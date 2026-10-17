import { statfsSync } from 'node:fs';
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

/** Serializes capacity admission in the single writable Data Root process. Files already on disk, including abandoned staging after restart, reduce available bytes. Completed writes reduce outstanding reservations only after the filesystem has accepted their bytes. */
export class FileStorageAdmission {
  private reservedBytes = 0n;

  /** Uses the current configured reserve and current non-superuser filesystem capacity. */
  constructor(
    root: string,
    private readonly reserveBytes: () => bigint,
    private readonly availableBytes: () => bigint = () => {
      const state = statfsSync(root, { bigint: true });
      return state.bavail * state.bsize;
    }
  ) {}

  /** Reserves all write domains atomically, with no asynchronous sampling gap. */
  reserve(writes: FileWriteCapacity): FileStorageReservation {
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
    this.assertCapacity(bytes);
    this.reservedBytes += bytes;
    let released = false;
    let remainingBytes = bytes;
    return {
      assertAvailable: () => {
        if (released) throw new FileAdmissionError('storage_capacity_unavailable');
        this.assertCapacity(0n);
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
        this.reservedBytes -= BigInt(byteLength);
      },
      reduceTo: (bytes) => {
        if (released || typeof bytes !== 'bigint' || bytes < 0n || bytes > remainingBytes)
          throw new FileAdmissionError('storage_capacity_unavailable');
        this.reservedBytes -= remainingBytes - bytes;
        remainingBytes = bytes;
      },
      release: () => {
        if (released) return;
        released = true;
        this.reservedBytes -= remainingBytes;
      },
    };
  }

  /** Fails closed when either capacity or the current reserve cannot be read. */
  private assertCapacity(additionalBytes: bigint): void {
    try {
      const reserve = this.reserveBytes();
      const available = this.availableBytes();
      if (
        typeof reserve !== 'bigint' ||
        typeof available !== 'bigint' ||
        reserve < 0n ||
        available < reserve + this.reservedBytes + additionalBytes
      ) {
        throw new FileAdmissionError('storage_capacity_unavailable');
      }
    } catch {
      throw new FileAdmissionError('storage_capacity_unavailable');
    }
  }
}
