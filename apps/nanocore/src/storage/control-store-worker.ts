import { existsSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { isMainThread, parentPort } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { ControlStoreBusyError, controlStoreFor } from './control-store.js';
import {
  CONTROL_WORKER_LIMITS,
  CONTROL_WORKER_VERSION,
  type ControlSqlResult,
  type ControlSqlRow,
  type ControlSqlStatement,
  type ControlSqlValue,
  type ControlWorkerFailureCode,
  type ControlWorkerReply,
  type ControlWorkerRequest,
} from './control-store-worker-protocol.js';

if (isMainThread || parentPort === null) {
  throw new Error('The database writer entrypoint requires a dedicated worker thread.');
}
const port = parentPort;

/** A queued transition, not a durable request or a second command receipt. */
type WriteRequest = Extract<ControlWorkerRequest, { operation: 'write' }>;

/** One worker-owned writable connection and its finite, disposable pending work. */
interface OwnedDatabase {
  readonly sqlite: Database.Database;
  readonly writer: ReturnType<typeof controlStoreFor>;
  readonly path: string;
  readonly identity: string;
  readonly pending: WriteRequest[];
  timer: ReturnType<typeof setTimeout> | null;
  immediate: ReturnType<typeof setImmediate> | null;
  poisoned: boolean;
}

const databases = new Map<string, OwnedDatabase>();
const paths = new Set<string>();
const identities = new Set<string>();
const pendingIds = new Set<number>();

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
): ControlWorkerReply {
  return { version: CONTROL_WORKER_VERSION, id, status: 'error', code, commit };
}

/** Classifies a native failure without publishing its message, SQL or parameters. */
function failureCode(error: unknown): ControlWorkerFailureCode {
  if (error instanceof PreconditionError) return 'precondition';
  if (error instanceof ControlStoreBusyError) return 'busy';
  const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : null;
  if (typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT')) return 'constraint';
  if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED') return 'busy';
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
    const statement = sqlite.prepare(step.sql);
    const parameters = step.parameters.map(parameter);
    if (step.mode === 'run') {
      const result = statement.run(...parameters);
      if (step.expectChanges !== undefined && result.changes !== step.expectChanges) {
        throw new PreconditionError();
      }
      return { mode: 'run', ...result };
    }
    const row = statement.safeIntegers(true).get(...parameters) as ControlSqlRow | undefined;
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

/**
 * Commits at most 32 transitions, with a savepoint per transition.
 *
 * Entry failures roll back before siblings proceed. All replies wait for outer COMMIT, including error replies, so an enclosing failure cannot become success. A commit failure poisons this handle: original receipt inspection, not automatic retry or an invented recovery path, decides uncertain results.
 */
function flush(owner: OwnedDatabase): void {
  unschedule(owner);
  const batch = owner.pending.splice(0, CONTROL_WORKER_LIMITS.batchTransitions);
  if (batch.length === 0) return;
  let bodyFinished = false;
  let replies: ControlWorkerReply[];
  try {
    replies = owner.writer.write((sqlite) => {
      const outcomes: ControlWorkerReply[] = [];
      for (const request of batch) {
        sqlite.exec('SAVEPOINT control_transition');
        try {
          const results = apply(sqlite, request.statements);
          // Fail serialization before COMMIT, never after acknowledging durable truth.
          structuredClone(results);
          sqlite.exec('RELEASE control_transition');
          outcomes.push({
            version: CONTROL_WORKER_VERSION,
            id: request.id,
            status: 'ok',
            operation: 'write',
            results,
          });
        } catch (error) {
          sqlite.exec('ROLLBACK TO control_transition');
          sqlite.exec('RELEASE control_transition');
          outcomes.push(failure(request.id, failureCode(error)));
        }
      }
      bodyFinished = true;
      return outcomes;
    });
  } catch (error) {
    const unknown = bodyFinished || owner.sqlite.inTransaction;
    owner.poisoned = unknown;
    replies = batch.map((request) =>
      failure(
        request.id,
        unknown ? 'commit-unknown' : failureCode(error),
        unknown ? 'unknown' : 'not-committed'
      )
    );
  }
  for (const result of replies) reply(result);
  if (owner.poisoned) {
    for (const request of owner.pending.splice(0)) reply(failure(request.id, 'unavailable'));
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
function drain(owner: OwnedDatabase): void {
  while (owner.pending.length > 0) flush(owner);
  unschedule(owner);
}

/** Opens only a trusted admitted path; neither directory discovery nor opening grants ownership. */
function openDatabase(request: Extract<ControlWorkerRequest, { operation: 'open' }>): void {
  if (databases.has(request.database)) {
    reply(failure(request.id, 'invalid-request'));
    return;
  }
  const path =
    request.create && !existsSync(request.path)
      ? join(realpathSync(dirname(request.path)), basename(request.path))
      : realpathSync(request.path);
  const existing = statSync(path, { throwIfNoEntry: false });
  const existingIdentity = existing ? `${existing.dev}:${existing.ino}` : null;
  if (paths.has(path) || (existingIdentity !== null && identities.has(existingIdentity))) {
    reply(failure(request.id, 'invalid-request'));
    return;
  }
  const sqlite = new Database(path, { fileMustExist: !request.create });
  try {
    const writer = controlStoreFor(sqlite);
    const metadata = statSync(path);
    const identity = `${metadata.dev}:${metadata.ino}`;
    databases.set(request.database, {
      sqlite,
      writer,
      path,
      identity,
      pending: [],
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

/** Checks wire scalars before any admission or native SQL execution. */
function validValue(value: unknown): value is ControlSqlValue {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'bigint' ||
    (typeof value === 'number' && Number.isFinite(value)) ||
    value instanceof Uint8Array
  );
}

/** Refuses transaction/connection control inside an entry's owned savepoint. */
function validStatement(value: unknown): value is ControlSqlStatement {
  if (value === null || typeof value !== 'object') return false;
  const step = value as Partial<ControlSqlStatement>;
  if (typeof step.sql !== 'string' || !Array.isArray(step.parameters)) return false;
  const sql = step.sql.replace(/^(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/, '');
  if (
    !/^(SELECT|WITH|INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP|EXPLAIN|VALUES)\b/i.test(sql)
  ) {
    return false;
  }
  if (!step.parameters.every(validValue)) return false;
  if (step.mode === 'run') {
    return (
      step.expectChanges === undefined ||
      (Number.isSafeInteger(step.expectChanges) && step.expectChanges >= 0)
    );
  }
  return (
    step.mode === 'get' &&
    (step.expectRow === undefined || step.expectRow === 'present' || step.expectRow === 'absent')
  );
}

/** Unknown core wire meanings fail closed; unknown additive fields carry no authority. */
function validRequest(value: unknown): value is ControlWorkerRequest {
  if (value === null || typeof value !== 'object') return false;
  const request = value as Partial<ControlWorkerRequest>;
  if (
    request.version !== CONTROL_WORKER_VERSION ||
    !Number.isSafeInteger(request.id) ||
    (request.id ?? -1) < 0 ||
    typeof request.database !== 'string' ||
    request.database.length === 0
  )
    return false;
  if (request.operation === 'open') {
    return (
      typeof request.path === 'string' &&
      isAbsolute(request.path) &&
      typeof request.create === 'boolean'
    );
  }
  if (request.operation === 'write') {
    return (
      Array.isArray(request.statements) &&
      request.statements.length > 0 &&
      request.statements.every(validStatement)
    );
  }
  return (
    request.operation === 'checkpoint' ||
    request.operation === 'reclaim' ||
    request.operation === 'close'
  );
}

/** Routes trusted protocol messages without transporting connections or executing caller code. */
function receive(value: unknown): void {
  const id = value !== null && typeof value === 'object' && 'id' in value ? value.id : undefined;
  // Even a malformed duplicate must not complete an accepted write's correlation id.
  if (typeof id === 'number' && pendingIds.has(id)) {
    throw new Error('Duplicate database writer message identity.');
  }
  if (!validRequest(value)) {
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 0) {
      // An uncorrelatable message cannot safely complete any caller's promise.
      throw new Error('Invalid database writer protocol.');
    }
    reply(failure(id, 'invalid-request'));
    return;
  }
  pendingIds.add(value.id);
  try {
    if (value.operation === 'open') {
      openDatabase(value);
      return;
    }
    const owner = databases.get(value.database);
    if (!owner) {
      reply(failure(value.id, 'not-open'));
      return;
    }
    if (value.operation === 'close') {
      drain(owner);
      owner.sqlite.close();
      databases.delete(value.database);
      paths.delete(owner.path);
      identities.delete(owner.identity);
      reply({ version: CONTROL_WORKER_VERSION, id: value.id, status: 'ok', operation: 'close' });
      return;
    }
    if (owner.poisoned) {
      reply(failure(value.id, 'unavailable'));
      return;
    }
    if (value.operation === 'write') {
      if (owner.pending.length >= CONTROL_WORKER_LIMITS.pendingTransitions) {
        reply(failure(value.id, 'busy'));
      } else {
        owner.pending.push(value);
        schedule(owner);
      }
      return;
    }
    drain(owner);
    if (owner.poisoned) {
      reply(failure(value.id, 'unavailable'));
    } else if (value.operation === 'checkpoint') {
      reply({
        version: CONTROL_WORKER_VERSION,
        id: value.id,
        status: 'ok',
        operation: 'checkpoint',
        pressure: owner.writer.checkpoint(),
      });
    } else {
      reply({
        version: CONTROL_WORKER_VERSION,
        id: value.id,
        status: 'ok',
        operation: 'reclaim',
        complete: owner.writer.reclaim(),
      });
    }
  } catch {
    reply(failure(value.id, 'unavailable', 'unknown'));
  }
}

port.on('message', receive);
port.on('close', () => {
  for (const owner of databases.values()) {
    unschedule(owner);
    owner.pending.length = 0;
    owner.sqlite.close();
  }
});
