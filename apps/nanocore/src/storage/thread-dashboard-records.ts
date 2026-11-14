import type Database from 'better-sqlite3';
import type { ThreadItemPosition } from './control-store-product-records.js';

/** Selectors for current Items, ordered by their original run and Item admission. */
export interface CurrentThreadItems {
  readonly type: string;
  readonly turnId?: string;
  readonly status?: string;
  readonly limit: number;
}

/** One indexed current-head seek; revisions do not move an Item's original position. */
export function readCurrentThreadItemPositions(
  sqlite: Database.Database,
  threadId: string,
  input: CurrentThreadItems
): ThreadItemPosition[] {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 50)
    throw new TypeError('Invalid current Item window.');
  const byTurn = input.turnId !== undefined;
  return sqlite
    .prepare(`SELECT id AS itemId,turn_id AS turnId,item_order AS sequence,
    turn_admission_order AS admissionOrder FROM control_product_entries
    WHERE kind='item' AND is_current=1 AND ${byTurn ? 'turn_id=?' : "json_extract(identity_json,'$.threadId')=?"}
    ${byTurn ? "AND json_extract(identity_json,'$.threadId')=?" : ''}
    AND json_extract(identity_json,'$.type')=?
    ${input.status === undefined ? '' : "AND json_extract(read_metadata_json,'$.status')=?"}
    ORDER BY ${byTurn ? '' : 'turn_admission_order DESC,'}item_order DESC LIMIT ?`)
    .all(
      byTurn ? input.turnId! : threadId,
      ...(byTurn ? [threadId] : []),
      input.type,
      ...(input.status === undefined ? [] : [input.status]),
      input.limit
    ) as ThreadItemPosition[];
}

/** Covering message-kind seek with one lookahead; only a proved finite set opens exact row identities. */
export function readNavigationMessageItemIds(
  sqlite: Database.Database,
  threadId: string
): string[] | null {
  const heads = sqlite
    .prepare(`SELECT rowid AS entry FROM control_product_entries INDEXED BY control_items_thread_read_idx
    WHERE kind='item' AND is_current=1 AND json_extract(identity_json,'$.threadId')=?
    AND json_extract(identity_json,'$.type') IN ('assistant-message','user-message')
    ORDER BY json_extract(identity_json,'$.type'),turn_admission_order,item_order LIMIT 65`)
    .all(threadId) as Array<{ entry: number }>;
  if (heads.length > 64) return null;
  const identity = sqlite.prepare('SELECT id FROM control_product_entries WHERE rowid=?');
  return heads.map((head) => (identity.get(head.entry) as { id: string }).id);
}

/** Navigation uses indexed endpoints, not admission order or complete run/Item histories. */
export function readThreadNavigationPositions(sqlite: Database.Database, threadId: string) {
  const latest = sqlite
    .prepare(`SELECT id FROM control_turns WHERE thread_id=?
      ORDER BY coalesce(json_extract(record_json,'$.startedAt'),'') DESC,thread_read_order DESC LIMIT 1`)
    .get(threadId) as { id: string } | undefined;
  const timestamps: string[] = [];
  for (const field of ['startedAt', 'completedAt']) {
    const turn = sqlite
      .prepare(`SELECT json_extract(record_json,'$.${field}') AS timestamp FROM control_turns
        WHERE thread_id=? ORDER BY json_extract(record_json,'$.${field}') DESC LIMIT 1`)
      .get(threadId) as { timestamp: string | null } | undefined;
    const item = sqlite
      .prepare(`SELECT json_extract(read_metadata_json,'$.${field === 'startedAt' ? 'createdAt' : field}') AS timestamp
        FROM control_product_entries WHERE kind='item' AND is_current=1
        AND json_extract(identity_json,'$.threadId')=?
        ORDER BY json_extract(read_metadata_json,'$.${field === 'startedAt' ? 'createdAt' : field}') DESC LIMIT 1`)
      .get(threadId) as { timestamp: string | null } | undefined;
    for (const row of [turn, item])
      if (row?.timestamp !== null && row?.timestamp !== undefined) timestamps.push(row.timestamp);
  }
  return { latestTurnId: latest?.id ?? null, lastActivityAt: timestamps.sort().at(-1) ?? null };
}

/** Metadata-only lookahead bounds the unchanged canonical Pending command-receipt decoder. */
export function readNavigationPendingReceiptSizes(
  sqlite: Database.Database,
  requestId: string,
  maximumRows: number
) {
  if (!Number.isSafeInteger(maximumRows) || maximumRows < 0 || maximumRows > 64)
    throw new TypeError('Invalid navigation Pending receipt allowance.');
  return sqlite
    .prepare(`SELECT octet_length(request_key)+octet_length(command_name)+octet_length(request_id)
    +octet_length(scope_json)+octet_length(input_hash)+octet_length(response_kind)+octet_length(response_id)
    +coalesce(octet_length(response_json),0)+octet_length(created_at)+octet_length(expires_at) AS bytes
    FROM idempotency_requests WHERE coalesce(json_extract(scope_json,'$.approvalRequestId'),
      json_extract(scope_json,'$.userInputRequestId'),json_extract(scope_json,'$.pendingRequestId'))=? LIMIT ?`)
    .all(requestId, maximumRows + 1) as Array<{ bytes: number }>;
}

/** Exact retained Thread rank facts; the global immutable admission key remains unchanged. */
export function readThreadTurnRanks(sqlite: Database.Database, threadId: string, turnId: string) {
  const current = sqlite
    .prepare('SELECT thread_read_order AS position FROM control_turns WHERE thread_id=? AND id=?')
    .get(threadId, turnId) as { position: number } | undefined;
  const latest = sqlite
    .prepare(
      'SELECT thread_read_order AS position FROM control_turns WHERE thread_id=? ORDER BY thread_read_order DESC LIMIT 1'
    )
    .get(threadId) as { position: number } | undefined;
  return current && latest ? { position: current.position, latest: latest.position } : undefined;
}

/** Request-qualified lineage only; no foreign Thread body is decoded for a contradiction. */
export function readPendingItemAssociations(
  sqlite: Database.Database,
  requestId: string,
  requestItemId: string
) {
  const select = `SELECT id AS itemId,turn_id AS turnId,json_extract(identity_json,'$.threadId') AS threadId,
    json_extract(identity_json,'$.type') AS type FROM control_product_entries WHERE kind='item' AND is_current=1 AND json_extract(identity_json,'$.type') IN ('approval-request','user-input-request','approval-decision','user-input-response')`;
  type Position = { itemId: string; turnId: string; threadId: string; type: string };
  const selected = [
    ...sqlite
      .prepare(`${select} AND json_extract(read_metadata_json,'$.requestId')=? LIMIT 129`)
      .all(requestId),
    ...sqlite
      .prepare(`${select} AND json_extract(identity_json,'$.causationId')=? LIMIT 129`)
      .all(requestItemId),
    ...sqlite.prepare(`${select} AND id=? LIMIT 1`).all(requestItemId),
  ] as Position[];
  if (selected.length > 256) throw new TypeError('Pending association proof exceeds its bound.');
  return [...new Map(selected.map((row) => [row.itemId, row])).values()];
}

/** The last recorded event time is an observation, never a liveness claim. */
export function readLastTurnEventTime(sqlite: Database.Database, turnId: string): string | null {
  const row = sqlite
    .prepare(`SELECT json_extract(read_metadata_json,'$.timestamp') AS timestamp
    FROM control_product_entries WHERE kind='event' AND turn_id=? ORDER BY sequence DESC LIMIT 1`)
    .get(turnId) as { timestamp: string | null } | undefined;
  return row?.timestamp ?? null;
}
