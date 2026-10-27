import type { PolicyDocumentV1 } from '@openkit/protocol';
import { allocateEntityId } from '@openkit/protocol';
import { describe, expect, it } from 'vitest';
import { evaluateProductAccess } from './workspace-access.js';
import {
  evaluateWorkspaceResourceAccess,
  type ResourcePolicyActor,
} from './workspace-resource-access.js';

const workspaceId = allocateEntityId('ws');
const userId = allocateEntityId('usr');
const otherUserId = allocateEntityId('usr');
const resource = { family: 'thread' as const, id: allocateEntityId('th') };
const actor = { kind: 'user' as const, userId };
const owner = { kind: 'workspace' as const, workspaceId };
const envelope = {
  author: { kind: 'human' as const, id: userId },
  authority: { kind: 'human' as const, userId },
  authoredAt: '2026-10-19T00:00:00.000Z',
  state: 'active' as const,
  lifetime: { anchor: { owner, kind: 'workspace', id: workspaceId } },
};
const target = {
  kind: 'container' as const,
  container: { owner, kind: 'thread', id: resource.id },
};
const boundary = {
  ...envelope,
  kind: 'managed-boundary' as const,
  id: 'managed-thread',
  scope: { subjects: [], actions: [], resources: [target] },
};
const permission = {
  ...envelope,
  kind: 'permission' as const,
  id: 'thread-read',
  scope: {
    subjects: [{ kind: 'human' as const, id: userId }],
    actions: ['thread.read'],
    resources: [target],
  },
  effect: 'allow' as const,
  grant: { kind: 'ordinary' as const },
};
const decide = (
  statements: PolicyDocumentV1['statements'],
  operation = 'thread.read',
  current: ResourcePolicyActor = actor,
  audience: Partial<
    Pick<
      Parameters<typeof evaluateWorkspaceResourceAccess>[0],
      'administrator' | 'visibility' | 'privateOwnerUserId' | 'personalWorkspaceId'
    >
  > = {}
) =>
  evaluateWorkspaceResourceAccess({
    workspaceId,
    policy: { schemaVersion: 1, statements },
    actor: current,
    administrator: false,
    visibility: 'workspace',
    ...audience,
    resource,
    operation,
  });

describe('named Workspace resource Kernel projection', () => {
  it('requires the additional resource association independently of primary admission', () => {
    expect(decide([]).effect).toBe('allow');
    expect(decide([boundary, permission]).effect).toBe('allow');
    expect(decide([boundary, permission], 'turn.run').effect).toBe('deny');
    expect(
      decide([boundary, permission], 'thread.read', { kind: 'user', userId: otherUserId }).effect
    ).toBe('deny');
    // Core Policy: a resource allocation cannot restore missing current membership.
    const primary = evaluateProductAccess({
      facts: {
        userId,
        activeUser: true,
        administrator: false,
        credential: { kind: 'session', current: true, workspaceBound: true, readOnly: false },
      },
      target: { kind: 'workspace', workspaceId, active: true, membership: null },
      operation: 'thread.read',
      mutating: false,
    });
    expect(primary.effect).toBe('deny');
    expect(decide([boundary, permission]).effect).toBe('allow');
    const revoked = decide([boundary]);
    expect(revoked.effect).toBe('deny');
    expect(revoked.reasons).toContainEqual(expect.objectContaining({ code: 'missing-privilege' }));
    expect(revoked.reasons).not.toContainEqual(expect.objectContaining({ code: 'invalid-policy' }));
  });

  it('keeps private and personal audiences mandatory beside exact allocation', () => {
    const privateAudience = { visibility: 'private' as const, privateOwnerUserId: userId };
    expect(decide([], 'thread.read', actor, privateAudience).effect).toBe('allow');
    const otherActor = { kind: 'user' as const, userId: otherUserId };
    const denied = decide([], 'thread.read', otherActor, privateAudience);
    expect(denied.effect).toBe('deny');
    expect(denied.reasons).toContainEqual(expect.objectContaining({ code: 'missing-privilege' }));
    expect(denied.reasons).not.toContainEqual(expect.objectContaining({ code: 'invalid-policy' }));
    expect(
      decide([], 'thread.read', otherActor, { ...privateAudience, administrator: true }).effect
    ).toBe('allow');
    expect(
      decide([boundary, permission], 'thread.read', actor, {
        ...privateAudience,
        privateOwnerUserId: otherUserId,
      }).effect
    ).toBe('deny');
    expect(decide([], 'thread.read', actor, { personalWorkspaceId: workspaceId }).effect).toBe(
      'allow'
    );
    const personalAudience = { personalWorkspaceId: allocateEntityId('ws') };
    expect(decide([], 'thread.read', actor, personalAudience).effect).toBe('deny');
    expect(
      decide([], 'thread.read', actor, { ...personalAudience, administrator: true }).effect
    ).toBe('allow');
    expect(
      decide([boundary], 'thread.read', actor, {
        ...privateAudience,
        administrator: true,
      }).effect
    ).toBe('deny');
    expect(
      decide([boundary, permission], 'thread.read', actor, {
        ...privateAudience,
        administrator: true,
      }).effect
    ).toBe('allow');
  });

  it('honors explicit prohibitions and narrows later operations without changing unrelated Threads', () => {
    const prohibited = decide([
      boundary,
      permission,
      { ...permission, id: 'prohibited-read', effect: 'prohibit' },
    ]);
    expect(prohibited.effect).toBe('deny');
    expect(prohibited.reasons).toEqual([expect.objectContaining({ code: 'restriction' })]);
    const unrelated = { ...target, container: { ...target.container, id: allocateEntityId('th') } };
    expect(
      decide([{ ...boundary, scope: { ...boundary.scope, resources: [unrelated] } }]).effect
    ).toBe('allow');
    expect(
      decide([boundary, { ...permission, scope: { ...permission.scope, actions: ['turn.run'] } }])
        .effect
    ).toBe('deny');
  });

  it('does not grant a human allocation or one Agent allocation to other processes sharing its User', () => {
    const agent = {
      kind: 'agent' as const,
      userId,
      agentId: 'researcher',
      processId: 'runtime-process-a',
    };
    const agentPermission = {
      ...permission,
      grant: { kind: 'agent-process' as const, agentId: 'researcher' },
    };
    expect(decide([boundary, permission], 'thread.read', agent).effect).toBe('deny');
    expect(decide([boundary, agentPermission], 'thread.read', agent).effect).toBe('allow');
    expect(
      decide(
        [boundary, agentPermission, { ...permission, id: 'prohibit-human', effect: 'prohibit' }],
        'thread.read',
        agent
      ).effect
    ).toBe('deny');
    expect(
      decide([boundary, agentPermission], 'thread.read', { ...agent, agentId: 'another-agent' })
        .effect
    ).toBe('deny');
    expect(decide([boundary, agentPermission], 'thread.read', actor).effect).toBe('deny');
    expect(
      decide(
        [
          boundary,
          agentPermission,
          { ...agentPermission, id: 'prohibit-agent', effect: 'prohibit' },
        ],
        'thread.read',
        agent
      ).effect
    ).toBe('deny');
  });
});
