import { sql } from 'drizzle-orm';
import {
  check,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

/** Decisions owned by one exact Artifact version Review. */
export type ArtifactReviewDecision =
  | 'accepted'
  | 'needs_refinement'
  | 'redo'
  | 'rejected'
  | 'deferred';

/** Immutable version-keyed Artifact Review history and first-writer decisions. */
export const artifactReviews = sqliteTable(
  'artifact_reviews',
  {
    /** Workspace that owns the reviewed Artifact. */
    workspaceId: text('workspace_id').notNull(),
    /** Deterministic identity for this exact Artifact version Review. */
    reviewId: text('review_id').notNull(),
    /** Reviewed Artifact identity. */
    artifactId: text('artifact_id').notNull(),
    /** Exact immutable Artifact version under review. */
    artifactVersion: integer('artifact_version').notNull(),
    /** SHA-256 digest of the reviewed canonical Artifact bytes. */
    contentDigest: text('content_digest').notNull(),
    /** Source Thread captured when this version became reviewable. */
    sourceThreadId: text('source_thread_id'),
    /** Source Turn captured when this version became reviewable. */
    sourceTurnId: text('source_turn_id'),
    /** Source Agent captured when this version became reviewable. */
    sourceAgentId: text('source_agent_id'),
    /** Proposed Material identity, or null when this is not a Material proposal. */
    proposalMaterialId: text('proposal_material_id'),
    /** Exact proposed Material base revision. */
    proposalBaseRevisionId: text('proposal_base_revision_id'),
    /** Exact verified digest of the proposed Material base revision. */
    proposalBaseContentDigest: text('proposal_base_content_digest'),
    /** First accepted Review decision. */
    decision: text('decision').$type<ArtifactReviewDecision>(),
    /** Authenticated actor that won the decision compare-and-set. */
    decisionActorId: text('decision_actor_id'),
    /** Request proof retained only by the authority owner. */
    decisionRequestId: text('decision_request_id'),
    /** Optional non-empty reviewer feedback. */
    feedback: text('feedback'),
    /** ISO timestamp shared by every decision effect. */
    decidedAt: text('decided_at'),
    /** Deterministic follow-up Turn reserved by refinement or redo. */
    followUpTurnId: text('follow_up_turn_id'),
    /** Immutable Material revision created by an accepted proposal. */
    appliedMaterialRevisionId: text('applied_material_revision_id'),
    /** ISO timestamp for Review creation. */
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.artifactId, table.artifactVersion] }),
    uniqueIndex('artifact_reviews_identity_idx').on(table.workspaceId, table.reviewId),
    check(
      'artifact_reviews_review_id_check',
      sql`length(${table.reviewId}) = 29 AND substr(${table.reviewId}, 1, 5) = 'arev_' AND substr(${table.reviewId}, 6) NOT GLOB '*[^0-9a-f]*'`
    ),
    check(
      'artifact_reviews_version_check',
      sql`typeof(${table.artifactVersion}) = 'integer' AND ${table.artifactVersion} > 0`
    ),
    check(
      'artifact_reviews_content_digest_check',
      sql`length(${table.contentDigest}) = 71 AND substr(${table.contentDigest}, 1, 7) = 'sha256:' AND substr(${table.contentDigest}, 8) NOT GLOB '*[^0-9a-f]*'`
    ),
    check(
      'artifact_reviews_proposal_tuple_check',
      sql`(${table.proposalMaterialId} IS NULL AND ${table.proposalBaseRevisionId} IS NULL AND ${table.proposalBaseContentDigest} IS NULL) OR (${table.proposalMaterialId} IS NOT NULL AND ${table.proposalBaseRevisionId} IS NOT NULL AND ${table.proposalBaseContentDigest} IS NOT NULL)`
    ),
    check(
      'artifact_reviews_proposal_digest_check',
      sql`${table.proposalBaseContentDigest} IS NULL OR (length(${table.proposalBaseContentDigest}) = 71 AND substr(${table.proposalBaseContentDigest}, 1, 7) = 'sha256:' AND substr(${table.proposalBaseContentDigest}, 8) NOT GLOB '*[^0-9a-f]*')`
    ),
    check(
      'artifact_reviews_feedback_check',
      sql`${table.feedback} IS NULL OR length(${table.feedback}) > 0`
    ),
    check(
      'artifact_reviews_decision_check',
      sql`(
        ${table.decision} IS NULL
        AND ${table.decisionActorId} IS NULL
        AND ${table.decisionRequestId} IS NULL
        AND ${table.feedback} IS NULL
        AND ${table.decidedAt} IS NULL
        AND ${table.followUpTurnId} IS NULL
        AND ${table.appliedMaterialRevisionId} IS NULL
      ) OR (
        ${table.decision} IN ('accepted', 'needs_refinement', 'redo', 'rejected', 'deferred')
        AND ${table.decisionActorId} IS NOT NULL
        AND ${table.decisionRequestId} IS NOT NULL
        AND length(${table.decisionRequestId}) > 0
        AND ${table.decidedAt} IS NOT NULL
        AND (
          (${table.decision} IN ('needs_refinement', 'redo') AND ${table.feedback} IS NOT NULL AND ${table.followUpTurnId} IS NOT NULL AND ${table.appliedMaterialRevisionId} IS NULL)
          OR (${table.decision} = 'accepted' AND ${table.followUpTurnId} IS NULL AND ((${table.proposalMaterialId} IS NULL AND ${table.appliedMaterialRevisionId} IS NULL) OR (${table.proposalMaterialId} IS NOT NULL AND ${table.appliedMaterialRevisionId} IS NOT NULL)))
          OR (${table.decision} IN ('rejected', 'deferred') AND ${table.followUpTurnId} IS NULL AND ${table.appliedMaterialRevisionId} IS NULL)
        )
      )`
    ),
  ]
);
