import { channel } from 'node:diagnostics_channel';
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { isMainThread, parentPort } from 'node:worker_threads';
import { writeRetainedV1 } from '@openkit/protocol';
import Database from 'better-sqlite3';
import {
  ArtifactReviewError,
  applyControlReviewCommand,
  type PreparedControlReviewCommand,
  prepareControlReviewCommand,
  readControlReviewMaterialId,
} from '../artifact-reviews.js';
import { applyControlMaintenanceAdmission } from '../knowledge/knowledge-agent-maintenance.js';
import { NotebookError } from '../knowledge/notebook.js';
import { OperationError, projectControlCapabilityFailure } from '../operation-error.js';
import {
  applyControlExecutionJournal,
  decodeExecutionJournalIntent,
  decodeExecutionJournalSettlement,
  readExecutionJournalRoot,
} from '../runtime/execution-journal.js';
import {
  advanceGoalRevision,
  applyControlGoalCommand,
  GoalCommandError,
  type PreparedControlGoalCommand,
  prepareControlGoalCommand,
} from '../runtime/goal-owner.js';
import { StoredGoalCompletionCandidateV1Schema } from '../runtime/goal-retained-v1.js';
import { IdempotencyKeyConflictError } from '../runtime/idempotent-command.js';
import type {
  ControlPendingCommandInput,
  PreparedControlPendingCommand,
} from '../runtime/pending-requests.js';
import {
  applyControlPendingCommand,
  assertControlPendingArchive,
  PendingRequestCommandError,
  pendingRequestItemId,
  readPendingRequest,
} from '../runtime/pending-requests.js';
import {
  ProjectWorkerBackendCleanupInputSchema,
  projectWorkerBackendCleanupInDb,
} from '../runtime/worker-backend-cleanup-projection.js';
import { WorkerRawOutputAuthorityError } from '../runtime/worker-raw-output.js';
import {
  applyControlMaterialCommand,
  type ControlMaterialCommandInput,
  prepareControlMaterialCommand,
  WorkspaceMaterialError,
} from '../workspace-materials.js';
import {
  ControlStoreBusyError,
  ControlStoreNoSpaceError,
  controlStoreFor,
} from './control-store.js';
import { applyControlAdmission } from './control-store-admission.js';
import {
  applyControlCapabilityCommand,
  type ControlCapabilityCommandInput,
  prepareControlCapabilityCommand,
  tryControlCapabilityReuse,
} from './control-store-capability.js';
import {
  applyControlPendingTransition,
  prepareControlPendingArchive,
  prepareControlPendingCommands,
} from './control-store-pending.js';
import type { ControlContentPreparation } from './control-store-products.js';
import {
  applyControlProducts,
  applyControlPublication,
  applyControlTerminal,
  ControlItemAppendError,
  type ControlProductContentMount,
  type ControlProductOwner,
  ControlProductPreconditionError,
  type ControlProductTransition,
  type ControlPublicationInput,
  type ControlTerminalTransition,
  decode as decodeControlProduct,
  type PreparedControlEntry,
  type PreparedControlPublication,
  type PreparedControlTerminal,
  prepareControlEntries,
  prepareControlEventAppend,
  prepareControlItemAppend,
  prepareControlPublication,
  prepareControlTerminal,
  readProduct,
} from './control-store-products.js';
import {
  applyControlRecoveryCleanup,
  applyControlRecoverySafety,
  type PreparedControlRecoverySafety,
  prepareControlRecoverySafety,
} from './control-store-recovery.js';
import {
  CONTROL_WORKER_LIMITS,
  CONTROL_WORKER_VERSION,
  type ControlSqlResult,
  type ControlSqlRow,
  type ControlSqlStatement,
  type ControlSqlValue,
  type ControlWorkerDomainRefusal,
  type ControlWorkerFailureCode,
  type ControlWorkerReply,
  type ControlWorkerRequest,
  controlWorkerInputBytes,
  hasControlSqlRollback,
  isControlProductCohort,
  isControlWorkerReply,
  isControlWorkerRequest,
} from './control-store-worker-protocol.js';
import { bindCoreSqlite, bindWorkspaceSqlite, type CoreDb, type WorkspaceDb } from './db.js';
import { coreDbPath, workspaceDbPath } from './fs-layout.js';
import { prepareRetainedProductJson } from './immutable-content.js';
import { applyNativeScopeMigrations } from './migrate.js';
import { applyControlWorkObservation } from './work-observations.js';

if (isMainThread || parentPort === null) {
  throw new Error('The database writer entrypoint requires a dedicated worker thread.');
}
const port = parentPort;

/** A queued transition, not a durable request or a second command receipt. */
type WriteCommand = Extract<
  ControlWorkerRequest,
  {
    operation:
      | 'write'
      | 'recovery-cleanup'
      | 'recovery-safety'
      | 'transition'
      | 'products'
      | 'item'
      | 'event'
      | 'publication'
      | 'project-cleanup'
      | 'observation'
      | 'capability'
      | 'pending'
      | 'journal'
      | 'goal'
      | 'maintenance'
      | 'material'
      | 'review'
      | 'terminal';
  }
>;

/** One slot is reserved before preparation; readiness never changes admitted causal order. */
type WriteRequest = WriteCommand & {
  readonly lanes: ReadonlySet<string>;
  /** Existing opaque SQL and archive commands retain their database-wide ordering boundary. */
  readonly barrier: boolean;
  readonly settled: Promise<void>;
  readonly finish: () => void;
  /** Membership only; all members occupy the same existing pending array. */
  readonly cohort?: { readonly size: number; readonly immediate: boolean } | undefined;
  preparation?: Promise<void>;
  ready: boolean;
  predecessorFailed: boolean;
  refusal?: ControlWorkerReply;
  readonly preparedPublication?: PreparedControlPublication | undefined;
  readonly preparedEvent?: Awaited<ReturnType<typeof prepareControlEventAppend>> | undefined;
  readonly preparedItem?: Awaited<ReturnType<typeof prepareControlItemAppend>> | undefined;
  readonly itemPublication?: ControlPublicationInput | undefined;
  readonly preparedEntries?: readonly PreparedControlEntry[] | undefined;
  readonly preparedPending?: PreparedControlPendingCommand | undefined;
  readonly preparedGoal?: PreparedControlGoalCommand | undefined;
  readonly preparedMaterial?: ControlMaterialCommandInput | undefined;
  readonly preparedCapability?: ControlCapabilityCommandInput | undefined;
  readonly preparedReview?: PreparedControlReviewCommand | undefined;
  readonly preparedTerminal?: PreparedControlTerminal | undefined;
  readonly preparedRecoverySafety?: PreparedControlRecoverySafety | undefined;
  /** Verified NEW parent paths are synchronized once for this request's actual selected SQL batch. */
  readonly preparedDirectories?: readonly string[];
  readonly preparedPublications?: readonly string[];
};

/** One worker-owned writable connection and its finite, disposable pending work. */
interface OwnedDatabase {
  readonly sqlite: Database.Database;
  /** Concrete domain handle, including ORM access on this exact worker-owned connection. */
  readonly scopeDb: CoreDb | WorkspaceDb | undefined;
  readonly writer: ReturnType<typeof controlStoreFor>;
  readonly path: string;
  readonly identity: string;
  readonly productOwner: ControlProductOwner | undefined;
  readonly contentMount: ControlProductContentMount | undefined;
  readonly pending: WriteRequest[];
  readonly publications: ControlContentPreparation['publications'];
  /** Accepted native-local preparation shares this finite scope lifetime, before SQL. */
  readonly preparations: Set<Promise<void>>;
  closing: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  immediate: ReturnType<typeof setImmediate> | null;
  poisoned: boolean;
}

const databases = new Map<string, OwnedDatabase>();
const paths = new Set<string>();
const identities = new Set<string>();
const pendingIds = new Set<number>();
let stopping = false;

/** Drops one request's references without discarding work still joined by another admitted request. */
function releaseContentPublications(
  publications: ControlContentPreparation['publications'],
  paths: Iterable<string>
): void {
  for (const path of paths) {
    const publication = publications.get(path);
    if (publication && --publication.references === 0) publications.delete(path);
  }
}

/** Refusal waits for every started file operation before releasing its bounded native lifetime. */
async function releaseContentPreparation(preparation: ControlContentPreparation): Promise<void> {
  await Promise.allSettled(
    [...preparation.published].map((path) => preparation.publications.get(path)?.result)
  );
  releaseContentPublications(preparation.publications, preparation.published);
}

/** Marks a failed SQL condition without leaking statement text or bound data. */
class PreconditionError extends Error {}

/** Posts a reply without claiming that an absent acknowledgement implies rollback. */
function reply(value: ControlWorkerReply): void {
  pendingIds.delete(value.id);
  port.postMessage(value);
}

/** Sends only closed error facts; native diagnostics can contain secrets in SQL bindings. */
function failure(
  id: number,
  code: ControlWorkerFailureCode,
  commit: 'not-committed' | 'unknown' = 'not-committed'
): Extract<ControlWorkerReply, { status: 'error' }> {
  return { version: CONTROL_WORKER_VERSION, id, status: 'error', code, commit };
}

/** Projects only declared owner refusals; SQLite diagnostics never enter this trusted projection. */
function domainRefusal(operation: string, error: unknown): ControlWorkerDomainRefusal | undefined {
  let domain: ControlWorkerDomainRefusal | undefined;
  if ((operation === 'item' || operation === 'event') && error instanceof ControlItemAppendError)
    return { operation, code: 'conflict', message: error.message, status: 409 };
  if (
    (operation === 'pending' ||
      (['products', 'transition'].includes(operation) &&
        error instanceof PendingRequestCommandError &&
        ['request_executing', 'thread_busy', 'conflict'].includes(error.code))) &&
    (error instanceof PendingRequestCommandError || error instanceof IdempotencyKeyConflictError)
  )
    return {
      operation: operation as 'pending' | 'products' | 'transition',
      code: error.code,
      message: error.message,
      status: error.status,
    };
  // Retained format refusal is a fixed owner message, not an arbitrary TypeError diagnostic.
  if (
    (operation === 'goal' || operation === 'capability') &&
    error instanceof TypeError &&
    error.message === 'Unsupported retained record format.'
  ) {
    domain = {
      operation,
      code: 'unsupported_retained_format',
      message: 'Unsupported retained record format.',
      status: 409,
    };
  } else if (
    operation === 'goal' &&
    (error instanceof GoalCommandError || error instanceof IdempotencyKeyConflictError)
  ) {
    domain = { operation, code: error.code, message: error.message, status: error.status };
  } else if (operation === 'capability') {
    const projected = projectControlCapabilityFailure(error);
    if (projected) domain = { operation, ...projected };
    else if (error instanceof PendingRequestCommandError)
      domain = {
        operation,
        kind: 'pending',
        code: error.code,
        message: error.message,
        status: error.status,
      };
    else if (error instanceof GoalCommandError || error instanceof IdempotencyKeyConflictError)
      domain = { operation, code: error.code, message: error.message, status: error.status };
  } else if (
    operation === 'material' &&
    (error instanceof WorkspaceMaterialError ||
      error instanceof OperationError ||
      error instanceof IdempotencyKeyConflictError)
  ) {
    domain = { operation, code: error.code, message: error.message, status: error.status };
  } else if (
    operation === 'review' &&
    (error instanceof ArtifactReviewError || error instanceof IdempotencyKeyConflictError)
  ) {
    domain = { operation, code: error.code, message: error.message, status: error.status };
  } else if (operation === 'maintenance') {
    if (error instanceof IdempotencyKeyConflictError)
      domain = { operation, code: error.code, message: error.message, status: error.status };
    else if (
      error instanceof NotebookError &&
      (error.code === 'invalid_request' || error.code === 'recovery_required')
    )
      domain = {
        operation,
        code: error.code,
        message: new NotebookError(error.code).message,
        status: error.code === 'invalid_request' ? 400 : 409,
      };
  }
  return domain && isControlWorkerReply({ ...failure(0, 'precondition'), domain })
    ? domain
    : undefined;
}

const refusalObservation = channel('openkit.control-store.refusal');
/** Passive LOAD observation only; no SQL, paths, bodies or changed refusal semantics. */
function observeRefusal(
  ids: readonly number[],
  origin: 'checkpoint-pressure' | 'sqlite-lock' | 'queue-count' | 'cohort-bytes',
  scope: 'request' | 'batch',
  databasePending?: number
): void {
  if (refusalObservation.hasSubscribers)
    refusalObservation.publish({
      ids,
      origin,
      scope,
      at: performance.timeOrigin + performance.now(),
      pending: pendingIds.size,
      databasePending,
    });
}

/** Classifies a native failure without publishing its message, SQL or parameters. */
function failureCode(
  error: unknown,
  ids: readonly number[] = [],
  scope: 'request' | 'batch' = 'request'
): ControlWorkerFailureCode {
  if (refusalObservation.hasSubscribers && ids.length) {
    const cause =
      error instanceof OperationError && error.code === 'usage_record_failed' ? error.cause : error;
    if (cause instanceof ControlStoreBusyError) observeRefusal(ids, 'checkpoint-pressure', scope);
    else if (
      cause !== null &&
      typeof cause === 'object' &&
      'code' in cause &&
      typeof cause.code === 'string' &&
      /^(SQLITE_BUSY|SQLITE_LOCKED)(_|$)/.test(cause.code)
    )
      observeRefusal(ids, 'sqlite-lock', scope);
  }
  if (
    error instanceof PreconditionError ||
    error instanceof ControlProductPreconditionError ||
    error instanceof WorkerRawOutputAuthorityError
  )
    return 'precondition';
  if (error instanceof ControlStoreBusyError) return 'busy';
  if (error instanceof ControlStoreNoSpaceError) return 'no-space';
  // The usage owner preserves its original SQLite cause; corruption still poisons this handle.
  const failure =
    error instanceof OperationError &&
    error.code === 'usage_record_failed' &&
    error.cause instanceof Database.SqliteError
      ? error.cause
      : error;
  const code =
    failure !== null && typeof failure === 'object' && 'code' in failure ? failure.code : null;
  if (code === 'ENOSPC' || code === 'SQLITE_FULL') return 'no-space';
  if (code === 'migration_missing' || code === 'migration_failed') return code;
  if (code === 'SQLITE_NOTADB' || (typeof code === 'string' && code.startsWith('SQLITE_CORRUPT')))
    return 'integrity';
  if (typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT')) return 'constraint';
  if (typeof code === 'string' && /^(SQLITE_BUSY|SQLITE_LOCKED)(_|$)/.test(code)) return 'busy';
  return 'sql-failed';
}

/** Accepts only cloneable SQLite scalars, with binary values restored to native buffers. */
function parameter(value: ControlSqlValue): string | number | bigint | Buffer | null {
  return value instanceof Uint8Array ? Buffer.from(value) : value;
}

/**
 * Executes the whole read/check/write body without a main-thread round trip.
 *
 * Conditions, dependent records and the original request receipt must be in this one program. SQL must bound row work and returned values; get materializes at most one row. No iterator, transaction callback or external wait can escape.
 */
function apply(
  sqlite: Database.Database,
  statements: readonly ControlSqlStatement[]
): ControlSqlResult[] {
  return statements.map((step) => {
    const statement = sqlite.prepare(step.sql).safeIntegers(true);
    const parameters = step.parameters.map(parameter);
    if (step.mode === 'run') {
      const result = statement.run(...parameters);
      if (step.expectChanges !== undefined && result.changes !== step.expectChanges) {
        throw new PreconditionError();
      }
      return { mode: 'run', ...result };
    }
    const row = statement.get(...parameters) as ControlSqlRow | undefined;
    if (
      (step.expectRow === 'present' && row === undefined) ||
      (step.expectRow === 'absent' && row !== undefined)
    ) {
      throw new PreconditionError();
    }
    return { mode: 'get', row: row ?? null };
  });
}

/** Clears only this owner's scheduling handles; no other Workspace is paused. */
function unschedule(owner: OwnedDatabase): void {
  if (owner.timer !== null) clearTimeout(owner.timer);
  if (owner.immediate !== null) clearImmediate(owner.immediate);
  owner.timer = null;
  owner.immediate = null;
}

/** Identifies existing standalone metadata tuples; complete closeout uses the terminal/Pending owner. */
function archivedThreads(request: WriteCommand): string[] {
  return request.operation === 'products' || request.operation === 'transition'
    ? request.transition.products
        .filter((input) => input.kind === 'thread' && input.record.status === 'archived')
        .map((input) => String(input.record.id))
    : [];
}

/** Collects only actions which publish or associate state with the named Turn. */
function pendingTurns(command: ControlPendingCommandInput, turns: Set<string>): void {
  if (command.action === 'raise') turns.add(command.input.raisingTurnId);
  else if (command.action === 'closeout') turns.add(command.closeoutTurnId);
  else if ('turnId' in command) turns.add(command.turnId);
}

/** Derives native Turn and AgentSession ordering lanes from executed owners, never read-only provenance. */
function requestLanes(owner: OwnedDatabase, request: WriteCommand): ReadonlySet<string> {
  const lanes = new Set<string>();
  const add = (transition: Pick<ControlProductTransition, 'products' | 'entries'>) => {
    for (const product of transition.products) {
      if (product.kind !== 'turn') continue;
      if (!owner.productOwner) throw new ControlProductPreconditionError();
      const turn = decodeControlProduct('turn', product.record, owner.productOwner);
      lanes.add(turn.id as string);
      if (typeof turn.agentSessionId === 'string') lanes.add(`session:${turn.agentSessionId}`);
    }
    for (const product of transition.products) {
      if (product.kind !== 'agent-session') continue;
      if (!owner.productOwner) throw new ControlProductPreconditionError();
      lanes.add(
        `session:${decodeControlProduct('agent-session', product.record, owner.productOwner).id}`
      );
    }
    for (const entry of transition.entries) lanes.add(entry.turnId);
  };
  const pending = (commands: readonly ControlPendingCommandInput[] = []) => {
    for (const command of commands) pendingTurns(command, lanes);
  };
  const terminal = (input: ControlTerminalTransition) => {
    add({ products: [input.turn, ...input.products], entries: input.entries });
    pending(input.pending);
  };
  const journal = (input: Extract<WriteCommand, { operation: 'journal' }>['input']) => {
    if (input.kind === 'intent') {
      lanes.add(decodeExecutionJournalIntent(input.inputJson).execution.workId);
      return;
    }
    if (!owner.scopeDb) throw new ControlProductPreconditionError();
    const ref = decodeExecutionJournalSettlement(input.inputJson).ref.execution;
    let workId: string | undefined;
    if (owner.sqlite.prepare('SELECT 1 FROM control_executions WHERE id=?').get(ref.executionId))
      workId = readExecutionJournalRoot(owner.scopeDb, ref).workId;
    // An earlier admitted intent is a causal dependency, never a replacement for its SQL root.
    for (const earlier of owner.pending) {
      const intents =
        earlier.operation === 'products'
          ? (earlier.transition.journalIntents ?? [])
          : earlier.operation === 'journal' && earlier.input.kind === 'intent'
            ? [earlier.input.inputJson]
            : [];
      for (const json of intents) {
        const execution = decodeExecutionJournalIntent(json).execution;
        if (!isDeepStrictEqual(execution.ref, ref)) continue;
        if (workId !== undefined && workId !== execution.workId)
          throw new ControlProductPreconditionError();
        workId = execution.workId;
      }
    }
    if (workId === undefined) throw new ControlProductPreconditionError();
    lanes.add(workId);
  };
  switch (request.operation) {
    case 'item':
    case 'event': {
      const turnId =
        request.operation === 'item' ? request.input.item.turnId : request.input.turnId;
      lanes.add(turnId);
      if (!owner.productOwner) throw new ControlProductPreconditionError();
      const turn = readProduct(owner.sqlite, owner.productOwner, 'turn', turnId);
      if (typeof turn?.record.agentSessionId === 'string')
        lanes.add(`session:${turn.record.agentSessionId}`);
      break;
    }
    case 'transition':
    case 'products':
      add(request.transition);
      pending(request.transition.pending);
      if (request.operation === 'products')
        for (const inputJson of request.transition.journalIntents ?? [])
          journal({ kind: 'intent', inputJson });
      break;
    case 'review':
      if (request.input.mode === 'submit') {
        add({ products: [], entries: request.input.transition.entries });
        if (request.input.artifact.origin.kind === 'turn-output')
          lanes.add(request.input.artifact.origin.turnId);
      }
      break;
    case 'pending':
      add(request.input);
      pending([request.input.input]);
      if (request.input.admission) add(request.input.admission);
      if (request.input.terminal) terminal(request.input.terminal);
      break;
    case 'terminal':
      terminal(request.input);
      break;
    case 'publication':
    case 'observation':
    case 'project-cleanup':
    case 'maintenance':
      lanes.add(request.input.turnId);
      break;
    case 'capability': {
      const input = request.input;
      const addCall = (callId: string) => {
        const call = owner.sqlite
          .prepare('SELECT turn_id, agent_session_id FROM capability_calls WHERE call_id=?')
          .get(callId) as
          | {
              turn_id: string | null;
              agent_session_id: string | null;
            }
          | undefined;
        if (call?.turn_id) lanes.add(call.turn_id);
        if (call?.agent_session_id) lanes.add(`session:${call.agent_session_id}`);
      };
      if (input.kind === 'finish' || input.kind === 'attribution') {
        addCall(input.callId);
        break;
      }
      if (input.kind === 'participant-audit') {
        if (input.event.capabilityCallId) addCall(input.event.capabilityCallId);
        if (input.event.turnId) lanes.add(input.event.turnId);
        if (input.event.agentSessionId) lanes.add(`session:${input.event.agentSessionId}`);
        const process = input.event.policyInvocation?.subject.process;
        if (process) lanes.add(process.turnId);
        break;
      }
      const context =
        input.kind === 'mcp-schema'
          ? input.environmentPackage.scope
          : input.kind === 'checkpoint'
            ? input.input
            : input.kind === 'admit'
              ? input.context
              : input.kind === 'usage-finish'
                ? input.call.context
                : input.kind === 'permission'
                  ? (input.decision.mediation?.subject.process ?? input.decision.contextSummary)
                  : input;
      if (typeof context?.turnId === 'string') lanes.add(context.turnId);
      if (context && 'agentSessionId' in context && typeof context.agentSessionId === 'string')
        lanes.add(`session:${context.agentSessionId}`);
      break;
    }
    case 'journal':
      journal(request.input);
      break;
    case 'goal':
      if (
        request.input.command.operation === 'goal.plan.propose' &&
        !request.input.context.coordinatorTurnId &&
        request.input.proposalTurnId
      )
        lanes.add(request.input.proposalTurnId);
      for (const entry of request.input.pendingAdmission?.entries ?? []) lanes.add(entry.turnId);
      pending(request.input.pendingAdmission?.pending);
      if (request.input.pendingItem) lanes.add(request.input.pendingItem.entry.turnId);
      break;
    case 'write':
    case 'recovery-cleanup':
    case 'recovery-safety':
    case 'material':
      break;
  }
  if (owner.productOwner) {
    for (const turnId of [...lanes].filter((id) => !id.startsWith('session:'))) {
      const sessionId = readProduct(owner.sqlite, owner.productOwner, 'turn', turnId)?.record
        .agentSessionId;
      if (typeof sessionId === 'string') lanes.add(`session:${sessionId}`);
      else
        for (const earlier of owner.pending.filter((request) => request.lanes.has(turnId)))
          for (const lane of earlier.lanes) if (lane.startsWith('session:')) lanes.add(lane);
    }
  }
  return lanes;
}

/** Returns only Pending commands executed by this request's actual owner branch. */
function pendingCommands(request: WriteCommand): readonly ControlPendingCommandInput[] {
  if (request.operation === 'transition' || request.operation === 'products')
    return request.transition.pending ?? [];
  if (request.operation === 'terminal') return request.input.pending ?? [];
  if (request.operation === 'pending')
    return [request.input.input, ...(request.input.terminal?.pending ?? [])];
  if (request.operation === 'goal') return request.input.pendingAdmission?.pending ?? [];
  return [];
}

/** Captures existing Pending selectors before expanding their retained Item dependencies. */
function pendingScope(owner: OwnedDatabase, request: WriteCommand, expand = true) {
  const ids = new Set<string>();
  const threads = new Set<string>();
  const goals = new Set<string>();
  const deliveries = new Set<string>();
  for (const command of pendingCommands(request)) {
    for (const expected of command.expected ?? []) ids.add(expected.requestId);
    if ('requestId' in command) ids.add(command.requestId);
    if ('threadId' in command) threads.add(command.threadId);
    if ('turnId' in command) deliveries.add(command.turnId);
    if (command.action === 'raise') ids.add(command.input.requestId);
    if (command.action === 'associate-invalidation')
      for (const id of command.requestIds) ids.add(id);
    if (
      expand &&
      (command.action === 'delivery-prove' ||
        command.action === 'delivery-release' ||
        command.action === 'delivery-unknown')
    ) {
      const rows = owner.sqlite
        .prepare(
          "SELECT request_id FROM pending_requests WHERE delivery='frozen' AND delivery_turn_id=?"
        )
        .all(command.turnId) as { request_id: string }[];
      for (const row of rows) ids.add(row.request_id);
    }
  }
  if (request.operation === 'goal') {
    const args = request.input.command.arguments;
    if ('pendingRequestId' in args && args.pendingRequestId) ids.add(args.pendingRequestId);
    if ('goalId' in args && args.goalId) goals.add(args.goalId);
    if ('threadId' in args) threads.add(args.threadId);
    if (
      request.input.command.operation === 'goal.plan.propose' ||
      (request.input.command.operation === 'goal.completion.accept' &&
        'candidate' in args &&
        Boolean(args.candidate))
    )
      ids.add(`ap_${request.input.command.arguments.requestId}`);
  }
  if (expand)
    for (const id of ids) {
      const record = readPendingRequest(owner.sqlite, id);
      if (record) {
        threads.add(record.threadId);
        if (record.deliveryTurnId) deliveries.add(record.deliveryTurnId);
        if (typeof record.governedIntent?.goalId === 'string')
          goals.add(record.governedIntent.goalId);
      }
    }
  return { ids, threads, goals, deliveries };
}

/** Names the exact Review version; no source Turn is inferred from provenance. */
function reviewVersion(request: WriteCommand): string | undefined {
  if (request.operation !== 'review') return undefined;
  const input = request.input;
  if (input.mode === 'submit') return `${input.artifact.id}:${input.artifact.version}`;
  const target =
    input.mode === 'judgement'
      ? input.judgement.target.kind === 'artifact-version'
        ? input.judgement.target
        : undefined
      : input.input;
  return target ? `${target.artifactId}:${target.artifactVersion}` : undefined;
}

/** Waits only the admitted writers of canonical proof; original expected values are never refreshed. */
async function prepareAfterPredecessors(
  owner: OwnedDatabase,
  queued: WriteRequest,
  earlier: readonly WriteRequest[]
): Promise<void> {
  const overlaps = (left: ReadonlySet<string>, right: ReadonlySet<string>) =>
    [...left].some((id) => right.has(id));
  const wait = async (predicate: (request: WriteRequest) => boolean) => {
    await Promise.all(earlier.filter(predicate).map((request) => request.settled));
    if (queued.predecessorFailed || owner.poisoned) throw new ControlProductPreconditionError();
  };
  await wait(
    (request) => request.barrier || queued.barrier || overlaps(queued.lanes, request.lanes)
  );
  const commands = pendingCommands(queued);
  const goalPending =
    queued.operation === 'goal' && 'pendingRequestId' in queued.input.command.arguments
      ? queued.input.command.arguments.pendingRequestId
      : undefined;
  if (commands.length || goalPending) {
    // First resolve a possibly queued row creation, then its newly discoverable Thread/Goal selectors.
    for (let pass = 0; pass < 2; pass += 1) {
      const scope = pendingScope(owner, queued);
      await wait((request) => {
        if (!pendingCommands(request).length && request.operation !== 'goal') return false;
        // Unrelated retained rows are not this request's proof and cannot cause its refusal.
        const source = pendingScope(owner, request, false);
        return (
          overlaps(scope.ids, source.ids) ||
          overlaps(scope.threads, source.threads) ||
          overlaps(scope.goals, source.goals) ||
          overlaps(scope.deliveries, source.deliveries)
        );
      });
    }
    // A queued raise/proposal can introduce the row and its source Items; expand only after it commits.
    const ids = new Set<string>();
    for (const id of pendingScope(owner, queued).ids) {
      const record = readPendingRequest(owner.sqlite, id);
      if (!record) continue;
      ids.add(record.requestItemId);
      if (goalPending === id && record.governedIntent?.operation === 'goal.completion.accept') {
        for (const evidence of StoredGoalCompletionCandidateV1Schema.parse(
          record.governedIntent.candidate
        ).evidence)
          if (evidence.kind === 'item') ids.add(evidence.id);
      }
      if (commands.length)
        for (const role of [
          'decision',
          'answer',
          'disposition',
          'disposition-status',
          'ending',
          'invalidation',
        ] as const)
          ids.add(pendingRequestItemId(id, role));
    }
    for (const command of commands)
      if (command.action === 'raise') ids.add(command.input.requestItemId);
    for (const id of ids) {
      const row = owner.sqlite
        .prepare(
          "SELECT turn_id FROM control_product_entries WHERE kind='item' AND id=? ORDER BY revision DESC LIMIT 1"
        )
        .get(id) as { turn_id: string } | undefined;
      if (row) {
        await wait((request) => request.lanes.has(row.turn_id));
        continue;
      }
      // Entry IDs live in verified bodies, not JSON framing. Resolve unknown earlier byte identities first.
      for (const request of earlier) {
        if (request.refusal || request.predecessorFailed) continue;
        if (
          request.operation === 'terminal' ||
          request.operation === 'publication' ||
          (request.operation === 'pending' && request.input.terminal)
        ) {
          // These opaque native proof tokens do not expose their verified Item identities.
          await request.settled;
          continue;
        }
        const hasEntries =
          request.operation === 'products' || request.operation === 'transition'
            ? request.transition.entries.length
            : request.operation === 'pending'
              ? request.input.entries.length
              : request.operation === 'goal'
                ? Number(Boolean(request.input.pendingItem)) +
                  (request.input.pendingAdmission?.entries.length ?? 0)
                : request.operation === 'review' && request.input.mode === 'submit'
                  ? request.input.transition.entries.length
                  : 0;
        if (!hasEntries) continue;
        if (
          request.preparedEntries === undefined &&
          request.preparedGoal === undefined &&
          request.preparedReview === undefined
        )
          await request.preparation;
        const entries = [
          ...(request.preparedEntries ?? []),
          ...(request.preparedGoal?.entries ?? []),
          ...(request.preparedGoal?.pendingAdmission?.entries ?? []),
          ...(request.preparedReview?.entries ?? []),
        ];
        if (entries.some((entry) => entry.input.kind === 'item' && entry.id === id))
          await request.settled;
      }
    }
  }
  const terminal =
    queued.operation === 'terminal'
      ? queued.input
      : queued.operation === 'pending'
        ? queued.input.terminal
        : undefined;
  if (terminal?.execution)
    // The owner follows retained parent invocations; the earlier local journal prefix covers that dynamic read.
    await wait(
      (request) =>
        request.operation === 'journal' ||
        (request.operation === 'products' && Boolean(request.transition.journalIntents?.length))
    );
  if (
    queued.operation === 'review' &&
    queued.input.mode === 'decide' &&
    queued.input.input.artifactOriginal
  ) {
    const version = reviewVersion(queued);
    await wait((request) => reviewVersion(request) === version);
    if (owner.scopeDb?.scope !== 'workspace') throw new ControlProductPreconditionError();
    const materialId = readControlReviewMaterialId(
      owner.scopeDb,
      queued.input.input.artifactId,
      queued.input.input.artifactVersion
    );
    if (materialId)
      for (const request of earlier) {
        if (request.refusal || request.predecessorFailed) continue;
        if (request.operation === 'material') {
          if (request.input.mode === 'create') continue;
          const input = request.input.input;
          if (('materialId' in input ? input.materialId : input.target.materialId) === materialId)
            await request.settled;
          continue;
        }
        if (
          request.operation !== 'review' ||
          request.input.mode !== 'decide' ||
          request.input.input.decision !== 'accepted'
        )
          continue;
        const input = request.input.input;
        const submission = earlier.find(
          (prior) =>
            prior.operation === 'review' &&
            prior.input.mode === 'submit' &&
            prior.input.artifact.id === input.artifactId &&
            prior.input.artifact.version === input.artifactVersion
        );
        let target: string | null | undefined;
        try {
          target =
            submission?.operation === 'review' && submission.input.mode === 'submit'
              ? submission.input.review.materialProposal?.materialId
              : readControlReviewMaterialId(owner.scopeDb, input.artifactId, input.artifactVersion);
        } catch {
          // An unresolved candidate can refuse only itself; finish it before reading our own Material proof.
          await request.settled;
          continue;
        }
        if (target === materialId) await request.settled;
      }
  }
  if (queued.predecessorFailed || owner.poisoned) throw new ControlProductPreconditionError();
}

/** Removes one admitted slot only after its ordered response and wakes its dependent preparation. */
function complete(owner: OwnedDatabase, request: WriteRequest, result: ControlWorkerReply): void {
  owner.pending.splice(owner.pending.indexOf(request), 1);
  try {
    reply(result);
  } finally {
    request.finish();
  }
}

/** Selects ready causal prefixes, so one Turn's file preparation cannot stop an independent Turn. */
function readyBatch(owner: OwnedDatabase): WriteRequest[] {
  const blocked = new Set<string>();
  const result: WriteRequest[] = [];
  for (const request of owner.pending) {
    if (request.barrier) {
      if (result.length === 0 && owner.pending[0] === request && request.ready)
        result.push(request);
      break;
    }
    if (!request.ready || [...request.lanes].some((turn) => blocked.has(turn))) {
      for (const turn of request.lanes) blocked.add(turn);
      continue;
    }
    if (request.cohort) {
      if (result.includes(request)) continue;
      const members = owner.pending.filter((member) => member.cohort === request.cohort);
      if (
        members.length !== request.cohort.size ||
        members.some(
          (member) => !member.ready || [...member.lanes].some((lane) => blocked.has(lane))
        ) ||
        result.length + members.length > CONTROL_WORKER_LIMITS.batchTransitions
      ) {
        for (const member of members) for (const lane of member.lanes) blocked.add(lane);
        continue;
      }
      result.push(...members);
    } else result.push(request);
    if (result.length === CONTROL_WORKER_LIMITS.batchTransitions) break;
  }
  return result;
}

/** Refuses only already admitted successors; a fresh later invocation gets its normal SQL checks. */
function refuseSuccessors(
  owner: OwnedDatabase,
  failed: WriteRequest,
  excluded: ReadonlySet<WriteRequest> = new Set()
): void {
  const turns = new Set(failed.lanes);
  let barrierFailed = failed.barrier;
  for (const request of owner.pending.slice(owner.pending.indexOf(failed) + 1)) {
    if (
      excluded.has(request) ||
      (!barrierFailed && !request.barrier && ![...request.lanes].some((turn) => turns.has(turn)))
    )
      continue;
    request.predecessorFailed = true;
    barrierFailed ||= request.barrier;
    for (const turn of request.lanes) turns.add(turn);
  }
}

/** A poisoned handle disposes only ready causal prefixes after their started file work drains. */
function refusePoisonedPending(owner: OwnedDatabase): void {
  let ready = readyBatch(owner);
  while (ready.length) {
    for (const request of ready) {
      releaseContentPublications(owner.publications, request.preparedPublications ?? []);
      complete(owner, request, failure(request.id, 'unavailable'));
    }
    ready = readyBatch(owner);
  }
}

/**
 * Commits at most 32 transitions, with a savepoint per transition.
 *
 * Entry failures roll back before siblings proceed. Mutation replies wait for outer COMMIT, including error replies, so an enclosing failure cannot become success. An unchanged leading MCP observation can reply from already durable facts without BEGIN. A commit failure poisons this handle: original receipt inspection, not automatic retry or an invented recovery path, decides uncertain results.
 */
function flush(owner: OwnedDatabase): void {
  unschedule(owner);
  // Reuse only an actual leading prefix after earlier mutation ACKs; never read ahead into a selected batch.
  while (owner.scopeDb?.scope === 'workspace') {
    const first = owner.pending[0];
    if (
      !first?.ready ||
      first.refusal ||
      first.predecessorFailed ||
      first.operation !== 'capability' ||
      first.preparedCapability?.kind !== 'mcp-schema'
    )
      break;
    let outcome: ControlWorkerReply;
    try {
      const result = tryControlCapabilityReuse(owner.scopeDb, first.preparedCapability);
      if (result === undefined) break;
      outcome = {
        version: CONTROL_WORKER_VERSION,
        id: first.id,
        status: 'ok',
        operation: 'capability',
        result,
      };
      if (!isControlWorkerReply(outcome)) throw new Error('Invalid database writer result.');
    } catch {
      // The ordinary savepoint owns refusals and poisoning; no fast-path failure becomes success.
      break;
    }
    complete(owner, first, outcome);
  }
  // Archive starts a batch so its immutable canonical proof includes every earlier committed writer.
  const archiveIndex = owner.pending.findIndex((request) => archivedThreads(request).length > 0);
  if (archiveIndex === 0 && owner.scopeDb?.scope === 'workspace') {
    const first = owner.pending[0]!;
    if (!first.ready) return;
    // Both synchronous receipt reads and asynchronous proof failures stay with this scope.
    const refuse = (error: unknown) => {
      refuseSuccessors(owner, first);
      releaseContentPublications(owner.publications, first.preparedPublications ?? []);
      const code = failureCode(error, [first.id]);
      if (code === 'integrity') owner.poisoned = true;
      const domain = domainRefusal(first.operation, error);
      complete(
        owner,
        first,
        domain ? { ...failure(first.id, 'precondition'), domain } : failure(first.id, code)
      );
      if (owner.poisoned) refusePoisonedPending(owner);
      else schedule(owner);
    };
    // Exact replay needs no new immutable proof; admission still verifies the original receipt.
    let retainedReceipt: unknown;
    try {
      retainedReceipt =
        first.operation === 'transition' &&
        owner.sqlite
          .prepare('SELECT 1 FROM idempotency_requests WHERE request_key=? AND expires_at>?')
          .get(first.transition.receipt.key, first.transition.receipt.createdAt);
    } catch (error) {
      refuse(error);
      return;
    }
    if (!retainedReceipt && !first.preparedPending) {
      first.ready = false;
      let preparation: Promise<void>;
      preparation = prepareControlPendingArchive(owner.scopeDb, owner.contentMount)
        .then((preparedPending) => {
          if (owner.poisoned || databases.get(first.database) !== owner)
            throw new ControlProductPreconditionError();
          Object.assign(first, { preparedPending, ready: true });
          schedule(owner);
        })
        .catch(refuse)
        .finally(() => owner.preparations.delete(preparation));
      first.preparation = preparation;
      owner.preparations.add(preparation);
      return;
    }
  }
  const selected = readyBatch(owner);
  if (selected.length === 0) return;
  const publications = new Map(
    selected.flatMap((request) =>
      (request.preparedPublications ?? []).map(
        (path) => [path, owner.publications.get(path)] as const
      )
    )
  );
  const requiredDirectories = new Map(
    selected.map((request) => [
      request,
      (request.preparedDirectories ?? []).filter((directory) => {
        const shared = (request.preparedPublications ?? []).filter(
          (path) => dirname(path) === directory
        );
        return (
          !shared.length || shared.some((path) => !publications.get(path)?.directorySynchronized)
        );
      }),
    ])
  );
  for (const request of selected)
    releaseContentPublications(owner.publications, request.preparedPublications ?? []);
  // A completed parent barrier is shared only while an already admitted reference still owns it.
  const directoryErrors = new Map<string, ControlWorkerFailureCode>();
  for (const directory of new Set([...requiredDirectories.values()].flat())) {
    try {
      const fd = openSync(
        directory,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
      );
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      for (const [path, publication] of publications)
        if (publication && dirname(path) === directory) publication.directorySynchronized = true;
    } catch (error) {
      directoryErrors.set(
        directory,
        failureCode(
          error,
          selected
            .filter((request) => requiredDirectories.get(request)?.includes(directory))
            .map((request) => request.id),
          'batch'
        )
      );
    }
  }
  for (const request of selected) {
    if (request.refusal || request.predecessorFailed) refuseSuccessors(owner, request);
    for (const directory of requiredDirectories.get(request) ?? []) {
      const code = directoryErrors.get(directory);
      if (code) {
        refuseSuccessors(owner, request);
        request.refusal ??= failure(request.id, code, 'not-committed');
        break;
      }
    }
  }
  const batch = selected;
  if (batch.every((request) => request.refusal || request.predecessorFailed)) {
    for (const request of batch)
      complete(
        owner,
        request,
        request.refusal ?? failure(request.id, 'precondition', 'not-committed')
      );
    if (readyBatch(owner).length) owner.immediate = setImmediate(() => flush(owner));
    return;
  }
  let bodyFinished = false;
  let replies: ControlWorkerReply[];
  try {
    replies = owner.writer.write((sqlite) => {
      const outcomes: ControlWorkerReply[] = [];
      for (const request of batch) {
        if (request.refusal || request.predecessorFailed) {
          outcomes.push(request.refusal ?? failure(request.id, 'precondition', 'not-committed'));
          continue;
        }
        sqlite.exec('SAVEPOINT control_transition');
        try {
          let outcome: ControlWorkerReply;
          if (request.operation === 'transition') {
            if (!owner.productOwner) throw new ControlProductPreconditionError();
            const result = applyControlAdmission(
              sqlite,
              owner.productOwner,
              request.transition,
              request.preparedEntries ?? []
            );
            if (!result.replayed && owner.scopeDb?.scope === 'workspace')
              for (const threadId of archivedThreads(request)) {
                if (!request.preparedPending) throw new ControlProductPreconditionError();
                assertControlPendingArchive(owner.scopeDb, threadId, request.preparedPending);
              }
            if (!result.replayed)
              for (const command of request.transition.pending ?? []) {
                if (owner.scopeDb?.scope !== 'workspace')
                  throw new ControlProductPreconditionError();
                applyControlPendingCommand(
                  owner.scopeDb,
                  command,
                  request.preparedPending ?? { entries: [], dependencies: [] }
                );
              }
            outcome = {
              version: CONTROL_WORKER_VERSION,
              id: request.id,
              status: 'ok',
              operation: 'transition',
              result,
            };
          } else if (request.operation === 'item' || request.operation === 'event') {
            const plan =
              request.operation === 'item' ? request.preparedItem : request.preparedEvent;
            if (!owner.productOwner || !plan || !owner.scopeDb)
              throw new ControlProductPreconditionError();
            const turnId =
              request.operation === 'item' ? request.input.item.turnId : request.input.turnId;
            if (
              readProduct(sqlite, owner.productOwner, 'turn', turnId)?.revision !==
              plan.head.revision
            )
              throw new ControlProductPreconditionError();
            if (request.preparedPublication)
              applyControlPublication(
                owner.scopeDb,
                request.itemPublication!,
                request.preparedPublication
              );
            else if (!plan.replay)
              applyControlProducts(
                sqlite,
                owner.productOwner,
                [{ kind: 'turn', expectedRevision: plan.head.revision, record: plan.head.record }],
                request.preparedEntries ?? []
              );
            outcome = {
              version: CONTROL_WORKER_VERSION,
              id: request.id,
              status: 'ok',
              ...(request.operation === 'item'
                ? { operation: 'item' as const, result: request.preparedItem!.item }
                : { operation: 'event' as const, result: request.preparedEvent!.event }),
            };
          } else if (request.operation === 'products') {
            if (!owner.productOwner) throw new ControlProductPreconditionError();
            applyControlProducts(
              sqlite,
              owner.productOwner,
              request.transition.products,
              request.preparedEntries ?? []
            );
            if (owner.scopeDb?.scope === 'workspace')
              for (const threadId of archivedThreads(request)) {
                if (!request.preparedPending) throw new ControlProductPreconditionError();
                assertControlPendingArchive(owner.scopeDb, threadId, request.preparedPending);
              }
            for (const command of request.transition.pending ?? []) {
              if (owner.scopeDb?.scope !== 'workspace') throw new ControlProductPreconditionError();
              applyControlPendingCommand(
                owner.scopeDb,
                command,
                request.preparedPending ?? { entries: [], dependencies: [] }
              );
            }
            for (const inputJson of request.transition.journalIntents ?? []) {
              if (owner.scopeDb?.scope !== 'workspace') throw new ControlProductPreconditionError();
              applyControlExecutionJournal(owner.scopeDb, { kind: 'intent', inputJson });
            }
            outcome = {
              version: CONTROL_WORKER_VERSION,
              id: request.id,
              status: 'ok',
              operation: 'products',
            };
          } else if (request.operation === 'publication') {
            if (!owner.scopeDb || !request.preparedPublication)
              throw new ControlProductPreconditionError();
            applyControlPublication(owner.scopeDb, request.input, request.preparedPublication);
            outcome = {
              version: CONTROL_WORKER_VERSION,
              id: request.id,
              status: 'ok',
              operation: 'publication',
            };
          } else if (request.operation === 'pending') {
            if (owner.scopeDb?.scope !== 'workspace') throw new ControlProductPreconditionError();
            const result = applyControlPendingTransition(
              owner.scopeDb,
              request.input,
              request.preparedPending ?? { entries: [], dependencies: [] },
              request.preparedTerminal
            );
            outcome = {
              version: CONTROL_WORKER_VERSION,
              id: request.id,
              status: 'ok',
              operation: 'pending',
              result,
            };
          } else if (request.operation === 'journal') {
            if (owner.scopeDb?.scope !== 'workspace') throw new ControlProductPreconditionError();
            const resultJson = applyControlExecutionJournal(owner.scopeDb, request.input);
            outcome = {
              version: CONTROL_WORKER_VERSION,
              id: request.id,
              status: 'ok',
              operation: 'journal',
              resultJson,
            };
          } else if (request.operation === 'goal') {
            if (owner.scopeDb?.scope !== 'workspace' || !request.preparedGoal)
              throw new ControlProductPreconditionError();
            const result = applyControlGoalCommand(
              owner.scopeDb,
              request.input,
              request.preparedGoal
            );
            outcome = {
              version: CONTROL_WORKER_VERSION,
              id: request.id,
              status: 'ok',
              operation: 'goal',
              result,
            };
          } else if (request.operation === 'terminal') {
            if (!owner.scopeDb || !owner.productOwner || !request.preparedTerminal)
              throw new ControlProductPreconditionError();
            const result = applyControlTerminal(
              owner.scopeDb,
              request.input,
              request.preparedTerminal
            );
            outcome = {
              version: CONTROL_WORKER_VERSION,
              id: request.id,
              status: 'ok',
              operation: 'terminal',
              result,
            };
          } else if (request.operation === 'review') {
            if (owner.scopeDb?.scope !== 'workspace' || !request.preparedReview)
              throw new ControlProductPreconditionError();
            const result = applyControlReviewCommand(
              owner.scopeDb,
              request.input,
              request.preparedReview
            );
            outcome = {
              version: CONTROL_WORKER_VERSION,
              id: request.id,
              status: 'ok',
              operation: 'review',
              result,
            };
          } else if (request.operation === 'material') {
            if (owner.scopeDb?.scope !== 'workspace' || !request.preparedMaterial)
              throw new ControlProductPreconditionError();
            const result = applyControlMaterialCommand(owner.scopeDb, request.preparedMaterial);
            outcome = {
              version: CONTROL_WORKER_VERSION,
              id: request.id,
              status: 'ok',
              operation: 'material',
              result,
            };
          } else if (request.operation === 'capability') {
            const db = owner.scopeDb;
            if (db?.scope !== 'workspace' || !request.preparedCapability)
              throw new WorkerRawOutputAuthorityError();
            const result = applyControlCapabilityCommand(db, request.preparedCapability, (goalId) =>
              advanceGoalRevision(db, goalId)
            );
            outcome = {
              version: CONTROL_WORKER_VERSION,
              id: request.id,
              status: 'ok',
              operation: 'capability',
              result,
            };
          } else if (request.operation === 'recovery-safety') {
            if (owner.scopeDb?.scope !== 'workspace' || !request.preparedRecoverySafety)
              throw new ControlProductPreconditionError();
            const result = applyControlRecoverySafety(
              owner.scopeDb,
              request.input,
              request.preparedRecoverySafety
            );
            outcome = {
              version: CONTROL_WORKER_VERSION,
              id: request.id,
              status: 'ok',
              operation: 'recovery-safety',
              result,
            };
          } else if (request.operation === 'recovery-cleanup') {
            if (owner.scopeDb?.scope !== 'workspace') throw new ControlProductPreconditionError();
            applyControlRecoveryCleanup(owner.scopeDb, request.input);
            outcome = {
              version: CONTROL_WORKER_VERSION,
              id: request.id,
              status: 'ok',
              operation: 'recovery-cleanup',
            };
          } else if (request.operation === 'maintenance') {
            if (!owner.scopeDb || !owner.productOwner) throw new ControlProductPreconditionError();
            const result = applyControlMaintenanceAdmission(owner.scopeDb, request.input);
            outcome = {
              version: CONTROL_WORKER_VERSION,
              id: request.id,
              status: 'ok',
              operation: 'maintenance',
              result,
            };
          } else if (request.operation === 'observation') {
            if (!owner.productOwner || !owner.scopeDb) throw new ControlProductPreconditionError();
            const result = applyControlWorkObservation(sqlite, owner.productOwner, request.input);
            outcome = {
              version: CONTROL_WORKER_VERSION,
              id: request.id,
              status: 'ok',
              operation: 'observation',
              result,
            };
          } else if (request.operation === 'project-cleanup') {
            const input = ProjectWorkerBackendCleanupInputSchema.parse(request.input);
            if (
              owner.scopeDb?.scope !== 'workspace' ||
              input.workspaceId !== owner.scopeDb.workspaceId ||
              input.environmentPackage.scope.workspaceId !== owner.scopeDb.workspaceId
            )
              throw new ControlProductPreconditionError();
            const result = projectWorkerBackendCleanupInDb(owner.scopeDb, input);
            outcome = {
              version: CONTROL_WORKER_VERSION,
              id: request.id,
              status: 'ok',
              operation: 'project-cleanup',
              result,
            };
          } else {
            const results = apply(sqlite, request.statements);
            outcome = {
              version: CONTROL_WORKER_VERSION,
              id: request.id,
              status: 'ok',
              operation: 'write',
              results,
            };
          }
          // Refuse unsupported results and serialization before the durable boundary.
          if (!isControlWorkerReply(outcome)) throw new Error('Invalid database writer result.');
          structuredClone(outcome);
          sqlite.exec('RELEASE control_transition');
          outcomes.push(outcome);
        } catch (error) {
          // SQLite FULL can automatically roll back the outer transaction. Preserve that cause.
          if (!sqlite.inTransaction) throw error;
          sqlite.exec('ROLLBACK TO control_transition');
          sqlite.exec('RELEASE control_transition');
          if (failureCode(error) === 'integrity') throw error;
          refuseSuccessors(owner, request);
          const domain = domainRefusal(request.operation, error);
          outcomes.push(
            domain
              ? { ...failure(request.id, 'precondition'), domain }
              : failure(request.id, failureCode(error, [request.id]))
          );
        }
      }
      bodyFinished = true;
      return outcomes;
    });
  } catch (error) {
    const unknown =
      !(error instanceof ControlStoreNoSpaceError) && (bodyFinished || owner.sqlite.inTransaction);
    const code = failureCode(
      error,
      batch.map((request) => request.id),
      'batch'
    );
    owner.poisoned = unknown || code === 'integrity';
    for (const request of batch) refuseSuccessors(owner, request, new Set(batch));
    replies = batch.map(
      (request) =>
        request.refusal ??
        (request.predecessorFailed
          ? failure(request.id, 'precondition', 'not-committed')
          : failure(
              request.id,
              code === 'integrity' ? code : unknown ? 'commit-unknown' : code,
              unknown ? 'unknown' : 'not-committed'
            ))
    );
  }
  for (let index = 0; index < replies.length; index += 1)
    complete(owner, batch[index]!, replies[index]!);
  if (owner.poisoned) {
    refusePoisonedPending(owner);
  } else if (readyBatch(owner).length > 0) {
    // One batch per turn lets ready sibling owners progress on the shared thread.
    owner.immediate = setImmediate(() => flush(owner));
  }
}

/** Starts the fixed wait, or promptly flushes a full batch without another wait window. */
function schedule(owner: OwnedDatabase): void {
  if (owner.poisoned) return;
  const ready = readyBatch(owner);
  if (!ready.length) return;
  if (
    ready.length >= CONTROL_WORKER_LIMITS.batchTransitions ||
    owner.pending.some(
      (request) =>
        request.operation === 'capability' &&
        request.ready &&
        (request.immediate || request.input.kind !== 'raw-observe')
    ) ||
    owner.pending.some(
      (request) =>
        request.cohort?.immediate &&
        owner.pending
          .filter((member) => member.cohort === request.cohort)
          .every((member) => member.ready)
    )
  ) {
    if (owner.timer !== null) clearTimeout(owner.timer);
    owner.timer = null;
    owner.immediate ??= setImmediate(() => flush(owner));
  } else if (owner.timer === null && owner.immediate === null) {
    owner.timer = setTimeout(() => flush(owner), CONTROL_WORKER_LIMITS.batchWaitMs);
  }
}

/** Drains accepted local work before an ordered close or maintenance request. */
async function drain(owner: OwnedDatabase): Promise<void> {
  while (owner.pending.length || owner.preparations.size) {
    const count = owner.pending.length;
    if (owner.poisoned) refusePoisonedPending(owner);
    else flush(owner);
    if (owner.pending.length < count) continue;
    // Ready predecessors must commit before a dependent preparation can finish; never await them first.
    const preparing = owner.pending
      .filter((request) => !request.ready)
      .map((request) => request.preparation!);
    if (preparing.length) await Promise.race(preparing);
    else if (owner.preparations.size) await Promise.all(owner.preparations);
  }
  unschedule(owner);
}

/** Includes accepted asynchronous preparation in ordered close/checkpoint/reclaim, without holding SQL across an await. */
function maintainDatabase(
  request: Extract<ControlWorkerRequest, { operation: 'close' | 'checkpoint' | 'reclaim' }>,
  owner: OwnedDatabase
): void {
  if (request.operation === 'close') owner.closing = true;
  const finish = async () => {
    try {
      await drain(owner);
      if (request.operation === 'close') {
        owner.sqlite.close();
        databases.delete(request.database);
        paths.delete(owner.path);
        identities.delete(owner.identity);
        reply({
          version: CONTROL_WORKER_VERSION,
          id: request.id,
          status: 'ok',
          operation: 'close',
        });
      } else if (owner.poisoned) reply(failure(request.id, 'unavailable'));
      else if (request.operation === 'checkpoint')
        reply({
          version: CONTROL_WORKER_VERSION,
          id: request.id,
          status: 'ok',
          operation: 'checkpoint',
          pressure: owner.writer.checkpoint(),
        });
      else
        reply({
          version: CONTROL_WORKER_VERSION,
          id: request.id,
          status: 'ok',
          operation: 'reclaim',
          complete: owner.writer.reclaim(),
        });
    } catch (error) {
      const code = failureCode(error, [request.id]);
      reply(failure(request.id, code === 'sql-failed' ? 'unavailable' : code, 'unknown'));
    }
  };
  void finish();
}

/** Stops new admission and drains every accepted preparation and SQL body before closing the actual worker. */
function shutdownWorker(id: number): void {
  stopping = true;
  for (const owner of databases.values()) owner.closing = true;
  const finish = async () => {
    try {
      for (const owner of databases.values()) {
        await drain(owner);
        owner.sqlite.close();
      }
      databases.clear();
      paths.clear();
      identities.clear();
      reply({ version: CONTROL_WORKER_VERSION, id, status: 'ok', operation: 'shutdown' });
      port.close();
    } catch (error) {
      const code = failureCode(error, [id]);
      reply(failure(id, code === 'sql-failed' ? 'unavailable' : code, 'unknown'));
    }
  };
  void finish();
}

/** Refuses stored conflict/trigger semantics that can undo successful batch siblings. */
function assertSavepointSafeSchema(sqlite: Database.Database): void {
  const rows = sqlite
    .prepare('SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL')
    .iterate() as Iterable<{ sql: string }>;
  for (const row of rows) {
    if (hasControlSqlRollback(row.sql))
      throw new Error('Database schema cannot isolate control transitions.');
  }
}

/** Opens only a trusted admitted path; neither directory discovery nor opening grants ownership. */
function openDatabase(request: Extract<ControlWorkerRequest, { operation: 'open' }>): void {
  if (databases.has(request.database)) {
    reply(failure(request.id, 'invalid-request'));
    return;
  }
  if (
    request.productOwner &&
    request.initialize !== (request.productOwner.kind === 'server' ? 'core' : 'workspace')
  )
    throw new ControlProductPreconditionError();
  let contentMount = request.contentMount;
  const path =
    request.create && !existsSync(request.path)
      ? join(realpathSync(dirname(request.path)), basename(request.path))
      : realpathSync(request.path);
  const dataRoot = request.dataRoot === undefined ? undefined : realpathSync(request.dataRoot);
  if (dataRoot !== undefined) {
    if (!request.productOwner) throw new ControlProductPreconditionError();
    const expected =
      request.productOwner.kind === 'server'
        ? coreDbPath(dataRoot)
        : workspaceDbPath(dataRoot, request.productOwner.workspaceId);
    if (join(realpathSync(dirname(expected)), basename(expected)) !== path)
      throw new ControlProductPreconditionError();
  }
  const existing = statSync(path, { throwIfNoEntry: false });
  const existingIdentity = existing ? `${existing.dev}:${existing.ino}` : null;
  if (paths.has(path) || (existingIdentity !== null && identities.has(existingIdentity))) {
    reply(failure(request.id, 'invalid-request'));
    return;
  }
  const sqlite = new Database(path, { fileMustExist: !request.create });
  try {
    assertSavepointSafeSchema(sqlite);
    if (request.initialize !== undefined) {
      applyNativeScopeMigrations(sqlite, request.initialize);
      assertSavepointSafeSchema(sqlite);
    }
    if (contentMount) {
      if (!request.productOwner) throw new ControlProductPreconditionError();
      const scopeRoot = dirname(dirname(path));
      const canonical = join(scopeRoot, 'evidence', 'backend');
      if (
        dataRoot &&
        resolve(contentMount.root) === canonical &&
        contentMount.mount === 'backend-evidence' &&
        contentMount.knowledgeBaseId === null
      ) {
        const directories = [
          scopeRoot,
          join(scopeRoot, 'evidence'),
          canonical,
          join(canonical, 'sha256'),
        ];
        for (const directory of directories) {
          if (!lstatSync(directory, { throwIfNoEntry: false })) mkdirSync(directory);
          const metadata = lstatSync(directory);
          if (
            !metadata.isDirectory() ||
            metadata.isSymbolicLink() ||
            realpathSync(directory) !== directory
          )
            throw new ControlProductPreconditionError();
        }
        // A visible directory may remain from interrupted first creation. Commit each parent once at open.
        for (const directory of directories.slice(0, -1).reverse()) {
          const fd = openSync(
            directory,
            constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
          );
          try {
            fsyncSync(fd);
          } finally {
            closeSync(fd);
          }
        }
      }
      contentMount = { ...contentMount, root: realpathSync(contentMount.root) };
      if (!statSync(contentMount.root).isDirectory()) throw new ControlProductPreconditionError();
    }
    const writer = controlStoreFor(sqlite);
    const metadata = statSync(path);
    const identity = `${metadata.dev}:${metadata.ino}`;
    databases.set(request.database, {
      sqlite,
      scopeDb:
        dataRoot === undefined || request.productOwner === undefined
          ? undefined
          : request.productOwner.kind === 'server'
            ? bindCoreSqlite(sqlite, dataRoot)
            : bindWorkspaceSqlite(sqlite, dataRoot, request.productOwner.workspaceId),
      writer,
      path,
      identity,
      productOwner: request.productOwner,
      contentMount,
      pending: [],
      publications: new Map(),
      preparations: new Set(),
      closing: false,
      timer: null,
      immediate: null,
      poisoned: false,
    });
    paths.add(path);
    identities.add(identity);
  } catch (error) {
    sqlite.close();
    throw error;
  }
  reply({ version: CONTROL_WORKER_VERSION, id: request.id, status: 'ok', operation: 'open' });
}

/** Routes trusted protocol messages without transporting connections or executing caller code. */
function receive(value: unknown, cohort?: WriteRequest['cohort']): void {
  if (value && typeof value === 'object' && 'requests' in value) {
    if (
      !isControlProductCohort(value) ||
      value.requests.some((request) => pendingIds.has(request.id))
    )
      throw new Error('Invalid native product cohort.');
    const first = value.requests[0]!;
    const owner = databases.get(first.database);
    let code: ControlWorkerFailureCode | undefined;
    if (stopping || owner?.poisoned) code = 'unavailable';
    else if (!owner || owner.closing) code = 'not-open';
    else if (
      owner.pending.length + value.requests.length > CONTROL_WORKER_LIMITS.pendingTransitions ||
      value.requests.reduce((bytes, request) => bytes + controlWorkerInputBytes(request) + 64, 0) >
        CONTROL_WORKER_LIMITS.pendingBytes
    ) {
      observeRefusal(
        value.requests.map((request) => request.id),
        owner.pending.length + value.requests.length > CONTROL_WORKER_LIMITS.pendingTransitions
          ? 'queue-count'
          : 'cohort-bytes',
        'batch',
        owner.pending.length
      );
      code = 'busy';
    } else {
      try {
        // Validate all metadata owners before any member can occupy a native slot.
        for (const request of value.requests) requestLanes(owner, request);
      } catch (error) {
        code = failureCode(
          error,
          value.requests.map((request) => request.id),
          'batch'
        );
      }
    }
    if (code) {
      for (const request of value.requests) {
        pendingIds.add(request.id);
        reply(failure(request.id, code));
      }
    } else {
      const membership = { size: value.requests.length, immediate: value.immediate };
      for (const request of value.requests) receive(request, membership);
    }
    return;
  }
  const id = value !== null && typeof value === 'object' && 'id' in value ? value.id : undefined;
  // Even a malformed duplicate must not complete an accepted write's correlation id.
  if (typeof id === 'number' && pendingIds.has(id)) {
    throw new Error('Duplicate database writer message identity.');
  }
  if (!isControlWorkerRequest(value)) {
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 0) {
      // An uncorrelatable message cannot safely complete any caller's promise.
      throw new Error('Invalid database writer protocol.');
    }
    reply(failure(id, 'invalid-request'));
    return;
  }
  pendingIds.add(value.id);
  try {
    if (stopping) {
      reply(failure(value.id, 'unavailable'));
      return;
    }
    if (value.operation === 'shutdown') {
      shutdownWorker(value.id);
      return;
    }
    if (value.operation === 'open') {
      openDatabase(value);
      return;
    }
    const owner = databases.get(value.database);
    if (!owner) {
      reply(failure(value.id, 'not-open'));
      return;
    }
    if (owner.closing) {
      reply(failure(value.id, 'not-open'));
      return;
    }
    if (value.operation === 'close') {
      maintainDatabase(value, owner);
      return;
    }
    if (owner.poisoned) {
      reply(failure(value.id, 'unavailable'));
      return;
    }
    if (
      value.operation === 'write' ||
      value.operation === 'recovery-cleanup' ||
      value.operation === 'recovery-safety' ||
      value.operation === 'transition' ||
      value.operation === 'products' ||
      value.operation === 'item' ||
      value.operation === 'event' ||
      value.operation === 'publication' ||
      value.operation === 'project-cleanup' ||
      value.operation === 'observation' ||
      value.operation === 'capability' ||
      value.operation === 'pending' ||
      value.operation === 'journal' ||
      value.operation === 'goal' ||
      value.operation === 'maintenance' ||
      value.operation === 'material' ||
      value.operation === 'review' ||
      value.operation === 'terminal'
    ) {
      if (owner.pending.length >= CONTROL_WORKER_LIMITS.pendingTransitions) {
        observeRefusal([value.id], 'queue-count', 'request', owner.pending.length);
        reply(failure(value.id, 'busy'));
      } else {
        let lanes: ReadonlySet<string>;
        try {
          lanes = requestLanes(owner, value);
        } catch (error) {
          const domain = domainRefusal(value.operation, error);
          reply(
            domain
              ? { ...failure(value.id, 'precondition'), domain }
              : failure(value.id, failureCode(error, [value.id]))
          );
          return;
        }
        let finish!: () => void;
        const settled = new Promise<void>((resolve) => {
          finish = resolve;
        });
        const queued: WriteRequest = {
          ...value,
          lanes,
          settled,
          finish,
          cohort,
          barrier:
            value.operation === 'recovery-cleanup' ||
            value.operation === 'recovery-safety' ||
            archivedThreads(value).length > 0 ||
            (value.operation === 'write' && owner.scopeDb !== undefined),
          ready: false,
          predecessorFailed: false,
        };
        // This is the existing bounded FIFO slot, retained throughout asynchronous preparation.
        const earlier = [...owner.pending];
        owner.pending.push(queued);
        const newDirectories: ControlContentPreparation = {
          db: owner.scopeDb,
          directories: new Set(),
          publications: owner.publications,
          published: new Set(),
        };
        const prepare = async () => {
          let preparedPublication: PreparedControlPublication | undefined;
          let preparedItem: WriteRequest['preparedItem'];
          let preparedEvent: WriteRequest['preparedEvent'];
          let itemPublication: ControlPublicationInput | undefined;
          let preparedEntries: WriteRequest['preparedEntries'];
          let preparedPending: PreparedControlPendingCommand | undefined;
          let preparedGoal: PreparedControlGoalCommand | undefined;
          let preparedMaterial: ControlMaterialCommandInput | undefined;
          let preparedCapability: ControlCapabilityCommandInput | undefined;
          let preparedReview: PreparedControlReviewCommand | undefined;
          let preparedTerminal: PreparedControlTerminal | undefined;
          let preparedRecoverySafety: PreparedControlRecoverySafety | undefined;
          try {
            if (value.operation === 'pending' && !value.input.terminal) {
              if (!owner.productOwner) throw new ControlProductPreconditionError();
              preparedEntries = await prepareControlEntries(
                owner.productOwner,
                owner.contentMount,
                value.input.entries,
                newDirectories
              );
              Object.assign(queued, { preparedEntries });
            }
            // Canonical-dependent preparation observes its admitted predecessor's committed state.
            if (
              ['terminal', 'publication', 'pending', 'goal', 'item', 'event'].includes(
                value.operation
              )
            )
              await prepareAfterPredecessors(owner, queued, earlier);
            if (value.operation === 'recovery-safety') {
              await prepareAfterPredecessors(owner, queued, earlier);
              if (
                owner.scopeDb?.scope !== 'workspace' ||
                owner.scopeDb.workspaceId !== value.input.workspaceId
              )
                throw new ControlProductPreconditionError();
              preparedRecoverySafety = prepareControlRecoverySafety(value.input);
            }
            if (value.operation === 'item' || value.operation === 'event') {
              if (owner.scopeDb?.scope !== 'workspace' || !owner.contentMount)
                throw new ControlProductPreconditionError();
              if (value.operation === 'item')
                preparedItem = await prepareControlItemAppend(
                  owner.scopeDb,
                  value.input,
                  owner.contentMount
                );
              else
                preparedEvent = await prepareControlEventAppend(
                  owner.scopeDb,
                  value.input,
                  owner.contentMount
                );
              const plan = (preparedItem ?? preparedEvent)!;
              const body = value.operation === 'item' ? preparedItem!.item : preparedEvent!.event;
              const turnId = body.turnId!;
              if (!plan.replay) {
                const content = await prepareRetainedProductJson(
                  owner.contentMount,
                  { kind: 'workspace', workspaceId: owner.scopeDb.workspaceId },
                  join(dirname(dirname(owner.path)), 'runtime', 'staging'),
                  writeRetainedV1(body)
                );
                const entries = [
                  {
                    kind: value.operation as 'item' | 'event',
                    turnId,
                    sequence:
                      value.operation === 'item'
                        ? preparedItem!.sequence
                        : preparedEvent!.event.sequence,
                    expectedRevision: value.operation === 'item' ? preparedItem!.revision : 0,
                    ...content,
                  },
                ];
                if (['pending', 'running'].includes(String(plan.head.record.status)))
                  preparedEntries = await prepareControlEntries(
                    owner.productOwner!,
                    owner.contentMount,
                    entries,
                    newDirectories
                  );
                else {
                  itemPublication = {
                    category:
                      value.operation === 'event'
                        ? 'already-decided-publication'
                        : value.input.category!,
                    turnId,
                    expectedRevision: plan.head.revision,
                    entries,
                  };
                  preparedPublication = await prepareControlPublication(
                    owner.scopeDb,
                    itemPublication,
                    owner.contentMount,
                    newDirectories
                  );
                }
              }
            }
            if (
              value.operation === 'terminal' ||
              (value.operation === 'pending' && value.input.terminal)
            ) {
              if (!owner.scopeDb || !owner.productOwner)
                throw new ControlProductPreconditionError();
              preparedTerminal = await prepareControlTerminal(
                owner.scopeDb,
                value.operation === 'terminal' ? value.input : value.input.terminal!,
                owner.contentMount,
                newDirectories
              );
            }
            if (value.operation === 'publication') {
              if (!owner.scopeDb || !owner.productOwner)
                throw new ControlProductPreconditionError();
              preparedPublication = await prepareControlPublication(
                owner.scopeDb,
                value.input,
                owner.contentMount,
                newDirectories
              );
            }
            if (value.operation === 'pending') {
              if (owner.scopeDb?.scope !== 'workspace' || !owner.productOwner)
                throw new ControlProductPreconditionError();
              preparedPending = await prepareControlPendingCommands(
                owner.scopeDb,
                [value.input.input],
                owner.contentMount,
                value.input.terminal ? [] : value.input.entries,
                preparedEntries,
                newDirectories
              );
              preparedEntries = preparedPending.entries;
            }
            if (value.operation === 'capability') {
              if (owner.scopeDb?.scope !== 'workspace') throw new WorkerRawOutputAuthorityError();
              preparedCapability = prepareControlCapabilityCommand(value.input, value.content);
            }
            if (value.operation === 'material') {
              if (owner.scopeDb?.scope !== 'workspace') throw new ControlProductPreconditionError();
              preparedMaterial = prepareControlMaterialCommand(value.input, value.content);
            }
            if (value.operation === 'review') {
              if (value.input.mode === 'decide' && value.input.input.artifactOriginal)
                await prepareAfterPredecessors(owner, queued, earlier);
              if (owner.scopeDb?.scope !== 'workspace') throw new ControlProductPreconditionError();
              preparedReview = await prepareControlReviewCommand(
                owner.scopeDb,
                value.input,
                owner.contentMount,
                newDirectories
              );
            }
            if (value.operation === 'goal') {
              if (owner.scopeDb?.scope !== 'workspace') throw new ControlProductPreconditionError();
              preparedGoal = await prepareControlGoalCommand(
                owner.scopeDb,
                value.input,
                owner.contentMount,
                newDirectories
              );
            }
            if (value.operation === 'transition' || value.operation === 'products') {
              if (!owner.productOwner) throw new ControlProductPreconditionError();
              preparedEntries = await prepareControlEntries(
                owner.productOwner,
                owner.contentMount,
                value.transition.entries,
                newDirectories
              );
              Object.assign(queued, { preparedEntries });
              if (value.transition.pending?.length && archivedThreads(value).length === 0) {
                await prepareAfterPredecessors(owner, queued, earlier);
                if (owner.scopeDb?.scope !== 'workspace')
                  throw new ControlProductPreconditionError();
                preparedPending = await prepareControlPendingCommands(
                  owner.scopeDb,
                  value.transition.pending,
                  owner.contentMount,
                  value.transition.entries,
                  preparedEntries,
                  newDirectories
                );
              }
            }
            if (owner.poisoned || databases.get(value.database) !== owner)
              throw new ControlProductPreconditionError();
            Object.assign(queued, {
              ready: true,
              preparedEntries,
              preparedGoal,
              preparedReview,
              preparedPending,
              preparedPublication,
              preparedItem,
              preparedEvent,
              itemPublication,
              preparedTerminal,
              preparedRecoverySafety,
              preparedMaterial,
              preparedCapability,
              preparedDirectories: [...newDirectories.directories],
              preparedPublications: [...newDirectories.published],
              ...('content' in value ? { content: undefined } : {}),
            });
            schedule(owner);
          } catch (error) {
            refuseSuccessors(owner, queued);
            await releaseContentPreparation(newDirectories);
            const domain = domainRefusal(value.operation, error);
            queued.refusal = owner.poisoned
              ? failure(value.id, 'unavailable')
              : domain
                ? { ...failure(value.id, 'precondition'), domain }
                : failure(value.id, failureCode(error, [value.id]), 'not-committed');
            queued.ready = true;
            if (owner.poisoned) refusePoisonedPending(owner);
            else schedule(owner);
          }
        };
        let preparation: Promise<void>;
        preparation = prepare().finally(() => owner.preparations.delete(preparation));
        queued.preparation = preparation;
        owner.preparations.add(preparation);
      }
      return;
    }
    maintainDatabase(value, owner);
  } catch (error) {
    const code = failureCode(error, [value.id]);
    reply(failure(value.id, code === 'sql-failed' ? 'unavailable' : code, 'unknown'));
  }
}

port.on('message', receive);
port.on('close', () => {
  stopping = true;
  for (const owner of databases.values()) {
    unschedule(owner);
    owner.pending.length = 0;
    owner.sqlite.close();
  }
  databases.clear();
  paths.clear();
  identities.clear();
});
