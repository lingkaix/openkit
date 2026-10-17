import { describe, expect, it } from 'vitest';

import {
  ApplyAdministrationConfigurationRequestSchema,
  SubmitAdministrationConversationRequestSchema,
} from './administration.js';

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
      threadId: 'th_00000000-0000-79b7-9009-e76cfeceddee',
    });

    expect(first.threadId).toBeUndefined();
    expect(continuation.threadId).toBe('th_00000000-0000-79b7-9009-e76cfeceddee');
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

it('binds configuration confirmation to the exact immutable digest and rejects model authority fields', () => {
  const contentDigest = `sha256:${'a'.repeat(64)}`;
  const request = {
    requestId: '11111111-1111-4111-8111-111111111111',
    candidate: {
      artifactId: 'ar_00000000-0000-7124-bbaa-516a6d18c0e9',
      artifactVersion: 1,
      contentDigest,
    },
    confirmation: { action: 'administration.configuration.apply', contentDigest },
  };
  expect(ApplyAdministrationConfigurationRequestSchema.safeParse(request).success).toBe(true);
  expect(
    ApplyAdministrationConfigurationRequestSchema.safeParse({
      ...request,
      confirmation: { ...request.confirmation, contentDigest: `sha256:${'b'.repeat(64)}` },
    }).success
  ).toBe(false);
  expect(
    ApplyAdministrationConfigurationRequestSchema.safeParse({ ...request, deploymentAdmin: true })
      .success
  ).toBe(false);
});
