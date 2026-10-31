import { isDeepStrictEqual } from 'node:util';
import {
  KnowledgeManagerDraftedProposalSchema,
  KnowledgeProposalReviewSchema,
  validKnowledgeProposalShape,
} from '@openkit/app-api-schemas';
import {
  ActorRefSchema,
  deriveEntityId,
  entityIdPattern,
  WorkspaceIdSchema,
} from '@openkit/protocol';
import { sha256Hex } from '@openkit/protocol/digest';
import { z } from 'zod';
import type { KnowledgeProposalRecord } from '../lib/store.js';

/** Retained attribution is descriptive; all actor branches and accountability fields remain closed. */
export const ActorRefReaderSchema = z.union(ActorRefSchema.options.map((schema) => schema.strip()));

const { status: _proposalStatus, ...knowledgeProposalRecordShape } =
  KnowledgeManagerDraftedProposalSchema.shape;
/** Retained immutable Proposal core, excluding mutable Review state. */
export const KnowledgeProposalRecordSchema = z
  .object(knowledgeProposalRecordShape)
  .extend({
    id: z.string().regex(/^kp_[a-f0-9]{64}$/),
    producer: ActorRefReaderSchema,
  })
  .strip()
  .refine(
    validKnowledgeProposalShape,
    'Knowledge Proposal must contain exactly one complete candidate shape.'
  );

/** Hidden original-byte binding shared by the parser and canonical serializer. */
export const retainedProposal = Symbol('retainedKnowledgeProposal');

/**
 * Serializes one immutable Knowledge Proposal owner without review state.
 *
 * @param proposal Proposal tuple to serialize.
 * @returns Exact canonical proposal-file bytes.
 */
export function serializeKnowledgeProposalRecord(
  proposal: KnowledgeProposalRecord | Omit<KnowledgeProposalRecord, 'workspaceId'>
): string {
  const retained = (
    proposal as KnowledgeProposalRecord & {
      [retainedProposal]?: { bytes: string; core: KnowledgeProposalRecord };
    }
  )[retainedProposal];
  if (
    retained &&
    'workspaceId' in proposal &&
    isDeepStrictEqual(retained.core, KnowledgeProposalRecordSchema.parse(proposal))
  )
    return retained.bytes;
  return [
    '---',
    'type: "proposal"',
    'operation: "notebook-change"',
    `owner_scope: ${JSON.stringify(proposal.ownerScope)}`,
    `base_revision: ${JSON.stringify(proposal.baseRevision)}`,
    `candidate_revision: ${JSON.stringify(proposal.candidateRevision)}`,
    ...(proposal.changes
      ? [
          `changes: ${JSON.stringify(proposal.changes.map(({ path, content }) => ({ path, removed: content === null })))}`,
        ]
      : [`knowledge_page_id: ${JSON.stringify(proposal.knowledgePageId)}`]),
    `content_digest: ${JSON.stringify(proposal.contentDigest)}`,
    `source_references: ${JSON.stringify(proposal.sourceReferences)}`,
    `rationale: ${JSON.stringify(proposal.rationale)}`,
    ...(proposal.confidence === undefined
      ? []
      : [`confidence: ${JSON.stringify(proposal.confidence)}`]),
    'review_required: true',
    `producer: ${JSON.stringify(proposal.producer)}`,
    `created_at: ${JSON.stringify(proposal.createdAt)}`,
    '---',
    proposal.rationale,
  ].join('\n');
}

/** Hashes the exact original document of an already verified Proposal; this pure codec grants no access. */
export function knowledgeProposalDocumentDigest(proposal: KnowledgeProposalRecord): string {
  return `sha256:${sha256Hex(serializeKnowledgeProposalRecord(proposal))}`;
}

/** Existing ordered Review codecs, below file and SQL selection consumers. */
export const KnowledgeProposalReviewRecordSchema = KnowledgeProposalReviewSchema.safeExtend({
  reviewId: z.string().regex(entityIdPattern('kr')),
  actor: z.union(ActorRefSchema.options.map((schema) => schema.strip())),
})
  .strip()
  .superRefine((review, context) => {
    const accepted = review.decision === 'accepted';
    if (
      accepted
        ? !review.changedPageIds && review.targetAbsentAtDecision === null
        : review.targetAbsentAtDecision !== null
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Only an accepted review may record target absence.',
        path: ['targetAbsentAtDecision'],
      });
    }
  });
/** Retained Review reader validates ordered decision core and identities without descriptive annotations. */
export const KnowledgeProposalReviewFileSchema = z
  .object({
    proposalId: z.string().regex(/^kp_[a-f0-9]{64}$/),
    workspaceId: WorkspaceIdSchema,
    decisions: z.array(KnowledgeProposalReviewRecordSchema).min(1),
  })
  .strip()
  .superRefine((file, context) => {
    const requestIds = new Set<string>();
    const reviewIds = new Set<string>();
    let terminal = false;

    for (const [index, review] of file.decisions.entries()) {
      const expectedReviewId = deriveEntityId('kr', {
        ownerScope: { kind: 'workspace', workspaceId: file.workspaceId },
        proposalId: file.proposalId,
        requestId: review.requestId,
      });
      if (
        review.proposalId !== file.proposalId ||
        review.workspaceId !== file.workspaceId ||
        review.reviewId !== expectedReviewId ||
        requestIds.has(review.requestId) ||
        reviewIds.has(review.reviewId) ||
        terminal
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Knowledge Proposal review history is not append-only canonical history.',
          path: ['decisions', index],
        });
      }
      requestIds.add(review.requestId);
      reviewIds.add(review.reviewId);
      terminal ||= review.decision === 'accepted' || review.decision === 'rejected';
    }
  });
