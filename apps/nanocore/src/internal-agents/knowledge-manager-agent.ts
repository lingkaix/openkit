import type { ActorRef, Item } from '@openkit/protocol';
import {
  allocateEntityId,
  isSealedTurnTerminal,
  responsibleUserIdForActor,
} from '@openkit/protocol';
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
import {
  type AgentMessage,
  type AgentTool,
  type InternalAgentProviderCall,
  type JsonSchema,
  runInternalAgentLoop,
} from './internal-agent-loop.js';
import { resolveInternalRoleProfile } from './profile-resolver.js';
import { internalContextFailure } from './rolling-context.js';

type Turn = ReturnType<FsStore['getTurnById']>;

// Live handles exist only during this process; retained Turns never restart a model after reboot.
const activeKnowledgeRuns = new WeakMap<
  FsStore,
  Map<string, { controller: AbortController; finished: Promise<void> }>
>();

/** Stops an active KM Turn and waits for its ordinary terminal record before accepting Stop. */
export async function interruptKnowledgeManagerTurn(
  store: FsStore,
  turnId: string
): Promise<boolean> {
  const run = activeKnowledgeRuns.get(store)?.get(turnId);
  if (!run) return false;
  run.controller.abort();
  await run.finished;
  return true;
}

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
  /** The existing loop validates this result Tool schema before role output admission. */
  readonly resultSchema: JsonSchema;
  /** Returns safe repair guidance for a missing prerequisite; throws for other admission failures. */
  readonly validateResult: (text: string) => undefined | string;
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
    roleId: 'knowledge-manager',
    workspaceId: turn.workspaceId,
    gatewayConfig: snapshot.gatewayConfig,
    profilesConfig: snapshot.internalRoleProfiles,
    providerRegistry: snapshot.providerRegistry,
    providerSubscriptionAccountManager: dependencies.providerSubscriptionAccountManager,
    providerCredentialConfigured: dependencies.providerCredentialConfigured,
    ...(pinned ? { requestedLogicalModelId: pinned.logicalModelId } : {}),
    ...(userConfig ? { userConfig } : {}),
    ...(workspaceConfig ? { workspaceConfig } : {}),
  });
  if (
    !selection ||
    !selection.logicalModel.capabilities.includes('responses') ||
    !selection.logicalModel.capabilities.includes('tool-calling')
  )
    throw new Error('Knowledge Manager logical model is unavailable.');
  const threshold = pinned?.threshold ?? selection.logicalModel.contextManagement.compactThreshold;
  if (
    pinned &&
    (pinned.contextStrategy !== 'compaction' ||
      JSON.stringify(pinned.knowledge) !== JSON.stringify(input.inputs))
  )
    throw new Error('Knowledge Manager admitted inputs changed.');
  dependencies.store.updateTurn(turn.id, {
    internalExecution: {
      roleId: 'knowledge-manager',
      logicalModelId: selection.logicalModel.id,
      contextStrategy: 'compaction',
      threshold,
      knowledge: input.inputs,
    },
  });
  return {
    selection,
    threshold,
    limits: selection.profile?.limits ?? {
      maxModelTurns: 8,
      maxToolCalls: 24,
      deadlineMs: 120_000,
    },
  };
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
  const controller = new AbortController();
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let runs = activeKnowledgeRuns.get(store);
  if (!runs) {
    runs = new Map();
    activeKnowledgeRuns.set(store, runs);
  }
  if (runs.has(input.turn.id)) throw new Error('Knowledge Manager Turn is already running.');
  runs.set(input.turn.id, { controller, finished });
  try {
    return await executeKnowledgeManagerAgent(dependencies, {
      ...input,
      signal: AbortSignal.any([input.signal, controller.signal]),
    });
  } finally {
    runs.delete(input.turn.id);
    finish();
  }
}

/** Executes within the caller's live cancellation handle, retaining the normal Turn lifecycle. */
async function executeKnowledgeManagerAgent(
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
    const signal = AbortSignal.any([input.signal, AbortSignal.timeout(limits.deadlineMs)]);
    let resultText: string | undefined;
    let usedToolCalls = 0;
    let repairUsed = false;
    let notebookSubmissionAttempted = false;
    const tools: AgentTool[] = [
      ...input.tools.map(
        (tool): AgentTool => ({
          ...tool,
          execute: async (value: unknown, context: Parameters<AgentTool['execute']>[1]) => {
            if (resultText !== undefined) throw new Error('Knowledge result is already submitted.');
            usedToolCalls += 1;
            // Repair can read evidence or supply a missing submission, but cannot repeat an edit effect.
            if (
              repairUsed &&
              (tool.name === 'knowledge.notebook-workspace.update' ||
                (tool.name === 'knowledge.notebook.update' && notebookSubmissionAttempted))
            )
              return {
                isError: true,
                content: [
                  {
                    type: 'text',
                    text: 'Repair cannot repeat notebook effects. Start a new request.',
                  },
                ],
              };
            if (tool.name === 'knowledge.notebook.update') notebookSubmissionAttempted = true;
            return tool.execute(value, context);
          },
        })
      ),
      {
        name: 'knowledge.result',
        description:
          'Finish this run by submitting the structured result. Use this Tool instead of a text answer. For maintenance, first submit the notebook candidate or no-change outcome through knowledge.notebook.update. A result grants no publication authority.',
        inputSchema: input.resultSchema,
        execute: async (value) => {
          signal.throwIfAborted();
          input.assertCurrent();
          if (resultText !== undefined) throw new Error('Knowledge result is already submitted.');
          usedToolCalls += 1;
          const text = JSON.stringify(value);
          const guidance = input.validateResult(text);
          if (guidance) return { isError: true, content: [{ type: 'text', text: guidance }] };
          resultText = text;
          return { content: [{ type: 'text', text: 'Result accepted.' }] };
        },
      },
    ];
    const commitMessages = createKnowledgeManagerTranscript(store, turn, turn.triggerActor);
    const result = await withTurnModelCapture(
      {
        store,
        turn,
        workspaceDb: input.workspaceDb,
        environment: { systemPrompt, tools },
      },
      async (capture) => {
        const ordinary = createInternalAgentGatewayProvider({
          capture,
          logicalModel,
          resolveLogicalModel: (id) => {
            const current = dependencies.runtimeConfig();
            return resolveLogicalModel(
              current.gatewayConfig,
              current.providerRegistry,
              id,
              dependencies.providerSubscriptionAccountManager,
              dependencies.providerCredentialConfigured
            );
          },
          dispatcher: dependencies.dispatcher,
          resolveGatewayProvider: dependencies.resolveGatewayProvider,
          ...(dependencies.providerSubscriptionAccountManager
            ? {
                providerSubscriptionAccountManager: dependencies.providerSubscriptionAccountManager,
              }
            : {}),
          promptCacheScope: { sessionId: turn.threadId, workspaceId: turn.workspaceId },
          usageEndpoint: 'responses',
          callContext: {
            authorityActor: turn.triggerActor,
            agentId: 'knowledge-manager',
            workspaceId: turn.workspaceId,
            family: 'llm',
            operation: 'knowledge.run',
            capabilityId: 'inference.local.knowledge-manager',
            providerRef: null,
            requestId: null,
            serviceRef: 'llm-gateway',
            redactionClass: 'metadata-only',
            summary: 'Knowledge Manager bounded Turn.',
          },
        });
        const provider = createCompactingInternalAgentProvider({
          store,
          turn,
          compactThreshold: threshold,
          limits,
          assertCurrent: input.assertCurrent,
          readEvidence: input.readEvidence,
          commitMessages,
          callProvider: ordinary,
        });
        // One repair turn may read missing evidence or submit an unsubmitted candidate. It shares
        // the captured Provider, compaction call budget and absolute deadline; effects are not repeated.
        let resultRequested = false;
        const callIds = new Set<string>();
        const resultProvider: InternalAgentProviderCall = async (request) => {
          request.signal.throwIfAborted();
          // The compacting Provider owns pre-dispatch and post-response source validation.
          // The result Tool is terminal. End the loop without another Provider effect.
          if (resultText !== undefined)
            return { message: { role: 'assistant', content: [], truncated: false } };
          if (resultRequested) {
            if (repairUsed) throw new Error('Knowledge result repair failed.');
            repairUsed = true;
          }
          const response = await provider(request);
          for (const part of response.message.content) {
            if (part.type !== 'toolCall') continue;
            if (callIds.has(part.callId))
              throw new Error('Knowledge result repair has invalid Tool calls.');
            callIds.add(part.callId);
          }
          resultRequested = response.message.content.some(
            (part) => part.type === 'toolCall' && part.name === 'knowledge.result'
          );
          return response;
        };
        const loopInput = {
          systemPrompt,
          messages: input.messages,
          tools,
          model: {
            logicalModelId: logicalModel.id,
            capabilities: logicalModel.capabilities,
            modelFamilyId: logicalModel.modelFamilyId,
          },
          limits,
          signal,
        };
        let exit = await runInternalAgentLoop(loopInput, resultProvider);
        commitMessages(exit.messages);
        if (resultText === undefined && exit.kind === 'quiescent' && !repairUsed) {
          repairUsed = true;
          if (usedToolCalls >= limits.maxToolCalls)
            throw new Error('Knowledge Tool budget is exhausted.');
          exit = await runInternalAgentLoop(
            {
              ...loopInput,
              messages: [
                ...exit.messages,
                {
                  role: 'user',
                  content: [
                    {
                      type: 'text',
                      text: 'The run has no accepted result. Complete missing evidence reads or the unsubmitted native notebook outcome, then call knowledge.result with its required fields. Plain text is not a result. Do not repeat notebook effects.',
                    },
                  ],
                },
              ],
              limits: {
                ...limits,
                maxToolCalls: limits.maxToolCalls - usedToolCalls,
              },
            },
            resultProvider
          );
          commitMessages(exit.messages);
        }
        signal.throwIfAborted();
        input.assertCurrent();
        if (resultText === undefined)
          throw new Error(`Knowledge Manager returned no accepted result (${exit.kind}).`);
        return resultText;
      }
    );
    store.updateTurn(turn.id, { status: 'completed', completedAt: new Date().toISOString() });
    return { turnId: turn.id, text: result };
  } catch (error) {
    if (!isSealedTurnTerminal(store.getTurnById(turn.id).status))
      store.updateTurn(turn.id, {
        status: input.signal.aborted ? 'cancelled' : 'failed',
        completedAt: new Date().toISOString(),
        error: internalContextFailure(error) ?? {
          code: 'knowledge_manager_failed',
          message: 'Knowledge Manager run failed. Inspect the retained Turn before a new request.',
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
  store: FsStore,
  turn: Turn,
  actor: ActorRef
): (messages: readonly AgentMessage[]) => readonly Item[] {
  const committed = new Map<string, Item>();
  return (messages) => {
    const items: Item[] = [];
    for (const [index, message] of messages.entries()) {
      if (message.role === 'tool') continue;
      const text = message.content
        .flatMap((part) => (part.type === 'text' ? [part.text] : []))
        .join('');
      if (text) {
        const key = `message:${index}`;
        if (!committed.has(key)) {
          const timestamp = new Date().toISOString();
          const base = {
            id: allocateEntityId('it'),
            workspaceId: turn.workspaceId,
            threadId: turn.threadId,
            turnId: turn.id,
            status: 'completed' as const,
            createdAt: timestamp,
            completedAt: timestamp,
            text,
          };
          committed.set(
            key,
            store.createItem(
              message.role === 'user'
                ? { ...base, type: 'user-message', actor }
                : { ...base, type: 'assistant-message' }
            )
          );
        }
        items.push(committed.get(key)!);
      }
      if (message.role !== 'assistant') continue;
      for (const part of message.content) {
        if (part.type !== 'toolCall') continue;
        const result = messages.find(
          (candidate) => candidate.role === 'tool' && candidate.callId === part.callId
        );
        // A cancelled run can end with an unsettled call. It has no accepted result to summarize.
        if (!result || result.role !== 'tool') continue;
        const key = `call:${part.callId}`;
        if (!committed.has(key)) {
          const timestamp = new Date().toISOString();
          committed.set(
            key,
            store.createItem({
              id: allocateEntityId('it'),
              workspaceId: turn.workspaceId,
              threadId: turn.threadId,
              turnId: turn.id,
              type: 'tool-call',
              causationId: part.callId,
              status: result.isError ? 'failed' : 'completed',
              tool: part.name,
              server: null,
              arguments:
                typeof part.arguments === 'object' &&
                part.arguments !== null &&
                !Array.isArray(part.arguments)
                  ? (part.arguments as Record<string, unknown>)
                  : null,
              result: JSON.stringify(result.content),
              error: result.isError ? 'Tool failed.' : null,
              durationMs: null,
              createdAt: timestamp,
              completedAt: timestamp,
            })
          );
        }
        items.push(committed.get(key)!);
      }
    }
    // Native publication outcomes can be committed between a call and its loop result.
    // Include that accepted canonical prefix so exact history ranges and summary source counts agree.
    return store
      .getTurnById(turn.id)
      .items.filter(
        (item) =>
          item.type !== 'context-summary' &&
          item.type !== 'reasoning' &&
          ['completed', 'failed'].includes(item.status)
      );
  };
}
