import { allocateEntityId } from '@openkit/protocol';
import { describe, expect, it } from 'vitest';
import { WorkspaceConfigSchema } from './workspace.js';

const workspaceId = allocateEntityId('ws');
const threadId = allocateEntityId('th');
const userId = allocateEntityId('usr');
const owner = { kind: 'workspace', workspaceId };
const resource = { kind: 'container', container: { owner, kind: 'thread', id: threadId } };
const envelope = {
  author: { kind: 'human', id: userId },
  authority: { kind: 'human', userId },
  authoredAt: '2026-10-19T00:00:00.000Z',
  state: 'active',
  lifetime: { anchor: { owner, kind: 'workspace', id: workspaceId } },
};
const boundary = {
  ...envelope,
  kind: 'managed-boundary',
  id: 'private-thread',
  scope: { subjects: [], actions: [], resources: [resource] },
};
const permission = {
  ...envelope,
  kind: 'permission',
  id: 'thread-read',
  effect: 'allow',
  grant: { kind: 'ordinary' },
  scope: {
    subjects: [{ kind: 'human', id: userId }],
    actions: ['thread.read'],
    resources: [resource],
  },
};
const config = (statements: unknown[]) => ({
  schemaVersion: 1,
  requiredFeatures: ['openkit.workspace-resource-policy.v1'],
  workspace: { name: 'Private project', policy: { mediation: { schemaVersion: 1, statements } } },
});

describe('Workspace resource privacy configuration', () => {
  it('refuses retired resource-access grammar in authored Workspace Policy', () => {
    expect(
      WorkspaceConfigSchema.safeParse({
        schemaVersion: 1,
        requiredFeatures: ['openkit.workspace-resource-policy.v1'],
        workspace: {
          name: 'Private project',
          policy: {
            resourceAccess: [
              {
                resource: { family: 'thread', id: threadId },
                grants: [{ subject: { kind: 'user', userId }, operations: ['thread.read'] }],
                prohibitions: [],
              },
            ],
          },
        },
      }).success
    ).toBe(false);
  });

  it('retains a scope-owned managed boundary when its final positive allocation is revoked', () => {
    const saved = WorkspaceConfigSchema.parse(config([boundary, permission]));
    expect(saved.workspace.policy?.mediation?.statements).toEqual([boundary, permission]);
    expect(
      WorkspaceConfigSchema.parse(config([boundary])).workspace.policy?.mediation?.statements
    ).toEqual([boundary]);
  });

  it('rejects missing feature declarations and malformed scope-owned authority without stripping it', () => {
    const valid = config([boundary]);
    expect(
      WorkspaceConfigSchema.safeParse({ schemaVersion: 1, workspace: valid.workspace }).success
    ).toBe(false);
    for (const invalid of [
      {
        ...boundary,
        scope: {
          ...boundary.scope,
          resources: [{ ...resource, container: { owner, kind: 'artifact', id: threadId } }],
        },
      },
      { ...boundary, extraAuthority: true },
      { ...permission, scope: { ...permission.scope, actions: ['unknown.operation'] } },
    ])
      expect(WorkspaceConfigSchema.safeParse(config([invalid])).success).toBe(false);
    expect(
      WorkspaceConfigSchema.safeParse(config([boundary, { ...boundary, id: 'duplicate-target' }]))
        .success
    ).toBe(false);
  });
});
