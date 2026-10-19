/** Policy candidate validation reads this metadata without loading native execution or composition. */
import { createHash } from 'node:crypto';
import {
  AdmitExternalTriggerRequestSchema,
  assertOperationNames,
  EXTERNAL_TRIGGER_OPERATION_DEFINITIONS,
  KNOWLEDGE_OPERATION_DEFINITIONS,
  KnowledgeAskRequestSchema,
  KnowledgeTellRequestSchema,
  operationToolName,
} from '@openkit/app-api-schemas';
import type { AgentEnvironmentPackage } from '@openkit/config-schema';
import {
  ArtifactMediaTypeSchema,
  MaterialIdSchema,
  RequestIdSchema,
  UserInputQuestionSchema,
} from '@openkit/protocol';
import { z } from 'zod';

/** Reserved built-in Worker MCP server supplied to every worker AgentSession. */
export const OPENKIT_WORK_MCP_ID = 'openkit-work';

/** Non-secret question arguments validated before Pending publication. */
export const WorkRequestInputArgsSchema = z
  .object({
    requestId: RequestIdSchema,
    prompt: z.string().min(1),
    questions: z.array(UserInputQuestionSchema).min(1),
  })
  .strip();

/** Bounded model metadata; scope, digest, bytes and physical target remain trusted. */
export const WorkSubmitArtifactArgsSchema = z
  .object({
    requestId: z
      .string()
      .min(1)
      .max(128)
      .refine((value) => !value.startsWith('import-lineage:'), {
        message: 'requestId uses reserved imported-history proof',
      }),
    path: z.string().min(1).max(4096),
    kind: z.enum(['report', 'diff', 'file', 'summary']),
    title: z.string().min(1),
    mediaType: ArtifactMediaTypeSchema,
    materialProposal: z
      .object({
        materialId: MaterialIdSchema,
        baseRevisionId: z.string().min(1),
        baseContentDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
      })
      .strict()
      .optional(),
  })
  .strip();

/** Selected-package source ranges with representation-bound cursors. */
export const WorkReadSourceArgsSchema = z
  .object({
    path: z.string().min(1).max(4096),
    mode: z.enum(['preview', 'read']).default('preview'),
    cursor: z
      .object({
        version: z.literal(1),
        mode: z.literal('read'),
        binding: z.string().regex(/^sha256:[a-f0-9]{64}$/),
        range: z
          .object({
            start: z.number().int().nonnegative().safe(),
            end: z.number().int().nonnegative().safe(),
          })
          .strip(),
      })
      .strip()
      .optional(),
  })
  .strip()
  .refine((args) => !args.cursor || args.mode === 'read');

/** Bounded search within one selected source representation. */
export const WorkSearchSourceArgsSchema = z
  .object({
    path: z.string().min(1).max(4096),
    mode: z.enum(['lexical', 'exact', 'regex']).default('lexical'),
    query: z.string().min(1).max(4096),
    limit: z.number().int().min(1).max(20).default(10),
  })
  .strip();

const WorkListPeersArgsSchema = z.object({}).strip();
/** One selected image or PDF page, with bounded optional crop. */
export const WorkViewSourceArgsSchema = z
  .object({
    path: z.string().min(1).max(4096),
    page: z.number().int().positive().safe().optional(),
    crop: z
      .object({
        left: z.number().int().nonnegative().safe(),
        top: z.number().int().nonnegative().safe(),
        width: z.number().int().positive().safe(),
        height: z.number().int().positive().safe(),
      })
      .strip()
      .optional(),
  })
  .strip();
/** Opaque current-Turn peer handle with bounded history pagination. */
export const WorkReadPeerArgsSchema = z
  .object({
    handle: z.string().min(1),
    cursor: z
      .string()
      .regex(/^(0|[1-9]\d*)$/)
      .default('0'),
    limit: z.number().int().min(1).max(50).default(20),
  })
  .strip();

function mcpInputSchema(schema: z.ZodType): Record<string, unknown> {
  const projection = z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input' }) as Record<
    string,
    unknown
  >;
  delete projection.$schema;
  return projection;
}

/** Canonical built-in Work contracts; their schemas ignore inert additive input members. */
export const OPENKIT_WORK_TOOL_DEFINITIONS = [
  {
    name: 'automation.event-admit',
    description: EXTERNAL_TRIGGER_OPERATION_DEFINITIONS['automation.event-admit'].description,
    inputSchema: mcpInputSchema(
      AdmitExternalTriggerRequestSchema.omit({ workspaceId: true, threadId: true, turnId: true })
    ),
  },
  ...(['knowledge.ask', 'knowledge.tell'] as const).map((id) => ({
    name: id,
    description: KNOWLEDGE_OPERATION_DEFINITIONS[id].description,
    inputSchema: mcpInputSchema(
      id === 'knowledge.ask'
        ? KnowledgeAskRequestSchema.omit({ workspaceId: true })
        : KnowledgeTellRequestSchema.omit({ workspaceId: true, requestId: true })
    ),
  })),
  {
    name: 'work.input.request',
    description:
      'Ask the responsible user one or more non-secret questions. The answer arrives on a later Turn. Recording the question is the result of this call.',
    inputSchema: mcpInputSchema(WorkRequestInputArgsSchema),
  },
  {
    name: 'work.peer.list',
    description:
      'List other AgentSessions currently in your Sandbox through opaque handles valid only within this Turn. Thread metadata requires current read access.',
    inputSchema: mcpInputSchema(WorkListPeersArgsSchema),
  },
  {
    name: 'work.peer.read',
    description:
      'Read recent product Turns and Items for one current peer. Results are newest first; use nextCursor for older records. This does not control or change the peer.',
    inputSchema: mcpInputSchema(WorkReadPeerArgsSchema),
  },
  {
    name: 'work.source.read',
    description:
      'Preview or read one selected source or Knowledge page from this Turn Context Package. Use its exact sourceFiles or knowledgeSelections packagePath as path. Knowledge reads stay pinned to the selected Notebook commit and current source access. Preview is at most 2048 UTF-8 bytes or 50 lines; read is at most 51200 bytes or 2000 lines, also bounded by the complete result envelope. Continue with mode read and the returned cursor. EOF describes the named representation only; PDF coverage may be incomplete. No host path or unselected source is accepted.',
    inputSchema: mcpInputSchema(WorkReadSourceArgsSchema),
  },
  {
    name: 'work.source.search',
    description:
      'Search one retained PDF text representation selected by its exact source inventory packagePath. Use lexical, exact or line-bounded regex mode. At most 20 bounded snippets return original identity, representation digest, processor and page coordinates. Partial text-layer coverage cannot prove absence in images or unprocessed pages. No unselected source or host path is accepted.',
    inputSchema: mcpInputSchema(WorkSearchSourceArgsSchema),
  },
  {
    name: 'work.source.view',
    description:
      'View one selected PNG/JPEG image or one explicitly selected PDF page as a bounded JPEG. Use the exact source inventory packagePath. PDF requires a one-based page; image inputs must omit page. Optional crop uses integer original-image pixels or rotated selected-page raster pixels at 72 dpi. Result text identifies the original, page, crop, processor and delivered JPEG digest; the image is a standard MCP image block. Current access is checked again before disclosure. No host path, URL or unselected source is accepted.',
    inputSchema: mcpInputSchema(WorkViewSourceArgsSchema),
  },
  {
    name: 'work.artifact.submit',
    description:
      'Submit one finished file from an eligible output root. Finish writing first. Success returns the durable Artifact id; correction or a new file version uses a new requestId. Read the eligible roots in this package guidance. Any file media type and exact binary bytes are admitted up to 1,000,000,000 bytes per file. Material proposals separately require their supported UTF-8 text format.',
    inputSchema: mcpInputSchema(WorkSubmitArtifactArgsSchema),
  },
] as const;

assertOperationNames(OPENKIT_WORK_TOOL_DEFINITIONS.map((tool) => tool.name));

/** MCP names are one mechanical projection of the canonical Work contracts. */
export const OPENKIT_WORK_TOOLS = OPENKIT_WORK_TOOL_DEFINITIONS.map((tool) => ({
  ...tool,
  name: operationToolName(tool.name),
}));

/** Digest binds selected supply to the exact built-in tool schema. */
export const OPENKIT_WORK_CATALOG_DIGEST = `sha256:${createHash('sha256').update(JSON.stringify(OPENKIT_WORK_TOOLS)).digest('hex')}`;

/** Returns the supply entry appended to every worker package. */
export function createOpenkitWorkMcpSupply(): AgentEnvironmentPackage['supply']['mcpServers'][number] {
  return {
    id: OPENKIT_WORK_MCP_ID,
    catalogDigest: OPENKIT_WORK_CATALOG_DIGEST,
    allowedTools: OPENKIT_WORK_TOOLS.map((tool) => tool.name),
    schemaPolicy: 'pinned',
    pinnedSchemaSnapshotId: null,
  };
}
