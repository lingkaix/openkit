import { describe, expect, it } from 'vitest';

import {
  createStructuredWorkerDelegationRequest,
  StructuredWorkerDelegationRequestSchema,
  serializeStructuredWorkerDelegationRequest,
} from './delegation.js';

describe('structured worker delegation requests', () => {
  it('creates a structured app-local worker delegation request', () => {
    const request = createStructuredWorkerDelegationRequest({
      objective: 'Fix the failing projection test.',
      acceptanceCriteria: ['The focused test passes.', 'No unrelated files are changed.'],
      contextRefs: [
        { kind: 'workspace', id: 'ws_00000000-0000-7000-8000-000000000001' },
        { kind: 'thread', id: 'th_00000000-0000-7000-8000-000000000001' },
        { kind: 'artifact', id: 'ar_00000000-0000-7000-8000-000000000007', artifactVersion: 7 },
        { kind: 'artifact', id: 'ar_00000000-0000-7000-8000-000000000008' },
      ],
      resources: [
        {
          kind: 'repository',
          reference: 'linked workspace repository',
          reason: 'The task changes repository code.',
        },
      ],
      expectedArtifacts: [
        {
          kind: 'code-change',
          description: 'Patch implementing the projection fix.',
        },
      ],
      constraints: {
        maxContextTokens: 12_000,
        maxWorkerIterations: 1,
      },
      verification: [
        {
          kind: 'command',
          description: 'Run the focused projection test.',
          command:
            'pnpm --filter @openkit/nanocore exec vitest run src/context/llm-projection.test.ts',
        },
      ],
      reviewPolicy: {
        required: true,
        reviewers: ['human'],
        instructions: 'Review the diff and test output before continuing.',
      },
      escalationConditions: ['Escalate if repository setup is invalid.'],
      reviewContext: null,
    });

    expect(request).toEqual({
      schemaVersion: 1,
      objective: 'Fix the failing projection test.',
      acceptanceCriteria: ['The focused test passes.', 'No unrelated files are changed.'],
      contextRefs: [
        { kind: 'workspace', id: 'ws_00000000-0000-7000-8000-000000000001' },
        { kind: 'thread', id: 'th_00000000-0000-7000-8000-000000000001' },
        { kind: 'artifact', id: 'ar_00000000-0000-7000-8000-000000000007', artifactVersion: 7 },
        { kind: 'artifact', id: 'ar_00000000-0000-7000-8000-000000000008' },
      ],
      resources: [
        {
          kind: 'repository',
          reference: 'linked workspace repository',
          reason: 'The task changes repository code.',
        },
      ],
      expectedArtifacts: [
        {
          kind: 'code-change',
          description: 'Patch implementing the projection fix.',
        },
      ],
      constraints: {
        maxContextTokens: 12_000,
        maxWorkerIterations: 1,
      },
      verification: [
        {
          kind: 'command',
          description: 'Run the focused projection test.',
          command:
            'pnpm --filter @openkit/nanocore exec vitest run src/context/llm-projection.test.ts',
        },
      ],
      reviewPolicy: {
        required: true,
        reviewers: ['human'],
        instructions: 'Review the diff and test output before continuing.',
      },
      escalationConditions: ['Escalate if repository setup is invalid.'],
      reviewContext: null,
    });
    expect(JSON.parse(serializeStructuredWorkerDelegationRequest(request))).toEqual(request);
  });

  it('allows positive Artifact versions only on Artifact context references', () => {
    const refs = StructuredWorkerDelegationRequestSchema.shape.contextRefs;
    expect(
      refs.safeParse([{ kind: 'artifact', id: 'ar_00000000-0000-7000-8000-0000000003ea', artifactVersion: 0 }]).success
    ).toBe(false);
    expect(refs.safeParse([{ kind: 'item', id: 'it_00000000-0000-7000-8000-0000000003ea', artifactVersion: 7 }]).success).toBe(
      false
    );
  });

  it('rejects malformed or oversized structured worker delegation requests', () => {
    expect(() =>
      createStructuredWorkerDelegationRequest({
        objective: 'x',
        acceptanceCriteria: [],
        contextRefs: [{ kind: 'workspace', id: 'ws_00000000-0000-7000-8000-000000000001' }],
        resources: [],
        expectedArtifacts: [],
        constraints: {
          maxContextTokens: 240_001,
          maxWorkerIterations: 1,
        },
        verification: [],
        reviewPolicy: {
          required: true,
          reviewers: [],
          instructions: 'Review the work.',
        },
        escalationConditions: [],
        reviewContext: null,
      })
    ).toThrow();
  });

  it('rejects retired execution policy fields', () => {
    expect(
      StructuredWorkerDelegationRequestSchema.shape.constraints.safeParse({
        maxContextTokens: 12_000,
        maxWorkerIterations: 1,
        requiresUserConfirmation: true,
        stopConditions: ['Stop after one turn.'],
      }).success
    ).toBe(false);
  });

  it('rejects non-human review authority', () => {
    expect(
      StructuredWorkerDelegationRequestSchema.shape.reviewPolicy.safeParse({
        required: true,
        reviewers: ['internal'],
        instructions: 'Review the work.',
      }).success
    ).toBe(false);
  });
});
