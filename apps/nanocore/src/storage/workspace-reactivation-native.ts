import { lstatSync } from 'node:fs';
import { recordWorkspaceAuditEvent } from '../audit-events.js';
import { commandInputHash } from './control-store-input.js';
import {
  ControlProductPreconditionError,
  openControlStoreProductReadHandle,
} from './control-store-product-records.js';
import { assertControlProductWriter } from './control-store-products.js';
import { bindCoreSqlite, type CoreDb, openWorkspaceReadDb, type WorkspaceDb } from './db.js';
import { coreDbPath, workspaceDbPath } from './fs-layout.js';
import {
  type ControlRecoverySourceReactivationInput,
  ControlRecoverySourceReactivationInputSchema,
} from './workspace-reactivation-codecs.js';
import {
  endRecoveryAdmission,
  type RecoveryAdmission,
  readRecoveryAdmission,
  refuseRecovery,
} from './workspace-recovery-admissions.js';
import type { WorkspaceRecoveryCliReport } from './workspace-recovery-cli.js';

/** Reads the exact source lifecycle through the existing short, query-only owner; no SQL crosses an await. */
export function readWorkspaceReactivationSource(dataRoot: string, workspaceId: string) {
  const stat = lstatSync(workspaceDbPath(dataRoot, workspaceId), { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.size === 0) refuseRecovery('workspace-unavailable');
  const db = openWorkspaceReadDb(dataRoot, workspaceId);
  try {
    const row = db.sqlite
      .prepare('SELECT revision, record_json FROM control_workspaces WHERE id=?')
      .get(workspaceId) as { revision: number; record_json: string } | undefined;
    if (!row) refuseRecovery('workspace-unavailable');
    const record = JSON.parse(row.record_json) as {
      movedOut?: { backupId: string; manifestDigest: string };
    };
    return { revision: row.revision, movedOut: record.movedOut };
  } finally {
    db.sqlite.close();
  }
}

/** Revalidates the complete original retained selection inside the owning effect. */
function selected(core: CoreDb, input: ControlRecoverySourceReactivationInput): RecoveryAdmission {
  const owned = readRecoveryAdmission(core, input.backupId);
  if (
    !owned ||
    owned.workspace_id !== input.workspaceId ||
    owned.revision !== input.expectedCoreRevision ||
    commandInputHash(owned.proof) !== input.proofHash
  )
    refuseRecovery('recovery-required');
  return owned;
}

/** Keeps the original stale-revision and wrong-capture refusal order at the actual Workspace effect. */
function assertMovedOut(
  current: ReturnType<typeof readWorkspaceReactivationSource>,
  input: ControlRecoverySourceReactivationInput
): void {
  if (current.revision !== input.expectedRevision) refuseRecovery('request-conflict');
  if (current.movedOut?.backupId !== input.backupId) refuseRecovery('recovery-required');
}

/** Applies one original stage in its own native savepoint and covering FULL commit, never across databases. */
export function applyControlRecoverySourceReactivation(
  db: CoreDb | WorkspaceDb,
  raw: ControlRecoverySourceReactivationInput
): void {
  assertControlProductWriter(db.sqlite);
  if (!db.sqlite.inTransaction) throw new ControlProductPreconditionError();
  const input = ControlRecoverySourceReactivationInputSchema.parse(raw);
  if (input.stage === 'workspace') {
    if (db.scope !== 'workspace' || db.workspaceId !== input.workspaceId)
      throw new ControlProductPreconditionError();
    const reader = openControlStoreProductReadHandle(coreDbPath(db.dataRoot), { kind: 'server' });
    try {
      if (selected(bindCoreSqlite(reader.sqlite, db.dataRoot), input).state !== 'abandoned')
        refuseRecovery('recovery-required');
    } finally {
      reader.close();
    }
    const row = db.sqlite
      .prepare('SELECT revision, record_json FROM control_workspaces WHERE id=?')
      .get(input.workspaceId) as { revision: number; record_json: string } | undefined;
    if (!row) refuseRecovery('workspace-unavailable');
    const record = JSON.parse(row.record_json) as {
      movedOut?: { backupId: string; manifestDigest: string };
    };
    assertMovedOut({ revision: row.revision, movedOut: record.movedOut }, input);
    db.sqlite
      .prepare(
        "UPDATE control_workspaces SET revision=revision+1, record_json=json_remove(record_json, '$.movedOut') WHERE id=?"
      )
      .run(input.workspaceId);
    recordWorkspaceAuditEvent({
      workspaceDb: db,
      workspaceId: input.workspaceId,
      action: 'workspace.reactivate',
      resource: `workspace:${input.workspaceId}`,
      outcome: 'succeeded',
      summary: `Reactivated after retiring ${input.backupId}.`,
    });
    return;
  }
  if (db.scope !== 'core') throw new ControlProductPreconditionError();
  const owned = selected(db, input);
  const current = readWorkspaceReactivationSource(db.dataRoot, input.workspaceId);
  if (input.stage === 'revoke') {
    assertMovedOut(current, input);
    // A fresh explicit retry still revokes and increments, even when the earlier revocation committed.
    // This original finished->abandoned update must not use the first-terminal end helper.
    db.sqlite
      .prepare(
        "UPDATE workspace_recovery_admissions SET state='abandoned', revision=revision+1, updated_at=? WHERE admission_id=?"
      )
      .run(new Date().toISOString(), input.backupId);
    return;
  }
  if (
    owned.state !== 'abandoned' ||
    current.movedOut ||
    current.revision !== input.expectedRevision + 1
  )
    refuseRecovery('recovery-required');
  const report: WorkspaceRecoveryCliReport = {
    ...owned.proof.result,
    command: 'reactivate',
    disposition: 'reactivated',
    currentRevision: current.revision,
    nextAction: 'none',
  };
  endRecoveryAdmission(db, input.backupId, 'abandoned', report);
}
