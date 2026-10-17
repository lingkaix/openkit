import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { lstat, mkdtemp, open, readdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import {
  ensureCanonicalDirectoryAsync,
  syncCanonicalDirectoryAsync,
} from '../workspace-file-records.js';
import type { FileStorageAdmission } from './file-admission.js';
import { ArtifactPayloadCleanupError } from './file-payload.js';
import { artifactFilePayloadPath, verifyArtifactFilePayload } from './file-records.js';
import {
  MAX_ZIP_EXPANDED_BYTES,
  stageZipSnapshot,
  ZipExtractionBudget,
  type ZipSnapshotFile,
} from './zip-snapshot.js';

/** Versioned output-changing processor identity; nested archives remain ordinary files. */
export const ZIP_FOLDER_PROCESSOR = 'openkit.zip.v1';
const MAX_MANIFEST_BYTES = 32 * 1024 * 1024;
const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const manifestSchema = z
  .object({
    processor: z.literal(ZIP_FOLDER_PROCESSOR),
    artifactId: z.string(),
    artifactVersion: z.number().int().positive(),
    contentDigest: digestSchema,
    files: z
      .array(
        z
          .object({
            relativePath: z.string().max(4096),
            byteLength: z.number().int().nonnegative(),
            contentDigest: digestSchema,
          })
          .strict()
      )
      .max(100_000),
    directories: z.array(z.string().max(4096)).max(131_072),
  })
  .strict();
const inflight = new Map<string, Promise<ArtifactFolderSnapshot>>();

/** The existing immutable Artifact version is the only durable source authority. */
export interface ArtifactFolderSource {
  readonly workspaceRoot: string;
  readonly artifactId: string;
  readonly artifactVersion: number;
  readonly byteLength: number;
  readonly contentDigest: string;
}

/** Verified disposable tree for existing Worker slot materialization, never an editable mount. */
export interface ArtifactFolderSnapshot {
  readonly root: string;
  readonly files: readonly ZipSnapshotFile[];
  readonly directories: readonly string[];
  readonly expandedBytes: number;
  readonly representationDigest: string;
}

/** Reuses a complete exact-source cache, or explicitly extracts and atomically publishes one. No original, Artifact record, Review, Item or command receipt changes. */
export async function ensureArtifactFolderSnapshot(input: {
  readonly source: ArtifactFolderSource;
  readonly admission: FileStorageAdmission;
  readonly assertAuthorized: () => void;
  readonly signal?: AbortSignal;
}): Promise<ArtifactFolderSnapshot> {
  const ready = await readArtifactFolderSnapshot(input);
  if (ready) return ready;
  input.assertAuthorized();
  const cacheRoot = folderCacheRoot(input.source);
  let pending = inflight.get(cacheRoot);
  if (!pending) {
    pending = buildSnapshot(input);
    inflight.set(cacheRoot, pending);
    void pending
      .finally(() => {
        if (inflight.get(cacheRoot) === pending) inflight.delete(cacheRoot);
      })
      .catch(() => {});
  }
  const result = await pending;
  input.signal?.throwIfAborted();
  input.assertAuthorized();
  return result;
}

/** Returns null for missing, stale or corrupt derived bytes. Missing or changed original authority fails closed; no cache can substitute for it. The caller rechecks current source audience on every use. */
export async function readArtifactFolderSnapshot(input: {
  readonly source: ArtifactFolderSource;
  readonly assertAuthorized: () => void;
  readonly signal?: AbortSignal;
}): Promise<ArtifactFolderSnapshot | null> {
  input.signal?.throwIfAborted();
  input.assertAuthorized();
  verifyArtifactFilePayload({ ...input.source, version: input.source.artifactVersion });
  const cacheRoot = folderCacheRoot(input.source);
  const signal = input.signal
    ? AbortSignal.any([input.signal, AbortSignal.timeout(30_000)])
    : AbortSignal.timeout(30_000);
  try {
    await assertDirectory(dirname(cacheRoot));
    await assertDirectory(cacheRoot);
    const manifestPath = join(cacheRoot, 'inventory.json');
    const file = await open(
      manifestPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    let bytes: Buffer;
    try {
      const metadata = await file.stat();
      if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size > MAX_MANIFEST_BYTES)
        return null;
      bytes = Buffer.alloc(metadata.size + 1);
      let offset = 0;
      while (offset < bytes.length) {
        signal.throwIfAborted();
        const { bytesRead } = await file.read(bytes, offset, bytes.length - offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      if (offset !== metadata.size) return null;
      bytes = bytes.subarray(0, offset);
    } finally {
      await file.close();
    }
    const manifest = manifestSchema.parse(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    );
    if (
      manifest.artifactId !== input.source.artifactId ||
      manifest.artifactVersion !== input.source.artifactVersion ||
      manifest.contentDigest !== input.source.contentDigest
    )
      return null;
    const root = join(cacheRoot, 'tree');
    await assertDirectory(root);
    const expected = new Map<string, 'file' | 'directory'>();
    for (const directory of manifest.directories) {
      assertRelativePath(directory);
      if (expected.has(directory)) return null;
      expected.set(directory, 'directory');
    }
    let expandedBytes = 0;
    for (const entry of manifest.files) {
      signal.throwIfAborted();
      assertRelativePath(entry.relativePath);
      if (expected.has(entry.relativePath)) return null;
      expected.set(entry.relativePath, 'file');
      expandedBytes += entry.byteLength;
      if (expandedBytes > MAX_ZIP_EXPANDED_BYTES) return null;
    }
    await verifyTree(root, '', expected, signal);
    if (expected.size) return null;
    for (const entry of manifest.files) {
      signal.throwIfAborted();
      const handle = await open(
        join(root, entry.relativePath),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
      );
      try {
        const metadata = await handle.stat();
        if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size !== entry.byteLength)
          return null;
        const hash = createHash('sha256');
        let actual = 0;
        const stream = createReadStream('', {
          fd: handle.fd,
          autoClose: false,
          highWaterMark: 65_536,
          signal,
        });
        for await (const chunk of stream) {
          actual += (chunk as Buffer).length;
          if (actual > entry.byteLength) return null;
          hash.update(chunk as Buffer);
        }
        if (actual !== entry.byteLength || `sha256:${hash.digest('hex')}` !== entry.contentDigest)
          return null;
      } finally {
        await handle.close();
      }
    }
    signal.throwIfAborted();
    input.assertAuthorized();
    return {
      root,
      files: manifest.files,
      directories: manifest.directories,
      expandedBytes,
      representationDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    };
  } catch {
    signal.throwIfAborted();
    // A corrupt derivative is rebuildable; current source access remains mandatory.
    input.assertAuthorized();
    return null;
  }
}

/** Reserves the complete extraction forecast before reading a parser entry. */
async function buildSnapshot(
  input: Parameters<typeof ensureArtifactFolderSnapshot>[0]
): Promise<ArtifactFolderSnapshot> {
  const reservation = input.admission.reserve({
    stagingBytes: 0n,
    extractionBytes: BigInt(MAX_ZIP_EXPANDED_BYTES),
    derivativeBytes: BigInt(MAX_MANIFEST_BYTES) + 1_073_741_824n,
    publicationBytes: 0n,
  });
  const budget = new ZipExtractionBudget(input.signal);
  let staged: Awaited<ReturnType<typeof stageZipSnapshot>> | undefined;
  let stageRoot: string | undefined;
  let envelope: string | undefined;
  let cleanupUnproved = false;
  let result: ArtifactFolderSnapshot | undefined;
  const failures: unknown[] = [];
  try {
    staged = await stageZipSnapshot({
      workspaceRoot: input.source.workspaceRoot,
      archivePath: artifactFilePayloadPath(
        input.source.workspaceRoot,
        input.source.artifactId,
        input.source.artifactVersion
      ),
      budget,
      reservation,
      expectedArchive: {
        byteLength: input.source.byteLength,
        contentDigest: input.source.contentDigest,
      },
    });
    stageRoot = staged.root;
    const files = [...staged.files].sort((left, right) =>
      left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0
    );
    const directories = [...staged.directories].sort();
    const manifest = Buffer.from(
      JSON.stringify({
        processor: ZIP_FOLDER_PROCESSOR,
        artifactId: input.source.artifactId,
        artifactVersion: input.source.artifactVersion,
        contentDigest: input.source.contentDigest,
        files,
        directories,
      })
    );
    if (manifest.length > MAX_MANIFEST_BYTES)
      throw new Error('The ZIP inventory resource limit was exceeded.');
    // Move the completed private tree under a private envelope before one directory publication.
    envelope = await mkdtemp(join(dirname(staged.root), 'zip-complete-'));
    await rename(staged.root, join(envelope, 'tree'));
    stageRoot = envelope;
    const inventory = await open(
      join(envelope, 'inventory.json'),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    );
    try {
      await inventory.writeFile(manifest);
      reservation.recordWritten(manifest.length);
      await inventory.sync();
    } finally {
      await inventory.close();
    }
    for (const directory of [...directories].sort((left, right) => right.length - left.length)) {
      budget.signal.throwIfAborted();
      await syncCanonicalDirectoryAsync(join(envelope, 'tree', directory));
    }
    await syncCanonicalDirectoryAsync(join(envelope, 'tree'));
    await syncCanonicalDirectoryAsync(envelope);
    budget.signal.throwIfAborted();
    input.assertAuthorized();
    verifyArtifactFilePayload({ ...input.source, version: input.source.artifactVersion });
    budget.signal.throwIfAborted();
    reservation.assertAvailable();
    const destination = folderCacheRoot(input.source);
    await ensureCanonicalDirectoryAsync(dirname(destination));
    await rm(destination, { recursive: true, force: true });
    budget.signal.throwIfAborted();
    input.assertAuthorized();
    await rename(envelope, destination);
    stageRoot = undefined;
    envelope = undefined;
    await syncCanonicalDirectoryAsync(dirname(destination));
    result = {
      root: join(destination, 'tree'),
      files,
      directories,
      expandedBytes: files.reduce((sum, entry) => sum + entry.byteLength, 0),
      representationDigest: `sha256:${createHash('sha256').update(manifest).digest('hex')}`,
    };
  } catch (error) {
    cleanupUnproved = error instanceof ArtifactPayloadCleanupError;
    failures.push(error);
  }
  try {
    if (stageRoot) await rm(stageRoot, { recursive: true, force: true });
    if (envelope && envelope !== stageRoot) await rm(envelope, { recursive: true, force: true });
  } catch (error) {
    cleanupUnproved = true;
    failures.push(error);
  }
  if (!cleanupUnproved) reservation.release();
  if (cleanupUnproved) throw new ArtifactPayloadCleanupError(failures);
  if (failures.length) throw failures[0];
  if (!result) throw new Error('The folder snapshot is unavailable.');
  return result;
}

/** Source-derived path; no caller path or separate folder identity is admitted. */
function folderCacheRoot(source: ArtifactFolderSource): string {
  return join(
    dirname(
      artifactFilePayloadPath(source.workspaceRoot, source.artifactId, source.artifactVersion)
    ),
    'derived',
    'zip-v1'
  );
}

/** Refuses cache redirection through links or non-directory nodes. */
async function assertDirectory(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink())
    throw new Error('The folder cache is unavailable.');
}

/** Applies the processor's containment syntax again before trusting a retained inventory. */
function assertRelativePath(path: string): void {
  if (
    !path ||
    path !== path.normalize('NFC') ||
    path.startsWith('/') ||
    /^[A-Za-z]:/.test(path) ||
    /[\\\0]/.test(path) ||
    path.split('/').length > 64 ||
    path.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new Error('The folder inventory is invalid.');
}

/** Verifies the entire disposable tree, including unexpected files and links, before returning its root. */
async function verifyTree(
  root: string,
  prefix: string,
  expected: Map<string, 'file' | 'directory'>,
  signal: AbortSignal
): Promise<void> {
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    signal.throwIfAborted();
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const kind = expected.get(relative);
    if (
      !kind ||
      entry.isSymbolicLink() ||
      (kind === 'file' ? !entry.isFile() : !entry.isDirectory())
    )
      throw new Error('The folder cache is inconsistent.');
    expected.delete(relative);
    if (kind === 'directory') await verifyTree(root, relative, expected, signal);
  }
}
