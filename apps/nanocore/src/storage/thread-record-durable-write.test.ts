// openkit-test-platform: posix
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestStore } from '../test-support/store.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './control-store-worker-client.js';
import { nativeProductScope, readNativeProduct } from './workspace-file-records.js';

const roots: string[] = [];
afterEach(async () => {
  await shutdownControlStoreWorkerClient();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Current Thread record durable publication', () => {
  it('acknowledges the owning FULL commit and retains Thread metadata after Store reopen', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-visibility-durable-'));
    roots.push(dataRoot);
    const store = createTestStore({ dataRoot });
    const workspace = await store.createWorkspace('Migration workspace');
    const formal = await store.createThread(workspace.id, 'Formal worker history');
    const turn = await store.createTurn(workspace.id, formal.id, 'Work', {
      kind: 'user',
      id: 'usr_00000000-0000-7000-8000-000000000001',
    });
    await store.updateTurn(turn.id, { agentId: 'agent_codex_host' });
    const scope = nativeProductScope(dataRoot, { kind: 'workspace', workspaceId: workspace.id });
    // Inspect the actual writer connection; a separate reader's synchronous pragma proves no write policy.
    const policy = await getControlStoreWorkerClient().write(`workspace:${scope.path}`, [
      {
        mode: 'get',
        sql: 'SELECT (SELECT synchronous FROM pragma_synchronous) AS synchronization, (SELECT journal_mode FROM pragma_journal_mode) AS journalMode',
        parameters: [],
      },
    ]);
    expect(policy).toMatchObject([{ row: { synchronization: 2n, journalMode: 'wal' } }]);
    const updated = await store.updateThread(workspace.id, formal.id, {
      name: 'Updated formal work',
    });
    expect(updated).toMatchObject({
      name: 'Updated formal work',
      owner: { kind: 'workspace', workspaceId: workspace.id },
      visibility: 'workspace',
    });
    expect(readNativeProduct(scope, 'thread', formal.id)?.record).toMatchObject(updated);
    const retainedTurn = store.getTurnById(turn.id);
    await shutdownControlStoreWorkerClient();
    const reopened = createTestStore({ dataRoot });
    expect(reopened.getThread(workspace.id, formal.id)).toEqual(updated);
    expect(reopened.getTurnById(turn.id)).toEqual(retainedTurn);
  });
});
