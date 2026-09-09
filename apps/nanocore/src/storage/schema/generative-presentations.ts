import { index, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/** Immutable native Generative UI presentation revisions. */
export const generativePresentations = sqliteTable(
  'generative_presentations',
  {
    /** Core-assigned presentation identity. */
    presentationId: text('presentation_id').notNull(),
    /** Workspace that owns the presentation. */
    workspaceId: text('workspace_id').notNull(),
    /** Destination Thread. */
    threadId: text('thread_id').notNull(),
    /** Destination Turn. */
    turnId: text('turn_id').notNull(),
    /** Reserved Item identity for publication. */
    itemId: text('item_id').notNull(),
    /** ISO timestamp for admission. */
    createdAt: text('created_at').notNull(),
    /** Trusted actor JSON. */
    actorJson: text('actor_json').notNull(),
    /** Local admission request id; null after portable import. */
    requestId: text('request_id'),
    /** Non-authorizing imported origin request id. */
    originRequestId: text('origin_request_id'),
    /** SHA-256 of producer semantic input. */
    semanticInputHash: text('semantic_input_hash').notNull(),
    /** Presentation title. */
    title: text('title').notNull(),
    /** Safe text fallback. */
    fallbackText: text('fallback_text').notNull(),
    /** Retained A2UI protocol version. */
    protocolVersion: text('protocol_version').notNull(),
    /** Host catalog identity. */
    catalogId: text('catalog_id').notNull(),
    /** Exact accepted three-message JSON array. */
    messagesJson: text('messages_json').notNull(),
    /** SHA-256 of accepted messages. */
    contentDigest: text('content_digest').notNull(),
    /** Admitted source JSON. */
    sourceJson: text('source_json').notNull(),
    /** Admitted action JSON. */
    actionsJson: text('actions_json').notNull(),
    /** Historical observation timestamp. */
    observedAt: text('observed_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.presentationId] }),
    index('generative_presentations_thread_idx').on(
      table.workspaceId,
      table.threadId,
      table.createdAt,
      table.presentationId
    ),
  ]
);
