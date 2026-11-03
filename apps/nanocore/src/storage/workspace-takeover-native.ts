import { listWorkspaceReconciliationRecords } from '../runtime/workspace-reconciliation-read.js';
import type { WorkspaceDb } from './db.js';
import { requireCompleteBackendWorkspaceHandleHandoff } from './workspace-handoff-read.js';
import { recordWorkspaceReconciliationRecord } from './workspace-reconciliation-records.js';
import {
  type ControlWorkspaceTakeover,
  WorkspaceTakeoverRefusal,
} from './workspace-takeover-codecs.js';

/** Revalidates the original handoff and current rows inside one original per-handle stage. */
export function applyWorkspaceTakeoverInDb(
  db: WorkspaceDb,
  input: ControlWorkspaceTakeover
): boolean {
  try {
    const { attempt, environmentPackage, timestamp, physicallyCleaned } = input;
    const handles = requireCompleteBackendWorkspaceHandleHandoff(db, environmentPackage);
    if (input.action === 'handle' && !handles.some((handle) => handle.id === input.handleId))
      throw new WorkspaceTakeoverRefusal(environmentPackage.snapshotId);
    const existing = new Set(
      listWorkspaceReconciliationRecords(db, attempt.workspaceId).map((record) => record.id)
    );
    for (const handle of handles) {
      if (input.action !== 'handle' || handle.id !== input.handleId) continue;
      const id = `wrr_${attempt.attemptId}_${handle.id}`;
      if (handle.cleanupStatus !== 'pending' || existing.has(id)) continue;
      recordWorkspaceReconciliationRecord(db, {
        affectedRecordIds: [handle.materializationRecordId, handle.id],
        backendHandleSummary: {
          backendKind: handle.backendKind,
          cleanupStatus: handle.cleanupStatus,
          handleId: handle.id,
          workerSessionId: handle.workerSessionId,
        },
        backendReachability: {
          checkedAt: timestamp,
          detail: attempt.terminalCause,
          status: 'unavailable',
        },
        collectedOutputManifestIds: [],
        evidenceBundleIds: [`evb_workspace_materialization_${handle.materializationRecordId}`],
        finishedAt: null,
        id,
        quarantineRefs: [],
        requiredHumanDecision: 'inspect_recovery',
        retentionDecision: physicallyCleaned ? 'teardown-backend' : 'retain-backend',
        startedAt: timestamp,
        stateAfter: 'requires-human',
        stateBefore: attempt.phase,
        triggerReason: 'backend_takeover',
        workspaceId: attempt.workspaceId,
      });
    }
    if (input.action === 'handle') return false;
    return (
      !physicallyCleaned &&
      listWorkspaceReconciliationRecords(db, attempt.workspaceId).some(
        (record) =>
          record.stateAfter === 'requires-human' &&
          record.retentionDecision === 'retain-backend' &&
          handles.some((handle) => record.affectedRecordIds.includes(handle.id))
      )
    );
  } catch (error) {
    const refusal = new WorkspaceTakeoverRefusal(input.environmentPackage.snapshotId);
    if (error instanceof Error && error.message === refusal.message) throw refusal;
    throw error;
  }
}
