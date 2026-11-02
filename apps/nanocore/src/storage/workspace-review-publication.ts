import type { WorkspaceSyncReviewItem } from '@openkit/app-api-schemas';
import { getControlStoreWorkerClient } from './control-store-worker-client.js';
import type { WorkspaceDb } from './db.js';
import { nativeProductScope } from './workspace-file-records.js';
import {
  type ControlWorkspaceReviewDecision,
  ControlWorkspaceReviewDecisionSchema,
} from './workspace-review-codecs.js';

/**
 * Publishes the original nonaccepted Review/Audit tuple through its actual Workspace owner.
 * @param workspaceDb Existing admitted Workspace connection; Main stays a reader.
 * @param input Exact original decision and attributable Audit facts.
 * @param changeSetId Existing verified Review lineage for local reconstruction of a bounded native refusal.
 * @param beforeSubmit Current Main authority check after awaited native opening, never transmitted.
 * @returns The original joined Review only after its covering FULL acknowledgement.
 */
export async function publishWorkspaceReviewDecision(
  workspaceDb: WorkspaceDb,
  input: ControlWorkspaceReviewDecision,
  changeSetId: string,
  beforeSubmit: () => void
): Promise<WorkspaceSyncReviewItem> {
  const parsed = ControlWorkspaceReviewDecisionSchema.parse(input);
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
  beforeSubmit();
  return client.workspaceReviewDecision(database, parsed, changeSetId);
}
