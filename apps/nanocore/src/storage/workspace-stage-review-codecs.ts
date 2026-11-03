import { WorkspaceSyncReviewItemSchema } from '@openkit/app-api-schemas';
import { AuditEventSchema, TimestampSchema, WorkspaceIdSchema } from '@openkit/protocol';
import { z } from 'zod';
import type { FilesystemSnapshotManifest } from '../runtime/filesystem-workspace-sync.js';
import { StoredFilesystemSnapshotManifestV1Schema } from '../runtime/workspace-filesystem-staging.js';

/** Exact physical staging facts; validation preserves original manifest byte ordering and annotations. */
const StagingInputSchema = z
  .object({
    workspaceId: WorkspaceIdSchema,
    reviewId: z.string().min(1),
    changeSetId: z.string().min(1),
    stagingRootPath: z.string().min(1),
    targetRootPath: z.string().min(1),
    createdAt: TimestampSchema,
    before: z.custom<FilesystemSnapshotManifest>(
      (value) => StoredFilesystemSnapshotManifestV1Schema.safeParse(value).success
    ),
  })
  .strict();
/** Exact original StageReview tuple, never an authority decision, SQL or callback. */
export const ControlWorkspaceStageReviewSchema = z
  .object({
    workspaceId: WorkspaceIdSchema,
    staging: StagingInputSchema.nullable(),
    review: z
      .object({
        item: WorkspaceSyncReviewItemSchema,
        producer: AuditEventSchema.pick({
          actor: true,
          agentId: true,
          agentSessionId: true,
          requestId: true,
          threadId: true,
          turnId: true,
        })
          .strict()
          .optional(),
      })
      .strict()
      .nullable(),
  })
  .strict()
  .refine(
    (input) =>
      (input.staging !== null || input.review !== null) &&
      (input.staging === null || input.staging.workspaceId === input.workspaceId) &&
      (input.review === null || input.review.item.review.workspaceId === input.workspaceId) &&
      (input.staging === null ||
        input.review === null ||
        (input.staging.reviewId === input.review.item.review.id &&
          input.staging.changeSetId === input.review.item.changeSet.id))
  );
/** Existing six-family stage, with optional original physical/Git branches. */
export type ControlWorkspaceStageReview = z.infer<typeof ControlWorkspaceStageReviewSchema>;

/** Closed original domain diagnostics; arbitrary filesystem and SQL errors remain redacted. */
const prefixes = {
  input_missing: 'Workspace synchronization input lineage is missing',
  materialization_missing: 'Workspace synchronization materialization lineage is missing',
  lineage_conflict: 'Workspace synchronization lineage conflict',
  review_conflict: 'Workspace synchronization review replay conflict',
  manifest_conflict: 'Worker output manifest replay conflict',
  changeset_conflict: 'Workspace change set replay conflict',
  staging_conflict: 'Filesystem workspace staging replay conflict',
  staging_missing: 'Filesystem workspace staging root was not recorded',
} as const;
/** Exact owned refusal constructed only from the original domain facts. */
export class WorkspaceStageReviewRefusal extends Error {
  constructor(
    readonly code: keyof typeof prefixes,
    readonly recordId: string
  ) {
    super(`${prefixes[code]}: ${recordId}`);
  }
}
/** Closed non-secret transport representation of an original StageReview refusal. */
export const ControlWorkspaceStageReviewRefusalSchema = z
  .object({
    operation: z.literal('workspace-stage-review'),
    code: z.enum([
      'input_missing',
      'materialization_missing',
      'lineage_conflict',
      'review_conflict',
      'manifest_conflict',
      'changeset_conflict',
      'staging_conflict',
      'staging_missing',
    ]),
    recordId: z.string().min(1),
    message: z.string(),
    status: z.literal(409),
  })
  .strict()
  .refine((value) => value.message === `${prefixes[value.code]}: ${value.recordId}`);

/** Recognizes only exact original messages bound to this typed command's record identities. */
export function stageReviewRefusal(
  input: ControlWorkspaceStageReview,
  error: unknown
): WorkspaceStageReviewRefusal | null {
  if (!(error instanceof Error)) return null;
  const item = input.review?.item;
  const ids: Partial<Record<keyof typeof prefixes, string>> = {
    ...(item
      ? {
          input_missing: item.changeSet.inputSnapshotId,
          materialization_missing: item.changeSet.materializationRecordId,
          lineage_conflict: item.changeSet.id,
          review_conflict: item.review.id,
          manifest_conflict: `wom_${item.changeSet.id}`,
          changeset_conflict: item.changeSet.id,
        }
      : {}),
    ...(input.staging
      ? { staging_conflict: input.staging.reviewId, staging_missing: input.staging.reviewId }
      : {}),
  };
  for (const [code, id] of Object.entries(ids) as [keyof typeof prefixes, string][]) {
    const refusal = new WorkspaceStageReviewRefusal(code, id);
    if (error.message === refusal.message) return refusal;
  }
  return null;
}
