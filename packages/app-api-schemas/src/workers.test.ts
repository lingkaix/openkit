import { describe, expect, it } from 'vitest';

import {
  WorkspaceWorkerSchema,
  WorkspaceWorkersResponseSchema,
  WorkspaceWorkerWorkSchema,
} from './workers.js';

const recordedAt = '2026-09-17T02:00:00.000Z';

/** Builds one valid Worker row with distinct package preference and last-used model. */
function worker(overrides: Record<string, unknown> = {}) {
  return {
    threadId: 'th_00000000-0000-7511-9db5-ba3f596149a8',
    threadTitle: 'Test ghp_publicFixture',
    agentId: 'agent_codex_host',
    agentName: 'sk-Latn fixture Agent',
    status: 'busy',
    recordUpdatedAt: recordedAt,
    stale: false,
    work: {
      kind: 'goal',
      turnId: 'tu_00000000-0000-721e-b9c7-66142de81c58',
      goalId: 'goal_worker',
      taskId: 'task_worker',
    },
    packageDetails: {
      kind: 'available',
      preferredLogicalModelId: 'openai/gpt-preferred',
      mcpServers: [
        {
          id: 'github',
          allowedTools: ['list_issues'],
          deniedTools: ['delete_repo'],
          approvalRequiredTools: ['create_issue'],
        },
      ],
      filesystem: { default: 'deny', enforcement: 'openshell', ruleCount: 1 },
      network: { default: 'deny', enforcement: 'openshell', ruleCount: 0 },
      process: null,
    },
    lastUsedModel: {
      kind: 'available',
      modelId: 'openai/gpt-last-used',
      recordedAt,
    },
    ...overrides,
  };
}

describe('WorkspaceWorkersResponseSchema', () => {
  it('accepts distinct package preference, last-used model, and explicit work states', () => {
    const parsed = WorkspaceWorkersResponseSchema.parse({
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      items: [
        worker(),
        worker({
          threadId: 'th_00000000-0000-75a6-bc34-5d61e9d70ab1',
          threadTitle: 'Idle Task',
          status: 'idle',
          work: { kind: 'none' },
          packageDetails: { kind: 'unavailable' },
          lastUsedModel: { kind: 'restricted' },
        }),
        worker({
          threadId: 'th_00000000-0000-7f4d-8b32-425735d1e383',
          work: { kind: 'task', turnId: 'tu_00000000-0000-703f-a142-6ac402fd9d5e' },
          lastUsedModel: { kind: 'unavailable' },
        }),
      ],
    });

    expect(parsed.items[0]?.threadTitle).toBe('Test ghp_publicFixture');
    expect(parsed.items[0]?.agentName).toBe('sk-Latn fixture Agent');
    expect(parsed.items.map((item) => item.threadId)).toEqual([
      'th_00000000-0000-7511-9db5-ba3f596149a8',
      'th_00000000-0000-75a6-bc34-5d61e9d70ab1',
      'th_00000000-0000-7f4d-8b32-425735d1e383',
    ]);
    expect(parsed.items[0]?.packageDetails).toMatchObject({
      kind: 'available',
      preferredLogicalModelId: 'openai/gpt-preferred',
      process: null,
    });
    expect(parsed.items[0]?.lastUsedModel).toMatchObject({
      kind: 'available',
      modelId: 'openai/gpt-last-used',
    });
    expect(parsed.items[0]?.work).toEqual({
      kind: 'goal',
      turnId: 'tu_00000000-0000-721e-b9c7-66142de81c58',
      goalId: 'goal_worker',
      taskId: 'task_worker',
    });
    expect(parsed.items[1]?.work).toEqual({ kind: 'none' });
    expect(parsed.items[1]?.lastUsedModel).toEqual({ kind: 'restricted' });
    expect(parsed.items[2]?.work).toEqual({
      kind: 'task',
      turnId: 'tu_00000000-0000-703f-a142-6ac402fd9d5e',
    });
  });

  it('rejects hidden runtime identifiers and half Goal assignment', () => {
    expect(
      WorkspaceWorkerSchema.safeParse(
        worker({ agentSessionId: 'as_00000000-0000-7271-8ba3-bea82b217022' })
      ).success
    ).toBe(false);
    expect(WorkspaceWorkerSchema.safeParse(worker({ workerSessionId: 'wkr_hidden' })).success).toBe(
      false
    );
    expect(
      WorkspaceWorkerWorkSchema.safeParse({
        kind: 'goal',
        turnId: 'tu_00000000-0000-721e-b9c7-66142de81c58',
      }).success
    ).toBe(false);
    expect(
      WorkspaceWorkerWorkSchema.safeParse({
        kind: 'goal',
        turnId: 'tu_00000000-0000-721e-b9c7-66142de81c58',
        goalId: 'goal_worker',
      }).success
    ).toBe(false);
    expect(
      WorkspaceWorkerWorkSchema.safeParse({
        kind: 'goal',
        turnId: 'tu_00000000-0000-721e-b9c7-66142de81c58',
        taskId: 'task_worker',
      }).success
    ).toBe(false);
    expect(WorkspaceWorkerSchema.safeParse(worker({ status: 'interrupted' })).success).toBe(false);
    expect(WorkspaceWorkersResponseSchema.safeParse({ items: [] }).success).toBe(false);
    expect(
      WorkspaceWorkerSchema.safeParse(
        worker({
          packageDetails: {
            kind: 'available',
            preferredLogicalModelId: 'openai/gpt-preferred',
            mcpServers: [],
            filesystem: null,
            network: null,
          },
        })
      ).success
    ).toBe(false);
  });
});
