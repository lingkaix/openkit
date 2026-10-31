import { AsyncLocalStorage } from 'node:async_hooks';
import { lstatSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { isMainThread, Worker } from 'node:worker_threads';
import type { AuditEvent } from '@openkit/protocol';
import {
  ArtifactReviewError,
  type ControlReviewCommandInput,
  type ControlReviewCommandResult,
} from '../artifact-reviews.js';
import { prepareAuditEventStatement } from '../audit-events.js';
import type {
  ControlMaintenanceAdmissionInput,
  ControlMaintenanceAdmissionResult,
} from '../knowledge/knowledge-agent-maintenance.js';
import { NotebookError } from '../knowledge/notebook.js';
import type { CommandRequestRecord } from '../lib/store.js';
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
import type {
  WorkspaceFrozenAdmission,
  WorkspaceMutationAdmission,
} from '../workspace-mutation-admission.js';
import {
  FileAdmissionError,
  FileStorageAdmission,
  type FileStorageReservation,
} from './artifacts/file-admission.js';
import { prepareControlCommandRequestStatement } from './command-request-codecs.js';
import { CONTROL_STORE_BUDGET, type ControlCheckpoint } from './control-store.js';
import type { ControlAdmission, ControlAdmissionResult } from './control-store-admission.js';
import {
  type ControlCapabilityCommandInput,
  type ControlCapabilityCommandResult,
  type ControlCapabilityWireInput,
  controlCapabilityText,
  prepareControlCapabilityTransfer,
} from './control-store-capability.js';
import {
  type ControlKnowledgeHead,
  controlKnowledgeHeadStatements,
} from './control-store-knowledge-heads.js';
import type { ControlPendingTransition } from './control-store-pending.js';
import {
  type ControlEventAppend,
  type ControlEventAppendResult,
  ControlEventAppendSchema,
  type ControlItemAppend,
  type ControlProductEntry,
  type ControlProductTransition,
  type ControlPublicationInput,
  type ControlTerminalResult,
  type ControlTerminalTransition,
  closeWorkspaceProductReadHandles,
} from './control-store-products.js';
import type {
  ControlRecoveryCaptureInput,
  ControlRecoveryCleanupInput,
  ControlRecoveryMoveOutInput,
  ControlRecoverySafetyInput,
  ControlRecoverySafetyResult,
} from './control-store-recovery.js';
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
/** Immutable native binding selected by the current Core recovery admission, not caller pathname text. */
export interface ControlRecoveryNativeBinding {
  readonly command: Omit<OpenCommand, 'operation'>;
  readonly path: string;
  readonly identity: string;
  readonly sourceDataRoot: string;
}
/** Transient per-call proof; never serialized, cached on an Opening or inherited by ordinary publishers. */
export interface ControlRecoveryNativeCall {
  readonly freeze: WorkspaceFrozenAdmission;
  readonly binding: ControlRecoveryNativeBinding;
}

const workspaceSchemaApplicationCall = Symbol('workspace-schema-application-call');

/** One exact schema application admitted by the current lifecycle freeze owner. */
interface ControlWorkspaceSchemaApplicationCall {
  readonly kind: 'workspace-schema-application';
  readonly [workspaceSchemaApplicationCall]: true;
  readonly freeze: WorkspaceFrozenAdmission;
  readonly workspaceId: string;
  readonly command: Omit<OpenCommand, 'operation'>;
  readonly path: string;
  readonly identity: string;
  readonly expectedHead: ControlKnowledgeHead;
  readonly nextHead: ControlKnowledgeHead;
  readonly requestId: string;
  readonly reportDigest: string;
  readonly statements: readonly ControlSqlStatement[];
}

type ControlFrozenNativeCall = ControlRecoveryNativeCall | ControlWorkspaceSchemaApplicationCall;
/** Native requests own release; the filesystem owner retains all physical admission semantics. */
type NativeCapacityReservation = Pick<FileStorageReservation, 'release'>;
/** Queued backing belongs to one database; host attribution preserves it after channel loss. */
interface DatabaseBacking {
  inputBytes: number;
  materialBytes: number;
}

/** One bounded native host; a failed host never restarts in this coordinator lifetime. */
interface WriterHost {
  worker: Worker | undefined;
  failed: boolean;
  /** Includes posted binary bytes whose channel failed until actual worker exit. */
  readonly backing: Map<string | undefined, DatabaseBacking>;
  pending: number;
  /** Disk forecasts survive failed transport until the worker actually exits. */
  readonly capacity: Set<NativeCapacityReservation>;
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
  readonly recovery?: ControlFrozenNativeCall;
  /** Unposted capture waiters share this same finite admission map and byte budget. */
  posted: boolean;
  /** The original admitted scope ACK gates posting after finite request admission. */
  ready: boolean;
  /** Binary input and echoed range content remain admitted until reply or known disposal. */
  readonly materialBytes: number;
  readonly inputBytes: number;
  readonly capacity: readonly NativeCapacityReservation[];
  readonly closeout?: CapabilityCloseoutCredit | undefined;
  cohort?: PendingCohort;
  readonly resolve: (reply: Success) => void;
  readonly reject: (
    error: ControlStoreWorkerError | PendingRequestCommandError | OperationError
  ) => void;
}

/** Exact live product publication; this is not retained state or permission to retry. */
interface ControlPublicationIdentity {
  readonly dataRoot: string;
  readonly workspaceId: string;
  readonly turnId: string;
}

/** Recognizes current decision Items and bounded terminal control projections. */
function isControlCapacityItem(item: ControlItemAppend['item']): boolean {
  return (
    item.type === 'approval-decision' ||
    item.type === 'user-input-response' ||
    (item.type === 'tool-call' && item.status !== 'in_progress') ||
    (item.type === 'status' && item.status !== 'in_progress')
  );
}

/** Only existing decision and terminal intents may consume the protected physical margin. */
function isControlCapacityCommand(command: ControlWorkerCommand): boolean {
  switch (command.operation) {
    case 'open':
      // Existing scopes must reopen for recovery and control closeout below the ordinary watermark.
      return !command.create;
    case 'terminal':
    case 'project-cleanup':
    case 'recovery-cleanup':
    case 'recovery-capture':
    case 'recovery-move-out':
    case 'recovery-history':
    case 'recovery-seal':
    case 'recovery-safety':
      return true;
    case 'item':
      return isControlCapacityItem(command.input.item);
    case 'event': {
      const data = command.input.event.data;
      return (
        data.type === 'turn-completed' ||
        data.type === 'approval-resolved' ||
        (data.type === 'turn-updated' &&
          data.turn.status !== 'pending' &&
          data.turn.status !== 'running') ||
        ((data.type === 'item-created' || data.type === 'item-completed') &&
          isControlCapacityItem(data.item))
      );
    }
    case 'publication':
      return command.input.category === 'already-decided-publication';
    case 'pending':
      return (
        command.input.admission === undefined &&
        [
          'deny',
          'answer',
          'withdraw',
          'invalidate',
          'grant-command',
          'claim',
          'claim-command',
          'refuse-command',
          'finish',
          'settle-unfinished',
          'delivery-prove',
          'delivery-release',
          'delivery-unknown',
          'freeze',
          'closeout',
          'associate-invalidation',
        ].includes(command.input.input.action)
      );
    case 'capability':
      return ['permission', 'usage-finish', 'finish', 'raw-settle', 'raw-invalidate'].includes(
        command.input.kind
      );
    case 'review':
      return ['judgement', 'select', 'decide', 'decision-receipt'].includes(command.input.mode);
    case 'goal':
      return [
        'goal.card.cancel',
        'goal.plan.approve',
        'goal.cancel',
        'goal.completion.accept',
      ].includes(command.input.command.operation);
    case 'journal':
      return command.input.kind === 'settle';
    default:
      return false;
  }
}

let singleton: ControlStoreWorkerClient | undefined;

/**
 * Returns the process-local writer coordinator, without opening a database.
 *
 * A failed native host is never restarted by this getter. Explicit shutdown must finish before a later call can start a new host; no request is replayed. A released product scope must transfer its complete producer and shared receipt closure before using this host. A legacy main writable handle is not a table-level access-control boundary.
 *
 * @returns Shared coordinator for admitted database scopes, never a synchronous SQL facade.
 */
export function getControlStoreWorkerClient(
  admission?: WorkspaceMutationAdmission
): ControlStoreWorkerClient {
  if (!isMainThread) throw new ControlStoreWorkerError('unavailable', 'not-committed');
  if (singleton === undefined || singleton.isClosed) singleton = new ControlStoreWorkerClient();
  if (admission) singleton.setWorkspaceMutationAdmission(admission);
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
    () => ({
      worker: undefined,
      failed: false,
      backing: new Map(),
      pending: 0,
      capacity: new Set(),
    })
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
  private readonly backing = new Map<string | undefined, DatabaseBacking>();
  private stopping = false;
  private closed = false;
  private shutdownPromise: Promise<void> | undefined;
  private backupHold: PostingHold | undefined;
  private readonly databaseHolds = new Map<string, PostingHold>();
  /** The application's one gate survives cold scope close/open for this native client lifetime. */
  private workspaceMutationAdmission: WorkspaceMutationAdmission | undefined;
  private readonly fileAdmissions = new Map<string, FileStorageAdmission>();
  private readonly walCapacity = new Map<
    string,
    { reservation: FileStorageReservation; users: number }
  >();

  /** Charges each database independently, with exact host ownership until ACK or actual exit. */
  private adjustBacking(
    database: string | undefined,
    inputBytes: number,
    materialBytes: number,
    host?: WriterHost
  ): void {
    for (const entries of host ? [this.backing, host.backing] : [this.backing]) {
      const current = entries.get(database) ?? { inputBytes: 0, materialBytes: 0 };
      current.inputBytes += inputBytes;
      current.materialBytes += materialBytes;
      if (current.inputBytes === 0 && current.materialBytes === 0) entries.delete(database);
      else entries.set(database, current);
    }
  }

  /** Binds the existing live file policy before native admission, including cold scope opens. */
  setFileStorageAdmission(dataRoot: string, admission: FileStorageAdmission): void {
    this.fileAdmissions.set(resolve(dataRoot), admission);
  }

  /** Holds actual filesystem capacity for native staging and its conservative bounded WAL growth. */
  private reserveCapacity(
    command: ControlWorkerCommand,
    opening: Opening | undefined,
    inputBytes: number,
    materialBytes: number,
    creditedCloseout: boolean
  ): readonly NativeCapacityReservation[] {
    if (['shutdown', 'close', 'checkpoint', 'reclaim'].includes(command.operation)) return [];
    const path = command.operation === 'open' ? command.path : opening?.path;
    const database = 'database' in command ? command.database : undefined;
    if (!path || database === undefined) return [];
    const root =
      command.operation === 'open'
        ? (command.dataRoot ?? dirname(path))
        : (opening?.command.dataRoot ?? dirname(path));
    let admission = this.fileAdmissions.get(resolve(root));
    if (!admission) {
      admission = new FileStorageAdmission(root, () => 1_000_000_000n);
      this.fileAdmissions.set(resolve(root), admission);
    }
    const entries: ControlProductEntry[] = [];
    switch (command.operation) {
      case 'products':
      case 'transition':
        entries.push(...command.transition.entries);
        break;
      case 'publication':
      case 'terminal':
        entries.push(...command.input.entries);
        break;
      case 'pending':
        entries.push(
          ...command.input.entries,
          ...(command.input.terminal?.entries ?? []),
          ...(command.input.admission?.entries ?? [])
        );
        break;
      case 'goal':
        entries.push(...(command.input.pendingAdmission?.entries ?? []));
        if (command.input.pendingItem) entries.push(command.input.pendingItem.entry);
        break;
      case 'review':
        if (command.input.mode === 'submit') entries.push(...command.input.transition.entries);
        break;
    }
    const stagingBytes = entries.reduce((sum, entry) => sum + BigInt(entry.content.byteLength), 0n);
    const priority = creditedCloseout || isControlCapacityCommand(command) ? 'control' : 'ordinary';
    const reservations: NativeCapacityReservation[] = [];
    try {
      let wal = this.walCapacity.get(database);
      if (!wal) {
        wal = {
          reservation: admission.forPath(path).reserve(
            {
              stagingBytes: 0n,
              extractionBytes: 0n,
              derivativeBytes: 0n,
              publicationBytes: BigInt(CONTROL_STORE_BUDGET.maxWalBytes),
            },
            priority
          ),
          users: 0,
        };
        this.walCapacity.set(database, wal);
      } else {
        // Every affected filesystem still needs capacity; ordinary borrowers also keep the margin.
        admission
          .forPath(path)
          .reserve(
            {
              stagingBytes: 0n,
              extractionBytes: 0n,
              derivativeBytes: 0n,
              publicationBytes: 0n,
            },
            priority
          )
          .release();
      }
      const shared = wal;
      shared.users += 1;
      let released = false;
      reservations.push({
        release: () => {
          if (released) return;
          released = true;
          if (--shared.users === 0) {
            shared.reservation.release();
            this.walCapacity.delete(database);
          }
        },
      });
      const contentRoot =
        command.operation === 'open'
          ? command.contentMount?.root
          : opening?.command.contentMount?.root;
      // Content may be a separate mount. Same-device forecasts still join the same pool.
      reservations.push(
        admission.forPath(contentRoot ?? path).reserve(
          {
            stagingBytes: stagingBytes + BigInt(inputBytes) + BigInt(materialBytes),
            extractionBytes: 0n,
            derivativeBytes: 0n,
            publicationBytes: 0n,
          },
          priority
        )
      );
      return reservations;
    } catch (error) {
      for (const reservation of reservations) reservation.release();
      throw error;
    }
  }

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
      for (const [database, bytes] of host.backing)
        this.adjustBacking(database, -bytes.inputBytes, -bytes.materialBytes);
      host.backing.clear();
      for (const reservation of host.capacity) reservation.release();
      host.capacity.clear();
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
        bytes > CONTROL_WORKER_LIMITS.pendingBytes - (this.backing.get(database)?.inputBytes ?? 0))
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
    this.adjustBacking(database, bytes, 0);
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
      this.adjustBacking(database, -bytes, 0);
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

  /** Checks the exact freeze and physical owner again at each trusted lifecycle submission. */
  private assertFrozenCall(
    command: ControlWorkerCommand,
    recovery: ControlFrozenNativeCall | undefined,
    opening?: Opening
  ): void {
    if (recovery === undefined) {
      const owner =
        command.operation === 'open'
          ? command.productOwner
          : (opening?.command.productOwner ??
            ('database' in command
              ? this.openings.get(command.database)?.command.productOwner
              : undefined));
      if (
        owner?.kind === 'workspace' &&
        this.workspaceMutationAdmission?.isClosed(owner.workspaceId, 'capture')
      )
        throw new OperationError('workspace_frozen', 'Workspace is temporarily frozen.', 409, {
          details: {
            workspaceId: owner.workspaceId,
            operation: 'capture',
            retryable: true,
            blockers: [
              {
                kind: 'publication',
                reason: 'frozen',
                reference: { workspaceId: owner.workspaceId },
                actions: [],
              },
            ],
          },
        });
      return;
    }
    if ('kind' in recovery) {
      try {
        const physical =
          opening ?? ('database' in command ? this.openings.get(command.database) : undefined);
        let admitted = physical?.command;
        if (command.operation === 'open') {
          const {
            operation: _operation,
            version: _version,
            id: _id,
            ...input
          } = command as Extract<ControlWorkerRequest, { operation: 'open' }>;
          admitted = input;
        }
        const current = statSync(recovery.path);
        if (
          recovery[workspaceSchemaApplicationCall] !== true ||
          recovery.kind !== 'workspace-schema-application' ||
          !this.workspaceMutationAdmission?.ownsFreeze(recovery.workspaceId, recovery.freeze) ||
          recovery.command.productOwner?.kind !== 'workspace' ||
          recovery.command.productOwner.workspaceId !== recovery.workspaceId ||
          recovery.command.database !== `workspace:${resolve(recovery.command.path)}` ||
          recovery.command.create !== false ||
          recovery.command.initialize !== 'workspace' ||
          realpathSync(recovery.command.path) !== recovery.path ||
          `${current.dev}:${current.ino}` !== recovery.identity ||
          (physical !== undefined &&
            (physical.path !== recovery.path || physical.identity !== recovery.identity)) ||
          !isDeepStrictEqual(recovery.command, admitted) ||
          !('database' in command) ||
          command.database !== recovery.command.database ||
          (command.operation !== 'open' &&
            (command.operation !== 'write' ||
              !isDeepStrictEqual(command.statements, recovery.statements)))
        )
          throw new Error('Workspace Schema application binding is not current.');
        return;
      } catch {
        throw new ControlStoreWorkerError('precondition', 'not-committed');
      }
    }
    try {
      const { binding, freeze } = recovery;
      const owner = binding.command.productOwner;
      const physical =
        opening ?? ('database' in command ? this.openings.get(command.database) : undefined);
      let admitted = physical?.command;
      if (command.operation === 'open') {
        // Request framing is assigned after admission; it is not part of the physical open binding.
        const {
          operation: _operation,
          version: _version,
          id: _id,
          ...input
        } = command as Extract<ControlWorkerRequest, { operation: 'open' }>;
        admitted = input;
      }
      const current = statSync(binding.path);
      if (
        owner?.kind !== 'workspace' ||
        !this.workspaceMutationAdmission?.isRecoveryBinding(owner.workspaceId, freeze, binding) ||
        !('database' in command) ||
        command.database !== binding.command.database ||
        binding.command.create !== false ||
        binding.command.initialize !== 'workspace' ||
        realpathSync(binding.command.path) !== binding.path ||
        `${current.dev}:${current.ino}` !== binding.identity ||
        (physical !== undefined &&
          (physical.path !== binding.path || physical.identity !== binding.identity)) ||
        !isDeepStrictEqual(binding.command, admitted) ||
        (command.operation === 'recovery-safety' &&
          resolve(command.input.sourceDataRoot) !== binding.sourceDataRoot)
      )
        throw new Error('Recovery binding is not current.');
    } catch {
      throw new ControlStoreWorkerError('precondition', 'not-committed');
    }
  }

  /**
   * Opens an admitted physical scope and optionally applies its existing native journal.
   *
   * @param command Trusted path/fresh-scope admission; app recovery is not bypassed.
   * Repeated access to the exact admitted binding shares its existing opening acknowledgement; it never reopens a scope or retries a failed command. Changed bindings and physical aliases still fail closed in the existing owner.
   *
   * @returns After connection policy and requested initialization have completed in the worker.
   */
  async open(
    command: Omit<OpenCommand, 'operation'>,
    recovery?: ControlRecoveryNativeCall
  ): Promise<void> {
    await this.openFrozen(command, recovery);
  }

  /** Internal open shared only by recovery and the exact schema-freeze composition. */
  private async openFrozen(
    command: Omit<OpenCommand, 'operation'>,
    recovery?: ControlFrozenNativeCall
  ): Promise<void> {
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
    this.assertFrozenCall({ ...command, operation: 'open' }, recovery);
    const existing = this.openings.get(command.database);
    if (existing) {
      if (existing.host.failed) throw new ControlStoreWorkerError('unavailable', 'not-committed');
      if (!isDeepStrictEqual(existing.command, command))
        throw new ControlStoreWorkerError('invalid-request', 'not-committed');
      await existing.promise;
      this.assertFrozenCall({ ...command, operation: 'open' }, recovery);
      return;
    }
    const binding = structuredClone(command);
    const physical = this.reserveOpening(binding);
    const opening: Opening = {
      command: binding,
      ...physical,
      acknowledged: false,
      promise: this.request(
        { ...binding, operation: 'open' },
        undefined,
        physical.host,
        false,
        recovery
      ).then(() => {
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
      }),
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
   * Opens one exact Workspace Schema application while its exclusive lifecycle freeze remains owned.
   *
   * The returned function can submit only the head CAS, original successful Audit and
   * original receipt that were bound here. The caller rechecks current human and Policy
   * authority after this awaited open and before it invokes the function. Ordinary
   * publishers remain closed, and each native boundary rechecks the live freeze and inode.
   *
   * @param input Exact physical owner and reviewed Schema application tuple.
   * @returns A single-use submitter for the already bound native tuple.
   */
  async openWorkspaceSchemaApplication(input: {
    readonly workspaceDb: WorkspaceDb;
    readonly command: Omit<OpenCommand, 'operation'>;
    readonly freeze: WorkspaceFrozenAdmission;
    readonly expectedHead: ControlKnowledgeHead;
    readonly nextHead: ControlKnowledgeHead;
    readonly audit: AuditEvent;
    readonly receipt: CommandRequestRecord;
    readonly reportDigest: string;
  }): Promise<() => Promise<void>> {
    const { workspaceDb: db, expectedHead, nextHead, receipt, audit } = input;
    const command = structuredClone(input.command);
    const path = realpathSync(command.path);
    const current = statSync(path);
    if (
      !this.workspaceMutationAdmission?.ownsFreeze(db.workspaceId, input.freeze) ||
      db.scope !== 'workspace' ||
      !db.sqlite.open ||
      db.sqlite.inTransaction ||
      resolve(db.sqlite.name) !== resolve(path) ||
      typeof command.dataRoot !== 'string' ||
      resolve(command.dataRoot) !== resolve(db.dataRoot) ||
      command.database !== `workspace:${resolve(command.path)}` ||
      command.productOwner?.kind !== 'workspace' ||
      command.productOwner.workspaceId !== db.workspaceId ||
      command.create !== false ||
      command.initialize !== 'workspace' ||
      expectedHead.workspaceId !== db.workspaceId ||
      nextHead.workspaceId !== db.workspaceId ||
      nextHead.knowledgeBaseId !== expectedHead.knowledgeBaseId ||
      !/^sha256:[a-f0-9]{64}$/.test(input.reportDigest) ||
      receipt.command !== 'knowledge.schema.apply' ||
      receipt.requestId !== audit.requestId ||
      receipt.response.kind !== 'knowledge_schema_report' ||
      receipt.response.id !== input.reportDigest ||
      audit.workspaceId !== db.workspaceId ||
      audit.category !== 'knowledge' ||
      audit.action !== 'knowledge.schema.apply' ||
      audit.outcome !== 'succeeded' ||
      audit.resource !== `knowledge-schema-report:${input.reportDigest}`
    )
      throw new ControlStoreWorkerError('precondition', 'not-committed');
    const statements = Object.freeze([
      ...controlKnowledgeHeadStatements(nextHead, expectedHead),
      prepareAuditEventStatement(audit),
      prepareControlCommandRequestStatement(db.workspaceId, receipt),
    ]);
    const application: ControlWorkspaceSchemaApplicationCall = Object.freeze({
      kind: 'workspace-schema-application',
      [workspaceSchemaApplicationCall]: true as const,
      freeze: input.freeze,
      workspaceId: db.workspaceId,
      command,
      path,
      identity: `${current.dev}:${current.ino}`,
      expectedHead: structuredClone(expectedHead),
      nextHead: structuredClone(nextHead),
      requestId: receipt.requestId,
      reportDigest: input.reportDigest,
      statements,
    });
    await this.openFrozen(command, application);
    let submitted = false;
    return async () => {
      if (submitted) throw new ControlStoreWorkerError('precondition', 'not-committed');
      submitted = true;
      await this.writeFrozen(command.database, statements, application);
    };
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
    statements: readonly ControlSqlStatement[],
    recovery?: ControlRecoveryNativeCall
  ): Promise<readonly ControlSqlResult[]> {
    return this.writeFrozen(database, statements, recovery);
  }

  /** Internal write shared only by recovery and the exact schema-freeze composition. */
  private async writeFrozen(
    database: string,
    statements: readonly ControlSqlStatement[],
    recovery?: ControlFrozenNativeCall
  ): Promise<readonly ControlSqlResult[]> {
    const reply = await this.request(
      { operation: 'write', database, statements },
      undefined,
      undefined,
      false,
      recovery
    );
    return (reply as Extract<Success, { operation: 'write' }>).results;
  }

  /** Advances one original captured history unit and acknowledges only its native covering commit. */
  async recoveryHistory(
    database: string,
    workspaceId: string,
    recovery?: ControlRecoveryNativeCall
  ): Promise<boolean> {
    const reply = await this.request(
      { operation: 'recovery-history', database, workspaceId },
      undefined,
      undefined,
      false,
      recovery
    );
    return (reply as Extract<Success, { operation: 'recovery-history' }>).done;
  }

  /** Copies proved current safety into an admitted private candidate, acknowledged only after FULL COMMIT. */
  async recoverySafety(
    database: string,
    input: ControlRecoverySafetyInput,
    recovery?: ControlRecoveryNativeCall
  ): Promise<ControlRecoverySafetyResult> {
    const reply = await this.request(
      { operation: 'recovery-safety', database, input },
      undefined,
      undefined,
      false,
      recovery
    );
    return (reply as Extract<Success, { operation: 'recovery-safety' }>).result;
  }

  /** Commits the exact source MOVE tuple and original Audit before acknowledging its covering FULL commit. */
  async recoveryMoveOut(
    database: string,
    input: ControlRecoveryMoveOutInput,
    recovery?: ControlRecoveryNativeCall
  ): Promise<void> {
    await this.request(
      { operation: 'recovery-move-out', database, input },
      undefined,
      undefined,
      false,
      recovery
    );
  }

  /** Ends exactly one capture through its original SQL owner; acknowledgement follows covering FULL COMMIT. */
  async recoveryCapture(
    database: string,
    input: ControlRecoveryCaptureInput,
    recovery?: ControlRecoveryNativeCall
  ): Promise<void> {
    await this.request(
      { operation: 'recovery-capture', database, input },
      undefined,
      undefined,
      false,
      recovery
    );
  }

  /** Cleans an admitted private recovery candidate through the existing native transaction and FULL ACK. */
  async recoveryCleanup(
    database: string,
    input: ControlRecoveryCleanupInput,
    recovery?: ControlRecoveryNativeCall
  ): Promise<void> {
    await this.request(
      { operation: 'recovery-cleanup', database, input },
      undefined,
      undefined,
      false,
      recovery
    );
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

  /** Publishes an addressed Item only after its native head checks, exact bytes and covering FULL commit. */
  async appendItem(database: string, input: ControlItemAppend): Promise<ControlItemAppend['item']> {
    try {
      const reply = await this.request({ operation: 'item', database, input });
      return (reply as Extract<Success, { operation: 'item' }>).result;
    } catch (error) {
      if (
        error instanceof ControlStoreWorkerError &&
        error.commit === 'not-committed' &&
        error.domain?.operation === 'item'
      )
        throw new Error(error.domain.message);
      throw error;
    }
  }

  /** Publishes one event intent after native sequence allocation and its covering FULL commit. */
  async appendEvent(
    database: string,
    input: ControlEventAppend
  ): Promise<ControlEventAppendResult> {
    try {
      const reply = await this.request({
        operation: 'event',
        database,
        input: ControlEventAppendSchema.parse(input),
      });
      return (reply as Extract<Success, { operation: 'event' }>).result;
    } catch (error) {
      if (
        error instanceof ControlStoreWorkerError &&
        error.commit === 'not-committed' &&
        error.domain?.operation === 'event'
      )
        throw new Error(error.domain.message);
      throw error;
    }
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
      (this.backing.get(database)?.inputBytes ?? 0) + bytes > CONTROL_WORKER_LIMITS.pendingBytes
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
              CONTROL_WORKER_LIMITS.materialPendingBytes -
                (this.backing.get(database)?.materialBytes ?? 0)))
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
  async close(database: string, recovery?: ControlRecoveryNativeCall): Promise<void> {
    this.assertFrozenCall({ operation: 'close', database }, recovery);
    const opening = this.openings.get(database);
    try {
      // Idle readers must not prevent the writer's final close from checkpointing at rest.
      if (opening) closeWorkspaceProductReadHandles(opening.path);
      await this.request({ operation: 'close', database }, undefined, undefined, false, recovery);
      if (this.openings.get(database) === opening) this.openings.delete(database);
    } finally {
      if (opening) closeWorkspaceProductReadHandles(opening.path);
    }
  }

  /** Closes the admitted private candidate before sealing; null proves close but never a usable seal. */
  async sealRecovery(
    database: string,
    recovery?: ControlRecoveryNativeCall
  ): Promise<string | null> {
    this.assertFrozenCall({ operation: 'recovery-seal', database }, recovery);
    const opening = this.openings.get(database);
    try {
      // The caller excludes new publishers. Accepted same-Turn producers can still be waiting
      // to post, so join their existing tails before the native close/drain boundary.
      const path = opening && realpathSync(opening.path);
      const accepted = [...this.turnTails].filter(([key]) => JSON.parse(key)[0] === path);
      const settled = await Promise.allSettled(accepted.map(([, entry]) => entry.tail));
      const failed = settled.find((result) => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
      if (opening) closeWorkspaceProductReadHandles(opening.path);
      const reply = await this.request(
        { operation: 'recovery-seal', database },
        undefined,
        undefined,
        false,
        recovery
      );
      if (this.openings.get(database) === opening) this.openings.delete(database);
      return (reply as Extract<Success, { operation: 'recovery-seal' }>).digest;
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
  /** Binds the application's same gate without creating a native host, connection or hold. */
  setWorkspaceMutationAdmission(admission: WorkspaceMutationAdmission): void {
    if (this.workspaceMutationAdmission && this.workspaceMutationAdmission !== admission)
      throw new Error('Native client already has a different Workspace mutation owner.');
    this.workspaceMutationAdmission = admission;
  }

  /** Installs the existing target hold without joining a competing target or global hold. Only posted ACKs may settle. */
  tryPauseForWorkspaceCapture(
    database: string,
    admission?: WorkspaceMutationAdmission
  ): Promise<() => void> | null {
    if (this.backupHold || this.databaseHolds.has(database)) return null;
    if (admission) this.setWorkspaceMutationAdmission(admission);
    return this.pauseForDataRootBackup(database);
  }

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
        // Accepted ACK continuations have finished; release readers before final writer close.
        closeWorkspaceProductReadHandles();
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
        for (const host of this.hosts) {
          this.fail(host);
          for (const reservation of host.capacity) reservation.release();
          host.capacity.clear();
        }
        this.backing.clear();
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
    deferPost = false,
    recovery?: ControlFrozenNativeCall
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
      (command.operation === 'products' ||
        command.operation === 'publication' ||
        command.operation === 'item');
    const opening = database === undefined ? undefined : this.openings.get(database);
    try {
      this.assertFrozenCall(command, recovery, opening);
    } catch (error) {
      return Promise.reject(error);
    }
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
      (this.backing.get(database)?.inputBytes ?? 0) + inputBytes >
        CONTROL_WORKER_LIMITS.pendingBytes
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
          materialBytes >
            CONTROL_WORKER_LIMITS.materialPendingBytes -
              (this.backing.get(database)?.materialBytes ?? 0))
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
    let capacity: readonly NativeCapacityReservation[];
    try {
      capacity = this.reserveCapacity(
        command,
        opening,
        inputBytes,
        materialBytes,
        closeout !== undefined || !!creditedPublication
      );
    } catch (error) {
      return Promise.reject(
        error instanceof FileAdmissionError
          ? new ControlStoreWorkerError('no-space', 'not-committed')
          : error
      );
    }
    let worker: Worker;
    try {
      worker = this.startWorker(host);
    } catch {
      for (const reservation of capacity) reservation.release();
      this.fail(host);
      return Promise.reject(new ControlStoreWorkerError('unavailable', 'not-committed'));
    }
    const id = this.nextId++;
    const result = new Promise<Success>((resolve, reject) => {
      this.adjustBacking(database, inputBytes, materialBytes, host);
      host.pending += 1;
      for (const reservation of capacity) host.capacity.add(reservation);
      if (closeout) closeout.borrowing = true;
      const entry: Pending = {
        counted: !borrowed,
        host,
        command: admittedRequest,
        request: admittedRequest,
        ...(recovery ? { recovery } : {}),
        posted: false,
        ready: ready === undefined,
        materialBytes,
        inputBytes,
        capacity,
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
    // Drain ordinary request settlement without promoting its caller-owned error to shutdown.
    // Opening-dependent requests retain their original shutdown failure reporting.
    const operation =
      ready === undefined
        ? result.then(
            () => undefined,
            () => undefined
          )
        : result;
    this.operations.set(operation, undefined);
    const release = () => this.operations.delete(operation);
    void operation.then(release, release);
    return result;
  }

  /** Posts an admitted message once, after its scope ACK and any data-root capture hold. */
  private post(entry: Pending): void {
    if (entry.posted) return;
    const opening =
      'database' in entry.command ? this.openings.get(entry.command.database) : undefined;
    try {
      this.assertFrozenCall(entry.command, entry.recovery, opening);
    } catch (error) {
      const members = entry.cohort?.frame.requests.map(
        (request) => this.pending.get(request.id)!
      ) ?? [entry];
      for (const member of members)
        this.complete(
          member.request.id,
          undefined,
          error as ControlStoreWorkerError | OperationError
        );
      return;
    }
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
    try {
      for (const member of members)
        this.assertFrozenCall(
          member.command,
          member.recovery,
          'database' in member.command ? this.openings.get(member.command.database) : undefined
        );
    } catch (error) {
      for (const member of members)
        this.complete(
          member.request.id,
          undefined,
          error as ControlStoreWorkerError | OperationError
        );
      return;
    }
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
    error?: ControlStoreWorkerError | PendingRequestCommandError | OperationError,
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
      this.adjustBacking(
        'database' in entry.command ? entry.command.database : undefined,
        -releasedInputBytes,
        -entry.materialBytes,
        entry.host
      );
      for (const reservation of entry.capacity) {
        reservation.release();
        entry.host.capacity.delete(reservation);
      }
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
