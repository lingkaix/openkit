import { constants } from 'node:fs';
import { lstat, mkdir, open, opendir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  KnowledgeBaseIdSchema,
  KnowledgeContentDigestSchema,
  KnowledgeOwnerScopeSchema,
  RETAINED_FORMAT_VERSION,
  readRetainedV1,
  writeRetainedV1,
} from '@openkit/protocol';
import { verifyPrivateFileCopy, writePrivateTextFileExclusive } from '@openkit/storage';
import { z } from 'zod';

/** Identifies the interchange family; the shared retained marker owns its format version. */
const KNOWLEDGE_PACKAGE_FORMAT = 'openkit.knowledge-package' as const;
/** Bound manifest parsing independently of potentially large original files. */
const MAX_KNOWLEDGE_PACKAGE_MANIFEST_BYTES = 1_048_576;
/** Existing semantics understood by this initial package reader. */
const KNOWLEDGE_PACKAGE_FEATURES = [
  'openkit.knowledge-git-notebook.v1',
  'openkit.knowledge-owner-scope.v1',
] as const;

const families = new Set(['pages', 'sources', 'schema', 'raw', 'indexes']);
function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

/** Checks canonical package-relative names without decoding or normalizing authored paths. */
export function isKnowledgePackagePath(path: string): boolean {
  const parts = path.split('/');
  return (
    Buffer.from(path, 'utf8').toString('utf8') === path &&
    !path.includes('\\') &&
    !hasControlCharacter(path) &&
    parts.length > 1 &&
    families.has(parts[0]!) &&
    parts.every((part) => part !== '' && part !== '.' && part !== '..') &&
    (!(parts[0] === 'pages' || parts[0] === 'sources') || path.endsWith('.md'))
  );
}

/** One included regular file, identified by its actual bytes rather than its filename. */
const KnowledgePackageInventoryEntrySchema = z.object({
  path: z.string().refine(isKnowledgePackagePath, 'Invalid Knowledge package path.'),
  contentDigest: KnowledgeContentDigestSchema,
  byteLength: z.number().int().nonnegative().safe(),
});

const mountSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(255)
    .refine(
      (name) =>
        name !== '.' &&
        name !== '..' &&
        !name.includes('/') &&
        !name.includes('\\') &&
        !hasControlCharacter(name)
    ),
  backend: z.string().min(1).max(128),
  root: z
    .string()
    .min(1)
    .max(4096)
    .refine((root) => {
      if (hasControlCharacter(root)) return false;
      // Remote roots are locations, not credential-bearing or presigned requests.
      if (!root.includes('://')) return true;
      try {
        const url = new URL(root);
        return !url.username && !url.password && !url.search && !url.hash;
      } catch {
        return false;
      }
    }, 'A mount root must contain only a location.'),
  default: z.boolean(),
});

const manifestSchema = z.object({
  schemaVersion: z.literal(RETAINED_FORMAT_VERSION),
  format: z.literal(KNOWLEDGE_PACKAGE_FORMAT),
  ownerScope: KnowledgeOwnerScopeSchema,
  knowledgeBaseId: KnowledgeBaseIdSchema,
  requiredFeatures: z.array(z.string()),
  notebookRevision: z.string().min(1).max(256),
  contentInventory: z.array(KnowledgePackageInventoryEntrySchema),
  mounts: z.array(mountSchema).min(1),
});

/** Parsed package metadata grants no current scope, mount, publication or filesystem authority. */
export type KnowledgePackageManifest = z.infer<typeof manifestSchema>;
/** Captured native provenance; content inventory is measured separately by the writer. */
export type KnowledgePackageMetadata = Omit<
  KnowledgePackageManifest,
  'schemaVersion' | 'format' | 'contentInventory'
>;
/** Exact declared byte identity for one included file. */
export type KnowledgePackageInventoryEntry = z.infer<typeof KnowledgePackageInventoryEntrySchema>;

/** Decodes the family only after the shared retained marker passes, then verifies its closure. */
function parseKnowledgePackageManifest(input: unknown): KnowledgePackageManifest {
  const manifest = readRetainedV1(input, (record) => manifestSchema.parse(record));
  const unique = (values: readonly string[]) => new Set(values).size === values.length;
  if (
    !unique(manifest.requiredFeatures) ||
    manifest.requiredFeatures.some(
      (feature) =>
        !KNOWLEDGE_PACKAGE_FEATURES.includes(feature as (typeof KNOWLEDGE_PACKAGE_FEATURES)[number])
    ) ||
    !unique(manifest.contentInventory.map((file) => file.path)) ||
    !unique(manifest.mounts.map((mount) => mount.name))
  )
    throw new Error('Unsupported semantics or duplicate Knowledge package member.');
  const defaults = manifest.mounts.filter((mount) => mount.default);
  if (defaults.length !== 1 || defaults[0]!.backend !== 'local' || defaults[0]!.root !== 'raw/')
    throw new Error('Invalid Knowledge package mount binding.');
  const reservedMounts = new Set(
    manifest.mounts.filter((mount) => !mount.default).map((mount) => mount.name)
  );
  for (const file of manifest.contentInventory) {
    if (file.path.startsWith('raw/') && reservedMounts.has(file.path.split('/')[1]!))
      throw new Error('Additional mount bytes cannot travel in a Knowledge package.');
  }
  // A trailing slash sorts each parent directly before its descendants without rebuilding prefixes.
  const directoryKeys = manifest.contentInventory.map((file) => `${file.path}/`).sort();
  if (directoryKeys.some((key, index) => index > 0 && key.startsWith(directoryKeys[index - 1]!)))
    throw new Error('Knowledge package file and directory paths collide.');
  return manifest;
}

/** Produces deterministic native manifest data through the sole retained-v1 writer. */
function createKnowledgePackageManifest(
  metadata: KnowledgePackageMetadata,
  inventory: readonly KnowledgePackageInventoryEntry[]
): KnowledgePackageManifest {
  const manifest = parseKnowledgePackageManifest(
    writeRetainedV1({
      format: KNOWLEDGE_PACKAGE_FORMAT,
      ...metadata,
      contentInventory: [...inventory],
    })
  );
  const compare = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
  manifest.requiredFeatures.sort(compare);
  manifest.contentInventory.sort((left, right) => compare(left.path, right.path));
  manifest.mounts.sort((left, right) => compare(left.name, right.name));
  return manifest;
}

/** Sorts JSON object keys without rewriting any included authored content bytes. */
function serializeKnowledgePackageManifest(manifest: KnowledgePackageManifest): string {
  const indentation = (depth: number) => '  '.repeat(depth);
  const render = (value: unknown, depth: number): string => {
    if (Array.isArray(value)) {
      if (value.length === 0) return '[]';
      const entries = value.map((entry) => `${indentation(depth + 1)}${render(entry, depth + 1)}`);
      return `[\n${entries.join(',\n')}\n${indentation(depth)}]`;
    }
    if (value !== null && typeof value === 'object') {
      const entries = Object.entries(value).sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0
      );
      if (entries.length === 0) return '{}';
      const fields = entries.map(
        ([key, entry]) =>
          `${indentation(depth + 1)}${JSON.stringify(key)}: ${render(entry, depth + 1)}`
      );
      return `{\n${fields.join(',\n')}\n${indentation(depth)}}`;
    }
    return JSON.stringify(value)!;
  };
  return `${render(manifest, 0)}\n`;
}

/** Caller admission limits include manifest bytes and all physical entries except the root. */
export interface KnowledgePackageLimits {
  readonly maxEntries: number;
  readonly maxBytes: number;
}

/** An admitted source file; its private native path never enters the package manifest. */
export interface KnowledgePackageFile extends KnowledgePackageInventoryEntry {
  readonly sourcePath: string;
}

function validateLimits(limits: KnowledgePackageLimits): void {
  if (
    !Number.isSafeInteger(limits.maxEntries) ||
    limits.maxEntries < 1 ||
    !Number.isSafeInteger(limits.maxBytes) ||
    limits.maxBytes < 1
  )
    throw new Error('Knowledge package limits must be positive safe integers.');
}

function checkUsage(entries: number, bytes: number, limits: KnowledgePackageLimits): void {
  if (!Number.isSafeInteger(bytes) || entries > limits.maxEntries || bytes > limits.maxBytes)
    throw new Error('Knowledge package resource limit exceeded.');
}

/** Reads only the separately bounded manifest; large included files never enter a whole-file buffer. */
async function readManifest(
  directory: string,
  limits: KnowledgePackageLimits
): Promise<KnowledgePackageManifest> {
  const file = await open(
    join(directory, 'manifest.json'),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    const before = await file.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.size > BigInt(MAX_KNOWLEDGE_PACKAGE_MANIFEST_BYTES)
    )
      throw new Error('Knowledge package manifest must be a bounded regular file.');
    checkUsage(1, Number(before.size), limits);
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    const after = await file.stat({ bigint: true });
    if (
      BigInt(length) !== before.size ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    )
      throw new Error('Knowledge package manifest changed during validation.');
    const text = buffer.subarray(0, length).toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(buffer.subarray(0, length)))
      throw new Error('Knowledge package manifest is not UTF-8.');
    return parseKnowledgePackageManifest(JSON.parse(text));
  } finally {
    await file.close();
  }
}

/** Checks format integrity in a private, immutable staging tree; this grants no Source or publication authority. */
export async function verifyKnowledgePackageFormat(input: {
  readonly directory: string;
  readonly limits: KnowledgePackageLimits;
}): Promise<KnowledgePackageManifest> {
  const { directory, limits } = input;
  validateLimits(limits);
  const root = await lstat(directory);
  if (!root.isDirectory() || root.isSymbolicLink())
    throw new Error('Knowledge package root must be a directory.');
  const manifest = await readManifest(directory, limits);
  const expected = new Map(manifest.contentInventory.map((file) => [file.path, file]));
  const reserved = new Set(
    manifest.mounts.filter((mount) => !mount.default).map((mount) => `raw/${mount.name}`)
  );
  let entries = 0;
  let bytes = 0;
  const pending = [''];
  const found = new Set<string>();
  while (pending.length > 0) {
    const parent = pending.pop()!;
    const children = await opendir(join(directory, parent));
    for await (const { name } of children) {
      checkUsage(entries + 1, bytes, limits);
      const relative = parent ? `${parent}/${name}` : name;
      const stat = await lstat(join(directory, relative));
      entries += 1;
      if (stat.isDirectory()) {
        if (!isKnowledgePackagePath(`${relative}/member.md`) || reserved.has(relative))
          throw new Error('Knowledge package directory is outside its declared layout.');
        pending.push(relative);
      } else {
        if (!stat.isFile() || stat.nlink !== 1)
          throw new Error('Knowledge package links and special files are refused.');
        bytes += stat.size;
        if (relative !== 'manifest.json') {
          const member = expected.get(relative);
          if (!member) throw new Error('Knowledge package contains an undeclared file.');
          if (stat.size !== member.byteLength)
            throw new Error('Knowledge package member length does not match.');
          found.add(relative);
        }
      }
      checkUsage(entries, bytes, limits);
    }
  }
  if (found.size !== expected.size)
    throw new Error('Knowledge package is missing an inventoried file.');
  for (const file of manifest.contentInventory)
    await verifyPrivateFileCopy(join(directory, file.path), file);
  return manifest;
}

/** Captures already-admitted native files into a fresh private directory without rewriting their bytes. */
export async function writeKnowledgePackageFormat(input: {
  readonly directory: string;
  readonly metadata: KnowledgePackageMetadata;
  readonly files: readonly KnowledgePackageFile[];
  readonly limits: KnowledgePackageLimits;
}): Promise<KnowledgePackageManifest> {
  const { directory, metadata, files, limits } = input;
  validateLimits(limits);
  const manifest = createKnowledgePackageManifest(metadata, files);
  const text = serializeKnowledgePackageManifest(manifest);
  const manifestBytes = Buffer.byteLength(text);
  if (manifestBytes > MAX_KNOWLEDGE_PACKAGE_MANIFEST_BYTES)
    throw new Error('Knowledge package manifest is too large.');
  const parents = new Set<string>();
  for (const file of manifest.contentInventory) {
    let parent = dirname(file.path);
    while (parent !== '.') {
      parents.add(parent);
      parent = dirname(parent);
    }
  }
  checkUsage(
    1 + files.length + parents.size,
    manifest.contentInventory.reduce((total, file) => total + file.byteLength, manifestBytes),
    limits
  );
  // Creation is exclusive. Cleanup below can remove only this call's new private staging tree.
  await mkdir(directory, { mode: 0o700 });
  try {
    for (const parent of [...parents].sort())
      await mkdir(join(directory, parent), { recursive: true, mode: 0o700 });
    const sources = new Map(files.map((file) => [file.path, file.sourcePath]));
    for (const file of manifest.contentInventory)
      await verifyPrivateFileCopy(sources.get(file.path)!, file, join(directory, file.path));
    await writePrivateTextFileExclusive(join(directory, 'manifest.json'), text);
    await verifyKnowledgePackageFormat({ directory, limits });
    return manifest;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
