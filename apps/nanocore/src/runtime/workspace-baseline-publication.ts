import { getControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import type { WorkspaceDb } from '../storage/db.js';
import {
  type ControlWorkspaceBaseline,
  ControlWorkspaceBaselineSchema,
} from '../storage/workspace-baseline-codecs.js';
import { nativeProductScope } from '../storage/workspace-file-records.js';
import type { WorkspaceSnapshotPair } from './workspace-collect-wire.js';
import type { WorkspaceCollectionIdentity } from './workspace-snapshot-chain.js';

/** Opens the actual Workspace owner and awaits the covering FULL acknowledgement for one stage. */
async function publishBaseline(db: WorkspaceDb, input: ControlWorkspaceBaseline): Promise<void> {
  const scope = nativeProductScope(db.dataRoot, { kind: 'workspace', workspaceId: db.workspaceId });
  const client = getControlStoreWorkerClient();
  const database = `workspace:${scope.path}`;
  await client.open({
    database,
    path: scope.path,
    dataRoot: db.dataRoot,
    create: false,
    initialize: 'workspace',
    productOwner: scope.owner,
    contentMount: scope.contentMount,
  });
  await client.workspaceBaseline(database, ControlWorkspaceBaselineSchema.parse(input));
}

/** Publishes only the original initialization identity, before the separate Host source verification. */
export async function authorizeWorkspaceBaselineInitialization(
  db: WorkspaceDb,
  identity: WorkspaceCollectionIdentity
): Promise<void> {
  await publishBaseline(db, { action: 'initialize', identity });
}

/** Publishes the accepted pair only after independent Host source verification, preserving pair-based replay. */
export async function acceptWorkspaceBaseline(
  db: WorkspaceDb,
  identity: WorkspaceCollectionIdentity,
  head: WorkspaceSnapshotPair,
  expectedTree: string | null,
  acceptedCommit: string | null = null
): Promise<void> {
  await publishBaseline(db, { action: 'accept', identity, head, expectedTree, acceptedCommit });
}
