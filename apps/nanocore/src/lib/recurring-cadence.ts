import type { AutomationCadence, MonthlyUtcSchedule } from '@openkit/app-api-schemas';
import { StoredAutomationCadenceV1Schema } from '../storage/recurring-retained-v1.js';

/** Exact inclusive nominal coverage through one cutoff, with its immediate successor. */
export interface RecurringNominalPrefix {
  readonly count: number;
  readonly last: number;
  readonly next: number;
}

/** Checks every monthly UTC field; fixed intervals accept any valid initial anchor. */
export function recurringNominalMatches(cadence: AutomationCadence, instant: number): boolean {
  const timing = StoredAutomationCadenceV1Schema.parse(cadence);
  const date = checkedDate(instant);
  const monthly = timing.monthlyUtc;
  return (
    monthly === undefined ||
    (date.getUTCDate() === monthly.dayOfMonth &&
      date.getUTCHours() === monthly.hour &&
      date.getUTCMinutes() === monthly.minute &&
      date.getUTCSeconds() === monthly.second &&
      date.getUTCMilliseconds() === 0)
  );
}

/** Advances the admitted nominal rule, without callback, attempt or completion-time drift. */
export function advanceRecurringNominal(cadence: AutomationCadence, instant: number): number {
  const timing = StoredAutomationCadenceV1Schema.parse(cadence);
  if (!recurringNominalMatches(timing, instant))
    throw new RangeError('Recurring cursor does not match its monthly UTC rule.');
  return timing.monthlyUtc === undefined
    ? checkedDate(instant + intervalStep(timing.intervalSeconds!)).getTime()
    : monthlyInstant(monthIndex(instant) + 1, timing.monthlyUtc);
}

/** Locates exact missed coverage in constant work, including outages spanning many calendar months. */
export function recurringPrefixThrough(
  cadence: AutomationCadence,
  first: number,
  through: number
): RecurringNominalPrefix | null {
  const timing = StoredAutomationCadenceV1Schema.parse(cadence);
  checkedDate(through);
  if (!recurringNominalMatches(timing, first))
    throw new RangeError('Recurring cursor does not match its monthly UTC rule.');
  if (first > through) return null;
  if (timing.monthlyUtc !== undefined) {
    const firstMonth = monthIndex(first);
    let lastMonth = monthIndex(through);
    if (monthlyInstant(lastMonth, timing.monthlyUtc) > through) lastMonth--;
    const last = monthlyInstant(lastMonth, timing.monthlyUtc);
    return {
      count: lastMonth - firstMonth + 1,
      last,
      next: monthlyInstant(lastMonth + 1, timing.monthlyUtc),
    };
  }
  const step = intervalStep(timing.intervalSeconds!);
  const count = Math.floor((through - first) / step) + 1;
  const last = first + (count - 1) * step;
  return { count, last: checkedDate(last).getTime(), next: checkedDate(last + step).getTime() };
}

/** Validates immutable range coverage without granting live actor or admission authority. */
export function validateRecurringRangeCoverage(
  range: AutomationCadence & {
    readonly firstScheduledAt: string;
    readonly lastScheduledAt: string;
    readonly count: number;
    readonly snapshot: { readonly monthlyUtc?: MonthlyUtcSchedule | undefined };
  }
): void {
  const coverage = recurringPrefixThrough(
    range,
    Date.parse(range.firstScheduledAt),
    Date.parse(range.lastScheduledAt)
  );
  const rootMonthly = range.monthlyUtc;
  const snapshotMonthly = range.snapshot.monthlyUtc;
  if (
    !coverage ||
    coverage.last !== Date.parse(range.lastScheduledAt) ||
    coverage.count !== range.count ||
    (rootMonthly === undefined) !== (snapshotMonthly === undefined) ||
    (rootMonthly !== undefined &&
      snapshotMonthly !== undefined &&
      (rootMonthly.zone !== snapshotMonthly.zone ||
        rootMonthly.dayOfMonth !== snapshotMonthly.dayOfMonth ||
        rootMonthly.hour !== snapshotMonthly.hour ||
        rootMonthly.minute !== snapshotMonthly.minute ||
        rootMonthly.second !== snapshotMonthly.second))
  )
    throw new RangeError('Expired recurring range contradicts its exact cadence or snapshot.');
}

/** Restricts arithmetic to integer milliseconds and the four-digit UTC years admitted by the record schema. */
function checkedDate(instant: number): Date {
  const date = new Date(instant);
  if (
    !Number.isSafeInteger(instant) ||
    !Number.isFinite(date.getTime()) ||
    date.getUTCFullYear() < 0 ||
    date.getUTCFullYear() > 9999
  )
    throw new RangeError('Recurring nominal timestamp is outside the supported UTC range.');
  return date;
}

function intervalStep(seconds: number): number {
  const step = seconds * 1000;
  if (!Number.isSafeInteger(step))
    throw new RangeError('Recurring interval exceeds safe integer arithmetic.');
  return step;
}

function monthIndex(instant: number): number {
  const date = checkedDate(instant);
  return date.getUTCFullYear() * 12 + date.getUTCMonth();
}

/** Constructs a known-valid date rather than overflowing a day or Date.UTC's special years 0 through 99. */
function monthlyInstant(index: number, monthly: MonthlyUtcSchedule): number {
  if (!Number.isSafeInteger(index) || index < 0 || index >= 120000)
    throw new RangeError('Recurring monthly successor is outside the supported UTC range.');
  const date = new Date(0);
  date.setUTCFullYear(Math.floor(index / 12), index % 12, monthly.dayOfMonth);
  date.setUTCHours(monthly.hour, monthly.minute, monthly.second, 0);
  return checkedDate(date.getTime()).getTime();
}
