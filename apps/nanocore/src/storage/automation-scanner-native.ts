import { isDeepStrictEqual } from 'node:util';
import { readRetainedV1 } from '@openkit/protocol';
import { sha256Hex } from '@openkit/protocol/digest';
import { recurringPrefixThrough } from '../lib/recurring-cadence.js';
import {
  accountRecurringExpiredPrefix,
  advanceRecurringSchedule,
  newRecurringOccurrence,
} from './automation-definition-native.js';
import {
  type AutomationScanPlan,
  AutomationScanPlanSchema,
  type ControlAutomationScanner,
  type ControlAutomationScannerResult,
} from './automation-scanner-codecs.js';
import { selectAutomationScan } from './automation-scanner-selection.js';
import { ControlProductPreconditionError } from './control-store-product-records.js';
import type { CoreDb } from './db.js';
import {
  findRecurringAutomationFromDb,
  finishRecurringOccurrenceInDb,
  writeRecurringOccurrenceInDb,
} from './recurring-attempt-native.js';
import {
  RECURRING_DEADLINE_MS,
  readRecurringOccurrence,
  readRecurringSchedule,
} from './recurring-records.js';
import { StoredAutomationCadenceV1Schema } from './recurring-retained-v1.js';

type Row = { schemaVersion: unknown; record_json: string };
const digest = (row: Row) => sha256Hex(JSON.stringify([row.schemaVersion, row.record_json]));
/** Selects the original bounded read set on the physical owner, without DML or Main callbacks. */
function readScanPlan(db: CoreDb, timestamp: string): AutomationScanPlan {
  // MOVE of the original connection-local deterministic function; there is no new durable state.
  db.sqlite.function(
    'recurring_live_frontier',
    { deterministic: true },
    (schemaVersion: unknown, recordJson: unknown, first: unknown, through: unknown) =>
      readRetainedV1({ schemaVersion }, () => {
        if (
          typeof recordJson !== 'string' ||
          typeof first !== 'number' ||
          typeof through !== 'number'
        )
          throw new Error('Recurring scan has invalid required timing values.');
        const cadence = StoredAutomationCadenceV1Schema.parse(JSON.parse(recordJson));
        const coverage = recurringPrefixThrough(cadence, first, through);
        return coverage ? coverage.next : first;
      })
  );
  const now = Date.parse(timestamp);
  const occurrence = (row: Row) => {
    const record = readRetainedV1(row, () => readRecurringOccurrence(row.record_json));
    return {
      id: record.id,
      workspaceId: record.workspaceId,
      scheduleId: record.scheduleId,
      scheduledAt: record.scheduledAt,
      rowDigest: digest(row),
    };
  };
  const schedule = (row: Row) => {
    const record = readRetainedV1(row, () => readRecurringSchedule(row.record_json));
    return {
      id: record.id,
      workspaceId: record.workspaceId,
      revision: record.revision,
      nextScheduledAt: record.nextScheduledAt,
      ...StoredAutomationCadenceV1Schema.parse(record),
      rowDigest: digest(row),
    };
  };
  const pending = (
    db.sqlite
      .prepare(`SELECT occurrence.schema_version AS schemaVersion,occurrence.record_json FROM recurring_occurrences occurrence
    JOIN recurring_schedules schedule ON schedule.id=occurrence.schedule_id WHERE occurrence.state='pending' AND occurrence.deadline>? AND occurrence.scheduled_at<=?
    AND schedule.status='active' ORDER BY occurrence.deadline,occurrence.id LIMIT ?`)
      .all(now, now, 128) as Row[]
  ).map(occurrence);
  const due = (
    db.sqlite
      .prepare(`SELECT schema_version AS schemaVersion,record_json FROM recurring_schedules WHERE status='active' AND next_scheduled_at<=?
    ORDER BY recurring_live_frontier(schema_version,record_json,next_scheduled_at,?),id LIMIT ?`)
      .all(now, now - RECURRING_DEADLINE_MS, 128) as Row[]
  ).map(schedule);
  const stale = (
    db.sqlite
      .prepare(
        `SELECT schema_version AS schemaVersion,record_json FROM recurring_occurrences WHERE state='pending' AND deadline<=? ORDER BY deadline,id LIMIT ?`
      )
      .all(now, 128) as Row[]
  ).map(occurrence);
  const expired = (
    db.sqlite
      .prepare(
        `SELECT schema_version AS schemaVersion,record_json FROM recurring_schedules WHERE status='active' AND next_scheduled_at<=? ORDER BY next_scheduled_at,id LIMIT ?`
      )
      .all(now - RECURRING_DEADLINE_MS, 128) as Row[]
  ).map(schedule);
  const pendingSchedules = [...new Set(pending.map((row) => row.scheduleId))].map((id) => {
    const row = db.sqlite
      .prepare(
        'SELECT schema_version AS schemaVersion,record_json FROM recurring_schedules WHERE id=?'
      )
      .get(id) as Row | undefined;
    if (!row) throw new ControlProductPreconditionError();
    return schedule(row);
  });
  return AutomationScanPlanSchema.parse({ pending, due, stale, expired, pendingSchedules });
}
/** Revalidates exact original selected rows before the one original publication tuple. */
export function applyAutomationScannerInDb(
  db: CoreDb,
  input: ControlAutomationScanner
): ControlAutomationScannerResult {
  const current = readScanPlan(db, input.timestamp);
  if (input.action === 'plan') return { kind: 'plan', plan: current };
  if (!isDeepStrictEqual(current, input.expected)) throw new ControlProductPreconditionError();
  const known = new Set(
    [...current.pending, ...current.due, ...current.stale, ...current.expired].map(
      (record) => record.workspaceId
    )
  );
  if (
    input.workspaceIds.some((id) => !known.has(id)) ||
    new Set(input.workspaceIds).size !== input.workspaceIds.length
  )
    throw new ControlProductPreconditionError();
  const selection = selectAutomationScan(current, input.timestamp, input.workspaceIds);
  const now = Date.parse(input.timestamp);
  const requireSchedule = (id: string) => {
    const schedule = findRecurringAutomationFromDb(db, id);
    if (!schedule) throw new ControlProductPreconditionError();
    return schedule;
  };
  const occurrences = selection.selected.map((candidate) => {
    if (candidate.occurrenceId) {
      const row = db.sqlite
        .prepare(
          'SELECT schema_version AS schemaVersion,record_json FROM recurring_occurrences WHERE id=?'
        )
        .get(candidate.occurrenceId) as Row | undefined;
      if (!row) throw new ControlProductPreconditionError();
      return readRetainedV1(row, () => readRecurringOccurrence(row.record_json));
    }
    const schedule = accountRecurringExpiredPrefix(
      db,
      requireSchedule(candidate.scheduleId),
      now,
      input.timestamp
    );
    const occurrence = newRecurringOccurrence(schedule, candidate.at, input.timestamp);
    writeRecurringOccurrenceInDb(db, occurrence, true);
    advanceRecurringSchedule(db, schedule, candidate.at);
    return occurrence;
  });
  for (const id of selection.stale) {
    const row = db.sqlite
      .prepare(
        'SELECT schema_version AS schemaVersion,record_json FROM recurring_occurrences WHERE id=?'
      )
      .get(id) as Row | undefined;
    if (!row) throw new ControlProductPreconditionError();
    finishRecurringOccurrenceInDb(
      db,
      readRetainedV1(row, () => readRecurringOccurrence(row.record_json)),
      'expired',
      input.timestamp
    );
  }
  for (const id of selection.expired)
    accountRecurringExpiredPrefix(db, requireSchedule(id), now, input.timestamp);
  return { kind: 'published', occurrences };
}
