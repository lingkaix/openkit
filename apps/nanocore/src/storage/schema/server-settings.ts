import { sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Stores singleton server-level settings as JSON payloads.
 */
export const serverSettings = sqliteTable('server_settings', {
  /** Setting key. */
  key: text('key').primaryKey(),
  /** JSON setting value serialized by Drizzle. */
  value: text('value', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  /** ISO timestamp for the latest write. */
  updatedAt: text('updated_at').notNull(),
});
