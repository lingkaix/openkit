import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId, ThreadSchema } from '@openkit/protocol';
import { describe, expect, it, onTestFinished } from 'vitest';
import { closeWorkspaceProductReadHandles } from '../storage/control-store-products.js';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { createDemoWorkspaceForUser } from '../test-support/demo-store.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { notebookImportFixture } from '../test-support/notebook-import.js';
import { closeTestCoreDb, createTestCoreDb, createTestStore } from '../test-support/store.js';
import { findAssistantTimeline, openAssistantTimeline } from './assistant-timeline.js';

/** Creates an explicit native fixture root and drains its owners before removal. */
function createTimelineStore() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'assistant-timeline-'));
  onTestFinished(async () => {
    await shutdownControlStoreWorkerClient();
    closeWorkspaceProductReadHandles(dataRoot);
    rmSync(dataRoot, { recursive: true, force: true });
  });
  const coreDb = createTestCoreDb(dataRoot);
  try {
    ensureLocalUser(coreDb);
  } finally {
    closeTestCoreDb(coreDb);
  }
  return createTestStore({ dataRoot });
}

describe('Assistant Timeline selection', () => {
  it('keeps the earliest retained conversation as the Timeline without merging or deleting history', async () => {
    const store = createTimelineStore();
    const demo = createDemoWorkspaceForUser('usr_00000000-0000-7d85-8fbd-e6550e949930');
    const workspace = {
      ...demo.workspace,
      name: 'Retained work',
      kind: 'general' as const,
      counts: { threadCount: 0, artifactCount: 0, knowledgeEntryCount: 0 },
    };
    const retained = [
      { name: 'Original', createdAt: '2026-10-15T00:00:00.000Z' },
      { name: 'Later history', createdAt: '2026-10-15T00:00:01.000Z' },
    ].map(({ name, createdAt }) =>
      ThreadSchema.parse({
        ...demo.thread,
        id: allocateEntityId('th'),
        name,
        preview: name,
        status: 'active',
        entryPath: 'conversation',
        owner: { kind: 'workspace', workspaceId: workspace.id },
        threadSource: 'conversation',
        visibility: 'private',
        privateOwnerUserId: 'usr_00000000-0000-7d85-8fbd-e6550e949930',
        createdAt,
      })
    );
    await store.importWorkspaceSnapshot({
      workspace,
      threads: retained,
      turns: [],
      knowledge: [],
      itemRevisions: [],
      artifacts: [],
      agentSessions: [],
      turnEvents: [],
      ...notebookImportFixture({ workspaceId: workspace.id, knowledge: [] }),
    });
    const first = store.getThread(workspace.id, retained[0]!.id);
    const later = store.getThread(workspace.id, retained[1]!.id);
    await store.createThread(workspace.id, 'Administration', undefined, 'administration', {
      visibility: 'private',
      privateOwnerUserId: 'usr_00000000-0000-7d85-8fbd-e6550e949930',
    });
    await store.createThread(workspace.id, 'Other user', undefined, 'conversation', {
      visibility: 'private',
      privateOwnerUserId: 'usr_00000000-0000-77d1-8a03-6e28034e0169',
    });
    await store.createThread(workspace.id, 'Shared Task');

    expect(
      await openAssistantTimeline(
        store,
        workspace.id,
        'usr_00000000-0000-7d85-8fbd-e6550e949930',
        'Replacement'
      )
    ).toEqual(first);
    expect(store.getThread(workspace.id, later.id)).toEqual(later);
    expect(store.listThreads(workspace.id)).toHaveLength(5);
  });

  it('preserves an archived Timeline until an explicit Thread update reopens it', async () => {
    const store = createTimelineStore();
    const workspace = await store.createWorkspace('Archived work');
    const timeline = await openAssistantTimeline(
      store,
      workspace.id,
      'usr_00000000-0000-7d85-8fbd-e6550e949930',
      'Assistant'
    );
    await store.archiveThread(workspace.id, timeline.id);

    expect(
      await openAssistantTimeline(
        store,
        workspace.id,
        'usr_00000000-0000-7d85-8fbd-e6550e949930',
        'New name'
      )
    ).toMatchObject({
      id: timeline.id,
      name: 'Assistant',
      status: 'archived',
    });
    expect(store.listThreads(workspace.id)).toHaveLength(1);
    await store.updateThread(workspace.id, timeline.id, { status: 'active' });
    expect(
      findAssistantTimeline(store, workspace.id, 'usr_00000000-0000-7d85-8fbd-e6550e949930')
    ).toMatchObject({
      id: timeline.id,
      status: 'active',
    });
  });
});
