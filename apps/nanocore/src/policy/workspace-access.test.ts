import { describe, expect, it } from 'vitest';

import { evaluateProductAccess, PRODUCT_OPERATION_ACCESS_RIGHTS } from './workspace-access.js';

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

const facts = {
  userId: 'current-member',
  activeUser: true,
  administrator: false,
  credential: { kind: 'session' as const, current: true, workspaceBound: true, readOnly: false },
};
const target = {
  kind: 'workspace' as const,
  workspaceId: 'selected-workspace',
  active: true,
  membership: 'member' as const,
};

describe('Workspace current-fact Policy projection', () => {
  it('exports the exact closed product operation to access-right registry', () => {
    expect(PRODUCT_OPERATION_ACCESS_RIGHTS).toEqual(EXPECTED_PRODUCT_OPERATION_ACCESS_RIGHTS);
  });

  it('grants ordinary Workspace operations to the actual active member', () => {
    for (const operation of Object.keys(EXPECTED_PRODUCT_OPERATION_ACCESS_RIGHTS).filter(
      (value) =>
        ![
          'api.call',
          'deployment.recover',
          'invitation.respond',
          'administration.configuration.apply',
          'workspace.export',
        ].includes(value)
    )) {
      const decision = evaluateProductAccess({ facts, target, operation, mutating: false });
      expect(decision.effect, operation).toBe('allow');
      expect(decision.trace.user).toBe(`user:${facts.userId}`);
      expect(decision.trace.requiredAccessRights).toEqual([
        EXPECTED_PRODUCT_OPERATION_ACCESS_RIGHTS[
          operation as keyof typeof EXPECTED_PRODUCT_OPERATION_ACCESS_RIGHTS
        ],
      ]);
    }
  });

  it.each([
    'api.call',
    'deployment.recover',
    'invitation.respond',
    'administration.configuration.apply',
    'workspace.export',
    'repo.push',
    'unknown.operation',
  ])('does not grant nonmember rights or unknown operation %s', (operation) => {
    expect(evaluateProductAccess({ facts, target, operation, mutating: false }).effect).toBe(
      'deny'
    );
  });

  it('treats membership and current administrator as alternatives without an owner privilege tier', () => {
    for (const membership of ['owner', 'member', null] as const) {
      const currentTarget = { ...target, membership };
      const ordinary = evaluateProductAccess({
        facts,
        target: currentTarget,
        operation: 'workspace.export',
        mutating: false,
      });
      expect(ordinary.effect).toBe('deny');
      expect(ordinary.reasons).toContainEqual(
        expect.objectContaining({ code: 'missing-privilege' })
      );
      const administrator = evaluateProductAccess({
        facts: { ...facts, administrator: true },
        target: currentTarget,
        operation: 'workspace.export',
        mutating: false,
      });
      expect(administrator.effect).toBe('allow');
      expect(administrator.trace.user).toBe(`user:${facts.userId}`);
    }
  });

  it('denies absent current facts with a valid Kernel missing-privilege decision', () => {
    const request = { facts, target, operation: 'workspace.read', mutating: false };
    for (const change of [
      { facts: { ...facts, activeUser: false } },
      { facts: { ...facts, userId: '' } },
      { facts: { ...facts, credential: { ...facts.credential, current: false } } },
      { facts: { ...facts, credential: { ...facts.credential, workspaceBound: false } } },
      { target: { ...target, active: false } },
      { target: { ...target, workspaceId: '' } },
      { target: { ...target, membership: null } },
    ]) {
      const decision = evaluateProductAccess({ ...request, ...change });
      expect(decision.effect).toBe('deny');
      expect(decision.reasons).toContainEqual(
        expect.objectContaining({ code: 'missing-privilege' })
      );
      expect(decision.reasons).not.toContainEqual(
        expect.objectContaining({ code: 'invalid-policy' })
      );
    }
  });

  it('keeps current credential and readonly mutation limits mandatory for administrators', () => {
    const current = {
      ...facts,
      administrator: true,
      credential: { ...facts.credential, readOnly: true, workspaceBound: false },
    };
    const request = {
      facts: current,
      target: { ...target, membership: null },
      operation: 'workspace.configure',
    };
    expect(evaluateProductAccess({ ...request, mutating: false }).effect).toBe('allow');
    const denied = evaluateProductAccess({ ...request, mutating: true });
    expect(denied.effect).toBe('deny');
    expect(denied.reasons).toContainEqual(expect.objectContaining({ code: 'missing-privilege' }));
    expect(
      evaluateProductAccess({
        ...request,
        mutating: false,
        facts: { ...current, credential: { ...current.credential, current: false } },
      }).effect
    ).toBe('deny');
  });
});
