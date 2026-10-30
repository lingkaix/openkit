import { statfsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { MAX_ARTIFACT_FILE_BYTES } from '@openkit/protocol';

export { MAX_ARTIFACT_FILE_BYTES } from '@openkit/protocol';

/** A bounded, non-content-bearing refusal from the file admission owner. */
export class FileAdmissionError extends Error {
  /** Creates a refusal without including source paths, names, or file content. */
  constructor(
    readonly code: 'file_too_large' | 'storage_capacity_unavailable' | 'invalid_file_size'
  ) {
    super(
      code === 'file_too_large'
        ? 'The file admission byte limit was exceeded.'
        : code === 'invalid_file_size'
          ? 'The file byte length is invalid.'
          : 'Storage capacity is unavailable.'
    );
    this.name = 'FileAdmissionError';
  }
}

/** Counts actual chunks across one submission; Worker captures use one counter per file. */
export class FileByteAdmission {
  private acceptedBytes = 0;

  /** Actual accepted bytes, independent of media type and raw model output. */
  get byteLength(): number {
    return this.acceptedBytes;
  }

  /** Refuses the entire next chunk before it can be written beyond the bound. */
  consume(byteLength: number): void {
    if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
      throw new FileAdmissionError('invalid_file_size');
    }
    if (byteLength > MAX_ARTIFACT_FILE_BYTES - this.acceptedBytes) {
      throw new FileAdmissionError('file_too_large');
    }
    this.acceptedBytes += byteLength;
  }
}

/** All worst-case writes that compete for the same filesystem's free space. */
export interface FileWriteCapacity {
  readonly stagingBytes: bigint;
  readonly extractionBytes: bigint;
  readonly derivativeBytes: bigint;
  readonly publicationBytes: bigint;
}

/** Request-owned capacity, retained until publication or proved staging cleanup. */
export interface FileStorageReservation {
  /** Rechecks capacity before publication while preserving this request's reservation. */
  assertAvailable(): void;
  /** Converts completed writes into occupied disk, so their bytes are not reserved twice. */
  recordWritten(byteLength: number): void;
  /** Releases once after publication or successful cleanup; repeated calls are harmless. */
  release(): void;
  /** Releases unused forecast capacity after a bounded capture establishes the actual future writes. Never increases the reservation. */
  reduceTo(remainingBytes: bigint): void;
}

/** Outstanding forecasts and current policies for one actual filesystem. */
interface FileCapacityPool {
  reservedBytes: bigint;
  readonly policies: Set<WeakRef<() => bigint>>;
}

const filesystemPools = new Map<bigint, FileCapacityPool>();
// Injected capacity sources are independent fixtures; derived paths retain the same source.
const injectedPools = new WeakMap<() => bigint, Map<bigint, FileCapacityPool>>();

/** Resolves capacity against the nearest existing ancestor before a new file is created. */
function capacityPath(path: string): string {
  let current = resolve(path);
  for (;;) {
    try {
      statSync(current);
      return current;
    } catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT')
        throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

/** Serializes capacity admission in the single writable Data Root process. Files already on disk, including abandoned staging after restart, reduce available bytes. Completed writes reduce outstanding reservations only after the filesystem has accepted their bytes. */
export class FileStorageAdmission {
  /** Uses the current configured reserve and current non-superuser filesystem capacity. */
  constructor(
    private readonly root: string,
    private readonly reserveBytes: () => bigint,
    private readonly availableBytes?: () => bigint
  ) {
    try {
      this.pool();
    } catch {
      // Construction grants no capacity. Unreadable destination identity fails at reservation.
    }
  }

  /** Keeps the same policy and injected capacity source while selecting the destination filesystem. */
  forPath(path: string): FileStorageAdmission {
    return new FileStorageAdmission(path, this.reserveBytes, this.availableBytes);
  }

  /** Joins the actual device's forecasts; independent injected sources remain isolated. */
  private pool(): FileCapacityPool {
    const device = statSync(capacityPath(this.root), { bigint: true }).dev;
    let pools = filesystemPools;
    if (this.availableBytes) {
      let injected = injectedPools.get(this.availableBytes);
      if (!injected) {
        injected = new Map();
        injectedPools.set(this.availableBytes, injected);
      }
      pools = injected;
    }
    let pool = pools.get(device);
    if (!pool) {
      pool = { reservedBytes: 0n, policies: new Set() };
      pools.set(device, pool);
    }
    // Weak ownership avoids keeping completed Data Root lifetimes or configuration managers alive.
    if (![...pool.policies].some((reference) => reference.deref() === this.reserveBytes))
      pool.policies.add(new WeakRef(this.reserveBytes));
    return pool;
  }

  /** Reserves all write domains atomically, with no asynchronous sampling gap. */
  reserve(
    writes: FileWriteCapacity,
    priority: 'ordinary' | 'control' = 'ordinary'
  ): FileStorageReservation {
    const sizes = [
      writes.stagingBytes,
      writes.extractionBytes,
      writes.derivativeBytes,
      writes.publicationBytes,
    ];
    if (sizes.some((size) => typeof size !== 'bigint' || size < 0n)) {
      throw new FileAdmissionError('invalid_file_size');
    }
    const bytes = sizes.reduce((sum, size) => sum + size, 0n);
    let pool: FileCapacityPool;
    try {
      pool = this.pool();
      this.assertCapacity(pool, bytes, priority);
    } catch {
      throw new FileAdmissionError('storage_capacity_unavailable');
    }
    pool.reservedBytes += bytes;
    let released = false;
    let remainingBytes = bytes;
    return {
      assertAvailable: () => {
        if (released) throw new FileAdmissionError('storage_capacity_unavailable');
        this.assertCapacity(pool, 0n, priority);
      },
      recordWritten: (byteLength) => {
        if (
          released ||
          !Number.isSafeInteger(byteLength) ||
          byteLength < 0 ||
          BigInt(byteLength) > remainingBytes
        ) {
          throw new FileAdmissionError('storage_capacity_unavailable');
        }
        remainingBytes -= BigInt(byteLength);
        pool.reservedBytes -= BigInt(byteLength);
      },
      reduceTo: (bytes) => {
        if (released || typeof bytes !== 'bigint' || bytes < 0n || bytes > remainingBytes)
          throw new FileAdmissionError('storage_capacity_unavailable');
        pool.reservedBytes -= remainingBytes - bytes;
        remainingBytes = bytes;
      },
      release: () => {
        if (released) return;
        released = true;
        pool.reservedBytes -= remainingBytes;
      },
    };
  }

  /** Fails closed when either capacity or the current reserve cannot be read. */
  private assertCapacity(
    pool: FileCapacityPool,
    additionalBytes: bigint,
    priority: 'ordinary' | 'control'
  ): void {
    try {
      let reserve = 0n;
      if (priority === 'ordinary') {
        for (const reference of pool.policies) {
          const readPolicy = reference.deref();
          if (!readPolicy) {
            pool.policies.delete(reference);
            continue;
          }
          const policy = readPolicy();
          if (typeof policy !== 'bigint' || policy < 0n)
            throw new FileAdmissionError('storage_capacity_unavailable');
          if (policy > reserve) reserve = policy;
        }
      }
      const state = this.availableBytes
        ? undefined
        : statfsSync(capacityPath(this.root), { bigint: true });
      const available = this.availableBytes ? this.availableBytes() : state!.bavail * state!.bsize;
      if (
        typeof reserve !== 'bigint' ||
        typeof available !== 'bigint' ||
        reserve < 0n ||
        available < 0n ||
        available < reserve + pool.reservedBytes + additionalBytes
      ) {
        throw new FileAdmissionError('storage_capacity_unavailable');
      }
    } catch {
      throw new FileAdmissionError('storage_capacity_unavailable');
    }
  }
}
