// openkit-test-platform: posix
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { type FileHandle, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Worker } from 'node:worker_threads';
import { allocateEntityId } from '@openkit/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listWorkspaceAuditEvents } from '../audit-events.js';
import { isScopeAdmitted } from '../bootstrap/readiness.js';
import { restoreWorkspaceRecoveryAdmission } from '../bootstrap/workspace-recovery.js';
import { createDemoStore, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import {
  type WorkspaceFrozenAdmission,
  WorkspaceMutationAdmission,
} from '../workspace-mutation-admission.js';
import { FileStorageAdmission } from './artifacts/file-admission.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './control-store-worker-client.js';
import { type CoreDb, openCoreDb, openWorkspaceDb, type WorkspaceDb } from './db.js';
import { readDataRootLayoutMarker } from './fs-layout.js';
import {
  createWorkspaceBackup,
  readWorkspaceBackupManifest,
  readWorkspaceRecoveryBlockers,
  WORKSPACE_BACKUP_POLICY,
} from './workspace-backup.js';
import { parseWorkspaceBackupSeal } from './workspace-backup-bundle.js';
import { inspectCapture, protectCapture } from './workspace-capture-protection.js';
import { abandonWorkspaceCaptureAtCore, finishWorkspaceCaptureAtCore } from './workspace-move.js';
import {
  readRecoveryAdmission,
  resumeWorkspaceCaptureOwner,
} from './workspace-recovery-admissions.js';

const roots: string[] = [];
const handles: (CoreDb | WorkspaceDb)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await shutdownControlStoreWorkerClient();
  for (const db of handles.splice(0)) if (db.sqlite.open) db.sqlite.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Produces source authority through real capture, or its original SQL-only crash pin owner. */
async function fixture(sqlOnly = false, sealedBackup = false) {
  const root = mkdtempSync(join(tmpdir(), 'source-finalization-'));
  roots.push(root);
  const dataRoot = join(root, 'source');
  const store = await createDemoStore({ dataRoot });
  const coreDb = openCoreDb(dataRoot);
  handles.push(coreDb);
  const workspaceId = DEMO_WORKSPACE_ID;
  recordWorkspaceOwnerMembership({ coreDb, workspaceId, ownerUserId: ensureLocalUser(coreDb) });
  const sourceFile = join(dataRoot, 'workspaces', workspaceId, 'files', 'retained-source.txt');
  mkdirSync(join(sourceFile, '..'), { recursive: true });
  writeFileSync(sourceFile, 'Retain these source bytes across recovery.');
  const sourceBytes = readFileSync(sourceFile);
  const mutationAdmission = new WorkspaceMutationAdmission();
  const source = { kind: 'live-workspace' as const, dataRoot, coreDb, store, mutationAdmission };
  const stagingParent = join(root, 'staging');
  mkdirSync(stagingParent);
  const verification = {
    ...WORKSPACE_BACKUP_POLICY,
    stagingParent,
    admission: new FileStorageAdmission(root, () => 0n),
    expectedRelease: {
      version: '0.1.0-source-finalization',
      buildId: 'source-finalization-oracle',
    },
  };
  const backupId = allocateEntityId('wsbak');
  const bundleRoot = join(dataRoot, 'server/backups/workspaces', workspaceId, backupId);
  const db = openWorkspaceDb(dataRoot, workspaceId);
  handles.push(db);
  if (sqlOnly) {
    await shutdownControlStoreWorkerClient();
    protectCapture(db, workspaceId, backupId);
    restoreWorkspaceRecoveryAdmission(coreDb, mutationAdmission);
  } else {
    const captureInput = {
      ...verification,
      source,
      workspaceId,
      backupId,
      bundleRoot,
      purpose: sealedBackup ? ('backup' as const) : ('move' as const),
      expectedSourceDeploymentId: readDataRootLayoutMarker(dataRoot).deploymentId,
    };
    if (sealedBackup) {
      await interruptBackupBeforeSqlFinish(captureInput);
      await shutdownControlStoreWorkerClient();
      restoreWorkspaceRecoveryAdmission(coreDb, mutationAdmission);
    } else {
      const captured = await createWorkspaceBackup(captureInput);
      expect(captured.disposition).toBe('prepared');
    }
  }
  const freeze = resumeWorkspaceCaptureOwner(coreDb, workspaceId, backupId, mutationAdmission, () =>
    readWorkspaceRecoveryBlockers(
      { ...source, workspaceId, operation: 'move-out' },
      { captureId: backupId }
    )
  );
  if (freeze.status !== 'frozen') throw new Error('Expected the exact retained source freeze.');
  // Source Seal step 3 concerns the raw lifecycle extension, which a parsed Store view can omit.
  const state = () => {
    const row = db.sqlite
      .prepare('SELECT revision, record_json FROM control_workspaces WHERE id=?')
      .get(workspaceId) as { revision: number; record_json: string };
    return {
      revision: row.revision,
      record: JSON.parse(row.record_json) as {
        movedOut?: { backupId: string; manifestDigest: string };
      },
      pin: inspectCapture(db, workspaceId, backupId),
      core: readRecoveryAdmission(coreDb, backupId),
      audit: listWorkspaceAuditEvents(db, workspaceId).filter(
        (event) => event.action === 'workspace.move-out'
      ),
    };
  };
  const marker = join(bundleRoot, 'seal.json');
  const owned = { ...source, currentAuthority: () => {}, verification };
  const input = { dataRoot, workspaceId, selection: { kind: 'capture' as const, backupId } };
  return {
    dataRoot,
    workspaceId,
    backupId,
    bundleRoot,
    sourceFile,
    sourceBytes,
    mutationAdmission,
    freeze,
    state,
    marker,
    owned,
    input,
  };
}

/** Loses the actual capture Worker after its durable backup seal, before its SQL finish request. */
async function interruptBackupBeforeSqlFinish(input: Parameters<typeof createWorkspaceBackup>[0]) {
  let worker: Worker | undefined;
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const emit = Worker.prototype.emit;
  const hold = vi.spyOn(Worker.prototype, 'emit').mockImplementation(function (
    this: Worker,
    event: string | symbol,
    ...args: unknown[]
  ) {
    const message = args[0];
    if (
      event === 'message' &&
      message !== null &&
      typeof message === 'object' &&
      'phase' in message &&
      message.phase === 'finish'
    ) {
      worker = this;
      enter();
      return true;
    }
    return emit.call(this, event, ...args);
  });
  const capturing = createWorkspaceBackup(input).then(
    (result) => ({ result }),
    (error: unknown) => ({ error })
  );
  try {
    await Promise.race([
      entered,
      capturing.then(() => {
        throw new Error('Capture did not reach its actual Worker finish boundary.');
      }),
    ]);
    expect(existsSync(join(input.bundleRoot, 'seal.json'))).toBe(true);
    await worker!.terminate();
    expect(await capturing).toMatchObject({ error: expect.any(Error) });
  } finally {
    hold.mockRestore();
    if (worker && worker.threadId !== -1) await worker.terminate();
    await capturing;
  }
}

/** Source Seal steps 3-4 require native commit, durable marker, then terminal capture publication. */
describe('exact live source capture finalization', () => {
  it('proves absent seal retirement durable on fresh boot before admitting an abandoned backup', async () => {
    const f = await fixture(false, true);
    const parent = lstatSync(f.bundleRoot);
    const handle = await open(f.bundleRoot, 'r');
    const prototype = Object.getPrototypeOf(handle) as FileHandle;
    const sync = prototype.sync;
    await handle.close();
    const syncFault = vi.spyOn(prototype, 'sync').mockImplementation(async function (
      this: FileHandle
    ) {
      const current = await this.stat();
      if (current.dev === parent.dev && current.ino === parent.ino) {
        expect(existsSync(f.marker)).toBe(false);
        throw new Error('Injected post-unlink parent synchronization failure.');
      }
      return sync.call(this);
    });
    try {
      await expect(abandonWorkspaceCaptureAtCore(f.owned, f.input, f.freeze)).rejects.toThrow();
      expect(f.state().pin?.state).toBe('abandoned');
      expect(f.state().core).toBeUndefined();
      expect(existsSync(f.marker)).toBe(false);
    } finally {
      syncFault.mockRestore();
      f.freeze.release();
      await shutdownControlStoreWorkerClient();
    }
    // A real new process cannot inherit the producer's in-memory recovery refusal.
    const boot = async (failSync: boolean) => {
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [
          '--import',
          'tsx',
          '--input-type=module',
          '-e',
          `
        import fs from 'node:fs';
        import { syncBuiltinESMExports } from 'node:module';
        const parent = fs.lstatSync(${JSON.stringify(f.bundleRoot)});
        const fsync = fs.fsyncSync;
        let syncAttempted = false, syncSucceeded = false;
        fs.fsyncSync = function(fd) {
          const current = fs.fstatSync(fd);
          const selected = current.dev === parent.dev && current.ino === parent.ino;
          if (selected) {
            syncAttempted = true;
            if (${JSON.stringify(failSync)}) throw new Error('Injected boot parent synchronization failure.');
          }
          fsync(fd);
          if (selected) syncSucceeded = true;
        };
        syncBuiltinESMExports();
        const { acquireDataRootLock } = await import(${JSON.stringify(new URL('../bootstrap/lock.ts', import.meta.url).href)});
        const { openCoreDb } = await import(${JSON.stringify(new URL('./db.ts', import.meta.url).href)});
        const { WorkspaceMutationAdmission } = await import(${JSON.stringify(new URL('../workspace-mutation-admission.ts', import.meta.url).href)});
        const { restoreWorkspaceRecoveryAdmission } = await import(${JSON.stringify(new URL('../bootstrap/workspace-recovery.ts', import.meta.url).href)});
        const { isScopeAdmitted, scopeAdmissionFailures } = await import(${JSON.stringify(new URL('../bootstrap/readiness.ts', import.meta.url).href)});
        const root = ${JSON.stringify(f.dataRoot)}, workspaceId = ${JSON.stringify(f.workspaceId)};
        const lock = acquireDataRootLock(root, { bootId: 'source-retirement-census' });
        const core = openCoreDb(root), gate = new WorkspaceMutationAdmission();
        try {
          restoreWorkspaceRecoveryAdmission(core, gate);
          const admitted = isScopeAdmitted(root, 'workspace', workspaceId);
          let rejoin = null, censusRead = false, scopeRefusedAfterRejoin = null;
          if (${JSON.stringify(failSync)}) {
            const { FsStore } = await import(${JSON.stringify(new URL('../lib/store.ts', import.meta.url).href)});
            const { readWorkspaceRecoveryBlockers } = await import(${JSON.stringify(new URL('./workspace-backup.ts', import.meta.url).href)});
            const { resumeWorkspaceCaptureOwner } = await import(${JSON.stringify(new URL('./workspace-recovery-admissions.ts', import.meta.url).href)});
            const store = new FsStore({ dataRoot: root });
            store.setWorkspaceMutationAdmission(gate);
            const selected = { captureId: ${JSON.stringify(f.backupId)} };
            const resumed = resumeWorkspaceCaptureOwner(core, workspaceId, selected.captureId, gate, () => {
              censusRead = true;
              return readWorkspaceRecoveryBlockers({ coreDb: core, store, workspaceId }, selected);
            });
            rejoin = resumed.status;
            scopeRefusedAfterRejoin = !isScopeAdmitted(root, 'workspace', workspaceId);
            if (resumed.status === 'frozen') resumed.release();
          }
          const release = gate.enter(workspaceId);
          process.stdout.write(JSON.stringify({ syncAttempted, syncSucceeded, admitted,
            gateOpen: !!release, check: scopeAdmissionFailures(root).find(row => row.id === workspaceId)?.check ?? null,
            rejoin, censusRead, scopeRefusedAfterRejoin }));
          release?.();
        } finally { core.sqlite.close(); lock.release(); }
        `,
        ],
        {
          cwd: fileURLToPath(new URL('../../', import.meta.url)),
          env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, TMPDIR: tmpdir() },
          timeout: 15_000,
          maxBuffer: 16_384,
        }
      ).catch((cause: unknown) => {
        const stderr = (cause as { stderr?: string | Buffer }).stderr;
        throw new Error(`Fresh boot census child failed: ${String(stderr ?? '').slice(0, 4096)}`, {
          cause,
        });
      });
      return JSON.parse(stdout);
    };
    expect(await boot(true)).toMatchObject({
      syncAttempted: true,
      syncSucceeded: false,
      admitted: false,
      gateOpen: false,
      check: 'recovery',
      rejoin: 'frozen',
      censusRead: true,
      scopeRefusedAfterRejoin: true,
    });
    expect(await boot(false)).toMatchObject({
      syncAttempted: true,
      syncSucceeded: true,
      admitted: true,
      gateOpen: true,
      check: null,
    });
    expect(readFileSync(f.sourceFile)).toEqual(f.sourceBytes);
  }, 60_000);

  it('keeps an abandoned sealed backup quarantined across boot until exact seal retirement succeeds', async () => {
    const f = await fixture(false, true);
    expect(f.state().pin?.state).toBe('active');
    expect(f.state().core).toBeUndefined();
    const manifestPath = join(f.bundleRoot, 'manifest.json');
    const manifest = readWorkspaceBackupManifest(f.bundleRoot);
    expect(parseWorkspaceBackupSeal(JSON.parse(readFileSync(f.marker, 'utf8')))).toMatchObject({
      purpose: 'backup',
      backupId: f.backupId,
      manifestDigest: `sha256:${createHash('sha256').update(readFileSync(manifestPath)).digest('hex')}`,
    });
    const preserved = [
      f.sourceFile,
      manifestPath,
      ...manifest.inventory.map((entry) =>
        join(
          f.dataRoot,
          'server/backups/workspaces',
          f.workspaceId,
          'objects',
          entry.sha256.slice(7)
        )
      ),
    ].map((path) => [path, readFileSync(path)] as const);
    const mode = lstatSync(f.bundleRoot).mode & 0o777;
    let retry: WorkspaceFrozenAdmission | undefined;
    try {
      chmodSync(f.bundleRoot, mode & ~0o222);
      await expect(abandonWorkspaceCaptureAtCore(f.owned, f.input, f.freeze)).rejects.toThrow();
      expect(f.state().pin?.state).toBe('abandoned');
      expect(existsSync(f.marker)).toBe(true);
      f.freeze.release();
      await shutdownControlStoreWorkerClient();
      const gate = new WorkspaceMutationAdmission();
      restoreWorkspaceRecoveryAdmission(f.owned.coreDb, gate);
      expect(isScopeAdmitted(f.dataRoot, 'workspace', f.workspaceId)).toBe(false);
      expect(gate.enter(f.workspaceId)).toBeNull();
      expect(gate.enterLatePublisher(f.workspaceId, 'worker-turn-closeout')).toBeNull();
      const resumed = resumeWorkspaceCaptureOwner(
        f.owned.coreDb,
        f.workspaceId,
        f.backupId,
        gate,
        () =>
          readWorkspaceRecoveryBlockers(
            { ...f.owned, workspaceId: f.workspaceId },
            { captureId: f.backupId }
          )
      );
      expect(resumed.status).toBe('frozen');
      if (resumed.status !== 'frozen') throw new Error('Expected exact pending seal retirement.');
      retry = resumed;
      chmodSync(f.bundleRoot, mode);
      await expect(
        abandonWorkspaceCaptureAtCore({ ...f.owned, mutationAdmission: gate }, f.input, retry)
      ).resolves.toMatchObject({
        command: 'abandon',
        disposition: 'abandoned',
        selection: f.input.selection,
      });
      expect(existsSync(f.marker)).toBe(false);
      expect(f.state().pin?.state).toBe('abandoned');
      expect(f.state().core).toBeUndefined();
      for (const [path, bytes] of preserved) expect(readFileSync(path)).toEqual(bytes);
    } finally {
      chmodSync(f.bundleRoot, mode);
      retry?.release();
      f.freeze.release();
    }
  }, 30_000);

  it('finishes a real MOVE only after its native moved-out ACK and durable matching marker', async () => {
    const f = await fixture();
    const before = f.state();
    const digest = `sha256:${createHash('sha256')
      .update(readFileSync(join(f.bundleRoot, 'manifest.json')))
      .digest('hex')}`;
    const client = getControlStoreWorkerClient(f.mutationAdmission);
    const moveOut = client.recoveryMoveOut.bind(client);
    const terminal = client.recoveryCapture.bind(client);
    let sourceAcknowledged = false;
    let terminalAcknowledged = false;
    vi.spyOn(client, 'recoveryMoveOut').mockImplementation(async (...args) => {
      expect(existsSync(f.marker)).toBe(false);
      await moveOut(...args);
      const committed = f.state();
      expect(committed.record.movedOut).toEqual({ backupId: f.backupId, manifestDigest: digest });
      expect(committed.revision).toBe(before.revision + 1);
      expect(committed.audit).toHaveLength(before.audit.length + 1);
      expect(committed.pin?.state).toBe('active');
      expect(committed.core?.state).toBe('prepared');
      expect(existsSync(f.marker)).toBe(false);
      sourceAcknowledged = true;
    });
    vi.spyOn(client, 'recoveryCapture').mockImplementation(async (...args) => {
      expect(sourceAcknowledged).toBe(true);
      expect(parseWorkspaceBackupSeal(JSON.parse(readFileSync(f.marker, 'utf8')))).toEqual({
        format: 'openkit-workspace-backup-seal',
        version: 1,
        purpose: 'move',
        backupId: f.backupId,
        manifestDigest: digest,
      });
      expect(f.state().pin?.state).toBe('active');
      await terminal(...args);
      expect(f.state().pin?.state).toBe('finished');
      expect(f.state().core?.state).toBe('prepared');
      terminalAcknowledged = true;
    });
    try {
      await expect(finishWorkspaceCaptureAtCore(f.owned, f.input, f.freeze)).resolves.toMatchObject(
        {
          command: 'finish',
          disposition: 'moved-out',
          workspaceId: f.workspaceId,
          currentRevision: before.revision + 1,
          capture: { backupId: f.backupId, manifestDigest: digest },
        }
      );
      expect(terminalAcknowledged).toBe(true);
      expect(f.state().core?.state).toBe('finished');
      await expect(abandonWorkspaceCaptureAtCore(f.owned, f.input, f.freeze)).rejects.toThrow();
      expect(readFileSync(f.sourceFile)).toEqual(f.sourceBytes);
      expect(f.mutationAdmission.enter(f.workspaceId)).toBeNull();
    } finally {
      f.freeze.release();
    }
  }, 30_000);

  it('refuses SQL-only finish and durably abandons its exact pin without retiring source bytes', async () => {
    const f = await fixture(true);
    const before = f.state();
    expect(before.core).toBeUndefined();
    expect(existsSync(join(f.bundleRoot, 'manifest.json'))).toBe(false);
    try {
      await expect(finishWorkspaceCaptureAtCore(f.owned, f.input, f.freeze)).rejects.toThrow();
      expect(f.state()).toEqual(before);
      await expect(
        abandonWorkspaceCaptureAtCore(f.owned, f.input, f.freeze)
      ).resolves.toMatchObject({
        command: 'abandon',
        disposition: 'abandoned',
        workspaceId: f.workspaceId,
        selection: f.input.selection,
      });
      const abandoned = f.state();
      expect(abandoned.pin?.state).toBe('abandoned');
      expect(abandoned.record).toEqual(before.record);
      expect(abandoned.revision).toBe(before.revision);
      expect(abandoned.core).toBeUndefined();
      await expect(finishWorkspaceCaptureAtCore(f.owned, f.input, f.freeze)).rejects.toThrow();
      expect(f.state()).toEqual(abandoned);
      expect(readFileSync(f.sourceFile)).toEqual(f.sourceBytes);
      expect(existsSync(f.marker)).toBe(false);
    } finally {
      f.freeze.release();
    }
  }, 30_000);

  it('retains active protection after real marker publication failure and retries without another move Audit', async () => {
    const f = await fixture();
    const before = f.state();
    const mode = lstatSync(f.bundleRoot).mode & 0o777;
    try {
      // The real filesystem refuses only marker publication; staged verification can still read.
      chmodSync(f.bundleRoot, mode & ~0o222);
      try {
        await expect(finishWorkspaceCaptureAtCore(f.owned, f.input, f.freeze)).rejects.toThrow();
      } finally {
        chmodSync(f.bundleRoot, mode);
      }
      const committed = f.state();
      expect(committed.record.movedOut).toEqual({
        backupId: f.backupId,
        manifestDigest: before.core!.proof.capture.manifestDigest,
      });
      expect(committed.revision).toBe(before.revision + 1);
      expect(committed.audit).toHaveLength(before.audit.length + 1);
      expect(committed.pin?.state).toBe('active');
      expect(committed.core?.state).toBe('prepared');
      expect(existsSync(f.marker)).toBe(false);
      expect(isScopeAdmitted(f.dataRoot, 'workspace', f.workspaceId)).toBe(false);
      expect(f.mutationAdmission.enter(f.workspaceId)).toBeNull();
      expect(
        f.mutationAdmission.enterLatePublisher(f.workspaceId, 'worker-turn-closeout')
      ).toBeNull();
      await expect(finishWorkspaceCaptureAtCore(f.owned, f.input, f.freeze)).resolves.toMatchObject(
        {
          command: 'finish',
          disposition: 'moved-out',
          currentRevision: committed.revision,
        }
      );
      const finished = f.state();
      expect(finished.pin?.state).toBe('finished');
      expect(finished.core?.state).toBe('finished');
      expect(finished.audit).toEqual(committed.audit);
      expect(
        parseWorkspaceBackupSeal(JSON.parse(readFileSync(f.marker, 'utf8'))).manifestDigest
      ).toBe(committed.record.movedOut!.manifestDigest);
      await expect(abandonWorkspaceCaptureAtCore(f.owned, f.input, f.freeze)).rejects.toThrow();
    } finally {
      f.freeze.release();
    }
  }, 30_000);
});
