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
      workspaceId: 'workspace',
      threadId: 'thread',
      userInputRequestId: 'question',
      answers: { path: ['left'] },
      futureHint: 'untrusted canary',
    };
    const withdraw = {
      requestId: 'command',
      workspaceId: 'workspace',
      threadId: 'thread',
      pendingRequestId: 'pending',
      futureHint: 'untrusted canary',
    };
    expect(AnswerUserInputRequestSchema.parse(answer)).not.toHaveProperty('futureHint');
    expect(WithdrawPendingRequestSchema.parse(withdraw)).not.toHaveProperty('futureHint');
    expect(
      PendingRequestOutcomeSchema.safeParse({
        requestId: 'pending',
        workspaceId: 'workspace',
        threadId: 'thread',
        state: 'future-state',
        resolution: null,
        ending: null,
      }).success
    ).toBe(false);
  });
});
