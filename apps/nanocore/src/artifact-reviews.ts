import { createHash } from 'node:crypto';

import {
  type ArtifactMaterialProposal,
  ArtifactMaterialProposalSchema,
  type ArtifactReviewView,
  ArtifactReviewViewSchema,
  SubmitArtifactReviewDecisionRequestSchema,
  type SubmitArtifactReviewDecisionResponse,
} from '@openkit/app-api-schemas';
import { z } from 'zod';

import type { WorkspaceDb } from './storage/db.js';
import type { artifactReviews } from './storage/schema/artifact-reviews.js';
import {
  getWorkspaceMaterial,
  getWorkspaceMaterialRevision,
  saveWorkspaceMaterialRevision,
} from './workspace-materials.js';

/** Closed Artifact Review decision values. */
type ArtifactReviewDecision = NonNullable<ArtifactReviewView['decision']>;

/** Text-compatible media types accepted by the Stage 4 Review authority. */
export type ArtifactReviewMediaType = 'text/markdown' | 'text/plain' | 'application/json';

/** Closed worker request used only by an accepted Artifact Review refinement or redo. */
export const ArtifactReviewFollowUpRequestSchema = z
  .object({
    kind: z.literal('artifact-review-follow-up'),
    workspaceId: z.string().min(1),
    reviewId: z.string().min(1),
    artifactId: z.string().min(1),
    artifactVersion: z.number().int().positive(),
    contentDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    artifactContent: z.string().min(1),
    artifactMediaType: z.enum(['text/markdown', 'text/plain', 'application/json']),
    sourceThreadId: z.string().min(1),
    sourceTurnId: z.string().min(1),
    sourceAgentId: z.string().min(1),
    materialProposal: ArtifactMaterialProposalSchema.nullable(),
    decision: z.enum(['needs_refinement', 'redo']),
    feedback: z.string().min(1),
    decisionRequestId: z.string().min(1),
    workerRequestId: z.string().min(1),
  })
  .strict()
  .superRefine((request, context) => {
    const digest = `sha256:${createHash('sha256').update(request.artifactContent).digest('hex')}`;
    if (request.contentDigest !== digest) {
      context.addIssue({
        code: 'custom',
        message: 'Artifact Review follow-up content digest is contradictory.',
        path: ['artifactContent'],
      });
    }
  });

/** Exact worker request carried by an Artifact Review follow-up Turn. */
export type ArtifactReviewFollowUpRequest = z.infer<typeof ArtifactReviewFollowUpRequestSchema>;

/**
 * Serializes one validated Artifact Review follow-up request.
 *
 * @param request Exact Review, Artifact, source, feedback, and request lineage.
 * @returns Compact JSON accepted by the worker Context Package boundary.
 * @throws z.ZodError when the request is incomplete or contradictory.
 */
export function serializeArtifactReviewFollowUpRequest(
  request: ArtifactReviewFollowUpRequest
): string {
  return JSON.stringify(ArtifactReviewFollowUpRequestSchema.parse(request));
}

/** Closed structural failures raised by the Artifact Review authority. */
export type ArtifactReviewErrorCode =
  | 'conflict'
  | 'idempotency_key_conflict'
  | 'invalid_request'
  | 'recovery_required'
  | 'stale';

/** Immutable input captured when one Artifact version becomes reviewable. */
export interface CreateArtifactReviewInput {
  /** Exact Artifact identity. */
  readonly artifactId: string;
  /** Exact positive Artifact version. */
  readonly artifactVersion: number;
  /** SHA-256 digest of the canonical Artifact content. */
  readonly contentDigest: string;
  /** Source Thread, when present. */
  readonly sourceThreadId: string | null;
  /** Source Turn, when present. */
  readonly sourceTurnId: string | null;
  /** Source Agent, when present. */
  readonly sourceAgentId: string | null;
  /** Explicit verified Material proposal tuple, or null. */
  readonly materialProposal: ArtifactMaterialProposal | null;
  /** ISO timestamp when the Artifact version became reviewable. */
  readonly createdAt: string;
}

/** Canonical command identity used to validate one completed decision replay. */
export interface ReplayArtifactReviewDecisionInput {
  /** Authenticated decision actor. */
  readonly actorId: string;
  /** Exact Artifact identity. */
  readonly artifactId: string;
  /** Exact Artifact version. */
  readonly artifactVersion: number;
  /** Requested decision. */
  readonly decision: ArtifactReviewDecision;
  /** Optional non-empty feedback normalized to null when absent. */
  readonly feedback: string | null;
  /** Caller command identity. */
  readonly requestId: string;
}

/** Accepted command and current Artifact content proof for one fresh decision attempt. */
export interface DecideArtifactReviewInput extends ReplayArtifactReviewDecisionInput {
  /** Exact current canonical Artifact content. */
  readonly artifactContent: string;
  /** Media type mapped from the current Artifact content format. */
  readonly artifactMediaType: ArtifactReviewMediaType;
  /** Timestamp captured by the first-writer decision attempt. */
  readonly decidedAt: string;
}

/** Raw Artifact Review authority row including private request proof. */
type ArtifactReviewRow = typeof artifactReviews.$inferSelect;

/** Portable Review owner retaining private decision request lineage. */
export type ExportableArtifactReview = ArtifactReviewView & {
  /** Historical request proof excluded from public Review views. */
  readonly decisionRequestId: string | null;
};

const REVIEW_SELECT = `SELECT
  workspace_id AS workspaceId, review_id AS reviewId, artifact_id AS artifactId,
  artifact_version AS artifactVersion, content_digest AS contentDigest,
  source_thread_id AS sourceThreadId, source_turn_id AS sourceTurnId,
  source_agent_id AS sourceAgentId, proposal_material_id AS proposalMaterialId,
  proposal_base_revision_id AS proposalBaseRevisionId,
  proposal_base_content_digest AS proposalBaseContentDigest,
  decision, decision_actor_id AS decisionActorId,
  decision_request_id AS decisionRequestId, feedback, decided_at AS decidedAt,
  follow_up_turn_id AS followUpTurnId,
  applied_material_revision_id AS appliedMaterialRevisionId, created_at AS createdAt
FROM artifact_reviews`;

/**
 * Creates or verifies the immutable owner for one exact Artifact version.
 *
 * @param workspaceDb Workspace database that owns the Review.
 * @param input Verified immutable Artifact and proposal facts.
 * @returns Current closed Review view.
 * @throws ArtifactReviewError when input or existing authority is contradictory.
 */
export function createArtifactReview(
  workspaceDb: WorkspaceDb,
  input: CreateArtifactReviewInput
): ArtifactReviewView {
  const reviewId = deriveArtifactReviewId(
    workspaceDb.workspaceId,
    input.artifactId,
    input.artifactVersion
  );
  const unresolved = parseInputView(workspaceDb.workspaceId, reviewId, input);

  return workspaceDb.sqlite.transaction(() => {
    const existing = findReview(workspaceDb, input.artifactId, input.artifactVersion);
    if (existing) {
      assertStoredReview(workspaceDb, existing);
      assertImmutableReview(existing, unresolved);
      return toView(existing);
    }
    if (findReviewById(workspaceDb, reviewId)) {
      throw reviewError('recovery_required', 'The deterministic Review id is already occupied.');
    }
    if (input.materialProposal) {
      requireProposalAuthority(workspaceDb, input.materialProposal);
    }

    workspaceDb.sqlite
      .prepare(`INSERT INTO artifact_reviews (
        workspace_id, review_id, artifact_id, artifact_version, content_digest,
        source_thread_id, source_turn_id, source_agent_id,
        proposal_material_id, proposal_base_revision_id, proposal_base_content_digest,
        decision, decision_actor_id, decision_request_id, feedback, decided_at,
        follow_up_turn_id, applied_material_revision_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?)`)
      .run(
        workspaceDb.workspaceId,
        reviewId,
        input.artifactId,
        input.artifactVersion,
        input.contentDigest,
        input.sourceThreadId,
        input.sourceTurnId,
        input.sourceAgentId,
        input.materialProposal?.materialId ?? null,
        input.materialProposal?.baseRevisionId ?? null,
        input.materialProposal?.baseContentDigest ?? null,
        input.createdAt
      );

    return toView(requireReview(workspaceDb, input.artifactId, input.artifactVersion));
  })();
}

/**
 * Lists one Workspace's Review history by ascending Artifact version.
 *
 * @param workspaceDb Workspace database that owns the Reviews.
 * @returns Closed Review views in stable order.
 * @throws ArtifactReviewError when any stored row is contradictory.
 */
export function listArtifactReviews(workspaceDb: WorkspaceDb): ArtifactReviewView[] {
  return (
    workspaceDb.sqlite
      .prepare(
        `${REVIEW_SELECT} WHERE workspace_id = ? ORDER BY artifact_version, artifact_id, review_id`
      )
      .all(workspaceDb.workspaceId) as ArtifactReviewRow[]
  ).map((row) => {
    assertStoredReview(workspaceDb, row);
    return toView(row);
  });
}

/** Lists raw portable Review owners in stable identity order. @param workspaceDb Workspace database. @returns Private export rows retaining decision request proof. */
export function listExportableArtifactReviews(
  workspaceDb: WorkspaceDb
): readonly ExportableArtifactReview[] {
  const rows = workspaceDb.sqlite
    .prepare(`${REVIEW_SELECT} WHERE workspace_id = ? ORDER BY artifact_id, artifact_version`)
    .all(workspaceDb.workspaceId) as ArtifactReviewRow[];
  rows.forEach((row) => {
    assertStoredReview(workspaceDb, row);
  });
  return rows.map((row) => ({ ...toView(row), decisionRequestId: row.decisionRequestId }));
}

/**
 * Reads one exact version-keyed Review.
 *
 * @param workspaceDb Workspace database that owns the Review.
 * @param artifactId Exact Artifact identity.
 * @param artifactVersion Exact Artifact version.
 * @returns Closed Review view.
 * @throws ArtifactReviewError when the Review is absent or contradictory.
 */
export function getArtifactReview(
  workspaceDb: WorkspaceDb,
  artifactId: string,
  artifactVersion: number
): ArtifactReviewView {
  const row = requireReview(workspaceDb, artifactId, artifactVersion);
  assertStoredReview(workspaceDb, row);
  return toView(row);
}

/**
 * Claims one first-writer decision and atomically applies an accepted Material proposal.
 *
 * The caller must wrap SQLite-only decisions in the existing Workspace receipt transaction.
 * Refinement and redo commit only their deterministic claim for later Turn and admission proof.
 *
 * @param workspaceDb Workspace database that owns the Review and any Material proposal.
 * @param input Accepted decision command and current Artifact content proof.
 * @returns Stable decision identity.
 * @throws ArtifactReviewError for stale, conflicting, invalid, or contradictory authority.
 */
export function decideArtifactReview(
  workspaceDb: WorkspaceDb,
  input: DecideArtifactReviewInput
): SubmitArtifactReviewDecisionResponse {
  assertFreshDecisionInput(input);

  return workspaceDb.sqlite.transaction(() => {
    const row = requireReview(workspaceDb, input.artifactId, input.artifactVersion);
    assertStoredReview(workspaceDb, row);
    assertArtifactContent(row, input.artifactContent);

    if (row.decision !== null) {
      if (row.decisionRequestId !== input.requestId) {
        throw reviewError('stale', 'The Artifact Review already has a decision.');
      }
      assertDecisionInputMatches(row, input);
      if (row.decision !== 'needs_refinement' && row.decision !== 'redo') {
        throw reviewError(
          'recovery_required',
          'The completed Review decision has no command receipt.'
        );
      }
      return toDecisionResponse(workspaceDb, row);
    }

    const proposal = materialProposal(row);
    if (proposal) {
      requireProposalAuthority(workspaceDb, proposal);
    }

    if (input.decision === 'accepted' && proposal) {
      return applyAcceptedProposal(workspaceDb, row, proposal, input);
    }

    if (input.decision === 'needs_refinement' || input.decision === 'redo') {
      if (!row.sourceThreadId || !row.sourceTurnId || !row.sourceAgentId) {
        throw reviewError('recovery_required', 'The Review source lineage is incomplete.');
      }
      if (proposal) {
        requireCurrentProposalBase(workspaceDb, proposal, input.artifactMediaType);
      }
      const followUpTurnId = deriveArtifactReviewFollowUpTurnId(
        workspaceDb.workspaceId,
        row.artifactId,
        row.artifactVersion,
        input.requestId
      );
      updateDecision(workspaceDb, row, input, followUpTurnId, null);
      return toDecisionResponse(
        workspaceDb,
        requireReview(workspaceDb, row.artifactId, row.artifactVersion)
      );
    }

    updateDecision(workspaceDb, row, input, null, null);
    return toDecisionResponse(
      workspaceDb,
      requireReview(workspaceDb, row.artifactId, row.artifactVersion)
    );
  })();
}

/**
 * Validates a completed receipt replay against the exact retained decision owner.
 *
 * @param workspaceDb Workspace database that owns the Review.
 * @param input Original canonical decision input and current Artifact content proof.
 * @returns Stable original decision identity.
 * @throws ArtifactReviewError when receipt input and business owner disagree.
 */
export function replayArtifactReviewDecision(
  workspaceDb: WorkspaceDb,
  input: ReplayArtifactReviewDecisionInput
): SubmitArtifactReviewDecisionResponse {
  assertDecisionInput(input);
  const row = requireReview(workspaceDb, input.artifactId, input.artifactVersion);
  assertStoredReview(workspaceDb, row);
  if (row.decision === null || row.decisionRequestId !== input.requestId) {
    throw reviewError('recovery_required', 'The decision receipt has no matching Review owner.');
  }
  assertDecisionInputMatches(row, input);
  return toDecisionResponse(workspaceDb, row);
}

/**
 * Derives the deterministic follow-up Turn reserved by refinement or redo.
 *
 * @param workspaceId Owning Workspace.
 * @param artifactId Reviewed Artifact.
 * @param artifactVersion Reviewed Artifact version.
 * @param requestId Decision request identity.
 * @returns Stable follow-up Turn id.
 */
export function deriveArtifactReviewFollowUpTurnId(
  workspaceId: string,
  artifactId: string,
  artifactVersion: number,
  requestId: string
): string {
  return deterministicId('tu_artifact_review', [
    workspaceId,
    artifactId,
    artifactVersion,
    requestId,
  ]);
}

/**
 * Derives the UUID-shaped scheduler request owned by one Artifact Review decision.
 *
 * @param requestId Original Artifact Review decision request id.
 * @returns The original UUID or a stable UUID-shaped digest of an opaque id.
 */
export function deriveArtifactReviewWorkerRequestId(requestId: string): string {
  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)
  ) {
    return requestId;
  }
  const digest = createHash('sha256')
    .update(JSON.stringify(['artifact.review.follow_up', requestId]), 'utf8')
    .digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

/**
 * Derives the exact deterministic identity for one version-keyed Review.
 *
 * @param workspaceId Owning Workspace.
 * @param artifactId Reviewed Artifact.
 * @param artifactVersion Reviewed Artifact version.
 * @returns Stable `arev_` identity.
 */
export function deriveArtifactReviewId(
  workspaceId: string,
  artifactId: string,
  artifactVersion: number
): string {
  return deterministicId('arev', [workspaceId, artifactId, artifactVersion]);
}

/** Applies a proposal through the existing Material revision owner. @param workspaceDb Open database. @param row Review owner. @param proposal Verified proposal. @param input Decision input. @returns Decision identity. @throws A conflict or recovery error. */
function applyAcceptedProposal(
  workspaceDb: WorkspaceDb,
  row: ArtifactReviewRow,
  proposal: ArtifactMaterialProposal,
  input: DecideArtifactReviewInput
): SubmitArtifactReviewDecisionResponse {
  requireCurrentProposalBase(workspaceDb, proposal, input.artifactMediaType);
  let revisionId: string;
  try {
    revisionId = saveWorkspaceMaterialRevision(workspaceDb, {
      acceptedAt: input.decidedAt,
      actorId: input.actorId,
      content: input.artifactContent,
      contentDigest: row.contentDigest,
      expectedRevisionId: proposal.baseRevisionId,
      materialId: proposal.materialId,
      requestId: input.requestId,
    }).revisionId;
  } catch (error) {
    throw asProposalApplyError(error);
  }
  updateDecision(workspaceDb, row, input, null, revisionId);
  return toDecisionResponse(
    workspaceDb,
    requireReview(workspaceDb, row.artifactId, row.artifactVersion)
  );
}

/** Writes a decision compare-and-set. @param workspaceDb Open database. @param row Review owner. @param input Decision input. @param followUpTurnId Reserved Turn. @param appliedMaterialRevisionId Applied revision. @throws ArtifactReviewError when the first-writer claim is lost. */
function updateDecision(
  workspaceDb: WorkspaceDb,
  row: ArtifactReviewRow,
  input: DecideArtifactReviewInput,
  followUpTurnId: string | null,
  appliedMaterialRevisionId: string | null
): void {
  const updated = workspaceDb.sqlite
    .prepare(`UPDATE artifact_reviews SET
      decision = ?, decision_actor_id = ?, decision_request_id = ?, feedback = ?, decided_at = ?,
      follow_up_turn_id = ?, applied_material_revision_id = ?
      WHERE workspace_id = ? AND artifact_id = ? AND artifact_version = ? AND decision IS NULL`)
    .run(
      input.decision,
      input.actorId,
      input.requestId,
      input.feedback,
      input.decidedAt,
      followUpTurnId,
      appliedMaterialRevisionId,
      workspaceDb.workspaceId,
      row.artifactId,
      row.artifactVersion
    );
  if (updated.changes !== 1) {
    throw reviewError('stale', 'The Artifact Review decision changed concurrently.');
  }
}

/** Validates canonical input. @param input Replay command input. @throws ArtifactReviewError for invalid input. */
function assertDecisionInput(input: ReplayArtifactReviewDecisionInput): void {
  const request = SubmitArtifactReviewDecisionRequestSchema.safeParse({
    decision: input.decision,
    ...(input.feedback === null ? {} : { feedback: input.feedback }),
    requestId: input.requestId,
  });
  if (
    !input.actorId ||
    !input.artifactId ||
    !Number.isInteger(input.artifactVersion) ||
    input.artifactVersion <= 0 ||
    !request.success
  ) {
    throw reviewError('invalid_request', 'The Artifact Review decision input is invalid.');
  }
}

/** Validates fresh content proof. @param input Fresh decision input. @throws ArtifactReviewError for invalid input. */
function assertFreshDecisionInput(input: DecideArtifactReviewInput): void {
  assertDecisionInput(input);
  if (
    !input.decidedAt ||
    input.artifactContent.length === 0 ||
    !['text/markdown', 'text/plain', 'application/json'].includes(input.artifactMediaType)
  ) {
    throw reviewError('invalid_request', 'The Artifact Review decision input is invalid.');
  }
}

/** Verifies Artifact bytes. @param row Review owner. @param content Canonical content. @throws ArtifactReviewError for contradictory bytes. */
function assertArtifactContent(row: ArtifactReviewRow, content: string): void {
  if (contentDigest(content) !== row.contentDigest) {
    throw reviewError('recovery_required', 'The reviewed Artifact content is contradictory.');
  }
}

/** Verifies replay input. @param row Review owner. @param input Replay input. @throws ArtifactReviewError for changed input. */
function assertDecisionInputMatches(
  row: ArtifactReviewRow,
  input: ReplayArtifactReviewDecisionInput
): void {
  if (
    row.decision !== input.decision ||
    row.decisionActorId !== input.actorId ||
    row.feedback !== input.feedback
  ) {
    throw reviewError(
      'idempotency_key_conflict',
      'The requestId was already used for different Review input.'
    );
  }
}

/** Verifies retained results. @param workspaceDb Open database. @param row Review owner. @throws ArtifactReviewError for contradictory results. */
function assertStoredDecisionResult(workspaceDb: WorkspaceDb, row: ArtifactReviewRow): void {
  if (!row.decision || !row.decisionRequestId) {
    throw reviewError('recovery_required', 'The decided Review tuple is incomplete.');
  }
  if (row.decision === 'needs_refinement' || row.decision === 'redo') {
    if (
      !row.decisionRequestId.startsWith('import-lineage:') &&
      row.followUpTurnId !==
        deriveArtifactReviewFollowUpTurnId(
          workspaceDb.workspaceId,
          row.artifactId,
          row.artifactVersion,
          row.decisionRequestId
        )
    ) {
      throw reviewError('recovery_required', 'The Review follow-up identity is contradictory.');
    }
    return;
  }
  const proposal = materialProposal(row);
  if (row.decision === 'accepted' && proposal) {
    requireAppliedRevision(workspaceDb, row, proposal);
  }
}

/** Verifies one applied revision against its Review result proof. @param workspaceDb Open database. @param row Review owner. @param proposal Immutable proposal. @throws A recovery error for contradictory lineage. */
function requireAppliedRevision(
  workspaceDb: WorkspaceDb,
  row: ArtifactReviewRow,
  proposal: ArtifactMaterialProposal
): void {
  if (!row.appliedMaterialRevisionId || !row.decidedAt) {
    throw reviewError('recovery_required', 'The accepted proposal has no applied revision.');
  }
  try {
    const material = getWorkspaceMaterial(workspaceDb, proposal.materialId);
    const revision = getWorkspaceMaterialRevision(
      workspaceDb,
      proposal.materialId,
      row.appliedMaterialRevisionId
    );
    const privateProof = workspaceDb.sqlite
      .prepare(`SELECT created_by_request_id AS createdByRequestId
        FROM workspace_material_revisions
        WHERE workspace_id = ? AND material_id = ? AND revision_id = ?`)
      .get(workspaceDb.workspaceId, proposal.materialId, row.appliedMaterialRevisionId) as
      | { readonly createdByRequestId: string }
      | undefined;
    if (
      revision.parentRevisionId !== proposal.baseRevisionId ||
      revision.contentDigest !== row.contentDigest ||
      revision.authorId !== row.decisionActorId ||
      privateProof?.createdByRequestId !== row.decisionRequestId ||
      revision.createdAt !== row.decidedAt ||
      revision.mediaType !== (material.kind === 'markdown' ? 'text/markdown' : 'text/plain')
    ) {
      throw new Error('contradictory applied revision');
    }
  } catch {
    throw reviewError('recovery_required', 'The applied Material revision is contradictory.');
  }
}

/** Requires an intact proposal base and returns its Material owner. @param workspaceDb Open database. @param proposal Immutable proposal. @returns Material owner. @throws A recovery error for missing or contradictory authority. */
function requireProposalAuthority(workspaceDb: WorkspaceDb, proposal: ArtifactMaterialProposal) {
  try {
    const material = getWorkspaceMaterial(workspaceDb, proposal.materialId);
    const base = getWorkspaceMaterialRevision(
      workspaceDb,
      proposal.materialId,
      proposal.baseRevisionId
    );
    if (
      material.currentRevisionId === null ||
      base.contentDigest !== proposal.baseContentDigest ||
      base.mediaType !== (material.kind === 'markdown' ? 'text/markdown' : 'text/plain')
    ) {
      throw new Error('contradictory proposal base');
    }
    getWorkspaceMaterialRevision(workspaceDb, proposal.materialId, material.currentRevisionId);
    return material;
  } catch {
    throw reviewError(
      'recovery_required',
      'The Material proposal base authority is contradictory.'
    );
  }
}

/** Requires the proposal base to remain current and media-compatible. @param workspaceDb Open database. @param proposal Immutable proposal. @param artifactMediaType Current Artifact media type. @throws A conflict or recovery error. */
function requireCurrentProposalBase(
  workspaceDb: WorkspaceDb,
  proposal: ArtifactMaterialProposal,
  artifactMediaType: ArtifactReviewMediaType
): void {
  const material = requireProposalAuthority(workspaceDb, proposal);
  if (material.currentRevisionId !== proposal.baseRevisionId) {
    throw reviewError('conflict', 'The Material current revision no longer matches the proposal.');
  }
  if (artifactMediaType !== (material.kind === 'markdown' ? 'text/markdown' : 'text/plain')) {
    throw reviewError('recovery_required', 'The Artifact and Material media types disagree.');
  }
  if (
    workspaceDb.sqlite
      .prepare(`SELECT 1 FROM workspace_material_revisions
        WHERE workspace_id = ? AND material_id = ? AND parent_revision_id = ?`)
      .get(workspaceDb.workspaceId, proposal.materialId, proposal.baseRevisionId)
  ) {
    throw reviewError(
      'recovery_required',
      'The current Material base already has a child revision.'
    );
  }
}

/** Maps the existing Material owner's failures into the Review contract. @param error Material mutation failure. @returns Review failure. */
function asProposalApplyError(error: unknown): Error {
  return hasErrorCode(error, 'conflict')
    ? reviewError('conflict', 'The Material current revision changed concurrently.')
    : reviewError('recovery_required', 'The Material proposal could not be applied safely.');
}

/** Reads a Review by version. @param workspaceDb Open database. @param artifactId Artifact id. @param artifactVersion Artifact version. @returns Row or undefined. */
function findReview(
  workspaceDb: WorkspaceDb,
  artifactId: string,
  artifactVersion: number
): ArtifactReviewRow | undefined {
  return workspaceDb.sqlite
    .prepare(`${REVIEW_SELECT} WHERE workspace_id = ? AND artifact_id = ? AND artifact_version = ?`)
    .get(workspaceDb.workspaceId, artifactId, artifactVersion) as ArtifactReviewRow | undefined;
}

/** Reads a Review by id. @param workspaceDb Open database. @param reviewId Review id. @returns Row or undefined. */
function findReviewById(workspaceDb: WorkspaceDb, reviewId: string): ArtifactReviewRow | undefined {
  return workspaceDb.sqlite
    .prepare(`${REVIEW_SELECT} WHERE workspace_id = ? AND review_id = ?`)
    .get(workspaceDb.workspaceId, reviewId) as ArtifactReviewRow | undefined;
}

/** Requires a Review. @param workspaceDb Open database. @param artifactId Artifact id. @param artifactVersion Artifact version. @returns Review row. @throws ArtifactReviewError when absent. */
function requireReview(
  workspaceDb: WorkspaceDb,
  artifactId: string,
  artifactVersion: number
): ArtifactReviewRow {
  const row = findReview(workspaceDb, artifactId, artifactVersion);
  if (!row) {
    throw reviewError('stale', 'The requested Artifact Review does not exist.');
  }
  return row;
}

/** Builds an unresolved view. @param workspaceId Workspace id. @param reviewId Review id. @param input Creation input. @returns Validated view. @throws ArtifactReviewError for invalid input. */
function parseInputView(
  workspaceId: string,
  reviewId: string,
  input: CreateArtifactReviewInput
): ArtifactReviewView {
  const parsed = ArtifactReviewViewSchema.safeParse({
    workspaceId,
    reviewId,
    ...input,
    decision: null,
    decisionActorId: null,
    feedback: null,
    decidedAt: null,
    followUpTurnId: null,
    appliedMaterialRevisionId: null,
  });
  if (!parsed.success) {
    throw reviewError('invalid_request', 'The Artifact Review creation input is invalid.');
  }
  return parsed.data;
}

/** Verifies immutable creation fields. @param row Stored row. @param expected Expected view. @throws ArtifactReviewError for contradiction. */
function assertImmutableReview(row: ArtifactReviewRow, expected: ArtifactReviewView): void {
  const actual = toView(row);
  if (
    actual.reviewId !== expected.reviewId ||
    actual.contentDigest !== expected.contentDigest ||
    actual.sourceThreadId !== expected.sourceThreadId ||
    actual.sourceTurnId !== expected.sourceTurnId ||
    actual.sourceAgentId !== expected.sourceAgentId ||
    JSON.stringify(actual.materialProposal) !== JSON.stringify(expected.materialProposal) ||
    actual.createdAt !== expected.createdAt
  ) {
    throw reviewError('recovery_required', 'The existing Artifact Review is contradictory.');
  }
}

/** Verifies stored coherence. @param workspaceDb Open database. @param row Stored row. @throws ArtifactReviewError for contradiction. */
function assertStoredReview(workspaceDb: WorkspaceDb, row: ArtifactReviewRow): void {
  if (
    row.reviewId !== deriveArtifactReviewId(row.workspaceId, row.artifactId, row.artifactVersion) ||
    (row.decision === null) !== (row.decisionRequestId === null)
  ) {
    throw reviewError('recovery_required', 'The stored Artifact Review is contradictory.');
  }
  toView(row);
  const proposal = materialProposal(row);
  if (proposal) {
    requireProposalAuthority(workspaceDb, proposal);
  }
  if (row.decision !== null) {
    assertStoredDecisionResult(workspaceDb, row);
  }
}

/** Projects a Review view. @param row Private row. @returns Closed view. @throws ArtifactReviewError for invalid fields. */
function toView(row: ArtifactReviewRow): ArtifactReviewView {
  const parsed = ArtifactReviewViewSchema.safeParse({
    workspaceId: row.workspaceId,
    reviewId: row.reviewId,
    artifactId: row.artifactId,
    artifactVersion: row.artifactVersion,
    contentDigest: row.contentDigest,
    sourceThreadId: row.sourceThreadId,
    sourceTurnId: row.sourceTurnId,
    sourceAgentId: row.sourceAgentId,
    materialProposal: materialProposal(row),
    decision: row.decision,
    decisionActorId: row.decisionActorId,
    feedback: row.feedback,
    decidedAt: row.decidedAt,
    followUpTurnId: row.followUpTurnId,
    appliedMaterialRevisionId: row.appliedMaterialRevisionId,
    createdAt: row.createdAt,
  });
  if (!parsed.success) {
    throw reviewError('recovery_required', 'The stored Artifact Review tuple is invalid.');
  }
  return parsed.data;
}

/** Reconstructs a proposal. @param row Review row. @returns Proposal or null. @throws ArtifactReviewError for an incomplete tuple. */
function materialProposal(row: ArtifactReviewRow): ArtifactMaterialProposal | null {
  if (
    row.proposalMaterialId === null &&
    row.proposalBaseRevisionId === null &&
    row.proposalBaseContentDigest === null
  ) {
    return null;
  }
  if (
    row.proposalMaterialId === null ||
    row.proposalBaseRevisionId === null ||
    row.proposalBaseContentDigest === null
  ) {
    throw reviewError('recovery_required', 'The Material proposal tuple is incomplete.');
  }
  return {
    materialId: row.proposalMaterialId,
    baseRevisionId: row.proposalBaseRevisionId,
    baseContentDigest: row.proposalBaseContentDigest,
  };
}

/** Projects a decision response. @param workspaceDb Open database. @param row Decided row. @returns Stable response. @throws ArtifactReviewError for contradictory authority. */
function toDecisionResponse(
  workspaceDb: WorkspaceDb,
  row: ArtifactReviewRow
): SubmitArtifactReviewDecisionResponse {
  assertStoredReview(workspaceDb, row);
  if (!row.decision) {
    throw reviewError('recovery_required', 'The Artifact Review decision is missing.');
  }
  return {
    reviewId: row.reviewId,
    artifactId: row.artifactId,
    artifactVersion: row.artifactVersion,
    decision: row.decision,
    followUpTurnId: row.followUpTurnId,
  };
}

/** Computes a content digest. @param content Exact UTF-8 content. @returns SHA-256 digest. */
function contentDigest(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

/** Derives a stable id. @param prefix Identity prefix. @param scope Immutable scope. @returns Deterministic id. */
function deterministicId(prefix: string, scope: readonly unknown[]): string {
  return `${prefix}_${createHash('sha256').update(JSON.stringify(scope)).digest('hex').slice(0, 24)}`;
}

/** Tests one structural error code. @param error Unknown failure. @param code Expected code. @returns Whether the code matches. */
function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

/** Creates a typed failure. @param code Stable code. @param message Safe summary. @returns Authority error. */
function reviewError(
  code: ArtifactReviewErrorCode,
  message: string
): Error & { readonly code: ArtifactReviewErrorCode; readonly status: 400 | 409 } {
  return Object.assign(new Error(message), {
    code,
    status: code === 'invalid_request' ? (400 as const) : (409 as const),
  });
}
