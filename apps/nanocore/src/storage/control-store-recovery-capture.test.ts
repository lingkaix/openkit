// openkit-test-platform: posix
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId } from '@openkit/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { openTestNativeWorkspace } from '../test-support/store.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './control-store-worker-client.js';
import { openWorkspaceDb, type WorkspaceDb } from './db.js';
import { workspaceDbPath } from './fs-layout.js';
import { applyScopedMigrations } from './migrate.js';
import { inspectCapture, protectCapture } from './workspace-capture-protection.js';

const roots: string[] = [];
const handles: WorkspaceDb[] = [];

afterEach(async () => {
  await shutdownControlStoreWorkerClient();
  for (const db of handles.splice(0)) if (db.sqlite.open) db.sqlite.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Produces real capture authority before the native writer opens the same physical Workspace. */
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'native-recovery-capture-'));
  roots.push(root);
  const workspaceId = allocateEntityId('ws');
  const db = openWorkspaceDb(root, workspaceId);
  handles.push(db);
  applyScopedMigrations(db, undefined, 'pre-knowledge');
  const captureId = randomUUID();
  const siblingId = randomUUID();
  const selected = protectCapture(db, workspaceId, captureId);
  const sibling = protectCapture(db, workspaceId, siblingId);
  await openTestNativeWorkspace(db);
  return {
    root,
    db,
    workspaceId,
    captureId,
    siblingId,
    selected,
    sibling,
    client: getControlStoreWorkerClient(),
    database: `workspace:${workspaceDbPath(root, workspaceId)}`,
  };
}

/** Observes persisted SQL independently of the native acknowledgement or returned owner values. */
function retainedRows(db: WorkspaceDb) {
  return db.sqlite.prepare('SELECT * FROM workspace_capture_records ORDER BY capture_id').all();
}

describe('native selected capture recovery', () => {
  it.each([
    'finished',
    'abandoned',
  ] as const)('durably retains the first %s decision for only the selected capture', async (state) => {
    const f = await fixture();
    const input = { workspaceId: f.workspaceId, captureId: f.captureId, state };
    await expect(f.client.recoveryCapture(f.database, input)).resolves.toBeUndefined();
    const terminal = inspectCapture(f.db, f.workspaceId, f.captureId);
    expect(terminal).toEqual({ ...f.selected, state, endedAt: expect.any(String) });
    expect(inspectCapture(f.db, f.workspaceId, f.siblingId)).toEqual(f.sibling);
    const committed = retainedRows(f.db);
    expect(committed).toHaveLength(2);
    // Operator Contract selects one capture; the first terminal decision cannot be replaced.
    await expect(f.client.recoveryCapture(f.database, input)).resolves.toBeUndefined();
    await expect(
      f.client.recoveryCapture(f.database, {
        ...input,
        state: state === 'finished' ? 'abandoned' : 'finished',
      })
    ).rejects.toThrow();
    expect(retainedRows(f.db)).toEqual(committed);
    await f.client.close(f.database);
    f.db.sqlite.close();
    const reopened = openWorkspaceDb(f.root, f.workspaceId);
    handles.push(reopened);
    expect(retainedRows(reopened)).toEqual(committed);
    expect(inspectCapture(reopened, f.workspaceId, f.captureId)).toEqual(terminal);
    // Snapshot Cut And Capture Protection keeps unrelated active protection through reopen.
    expect(inspectCapture(reopened, f.workspaceId, f.siblingId)).toEqual(f.sibling);
  });

  it('refuses a foreign Workspace selector and absent capture without changing protection', async () => {
    const f = await fixture();
    const before = retainedRows(f.db);
    await expect(
      f.client.recoveryCapture(f.database, {
        workspaceId: allocateEntityId('ws'),
        captureId: f.captureId,
        state: 'finished',
      })
    ).rejects.toThrow();
    expect(retainedRows(f.db)).toEqual(before);
    await expect(
      f.client.recoveryCapture(f.database, {
        workspaceId: f.workspaceId,
        captureId: randomUUID(),
        state: 'abandoned',
      })
    ).rejects.toThrow();
    expect(retainedRows(f.db)).toEqual(before);
  });
});
