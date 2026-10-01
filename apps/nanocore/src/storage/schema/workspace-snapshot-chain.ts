import { sql } from 'drizzle-orm';
import { blob, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/** Accepted materialized base and independent captured snapshot cursor for one admitted volume slot. */
export const workspaceSnapshotCursors = sqliteTable(
  'workspace_snapshot_cursors',
  {
    /** Workspace lineage owner. */
    workspaceId: text('workspace_id').notNull(),
    /** Exact retained storage association. */
    storageRef: text('storage_ref').notNull(),
    /** Stable work slot within this association. */
    workSlot: text('work_slot').notNull(),
    /** Accepted private-store tree and permission-manifest pair. */
    acceptedBaseJson: text('accepted_base_json'),
    /** Last captured pair, independent of review-branch commits. */
    headJson: text('head_json'),
    /** Exact first initialization identity for baseline replay only. */
    baselineIdentityJson: text('baseline_identity_json').notNull(),
    /** Comparable Core Git commit for the accepted tree, distinct from the captured cursor. */
    acceptedCommit: text('accepted_commit'),
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.storageRef, table.workSlot] })]
);
/** Immutable collection receipts; links, unchanged receipts and cumulative bytes share this owner. */
export const workspaceSnapshotCollections = sqliteTable(
  'workspace_snapshot_collections',
  {
    /** Workspace lineage owner. */
    workspaceId: text('workspace_id').notNull(),
    /** Exact retained storage association. */
    storageRef: text('storage_ref').notNull(),
    /** Stable work slot within this association. */
    workSlot: text('work_slot').notNull(),
    /** Exact lifecycle-bound collection identity. */
    collectionId: text('collection_id').notNull(),
    /** Association, attachment and Turn lineage, without check values. */
    identityJson: text('identity_json').notNull(),
    /** Verified scan result and stability. */
    resultJson: text('result_json').notNull(),
    /** Exact cumulative native candidate, only after the credential check passed. */
    candidate: blob('candidate', { mode: 'buffer' }),
    /** Changed or unstable observation link; stable unchanged receipts have no link. */
    isLink: integer('is_link').notNull(),
    /** Actual durable review change set linked to this captured candidate, if a destination exists. */
    changeSetId: text('change_set_id'),
  },
  (table) => [
    primaryKey({
      columns: [table.workspaceId, table.storageRef, table.workSlot, table.collectionId],
    }),
    uniqueIndex('workspace_snapshot_collection_review_idx')
      .on(table.workspaceId, table.changeSetId)
      .where(sql`${table.changeSetId} IS NOT NULL`),
  ]
);
