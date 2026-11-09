// openkit-test-platform: posix
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { FsStore } from '../lib/store.js';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { createMeasurementEffectFixture } from '../test-support/load-effect.fixture.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';

it('keeps the real MCP Item and Turn unchanged when session DELETE resets during close', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'load-cleanup-outcome-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  const userId = await ensureLocalUser(coreDb);
  const store = new FsStore({ dataRoot });
  const workspace = await store.createWorkspace('cleanup outcomes');
  await recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
  const db = openWorkspaceDb(dataRoot, workspace.id);
  applyScopedMigrations(db);
  const fixture = await createMeasurementEffectFixture({
    dataRoot,
    coreDb,
    store,
    userId,
    workspaces: [{ workspace, db }],
  });
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const nativeFetch = globalThis.fetch;
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation((request, init) => {
    if (init?.method === 'DELETE')
      return Promise.reject(
        new TypeError('fetch failed', {
          cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
        })
      );
    return nativeFetch(request, init);
  });
  try {
    const witness = await fixture.call(workspace.id, 1);
    const turn = await store.getTurnById(witness.turnId);
    const verified = fixture.verify(witness);
    await expect(fixture.close()).resolves.toEqual({ clientCloseFailures: 0 });
    expect(fixture.verify(witness)).toEqual(verified);
    expect(await store.getTurnById(witness.turnId)).toEqual(turn);
    expect(turn?.status).toBe('running');
    expect(
      warn.mock.calls.filter(([line]) =>
        String(line).includes('worker.mcp.session-termination-failed')
      )
    ).toHaveLength(1);
  } finally {
    fetch.mockRestore();
    warn.mockRestore();
    await fixture.close();
    await shutdownControlStoreWorkerClient();
    db.sqlite.close();
    coreDb.sqlite.close();
  }
});
