import { randomUUID } from 'node:crypto';
import {
  ArchiveThreadRequestSchema,
  InterruptTurnRequestSchema,
  UpdateThreadRequestSchema,
} from '@openkit/protocol';
import { expect, it } from 'vitest';
import { OPERATION_DEFINITIONS } from './operation-definitions.js';

it.each([
  ['thread.update', UpdateThreadRequestSchema],
  ['thread.archive', ArchiveThreadRequestSchema],
  ['turn.interrupt', InterruptTurnRequestSchema],
] as const)('preserves the complete %s schema unknown-field policy and required selectors', (id, former) => {
  const input = {
    workspaceId: 'ws1',
    threadId: 'th1',
    turnId: 't1',
    requestId: randomUUID(),
    futureHint: true,
  };
  const current = OPERATION_DEFINITIONS[id].inputSchema;
  expect(current.parse(input)).toEqual(former.parse(input));
  expect(current.parse(input)).not.toHaveProperty('futureHint');
  expect(current.safeParse({ ...input, threadId: undefined }).success).toBe(false);
  if (id === 'turn.interrupt')
    expect(current.safeParse({ ...input, turnId: undefined }).success).toBe(false);
});
