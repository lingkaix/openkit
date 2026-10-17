import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, onTestFinished } from 'vitest';
import { createRuntimeConfigManager } from '../config/runtime-config.js';
import { FsStore } from '../lib/store.js';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { createApp } from '../test-support/app.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';

it('keeps scheduling off by default and retains a visible unavailable-model outcome once per day', () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'km-schedule-app-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  onTestFinished(() => {
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  const store = new FsStore({ dataRoot });
  const workspace = store.createWorkspace('Scheduled maintenance');
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
  const directory = join(dataRoot, 'workspaces', workspace.id, 'config');
  mkdirSync(directory, { recursive: true });
  const configure = (enabled: boolean) => writeFileSync(join(directory, 'workspace.jsonc'), JSON.stringify({
    schemaVersion: 1,
    workspace: { name: workspace.name,
      internalRoles: [{ roleId: 'knowledge-manager', profileId: 'missing-knowledge-profile' }],
      knowledgeMaintenance: {
      enabled: false, reviewRequiredPageIds: [], ...(enabled ? { schedule: { enabled: true } } : {}),
    } },
  }));
  let scan!: (instant: string) => void;
  const boot = () => createApp({
    coreDb, dataRoot, store, runtimeConfigManager: createRuntimeConfigManager({ dataRoot }),
    onKnowledgeMaintenanceReady: (callback) => { scan = callback; },
  });
  const turns = () => store.listThreads(workspace.id).flatMap((thread) => store.listThreadTurns(workspace.id, thread.id));
  configure(false);
  boot();
  scan('2026-10-17T10:00:00.000Z');
  expect(turns()).toEqual([]);
  configure(true);
  boot();
  scan('2026-10-17T10:01:00.000Z');
  const retained = turns();
  expect(retained).toHaveLength(1);
  expect(retained[0]).toMatchObject({
    agentId: 'knowledge-manager', status: 'failed',
    triggerSource: { kind: 'automation', summary: 'Knowledge Manager scheduled maintenance.' },
    error: { code: 'knowledge_maintenance_failed' },
  });
  const turn = retained[0]!;
  expect(store.listThreadItems(workspace.id, turn.threadId).filter((item) => item.turnId === turn.id)).toContainEqual(expect.objectContaining({
    type: 'status', status: 'failed', title: 'Knowledge maintenance',
  }));
  // Boot and a later scan retain the same outcome; neither restarts model work.
  boot();
  scan('2026-10-17T20:00:00.000Z');
  expect(turns().map(({ id }) => id)).toEqual([turn.id]);
});
