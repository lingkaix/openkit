import { RequestIdSchema } from '@openkit/protocol';
import { z } from 'zod';

const CATALOG_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;

/** One submitted catalog tree file or directory. */
export const CatalogTreeFileSchema = z
  .object({
    contentBase64: z.string().optional(),
    executable: z.boolean().optional(),
    kind: z.enum(['directory', 'file']),
    path: z.string().min(1),
  })
  .strict();

/** Redacted Skill entry shown to ordinary catalog readers. */
export const SkillCatalogEntrySchema = z
  .object({
    availability: z.enum(['available', 'removed']),
    currentDigest: z.string().regex(SHA256).nullable(),
    description: z.string().nullable(),
    displayName: z.string().min(1),
    id: z.string().regex(CATALOG_ID),
  })
  .strict();

/** Skill row on the Workspace catalog summary, including pin and version history. */
export const WorkspaceCatalogSkillSummarySchema = SkillCatalogEntrySchema.extend({
  pinDigest: z.string().regex(SHA256).nullable(),
  versions: z.array(
    z
      .object({
        createdAt: z.string().min(1),
        digest: z.string().regex(SHA256),
      })
      .strict()
  ),
}).strict();

/** Redacted Skill version metadata. */
export const SkillCatalogVersionSchema = z
  .object({
    createdAt: z.string().min(1),
    digest: z.string().regex(SHA256),
    digestFormat: z.literal('openkit-tree-v1'),
    entryId: z.string().regex(CATALOG_ID),
    inventory: z.array(
      z
        .object({
          executable: z.boolean(),
          kind: z.enum(['directory', 'file']),
          path: z.string().min(1),
          sha256: z.string().regex(SHA256).nullable(),
          size: z.number().int().nonnegative(),
        })
        .strict()
    ),
    publisherVersion: z.string().nullable(),
  })
  .strict();

/** Redacted Skill candidate. */
export const SkillCatalogCandidateSchema = z
  .object({
    baseDigest: z.string().regex(SHA256).nullable(),
    candidateDigest: z.string().regex(SHA256),
    createdAt: z.string().min(1),
    disposition: z.enum(['proposed', 'withdrawn', 'rejected', 'promoted']),
    entryId: z.string().regex(CATALOG_ID),
    id: z.string().min(1),
    summary: z.string().min(1),
  })
  .strict();

/** Redacted MCP entry. */
export const McpCatalogEntrySchema = z
  .object({
    availability: z.enum(['available', 'removed']),
    bindingRevision: z.number().int().nonnegative(),
    currentVersionDigest: z.string().regex(SHA256).nullable(),
    displayName: z.string().min(1),
    enabled: z.boolean(),
    id: z.string().regex(CATALOG_ID),
    allowedTools: z.array(z.string().min(1)),
    approvalRequiredTools: z.array(z.string().min(1)),
    deniedTools: z.array(z.string().min(1)),
    schemaPolicy: z.enum(['pinned', 'tracking']).nullable(),
    timeoutMs: z.number().int().positive().nullable(),
    transportKind: z.enum(['stdio', 'http']).nullable(),
    versions: z.array(
      z
        .object({
          createdAt: z.string().min(1),
          digest: z.string().regex(SHA256),
          transportKind: z.enum(['stdio', 'http']).nullable(),
        })
        .strict()
    ),
  })
  .strict();

/** Redacted plugin entry. */
export const PluginCatalogEntrySchema = z
  .object({
    availability: z.enum(['available', 'removed']),
    description: z.string().nullable(),
    displayName: z.string().min(1),
    id: z.string().regex(CATALOG_ID),
    installedVersionDigest: z.string().regex(SHA256).nullable(),
    memberCount: z.number().int().nonnegative(),
  })
  .strict();

/** Workspace catalog overview. */
export const WorkspaceCatalogSummarySchema = z
  .object({
    candidates: z.array(SkillCatalogCandidateSchema),
    mcp: z.array(McpCatalogEntrySchema),
    plugins: z.array(PluginCatalogEntrySchema),
    revision: z.number().int().nonnegative(),
    skills: z.array(WorkspaceCatalogSkillSummarySchema),
  })
  .strict();

/** List Skills response. */
export const ListSkillCatalogResponseSchema = z.object({ items: z.array(SkillCatalogEntrySchema) });
/** List MCP response. */
export const ListMcpCatalogResponseSchema = z.object({ items: z.array(McpCatalogEntrySchema) });
/** List plugin response. */
export const ListPluginCatalogResponseSchema = z.object({
  items: z.array(PluginCatalogEntrySchema),
});
/** Catalog summary response. */
export const GetWorkspaceCatalogResponseSchema = WorkspaceCatalogSummarySchema;

/** Create or import a Skill. */
export const ImportSkillRequestSchema = z
  .object({
    activate: z.boolean().default(true),
    displayName: z.string().min(1),
    expectedRevision: z.number().int().nonnegative(),
    id: z.string().regex(CATALOG_ID).optional(),
    requestId: RequestIdSchema,
    tree: z.array(CatalogTreeFileSchema).min(1),
  })
  .strict();

/** Skill import response. */
export const ImportSkillResponseSchema = z
  .object({
    entry: SkillCatalogEntrySchema,
    revision: z.number().int().nonnegative(),
    version: SkillCatalogVersionSchema,
  })
  .strict();

/** Submit a Skill candidate. */
export const SubmitSkillCandidateRequestSchema = z
  .object({
    baseDigest: z.string().regex(SHA256).nullable(),
    expectedRevision: z.number().int().nonnegative(),
    requestId: RequestIdSchema,
    summary: z.string().min(1).max(4_096),
    tree: z.array(CatalogTreeFileSchema).min(1),
  })
  .strict();

/** Candidate mutation response. */
export const SkillCandidateResponseSchema = z
  .object({
    candidate: SkillCatalogCandidateSchema,
    revision: z.number().int().nonnegative(),
  })
  .strict();

/** Promote, reject, or withdraw a candidate. */
export const DecideSkillCandidateRequestSchema = z
  .object({
    decision: z.enum(['promoted', 'rejected', 'withdrawn']),
    expectedRevision: z.number().int().nonnegative(),
    requestId: RequestIdSchema,
  })
  .strict();

/** Select current Skill digest or pin. */
export const SelectSkillVersionRequestSchema = z
  .object({
    digest: z.string().regex(SHA256).nullable(),
    expectedRevision: z.number().int().nonnegative(),
    requestId: RequestIdSchema,
  })
  .strict();

/** Catalog revision response. */
export const CatalogMutationResponseSchema = z
  .object({
    revision: z.number().int().nonnegative(),
  })
  .strict();

/** Create an inactive MCP configuration. */
export const CreateMcpConfigRequestSchema = z
  .object({
    allowedTools: z.array(z.string().min(1)).min(1),
    declaration: z.unknown(),
    displayName: z.string().min(1),
    expectedRevision: z.number().int().nonnegative(),
    id: z.string().regex(CATALOG_ID).optional(),
    requestId: RequestIdSchema,
  })
  .strict();

/** MCP create response. */
export const CreateMcpConfigResponseSchema = z
  .object({
    entry: McpCatalogEntrySchema,
    revision: z.number().int().nonnegative(),
    versionDigest: z.string().regex(SHA256),
  })
  .strict();

/** Select an MCP configuration version. */
export const SelectMcpVersionRequestSchema = z
  .object({
    digest: z.string().regex(SHA256),
    expectedRevision: z.number().int().nonnegative(),
    requestId: RequestIdSchema,
  })
  .strict();

/** Update an MCP binding. */
export const UpdateMcpBindingRequestSchema = z
  .object({
    allowedTools: z.array(z.string().min(1)).min(1),
    approvalRequiredTools: z.array(z.string().min(1)).default([]),
    bindingRevision: z.number().int().nonnegative(),
    deniedTools: z.array(z.string().min(1)).default([]),
    enabled: z.boolean(),
    expectedRevision: z.number().int().nonnegative(),
    requestId: RequestIdSchema,
    schemaPolicy: z.enum(['pinned', 'tracking']),
    timeoutMs: z.number().int().positive().max(2_147_483_647).default(60_000),
  })
  .strict();

/** Import a plugin from an uploaded tree of files. */
export const ImportPluginRequestSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    install: z.boolean().default(true),
    requestId: RequestIdSchema,
    selectedPackageKeys: z.array(z.string().min(1)).optional(),
    tree: z.array(CatalogTreeFileSchema).min(1),
  })
  .strict();

/** Plugin import response. */
export const ImportPluginResponseSchema = z
  .object({
    entry: PluginCatalogEntrySchema,
    revision: z.number().int().nonnegative(),
    versionDigest: z.string().regex(SHA256),
  })
  .strict();

/** Get workspace catalog response. */
export type GetWorkspaceCatalogResponse = z.infer<typeof GetWorkspaceCatalogResponseSchema>;
/** Import skill request. */
export type ImportSkillRequest = z.infer<typeof ImportSkillRequestSchema>;
/** Import skill response. */
export type ImportSkillResponse = z.infer<typeof ImportSkillResponseSchema>;
/** Submit skill candidate request. */
export type SubmitSkillCandidateRequest = z.infer<typeof SubmitSkillCandidateRequestSchema>;
/** Skill candidate mutation response. */
export type SkillCandidateResponse = z.infer<typeof SkillCandidateResponseSchema>;
/** Decide skill candidate request. */
export type DecideSkillCandidateRequest = z.infer<typeof DecideSkillCandidateRequestSchema>;
/** Select skill version request. */
export type SelectSkillVersionRequest = z.infer<typeof SelectSkillVersionRequestSchema>;
/** Catalog revision response. */
export type CatalogMutationResponse = z.infer<typeof CatalogMutationResponseSchema>;
/** Create MCP config request. */
export type CreateMcpConfigRequest = z.infer<typeof CreateMcpConfigRequestSchema>;
/** Create MCP config response. */
export type CreateMcpConfigResponse = z.infer<typeof CreateMcpConfigResponseSchema>;
/** Select MCP version request. */
export type SelectMcpVersionRequest = z.infer<typeof SelectMcpVersionRequestSchema>;
/** Update MCP binding request. */
export type UpdateMcpBindingRequest = z.infer<typeof UpdateMcpBindingRequestSchema>;
/** Import plugin request. */
export type ImportPluginRequest = z.infer<typeof ImportPluginRequestSchema>;
/** Import plugin response. */
export type ImportPluginResponse = z.infer<typeof ImportPluginResponseSchema>;
/** List skill catalog response. */
export type ListSkillCatalogResponse = z.infer<typeof ListSkillCatalogResponseSchema>;
/** List MCP catalog response. */
export type ListMcpCatalogResponse = z.infer<typeof ListMcpCatalogResponseSchema>;
/** List plugin catalog response. */
export type ListPluginCatalogResponse = z.infer<typeof ListPluginCatalogResponseSchema>;
