import { closeSync, constants, createReadStream, fstatSync, openSync, readSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Readable } from 'node:stream';
import { resolveDataRootPath } from '../fs-layout.js';
import {
  assertCanonicalDirectory,
  measureCanonicalFileDescriptor,
} from '../workspace-file-records.js';

/** Resolves one immutable version-owned payload without accepting path syntax as identity. */
export function artifactFilePayloadPath(
  workspaceRoot: string,
  artifactId: string,
  version: number
): string {
  if (
    !artifactId ||
    artifactId === '.' ||
    artifactId === '..' ||
    /[\\/\0]/.test(artifactId) ||
    !Number.isSafeInteger(version) ||
    version < 1
  ) {
    throw new Error('The Artifact file identity is invalid.');
  }
  return resolveDataRootPath(
    workspaceRoot,
    'artifacts',
    artifactId,
    'versions',
    String(version),
    'payload'
  );
}

/** Verifies exact bytes with a bounded buffer and an unchanged no-follow file descriptor. This synchronous verifier serves the existing synchronous Store and boot owner. Transfer staging and downloads use backpressure; no canonical body is materialized. */
export function verifyArtifactFilePayload(input: {
  readonly workspaceRoot: string;
  readonly artifactId: string;
  readonly version: number;
  readonly byteLength: number;
  readonly contentDigest: string;
}): void {
  const descriptor = openArtifactFilePayload(input);
  closeSync(descriptor);
}

/** Opens an exact verified immutable version for streamed download or Worker delivery. */
export function readArtifactFilePayload(input: {
  readonly workspaceRoot: string;
  readonly artifactId: string;
  readonly version: number;
  readonly byteLength: number;
  readonly contentDigest: string;
  readonly signal?: AbortSignal;
}): Readable {
  input.signal?.throwIfAborted();
  const descriptor = openArtifactFilePayload(input);
  return createReadStream('', {
    fd: descriptor,
    autoClose: true,
    start: 0,
    highWaterMark: 65_536,
    signal: input.signal,
  });
}

/** Existing inline Material publication has a bounded text processor, independent of arbitrary-file admission. */
export const MAX_ARTIFACT_MATERIAL_TEXT_BYTES = 16_777_216;

/** Reads a complete small UTF-8 original for text-only consumers. Larger or non-UTF-8 files have no inline representation; missing/corrupt originals still fail. BOM bytes are preserved in the exact text round trip. */
export function readArtifactFileText(input: {
  readonly workspaceRoot: string;
  readonly artifactId: string;
  readonly version: number;
  readonly byteLength: number;
  readonly contentDigest: string;
  readonly maximumBytes: number;
}): string | null {
  if (
    !Number.isSafeInteger(input.maximumBytes) ||
    input.maximumBytes < 0 ||
    input.maximumBytes > MAX_ARTIFACT_MATERIAL_TEXT_BYTES
  )
    throw new Error('Artifact text processor limit is invalid.');
  const bytes = readArtifactFileBytes(input);
  if (bytes === null) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Reads complete original bytes within the native caller's explicit allocation bound.
 * @param input Exact version-owned identity, integrity evidence and caller-owned maximum.
 * @returns Verified unchanged bytes, or null when the original exceeds the caller's bound.
 * @throws Error for an invalid bound or unavailable, changed or corrupt original.
 */
export function readArtifactFileBytes(input: {
  readonly workspaceRoot: string;
  readonly artifactId: string;
  readonly version: number;
  readonly byteLength: number;
  readonly contentDigest: string;
  readonly maximumBytes: number;
}): Buffer | null {
  if (!Number.isSafeInteger(input.maximumBytes) || input.maximumBytes < 0)
    throw new Error('Artifact byte reader limit is invalid.');
  if (input.byteLength > input.maximumBytes) return null;
  const descriptor = openArtifactFilePayload(input);
  try {
    const before = fstatSync(descriptor, { bigint: true });
    const bytes = Buffer.alloc(input.byteLength);
    let position = 0;
    while (position < bytes.byteLength) {
      const count = readSync(
        descriptor,
        bytes,
        position,
        Math.min(65_536, bytes.byteLength - position),
        position
      );
      if (!count) throw new Error('The Artifact original changed during byte reading.');
      position += count;
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      after.nlink !== 1n
    )
      throw new Error('The Artifact original changed during byte reading.');
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

/** Verifies the owner path and original digest, retaining one descriptor on success. */
function openArtifactFilePayload(input: {
  readonly workspaceRoot: string;
  readonly artifactId: string;
  readonly version: number;
  readonly byteLength: number;
  readonly contentDigest: string;
}): number {
  const path = artifactFilePayloadPath(input.workspaceRoot, input.artifactId, input.version);
  let parent = dirname(path);
  for (let level = 0; level < 5; level += 1) {
    assertCanonicalDirectory(parent);
    parent = dirname(parent);
  }
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      !Number.isSafeInteger(input.byteLength) ||
      input.byteLength < 0 ||
      before.size !== BigInt(input.byteLength)
    ) {
      throw new Error('The Artifact file version is unavailable.');
    }
    const measured = measureCanonicalFileDescriptor(descriptor);
    if (
      measured.byteLength !== input.byteLength ||
      measured.contentDigest !== input.contentDigest
    ) {
      throw new Error('The Artifact file version failed integrity verification.');
    }
    return descriptor;
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}
