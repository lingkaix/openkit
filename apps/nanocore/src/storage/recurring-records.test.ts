import { testEntityId } from '../test-support/entity-ids.js';
import { describe, expect, it } from 'vitest';
import { ExpiredOccurrenceRangeSchema, readRecurringSchedule } from './recurring-records.js';

const monthlyUtc = { zone: 'UTC' as const, dayOfMonth: 28, hour: 9, minute: 0, second: 0 };
const actor = { kind: 'automation' as const, id: testEntityId('auto', 'schedule'), responsibleUserId: testEntityId('usr', 'creator') };
const range = {
  id: testEntityId('range', 'range'),
  scheduleId: testEntityId('auto', 'schedule'),
  workspaceId: testEntityId('ws', 'workspace'),
  definitionRevision: 2,
  monthlyUtc,
  firstScheduledAt: '2027-01-28T09:00:00.000Z',
  lastScheduledAt: '2027-03-28T09:00:00.000Z',
  count: 3,
  snapshot: { threadId: testEntityId('th', 'thread'), actor, prompt: 'Inspect status', monthlyUtc },
  reason: 'deadline_elapsed',
  createdAt: '2027-04-28T09:00:00.000Z',
  terminalAt: '2027-04-28T09:00:00.000Z',
};

describe('retained recurring timing core', () => {
  it('validates exact monthly bounds, count, actor and old-rule snapshot without expansion', () => {
    expect(ExpiredOccurrenceRangeSchema.parse(range)).toEqual(range);
    for (const patch of [
      { count: 4 },
      { lastScheduledAt: '2027-03-29T09:00:00.000Z' },
      { firstScheduledAt: '2027-04-28T09:00:00.000Z' },
      { snapshot: { ...range.snapshot, monthlyUtc: { ...monthlyUtc, hour: 10 } } },
      { snapshot: { ...range.snapshot, monthlyUtc: undefined } },
      { snapshot: { ...range.snapshot, actor: { ...actor, id: testEntityId('auto', 'different') } } },
      { intervalSeconds: 5 },
      { requiredFeatures: ['unknown-monthly-semantics'] },
    ])
      expect(ExpiredOccurrenceRangeSchema.safeParse({ ...range, ...patch }).success).toBe(false);
  });

  it('keeps fixed ranges readable and refuses inaccurate fixed-duration coverage', () => {
    const { monthlyUtc: _rule, ...fixedRange } = range;
    const { monthlyUtc: _snapshotRule, ...snapshot } = range.snapshot;
    const fixed = {
      ...fixedRange,
      snapshot,
      intervalSeconds: 5,
      lastScheduledAt: '2027-01-28T09:00:10.000Z',
    };
    expect(ExpiredOccurrenceRangeSchema.parse(fixed)).toEqual(fixed);
    expect(ExpiredOccurrenceRangeSchema.safeParse({ ...fixed, count: 2 }).success).toBe(false);
  });

  it('refuses a monthly cursor that does not match the retained rule while tolerating annotations', () => {
    const schedule = {
      id: actor.id,
      workspaceId: testEntityId('ws', 'workspace'),
      name: 'Monthly',
      threadId: testEntityId('th', 'thread'),
      monthlyUtc,
      responsibleUserId: actor.responsibleUserId,
      actor,
      status: 'active',
      revision: 2,
      nextScheduledAt: '2027-04-28T09:00:00.000Z',
      greatestAccountedScheduledAt: range.lastScheduledAt,
      prompt: 'Inspect status',
      createdAt: range.createdAt,
      updatedAt: range.createdAt,
      deletedAt: null,
    };
    expect(
      readRecurringSchedule(JSON.stringify({ ...schedule, annotation: 'Descriptive only' }))
    ).toEqual(schedule);
    expect(() =>
      readRecurringSchedule(
        JSON.stringify({ ...schedule, nextScheduledAt: '2027-04-29T09:00:00.000Z' })
      )
    ).toThrow();
    expect(() =>
      readRecurringSchedule(
        JSON.stringify({ ...schedule, monthlyUtc: { ...monthlyUtc, zone: 'unknown' } })
      )
    ).toThrow();
    expect(() =>
      readRecurringSchedule(JSON.stringify({ ...schedule, requiredFeatures: ['future-cadence'] }))
    ).toThrow();
  });
});
