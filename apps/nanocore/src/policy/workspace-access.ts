import { evaluateAccess, type PolicyDecision, type PolicyState } from '@openkit/policy-kernel';

/** Closed V1 product-operation to NGAC access-right registry. */
export const PRODUCT_OPERATION_ACCESS_RIGHTS = {
  'api.call': 'ar:core-api-call',
  'administration.configuration.apply': 'ar:worker-git-read-maintenance-apply',
  'approval.respond': 'ar:approval-respond',
  'artifact.read': 'ar:artifact-read',
  'artifact.write': 'ar:artifact-write',
  'audit.read': 'ar:audit-read',
  'deployment.recover': 'ar:deployment-recover',
  'invitation.respond': 'ar:invitation-respond',
  'knowledge.propose': 'ar:knowledge-propose',
  'knowledge.read': 'ar:knowledge-read',
  'knowledge.write': 'ar:knowledge-write',
  'llm.gateway.use': 'ar:llm-gateway-use',
  'membership.manage': 'ar:membership-manage',
  'network.egress': 'ar:network-egress',
  'review.apply': 'ar:review-apply',
  'runtime.launch': 'ar:runtime-launch',
  'thread.read': 'ar:thread-read',
  'tool.grant': 'ar:tool-grant',
  'tool.use': 'ar:tool-use',
  'turn.run': 'ar:turn-run',
  'vault.admin': 'ar:vault-admin',
  'vault.use': 'ar:vault-use',
  'workspace.configure': 'ar:workspace-configure',
  'workspace.export': 'ar:workspace-export',
  'workspace.leave': 'ar:workspace-leave',
  'workspace.lifecycle': 'ar:workspace-lifecycle',
  'workspace.read': 'ar:workspace-read',
  'workspace.write': 'ar:workspace-write',
} as const;

/** Product operation registered by the V1 authorization vocabulary. */
export type ProductOperation = keyof typeof PRODUCT_OPERATION_ACCESS_RIGHTS;

/** Product operations supplied by the single active-member association. */
const WORKSPACE_MEMBER_OPERATIONS = [
  'approval.respond',
  'artifact.read',
  'artifact.write',
  'audit.read',
  'knowledge.propose',
  'knowledge.read',
  'knowledge.write',
  'llm.gateway.use',
  'membership.manage',
  'network.egress',
  'review.apply',
  'runtime.launch',
  'thread.read',
  'tool.grant',
  'tool.use',
  'turn.run',
  'vault.admin',
  'vault.use',
  'workspace.configure',
  'workspace.export',
  'workspace.leave',
  'workspace.lifecycle',
  'workspace.read',
  'workspace.write',
] satisfies readonly ProductOperation[];

/** Input for membership-derived eligibility; identity and credential checks precede this adapter. */
export interface EvaluateWorkspaceMemberAccessInput {
  /** Registered operation, or an unknown value which fails closed. */
  operation: string;
}

/**
 * Evaluates one operation against the access-right association of an active Workspace member.
 * Resource lifecycle, credential, audience and owner-specific Policy constraints remain mandatory.
 *
 * @param input Requested product operation after current active-member admission.
 * @returns Existing policy-kernel decision, including a structural trace and fail-closed reason.
 */
export function evaluateWorkspaceMemberAccess(
  input: EvaluateWorkspaceMemberAccessInput
): PolicyDecision {
  const subjectId = 'user:workspace-actor';
  const memberAttributeId = 'ua:workspace-active-member';
  const targetId = 'object:workspace-resource';
  const targetAttributeId = 'oa:workspace-resources';
  const policyClassId = 'pc:workspace';
  const policy: PolicyState = {
    associations: [
      {
        accessRights: WORKSPACE_MEMBER_OPERATIONS.map(
          (operation) => PRODUCT_OPERATION_ACCESS_RIGHTS[operation]
        ),
        id: 'assoc:workspace-active-member',
        targetAttribute: targetAttributeId,
        userAttribute: memberAttributeId,
      },
    ],
    assignments: [
      { child: subjectId, parent: memberAttributeId },
      { child: memberAttributeId, parent: policyClassId },
      { child: targetId, parent: targetAttributeId },
      { child: targetAttributeId, parent: policyClassId },
    ],
    elements: [
      { id: subjectId, kind: 'user' },
      { id: memberAttributeId, kind: 'userAttribute' },
      { id: targetId, kind: 'object' },
      { id: targetAttributeId, kind: 'objectAttribute' },
      { id: policyClassId, kind: 'policyClass' },
    ],
    operations: WORKSPACE_MEMBER_OPERATIONS.map((operation) => ({
      id: operation,
      accessRights: [PRODUCT_OPERATION_ACCESS_RIGHTS[operation]],
    })),
  };

  return evaluateAccess(policy, {
    operation: input.operation,
    target: targetId,
    user: subjectId,
  });
}
