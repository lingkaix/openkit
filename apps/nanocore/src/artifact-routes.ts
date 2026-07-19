import { createHash } from 'node:crypto';

import {
  type ArtifactReviewView,
  ImportWorkspaceArtifactRequestSchema,
  ImportWorkspaceArtifactResponseSchema,
  IntroduceWorkspaceArtifactRequestSchema,
  IntroduceWorkspaceArtifactResponseSchema,
  ListArtifactReviewsResponseSchema,
  SubmitArtifactReviewDecisionRequestSchema,
  type SubmitArtifactReviewDecisionResponse,
} from '@openkit/app-api-schemas';
import { type ActorRef, ListArtifactsResponseSchema } from '@openkit/protocol';
import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

import { asApiError, asCommandError, asInvalidRequestError } from './api-errors.js';
import {
  type ArtifactReviewMediaType,
  decideArtifactReview,
  deriveArtifactReviewFollowUpTurnId,
  deriveArtifactReviewWorkerRequestId,
  getArtifactReview,
  listArtifactReviews,
  replayArtifactReviewDecision,
  serializeArtifactReviewFollowUpRequest,
} from './artifact-reviews.js';
import type { AuthVariables } from './auth/middleware.js';
import { assertAuthorizedWorkspaceLineage } from './auth/operation-authorizer.js';
import { createWorkerContextPackageAuthorityReader } from './context/worker-context-authorities.js';
import { readWorkerContextPackageTrace } from './context/worker-context-package.js';
import { ArtifactAuthorityError, type CommandRequestRecord, type FsStore } from './lib/store.js';
import { registerAppApiRoute } from './openapi.js';
import {
  commandInputHash,
  type InflightIdempotentCommand,
  runIdempotentCommand,
} from './runtime/idempotent-command.js';
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

/**
 * Registers the Core Artifact list, detail, and content routes.
 *
 * @param dependencies Hono app and request-scoped storage.
 */
export function registerArtifactRoutes({
  app,
  coreDb,
  inflightCommands,
  openWorkspaceDb,
  requestStore,
  startModeWorkerTurn,
}: {
  readonly app: Hono<{ Variables: AuthVariables }>;
  readonly coreDb: CoreDb | undefined;
  readonly inflightCommands: WeakMap<FsStore, Map<string, InflightIdempotentCommand>>;
  readonly openWorkspaceDb: (workspaceId: string) => WorkspaceDb;
  readonly requestStore: (context: Context<{ Variables: AuthVariables }>) => FsStore;
  readonly startModeWorkerTurn: (input: {
    /** Shared product store that owns the Turn. */
    readonly store: FsStore;
    /** Exact authenticated actor that triggered the follow-up Turn. */
    readonly triggerActor: ActorRef;
    readonly workspaceId: string;
    readonly threadId: string;
    readonly prompt: string;
    readonly requestId: string;
    readonly requestedAgentId: string;
    readonly reservedTurnId?: string | undefined;
  }) => Promise<ReturnType<FsStore['getTurnById']>>;
}): void {
  app.get('/api/workspaces/:workspaceId/artifacts', (c) => {
    try {
      return c.json(
        ListArtifactsResponseSchema.parse({
          items: requestStore(c).listArtifacts(c.req.param('workspaceId')),
        })
      );
    } catch (error) {
      return asApiError((error as Error).message);
    }
  });

  app.get('/api/workspaces/:workspaceId/artifacts/:artifactId', (c) => {
    const store = requestStore(c);
    const workspaceId = c.req.param('workspaceId');
    const artifactId = c.req.param('artifactId');
    assertArtifactWorkspaceLineage(c, store, workspaceId, artifactId);

    try {
      return c.json(store.getArtifact(workspaceId, artifactId));
    } catch (error) {
      return asApiError((error as Error).message);
    }
  });

  app.get('/api/workspaces/:workspaceId/artifacts/:artifactId/content', (c) => {
    const store = requestStore(c);
    const workspaceId = c.req.param('workspaceId');
    const artifactId = c.req.param('artifactId');
    assertArtifactWorkspaceLineage(c, store, workspaceId, artifactId);

    try {
      const artifact = store.getArtifact(workspaceId, artifactId);
      const content = artifact.content;

      if (!content) {
        return new Response(null, { status: 204 });
      }

      if (content.format === 'markdown') {
        return c.text(content.body, 200, { 'content-type': 'text/markdown; charset=utf-8' });
      }

      if (content.format === 'text') {
        return c.text(content.body, 200, { 'content-type': 'text/plain; charset=utf-8' });
      }

      return c.json(content);
    } catch (error) {
      return asApiError((error as Error).message);
    }
  });

  registerAppApiRoute(app, 'listArtifactReviews', (c) => {
    const workspaceId = c.req.param('workspaceId');
    const artifactId = c.req.param('artifactId');
    const store = requestStore(c);
    assertArtifactWorkspaceLineage(c, store, workspaceId, artifactId);
    let workspaceDb: WorkspaceDb | undefined;
    try {
      store.getArtifact(workspaceId, artifactId);
      workspaceDb = openWorkspaceDb(workspaceId);
      const reviews = listArtifactReviews(workspaceDb).filter(
        (review) => review.artifactId === artifactId
      );
      return c.json(ListArtifactReviewsResponseSchema.parse({ reviews }));
    } catch (error) {
      return asArtifactApiError(error);
    } finally {
      workspaceDb?.sqlite.close();
    }
  });

  registerAppApiRoute(app, 'submitArtifactReviewDecision', async (c) => {
    const parsed = SubmitArtifactReviewDecisionRequestSchema.safeParse(
      await c.req.json().catch(() => ({}))
    );
    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }
    const versionText = c.req.param('artifactVersion');
    if (!/^[1-9]\d*$/.test(versionText)) {
      return asApiError('artifactVersion must be a positive integer.', 'invalid_request', 400);
    }

    const workspaceId = c.req.param('workspaceId');
    const artifactId = c.req.param('artifactId');
    const artifactVersion = Number(versionText);
    let store: FsStore;
    try {
      store = requestStore(c);
      store.getWorkspace(workspaceId);
    } catch (error) {
      return asApiError((error as Error).message);
    }
    assertArtifactWorkspaceLineage(c, store, workspaceId, artifactId);
    const workspaceDb = openWorkspaceDb(workspaceId);
    const actorId = c.get('actor').userId;
    const input = parsed.data;
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
        scope: { workspaceId, artifactId, artifactVersion: versionText },
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
                .some((turn) => ['pending', 'running', 'awaiting_human'].includes(turn.status))
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
                  : followUpTurn.status === 'awaiting_human'
                    ? 'waiting_for_user'
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

      return c.json(response);
    } catch (error) {
      return asArtifactApiError(error);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  registerAppApiRoute(app, 'importWorkspaceArtifact', async (c) => {
    const parsed = ImportWorkspaceArtifactRequestSchema.safeParse(
      await c.req.json().catch(() => ({}))
    );
    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    const workspaceId = c.req.param('workspaceId') ?? '';
    let store: FsStore;
    try {
      store = requestStore(c);
      store.getWorkspace(workspaceId);
    } catch (error) {
      return asApiError((error as Error).message);
    }

    try {
      assertArtifactContentDigest(parsed.data.content, parsed.data.contentDigest);
    } catch (error) {
      return asArtifactApiError(error);
    }

    const actorId = c.get('actor').userId;
    const artifactId = deterministicArtifactCommandId('ar_import', [
      actorId,
      workspaceId,
      'artifact.import',
      parsed.data.requestId,
    ]);
    const workspaceDb = openWorkspaceDb(workspaceId);

    try {
      const input = parsed.data;
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

      return c.json(response, 201);
    } catch (error) {
      return asArtifactApiError(error);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  registerAppApiRoute(app, 'introduceWorkspaceArtifact', async (c) => {
    const parsed = IntroduceWorkspaceArtifactRequestSchema.safeParse(
      await c.req.json().catch(() => ({}))
    );
    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    const workspaceId = c.req.param('workspaceId') ?? '';
    const threadId = c.req.param('threadId') ?? '';
    const artifactId = c.req.param('artifactId') ?? '';
    let store: FsStore;
    try {
      store = requestStore(c);
      store.getWorkspace(workspaceId);
    } catch (error) {
      return asApiError((error as Error).message);
    }
    const actorId = c.get('actor').userId;
    const turnId = deterministicArtifactCommandId('tu_artifact', [
      actorId,
      workspaceId,
      threadId,
      'artifact.introduce',
      parsed.data.requestId,
    ]);
    const workspaceDb = openWorkspaceDb(workspaceId);

    try {
      const input = parsed.data;
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
          assertArtifactIntroductionWorkspaceLineage(c, store, workspaceId, threadId, artifactId);
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

      return c.json(response, 201);
    } catch (error) {
      return asArtifactApiError(error);
    } finally {
      workspaceDb.sqlite.close();
    }
  });
}

/**
 * Requires one scoped Artifact owner to match the centrally authorized Workspace.
 *
 * @param context Request context carrying optional central Workspace authorization.
 * @param store Product store containing the Artifact owner.
 * @param workspaceId Workspace named by the route path.
 * @param artifactId Artifact named by the route path.
 */
function assertArtifactWorkspaceLineage(
  context: Context<{ Variables: AuthVariables }>,
  store: FsStore,
  workspaceId: string,
  artifactId: string
): void {
  const access = context.get('workspaceAccess');
  if (!access) {
    return;
  }

  try {
    const artifact = store.getArtifact(workspaceId, artifactId);
    assertAuthorizedWorkspaceLineage(access, artifact.workspaceId);
  } catch {
    assertAuthorizedWorkspaceLineage(access, null);
  }
}

/**
 * Requires both children of one introduction to match the authorized Workspace.
 *
 * @param context Request context carrying optional central Workspace authorization.
 * @param store Product store containing the Thread and Artifact owners.
 * @param workspaceId Workspace named by the route path.
 * @param threadId Thread named by the route path.
 * @param artifactId Artifact named by the route path.
 */
function assertArtifactIntroductionWorkspaceLineage(
  context: Context<{ Variables: AuthVariables }>,
  store: FsStore,
  workspaceId: string,
  threadId: string,
  artifactId: string
): void {
  assertArtifactWorkspaceLineage(context, store, workspaceId, artifactId);
  const access = context.get('workspaceAccess');
  if (!access) {
    return;
  }

  try {
    const thread = store.getThread(workspaceId, threadId);
    assertAuthorizedWorkspaceLineage(access, thread.workspaceId);
  } catch {
    assertAuthorizedWorkspaceLineage(access, null);
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
 * @param store Product Turn and Agent Session owner.
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
    turn.humanGate !== null ||
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

/**
 * Maps Artifact authority failures to their exact S16 HTTP semantics.
 *
 * @param error Route or authority failure.
 * @returns Protocol-stamped API error response.
 */
function asArtifactApiError(error: unknown): Response {
  if (error instanceof HTTPException) {
    throw error;
  }
  const candidate = error as { readonly code?: unknown; readonly message?: unknown };
  const message =
    typeof candidate.message === 'string' ? candidate.message : 'Artifact request failed.';

  if (candidate.code === 'invalid_request' || candidate.code === 'source_digest_mismatch') {
    return asApiError(message, candidate.code, 400);
  }
  if (
    candidate.code === 'conflict' ||
    candidate.code === 'idempotency_key_conflict' ||
    candidate.code === 'recovery_required' ||
    candidate.code === 'stale' ||
    candidate.code === 'thread_busy'
  ) {
    return asApiError(message, candidate.code, 409);
  }
  return asCommandError(error, 'artifact_request_failed', 500);
}
