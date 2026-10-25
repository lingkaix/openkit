import { randomUUID } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { RequestIdSchema } from '@openkit/protocol';
import Database from 'better-sqlite3';
import { acquireDataRootLock, DataRootLockError } from '../bootstrap/lock.js';
import { configureOwnedSqlite } from './control-store.js';
import { closeWorkspaceProductReadHandles } from './control-store-products.js';
import { type CoreDb, openExistingCoreDbWithIntegrityCheck } from './db.js';
import { coreDbPath } from './fs-layout.js';
import {
  type WorkspaceBackupReport,
  WorkspaceRecoveryError,
  type WorkspaceRecoveryErrorCode,
} from './workspace-backup.js';
import {
  parseWorkspaceBackupManifest,
  type WorkspaceBackupManifest,
} from './workspace-backup-bundle.js';
import { assertCanonicalDirectory } from './workspace-file-records.js';
import type {
  WorkspaceRecoveryCliArgs,
  WorkspaceRecoveryCliReport,
} from './workspace-recovery-cli.js';

/** Closed proof retained by the offline admission owner, not the command receipt ledger. */
export interface RecoveryProof {
  readonly input: WorkspaceRecoveryCliArgs;
  readonly manifest: WorkspaceBackupManifest;
  readonly capture: WorkspaceBackupReport;
  result: WorkspaceRecoveryCliReport;
  readonly candidateDigest?: string;
}
/** One native request whose proof and candidate survive registration rollback. */
export interface RecoveryAdmission {
  readonly admission_id: string;
  readonly backup_id: string;
  readonly workspace_id: string;
  readonly purpose: 'backup' | 'move';
  readonly state: 'prepared' | 'finished' | 'abandoned';
  readonly revision: number;
  readonly candidate_ref: string;
  readonly proof: RecoveryProof;
}
/** Keeps original identities under the existing private recovery container, outside live discovery. */
export function workspaceRecoveryPredecessorRoot(owned: RecoveryAdmission): string {
  return join(
    dirname(dirname(owned.candidate_ref)),
    'predecessor',
    'workspaces',
    owned.workspace_id
  );
}

/** Selects preserved predecessor history only through retained recovery ownership, never directory discovery. */
export function listWorkspaceRecoveryPredecessors(
  core: CoreDb
): readonly { dataRoot: string; workspaceId: string }[] {
  const predecessors: { dataRoot: string; workspaceId: string }[] = [];
  const ids = core.sqlite
    .prepare('SELECT admission_id FROM workspace_recovery_admissions')
    .all() as { admission_id: string }[];
  for (const { admission_id: id } of ids) {
    const owned = readRecoveryAdmission(core, id)!;
    if (owned.proof.input.command !== 'restore') continue;
    if (!RequestIdSchema.safeParse(owned.admission_id).success) refuseRecovery('recovery-required');
    const container = `${resolve(core.dataRoot)}.workspace-recovery-${owned.admission_id}`;
    if (owned.candidate_ref !== join(container, 'workspaces', owned.workspace_id))
      refuseRecovery('recovery-required');
    const root = workspaceRecoveryPredecessorRoot(owned);
    let present = true;
    for (const path of [container, dirname(dirname(root)), dirname(root), root]) {
      if (!lstatSync(path, { throwIfNoEntry: false })) {
        present = false;
        break;
      }
      assertCanonicalDirectory(path);
    }
    if (present)
      predecessors.push({ dataRoot: dirname(dirname(root)), workspaceId: owned.workspace_id });
  }
  return predecessors;
}
/** Produces a bounded refusal without storage paths or packaged text. */
export function refuseRecovery(code: WorkspaceRecoveryErrorCode): never {
  throw new WorkspaceRecoveryError(code, `Workspace recovery refused: ${code}.`);
}
/** Existing-only writable open with the same connection-local durability owner as boot. */
export function openRecoveryDatabase(path: string): Database.Database {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.size === 0) refuseRecovery('workspace-unavailable');
  const db = new Database(path, { fileMustExist: true });
  try {
    configureOwnedSqlite(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
/** Holds the existing root lock throughout one explicit offline decision; never composes a server. */
export async function withRecoveryRoot<T>(
  dataRoot: string,
  body: (core: CoreDb) => Promise<T>
): Promise<T> {
  let lock: ReturnType<typeof acquireDataRootLock> | undefined;
  let core: CoreDb | undefined;
  try {
    lock = acquireDataRootLock(dataRoot, { bootId: randomUUID() });
    // Restore and MOVE replace live paths only after excluding the live server.
    closeWorkspaceProductReadHandles(dataRoot);
    const stat = lstatSync(coreDbPath(dataRoot), { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.size === 0) refuseRecovery('source-unavailable');
    core = openExistingCoreDbWithIntegrityCheck(dataRoot);
    return await body(core);
  } catch (error) {
    if (error instanceof WorkspaceRecoveryError) throw error;
    if (error instanceof DataRootLockError) refuseRecovery('root-locked');
    return refuseRecovery('recovery-required');
  } finally {
    if (lock) closeWorkspaceProductReadHandles(dataRoot);
    core?.sqlite.close();
    lock?.release();
  }
}
/** Reads the retained core before any bundle or mapping revalidation. */
export function readRecoveryAdmission(core: CoreDb, id: string): RecoveryAdmission | undefined {
  const row = core.sqlite
    .prepare('SELECT * FROM workspace_recovery_admissions WHERE admission_id=?')
    .get(id) as
    | (Omit<RecoveryAdmission, 'proof'> & { proof_json: string; schema_version: number })
    | undefined;
  if (!row) return undefined;
  const proof = JSON.parse(row.proof_json) as RecoveryProof;
  const manifest = parseWorkspaceBackupManifest(proof.manifest);
  if (
    row.schema_version !== 1 ||
    !['prepared', 'finished', 'abandoned'].includes(row.state) ||
    row.revision < 1 ||
    manifest.backupId !== row.backup_id ||
    manifest.workspaceId !== row.workspace_id ||
    proof.capture.manifestDigest !== proof.result.capture?.manifestDigest
  )
    refuseRecovery('recovery-required');
  return { ...row, proof: { ...proof, manifest } };
}
/** Creates ownership before placement; the enclosing caller holds the root lock. */
export function prepareRecoveryAdmission(
  core: CoreDb,
  id: string,
  candidate: string,
  proof: RecoveryProof
): void {
  const now = new Date().toISOString();
  core.sqlite
    .prepare(
      `INSERT INTO workspace_recovery_admissions (admission_id, backup_id, workspace_id, purpose, state, revision, created_at, updated_at, candidate_ref, proof_json) VALUES (?,?,?,?,'prepared',1,?,?,?,?)`
    )
    .run(
      id,
      proof.manifest.backupId,
      proof.manifest.workspaceId,
      proof.manifest.purpose,
      now,
      now,
      candidate,
      JSON.stringify(proof)
    );
}
/** The first terminal decision wins; this update can share registration's Core transaction. */
export function endRecoveryAdmission(
  core: CoreDb,
  id: string,
  state: 'finished' | 'abandoned',
  result?: WorkspaceRecoveryCliReport
): void {
  const row = readRecoveryAdmission(core, id);
  if (!row || (row.state !== 'prepared' && row.state !== state)) refuseRecovery('request-conflict');
  if (result)
    core.sqlite
      .prepare('UPDATE workspace_recovery_admissions SET proof_json=? WHERE admission_id=?')
      .run(JSON.stringify({ ...row.proof, result }), id);
  if (row.state !== state)
    core.sqlite
      .prepare(
        "UPDATE workspace_recovery_admissions SET state=?, revision=revision+1, updated_at=? WHERE admission_id=? AND state='prepared'"
      )
      .run(state, new Date().toISOString(), id);
}

/** Constructs the common path-free report without introducing another retained result shape. */
export function recoveryReport(
  command: WorkspaceRecoveryCliArgs['command'],
  disposition: WorkspaceRecoveryCliReport['disposition'],
  capture: WorkspaceBackupReport
): WorkspaceRecoveryCliReport {
  return {
    command,
    disposition,
    workspaceId: capture.workspaceId,
    capture,
    droppedSourceMemberIds: [],
    restrictedRecovery: false,
    nextAction: disposition === 'prepared' ? 'finish' : 'none',
  };
}
