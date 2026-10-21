import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { openWorkspaceDb } from '../storage/db.js';
import { createTestStore } from '../test-support/store.js';
import { FsStore } from './store.js';

let dataRoot: string | undefined;
afterEach(async () => {
  await shutdownControlStoreWorkerClient();
  if (dataRoot) rmSync(dataRoot, { recursive: true, force: true });
  dataRoot = undefined;
});

describe('record publication before a later aggregate failure', () => {
  it('preserves an already committed Thread when a later sibling preparation fails', async () => {
    dataRoot = mkdtempSync(join(tmpdir(), 'store-late-publication-'));
    const store = createTestStore({ dataRoot });
    const workspace = await store.createWorkspace('Publication boundaries');
    const first = await store.createThread(workspace.id, 'Original first Thread');
    const second = await store.createThread(workspace.id, 'Second Thread');
    const actor = { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' } as const;
    await store.createTurn(workspace.id, first.id, 'First request', actor);
    await store.createTurn(workspace.id, second.id, 'Second request', actor);
    const committed = await store.updateThread(workspace.id, first.id, {
      name: 'Durably committed first Thread',
    });
    const db = openWorkspaceDb(dataRoot, workspace.id);
    let committedBytes: string;
    try {
      committedBytes = (
        db.sqlite.prepare('SELECT record_json FROM control_threads WHERE id=?').get(first.id) as {
          record_json: string;
        }
      ).record_json;
      expect(JSON.parse(committedBytes).name).toBe('Durably committed first Thread');
      // A later independent native transition cannot roll back an earlier acknowledged tuple.
      const previousSecond = store.getThread(workspace.id, second.id);
      db.sqlite.exec(
        `CREATE TRIGGER refuse_sibling BEFORE UPDATE ON control_threads WHEN NEW.id='${second.id}' BEGIN SELECT RAISE(ABORT, 'injected sibling refusal'); END`
      );
      await expect(
        store.updateThread(workspace.id, second.id, { name: 'Refused sibling' })
      ).rejects.toMatchObject({ commit: 'not-committed' });
      expect(store.getThread(workspace.id, second.id)).toEqual(previousSecond);
      expect(
        (
          db.sqlite.prepare('SELECT record_json FROM control_threads WHERE id=?').get(first.id) as {
            record_json: string;
          }
        ).record_json
      ).toBe(committedBytes);
    } finally {
      db.sqlite.exec('DROP TRIGGER refuse_sibling');
      db.sqlite.close();
    }
    expect(store.getThread(workspace.id, first.id)).toEqual(committed);
    expect(new FsStore({ dataRoot }).getThread(workspace.id, first.id)).toEqual(committed);
    await store.updateWorkspace(workspace.id, { name: 'Unrelated Workspace update' });
    expect(new FsStore({ dataRoot }).getThread(workspace.id, first.id)).toEqual(committed);
    const preserved = openWorkspaceDb(dataRoot, workspace.id);
    try {
      expect(
        (
          preserved.sqlite
            .prepare('SELECT record_json FROM control_threads WHERE id=?')
            .get(first.id) as { record_json: string }
        ).record_json
      ).toBe(committedBytes);
    } finally {
      preserved.sqlite.close();
    }
  });
});
