import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  listWorkspaceCapabilityCalls,
  listWorkspaceUsageRecords,
} from '../capability/usage-ledger.js';
import {
  createInMemoryRuntimeConfigSnapshot,
  type RuntimeConfigSnapshot,
} from '../config/runtime-config.js';
import type {
  AgentAssistantMessage,
  InternalAgentProviderCall,
} from '../internal-agents/internal-agent-loop.js';
import { PiAiGatewayConfigurationError } from '../llm/pi-ai-client.js';
import type { ResolvedLLMProviderConfig } from '../providers/llm-config.js';
import { ProviderRegistry } from '../providers/registry.js';
import { createProviderCredentialConfigured } from '../providers/vault-credential-resolver.js';
import { type CoreDb, openCoreDb, openWorkspaceDb, type WorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { createDeterministicGoalPlanFallback, type GoalPlanOutput } from './goal-plan.js';
import {
  createGoalPlanPlanner,
  createGoalPlanProposeTool,
  GOAL_ORCHESTRATOR_ROLE_ID,
  GOAL_PLAN_PROPOSE_TOOL_NAME,
  runGoalPlanProposal,
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
const REVISION_ACTOR = { kind: 'user', id: 'user_demo' } as const;

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
 * Opens isolated Core and Workspace databases for revision usage regressions.
 *
 * @returns Migrated Core and Workspace database handles.
 */
function openRevisionUsageStorage(): { coreDb: CoreDb; workspaceDb: WorkspaceDb } {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-goal-plan-revision-usage-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  const store = createDemoStore({ dataRoot });
  store.createTurn(GOAL.workspaceId, GOAL.threadId, 'Revise Plan', REVISION_ACTOR, null, {
    turnId: 'tu_revision_capture',
  });
  const workspaceDb = openWorkspaceDb(dataRoot, GOAL.workspaceId);
  applyScopedMigrations(workspaceDb);
  return { coreDb, workspaceDb };
}

/**
 * Builds the admitted Goal Orchestrator snapshot used by planner factory tests.
 *
 * @returns Snapshot and Gateway provider resolver for the test provider.
 */
function admittedOrchestratorBindings(): {
  snapshot: ReturnType<typeof createInMemoryRuntimeConfigSnapshot>;
  resolveGatewayProvider: () => ResolvedLLMProviderConfig;
} {
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
  return {
    snapshot: createInMemoryRuntimeConfigSnapshot({
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
    }),
    resolveGatewayProvider: () =>
      ({
        adapterId: 'provider',
        apiKey: 'unused',
        baseUrl: providerProfile.baseUrl,
        displayName: providerProfile.displayName,
        gatewayCapabilities: { chatCompletions: 'native', responses: 'native' },
        id: providerProfile.id,
        models: providerProfile.models,
        modelMetadata: providerProfile.modelMetadata,
        requiresApiKey: true,
      }) satisfies ResolvedLLMProviderConfig,
  };
}

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
    const tool = createGoalPlanProposeTool(PREVIOUS_PLAN, (plan) => {
      submitted.push(plan);
    });
    const plan = twoTaskPlan(PREVIOUS_PLAN);
    const result = await tool.execute(plan, {
      callId: 'call_1',
      signal: new AbortController().signal,
    });
    expect(tool.name).toBe(GOAL_PLAN_PROPOSE_TOOL_NAME);
    expect(result.isError).not.toBe(true);
    expect(result.content).toEqual([
      { type: 'text', text: 'Proposed Goal Plan passed validation.' },
    ]);
    expect(submitted).toEqual([plan]);
  });

  it('rejects a cyclic Plan without submitting', async () => {
    const submitted: GoalPlanOutput[] = [];
    const tool = createGoalPlanProposeTool(PREVIOUS_PLAN, (plan) => {
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
    expect(result.content).toEqual([
      { type: 'text', text: 'The proposed Goal Plan failed schema or graph checks.' },
    ]);
    expect(submitted).toEqual([]);
  });

  it('rejects an unchanged previous Plan without submitting', async () => {
    const submitted: GoalPlanOutput[] = [];
    const tool = createGoalPlanProposeTool(PREVIOUS_PLAN, (plan) => {
      submitted.push(plan);
    });
    const result = await tool.execute(PREVIOUS_PLAN, {
      callId: 'call_unchanged',
      signal: new AbortController().signal,
    });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      {
        type: 'text',
        text: 'Pre-approval Goal Plan revision cannot repeat the previous draft.',
      },
    ]);
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

    const plan = await runGoalPlanProposal({
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
    expect(firstCall?.systemPrompt).toContain(
      'Propose the initial Plan and every material Plan revision'
    );
    expect(firstCall?.systemPrompt).toContain('approval of its exact version');
    expect(firstCall?.systemPrompt).not.toContain(REVISION);
  });

  it('accepts a questioned proposal as a planning Gate result', async () => {
    const questioned = {
      ...twoTaskPlan(PREVIOUS_PLAN),
      questions: ['Who should own the second task?'],
    };
    const callProvider = vi
      .fn<InternalAgentProviderCall>()
      .mockResolvedValueOnce({
        message: assistantMessage([
          {
            type: 'toolCall',
            callId: 'call_questions',
            name: GOAL_PLAN_PROPOSE_TOOL_NAME,
            arguments: questioned,
          },
        ]),
      })
      .mockImplementationOnce(async (request) => {
        const toolMessage = request.messages.find(
          (message) => message.role === 'tool' && message.callId === 'call_questions'
        );
        expect(toolMessage).toMatchObject({
          role: 'tool',
          callId: 'call_questions',
          content: [
            {
              type: 'text',
              text: 'Proposed Goal Plan passed validation.',
            },
          ],
        });
        return {
          message: assistantMessage([{ type: 'text', text: 'Question submitted.' }]),
        };
      });

    const plan = await runGoalPlanProposal({
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

    expect(plan).toEqual(questioned);
    expect(callProvider).toHaveBeenCalledTimes(2);
  });

  it('fails closed when the model never proposes a Plan', async () => {
    const callProvider = vi.fn<InternalAgentProviderCall>().mockResolvedValue({
      message: assistantMessage([{ type: 'text', text: 'No tool.' }]),
    });

    await expect(
      runGoalPlanProposal({
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
      runGoalPlanProposal({
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
      runGoalPlanProposal({
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
      runGoalPlanProposal({
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
      runGoalPlanProposal({
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
  it.each([
    true,
    false,
  ])('recomputes missing API-key supply for internal-role calls with configured backup %s', async (backupConfigured) => {
    const { snapshot, resolveGatewayProvider } = admittedOrchestratorBindings();
    const baseProfile = snapshot.providerRegistry.list()[0]!;
    snapshot.providerRegistry = new ProviderRegistry([
      { ...baseProfile, id: 'primary', kind: 'direct', secretRef: 'test:missing-key' },
      { ...baseProfile, id: 'backup', kind: 'direct', secretRef: 'test:backup-key' },
    ]);
    snapshot.gatewayConfig.logicalModels[0]!.routes = [
      { id: 'primary', providerProfileId: 'primary', providerModel: 'model' },
      { id: 'backup', providerProfileId: 'backup', providerModel: 'model' },
    ];
    const providerCredentialConfigured = createProviderCredentialConfigured({
      fallback: (ref) =>
        backupConfigured && ref === 'test:backup-key' ? 'synthetic-backup-key' : null,
    });
    const { coreDb, workspaceDb } = openRevisionUsageStorage();
    const proposed = twoTaskPlan(PREVIOUS_PLAN);
    let modelCalls = 0;
    const createResponses = vi.fn(async (provider: ResolvedLLMProviderConfig) => {
      if (!provider.apiKey) {
        throw new PiAiGatewayConfigurationError('Provider requires an explicit API key.');
      }
      modelCalls += 1;
      return {
        id: 'resp_configured_backup',
        object: 'response' as const,
        status: 'completed' as const,
        output:
          modelCalls === 1
            ? [
                {
                  type: 'function_call',
                  call_id: 'call_propose',
                  name: GOAL_PLAN_PROPOSE_TOOL_NAME,
                  arguments: JSON.stringify(proposed),
                },
              ]
            : [
                {
                  type: 'message',
                  role: 'assistant',
                  status: 'completed',
                  content: [{ type: 'output_text', text: 'Proposed.' }],
                },
              ],
        usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
      };
    });
    try {
      const planner = createGoalPlanPlanner({
        runtimeConfig: () => snapshot,
        llmGatewayDispatcher: { createResponses },
        resolveGatewayProvider: (id) => ({
          ...resolveGatewayProvider(),
          id,
          apiKey: backupConfigured && id === 'backup' ? 'synthetic-backup-key' : null,
        }),
        providerCredentialConfigured,
        workspaceId: GOAL.workspaceId,
        userId: REVISION_ACTOR.id,
        authorityActor: REVISION_ACTOR,
        signal: new AbortController().signal,
      });
      const result = planner({
        goal: GOAL,
        capture: { workspaceDb, threadId: GOAL.threadId, turnId: 'tu_revision_capture' },
        previousPlan: PREVIOUS_PLAN,
        previousPlanItemId: 'it_goal_plan_prior',
        revisionText: REVISION,
      });
      if (backupConfigured) {
        expect(await result).toEqual(proposed);
        expect(createResponses).toHaveBeenCalledTimes(2);
        expect(createResponses.mock.calls.every(([provider]) => provider.id === 'backup')).toBe(
          true
        );
      } else {
        await expect(result).rejects.toMatchObject({ code: 'goal_plan_revision_unavailable' });
        expect(createResponses).not.toHaveBeenCalled();
      }
      const calls = listWorkspaceCapabilityCalls(workspaceDb, GOAL.workspaceId);
      expect(calls).toHaveLength(backupConfigured ? 2 : 1);
      for (const call of calls) {
        expect(call.status).toBe(backupConfigured ? 'succeeded' : 'failed');
        expect(call.extensions?.['openkit.gateway/routeLineage']).toMatchObject({
          entries: [
            {
              kind: 'unavailable',
              routeMemberId: 'primary',
              unavailableReason: 'provider_api_key_missing',
              failureKind: 'auth_rejected',
            },
            backupConfigured
              ? { kind: 'attempt', routeMemberId: 'backup', terminalResult: 'succeeded' }
              : {
                  kind: 'unavailable',
                  routeMemberId: 'backup',
                  unavailableReason: 'provider_api_key_missing',
                  failureKind: 'auth_rejected',
                },
          ],
        });
      }
      const usage = listWorkspaceUsageRecords(workspaceDb, GOAL.workspaceId);
      expect(usage).toHaveLength(backupConfigured ? 2 : 0);
      expect(usage.every((record) => record.providerRef === 'backup')).toBe(true);
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
      rmSync(coreDb.dataRoot, { recursive: true, force: true });
    }
  });

  it.each([
    'added',
    'shrink',
  ] as const)('preserves pinned limits across %s snapshot replacement', async (change) => {
    let primaryConfigured = change === 'added';
    const { snapshot, resolveGatewayProvider } = admittedOrchestratorBindings();
    let currentSnapshot = snapshot;
    const baseProfile = snapshot.providerRegistry.list()[0]!;
    snapshot.providerRegistry = new ProviderRegistry([
      { ...baseProfile, id: 'primary', kind: 'direct', secretRef: 'test:missing-key' },
      { ...baseProfile, id: 'backup', kind: 'direct', secretRef: 'test:backup-key' },
    ]);
    snapshot.gatewayConfig.logicalModels[0]!.routes = [
      { id: 'primary', providerProfileId: 'primary', providerModel: 'model' },
      { id: 'backup', providerProfileId: 'backup', providerModel: 'model' },
    ];
    const providerCredentialConfigured = createProviderCredentialConfigured({
      fallback: (ref) =>
        ref === 'test:new-key' ||
        ref === 'test:backup-key' ||
        (primaryConfigured && ref === 'test:missing-key')
          ? 'synthetic-key'
          : null,
    });
    const { coreDb, workspaceDb } = openRevisionUsageStorage();
    const proposed = twoTaskPlan(PREVIOUS_PLAN);
    let modelCalls = 0;
    const createResponses = vi.fn(
      async (
        provider: ResolvedLLMProviderConfig,
        _request: unknown,
        _context: { capture?: { capabilityCallId?: string } }
      ) => {
        if (!provider.apiKey) {
          throw new PiAiGatewayConfigurationError('Provider requires an explicit API key.');
        }
        modelCalls += 1;
        primaryConfigured = true;
        currentSnapshot = {
          ...snapshot,
          gatewayConfig: {
            ...snapshot.gatewayConfig,
            logicalModels: snapshot.gatewayConfig.logicalModels.map((model) => ({
              ...model,
              contextManagement: [{ type: 'compaction' as const, compactThreshold: 8000 }],
              routes:
                change === 'added'
                  ? [
                      { id: 'new', providerProfileId: 'new', providerModel: 'model' },
                      ...model.routes,
                    ]
                  : model.routes,
            })),
          },
          providerRegistry: new ProviderRegistry(
            change === 'added'
              ? [
                  ...snapshot.providerRegistry.list(),
                  {
                    ...baseProfile,
                    id: 'new',
                    kind: 'direct',
                    secretRef: 'test:new-key',
                    modelMetadata: {
                      model: {
                        ...baseProfile.modelMetadata.model,
                        limit: { context: 20000, output: 1000 },
                      },
                    },
                  },
                ]
              : snapshot.providerRegistry.list().map((profile) => ({
                  ...profile,
                  modelMetadata: {
                    model: {
                      ...baseProfile.modelMetadata.model,
                      limit: { context: 20000, output: 1000 },
                    },
                  },
                }))
          ),
        };
        return {
          id: 'resp_configured_backup',
          object: 'response' as const,
          status: 'completed' as const,
          output:
            modelCalls === 1
              ? [
                  {
                    type: 'function_call',
                    call_id: 'call_propose',
                    name: GOAL_PLAN_PROPOSE_TOOL_NAME,
                    arguments: JSON.stringify(proposed),
                  },
                ]
              : [
                  {
                    type: 'message',
                    role: 'assistant',
                    status: 'completed',
                    content: [{ type: 'output_text', text: 'Proposed.' }],
                  },
                ],
          usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
        };
      }
    );
    try {
      const planner = createGoalPlanPlanner({
        runtimeConfig: () => currentSnapshot,
        llmGatewayDispatcher: { createResponses },
        resolveGatewayProvider: (id) => ({
          ...resolveGatewayProvider(),
          modelMetadata: currentSnapshot.providerRegistry.get(id)!.modelMetadata,
          id,
          apiKey:
            id === 'new' || id === 'backup' || (primaryConfigured && id === 'primary')
              ? 'synthetic-key'
              : null,
        }),
        providerCredentialConfigured,
        workspaceId: GOAL.workspaceId,
        userId: REVISION_ACTOR.id,
        authorityActor: REVISION_ACTOR,
        signal: new AbortController().signal,
      });
      const result = planner({
        goal: GOAL,
        capture: { workspaceDb, threadId: GOAL.threadId, turnId: 'tu_revision_capture' },
        previousPlan: PREVIOUS_PLAN,
        previousPlanItemId: 'it_goal_plan_prior',
        revisionText: REVISION,
      });
      if (change === 'added') await expect(result).resolves.toEqual(proposed);
      else await expect(result).rejects.toMatchObject({ code: 'goal_plan_revision_unavailable' });
      expect(createResponses.mock.calls.map(([provider]) => provider.id)).toEqual(
        change === 'added' ? ['primary', 'primary'] : ['backup']
      );
      expect(
        createResponses.mock.calls.every(
          ([provider]) =>
            provider.modelMetadata?.model?.limit?.context === 200000 &&
            provider.modelMetadata?.model?.limit?.output === 8000
        )
      ).toBe(true);
      expect(
        snapshot.gatewayConfig.logicalModels[0]?.contextManagement?.[0]?.compactThreshold
      ).toBe(50000);
      expect(
        currentSnapshot.gatewayConfig.logicalModels[0]?.contextManagement?.[0]?.compactThreshold
      ).toBe(8000);
      const calls = listWorkspaceCapabilityCalls(workspaceDb, GOAL.workspaceId);
      const usage = listWorkspaceUsageRecords(workspaceDb, GOAL.workspaceId);
      expect(calls).toHaveLength(2);
      expect(usage).toHaveLength(change === 'added' ? 2 : 1);
      expect(
        usage.every((record) => record.providerRef === (change === 'added' ? 'primary' : 'backup'))
      ).toBe(true);
      const firstCallId = createResponses.mock.calls[0]?.[2]?.capture?.capabilityCallId;
      const first = calls.find((call) => call.id === firstCallId);
      const second = calls.find((call) => call.id !== firstCallId);
      expect(first).toMatchObject({ status: 'succeeded' });
      expect(first?.extensions?.['openkit.gateway/routeLineage']).toMatchObject({
        entries: [
          ...(change === 'shrink'
            ? [
                {
                  kind: 'unavailable',
                  routeMemberId: 'primary',
                  unavailableReason: 'provider_api_key_missing',
                  failureKind: 'auth_rejected',
                },
              ]
            : []),
          {
            kind: 'attempt',
            routeMemberId: change === 'added' ? 'primary' : 'backup',
            terminalResult: 'succeeded',
          },
        ],
      });
      expect(usage.filter((record) => record.capabilityCallId === firstCallId)).toHaveLength(1);
      expect(second).toMatchObject(
        change === 'added'
          ? { status: 'succeeded' }
          : { status: 'failed', errorCode: 'gateway_logical_model_unavailable' }
      );
      const ineligible = (routeMemberId: string) => ({
        kind: 'unavailable',
        routeMemberId,
        selectionReason: 'pinned_capability_unavailable',
        unavailableReason: 'pinned_capability_unavailable',
        failureKind: 'unsupported',
      });
      expect(second?.extensions?.['openkit.gateway/routeLineage']).toMatchObject({
        entries:
          change === 'added'
            ? [
                ineligible('new'),
                { kind: 'attempt', routeMemberId: 'primary', terminalResult: 'succeeded' },
              ]
            : [ineligible('primary'), ineligible('backup')],
      });
      expect(usage.filter((record) => record.capabilityCallId === second?.id)).toHaveLength(
        change === 'added' ? 1 : 0
      );
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
      rmSync(coreDb.dataRoot, { recursive: true, force: true });
    }
  });

  it('restores primary between internal model calls', async () => {
    let primaryConfigured = false;
    const { snapshot, resolveGatewayProvider } = admittedOrchestratorBindings();
    const baseProfile = snapshot.providerRegistry.list()[0]!;
    snapshot.providerRegistry = new ProviderRegistry([
      { ...baseProfile, id: 'primary', kind: 'direct', secretRef: 'test:missing-key' },
      { ...baseProfile, id: 'backup', kind: 'direct', secretRef: 'test:backup-key' },
    ]);
    snapshot.gatewayConfig.logicalModels[0]!.routes = [
      { id: 'primary', providerProfileId: 'primary', providerModel: 'model' },
      { id: 'backup', providerProfileId: 'backup', providerModel: 'model' },
    ];
    const providerCredentialConfigured = createProviderCredentialConfigured({
      fallback: (ref) =>
        ref === 'test:backup-key' || (primaryConfigured && ref === 'test:missing-key')
          ? 'synthetic-key'
          : null,
    });
    const { coreDb, workspaceDb } = openRevisionUsageStorage();
    const proposed = twoTaskPlan(PREVIOUS_PLAN);
    let modelCalls = 0;
    const createResponses = vi.fn(async (provider: ResolvedLLMProviderConfig) => {
      if (!provider.apiKey) {
        throw new PiAiGatewayConfigurationError('Provider requires an explicit API key.');
      }
      modelCalls += 1;
      primaryConfigured = true;
      return {
        id: 'resp_configured_backup',
        object: 'response' as const,
        status: 'completed' as const,
        output:
          modelCalls === 1
            ? [
                {
                  type: 'function_call',
                  call_id: 'call_propose',
                  name: GOAL_PLAN_PROPOSE_TOOL_NAME,
                  arguments: JSON.stringify(proposed),
                },
              ]
            : [
                {
                  type: 'message',
                  role: 'assistant',
                  status: 'completed',
                  content: [{ type: 'output_text', text: 'Proposed.' }],
                },
              ],
        usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
      };
    });
    try {
      const planner = createGoalPlanPlanner({
        runtimeConfig: () => snapshot,
        llmGatewayDispatcher: { createResponses },
        resolveGatewayProvider: (id) => ({
          ...resolveGatewayProvider(),
          id,
          apiKey:
            id === 'backup' || (primaryConfigured && id === 'primary') ? 'synthetic-key' : null,
        }),
        providerCredentialConfigured,
        workspaceId: GOAL.workspaceId,
        userId: REVISION_ACTOR.id,
        authorityActor: REVISION_ACTOR,
        signal: new AbortController().signal,
      });
      const result = planner({
        goal: GOAL,
        capture: { workspaceDb, threadId: GOAL.threadId, turnId: 'tu_revision_capture' },
        previousPlan: PREVIOUS_PLAN,
        previousPlanItemId: 'it_goal_plan_prior',
        revisionText: REVISION,
      });
      expect(await result).toEqual(proposed);
      expect(createResponses).toHaveBeenCalledTimes(2);
      const providerOrder = ['backup', 'primary'];
      expect(createResponses.mock.calls.map(([provider]) => provider.id)).toEqual(providerOrder);
      expect(createResponses.mock.calls.every(([provider]) => Boolean(provider.apiKey))).toBe(true);
      const calls = listWorkspaceCapabilityCalls(workspaceDb, GOAL.workspaceId);
      const usage = listWorkspaceUsageRecords(workspaceDb, GOAL.workspaceId);
      expect(calls).toHaveLength(2);
      expect(usage).toHaveLength(2);
      for (const providerId of providerOrder) {
        const record = usage.find((entry) => entry.providerRef === providerId);
        expect(record).toBeDefined();
        const call = calls.find((entry) => entry.id === record?.capabilityCallId);
        expect(call?.status).toBe('succeeded');
        expect(call?.extensions?.['openkit.gateway/routeLineage']).toMatchObject({
          entries: [
            ...(providerId === 'backup'
              ? [
                  {
                    kind: 'unavailable',
                    routeMemberId: 'primary',
                    unavailableReason: 'provider_api_key_missing',
                    failureKind: 'auth_rejected',
                  },
                ]
              : []),
            { kind: 'attempt', routeMemberId: providerId, terminalResult: 'succeeded' },
          ],
        });
      }
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
      rmSync(coreDb.dataRoot, { recursive: true, force: true });
    }
  });
  it('loses primary between internal model calls', async () => {
    let primaryConfigured = true;
    const { snapshot, resolveGatewayProvider } = admittedOrchestratorBindings();
    const baseProfile = snapshot.providerRegistry.list()[0]!;
    snapshot.providerRegistry = new ProviderRegistry([
      { ...baseProfile, id: 'primary', kind: 'direct', secretRef: 'test:missing-key' },
      { ...baseProfile, id: 'backup', kind: 'direct', secretRef: 'test:backup-key' },
    ]);
    snapshot.gatewayConfig.logicalModels[0]!.routes = [
      { id: 'primary', providerProfileId: 'primary', providerModel: 'model' },
      { id: 'backup', providerProfileId: 'backup', providerModel: 'model' },
    ];
    const providerCredentialConfigured = createProviderCredentialConfigured({
      fallback: (ref) =>
        ref === 'test:backup-key' || (primaryConfigured && ref === 'test:missing-key')
          ? 'synthetic-key'
          : null,
    });
    const { coreDb, workspaceDb } = openRevisionUsageStorage();
    const proposed = twoTaskPlan(PREVIOUS_PLAN);
    let modelCalls = 0;
    const createResponses = vi.fn(async (provider: ResolvedLLMProviderConfig) => {
      if (!provider.apiKey) {
        throw new PiAiGatewayConfigurationError('Provider requires an explicit API key.');
      }
      modelCalls += 1;
      primaryConfigured = false;
      return {
        id: 'resp_configured_backup',
        object: 'response' as const,
        status: 'completed' as const,
        output:
          modelCalls === 1
            ? [
                {
                  type: 'function_call',
                  call_id: 'call_propose',
                  name: GOAL_PLAN_PROPOSE_TOOL_NAME,
                  arguments: JSON.stringify(proposed),
                },
              ]
            : [
                {
                  type: 'message',
                  role: 'assistant',
                  status: 'completed',
                  content: [{ type: 'output_text', text: 'Proposed.' }],
                },
              ],
        usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
      };
    });
    try {
      const planner = createGoalPlanPlanner({
        runtimeConfig: () => snapshot,
        llmGatewayDispatcher: { createResponses },
        resolveGatewayProvider: (id) => ({
          ...resolveGatewayProvider(),
          id,
          apiKey:
            id === 'backup' || (primaryConfigured && id === 'primary') ? 'synthetic-key' : null,
        }),
        providerCredentialConfigured,
        workspaceId: GOAL.workspaceId,
        userId: REVISION_ACTOR.id,
        authorityActor: REVISION_ACTOR,
        signal: new AbortController().signal,
      });
      const result = planner({
        goal: GOAL,
        capture: { workspaceDb, threadId: GOAL.threadId, turnId: 'tu_revision_capture' },
        previousPlan: PREVIOUS_PLAN,
        previousPlanItemId: 'it_goal_plan_prior',
        revisionText: REVISION,
      });
      expect(await result).toEqual(proposed);
      expect(createResponses).toHaveBeenCalledTimes(2);
      const providerOrder = ['primary', 'backup'];
      expect(createResponses.mock.calls.map(([provider]) => provider.id)).toEqual(providerOrder);
      expect(createResponses.mock.calls.every(([provider]) => Boolean(provider.apiKey))).toBe(true);
      const calls = listWorkspaceCapabilityCalls(workspaceDb, GOAL.workspaceId);
      const usage = listWorkspaceUsageRecords(workspaceDb, GOAL.workspaceId);
      expect(calls).toHaveLength(2);
      expect(usage).toHaveLength(2);
      for (const providerId of providerOrder) {
        const record = usage.find((entry) => entry.providerRef === providerId);
        expect(record).toBeDefined();
        const call = calls.find((entry) => entry.id === record?.capabilityCallId);
        expect(call?.status).toBe('succeeded');
        expect(call?.extensions?.['openkit.gateway/routeLineage']).toMatchObject({
          entries: [
            ...(providerId === 'backup'
              ? [
                  {
                    kind: 'unavailable',
                    routeMemberId: 'primary',
                    unavailableReason: 'provider_api_key_missing',
                    failureKind: 'auth_rejected',
                  },
                ]
              : []),
            { kind: 'attempt', routeMemberId: providerId, terminalResult: 'succeeded' },
          ],
        });
      }
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
      rmSync(coreDb.dataRoot, { recursive: true, force: true });
    }
  });

  it('resolves the Goal Orchestrator model and returns a revised Plan through the Gateway dispatcher', async () => {
    const proposed = twoTaskPlan(PREVIOUS_PLAN);
    const { snapshot, resolveGatewayProvider } = admittedOrchestratorBindings();
    const { coreDb, workspaceDb } = openRevisionUsageStorage();
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
    try {
      const planner = createGoalPlanPlanner({
        runtimeConfig: () => snapshot,
        llmGatewayDispatcher: { createResponses },
        resolveGatewayProvider,
        workspaceId: GOAL.workspaceId,
        userId: REVISION_ACTOR.id,
        authorityActor: REVISION_ACTOR,
        signal: new AbortController().signal,
      });

      const plan = await planner({
        goal: GOAL,
        capture: { workspaceDb, threadId: GOAL.threadId, turnId: 'tu_revision_capture' },
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
        tools?: Array<{ name: string }>;
      };
      expect(firstRequest?.tools?.map((tool) => tool.name)).toEqual([GOAL_PLAN_PROPOSE_TOOL_NAME]);
      expect(firstRequest).not.toHaveProperty('metadata');
      expect(createResponses.mock.calls[0]?.[2]).toMatchObject({
        promptCacheScope: {
          sessionId: `${GOAL_ORCHESTRATOR_ROLE_ID}:${GOAL.goalId}`,
          workspaceId: GOAL.workspaceId,
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
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
      rmSync(coreDb.dataRoot, { recursive: true, force: true });
    }
  });

  it('records Workspace-attributed LLM usage for successful dispatches including a later rejected proposal', async () => {
    const questioned = {
      ...twoTaskPlan(PREVIOUS_PLAN),
      questions: ['Who should own the second task?'],
    };
    const proposed = twoTaskPlan(PREVIOUS_PLAN);
    const { snapshot, resolveGatewayProvider } = admittedOrchestratorBindings();
    const { coreDb, workspaceDb } = openRevisionUsageStorage();
    const createResponses = vi
      .fn()
      .mockResolvedValueOnce({
        id: 'resp_goal_plan_questions',
        object: 'response',
        status: 'completed',
        output: [
          {
            type: 'function_call',
            call_id: 'call_questions',
            name: GOAL_PLAN_PROPOSE_TOOL_NAME,
            arguments: JSON.stringify(questioned),
          },
        ],
        usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 },
      })
      .mockResolvedValueOnce({
        id: 'resp_goal_plan_corrected',
        object: 'response',
        status: 'completed',
        output: [
          {
            type: 'function_call',
            call_id: 'call_corrected',
            name: GOAL_PLAN_PROPOSE_TOOL_NAME,
            arguments: JSON.stringify(proposed),
          },
        ],
        usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 },
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
        usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 },
      });
    try {
      const planner = createGoalPlanPlanner({
        runtimeConfig: () => snapshot,
        llmGatewayDispatcher: { createResponses },
        resolveGatewayProvider,
        workspaceId: GOAL.workspaceId,
        userId: REVISION_ACTOR.id,
        authorityActor: REVISION_ACTOR,
        signal: new AbortController().signal,
      });

      const plan = await planner({
        goal: GOAL,
        capture: { workspaceDb, threadId: GOAL.threadId, turnId: 'tu_revision_capture' },
        previousPlan: PREVIOUS_PLAN,
        previousPlanItemId: 'it_goal_plan_prior',
        revisionText: REVISION,
      });

      expect(plan).toEqual(proposed);
      expect(createResponses).toHaveBeenCalledTimes(3);
      const records = listWorkspaceUsageRecords(workspaceDb, GOAL.workspaceId);
      const calls = listWorkspaceCapabilityCalls(workspaceDb, GOAL.workspaceId);
      expect(records).toHaveLength(3);
      expect(calls).toHaveLength(3);
      expect(new Set(records.map((record) => record.capabilityCallId)).size).toBe(3);
      for (const record of records) {
        expect(record).toMatchObject({
          workspaceId: GOAL.workspaceId,
          threadId: GOAL.threadId,
          turnId: 'tu_revision_capture',
          requestId: null,
          responsibleUserId: REVISION_ACTOR.id,
          category: 'llm',
          unit: 'tokens',
          quantity: 18,
          modelId: 'reasoning',
          providerRef: 'provider',
          source: 'gateway-reported',
          agentId: GOAL_ORCHESTRATOR_ROLE_ID,
        });
      }
      for (const call of calls) {
        expect(call).toMatchObject({
          workspaceId: GOAL.workspaceId,
          threadId: GOAL.threadId,
          turnId: 'tu_revision_capture',
          requestId: null,
          capabilityId: 'inference.local.goal_orchestrator',
          family: 'llm',
          operation: 'goal.plan',
          status: 'succeeded',
          providerRef: null,
        });
      }
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
      rmSync(coreDb.dataRoot, { recursive: true, force: true });
    }
  });

  it('throws a typed unavailable error when Goal Orchestrator has no admitted model', async () => {
    const { coreDb, workspaceDb } = openRevisionUsageStorage();
    try {
      const planner = createGoalPlanPlanner({
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
        workspaceId: GOAL.workspaceId,
        userId: REVISION_ACTOR.id,
        authorityActor: REVISION_ACTOR,
        signal: new AbortController().signal,
      });

      await expect(
        planner({
          goal: GOAL,
          capture: { workspaceDb, threadId: GOAL.threadId, turnId: 'tu_revision_capture' },
          previousPlan: PREVIOUS_PLAN,
          previousPlanItemId: 'it_goal_plan_prior',
          revisionText: REVISION,
        })
      ).rejects.toBeInstanceOf(GoalPlanRevisionError);
      await expect(
        planner({
          goal: GOAL,
          capture: { workspaceDb, threadId: GOAL.threadId, turnId: 'tu_revision_capture' },
          previousPlan: PREVIOUS_PLAN,
          previousPlanItemId: 'it_goal_plan_prior',
          revisionText: REVISION,
        })
      ).rejects.toMatchObject({ code: 'goal_plan_revision_unavailable' });
      expect(listWorkspaceUsageRecords(workspaceDb, GOAL.workspaceId)).toEqual([]);
      expect(listWorkspaceCapabilityCalls(workspaceDb, GOAL.workspaceId)).toEqual([]);
    } finally {
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
      rmSync(coreDb.dataRoot, { recursive: true, force: true });
    }
  });
});
