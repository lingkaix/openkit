import { recordWorkspaceAuditEvent } from '../audit-events.js';
import type { WorkspaceDb } from '../storage/db.js';
import type { PendingUserTurnQueueMode } from '../storage/schema/index.js';

/**
 * Stored pending user turn row.
 */
export interface PendingUserTurnRecord {
  /** Stable pending row id derived from workspace, thread, and request id. */
  readonly pendingTurnId: string;
  /** Workspace that owns the pending input. */
  readonly workspaceId: string;
  /** Thread that owns the pending input. */
  readonly threadId: string;
  /** Idempotency request id from the submitting command. */
  readonly requestId: string;
  /** Optional durable content item id for the submitted input. */
  readonly contentItemId: string | null;
  /** Optional digest when the submitted content is represented indirectly. */
  readonly contentDigest: string | null;
  /** Queue mode that controls later steering or follow-up delivery. */
  readonly queueMode: PendingUserTurnQueueMode;
  /** ISO timestamp when NanoCore received the input. */
  readonly receivedAt: string;
  /** ISO timestamp when the pending row was first created. */
  readonly createdAt: string;
}

interface PendingUserTurnRow {
  readonly pending_turn_id: string;
  readonly workspace_id: string;
  readonly thread_id: string;
  readonly request_id: string;
  readonly content_item_id: string | null;
  readonly content_digest: string | null;
  readonly queue_mode: PendingUserTurnQueueMode;
  readonly received_at: string;
  readonly created_at: string;
}

/**
 * Input used to enqueue one pending user turn.
 */
export interface EnqueuePendingUserTurnInput {
  /** Workspace that owns the pending input. */
  readonly workspaceId: string;
  /** Thread that owns the pending input. */
  readonly threadId: string;
  /** Idempotency request id from the submitting command. */
  readonly requestId: string;
  /** Optional durable content item id for the submitted input. */
  readonly contentItemId?: string | null;
  /** Optional digest when the submitted content is represented indirectly. */
  readonly contentDigest?: string | null;
  /** Queue mode that controls later steering or follow-up delivery. */
  readonly queueMode: PendingUserTurnQueueMode;
  /** Optional ISO timestamp when NanoCore received the input. */
  readonly receivedAt?: string;
  /** Optional clock used by deterministic tests. */
  readonly now?: () => string;
}

/**
 * Input used to list pending user turns for one thread.
 */
export interface ListPendingUserTurnsInput {
  /** Workspace that owns the pending input. */
  readonly workspaceId: string;
  /** Thread that owns the pending input. */
  readonly threadId: string;
}

/**
 * Input used to consume one pending user turn.
 */
export interface ConsumePendingUserTurnInput {
  /** Workspace that owns the pending input. */
  readonly workspaceId: string;
  /** Thread that owns the pending input. */
  readonly threadId: string;
  /** Idempotency request id for the pending input to consume. */
  readonly requestId: string;
}

/**
 * Enqueues one pending user turn idempotently.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param input Pending user turn enqueue input.
 * @returns Stored pending user turn record.
 * @throws Error when neither content item id nor content digest is provided.
 */
export function enqueuePendingUserTurn(
  workspaceDb: WorkspaceDb,
  input: EnqueuePendingUserTurnInput
): PendingUserTurnRecord {
  assertHasContentReference(input);

  const pendingTurnId = createPendingUserTurnId(input.workspaceId, input.threadId, input.requestId);
  const timestamp = input.receivedAt ?? input.now?.() ?? new Date().toISOString();

  const insertResult = workspaceDb.sqlite
    .prepare(
      `INSERT OR IGNORE INTO pending_user_turns (
        pending_turn_id,
        workspace_id,
        thread_id,
        request_id,
        content_item_id,
        content_digest,
        queue_mode,
        received_at,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      pendingTurnId,
      input.workspaceId,
      input.threadId,
      input.requestId,
      input.contentItemId ?? null,
      input.contentDigest ?? null,
      input.queueMode,
      timestamp,
      timestamp
    );

  const pendingTurn = requirePendingUserTurn(
    workspaceDb,
    input.workspaceId,
    input.threadId,
    input.requestId
  );

  if (insertResult.changes === 0) {
    assertSamePendingUserTurn(pendingTurn, input);
  }

  if (insertResult.changes > 0) {
    recordPendingUserTurnEnqueuedAuditEvent(workspaceDb, pendingTurn);
  }

  return pendingTurn;
}

/**
 * Lists pending user turns for one workspace thread in delivery order.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param input Thread scope for pending user turns.
 * @returns Pending user turn rows in deterministic order.
 */
export function listPendingUserTurns(
  workspaceDb: WorkspaceDb,
  input: ListPendingUserTurnsInput
): PendingUserTurnRecord[] {
  return (
    workspaceDb.sqlite
      .prepare(
        `${pendingUserTurnSelectSql()}
        WHERE workspace_id = ? AND thread_id = ?
        ORDER BY received_at ASC, pending_turn_id ASC`
      )
      .all(input.workspaceId, input.threadId) as PendingUserTurnRow[]
  ).map(mapPendingUserTurnRow);
}

/**
 * Lists all pending user turns for one workspace in stable export order.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param workspaceId Workspace id.
 * @returns Pending user turn rows in oldest-first order.
 */
export function listExportablePendingUserTurns(
  workspaceDb: WorkspaceDb,
  workspaceId: string
): PendingUserTurnRecord[] {
  return (
    workspaceDb.sqlite
      .prepare(
        `${pendingUserTurnSelectSql()}
        WHERE workspace_id = ?
        ORDER BY received_at ASC, pending_turn_id ASC`
      )
      .all(workspaceId) as PendingUserTurnRow[]
  ).map(mapPendingUserTurnRow);
}

/**
 * Replays imported pending user turns without emitting enqueue audit events.
 *
 * @param workspaceDb Open target workspace database handle.
 * @param pendingTurns Pending user turn rows to replay.
 */
export function importPendingUserTurns(
  workspaceDb: WorkspaceDb,
  pendingTurns: readonly PendingUserTurnRecord[]
): void {
  for (const pendingTurn of pendingTurns) {
    if (!pendingTurn.contentItemId && !pendingTurn.contentDigest) {
      throw new Error('Pending user turn import record requires a content item id or digest.');
    }

    workspaceDb.sqlite
      .prepare(
        `INSERT OR IGNORE INTO pending_user_turns (
          pending_turn_id,
          workspace_id,
          thread_id,
          request_id,
          content_item_id,
          content_digest,
          queue_mode,
          received_at,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        pendingTurn.pendingTurnId,
        pendingTurn.workspaceId,
        pendingTurn.threadId,
        pendingTurn.requestId,
        pendingTurn.contentItemId,
        pendingTurn.contentDigest,
        pendingTurn.queueMode,
        pendingTurn.receivedAt,
        pendingTurn.createdAt
      );
  }
}

/**
 * Consumes one pending user turn by deleting it after reading.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param input Pending user turn identity.
 * @returns The consumed pending user turn, or null when no row exists.
 */
export function consumePendingUserTurn(
  workspaceDb: WorkspaceDb,
  input: ConsumePendingUserTurnInput
): PendingUserTurnRecord | null {
  const pendingTurn = deletePendingUserTurn(workspaceDb, input);

  if (!pendingTurn) {
    return null;
  }

  recordPendingUserTurnConsumedAuditEvent(workspaceDb, pendingTurn);

  return pendingTurn;
}

/**
 * Cancels one pending user turn by deleting it from the recovery queue.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param input Pending user turn identity.
 * @returns The cancelled pending user turn, or null when no row exists.
 */
export function cancelPendingUserTurn(
  workspaceDb: WorkspaceDb,
  input: ConsumePendingUserTurnInput
): PendingUserTurnRecord | null {
  const pendingTurn = deletePendingUserTurn(workspaceDb, input);

  if (!pendingTurn) {
    return null;
  }

  recordPendingUserTurnCancelledAuditEvent(workspaceDb, pendingTurn);

  return pendingTurn;
}

/**
 * Converts one pending user turn to follow-up delivery.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param input Pending user turn identity.
 * @returns The converted pending user turn, or null when no row exists.
 */
export function convertPendingUserTurnToFollowUp(
  workspaceDb: WorkspaceDb,
  input: ConsumePendingUserTurnInput
): PendingUserTurnRecord | null {
  const pendingTurn = getPendingUserTurn(
    workspaceDb,
    input.workspaceId,
    input.threadId,
    input.requestId
  );

  if (!pendingTurn) {
    return null;
  }

  workspaceDb.sqlite
    .prepare('UPDATE pending_user_turns SET queue_mode = ? WHERE pending_turn_id = ?')
    .run('follow_up', pendingTurn.pendingTurnId);

  const converted = requirePendingUserTurn(
    workspaceDb,
    input.workspaceId,
    input.threadId,
    input.requestId
  );
  recordPendingUserTurnFollowUpConvertedAuditEvent(workspaceDb, converted);

  return converted;
}

/**
 * Promotes one pending user turn into an interrupt command by removing it from the queue.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param input Pending user turn identity.
 * @returns The promoted pending user turn, or null when no row exists.
 */
export function promotePendingUserTurnToInterrupt(
  workspaceDb: WorkspaceDb,
  input: ConsumePendingUserTurnInput
): PendingUserTurnRecord | null {
  const pendingTurn = deletePendingUserTurn(workspaceDb, input);

  if (!pendingTurn) {
    return null;
  }

  recordPendingUserTurnInterruptPromotedAuditEvent(workspaceDb, pendingTurn);

  return pendingTurn;
}

/**
 * Records audit lineage for an edited pending user turn idempotently.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param pendingTurn Edited pending user turn record.
 */
export function recordPendingUserTurnEditedAuditEvent(
  workspaceDb: WorkspaceDb,
  pendingTurn: PendingUserTurnRecord
): void {
  if (hasPendingUserTurnAuditEvent(workspaceDb, pendingTurn, 'human.pending_user_turn.edit')) {
    return;
  }

  recordWorkspaceAuditEvent({
    action: 'human.pending_user_turn.edit',
    category: 'command',
    itemId: pendingTurn.contentItemId,
    outcome: 'succeeded',
    requestId: pendingTurn.requestId,
    resource: `pending-user-turn:${pendingTurn.pendingTurnId}`,
    severity: 'info',
    summary: 'Pending user turn edited.',
    threadId: pendingTurn.threadId,
    workspaceDb,
    workspaceId: pendingTurn.workspaceId,
  });
}

/**
 * Records audit lineage for a newly queued pending user turn.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param pendingTurn Stored pending user turn record.
 */
function recordPendingUserTurnEnqueuedAuditEvent(
  workspaceDb: WorkspaceDb,
  pendingTurn: PendingUserTurnRecord
): void {
  recordWorkspaceAuditEvent({
    action: 'human.pending_user_turn.enqueue',
    category: 'command',
    itemId: pendingTurn.contentItemId,
    now: new Date(pendingTurn.createdAt),
    outcome: 'succeeded',
    requestId: pendingTurn.requestId,
    resource: `pending-user-turn:${pendingTurn.pendingTurnId}`,
    severity: 'info',
    summary: 'Pending user turn enqueued.',
    threadId: pendingTurn.threadId,
    workspaceDb,
    workspaceId: pendingTurn.workspaceId,
  });
}

/**
 * Records audit lineage for a consumed pending user turn.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param pendingTurn Consumed pending user turn record.
 */
function recordPendingUserTurnConsumedAuditEvent(
  workspaceDb: WorkspaceDb,
  pendingTurn: PendingUserTurnRecord
): void {
  recordWorkspaceAuditEvent({
    action: 'human.pending_user_turn.consume',
    category: 'command',
    itemId: pendingTurn.contentItemId,
    outcome: 'succeeded',
    requestId: pendingTurn.requestId,
    resource: `pending-user-turn:${pendingTurn.pendingTurnId}`,
    severity: 'info',
    summary: 'Pending user turn consumed.',
    threadId: pendingTurn.threadId,
    workspaceDb,
    workspaceId: pendingTurn.workspaceId,
  });
}

/**
 * Records audit lineage for a cancelled pending user turn.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param pendingTurn Cancelled pending user turn record.
 */
function recordPendingUserTurnCancelledAuditEvent(
  workspaceDb: WorkspaceDb,
  pendingTurn: PendingUserTurnRecord
): void {
  recordWorkspaceAuditEvent({
    action: 'human.pending_user_turn.cancel',
    category: 'command',
    itemId: pendingTurn.contentItemId,
    outcome: 'cancelled',
    requestId: pendingTurn.requestId,
    resource: `pending-user-turn:${pendingTurn.pendingTurnId}`,
    severity: 'info',
    summary: 'Pending user turn cancelled.',
    threadId: pendingTurn.threadId,
    workspaceDb,
    workspaceId: pendingTurn.workspaceId,
  });
}

/**
 * Records audit lineage for a pending user turn converted to follow-up delivery.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param pendingTurn Converted pending user turn record.
 */
function recordPendingUserTurnFollowUpConvertedAuditEvent(
  workspaceDb: WorkspaceDb,
  pendingTurn: PendingUserTurnRecord
): void {
  if (
    hasPendingUserTurnAuditEvent(
      workspaceDb,
      pendingTurn,
      'human.pending_user_turn.convert_follow_up'
    )
  ) {
    return;
  }

  recordWorkspaceAuditEvent({
    action: 'human.pending_user_turn.convert_follow_up',
    category: 'command',
    itemId: pendingTurn.contentItemId,
    outcome: 'succeeded',
    requestId: pendingTurn.requestId,
    resource: `pending-user-turn:${pendingTurn.pendingTurnId}`,
    severity: 'info',
    summary: 'Pending user turn converted to follow-up.',
    threadId: pendingTurn.threadId,
    workspaceDb,
    workspaceId: pendingTurn.workspaceId,
  });
}

/**
 * Records audit lineage for a pending user turn promoted to an interrupt.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param pendingTurn Promoted pending user turn record.
 */
function recordPendingUserTurnInterruptPromotedAuditEvent(
  workspaceDb: WorkspaceDb,
  pendingTurn: PendingUserTurnRecord
): void {
  recordWorkspaceAuditEvent({
    action: 'human.pending_user_turn.promote_interrupt',
    category: 'command',
    itemId: pendingTurn.contentItemId,
    outcome: 'succeeded',
    requestId: pendingTurn.requestId,
    resource: `pending-user-turn:${pendingTurn.pendingTurnId}`,
    severity: 'info',
    summary: 'Pending user turn promoted to interrupt.',
    threadId: pendingTurn.threadId,
    workspaceDb,
    workspaceId: pendingTurn.workspaceId,
  });
}

/**
 * Checks whether an audit event has already been recorded for a pending turn action.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param pendingTurn Pending user turn record.
 * @param action Audit action name.
 * @returns True when the action/resource pair already exists.
 */
function hasPendingUserTurnAuditEvent(
  workspaceDb: WorkspaceDb,
  pendingTurn: PendingUserTurnRecord,
  action: string
): boolean {
  const row = workspaceDb.sqlite
    .prepare(
      `SELECT audit_event_id
      FROM audit_events
      WHERE action = ? AND resource = ?
      LIMIT 1`
    )
    .get(action, `pending-user-turn:${pendingTurn.pendingTurnId}`) as
    | { readonly audit_event_id: string }
    | undefined;

  return Boolean(row);
}

/**
 * Deletes one pending user turn without deciding its semantic outcome.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param input Pending user turn identity.
 * @returns Deleted pending user turn, or null when no row exists.
 */
function deletePendingUserTurn(
  workspaceDb: WorkspaceDb,
  input: ConsumePendingUserTurnInput
): PendingUserTurnRecord | null {
  const pendingTurn = getPendingUserTurn(
    workspaceDb,
    input.workspaceId,
    input.threadId,
    input.requestId
  );

  if (!pendingTurn) {
    return null;
  }

  workspaceDb.sqlite
    .prepare('DELETE FROM pending_user_turns WHERE pending_turn_id = ?')
    .run(pendingTurn.pendingTurnId);

  return pendingTurn;
}

/**
 * Reads one pending user turn by scope and request id.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param workspaceId Workspace id.
 * @param threadId Thread id.
 * @param requestId Request id.
 * @returns Pending user turn record, or null.
 */
function getPendingUserTurn(
  workspaceDb: WorkspaceDb,
  workspaceId: string,
  threadId: string,
  requestId: string
): PendingUserTurnRecord | null {
  const row = workspaceDb.sqlite
    .prepare(
      `${pendingUserTurnSelectSql()}
      WHERE pending_turn_id = ?`
    )
    .get(createPendingUserTurnId(workspaceId, threadId, requestId)) as
    | PendingUserTurnRow
    | undefined;

  return row ? mapPendingUserTurnRow(row) : null;
}

/**
 * Reads one pending user turn or throws a readable error.
 *
 * @param workspaceDb Open workspace-scope database handle.
 * @param workspaceId Workspace id.
 * @param threadId Thread id.
 * @param requestId Request id.
 * @returns Pending user turn record.
 * @throws Error when the pending user turn does not exist.
 */
function requirePendingUserTurn(
  workspaceDb: WorkspaceDb,
  workspaceId: string,
  threadId: string,
  requestId: string
): PendingUserTurnRecord {
  const pendingTurn = getPendingUserTurn(workspaceDb, workspaceId, threadId, requestId);

  if (!pendingTurn) {
    throw new Error(`Pending user turn not found: ${workspaceId}/${threadId}/${requestId}`);
  }

  return pendingTurn;
}

/**
 * Builds the shared pending user turn SELECT fragment.
 *
 * @returns SQL fragment selecting every pending user turn column.
 */
function pendingUserTurnSelectSql(): string {
  return `SELECT
    pending_turn_id,
    workspace_id,
    thread_id,
    request_id,
    content_item_id,
    content_digest,
    queue_mode,
    received_at,
    created_at
    FROM pending_user_turns`;
}

/**
 * Creates the stable pending user turn id.
 *
 * @param workspaceId Workspace id.
 * @param threadId Thread id.
 * @param requestId Request id.
 * @returns Stable pending user turn id.
 */
function createPendingUserTurnId(workspaceId: string, threadId: string, requestId: string): string {
  return `${workspaceId}:${threadId}:${requestId}`;
}

/**
 * Verifies that pending input is represented without raw user text storage.
 *
 * @param input Pending user turn enqueue input.
 * @throws Error when neither content item id nor content digest is provided.
 */
function assertHasContentReference(input: EnqueuePendingUserTurnInput): void {
  if (!input.contentItemId && !input.contentDigest) {
    throw new Error('Pending user turn requires a content item id or content digest.');
  }
}

/**
 * Rejects duplicate request ids that resolve to different durable lineage.
 *
 * @param pendingTurn Existing pending row.
 * @param input Replayed enqueue input.
 * @throws Error when the replay changes content or queue mode.
 */
function assertSamePendingUserTurn(
  pendingTurn: PendingUserTurnRecord,
  input: EnqueuePendingUserTurnInput
): void {
  if (
    pendingTurn.contentItemId !== (input.contentItemId ?? null) ||
    pendingTurn.contentDigest !== (input.contentDigest ?? null) ||
    pendingTurn.queueMode !== input.queueMode
  ) {
    throw new Error('Pending user turn request conflicts with existing lineage.');
  }
}

/**
 * Maps a pending user turn row to the store record.
 *
 * @param row Pending user turn row.
 * @returns Pending user turn record.
 */
function mapPendingUserTurnRow(row: PendingUserTurnRow): PendingUserTurnRecord {
  return {
    pendingTurnId: row.pending_turn_id,
    workspaceId: row.workspace_id,
    threadId: row.thread_id,
    requestId: row.request_id,
    contentItemId: row.content_item_id,
    contentDigest: row.content_digest,
    queueMode: row.queue_mode,
    receivedAt: row.received_at,
    createdAt: row.created_at,
  };
}
