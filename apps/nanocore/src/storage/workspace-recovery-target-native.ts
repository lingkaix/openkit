import { recordServerAuditEvent } from '../audit-events.js';
import {
  DeploymentAdminRequiredError,
  evaluateProductAuthorization,
  requireAdministratorOperation,
} from '../auth/operation-authorizer.js';
import { OperationError } from '../operation-error.js';
import { cancelSchedulerAdmissionEntry } from '../scheduler-records.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import {
  getWorkspaceRegistryLifecycleFact,
  recoverDeletedWorkspaceRegistry,
} from '../workspace-sharing.js';
import { accessDenied } from '../workspace-sharing-operations.js';
import { applyAutomationDefinitionInDb } from './automation-definition-native.js';
import { commandInputHash, presentControlFacts } from './control-store-input.js';
import {
  assertControlProductWriter,
  ControlProductPreconditionError,
} from './control-store-products.js';
import type { CoreDb } from './db.js';
import type { WorkspaceBackupManifest } from './workspace-backup-bundle.js';
import { validateWorkspaceMoveMapping } from './workspace-move-mapping.js';
import {
  endRecoveryAdmission,
  readRecoveryAdmission,
  refuseRecovery,
} from './workspace-recovery-admissions.js';
import type {
  WorkspaceRecoveryCliArgs,
  WorkspaceRecoveryCliReport,
} from './workspace-recovery-cli.js';
import {
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
