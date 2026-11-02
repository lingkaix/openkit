import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import {
  chmod,
  type FileHandle,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  opendir,
  readdir,
  rename,
  rm,
  stat,
  unlink,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { type Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  ContentReferenceSchema,
  KnowledgeBaseIdSchema,
  KnowledgeOwnerScopeSchema,
  NativeContentReferenceSchema,
} from '@openkit/protocol';
import {
  type LocalStorageMount,
  STORAGE_LIMITS,
  type StorageAccess,
  type StorageChunk,
  type StorageContent,
  type StorageFailure,
  type StorageLocator,
  type StorageResult,
  type StorageScan,
  type StorageService,
} from './contract.js';

/** Transient output state, never a retained grant or publication record. */
interface Stage {
  directory: string;
  file: string;
  access: StorageAccess;
  locator: StorageLocator;
  maxByteLength: number;
  byteLength: number;
  busy: boolean;
  broken: boolean;
  content?: StorageContent;
}

/** Internal failure propagation without native paths or error messages in responses. */
class Refusal extends Error {
  constructor(readonly result: StorageFailure) {
    super(result.status);
  }
}

/** Local byte storage enforcing admitted access without owning Policy or publication. */
export class LocalStorage implements StorageService {
  private readonly mounts: LocalStorageMount[];
  private readonly stagingRoot: string;
  private readonly stages = new Map<string, Stage>();
  private pendingStages = 0;
  private closed = false;

  constructor(options: { mounts: LocalStorageMount[]; stagingRoot: string }) {
    this.mounts = structuredClone(options.mounts).map((mount) => {
      if (
        !KnowledgeOwnerScopeSchema.safeParse(mount.ownerScope).success ||
        (mount.knowledgeBaseId === null
          ? mount.ownerScope.kind === 'user' ||
            !NativeContentReferenceSchema.shape.locator.shape.mount.safeParse(mount.name).success
          : !KnowledgeBaseIdSchema.safeParse(mount.knowledgeBaseId).success) ||
        !mount.name
      ) {
        throw new Error('Invalid local Storage mount.');
      }
      return { ...mount, root: resolve(mount.root) };
    });
    this.stagingRoot = resolve(options.stagingRoot);
    const keys = this.mounts.map(mountKey);
    if (new Set(keys).size !== keys.length) throw new Error('Duplicate local Storage mount.');
    if (this.mounts.some((mount) => inside(mount.root, this.stagingRoot))) {
      throw new Error('Storage staging must be outside original mount roots.');
    }
  }

  /** Observe current original identity, without consulting an old index or filename hint. */
  stat: StorageService['stat'] = (request) =>
    this.run(async () => {
      const mount = this.authorize(request.access, request.locator, 'read-only');
      const observed = await inspect(await confined(mount.root, request.locator.path));
      await verifyBinding(mount.root, request.locator.path, observed.fileIdentity);
      this.authorize(request.access, request.locator, 'read-only');
      return contentFor(request.access.knowledgeBaseId, request.locator, observed);
    });

  /** Shallow bounded discovery; changed directory identity invalidates continuation. */
  scan: StorageService['scan'] = (request) =>
    this.run(async () => {
      const mount = this.authorize(request.access, request.directory, 'read-only', true);
      integer(request.limit, 1, STORAGE_LIMITS.scanEntries);
      if (request.nameIncludes !== undefined && request.nameIncludes.length > 255) {
        refuse({ status: 'invalid-request' });
      }
      const pinned = await confined(mount.root, request.directory.path, true);
      try {
        const path = await descriptorPath(pinned);
        const before = await pinned.stat({ bigint: true });
        if (!before.isDirectory()) refuse({ status: 'unavailable', reason: 'unsupported' });
        const version = `${before.dev}:${before.ino}:${before.mtimeNs}:${before.ctimeNs}`;
        const key = JSON.stringify([
          mountKey(mount),
          request.directory.path,
          request.access.pathPrefix,
          request.nameIncludes ?? null,
        ]);
        let offset = 0;
        if (request.cursor !== undefined) {
          try {
            if (request.cursor.length > 16_384) throw new Error('Invalid cursor.');
            const cursor = JSON.parse(Buffer.from(request.cursor, 'base64url').toString('utf8'));
            if (
              cursor.key !== key ||
              cursor.version !== version ||
              !Number.isSafeInteger(cursor.offset) ||
              cursor.offset < 0 ||
              cursor.offset > 65_536
            ) {
              throw new Error('Stale cursor.');
            }
            offset = cursor.offset;
          } catch {
            refuse({ status: 'rescan-required' });
          }
        }
        const directory = await opendir(path);
        const entries: StorageScan['entries'] = [];
        let visited = 0;
        let finished = false;
        try {
          // Stateless seeking is bounded separately; it does not retain a directory handle.
          for (let skipped = 0; skipped < offset; skipped++) {
            if (!(await directory.read())) refuse({ status: 'rescan-required' });
          }
          while (visited < request.limit) {
            const entry = await directory.read();
            if (!entry) {
              finished = true;
              break;
            }
            visited++;
            if (
              (!entry.isFile() && !entry.isDirectory()) ||
              (request.nameIncludes !== undefined && !entry.name.includes(request.nameIncludes))
            )
              continue;
            const metadata = await lstat(join(path, entry.name));
            if (!metadata.isFile() && !metadata.isDirectory()) continue;
            entries.push({
              path: [request.directory.path, entry.name].filter(Boolean).join('/'),
              kind: metadata.isDirectory() ? 'directory' : 'file',
              byteLength: metadata.isFile() ? metadata.size : 0,
            });
          }
        } finally {
          await directory.close();
        }
        const after = await pinned.stat({ bigint: true });
        if (`${after.dev}:${after.ino}:${after.mtimeNs}:${after.ctimeNs}` !== version) {
          refuse({ status: 'rescan-required' });
        }
        await verifyBinding(
          mount.root,
          request.directory.path,
          `${before.dev}:${before.ino}`,
          true
        );
        this.authorize(request.access, request.directory, 'read-only', true);
        return {
          entries,
          cursor: finished
            ? null
            : Buffer.from(JSON.stringify({ key, version, offset: offset + visited })).toString(
                'base64url'
              ),
        };
      } finally {
        await pinned.close();
      }
    });

  /** Verify whole captured identity before disclosing a bounded raw-byte range. */
  read: StorageService['read'] = async (request) => {
    const result = await this.run(async () => {
      const parsed = ContentReferenceSchema.safeParse(request.content.reference);
      if (!parsed.success) refuse({ status: 'invalid-request' });
      const reference = parsed.data;
      if (reference.knowledgeBaseId !== request.access.knowledgeBaseId)
        refuse({ status: 'denied' });
      const mount = this.authorize(request.access, reference.locator, 'read-only');
      integer(request.content.byteLength, 0, STORAGE_LIMITS.contentBytes);
      const range = reference.range;
      if (range && range.kind !== 'bytes') refuse({ status: 'unavailable', reason: 'unsupported' });
      const start = range?.start ?? 0;
      const end = range?.end ?? request.content.byteLength;
      if (end > request.content.byteLength) refuse({ status: 'invalid-request' });
      const bounds = chunkBounds(request.offset, request.length, start, end);
      const observed = await inspect(await confined(mount.root, reference.locator.path), bounds);
      if (
        observed.contentDigest !== reference.contentDigest ||
        observed.byteLength !== request.content.byteLength
      ) {
        refuse({ status: 'unavailable', reason: 'changed' });
      }
      await verifyBinding(mount.root, reference.locator.path, observed.fileIdentity);
      this.authorize(request.access, reference.locator, 'read-only');
      return chunk(observed.data, bounds.start, bounds.end, end);
    });
    return result.status === 'unavailable'
      ? {
          ...result,
          reference: { ...request.content.reference, availability: 'unavailable' as const },
        }
      : result;
  };

  /** Begin temporary output without creating or replacing its destination original. */
  beginStage: StorageService['beginStage'] = (request) =>
    this.run(async () => {
      this.authorize(request.access, request.locator, 'staged-write');
      integer(request.maxByteLength, 0, STORAGE_LIMITS.contentBytes);
      if (this.stages.size + this.pendingStages >= STORAGE_LIMITS.openStages) {
        refuse({ status: 'resource-limited' });
      }
      this.pendingStages++;
      let directory: string | undefined;
      try {
        await mkdir(this.stagingRoot, { recursive: true });
        const root = await lstat(this.stagingRoot);
        if (!root.isDirectory() || root.isSymbolicLink()) {
          refuse({ status: 'unavailable', reason: 'unsupported' });
        }
        directory = await mkdtemp(join(this.stagingRoot, 'stage-'));
        const file = join(directory, 'payload');
        const descriptor = await open(file, 'wx', 0o600);
        await descriptor.close();
        this.authorize(request.access, request.locator, 'staged-write');
        const handle = randomUUID();
        this.stages.set(handle, {
          directory,
          file,
          access: structuredClone(request.access),
          locator: structuredClone(request.locator),
          maxByteLength: request.maxByteLength,
          byteLength: 0,
          busy: false,
          broken: false,
        });
        return { handle };
      } catch (error) {
        if (directory) await rm(directory, { recursive: true, force: true });
        throw error;
      } finally {
        this.pendingStages--;
      }
    });

  /** Append one bounded chunk; overlapping calls refuse instead of reordering bytes. */
  writeStage: StorageService['writeStage'] = (request) =>
    this.run(async () => {
      const stage = this.stageFor(request.access, request.handle);
      if (stage.content || stage.broken || stage.busy) refuse({ status: 'failed' });
      const data = decodeChunk(request.data);
      if (stage.byteLength + data.length > stage.maxByteLength)
        refuse({ status: 'resource-limited' });
      stage.busy = true;
      try {
        const file = await open(
          stage.file,
          constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW
        );
        try {
          await file.writeFile(data);
        } finally {
          await file.close();
        }
        stage.byteLength += data.length;
        return { byteLength: stage.byteLength };
      } catch (error) {
        // A partial write cannot become a publishable staged result.
        stage.broken = true;
        throw error;
      } finally {
        stage.busy = false;
      }
    });

  /** Seal staged identity for later admission by the owning Source/Artifact publisher. */
  finishStage: StorageService['finishStage'] = (request) =>
    this.run(async () => {
      const stage = this.stageFor(request.access, request.handle);
      if (stage.broken || stage.busy) refuse({ status: 'failed' });
      if (!stage.content) {
        stage.busy = true;
        try {
          const observed = await inspect(
            await open(stage.file, constants.O_RDONLY | constants.O_NOFOLLOW)
          );
          if (observed.byteLength !== stage.byteLength)
            refuse({ status: 'unavailable', reason: 'changed' });
          stage.content = contentFor(stage.access.knowledgeBaseId, stage.locator, observed);
        } finally {
          stage.busy = false;
        }
      }
      this.stageFor(request.access, request.handle);
      return { handle: request.handle, content: structuredClone(stage.content) };
    });

  /** Consume sealed staged bytes without exposing a native resource or publication right. */
  readStage: StorageService['readStage'] = (request) =>
    this.run(async () => {
      const stage = this.stageFor(request.access, request.handle);
      if (!stage.content || stage.broken) refuse({ status: 'failed' });
      const bounds = chunkBounds(request.offset, request.length, 0, stage.content.byteLength);
      // Sealed bytes are private and further writes are refused. Hash once at seal,
      // then stream chunks; rehashing every chunk would make owner handoff quadratic.
      const data = await readSealed(stage.file, bounds, stage.content.byteLength);
      this.stageFor(request.access, request.handle);
      return chunk(data, bounds.start, bounds.end, stage.content.byteLength);
    });

  /** Remove only this admitted handle's temporary bytes, never its destination original. */
  discardStage: StorageService['discardStage'] = (request) =>
    this.run(async () => {
      const stage = this.stageFor(request.access, request.handle);
      if (stage.busy) refuse({ status: 'failed' });
      stage.busy = true;
      try {
        await rm(stage.directory, { recursive: true, force: true });
        this.stages.delete(request.handle);
        return null;
      } finally {
        stage.busy = false;
      }
    });

  /** Close after requests settle, removing all remaining transient stages. */
  async close(): Promise<void> {
    if (this.pendingStages || [...this.stages.values()].some((stage) => stage.busy)) {
      throw new Error('Storage staging operations are active.');
    }
    this.closed = true;
    for (const [handle, stage] of this.stages) {
      await rm(stage.directory, { recursive: true, force: true });
      this.stages.delete(handle);
    }
  }

  /** Enforce current admitted facts without creating or widening a Policy decision. */
  private authorize(
    access: StorageAccess,
    locator: StorageLocator,
    mode: StorageAccess['mode'],
    directory = false
  ): LocalStorageMount {
    if (this.closed) refuse({ status: 'failed' });
    if (
      !['lease', 'knowledge', 'work-capture'].includes(access.basis) ||
      (access.basis === 'work-capture'
        ? access.knowledgeBaseId !== null
        : !KnowledgeBaseIdSchema.safeParse(access.knowledgeBaseId).success) ||
      (access.basis === 'lease' &&
        (!access.grantId ||
          access.revoked !== false ||
          !Number.isFinite(Date.parse(access.expiresAt)) ||
          Date.parse(access.expiresAt) <= Date.now())) ||
      (access.basis === 'knowledge' && access.pathPrefix !== 'sources') ||
      (access.basis !== 'lease' &&
        ('grantId' in access || 'expiresAt' in access || 'revoked' in access)) ||
      access.mode !== mode ||
      scopeKey(access.ownerScope) !== scopeKey(locator.ownerScope) ||
      access.mount !== locator.mount ||
      !safePath(access.pathPrefix, true)
    )
      refuse({ status: 'denied' });
    if (!safePath(locator.path, directory)) refuse({ status: 'invalid-request' });
    if (
      access.basis === 'work-capture' &&
      !(directory
        ? (locator.path === '' || locator.path === 'sha256') &&
          NativeContentReferenceSchema.shape.locator.omit({ path: true }).safeParse(locator).success
        : NativeContentReferenceSchema.shape.locator.safeParse(locator).success)
    )
      refuse({ status: 'invalid-request' });
    if (
      access.pathPrefix &&
      locator.path !== access.pathPrefix &&
      !locator.path.startsWith(`${access.pathPrefix}/`)
    )
      refuse({ status: 'denied' });
    const mount = this.mounts.find(
      (candidate) =>
        candidate.knowledgeBaseId === access.knowledgeBaseId &&
        candidate.name === access.mount &&
        scopeKey(candidate.ownerScope) === scopeKey(access.ownerScope)
    );
    if (!mount || (access.basis === 'knowledge' && mount.managed !== true))
      refuse({ status: 'denied' });
    return mount;
  }

  /** Bind temporary handles to the same admitted basis, exact owner, mount and prefix. */
  private stageFor(access: StorageAccess, handle: string): Stage {
    const stage = this.stages.get(handle);
    if (
      !stage ||
      stage.access.basis !== access.basis ||
      (stage.access.basis === 'lease' &&
        (access.basis !== 'lease' ||
          stage.access.grantId !== access.grantId ||
          Date.parse(stage.access.expiresAt) <= Date.now())) ||
      stage.access.knowledgeBaseId !== access.knowledgeBaseId ||
      scopeKey(stage.access.ownerScope) !== scopeKey(access.ownerScope) ||
      stage.access.mount !== access.mount ||
      stage.access.pathPrefix !== access.pathPrefix
    )
      refuse({ status: 'denied' });
    this.authorize(access, stage.locator, 'staged-write');
    return stage;
  }

  /** Expected filesystem outcomes remain bounded and do not disclose backend locations. */
  private async run<T>(action: () => Promise<T>): Promise<StorageResult<T>> {
    try {
      return { status: 'ok', value: await action() };
    } catch (error) {
      if (error instanceof Refusal) return error.result;
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT' || code === 'ENOTDIR')
        return { status: 'unavailable', reason: 'missing' };
      if (code === 'EACCES' || code === 'EPERM')
        return { status: 'unavailable', reason: 'inaccessible' };
      if (code === 'ELOOP') return { status: 'unavailable', reason: 'unsupported' };
      if (['EFBIG', 'ENOSPC', 'EDQUOT', 'EMFILE'].includes(code ?? ''))
        return { status: 'resource-limited' };
      return { status: 'failed' };
    }
  }
}

/** Propagate one explicit public outcome. */
function refuse(result: StorageFailure): never {
  throw new Refusal(result);
}

/** Compare Protocol scope fields rather than identifier prefixes or inferred locations. */
function scopeKey(scope: StorageLocator['ownerScope']): string {
  switch (scope.kind) {
    case 'server':
      return 'server';
    case 'user':
      return `user/${scope.userId}`;
    case 'workspace':
      return `workspace/${scope.workspaceId}`;
  }
}

/** Mount names remain distinct across Knowledge Bases and owner scopes. */
function mountKey(mount: LocalStorageMount): string {
  return JSON.stringify([scopeKey(mount.ownerScope), mount.knowledgeBaseId, mount.name]);
}

/** Require canonical relative components instead of repairing caller paths. */
function safePath(path: string, allowEmpty: boolean): boolean {
  return (
    typeof path === 'string' &&
    (path === ''
      ? allowEmpty
      : path.length <= 4096 &&
        !path.includes('\\') &&
        !path.includes('\0') &&
        path.split('/').every((part) => part !== '' && part !== '.' && part !== '..'))
  );
}

/** A sibling native prefix does not count as a child of the admitted root. */
function inside(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith('../'));
}

/** Pin each parent before opening its child; a concurrent rename cannot redirect traversal. */
async function confined(root: string, path: string, directory = false): Promise<FileHandle> {
  if (!safePath(path, directory)) refuse({ status: 'invalid-request' });
  const target = resolve(root, path);
  if (!inside(root, target)) refuse({ status: 'invalid-request' });
  const volume = parse(root).root;
  const parts = [
    ...root.slice(volume.length).split(sep).filter(Boolean),
    ...path.split('/').filter(Boolean),
  ];
  let current = await open(
    volume,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
  );
  try {
    for (let index = 0; index < parts.length; index++) {
      const parent = await descriptorPath(current);
      const flags =
        constants.O_RDONLY |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK |
        (index < parts.length - 1 || directory ? constants.O_DIRECTORY : 0);
      const next = await open(join(parent, parts[index]!), flags);
      try {
        await current.close();
      } catch (error) {
        await next.close();
        throw error;
      }
      current = next;
    }
    return current;
  } catch (error) {
    await current.close();
    throw error;
  }
}

/** Use only a kernel path that resolves to the opened directory, never the mutable source name. */
async function descriptorPath(handle: FileHandle): Promise<string> {
  const expected = await handle.stat({ bigint: true });
  for (const root of ['/proc/self/fd', '/dev/fd']) {
    const path = join(root, String(handle.fd));
    try {
      const actual = await stat(path, { bigint: true });
      if (actual.isDirectory() && actual.dev === expected.dev && actual.ino === expected.ino)
        return path;
    } catch {
      /* Another supported descriptor namespace can still provide the primitive. */
    }
  }
  refuse({ status: 'unavailable', reason: 'unsupported' });
}

/** Refuse unsafe integers before allocation or byte access. */
function integer(value: number, minimum: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    refuse({ status: 'invalid-request' });
}

/** Bound a byte chunk inside its captured source coordinates. */
function chunkBounds(offset: number, length: number, start: number, end: number) {
  integer(offset, start, end);
  integer(length, 1, STORAGE_LIMITS.chunkBytes);
  return { start: offset, end: Math.min(end, offset + length) };
}

/** Encode only verified bytes, with absolute original offsets. */
function chunk(data: Buffer, start: number, end: number, totalEnd: number): StorageChunk {
  return { data: data.toString('base64'), offset: start, nextOffset: end < totalEnd ? end : null };
}

/** Bound decoding before allocation and reject ambiguous base64 forms. */
function decodeChunk(value: string): Buffer {
  if (typeof value !== 'string') refuse({ status: 'invalid-request' });
  if (value.length > Math.ceil(STORAGE_LIMITS.chunkBytes / 3) * 4)
    refuse({ status: 'resource-limited' });
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) refuse({ status: 'invalid-request' });
  if (bytes.length > STORAGE_LIMITS.chunkBytes) refuse({ status: 'resource-limited' });
  return bytes;
}

/** Hash an original with bounded memory, retaining only a requested bounded chunk. */
async function inspect(handle: FileHandle, range?: { start: number; end: number }) {
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) refuse({ status: 'unavailable', reason: 'unsupported' });
    if (before.size > BigInt(STORAGE_LIMITS.contentBytes)) refuse({ status: 'resource-limited' });
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(65_536);
    const data = Buffer.alloc(range ? range.end - range.start : 0);
    let header = Buffer.alloc(0);
    let position = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      if (position + bytesRead > STORAGE_LIMITS.contentBytes)
        refuse({ status: 'resource-limited' });
      const bytes = buffer.subarray(0, bytesRead);
      if (!position) header = Buffer.from(bytes.subarray(0, 4096));
      hash.update(bytes);
      if (range) {
        const start = Math.max(range.start, position);
        const end = Math.min(range.end, position + bytesRead);
        if (start < end) bytes.copy(data, start - range.start, start - position, end - position);
      }
      position += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      BigInt(position) !== after.size
    ) {
      refuse({ status: 'unavailable', reason: 'changed' });
    }
    return {
      fileIdentity: `${before.dev}:${before.ino}`,
      contentDigest: `sha256:${hash.digest('hex')}`,
      byteLength: position,
      mediaType: sniff(header),
      data,
    };
  } finally {
    await handle.close();
  }
}

/** Signatures classify bytes without claiming parser admission; unknown formats stay opaque. */
function sniff(header: Buffer): string {
  if (header.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (header.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))) return 'image/jpeg';
  if (header.subarray(0, 5).toString('ascii') === '%PDF-') return 'application/pdf';
  if (header.subarray(0, 4).equals(Buffer.from('504b0304', 'hex'))) return 'application/zip';
  return 'application/octet-stream';
}

/** Reuse the shared descriptor without creating a second retained authority. */
function contentFor(
  knowledgeBaseId: StorageAccess['knowledgeBaseId'],
  locator: StorageLocator,
  observed: { contentDigest: string; byteLength: number; mediaType: string }
): StorageContent {
  const parsed = ContentReferenceSchema.safeParse({
    knowledgeBaseId,
    contentDigest: observed.contentDigest,
    locator,
    range: null,
    availability: 'available',
  });
  // Authorized native locators are digest keys; different observed bytes are unavailable.
  if (!parsed.success)
    refuse(
      knowledgeBaseId === null
        ? { status: 'unavailable', reason: 'changed' }
        : { status: 'invalid-request' }
    );
  return { reference: parsed.data, byteLength: observed.byteLength, mediaType: observed.mediaType };
}

/** Read a bounded chunk from this service's private immutable sealed output. */
async function readSealed(file: string, range: { start: number; end: number }, byteLength: number) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size !== byteLength)
      refuse({ status: 'unavailable', reason: 'changed' });
    const data = Buffer.alloc(range.end - range.start);
    let count = 0;
    while (count < data.length) {
      const { bytesRead } = await handle.read(
        data,
        count,
        data.length - count,
        range.start + count
      );
      if (!bytesRead) refuse({ status: 'unavailable', reason: 'changed' });
      count += bytesRead;
    }
    return data;
  } finally {
    await handle.close();
  }
}

/** Refuse a changed logical binding before disclosure; byte reads already use pinned handles. */
async function verifyBinding(root: string, path: string, expected: string, directory = false) {
  const current = await confined(root, path, directory);
  try {
    const actual = await current.stat({ bigint: true });
    if (`${actual.dev}:${actual.ino}` !== expected)
      refuse({ status: 'unavailable', reason: 'changed' });
  } finally {
    await current.close();
  }
}

/** Copies and verifies independent bytes, synchronizing a destination before return. */
export async function copyVerifiedFile(
  input: Parameters<typeof copyIndependentFile>[0]
): Promise<{ bytes: number; sha256: string; mode: number }> {
  const result = await copyIndependentFile(input, true);
  if (!result.sha256) throw new Error('Verified copy has no digest.');
  return { ...result, sha256: result.sha256 };
}

/** Makes an independent private cut only; the caller must verify and sync before publishing a seal. */
export async function copyFileForCut(input: {
  readonly sourcePath: string;
  readonly destinationPath: string;
  readonly maxBytes: number;
  readonly mode?: number;
}): Promise<{ bytes: number; mode: number }> {
  const { bytes, mode } = await copyIndependentFile(input, false);
  return { bytes, mode };
}

/** Copies independently owned regular bytes, verifies their original digest and synchronizes before returning. */
async function copyIndependentFile(
  input: {
    readonly sourcePath: string;
    readonly destinationPath?: string;
    readonly expectedBytes?: number;
    readonly expectedSha256?: string;
    readonly mode?: number;
    readonly maxBytes?: number;
  },
  verify: boolean
): Promise<{ bytes: number; sha256: string | undefined; mode: number }> {
  const sourceRoot = dirname(resolve(input.sourcePath));
  const sourceName = basename(input.sourcePath);
  const source = await confined(sourceRoot, sourceName);
  let destinationParent: FileHandle | undefined;
  let destination: string | undefined;
  let output: FileHandle | undefined;
  let owned = false;
  try {
    const before = await source.stat({ bigint: true });
    const limit = input.maxBytes ?? Number.MAX_SAFE_INTEGER;
    if (
      !Number.isSafeInteger(limit) ||
      limit < 0 ||
      !before.isFile() ||
      before.nlink !== 1n ||
      before.size > BigInt(limit) ||
      (input.expectedBytes !== undefined && BigInt(input.expectedBytes) !== before.size)
    )
      throw new Error('Durable source is not an admitted regular file.');
    if (input.destinationPath) {
      destinationParent = await confined(dirname(resolve(input.destinationPath)), '', true);
      destination = join(await descriptorPath(destinationParent), basename(input.destinationPath));
      output = await open(destination, 'wx', 0o600);
      owned = true;
    }
    const hash = verify ? createHash('sha256') : undefined;
    let bytes = 0;
    for (;;) {
      const chunk = Buffer.alloc(65536);
      const { bytesRead } = await source.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      bytes += bytesRead;
      if (bytes > limit || BigInt(bytes) > before.size)
        throw new Error('Durable source exceeded its bound.');
      hash?.update(chunk.subarray(0, bytesRead));
      let offset = 0;
      while (output && offset < bytesRead) {
        const result = await output.write(chunk, offset, bytesRead - offset);
        if (!result.bytesWritten) throw new Error('Durable copy made no progress.');
        offset += result.bytesWritten;
      }
    }
    const after = await source.stat({ bigint: true });
    const sha256 = hash ? `sha256:${hash.digest('hex')}` : undefined;
    if (
      BigInt(bytes) !== before.size ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs ||
      after.nlink !== 1n ||
      (input.expectedSha256 !== undefined && input.expectedSha256 !== sha256)
    )
      throw new Error('Durable source changed or failed verification.');
    const mode = input.mode ?? Number(before.mode & 0o777n);
    await output?.chmod(mode);
    if (verify) await output?.sync();
    await verifyBinding(sourceRoot, sourceName, `${before.dev}:${before.ino}`);
    if (output && input.destinationPath) {
      const stored = await output.stat({ bigint: true });
      if (stored.nlink !== 1n || stored.size !== BigInt(bytes))
        throw new Error('Durable destination changed.');
      await verifyBinding(
        dirname(resolve(input.destinationPath)),
        basename(input.destinationPath),
        `${stored.dev}:${stored.ino}`
      );
    }
    return { bytes, sha256, mode };
  } catch (error) {
    if (owned && output && destination) {
      const stored = await output.stat({ bigint: true });
      const current = await lstat(destination, { bigint: true }).catch(() => null);
      if (current?.dev === stored.dev && current.ino === stored.ino) await unlink(destination);
    }
    throw error;
  } finally {
    await output?.close();
    await destinationParent?.close();
    await source.close();
  }
}

/** Publishes exact private metadata create-only, with durable bytes before the directory entry acknowledgement. */
export async function publishDurableFile(input: {
  readonly destinationPath: string;
  readonly bytes: Uint8Array | string;
  readonly mode?: number;
}): Promise<{ bytes: number; sha256: string; mode: number }> {
  const parent = dirname(resolve(input.destinationPath));
  const directory = await confined(parent, '', true);
  try {
    const before = await directory.stat({ bigint: true });
    const pinned = await descriptorPath(directory);
    const temporary = join(pinned, `.publish-${randomUUID()}`);
    const destination = join(pinned, basename(input.destinationPath));
    const file = await open(temporary, 'wx', 0o600);
    const bytes =
      typeof input.bytes === 'string' ? Buffer.from(input.bytes) : Buffer.from(input.bytes);
    const mode = input.mode ?? 0o600;
    try {
      await file.writeFile(bytes);
      await file.chmod(mode);
      await file.sync();
      await verifyBinding(parent, '', `${before.dev}:${before.ino}`, true);
      // Link only our private copy inside the pinned parent; never a live source or substituted directory.
      await link(temporary, destination);
    } finally {
      await file.close();
      await unlink(temporary);
    }
    await directory.sync();
    await verifyBinding(parent, '', `${before.dev}:${before.ino}`, true);
    return {
      bytes: bytes.length,
      sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      mode,
    };
  } finally {
    await directory.close();
  }
}

/** Retires one caller-owned regular-file entry and synchronizes its pinned parent before acknowledging absence. */
export async function removeDurableFile(input: {
  readonly destinationPath: string;
}): Promise<void> {
  const parent = dirname(resolve(input.destinationPath));
  const directory = await confined(parent, '', true);
  try {
    const before = await directory.stat({ bigint: true });
    const destination = join(await descriptorPath(directory), basename(input.destinationPath));
    const entry = await lstat(destination).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (entry && (!entry.isFile() || entry.isSymbolicLink()))
      throw new Error('Durable removal requires a regular file.');
    await verifyBinding(parent, '', `${before.dev}:${before.ino}`, true);
    if (entry) await unlink(destination);
    // An absent-entry retry still owes the directory sync lost by an earlier unlink.
    await directory.sync();
    await verifyBinding(parent, '', `${before.dev}:${before.ino}`, true);
  } finally {
    await directory.close();
  }
}

/** Existing caller-held metadata for one already-verified regular file. */
interface VerifiedFileProof {
  readonly expectedIdentity: string;
  readonly expectedBytes: number;
  readonly expectedMtimeMs: number;
  readonly expectedCtimeMs: number;
  readonly expectedMode: number;
}

/** Checks the complete admitted metadata without reading or hashing file content. */
async function assertVerifiedFile(file: FileHandle, expected: VerifiedFileProof): Promise<void> {
  const actual = await file.stat();
  if (
    !Number.isSafeInteger(expected.expectedBytes) ||
    expected.expectedBytes < 0 ||
    !actual.isFile() ||
    actual.nlink !== 1 ||
    `${actual.dev}:${actual.ino}` !== expected.expectedIdentity ||
    actual.size !== expected.expectedBytes ||
    actual.mtimeMs !== expected.expectedMtimeMs ||
    actual.ctimeMs !== expected.expectedCtimeMs ||
    (actual.mode & 0o777) !== expected.expectedMode
  )
    throw new Error('Admitted file identity changed.');
}

/** Synchronizes the exact caller-owned file after its existing producer has closed its writes. */
export async function syncVerifiedFile(
  input: VerifiedFileProof & { readonly path: string }
): Promise<void> {
  const parent = dirname(resolve(input.path));
  const name = basename(input.path);
  const file = await confined(parent, name);
  try {
    await assertVerifiedFile(file, input);
    await verifyBinding(parent, name, input.expectedIdentity);
    await file.sync();
    await verifyBinding(parent, name, input.expectedIdentity);
    await assertVerifiedFile(file, input);
  } finally {
    await file.close();
  }
}

/** Changes only the exact admitted file's mode; publication authority remains with its caller. */
export async function changeVerifiedFileMode(
  input: VerifiedFileProof & {
    readonly path: string;
    readonly mode: number;
  }
): Promise<void> {
  const parent = dirname(resolve(input.path));
  const name = basename(input.path);
  const file = await confined(parent, name);
  try {
    await assertVerifiedFile(file, input);
    await verifyBinding(parent, name, input.expectedIdentity);
    await file.chmod(input.mode);
    const changed = {
      ...input,
      expectedCtimeMs: (await file.stat()).ctimeMs,
      expectedMode: input.mode,
    };
    await assertVerifiedFile(file, changed);
    await verifyBinding(parent, name, input.expectedIdentity);
    await assertVerifiedFile(file, changed);
  } finally {
    await file.close();
  }
}

/** Replaces one exact same-directory file with its caller-verified candidate, then commits the entry. */
export async function publishVerifiedFileReplacement(
  input: Omit<VerifiedFileProof, 'expectedIdentity'> & {
    readonly sourcePath: string;
    readonly destinationPath: string;
    readonly sourceIdentity: string;
    readonly destinationIdentity: string;
    readonly mode: number;
  }
): Promise<void> {
  const parent = dirname(resolve(input.sourcePath));
  if (
    parent !== dirname(resolve(input.destinationPath)) ||
    basename(input.sourcePath) === basename(input.destinationPath)
  )
    throw new Error('File replacement requires distinct entries in the same directory.');
  const directory = await confined(parent, '', true);
  let source: FileHandle | undefined;
  let destination: FileHandle | undefined;
  try {
    const originalParent = await directory.stat({ bigint: true });
    const sourceName = basename(input.sourcePath);
    const destinationName = basename(input.destinationPath);
    source = await confined(parent, sourceName);
    destination = await confined(parent, destinationName);
    const expected = { ...input, expectedIdentity: input.sourceIdentity };
    await assertVerifiedFile(source, expected);
    const previous = await destination.stat({ bigint: true });
    if (!previous.isFile() || previous.nlink !== 1n)
      throw new Error('Replacement destination is not an admitted regular file.');
    await verifyBinding(parent, sourceName, input.sourceIdentity);
    await verifyBinding(parent, destinationName, input.destinationIdentity);
    await verifyBinding(parent, '', `${originalParent.dev}:${originalParent.ino}`, true);
    await assertVerifiedFile(source, expected);
    await source.chmod(input.mode);
    const changed = {
      ...expected,
      expectedCtimeMs: (await source.stat()).ctimeMs,
      expectedMode: input.mode,
    };
    await assertVerifiedFile(source, changed);
    await source.sync();
    await verifyBinding(parent, sourceName, input.sourceIdentity);
    await verifyBinding(parent, destinationName, input.destinationIdentity);
    await verifyBinding(parent, '', `${originalParent.dev}:${originalParent.ino}`, true);
    const pinned = await descriptorPath(directory);
    await assertVerifiedFile(source, changed);
    await rename(join(pinned, sourceName), join(pinned, destinationName));
    await directory.sync();
    await verifyBinding(parent, destinationName, input.sourceIdentity);
    await verifyBinding(parent, '', `${originalParent.dev}:${originalParent.ino}`, true);
  } finally {
    await destination?.close();
    await source?.close();
    await directory.close();
  }
}

/** Creates one exact directory exclusively; existing entries and missing parents remain errors. */
export function createDirectoryExclusive(path: string, mode: number): void {
  mkdirSync(path, { mode });
}

/** @internal Synchronizes a caller-owned directory without following its final link. */
export async function syncTreeDirectory(path: string): Promise<void> {
  const descriptor = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await descriptor.stat()).isDirectory())
      throw new Error(`Canonical path must be a directory: ${path}.`);
    await descriptor.sync();
  } finally {
    await descriptor.close();
  }
}

/** @internal Creates missing publication parents and commits their entries before use. */
export async function ensureTreeDirectory(path: string): Promise<void> {
  const metadata = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!metadata) {
    // Commit each parent before creating children so a failed retry has one entry to verify.
    await ensureTreeDirectory(dirname(path));
    try {
      await mkdir(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  const current = metadata ?? (await lstat(path));
  if (!current.isDirectory() || current.isSymbolicLink())
    throw new Error(`Canonical path must be a directory: ${path}.`);
  await syncTreeDirectory(dirname(path));
}

/** @internal Creates a unique private tree under an already-admitted parent. */
export async function createPrivateTree(parent: string, prefix: string): Promise<string> {
  return mkdtemp(join(parent, prefix));
}

/** @internal Creates private member directories; path admission remains with the caller. */
export async function makePrivateTreeDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
}

/** @internal Moves a complete caller-owned tree; its publication owner orders directory syncs. */
export async function movePrivateTree(source: string, destination: string): Promise<void> {
  await rename(source, destination);
}

/** @internal Removes only a caller-selected disposable tree, propagating cleanup failure. */
export async function removePrivateTree(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

/** @internal Streams private member bytes; the caller retains caps, integrity and capacity accounting. */
export async function writePrivateTreeFile(input: {
  readonly path: string;
  readonly source: Readable;
  readonly signal: AbortSignal;
  readonly onChunk: (bytes: Buffer) => void;
  readonly onWritten: (count: number) => void;
  readonly validate: () => void;
  readonly cancellationMessage: string;
}): Promise<void> {
  const abort = () => input.source.destroy(new Error(input.cancellationMessage));
  input.signal.addEventListener('abort', abort, { once: true });
  let sink: FileHandle | undefined;
  try {
    input.signal.throwIfAborted();
    sink = await open(
      input.path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    );
    input.signal.throwIfAborted();
    for await (const chunk of input.source) {
      const bytes = chunk as Buffer;
      input.onChunk(bytes);
      let offset = 0;
      while (offset < bytes.byteLength) {
        const written = await sink.write(bytes, offset);
        if (written.bytesWritten === 0) throw new Error('The ZIP write made no progress.');
        input.onWritten(written.bytesWritten);
        offset += written.bytesWritten;
      }
    }
    input.validate();
    // Disposable member bytes retain their existing close-only completion. The
    // owner's complete inventory verifier rejects crash-damaged cache members.
  } finally {
    input.signal.removeEventListener('abort', abort);
    input.source.destroy();
    await sink?.close();
  }
}

/** @internal Writes exact private metadata with accounting before fsync, preserving failure order. */
export async function writePrivateTreeMetadata(
  path: string,
  bytes: Uint8Array,
  onWritten: (count: number) => void
): Promise<void> {
  const inventory = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600
  );
  try {
    await inventory.writeFile(bytes);
    onWritten(bytes.byteLength);
    await inventory.sync();
  } finally {
    await inventory.close();
  }
}

/**
 * Verifies that one canonical path is a regular file rather than a link.
 *
 * @param path Canonical file path.
 * @throws Error when the path is a symbolic link or not a regular file.
 */
export function assertCanonicalRegularFile(path: string): void {
  const metadata = lstatSync(path);

  if (metadata.isSymbolicLink()) {
    throw new Error(`Canonical path must not be a symbolic link: ${path}.`);
  }
  if (!metadata.isFile()) {
    throw new Error(`Canonical path must be a regular file: ${path}.`);
  }
}

/**
 * Verifies that one canonical path is a real directory rather than a link.
 *
 * @param path Canonical directory path.
 * @throws Error when the path is a symbolic link or not a directory.
 */
export function assertCanonicalDirectory(path: string): void {
  const metadata = lstatSync(path);

  if (metadata.isSymbolicLink()) {
    throw new Error(`Canonical path must not be a symbolic link: ${path}.`);
  }
  if (!metadata.isDirectory()) {
    throw new Error(`Canonical path must be a directory: ${path}.`);
  }
}

/**
 * Creates a canonical directory and any missing parents without an existing redirect.
 *
 * @param path Canonical directory path beneath the caller's validated boundary.
 * @param mode Creation permissions, subject to the process umask.
 * @throws Error when the existing or created path is not a real directory.
 */
export function ensureCanonicalDirectory(path: string, mode = 0o700): void {
  const metadata = lstatSync(path, { throwIfNoEntry: false });

  if (metadata) {
    assertCanonicalDirectory(path);
    syncCanonicalDirectory(dirname(path));
    return;
  }

  // A visible parent can remain after its creation was not durably acknowledged.
  ensureCanonicalDirectory(dirname(path), mode);
  assertCanonicalDirectory(dirname(path));
  mkdirSync(path, { mode });
  assertCanonicalDirectory(path);
  syncCanonicalDirectory(dirname(path));
}

/** Synchronizes a verified directory entry before acknowledging publication. */
export function syncCanonicalDirectory(path: string): void {
  assertCanonicalDirectory(path);
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

/** Synchronizes complete staged bytes and child entries before their containing tree is published. */
export function syncCanonicalTree(path: string): void {
  const metadata = lstatSync(path);
  if (metadata.isDirectory()) {
    for (const entry of readdirSync(path)) syncCanonicalTree(join(path, entry));
    syncCanonicalDirectory(path);
    return;
  }
  assertCanonicalRegularFile(path);
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    if (!fstatSync(descriptor).isFile())
      throw new Error(`Canonical path must be a regular file: ${path}.`);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

/** A published canonical reference whose parent directory commit was not acknowledged. */
export class CanonicalPublicationError extends Error {
  public readonly code = 'recovery_required';
  public readonly status = 409;

  /** Preserves the publication stage and original I/O failure without adding retained state. */
  public constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'CanonicalPublicationError';
  }
}

/** Publishes a complete staged file or tree and commits both sides of a cross-parent rename. */
export function publishCanonicalPath(staged: string, destination: string): void {
  syncCanonicalTree(staged);
  renameSync(staged, destination);
  try {
    syncCanonicalDirectory(dirname(destination));
    if (dirname(staged) !== dirname(destination)) syncCanonicalDirectory(dirname(staged));
  } catch (error) {
    throw new CanonicalPublicationError(
      `Directory sync after rename failed during publication acknowledgement: ${error instanceof Error ? error.message : 'I/O failure'}`,
      error
    );
  }
}

/** Synchronizes a complete asynchronous staging tree, with child entries committed before their parents. */
export async function syncCanonicalTreeAsync(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (metadata.isDirectory()) {
    for (const entry of await readdir(path)) await syncCanonicalTreeAsync(join(path, entry));
    await syncTreeDirectory(path);
    return;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink())
    throw new Error(`Canonical path must be a regular file: ${path}.`);
  const descriptor = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    if (!(await descriptor.stat()).isFile())
      throw new Error(`Canonical path must be a regular file: ${path}.`);
    await descriptor.sync();
  } finally {
    await descriptor.close();
  }
}

/** Publishes staged asynchronous bytes and commits the destination and any distinct source parent. */
export async function publishCanonicalPathAsync(
  staged: string,
  destination: string
): Promise<void> {
  await syncCanonicalTreeAsync(staged);
  await rename(staged, destination);
  await syncTreeDirectory(dirname(destination));
  if (dirname(staged) !== dirname(destination)) await syncTreeDirectory(dirname(staged));
}

/**
 * Reads one canonical UTF-8 file without following a symbolic link.
 *
 * @param path Canonical file path.
 * @returns Complete UTF-8 file content.
 * @throws Error when the path is a symbolic link or not a regular file.
 */
export function readCanonicalTextFile(path: string): string {
  return readCanonicalFile(path).toString('utf8');
}

/**
 * Reads one canonical file buffer through a no-follow regular-file descriptor.
 *
 * @param path Canonical file path.
 * @returns Complete file bytes.
 * @throws Error when the path is a symbolic link or not a regular file.
 */
export function readCanonicalFile(path: string): Buffer {
  assertCanonicalRegularFile(path);
  let descriptor: number;

  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    throwCanonicalLinkError(path, error);
  }

  try {
    if (!fstatSync(descriptor).isFile()) {
      throw new Error(`Canonical path must be a regular file: ${path}.`);
    }
    return readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

/** Measures one regular file's exact size and digest without materializing its body. */
export function measureCanonicalFile(path: string): { byteLength: number; contentDigest: string } {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return measureCanonicalFileDescriptor(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

/** Measures an open no-follow regular file while preserving its offset for a later stream. */
export function measureCanonicalFileDescriptor(descriptor: number): {
  byteLength: number;
  contentDigest: string;
} {
  const before = fstatSync(descriptor, { bigint: true });
  if (!before.isFile() || before.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('The canonical file cannot be measured.');
  }
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(65_536);
  let byteLength = 0;
  while (byteLength < Number(before.size)) {
    const count = readSync(
      descriptor,
      buffer,
      0,
      Math.min(buffer.byteLength, Number(before.size) - byteLength),
      byteLength
    );
    if (count === 0) break;
    byteLength += count;
    hash.update(buffer.subarray(0, count));
  }
  const after = fstatSync(descriptor, { bigint: true });
  if (
    BigInt(byteLength) !== before.size ||
    before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs ||
    before.ctimeNs !== after.ctimeNs
  ) {
    throw new Error('The canonical file changed during integrity verification.');
  }
  return { byteLength, contentDigest: `sha256:${hash.digest('hex')}` };
}

/**
 * Preserves a useful canonical-path error when a no-follow open rejects a link race.
 *
 * @param path Canonical file path.
 * @param error Native open error.
 * @throws The native error, or a canonical symbolic-link error for ELOOP.
 */
export function throwCanonicalLinkError(path: string, error: unknown): never {
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ELOOP') {
    throw new Error(`Canonical path must not be a symbolic link: ${path}.`, { cause: error });
  }
  throw error;
}

/** Writes one immutable snapshot directory. */
export function materializeSnapshot(
  target: string,
  entries: readonly {
    readonly content?: Buffer;
    readonly kind: 0 | 1 | 2;
    readonly path: string;
  }[]
): void {
  if (existsSync(target)) {
    // A visible snapshot can be the result of a failed post-rename acknowledgement.
    syncCanonicalTree(target);
    syncCanonicalDirectory(dirname(target));
    return;
  }
  const staged = `${target}.staging`;
  // Validate the parent before cleanup can touch any path beneath it.
  ensureCanonicalDirectory(dirname(target), 0o777);
  rmSync(staged, { force: true, recursive: true });
  mkdirSync(staged, { recursive: true });
  try {
    for (const entry of entries) {
      const path = join(staged, entry.path);
      if (entry.kind === 0) {
        mkdirSync(path, { recursive: true });
        continue;
      }
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, entry.content ?? Buffer.alloc(0), { flag: 'wx' });
      if (entry.kind === 2) {
        chmodSync(path, 0o755);
      }
    }
    publishCanonicalPath(staged, target);
  } catch (error) {
    rmSync(staged, { force: true, recursive: true });
    throw error;
  }
}

/** Returns true when any regular file exists under root, ignoring incomplete `.staging` directories. */
export function directoryContainsFiles(root: string): boolean {
  if (!existsSync(root)) {
    return false;
  }
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      const metadata = statSync(path);
      if (metadata.isDirectory()) {
        if (!name.endsWith('.staging')) {
          pending.push(path);
        }
        continue;
      }
      if (metadata.isFile()) {
        return true;
      }
    }
  }
  return false;
}

/** @internal Creates a unique private tree for an existing synchronous publication owner. */
export function createPrivateTreeSync(parent: string, prefix: string): string {
  return mkdtempSync(join(parent, prefix));
}

/** @internal Removes only the synchronous caller's selected private or unacknowledged tree. */
export function removePrivateTreeSync(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

/** @internal Stages exact admitted bytes with the original domain counters and refusals; the caller retains product and capacity authority. */
export async function stagePrivateFile(
  stagingParent: string,
  input: {
    readonly source: Readable;
    readonly expectedByteLength: number;
    readonly expectedDigest: string;
    readonly reservation: {
      assertAvailable(): void;
      recordWritten(byteLength: number): void;
    };
    readonly submission?: { consume(byteLength: number): void };
    readonly signal?: AbortSignal;
    readonly inspectChunk?: (chunk: Buffer) => void;
  },
  FileByteAdmission: new () => {
    readonly byteLength: number;
    consume(byteLength: number): void;
  },
  ArtifactPayloadIntegrityError: new (code: 'invalid_request' | 'source_digest_mismatch') => Error,
  ArtifactPayloadCleanupError: new (causes: readonly unknown[]) => Error
): Promise<{
  readonly path: string;
  readonly byteLength: number;
  readonly contentDigest: string;
  remove(): Promise<void>;
}> {
  await ensureTreeDirectory(stagingParent);
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
    await syncTreeDirectory(requestRoot);
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

/** @internal Owns verified private media bytes through consumption and proved cleanup; the caller retains admission and processing. */
export async function withStagedMediaSource<T>(
  source: {
    originalDigest: string;
    byteLength: number;
    open(signal: AbortSignal): AsyncIterable<Uint8Array>;
  },
  temporaryRoot: string,
  reserveTemporaryBytes: (bytes: number) => { recordWritten(bytes: bigint): void; release(): void },
  signal: AbortSignal,
  prefix: string,
  consume: (path: string) => Promise<T>,
  MediaProcessFailure: new (
    reason: 'source-unavailable' | 'source-changed' | 'resource-limited' | 'cleanup-unavailable'
  ) => Error
): Promise<T> {
  let reservation: ReturnType<typeof reserveTemporaryBytes>;
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
    await stageSource(
      source,
      path,
      signal,
      (bytes) => reservation.recordWritten(bytes),
      MediaProcessFailure
    );
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
  source: Parameters<typeof withStagedMediaSource>[0],
  path: string,
  signal: AbortSignal,
  recordWritten: (bytes: bigint) => void,
  MediaProcessFailure: Parameters<typeof withStagedMediaSource>[6]
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
