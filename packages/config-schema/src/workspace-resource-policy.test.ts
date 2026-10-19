import { allocateEntityId } from '@openkit/protocol';
import { describe, expect, it } from 'vitest';
import { WorkspaceConfigSchema } from './workspace.js';

const threadId = allocateEntityId('th');
const userId = allocateEntityId('usr');
const boundary = {
  resource: { family: 'thread', id: threadId },
  grants: [{ subject: { kind: 'user', userId }, operations: ['thread.read'] }],
  prohibitions: [],
};
const config = (resourceAccess: unknown[]) => ({
  requiredFeatures: ['openkit.workspace-resource-policy.v1'],
  workspace: { name: 'Private project', policy: { resourceAccess } },
});

describe('Workspace resource privacy configuration', () => {
  it('retains a managed boundary when its final positive allocation is revoked', () => {
    const saved = WorkspaceConfigSchema.parse(config([boundary]));
    expect(saved.workspace.policy?.resourceAccess).toEqual([boundary]);
    const revoked = { ...boundary, grants: [] };
    expect(WorkspaceConfigSchema.parse(config([revoked])).workspace.policy?.resourceAccess).toEqual(
      [revoked]
    );
  });

  it('rejects missing feature declarations and malformed authority without stripping it', () => {
    const valid = config([boundary]);
    expect(WorkspaceConfigSchema.safeParse({ workspace: valid.workspace }).success).toBe(false);
    for (const invalid of [
      { ...boundary, resource: { family: 'artifact', id: threadId } },
      { ...boundary, extraAuthority: true },
      { ...boundary, grants: [{ ...boundary.grants[0], operations: ['unknown.operation'] }] },
    ])
      expect(WorkspaceConfigSchema.safeParse(config([invalid])).success).toBe(false);
    expect(WorkspaceConfigSchema.safeParse(config([boundary, boundary])).success).toBe(false);
  });
});
