import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { WORKSPACE_RESOURCE_POLICY_FEATURE } from '@openkit/config-schema';
import {
  allocateEntityId,
  PROTOCOL_VERSION,
  SEALED_TURN_TERMINALS,
  writeRetainedV1,
} from '@openkit/protocol';
import Database from 'better-sqlite3';
import { recordWorkspaceAuditEvent } from '../audit-events.js';
import { recoverRunningCapabilityCalls } from '../capability/usage-ledger.js';
import {
  publishWorkspaceResourceCatalog,
  readWorkspaceResourceCatalog,
} from '../catalog/resource-catalog.js';
import { parseJsoncObject } from '../config/jsonc.js';
import { AutomationStore } from '../lib/automation-store.js';
import { commandInputHash } from '../runtime/idempotent-command.js';
import {
  applyPendingCloseout,
  listThreadPendingRequests,
  renderPendingOutcomeItems,
} from '../runtime/pending-requests.js';
import { workerTurnTerminalPublication } from '../runtime/worker-turn-failure.js';
import { cancelSchedulerAdmissionEntry } from '../scheduler-records.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import { FileStorageAdmission } from './artifacts/file-admission.js';
import type { ControlProductEntry } from './control-store-products.js';
import { getControlStoreWorkerClient } from './control-store-worker-client.js';
import type { ControlSqlStatement } from './control-store-worker-protocol.js';
import { inventoryRegularFiles } from './data-root-backup.js';
import { bindWorkspaceSqlite, type CoreDb } from './db.js';
import { readDataRootLayoutMarker, workspaceDbPath } from './fs-layout.js';
import { prepareRetainedProductJson } from './immutable-content.js';
import {
  RECURRING_PORTABLE_PATHS,
  readRecurringPortableFiles,
} from './recurring-portable-history.js';
import {
  readWorkspaceBackupManifest,
  stageWorkspaceBackup,
  WORKSPACE_BACKUP_POLICY,
} from './workspace-backup.js';
import {
  WORKSPACE_BACKUP_MANIFEST_FILE,
  type WorkspaceBackupManifest,
} from './workspace-backup-bundle.js';
import { completeCapture } from './workspace-capture-protection.js';
import {
  assertCanonicalDirectory,
  ensureCanonicalDirectory,
  loadWorkspaceFileRecords,
  nativeProductScope,
  syncCanonicalDirectory,
  syncCanonicalTree,
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

/** Binds only canonical target bytes; the retained source manifest and evidence remain unchanged. */
function candidateDigest(root: string): string {
  return createHash('sha256')
    .update(JSON.stringify(inventoryRegularFiles(root)))
    .digest('hex');
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
    await bindTargetCandidate(core, owned, map);
    syncCanonicalTree(candidate);
    const proof = { ...owned.proof, candidateDigest: candidateDigest(candidate) };
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
): Promise<void> {
  const input = owned.proof.input as TargetArgs;
  const root = owned.candidate_ref;
  const dataRoot = dirname(dirname(root));
  const workspaceId = owned.workspace_id;
  const manifest = owned.proof.manifest;
  const now = new Date().toISOString();
  const sqlite = openRecoveryDatabase(join(root, 'db/workspace.sqlite'));
  const db = bindWorkspaceSqlite(sqlite, dataRoot, workspaceId);
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
      let current: Database.Database | undefined;
      let currentSafetyRead = false;
      try {
        current = new Database(workspaceDbPath(core.dataRoot, workspaceId), {
          readonly: true,
          fileMustExist: true,
        });
        if (current.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error();
        if (
          current
            .prepare(
              "SELECT json_extract(record_json,'$.movedOut') FROM control_workspaces WHERE id=?"
            )
            .pluck()
            .get(workspaceId)
        )
          refuseRecovery('workspace-moved-out');
        const rows = current.prepare('SELECT * FROM evidence_bundles').all() as Record<
          string,
          unknown
        >[];
        currentSafetyRead = true;
        sqlite
          .transaction(() => {
            sqlite.prepare('DELETE FROM evidence_bundles').run();
            for (const row of rows) {
              const columns = Object.keys(row);
              sqlite
                .prepare(
                  `INSERT INTO evidence_bundles (${columns.map((key) => `"${key}"`).join(',')}) VALUES (${columns.map(() => '?').join(',')})`
                )
                .run(...Object.values(row));
            }
          })
          .immediate();
        writeFileSync(
          join(root, 'config/workspace.jsonc'),
          readFileSync(join(core.dataRoot, 'workspaces', workspaceId, 'config/workspace.jsonc'))
        );
        mkdirSync(join(root, 'catalog'), { recursive: true });
        writeFileSync(
          join(root, 'catalog/catalog.json'),
          JSON.stringify(readWorkspaceResourceCatalog(core.dataRoot, workspaceId))
        );
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'workspace-moved-out')
          throw error;
        if (currentSafetyRead) throw error;
        if (!input.acknowledgeLostSafety) refuseRecovery('safety-unproved');
        restricted = {
          backupId: manifest.backupId,
          captureStartedAt: manifest.capture.startedAt,
          lossDetectedAt: now,
        };
      } finally {
        current?.close();
      }
    }
    const records = loadWorkspaceFileRecords(dataRoot).find(
      (record) => record.workspace.id === workspaceId
    );
    if (!records) refuseRecovery('invalid-database');
    if (manifest.requiredFeatures.includes('workspace.recurring-triggers.v1')) {
      const history = readRecurringPortableFiles(
        new Map(
          Object.values(RECURRING_PORTABLE_PATHS).map((path) => [
            path,
            readFileSync(join(root, path), 'utf8'),
          ])
        ),
        {
          workspaceId,
          threadIds: new Set(records.threads.map((thread) => thread.id)),
          turns: new Map(records.turns.map((turn) => [turn.id, turn.threadId])),
        }
      );
      mkdirSync(join(root, 'imports'), { recursive: true, mode: 0o700 });
      writeFileSync(join(root, 'imports/recurrence-history.json'), JSON.stringify(history), {
        mode: 0o600,
      });
      for (const path of Object.values(RECURRING_PORTABLE_PATHS)) unlinkSync(join(root, path));
    }
    if (input.command === 'move-in' || restricted) {
      const configPath = join(root, 'config/workspace.jsonc');
      const config = parseJsoncObject(readFileSync(configPath, 'utf8')) as {
        workspace: { policy?: { mediation?: unknown } };
        requiredFeatures?: string[];
      };
      config.requiredFeatures = [
        ...new Set([...(config.requiredFeatures ?? []), WORKSPACE_RESOURCE_POLICY_FEATURE]),
      ];
      // Source Policy grants do not become target grants. Unmapped private audiences receive no allow.
      const pairs = new Map(
        map?.accountMap.memberMappings.map((pair) => [
          pair.sourceAccountId,
          pair.targetAccountId,
        ]) ?? []
      );
      const unavailable =
        input.command === 'move-in'
          ? records.threads.filter(
              (thread) => thread.visibility === 'private' && !pairs.has(thread.privateOwnerUserId!)
            )
          : records.threads;
      const author = input.command === 'move-in' ? input.targetOwnerId : manifest.accounts.ownerId;
      const anchor = {
        owner: { kind: 'workspace', workspaceId },
        kind: 'workspace',
        id: workspaceId,
      };
      config.workspace.policy = {
        mediation: {
          schemaVersion: 1,
          statements: unavailable.map((thread) => ({
            id: `recovery-${thread.id}`,
            kind: 'managed-boundary',
            state: 'active',
            author: { kind: 'human', id: author },
            authority: { kind: 'human', userId: author },
            authoredAt: now,
            lifetime: { anchor },
            scope: {
              subjects: [],
              actions: [],
              resources: [
                {
                  kind: 'container',
                  container: { ...anchor, kind: 'thread', id: thread.id },
                },
              ],
            },
          })),
        },
      };
      writeFileSync(configPath, JSON.stringify(config));
      const catalog = readWorkspaceResourceCatalog(dataRoot, workspaceId);
      publishWorkspaceResourceCatalog({
        dataRoot,
        workspaceId,
        expectedRevision: catalog.revision,
        catalog: {
          ...catalog,
          mcp: {
            ...catalog.mcp,
            bindings: catalog.mcp.bindings.map((binding) => ({
              ...binding,
              enabled: false,
              credentialBindings: [],
            })),
          },
          plugins: { ...catalog.plugins, installations: [] },
          skills: { ...catalog.skills, pins: [] },
        },
      });
      const statements: ControlSqlStatement[] = [];
      for (const thread of records.threads) {
        const target = pairs.get(thread.privateOwnerUserId!);
        if (target)
          statements.push({
            mode: 'run',
            sql: "UPDATE control_threads SET revision=revision+1,record_json=json_set(record_json,'$.privateOwnerUserId',?) WHERE id=?",
            parameters: [target, thread.id],
          });
      }
      if (statements.length) await client.write(database, statements);
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
    recoverRunningCapabilityCalls({ workspaceDb: db });
    const captures = sqlite
      .prepare("SELECT capture_id FROM workspace_capture_records WHERE state='active'")
      .pluck()
      .all() as string[];
    for (const capture of captures) completeCapture(db, workspaceId, capture);
    recordWorkspaceAuditEvent({
      workspaceDb: db,
      workspaceId,
      action: input.command === 'restore' ? 'workspace.restore' : 'workspace.move-in',
      resource: `workspace:${workspaceId}`,
      outcome: 'succeeded',
      summary: JSON.stringify({
        backupId: manifest.backupId,
        manifestDigest: owned.proof.capture.manifestDigest,
        restrictedRecovery: restricted,
      }),
    });
    await interruptImportedHistory(db, root, records);
    owned.proof.result = { ...owned.proof.result, restrictedRecovery: restricted };
  } finally {
    try {
      if (opened) await client.close(database);
    } finally {
      sqlite.close();
    }
  }
}

/** Prepares interrupted history on the caller-admitted private candidate; shared Store preparation remains pending. */
async function interruptImportedHistory(
  db: ReturnType<typeof bindWorkspaceSqlite>,
  root: string,
  records: NonNullable<ReturnType<typeof loadWorkspaceFileRecords>[number]>
): Promise<void> {
  const client = getControlStoreWorkerClient();
  const {
    owner,
    path,
    contentMount: mount,
  } = nativeProductScope(db.dataRoot, { kind: 'workspace', workspaceId: db.workspaceId }, root);
  const database = `workspace:${path}`;
  // Captured execution is historical: publish interruption, never infer physical cleanup or replay.
  for (const before of records.turns.filter((turn) => !SEALED_TURN_TERMINALS[turn.status])) {
    const now = new Date().toISOString();
    const turn = {
      ...before,
      status: 'interrupted' as const,
      completedAt: now,
      error: {
        code: 'workspace_recovered',
        message: 'Captured work was interrupted by offline recovery.',
      },
    };
    const sequence = Number(
      db.sqlite
        .prepare(
          "SELECT COALESCE(MAX(sequence),0)+1 FROM control_product_entries WHERE kind='event' AND turn_id=?"
        )
        .pluck()
        .get(before.id)
    );
    const governed = db.sqlite
      .prepare('SELECT 1 FROM control_executions WHERE work_id=?')
      .get(before.id)
      ? await workerTurnTerminalPublication(db, before.id, 'interrupted')
      : undefined;
    await client.terminal(database, {
      owner,
      turn: {
        kind: 'turn',
        expectedRevision: Number(
          db.sqlite.prepare('SELECT revision FROM control_turns WHERE id=?').pluck().get(before.id)
        ),
        record: writeRetainedV1({
          ...turn,
          items: [],
          captureCoverage: records.turnCaptureCoverage?.get(before.id),
        }),
      },
      products: [],
      entries: [
        {
          kind: 'event',
          turnId: before.id,
          sequence,
          expectedRevision: 0,
          ...(await prepareRetainedProductJson(
            mount,
            owner,
            join(root, 'runtime/staging'),
            writeRetainedV1({
              protocolVersion: PROTOCOL_VERSION,
              workspaceId: db.workspaceId,
              threadId: before.threadId,
              turnId: before.id,
              requestId: null,
              timestamp: now,
              sequence,
              event: 'turn.completed',
              data: { type: 'turn-completed', stopReason: 'aborted', turn },
            })
          )),
        },
      ],
      reap: { reason: 'offline Workspace recovery', inferredBy: 'workspace-recovery' },
      evidence: governed?.evidence ?? [],
      evidenceContent: [],
      command: null,
      execution: governed?.execution ?? null,
    });
  }
  for (const thread of records.threads) {
    const pending = () => listThreadPendingRequests(db.sqlite, db.workspaceId, thread.id);
    const sources = () =>
      pending().map((record) => ({
        requestId: record.requestId,
        sourceHash: commandInputHash(record),
      }));
    await client.pendingCommand(database, {
      input: {
        action: 'settle-unfinished',
        workspaceId: db.workspaceId,
        now: new Date().toISOString(),
        expected: sources(),
      },
      products: [],
      entries: [],
      receipt: null,
    });
    for (const turnId of new Set(
      pending()
        .filter((record) => record.delivery === 'frozen')
        .map((record) => record.deliveryTurnId!)
    ))
      await client.pendingCommand(database, {
        input: {
          action: 'delivery-unknown',
          workspaceId: db.workspaceId,
          turnId,
          now: new Date().toISOString(),
          expected: sources(),
        },
        products: [],
        entries: [],
        receipt: null,
      });
    for (const record of pending().filter(
      (request) => request.state === 'pending' || request.delivery === 'undelivered'
    )) {
      const now = new Date().toISOString();
      const turnId = allocateEntityId('tu');
      const command = {
        action: 'closeout' as const,
        workspaceId: db.workspaceId,
        threadId: thread.id,
        closeoutTurnId: turnId,
        actor: { kind: 'system' as const, id: 'workspace-recovery' },
        now,
        expected: [{ requestId: record.requestId, sourceHash: commandInputHash(record) }],
        expectedThreadCensus: pending().map((request) => request.requestId),
        invalidatingEvents: [{ requestId: record.requestId, event: 'workspace-recovered' }],
      };
      let items: ReturnType<typeof renderPendingOutcomeItems>;
      db.sqlite.exec('SAVEPOINT recovery_projection');
      try {
        items = renderPendingOutcomeItems(
          applyPendingCloseout(db.sqlite, {
            ...command,
            usable: (request) => request.requestId === record.requestId,
            invalidatingEvent: () => 'workspace-recovered',
          }),
          turnId,
          now
        );
      } finally {
        db.sqlite.exec('ROLLBACK TO recovery_projection');
        db.sqlite.exec('RELEASE recovery_projection');
      }
      const turn = {
        id: turnId,
        owner,
        threadId: thread.id,
        triggerActor: {
          kind: 'system' as const,
          id: 'workspace-recovery',
          responsibleUserId: null,
        },
        triggerSource: { kind: 'system-input' as const, summary: 'Offline recovery closeout' },
        agentId: null,
        agentSessionId: null,
        configVersion: null,
        items,
        status: 'completed' as const,
        startedAt: now,
        completedAt: now,
        durationMs: 0,
        error: null,
      };
      const entries: ControlProductEntry[] = [];
      for (const item of items)
        entries.push({
          kind: 'item',
          turnId,
          sequence: entries.length + 1,
          expectedRevision: 0,
          ...(await prepareRetainedProductJson(
            mount,
            owner,
            join(root, 'runtime/staging'),
            writeRetainedV1(item)
          )),
        });
      const sequence = 1;
      entries.push({
        kind: 'event',
        turnId,
        sequence,
        expectedRevision: 0,
        ...(await prepareRetainedProductJson(
          mount,
          owner,
          join(root, 'runtime/staging'),
          writeRetainedV1({
            protocolVersion: PROTOCOL_VERSION,
            workspaceId: db.workspaceId,
            threadId: thread.id,
            turnId,
            requestId: null,
            timestamp: now,
            sequence,
            event: 'turn.completed',
            data: { type: 'turn-completed', stopReason: 'completed', turn },
          })
        )),
      });
      await client.terminal(database, {
        owner,
        turn: {
          kind: 'turn',
          expectedRevision: 0,
          record: writeRetainedV1({
            ...turn,
            items: [],
            captureCoverage: { scope: 'workspace', value: 'off' },
          }),
        },
        products: [],
        entries,
        pending: [command],
        reap: { reason: 'offline Workspace recovery', inferredBy: 'workspace-recovery' },
        evidence: [],
        evidenceContent: [],
        command: null,
        execution: null,
      });
    }
  }
}
