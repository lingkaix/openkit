import type { WorkspaceSyncReviewItem } from '@openkit/app-api-schemas';
import {
  recordWorkspaceInputSnapshots,
  recordWorkspaceMaterializationRecords,
} from '../runtime/workspace-sync-records.js';
import type { WorkspaceDb } from '../storage/db.js';

/**
 * Persists deterministic trusted materialization lineage for one review fixture.
 *
 * @param workspaceDb Workspace database owned by the test.
 * @param item Review fixture whose change set names the required materialization.
 */
export function recordTestWorkspaceReviewMaterialization(
  workspaceDb: WorkspaceDb,
  item: WorkspaceSyncReviewItem
): void {
  const { changeSet } = item;
  recordWorkspaceInputSnapshots(workspaceDb, [
    {
      backend: {
        capabilitySummary: [],
        kind: 'openshell',
        label: 'test backend',
      },
      base: changeSet.base,
      createdAt: changeSet.createdAt,
      generatedFiles: [],
      id: changeSet.inputSnapshotId,
      ignoredPaths: [],
      pathScope: [changeSet.resourceId],
      resourceId: changeSet.resourceId,
      resourceKind: changeSet.strategy === 'git' ? 'git_repository' : 'filesystem',
      ...(changeSet.sourceId ? { sourceId: changeSet.sourceId } : {}),
      strategy: changeSet.strategy,
      workspaceId: changeSet.workspaceId,
      writableRoots: [changeSet.resourceId],
    },
  ]);
  recordWorkspaceMaterializationRecords(workspaceDb, [
    {
      backendKind: 'openshell',
      base: changeSet.base,
      createdAt: changeSet.createdAt,
      id: changeSet.materializationRecordId,
      inputSnapshotId: changeSet.inputSnapshotId,
      materializedRootRef: `workspace://${changeSet.workspaceId}/${changeSet.resourceId}`,
      packageSnapshotId: `aepsnap_test_${changeSet.materializationRecordId}`,
      policyDigest: 'sha256:test-workspace-materialization',
      readinessEvidence: [],
      ...(changeSet.sourceId ? { sourceId: changeSet.sourceId } : {}),
      strategy: changeSet.strategy,
      workerSessionId: `sandbox_test_${changeSet.materializationRecordId}`,
      workspaceId: changeSet.workspaceId,
    },
  ]);
}
