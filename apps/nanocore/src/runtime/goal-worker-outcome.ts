import type { ActorRef, StopReason } from '@openkit/protocol';

import type { WorkspaceDb } from '../storage/db.js';
import { type GoalTaskRecord, updateGoalTask } from './goal-store.js';
import {
  createWorkerCheckpointEvidenceDiagnostics,
  updateWorkerCheckpoint,
  type WorkerCheckpointContextAssemblySummary,
} from './worker-checkpoints.js';
import { type WorkerTurnStage, workerTurnStageForStopReason } from './worker-stage.js';

/**
 * Input for recording one worker terminal outcome on a goal task.
 */
export interface RecordGoalTaskWorkerOutcomeInput {
  /** Exact actor responsible for the worker effect. */
  readonly authorityActor: ActorRef;
  /** Open workspace-scope database handle for worker checkpoint storage. */
  readonly workspaceDb: WorkspaceDb;
  /** Workspace that owns the task and checkpoint. */
  readonly workspaceId: string;
  /** Thread that owns the task and checkpoint. */
  readonly threadId: string;
  /** Goal that owns the task. */
  readonly goalId: string;
  /** Goal task that owns the worker turn. */
  readonly taskId: string;
  /** Worker turn id linked by checkpoint. */
  readonly turnId: string;
  /** Terminal stop reason reported by the worker turn. */
  readonly stopReason: StopReason;
  /** Relevant terminal item ids, when available. */
  readonly itemIds?: readonly string[];
  /** Relevant terminal artifact ids, when available. */
  readonly artifactIds?: readonly string[];
  /** Product-safe context assembly summary to preserve on interrupted checkpoints. */
  readonly contextAssembly?: WorkerCheckpointContextAssemblySummary | null;
}

/**
 * Result after recording one worker terminal outcome.
 */
export interface RecordGoalTaskWorkerOutcomeResult {
  /** Updated goal task record. */
  readonly task: GoalTaskRecord;
  /** Worker checkpoint stage written for the terminal outcome. */
  readonly checkpointStage: WorkerTurnStage;
  /** Terminal evidence refs persisted in the checkpoint diagnostics summary. */
  readonly evidence: {
    /** Relevant terminal item ids. */
    readonly itemIds: readonly string[];
    /** Relevant terminal artifact ids. */
    readonly artifactIds: readonly string[];
  };
}

/**
 * Records a worker terminal outcome on the linked goal task and checkpoint.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param input Worker terminal outcome input.
 * @returns Updated task and terminal checkpoint metadata.
 */
export function recordGoalTaskWorkerOutcome(
  workspaceDb: WorkspaceDb,
  input: RecordGoalTaskWorkerOutcomeInput
): RecordGoalTaskWorkerOutcomeResult {
  const checkpointStage = workerTurnStageForStopReason(input.stopReason);
  const task = updateGoalTask(workspaceDb, {
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    goalId: input.goalId,
    taskId: input.taskId,
    status:
      input.stopReason === 'completed'
        ? 'completed'
        : input.stopReason === 'ask_user'
          ? 'running'
          : 'failed',
  });
  const evidence = {
    itemIds: [...(input.itemIds ?? [])],
    artifactIds: [...(input.artifactIds ?? [])],
  };

  updateWorkerCheckpoint(input.workspaceDb, {
    authorityActor: input.authorityActor,
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    turnId: input.turnId,
    stage: checkpointStage,
    stopReason: input.stopReason,
    diagnosticsSummary: createWorkerCheckpointEvidenceDiagnostics(evidence, input.contextAssembly),
  });

  return { task, checkpointStage, evidence };
}
