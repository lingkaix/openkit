import { allocateEntityId, ThreadSchema } from '@openkit/protocol';
import { describe, expect, it } from 'vitest';
import { FsStore } from '../lib/store.js';
import { managedThreadPolicy } from '../test-support/resource-policy.js';
import { canDiscloseThreadToAudience, isThreadVisible } from './thread-visibility.js';

describe('current managed Thread audience', () => {
  it('uses the loaded boundary for discovery, source reads and revocation, including administrators', async () => {
    const store = new FsStore();
    const workspace = await store.createWorkspace('Managed audience');
    const managed = await store.createThread(workspace.id, 'Restricted');
    const ordinary = await store.createThread(workspace.id, 'Ordinary');
    const userId = allocateEntityId('usr');
    const otherId = allocateEntityId('usr');
    let policy = managedThreadPolicy({
      workspaceId: workspace.id,
      threadId: managed.id,
      userId,
      operations: ['thread.read'],
    });
    store.setWorkspaceResourcePolicyProjection(() => policy);
    expect(isThreadVisible(store, managed, userId)).toBe(true);
    expect(isThreadVisible(store, managed, userId, false, 'turn.run')).toBe(false);
    expect(isThreadVisible(store, managed, otherId)).toBe(false);
    expect(isThreadVisible(store, managed, otherId, true)).toBe(false);
    expect(
      store.listThreads(workspace.id).filter((thread) => isThreadVisible(store, thread, otherId))
    ).toEqual([ordinary]);
    policy = {
      ...policy,
      statements: policy.statements.filter((statement) => statement.kind === 'managed-boundary'),
    };
    expect(isThreadVisible(store, managed, userId)).toBe(false);
    expect(isThreadVisible(store, ordinary, userId)).toBe(true);
  });
});

it('does not copy a managed source into an unmanaged or different audience', async () => {
  const store = new FsStore();
  const workspace = await store.createWorkspace('Source boundary');
  const source = await store.createThread(workspace.id, 'Managed source');
  const destination = await store.createThread(workspace.id, 'Broad destination');
  const matching = await store.createThread(workspace.id, 'Matching destination');
  const userId = allocateEntityId('usr');
  store.setWorkspaceResourcePolicyProjection(() => ({
    schemaVersion: 1,
    statements: [
      ...managedThreadPolicy({
        workspaceId: workspace.id,
        threadId: source.id,
        userId,
        operations: ['thread.read'],
      }).statements,
      ...managedThreadPolicy({
        workspaceId: workspace.id,
        threadId: matching.id,
        userId,
        operations: ['thread.read'],
      }).statements,
    ],
  }));
  expect(canDiscloseThreadToAudience(store, source, source)).toBe(true);
  expect(canDiscloseThreadToAudience(store, source, destination)).toBe(false);
  expect(canDiscloseThreadToAudience(store, source, null)).toBe(false);
  expect(canDiscloseThreadToAudience(store, source, matching)).toBe(true);
  expect(canDiscloseThreadToAudience(store, destination, source)).toBe(true);
});

it('never interprets a Server Thread as Workspace audience authority', () => {
  const store = new FsStore();
  const timestamp = '2026-10-19T00:00:00.000Z';
  const thread = ThreadSchema.parse({
    id: allocateEntityId('th'),
    owner: { kind: 'server' },
    name: 'Server work',
    preview: 'Server work',
    status: 'active',
    entryPath: 'knowledge-manager',
    visibility: 'server',
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  for (const administratorEligible of [false, true]) {
    expect(isThreadVisible(store, thread, allocateEntityId('usr'), administratorEligible)).toBe(
      false
    );
  }
  expect(canDiscloseThreadToAudience(store, thread, thread)).toBe(false);
  expect(canDiscloseThreadToAudience(store, thread, null)).toBe(false);
});
