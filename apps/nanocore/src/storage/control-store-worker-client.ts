import { AsyncLocalStorage } from 'node:async_hooks';
import { lstatSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { isMainThread, Worker } from 'node:worker_threads';
import {
  ArtifactReviewError,
  type ControlReviewCommandInput,
  type ControlReviewCommandResult,
} from '../artifact-reviews.js';
import type {
  ControlMaintenanceAdmissionInput,
  ControlMaintenanceAdmissionResult,
} from '../knowledge/knowledge-agent-maintenance.js';
import { NotebookError } from '../knowledge/notebook.js';
import { OperationError, restoreControlCapabilityFailure } from '../operation-error.js';
import type { ControlExecutionJournalInput } from '../runtime/execution-journal.js';
import {
  type ControlGoalCommandInput,
  type ControlGoalCommandResult,
  GoalCommandError,
} from '../runtime/goal-owner.js';
import { IdempotencyKeyConflictError } from '../runtime/idempotent-command.js';
import {
  type ControlPendingCommandResult,
  PendingRequestCommandError,
} from '../runtime/pending-requests.js';
import type {
  ProjectWorkerBackendCleanupInput,
  WorkerBackendCleanupProjectionResult,
} from '../runtime/worker-backend-cleanup-projection.js';
import {
  type ControlMaterialCommandInput,
  type ControlMaterialCommandResult,
  prepareControlMaterialTransfer,
} from '../workspace-materials.js';
import type { ControlCheckpoint } from './control-store.js';
import type { ControlAdmission, ControlAdmissionResult } from './control-store-admission.js';
import {
  type ControlCapabilityCommandInput,
  type ControlCapabilityCommandResult,
  type ControlCapabilityWireInput,
  controlCapabilityText,
  prepareControlCapabilityTransfer,
} from './control-store-capability.js';
import type { ControlPendingTransition } from './control-store-pending.js';
import {
  type ControlProductTransition,
  type ControlPublicationInput,
  type ControlTerminalResult,
  type ControlTerminalTransition,
  closeWorkspaceProductReadHandles,
} from './control-store-products.js';
import {
  CONTROL_WORKER_LIMITS,
  CONTROL_WORKER_VERSION,
  type ControlProductCohort,
  type ControlSqlResult,
  type ControlSqlStatement,
  type ControlWorkerCommand,
  type ControlWorkerDomainRefusal,
  type ControlWorkerFailureCode,
  type ControlWorkerReply,
  type ControlWorkerRequest,
  controlMaterialTransferSize,
  controlWorkerInputBytes,
  isControlProductCohort,
  isControlWorkerReply,
  isControlWorkerRequest,
} from './control-store-worker-protocol.js';
import type { WorkspaceDb } from './db.js';
import type {
  ControlWorkObservationInput,
  ControlWorkObservationResult,
} from './work-observations.js';
import { nativeProductScope } from './workspace-file-records.js';

/** A refusal or uncertain result, never a substitute for the original SQL command receipt. */
export class ControlStoreWorkerError extends Error {
  /** Creates a redacted failure; unknown results require original-request inspection. */
  constructor(
    readonly code: ControlWorkerFailureCode,
    readonly commit: 'not-committed' | 'unknown',
    readonly domain?: ControlWorkerDomainRefusal
  ) {
    super('Control database writer operation failed.');
    this.name = 'ControlStoreWorkerError';
  }
}

/** Definite refusal of new work by this host lifetime; no command was admitted. */
export class ControlStoreWorkerShutdownError extends ControlStoreWorkerError {
  /** Keeps shutdown distinct from a failed transport with unknown accepted outcomes. */
  constructor() {
    super('unavailable', 'not-committed');
    this.name = 'ControlStoreWorkerShutdownError';
  }
}

type Success = Extract<ControlWorkerReply, { status: 'ok' }>;
type OpenCommand = Extract<ControlWorkerCommand, { operation: 'open' }>;

/** One bounded native host; a failed host never restarts in this coordinator lifetime. */
interface WriterHost {
  worker: Worker | undefined;
  failed: boolean;
  /** Includes posted binary bytes whose channel failed until actual worker exit. */
  materialBytes: number;
  inputBytes: number;
  pending: number;
}

/** A process-wide physical reservation, including a fresh scope awaiting native initialization. */
interface Opening {
  readonly command: Omit<OpenCommand, 'operation'>;
  readonly host: WriterHost;
  readonly path: string;
  identity: string | undefined;
  /** True only after the original native ACK and physical identity validation. */
  acknowledged: boolean;
  readonly promise: Promise<void>;
}

/** The existing posting hold and its FIFO release boundary, without another request queue. */
interface PostingHold {
  released: Promise<void>;
  drain: (() => void) | undefined;
}

/** One immutable transport frame shared by its existing pending request slots. */
interface PendingCohort {
  readonly frame: ControlProductCohort;
  readonly inputBytes: number;
  remaining: number;
}

/** One exact call's closeout count, retained by its original accepted producer. */
interface CapabilityCloseoutCredit {
  readonly database: string;
  readonly callId: string;
  active: boolean;
  borrowing: boolean;
}

/** One finite in-flight message, not persisted work or an execution attempt. */
interface Pending {
  readonly counted: boolean;
  readonly host: WriterHost;
  readonly command: ControlWorkerCommand;
  readonly request: ControlWorkerRequest;
  /** Unposted capture waiters share this same finite admission map and byte budget. */
  posted: boolean;
  /** The original admitted scope ACK gates posting after finite request admission. */
  ready: boolean;
  /** Binary input and echoed range content remain admitted until reply or known disposal. */
  readonly materialBytes: number;
  readonly inputBytes: number;
  readonly closeout?: CapabilityCloseoutCredit | undefined;
  cohort?: PendingCohort;
  readonly resolve: (reply: Success) => void;
  readonly reject: (error: ControlStoreWorkerError | PendingRequestCommandError) => void;
}

/** Exact live product publication; this is not retained state or permission to retry. */
interface ControlPublicationIdentity {
  readonly dataRoot: string;
  readonly workspaceId: string;
  readonly turnId: string;
}

let singleton: ControlStoreWorkerClient | undefined;

/**
 * Returns the process-local writer coordinator, without opening a database.
 *
 * A failed native host is never restarted by this getter. Explicit shutdown must finish before a later call can start a new host; no request is replayed. A released product scope must transfer its complete producer and shared receipt closure before using this host. A legacy main writable handle is not a table-level access-control boundary.
 *
 * @returns Shared coordinator for admitted database scopes, never a synchronous SQL facade.
 */
export function getControlStoreWorkerClient(): ControlStoreWorkerClient {
  if (!isMainThread) throw new ControlStoreWorkerError('unavailable', 'not-committed');
  if (singleton === undefined || singleton.isClosed) singleton = new ControlStoreWorkerClient();
  return singleton;
}

/** Stops the existing process-local host without creating one; callers must finish shutdown before removing its database roots. */
export async function shutdownControlStoreWorkerClient(): Promise<void> {
  if (singleton) await singleton.shutdown();
  else closeWorkspaceProductReadHandles();
}

/** Owns the worker lifetime, finite pre-post admission and asynchronous acknowledgements. */
class ControlStoreWorkerClient {
  private readonly hosts: WriterHost[] = Array.from(
    { length: CONTROL_WORKER_LIMITS.workspaceWorkers + 1 },
    () => ({ worker: undefined, failed: false, materialBytes: 0, inputBytes: 0, pending: 0 })
  );
  private readonly operations = new Map<Promise<unknown>, ControlPublicationIdentity | undefined>();
  private readonly turnTails = new Map<string, { tail: Promise<unknown>; pending: number }>();
  private readonly operationContext = new AsyncLocalStorage<{
    active: boolean;
    publication: ControlPublicationIdentity | undefined;
    reservation: string | undefined;
    closeout: CapabilityCloseoutCredit | undefined;
  }>();
  private readonly pending = new Map<number, Pending>();
  private readonly outstanding = new Map<string, number>();
  private readonly openings = new Map<string, Opening>();
  private nextId = 0;
  private materialBytes = 0;
  private inputBytes = 0;
  private stopping = false;
  private closed = false;
  private shutdownPromise: Promise<void> | undefined;
  private backupHold: PostingHold | undefined;
  private readonly databaseHolds = new Map<string, PostingHold>();

  /** Starts the native host on first command; retaining a shutdown owner alone needs no thread. */
  private startWorker(host: WriterHost): Worker {
    if (host.worker) return host.worker;
    if (import.meta.url.endsWith('.ts') && process.env.VITEST === 'true') {
      // Vitest global setup compiles this same entry once in its owned private directory; missing setup fails closed.
      host.worker = new Worker(
        pathToFileURL(
          join(tmpdir(), 'nanocore-worker', 'dist', 'storage', 'control-store-worker.mjs')
        )
      );
    } else if (import.meta.url.endsWith('.ts')) {
      const require = createRequire(import.meta.url);
      const loader = pathToFileURL(require.resolve('tsx/esm/api')).href;
      const entry = new URL('./control-store-worker.ts', import.meta.url).href;
      host.worker = new Worker(
        // This thread is already isolated. A second tsImport namespace adds synchronous CommonJS loader round trips for the complete owner graph.
        `import(${JSON.stringify(loader)}).then(({register}) => { register(); return import(${JSON.stringify(entry)}); });`,
        { eval: true }
      );
    } else {
      host.worker = new Worker(new URL('./control-store-worker.js', import.meta.url));
    }
    host.worker.on('message', (value: unknown) => this.receive(value, host));
    host.worker.on('messageerror', () => this.fail(host));
    host.worker.on('error', () => this.fail(host));
    host.worker.on('exit', () => {
      // Even during producer drain, exit cannot leave a host eligible for later causal work.
      this.fail(host);
      // A failed channel alone cannot prove the worker released its queued bytes. Exit can.
      this.inputBytes -= host.inputBytes;
      host.inputBytes = 0;
      this.materialBytes -= host.materialBytes;
      host.materialBytes = 0;
    });
    host.worker.unref();
    return host.worker;
  }

  /** True only after explicit shutdown has terminated the owned worker. */
  get isClosed(): boolean {
    return this.closed;
  }

  /** Retains an accepted producer, including asynchronous preparation, until its own closeout settles.
   * @param publication Optional exact initial product identity, never retry authority.
   * @param reservation Existing publication count, or the exact invocation credit borrowed through terminal Item acknowledgement.
   * @param closeout Exact capability call whose serial closeout retains one count credit.
   * @returns The original producer result after its own closeout.
   */
  async runOperation<T>(
    operation: () => Promise<T>,
    publication?: ControlPublicationIdentity,
    reservation?:
      | string
      | { readonly database: string; readonly closeout: CapabilityCloseoutCredit },
    closeout?: { readonly database: string; readonly callId: string }
  ): Promise<T> {
    this.assertAccepting();
    if (
      closeout &&
      (this.outstanding.get(closeout.database) ?? 0) >= CONTROL_WORKER_LIMITS.pendingTransitions
    )
      throw new ControlStoreWorkerError('busy', 'not-committed');
    const credit = closeout && { ...closeout, active: true, borrowing: false };
    if (credit)
      this.outstanding.set(credit.database, (this.outstanding.get(credit.database) ?? 0) + 1);
    const context = {
      active: true,
      publication,
      reservation: typeof reservation === 'string' ? reservation : reservation?.database,
      closeout: credit ?? (typeof reservation === 'object' ? reservation.closeout : undefined),
    };
    // Register before invoking the producer: its synchronous Core commit may expose this identity.
    const promise = this.operationContext.run(context, () => Promise.resolve().then(operation));
    this.operations.set(promise, publication);
    try {
      return await promise;
    } finally {
      context.active = false;
      this.operations.delete(promise);
      if (credit) {
        credit.active = false;
        // An unawaited descendant still owns its actual native backing until its reply or disposal.
        if (!credit.borrowing) this.releaseOutstanding(credit.database);
      }
    }
  }

  /** Owns JSON input before same-Turn head capture through ACK; only an exact terminal Item borrows its invocation credit. */
  async runTurnPublication<I, T>(
    database: string,
    turns: readonly string[],
    input: I,
    prepare: (owned: I) => Promise<T>,
    closeoutCallId?: string
  ): Promise<T> {
    this.assertAccepting();
    const context = this.operationContext.getStore();
    const credit = context?.closeout;
    const closeout =
      context?.active &&
      credit?.active &&
      !credit.borrowing &&
      credit.database === database &&
      credit.callId === closeoutCallId
        ? credit
        : undefined;
    const json = JSON.stringify(input);
    const bytes = Buffer.byteLength(json) + 64;
    if (
      !closeout &&
      ((this.outstanding.get(database) ?? 0) >= CONTROL_WORKER_LIMITS.pendingTransitions ||
        bytes > CONTROL_WORKER_LIMITS.pendingBytes - this.inputBytes)
    )
      throw new ControlStoreWorkerError('busy', 'not-committed');
    const physical = realpathSync(database.slice(database.indexOf(':') + 1));
    const keys = [...new Set(turns)].map((turn) => JSON.stringify([physical, turn]));
    // Check the complete selector set before reserving any member or installing its tail.
    if (
      !closeout &&
      keys.some(
        (key) =>
          (this.turnTails.get(key)?.pending ?? 0) >= CONTROL_WORKER_LIMITS.pendingTurnTransitions
      )
    )
      throw new ControlStoreWorkerError('busy', 'not-committed');
    const predecessors = keys.map((key) => this.turnTails.get(key)?.tail);
    this.inputBytes += bytes;
    if (closeout) closeout.borrowing = true;
    else this.outstanding.set(database, (this.outstanding.get(database) ?? 0) + 1);
    const result = this.runOperation(
      async () => {
        try {
          await Promise.all(predecessors);
        } catch {
          throw new ControlStoreWorkerError('precondition', 'not-committed');
        }
        return prepare(JSON.parse(json) as I);
      },
      undefined,
      closeout ? { database, closeout } : database
    );
    for (const key of keys)
      this.turnTails.set(key, {
        tail: result,
        pending: (this.turnTails.get(key)?.pending ?? 0) + 1,
      });
    try {
      return await result;
    } finally {
      this.inputBytes -= bytes;
      if (closeout) {
        closeout.borrowing = false;
        if (!closeout.active) this.releaseOutstanding(database);
      } else this.releaseOutstanding(database);
      for (const key of keys) {
        const entry = this.turnTails.get(key)!;
        if (--entry.pending === 0) this.turnTails.delete(key);
      }
    }
  }

  /** Releases one admitted producer or independently counted native request. */
  private releaseOutstanding(database: string): void {
    const remaining = (this.outstanding.get(database) ?? 1) - 1;
    if (remaining === 0) this.outstanding.delete(database);
    else this.outstanding.set(database, remaining);
  }

  /** Observes only an exact live original admission; absence never authorizes publication or replay. */
  async waitForPublication(publication: ControlPublicationIdentity): Promise<void> {
    if (
      this.operationContext.getStore()?.active &&
      isDeepStrictEqual(this.operationContext.getStore()?.publication, publication)
    )
      throw new Error('A publication cannot join itself.');
    const matches = [...this.operations].filter(([, identity]) =>
      isDeepStrictEqual(identity, publication)
    );
    if (matches.length > 1) throw new Error('Publication identity is ambiguous.');
    // The caller must inspect canonical history even when the original acknowledgement was lost.
    if (matches[0]) await matches[0][0].catch(() => undefined);
  }

  /** Only still-active accepted producers may continue submitting work during shutdown drain. */
  private assertAccepting(): void {
    if (this.closed || (this.stopping && !this.operationContext.getStore()?.active))
      throw new ControlStoreWorkerShutdownError();
  }

  /** Reserves physical identity before posting; unrelated openings never wait for another native ACK. */
  private reserveOpening(command: Omit<OpenCommand, 'operation'>): {
    path: string;
    identity: string | undefined;
    host: WriterHost;
  } {
    let path: string;
    let identity: string | undefined;
    try {
      const incoming = statSync(command.path, { throwIfNoEntry: false });
      const leaf = lstatSync(command.path, { throwIfNoEntry: false });
      if (!incoming && leaf?.isSymbolicLink())
        throw new Error('A dangling link cannot reserve a new database.');
      path = incoming
        ? realpathSync(command.path)
        : join(realpathSync(dirname(command.path)), basename(command.path));
      identity = incoming ? `${incoming.dev}:${incoming.ino}` : undefined;
      // Incoming identity is read first: an alias of a newly initialized file implies
      // that its earlier reserved path can now supply that inode, even before ACK.
      for (const opening of this.openings.values()) {
        if (opening.identity === undefined) {
          const current = statSync(opening.path, { throwIfNoEntry: false });
          if (current) opening.identity = `${current.dev}:${current.ino}`;
        }
        if (opening.path === path || (identity !== undefined && opening.identity === identity))
          throw new Error('Duplicate physical database.');
      }
    } catch {
      throw new ControlStoreWorkerError('invalid-request', 'not-committed');
    }
    const candidates =
      command.productOwner?.kind === 'server' || command.initialize === 'core'
        ? this.hosts.slice(0, 1)
        : this.hosts.slice(1);
    const counts = new Map(candidates.map((host) => [host, 0]));
    for (const opening of this.openings.values())
      if (counts.has(opening.host)) counts.set(opening.host, counts.get(opening.host)! + 1);
    const host = candidates
      .filter((candidate) => !candidate.failed)
      .reduce<WriterHost | undefined>(
        (least, candidate) =>
          least === undefined || counts.get(candidate)! < counts.get(least)! ? candidate : least,
        undefined
      );
    if (!host) throw new ControlStoreWorkerError('unavailable', 'not-committed');
    return { path, identity, host };
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
    this.assertAccepting();
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
      if (existing.host.failed) throw new ControlStoreWorkerError('unavailable', 'not-committed');
      if (!isDeepStrictEqual(existing.command, command))
        throw new ControlStoreWorkerError('invalid-request', 'not-committed');
      await existing.promise;
      return;
    }
    const binding = structuredClone(command);
    const physical = this.reserveOpening(binding);
    const opening: Opening = {
      command: binding,
      ...physical,
      acknowledged: false,
      promise: this.request({ ...binding, operation: 'open' }, undefined, physical.host).then(
        () => {
          try {
            const current = statSync(physical.path);
            const identity = `${current.dev}:${current.ino}`;
            if (opening.identity !== undefined && opening.identity !== identity)
              throw new Error('Physical database changed.');
            opening.identity = identity;
            opening.acknowledged = true;
          } catch {
            this.fail(physical.host);
            throw new ControlStoreWorkerError('unavailable', 'unknown');
          }
        }
      ),
    };
    this.openings.set(command.database, opening);
    try {
      await opening.promise;
    } catch (error) {
      // Unknown channel results retain their physical reservation until explicit shutdown.
      if (!physical.host.failed && this.openings.get(command.database) === opening)
        this.openings.delete(command.database);
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

  /**
   * Admits one finite eligible Item/event prefix atomically into existing native request slots.
   *
   * Each member retains its own deciding CAS, savepoint and FULL acknowledgement. The ordered
   * results preserve an earlier committed member when a later member or its suffix refuses.
   * This is private writer framing; callers still own progress eligibility and source retention.
   */
  async productsCohort(
    database: string,
    transitions: readonly ControlProductTransition[],
    options: { readonly immediate?: boolean } = {}
  ): Promise<readonly PromiseSettledResult<void>[]> {
    this.assertAccepting();
    if (transitions.length === 0 || transitions.length > CONTROL_WORKER_LIMITS.batchTransitions)
      throw new ControlStoreWorkerError('invalid-request', 'not-committed');
    const requests = transitions.map(
      (transition, index) =>
        ({
          version: CONTROL_WORKER_VERSION,
          operation: 'products' as const,
          database,
          transition,
          id: this.nextId + index,
        }) as const
    );
    const frame: ControlProductCohort = {
      version: CONTROL_WORKER_VERSION,
      operation: 'products',
      requests,
      immediate: options.immediate ?? false,
    };
    if (!isControlProductCohort(frame))
      throw new ControlStoreWorkerError('invalid-request', 'not-committed');
    const bytes = requests.reduce(
      (total, request) => total + controlWorkerInputBytes(request) + 64,
      0
    );
    if (
      (this.outstanding.get(database) ?? 0) + requests.length >
        CONTROL_WORKER_LIMITS.pendingTransitions ||
      this.inputBytes + bytes > CONTROL_WORKER_LIMITS.pendingBytes
    )
      throw new ControlStoreWorkerError('busy', 'not-committed');
    // No await or post occurs between the complete admission check and reservation of all slots.
    const results = requests.map((request) =>
      this.request(
        { operation: 'products', database, transition: request.transition },
        undefined,
        undefined,
        true
      ).then(() => undefined)
    );
    const entries = requests.map((request) => this.pending.get(request.id));
    if (entries.some((entry) => !entry)) {
      for (const request of requests)
        this.complete(
          request.id,
          undefined,
          new ControlStoreWorkerError('invalid-request', 'not-committed')
        );
    } else {
      const admitted = entries as Pending[];
      const cohort: PendingCohort = {
        frame: {
          ...frame,
          requests: admitted.map((entry) => entry.request) as ControlProductCohort['requests'],
        },
        inputBytes: admitted.reduce((total, entry) => total + entry.inputBytes, 0),
        remaining: admitted.length,
      };
      for (const entry of admitted) entry.cohort = cohort;
      this.post(admitted[0]!);
    }
    return Promise.allSettled(results);
  }

  /** Publishes only the named sealed-Turn entry category after native preparation and FULL acknowledgement. */
  async publication(database: string, input: ControlPublicationInput): Promise<void> {
    await this.request({ operation: 'publication', database, input });
  }

  /** Commits the complete Workspace cleanup projection on its admitted scoped handle; physical release authority remains with its existing producer. */
  async projectCleanup(
    database: string,
    input: ProjectWorkerBackendCleanupInput
  ): Promise<WorkerBackendCleanupProjectionResult> {
    const reply = await this.request({ operation: 'project-cleanup', database, input });
    return (reply as Extract<Success, { operation: 'project-cleanup' }>).result;
  }

  /** Appends native observation order and publication metadata; independently published body bytes are not carried through SQL. */
  async observation(
    database: string,
    input: ControlWorkObservationInput
  ): Promise<ControlWorkObservationResult> {
    const reply = await this.request({ operation: 'observation', database, input });
    return (reply as Extract<Success, { operation: 'observation' }>).result;
  }

  /** Commits the Pending owner and its complete local publication before returning IDs. */
  async pendingCommand(
    database: string,
    input: ControlPendingTransition
  ): Promise<ControlPendingCommandResult> {
    try {
      const reply = await this.request({ operation: 'pending', database, input });
      return (reply as Extract<Success, { operation: 'pending' }>).result;
    } catch (error) {
      if (error instanceof ControlStoreWorkerError && error.domain?.operation === 'pending') {
        if (error.domain.code === 'idempotency_key_conflict')
          throw new IdempotencyKeyConflictError();
        throw new PendingRequestCommandError(
          error.domain.code,
          error.domain.message,
          error.domain.status
        );
      }
      throw error;
    }
  }

  /** Mutates the existing Workspace journal and returns only after the outer FULL commit. */
  async journal(database: string, input: ControlExecutionJournalInput): Promise<string> {
    const reply = await this.request({ operation: 'journal', database, input });
    return (reply as Extract<Success, { operation: 'journal' }>).resultJson;
  }

  /** Opens or reuses the exact retained Workspace scope through its existing native owner. */
  async workspaceCapability(
    db: WorkspaceDb,
    input: ControlCapabilityCommandInput,
    options: { readonly immediate?: boolean } = {}
  ): Promise<ControlCapabilityCommandResult> {
    const scope = nativeProductScope(db.dataRoot, {
      kind: 'workspace',
      workspaceId: db.workspaceId,
    });
    const database = `workspace:${scope.path}`;
    const admitted = this.openings.get(database);
    if (!admitted) {
      // Reserve the request before awaiting this exact cold scope's original opening ACK.
      return (
        await Promise.all([
          this.open({
            database,
            path: scope.path,
            dataRoot: db.dataRoot,
            create: false,
            initialize: 'workspace',
            productOwner: scope.owner,
            contentMount: scope.contentMount,
          }),
          this.capability(database, input, options),
        ])
      )[1];
    }
    if (
      admitted.command.path !== scope.path ||
      admitted.command.dataRoot !== db.dataRoot ||
      !isDeepStrictEqual(admitted.command.productOwner, scope.owner)
    )
      throw new ControlStoreWorkerError('invalid-request', 'not-committed');
    return this.capability(database, input, options);
  }

  /** Submits prepared family facts through the bounded writer and awaits durable acknowledgement. */
  async capability(
    database: string,
    input: ControlCapabilityCommandInput,
    options: { readonly immediate?: boolean } = {}
  ): Promise<ControlCapabilityCommandResult> {
    try {
      const text = controlCapabilityText(input);
      if (
        text !== undefined &&
        (Buffer.byteLength(text) > CONTROL_WORKER_LIMITS.materialPendingBytes ||
          (!this.closeoutCredit(database, input) &&
            Buffer.byteLength(text) >
              CONTROL_WORKER_LIMITS.materialPendingBytes - this.materialBytes))
      )
        throw new ControlStoreWorkerError('busy', 'not-committed');
      const transfer = prepareControlCapabilityTransfer(input);
      const reply = await this.request(
        {
          operation: 'capability',
          database,
          input: transfer.input,
          immediate: options.immediate ?? false,
        },
        transfer.parts
      );
      return (reply as Extract<Success, { operation: 'capability' }>).result;
    } catch (error) {
      if (error instanceof ControlStoreWorkerError && error.domain?.operation === 'capability') {
        if (error.domain.kind === 'pending')
          throw new PendingRequestCommandError(
            error.domain.code,
            error.domain.message,
            error.domain.status
          );
        if (error.domain.kind)
          throw restoreControlCapabilityFailure({
            kind: error.domain.kind,
            code: error.domain.code,
            message: error.domain.message,
            status: error.domain.status,
          });
        if (error.domain.code === 'unsupported_retained_format')
          throw new TypeError('Unsupported retained record format.');
        if (error.domain.code === 'idempotency_key_conflict')
          throw new IdempotencyKeyConflictError();
        throw new GoalCommandError(error.domain.code, error.domain.message, error.domain.status);
      }
      throw error;
    }
  }

  /** Only the exact call's schema preparation or serial closeout borrows its original credit. */
  private closeoutCredit(
    database: string,
    input: ControlCapabilityCommandInput | ControlCapabilityWireInput
  ): CapabilityCloseoutCredit | undefined {
    if (
      input.kind !== 'finish' &&
      input.kind !== 'mcp-schema' &&
      !(input.kind === 'usage-finish' && input.finish)
    )
      return undefined;
    const context = this.operationContext.getStore();
    const credit = context?.closeout;
    const callId = input.kind === 'usage-finish' ? input.call.id : input.callId;
    return context?.active &&
      credit?.active &&
      !credit.borrowing &&
      credit.database === database &&
      credit.callId === callId
      ? credit
      : undefined;
  }

  /** Executes the complete native Goal body; trusted domain refusals keep their public meaning, while SQL failures remain redacted. */
  async goal(database: string, input: ControlGoalCommandInput): Promise<ControlGoalCommandResult> {
    try {
      const reply = await this.request({ operation: 'goal', database, input });
      return (reply as Extract<Success, { operation: 'goal' }>).result;
    } catch (error) {
      if (error instanceof ControlStoreWorkerError && error.domain?.operation === 'goal') {
        if (error.domain.code === 'unsupported_retained_format')
          throw new TypeError('Unsupported retained record format.');
        if (error.domain.code === 'idempotency_key_conflict')
          throw new IdempotencyKeyConflictError();
        throw new GoalCommandError(error.domain.code, error.domain.message, error.domain.status);
      }
      throw error;
    }
  }

  /** Admits one scoped Knowledge unit; model work starts only after its native acknowledgement. */
  async maintenance(
    database: string,
    input: ControlMaintenanceAdmissionInput
  ): Promise<ControlMaintenanceAdmissionResult> {
    try {
      const reply = await this.request({ operation: 'maintenance', database, input });
      return (reply as Extract<Success, { operation: 'maintenance' }>).result;
    } catch (error) {
      if (error instanceof ControlStoreWorkerError && error.domain?.operation === 'maintenance') {
        if (error.domain.code === 'idempotency_key_conflict')
          throw new IdempotencyKeyConflictError();
        if (error.domain.code === 'invalid_request' || error.domain.code === 'recovery_required')
          throw new NotebookError(error.domain.code);
      }
      throw error;
    }
  }

  /** Executes one complete Material-family body; only its outer FULL commit acknowledges the result. */
  async material(
    database: string,
    input: ControlMaterialCommandInput
  ): Promise<ControlMaterialCommandResult> {
    try {
      const transfer = prepareControlMaterialTransfer(input);
      const reply = await this.request(
        { operation: 'material', database, input: transfer.input },
        transfer.parts
      );
      return (reply as Extract<Success, { operation: 'material' }>).result;
    } catch (error) {
      if (error instanceof ControlStoreWorkerError && error.domain?.operation === 'material') {
        if (error.domain.code === 'idempotency_key_conflict')
          throw new IdempotencyKeyConflictError();
        throw new OperationError(error.domain.code, error.domain.message, error.domain.status);
      }
      throw error;
    }
  }

  /** Commits the complete scoped Review or Artifact submission tuple and its original receipt. */
  async review(
    database: string,
    input: ControlReviewCommandInput
  ): Promise<ControlReviewCommandResult> {
    try {
      const reply = await this.request({ operation: 'review', database, input });
      return (reply as Extract<Success, { operation: 'review' }>).result;
    } catch (error) {
      if (error instanceof ControlStoreWorkerError && error.domain?.operation === 'review') {
        if (error.domain.code === 'idempotency_key_conflict')
          throw new IdempotencyKeyConflictError();
        throw new ArtifactReviewError(
          error.domain.code as ConstructorParameters<typeof ArtifactReviewError>[0],
          error.domain.message
        );
      }
      throw error;
    }
  }

  /** Commits the complete local terminal tuple; only outer FULL COMMIT produces this acknowledgement, never physical release. */
  async terminal(
    database: string,
    input: ControlTerminalTransition
  ): Promise<ControlTerminalResult> {
    const reply = await this.request({ operation: 'terminal', database, input });
    return (reply as Extract<Success, { operation: 'terminal' }>).result;
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
    try {
      await this.request({ operation: 'close', database });
      if (this.openings.get(database) === opening) this.openings.delete(database);
    } finally {
      if (opening) closeWorkspaceProductReadHandles(opening.path);
    }
  }

  /**
   * Holds native posting for synchronous Main SQL or data-root capture after posted acknowledgements settle.
   *
   * New requests keep the same finite admission slots and byte budget while waiting. The caller must resume in finally; this hold neither closes scopes nor replays commands. A failed channel refuses capture because its outstanding commits are unknown.
   *
   * Database holds run FIFO and leave siblings live. Global capture waits for earlier database holds;
   * later database holds wait for its release. The synchronous body must not await native work.
   *
   * @param database Exact database key, or all databases for the existing backup capture.
   * @returns An idempotent release, which the caller must invoke in finally.
   */
  async pauseForDataRootBackup(database?: string): Promise<() => void> {
    this.assertAccepting();
    const failed = () =>
      database === undefined
        ? this.hosts.some((host) => host.failed)
        : this.openings.get(database)?.host.failed === true;
    if (failed()) throw new ControlStoreWorkerError('unavailable', 'not-committed');
    if (database === undefined && this.backupHold)
      throw new ControlStoreWorkerError('busy', 'not-committed');
    const previous = database === undefined ? undefined : this.databaseHolds.get(database);
    const dependencies =
      database === undefined
        ? [...this.databaseHolds.values()].map((hold) => hold.released)
        : [previous?.released, this.backupHold?.released];
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const hold = previous ?? { released, drain: undefined };
    hold.released = released;
    if (database === undefined) this.backupHold = hold;
    else this.databaseHolds.set(database, hold);
    const resume = () => {
      if (database === undefined) this.backupHold = undefined;
      else if (hold.released === released) this.databaseHolds.delete(database);
      release();
      for (const entry of this.pending.values()) if (!entry.posted) this.post(entry);
    };
    try {
      await Promise.all(dependencies);
      await new Promise<void>((resolve) => {
        hold.drain = resolve;
        this.completeBackupDrain();
      });
      this.assertAccepting();
      if (failed()) throw new ControlStoreWorkerError('unavailable', 'not-committed');
    } catch (error) {
      resume();
      throw error;
    }
    let resumed = false;
    return () => {
      if (resumed) return;
      resumed = true;
      resume();
    };
  }

  /**
   * Stops admission, drains accepted work and closes the actual owned thread.
   *
   * A failed transport is terminated without retrying its pending work. A subsequent explicit host lifetime does not resolve those unknown command outcomes.
   *
   * @returns After graceful shutdown or termination; never leaves a second live host.
   */
  shutdown(): Promise<void> {
    // Read-only inspection can occur after this writer lifetime has already stopped.
    if (this.closed) closeWorkspaceProductReadHandles();
    if (this.shutdownPromise !== undefined) return this.shutdownPromise;
    this.stopping = true;
    this.shutdownPromise = (async () => {
      try {
        const failures: unknown[] = [];
        while (this.operations.size) {
          const outcomes = await Promise.allSettled(this.operations.keys());
          for (const outcome of outcomes)
            if (outcome.status === 'rejected') failures.push(outcome.reason);
        }
        const shutdowns = await Promise.allSettled(
          this.hosts
            .filter((host) => host.worker && !host.failed)
            .map((host) => this.request({ operation: 'shutdown' }, undefined, host))
        );
        for (const outcome of shutdowns)
          if (outcome.status === 'rejected') failures.push(outcome.reason);
        if (failures.length)
          throw new AggregateError(
            failures,
            'Accepted control-store operations failed during shutdown.'
          );
      } finally {
        try {
          await Promise.all(this.hosts.map((host) => host.worker?.terminate()));
        } finally {
          closeWorkspaceProductReadHandles();
        }
        for (const host of this.hosts) this.fail(host);
        this.materialBytes = 0;
        this.inputBytes = 0;
        this.closed = true;
      }
    })();
    return this.shutdownPromise;
  }

  /** Bounds all scoped messages BEFORE cloning/posting, including native-thread stalls. */
  private request(
    command: ControlWorkerCommand,
    materialParts?: readonly string[],
    target?: WriterHost,
    deferPost = false
  ): Promise<Success> {
    if (command.operation !== 'shutdown') {
      try {
        this.assertAccepting();
      } catch (error) {
        return Promise.reject(error);
      }
    }
    const database = 'database' in command ? command.database : undefined;
    const context = this.operationContext.getStore();
    const closeout =
      command.operation === 'capability'
        ? this.closeoutCredit(command.database, command.input)
        : undefined;
    const borrowed =
      closeout !== undefined ||
      (database !== undefined && context?.active && context.reservation === database);
    // The exact Item's preparation owns this serial borrow until its covering native ACK.
    const creditedPublication =
      context?.active &&
      context.reservation === database &&
      context.closeout?.borrowing &&
      context.closeout.database === database &&
      (command.operation === 'products' || command.operation === 'publication');
    const opening = database === undefined ? undefined : this.openings.get(database);
    const host = target ?? opening?.host;
    // An ACK may be validated before older scope reactions run. They keep their prefix.
    const ready =
      command.operation !== 'open' &&
      opening &&
      (!opening.acknowledged ||
        [...this.pending.values()].some(
          (entry) =>
            !entry.ready && 'database' in entry.command && entry.command.database === database
        ))
        ? opening.promise
        : undefined;
    if (!host || host.failed)
      return Promise.reject(
        new ControlStoreWorkerError(host ? 'unavailable' : 'not-open', 'not-committed')
      );
    if (
      database !== undefined &&
      (this.outstanding.get(database) ?? 0) - (borrowed ? 1 : 0) >=
        CONTROL_WORKER_LIMITS.pendingTransitions
    ) {
      return Promise.reject(new ControlStoreWorkerError('busy', 'not-committed'));
    }
    if (!Number.isSafeInteger(this.nextId)) {
      return Promise.reject(new ControlStoreWorkerError('unavailable', 'not-committed'));
    }
    let inputBytes: number;
    try {
      inputBytes =
        controlWorkerInputBytes({ ...command, version: CONTROL_WORKER_VERSION, id: this.nextId }) +
        64;
    } catch {
      return Promise.reject(new ControlStoreWorkerError('invalid-request', 'not-committed'));
    }
    // One fixed shutdown message per owned host must still drain accepted work at saturation.
    if (
      command.operation !== 'shutdown' &&
      !closeout &&
      !creditedPublication &&
      this.inputBytes + inputBytes > CONTROL_WORKER_LIMITS.pendingBytes
    )
      return Promise.reject(new ControlStoreWorkerError('busy', 'not-committed'));
    let materialBytes = 0;
    let posted = command;
    if (command.operation === 'material' || command.operation === 'capability') {
      const size =
        command.operation === 'material'
          ? controlMaterialTransferSize(command.input)
          : {
              byteLength: controlCapabilityText(command.input)?.byteLength ?? 0,
              replyByteLength: 0,
            };
      if (!size)
        return Promise.reject(new ControlStoreWorkerError('invalid-request', 'not-committed'));
      materialBytes = size.byteLength + size.replyByteLength;
      if (
        !Number.isSafeInteger(materialBytes) ||
        materialBytes > CONTROL_WORKER_LIMITS.materialPendingBytes ||
        (!closeout &&
          materialBytes > CONTROL_WORKER_LIMITS.materialPendingBytes - this.materialBytes)
      )
        return Promise.reject(new ControlStoreWorkerError('busy', 'not-committed'));
      if (materialParts?.length) {
        // Admission precedes allocation and transfer. No escaped JSON or second payload buffer is made.
        const content = new ArrayBuffer(size.byteLength);
        let offset = 0;
        for (const text of materialParts) {
          const encoded = new TextEncoder().encodeInto(text, new Uint8Array(content, offset));
          if (encoded.read !== text.length)
            return Promise.reject(new ControlStoreWorkerError('invalid-request', 'not-committed'));
          offset += encoded.written;
        }
        if (offset !== size.byteLength)
          return Promise.reject(new ControlStoreWorkerError('invalid-request', 'not-committed'));
        posted = { ...command, content };
      }
    } else if (materialParts !== undefined)
      return Promise.reject(new ControlStoreWorkerError('invalid-request', 'not-committed'));
    const request: ControlWorkerRequest = {
      ...posted,
      version: CONTROL_WORKER_VERSION,
      id: this.nextId,
    };
    if (!isControlWorkerRequest(request)) {
      return Promise.reject(new ControlStoreWorkerError('invalid-request', 'not-committed'));
    }
    // Posting normally transfers ownership immediately. A capture hold must take the same
    // immutable input now, so its caller cannot change a bounded envelope before resume.
    let admittedRequest = request;
    if (
      this.backupHold ||
      (database !== undefined && this.databaseHolds.has(database)) ||
      deferPost ||
      ready !== undefined
    ) {
      try {
        admittedRequest = structuredClone(request, {
          transfer: 'content' in request && request.content ? [request.content] : [],
        });
      } catch {
        return Promise.reject(new ControlStoreWorkerError('invalid-request', 'not-committed'));
      }
    }
    let worker: Worker;
    try {
      worker = this.startWorker(host);
    } catch {
      this.fail(host);
      return Promise.reject(new ControlStoreWorkerError('unavailable', 'not-committed'));
    }
    const id = this.nextId++;
    const result = new Promise<Success>((resolve, reject) => {
      this.inputBytes += inputBytes;
      host.inputBytes += inputBytes;
      this.materialBytes += materialBytes;
      host.materialBytes += materialBytes;
      host.pending += 1;
      if (closeout) closeout.borrowing = true;
      const entry: Pending = {
        counted: !borrowed,
        host,
        command: admittedRequest,
        request: admittedRequest,
        posted: false,
        ready: ready === undefined,
        materialBytes,
        inputBytes,
        closeout,
        resolve,
        reject,
      };
      this.pending.set(id, entry);
      if (database !== undefined && !borrowed)
        this.outstanding.set(database, (this.outstanding.get(database) ?? 0) + 1);
      worker.ref();
      if (ready !== undefined) {
        void ready.then(
          () => {
            if (this.pending.get(id) !== entry) return;
            entry.ready = true;
            if (!deferPost || entry.cohort) this.post(entry);
          },
          (error: unknown) => {
            this.complete(
              id,
              undefined,
              new ControlStoreWorkerError(
                error instanceof ControlStoreWorkerError ? error.code : 'unavailable',
                'not-committed'
              )
            );
          }
        );
      } else if (!deferPost) this.post(entry);
    });
    if (ready !== undefined) {
      // Shutdown drains the original admitted request, including its unposted open wait.
      this.operations.set(result, undefined);
      const release = () => this.operations.delete(result);
      void result.then(release, release);
    }
    return result;
  }

  /** Posts an admitted message once, after its scope ACK and any data-root capture hold. */
  private post(entry: Pending): void {
    if (
      entry.posted ||
      !entry.ready ||
      this.backupHold ||
      ('database' in entry.command && this.databaseHolds.has(entry.command.database))
    )
      return;
    const members = entry.cohort?.frame.requests.map(
      (request) => this.pending.get(request.id)!
    ) ?? [entry];
    if (members.some((member) => !member.ready)) return;
    for (const member of members) member.posted = true;
    try {
      const request = entry.request;
      const transferList =
        'content' in request && request.content !== undefined ? [request.content] : [];
      entry.host.worker!.postMessage(entry.cohort?.frame ?? request, transferList);
    } catch {
      // A clone/post failure enqueues none of this one frame, including every cohort member.
      for (const member of members) {
        member.posted = false;
        this.complete(
          member.request.id,
          undefined,
          new ControlStoreWorkerError('invalid-request', 'not-committed')
        );
      }
    }
  }

  /** A held capture can start only after every previously posted message has settled. */
  private completeBackupDrain(): void {
    for (const [database, hold] of [[undefined, this.backupHold], ...this.databaseHolds] as const) {
      if (
        !hold?.drain ||
        [...this.pending.values()].some(
          (entry) =>
            entry.posted &&
            (database === undefined ||
              ('database' in entry.command && entry.command.database === database))
        )
      )
        continue;
      const complete = hold.drain;
      hold.drain = undefined;
      complete();
    }
  }

  /** Completes correlation once and releases the pre-post admission slot. */
  private complete(
    id: number,
    reply?: Success,
    error?: ControlStoreWorkerError | PendingRequestCommandError,
    releaseMaterialBytes = true
  ): void {
    const entry = this.pending.get(id);
    if (entry === undefined) return;
    this.pending.delete(id);
    if (releaseMaterialBytes) {
      const releasedInputBytes = entry.cohort
        ? --entry.cohort.remaining === 0
          ? entry.cohort.inputBytes
          : 0
        : entry.inputBytes;
      this.inputBytes -= releasedInputBytes;
      entry.host.inputBytes -= releasedInputBytes;
      this.materialBytes -= entry.materialBytes;
      entry.host.materialBytes -= entry.materialBytes;
    }
    entry.host.pending -= 1;
    if (entry.counted && 'database' in entry.command)
      this.releaseOutstanding(entry.command.database);
    if (entry.closeout) {
      entry.closeout.borrowing = false;
      if (!entry.closeout.active) this.releaseOutstanding(entry.closeout.database);
    }
    if (error !== undefined) entry.reject(error);
    else if (reply !== undefined) entry.resolve(reply);
    if (entry.host.pending === 0) entry.host.worker?.unref();
    this.completeBackupDrain();
  }

  /** Rejects unknown/miscorrelated wire meanings without falsely reporting rollback. */
  private receive(value: unknown, host: WriterHost): void {
    if (!isControlWorkerReply(value)) {
      this.fail(host);
      return;
    }
    const entry = this.pending.get(value.id);
    if (
      entry === undefined ||
      entry.host !== host ||
      !entry.posted ||
      (value.status === 'ok' && value.operation !== entry.command.operation) ||
      (value.status === 'error' &&
        value.domain !== undefined &&
        value.domain.operation !== entry.command.operation)
    ) {
      this.fail(host);
      return;
    }
    if (value.status === 'error')
      this.complete(
        value.id,
        undefined,
        (entry.command.operation === 'products' || entry.command.operation === 'transition') &&
          value.commit === 'not-committed' &&
          value.domain &&
          ['request_executing', 'thread_busy', 'conflict'].includes(value.domain.code)
          ? new PendingRequestCommandError(
              value.domain.code,
              value.domain.message,
              value.domain.status
            )
          : new ControlStoreWorkerError(value.code, value.commit, value.domain)
      );
    else this.complete(value.id, value);
  }

  /** No reply, worker loss or protocol failure proves that a posted write did not commit. */
  private fail(host: WriterHost): void {
    if (host.failed) return;
    host.failed = true;
    for (const [id, entry] of this.pending) {
      if (entry.host !== host) continue;
      const posted = entry.posted;
      this.complete(
        id,
        undefined,
        new ControlStoreWorkerError('unavailable', posted ? 'unknown' : 'not-committed'),
        !posted
      );
    }
    // A failed channel must not retain a writable connection or continue queued work.
    void host.worker?.terminate();
  }
}
