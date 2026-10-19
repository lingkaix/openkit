import { WORKSPACE_RESOURCE_POLICY_FEATURE, WorkspaceConfigSchema } from '@openkit/config-schema';
import { allocateEntityId } from '@openkit/protocol';
import { parse } from 'jsonc-parser';
import { describe, expect, it } from 'vitest';
import { remintResourcePolicyConfig } from './resource-policy-portability.js';

const sourceWorkspaceId = allocateEntityId('ws');
const targetWorkspaceId = allocateEntityId('ws');
const source = allocateEntityId('th');
const target = allocateEntityId('th');
const userId = allocateEntityId('usr');
const owner = { kind: 'workspace', workspaceId: sourceWorkspaceId };
const resource = { kind: 'container', container: { owner, kind: 'thread', id: source } };
const envelope = {
  author: { kind: 'human', id: userId },
  authority: { kind: 'human', userId },
  authoredAt: '2026-10-19T00:00:00.000Z',
  state: 'active',
  lifetime: { anchor: { owner, kind: 'workspace', id: sourceWorkspaceId } },
};
const boundary = {
  ...envelope,
  kind: 'managed-boundary',
  id: 'managed-thread',
  scope: { subjects: [], actions: [], resources: [resource] },
};
const config = (statements: unknown[]) =>
  JSON.stringify({
    schemaVersion: 1,
    requiredFeatures: [WORKSPACE_RESOURCE_POLICY_FEATURE],
    workspace: {
      name: 'Portable privacy',
      policy: { mediation: { schemaVersion: 1, statements } },
    },
  });
const input = {
  sourceWorkspaceId,
  targetWorkspaceId,
  content: config([boundary]),
  threads: [{ id: source, visibility: 'workspace' }],
  threadIds: new Map([[source, target]]),
  manifestFeatures: [WORKSPACE_RESOURCE_POLICY_FEATURE],
};
const remapped = (statement: typeof boundary) => ({
  ...statement,
  lifetime: {
    anchor: {
      owner: { kind: 'workspace', workspaceId: targetWorkspaceId },
      kind: 'workspace',
      id: targetWorkspaceId,
    },
  },
  scope: {
    ...statement.scope,
    resources: [
      {
        kind: 'container',
        container: {
          owner: { kind: 'workspace', workspaceId: targetWorkspaceId },
          kind: 'thread',
          id: target,
        },
      },
    ],
  },
});

describe('portable Workspace resource Policy', () => {
  it('retains an empty last-revoke boundary with its reminted Thread on a different Server', () => {
    expect(WorkspaceConfigSchema.safeParse(parse(input.content)).success).toBe(true);
    const imported = parse(remintResourcePolicyConfig(input));
    expect(imported.workspace.policy.mediation).toEqual({
      schemaVersion: 1,
      statements: [remapped(boundary)],
    });
    expect(imported.requiredFeatures).toEqual([WORKSPACE_RESOURCE_POLICY_FEATURE]);
    expect(WorkspaceConfigSchema.safeParse(imported).success).toBe(true);
  });

  it('rejects an unvalidated principal before any target publication and preserves validated terms', () => {
    const permission = {
      ...envelope,
      kind: 'permission',
      id: 'thread-read',
      scope: {
        subjects: [{ kind: 'human', id: userId }],
        actions: ['thread.read'],
        resources: [resource],
      },
      effect: 'allow',
      grant: { kind: 'ordinary' },
    };
    const prohibition = { ...permission, id: 'prohibit-thread-read', effect: 'prohibit' };
    const captured = { ...input, content: config([boundary, permission, prohibition]) };
    expect(() => remintResourcePolicyConfig(captured)).toThrow('principal binding');
    const admitted: unknown[] = [];
    const imported = parse(
      remintResourcePolicyConfig({
        ...captured,
        subjectEligible: (subject) => {
          admitted.push(subject);
          return true;
        },
      })
    );
    const expectedPermission = {
      ...remapped(boundary),
      ...permission,
      lifetime: remapped(boundary).lifetime,
      scope: { ...permission.scope, resources: remapped(boundary).scope.resources },
    };
    expect(imported.workspace.policy.mediation.statements).toEqual([
      remapped(boundary),
      expectedPermission,
      { ...expectedPermission, id: prohibition.id, effect: 'prohibit' },
    ]);
    expect(admitted).toContainEqual({ kind: 'user', userId });
    expect(() => remintResourcePolicyConfig({ ...input, manifestFeatures: [] })).toThrow(
      'required feature'
    );
    expect(() => remintResourcePolicyConfig({ ...input, threadIds: new Map() })).toThrow(
      'identity'
    );
    expect(() => remintResourcePolicyConfig({ ...input, threads: [] })).toThrow('Thread owner');
  });
});
