import * as policyKernel from '@openkit/policy-kernel';
import { describe, expect, it, vi } from 'vitest';
import {
  evaluateAdministratorWorkspaceAccess,
  evaluateServerAccess,
  evaluateUserAccess,
} from './server-access.js';

describe('primary identity-scope Policy admission', () => {
  it('maps the current actor and exact admitted scope to an explainable kernel decision', () => {
    const userId = 'current-user';
    const server = evaluateServerAccess({ userId, operation: 'audit.read' });
    expect(server.effect).toBe('allow');
    expect(server.trace).toMatchObject({
      user: `user:${userId}`,
      targetClosure: expect.arrayContaining(['object:server:administration']),
      requiredAccessRights: ['ar:audit-read'],
      matchedAssociations: ['assoc:server-administrator:administration'],
    });
    const user = evaluateUserAccess({ userId, operation: 'invitation.respond' });
    expect(user.effect).toBe('allow');
    expect(user.trace).toMatchObject({
      targetClosure: expect.arrayContaining(['object:["user","current-user"]']),
      requiredAccessRights: ['ar:invitation-respond'],
      matchedAssociations: ['assoc:user-eligible-actor'],
    });
    const workspace = evaluateAdministratorWorkspaceAccess({
      userId,
      workspaceId: 'selected-workspace',
      operation: 'workspace.read',
    });
    expect(workspace.effect).toBe('allow');
    expect(workspace.trace).toMatchObject({
      targetClosure: expect.arrayContaining(['object:["workspace","selected-workspace"]']),
      requiredAccessRights: ['ar:workspace-read'],
      matchedAssociations: ['assoc:workspace-eligible-actor'],
    });
  });

  it.each([
    { family: 'administration', operation: 'api.call', right: 'ar:core-api-call' },
    { family: 'mcp', operation: 'api.call', right: 'ar:core-api-call' },
    { family: 'knowledge', operation: 'knowledge.read', right: 'ar:knowledge-read' },
    { family: 'knowledge', operation: 'knowledge.write', right: 'ar:knowledge-write' },
  ] as const)('evaluates current administrator allow and deny for $family/$operation', (input) => {
    const request = { ...input, userId: 'current-user' };
    const allowed = evaluateServerAccess(request);
    expect(allowed.effect).toBe('allow');
    expect(allowed.trace).toMatchObject({
      user: 'user:current-user',
      userClosure: expect.arrayContaining(['ua:server-administrator', 'pc:server']),
      targetClosure: expect.arrayContaining([
        `object:server:${input.family}`,
        `oa:server-${input.family}`,
        'pc:server',
      ]),
      requiredAccessRights: [input.right],
      matchedAssociations: [`assoc:server-administrator:${input.family}`],
    });
    const actualEvaluate = policyKernel.evaluateAccess;
    const evaluate = vi
      .spyOn(policyKernel, 'evaluateAccess')
      .mockImplementation((policy, access) =>
        actualEvaluate({ ...policy, associations: [] }, access)
      );
    try {
      const denied = evaluateServerAccess(request);
      expect(denied.effect).toBe('deny');
      expect(denied.trace.targetClosure).toContain(`object:server:${input.family}`);
      expect(evaluate).toHaveBeenCalledTimes(1);
    } finally {
      evaluate.mockRestore();
    }
  });

  it('rejects an unknown family and does not borrow another family association', () => {
    const input = { userId: 'current-user', operation: 'api.call', family: 'unknown' };
    expect(evaluateServerAccess(input).effect).toBe('deny');
    const mcp = { userId: 'current-user', operation: 'knowledge.write', family: 'mcp' };
    expect(evaluateServerAccess(mcp).effect).toBe('deny');
    const knowledge = { userId: 'current-user', operation: 'api.call', family: 'knowledge' };
    expect(evaluateServerAccess(knowledge).effect).toBe('deny');
  });

  it('does not grant unknown operations or the separately assigned maintenance effect', () => {
    for (const operation of ['unregistered.operation', 'administration.configuration.apply']) {
      expect(evaluateServerAccess({ userId: 'current-user', operation }).effect).toBe('deny');
      expect(evaluateUserAccess({ userId: 'current-user', operation }).effect).toBe('deny');
      expect(
        evaluateAdministratorWorkspaceAccess({
          userId: 'current-user',
          workspaceId: 'selected-workspace',
          operation,
        }).effect
      ).toBe('deny');
    }
  });

  it('denies when the current identity or selected resource is missing', () => {
    expect(evaluateServerAccess({ userId: '', operation: 'api.call' }).effect).toBe('deny');
    expect(
      evaluateAdministratorWorkspaceAccess({
        userId: 'current-user',
        workspaceId: '',
        operation: 'workspace.read',
      }).effect
    ).toBe('deny');
  });
});
