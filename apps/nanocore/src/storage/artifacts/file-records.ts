import { closeSync, constants, createReadStream, fstatSync, openSync } from 'node:fs';
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
