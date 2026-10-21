import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { recordWorkspaceAuditEvent } from '../audit-events.js';
import { FileStorageAdmission } from './artifacts/file-admission.js';
import { bindWorkspaceSqlite, type CoreDb } from './db.js';
import { readDataRootLayoutMarker, workspaceDbPath } from './fs-layout.js';
import {
  assertWorkspaceBackupCut,
  readWorkspaceBackupManifest,
  stageWorkspaceBackup,
  WORKSPACE_BACKUP_POLICY,
} from './workspace-backup.js';
import {
  abandonCapture,
  completeCapture,
  inspectCapture,
  protectCapture,
} from './workspace-capture-protection.js';
import { syncCanonicalTree } from './workspace-file-records.js';
import {
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
          db.prepare(
            "UPDATE control_workspaces SET revision=revision+1, record_json=json_set(record_json, '$.movedOut', json(?)) WHERE id=? AND revision=?"
          ).run(
            JSON.stringify({ backupId: input.backupId, manifestDigest: capture.manifestDigest }),
            input.workspaceId,
            revision
          );
          recordWorkspaceAuditEvent({
            workspaceDb: bindWorkspaceSqlite(db, input.dataRoot, input.workspaceId),
            workspaceId: input.workspaceId,
            action: 'workspace.move-out',
            resource: `workspace:${input.workspaceId}`,
            outcome: 'succeeded',
            summary: `Moved out ${input.backupId} ${capture.manifestDigest}.`,
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
/** Reports existing source or target ownership without opening or changing candidate bytes. */
export async function inspectWorkspaceRecovery(
  input: WorkspaceRecoverySelectedInput
): Promise<WorkspaceRecoveryCliReport> {
  return withRecoveryRoot(input.dataRoot, async (core) => {
    const id =
      input.selection.kind === 'capture' ? input.selection.backupId : input.selection.requestId;
    if (!readRecoveryAdmission(core, id)) return incompleteCapture(input, 'inspect');
    const row = selectRecoveryAdmission(core, input);
    let currentRevision: number | undefined;
    let disposition: WorkspaceRecoveryCliReport['disposition'] =
      row.state === 'abandoned'
        ? 'abandoned'
        : row.state === 'finished'
          ? row.proof.result.disposition
          : input.selection.kind === 'capture'
            ? 'prepared'
            : 'quarantined';
    if (input.selection.kind === 'capture') {
      const current = source(input.dataRoot, input.workspaceId);
      try {
        currentRevision = current.row.revision;
        if (current.record.movedOut) disposition = 'moved-out';
      } finally {
        current.db.close();
      }
    }
    return {
      ...row.proof.result,
      command: 'inspect',
      disposition,
      selection: input.selection,
      ...(currentRevision === undefined ? {} : { currentRevision }),
      nextAction: row.state === 'prepared' ? 'finish' : 'none',
    };
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
      rmSync(join(owned.candidate_ref, 'seal.json'), { force: true });
      syncCanonicalTree(owned.candidate_ref);
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
