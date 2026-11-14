// openkit-test-platform: posix

// Independent outside-repository draft. UNRUN / not type-qualified.
import { randomUUID } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { setImmediate } from 'node:timers';
import type { Worker, WorkerOptions } from 'node:worker_threads';
import { allocateEntityId } from '@openkit/protocol';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { actorFromRequest, ensureLocalUser, getLocalUserId } from '../auth/identity.js';
import {
  createLightApp,
  createRecord,
  type KernelCommandContext,
} from '../generative-kernel/commands.js';
import { createRemainingKernelOperationImplementations } from '../generative-operations.js';
import { createOperationEngine } from '../operation-invocation.js';
import { createDemoStore, createDemoWorkspaceForUser } from '../test-support/demo-store.js';
import {
  createTestCoreDb,
  createTestStore,
  openTestNativeWorkspace,
} from '../test-support/store.js';
import { publishWorkspaceOwnerMembership } from '../workspace-membership.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import { lightAppDbPath } from './app-db.js';
import { FileStorageAdmission } from './artifacts/file-admission.js';
import { closeWorkspaceProductReadHandles } from './control-store-product-records.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
import { openAdmittedWorkspaceReadDb, openCoreDb, openWorkspaceDb } from './db.js';
import { readDataRootLayoutMarker, workspaceDbPath } from './fs-layout.js';
import { createWorkspaceBackup, WORKSPACE_BACKUP_DATABASE_FORMATS } from './workspace-backup.js';

type Fields = Record<string, unknown>;
type Mode = 'core-pin' | 'copy' | 'enumeration';
function object(value: unknown): value is Fields {
  return value !== null && typeof value === 'object';
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
interface Wire {
  worker: Worker;
  seq: number;
  direction: 'request' | 'reply';
  value: Fields;
  // The ORIGINAL currently outstanding control object, not an invented phase binding.
  control?: Fields | undefined;
}
interface Host {
  worker: Worker;
  role: 'native' | 'capture' | 'other';
  exited: boolean;
  exitSeq?: number | undefined;
  exit: Promise<void>;
}
interface Control {
  mode: Mode;
  backupId: string;
  database: string;
  path: string;
  coreReached: ReturnType<typeof deferred<void>>;
  coreHeld?: { worker: Worker; message: Fields } | undefined;
  coreReleased: boolean;
  coreReemissions: number;
  coreReleaseSeq?: number | undefined;
  gate: Int32Array;
  copyReached: ReturnType<typeof deferred<Fields>>;
  enumerationReached: ReturnType<typeof deferred<void>>;
  nativeReached: ReturnType<typeof deferred<void>>;
  nativeHeld?: { worker: Worker; message: Fields } | undefined;
  nativeReleased: boolean;
  nativeDeliverySeq?: number | undefined;
}
const observation = vi.hoisted(() => ({
  sequence: 0,
  wires: [] as Wire[],
  hosts: [] as Host[],
  reads: [] as { worker: Worker; seq: number; value: Fields }[],
  control: undefined as Control | undefined,
}));

// Native entry/SDK/SQL are unchanged. Only original phase offers, selected native
// replies, and test facts are intercepted. No production signal word is written.
vi.mock('node:worker_threads', async (load) => {
  const actual = await load<typeof import('node:worker_threads')>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      private readonly selectedCapture: boolean;
      private pendingControl: Fields | undefined;
      constructor(filename: string | URL, options?: WorkerOptions) {
        const role = String(filename).includes('workspace-backup-worker')
          ? 'capture'
          : String(filename).includes('control-store-worker')
            ? 'native'
            : 'other';
        const control = observation.control;
        const selected =
          role === 'capture' &&
          !!control &&
          options?.workerData?.input?.backupId === control.backupId;
        if (selected) {
          const prelude = `(() => {
          const fs = require('node:fs');
          const path = require('node:path');
          const { syncBuiltinESMExports } = require('node:module');
          const threads = require('node:worker_threads');
          const { parentPort, workerData } = threads;
          const privateGate = new Int32Array(workerData.__q03CopyGate);
          const selectedPath = workerData.__q03CopyPath;
          const holdCopy = workerData.__q03HoldCopy;
          delete workerData.__q03CopyGate;
          delete workerData.__q03CopyPath;
          delete workerData.__q03HoldCopy;
          const root = path.join(workerData.input.dataRoot, 'workspaces', workerData.input.workspaceId);
          const readdir = fs.readdirSync;
          const receive = threads.receiveMessageOnPort;
          const post = parentPort.postMessage.bind(parentPort);
          let enumerating = false;
          let pending;
          let paused = false;
          fs.readdirSync = function(directory, ...args) {
            const result = Reflect.apply(readdir, this, [directory, ...args]);
            if (enumerating && typeof directory === 'string'
              && (directory === root || directory.startsWith(root + path.sep)))
              post({ __q03Fact: 'enumeration-read', root, directory,
                names: result.map(entry => typeof entry === 'string' ? entry
                  : Buffer.isBuffer(entry) ? entry.toString() : entry.name) });
            return result;
          };
          parentPort.postMessage = function(message, ...args) {
            if (message && typeof message === 'object') {
              pending = message;
              if (message.kind === 'phase' && message.phase === 'enumeration') enumerating = true;
              if (message.kind === 'phase' && message.phase === 'pin') enumerating = false;
            }
            return post(message, ...args);
          };
          threads.receiveMessageOnPort = function(port, ...args) {
            const original = Reflect.apply(receive, this, [port, ...args]);
            if (port === parentPort && original) {
              const phase = pending;
              pending = undefined;
              if (holdCopy && !paused && phase && phase.kind === 'phase'
                && phase.phase === 'db-backup' && phase.path === selectedPath
                && original.message && original.message.ok === true) {
                paused = true;
                // Original reply has really been consumed ONCE; Main already notified.
                // Pause BEFORE returning that SAME result to original control()/SQLite.
                post({ __q03Fact: 'copy-window-held', path: phase.path,
                  phase, reply: original.message });
                while (Atomics.load(privateGate, 0) === 0) Atomics.wait(privateGate, 0, 0);
              }
            }
            return original;
          };
          syncBuiltinESMExports();
        })();\n`;
          const entry = options?.eval
            ? String(filename)
            : `import(${JSON.stringify(String(filename))});`;
          super(prelude + entry, {
            ...options,
            eval: true,
            workerData: {
              ...options?.workerData,
              __q03CopyGate: control.gate.buffer,
              __q03CopyPath: control.path,
              __q03HoldCopy: control.mode === 'copy',
            },
          });
        } else super(filename, options);
        this.selectedCapture = selected;
        const exited = deferred<void>();
        const host: Host = { worker: this, role, exited: false, exit: exited.promise };
        observation.hosts.push(host);
        this.once('exit', () => {
          host.exited = true;
          host.exitSeq = ++observation.sequence;
          exited.resolve(undefined);
        });
      }
      override postMessage(...args: Parameters<Worker['postMessage']>): void {
        const control = this.pendingControl;
        super.postMessage(...args);
        if (object(args[0]))
          observation.wires.push({
            worker: this,
            seq: ++observation.sequence,
            direction: 'request',
            value: args[0],
            control,
          });
        this.pendingControl = undefined;
      }
      override emit(event: string | symbol, ...args: unknown[]): boolean {
        const message = args[0];
        if (event === 'message' && object(message)) {
          const control = observation.control;
          if (this.selectedCapture && message.__q03Fact === 'enumeration-read') {
            observation.reads.push({ worker: this, seq: ++observation.sequence, value: message });
            return true;
          }
          if (this.selectedCapture && message.__q03Fact === 'copy-window-held') {
            ++observation.sequence;
            control?.copyReached.resolve(message);
            return true;
          }
          const replay =
            (control?.coreReleased &&
              control.coreHeld?.worker === this &&
              control.coreHeld.message === message) ||
            (control?.nativeReleased &&
              control.nativeHeld?.worker === this &&
              control.nativeHeld.message === message);
          if (!replay)
            observation.wires.push({
              worker: this,
              seq: ++observation.sequence,
              direction: 'reply',
              value: message,
            });
          if (this.selectedCapture && message.kind !== 'done' && message.kind !== 'failed') {
            this.pendingControl = message;
            if (message.kind === 'phase' && message.phase === 'enumeration')
              control?.enumerationReached.resolve(undefined);
            if (
              control &&
              !control.coreReleased &&
              !control.coreHeld &&
              message.kind === 'phase' &&
              message.phase === 'core-pin'
            ) {
              control.coreHeld = { worker: this, message };
              control.coreReached.resolve(undefined);
              return true;
            }
          }
          if (
            !this.selectedCapture &&
            control?.mode === 'enumeration' &&
            !control.nativeReleased &&
            message.operation === 'open' &&
            message.status === 'ok'
          ) {
            const offered = observation.wires.findLast(
              (wire) =>
                wire.worker === this &&
                wire.direction === 'request' &&
                wire.value.id === message.id &&
                wire.value.operation === 'open' &&
                wire.value.database === control.database
            );
            if (offered && !control.nativeHeld) {
              control.nativeHeld = { worker: this, message };
              control.nativeReached.resolve(undefined);
              return true;
            }
          }
        }
        return super.emit(event, ...args);
      }
    },
  };
});
function releaseCore(control: Control | undefined) {
  if (!control || control.coreReleased) return;
  control.coreReleased = true;
  control.coreReleaseSeq = ++observation.sequence;
  if (control.coreHeld) {
    control.coreReemissions++;
    control.coreHeld.worker.emit('message', control.coreHeld.message);
  }
}
function releaseNative(control: Control | undefined) {
  if (!control || control.nativeReleased) return;
  control.nativeReleased = true;
  control.nativeDeliverySeq = ++observation.sequence;
  if (control.nativeHeld) control.nativeHeld.worker.emit('message', control.nativeHeld.message);
}
function releaseCopy(control: Control | undefined) {
  if (!control) return;
  Atomics.store(control.gate, 0, 1); // ONLY the separately owned test gate.
  Atomics.notify(control.gate, 0);
}
function disarm(control: Control | undefined) {
  if (!control) return;
  releaseCopy(control);
  releaseNative(control);
  releaseCore(control);
}
function requests(database: string, operation: string) {
  return observation.wires.filter(
    (wire) =>
      wire.direction === 'request' &&
      wire.value.database === database &&
      wire.value.operation === operation
  );
}
function successful(request: Wire): Wire {
  const reply = observation.wires.find(
    (wire) =>
      wire.worker === request.worker &&
      wire.direction === 'reply' &&
      wire.seq > request.seq &&
      wire.value.id === request.value.id &&
      wire.value.operation === request.value.operation
  );
  if (!reply) throw new Error(`UNKNOWN: original ${String(request.value.operation)} reply missing`);
  expect(reply.value.status, 'Original native reply, never an oracle ACK').toBe('ok');
  return reply;
}
function identity(path: string) {
  const stat = lstatSync(path);
  expect(stat.isFile() && !stat.isSymbolicLink()).toBe(true);
  return { dev: stat.dev, ino: stat.ino };
}
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
const releasePolicy = { version: '0.1.0-c-a-oracle', buildId: 'independent-snapshot-oracle' };
const formats = WORKSPACE_BACKUP_DATABASE_FORMATS;
type Produced = {
  app: Awaited<ReturnType<typeof createLightApp>>;
  row: Awaited<ReturnType<typeof createRecord>>;
};
let basis:
  | { root: string; ownerId: string; workspaceId: string; selected: Produced; other: Produced }
  | undefined;
let preparationAttempted = false;
let namespace: string | undefined;
let namespaceIdentity: { dev: number; ino: number } | undefined;
let completed = 0;
let previousSettled = true;
let cleanupCurrent: (() => Promise<void>) | undefined;
function retainedNamespace() {
  const privateRoot = tmpdir();
  const parent = dirname(privateRoot);
  const uid = process.getuid?.();
  const own = lstatSync(privateRoot);
  const outer = lstatSync(parent);
  if (
    uid === undefined ||
    !basename(privateRoot).startsWith('openkit-vitest-') ||
    realpathSync(privateRoot) !== privateRoot ||
    realpathSync(parent) !== parent ||
    !own.isDirectory() ||
    own.isSymbolicLink() ||
    own.uid !== uid ||
    !outer.isDirectory() ||
    outer.isSymbolicLink() ||
    own.dev !== outer.dev
  )
    throw new Error('UNKNOWN: prepared private-root sibling premise is not established');
  namespace = mkdtempSync(join(parent, 'q03-b-enrollment-'));
  const made = lstatSync(namespace);
  if (
    !made.isDirectory() ||
    made.isSymbolicLink() ||
    made.uid !== uid ||
    (made.mode & 0o7777) !== 0o700 ||
    made.dev !== outer.dev
  )
    throw new Error('UNKNOWN: retain unverified namespace; no producer may start');
  namespaceIdentity = { dev: made.dev, ino: made.ino };
  return namespace;
}
afterEach(async () => {
  await cleanupCurrent?.();
});
afterAll(() => {
  if (!namespace) return;
  const current = lstatSync(namespace);
  if (
    completed === 3 &&
    previousSettled &&
    namespaceIdentity &&
    current.dev === namespaceIdentity.dev &&
    current.ino === namespaceIdentity.ino &&
    !current.isSymbolicLink()
  )
    rmSync(namespace, { recursive: true, force: true });
  else
    console.log(
      'Retain Q03 namespace AND enclosing runtime/filesystem on failure or UNKNOWN:',
      namespace
    );
});

async function exercise(mode: Mode) {
  if (!previousSettled)
    throw new Error('UNKNOWN: prior original lifecycle unresolved; no next setup');
  previousSettled = false;
  let stopped = false;
  const pending: Promise<void>[] = [];
  const errors: unknown[] = [];
  const originalErrors: unknown[] = [];
  const facts: Fields = { mode };
  const active = () => {
    if (stopped) throw new Error('UNKNOWN: setup crossed original teardown');
  };
  function start<T>(call: () => T): T {
    active();
    const settled = deferred<void>();
    pending.push(settled.promise); // Register BEFORE any original call.
    try {
      const returned = call();
      void Promise.resolve(returned).then(
        () => settled.resolve(undefined),
        (error) => {
          originalErrors.push(error);
          settled.resolve(undefined);
        }
      );
      return returned;
    } catch (error) {
      originalErrors.push(error);
      settled.resolve(undefined);
      throw error;
    }
  }
  const check = (call: () => void) => {
    try {
      call();
    } catch (error) {
      errors.push(error);
    }
  };
  let producerCore: ReturnType<typeof openCoreDb> | undefined;
  let core: ReturnType<typeof openCoreDb> | undefined;
  let workspace: ReturnType<typeof openWorkspaceDb> | undefined;
  let control: Control | undefined;
  let capture: Promise<Awaited<ReturnType<typeof createWorkspaceBackup>>> | undefined;
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = () => {
    stopped = true;
    disarm(control); // ALL test holds first, including ones whose fact/ACK arrives late.
    cleanupPromise ??= (async () => {
      await Promise.all(pending);
      let disposalFailed = false;
      const dispose = async (call: () => unknown) => {
        try {
          await call();
        } catch (error) {
          disposalFailed = true;
          errors.push(error);
        }
      };
      await dispose(() => closeWorkspaceProductReadHandles());
      await dispose(() => {
        if (workspace?.sqlite.open) workspace.sqlite.close();
      });
      await dispose(() => shutdownControlStoreWorkerClient()); // Non-creating original helper.
      for (const db of [producerCore, core])
        await dispose(() => {
          if (db?.sqlite.open) db.sqlite.close();
        });
      const hosts = observation.hosts.slice();
      await Promise.all(hosts.map((host) => host.exit));
      if (observation.hosts.length !== hosts.length) {
        disposalFailed = true;
        errors.push(new Error('UNKNOWN: late original Worker generation'));
      }
      previousSettled = !disposalFailed;
    })();
    return cleanupPromise;
  };
  cleanupCurrent = cleanup;
  let selectedPath: string | undefined;
  let otherPath: string | undefined;
  let selectedDatabase: string | undefined;
  let otherDatabase: string | undefined;
  let readAttempted = false;
  let otherReadAttempted = false;
  let caseWireStart = observation.wires.length;
  try {
    const root = namespaceIdentity ? namespace! : start(retainedNamespace);
    if (!basis) {
      if (preparationAttempted) throw new Error('UNKNOWN: failed original basis is not retried');
      preparationAttempted = true;
      const producerRoot = join(root, 'producer');
      producerCore = start(() => createTestCoreDb(producerRoot));
      const ownerId = await start(() => ensureLocalUser(producerCore!));
      const workspaceId = createDemoWorkspaceForUser(ownerId).workspace.id;
      const producer = await start(() => createDemoStore({ dataRoot: producerRoot }, ownerId));
      await start(() =>
        publishWorkspaceOwnerMembership({
          coreDb: producerCore!,
          workspaceId,
          ownerUserId: ownerId,
        })
      );
      const command: KernelCommandContext = {
        store: producer,
        dataRoot: producerRoot,
        workspaceId,
        actor: { kind: 'user', id: ownerId },
        requestId: randomUUID(),
        inflightCommands: new WeakMap(),
      };
      const produce = async (title: string, value: string): Promise<Produced> => {
        const app = await start(() =>
          createLightApp(
            { ...command, requestId: randomUUID() },
            {
              format: 'openkit.light-app',
              schemaVersion: 1,
              title,
              purpose: 'Owner-published cold App control.',
              collections: [
                {
                  name: 'facts',
                  type: 'base',
                  description: 'Original owner row.',
                  fields: [
                    { name: 'value', type: 'text', required: true, description: 'Authored value.' },
                  ],
                  indexes: [],
                },
              ],
            }
          )
        );
        const row = await start(() =>
          createRecord(
            { ...command, requestId: randomUUID() },
            app.appId,
            'facts',
            app.schemaRevision,
            { value }
          )
        );
        const database = 'app:' + lightAppDbPath(producerRoot, workspaceId, app.appId);
        for (const kind of ['create', 'record-create']) {
          const offered = requests(database, 'app-kernel').filter(
            (wire) => object(wire.value.input) && wire.value.input.kind === kind
          );
          expect(offered).toHaveLength(1);
          successful(offered[0]!); // Genuine native durable-command ACK.
        }
        return { app, row };
      };
      const selected = await produce('Selected cold App', 'exact original selected row');
      const other = await produce('Other cold App', 'exact original other row');
      start(() => closeWorkspaceProductReadHandles(producerRoot));
      await start(() => shutdownControlStoreWorkerClient());
      start(() => producerCore!.sqlite.close());
      await start(() => Promise.all(observation.hosts.map((host) => host.exit)));
      expect(observation.hosts.every((host) => host.exited)).toBe(true);
      for (const { app } of [selected, other]) {
        const path = lightAppDbPath(producerRoot, workspaceId, app.appId);
        expect(existsSync(path)).toBe(true);
        expect(existsSync(path + '-wal')).toBe(false);
        expect(existsSync(path + '-shm')).toBe(false);
      }
      active();
      basis = { root: producerRoot, ownerId, workspaceId, selected, other };
    }
    const { ownerId, workspaceId, selected, other } = basis;
    facts.producerReturns = { selected, other, ownerId, workspaceId };
    const dataRoot = join(root, mode);
    start(() => cpSync(basis!.root, dataRoot, { recursive: true })); // Same closed basis; no re-authoring.
    caseWireStart = observation.wires.length;
    selectedPath = lightAppDbPath(dataRoot, workspaceId, selected.app.appId);
    otherPath = lightAppDbPath(dataRoot, workspaceId, other.app.appId);
    selectedDatabase = 'app:' + selectedPath;
    otherDatabase = 'app:' + otherPath;
    const selectedIdentity = identity(selectedPath);
    const otherIdentity = identity(otherPath);
    const store = start(() => createTestStore({ dataRoot }));
    core = start(() => openCoreDb(dataRoot));
    workspace = start(() => openWorkspaceDb(dataRoot, workspaceId));
    await start(() => openTestNativeWorkspace(workspace!));
    start(() => workspace!.sqlite.close());
    const parentOpen = requests('workspace:' + workspaceDbPath(dataRoot, workspaceId), 'open');
    expect(parentOpen).toHaveLength(1);
    successful(parentOpen[0]!);
    const admission = new WorkspaceMutationAdmission();
    const dependencies = {
      coreDb: core,
      store,
      inflightCommands: new WeakMap(),
      repositoryWorkspaceDb: (id: string) => openAdmittedWorkspaceReadDb(dataRoot, id),
    };
    const implementation = createRemainingKernelOperationImplementations(dependencies);
    const invoke = createOperationEngine(
      { 'kernel.records.get': implementation['kernel.records.get'] },
      {
        coreDb: core,
        store,
        dataRoot,
        workspaceMutationAdmission: admission,
        repositoryWorkspaceDb: dependencies.repositoryWorkspaceDb,
      }
    );
    const actor = actorFromRequest(new Request('http://localhost/'), 'local', getLocalUserId(core));
    expect(actor.userId).toBe(ownerId);
    let readState = 'not-started';
    let otherState = 'not-started';
    const read = (which: Produced, second = false) => {
      if (second) {
        otherReadAttempted = true;
        otherState = 'pending';
      } else {
        readAttempted = true;
        readState = 'pending';
      }
      const original = start(() =>
        invoke(
          'kernel.records.get',
          {
            workspaceId,
            appId: which.app.appId,
            collection: 'facts',
            recordId: which.row.id,
            schemaRevision: which.app.schemaRevision,
          },
          { kind: 'public', actor, delivery: 'human' }
        )
      );
      // Observe, but return the SAME original operation promise.
      void original.then(
        () => {
          if (second) otherState = 'fulfilled';
          else readState = 'fulfilled';
        },
        () => {
          if (second) otherState = 'rejected';
          else readState = 'rejected';
        }
      );
      return original;
    };
    const stagingParent = join(root, mode + '-staging');
    start(() => mkdirSync(stagingParent));
    const backupId = allocateEntityId('wsbak');
    control = {
      mode,
      backupId,
      database: selectedDatabase,
      path: selectedPath,
      coreReached: deferred<void>(),
      coreReleased: false,
      coreReemissions: 0,
      gate: new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)),
      copyReached: deferred<Fields>(),
      enumerationReached: deferred<void>(),
      nativeReached: deferred<void>(),
      nativeReleased: false,
    };
    observation.control = control;
    capture = start(() =>
      createWorkspaceBackup({
        source: {
          kind: 'live-workspace',
          dataRoot,
          coreDb: core!,
          store,
          mutationAdmission: admission,
          actor,
        },
        workspaceId,
        backupId,
        purpose: 'backup',
        expectedSourceDeploymentId: readDataRootLayoutMarker(dataRoot).deploymentId,
        bundleRoot: join(dataRoot, 'server', 'backups', 'workspaces', workspaceId, backupId),
        stagingParent,
        admission: new FileStorageAdmission(root, () => 0n),
        expectedRelease: releasePolicy,
        supportedDatabaseFormats: formats,
      })
    );
    void capture.then(
      (result) => {
        facts.capture = result;
      },
      (error) => {
        facts.captureError = error;
      }
    );
    // Every required hold races actual capture settlement, not an elapsed-time grace.
    const beforeCaptureEnds = <T>(event: Promise<T>, contract: string) =>
      Promise.race([
        event,
        capture!.then((result) => {
          facts.completedBeforeRequiredHold = result;
          throw new Error(
            'Required original capture contract missing/completed before hold: ' + contract
          );
        }),
      ]);
    await beforeCaptureEnds(control.coreReached.promise, 'core-pin');
    active();
    const captureWorker = control.coreHeld!.worker;
    const phases = () =>
      observation.wires.filter(
        (wire) =>
          wire.worker === captureWorker && wire.direction === 'reply' && wire.value.kind === 'phase'
      );
    const phaseReplies = (name: string) =>
      observation.wires.filter(
        (wire) =>
          wire.worker === captureWorker &&
          wire.direction === 'request' &&
          wire.control?.kind === 'phase' &&
          wire.control.phase === name
      );
    const walks = () => observation.reads.filter((row) => row.worker === captureWorker);
    const prefix = phases().map((wire) => wire.value.phase);
    expect(prefix.indexOf('freeze')).toBeGreaterThanOrEqual(0);
    expect(prefix.indexOf('drain')).toBeGreaterThan(prefix.indexOf('freeze'));
    expect(prefix.indexOf('core-pin')).toBeGreaterThan(prefix.indexOf('drain'));
    expect(
      requests(selectedDatabase, 'open'),
      'Selected App genuinely cold at held core-pin'
    ).toEqual([]);
    expect(requests(otherDatabase, 'open'), 'Other App genuinely cold at held core-pin').toEqual(
      []
    );
    const readStart = ++observation.sequence;
    if (mode === 'core-pin') {
      const row = await read(selected);
      active();
      facts.read = { row, whileCorePinHeld: !control.coreReleased };
      expect(row).toEqual(selected.row);
      expect(control.coreReleased).toBe(false);
      expect(phases().some((wire) => wire.value.phase === 'enumeration')).toBe(false);
      const opens = requests(selectedDatabase, 'open');
      expect(opens, 'Async read must itself enroll the cold App').toHaveLength(1);
      expect(successful(opens[0]!).seq).toBeGreaterThan(readStart);
      expect(observation.hosts.find((host) => host.worker === opens[0]!.worker)?.exited).toBe(
        false
      );
      expect(opens[0]!.worker.threadId).toBeGreaterThan(0);
      releaseCore(control);
    } else if (mode === 'copy') {
      releaseCore(control);
      const held = await beforeCaptureEnds(
        control.copyReached.promise,
        'path-bearing db-backup + consumed original ok reply'
      );
      active();
      facts.copyWindowHeld = held;
      expect(held).toMatchObject({
        path: selectedPath,
        phase: { kind: 'phase', phase: 'db-backup', path: selectedPath },
        reply: { ok: true },
      });
      expect(Atomics.load(control.gate, 0)).toBe(0);
      const begin = phases().find(
        (wire) => wire.value.phase === 'db-backup' && wire.value.path === selectedPath
      )!;
      expect(begin).toBeDefined();
      const accepted = phaseReplies('db-backup').find((wire) => wire.control === begin.value);
      expect(accepted?.value.ok).toBe(true);
      const original = read(selected);
      await turn(); // ONE check-phase turn; no deadline/grace or fabricated phase.
      active();
      facts.copyPending = {
        readState,
        opens: requests(selectedDatabase, 'open').map((wire) => wire.value),
      };
      check(() => {
        expect(readState).toBe('pending');
        expect(
          requests(selectedDatabase!, 'open'),
          'No OPEN while same-App copy window is owned'
        ).toEqual([]);
        expect(
          phases().some((wire) => wire.seq > begin.seq && wire.value.phase === 'mutable-copy')
        ).toBe(false);
      });
      releaseCopy(control);
      const row = await original;
      active();
      facts.read = { row };
      expect(row).toEqual(selected.row);
      const end = phases().find(
        (wire) => wire.seq > begin.seq && wire.value.phase === 'mutable-copy'
      );
      expect(end, 'Real post-RO-close mutable-copy end phase').toBeDefined();
      expect(end!.value.path, 'Original path-bearing copy end, never a guessed path').toBe(
        selectedPath
      );
      const opens = requests(selectedDatabase, 'open');
      expect(opens).toHaveLength(1);
      expect(opens[0]!.seq).toBeGreaterThan(end!.seq);
      expect(successful(opens[0]!).seq).toBeGreaterThan(opens[0]!.seq);
      facts.copyEnd = end!.value;
    } else {
      const original = read(selected);
      await Promise.race([
        control.nativeReached.promise,
        original.then(() => {
          throw new Error('Original async read settled without required held native OPEN reply');
        }),
      ]);
      active();
      expect(control.nativeHeld?.message.status).toBe('ok');
      expect(readState).toBe('pending');
      releaseCore(control); // Distinct scenario: ACK remains held while capture progresses.
      await beforeCaptureEnds(
        control.enumerationReached.promise,
        'enumeration offered while enrolled OPEN awaits ACK'
      );
      active();
      // A SECOND cold App probes enumerating-before-await, not just a one-time join.
      const second = read(other, true);
      await turn();
      active();
      facts.enumerationPending = {
        readState,
        otherState,
        replies: phaseReplies('enumeration').map((wire) => wire.value),
        reads: walks().map((row) => row.value),
      };
      check(() => {
        expect(readState).toBe('pending');
        expect(otherState).toBe('pending');
        expect(
          phaseReplies('enumeration'),
          'No enumeration ACK until accepted OPEN settles'
        ).toEqual([]);
        expect(walks(), 'Actual readdir must not run behind pending enrollment').toEqual([]);
        expect(
          requests(otherDatabase!, 'open'),
          'Enumeration fence also excludes newly arriving cold OPEN'
        ).toEqual([]);
      });
      releaseNative(control);
      const row = await original;
      active();
      expect(row).toEqual(selected.row);
      const secondRow = await second;
      active();
      expect(secondRow).toEqual(other.row);
      facts.read = { row, secondRow };
      const replied = phaseReplies('enumeration');
      expect(replied).toHaveLength(1);
      expect(replied[0]!.value.ok).toBe(true);
      expect(replied[0]!.seq).toBeGreaterThan(control.nativeDeliverySeq!);
      const pin = phases().find((wire) => wire.value.phase === 'pin');
      expect(pin).toBeDefined();
      const secondOpen = requests(otherDatabase, 'open');
      expect(secondOpen).toHaveLength(1);
      expect(secondOpen[0]!.seq).toBeGreaterThan(pin!.seq);
      facts.heldOriginalNativeReply = control.nativeHeld!.message;
    }
    const captured = await capture;
    active();
    facts.capture = captured;
    expect(captured.disposition).toBe('sealed');
    for (const [path, database, originalIdentity, produced] of [
      [selectedPath, selectedDatabase, selectedIdentity, selected],
      ...(otherReadAttempted ? [[otherPath, otherDatabase, otherIdentity, other] as const] : []),
    ] as const) {
      const opens = requests(database, 'open');
      expect(opens).toHaveLength(1);
      expect(opens[0]!.value).toMatchObject({
        create: false,
        path,
        dataRoot,
        physicalScope: { kind: 'app', workspaceId, appId: produced.app.appId },
      });
      successful(opens[0]!);
      expect(identity(path)).toEqual(originalIdentity);
      expect(observation.hosts.find((host) => host.worker === opens[0]!.worker)?.role).toBe(
        'native'
      );
      // For the queued second App too, use ONLY actual path-bearing begin/end pairs.
      const intervals = phases().filter(
        (wire) => wire.value.phase === 'db-backup' && wire.value.path === path
      );
      expect(
        intervals,
        'Real per-App copy path must be present; never guessed on OLD'
      ).toHaveLength(1);
      const end = phases().find(
        (wire) => wire.seq > intervals[0]!.seq && wire.value.phase === 'mutable-copy'
      );
      expect(end).toBeDefined();
      expect(end!.value.path, 'Original path-bearing post-RO-close end').toBe(path);
      const accepted = phaseReplies('db-backup').find(
        (wire) => wire.control === intervals[0]!.value
      );
      expect(accepted?.value.ok).toBe(true);
      const ack = successful(opens[0]!);
      // An OPEN already in flight at the phase OFFER may correctly be joined.
      // Actual copy cannot start until Main's original successful phase REPLY.
      expect(
        ack.seq < accepted!.seq || opens[0]!.seq > end!.seq,
        'Entire original OPEN request/reply interval excludes same-App backup'
      ).toBe(true);
    }
    const enumerationReply = phaseReplies('enumeration');
    expect(enumerationReply).toHaveLength(1);
    expect(enumerationReply[0]!.value.ok).toBe(true);
    const pin = phases().find((wire) => wire.value.phase === 'pin');
    expect(pin).toBeDefined();
    for (const entry of walks()) {
      expect(entry.seq).toBeGreaterThan(enumerationReply[0]!.seq);
      expect(entry.seq).toBeLessThan(pin!.seq);
    }
    const actualReads = walks().map((row) => row.value);
    expect(actualReads.length).toBeGreaterThan(0);
    for (const path of [selectedPath, otherPath])
      expect(
        actualReads.some(
          (entry) =>
            entry.directory === dirname(path) &&
            Array.isArray(entry.names) &&
            entry.names.includes('data.sqlite')
        )
      ).toBe(true);
    expect(
      actualReads
        .flatMap((entry) => entry.names as string[])
        .filter((name) => name.startsWith('.app-open-inspection-'))
    ).toEqual([]);
    expect(
      captured.manifest.inventory.some((entry) =>
        entry.path.split('/').some((name) => name.startsWith('.app-open-inspection-'))
      )
    ).toBe(false);
    facts.actualEnumeration = actualReads;
    facts.originalPhases = phases().map((wire) => wire.value);
  } catch (error) {
    errors.push(error);
  } finally {
    await cleanup();
    for (const [path, database, wasRead] of [
      [selectedPath, selectedDatabase, readAttempted],
      [otherPath, otherDatabase, otherReadAttempted],
    ] as const) {
      if (!path || !database) continue;
      facts[path] = { wasRead, wal: existsSync(path + '-wal'), shm: existsSync(path + '-shm') };
      check(() => {
        if (!wasRead) {
          expect(
            requests(database, 'open'),
            'Unread App gets NO native OPEN; its capture-only SHM is NOT Q03 failure'
          ).toEqual([]);
          return;
        }
        const opens = requests(database, 'open');
        expect(opens).toHaveLength(1);
        const openAck = successful(opens[0]!);
        // Original shutdown closes all resident databases; it sends no per-App close RPC.
        const shutdowns = observation.wires.filter(
          (wire) =>
            wire.worker === opens[0]!.worker &&
            wire.direction === 'request' &&
            wire.value.operation === 'shutdown'
        );
        expect(shutdowns, 'Original shutdown request on the SAME native Worker').toHaveLength(1);
        expect(shutdowns[0]!.seq).toBeGreaterThan(openAck.seq);
        const shutdownAck = successful(shutdowns[0]!);
        expect(shutdownAck.seq).toBeGreaterThan(shutdowns[0]!.seq);
        const native = observation.hosts.find((host) => host.worker === opens[0]!.worker);
        expect(native?.role).toBe('native');
        expect(native?.exited).toBe(true);
        expect(
          native?.exitSeq,
          'Actual native exit AFTER its original successful shutdown ACK'
        ).toBeGreaterThan(shutdownAck.seq);
        expect(existsSync(path + '-wal'), 'Read App after original native RW last-close').toBe(
          false
        );
        expect(existsSync(path + '-shm'), 'Read App after original native RW last-close').toBe(
          false
        );
      });
    }
    facts.wires = observation.wires.slice(caseWireStart).map((wire) => ({
      seq: wire.seq,
      direction: wire.direction,
      value: wire.value,
      control: wire.control,
      role: observation.hosts.find((host) => host.worker === wire.worker)?.role,
    }));
    facts.originalErrors = originalErrors;
    facts.errors = errors;
    facts.originalCorePinReemissions = control?.coreReemissions;
    console.log(
      'Q03 B-amended original facts',
      JSON.stringify(facts, (_key, value) =>
        value instanceof Error
          ? {
              name: value.name,
              message: value.message,
              stack: value.stack,
              ...(object(value) ? { code: value.code, status: value.status } : {}),
            }
          : typeof value === 'bigint'
            ? String(value)
            : value
      )
    );
  }
  if (errors.length)
    throw new AggregateError(errors, 'Original Q03 enrollment/hold-lifetime observations failed');
  completed++;
}
describe('B-amended cold App read capture enrollment', () => {
  it('returns the exact row while core-pin stays held, opens only the read cold App, and retires without sidecars', () =>
    exercise('core-pin'));
  it('keeps a same-App cold read pending through the accepted original DB-copy window', () =>
    exercise('copy'));
  it('fences enumeration and a newly arriving cold OPEN until the accepted original OPEN settles', () =>
    exercise('enumeration'));
});
