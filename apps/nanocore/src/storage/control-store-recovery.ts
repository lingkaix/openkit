import { recordWorkspaceAuditEvent } from '../audit-events.js';
import { recoverRunningCapabilityCalls } from '../capability/usage-ledger.js';
import { ControlProductPreconditionError } from './control-store-products.js';
import type { WorkspaceDb } from './db.js';
import { endCaptureInDb } from './workspace-capture-protection.js';

/** Cleanup facts for an already admitted, unpublished restore or MOVE candidate. */
export interface ControlRecoveryCleanupInput {
  readonly workspaceId: string;
  readonly action: 'workspace.restore' | 'workspace.move-in';
  readonly summary: string;
}

/** Applies existing recovery owners together; only the native covering commit acknowledges them. */
export function applyControlRecoveryCleanup(
  db: WorkspaceDb,
  input: ControlRecoveryCleanupInput
): void {
  if (db.scope !== 'workspace' || db.workspaceId !== input.workspaceId || !db.sqlite.inTransaction)
    throw new ControlProductPreconditionError();
  recoverRunningCapabilityCalls({ workspaceDb: db });
  const captures = db.sqlite
    .prepare("SELECT capture_id FROM workspace_capture_records WHERE state='active'")
    .pluck()
    .all() as string[];
  for (const capture of captures) endCaptureInDb(db, db.workspaceId, capture, 'finished');
  recordWorkspaceAuditEvent({
    workspaceDb: db,
    workspaceId: db.workspaceId,
    action: input.action,
    resource: `workspace:${db.workspaceId}`,
    outcome: 'succeeded',
    summary: input.summary,
  });
}
