import { sql } from 'drizzle-orm';
import { check, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { schedulerAdmissionEntries } from './scheduler-admission-entries.js';

/** Immutable Core join; schedule and ordinary scheduler records retain all other event work facts. */
export const externalTriggerAdmissions = sqliteTable(
  'external_trigger_admissions',
  {
    /** Schedule whose selected source scopes the event key. */
    scheduleId: text('schedule_id').notNull(),
    /** Opaque stable source identity, distinct from Core entity identifiers. */
    eventKey: text('event_key').notNull(),
    /** Original accepted poll Turn; one poll can admit several distinct events. */
    sourceTurnId: text('source_turn_id').notNull(),
    /** Ordinary scheduler admission owning the accepted Worker work. */
    queueEntryId: text('queue_entry_id')
      .notNull()
      .references(() => schedulerAdmissionEntries.queueEntryId),
  },
  (table) => [
    primaryKey({ columns: [table.scheduleId, table.eventKey] }),
    check(
      'external_trigger_admissions_event_key_check',
      sql`length(${table.eventKey}) BETWEEN 1 AND 1024`
    ),
  ]
);
