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
    workspaceId: 'ws_00000000-0000-7b10-9af8-12fd37a880e0',
    threadId: 'th_00000000-0000-70a0-9cde-4561f64881c6',
    turnId: 'tu_00000000-0000-7da3-a7fc-80982f9b215e',
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
