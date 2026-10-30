// openkit-test-platform: posix
import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId } from '@openkit/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isScopeAdmitted } from '../bootstrap/readiness.js';
import { restoreWorkspaceRecoveryAdmission } from '../bootstrap/workspace-recovery.js';
import { createDemoStore, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { createTestCoreDb, openTestNativeWorkspace } from '../test-support/store.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import { FileStorageAdmission } from './artifacts/file-admission.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './control-store-worker-client.js';
import { type CoreDb, openWorkspaceDb, type WorkspaceDb } from './db.js';
import { readDataRootLayoutMarker, workspaceDbPath } from './fs-layout.js';
import { applyScopedMigrations } from './migrate.js';
import { createWorkspaceBackup, WORKSPACE_BACKUP_POLICY } from './workspace-backup.js';
import { completeCapture, inspectCapture, protectCapture } from './workspace-capture-protection.js';
import * as recovery from './workspace-recovery-admissions.js';

const roots: string[] = [];
const handles: (CoreDb | WorkspaceDb)[] = [];

afterEach(async () => {
  await shutdownControlStoreWorkerClient();
  for (const db of handles.splice(0)) if (db.sqlite.open) db.sqlite.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Retains capture authority through its owner, without inventing a Core recovery admission. */
function fixture(competing = false) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'capture-rejoin-'));
  roots.push(dataRoot);
  const core = createTestCoreDb(dataRoot);
  handles.push(core);
  const userId = ensureLocalUser(core);
  const workspaceId = allocateEntityId('ws');
  const siblingId = allocateEntityId('ws');
  const open = (id: string) => {
    recordWorkspaceOwnerMembership({ coreDb: core, workspaceId: id, ownerUserId: userId });
    const db = openWorkspaceDb(dataRoot, id);
    handles.push(db);
    applyScopedMigrations(db);
    return db;
  };
  const db = open(workspaceId);
  const sibling = open(siblingId);
  const captureId = randomUUID();
  const selected = protectCapture(db, workspaceId, captureId);
  const competitor = competing ? protectCapture(db, workspaceId, randomUUID()) : undefined;
  const gate = new WorkspaceMutationAdmission();
  restoreWorkspaceRecoveryAdmission(core, gate);
  return {
    dataRoot,
    core,
    workspaceId,
    siblingId,
    db,
    sibling,
    captureId,
    selected,
    competitor,
    gate,
  };
}

/** Local Hot Capture and Source Seal retain exclusion across explicit recovery and native publication. */
describe('retained capture exclusion rejoin', () => {
  it('rejoins a SQL-only boot capture for exact native recovery while publishers remain fenced', async () => {
    const f = fixture();
    const client = getControlStoreWorkerClient(f.gate);
    expect(isScopeAdmitted(f.dataRoot, 'workspace', f.workspaceId)).toBe(false);
    expect(f.gate.enter(f.workspaceId)).toBeNull();
    expect(f.gate.enterLatePublisher(f.workspaceId, 'worker-turn-closeout')).toBeNull();
    await openTestNativeWorkspace(f.sibling);
    expect(isScopeAdmitted(f.dataRoot, 'workspace', f.siblingId)).toBe(true);
    const releaseSibling = f.gate.enter(f.siblingId);
    expect(releaseSibling).toBeTypeOf('function');
    releaseSibling!();
    expect(() =>
      recovery.resumeWorkspaceCaptureOwner(f.core, f.workspaceId, randomUUID(), f.gate, () => [])
    ).toThrow();
    const resume = () =>
      recovery.resumeWorkspaceCaptureOwner(f.core, f.workspaceId, f.captureId, f.gate, () => []);
    const first = resume();
    if (first.status !== 'frozen') throw new Error('Expected the retained capture owner.');
    const stale = recovery.bindWorkspaceCaptureNativeOwner(
      f.core,
      f.workspaceId,
      f.captureId,
      f.gate,
      first
    );
    first.release();
    await expect(client.open(stale.binding.command, stale)).rejects.toThrow();
    restoreWorkspaceRecoveryAdmission(f.core, f.gate);
    const freeze = resume();
    if (freeze.status !== 'frozen') throw new Error('Expected an explicit selected-capture retry.');
    const call = recovery.bindWorkspaceCaptureNativeOwner(
      f.core,
      f.workspaceId,
      f.captureId,
      f.gate,
      freeze
    );
    // The physical file is replaced after valid owner selection: pathname equality grants nothing.
    const path = workspaceDbPath(f.dataRoot, f.workspaceId);
    const original = `${path}.original`;
    renameSync(path, original);
    copyFileSync(original, path);
    try {
      await expect(client.open(call.binding.command, call)).rejects.toThrow();
      expect(inspectCapture(f.db, f.workspaceId, f.captureId)).toEqual(f.selected);
    } finally {
      rmSync(path);
      renameSync(original, path);
    }
    await client.open(call.binding.command, call);
    const terminal = {
      workspaceId: f.workspaceId,
      captureId: f.captureId,
      state: 'abandoned' as const,
    };
    await expect(client.recoveryCapture(call.binding.command.database, terminal)).rejects.toThrow();
    expect(inspectCapture(f.db, f.workspaceId, f.captureId)).toEqual(f.selected);
    await client.recoveryCapture(call.binding.command.database, terminal, call);
    expect(inspectCapture(f.db, f.workspaceId, f.captureId)?.state).toBe('abandoned');
    expect(f.gate.enter(f.workspaceId)).toBeNull();
    expect(f.gate.enterLatePublisher(f.workspaceId, 'worker-turn-closeout')).toBeNull();
    freeze.release();
    expect(f.gate.enter(f.workspaceId)).toBeNull();
    expect(isScopeAdmitted(f.dataRoot, 'workspace', f.workspaceId)).toBe(false);
    // A retained first-terminal result can outlive its ACK; explicit retry keeps the same quarantine.
    const terminalRetry = resume();
    expect(terminalRetry.status).toBe('frozen');
    if (terminalRetry.status !== 'frozen') throw new Error('Expected an exact terminal retry.');
    terminalRetry.release();
    expect(f.gate.enter(f.workspaceId)).toBeNull();
  }, 30_000);

  it('preserves a real source capture exclusion across its Core terminal revision', async () => {
    const root = mkdtempSync(join(tmpdir(), 'source-core-capture-rejoin-'));
    roots.push(root);
    const dataRoot = join(root, 'source');
    await createDemoStore({ dataRoot });
    const core = createTestCoreDb(dataRoot);
    handles.push(core);
    const workspaceId = DEMO_WORKSPACE_ID;
    recordWorkspaceOwnerMembership({
      coreDb: core,
      workspaceId,
      ownerUserId: ensureLocalUser(core),
    });
    await shutdownControlStoreWorkerClient();
    const stagingParent = join(root, 'staging');
    mkdirSync(stagingParent);
    const captureId = allocateEntityId('wsbak');
    const captured = await createWorkspaceBackup({
      ...WORKSPACE_BACKUP_POLICY,
      source: { kind: 'stopped-data-root', dataRoot },
      workspaceId,
      backupId: captureId,
      purpose: 'move',
      expectedSourceDeploymentId: readDataRootLayoutMarker(dataRoot).deploymentId,
      expectedRelease: { version: '0.1.0-source-rejoin', buildId: 'source-rejoin-oracle' },
      bundleRoot: join(root, 'move-bundle'),
      stagingParent,
      admission: new FileStorageAdmission(root, () => 0n),
    });
    expect(captured.disposition).toBe('prepared');
    const prepared = recovery.readRecoveryAdmission(core, captureId);
    expect(prepared?.state).toBe('prepared');
    const db = openWorkspaceDb(dataRoot, workspaceId);
    handles.push(db);
    const gate = new WorkspaceMutationAdmission();
    restoreWorkspaceRecoveryAdmission(core, gate);
    const resume = () =>
      recovery.resumeWorkspaceCaptureOwner(core, workspaceId, captureId, gate, () => []);
    const first = resume();
    if (first.status !== 'frozen') throw new Error('Expected the prepared source capture owner.');
    completeCapture(db, workspaceId, captureId);
    recovery.endRecoveryAdmission(core, captureId, 'finished');
    expect(recovery.readRecoveryAdmission(core, captureId)?.revision).toBe(prepared!.revision + 1);
    expect(() =>
      recovery.bindWorkspaceCaptureNativeOwner(core, workspaceId, captureId, gate, first)
    ).not.toThrow();
    first.release();
    const terminal = resume();
    expect(terminal.status).toBe('frozen');
    if (terminal.status !== 'frozen')
      throw new Error('Expected the same source capture exclusion.');
    expect(gate.enter(workspaceId)).toBeNull();
    expect(gate.enterLatePublisher(workspaceId, 'worker-turn-closeout')).toBeNull();
    terminal.release();
    expect(gate.enter(workspaceId)).toBeNull();
    expect(isScopeAdmitted(dataRoot, 'workspace', workspaceId)).toBe(false);
  }, 30_000);

  it('refuses ambiguous active captures without inspecting blockers or weakening protection', () => {
    const f = fixture(true);
    const inspect = vi.fn(() => []);
    for (const captureId of [f.captureId, f.competitor!.captureId]) {
      expect(() =>
        recovery.resumeWorkspaceCaptureOwner(f.core, f.workspaceId, captureId, f.gate, inspect)
      ).toThrow();
    }
    expect(inspect).not.toHaveBeenCalled();
    expect(inspectCapture(f.db, f.workspaceId, f.captureId)).toEqual(f.selected);
    expect(inspectCapture(f.db, f.workspaceId, f.competitor!.captureId)).toEqual(f.competitor);
    expect(f.gate.enter(f.workspaceId)).toBeNull();
    expect(f.gate.enterLatePublisher(f.workspaceId, 'worker-turn-closeout')).toBeNull();
  });
});
