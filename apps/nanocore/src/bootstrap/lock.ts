import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { ensureLayout } from '../storage/fs-layout.js';

const LOCK_FILE_NAME = 'nanocore.lock';
const HEARTBEAT_MS = 5_000;

/** Input for acquiring the data-root instance lock. */
export interface DataRootLockInput {
  /** Boot id for the process that owns the lock. */
  bootId: string;
  /** Optional process id override for tests. */
  pid?: number;
  /** Optional clock override for tests. */
  now?: () => string;
}

/** Active data-root lock handle. */
export interface DataRootLock {
  /** Summary of how the lock was acquired. */
  acquisition: DataRootLockAcquisition;
  /** Absolute lockfile path. */
  path: string;
  /** Releases the lock when the current process still owns it. */
  release(): void;
}

/** Durable-safe summary of one data-root lock acquisition. */
export interface DataRootLockAcquisition {
  /** Lock acquisition outcome. */
  status: 'acquired' | 'stale_broken';
  /** Absolute lockfile path. */
  lockPath: string;
  /** Previous stale holder when a stale lock was broken. */
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
   * @param lockPath Lockfile path that could not be acquired.
   * @param holder Existing holder metadata.
   */
  public constructor(lockPath: string, holder: unknown) {
    super(`NanoCore data root is already locked: ${lockPath}`);
    this.name = 'DataRootLockError';
    this.holder = holder;
  }
}

/**
 * Returns the lockfile path for one data root.
 *
 * @param dataRoot NanoCore data root.
 * @returns Absolute or relative lockfile path.
 */
export function dataRootLockPath(dataRoot: string): string {
  return join(ensureLayout(dataRoot).serverRuntime, LOCK_FILE_NAME);
}

/**
 * Acquires the exclusive NanoCore data-root lock.
 *
 * @param dataRoot NanoCore data root.
 * @param input Lock owner input.
 * @returns Lock handle that must be released on orderly shutdown.
 */
export function acquireDataRootLock(dataRoot: string, input: DataRootLockInput): DataRootLock {
  const lockPath = dataRootLockPath(dataRoot);
  const now = input.now ?? (() => new Date().toISOString());
  const record: DataRootLockRecord = {
    schemaVersion: 1,
    bootId: input.bootId,
    pid: input.pid ?? process.pid,
    hostname: hostname(),
    createdAt: now(),
    updatedAt: now(),
  };

  let fd: number;
  let acquisition: DataRootLockAcquisition = {
    status: 'acquired',
    lockPath,
    staleHolder: null,
  };
  try {
    fd = openSync(lockPath, 'wx');
  } catch (error) {
    if (isExistingLockError(error)) {
      const holder = readLockRecord(lockPath);

      if (canBreakDeadLocalLock(holder)) {
        unlinkSync(lockPath);
        fd = openSync(lockPath, 'wx');
        acquisition = {
          status: 'stale_broken',
          lockPath,
          staleHolder: holder,
        };
      } else {
        throw new DataRootLockError(lockPath, holder);
      }
    } else {
      throw error;
    }
  }

  writeFileSync(fd, `${JSON.stringify(record, null, 2)}\n`);
  closeSync(fd);

  const heartbeat = setInterval(() => {
    writeLockRecord(lockPath, { ...record, updatedAt: now() });
  }, HEARTBEAT_MS);
  heartbeat.unref();

  return {
    acquisition,
    path: lockPath,
    release() {
      clearInterval(heartbeat);

      if (lockStillOwned(lockPath, record.bootId)) {
        unlinkSync(lockPath);
      }
    },
  };
}

/**
 * Writes a lock record to disk.
 *
 * @param lockPath Lockfile path.
 * @param record Lock record to write.
 */
function writeLockRecord(lockPath: string, record: DataRootLockRecord): void {
  writeFileSync(lockPath, `${JSON.stringify(record, null, 2)}\n`);
}

/**
 * Reads a lock record, returning null when it is unreadable.
 *
 * @param lockPath Lockfile path.
 * @returns Parsed lock record or null.
 */
function readLockRecord(lockPath: string): unknown {
  try {
    return JSON.parse(readFileSync(lockPath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Checks whether an existing lock belongs to a dead local process.
 *
 * @param holder Existing lock holder metadata.
 * @returns True when the holder is local and confirmed dead.
 */
function canBreakDeadLocalLock(holder: unknown): boolean {
  if (!isDataRootLockRecord(holder) || holder.hostname !== hostname()) {
    return false;
  }

  return !processIsAlive(holder.pid);
}

/**
 * Checks whether a value is a parseable data-root lock record.
 *
 * @param value Parsed lockfile value.
 * @returns True when the value has the fields needed for safe stale-lock probing.
 */
function isDataRootLockRecord(value: unknown): value is DataRootLockRecord {
  return (
    typeof value === 'object' &&
    value !== null &&
    'schemaVersion' in value &&
    value.schemaVersion === 1 &&
    'bootId' in value &&
    typeof value.bootId === 'string' &&
    'pid' in value &&
    Number.isInteger(value.pid) &&
    'hostname' in value &&
    typeof value.hostname === 'string' &&
    'createdAt' in value &&
    typeof value.createdAt === 'string' &&
    'updatedAt' in value &&
    typeof value.updatedAt === 'string'
  );
}

/**
 * Checks whether a local process id appears alive.
 *
 * @param pid Process id from the lock holder.
 * @returns True when the process is alive or liveness is indeterminate.
 */
function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isNoSuchProcessError(error);
  }
}

/**
 * Checks whether a caught error means the lockfile already exists.
 *
 * @param error Unknown thrown value.
 * @returns True when the error is an existing-file failure.
 */
function isExistingLockError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}

/**
 * Checks whether a caught process signal error means the process is absent.
 *
 * @param error Unknown thrown value.
 * @returns True when the process does not exist.
 */
function isNoSuchProcessError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ESRCH';
}

/**
 * Checks whether the lockfile still belongs to a boot id.
 *
 * @param lockPath Lockfile path.
 * @param bootId Boot id expected in the record.
 * @returns True when the lockfile still belongs to the boot id.
 */
function lockStillOwned(lockPath: string, bootId: string): boolean {
  if (!existsSync(lockPath)) {
    return false;
  }

  const record = readLockRecord(lockPath) as { bootId?: unknown } | null;
  return record?.bootId === bootId;
}
