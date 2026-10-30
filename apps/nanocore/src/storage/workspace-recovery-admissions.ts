import { randomUUID } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { RequestIdSchema } from '@openkit/protocol';
import Database from 'better-sqlite3';
import { acquireDataRootLock, DataRootLockError } from '../bootstrap/lock.js';
import { scopeAdmissionFailures } from '../bootstrap/readiness.js';
import type {
  WorkspaceFreezeAdmission,
  WorkspaceFrozenAdmission,
  WorkspaceMutationAdmission,
} from '../workspace-mutation-admission.js';
import { configureOwnedSqlite } from './control-store.js';
import { closeWorkspaceProductReadHandles } from './control-store-products.js';
import type {
  ControlRecoveryNativeBinding,
  ControlRecoveryNativeCall,
} from './control-store-worker-client.js';
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
import { assertCanonicalDirectory, nativeProductScope } from './workspace-file-records.js';
import type {
  WorkspaceRecoveryCliArgs,
  WorkspaceRecoveryCliReport,
} from './workspace-recovery-cli.js';

/** Closed proof retained by the offline admission owner, not the command receipt ledger. */
export interface RecoveryProof {
  readonly input:
    | WorkspaceRecoveryCliArgs
    | (Omit<Extract<WorkspaceRecoveryCliArgs, { command: 'capture' }>, 'source'> & {
        readonly source:
          | Extract<WorkspaceRecoveryCliArgs, { command: 'capture' }>['source']
          | { readonly kind: 'live-workspace' };
      });
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

/** Rejoins the exact boot-restored exclusion without clearing scoped authority failure. */
export function resumeWorkspaceRecoveryOwner(
  core: CoreDb,
  owned: RecoveryAdmission,
  admission: WorkspaceMutationAdmission,
  readBlockers: Parameters<WorkspaceMutationAdmission['tryFreeze']>[1]
): WorkspaceFreezeAdmission {
  const current = readRecoveryAdmission(core, owned.admission_id);
  const failures = scopeAdmissionFailures(core.dataRoot).filter(
    (failure) =>
      failure.scope === 'workspace' &&
      failure.id === owned.workspace_id &&
      failure.check !== 'index'
  );
  const unresolved = unresolvedRecoveryAdmissions(core, owned.workspace_id);
  if (
    !current ||
    !isDeepStrictEqual(current, owned) ||
    !['prepared', 'finished'].includes(current.state) ||
    !RequestIdSchema.safeParse(current.admission_id).success ||
    !['restore', 'move-in'].includes(current.proof.input.command) ||
    current.candidate_ref !==
      join(
        `${resolve(core.dataRoot)}.workspace-recovery-${current.admission_id}`,
        'workspaces',
        current.workspace_id
      ) ||
    (current.state === 'prepared'
      ? unresolved.length !== 1 || unresolved[0]!.admission_id !== current.admission_id
      : unresolved.length !== 0) ||
    failures.length !== 1 ||
    failures[0]!.check !== 'recovery'
  )
    refuseRecovery('recovery-required');
  return admission.tryResumeRecovery(
    current.workspace_id,
    {
      admissionId: current.admission_id,
      revision: current.revision - (current.state === 'finished' ? 1 : 0),
      candidateRef: current.candidate_ref,
    },
    readBlockers
  );
}

/** Reads only a finished target whose original exclusion has no competing unfinished owner. */
export function readWorkspaceRecoveryReadmission(
  core: CoreDb,
  id: string,
  admission: WorkspaceMutationAdmission,
  freeze: WorkspaceFrozenAdmission
): RecoveryAdmission {
  const owned = readRecoveryAdmission(core, id);
  if (
    !owned ||
    owned.state !== 'finished' ||
    !RequestIdSchema.safeParse(id).success ||
    !['restore', 'move-in'].includes(owned.proof.input.command) ||
    unresolvedRecoveryAdmissions(core, owned.workspace_id).length !== 0 ||
    !admission.ownsRecoveryOrigin(owned.workspace_id, freeze, {
      admissionId: owned.admission_id,
      revision: owned.revision - 1,
      candidateRef: owned.candidate_ref,
    })
  )
    refuseRecovery('recovery-required');
  return owned;
}

/** The same unresolved-owner predicate binds boot rejoin and terminal serving readmission. */
function unresolvedRecoveryAdmissions(core: CoreDb, workspaceId: string): RecoveryAdmission[] {
  return recoveryAdmissions(core, workspaceId).filter(
    (row) =>
      row.state === 'prepared' ||
      (row.admission_id.startsWith('wsbak_') && row.state === 'finished') ||
      (row.state === 'abandoned' &&
        ['moved-out', 'quarantined'].includes(row.proof.result.disposition))
  );
}

/** Uses the existing Core selection for both predecessor discovery and exclusive recovery ownership. */
function recoveryAdmissions(core: CoreDb, workspaceId?: string): RecoveryAdmission[] {
  const ids = core.sqlite
    .prepare(
      'SELECT admission_id FROM workspace_recovery_admissions WHERE (? IS NULL OR workspace_id=?)'
    )
    .all(workspaceId ?? null, workspaceId ?? null) as { admission_id: string }[];
  return ids.map(({ admission_id }) => readRecoveryAdmission(core, admission_id)!);
}

/** Binds the exact prepared recovery's physical databases to its still-live mutation freeze. */
export function bindWorkspaceRecoveryNativeOwner(
  core: CoreDb,
  owned: RecoveryAdmission,
  admission: WorkspaceMutationAdmission,
  freeze: WorkspaceFrozenAdmission
): {
  readonly canonical?: ControlRecoveryNativeCall;
  readonly candidate: ControlRecoveryNativeCall;
} {
  const current = readRecoveryAdmission(core, owned.admission_id);
  const sourceDataRoot = resolve(core.dataRoot);
  const privateDataRoot = `${sourceDataRoot}.workspace-recovery-${owned.admission_id}`;
  if (
    !current ||
    current.state !== 'prepared' ||
    current.revision !== owned.revision ||
    current.workspace_id !== owned.workspace_id ||
    current.candidate_ref !== owned.candidate_ref ||
    !isDeepStrictEqual(current.proof.input, owned.proof.input) ||
    !RequestIdSchema.safeParse(owned.admission_id).success ||
    !['restore', 'move-in'].includes(current.proof.input.command) ||
    current.candidate_ref !== join(privateDataRoot, 'workspaces', current.workspace_id) ||
    !admission.ownsFreeze(current.workspace_id, freeze)
  )
    refuseRecovery('recovery-required');
  const bind = (dataRoot: string, root: string): ControlRecoveryNativeBinding => {
    assertCanonicalDirectory(root);
    const scope = nativeProductScope(
      dataRoot,
      { kind: 'workspace', workspaceId: current.workspace_id },
      root
    );
    const stat = lstatSync(scope.path, { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.isSymbolicLink() || stat.size === 0)
      refuseRecovery('recovery-required');
    const command = Object.freeze({
      database: `workspace:${scope.path}`,
      path: scope.path,
      dataRoot,
      productOwner: Object.freeze(scope.owner),
      contentMount: Object.freeze(scope.contentMount),
      create: false as const,
      initialize: 'workspace' as const,
    });
    return Object.freeze({
      command,
      path: realpathSync(scope.path),
      identity: `${stat.dev}:${stat.ino}`,
      sourceDataRoot,
    });
  };
  assertCanonicalDirectory(privateDataRoot);
  assertCanonicalDirectory(join(privateDataRoot, 'workspaces'));
  const candidate = bind(privateDataRoot, current.candidate_ref);
  const root = join(sourceDataRoot, 'workspaces', current.workspace_id);
  const canonical = lstatSync(root, { throwIfNoEntry: false })
    ? bind(sourceDataRoot, root)
    : undefined;
  admission.bindRecovery(current.workspace_id, freeze, {
    ...(canonical ? { canonical } : {}),
    candidate,
  });
  return Object.freeze({
    ...(canonical ? { canonical: Object.freeze({ freeze, binding: canonical }) } : {}),
    candidate: Object.freeze({ freeze, binding: candidate }),
  });
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
  for (const owned of recoveryAdmissions(core)) {
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
