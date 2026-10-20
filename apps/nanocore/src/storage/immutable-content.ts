import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, open, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { ContentReferenceSchema } from '@openkit/protocol';
import {
  STORAGE_LIMITS,
  type StorageAccess,
  type StorageContent,
  type StorageService,
  type StorageStage,
} from '@openkit/storage';
import {
  ensureCanonicalDirectoryAsync,
  syncCanonicalDirectoryAsync,
} from './workspace-file-records.js';

/** Trusted scope owner and the already-admitted Storage stage to consume. */
export interface ImmutableContentHandoff {
  readonly storage: StorageService;
  readonly access: StorageAccess;
  readonly stage: StorageStage;
  /** Core-managed immutable scope mount only; never an external original mount or public path. */
  readonly mountRoot: string;
}

/**
 * Publishes verified staged bytes without overwriting immutable content.
 *
 * The owning scope supplies its private content root and excludes sweep until it
 * commits the returned reference. External original mounts are not publication roots.
 * This function admits no SQL head, receipt or current access grant. A failed
 * reference transaction may leave an orphan; it must not remove a shared winner.
 * Staging cleanup remains with the admitted request's existing Storage lifetime.
 *
 * @param input Trusted mount binding and sealed Storage stage.
 * @returns Exact durable byte facts, safe for a later owning SQL transaction.
 */
export async function publishImmutableContent(
  input: ImmutableContentHandoff
): Promise<StorageContent> {
  const source = ContentReferenceSchema.parse(input.stage.content.reference);
  const byteLength = input.stage.content.byteLength;
  if (
    source.range !== null ||
    source.availability !== 'available' ||
    !Number.isSafeInteger(byteLength) ||
    byteLength < 0 ||
    byteLength > STORAGE_LIMITS.contentBytes ||
    source.knowledgeBaseId !== input.access.knowledgeBaseId ||
    source.locator.mount !== input.access.mount ||
    !isDeepStrictEqual(source.locator.ownerScope, input.access.ownerScope) ||
    input.access.mode !== 'staged-write'
  ) {
    throw new Error('Immutable handoff requires an admitted whole-content stage.');
  }
  if (byteLength === 0) {
    // Even empty bodies must resolve their real handle under current Storage admission.
    const empty = await input.storage.readStage({
      access: input.access,
      handle: input.stage.handle,
      offset: 0,
      length: 1,
    });
    if (
      empty.status !== 'ok' ||
      empty.value.offset !== 0 ||
      empty.value.data !== '' ||
      empty.value.nextOffset !== null
    ) {
      throw new Error('Immutable empty stage is unavailable or contradictory.');
    }
  }
  const hex = source.contentDigest.slice('sha256:'.length);
  const prefix = input.access.pathPrefix ? `${input.access.pathPrefix.replace(/\/$/, '')}/` : '';
  const reference = ContentReferenceSchema.parse({
    ...source,
    locator: { ...source.locator, path: `${prefix}sha256/${hex}` },
  });
  const destination = join(input.mountRoot, reference.locator.path);
  const directory = dirname(destination);
  await ensureCanonicalDirectoryAsync(directory);
  const temporary = join(directory, `.${hex}.${randomUUID()}.tmp`);
  const file = await open(temporary, 'wx', 0o600);
  try {
    const hash = createHash('sha256');
    let offset = 0;
    while (offset < byteLength) {
      const result = await input.storage.readStage({
        access: input.access,
        handle: input.stage.handle,
        offset,
        length: Math.min(STORAGE_LIMITS.chunkBytes, byteLength - offset),
      });
      if (result.status !== 'ok' || result.value.offset !== offset) {
        throw new Error('Immutable stage is unavailable or has contradictory offsets.');
      }
      const bytes = Buffer.from(result.value.data, 'base64');
      if (
        bytes.length === 0 ||
        bytes.length > Math.min(STORAGE_LIMITS.chunkBytes, byteLength - offset)
      ) {
        throw new Error('Immutable stage has an invalid chunk length.');
      }
      const next = offset + bytes.length;
      if (result.value.nextOffset !== (next === byteLength ? null : next)) {
        throw new Error('Immutable stage has a contradictory continuation.');
      }
      hash.update(bytes);
      let written = 0;
      while (written < bytes.length) {
        const part = await file.write(bytes, written, bytes.length - written, offset + written);
        if (part.bytesWritten === 0) throw new Error('Immutable content write made no progress.');
        written += part.bytesWritten;
      }
      offset = next;
    }
    if (`sha256:${hash.digest('hex')}` !== source.contentDigest) {
      throw new Error('Immutable stage digest does not match its exact bytes.');
    }
    await file.chmod(0o444);
    await file.sync();
    try {
      // Link is create-only: a concurrent publisher can win, but cannot be replaced.
      await link(temporary, destination);
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
      await verifyImmutableWinner(destination, source.contentDigest, byteLength);
    }
    await syncCanonicalDirectoryAsync(directory);
    return { reference, byteLength, mediaType: input.stage.content.mediaType };
  } finally {
    await file.close();
    await unlink(temporary);
    await syncCanonicalDirectoryAsync(directory);
  }
}

/** Verifies and synchronizes an existing digest winner; equal naming alone is not proof. */
async function verifyImmutableWinner(
  path: string,
  expectedDigest: string,
  expectedBytes: number
): Promise<void> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size !== expectedBytes) {
      throw new Error('Immutable content winner has an invalid size or file kind.');
    }
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(Math.min(STORAGE_LIMITS.chunkBytes, Math.max(1, expectedBytes)));
    let offset = 0;
    while (offset < expectedBytes) {
      const read = await file.read(
        buffer,
        0,
        Math.min(buffer.length, expectedBytes - offset),
        offset
      );
      if (read.bytesRead === 0) throw new Error('Immutable content winner is incomplete.');
      hash.update(buffer.subarray(0, read.bytesRead));
      offset += read.bytesRead;
    }
    if (`sha256:${hash.digest('hex')}` !== expectedDigest) {
      throw new Error('Immutable content winner digest does not match.');
    }
    await file.sync();
  } finally {
    await file.close();
  }
}
