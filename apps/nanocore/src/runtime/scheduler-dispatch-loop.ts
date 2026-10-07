import { randomUUID } from 'node:crypto';
import { ActivateWorkerEnvironmentResponseSchema } from '@openkit/app-api-schemas';
import type {
  GatewayConfig,
  UserConfig,
  WorkspaceConfig,
  WorkspaceDataSourceCatalog,
  WorkspaceMcpServerCatalog,
} from '@openkit/config-schema';
import { responsibleUserIdForActor, type TurnSchema } from '@openkit/protocol';
import type { z } from 'zod';
import type { AgentManifest } from '../agents/manifest.js';
import { computeReadiness, isAgentLaunchable } from '../agents/readiness.js';
import { resolveAgentSetup } from '../agents/setup-resolver.js';
import { deriveArtifactReviewWorkerRequestId } from '../artifact-reviews.js';
import { currentSchedulerAdmissionWorkspaceAuthority } from '../auth/operation-authorizer.js';
import { StructuredWorkerDelegationRequestSchema } from '../internal-agents/delegation.js';
import { type FsStore, StoreRecordNotFoundError } from '../lib/store.js';
import type { ProviderRegistry } from '../providers/registry.js';
import {
  denySchedulerAdmissionEntry,
  findNextDispatchableSchedulerAdmissionEntry,
  listQueuedSchedulerAdmissionEntries,
  requireSchedulerAdmissionEntry,
  type SchedulerAdmissionEntryRecord,
} from '../scheduler-records.js';
import {
  type CoreDb,
  listExistingWorkspaceDatabaseScopes,
  openWorkspaceDb,
} from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import { DeterministicAgentPreparationError } from './agent-preparation-error.js';
import {
  bindSchedulerExecutionAttemptSession,
  closeSchedulerExecutionAttemptWithoutEffects,
  createSchedulerExecutionAttempt,
  markSchedulerExecutionAttemptClosing,
  requireSchedulerExecutionAttempt,
  type SchedulerExecutionAttemptRecord,
} from './execution-attempt-records.js';
import type { ExecutionBackend } from './execution-backend.js';
import {
  type StartTurnDependencies,
  startTurn,
  type TurnHandle,
  TurnStartValidationError,
  workspaceSourceRefsFromAgentManifest,
} from './orchestrator.js';
import {
  assistantPendingOutcomeSourceHash,
  listThreadPendingRequests,
} from './pending-requests.js';
import { generateUuidV7 } from './session-id.js';
import type { PrepareAgentSessionForTurnInput, TurnExecutor } from './types.js';
import { WorkerGovernanceCapacityUnavailableError } from './worker-governance-backend.js';
import { terminalizeGovernedWorkerTurn } from './worker-turn-failure.js';

/** Current composition and the exact selected admission; no placement or native proof policy lives here. */
export interface RunSchedulerDispatchLoopInput {
  agentManifests: AgentManifest[];
  coreDb: CoreDb;
  callerQueueEntryId?: string;
  createAgentSessionId?: () => string;
  createAttemptId?: () => string;
  dependencies?: StartTurnDependencies;
  maxDispatches?: number;
  now?: () => string;
  providerRegistry: ProviderRegistry;
  gatewayConfig: GatewayConfig;
  workspaceConfigs?: readonly { workspaceId: string; config: WorkspaceConfig }[];
  userConfigs?: readonly { userId: string; config: UserConfig }[];
  store: FsStore;
  turnExecutor: TurnExecutor;
  executionBackend: ExecutionBackend;
  configVersion?: number | null;
  workspaceDataSourceCatalogs?: readonly {
    workspaceId: string;
    catalog: WorkspaceDataSourceCatalog;
  }[];
  workspaceMcpServerCatalogs?: readonly {
    workspaceId: string;
    catalog: WorkspaceMcpServerCatalog;
  }[];
  onTurnCreated?: (turn: z.infer<typeof TurnSchema>, agentSessionId: string) => void;
  onDispatchAttribution?: (queueEntryId: string | null) => void;
}

/** One exact acquisition and its existing executor's full closeout. */
export interface SchedulerDispatchLoopStartedTurn {
  dispatch: {
    status: 'dispatched';
    entry: SchedulerAdmissionEntryRecord;
    attempt: SchedulerExecutionAttemptRecord;
  };
  handle: TurnHandle;
}

/** Backend busy remains accepted queued work; another Thread's fence is not a global admission veto. */
export interface SchedulerDispatchLoopResult {
  startedTurns: SchedulerDispatchLoopStartedTurn[];
  terminalResult:
    | {
        status: 'queued';
        reason:
          | 'no-queued-entry'
          | 'thread-busy'
          | 'backend-busy'
          | 'entry-publication-pending'
          | 'max-dispatches';
      }
    | { status: 'denied'; entry: SchedulerAdmissionEntryRecord };
}

/** Existing process-local invocation claim joins full closeout; no receipt, result, or claim survives its attempt. */
export type SchedulerPreparationClaims = Map<string, Promise<SchedulerDispatchLoopResult>>;
const preparationClaimsByDataRoot = new Map<string, SchedulerPreparationClaims>();

/** Returns the existing single-flight preparation owner for this Core data root. */
export function getSchedulerPreparationClaims(coreDb: CoreDb): SchedulerPreparationClaims {
  let claims = preparationClaimsByDataRoot.get(coreDb.dataRoot);
  if (!claims) {
    claims = new Map();
    preparationClaimsByDataRoot.set(coreDb.dataRoot, claims);
  }
  return claims;
}

/** Dispatches eligible FIFO work through an attempt persisted before its preparation effects. */
export async function runSchedulerDispatchLoop(
  input: RunSchedulerDispatchLoopInput
): Promise<SchedulerDispatchLoopResult> {
  const claims = getSchedulerPreparationClaims(input.coreDb);
  const joined = input.callerQueueEntryId ? claims.get(input.callerQueueEntryId) : undefined;
  if (joined) return joined;
  // Preparation is single-flight. Keep its invocation promise through closeout so product observers cannot mistake a terminal row for finished output and backend handoff.
  if (
    [...claims.keys()].some((queueEntryId) =>
      input.coreDb.sqlite
        .prepare(
          "SELECT 1 FROM scheduler_execution_attempts WHERE queue_entry_id = ? AND phase = 'open' AND operation_id IS NULL"
        )
        .get(queueEntryId)
    )
  )
    return { startedTurns: [], terminalResult: { status: 'queued', reason: 'thread-busy' } };
  const startedTurns: SchedulerDispatchLoopStartedTurn[] = [];
  const unpublishedQueueEntryIds = new Set<string>();
  for (let count = 0; count < (input.maxDispatches ?? 1); count++) {
    const entry = findNextDispatchableSchedulerAdmissionEntry(
      input.coreDb,
      unpublishedQueueEntryIds
    );
    if (!entry)
      return {
        startedTurns,
        terminalResult: {
          status: 'queued',
          reason: unpublishedQueueEntryIds.size
            ? 'entry-publication-pending'
            : listQueuedSchedulerAdmissionEntries(input.coreDb).length
              ? 'thread-busy'
              : 'no-queued-entry',
        },
      };
    if (claims.has(entry.queueEntryId))
      return { startedTurns, terminalResult: { status: 'queued', reason: 'thread-busy' } };
    if (!currentSchedulerAdmissionWorkspaceAuthority(input.coreDb, entry, 'runtime.launch', true))
      return {
        startedTurns,
        terminalResult: {
          status: 'denied',
          entry: denySchedulerAdmissionEntry(input.coreDb, {
            queueEntryId: entry.queueEntryId,
            denialReason: 'authority-denied',
          }),
        },
      };
    if (entry.backendId !== input.executionBackend.id)
      throw new Error('Queued admission does not name the configured execution backend.');
    // An incomplete cross-store publication fences only its own request/Thread. Continue
    // selecting eligible FIFO work; a receipt gap on A cannot veto independent Thread B.
    if (!schedulerEntryPublicationComplete(input, entry)) {
      unpublishedQueueEntryIds.add(entry.queueEntryId);
      count--;
      continue;
    }
    let acknowledgeSubmission!: (result: SchedulerDispatchLoopResult) => void;
    let submissionResult: SchedulerDispatchLoopResult | undefined;
    const submitted = new Promise<SchedulerDispatchLoopResult>((resolve) => {
      acknowledgeSubmission = (result) => {
        submissionResult = result;
        resolve(result);
      };
    });
    const promise = dispatchSchedulerAdmission(input, entry, acknowledgeSubmission);
    claims.set(entry.queueEntryId, promise);
    const forget = () => {
      if (claims.get(entry.queueEntryId) === promise) claims.delete(entry.queueEntryId);
    };
    void promise.then(forget, forget);
    const result = await Promise.race([promise, submitted]);
    if (result === submissionResult)
      void promise.catch((error: unknown) =>
        console.error(
          'scheduler_dispatch_failed_after_admission',
          error instanceof Error ? error.message : 'unknown'
        )
      );
    startedTurns.push(...result.startedTurns);
    if (
      result.terminalResult.status !== 'queued' ||
      result.terminalResult.reason !== 'max-dispatches'
    )
      return { startedTurns, terminalResult: result.terminalResult };
  }
  return { startedTurns, terminalResult: { status: 'queued', reason: 'max-dispatches' } };
}

/** Checks the existing receipt or receipt-free source tuple without inventing a second ready flag. */
function schedulerEntryPublicationComplete(
  input: RunSchedulerDispatchLoopInput,
  entry: SchedulerAdmissionEntryRecord
): boolean {
  try {
    const turn = input.store.getTurn(entry.workspaceId, entry.threadId, entry.turnId);
    if (turn.status !== 'pending' || turn.agentId !== entry.requestedAgentId) return false;
  } catch (error) {
    if (error instanceof StoreRecordNotFoundError) return false;
    throw error;
  }
  const workspaceDb = openWorkspaceDb(input.coreDb.dataRoot, entry.workspaceId);
  try {
    applyScopedMigrations(workspaceDb);
    const receipts = workspaceDb.sqlite
      .prepare(
        'SELECT response_id AS responseId, response_json AS responseJson FROM idempotency_requests WHERE request_id = ?'
      )
      .all(entry.requestId) as Array<{ responseId: string; responseJson: string | null }>;
    if (
      receipts.some(
        (receipt) =>
          receipt.responseId === entry.turnId ||
          (receipt.responseJson &&
            JSON.parse(receipt.responseJson)?.downstream?.turnId === entry.turnId)
      )
    )
      return true;
    const reviewReceipts = workspaceDb.sqlite
      .prepare(`SELECT review.decision_request_id AS decisionRequestId FROM artifact_reviews AS review
      JOIN idempotency_requests AS receipt ON receipt.request_id = review.decision_request_id
        AND receipt.command_name = 'artifact.review.decide' AND receipt.response_kind = 'artifact_review'
        AND receipt.response_id = review.review_id
      WHERE review.workspace_id = ? AND review.source_thread_id = ? AND review.follow_up_turn_id = ?
        AND review.source_agent_id = ?`)
      .all(entry.workspaceId, entry.threadId, entry.turnId, entry.requestedAgentId) as Array<{
      decisionRequestId: string;
    }>;
    if (
      reviewReceipts.some(
        (receipt) =>
          deriveArtifactReviewWorkerRequestId(receipt.decisionRequestId) === entry.requestId
      )
    )
      return true;
    if (assistantOutcomePublicationComplete(input.store, workspaceDb, entry)) return true;
    if (activationPublicationComplete(input, entry)) return true;
    const checkpoint = workspaceDb.sqlite
      .prepare(
        'SELECT goal_id AS goalId, task_id AS taskId FROM worker_turn_checkpoints WHERE workspace_id = ? AND thread_id = ? AND turn_id = ? AND request_id = ?'
      )
      .get(entry.workspaceId, entry.threadId, entry.turnId, entry.requestId) as
      | { goalId: string | null; taskId: string | null }
      | undefined;
    if (checkpoint?.goalId && checkpoint.taskId) return true;
    return Boolean(
      workspaceDb.sqlite
        .prepare(
          "SELECT 1 FROM pending_requests WHERE workspace_id = ? AND thread_id = ? AND delivery_turn_id = ? AND delivery_cause = 'outcome' LIMIT 1"
        )
        .get(entry.workspaceId, entry.threadId, entry.turnId)
    );
  } finally {
    workspaceDb.sqlite.close();
  }
}

/** Joins an Assistant handoff to its original decided outcome tuple, which has no command receipt. */
function assistantOutcomePublicationComplete(
  store: FsStore,
  workspaceDb: import('../storage/db.js').WorkspaceDb,
  entry: SchedulerAdmissionEntryRecord
): boolean {
  const userId = responsibleUserIdForActor(entry.triggerActor);
  if (!userId || !entry.requestId?.startsWith('pending_')) return false;
  let value: unknown;
  try {
    value = JSON.parse(entry.turnInput);
  } catch {
    return false;
  }
  const parsed = StructuredWorkerDelegationRequestSchema.safeParse(value);
  if (!parsed.success) return false;
  const itemIds = parsed.data.contextRefs.filter((ref) => ref.kind === 'item').map((ref) => ref.id);
  if (!itemIds.length) return false;
  const sources = workspaceDb.sqlite
    .prepare(`SELECT DISTINCT thread_id AS threadId, delivery_turn_id AS turnId
    FROM pending_requests WHERE workspace_id = ? AND requester_kind = 'assistant'
      AND delivery_cause = 'outcome' AND delivery = 'delivered'
      AND request_item_id IN (${itemIds.map(() => '?').join(',')})`)
    .all(entry.workspaceId, ...itemIds) as Array<{ threadId: string; turnId: string }>;
  return sources.some((source) => {
    const records = listThreadPendingRequests(
      workspaceDb.sqlite,
      entry.workspaceId,
      source.threadId
    ).filter(
      (record) => record.deliveryTurnId === source.turnId && record.requesterKind === 'assistant'
    );
    if (!records.length || records.some((record) => !itemIds.includes(record.requestItemId)))
      return false;
    const turn = store.getTurn(entry.workspaceId, source.threadId, source.turnId);
    const hash = assistantPendingOutcomeSourceHash(turn, records, userId);
    return (
      entry.requestId === `pending_${hash}` &&
      entry.threadId === `th_task_${hash.slice(0, 24)}` &&
      entry.turnId === `tu_task_${hash.slice(0, 24)}`
    );
  });
}

/** Resolves the existing administrator-home activation receipt and immutable result for its queued successor. */
function activationPublicationComplete(
  input: RunSchedulerDispatchLoopInput,
  entry: SchedulerAdmissionEntryRecord
): boolean {
  for (const workspace of listExistingWorkspaceDatabaseScopes(input.coreDb.dataRoot)) {
    const db = openWorkspaceDb(input.coreDb.dataRoot, workspace.workspaceId);
    try {
      applyScopedMigrations(db);
      const receipts = db.sqlite
        .prepare(`SELECT response_id AS artifactId FROM idempotency_requests
        WHERE command_name = 'worker_environment.activate' AND request_id = ? AND response_kind = 'artifact'
        AND json_extract(scope_json, '$.actorId') = ?`)
        .all(entry.requestId, responsibleUserIdForActor(entry.triggerActor)) as Array<{
        artifactId: string;
      }>;
      for (const receipt of receipts) {
        const artifact = input.store.getArtifact(workspace.workspaceId, receipt.artifactId);
        if (
          artifact.content.format !== 'json' ||
          artifact.lastMutationRequestId !== entry.requestId
        )
          continue;
        const result = ActivateWorkerEnvironmentResponseSchema.safeParse(
          JSON.parse(artifact.content.body)
        );
        if (
          result.success &&
          result.data.requestId === entry.requestId &&
          result.data.replaceNow?.workspaceId === entry.workspaceId &&
          result.data.replaceNow.threadId === entry.threadId &&
          result.data.replaceNow.prompt === entry.turnInput &&
          result.data.target.agentId === entry.requestedAgentId
        )
          return true;
      }
    } finally {
      db.sqlite.close();
    }
  }
  return false;
}

/** Keeps preparation, submission, and Turn closeout with their current executor owner. */
async function dispatchSchedulerAdmission(
  input: RunSchedulerDispatchLoopInput,
  entry: SchedulerAdmissionEntryRecord,
  acknowledgeSubmission: (result: SchedulerDispatchLoopResult) => void
): Promise<SchedulerDispatchLoopResult> {
  input.onDispatchAttribution?.(entry.queueEntryId);
  const responsibleUserId =
    entry.triggerActor.kind === 'user'
      ? entry.triggerActor.id
      : entry.triggerActor.responsibleUserId;
  const workspaceConfig = input.workspaceConfigs?.find(
    (candidate) => candidate.workspaceId === entry.workspaceId
  )?.config;
  const userConfig = input.userConfigs?.find(
    (candidate) => candidate.userId === responsibleUserId
  )?.config;
  const workspaceDataSourceCatalog = input.workspaceDataSourceCatalogs?.find(
    (candidate) => candidate.workspaceId === entry.workspaceId
  )?.catalog;
  const workspaceMcpServerCatalog = input.workspaceMcpServerCatalogs?.find(
    (candidate) => candidate.workspaceId === entry.workspaceId
  )?.catalog;
  const attempt = createSchedulerExecutionAttempt(input.coreDb, {
    entry,
    attemptId: (input.createAttemptId ?? (() => `attempt_${randomUUID()}`))(),
    preparationInput: {
      admission: entry,
      configVersion: input.configVersion ?? null,
      manifest: input.agentManifests.find((manifest) => manifest.id === entry.requestedAgentId),
      workspaceConfig,
      userConfig,
      workspaceDataSourceCatalog,
      workspaceMcpServerCatalog,
    },
    ...(input.now ? { now: input.now } : {}),
  });
  try {
    const setup = resolveDispatchAgentSetup(
      input,
      entry.requestedAgentId,
      entry.profileRef,
      entry.modelId,
      entry.workspaceId,
      workspaceConfig,
      userConfig
    );
    const workspaceSourceRefs = workspaceSourceRefsFromAgentManifest(
      setup.manifest,
      entry.workspaceRoots
    );
    const preparation: PrepareAgentSessionForTurnInput = {
      attemptId: attempt.attemptId,
      agentSetup: setup,
      freshAgentSessionId: (input.createAgentSessionId ?? generateUuidV7)(),
      requestId: entry.requestId,
      turn: input.store.getTurnById(entry.turnId),
      turnInput: entry.turnInput,
      workspaceCwd: entry.workspaceCwd,
      workspaceRoots: entry.workspaceRoots,
      ...(entry.workerStorageChoice ? { workerStorageChoice: entry.workerStorageChoice } : {}),
      ...(workspaceDataSourceCatalog ? { workspaceDataSourceCatalog } : {}),
      ...(workspaceMcpServerCatalog ? { workspaceMcpServerCatalog } : {}),
      ...(workspaceSourceRefs ? { workspaceSourceRefs } : {}),
    };
    if (!input.turnExecutor.prepareAgentSessionForTurn)
      throw new Error('Configured executor has no AgentSession preparation owner.');
    const prepared = await input.turnExecutor.prepareAgentSessionForTurn(input.store, preparation);
    bindSchedulerExecutionAttemptSession(input.coreDb, {
      attemptId: attempt.attemptId,
      agentSessionId: prepared.agentSessionId,
    });
    const committed = await input.turnExecutor.commitPreparedAgentSessionForTurn?.(input.store, {
      attemptId: attempt.attemptId,
      prepared,
      preparation,
    });
    if (prepared.replacementRequired && !input.turnExecutor.commitPreparedAgentSessionForTurn)
      throw new Error('Configured executor has no AgentSession replacement owner.');
    const current = requireSchedulerAdmissionEntry(input.coreDb, entry.queueEntryId);
    if (!currentSchedulerAdmissionWorkspaceAuthority(input.coreDb, current, 'runtime.launch', true))
      throw new TurnStartValidationError(
        'workspace_access_denied',
        'Workspace access denied.',
        403
      );
    const workspaceDb = openWorkspaceDb(input.coreDb.dataRoot, entry.workspaceId);
    try {
      applyScopedMigrations(workspaceDb);
      const handle = await startTurn({
        onSubmissionSettled: () => {
          const settled = requireSchedulerExecutionAttempt(input.coreDb, attempt.attemptId);
          // Preparation effects can also be accepted; only submit fixes the absolute deadline.
          if (
            settled.phase !== 'open' ||
            settled.disposition !== 'accepted' ||
            settled.deadline === null
          )
            return;
          acknowledgeSubmission({
            startedTurns: [
              {
                dispatch: { status: 'dispatched', entry: current, attempt: settled },
                handle: {
                  turn: input.store.getTurnById(entry.turnId),
                  agent: setup.manifest,
                  agentSetup: setup,
                  agentSetupRecordId: `ras_${entry.turnId}`,
                  agentSetupDiagnostics: [],
                  modelId: setup.logicalModels.preferredLogicalModelId ?? null,
                  readiness: computeReadiness(setup.manifest),
                },
              },
            ],
            terminalResult: { status: 'queued', reason: 'max-dispatches' },
          });
        },
        attemptId: attempt.attemptId,
        agentSessionId: prepared.agentSessionId,
        agentId: entry.requestedAgentId,
        agentManifests: input.agentManifests,
        agentSetupWorkspaceDb: workspaceDb,
        gatewayConfig: input.gatewayConfig,
        input: entry.turnInput,
        modelId: entry.modelId,
        ...(entry.reasoningEffort !== undefined ? { reasoningEffort: entry.reasoningEffort } : {}),
        profileId: entry.profileRef,
        providerRegistry: input.providerRegistry,
        requestId: entry.requestId,
        sessionCompatibilityKey: prepared.sessionCompatibilityKey,
        store: input.store,
        threadId: entry.threadId,
        triggerActor: entry.triggerActor,
        turnExecutor: input.turnExecutor,
        turnId: entry.turnId,
        workspaceCwd: entry.workspaceCwd,
        workerStorageChoice: committed ?? entry.workerStorageChoice ?? undefined,
        workspaceId: entry.workspaceId,
        ...(workspaceConfig ? { workspaceConfig } : {}),
        ...(userConfig ? { userConfig } : {}),
        workspaceRoots: entry.workspaceRoots,
        ...(workspaceDataSourceCatalog ? { workspaceDataSourceCatalog } : {}),
        ...(workspaceMcpServerCatalog ? { workspaceMcpServerCatalog } : {}),
        ...(workspaceSourceRefs ? { workspaceSourceRefs } : {}),
        configVersion: input.configVersion ?? null,
        ...(input.dependencies ? { dependencies: input.dependencies } : {}),
      });
      return {
        startedTurns: [
          {
            dispatch: {
              status: 'dispatched',
              entry: current,
              attempt: requireSchedulerExecutionAttempt(input.coreDb, attempt.attemptId),
            },
            handle,
          },
        ],
        terminalResult: { status: 'queued', reason: 'max-dispatches' },
      };
    } finally {
      workspaceDb.sqlite.close();
    }
  } catch (error) {
    const current = requireSchedulerExecutionAttempt(input.coreDb, attempt.attemptId);
    if (
      error instanceof WorkerGovernanceCapacityUnavailableError &&
      current.operationId === null &&
      !input.store
        .listThreadAgentSessions(entry.workspaceId, entry.threadId)
        .some((session) => session.id === current.agentSessionId && session.status === 'busy')
    ) {
      closeSchedulerExecutionAttemptWithoutEffects(input.coreDb, {
        attemptId: attempt.attemptId,
        noOutstandingEffects: true,
        cause: 'backend-busy',
        requeue: true,
      });
      return { startedTurns: [], terminalResult: { status: 'queued', reason: 'backend-busy' } };
    }
    if (current.operationId === null)
      closeSchedulerExecutionAttemptWithoutEffects(input.coreDb, {
        attemptId: attempt.attemptId,
        noOutstandingEffects: true,
        cause: 'turn-start-failed',
      });
    else
      markSchedulerExecutionAttemptClosing(input.coreDb, {
        attemptId: attempt.attemptId,
        cause: 'preparation-or-execution-failed',
      });
    const turn = input.store.getTurnById(entry.turnId);
    if (turn.status === 'pending' || turn.status === 'running')
      terminalizeGovernedWorkerTurn({
        store: input.store,
        turnId: turn.id,
        agentSessionId: current.agentSessionId,
        requestId: entry.requestId,
        outcome: 'failed',
        completedAt: input.now?.() ?? new Date().toISOString(),
        errorCode: 'worker_preparation_failed',
        message: error instanceof Error ? error.message : 'Worker preparation failed.',
      });
    throw error;
  }
}
function resolveDispatchAgentSetup(
  input: RunSchedulerDispatchLoopInput,
  requestedAgentId: string,
  profileId: string | null,
  modelId: string | null,
  workspaceId: string,
  workspaceConfig: WorkspaceConfig | undefined,
  userConfig: UserConfig | undefined
) {
  const manifest = input.agentManifests.find((candidate) => candidate.id === requestedAgentId);
  if (!manifest) {
    throw new TurnStartValidationError(
      'agent_not_found',
      `Agent not found: ${requestedAgentId}.`,
      409
    );
  }
  const readiness = computeReadiness(manifest);
  if (!isAgentLaunchable(readiness)) {
    throw new TurnStartValidationError(
      'agent_not_ready',
      `Agent ${requestedAgentId} readiness is ${readiness.status}.`,
      409
    );
  }
  const resolved = resolveAgentSetup(manifest, {
    gatewayConfig: input.gatewayConfig,
    providerRegistry: input.providerRegistry,
    selectedProfileId: profileId,
    requestedLogicalModelId: modelId,
    workspaceId,
    ...(workspaceConfig ? { workspaceConfig } : {}),
    ...(userConfig ? { userConfig } : {}),
  });
  if (!resolved.setup || resolved.diagnostics.length > 0) {
    const message =
      resolved.diagnostics.map((diagnostic) => diagnostic.message).join('\n') ||
      `Agent ${requestedAgentId} setup is unavailable.`;
    // Classify only known input-bound diagnostics; new or missing dependency failures stay queued.
    if (
      resolved.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === 'agent_setup.invalid_default_profile' ||
          diagnostic.code === 'agent_setup.duplicate_credential_requirement' ||
          diagnostic.code === 'agent_setup.missing_credential_binding' ||
          diagnostic.code === 'agent_setup.logical_model_not_allowed' ||
          diagnostic.code === 'agent_setup.unsupported_required_feature'
      )
    ) {
      throw new DeterministicAgentPreparationError(message, 'agent_not_ready', 409);
    }
    throw new TurnStartValidationError('agent_not_ready', message, 409);
  }
  return resolved.setup;
}
