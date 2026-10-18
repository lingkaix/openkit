import {
  KnowledgeBaseIdSchema,
  KnowledgeContentDigestSchema,
  KnowledgeOwnerScopeSchema,
  RETAINED_FORMAT_VERSION,
  readRetainedV1,
  writeRetainedV1,
} from '@openkit/protocol';
import { z } from 'zod';

/** Identifies the interchange family; the shared retained marker owns its format version. */
export const KNOWLEDGE_PACKAGE_FORMAT = 'openkit.knowledge-package' as const;
/** Bound manifest parsing independently of potentially large original files. */
export const MAX_KNOWLEDGE_PACKAGE_MANIFEST_BYTES = 1_048_576;
/** Existing semantics understood by this initial package reader. */
export const KNOWLEDGE_PACKAGE_FEATURES = [
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
export const KnowledgePackageInventoryEntrySchema = z.object({
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
export function parseKnowledgePackageManifest(input: unknown): KnowledgePackageManifest {
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
export function createKnowledgePackageManifest(
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
export function serializeKnowledgePackageManifest(manifest: KnowledgePackageManifest): string {
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
