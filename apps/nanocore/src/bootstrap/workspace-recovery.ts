import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isEntityId } from '@openkit/protocol';
import Database from 'better-sqlite3';
import { configureOwnedSqlite } from '../storage/control-store.js';
import type { CoreDb } from '../storage/db.js';
import { bindWorkspaceSqlite } from '../storage/db.js';
import { abandonCapture } from '../storage/workspace-capture-protection.js';
import type { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import { isScopeAdmitted, refuseScope, scopeAdmissionFailures } from './readiness.js';

/** Only an absent seal under the owned local directory permits automatic crash abandonment. */
function automaticCaptureIsUnsealed(dataRoot: string, workspaceId: string, captureId: string) {
  if (!isEntityId('wsbak', captureId)) throw new Error('Invalid automatic capture identity.');
  let path = dataRoot;
  for (const part of ['server', 'backups', 'workspaces', workspaceId, captureId]) {
    path = join(path, part);
    try {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || !stat.isDirectory())
        throw new Error('Automatic capture directory is unavailable.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
      throw error;
    }
  }
  try {
    lstatSync(join(path, 'seal.json'));
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
}

/** Rebuilds quarantine and the same mutation fence from retained recovery before scoped opens or scanners. */
export function restoreWorkspaceRecoveryAdmission(
  core: CoreDb,
  mutationAdmission?: WorkspaceMutationAdmission
): void {
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
      'SELECT admission_id, workspace_id, state, revision, candidate_ref, proof_json FROM workspace_recovery_admissions'
    )
    .all() as {
    admission_id: string;
    workspace_id: string;
    state: string;
    revision: number;
    candidate_ref: string;
    proof_json: string;
  }[];
  const unresolved = rows.filter(
    (row) =>
      row.state === 'prepared' ||
      (row.admission_id.startsWith('wsbak_') && row.state === 'finished') ||
      (row.state === 'abandoned' &&
        ['moved-out', 'quarantined'].includes(JSON.parse(row.proof_json).result?.disposition))
  );
  for (const row of unresolved)
    refuseScope(core.dataRoot, { scope: 'workspace', id: row.workspace_id, check: 'recovery' });
  // Capture protection also survives a failure before complete bundle facts can be recorded in Core.
  for (const id of registered) {
    if (!isScopeAdmitted(core.dataRoot, 'workspace', id)) continue;
    let db: Database.Database | undefined;
    try {
      db = new Database(join(workspaces, id, 'db/workspace.sqlite'), {
        readonly: true,
        fileMustExist: true,
      });
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='workspace_capture_records'").get()) {
        // This scan precedes scoped migrations: old rows cannot prove automatic origin.
        const columns = db.pragma('table_info(workspace_capture_records)') as { name: string }[];
        if (columns.some((column) => column.name === 'origin')) {
          const automatic = db
            .prepare(
              "SELECT capture_id FROM workspace_capture_records WHERE state='active' AND origin='automatic'"
            )
            .all() as { capture_id: string }[];
          const unsealed = automatic.filter((row) =>
            automaticCaptureIsUnsealed(core.dataRoot, id, row.capture_id)
          );
          if (unsealed.length) {
            db.close();
            // Startup still owns the data-root lock; native and request producers have not started.
            db = new Database(join(workspaces, id, 'db/workspace.sqlite'), {
              fileMustExist: true,
              timeout: 5,
            });
            configureOwnedSqlite(db);
            const writer = bindWorkspaceSqlite(db, core.dataRoot, id);
            for (const row of unsealed) abandonCapture(writer, id, row.capture_id);
          }
        }
        if (
          db.prepare("SELECT 1 FROM workspace_capture_records WHERE state='active' LIMIT 1").get()
        )
          refuseScope(core.dataRoot, { scope: 'workspace', id, check: 'recovery' });
      }
    } catch {
      refuseScope(core.dataRoot, { scope: 'workspace', id, check: 'database' });
    } finally {
      db?.close();
    }
  }
  // Already-refused captures skip reopening above; their existing refusal still closes every producer.
  for (const failure of scopeAdmissionFailures(core.dataRoot)) {
    if (failure.scope !== 'workspace' || failure.check === 'index') continue;
    const owners = unresolved.filter((row) => row.workspace_id === failure.id);
    if (failure.check === 'recovery' && owners.length === 1) {
      const owner = owners[0]!;
      mutationAdmission?.restoreRecoveryClosed(failure.id, {
        admissionId: owner.admission_id,
        revision: owner.revision,
        candidateRef: owner.candidate_ref,
      });
    } else
      mutationAdmission?.restoreClosed(
        failure.id,
        failure.check === 'retired' ? 'ordinary' : 'capture'
      );
  }
}
