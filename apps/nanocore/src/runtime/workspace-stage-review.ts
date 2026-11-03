import { getControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import type { WorkspaceDb } from '../storage/db.js';
import { nativeProductScope } from '../storage/workspace-file-records.js';
import {
  type ControlWorkspaceStageReview,
  ControlWorkspaceStageReviewSchema,
} from '../storage/workspace-stage-review-codecs.js';

/** Publishes the original complete StageReview after the separate immutable Artifact ACK. */
export async function publishWorkspaceStageReview(
  db: WorkspaceDb,
  input: ControlWorkspaceStageReview
): Promise<void> {
  const exact = ControlWorkspaceStageReviewSchema.parse(input);
  if (exact.workspaceId !== db.workspaceId) throw new Error('Workspace stage scope mismatch.');
  const scope = nativeProductScope(db.dataRoot, { kind: 'workspace', workspaceId: db.workspaceId });
  const database = `workspace:${scope.path}`;
  const client = getControlStoreWorkerClient();
  await client.open({
    database,
    path: scope.path,
    dataRoot: db.dataRoot,
    create: false,
    initialize: 'workspace',
    productOwner: scope.owner,
    contentMount: scope.contentMount,
  });
  await client.workspaceStageReview(database, exact);
}
