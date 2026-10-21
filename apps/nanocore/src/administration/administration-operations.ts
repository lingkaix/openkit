import {
  type ADMINISTRATION_ENTRY_OPERATION_DEFINITIONS,
  type SubmitAdministrationConversationResponse,
  SubmitAdministrationConversationResponseSchema,
} from '@openkit/app-api-schemas';
import { ASSISTANT_RUN_DEADLINE_MS, type OpenKitNanoHostConfig } from '@openkit/config-schema';
import type { ActorRef } from '@openkit/protocol';
import { deriveEntityId, workspaceIdForOwner } from '@openkit/protocol';
import { z } from 'zod';
import { prepareAuditEvent } from '../audit-events.js';
import type { Actor } from '../auth/identity.js';
import {
  DeploymentAdminRequiredError,
  requireCurrentDeploymentAdmin,
} from '../auth/operation-authorizer.js';
import { createAdministrationConfiguration } from '../config/administration-configuration.js';
import type { CoreMode } from '../config/mode.js';
import type { RuntimeConfigManager } from '../config/runtime-config.js';
import { findWorkspaceConfig, type RuntimeConfigSnapshot } from '../config/runtime-config.js';
import type { RuntimeConfigFileService } from '../config/runtime-config-files.js';
import { RuntimeConfigFileServiceError } from '../config/runtime-config-files.js';
import { assembleBuiltInSystemPrompt } from '../internal-agents/builtin-prompts.js';
import { createInternalAgentGatewayProvider } from '../internal-agents/gateway-provider.js';
import { type AgentMessage, runInternalAgentLoop } from '../internal-agents/internal-agent-loop.js';
import { readInternalContextEvidence } from '../internal-agents/internal-context-evidence.js';
import { resolveInternalRoleProfile } from '../internal-agents/profile-resolver.js';
import { redactInternalAgentText } from '../internal-agents/redaction.js';
import {
  internalContextFailure,
  prepareInternalAgentContext,
} from '../internal-agents/rolling-context.js';
import {
  ALREADY_DECIDED_PUBLICATION_ADMISSION,
  type FsStore,
  StoreRecordNotFoundError,
  type TerminalTurnPublication,
} from '../lib/store.js';
import { resolveLogicalModel } from '../llm/logical-models.js';
import { withTurnModelCapture } from '../llm/model-capture.js';
import type { LLMGatewayProviderDispatcher } from '../llm/provider-dispatcher.js';
import type { ProviderSubscriptionAccountManager } from '../llm/provider-subscription-accounts.js';
import { type FamilyImplementations, publicOperationActor } from '../operation-contract.js';
import { OperationError } from '../operation-error.js';
import type { ResolvedLLMProviderConfig } from '../providers/llm-config.js';
import type { ProviderCredentialConfigured } from '../providers/registry.js';
import {
  IdempotencyKeyConflictError,
  type InflightIdempotentCommand,
  runIdempotentCommand,
} from '../runtime/idempotent-command.js';
import type { TurnCommandRuntimeContext } from '../runtime/types.js';
import type { CoreDb, WorkspaceDb } from '../storage/db.js';
import {
  type AdministrationEnvironmentTools,
  createAdministrationTools,
} from './administration-tools.js';
import { createAdministrationConfigurationTools } from './configuration-tools.js';
import { createAdministrationNanoHostRuntimeTargetTool } from './nanohost-runtime-target-tool.js';

const ADMINISTRATION_AGENT_ID = 'assistant';
const ADMINISTRATION_TARGET_REF = 'internal-role:administration';
const DEFAULT_LIMITS = {
  maxModelTurns: 16,
  maxToolCalls: 48,
  deadlineMs: ASSISTANT_RUN_DEADLINE_MS,
} as const;

// Live interruption handles belong to this entry; retained Turns never resume inference after restart.
const activeAdministrationRuns = new WeakMap<
  FsStore,
  Map<string, { controller: AbortController; finished: Promise<void> }>
>();

/** Interrupts an admitted Administration run and verifies its durable terminal outcome before accepting Stop. */
export async function interruptAdministrationTurn(
  store: FsStore,
  turnId: string,
  context?: TurnCommandRuntimeContext
): Promise<boolean> {
  const run = activeAdministrationRuns.get(store)?.get(turnId);
  if (!run) return false;
  if (context?.command && context.command.receipt.command !== 'turn.interrupt')
    throw new Error('Internal interruption requires its original interrupt command.');
  if (
    run.controller.signal.aborted &&
    context?.command?.receipt.key !==
      (run.controller.signal.reason as TurnCommandRuntimeContext | undefined)?.command?.receipt.key
  )
    throw new Error('Another interruption already owns this run.');
  // The existing cancellation reason carries the original command to the first terminal publisher.
  run.controller.abort(context);
  await run.finished;
  if (store.getTurnById(turnId).status !== 'interrupted')
    throw new OperationError(
      'recovery_required',
      'Administration interruption requires inspection of its retained outcome.',
      409
    );
  return true;
}

class AdministrationRecoveryRequiredError extends Error {
  public constructor() {
    super('Administration has partial durable state that requires inspection.');
    this.name = 'AdministrationRecoveryRequiredError';
  }
}

/** Context supplied to the Worker environment owner for one administration Turn. */
interface AdministrationEnvironmentToolContext {
  readonly actor: Actor;
  readonly administrationThreadId: string;
  readonly administrationTurnId: string;
  readonly administrationWorkspaceId: string;
  readonly requestId: string;
  readonly store: FsStore;
}

/** Dependencies for the private administration family; all request facts arrive in admitted context. */
interface AdministrationDependencies {
  readonly repositoryWorkspaceDb: (workspaceId: string) => WorkspaceDb;
  readonly coreDb: CoreDb | undefined;
  readonly environmentToolsForTurn: (
    context: AdministrationEnvironmentToolContext
  ) => AdministrationEnvironmentTools;
  readonly inflightCommands: WeakMap<FsStore, Map<string, InflightIdempotentCommand>>;
  readonly llmGatewayDispatcher: Pick<LLMGatewayProviderDispatcher, 'createResponses'>;
  readonly mode: CoreMode;
  readonly nanoHostConfig?: Pick<OpenKitNanoHostConfig, 'identityId' | 'deploymentId'>;
  readonly providerSubscriptionAccountManager?: ProviderSubscriptionAccountManager;
  /** Current API-key presence without resolving Vault material. */
  readonly providerCredentialConfigured?: ProviderCredentialConfigured;
  readonly quickChatWorkspaceIdForUser: (userId: string) => string;
  readonly store: FsStore;
  readonly runtimeConfigFiles: (actor: Actor) => RuntimeConfigFileService;
  readonly reloadRuntimeConfig: () => ReturnType<RuntimeConfigManager['reload']>;
  readonly resolveGatewayProvider: (providerId: string, model: string) => ResolvedLLMProviderConfig;
  readonly runtimeConfig: () => RuntimeConfigSnapshot;
}

/** Joins the private administration entry to its bounded conversation and immutable configuration owners. */
export function createAdministrationOperationImplementations(input: AdministrationDependencies) {
  /** Resolves request-owned configuration services without exposing authority to the model. */
  function configuration(actor: Actor) {
    if (!input.coreDb) throw new DeploymentAdminRequiredError();
    return createAdministrationConfiguration({
      actor,
      coreDb: input.coreDb,
      store: input.store,
      files: input.runtimeConfigFiles(actor),
      reload: input.reloadRuntimeConfig,
      inflightCommands: input.inflightCommands,
      runtimeConfig: input.runtimeConfig,
      repositoryWorkspaceDb: input.repositoryWorkspaceDb,
    });
  }
  return {
    'administration.configuration-apply': async (request, context) => {
      try {
        const actor = publicOperationActor(context);
        if (!input.coreDb) throw new DeploymentAdminRequiredError();
        requireCurrentDeploymentAdmin(input.coreDb, actor);
        return await configuration(actor).apply(request);
      } catch (error) {
        if (error instanceof DeploymentAdminRequiredError)
          throw new OperationError(
            'deployment_admin_required',
            'Current deployment administrator authority is required.',
            403,
            { cause: error }
          );
        if (
          error instanceof RuntimeConfigFileServiceError ||
          error instanceof IdempotencyKeyConflictError
        )
          throw new OperationError(error.code, error.message, error.status, { cause: error });
        if (
          error instanceof StoreRecordNotFoundError ||
          error instanceof z.ZodError ||
          error instanceof SyntaxError
        )
          throw new OperationError(
            'configuration_candidate_invalid',
            'Configuration candidate is unavailable or invalid.',
            409,
            { cause: error }
          );
        throw error;
      }
    },
    'administration.conversation-submit': async (request, context) => {
      if (!input.coreDb)
        throw new OperationError(
          'deployment_admin_required',
          'Current deployment administrator authority is required.',
          403
        );
      const actor = publicOperationActor(context);
      const workspaceId = input.quickChatWorkspaceIdForUser(actor.userId);
      const threadId = request.threadId ?? administrationThreadId(actor.userId, request.requestId);
      const store = input.store;
      try {
        requireCurrentDeploymentAdmin(input.coreDb, actor);
        const workspace = store.getWorkspace(workspaceId);
        if (workspace.kind !== 'personal')
          throw new OperationError('administration_failed', 'Administration failed.', 500);
        const currentThread = store
          .listThreads(workspaceId)
          .find((thread) => thread.id === threadId);
        if (request.threadId && !currentThread) {
          throw new OperationError('target_missing', 'Administration Thread is unavailable.', 409);
        }
        if (currentThread && currentThread.entryPath !== 'administration') {
          throw new OperationError(
            'thread_entry_path_mismatch',
            'Administration submission cannot continue this Thread.',
            409
          );
        }

        const result = await runIdempotentCommand({
          command: 'conversation.submit',
          execute: async (commandReceipt) => {
            requireCurrentDeploymentAdmin(input.coreDb!, actor);
            const thread =
              currentThread ??
              (await store.createThread(
                workspaceId,
                administrationThreadTitle(request.input),
                threadId,
                'administration',
                { visibility: 'private', privateOwnerUserId: actor.userId }
              ));
            const turnId = administrationTurnId(actor.userId, thread.id, request.requestId);
            if (
              store
                .listThreadTurns(workspaceId, thread.id)
                .some((candidate) => candidate.id === turnId)
            ) {
              throw new AdministrationRecoveryRequiredError();
            }
            const triggerActor = { kind: 'user', id: actor.userId } as const satisfies ActorRef;
            let turn: Awaited<ReturnType<FsStore['createTurn']>>;
            try {
              turn = await store.createTurn(
                workspaceId,
                thread.id,
                request.input,
                triggerActor,
                null,
                {
                  turnId,
                  agentId: ADMINISTRATION_AGENT_ID,
                }
              );
              const createdAt = turn.startedAt ?? new Date().toISOString();
              await store.createItem({
                id: deriveEntityId('it', ['administration_user', turn.id]),
                owner: { kind: 'workspace', workspaceId: workspaceId },
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

            /** Prepares the original Administration conversation receipt for its terminal tuple. */
            const terminalCommand = (
              resultKind: 'provider-answer' | 'refused',
              logicalModelId: string | null
            ): NonNullable<TerminalTurnPublication['command']> => {
              const { responseKind, command, ...receipt } = commandReceipt;
              if (command !== 'conversation.submit')
                throw new Error('Administration requires its original conversation command.');
              return {
                receipt: {
                  ...receipt,
                  command,
                  response: {
                    kind: responseKind,
                    id: turn.id,
                    conversationMetadata: {
                      downstream: null,
                      targetRef: ADMINISTRATION_TARGET_REF,
                      logicalModelId,
                      receivingWorkspaceId: workspaceId,
                      receivingThreadId: thread.id,
                      resultKind,
                      status: 200,
                    },
                  },
                },
                audit: {
                  ...prepareAuditEvent({
                    workspaceId,
                    threadId: thread.id,
                    turnId: turn.id,
                    requestId: receipt.requestId,
                    actor: context.actorRef,
                    category: 'command',
                    action: command,
                    resource: `turn:${turn.id}`,
                    outcome: 'succeeded',
                    summary: 'Administration conversation result published.',
                    now: new Date(receipt.createdAt),
                  }),
                  createdAt: receipt.createdAt,
                  occurredAt: receipt.createdAt,
                },
              };
            };
            const fail = (
              code: string,
              explanation: string,
              status: 'failed' | 'interrupted' = 'failed'
            ) =>
              failedAdministrationTurn(
                store,
                turn.id,
                code,
                explanation,
                status,
                terminalCommand('refused', null),
                status === 'interrupted'
                  ? ((controller.signal.reason as TurnCommandRuntimeContext | undefined)?.command ??
                      undefined)
                  : undefined
              );

            // Admission, not the submitting connection, owns this run's cancellation lifetime.
            const controller = new AbortController();
            let finishRun!: () => void;
            const finished = new Promise<void>((resolve) => {
              finishRun = resolve;
            });
            let runs = activeAdministrationRuns.get(store);
            if (!runs) {
              runs = new Map();
              activeAdministrationRuns.set(store, runs);
            }
            runs.set(turn.id, { controller, finished });
            let answerStarted = false;
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
                providerSubscriptionAccountManager: input.providerSubscriptionAccountManager,
                providerCredentialConfigured: input.providerCredentialConfigured,
                ...(request.logicalModelId
                  ? { requestedLogicalModelId: request.logicalModelId }
                  : {}),
                ...(workspaceConfig ? { workspaceConfig } : {}),
                ...(userConfig ? { userConfig } : {}),
              });
              if (
                !selection ||
                !selection.logicalModel.capabilities.includes('responses') ||
                !selection.logicalModel.capabilities.includes('tool-calling')
              ) {
                return await fail(
                  'administration_execution_failed',
                  !selection
                    ? 'Administration has no admitted logical model for this request.'
                    : 'Administration requires an admitted logical model with responses and tool-calling capabilities.'
                );
              }
              const catalog = configuration(actor);
              const tools = createAdministrationTools({
                configurationTools: createAdministrationConfigurationTools(
                  snapshot,
                  input.runtimeConfigFiles(actor),
                  {
                    ...catalog,
                    propose: (value) =>
                      catalog.propose(value, {
                        threadId: thread.id,
                        turnId: turn.id,
                        requestId: request.requestId,
                      }),
                    applyDelegated: (value, context) =>
                      catalog.applyDelegated(value, {
                        threadId: thread.id,
                        turnId: turn.id,
                        signal: context.signal,
                      }),
                  }
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
                runtimeTargetTool: createAdministrationNanoHostRuntimeTargetTool({
                  actor,
                  lineage: { workspaceId, threadId: thread.id, turnId: turn.id },
                  coreDb: input.coreDb,
                  mode: input.mode,
                  ...(input.nanoHostConfig ? { nanoHostConfig: input.nanoHostConfig } : {}),
                }),
              });
              const systemPrompt = assembleBuiltInSystemPrompt('administration', {
                workspaceId,
                threadId: thread.id,
                workspaceKind: 'personal',
              });
              const loopResult = await withTurnModelCapture(
                { store, turn, environment: { systemPrompt, tools } },
                async (capture) => {
                  const provider = createInternalAgentGatewayProvider({
                    capture,
                    logicalModel: selection.logicalModel,
                    ...(selection.profile?.reasoningEffort === undefined
                      ? {}
                      : { reasoningEffort: selection.profile.reasoningEffort }),
                    resolveLogicalModel: (logicalModelId) => {
                      const snapshot = input.runtimeConfig();
                      return resolveLogicalModel(
                        snapshot.gatewayConfig,
                        snapshot.providerRegistry,
                        logicalModelId,
                        input.providerSubscriptionAccountManager,
                        input.providerCredentialConfigured
                      );
                    },
                    dispatcher: input.llmGatewayDispatcher,
                    resolveGatewayProvider: input.resolveGatewayProvider,
                    ...(input.providerSubscriptionAccountManager
                      ? {
                          providerSubscriptionAccountManager:
                            input.providerSubscriptionAccountManager,
                        }
                      : {}),
                    promptCacheScope: { sessionId: `administration:${thread.id}`, workspaceId },
                    usageEndpoint: 'responses',
                    callContext: {
                      authorityActor: triggerActor,
                      agentId: ADMINISTRATION_AGENT_ID,
                      workspaceId,
                      family: 'llm',
                      operation: 'administration',
                      capabilityId: 'inference.local.administration',
                      providerRef: null,
                      requestId: null,
                      serviceRef: 'llm-gateway',
                      redactionClass: 'metadata-only',
                      summary: 'Private administration Assistant LLM call.',
                    },
                  });
                  const model = {
                    logicalModelId: selection.logicalModel.id,
                    capabilities: selection.logicalModel.capabilities,
                    modelFamilyId: selection.logicalModel.modelFamilyId,
                  };
                  const window = await prepareInternalAgentContext({
                    store,
                    turn,
                    systemPrompt,
                    tools,
                    model,
                    bounds: {
                      context: selection.logicalModel.contract?.context,
                      output: selection.logicalModel.contract?.output,
                    },
                    requiredMessages: [
                      { role: 'user', content: [{ type: 'text', text: request.input }] },
                    ],
                    profileId: selection.profile?.id ?? null,
                    limits: selection.profile?.limits ?? DEFAULT_LIMITS,
                    signal: controller.signal,
                    assertCurrent: () => requireCurrentDeploymentAdmin(input.coreDb!, actor),
                    readEvidence: (items) =>
                      readInternalContextEvidence({
                        store,
                        coreDb: input.coreDb!,
                        actor,
                        workspaceId,
                        threadId: thread.id,
                        items,
                      }),
                    callProvider: provider,
                  });
                  answerStarted = true;
                  const exit = await runInternalAgentLoop(
                    {
                      systemPrompt,
                      tools,
                      model,
                      messages: window.messages,
                      limits: window.limits,
                      signal: window.signal,
                    },
                    (request) => {
                      window.assertCurrent();
                      return provider(request);
                    }
                  );
                  window.assertCurrent();
                  return exit;
                }
              );
              controller.signal.throwIfAborted();
              if (loopResult.kind !== 'quiescent') {
                const code =
                  loopResult.kind === 'failed'
                    ? loopResult.code
                    : loopResult.kind === 'limit_reached'
                      ? `internal_agent_${loopResult.limit}_limit`
                      : 'internal_agent_aborted';
                return await fail(
                  code,
                  loopResult.kind === 'limit_reached' && loopResult.limit === 'deadline'
                    ? 'The admitted deadline expired during Administration answer production.'
                    : 'Administration could not complete this bounded run.'
                );
              }
              const answer = finalAssistantText(loopResult.messages);
              if (!answer) {
                return await fail(
                  'internal_agent_empty_answer',
                  'Administration returned no publishable answer.'
                );
              }
              requireCurrentDeploymentAdmin(input.coreDb!, actor);
              try {
                const completedAt = new Date().toISOString();
                const item = await store.createItem({
                  id: deriveEntityId('it', ['administration_answer', turn.id]),
                  owner: { kind: 'workspace', workspaceId: workspaceId },
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
                    await store.completeTurn(
                      turn.id,
                      { status: 'completed', completedAt },
                      {
                        items: [item],
                        command: terminalCommand('provider-answer', selection.logicalModel.id),
                        requestId: request.requestId,
                      }
                    ),
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
              if (controller.signal.aborted)
                return await fail(
                  'internal_agent_aborted',
                  'Administration was explicitly interrupted.',
                  'interrupted'
                );
              const contextFailure = internalContextFailure(error);
              const answerDeadline =
                answerStarted && contextFailure?.code === 'internal_agent_context_deadline';
              return await fail(
                error instanceof DeploymentAdminRequiredError
                  ? 'deployment_admin_required'
                  : answerDeadline
                    ? 'internal_agent_deadline_limit'
                    : (contextFailure?.code ?? 'administration_execution_failed'),
                error instanceof DeploymentAdminRequiredError
                  ? 'Current deployment administrator authority was lost before publication.'
                  : answerDeadline
                    ? 'The admitted deadline expired during Administration answer production.'
                    : (contextFailure?.message ??
                      'Administration could not settle the current bounded run.')
              );
            } finally {
              runs.delete(turn.id);
              finishRun();
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
        return result.body;
      } catch (error) {
        if (error instanceof OperationError) throw error;
        if (error instanceof DeploymentAdminRequiredError)
          throw new OperationError(
            'deployment_admin_required',
            'Current deployment administrator authority is required.',
            403,
            { cause: error }
          );
        if (error instanceof IdempotencyKeyConflictError)
          throw new OperationError(
            error.code,
            redactInternalAgentText(error.message),
            error.status,
            { cause: error }
          );
        if (
          error instanceof AdministrationRecoveryRequiredError ||
          hasAdministrationTurn(
            store,
            workspaceId,
            threadId,
            administrationTurnId(actor.userId, threadId, request.requestId)
          )
        )
          throw new OperationError(
            'recovery_required',
            'Administration has partial durable state that requires inspection.',
            409,
            { cause: error }
          );
        if (error instanceof StoreRecordNotFoundError)
          throw new OperationError('administration_failed', 'Administration failed.', 500, {
            cause: error,
          });
        throw error;
      }
    },
  } satisfies FamilyImplementations<typeof ADMINISTRATION_ENTRY_OPERATION_DEFINITIONS>;
}

type AdministrationCommandResult = {
  readonly body: SubmitAdministrationConversationResponse;
  readonly resultKind: 'provider-answer' | 'refused';
  readonly status: 200;
};

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

/** Awaits failed or interrupted publication so its live interruption handle remains owned until acknowledgement. */
async function failedAdministrationTurn(
  store: FsStore,
  turnId: string,
  code: string,
  explanation: string,
  status: 'failed' | 'interrupted',
  command: NonNullable<TerminalTurnPublication['command']>,
  interruptCommand?: TerminalTurnPublication['interruptCommand']
): Promise<AdministrationCommandResult> {
  const turn = store.getTurnById(turnId);
  const completedAt = new Date().toISOString();
  try {
    const item = await store.createItem(
      {
        id: deriveEntityId('it', ['administration_refused', turn.id]),
        owner: { kind: 'workspace', workspaceId: workspaceIdForOwner(turn.owner) },
        threadId: turn.threadId,
        turnId: turn.id,
        type: 'status',
        status: 'completed',
        level: 'warning',
        title: 'Administration request did not complete',
        summary: explanation,
        createdAt: completedAt,
        completedAt,
      },
      ALREADY_DECIDED_PUBLICATION_ADMISSION
    );
    const completedTurn = await store.completeTurn(
      turn.id,
      {
        status,
        completedAt,
        error: { code, message: explanation },
      },
      { items: [item], command, interruptCommand, requestId: command.receipt.requestId }
    );
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
  item: Awaited<ReturnType<FsStore['createItem']>>,
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
    originatingWorkspaceId: workspaceIdForOwner(turn.owner),
    originatingThreadId: turn.threadId,
    receivingWorkspaceId: workspaceIdForOwner(turn.owner),
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
      workspaceIdForOwner(turn.owner) !== workspaceId ||
      turn.threadId !== threadId ||
      store.getThread(workspaceId, threadId).entryPath !== 'administration'
    ) {
      throw new AdministrationRecoveryRequiredError();
    }
    const itemId =
      resultKind === 'provider-answer'
        ? deriveEntityId('it', ['administration_answer', turn.id])
        : deriveEntityId('it', ['administration_refused', turn.id]);
    const item = turn.items.find((candidate) => candidate.id === itemId);
    const userItem = turn.items.find(
      (candidate) => candidate.id === deriveEntityId('it', ['administration_user', turn.id])
    );
    const consistentUser =
      userItem?.type === 'user-message' &&
      userItem.status === 'completed' &&
      workspaceIdForOwner(userItem.owner) === workspaceId &&
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
      (turn.status === 'failed' ||
        (turn.status === 'interrupted' && turn.error?.code === 'internal_agent_aborted')) &&
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
  return deriveEntityId('th', ['administration', userId, requestId]);
}

function administrationTurnId(userId: string, threadId: string, requestId: string): string {
  return deriveEntityId('tu', ['administration', userId, threadId, requestId]);
}

function administrationThreadTitle(text: string): string {
  return text.trim().split(/\r?\n/, 1)[0]?.slice(0, 120) || 'Administration';
}
