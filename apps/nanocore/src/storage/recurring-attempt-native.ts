import type { AutomationRecord } from '@openkit/app-api-schemas';
import { deriveEntityId, readRetainedV1, writeRetainedV1 } from '@openkit/protocol';
import { recordServerAuditEvent } from '../audit-events.js';
import { currentWorkspaceAuthority } from '../auth/operation-authorizer.js';
import {
  createSchedulerAdmissionEntry,
  requireSchedulerAdmissionEntry,
  SchedulerAdmissionTransitionError,
  schedulerAdmissionInputHash,
} from '../scheduler-records.js';
import { assertControlProductWriter } from './control-store-products.js';
import type { CoreDb } from './db.js';
import {
  RecurringAdmissionPayloadSchema,
  type RecurringOccurrence,
  readRecurringOccurrence,
  readRecurringSchedule,
  recurringSchedulerAdmissionInput,
} from './recurring-records.js';
import {
  AutomationRecordNotFoundError,
  type ControlSchedulerAdmission,
} from './scheduler-admission-codecs.js';

type JsonRow = { schemaVersion: unknown; record_json: string };
/** The existing exact recurring occurrence read. */
export function readRecurringOccurrenceFromDb(coreDb: CoreDb, id: string): RecurringOccurrence {
  const row = coreDb.sqlite
    .prepare(
      'SELECT schema_version AS schemaVersion, record_json FROM recurring_occurrences WHERE id = ?'
    )
    .get(id) as JsonRow | undefined;
  if (!row) throw new AutomationRecordNotFoundError(`Recurring occurrence not found: ${id}`);
  return readRetainedV1(row, () => readRecurringOccurrence(row.record_json));
}
/** The existing single-definition read. */
export function findRecurringAutomationFromDb(coreDb: CoreDb, id: string): AutomationRecord | null {
  const row = coreDb.sqlite
    .prepare(
      'SELECT schema_version AS schemaVersion, record_json FROM recurring_schedules WHERE id = ?'
    )
    .get(id) as JsonRow | undefined;
  return row ? readRetainedV1(row, () => readRecurringSchedule(row.record_json)) : null;
}
/** Requires the same definition owner as the Main projection. */
function requireRecurringAutomationFromDb(coreDb: CoreDb, id: string): AutomationRecord {
  const record = findRecurringAutomationFromDb(coreDb, id);
  if (!record) throw new AutomationRecordNotFoundError(`Automation not found: ${id}`);
  return record;
}
/** Original occurrence publication shared by the scanner and native attempt tuple. */
export function writeRecurringOccurrenceInDb(
  coreDb: CoreDb,
  record: RecurringOccurrence,
  insert = false
): void {
  readRecurringOccurrence(JSON.stringify(record));
  if (!insert) readRecurringOccurrenceFromDb(coreDb, record.id);
  if (insert)
    coreDb.sqlite
      .prepare(`INSERT INTO recurring_occurrences
      (id, schedule_id, workspace_id, scheduled_at, deadline, state, queue_entry_id, record_json, schema_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        record.id,
        record.scheduleId,
        record.workspaceId,
        Date.parse(record.scheduledAt),
        Date.parse(record.deadline),
        record.state,
        record.queueEntryId,
        JSON.stringify(record),
        writeRetainedV1({}).schemaVersion
      );
  else
    coreDb.sqlite
      .prepare(
        `UPDATE recurring_occurrences SET state = ?, queue_entry_id = ?, record_json = ? WHERE id = ?`
      )
      .run(record.state, record.queueEntryId, JSON.stringify(record), record.id);
}
/** Original terminal occurrence plus Audit tuple. */
export function finishRecurringOccurrenceInDb(
  coreDb: CoreDb,
  occurrence: RecurringOccurrence,
  state: RecurringOccurrence['state'],
  timestamp: string,
  insert = false
): RecurringOccurrence {
  const updated = { ...occurrence, state, terminalAt: timestamp };
  writeRecurringOccurrenceInDb(coreDb, updated, insert);
  recordServerAuditEvent({
    coreDb: coreDb,
    workspaceId: occurrence.workspaceId,
    actor: occurrence.snapshot.actor,
    threadId: occurrence.snapshot.threadId,
    // Core acceptance reserves a Turn identity; it does not prove canonical file publication.
    turnId: null,
    requestId: occurrence.requestId,
    action: 'recurring.occurrence.terminal',
    resource: occurrence.id,
    outcome:
      state === 'admission-accepted'
        ? 'succeeded'
        : state === 'cancelled'
          ? 'cancelled'
          : state === 'recovery_required'
            ? 'unknown'
            : 'failed',
    summary: `Recurring occurrence terminal: ${state}.`,
    now: new Date(timestamp),
  });
  return updated;
}
/** One complete recurring attempt, original queue acceptance and terminal Audit on the native savepoint. */
export function applyNativeRecurringAttempt(
  coreDb: CoreDb,
  input: Extract<ControlSchedulerAdmission, { mode: 'recurring-attempt' }>
): RecurringOccurrence | null {
  assertControlProductWriter(coreDb.sqlite);
  const { occurrenceId, definitionRevision, preparation } = input;
  return coreDb.sqlite
    .transaction(() => {
      let occurrence = readRecurringOccurrenceFromDb(coreDb, occurrenceId);
      if (occurrence.state !== 'pending') return occurrence;
      const schedule = requireRecurringAutomationFromDb(coreDb, occurrence.scheduleId);
      if (
        schedule.status !== 'active' ||
        schedule.revision !== definitionRevision ||
        occurrence.definitionRevision !== definitionRevision
      )
        return null;
      const timestamp = input.timestamp;
      const now = Date.parse(timestamp);
      if (now < Date.parse(occurrence.scheduledAt)) return occurrence;
      if (now >= Date.parse(occurrence.deadline))
        return finishRecurringOccurrenceInDb(coreDb, occurrence, 'expired', timestamp);
      const payload =
        preparation.kind === 'ready' || preparation.kind === 'failure'
          ? preparation.payload
          : undefined;
      const resolved =
        occurrence.resolvedPayload ??
        (payload ? RecurringAdmissionPayloadSchema.parse(payload) : null);
      if (
        occurrence.resolvedPayload &&
        payload &&
        JSON.stringify(RecurringAdmissionPayloadSchema.parse(payload)) !==
          JSON.stringify(occurrence.resolvedPayload)
      )
        return finishRecurringOccurrenceInDb(coreDb, occurrence, 'recovery_required', timestamp);
      const request = resolved
        ? recurringSchedulerAdmissionInput(occurrence, resolved, timestamp)
        : null;
      const ownQueues = coreDb.sqlite
        .prepare(`SELECT queue_entry_id FROM scheduler_admission_entries
        WHERE queue_entry_id = ? OR request_id = ? OR turn_id = ? LIMIT 2`)
        .all(
          occurrence.requestId,
          occurrence.requestId,
          deriveEntityId('tu', ['recurring', occurrence.scheduleId, occurrence.scheduledAt])
        ) as { queue_entry_id: string }[];
      if (ownQueues.length > 1)
        return finishRecurringOccurrenceInDb(coreDb, occurrence, 'recovery_required', timestamp);
      if (ownQueues[0]) {
        const existing = requireSchedulerAdmissionEntry(coreDb, ownQueues[0].queue_entry_id);
        if (
          !request ||
          existing.queueEntryId !== request.queueEntryId ||
          existing.inputHash !== schedulerAdmissionInputHash(request) ||
          schedulerAdmissionInputHash(existing) !== schedulerAdmissionInputHash(request)
        )
          return finishRecurringOccurrenceInDb(coreDb, occurrence, 'recovery_required', timestamp);
        occurrence = {
          ...occurrence,
          resolvedPayload: resolved,
          queueEntryId: existing.queueEntryId,
          turnId: existing.turnId,
        };
        return finishRecurringOccurrenceInDb(coreDb, occurrence, 'admission-accepted', timestamp);
      }
      // A later authority refusal cannot prove an unknown preparation had no effects.
      let current =
        preparation.kind === 'recovery_required' ? preparation : (input.current ?? preparation);
      if (
        input.current !== undefined &&
        current.kind !== 'recovery_required' &&
        (!currentWorkspaceAuthority(
          coreDb,
          occurrence.workspaceId,
          occurrence.snapshot.actor,
          'turn.run',
          true
        ) ||
          !currentWorkspaceAuthority(
            coreDb,
            occurrence.workspaceId,
            occurrence.snapshot.actor,
            'runtime.launch',
            true
          ))
      )
        current = { kind: 'failure', code: 'authority_denied' };
      if (current.kind === 'recovery_required')
        return finishRecurringOccurrenceInDb(coreDb, occurrence, 'recovery_required', timestamp);
      let code = current.kind === 'failure' ? current.code : ('accepted' as const);
      if (code === 'accepted') {
        const waiting = coreDb.sqlite
          .prepare(`SELECT 1 FROM recurring_occurrences occurrence
          JOIN scheduler_admission_entries entry ON entry.queue_entry_id = occurrence.queue_entry_id
          WHERE occurrence.schedule_id = ? AND occurrence.id <> ?
            AND occurrence.state = 'admission-accepted' AND entry.status = 'queued' LIMIT 1`)
          .get(occurrence.scheduleId, occurrence.id);
        if (waiting) code = 'queue_backlog_full';
        else if (!request) code = 'selection_unavailable';
        else {
          try {
            const entry = createSchedulerAdmissionEntry(coreDb, request);
            occurrence = {
              ...occurrence,
              queueEntryId: entry.queueEntryId,
              turnId: entry.turnId,
            };
          } catch (error) {
            if (!(error instanceof SchedulerAdmissionTransitionError)) throw error;
            code = error.reason === 'queue-full' ? 'queue_full' : 'admission_failed';
          }
        }
      }
      occurrence = {
        ...occurrence,
        resolvedPayload: resolved,
        attempts: [
          ...occurrence.attempts,
          {
            number: occurrence.attempts.length + 1,
            at: timestamp,
            code,
            summary:
              code === 'accepted' ? 'Scheduler admission accepted.' : `Admission refused: ${code}.`,
          },
        ],
      };
      if (code === 'accepted')
        return finishRecurringOccurrenceInDb(coreDb, occurrence, 'admission-accepted', timestamp);
      if (occurrence.attempts.length === 3)
        return finishRecurringOccurrenceInDb(coreDb, occurrence, 'admission-failed', timestamp);
      writeRecurringOccurrenceInDb(coreDb, occurrence);
      return occurrence;
    })
    .immediate();
}
