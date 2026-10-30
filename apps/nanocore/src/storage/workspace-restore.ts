import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { AutomationStore } from '../lib/automation-store.js';
import { cancelSchedulerAdmissionEntry } from '../scheduler-records.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import { FileStorageAdmission } from './artifacts/file-admission.js';
import { getControlStoreWorkerClient } from './control-store-worker-client.js';
import { workspaceRecoveryCandidateDigest as candidateDigest } from './data-root-backup.js';
import type { CoreDb } from './db.js';
import { readDataRootLayoutMarker } from './fs-layout.js';
import { RECURRING_PORTABLE_PATHS } from './recurring-portable-history.js';
import {
  readWorkspaceBackupManifest,
  stageWorkspaceBackup,
  WORKSPACE_BACKUP_POLICY,
} from './workspace-backup.js';
import {
  WORKSPACE_BACKUP_MANIFEST_FILE,
  type WorkspaceBackupManifest,
} from './workspace-backup-bundle.js';
import {
  assertCanonicalDirectory,
  ensureCanonicalDirectory,
  nativeProductScope,
  syncCanonicalDirectory,
} from './workspace-file-records.js';
import {
  selectRecoveryAdmission,
  type WorkspaceRecoveryDependencies,
  type WorkspaceRecoverySelectedInput,
} from './workspace-move.js';
import { validateWorkspaceMoveMapping } from './workspace-move-mapping.js';
import {
  endRecoveryAdmission,
  openRecoveryDatabase,
  prepareRecoveryAdmission,
  type RecoveryAdmission,
  readRecoveryAdmission,
  recoveryReport,
  refuseRecovery,
  withRecoveryRoot,
  workspaceRecoveryPredecessorRoot,
} from './workspace-recovery-admissions.js';
import type {
  WorkspaceRecoveryCliArgs,
  WorkspaceRecoveryCliReport,
} from './workspace-recovery-cli.js';

type TargetArgs = Extract<WorkspaceRecoveryCliArgs, { command: 'restore' | 'move-in' }>;
export type WorkspaceTargetRecoveryInput = TargetArgs & {
  readonly expectedRelease: WorkspaceBackupManifest['release'];
};

/** Request identity excludes the movable bundle pathname and orders only the explicit account map. */
function requestIdentity(input: TargetArgs) {
  return input.command === 'restore'
    ? [input.command, input.workspaceId, input.acknowledgeLostSafety]
    : [
        input.command,
        input.targetOwnerId,
        [...input.memberMappings].sort(
          (a, b) =>
            a.sourceAccountId.localeCompare(b.sourceAccountId) ||
            a.targetAccountId.localeCompare(b.targetAccountId)
        ),
      ];
}
/** Rechecks current mapping before any unpublished target effect; no source account implies a grant. */
function mapping(core: CoreDb, input: TargetArgs, owned: RecoveryAdmission) {
  if (input.command === 'restore') return undefined;
  const report = validateWorkspaceMoveMapping({
    manifest: owned.proof.manifest,
    manifestDigest: owned.proof.capture.manifestDigest,
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
/** Publishes a proved candidate before one Core registration/result transaction; failure retains ownership. */
async function finishTarget(
  core: CoreDb,
  owned: RecoveryAdmission,
  deps: WorkspaceRecoveryDependencies,
  expectedRelease?: WorkspaceBackupManifest['release']
): Promise<WorkspaceRecoveryCliReport> {
  const input = owned.proof.input as TargetArgs;
  if (!['restore', 'move-in'].includes(input.command)) refuseRecovery('request-conflict');
  if (owned.state === 'abandoned') refuseRecovery('request-conflict');
  if (owned.state === 'finished') return owned.proof.result;
  if (expectedRelease && !isDeepStrictEqual(expectedRelease, owned.proof.manifest.release))
    refuseRecovery('release-mismatch');
  const map = mapping(core, input, owned);
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
  const report: WorkspaceRecoveryCliReport = {
    ...owned.proof.result,
    disposition: input.command === 'restore' ? 'restored' : 'imported',
    droppedSourceMemberIds: map?.droppedSourceMemberIds ?? [],
    nextAction: 'none',
  };
  core.sqlite
    .transaction(() => {
      if (input.command === 'move-in') {
        if (
          core.sqlite
            .prepare('SELECT 1 FROM workspace_registry WHERE workspace_id=?')
            .get(workspaceId)
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
        const schedules = new AutomationStore(core, new WorkspaceMutationAdmission());
        const rows = core.sqlite
          .prepare(
            "SELECT id, revision FROM recurring_schedules WHERE workspace_id=? AND status='active'"
          )
          .all(workspaceId) as { id: string; revision: number }[];
        for (const row of rows)
          schedules.updateAutomation(owned.proof.manifest.accounts.ownerId, row.id, {
            expectedRevision: row.revision,
            status: 'paused',
          });
        const queued = core.sqlite
          .prepare(
            "SELECT queue_entry_id FROM scheduler_admission_entries WHERE workspace_id=? AND status IN ('queued','denied')"
          )
          .all(workspaceId) as { queue_entry_id: string }[];
        for (const row of queued)
          cancelSchedulerAdmissionEntry(core, { workspaceId, queueEntryId: row.queue_entry_id });
      }
      endRecoveryAdmission(core, owned.admission_id, 'finished', report);
      deps.atBoundary?.('before-registration-commit');
    })
    .immediate();
  deps.atBoundary?.('after-registration-commit');
  return report;
}

/** Restores one existing same-deployment Workspace, or admits one identity-preserving MOVE privately. */
export async function admitWorkspaceBackup(
  input: WorkspaceTargetRecoveryInput,
  deps: WorkspaceRecoveryDependencies = {}
): Promise<WorkspaceRecoveryCliReport> {
  return withRecoveryRoot(input.dataRoot, async (core) => {
    const previous = readRecoveryAdmission(core, input.requestId);
    if (previous) {
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
      return finishTarget(core, previous, deps, input.expectedRelease);
    }
    const manifest = readWorkspaceBackupManifest(input.bundleRoot);
    const workspaceId = manifest.workspaceId;
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
    // Unpublished databases stay outside the boot layout, owned by this root-locked admission.
    const container = `${resolve(input.dataRoot)}.workspace-recovery-${input.requestId}`;
    const candidate = join(container, 'workspaces', workspaceId);
    mkdirSync(dirname(candidate), { recursive: true, mode: 0o700 });
    const staged = await stageWorkspaceBackup({
      ...WORKSPACE_BACKUP_POLICY,
      bundleRoot: input.bundleRoot,
      stagingParent: container,
      admission: new FileStorageAdmission(input.dataRoot, () => 1_000_000_000n),
      expectedRelease: input.expectedRelease,
      candidateRoot: candidate,
      expectedWorkspaceId: workspaceId,
      expectedSourceDeploymentId: manifest.sourceDeploymentId,
      purpose: input.command === 'restore' ? 'backup' : 'move',
    });
    const result = recoveryReport(input.command, 'quarantined', staged.report);
    prepareRecoveryAdmission(core, input.requestId, candidate, {
      input,
      manifest: staged.manifest,
      capture: staged.report,
      result,
    });
    const owned = readRecoveryAdmission(core, input.requestId)!;
    const map = mapping(core, input, owned);
    const digest = await bindTargetCandidate(core, owned, map);
    const proof = { ...owned.proof, candidateDigest: digest };
    core.sqlite
      .prepare('UPDATE workspace_recovery_admissions SET proof_json=? WHERE admission_id=?')
      .run(JSON.stringify(proof), input.requestId);
    return finishTarget(core, { ...owned, proof }, deps);
  });
}
/** Finishes only the retained owned target; no bundle, account, or final directory discovers ownership. */
export async function finishWorkspaceRecovery(
  input: WorkspaceRecoverySelectedInput,
  deps: WorkspaceRecoveryDependencies = {}
): Promise<WorkspaceRecoveryCliReport> {
  return withRecoveryRoot(input.dataRoot, async (core) => {
    if (input.selection.kind !== 'admission') refuseRecovery('request-conflict');
    const owned = selectRecoveryAdmission(core, input);
    return {
      ...(await finishTarget(core, owned, deps, input.expectedRelease)),
      command: 'finish',
      selection: input.selection,
    };
  });
}
/** Closes finish rights before retiring owned unpublished bytes; retained holds are never deleted. */
export async function abandonWorkspaceRecovery(
  input: WorkspaceRecoverySelectedInput
): Promise<WorkspaceRecoveryCliReport> {
  return withRecoveryRoot(input.dataRoot, async (core) => {
    if (input.selection.kind !== 'admission') refuseRecovery('request-conflict');
    const owned = selectRecoveryAdmission(core, input);
    if (owned.state === 'finished') refuseRecovery('request-conflict');
    if (owned.state === 'abandoned' && owned.proof.result.disposition === 'abandoned')
      return owned.proof.result;
    endRecoveryAdmission(core, owned.admission_id, 'abandoned');
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
    endRecoveryAdmission(core, owned.admission_id, 'abandoned', report);
    return report;
  });
}

/** Applies current safety and target bindings only to privately owned, already verified bytes. */
async function bindTargetCandidate(
  core: CoreDb,
  owned: RecoveryAdmission,
  map: ReturnType<typeof mapping>
): Promise<string> {
  const input = owned.proof.input as TargetArgs;
  const root = owned.candidate_ref;
  const dataRoot = dirname(dirname(root));
  const workspaceId = owned.workspace_id;
  const manifest = owned.proof.manifest;
  const now = new Date().toISOString();
  const client = getControlStoreWorkerClient();
  const {
    owner,
    path,
    contentMount: mount,
  } = nativeProductScope(dataRoot, { kind: 'workspace', workspaceId }, root);
  const database = `workspace:${path}`;
  let opened = false;
  let restricted: WorkspaceRecoveryCliReport['restrictedRecovery'] = false;
  try {
    // The root-locked admission owns this unpublished candidate through native close.
    mkdirSync(mount.root, { recursive: true, mode: 0o700 });
    mkdirSync(join(root, 'runtime'), { recursive: true, mode: 0o700 });
    await client.open({
      database,
      path,
      dataRoot,
      create: false,
      initialize: 'workspace',
      productOwner: owner,
      contentMount: mount,
    });
    opened = true;
    if (input.command === 'restore') {
      const safety = await client.recoverySafety(database, {
        workspaceId,
        sourceDataRoot: resolve(core.dataRoot),
      });
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
    await client.write(database, [
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
    ]);
    await client.recoveryCleanup(database, {
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
    });
    if (manifest.requiredFeatures.includes('workspace.recurring-triggers.v1')) {
      // The root-locked coordinator retires transfer inputs only after durable native preparation.
      for (const path of Object.values(RECURRING_PORTABLE_PATHS)) unlinkSync(join(root, path));
    }
    while (!(await client.recoveryHistory(database, workspaceId))) {
      // Each acknowledged request advances one existing history unit; this is not a retry.
    }
    owned.proof.result = { ...owned.proof.result, restrictedRecovery: restricted };
    const digest = await client.sealRecovery(database);
    opened = false; // The reply proves close even when the subsequent byte seal was unavailable.
    if (digest === null) refuseRecovery('recovery-required');
    return digest;
  } finally {
    if (opened) await client.close(database);
  }
}
