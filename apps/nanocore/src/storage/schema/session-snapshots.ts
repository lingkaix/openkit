import { index, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/** Durable agent session snapshot kinds. */
export type SessionSnapshotKind = 'runtime-handle' | 'backend-snapshot' | 'serialized-state';

/** Durable agent session snapshot lifecycle status. */
export type SessionSnapshotStatus = 'available' | 'expired' | 'invalidated' | 'consumed-by-restore';

/** Server-scoped durable agent session snapshot rows. */
export const sessionSnapshots = sqliteTable(
  'session_snapshots',
  {
    /** Stable snapshot id. */
    snapshotId: text('snapshot_id').primaryKey().notNull(),
    /** Source agent session id. */
    agentSessionId: text('agent_session_id').notNull(),
    /** Workspace lineage id. */
    workspaceId: text('workspace_id').notNull(),
    /** Optional thread affinity lineage id. */
    threadId: text('thread_id'),
    /** Turn lineage id that triggered the snapshot. */
    turnId: text('turn_id').notNull(),
    /** Agent Environment Package snapshot id captured at snapshot time. */
    aepSnapshotId: text('aep_snapshot_id').notNull(),
    /** Snapshot storage mechanism. */
    snapshotKind: text('snapshot_kind').$type<SessionSnapshotKind>().notNull(),
    /** Redacted adapter handle reference. */
    backendHandleRef: text('backend_handle_ref').notNull(),
    /** Strict V1 compatibility key captured at snapshot time. */
    sessionCompatibilityKey: text('session_compatibility_key').notNull(),
    /** Optional backend content digest. */
    contentDigest: text('content_digest'),
    /** Snapshot creation timestamp. */
    createdAt: text('created_at').notNull(),
    /** Snapshot expiry timestamp. */
    expiresAt: text('expires_at').notNull(),
    /** Snapshot lifecycle status. */
    status: text('status').$type<SessionSnapshotStatus>().notNull(),
  },
  (table) => [
    index('session_snapshots_workspace_idx').on(
      table.workspaceId,
      table.threadId,
      table.status,
      table.expiresAt
    ),
    index('session_snapshots_compatibility_idx').on(
      table.sessionCompatibilityKey,
      table.status,
      table.expiresAt
    ),
  ]
);
