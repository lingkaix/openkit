import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isEntityId } from '@openkit/protocol';
import Database from 'better-sqlite3';
import { configureOwnedSqlite } from '../storage/control-store.js';
import type { CoreDb } from '../storage/db.js';
import { bindWorkspaceSqlite } from '../storage/db.js';
import { abandonCapture, inspectCapture } from '../storage/workspace-capture-protection.js';
import { syncCanonicalDirectory } from '../storage/workspace-file-records.js';
import type { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import { isScopeAdmitted, refuseScope, scopeAdmissionFailures } from './readiness.js';

/** Only owned seal absence permits abandonment; a retired publication also owes durable absence. */
function captureSealIsAbsent(
  dataRoot: string,
  workspaceId: string,
  captureId: string,
  synchronizeAbsence = false
) {
  const absent = (parent: string) => {
    if (synchronizeAbsence) {
      try {
        syncCanonicalDirectory(parent);
      } catch {
        // Unproved absence stays pending so the normal census retains its exact retry origin.
        refuseScope(dataRoot, { scope: 'workspace', id: workspaceId, check: 'recovery' });
        return false;
      }
    }
    return true;
  };
  if (!isEntityId('wsbak', captureId)) throw new Error('Invalid automatic capture identity.');
  let path = dataRoot;
  for (const part of ['server', 'backups', 'workspaces', workspaceId, captureId]) {
    path = join(path, part);
    try {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || !stat.isDirectory())
        throw new Error('Automatic capture directory is unavailable.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return absent(dirname(path));
      throw error;
    }
  }
  try {
    lstatSync(join(path, 'seal.json'));
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return absent(path);
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
  const captureOrigins = new Map<string, string>();
  // Capture protection also survives a failure before complete bundle facts can be recorded in Core.
  for (const id of registered) {
    if (!isScopeAdmitted(core.dataRoot, 'workspace', id)) {
      const failure = scopeAdmissionFailures(core.dataRoot).find(
        (row) => row.scope === 'workspace' && row.id === id && row.check !== 'index'
      );
      // A repeated census may re-read capture facts, never a refused target candidate.
      if (failure?.check !== 'recovery' || unresolved.some((row) => row.workspace_id === id))
        continue;
    }
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
            captureSealIsAbsent(core.dataRoot, id, row.capture_id)
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
        const active = db
          .prepare("SELECT capture_id FROM workspace_capture_records WHERE state='active'")
          .all() as { capture_id: string }[];
        // Publication can close before retiring its original seal. That interrupted
        // abandonment stays quarantined until exact recovery proves durable absence.
        const retiring = (
          db
            .prepare("SELECT capture_id FROM workspace_capture_records WHERE state='abandoned'")
            .all() as { capture_id: string }[]
        ).filter((row) => !captureSealIsAbsent(core.dataRoot, id, row.capture_id, true));
        const pending = [...active, ...retiring];
        if (pending.length) {
          if (pending.length === 1) {
            const capture = inspectCapture(
              bindWorkspaceSqlite(db, core.dataRoot, id),
              id,
              pending[0]!.capture_id
            );
            if (capture) captureOrigins.set(id, capture.captureId);
          }
          refuseScope(core.dataRoot, { scope: 'workspace', id, check: 'recovery' });
        }
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
      mutationAdmission?.restoreRecoveryClosed(
        failure.id,
        owner.admission_id.startsWith('wsbak_')
          ? { captureId: owner.admission_id }
          : {
              admissionId: owner.admission_id,
              revision: owner.revision,
              candidateRef: owner.candidate_ref,
            }
      );
    } else if (
      failure.check === 'recovery' &&
      owners.length === 0 &&
      captureOrigins.has(failure.id)
    ) {
      mutationAdmission?.restoreRecoveryClosed(failure.id, {
        captureId: captureOrigins.get(failure.id)!,
      });
    } else if (failure.check === 'recovery' && mutationAdmission?.isClosed(failure.id, 'capture')) {
    } else
      mutationAdmission?.restoreClosed(
        failure.id,
        failure.check === 'retired' ? 'ordinary' : 'capture'
      );
  }
}
