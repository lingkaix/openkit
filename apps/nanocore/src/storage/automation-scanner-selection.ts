import { compareCodeUnits } from '@openkit/protocol';
import { nextRecurringNominal, recurringPrefixThrough } from '../lib/recurring-cadence.js';
import type { AutomationScanPlan } from './automation-scanner-codecs.js';
import { RECURRING_DEADLINE_MS } from './recurring-records.js';

type Schedule = AutomationScanPlan['due'][number];
/** Replays only original scheduling arithmetic, allowing Main's original callback before any write. */
export function selectAutomationScan(
  plan: AutomationScanPlan,
  timestamp: string,
  workspaceIds: readonly string[],
  onError?: (error: unknown) => void
) {
  const now = Date.parse(timestamp);
  const admitted = new Set(workspaceIds);
  const schedules = new Map(
    [...plan.pendingSchedules, ...plan.due, ...plan.expired].map((record) => [record.id, record])
  );
  const candidates: { scheduleId: string; at: number; occurrenceId?: string }[] = [];
  for (const occurrence of plan.pending)
    if (admitted.has(occurrence.workspaceId))
      candidates.push({
        scheduleId: occurrence.scheduleId,
        at: Date.parse(occurrence.scheduledAt),
        occurrenceId: occurrence.id,
      });
  for (const schedule of plan.due) {
    if (!admitted.has(schedule.workspaceId)) continue;
    const next = Date.parse(schedule.nextScheduledAt!);
    const coverage = recurringPrefixThrough(schedule, next, now - RECURRING_DEADLINE_MS);
    for (
      let at = coverage ? coverage.next : next, count = 0;
      at !== null && at <= now && count < 128;
      at = nextRecurringNominal(schedule, at), count++
    )
      candidates.push({ scheduleId: schedule.id, at });
  }
  candidates.sort((a, b) => a.at - b.at || compareCodeUnits(a.scheduleId, b.scheduleId));
  const selected = candidates.slice(0, 128);
  /** Keeps the original prefix and cursor calculations without allocating an occurrence or range. */
  const account = (schedule: Schedule): Schedule => {
    if (!schedule.nextScheduledAt) return schedule;
    const first = Date.parse(schedule.nextScheduledAt);
    if (first > now - RECURRING_DEADLINE_MS) return schedule;
    const coverage = recurringPrefixThrough(schedule, first, now - RECURRING_DEADLINE_MS);
    if (!coverage) return schedule;
    const next = nextRecurringNominal(schedule, coverage.last, onError);
    return { ...schedule, nextScheduledAt: next === null ? null : new Date(next).toISOString() };
  };
  let expiredRangeCount = 0;
  for (const candidate of selected) {
    if (candidate.occurrenceId) continue;
    let schedule = schedules.get(candidate.scheduleId)!;
    if (Date.parse(schedule.nextScheduledAt!) <= now - RECURRING_DEADLINE_MS) expiredRangeCount++;
    schedule = account(schedule);
    const next = nextRecurringNominal(schedule, candidate.at, onError);
    schedules.set(schedule.id, {
      ...schedule,
      nextScheduledAt: next === null ? null : new Date(next).toISOString(),
    });
  }
  // Selected publications only advance/remove expired cursors. The original first128 contains
  // every possible member of the later reduced (128-expiredRangeCount) query.
  const expired = plan.expired
    .map((record) => schedules.get(record.id)!)
    .filter(
      (record) =>
        record.nextScheduledAt !== null &&
        Date.parse(record.nextScheduledAt) <= now - RECURRING_DEADLINE_MS
    )
    .sort(
      (a, b) =>
        Date.parse(a.nextScheduledAt!) - Date.parse(b.nextScheduledAt!) ||
        compareCodeUnits(a.id, b.id)
    )
    .slice(0, 128 - expiredRangeCount)
    .filter((record) => admitted.has(record.workspaceId));
  for (const schedule of expired) schedules.set(schedule.id, account(schedule));
  return {
    selected,
    stale: plan.stale
      .filter((record) => admitted.has(record.workspaceId))
      .map((record) => record.id),
    expired: expired.map((record) => record.id),
  };
}
