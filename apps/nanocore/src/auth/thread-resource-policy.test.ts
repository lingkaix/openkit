import type { WorkspaceResourceAccessEntry } from '@openkit/config-schema';
import { allocateEntityId } from '@openkit/protocol';
import { describe, expect, it } from 'vitest';
import { FsStore } from '../lib/store.js';
import { canDiscloseThreadToAudience, isThreadVisible } from './thread-visibility.js';

describe('current managed Thread audience', () => {
  it('uses the loaded boundary for discovery, source reads and revocation, including administrators', () => {
    const store = new FsStore();
    const workspace = store.createWorkspace('Managed audience');
    const managed = store.createThread(workspace.id, 'Restricted');
    const ordinary = store.createThread(workspace.id, 'Ordinary');
    const userId = allocateEntityId('usr');
    const otherId = allocateEntityId('usr');
    let entries: WorkspaceResourceAccessEntry[] = [
      {
        resource: { family: 'thread', id: managed.id },
        grants: [{ subject: { kind: 'user', userId }, operations: ['thread.read'] }],
        prohibitions: [],
      },
    ];
    store.setWorkspaceResourcePolicyProjection(() => entries);
    expect(isThreadVisible(store, managed, userId)).toBe(true);
    expect(isThreadVisible(store, managed, userId, false, 'turn.run')).toBe(false);
    expect(isThreadVisible(store, managed, otherId)).toBe(false);
    expect(isThreadVisible(store, managed, otherId, true)).toBe(false);
    expect(
      store.listThreads(workspace.id).filter((thread) => isThreadVisible(store, thread, otherId))
    ).toEqual([ordinary]);
    entries = [{ ...entries[0]!, grants: [] }];
    expect(isThreadVisible(store, managed, userId)).toBe(false);
    expect(isThreadVisible(store, ordinary, userId)).toBe(true);
  });
});

it('does not copy a managed source into an unmanaged or different audience', () => {
  const store = new FsStore();
  const workspace = store.createWorkspace('Source boundary');
  const source = store.createThread(workspace.id, 'Managed source');
  const destination = store.createThread(workspace.id, 'Broad destination');
  const matching = store.createThread(workspace.id, 'Matching destination');
  const grants = [
    {
      subject: { kind: 'user' as const, userId: allocateEntityId('usr') },
      operations: ['thread.read' as const],
    },
  ];
  store.setWorkspaceResourcePolicyProjection(() => [
    { resource: { family: 'thread', id: source.id }, grants, prohibitions: [] },
    { resource: { family: 'thread', id: matching.id }, grants, prohibitions: [] },
  ]);
  expect(canDiscloseThreadToAudience(store, source, source)).toBe(true);
  expect(canDiscloseThreadToAudience(store, source, destination)).toBe(false);
  expect(canDiscloseThreadToAudience(store, source, null)).toBe(false);
  expect(canDiscloseThreadToAudience(store, source, matching)).toBe(true);
  expect(canDiscloseThreadToAudience(store, destination, source)).toBe(true);
});
