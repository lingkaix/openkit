import { join } from 'node:path';

import type { StopReason } from '@openkit/protocol';

import type { WorkspaceDb } from '../storage/db.js';
import { listExportableAgentEnvironmentPackageSnapshots } from './aep-snapshot-ledger.js';
import {
  clearWorkerCheckpoint,
  getWorkerCheckpoint,
  listRecoverableWorkerCheckpoints,
  parseWorkerCheckpointContextAssembly,
  type WorkerCheckpointContextAssemblySummary,
  type WorkerCheckpointRecord,
} from './worker-checkpoints.js';
import { importWorkerRuntimeProvenance } from './worker-runtime-provenance.js';
import { isTerminalWorkerTurnStage, type WorkerTurnStage } from './worker-stage.js';

/**
 * Worker stages that still need visible recovery materialization.
 */
export type RecoverableWorkerTurnStage = Exclude<WorkerTurnStage, 'completed'>;

/**
 * Read-model row describing a worker turn that was interrupted before terminal save.
 */
export interface InterruptedWorkerStateRecord {
  /** Stable row kind used by App API projections. */
  readonly kind: 'interrupted_worker_state';
  /** Source checkpoint id. */
  readonly checkpointId: string;
  /** Workspace that owns the interrupted worker turn. */
  readonly workspaceId: string;
  /** Thread that owns the interrupted worker turn. */
  readonly threadId: string;
  /** Turn represented by the interrupted state. */
  readonly turnId: string;
  /** Optional goal id associated with the interrupted worker turn. */
  readonly goalId: string | null;
  /** Optional goal task id associated with the interrupted worker turn. */
  readonly taskId: string | null;
  /** Last known recoverable worker stage. */
  readonly stage: RecoverableWorkerTurnStage;
  /** Worker iteration count at the source checkpoint. */
  readonly iteration: number;
  /** Optional host worker session id from the source checkpoint. */
  readonly workerSessionId: string | null;
  /** Optional context package digest from the source checkpoint. */
  readonly contextDigest: string | null;
  /** Product-safe context assembly summary from the source checkpoint. */
  readonly contextAssembly: WorkerCheckpointContextAssemblySummary | null;
  /** Optional stop reason known at interruption time. */
  readonly stopReason: StopReason | null;
  /** Redacted diagnostic summary from the source checkpoint. */
  readonly diagnosticsSummary: string | null;
  /** Interrupted states are visibility records, not replay instructions. */
  readonly replayInstruction: false;
  /** Typed recovery choices available to a user or Coordinator. */
  readonly choices: readonly InterruptedWorkerRecoveryChoice[];
  /** ISO timestamp for recovery materialization. */
  readonly materializedAt: string;
  /** ISO timestamp copied from the source checkpoint update. */
  readonly sourceUpdatedAt: string;
}

/**
 * Typed recovery choice surfaced for an interrupted worker turn.
 */
export type InterruptedWorkerRecoveryChoice =
  | {
      /** Inspect durable state and evidence before choosing a recovery action. */
      readonly kind: 'inspect';
      /** User-facing action label. */
      readonly label: string;
      /** True when this should be the first recovery step. */
      readonly recommended: true;
    }
  | {
      /** Retry the interrupted checkpoint through the existing recovery endpoint. */
      readonly kind: 'retry';
      /** User-facing action label. */
      readonly label: string;
    }
  | {
      /** Record the worker turn's terminal state after external evidence is known. */
      readonly kind: 'record_terminal';
      /** User-facing action label. */
      readonly label: string;
      /** Terminal stages accepted by the current recovery endpoint. */
      readonly allowedTerminalStages: readonly ['completed', 'failed', 'aborted'];
    }
  | {
      /** Ask the user or coordinator how to proceed when evidence is insufficient. */
      readonly kind: 'request_human';
      /** User-facing action label. */
      readonly label: string;
    };

/**
 * Input used to materialize interrupted worker read-model rows.
 */
export interface MaterializeInterruptedWorkerStatesInput {
  /** Optional clock used by deterministic tests. */
  readonly now?: () => string;
}

/**
 * Input used to clear a checkpoint after terminal state is durably saved.
 */
export interface ClearWorkerCheckpointAfterTerminalStateInput {
  /** Workspace that owns the worker turn. */
  readonly workspaceId: string;
  /** Thread that owns the worker turn. */
  readonly threadId: string;
  /** Turn represented by the checkpoint. */
  readonly turnId: string;
  /** Stage that has already been durably saved for the worker turn. */
  readonly terminalStage: WorkerTurnStage;
}

/**
 * Materializes all pending checkpoints as interrupted worker read-model rows.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param input Optional deterministic materialization input.
 * @returns Interrupted worker state rows for visible restart recovery.
 */
export function materializeInterruptedWorkerStates(
  workspaceDb: WorkspaceDb,
  input: MaterializeInterruptedWorkerStatesInput = {}
): InterruptedWorkerStateRecord[] {
  const materializedAt = input.now?.() ?? new Date().toISOString();

  return listRecoverableWorkerCheckpoints(workspaceDb).map((checkpoint) =>
    createInterruptedWorkerState(checkpoint, materializedAt)
  );
}

/**
 * Clears one checkpoint after its terminal worker state has been durably saved.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param input Cleanup input with the saved terminal stage.
 * @returns True when a checkpoint row was deleted.
 */
export async function clearWorkerCheckpointAfterTerminalState(
  workspaceDb: WorkspaceDb,
  input: ClearWorkerCheckpointAfterTerminalStateInput
): Promise<boolean> {
  if (!isTerminalWorkerTurnStage(input.terminalStage)) {
    return false;
  }

  const checkpoint = getWorkerCheckpoint(
    workspaceDb,
    input.workspaceId,
    input.threadId,
    input.turnId
  );
  if (!checkpoint) {
    return false;
  }
  const environmentPackage = listExportableAgentEnvironmentPackageSnapshots(
    workspaceDb,
    input.workspaceId
  ).find(
    (record) =>
      record.turnId === input.turnId &&
      (!checkpoint.workerSessionId || record.agentSessionId === checkpoint.workerSessionId)
  )?.snapshot;
  if (environmentPackage?.control.transcript?.runtimeProvenance) {
    const rawBundle = workspaceDb.sqlite
      .prepare(
        `SELECT evidence_bundle_id, backend_type, created_at
        FROM evidence_bundles
        WHERE workspace_id = ?
          AND thread_id = ?
          AND turn_id = ?
          AND agent_session_id = ?
          AND source_kind = 'worker-runtime-provenance-raw'
        LIMIT 1`
      )
      .get(
        input.workspaceId,
        input.threadId,
        input.turnId,
        environmentPackage.scope.agentSessionId
      ) as
      | { evidence_bundle_id: string; backend_type: string | null; created_at: string }
      | undefined;
    if (!rawBundle) {
      throw new Error('Required retained runtime provenance is missing.');
    }
    const runtime = workspaceDb.sqlite
      .prepare(
        `SELECT backend_version, placement
        FROM runtime_evidence
        WHERE workspace_id = ?
          AND turn_id = ?
          AND agent_session_id = ?
          AND phase = 'transcript-collection'
        LIMIT 1`
      )
      .get(input.workspaceId, input.turnId, environmentPackage.scope.agentSessionId) as
      | { backend_version: string | null; placement: 'local' | 'remote' | 'unknown' }
      | undefined;
    const workspaceRoot = join(
      workspaceDb.dataRoot,
      'users',
      workspaceDb.userId,
      'workspaces',
      workspaceDb.workspaceId
    );
    const rawRoot = join(workspaceRoot, 'evidence', 'backend', rawBundle.evidence_bundle_id);
    const verified = await importWorkerRuntimeProvenance({
      backend: {
        kind: rawBundle.backend_type ?? environmentPackage.backend.preferred,
        placement: runtime?.placement ?? 'unknown',
        version: runtime?.backend_version ?? null,
      },
      capture: {
        nativeOriginIndexPath: join(rawRoot, 'native-origin-index.jsonl'),
        rawStreamsRoot: join(rawRoot, 'raw'),
        streamManifestPath: join(rawRoot, 'raw-streams.json'),
      },
      collectedAt: rawBundle.created_at,
      environmentPackage,
      workspaceDb,
      workspaceRoot,
    }).catch(() => {
      throw new Error('Required retained runtime provenance verification failed.');
    });
    if (!verified.complete) {
      throw new Error('Required retained runtime provenance verification failed.');
    }
  }

  return clearWorkerCheckpoint(workspaceDb, input.workspaceId, input.threadId, input.turnId);
}

/**
 * Creates one interrupted worker state row from a source checkpoint.
 *
 * @param checkpoint Source pending worker checkpoint.
 * @param materializedAt ISO timestamp for recovery materialization.
 * @returns Interrupted worker read-model row.
 */
function createInterruptedWorkerState(
  checkpoint: WorkerCheckpointRecord,
  materializedAt: string
): InterruptedWorkerStateRecord {
  return {
    kind: 'interrupted_worker_state',
    checkpointId: checkpoint.checkpointId,
    workspaceId: checkpoint.workspaceId,
    threadId: checkpoint.threadId,
    turnId: checkpoint.turnId,
    goalId: checkpoint.goalId,
    taskId: checkpoint.taskId,
    stage: checkpoint.stage as RecoverableWorkerTurnStage,
    iteration: checkpoint.iteration,
    workerSessionId: checkpoint.workerSessionId,
    contextDigest: checkpoint.contextDigest,
    contextAssembly: parseWorkerCheckpointContextAssembly(checkpoint.diagnosticsSummary),
    stopReason: checkpoint.stopReason,
    diagnosticsSummary: checkpoint.diagnosticsSummary,
    replayInstruction: false,
    choices: createInterruptedWorkerRecoveryChoices(),
    materializedAt,
    sourceUpdatedAt: checkpoint.updatedAt,
  };
}

/**
 * Creates the V1 typed recovery choices for an interrupted worker checkpoint.
 *
 * @returns Product-safe recovery choices.
 */
function createInterruptedWorkerRecoveryChoices(): readonly InterruptedWorkerRecoveryChoice[] {
  return [
    {
      kind: 'inspect',
      label: 'Inspect interrupted worker evidence',
      recommended: true,
    },
    {
      kind: 'retry',
      label: 'Retry interrupted worker turn',
    },
    {
      kind: 'record_terminal',
      label: 'Record terminal worker state',
      allowedTerminalStages: ['completed', 'failed', 'aborted'],
    },
    {
      kind: 'request_human',
      label: 'Ask the user how to recover this worker turn',
    },
  ];
}
