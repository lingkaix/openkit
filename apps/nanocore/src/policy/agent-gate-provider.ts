import {
  PolicyAgentGateOutputV1Schema,
  type PolicyBindingV1,
  PolicyResourceV1Schema,
  PolicySubjectV1Schema,
  workspaceIdForOwner,
} from '@openkit/protocol';
import { z } from 'zod';
import type { RuntimeConfigSnapshot } from '../config/runtime-config.js';
import { assembleBuiltInSystemPrompt } from '../internal-agents/builtin-prompts.js';
import { createInternalAgentGatewayProvider } from '../internal-agents/gateway-provider.js';
import {
  type AgentTool,
  type InternalAgentLogicalModel,
  type InternalAgentProviderCall,
  runInternalAgentLoop,
} from '../internal-agents/internal-agent-loop.js';
import type { FsStore } from '../lib/store.js';
import type { GatewayDecisionAction, GatewayDecisionResult } from '../llm/gateway-decision.js';
import { resolveLogicalModel } from '../llm/logical-models.js';
import { withTurnModelCapture } from '../llm/model-capture.js';
import type { LLMGatewayProviderDispatcher } from '../llm/provider-dispatcher.js';
import type { ProviderSubscriptionAccountManager } from '../llm/provider-subscription-accounts.js';
import type { ResolvedLLMProviderConfig } from '../providers/llm-config.js';
import type { ProviderCredentialConfigured } from '../providers/registry.js';
import type { CoreDb } from '../storage/db.js';
import { readAdmittedPolicyDocument } from './configuration.js';
import type { AgentPolicyParticipant } from './interception.js';
import { type PolicyProposal, policyDigest } from './statements.js';

/** Uses the existing Gateway, capture and capability owners only when an agent gate is invoked. */
export function createAgentPolicyParticipant(deps: {
  readonly coreDb?: CoreDb;
  readonly store: FsStore;
  readonly runtimeConfig: () => RuntimeConfigSnapshot;
  readonly dispatcher: LLMGatewayProviderDispatcher;
  readonly resolveGatewayProvider: (
    providerId: string,
    model: string
  ) => ResolvedLLMProviderConfig | Promise<ResolvedLLMProviderConfig>;
  readonly providerSubscriptionAccountManager?: ProviderSubscriptionAccountManager;
  readonly providerCredentialConfigured?: ProviderCredentialConfigured;
  /** Trusted Core decision service, not Provider transport or a route qualification claim. */
  readonly requestSecurityReviewDecision?: (input: {
    readonly binding: PolicyBindingV1;
    readonly proposal: PolicyProposal;
    readonly action: GatewayDecisionAction;
    readonly signal: AbortSignal;
    readonly deadline: number;
  }) => Promise<GatewayDecisionResult>;
}): AgentPolicyParticipant {
  // Assessments only: the outer interception still writes a fresh decision and runs current Kernel facts.
  const cache = new Map<
    string,
    { readonly expiresAt: number; readonly result: GatewayDecisionResult }
  >();
  return {
    invoke: async (input) => {
      if (!deps.coreDb) throw new Error('Agent Policy storage is unavailable.');
      const snapshot = deps.runtimeConfig();
      const document = readAdmittedPolicyDocument(
        deps.coreDb,
        snapshot.openKitConfig.policy?.mediation
      );
      const declaration = document.statements.find(
        (s) => s.kind === 'agent-principal' && s.agentId === input.binding.participant.id
      );
      if (declaration?.kind !== 'agent-principal')
        throw new Error('Agent declaration is unavailable.');
      // E9 requires a qualified decision route, never the Turn's ordinary default model.
      // Until that route is admitted, the existing interception owner escalates to a person.
      if (declaration.agentId === 'security-review') {
        if (!deps.requestSecurityReviewDecision)
          throw new Error('Security Review decision route is unavailable.');
        if (
          input.binding.mode !== 'gate' ||
          input.binding.stage !== 'decide' ||
          !input.action ||
          input.deadline === undefined ||
          !Number.isFinite(input.deadline) ||
          input.deadline <= Date.now()
        )
          throw new Error('Security Review decision facts or original deadline are unavailable.');
        input.signal.throwIfAborted();
        const key = policyDigest([
          policyDigest(input.binding),
          policyDigest(document),
          policyDigest(input.action),
          input.action.influenceSources,
        ]);
        const previous = cache.get(key);
        if (previous && previous.expiresAt > Date.now()) {
          cache.delete(key);
          cache.set(key, previous);
          return structuredClone(previous.result);
        }
        cache.delete(key);
        const result = await deps.requestSecurityReviewDecision({
          binding: input.binding,
          proposal: input.proposal,
          action: input.action,
          signal: input.signal,
          deadline: input.deadline,
        });
        if (
          !input.signal.aborted &&
          Date.now() < input.deadline &&
          (result.decision === 'allow' || result.decision === 'block')
        ) {
          cache.delete(key);
          if (cache.size >= 10_000) {
            const oldest = cache.keys().next().value;
            if (oldest !== undefined) cache.delete(oldest);
          }
          cache.set(key, {
            expiresAt: Date.now() + 24 * 60 * 60 * 1000,
            result: structuredClone(result),
          });
        }
        return result;
      }
      const process = input.proposal.subject.process;
      if (!process) throw new Error('The agent gate has no admitted native process.');
      const turn = deps.store.getTurn(process.workspaceId, process.threadId, process.turnId);
      const workspaceId = workspaceIdForOwner(turn.owner);
      const logicalModel = resolveLogicalModel(
        snapshot.gatewayConfig,
        snapshot.providerRegistry,
        undefined,
        deps.providerSubscriptionAccountManager,
        deps.providerCredentialConfigured
      );
      if (!logicalModel) throw new Error('Agent gate logical model is unavailable.');
      return withTurnModelCapture({ store: deps.store, turn }, (capture) => {
        const callProvider = createInternalAgentGatewayProvider({
          capture,
          logicalModel,
          resolveLogicalModel: (id) => {
            const current = deps.runtimeConfig();
            return resolveLogicalModel(
              current.gatewayConfig,
              current.providerRegistry,
              id,
              deps.providerSubscriptionAccountManager,
              deps.providerCredentialConfigured
            );
          },
          dispatcher: deps.dispatcher,
          resolveGatewayProvider: deps.resolveGatewayProvider,
          ...(deps.providerSubscriptionAccountManager
            ? { providerSubscriptionAccountManager: deps.providerSubscriptionAccountManager }
            : {}),
          promptCacheScope: { sessionId: turn.threadId, workspaceId: workspaceId },
          usageEndpoint: 'responses',
          callContext: {
            workspaceId: workspaceId,
            authorityActor: {
              kind: 'agent',
              id: declaration.agentId,
              responsibleUserId: declaration.responsibleHumanId,
            },
            agentId: declaration.agentId,
            family: 'llm',
            operation: 'policy.agent-gate',
            capabilityId: 'inference.local.policy-agent-gate',
            redactionClass: 'content',
          },
        });
        return runPolicyAgentGate(
          {
            ...input,
            model: {
              logicalModelId: logicalModel.id,
              capabilities: logicalModel.capabilities,
              modelFamilyId: logicalModel.modelFamilyId,
            },
          },
          callProvider
        );
      });
    },
  };
}

/** Runs the existing bounded loop with only a typed result closure and no effect or investigative Tools. */
async function runPolicyAgentGate(
  input: {
    readonly binding: PolicyBindingV1;
    readonly proposal: PolicyProposal;
    readonly signal: AbortSignal;
    readonly model: InternalAgentLogicalModel;
  },
  callProvider: InternalAgentProviderCall
): Promise<z.infer<typeof PolicyAgentGateOutputV1Schema>> {
  if (
    input.binding.participant.kind !== 'agent' ||
    input.binding.mode !== 'gate' ||
    input.binding.stage !== 'decide'
  )
    throw new Error('Only an agent deciding gate can invoke this bounded loop.');
  let result: z.infer<typeof PolicyAgentGateOutputV1Schema> | undefined;
  const tool: AgentTool = {
    name: 'policy.gate-result',
    description:
      'Submit the bounded assessment. This grants no authority and cannot satisfy a human-only approval.',
    inputSchema: z.toJSONSchema(PolicyAgentGateOutputV1Schema),
    execute: async (value) => {
      input.signal.throwIfAborted();
      if (result) throw new Error('An agent assessment is already submitted.');
      result = PolicyAgentGateOutputV1Schema.parse(value);
      return { content: [{ type: 'text', text: 'Assessment received.' }] };
    },
  };
  // TypeScript structural assignment can carry extra properties. Select the closed
  // summary explicitly so a native caller cannot accidentally disclose argument bodies.
  const proposal = {
    operation: input.proposal.operation,
    workspaceId: input.proposal.workspaceId,
    resource: PolicyResourceV1Schema.parse(input.proposal.resource),
    inputReferences: z
      .record(z.string(), z.string().nullable())
      .parse(input.proposal.inputReferences),
    inputAttributes: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
      .parse(input.proposal.inputAttributes),
    capabilityCallId: input.proposal.capabilityCallId,
    subject: PolicySubjectV1Schema.parse(input.proposal.subject),
  };
  const exit = await runInternalAgentLoop(
    {
      systemPrompt: assembleBuiltInSystemPrompt('policy-agent-gate'),
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: JSON.stringify({ proposal }) }],
        },
      ],
      tools: [tool],
      model: input.model,
      limits: { maxModelTurns: 2, maxToolCalls: 1, deadlineMs: input.binding.timeoutMs },
      signal: input.signal,
    },
    (request) =>
      result
        ? Promise.resolve({ message: { role: 'assistant', content: [], truncated: false } })
        : callProvider(request)
  );
  input.signal.throwIfAborted();
  if (!result || exit.kind !== 'quiescent')
    throw new Error('The agent gate has no completed valid assessment.');
  return result;
}
