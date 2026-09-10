import { createHash } from 'node:crypto';

import {
  SubmitAdministrationConversationRequestSchema,
  type SubmitAdministrationConversationResponse,
  SubmitAdministrationConversationResponseSchema,
} from '@openkit/app-api-schemas';
import type { ActorRef } from '@openkit/protocol';
import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

import { asApiError, asInvalidRequestError } from '../api-errors.js';
import type { AuthVariables } from '../auth/middleware.js';
import {
  assertAuthorizedWorkspaceLineage,
  DeploymentAdminRequiredError,
  requireCurrentDeploymentAdmin,
} from '../auth/operation-authorizer.js';
import {
  finishCapabilityCall,
  recordUsage,
  startCapabilityCall,
} from '../capability/usage-ledger.js';
import { findWorkspaceConfig, type RuntimeConfigSnapshot } from '../config/runtime-config.js';
import type { RuntimeConfigFileService } from '../config/runtime-config-files.js';
import { createInternalAgentGatewayProvider } from '../internal-agents/gateway-provider.js';
import { type AgentMessage, runInternalAgentLoop } from '../internal-agents/internal-agent-loop.js';
import { resolveInternalRoleProfile } from '../internal-agents/profile-resolver.js';
import { redactInternalAgentText } from '../internal-agents/redaction.js';
import type { FsStore } from '../lib/store.js';
import { parseUsage } from '../llm/gateway-usage.js';
import type { LLMGatewayProviderDispatcher } from '../llm/provider-dispatcher.js';
import type { ProviderSubscriptionAccountManager } from '../llm/provider-subscription-accounts.js';
import { registerAppApiRoute } from '../openapi.js';
import type { ResolvedLLMProviderConfig } from '../providers/llm-config.js';
import {
  IdempotencyKeyConflictError,
  type InflightIdempotentCommand,
  runIdempotentCommand,
} from '../runtime/idempotent-command.js';
import { type CoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import {
  type AdministrationEnvironmentTools,
  createAdministrationTools,
} from './administration-tools.js';
import { createAdministrationConfigurationTools } from './configuration-tools.js';

const ADMINISTRATION_AGENT_ID = 'assistant';
const ADMINISTRATION_TARGET_REF = 'internal-role:administration';
const ADMINISTRATION_SYSTEM_PROMPT = [
  'You are the private OpenKit administration entry of the Personal Assistant.',
  'Use only the six supplied Tools. Treat Tool results as current owner observations and state uncertainty explicitly.',
  'Configuration operations may be unavailable. Worker environment preparation proposes an exact candidate only; it never activates, purges, interrupts, mounts, or restarts work.',
  'Never request or reveal credentials, host paths, shell commands, Docker socket access, raw policy, or authorization tokens. A human applies confirmed effects through the owning public command.',
].join(' ');
const DEFAULT_LIMITS = { maxModelTurns: 16, maxToolCalls: 48, deadlineMs: 120_000 } as const;

class AdministrationRecoveryRequiredError extends Error {
  public constructor() {
    super('Administration has partial durable state that requires inspection.');
    this.name = 'AdministrationRecoveryRequiredError';
  }
}

/** Context supplied to the Worker environment owner for one administration Turn. */
export interface AdministrationEnvironmentToolContext {
  readonly actor: Context<{ Variables: AuthVariables }>['var']['actor'];
  readonly administrationThreadId: string;
  readonly administrationTurnId: string;
  readonly administrationWorkspaceId: string;
  readonly requestId: string;
  readonly store: FsStore;
}

/** Dependencies for the private administration conversation route. */
export interface RegisterAdministrationRoutesInput {
  readonly app: Hono<{ Variables: AuthVariables }>;
  readonly coreDb: CoreDb | undefined;
  readonly environmentToolsForTurn: (
    context: AdministrationEnvironmentToolContext
  ) => AdministrationEnvironmentTools;
  readonly inflightCommands: WeakMap<FsStore, Map<string, InflightIdempotentCommand>>;
  readonly llmGatewayDispatcher: Pick<LLMGatewayProviderDispatcher, 'createResponses'>;
  readonly providerSubscriptionAccountManager?: ProviderSubscriptionAccountManager;
  readonly quickChatWorkspaceIdForUser: (userId: string) => string;
  readonly requestStore: (context: Context<{ Variables: AuthVariables }>) => FsStore;
  readonly runtimeConfigFiles: (
    context: Context<{ Variables: AuthVariables }>
  ) => Pick<RuntimeConfigFileService, 'listFiles' | 'readFile'>;
  readonly resolveGatewayProvider: (providerId: string, model: string) => ResolvedLLMProviderConfig;
  readonly runtimeConfig: () => RuntimeConfigSnapshot;
}

/** Registers the current-user private administration conversation entry. */
export function registerAdministrationRoutes(input: RegisterAdministrationRoutesInput): void {
  registerAppApiRoute(input.app, 'submitAdministrationConversation', async (context) => {
    const parsed = SubmitAdministrationConversationRequestSchema.safeParse(
      await context.req.json().catch(() => ({}))
    );
    if (!parsed.success) return asInvalidRequestError(parsed.error);
    if (!input.coreDb) {
      return asApiError(
        'Current deployment administrator authority is required.',
        'deployment_admin_required',
        403
      );
    }

    const request = parsed.data;
    const actor = context.get('actor');
    const workspaceId = input.quickChatWorkspaceIdForUser(actor.userId);
    const threadId = request.threadId ?? administrationThreadId(actor.userId, request.requestId);
    const store = input.requestStore(context);
    try {
      requireCurrentDeploymentAdmin(input.coreDb, actor);
      const workspace = store.getWorkspace(workspaceId);
      if (workspace.kind !== 'quick-chat') throw new Error('Private Workspace is unavailable.');
      const workspaceAccess = context.get('workspaceAccess');
      if (workspaceAccess) assertAuthorizedWorkspaceLineage(workspaceAccess, workspaceId);
      const currentThread = store.listThreads(workspaceId).find((thread) => thread.id === threadId);
      if (request.threadId && !currentThread) {
        return asApiError('Administration Thread is unavailable.', 'target_missing', 409);
      }
      if (currentThread && currentThread.entryPath !== 'administration') {
        return asApiError(
          'Administration submission cannot continue this Thread.',
          'thread_entry_path_mismatch',
          409
        );
      }

      const result = await runIdempotentCommand({
        command: 'conversation.submit',
        execute: async () => {
          requireCurrentDeploymentAdmin(input.coreDb!, actor);
          const thread =
            currentThread ??
            store.createThread(
              workspaceId,
              administrationThreadTitle(request.input),
              threadId,
              'administration'
            );
          const turnId = administrationTurnId(actor.userId, thread.id, request.requestId);
          if (
            store
              .listThreadTurns(workspaceId, thread.id)
              .some((candidate) => candidate.id === turnId)
          ) {
            throw new AdministrationRecoveryRequiredError();
          }
          const triggerActor = { kind: 'user', id: actor.userId } as const satisfies ActorRef;
          let turn: ReturnType<FsStore['createTurn']>;
          try {
            turn = store.createTurn(workspaceId, thread.id, request.input, triggerActor, null, {
              turnId,
            });
            const createdAt = turn.startedAt ?? new Date().toISOString();
            store.createItem({
              id: `it_administration_user_${turn.id}`,
              workspaceId,
              threadId: thread.id,
              turnId: turn.id,
              type: 'user-message',
              status: 'completed',
              actor: triggerActor,
              text: request.input,
              createdAt,
              completedAt: createdAt,
            });
          } catch (error) {
            if (
              store
                .listThreadTurns(workspaceId, thread.id)
                .some((candidate) => candidate.id === turnId)
            ) {
              throw new AdministrationRecoveryRequiredError();
            }
            throw error;
          }

          try {
            const snapshot = input.runtimeConfig();
            const workspaceConfig = findWorkspaceConfig(snapshot, workspaceId)?.config;
            const userConfig = snapshot.userConfigs.find(
              (entry) => entry.userId === actor.userId
            )?.config;
            const selection = resolveInternalRoleProfile({
              roleId: ADMINISTRATION_AGENT_ID,
              workspaceId,
              gatewayConfig: snapshot.gatewayConfig,
              profilesConfig: snapshot.internalRoleProfiles,
              providerRegistry: snapshot.providerRegistry,
              ...(request.logicalModelId
                ? { requestedLogicalModelId: request.logicalModelId }
                : {}),
              ...(workspaceConfig ? { workspaceConfig } : {}),
              ...(userConfig ? { userConfig } : {}),
            });
            if (
              !selection ||
              !selection.logicalModel.contextManagement ||
              !selection.logicalModel.capabilities.includes('responses') ||
              !selection.logicalModel.capabilities.includes('tool-calling')
            ) {
              return failedAdministrationTurn(
                store,
                turn.id,
                'context_compaction_unavailable',
                'Administration requires an admitted Tool-capable logical model with context policy.'
              );
            }

            const tools = createAdministrationTools({
              configurationTools: createAdministrationConfigurationTools(
                snapshot,
                input.runtimeConfigFiles(context)
              ),
              requireCurrentAdministrator: () => {
                requireCurrentDeploymentAdmin(input.coreDb!, actor);
              },
              environmentTools: input.environmentToolsForTurn({
                actor,
                administrationThreadId: thread.id,
                administrationTurnId: turn.id,
                administrationWorkspaceId: workspaceId,
                requestId: request.requestId,
                store,
              }),
            });
            const priorMessages = administrationMessages(store, workspaceId, thread.id, turn.id);
            const loopResult = await runInternalAgentLoop(
              {
                systemPrompt: ADMINISTRATION_SYSTEM_PROMPT,
                messages: priorMessages,
                tools,
                model: {
                  logicalModelId: selection.logicalModel.id,
                  capabilities: selection.logicalModel.capabilities,
                  modelFamilyId: selection.logicalModel.modelFamilyId,
                },
                contextManagement: {
                  ...selection.logicalModel.contextManagement,
                  authority: 'openkit',
                },
                limits: selection.profile?.limits ?? DEFAULT_LIMITS,
                signal: context.req.raw.signal,
              },
              createInternalAgentGatewayProvider({
                logicalModel: selection.logicalModel,
                dispatcher: input.llmGatewayDispatcher,
                resolveGatewayProvider: input.resolveGatewayProvider,
                ...(input.providerSubscriptionAccountManager
                  ? { providerSubscriptionAccountManager: input.providerSubscriptionAccountManager }
                  : {}),
                metadata: { openkit: { sessionId: `administration:${thread.id}`, workspaceId } },
                promptCacheScope: { sessionId: `administration:${thread.id}`, workspaceId },
                usageEndpoint: 'responses',
                onDispatch: ({ providerId, usage }) => {
                  recordAdministrationLlmUsage({
                    authorityActor: triggerActor,
                    coreDb: input.coreDb!,
                    logicalModelId: selection.logicalModel.id,
                    providerId,
                    requestId: request.requestId,
                    threadId: thread.id,
                    turnId: turn.id,
                    usage,
                    workspaceId,
                  });
                },
              })
            );
            if (loopResult.kind !== 'quiescent') {
              const code =
                loopResult.kind === 'failed'
                  ? loopResult.code
                  : loopResult.kind === 'limit_reached'
                    ? `internal_agent_${loopResult.limit}_limit`
                    : 'internal_agent_aborted';
              return failedAdministrationTurn(
                store,
                turn.id,
                code,
                'Administration could not complete this bounded run.'
              );
            }
            const answer = finalAssistantText(loopResult.messages);
            if (!answer) {
              return failedAdministrationTurn(
                store,
                turn.id,
                'internal_agent_empty_answer',
                'Administration returned no publishable answer.'
              );
            }
            requireCurrentDeploymentAdmin(input.coreDb!, actor);
            try {
              const completedAt = new Date().toISOString();
              const item = store.createItem({
                id: `it_administration_answer_${turn.id}`,
                workspaceId,
                threadId: thread.id,
                turnId: turn.id,
                type: 'assistant-message',
                status: 'completed',
                text: redactInternalAgentText(answer),
                createdAt: completedAt,
                completedAt,
              });
              return {
                body: administrationResponse(
                  store.updateTurn(turn.id, { status: 'completed', completedAt }),
                  item,
                  selection.logicalModel.id,
                  'answered',
                  'The private administration Assistant answered through the bounded Tool set.'
                ),
                resultKind: 'provider-answer' as const,
                status: 200 as const,
              };
            } catch {
              throw new AdministrationRecoveryRequiredError();
            }
          } catch (error) {
            if (error instanceof AdministrationRecoveryRequiredError) throw error;
            return failedAdministrationTurn(
              store,
              turn.id,
              error instanceof DeploymentAdminRequiredError
                ? 'deployment_admin_required'
                : 'administration_execution_failed',
              error instanceof DeploymentAdminRequiredError
                ? 'Current deployment administrator authority was lost before publication.'
                : 'Administration could not settle the current bounded run.'
            );
          }
        },
        inflightCommands: input.inflightCommands,
        input: {
          input: request.input,
          logicalModelId: request.logicalModelId ?? null,
          targetRef: ADMINISTRATION_TARGET_REF,
        },
        replay: (record) =>
          replayAdministrationTurn(store, workspaceId, threadId, actor.userId, record),
        requestId: request.requestId,
        responseId: (result) => result.body.turn.id,
        responseKind: 'turn',
        conversationResponseMetadata: (result) => ({
          downstream: null,
          targetRef: ADMINISTRATION_TARGET_REF,
          logicalModelId: result.body.logicalModelId,
          receivingWorkspaceId: workspaceId,
          receivingThreadId: threadId,
          resultKind: result.resultKind,
          status: result.status,
        }),
        scope: { actorId: actor.userId, threadId, workspaceId },
        store,
      });
      return context.json(
        SubmitAdministrationConversationResponseSchema.parse(result.body),
        result.status
      );
    } catch (error) {
      if (error instanceof HTTPException) throw error;
      if (error instanceof DeploymentAdminRequiredError) {
        return asApiError(
          'Current deployment administrator authority is required.',
          'deployment_admin_required',
          403
        );
      }
      if (error instanceof IdempotencyKeyConflictError) {
        return asApiError(redactInternalAgentText(error.message), error.code, error.status);
      }
      if (error instanceof AdministrationRecoveryRequiredError) {
        return asApiError(
          'Administration has partial durable state that requires inspection.',
          'recovery_required',
          409
        );
      }
      if (
        hasAdministrationTurn(
          store,
          workspaceId,
          threadId,
          administrationTurnId(actor.userId, threadId, request.requestId)
        )
      ) {
        return asApiError(
          'Administration has partial durable state that requires inspection.',
          'recovery_required',
          409
        );
      }
      return asApiError('Administration failed.', 'administration_failed', 500);
    }
  });
}

type AdministrationCommandResult = {
  readonly body: SubmitAdministrationConversationResponse;
  readonly resultKind: 'provider-answer' | 'refused';
  readonly status: 200;
};

function administrationMessages(
  store: FsStore,
  workspaceId: string,
  threadId: string,
  currentTurnId: string
): AgentMessage[] {
  return store
    .listThreadItems(workspaceId, threadId)
    .filter((item) => item.turnId !== currentTurnId || item.type === 'user-message')
    .flatMap((item): AgentMessage[] => {
      if (item.type === 'user-message') {
        return [{ role: 'user', content: [{ type: 'text', text: item.text }] }];
      }
      if (item.type === 'assistant-message') {
        return [
          { role: 'assistant', content: [{ type: 'text', text: item.text }], truncated: false },
        ];
      }
      return [];
    });
}

/** Reads publishable text only from the final response of a quiescent loop. */
function finalAssistantText(messages: readonly AgentMessage[]): string {
  const message = messages.at(-1);
  if (!message || message.role !== 'assistant') return '';
  return message.content
    .filter(
      (part): part is { readonly type: 'text'; readonly text: string } => part.type === 'text'
    )
    .map((part) => part.text)
    .join('')
    .trim();
}

function failedAdministrationTurn(
  store: FsStore,
  turnId: string,
  code: string,
  explanation: string
): AdministrationCommandResult {
  const turn = store.getTurnById(turnId);
  const completedAt = new Date().toISOString();
  try {
    const item = store.createItem({
      id: `it_administration_refused_${turn.id}`,
      workspaceId: turn.workspaceId,
      threadId: turn.threadId,
      turnId: turn.id,
      type: 'status',
      status: 'completed',
      level: 'warning',
      title: 'Administration request did not complete',
      summary: explanation,
      createdAt: completedAt,
      completedAt,
    });
    const completedTurn = store.updateTurn(turn.id, {
      status: 'failed',
      completedAt,
      error: { code, message: explanation },
    });
    return {
      body: administrationResponse(completedTurn, item, null, 'refused', explanation),
      resultKind: 'refused',
      status: 200,
    };
  } catch {
    throw new AdministrationRecoveryRequiredError();
  }
}

function administrationResponse(
  turn: ReturnType<FsStore['getTurnById']>,
  item: ReturnType<FsStore['createItem']>,
  logicalModelId: string | null,
  outcome: 'answered' | 'refused',
  explanation: string
): SubmitAdministrationConversationResponse {
  return SubmitAdministrationConversationResponseSchema.parse({
    outcome,
    explanation,
    turn,
    item,
    handoff: null,
    originatingWorkspaceId: turn.workspaceId,
    originatingThreadId: turn.threadId,
    receivingWorkspaceId: turn.workspaceId,
    receivingThreadId: turn.threadId,
    targetRef: ADMINISTRATION_TARGET_REF,
    logicalModelId,
  });
}

function replayAdministrationTurn(
  store: FsStore,
  workspaceId: string,
  threadId: string,
  userId: string,
  record: ReturnType<FsStore['getCommandRequest']> extends infer T ? NonNullable<T> : never
): AdministrationCommandResult {
  try {
    const metadata = record.response.conversationMetadata;
    const turn = store.getTurnById(record.response.id);
    const resultKind = metadata?.resultKind;
    if (
      record.response.kind !== 'turn' ||
      metadata?.targetRef !== ADMINISTRATION_TARGET_REF ||
      metadata.receivingWorkspaceId !== workspaceId ||
      metadata.receivingThreadId !== threadId ||
      turn.workspaceId !== workspaceId ||
      turn.threadId !== threadId ||
      store.getThread(workspaceId, threadId).entryPath !== 'administration'
    ) {
      throw new AdministrationRecoveryRequiredError();
    }
    const itemId =
      resultKind === 'provider-answer'
        ? `it_administration_answer_${turn.id}`
        : `it_administration_refused_${turn.id}`;
    const item = turn.items.find((candidate) => candidate.id === itemId);
    const userItem = turn.items.find(
      (candidate) => candidate.id === `it_administration_user_${turn.id}`
    );
    const consistentUser =
      userItem?.type === 'user-message' &&
      userItem.status === 'completed' &&
      userItem.workspaceId === workspaceId &&
      userItem.threadId === threadId &&
      userItem.turnId === turn.id &&
      userItem.actor.kind === 'user' &&
      userItem.actor.id === userId;
    const consistentAnswer =
      resultKind === 'provider-answer' &&
      turn.status === 'completed' &&
      item?.type === 'assistant-message' &&
      item.status === 'completed';
    const consistentRefusal =
      resultKind === 'refused' &&
      turn.status === 'failed' &&
      turn.error !== null &&
      item?.type === 'status' &&
      item.status === 'completed';
    if (!consistentUser || (!consistentAnswer && !consistentRefusal)) {
      throw new AdministrationRecoveryRequiredError();
    }
    return {
      body: administrationResponse(
        turn,
        item,
        metadata.logicalModelId,
        resultKind === 'provider-answer' ? 'answered' : 'refused',
        resultKind === 'provider-answer'
          ? 'The private administration Assistant answered through the bounded Tool set.'
          : (turn.error?.message ?? 'Administration could not complete this bounded run.')
      ),
      resultKind,
      status: 200,
    };
  } catch {
    throw new AdministrationRecoveryRequiredError();
  }
}

function hasAdministrationTurn(
  store: FsStore,
  workspaceId: string,
  threadId: string,
  turnId: string
): boolean {
  try {
    return store.listThreadTurns(workspaceId, threadId).some((turn) => turn.id === turnId);
  } catch {
    return false;
  }
}

function administrationThreadId(userId: string, requestId: string): string {
  return `th_administration_${createHash('sha256')
    .update(JSON.stringify([userId, requestId]))
    .digest('hex')
    .slice(0, 24)}`;
}

function administrationTurnId(userId: string, threadId: string, requestId: string): string {
  return `tu_administration_${createHash('sha256')
    .update(JSON.stringify([userId, threadId, requestId]))
    .digest('hex')
    .slice(0, 24)}`;
}

function administrationThreadTitle(text: string): string {
  return text.trim().split(/\r?\n/, 1)[0]?.slice(0, 120) || 'Administration';
}

function recordAdministrationLlmUsage(input: {
  readonly authorityActor: ActorRef;
  readonly coreDb: CoreDb;
  readonly logicalModelId: string;
  readonly providerId: string;
  readonly requestId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly usage?: unknown;
  readonly workspaceId: string;
}): void {
  const workspaceDb = openWorkspaceDb(input.coreDb.dataRoot, input.workspaceId);
  try {
    applyScopedMigrations(workspaceDb);
    const call = startCapabilityCall({
      authorityActor: input.authorityActor,
      agentId: ADMINISTRATION_AGENT_ID,
      agentSessionId: null,
      capabilityId: 'inference.local.administration',
      family: 'llm',
      operation: 'administration',
      providerRef: input.providerId,
      redactionClass: 'metadata-only',
      requestId: input.requestId,
      serviceRef: 'llm-gateway',
      summary: 'Private administration Assistant LLM call.',
      threadId: input.threadId,
      turnId: input.turnId,
      itemId: null,
      workspaceDb,
      workspaceId: input.workspaceId,
    });
    const parsed = parseUsage(input.usage);
    const tokens = parsed.totalTokens || parsed.inputTokens + parsed.completionTokens;
    recordUsage({
      call,
      records: [
        {
          category: 'llm',
          modelId: input.logicalModelId,
          providerRef: input.providerId,
          quantity: tokens > 0 ? tokens : 1,
          source: tokens > 0 ? 'gateway-reported' : 'gateway-observed',
          unit: tokens > 0 ? 'tokens' : 'requests',
        },
      ],
      workspaceDb,
    });
    finishCapabilityCall({ workspaceDb, callId: call.id, status: 'succeeded' });
  } finally {
    workspaceDb.sqlite.close();
  }
}
