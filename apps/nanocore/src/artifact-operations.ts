import { createHash } from 'node:crypto';
import type { ARTIFACT_OPERATION_DEFINITIONS } from '@openkit/app-api-schemas';
import {
  type ArtifactReviewView,
  ImportWorkspaceArtifactResponseSchema,
  IntroduceWorkspaceArtifactResponseSchema,
  ListArtifactReviewsResponseSchema,
  type SubmitArtifactReviewDecisionResponse,
} from '@openkit/app-api-schemas';
import {
  isSealedTurnTerminal,
  ListArtifactsResponseSchema,
  responsibleUserIdForActor,
} from '@openkit/protocol';
import { z } from 'zod';
import { publishedErrorMessage } from './api-errors.js';
import { listOutputArtifacts } from './artifact-catalog.js';
import {
  ArtifactReviewError,
  type ArtifactReviewMediaType,
  decideArtifactReview,
  deriveArtifactReviewFollowUpTurnId,
  deriveArtifactReviewWorkerRequestId,
  getArtifactReview,
  listArtifactReviews,
  replayArtifactReviewDecision,
  serializeArtifactReviewFollowUpRequest,
} from './artifact-reviews.js';
import { isCurrentDeploymentAdministrator } from './auth/operation-authorizer.js';
import { isArtifactVisible } from './auth/thread-visibility.js';
import { createWorkerContextPackageAuthorityReader } from './context/worker-context-authorities.js';
import { readWorkerContextPackageTrace } from './context/worker-context-package.js';
import {
  ArtifactAuthorityError,
  type CommandRequestRecord,
  type FsStore,
  StoreRecordNotFoundError,
} from './lib/store.js';
import type { OperationInvocationDependencies } from './operation-composition.js';
import type { OperationImplementations } from './operation-contract.js';
import { OperationError } from './operation-error.js';
import {
  commandInputHash,
  IdempotencyKeyConflictError,
  runIdempotentCommand,
} from './runtime/idempotent-command.js';
import { TurnStartValidationError } from './runtime/orchestrator.js';
import { updateWorkerCheckpoint, upsertWorkerCheckpoint } from './runtime/worker-checkpoints.js';
import { listWorkspaceSyncReviews } from './runtime/workspace-sync-records.js';
import { listSchedulerAdmissionEntriesForWorkspace } from './scheduler-records.js';
import type { CoreDb, WorkspaceDb } from './storage/db.js';
import { resolveDataRootPath } from './storage/fs-layout.js';

/** Exact protocol content format for each accepted Artifact import media type. */
const ARTIFACT_FORMAT_BY_MEDIA_TYPE = {
  'application/json': 'json',
  'text/markdown': 'markdown',
  'text/plain': 'text',
} as const;

/** Exact family join; the definition table alone owns ids and declarative facts. */
type ArtifactImplementations = Pick<
  OperationImplementations,
  keyof typeof ARTIFACT_OPERATION_DEFINITIONS
>;

/** Joins the existing Artifact, command and version-owned Review lifecycles without HTTP context. */
export function createArtifactOperationImplementations(
  dependencies: Pick<
    OperationInvocationDependencies,
    'store' | 'coreDb' | 'inflightCommands' | 'repositoryWorkspaceDb' | 'startModeWorkerTurn'
  >
) {
  const store = dependencies.store!;
  const coreDb = dependencies.coreDb;
  const inflightCommands = dependencies.inflightCommands!;
  const openWorkspaceDb = dependencies.repositoryWorkspaceDb!;
  const startModeWorkerTurn = dependencies.startModeWorkerTurn!;
  /** Preserves the commands' safe storage-availability 500 when opening their receipt owner fails before the command fallback. */
  const openReceiptDb = (workspaceId: string): WorkspaceDb => {
    try {
      return openWorkspaceDb(workspaceId);
    } catch {
      throw new OperationError('internal_error', 'Internal Server Error', 500);
    }
  };
  const administratorEligible = (
    context: Parameters<ArtifactImplementations['artifact.read']>[1]
  ) => context.kind === 'public' && isCurrentDeploymentAdministrator(coreDb!, context.actor);
  return {
    'artifact.list': (input, context) => {
      const actor = context.actorRef;
      try {
        return ListArtifactsResponseSchema.parse({
          items: listOutputArtifacts(
            store,
            coreDb,
            input.workspaceId,
            responsibleUserIdForActor(actor)!,
            administratorEligible(context)
          ),
        });
      } catch (error) {
        artifactOperationFailure(error);
      }
    },
    'artifact.read': (input, context) => {
      const actor = context.actorRef;
      assertArtifactWorkspaceLineage(
        responsibleUserIdForActor(actor)!,
        administratorEligible(context),
        store,
        input.workspaceId,
        input.artifactId
      );
      try {
        return store.getArtifact(input.workspaceId, input.artifactId);
      } catch (error) {
        artifactOperationFailure(error);
      }
    },
    'artifact.import': async (input, context) => {
      const actor = context.actorRef;
      const { workspaceId } = input;
      const actorId = responsibleUserIdForActor(actor)!;
      try {
        store.getWorkspace(workspaceId);
      } catch (error) {
        artifactOperationFailure(error);
      }
      try {
        assertArtifactContentDigest(input.content, input.contentDigest);
      } catch (error) {
        artifactOperationFailure(error);
      }
      const artifactId = deterministicArtifactCommandId('ar_import', [
        actorId,
        workspaceId,
        'artifact.import',
        input.requestId,
      ]);
      const workspaceDb = openReceiptDb(workspaceId);

      try {
        const response = await runIdempotentCommand({
          store,
          inflightCommands,
          command: 'artifact.import',
          requestId: input.requestId,
          scope: { workspaceId },
          input: {
            title: input.title,
            mediaType: input.mediaType,
            contentDigest: input.contentDigest,
          },
          responseKind: 'artifact',
          workspaceDb,
          execute: () => {
            const acceptedAt = new Date().toISOString();
            const artifact = store.createArtifact({
              id: artifactId,
              workspaceId,
              threadId: null,
              turnId: null,
              kind: 'file',
              title: input.title,
              status: 'ready',
              summary: null,
              version: 1,
              content: {
                format: ARTIFACT_FORMAT_BY_MEDIA_TYPE[input.mediaType],
                body: input.content,
              },
              contentDigest: input.contentDigest,
              lastMutationRequestId: input.requestId,
              origin: {
                kind: 'imported',
                sourceKind: 'direct-import',
                sourceId: input.requestId,
                sourceDigest: input.contentDigest,
                actor: { kind: 'user', id: actorId },
                requestId: input.requestId,
                recordedAt: acceptedAt,
              },
              createdAt: acceptedAt,
              updatedAt: acceptedAt,
            });
            return ImportWorkspaceArtifactResponseSchema.parse({
              artifactId: artifact.id,
              artifactVersion: artifact.version,
            });
          },
          replay: (record) =>
            replayArtifactImport(store, {
              actorId,
              artifactId,
              input,
              record,
              workspaceId,
            }),
          responseId: (result) => result.artifactId,
        });

        return response;
      } catch (error) {
        artifactOperationFailure(error);
      } finally {
        workspaceDb.sqlite.close();
      }
    },
    'artifact.introduce': async (input, context) => {
      const actor = context.actorRef;
      const { workspaceId, threadId, artifactId } = input;
      const actorId = responsibleUserIdForActor(actor)!;
      try {
        store.getWorkspace(workspaceId);
      } catch (error) {
        artifactOperationFailure(error);
      }
      const turnId = deterministicArtifactCommandId('tu_artifact', [
        actorId,
        workspaceId,
        threadId,
        'artifact.introduce',
        input.requestId,
      ]);
      const workspaceDb = openReceiptDb(workspaceId);

      try {
        const response = await runIdempotentCommand({
          store,
          inflightCommands,
          command: 'artifact.introduce',
          requestId: input.requestId,
          scope: { workspaceId, threadId },
          input: {
            artifactId,
            expectedArtifactVersion: input.expectedArtifactVersion,
          },
          responseKind: 'artifact',
          workspaceDb,
          execute: () => {
            assertArtifactWorkspaceLineage(
              actorId,
              administratorEligible(context),
              store,
              workspaceId,
              artifactId
            );
            return IntroduceWorkspaceArtifactResponseSchema.parse(
              store.introduceArtifact({
                workspaceId,
                threadId,
                artifactId,
                expectedArtifactVersion: input.expectedArtifactVersion,
                requestId: input.requestId,
                acceptedAt: new Date().toISOString(),
                turnId,
                triggerActor: { kind: 'user', id: actorId },
              })
            );
          },
          replay: (record) =>
            replayArtifactIntroduction(store, {
              actorId,
              artifactId,
              expectedArtifactVersion: input.expectedArtifactVersion,
              record,
              requestId: input.requestId,
              threadId,
              turnId,
              workspaceId,
            }),
          responseId: (result) => result.artifactId,
        });

        return response;
      } catch (error) {
        artifactOperationFailure(error);
      } finally {
        workspaceDb.sqlite.close();
      }
    },
    'artifact.review-list': (input, context) => {
      const actor = context.actorRef;
      const { workspaceId, artifactId } = input;
      assertArtifactWorkspaceLineage(
        responsibleUserIdForActor(actor)!,
        administratorEligible(context),
        store,
        workspaceId,
        artifactId
      );
      let workspaceDb: WorkspaceDb | undefined;
      try {
        store.getArtifact(workspaceId, artifactId);
        workspaceDb = openWorkspaceDb(workspaceId);
        return ListArtifactReviewsResponseSchema.parse({
          reviews: listArtifactReviews(workspaceDb).filter(
            (review) => review.artifactId === artifactId
          ),
        });
      } catch (error) {
        artifactOperationFailure(error);
      } finally {
        workspaceDb?.sqlite.close();
      }
    },
    'artifact.review.decide': async (input, context) => {
      const actor = context.actorRef;
      const { workspaceId, artifactId, artifactVersion } = input;
      const actorId = responsibleUserIdForActor(actor)!;
      try {
        store.getWorkspace(workspaceId);
      } catch (error) {
        artifactOperationFailure(error);
      }
      assertArtifactWorkspaceLineage(
        actorId,
        administratorEligible(context),
        store,
        workspaceId,
        artifactId
      );
      const workspaceDb = openReceiptDb(workspaceId);
      const feedback = input.feedback ?? null;

      try {
        if (
          listWorkspaceSyncReviews(workspaceDb, workspaceId).some(
            (review) => review.artifactId === artifactId
          )
        ) {
          throw recoveryRequired(
            'A Workspace Sync Review already owns the target Artifact presentation.'
          );
        }
        const replay = (record: CommandRequestRecord) => {
          const response = replayArtifactReviewDecision(workspaceDb, {
            actorId,
            artifactId,
            artifactVersion,
            decision: input.decision,
            feedback,
            requestId: input.requestId,
          });
          if (
            record.response.kind !== 'artifact_review' ||
            record.response.id !== response.reviewId
          ) {
            throw recoveryRequired('The Artifact Review receipt has invalid response lineage.');
          }
          if (response.followUpTurnId !== null) {
            const review = getArtifactReview(workspaceDb, artifactId, artifactVersion);
            if (input.decision !== 'needs_refinement' && input.decision !== 'redo') {
              throw recoveryRequired('The Artifact Review receipt decision is contradictory.');
            }
            const artifact = requireCurrentReviewedArtifact(store, review);
            assertArtifactReviewFollowUpProof({
              coreDb,
              decisionRequestId: input.requestId,
              expectedPrompt: artifactReviewFollowUpPrompt(
                review,
                input.decision,
                feedback ?? '',
                artifact.content.body,
                artifactMediaType(artifact.content.format),
                input.requestId
              ),
              response,
              review,
              store,
            });
          }
          return response;
        };
        const common = {
          store,
          inflightCommands,
          command: 'artifact.review.decide' as const,
          requestId: input.requestId,
          scope: { workspaceId, artifactId, artifactVersion: String(artifactVersion) },
          input: { decision: input.decision, feedback },
          responseKind: 'artifact_review' as const,
          workspaceDb,
          replay,
          responseId: (result: SubmitArtifactReviewDecisionResponse) => result.reviewId,
        };
        let response: SubmitArtifactReviewDecisionResponse;
        if (input.decision === 'needs_refinement' || input.decision === 'redo') {
          const decision = input.decision;
          if (feedback === null) {
            throw new ArtifactAuthorityError(
              'invalid_request',
              'Artifact Review follow-up feedback is required.'
            );
          }
          response = await runIdempotentCommand({
            ...common,
            execute: async () => {
              if (!coreDb) {
                throw recoveryRequired(
                  'Artifact Review follow-up scheduler authority is unavailable.'
                );
              }
              const review = getArtifactReview(workspaceDb, artifactId, artifactVersion);
              const artifact = requireCurrentReviewedArtifact(store, review);
              const decisionInput = {
                actorId,
                artifactContent: artifact.content.body,
                artifactId,
                artifactMediaType: artifactMediaType(artifact.content.format),
                artifactVersion,
                decidedAt: new Date().toISOString(),
                decision,
                feedback,
                requestId: input.requestId,
              } as const;
              const claimedResponse =
                review.decision === null ? null : decideArtifactReview(workspaceDb, decisionInput);
              const followUpTurnId =
                claimedResponse?.followUpTurnId ??
                deriveArtifactReviewFollowUpTurnId(
                  workspaceId,
                  artifactId,
                  artifactVersion,
                  input.requestId
                );
              let followUpTurnExists = true;
              try {
                store.getTurnById(followUpTurnId);
              } catch {
                followUpTurnExists = false;
              }
              if (
                followUpTurnExists ||
                listSchedulerAdmissionEntriesForWorkspace(coreDb, {
                  workspaceId,
                  statuses: ['queued', 'admitted', 'denied', 'cancelled', 'expired'],
                }).some((entry) => entry.turnId === followUpTurnId)
              ) {
                throw recoveryRequired(
                  'The Artifact Review follow-up identity already has downstream proof without its command receipt.'
                );
              }
              if (!review.sourceThreadId || !review.sourceTurnId || !review.sourceAgentId) {
                throw recoveryRequired('The Artifact Review source lineage is incomplete.');
              }
              if (
                !store
                  .getWorkspaceResources(workspaceId)
                  .agents.some(
                    (agent) => agent.id === review.sourceAgentId && agent.status === 'enabled'
                  )
              ) {
                throw new ArtifactAuthorityError(
                  'stale',
                  'The Artifact Review source Agent is not currently enabled.'
                );
              }
              if (review.materialProposal !== null) {
                assertArtifactReviewProposalTrace(coreDb, store, workspaceDb, review);
              }
              if (
                store
                  .listThreadTurns(workspaceId, review.sourceThreadId)
                  .some((turn) => !isSealedTurnTerminal(turn.status))
              ) {
                throw new ArtifactAuthorityError(
                  'thread_busy',
                  'The source Thread has a non-terminal Turn.'
                );
              }
              const result = claimedResponse ?? decideArtifactReview(workspaceDb, decisionInput);
              if (result.followUpTurnId !== followUpTurnId) {
                throw recoveryRequired('The Artifact Review follow-up identity is contradictory.');
              }

              const prompt = artifactReviewFollowUpPrompt(
                review,
                decision,
                feedback,
                artifact.content.body,
                artifactMediaType(artifact.content.format),
                input.requestId
              );
              const workerRequestId = deriveArtifactReviewWorkerRequestId(input.requestId);
              upsertWorkerCheckpoint(workspaceDb, {
                workspaceId,
                threadId: review.sourceThreadId,
                turnId: followUpTurnId,
                goalId: null,
                taskId: null,
                requestId: workerRequestId,
                requestInputHash: commandInputHash({
                  reviewId: review.reviewId,
                  artifactVersion: review.artifactVersion,
                  decision,
                  feedback,
                }),
                stage: 'preparing',
                iteration: 0,
              });
              const followUpTurn = await startModeWorkerTurn({
                store,
                triggerActor: { kind: 'user', id: actorId },
                workspaceId,
                threadId: review.sourceThreadId,
                prompt,
                requestId: workerRequestId,
                requestedAgentId: review.sourceAgentId,
                reservedTurnId: followUpTurnId,
              });
              updateWorkerCheckpoint(workspaceDb, {
                authorityActor: followUpTurn.triggerActor,
                workspaceId,
                threadId: review.sourceThreadId,
                turnId: followUpTurnId,
                stage:
                  followUpTurn.status === 'completed'
                    ? 'completed'
                    : followUpTurn.status === 'cancelled'
                      ? 'aborted'
                      : followUpTurn.status === 'failed' || followUpTurn.status === 'interrupted'
                        ? 'failed'
                        : 'running_worker',
                workerSessionId: followUpTurn.agentSessionId ?? null,
              });
              assertArtifactReviewFollowUpProof({
                coreDb,
                decisionRequestId: input.requestId,
                expectedPrompt: prompt,
                response: result,
                review,
                store,
              });
              return result;
            },
          });
        } else {
          response = await runIdempotentCommand({
            ...common,
            execute: () => {
              const review = getArtifactReview(workspaceDb, artifactId, artifactVersion);
              const artifact = requireCurrentReviewedArtifact(store, review);
              if (input.decision === 'accepted' && review.materialProposal !== null) {
                assertArtifactReviewProposalTrace(coreDb, store, workspaceDb, review);
              }
              return decideArtifactReview(workspaceDb, {
                actorId,
                artifactContent: artifact.content.body,
                artifactId,
                artifactMediaType: artifactMediaType(artifact.content.format),
                artifactVersion,
                decidedAt: new Date().toISOString(),
                decision: input.decision,
                feedback,
                requestId: input.requestId,
              });
            },
            workspaceTransaction: true,
          });
        }

        return response;
      } catch (error) {
        artifactOperationFailure(error);
      } finally {
        workspaceDb.sqlite.close();
      }
    },
  } satisfies ArtifactImplementations;
}

/**
 * Requires Artifact Workspace lineage and the authenticated actor's immutable origin audience.
 *
 * @param userId Authenticated user supplied by native invocation.
 * @param administratorEligible Current eligibility supplied by the unique authorizer.
 * @param store Product store containing the Artifact owner.
 * @param workspaceId Workspace named by the route path.
 * @param artifactId Artifact named by the route path.
 */
function assertArtifactWorkspaceLineage(
  userId: string,
  administratorEligible: boolean,
  store: FsStore,
  workspaceId: string,
  artifactId: string
): void {
  let artifact: ReturnType<FsStore['getArtifact']>;
  try {
    artifact = store.getArtifact(workspaceId, artifactId);
  } catch (error) {
    if (
      !(
        error instanceof StoreRecordNotFoundError ||
        error instanceof SyntaxError ||
        error instanceof z.ZodError
      )
    )
      throw error;
    throw new OperationError('not_found', 'Artifact not found.', 404);
  }
  if (!isArtifactVisible(store, artifact, userId, administratorEligible)) {
    throw new OperationError('not_found', 'Artifact not found.', 404);
  }
}

/**
 * Requires one unresolved Review's exact current Artifact and source Turn authority.
 *
 * @param store Product Artifact owner.
 * @param review Version-keyed Review authority.
 * @returns Exact current ready Artifact.
 * @throws ArtifactAuthorityError when current Artifact or source Turn authority is contradictory.
 */
function requireCurrentReviewedArtifact(
  store: FsStore,
  review: ArtifactReviewView
): ReturnType<FsStore['getArtifact']> {
  let artifact: ReturnType<FsStore['getArtifact']>;
  try {
    artifact = store.getArtifact(review.workspaceId, review.artifactId);
  } catch {
    throw recoveryRequired('The reviewed Artifact is unavailable.');
  }
  const origin = artifact.origin;
  if (
    artifact.version !== review.artifactVersion ||
    artifact.status !== 'ready' ||
    artifact.contentDigest !== review.contentDigest ||
    artifactContentDigest(artifact.content.body) !== review.contentDigest ||
    origin.kind !== 'turn-output' ||
    origin.threadId !== review.sourceThreadId ||
    origin.turnId !== review.sourceTurnId
  ) {
    throw recoveryRequired('The reviewed Artifact authority is contradictory.');
  }
  if (!review.sourceThreadId || !review.sourceTurnId) {
    throw recoveryRequired('The Artifact Review source lineage is incomplete.');
  }
  let sourceTurn: ReturnType<FsStore['getTurn']>;
  try {
    sourceTurn = store.getTurn(review.workspaceId, review.sourceThreadId, review.sourceTurnId);
  } catch {
    throw recoveryRequired('The Artifact Review source Turn is unavailable.');
  }
  if (
    sourceTurn.workspaceId !== review.workspaceId ||
    sourceTurn.threadId !== review.sourceThreadId ||
    sourceTurn.id !== review.sourceTurnId ||
    sourceTurn.agentId !== review.sourceAgentId
  ) {
    throw recoveryRequired('The Artifact Review source Turn authority is contradictory.');
  }
  return artifact;
}

/**
 * Verifies a non-null proposal against the source Turn's strict accepted S39 trace.
 *
 * @param coreDb Core scheduler and worker-session authority.
 * @param store Product Turn and AgentSession owner.
 * @param workspaceDb Workspace Review, Material, and package owner.
 * @param review Review whose immutable proposal must be present exactly once.
 * @throws ArtifactAuthorityError when strict trace proof is absent or contradictory.
 */
function assertArtifactReviewProposalTrace(
  coreDb: CoreDb | undefined,
  store: FsStore,
  workspaceDb: WorkspaceDb,
  review: ArtifactReviewView
): void {
  if (
    !coreDb ||
    !review.sourceThreadId ||
    !review.sourceTurnId ||
    review.materialProposal === null
  ) {
    throw recoveryRequired('The Artifact Review proposal lacks strict source proof.');
  }
  try {
    const proposal = review.materialProposal;
    const trace = readWorkerContextPackageTrace({
      authorities: createWorkerContextPackageAuthorityReader({ coreDb, store, workspaceDb }),
      workspaceId: review.workspaceId,
      threadId: review.sourceThreadId,
      turnId: review.sourceTurnId,
      workspaceRoot: resolveDataRootPath(workspaceDb.dataRoot, 'workspaces', review.workspaceId),
    });
    if (
      trace.materialSelections.filter(
        (selection) =>
          selection.materialId === proposal.materialId &&
          selection.revisionId === proposal.baseRevisionId &&
          selection.contentDigest === proposal.baseContentDigest
      ).length !== 1
    ) {
      throw new Error('The proposal tuple is not uniquely present in the source trace.');
    }
  } catch {
    throw recoveryRequired('The Artifact Review proposal source proof is contradictory.');
  }
}

/**
 * Requires the exact reserved Turn and admitted scheduler input for one follow-up result.
 *
 * @param input Expected command, response, and durable downstream owners.
 * @throws ArtifactAuthorityError when Turn or admission proof is absent or contradictory.
 */
function assertArtifactReviewFollowUpProof(input: {
  readonly coreDb: CoreDb | undefined;
  readonly decisionRequestId: string;
  readonly expectedPrompt: string;
  readonly response: SubmitArtifactReviewDecisionResponse;
  readonly review: ArtifactReviewView;
  readonly store: FsStore;
}): void {
  const turnId = input.response.followUpTurnId;
  if (!input.coreDb || !turnId) {
    throw recoveryRequired('The Artifact Review follow-up proof is incomplete.');
  }
  let turn: ReturnType<FsStore['getTurnById']>;
  try {
    turn = input.store.getTurnById(turnId);
  } catch {
    throw recoveryRequired('The Artifact Review follow-up Turn is unavailable.');
  }
  const admissions = listSchedulerAdmissionEntriesForWorkspace(input.coreDb, {
    workspaceId: input.review.workspaceId,
    statuses: ['admitted'],
  }).filter((entry) => entry.turnId === turnId);
  if (
    turn.workspaceId !== input.review.workspaceId ||
    turn.threadId !== input.review.sourceThreadId ||
    turn.agentId !== input.review.sourceAgentId ||
    admissions.length !== 1 ||
    admissions[0]?.threadId !== turn.threadId ||
    admissions[0]?.requestId !== deriveArtifactReviewWorkerRequestId(input.decisionRequestId) ||
    admissions[0]?.requestedAgentId !== input.review.sourceAgentId ||
    admissions[0]?.turnInput !== input.expectedPrompt
  ) {
    throw recoveryRequired('The Artifact Review follow-up proof is contradictory.');
  }
}

/**
 * Serializes the exact immutable Review, Artifact, feedback, and Agent selector for one retry.
 *
 * @param review Version-owned Review input.
 * @param decision Refinement or redo choice.
 * @param feedback Required reviewer feedback.
 * @param artifactContent Exact reviewed Artifact content.
 * @param mediaType Exact reviewed Artifact media type.
 * @param decisionRequestId Original Review command identity.
 * @returns Canonical worker input retained by scheduler admission and S39.
 * @throws ArtifactAuthorityError when the required source lineage is incomplete.
 */
function artifactReviewFollowUpPrompt(
  review: ArtifactReviewView,
  decision: 'needs_refinement' | 'redo',
  feedback: string,
  artifactContent: string,
  mediaType: ArtifactReviewMediaType,
  decisionRequestId: string
): string {
  if (!review.sourceThreadId || !review.sourceTurnId || !review.sourceAgentId) {
    throw recoveryRequired('The Artifact Review source lineage is incomplete.');
  }
  return serializeArtifactReviewFollowUpRequest({
    kind: 'artifact-review-follow-up',
    workspaceId: review.workspaceId,
    reviewId: review.reviewId,
    artifactId: review.artifactId,
    artifactVersion: review.artifactVersion,
    contentDigest: review.contentDigest,
    artifactContent,
    artifactMediaType: mediaType,
    sourceThreadId: review.sourceThreadId,
    sourceTurnId: review.sourceTurnId,
    sourceAgentId: review.sourceAgentId,
    materialProposal: review.materialProposal,
    decision,
    feedback,
    decisionRequestId,
    workerRequestId: deriveArtifactReviewWorkerRequestId(decisionRequestId),
  });
}

/**
 * Maps protocol Artifact content format to the immutable Review media type.
 *
 * @param format Artifact content representation.
 * @returns Exact accepted media type.
 */
function artifactMediaType(
  format: ReturnType<FsStore['getArtifact']>['content']['format']
): 'text/markdown' | 'text/plain' | 'application/json' {
  return format === 'markdown'
    ? 'text/markdown'
    : format === 'text'
      ? 'text/plain'
      : 'application/json';
}

/**
 * Replays one import receipt after proving the exact imported Artifact owner.
 *
 * @param store Shared product store.
 * @param expected Expected request, identity, and receipt proof.
 * @returns Stable imported Artifact identity.
 * @throws ArtifactAuthorityError when the receipt and Artifact disagree.
 */
function replayArtifactImport(
  store: FsStore,
  expected: {
    readonly actorId: string;
    readonly artifactId: string;
    readonly input: {
      readonly requestId: string;
      readonly contentDigest: string;
    };
    readonly record: CommandRequestRecord;
    readonly workspaceId: string;
  }
) {
  if (
    expected.record.response.kind !== 'artifact' ||
    expected.record.response.id !== expected.artifactId
  ) {
    throw recoveryRequired('The Artifact import receipt has invalid response lineage.');
  }

  let artifact: ReturnType<FsStore['getArtifact']>;
  try {
    artifact = store.getArtifact(expected.workspaceId, expected.artifactId);
  } catch {
    throw recoveryRequired('The Artifact import receipt has no matching owner.');
  }
  const origin = artifact.origin;
  if (
    artifact.workspaceId !== expected.workspaceId ||
    artifact.threadId !== null ||
    artifact.turnId !== null ||
    artifactContentDigest(artifact.content.body) !== artifact.contentDigest ||
    origin.kind !== 'imported' ||
    origin.sourceKind !== 'direct-import' ||
    origin.sourceId !== expected.input.requestId ||
    origin.sourceDigest !== expected.input.contentDigest ||
    origin.actor.kind !== 'user' ||
    origin.actor.id !== expected.actorId ||
    origin.requestId !== expected.input.requestId ||
    origin.recordedAt !== artifact.createdAt
  ) {
    throw recoveryRequired('The Artifact import receipt disagrees with its durable owner.');
  }

  return ImportWorkspaceArtifactResponseSchema.parse({
    artifactId: artifact.id,
    artifactVersion: 1,
  });
}

/**
 * Replays one introduction receipt after proving its exact Artifact, Turn, and Item tuple.
 *
 * @param store Shared product store.
 * @param expected Expected path, deterministic identities, and receipt proof.
 * @returns Stable introduction result.
 * @throws ArtifactAuthorityError when any owner is absent or contradictory.
 */
function replayArtifactIntroduction(
  store: FsStore,
  expected: {
    readonly actorId: string;
    readonly artifactId: string;
    readonly expectedArtifactVersion: number;
    readonly record: CommandRequestRecord;
    readonly requestId: string;
    readonly threadId: string;
    readonly turnId: string;
    readonly workspaceId: string;
  }
) {
  if (
    expected.record.response.kind !== 'artifact' ||
    expected.record.response.id !== expected.artifactId
  ) {
    throw recoveryRequired('The Artifact introduction receipt has invalid response lineage.');
  }

  let artifact: ReturnType<FsStore['getArtifact']>;
  let turn: ReturnType<FsStore['getTurn']>;
  try {
    artifact = store.getArtifact(expected.workspaceId, expected.artifactId);
    turn = store.getTurn(expected.workspaceId, expected.threadId, expected.turnId);
  } catch {
    throw recoveryRequired('The Artifact introduction receipt has no matching owner tuple.');
  }
  const origin = artifact.origin;
  const item = turn.items[0];
  if (
    artifact.threadId !== null ||
    artifact.turnId !== null ||
    artifactContentDigest(artifact.content.body) !== artifact.contentDigest ||
    origin.kind !== 'imported' ||
    origin.sourceKind !== 'direct-import' ||
    origin.sourceId !== origin.requestId ||
    origin.recordedAt !== artifact.createdAt ||
    turn.workspaceId !== expected.workspaceId ||
    turn.threadId !== expected.threadId ||
    turn.triggerActor.kind !== 'user' ||
    turn.triggerActor.id !== expected.actorId ||
    turn.status !== 'completed' ||
    turn.error !== null ||
    turn.configVersion !== null ||
    turn.startedAt === null ||
    turn.completedAt !== turn.startedAt ||
    turn.durationMs !== 0 ||
    turn.items.length !== 1 ||
    !item ||
    item.workspaceId !== expected.workspaceId ||
    item.threadId !== expected.threadId ||
    item.turnId !== expected.turnId ||
    item.type !== 'artifact-reference' ||
    item.status !== 'completed' ||
    item.artifactId !== expected.artifactId ||
    item.artifactVersion !== expected.expectedArtifactVersion ||
    artifact.version < item.artifactVersion ||
    item.lastMutationRequestId !== expected.requestId ||
    item.createdAt !== turn.startedAt ||
    item.completedAt !== turn.completedAt
  ) {
    throw recoveryRequired('The Artifact introduction receipt disagrees with its durable tuple.');
  }

  return IntroduceWorkspaceArtifactResponseSchema.parse({
    artifactId: artifact.id,
    artifactVersion: item.artifactVersion,
    turnId: turn.id,
    itemId: item.id,
  });
}

/**
 * Verifies exact Artifact bytes before receipt lookup.
 *
 * @param content Submitted canonical content.
 * @param expectedDigest Submitted lowercase SHA-256 digest.
 * @throws ArtifactAuthorityError when the bytes do not match.
 */
function assertArtifactContentDigest(content: string, expectedDigest: string): void {
  if (artifactContentDigest(content) !== expectedDigest) {
    throw new ArtifactAuthorityError(
      'source_digest_mismatch',
      'Artifact content does not match its digest.'
    );
  }
}

/**
 * Computes the canonical Artifact digest over exact UTF-8 content.
 *
 * @param content Exact Artifact body.
 * @returns Lowercase SHA-256 digest with its protocol prefix.
 */
function artifactContentDigest(content: string): string {
  return `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`;
}

/**
 * Derives one deterministic command-owned resource identity.
 *
 * @param prefix Resource namespace.
 * @param scope Immutable actor and command scope.
 * @returns Stable non-secret resource id.
 */
function deterministicArtifactCommandId(
  prefix: 'ar_import' | 'tu_artifact',
  scope: readonly string[]
): string {
  return `${prefix}_${createHash('sha256')
    .update(JSON.stringify(scope), 'utf8')
    .digest('hex')
    .slice(0, 24)}`;
}

/**
 * Creates the bounded S16 recovery failure used by receipt-owner guards.
 *
 * @param message Product-safe recovery diagnostic.
 * @returns Structured recovery error.
 */
function recoveryRequired(message: string): ArtifactAuthorityError {
  return new ArtifactAuthorityError('recovery_required', message);
}

/** Preserves the Artifact authority and command owners' exact refusal classes and fallback. */
function artifactOperationFailure(error: unknown): never {
  if (error instanceof OperationError) throw error;
  if (
    error instanceof ArtifactAuthorityError ||
    error instanceof ArtifactReviewError ||
    error instanceof IdempotencyKeyConflictError ||
    error instanceof TurnStartValidationError
  )
    throw new OperationError(error.code, error.message, error.status, { cause: error });
  if (
    error instanceof StoreRecordNotFoundError ||
    error instanceof SyntaxError ||
    error instanceof z.ZodError
  )
    throw new OperationError('not_found', publishedErrorMessage(error), 404, { cause: error });
  throw error;
}
