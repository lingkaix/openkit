import { posix } from 'node:path';

/** Canonical media type for portable Workspace archives. */
export const WORKSPACE_EXPORT_ARCHIVE_MEDIA_TYPE =
  'application/vnd.openkit.workspace-export+tar.zstd';

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
function ustarPath(path: string): { name: Buffer; prefix: Buffer } | undefined {
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
  return undefined;
}

/** Admits one safe canonical path, shared by export, verification and operational restore. */
export function assertWorkspaceArchiveFilePath(path: string): void {
  validateTarPath(path, false);
}

/** Writes one canonical NUL-terminated USTAR octal field. */
function writeWorkspaceArchiveOctal(
  header: Buffer,
  offset: number,
  length: number,
  value: number
): void {
  const encoded = `${value.toString(8).padStart(length - 1, '0')}\0`;
  if (encoded.length !== length) {
    throw new Error('Workspace export value cannot be represented by POSIX USTAR.');
  }
  header.write(encoded, offset, length, 'ascii');
}

/** Returns deterministic entry framing; only paths beyond USTAR gain a standard PAX path record. */
export function workspaceArchiveHeader(
  path: string,
  type: 'directory' | 'file',
  size: number,
  mode?: number
): Buffer {
  validateTarPath(path, type === 'directory');
  const fields = ustarPath(path);
  if (fields) return ustarHeader(fields, type, size, mode);
  // PAX length counts UTF-8 bytes, including its own decimal length and final newline.
  const value = Buffer.from(` path=${path}\n`);
  let length = value.length + 1;
  while (length !== value.length + String(length).length)
    length = value.length + String(length).length;
  const record = Buffer.concat([Buffer.from(String(length)), value]);
  return Buffer.concat([
    ustarHeader(
      { name: Buffer.from('PaxHeader'), prefix: Buffer.alloc(0) },
      'pax',
      record.length,
      0o644
    ),
    record,
    Buffer.alloc((512 - (record.length % 512)) % 512),
    ustarHeader(
      {
        name: Buffer.from(type === 'directory' ? 'PaxEntry/' : 'PaxEntry'),
        prefix: Buffer.alloc(0),
      },
      type,
      size,
      mode
    ),
  ]);
}

/** Encodes unchanged deterministic USTAR fields for a member or its local extended header. */
function ustarHeader(
  { name, prefix }: { name: Buffer; prefix: Buffer },
  type: 'directory' | 'file' | 'pax',
  size: number,
  mode?: number
): Buffer {
  const header = Buffer.alloc(512);
  name.copy(header, 0);
  writeWorkspaceArchiveOctal(header, 100, 8, mode ?? (type === 'directory' ? 0o755 : 0o644));
  writeWorkspaceArchiveOctal(header, 108, 8, 0);
  writeWorkspaceArchiveOctal(header, 116, 8, 0);
  writeWorkspaceArchiveOctal(header, 124, 12, size);
  writeWorkspaceArchiveOctal(header, 136, 12, 0);
  header.fill(32, 148, 156);
  header[156] = type === 'pax' ? 120 : type === 'directory' ? 53 : 48;
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  writeWorkspaceArchiveOctal(header, 329, 8, 0);
  writeWorkspaceArchiveOctal(header, 337, 8, 0);
  prefix.copy(header, 345);
  let checksum = 0;
  for (const byte of header) {
    checksum += byte;
  }
  const encodedChecksum = `${checksum.toString(8).padStart(6, '0')}\0 `;
  if (encodedChecksum.length !== 8) {
    throw new Error('Workspace export checksum cannot be represented by POSIX USTAR.');
  }
  header.write(encodedChecksum, 148, 8, 'ascii');
  return header;
}
