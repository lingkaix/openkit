import type { FsStore } from '../lib/store.js';
import type { WorkspaceDb } from '../storage/db.js';
import { updateGoalTask } from './goal-store.js';
import type { PreparedNextTurn } from './prepare-next-turn.js';
import { updateWorkerCheckpoint, upsertWorkerCheckpoint } from './worker-checkpoints.js';

type GoalWorkerTurn = ReturnType<FsStore['createTurn']>;

/**
 * Input passed to the worker start effect.
 */
export interface GoalWorkerStartEffectInput {
  /** Created turn id for the worker boundary. */
  readonly turnId: string;
  /** Prepared worker delegation payload. */
  readonly prepared: PreparedNextTurn;
}

/**
 * Result returned by the worker start effect.
 */
export interface GoalWorkerStartEffectResult {
  /** Optional host worker session id. */
  readonly workerSessionId?: string | null;
}

/**
 * Worker start effect used by the supervise loop.
 */
export type GoalWorkerStartEffect = (
  input: GoalWorkerStartEffectInput
) => Promise<GoalWorkerStartEffectResult> | GoalWorkerStartEffectResult;

/**
 * Input for starting one goal task worker turn.
 */
export interface StartGoalTaskWorkerTurnInput {
  /** Open workspace-scope database handle for goal task and worker checkpoint storage. */
  readonly workspaceDb: WorkspaceDb;
  /** App-local durable store. */
  readonly store: FsStore;
  /** Workspace that owns the goal task. */
  readonly workspaceId: string;
  /** Thread that owns the goal task. */
  readonly threadId: string;
  /** Goal that owns the task. */
  readonly goalId: string;
  /** Goal task to start. */
  readonly taskId: string;
  /** Prepared worker delegation payload. */
  readonly prepared: PreparedNextTurn;
  /** Effect that starts the host worker. */
  readonly startWorker: GoalWorkerStartEffect;
}

/**
 * Result returned after a goal task worker turn starts.
 */
export interface StartGoalTaskWorkerTurnResult {
  /** Created worker turn record. */
  readonly turn: GoalWorkerTurn;
  /** Optional host worker session id. */
  readonly workerSessionId: string | null;
}

/**
 * Starts a worker turn from a prepared goal task delegation.
 *
 * @param input Worker start input.
 * @returns Created turn and worker session metadata.
 * @throws Error when the worker start effect fails.
 */
export async function startGoalTaskWorkerTurn(
  input: StartGoalTaskWorkerTurnInput
): Promise<StartGoalTaskWorkerTurnResult> {
  const turn = input.store.createTurn(
    input.workspaceId,
    input.threadId,
    input.prepared.delegationRequest.objective
  );

  upsertWorkerCheckpoint(input.workspaceDb, {
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    turnId: turn.id,
    goalId: input.goalId,
    taskId: input.taskId,
    stage: 'preparing',
    iteration: 0,
    contextDigest: input.prepared.contextPackageDigest,
  });
  updateGoalTask(input.workspaceDb, {
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    goalId: input.goalId,
    taskId: input.taskId,
    status: 'running',
  });

  try {
    const result = await input.startWorker({ turnId: turn.id, prepared: input.prepared });
    const workerSessionId = result.workerSessionId ?? null;

    updateWorkerCheckpoint(input.workspaceDb, {
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      turnId: turn.id,
      stage: 'running_worker',
      workerSessionId,
    });

    return { turn, workerSessionId };
  } catch (error) {
    updateGoalTask(input.workspaceDb, {
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      goalId: input.goalId,
      taskId: input.taskId,
      status: 'failed',
    });
    updateWorkerCheckpoint(input.workspaceDb, {
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      turnId: turn.id,
      stage: 'failed',
      stopReason: 'error',
      diagnosticsSummary: (error as Error).message,
    });
    input.store.updateTurn(turn.id, {
      status: 'failed',
      error: {
        code: 'worker_start_failed',
        message: 'Worker start failed.',
      },
      completedAt: turn.startedAt ?? new Date().toISOString(),
      durationMs: 0,
    });

    throw error;
  }
}
