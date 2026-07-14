import { execFileSync } from 'node:child_process';
import { type MaterializedWorkspaceRoot, materializeWorkspaceRoots } from '@openkit/config-schema';

import { findWorkspaceConfig, type RuntimeConfigSnapshot } from '../config/runtime-config.js';
import type { FsStore } from '../lib/store.js';
import { type CoreDb, openWorkspaceDb } from '../storage/db.js';
import { ensureWorkspaceLayout } from '../storage/fs-layout.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import { syncRepositoryDataSourceCatalog } from '../workspace/repository-data-source-catalog.js';
import {
  getDefaultWorkspaceRepositoryResource,
  type WorkspaceRepositoryResourceRecord,
} from '../workspace/repository-store.js';
import { validateRepositoryPath } from '../workspace/repository-validation.js';
import { TurnStartValidationError } from './orchestrator.js';
import type { TurnStartRuntimeContext } from './types.js';

/**
 * Resolves the repository resource that should back a worker turn.
 *
 * @param coreDb Optional repository database handles for workspace repository links.
 * @param workspaceId Workspace id that owns the turn.
 * @param userId User id that owns the workspace.
 * @returns Ready repository resource for internal worker startup, or null when repository storage is disabled.
 * @throws TurnStartValidationError when repository setup is missing or not ready.
 */
export function resolveWorkspaceRepositoryForTurn(
  coreDb: CoreDb | undefined,
  workspaceId: string,
  userId: string
): WorkspaceRepositoryResourceRecord | null {
  if (!coreDb) {
    return null;
  }

  const workspaceDb = openWorkspaceDb(coreDb.dataRoot, userId, workspaceId);
  let repository: WorkspaceRepositoryResourceRecord | null;
  try {
    applyScopedMigrations(workspaceDb);
    repository = getDefaultWorkspaceRepositoryResource(workspaceDb, workspaceId);
  } finally {
    workspaceDb.sqlite.close();
  }

  if (!repository) {
    throw new TurnStartValidationError(
      'workspace_repository_missing',
      'Workspace repository is not configured.'
    );
  }

  const validation = validateRepositoryPath(repository.localPath);

  if (!validation.ok || validation.status !== 'ready') {
    throw new TurnStartValidationError(
      'workspace_repository_not_ready',
      `Workspace repository is not ready: ${validation.summary}`
    );
  }

  return repository;
}

/**
 * Materializes workspace roots for a turn from the current effective runtime snapshot.
 *
 * @param snapshot Runtime config snapshot captured for the turn.
 * @param store Actor-scoped store that owns the workspace.
 * @param workspaceId Workspace id that owns the turn.
 * @param repository Optional ready repository selected for the turn.
 * @returns Worker launch roots for the accepted turn.
 */
export function materializeWorkspaceRootsForTurn(
  snapshot: RuntimeConfigSnapshot,
  store: FsStore,
  workspaceId: string,
  repository: WorkspaceRepositoryResourceRecord | null = null
): MaterializedWorkspaceRoot[] {
  const dataRoot = store.getDataRoot();
  const workspaceConfig = findWorkspaceConfig(snapshot, store.getUserId(), workspaceId);
  const sourceCommit = repository ? readRepositoryHeadCommit(repository.localPath) : null;
  const repositoryRoot = repository
    ? {
        access: 'read-write' as const,
        id: repository.resourceId,
        ...(sourceCommit ? { sourceCommit } : {}),
        sourceKind: 'host-dir' as const,
        sourcePath: repository.localPath,
        workerPath: '/workspace/openkit',
      }
    : null;

  if (!dataRoot || !workspaceConfig) {
    return repositoryRoot ? [repositoryRoot] : [];
  }

  const layout = ensureWorkspaceLayout(dataRoot, store.getUserId(), workspaceId);
  const configuredRoots = materializeWorkspaceRoots({
    config: workspaceConfig.config,
    workspaceRoot: layout.root,
    createMissing: true,
  });

  if (
    !repositoryRoot ||
    configuredRoots.some(
      (root) => root.id === repositoryRoot.id || root.sourcePath === repositoryRoot.sourcePath
    )
  ) {
    return configuredRoots;
  }

  return [repositoryRoot, ...configuredRoots];
}

/**
 * Captures one linked repository HEAD without loading user Git configuration.
 *
 * @param repositoryPath Ready linked repository path.
 * @returns Full Git object id for the current HEAD commit, or null when the linked path has no commit.
 */
function readRepositoryHeadCommit(repositoryPath: string): string | null {
  try {
    const commit = execFileSync('git', ['rev-parse', '--verify', 'HEAD^{commit}'], {
      cwd: repositoryPath,
      encoding: 'utf8',
      env: {
        GIT_CONFIG_COUNT: '0',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_OPTIONAL_LOCKS: '0',
        LC_ALL: 'C',
        PATH: process.env.PATH ?? '',
      },
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 20_000,
    }).trim();

    if (/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)) {
      return commit;
    }
  } catch {
    // Unavailable Git state stays unpinned and remains fail-closed at worker review ingress.
  }

  return null;
}

/**
 * Builds sourceRef context for repository-backed worker launches.
 *
 * @param coreDb Optional repository database handles for workspace source synchronization.
 * @param snapshot Runtime config snapshot captured for the turn.
 * @param store Request store that owns the workspace tree.
 * @param workspaceId Workspace id that owns the turn.
 * @param repository Repository selected for the worker, when any.
 * @param workspaceRoots Worker roots captured for the turn.
 * @returns Optional Agent Environment Package sourceRef context.
 * @throws Error when a selected repository has no configured Core database.
 */
export function workspaceSourceContextForTurn(
  coreDb: CoreDb | undefined,
  snapshot: RuntimeConfigSnapshot,
  store: FsStore,
  workspaceId: string,
  repository: WorkspaceRepositoryResourceRecord | null,
  workspaceRoots: MaterializedWorkspaceRoot[]
): Pick<TurnStartRuntimeContext, 'workspaceDataSourceCatalog' | 'workspaceSourceRefs'> {
  let workspaceDataSourceCatalog = snapshot.workspaceDataSourceCatalogs.find(
    (entry) => entry.userId === store.getUserId() && entry.workspaceId === workspaceId
  )?.catalog;

  if (!repository || !workspaceRoots.some((root) => root.id === repository.resourceId)) {
    return workspaceDataSourceCatalog ? { workspaceDataSourceCatalog } : {};
  }

  if (!coreDb) {
    throw new Error('Repository storage is unavailable for this NanoCore instance.');
  }

  workspaceDataSourceCatalog = syncRepositoryDataSourceCatalog({
    dataRoot: coreDb.dataRoot,
    userId: store.getUserId(),
    workspaceId,
    record: repository,
  });

  return {
    workspaceDataSourceCatalog,
    workspaceSourceRefs: { [repository.resourceId]: repository.resourceId },
  };
}
