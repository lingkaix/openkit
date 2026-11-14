import { writeRetainedV1 } from '@openkit/protocol';
import { integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { securityTriggerOutbox } from './security-trigger.js';

/** Original native generation and publication progress; actual Thread bytes stay in its Workspace. */
export const securityThreadDestinations = sqliteTable(
  'security_thread_destinations',
  {
    schemaVersion: integer('schema_version').notNull().default(writeRetainedV1({}).schemaVersion),
    recipientUserId: text('recipient_user_id').notNull(),
    generation: integer('generation').notNull(),
    workspaceId: text('workspace_id').notNull(),
    threadId: text('thread_id').notNull(),
    sourceRequestId: text('source_request_id')
      .notNull()
      .references(() => securityTriggerOutbox.requestId),
    status: text('status', { enum: ['reserved', 'ready'] }).notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.recipientUserId, t.generation] }),
    uniqueIndex('security_thread_destination_thread').on(t.threadId),
  ]
);
