import { recordWorkspaceAuditEvent } from '../audit-events.js';
import { recoverRunningCapabilityCalls } from '../capability/usage-ledger.js';
import {
  ControlProductPreconditionError,
  openControlStoreProductReadHandle,
} from './control-store-products.js';
import type { WorkspaceDb } from './db.js';
import { workspaceDbPath } from './fs-layout.js';
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

/** Root-locked current safety source for an already admitted private restore candidate. */
export interface ControlRecoverySafetyInput {
  readonly workspaceId: string;
  readonly sourceDataRoot: string;
}

/** Existing refusal distinctions; no source row crosses the message boundary. */
export type ControlRecoverySafetyResult = 'preserved' | 'unavailable' | 'moved-out';

/** Worker-local source census, held only until the owning candidate transition settles. */
export type PreparedControlRecoverySafety =
  | { readonly result: 'preserved'; readonly rows: readonly Record<string, unknown>[] }
  | { readonly result: 'unavailable' | 'moved-out' };

/** Reads current safety without migrations or writes, and closes the source before candidate SQL. */
export function prepareControlRecoverySafety(
  input: ControlRecoverySafetyInput
): PreparedControlRecoverySafety {
  let current: ReturnType<typeof openControlStoreProductReadHandle> | undefined;
  try {
    current = openControlStoreProductReadHandle(
      workspaceDbPath(input.sourceDataRoot, input.workspaceId),
      { kind: 'workspace', workspaceId: input.workspaceId }
    );
    if (current.sqlite.pragma('integrity_check', { simple: true }) !== 'ok')
      return { result: 'unavailable' };
    if (
      current.sqlite
        .prepare("SELECT json_extract(record_json,'$.movedOut') FROM control_workspaces WHERE id=?")
        .pluck()
        .get(input.workspaceId)
    )
      return { result: 'moved-out' };
    return {
      result: 'preserved',
      rows: current.sqlite.prepare('SELECT * FROM evidence_bundles').all() as Record<
        string,
        unknown
      >[],
    };
  } catch {
    // Only an unreadable source may use the original explicit lost-safety acknowledgement.
    return { result: 'unavailable' };
  } finally {
    current?.close();
  }
}

/** Replaces captured safety with the proved current rows; failures never become lost-safety consent. */
export function applyControlRecoverySafety(
  db: WorkspaceDb,
  input: ControlRecoverySafetyInput,
  prepared: PreparedControlRecoverySafety
): ControlRecoverySafetyResult {
  if (db.workspaceId !== input.workspaceId || !db.sqlite.inTransaction)
    throw new ControlProductPreconditionError();
  if (prepared.result !== 'preserved') return prepared.result;
  db.sqlite.prepare('DELETE FROM evidence_bundles').run();
  for (const row of prepared.rows) {
    const columns = Object.keys(row);
    db.sqlite
      .prepare(
        `INSERT INTO evidence_bundles (${columns.map((key) => `"${key}"`).join(',')}) VALUES (${columns.map(() => '?').join(',')})`
      )
      .run(...Object.values(row));
  }
  return 'preserved';
}
