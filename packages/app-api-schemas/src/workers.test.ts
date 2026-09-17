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
    threadId: 'th_worker',
    threadTitle: 'Implement inventory',
    agentId: 'agent_codex_host',
    agentName: 'Codex',
    status: 'busy',
    recordUpdatedAt: recordedAt,
    stale: false,
    work: {
      kind: 'goal',
      turnId: 'turn_worker',
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
      workspaceId: 'ws_demo',
      items: [
        worker(),
        worker({
          threadId: 'th_idle',
          threadTitle: 'Idle Task',
          status: 'idle',
          work: { kind: 'none' },
          packageDetails: { kind: 'unavailable' },
          lastUsedModel: { kind: 'restricted' },
        }),
        worker({
          threadId: 'th_task',
          work: { kind: 'task', turnId: 'turn_task' },
          lastUsedModel: { kind: 'unavailable' },
        }),
      ],
    });

    expect(parsed.items.map((item) => item.threadId)).toEqual(['th_worker', 'th_idle', 'th_task']);
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
      turnId: 'turn_worker',
      goalId: 'goal_worker',
      taskId: 'task_worker',
    });
    expect(parsed.items[1]?.work).toEqual({ kind: 'none' });
    expect(parsed.items[1]?.lastUsedModel).toEqual({ kind: 'restricted' });
    expect(parsed.items[2]?.work).toEqual({ kind: 'task', turnId: 'turn_task' });
  });

  it('rejects hidden runtime identifiers and half Goal assignment', () => {
    expect(WorkspaceWorkerSchema.safeParse(worker({ agentSessionId: 'as_hidden' })).success).toBe(
      false
    );
    expect(WorkspaceWorkerSchema.safeParse(worker({ workerSessionId: 'wkr_hidden' })).success).toBe(
      false
    );
    expect(
      WorkspaceWorkerWorkSchema.safeParse({ kind: 'goal', turnId: 'turn_worker' }).success
    ).toBe(false);
    expect(
      WorkspaceWorkerWorkSchema.safeParse({
        kind: 'goal',
        turnId: 'turn_worker',
        goalId: 'goal_worker',
      }).success
    ).toBe(false);
    expect(
      WorkspaceWorkerWorkSchema.safeParse({
        kind: 'goal',
        turnId: 'turn_worker',
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
