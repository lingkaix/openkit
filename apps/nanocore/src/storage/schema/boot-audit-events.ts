import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Durable server-scope audit row for one NanoCore boot lifecycle event.
 */
export const bootAuditEvents = sqliteTable(
  'boot_audit_events',
  {
    /** Stable event id for this boot lifecycle row. */
    bootEventId: text('boot_event_id').primaryKey().notNull(),
    /** Process boot id. */
    bootId: text('boot_id').notNull(),
    /** Stable audit event type. */
    eventType: text('event_type').notNull(),
    /** Overall boot readiness outcome. */
    outcome: text('outcome').notNull(),
    /** Whether unrelated product work may be admitted. */
    acceptingProductWork: integer('accepting_product_work').notNull(),
    /** JSON snapshot of boot phase outcomes. */
    phaseOutcomesJson: text('phase_outcomes_json').notNull(),
    /** JSON snapshot of computed boot readiness. */
    readinessJson: text('readiness_json').notNull(),
    /** ISO timestamp for event creation. */
    createdAt: text('created_at').notNull(),
  },
  (table) => [index('boot_audit_events_boot_idx').on(table.bootId, table.createdAt)]
);
