// openkit-test-platform: posix
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listWorkspaceAuditEvents } from '../audit-events.js';
import { requireAdministratorOperation } from '../auth/operation-authorizer.js';
import { isScopeAdmitted, refuseScope, scopeAdmissionFailures } from '../bootstrap/readiness.js';
import { restoreWorkspaceRecoveryAdmission } from '../bootstrap/workspace-recovery.js';
import { createOperationInvocation } from '../operation-composition.js';
import { createDemoStore, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import {
  type WorkspaceFrozenAdmission,
  WorkspaceMutationAdmission,
} from '../workspace-mutation-admission.js';
import { FileStorageAdmission } from './artifacts/file-admission.js';
import {
  ControlStoreWorkerError,
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './control-store-worker-client.js';
import { type CoreDb, openCoreDb, openWorkspaceDb, type WorkspaceDb } from './db.js';
import { readDataRootLayoutMarker } from './fs-layout.js';
import {
  createWorkspaceBackup,
  invokeWorkspaceRecoveryOperation,
  readWorkspaceBackupManifest,
  readWorkspaceRecoveryBlockers,
  WORKSPACE_BACKUP_POLICY,
} from './workspace-backup.js';
import { parseWorkspaceBackupSeal } from './workspace-backup-bundle.js';
import { inspectCapture, protectCapture } from './workspace-capture-protection.js';
import { nativeProductScope } from './workspace-file-records.js';
import { abandonWorkspaceCaptureAtCore, finishWorkspaceCaptureAtCore } from './workspace-move.js';
import {
  readRecoveryAdmission,
  resumeWorkspaceCaptureOwner,
} from './workspace-recovery-admissions.js';
import { WorkspaceRecoveryError } from './workspace-recovery-error.js';

const roots: string[] = [];
const handles: (CoreDb | WorkspaceDb)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await shutdownControlStoreWorkerClient();
  for (const db of handles.splice(0)) if (db.sqlite.open) db.sqlite.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Produces source authority through real capture, or its original SQL-only crash pin owner. */
async function fixture(sqlOnly = false, sealedBackup = false, missingMoveProof = false) {
  const root = mkdtempSync(join(tmpdir(), 'source-finalization-'));
  roots.push(root);
  const dataRoot = join(root, 'source');
  const store = await createDemoStore({ dataRoot });
  const coreDb = openCoreDb(dataRoot);
  handles.push(coreDb);
  const workspaceId = DEMO_WORKSPACE_ID;
  const userId = ensureLocalUser(coreDb);
  recordWorkspaceOwnerMembership({ coreDb, workspaceId, ownerUserId: userId });
  const sourceFile = join(dataRoot, 'workspaces', workspaceId, 'files', 'retained-source.txt');
  mkdirSync(join(sourceFile, '..'), { recursive: true });
  writeFileSync(sourceFile, 'Retain these source bytes across recovery.');
  const sourceBytes = readFileSync(sourceFile);
  const mutationAdmission = new WorkspaceMutationAdmission();
  const source = {
    kind: 'live-workspace' as const,
    dataRoot,
    coreDb,
    store,
    mutationAdmission,
    actor: { kind: 'local' as const, userId },
  };
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
    if (sealedBackup || missingMoveProof) {
      await interruptCaptureBeforeCoreDecision(captureInput);
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

/** Loses the real capture Worker after its published metadata, before its original SQL decision. */
async function interruptCaptureBeforeCoreDecision(
  input: Parameters<typeof createWorkspaceBackup>[0]
) {
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
      (input.purpose === 'move'
        ? message.phase === 'authority' && existsSync(join(input.bundleRoot, 'manifest.json'))
        : message.phase === 'finish')
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
        throw new Error('Capture did not reach its actual Worker decision boundary.');
      }),
    ]);
    expect(existsSync(join(input.bundleRoot, 'manifest.json'))).toBe(true);
    expect(existsSync(join(input.bundleRoot, 'seal.json'))).toBe(input.purpose !== 'move');
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
  it('prepares the original missing MOVE admission after actual capture interruption and retains it through cold reopen', async () => {
    const f = await fixture(false, false, true);
    expect(f.state().core).toBeUndefined();
    expect(f.state().pin?.state).toBe('active');
    expect(existsSync(f.marker)).toBe(false);
    try {
      await expect(finishWorkspaceCaptureAtCore(f.owned, f.input, f.freeze)).resolves.toMatchObject(
        {
          command: 'finish',
          disposition: 'moved-out',
          workspaceId: f.workspaceId,
        }
      );
      const finished = f.state();
      expect(finished.core).toMatchObject({
        admission_id: f.backupId,
        state: 'finished',
        revision: 2,
        proof: {
          input: { command: 'move-out', backupId: f.backupId },
          result: { disposition: 'moved-out' },
        },
      });
      expect(finished.pin?.state).toBe('finished');
      expect(readFileSync(f.sourceFile)).toEqual(f.sourceBytes);
      expect(f.mutationAdmission.enter(f.workspaceId)).toBeNull();
      await shutdownControlStoreWorkerClient();
      f.owned.coreDb.sqlite.close();
      const reopened = openCoreDb(f.dataRoot);
      handles.push(reopened);
      expect(readRecoveryAdmission(reopened, f.backupId)).toEqual(finished.core);
    } finally {
      f.freeze.release();
    }
  }, 30_000);

  it('natively prepares and finishes the missing MOVE proof with Main Core query-only and exact cold readback', async () => {
    const f = await fixture(false, false, true);
    f.owned.coreDb.sqlite.pragma('query_only = ON');
    const post = vi.spyOn(Worker.prototype, 'postMessage');
    try {
      const report = await finishWorkspaceCaptureAtCore(f.owned, f.input, f.freeze);
      expect(report).toMatchObject({ command: 'finish', disposition: 'moved-out' });
      const frames = post.mock.calls
        .map(([frame]) => frame)
        .filter((frame) => frame?.operation === 'recovery-target-preparation');
      expect(frames.map((frame) => frame.input.kind)).toEqual(['source-prepare', 'source-finish']);
      for (const frame of frames) {
        expect(frame.database).toBe(`core:${f.owned.coreDb.sqlite.name}`);
        expect(frame.input).toMatchObject({
          admissionId: f.backupId,
          workspaceId: f.workspaceId,
          authority: { mode: 'source' },
          file: {
            name: expect.stringMatching(/^\.proof-[0-9a-f-]+\.json$/),
            byteLength: expect.any(Number),
            digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
          },
        });
      }
      expect(JSON.stringify(frames)).not.toContain('"manifest":');
      expect(JSON.stringify(frames)).not.toContain(f.sourceBytes.toString());
      const finished = f.state();
      expect(finished.core).toMatchObject({ state: 'finished', revision: 2 });
      expect(finished.pin?.state).toBe('finished');
      expect(finished.audit).toHaveLength(1);
      expect(existsSync(f.marker)).toBe(true);
      expect(readFileSync(f.sourceFile)).toEqual(f.sourceBytes);
      expect(f.mutationAdmission.enter(f.workspaceId)).toBeNull();
      await shutdownControlStoreWorkerClient();
      f.owned.coreDb.sqlite.close();
      const reopened = openCoreDb(f.dataRoot);
      handles.push(reopened);
      expect(readRecoveryAdmission(reopened, f.backupId)).toEqual(finished.core);
    } finally {
      f.freeze.release();
    }
  }, 30_000);

  it.each(['freeze', 'current-origin'] as const)(
    'refuses a genuinely held source post after losing its %s before native publication',
    async (loss) => {
      const f = await fixture(false, false, true);
      const before = f.state();
      const client = getControlStoreWorkerClient(f.mutationAdmission);
      const scope = nativeProductScope(f.dataRoot, { kind: 'server' });
      const database = `core:${scope.path}`;
      await client.open({
        database,
        path: scope.path,
        dataRoot: f.dataRoot,
        create: false,
        initialize: 'core',
        productOwner: scope.owner,
        contentMount: scope.contentMount,
      });
      const release = await client.pauseForDataRootBackup(database);
      const original = client.recoveryTargetPreparation.bind(client);
      let entered!: () => void;
      const admitted = new Promise<void>((resolve) => {
        entered = resolve;
      });
      vi.spyOn(client, 'recoveryTargetPreparation').mockImplementation((...args) => {
        const result = original(...args);
        if (args[1].kind === 'source-prepare' && args[1].admissionId === f.backupId) entered();
        return result;
      });
      const post = vi.spyOn(Worker.prototype, 'postMessage');
      const pending = finishWorkspaceCaptureAtCore(f.owned, f.input, f.freeze).then(
        (result) => ({ result }),
        (error: unknown) => ({ error })
      );
      try {
        await Promise.race([
          admitted,
          pending.then(() => {
            throw new Error('Source did not enter the real Core posting hold.');
          }),
        ]);
        expect(f.state()).toEqual(before);
        expect(
          post.mock.calls.filter(([frame]) => frame?.operation === 'recovery-target-preparation')
        ).toHaveLength(0);
        if (loss === 'freeze') f.freeze.release();
        else {
          refuseScope(f.dataRoot, { scope: 'workspace', id: f.workspaceId, check: 'retired' });
          expect(scopeAdmissionFailures(f.dataRoot)).toContainEqual({
            scope: 'workspace',
            id: f.workspaceId,
            check: 'retired',
          });
        }
        release();
        const refused = await pending;
        if (loss === 'freeze') {
          expect(refused).toMatchObject({ error: expect.any(ControlStoreWorkerError) });
          expect(refused).toMatchObject({
            error: { code: 'precondition', commit: 'not-committed' },
          });
        } else {
          expect(refused).toMatchObject({ error: expect.any(WorkspaceRecoveryError) });
          expect(refused).toMatchObject({ error: { code: 'recovery-required' } });
        }
        expect(f.state()).toEqual(before);
        expect(
          post.mock.calls.filter(([frame]) => frame?.operation === 'recovery-target-preparation')
        ).toHaveLength(0);
        expect(existsSync(f.marker)).toBe(false);
        expect(readFileSync(f.sourceFile)).toEqual(f.sourceBytes);
        expect(isScopeAdmitted(f.dataRoot, 'workspace', f.workspaceId)).toBe(false);
      } finally {
        release();
        await pending;
        f.freeze.release();
      }
    },
    30_000
  );

  it('refuses source preparation ordered behind actual native User disable before any source Core write', async () => {
    const f = await fixture(false, false, true);
    const before = f.state();
    const actor = f.owned.actor;
    const owned = {
      ...f.owned,
      currentAuthority: () => requireAdministratorOperation(f.owned.coreDb, actor, 'api.call'),
    };
    owned.currentAuthority();
    const client = getControlStoreWorkerClient(f.mutationAdmission);
    const scope = nativeProductScope(f.dataRoot, { kind: 'server' });
    const database = `core:${scope.path}`;
    await client.open({
      database,
      path: scope.path,
      dataRoot: f.dataRoot,
      create: false,
      initialize: 'core',
      productOwner: scope.owner,
      contentMount: scope.contentMount,
    });
    const blocker = new Database(scope.path);
    blocker.exec('BEGIN IMMEDIATE');
    let disableEntered!: () => void;
    let sourceEntered!: () => void;
    const disablePosted = new Promise<void>((resolve) => {
      disableEntered = resolve;
    });
    const sourcePosted = new Promise<void>((resolve) => {
      sourceEntered = resolve;
    });
    const order: string[] = [];
    const post = Worker.prototype.postMessage;
    vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (this: Worker, ...args) {
      const result = post.call(this, ...args);
      const frame = args[0];
      if (
        frame?.database === database &&
        frame.operation === 'core-sharing' &&
        frame.input?.command === 'user.disable'
      ) {
        order.push('user.disable');
        disableEntered();
      }
      if (
        frame?.database === database &&
        frame.operation === 'recovery-target-preparation' &&
        frame.input?.kind === 'source-prepare' &&
        frame.input?.admissionId === f.backupId
      ) {
        order.push('source-prepare');
        sourceEntered();
      }
      return result;
    });
    const invoke = createOperationInvocation({
      inflightCommands: new WeakMap(),
      coreDb: f.owned.coreDb,
      dataRoot: f.dataRoot,
      store: f.owned.store,
      workspaceMutationAdmission: f.mutationAdmission,
      mode: 'local',
    });
    const disabling = invoke(
      'user.disable',
      { targetUserId: actor.userId, requestId: randomUUID() },
      { kind: 'public', actor, delivery: 'human' }
    );
    let pending: Promise<{ result: unknown } | { error: unknown }> | undefined;
    try {
      await Promise.race([
        disablePosted,
        disabling.then(() => {
          throw new Error('User disable did not reach the actual native Core queue.');
        }),
      ]);
      expect(
        f.owned.coreDb.sqlite.prepare('SELECT status FROM users WHERE id=?').get(actor.userId)
      ).toEqual({ status: 'active' });
      pending = invokeWorkspaceRecoveryOperation(() =>
        finishWorkspaceCaptureAtCore(owned, f.input, f.freeze)
      ).then(
        (result) => ({ result }),
        (error: unknown) => ({ error })
      );
      await Promise.race([
        sourcePosted,
        pending.then(() => {
          throw new Error('Source did not reach the native queue behind User disable.');
        }),
      ]);
      expect(order).toEqual(['user.disable', 'source-prepare']);
      blocker.exec('ROLLBACK');
      expect(await disabling).toMatchObject({ user: { userId: actor.userId, status: 'disabled' } });
      const sourceOutcome = await pending;
      expect(
        f.owned.coreDb.sqlite.prepare('SELECT status FROM users WHERE id=?').get(actor.userId)
      ).toEqual({ status: 'disabled' });
      expect(f.state().core).toBeUndefined();
      expect(f.state()).toEqual(before);
      expect(existsSync(f.marker)).toBe(false);
      expect(readFileSync(f.sourceFile)).toEqual(f.sourceBytes);
      expect(f.mutationAdmission.enter(f.workspaceId)).toBeNull();
      expect(order).toEqual(['user.disable', 'source-prepare']);
      expect(sourceOutcome).toMatchObject({
        error: {
          code: 'deployment_admin_required',
          status: 403,
          message: 'Current deployment administrator authority is required.',
        },
      });
    } finally {
      if (blocker.inTransaction) blocker.exec('ROLLBACK');
      blocker.close();
      await Promise.allSettled([disabling, ...(pending ? [pending] : [])]);
      f.freeze.release();
    }
  }, 30_000);

  it.each([
    'source-prepare',
    'source-finish',
    'source-abandon-preseal',
    'source-abandon-final',
  ] as const)(
    'retains the genuine committed %s tuple after its covering ACK is held then lost without reposting',
    async (stage) => {
      const f = await fixture(false, false, stage === 'source-prepare');
      const generation = lstatSync(f.bundleRoot);
      const handle = await open(f.bundleRoot, 'r');
      const prototype = Object.getPrototypeOf(handle) as FileHandle;
      const sync = prototype.sync;
      await handle.close();
      let generationSyncs = 0;
      vi.spyOn(prototype, 'sync').mockImplementation(async function (this: FileHandle) {
        const current = await this.stat();
        await sync.call(this);
        if (current.dev === generation.dev && current.ino === generation.ino) generationSyncs += 1;
      });
      const post = vi.spyOn(Worker.prototype, 'postMessage');
      let selectedWorker: Worker | undefined;
      let arrived!: () => void;
      const committed = new Promise<void>((resolve) => {
        arrived = resolve;
      });
      const emit = Worker.prototype.emit;
      const crossing = vi.spyOn(Worker.prototype, 'emit').mockImplementation(function (
        this: Worker,
        event: string | symbol,
        ...args: unknown[]
      ) {
        const reply = args[0] as { id?: number; status?: string; operation?: string } | undefined;
        const request = post.mock.calls.find(
          ([frame]) =>
            frame?.operation === 'recovery-target-preparation' &&
            frame.input?.kind === stage &&
            frame.input?.admissionId === f.backupId
        )?.[0];
        if (
          event === 'message' &&
          reply?.status === 'ok' &&
          reply.operation === 'recovery-target-preparation' &&
          request?.id === reply.id &&
          !selectedWorker
        ) {
          selectedWorker = this;
          arrived();
          return true;
        }
        return emit.call(this, event, ...args);
      });
      let continued = false;
      const action = stage.startsWith('source-abandon')
        ? abandonWorkspaceCaptureAtCore(f.owned, f.input, f.freeze)
        : finishWorkspaceCaptureAtCore(f.owned, f.input, f.freeze);
      const pending = action.then(
        (result) => {
          continued = true;
          return { result };
        },
        (error: unknown) => {
          continued = true;
          return { error };
        }
      );
      try {
        await Promise.race([
          committed,
          pending.then(() => {
            throw new Error('The selected source operation settled before its genuine native ACK.');
          }),
        ]);
        expect(continued).toBe(false);
        const retained = f.state();
        expect(retained.core).toMatchObject({
          admission_id: f.backupId,
          state:
            stage === 'source-prepare'
              ? 'prepared'
              : stage === 'source-finish'
                ? 'finished'
                : 'abandoned',
          revision: stage === 'source-prepare' ? 1 : 2,
          proof: {
            result: {
              disposition:
                stage === 'source-prepare'
                  ? 'prepared'
                  : stage === 'source-finish'
                    ? 'moved-out'
                    : stage === 'source-abandon-preseal'
                      ? 'quarantined'
                      : 'abandoned',
            },
          },
        });
        expect(retained.pin?.state).toBe(
          stage === 'source-prepare'
            ? 'active'
            : stage === 'source-finish'
              ? 'finished'
              : 'abandoned'
        );
        expect(!!retained.record.movedOut).toBe(stage === 'source-finish');
        expect(existsSync(f.marker)).toBe(stage === 'source-finish');
        if (stage === 'source-abandon-preseal') expect(generationSyncs).toBe(0);
        if (stage === 'source-abandon-final') expect(generationSyncs).toBe(1);
        expect(readFileSync(f.sourceFile)).toEqual(f.sourceBytes);
        expect(f.mutationAdmission.enter(f.workspaceId)).toBeNull();
        const selectedPosts = post.mock.calls.filter(
          ([frame]) =>
            frame?.operation === 'recovery-target-preparation' &&
            frame.input?.kind === stage &&
            frame.input?.admissionId === f.backupId
        );
        expect(selectedPosts).toHaveLength(1);
        await selectedWorker!.terminate();
        const outcome = await pending;
        expect(outcome).toMatchObject({ error: expect.any(ControlStoreWorkerError) });
        if (!('error' in outcome)) throw new Error('A lost source ACK cannot return success.');
        expect(outcome.error).toMatchObject({ commit: 'unknown' });
        expect(
          post.mock.calls.filter(
            ([frame]) =>
              frame?.operation === 'recovery-target-preparation' &&
              frame.input?.kind === stage &&
              frame.input?.admissionId === f.backupId
          )
        ).toHaveLength(1);
        expect(f.state().core).toEqual(retained.core);
        expect(f.state().pin).toEqual(retained.pin);
        expect(existsSync(f.marker)).toBe(stage === 'source-finish');
        if (stage === 'source-abandon-preseal') expect(generationSyncs).toBe(0);
        await shutdownControlStoreWorkerClient();
        f.owned.coreDb.sqlite.close();
        const reopened = openCoreDb(f.dataRoot);
        handles.push(reopened);
        expect(readRecoveryAdmission(reopened, f.backupId)).toEqual(retained.core);
        expect(readFileSync(f.sourceFile)).toEqual(f.sourceBytes);
        if (stage !== 'source-abandon-final') {
          const coldAdmission = new WorkspaceMutationAdmission();
          restoreWorkspaceRecoveryAdmission(reopened, coldAdmission);
          expect(coldAdmission.enter(f.workspaceId)).toBeNull();
        }
      } finally {
        crossing.mockRestore();
        if (selectedWorker && selectedWorker.threadId !== -1) await selectedWorker.terminate();
        await pending;
        f.freeze.release();
      }
    },
    30_000
  );

  it('rolls back the exact native source preparation INSERT before any moved-out or seal effect', async () => {
    const f = await fixture(false, false, true);
    const before = f.state();
    f.owned.coreDb.sqlite.exec(`CREATE TRIGGER refuse_source_prepare BEFORE INSERT ON workspace_recovery_admissions
      WHEN NEW.admission_id='${f.backupId}' BEGIN SELECT RAISE(ABORT, 'source preparation refused'); END`);
    const post = vi.spyOn(Worker.prototype, 'postMessage');
    try {
      await expect(finishWorkspaceCaptureAtCore(f.owned, f.input, f.freeze)).rejects.toMatchObject({
        code: 'constraint',
        commit: 'not-committed',
      });
      expect(
        post.mock.calls.filter(
          ([frame]) =>
            frame?.operation === 'recovery-target-preparation' &&
            frame.input?.kind === 'source-prepare' &&
            frame.input?.admissionId === f.backupId
        )
      ).toHaveLength(1);
      expect(f.state()).toEqual(before);
      expect(before.core).toBeUndefined();
      expect(before.pin?.state).toBe('active');
      expect(before.record.movedOut).toBeUndefined();
      expect(existsSync(f.marker)).toBe(false);
      expect(readFileSync(f.sourceFile)).toEqual(f.sourceBytes);
      expect(f.mutationAdmission.enter(f.workspaceId)).toBeNull();
      f.owned.coreDb.sqlite.exec('DROP TRIGGER refuse_source_prepare');
      await shutdownControlStoreWorkerClient();
      f.owned.coreDb.sqlite.close();
      const reopened = openCoreDb(f.dataRoot);
      handles.push(reopened);
      expect(readRecoveryAdmission(reopened, f.backupId)).toBeUndefined();
      const coldAdmission = new WorkspaceMutationAdmission();
      restoreWorkspaceRecoveryAdmission(reopened, coldAdmission);
      expect(coldAdmission.enter(f.workspaceId)).toBeNull();
    } finally {
      if (f.owned.coreDb.sqlite.open)
        f.owned.coreDb.sqlite.exec('DROP TRIGGER IF EXISTS refuse_source_prepare');
      f.freeze.release();
    }
  }, 30_000);

  it('retires its exact private proof after real post-link directory-sync failure without publishing the Core finish report', async () => {
    const f = await fixture();
    const before = f.state();
    const pool = dirname(f.bundleRoot);
    const parent = lstatSync(pool);
    const handle = await open(pool, 'r');
    const prototype = Object.getPrototypeOf(handle) as FileHandle;
    const sync = prototype.sync;
    await handle.close();
    let publicationFailures = 0;
    let cleanupSyncs = 0;
    vi.spyOn(prototype, 'sync').mockImplementation(async function (this: FileHandle) {
      const current = await this.stat();
      const selected = current.dev === parent.dev && current.ino === parent.ino;
      const proofs = selected
        ? readdirSync(pool).filter((name) => /^\.proof-[0-9a-f-]+\.json$/.test(name))
        : [];
      if (selected && proofs.length && publicationFailures === 0) {
        expect(proofs).toHaveLength(1);
        publicationFailures += 1;
        throw new Error('Injected private proof post-link directory synchronization failure.');
      }
      await sync.call(this);
      if (selected && publicationFailures === 1 && proofs.length === 0) cleanupSyncs += 1;
    });
    const post = vi.spyOn(Worker.prototype, 'postMessage');
    try {
      await expect(finishWorkspaceCaptureAtCore(f.owned, f.input, f.freeze)).rejects.toThrow();
      expect(publicationFailures).toBe(1);
      expect(cleanupSyncs).toBe(1);
      expect(readdirSync(pool).filter((name) => /^\.proof-/.test(name))).toEqual([]);
      const failed = f.state();
      expect(failed.core).toEqual(before.core);
      expect(failed.pin?.state).toBe('finished');
      expect(failed.record.movedOut).toMatchObject({ backupId: f.backupId });
      expect(failed.audit).toHaveLength(1);
      expect(existsSync(f.marker)).toBe(true);
      expect(readFileSync(f.sourceFile)).toEqual(f.sourceBytes);
      expect(f.mutationAdmission.enter(f.workspaceId)).toBeNull();
      expect(
        post.mock.calls.filter(
          ([frame]) =>
            frame?.operation === 'recovery-target-preparation' &&
            frame.input?.kind === 'source-finish'
        )
      ).toHaveLength(0);
      await shutdownControlStoreWorkerClient();
      f.owned.coreDb.sqlite.close();
      const reopened = openCoreDb(f.dataRoot);
      handles.push(reopened);
      expect(readRecoveryAdmission(reopened, f.backupId)).toEqual(before.core);
      const coldAdmission = new WorkspaceMutationAdmission();
      restoreWorkspaceRecoveryAdmission(reopened, coldAdmission);
      expect(coldAdmission.enter(f.workspaceId)).toBeNull();
    } finally {
      f.freeze.release();
    }
  }, 30_000);

  it('refuses missing-proof finalization when retirement refusal supersedes recovery during materialization', async () => {
    const f = await fixture(false, false, true);
    const before = f.state();
    const storage = await import('@openkit/storage');
    const materialize = storage.materializeWorkspaceBackupInventory;
    let completedMaterializations = 0;
    const crossing = vi
      .spyOn(storage, 'materializeWorkspaceBackupInventory')
      .mockImplementation(async (...args) => {
        const result = await materialize(...args);
        completedMaterializations += 1;
        refuseScope(f.dataRoot, { scope: 'workspace', id: f.workspaceId, check: 'retired' });
        expect(scopeAdmissionFailures(f.dataRoot)).toContainEqual({
          scope: 'workspace',
          id: f.workspaceId,
          check: 'retired',
        });
        return result;
      });
    const post = vi.spyOn(Worker.prototype, 'postMessage');
    try {
      await expect(finishWorkspaceCaptureAtCore(f.owned, f.input, f.freeze)).rejects.toThrow();
      expect(completedMaterializations).toBe(1);
      const refused = f.state();
      expect(refused.core).toEqual(before.core);
      expect(refused.core).toBeUndefined();
      expect(refused.pin).toEqual(before.pin);
      expect(refused.pin?.state).toBe('active');
      expect(refused.revision).toBe(before.revision);
      expect(refused.record).toEqual(before.record);
      expect(refused.audit).toEqual(before.audit);
      expect(refused.record.movedOut).toBeUndefined();
      expect(existsSync(f.marker)).toBe(false);
      expect(readFileSync(f.sourceFile)).toEqual(f.sourceBytes);
      expect(f.mutationAdmission.enter(f.workspaceId)).toBeNull();
      expect(scopeAdmissionFailures(f.dataRoot)).toContainEqual({
        scope: 'workspace',
        id: f.workspaceId,
        check: 'retired',
      });
      expect(
        post.mock.calls.filter(
          ([frame]) =>
            frame?.operation === 'recovery-target-preparation' &&
            frame.input?.kind === 'source-prepare'
        )
      ).toHaveLength(0);
    } finally {
      crossing.mockRestore();
      f.freeze.release();
    }
  }, 30_000);

  it.each(['finish', 'abandon-preseal', 'abandon-final'] as const)(
    'rolls back the original %s Core report while retaining earlier source effects across cold reopen',
    async (stage) => {
      const f = await fixture();
      const before = f.state();
      const condition =
        stage === 'abandon-final'
          ? "OLD.state='abandoned' AND json_extract(NEW.proof_json,'$.result.disposition')='abandoned'"
          : `NEW.state='${stage === 'finish' ? 'finished' : 'abandoned'}'`;
      const column = stage === 'abandon-final' ? 'proof_json' : 'state';
      f.owned.coreDb.sqlite.exec(`CREATE TRIGGER refuse_source_report BEFORE UPDATE OF ${column} ON workspace_recovery_admissions
        WHEN OLD.admission_id='${f.backupId}' AND ${condition}
        BEGIN SELECT RAISE(ABORT, 'source Core report refused'); END`);
      try {
        await expect(
          stage === 'finish'
            ? finishWorkspaceCaptureAtCore(f.owned, f.input, f.freeze)
            : abandonWorkspaceCaptureAtCore(f.owned, f.input, f.freeze)
        ).rejects.toThrow();
        const failed = f.state();
        if (stage === 'abandon-final') {
          expect(failed.core).toMatchObject({
            state: 'abandoned',
            revision: before.core!.revision + 1,
            proof: {
              input: before.core!.proof.input,
              manifest: before.core!.proof.manifest,
              result: { disposition: 'quarantined', nextAction: 'abandon' },
            },
          });
        } else expect(failed.core).toEqual(before.core);
        expect(failed.pin?.state).toBe(stage === 'finish' ? 'finished' : 'abandoned');
        expect(existsSync(f.marker)).toBe(stage === 'finish');
        expect(readFileSync(f.sourceFile)).toEqual(f.sourceBytes);
        expect(f.mutationAdmission.enter(f.workspaceId)).toBeNull();
        f.owned.coreDb.sqlite.exec('DROP TRIGGER refuse_source_report');
        await shutdownControlStoreWorkerClient();
        f.owned.coreDb.sqlite.close();
        const reopened = openCoreDb(f.dataRoot);
        handles.push(reopened);
        expect(readRecoveryAdmission(reopened, f.backupId)).toEqual(failed.core);
      } finally {
        if (f.owned.coreDb.sqlite.open)
          f.owned.coreDb.sqlite.exec('DROP TRIGGER IF EXISTS refuse_source_report');
        f.freeze.release();
      }
    },
    30_000
  );

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
