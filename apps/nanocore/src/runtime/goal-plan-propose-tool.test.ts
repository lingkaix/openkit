import { describe, expect, it, vi } from 'vitest';
import {
  createInMemoryRuntimeConfigSnapshot,
  type RuntimeConfigSnapshot,
} from '../config/runtime-config.js';
import type {
  AgentAssistantMessage,
  InternalAgentProviderCall,
} from '../internal-agents/internal-agent-loop.js';
import type { ResolvedLLMProviderConfig } from '../providers/llm-config.js';
import { ProviderRegistry } from '../providers/registry.js';
import { createDeterministicGoalPlanFallback, type GoalPlanOutput } from './goal-plan.js';
import {
  createGoalPlanProposeTool,
  createPreApprovalGoalPlanRevisionPlanner,
  GOAL_ORCHESTRATOR_ROLE_ID,
  GOAL_PLAN_PROPOSE_TOOL_NAME,
  runPreApprovalGoalPlanRevision,
} from './goal-plan-propose-tool.js';
import { GoalPlanRevisionError } from './goal-planning.js';
import type { GoalRecord } from './goal-store.js';

const GOAL: GoalRecord = {
  goalId: 'goal_revise',
  workspaceId: 'ws_demo',
  threadId: 'th_demo',
  status: 'planning',
  title: 'Ship v0.0.6',
  objective: 'Make v0.0.6 ready to publish.',
  createdByItemId: null,
  planItemId: null,
  currentTaskId: null,
  terminalStopReason: null,
  workerStorageChoice: null,
  createdAt: '2026-09-17T00:00:00.000Z',
  updatedAt: '2026-09-17T00:00:00.000Z',
};

const PREVIOUS_PLAN = createDeterministicGoalPlanFallback({
  goalTitle: GOAL.title,
  objective: GOAL.objective,
});

const REVISION = 'Split this into two bounded worker tasks.';

const MODEL = {
  logicalModelId: 'openai/gpt-5.2',
  capabilities: ['responses', 'tool-calling'],
  modelFamilyId: 'gpt',
};

const CONTEXT = {
  type: 'compaction' as const,
  compactThreshold: 8_000,
  authority: 'openkit' as const,
};

/**
 * Builds one two-task Plan that consumes the prior draft and revision text.
 *
 * @param previous Prior Plan payload.
 * @returns Revised Plan payload.
 */
function twoTaskPlan(previous: GoalPlanOutput): GoalPlanOutput {
  const first = previous.tasks[0];
  if (!first) {
    throw new Error('previous Plan has no tasks');
  }
  return {
    ...previous,
    goalSummary: `${previous.goalSummary} Revision: ${REVISION}`,
    tasks: [
      first,
      {
        ...first,
        taskId: 'task_2',
        title: 'Apply the requested revision',
        objective: REVISION,
        dependsOnTaskIds: [first.taskId],
      },
    ],
  };
}

/**
 * Builds one assistant message for the internal-agent loop.
 *
 * @param content Assistant content blocks.
 * @returns Assistant message.
 */
function assistantMessage(content: AgentAssistantMessage['content']): AgentAssistantMessage {
  return { role: 'assistant', content, truncated: false };
}

describe('goal.plan.propose Tool', () => {
  it('submits a schema-valid Plan through existing graph checks', async () => {
    const submitted: GoalPlanOutput[] = [];
    const tool = createGoalPlanProposeTool((plan) => {
      submitted.push(plan);
    });
    const plan = twoTaskPlan(PREVIOUS_PLAN);
    const result = await tool.execute(plan, {
      callId: 'call_1',
      signal: new AbortController().signal,
    });
    expect(tool.name).toBe(GOAL_PLAN_PROPOSE_TOOL_NAME);
    expect(result.isError).not.toBe(true);
    expect(submitted).toEqual([plan]);
  });

  it('rejects a cyclic Plan without submitting', async () => {
    const submitted: GoalPlanOutput[] = [];
    const tool = createGoalPlanProposeTool((plan) => {
      submitted.push(plan);
    });
    const first = PREVIOUS_PLAN.tasks[0];
    if (!first) {
      throw new Error('previous Plan has no tasks');
    }
    const result = await tool.execute(
      {
        ...PREVIOUS_PLAN,
        tasks: [
          { ...first, taskId: 'task_1', dependsOnTaskIds: ['task_2'] },
          { ...first, taskId: 'task_2', dependsOnTaskIds: ['task_1'] },
        ],
      },
      { callId: 'call_1', signal: new AbortController().signal }
    );
    expect(result.isError).toBe(true);
    expect(submitted).toEqual([]);
  });
});

describe('pre-approval Goal Plan revision Turn', () => {
  it('assembles Goal, exact previous Plan, and revision then returns the proposed Plan', async () => {
    const proposed = twoTaskPlan(PREVIOUS_PLAN);
    const callProvider = vi
      .fn<InternalAgentProviderCall>()
      .mockResolvedValueOnce({
        message: assistantMessage([
          {
            type: 'toolCall',
            callId: 'call_propose',
            name: GOAL_PLAN_PROPOSE_TOOL_NAME,
            arguments: proposed,
          },
        ]),
      })
      .mockResolvedValueOnce({
        message: assistantMessage([{ type: 'text', text: 'Proposed.' }]),
      });

    const plan = await runPreApprovalGoalPlanRevision({
      goal: GOAL,
      previousPlan: PREVIOUS_PLAN,
      previousPlanItemId: 'it_goal_plan_prior',
      revisionText: REVISION,
      model: MODEL,
      contextManagement: CONTEXT,
      limits: { maxModelTurns: 4, maxToolCalls: 2, deadlineMs: 5_000 },
      callProvider,
      signal: new AbortController().signal,
    });

    expect(plan.tasks.map((task) => task.taskId)).toEqual(['task_1', 'task_2']);
    const firstCall = callProvider.mock.calls[0]?.[0];
    expect(firstCall?.tools.map((tool) => tool.name)).toEqual([GOAL_PLAN_PROPOSE_TOOL_NAME]);
    const userText = firstCall?.messages[0];
    expect(userText).toMatchObject({ role: 'user' });
    const text =
      userText && userText.role === 'user' && userText.content[0]?.type === 'text'
        ? userText.content[0].text
        : '';
    const payload = JSON.parse(text) as {
      previousPlanItemId: string;
      previousPlan: GoalPlanOutput;
      revision: string;
    };
    expect(payload).toMatchObject({
      previousPlanItemId: 'it_goal_plan_prior',
      previousPlan: PREVIOUS_PLAN,
      revision: REVISION,
    });
  });

  it('fails closed when the model never proposes a Plan', async () => {
    const callProvider = vi.fn<InternalAgentProviderCall>().mockResolvedValue({
      message: assistantMessage([{ type: 'text', text: 'No tool.' }]),
    });

    await expect(
      runPreApprovalGoalPlanRevision({
        goal: GOAL,
        previousPlan: PREVIOUS_PLAN,
        previousPlanItemId: 'it_goal_plan_prior',
        revisionText: REVISION,
        model: MODEL,
        contextManagement: CONTEXT,
        limits: { maxModelTurns: 4, maxToolCalls: 2, deadlineMs: 5_000 },
        callProvider,
        signal: new AbortController().signal,
      })
    ).rejects.toMatchObject({
      name: 'GoalPlanRevisionError',
      code: 'goal_plan_revision_invalid',
    });
  });

  it('fails closed when the provider call is unavailable', async () => {
    const callProvider = vi.fn<InternalAgentProviderCall>().mockRejectedValue(new Error('down'));

    await expect(
      runPreApprovalGoalPlanRevision({
        goal: GOAL,
        previousPlan: PREVIOUS_PLAN,
        previousPlanItemId: 'it_goal_plan_prior',
        revisionText: REVISION,
        model: MODEL,
        contextManagement: CONTEXT,
        limits: { maxModelTurns: 4, maxToolCalls: 2, deadlineMs: 5_000 },
        callProvider,
        signal: new AbortController().signal,
      })
    ).rejects.toMatchObject({
      name: 'GoalPlanRevisionError',
      code: 'goal_plan_revision_unavailable',
    });
  });

  it('does not accept a proposed Plan after a failed or limited loop exit', async () => {
    const proposed = twoTaskPlan(PREVIOUS_PLAN);
    const failedAfterPropose = vi
      .fn<InternalAgentProviderCall>()
      .mockResolvedValueOnce({
        message: assistantMessage([
          {
            type: 'toolCall',
            callId: 'call_propose',
            name: GOAL_PLAN_PROPOSE_TOOL_NAME,
            arguments: proposed,
          },
        ]),
      })
      .mockRejectedValueOnce(new Error('down'));

    await expect(
      runPreApprovalGoalPlanRevision({
        goal: GOAL,
        previousPlan: PREVIOUS_PLAN,
        previousPlanItemId: 'it_goal_plan_prior',
        revisionText: REVISION,
        model: MODEL,
        contextManagement: CONTEXT,
        limits: { maxModelTurns: 4, maxToolCalls: 2, deadlineMs: 5_000 },
        callProvider: failedAfterPropose,
        signal: new AbortController().signal,
      })
    ).rejects.toMatchObject({
      name: 'GoalPlanRevisionError',
      code: 'goal_plan_revision_unavailable',
    });

    const limitedAfterPropose = vi.fn<InternalAgentProviderCall>().mockResolvedValue({
      message: assistantMessage([
        {
          type: 'toolCall',
          callId: 'call_limit',
          name: GOAL_PLAN_PROPOSE_TOOL_NAME,
          arguments: proposed,
        },
      ]),
    });

    await expect(
      runPreApprovalGoalPlanRevision({
        goal: GOAL,
        previousPlan: PREVIOUS_PLAN,
        previousPlanItemId: 'it_goal_plan_prior',
        revisionText: REVISION,
        model: MODEL,
        contextManagement: CONTEXT,
        limits: { maxModelTurns: 1, maxToolCalls: 4, deadlineMs: 5_000 },
        callProvider: limitedAfterPropose,
        signal: new AbortController().signal,
      })
    ).rejects.toMatchObject({
      name: 'GoalPlanRevisionError',
      code: 'goal_plan_revision_unavailable',
    });
  });

  it('does not return a proposed Plan after the caller aborts before loop completion', async () => {
    const proposed = twoTaskPlan(PREVIOUS_PLAN);
    const abort = new AbortController();
    const callProvider = vi
      .fn<InternalAgentProviderCall>()
      .mockResolvedValueOnce({
        message: assistantMessage([
          {
            type: 'toolCall',
            callId: 'call_propose',
            name: GOAL_PLAN_PROPOSE_TOOL_NAME,
            arguments: proposed,
          },
        ]),
      })
      .mockImplementationOnce(async () => {
        abort.abort();
        throw new Error('aborted');
      });

    await expect(
      runPreApprovalGoalPlanRevision({
        goal: GOAL,
        previousPlan: PREVIOUS_PLAN,
        previousPlanItemId: 'it_goal_plan_prior',
        revisionText: REVISION,
        model: MODEL,
        contextManagement: CONTEXT,
        limits: { maxModelTurns: 4, maxToolCalls: 2, deadlineMs: 5_000 },
        callProvider,
        signal: abort.signal,
      })
    ).rejects.toMatchObject({
      name: 'GoalPlanRevisionError',
      code: 'goal_plan_revision_unavailable',
    });
  });
});

describe('pre-approval Goal Plan revision planner factory', () => {
  it('resolves the Goal Orchestrator model and returns a revised Plan through the Gateway dispatcher', async () => {
    const proposed = twoTaskPlan(PREVIOUS_PLAN);
    const providerProfile = {
      baseUrl: 'https://provider.invalid/v1',
      displayName: 'Provider',
      id: 'provider',
      kind: 'custom' as const,
      modelMetadata: {
        model: {
          family: 'test',
          limit: { context: 200_000, output: 8_000 },
          modalities: { input: ['text'], output: ['text'] },
          tool_call: true,
        },
      },
      models: ['model'],
    };
    const snapshot = createInMemoryRuntimeConfigSnapshot({
      gatewayConfig: {
        schemaVersion: 1,
        enabled: true,
        defaultLogicalModelId: 'reasoning',
        requiredFeatures: [],
        logicalModels: [
          {
            id: 'reasoning',
            displayName: 'Reasoning',
            contextManagement: [{ type: 'compaction', compactThreshold: 50_000 }],
            routes: [
              { id: 'primary', providerProfileId: providerProfile.id, providerModel: 'model' },
            ],
          },
        ],
      },
      internalRoleProfiles: {
        schemaVersion: 1,
        defaultLogicalModelId: 'reasoning',
        profiles: [
          {
            id: 'goal-orchestrator-default',
            roleId: GOAL_ORCHESTRATOR_ROLE_ID,
            preferredLogicalModelId: 'reasoning',
            compatibleLogicalModelIds: [],
            requiredLogicalModelCapabilities: ['responses', 'tool-calling'],
          },
        ],
      },
      providerRegistry: new ProviderRegistry([providerProfile]),
    });
    const createResponses = vi
      .fn()
      .mockResolvedValueOnce({
        id: 'resp_goal_plan_propose',
        object: 'response',
        status: 'completed',
        output: [
          {
            type: 'function_call',
            call_id: 'call_propose',
            name: GOAL_PLAN_PROPOSE_TOOL_NAME,
            arguments: JSON.stringify(proposed),
          },
        ],
      })
      .mockResolvedValueOnce({
        id: 'resp_goal_plan_proposed',
        object: 'response',
        status: 'completed',
        output: [
          {
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'Proposed.' }],
          },
        ],
      });
    const planner = createPreApprovalGoalPlanRevisionPlanner({
      runtimeConfig: () => snapshot,
      llmGatewayDispatcher: { createResponses },
      resolveGatewayProvider: () =>
        ({
          adapterId: 'provider',
          apiKey: 'unused',
          baseUrl: providerProfile.baseUrl,
          displayName: providerProfile.displayName,
          gatewayCapabilities: { chatCompletions: 'native', responses: 'native' },
          id: providerProfile.id,
          models: providerProfile.models,
          requiresApiKey: true,
        }) satisfies ResolvedLLMProviderConfig,
      workspaceId: 'ws_demo',
      userId: 'user_demo',
      signal: new AbortController().signal,
    });

    const plan = await planner({
      goal: GOAL,
      previousPlan: PREVIOUS_PLAN,
      previousPlanItemId: 'it_goal_plan_prior',
      revisionText: REVISION,
    });

    expect(plan).toEqual(proposed);
    expect(createResponses).toHaveBeenCalled();
    const firstRequest = createResponses.mock.calls[0]?.[1] as {
      input?: Array<{
        role?: string;
        content?: Array<{ type?: string; text?: string }>;
      }>;
      metadata?: { openkit?: { sessionId?: string; workspaceId?: string } };
      tools?: Array<{ name: string }>;
    };
    expect(firstRequest?.tools?.map((tool) => tool.name)).toEqual([GOAL_PLAN_PROPOSE_TOOL_NAME]);
    expect(firstRequest?.metadata).toEqual({
      openkit: {
        sessionId: `${GOAL_ORCHESTRATOR_ROLE_ID}:${GOAL.goalId}`,
        workspaceId: 'ws_demo',
      },
    });
    const userText = firstRequest?.input?.[0]?.content?.find(
      (part) => part.type === 'input_text'
    )?.text;
    expect(typeof userText).toBe('string');
    expect(JSON.parse(userText ?? '')).toMatchObject({
      previousPlanItemId: 'it_goal_plan_prior',
      previousPlan: PREVIOUS_PLAN,
      revision: REVISION,
    });
  });

  it('throws a typed unavailable error when Goal Orchestrator has no admitted model', async () => {
    const planner = createPreApprovalGoalPlanRevisionPlanner({
      runtimeConfig: () =>
        ({
          gatewayConfig: {
            schemaVersion: 1,
            enabled: true,
            requiredFeatures: [],
            logicalModels: [],
          },
          internalRoleProfiles: { schemaVersion: 1, profiles: [] },
          providerRegistry: new ProviderRegistry([]),
          userConfigs: [],
          workspaceConfigs: [],
        }) as RuntimeConfigSnapshot,
      llmGatewayDispatcher: { createResponses: vi.fn() },
      resolveGatewayProvider: () => {
        throw new Error('unused');
      },
      workspaceId: 'ws_demo',
      userId: 'user_demo',
      signal: new AbortController().signal,
    });

    await expect(
      planner({
        goal: GOAL,
        previousPlan: PREVIOUS_PLAN,
        previousPlanItemId: 'it_goal_plan_prior',
        revisionText: REVISION,
      })
    ).rejects.toBeInstanceOf(GoalPlanRevisionError);
    await expect(
      planner({
        goal: GOAL,
        previousPlan: PREVIOUS_PLAN,
        previousPlanItemId: 'it_goal_plan_prior',
        revisionText: REVISION,
      })
    ).rejects.toMatchObject({ code: 'goal_plan_revision_unavailable' });
  });
});
