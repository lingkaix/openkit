import { z } from 'zod';

import {
  mcpCatalogContainsRawSecret,
  WorkspaceMcpCredentialBindingSchema,
  WorkspaceMcpToolNameSchema,
} from './mcp-catalog.js';
import { OPENKIT_TREE_DIGEST_FORMAT } from './tree-digest.js';

const CATALOG_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/;
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HTTP_HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const RESERVED_PLUGIN_ENV = new Set(['PLUGIN_ROOT', 'PLUGIN_DATA']);

/** Stable scoped catalog identifier. */
export const ResourceCatalogIdSchema = z.string().regex(CATALOG_ID);

/** Canonical lowercase SHA-256 digest. */
export const ResourceDigestSchema = z.string().regex(SHA256_DIGEST);

/** Actor recorded on catalog provenance. */
export const CatalogProducerSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(['user', 'agent', 'system']),
  })
  .strict();

/** File or directory inventory row retained with a Skill or package version. */
export const ResourceInventoryEntrySchema = z
  .object({
    executable: z.boolean(),
    kind: z.enum(['directory', 'file']),
    path: z.string().min(1),
    sha256: ResourceDigestSchema.nullable(),
    size: z.number().int().nonnegative(),
  })
  .strict();

/** Immutable Skill version metadata. */
export const SkillVersionRecordSchema = z
  .object({
    createdAt: z.string().min(1),
    digest: ResourceDigestSchema,
    digestFormat: z.literal(OPENKIT_TREE_DIGEST_FORMAT),
    entryId: ResourceCatalogIdSchema,
    inventory: z.array(ResourceInventoryEntrySchema),
    producer: CatalogProducerSchema,
    provenance: z
      .object({
        baseDigest: ResourceDigestSchema.nullable().default(null),
        pluginMemberKey: z.string().min(1).nullable().default(null),
        pluginVersionDigest: ResourceDigestSchema.nullable().default(null),
        sourceCommit: z.string().min(1).nullable().default(null),
        sourceSubpath: z.string().min(1).nullable().default(null),
        uploadedSourceId: z.string().min(1).nullable().default(null),
      })
      .strict(),
    publisherVersion: z.string().min(1).nullable().default(null),
  })
  .strict();

/** Workspace or server Skill catalog entry. */
export const SkillEntryRecordSchema = z
  .object({
    availability: z.enum(['available', 'removed']),
    currentDigest: ResourceDigestSchema.nullable(),
    description: z.string().min(1).nullable().default(null),
    displayName: z.string().min(1),
    id: ResourceCatalogIdSchema,
  })
  .strict();

/** Exact pin of one Skill version for the owning Workspace. */
export const SkillPinRecordSchema = z
  .object({
    digest: ResourceDigestSchema,
    entryId: ResourceCatalogIdSchema,
  })
  .strict();

/** Bounded Skill candidate requesting promotion review. */
export const SkillCandidateRecordSchema = z
  .object({
    baseDigest: ResourceDigestSchema.nullable(),
    candidateDigest: ResourceDigestSchema,
    createdAt: z.string().min(1),
    disposition: z.enum(['proposed', 'withdrawn', 'rejected', 'promoted']),
    entryId: ResourceCatalogIdSchema,
    evidenceRefs: z.array(z.string().min(1)).default([]),
    id: z.string().min(1),
    producer: CatalogProducerSchema,
    summary: z.string().min(1).max(4_096),
  })
  .strict();

/** Non-secret stdio declaration stored on an MCP configuration version. */
export const McpStdioDeclarationSchema = z
  .object({
    args: z.array(z.string()).default([]),
    command: z.string().min(1),
    cwd: z.string().min(1).nullable().default(null),
    environment: z.record(z.string().regex(ENVIRONMENT_NAME), z.string()).default({}),
    environmentSlots: z
      .record(
        z.string().regex(ENVIRONMENT_NAME),
        z.object({ credentialSlot: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/) }).strict()
      )
      .default({}),
    kind: z.literal('stdio'),
  })
  .strict()
  .superRefine((value, context) => {
    for (const name of [
      ...Object.keys(value.environment),
      ...Object.keys(value.environmentSlots),
    ]) {
      if (RESERVED_PLUGIN_ENV.has(name)) {
        context.addIssue({
          code: 'custom',
          message: `Reserved MCP environment name cannot be configured: ${name}.`,
          path: ['environment', name],
        });
      }
    }
    if (mcpCatalogContainsRawSecret(value)) {
      context.addIssue({
        code: 'custom',
        message: 'Workspace MCP catalogs must not contain raw-secret-shaped strings.',
      });
    }
  });

/** Non-secret Streamable HTTP declaration stored on an MCP configuration version. */
export const McpHttpDeclarationSchema = z
  .object({
    endpoint: z.string().url(),
    headers: z.record(z.string().regex(HTTP_HEADER_NAME), z.string()).default({}),
    kind: z.literal('http'),
  })
  .strict()
  .superRefine((value, context) => {
    if (mcpCatalogContainsRawSecret(value)) {
      context.addIssue({
        code: 'custom',
        message: 'Workspace MCP catalogs must not contain raw-secret-shaped strings.',
      });
    }
  });

/** Validated non-secret MCP transport declaration. */
export const McpValidatedDeclarationSchema = z.discriminatedUnion('kind', [
  McpStdioDeclarationSchema,
  McpHttpDeclarationSchema,
]);

/** Immutable MCP configuration version. */
export const McpConfigVersionRecordSchema = z
  .object({
    createdAt: z.string().min(1),
    declaration: McpValidatedDeclarationSchema,
    digest: ResourceDigestSchema,
    digestFormat: z.literal('openkit-mcp-config-v1'),
    entryId: ResourceCatalogIdSchema,
    packageRootDigest: ResourceDigestSchema.nullable().default(null),
    pluginVersionDigest: ResourceDigestSchema.nullable().default(null),
    provenance: z
      .object({
        pluginMemberKey: z.string().min(1).nullable().default(null),
        sourceCommit: z.string().min(1).nullable().default(null),
        uploadedSourceId: z.string().min(1).nullable().default(null),
      })
      .strict(),
    publisherLabel: z.string().min(1).nullable().default(null),
  })
  .strict();

/** Workspace MCP catalog entry. */
export const McpEntryRecordSchema = z
  .object({
    availability: z.enum(['available', 'removed']),
    currentVersionDigest: ResourceDigestSchema.nullable(),
    displayName: z.string().min(1),
    id: ResourceCatalogIdSchema,
  })
  .strict();

/** Mutable Workspace MCP binding. */
export const McpBindingRecordSchema = z
  .object({
    allowedTools: z.array(WorkspaceMcpToolNameSchema).min(1),
    approvalRequiredTools: z.array(WorkspaceMcpToolNameSchema).default([]),
    credentialBindings: z.array(WorkspaceMcpCredentialBindingSchema).default([]),
    deniedTools: z.array(WorkspaceMcpToolNameSchema).default([]),
    enabled: z.boolean(),
    entryId: ResourceCatalogIdSchema,
    packageDataKey: z.string().min(1),
    pinnedSchemaSnapshotId: z.string().min(1).nullable().default(null),
    revision: z.number().int().nonnegative(),
    schemaPolicy: z.enum(['pinned', 'tracking']),
    timeoutMs: z.number().int().positive().max(2_147_483_647).default(60_000),
  })
  .strict();

/** Immutable plugin package membership row. */
export const PluginMemberRecordSchema = z
  .object({
    catalogId: ResourceCatalogIdSchema,
    kind: z.enum(['skill', 'mcp']),
    packageKey: z.string().min(1),
    versionDigest: ResourceDigestSchema,
  })
  .strict();

/** Immutable plugin package version. */
export const PluginVersionRecordSchema = z
  .object({
    createdAt: z.string().min(1),
    digest: ResourceDigestSchema,
    digestFormat: z.literal(OPENKIT_TREE_DIGEST_FORMAT),
    entryId: ResourceCatalogIdSchema,
    members: z.array(PluginMemberRecordSchema),
    provenance: z
      .object({
        sourceCommit: z.string().min(1).nullable().default(null),
        uploadedSourceId: z.string().min(1).nullable().default(null),
      })
      .strict(),
    publisherLabel: z.string().min(1).nullable().default(null),
  })
  .strict();

/** Workspace plugin catalog entry. */
export const PluginEntryRecordSchema = z
  .object({
    availability: z.enum(['available', 'removed']),
    description: z.string().min(1).nullable().default(null),
    displayName: z.string().min(1),
    id: ResourceCatalogIdSchema,
  })
  .strict();

/** Current Workspace installation of one plugin version. */
export const PluginInstallationRecordSchema = z
  .object({
    memberOverrides: z.array(PluginMemberRecordSchema).default([]),
    pluginId: ResourceCatalogIdSchema,
    selectedPackageKeys: z.array(z.string().min(1)),
    versionDigest: ResourceDigestSchema,
  })
  .strict();

/** One owner-scope catalog document. */
export const ResourceCatalogDocumentSchema = z
  .object({
    mcp: z
      .object({
        bindings: z.array(McpBindingRecordSchema).default([]),
        entries: z.array(McpEntryRecordSchema).default([]),
        versions: z.array(McpConfigVersionRecordSchema).default([]),
      })
      .strict(),
    plugins: z
      .object({
        entries: z.array(PluginEntryRecordSchema).default([]),
        installations: z.array(PluginInstallationRecordSchema).default([]),
        versions: z.array(PluginVersionRecordSchema).default([]),
      })
      .strict(),
    revision: z.number().int().nonnegative(),
    schemaVersion: z.literal(1),
    skills: z
      .object({
        candidates: z.array(SkillCandidateRecordSchema).default([]),
        entries: z.array(SkillEntryRecordSchema).default([]),
        pins: z.array(SkillPinRecordSchema).default([]),
        versions: z.array(SkillVersionRecordSchema).default([]),
      })
      .strict(),
  })
  .strict();

/** Empty catalog used when a scope has never published resources. */
export const EMPTY_RESOURCE_CATALOG = ResourceCatalogDocumentSchema.parse({
  mcp: { bindings: [], entries: [], versions: [] },
  plugins: { entries: [], installations: [], versions: [] },
  revision: 0,
  schemaVersion: 1,
  skills: { candidates: [], entries: [], pins: [], versions: [] },
});

/** Required feature gating the portable Skill/MCP/plugin catalog projection. */
export const AGENT_RESOURCE_CATALOG_FEATURE = 'agent.resource-catalog.v1' as const;

/** One retained Skill tree file in a portable payload. */
export const PortableCatalogTreeFileSchema = z
  .object({
    contentBase64: z.string().optional(),
    executable: z.boolean().optional(),
    kind: z.enum(['directory', 'file']),
    path: z.string().min(1),
  })
  .strict();

/** Historical Skill entry without a live default or pin. */
export const PortableSkillEntrySchema = z
  .object({
    availability: z.enum(['available', 'removed']),
    description: z.string().min(1).nullable(),
    displayName: z.string().min(1),
    id: ResourceCatalogIdSchema,
    sourceCurrentDigest: ResourceDigestSchema.nullable(),
  })
  .strict();

/** MCP version metadata that cannot reconstruct a runnable declaration. */
export const PortableMcpVersionSchema = z
  .object({
    contentUnavailable: z.literal(true),
    createdAt: z.string().min(1),
    digest: ResourceDigestSchema,
    digestFormat: z.literal('openkit-mcp-config-v1'),
    entryId: ResourceCatalogIdSchema,
    pluginVersionDigest: ResourceDigestSchema.nullable(),
    provenance: z
      .object({
        pluginMemberKey: z.string().min(1).nullable(),
        sourceCommit: z.string().min(1).nullable(),
        uploadedSourceId: z.string().min(1).nullable(),
      })
      .strict(),
    publisherLabel: z.string().min(1).nullable(),
  })
  .strict();

/** Strict whitelist projection of one Workspace resource catalog. */
export const PortableAgentResourceCatalogSchema = z
  .object({
    mcp: z
      .object({
        entries: z.array(McpEntryRecordSchema.omit({ currentVersionDigest: true })),
        versions: z.array(PortableMcpVersionSchema),
      })
      .strict(),
    plugins: z
      .object({
        entries: z.array(PluginEntryRecordSchema),
        versions: z.array(PluginVersionRecordSchema),
      })
      .strict(),
    schemaVersion: z.literal(1),
    skills: z
      .object({
        candidates: z.array(SkillCandidateRecordSchema),
        entries: z.array(PortableSkillEntrySchema),
        pins: z.array(SkillPinRecordSchema),
        versions: z.array(SkillVersionRecordSchema),
      })
      .strict(),
  })
  .strict();

/** One retained Skill tree keyed by catalog identity. */
export const PortableSkillPayloadSchema = z
  .object({
    digest: ResourceDigestSchema,
    entryId: ResourceCatalogIdSchema,
    tree: z.array(PortableCatalogTreeFileSchema).min(1),
  })
  .strict();

/** Parsed resource catalog document. */
export type ResourceCatalogDocument = z.infer<typeof ResourceCatalogDocumentSchema>;
/** Parsed Skill entry. */
export type SkillEntryRecord = z.infer<typeof SkillEntryRecordSchema>;
/** Parsed Skill version. */
export type SkillVersionRecord = z.infer<typeof SkillVersionRecordSchema>;
/** Parsed Skill candidate. */
export type SkillCandidateRecord = z.infer<typeof SkillCandidateRecordSchema>;
/** Parsed catalog producer. */
export type CatalogProducer = z.infer<typeof CatalogProducerSchema>;
/** Parsed MCP transport declaration. */
export type McpValidatedDeclaration = z.infer<typeof McpValidatedDeclarationSchema>;
/** Parsed MCP configuration version. */
export type McpConfigVersionRecord = z.infer<typeof McpConfigVersionRecordSchema>;
/** Parsed MCP binding. */
export type McpBindingRecord = z.infer<typeof McpBindingRecordSchema>;
/** Parsed plugin version. */
export type PluginVersionRecord = z.infer<typeof PluginVersionRecordSchema>;
/** Parsed plugin installation. */
export type PluginInstallationRecord = z.infer<typeof PluginInstallationRecordSchema>;
/** Parsed portable catalog projection. */
export type PortableAgentResourceCatalog = z.infer<typeof PortableAgentResourceCatalogSchema>;
/** Parsed retained Skill payload. */
export type PortableSkillPayload = z.infer<typeof PortableSkillPayloadSchema>;
/** Parsed portable Skill tree file. */
export type PortableCatalogTreeFile = z.infer<typeof PortableCatalogTreeFileSchema>;

/** Parses one scope catalog document. */
export function parseResourceCatalogDocument(input: unknown): ResourceCatalogDocument {
  return ResourceCatalogDocumentSchema.parse(input);
}

/** Parses one portable Workspace catalog projection. */
export function parsePortableAgentResourceCatalog(input: unknown): PortableAgentResourceCatalog {
  return PortableAgentResourceCatalogSchema.parse(input);
}

/** Parses one retained Skill payload. */
export function parsePortableSkillPayload(input: unknown): PortableSkillPayload {
  return PortableSkillPayloadSchema.parse(input);
}
