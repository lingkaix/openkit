import { WorkspaceMcpCredentialBindingSchema } from '@openkit/config-schema/mcp-credentials';
import { RequestIdSchema } from '@openkit/protocol';
import { z } from 'zod';

const CATALOG_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;

/** Authenticated actor retained in Skill version and decision lineage. */
export const SkillCatalogProducerSchema = z
  .object({ id: z.string().min(1), kind: z.enum(['user', 'agent', 'system']) })
  .strict();

/** Exact source facts of the first admission of immutable Skill bytes. */
export const SkillCatalogProvenanceSchema = z
  .object({
    baseDigest: z.string().regex(SHA256).nullable(),
    pluginMemberKey: z.string().min(1).nullable(),
    pluginVersionDigest: z.string().regex(SHA256).nullable(),
    sourceCommit: z.string().min(1).nullable(),
    sourceLocator: z.string().min(1).max(8192).optional(),
    sourceSubpath: z.string().min(1).nullable(),
    uploadedSourceId: z.string().min(1).nullable(),
  })
  .strict();

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
        contentState: z.enum(['retained', 'purged']),
        createdAt: z.string().min(1),
        digest: z.string().regex(SHA256),
      })
      .strict()
  ),
}).strict();

/** Redacted Skill version metadata. */
export const SkillCatalogVersionSchema = z
  .object({
    contentState: z.enum(['retained', 'purged']),
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
    producer: SkillCatalogProducerSchema,
    provenance: SkillCatalogProvenanceSchema,
    publisherVersion: z.string().nullable(),
  })
  .strict();

/** Redacted Skill candidate. */
export const SkillCatalogCandidateSchema = z
  .object({
    baseDigest: z.string().regex(SHA256).nullable(),
    candidateDigest: z.string().regex(SHA256),
    createdAt: z.string().min(1),
    decision: z
      .object({
        actor: SkillCatalogProducerSchema,
        auditRef: z.string().min(1),
        decidedAt: z.string().min(1),
      })
      .strict()
      .nullable(),
    disposition: z.enum(['proposed', 'withdrawn', 'rejected', 'promoted']),
    entryId: z.string().regex(CATALOG_ID),
    id: z.string().min(1),
    producer: SkillCatalogProducerSchema,
    submitter: SkillCatalogProducerSchema.nullable(),
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
/** Exact version history with immutable provenance. */
export const ListSkillVersionsResponseSchema = z
  .object({ items: z.array(SkillCatalogVersionSchema) })
  .strict();
/** One retained version, including historical removed versions. */
export const ReadSkillVersionResponseSchema = z
  .object({ version: SkillCatalogVersionSchema })
  .strict();
/** One exact digest-verified file; byte encoding does not infer text. */
export const ReadSkillContentResponseSchema = z
  .object({
    contentBase64: z.string(),
    digest: z.string().regex(SHA256),
    entryId: z.string().regex(CATALOG_ID),
    path: z.string().min(1),
  })
  .strict();
/** Exact inventory differences for two verified retained versions. */
export const DiffSkillVersionsResponseSchema = z
  .object({
    baseDigest: z.string().regex(SHA256),
    candidateDigest: z.string().regex(SHA256),
    changes: z.array(
      z
        .object({
          after: SkillCatalogVersionSchema.shape.inventory.element.nullable(),
          before: SkillCatalogVersionSchema.shape.inventory.element.nullable(),
          path: z.string().min(1),
        })
        .strict()
    ),
    entryId: z.string().regex(CATALOG_ID),
  })
  .strict();
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
    tree: z.array(CatalogTreeFileSchema).min(1).optional(),
    source: z.string().min(1).max(8192).optional(),
    sourceSubpath: z.string().min(1).max(4096).optional(),
    sourceSkillName: z.string().min(1).max(256).optional(),
  })
  .strict()
  .refine((input) => (input.tree === undefined) !== (input.source === undefined), {
    message: 'Supply exactly one uploaded tree or ecosystem source.',
  })
  .refine(
    (input) =>
      input.source !== undefined ||
      (input.sourceSubpath === undefined && input.sourceSkillName === undefined),
    {
      message: 'Source selectors require an ecosystem source.',
    }
  );

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
    expectedCurrentDigest: z.string().regex(SHA256).nullable(),
    expectedRevision: z.number().int().nonnegative(),
    requestId: RequestIdSchema,
  })
  .strict();

/** Select current Skill digest or pin. */
export const SelectSkillVersionRequestSchema = z
  .object({
    digest: z.string().regex(SHA256).nullable(),
    expectedCurrentDigest: z.string().regex(SHA256).nullable(),
    expectedRevision: z.number().int().nonnegative(),
    requestId: RequestIdSchema,
  })
  .strict();

/** Compare-and-set mutation of an exact Workspace Skill pin. */
export const SetSkillPinRequestSchema = z
  .object({
    digest: z.string().regex(SHA256).nullable(),
    expectedPinDigest: z.string().regex(SHA256).nullable(),
    expectedRevision: z.number().int().nonnegative(),
    requestId: RequestIdSchema,
  })
  .strict();

/** Revision-protected Skill removal or explicit payload purge. */
export const RemoveSkillRequestSchema = z
  .object({
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

/** Update an MCP binding; omitted credentials preserve the current bindings and a supplied array replaces them. */
export const UpdateMcpBindingRequestSchema = z
  .object({
    allowedTools: z.array(z.string().min(1)).min(1),
    approvalRequiredTools: z.array(z.string().min(1)).default([]),
    bindingRevision: z.number().int().nonnegative(),
    credentialBindings: z.array(WorkspaceMcpCredentialBindingSchema).optional(),
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
