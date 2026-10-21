import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { CoreDb } from '../storage/db.js';
import { isScopeAdmitted, refuseScope } from './readiness.js';

/** Refuses unpublished bytes and unfinished offline decisions before any scoped open or recovery. */
export function restoreWorkspaceRecoveryAdmission(core: CoreDb): void {
  const registered = new Set(
    core.sqlite
      .prepare("SELECT workspace_id FROM workspace_registry WHERE status='active'")
      .pluck()
      .all() as string[]
  );
  const workspaces = join(core.dataRoot, 'workspaces');
  for (const entry of existsSync(workspaces)
    ? readdirSync(workspaces, { withFileTypes: true })
    : []) {
    if (entry.isDirectory() && entry.name !== '.staging' && !registered.has(entry.name))
      refuseScope(core.dataRoot, { scope: 'workspace', id: entry.name, check: 'recovery' });
  }
  const rows = core.sqlite
    .prepare(
      'SELECT admission_id, workspace_id, state, proof_json FROM workspace_recovery_admissions'
    )
    .all() as { admission_id: string; workspace_id: string; state: string; proof_json: string }[];
  for (const row of rows) {
    const source = row.admission_id.startsWith('wsbak_');
    const revokedButNotReopened =
      row.state === 'abandoned' && JSON.parse(row.proof_json).result?.disposition === 'moved-out';
    if (row.state === 'prepared' || (source && (row.state === 'finished' || revokedButNotReopened)))
      refuseScope(core.dataRoot, { scope: 'workspace', id: row.workspace_id, check: 'recovery' });
  }
  // Capture protection also survives a failure before complete bundle facts can be recorded in Core.
  for (const id of registered) {
    if (!isScopeAdmitted(core.dataRoot, 'workspace', id)) continue;
    let db: Database.Database | undefined;
    try {
      db = new Database(join(workspaces, id, 'db/workspace.sqlite'), {
        readonly: true,
        fileMustExist: true,
      });
      if (
        db.prepare("SELECT 1 FROM sqlite_master WHERE name='workspace_capture_records'").get() &&
        db.prepare("SELECT 1 FROM workspace_capture_records WHERE state='active' LIMIT 1").get()
      )
        refuseScope(core.dataRoot, { scope: 'workspace', id, check: 'recovery' });
    } catch {
      refuseScope(core.dataRoot, { scope: 'workspace', id, check: 'database' });
    } finally {
      db?.close();
    }
  }
}
