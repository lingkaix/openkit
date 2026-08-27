import type { ActorRef, StopReason } from '@openkit/protocol';

import { recordWorkspaceAuditEvent } from '../audit-events.js';
import {
  finishCapabilityCall,
  recordUsage,
  startCapabilityCall,
} from '../capability/usage-ledger.js';
import { redactInternalAgentText } from '../internal-agents/redaction.js';
import type { WorkspaceDb } from '../storage/db.js';
import { recordWorkerCheckpointRuntimeEvidence } from './runtime-evidence.js';
import { isTerminalWorkerTurnStage, type WorkerTurnStage } from './worker-stage.js';

/**
 * Stored worker checkpoint record.
 */
export interface WorkerCheckpointRecord {
  /** Stable checkpoint id derived from workspace, thread, and turn ids. */
  readonly checkpointId: string;
  /** Workspace that owns the worker turn. */
  readonly workspaceId: string;
  /** Thread that owns the worker turn. */
  readonly threadId: string;
  /** Turn represented by the checkpoint. */
  readonly turnId: string;
  /** Optional goal id associated with the worker turn. */
  readonly goalId: string | null;
  /** Optional goal task id associated with the worker turn. */
  readonly taskId: string | null;
  /** Command request that owns this worker envelope. */
  readonly requestId: string;
  /** Hash of the canonical command input without raw request content. */
  readonly requestInputHash: string;
  /** Recovery stage recorded for the worker turn. */
  readonly stage: WorkerTurnStage;
  /** Worker iteration count at the checkpoint. */
  readonly iteration: number;
  /** Optional host worker session id. */
  readonly workerSessionId: string | null;
  /** Optional context package digest used by the worker. */
  readonly contextDigest: string | null;
  /** Optional terminal stop reason when known. */
  readonly stopReason: StopReason | null;
  /** Redacted checkpoint diagnostics summary. */
  readonly diagnosticsSummary: string | null;
  /** Checkpoints are recovery records, not replay instructions. */
  readonly replayInstruction: false;
  /** ISO timestamp for checkpoint creation. */
  readonly createdAt: string;
  /** ISO timestamp for latest checkpoint update. */
  readonly updatedAt: string;
}

interface WorkerCheckpointRow {
  readonly checkpoint_id: string;
  readonly workspace_id: string;
  readonly thread_id: string;
  readonly turn_id: string;
  readonly goal_id: string | null;
  readonly task_id: string | null;
  readonly request_id: string;
  readonly request_input_hash: string;
  readonly stage: WorkerTurnStage;
  readonly iteration: number;
  readonly worker_session_id: string | null;
  readonly context_digest: string | null;
  readonly stop_reason: StopReason | null;
  readonly diagnostics_summary: string | null;
  readonly replay_instruction: 0 | 1;
  readonly created_at: string;
  readonly updated_at: string;
}

/**
 * Input used to create or replace a worker checkpoint.
 */
export interface UpsertWorkerCheckpointInput {
  /** Workspace that owns the worker turn. */
  readonly workspaceId: string;
  /** Thread that owns the worker turn. */
  readonly threadId: string;
  /** Turn represented by the checkpoint. */
  readonly turnId: string;
  /** Optional goal id associated with the worker turn. */
  readonly goalId?: string | null;
  /** Optional goal task id associated with the worker turn. */
  readonly taskId?: string | null;
  /** Command request that owns this worker envelope. */
  readonly requestId: string;
  /** Hash of the canonical command input without raw request content. */
  readonly requestInputHash: string;
  /** Recovery stage recorded for the worker turn. */
  readonly stage: WorkerTurnStage;
  /** Worker iteration count at the checkpoint. */
  readonly iteration: number;
  /** Optional host worker session id. */
  readonly workerSessionId?: string | null;
  /** Optional context package digest used by the worker. */
  readonly contextDigest?: string | null;
  /** Optional terminal stop reason when known. */
  readonly stopReason?: StopReason | null;
  /** Redacted before storage when present. */
  readonly diagnosticsSummary?: string | null;
  /** Optional clock used by deterministic tests. */
  readonly now?: () => string;
}

/**
 * Input used to update an existing worker checkpoint.
 */
export interface UpdateWorkerCheckpointInput {
  /** Exact actor responsible for the worker effect; used only for process-local usage attribution. */
  readonly authorityActor: ActorRef;
  /** Workspace that owns the worker turn. */
  readonly workspaceId: string;
  /** Thread that owns the worker turn. */
  readonly threadId: string;
  /** Turn represented by the checkpoint. */
  readonly turnId: string;
  /** Optional updated worker stage. */
  readonly stage?: WorkerTurnStage;
  /** Optional updated iteration count. */
  readonly iteration?: number;
  /** Optional updated worker session id. */
  readonly workerSessionId?: string | null;
  /** Optional updated context package digest. */
  readonly contextDigest?: string | null;
  /** Optional updated stop reason. */
  readonly stopReason?: StopReason | null;
  /** Optional updated diagnostics summary, redacted before storage. */
  readonly diagnosticsSummary?: string | null;
  /** Optional clock used by deterministic tests. */
  readonly now?: () => string;
}

/**
 * Evidence ids attached to a worker terminal checkpoint.
 */
export interface WorkerCheckpointEvidenceRefs {
  /** Relevant terminal item ids. */
  readonly itemIds: readonly string[];
  /** Relevant terminal artifact ids. */
  readonly artifactIds: readonly string[];
}

/**
 * Product-safe context assembly summary persisted while a worker turn is non-terminal.
 */
export interface WorkerCheckpointContextAssemblySummary {
  /** Context package digest selected for this worker turn. */
  readonly contextDigest: string;
  /** Source references selected for the worker context package. */
  readonly contextRefs: readonly { readonly kind: string; readonly id: string }[];
  /** Governed Knowledge selection consumed by a direct Task, or null when not requested. */
  readonly knowledgeSelectionInput: { readonly retrievalTraceId: string } | null;
}

/**
 * Creates the compact diagnostics summary used while worker context is active.
 *
 * @param contextAssembly Product-safe context assembly summary.
 * @returns JSON diagnostics summary.
 */
export function createWorkerCheckpointContextDiagnostics(
  contextAssembly: WorkerCheckpointContextAssemblySummary
): string {
  return JSON.stringify({ contextAssembly });
}

/**
 * Creates the compact diagnostics summary used for terminal worker evidence.
 *
 * @param evidence Terminal evidence ids returned by a worker.
 * @param contextAssembly Product-safe context assembly summary to preserve for recovery.
 * @param failureSummary Product-safe worker failure summary to preserve for RuntimeEvidence.
 * @returns JSON diagnostics summary, or null when there is no evidence.
 */
export function createWorkerCheckpointEvidenceDiagnostics(
  evidence: WorkerCheckpointEvidenceRefs,
  contextAssembly?: WorkerCheckpointContextAssemblySummary | null,
  failureSummary?: string | null
): string | null {
  return evidence.itemIds.length > 0 ||
    evidence.artifactIds.length > 0 ||
    contextAssembly ||
    failureSummary
    ? JSON.stringify({
        itemIds: evidence.itemIds,
        artifactIds: evidence.artifactIds,
        ...(contextAssembly ? { contextAssembly } : {}),
        ...(failureSummary ? { failureSummary: redactInternalAgentText(failureSummary) } : {}),
      })
    : null;
}

/**
 * Reads a context assembly summary from checkpoint diagnostics.
 *
 * @param diagnosticsSummary Stored checkpoint diagnostics text.
 * @returns Context assembly summary, or null when unavailable.
 */
export function parseWorkerCheckpointContextAssembly(
  diagnosticsSummary: string | null
): WorkerCheckpointContextAssemblySummary | null {
  if (!diagnosticsSummary) {
    return null;
  }

  try {
    const parsed = JSON.parse(diagnosticsSummary) as { contextAssembly?: unknown };
    const summary = parsed.contextAssembly;
    if (!summary || typeof summary !== 'object' || Array.isArray(summary)) {
      return null;
    }

    const record = summary as Record<string, unknown>;
    const contextRefs = record.contextRefs;
    if (typeof record.contextDigest !== 'string' || !Array.isArray(contextRefs)) {
      return null;
    }

    const normalizedContextRefs: { kind: string; id: string }[] = [];
    for (const reference of contextRefs) {
      if (reference === null || typeof reference !== 'object' || Array.isArray(reference)) {
        return null;
      }
      const ref = reference as Record<string, unknown>;
      if (typeof ref.kind !== 'string' || typeof ref.id !== 'string') {
        return null;
      }
      normalizedContextRefs.push({ kind: ref.kind, id: ref.id });
    }

    const knowledgeSelectionInput = record.knowledgeSelectionInput;
    let normalizedKnowledgeSelectionInput: { retrievalTraceId: string } | null = null;
    if (knowledgeSelectionInput !== null) {
      if (
        typeof knowledgeSelectionInput !== 'object' ||
        Array.isArray(knowledgeSelectionInput) ||
        Object.keys(knowledgeSelectionInput).length !== 1
      ) {
        return null;
      }
      const retrievalTraceId = (knowledgeSelectionInput as Record<string, unknown>)
        .retrievalTraceId;
      if (
        typeof retrievalTraceId !== 'string' ||
        !/^krt_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
          retrievalTraceId
        )
      ) {
        return null;
      }
      normalizedKnowledgeSelectionInput = { retrievalTraceId };
    }

    return {
      contextDigest: record.contextDigest,
      contextRefs: normalizedContextRefs,
      knowledgeSelectionInput: normalizedKnowledgeSelectionInput,
    };
  } catch {
    return null;
  }
}

/**
 * Reads terminal evidence ids from checkpoint diagnostics.
 *
 * @param diagnosticsSummary Stored checkpoint diagnostics text.
 * @returns Terminal evidence ids, or null when the summary is not an evidence record.
 */
export function parseWorkerCheckpointEvidence(
  diagnosticsSummary: string | null
): WorkerCheckpointEvidenceRefs | null {
  if (!diagnosticsSummary) {
    return null;
  }

  try {
    const parsed = JSON.parse(diagnosticsSummary) as {
      itemIds?: unknown;
      artifactIds?: unknown;
    };
    if (
      !Array.isArray(parsed.itemIds) ||
      !parsed.itemIds.every((itemId) => typeof itemId === 'string') ||
      !Array.isArray(parsed.artifactIds) ||
      !parsed.artifactIds.every((artifactId) => typeof artifactId === 'string')
    ) {
      return null;
    }

    return { itemIds: parsed.itemIds, artifactIds: parsed.artifactIds };
  } catch {
    return null;
  }
}

/**
 * Creates or replaces one worker checkpoint.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param input Worker checkpoint input.
 * @returns Stored worker checkpoint record.
 */
export function upsertWorkerCheckpoint(
  workspaceDb: WorkspaceDb,
  input: UpsertWorkerCheckpointInput
): WorkerCheckpointRecord {
  const checkpointId = createWorkerCheckpointId(input.workspaceId, input.threadId, input.turnId);
  const timestamp = input.now?.() ?? new Date().toISOString();

  workspaceDb.sqlite
    .prepare(
      `INSERT INTO worker_turn_checkpoints (
        checkpoint_id,
        workspace_id,
        thread_id,
        turn_id,
        goal_id,
        task_id,
        request_id,
        request_input_hash,
        stage,
        iteration,
        worker_session_id,
        context_digest,
        stop_reason,
        diagnostics_summary,
        replay_instruction,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(checkpoint_id) DO UPDATE SET
        goal_id = excluded.goal_id,
        task_id = excluded.task_id,
        stage = excluded.stage,
        iteration = excluded.iteration,
        worker_session_id = excluded.worker_session_id,
        context_digest = excluded.context_digest,
        stop_reason = excluded.stop_reason,
        diagnostics_summary = excluded.diagnostics_summary,
        replay_instruction = excluded.replay_instruction,
        updated_at = excluded.updated_at`
    )
    .run(
      checkpointId,
      input.workspaceId,
      input.threadId,
      input.turnId,
      input.goalId ?? null,
      input.taskId ?? null,
      input.requestId,
      input.requestInputHash,
      input.stage,
      input.iteration,
      input.workerSessionId ?? null,
      input.contextDigest ?? null,
      input.stopReason ?? null,
      redactOptionalText(input.diagnosticsSummary),
      0,
      timestamp,
      timestamp
    );

  const checkpoint = requireWorkerCheckpoint(
    workspaceDb,
    input.workspaceId,
    input.threadId,
    input.turnId
  );
  return checkpoint;
}

/**
 * Updates an existing worker checkpoint.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param input Worker checkpoint update input.
 * @returns Updated worker checkpoint record.
 * @throws Error when the checkpoint does not exist.
 */
export function updateWorkerCheckpoint(
  workspaceDb: WorkspaceDb,
  input: UpdateWorkerCheckpointInput
): WorkerCheckpointRecord {
  const existing = requireWorkerCheckpoint(
    workspaceDb,
    input.workspaceId,
    input.threadId,
    input.turnId
  );
  const timestamp = input.now?.() ?? new Date().toISOString();

  workspaceDb.sqlite
    .prepare(
      `UPDATE worker_turn_checkpoints
      SET
        stage = ?,
        iteration = ?,
        worker_session_id = ?,
        context_digest = ?,
        stop_reason = ?,
        diagnostics_summary = ?,
        updated_at = ?
      WHERE checkpoint_id = ?`
    )
    .run(
      input.stage ?? existing.stage,
      input.iteration ?? existing.iteration,
      input.workerSessionId ?? existing.workerSessionId,
      input.contextDigest ?? existing.contextDigest,
      input.stopReason ?? existing.stopReason,
      input.diagnosticsSummary === undefined
        ? existing.diagnosticsSummary
        : redactOptionalText(input.diagnosticsSummary),
      timestamp,
      existing.checkpointId
    );

  const checkpoint = requireWorkerCheckpoint(
    workspaceDb,
    input.workspaceId,
    input.threadId,
    input.turnId
  );
  recordTerminalCheckpointEvidence(workspaceDb, existing, checkpoint, input.authorityActor);
  return checkpoint;
}

/**
 * Reads one worker checkpoint.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param workspaceId Workspace id.
 * @param threadId Thread id.
 * @param turnId Turn id.
 * @returns Worker checkpoint record, or null.
 */
export function getWorkerCheckpoint(
  workspaceDb: WorkspaceDb,
  workspaceId: string,
  threadId: string,
  turnId: string
): WorkerCheckpointRecord | null {
  const row = workspaceDb.sqlite
    .prepare(
      `${workerCheckpointSelectSql()}
      WHERE workspace_id = ? AND thread_id = ? AND turn_id = ?`
    )
    .get(workspaceId, threadId, turnId) as WorkerCheckpointRow | undefined;

  return row ? mapWorkerCheckpointRow(row) : null;
}

/**
 * Deletes one worker checkpoint.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param workspaceId Workspace id.
 * @param threadId Thread id.
 * @param turnId Turn id.
 * @returns True when a checkpoint row was deleted.
 */
export function clearWorkerCheckpoint(
  workspaceDb: WorkspaceDb,
  workspaceId: string,
  threadId: string,
  turnId: string
): boolean {
  const result = workspaceDb.sqlite
    .prepare('DELETE FROM worker_turn_checkpoints WHERE checkpoint_id = ?')
    .run(createWorkerCheckpointId(workspaceId, threadId, turnId));

  return result.changes > 0;
}

/**
 * Lists worker checkpoints that still need recovery materialization for one workspace.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @returns Recoverable worker checkpoints in deterministic order.
 */
export function listRecoverableWorkerCheckpoints(
  workspaceDb: WorkspaceDb
): WorkerCheckpointRecord[] {
  return (
    workspaceDb.sqlite
      .prepare(
        `${workerCheckpointSelectSql()}
        ORDER BY updated_at ASC, checkpoint_id ASC`
      )
      .all() as WorkerCheckpointRow[]
  )
    .map(mapWorkerCheckpointRow)
    .filter((checkpoint) => checkpoint.stage !== 'completed');
}

/**
 * Lists all worker checkpoints for one workspace in stable export order.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param workspaceId Workspace id.
 * @returns Worker checkpoint rows in oldest-first order.
 */
export function listExportableWorkerCheckpoints(
  workspaceDb: WorkspaceDb,
  workspaceId: string
): WorkerCheckpointRecord[] {
  return (
    workspaceDb.sqlite
      .prepare(
        `${workerCheckpointSelectSql()}
        WHERE workspace_id = ?
        ORDER BY updated_at ASC, checkpoint_id ASC`
      )
      .all(workspaceId) as WorkerCheckpointRow[]
  ).map(mapWorkerCheckpointRow);
}

/**
 * Replays imported worker checkpoints without emitting checkpoint audit events.
 *
 * @param workspaceDb Open target workspace database handle.
 * @param checkpoints Worker checkpoint rows to replay.
 */
export function importWorkerCheckpoints(
  workspaceDb: WorkspaceDb,
  checkpoints: readonly WorkerCheckpointRecord[]
): void {
  for (const checkpoint of checkpoints) {
    workspaceDb.sqlite
      .prepare(
        `INSERT OR IGNORE INTO worker_turn_checkpoints (
          checkpoint_id,
          workspace_id,
          thread_id,
          turn_id,
          goal_id,
          task_id,
          request_id,
          request_input_hash,
          stage,
          iteration,
          worker_session_id,
          context_digest,
          stop_reason,
          diagnostics_summary,
          replay_instruction,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        checkpoint.checkpointId,
        checkpoint.workspaceId,
        checkpoint.threadId,
        checkpoint.turnId,
        checkpoint.goalId,
        checkpoint.taskId,
        checkpoint.requestId,
        checkpoint.requestInputHash,
        checkpoint.stage,
        checkpoint.iteration,
        checkpoint.workerSessionId,
        checkpoint.contextDigest,
        checkpoint.stopReason,
        checkpoint.diagnosticsSummary,
        0,
        checkpoint.createdAt,
        checkpoint.updatedAt
      );
  }
}

/**
 * Builds the shared worker checkpoint SELECT fragment.
 *
 * @returns SQL fragment selecting every checkpoint column.
 */
function workerCheckpointSelectSql(): string {
  return `SELECT
    checkpoint_id,
    workspace_id,
    thread_id,
    turn_id,
    goal_id,
    task_id,
    request_id,
    request_input_hash,
    stage,
    iteration,
    worker_session_id,
    context_digest,
    stop_reason,
    diagnostics_summary,
    replay_instruction,
    created_at,
    updated_at
    FROM worker_turn_checkpoints`;
}

/**
 * Creates the stable checkpoint id.
 *
 * @param workspaceId Workspace id.
 * @param threadId Thread id.
 * @param turnId Turn id.
 * @returns Stable checkpoint id.
 */
function createWorkerCheckpointId(workspaceId: string, threadId: string, turnId: string): string {
  return `${workspaceId}:${threadId}:${turnId}`;
}

/**
 * Records the first terminal transition for one worker checkpoint.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param previous Previous checkpoint record, or null for new rows.
 * @param checkpoint Current checkpoint record.
 * @param authorityActor Exact actor responsible for the worker effect.
 */
function recordTerminalCheckpointEvidence(
  workspaceDb: WorkspaceDb,
  previous: WorkerCheckpointRecord | null,
  checkpoint: WorkerCheckpointRecord,
  authorityActor: ActorRef
): void {
  if (
    !previous ||
    !isTerminalWorkerTurnStage(checkpoint.stage) ||
    isTerminalWorkerTurnStage(previous.stage)
  ) {
    return;
  }

  recordWorkerCheckpointRuntimeEvidence(workspaceDb, checkpoint);
  recordTerminalCheckpointRuntimeUsage(workspaceDb, checkpoint, authorityActor);
  recordWorkspaceAuditEvent({
    action: 'worker.checkpoint.terminal',
    category: 'system',
    now: new Date(checkpoint.updatedAt),
    outcome: checkpoint.stage === 'completed' ? 'succeeded' : 'failed',
    resource: `worker-checkpoint:${checkpoint.checkpointId}`,
    severity: checkpoint.stage === 'completed' ? 'info' : 'warning',
    summary: `Worker checkpoint terminal: ${checkpoint.stage}`,
    threadId: checkpoint.threadId,
    turnId: checkpoint.turnId,
    workspaceDb,
    workspaceId: checkpoint.workspaceId,
  });
}

/**
 * Records one runtime usage measurement for a terminal worker checkpoint.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param checkpoint Current terminal checkpoint.
 * @param authorityActor Exact actor responsible for the worker effect.
 */
function recordTerminalCheckpointRuntimeUsage(
  workspaceDb: WorkspaceDb,
  checkpoint: WorkerCheckpointRecord,
  authorityActor: ActorRef
): void {
  const now = new Date(checkpoint.updatedAt);
  const call = startCapabilityCall({
    agentSessionId: checkpoint.workerSessionId,
    authorityActor,
    callId: `cap_runtime_${checkpoint.checkpointId}`,
    capabilityId: 'runtime.worker_turn',
    family: 'runtime',
    operation: 'worker.checkpoint.terminal',
    providerRef: 'nanocore-runtime',
    redactionClass: 'metadata-only',
    serviceRef: 'worker-checkpoint',
    summary: `Worker checkpoint terminal: ${checkpoint.stage}`,
    threadId: checkpoint.threadId,
    turnId: checkpoint.turnId,
    workspaceDb,
    workspaceId: checkpoint.workspaceId,
    now,
  });

  recordUsage({
    call,
    records: [
      {
        category: 'runtime',
        providerRef: 'nanocore-runtime',
        quantity: 1,
        source: 'worker-checkpoint-terminal',
        unit: 'sandbox_sessions',
        usageId: `use_runtime_${checkpoint.checkpointId}`,
      },
    ],
    workspaceDb,
    now,
  });
  finishCapabilityCall({
    callId: call.id,
    status: checkpoint.stage === 'completed' ? 'succeeded' : 'failed',
    workspaceDb,
    now,
  });
}

/**
 * Reads one checkpoint or throws a readable error.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param workspaceId Workspace id.
 * @param threadId Thread id.
 * @param turnId Turn id.
 * @returns Worker checkpoint record.
 * @throws Error when the checkpoint does not exist.
 */
function requireWorkerCheckpoint(
  workspaceDb: WorkspaceDb,
  workspaceId: string,
  threadId: string,
  turnId: string
): WorkerCheckpointRecord {
  const checkpoint = getWorkerCheckpoint(workspaceDb, workspaceId, threadId, turnId);

  if (!checkpoint) {
    throw new Error(`Worker checkpoint not found: ${workspaceId}/${threadId}/${turnId}`);
  }

  return checkpoint;
}

/**
 * Redacts optional diagnostics text.
 *
 * @param value Optional diagnostics text.
 * @returns Redacted diagnostics text or null.
 */
function redactOptionalText(value: string | null | undefined): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  const evidence = parseWorkerCheckpointEvidence(value);
  const contextAssembly = parseWorkerCheckpointContextAssembly(value);
  if (evidence) {
    const parsed = JSON.parse(value) as { failureSummary?: unknown };
    const failureSummary = typeof parsed.failureSummary === 'string' ? parsed.failureSummary : null;
    return createWorkerCheckpointEvidenceDiagnostics(evidence, contextAssembly, failureSummary);
  }
  if (contextAssembly) {
    return createWorkerCheckpointContextDiagnostics(contextAssembly);
  }
  return redactInternalAgentText(value);
}

/**
 * Maps a worker checkpoint row to the store record.
 *
 * @param row Worker checkpoint row.
 * @returns Worker checkpoint record.
 */
function mapWorkerCheckpointRow(row: WorkerCheckpointRow): WorkerCheckpointRecord {
  return {
    checkpointId: row.checkpoint_id,
    workspaceId: row.workspace_id,
    threadId: row.thread_id,
    turnId: row.turn_id,
    goalId: row.goal_id,
    taskId: row.task_id,
    requestId: row.request_id,
    requestInputHash: row.request_input_hash,
    stage: row.stage,
    iteration: row.iteration,
    workerSessionId: row.worker_session_id,
    contextDigest: row.context_digest,
    stopReason: row.stop_reason,
    diagnosticsSummary: row.diagnostics_summary,
    replayInstruction: false,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
