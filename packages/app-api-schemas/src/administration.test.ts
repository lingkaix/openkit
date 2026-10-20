import { describe, expect, it } from 'vitest';

import {
  ApplyAdministrationConfigurationRequestSchema,
  ConfigurationCandidateArtifactSchema,
  ProposeAdministrationConfigurationRequestSchema,
  SubmitAdministrationConversationRequestSchema,
} from './administration.js';

describe('administration App API schemas', () => {
  it('retains optional typed Policy warnings but never accepts them as author input', () => {
    const request = {
      targetFamily: 'policy',
      targetId: 'server',
      expectedRevision: `sha256:${'a'.repeat(64)}`,
      changes: {
        proposed: { schemaVersion: 1, statements: [] },
        rationale: 'Restrict future Tool use.',
      },
    };
    const candidate = {
      ...request,
      kind: 'administration-configuration-candidate',
      before: {},
      after: {},
      restartRequired: false,
      command: 'administration.configuration.apply',
      operation: 'update',
      policyProposal: {
        schemaVersion: 1,
        proposer: { kind: 'human', id: 'usr_00000000-0000-7000-8000-000000000001' },
        rationale: request.changes.rationale,
        baseRevision: request.expectedRevision,
        proposed: request.changes.proposed,
        validation: 'valid',
      },
    };
    const warning = {
      code: 'mcp_tool_unobserved',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      serverId: 'issues',
      toolName: 'future-tool',
      message: 'Exact-name restriction applies when this Tool is exposed.',
    };
    expect(ConfigurationCandidateArtifactSchema.safeParse(candidate).success).toBe(true);
    expect(
      ConfigurationCandidateArtifactSchema.safeParse({ ...candidate, warnings: [] }).success
    ).toBe(true);
    expect(
      ConfigurationCandidateArtifactSchema.parse({ ...candidate, warnings: [warning] })
    ).toMatchObject({ warnings: [warning] });
    expect(
      ConfigurationCandidateArtifactSchema.safeParse({
        ...candidate,
        warnings: [{ ...warning, code: 'unknown' }],
      }).success
    ).toBe(false);
    expect(
      ProposeAdministrationConfigurationRequestSchema.safeParse({ ...request, warnings: [warning] })
        .success
    ).toBe(false);
    expect(
      ConfigurationCandidateArtifactSchema.safeParse({
        ...candidate,
        policyProposal: { ...candidate.policyProposal, warnings: [warning] },
      }).success
    ).toBe(false);
  });
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
