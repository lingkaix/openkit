import { writeRetainedV1 } from '@openkit/protocol';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Stores server-owned JSON settings keyed by name, including singleton values and per-user keys.
 */
export const serverSettings = sqliteTable('server_settings', {
  /** Setting key. */
  key: text('key').primaryKey(),
  /** Independent retained format for the setting's owned JSON payload. */
  schemaVersion: integer('schema_version').notNull().default(writeRetainedV1({}).schemaVersion),
  /** JSON setting value serialized by Drizzle. */
  value: text('value', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  /** ISO timestamp for the latest write. */
  updatedAt: text('updated_at').notNull(),
});
