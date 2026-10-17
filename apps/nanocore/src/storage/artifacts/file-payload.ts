import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { type Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  ensureCanonicalDirectoryAsync,
  syncCanonicalDirectoryAsync,
} from '../workspace-file-records.js';
import {
  FileAdmissionError,
  FileByteAdmission,
  type FileStorageReservation,
  MAX_ARTIFACT_FILE_BYTES,
} from './file-admission.js';

/** Immutable bytes verified in private same-filesystem staging, without product acceptance. */
export interface StagedArtifactPayload {
  readonly path: string;
  readonly byteLength: number;
  readonly contentDigest: string;
  /** Removes this request's files; reservation release requires this cleanup to succeed. */
  remove(): Promise<void>;
}

/** A failed capture whose occupied staging could not be proved removed. */
export class ArtifactPayloadCleanupError extends Error {
  /** Retains private diagnostic causes without exposing source bytes in the message. */
  constructor(causes: readonly unknown[]) {
    super('Artifact payload staging requires cleanup.', { cause: new AggregateError(causes) });
    this.name = 'ArtifactPayloadCleanupError';
  }
}

/** A complete stream whose actual bytes contradict admitted file metadata. */
export class ArtifactPayloadIntegrityError extends Error {
  /** Creates a bounded refusal without revealing source content. */
  constructor(readonly code: 'invalid_request' | 'source_digest_mismatch') {
    super('The file bytes do not match their admitted size and digest.');
    this.name = 'ArtifactPayloadIntegrityError';
  }
}

/** Captures exact bytes with stream backpressure and no text decoding. The caller holds the capacity reservation through publication or proved cleanup. Existing boot staging cleanup handles abandoned requests without claiming acceptance. */
export async function stageArtifactPayload(input: {
  readonly workspaceRoot: string;
  readonly source: Readable;
  readonly expectedByteLength: number;
  readonly expectedDigest: string;
  readonly reservation: FileStorageReservation;
  readonly submission?: FileByteAdmission;
  readonly signal?: AbortSignal;
  /** Optional source-owned check before any original chunk can be written. */
  readonly inspectChunk?: (chunk: Buffer) => void;
}): Promise<StagedArtifactPayload> {
  if (
    !Number.isSafeInteger(input.expectedByteLength) ||
    input.expectedByteLength < 0 ||
    input.expectedByteLength > MAX_ARTIFACT_FILE_BYTES ||
    !/^sha256:[a-f0-9]{64}$/.test(input.expectedDigest)
  ) {
    input.source.destroy();
    throw new FileAdmissionError('invalid_file_size');
  }
  input.signal?.throwIfAborted();
  input.reservation.assertAvailable();
  const stagingParent = join(dirname(input.workspaceRoot), '.staging');
  await ensureCanonicalDirectoryAsync(stagingParent);
  const requestRoot = await mkdtemp(join(stagingParent, 'artifact-'));
  const path = join(requestRoot, 'payload');
  const counter = new FileByteAdmission();
  const hash = createHash('sha256');
  let descriptor: Awaited<ReturnType<typeof open>> | undefined;
  let pendingWrite: Promise<void> | undefined;
  try {
    descriptor = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    );
    const count = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        try {
          input.inspectChunk?.(chunk);
          counter.consume(chunk.byteLength);
          input.submission?.consume(chunk.byteLength);
          if (counter.byteLength > input.expectedByteLength) {
            throw new ArtifactPayloadIntegrityError('invalid_request');
          }
          hash.update(chunk);
          callback(null, chunk);
        } catch (error) {
          callback(error as Error);
        }
      },
    });
    const file = descriptor;
    const sink = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        // Keep descriptor ownership here so pipeline cancellation cannot close it
        // before durable synchronization or request-local cleanup.
        const writeChunk = async () => {
          let offset = 0;
          while (offset < chunk.byteLength) {
            const { bytesWritten } = await file.write(chunk, offset);
            if (bytesWritten === 0) throw new Error('The file write made no progress.');
            input.reservation.recordWritten(bytesWritten);
            offset += bytesWritten;
          }
        };
        pendingWrite = writeChunk();
        void pendingWrite.then(() => callback(), callback);
      },
    });
    await pipeline(input.source, count, sink, { signal: input.signal });
    const contentDigest = `sha256:${hash.digest('hex')}`;
    if (counter.byteLength !== input.expectedByteLength || contentDigest !== input.expectedDigest) {
      throw new ArtifactPayloadIntegrityError(
        counter.byteLength !== input.expectedByteLength
          ? 'invalid_request'
          : 'source_digest_mismatch'
      );
    }
    await descriptor.sync();
    await descriptor.close();
    descriptor = undefined;
    await syncCanonicalDirectoryAsync(requestRoot);
    input.signal?.throwIfAborted();
    input.reservation.assertAvailable();
    return {
      path,
      byteLength: counter.byteLength,
      contentDigest,
      remove: () => rm(requestRoot, { recursive: true, force: true }),
    };
  } catch (error) {
    // Pipeline destruction may precede completion of an already-started file write.
    await pendingWrite?.catch(() => {});
    const cleanupErrors: unknown[] = [];
    try {
      await descriptor?.close();
    } catch (closeError) {
      cleanupErrors.push(closeError);
    }
    try {
      await rm(requestRoot, { recursive: true, force: true });
    } catch (removeError) {
      cleanupErrors.push(removeError);
    }
    if (cleanupErrors.length) throw new ArtifactPayloadCleanupError([error, ...cleanupErrors]);
    throw error;
  }
}
