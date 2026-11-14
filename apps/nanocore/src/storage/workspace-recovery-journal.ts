import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { isEntityId, RequestIdSchema, UserIdSchema, WorkspaceIdSchema } from '@openkit/protocol';
import {
  assertCanonicalDirectory,
  publishDurableFile,
  type StorageContent,
  syncCanonicalDirectory,
  syncCanonicalDirectoryAsync,
  writeCanonicalFileAtomic,
} from '@openkit/storage';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { acquireDataRootLock, DataRootLockError } from '../bootstrap/lock.js';
import { scopeAdmissionFailures } from '../bootstrap/readiness.js';
import { localCoreJournalIntent } from '../runtime/core-journal-records.js';
import {
  CORE_WORKSPACE_RECOVERY_EXECUTION_DEFINITION,
  decodeExecutionJournalSpan,
  readExecutionJournalInvocation,
  readExecutionJournalRoot,
  settleExecutionJournalStep,
  writeExecutionJournalIntent,
} from '../runtime/execution-journal.js';
import type { ExecutionStepRef } from '../runtime/execution-step-journal.js';
import type {
  WorkspaceFreezeAdmission,
  WorkspaceFrozenAdmission,
  WorkspaceMutationAdmission,
  WorkspaceRecoveryFreezeOrigin,
} from '../workspace-mutation-admission.js';
import { reserveCanonicalFileWrite } from './canonical-write-capacity.js';
import { configureOwnedSqlite } from './control-store.js';
import { commandInputHash } from './control-store-input.js';
import {
  closeWorkspaceProductReadHandles,
  fileContentSchema,
} from './control-store-product-records.js';
import type {
  ControlRecoveryNativeBinding,
  ControlRecoveryNativeCall,
} from './control-store-worker-client.js';
import { type CoreDb, openExistingCoreDbWithIntegrityCheck, openWorkspaceReadDb } from './db.js';
import { coreDbPath } from './fs-layout.js';
import { readImmutableContentBytes } from './immutable-content-read.js';
import type { WorkspaceBackupCreateInput, WorkspaceBackupReport } from './workspace-backup.js';
import {
  parseWorkspaceBackupManifest,
  WORKSPACE_BACKUP_MAX_FILE_BYTES,
  type WorkspaceBackupManifest,
} from './workspace-backup-bundle.js';
import { inspectCapture } from './workspace-capture-protection.js';
import { ensureCanonicalDirectory, nativeProductScope } from './workspace-file-records.js';
import type {
  WorkspaceRecoveryCliArgs,
  WorkspaceRecoveryCliReport,
} from './workspace-recovery-cli.js';
import {
  WorkspaceRecoveryError,
  type WorkspaceRecoveryErrorCode,
} from './workspace-recovery-error.js';

/** Original recovery proof; current lifecycle authority belongs to the Core execution journal. */
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
/** A read projection: existing journal facts and original proof, never a parallel admission record. */
export interface RecoveryExecution {
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
  owned: RecoveryExecution,
  admission: WorkspaceMutationAdmission,
  readBlockers: Parameters<WorkspaceMutationAdmission['tryFreeze']>[1]
): WorkspaceFreezeAdmission {
  const current = readRecoveryExecution(core, owned.admission_id);
  const failures = scopeAdmissionFailures(core.dataRoot).filter(
    (failure) =>
      failure.scope === 'workspace' &&
      failure.id === owned.workspace_id &&
      failure.check !== 'index'
  );
  const unresolved = unresolvedRecoveryExecutions(core, owned.workspace_id);
  if (
    !current ||
    !isDeepStrictEqual(current, owned) ||
    !RequestIdSchema.safeParse(current.admission_id).success ||
    !['restore', 'move-in'].includes(current.proof.input.command) ||
    current.candidate_ref !==
      join(
        `${resolve(core.dataRoot)}.workspace-recovery-${current.admission_id}`,
        'workspaces',
        current.workspace_id
      ) ||
    (current.state === 'prepared' ||
    (current.state === 'abandoned' && current.proof.result.disposition === 'quarantined')
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
      revision: current.revision - (current.state === 'prepared' ? 0 : 1),
      candidateRef: current.candidate_ref,
    },
    readBlockers
  );
}

/** Reads a terminal target or abandoned restore whose original exclusion has no unfinished competitor. */
export function readWorkspaceRecoveryReadmission(
  core: CoreDb,
  id: string,
  admission: WorkspaceMutationAdmission,
  freeze: WorkspaceFrozenAdmission
): RecoveryExecution {
  const owned = readRecoveryExecution(core, id);
  if (
    !owned ||
    (owned.state !== 'finished' &&
      !(
        owned.state === 'abandoned' &&
        owned.proof.input.command === 'restore' &&
        owned.proof.result.disposition === 'abandoned'
      )) ||
    !RequestIdSchema.safeParse(id).success ||
    !['restore', 'move-in'].includes(owned.proof.input.command) ||
    unresolvedRecoveryExecutions(core, owned.workspace_id).length !== 0 ||
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
export function unresolvedRecoveryExecutions(
  core: CoreDb,
  workspaceId: string
): RecoveryExecution[] {
  return listRecoveryExecutions(core, workspaceId).filter(
    (row) =>
      row.state === 'prepared' ||
      (row.admission_id.startsWith('wsbak_') && row.state === 'finished') ||
      (row.state === 'abandoned' &&
        ['moved-out', 'quarantined'].includes(row.proof.result.disposition))
  );
}

/** Uses the existing Core selection for both predecessor discovery and exclusive recovery ownership. */
export function listRecoveryExecutions(
  core: CoreDb,
  workspaceId?: string,
  state?: 'prepared' | 'terminal'
): RecoveryExecution[] {
  const ids = core.sqlite
    .prepare(`SELECT DISTINCT json_extract(s.invocation_json,'$.carriage.requestId') AS id
    FROM control_executions e JOIN control_execution_steps s ON s.execution_id=e.id
    WHERE (e.definition_version GLOB 'core-workspace-recovery/*'
      OR json_extract(s.control_json,'$.definitionVersion') GLOB 'core-workspace-recovery/*')
    ${workspaceId === undefined ? '' : 'AND e.work_id=?'}`)
    .all(...(workspaceId === undefined ? [] : [workspaceId])) as { id: string }[];
  // Validate the complete owner census before applying a lifecycle predicate.
  return ids
    .map(({ id }) => readRecoveryExecution(core, id)!)
    .filter(
      (row) =>
        state === undefined ||
        (state === 'prepared' ? row.state === 'prepared' : row.state !== 'prepared')
    );
}

/** Selects the unique finished original recovery; this grants no serving or replacement authority. */
export function readFinishedDeletedWorkspaceRecovery(
  core: CoreDb,
  deletion: import('../workspace-deletion-request.js').WorkspaceDeletionRequestRecord
): RecoveryExecution | undefined {
  if (
    !['deleted', 'cleaned'].includes(deletion.phase) ||
    !deletion.recoveryBackupId ||
    !deletion.closureDigest
  )
    return undefined;
  const matches = listRecoveryExecutions(core, deletion.workspaceId).filter(
    (row) =>
      row.state === 'finished' &&
      row.proof.input.command === 'restore' &&
      !row.proof.input.acknowledgeLostSafety &&
      row.backup_id === deletion.recoveryBackupId &&
      row.proof.capture.manifestDigest === deletion.recoveryBackupManifestDigest &&
      row.proof.manifest.accounts.ownerId === deletion.originalOwnerUserId &&
      row.proof.result.disposition === 'restored' &&
      row.proof.result.currentRevision === deletion.expectedRegistryRevision + 3
  );
  return matches.length === 1 ? matches[0] : undefined;
}

/** Binds the exact prepared recovery's physical databases to its still-live mutation freeze. */
export function bindWorkspaceRecoveryNativeOwner(
  core: CoreDb,
  owned: RecoveryExecution,
  admission: WorkspaceMutationAdmission,
  freeze: WorkspaceFrozenAdmission
): {
  readonly canonical?: ControlRecoveryNativeCall;
  readonly candidate: ControlRecoveryNativeCall;
} {
  const current = readRecoveryExecution(core, owned.admission_id);
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
  assertCanonicalDirectory(privateDataRoot);
  assertCanonicalDirectory(join(privateDataRoot, 'workspaces'));
  const candidate = bindRecoveryDatabase(
    sourceDataRoot,
    privateDataRoot,
    current.workspace_id,
    current.candidate_ref
  );
  const root = join(sourceDataRoot, 'workspaces', current.workspace_id);
  const canonical = lstatSync(root, { throwIfNoEntry: false })
    ? bindRecoveryDatabase(sourceDataRoot, sourceDataRoot, current.workspace_id, root)
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
/** Binds only the placed terminal target for open/close before exact serving readmission. */
export function bindWorkspaceRecoveryReadmissionNativeOwner(
  core: CoreDb,
  owned: RecoveryExecution,
  admission: WorkspaceMutationAdmission,
  freeze: WorkspaceFrozenAdmission
): ControlRecoveryNativeCall {
  const current = readWorkspaceRecoveryReadmission(core, owned.admission_id, admission, freeze);
  if (current.state !== 'finished' || !isDeepStrictEqual(current, owned))
    refuseRecovery('recovery-required');
  const sourceDataRoot = resolve(core.dataRoot);
  const canonical = bindRecoveryDatabase(
    sourceDataRoot,
    sourceDataRoot,
    current.workspace_id,
    join(sourceDataRoot, 'workspaces', current.workspace_id)
  );
  admission.bindRecovery(current.workspace_id, freeze, { canonical });
  return Object.freeze({ freeze, binding: canonical });
}
/** Closes the final deletion source through the same exact physical recovery binding before rename. */
export function bindWorkspaceDeletionNativeOwner(
  core: CoreDb,
  deletion: import('../workspace-deletion-request.js').WorkspaceDeletionRequestRecord,
  admission: WorkspaceMutationAdmission,
  freeze: WorkspaceFrozenAdmission
): ControlRecoveryNativeCall {
  const registry = core.sqlite
    .prepare('SELECT status,revision,owner_user_id FROM workspace_registry WHERE workspace_id=?')
    .get(deletion.workspaceId) as
    | { status: string; revision: number; owner_user_id: string }
    | undefined;
  if (
    deletion.phase !== 'closure-sealed' ||
    !deletion.recoveryBackupId ||
    !deletion.closureDigest ||
    registry?.status !== 'deleting' ||
    registry.revision !== deletion.expectedRegistryRevision + 1 ||
    registry.owner_user_id !== deletion.originalOwnerUserId ||
    !admission.ownsFreeze(deletion.workspaceId, freeze)
  )
    refuseRecovery('recovery-required');
  const canonical = bindRecoveryDatabase(
    resolve(core.dataRoot),
    resolve(core.dataRoot),
    deletion.workspaceId,
    join(core.dataRoot, 'workspaces', deletion.workspaceId)
  );
  admission.bindRecovery(deletion.workspaceId, freeze, { canonical });
  return Object.freeze({ freeze, binding: canonical });
}
/** Binds an existing physical database without creating schema or bypassing native admission. */
function bindRecoveryDatabase(
  sourceDataRoot: string,
  dataRoot: string,
  workspaceId: string,
  root: string
): ControlRecoveryNativeBinding {
  assertCanonicalDirectory(root);
  const scope = nativeProductScope(dataRoot, { kind: 'workspace', workspaceId: workspaceId }, root);
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
}

/** Validates the selected source capture and any exact retained source-side Core proof. */
export function captureRecoveryOrigin(
  core: CoreDb,
  workspaceId: string,
  captureId: string
): WorkspaceRecoveryFreezeOrigin {
  if (
    !core.sqlite
      .prepare("SELECT 1 FROM workspace_registry WHERE workspace_id=? AND status='active'")
      .get(workspaceId)
  )
    refuseRecovery('recovery-required');
  if (
    scopeAdmissionFailures(core.dataRoot).some(
      (failure) =>
        failure.scope === 'workspace' &&
        failure.id === workspaceId &&
        !['index', 'recovery'].includes(failure.check)
    )
  )
    refuseRecovery('recovery-required');
  const db = openWorkspaceReadDb(core.dataRoot, workspaceId);
  try {
    if (!inspectCapture(db, workspaceId, captureId)) refuseRecovery('recovery-required');
    const active = db.sqlite
      .prepare("SELECT capture_id FROM workspace_capture_records WHERE state='active'")
      .all() as { capture_id: string }[];
    if (active.length > 1 || active.some((row) => row.capture_id !== captureId))
      refuseRecovery('recovery-required');
  } finally {
    db.sqlite.close();
  }
  const owned = readRecoveryExecution(core, captureId);
  if (unresolvedRecoveryExecutions(core, workspaceId).some((row) => row.admission_id !== captureId))
    refuseRecovery('recovery-required');
  if (!owned) return { captureId };
  if (
    owned.workspace_id !== workspaceId ||
    owned.backup_id !== captureId ||
    owned.purpose !== 'move' ||
    (owned.proof.input.command !== 'capture' && owned.proof.input.command !== 'move-out') ||
    owned.candidate_ref !== resolve(owned.proof.input.bundleRoot)
  )
    refuseRecovery('recovery-required');
  // Source terminal decisions advance Core revision but retain the same capture publication right.
  return { captureId };
}

/** Rejoins only a validated exact source capture, preserving quarantine and unrelated failures. */
export function resumeWorkspaceCaptureOwner(
  core: CoreDb,
  workspaceId: string,
  captureId: string,
  admission: WorkspaceMutationAdmission,
  readBlockers: Parameters<WorkspaceMutationAdmission['tryFreeze']>[1]
): WorkspaceFreezeAdmission {
  const origin = captureRecoveryOrigin(core, workspaceId, captureId);
  const failures = scopeAdmissionFailures(core.dataRoot).filter(
    (failure) =>
      failure.scope === 'workspace' && failure.id === workspaceId && failure.check !== 'index'
  );
  if (failures.length !== 1 || failures[0]!.check !== 'recovery')
    refuseRecovery('recovery-required');
  return admission.tryResumeRecovery(workspaceId, origin, readBlockers);
}

/** Selects only the canonical source under the exact capture's current lifecycle freeze. */
export function bindWorkspaceCaptureNativeOwner(
  core: CoreDb,
  workspaceId: string,
  captureId: string,
  admission: WorkspaceMutationAdmission,
  freeze: WorkspaceFrozenAdmission
): ControlRecoveryNativeCall {
  const origin = captureRecoveryOrigin(core, workspaceId, captureId);
  if (!admission.ownsRecoveryOrigin(workspaceId, freeze, origin))
    refuseRecovery('recovery-required');
  const binding = bindRecoveryDatabase(
    resolve(core.dataRoot),
    core.dataRoot,
    workspaceId,
    join(core.dataRoot, 'workspaces', workspaceId)
  );
  admission.bindRecovery(workspaceId, freeze, { canonical: binding });
  return Object.freeze({ freeze, binding });
}

/** Keeps original identities under the existing private recovery container, outside live discovery. */
export function workspaceRecoveryPredecessorRoot(owned: RecoveryExecution): string {
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
  for (const owned of listRecoveryExecutions(core)) {
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
const retainedPath = z.string().min(1);
const retainedRelease = z.object({ version: retainedPath, buildId: retainedPath }).optional();
const backupIdentity = z.string().refine((value) => isEntityId('wsbak', value));
const retainedRecoveryIntent = z.discriminatedUnion('command', [
  z.strictObject({
    command: z.literal('capture'),
    source: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('live-workspace') }),
      z.strictObject({ kind: z.literal('stopped-data-root'), dataRoot: retainedPath }),
      z.strictObject({ kind: z.literal('data-root-backup'), backupRoot: retainedPath }),
    ]),
    workspaceId: WorkspaceIdSchema,
    expectedSourceDeploymentId: z.string().refine((value) => isEntityId('dep', value)),
    bundleRoot: retainedPath,
    backupId: backupIdentity,
    purpose: z.literal('move'),
  }),
  z.strictObject({
    command: z.literal('move-out'),
    dataRoot: retainedPath,
    workspaceId: WorkspaceIdSchema,
    backupId: backupIdentity,
    bundleRoot: retainedPath,
    expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    expectedRelease: retainedRelease,
  }),
  z.strictObject({
    command: z.literal('restore'),
    dataRoot: retainedPath,
    bundleRoot: retainedPath,
    workspaceId: WorkspaceIdSchema,
    requestId: RequestIdSchema,
    acknowledgeLostSafety: z.boolean(),
    expectedRelease: retainedRelease,
  }),
  z.strictObject({
    command: z.literal('move-in'),
    dataRoot: retainedPath,
    bundleRoot: retainedPath,
    requestId: RequestIdSchema,
    targetOwnerId: UserIdSchema,
    memberMappings: z.array(
      z.strictObject({
        sourceAccountId: UserIdSchema,
        targetAccountId: UserIdSchema,
      })
    ),
    expectedRelease: retainedRelease,
  }),
]);

/** Validates original authority-bearing intent without treating current accounts as historical facts. */
export function validateRecoveryProof(id: string, candidate: string, proof: RecoveryProof) {
  const parsed = retainedRecoveryIntent.safeParse(proof.input);
  if (!parsed.success) refuseRecovery('recovery-required');
  const input = parsed.data;
  const manifest = parseWorkspaceBackupManifest(proof.manifest);
  const capture = proof.capture;
  if (
    !capture ||
    !proof.result ||
    !/^sha256:[0-9a-f]{64}$/.test(capture.manifestDigest) ||
    capture.backupId !== manifest.backupId ||
    capture.workspaceId !== manifest.workspaceId ||
    capture.sourceDeploymentId !== manifest.sourceDeploymentId ||
    capture.capturedRevision !== manifest.capturedRevision ||
    proof.result.workspaceId !== manifest.workspaceId ||
    !proof.result.capture ||
    (
      [
        'backupId',
        'workspaceId',
        'sourceDeploymentId',
        'capturedRevision',
        'manifestDigest',
      ] as const
    ).some((key) => proof.result.capture![key] !== capture[key]) ||
    (proof.candidateDigest !== undefined && !/^[0-9a-f]{64}$/.test(proof.candidateDigest))
  )
    refuseRecovery('recovery-required');
  if (input.command === 'capture' || input.command === 'move-out') {
    if (
      id !== manifest.backupId ||
      input.backupId !== id ||
      input.workspaceId !== manifest.workspaceId ||
      manifest.purpose !== 'move' ||
      (isAbsolute(input.bundleRoot) && resolve(input.bundleRoot) !== resolve(candidate)) ||
      (input.command === 'capture'
        ? input.expectedSourceDeploymentId !== manifest.sourceDeploymentId
        : input.expectedRevision !== manifest.capturedRevision)
    )
      refuseRecovery('recovery-required');
  } else {
    // These are original descriptor paths, not current-location authority after a data-root move.
    if (
      input.requestId !== id ||
      (isAbsolute(input.dataRoot) &&
        candidate !==
          join(
            `${resolve(input.dataRoot)}.workspace-recovery-${id}`,
            'workspaces',
            manifest.workspaceId
          )) ||
      (input.command === 'restore'
        ? input.workspaceId !== manifest.workspaceId || manifest.purpose !== 'backup'
        : manifest.purpose !== 'move')
    )
      refuseRecovery('recovery-required');
    if (input.command === 'move-in') {
      const sources = new Set<string>([manifest.accounts.ownerId, ...manifest.accounts.memberIds]);
      const mapped = new Set<string>();
      const targets = new Map<string, string>([[input.targetOwnerId, manifest.accounts.ownerId]]);
      for (const pair of input.memberMappings) {
        if (
          !sources.has(pair.sourceAccountId) ||
          mapped.has(pair.sourceAccountId) ||
          (targets.has(pair.targetAccountId) &&
            targets.get(pair.targetAccountId) !== pair.sourceAccountId)
        )
          refuseRecovery('recovery-required');
        mapped.add(pair.sourceAccountId);
        targets.set(pair.targetAccountId, pair.sourceAccountId);
      }
    }
  }
  return { ...proof, manifest };
}

/** Reads one addressed stage; journal sequence and original admission revision are distinct. */
function recoveryStage(core: CoreDb, id: string) {
  const row = core.sqlite
    .prepare(`SELECT s.execution_id, s.step_id, s.span_json
    FROM control_execution_steps s JOIN control_executions e ON e.id=s.execution_id
    WHERE (e.definition_version GLOB 'core-workspace-recovery/*'
      OR json_extract(s.control_json,'$.definitionVersion') GLOB 'core-workspace-recovery/*')
      AND json_extract(s.invocation_json,'$.carriage.requestId')=?
    ORDER BY json_extract(s.invocation_json,'$.carriage.sequence') DESC LIMIT 1`)
    .get(id) as { execution_id: string; step_id: string; span_json: string } | undefined;
  if (!row) return undefined;
  try {
    const ref = {
      execution: { owner: { kind: 'server' as const }, executionId: row.execution_id },
      stepId: row.step_id,
    };
    const invocation = readExecutionJournalInvocation(core, ref);
    const root = readExecutionJournalRoot(core, ref.execution);
    const encoded = invocation.control.inputRefs[0]!;
    const content = fileContentSchema.parse(JSON.parse(encoded));
    const { carriage, control } = invocation;
    const revision = Number(control.authorityRefs[1]);
    const candidate = carriage.bindingRef;
    if (!candidate) refuseRecovery('recovery-required');
    const { originalProof, proof } = readRecoveryProofContent(
      core.dataRoot,
      id,
      candidate,
      content
    );
    const state =
      root.phase === 'open'
        ? 'prepared'
        : root.terminalCause?.startsWith('abandoned:')
          ? 'abandoned'
          : 'finished';
    if (
      root.definitionVersion !== CORE_WORKSPACE_RECOVERY_EXECUTION_DEFINITION ||
      control.definitionVersion !== CORE_WORKSPACE_RECOVERY_EXECUTION_DEFINITION ||
      root.phase === 'closing' ||
      root.workId !== proof.manifest.workspaceId ||
      carriage.operation !== 'workspace.recovery' ||
      carriage.requestId !== id ||
      !carriage.sequence ||
      !Number.isSafeInteger(revision) ||
      revision < 1 ||
      content.mediaType !== 'application/json' ||
      control.fingerprint !==
        commandInputHash({ id, revision, candidate, proof: content.reference.contentDigest }) ||
      !isDeepStrictEqual(control.inputRefs, [encoded]) ||
      !isDeepStrictEqual(control.authorityRefs, [id, String(revision)]) ||
      !isDeepStrictEqual(control.outputRefs, invocation.state === 'intent' ? [] : [encoded]) ||
      root.terminalCause !==
        (state === 'abandoned' ? `abandoned:${proof.result.disposition}` : null) ||
      (invocation.state !== 'completed' &&
        !(invocation.state === 'intent' && control.kind === 'admit' && state === 'prepared'))
    )
      refuseRecovery('recovery-required');
    const snapshot: RecoveryExecution = {
      admission_id: id,
      backup_id: proof.manifest.backupId,
      workspace_id: proof.manifest.workspaceId,
      purpose: proof.manifest.purpose,
      state,
      revision,
      candidate_ref: candidate,
      proof,
    };
    return {
      snapshot,
      originalProof,
      ref,
      root,
      sequence: carriage.sequence,
      span: decodeExecutionJournalSpan(JSON.parse(row.span_json)),
    };
  } catch {
    return refuseRecovery('recovery-required');
  }
}

/** Reads original authority before current bundle, mapping or effect checks. */
export function readRecoveryExecution(core: CoreDb, id: string): RecoveryExecution | undefined {
  return recoveryStage(core, id)?.snapshot;
}

/** Gives retention its original required-feature declarations before the domain reader narrows them. */
export function readWorkspaceRecoveryProof(core: CoreDb, id: string): RecoveryProof | undefined {
  return recoveryStage(core, id)?.originalProof;
}

/** One Core content binding for async preparation and native decisions; an orphan grants no authority. */
function recoveryProofFile(
  dataRoot: string,
  proof: RecoveryProof,
  admission?: Pick<WorkspaceBackupCreateInput['admission'], 'reserve'>
) {
  const bytes = Buffer.from(JSON.stringify(proof));
  if (bytes.length > WORKSPACE_BACKUP_MAX_FILE_BYTES) refuseRecovery('invalid-bundle');
  const scope = nativeProductScope(dataRoot, { kind: 'server' });
  const digest = createHash('sha256').update(bytes).digest('hex');
  const path = join(scope.contentMount.root, 'sha256', digest);
  const content = fileContentSchema.parse({
    reference: {
      knowledgeBaseId: null,
      contentDigest: `sha256:${digest}`,
      availability: 'available',
      range: null,
      locator: {
        ownerScope: scope.owner,
        mount: scope.contentMount.mount,
        path: `sha256/${digest}`,
      },
    },
    byteLength: bytes.length,
    mediaType: 'application/json',
  });
  const reservation = reserveCanonicalFileWrite(bytes.length, {
    path,
    ...(admission ? { admission } : {}),
  })!;
  return { bytes, path, content, reservation };
}

/** Reads exact Core-owned proof bytes; parsing a descriptor alone grants no authority. */
export function readRecoveryProofContent(
  dataRoot: string,
  id: string,
  candidate: string,
  content: StorageContent
) {
  try {
    if (content.mediaType !== 'application/json') refuseRecovery('recovery-required');
    const scope = nativeProductScope(dataRoot, { kind: 'server' });
    const originalProof = JSON.parse(
      Buffer.from(
        readImmutableContentBytes(
          scope.contentMount,
          scope.owner,
          content,
          WORKSPACE_BACKUP_MAX_FILE_BYTES
        )
      ).toString('utf8')
    ) as RecoveryProof;
    return { originalProof, proof: validateRecoveryProof(id, candidate, originalProof) };
  } catch (error) {
    if (error instanceof WorkspaceRecoveryError) throw error;
    return refuseRecovery('recovery-required');
  }
}

/** Publishes proof before its journal reference inside the native/stopped Core decision. */
function recoveryContent(core: CoreDb, proof: RecoveryProof): string {
  const file = recoveryProofFile(core.dataRoot, proof);
  try {
    writeCanonicalFileAtomic(
      file.path,
      file.bytes,
      file.bytes.length,
      file.reservation,
      0o600,
      'create'
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    syncCanonicalDirectory(dirname(file.path));
  }
  const scope = nativeProductScope(core.dataRoot, { kind: 'server' });
  readImmutableContentBytes(
    scope.contentMount,
    scope.owner,
    file.content,
    WORKSPACE_BACKUP_MAX_FILE_BYTES
  );
  return JSON.stringify(file.content);
}

/** Advances only local recovery decisions. Ended originals stay immutable across later explicit reactivation. */
function recordRecoveryState(core: CoreDb, snapshot: RecoveryExecution): void {
  validateRecoveryProof(snapshot.admission_id, snapshot.candidate_ref, snapshot.proof);
  core.sqlite.transaction(() => {
    const prior = recoveryStage(core, snapshot.admission_id);
    if (prior && isDeepStrictEqual(prior.snapshot, snapshot)) return;
    if (
      (!prior && snapshot.state !== 'prepared') ||
      (prior?.root.phase === 'closed' && snapshot.state === 'prepared')
    )
      refuseRecovery('request-conflict');
    const sequence = (prior?.sequence ?? 0) + 1;
    const root = prior?.root.phase === 'open' ? prior.root : undefined;
    const encoded = recoveryContent(core, snapshot.proof);
    const intent = localCoreJournalIntent({
      definitionVersion: CORE_WORKSPACE_RECOVERY_EXECUTION_DEFINITION,
      executionId:
        root?.ref.executionId ?? `workspace-recovery:${snapshot.admission_id}:${sequence}`,
      stepId: `stage:${sequence}`,
      workId: snapshot.workspace_id,
      fingerprint: commandInputHash({
        id: snapshot.admission_id,
        revision: snapshot.revision,
        candidate: snapshot.candidate_ref,
        proof: fileContentSchema.parse(JSON.parse(encoded)).reference.contentDigest,
      }),
      kind: prior ? 'inspect-cleanup' : 'admit',
      actorId: 'workspace-recovery',
      inputRefs: [encoded],
      authorityRefs: [snapshot.admission_id, String(snapshot.revision)],
      carriage: {
        operation: 'workspace.recovery',
        requestId: snapshot.admission_id,
        sequence,
        bindingRef: snapshot.candidate_ref,
      },
      timestamp: new Date().toISOString(),
      ...(root ? { root } : {}),
      ...(prior ? { inspected: { ref: prior.ref, span: prior.span } } : {}),
    });
    writeExecutionJournalIntent(core, intent);
    if (!prior) return;
    const settle = (
      ref: ExecutionStepRef,
      state: 'completed' | 'cancelled',
      nextPhase: 'open' | 'closed',
      span = intent.span
    ) =>
      settleExecutionJournalStep(core, {
        ref,
        expectedExecutionRevision: readExecutionJournalRoot(core, ref.execution).revision,
        state,
        outputRefs: [encoded],
        span: { ...span, endTimeUnixNano: intent.span.startTimeUnixNano, status: { code: 'OK' } },
        nextPhase,
        terminalCause:
          snapshot.state === 'abandoned' ? `abandoned:${snapshot.proof.result.disposition}` : null,
        exclusionRefs: [],
      });
    settle(
      { execution: intent.execution.ref, stepId: intent.stepId },
      'completed',
      root ? 'open' : 'closed'
    );
    if (root && snapshot.state !== 'prepared') {
      const first = core.sqlite
        .prepare('SELECT span_json FROM control_execution_steps WHERE execution_id=? AND step_id=?')
        .get(root.ref.executionId, 'stage:1') as { span_json: string };
      settle(
        { execution: root.ref, stepId: 'stage:1' },
        snapshot.state === 'abandoned' ? 'cancelled' : 'completed',
        'closed',
        { ...decodeExecutionJournalSpan(JSON.parse(first.span_json)), endTimeUnixNano: null }
      );
    }
  })();
}

/** Creates exact ownership before placement under the existing root lock/native transaction. */
export function prepareRecoveryExecution(
  core: CoreDb,
  id: string,
  candidate: string,
  proof: RecoveryProof
): void {
  if (readRecoveryExecution(core, id)) refuseRecovery('request-conflict');
  recordRecoveryState(core, {
    admission_id: id,
    backup_id: proof.manifest.backupId,
    workspace_id: proof.manifest.workspaceId,
    purpose: proof.manifest.purpose,
    state: 'prepared',
    revision: 1,
    candidate_ref: candidate,
    proof,
  });
}

/** Retains the original first-terminal rule and its independent admission revision. */
export function finishRecoveryExecution(
  core: CoreDb,
  id: string,
  state: 'finished' | 'abandoned',
  result?: WorkspaceRecoveryCliReport
): void {
  const owned = readRecoveryExecution(core, id);
  if (!owned || (owned.state !== 'prepared' && owned.state !== state))
    refuseRecovery('request-conflict');
  recordRecoveryState(core, {
    ...owned,
    state,
    revision: owned.revision + (owned.state === state ? 0 : 1),
    proof: { ...owned.proof, ...(result ? { result } : {}) },
  });
}

/** Candidate proof advancement keeps its original admission revision. */
export function reviseRecoveryProof(
  core: CoreDb,
  owned: RecoveryExecution,
  proof: RecoveryProof
): void {
  recordRecoveryState(core, { ...owned, proof });
}

/** Every explicit source revocation advances the original domain revision, including a retry. */
export function revokeRecoveryExecution(core: CoreDb, owned: RecoveryExecution): void {
  recordRecoveryState(core, { ...owned, state: 'abandoned', revision: owned.revision + 1 });
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

/** Async preparation uses the same immutable Core content as its journal, without a temporary-file codec. */
export async function publishRecoveryProof(
  dataRoot: string,
  proof: RecoveryProof,
  admission: Pick<WorkspaceBackupCreateInput['admission'], 'reserve'>
): Promise<StorageContent> {
  const parsed = retainedRecoveryIntent.safeParse(proof.input);
  if (!parsed.success) refuseRecovery('recovery-required');
  const input = parsed.data;
  const source = input.command === 'capture' || input.command === 'move-out';
  const id = source ? proof.manifest.backupId : input.requestId;
  const candidate = source
    ? join(resolve(dataRoot), 'server/backups/workspaces', proof.manifest.workspaceId, id)
    : join(
        `${resolve(dataRoot)}.workspace-recovery-${id}`,
        'workspaces',
        proof.manifest.workspaceId
      );
  validateRecoveryProof(id, candidate, proof);
  ensureCanonicalDirectory(source ? dirname(candidate) : dirname(dirname(candidate)));
  const file = recoveryProofFile(dataRoot, proof, admission);
  try {
    ensureCanonicalDirectory(dirname(file.path));
    file.reservation.assertAvailable();
    try {
      const written = await publishDurableFile({
        destinationPath: file.path,
        bytes: file.bytes,
        mode: 0o600,
      });
      file.reservation.recordWritten(written.bytes);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const scope = nativeProductScope(dataRoot, { kind: 'server' });
      readImmutableContentBytes(
        scope.contentMount,
        scope.owner,
        file.content,
        WORKSPACE_BACKUP_MAX_FILE_BYTES
      );
      await syncCanonicalDirectoryAsync(dirname(file.path));
    }
    return file.content;
  } finally {
    file.reservation.release();
  }
}
