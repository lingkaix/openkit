import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  LocalStorage,
  STORAGE_LIMITS,
  type StorageAccess,
  type StorageContent,
} from '@openkit/storage';
import { ensureCanonicalDirectoryAsync } from './canonical-filesystem.js';
import {
  CONTROL_PRODUCT_LIMITS,
  type ControlProductContentMount,
  type ControlProductEntry,
  ControlProductEntrySchema,
  type ControlProductOwner,
  inlineControlContentBytes,
} from './control-store-products.js';
import {
  copyImmutableStage,
  type ImmutableContentHandoff,
  immutableStageContent,
  publishImmutableContent,
} from './immutable-content-publish.js';
import { readImmutableContentBytes } from './immutable-content-read.js';

export {
  type ImmutableContentHandoff,
  publishImmutableContent,
} from './immutable-content-publish.js';

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
  const bytes = readImmutableContentBytes(
    mount,
    owner,
    content,
    CONTROL_PRODUCT_LIMITS.payloadBytes
  );
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}
