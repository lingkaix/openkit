import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname } from 'node:path';
import { resolveDataRootPath } from '../storage/fs-layout.js';

const LOCK_FILE_NAME = 'nanocore.lock';
const HEARTBEAT_MS = 5_000;
const LOCK_CONFLICT_EXIT_CODE = 75;

/** Input for acquiring the data-root instance lock. */
export interface DataRootLockInput {
  /** Boot id for the process that owns the lock. */
  bootId: string;
  /** Optional process id override for diagnostic metadata in tests. */
  pid?: number;
  /** Optional clock override for tests. */
  now?: () => string;
}

/** Active data-root lock handle. */
export interface DataRootLock {
  /** Summary of how the lock was acquired. */
  acquisition: DataRootLockAcquisition;
  /** Absolute lockfile path, also used for diagnostic metadata. */
  path: string;
  /** Removes diagnostic metadata and releases kernel ownership. */
  release(): void;
}

/** Durable-safe summary of one data-root lock acquisition. */
export interface DataRootLockAcquisition {
  /** Lock acquisition outcome. */
  status: 'acquired' | 'stale_broken';
  /** Absolute lockfile path, also used for diagnostic metadata. */
  lockPath: string;
  /** Previous stale metadata replaced after kernel ownership was acquired. */
  staleHolder: unknown | null;
}

interface DataRootLockRecord {
  schemaVersion: 1;
  bootId: string;
  pid: number;
  hostname: string;
  createdAt: string;
  updatedAt: string;
}

/** Error thrown when another NanoCore holder owns the data root. */
export class DataRootLockError extends Error {
  /** Existing holder metadata when the lockfile could be read. */
  public readonly holder: unknown;

  /**
   * Creates a data-root lock error.
   *
   * @param lockPath Holder-metadata path for the unavailable data-root lock.
   * @param holder Existing holder metadata.
   */
  public constructor(lockPath: string, holder: unknown) {
    super(`NanoCore data root is already locked: ${lockPath}`);
    this.name = 'DataRootLockError';
    this.holder = holder;
  }
}

/**
 * Returns the diagnostic holder-metadata path for one data root.
 *
 * @param dataRoot NanoCore data root.
 * @returns Absolute or relative holder-metadata path.
 */
export function dataRootLockPath(dataRoot: string): string {
  return resolveDataRootPath(dataRoot, 'server', 'runtime', LOCK_FILE_NAME);
}

/**
 * Holds the kernel-backed whole-data-root lock until release or process death.
 *
 * @param dataRoot NanoCore data root.
 * @param input Lock owner input.
 * @returns Lock handle retained until orderly shutdown.
 */
export function acquireDataRootLock(dataRoot: string, input: DataRootLockInput): DataRootLock {
  const lockPath = dataRootLockPath(dataRoot);
  const fd = openSync(dirname(lockPath), 'r');
  try {
    // Lock the existing runtime directory; metadata can keep its stopped-server lifecycle.
    // flock locks the inherited open file description; Node retains it after this utility exits.
    // Unlike process-owned fcntl locks, unrelated metadata reads cannot release this ownership.
    const attempt = spawnSync(
      'flock',
      ['--exclusive', '--nonblock', '--conflict-exit-code', String(LOCK_CONFLICT_EXIT_CODE), '3'],
      { stdio: ['ignore', 'ignore', 'pipe', fd], env: { PATH: process.env.PATH } }
    );
    if (attempt.error) throw attempt.error;
    if (attempt.status === LOCK_CONFLICT_EXIT_CODE) {
      throw new DataRootLockError(lockPath, readLockRecord(lockPath));
    }
    if (attempt.status !== 0) {
      throw new Error(`NanoCore data-root kernel locking failed (flock exit ${attempt.status}).`);
    }
    const stale = existsSync(lockPath);
    const staleHolder = stale ? readLockRecord(lockPath) : null;
    const now = input.now ?? (() => new Date().toISOString());
    const record: DataRootLockRecord = {
      schemaVersion: 1,
      bootId: input.bootId,
      pid: input.pid ?? process.pid,
      hostname: hostname(),
      createdAt: now(),
      updatedAt: now(),
    };
    writeLockRecord(lockPath, record);

    const heartbeat = setInterval(() => {
      writeLockRecord(lockPath, { ...record, updatedAt: now() });
    }, HEARTBEAT_MS);
    heartbeat.unref();
    let released = false;

    return {
      acquisition: {
        status: stale ? 'stale_broken' : 'acquired',
        lockPath,
        staleHolder,
      },
      path: lockPath,
      release() {
        if (released) return;
        released = true;
        clearInterval(heartbeat);
        try {
          // The runtime directory inode stays fixed; only diagnostic metadata is removed.
          unlinkSync(lockPath);
        } finally {
          closeSync(fd);
        }
      },
    };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

/**
 * Updates diagnostic holder metadata while directory ownership is held.
 *
 * @param lockPath Holder-metadata path.
 * @param record Lock record to write.
 */
function writeLockRecord(lockPath: string, record: DataRootLockRecord): void {
  writeFileSync(lockPath, `${JSON.stringify(record, null, 2)}\n`);
}

/**
 * Reads holder metadata, returning null when it is unreadable.
 *
 * @param lockPath Holder-metadata path.
 * @returns Parsed lock record or null.
 */
function readLockRecord(lockPath: string): unknown {
  try {
    return JSON.parse(readFileSync(lockPath, 'utf8'));
  } catch {
    return null;
  }
}
