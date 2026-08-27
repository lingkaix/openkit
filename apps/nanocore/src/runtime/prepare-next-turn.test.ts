import { describe, expect, it } from 'vitest';

import type { LlmProjectionResult } from '../context/llm-projection.js';
import { prepareNextTurnContext } from './prepare-next-turn.js';

const TASK_EXECUTION_CONTRACT = {
  contextBudgetTokens: 12_000,
  resources: [
    {
      kind: 'repository' as const,
      reference: 'linked workspace repository',
      reason: 'The task changes repository code.',
    },
  ],
  expectedArtifacts: [{ kind: 'code-change' as const, description: 'NanoCore helper files.' }],
  verification: [
    {
      kind: 'test' as const,
      description: 'Run focused NanoCore tests.',
      command: 'pnpm --filter @openkit/nanocore test',
    },
  ],
  reviewPolicy: {
    required: true,
    reviewers: ['human'] as const,
    instructions: 'Review the focused diff and test evidence.',
  },
  escalationConditions: ['Escalate if repository setup is invalid.'],
};

/**
 * Builds a context projection fixture for prepare-next-turn tests.
 *
 * @param includedItemIds Durable item ids included in provider-visible context.
 * @returns Context projection result.
 */
function projectionFixture(includedItemIds: readonly string[]): LlmProjectionResult {
  return {
    policyVersion: 1,
    contextPackageDigest: 'ctxpkg_sha256_demo',
    providerMessages: includedItemIds.map((itemId) => ({
      role: 'user',
      content: `Context from ${itemId}`,
    })),
    includedItemIds,
    excludedItems: [],
    decisions: [],
  };
}

describe('prepareNextTurnContext', () => {
  it('prepares authorized worker request facts for the next task', () => {
    const prepared = prepareNextTurnContext({
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      taskState: {
        objective: 'Add a helper for durable user turn queues.',
        acceptanceCriteria: ['Helper tests pass.', 'No raw user text is persisted.'],
        ...TASK_EXECUTION_CONTRACT,
      },
      contextProjection: projectionFixture(['item_context']),
    });

    expect(prepared.contextPackageDigest).toBe('ctxpkg_sha256_demo');
    expect(prepared.objective).toBe('Add a helper for durable user turn queues.');
    expect(prepared.workerRequestDetails).toMatchObject({
      acceptanceCriteria: ['Helper tests pass.', 'No raw user text is persisted.'],
      resources: TASK_EXECUTION_CONTRACT.resources,
      expectedArtifacts: [{ kind: 'code-change', description: 'NanoCore helper files.' }],
      constraints: {
        maxContextTokens: 12_000,
        maxWorkerIterations: 1,
      },
      verification: TASK_EXECUTION_CONTRACT.verification,
      reviewPolicy: TASK_EXECUTION_CONTRACT.reviewPolicy,
      escalationConditions: TASK_EXECUTION_CONTRACT.escalationConditions,
      reviewContext: null,
    });
    expect(prepared.contextRefs).toEqual([{ kind: 'item', id: 'item_context' }]);
  });

  it('fails when there is no included context', () => {
    expect(() =>
      prepareNextTurnContext({
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        taskState: {
          objective: 'Prepare a worker turn.',
          acceptanceCriteria: ['Worker request is created.'],
          ...TASK_EXECUTION_CONTRACT,
        },
        contextProjection: projectionFixture([]),
      })
    ).toThrow('prepareNextTurnContext requires at least one included context item.');
  });
});
