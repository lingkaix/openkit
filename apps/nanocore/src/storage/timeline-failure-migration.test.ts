import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId } from '@openkit/protocol';
import { afterEach, expect, it } from 'vitest';
import { createDemoStore, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import { FIXTURE_LOCAL_USER_ID } from '../test-support/local-user.js';
import { disposeTestStore } from '../test-support/store.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
import { openWorkspaceDb } from './db.js';
import { readImmutableContentBytes } from './immutable-content-read.js';
import { applyNativeScopeMigrations, listAppliedNativeMigrationIds } from './migrate.js';
import {
  nativeProductScope,
  readNativeThreadItem,
  withNativeThreadTimelineSnapshot,
} from './workspace-file-records.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await disposeTestStore(root);
});
type Entry = {
  id: string;
  revision: number;
  content_json: string;
  identity_json: string;
  read_metadata_json: string;
};

// Owner: Conversation Timeline, Run Entries and Loading And Performance: Workspace-scoped statistics.
// Failure read metadata is a verified projection; original Item authority is unchanged.
it('reads current Workspace failure metadata from original inline and file-backed revisions', async () => {
  const kind = 'workspace' as const;
  const sourceRoot = mkdtempSync(join(tmpdir(), 'failure-source-'));
  roots.push(sourceRoot);
  const store = await createDemoStore({ dataRoot: sourceRoot });
  const actor = { kind: 'user' as const, id: FIXTURE_LOCAL_USER_ID };
  const thread = await store.createThread(DEMO_WORKSPACE_ID, 'Fresh failure metadata');
  const turn = await store.createTurn(DEMO_WORKSPACE_ID, thread.id, 'Original failures', actor);
  const createItem = store.createItem.bind(store);
  const updateItem = store.updateItem.bind(store);
  const base = {
    owner: turn.owner,
    threadId: thread.id,
    turnId: turn.id,
    status: 'completed' as const,
    createdAt: '2026-11-12T05:20:00.000Z',
    completedAt: '2026-11-12T05:20:00.000Z',
  };
  const recovered = await createItem({
    ...base,
    id: allocateEntityId('it'),
    type: 'command-execution',
    status: 'failed',
    command: 'first attempt',
    cwd: '.',
    output: 'Original inline failure',
    exitCode: 1,
    durationMs: 1,
  });
  await updateItem(recovered.id, {
    status: 'completed',
    exitCode: 0,
    output: 'Current successful revision',
  });
  const nonzero = await createItem({
    ...base,
    id: allocateEntityId('it'),
    type: 'command-execution',
    command: 'recorded exit failure',
    cwd: '.',
    output: 'Recorded nonzero exit',
    exitCode: 7,
    durationMs: 1,
  });
  const large = await createItem({
    ...base,
    id: allocateEntityId('it'),
    type: 'tool-call',
    tool: 'fixture.inspect',
    server: null,
    arguments: {},
    result: 'Original file-backed result. '.repeat(12_000),
    error: 'Recorded tool error',
    durationMs: 1,
  });
  await shutdownControlStoreWorkerClient();
  const sourceScope = nativeProductScope(sourceRoot, turn.owner);
  const target = openWorkspaceDb(sourceRoot, DEMO_WORKSPACE_ID);
  try {
    expect(listAppliedNativeMigrationIds(target.sqlite, kind)).toEqual([
      'workspace_0000_baseline',
      'workspace_0001_agent_session_current_thread',
    ]);
    const itemRows = () =>
      target.sqlite
        .prepare(
          "SELECT id,revision,content_json,identity_json,read_metadata_json FROM control_product_entries WHERE kind='item' ORDER BY id,revision"
        )
        .all() as Entry[];
    const currentMetadata = itemRows();
    expect(currentMetadata).toHaveLength(4);
    const inline = currentMetadata.find((row) => row.id === recovered.id && row.revision === 1)!;
    const file = currentMetadata.find((row) => row.id === large.id)!;
    expect(JSON.parse(inline.content_json).reference.representation).toBe('inline');
    const fileContent = JSON.parse(file.content_json);
    expect(fileContent.reference.representation).not.toBe('inline');
    const originalFileBytes = Buffer.from(
      readImmutableContentBytes(sourceScope.contentMount, turn.owner, fileContent, 2_000_000)
    );
    const targetScope = nativeProductScope(sourceRoot, turn.owner);
    const filePath = join(targetScope.contentMount.root, fileContent.reference.locator.path);
    const expected = new Map([
      [`${recovered.id}:1`, true],
      [`${recovered.id}:2`, false],
      [`${nonzero.id}:1`, true],
      [`${large.id}:1`, true],
    ]);
    for (const row of itemRows()) {
      const metadata = JSON.parse(row.read_metadata_json);
      expect(metadata.failed).toBe(expected.get(`${row.id}:${row.revision}`));
    }
    expect(
      target.sqlite
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type='index' AND name='control_items_turn_failure_idx'"
        )
        .get()
    ).toEqual({ name: 'control_items_turn_failure_idx' });
    expect(readFileSync(filePath)).toEqual(originalFileBytes);
    const failures = withNativeThreadTimelineSnapshot(targetScope, thread.id, (snapshot) =>
      snapshot.failures(turn.id)
    );
    expect(failures['command-execution']).toBe(1);
    expect(failures['tool-call']).toBe(1);
    expect(Object.values(failures).reduce((total, count) => total + count, 0)).toBe(2);
    expect(readNativeThreadItem(targetScope, thread.id, large.id)).toEqual(large);
    expect(readNativeThreadItem(targetScope, thread.id, recovered.id)).toMatchObject({
      status: 'completed',
      exitCode: 0,
    });
    const beforeReapply = target.sqlite.serialize();
    applyNativeScopeMigrations(target.sqlite, kind);
    expect(target.sqlite.serialize()).toEqual(beforeReapply);
  } finally {
    target.sqlite.close();
  }
}, 120_000);
