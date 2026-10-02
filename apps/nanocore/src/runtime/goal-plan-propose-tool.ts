import type { ActorRef } from '@openkit/protocol';
import { z } from 'zod';

import { findWorkspaceConfig, type RuntimeConfigSnapshot } from '../config/runtime-config.js';
import { assembleBuiltInSystemPrompt } from '../internal-agents/builtin-prompts.js';
import { createInternalAgentGatewayProvider } from '../internal-agents/gateway-provider.js';
import {
  type AgentTool,
  type AgentToolResult,
  type InternalAgentProviderCall,
  runInternalAgentLoop,
} from '../internal-agents/internal-agent-loop.js';
import { resolveInternalRoleProfile } from '../internal-agents/profile-resolver.js';
import { resolveLogicalModel } from '../llm/logical-models.js';
import type { LLMGatewayProviderDispatcher } from '../llm/provider-dispatcher.js';
import type { ProviderSubscriptionAccountManager } from '../llm/provider-subscription-accounts.js';
import type { ResolvedLLMProviderConfig } from '../providers/llm-config.js';
import type { ProviderCredentialConfigured } from '../providers/registry.js';
import {
  assertGoalPlanTaskDispositions,
  assertValidGoalPlanGraph,
  type GoalPlanOutput,
  GoalPlanOutputSchema,
} from './goal-plan.js';
import {
  assertApprovableGoalPlanRevision,
  type GoalPlanner,
  type GoalPlannerInput,
  GoalPlanRevisionError,
} from './goal-planning.js';
import { assertGoalPlanCompletedResultTreatment } from './goal-source-evidence.js';

/** Exact model-visible Tool name for one Goal Plan proposal. */
export const GOAL_PLAN_PROPOSE_TOOL_NAME = 'goal.plan.propose';

/** Goal Orchestrator role identity used by initial and successor planning Turns. */
export const GOAL_ORCHESTRATOR_ROLE_ID = 'goal-orchestrator';

const DEFAULT_PLAN_LIMITS = { maxModelTurns: 8, maxToolCalls: 4, deadlineMs: 120_000 } as const;

const GOAL_PLAN_PROPOSE_INPUT_SCHEMA = stripJsonSchemaMetadata(
  z.toJSONSchema(GoalPlanOutputSchema) as Record<string, unknown>
);

/**
 * Dependencies that bind Goal planning to the existing internal-agent runtime.
 */
export interface GoalPlanPlannerOptions {
  /** Current runtime configuration snapshot. */
  readonly runtimeConfig: () => RuntimeConfigSnapshot;
  /** Existing logical Gateway dispatcher. */
  readonly llmGatewayDispatcher: Pick<LLMGatewayProviderDispatcher, 'createResponses'>;
  /** Resolves one dispatchable provider profile. */
  readonly resolveGatewayProvider: (providerId: string, model: string) => ResolvedLLMProviderConfig;
  /** Optional subscription-backed account manager. */
  readonly providerSubscriptionAccountManager?: ProviderSubscriptionAccountManager;
  /** Current API-key presence without resolving Vault material. */
  readonly providerCredentialConfigured?: ProviderCredentialConfigured;
  /** Workspace that owns the Goal. */
  readonly workspaceId: string;
  /** Authenticated user whose internal-role preference is consulted. */
  readonly userId: string;
  /** Request actor already resolved by the Goal route. */
  readonly authorityActor: ActorRef;
  /** Caller abort signal for the planning request. */
  readonly signal: AbortSignal;
}

/**
 * Creates the single `goal.plan.propose` Tool.
 *
 * @param previousPlan Exact previous Plan used by owner revision guards.
 * @param submit Closure that receives one owner-validated Plan.
 * @returns Model-visible Tool bound to the existing Goal Plan owner checks.
 */
export function createGoalPlanProposeTool(
  previousPlan: GoalPlanOutput | null,
  submit: (plan: GoalPlanOutput) => void,
  sourceTaskEvidence: GoalPlannerInput['sourceTaskEvidence'] = null
): AgentTool {
  return {
    name: GOAL_PLAN_PROPOSE_TOOL_NAME,
    description:
      'Submit one complete Goal Plan proposal for later human approval. Arguments are the exact Goal Plan payload. This Tool cannot approve, dispatch Workers, or terminalize the Goal.',
    inputSchema: GOAL_PLAN_PROPOSE_INPUT_SCHEMA,
    execute: async (value): Promise<AgentToolResult> => {
      try {
        const plan = GoalPlanOutputSchema.parse(value);
        assertValidGoalPlanGraph(plan.tasks);
        if (plan.questions.length === 0) {
          assertGoalPlanTaskDispositions(plan, sourceTaskEvidence?.facts ?? []);
          if (sourceTaskEvidence) assertGoalPlanCompletedResultTreatment(plan, sourceTaskEvidence);
        }
        if (previousPlan && plan.questions.length === 0) {
          assertApprovableGoalPlanRevision(plan, previousPlan);
        }
        submit(plan);
        return {
          content: [
            {
              type: 'text',
              text: 'Proposed Goal Plan passed validation.',
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text:
                error instanceof GoalPlanRevisionError
                  ? error.message
                  : 'The proposed Goal Plan failed schema or graph checks.',
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
export async function runGoalPlanProposal(input: {
  readonly goal: GoalPlannerInput['goal'];
  readonly sourceTaskEvidence?: GoalPlannerInput['sourceTaskEvidence'];
  readonly clarification?: GoalPlannerInput['clarification'];
  readonly previousPlan: GoalPlanOutput | null;
  readonly previousPlanItemId: string | null;
  readonly revisionText: string | null;
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
    createGoalPlanProposeTool(
      input.previousPlan,
      (plan) => {
        proposed = plan;
      },
      input.sourceTaskEvidence
    ),
  ];
  const exit = await runInternalAgentLoop(
    {
      systemPrompt: assembleBuiltInSystemPrompt('goal-orchestrator'),
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
                sourceTaskEvidence: input.sourceTaskEvidence,
                clarification: input.clarification ?? null,
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
        ? 'Goal Plan proposal Tool assembly is invalid.'
        : 'Goal Plan proposal model call failed.'
    );
  }
  if (!proposed) {
    throw new GoalPlanRevisionError(
      'goal_plan_revision_invalid',
      'Goal Orchestrator did not propose a valid Plan.'
    );
  }
  return proposed;
}

/**
 * Creates the GoalPlanner used for initial and successor Plan proposals.
 *
 * @param options Existing profile, Gateway, and request bindings.
 * @returns Planner that runs one propose-only Orchestrator Turn.
 */
export function createGoalPlanPlanner(options: GoalPlanPlannerOptions): GoalPlanner {
  return async (input) => {
    if (
      !input.capture ||
      (input.previousPlanItemId !== undefined) !== (input.previousPlan !== undefined)
    ) {
      throw new GoalPlanRevisionError(
        'goal_plan_revision_invalid',
        'Goal Plan proposal is missing admitted capture or predecessor lineage.'
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
      providerSubscriptionAccountManager: options.providerSubscriptionAccountManager,
      providerCredentialConfigured: options.providerCredentialConfigured,
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
        'Goal Orchestrator has no admitted logical model for Plan proposal.'
      );
    }

    return runGoalPlanProposal({
      goal: input.goal,
      sourceTaskEvidence: input.sourceTaskEvidence ?? null,
      clarification: input.clarification ?? null,
      previousPlan: input.previousPlan ?? null,
      previousPlanItemId: input.previousPlanItemId ?? null,
      revisionText: input.revisionText ?? null,
      model: {
        logicalModelId: selection.logicalModel.id,
        capabilities: selection.logicalModel.capabilities,
        modelFamilyId: selection.logicalModel.modelFamilyId,
      },
      contextManagement: {
        ...selection.logicalModel.contextManagement,
        authority: 'openkit',
      },
      limits: selection.profile?.limits ?? DEFAULT_PLAN_LIMITS,
      callProvider: createInternalAgentGatewayProvider({
        capture: input.capture,
        logicalModel: selection.logicalModel,
        resolveLogicalModel: (logicalModelId) => {
          const snapshot = options.runtimeConfig();
          return resolveLogicalModel(
            snapshot.gatewayConfig,
            snapshot.providerRegistry,
            logicalModelId,
            options.providerSubscriptionAccountManager,
            options.providerCredentialConfigured
          );
        },
        dispatcher: options.llmGatewayDispatcher,
        resolveGatewayProvider: options.resolveGatewayProvider,
        ...(options.providerSubscriptionAccountManager
          ? { providerSubscriptionAccountManager: options.providerSubscriptionAccountManager }
          : {}),
        promptCacheScope: {
          sessionId: `${GOAL_ORCHESTRATOR_ROLE_ID}:${input.goal.goalId}`,
          workspaceId: options.workspaceId,
        },
        usageEndpoint: 'responses',
        callContext: {
          authorityActor: options.authorityActor,
          agentId: GOAL_ORCHESTRATOR_ROLE_ID,
          workspaceId: options.workspaceId,
          family: 'llm',
          operation: 'goal.plan',
          capabilityId: 'inference.local.goal_orchestrator',
          providerRef: null,
          requestId: null,
          serviceRef: 'llm-gateway',
          redactionClass: 'metadata-only',
          summary: 'Goal Orchestrator Plan proposal LLM call.',
        },
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
