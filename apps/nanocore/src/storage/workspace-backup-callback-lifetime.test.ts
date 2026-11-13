// openkit-test-platform: posix
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
import { basename, dirname, join, resolve } from 'node:path';
import { setImmediate } from 'node:timers';
import type { Worker, WorkerOptions } from 'node:worker_threads';
import { allocateEntityId } from '@openkit/protocol';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { createDemoStore, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { createTestStore, openTestNativeWorkspace } from '../test-support/store.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import { FileStorageAdmission } from './artifacts/file-admission.js';
import { closeWorkspaceProductReadHandles } from './control-store-product-records.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './control-store-worker-client.js';
import { openCoreDb, openWorkspaceDb } from './db.js';
import { readDataRootLayoutMarker, workspaceDbPath } from './fs-layout.js';
import { createWorkspaceBackup } from './workspace-backup.js';

type Fields = Record<string, unknown>;
type Client = ReturnType<typeof getControlStoreWorkerClient>;
type Result =
  | { ok: true; value: Awaited<ReturnType<typeof createWorkspaceBackup>> }
  | { ok: false; error: unknown };
function object(value: unknown): value is Fields {
  return value !== null && typeof value === 'object';
}
function deferred<T>() {
  let resolveValue!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolveValue = resolve;
  });
  return { promise, resolve: resolveValue };
}
interface Control {
  backupId: string;
  database: string;
  gate?: Int32Array | undefined;
  capture?: Worker;
  request?: Fields;
  reply?: Fields;
  native?: Worker;
  released: boolean;
  reemissions: number;
  stopped: boolean;
  ready: ReturnType<typeof deferred<void>>;
  exit: ReturnType<typeof deferred<number>>;
  termination: ReturnType<typeof deferred<{ actual: Promise<number> }>>;
  frames: Fields[];
}
const hook = vi.hoisted(() => ({ current: undefined as Control | undefined }));

// Only the actual capture fault and selected original terminal reply are intercepted.
// Native Workers, SDK constructors, SQL, close operations and their entry loading are unchanged.
vi.mock('node:worker_threads', async (load) => {
  const actual = await load<typeof import('node:worker_threads')>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      private readonly native: boolean;
      constructor(filename: string | URL, options?: WorkerOptions) {
        const control = hook.current;
        const capture =
          String(filename).includes('workspace-backup-worker') &&
          control &&
          options?.workerData?.input?.backupId === control.backupId;
        if (capture && control.gate) {
          const prelude = `
          const { parentPort, workerData } = require('node:worker_threads');
          const gate = new Int32Array(workerData.__callbackFaultGate);
          delete workerData.__callbackFaultGate;
          const post = parentPort.postMessage.bind(parentPort);
          let offered = false;
          parentPort.postMessage = function(message, ...args) {
            const sent = post(message, ...args);
            if (!offered && message && message.kind === 'phase' && message.phase === 'finish') {
              offered = true;
              while (Atomics.load(gate, 0) === 0) Atomics.wait(gate, 0, 0);
              if (Atomics.load(gate, 0) === 1) {
                Atomics.add(gate, 1, 1);
                const error = new Error('Original finish caught-failure control');
                console.error(error);
                throw error;
              }
            }
            return sent;
          };
        `;
          const entry = options?.eval
            ? String(filename)
            : `import(${JSON.stringify(String(filename))});`;
          super(prelude + entry, {
            ...options,
            eval: true,
            workerData: { ...options?.workerData, __callbackFaultGate: control.gate.buffer },
          });
        } else super(filename, options);
        this.native = String(filename).includes('control-store-worker');
        if (capture) {
          control.capture = this;
          this.once('exit', (code) => control.exit.resolve(code));
        }
      }
      override postMessage(...args: Parameters<Worker['postMessage']>): void {
        super.postMessage(...args);
        const control = hook.current;
        const value = args[0];
        if (
          this.native &&
          control &&
          object(value) &&
          value.operation === 'recovery-capture' &&
          value.database === control.database &&
          object(value.input) &&
          value.input.captureId === control.backupId &&
          value.input.state === 'finished'
        ) {
          control.request = value; // Only AFTER the original post succeeded.
        }
      }
      override emit(event: string | symbol, ...args: unknown[]): boolean {
        const control = hook.current;
        const value = args[0];
        if (event === 'message' && control && object(value)) {
          if (this === control.capture) control.frames.push(value);
          if (
            this.native &&
            control.request &&
            !control.reply &&
            value.id === control.request.id &&
            value.operation === 'recovery-capture'
          ) {
            control.reply = value;
            control.native = this;
            control.ready.resolve(undefined);
            if (control.gate && !control.stopped && !control.released) return true;
          }
        }
        return super.emit(event, ...args);
      }
      override terminate(): Promise<number> {
        const actual = super.terminate();
        if (this === hook.current?.capture) hook.current.termination.resolve({ actual });
        return actual; // Passive observation; the oracle never initiates termination.
      }
    },
  };
});

let namespace: string | undefined;
let namespaceVerified = false;
let base:
  | {
      ownerId: string;
      thread: Awaited<ReturnType<Awaited<ReturnType<typeof createDemoStore>>['createThread']>>;
    }
  | undefined;
let preparationAttempted = false;
let previousPassed = true;
let passed = 0;
let cleanupCurrent: (() => Promise<void>) | undefined;
function retainedNamespace() {
  const uid = process.getuid?.();
  const invocation = tmpdir();
  if (
    uid === undefined ||
    resolve(invocation) !== invocation ||
    !basename(invocation).startsWith('openkit-vitest-')
  )
    throw new Error('UNKNOWN: actual prepared invocation root unavailable; no fallback');
  const parent = dirname(invocation);
  const own = lstatSync(invocation);
  const outer = lstatSync(parent);
  if (
    realpathSync(invocation) !== invocation ||
    realpathSync(parent) !== parent ||
    !own.isDirectory() ||
    !outer.isDirectory() ||
    own.isSymbolicLink() ||
    outer.isSymbolicLink() ||
    own.uid !== uid ||
    (own.mode & 0o7777) !== 0o700 ||
    own.dev !== outer.dev ||
    (outer.uid !== uid && !(outer.uid === 0 && (outer.mode & 0o7777) === 0o1777)) ||
    ((outer.mode & 0o022) !== 0 && (outer.mode & 0o1000) === 0)
  )
    throw new Error('UNKNOWN: prepared root/parent uid, mode or filesystem mismatch');
  namespace = mkdtempSync(join(parent, 'storecore2-q06-callback-retained-'));
  console.log('Callback fixture namespace', namespace); // Recorded BEFORE any producer.
  const made = lstatSync(namespace);
  if (
    realpathSync(namespace) !== namespace ||
    made.isSymbolicLink() ||
    !made.isDirectory() ||
    made.uid !== uid ||
    (made.mode & 0o7777) !== 0o700 ||
    made.dev !== outer.dev
  )
    throw new Error('UNKNOWN: owned sibling identity not established');
  namespaceVerified = true;
  return namespace;
}
function release(control: Control | undefined) {
  if (!control) return;
  control.stopped = true;
  if (control.gate && Atomics.load(control.gate, 0) === 0) {
    Atomics.store(control.gate, 0, 2); // Disarm only the PRIVATE fault gate.
    Atomics.notify(control.gate, 0);
  }
  if (control.released) return;
  control.released = true;
  if (control.gate && control.reply && control.native) {
    control.reemissions++;
    control.native.emit('message', control.reply); // Same original object, not a generated ACK.
  }
}
afterEach(async () => {
  await cleanupCurrent?.();
  cleanupCurrent = undefined;
});
afterAll(() => {
  if (!namespace) return;
  if (namespaceVerified && passed === 2) rmSync(namespace, { recursive: true, force: true });
  else
    console.log(
      'Retain callback fixture namespace and enclosing runtime on UNKNOWN/failure:',
      namespace
    );
});

async function exercise(fault: boolean) {
  if (!previousPassed)
    throw new Error('UNKNOWN: prior fixture was not qualified; no overlapping setup');
  previousPassed = false;
  let stopped = false;
  const pending: Promise<void>[] = [];
  const originalErrors: unknown[] = [];
  const errors: unknown[] = [];
  const active = () => {
    if (stopped) throw new Error('UNKNOWN: setup crossed teardown');
  };
  function start<T>(call: () => T): T {
    active();
    const done = deferred<void>();
    pending.push(done.promise); // Register BEFORE evaluating an original setup call.
    try {
      const returned = call();
      void Promise.resolve(returned).then(
        () => done.resolve(undefined),
        (error) => {
          originalErrors.push(error);
          done.resolve(undefined);
        }
      );
      return returned; // Actual caller still owns the original value/promise.
    } catch (error) {
      originalErrors.push(error);
      done.resolve(undefined);
      throw error;
    }
  }
  let producerCore: ReturnType<typeof openCoreDb> | undefined;
  let core: ReturnType<typeof openCoreDb> | undefined;
  let workspace: ReturnType<typeof openWorkspaceDb> | undefined;
  let client: Client | undefined;
  let control: Control | undefined;
  let terminalDone: Promise<void> | undefined;
  let terminalState: 'not-offered' | 'pending' | 'fulfilled' | 'rejected' = 'not-offered';
  let restore: (() => void) | undefined;
  let outcome: Promise<Result> | undefined;
  let captureState = 'not-started';
  let settlement: { terminalState: string; reemissions: number } | undefined;
  let cleanupPromise: Promise<void> | undefined;
  let decision = false;
  const facts: Fields = { fault };
  const cleanup = () => {
    stopped = true;
    release(control); // Always release/disarm controls BEFORE awaiting original work.
    cleanupPromise ??= (async () => {
      await Promise.all(pending);
      if (outcome) facts.outcome = await outcome;
      if (control?.capture) {
        await control.exit.promise;
        await (await control.termination.promise).actual;
      }
      // The selected successful terminal await has a synchronous remaining finish tail.
      // This observation reaction was attached before returning its original promise to that caller.
      await terminalDone;
      const dispose = async (call: () => unknown) => {
        try {
          await call();
        } catch (error) {
          errors.push(error);
        }
      };
      await dispose(() => closeWorkspaceProductReadHandles());
      await dispose(() => {
        if (workspace?.sqlite.open) workspace.sqlite.close();
      });
      if (client) await dispose(() => client!.shutdown());
      else await dispose(() => shutdownControlStoreWorkerClient()); // Non-creating existing helper.
      for (const db of [producerCore, core])
        await dispose(() => {
          if (db?.sqlite.open) db.sqlite.close();
        });
      restore?.();
      hook.current = undefined;
      facts.request = control?.request;
      facts.reply = control?.reply;
      facts.frames = control?.frames;
      facts.originalErrors = originalErrors;
      facts.errors = errors;
      facts.settlement = settlement;
      facts.terminalState = terminalState;
      facts.faultThrows = control?.gate ? Atomics.load(control.gate, 1) : 0;
      console.log(
        'Callback lifetime facts',
        JSON.stringify(facts, (_key, value) => {
          if (typeof value === 'bigint') return String(value);
          if (value instanceof Error)
            return {
              name: value.name,
              message: value.message,
              stack: value.stack,
              ...(object(value) ? { code: value.code } : {}),
            };
          return value;
        })
      );
    })();
    return cleanupPromise;
  };
  cleanupCurrent = cleanup;
  try {
    if (!namespace) start(retainedNamespace);
    if (!namespaceVerified) throw new Error('UNKNOWN: sibling namespace was not verified');
    const root = start(() => mkdtempSync(join(namespace!, fault ? 'fault-' : 'normal-')));
    const producerRoot = join(namespace!, 'producer');
    const dataRoot = join(root, 'source');
    facts.root = root;
    if (!base) {
      if (preparationAttempted)
        throw new Error('UNKNOWN: failed original preparation is not retried');
      preparationAttempted = true;
      const producer = await start(() => createDemoStore({ dataRoot: producerRoot }));
      producerCore = start(() => openCoreDb(producerRoot));
      const ownerId = start(() => ensureLocalUser(producerCore!));
      start(() =>
        recordWorkspaceOwnerMembership({
          coreDb: producerCore!,
          workspaceId: DEMO_WORKSPACE_ID,
          ownerUserId: ownerId,
        })
      );
      const thread = await start(() =>
        producer.createThread(DEMO_WORKSPACE_ID, 'Callback lifetime owner row')
      );
      expect(start(() => producer.getThread(DEMO_WORKSPACE_ID, thread.id))).toEqual(thread);
      start(() => closeWorkspaceProductReadHandles(producerRoot));
      await start(() => shutdownControlStoreWorkerClient());
      start(() => {
        if (producerCore!.sqlite.open) producerCore!.sqlite.close();
      });
      active();
      base = { ownerId, thread }; // Publish only the fully closed genuine original basis.
    }
    const { ownerId, thread } = base;
    start(() => cpSync(producerRoot, dataRoot, { recursive: true }));
    const store = start(() => createTestStore({ dataRoot }));
    core = start(() => openCoreDb(dataRoot));
    workspace = start(() => openWorkspaceDb(dataRoot, DEMO_WORKSPACE_ID));
    await start(() => openTestNativeWorkspace(workspace!));
    start(() => {
      if (workspace!.sqlite.open) workspace!.sqlite.close();
    });
    expect(start(() => store.getThread(DEMO_WORKSPACE_ID, thread.id))).toEqual(thread);
    client = start(() => getControlStoreWorkerClient());
    const actualClient = client;
    const backupId = allocateEntityId('wsbak');
    const database = `workspace:${workspaceDbPath(dataRoot, DEMO_WORKSPACE_ID)}`;
    control = {
      backupId,
      database,
      gate: fault ? new Int32Array(new SharedArrayBuffer(8)) : undefined,
      released: false,
      reemissions: 0,
      stopped: false,
      ready: deferred<void>(),
      exit: deferred<number>(),
      termination: deferred<{ actual: Promise<number> }>(),
      frames: [],
    };
    hook.current = control;
    const previous = Object.getOwnPropertyDescriptor(actualClient, 'recoveryCapture');
    const original = actualClient.recoveryCapture;
    active();
    Object.defineProperty(actualClient, 'recoveryCapture', {
      configurable: true,
      value: function (this: Client, ...args: Parameters<Client['recoveryCapture']>) {
        if (args[0] !== database || args[1].captureId !== backupId || args[1].state !== 'finished')
          return Reflect.apply(original, this, args);
        const done = deferred<void>(); // BEFORE invoking the actual accepted terminal method.
        terminalDone = done.promise;
        terminalState = 'pending';
        try {
          const actual = Reflect.apply(original, this, args) as Promise<void>;
          void actual.then(
            () => {
              terminalState = 'fulfilled';
              done.resolve(undefined);
            },
            (error) => {
              terminalState = 'rejected';
              originalErrors.push(error);
              done.resolve(undefined);
            }
          );
          return actual;
        } catch (error) {
          terminalState = 'rejected';
          originalErrors.push(error);
          done.resolve(undefined);
          throw error;
        }
      },
    });
    restore = () => {
      if (previous) Object.defineProperty(actualClient, 'recoveryCapture', previous);
      else Reflect.deleteProperty(actualClient, 'recoveryCapture');
    };
    const stagingParent = join(root, 'staging');
    start(() => mkdirSync(stagingParent));
    const admission = start(() => new FileStorageAdmission(root, () => 0n));
    const mutationAdmission = start(() => new WorkspaceMutationAdmission());
    const input: Parameters<typeof createWorkspaceBackup>[0] = {
      source: {
        kind: 'live-workspace',
        dataRoot,
        coreDb: core,
        store,
        mutationAdmission,
        actor: { kind: 'local', userId: ownerId },
      },
      workspaceId: DEMO_WORKSPACE_ID,
      backupId,
      purpose: 'backup',
      expectedSourceDeploymentId: readDataRootLayoutMarker(dataRoot).deploymentId,
      bundleRoot: join(dataRoot, 'server/backups/workspaces', DEMO_WORKSPACE_ID, backupId),
      stagingParent,
      admission,
      expectedRelease: { version: '0.1.0-c-a-oracle', buildId: 'independent-snapshot-oracle' },
      supportedDatabaseFormats: {
        'drizzle.workspace': 26,
        'drizzle.app.1': 1,
        'drizzle.app.2': 2,
        'drizzle.app.3': 3,
        'drizzle.app.4': 4,
        'drizzle.app.5': 5,
        'light-app.kernel.1': 1,
        'light-app.kernel.2': 2,
      },
    };
    const actual = start(() => createWorkspaceBackup(input));
    captureState = 'pending';
    outcome = actual.then<Result, Result>(
      (value) => {
        captureState = 'fulfilled';
        settlement = { terminalState, reemissions: control!.reemissions };
        return { ok: true, value };
      },
      (error: unknown) => {
        captureState = 'rejected';
        settlement = { terminalState, reemissions: control!.reemissions };
        return { ok: false, error };
      }
    );
    if (fault) {
      await Promise.race([
        control.ready.promise,
        outcome.then((result) => {
          if (!result.ok) throw result.error;
          throw new Error('UNKNOWN: capture returned before the real terminal reply was held');
        }),
      ]);
      active();
      expect(control.request).toMatchObject({
        operation: 'recovery-capture',
        database,
        input: { workspaceId: DEMO_WORKSPACE_ID, captureId: backupId, state: 'finished' },
      });
      expect(control.reply).toMatchObject({
        id: control.request?.id,
        operation: 'recovery-capture',
        status: 'ok',
      });
      expect(terminalState).toBe('pending');
      Atomics.store(control.gate!, 0, 1); // Only after the genuine terminal reply was produced/held.
      Atomics.notify(control.gate!, 0);
      await control.exit.promise;
      await (await control.termination.promise).actual;
      await new Promise<void>((resolve) => setImmediate(resolve)); // ONE check-phase barrier, no duration.
      active();
      expect(control.frames.some((frame) => frame.kind === 'failed')).toBe(true);
      expect(Atomics.load(control.gate!, 1)).toBe(1);
      expect(control.reemissions).toBe(0);
      expect(terminalState).toBe('pending');
      expect(
        captureState,
        'An accepted finish callback must still own enclosing capture settlement'
      ).toBe('pending');
      release(control);
    }
    const result = await outcome;
    active();
    expect(control.request).toMatchObject({
      operation: 'recovery-capture',
      database,
      input: { captureId: backupId, state: 'finished' },
    });
    expect(control.reply).toMatchObject({
      id: control.request?.id,
      operation: 'recovery-capture',
      status: 'ok',
    });
    expect(settlement).toEqual({ terminalState: 'fulfilled', reemissions: fault ? 1 : 0 });
    if (!fault) {
      if (!result.ok) throw result.error;
      expect(result.value).toMatchObject({ purpose: 'backup', disposition: 'sealed' });
      expect(existsSync(join(input.bundleRoot, 'seal.json'))).toBe(true);
      expect(control.frames.some((frame) => frame.kind === 'failed')).toBe(false);
    } else {
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('Caught-failure control unexpectedly sealed');
      const failed = control.frames.find((frame) => frame.kind === 'failed');
      expect(failed).toBeDefined();
      expect(result.error).toMatchObject({ code: failed!.code });
    }
    facts.sealExists = existsSync(join(input.bundleRoot, 'seal.json')); // Record effects, never assert seal safety on fault.
    decision = true;
  } catch (error) {
    errors.push(error);
  } finally {
    await cleanup();
  } // Never include this whole body in its own cleanup fence.
  if (errors.length || !decision)
    throw new AggregateError(errors, 'Callback lifetime control did not qualify');
  previousPassed = true;
  passed++;
}

describe('Original capture callback lifetime', () => {
  it('completes a normal original capture through its native terminal acknowledgement', async () => {
    await exercise(false);
  });
  it('keeps a failed capture pending until its accepted original finish callback settles', async () => {
    await exercise(true);
  });
});
