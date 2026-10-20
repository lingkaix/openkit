import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { isMainThread, Worker } from 'node:worker_threads';
import type { ControlCheckpoint } from './control-store.js';
import type { ControlAdmission, ControlAdmissionResult } from './control-store-admission.js';
import type { ControlProductTransition } from './control-store-products.js';
import {
  CONTROL_WORKER_LIMITS,
  CONTROL_WORKER_VERSION,
  type ControlSqlResult,
  type ControlSqlStatement,
  type ControlWorkerCommand,
  type ControlWorkerFailureCode,
  type ControlWorkerReply,
  type ControlWorkerRequest,
  isControlWorkerReply,
  isControlWorkerRequest,
} from './control-store-worker-protocol.js';

/** A refusal or uncertain result, never a substitute for the original SQL command receipt. */
export class ControlStoreWorkerError extends Error {
  /** Creates a redacted failure; unknown results require original-request inspection. */
  constructor(
    readonly code: ControlWorkerFailureCode,
    readonly commit: 'not-committed' | 'unknown'
  ) {
    super('Control database writer operation failed.');
    this.name = 'ControlStoreWorkerError';
  }
}

type Success = Extract<ControlWorkerReply, { status: 'ok' }>;
type OpenCommand = Extract<ControlWorkerCommand, { operation: 'open' }>;

/** One finite in-flight message, not persisted work or an execution attempt. */
interface Pending {
  readonly command: ControlWorkerCommand;
  readonly resolve: (reply: Success) => void;
  readonly reject: (error: ControlStoreWorkerError) => void;
}

let singleton: ControlStoreWorkerClient | undefined;

/**
 * Returns the one process-local writer host, without opening a database.
 *
 * A failed host is never restarted by this getter. Explicit shutdown must finish before a later call can start a new host; no request is replayed. This component remains unused by ordinary product callers until the scope's factory/write closure is switched. Do not activate a product writer until every producer and shared receipt path observes the accepted family boundary; a legacy main writable handle is not a table-level access-control boundary.
 *
 * @returns Shared host for admitted database scopes, never a synchronous SQL facade.
 */
export function getControlStoreWorkerClient(): ControlStoreWorkerClient {
  if (!isMainThread) throw new ControlStoreWorkerError('unavailable', 'not-committed');
  if (singleton === undefined || singleton.isClosed) singleton = new ControlStoreWorkerClient();
  return singleton;
}

/** Owns the worker lifetime, finite pre-post admission and asynchronous acknowledgements. */
class ControlStoreWorkerClient {
  private readonly worker: Worker;
  private readonly pending = new Map<number, Pending>();
  private readonly outstanding = new Map<string, number>();
  private readonly openings = new Map<
    string,
    { readonly command: Omit<OpenCommand, 'operation'>; readonly promise: Promise<void> }
  >();
  private nextId = 0;
  private failed = false;
  private stopping = false;
  private closed = false;
  private shutdownPromise: Promise<void> | undefined;

  /** Starts the real compiled entry, or the existing TypeScript loader in development. */
  constructor() {
    if (import.meta.url.endsWith('.ts')) {
      const require = createRequire(import.meta.url);
      const loader = pathToFileURL(require.resolve('tsx/esm/api')).href;
      const entry = new URL('./control-store-worker.ts', import.meta.url).href;
      this.worker = new Worker(
        `import(${JSON.stringify(loader)}).then(({tsImport}) => tsImport(${JSON.stringify(entry)}, ${JSON.stringify(import.meta.url)}));`,
        { eval: true }
      );
    } else {
      this.worker = new Worker(new URL('./control-store-worker.js', import.meta.url));
    }
    this.worker.on('message', (value: unknown) => this.receive(value));
    this.worker.on('messageerror', () => this.fail());
    this.worker.on('error', () => this.fail());
    this.worker.on('exit', () => {
      if (!this.stopping || this.pending.size > 0) this.fail();
    });
    this.worker.unref();
  }

  /** True only after explicit shutdown has terminated the owned worker. */
  get isClosed(): boolean {
    return this.closed;
  }

  /**
   * Opens an admitted physical scope and optionally applies its existing native journal.
   *
   * @param command Trusted path/fresh-scope admission; app recovery is not bypassed.
   * Repeated access to the exact admitted binding shares its existing opening acknowledgement; it never reopens a scope or retries a failed command. Changed bindings and physical aliases still fail closed in the existing owner.
   *
   * @returns After connection policy and requested initialization have completed in the worker.
   */
  async open(command: Omit<OpenCommand, 'operation'>): Promise<void> {
    if (this.failed || this.stopping || this.closed)
      throw new ControlStoreWorkerError('unavailable', 'not-committed');
    if (
      !isControlWorkerRequest({
        ...command,
        operation: 'open',
        version: CONTROL_WORKER_VERSION,
        id: 0,
      })
    )
      throw new ControlStoreWorkerError('invalid-request', 'not-committed');
    const existing = this.openings.get(command.database);
    if (existing) {
      if (!isDeepStrictEqual(existing.command, command))
        throw new ControlStoreWorkerError('invalid-request', 'not-committed');
      await existing.promise;
      return;
    }
    const binding = structuredClone(command);
    const promise = this.request({ ...binding, operation: 'open' }).then(() => {});
    const opening = { command: binding, promise };
    this.openings.set(command.database, opening);
    try {
      await promise;
    } catch (error) {
      if (this.openings.get(command.database) === opening) this.openings.delete(command.database);
      throw error;
    }
  }

  /**
   * Submits a whole conditional transition and its original receipt, never a callback.
   *
   * @param database Already-admitted worker database key.
   * @param statements Bounded Core-owned SQL; immutable content is synchronized before submission.
   * @returns Materialized results only after durable outer COMMIT.
   */
  async write(
    database: string,
    statements: readonly ControlSqlStatement[]
  ): Promise<readonly ControlSqlResult[]> {
    const reply = await this.request({ operation: 'write', database, statements });
    return (reply as Extract<Success, { operation: 'write' }>).results;
  }

  /**
   * Submits the native admission/product tuple, original receipt and required local Audit to the owning worker.
   *
   * Immutable entries must already be published through Storage; the worker verifies and synchronizes their actual bytes before SQL. This preparation API has no public caller binding. Receipt replay returns the original response, not a newly proposed resource identity.
   */
  async transition(
    database: string,
    transition: ControlAdmission
  ): Promise<ControlAdmissionResult> {
    const reply = await this.request({ operation: 'transition', database, transition });
    return (reply as Extract<Success, { operation: 'transition' }>).result;
  }

  /** Submits a whole non-command product/lifecycle transition; success follows outer FULL COMMIT, never a queued-write acknowledgement. */
  async products(database: string, transition: ControlProductTransition): Promise<void> {
    await this.request({ operation: 'products', database, transition });
  }

  /** Attempts native checkpoint progress after prior submitted work. */
  async checkpoint(database: string): Promise<ControlCheckpoint> {
    const reply = await this.request({ operation: 'checkpoint', database });
    return (reply as Extract<Success, { operation: 'checkpoint' }>).pressure;
  }

  /** Requests bounded native reclamation; false preserves the existing blocked result. */
  async reclaim(database: string): Promise<boolean> {
    const reply = await this.request({ operation: 'reclaim', database });
    return (reply as Extract<Success, { operation: 'reclaim' }>).complete;
  }

  /** Closes a scope only after its previously accepted writes have finished. */
  async close(database: string): Promise<void> {
    const opening = this.openings.get(database);
    await this.request({ operation: 'close', database });
    if (this.openings.get(database) === opening) this.openings.delete(database);
  }

  /**
   * Stops admission, drains accepted work and closes the actual owned thread.
   *
   * A failed transport is terminated without retrying its pending work. A subsequent explicit host lifetime does not resolve those unknown command outcomes.
   *
   * @returns After graceful shutdown or termination; never leaves a second live host.
   */
  shutdown(): Promise<void> {
    if (this.shutdownPromise !== undefined) return this.shutdownPromise;
    this.stopping = true;
    this.shutdownPromise = (async () => {
      try {
        if (!this.failed) await this.request({ operation: 'shutdown' });
      } finally {
        await this.worker.terminate();
        this.fail();
        this.closed = true;
      }
    })();
    return this.shutdownPromise;
  }

  /** Bounds all scoped messages BEFORE cloning/posting, including native-thread stalls. */
  private request(command: ControlWorkerCommand): Promise<Success> {
    if (this.failed || this.closed || (this.stopping && command.operation !== 'shutdown')) {
      return Promise.reject(new ControlStoreWorkerError('unavailable', 'not-committed'));
    }
    const database = 'database' in command ? command.database : undefined;
    if (
      database !== undefined &&
      (this.outstanding.get(database) ?? 0) >= CONTROL_WORKER_LIMITS.pendingTransitions
    ) {
      return Promise.reject(new ControlStoreWorkerError('busy', 'not-committed'));
    }
    if (!Number.isSafeInteger(this.nextId)) {
      return Promise.reject(new ControlStoreWorkerError('unavailable', 'not-committed'));
    }
    const request: ControlWorkerRequest = {
      ...command,
      version: CONTROL_WORKER_VERSION,
      id: this.nextId,
    };
    if (!isControlWorkerRequest(request)) {
      return Promise.reject(new ControlStoreWorkerError('invalid-request', 'not-committed'));
    }
    const id = this.nextId++;
    return new Promise<Success>((resolve, reject) => {
      this.pending.set(id, { command, resolve, reject });
      if (database !== undefined)
        this.outstanding.set(database, (this.outstanding.get(database) ?? 0) + 1);
      this.worker.ref();
      try {
        this.worker.postMessage(request);
      } catch {
        // Structured cloning fails before a message is enqueued; nothing was submitted.
        this.complete(
          id,
          undefined,
          new ControlStoreWorkerError('invalid-request', 'not-committed')
        );
      }
    });
  }

  /** Completes correlation once and releases the pre-post admission slot. */
  private complete(id: number, reply?: Success, error?: ControlStoreWorkerError): void {
    const entry = this.pending.get(id);
    if (entry === undefined) return;
    this.pending.delete(id);
    if ('database' in entry.command) {
      const database = entry.command.database;
      const remaining = (this.outstanding.get(database) ?? 1) - 1;
      if (remaining === 0) this.outstanding.delete(database);
      else this.outstanding.set(database, remaining);
    }
    if (error !== undefined) entry.reject(error);
    else if (reply !== undefined) entry.resolve(reply);
    if (this.pending.size === 0) this.worker.unref();
  }

  /** Rejects unknown/miscorrelated wire meanings without falsely reporting rollback. */
  private receive(value: unknown): void {
    if (!isControlWorkerReply(value)) {
      this.fail();
      return;
    }
    const entry = this.pending.get(value.id);
    if (
      entry === undefined ||
      (value.status === 'ok' && value.operation !== entry.command.operation)
    ) {
      this.fail();
      return;
    }
    if (value.status === 'error')
      this.complete(value.id, undefined, new ControlStoreWorkerError(value.code, value.commit));
    else this.complete(value.id, value);
  }

  /** No reply, worker loss or protocol failure proves that a posted write did not commit. */
  private fail(): void {
    if (this.failed) return;
    this.failed = true;
    for (const id of this.pending.keys()) {
      this.complete(id, undefined, new ControlStoreWorkerError('unavailable', 'unknown'));
    }
    // A failed channel must not retain a writable connection or continue queued work.
    void this.worker.terminate();
  }
}
