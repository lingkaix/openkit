import { isArtifactVisible } from './auth/thread-visibility.js';
import type { FsStore } from './lib/store.js';
import { listWorkspaceSyncReviews } from './runtime/workspace-sync-records.js';
import { type CoreDb, openWorkspaceDb } from './storage/db.js';
import { applyScopedMigrations } from './storage/migrate.js';

/**
 * Lists submitted outputs, excluding exact durable Workspace Sync Review backing records.
 *
 * This actor-scoped product projection does not replace retained history or direct-read guards.
 * @param store Workspace Artifact authority.
 * @param coreDb Deployment database, absent in purely in-memory local instances.
 * @param workspaceId Already authorized Workspace to inspect.
 * @param userId Authenticated actor whose immutable Thread audience must permit discovery.
 * @returns Deliverables without internal review evidence, preserving store order.
 */
export function listOutputArtifacts(
  store: FsStore,
  coreDb: CoreDb | undefined,
  workspaceId: string,
  userId: string | undefined
) {
  const artifacts = store
    .listArtifacts(workspaceId)
    .filter((artifact) => isArtifactVisible(store, artifact, userId));
  if (!coreDb || artifacts.length === 0) return artifacts;
  const workspaceDb = openWorkspaceDb(coreDb.dataRoot, workspaceId);
  try {
    applyScopedMigrations(workspaceDb);
    const reviewArtifactIds = new Set(
      listWorkspaceSyncReviews(workspaceDb, workspaceId).map((review) => review.artifactId)
    );
    return artifacts.filter((artifact) => !reviewArtifactIds.has(artifact.id));
  } finally {
    workspaceDb.sqlite.close();
  }
}
