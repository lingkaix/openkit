import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OPERATION_DEFINITIONS } from '@openkit/app-api-schemas';
import { expect, it, vi } from 'vitest';
import { createAppSearchOperationImplementations } from './app-search-operation-implementations.js';
import { refuseScope } from './bootstrap/readiness.js';
import { FsStore } from './lib/store.js';
import { admitOperation } from './operation-resolvers.js';
import { shutdownControlStoreWorkerClient } from './storage/control-store-worker-client.js';
import { openCoreDb } from './storage/db.js';
import { workspaceDbPath } from './storage/fs-layout.js';
import { applyMigrations } from './storage/migrate.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';
import { WorkspaceMutationAdmission } from './workspace-mutation-admission.js';

it('searches healthy authorized siblings without reading quarantined or unauthorized Workspaces', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'search-scope-'));
  const coreDb = openCoreDb(dataRoot);
  try {
    applyMigrations(coreDb);
    const userId = 'usr_00000000-0000-7000-8000-000000000001';
    const outsideOwner = 'usr_00000000-0000-7e68-8ab1-8dcac1be1b5b';
    for (const [id, email] of [
      [userId, 'search-member@example.invalid'],
      [outsideOwner, 'search-owner@example.invalid'],
    ]) {
      coreDb.sqlite
        .prepare(`INSERT INTO users
        (id, display_name, email, email_verified, created_at, updated_at, kind, status)
        VALUES (?, 'Search viewer', ?, 0, ?, ?, 'human', 'active')`)
        .run(id, email, Date.now(), Date.now());
    }
    const store = new FsStore({ dataRoot });
    const bad = await store.createWorkspace('Scope match quarantined');
    const good = await store.createWorkspace('Scope match healthy');
    const hidden = await store.createWorkspace('Scope match outside audience');
    for (const workspace of [bad, good, hidden]) {
      recordWorkspaceOwnerMembership({
        coreDb,
        workspaceId: workspace.id,
        ownerUserId: workspace.id === hidden.id ? outsideOwner : userId,
      });
    }
    refuseScope(dataRoot, { scope: 'workspace', id: bad.id, check: 'database' });
    const input = { query: 'scope match' };
    const admitted = await admitOperation(
      OPERATION_DEFINITIONS['app.search'],
      input,
      { kind: 'public', actor: { kind: 'session', userId } },
      { dataRoot, coreDb, store, workspaceMutationAdmission: new WorkspaceMutationAdmission() }
    );
    expect(admitted.context.scope).toMatchObject({ kind: 'authorized-workspace-set' });
    if (admitted.context.scope.kind !== 'authorized-workspace-set')
      throw new Error('Unexpected scope.');
    expect(admitted.context.scope.workspaceIds).toEqual(expect.arrayContaining([bad.id, good.id]));
    expect(admitted.context.scope.workspaceIds).not.toContain(hidden.id);
    await shutdownControlStoreWorkerClient();
    const badRecord = workspaceDbPath(dataRoot, bad.id);
    const before = readFileSync(badRecord);
    const reads = vi.spyOn(store, 'getWorkspace');
    try {
      const result = await createAppSearchOperationImplementations({ coreDb, store })['app.search'](
        input,
        admitted.context
      );
      expect(result.items.filter(({ kind }) => kind === 'workspace').map(({ id }) => id)).toEqual([
        good.id,
      ]);
      expect(reads.mock.calls.some(([id]) => id === bad.id || id === hidden.id)).toBe(false);
      expect(readFileSync(badRecord)).toEqual(before);
    } finally {
      reads.mockRestore();
      admitted.release?.();
    }
  } finally {
    coreDb.sqlite.close();
    await shutdownControlStoreWorkerClient();
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
