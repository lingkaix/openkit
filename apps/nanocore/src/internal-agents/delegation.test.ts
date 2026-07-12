import { describe, expect, it } from 'vitest';

import { createStructuredWorkerDelegationRequest } from './delegation.js';

describe('structured worker delegation requests', () => {
  it('creates a structured app-local worker delegation request', () => {
    const request = createStructuredWorkerDelegationRequest({
      objective: 'Fix the failing projection test.',
      acceptanceCriteria: ['The focused test passes.', 'No unrelated files are changed.'],
      contextRefs: [
        { kind: 'workspace', id: 'ws_demo' },
        { kind: 'thread', id: 'th_demo' },
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
        requiresUserConfirmation: true,
        stopConditions: ['Stop if repository setup is invalid.'],
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
        reviewers: ['human', 'internal'],
        instructions: 'Review the diff and test output before continuing.',
      },
    });

    expect(request).toMatchObject({
      schemaVersion: 1,
      objective: 'Fix the failing projection test.',
      acceptanceCriteria: ['The focused test passes.', 'No unrelated files are changed.'],
      constraints: {
        maxContextTokens: 12_000,
        maxWorkerIterations: 1,
        requiresUserConfirmation: true,
      },
      reviewPolicy: {
        required: true,
        reviewers: ['human', 'internal'],
      },
    });
  });

  it('rejects malformed or oversized structured worker delegation requests', () => {
    expect(() =>
      createStructuredWorkerDelegationRequest({
        objective: 'x',
        acceptanceCriteria: [],
        contextRefs: [{ kind: 'workspace', id: 'ws_demo' }],
        expectedArtifacts: [],
        constraints: {
          maxContextTokens: 240_001,
          maxWorkerIterations: 1,
          requiresUserConfirmation: true,
          stopConditions: [],
        },
        verification: [],
        reviewPolicy: {
          required: true,
          reviewers: [],
          instructions: 'Review the work.',
        },
      })
    ).toThrow();
  });
});
