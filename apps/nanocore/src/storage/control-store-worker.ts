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
import { isMainThread, parentPort } from 'node:worker_threads';
import Database from 'better-sqlite3';
import {
  ArtifactReviewError,
  applyControlReviewCommand,
  type PreparedControlReviewCommand,
  prepareControlReviewCommand,
} from '../artifact-reviews.js';
import { applyControlMaintenanceAdmission } from '../knowledge/knowledge-agent-maintenance.js';
import { NotebookError } from '../knowledge/notebook.js';
import { OperationError } from '../operation-error.js';
import { applyControlExecutionJournal } from '../runtime/execution-journal.js';
import {
  applyControlGoalCommand,
  GoalCommandError,
  type PreparedControlGoalCommand,
  prepareControlGoalCommand,
} from '../runtime/goal-owner.js';
import { IdempotencyKeyConflictError } from '../runtime/idempotent-command.js';
import type { PreparedControlPendingCommand } from '../runtime/pending-requests.js';
import {
  applyControlPendingCommand,
  assertControlPendingArchive,
  PendingRequestCommandError,
} from '../runtime/pending-requests.js';
import {
  ProjectWorkerBackendCleanupInputSchema,
  projectWorkerBackendCleanupInDb,
} from '../runtime/worker-backend-cleanup-projection.js';
import {
  applyControlMaterialCommand,
  type ControlMaterialCommandInput,
  prepareControlMaterialCommand,
  WorkspaceMaterialError,
} from '../workspace-materials.js';
import { ControlStoreBusyError, controlStoreFor } from './control-store.js';
import { applyControlAdmission } from './control-store-admission.js';
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
  type ControlProductContentMount,
  type ControlProductOwner,
  ControlProductPreconditionError,
  type PreparedControlEntry,
  type PreparedControlPublication,
  type PreparedControlTerminal,
  prepareControlEntries,
  prepareControlPublication,
  prepareControlTerminal,
} from './control-store-products.js';
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
  hasControlSqlRollback,
  isControlWorkerReply,
  isControlWorkerRequest,
} from './control-store-worker-protocol.js';
import { bindCoreSqlite, bindWorkspaceSqlite, type CoreDb, type WorkspaceDb } from './db.js';
import { coreDbPath, workspaceDbPath } from './fs-layout.js';
import { applyNativeScopeMigrations } from './migrate.js';
import { applyControlWorkObservation } from './work-observations.js';

if (isMainThread || parentPort === null) {
  throw new Error('The database writer entrypoint requires a dedicated worker thread.');
}
const port = parentPort;

/** A queued transition, not a durable request or a second command receipt. */
type WriteRequest = Extract<
  ControlWorkerRequest,
  {
    operation:
      | 'write'
      | 'transition'
      | 'products'
      | 'publication'
      | 'project-cleanup'
      | 'observation'
      | 'pending'
      | 'journal'
      | 'goal'
      | 'maintenance'
      | 'material'
      | 'review'
      | 'terminal';
  }
> & {
  readonly preparedPublication?: PreparedControlPublication | undefined;
  readonly preparedEntries?: readonly PreparedControlEntry[] | undefined;
  readonly preparedPending?: PreparedControlPendingCommand | undefined;
  readonly preparedGoal?: PreparedControlGoalCommand | undefined;
  readonly preparedMaterial?: ControlMaterialCommandInput | undefined;
  readonly preparedReview?: PreparedControlReviewCommand | undefined;
  readonly preparedTerminal?: PreparedControlTerminal | undefined;
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
    operation === 'goal' &&
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

/** Classifies a native failure without publishing its message, SQL or parameters. */
function failureCode(error: unknown): ControlWorkerFailureCode {
  if (error instanceof PreconditionError || error instanceof ControlProductPreconditionError)
    return 'precondition';
  if (error instanceof ControlStoreBusyError) return 'busy';
  const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : null;
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
function archivedThreads(request: WriteRequest): string[] {
  return request.operation === 'products' || request.operation === 'transition'
    ? request.transition.products
        .filter((input) => input.kind === 'thread' && input.record.status === 'archived')
        .map((input) => String(input.record.id))
    : [];
}

/**
 * Commits at most 32 transitions, with a savepoint per transition.
 *
 * Entry failures roll back before siblings proceed. All replies wait for outer COMMIT, including error replies, so an enclosing failure cannot become success. A commit failure poisons this handle: original receipt inspection, not automatic retry or an invented recovery path, decides uncertain results.
 */
function flush(owner: OwnedDatabase): void {
  unschedule(owner);
  // Archive starts a batch so its immutable canonical proof includes every earlier committed writer.
  const archiveIndex = owner.pending.findIndex((request) => archivedThreads(request).length > 0);
  const nextArchive =
    archiveIndex === 0
      ? owner.pending.findIndex(
          (request, index) => index > 0 && archivedThreads(request).length > 0
        )
      : archiveIndex;
  const count =
    nextArchive > 0
      ? Math.min(nextArchive, CONTROL_WORKER_LIMITS.batchTransitions)
      : CONTROL_WORKER_LIMITS.batchTransitions;
  if (archiveIndex === 0 && owner.scopeDb?.scope === 'workspace') {
    // Keep the head stable while any admitted immutable proof is still being prepared.
    if (owner.preparations.size) {
      void Promise.all([...owner.preparations]).then(() => schedule(owner));
      return;
    }
    const first = owner.pending[0]!;
    // Both synchronous receipt reads and asynchronous proof failures stay with this scope.
    const refuse = (error: unknown) => {
      owner.pending.shift();
      releaseContentPublications(owner.publications, first.preparedPublications ?? []);
      const code = failureCode(error);
      if (code === 'integrity') owner.poisoned = true;
      if (owner.poisoned) {
        for (const request of owner.pending.splice(0)) {
          releaseContentPublications(owner.publications, request.preparedPublications ?? []);
          reply(failure(request.id, 'unavailable'));
        }
      } else if (owner.pending.length) schedule(owner);
      const domain = domainRefusal(first.operation, error);
      reply(domain ? { ...failure(first.id, 'precondition'), domain } : failure(first.id, code));
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
      let preparation: Promise<void>;
      preparation = prepareControlPendingArchive(owner.scopeDb, owner.contentMount)
        .then((preparedPending) => {
          if (owner.poisoned || databases.get(first.database) !== owner)
            throw new ControlProductPreconditionError();
          owner.pending[0] = { ...first, preparedPending };
          schedule(owner);
        })
        .catch(refuse)
        .finally(() => owner.preparations.delete(preparation));
      owner.preparations.add(preparation);
      return;
    }
  }
  const selected = owner.pending.splice(0, count);
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
      directoryErrors.set(directory, failureCode(error));
    }
  }
  const batch = selected.filter((request) => {
    for (const directory of requiredDirectories.get(request) ?? []) {
      const code = directoryErrors.get(directory);
      if (code) {
        reply(failure(request.id, code, 'not-committed'));
        return false;
      }
    }
    return true;
  });
  if (batch.length === 0) {
    if (owner.pending.length) owner.immediate = setImmediate(() => flush(owner));
    return;
  }
  let bodyFinished = false;
  let replies: ControlWorkerReply[];
  try {
    replies = owner.writer.write((sqlite) => {
      const outcomes: ControlWorkerReply[] = [];
      for (const request of batch) {
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
          sqlite.exec('ROLLBACK TO control_transition');
          sqlite.exec('RELEASE control_transition');
          if (failureCode(error) === 'integrity') throw error;
          const domain = domainRefusal(request.operation, error);
          outcomes.push(
            domain
              ? { ...failure(request.id, 'precondition'), domain }
              : failure(request.id, failureCode(error))
          );
        }
      }
      bodyFinished = true;
      return outcomes;
    });
  } catch (error) {
    const unknown = bodyFinished || owner.sqlite.inTransaction;
    const code = failureCode(error);
    owner.poisoned = unknown || code === 'integrity';
    replies = batch.map((request) =>
      failure(
        request.id,
        code === 'integrity' ? code : unknown ? 'commit-unknown' : code,
        unknown ? 'unknown' : 'not-committed'
      )
    );
  }
  for (const result of replies) reply(result);
  if (owner.poisoned) {
    for (const request of owner.pending.splice(0)) {
      releaseContentPublications(owner.publications, request.preparedPublications ?? []);
      reply(failure(request.id, 'unavailable'));
    }
  } else if (owner.pending.length > 0) {
    // One batch per turn lets ready sibling owners progress on the shared thread.
    owner.immediate = setImmediate(() => flush(owner));
  }
}

/** Starts the fixed wait, or promptly flushes a full batch without another wait window. */
function schedule(owner: OwnedDatabase): void {
  if (owner.pending.length >= CONTROL_WORKER_LIMITS.batchTransitions) {
    if (owner.timer !== null) clearTimeout(owner.timer);
    owner.timer = null;
    owner.immediate ??= setImmediate(() => flush(owner));
  } else if (owner.timer === null && owner.immediate === null) {
    owner.timer = setTimeout(() => flush(owner), CONTROL_WORKER_LIMITS.batchWaitMs);
  }
}

/** Drains accepted local work before an ordered close or maintenance request. */
async function drain(owner: OwnedDatabase): Promise<void> {
  // A queued archive can start preparation during flush, so one snapshot cannot drain this owner.
  while (owner.pending.length || owner.preparations.size) {
    await Promise.all([...owner.preparations]);
    while (owner.pending.length) {
      const count = owner.pending.length;
      flush(owner);
      if (owner.pending.length === count) break;
    }
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
      const code = failureCode(error);
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
      const code = failureCode(error);
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
function receive(value: unknown): void {
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
      value.operation === 'transition' ||
      value.operation === 'products' ||
      value.operation === 'publication' ||
      value.operation === 'project-cleanup' ||
      value.operation === 'observation' ||
      value.operation === 'pending' ||
      value.operation === 'journal' ||
      value.operation === 'goal' ||
      value.operation === 'maintenance' ||
      value.operation === 'material' ||
      value.operation === 'review' ||
      value.operation === 'terminal'
    ) {
      if (
        owner.pending.length + owner.preparations.size >=
        CONTROL_WORKER_LIMITS.pendingTransitions
      ) {
        reply(failure(value.id, 'busy'));
      } else {
        const newDirectories: ControlContentPreparation = {
          db: owner.scopeDb,
          directories: new Set(),
          publications: owner.publications,
          published: new Set(),
        };
        if (value.operation === 'pending' && value.input.terminal) {
          if (owner.scopeDb?.scope !== 'workspace' || !owner.productOwner) {
            reply(failure(value.id, 'precondition'));
            return;
          }
          const db = owner.scopeDb;
          let preparation: Promise<void>;
          preparation = prepareControlTerminal(
            owner.scopeDb,
            value.input.terminal,
            owner.contentMount,
            newDirectories
          )
            .then(async (preparedTerminal) => {
              if (owner.poisoned || databases.get(value.database) !== owner)
                throw new ControlProductPreconditionError();
              const preparedPending = await prepareControlPendingCommands(
                db,
                [value.input.input],
                owner.contentMount,
                [],
                undefined,
                newDirectories
              );
              if (owner.poisoned || databases.get(value.database) !== owner)
                throw new ControlProductPreconditionError();
              owner.pending.push({
                ...value,
                preparedTerminal,
                preparedPending,
                preparedDirectories: [...newDirectories.directories],
                preparedPublications: [...newDirectories.published],
              });
              schedule(owner);
            })
            .catch(async (error) => {
              await releaseContentPreparation(newDirectories);
              const domain = domainRefusal('pending', error);
              reply(
                domain
                  ? { ...failure(value.id, 'precondition'), domain }
                  : failure(value.id, failureCode(error), 'not-committed')
              );
            })
            .finally(() => owner.preparations.delete(preparation));
          owner.preparations.add(preparation);
          return;
        }
        if (value.operation === 'terminal') {
          if (!owner.scopeDb || !owner.productOwner) {
            reply(failure(value.id, 'precondition'));
            return;
          }
          let preparation: Promise<void>;
          preparation = prepareControlTerminal(
            owner.scopeDb,
            value.input,
            owner.contentMount,
            newDirectories
          )
            .then((preparedTerminal) => {
              if (owner.poisoned || databases.get(value.database) !== owner)
                throw new ControlProductPreconditionError();
              owner.pending.push({
                ...value,
                preparedTerminal,
                preparedDirectories: [...newDirectories.directories],
                preparedPublications: [...newDirectories.published],
              });
              schedule(owner);
            })
            .catch(async (error) => {
              await releaseContentPreparation(newDirectories);
              reply(failure(value.id, failureCode(error), 'not-committed'));
            })
            .finally(() => {
              owner.preparations.delete(preparation);
            });
          owner.preparations.add(preparation);
          return;
        }
        // Archive must not overtake an earlier admitted producer while its bytes synchronize.
        const earlier = archivedThreads(value).length ? [...owner.preparations] : [];
        const prepare = async () => {
          if (earlier.length) await Promise.all(earlier);
          let preparedPublication: PreparedControlPublication | undefined;
          let preparedEntries: WriteRequest['preparedEntries'];
          let preparedPending: PreparedControlPendingCommand | undefined;
          let preparedGoal: PreparedControlGoalCommand | undefined;
          let preparedMaterial: ControlMaterialCommandInput | undefined;
          let preparedReview: PreparedControlReviewCommand | undefined;
          try {
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
                value.input.entries,
                undefined,
                newDirectories
              );
              preparedEntries = preparedPending.entries;
            }
            if (value.operation === 'material') {
              if (owner.scopeDb?.scope !== 'workspace') throw new ControlProductPreconditionError();
              preparedMaterial = prepareControlMaterialCommand(value.input, value.content);
            }
            if (value.operation === 'review') {
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
              if (value.transition.pending?.length && archivedThreads(value).length === 0) {
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
          } catch (error) {
            await releaseContentPreparation(newDirectories);
            // No queue or SQL effect exists yet; only later transaction/reply failures can be unknown.
            const domain = domainRefusal(value.operation, error);
            reply(
              domain
                ? { ...failure(value.id, 'precondition'), domain }
                : failure(value.id, failureCode(error), 'not-committed')
            );
            return;
          }
          if (value.operation === 'material') {
            const { content: _content, ...framing } = value;
            owner.pending.push({ ...framing, preparedMaterial });
          } else {
            owner.pending.push({
              ...value,
              preparedEntries,
              preparedGoal,
              preparedReview,
              preparedPending,
              preparedPublication,
              preparedDirectories: [...newDirectories.directories],
              preparedPublications: [...newDirectories.published],
            });
          }
          schedule(owner);
        };
        let preparation: Promise<void>;
        preparation = prepare().finally(() => owner.preparations.delete(preparation));
        owner.preparations.add(preparation);
      }
      return;
    }
    maintainDatabase(value, owner);
  } catch (error) {
    const code = failureCode(error);
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
