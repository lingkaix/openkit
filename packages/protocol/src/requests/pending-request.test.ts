import { describe, expect, it } from 'vitest';
import {
  AnswerUserInputRequestSchema,
  PendingRequestOutcomeSchema,
  WithdrawPendingRequestSchema,
} from '../index.js';

describe('pending request additive command content', () => {
  it('accepts and strips additive answer and withdrawal fields', () => {
    const answer = {
      requestId: 'command',
      workspaceId: 'ws_00000000-0000-70c6-8ed9-fd7af910ecca',
      threadId: 'th_00000000-0000-73eb-9a38-397e2c3d8bd1',
      userInputRequestId: 'question',
      answers: { path: ['left'] },
      futureHint: 'untrusted canary',
    };
    const withdraw = {
      requestId: 'command',
      workspaceId: 'ws_00000000-0000-70c6-8ed9-fd7af910ecca',
      threadId: 'th_00000000-0000-73eb-9a38-397e2c3d8bd1',
      pendingRequestId: 'pending',
      futureHint: 'untrusted canary',
    };
    expect(AnswerUserInputRequestSchema.parse(answer)).not.toHaveProperty('futureHint');
    expect(WithdrawPendingRequestSchema.parse(withdraw)).not.toHaveProperty('futureHint');
    expect(
      PendingRequestOutcomeSchema.safeParse({
        requestId: 'pending',
        workspaceId: 'ws_00000000-0000-70c6-8ed9-fd7af910ecca',
        threadId: 'th_00000000-0000-73eb-9a38-397e2c3d8bd1',
        state: 'future-state',
        resolution: null,
        ending: null,
      }).success
    ).toBe(false);
  });
});
