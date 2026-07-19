import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { parseWorkspaceDataSourceCatalog } from '@openkit/config-schema';

import { parseJsoncObject } from '../config/jsonc.js';
import type { CoreDb, WorkspaceDb } from '../storage/db.js';
import { openWorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import { safeWorkspaceRepositoryDisplayName } from './repository-diagnostics.js';
import {
  listWorkspaceRepositoryResources,
  type WorkspaceRepositoryResourceRecord,
} from './repository-store.js';
import { validateRepositoryPath } from './repository-validation.js';

/** Input for mirroring one repository resource into a workspace source catalog. */
export interface SyncRepositoryDataSourceCatalogInput {
  /** Data root that owns the workspace tree. */
  readonly dataRoot: string;
  /** Workspace id that owns the repository resource. */
  readonly workspaceId: string;
  /** Repository resource to mirror as a catalog source. */
  readonly record: WorkspaceRepositoryResourceRecord;
}

/**
 * Mirrors one repository resource into the workspace data source catalog without exposing host paths.
 *
 * @param input Data root, Workspace id, and repository record to mirror.
 * @returns Parsed catalog after the repository source has been written.
 */
export function syncRepositoryDataSourceCatalog(input: SyncRepositoryDataSourceCatalogInput) {
  const catalogPath = dataSourceCatalogPath(input.dataRoot, input.workspaceId);
  const existing = existsSync(catalogPath)
    ? parseWorkspaceDataSourceCatalog(
        parseJsoncObject(readFileSync(catalogPath, 'utf8'), catalogPath)
      )
    : parseWorkspaceDataSourceCatalog({ schemaVersion: 1, sources: [] });
  const source = {
    id: input.record.resourceId,
    kind: 'git' as const,
    displayName: safeWorkspaceRepositoryDisplayName(
      input.record,
      input.record.validation ?? validateRepositoryPath(input.record.localPath)
    ),
    locator: { repositoryResourceId: input.record.resourceId },
    access: 'read-write' as const,
    sensitivity: 'internal' as const,
    allowedSlotKinds: ['worktree' as const],
    status:
      input.record.diagnosticsStatus === 'ready' ? ('active' as const) : ('disabled' as const),
  };
  const catalog = parseWorkspaceDataSourceCatalog({
    ...existing,
    sources: [
      ...existing.sources.filter((candidate) => candidate.id !== input.record.resourceId),
      source,
    ],
  });

  mkdirSync(dirname(catalogPath), { recursive: true });
  writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
  return catalog;
}

/**
 * Backfills workspace repository rows into data-source catalogs for already-existing workspaces.
 *
 * @param coreDb Server-scope database whose data root owns the workspace tree.
 */
export function backfillRepositoryDataSourceCatalogs(coreDb: CoreDb): void {
  for (const workspaceId of listChildDirectories(join(coreDb.dataRoot, 'workspaces'))) {
    if (workspaceId === '.staging') {
      continue;
    }
    syncWorkspaceRepositorySources(coreDb.dataRoot, workspaceId);
  }
}

/**
 * Mirrors repository resources from one workspace database into its source catalog.
 *
 * @param dataRoot Data root that owns the workspace tree.
 * @param workspaceId Workspace id to inspect.
 */
function syncWorkspaceRepositorySources(dataRoot: string, workspaceId: string): void {
  const workspaceDb = openWorkspaceDb(dataRoot, workspaceId);

  try {
    applyScopedMigrations(workspaceDb);
    syncRepositoryRowsFromWorkspaceDb(workspaceDb);
  } finally {
    workspaceDb.sqlite.close();
  }
}

/**
 * Mirrors repository rows from an open workspace database.
 *
 * @param workspaceDb Open workspace database.
 */
function syncRepositoryRowsFromWorkspaceDb(workspaceDb: WorkspaceDb): void {
  const records = listWorkspaceRepositoryResources(workspaceDb, workspaceDb.workspaceId);

  for (const record of records) {
    syncRepositoryDataSourceCatalog({
      dataRoot: workspaceDb.dataRoot,
      workspaceId: workspaceDb.workspaceId,
      record,
    });
  }
}

/**
 * Returns the canonical data-source catalog path for one workspace.
 *
 * @param dataRoot Data root that owns the workspace tree.
 * @param workspaceId Workspace id to resolve.
 * @returns Absolute catalog path.
 */
function dataSourceCatalogPath(dataRoot: string, workspaceId: string): string {
  return join(dataRoot, 'workspaces', workspaceId, 'config', 'data-sources.jsonc');
}

/**
 * Lists direct child directory names in stable order.
 *
 * @param path Parent directory path.
 * @returns Sorted child directory names, or an empty list when the parent is absent.
 */
function listChildDirectories(path: string): string[] {
  if (!existsSync(path)) {
    return [];
  }

  return readdirSync(path)
    .filter((name) => statSync(join(path, name)).isDirectory())
    .sort();
}
