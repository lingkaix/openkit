import * as policyKernel from '@openkit/policy-kernel';
import { describe, expect, it, vi } from 'vitest';
import { evaluateProductAccess } from './workspace-access.js';

const facts = {
  userId: 'current-user',
  activeUser: true,
  administrator: true,
  credential: { kind: 'session' as const, current: true, workspaceBound: false, readOnly: false },
};

describe('primary identity-scope Policy admission', () => {
  it('maps the current actor and exact admitted scope to an explainable Kernel decision', () => {
    const requests = [
      { target: { kind: 'server' as const }, operation: 'audit.read', right: 'ar:audit-read' },
      {
        target: { kind: 'user' as const },
        operation: 'invitation.respond',
        right: 'ar:invitation-respond',
      },
      {
        target: {
          kind: 'workspace' as const,
          workspaceId: 'selected-workspace',
          active: true,
          membership: null,
        },
        operation: 'workspace.read',
        right: 'ar:workspace-read',
      },
    ];
    for (const request of requests) {
      const decision = evaluateProductAccess({ ...request, facts, mutating: false });
      expect(decision.effect).toBe('allow');
      expect(decision.trace.user).toBe(`user:${facts.userId}`);
      expect(decision.trace.requiredAccessRights).toEqual([request.right]);
    }
  });

  it.each([
    { family: 'administration', operation: 'api.call', right: 'ar:core-api-call' },
    { family: 'mcp', operation: 'api.call', right: 'ar:core-api-call' },
    { family: 'knowledge', operation: 'knowledge.read', right: 'ar:knowledge-read' },
    { family: 'knowledge', operation: 'knowledge.write', right: 'ar:knowledge-write' },
  ] as const)('evaluates current administrator allow and deny for $family/$operation', (input) => {
    const request = {
      facts,
      target: { kind: 'server' as const, family: input.family },
      operation: input.operation,
      mutating: false,
    };
    const allowed = evaluateProductAccess(request);
    expect(allowed.effect).toBe('allow');
    expect(allowed.trace.user).toBe(`user:${facts.userId}`);
    expect(allowed.trace.requiredAccessRights).toEqual([input.right]);
    const denied = evaluateProductAccess({ ...request, facts: { ...facts, administrator: false } });
    expect(denied.effect).toBe('deny');
    expect(denied.reasons).toContainEqual(expect.objectContaining({ code: 'missing-privilege' }));
    const actualEvaluate = policyKernel.evaluateAccess;
    const evaluate = vi
      .spyOn(policyKernel, 'evaluateAccess')
      .mockImplementation((policy, access) =>
        actualEvaluate({ ...policy, associations: [] }, access)
      );
    try {
      const noGrant = evaluateProductAccess(request);
      expect(noGrant.effect).toBe('deny');
      expect(noGrant.reasons).toContainEqual(
        expect.objectContaining({ code: 'missing-privilege' })
      );
      // Accepted QP-2 brief13e: alternatives belong inside one evaluated graph.
      expect(evaluate).toHaveBeenCalledTimes(1);
    } finally {
      evaluate.mockRestore();
    }
  });

  it('rejects an unknown family and does not borrow another family association', () => {
    for (const target of [
      { kind: 'server' as const, family: 'unknown' },
      { kind: 'server' as const, family: 'mcp' },
      { kind: 'server' as const, family: 'knowledge' },
    ]) {
      const operation = target.family === 'mcp' ? 'knowledge.write' : 'api.call';
      expect(evaluateProductAccess({ facts, target, operation, mutating: false }).effect).toBe(
        'deny'
      );
    }
  });

  it('does not grant unknown operations or the separately assigned maintenance effect', () => {
    for (const operation of ['unregistered.operation', 'administration.configuration.apply']) {
      for (const target of [
        { kind: 'server' as const },
        { kind: 'user' as const },
        {
          kind: 'workspace' as const,
          workspaceId: 'selected-workspace',
          active: true,
          membership: null,
        },
      ]) {
        expect(evaluateProductAccess({ facts, target, operation, mutating: false }).effect).toBe(
          'deny'
        );
      }
    }
  });

  it('does not treat a nonadministrator bearer as a User session', () => {
    const request = {
      target: { kind: 'user' as const },
      operation: 'invitation.respond',
      mutating: false,
    };
    const current = { ...facts, administrator: false };
    expect(evaluateProductAccess({ ...request, facts: current }).effect).toBe('allow');
    expect(
      evaluateProductAccess({
        ...request,
        facts: { ...current, credential: { ...current.credential, kind: 'token' } },
      }).effect
    ).toBe('deny');
  });
});
