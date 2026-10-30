import type { WorkspaceDb } from './db.js';
import type { workspaceCaptureRecords } from './schema/workspace-capture-protection.js';

/** One retained capture decision; it does not establish closure or GC/Notebook exclusion. */
export type WorkspaceCaptureRecord = Readonly<typeof workspaceCaptureRecords.$inferSelect>;

/** Refuses a different physical Workspace authority or an empty capture identity before SQL effects. */
function assertCaptureScope(db: WorkspaceDb, workspaceId: string, captureId: string): void {
  if (db.scope !== 'workspace' || db.workspaceId !== workspaceId) {
    throw new Error('Workspace capture scope mismatch.');
  }
  if (typeof captureId !== 'string' || captureId.trim().length === 0) {
    throw new Error('Workspace capture identity is required.');
  }
}

/** Recognizes the exact UTC timestamp representation written by this record owner. */
function isTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

/**
 * Reads one record without writes or implicit recovery, ignoring additive SQL columns.
 * @param db Physical Workspace authority.
 * @param workspaceId Expected owning Workspace.
 * @param captureId Exact retained capture identity.
 * @returns The retained decision, or null when absent.
 * @throws On a scope mismatch, unsupported retained core or unavailable SQL authority.
 */
export function inspectCapture(
  db: WorkspaceDb,
  workspaceId: string,
  captureId: string
): WorkspaceCaptureRecord | null {
  assertCaptureScope(db, workspaceId, captureId);
  // Quarantine can defer migration. The additive column's manual default still permits explicit
  // inspection/abandonment of predecessor records without granting automatic recovery authority.
  const hasOrigin = (
    db.sqlite.pragma('table_info(workspace_capture_records)') as { name: string }[]
  ).some((column) => column.name === 'origin');
  const row = db.sqlite
    .prepare(
      `SELECT capture_id AS captureId, workspace_id AS workspaceId, state,
              ${hasOrigin ? 'origin' : "'manual' AS origin"},
              created_at AS createdAt, ended_at AS endedAt
       FROM workspace_capture_records WHERE capture_id = ?`
    )
    .get(captureId) as Record<string, unknown> | undefined;
  if (row === undefined) return null;
  if (
    row.captureId !== captureId ||
    row.workspaceId !== workspaceId ||
    (row.state !== 'active' && row.state !== 'finished' && row.state !== 'abandoned') ||
    (row.origin !== 'manual' && row.origin !== 'automatic') ||
    !isTimestamp(row.createdAt) ||
    (row.state === 'active' ? row.endedAt !== null : !isTimestamp(row.endedAt))
  ) {
    throw new Error('Workspace capture record has unsupported retained core.');
  }
  return {
    captureId,
    workspaceId,
    state: row.state,
    origin: row.origin,
    createdAt: row.createdAt,
    endedAt: row.endedAt as string | null,
  };
}

/**
 * Durably creates one active record, or reads its unchanged active retry.
 * @param db Physical Workspace authority.
 * @param workspaceId Expected owning Workspace.
 * @param captureId Exact identity reused for retries.
 * @param options Trusted origin; ordinary callers and predecessor records remain manual.
 * @returns The active record with its original creation time.
 * @throws On terminal identity reuse, unsupported core, scope conflict, enclosing transaction or SQL failure.
 */
export function protectCapture(
  db: WorkspaceDb,
  workspaceId: string,
  captureId: string,
  options: { readonly origin: 'manual' | 'automatic' } = { origin: 'manual' }
): WorkspaceCaptureRecord {
  assertCaptureScope(db, workspaceId, captureId);
  if (options.origin !== 'manual' && options.origin !== 'automatic')
    throw new Error('Workspace capture origin is unsupported.');
  // A nested savepoint could return success before its outer transaction commits or rolls back.
  if (db.sqlite.inTransaction) throw new Error('Workspace capture requires its own commit.');
  // An immediate transaction serializes the identity check and insert across native connections.
  return db.sqlite
    .transaction(() => {
      const existing = inspectCapture(db, workspaceId, captureId);
      if (existing) {
        if (existing.state !== 'active' || existing.origin !== options.origin) {
          throw new Error('Workspace capture identity is already terminal.');
        }
        return existing;
      }
      const createdAt = new Date().toISOString();
      db.sqlite
        .prepare(
          `INSERT INTO workspace_capture_records
         (capture_id, workspace_id, state, origin, created_at, ended_at) VALUES (?, ?, 'active', ?, ?, NULL)`
        )
        .run(captureId, workspaceId, options.origin, createdAt);
      return {
        captureId,
        workspaceId,
        state: 'active' as const,
        origin: options.origin,
        createdAt,
        endedAt: null,
      };
    })
    .immediate();
}

/** Commits one of the two explicit terminal decisions without reopening or replacing a record. */
function endCapture(
  db: WorkspaceDb,
  workspaceId: string,
  captureId: string,
  state: 'finished' | 'abandoned'
): WorkspaceCaptureRecord {
  assertCaptureScope(db, workspaceId, captureId);
  if (db.sqlite.inTransaction) throw new Error('Workspace capture requires its own commit.');
  return db.sqlite.transaction(() => endCaptureInDb(db, workspaceId, captureId, state)).immediate();
}

/** Decides the existing terminal mutation inside its caller's transaction; this never acknowledges durability. */
export function endCaptureInDb(
  db: WorkspaceDb,
  workspaceId: string,
  captureId: string,
  state: 'finished' | 'abandoned'
): WorkspaceCaptureRecord {
  assertCaptureScope(db, workspaceId, captureId);
  if (!db.sqlite.inTransaction)
    throw new Error('Workspace capture requires an owning transaction.');
  const existing = inspectCapture(db, workspaceId, captureId);
  if (!existing) throw new Error('Workspace capture record is missing.');
  if (existing.state === state) return existing;
  if (existing.state !== 'active') {
    throw new Error('Workspace capture has a conflicting terminal decision.');
  }
  const endedAt = new Date().toISOString();
  const result = db.sqlite
    .prepare(
      `UPDATE workspace_capture_records SET state = ?, ended_at = ?
         WHERE capture_id = ? AND workspace_id = ? AND state = 'active'`
    )
    .run(state, endedAt, captureId, workspaceId);
  if (result.changes !== 1) throw new Error('Workspace capture transition did not commit.');
  return { ...existing, state, endedAt };
}

/**
 * Records the owner's explicit finish decision; this primitive does not verify closure.
 * @param db Physical Workspace authority.
 * @param workspaceId Expected owning Workspace.
 * @param captureId Capture to finish, never to recreate.
 * @returns The first finished decision, unchanged on an identical retry.
 * @throws On a missing record, competing abandon decision, unsupported core, enclosing transaction or SQL failure.
 */
export function completeCapture(
  db: WorkspaceDb,
  workspaceId: string,
  captureId: string
): WorkspaceCaptureRecord {
  return endCapture(db, workspaceId, captureId, 'finished');
}

/**
 * Records the owner's explicit abandon decision without claiming a complete backup.
 * @param db Physical Workspace authority.
 * @param workspaceId Expected owning Workspace.
 * @param captureId Capture to abandon, never to recreate.
 * @returns The first abandoned decision, unchanged on an identical retry.
 * @throws On a missing record, competing finish decision, unsupported core, enclosing transaction or SQL failure.
 */
export function abandonCapture(
  db: WorkspaceDb,
  workspaceId: string,
  captureId: string
): WorkspaceCaptureRecord {
  return endCapture(db, workspaceId, captureId, 'abandoned');
}
