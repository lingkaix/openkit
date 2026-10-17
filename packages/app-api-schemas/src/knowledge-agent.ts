import { KnowledgeMaintenanceOutcomeSchema, KnowledgeSourceIdSchema, RequestIdSchema, ThreadIdSchema, TurnIdSchema, WorkspaceIdSchema } from '@openkit/protocol';
import { z } from 'zod';
import { KnowledgeNotebookPathSchema } from './knowledge-notebook.js';

/** A question carries no scope or authority beyond its native Workspace admission. */
export const KnowledgeAskRequestSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  question: z.string().min(1).max(65_536),
}).strict();

/** Exact read evidence; page revisions and captured Source digests remain distinct identities. */
export const KnowledgeAgentCitationSchema = z.object({
  reference: z.string().min(1),
  revision: z.string().min(1),
  contentDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  sourceReferences: z.array(z.string().min(1)),
}).strict();

/** Delivered model answer and its separate Knowledge Manager work lineage. */
export const KnowledgeAskResponseSchema = z.object({
  threadId: ThreadIdSchema,
  turnId: TurnIdSchema,
  answer: z.string().min(1),
  citations: z.array(KnowledgeAgentCitationSchema),
  uncertainty: z.string().min(1).nullable(),
}).strict();

/** Explicit information capture starts one bounded maintenance run, never an automatic publication grant. */
export const KnowledgeTellRequestSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  requestId: RequestIdSchema,
  content: z.string().min(1).max(65_536),
  sources: z.array(z.string().min(1)).max(256).default([]),
}).strict();

/** An explicit maintenance request uses the same bounded run as the daily trigger. */
export const KnowledgeMaintainRequestSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  requestId: RequestIdSchema,
  instruction: z.string().min(1).max(65_536),
  pageIds: z.array(z.string().refine((id) => KnowledgeNotebookPathSchema.safeParse(`${id}.md`).success)).min(1).max(256)
    .refine((ids) => new Set(ids).size === ids.length, 'Page IDs must be unique.').optional(),
  sourceIds: z.array(KnowledgeSourceIdSchema).min(1).max(256)
    .refine((ids) => new Set(ids).size === ids.length, 'Source IDs must be unique.').optional(),
}).strict();

/** The Turn and notebook candidate remain the sole work and review records. */
export const KnowledgeMaintenanceResponseSchema = KnowledgeMaintenanceOutcomeSchema;
