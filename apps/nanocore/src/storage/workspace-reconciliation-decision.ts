import type {
  WorkerOutputManifest,
  WorkspaceReconciliationRecord,
  WorkspaceRecoveryDecision,
} from '@openkit/app-api-schemas';
import { StoreRecordNotFoundError } from '../lib/store-errors.js';
import { OperationError } from '../operation-error-core.js';
import { listWorkspaceReconciliationRecords } from '../runtime/workspace-reconciliation-read.js';
import { StoredWorkspaceReconciliationRecordV1Schema } from '../runtime/workspace-sync-outcomes-v1.js';
import type { WorkspaceDb } from './db.js';
import { persistWorkspaceReconciliationRecordV1 } from './workspace-reconciliation-records.js';

interface ResumeWorkspaceRecoveryCollectionInput {
  /** Durable worker output manifests currently available for the workspace. */
  readonly workerOutputManifests?: readonly WorkerOutputManifest[];
}

/**
 * Resolves one human-required workspace reconciliation record.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param input Recovery decision input.
 * @returns Updated reconciliation record.
 * @throws StoreRecordNotFoundError for a missing record or OperationError for a known decision refusal.
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
    throw new StoreRecordNotFoundError(
      `Workspace reconciliation record not found: ${input.reconciliationRecordId}`
    );
  }
  if (record.stateAfter !== 'requires-human') {
    throw new OperationError(
      'workspace_recovery_decision_failed',
      `Workspace reconciliation record is already terminal: ${input.reconciliationRecordId}`,
      404
    );
  }

  if (record.id.startsWith('wrr_capture_') && input.decision !== 'abandon') {
    throw new OperationError(
      'workspace_recovery_decision_failed',
      'Unaccepted capture source supports only abandon with evidence retained.',
      409
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
  const updated = StoredWorkspaceReconciliationRecordV1Schema.parse({
    ...record,
    ...(resumeCollection ?? {}),
    stateBefore: 'requires-human',
    stateAfter: recoveryDecisionState(input.decision),
    requiredHumanDecision: null,
    retentionDecision: 'teardown-backend',
    finishedAt: input.decidedAt,
  });

  return persistWorkspaceReconciliationRecordV1(input.workspaceDb, updated);
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
    throw new OperationError(
      'workspace_recovery_decision_failed',
      `Workspace recovery collection has no durable output manifest: ${input.record.id}`,
      404
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
