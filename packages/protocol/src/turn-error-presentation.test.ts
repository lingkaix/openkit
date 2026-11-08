import { expect, it } from 'vitest';
import {
  ProductTurnErrorSchema,
  TurnErrorPresentationSchema,
  TurnErrorSchema,
} from './models/turn.js';

it('accepts only a closed descriptive class and an exact owner read action', () => {
  const action = {
    kind: 'inspect',
    owner: 'turn',
    operation: 'turn.read',
    input: {
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      threadId: 'th_00000000-0000-7000-8000-000000000001',
      turnId: 'tu_00000000-0000-7000-8000-000000000001',
    },
  };
  for (const classification of ['work', 'system', 'needs-you', 'unknown-outcome', 'unclassified']) {
    expect(
      TurnErrorPresentationSchema.safeParse({
        class: classification,
        summary: 'Recorded failure',
        actions: [action],
      }).success
    ).toBe(true);
  }
  for (const actionPatch of [
    { kind: 'retry' },
    { operation: 'task.start' },
    { owner: 'gateway' },
    { automatic: true },
  ]) {
    expect(
      TurnErrorPresentationSchema.safeParse({
        class: 'system',
        summary: 'Recorded failure',
        actions: [{ ...action, ...actionPatch }],
      }).success
    ).toBe(false);
  }
  expect(
    TurnErrorPresentationSchema.safeParse({
      class: 'provider-policy-denied',
      summary: 'Recorded failure',
      actions: [],
    }).success
  ).toBe(false);
  expect(
    TurnErrorPresentationSchema.safeParse({
      class: 'system',
      summary: '界'.repeat(257),
      actions: [],
    }).success
  ).toBe(false);
});

it('keeps the outward projection separate from original Turn error authority', () => {
  const original = {
    code: 'future_failure',
    message: 'Retained original failure',
    presentation: { class: 'unclassified', summary: 'This run ended with an error.', actions: [] },
  };
  expect(ProductTurnErrorSchema.parse(original)).toEqual(original);
  expect(TurnErrorSchema.parse(original)).toEqual({
    code: original.code,
    message: original.message,
  });
});
