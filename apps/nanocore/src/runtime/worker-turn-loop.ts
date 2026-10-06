import {
  type ActorRef,
  responsibleUserIdForActor,
  type StopReason,
  type TurnSchema,
} from '@openkit/protocol';
import type { z } from 'zod';
import { publishedErrorMessage } from '../api-errors.js';

import type { Actor } from '../auth/identity.js';
import { currentWorkspaceAuthority } from '../auth/operation-authorizer.js';
import { serializeStructuredWorkerDelegationRequest } from '../internal-agents/delegation.js';
import type { FsStore } from '../lib/store.js';
import { recordWorkerTurnLaunchDecision } from '../policy/permission-decisions.js';
import {
  listSchedulerSessionLeasesForTurn,
  requireSchedulerAdmissionEntry,
} from '../scheduler-records.js';
import type { CoreDb, WorkspaceDb } from '../storage/db.js';
import { readPublishedTurnIdentities } from '../storage/workspace-file-records.js';
import { listExportableAgentEnvironmentPackageSnapshots } from './aep-snapshot-ledger.js';
import { TurnStartValidationError } from './orchestrator.js';
import type { PreparedNextTurn } from './prepare-next-turn.js';
import { validateLiveProductTurnAdmission } from './product-turn-start.js';
import { type StopAfterTurnDecision, shouldStopAfterTurn } from './stop-after-turn.js';
import {
  clearWorkerCheckpoint,
  createWorkerCheckpointContextDiagnostics,
  createWorkerCheckpointEvidenceDiagnostics,
  getWorkerCheckpoint,
  updateWorkerCheckpoint,
  upsertWorkerCheckpoint,
  type WorkerCheckpointContextAssemblySummary,
  type WorkerCheckpointRecord,
} from './worker-checkpoints.js';
import { workerTurnStageForStopReason } from './worker-stage.js';

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
 * Effect that reserves stable turn lineage before checkpointing begins.
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
  /** Binds the exact lease before acknowledging admission or entering execution. */
  readonly onAdmitted: (turn: z.infer<typeof TurnSchema>, agentSessionId: string) => void;
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
  /** Effect that reserves stable worker turn lineage before checkpointing. */
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
  const turn = input.workspaceDb.sqlite.transaction(() => {
    const reserved = input.reserveTurn({ prepared });
    if (
      reserved.turnId !== input.reservedTurnId ||
      getWorkerCheckpoint(input.workspaceDb, input.workspaceId, input.threadId, reserved.turnId)
    ) {
      throw new TurnStartValidationError(
        'recovery_required',
        'The worker invocation does not own a fresh exact checkpoint.',
        409
      );
    }
    recordWorkerTurnLaunchDecision({
      workspaceDb: input.workspaceDb,
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      turnId: reserved.turnId,
      goalId: input.goalId ?? null,
      taskId: input.taskId ?? null,
      ...(input.now ? { now: new Date(input.now()) } : {}),
    });
    const checkpoint = upsertWorkerCheckpoint(input.workspaceDb, {
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      turnId: reserved.turnId,
      goalId: input.goalId ?? null,
      taskId: input.taskId ?? null,
      requestId: input.requestId,
      requestInputHash: input.requestInputHash,
      stage: 'preparing',
      iteration: 0,
      contextDigest: prepared.contextPackageDigest,
      diagnosticsSummary: createWorkerCheckpointContextDiagnostics(contextAssembly),
      ...(input.now ? { now: input.now } : {}),
    });
    return { ...reserved, checkpoint };
  })();

  let workerSessionId: string | null = null;
  let admissionObserved = false;

  try {
    const started = await input.startWorker({
      turnId: turn.turnId,
      prepared,
      onAdmitted: (created, agentSessionId) => {
        admissionObserved = true;
        const checkpoint = getWorkerCheckpoint(
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
          created.workspaceId !== input.workspaceId ||
          created.threadId !== input.threadId ||
          admission.lease.agentSessionId !== agentSessionId ||
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
        updateWorkerCheckpoint(input.workspaceDb, {
          authorityActor: input.triggerActor,
          workspaceId: input.workspaceId,
          threadId: input.threadId,
          turnId: turn.turnId,
          stage: 'running_worker',
          workerSessionId: agentSessionId,
          ...(input.now ? { now: input.now } : {}),
        });
        workerSessionId = agentSessionId;
      },
    });
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

    updateWorkerCheckpoint(input.workspaceDb, {
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

    return {
      turnId: turn.turnId,
      prepared,
      workerSessionId,
      stopDecision,
      evidence,
      contextAssembly,
    };
  } catch (error) {
    if (!admissionObserved && removeOwnCancelledPreparation(input, turn.checkpoint, prepared)) {
      throw error;
    }
    // An exception cannot decide an already admitted or partially persisted worker outcome.
    // Preserve its owner tuple, including restart-cleanup interruption and completed closeout.
    const checkpoint = getWorkerCheckpoint(
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
      listSchedulerSessionLeasesForTurn(input.coreDb, {
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        turnId: turn.turnId,
      }).length > 0
    ) {
      throw error;
    }
    updateWorkerCheckpoint(input.workspaceDb, {
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
 * Core cancellation is already committed; this synchronous Workspace transaction does not promise cross-store atomicity. Any contradiction preserves the checkpoint and original refusal. Process loss or removal failure leaves the existing inspection path authoritative.
 * @param input Live invocation owning the checkpoint and request.
 * @param ownCheckpoint Exact preparation written by this invocation before starting the Worker.
 * @param prepared Exact serialized worker request passed to product admission.
 * @returns Whether the preparation checkpoint was removed.
 */
function removeOwnCancelledPreparation(
  input: RunWorkerTurnLoopInput,
  ownCheckpoint: WorkerCheckpointRecord,
  prepared: PreparedNextTurn
): boolean {
  return input.workspaceDb.sqlite.transaction(() => {
    const checkpoint = getWorkerCheckpoint(
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
      SELECT 1 FROM scheduler_placement_plans WHERE turn_id = @turn OR queue_entry_id = @queue
      UNION ALL SELECT 1 FROM scheduler_session_leases WHERE turn_id = @turn
      UNION ALL SELECT 1 FROM worker_backend_sessions WHERE turn_id = @turn
      UNION ALL SELECT 1 FROM worker_control_records WHERE turn_id = @turn
      UNION ALL SELECT 1 FROM worker_control_rejected_evidence WHERE turn_id = @turn
      UNION ALL SELECT 1 FROM worker_control_sequence_fingerprints WHERE turn_id = @turn
      UNION ALL SELECT 1 FROM agent_session_runtime_bindings WHERE current_turn_id = @turn
      UNION ALL SELECT 1 FROM scheduler_orphan_worker_evidence WHERE turn_id = @turn
      UNION ALL SELECT 1 FROM idempotency_requests WHERE response_id = @turn OR json_extract(response_json, '$.downstream.turnId') = @turn
      LIMIT 1`)
      .get({
        turn: checkpoint.turnId,
        queue: admission.queueEntryId,
      });
    const workspaceEffects = input.workspaceDb.sqlite
      .prepare(`
      SELECT 1 FROM runtime_evidence WHERE turn_id = @turn
      UNION ALL SELECT 1 FROM evidence_bundles WHERE turn_id = @turn
      UNION ALL SELECT 1 FROM idempotency_requests WHERE response_id = @turn OR json_extract(response_json, '$.downstream.turnId') = @turn
      LIMIT 1`)
      .get({
        turn: checkpoint.turnId,
      });
    if (
      coreEffects ||
      workspaceEffects ||
      listExportableAgentEnvironmentPackageSnapshots(input.workspaceDb, input.workspaceId).some(
        (snapshot) => snapshot.turnId === checkpoint.turnId
      )
    )
      return false;
    const dataRoot = input.store.getDataRoot();
    if (!dataRoot || dataRoot !== input.coreDb.dataRoot || input.workspaceDb.dataRoot !== dataRoot)
      return false;
    const history = readPublishedTurnIdentities(dataRoot);
    if (
      history.status !== 'readable' ||
      history.turns.some((turn) => turn.turnId === checkpoint.turnId)
    )
      return false;
    // Published Turns own canonical AgentSession association and input Items; package/control/backend and runtime-binding rows above own native delivery and execution.
    return clearWorkerCheckpoint(
      input.workspaceDb,
      input.workspaceId,
      input.threadId,
      checkpoint.turnId
    );
  })();
}
