import {
  PRODUCT_OPERATION_ACCESS_RIGHTS,
  WorkspacePolicyDocumentSchema,
  type WorkspacePolicySubject,
} from '@openkit/config-schema';
import { evaluateAccess, type PolicyDecision, type PolicyState } from '@openkit/policy-kernel';
import { type PolicyDocumentV1, ThreadSchema, workspaceIdForOwner } from '@openkit/protocol';
import type { z } from 'zod';
import { WORKSPACE_MEMBER_OPERATIONS } from './workspace-access.js';

/** Validates the activated Workspace subset without introducing another authored grammar. */
export function parseWorkspacePolicy(workspaceId: string, value: unknown): PolicyDocumentV1 {
  const document = WorkspacePolicyDocumentSchema.parse(value);
  for (const statement of document.statements) {
    const anchor = statement.lifetime.anchor;
    if (anchor.owner.kind !== 'workspace' || anchor.owner.workspaceId !== workspaceId)
      throw new Error('Workspace Policy belongs to a different owner.');
  }
  return document;
}

/** Projects the exact permission recipient for native membership and portable binding checks. */
export function workspacePolicySubject(
  statement: PolicyDocumentV1['statements'][number]
): WorkspacePolicySubject | null {
  if (statement.kind !== 'permission') return null;
  const principal = statement.scope.subjects[0];
  if (principal?.kind !== 'human')
    throw new Error('Workspace Policy recipient must be human-rooted.');
  if (statement.grant.kind === 'ordinary') return { kind: 'user', userId: principal.id };
  if (statement.grant.kind === 'agent-process')
    return { kind: 'agent', userId: principal.id, agentId: statement.grant.agentId };
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
 * Evaluates exact Thread audience constraints and its optional additional resource Policy class.
 * The caller independently requires current primary Workspace admission and exact Agent lineage.
 * Every allocation and prohibition is decided by the existing Kernel, including last-grant revocation.
 */
export function evaluateWorkspaceResourceAccess(input: {
  readonly actor: ResourcePolicyActor;
  readonly administrator: boolean;
  readonly visibility: 'workspace' | 'private';
  readonly privateOwnerUserId?: string | undefined;
  readonly personalWorkspaceId?: string | undefined;
  readonly workspaceId: string;
  readonly policy: unknown;
  readonly resource: { readonly family: 'thread'; readonly id: string };
  readonly operation: string;
}): PolicyDecision {
  // Reparse at the bridge boundary: corrupt or unsupported mandatory facts cannot become unmanaged.
  const document = parseWorkspacePolicy(input.workspaceId, input.policy);
  const matching = document.statements.filter(
    (statement) =>
      statement.state === 'active' &&
      statement.scope.resources.some(
        (resource) =>
          resource.kind === 'container' &&
          resource.container.kind === 'thread' &&
          resource.container.id === input.resource.id
      )
  );
  const managed = matching.some((statement) => statement.kind === 'managed-boundary')
    ? {
        grants: matching.flatMap((statement) =>
          statement.kind === 'permission' && statement.effect === 'allow'
            ? [{ subject: workspacePolicySubject(statement)!, operations: statement.scope.actions }]
            : []
        ),
        prohibitions: matching.flatMap((statement) =>
          statement.kind === 'permission' && statement.effect === 'prohibit'
            ? [{ subject: workspacePolicySubject(statement)!, operations: statement.scope.actions }]
            : []
        ),
      }
    : null;
  const user = `user:${input.actor.userId}`;
  const target = `object:${JSON.stringify(input.resource)}`;
  const subject = 'ua:thread-subject';
  const baseline = 'ua:thread-shared';
  const privateOwner = 'ua:thread-private-owner';
  const administrator = 'ua:thread-administrator';
  const objects = 'oa:workspace-resource';
  const baselineClass = 'pc:thread-audience';
  const operations = WORKSPACE_MEMBER_OPERATIONS.map(
    (operation) => [operation, PRODUCT_OPERATION_ACCESS_RIGHTS[operation]] as const
  );
  const policy: PolicyState = {
    elements: [
      { id: user, kind: 'user' },
      { id: subject, kind: 'userAttribute' },
      { id: baseline, kind: 'userAttribute' },
      { id: privateOwner, kind: 'userAttribute' },
      { id: administrator, kind: 'userAttribute' },
      { id: target, kind: 'object' },
      { id: objects, kind: 'objectAttribute' },
      { id: baselineClass, kind: 'policyClass' },
    ],
    assignments: [
      { child: user, parent: subject },
      { child: subject, parent: baselineClass },
      ...(input.visibility === 'workspace' ? [{ child: user, parent: baseline }] : []),
      ...(input.visibility === 'private' && input.privateOwnerUserId === input.actor.userId
        ? [{ child: user, parent: privateOwner }]
        : []),
      ...(input.administrator ? [{ child: user, parent: administrator }] : []),
      { child: privateOwner, parent: baselineClass },
      { child: administrator, parent: baselineClass },
      { child: baseline, parent: baselineClass },
      { child: target, parent: objects },
      { child: objects, parent: baselineClass },
    ],
    associations: [baseline, privateOwner, administrator].map((attribute) => ({
      id: `assoc:${attribute}`,
      userAttribute: attribute,
      targetAttribute: objects,
      accessRights: operations.map(([, right]) => right),
    })),
    operations: operations.map(([id, right]) => ({ id, accessRights: [right] })),
    ...(input.actor.kind === 'agent'
      ? { processUsers: [{ process: input.actor.processId, user }] }
      : {}),
  };
  if (input.personalWorkspaceId !== undefined) {
    const personalClass = 'pc:personal-workspace-audience';
    const personalObjects = 'oa:personal-workspace';
    const personalOwner = 'ua:personal-workspace-owner';
    const personalAdministrator = 'ua:personal-workspace-administrator';
    policy.elements = [
      ...policy.elements,
      { id: personalClass, kind: 'policyClass' },
      { id: personalObjects, kind: 'objectAttribute' },
      { id: personalOwner, kind: 'userAttribute' },
      { id: personalAdministrator, kind: 'userAttribute' },
    ];
    policy.assignments = [
      ...policy.assignments,
      { child: subject, parent: personalClass },
      { child: target, parent: personalObjects },
      { child: personalObjects, parent: personalClass },
      { child: personalOwner, parent: personalClass },
      { child: personalAdministrator, parent: personalClass },
      ...(input.workspaceId === input.personalWorkspaceId
        ? [{ child: user, parent: personalOwner }]
        : []),
      ...(input.administrator ? [{ child: user, parent: personalAdministrator }] : []),
    ];
    policy.associations = [
      ...policy.associations,
      ...[personalOwner, personalAdministrator].map((attribute) => ({
        id: `assoc:${attribute}`,
        userAttribute: attribute,
        targetAttribute: personalObjects,
        accessRights: operations.map(([, right]) => right),
      })),
    ];
  }
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
          (operation) =>
            PRODUCT_OPERATION_ACCESS_RIGHTS[
              operation as keyof typeof PRODUCT_OPERATION_ACCESS_RIGHTS
            ]
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
            (operation) =>
              PRODUCT_OPERATION_ACCESS_RIGHTS[
                operation as keyof typeof PRODUCT_OPERATION_ACCESS_RIGHTS
              ]
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

/** Requires the resource Kernel in addition to independently established primary Workspace admission. */
export function evaluateThreadAuthorization(input: {
  readonly thread: z.infer<typeof ThreadSchema>;
  readonly workspaceId: string;
  readonly userId: string;
  readonly administrator: boolean;
  readonly personalWorkspaceId?: string | undefined;
  readonly policy: unknown;
  readonly operation: string;
  readonly actor?: ResourcePolicyActor | undefined;
}): PolicyDecision {
  if (
    !input.userId ||
    !ThreadSchema.safeParse(input.thread).success ||
    input.thread.visibility === 'server' ||
    input.thread.owner.kind !== 'workspace' ||
    workspaceIdForOwner(input.thread.owner) !== input.workspaceId ||
    (input.actor && input.actor.userId !== input.userId)
  )
    throw new Error('Thread authorization requires exact current audience and actor facts.');
  return evaluateWorkspaceResourceAccess({
    workspaceId: input.workspaceId,
    actor: input.actor ?? { kind: 'user', userId: input.userId },
    administrator: input.administrator,
    visibility: input.thread.visibility,
    privateOwnerUserId: input.thread.privateOwnerUserId,
    personalWorkspaceId: input.personalWorkspaceId,
    policy: input.policy,
    resource: { family: 'thread', id: input.thread.id },
    operation: input.operation,
  });
}
