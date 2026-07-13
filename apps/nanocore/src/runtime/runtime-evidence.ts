import { createHash } from 'node:crypto';
import {
  type RuntimeEvidenceRecord,
  RuntimeEvidenceRecordSchema,
  type WorkspaceMaterializationRecord,
} from '@openkit/app-api-schemas';

import type { WorkspaceDb } from '../storage/db.js';
import type { WorkerCheckpointRecord } from './worker-checkpoints.js';

interface RuntimeEvidenceRow {
  readonly runtime_evidence_id: string;
  readonly workspace_id: string;
  readonly thread_id: string | null;
  readonly turn_id: string | null;
  readonly goal_id: string | null;
  readonly task_id: string | null;
  readonly agent_session_id: string | null;
  readonly backend_type: string | null;
  readonly backend_version: string | null;
  readonly placement: RuntimeEvidenceRecord['placement'];
  readonly phase: RuntimeEvidenceRecord['phase'];
  readonly summary: string;
  readonly policy_digest: string | null;
  readonly worker_image: string | null;
  readonly sandbox_summary: string | null;
  readonly capability_summary: string | null;
  readonly upload_manifest_json: string;
  readonly download_manifest_json: string;
  readonly transcript_summary: string | null;
  readonly workspace_change_summary: string | null;
  readonly control_summary: string | null;
  readonly outcome: RuntimeEvidenceRecord['outcome'];
  readonly exit_code: number | null;
  readonly signal: string | null;
  readonly stop_reason: string | null;
  readonly error_code: string | null;
  readonly error_message: string | null;
  readonly redacted_stdout_summary: string | null;
  readonly redacted_stderr_summary: string | null;
  readonly evidence_bundle_ids_json: string;
  readonly content_digests_json: string;
  readonly required_features_json: string;
  readonly created_at: string;
  readonly started_at: string | null;
  readonly completed_at: string | null;
  readonly collected_at: string | null;
}

const ImportedRuntimeEvidenceRecordSchema = RuntimeEvidenceRecordSchema.strip();

/** Input for one automatic worker runtime provenance evidence record. */
export interface RecordWorkerRuntimeProvenanceEvidenceInput {
  /** Agent Environment Package snapshot that owns the capture. */
  packageSnapshotId: string;
  /** Workspace that owns the outer turn. */
  workspaceId: string;
  /** Outer OpenKit thread id. */
  threadId: string;
  /** Outer OpenKit turn id. */
  turnId: string;
  /** Outer worker agent session id. */
  agentSessionId: string;
  /** Governance backend family. */
  backendType: string;
  /** Governance backend version. */
  backendVersion: string | null;
  /** Governance backend placement. */
  placement: RuntimeEvidenceRecord['placement'];
  /** Product-safe transcript collection summary. */
  summary: string;
  /** Automatically produced evidence bundle ids. */
  evidenceBundleIds: string[];
  /** Digests of the retained and normalized evidence. */
  contentDigests: string[];
  /** Transcript collection outcome. */
  outcome: RuntimeEvidenceRecord['outcome'];
  /** Stable failure code when transcript collection fails. */
  errorCode?: string | null;
  /** Product-safe failure message when transcript collection fails. */
  errorMessage?: string | null;
  /** Collection timestamp. */
  collectedAt: string;
}

/**
 * Records package-scoped transcript collection evidence for worker runtime provenance.
 *
 * @param workspaceDb Open workspace database handle.
 * @param input Product-safe runtime provenance summary and bundle linkage.
 * @returns Stored runtime evidence record.
 */
export function recordWorkerRuntimeProvenanceEvidence(
  workspaceDb: WorkspaceDb,
  input: RecordWorkerRuntimeProvenanceEvidenceInput
): RuntimeEvidenceRecord {
  const record = RuntimeEvidenceRecordSchema.parse({
    id: createWorkerRuntimeProvenanceEvidenceId(input.packageSnapshotId),
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    turnId: input.turnId,
    goalId: null,
    taskId: null,
    agentSessionId: input.agentSessionId,
    backendType: input.backendType,
    backendVersion: input.backendVersion,
    placement: input.placement,
    phase: 'transcript-collection',
    summary: input.summary,
    policyDigest: null,
    workerImage: null,
    sandboxSummary: null,
    capabilitySummary: 'worker runtime provenance',
    uploadManifest: [],
    downloadManifest: [],
    transcriptSummary: input.summary,
    workspaceChangeSummary: null,
    controlSummary: null,
    outcome: input.outcome,
    exitCode: null,
    signal: null,
    stopReason: null,
    errorCode: input.errorCode ?? null,
    errorMessage: input.errorMessage ?? null,
    redactedStdoutSummary: null,
    redactedStderrSummary: null,
    evidenceBundleIds: input.evidenceBundleIds,
    contentDigests: input.contentDigests,
    requiredFeatures: ['runtime.evidence.v1', 'worker.runtime-provenance.v1'],
    createdAt: input.collectedAt,
    startedAt: null,
    completedAt: input.collectedAt,
    collectedAt: input.collectedAt,
  });

  return insertRuntimeEvidence(workspaceDb, record);
}

/**
 * Records normalized runtime evidence for a terminal worker checkpoint.
 *
 * @param workspaceDb Open workspace database handle.
 * @param checkpoint Terminal worker checkpoint.
 * @returns Stored runtime evidence record.
 */
export function recordWorkerCheckpointRuntimeEvidence(
  workspaceDb: WorkspaceDb,
  checkpoint: WorkerCheckpointRecord
): RuntimeEvidenceRecord {
  const record = RuntimeEvidenceRecordSchema.parse({
    id: createRuntimeEvidenceId(checkpoint.checkpointId),
    workspaceId: checkpoint.workspaceId,
    threadId: checkpoint.threadId,
    turnId: checkpoint.turnId,
    goalId: checkpoint.goalId,
    taskId: checkpoint.taskId,
    agentSessionId: checkpoint.workerSessionId,
    backendType: checkpoint.workerSessionId ? 'openshell' : null,
    backendVersion: null,
    placement: 'local',
    phase: 'teardown',
    summary: `Worker checkpoint terminal: ${checkpoint.stage}.`,
    policyDigest: null,
    workerImage: null,
    sandboxSummary: null,
    capabilitySummary: 'worker turn checkpoint',
    uploadManifest: [],
    downloadManifest: [],
    transcriptSummary: summarizeCheckpointDiagnostics(checkpoint.diagnosticsSummary),
    workspaceChangeSummary: null,
    controlSummary: null,
    outcome: checkpoint.stage === 'completed' ? 'succeeded' : 'failed',
    exitCode: checkpoint.stage === 'completed' ? 0 : null,
    signal: null,
    stopReason: checkpoint.stopReason,
    errorCode: null,
    errorMessage: null,
    redactedStdoutSummary: null,
    redactedStderrSummary: null,
    evidenceBundleIds: [],
    contentDigests: [digestRuntimeEvidence(checkpoint)],
    requiredFeatures: ['runtime.evidence.v1'],
    createdAt: checkpoint.updatedAt,
    startedAt: null,
    completedAt: checkpoint.updatedAt,
    collectedAt: checkpoint.updatedAt,
  });

  return insertRuntimeEvidence(workspaceDb, record);
}

/**
 * Records normalized runtime evidence for workspace materialization readiness.
 *
 * @param workspaceDb Open workspace database handle.
 * @param record Durable materialization record.
 * @returns Stored runtime evidence record.
 */
export function recordMaterializationRuntimeEvidence(
  workspaceDb: WorkspaceDb,
  record: WorkspaceMaterializationRecord
): RuntimeEvidenceRecord {
  const runtimeEvidence = RuntimeEvidenceRecordSchema.parse({
    id: createRuntimeEvidenceId(record.id),
    workspaceId: record.workspaceId,
    threadId: null,
    turnId: null,
    goalId: null,
    taskId: null,
    agentSessionId: record.workerSessionId,
    backendType: record.backendKind,
    backendVersion: materializationBackendVersion(record),
    placement: 'unknown',
    phase: 'capability-negotiation',
    summary: `Workspace materialization recorded: strategy ${record.strategy}, backend ${record.backendKind}`,
    policyDigest: record.policyDigest,
    workerImage: null,
    sandboxSummary: `materialized root ${record.materializedRootRef}`,
    capabilitySummary: materializationCapabilitySummary(record),
    uploadManifest: [],
    downloadManifest: [],
    transcriptSummary: null,
    workspaceChangeSummary: null,
    controlSummary: null,
    outcome: 'succeeded',
    exitCode: null,
    signal: null,
    stopReason: null,
    errorCode: null,
    errorMessage: null,
    redactedStdoutSummary: null,
    redactedStderrSummary: null,
    evidenceBundleIds: [`evb_workspace_materialization_${record.id}`],
    contentDigests: [record.policyDigest],
    requiredFeatures: ['runtime.evidence.v1'],
    createdAt: record.createdAt,
    startedAt: record.createdAt,
    completedAt: record.createdAt,
    collectedAt: record.createdAt,
  });

  return insertRuntimeEvidence(workspaceDb, runtimeEvidence);
}

/**
 * Lists workspace runtime evidence in durable order.
 *
 * @param workspaceDb Open workspace database handle.
 * @param workspaceId Workspace id to list.
 * @returns Runtime evidence rows.
 */
export function listWorkspaceRuntimeEvidence(
  workspaceDb: WorkspaceDb,
  workspaceId: string
): RuntimeEvidenceRecord[] {
  return (
    workspaceDb.sqlite
      .prepare(
        `SELECT *
        FROM runtime_evidence
        WHERE workspace_id = ?
        ORDER BY created_at, runtime_evidence_id`
      )
      .all(workspaceId) as RuntimeEvidenceRow[]
  ).map(runtimeEvidenceFromRow);
}

/**
 * Replays imported workspace runtime evidence rows.
 *
 * @param workspaceDb Open target workspace database handle.
 * @param records Runtime evidence rows to import.
 */
export function importWorkspaceRuntimeEvidence(
  workspaceDb: WorkspaceDb,
  records: readonly RuntimeEvidenceRecord[]
): void {
  for (const record of records) {
    insertRuntimeEvidence(workspaceDb, ImportedRuntimeEvidenceRecordSchema.parse(record));
  }
}

function createRuntimeEvidenceId(checkpointId: string): string {
  return `rte_${createHash('sha256').update(checkpointId).digest('hex').slice(0, 24)}`;
}

/**
 * Returns the deterministic RuntimeEvidence id for one provenance package snapshot.
 *
 * @param packageSnapshotId Package snapshot that owns the evidence.
 * @returns Deterministic runtime evidence id.
 */
export function createWorkerRuntimeProvenanceEvidenceId(packageSnapshotId: string): string {
  return createRuntimeEvidenceId(`worker-runtime-provenance:${packageSnapshotId}`);
}

function materializationBackendVersion(record: WorkspaceMaterializationRecord): string | null {
  const version = record.readinessEvidence
    .map((evidence) => evidence.ref)
    .find((ref) => ref.startsWith('version:'));

  return version ? version.slice('version:'.length) : null;
}

function materializationCapabilitySummary(record: WorkspaceMaterializationRecord): string | null {
  const summary = [...new Set(record.readinessEvidence.map((evidence) => evidence.kind))].join(
    ', '
  );

  return summary || null;
}

function digestRuntimeEvidence(checkpoint: WorkerCheckpointRecord): string {
  return `sha256:${createHash('sha256')
    .update(
      JSON.stringify({
        checkpointId: checkpoint.checkpointId,
        stage: checkpoint.stage,
        stopReason: checkpoint.stopReason,
        updatedAt: checkpoint.updatedAt,
      })
    )
    .digest('hex')}`;
}

function summarizeCheckpointDiagnostics(diagnosticsSummary: string | null): string | null {
  if (!diagnosticsSummary) {
    return null;
  }

  try {
    const parsed = JSON.parse(diagnosticsSummary) as {
      artifactIds?: unknown[];
      itemIds?: unknown[];
    };
    const itemCount = Array.isArray(parsed.itemIds) ? parsed.itemIds.length : 0;
    const artifactCount = Array.isArray(parsed.artifactIds) ? parsed.artifactIds.length : 0;

    return itemCount > 0 || artifactCount > 0
      ? `${itemCount} item${itemCount === 1 ? '' : 's'}, ${artifactCount} artifact${artifactCount === 1 ? '' : 's'}`
      : null;
  } catch {
    return null;
  }
}

function runtimeEvidenceFromRow(row: RuntimeEvidenceRow): RuntimeEvidenceRecord {
  return RuntimeEvidenceRecordSchema.parse({
    id: row.runtime_evidence_id,
    workspaceId: row.workspace_id,
    threadId: row.thread_id,
    turnId: row.turn_id,
    goalId: row.goal_id,
    taskId: row.task_id,
    agentSessionId: row.agent_session_id,
    backendType: row.backend_type,
    backendVersion: row.backend_version,
    placement: row.placement,
    phase: row.phase,
    summary: row.summary,
    policyDigest: row.policy_digest,
    workerImage: row.worker_image,
    sandboxSummary: row.sandbox_summary,
    capabilitySummary: row.capability_summary,
    uploadManifest: JSON.parse(row.upload_manifest_json) as unknown,
    downloadManifest: JSON.parse(row.download_manifest_json) as unknown,
    transcriptSummary: row.transcript_summary,
    workspaceChangeSummary: row.workspace_change_summary,
    controlSummary: row.control_summary,
    outcome: row.outcome,
    exitCode: row.exit_code,
    signal: row.signal,
    stopReason: row.stop_reason,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    redactedStdoutSummary: row.redacted_stdout_summary,
    redactedStderrSummary: row.redacted_stderr_summary,
    evidenceBundleIds: JSON.parse(row.evidence_bundle_ids_json) as unknown,
    contentDigests: JSON.parse(row.content_digests_json) as unknown,
    requiredFeatures: JSON.parse(row.required_features_json) as unknown,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    collectedAt: row.collected_at,
  });
}

function insertRuntimeEvidence(
  workspaceDb: WorkspaceDb,
  record: RuntimeEvidenceRecord
): RuntimeEvidenceRecord {
  const existingRow = workspaceDb.sqlite
    .prepare('SELECT * FROM runtime_evidence WHERE runtime_evidence_id = ?')
    .get(record.id) as RuntimeEvidenceRow | undefined;
  if (existingRow) {
    const existing = runtimeEvidenceFromRow(existingRow);
    if (JSON.stringify(existing) !== JSON.stringify(record)) {
      throw new Error(`Runtime evidence replay conflict: ${record.id}`);
    }
    return existing;
  }
  workspaceDb.sqlite
    .prepare(
      `INSERT INTO runtime_evidence (
        runtime_evidence_id,
        workspace_id,
        thread_id,
        turn_id,
        goal_id,
        task_id,
        agent_session_id,
        backend_type,
        backend_version,
        placement,
        phase,
        summary,
        policy_digest,
        worker_image,
        sandbox_summary,
        capability_summary,
        upload_manifest_json,
        download_manifest_json,
        transcript_summary,
        workspace_change_summary,
        control_summary,
        outcome,
        exit_code,
        signal,
        stop_reason,
        error_code,
        error_message,
        redacted_stdout_summary,
        redacted_stderr_summary,
        evidence_bundle_ids_json,
        content_digests_json,
        required_features_json,
        created_at,
        started_at,
        completed_at,
        collected_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      record.id,
      record.workspaceId,
      record.threadId,
      record.turnId,
      record.goalId,
      record.taskId,
      record.agentSessionId,
      record.backendType,
      record.backendVersion,
      record.placement,
      record.phase,
      record.summary,
      record.policyDigest,
      record.workerImage,
      record.sandboxSummary,
      record.capabilitySummary,
      JSON.stringify(record.uploadManifest),
      JSON.stringify(record.downloadManifest),
      record.transcriptSummary,
      record.workspaceChangeSummary,
      record.controlSummary,
      record.outcome,
      record.exitCode,
      record.signal,
      record.stopReason,
      record.errorCode,
      record.errorMessage,
      record.redactedStdoutSummary,
      record.redactedStderrSummary,
      JSON.stringify(record.evidenceBundleIds),
      JSON.stringify(record.contentDigests),
      JSON.stringify(record.requiredFeatures),
      record.createdAt,
      record.startedAt,
      record.completedAt,
      record.collectedAt
    );

  return record;
}
