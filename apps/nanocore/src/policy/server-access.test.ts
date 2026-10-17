import { describe, expect, it } from 'vitest';
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
      targetClosure: expect.arrayContaining(['object:["server","server"]']),
      requiredAccessRights: ['ar:audit-read'],
      matchedAssociations: ['assoc:server-eligible-actor'],
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
