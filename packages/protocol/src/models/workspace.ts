import { z } from 'zod';

import { WorkspaceIdSchema } from '../common/ids.js';
import { TimestampSchema } from '../common/timestamps.js';
import { AgentSchema } from './agent.js';
import { KnowledgeEntrySchema, ModelRefSchema, SkillRefSchema } from './knowledge.js';

/**
 * Product-visible workspace kind.
 */
export const WorkspaceKindSchema = z.enum([
  'code',
  'content',
  'personal-ops',
  'research',
  'operations',
  'general',
  'quick-chat',
]);

/**
 * Aggregate counts exposed on workspace list/detail payloads.
 */
export const WorkspaceCountsSchema = z.object({
  threadCount: z.number().int().nonnegative(),
  artifactCount: z.number().int().nonnegative(),
  knowledgeEntryCount: z.number().int().nonnegative(),
});

/**
 * Lineage recorded when a workspace was imported from an export manifest.
 */
export const WorkspaceImportedFromSchema = z.object({
  sourceDeploymentId: z.string().min(1),
  sourceWorkspaceId: WorkspaceIdSchema,
  exportCreatedAt: TimestampSchema,
  manifestDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
});

/**
 * Thin product-facing workspace record.
 */
export const WorkspaceRecordSchema = z
  .object({
    id: WorkspaceIdSchema,
    name: z.string().min(1),
    kind: WorkspaceKindSchema,
    status: z.enum(['active', 'archived']),
    counts: WorkspaceCountsSchema,
    importedFrom: WorkspaceImportedFromSchema.optional(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();

/**
 * Separately fetched workspace resources owned by a workspace.
 */
export const WorkspaceResourcesSchema = z.object({
  knowledge: z.array(KnowledgeEntrySchema),
  skills: z.array(SkillRefSchema),
  agents: z.array(AgentSchema),
  models: z.array(ModelRefSchema),
});

/**
 * Summary form for workspace listings.
 */
export const WorkspaceSummarySchema = WorkspaceRecordSchema;
