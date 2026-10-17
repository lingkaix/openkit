import { WorkspaceIdSchema } from '@openkit/protocol';
import { z } from 'zod';
import { KnowledgeManagerDraftedProposalSchema } from './knowledge-manager.js';
import { KnowledgeNotebookPathSchema } from './knowledge-notebook.js';

/** Maximum exact UTF-16 text per version in one Proposal preview response. */
export const KNOWLEDGE_PROPOSAL_PREVIEW_CHUNK_UNITS = 4096;
/** Strict serialized UTF-8 response bound, including inventory and identity metadata. */
export const KNOWLEDGE_PROPOSAL_PREVIEW_RESPONSE_BYTES = 64 * 1024;

/** Addresses one saved Proposal; offset starts at zero and counts Unicode code points in both versions. */
export const ReadKnowledgeProposalRequestSchema = z
  .object({
    workspaceId: WorkspaceIdSchema,
    proposalId: KnowledgeManagerDraftedProposalSchema.shape.id,
    path: KnowledgeNotebookPathSchema.optional(),
    offset: z.number().int().nonnegative().safe().default(0),
  })
  .strict()
  .refine(({ path, offset }) => path !== undefined || offset === 0, 'An offset requires a path.');

/** Every inventory and chunk repeats the immutable tuple required by human Review. */
export const ReadKnowledgeProposalResponseSchema = z
  .object({
    proposalId: KnowledgeManagerDraftedProposalSchema.shape.id,
    proposalDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    baseRevision: z.string().min(1),
    candidateRevision: z.string().min(1),
    paths: z.array(KnowledgeNotebookPathSchema).min(1).max(256),
    path: KnowledgeNotebookPathSchema.optional(),
    before: z.string().max(KNOWLEDGE_PROPOSAL_PREVIEW_CHUNK_UNITS).nullable().optional(),
    after: z.string().max(KNOWLEDGE_PROPOSAL_PREVIEW_CHUNK_UNITS).nullable().optional(),
    nextOffset: z.number().int().positive().safe().nullable().optional(),
  })
  .strict()
  .refine(
    ({ path, paths, before, after, nextOffset }) =>
      new Set(paths).size === paths.length &&
      (path === undefined
        ? before === undefined && after === undefined && nextOffset === undefined
        : paths.includes(path) &&
          before !== undefined &&
          after !== undefined &&
          nextOffset !== undefined),
    'A chunk requires an inventoried path, both versions and a completion cursor.'
  )
  .refine(
    (value) =>
      new TextEncoder().encode(JSON.stringify(value)).length <
      KNOWLEDGE_PROPOSAL_PREVIEW_RESPONSE_BYTES,
    'Proposal preview exceeds its serialized response bound.'
  );

/** Parsed exact Proposal selector and shared Unicode code-point offset. */
export type ReadKnowledgeProposalRequest = z.infer<typeof ReadKnowledgeProposalRequestSchema>;
/** Bounded exact preview; null versions are absent paths and empty text is past that version's end. */
export type ReadKnowledgeProposalResponse = z.infer<typeof ReadKnowledgeProposalResponseSchema>;
