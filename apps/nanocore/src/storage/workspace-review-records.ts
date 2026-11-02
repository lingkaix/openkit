import { createHash } from 'node:crypto';
import {
  StagedWorkspaceReviewReaderSchema,
  StagedWorkspaceReviewSchema,
  type StagedWorkspaceReviewStatus,
  type WorkspaceChangeSet,
  WorkspaceChangeSetReaderSchema,
  type WorkspaceSyncReviewItem,
  WorkspaceSyncReviewItemSchema,
  WorkspaceSyncReviewPatchPayloadSchema,
  workspaceSyncReviewPatchBytes,
} from '@openkit/app-api-schemas';
import { type ActorRef, type AuditEvent, readRetainedV1 } from '@openkit/protocol';
import { z } from 'zod';
import { recordWorkspaceAuditEvent } from '../audit-events.js';
import { StoreRecordNotFoundError } from '../lib/store-errors.js';
import { OperationError } from '../operation-error-core.js';
import type { WorkspaceDb } from './db.js';
import {
  type ControlWorkspaceReviewDecision,
  WorkspaceReviewDecisionRefusal,
} from './workspace-review-codecs.js';

/** Durable workspace synchronization review decision persistence input. */
export interface UpdateWorkspaceSyncReviewDecisionInput {
  /** Actual command actor when supplied by the current command owner. */
  readonly actor?: ActorRef;
  /** Existing non-secret authentication facts when the command has a public requester. */
  readonly authentication?: AuditEvent['authentication'];
  /** Workspace that owns the staged review. */
  readonly workspaceId: string;
  /** Staged review id to resolve. */
  readonly reviewId: string;
  /** Terminal status selected by the human reviewer. */
  readonly status: Exclude<StagedWorkspaceReviewStatus, 'pending'>;
  /** Idempotent command request associated with the decision. */
  readonly requestId: string;
  /** Decision timestamp. */
  readonly updatedAt: string;
}

export interface WorkspaceChangeSetRow {
  readonly schemaVersion: unknown;
  readonly change_set_id: string;
  readonly workspace_id: string;
  readonly input_snapshot_id: string;
  readonly materialization_record_id: string;
  readonly resource_id: string;
  readonly strategy: string;
  readonly payload_json: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface StagedWorkspaceReviewRow {
  readonly schemaVersion: unknown;
  readonly review_id: string;
  readonly workspace_id: string;
  readonly change_set_id: string;
  readonly artifact_id: string;
  readonly status: string;
  readonly payload_json: string;
  readonly patch_payload_json: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

/**
 * Parses one workspace review item and enforces its cross-record integrity.
 *
 * @param item Candidate joined review item.
 * @param pendingOnly Whether the caller accepts only newly staged pending reviews.
 * @returns Parsed review item with verified lineage and patch bytes.
 * @throws ZodError when retained status, lineage, or patch integrity is invalid.
 */
export function parseWorkspaceSyncReviewItem(
  item: WorkspaceSyncReviewItem,
  pendingOnly: boolean
): WorkspaceSyncReviewItem {
  const parsed = WorkspaceSyncReviewItemSchema.parse(item);
  const { changeSet, patchPayload, review } = parsed;
  if (pendingOnly && review.status !== 'pending') {
    throw new z.ZodError([
      {
        code: 'custom',
        message: `Workspace synchronization review is not pending: ${review.id}`,
        path: [],
      },
    ]);
  }
  if (review.workspaceId !== changeSet.workspaceId || review.changeSetId !== changeSet.id) {
    throw new z.ZodError([
      {
        code: 'custom',
        message: `Workspace synchronization review lineage mismatch: ${review.id}`,
        path: [],
      },
    ]);
  }
  if (Boolean(changeSet.patch) !== Boolean(patchPayload)) {
    throw new z.ZodError([
      {
        code: 'custom',
        message: `Workspace synchronization review patch conflict: ${review.id}`,
        path: [],
      },
    ]);
  }
  if (changeSet.patch && patchPayload) {
    const raw = workspaceSyncReviewPatchBytes(patchPayload);
    const digest = `sha256:${createHash('sha256').update(raw).digest('hex')}`;
    const bytes = raw.length;
    if (
      changeSet.patch.digest !== patchPayload.digest ||
      changeSet.patch.bytes !== patchPayload.bytes ||
      patchPayload.digest !== digest ||
      patchPayload.bytes !== bytes
    ) {
      throw new z.ZodError([
        {
          code: 'custom',
          message: `Workspace synchronization review patch integrity conflict: ${review.id}`,
          path: [],
        },
      ]);
    }
  }
  return parsed;
}

/**
 * Lists durable staged workspace reviews for one workspace.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param workspaceId Workspace id.
 * @returns Stored workspace review items in stable newest-first order.
 */
export function listWorkspaceSyncReviews(
  workspaceDb: Pick<WorkspaceDb, 'sqlite'>,
  workspaceId: string
): WorkspaceSyncReviewItem[] {
  return (
    workspaceDb.sqlite
      .prepare(
        `SELECT
        schema_version AS schemaVersion,
          review_id,
          workspace_id,
          change_set_id,
          artifact_id,
          status,
          payload_json,
          patch_payload_json,
          created_at,
          updated_at
        FROM staged_workspace_reviews
        WHERE workspace_id = ?
        ORDER BY updated_at ASC, review_id ASC`
      )
      .all(workspaceId) as StagedWorkspaceReviewRow[]
  )
    .map((row) => mapWorkspaceReviewRow(workspaceDb, row))
    .reverse();
}

/**
 * Reads one durable staged workspace review.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param workspaceId Workspace id.
 * @param reviewId Staged review id.
 * @returns Stored workspace review item, or null.
 */
export function getWorkspaceSyncReview(
  workspaceDb: Pick<WorkspaceDb, 'sqlite'>,
  workspaceId: string,
  reviewId: string
): WorkspaceSyncReviewItem | null {
  const row = workspaceDb.sqlite
    .prepare(
      `SELECT
        schema_version AS schemaVersion,
        review_id,
        workspace_id,
        change_set_id,
        artifact_id,
        status,
        payload_json,
        patch_payload_json,
        created_at,
        updated_at
      FROM staged_workspace_reviews
      WHERE workspace_id = ? AND review_id = ?`
    )
    .get(workspaceId, reviewId) as StagedWorkspaceReviewRow | undefined;

  return row ? mapWorkspaceReviewRow(workspaceDb, row) : null;
}

/**
 * Records one durable staged workspace review decision.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param input Review decision persistence input.
 * @returns Updated public workspace review item.
 * @throws StoreRecordNotFoundError for a missing review or OperationError for a terminal review.
 */
export function updateWorkspaceSyncReviewDecision(
  workspaceDb: WorkspaceDb,
  input: UpdateWorkspaceSyncReviewDecisionInput
): WorkspaceSyncReviewItem {
  const item = requireWorkspaceSyncReview(workspaceDb, input.workspaceId, input.reviewId);

  if (item.review.status !== 'pending') {
    throw new OperationError(
      'workspace_sync_review_failed',
      `Workspace synchronization review is already resolved: ${input.reviewId}`,
      404
    );
  }

  // Preserve the validated owner's original nested observations when only decision facts change.
  const retainedReview = workspaceDb.sqlite
    .prepare(
      'SELECT schema_version AS schemaVersion, payload_json FROM staged_workspace_reviews WHERE workspace_id = ? AND review_id = ?'
    )
    .get(input.workspaceId, input.reviewId) as { schemaVersion: unknown; payload_json: string };
  const review = StagedWorkspaceReviewSchema.parse({
    ...item.review,
    status: input.status,
    updatedAt: input.updatedAt,
  });

  workspaceDb.sqlite
    .prepare(
      `UPDATE staged_workspace_reviews
       SET status = ?, payload_json = ?, updated_at = ?
      WHERE workspace_id = ? AND review_id = ?`
    )
    .run(
      review.status,
      JSON.stringify({
        ...readRetainedV1(retainedReview, () => JSON.parse(retainedReview.payload_json)),
        status: review.status,
        updatedAt: review.updatedAt,
      }),
      review.updatedAt,
      input.workspaceId,
      input.reviewId
    );

  recordWorkspaceAuditEvent({
    action: 'workspace.review.decide',
    actor: input.actor ?? null,
    ...(input.authentication ? { authentication: input.authentication } : {}),
    category: 'artifact',
    now: new Date(input.updatedAt),
    outcome: 'succeeded',
    requestId: input.requestId,
    resource: `workspace-review:${review.id}`,
    severity: 'info',
    summary: `Workspace review ${review.id} resolved as ${review.status}.`,
    workspaceDb,
    workspaceId: review.workspaceId,
  });

  return requireWorkspaceSyncReview(workspaceDb, input.workspaceId, input.reviewId);
}

/**
 * Reads one durable workspace review item or throws.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param workspaceId Workspace id.
 * @param reviewId Review id.
 * @returns Stored workspace review item.
 * @throws Error when the review does not exist.
 */
export function requireWorkspaceSyncReview(
  workspaceDb: Pick<WorkspaceDb, 'sqlite'>,
  workspaceId: string,
  reviewId: string
): WorkspaceSyncReviewItem {
  const item = getWorkspaceSyncReview(workspaceDb, workspaceId, reviewId);

  if (!item) {
    throw new StoreRecordNotFoundError(
      `Workspace synchronization review not found: ${workspaceId}/${reviewId}`
    );
  }

  return item;
}

/**
 * Maps one staged review row to the public joined item.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param row Staged workspace review row.
 * @returns Public joined review item.
 */
export function mapWorkspaceReviewRow(
  workspaceDb: Pick<WorkspaceDb, 'sqlite'>,
  row: StagedWorkspaceReviewRow
): WorkspaceSyncReviewItem {
  const review = StagedWorkspaceReviewReaderSchema.parse(
    readRetainedV1(row, () => JSON.parse(row.payload_json)) as unknown
  );
  const changeSet = requireWorkspaceChangeSet(workspaceDb, row.workspace_id, review.changeSetId);
  const patchPayload = row.patch_payload_json
    ? WorkspaceSyncReviewPatchPayloadSchema.parse(JSON.parse(row.patch_payload_json) as unknown)
    : null;

  return parseWorkspaceSyncReviewItem(
    {
      artifactId: row.artifact_id,
      changeSet,
      patchPayload,
      review,
    },
    false
  );
}

/**
 * Reads one durable change set or throws.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param workspaceId Workspace id.
 * @param changeSetId Change set id.
 * @returns Stored change set.
 * @throws Error when the change set does not exist.
 */
export function requireWorkspaceChangeSet(
  workspaceDb: Pick<WorkspaceDb, 'sqlite'>,
  workspaceId: string,
  changeSetId: string
): WorkspaceChangeSet {
  const row = workspaceDb.sqlite
    .prepare(
      `SELECT
        schema_version AS schemaVersion,
        change_set_id,
        workspace_id,
        input_snapshot_id,
        materialization_record_id,
        resource_id,
        strategy,
        payload_json,
        created_at,
        updated_at
      FROM workspace_change_sets
      WHERE workspace_id = ? AND change_set_id = ?`
    )
    .get(workspaceId, changeSetId) as WorkspaceChangeSetRow | undefined;

  if (!row) {
    throw new StoreRecordNotFoundError(
      `Workspace change set not found: ${workspaceId}/${changeSetId}`
    );
  }

  return WorkspaceChangeSetReaderSchema.parse(
    readRetainedV1(row, () => JSON.parse(row.payload_json)) as unknown
  );
}

/** Runs the original complete nonaccepted Review/Audit tuple inside the existing native savepoint. */
export function applyWorkspaceReviewDecisionInDb(
  workspaceDb: WorkspaceDb,
  input: ControlWorkspaceReviewDecision
): WorkspaceSyncReviewItem {
  try {
    return updateWorkspaceSyncReviewDecision(workspaceDb, {
      workspaceId: input.workspaceId,
      reviewId: input.reviewId,
      status: input.status,
      requestId: input.requestId,
      updatedAt: input.updatedAt,
      ...(input.actor === undefined ? {} : { actor: input.actor }),
      ...(input.authentication === undefined ? {} : { authentication: input.authentication }),
    });
  } catch (error) {
    if (error instanceof StoreRecordNotFoundError) {
      if (
        error.message ===
        `Workspace synchronization review not found: ${input.workspaceId}/${input.reviewId}`
      )
        throw new WorkspaceReviewDecisionRefusal('review_absent');
      if (error.message.startsWith(`Workspace change set not found: ${input.workspaceId}/`))
        throw new WorkspaceReviewDecisionRefusal('change_set_absent');
    }
    if (
      error instanceof OperationError &&
      error.code === 'workspace_sync_review_failed' &&
      error.status === 404 &&
      error.message === `Workspace synchronization review is already resolved: ${input.reviewId}`
    )
      throw new WorkspaceReviewDecisionRefusal('resolved');
    if (error instanceof TypeError && error.message === 'Unsupported retained record format.')
      throw new WorkspaceReviewDecisionRefusal('unsupported_retained_format');
    throw error;
  }
}
