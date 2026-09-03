import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { Readable, Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createZstdDecompress } from 'node:zlib';

/** Canonical media type for portable Workspace archives. */
export const WORKSPACE_EXPORT_ARCHIVE_MEDIA_TYPE =
  'application/vnd.openkit.workspace-export+tar.zstd';

const MAX_COMPRESSED_BYTES = 8_589_934_592;
const MAX_EXPANDED_BYTES = 34_359_738_368;
const MAX_TAR_ENTRIES = 200_000;
const MAX_FILE_BYTES = 2_147_483_648;

/** One request-owned extracted archive tree. */
export interface StagedWorkspaceArchive {
  /** Root containing the extracted export tree. */
  readonly exportRoot: string;
  /** Removes only this request's staging directory. */
  readonly remove: () => void;
}

/**
 * Removes the complete non-authorizing archive-request namespace during exclusive boot preflight.
 *
 * @param dataRoot Canonical data root held by the boot process lock.
 */
export function cleanupWorkspaceArchiveRequestStaging(dataRoot: string): void {
  const stagingRoot = join(dataRoot, 'server', 'files', 'workspace-archive-requests');
  const metadata = lstatSync(stagingRoot, { throwIfNoEntry: false });
  if (!metadata) {
    return;
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error('Workspace archive staging root is invalid.');
  }
  rmSync(stagingRoot, { recursive: true });
}

/** Counts streamed bytes and fails before the owned ceiling is exceeded. */
class ByteLimitTransform extends Transform {
  private observed = 0;

  public constructor(private readonly maximum: number) {
    super();
  }

  public override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback
  ): void {
    this.observed += chunk.byteLength;
    if (this.observed > this.maximum) {
      callback(new Error('Workspace archive exceeds its byte limit.'));
      return;
    }
    callback(null, chunk);
  }
}

/** Decodes one strict NUL-padded UTF-8 tar text field. */
function decodeTarText(header: Buffer, offset: number, length: number): string {
  const field = header.subarray(offset, offset + length);
  const terminator = field.indexOf(0);
  const bytes = terminator === -1 ? field : field.subarray(0, terminator);
  if (terminator !== -1 && !field.subarray(terminator).every((byte) => byte === 0)) {
    throw new Error('Workspace archive contains a noncanonical tar text field.');
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

/** Parses one strict octal tar number field. */
function parseTarOctal(header: Buffer, offset: number, length: number): number {
  const field = header.subarray(offset, offset + length);
  const terminator = field.indexOf(0);
  const text = field
    .subarray(0, terminator === -1 ? field.length : terminator)
    .toString('ascii')
    .trim();
  if (!/^[0-7]+$/.test(text)) {
    throw new Error('Workspace archive contains a noncanonical tar number.');
  }
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('Workspace archive contains an invalid tar number.');
  }
  return value;
}

/** Verifies the checksum and USTAR identity of one tar header. */
function verifyTarHeader(header: Buffer): void {
  if (
    !header.subarray(257, 263).equals(Buffer.from('ustar\0')) ||
    !header.subarray(263, 265).equals(Buffer.from('00'))
  ) {
    throw new Error('Workspace archive must use the POSIX USTAR format.');
  }
  const expected = parseTarOctal(header, 148, 8);
  let actual = 0;
  for (let index = 0; index < header.length; index += 1) {
    actual += index >= 148 && index < 156 ? 32 : (header[index] ?? 0);
  }
  if (actual !== expected) {
    throw new Error('Workspace archive tar checksum is invalid.');
  }
}

/** Validates and normalizes one regular-file or directory tar path. */
function validateTarPath(name: string, directory: boolean): string {
  if (directory !== name.endsWith('/')) {
    throw new Error('Workspace archive tar entry has a noncanonical type suffix.');
  }
  const path = directory ? name.slice(0, -1) : name;
  if (
    path.length === 0 ||
    path !== path.normalize('NFC') ||
    posix.isAbsolute(path) ||
    path.includes('\\') ||
    [...path].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127;
    }) ||
    path.split('/').some((part) => part.length === 0 || part === '.' || part === '..') ||
    posix.normalize(path) !== path
  ) {
    throw new Error('Workspace archive tar entry path is unsafe.');
  }
  return path;
}

/**
 * Splits one canonical path across the fixed POSIX USTAR name and prefix fields.
 *
 * @param path Canonical relative entry path, including a directory suffix when applicable.
 * @returns Exact USTAR name and prefix fields.
 */
export function splitWorkspaceArchivePath(path: string): { name: Buffer; prefix: Buffer } {
  validateTarPath(path, path.endsWith('/'));
  const direct = Buffer.from(path);
  if (direct.byteLength <= 100) {
    return { name: direct, prefix: Buffer.alloc(0) };
  }
  for (let split = path.lastIndexOf('/'); split > 0; split = path.lastIndexOf('/', split - 1)) {
    const name = Buffer.from(path.slice(split + 1));
    const prefix = Buffer.from(path.slice(0, split));
    if (name.byteLength > 0 && name.byteLength <= 100 && prefix.byteLength <= 155) {
      return { name, prefix };
    }
  }
  throw new Error('Workspace export path cannot be represented by POSIX USTAR.');
}

/**
 * Requires one portable export file and every derived directory to fit strict POSIX USTAR.
 *
 * @param path Export-relative regular-file path.
 */
export function assertWorkspaceArchiveFilePath(path: string): void {
  splitWorkspaceArchivePath(path);
  const parts = path.split('/');
  parts.pop();
  while (parts.length > 0) {
    splitWorkspaceArchivePath(`${parts.join('/')}/`);
    parts.pop();
  }
}

/** Writes every byte to one exclusively created staging file. */
function writeAll(fileDescriptor: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    offset += writeSync(fileDescriptor, bytes, offset);
  }
}

/** Strict streaming tar extractor for one private request staging root. */
class WorkspaceTarExtractTransform extends Transform {
  private currentFile: number | null = null;
  private currentPadding = 0;
  private currentRemaining = 0;
  private ended = false;
  private endingPaddingBytes = 0;
  private entries = 0;
  private pending = Buffer.alloc(0);
  private readonly paths = new Set<string>();
  private readonly casePaths = new Set<string>();
  private zeroBlocks = 0;

  public constructor(private readonly exportRoot: string) {
    super();
  }

  public override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback
  ): void {
    try {
      this.pending = Buffer.concat([this.pending, chunk]);
      this.consume();
      callback();
    } catch (error) {
      this.closeCurrentFile();
      callback(error as Error);
    }
  }

  public override _flush(callback: TransformCallback): void {
    this.closeCurrentFile();
    if (
      !this.ended ||
      this.zeroBlocks < 2 ||
      this.endingPaddingBytes % 512 !== 0 ||
      this.currentRemaining !== 0 ||
      this.currentPadding !== 0 ||
      this.pending.length !== 0
    ) {
      callback(new Error('Workspace archive tar stream is truncated.'));
      return;
    }
    callback();
  }

  public override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    try {
      this.closeCurrentFile();
      callback(error);
    } catch (closeError) {
      callback(error ?? (closeError as Error));
    }
  }

  private closeCurrentFile(): void {
    if (this.currentFile !== null) {
      closeSync(this.currentFile);
      this.currentFile = null;
    }
  }

  private consume(): void {
    while (this.pending.length > 0) {
      if (this.ended) {
        if (!this.pending.every((byte) => byte === 0)) {
          throw new Error('Workspace archive contains bytes after its tar end marker.');
        }
        this.endingPaddingBytes += this.pending.byteLength;
        this.pending = Buffer.alloc(0);
        return;
      }
      if (this.currentRemaining > 0) {
        const length = Math.min(this.currentRemaining, this.pending.length);
        if (this.currentFile === null) {
          throw new Error('Workspace archive lost its staging file owner.');
        }
        writeAll(this.currentFile, this.pending.subarray(0, length));
        this.pending = this.pending.subarray(length);
        this.currentRemaining -= length;
        if (this.currentRemaining === 0) {
          this.closeCurrentFile();
        }
        continue;
      }
      if (this.currentPadding > 0) {
        const length = Math.min(this.currentPadding, this.pending.length);
        if (!this.pending.subarray(0, length).every((byte) => byte === 0)) {
          throw new Error('Workspace archive contains nonzero tar padding.');
        }
        this.pending = this.pending.subarray(length);
        this.currentPadding -= length;
        continue;
      }
      if (this.pending.length < 512) {
        return;
      }
      const header = this.pending.subarray(0, 512);
      this.pending = this.pending.subarray(512);
      if (header.every((byte) => byte === 0)) {
        this.zeroBlocks += 1;
        if (this.zeroBlocks === 2) {
          this.ended = true;
        }
        continue;
      }
      if (this.zeroBlocks !== 0) {
        throw new Error('Workspace archive contains an incomplete tar end marker.');
      }
      this.startEntry(header);
    }
  }

  private startEntry(header: Buffer): void {
    verifyTarHeader(header);
    this.entries += 1;
    if (this.entries > MAX_TAR_ENTRIES) {
      throw new Error('Workspace archive contains too many tar entries.');
    }
    const type = header[156];
    const directory = type === 53;
    if (type !== 0 && type !== 48 && !directory) {
      throw new Error('Workspace archive contains an unsupported tar entry type.');
    }
    const name = decodeTarText(header, 0, 100);
    const prefix = decodeTarText(header, 345, 155);
    const path = validateTarPath(prefix ? `${prefix}/${name}` : name, directory);
    const collisionKey = path.toLowerCase();
    if (this.paths.has(path) || this.casePaths.has(collisionKey)) {
      throw new Error('Workspace archive contains a duplicate or case-colliding path.');
    }
    this.paths.add(path);
    this.casePaths.add(collisionKey);
    const size = parseTarOctal(header, 124, 12);
    if (directory) {
      if (size !== 0) {
        throw new Error('Workspace archive directory contains a body.');
      }
      mkdirSync(join(this.exportRoot, path), { recursive: true, mode: 0o700 });
      return;
    }
    if (size > MAX_FILE_BYTES) {
      throw new Error('Workspace archive file exceeds its byte limit.');
    }
    const target = join(this.exportRoot, path);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    this.currentFile = openSync(
      target,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600
    );
    this.currentRemaining = size;
    this.currentPadding = (512 - (size % 512)) % 512;
    if (size === 0) {
      this.closeCurrentFile();
    }
  }
}

/**
 * Extracts one request body into private request-local staging.
 *
 * @param request Archive upload request.
 * @param dataRoot Canonical target data root.
 * @returns Owned staging handle whose caller must remove in a finally block.
 */
export async function stageWorkspaceArchive(
  request: Request,
  dataRoot: string
): Promise<StagedWorkspaceArchive> {
  if (request.headers.get('content-type') !== WORKSPACE_EXPORT_ARCHIVE_MEDIA_TYPE) {
    throw new Error('Workspace archive media type is invalid.');
  }
  const declaredLength = request.headers.get('content-length');
  if (declaredLength !== null) {
    if (!/^\d+$/u.test(declaredLength) || BigInt(declaredLength) > BigInt(MAX_COMPRESSED_BYTES)) {
      throw new Error('Workspace archive exceeds its compressed byte limit.');
    }
  }
  if (!request.body) {
    throw new Error('Workspace archive body is required.');
  }

  const stagingRoot = join(dataRoot, 'server', 'files', 'workspace-archive-requests');
  const stagingMetadata = lstatSync(stagingRoot, { throwIfNoEntry: false });
  if (stagingMetadata && (stagingMetadata.isSymbolicLink() || !stagingMetadata.isDirectory())) {
    throw new Error('Workspace archive staging root is invalid.');
  }
  mkdirSync(stagingRoot, { recursive: true, mode: 0o700 });
  const requestRoot = mkdtempSync(join(stagingRoot, `request-${randomUUID()}-`));
  const exportRoot = join(requestRoot, 'export');
  mkdirSync(exportRoot, { mode: 0o700 });
  const remove = () => rmSync(requestRoot, { force: true, recursive: true });

  try {
    await pipeline(
      Readable.fromWeb(request.body as never),
      new ByteLimitTransform(MAX_COMPRESSED_BYTES),
      createZstdDecompress(),
      new ByteLimitTransform(MAX_EXPANDED_BYTES),
      new WorkspaceTarExtractTransform(exportRoot)
    );
    return { exportRoot, remove };
  } catch (error) {
    remove();
    throw error;
  }
}
