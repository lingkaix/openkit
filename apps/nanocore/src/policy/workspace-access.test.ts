import { describe, expect, it } from 'vitest';

import {
  evaluateWorkspaceRoleAccess,
  PRODUCT_OPERATION_ACCESS_RIGHTS,
} from './workspace-access.js';

const EXPECTED_PRODUCT_OPERATION_ACCESS_RIGHTS = {
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

const ROLE_MATRIX = [
  ['workspace.read', ['owner', 'editor', 'viewer']],
  ['workspace.write', ['owner', 'editor']],
  ['thread.read', ['owner', 'editor', 'viewer']],
  ['turn.run', ['owner', 'editor']],
  ['artifact.read', ['owner', 'editor', 'viewer']],
  ['artifact.write', ['owner', 'editor']],
  ['review.apply', ['owner', 'editor']],
  ['approval.respond', ['owner', 'editor']],
  ['knowledge.read', ['owner', 'editor', 'viewer']],
  ['knowledge.write', ['owner', 'editor']],
  ['knowledge.propose', ['owner', 'editor']],
  ['audit.read', ['owner', 'editor']],
  ['workspace.configure', ['owner']],
  ['workspace.export', ['owner']],
  ['workspace.leave', ['editor', 'viewer']],
  ['workspace.lifecycle', ['owner']],
  ['membership.manage', ['owner']],
  ['vault.use', ['owner', 'editor']],
  ['vault.admin', ['owner']],
  ['tool.use', ['owner', 'editor']],
  ['tool.grant', ['owner']],
  ['runtime.launch', ['owner', 'editor']],
  ['network.egress', ['owner', 'editor']],
  ['llm.gateway.use', ['owner', 'editor']],
  ['repo.push', ['owner', 'editor']],
] as const;

describe('Workspace fixed-role policy adapter', () => {
  it('exports the exact closed product operation to access-right registry', () => {
    expect(PRODUCT_OPERATION_ACCESS_RIGHTS).toEqual(EXPECTED_PRODUCT_OPERATION_ACCESS_RIGHTS);
  });

  it('projects each fixed role ceiling through the policy kernel', () => {
    const roles = ['owner', 'editor', 'viewer'] as const;

    for (const [operation, allowedRoles] of ROLE_MATRIX) {
      for (const role of roles) {
        const decision = evaluateWorkspaceRoleAccess({ operation, role });
        const allowed = allowedRoles.some((allowedRole) => allowedRole === role);

        expect(decision.effect, `${role} ${operation}`).toBe(allowed ? 'allow' : 'deny');
        expect(decision.trace.requiredAccessRights, `${role} ${operation}`).toEqual([
          EXPECTED_PRODUCT_OPERATION_ACCESS_RIGHTS[operation],
        ]);
        expect(decision.reasons[0]?.code, `${role} ${operation}`).toBe(
          allowed ? 'association-grant' : 'missing-privilege'
        );
      }
    }
  });

  it('fails closed through the policy kernel for an unregistered operation', () => {
    const decision = evaluateWorkspaceRoleAccess({
      operation: 'workspace.unregistered',
      role: 'owner',
    });

    expect(decision).toMatchObject({
      effect: 'deny',
      reasons: [{ code: 'missing-operation', operation: 'workspace.unregistered' }],
      trace: { requiredAccessRights: [] },
    });
  });
});
