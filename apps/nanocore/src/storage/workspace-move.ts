import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { isEntityId } from '@openkit/protocol';
import { publishDurableFile, removeDurableFile } from '@openkit/storage';
import { recordWorkspaceAuditEvent } from '../audit-events.js';
import type { WorkspaceFrozenAdmission } from '../workspace-mutation-admission.js';
import { FileStorageAdmission } from './artifacts/file-admission.js';
import { applyControlRecoveryMoveOut } from './control-store-recovery.js';
import { getControlStoreWorkerClient } from './control-store-worker-client.js';
import { bindWorkspaceSqlite, type CoreDb, openWorkspaceReadDb } from './db.js';
import { readDataRootLayoutMarker, workspaceDbPath } from './fs-layout.js';
import {
  assertWorkspaceBackupCut,
  inspectWorkspaceSnapshot,
  readWorkspaceBackupManifest,
  stageWorkspaceBackup,
  WORKSPACE_BACKUP_POLICY,
  type workspaceSnapshotOperationPolicy,
} from './workspace-backup.js';
import { readWorkspaceSnapshotMetadata } from './workspace-backup-bundle.js';
import {
  abandonCapture,
  completeCapture,
  inspectCapture,
  protectCapture,
} from './workspace-capture-protection.js';
import {
  assertCanonicalDirectory,
  nativeProductScope,
  readNativeProduct,
  syncCanonicalTree,
} from './workspace-file-records.js';
import {
  bindWorkspaceCaptureNativeOwner,
  endRecoveryAdmission,
  openRecoveryDatabase,
  prepareRecoveryAdmission,
  type RecoveryAdmission,
  readRecoveryAdmission,
  recoveryReport,
  refuseRecovery,
  withRecoveryRoot,
} from './workspace-recovery-admissions.js';
import type {
  WorkspaceRecoveryCliArgs,
  WorkspaceRecoveryCliReport,
  WorkspaceRecoverySelection,
} from './workspace-recovery-cli.js';

/** Exact process-crash boundaries; internal dependencies only, never operator input. */
export type WorkspaceRecoveryBoundary =
  | 'before-moved-out-commit'
  | 'after-moved-out-commit'
  | 'before-seal-publication'
  | 'after-seal-publication'
  | 'before-target-rename'
  | 'after-target-rename'
  | 'before-registration-commit'
  | 'after-registration-commit';
/** Production omits this dependency; independent child-process tests may exit at a boundary. */
export interface WorkspaceRecoveryDependencies {
  readonly atBoundary?: (point: WorkspaceRecoveryBoundary) => void;
}
export type WorkspaceMoveOutInput = Omit<
  Extract<WorkspaceRecoveryCliArgs, { command: 'move-out' }>,
  'command'
> & {
  readonly expectedRelease?: import('./workspace-backup-bundle.js').WorkspaceBackupManifest['release'];
};
export type WorkspaceReactivateInput = Omit<
  Extract<WorkspaceRecoveryCliArgs, { command: 'reactivate' }>,
  'command'
>;
export interface WorkspaceRecoverySelectedInput {
  readonly dataRoot: string;
  readonly workspaceId: string;
  readonly selection: WorkspaceRecoverySelection;
  /** CLI supplies the current installed release when completing an unfinished decision. */
  readonly expectedRelease?: WorkspaceMoveOutInput['expectedRelease'];
}
/** Reads native Workspace lifecycle without creating or recovering a missing database. */
function source(dataRoot: string, workspaceId: string) {
  const db = openRecoveryDatabase(workspaceDbPath(dataRoot, workspaceId));
  const row = db
    .prepare('SELECT revision, record_json FROM control_workspaces WHERE id=?')
    .get(workspaceId) as { revision: number; record_json: string } | undefined;
  if (!row) {
    db.close();
    refuseRecovery('workspace-unavailable');
  }
  return {
    db,
    row,
    record: JSON.parse(row.record_json) as {
      movedOut?: { backupId: string; manifestDigest: string };
    },
  };
}
/** Resolves only retained ownership, never a bundle-selected request. */
export function selectRecoveryAdmission(
  core: CoreDb,
  input: WorkspaceRecoverySelectedInput
): RecoveryAdmission {
  const id =
    input.selection.kind === 'capture' ? input.selection.backupId : input.selection.requestId;
  const row = readRecoveryAdmission(core, id);
  if (!row || row.workspace_id !== input.workspaceId) refuseRecovery('recovery-required');
  return row;
}
/** Finishes the source transaction before any transferable completion marker can exist. */
export async function moveOutWorkspace(
  input: WorkspaceMoveOutInput,
  deps: WorkspaceRecoveryDependencies = {}
): Promise<WorkspaceRecoveryCliReport> {
  return withRecoveryRoot(input.dataRoot, async (core) => {
    let owned = readRecoveryAdmission(core, input.backupId);
    const manifest = owned?.proof.manifest ?? readWorkspaceBackupManifest(input.bundleRoot);
    if (
      (!owned && (!input.expectedRelease || existsSync(join(input.bundleRoot, 'seal.json')))) ||
      (owned &&
        (owned.workspace_id !== input.workspaceId ||
          owned.state === 'abandoned' ||
          resolve(input.bundleRoot) !== owned.candidate_ref))
    )
      refuseRecovery('recovery-required');
    if (
      manifest.backupId !== input.backupId ||
      manifest.workspaceId !== input.workspaceId ||
      manifest.sourceDeploymentId !== readDataRootLayoutMarker(input.dataRoot).deploymentId
    )
      refuseRecovery('request-conflict');
    const { db, row, record } = source(input.dataRoot, input.workspaceId);
    let revision = row.revision;
    try {
      if (input.expectedRevision !== manifest.capturedRevision) refuseRecovery('request-conflict');
      if (
        record.movedOut &&
        (record.movedOut.backupId !== input.backupId ||
          record.movedOut.manifestDigest !== owned?.proof.capture.manifestDigest)
      )
        refuseRecovery('recovery-required');
      if (record.movedOut && revision !== manifest.capturedRevision + 1)
        refuseRecovery('recovery-required');
      if (!record.movedOut && revision !== input.expectedRevision)
        refuseRecovery('request-conflict');
      const temporary = mkdtempSync(join(input.dataRoot, 'server/runtime/.move-verify-'));
      try {
        const staged = await stageWorkspaceBackup({
          ...WORKSPACE_BACKUP_POLICY,
          bundleRoot: input.bundleRoot,
          stagingParent: temporary,
          expectedRelease: input.expectedRelease ?? manifest.release,
          admission: new FileStorageAdmission(input.dataRoot, () => 1_000_000_000n),
          candidateRoot: join(temporary, 'candidate'),
          expectedWorkspaceId: input.workspaceId,
          expectedSourceDeploymentId: manifest.sourceDeploymentId,
          purpose: 'move',
          allowPreparedMove: true,
        });
        if (owned && staged.report.manifestDigest !== owned.proof.capture.manifestDigest)
          refuseRecovery('request-conflict');
        if (!owned) {
          assertWorkspaceBackupCut(input.dataRoot, staged.candidateRoot, manifest, core);
          protectCapture(
            bindWorkspaceSqlite(db, input.dataRoot, input.workspaceId),
            input.workspaceId,
            input.backupId
          );
          prepareRecoveryAdmission(core, input.backupId, resolve(input.bundleRoot), {
            input: { command: 'move-out', ...input },
            manifest,
            capture: staged.report,
            result: recoveryReport('capture', 'prepared', staged.report),
          });
          owned = readRecoveryAdmission(core, input.backupId)!;
        }
      } finally {
        rmSync(temporary, { recursive: true, force: true });
      }
      if (!owned) refuseRecovery('recovery-required');
      const capture = owned.proof.capture;
      if (!record.movedOut) {
        db.transaction(() => {
          applyControlRecoveryMoveOut(bindWorkspaceSqlite(db, input.dataRoot, input.workspaceId), {
            workspaceId: input.workspaceId,
            captureId: input.backupId,
            expectedRevision: revision,
            manifestDigest: capture.manifestDigest,
          });
          deps.atBoundary?.('before-moved-out-commit');
        }).immediate();
        revision++;
        deps.atBoundary?.('after-moved-out-commit');
      }
      const report: WorkspaceRecoveryCliReport = {
        ...owned.proof.result,
        command: 'move-out',
        disposition: 'moved-out',
        currentRevision: revision,
        nextAction: 'reactivate',
      };
      deps.atBoundary?.('before-seal-publication');
      const seal = join(input.bundleRoot, 'seal.json');
      if (!existsSync(seal))
        writeFileSync(
          seal,
          JSON.stringify({
            format: 'openkit-workspace-backup-seal',
            version: 1,
            backupId: input.backupId,
            purpose: 'move',
            manifestDigest: capture.manifestDigest,
          }),
          { flag: 'wx', mode: 0o600 }
        );
      syncCanonicalTree(input.bundleRoot);
      deps.atBoundary?.('after-seal-publication');
      const scoped = bindWorkspaceSqlite(db, input.dataRoot, input.workspaceId);
      if (inspectCapture(scoped, input.workspaceId, input.backupId)?.state === 'active')
        completeCapture(scoped, input.workspaceId, input.backupId);
      core.sqlite
        .transaction(() => {
          endRecoveryAdmission(core, input.backupId, 'finished', report);
        })
        .immediate();
      return report;
    } finally {
      db.close();
    }
  });
}
/** A failed copy may retain only the original Workspace capture record, with no complete manifest. */
function incompleteCapture(
  input: WorkspaceRecoverySelectedInput,
  command: 'inspect' | 'abandon'
): WorkspaceRecoveryCliReport {
  if (input.selection.kind !== 'capture') refuseRecovery('recovery-required');
  const current = source(input.dataRoot, input.workspaceId);
  try {
    const scoped = bindWorkspaceSqlite(current.db, input.dataRoot, input.workspaceId);
    let capture = inspectCapture(scoped, input.workspaceId, input.selection.backupId);
    if (!capture) refuseRecovery('recovery-required');
    if (command === 'abandon') {
      if (current.record.movedOut) refuseRecovery('workspace-moved-out');
      capture = abandonCapture(scoped, input.workspaceId, input.selection.backupId);
    }
    return {
      command,
      workspaceId: input.workspaceId,
      selection: input.selection,
      currentRevision: current.row.revision,
      disposition:
        capture.state === 'abandoned'
          ? 'abandoned'
          : capture.state === 'finished'
            ? 'sealed'
            : 'pending',
      droppedSourceMemberIds: [],
      restrictedRecovery: false,
      nextAction: capture.state === 'active' ? 'abandon' : 'none',
    };
  } finally {
    current.db.close();
  }
}
/** Projects an exact Core-owned recovery without opening or changing candidate bytes. */
export function inspectWorkspaceRecoveryAtCore(
  core: CoreDb,
  input: WorkspaceRecoverySelectedInput,
  current?: { readonly revision: number; readonly movedOut: boolean }
): WorkspaceRecoveryCliReport {
  if (resolve(core.dataRoot) !== resolve(input.dataRoot)) refuseRecovery('recovery-required');
  const row = selectRecoveryAdmission(core, input);
  return {
    ...row.proof.result,
    command: 'inspect',
    disposition: current?.movedOut
      ? 'moved-out'
      : row.state === 'abandoned'
        ? 'abandoned'
        : row.state === 'finished'
          ? row.proof.result.disposition
          : input.selection.kind === 'capture'
            ? 'prepared'
            : 'quarantined',
    selection: input.selection,
    ...(current ? { currentRevision: current.revision } : {}),
    nextAction: row.state === 'prepared' ? 'finish' : 'none',
  };
}
/** Offline inspection keeps its root lock and delegates retained Core report selection. */
export async function inspectWorkspaceRecovery(
  input: WorkspaceRecoverySelectedInput
): Promise<WorkspaceRecoveryCliReport> {
  return withRecoveryRoot(input.dataRoot, async (core) => {
    const id =
      input.selection.kind === 'capture' ? input.selection.backupId : input.selection.requestId;
    if (!readRecoveryAdmission(core, id)) return incompleteCapture(input, 'inspect');
    if (input.selection.kind !== 'capture') return inspectWorkspaceRecoveryAtCore(core, input);
    const current = source(input.dataRoot, input.workspaceId);
    try {
      return inspectWorkspaceRecoveryAtCore(core, input, {
        revision: current.row.revision,
        movedOut: !!current.record.movedOut,
      });
    } finally {
      current.db.close();
    }
  });
}
/** Finishes only an existing source capture; target admission has its own placement owner. */
export async function finishWorkspaceMove(
  input: WorkspaceRecoverySelectedInput,
  deps: WorkspaceRecoveryDependencies = {}
): Promise<WorkspaceRecoveryCliReport> {
  const owned = await withRecoveryRoot(input.dataRoot, async (core) =>
    selectRecoveryAdmission(core, input)
  );
  if (owned.state === 'abandoned') refuseRecovery('recovery-required');
  const result = await moveOutWorkspace(
    {
      dataRoot: input.dataRoot,
      workspaceId: input.workspaceId,
      backupId: owned.backup_id,
      bundleRoot: owned.candidate_ref,
      expectedRevision: owned.proof.manifest.capturedRevision,
      ...(input.expectedRelease ? { expectedRelease: input.expectedRelease } : {}),
    },
    deps
  );
  return { ...result, command: 'finish', selection: input.selection };
}
/** Revokes publication durably before retiring the local seal and reopening source admission. */
export async function reactivateWorkspace(
  input: WorkspaceReactivateInput
): Promise<WorkspaceRecoveryCliReport> {
  if (!input.acknowledgeTargetFenced || !input.acknowledgeCopiesRetired)
    refuseRecovery('invalid-arguments');
  return withRecoveryRoot(input.dataRoot, async (core) => {
    const owned = readRecoveryAdmission(core, input.backupId);
    if (!owned || owned.workspace_id !== input.workspaceId) refuseRecovery('recovery-required');
    const current = source(input.dataRoot, input.workspaceId);
    try {
      if (
        owned.state === 'abandoned' &&
        !current.record.movedOut &&
        current.row.revision === owned.proof.manifest.capturedRevision + 2 &&
        input.expectedRevision === current.row.revision - 1
      ) {
        const report: WorkspaceRecoveryCliReport = {
          ...owned.proof.result,
          command: 'reactivate',
          disposition: 'reactivated',
          currentRevision: current.row.revision,
          nextAction: 'none',
        };
        endRecoveryAdmission(core, input.backupId, 'abandoned', report);
        return report;
      }
      if (current.row.revision !== input.expectedRevision) refuseRecovery('request-conflict');
      if (current.record.movedOut?.backupId !== input.backupId) refuseRecovery('recovery-required');
      core.sqlite
        .prepare(
          "UPDATE workspace_recovery_admissions SET state='abandoned', revision=revision+1, updated_at=? WHERE admission_id=?"
        )
        .run(new Date().toISOString(), input.backupId);
      await removeDurableFile({ destinationPath: join(owned.candidate_ref, 'seal.json') });
      current.db
        .transaction(() => {
          current.db
            .prepare(
              "UPDATE control_workspaces SET revision=revision+1, record_json=json_remove(record_json, '$.movedOut') WHERE id=?"
            )
            .run(input.workspaceId);
          recordWorkspaceAuditEvent({
            workspaceDb: bindWorkspaceSqlite(current.db, input.dataRoot, input.workspaceId),
            workspaceId: input.workspaceId,
            action: 'workspace.reactivate',
            resource: `workspace:${input.workspaceId}`,
            outcome: 'succeeded',
            summary: `Reactivated after retiring ${input.backupId}.`,
          });
        })
        .immediate();
      const report: WorkspaceRecoveryCliReport = {
        ...owned.proof.result,
        command: 'reactivate',
        disposition: 'reactivated',
        currentRevision: current.row.revision + 1,
        nextAction: 'none',
      };
      endRecoveryAdmission(core, input.backupId, 'abandoned', report);
      return report;
    } finally {
      current.db.close();
    }
  });
}
/** Ends prepared source protection; retained content and holds are never deleted. */
export async function abandonWorkspaceMove(
  input: WorkspaceRecoverySelectedInput
): Promise<WorkspaceRecoveryCliReport> {
  return withRecoveryRoot(input.dataRoot, async (core) => {
    const id =
      input.selection.kind === 'capture' ? input.selection.backupId : input.selection.requestId;
    if (!readRecoveryAdmission(core, id)) return incompleteCapture(input, 'abandon');
    const owned = selectRecoveryAdmission(core, input);
    if (owned.state === 'finished') refuseRecovery('request-conflict');
    const current = source(input.dataRoot, input.workspaceId);
    try {
      if (current.record.movedOut) refuseRecovery('workspace-moved-out');
      endRecoveryAdmission(core, owned.admission_id, 'abandoned');
      abandonCapture(
        bindWorkspaceSqlite(current.db, input.dataRoot, input.workspaceId),
        input.workspaceId,
        owned.backup_id
      );
      return {
        ...owned.proof.result,
        command: 'abandon',
        disposition: 'abandoned',
        selection: input.selection,
        nextAction: 'none',
      };
    } finally {
      current.db.close();
    }
  });
}

/** Reads exact retained source facts without creating a database or decoding away moved-out lineage. */
export function readWorkspaceCaptureRecoveryAtCore(
  core: CoreDb,
  input: WorkspaceRecoverySelectedInput
) {
  if (resolve(core.dataRoot) !== resolve(input.dataRoot) || input.selection.kind !== 'capture')
    refuseRecovery('recovery-required');
  const db = openWorkspaceReadDb(core.dataRoot, input.workspaceId);
  try {
    const row = readNativeProduct(
      nativeProductScope(core.dataRoot, { kind: 'workspace', workspaceId: input.workspaceId }),
      'workspace',
      input.workspaceId
    );
    const capture = inspectCapture(db, input.workspaceId, input.selection.backupId);
    if (!row || !capture) refuseRecovery('recovery-required');
    const movedOut = row.record.movedOut as
      | {
          backupId: string;
          manifestDigest: string;
        }
      | undefined;
    if (
      movedOut !== undefined &&
      (!movedOut ||
        !isEntityId('wsbak', movedOut.backupId) ||
        !/^sha256:[0-9a-f]{64}$/.test(movedOut.manifestDigest))
    )
      refuseRecovery('recovery-required');
    return {
      revision: row.revision,
      movedOut,
      capture,
      owned: readRecoveryAdmission(core, input.selection.backupId),
    };
  } finally {
    db.sqlite.close();
  }
}

/** Binds the existing source lifecycle to its exact current freeze, native file and original Core proof. */
function sourceCaptureOwner(
  policy: ReturnType<typeof workspaceSnapshotOperationPolicy>,
  input: WorkspaceRecoverySelectedInput,
  freeze: WorkspaceFrozenAdmission
) {
  policy.currentAuthority();
  if (input.selection.kind !== 'capture' || resolve(input.dataRoot) !== resolve(policy.dataRoot))
    refuseRecovery('recovery-required');
  const captureId = input.selection.backupId;
  const generation = join(
    policy.dataRoot,
    'server/backups/workspaces',
    input.workspaceId,
    captureId
  );
  const call = bindWorkspaceCaptureNativeOwner(
    policy.coreDb,
    input.workspaceId,
    captureId,
    policy.mutationAdmission,
    freeze
  );
  let proof = readRecoveryAdmission(policy.coreDb, captureId);
  const current = () => {
    policy.currentAuthority();
    if (!policy.mutationAdmission.isRecoveryBinding(input.workspaceId, freeze, call.binding))
      refuseRecovery('recovery-required');
    const facts = readWorkspaceCaptureRecoveryAtCore(policy.coreDb, input);
    if (
      !isDeepStrictEqual(facts.owned, proof) ||
      (proof && proof.candidate_ref !== resolve(generation))
    )
      refuseRecovery('recovery-required');
    return facts;
  };
  return {
    captureId,
    generation,
    call,
    current,
    client: getControlStoreWorkerClient(policy.mutationAdmission),
    updateProof: () => {
      proof = readRecoveryAdmission(policy.coreDb, captureId);
    },
  };
}

/** Completes the original verified source capture; a MOVE marker follows the native source tuple. */
export async function finishWorkspaceCaptureAtCore(
  policy: ReturnType<typeof workspaceSnapshotOperationPolicy>,
  input: WorkspaceRecoverySelectedInput,
  freeze: WorkspaceFrozenAdmission
): Promise<WorkspaceRecoveryCliReport> {
  const owner = sourceCaptureOwner(policy, input, freeze);
  let facts = owner.current();
  if (facts.capture.state === 'abandoned' || facts.owned?.state === 'abandoned')
    refuseRecovery('request-conflict');
  const verified = await inspectWorkspaceSnapshot(
    { workspaceId: input.workspaceId, backupId: owner.captureId },
    policy,
    freeze
  );
  facts = owner.current();
  const move = verified.manifest.purpose === 'move';
  if (!move && (facts.movedOut || facts.owned)) refuseRecovery('recovery-required');
  if (move && !facts.owned) {
    // The full inspector compared this manifested, still-fenced source with its cut before
    // cleanup. Retain the same original source admission used by the stopped path.
    if (facts.movedOut || facts.capture.state !== 'active') refuseRecovery('recovery-required');
    prepareRecoveryAdmission(policy.coreDb, owner.captureId, owner.generation, {
      input: {
        command: 'move-out',
        dataRoot: input.dataRoot,
        workspaceId: input.workspaceId,
        backupId: owner.captureId,
        bundleRoot: owner.generation,
        expectedRevision: verified.manifest.capturedRevision,
      },
      manifest: verified.manifest,
      capture: verified.report,
      result: recoveryReport('capture', 'prepared', verified.report),
    });
    owner.updateProof();
    facts = owner.current();
  }
  if (
    move &&
    (!facts.owned ||
      facts.owned.proof.capture.manifestDigest !== verified.report.manifestDigest ||
      !isDeepStrictEqual(facts.owned.proof.manifest, verified.manifest))
  )
    refuseRecovery('request-conflict');
  if (facts.owned?.state === 'finished' && facts.capture.state !== 'finished')
    refuseRecovery('recovery-required');
  const assertSource = () => {
    const current = owner.current();
    if (
      move
        ? current.revision !== verified.manifest.capturedRevision + 1 ||
          current.movedOut?.backupId !== owner.captureId ||
          current.movedOut.manifestDigest !== verified.report.manifestDigest
        : !!current.movedOut
    )
      refuseRecovery('recovery-required');
    return current;
  };
  if (facts.capture.state === 'active') {
    await owner.client.open(owner.call.binding.command, owner.call);
    facts = owner.current();
    if ((!move && facts.movedOut) || facts.capture.state !== 'active')
      refuseRecovery('request-conflict');
    if (move) {
      await owner.client.recoveryMoveOut(
        owner.call.binding.command.database,
        {
          workspaceId: input.workspaceId,
          captureId: owner.captureId,
          expectedRevision: verified.manifest.capturedRevision,
          manifestDigest: verified.report.manifestDigest,
        },
        owner.call
      );
      facts = assertSource();
      if (facts.capture.state !== 'active') refuseRecovery('request-conflict');
      const seal = join(owner.generation, 'seal.json');
      if (!existsSync(seal)) {
        const bytes = JSON.stringify({
          format: 'openkit-workspace-backup-seal',
          version: 1,
          backupId: owner.captureId,
          purpose: 'move',
          manifestDigest: verified.report.manifestDigest,
        });
        const reservation = policy.verification.admission.reserve({
          stagingBytes: 0n,
          extractionBytes: 0n,
          derivativeBytes: 0n,
          publicationBytes: BigInt(Buffer.byteLength(bytes)),
        });
        try {
          reservation.assertAvailable();
          assertSource();
          await publishDurableFile({ destinationPath: seal, bytes });
          reservation.recordWritten(Buffer.byteLength(bytes));
        } finally {
          reservation.release();
        }
        assertSource();
      }
    }
    const metadata = await readWorkspaceSnapshotMetadata({
      ...policy.verification,
      dataRoot: policy.dataRoot,
      workspaceId: input.workspaceId,
      backupId: owner.captureId,
    });
    facts = assertSource();
    if (
      metadata.manifestDigest !== verified.report.manifestDigest ||
      facts.capture.state !== 'active'
    )
      refuseRecovery('recovery-required');
    // Retry may find a marker whose publication failed after link but before directory sync.
    syncCanonicalTree(owner.generation);
    assertSource();
    await owner.client.recoveryCapture(
      owner.call.binding.command.database,
      {
        workspaceId: input.workspaceId,
        captureId: owner.captureId,
        state: 'finished',
      },
      owner.call
    );
    facts = owner.current();
  } else {
    // A terminal retry inspects the existing seal; it never republishes a historical marker.
    const metadata = await readWorkspaceSnapshotMetadata({
      ...policy.verification,
      dataRoot: policy.dataRoot,
      workspaceId: input.workspaceId,
      backupId: owner.captureId,
    });
    facts = assertSource();
    if (metadata.manifestDigest !== verified.report.manifestDigest)
      refuseRecovery('request-conflict');
    syncCanonicalTree(owner.generation);
  }
  facts = assertSource();
  if (facts.capture.state !== 'finished') refuseRecovery('recovery-required');
  const report: WorkspaceRecoveryCliReport = {
    ...recoveryReport('finish', move ? 'moved-out' : 'sealed', verified.report),
    selection: input.selection,
    currentRevision: facts.revision,
    nextAction: move ? 'reactivate' : 'none',
  };
  if (facts.owned)
    policy.coreDb.sqlite
      .transaction(() => endRecoveryAdmission(policy.coreDb, owner.captureId, 'finished', report))
      .immediate();
  return report;
}

/** Closes the exact publication right before retiring its seal; source bytes and holds survive. */
export async function abandonWorkspaceCaptureAtCore(
  policy: ReturnType<typeof workspaceSnapshotOperationPolicy>,
  input: WorkspaceRecoverySelectedInput,
  freeze: WorkspaceFrozenAdmission
): Promise<WorkspaceRecoveryCliReport> {
  const owner = sourceCaptureOwner(policy, input, freeze);
  let facts = owner.current();
  if (facts.movedOut) refuseRecovery('workspace-moved-out');
  if (facts.capture.state === 'finished' || facts.owned?.state === 'finished')
    refuseRecovery('request-conflict');
  await owner.client.open(owner.call.binding.command, owner.call);
  facts = owner.current();
  if (facts.movedOut || facts.capture.state === 'finished') refuseRecovery('request-conflict');
  await owner.client.recoveryCapture(
    owner.call.binding.command.database,
    {
      workspaceId: input.workspaceId,
      captureId: owner.captureId,
      state: 'abandoned',
    },
    owner.call
  );
  facts = owner.current();
  if (facts.capture.state !== 'abandoned' || facts.movedOut) refuseRecovery('recovery-required');
  const report: WorkspaceRecoveryCliReport = {
    command: 'abandon',
    disposition: 'abandoned',
    workspaceId: input.workspaceId,
    selection: input.selection,
    currentRevision: facts.revision,
    ...(facts.owned ? { capture: facts.owned.proof.capture } : {}),
    droppedSourceMemberIds: [],
    restrictedRecovery: false,
    nextAction: 'none',
  };
  if (facts.owned) {
    policy.coreDb.sqlite
      .transaction(() =>
        endRecoveryAdmission(policy.coreDb, owner.captureId, 'abandoned', {
          ...report,
          disposition: 'quarantined',
          nextAction: 'abandon',
        })
      )
      .immediate();
    owner.updateProof();
  }
  if (existsSync(owner.generation)) {
    assertCanonicalDirectory(owner.generation);
    await removeDurableFile({ destinationPath: join(owner.generation, 'seal.json') });
  }
  facts = owner.current();
  if (facts.capture.state !== 'abandoned' || facts.movedOut) refuseRecovery('recovery-required');
  if (facts.owned)
    policy.coreDb.sqlite
      .transaction(() => endRecoveryAdmission(policy.coreDb, owner.captureId, 'abandoned', report))
      .immediate();
  return report;
}
