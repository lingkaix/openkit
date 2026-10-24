import {
  type ActorRef,
  responsibleUserIdForActor,
  type StopReason,
  type TurnSchema,
  workspaceIdForOwner,
} from '@openkit/protocol';
import type { z } from 'zod';
import { publishedErrorMessage } from '../api-errors.js';
import type { Actor } from '../auth/identity.js';
import { currentWorkspaceAuthority } from '../auth/operation-authorizer.js';
import { serializeStructuredWorkerDelegationRequest } from '../internal-agents/delegation.js';
import type { FsStore } from '../lib/store.js';
import { requireSchedulerAdmissionEntry } from '../scheduler-records.js';
import {
  ControlStoreWorkerError,
  getControlStoreWorkerClient,
} from '../storage/control-store-worker-client.js';
import { type CoreDb, openWorkspaceReadDb, type WorkspaceDb } from '../storage/db.js';
import { readPublishedTurnIdentities } from '../storage/workspace-file-records.js';
import {
  listSchedulerExecutionAttemptsForTurn,
  requireSchedulerExecutionAttempt,
} from './execution-attempt-records.js';
import type { GoalTaskAdmission } from './goal-task-admission.js';
import { TurnStartValidationError } from './orchestrator.js';
import type { PreparedNextTurn } from './prepare-next-turn.js';
import { validateLiveProductTurnAdmission } from './product-turn-start.js';
import { type StopAfterTurnDecision, shouldStopAfterTurn } from './stop-after-turn.js';
import {
  createWorkerCheckpointContextDiagnostics,
  createWorkerCheckpointEvidenceDiagnostics,
  getWorkerCheckpoint,
  updateWorkerCheckpoint,
  type WorkerCheckpointContextAssemblySummary,
  type WorkerCheckpointRecord,
} from './worker-checkpoints.js';
import { workerTurnStageForStopReason } from './worker-stage.js';

/** Materializes one acknowledged checkpoint on a scoped read-only handle before the next effect or await. */
function readWorkerCheckpoint(
  workspaceDb: WorkspaceDb,
  workspaceId: string,
  threadId: string,
  turnId: string
): WorkerCheckpointRecord | null {
  const reader = openWorkspaceReadDb(workspaceDb.dataRoot, workspaceDb.workspaceId);
  try {
    return getWorkerCheckpoint(reader, workspaceId, threadId, turnId);
  } finally {
    reader.sqlite.close();
  }
}

/**
 * Effect that prepares worker-visible context and delegation data.
 */
export type WorkerTurnLoopPrepareEffect = () => PreparedNextTurn | Promise<PreparedNextTurn>;

/**
 * Input passed to the worker turn reservation effect.
 */
export interface WorkerTurnLoopReserveTurnInput {
  /** Prepared delegation payload that frames the worker turn. */
  readonly prepared: PreparedNextTurn;
}

/**
 * Worker turn reservation effect result.
 */
export interface WorkerTurnLoopReserveTurnResult {
  /** Stable turn id for the worker boundary. */
  readonly turnId: string;
}

/**
 * Pure synchronous effect that selects stable Turn lineage before native reservation.
 */
export type WorkerTurnLoopReserveTurnEffect = (
  input: WorkerTurnLoopReserveTurnInput
) => WorkerTurnLoopReserveTurnResult;

/**
 * Input passed to the worker start effect.
 */
export interface WorkerTurnLoopStartWorkerInput {
  /** Reserved worker turn id. */
  readonly turnId: string;
  /** Prepared worker delegation payload. */
  readonly prepared: PreparedNextTurn;
  /** Await this exact binding before acknowledging admission or entering execution. */
  readonly onAdmitted: (
    turn: z.infer<typeof TurnSchema>,
    agentSessionId: string | null
  ) => void | Promise<void>;
}

/**
 * Worker start effect result.
 */
export interface WorkerTurnLoopStartWorkerResult {
  /** Exact admitted AgentSession returned after worker execution. */
  readonly workerSessionId?: string | null;
}

/**
 * Effect that starts the host worker after the pre-run checkpoint is durable.
 */
export type WorkerTurnLoopStartWorkerEffect = (
  input: WorkerTurnLoopStartWorkerInput
) => WorkerTurnLoopStartWorkerResult | Promise<WorkerTurnLoopStartWorkerResult>;

/**
 * Input passed to the worker completion effect.
 */
export interface WorkerTurnLoopAwaitWorkerInput {
  /** Reserved worker turn id. */
  readonly turnId: string;
  /** Prepared worker delegation payload. */
  readonly prepared: PreparedNextTurn;
  /** AgentSession bound at durable worker admission. */
  readonly workerSessionId: string | null;
}

/**
 * Worker completion effect result.
 */
export interface WorkerTurnLoopAwaitWorkerResult {
  /** Terminal stop reason reported by the worker. */
  readonly stopReason: StopReason;
  /** Relevant terminal item ids, when available. */
  readonly itemIds?: readonly string[];
  /** Relevant terminal artifact ids, when available. */
  readonly artifactIds?: readonly string[];
  /** Optional redacted or redactable diagnostics summary. */
  readonly diagnosticsSummary?: string | null;
}

/**
 * Effect that waits for or observes the bounded worker terminal result.
 */
export type WorkerTurnLoopAwaitWorkerEffect = (
  input: WorkerTurnLoopAwaitWorkerInput
) => WorkerTurnLoopAwaitWorkerResult | Promise<WorkerTurnLoopAwaitWorkerResult>;

/**
 * Input used to execute one worker turn loop.
 */
export interface RunWorkerTurnLoopInput {
  /** Product store owning the exact Turn outcome. */
  readonly store: FsStore;
  /** Core database owning current Workspace authority. */
  readonly coreDb: CoreDb;
  /** Immutable actor responsible for this worker effect. */
  readonly triggerActor: ActorRef;
  /** Authenticating request actor when the caller still holds the HTTP credential context. */
  readonly requestActor?: Actor;
  /** Open workspace-scope database handle for worker checkpoint storage. */
  readonly workspaceDb: WorkspaceDb;
  /** Workspace that owns the worker turn. */
  readonly workspaceId: string;
  /** Thread that owns the worker turn. */
  readonly threadId: string;
  /** Mode-derived immutable Turn identity available before preparation or replay effects. */
  readonly reservedTurnId: string;
  /** Optional goal id associated with the worker turn. */
  readonly goalId?: string | null;
  /** Optional goal task id associated with the worker turn. */
  readonly taskId?: string | null;
  /** Original Goal Task citation committed with launch admission and the checkpoint. */
  readonly goalTaskAdmission?: GoalTaskAdmission;
  /** Command request that owns this worker envelope. */
  readonly requestId: string;
  /** Hash of the canonical command input without raw request content. */
  readonly requestInputHash: string;
  /** Whether a normal completion should stop for review. */
  readonly reviewRequired: boolean;
  /** Remaining worker iterations after this turn. Omitted means this attempt cannot continue. */
  readonly remainingWorkerIterations?: number;
  /** Effect that prepares worker-visible context. */
  readonly prepare: WorkerTurnLoopPrepareEffect;
  /** Pure synchronous effect that selects stable worker Turn lineage before native reservation. */
  readonly reserveTurn: WorkerTurnLoopReserveTurnEffect;
  /** Effect that starts the worker after checkpointing. */
  readonly startWorker: WorkerTurnLoopStartWorkerEffect;
  /** Effect that returns the bounded worker outcome. */
  readonly awaitWorker: WorkerTurnLoopAwaitWorkerEffect;
  /** Optional clock used by deterministic tests. */
  readonly now?: () => string;
}

/**
 * Result returned after one worker turn loop reaches a terminal outcome.
 */
export interface RunWorkerTurnLoopResult {
  /** Reserved worker turn id. */
  readonly turnId: string;
  /** Prepared worker delegation payload. */
  readonly prepared: PreparedNextTurn;
  /** Host worker session id, when available. */
  readonly workerSessionId: string | null;
  /** Stable stop-after-turn decision. */
  readonly stopDecision: StopAfterTurnDecision;
  /** Evidence surfaced by the worker outcome. */
  readonly evidence: {
    /** Relevant terminal item ids. */
    readonly itemIds: readonly string[];
    /** Relevant terminal artifact ids. */
    readonly artifactIds: readonly string[];
  };
  /** Product-safe summary of the context selected for this worker turn. */
  readonly contextAssembly: WorkerCheckpointContextAssemblySummary;
}

/**
 * Runs the app-local worker turn envelope around prepare, checkpoint, worker start, and terminal save.
 *
 * @param input Worker turn loop input and effects.
 * @returns Terminal worker loop result.
 * @throws Error when preparation, turn reservation, worker start, or worker completion fails.
 */
export async function runWorkerTurnLoop(
  input: RunWorkerTurnLoopInput
): Promise<RunWorkerTurnLoopResult> {
  // Command names can share a request UUID; only the mode-derived reserved Turn owns this attempt.
  if (
    input.coreDb.sqlite
      .prepare('SELECT 1 FROM scheduler_admission_entries WHERE turn_id = ? LIMIT 1')
      .get(input.reservedTurnId)
  ) {
    throw new TurnStartValidationError(
      'recovery_required',
      'The worker request already has scheduler admission history.',
      409
    );
  }
  const prepared = await input.prepare();
  if (
    !currentWorkspaceAuthority(
      input.coreDb,
      input.workspaceId,
      input.triggerActor,
      'runtime.launch',
      true,
      input.requestActor
    )
  ) {
    throw new TurnStartValidationError('workspace_access_denied', 'Workspace access denied.', 403);
  }
  const contextAssembly = createContextAssemblySummary(prepared);
  const reserved = input.reserveTurn({ prepared });
  if (
    reserved.turnId !== input.reservedTurnId ||
    readWorkerCheckpoint(input.workspaceDb, input.workspaceId, input.threadId, reserved.turnId)
  ) {
    throw new TurnStartValidationError(
      'recovery_required',
      'The worker invocation does not own a fresh exact checkpoint.',
      409
    );
  }
  const checkpoint = await getControlStoreWorkerClient().workspaceCapability(input.workspaceDb, {
    kind: 'checkpoint',
    input: {
      kind: 'reserve',
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      turnId: reserved.turnId,
      goalId: input.goalId ?? null,
      taskId: input.taskId ?? null,
      requestId: input.requestId,
      requestInputHash: input.requestInputHash,
      contextDigest: prepared.contextPackageDigest,
      diagnosticsSummary: createWorkerCheckpointContextDiagnostics(contextAssembly),
      now: input.now?.() ?? new Date().toISOString(),
      ...(input.goalTaskAdmission ? { goalTaskAdmission: input.goalTaskAdmission } : {}),
    },
  });
  if (!checkpoint || typeof checkpoint !== 'object' || !('checkpointId' in checkpoint))
    throw new TypeError('Invalid native checkpoint reserve result.');
  const turn = { ...reserved, checkpoint };

  let workerSessionId: string | null = null;
  let admissionObserved = false;
  let closeoutFailed = false;
  let closeoutFailure: unknown;

  try {
    const started = await Promise.resolve()
      .then(() =>
        input.startWorker({
          turnId: turn.turnId,
          prepared,
          onAdmitted: async (created, agentSessionId) => {
            admissionObserved = true;
            const checkpoint = readWorkerCheckpoint(
              input.workspaceDb,
              input.workspaceId,
              input.threadId,
              turn.turnId
            );
            const admission = validateLiveProductTurnAdmission({
              coreDb: input.coreDb,
              store: input.store,
              actorId: input.triggerActor.id,
              workspaceId: input.workspaceId,
              threadId: input.threadId,
              requestId: input.requestId,
              turnId: turn.turnId,
            });
            if (
              created.id !== turn.turnId ||
              workspaceIdForOwner(created.owner) !== input.workspaceId ||
              created.threadId !== input.threadId ||
              (admission.attempt?.agentSessionId ?? null) !== agentSessionId ||
              admission.admission.turnInput !==
                serializeStructuredWorkerDelegationRequest(prepared.delegationRequest) ||
              !checkpoint ||
              checkpoint.requestId !== input.requestId ||
              checkpoint.requestInputHash !== input.requestInputHash ||
              checkpoint.goalId !== (input.goalId ?? null) ||
              checkpoint.taskId !== (input.taskId ?? null) ||
              checkpoint.iteration !== 0 ||
              checkpoint.contextDigest !== prepared.contextPackageDigest ||
              checkpoint.stage !== 'preparing' ||
              checkpoint.workerSessionId !== null ||
              checkpoint.stopReason !== null
            ) {
              throw new TurnStartValidationError(
                'recovery_required',
                'Worker checkpoint admission lineage requires recovery.',
                409
              );
            }
            if (agentSessionId !== null) {
              const bound = await getControlStoreWorkerClient().workspaceCapability(
                input.workspaceDb,
                {
                  kind: 'checkpoint',
                  input: {
                    kind: 'bind',
                    workspaceId: input.workspaceId,
                    threadId: input.threadId,
                    turnId: turn.turnId,
                    requestId: input.requestId,
                    agentSessionId,
                    now: input.now?.() ?? new Date().toISOString(),
                  },
                }
              );
              if (bound !== true)
                throw new TurnStartValidationError(
                  'recovery_required',
                  'Worker checkpoint admission lineage requires recovery.',
                  409
                );
            }
            workerSessionId = agentSessionId;
          },
        })
      )
      .catch((error: unknown) => {
        // A cleanup error cannot erase an already published successful outcome. Finish
        // only its checkpoint projection below; the original error still fences closeout.
        if (!admissionObserved || input.store.getTurnById(turn.turnId).status !== 'completed')
          throw error;
        closeoutFailed = true;
        closeoutFailure = error;
        return {
          workerSessionId:
            readWorkerCheckpoint(input.workspaceDb, input.workspaceId, input.threadId, turn.turnId)
              ?.workerSessionId ?? null,
        };
      });
    workerSessionId =
      readWorkerCheckpoint(input.workspaceDb, input.workspaceId, input.threadId, turn.turnId)
        ?.workerSessionId ?? workerSessionId;
    if (!workerSessionId || started.workerSessionId !== workerSessionId) {
      throw new TurnStartValidationError(
        'recovery_required',
        'Worker completion contradicts its checkpoint admission binding.',
        409
      );
    }

    const worker = await input.awaitWorker({
      turnId: turn.turnId,
      prepared,
      workerSessionId,
    });
    if (closeoutFailed && workerTurnStageForStopReason(worker.stopReason) !== 'completed')
      throw closeoutFailure;
    const stopDecision = shouldStopAfterTurn({
      stopReason: worker.stopReason,
      reviewRequired: input.reviewRequired,
      ...(input.remainingWorkerIterations !== undefined
        ? { remainingWorkerIterations: input.remainingWorkerIterations }
        : {}),
    });
    const evidence = {
      itemIds: [...(worker.itemIds ?? [])],
      artifactIds: [...(worker.artifactIds ?? [])],
    };

    await updateWorkerCheckpoint(input.workspaceDb, {
      authorityActor: input.triggerActor,
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      turnId: turn.turnId,
      stage: workerTurnStageForStopReason(worker.stopReason),
      stopReason: worker.stopReason,
      diagnosticsSummary: createWorkerCheckpointEvidenceDiagnostics(
        evidence,
        contextAssembly,
        worker.diagnosticsSummary
      ),
      ...(input.now ? { now: input.now } : {}),
    });
    if (closeoutFailed) throw closeoutFailure;

    return {
      turnId: turn.turnId,
      prepared,
      workerSessionId,
      stopDecision,
      evidence,
      contextAssembly,
    };
  } catch (error) {
    // An unknown accepted publication is not proof that this invocation can remove or fail its preparation.
    if (error instanceof ControlStoreWorkerError && error.commit === 'unknown') throw error;
    if (
      !admissionObserved &&
      (await removeOwnCancelledPreparation(input, turn.checkpoint, prepared))
    ) {
      throw error;
    }
    // An exception cannot decide an already admitted or partially persisted worker outcome.
    // Preserve its owner tuple, including restart-cleanup interruption and completed closeout.
    const checkpoint = readWorkerCheckpoint(
      input.workspaceDb,
      input.workspaceId,
      input.threadId,
      turn.turnId
    );
    if (
      input.coreDb.sqlite
        .prepare('SELECT 1 FROM scheduler_admission_entries WHERE turn_id = ? LIMIT 1')
        .get(turn.turnId) ||
      (error instanceof TurnStartValidationError && error.code === 'recovery_required') ||
      !checkpoint ||
      checkpoint.stage !== 'preparing' ||
      checkpoint.workerSessionId !== null ||
      checkpoint.stopReason !== null ||
      input.store
        .listThreadTurns(input.workspaceId, input.threadId)
        .some((candidate) => candidate.id === turn.turnId) ||
      listSchedulerExecutionAttemptsForTurn(input.coreDb, {
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        turnId: turn.turnId,
      }).length > 0
    ) {
      throw error;
    }
    await updateWorkerCheckpoint(input.workspaceDb, {
      authorityActor: input.triggerActor,
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      turnId: turn.turnId,
      stage: 'failed',
      stopReason: 'error',
      diagnosticsSummary: publishedErrorMessage(
        error,
        error instanceof Error ? undefined : String(error)
      ),
      ...(input.now ? { now: input.now } : {}),
    });

    throw error;
  }
}

/**
 * Creates a product-safe context assembly summary from prepared worker inputs.
 *
 * @param prepared Prepared worker turn payload.
 * @returns Context assembly summary safe for App API and recovery diagnostics.
 */
function createContextAssemblySummary(
  prepared: PreparedNextTurn
): WorkerCheckpointContextAssemblySummary {
  return {
    contextDigest: prepared.contextPackageDigest,
    contextRefs: prepared.delegationRequest.contextRefs,
    knowledgeSelectionInput: prepared.knowledgeSelectionInput,
  };
}

/**
 * Removes only this invocation's unchanged preparation after durable cancellation and a complete no-execution proof.
 *
 * Core cancellation is already committed; the native Workspace transition does not promise cross-store atomicity. Any contradiction preserves the checkpoint and original refusal. Process loss or removal failure leaves the existing inspection path authoritative.
 * @param input Live invocation owning the checkpoint and request.
 * @param ownCheckpoint Exact preparation written by this invocation before starting the Worker.
 * @param prepared Exact serialized worker request passed to product admission.
 * @returns Whether the preparation checkpoint was removed.
 */
async function removeOwnCancelledPreparation(
  input: RunWorkerTurnLoopInput,
  ownCheckpoint: WorkerCheckpointRecord,
  prepared: PreparedNextTurn
): Promise<boolean> {
  const checkpoint = readWorkerCheckpoint(
    input.workspaceDb,
    input.workspaceId,
    input.threadId,
    ownCheckpoint.turnId
  );
  if (
    !checkpoint ||
    JSON.stringify(checkpoint) !== JSON.stringify(ownCheckpoint) ||
    checkpoint.stage !== 'preparing' ||
    checkpoint.workerSessionId !== null ||
    checkpoint.stopReason !== null
  )
    return false;
  const rows = input.coreDb.sqlite
    .prepare('SELECT queue_entry_id AS id FROM scheduler_admission_entries WHERE turn_id = ?')
    .all(checkpoint.turnId) as { id: string }[];
  if (rows.length !== 1) return false;
  const admission = requireSchedulerAdmissionEntry(input.coreDb, rows[0]!.id, {
    workspaceId: input.workspaceId,
  });
  // Both owners receive these identities from the initiating mode; product-start copies the reserved Turn and exact serialized request into its admission.
  if (
    admission.status !== 'cancelled' ||
    admission.workspaceId !== input.workspaceId ||
    admission.threadId !== input.threadId ||
    admission.turnId !== checkpoint.turnId ||
    admission.requestId !== input.requestId ||
    admission.triggerActor.kind !== input.triggerActor.kind ||
    admission.triggerActor.id !== input.triggerActor.id ||
    responsibleUserIdForActor(admission.triggerActor) !==
      responsibleUserIdForActor(input.triggerActor) ||
    admission.turnInput !== serializeStructuredWorkerDelegationRequest(prepared.delegationRequest)
  )
    return false;
  const coreEffects = input.coreDb.sqlite
    .prepare(`
    SELECT 1 FROM scheduler_execution_attempts WHERE turn_id = @turn
    UNION ALL SELECT 1 FROM worker_backend_sessions WHERE turn_id = @turn
    UNION ALL SELECT 1 FROM worker_control_records WHERE turn_id = @turn
    UNION ALL SELECT 1 FROM worker_control_rejected_evidence WHERE turn_id = @turn
    UNION ALL SELECT 1 FROM worker_control_sequence_fingerprints WHERE turn_id = @turn
    UNION ALL SELECT 1 FROM agent_session_runtime_bindings WHERE current_turn_id = @turn
    UNION ALL SELECT 1 FROM idempotency_requests WHERE response_id = @turn OR json_extract(response_json, '$.downstream.turnId') = @turn
    LIMIT 1`)
    .get({
      turn: checkpoint.turnId,
    });
  if (coreEffects) return false;
  const dataRoot = input.store.getDataRoot();
  if (!dataRoot || dataRoot !== input.coreDb.dataRoot || input.workspaceDb.dataRoot !== dataRoot)
    return false;
  const history = readPublishedTurnIdentities(dataRoot);
  if (
    history.status !== 'readable' ||
    history.turns.some((turn) => turn.turnId === checkpoint.turnId)
  )
    return false;
  // The native same-Turn prefix rechecks Turn absence and the complete Workspace/AEP proof before exact deletion.
  const removed = await getControlStoreWorkerClient().workspaceCapability(input.workspaceDb, {
    kind: 'checkpoint',
    input: { kind: 'clear-cancelled', ...checkpoint },
  });
  if (typeof removed !== 'boolean') throw new TypeError('Invalid native checkpoint clear result.');
  return removed;
}

/** Binds an admitted checkpoint when preparation selects its actual session, before worker effects. */
export async function bindWorkerCheckpointToPreparedSession(input: {
  readonly coreDb: CoreDb;
  readonly workspaceDb: WorkspaceDb;
  readonly store: FsStore;
  readonly workspaceId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly requestId: string | null;
  readonly agentSessionId: string;
  readonly attemptId: string;
}): Promise<void> {
  const checkpoint = readWorkerCheckpoint(
    input.workspaceDb,
    input.workspaceId,
    input.threadId,
    input.turnId
  );
  if (!checkpoint) return; // Frozen outcome input has its own existing owner.
  const attempt = requireSchedulerExecutionAttempt(input.coreDb, input.attemptId);
  input.store.getTurnById(input.turnId);
  if (
    attempt.phase !== 'open' ||
    attempt.workspaceId !== input.workspaceId ||
    attempt.threadId !== input.threadId ||
    attempt.turnId !== input.turnId ||
    attempt.agentSessionId !== input.agentSessionId
  )
    throw new TurnStartValidationError(
      'recovery_required',
      'Prepared session contradicts its exact checkpoint.',
      409
    );
  const bound = await getControlStoreWorkerClient().workspaceCapability(input.workspaceDb, {
    kind: 'checkpoint',
    input: {
      kind: 'bind',
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      turnId: input.turnId,
      requestId: input.requestId,
      agentSessionId: input.agentSessionId,
      now: new Date().toISOString(),
    },
  });
  if (bound !== true)
    throw new TurnStartValidationError(
      'recovery_required',
      'Prepared session contradicts its exact checkpoint.',
      409
    );
}
