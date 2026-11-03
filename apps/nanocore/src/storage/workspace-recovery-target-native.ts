import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { assertCanonicalDirectory, readCanonicalFile } from '@openkit/storage';
import { recordServerAuditEvent } from '../audit-events.js';
import {
  DeploymentAdminRequiredError,
  evaluateProductAuthorization,
  requireAdministratorOperation,
} from '../auth/operation-authorizer.js';
import { OperationError } from '../operation-error.js';
import { cancelSchedulerAdmissionEntry } from '../scheduler-records.js';
import {
  getWorkspaceRegistryLifecycleFact,
  recoverDeletedWorkspaceRegistry,
} from '../workspace-sharing.js';
import { accessDenied } from '../workspace-sharing-operations.js';
import { applyAutomationDefinitionInDb } from './automation-definition-native.js';
import { commandInputHash, presentControlFacts } from './control-store-input.js';
import { ControlProductPreconditionError } from './control-store-product-records.js';
import { assertControlProductWriter } from './control-store-products.js';
import type { CoreDb } from './db.js';
import { readDataRootLayoutMarker } from './fs-layout.js';
import { WorkspaceRecoveryError } from './workspace-backup.js';
import {
  WORKSPACE_BACKUP_MAX_FILE_BYTES,
  type WorkspaceBackupManifest,
} from './workspace-backup-bundle.js';
import { validateWorkspaceMoveMapping } from './workspace-move-mapping.js';
import { recordWorkspaceOwnerMembership } from './workspace-owner-records.js';
import {
  endRecoveryAdmission,
  prepareRecoveryAdmission,
  type RecoveryProof,
  readRecoveryAdmission,
  refuseRecovery,
  validateRecoveryProof,
} from './workspace-recovery-admissions.js';
import type {
  WorkspaceRecoveryCliArgs,
  WorkspaceRecoveryCliReport,
} from './workspace-recovery-cli.js';
import {
  type ControlRecoveryTargetPreparationInput,
  ControlRecoveryTargetPreparationInputSchema,
  type ControlRecoveryTargetRegistrationInput,
  ControlRecoveryTargetRegistrationInputSchema,
  ControlRecoveryTargetRegistrationResultSchema,
} from './workspace-recovery-target-codecs.js';

/** Applies the whole original Core target registration/result tuple in its existing savepoint and FULL commit. */
export function applyControlRecoveryTargetRegistration(
  core: CoreDb,
  raw: ControlRecoveryTargetRegistrationInput
): WorkspaceRecoveryCliReport {
  assertControlProductWriter(core.sqlite);
  if (core.scope !== 'core') throw new ControlProductPreconditionError();
  const value = ControlRecoveryTargetRegistrationInputSchema.parse(raw);
  const owned = readRecoveryAdmission(core, value.admissionId);
  if (
    !owned ||
    owned.workspace_id !== value.workspaceId ||
    owned.revision !== value.expectedRevision ||
    owned.state !== 'prepared' ||
    commandInputHash(owned.proof) !== value.proofHash ||
    !owned.proof.candidateDigest
  )
    refuseRecovery('recovery-required');
  const input = owned.proof.input;
  if (input.command !== 'restore' && input.command !== 'move-in')
    refuseRecovery('request-conflict');
  const workspaceId = owned.workspace_id;
  if (
    getWorkspaceRegistryLifecycleFact(core, workspaceId)?.status === 'deleted' &&
    !value.deletedRecovery
  )
    refuseRecovery('recovery-required');
  assertTargetAuthority(core, value);
  const map = validateRecoveryTargetMapping(
    core,
    input,
    owned.proof.manifest,
    owned.proof.capture.manifestDigest
  );
  let report: WorkspaceRecoveryCliReport = {
    ...owned.proof.result,
    disposition: input.command === 'restore' ? 'restored' : 'imported',
    droppedSourceMemberIds: map?.droppedSourceMemberIds ?? [],
    nextAction: 'none',
  };
  if (input.command === 'move-in') {
    if (
      core.sqlite.prepare('SELECT 1 FROM workspace_registry WHERE workspace_id=?').get(workspaceId)
    )
      refuseRecovery('identity-collision');
    recordWorkspaceOwnerMembership({
      coreDb: core,
      workspaceId,
      ownerUserId: input.targetOwnerId,
    });
    const now = new Date().toISOString();
    for (const userId of new Set(
      map!.accountMap.memberMappings.map((pair) => pair.targetAccountId)
    )) {
      if (userId === input.targetOwnerId) continue;
      core.sqlite
        .prepare(
          "INSERT INTO workspace_members (workspace_id,user_id,status,invitation_id,joined_at,removed_at,revision,created_at,updated_at) VALUES (?,?,'active',NULL,?,NULL,1,?,?)"
        )
        .run(workspaceId, userId, now, now, now);
    }
  } else {
    const rows = core.sqlite
      .prepare(
        "SELECT id, revision FROM recurring_schedules WHERE workspace_id=? AND status='active'"
      )
      .all(workspaceId) as { id: string; revision: number }[];
    for (const row of rows)
      applyAutomationDefinitionInDb(
        core,
        owned.proof.manifest.accounts.ownerId,
        {
          action: 'update',
          id: row.id,
          input: { expectedRevision: row.revision, status: 'paused' },
        },
        new Date().toISOString()
      );
    const queued = core.sqlite
      .prepare(
        "SELECT queue_entry_id FROM scheduler_admission_entries WHERE workspace_id=? AND status IN ('queued','denied')"
      )
      .all(workspaceId) as { queue_entry_id: string }[];
    for (const row of queued)
      cancelSchedulerAdmissionEntry(core, { workspaceId, queueEntryId: row.queue_entry_id });
  }
  if (value.deletedRecovery) {
    const { deletion, actorId } = value.deletedRecovery;
    if (
      input.command !== 'restore' ||
      deletion.workspaceId !== workspaceId ||
      deletion.recoveryBackupId !== owned.backup_id ||
      deletion.recoveryBackupManifestDigest !== owned.proof.capture.manifestDigest ||
      deletion.originalOwnerUserId !== owned.proof.manifest.accounts.ownerId
    )
      refuseRecovery('request-conflict');
    const registry = recoverDeletedWorkspaceRegistry({
      coreDb: core,
      workspaceId,
      originalOwnerUserId: deletion.originalOwnerUserId,
      expectedRegistryRevision: deletion.expectedRegistryRevision + 2,
    });
    report = {
      ...report,
      currentRevision: registry.registryRevision,
      selection: { kind: 'admission', requestId: owned.admission_id },
    };
    recordServerAuditEvent({
      action: 'workspace.deleted-recover',
      actor: { kind: 'user', id: actorId },
      category: 'command',
      coreDb: core,
      outcome: 'succeeded',
      requestId: owned.admission_id,
      resource: `workspace:${workspaceId}`,
      resourceRevision: registry.registryRevision,
      summary: 'Original deleted Workspace restored from its final fenced backup.',
      workspaceId,
    });
  }
  if (!ControlRecoveryTargetRegistrationResultSchema.safeParse(report).success)
    refuseRecovery('recovery-required');
  endRecoveryAdmission(core, owned.admission_id, 'finished', report);
  return report;
}

/** Rechecks current mapping before any unpublished target effect; no source account implies a grant. */
export function validateRecoveryTargetMapping(
  core: CoreDb,
  input: Extract<WorkspaceRecoveryCliArgs, { command: 'restore' | 'move-in' }>,
  manifest: WorkspaceBackupManifest,
  manifestDigest: string
): Extract<ReturnType<typeof validateWorkspaceMoveMapping>, { disposition: 'ready' }> | undefined {
  if (input.command === 'restore') return undefined;
  const report = validateWorkspaceMoveMapping({
    manifest,
    manifestDigest,
    importingAdministratorId: input.targetOwnerId,
    targetOwnerId: input.targetOwnerId,
    memberMappings: input.memberMappings,
    targetAccounts: core.sqlite.prepare('SELECT id AS accountId, status FROM users').all() as {
      accountId: string;
      status: 'active' | 'disabled';
    }[],
  });
  if (report.disposition !== 'ready') refuseRecovery('mapping-refused');
  return report;
}

/** Reuses current native Core authority for each original target lifecycle effect. */
function assertTargetAuthority(
  core: CoreDb,
  value: Pick<
    ControlRecoveryTargetRegistrationInput,
    'workspaceId' | 'authority' | 'deletedRecovery'
  >
): void {
  const workspaceId = value.workspaceId;
  if (value.authority.mode === 'live') {
    const actor = presentControlFacts(value.authority.actor);
    if (value.deletedRecovery) {
      if (
        value.deletedRecovery.actorId !== actor.userId ||
        evaluateProductAuthorization(
          core,
          actor,
          { kind: 'workspace', workspaceId, deletedRecovery: true },
          'workspace.write',
          true
        ).effect !== 'allow'
      )
        throw accessDenied();
    } else {
      try {
        requireAdministratorOperation(core, actor, 'api.call');
      } catch (error) {
        if (!(error instanceof DeploymentAdminRequiredError)) throw error;
        throw new OperationError(
          'deployment_admin_required',
          'Current deployment administrator authority is required.',
          403
        );
      }
    }
  } else if (value.deletedRecovery) refuseRecovery('request-conflict');
}

/** Reads only the exact immutable proof selected inside this opening's original restore container. */
export function prepareControlRecoveryTargetPreparation(
  core: CoreDb,
  input: ControlRecoveryTargetPreparationInput
): RecoveryProof | undefined {
  if (core.scope !== 'core') throw new ControlProductPreconditionError();
  if (input.kind === 'abandon') return undefined;
  const root = `${resolve(core.dataRoot)}.workspace-recovery-${input.admissionId}`;
  // Retained descriptor paths remain historical after a data-root move; they do not choose the file root.
  const owned =
    input.kind === 'prepare' ? undefined : readRecoveryAdmission(core, input.admissionId);
  if (
    input.kind !== 'prepare' &&
    (!owned ||
      owned.workspace_id !== input.workspaceId ||
      owned.revision !== input.expectedRevision ||
      commandInputHash(owned.proof) !== input.proofHash)
  )
    refuseRecovery('recovery-required');
  const candidate = owned?.candidate_ref ?? join(root, 'workspaces', input.workspaceId);
  try {
    assertCanonicalDirectory(root);
    if (realpathSync(root) !== root || input.file.byteLength > WORKSPACE_BACKUP_MAX_FILE_BYTES)
      refuseRecovery('recovery-required');
    const path = join(root, input.file.name);
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1)
      refuseRecovery('recovery-required');
    const bytes = readCanonicalFile(path, input.file.byteLength);
    if (realpathSync(root) !== root) refuseRecovery('recovery-required');
    if (`sha256:${createHash('sha256').update(bytes).digest('hex')}` !== input.file.digest)
      refuseRecovery('recovery-required');
    const proof = JSON.parse(bytes.toString('utf8')) as RecoveryProof;
    validateRecoveryProof(input.admissionId, candidate, proof);
    if (
      proof.manifest.workspaceId !== input.workspaceId ||
      (proof.input.command !== 'restore' && proof.input.command !== 'move-in')
    )
      refuseRecovery('request-conflict');
    if (
      proof.input.command === 'restore' &&
      proof.manifest.sourceDeploymentId !== readDataRootLayoutMarker(core.dataRoot).deploymentId
    )
      refuseRecovery('deployment-mismatch');
    return proof;
  } catch (error) {
    // Bad private input never authorizes a native effect or exposes a selected path.
    if (error instanceof WorkspaceRecoveryError) throw error;
    return refuseRecovery('recovery-required');
  }
}

/** Compares original facts while allowing only the fields changed by one existing lifecycle stage. */
function equalExcept(left: object, right: object, keys: readonly string[]): boolean {
  const rest = (value: object) =>
    Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
  return isDeepStrictEqual(rest(left), rest(right));
}

/** Applies one whole original Core stage; candidate work and retirement stay outside SQL. */
export function applyControlRecoveryTargetPreparation(
  core: CoreDb,
  raw: ControlRecoveryTargetPreparationInput,
  proof: RecoveryProof | undefined
): void {
  assertControlProductWriter(core.sqlite);
  if (core.scope !== 'core') throw new ControlProductPreconditionError();
  const input = ControlRecoveryTargetPreparationInputSchema.parse(raw);
  assertTargetAuthority(core, input);
  if (input.kind === 'prepare') {
    if (!proof || proof.candidateDigest || proof.result.disposition !== 'quarantined')
      refuseRecovery('recovery-required');
    const workspaceId = input.workspaceId;
    if (
      readRecoveryAdmission(core, input.admissionId) ||
      core.sqlite
        .prepare(
          "SELECT 1 FROM workspace_recovery_admissions WHERE workspace_id=? AND (state='prepared' OR (state='abandoned' AND json_extract(proof_json,'$.result.disposition')!='abandoned'))"
        )
        .get(workspaceId)
    )
      refuseRecovery('recovery-required');
    const lifecycle = getWorkspaceRegistryLifecycleFact(core, workspaceId);
    if (proof.input.command === 'restore') {
      if (
        !lifecycle ||
        (input.deletedRecovery ? lifecycle.status !== 'deleted' : lifecycle.status !== 'active')
      )
        refuseRecovery('workspace-unavailable');
      if (input.deletedRecovery) {
        const deletion = input.deletedRecovery.deletion;
        if (
          deletion.workspaceId !== workspaceId ||
          deletion.recoveryBackupId !== proof.manifest.backupId ||
          deletion.recoveryBackupManifestDigest !== proof.capture.manifestDigest ||
          deletion.originalOwnerUserId !== proof.manifest.accounts.ownerId ||
          lifecycle.registryRevision !== deletion.expectedRegistryRevision + 2
        )
          refuseRecovery('recovery-required');
      }
    } else if (proof.input.command === 'move-in') {
      if (
        lifecycle ||
        core.sqlite
          .prepare(
            "SELECT 1 FROM workspace_recovery_admissions WHERE workspace_id=? AND NOT (state='abandoned' AND json_extract(proof_json,'$.result.disposition')='abandoned')"
          )
          .get(workspaceId)
      )
        refuseRecovery('identity-collision');
      validateRecoveryTargetMapping(
        core,
        proof.input,
        proof.manifest,
        proof.capture.manifestDigest
      );
    } else refuseRecovery('request-conflict');
    const candidate = join(
      `${resolve(core.dataRoot)}.workspace-recovery-${input.admissionId}`,
      'workspaces',
      workspaceId
    );
    prepareRecoveryAdmission(core, input.admissionId, candidate, proof);
    return;
  }
  const owned = readRecoveryAdmission(core, input.admissionId);
  if (
    !owned ||
    owned.workspace_id !== input.workspaceId ||
    owned.revision !== input.expectedRevision ||
    commandInputHash(owned.proof) !== input.proofHash
  )
    refuseRecovery('recovery-required');
  if (owned.proof.input.command !== 'restore' && owned.proof.input.command !== 'move-in')
    refuseRecovery('request-conflict');
  if (input.kind === 'abandon') {
    if (owned.state === 'finished') refuseRecovery('request-conflict');
    endRecoveryAdmission(core, input.admissionId, 'abandoned');
    return;
  }
  if (!proof || !equalExcept(proof, owned.proof, ['candidateDigest', 'result']))
    refuseRecovery('recovery-required');
  if (input.kind === 'proof') {
    if (
      owned.state !== 'prepared' ||
      owned.proof.candidateDigest ||
      !proof.candidateDigest ||
      !equalExcept(proof.result, owned.proof.result, ['restrictedRecovery'])
    )
      refuseRecovery('recovery-required');
    if (
      getWorkspaceRegistryLifecycleFact(core, input.workspaceId)?.status === 'deleted' &&
      !input.deletedRecovery
    )
      refuseRecovery('recovery-required');
    validateRecoveryTargetMapping(
      core,
      proof.input as Extract<WorkspaceRecoveryCliArgs, { command: 'restore' | 'move-in' }>,
      proof.manifest,
      proof.capture.manifestDigest
    );
    ControlRecoveryTargetRegistrationResultSchema.parse(proof.result);
    core.sqlite
      .prepare('UPDATE workspace_recovery_admissions SET proof_json=? WHERE admission_id=?')
      .run(JSON.stringify(proof), input.admissionId);
    return;
  }
  const report = proof.result;
  if (
    owned.state !== 'abandoned' ||
    proof.candidateDigest !== owned.proof.candidateDigest ||
    report.command !== 'abandon' ||
    report.disposition !== 'abandoned' ||
    report.nextAction !== 'none' ||
    report.selection?.kind !== 'admission' ||
    report.selection.requestId !== input.admissionId ||
    !equalExcept(report, owned.proof.result, ['command', 'disposition', 'selection', 'nextAction'])
  )
    refuseRecovery('recovery-required');
  ControlRecoveryTargetRegistrationResultSchema.parse(report);
  endRecoveryAdmission(core, input.admissionId, 'abandoned', report);
}
