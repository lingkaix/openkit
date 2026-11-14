import { writeRetainedV1 } from '@openkit/protocol';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type { SecurityItemKey } from '../../security/identifiers.js';

/** One closed Server trigger; the physical Core home is its only owner. */
export const securityTriggerState = sqliteTable('security_trigger_state', {
  singleton: integer('singleton').primaryKey(),
  schemaVersion: integer('schema_version').notNull().default(writeRetainedV1({}).schemaVersion),
  state: text('state', { enum: ['off', 'on', 'stopping'] })
    .notNull()
    .default('off'),
  enableGeneration: integer('enable_generation').notNull().default(0),
  enablingUserId: text('enabling_user_id'),
  expectedAlarmCount: integer('expected_alarm_count').notNull().default(0),
});

/** Original stop/loss intent, including the explicit failure when no recipient is current. */
export const securityTriggerAlarms = sqliteTable(
  'security_trigger_alarms',
  {
    id: text('id').primaryKey(),
    schemaVersion: integer('schema_version').notNull().default(writeRetainedV1({}).schemaVersion),
    enableGeneration: integer('enable_generation').notNull(),
    rule: text('rule', { enum: ['R1', 'R8'] }).notNull(),
    recipientCount: integer('recipient_count').notNull(),
    failure: text('failure', { enum: ['no-current-administrator'] }),
    createdAt: text('created_at').notNull(),
  },
  (t) => [uniqueIndex('security_trigger_alarm_generation_rule').on(t.enableGeneration, t.rule)]
);

/** Original E4 notice identity inputs; publication and acknowledgement remain downstream. */
export const securityTriggerOutbox = sqliteTable(
  'security_trigger_outbox',
  {
    requestId: text('request_id').primaryKey(),
    schemaVersion: integer('schema_version').notNull().default(writeRetainedV1({}).schemaVersion),
    alarmId: text('alarm_id').references(() => securityTriggerAlarms.id),
    key: text('key_json', { mode: 'json' }).$type<SecurityItemKey>().notNull(),
    recipientUserId: text('recipient_user_id').notNull(),
    occurrenceKind: text('occurrence_kind', {
      enum: ['initial', 'reopen', 'reminder', 'renotice', 'conflict'],
    }).notNull(),
    occurrenceN: integer('occurrence_n').notNull(),
    raised: integer('raised', { mode: 'boolean' }).notNull().default(false),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    index('security_trigger_outbox_alarm').on(t.alarmId),
    index('security_trigger_outbox_pending').on(t.raised, t.createdAt, t.requestId),
    uniqueIndex('security_trigger_outbox_occurrence').on(
      t.key,
      t.recipientUserId,
      t.occurrenceKind,
      t.occurrenceN
    ),
  ]
);
