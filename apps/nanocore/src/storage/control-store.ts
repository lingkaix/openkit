import { realpathSync, statSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import type Database from 'better-sqlite3';

/** Measured admission and checkpoint budgets for one owning control database. */
export interface ControlStoreBudget {
  readonly checkpointBytes: number;
  readonly checkpointAgeMs: number;
  readonly maxWalBytes: number;
  readonly maxWalAgeMs: number;
  readonly maxReadMs: number;
}

/** Initial qualification profile; final limits require the concurrent-load evidence. */
export const CONTROL_STORE_BUDGET: ControlStoreBudget = {
  checkpointBytes: 8 * 1024 * 1024,
  checkpointAgeMs: 1000,
  maxWalBytes: 32 * 1024 * 1024,
  maxWalAgeMs: 5000,
  maxReadMs: 250,
};

/** Scope-local overload; no transition was admitted when this error is thrown. */
export class ControlStoreBusyError extends Error {
  constructor() {
    super('Control database admission is blocked by checkpoint pressure.');
    this.name = 'ControlStoreBusyError';
  }
}

/** A physical-capacity refusal with proved rollback; the original failure remains private. */
export class ControlStoreNoSpaceError extends Error {
  /** Only the owning transaction can establish this definite non-commit classification. */
  constructor(cause: unknown) {
    super('Control database storage capacity is unavailable.', { cause });
    this.name = 'ControlStoreNoSpaceError';
  }
}

/** Recognizes only actual filesystem or SQLite capacity failures, without causal inference. */
function isNoSpace(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error.code === 'ENOSPC' || error.code === 'SQLITE_FULL')
  );
}

/** Current physical WAL size and conservative age since its last complete checkpoint. */
export interface ControlStorePressure {
  readonly walBytes: number;
  readonly walAgeMs: number;
}

/** SQLite's observed checkpoint progress, not proof that an external effect completed. */
export interface ControlCheckpoint extends ControlStorePressure {
  readonly busy: number;
  readonly log: number;
  readonly checkpointed: number;
}

const fileWriters = new Map<string, ControlStore>();
const memoryWriters = new WeakMap<Database.Database, ControlStore>();

/**
 * Applies owned-connection durability without converting an existing database.
 *
 * Incremental auto-vacuum must precede the first schema page. Existing authority
 * keeps its format; the authorized reset supplies fresh databases at cutover.
 *
 * @param sqlite Owned writable connection outside a transaction.
 */
export function configureOwnedSqlite(sqlite: Database.Database): void {
  if (sqlite.inTransaction) throw new Error('Database configuration requires no transaction.');
  if (sqlite.pragma('page_count', { simple: true }) === 0) {
    sqlite.pragma('auto_vacuum = INCREMENTAL');
  }
  sqlite.pragma('secure_delete = ON');
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = FULL');
  sqlite.pragma('foreign_keys = ON');
}

/**
 * Returns the single process-local writer for an existing physical database.
 *
 * Duplicate handles resolve to the original writer's connection, not parallel
 * writers. Callers must use the callback connection for all cohort statements.
 * Scope opening, integrity, authority and handle lifetime remain with db.ts.
 *
 * @param sqlite Existing admitted writable connection.
 * @param budget Scope's qualified resource limits.
 * @returns Synchronous owning writer; this does not switch existing raw callers.
 */
export function controlStoreFor(
  sqlite: Database.Database,
  budget: ControlStoreBudget = CONTROL_STORE_BUDGET
): ControlStore {
  if (!sqlite.open || sqlite.readonly)
    throw new Error('Control writer requires writable authority.');
  const key = sqlite.name === ':memory:' || sqlite.name === '' ? null : realpathSync(sqlite.name);
  const previous = key === null ? memoryWriters.get(sqlite) : fileWriters.get(key);
  if (previous?.isOpen) return previous;
  configureOwnedSqlite(sqlite);
  sqlite.pragma('wal_autocheckpoint = 0');
  const store = new ControlStore(sqlite, budget);
  if (key === null) memoryWriters.set(sqlite, store);
  else fileWriters.set(key, store);
  return store;
}

/**
 * Synchronous transaction primitive with scope-local WAL backpressure.
 *
 * Callbacks contain bounded local SQL only. The database worker places one savepoint per transition inside this outer transaction. File synchronization, external effects, notifications and waits belong outside SQL. A write returns only after COMMIT; uncertain acknowledgement uses the original receipt.
 */
class ControlStore {
  private active = false;
  private uncheckpointedSince: number | null = null;

  /** Creates the owner through controlStoreFor, not from a second caller handle. */
  constructor(
    private readonly sqlite: Database.Database,
    private readonly budget: ControlStoreBudget
  ) {
    if (
      !Object.values(budget).every((value) => Number.isFinite(value) && value > 0) ||
      budget.checkpointBytes > budget.maxWalBytes ||
      budget.checkpointAgeMs > budget.maxWalAgeMs
    ) {
      throw new Error('Control database budgets are invalid.');
    }
    if (this.pressure().walBytes > 0) {
      // Unknown pre-open WAL age cannot receive a fresh admission allowance.
      this.uncheckpointedSince = performance.now() - budget.maxWalAgeMs;
      this.checkpoint();
    }
  }

  /** Whether the externally owned connection remains usable. */
  get isOpen(): boolean {
    return this.sqlite.open;
  }

  /** Reads pressure without holding a SQL read transaction or using wall-clock time. */
  pressure(): ControlStorePressure {
    const walBytes =
      this.sqlite.name === ':memory:' || this.sqlite.name === ''
        ? 0
        : (statSync(`${this.sqlite.name}-wal`, { throwIfNoEntry: false })?.size ?? 0);
    return {
      walBytes,
      walAgeMs:
        this.uncheckpointedSince === null ? 0 : performance.now() - this.uncheckpointedSince,
    };
  }

  /**
   * Commits one bounded SQL body and its receipts, or rolls the whole body back.
   *
   * @param apply Bounded synchronous statements on the owning connection.
   * @returns Committed result; callers may publish disposable projections afterward.
   */
  write<T>(apply: (sqlite: Database.Database) => T): T {
    this.assertIdle();
    let pressure = this.pressure();
    if (
      pressure.walBytes >= this.budget.checkpointBytes ||
      pressure.walAgeMs >= this.budget.checkpointAgeMs
    ) {
      pressure = this.checkpoint();
    }
    if (
      pressure.walBytes >= this.budget.maxWalBytes ||
      pressure.walAgeMs >= this.budget.maxWalAgeMs
    ) {
      throw new ControlStoreBusyError();
    }
    this.active = true;
    let committing = false;
    try {
      this.sqlite.exec('BEGIN IMMEDIATE');
      const result = apply(this.sqlite);
      this.assertSynchronous(result);
      // COMMIT can apply even when acknowledgement fails; retain conservative age first.
      this.uncheckpointedSince ??= performance.now();
      committing = true;
      this.sqlite.exec('COMMIT');
      return result;
    } catch (error) {
      let rolledBack = !committing && !this.sqlite.inTransaction;
      if (this.sqlite.inTransaction) {
        try {
          this.sqlite.exec('ROLLBACK');
          rolledBack = !this.sqlite.inTransaction;
        } catch {
          // Cleanup cannot replace the primary failure or establish non-commit.
        }
      }
      if (isNoSpace(error) && rolledBack) throw new ControlStoreNoSpaceError(error);
      throw error;
    } finally {
      this.active = false;
    }
  }

  /**
   * Reads one bounded page without retaining a transaction across caller waits.
   *
   * The caller must bound SQL work and result size; JavaScript cannot preempt a
   * synchronous query. Over-budget pages fail rather than return a usable cursor.
   *
   * @param select Bounded synchronous query; writes are disabled for this callback.
   * @returns Materialized page after its read transaction has ended.
   */
  read<T>(select: (sqlite: Database.Database) => T): T {
    this.assertIdle();
    const queryOnly = this.sqlite.pragma('query_only', { simple: true });
    this.active = true;
    const started = performance.now();
    try {
      this.sqlite.pragma('query_only = ON');
      this.sqlite.exec('BEGIN');
      const result = select(this.sqlite);
      this.assertSynchronous(result);
      if (performance.now() - started > this.budget.maxReadMs) {
        throw new Error('Control database read exceeded its page budget.');
      }
      this.sqlite.exec('COMMIT');
      return result;
    } finally {
      if (this.sqlite.inTransaction) this.sqlite.exec('ROLLBACK');
      this.sqlite.pragma(`query_only = ${queryOnly === 1 ? 'ON' : 'OFF'}`);
      this.active = false;
    }
  }

  /**
   * Makes bounded checkpoint progress; a pinned reader never causes a busy wait.
   *
   * Truncation follows complete PASSIVE progress, with zero busy timeout for the
   * possible reader race. A failed/blocked truncation retains pressure and bytes.
   *
   * @returns Actual progress and remaining pressure for admission/diagnosis.
   */
  checkpoint(): ControlCheckpoint {
    this.assertIdle();
    const progress = (
      this.sqlite.pragma('wal_checkpoint(PASSIVE)') as [
        { busy: number; log: number; checkpointed: number },
      ]
    )[0];
    if (progress.busy === 0 && progress.checkpointed >= progress.log) {
      this.uncheckpointedSince = null;
      const timeout = this.sqlite.pragma('busy_timeout', { simple: true });
      try {
        this.sqlite.pragma('busy_timeout = 0');
        this.sqlite.pragma('wal_checkpoint(TRUNCATE)');
      } finally {
        this.sqlite.pragma(`busy_timeout = ${timeout}`);
      }
    }
    return { ...progress, ...this.pressure() };
  }

  /**
   * Reclaims at most 64 freelist pages and attempts the deletion checkpoint.
   *
   * @returns True only when no freelist pages or WAL bytes remain; blocked work is retryable.
   */
  reclaim(): boolean {
    this.assertIdle();
    if (this.checkpoint().walBytes !== 0) return false;
    this.sqlite.pragma('incremental_vacuum(64)');
    this.uncheckpointedSince ??= performance.now();
    const pressure = this.checkpoint();
    return pressure.walBytes === 0 && this.sqlite.pragma('freelist_count', { simple: true }) === 0;
  }

  /** Rejects nesting so one transition cannot acknowledge an enclosing uncommitted write. */
  private assertIdle(): void {
    if (this.active || this.sqlite.inTransaction) {
      throw new Error('Control database operation cannot nest an existing transaction.');
    }
  }

  /** Refuses accidental async callbacks before committing their synchronous prefix. */
  private assertSynchronous(value: unknown): void {
    if (value !== null && typeof value === 'object' && 'then' in value) {
      throw new Error('Control database callbacks must be synchronous.');
    }
  }
}
