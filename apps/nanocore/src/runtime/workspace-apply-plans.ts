import { type WorkspaceApplyPlan, WorkspaceApplyPlanSchema } from '@openkit/app-api-schemas';
import { getControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import type { WorkspaceDb } from '../storage/db.js';
import { nativeProductScope } from '../storage/workspace-file-records.js';

export {
  listExportableWorkspaceApplyPlans,
  listWorkspaceApplyPlans,
  StoredWorkspaceApplyPlanV1Schema,
} from '../storage/workspace-apply-plan-records.js';

/**
 * Publishes the original immutable Plan through its Workspace physical owner and covering FULL ACK.
 * @param workspaceDb Existing admitted Workspace connection; Main remains a reader.
 * @param plan Original preflight instructions, independently committed before filesystem effects.
 * @param beforeSubmit Optional caller-owned current-authority check after native open; it never crosses the wire.
 * @returns Original accepted Plan, including its first creation timestamp on exact replay.
 */
export async function recordWorkspaceApplyPlan(
  workspaceDb: WorkspaceDb,
  plan: WorkspaceApplyPlan,
  beforeSubmit?: () => void
): Promise<WorkspaceApplyPlan> {
  const input = WorkspaceApplyPlanSchema.parse(plan);
  const scope = nativeProductScope(workspaceDb.dataRoot, {
    kind: 'workspace',
    workspaceId: workspaceDb.workspaceId,
  });
  const database = `workspace:${scope.path}`;
  const client = getControlStoreWorkerClient();
  await client.open({
    database,
    path: scope.path,
    dataRoot: workspaceDb.dataRoot,
    create: false,
    initialize: 'workspace',
    productOwner: scope.owner,
    contentMount: scope.contentMount,
  });
  beforeSubmit?.();
  return client.workspaceApplyPlan(database, input);
}
