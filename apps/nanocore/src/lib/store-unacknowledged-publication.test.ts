import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ControlStoreWorkerError,
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from '../storage/control-store-worker-client.js';
import { openWorkspaceDb } from '../storage/db.js';
import { createTestStore } from '../test-support/store.js';
import { FsStore } from './store.js';

let dataRoot: string | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await shutdownControlStoreWorkerClient();
  if (dataRoot) rmSync(dataRoot, { recursive: true, force: true });
  dataRoot = undefined;
});

describe('unacknowledged canonical Thread publication', () => {
  it('preserves the visible candidate during later unrelated Workspace persistence', async () => {
    dataRoot = mkdtempSync(join(tmpdir(), 'store-unacknowledged-publication-'));
    const store = createTestStore({ dataRoot });
    const workspace = await store.createWorkspace('Initial Workspace');
    const previousThread = await store.createThread(workspace.id, 'Previous Thread');
    const client = getControlStoreWorkerClient();
    const products = client.products.bind(client);
    let commits = 0;
    const interception = vi.spyOn(client, 'products').mockImplementationOnce(async (...args) => {
      await products(...args);
      commits++;
      // Drop delivery of the real successful native ACK to this Store caller.
      throw new ControlStoreWorkerError('unavailable', 'unknown');
    });
    await expect(
      store.updateThread(workspace.id, previousThread.id, { name: 'Visible unacknowledged Thread' })
    ).rejects.toMatchObject({ commit: 'unknown' });
    expect(commits).toBe(1);
    expect(interception).toHaveBeenCalledOnce();
    interception.mockRestore();
    const db = openWorkspaceDb(dataRoot, workspace.id);
    let candidateBytes: string;
    try {
      candidateBytes = (
        db.sqlite
          .prepare('SELECT record_json FROM control_threads WHERE id=?')
          .get(previousThread.id) as { record_json: string }
      ).record_json;
      expect(JSON.parse(candidateBytes).name).toBe('Visible unacknowledged Thread');
      expect(JSON.parse(candidateBytes)).toMatchObject({
        id: previousThread.id,
        owner: previousThread.owner,
      });
    } finally {
      db.sqlite.close();
    }
    // Committed SQL is a truthful read even while the original caller's result is unknown.
    expect(store.getThread(workspace.id, previousThread.id).name).toBe(
      'Visible unacknowledged Thread'
    );
    await store.updateWorkspace(workspace.id, { name: 'Unrelated Workspace update' });
    const reopened = new FsStore({ dataRoot });
    expect(reopened.getThread(workspace.id, previousThread.id).name).toBe(
      'Visible unacknowledged Thread'
    );
    const preserved = openWorkspaceDb(dataRoot, workspace.id);
    try {
      expect(
        (
          preserved.sqlite
            .prepare('SELECT record_json FROM control_threads WHERE id=?')
            .get(previousThread.id) as { record_json: string }
        ).record_json
      ).toBe(candidateBytes);
    } finally {
      preserved.sqlite.close();
    }
  });
});
