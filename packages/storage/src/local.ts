import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, opendir, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { ContentReferenceSchema, KnowledgeBaseIdSchema } from '@openkit/protocol';
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
  grantId: string;
  expiresAt: number;
  knowledgeBaseId: string;
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
      if (!KnowledgeBaseIdSchema.safeParse(mount.knowledgeBaseId).success || !mount.name) {
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
      const path = await confined(mount.root, request.directory.path, true);
      const before = await lstat(path, { bigint: true });
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
      const after = await lstat(path, { bigint: true });
      if (`${after.dev}:${after.ino}:${after.mtimeNs}:${after.ctimeNs}` !== version) {
        refuse({ status: 'rescan-required' });
      }
      this.authorize(request.access, request.directory, 'read-only', true);
      return {
        entries,
        cursor: finished
          ? null
          : Buffer.from(JSON.stringify({ key, version, offset: offset + visited })).toString(
              'base64url'
            ),
      };
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
          grantId: request.access.grantId,
          expiresAt: Date.parse(request.access.expiresAt),
          knowledgeBaseId: request.access.knowledgeBaseId,
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
          const observed = await inspect(stage.file);
          if (observed.byteLength !== stage.byteLength)
            refuse({ status: 'unavailable', reason: 'changed' });
          stage.content = contentFor(stage.knowledgeBaseId, stage.locator, observed);
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
      !access.grantId ||
      access.revoked !== false ||
      !Number.isFinite(Date.parse(access.expiresAt)) ||
      Date.parse(access.expiresAt) <= Date.now() ||
      access.mode !== mode ||
      scopeKey(access.ownerScope) !== scopeKey(locator.ownerScope) ||
      access.mount !== locator.mount ||
      !safePath(access.pathPrefix, true)
    )
      refuse({ status: 'denied' });
    if (!safePath(locator.path, directory)) refuse({ status: 'invalid-request' });
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
    if (!mount) refuse({ status: 'denied' });
    return mount;
  }

  /** Bind opaque staging handles to their original grant, expiry and admitted destination. */
  private stageFor(access: StorageAccess, handle: string): Stage {
    const stage = this.stages.get(handle);
    if (
      !stage ||
      stage.grantId !== access.grantId ||
      stage.expiresAt <= Date.now() ||
      stage.knowledgeBaseId !== access.knowledgeBaseId
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

/** Reject links at each source component; byte operations never intentionally follow links. */
async function confined(root: string, path: string, directory = false): Promise<string> {
  if (!safePath(path, directory)) refuse({ status: 'invalid-request' });
  const target = resolve(root, path);
  if (!inside(root, target)) refuse({ status: 'invalid-request' });
  let current = root;
  for (const component of ['', ...path.split('/').filter(Boolean)]) {
    if (component) current = join(current, component);
    if ((await lstat(current)).isSymbolicLink())
      refuse({ status: 'unavailable', reason: 'unsupported' });
  }
  return target;
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
async function inspect(file: string, range?: { start: number; end: number }) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
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
  knowledgeBaseId: string,
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
  if (!parsed.success) refuse({ status: 'invalid-request' });
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
