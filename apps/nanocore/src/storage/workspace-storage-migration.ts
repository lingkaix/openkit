import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isScopeAdmitted, refuseScope } from '../bootstrap/readiness.js';
import { recoverRunningCapabilityCalls } from '../capability/usage-ledger.js';
import {
  assertSqliteIntegrity,
  listChildDirectories,
  listWorkspaceDirectories,
  openBootVerifiedWorkspaceDb,
  openUserDb,
} from './db.js';
import { ensureLayout, userDbPath, workspaceDbPath } from './fs-layout.js';
import { applyScopedMigrations } from './migrate.js';

/**
 * Validates and migrates existing User and Workspace scopes during boot.
 * Isolated failures refuse their own scope. Shared layout failures stop boot.
 */
export async function verifyAndMigrateExistingScopedDatabases(
  dataRoot: string,
  validateFileAuthority?: () => void
): Promise<void> {
  ensureLayout(dataRoot);
  const scopes = [
    ...listChildDirectories(join(dataRoot, 'users')).map((id) => ({ scope: 'user' as const, id })),
    ...listWorkspaceDirectories(dataRoot).map((id) => ({ scope: 'workspace' as const, id })),
  ];
  for (const { scope, id } of scopes) {
    if (!isScopeAdmitted(dataRoot, scope, id)) continue;
    try {
      const path = scope === 'workspace' ? workspaceDbPath(dataRoot, id) : userDbPath(dataRoot, id);
      if (scope === 'workspace' && (!existsSync(path) || statSync(path).size === 0))
        throw new Error('Expected Workspace database is missing or uninitialized.');
      assertSqliteIntegrity(path);
    } catch {
      refuseScope(dataRoot, { scope, id, check: 'database' });
    }
  }

  // Boot must not migrate or recover a scope whose canonical file authority is unreadable.
  validateFileAuthority?.();
  for (const { scope, id } of scopes) {
    if (!isScopeAdmitted(dataRoot, scope, id)) continue;
    try {
      if (scope === 'workspace') await migrateWorkspaceDatabase(dataRoot, id);
      else migrateUserDatabase(dataRoot, id);
    } catch {
      refuseScope(dataRoot, { scope, id, check: 'database' });
    }
  }
}

/** Applies User migrations after integrity and boot file-authority admission. */
function migrateUserDatabase(dataRoot: string, userId: string): void {
  const userDb = openUserDb(dataRoot, userId);
  try {
    applyScopedMigrations(userDb);
  } finally {
    userDb.sqlite.close();
  }
}

/** Applies Workspace migrations and call-loss recovery after both authority checks. */
async function migrateWorkspaceDatabase(dataRoot: string, workspaceId: string): Promise<void> {
  const workspaceDb = openBootVerifiedWorkspaceDb(dataRoot, workspaceId);
  try {
    applyScopedMigrations(workspaceDb);
    recoverRunningCapabilityCalls({ workspaceDb });
  } finally {
    workspaceDb.sqlite.close();
  }
}
