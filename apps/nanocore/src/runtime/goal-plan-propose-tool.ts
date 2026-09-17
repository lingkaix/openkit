import { z } from 'zod';

import { findWorkspaceConfig, type RuntimeConfigSnapshot } from '../config/runtime-config.js';
import { createInternalAgentGatewayProvider } from '../internal-agents/gateway-provider.js';
import {
  type AgentTool,
  type AgentToolResult,
  type InternalAgentProviderCall,
  runInternalAgentLoop,
} from '../internal-agents/internal-agent-loop.js';
import { resolveInternalRoleProfile } from '../internal-agents/profile-resolver.js';
import type { LLMGatewayProviderDispatcher } from '../llm/provider-dispatcher.js';
import type { ProviderSubscriptionAccountManager } from '../llm/provider-subscription-accounts.js';
import type { ResolvedLLMProviderConfig } from '../providers/llm-config.js';
import {
  assertValidGoalPlanGraph,
  type GoalPlanOutput,
  GoalPlanOutputSchema,
} from './goal-plan.js';
import { type GoalPlanner, type GoalPlannerInput, GoalPlanRevisionError } from './goal-planning.js';

/** Exact model-visible Tool name for one pre-approval Goal Plan proposal. */
export const GOAL_PLAN_PROPOSE_TOOL_NAME = 'goal.plan.propose';

/** Goal Orchestrator role identity reused for pre-approval revision Turns. */
export const GOAL_ORCHESTRATOR_ROLE_ID = 'goal-orchestrator';

const DEFAULT_REVISION_LIMITS = { maxModelTurns: 8, maxToolCalls: 4, deadlineMs: 120_000 } as const;

const GOAL_PLAN_PROPOSE_INPUT_SCHEMA = stripJsonSchemaMetadata(
  z.toJSONSchema(GoalPlanOutputSchema) as Record<string, unknown>
);

const REVISION_SYSTEM_PROMPT = [
  'You are the OpenKit Goal Orchestrator drafting one revised Goal Plan before human approval.',
  'Use only goal.plan.propose. Submit one complete Plan that consumes the recorded human revision and the exact previous Plan.',
  'You cannot approve a Plan, dispatch Workers, access repository tools, MCP or Vault, widen Goal authority, or terminalize the Goal.',
].join(' ');

/**
 * Dependencies that bind one pre-approval revision planner to the existing internal-agent runtime.
 */
export interface PreApprovalGoalPlanRevisionPlannerOptions {
  /** Current runtime configuration snapshot. */
  readonly runtimeConfig: () => RuntimeConfigSnapshot;
  /** Existing logical Gateway dispatcher. */
  readonly llmGatewayDispatcher: Pick<LLMGatewayProviderDispatcher, 'createResponses'>;
  /** Resolves one dispatchable provider profile. */
  readonly resolveGatewayProvider: (providerId: string, model: string) => ResolvedLLMProviderConfig;
  /** Optional subscription-backed account manager. */
  readonly providerSubscriptionAccountManager?: ProviderSubscriptionAccountManager;
  /** Workspace that owns the Goal. */
  readonly workspaceId: string;
  /** Authenticated user whose internal-role preference is consulted. */
  readonly userId: string;
  /** Caller abort signal for the planning request. */
  readonly signal: AbortSignal;
}

/**
 * Creates the single pre-approval `goal.plan.propose` Tool.
 *
 * @param submit Closure that receives one schema- and graph-validated Plan.
 * @returns Model-visible Tool bound to the existing Goal Plan owner checks.
 */
export function createGoalPlanProposeTool(submit: (plan: GoalPlanOutput) => void): AgentTool {
  return {
    name: GOAL_PLAN_PROPOSE_TOOL_NAME,
    description:
      'Submit one complete revised Goal Plan for later human approval. Arguments are the exact Goal Plan payload. This Tool cannot approve, dispatch Workers, or terminalize the Goal.',
    inputSchema: GOAL_PLAN_PROPOSE_INPUT_SCHEMA,
    execute: async (value): Promise<AgentToolResult> => {
      try {
        const plan = GoalPlanOutputSchema.parse(value);
        assertValidGoalPlanGraph(plan.tasks);
        submit(plan);
        return {
          content: [
            {
              type: 'text',
              text: 'Proposed Goal Plan was accepted for human review.',
            },
          ],
        };
      } catch {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: 'The proposed Goal Plan failed schema or graph checks.',
            },
          ],
        };
      }
    },
  };
}

/**
 * Runs one Goal-scoped Orchestrator Turn whose only Tool is `goal.plan.propose`.
 *
 * @param input Authoritative Goal, exact previous Plan, revision instruction, and loop bindings.
 * @returns Schema-validated proposed Plan.
 * @throws GoalPlanRevisionError when the model does not submit a valid Plan.
 */
export async function runPreApprovalGoalPlanRevision(input: {
  readonly goal: GoalPlannerInput['goal'];
  readonly previousPlan: GoalPlanOutput;
  readonly previousPlanItemId: string;
  readonly revisionText: string;
  readonly model: {
    readonly logicalModelId: string;
    readonly capabilities: readonly string[];
    readonly modelFamilyId: string | null;
  };
  readonly contextManagement: {
    readonly type: 'compaction';
    readonly compactThreshold: number;
    readonly authority: 'openkit';
  };
  readonly limits: {
    readonly maxModelTurns: number;
    readonly maxToolCalls: number;
    readonly deadlineMs: number;
  };
  readonly callProvider: InternalAgentProviderCall;
  readonly signal: AbortSignal;
}): Promise<GoalPlanOutput> {
  let proposed: GoalPlanOutput | null = null;
  const tools = [
    createGoalPlanProposeTool((plan) => {
      proposed = plan;
    }),
  ];
  const exit = await runInternalAgentLoop(
    {
      systemPrompt: REVISION_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                goal: {
                  goalId: input.goal.goalId,
                  title: input.goal.title,
                  objective: input.goal.objective,
                },
                previousPlanItemId: input.previousPlanItemId,
                previousPlan: input.previousPlan,
                revision: input.revisionText,
              }),
            },
          ],
        },
      ],
      tools,
      model: input.model,
      contextManagement: input.contextManagement,
      limits: input.limits,
      signal: input.signal,
    },
    input.callProvider
  );

  if (input.signal.aborted || exit.kind !== 'quiescent') {
    throw new GoalPlanRevisionError(
      exit.kind === 'failed' && exit.code === 'internal_agent_input_invalid'
        ? 'goal_plan_revision_invalid'
        : 'goal_plan_revision_unavailable',
      exit.kind === 'failed' && exit.code === 'internal_agent_input_invalid'
        ? 'Pre-approval Goal Plan revision Tool assembly is invalid.'
        : 'Pre-approval Goal Plan revision model call failed.'
    );
  }
  if (!proposed) {
    throw new GoalPlanRevisionError(
      'goal_plan_revision_invalid',
      'Pre-approval Goal Plan revision did not propose a valid Plan.'
    );
  }
  return proposed;
}

/**
 * Creates the GoalPlanner used after a recorded pre-approval revision.
 *
 * @param options Existing profile, Gateway, and request bindings.
 * @returns Planner that runs one propose-only Orchestrator Turn.
 */
export function createPreApprovalGoalPlanRevisionPlanner(
  options: PreApprovalGoalPlanRevisionPlannerOptions
): GoalPlanner {
  return async (input) => {
    if (!input.previousPlan || !input.previousPlanItemId || input.revisionText === undefined) {
      throw new GoalPlanRevisionError(
        'goal_plan_revision_invalid',
        'Pre-approval Goal Plan revision is missing its prior Plan or instruction.'
      );
    }

    const snapshot = options.runtimeConfig();
    const workspaceConfig = findWorkspaceConfig(snapshot, options.workspaceId)?.config;
    const userConfig = snapshot.userConfigs.find(
      (entry) => entry.userId === options.userId
    )?.config;
    const selection = resolveInternalRoleProfile({
      roleId: GOAL_ORCHESTRATOR_ROLE_ID,
      workspaceId: options.workspaceId,
      gatewayConfig: snapshot.gatewayConfig,
      profilesConfig: snapshot.internalRoleProfiles,
      providerRegistry: snapshot.providerRegistry,
      ...(workspaceConfig ? { workspaceConfig } : {}),
      ...(userConfig ? { userConfig } : {}),
    });
    if (
      !selection ||
      !selection.logicalModel.capabilities.includes('responses') ||
      !selection.logicalModel.capabilities.includes('tool-calling') ||
      !selection.logicalModel.contextManagement
    ) {
      throw new GoalPlanRevisionError(
        'goal_plan_revision_unavailable',
        'Goal Orchestrator has no admitted logical model for pre-approval Plan revision.'
      );
    }

    return runPreApprovalGoalPlanRevision({
      goal: input.goal,
      previousPlan: input.previousPlan,
      previousPlanItemId: input.previousPlanItemId,
      revisionText: input.revisionText,
      model: {
        logicalModelId: selection.logicalModel.id,
        capabilities: selection.logicalModel.capabilities,
        modelFamilyId: selection.logicalModel.modelFamilyId,
      },
      contextManagement: {
        ...selection.logicalModel.contextManagement,
        authority: 'openkit',
      },
      limits: selection.profile?.limits ?? DEFAULT_REVISION_LIMITS,
      callProvider: createInternalAgentGatewayProvider({
        logicalModel: selection.logicalModel,
        dispatcher: options.llmGatewayDispatcher,
        resolveGatewayProvider: options.resolveGatewayProvider,
        ...(options.providerSubscriptionAccountManager
          ? { providerSubscriptionAccountManager: options.providerSubscriptionAccountManager }
          : {}),
        metadata: {
          openkit: {
            sessionId: `${GOAL_ORCHESTRATOR_ROLE_ID}:${input.goal.goalId}`,
            workspaceId: options.workspaceId,
          },
        },
        promptCacheScope: {
          sessionId: `${GOAL_ORCHESTRATOR_ROLE_ID}:${input.goal.goalId}`,
          workspaceId: options.workspaceId,
        },
        usageEndpoint: 'responses',
      }),
      signal: options.signal,
    });
  };
}

/**
 * Removes JSON Schema metadata that the internal-agent Ajv compiler does not admit.
 *
 * @param schema Zod-emitted JSON Schema object.
 * @returns Schema object without `$schema` metadata.
 */
function stripJsonSchemaMetadata(schema: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _schema, ...rest } = schema;
  return rest;
}
