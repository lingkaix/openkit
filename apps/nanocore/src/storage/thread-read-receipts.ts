import { ItemIdSchema, ThreadIdSchema, WorkspaceIdSchema } from '@openkit/protocol';
import type { UserDb } from './db.js';

const itemIdsSchema = ItemIdSchema.array();

/**
 * Reads the User-owned set of recorded read message identities without advancing it.
 * Callers enforce current Workspace/Thread access and message eligibility.
 *
 * @param userDb Existing database of the authenticated User.
 * @param workspaceId Workspace that contains the Thread.
 * @param threadId Thread whose read receipt is requested.
 * @returns Recorded Item membership in deterministic serialization order, or an empty set.
 * @throws When required receipt content is invalid or SQLite cannot read it.
 */
export function readThreadReadReceipt(
  userDb: UserDb,
  workspaceId: string,
  threadId: string
): string[] {
  WorkspaceIdSchema.parse(workspaceId);
  ThreadIdSchema.parse(threadId);
  const row = userDb.sqlite
    .prepare(
      'SELECT item_ids_json FROM thread_read_receipts WHERE workspace_id = ? AND thread_id = ?'
    )
    .get(workspaceId, threadId) as { item_ids_json: string } | undefined;
  if (!row) return [];

  try {
    const itemIds = itemIdsSchema.parse(JSON.parse(row.item_ids_json));
    if (new Set(itemIds).size !== itemIds.length) {
      throw new Error('Receipt membership must be a set.');
    }
    return itemIds.sort();
  } catch (cause) {
    throw new Error('Thread read receipt storage content is invalid.', { cause });
  }
}

/**
 * Unions admitted read Item identities with the User-owned Thread receipt.
 * The immediate transaction serializes devices before reading existing membership.
 * Identifier order is serialization only and has no chronological meaning.
 *
 * @param userDb Existing database of the authenticated User.
 * @param workspaceId Workspace that contains the Thread.
 * @param threadId Thread whose receipt advances.
 * @param itemIds Eligible completed message identities validated by the caller.
 * @returns Stored union in deterministic serialization order.
 * @throws When identifiers or required stored content are invalid, or SQLite fails.
 */
export function advanceThreadReadReceipt(
  userDb: UserDb,
  workspaceId: string,
  threadId: string,
  itemIds: readonly string[]
): string[] {
  const observedItemIds = itemIdsSchema.parse(itemIds);
  if (observedItemIds.length === 0) {
    return readThreadReadReceipt(userDb, workspaceId, threadId);
  }

  return userDb.sqlite
    .transaction(() => {
      const previous = readThreadReadReceipt(userDb, workspaceId, threadId);
      const union = [...new Set([...previous, ...observedItemIds])].sort();
      if (union.length !== previous.length) {
        userDb.sqlite
          .prepare(
            `INSERT INTO thread_read_receipts (workspace_id, thread_id, item_ids_json)
           VALUES (?, ?, ?)
           ON CONFLICT (workspace_id, thread_id) DO UPDATE SET item_ids_json = excluded.item_ids_json`
          )
          .run(workspaceId, threadId, JSON.stringify(union));
      }
      return union;
    })
    .immediate();
}
