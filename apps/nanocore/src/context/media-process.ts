import { createHash } from 'node:crypto';
import { chmod, mkdtemp, open, rm } from 'node:fs/promises';
import { join } from 'node:path';

/** An authorized immutable source. Emit at most 64KiB per chunk and honor cancellation. */
export interface MediaByteSource {
  sourceKey: string;
  revision: string;
  originalDigest: string;
  byteLength: number;
  open(signal: AbortSignal): AsyncIterable<Uint8Array>;
}
/** Digest of the observed processor versions and actual enforced invocation/resource configuration; it is not binary or image attestation. */
export interface MediaResourceProfile {
  resourceProfileDigest: string;
}
/** Existing shared disk-owner reservation; completed writes become occupied filesystem bytes. */
export interface MediaStageReservation {
  recordWritten(bytes: bigint): void;
  release(): void;
}
/** Closed infrastructure failures, without peer text, host paths or source bodies. */
export class MediaProcessFailure extends Error {
  constructor(
    readonly reason:
      | 'source-unavailable'
      | 'source-changed'
      | 'resource-limited'
      | 'cleanup-unavailable'
  ) {
    super(reason);
  }
}
/** Owns private staging and proved cleanup through the source owner's existing shared reservation. */
export async function withStagedMediaSource<T>(
  source: MediaByteSource,
  temporaryRoot: string,
  reserveTemporaryBytes: (bytes: number) => MediaStageReservation,
  signal: AbortSignal,
  prefix: string,
  consume: (path: string) => Promise<T>
): Promise<T> {
  let reservation: MediaStageReservation;
  try {
    reservation = reserveTemporaryBytes(source.byteLength);
  } catch {
    throw new MediaProcessFailure('resource-limited');
  }
  let directory: string | undefined;
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    directory = await mkdtemp(join(temporaryRoot, prefix));
    await chmod(directory, 0o700);
    const path = join(directory, 'input.pdf');
    await stageSource(source, path, signal, (bytes) => reservation.recordWritten(bytes));
    outcome = { ok: true, value: await consume(path) };
  } catch (error) {
    outcome = { ok: false, error };
  }
  // Cleanup uncertainty retains capacity and cannot expose a partially accepted representation.
  try {
    if (directory) await rm(directory, { recursive: true, force: true });
    reservation.release();
  } catch {
    throw new MediaProcessFailure('cleanup-unavailable');
  }
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

/** Copies bounded chunks into a new private file and verifies the exact canonical digest. */
async function stageSource(
  source: MediaByteSource,
  path: string,
  signal: AbortSignal,
  recordWritten: (bytes: bigint) => void
): Promise<void> {
  const file = await open(path, 'wx', 0o600);
  const hash = createHash('sha256');
  let observed = 0;
  let iterator: AsyncIterator<Uint8Array> | undefined;
  try {
    iterator = source.open(signal)[Symbol.asyncIterator]();
    while (true) {
      const next = await withCancellation(iterator.next(), signal);
      if (next.done) break;
      if (
        !(next.value instanceof Uint8Array) ||
        next.value.byteLength > source.byteLength - observed
      )
        throw new MediaProcessFailure('source-changed');
      if (next.value.byteLength === 0 || next.value.byteLength > 65_536)
        throw new MediaProcessFailure('source-unavailable');
      signal.throwIfAborted();
      // Own this bounded view while asynchronous I/O runs; the producer cannot mutate the digest proof.
      const chunk = Buffer.from(next.value);
      await file.writeFile(chunk);
      recordWritten(BigInt(chunk.byteLength));
      hash.update(chunk);
      observed += chunk.byteLength;
    }
    if (observed !== source.byteLength || `sha256:${hash.digest('hex')}` !== source.originalDigest)
      throw new MediaProcessFailure('source-changed');
  } finally {
    await file.close();
    // A source owner must honor the signal; its uncooperative iterator cannot delay cleanup.
    void iterator?.return?.().catch(() => {});
  }
  await chmod(path, 0o400);
}

/** Releases an abort listener on both completion and cancellation without waiting on a source. */
function withCancellation<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      }
    );
    if (signal.aborted) abort();
  });
}

/** Validates immutable source metadata before private staging. */
export function validMediaSource(source: MediaByteSource): boolean {
  return (
    typeof source.sourceKey === 'string' &&
    source.sourceKey.length > 0 &&
    source.sourceKey.length <= 1024 &&
    typeof source.revision === 'string' &&
    source.revision.length > 0 &&
    source.revision.length <= 256 &&
    /^sha256:[0-9a-f]{64}$/.test(source.originalDigest) &&
    Number.isSafeInteger(source.byteLength) &&
    source.byteLength >= 0 &&
    source.byteLength <= 1_000_000_000 &&
    typeof source.open === 'function'
  );
}
