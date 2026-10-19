import { PRODUCT_OPERATION_ACCESS_RIGHTS, WorkspacePolicyDocumentSchema, type WorkspacePolicySubject } from '@openkit/config-schema';
import { type PolicyDocumentV1 } from '@openkit/protocol';
import { evaluateAccess, type PolicyDecision, type PolicyState } from '@openkit/policy-kernel';
import type { CoreDb } from '../storage/db.js';
import { resolveWorkspaceMembershipRelation } from '../workspace-membership.js';
import { isCurrentServerPolicyAuthor } from './configuration.js';
import { WORKSPACE_MEMBER_OPERATIONS } from './workspace-access.js';

/** Validates the activated Workspace subset without introducing another authored grammar. */
export function parseWorkspacePolicy(workspaceId: string, value: unknown): PolicyDocumentV1 {
  const document = WorkspacePolicyDocumentSchema.parse(value);
  for (const statement of document.statements) {
    const anchor = statement.lifetime.anchor;
    if (anchor.owner.kind !== 'workspace' || anchor.owner.workspaceId !== workspaceId) throw new Error('Workspace Policy belongs to a different owner.');
  }
  return document;
}

/** Rereads current authors before projection; a lost boundary author never becomes an unmanaged resource. */
export function readCurrentWorkspacePolicy(input: {readonly coreDb: CoreDb; readonly workspaceId: string; readonly policy: unknown}): PolicyDocumentV1 {
  const document = parseWorkspacePolicy(input.workspaceId, input.policy);
  for (const statement of document.statements) {
    if (statement.state !== 'active') continue;
    if (statement.author.kind !== 'human' ||
      !(resolveWorkspaceMembershipRelation(input.coreDb,input.workspaceId,statement.author.id) ||
        isCurrentServerPolicyAuthor(input.coreDb,statement.author.id)))
      throw new Error('Workspace Policy author no longer has current authority.');
  }
  return document;
}

/** Projects the exact permission recipient for native membership and portable binding checks. */
export function workspacePolicySubject(statement: PolicyDocumentV1['statements'][number]): WorkspacePolicySubject | null {
  if (statement.kind !== 'permission') return null;
  const principal = statement.scope.subjects[0];
  if (principal?.kind !== 'human') throw new Error('Workspace Policy recipient must be human-rooted.');
  if (statement.grant.kind === 'ordinary') return {kind:'user',userId:principal.id};
  if (statement.grant.kind === 'agent-process') return {kind:'agent',userId:principal.id,agentId:statement.grant.agentId};
  throw new Error('Unsupported Workspace Policy grant.');
}

/** Authenticated current responsibility; a runtime process is mapped to a User, never an NGAC element. */
export type ResourcePolicyActor =
  | { readonly kind: 'user'; readonly userId: string }
  | {
      readonly kind: 'agent';
      readonly userId: string;
      readonly agentId: string;
      readonly processId: string;
    };

/** Identity matching projects trusted responsibility onto attributes; it does not evaluate rights. */
function matches(subject: WorkspacePolicySubject, actor: ResourcePolicyActor): boolean {
  return (
    subject.kind === actor.kind &&
    subject.userId === actor.userId &&
    (subject.kind !== 'agent' || (actor.kind === 'agent' && subject.agentId === actor.agentId))
  );
}

/**
 * Evaluates the current member/administrator baseline and an optional additional resource Policy class.
 * The caller establishes current identity, membership, credential, private audience and exact Agent facts.
 * Every allocation and prohibition is decided by the existing Kernel, including last-grant revocation.
 */
export function evaluateWorkspaceResourceAccess(input: {
  readonly actor: ResourcePolicyActor;
  readonly eligible: boolean;
  readonly workspaceId: string;
  readonly policy: unknown;
  readonly resource: { readonly family: 'thread'; readonly id: string };
  readonly operation: string;
}): PolicyDecision {
  // Reparse at the bridge boundary: corrupt or unsupported mandatory facts cannot become unmanaged.
  const document = parseWorkspacePolicy(input.workspaceId,input.policy);
  const matching = document.statements.filter(statement => statement.state === 'active' && statement.scope.resources.some(resource => resource.kind === 'container' && resource.container.kind === 'thread' && resource.container.id === input.resource.id));
  const managed = matching.some(statement => statement.kind === 'managed-boundary') ? {
    grants: matching.flatMap(statement => statement.kind === 'permission' && statement.effect === 'allow' ? [{subject:workspacePolicySubject(statement)!,operations:statement.scope.actions}] : []),
    prohibitions: matching.flatMap(statement => statement.kind === 'permission' && statement.effect === 'prohibit' ? [{subject:workspacePolicySubject(statement)!,operations:statement.scope.actions}] : [])
  } : null;
  const user = `user:${input.actor.userId}`;
  const target = `object:${JSON.stringify(input.resource)}`;
  const baseline = 'ua:workspace-eligible';
  const objects = 'oa:workspace-resource';
  const baselineClass = 'pc:workspace';
  const operations = WORKSPACE_MEMBER_OPERATIONS.map(
    (operation) => [operation, PRODUCT_OPERATION_ACCESS_RIGHTS[operation]] as const
  );
  const policy: PolicyState = {
    elements: [
      { id: user, kind: 'user' },
      { id: baseline, kind: 'userAttribute' },
      { id: target, kind: 'object' },
      { id: objects, kind: 'objectAttribute' },
      { id: baselineClass, kind: 'policyClass' },
    ],
    assignments: [
      ...(input.eligible && input.actor.userId ? [{ child: user, parent: baseline }] : []),
      { child: baseline, parent: baselineClass },
      { child: target, parent: objects },
      { child: objects, parent: baselineClass },
    ],
    associations: [
      {
        id: 'assoc:workspace-eligible',
        userAttribute: baseline,
        targetAttribute: objects,
        accessRights: operations.map(([, right]) => right),
      },
    ],
    operations: operations.map(([id, right]) => ({ id, accessRights: [right] })),
    ...(input.actor.kind === 'agent'
      ? { processUsers: [{ process: input.actor.processId, user }] }
      : {}),
  };
  if (managed) {
    const resourceClass = 'pc:managed-resource';
    const resourceObjects = 'oa:managed-resource';
    const elements = [
      ...policy.elements,
      { id: resourceClass, kind: 'policyClass' as const },
      { id: resourceObjects, kind: 'objectAttribute' as const },
    ];
    const assignments = [
      ...policy.assignments,
      { child: target, parent: resourceObjects },
      { child: resourceObjects, parent: resourceClass },
    ];
    const associations = [...policy.associations];
    for (const [index, grant] of managed.grants.entries()) {
      const attribute = `ua:resource-allocation:${index}`;
      elements.push({ id: attribute, kind: 'userAttribute' });
      assignments.push({ child: attribute, parent: resourceClass });
      if (matches(grant.subject, input.actor)) assignments.push({ child: user, parent: attribute });
      associations.push({
        id: `assoc:resource-allocation:${index}`,
        userAttribute: attribute,
        targetAttribute: resourceObjects,
        accessRights: grant.operations.map(
          (operation) => PRODUCT_OPERATION_ACCESS_RIGHTS[operation as keyof typeof PRODUCT_OPERATION_ACCESS_RIGHTS]
        ),
      });
    }
    policy.elements = elements;
    policy.assignments = assignments;
    policy.associations = associations;
    policy.prohibitions = managed.prohibitions.flatMap((prohibition, index) => {
      // A User restriction follows that User's mapped processes; an Agent restriction stays exact.
      const restrictUser =
        prohibition.subject.kind === 'user' && prohibition.subject.userId === input.actor.userId;
      if (!restrictUser && !matches(prohibition.subject, input.actor)) return [];
      return [
        {
          id: `prohibition:resource:${index}`,
          kind: restrictUser ? ('user' as const) : ('process' as const),
          subject: restrictUser
            ? user
            : input.actor.kind === 'agent'
              ? input.actor.processId
              : user,
          accessRights: prohibition.operations.map(
            (operation) => PRODUCT_OPERATION_ACCESS_RIGHTS[operation as keyof typeof PRODUCT_OPERATION_ACCESS_RIGHTS]
          ),
          range: { type: 'disjunctive' as const, include: [resourceObjects] },
        },
      ];
    });
  }
  return evaluateAccess(policy, {
    user,
    ...(input.actor.kind === 'agent' ? { process: input.actor.processId } : {}),
    target,
    operation: input.operation,
  });
}
