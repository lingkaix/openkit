// openkit-test-platform: posix
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { type Worker as NativeWorker, Worker } from 'node:worker_threads';
import { allocateEntityId } from '@openkit/protocol';
import { publishDurableFile, removeDurableFile } from '@openkit/storage';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createOpenKitAccessTokenRecord,
  revokeOpenKitAccessTokenRecord,
} from '../auth/access-token-store.js';
import { requireAdministratorOperation } from '../auth/operation-authorizer.js';
import { acquireDataRootLock } from '../bootstrap/lock.js';
import { createDemoStore, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import { FileStorageAdmission } from './artifacts/file-admission.js';
import { commandInputHash } from './control-store-input.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './control-store-worker-client.js';
import { CONTROL_WORKER_LIMITS, controlWorkerInputBytes } from './control-store-worker-protocol.js';
import { inventoryRegularFiles } from './data-root-backup.js';
import { openCoreDb } from './db.js';
import { coreDbPath, readDataRootLayoutMarker, workspaceDbPath } from './fs-layout.js';
import { createWorkspaceBackup, WORKSPACE_BACKUP_POLICY } from './workspace-backup.js';
import { nativeProductScope } from './workspace-file-records.js';
import { inspectWorkspaceRecoveryAtCore } from './workspace-move.js';
import {
  bindWorkspaceRecoveryNativeOwner,
  endRecoveryAdmission,
  readRecoveryAdmission,
} from './workspace-recovery-admissions.js';
import {
  abandonWorkspaceRecoveryAtCore,
  admitWorkspaceBackupAtCore,
  finishWorkspaceRecoveryAtCore,
} from './workspace-restore.js';

const interception = vi.hoisted(() => ({
  selected: undefined as
    | {
        corePath: string;
        admissionId: string;
        workspaceId: string;
        kind: 'prepare' | 'proof';
        gate: SharedArrayBuffer;
      }
    | undefined,
  worker: undefined as NativeWorker | undefined,
  replied: false,
}));

const physical = vi.hoisted(() => ({ completedDirectorySyncs: [] as string[] }));

// Observe the existing physical owner's completed acknowledgement; every sync is real.
vi.mock('@openkit/storage', async (load) => {
  const actual = await load<typeof import('@openkit/storage')>();
  return {
    ...actual,
    syncCanonicalDirectory(path: string) {
      actual.syncCanonicalDirectory(path);
      physical.completedDirectorySyncs.push(path);
    },
  };
});

// Reuse the actual Worker/SQLite COMMIT method from the frozen Target tests.
// No substitute entry, SQL success or production callback supplies this observation.
vi.mock('node:worker_threads', async (load) => {
  const actual = await load<typeof import('node:worker_threads')>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(filename: string | URL, options?: import('node:worker_threads').WorkerOptions) {
        const selected = interception.selected;
        if (!selected) {
          super(filename, options);
          return;
        }
        const prelude = `
        const { workerData } = require('node:worker_threads');
        const Database = require(workerData.databaseModule);
        const execute = Database.prototype.exec;
        const gate = workerData.gate;
        Database.prototype.exec = function(sql) {
          const result = execute.call(this, sql);
          if (/^COMMIT$/i.test(sql) && this.name === workerData.corePath &&
              Atomics.load(gate, 2) && Atomics.load(gate, 0) === 0) {
            const admission = this.prepare(
              'SELECT state,revision,workspace_id,proof_json FROM workspace_recovery_admissions WHERE admission_id=?'
            ).get(workerData.admissionId);
            const proof = admission && JSON.parse(admission.proof_json);
            const complete = admission?.state === 'prepared' && admission.revision === 1 &&
              admission.workspace_id === workerData.workspaceId && proof.input.requestId === workerData.admissionId &&
              proof.result.disposition === 'quarantined' &&
              (workerData.kind === 'prepare' ? proof.candidateDigest === undefined : /^[0-9a-f]{64}$/.test(proof.candidateDigest));
            if (!complete) return result;
            if (this.inTransaction || this.pragma('synchronous', { simple: true }) !== 2)
              throw new Error('The selected preparation COMMIT did not contain its original whole tuple.');
            Atomics.store(gate, 3, 2);
            Atomics.store(gate, 0, 1);
            Atomics.wait(gate, 1, 0);
          }
          return result;
        };
      `;
        const entry = options?.eval
          ? String(filename)
          : `import(${JSON.stringify(String(filename))});`;
        const require = createRequire(import.meta.url);
        super(prelude + entry, {
          ...options,
          eval: true,
          workerData: {
            ...options?.workerData,
            ...selected,
            gate: new Int32Array(selected.gate),
            databaseModule: require.resolve('better-sqlite3'),
          },
        });
        const post = this.postMessage.bind(this);
        this.postMessage = (message, ...args) => {
          if (
            message.operation === 'recovery-target-preparation' &&
            message.database === `core:${selected.corePath}` &&
            message.input?.admissionId === selected.admissionId &&
            message.input?.workspaceId === selected.workspaceId &&
            message.input?.kind === selected.kind
          ) {
            if (interception.worker) throw new Error('Duplicate selected preparation post.');
            interception.worker = this;
            Atomics.store(new Int32Array(selected.gate), 2, 1);
            this.on('message', (reply) => {
              if (reply.id === message.id) interception.replied = true;
            });
          }
          return post(message, ...args);
        };
      }
    },
  };
});

const roots: string[] = [];
const owners: (() => void)[] = [];
afterEach(async () => {
  if (interception.selected) {
    const gate = new Int32Array(interception.selected.gate);
    Atomics.store(gate, 1, 1);
    Atomics.notify(gate, 1);
  }
  vi.restoreAllMocks();
  await shutdownControlStoreWorkerClient();
  interception.selected = undefined;
  interception.worker = undefined;
  interception.replied = false;
  physical.completedDirectorySyncs.length = 0;
  for (const close of owners.splice(0).reverse()) close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Reads committed truth independently; setup never assembles an admission or proof. */
function rows(path: string, table: string) {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all();
  } finally {
    db.close();
  }
}

/** Selected resolution always uses the original request and the actual owner's Workspace. */
function selection(f: Awaited<ReturnType<typeof fixture>>) {
  return {
    dataRoot: f.dataRoot,
    workspaceId: f.input.workspaceId,
    selection: { kind: 'admission' as const, requestId: f.input.requestId },
  };
}

/** Compares closed physical states through the original current native recovery binding. */
async function closeCanonicalAtBoundary(
  f: Awaited<ReturnType<typeof fixture>>,
  owned: NonNullable<ReturnType<typeof readRecoveryAdmission>>,
  currentAuthority = f.owner.currentAuthority
) {
  currentAuthority();
  const binding = bindWorkspaceRecoveryNativeOwner(
    f.owner.core,
    owned,
    f.owner.native.gate,
    f.owner.native.freeze
  ).canonical;
  if (!binding) throw new Error('The existing canonical recovery owner is required.');
  const client = getControlStoreWorkerClient(f.owner.native.gate);
  await client.open(binding.binding.command, binding);
  currentAuthority();
  await client.close(binding.binding.command.database, binding);
  currentAuthority();
  expect(f.owner.native.gate.ownsFreeze(f.input.workspaceId, f.owner.native.freeze)).toBe(true);
}

/** A real candidate failure leaves the original prepared row without inventing recovery state. */
async function partialPreparation(f: Awaited<ReturnType<typeof fixture>>) {
  const client = getControlStoreWorkerClient(f.owner.native.gate);
  const stopped = new Error('Interrupt actual private candidate preparation.');
  const cleanup = vi.spyOn(client, 'recoveryCleanup').mockRejectedValueOnce(stopped);
  try {
    await expect(admitWorkspaceBackupAtCore(f.owner, f.input)).rejects.toBe(stopped);
    expect(cleanup).toHaveBeenCalledTimes(1);
  } finally {
    cleanup.mockRestore();
  }
  const owned = readRecoveryAdmission(f.owner.core, f.input.requestId)!;
  expect(owned).toMatchObject({ state: 'prepared', revision: 1 });
  expect(owned.proof.candidateDigest).toBeUndefined();
  // Candidate safety used a readonly canonical source. Its WAL/SHM lifetime is
  // settled by the same real close that selected abandonment already requires.
  await closeCanonicalAtBoundary(f, owned);
  return owned;
}

/** Captures a genuine sealed bundle before entering the real fresh target lifecycle. */
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'target-preparation-'));
  roots.push(root);
  const dataRoot = join(root, 'source');
  const store = await createDemoStore({ dataRoot });
  const core = openCoreDb(dataRoot);
  const userId = ensureLocalUser(core);
  recordWorkspaceOwnerMembership({
    coreDb: core,
    workspaceId: DEMO_WORKSPACE_ID,
    ownerUserId: userId,
  });
  core.sqlite.close();
  await shutdownControlStoreWorkerClient();
  const stagingParent = join(root, 'capture-staging');
  mkdirSync(stagingParent);
  const bundleRoot = join(root, 'bundle');
  const fileAdmission = new FileStorageAdmission(root, () => 0n);
  const capture = await createWorkspaceBackup({
    ...WORKSPACE_BACKUP_POLICY,
    source: { kind: 'stopped-data-root', dataRoot },
    workspaceId: DEMO_WORKSPACE_ID,
    expectedSourceDeploymentId: readDataRootLayoutMarker(dataRoot).deploymentId,
    backupId: allocateEntityId('wsbak'),
    purpose: 'backup',
    bundleRoot,
    stagingParent,
    admission: fileAdmission,
    expectedRelease: { version: 'target-preparation-test', buildId: 'original-owner-fixture' },
  });
  expect(capture.disposition).toBe('sealed');
  await shutdownControlStoreWorkerClient();
  const selectedCore = openCoreDb(dataRoot);
  const lock = acquireDataRootLock(dataRoot, { bootId: randomUUID() });
  const gate = new WorkspaceMutationAdmission();
  const freeze = gate.tryFreeze(DEMO_WORKSPACE_ID, () => []);
  if (freeze.status !== 'frozen') throw new Error('The actual target freeze was not acquired.');
  owners.push(() => {
    selectedCore.sqlite.close();
    freeze.release();
    lock.release();
  });
  store.setWorkspaceMutationAdmission(gate);
  const actor = { kind: 'local' as const, userId };
  const owner = {
    core: selectedCore,
    fileAdmission,
    actor,
    native: { gate, freeze },
    currentAuthority: () => requireAdministratorOperation(selectedCore, actor, 'api.call'),
  };
  const input = {
    command: 'restore' as const,
    dataRoot,
    bundleRoot,
    workspaceId: DEMO_WORKSPACE_ID,
    requestId: randomUUID(),
    acknowledgeLostSafety: false,
    expectedRelease: capture.manifest.release,
  };
  return { root, dataRoot, owner, input, capture, store };
}

describe('Target admission original preparation boundaries', () => {
  it('prepares and publishes the complete candidate proof through native Core with query-only Main', async () => {
    const f = await fixture();
    const source = readFileSync(workspaceDbPath(f.dataRoot, f.input.workspaceId));
    const registry = rows(coreDbPath(f.dataRoot), 'workspace_registry');
    const stopped = new Error(
      'Observe the original placement boundary without replacing the target.'
    );
    let placementReached = false;
    f.owner.core.sqlite.pragma('query_only = ON');
    const failure: unknown = await admitWorkspaceBackupAtCore(f.owner, f.input, {
      atBoundary(point) {
        if (point !== 'before-target-rename') return;
        placementReached = true;
        throw stopped;
      },
    }).then(
      () => undefined,
      (error: unknown) => error
    );
    // Preserve an unexpected producer exception and its actual owner stack.
    if (failure !== stopped) throw failure ?? new Error('Preparation returned before observation.');
    expect(placementReached).toBe(true);
    const admission = readRecoveryAdmission(f.owner.core, f.input.requestId)!;
    expect(admission).toMatchObject({ state: 'prepared', revision: 1 });
    expect(admission.proof.input).toEqual(f.input);
    expect(admission.proof.manifest).toEqual(f.capture.manifest);
    expect(admission.proof.capture).toMatchObject({
      backupId: f.capture.report.backupId,
      manifestDigest: f.capture.report.manifestDigest,
    });
    expect(admission.proof.result).toMatchObject({
      command: 'restore',
      disposition: 'quarantined',
      restrictedRecovery: false,
    });
    expect(admission.proof.result.capture).toEqual(admission.proof.capture);
    expect(admission.proof.candidateDigest).toBe(
      createHash('sha256')
        .update(JSON.stringify(inventoryRegularFiles(admission.candidate_ref)))
        .digest('hex')
    );
    expect(readFileSync(workspaceDbPath(f.dataRoot, f.input.workspaceId))).toEqual(source);
    expect(rows(coreDbPath(f.dataRoot), 'workspace_registry')).toEqual(registry);
    expect(existsSync(admission.candidate_ref)).toBe(true);
    expect(f.owner.native.gate.ownsFreeze(f.input.workspaceId, f.owner.native.freeze)).toBe(true);
  }, 120_000);

  it('joins the actual unsealed native writer before either partial-abandon Core effect', async () => {
    const f = await fixture();
    const owned = await partialPreparation(f);
    const binding = bindWorkspaceRecoveryNativeOwner(
      f.owner.core,
      owned,
      f.owner.native.gate,
      f.owner.native.freeze
    );
    const client = getControlStoreWorkerClient(f.owner.native.gate);
    await client.open(binding.candidate.binding.command, binding.candidate);
    const candidate = inventoryRegularFiles(owned.candidate_ref);
    const closeFailure = new Error('The actual candidate close is unavailable.');
    const actualClose = client.close.bind(client);
    const closing = vi
      .spyOn(client, 'close')
      .mockImplementation((...args) =>
        args[0] === binding.candidate.binding.command.database
          ? Promise.reject(closeFailure)
          : actualClose(...args)
      );
    const stages = vi.spyOn(client, 'recoveryTargetPreparation');
    f.owner.core.sqlite.pragma('query_only = ON');
    try {
      await expect(abandonWorkspaceRecoveryAtCore(f.owner, selection(f))).rejects.toBe(
        closeFailure
      );
      expect(stages).not.toHaveBeenCalled();
      expect(readRecoveryAdmission(f.owner.core, f.input.requestId)).toEqual(owned);
      expect(inventoryRegularFiles(owned.candidate_ref)).toEqual(candidate);
      expect(f.owner.native.gate.ownsFreeze(f.input.workspaceId, f.owner.native.freeze)).toBe(true);
    } finally {
      closing.mockRestore();
      stages.mockRestore();
    }
    await expect(abandonWorkspaceRecoveryAtCore(f.owner, selection(f))).resolves.toMatchObject({
      disposition: 'abandoned',
    });
    expect(existsSync(owned.candidate_ref)).toBe(false);
  }, 120_000);

  it.each(['prepare', 'proof'] as const)(
    'keeps committed %s truth after actual native-host reply loss and resolves only by inspection',
    async (kind) => {
      const f = await fixture();
      const gate = new Int32Array(new SharedArrayBuffer(16));
      interception.selected = {
        corePath: coreDbPath(f.dataRoot),
        admissionId: f.input.requestId,
        workspaceId: f.input.workspaceId,
        kind,
        gate: gate.buffer as SharedArrayBuffer,
      };
      const client = getControlStoreWorkerClient(f.owner.native.gate);
      const actual = client.recoveryTargetPreparation.bind(client);
      let nativeFailure: unknown;
      const publication = vi
        .spyOn(client, 'recoveryTargetPreparation')
        .mockImplementation(async (...args) => {
          if (args[1].kind === 'proof') {
            // Finish this checkpoint before posting: the selected host will be
            // synchronously held after its actual proof COMMIT.
            await closeCanonicalAtBoundary(
              f,
              readRecoveryAdmission(f.owner.core, f.input.requestId)!
            );
            expect(
              inventoryRegularFiles(join(f.dataRoot, 'workspaces', f.input.workspaceId))
            ).toEqual(canonical);
          }
          try {
            return await actual(...args);
          } catch (error) {
            if (args[1].kind === kind) nativeFailure = error;
            throw error;
          }
        });
      const canonical = inventoryRegularFiles(join(f.dataRoot, 'workspaces', f.input.workspaceId));
      f.owner.core.sqlite.pragma('query_only = ON');
      let settled = false;
      const command = admitWorkspaceBackupAtCore(f.owner, f.input).then(
        (result) => {
          settled = true;
          return { result };
        },
        (error: unknown) => {
          settled = true;
          return { error };
        }
      );
      try {
        while (Atomics.load(gate, 0) === 0 && !settled) await nextTurn();
        expect(
          Atomics.load(gate, 0),
          'Actual selected preparation COMMIT gate was not reached.'
        ).toBe(1);
        expect(Atomics.load(gate, 3)).toBe(2);
        expect(settled).toBe(false);
        expect(interception.replied).toBe(false);
        const committed = readRecoveryAdmission(f.owner.core, f.input.requestId)!;
        expect(committed).toMatchObject({ state: 'prepared', revision: 1 });
        if (kind === 'prepare') expect(committed.proof.candidateDigest).toBeUndefined();
        else
          expect(committed.proof.candidateDigest).toBe(
            createHash('sha256')
              .update(JSON.stringify(inventoryRegularFiles(committed.candidate_ref)))
              .digest('hex')
          );
        expect(interception.worker).toBeDefined();
        await interception.worker!.terminate();
        expect(await command).toHaveProperty('error');
        expect(nativeFailure).toMatchObject({ code: 'unavailable', commit: 'unknown' });
        expect(interception.replied).toBe(false);
        expect(readRecoveryAdmission(f.owner.core, f.input.requestId)).toEqual(committed);
        expect(inventoryRegularFiles(join(f.dataRoot, 'workspaces', f.input.workspaceId))).toEqual(
          canonical
        );
        expect(f.owner.native.gate.ownsFreeze(f.input.workspaceId, f.owner.native.freeze)).toBe(
          true
        );
        interception.selected = undefined;
        await shutdownControlStoreWorkerClient();
        expect(inspectWorkspaceRecoveryAtCore(f.owner.core, selection(f))).toMatchObject({
          disposition: 'quarantined',
          nextAction: 'finish',
        });
        if (kind === 'prepare') {
          await expect(finishWorkspaceRecoveryAtCore(f.owner, selection(f))).rejects.toMatchObject({
            code: 'recovery-required',
          });
          expect(readRecoveryAdmission(f.owner.core, f.input.requestId)).toEqual(committed);
          await expect(
            abandonWorkspaceRecoveryAtCore(f.owner, selection(f))
          ).resolves.toMatchObject({
            disposition: 'abandoned',
          });
        } else {
          await expect(finishWorkspaceRecoveryAtCore(f.owner, selection(f))).resolves.toMatchObject(
            {
              disposition: 'restored',
            }
          );
          const terminal = readRecoveryAdmission(f.owner.core, f.input.requestId)!;
          const registry = rows(coreDbPath(f.dataRoot), 'workspace_registry');
          await expect(finishWorkspaceRecoveryAtCore(f.owner, selection(f))).resolves.toMatchObject(
            {
              disposition: 'restored',
            }
          );
          expect(readRecoveryAdmission(f.owner.core, f.input.requestId)).toEqual(terminal);
          expect(rows(coreDbPath(f.dataRoot), 'workspace_registry')).toEqual(registry);
        }
      } finally {
        Atomics.store(gate, 1, 1);
        Atomics.notify(gate, 1);
        await command;
        publication.mockRestore();
      }
    },
    120_000
  );

  it('retains the actual restrictedRecovery fact in the whole proof before placement', async () => {
    const f = await fixture();
    // An absent original Workspace has no canonical binding. A directory with a
    // missing DB is instead an invalid existing envelope and must refuse early.
    rmSync(join(f.dataRoot, 'workspaces', f.input.workspaceId), { recursive: true });
    const before = Date.now();
    const stopped = new Error('Observe restricted proof before replacement.');
    f.owner.core.sqlite.pragma('query_only = ON');
    const error = await admitWorkspaceBackupAtCore(
      f.owner,
      { ...f.input, acknowledgeLostSafety: true },
      {
        atBoundary(point) {
          if (point === 'before-target-rename') throw stopped;
        },
      }
    ).then(
      () => undefined,
      (failure: unknown) => failure
    );
    if (error !== stopped) throw error ?? new Error('Restricted preparation returned early.');
    const owned = readRecoveryAdmission(f.owner.core, f.input.requestId)!;
    expect(owned).toMatchObject({ state: 'prepared', revision: 1 });
    expect(owned.proof.input).toEqual({ ...f.input, acknowledgeLostSafety: true });
    const restricted = owned.proof.result.restrictedRecovery;
    expect(restricted).toMatchObject({
      backupId: f.capture.manifest.backupId,
      captureStartedAt: f.capture.manifest.capture.startedAt,
    });
    if (restricted === false) throw new Error('The original restricted result was lost.');
    expect(Date.parse(restricted.lossDetectedAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(restricted.lossDetectedAt)).toBeLessThanOrEqual(Date.now());
    expect(owned.proof.candidateDigest).toBe(
      createHash('sha256')
        .update(JSON.stringify(inventoryRegularFiles(owned.candidate_ref)))
        .digest('hex')
    );
    expect(existsSync(workspaceDbPath(f.dataRoot, f.input.workspaceId))).toBe(false);
  }, 120_000);

  it('rolls a late prepare INSERT back without replacing canonical bytes or granting finish', async () => {
    const f = await fixture();
    const source = inventoryRegularFiles(join(f.dataRoot, 'workspaces', f.input.workspaceId));
    const registry = rows(coreDbPath(f.dataRoot), 'workspace_registry');
    f.owner.core.sqlite.exec(`CREATE TRIGGER target_prepare_fault AFTER INSERT ON workspace_recovery_admissions
      BEGIN SELECT RAISE(ABORT, 'TARGET_PREPARE_LATE_FAULT'); END`);
    f.owner.core.sqlite.pragma('query_only = ON');
    const client = getControlStoreWorkerClient(f.owner.native.gate);
    const calls = vi.spyOn(client, 'recoveryTargetPreparation');
    await expect(admitWorkspaceBackupAtCore(f.owner, f.input)).rejects.toBeInstanceOf(Error);
    expect(calls.mock.calls.filter(([, input]) => input.kind === 'prepare')).toHaveLength(1);
    expect(readRecoveryAdmission(f.owner.core, f.input.requestId)).toBeUndefined();
    expect(rows(coreDbPath(f.dataRoot), 'workspace_registry')).toEqual(registry);
    expect(inventoryRegularFiles(join(f.dataRoot, 'workspaces', f.input.workspaceId))).toEqual(
      source
    );
    expect(f.owner.native.gate.ownsFreeze(f.input.workspaceId, f.owner.native.freeze)).toBe(true);
    // Already staged private bytes are not falsely described as a filesystem rollback.
    const container = `${f.dataRoot}.workspace-recovery-${f.input.requestId}`;
    expect(existsSync(join(container, 'workspaces', f.input.workspaceId))).toBe(true);
    expect(readdirSync(container).filter((name) => name.startsWith('.proof-'))).toEqual([]);
  }, 120_000);

  it('rolls a late whole-proof UPDATE back and preserves explicit partial abandonment', async () => {
    const f = await fixture();
    const source = inventoryRegularFiles(join(f.dataRoot, 'workspaces', f.input.workspaceId));
    f.owner.core.sqlite.exec(`CREATE TRIGGER target_proof_fault AFTER UPDATE OF proof_json ON workspace_recovery_admissions
      WHEN json_extract(OLD.proof_json,'$.candidateDigest') IS NULL
        AND json_extract(NEW.proof_json,'$.candidateDigest') IS NOT NULL
      BEGIN SELECT RAISE(ABORT, 'TARGET_PROOF_LATE_FAULT'); END`);
    f.owner.core.sqlite.pragma('query_only = ON');
    const client = getControlStoreWorkerClient(f.owner.native.gate);
    const actual = client.recoveryTargetPreparation.bind(client);
    let beforeProof: ReturnType<typeof readRecoveryAdmission>;
    const calls = vi
      .spyOn(client, 'recoveryTargetPreparation')
      .mockImplementation(async (...args) => {
        if (args[1].kind === 'proof')
          beforeProof = readRecoveryAdmission(f.owner.core, f.input.requestId);
        return actual(...args);
      });
    await expect(admitWorkspaceBackupAtCore(f.owner, f.input)).rejects.toBeInstanceOf(Error);
    expect(calls.mock.calls.filter(([, input]) => input.kind === 'proof')).toHaveLength(1);
    const owned = readRecoveryAdmission(f.owner.core, f.input.requestId)!;
    expect(beforeProof).toBeDefined();
    expect(owned).toEqual(beforeProof);
    expect(owned).toMatchObject({ state: 'prepared', revision: 1 });
    expect(owned.proof.candidateDigest).toBeUndefined();
    expect(owned.proof.result.disposition).toBe('quarantined');
    await closeCanonicalAtBoundary(f, owned);
    expect(inventoryRegularFiles(join(f.dataRoot, 'workspaces', f.input.workspaceId))).toEqual(
      source
    );
    expect(inspectWorkspaceRecoveryAtCore(f.owner.core, selection(f))).toMatchObject({
      disposition: 'quarantined',
      nextAction: 'finish',
    });
    // The original label is no authority to synthesize the missing digest or retry preparation.
    await expect(finishWorkspaceRecoveryAtCore(f.owner, selection(f))).rejects.toMatchObject({
      code: 'recovery-required',
    });
    expect(readRecoveryAdmission(f.owner.core, f.input.requestId)).toEqual(owned);
    await expect(abandonWorkspaceRecoveryAtCore(f.owner, selection(f))).resolves.toMatchObject({
      disposition: 'abandoned',
    });
    expect(readRecoveryAdmission(f.owner.core, f.input.requestId)).toMatchObject({
      state: 'abandoned',
      revision: 2,
      proof: { result: { disposition: 'abandoned' } },
    });
  }, 120_000);

  it.each(['abandon', 'abandon-result'] as const)(
    'keeps the original partial-abandon SQL and durable retirement order on late %s failure',
    async (kind) => {
      const f = await fixture();
      const owned = await partialPreparation(f);
      const candidate = inventoryRegularFiles(owned.candidate_ref);
      const canonical = inventoryRegularFiles(join(f.dataRoot, 'workspaces', f.input.workspaceId));
      physical.completedDirectorySyncs.length = 0;
      const condition =
        kind === 'abandon'
          ? "OLD.state='prepared' AND NEW.state='abandoned'"
          : "json_extract(NEW.proof_json,'$.result.disposition')='abandoned'";
      f.owner.core.sqlite.exec(`CREATE TRIGGER target_abandon_fault AFTER UPDATE ON workspace_recovery_admissions
        WHEN ${condition} BEGIN SELECT RAISE(ABORT, 'TARGET_ABANDON_LATE_FAULT'); END`);
      f.owner.core.sqlite.pragma('query_only = ON');
      const client = getControlStoreWorkerClient(f.owner.native.gate);
      const actual = client.recoveryTargetPreparation.bind(client);
      const publication = vi
        .spyOn(client, 'recoveryTargetPreparation')
        .mockImplementation(async (...args) => {
          if (args[1].kind === 'abandon') {
            expect(inventoryRegularFiles(owned.candidate_ref)).toEqual(candidate);
            expect(readRecoveryAdmission(f.owner.core, f.input.requestId)).toEqual(owned);
          } else if (args[1].kind === 'abandon-result') {
            expect(existsSync(owned.candidate_ref)).toBe(false);
            expect(inventoryRegularFiles(join(dirname(owned.candidate_ref), 'abandoned'))).toEqual(
              candidate
            );
            expect(readRecoveryAdmission(f.owner.core, f.input.requestId)).toMatchObject({
              state: 'abandoned',
              revision: 2,
              proof: { result: { disposition: 'quarantined' } },
            });
            expect(readRecoveryAdmission(f.owner.core, f.input.requestId)?.proof).toEqual(
              owned.proof
            );
            expect(physical.completedDirectorySyncs).toEqual(
              expect.arrayContaining([join(f.dataRoot, 'workspaces'), dirname(owned.candidate_ref)])
            );
          }
          return actual(...args);
        });
      await expect(abandonWorkspaceRecoveryAtCore(f.owner, selection(f))).rejects.toBeInstanceOf(
        Error
      );
      expect(publication.mock.calls.some(([, input]) => input.kind === kind)).toBe(true);
      if (kind === 'abandon') {
        expect(readRecoveryAdmission(f.owner.core, f.input.requestId)).toEqual(owned);
        expect(inventoryRegularFiles(owned.candidate_ref)).toEqual(candidate);
      } else {
        expect(readRecoveryAdmission(f.owner.core, f.input.requestId)).toMatchObject({
          state: 'abandoned',
          revision: 2,
          proof: { result: { disposition: 'quarantined' } },
        });
        expect(readRecoveryAdmission(f.owner.core, f.input.requestId)?.proof).toEqual(owned.proof);
        expect(existsSync(owned.candidate_ref)).toBe(false);
      }
      expect(inventoryRegularFiles(join(f.dataRoot, 'workspaces', f.input.workspaceId))).toEqual(
        canonical
      );
      publication.mockRestore();
      const writer = openCoreDb(f.dataRoot);
      try {
        writer.sqlite.exec('DROP TRIGGER target_abandon_fault');
      } finally {
        writer.sqlite.close();
      }
      await expect(abandonWorkspaceRecoveryAtCore(f.owner, selection(f))).resolves.toMatchObject({
        disposition: 'abandoned',
      });
      const terminal = readRecoveryAdmission(f.owner.core, f.input.requestId)!;
      expect(terminal).toMatchObject({
        state: 'abandoned',
        revision: 2,
        proof: { result: { disposition: 'abandoned' } },
      });
      expect(terminal.proof).toEqual({
        ...owned.proof,
        result: {
          ...owned.proof.result,
          command: 'abandon',
          disposition: 'abandoned',
          selection: selection(f).selection,
          nextAction: 'none',
        },
      });
      expect(inventoryRegularFiles(join(dirname(owned.candidate_ref), 'abandoned'))).toEqual(
        candidate
      );
      await expect(abandonWorkspaceRecoveryAtCore(f.owner, selection(f))).resolves.toEqual(
        terminal.proof.result
      );
      await expect(finishWorkspaceRecoveryAtCore(f.owner, selection(f))).rejects.toMatchObject({
        code: 'request-conflict',
      });
    },
    120_000
  );

  it.each([
    ['prepare', 'credential-revoked'],
    ['prepare', 'freeze-released'],
    ['proof', 'credential-revoked'],
    ['proof', 'freeze-released'],
    ['proof', 'retained-row-abandoned'],
  ] as const)(
    'refuses %s after %s at the real deferred Core post',
    async (kind, fault) => {
      const f = await fixture();
      const token = createOpenKitAccessTokenRecord(f.owner.core, {
        ownerUserId: f.owner.actor.userId,
        scope: 'server-admin',
        workspaceIds: [],
        expiresAt: '2999-01-01T00:00:00.000Z',
      });
      const actor = {
        kind: 'token' as const,
        userId: token.record.ownerUserId,
        tokenId: token.tokenId,
        tokenScope: token.record.scope,
        tokenWorkspaceIds: token.record.workspaceIds,
      };
      const owner = {
        ...f.owner,
        actor,
        currentAuthority: () => requireAdministratorOperation(f.owner.core, actor, 'api.call'),
      };
      const client = getControlStoreWorkerClient(owner.native.gate);
      const scope = nativeProductScope(f.dataRoot, { kind: 'server' });
      const database = `core:${scope.path}`;
      const actual = client.recoveryTargetPreparation.bind(client);
      let release = () => {};
      let held = false;
      const publication = vi
        .spyOn(client, 'recoveryTargetPreparation')
        .mockImplementation(async (...args) => {
          if (args[1].kind === kind) {
            if (kind === 'proof') {
              await closeCanonicalAtBoundary(
                f,
                readRecoveryAdmission(f.owner.core, f.input.requestId)!,
                owner.currentAuthority
              );
              expect(
                inventoryRegularFiles(join(f.dataRoot, 'workspaces', f.input.workspaceId))
              ).toEqual(source);
            }
            release = await client.pauseForDataRootBackup(database);
            held = true;
          }
          return actual(...args);
        });
      const post = vi.spyOn(Worker.prototype, 'postMessage');
      const selectedPosts = () =>
        post.mock.calls.filter(
          ([message]) =>
            message.operation === 'recovery-target-preparation' &&
            message.database === database &&
            message.input?.admissionId === f.input.requestId &&
            message.input?.kind === kind
        );
      const source = inventoryRegularFiles(join(f.dataRoot, 'workspaces', f.input.workspaceId));
      f.owner.core.sqlite.pragma('query_only = ON');
      let settled = false;
      const command = admitWorkspaceBackupAtCore(owner, f.input).then(
        (result) => {
          settled = true;
          return { result };
        },
        (error: unknown) => {
          settled = true;
          return { error };
        }
      );
      try {
        while (!held && !settled) await nextTurn();
        expect(held).toBe(true);
        expect(settled).toBe(false);
        expect(selectedPosts()).toEqual([]);
        const before = readRecoveryAdmission(f.owner.core, f.input.requestId);
        if (kind === 'proof') {
          expect(before).toBeDefined();
          expect(
            publication.mock.calls.find(([, input]) => input.kind === 'proof')?.[1]
          ).toMatchObject({
            expectedRevision: before!.revision,
            proofHash: commandInputHash(before!.proof),
          });
        }
        const registry = rows(scope.path, 'workspace_registry');
        const writer = openCoreDb(f.dataRoot);
        try {
          if (fault === 'credential-revoked') revokeOpenKitAccessTokenRecord(writer, token.tokenId);
          else if (fault === 'freeze-released') owner.native.freeze.release();
          else {
            // Adversarial current fact through the existing Core terminal leaf, not a full physical abandon.
            endRecoveryAdmission(writer, f.input.requestId, 'abandoned');
          }
        } finally {
          writer.sqlite.close();
        }
        const expected = readRecoveryAdmission(f.owner.core, f.input.requestId);
        release();
        release = () => {};
        expect(await command).toHaveProperty('error');
        expect(selectedPosts()).toHaveLength(fault === 'freeze-released' ? 0 : 1);
        expect(readRecoveryAdmission(f.owner.core, f.input.requestId)).toEqual(expected);
        if (fault !== 'retained-row-abandoned') expect(expected).toEqual(before);
        expect(rows(scope.path, 'workspace_registry')).toEqual(registry);
        expect(inventoryRegularFiles(join(f.dataRoot, 'workspaces', f.input.workspaceId))).toEqual(
          source
        );
      } finally {
        release();
        await command;
        publication.mockRestore();
        post.mockRestore();
      }
    },
    120_000
  );

  it.each(['digest-mismatch', 'wrong-root'] as const)(
    'refuses actual native immutable input with %s before creating admission authority',
    async (fault) => {
      const f = await fixture();
      const client = getControlStoreWorkerClient(f.owner.native.gate);
      const actual = client.recoveryTargetPreparation.bind(client);
      const container = `${f.dataRoot}.workspace-recovery-${f.input.requestId}`;
      const displaced = `${container}-retained`;
      let substituted = false;
      const publication = vi
        .spyOn(client, 'recoveryTargetPreparation')
        .mockImplementation(async (...args) => {
          if (args[1].kind !== 'prepare') return actual(...args);
          const input = args[1];
          if (fault === 'digest-mismatch')
            return actual(
              args[0],
              { ...input, file: { ...input.file, digest: `sha256:${'0'.repeat(64)}` } },
              args[2]
            );
          const outside = join(f.root, 'outside-operation');
          mkdirSync(outside);
          const bytes = readFileSync(join(container, input.file.name));
          await publishDurableFile({ destinationPath: join(outside, input.file.name), bytes });
          renameSync(container, displaced);
          symlinkSync(outside, container, 'dir');
          substituted = true;
          try {
            return await actual(...args);
          } finally {
            rmSync(container);
            renameSync(displaced, container);
            substituted = false;
          }
        });
      const post = vi.spyOn(Worker.prototype, 'postMessage');
      const source = inventoryRegularFiles(join(f.dataRoot, 'workspaces', f.input.workspaceId));
      f.owner.core.sqlite.pragma('query_only = ON');
      try {
        await expect(admitWorkspaceBackupAtCore(f.owner, f.input)).rejects.toBeInstanceOf(Error);
        expect(publication.mock.calls.filter(([, input]) => input.kind === 'prepare')).toHaveLength(
          1
        );
        expect(
          post.mock.calls.filter(
            ([message]) =>
              message.operation === 'recovery-target-preparation' &&
              message.input?.admissionId === f.input.requestId &&
              message.input?.kind === 'prepare'
          )
        ).toHaveLength(1);
        expect(readRecoveryAdmission(f.owner.core, f.input.requestId)).toBeUndefined();
        expect(inventoryRegularFiles(join(f.dataRoot, 'workspaces', f.input.workspaceId))).toEqual(
          source
        );
      } finally {
        if (substituted) {
          rmSync(container);
          renameSync(displaced, container);
        }
        publication.mockRestore();
        post.mockRestore();
      }
    },
    120_000
  );

  it('transports a scaled proof larger than 64 MiB through the real immutable file and native SQL owner', async () => {
    const f = await fixture();
    const client = getControlStoreWorkerClient(f.owner.native.gate);
    const actual = client.recoveryTargetPreparation.bind(client);
    const stopped = new Error('Observe scaled native transport before candidate preparation.');
    let expectedDigest = '';
    let expectedBytes = 0;
    const publication = vi
      .spyOn(client, 'recoveryTargetPreparation')
      .mockImplementation(async (...args) => {
        const input = args[1];
        if (input.kind !== 'prepare') return actual(...args);
        const container = `${f.dataRoot}.workspace-recovery-${f.input.requestId}`;
        const proof = JSON.parse(readFileSync(join(container, input.file.name), 'utf8'));
        // Transport sizing only: this descriptive addition does not claim 850,000 real graph records.
        proof.result.futureTransportDescription = 'x'.repeat(64 * 1024 * 1024 + 1024);
        const bytes = Buffer.from(JSON.stringify(proof), 'utf8');
        expectedBytes = bytes.length;
        expectedDigest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
        expect(bytes.length).toBeGreaterThan(CONTROL_WORKER_LIMITS.pendingBytes);
        const name = `.proof-${randomUUID()}.json`;
        const path = join(container, name);
        const reservation = f.owner.fileAdmission.forPath(container).reserve({
          stagingBytes: BigInt(bytes.length),
          extractionBytes: 0n,
          derivativeBytes: 0n,
          publicationBytes: 0n,
        });
        try {
          reservation.assertAvailable();
          const written = await publishDurableFile({ destinationPath: path, bytes });
          reservation.recordWritten(written.bytes);
          expect(written.sha256).toBe(expectedDigest);
          const descriptor = { name, byteLength: bytes.length, digest: expectedDigest };
          await actual(args[0], { ...input, file: descriptor }, args[2]);
        } finally {
          await removeDurableFile({ destinationPath: path });
          reservation.release();
        }
        throw stopped;
      });
    const post = vi.spyOn(Worker.prototype, 'postMessage');
    f.owner.core.sqlite.pragma('query_only = ON');
    try {
      await expect(admitWorkspaceBackupAtCore(f.owner, f.input)).rejects.toBe(stopped);
      const commands = post.mock.calls
        .map(([message]) => message)
        .filter(
          (message) =>
            message.operation === 'recovery-target-preparation' &&
            message.input?.admissionId === f.input.requestId
        );
      expect(commands).toHaveLength(1);
      expect(controlWorkerInputBytes(commands[0]) + 64).toBeLessThan(1024 * 1024);
      const reader = new Database(coreDbPath(f.dataRoot), { readonly: true, fileMustExist: true });
      try {
        const row = reader
          .prepare(
            'SELECT state,revision,proof_json FROM workspace_recovery_admissions WHERE admission_id=?'
          )
          .get(f.input.requestId) as { state: string; revision: number; proof_json: string };
        expect(row.state).toBe('prepared');
        expect(row.revision).toBe(1);
        expect(Buffer.byteLength(row.proof_json)).toBe(expectedBytes);
        expect(`sha256:${createHash('sha256').update(row.proof_json).digest('hex')}`).toBe(
          expectedDigest
        );
        const retained = JSON.parse(row.proof_json);
        expect(retained.input).toEqual(f.input);
        expect(retained.manifest).toEqual(f.capture.manifest);
        expect(retained.candidateDigest).toBeUndefined();
        expect(retained.result.futureTransportDescription.length).toBe(64 * 1024 * 1024 + 1024);
      } finally {
        reader.close();
      }
    } finally {
      publication.mockRestore();
      post.mockRestore();
    }
  }, 120_000);
});
