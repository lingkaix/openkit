import { randomUUID } from 'node:crypto';

import {
  SubmitArtifactReviewDecisionRequestSchema,
  SubmitArtifactReviewDecisionResponseSchema,
  SubmitGoalReviewDecisionRequestSchema,
  SubmitGoalReviewDecisionResponseSchema,
  SubmitKnowledgeProposalDecisionRequestSchema,
  SubmitKnowledgeProposalDecisionResponseSchema,
  type WorkspaceApplyResult,
} from '@openkit/app-api-schemas';
import type { Context, Hono } from 'hono';

import { asApiError, asCommandError, asInvalidRequestError } from './api-errors.js';
import type { AuthVariables } from './auth/middleware.js';
import type { FsStore } from './lib/store.js';
import { registerAppApiRoute } from './openapi.js';
import {
  type GoalReviewRecord,
  GoalReviewResolutionError,
  getGoalReviewRecord,
  resolveGoalReviewRecord,
} from './runtime/goal-review-records.js';
import { getGoalRecord, listGoalTasks } from './runtime/goal-store.js';
import { advanceGoalAfterReview } from './runtime/goal-supervise-advance.js';
import {
  commandInputHash,
  IdempotencyKeyConflictError,
  type InflightIdempotentCommand,
  runIdempotentCommand,
} from './runtime/idempotent-command.js';
import { TurnStartValidationError } from './runtime/orchestrator.js';
import { requireWorkspaceApplyResult } from './runtime/workspace-apply-results.js';
import {
  decideWorkspaceSyncReview,
  parseWorkspaceSyncReviewArtifact,
  workspaceSyncDecisionFromArtifact,
} from './runtime/workspace-review-application.js';
import { getWorkspaceSyncReview } from './runtime/workspace-sync-records.js';
import type { CoreDb, WorkspaceDb } from './storage/db.js';

/**
 * Builds the replayable response for one Goal Review decision route call.
 *
 * @param review Resolved or resolving Goal Review record.
 * @returns Parsed App API response payload.
 * @throws Error when the review does not contain its immutable resolution snapshot.
 */
function buildGoalReviewDecisionResponse(review: GoalReviewRecord): unknown {
  const { resolutionSnapshot, ...publicReview } = review;

  if (!resolutionSnapshot) {
    throw new Error(`Goal review resolution snapshot is unavailable: ${review.reviewId}`);
  }

  return SubmitGoalReviewDecisionResponseSchema.parse({
    review: publicReview,
    advance: resolutionSnapshot,
  });
}

/**
 * Removes app-local audit fields from an artifact review response.
 *
 * @param review Stored artifact review record.
 * @returns Public App API artifact review payload.
 */
function publicArtifactReviewDecision(review: {
  readonly artifactId: string;
  readonly workspaceId: string;
  readonly threadId: string | null;
  readonly turnId: string | null;
  readonly status: string;
  readonly message: string | null;
  readonly decidedAt: string;
  readonly followUpTurnId: string | null;
}): unknown {
  return {
    artifactId: review.artifactId,
    workspaceId: review.workspaceId,
    threadId: review.threadId,
    turnId: review.turnId,
    status: review.status,
    message: review.message,
    decidedAt: review.decidedAt,
    followUpTurnId: review.followUpTurnId,
  };
}

/**
 * Registers the artifact, knowledge, and Goal review decision App API feature path.
 *
 * @param dependencies Hono app and concrete review-decision dependencies.
 */
export function registerReviewDecisionRoutes({
  app,
  coreDb,
  inflightCommands,
  repositoryWorkspaceDb,
  requestStore,
  startModeWorkerTurn,
}: {
  readonly app: Hono<{ Variables: AuthVariables }>;
  readonly coreDb: CoreDb | undefined;
  readonly inflightCommands: WeakMap<FsStore, Map<string, InflightIdempotentCommand>>;
  readonly repositoryWorkspaceDb: (store: FsStore, workspaceId: string) => WorkspaceDb;
  readonly requestStore: (context: Context<{ Variables: AuthVariables }>) => FsStore;
  /** Starts the existing worker-backed Turn path for refinement and redo decisions. */
  readonly startModeWorkerTurn: (input: {
    readonly store: FsStore;
    readonly workspaceId: string;
    readonly threadId: string;
    readonly prompt: string;
    readonly requestId: string;
    readonly requestedAgentId: string;
    readonly reservedTurnId: string;
  }) => Promise<unknown>;
}): void {
  registerAppApiRoute(app, 'submitArtifactReviewDecision', async (c) => {
    try {
      const parsed = SubmitArtifactReviewDecisionRequestSchema.safeParse(
        await c.req.json().catch(() => ({}))
      );

      if (!parsed.success) {
        return asInvalidRequestError(parsed.error);
      }

      const store = requestStore(c);
      const workspaceId = c.req.param('workspaceId');
      const artifact = store.getArtifact(workspaceId, c.req.param('artifactId'));
      const input = parsed.data;

      if (!input.requestId) {
        return asApiError('requestId is required.', 'invalid_request', 400);
      }

      const requestId = input.requestId;
      const review = await runIdempotentCommand({
        store,
        inflightCommands,
        command: 'artifact.review.decide',
        requestId,
        scope: { workspaceId, artifactId: artifact.id },
        input,
        responseKind: 'artifact_review',
        execute: async () => {
          const message = input.message ?? null;
          const existingReview = store.getArtifactReviewDecision(artifact.id);
          const resumesExistingClaim =
            existingReview !== null &&
            existingReview.lifecycle !== 'failed' &&
            existingReview.requestId === requestId &&
            existingReview.status === input.decision &&
            existingReview.message === message;

          if (existingReview && existingReview.lifecycle !== 'failed' && !resumesExistingClaim) {
            throw new IdempotencyKeyConflictError();
          }

          const claimStatus = resumesExistingClaim ? existingReview.status : input.decision;
          const claimRequestId = resumesExistingClaim ? existingReview.requestId : requestId;
          const claimMessage = resumesExistingClaim ? existingReview.message : message;
          const decidedAt =
            existingReview && existingReview.lifecycle !== 'failed'
              ? existingReview.decidedAt
              : new Date().toISOString();
          const followUpText =
            claimStatus === 'needs_refinement' || claimStatus === 'redo'
              ? (claimMessage ??
                (claimStatus === 'redo'
                  ? `Redo artifact ${artifact.title}.`
                  : `Refine artifact ${artifact.title}.`))
              : null;
          const followUpTurnId = resumesExistingClaim
            ? existingReview.followUpTurnId
            : artifact.threadId && followUpText
              ? `tu_artifact_review_${commandInputHash({
                  artifactId: artifact.id,
                  input,
                  workspaceId,
                }).slice(7, 31)}`
              : null;
          let sourceAgentId: string | null = null;

          if (
            existingReview?.lifecycle !== 'completed' &&
            artifact.threadId &&
            followUpText &&
            followUpTurnId
          ) {
            if (!artifact.turnId) {
              throw new Error(`Artifact refinement requires a source Turn: ${artifact.id}`);
            }
            const sourceTurn = store.getTurn(workspaceId, artifact.threadId, artifact.turnId);
            if (!sourceTurn.agentId) {
              throw new Error(`Artifact refinement requires an assigned Agent: ${artifact.id}`);
            }
            sourceAgentId = sourceTurn.agentId;

            const threadBusy = store
              .listThreadTurns(workspaceId, artifact.threadId)
              .some(
                (turn) =>
                  turn.id !== followUpTurnId &&
                  (turn.status === 'pending' ||
                    turn.status === 'running' ||
                    turn.status === 'awaiting_human')
              );
            if (threadBusy) {
              throw new TurnStartValidationError(
                'thread_busy',
                'Thread already has an active worker turn.',
                409
              );
            }
          }

          const claimedReview = store.recordArtifactReviewDecision({
            artifactId: artifact.id,
            workspaceId,
            threadId: artifact.threadId,
            turnId: artifact.turnId,
            status: claimStatus,
            requestId: claimRequestId,
            message: claimMessage,
            decidedAt,
            followUpTurnId,
            lifecycle: 'pending',
          });
          let workspaceApplyResult: WorkspaceApplyResult | null = null;

          if (
            claimedReview.workspaceId !== workspaceId ||
            claimedReview.threadId !== artifact.threadId ||
            claimedReview.turnId !== artifact.turnId ||
            claimedReview.requestId !== claimRequestId ||
            claimedReview.status !== claimStatus ||
            claimedReview.message !== claimMessage ||
            claimedReview.followUpTurnId !== followUpTurnId
          ) {
            throw new IdempotencyKeyConflictError();
          }

          const workspaceReview = parseWorkspaceSyncReviewArtifact(artifact);

          if (
            workspaceReview &&
            claimedReview.status !== 'needs_refinement' &&
            claimedReview.status !== 'redo'
          ) {
            const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
            try {
              const result = await decideWorkspaceSyncReview({
                decidedAt: claimedReview.decidedAt,
                decision: workspaceSyncDecisionFromArtifact(claimedReview.status),
                fallbackReview: workspaceReview,
                requestId: claimedReview.requestId ?? requestId,
                reviewId: workspaceReview.review.id,
                store,
                workspaceDb,
                workspaceId,
              });
              workspaceApplyResult = result.workspaceApplyResult ?? null;
            } catch (error) {
              const durableReview = getWorkspaceSyncReview(
                workspaceDb,
                workspaceId,
                workspaceReview.review.id
              );
              if (
                durableReview &&
                durableReview.review.status !== 'pending' &&
                durableReview.review.status !==
                  workspaceSyncDecisionFromArtifact(claimedReview.status)
              ) {
                store.recordArtifactReviewDecision({
                  ...claimedReview,
                  lifecycle: 'failed',
                });
                throw new IdempotencyKeyConflictError();
              }
              throw error;
            } finally {
              workspaceDb.sqlite.close();
            }
          }

          if (claimedReview.lifecycle === 'completed') {
            return { review: claimedReview, workspaceApplyResult };
          }

          if (artifact.threadId && followUpText && followUpTurnId) {
            if (!sourceAgentId) {
              throw new Error(`Artifact refinement requires an assigned Agent: ${artifact.id}`);
            }
            const existingTurn = store
              .listThreadTurns(workspaceId, artifact.threadId)
              .find((turn) => turn.id === followUpTurnId);
            if (existingTurn) {
              const userItem = existingTurn.items.find((item) => item.type === 'user-message');
              if (
                existingTurn.agentId !== sourceAgentId ||
                userItem?.type !== 'user-message' ||
                userItem.text !== followUpText
              ) {
                throw new IdempotencyKeyConflictError();
              }
            } else {
              await startModeWorkerTurn({
                store,
                workspaceId,
                threadId: artifact.threadId,
                prompt: followUpText,
                requestId: randomUUID(),
                requestedAgentId: sourceAgentId,
                reservedTurnId: followUpTurnId,
              });
            }
          }

          const review = store.recordArtifactReviewDecision({
            ...claimedReview,
            lifecycle: 'completed',
          });
          if (review.lifecycle !== 'completed') {
            throw new IdempotencyKeyConflictError();
          }

          return { review, workspaceApplyResult };
        },
        replay: (record) => {
          const replayed = store.getArtifactReviewDecision(record.response.id);

          if (!replayed) {
            throw new Error(`Artifact review decision not found: ${record.response.id}`);
          }

          const workspaceReview = parseWorkspaceSyncReviewArtifact(artifact);
          let workspaceApplyResult: WorkspaceApplyResult | null = null;
          if (workspaceReview && replayed.status === 'accepted') {
            const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
            try {
              workspaceApplyResult = requireWorkspaceApplyResult(
                workspaceDb,
                workspaceId,
                `war_${workspaceReview.review.id}`
              );
            } finally {
              workspaceDb.sqlite.close();
            }
          }

          return { review: replayed, workspaceApplyResult };
        },
        responseId: (result) => result.review.artifactId,
      });

      return c.json(
        SubmitArtifactReviewDecisionResponseSchema.parse({
          review: publicArtifactReviewDecision(review.review),
          workspaceApplyResult: review.workspaceApplyResult,
        })
      );
    } catch (error) {
      return asCommandError(
        error,
        'artifact_review_failed',
        (error as Error).message.startsWith('Artifact not found:') ? 404 : 500
      );
    }
  });

  registerAppApiRoute(app, 'submitKnowledgeProposalDecision', async (c) => {
    try {
      const parsed = SubmitKnowledgeProposalDecisionRequestSchema.safeParse(
        await c.req.json().catch(() => ({}))
      );

      if (!parsed.success) {
        return asInvalidRequestError(parsed.error);
      }

      const store = requestStore(c);
      const workspaceId = c.req.param('workspaceId');
      const proposalId = c.req.param('proposalId');
      const input = parsed.data;

      if (!input.requestId) {
        return asApiError('requestId is required.', 'invalid_request', 400);
      }

      const requestId = input.requestId;
      const message = input.message ?? null;
      const decidedAt = new Date().toISOString();
      const review = await runIdempotentCommand({
        store,
        inflightCommands,
        command: 'knowledge.proposal.decide',
        requestId,
        scope: { workspaceId, proposalId },
        input,
        responseKind: 'knowledge_proposal_review',
        execute: () => {
          const proposal = store.getKnowledgeProposal(proposalId);
          const sourceClaimId =
            proposal && proposal.status !== 'accepted' ? proposal.sourceClaimId : undefined;
          const shouldApplyClaim = input.decision === 'accepted' && sourceClaimId !== undefined;
          if (input.decision === 'edited') {
            const updates: { title?: string; summary?: string; updatedAt: string } = {
              updatedAt: decidedAt,
            };
            if (input.title !== undefined) {
              updates.title = input.title;
            }
            if (input.summary !== undefined) {
              updates.summary = input.summary;
            }
            store.updateKnowledgeProposalContent(proposalId, {
              ...updates,
            });
          }
          const review = store.recordKnowledgeProposalReviewDecision({
            proposalId,
            workspaceId,
            status: input.decision,
            requestId,
            message,
            decidedAt,
          });

          if (shouldApplyClaim) {
            const claim = store.getKnowledgeClaim(workspaceId, sourceClaimId);
            store.createKnowledgeEntry(workspaceId, {
              kind: 'project-context',
              title: claim.statement,
              content: claim.statement,
              sourceReferences: claim.sourceReferences,
            });
          }

          return review;
        },
        replay: (record) => {
          const replayed = store.getKnowledgeProposalReviewDecision(record.response.id);

          if (!replayed) {
            throw new Error(`Knowledge proposal review decision not found: ${record.response.id}`);
          }

          return replayed;
        },
        responseId: (result) => result.proposalId,
      });

      return c.json(
        SubmitKnowledgeProposalDecisionResponseSchema.parse({
          review,
        })
      );
    } catch (error) {
      return asCommandError(error, 'knowledge_proposal_review_failed');
    }
  });

  registerAppApiRoute(app, 'submitGoalReviewDecision', async (c) => {
    try {
      const parsed = SubmitGoalReviewDecisionRequestSchema.safeParse(
        await c.req.json().catch(() => ({}))
      );

      if (!parsed.success) {
        return asInvalidRequestError(parsed.error);
      }

      if (!coreDb) {
        return asApiError(
          'Goal storage is unavailable for this NanoCore instance.',
          'goal_storage_unavailable',
          503
        );
      }

      const input = parsed.data;

      const store = requestStore(c);
      const workspaceId = c.req.param('workspaceId');
      const threadId = c.req.param('threadId');
      const goalId = c.req.param('goalId');
      const reviewId = c.req.param('reviewId');
      const actorId = c.get('actor').userId;

      store.getWorkspace(workspaceId);
      store.getThread(workspaceId, threadId);

      const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
      try {
        const response = await runIdempotentCommand({
          store,
          inflightCommands,
          command: 'goal.review.decide',
          requestId: input.requestId,
          scope: { workspaceId, threadId, goalId, reviewId },
          input,
          responseKind: 'goal_review',
          execute: () =>
            workspaceDb.sqlite.transaction(() => {
              const review = getGoalReviewRecord(
                workspaceDb,
                workspaceId,
                threadId,
                goalId,
                reviewId
              );

              if (!review) {
                throw new Error(
                  `Goal review record not found: ${workspaceId}/${threadId}/${goalId}/${reviewId}`
                );
              }

              if (review.resolvedAt) {
                if (!review.resolutionSnapshot) {
                  throw new GoalReviewResolutionError(
                    'recovery_required',
                    'Resolved Goal Review is missing its resolution snapshot.'
                  );
                }
                return buildGoalReviewDecisionResponse(
                  resolveGoalReviewRecord(workspaceDb, {
                    workspaceId,
                    threadId,
                    goalId,
                    reviewId,
                    requestId: input.requestId,
                    actorId,
                    verdict: input.verdict,
                    ...(input.reason ? { reason: input.reason } : {}),
                    ...(input.revisionInstruction
                      ? { revisionInstruction: input.revisionInstruction }
                      : {}),
                    resolutionSnapshot: review.resolutionSnapshot,
                  })
                );
              }

              const goal = getGoalRecord(workspaceDb, workspaceId, threadId, goalId);
              const task = listGoalTasks(workspaceDb, {
                workspaceId,
                threadId,
                goalId,
              }).find((candidate) => candidate.taskId === review.taskId);
              if (
                !goal ||
                !task ||
                goal.status !== 'reviewing' ||
                goal.currentTaskId !== task.taskId ||
                task.status !== 'reviewing'
              ) {
                throw new GoalReviewResolutionError(
                  'recovery_required',
                  'Unresolved Goal Review does not own the current reviewing Goal and Task.'
                );
              }

              const resolutionSnapshot = advanceGoalAfterReview(workspaceDb, {
                workspaceId,
                threadId,
                goalId,
                taskId: review.taskId,
                verdict: input.verdict,
              });

              const resolved = resolveGoalReviewRecord(workspaceDb, {
                workspaceId,
                threadId,
                goalId,
                reviewId,
                requestId: input.requestId,
                actorId,
                verdict: input.verdict,
                ...(input.reason ? { reason: input.reason } : {}),
                ...(input.revisionInstruction
                  ? { revisionInstruction: input.revisionInstruction }
                  : {}),
                resolutionSnapshot,
              });

              return buildGoalReviewDecisionResponse(resolved);
            })(),
          replay: (record) => {
            const review = getGoalReviewRecord(
              workspaceDb,
              workspaceId,
              threadId,
              goalId,
              record.response.id
            );

            if (!review) {
              throw new Error(
                `Goal review record not found: ${workspaceId}/${threadId}/${goalId}/${record.response.id}`
              );
            }

            return buildGoalReviewDecisionResponse(review);
          },
          responseId: (result) =>
            SubmitGoalReviewDecisionResponseSchema.parse(result).review.reviewId,
        });

        return c.json(response);
      } finally {
        workspaceDb.sqlite.close();
      }
    } catch (error) {
      if (error instanceof GoalReviewResolutionError) {
        return asApiError(error.message, error.code, error.status);
      }
      return asCommandError(error, 'goal_review_decision_failed');
    }
  });
}
