import type { RuntimeConfigSnapshot } from '../config/runtime-config.js';
import { createInternalAgentGatewayProvider } from '../internal-agents/gateway-provider.js';
import type { FsStore } from '../lib/store.js';
import { resolveLogicalModel } from '../llm/logical-models.js';
import { withTurnModelCapture } from '../llm/model-capture.js';
import type { LLMGatewayProviderDispatcher } from '../llm/provider-dispatcher.js';
import type { ProviderSubscriptionAccountManager } from '../llm/provider-subscription-accounts.js';
import type { ResolvedLLMProviderConfig } from '../providers/llm-config.js';
import type { ProviderCredentialConfigured } from '../providers/registry.js';
import type { CoreDb } from '../storage/db.js';
import { runPolicyAgentGate } from './agent-gate.js';
import { readAdmittedPolicyDocument } from './configuration.js';
import type { AgentPolicyParticipant } from './interception.js';

/** Uses the existing Gateway, capture and capability owners only when an agent gate is invoked. */
export function createAgentPolicyParticipant(deps: {
  readonly coreDb?: CoreDb;
  readonly store: FsStore;
  readonly runtimeConfig: () => RuntimeConfigSnapshot;
  readonly dispatcher: LLMGatewayProviderDispatcher;
  readonly resolveGatewayProvider: (providerId: string, model: string) => ResolvedLLMProviderConfig;
  readonly providerSubscriptionAccountManager?: ProviderSubscriptionAccountManager;
  readonly providerCredentialConfigured?: ProviderCredentialConfigured;
}): AgentPolicyParticipant {
  return {
    invoke: async (input) => {
      if (!deps.coreDb) throw new Error('Agent Policy storage is unavailable.');
      const process = input.proposal.subject.process;
      if (!process) throw new Error('The agent gate has no admitted native process.');
      const turn = deps.store.getTurn(process.workspaceId, process.threadId, process.turnId);
      const snapshot = deps.runtimeConfig();
      const declaration = readAdmittedPolicyDocument(
        deps.coreDb,
        snapshot.openKitConfig.policy?.mediation
      ).statements.find(
        (s) => s.kind === 'agent-principal' && s.agentId === input.binding.participant.id
      );
      if (declaration?.kind !== 'agent-principal')
        throw new Error('Agent declaration is unavailable.');
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
          promptCacheScope: { sessionId: turn.threadId, workspaceId: turn.workspaceId },
          usageEndpoint: 'responses',
          callContext: {
            workspaceId: turn.workspaceId,
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
