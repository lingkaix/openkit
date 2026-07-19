import { evaluateAccess, type PolicyDecision, type PolicyState } from '@openkit/policy-kernel';
import type { WorkspaceRole } from '../workspace-membership.js';

/** Closed V1 product-operation to NGAC access-right registry. */
export const PRODUCT_OPERATION_ACCESS_RIGHTS = {
  'api.call': 'ar:core-api-call',
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
  'repo.push': 'ar:repo-push',
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

/** Product operations governed directly by an active Workspace fixed role. */
type WorkspaceRoleOperation = Exclude<
  ProductOperation,
  'api.call' | 'deployment.recover' | 'invitation.respond'
>;

/** Input for evaluating the fixed-role ceiling of one Workspace operation. */
export interface EvaluateWorkspaceRoleAccessInput {
  /** Concrete registered product operation, or an unknown value that must fail closed. */
  operation: string;
  /** Effective role already derived from authoritative Core membership facts. */
  role: WorkspaceRole;
}

/** Fixed-role operation ceilings; deployment- and user-only operations stay outside this adapter. */
const WORKSPACE_ROLE_OPERATION_CEILINGS: Readonly<
  Record<WorkspaceRole, readonly WorkspaceRoleOperation[]>
> = {
  owner: [
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
    'repo.push',
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
    'workspace.lifecycle',
    'workspace.read',
    'workspace.write',
  ],
  editor: [
    'approval.respond',
    'artifact.read',
    'artifact.write',
    'audit.read',
    'knowledge.propose',
    'knowledge.read',
    'knowledge.write',
    'llm.gateway.use',
    'network.egress',
    'repo.push',
    'review.apply',
    'runtime.launch',
    'thread.read',
    'tool.use',
    'turn.run',
    'vault.use',
    'workspace.leave',
    'workspace.read',
    'workspace.write',
  ],
  viewer: ['artifact.read', 'knowledge.read', 'thread.read', 'workspace.leave', 'workspace.read'],
};

/** Fixed-role operations presented to the policy kernel. */
const WORKSPACE_ROLE_OPERATIONS = [
  ...new Set(Object.values(WORKSPACE_ROLE_OPERATION_CEILINGS).flat()),
].map((operation) => ({
  accessRights: [PRODUCT_OPERATION_ACCESS_RIGHTS[operation]],
  id: operation,
}));

/**
 * Evaluates one operation against the maximum access-right association for an effective fixed role.
 * Resource lifecycle, token, approval, and policy restrictions may only narrow this result downstream.
 *
 * @param input Effective Workspace role and requested product operation.
 * @returns Existing policy-kernel decision, including a structural trace and fail-closed reason.
 */
export function evaluateWorkspaceRoleAccess(
  input: EvaluateWorkspaceRoleAccessInput
): PolicyDecision {
  const subjectId = 'user:workspace-actor';
  const roleAttributeId = `ua:workspace-role:${input.role}`;
  const targetId = 'object:workspace-resource';
  const targetAttributeId = 'oa:workspace-resources';
  const policyClassId = 'pc:workspace';
  const policy: PolicyState = {
    associations: [
      {
        accessRights: WORKSPACE_ROLE_OPERATION_CEILINGS[input.role].map(
          (operation) => PRODUCT_OPERATION_ACCESS_RIGHTS[operation]
        ),
        id: `assoc:workspace-role:${input.role}`,
        targetAttribute: targetAttributeId,
        userAttribute: roleAttributeId,
      },
    ],
    assignments: [
      { child: subjectId, parent: roleAttributeId },
      { child: roleAttributeId, parent: policyClassId },
      { child: targetId, parent: targetAttributeId },
      { child: targetAttributeId, parent: policyClassId },
    ],
    elements: [
      { id: subjectId, kind: 'user' },
      { id: roleAttributeId, kind: 'userAttribute' },
      { id: targetId, kind: 'object' },
      { id: targetAttributeId, kind: 'objectAttribute' },
      { id: policyClassId, kind: 'policyClass' },
    ],
    operations: WORKSPACE_ROLE_OPERATIONS,
  };

  return evaluateAccess(policy, {
    operation: input.operation,
    target: targetId,
    user: subjectId,
  });
}
