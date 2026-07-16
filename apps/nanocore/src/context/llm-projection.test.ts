import type { ItemSchema } from '@openkit/protocol';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';

import { convertToLlm, createContextPackageRecord } from './llm-projection.js';
import { LLM_PROJECTION_POLICY_VERSION, type LlmProjectionPolicy } from './projection-policy.js';

type Item = z.infer<typeof ItemSchema>;

const BASE_ITEM = {
  workspaceId: 'ws_projection',
  threadId: 'th_projection',
  turnId: 'turn_projection',
  status: 'completed',
  createdAt: '2026-05-31T00:00:00.000Z',
  completedAt: '2026-05-31T00:00:01.000Z',
} as const;

const TEST_POLICY: LlmProjectionPolicy = {
  version: LLM_PROJECTION_POLICY_VERSION,
  defaultOutcome: 'ui-only',
  categoryOutcomes: {
    user: 'model-visible',
    assistant: 'model-visible',
    artifact: 'summarized',
    approval: 'summarized',
    review: 'summarized',
    goal: 'summarized',
    diagnostic: 'ui-only',
  },
};

describe('convertToLlm', () => {
  it('projects durable items into provider messages and inclusion records', () => {
    const items: Item[] = [
      {
        ...BASE_ITEM,
        id: 'item_user',
        type: 'user-message',
        text: 'Please fix the failing test.',
      },
      {
        ...BASE_ITEM,
        id: 'item_assistant',
        type: 'assistant-message',
        text: 'I will inspect the failure.',
      },
      {
        ...BASE_ITEM,
        id: 'item_status',
        type: 'status',
        level: 'info',
        title: 'Running tests',
        summary: 'vitest is running',
      },
      {
        ...BASE_ITEM,
        id: 'item_artifact',
        type: 'artifact-reference',
        artifactId: 'artifact_patch',
        artifactVersion: 1,
        title: 'Patch summary',
        summary: 'Changed the runner loop.',
      },
      {
        ...BASE_ITEM,
        id: 'item_approval',
        type: 'approval-request',
        approvalRequestId: 'approval_1',
        title: 'Run command',
        description: 'Run pnpm test.',
        kind: 'permission',
      },
      {
        ...BASE_ITEM,
        id: 'item_review',
        type: 'reasoning',
        summary: ['Review passed'],
        content: ['No blocking issues found.'],
      },
      {
        ...BASE_ITEM,
        id: 'item_goal',
        type: 'plan',
        title: 'Goal plan',
        summary: 'Complete the release tasks.',
        steps: [{ id: 'step_1', title: 'Implement projection', status: 'completed' }],
      },
    ];

    const result = convertToLlm(items, TEST_POLICY);

    expect(result.policyVersion).toBe(LLM_PROJECTION_POLICY_VERSION);
    expect(result.includedItemIds).toEqual([
      'item_user',
      'item_assistant',
      'item_artifact',
      'item_approval',
      'item_review',
      'item_goal',
    ]);
    expect(result.excludedItems).toEqual([
      {
        itemId: 'item_status',
        itemType: 'status',
        category: 'diagnostic',
        outcome: 'ui-only',
        exclusionReason: 'diagnostic_noise',
      },
    ]);
    expect(result.providerMessages).toEqual([
      { role: 'user', content: 'Please fix the failing test.' },
      { role: 'assistant', content: 'I will inspect the failure.' },
      {
        role: 'developer',
        content: 'Artifact artifact_patch: Patch summary\nChanged the runner loop.',
      },
      {
        role: 'developer',
        content: 'Approval required approval_1: Run command\nRun pnpm test.',
      },
      {
        role: 'developer',
        content: 'Review item_review:\nReview passed\nNo blocking issues found.',
      },
      {
        role: 'developer',
        content:
          'Goal item_goal: Goal plan\nComplete the release tasks.\n- Implement projection: completed',
      },
    ]);
  });

  it('generates deterministic context package digests from included content', () => {
    const baseItems: Item[] = [
      {
        ...BASE_ITEM,
        id: 'item_user',
        type: 'user-message',
        text: 'Please fix the failing test.',
      },
    ];
    const changedItems: Item[] = [
      {
        ...BASE_ITEM,
        id: 'item_user',
        type: 'user-message',
        text: 'Please fix the failing test and update docs.',
      },
    ];

    const first = convertToLlm(baseItems, TEST_POLICY);
    const second = convertToLlm(baseItems, TEST_POLICY);
    const changed = convertToLlm(changedItems, TEST_POLICY);

    expect(first.contextPackageDigest).toMatch(/^ctxpkg_sha256_[a-f0-9]{64}$/);
    expect(first.contextPackageDigest).toBe(second.contextPackageDigest);
    expect(changed.contextPackageDigest).not.toBe(first.contextPackageDigest);
  });

  it('creates attachable context package records for internal agents and worker turns', () => {
    const result = convertToLlm(
      [
        {
          ...BASE_ITEM,
          id: 'item_user',
          type: 'user-message',
          text: 'Please fix the failing test.',
        },
        {
          ...BASE_ITEM,
          id: 'item_status',
          type: 'status',
          level: 'info',
          title: 'Running tests',
          summary: 'vitest is running',
        },
      ],
      TEST_POLICY
    );

    expect(
      createContextPackageRecord(result, {
        targetKind: 'internal-agent',
        targetId: 'run_1',
      })
    ).toEqual({
      digest: result.contextPackageDigest,
      policyVersion: LLM_PROJECTION_POLICY_VERSION,
      includedItemIds: ['item_user'],
      excludedItemIds: ['item_status'],
      targetKind: 'internal-agent',
      targetId: 'run_1',
    });
    expect(
      createContextPackageRecord(result, {
        targetKind: 'worker-turn',
        targetId: 'turn_1',
      })
    ).toMatchObject({
      digest: result.contextPackageDigest,
      targetKind: 'worker-turn',
      targetId: 'turn_1',
    });
  });
});
