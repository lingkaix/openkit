import {
  ReverseKnowledgeProposalRequestSchema,
  ReverseKnowledgeProposalResponseSchema,
  SubmitGoalReviewDecisionRequestSchema,
  SubmitGoalReviewDecisionResponseSchema,
  SubmitKnowledgeProposalDecisionRequestSchema,
  SubmitKnowledgeProposalDecisionResponseSchema,
} from '@openkit/app-api-schemas';
import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

import { asApiError, asCommandError, asInvalidRequestError } from './api-errors.js';
import { listWorkspaceAuditEvents, recordWorkspaceAuditEvent } from './audit-events.js';
import type { AuthVariables } from './auth/middleware.js';
import { assertAuthorizedWorkspaceLineage } from './auth/operation-authorizer.js';
import { verifyKnowledgeProposalWorkHistory } from './knowledge-manager.js';
import {
  type FsStore,
  knowledgeAuthorityId,
  knowledgeProposalAuthorityError as knowledgeProposalAuthorityFailure,
} from './lib/store.js';
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
  IdempotencyKeyConflictError,
  type InflightIdempotentCommand,
  runIdempotentCommand,
} from './runtime/idempotent-command.js';
import type { CoreDb, WorkspaceDb } from './storage/db.js';

/**
 * Maps one Knowledge Proposal command failure to the closed public vocabulary.
 *
 * @param error Caught command failure.
 * @param fallbackCode Stable fallback code for unexpected internal failures.
 * @returns Redacted protocol error response.
 */
function asKnowledgeProposalCommandError(error: unknown, fallbackCode: string): Response {
  if (error instanceof IdempotencyKeyConflictError) {
    return asCommandError(error, fallbackCode);
  }
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    'status' in error &&
    ['invalid_request', 'not_found', 'conflict', 'recovery_required'].includes(
      String(error.code)
    ) &&
    [400, 404, 409].includes(Number(error.status))
  ) {
    return asApiError(
      'Knowledge Proposal authority check failed.',
      String(error.code),
      Number(error.status)
    );
  }
  return asApiError('Knowledge Proposal command failed.', fallbackCode, 500);
}

/**
 * Counts exact Audit evidence for one Knowledge Proposal command.
 *
 * @param workspaceDb Workspace Audit owner.
 * @param input Exact command and actor lineage.
 * @param requireActor Whether the count requires exact actor lineage.
 * @returns Number of matching successful Audit events.
 */
function knowledgeProposalAuditCount(
  workspaceDb: WorkspaceDb,
  input: {
    /** Exact internal command action. */
    readonly action: 'knowledge.proposal.decide' | 'knowledge.proposal.reverse';
    /** Authenticated actor assigned by the route. */
    readonly actor: { readonly kind: 'user'; readonly id: string };
    /** Proposal resource named by the Audit event. */
    readonly proposalId: string;
    /** Command request identity named by the Audit event. */
    readonly requestId: string;
    /** Workspace that owns the Audit event. */
    readonly workspaceId: string;
  },
  requireActor = true
): number {
  return listWorkspaceAuditEvents(workspaceDb, input.workspaceId).filter(
    (event) =>
      event.action === input.action &&
      event.category === 'knowledge' &&
      event.outcome === 'succeeded' &&
      event.requestId === input.requestId &&
      event.resource === `knowledge-proposal:${input.proposalId}` &&
      (!requireActor ||
        (event.actor?.kind === input.actor.kind && event.actor.id === input.actor.id))
  ).length;
}

/**
 * Reads one Proposal through the authorized path Workspace without exposing foreign lineage.
 *
 * @param context Request context carrying central Workspace authorization when enabled.
 * @param store Existing Proposal owner.
 * @param workspaceId Authorized path Workspace.
 * @param proposalId Addressed Proposal identity.
 * @returns Exact Proposal owned by the path Workspace.
 * @throws Uniform access denial or bounded not-found failure.
 */
function requireAuthorizedKnowledgeProposal(
  context: Context<{ Variables: AuthVariables }>,
  store: FsStore,
  workspaceId: string,
  proposalId: string
): NonNullable<ReturnType<FsStore['getKnowledgeProposal']>> {
  const proposal = store.getKnowledgeProposal(proposalId);
  const access = context.get('workspaceAccess');
  if (access) {
    assertAuthorizedWorkspaceLineage(access, proposal?.workspaceId ?? null);
  }
  if (!proposal || proposal.workspaceId !== workspaceId) {
    throw knowledgeProposalAuthorityFailure('not_found');
  }
  return proposal;
}

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
    const parsed = SubmitKnowledgeProposalDecisionRequestSchema.safeParse(
      await c.req.json().catch(() => ({}))
    );
    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    try {
      const store = requestStore(c);
      const workspaceId = c.req.param('workspaceId');
      const proposalId = c.req.param('proposalId');
      const proposal = requireAuthorizedKnowledgeProposal(c, store, workspaceId, proposalId);
      if (!coreDb) {
        return asApiError(
          'Knowledge Proposal command storage is unavailable.',
          'knowledge_proposal_storage_unavailable',
          503
        );
      }

      const actor = { kind: 'user' as const, id: c.get('actor').userId };
      const scope = { workspaceId, proposalId };
      const reviewId = knowledgeAuthorityId('kr_', {
        workspaceId,
        proposalId,
        requestId: parsed.data.requestId,
      });
      const auditIdentity = {
        action: 'knowledge.proposal.decide' as const,
        actor,
        proposalId,
        requestId: parsed.data.requestId,
        workspaceId,
      };
      const workspaceDb = repositoryWorkspaceDb(workspaceId);
      try {
        const receipt = store.getCommandRequest(
          'knowledge.proposal.decide',
          parsed.data.requestId,
          scope,
          workspaceDb
        );
        const existingReview = store
          .listKnowledgeProposalReviewDecisions(workspaceId)
          .find((candidate) => candidate.reviewId === reviewId);
        const auditCount = knowledgeProposalAuditCount(workspaceDb, auditIdentity, false);
        if (!receipt) {
          if (auditCount !== 0) {
            throw knowledgeProposalAuthorityFailure('recovery_required');
          }
          if (existingReview) {
            if (
              existingReview.requestId !== parsed.data.requestId ||
              existingReview.decision !== parsed.data.decision ||
              JSON.stringify(existingReview.actor) !== JSON.stringify(actor)
            ) {
              throw knowledgeProposalAuthorityFailure('conflict');
            }
            if (
              existingReview.proposalId !== proposalId ||
              existingReview.workspaceId !== workspaceId ||
              existingReview.knowledgePageId !== proposal.knowledgePageId ||
              existingReview.contentDigest !== proposal.contentDigest
            ) {
              throw knowledgeProposalAuthorityFailure('recovery_required');
            }

            let complete = false;
            try {
              store.projectKnowledgeProposalDecision(workspaceId, reviewId);
              complete = true;
            } catch {
              // Only the accepted Review's exact missing-page path may continue below.
            }
            if (complete || existingReview.decision !== 'accepted') {
              throw knowledgeProposalAuthorityFailure('recovery_required');
            }
            try {
              store.projectKnowledgeProposalReversal({
                workspaceId,
                proposalId,
                reviewId,
                knowledgePageId: proposal.knowledgePageId,
                expectedContentDigest: proposal.contentDigest,
              });
            } catch {
              throw knowledgeProposalAuthorityFailure('recovery_required');
            }
          }
        }

        const response = await runIdempotentCommand({
          store,
          inflightCommands,
          command: 'knowledge.proposal.decide',
          requestId: parsed.data.requestId,
          scope,
          input: {
            actor,
            proposalId,
            decision: parsed.data.decision,
            knowledgePageId: proposal.knowledgePageId,
            contentDigest: proposal.contentDigest,
            sourceReferences: proposal.sourceReferences,
          },
          responseKind: 'knowledge_proposal_review',
          workspaceDb,
          execute: () => {
            const verifiedExternalReferences =
              parsed.data.decision === 'accepted'
                ? verifyKnowledgeProposalWorkHistory({
                    coreDb,
                    sourceReferences: proposal.sourceReferences,
                    store,
                    workspaceDb,
                    workspaceId,
                  }).verifiedExternalReferences
                : [];
            const executed = store.recordKnowledgeProposalReviewDecision({
              ...parsed.data,
              actor,
              decidedAt: new Date().toISOString(),
              proposalId,
              verifiedExternalReferences,
              workspaceId,
            });
            recordWorkspaceAuditEvent({
              workspaceDb,
              workspaceId,
              requestId: parsed.data.requestId,
              actor,
              category: 'knowledge',
              action: auditIdentity.action,
              resource: `knowledge-proposal:${proposalId}`,
              outcome: 'succeeded',
              severity: 'info',
              summary: 'Knowledge proposal decision recorded.',
            });
            return SubmitKnowledgeProposalDecisionResponseSchema.parse(executed);
          },
          replay: (record) => {
            if (
              record.response.kind !== 'knowledge_proposal_review' ||
              record.response.id !== reviewId
            ) {
              throw knowledgeProposalAuthorityFailure('recovery_required');
            }
            const replayed = store.projectKnowledgeProposalDecision(workspaceId, reviewId);
            if (
              replayed.review.proposalId !== proposalId ||
              replayed.review.workspaceId !== workspaceId ||
              replayed.review.reviewId !== reviewId ||
              replayed.review.requestId !== parsed.data.requestId ||
              replayed.review.decision !== parsed.data.decision ||
              replayed.review.knowledgePageId !== proposal.knowledgePageId ||
              replayed.review.contentDigest !== proposal.contentDigest ||
              JSON.stringify(replayed.review.actor) !== JSON.stringify(actor) ||
              knowledgeProposalAuditCount(workspaceDb, auditIdentity) !== 1
            ) {
              throw knowledgeProposalAuthorityFailure('recovery_required');
            }
            return SubmitKnowledgeProposalDecisionResponseSchema.parse(replayed);
          },
          responseId: (result) => result.review.reviewId,
        });

        return c.json(response);
      } finally {
        workspaceDb.sqlite.close();
      }
    } catch (error) {
      if (error instanceof HTTPException) {
        throw error;
      }
      return asKnowledgeProposalCommandError(error, 'knowledge_proposal_review_failed');
    }
  });

  registerAppApiRoute(app, 'reverseKnowledgeProposal', async (c) => {
    const parsed = ReverseKnowledgeProposalRequestSchema.safeParse(
      await c.req.json().catch(() => ({}))
    );
    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    try {
      const store = requestStore(c);
      const workspaceId = c.req.param('workspaceId');
      const proposalId = c.req.param('proposalId');
      const proposal = requireAuthorizedKnowledgeProposal(c, store, workspaceId, proposalId);
      if (!coreDb) {
        return asApiError(
          'Knowledge Proposal command storage is unavailable.',
          'knowledge_proposal_storage_unavailable',
          503
        );
      }

      const actor = { kind: 'user' as const, id: c.get('actor').userId };
      const scope = { workspaceId, proposalId };
      const auditIdentity = {
        action: 'knowledge.proposal.reverse' as const,
        actor,
        proposalId,
        requestId: parsed.data.requestId,
        workspaceId,
      };
      const workspaceDb = repositoryWorkspaceDb(workspaceId);
      try {
        const receipt = store.getCommandRequest(
          'knowledge.proposal.reverse',
          parsed.data.requestId,
          scope,
          workspaceDb
        );
        if (!receipt && knowledgeProposalAuditCount(workspaceDb, auditIdentity, false) !== 0) {
          throw knowledgeProposalAuthorityFailure('recovery_required');
        }

        const response = await runIdempotentCommand({
          store,
          inflightCommands,
          command: 'knowledge.proposal.reverse',
          requestId: parsed.data.requestId,
          scope,
          input: { ...parsed.data, actor, proposalId },
          responseKind: 'knowledge_proposal',
          workspaceDb,
          execute: () => {
            const executed = store.reverseKnowledgeProposalApplication({
              workspaceId,
              proposalId,
              reviewId: parsed.data.reviewId,
              knowledgePageId: parsed.data.knowledgePageId,
              expectedContentDigest: parsed.data.expectedContentDigest,
            });
            recordWorkspaceAuditEvent({
              workspaceDb,
              workspaceId,
              requestId: parsed.data.requestId,
              actor,
              category: 'knowledge',
              action: auditIdentity.action,
              resource: `knowledge-proposal:${proposalId}`,
              outcome: 'succeeded',
              severity: 'info',
              summary: 'Knowledge proposal application reversed.',
            });
            return ReverseKnowledgeProposalResponseSchema.parse(executed);
          },
          replay: (record) => {
            if (
              record.response.kind !== 'knowledge_proposal' ||
              record.response.id !== proposalId
            ) {
              throw knowledgeProposalAuthorityFailure('recovery_required');
            }
            const replayed = store.projectKnowledgeProposalReversal({
              workspaceId,
              proposalId,
              reviewId: parsed.data.reviewId,
              knowledgePageId: parsed.data.knowledgePageId,
              expectedContentDigest: parsed.data.expectedContentDigest,
            });
            if (
              replayed.proposalId !== proposalId ||
              replayed.reviewId !== parsed.data.reviewId ||
              replayed.application.knowledgePageId !== proposal.knowledgePageId ||
              replayed.application.contentDigest !== proposal.contentDigest ||
              replayed.application.present !== false ||
              knowledgeProposalAuditCount(workspaceDb, auditIdentity) !== 1
            ) {
              throw knowledgeProposalAuthorityFailure('recovery_required');
            }
            return ReverseKnowledgeProposalResponseSchema.parse(replayed);
          },
          responseId: (result) => result.proposalId,
        });

        return c.json(response);
      } finally {
        workspaceDb.sqlite.close();
      }
    } catch (error) {
      if (error instanceof HTTPException) {
        throw error;
      }
      return asKnowledgeProposalCommandError(error, 'knowledge_proposal_reversal_failed');
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
