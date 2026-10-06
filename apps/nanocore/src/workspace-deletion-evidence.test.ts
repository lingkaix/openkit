import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { ensureLocalUser } from './auth/identity.js';
import { FsStore } from './lib/store.js';
import { openCoreDb, openWorkspaceDb } from './storage/db.js';
import { applyMigrations, applyScopedMigrations } from './storage/migrate.js';
import {
  createWorkspaceDeletionClosure,
  existingWorkspaceDeletionClosureRoot,
  verifyWorkspaceDeletionClosure,
} from './workspace-deletion-evidence.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

it('verifies extended descriptive closure bytes after reopen while inventory and requirements stay exact', () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-closure-extensions-'));
  const coreDb = openCoreDb(dataRoot);
  try {
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = new FsStore({ dataRoot });
    const workspace = store.createWorkspace('Closure annotations');
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'user_local',
      workspaceId: workspace.id,
    });
    const input = {
      coreDb,
      dataRoot,
      workspaceId: workspace.id,
      repositoryWorkspaceDb: (workspaceId: string) => {
        const db = openWorkspaceDb(dataRoot, workspaceId);
        applyScopedMigrations(db);
        return db;
      },
      requestId: '00000000-0000-4000-8000-000000000001',
      originalOwnerUserId: 'user_local',
      sourceRegistryRevision: 1,
      closureId: 'wsclose_extended',
      cutoffTimestamp: '2026-10-06T00:00:00.000Z',
      recoveryExportId: 'wsexp_separate',
      recoveryExportManifestDigest: `sha256:${'a'.repeat(64)}`,
    };
    const baseline = createWorkspaceDeletionClosure(input);
    const closureRoot = existingWorkspaceDeletionClosureRoot(
      dataRoot,
      workspace.id,
      input.closureId
    );
    const path = join(closureRoot, 'workspace-closure.json');
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    raw.annotation = 'closure';
    raw.lineage.annotation = 'lineage';
    const bytes = `${JSON.stringify(raw)}\n`;
    writeFileSync(path, bytes);
    const read = verifyWorkspaceDeletionClosure({ ...input, closureRoot });
    expect(read).not.toHaveProperty('annotation');
    expect(read.lineage).not.toHaveProperty('annotation');
    expect(read.contentDigest).toBe(baseline.contentDigest);
    expect(read.manifestDigest).toBe(`sha256:${createHash('sha256').update(bytes).digest('hex')}`);
    expect(readFileSync(path, 'utf8')).toBe(bytes);
    expect(verifyWorkspaceDeletionClosure({ ...input, closureRoot })).toEqual(read);
    raw.contentInventory[0].annotation = 'inventory';
    writeFileSync(path, JSON.stringify(raw));
    expect(() => verifyWorkspaceDeletionClosure({ ...input, closureRoot })).toThrow(
      /Unrecognized key/
    );
    delete raw.contentInventory[0].annotation;
    raw.requiredFeatures = ['unsupported.closure.v1'];
    writeFileSync(path, JSON.stringify(raw));
    expect(() => verifyWorkspaceDeletionClosure({ ...input, closureRoot })).toThrow(
      /required feature/
    );
    raw.requiredFeatures = [];
    raw.lineage.workspaceId = 'ws_wrong';
    writeFileSync(path, JSON.stringify(raw));
    expect(() => verifyWorkspaceDeletionClosure({ ...input, closureRoot })).toThrow(
      /contradictory/
    );
  } finally {
    coreDb.sqlite.close();
  }
});
