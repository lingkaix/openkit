import { describe, expect, it } from 'vitest';

import {
  evaluateWorkspaceMemberAccess,
  PRODUCT_OPERATION_ACCESS_RIGHTS,
} from './workspace-access.js';

const EXPECTED_PRODUCT_OPERATION_ACCESS_RIGHTS = {
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

describe('Workspace active-member policy adapter', () => {
  it('exports the exact closed product operation to access-right registry', () => {
    expect(PRODUCT_OPERATION_ACCESS_RIGHTS).toEqual(EXPECTED_PRODUCT_OPERATION_ACCESS_RIGHTS);
  });

  it('grants full Workspace eligibility through one active-member association', () => {
    for (const operation of Object.keys(EXPECTED_PRODUCT_OPERATION_ACCESS_RIGHTS).filter(
      (value) =>
        ![
          'api.call',
          'deployment.recover',
          'invitation.respond',
          'administration.configuration.apply',
        ].includes(value)
    )) {
      const decision = evaluateWorkspaceMemberAccess({ operation });
      expect(decision.effect, operation).toBe('allow');
      expect(decision.trace.requiredAccessRights).toEqual([
        EXPECTED_PRODUCT_OPERATION_ACCESS_RIGHTS[
          operation as keyof typeof EXPECTED_PRODUCT_OPERATION_ACCESS_RIGHTS
        ],
      ]);
      expect(decision.trace.matchedAssociations).toEqual(['assoc:workspace-active-member']);
    }
  });

  it.each([
    'api.call',
    'deployment.recover',
    'invitation.respond',
    'administration.configuration.apply',
    'repo.push',
    'unknown.operation',
  ])('does not grant non-Workspace or unknown operation %s', (operation) => {
    expect(evaluateWorkspaceMemberAccess({ operation }).effect).toBe('deny');
  });
});
