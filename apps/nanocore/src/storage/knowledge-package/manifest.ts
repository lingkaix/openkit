import {
  ContentReferenceRangeSchema,
  ContentReferenceSchema,
  KnowledgeBaseIdSchema,
  KnowledgeContentDigestSchema,
  KnowledgeOwnerScopeSchema,
  parseReferenceUri,
  RETAINED_FORMAT_VERSION,
  ReferenceUriSchema,
  readRetainedV1,
  writeRetainedV1,
} from '@openkit/protocol';
import { z } from 'zod';

/** The package owns interchange versioning, independently of retained-record versioning. */
export const KNOWLEDGE_PACKAGE_FORMAT = 'openkit.knowledge-package' as const;
/** Bound manifest parsing independently of potentially large original files. */
export const MAX_KNOWLEDGE_PACKAGE_MANIFEST_BYTES = 1_048_576;
/** Existing semantics understood by this initial package reader. */
export const KNOWLEDGE_PACKAGE_FEATURES = [
  'openkit.knowledge-git-notebook.v1',
  'openkit.knowledge-owner-scope.v1',
] as const;

const families = new Set(['pages', 'sources', 'schema', 'raw', 'derived', 'indexes']);
type JsonValue = z.infer<ReturnType<typeof z.json>>;
const jsonPrimitive = z.json();

/** Validates every own JSON setting without Zod's record decoder dropping prototype-named keys. */
function isJsonValue(value: unknown): value is JsonValue {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!isJsonValue(value[index])) return false;
    }
    return true;
  }
  if (value !== null && typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    return (
      (prototype === Object.prototype || prototype === null) &&
      Object.values(value).every(isJsonValue)
    );
  }
  return jsonPrimitive.safeParse(value).success;
}

const recipeParameters = z.custom<Record<string, JsonValue>>(
  (value) =>
    value !== null && typeof value === 'object' && !Array.isArray(value) && isJsonValue(value),
  'Recipe parameters must be a JSON object.'
);

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
    path.length <= 1024 &&
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
  knowledgeBaseId: KnowledgeBaseIdSchema,
});

/** Package projection of admitted derivative lineage; it is not a second representation authority. */
export const KnowledgePackageRepresentationSchema = z.object({
  id: z.string().min(1).max(1024),
  path: z.string().refine(isKnowledgePackagePath).nullable(),
  sourceContentDigest: KnowledgeContentDigestSchema,
  sourceReference: ReferenceUriSchema,
  sourceLocator: ContentReferenceRangeSchema.nullable(),
  recipe: z.object({
    id: z.string().min(1),
    version: z.string().min(1),
    parameters: recipeParameters,
  }),
  provider: z.string().min(1).nullable(),
  model: z.string().min(1).nullable(),
  embeddingSpace: z.string().min(1).nullable(),
  contentRef: ContentReferenceSchema,
  byteLength: z.number().int().nonnegative().safe(),
  mediaType: z.string().min(1).max(256),
  coverage: z.enum(['complete', 'incomplete']),
});

const manifestSchema = z.object({
  schemaVersion: z.literal(RETAINED_FORMAT_VERSION),
  format: z.literal(KNOWLEDGE_PACKAGE_FORMAT),
  formatVersion: z.literal(1),
  ownerScope: KnowledgeOwnerScopeSchema,
  knowledgeBaseId: KnowledgeBaseIdSchema,
  requiredFeatures: z.array(z.string()),
  notebookRevision: z.string().min(1).max(256),
  contentInventory: z.array(KnowledgePackageInventoryEntrySchema),
  mounts: z.array(mountSchema).min(1),
  representations: z.array(KnowledgePackageRepresentationSchema),
});

/** Parsed package metadata grants no current scope, mount, publication or filesystem authority. */
export type KnowledgePackageManifest = z.infer<typeof manifestSchema>;
/** Captured native provenance; content inventory is measured separately by the writer. */
export type KnowledgePackageMetadata = Omit<
  KnowledgePackageManifest,
  'schemaVersion' | 'format' | 'formatVersion' | 'contentInventory'
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
    !unique(manifest.mounts.map((mount) => mount.name)) ||
    !unique(manifest.representations.map((representation) => representation.id))
  )
    throw new Error('Unsupported semantics or duplicate Knowledge package member.');
  const defaults = manifest.mounts.filter((mount) => mount.default);
  if (
    defaults.length !== 1 ||
    defaults[0]!.backend !== 'local' ||
    defaults[0]!.root !== 'raw/' ||
    manifest.mounts.some((mount) => mount.knowledgeBaseId !== manifest.knowledgeBaseId)
  )
    throw new Error('Invalid Knowledge package mount binding.');
  const reservedMounts = new Set(
    manifest.mounts.filter((mount) => !mount.default).map((mount) => mount.name)
  );
  for (const file of manifest.contentInventory) {
    if (file.path.startsWith('raw/') && reservedMounts.has(file.path.split('/')[1]!))
      throw new Error('Additional mount bytes cannot travel in a Knowledge package.');
  }
  const inventory = new Map(manifest.contentInventory.map((file) => [file.path, file]));
  for (const file of manifest.contentInventory) {
    const segments = file.path.split('/');
    for (let length = 1; length < segments.length; length += 1) {
      if (inventory.has(segments.slice(0, length).join('/')))
        throw new Error('Knowledge package file and directory paths collide.');
    }
  }
  const outputs = new Set<string>();
  for (const representation of manifest.representations) {
    const source = parseReferenceUri(representation.sourceReference)!;
    if (
      source.contentDigest !== representation.sourceContentDigest ||
      representation.contentRef.knowledgeBaseId !== manifest.knowledgeBaseId ||
      !manifest.mounts.some((mount) => mount.name === representation.contentRef.locator.mount) ||
      JSON.stringify(representation.contentRef.locator.ownerScope) !==
        JSON.stringify(manifest.ownerScope) ||
      representation.contentRef.range !== null ||
      (representation.provider === null) !== (representation.model === null)
    )
      throw new Error('Invalid Knowledge package derivative lineage.');
    if (representation.path === null) {
      if (representation.contentRef.availability !== 'unavailable')
        throw new Error('Omitted derivative bytes are unavailable for package replay.');
      continue;
    }
    const file = inventory.get(representation.path);
    if (
      !representation.path.startsWith('derived/') ||
      outputs.has(representation.path) ||
      representation.contentRef.availability !== 'available' ||
      !file ||
      file.contentDigest !== representation.contentRef.contentDigest ||
      file.byteLength !== representation.byteLength
    )
      throw new Error('Included derivative bytes contradict their declared output.');
    outputs.add(representation.path);
  }
  if (
    manifest.contentInventory.some(
      (file) => file.path.startsWith('derived/') && !outputs.has(file.path)
    )
  )
    throw new Error('A Knowledge package derivative lacks lineage.');
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
      formatVersion: 1,
      ...metadata,
      contentInventory: [...inventory],
    })
  );
  const compare = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
  manifest.requiredFeatures.sort(compare);
  manifest.contentInventory.sort((left, right) => compare(left.path, right.path));
  manifest.mounts.sort((left, right) => compare(left.name, right.name));
  manifest.representations.sort((left, right) => compare(left.id, right.id));
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
  // Render own keys directly: integer-like and prototype-named settings retain exact meaning.
  return `${render(manifest, 0)}\n`;
}
