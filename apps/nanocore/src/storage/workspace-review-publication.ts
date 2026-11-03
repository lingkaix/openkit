import type { WorkspaceSyncReviewItem } from '@openkit/app-api-schemas';
import { getControlStoreWorkerClient } from './control-store-worker-client.js';
import type { WorkspaceDb } from './db.js';
import { nativeProductScope } from './workspace-file-records.js';
import {
  type ControlWorkspaceReviewDecision,
  ControlWorkspaceReviewDecisionSchema,
  type ControlWorkspaceReviewFinish,
  ControlWorkspaceReviewFinishSchema,
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

/**
 * Publishes the complete original accepted finish after its separately durable Plan and filesystem effect.
 * @param workspaceDb Actual admitted Workspace connection; Main remains a reader.
 * @param input Exact Result, original request and attributable decision facts.
 * @returns Only after the covering FULL acknowledgement; missing ACK remains unknown.
 */
export async function publishWorkspaceReviewFinish(
  workspaceDb: WorkspaceDb,
  input: ControlWorkspaceReviewFinish
): Promise<void> {
  const parsed = ControlWorkspaceReviewFinishSchema.parse(input);
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
  return client.workspaceReviewFinish(database, parsed, parsed.result.changeSetId);
}
