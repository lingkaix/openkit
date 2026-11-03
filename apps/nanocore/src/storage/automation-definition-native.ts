import { nextRecurringNominal } from '../lib/recurring-cadence.js';

export { nextRecurringNominal } from '../lib/recurring-cadence.js';

import {
  type AutomationRecord,
  type CreateAutomationRequest,
  CreateAutomationRequestSchema,
  type UpdateAutomationRequest,
  UpdateAutomationRequestSchema,
} from '@openkit/app-api-schemas';
import {
  allocateEntityId,
  deriveEntityId,
  readRetainedV1,
  writeRetainedV1,
} from '@openkit/protocol';
import { recordServerAuditEvent } from '../audit-events.js';
import {
  type advanceRecurringNominal,
  RecurringCadenceExhaustedError,
  recurringNominalMatches,
  recurringPrefixThrough,
} from '../lib/recurring-cadence.js';
import type { CoreDb } from './db.js';
import {
  findRecurringAutomationFromDb,
  finishRecurringOccurrenceInDb,
  writeRecurringOccurrenceInDb,
} from './recurring-attempt-native.js';
import {
  RECURRING_DEADLINE_MS as DEADLINE_MS,
  type ExpiredOccurrenceRange,
  type RecurringOccurrence,
  readRecurringOccurrence,
  readRecurringSchedule,
  recurringRequestId,
} from './recurring-records.js';
import { StoredAutomationCadenceV1Schema } from './recurring-retained-v1.js';
import {
  type AutomationDefinitionMutation,
  AutomationMutationError,
  AutomationRecordNotFoundError,
} from './scheduler-admission-codecs.js';

/** Decides exactly one definition tuple within the caller's existing transaction or native savepoint. */
export function applyAutomationDefinitionInDb(
  db: CoreDb,
  userId: string,
  mutation: AutomationDefinitionMutation,
  timestamp: string
): AutomationRecord | null {
  if (mutation.action === 'create')
    return createAutomationDefinition(db, userId, mutation.id, mutation.input, timestamp);
  if (mutation.action === 'update')
    return updateAutomationDefinition(db, userId, mutation.id, mutation.input, timestamp);
  deleteAutomationDefinition(db, userId, mutation.id, timestamp);
  return null;
}
/** Reads the existing immutable definition identity before its current lifecycle decision. */
function requireAutomationDefinition(db: CoreDb, id: string): AutomationRecord {
  const record = findRecurringAutomationFromDb(db, id);
  if (!record) throw new AutomationRecordNotFoundError(`Automation not found: ${id}`);
  return record;
}

/** Creates the original paused definition and caller Audit atomically. */
function createAutomationDefinition(
  db: CoreDb,
  userId: string,
  id: string,
  value: CreateAutomationRequest,
  timestamp: string
): AutomationRecord {
  const input = CreateAutomationRequestSchema.strict().parse(value);
  if (input.intervalSeconds !== undefined) requireRecurringSuccessor(input, Date.parse(timestamp));
  const record: AutomationRecord = {
    ...input,
    id,
    responsibleUserId: userId,
    actor: { kind: 'automation', id, responsibleUserId: userId },
    status: 'paused',
    revision: 1,
    nextScheduledAt: null,
    greatestAccountedScheduledAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    deletedAt: null,
  };
  writeRecurringScheduleInDb(db, record, true);
  auditAutomationDefinition(db, record, userId, 'create');
  return record;
}

/** Revalidates revision and seals only the original cadence inside the deciding section. */
function updateAutomationDefinition(
  db: CoreDb,
  userId: string,
  automationId: string,
  value: UpdateAutomationRequest,
  timestamp: string
): AutomationRecord {
  const input = UpdateAutomationRequestSchema.strict().parse(value);
  let schedule = requireAutomationDefinition(db, automationId);
  if (schedule.status === 'deleted' || schedule.revision !== input.expectedRevision)
    throw new AutomationMutationError('Recurring schedule revision or lifecycle conflicts.');
  const { expectedRevision: _revision, status, scheduledAt, ...edits } = input;
  const editing = Object.keys(edits).length > 0;
  if (!editing && status === undefined)
    throw new AutomationMutationError('A recurring schedule mutation is required.');
  if (editing && (schedule.status !== 'paused' || status === 'active'))
    throw new AutomationMutationError('Edit requires a paused recurring schedule.');
  if (status === 'active') {
    // Date.parse truncates finer precision, so authored monthly fractions need an exact zero check.
    if (
      schedule.status !== 'paused' ||
      !scheduledAt ||
      !recurringNominalMatches(schedule, Date.parse(scheduledAt)) ||
      (schedule.monthlyUtc !== undefined && /\.[0-9]*[1-9][0-9]*Z$/.test(scheduledAt)) ||
      Date.parse(scheduledAt) < Date.parse(timestamp) ||
      (schedule.greatestAccountedScheduledAt !== null &&
        Date.parse(scheduledAt) <= Date.parse(schedule.greatestAccountedScheduledAt))
    )
      throw new AutomationMutationError('Resume requires a new current-or-future nominal instant.');
    schedule = {
      ...schedule,
      status,
      nextScheduledAt: new Date(scheduledAt).toISOString(),
    };
    requireRecurringSuccessor(schedule, Date.parse(scheduledAt));
  } else {
    if (scheduledAt !== undefined)
      throw new AutomationMutationError('A nominal instant is accepted only on resume.');
    if (status === 'paused') schedule = sealRecurringSchedule(db, schedule, timestamp);
    const candidate = { ...schedule, ...edits };
    if (edits.monthlyUtc !== undefined) delete candidate.intervalSeconds;
    if (edits.intervalSeconds !== undefined) delete candidate.monthlyUtc;
    for (const field of ['agentId', 'profileId', 'modelId'] as const)
      if (candidate[field] === null) delete candidate[field];
    schedule = readRecurringSchedule(JSON.stringify(candidate));
    if (edits.intervalSeconds !== undefined)
      requireRecurringSuccessor(schedule, Date.parse(timestamp));
  }
  const updated = { ...schedule, revision: schedule.revision + 1, updatedAt: timestamp };
  writeRecurringScheduleInDb(db, updated);
  auditAutomationDefinition(
    db,
    updated,
    userId,
    status === 'active' ? 'resume' : status === 'paused' ? 'pause' : 'edit'
  );
  return updated;
}

/** Retains the exact terminal tombstone without cancelling accepted work. */
function deleteAutomationDefinition(
  db: CoreDb,
  userId: string,
  automationId: string,
  timestamp: string
): void {
  let schedule = requireAutomationDefinition(db, automationId);
  if (schedule.status === 'deleted') return;
  schedule = sealRecurringSchedule(db, schedule, timestamp);
  const deleted: AutomationRecord = {
    ...schedule,
    status: 'deleted',
    revision: schedule.revision + 1,
    updatedAt: timestamp,
    deletedAt: timestamp,
  };
  writeRecurringScheduleInDb(db, deleted);
  auditAutomationDefinition(db, deleted, userId, 'delete');
}

/** Seals all old-cadence instants through the mutation time before pause, edit or delete. */
function sealRecurringSchedule(
  db: CoreDb,
  schedule: AutomationRecord,
  timestamp: string
): AutomationRecord {
  const now = Date.parse(timestamp);
  if (schedule.status === 'active' && schedule.nextScheduledAt) {
    schedule = accountRecurringExpiredPrefix(db, schedule, now, timestamp);
    const first = schedule.nextScheduledAt === null ? null : Date.parse(schedule.nextScheduledAt);
    for (let at = first; at !== null && at <= now; at = nextRecurringNominal(schedule, at)) {
      const occurrence = newRecurringOccurrence(schedule, at, timestamp);
      finishRecurringOccurrenceInDb(db, occurrence, 'cancelled', timestamp, true);
      schedule = advanceRecurringSchedule(db, schedule, at);
    }
  }
  for (const row of db.sqlite
    .prepare(`SELECT schema_version AS schemaVersion, record_json FROM recurring_occurrences
    WHERE schedule_id = ? AND state = 'pending'`)
    .all(schedule.id) as JsonRow[])
    finishRecurringOccurrenceInDb(
      db,
      readRetainedV1(row, () => readRecurringOccurrence(row.record_json)),
      'cancelled',
      timestamp
    );
  return { ...schedule, status: 'paused', nextScheduledAt: null };
}

/** Records one exact old prefix and moves the same definition cursor atomically. */
export function accountRecurringExpiredPrefix(
  db: CoreDb,
  schedule: AutomationRecord,
  now: number,
  timestamp: string,
  onError?: (error: unknown) => void
): AutomationRecord {
  if (!schedule.nextScheduledAt) return schedule;
  const first = Date.parse(schedule.nextScheduledAt);
  if (first > now - DEADLINE_MS) return schedule;
  const coverage = recurringPrefixThrough(schedule, first, now - DEADLINE_MS);
  if (!coverage) return schedule;
  const { count, last } = coverage;
  const record: ExpiredOccurrenceRange = {
    id: allocateEntityId('range'),
    scheduleId: schedule.id,
    workspaceId: schedule.workspaceId,
    definitionRevision: schedule.revision,
    ...StoredAutomationCadenceV1Schema.parse(schedule),
    firstScheduledAt: new Date(first).toISOString(),
    lastScheduledAt: new Date(last).toISOString(),
    count,
    snapshot: snapshot(schedule),
    reason: 'deadline_elapsed',
    createdAt: timestamp,
    terminalAt: timestamp,
  };
  db.sqlite
    .prepare(`INSERT INTO recurring_expired_ranges
    (id, schedule_id, workspace_id, definition_revision, first_scheduled_at, last_scheduled_at, record_json, schema_version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      record.id,
      record.scheduleId,
      record.workspaceId,
      record.definitionRevision,
      first,
      last,
      JSON.stringify(record),
      writeRetainedV1({}).schemaVersion
    );
  recordServerAuditEvent({
    coreDb: db,
    workspaceId: schedule.workspaceId,
    actor: schedule.actor,
    threadId: schedule.threadId,
    action: 'recurring.expired-range.record',
    resource: record.id,
    resourceRevision: schedule.revision,
    outcome: 'failed',
    summary: `Expired nominal range ${record.firstScheduledAt} through ${record.lastScheduledAt}; count ${count}.`,
    now: new Date(timestamp),
  });
  return advanceRecurringSchedule(db, schedule, last, onError);
}

/** Refuses new cadence authority when its actual admission anchor has no valid successor. */
function requireRecurringSuccessor(
  cadence: Parameters<typeof advanceRecurringNominal>[0],
  at: number
): void {
  if (nextRecurringNominal(cadence, at) === null)
    throw new AutomationMutationError('Recurring cadence has no representable UTC successor.');
}

/** Advances the exact nominal cadence, retaining its final instant when the calendar ends. */
export function advanceRecurringSchedule(
  db: CoreDb,
  schedule: AutomationRecord,
  at: number,
  onError?: (error: unknown) => void
): AutomationRecord {
  const next = nextRecurringNominal(schedule, at, onError);
  const updated = {
    ...schedule,
    greatestAccountedScheduledAt: new Date(at).toISOString(),
    nextScheduledAt: next === null ? null : new Date(next).toISOString(),
  };
  writeRecurringScheduleInDb(db, updated);
  return updated;
}

/** Captures immutable authored inputs before any bounded preparation starts. */
export function newRecurringOccurrence(
  schedule: AutomationRecord,
  at: number,
  timestamp: string
): RecurringOccurrence {
  const scheduledAt = new Date(at).toISOString();
  const requestId = recurringRequestId(schedule.id, scheduledAt);
  return {
    id: deriveEntityId('occ', [schedule.id, scheduledAt]),
    requestId,
    scheduleId: schedule.id,
    workspaceId: schedule.workspaceId,
    definitionRevision: schedule.revision,
    scheduledAt,
    deadline: new Date(at + DEADLINE_MS).toISOString(),
    snapshot: snapshot(schedule),
    resolvedPayload: null,
    state: 'pending',
    attempts: [],
    queueEntryId: null,
    turnId: null,
    createdAt: timestamp,
    terminalAt: null,
  };
}

/** Attributes a definition mutation to its actual caller in the same Core transaction. */
function auditAutomationDefinition(
  db: CoreDb,
  schedule: AutomationRecord,
  userId: string,
  action: 'create' | 'edit' | 'pause' | 'resume' | 'delete'
): void {
  recordServerAuditEvent({
    coreDb: db,
    workspaceId: schedule.workspaceId,
    actor: { kind: 'user', id: userId },
    threadId: schedule.threadId,
    category: 'command',
    action: `recurring.schedule.${action}`,
    resource: schedule.id,
    resourceRevision: schedule.revision,
    outcome: 'succeeded',
    summary: `Recurring schedule ${action}.`,
    now: new Date(schedule.updatedAt),
  });
}

/** Writes one definition and the indexed cursor under the caller's transaction when present. */
function writeRecurringScheduleInDb(db: CoreDb, record: AutomationRecord, insert = false): void {
  readRecurringSchedule(JSON.stringify(record));
  if (!insert) requireAutomationDefinition(db, record.id);
  const values = [
    record.workspaceId,
    record.responsibleUserId,
    record.status,
    record.revision,
    record.nextScheduledAt === null ? null : Date.parse(record.nextScheduledAt),
    JSON.stringify(record),
  ];
  if (insert)
    db.sqlite
      .prepare(`INSERT INTO recurring_schedules
    (workspace_id, responsible_user_id, status, revision, next_scheduled_at, record_json, id, schema_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(...values, record.id, writeRetainedV1({}).schemaVersion);
  else
    db.sqlite
      .prepare(`UPDATE recurring_schedules SET workspace_id = ?, responsible_user_id = ?,
    status = ?, revision = ?, next_scheduled_at = ?, record_json = ? WHERE id = ?`)
      .run(...values, record.id);
}

type JsonRow = { schemaVersion: unknown; record_json: string };
/** Preserves the exact old authored request in each occurrence and missed-history range. */
function snapshot(schedule: AutomationRecord): RecurringOccurrence['snapshot'] {
  return {
    threadId: schedule.threadId,
    actor: schedule.actor,
    prompt: schedule.prompt,
    ...(schedule.monthlyUtc === undefined ? {} : { monthlyUtc: { ...schedule.monthlyUtc } }),
    ...(schedule.agentId === undefined ? {} : { agentId: schedule.agentId }),
    ...(schedule.profileId === undefined ? {} : { profileId: schedule.profileId }),
    ...(schedule.modelId === undefined ? {} : { modelId: schedule.modelId }),
  };
}
