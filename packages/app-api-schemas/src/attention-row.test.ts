import { expect, it } from 'vitest';
import { HumanAttentionRowSchema } from './action-center.js';

const actor = { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' };

it('keeps unknown attention origin and viewer relationships nullable', () => {
  const schema = HumanAttentionRowSchema.shape.origin;
  expect(schema.safeParse(null).success).toBe(true);
  expect(schema.safeParse(undefined).success).toBe(true);
  expect(
    schema.safeParse({
      startedBy: actor,
      startedAt: null,
      viewerStartedRun: null,
      viewerCausedHandoff: null,
    }).success
  ).toBe(true);
  expect(
    schema.safeParse({
      startedBy: actor,
      startedAt: '2026-11-12T10:00:00.000Z',
      viewerStartedRun: true,
      viewerCausedHandoff: false,
    }).success
  ).toBe(true);
  expect(
    schema.safeParse({
      startedBy: actor,
      startedAt: null,
      viewerStartedRun: 'unknown',
      viewerCausedHandoff: false,
    }).success
  ).toBe(false);
});

it('retains actual question whitespace and explicit clipping metadata', () => {
  const schema = HumanAttentionRowSchema.shape.questionSummary;
  const summary = { text: '  Which 雪?\nSecond line.  ', truncated: false };
  expect(schema.parse(summary)).toEqual(summary);
  expect(schema.safeParse(null).success).toBe(true);
  expect(schema.safeParse({ text: 'prefix', truncated: true }).success).toBe(true);
  expect(schema.safeParse({ text: 'prefix' }).success).toBe(false);
});

it('bounds question text by serialized UTF-8 bytes rather than character count', () => {
  const schema = HumanAttentionRowSchema.shape.questionSummary;
  expect(schema.safeParse({ text: 'a'.repeat(1022), truncated: false }).success).toBe(true);
  expect(schema.safeParse({ text: 'a'.repeat(1023), truncated: false }).success).toBe(false);
  expect(schema.safeParse({ text: '雪'.repeat(341), truncated: false }).success).toBe(false);
  expect(schema.safeParse({ text: '"'.repeat(512), truncated: false }).success).toBe(false);
});
