import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync } from 'node:fs';
import { mkdir, mkdtemp, open, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { crc32 } from 'node:zlib';
import { fromFdPromise, type ZipFile } from 'yauzl';
import { ensureCanonicalDirectoryAsync } from '../workspace-file-records.js';
import type { FileStorageReservation } from './file-admission.js';
import { ArtifactPayloadCleanupError } from './file-payload.js';

/** Current accepted cumulative limits, including explicitly requested nested extraction. */
export const MAX_ZIP_EXPANDED_BYTES = 4_000_000_000;
export const MAX_ZIP_ENTRIES = 100_000;

/** Actual expansion accounting shared by all explicitly selected archive depths. */
export class ZipExtractionBudget {
  private bytes = 0;
  private entries = 0;
  private metadataBytes = 0;
  /** A single wall-time budget includes every explicitly admitted nested extraction. */
  readonly signal: AbortSignal;

  /** Begins one resource budget; nested extraction must receive this same object. */
  constructor(signal?: AbortSignal) {
    this.signal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
      : AbortSignal.timeout(30_000);
  }

  /** Counts actual entries and bounds retained inventory independently of file bodies. */
  admitEntry(name: string): void {
    this.signal.throwIfAborted();
    this.entries += 1;
    this.admitPath(name);
    if (this.entries > MAX_ZIP_ENTRIES) {
      throw new Error('The ZIP entry or inventory resource limit was exceeded.');
    }
  }

  /** Includes retained implicit parent paths in the independent inventory bound. */
  admitPath(name: string): void {
    this.metadataBytes += Buffer.byteLength(name, 'utf8') + 256;
    if (this.metadataBytes > 32 * 1024 * 1024) {
      throw new Error('The ZIP inventory resource limit was exceeded.');
    }
  }

  /** Refuses actual expanded chunks before a write can exceed the shared limit. */
  consume(byteLength: number): void {
    this.signal.throwIfAborted();
    if (
      !Number.isSafeInteger(byteLength) ||
      byteLength < 0 ||
      byteLength > MAX_ZIP_EXPANDED_BYTES - this.bytes
    ) {
      throw new Error('The ZIP expansion byte limit was exceeded.');
    }
    this.bytes += byteLength;
  }
}

/** One exact extracted regular file, without an independent product identity. */
export interface ZipSnapshotFile {
  readonly relativePath: string;
  readonly byteLength: number;
  readonly contentDigest: string;
}

/** Complete private extraction; no file or directory is visible as a product until publication. */
export interface StagedZipSnapshot {
  readonly root: string;
  readonly files: readonly ZipSnapshotFile[];
  remove(): Promise<void>;
}

/** Extracts one explicitly selected ZIP using lazy entries, exact counts and private staging. Original archives are read only. Nested archives remain ordinary files; an explicit further extraction must reuse the same budget and capacity reservation. */
export async function stageZipSnapshot(input: {
  readonly workspaceRoot: string;
  readonly archivePath: string;
  readonly budget: ZipExtractionBudget;
  readonly reservation: FileStorageReservation;
}): Promise<StagedZipSnapshot> {
  input.budget.signal.throwIfAborted();
  input.reservation.assertAvailable();
  const stagingParent = join(dirname(input.workspaceRoot), '.staging');
  await ensureCanonicalDirectoryAsync(stagingParent);
  const root = await mkdtemp(join(stagingParent, 'zip-'));
  const files: ZipSnapshotFile[] = [];
  const paths = new Map<string, { kind: 'file' | 'directory'; explicit: boolean }>();
  let archive: ZipFile | undefined;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      input.archivePath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    const archiveMetadata = fstatSync(descriptor);
    if (!archiveMetadata.isFile() || archiveMetadata.nlink !== 1)
      throw new Error('The ZIP source is not one regular file.');
    archive = await fromFdPromise(descriptor, {
      autoClose: true,
      lazyEntries: true,
      strictFileNames: true,
      validateEntrySizes: true,
    });
    descriptor = undefined; // The ZIP owner closes its descriptor from this point.
    // Cancellation can leave a pending central-directory read after iterator cleanup.
    archive.on('error', () => {});
    const entries = archive.eachEntry();
    try {
      for (;;) {
        const next = await untilAborted(entries.next(), input.budget.signal);
        if (next.done) break;
        const entry = next.value;
        if (entry.generalPurposeBitFlag & 0x800)
          new TextDecoder('utf-8', { fatal: true }).decode(entry.fileNameRaw);
        for (const extra of entry.extraFields) {
          if (extra.id === 0x7075) {
            if (extra.data.length < 5) throw new Error('The ZIP Unicode path field is malformed.');
            new TextDecoder('utf-8', { fatal: true }).decode(extra.data.subarray(5));
          }
        }
        const directory = entry.fileName.endsWith('/');
        const name = safeZipPath(entry.fileName, directory);
        input.budget.admitEntry(name);
        const type = (entry.externalFileAttributes >>> 16) & 0xf000;
        if (
          entry.isEncrypted() ||
          !entry.canDecodeFileData() ||
          (type !== 0 && type !== (directory ? 0x4000 : 0x8000)) ||
          (directory && entry.uncompressedSize !== 0)
        ) {
          throw new Error('The ZIP entry type is unsupported.');
        }
        claimZipPath(paths, name, directory, input.budget);
        const destination = join(root, ...name.split('/'));
        if (directory) {
          await mkdir(destination, { recursive: true, mode: 0o700 });
          continue;
        }
        await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
        // Own errors immediately, including cancellation while the destination open is pending.
        const sourcePromise = archive.openReadStreamPromise(entry).then((stream) => {
          stream.on('error', () => {});
          if (input.budget.signal.aborted) stream.destroy();
          return stream;
        });
        const source = await untilAborted(sourcePromise, input.budget.signal);
        const abort = () => source.destroy(new Error('The ZIP extraction was cancelled.'));
        input.budget.signal.addEventListener('abort', abort, { once: true });
        let sink: Awaited<ReturnType<typeof open>> | undefined;
        let byteLength = 0;
        let checksum = 0;
        const hash = createHash('sha256');
        try {
          input.budget.signal.throwIfAborted();
          sink = await open(
            destination,
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
            0o600
          );
          input.budget.signal.throwIfAborted();
          for await (const chunk of source) {
            const bytes = chunk as Buffer;
            input.budget.consume(bytes.byteLength);
            byteLength += bytes.byteLength;
            checksum = crc32(bytes, checksum);
            hash.update(bytes);
            let offset = 0;
            while (offset < bytes.byteLength) {
              const written = await sink.write(bytes, offset);
              if (written.bytesWritten === 0) throw new Error('The ZIP write made no progress.');
              input.reservation.recordWritten(written.bytesWritten);
              offset += written.bytesWritten;
            }
          }
          if (byteLength !== entry.uncompressedSize || checksum !== entry.crc32) {
            throw new Error('The ZIP entry size or checksum is inconsistent.');
          }
        } finally {
          input.budget.signal.removeEventListener('abort', abort);
          source.destroy();
          await sink?.close();
        }
        files.push({
          relativePath: name,
          byteLength,
          contentDigest: `sha256:${hash.digest('hex')}`,
        });
      }
    } finally {
      await entries.return?.();
    }
    input.budget.signal.throwIfAborted();
    input.reservation.assertAvailable();
    return { root, files, remove: () => removeZipStage(root) };
  } catch (error) {
    try {
      await removeZipStage(root);
    } catch (cleanupError) {
      throw new ArtifactPayloadCleanupError([error, cleanupError]);
    }
    throw error;
  } finally {
    archive?.close();
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

/** Rejects unsafe path syntax before any destination directory or file is made. */
function safeZipPath(raw: string, directory: boolean): string {
  const name = (directory ? raw.slice(0, -1) : raw).normalize('NFC');
  if (
    !name ||
    name.startsWith('/') ||
    /^[A-Za-z]:/.test(name) ||
    /[\\\0]/.test(name) ||
    name.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error('The ZIP entry path is unsafe.');
  }
  return name;
}

/** Rejects collisions with explicit paths and implicit parent directories. */
function claimZipPath(
  paths: Map<string, { kind: 'file' | 'directory'; explicit: boolean }>,
  name: string,
  directory: boolean,
  budget: ZipExtractionBudget
) {
  const previous = paths.get(name);
  if (previous && (!directory || previous.kind !== 'directory' || previous.explicit)) {
    throw new Error('The ZIP contains a normalized path collision.');
  }
  const parts = name.split('/');
  for (let depth = 1; depth < parts.length; depth += 1) {
    const parent = parts.slice(0, depth).join('/');
    if (paths.get(parent)?.kind === 'file') throw new Error('The ZIP contains a path collision.');
    if (!paths.has(parent)) {
      budget.admitPath(parent);
      paths.set(parent, { kind: 'directory', explicit: false });
    }
  }
  paths.set(name, { kind: directory ? 'directory' : 'file', explicit: true });
}

/** Bounds a parser wait without converting cancellation into a partial successful snapshot. */
async function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  // The work has already started. Own a late rejection even when cancellation won before entry.
  void work.catch(() => {});
  signal.throwIfAborted();
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
      }),
    ]);
  } finally {
    if (abort) signal.removeEventListener('abort', abort);
  }
}

/** Keeps the caller's capacity reservation held when private extraction cleanup is unproved. */
async function removeZipStage(root: string): Promise<void> {
  try {
    await rm(root, { recursive: true, force: true });
  } catch (error) {
    throw new ArtifactPayloadCleanupError([error]);
  }
}
