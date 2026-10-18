import {
  PRODUCT_OPERATION_ACCESS_RIGHTS,
  type WorkspacePolicySubject,
  type WorkspaceResourceAccessEntry,
  WorkspaceResourceAccessSchema,
} from '@openkit/config-schema';
import { evaluateAccess, type PolicyDecision, type PolicyState } from '@openkit/policy-kernel';
import { WORKSPACE_MEMBER_OPERATIONS } from './workspace-access.js';

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
  readonly resource: WorkspaceResourceAccessEntry['resource'];
  readonly operation: string;
  readonly resourceAccess: readonly WorkspaceResourceAccessEntry[];
}): PolicyDecision {
  // Reparse at the bridge boundary: corrupt or unsupported mandatory facts cannot become unmanaged.
  const entries = WorkspaceResourceAccessSchema.parse(input.resourceAccess);
  const managed = entries.find(
    (entry) =>
      entry.resource.family === input.resource.family && entry.resource.id === input.resource.id
  );
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
          (operation) => PRODUCT_OPERATION_ACCESS_RIGHTS[operation]
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
            (operation) => PRODUCT_OPERATION_ACCESS_RIGHTS[operation]
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
