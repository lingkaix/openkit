import { type ActorRef, writeRetainedV1 } from '@openkit/protocol';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type { SecurityItemKey } from '../../security/identifiers.js';
import type { SecurityAuditAction, SecurityAuditMissingField } from '../security-trigger-codecs.js';

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

/** Private append position plus original public source cursor; never caller-resettable. */
export const securityTriggerAuditProgress = sqliteTable('security_trigger_audit_progress', {
  singleton: integer('singleton').primaryKey(),
  schemaVersion: integer('schema_version').notNull().default(writeRetainedV1({}).schemaVersion),
  cursorRowId: integer('cursor_rowid'),
  cursorCreatedAt: text('cursor_created_at'),
  cursorAuditEventId: text('cursor_audit_event_id'),
  assessedCount: integer('assessed_count').notNull().default(0),
});

/** Original Audit facts and the exact initial native decision/recipient-count snapshot. */
export const securityTriggerAuditAssessments = sqliteTable(
  'security_trigger_audit_assessments',
  {
    auditEventId: text('audit_event_id').primaryKey(),
    schemaVersion: integer('schema_version').notNull().default(writeRetainedV1({}).schemaVersion),
    sourceRowId: integer('source_rowid').notNull(),
    createdAt: text('created_at').notNull(),
    enableGeneration: integer('enable_generation').notNull(),
    action: text('action').$type<SecurityAuditAction>().notNull(),
    actor: text('actor_json', { mode: 'json' }).$type<ActorRef | null>(),
    targetUserId: text('target_user_id'),
    outcome: text('outcome', {
      enum: ['succeeded', 'failed', 'denied', 'cancelled', 'unknown'],
    }).notNull(),
    responsibleUserId: text('responsible_user_id').notNull(),
    status: text('status', { enum: ['detected', 'unsupported'] }).notNull(),
    rule: text('rule', { enum: ['R1', 'R1d'] }),
    notify: text('notify', { enum: ['immediate', 'daily'] }),
    missingFields: text('missing_fields_json', { mode: 'json' })
      .$type<SecurityAuditMissingField[]>()
      .notNull(),
    recipientCount: integer('recipient_count').notNull(),
  },
  (t) => [
    uniqueIndex('security_trigger_assessment_source').on(t.sourceRowId),
    index('security_trigger_assessment_page').on(t.createdAt, t.auditEventId),
  ]
);

/** Original E4 notice identity inputs; publication and acknowledgement remain downstream. */
export const securityTriggerOutbox = sqliteTable(
  'security_trigger_outbox',
  {
    requestId: text('request_id').primaryKey(),
    schemaVersion: integer('schema_version').notNull().default(writeRetainedV1({}).schemaVersion),
    alarmId: text('alarm_id').references(() => securityTriggerAlarms.id),
    auditEventId: text('audit_event_id').references(
      () => securityTriggerAuditAssessments.auditEventId
    ),
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
    index('security_trigger_outbox_event').on(t.auditEventId),
    index('security_trigger_outbox_pending').on(t.raised, t.createdAt, t.requestId),
    uniqueIndex('security_trigger_outbox_occurrence').on(
      t.key,
      t.recipientUserId,
      t.occurrenceKind,
      t.occurrenceN
    ),
  ]
);
