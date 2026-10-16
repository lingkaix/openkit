import { z } from 'zod';
import type { CoreDb } from './db.js';
import {
  ExpiredOccurrenceRangeSchema,
  readRecurringOccurrence,
  readRecurringSchedule,
} from './recurring-records.js';

const HistoricalSourceSchema = z
  .object({
    workspaceId: z.string().min(1),
    schedules: z.array(z.record(z.string(), z.unknown())),
    occurrences: z.array(z.record(z.string(), z.unknown())),
    expiredRanges: z.array(z.record(z.string(), z.unknown())),
    requiredFeatures: z.array(z.never()).optional(),
  })
  .passthrough();
const HistoricalBundleSchema = z
  .object({
    historyVersion: z.literal(1),
    sources: z.array(HistoricalSourceSchema),
    requiredFeatures: z.array(z.never()).optional(),
  })
  .passthrough();

/** Validates descriptive source bytes; these identities never enter live schedule or queue tables. */
export function validateRecurringPortableHistory(text: string): void {
  const bundle = HistoricalBundleSchema.parse(JSON.parse(text));
  for (const source of bundle.sources) {
    const schedules = new Map(
      source.schedules.map((raw) => {
        const schedule = readRecurringSchedule(JSON.stringify(raw));
        if (
          schedule.workspaceId !== source.workspaceId ||
          schedule.actor.id !== schedule.id ||
          schedule.actor.responsibleUserId !== schedule.responsibleUserId
        )
          throw new Error('Recurring history has contradictory source ownership.');
        return [schedule.id, schedule] as const;
      })
    );
    if (schedules.size !== source.schedules.length)
      throw new Error('Recurring history repeats a definition identity.');
    for (const raw of source.occurrences) {
      const occurrence = readRecurringOccurrence(JSON.stringify(raw));
      const schedule = schedules.get(occurrence.scheduleId);
      if (
        !schedule ||
        occurrence.workspaceId !== source.workspaceId ||
        occurrence.snapshot.actor.responsibleUserId !== schedule.responsibleUserId
      )
        throw new Error('Recurring history has contradictory occurrence ownership.');
    }
    for (const raw of source.expiredRanges) {
      const range = ExpiredOccurrenceRangeSchema.parse(raw);
      const schedule = schedules.get(range.scheduleId);
      if (
        !schedule ||
        range.workspaceId !== source.workspaceId ||
        range.snapshot.actor.id !== schedule.id ||
        range.snapshot.actor.responsibleUserId !== schedule.responsibleUserId
      )
        throw new Error('Recurring history has contradictory expired-range ownership.');
    }
  }
}

/** Captures all current Workspace recurrence history beside unchanged prior imported source bytes. */
export function exportRecurringPortableHistory(
  coreDb: CoreDb | undefined,
  workspaceId: string,
  inherited: string | null
): string | null {
  if (inherited !== null) validateRecurringPortableHistory(inherited);
  if (!coreDb) return inherited;
  const readRows = (
    table: 'recurring_schedules' | 'recurring_occurrences' | 'recurring_expired_ranges'
  ) =>
    (
      coreDb.sqlite
        .prepare(`SELECT record_json FROM ${table} WHERE workspace_id = ? ORDER BY id`)
        .all(workspaceId) as { record_json: string }[]
    ).map((row) => JSON.parse(row.record_json));
  const schedules = readRows('recurring_schedules');
  const occurrences = readRows('recurring_occurrences');
  const expiredRanges = readRows('recurring_expired_ranges');
  if (!schedules.length && !occurrences.length && !expiredRanges.length) return inherited;
  const existing =
    inherited === null
      ? { historyVersion: 1, sources: [] }
      : HistoricalBundleSchema.parse(JSON.parse(inherited));
  const text = `${JSON.stringify({
    ...existing,
    sources: [
      ...existing.sources,
      {
        workspaceId,
        schedules,
        occurrences,
        expiredRanges,
      },
    ],
  })}\n`;
  validateRecurringPortableHistory(text);
  return text;
}
