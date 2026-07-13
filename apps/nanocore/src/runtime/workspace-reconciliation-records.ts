import {
  type WorkerOutputManifest,
  type WorkspaceReconciliationRecord,
  WorkspaceReconciliationRecordSchema,
  type WorkspaceRecoveryDecision,
} from '@openkit/app-api-schemas';
import type { WorkspaceDb } from '../storage/db.js';

interface WorkspaceReconciliationRecordRow {
  readonly payload_json: string;
}

interface ResumeWorkspaceRecoveryCollectionInput {
  /** Durable worker output manifests currently available for the workspace. */
  readonly workerOutputManifests?: readonly WorkerOutputManifest[];
}

/**
 * Persists one durable workspace reconciliation record.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param record Reconciliation record to persist.
 * @returns Stored public workspace reconciliation record.
 */
export function recordWorkspaceReconciliationRecord(
  workspaceDb: WorkspaceDb,
  record: WorkspaceReconciliationRecord
): WorkspaceReconciliationRecord {
  const parsed = WorkspaceReconciliationRecordSchema.parse(record);
  workspaceDb.sqlite
    .prepare(
      `INSERT INTO workspace_reconciliation_records (
        reconciliation_record_id,
        workspace_id,
        trigger_reason,
        state_after,
        payload_json,
        started_at,
        finished_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, reconciliation_record_id) DO UPDATE SET
        trigger_reason = excluded.trigger_reason,
        state_after = excluded.state_after,
        payload_json = excluded.payload_json,
        finished_at = excluded.finished_at,
        updated_at = excluded.updated_at`
    )
    .run(
      parsed.id,
      parsed.workspaceId,
      parsed.triggerReason,
      parsed.stateAfter,
      JSON.stringify(parsed),
      parsed.startedAt,
      parsed.finishedAt,
      parsed.finishedAt ?? parsed.startedAt
    );

  return parsed;
}

/**
 * Lists durable workspace reconciliation records for one workspace.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param workspaceId Workspace id.
 * @returns Stored reconciliation records in newest-first order.
 */
export function listWorkspaceReconciliationRecords(
  workspaceDb: WorkspaceDb,
  workspaceId: string
): WorkspaceReconciliationRecord[] {
  return (
    workspaceDb.sqlite
      .prepare(
        `SELECT payload_json
         FROM workspace_reconciliation_records
         WHERE workspace_id = ?
         ORDER BY started_at ASC, reconciliation_record_id ASC`
      )
      .all(workspaceId) as WorkspaceReconciliationRecordRow[]
  )
    .map((row) =>
      WorkspaceReconciliationRecordSchema.parse(JSON.parse(row.payload_json) as unknown)
    )
    .reverse();
}

/**
 * Resolves one human-required workspace reconciliation record.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param input Recovery decision input.
 * @returns Updated reconciliation record.
 */
export function resolveWorkspaceReconciliationRecord(
  input: {
    /** Open workspace-scope database handle. */
    readonly workspaceDb: WorkspaceDb;
    /** Workspace id. */
    readonly workspaceId: string;
    /** Reconciliation record id. */
    readonly reconciliationRecordId: string;
    /** Human recovery decision. */
    readonly decision: WorkspaceRecoveryDecision;
    /** Decision timestamp. */
    readonly decidedAt: string;
  } & ResumeWorkspaceRecoveryCollectionInput
): WorkspaceReconciliationRecord {
  const record = listWorkspaceReconciliationRecords(input.workspaceDb, input.workspaceId).find(
    (candidate) => candidate.id === input.reconciliationRecordId
  );

  if (!record) {
    throw new Error(`Workspace reconciliation record not found: ${input.reconciliationRecordId}`);
  }
  if (record.stateAfter !== 'requires-human') {
    throw new Error(
      `Workspace reconciliation record is already terminal: ${input.reconciliationRecordId}`
    );
  }

  const resumeCollection =
    input.decision === 'resume_collection'
      ? resolveResumeCollection({
          decidedAt: input.decidedAt,
          record,
          workerOutputManifests: input.workerOutputManifests ?? [],
        })
      : null;
  const updated = WorkspaceReconciliationRecordSchema.parse({
    ...record,
    ...(resumeCollection ?? {}),
    stateBefore: 'requires-human',
    stateAfter: recoveryDecisionState(input.decision),
    requiredHumanDecision: null,
    retentionDecision: 'teardown-backend',
    finishedAt: input.decidedAt,
  });

  return recordWorkspaceReconciliationRecord(input.workspaceDb, updated);
}

/**
 * Resolves the durable portion of automatic recovery collection.
 *
 * @param input Resume collection candidates and target record.
 * @returns Reconciliation fields collected from durable workspace sync rows.
 */
function resolveResumeCollection(input: {
  /** Decision timestamp. */
  readonly decidedAt: string;
  /** Reconciliation record being resumed. */
  readonly record: WorkspaceReconciliationRecord;
  /** Durable worker output manifests currently available for the workspace. */
  readonly workerOutputManifests: readonly WorkerOutputManifest[];
}): Pick<
  WorkspaceReconciliationRecord,
  'backendReachability' | 'collectedOutputManifestIds' | 'evidenceBundleIds'
> {
  const affectedRecordIds = new Set(input.record.affectedRecordIds);
  const existingManifestIds = new Set(input.record.collectedOutputManifestIds);
  const matchingOutputManifestIds = input.workerOutputManifests
    .filter(
      (manifest) =>
        affectedRecordIds.has(manifest.materializationRecordId) ||
        existingManifestIds.has(manifest.id)
    )
    .map((manifest) => manifest.id);
  const collectedOutputManifestIds = uniqueStrings([
    ...input.record.collectedOutputManifestIds,
    ...matchingOutputManifestIds,
  ]);

  if (matchingOutputManifestIds.length === 0) {
    throw new Error(
      `Workspace recovery collection has no durable output manifest: ${input.record.id}`
    );
  }

  return {
    backendReachability: {
      checkedAt: input.decidedAt,
      detail:
        'Recovered from durable worker output manifests; live backend reachability was not required.',
      status: 'unknown',
    },
    collectedOutputManifestIds,
    evidenceBundleIds: input.record.evidenceBundleIds,
  };
}

/**
 * Deduplicates strings while preserving first-seen order.
 *
 * @param values Candidate string values.
 * @returns Unique values in stable order.
 */
function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/**
 * Maps a recovery decision to the terminal reconciliation state.
 *
 * @param decision Human recovery decision.
 * @returns Terminal reconciliation state.
 */
function recoveryDecisionState(
  decision: WorkspaceRecoveryDecision
): WorkspaceReconciliationRecord['stateAfter'] {
  if (decision === 'stage_verified') {
    return 'recovered';
  }
  if (decision === 'resume_collection') {
    return 'recovered';
  }
  if (decision === 'quarantine') {
    return 'quarantined';
  }

  return 'unrecoverable';
}

/**
 * Lists durable workspace reconciliation records for export in stable order.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param workspaceId Workspace id.
 * @returns Exportable reconciliation records in oldest-first order.
 */
export function listExportableWorkspaceReconciliationRecords(
  workspaceDb: WorkspaceDb,
  workspaceId: string
): WorkspaceReconciliationRecord[] {
  return [...listWorkspaceReconciliationRecords(workspaceDb, workspaceId)].reverse();
}

/**
 * Replays imported workspace reconciliation records.
 *
 * @param workspaceDb Open target workspace database handle.
 * @param records Exported reconciliation records to replay.
 */
export function importWorkspaceReconciliationRecords(
  workspaceDb: WorkspaceDb,
  records: readonly WorkspaceReconciliationRecord[]
): void {
  for (const record of records) {
    recordWorkspaceReconciliationRecord(
      workspaceDb,
      WorkspaceReconciliationRecordSchema.parse(record)
    );
  }
}
