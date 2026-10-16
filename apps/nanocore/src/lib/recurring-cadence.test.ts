import { describe, expect, it } from 'vitest';
import {
  advanceRecurringNominal,
  recurringNominalMatches,
  recurringPrefixThrough,
} from './recurring-cadence.js';

const monthly = {
  monthlyUtc: { zone: 'UTC' as const, dayOfMonth: 28, hour: 9, minute: 0, second: 0 },
};
const at = (value: string) => Date.parse(value);

describe('closed recurring cadence arithmetic', () => {
  it('uses exact Gregorian months rather than a fixed elapsed duration', () => {
    const january = at('2027-01-28T09:00:00.000Z');
    const february = advanceRecurringNominal(monthly, january);
    const march = advanceRecurringNominal(monthly, february);
    expect(new Date(february).toISOString()).toBe('2027-02-28T09:00:00.000Z');
    expect(new Date(march).toISOString()).toBe('2027-03-28T09:00:00.000Z');
    expect((february - january) / 86_400_000).toBe(31);
    expect((march - february) / 86_400_000).toBe(28);
    expect(
      new Date(advanceRecurringNominal(monthly, at('2028-02-28T09:00:00.000Z'))).toISOString()
    ).toBe('2028-03-28T09:00:00.000Z');
    expect(
      new Date(advanceRecurringNominal(monthly, at('2027-12-28T09:00:00.000Z'))).toISOString()
    ).toBe('2028-01-28T09:00:00.000Z');
    expect(
      new Date(advanceRecurringNominal(monthly, at('0099-12-28T09:00:00.000Z'))).toISOString()
    ).toBe('0100-01-28T09:00:00.000Z');
  });

  it('matches every authored UTC field and refuses subsecond or shifted nominal instants', () => {
    expect(recurringNominalMatches(monthly, at('2027-01-28T09:00:00.000Z'))).toBe(true);
    for (const value of [
      '2027-01-27T09:00:00.000Z',
      '2027-01-28T09:00:01.000Z',
      '2027-01-28T09:00:00.001Z',
    ]) {
      expect(recurringNominalMatches(monthly, at(value))).toBe(false);
      expect(() => advanceRecurringNominal(monthly, at(value))).toThrow();
    }
  });

  it('covers an expired monthly prefix by exact inclusive month count', () => {
    const first = at('2020-01-28T09:00:00.000Z');
    expect(recurringPrefixThrough(monthly, first, at('2027-03-28T08:59:59.999Z'))).toEqual({
      count: 86,
      last: at('2027-02-28T09:00:00.000Z'),
      next: at('2027-03-28T09:00:00.000Z'),
    });
    expect(recurringPrefixThrough(monthly, first, at('2027-03-28T09:00:00.000Z'))).toEqual({
      count: 87,
      last: at('2027-03-28T09:00:00.000Z'),
      next: at('2027-04-28T09:00:00.000Z'),
    });
    expect(recurringPrefixThrough(monthly, first, first - 1)).toBeNull();
    expect(recurringPrefixThrough(monthly, first, first)).toMatchObject({ count: 1, last: first });
    expect(
      recurringPrefixThrough(
        { monthlyUtc: { ...monthly.monthlyUtc, dayOfMonth: 1 } },
        at('0001-01-01T09:00:00.000Z'),
        at('9998-12-01T09:00:00.000Z')
      )?.count
    ).toBe(119976);
  });

  it('preserves fixed interval anchors, fractional milliseconds and exact boundary counts', () => {
    const fixed = { intervalSeconds: 5 };
    const first = at('2027-01-01T00:00:00.123Z');
    expect(advanceRecurringNominal(fixed, first)).toBe(first + 5000);
    expect(recurringPrefixThrough(fixed, first, first + 9999)).toEqual({
      count: 2,
      last: first + 5000,
      next: first + 10000,
    });
    expect(recurringPrefixThrough(fixed, first, first + 10000)).toEqual({
      count: 3,
      last: first + 10000,
      next: first + 15000,
    });
  });

  it('fails closed on invalid cadence, contradictory shapes, corrupt cursors and overflow', () => {
    const first = at('2027-01-28T09:00:00.000Z');
    for (const cadence of [
      {},
      { intervalSeconds: 4 },
      { intervalSeconds: 5, ...monthly },
      { monthlyUtc: { ...monthly.monthlyUtc, dayOfMonth: 29 } },
      { monthlyUtc: { ...monthly.monthlyUtc, zone: 'Europe/London' } },
    ])
      expect(() => advanceRecurringNominal(cadence as typeof monthly, first)).toThrow();
    expect(() => recurringPrefixThrough(monthly, first + 1, first + 2)).toThrow();
    expect(() => advanceRecurringNominal(monthly, at('9999-12-28T09:00:00.000Z'))).toThrow();
    expect(() =>
      advanceRecurringNominal({ intervalSeconds: 5 }, at('9999-12-31T23:59:59.999Z'))
    ).toThrow();
    expect(() =>
      advanceRecurringNominal({ intervalSeconds: Number.MAX_SAFE_INTEGER }, first)
    ).toThrow();
    expect(() => recurringNominalMatches(monthly, Number.NaN)).toThrow();
  });
});
