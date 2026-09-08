import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Named digest format for bounded installed resource trees. */
export const OPENKIT_TREE_DIGEST_FORMAT = 'openkit-tree-v1' as const;

const TREE_DOMAIN = Buffer.from(OPENKIT_TREE_DIGEST_FORMAT, 'ascii');
const GIT_SEGMENT = '.git';
const MAX_UTF8_PATH_BYTES = 4_096;

/** One directory or regular file participating in `openkit-tree-v1`. */
export interface OpenKitTreeEntry {
  /** Exact file bytes; omitted for directories. */
  readonly content?: Buffer;
  /** `0` directory, `1` non-executable file, `2` file with any executable bit. */
  readonly kind: 0 | 1 | 2;
  /** Root-relative `/`-separated Unicode NFC path without a trailing slash. */
  readonly path: string;
}

/** Bounds applied while collecting or hashing one tree. */
export interface OpenKitTreeBounds {
  /** Inclusive maximum regular-file bytes. */
  readonly maxBytes: number;
  /** Inclusive maximum directory plus file entries. */
  readonly maxEntries: number;
  /** Inclusive maximum directory depth below the implicit root. */
  readonly maxDepth?: number;
}

/** Digest and inventory produced from one admitted tree. */
export interface OpenKitTreeDigest {
  /** `sha256:` plus 64 lowercase hexadecimal digits. */
  readonly digest: string;
  /** Named digest format. */
  readonly digestFormat: typeof OPENKIT_TREE_DIGEST_FORMAT;
  /** Ordered inventory used for the digest. */
  readonly entries: readonly OpenKitTreeEntry[];
}

const DEFAULT_BOUNDS: OpenKitTreeBounds = {
  maxBytes: 16 * 1024 * 1024,
  maxDepth: 32,
  maxEntries: 1_024,
};

/**
 * Hashes one already-validated bounded tree.
 *
 * @param entries Unordered tree entries.
 * @param bounds Optional Skill-or-package limits.
 * @returns `sha256:` digest.
 */
export function hashOpenKitTreeEntries(
  entries: readonly OpenKitTreeEntry[],
  bounds: OpenKitTreeBounds = DEFAULT_BOUNDS
): string {
  const normalized = normalizeTreeEntries(entries, bounds);
  return hashNormalizedTree(normalized);
}

/**
 * Walks one filesystem root, skipping `.git`, and returns its digest plus inventory.
 *
 * @param root Absolute directory to hash.
 * @param bounds Optional Skill-or-package limits.
 * @returns Digest and collected entries.
 */
export function digestOpenKitTree(
  root: string,
  bounds: OpenKitTreeBounds = DEFAULT_BOUNDS
): OpenKitTreeDigest {
  const entries = collectBoundedTree(root, bounds);
  return {
    digest: hashNormalizedTree(entries),
    digestFormat: OPENKIT_TREE_DIGEST_FORMAT,
    entries,
  };
}

/**
 * Collects a bounded installable tree, excluding repository-administrative `.git` entries.
 *
 * @param root Absolute directory to walk.
 * @param bounds Optional Skill-or-package limits.
 * @returns Ordered normalized entries.
 */
export function collectBoundedTree(
  root: string,
  bounds: OpenKitTreeBounds = DEFAULT_BOUNDS
): OpenKitTreeEntry[] {
  const collected: OpenKitTreeEntry[] = [];
  walkTree(root, '', collected, bounds);
  return normalizeTreeEntries(collected, bounds);
}

/**
 * Recursively walks one directory into the collector.
 *
 * @param absolute Parent filesystem path.
 * @param relative Root-relative path, empty at the implicit root.
 * @param collected Mutable collector.
 * @param bounds Resource limits.
 */
function walkTree(
  absolute: string,
  relative: string,
  collected: OpenKitTreeEntry[],
  bounds: OpenKitTreeBounds
): void {
  const metadata = lstatSync(absolute);
  if (metadata.isSymbolicLink()) {
    throw new Error(`Resource tree must not contain a symbolic link: ${relative || '.'}.`);
  }
  if (metadata.isDirectory()) {
    if (relative.length > 0) {
      collected.push({ kind: 0, path: relative });
    }
    const depth = relative.length === 0 ? 0 : relative.split('/').length;
    if (depth >= (bounds.maxDepth ?? DEFAULT_BOUNDS.maxDepth ?? 32)) {
      throw new Error(`Resource tree exceeds ${bounds.maxDepth ?? 32} directory levels.`);
    }
    for (const name of readdirSync(absolute).sort()) {
      if (name === GIT_SEGMENT) {
        continue;
      }
      walkTree(join(absolute, name), relative ? `${relative}/${name}` : name, collected, bounds);
    }
    return;
  }
  if (!metadata.isFile()) {
    throw new Error(`Resource tree entries must be directories or regular files: ${relative}.`);
  }
  collected.push({
    content: readFileSync(absolute),
    kind: (metadata.mode & 0o111) === 0 ? 1 : 2,
    path: relative,
  });
}

/**
 * Validates, bounds, and lexicographically orders tree entries.
 *
 * @param entries Candidate entries.
 * @param bounds Resource limits.
 * @returns Ordered normalized copies.
 */
function normalizeTreeEntries(
  entries: readonly OpenKitTreeEntry[],
  bounds: OpenKitTreeBounds
): OpenKitTreeEntry[] {
  if (entries.length > bounds.maxEntries) {
    throw new Error(`Resource tree exceeds ${bounds.maxEntries.toLocaleString('en-US')} entries.`);
  }
  const seen = new Set<string>();
  let fileBytes = 0;
  const normalized: OpenKitTreeEntry[] = entries.map((entry) => {
    validateTreePath(entry.path, bounds.maxDepth ?? DEFAULT_BOUNDS.maxDepth ?? 32);
    if (seen.has(entry.path)) {
      throw new Error(`Resource tree contains a duplicate path: ${entry.path}.`);
    }
    seen.add(entry.path);
    if (entry.kind === 0) {
      if (entry.content !== undefined && entry.content.length > 0) {
        throw new Error(`Directory entries cannot carry content: ${entry.path}.`);
      }
      return { kind: 0, path: entry.path };
    }
    const content = entry.content ?? Buffer.alloc(0);
    fileBytes += content.length;
    if (fileBytes > bounds.maxBytes) {
      throw new Error(
        `Resource tree exceeds ${bounds.maxBytes.toLocaleString('en-US')} file bytes.`
      );
    }
    return { content, kind: entry.kind, path: entry.path };
  });
  normalized.sort((left, right) => compareUtf8(left.path, right.path));
  return normalized;
}

/**
 * Enforces the Skill/package path contract.
 *
 * @param path Root-relative path.
 * @param maxDepth Inclusive directory-level bound.
 */
function validateTreePath(path: string, maxDepth: number): void {
  if (path.length === 0 || path.startsWith('/') || path.includes('\\') || path.includes('\0')) {
    throw new Error(
      path.includes('\\')
        ? 'Resource tree paths must not contain a backslash.'
        : 'Resource tree paths must be relative, non-empty, and free of NUL or absolute prefixes.'
    );
  }
  const bytes = Buffer.from(path, 'utf8');
  if (bytes.includes(0) || bytes.length > MAX_UTF8_PATH_BYTES || bytes.toString('utf8') !== path) {
    throw new Error('Resource tree paths must be well-formed UTF-8 within the path-byte bound.');
  }
  if (path.normalize('NFC') !== path) {
    throw new Error('Resource tree paths must already be Unicode NFC.');
  }
  const segments = path.split('/');
  if (segments.length > maxDepth) {
    throw new Error(`Resource tree exceeds ${maxDepth} directory levels.`);
  }
  for (const segment of segments) {
    if (segment.length === 0 || segment === '.' || segment === '..') {
      throw new Error('Resource tree paths must not contain empty, dot, or parent path segments.');
    }
    if (segment === GIT_SEGMENT) {
      throw new Error('Uploaded resource trees must not contain a .git path segment.');
    }
  }
}

/**
 * Compares two strings by unsigned UTF-8 path bytes.
 *
 * @param left Left path.
 * @param right Right path.
 * @returns Negative when left sorts first.
 */
function compareUtf8(left: string, right: string): number {
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  const limit = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < limit; index += 1) {
    const delta = leftBytes[index]! - rightBytes[index]!;
    if (delta !== 0) {
      return delta;
    }
  }
  return leftBytes.length - rightBytes.length;
}

/**
 * Hashes normalized entries with the `openkit-tree-v1` framing.
 *
 * @param entries Ordered validated entries.
 * @returns `sha256:` digest.
 */
function hashNormalizedTree(entries: readonly OpenKitTreeEntry[]): string {
  const hash = createHash('sha256');
  hash.update(TREE_DOMAIN);
  hash.update(Buffer.from([0]));
  hash.update(u32(entries.length));
  for (const entry of entries) {
    const pathBytes = Buffer.from(entry.path, 'utf8');
    hash.update(u32(pathBytes.length));
    hash.update(pathBytes);
    hash.update(Buffer.from([entry.kind]));
    const content = entry.kind === 0 ? Buffer.alloc(0) : (entry.content ?? Buffer.alloc(0));
    hash.update(u64(content.length));
    hash.update(content);
  }
  return `sha256:${hash.digest('hex')}`;
}

/**
 * Encodes an unsigned 32-bit big-endian integer.
 *
 * @param value Integer in range.
 * @returns Four-byte buffer.
 */
function u32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value);
  return buffer;
}

/**
 * Encodes an unsigned 64-bit big-endian integer for content lengths.
 *
 * @param value Non-negative length.
 * @returns Eight-byte buffer.
 */
function u64(value: number): Buffer {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(value));
  return buffer;
}
