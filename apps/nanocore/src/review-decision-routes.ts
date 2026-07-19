import {
  SubmitGoalReviewDecisionRequestSchema,
  SubmitGoalReviewDecisionResponseSchema,
  SubmitKnowledgeProposalDecisionRequestSchema,
  SubmitKnowledgeProposalDecisionResponseSchema,
} from '@openkit/app-api-schemas';
import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

import { asApiError, asCommandError, asInvalidRequestError } from './api-errors.js';
import type { AuthVariables } from './auth/middleware.js';
import { assertAuthorizedWorkspaceLineage } from './auth/operation-authorizer.js';
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
  type InflightIdempotentCommand,
  runIdempotentCommand,
} from './runtime/idempotent-command.js';
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
 * Requires one review route Thread to belong to the centrally authorized path Workspace.
 *
 * @param context Request context carrying optional central authorization.
 * @param store Existing Thread owner.
 * @param workspaceId Authorized path Workspace.
 * @param threadId Requested Thread identifier.
 * @throws The original missing error in no-Core tests, or uniform Workspace denial in guarded mode.
 */
function requireAuthorizedReviewThread(
  context: Context<{ Variables: AuthVariables }>,
  store: FsStore,
  workspaceId: string,
  threadId: string
): void {
  const access = context.get('workspaceAccess');
  try {
    const thread = store.getThread(workspaceId, threadId);
    if (access) {
      assertAuthorizedWorkspaceLineage(access, thread.workspaceId);
    }
  } catch (error) {
    if (access) {
      assertAuthorizedWorkspaceLineage(access, null);
    }
    throw error;
  }
}

/**
 * Registers the Knowledge and Goal review decision App API feature paths.
 *
 * @param dependencies Hono app and concrete review-decision dependencies.
 */
export function registerReviewDecisionRoutes({
  app,
  coreDb,
  inflightCommands,
  repositoryWorkspaceDb,
  requestStore,
}: {
  readonly app: Hono<{ Variables: AuthVariables }>;
  readonly coreDb: CoreDb | undefined;
  readonly inflightCommands: WeakMap<FsStore, Map<string, InflightIdempotentCommand>>;
  readonly repositoryWorkspaceDb: (workspaceId: string) => WorkspaceDb;
  readonly requestStore: (context: Context<{ Variables: AuthVariables }>) => FsStore;
}): void {
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
          const workspaceAccess = c.get('workspaceAccess');
          if (workspaceAccess) {
            assertAuthorizedWorkspaceLineage(workspaceAccess, proposal?.workspaceId ?? null);
          }
          const sourceClaimId =
            proposal && proposal.status !== 'accepted' ? proposal.sourceClaimId : undefined;
          const shouldApplyClaim = input.decision === 'accepted' && sourceClaimId !== undefined;
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
          const workspaceAccess = c.get('workspaceAccess');
          if (workspaceAccess) {
            assertAuthorizedWorkspaceLineage(workspaceAccess, replayed.workspaceId);
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
      if (error instanceof HTTPException) {
        throw error;
      }
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
      requireAuthorizedReviewThread(c, store, workspaceId, threadId);

      const workspaceDb = repositoryWorkspaceDb(workspaceId);
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
                const workspaceAccess = c.get('workspaceAccess');
                if (workspaceAccess) {
                  assertAuthorizedWorkspaceLineage(workspaceAccess, null);
                }
                throw new Error(
                  `Goal review record not found: ${workspaceId}/${threadId}/${goalId}/${reviewId}`
                );
              }
              const workspaceAccess = c.get('workspaceAccess');
              if (workspaceAccess) {
                assertAuthorizedWorkspaceLineage(workspaceAccess, review.workspaceId);
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
            const workspaceAccess = c.get('workspaceAccess');
            if (workspaceAccess) {
              assertAuthorizedWorkspaceLineage(workspaceAccess, review.workspaceId);
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
      if (error instanceof HTTPException) {
        throw error;
      }
      if (error instanceof GoalReviewResolutionError) {
        return asApiError(error.message, error.code, error.status);
      }
      return asCommandError(error, 'goal_review_decision_failed');
    }
  });
}
