import { z } from 'zod';

import { ArtifactIdSchema, RequestIdSchema, WorkspaceIdSchema } from '../common/ids.js';
import { ArtifactSchema } from '../models/artifact.js';

/**
 * List artifacts with cursor pagination.
 */
export const ListArtifactsRequestSchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.number().int().positive().max(100).optional(),
});

/**
 * Paginated list-artifacts response.
 */
export const ListArtifactsResponseSchema = z.object({
  items: z.array(ArtifactSchema),
  nextCursor: z.string().min(1).nullable().optional(),
});

/**
 * Bare artifact detail response.
 */
export const GetArtifactResponseSchema = ArtifactSchema;

/**
 * Update artifact metadata payload.
 */
export const UpdateArtifactMetadataRequestSchema = z.object({
  requestId: RequestIdSchema,
  workspaceId: WorkspaceIdSchema,
  artifactId: ArtifactIdSchema,
  title: z.string().min(1).optional(),
  status: ArtifactSchema.shape.status.optional(),
  summary: z.string().nullable().optional(),
});
