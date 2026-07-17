import type { StopReason } from '@openkit/protocol';

import { recordWorkerTurnLaunchDecision } from '../policy/permission-decisions.js';
import type { WorkspaceDb } from '../storage/db.js';
import type { PreparedNextTurn } from './prepare-next-turn.js';
import { type StopAfterTurnDecision, shouldStopAfterTurn } from './stop-after-turn.js';
import {
  createWorkerCheckpointContextDiagnostics,
  createWorkerCheckpointEvidenceDiagnostics,
  updateWorkerCheckpoint,
  upsertWorkerCheckpoint,
  type WorkerCheckpointContextAssemblySummary,
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
}

/**
 * Worker start effect result.
 */
export interface WorkerTurnLoopStartWorkerResult {
  /** Optional host worker session id. */
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
  /** Host worker session id returned by the start effect. */
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
  /** Open workspace-scope database handle for worker checkpoint storage. */
  readonly workspaceDb: WorkspaceDb;
  /** Workspace that owns the worker turn. */
  readonly workspaceId: string;
  /** Thread that owns the worker turn. */
  readonly threadId: string;
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
  /** Remaining worker iterations after this turn. */
  readonly remainingWorkerIterations: number;
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
  const prepared = await input.prepare();
  const contextAssembly = createContextAssemblySummary(prepared);
  const turn = input.workspaceDb.sqlite.transaction(() => {
    const reserved = input.reserveTurn({ prepared });
    recordWorkerTurnLaunchDecision({
      workspaceDb: input.workspaceDb,
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      turnId: reserved.turnId,
      goalId: input.goalId ?? null,
      taskId: input.taskId ?? null,
      ...(input.now ? { now: new Date(input.now()) } : {}),
    });
    upsertWorkerCheckpoint(input.workspaceDb, {
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
    return reserved;
  })();

  let workerSessionId: string | null = null;

  try {
    const started = await input.startWorker({ turnId: turn.turnId, prepared });
    workerSessionId = started.workerSessionId ?? null;

    updateWorkerCheckpoint(input.workspaceDb, {
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      turnId: turn.turnId,
      stage: 'running_worker',
      workerSessionId,
      ...(input.now ? { now: input.now } : {}),
    });

    const worker = await input.awaitWorker({
      turnId: turn.turnId,
      prepared,
      workerSessionId,
    });
    const stopDecision = shouldStopAfterTurn({
      stopReason: worker.stopReason,
      reviewRequired: input.reviewRequired,
      remainingWorkerIterations: input.remainingWorkerIterations,
    });
    const evidence = {
      itemIds: [...(worker.itemIds ?? [])],
      artifactIds: [...(worker.artifactIds ?? [])],
    };

    updateWorkerCheckpoint(input.workspaceDb, {
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      turnId: turn.turnId,
      stage: workerTurnStageForStopReason(worker.stopReason),
      stopReason: worker.stopReason,
      diagnosticsSummary:
        worker.diagnosticsSummary ??
        createWorkerCheckpointEvidenceDiagnostics(evidence, contextAssembly),
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
    updateWorkerCheckpoint(input.workspaceDb, {
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      turnId: turn.turnId,
      stage: 'failed',
      stopReason: 'error',
      ...(workerSessionId ? { workerSessionId } : {}),
      diagnosticsSummary: error instanceof Error ? error.message : String(error),
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
    repositoryResourceId: prepared.repository.resourceId,
  };
}
