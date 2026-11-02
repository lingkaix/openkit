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
