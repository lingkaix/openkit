import type { ActorRef, Item, Turn } from '@openkit/protocol';
import { allocateEntityId, isSealedTurnTerminal, responsibleUserIdForActor } from '@openkit/protocol';
import { findWorkspaceConfig, type RuntimeConfigSnapshot } from '../config/runtime-config.js';
import type { FsStore } from '../lib/store.js';
import { resolveLogicalModel } from '../llm/logical-models.js';
import { withTurnModelCapture } from '../llm/model-capture.js';
import type { LLMGatewayProviderDispatcher } from '../llm/provider-dispatcher.js';
import type { ProviderSubscriptionAccountManager } from '../llm/provider-subscription-accounts.js';
import type { ResolvedLLMProviderConfig } from '../providers/llm-config.js';
import type { ProviderCredentialConfigured } from '../providers/registry.js';
import type { WorkspaceDb } from '../storage/db.js';
import { assembleBuiltInSystemPrompt } from './builtin-prompts.js';
import { createCompactingInternalAgentProvider } from './compacting-context.js';
import { createInternalAgentGatewayProvider } from './gateway-provider.js';
import { type AgentMessage, type AgentTool, runInternalAgentLoop } from './internal-agent-loop.js';
import { resolveInternalRoleProfile } from './profile-resolver.js';
import { internalContextFailure } from './rolling-context.js';

/** Existing Gateway dependencies; the role adds no transport, execution store or scheduler. */
export interface KnowledgeManagerAgentDependencies {
  readonly store: FsStore;
  readonly runtimeConfig: () => RuntimeConfigSnapshot;
  readonly dispatcher: Pick<LLMGatewayProviderDispatcher, 'createResponses'>;
  readonly resolveGatewayProvider: (providerId: string, model: string) => ResolvedLLMProviderConfig;
  readonly providerSubscriptionAccountManager?: ProviderSubscriptionAccountManager;
  readonly providerCredentialConfigured?: ProviderCredentialConfigured;
}

/** Trusted admission supplies the scope, fixed base, current audience and finite Tool closures. */
export interface KnowledgeManagerAgentRun {
  readonly turn: Turn;
  readonly workspaceDb: WorkspaceDb;
  readonly inputs: NonNullable<Turn['internalExecution']>['knowledge'];
  readonly messages: readonly AgentMessage[];
  readonly tools: readonly AgentTool[];
  readonly signal: AbortSignal;
  readonly assertCurrent: () => void;
  readonly readEvidence: (items: readonly Item[]) => string;
  /** Role output admission occurs before the Turn can claim successful completion. */
  readonly validateResult: (text: string) => void;
}

/** Pins finite role admission before a daily trigger returns; this performs no Provider effect. */
export function pinKnowledgeManagerExecution(
  dependencies: KnowledgeManagerAgentDependencies,
  input: Pick<KnowledgeManagerAgentRun, 'turn' | 'inputs'>
) {
  const turn = dependencies.store.getTurnById(input.turn.id);
  const userId = responsibleUserIdForActor(turn.triggerActor);
  if (!userId || !input.inputs || turn.agentId !== 'knowledge-manager' || turn.status !== 'running')
    throw new Error('Knowledge Manager input is unavailable.');
  const snapshot = dependencies.runtimeConfig();
  const userConfig = snapshot.userConfigs.find((entry) => entry.userId === userId)?.config;
  const workspaceConfig = findWorkspaceConfig(snapshot, turn.workspaceId)?.config;
  const pinned = turn.internalExecution;
  const selection = resolveInternalRoleProfile({
    roleId: 'knowledge-manager', workspaceId: turn.workspaceId,
    gatewayConfig: snapshot.gatewayConfig, profilesConfig: snapshot.internalRoleProfiles,
    providerRegistry: snapshot.providerRegistry,
    providerSubscriptionAccountManager: dependencies.providerSubscriptionAccountManager,
    providerCredentialConfigured: dependencies.providerCredentialConfigured,
    ...(pinned ? { requestedLogicalModelId: pinned.logicalModelId } : {}),
    ...(userConfig ? { userConfig } : {}), ...(workspaceConfig ? { workspaceConfig } : {}),
  });
  if (!selection || !selection.logicalModel.capabilities.includes('responses') ||
      !selection.logicalModel.capabilities.includes('tool-calling'))
    throw new Error('Knowledge Manager logical model is unavailable.');
  const threshold = pinned?.threshold ?? selection.logicalModel.contextManagement.compactThreshold;
  if (pinned && (pinned.contextStrategy !== 'compaction' || JSON.stringify(pinned.knowledge) !== JSON.stringify(input.inputs)))
    throw new Error('Knowledge Manager admitted inputs changed.');
  dependencies.store.updateTurn(turn.id, { internalExecution: {
    roleId: 'knowledge-manager', logicalModelId: selection.logicalModel.id,
    contextStrategy: 'compaction', threshold, knowledge: input.inputs,
  } });
  return { selection, threshold, limits: selection.profile?.limits ?? {
    maxModelTurns: 8, maxToolCalls: 24, deadlineMs: 120_000,
  } };
}

/**
 * Executes one fresh, bounded Knowledge Manager Turn with its own model usage and canonical transcript.
 *
 * The caller owns query isolation, notebook admission and output validation. A settled or interrupted Turn is never replayed. Maintenance Tools publish only their admitted fixed-base candidate; model text cannot authorize publication.
 */
export async function runKnowledgeManagerAgent(
  dependencies: KnowledgeManagerAgentDependencies,
  input: KnowledgeManagerAgentRun
): Promise<{ readonly turnId: string; readonly text: string }> {
  const { store } = dependencies;
  const turn = store.getTurnById(input.turn.id);
  if (turn.agentId !== 'knowledge-manager' || turn.agentSessionId || turn.status !== 'running')
    throw new Error('Knowledge Manager Turn is not admitted.');
  try {
    input.signal.throwIfAborted();
    input.assertCurrent();
    const { selection, threshold, limits } = pinKnowledgeManagerExecution(dependencies, input);
    const logicalModel = selection.logicalModel;
    const systemPrompt = assembleBuiltInSystemPrompt('knowledge-manager');
    const commitMessages = createKnowledgeManagerTranscript(store, turn, turn.triggerActor);
    const result = await withTurnModelCapture({
      store, turn, workspaceDb: input.workspaceDb,
      environment: { systemPrompt, tools: input.tools },
    }, async (capture) => {
      const ordinary = createInternalAgentGatewayProvider({
        capture, logicalModel,
        resolveLogicalModel: (id) => {
          const current = dependencies.runtimeConfig();
          return resolveLogicalModel(current.gatewayConfig, current.providerRegistry, id,
            dependencies.providerSubscriptionAccountManager, dependencies.providerCredentialConfigured);
        },
        dispatcher: dependencies.dispatcher,
        resolveGatewayProvider: dependencies.resolveGatewayProvider,
        ...(dependencies.providerSubscriptionAccountManager
          ? { providerSubscriptionAccountManager: dependencies.providerSubscriptionAccountManager } : {}),
        promptCacheScope: { sessionId: turn.threadId, workspaceId: turn.workspaceId },
        usageEndpoint: 'responses',
        callContext: {
          authorityActor: turn.triggerActor, agentId: 'knowledge-manager', workspaceId: turn.workspaceId,
          family: 'llm', operation: 'knowledge.run', capabilityId: 'inference.local.knowledge-manager',
          providerRef: null, requestId: null, serviceRef: 'llm-gateway',
          redactionClass: 'metadata-only', summary: 'Knowledge Manager bounded Turn.',
        },
      });
      const provider = createCompactingInternalAgentProvider({
        store, turn, compactThreshold: threshold, limits,
        assertCurrent: input.assertCurrent, readEvidence: input.readEvidence,
        commitMessages, callProvider: ordinary,
      });
      const exit = await runInternalAgentLoop({
        systemPrompt, messages: input.messages, tools: input.tools,
        model: { logicalModelId: logicalModel.id, capabilities: logicalModel.capabilities,
          modelFamilyId: logicalModel.modelFamilyId },
        limits, signal: input.signal,
      }, provider);
      commitMessages(exit.messages);
      input.assertCurrent();
      if (exit.kind !== 'quiescent')
        throw new Error(`Knowledge Manager run ended: ${exit.kind}${'code' in exit ? ` (${exit.code})` : ''}.`);
      const last = exit.messages.at(-1);
      const text = last?.role === 'assistant'
        ? last.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('') : '';
      if (!text.trim()) throw new Error('Knowledge Manager returned no answer.');
      input.validateResult(text);
      return text;
    });
    store.updateTurn(turn.id, { status: 'completed', completedAt: new Date().toISOString() });
    return { turnId: turn.id, text: result };
  } catch (error) {
    if (!isSealedTurnTerminal(store.getTurnById(turn.id).status))
      store.updateTurn(turn.id, {
        status: input.signal.aborted ? 'cancelled' : 'failed', completedAt: new Date().toISOString(),
        error: internalContextFailure(error) ?? {
          code: 'knowledge_manager_failed', message: 'Knowledge Manager run failed. Inspect the retained Turn before a new request.',
        },
      });
    throw error;
  }
}

/**
 * Commits accepted loop messages once through ordinary Items, including each completed Tool pair.
 *
 * Model call IDs correlate retained calls but select no effect. The full ordered source inventory is returned for compaction; summaries are never copied into that inventory.
 */
export function createKnowledgeManagerTranscript(
  store: FsStore, turn: Turn, actor: ActorRef
): (messages: readonly AgentMessage[]) => readonly Item[] {
  const committed = new Map<string, Item>();
  return (messages) => {
    const items: Item[] = [];
    for (const [index, message] of messages.entries()) {
      if (message.role === 'tool') continue;
      const text = message.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('');
      if (text) {
        const key = `message:${index}`;
        if (!committed.has(key)) {
          const timestamp = new Date().toISOString();
          const base = { id: allocateEntityId('it'), workspaceId: turn.workspaceId,
            threadId: turn.threadId, turnId: turn.id, status: 'completed' as const,
            createdAt: timestamp, completedAt: timestamp, text };
          committed.set(key, store.createItem(message.role === 'user'
            ? { ...base, type: 'user-message', actor } : { ...base, type: 'assistant-message' }));
        }
        items.push(committed.get(key)!);
      }
      if (message.role !== 'assistant') continue;
      for (const part of message.content) {
        if (part.type !== 'toolCall') continue;
        const result = messages.find((candidate) => candidate.role === 'tool' && candidate.callId === part.callId);
        // A cancelled run can end with an unsettled call. It has no accepted result to summarize.
        if (!result || result.role !== 'tool') continue;
        const key = `call:${part.callId}`;
        if (!committed.has(key)) {
          const timestamp = new Date().toISOString();
          committed.set(key, store.createItem({
            id: allocateEntityId('it'), workspaceId: turn.workspaceId, threadId: turn.threadId,
            turnId: turn.id, type: 'tool-call', causationId: part.callId,
            status: result.isError ? 'failed' : 'completed', tool: part.name, server: null,
            arguments: typeof part.arguments === 'object' && part.arguments !== null && !Array.isArray(part.arguments)
              ? part.arguments as Record<string, unknown> : null,
            result: JSON.stringify(result.content), error: result.isError ? 'Tool failed.' : null,
            durationMs: null, createdAt: timestamp, completedAt: timestamp,
          }));
        }
        items.push(committed.get(key)!);
      }
    }
    return items;
  };
}
