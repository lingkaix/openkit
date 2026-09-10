import { describe, expect, it } from 'vitest';

import { SubmitAdministrationConversationRequestSchema } from './administration.js';

describe('administration App API schemas', () => {
  it('accepts a first request without a Thread and a continuation with one', () => {
    const first = SubmitAdministrationConversationRequestSchema.parse({
      input: 'Prepare a Worker image with jq.',
      requestId: '11111111-1111-4111-8111-111111111111',
    });
    const continuation = SubmitAdministrationConversationRequestSchema.parse({
      input: 'Show the current preparation status.',
      logicalModelId: 'logical-model-admin',
      requestId: '22222222-2222-4222-8222-222222222222',
      threadId: 'thread_admin',
    });

    expect(first.threadId).toBeUndefined();
    expect(continuation.threadId).toBe('thread_admin');
  });

  it('rejects empty input and undeclared fields', () => {
    expect(
      SubmitAdministrationConversationRequestSchema.safeParse({
        input: '',
        requestId: '11111111-1111-4111-8111-111111111111',
      }).success
    ).toBe(false);
    expect(
      SubmitAdministrationConversationRequestSchema.safeParse({
        artifactRefs: [],
        input: 'Prepare an image.',
        requestId: '11111111-1111-4111-8111-111111111111',
      }).success
    ).toBe(false);
  });
});
