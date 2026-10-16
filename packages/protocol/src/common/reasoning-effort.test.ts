import { expect, it } from 'vitest';
import * as protocol from '../index.js';

it('exports the exact ordered Core reasoning-effort vocabulary', () => {
  expect(protocol).toHaveProperty('REASONING_EFFORT_LEVELS', [
    'none',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
  ]);
});

it('admits effort on turn.start and retained Turn projections without inventing omission', () => {
  const input = {
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    threadId: 'th_00000000-0000-7000-8000-000000000001',
    requestId: '00000000-0000-4000-8000-000000000999',
    input: 'Run',
    reasoningEffort: 'none',
  };
  expect(protocol.SubmitTurnInputRequestSchema.parse(input)).toEqual(input);
  expect(
    protocol.SubmitTurnInputRequestSchema.safeParse({ ...input, reasoningEffort: 'default' })
      .success
  ).toBe(false);
  const retained = {
    id: 'tu_00000000-0000-77e3-bfde-66477d556f64',
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    threadId: 'th_00000000-0000-7000-8000-000000000001',
    triggerActor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
    items: [],
    status: 'completed',
    error: null,
    configVersion: null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
  };
  expect(protocol.TurnSchema.parse(retained)).not.toHaveProperty('reasoningEffort');
  expect(protocol.TurnSchema.parse({ ...retained, reasoningEffort: 'max' })).toHaveProperty(
    'reasoningEffort',
    'max'
  );
  expect(protocol.ProductTurnSchema.parse({ ...retained, reasoningEffort: 'max' })).toHaveProperty(
    'reasoningEffort',
    'max'
  );
});
