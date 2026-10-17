import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';
import { ArtifactAuthorityError } from '../lib/store.js';
import { getRetrievalService } from '../retrieval-service.js';
import type { StagedArtifactPayload } from '../storage/artifacts/file-payload.js';
import {
  requireWorkerCredentialCheckValues,
  type WorkerCredentialCheckValues,
} from './worker-credential-guard.js';

const RANGE_BYTES = 16 * 1024 * 1024;
const OVERLAP_BYTES = 42;
const WALL_MS = 300_000;

/** Core selects original private proof and requires complete exact coverage; the sidecar sees generic digests only. */
export async function assertWorkerArtifactDigestProof(input: {
  readonly dataRoot: string;
  readonly ownerRoot: string;
  readonly payload: StagedArtifactPayload;
  readonly evidence: WorkerCredentialCheckValues;
  readonly signal?: AbortSignal;
}): Promise<void> {
  const values = requireWorkerCredentialCheckValues(input.evidence);
  const path = relative(input.dataRoot, input.payload.path);
  if (!path || path.startsWith('..') || isAbsolute(path)) throw unavailable();
  const timeout = AbortSignal.timeout(WALL_MS);
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
  const service = getRetrievalService(input.dataRoot, input.ownerRoot);
  const patterns = [
    { window_bytes: 43, encoding: 'base64url-text' as const, digests: values.loopbackDigests },
    {
      window_bytes: 43,
      encoding: 'base64url-decoded' as const,
      digests: Object.values(values.routeTokenHashes),
    },
  ];
  try {
    // Empty originals still get one source identity check. Each later range repeats 42 bytes,
    // so every possible 43-byte candidate is included without joining separate source ranges.
    let start = 0;
    do {
      signal.throwIfAborted();
      const end = Math.min(input.payload.byteLength, start + RANGE_BYTES);
      const result = await service.digestWindows(
        {
          path,
          source_bytes: input.payload.byteLength,
          start,
          end,
          patterns,
          bounds: { max_bytes: RANGE_BYTES, max_matches: 1024, timeout_ms: 30_000 },
        },
        signal
      );
      if (result.matches.length)
        throw new ArtifactAuthorityError(
          'invalid_request',
          'Worker Artifact content contains injected credential material.'
        );
      if (end === input.payload.byteLength) break;
      start = end - OVERLAP_BYTES;
    } while (start < input.payload.byteLength);
    // Publication uses the same private, single-link original. Recheck the complete original
    // asynchronously after all range proofs; a partial range hash is never a whole-file identity.
    await verifyOriginal(input.payload, signal);
  } catch (error) {
    input.signal?.throwIfAborted();
    if (error instanceof ArtifactAuthorityError) throw error;
    throw unavailable();
  }
}
/** Verify original length, digest and metadata without loading it whole or blocking the event loop. */
async function verifyOriginal(payload: StagedArtifactPayload, signal: AbortSignal): Promise<void> {
  const source = await open(
    payload.path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    const before = await source.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size !== BigInt(payload.byteLength))
      throw unavailable();
    const buffer = Buffer.allocUnsafe(65_536),
      hash = createHash('sha256');
    let position = 0;
    while (position < payload.byteLength) {
      signal.throwIfAborted();
      const { bytesRead } = await source.read(
        buffer,
        0,
        Math.min(buffer.byteLength, payload.byteLength - position),
        position
      );
      if (!bytesRead) throw unavailable();
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await source.stat({ bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.nlink !== after.nlink ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      `sha256:${hash.digest('hex')}` !== payload.contentDigest
    )
      throw unavailable();
    signal.throwIfAborted();
  } finally {
    await source.close();
  }
}
/** A bounded fixed refusal contains neither credential material nor source paths. */
function unavailable(): ArtifactAuthorityError {
  return new ArtifactAuthorityError(
    'recovery_required',
    'Worker Artifact comparison proof is unavailable.'
  );
}
