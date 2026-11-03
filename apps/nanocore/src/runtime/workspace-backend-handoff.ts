import type {
  WorkspaceInputSnapshot,
  WorkspaceMaterializationRecord,
} from '@openkit/app-api-schemas';
import { getControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import type { WorkspaceDb } from '../storage/db.js';
import { ControlWorkspaceBackendHandoffSchema } from '../storage/workspace-backend-handoff-codecs.js';
import { nativeProductScope } from '../storage/workspace-file-records.js';

/**
 * Atomically publishes the exact input-snapshot and backend-handle handoff for one package.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param inputSnapshots Package input snapshots built before materialization.
 * @param materializationRecords Exact backend materialization records built after creation.
 * @returns Stored snapshots and materialization records.
 */
export async function recordWorkspaceBackendHandoff(
  workspaceDb: WorkspaceDb,
  inputSnapshots: readonly WorkspaceInputSnapshot[],
  materializationRecords: readonly WorkspaceMaterializationRecord[]
): Promise<{
  readonly inputSnapshots: WorkspaceInputSnapshot[];
  readonly materializationRecords: WorkspaceMaterializationRecord[];
}> {
  const input = ControlWorkspaceBackendHandoffSchema.parse({
    workspaceId: workspaceDb.workspaceId,
    inputSnapshots,
    materializationRecords,
  });
  const scope = nativeProductScope(workspaceDb.dataRoot, {
    kind: 'workspace',
    workspaceId: workspaceDb.workspaceId,
  });
  const client = getControlStoreWorkerClient();
  const database = `workspace:${scope.path}`;
  await client.open({
    database,
    path: scope.path,
    dataRoot: workspaceDb.dataRoot,
    create: false,
    initialize: 'workspace',
    productOwner: scope.owner,
    contentMount: scope.contentMount,
  });
  return client.workspaceBackendHandoff(database, input);
}
