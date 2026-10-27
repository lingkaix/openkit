import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { type FileHandle, link, lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { ContentReferenceSchema } from '@openkit/protocol';
import {
  LocalStorage,
  STORAGE_LIMITS,
  type StorageAccess,
  type StorageContent,
  type StorageService,
  type StorageStage,
} from '@openkit/storage';
import {
  CONTROL_PRODUCT_LIMITS,
  type ControlProductContentMount,
  type ControlProductEntry,
  ControlProductEntrySchema,
  type ControlProductOwner,
  inlineControlContentBytes,
} from './control-store-products.js';
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
  const content = immutableStageContent(input);
  const source = content.reference;
  const byteLength = content.byteLength;
  const hex = source.contentDigest.slice('sha256:'.length);
  const reference = content.reference;
  const destination = join(input.mountRoot, reference.locator.path);
  const directory = dirname(destination);
  await ensureCanonicalDirectoryAsync(directory);
  const temporary = join(directory, `.${hex}.${randomUUID()}.tmp`);
  const file = await open(temporary, 'wx', 0o600);
  try {
    await copyImmutableStage(input, file, content);
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

/** Validates the existing sealed Storage admission and derives its immutable descriptor. */
function immutableStageContent(input: ImmutableContentHandoff): StorageContent {
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
  const hex = source.contentDigest.slice('sha256:'.length);
  const prefix = input.access.pathPrefix ? `${input.access.pathPrefix.replace(/\/$/, '')}/` : '';
  const reference = ContentReferenceSchema.parse({
    ...source,
    locator: { ...source.locator, path: `${prefix}sha256/${hex}` },
  });
  return { reference, byteLength, mediaType: input.stage.content.mediaType };
}

/** Copies and verifies a sealed stage without choosing its publishing or synchronization owner. */
async function copyImmutableStage(
  input: ImmutableContentHandoff,
  file: FileHandle,
  content: StorageContent
): Promise<void> {
  const source = content.reference;
  const byteLength = content.byteLength;
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
}

/** Publishes one bounded retained product body through the existing Storage stage owner. */
async function withStagedProductJson<T>(
  mount: ControlProductContentMount,
  owner: ControlProductOwner,
  stagingRoot: string,
  bytes: Buffer,
  consume: (input: ImmutableContentHandoff) => Promise<T>
): Promise<T> {
  if (mount.knowledgeBaseId !== null || mount.mount !== 'backend-evidence')
    throw new Error(
      'Canonical product publication requires the admitted native work-byte binding.'
    );
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (bytes.length > CONTROL_PRODUCT_LIMITS.payloadBytes)
    throw new Error('Control product body exceeds its byte limit.');
  const storage = new LocalStorage({
    mounts: [
      {
        knowledgeBaseId: mount.knowledgeBaseId,
        ownerScope: owner,
        name: mount.mount,
        root: mount.root,
      },
    ],
    stagingRoot,
  });
  const access: StorageAccess = {
    basis: 'work-capture',
    knowledgeBaseId: null,
    ownerScope: owner,
    mount: mount.mount,
    pathPrefix: '',
    mode: 'staged-write',
  };
  const admitted = <T>(result: { status: string; value?: T }): T => {
    if (result.status !== 'ok') throw new Error('Control product Storage publication failed.');
    return result.value as T;
  };
  try {
    const { handle } = admitted(
      await storage.beginStage({
        access,
        locator: { ownerScope: owner, mount: mount.mount, path: `sha256/${digest}` },
        maxByteLength: bytes.length,
      })
    );
    try {
      for (let offset = 0; offset < bytes.length; offset += STORAGE_LIMITS.chunkBytes) {
        admitted(
          await storage.writeStage({
            access,
            handle,
            data: bytes.subarray(offset, offset + STORAGE_LIMITS.chunkBytes).toString('base64'),
          })
        );
      }
      const stage = admitted(await storage.finishStage({ access, handle }));
      return await consume({ storage, access, stage, mountRoot: mount.root });
    } finally {
      admitted(await storage.discardStage({ access, handle }));
    }
  } finally {
    await storage.close();
  }
}

/** Publishes bytes for private bootstrap SQL under its existing phase exclusion. */
export async function publishImmutableProductJson(
  mount: ControlProductContentMount,
  owner: ControlProductOwner,
  stagingRoot: string,
  value: unknown
): Promise<StorageContent> {
  await ensureCanonicalDirectoryAsync(mount.root);
  await ensureCanonicalDirectoryAsync(stagingRoot);
  return withStagedProductJson(
    mount,
    owner,
    stagingRoot,
    Buffer.from(JSON.stringify(value)),
    publishImmutableContent
  );
}

/** Hands verified private bytes to the native publisher; neither a final name nor durability is published on Main. */
export async function prepareImmutableProductJson(
  mount: ControlProductContentMount,
  owner: ControlProductOwner,
  stagingRoot: string,
  value: unknown
): Promise<{ content: StorageContent; publication: { temporary: string } }> {
  return prepareProductFile(mount, owner, stagingRoot, Buffer.from(JSON.stringify(value)));
}

/** Selects the accepted retained work-body representation once, before native verification and FULL ACK. */
export async function prepareRetainedProductJson(
  mount: ControlProductContentMount,
  owner: ControlProductOwner,
  stagingRoot: string,
  value: unknown
): Promise<Pick<ControlProductEntry, 'content' | 'publication'>> {
  const body = JSON.stringify(value);
  const bytes = Buffer.from(body, 'utf8');
  if (bytes.length > CONTROL_PRODUCT_LIMITS.inlineBytes)
    return prepareProductFile(mount, owner, stagingRoot, bytes);
  if (mount.knowledgeBaseId !== null || mount.mount !== 'backend-evidence')
    throw new Error(
      'Canonical product publication requires the admitted native work-byte binding.'
    );
  return {
    content: {
      reference: {
        representation: 'inline',
        body,
        contentDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
        ownerScope: owner,
      },
      byteLength: bytes.length,
      mediaType: 'application/json',
    },
  };
}

/** Keeps the existing file publication for large bodies and explicit immutable-file owners. */
async function prepareProductFile(
  mount: ControlProductContentMount,
  owner: ControlProductOwner,
  stagingRoot: string,
  bytes: Buffer
): Promise<{ content: StorageContent; publication: { temporary: string } }> {
  for (const path of [dirname(mount.root), dirname(stagingRoot)])
    if ((await realpath(path)) !== resolve(path))
      throw new Error('Native private staging must not traverse a link.');
  await mkdir(mount.root).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error;
  });
  const metadata = await lstat(mount.root);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (await realpath(mount.root)) !== resolve(mount.root)
  )
    throw new Error('Native publication mount must not traverse a link.');
  return withStagedProductJson(mount, owner, stagingRoot, bytes, async (input) => {
    const content = immutableStageContent(input);
    const temporary = `.${content.reference.contentDigest.slice('sha256:'.length)}.${randomUUID()}.tmp`;
    const path = join(mount.root, temporary);
    const file = await open(path, 'wx', 0o600);
    try {
      await copyImmutableStage(input, file, content);
      await file.chmod(0o444);
    } catch (error) {
      await unlink(path);
      throw error;
    } finally {
      await file.close();
    }
    return { content, publication: { temporary } };
  });
}

/** Reads verified exact inline or immutable-file bytes under the owning scope, never a file-record fallback. */
export function readImmutableProductJson(
  mount: ControlProductContentMount,
  owner: ControlProductOwner,
  content: ControlProductEntry['content']
): unknown {
  content = ControlProductEntrySchema.shape.content.parse(content);
  const inline = inlineControlContentBytes(owner, content);
  if (inline) return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(inline));
  const reference = ContentReferenceSchema.parse(content.reference);
  if (
    reference.range !== null ||
    reference.availability !== 'available' ||
    reference.knowledgeBaseId !== mount.knowledgeBaseId ||
    reference.locator.mount !== mount.mount ||
    !isDeepStrictEqual(reference.locator.ownerScope, owner) ||
    !Number.isSafeInteger(content.byteLength) ||
    content.byteLength < 0 ||
    content.byteLength > CONTROL_PRODUCT_LIMITS.payloadBytes
  )
    throw new Error('Control product immutable binding is recovery_required.');
  const root = realpathSync(mount.root);
  if (root !== resolve(mount.root))
    throw new Error('Control product immutable mount is recovery_required.');
  const path = resolve(root, reference.locator.path);
  const rel = relative(root, path);
  if (
    !rel ||
    rel.startsWith('..') ||
    isAbsolute(rel) ||
    realpathSync(dirname(path)) !== dirname(path)
  )
    throw new Error('Control product immutable path is recovery_required.');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size !== content.byteLength)
      throw new Error('Control product immutable size is recovery_required.');
    const bytes = readFileSync(fd);
    if (`sha256:${createHash('sha256').update(bytes).digest('hex')}` !== reference.contentDigest)
      throw new Error('Control product immutable digest is recovery_required.');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } finally {
    closeSync(fd);
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
