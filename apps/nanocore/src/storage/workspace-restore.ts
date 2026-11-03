import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  type WORKSPACE_SNAPSHOT_OPERATION_DEFINITIONS,
  WorkspaceSnapshotReportSchema,
} from '@openkit/app-api-schemas';
import { compareCodeUnits } from '@openkit/protocol';
import { publishDurableFile, removeDurableFile } from '@openkit/storage';
import type { Actor } from '../auth/identity.js';
import {
  isScopeAdmitted,
  refuseScope,
  scopeAdmissionFailures,
  settleWorkspaceRecoveryScope,
} from '../bootstrap/readiness.js';
import type { RuntimeConfigManager } from '../config/runtime-config.js';
import type { FsStore } from '../lib/store.js';
import type { OperationInvocationDependencies } from '../operation-composition.js';
import type { AdmittedOperationContext } from '../operation-contract.js';
import { publicOperationActor } from '../operation-contract.js';
import { OperationError } from '../operation-error.js';
import type { WorkspaceDeletionRequestRecord } from '../workspace-deletion-request.js';
import type {
  WorkspaceFrozenAdmission,
  WorkspaceMutationAdmission,
} from '../workspace-mutation-admission.js';
import { getWorkspaceRegistryLifecycleFact } from '../workspace-sharing.js';
import { FileStorageAdmission } from './artifacts/file-admission.js';
import { commandInputHash } from './control-store-input.js';
import {
  ControlStoreWorkerError,
  getControlStoreWorkerClient,
} from './control-store-worker-client.js';
import { workspaceRecoveryCandidateDigest as candidateDigest } from './data-root-backup.js';
import type { CoreDb } from './db.js';
import { readDataRootLayoutMarker } from './fs-layout.js';
import { RECURRING_PORTABLE_PATHS } from './recurring-portable-history.js';
import {
  inspectWorkspaceSnapshot,
  invokeWorkspaceRecoveryOperation,
  readBlockers,
  readWorkspaceBackupManifest,
  readWorkspaceRecoveryBlockers,
  stageWorkspaceBackup,
  WORKSPACE_BACKUP_POLICY,
  type WorkspaceBackupStageInput,
  WorkspaceRecoveryError,
  type WorkspaceRecoveryErrorCode,
  workspaceSnapshotOperationPolicy,
} from './workspace-backup.js';
import {
  WORKSPACE_BACKUP_MANIFEST_FILE,
  WORKSPACE_BACKUP_MAX_FILE_BYTES,
  WorkspaceBackupBundleError,
  type WorkspaceBackupManifest,
} from './workspace-backup-bundle.js';
import {
  assertCanonicalDirectory,
  ensureCanonicalDirectory,
  nativeProductScope,
  syncCanonicalDirectory,
} from './workspace-file-records.js';
import {
  abandonWorkspaceCaptureAtCore,
  finishWorkspaceCaptureAtCore,
  inspectWorkspaceRecoveryAtCore,
  readWorkspaceCaptureRecoveryAtCore,
  selectRecoveryAdmission,
  type WorkspaceRecoveryDependencies,
  type WorkspaceRecoverySelectedInput,
} from './workspace-move.js';
import {
  bindWorkspaceRecoveryNativeOwner,
  openRecoveryDatabase,
  type RecoveryAdmission,
  type RecoveryProof,
  readRecoveryAdmission,
  readWorkspaceRecoveryReadmission,
  recoveryReport,
  refuseRecovery,
  resumeWorkspaceCaptureOwner,
  resumeWorkspaceRecoveryOwner,
  withRecoveryRoot,
  workspaceRecoveryPredecessorRoot,
} from './workspace-recovery-admissions.js';
import type {
  WorkspaceRecoveryCliArgs,
  WorkspaceRecoveryCliReport,
} from './workspace-recovery-cli.js';
import type {
  ControlRecoveryTargetPreparationInput,
  ControlRecoveryTargetRegistrationInput,
} from './workspace-recovery-target-codecs.js';
import { validateRecoveryTargetMapping as mapping } from './workspace-recovery-target-native.js';

type TargetArgs = Extract<WorkspaceRecoveryCliArgs, { command: 'restore' | 'move-in' }>;
export type WorkspaceTargetRecoveryInput = TargetArgs & {
  readonly expectedRelease: WorkspaceBackupManifest['release'];
  readonly snapshotSource?: WorkspaceBackupStageInput['snapshotSource'];
};

/** Existing Core, physical admission and optional live freeze owned by the invoking lifecycle. */
interface TargetRecoveryOwner {
  readonly core: CoreDb;
  readonly fileAdmission: FileStorageAdmission;
  readonly currentAuthority?: () => void;
  /** Actual authenticated actor for a live native Core effect; stopped wrappers retain the root lock. */
  readonly actor?: Actor;
  /** Exact final-cut proof, revalidated by the deletion owner at each awaited boundary. */
  readonly deletedRecovery?: {
    readonly deletion: WorkspaceDeletionRequestRecord;
    readonly actorId: string;
  };
  readonly native?: {
    readonly gate: WorkspaceMutationAdmission;
    readonly freeze: WorkspaceFrozenAdmission;
  };
}

/** Existing target lifecycle facts; selected decisions may use the stopped file policy. */
type TargetCoreOwner = Pick<
  TargetRecoveryOwner,
  'core' | 'native' | 'currentAuthority' | 'deletedRecovery' | 'actor'
> &
  Partial<Pick<TargetRecoveryOwner, 'fileAdmission'>>;

/** A live entry always supplies its current freeze; only offline root-lock wrappers omit it. */
export interface WorkspaceRecoveryTargetOwner extends TargetRecoveryOwner {
  readonly native: NonNullable<TargetRecoveryOwner['native']>;
  readonly actor: Actor;
}

/** Binds all target effects to the supplied Core and, online, the same live target freeze. */
function assertTargetRecoveryOwner(
  owner: TargetCoreOwner,
  dataRoot: string,
  workspaceId?: string
): void {
  if (
    resolve(owner.core.dataRoot) !== resolve(dataRoot) ||
    (owner.native &&
      workspaceId !== undefined &&
      !owner.native.gate.ownsFreeze(workspaceId, owner.native.freeze))
  )
    refuseRecovery('recovery-required');
  owner.currentAuthority?.();
}

/** Request identity excludes the movable bundle pathname and orders only the explicit account map. */
function requestIdentity(input: TargetArgs) {
  return input.command === 'restore'
    ? [input.command, input.workspaceId, input.acknowledgeLostSafety]
    : [
        input.command,
        input.targetOwnerId,
        [...input.memberMappings].sort(
          (a, b) =>
            compareCodeUnits(a.sourceAccountId, b.sourceAccountId) ||
            compareCodeUnits(a.targetAccountId, b.targetAccountId)
        ),
      ];
}
/** Publishes a proved candidate before one Core registration/result transaction; failure retains ownership. */
async function finishTarget(
  owner: TargetCoreOwner,
  owned: RecoveryAdmission,
  deps: WorkspaceRecoveryDependencies,
  expectedRelease?: WorkspaceBackupManifest['release']
): Promise<WorkspaceRecoveryCliReport> {
  const core = owner.core;
  assertTargetRecoveryOwner(owner, core.dataRoot, owned.workspace_id);
  const input = owned.proof.input as TargetArgs;
  if (
    getWorkspaceRegistryLifecycleFact(core, owned.workspace_id)?.status === 'deleted' &&
    !owner.deletedRecovery
  )
    refuseRecovery('recovery-required');
  if (!['restore', 'move-in'].includes(input.command)) refuseRecovery('request-conflict');
  if (owned.state === 'abandoned') refuseRecovery('request-conflict');
  if (owned.state === 'finished') return owned.proof.result;
  if (expectedRelease && !isDeepStrictEqual(expectedRelease, owned.proof.manifest.release))
    refuseRecovery('release-mismatch');
  mapping(core, input, owned.proof.manifest, owned.proof.capture.manifestDigest);
  const workspaceId = owned.workspace_id;
  const final = join(core.dataRoot, 'workspaces', workspaceId);
  const predecessor = workspaceRecoveryPredecessorRoot(owned);
  const candidate = existsSync(owned.candidate_ref) ? owned.candidate_ref : final;
  if (!owned.proof.candidateDigest || candidateDigest(candidate) !== owned.proof.candidateDigest)
    refuseRecovery('recovery-required');
  const db = openRecoveryDatabase(join(candidate, 'db/workspace.sqlite'));
  try {
    if (db.pragma('integrity_check', { simple: true }) !== 'ok') refuseRecovery('invalid-database');
  } finally {
    db.close();
  }
  if (candidate !== final) {
    deps.atBoundary?.('before-target-rename');
    assertTargetRecoveryOwner(owner, core.dataRoot, workspaceId);
    if (owner.native)
      refuseScope(core.dataRoot, { scope: 'workspace', id: workspaceId, check: 'recovery' });
    if (input.command === 'restore' && existsSync(final)) {
      if (existsSync(predecessor)) refuseRecovery('recovery-required');
      assertCanonicalDirectory(dirname(dirname(owned.candidate_ref)));
      ensureCanonicalDirectory(dirname(dirname(predecessor)));
      ensureCanonicalDirectory(dirname(predecessor));
      renameSync(final, predecessor);
      syncCanonicalDirectory(dirname(predecessor));
    } else if (existsSync(final)) refuseRecovery('identity-collision');
    mkdirSync(dirname(final), { recursive: true, mode: 0o700 });
    renameSync(candidate, final);
    syncCanonicalDirectory(dirname(final));
    syncCanonicalDirectory(dirname(owned.candidate_ref));
    deps.atBoundary?.('after-target-rename');
  }
  assertTargetRecoveryOwner(owner, core.dataRoot, workspaceId);
  if (owner.native)
    refuseScope(core.dataRoot, { scope: 'workspace', id: workspaceId, check: 'recovery' });
  return withTargetCore(owner, workspaceId, async (client, database) => {
    const report = await client.recoveryTargetRegistration(
      database,
      {
        ...targetCoreAuthority(owner, owned.admission_id, workspaceId),
        expectedRevision: owned.revision,
        proofHash: commandInputHash(owned.proof),
      },
      owner.native?.freeze
    );
    deps.atBoundary?.('after-registration-commit');
    return report;
  });
}

/** Keeps every stopped native Core effect joined or terminated before the original root lock releases. */
async function withTargetCore<T>(
  owner: TargetCoreOwner,
  workspaceId: string,
  body: (client: ReturnType<typeof getControlStoreWorkerClient>, database: string) => Promise<T>
): Promise<T> {
  const client = getControlStoreWorkerClient(owner.native?.gate);
  const core = owner.core;
  const dataRoot = resolve(core.dataRoot);
  const scope = nativeProductScope(dataRoot, { kind: 'server' });
  const path = scope.path;
  const database = `core:${path}`;
  let result: { ok: true; report: T } | { ok: false; error: unknown };
  try {
    await client.open({
      database,
      path,
      create: false,
      initialize: 'core',
      dataRoot,
      productOwner: scope.owner,
      contentMount: scope.contentMount,
    });
    assertTargetRecoveryOwner(owner, core.dataRoot, workspaceId);
    if (owner.native && !owner.actor) refuseRecovery('recovery-required');
    const value = await body(client, database);
    result = { ok: true, report: value };
  } catch (error) {
    if (
      error instanceof ControlStoreWorkerError &&
      (error.domain?.operation === 'recovery-target-registration' ||
        error.domain?.operation === 'recovery-target-preparation')
    ) {
      const { code, message, status } = error.domain;
      result = {
        ok: false,
        error:
          status === 409
            ? new WorkspaceRecoveryError(code as WorkspaceRecoveryErrorCode, message)
            : new OperationError(code, message, status),
      };
    } else result = { ok: false, error };
  }
  if (!owner.native) {
    try {
      await client.close(database);
    } catch (error) {
      if (result.ok) result = { ok: false, error };
    }
  }
  if (!result.ok) throw result.error;
  return result.report;
}

/** Projects only the actual current caller and original deleted-recovery SQL facts. */
function targetCoreAuthority(
  owner: TargetCoreOwner,
  admissionId: string,
  workspaceId: string
): Pick<
  ControlRecoveryTargetRegistrationInput,
  'admissionId' | 'workspaceId' | 'authority' | 'deletedRecovery'
> {
  if (owner.native && !owner.actor) refuseRecovery('recovery-required');
  return {
    admissionId,
    workspaceId,
    authority: owner.native ? { mode: 'live', actor: owner.actor! } : { mode: 'stopped' },
    ...(owner.deletedRecovery
      ? {
          deletedRecovery: {
            actorId: owner.deletedRecovery.actorId,
            deletion: {
              workspaceId: owner.deletedRecovery.deletion.workspaceId,
              recoveryBackupId: owner.deletedRecovery.deletion.recoveryBackupId,
              recoveryBackupManifestDigest:
                owner.deletedRecovery.deletion.recoveryBackupManifestDigest,
              originalOwnerUserId: owner.deletedRecovery.deletion.originalOwnerUserId,
              expectedRegistryRevision: owner.deletedRecovery.deletion.expectedRegistryRevision,
            },
          },
        }
      : {}),
  };
}

type TargetProofStage =
  | Omit<Extract<ControlRecoveryTargetPreparationInput, { kind: 'prepare' }>, 'file'>
  | Omit<Extract<ControlRecoveryTargetPreparationInput, { kind: 'proof' }>, 'file'>
  | Omit<Extract<ControlRecoveryTargetPreparationInput, { kind: 'abandon-result' }>, 'file'>;

/** The original restore owner publishes and retires one exact request-local proof, never a retained descriptor. */
async function publishTargetProofStage(
  owner: TargetCoreOwner,
  input: TargetProofStage,
  proof: RecoveryProof
): Promise<void> {
  assertTargetRecoveryOwner(owner, owner.core.dataRoot, input.workspaceId);
  const root = `${resolve(owner.core.dataRoot)}.workspace-recovery-${input.admissionId}`;
  ensureCanonicalDirectory(root);
  const bytes = Buffer.from(JSON.stringify(proof), 'utf8');
  if (bytes.length > WORKSPACE_BACKUP_MAX_FILE_BYTES)
    throw new WorkspaceBackupBundleError('invalid-bundle');
  const name = `.proof-${randomUUID()}.json`;
  const destinationPath = join(root, name);
  const admission =
    owner.fileAdmission ?? new FileStorageAdmission(owner.core.dataRoot, () => 1_000_000_000n);
  const reservation = admission.forPath(root).reserve({
    stagingBytes: BigInt(bytes.length),
    extractionBytes: 0n,
    derivativeBytes: 0n,
    publicationBytes: 0n,
  });
  let published = false;
  let result: { ok: true } | { ok: false; error: unknown };
  try {
    assertTargetRecoveryOwner(owner, owner.core.dataRoot, input.workspaceId);
    reservation.assertAvailable();
    const file = await publishDurableFile({ destinationPath, bytes });
    published = true;
    reservation.recordWritten(file.bytes);
    assertTargetRecoveryOwner(owner, owner.core.dataRoot, input.workspaceId);
    await withTargetCore(owner, input.workspaceId, (client, database) =>
      client.recoveryTargetPreparation(
        database,
        {
          ...input,
          file: { name, byteLength: file.bytes, digest: file.sha256 },
        },
        owner.native?.freeze
      )
    );
    result = { ok: true };
  } catch (error) {
    result = { ok: false, error };
  }
  try {
    if (published) await removeDurableFile({ destinationPath });
  } catch (error) {
    if (result.ok) result = { ok: false, error };
  } finally {
    reservation.release();
  }
  if (!result.ok) throw result.error;
  assertTargetRecoveryOwner(owner, owner.core.dataRoot, input.workspaceId);
}

/** Restores one existing same-deployment Workspace, or admits one identity-preserving MOVE privately. */
export async function admitWorkspaceBackup(
  input: WorkspaceTargetRecoveryInput,
  deps: WorkspaceRecoveryDependencies = {}
): Promise<WorkspaceRecoveryCliReport> {
  return withRecoveryRoot(input.dataRoot, (core) =>
    admitTarget(
      { core, fileAdmission: new FileStorageAdmission(input.dataRoot, () => 1_000_000_000n) },
      input,
      deps
    )
  );
}

/** Prepares and places a target through the already-owned Core and exact live freeze. */
export async function admitWorkspaceBackupAtCore(
  owner: WorkspaceRecoveryTargetOwner,
  input: WorkspaceTargetRecoveryInput,
  deps: WorkspaceRecoveryDependencies = {}
): Promise<WorkspaceRecoveryCliReport> {
  if (!owner.native) refuseRecovery('recovery-required');
  return admitTarget(owner, input, deps);
}

/**
 * Revalidates a placed target or restored predecessor before its exact recovery exclusion can end.
 * A terminal result proves the lifecycle decision, never serving validity.
 */
export function activateWorkspaceRecoveryAtCore(
  owner: WorkspaceRecoveryTargetOwner,
  input: {
    readonly requestId: string;
    readonly store: FsStore;
    readonly runtimeConfigManager: RuntimeConfigManager;
    readonly currentAuthority: () => void;
  }
): WorkspaceRecoveryCliReport {
  const { core, native } = owner;
  if (!native) refuseRecovery('recovery-required');
  input.currentAuthority();
  const owned = readWorkspaceRecoveryReadmission(core, input.requestId, native.gate, native.freeze);
  if (
    !['restore', 'move-in'].includes(owned.proof.input.command) ||
    owned.proof.result.disposition !==
      (owned.state === 'abandoned'
        ? 'abandoned'
        : owned.proof.input.command === 'restore'
          ? 'restored'
          : 'imported') ||
    owned.proof.result.workspaceId !== owned.workspace_id ||
    owned.candidate_ref !==
      join(
        `${resolve(core.dataRoot)}.workspace-recovery-${owned.admission_id}`,
        'workspaces',
        owned.workspace_id
      ) ||
    input.store.getDataRoot() === null ||
    resolve(input.store.getDataRoot()!) !== resolve(core.dataRoot) ||
    input.runtimeConfigManager.getDataRoot() === null ||
    resolve(input.runtimeConfigManager.getDataRoot()!) !== resolve(core.dataRoot)
  )
    refuseRecovery('recovery-required');
  const workspaceId = owned.workspace_id;
  if (owned.state === 'finished') {
    if (
      !owned.proof.candidateDigest ||
      candidateDigest(join(core.dataRoot, 'workspaces', workspaceId)) !==
        owned.proof.candidateDigest
    )
      refuseRecovery('recovery-required');
  } else {
    // The retired candidate's digest cannot identify the restored predecessor. Both pending
    // placement paths must be gone before the same canonical Store/config readers admit it.
    if (existsSync(owned.candidate_ref) || existsSync(workspaceRecoveryPredecessorRoot(owned)))
      refuseRecovery('recovery-required');
    assertCanonicalDirectory(join(dirname(owned.candidate_ref), 'abandoned'));
  }
  assertTargetRecoveryOwner(owner, core.dataRoot, workspaceId);
  const failure = scopeAdmissionFailures(core.dataRoot).find(
    (entry) => entry.scope === 'workspace' && entry.id === workspaceId && entry.check !== 'index'
  );
  if (failure?.check !== 'recovery') refuseRecovery('recovery-required');
  // Both loaders retain their owning checks and leave public authority refused on any failure.
  input.store.reloadRecoveredWorkspace(workspaceId, native.freeze);
  input.runtimeConfigManager.reloadRecoveredWorkspace(workspaceId, native.gate, native.freeze);
  input.currentAuthority();
  assertTargetRecoveryOwner(owner, core.dataRoot, workspaceId);
  if (
    !isDeepStrictEqual(
      readWorkspaceRecoveryReadmission(core, input.requestId, native.gate, native.freeze),
      owned
    ) ||
    !scopeAdmissionFailures(core.dataRoot).includes(failure)
  )
    refuseRecovery('recovery-required');
  // Synchronous settlement has no I/O, callback or await between validation and serving admission.
  input.store.settleRecoveredWorkspacePublication(workspaceId, native.freeze);
  settleWorkspaceRecoveryScope({
    dataRoot: core.dataRoot,
    failure,
    admission: native.gate,
    freeze: native.freeze,
  });
  native.gate.reopen(workspaceId, 'capture');
  return owned.proof.result;
}

/** Reuses original request/manifest identity before either replay or a new lifecycle effect. */
function originalTargetRequest(
  core: CoreDb,
  input: WorkspaceTargetRecoveryInput
): RecoveryAdmission | undefined {
  const previous = readRecoveryAdmission(core, input.requestId);
  if (previous) {
    if (
      input.snapshotSource?.source.kind === 'local-snapshot' &&
      input.snapshotSource.source.backupId !== previous.backup_id
    )
      refuseRecovery('request-conflict');
    if (
      !isDeepStrictEqual(
        requestIdentity(previous.proof.input as TargetArgs),
        requestIdentity(input)
      )
    )
      refuseRecovery('request-conflict');
    // A readable changed identity conflicts; damaged source bytes cannot revoke a committed result.
    let manifest: WorkspaceBackupManifest | undefined;
    let digest: string | undefined;
    try {
      manifest = readWorkspaceBackupManifest(input.bundleRoot);
      digest = `sha256:${createHash('sha256')
        .update(readFileSync(join(input.bundleRoot, WORKSPACE_BACKUP_MANIFEST_FILE)))
        .digest('hex')}`;
    } catch {}
    if (
      manifest &&
      (!isDeepStrictEqual(manifest, previous.proof.manifest) ||
        (digest !== undefined && digest !== previous.proof.capture.manifestDigest))
    )
      refuseRecovery('request-conflict');
    return previous;
  }
  return undefined;
}

/** Shared body for the existing offline root lock and the admitted live lifecycle. */
async function admitTarget(
  owner: TargetRecoveryOwner,
  input: WorkspaceTargetRecoveryInput,
  deps: WorkspaceRecoveryDependencies = {}
): Promise<WorkspaceRecoveryCliReport> {
  const core = owner.core;
  assertTargetRecoveryOwner(owner, input.dataRoot);
  const previous = originalTargetRequest(core, input);
  if (previous) {
    assertTargetRecoveryOwner(owner, input.dataRoot, previous.workspace_id);
    return finishTarget(owner, previous, deps, input.expectedRelease);
  }
  const manifest = readWorkspaceBackupManifest(input.bundleRoot);
  const workspaceId = manifest.workspaceId;
  if (owner.deletedRecovery) {
    const deletion = owner.deletedRecovery.deletion;
    if (
      input.command !== 'restore' ||
      input.acknowledgeLostSafety ||
      deletion.workspaceId !== workspaceId ||
      deletion.recoveryBackupId !== manifest.backupId ||
      deletion.originalOwnerUserId !== manifest.accounts.ownerId ||
      !['deleted', 'cleaned'].includes(deletion.phase) ||
      !deletion.closureId ||
      !deletion.closureDigest
    )
      refuseRecovery('recovery-required');
  }
  assertTargetRecoveryOwner(owner, input.dataRoot, workspaceId);
  const final = join(input.dataRoot, 'workspaces', workspaceId);
  if (
    core.sqlite
      .prepare(
        "SELECT 1 FROM workspace_recovery_admissions WHERE workspace_id=? AND (state='prepared' OR (state='abandoned' AND json_extract(proof_json,'$.result.disposition')!='abandoned'))"
      )
      .get(workspaceId)
  )
    refuseRecovery('recovery-required');
  const registered = core.sqlite
    .prepare('SELECT * FROM workspace_registry WHERE workspace_id=?')
    .get(workspaceId);
  if (input.command === 'restore') {
    if (
      manifest.sourceDeploymentId !== readDataRootLayoutMarker(input.dataRoot).deploymentId ||
      workspaceId !== input.workspaceId
    )
      refuseRecovery('deployment-mismatch');
    if (!registered) refuseRecovery('workspace-unavailable');
    const lifecycle = getWorkspaceRegistryLifecycleFact(core, workspaceId);
    if (lifecycle?.status !== 'active' && !owner.deletedRecovery)
      refuseRecovery('workspace-unavailable');
    if (owner.deletedRecovery && (lifecycle?.status !== 'deleted' || existsSync(final)))
      refuseRecovery('recovery-required');
  } else if (
    registered ||
    existsSync(final) ||
    core.sqlite
      .prepare(
        "SELECT 1 FROM workspace_recovery_admissions WHERE workspace_id=? AND NOT (state='abandoned' AND json_extract(proof_json,'$.result.disposition')='abandoned')"
      )
      .get(workspaceId)
  )
    refuseRecovery('identity-collision');
  // Fresh invalid maps are input refusals, not corrupt retained ownership.
  if (input.command === 'move-in') {
    mapping(
      core,
      input,
      manifest,
      `sha256:${createHash('sha256')
        .update(readFileSync(join(input.bundleRoot, WORKSPACE_BACKUP_MANIFEST_FILE)))
        .digest('hex')}`
    );
  }
  // Unpublished databases stay outside boot discovery under the same admitted recovery owner.
  const container = `${resolve(input.dataRoot)}.workspace-recovery-${input.requestId}`;
  const candidate = join(container, 'workspaces', workspaceId);
  mkdirSync(dirname(candidate), { recursive: true, mode: 0o700 });
  const staged = await stageWorkspaceBackup({
    ...WORKSPACE_BACKUP_POLICY,
    ...(input.snapshotSource ? { snapshotSource: input.snapshotSource } : {}),
    bundleRoot: input.bundleRoot,
    stagingParent: container,
    admission: owner.fileAdmission,
    expectedRelease: input.expectedRelease,
    candidateRoot: candidate,
    expectedWorkspaceId: workspaceId,
    expectedSourceDeploymentId: manifest.sourceDeploymentId,
    purpose: input.command === 'restore' ? 'backup' : 'move',
  });
  assertTargetRecoveryOwner(owner, input.dataRoot, workspaceId);
  const result = recoveryReport(input.command, 'quarantined', staged.report);
  const { snapshotSource: _snapshotSource, ...retainedInput } = input;
  await publishTargetProofStage(
    owner,
    {
      ...targetCoreAuthority(owner, input.requestId, workspaceId),
      kind: 'prepare',
    },
    {
      input: retainedInput,
      manifest: staged.manifest,
      capture: staged.report,
      result,
    }
  );
  const owned = readRecoveryAdmission(core, input.requestId)!;
  const map = mapping(core, input, owned.proof.manifest, owned.proof.capture.manifestDigest);
  const previousProofHash = commandInputHash(owned.proof);
  const digest = await bindTargetCandidate(core, owned, map, owner);
  assertTargetRecoveryOwner(owner, input.dataRoot, workspaceId);
  const proof = { ...owned.proof, candidateDigest: digest };
  await publishTargetProofStage(
    owner,
    {
      ...targetCoreAuthority(owner, input.requestId, workspaceId),
      kind: 'proof',
      expectedRevision: owned.revision,
      proofHash: previousProofHash,
    },
    proof
  );
  return finishTarget(owner, { ...owned, proof }, deps);
}
/** Finishes only the retained owned target; no bundle, account, or final directory discovers ownership. */
export async function finishWorkspaceRecovery(
  input: WorkspaceRecoverySelectedInput,
  deps: WorkspaceRecoveryDependencies = {}
): Promise<WorkspaceRecoveryCliReport> {
  return withRecoveryRoot(input.dataRoot, (core) => finishSelectedTarget({ core }, input, deps));
}

/** Finishes the original selected target under an already-owned Core and lifecycle exclusion. */
export async function finishWorkspaceRecoveryAtCore(
  owner: TargetCoreOwner,
  input: WorkspaceRecoverySelectedInput,
  deps: WorkspaceRecoveryDependencies = {}
): Promise<WorkspaceRecoveryCliReport> {
  if (!owner.native) refuseRecovery('recovery-required');
  return finishSelectedTarget(owner, input, deps);
}

/** Shared body for the existing offline root lock and the admitted live lifecycle. */
async function finishSelectedTarget(
  owner: TargetCoreOwner,
  input: WorkspaceRecoverySelectedInput,
  deps: WorkspaceRecoveryDependencies = {}
): Promise<WorkspaceRecoveryCliReport> {
  const core = owner.core;
  assertTargetRecoveryOwner(owner, input.dataRoot, input.workspaceId);
  if (input.selection.kind !== 'admission') refuseRecovery('request-conflict');
  const owned = selectRecoveryAdmission(core, input);
  return {
    ...(await finishTarget(owner, owned, deps, input.expectedRelease)),
    command: 'finish',
    selection: input.selection,
  };
}
/** Closes finish rights before retiring owned unpublished bytes; retained holds are never deleted. */
export async function abandonWorkspaceRecovery(
  input: WorkspaceRecoverySelectedInput
): Promise<WorkspaceRecoveryCliReport> {
  return withRecoveryRoot(input.dataRoot, (core) => abandonSelectedTarget({ core }, input));
}

/** Closes original finish rights and retires only its owned target under the supplied Core. */
export async function abandonWorkspaceRecoveryAtCore(
  owner: TargetCoreOwner,
  input: WorkspaceRecoverySelectedInput
): Promise<WorkspaceRecoveryCliReport> {
  if (!owner.native) refuseRecovery('recovery-required');
  return abandonSelectedTarget(owner, input);
}

/** Shared body for the existing offline root lock and the admitted live lifecycle. */
async function abandonSelectedTarget(
  owner: TargetCoreOwner,
  input: WorkspaceRecoverySelectedInput
): Promise<WorkspaceRecoveryCliReport> {
  const core = owner.core;
  assertTargetRecoveryOwner(owner, input.dataRoot, input.workspaceId);
  if (input.selection.kind !== 'admission') refuseRecovery('request-conflict');
  const owned = selectRecoveryAdmission(core, input);
  if (owned.state === 'finished') refuseRecovery('request-conflict');
  if (owned.state === 'abandoned' && owned.proof.result.disposition === 'abandoned')
    return owned.proof.result;
  if (owner.native && owned.state === 'prepared' && !owned.proof.candidateDigest) {
    // A digest is published only after native seal/close. Partial preparation can instead
    // leave a real writer open: freeze alone cannot authorize retiring that database.
    const bindings = bindWorkspaceRecoveryNativeOwner(
      core,
      owned,
      owner.native.gate,
      owner.native.freeze
    );
    const client = getControlStoreWorkerClient(owner.native.gate);
    for (const binding of [bindings.canonical, bindings.candidate]) {
      if (!binding) continue;
      await client.open(binding.binding.command, binding);
      assertTargetRecoveryOwner(owner, core.dataRoot, input.workspaceId);
      await client.close(binding.binding.command.database, binding);
      assertTargetRecoveryOwner(owner, core.dataRoot, input.workspaceId);
    }
    if (!isDeepStrictEqual(readRecoveryAdmission(core, owned.admission_id), owned))
      refuseRecovery('recovery-required');
  }
  await withTargetCore(owner, input.workspaceId, (client, database) =>
    client.recoveryTargetPreparation(
      database,
      {
        ...targetCoreAuthority(owner, owned.admission_id, input.workspaceId),
        kind: 'abandon',
        expectedRevision: owned.revision,
        proofHash: commandInputHash(owned.proof),
      },
      owner.native?.freeze
    )
  );
  assertTargetRecoveryOwner(owner, core.dataRoot, input.workspaceId);
  const closed = readRecoveryAdmission(core, owned.admission_id)!;
  const final = join(input.dataRoot, 'workspaces', input.workspaceId);
  const retired = join(dirname(owned.candidate_ref), 'abandoned');
  const candidate =
    existsSync(owned.candidate_ref) || !owned.proof.candidateDigest ? owned.candidate_ref : final;
  if (!existsSync(retired) && existsSync(candidate)) {
    if (owned.proof.candidateDigest && candidateDigest(candidate) !== owned.proof.candidateDigest)
      refuseRecovery('recovery-required');
    renameSync(candidate, retired);
  }
  const predecessor = workspaceRecoveryPredecessorRoot(owned);
  if (existsSync(predecessor)) {
    if (existsSync(final)) refuseRecovery('recovery-required');
    renameSync(predecessor, final);
    syncCanonicalDirectory(dirname(predecessor));
  }
  syncCanonicalDirectory(dirname(final));
  syncCanonicalDirectory(dirname(retired));
  const report: WorkspaceRecoveryCliReport = {
    ...owned.proof.result,
    command: 'abandon',
    disposition: 'abandoned',
    selection: input.selection,
    nextAction: 'none',
  };
  // Boot stays fenced until the owned retirement and predecessor restoration are durable.
  await publishTargetProofStage(
    owner,
    {
      ...targetCoreAuthority(owner, owned.admission_id, input.workspaceId),
      kind: 'abandon-result',
      expectedRevision: closed.revision,
      proofHash: commandInputHash(closed.proof),
    },
    { ...closed.proof, result: report }
  );
  return report;
}

/** Applies current safety and target bindings only to privately owned, already verified bytes. */
async function bindTargetCandidate(
  core: CoreDb,
  owned: RecoveryAdmission,
  map: ReturnType<typeof mapping>,
  admitted: TargetRecoveryOwner
): Promise<string> {
  const input = owned.proof.input as TargetArgs;
  const root = owned.candidate_ref;
  const dataRoot = dirname(dirname(root));
  const workspaceId = owned.workspace_id;
  const manifest = owned.proof.manifest;
  const now = new Date().toISOString();
  const live = admitted.native;
  const client = getControlStoreWorkerClient(live?.gate);
  if (live) client.setFileStorageAdmission(dataRoot, admitted.fileAdmission.forPath(root));
  const native = live
    ? bindWorkspaceRecoveryNativeOwner(core, owned, live.gate, live.freeze)
    : undefined;
  const {
    owner,
    path,
    contentMount: mount,
  } = nativeProductScope(dataRoot, { kind: 'workspace', workspaceId }, root);
  const database = `workspace:${path}`;
  let opened = false;
  let restricted: WorkspaceRecoveryCliReport['restrictedRecovery'] = false;
  try {
    // The admitted lifecycle owns this private candidate through native close.
    if (native?.canonical) {
      await client.open(native.canonical.binding.command, native.canonical);
      await client.close(native.canonical.binding.command.database, native.canonical);
      assertTargetRecoveryOwner(admitted, core.dataRoot, workspaceId);
    }
    mkdirSync(mount.root, { recursive: true, mode: 0o700 });
    mkdirSync(join(root, 'runtime'), { recursive: true, mode: 0o700 });
    await client.open(
      {
        database,
        path,
        dataRoot,
        create: false,
        initialize: 'workspace',
        productOwner: owner,
        contentMount: mount,
      },
      native?.candidate
    );
    opened = true;
    assertTargetRecoveryOwner(admitted, core.dataRoot, workspaceId);
    if (input.command === 'restore' && !admitted.deletedRecovery) {
      const safety = await client.recoverySafety(
        database,
        {
          workspaceId,
          sourceDataRoot: resolve(core.dataRoot),
        },
        native?.candidate
      );
      assertTargetRecoveryOwner(admitted, core.dataRoot, workspaceId);
      if (safety === 'moved-out') refuseRecovery('workspace-moved-out');
      if (safety === 'unavailable') {
        if (!input.acknowledgeLostSafety) refuseRecovery('safety-unproved');
        restricted = {
          backupId: manifest.backupId,
          captureStartedAt: manifest.capture.startedAt,
          lossDetectedAt: now,
        };
      }
    }
    await client.write(
      database,
      [
        {
          mode: 'run',
          sql: "UPDATE control_workspaces SET revision=revision+1,record_json=json_set(record_json,'$.importedFrom',json(?)) WHERE id=?",
          parameters: [
            JSON.stringify({
              sourceDeploymentId: manifest.sourceDeploymentId,
              sourceWorkspaceId: workspaceId,
              exportCreatedAt: manifest.capture.completedAt,
              manifestDigest: owned.proof.capture.manifestDigest,
            }),
            workspaceId,
          ],
        },
      ],
      native?.candidate
    );
    assertTargetRecoveryOwner(admitted, core.dataRoot, workspaceId);
    await client.recoveryCleanup(
      database,
      {
        workspaceId,
        action: input.command === 'restore' ? 'workspace.restore' : 'workspace.move-in',
        preparation: {
          now,
          requiredFeatures: manifest.requiredFeatures,
          restricted: !!restricted,
          ownerId: input.command === 'move-in' ? input.targetOwnerId : manifest.accounts.ownerId,
          memberMappings: map?.accountMap.memberMappings ?? [],
        },
        summary: JSON.stringify({
          backupId: manifest.backupId,
          manifestDigest: owned.proof.capture.manifestDigest,
          restrictedRecovery: restricted,
        }),
      },
      native?.candidate
    );
    assertTargetRecoveryOwner(admitted, core.dataRoot, workspaceId);
    if (manifest.requiredFeatures.includes('workspace.recurring-triggers.v1')) {
      // The admitted coordinator retires transfer inputs only after durable native preparation.
      if (live && !live.gate.ownsFreeze(workspaceId, live.freeze))
        refuseRecovery('recovery-required');
      for (const path of Object.values(RECURRING_PORTABLE_PATHS)) unlinkSync(join(root, path));
    }
    for (;;) {
      const done = await client.recoveryHistory(database, workspaceId, native?.candidate);
      assertTargetRecoveryOwner(admitted, core.dataRoot, workspaceId);
      if (done) break; // Each ACK advances an existing history unit, never a retry.
    }
    owned.proof.result = { ...owned.proof.result, restrictedRecovery: restricted };
    const digest = await client.sealRecovery(database, native?.candidate);
    opened = false; // The reply proves close even when the subsequent byte seal was unavailable.
    assertTargetRecoveryOwner(admitted, core.dataRoot, workspaceId);
    if (digest === null) refuseRecovery('recovery-required');
    return digest;
  } finally {
    if (opened) await client.close(database, native?.candidate);
  }
}

/** Revalidates canonical source bytes without borrowing a replaced target's candidate digest. */
function activateSourceCapture(
  owned: ReturnType<typeof workspaceSnapshotOperationPolicy>,
  input: WorkspaceRecoverySelectedInput,
  freeze: WorkspaceFrozenAdmission,
  manager: RuntimeConfigManager
): void {
  const before = readWorkspaceCaptureRecoveryAtCore(owned.coreDb, input);
  if (
    before.movedOut ||
    before.capture.state === 'active' ||
    !owned.mutationAdmission.ownsRecoveryOrigin(input.workspaceId, freeze, {
      captureId: before.capture.captureId,
    }) ||
    (before.owned && before.owned.state !== 'abandoned')
  )
    refuseRecovery('recovery-required');
  const failure = scopeAdmissionFailures(owned.dataRoot).find(
    (row) => row.scope === 'workspace' && row.id === input.workspaceId && row.check !== 'index'
  );
  if (failure && failure.check !== 'recovery') refuseRecovery('recovery-required');
  try {
    owned.store.reloadRecoveredWorkspace(input.workspaceId, freeze);
    manager.reloadRecoveredWorkspace(input.workspaceId, owned.mutationAdmission, freeze);
  } catch (error) {
    throw new OperationError(
      'recovery-required',
      'Canonical Workspace validation is unavailable.',
      409,
      { cause: error }
    );
  }
  owned.currentAuthority();
  if (
    !isDeepStrictEqual(before, readWorkspaceCaptureRecoveryAtCore(owned.coreDb, input)) ||
    failure !==
      scopeAdmissionFailures(owned.dataRoot).find(
        (row) => row.scope === 'workspace' && row.id === input.workspaceId && row.check !== 'index'
      ) ||
    readWorkspaceRecoveryBlockers(
      { ...owned, workspaceId: input.workspaceId, operation: 'restore' },
      { captureId: before.capture.captureId }
    ).length
  )
    refuseRecovery('recovery-required');
  owned.store.settleRecoveredWorkspacePublication(input.workspaceId, freeze);
  if (failure)
    settleWorkspaceRecoveryScope({
      dataRoot: owned.dataRoot,
      failure,
      admission: owned.mutationAdmission,
      freeze,
    });
  owned.mutationAdmission.reopen(input.workspaceId, 'capture');
}

/** Completes one original selection under the existing nonwaiting freeze and native drain. */
async function decideWorkspaceRecovery(
  dependencies: OperationInvocationDependencies,
  input: Omit<WorkspaceRecoverySelectedInput, 'dataRoot' | 'expectedRelease'>,
  context: AdmittedOperationContext,
  decision: 'finish' | 'abandon'
) {
  return invokeWorkspaceRecoveryOperation(async () => {
    const owned = workspaceSnapshotOperationPolicy(dependencies, context);
    const manager = dependencies.runtimeConfigManager;
    if (
      !manager ||
      manager.getDataRoot() === null ||
      resolve(manager.getDataRoot()!) !== resolve(owned.dataRoot)
    )
      throw new OperationError(
        'operation_storage_unavailable',
        'Workspace configuration is unavailable.',
        503
      );
    const selected = {
      ...input,
      dataRoot: owned.dataRoot,
      expectedRelease: owned.verification.expectedRelease,
    };
    const target =
      input.selection.kind === 'admission'
        ? selectRecoveryAdmission(owned.coreDb, selected)
        : undefined;
    const source =
      input.selection.kind === 'capture'
        ? readWorkspaceCaptureRecoveryAtCore(owned.coreDb, selected)
        : undefined;
    // A SQL pin alone does not prove a complete generation or its intended finish.
    if (
      source &&
      decision === 'finish' &&
      !existsSync(
        join(
          owned.dataRoot,
          'server/backups/workspaces',
          input.workspaceId,
          source.capture.captureId,
          WORKSPACE_BACKUP_MANIFEST_FILE
        )
      )
    )
      refuseRecovery('recovery-required');
    const terminal = target?.state ?? source!.capture.state;
    if (
      (terminal === 'finished' && decision === 'abandon') ||
      (terminal === 'abandoned' && decision === 'finish')
    )
      refuseRecovery('request-conflict');
    // A committed replay never reloads or replaces the target's later healthy work.
    if (
      isScopeAdmitted(owned.dataRoot, 'workspace', input.workspaceId) &&
      !owned.mutationAdmission.isClosed(input.workspaceId) &&
      terminal !== 'prepared' &&
      terminal !== 'active'
    ) {
      owned.currentAuthority();
      if (target)
        return WorkspaceSnapshotReportSchema.parse({
          ...target.proof.result,
          command: decision,
          selection: input.selection,
        });
      if (terminal === 'abandoned')
        return WorkspaceSnapshotReportSchema.parse({
          command: decision,
          disposition: 'abandoned',
          workspaceId: input.workspaceId,
          selection: input.selection,
          currentRevision: source!.revision,
          droppedSourceMemberIds: [],
          restrictedRecovery: false,
          nextAction: 'none',
        });
      const verified = await inspectWorkspaceSnapshot(
        { workspaceId: input.workspaceId, backupId: source!.capture.captureId },
        owned
      );
      owned.currentAuthority();
      return WorkspaceSnapshotReportSchema.parse({
        ...recoveryReport(decision, 'sealed', verified.report),
        selection: input.selection,
        currentRevision: source!.revision,
      });
    }
    owned.store.setWorkspaceMutationAdmission(owned.mutationAdmission);
    const inspect = () =>
      readWorkspaceRecoveryBlockers(
        { ...owned, workspaceId: input.workspaceId, operation: 'restore' },
        target ?? { captureId: source!.capture.captureId }
      );
    let hold: Promise<() => void> | null = null;
    const inspectAndHold = () => {
      const blockers = inspect();
      if (blockers.length) return blockers;
      hold = getControlStoreWorkerClient(owned.mutationAdmission).tryPauseForWorkspaceCapture(
        `workspace:${join(owned.dataRoot, 'workspaces', input.workspaceId, 'db/workspace.sqlite')}`,
        owned.mutationAdmission
      );
      return hold
        ? []
        : [
            {
              kind: 'publication' as const,
              reason: 'pending-publication' as const,
              reference: { workspaceId: input.workspaceId },
              actions: [],
            },
          ];
    };
    const wasClosed = owned.mutationAdmission.isClosed(input.workspaceId);
    const freeze = wasClosed
      ? target
        ? resumeWorkspaceRecoveryOwner(
            owned.coreDb,
            target,
            owned.mutationAdmission,
            inspectAndHold
          )
        : resumeWorkspaceCaptureOwner(
            owned.coreDb,
            input.workspaceId,
            source!.capture.captureId,
            owned.mutationAdmission,
            inspectAndHold
          )
      : owned.mutationAdmission.tryFreeze(input.workspaceId, inspectAndHold);
    if (freeze.status !== 'frozen')
      throw new OperationError(
        freeze.status === 'busy' && wasClosed ? 'workspace_frozen' : 'workspace_blocked',
        'Workspace recovery is not admitted.',
        409,
        {
          details: {
            workspaceId: input.workspaceId,
            operation: 'restore',
            retryable: freeze.status === 'busy' && wasClosed,
            blockers:
              freeze.status === 'blocked'
                ? freeze.blockers
                : [
                    {
                      kind: 'publication',
                      reason: wasClosed ? 'frozen' : 'pending-publication',
                      reference: { workspaceId: input.workspaceId },
                      actions: [],
                    },
                  ],
          },
        }
      );
    let release: (() => void) | undefined;
    try {
      try {
        if (!hold) refuseRecovery('recovery-required');
        release = await hold;
        owned.currentAuthority();
        const blockers = inspect();
        if (blockers.length)
          throw new OperationError(
            'workspace_blocked',
            'Workspace recovery is not admitted.',
            409,
            {
              details: {
                workspaceId: input.workspaceId,
                operation: 'restore',
                retryable: false,
                blockers,
              },
            }
          );
      } finally {
        release?.();
      }
      const owner = {
        core: owned.coreDb,
        fileAdmission: owned.verification.admission,
        native: { gate: owned.mutationAdmission, freeze },
        currentAuthority: owned.currentAuthority,
        actor: publicOperationActor(context),
      };
      let report: WorkspaceRecoveryCliReport;
      if (target) {
        report =
          decision === 'finish'
            ? await finishWorkspaceRecoveryAtCore(owner, selected)
            : await abandonWorkspaceRecoveryAtCore(owner, selected);
        owned.currentAuthority();
        if (decision === 'finish' || target.proof.input.command === 'restore')
          activateWorkspaceRecoveryAtCore(owner, {
            requestId: target.admission_id,
            store: owned.store,
            runtimeConfigManager: manager,
            currentAuthority: owned.currentAuthority,
          });
      } else {
        report =
          decision === 'finish'
            ? await finishWorkspaceCaptureAtCore(owned, selected, freeze)
            : await abandonWorkspaceCaptureAtCore(owned, selected, freeze);
        owned.currentAuthority();
        if (!readWorkspaceCaptureRecoveryAtCore(owned.coreDb, selected).movedOut)
          activateSourceCapture(owned, selected, freeze, manager);
      }
      return WorkspaceSnapshotReportSchema.parse(report);
    } catch (error) {
      refuseScope(owned.dataRoot, { scope: 'workspace', id: input.workspaceId, check: 'recovery' });
      if (target)
        owned.mutationAdmission.restoreRecoveryClosed(input.workspaceId, {
          admissionId: target.admission_id,
          revision: target.revision - (target.state === 'prepared' ? 0 : 1),
          candidateRef: target.candidate_ref,
        });
      else
        owned.mutationAdmission.restoreRecoveryClosed(input.workspaceId, {
          captureId: source!.capture.captureId,
        });
      throw error;
    } finally {
      freeze.release();
    }
  });
}

/** Composes same-deployment restore through the existing target and admission owners only. */
export function createWorkspaceRestoreOperationImplementations(
  dependencies: OperationInvocationDependencies
) {
  type Input = import('zod').infer<
    (typeof WORKSPACE_SNAPSHOT_OPERATION_DEFINITIONS)['workspace.backup-restore']['inputSchema']
  >;
  type SelectedInput = import('zod').infer<
    (typeof WORKSPACE_SNAPSHOT_OPERATION_DEFINITIONS)['workspace.recovery-finish']['inputSchema']
  >;
  return {
    'workspace.recovery-finish': (input: SelectedInput, context: AdmittedOperationContext) =>
      decideWorkspaceRecovery(dependencies, input, context, 'finish'),
    'workspace.recovery-abandon': (input: SelectedInput, context: AdmittedOperationContext) =>
      decideWorkspaceRecovery(dependencies, input, context, 'abandon'),
    'workspace.recovery-inspect': (
      input: import('zod').infer<
        (typeof WORKSPACE_SNAPSHOT_OPERATION_DEFINITIONS)['workspace.recovery-inspect']['inputSchema']
      >,
      context: AdmittedOperationContext
    ) =>
      invokeWorkspaceRecoveryOperation(async () => {
        const owned = workspaceSnapshotOperationPolicy(dependencies, context);
        const selected = { ...input, dataRoot: owned.dataRoot };
        if (input.selection.kind === 'admission')
          return WorkspaceSnapshotReportSchema.parse(
            inspectWorkspaceRecoveryAtCore(owned.coreDb, selected)
          );
        const facts = readWorkspaceCaptureRecoveryAtCore(owned.coreDb, selected);
        const state = facts.capture;
        const current = facts;
        const retained = readRecoveryAdmission(owned.coreDb, input.selection.backupId);
        if (retained)
          return WorkspaceSnapshotReportSchema.parse(
            inspectWorkspaceRecoveryAtCore(owned.coreDb, selected, {
              revision: current.revision,
              movedOut: !!current.movedOut,
            })
          );
        // SQL lifecycle alone proves neither capture purpose nor a transferable seal.
        const basic = {
          command: 'inspect' as const,
          workspaceId: input.workspaceId,
          selection: input.selection,
          currentRevision: current.revision,
          droppedSourceMemberIds: [],
          restrictedRecovery: false as const,
        };
        if (state.state !== 'finished')
          return WorkspaceSnapshotReportSchema.parse({
            ...basic,
            disposition: state.state === 'abandoned' ? 'abandoned' : 'pending',
            nextAction: state.state === 'active' ? 'abandon' : 'none',
          });
        const verified = await inspectWorkspaceSnapshot(
          { workspaceId: input.workspaceId, backupId: input.selection.backupId },
          owned
        );
        owned.currentAuthority();
        return WorkspaceSnapshotReportSchema.parse({
          ...recoveryReport('inspect', 'sealed', verified.report),
          ...basic,
        });
      }),
    'workspace.backup-restore': (input: Input, context: AdmittedOperationContext) =>
      invokeWorkspaceRecoveryOperation(async () => {
        const owned = workspaceSnapshotOperationPolicy(dependencies, context);
        const manager = dependencies.runtimeConfigManager;
        if (
          !manager ||
          manager.getDataRoot() === null ||
          resolve(manager.getDataRoot()!) !== resolve(owned.dataRoot)
        )
          throw new OperationError(
            'operation_storage_unavailable',
            'Workspace configuration is unavailable.',
            503
          );
        const target: WorkspaceTargetRecoveryInput = {
          command: 'restore',
          dataRoot: owned.dataRoot,
          bundleRoot: join(
            owned.dataRoot,
            'server/backups/workspaces',
            input.workspaceId,
            input.backupId
          ),
          workspaceId: input.workspaceId,
          requestId: input.requestId,
          acknowledgeLostSafety: input.acknowledgeLostSafety,
          expectedRelease: owned.verification.expectedRelease,
          snapshotSource: {
            dataRoot: owned.dataRoot,
            source: {
              kind: 'local-snapshot',
              workspaceId: input.workspaceId,
              backupId: input.backupId,
            },
          },
        };
        const previous = originalTargetRequest(owned.coreDb, target);
        // Original committed replay never freezes or rewrites current healthy work.
        if (
          previous?.state === 'finished' &&
          isScopeAdmitted(owned.dataRoot, 'workspace', input.workspaceId)
        ) {
          owned.currentAuthority();
          return WorkspaceSnapshotReportSchema.parse(previous.proof.result);
        }
        owned.store.setWorkspaceMutationAdmission(owned.mutationAdmission);
        const inspect = () =>
          previous
            ? readWorkspaceRecoveryBlockers(
                {
                  coreDb: owned.coreDb,
                  store: owned.store,
                  workspaceId: input.workspaceId,
                  operation: 'restore',
                },
                previous
              )
            : readBlockers({
                coreDb: owned.coreDb,
                store: owned.store,
                workspaceId: input.workspaceId,
                operation: 'restore',
              });
        let hold: Promise<() => void> | null = null;
        const inspectAndHold = () => {
          const blockers = inspect();
          if (blockers.length) return blockers;
          hold = getControlStoreWorkerClient(owned.mutationAdmission).tryPauseForWorkspaceCapture(
            `workspace:${join(owned.dataRoot, 'workspaces', input.workspaceId, 'db/workspace.sqlite')}`,
            owned.mutationAdmission
          );
          return hold
            ? []
            : [
                {
                  kind: 'publication' as const,
                  reason: 'pending-publication' as const,
                  reference: { workspaceId: input.workspaceId },
                  actions: [],
                },
              ];
        };
        const wasClosed = owned.mutationAdmission.isClosed(input.workspaceId);
        const freeze = previous
          ? resumeWorkspaceRecoveryOwner(
              owned.coreDb,
              previous,
              owned.mutationAdmission,
              inspectAndHold
            )
          : owned.mutationAdmission.tryFreeze(input.workspaceId, inspectAndHold);
        if (freeze.status !== 'frozen')
          throw new OperationError(
            freeze.status === 'busy' && wasClosed ? 'workspace_frozen' : 'workspace_blocked',
            'Workspace restore is not admitted.',
            409,
            {
              details: {
                workspaceId: input.workspaceId,
                operation: 'restore',
                retryable: freeze.status === 'busy' && wasClosed,
                blockers:
                  freeze.status === 'blocked'
                    ? freeze.blockers
                    : [
                        {
                          kind: 'publication',
                          reason: wasClosed ? 'frozen' : 'pending-publication',
                          reference: { workspaceId: input.workspaceId },
                          actions: [],
                        },
                      ],
              },
            }
          );
        let releaseHold: (() => void) | undefined;
        try {
          try {
            if (!hold) refuseRecovery('recovery-required');
            releaseHold = await hold;
            owned.currentAuthority();
            const blockers = inspect();
            if (blockers.length)
              throw new OperationError(
                'workspace_blocked',
                'Workspace restore is not admitted.',
                409,
                {
                  details: {
                    workspaceId: input.workspaceId,
                    operation: 'restore',
                    retryable: false,
                    blockers,
                  },
                }
              );
          } finally {
            // Native lifecycle posts must not wait on the hold owned by this same operation.
            releaseHold?.();
          }
          const owner = {
            core: owned.coreDb,
            fileAdmission: owned.verification.admission,
            native: { gate: owned.mutationAdmission, freeze },
            currentAuthority: owned.currentAuthority,
            actor: publicOperationActor(context),
          };
          await admitWorkspaceBackupAtCore(owner, target);
          owned.currentAuthority();
          const report = activateWorkspaceRecoveryAtCore(owner, {
            requestId: input.requestId,
            store: owned.store,
            runtimeConfigManager: manager,
            currentAuthority: owned.currentAuthority,
          });
          return WorkspaceSnapshotReportSchema.parse(report);
        } catch (error) {
          const current = readRecoveryAdmission(owned.coreDb, input.requestId);
          if (
            current &&
            current.workspace_id === input.workspaceId &&
            current.state !== 'abandoned'
          ) {
            refuseScope(owned.dataRoot, {
              scope: 'workspace',
              id: input.workspaceId,
              check: 'recovery',
            });
            owned.mutationAdmission.restoreRecoveryClosed(input.workspaceId, {
              admissionId: current.admission_id,
              revision: current.revision - (current.state === 'finished' ? 1 : 0),
              candidateRef: current.candidate_ref,
            });
          }
          throw error;
        } finally {
          freeze.release();
        }
      }),
  };
}
