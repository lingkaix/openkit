import { sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Records committed storage migrations applied to one data root.
 */
export const schemaMigrations = sqliteTable('schema_migrations', {
  /** Stable migration identifier. */
  id: text('id').primaryKey(),
  /** ISO timestamp for when the migration was applied. */
  appliedAt: text('applied_at').notNull(),
});
