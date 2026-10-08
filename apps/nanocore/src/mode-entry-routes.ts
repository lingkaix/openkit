import { createHash } from 'node:crypto';
import {
  ConversationTargetCatalogSchema,
  type QuickChatRequestSchema,
  QuickChatResponseSchema,
  type StartTaskModeRequestSchema,
  type StartTaskModeResponse,
  StartTaskModeResponseSchema,
  type SubmitConversationRequestSchema,
  SubmitConversationResponseSchema,
  type TaskDelegationDecision,
  type TaskModeEvidence,
  type WorkerEnvironmentStorageChoice,
} from '@openkit/app-api-schemas';
import {
  type ActorRef,
  isCheckpointCollectableTurnStatus,
  responsibleUserIdForActor,
  type StopReason,
  TurnSchema,
} from '@openkit/protocol';
import { HTTPException } from 'hono/http-exception';
import type { z } from 'zod';
import { resolveAgentSetup } from './agents/setup-resolver.js';
import { publishedErrorMessage } from './api-errors.js';
import { listOutputArtifacts } from './artifact-catalog.js';
import type { Actor } from './auth/identity.js';
import { currentWorkspaceAuthority } from './auth/operation-authorizer.js';
import {
  finishCapabilityCall,
  normalizeCapabilityRequestId,
  startCapabilityCall,
} from './capability/usage-ledger.js';
import {
  findWorkspaceConfig,
  type RuntimeConfigSnapshot,
  resolveDefaultAgentId,
} from './config/runtime-config.js';
import { assembleBuiltInSystemPrompt } from './internal-agents/builtin-prompts.js';
import {
  createStructuredWorkerDelegationRequest,
  StructuredWorkerDelegationRequestSchema,
  serializeStructuredWorkerDelegationRequest,
} from './internal-agents/delegation.js';
import { resolveInternalRoleProfile } from './internal-agents/profile-resolver.js';
import { redactInternalAgentText } from './internal-agents/redaction.js';
import {
  createWorkerCoordinatorDecision,
  type WorkerCoordinatorCandidate,
  type WorkerCoordinatorDecision,
} from './internal-agents/worker-coordinator.js';
import { createTaskKnowledgePreparation } from './knowledge-operations.js';
import {
  type CommandRequestRecord,
  type ConversationCommandReceiptMetadata,
  DISPLAY_PROJECTION_REFRESH_ADMISSION,
  type FsStore,
} from './lib/store.js';
import {
  dispatchLogicalModel,
  LogicalModelRoutesExhaustedError,
  projectGatewayFailure,
} from './llm/gateway-routes.js';
import { recordInternalLlmGatewayUsage } from './llm/gateway-usage.js';
import type { ResolvedLogicalModel } from './llm/logical-models.js';
import { type ModelCaptureContext, withTurnModelCapture } from './llm/model-capture.js';
import {
  type OpenAICompatibleChatMessage,
  OpenAICompatibleProviderError,
} from './llm/openai-compatible-client.js';
import type { LLMGatewayProviderDispatcher } from './llm/provider-dispatcher.js';
import type { ProviderSubscriptionAccountManager } from './llm/provider-subscription-accounts.js';
import { createOperationInvocation } from './operation-composition.js';
import type { ResolvedLLMProviderConfig } from './providers/llm-config.js';
import type { ProviderCredentialConfigured } from './providers/registry.js';
import { listExportableAgentEnvironmentPackageSnapshots } from './runtime/aep-snapshot-ledger.js';
import {
  isSchedulerExecutionBusyRefusal,
  listSchedulerExecutionAttemptsForTurn,
} from './runtime/execution-attempt-records.js';
import {
  executeGoalOperation,
  type GoalOwnerServices,
  listGoalsForThread,
  readGoalView,
} from './runtime/goal-owner.js';
import {
  chatTaskModeTurnId,
  commandInputHash,
  findExactConversationWorkerOwnerReceipt,
  IdempotencyKeyConflictError,
  type InflightIdempotentCommand,
  runIdempotentCommand,
} from './runtime/idempotent-command.js';
import { hasNanoHostAttemptPreEffectProof } from './runtime/nanohost-attempt-recovery.js';
import { TurnStartValidationError } from './runtime/orchestrator.js';
import { raiseRecordedPendingRequest } from './runtime/pending-request-flow.js';
import {
  assistantPendingOutcomeSourceHash,
  frozenPendingOutcomeInput,
  isBlockingPendingRequest,
  listThreadPendingRequests,
  proveFrozenDelivery,
} from './runtime/pending-requests.js';
import {
  observeTurnAdmission,
  validateLiveProductTurnAdmission,
} from './runtime/product-turn-start.js';
import {
  createWorkerCheckpointEvidenceDiagnostics,
  getWorkerCheckpoint,
  parseWorkerCheckpointContextAssembly,
  parseWorkerCheckpointEvidence,
  updateWorkerCheckpoint,
  type WorkerCheckpointRecord,
} from './runtime/worker-checkpoints.js';
import { turnStatusForCanonicalWorkerStopReason } from './runtime/worker-control-records.js';
import {
  classifyClosedWorkerApprovalGate,
  classifyClosedWorkerUserInputGate,
  clearWorkerCheckpointAfterTerminalState,
  hasWorkerCheckpointNeverSubmittedProof,
  recoverWorkerCheckpointStopReason,
  resolveInterruptedWorkerRetryDecision,
} from './runtime/worker-recovery.js';
import { isTerminalWorkerTurnStage, workerTurnStageForStopReason } from './runtime/worker-stage.js';
import { terminalizeGovernedWorkerTurn } from './runtime/worker-turn-failure.js';
import { runWorkerTurnLoop } from './runtime/worker-turn-loop.js';
import { listWorkspaceSyncReviews } from './runtime/workspace-sync-records.js';
import {
  requireSchedulerAdmissionEntry,
  requireSchedulerExecutionAttemptAdmissionContext,
  type SchedulerWorkerStorageChoice,
  schedulerAdmissionInputHash,
} from './scheduler-records.js';
import { type CoreDb, openWorkspaceDb, type WorkspaceDb } from './storage/db.js';
import { applyScopedMigrations } from './storage/migrate.js';
import {
  artifactReferenceItemId,
  isCurrentAgentSessionStatus,
} from './storage/workspace-file-records.js';
import type { WorkspaceMutationAdmission } from './workspace-mutation-admission.js';

/** Stable attribution id for the direct Quick Chat provider call. */
export const QUICK_CHAT_AGENT_ID = 'quick-chat';

/** Maximum duration of one direct Quick Chat provider call. */
const QUICK_CHAT_TIMEOUT_MS = 30_000;
const ConversationCommandBodySchema = SubmitConversationResponseSchema.omit({
  originatingWorkspaceId: true,
  originatingThreadId: true,
  receivingWorkspaceId: true,
  receivingThreadId: true,
  targetRef: true,
  logicalModelId: true,
});
type ConversationCommandBody = z.infer<typeof ConversationCommandBodySchema>;

/** Closed Chat result kind retained by the bounded receipt. */
type ConversationCommandResultKind = ConversationCommandReceiptMetadata['resultKind'];

/** Deterministic durable Item prefix for each accepted Chat result kind. */
const CONVERSATION_RESULT_ITEM_PREFIX = {
  'knowledge-answer': 'it_chat_answer_',
  'provider-answer': 'it_chat_answer_',
  clarification: 'it_chat_clarify_',
  'task-handoff': 'it_chat_task_',
  'goal-handoff': 'it_chat_goal_',
  'worker-turn': 'it_worker_result_',
  'goal-intent': 'it_chat_goal_intent_',
  'goal-steering': 'it_steering_result_',
  refused: 'it_chat_refused_',
} satisfies Record<ConversationCommandResultKind, string>;

/** Stable downstream business-owner identifiers retained by the bounded receipt. */
type ConversationCommandDownstream = ConversationCommandReceiptMetadata['downstream'];

/** Accepted Chat Mode result plus its HTTP status. */
type ConversationCommandResult = {
  /** Public response projected from durable Chat owners. */
  readonly body: ConversationCommandBody;
  /** Stable downstream owner identifiers for handoff validation. */
  readonly downstream: ConversationCommandDownstream;
  /** Closed result kind used to reconstruct fixed response fields. */
  readonly resultKind: ConversationCommandResultKind;
  /** Existing success status for this Chat outcome. */
  readonly status: 200 | 202;
};

/**
 * Projects the selected-Worker conversation status Item from the durable Turn outcome.
 *
 * The conversation command receipt stays `accepted`; only the status Item and explanation
 * name a failed or interrupted Worker Turn. Summaries are fixed product-safe text and never
 * copy Turn.error, which may carry Worker, backend, or cleanup diagnostics.
 *
 * @param turn Durable Worker Turn after its unique terminal outcome.
 * @param agentId Selected Worker identity used by the successful continuation summary.
 * @returns Status Item fields and explanation for the live write and exact replay.
 */
function conversationWorkerTurnPresentation(
  turn: Pick<z.infer<typeof TurnSchema>, 'status'>,
  agentId: string
): {
  readonly level: 'info' | 'warning';
  readonly title: string;
  readonly summary: string;
  readonly explanation: string;
} {
  if (turn.status === 'failed') {
    return {
      level: 'warning',
      title: 'Worker Turn failed',
      summary: 'Worker turn ended without success.',
      explanation: 'The selected Worker failed the conversation Turn.',
    };
  }
  if (turn.status === 'interrupted') {
    return {
      level: 'warning',
      title: 'Worker Turn interrupted',
      summary: 'Worker turn ended without success.',
      explanation: 'The selected Worker interrupted the conversation Turn.',
    };
  }
  return {
    level: turn.status === 'completed' ? 'info' : 'warning',
    title: 'Worker Turn accepted',
    summary: `Conversation continued with ${agentId}.`,
    explanation: 'The selected Worker accepted the conversation Turn.',
  };
}

/**
 * Creates or updates the durable selected-Worker conversation status Item from the current Turn.
 *
 * The Item identity and createdAt stay fixed after the first write. Closeout and the immediate
 * failure race only refresh product-safe presentation fields through `FsStore.updateItem` when
 * those fields changed. A same-id Item with a different type or lineage is left unchanged and
 * reported as contradictory.
 *
 * @param store Store that owns the Worker Turn.
 * @param workspaceId Workspace that owns the Turn.
 * @param threadId Thread that owns the Turn.
 * @param turnId Worker Turn id.
 * @param agentId Selected Worker identity used by the successful continuation summary.
 * @returns Current status Item after create or presentation update.
 * @throws Error when an existing Item id has a contradictory type or lineage.
 */
function persistConversationWorkerResultItem(
  store: FsStore,
  workspaceId: string,
  threadId: string,
  turnId: string,
  agentId: string
) {
  const turn = store.getTurn(workspaceId, threadId, turnId);
  const presentation = conversationWorkerTurnPresentation(turn, agentId);
  const itemId = `it_worker_result_${turn.id}`;
  const existing = turn.items.find((item) => item.id === itemId);
  if (!existing) {
    const createdAt = new Date().toISOString();
    return store.createItem(
      {
        id: itemId,
        workspaceId,
        threadId,
        turnId,
        type: 'status',
        status: 'completed',
        level: presentation.level,
        title: presentation.title,
        summary: presentation.summary,
        createdAt,
        completedAt: createdAt,
      },
      DISPLAY_PROJECTION_REFRESH_ADMISSION
    );
  }
  if (
    existing.type !== 'status' ||
    existing.workspaceId !== workspaceId ||
    existing.threadId !== threadId ||
    existing.turnId !== turnId
  ) {
    throw new Error('Conversation Worker result is contradictory.');
  }
  if (
    existing.level === presentation.level &&
    existing.title === presentation.title &&
    existing.summary === presentation.summary
  ) {
    return existing;
  }
  return store.updateItem(
    itemId,
    {
      level: presentation.level,
      title: presentation.title,
      summary: presentation.summary,
    },
    DISPLAY_PROJECTION_REFRESH_ADMISSION
  );
}

/**
 * Rebuilds one accepted Chat Mode response from its command receipt and durable Turn owners.
 *
 * @param store Store that owns the original Chat Turn and Item.
 * @param repositoryWorkspaceDb Opens the Workspace database for Goal-owner validation.
 * @param workspaceId Workspace bound into the command scope.
 * @param threadId Thread bound into the command scope.
 * @param record Completed command receipt.
 * @returns Original Chat response without rerunning routing or downstream effects.
 * @throws TurnStartValidationError when the receipt and durable owners disagree.
 */
function replayConversationCommand(
  store: FsStore,
  actorId: string,
  repositoryWorkspaceDb: (workspaceId: string) => WorkspaceDb,
  workspaceId: string,
  threadId: string,
  record: CommandRequestRecord,
  coreDb?: CoreDb
): ConversationCommandResult {
  if (!record.response.conversationMetadata) {
    // A failed provider attempt has no successful result kind or result Item to replay.
    try {
      const turn = store.getTurn(workspaceId, threadId, record.response.id);
      const userItemId = `it_chat_user_${turn.id}`;
      const firstUserItem = store
        .listWorkspaceItemRevisions(workspaceId)
        .find((item) => item.id === userItemId);
      const userItem = turn.items.find((item) => item.id === userItemId);
      if (
        record.response.kind !== 'turn' ||
        turn.id !== providerChatTurnId(actorId, workspaceId, threadId, record.requestId) ||
        turn.triggerActor.kind !== 'user' ||
        turn.triggerActor.id !== actorId ||
        turn.agentId !== QUICK_CHAT_AGENT_ID ||
        turn.agentSessionId ||
        turn.status !== 'interrupted' ||
        !turn.completedAt ||
        turn.error?.code !== 'provider_call_aborted' ||
        firstUserItem?.type !== 'user-message' ||
        firstUserItem.status !== 'completed' ||
        !firstUserItem.completedAt ||
        firstUserItem.actor.kind !== 'user' ||
        firstUserItem.actor.id !== actorId ||
        firstUserItem.workspaceId !== workspaceId ||
        firstUserItem.threadId !== threadId ||
        firstUserItem.turnId !== turn.id ||
        firstUserItem.createdAt !== turn.startedAt ||
        userItem?.type !== 'user-message' ||
        userItem.actor.kind !== 'user' ||
        userItem.actor.id !== actorId ||
        userItem.status !== firstUserItem.status ||
        userItem.completedAt !== firstUserItem.completedAt ||
        userItem.createdAt !== firstUserItem.createdAt ||
        userItem.text !== firstUserItem.text ||
        turn.items.some((item) => item.type === 'assistant-message')
      )
        throw new Error('Interrupted Chat lineage is contradictory.');
    } catch {
      throw new TurnStartValidationError(
        'recovery_required',
        'The Chat command receipt does not match its durable Turn lineage.',
        409
      );
    }
    throw new TurnStartValidationError(
      'provider_call_aborted',
      'Quick chat provider call was aborted.',
      499
    );
  }
  try {
    const metadata = record.response.conversationMetadata;
    const currentTurn = store.getTurnById(record.response.id);
    const itemRevisions = store.listWorkspaceItemRevisions(workspaceId);
    if (
      currentTurn.workspaceId !== metadata.receivingWorkspaceId ||
      currentTurn.threadId !== metadata.receivingThreadId
    ) {
      throw new Error('Conversation receiving lineage is contradictory.');
    }
    if (metadata.resultKind === 'worker-turn') {
      if (
        coreDb &&
        listSchedulerExecutionAttemptsForTurn(coreDb, {
          workspaceId: currentTurn.workspaceId,
          threadId: currentTurn.threadId,
          turnId: currentTurn.id,
        }).some((attempt) => attempt.phase === 'closing')
      ) {
        throw new Error('Conversation Worker execution requires recovery.');
      }
      if (currentTurn.status === 'pending' || currentTurn.status === 'running') {
        if (!coreDb) throw new Error('Conversation Worker runtime owners are unavailable.');
        const workspaceDb = repositoryWorkspaceDb(currentTurn.workspaceId);
        try {
          const checkpoint = getWorkerCheckpoint(
            workspaceDb,
            currentTurn.workspaceId,
            currentTurn.threadId,
            currentTurn.id
          );
          const attempts = listSchedulerExecutionAttemptsForTurn(coreDb, {
            workspaceId: currentTurn.workspaceId,
            threadId: currentTurn.threadId,
            turnId: currentTurn.id,
          }).filter((attempt) => !isSchedulerExecutionBusyRefusal(attempt));
          if (
            !checkpoint ||
            checkpoint.requestId !== record.requestId ||
            checkpoint.requestInputHash !== record.inputHash ||
            isTerminalWorkerTurnStage(checkpoint.stage) ||
            attempts.some((candidate) => candidate.phase === 'closing')
          ) {
            throw new Error('Conversation Worker execution requires recovery.');
          }
          const { admission } = validateLiveProductTurnAdmission({
            coreDb,
            store,
            actorId,
            workspaceId: currentTurn.workspaceId,
            threadId: currentTurn.threadId,
            turnId: currentTurn.id,
            requestId: record.requestId,
          });
          if (
            admission.requestId !== record.requestId ||
            admission.triggerActor.kind !== 'user' ||
            admission.triggerActor.id !== actorId
          ) {
            throw new Error('Conversation Worker admission is contradictory.');
          }
        } finally {
          workspaceDb.sqlite.close();
        }
      }
      const resultItem = currentTurn.items.find(
        (item) => item.id === `it_worker_result_${currentTurn.id}`
      );
      if (
        record.response.kind !== 'turn' ||
        metadata.status !== 202 ||
        metadata.downstream?.kind !== 'task' ||
        metadata.downstream.turnId !== currentTurn.id ||
        !resultItem ||
        resultItem.type !== 'status'
      ) {
        throw new Error('Conversation Worker result is contradictory.');
      }
      const presentation = conversationWorkerTurnPresentation(
        currentTurn,
        currentTurn.agentId ?? 'the selected Worker'
      );
      if (
        resultItem.level !== presentation.level ||
        resultItem.title !== presentation.title ||
        resultItem.summary !== presentation.summary
      ) {
        throw new Error('Conversation Worker result is contradictory.');
      }
      return {
        body: ConversationCommandBodySchema.parse({
          outcome: 'accepted',
          explanation: presentation.explanation,
          turn: currentTurn,
          item: resultItem,
          handoff: null,
        }),
        downstream: metadata.downstream,
        resultKind: metadata.resultKind,
        status: metadata.status,
      };
    }
    if (metadata.resultKind === 'goal-steering') {
      const resultItem = currentTurn.items.find(
        (item) =>
          item.type === 'user-message' &&
          item.causationId === record.requestId &&
          item.actor.kind === 'user' &&
          item.actor.id === actorId
      );
      if (
        record.response.kind !== 'turn' ||
        metadata.status !== 202 ||
        metadata.downstream?.kind !== 'goal' ||
        metadata.downstream.turnId !== currentTurn.id ||
        !resultItem
      ) {
        throw new Error('Conversation Goal steering result is contradictory.');
      }
      return {
        body: ConversationCommandBodySchema.parse({
          outcome: 'accepted',
          explanation: 'The active Goal Orchestrator accepted the steering input.',
          turn: currentTurn,
          item: resultItem,
          handoff: null,
        }),
        downstream: metadata.downstream,
        resultKind: metadata.resultKind,
        status: metadata.status,
      };
    }
    const userItemId = `it_chat_user_${currentTurn.id}`;
    const resultItemId = `${CONVERSATION_RESULT_ITEM_PREFIX[metadata.resultKind]}${currentTurn.id}`;
    const userItem = itemRevisions.find((item) => item.id === userItemId);
    const resultItem = itemRevisions.find((item) => item.id === resultItemId);
    const currentUserItem = currentTurn.items.find((item) => item.id === userItemId);
    const currentResultItem = currentTurn.items.find((item) => item.id === resultItemId);

    if (
      record.response.kind !== 'turn' ||
      currentTurn.workspaceId !== workspaceId ||
      currentTurn.threadId !== threadId ||
      currentTurn.triggerActor.kind !== 'user' ||
      currentTurn.triggerActor.id !== actorId ||
      userItem?.type !== 'user-message' ||
      userItem.status !== 'completed' ||
      !userItem.completedAt ||
      userItem.actor.kind !== 'user' ||
      userItem.actor.id !== actorId ||
      userItem.workspaceId !== workspaceId ||
      userItem.threadId !== threadId ||
      userItem.turnId !== currentTurn.id ||
      resultItem?.workspaceId !== workspaceId ||
      resultItem.threadId !== threadId ||
      resultItem.turnId !== currentTurn.id ||
      currentTurn.startedAt !== userItem.createdAt ||
      resultItem.createdAt !== userItem.createdAt ||
      !currentUserItem ||
      currentUserItem.type !== 'user-message' ||
      currentUserItem.createdAt !== userItem.createdAt ||
      currentUserItem.actor.kind !== 'user' ||
      currentUserItem.actor.id !== actorId ||
      !currentResultItem ||
      currentResultItem.type !== resultItem.type ||
      currentResultItem.createdAt !== resultItem.createdAt
    ) {
      throw new Error('Chat command owner contradiction.');
    }

    if (metadata.resultKind === 'clarification') {
      if (
        metadata.status !== 202 ||
        metadata.downstream !== null ||
        resultItem.type !== 'user-input-request' ||
        resultItem.status !== 'completed' ||
        resultItem.completedAt !== resultItem.createdAt ||
        resultItem.responsibleUserId !== actorId ||
        currentResultItem.type !== 'user-input-request' ||
        currentResultItem.responsibleUserId !== actorId
      ) {
        throw new Error('Chat clarification owner contradiction.');
      }

      return {
        body: ConversationCommandBodySchema.parse({
          outcome: 'clarification-needed',
          explanation: 'The Assistant needs a concrete request before choosing a mode.',
          turn: {
            ...currentTurn,
            items: [userItem, resultItem],
          },
          item: resultItem,
          handoff: null,
        }),
        downstream: null,
        resultKind: metadata.resultKind,
        status: metadata.status,
      };
    }

    if (
      !resultItem.completedAt ||
      currentTurn.status !== 'completed' ||
      currentTurn.completedAt !== resultItem.completedAt
    ) {
      throw new Error('Chat terminal result Item is incomplete.');
    }

    let outcome: ConversationCommandBody['outcome'];
    let explanation: string;
    let handoff: ConversationCommandBody['handoff'] = null;

    if (metadata.resultKind === 'knowledge-answer' || metadata.resultKind === 'provider-answer') {
      if (
        resultItem.type !== 'assistant-message' ||
        resultItem.status !== 'completed' ||
        metadata.downstream !== null ||
        metadata.status !== 200
      ) {
        throw new Error('Chat answer owner contradiction.');
      }

      outcome = 'answered';
      explanation =
        metadata.resultKind === 'knowledge-answer'
          ? 'The Knowledge Manager answered from Workspace Knowledge.'
          : 'The Assistant answered directly.';
    } else if (metadata.resultKind === 'task-handoff') {
      if (
        resultItem.type !== 'status' ||
        resultItem.status !== 'completed' ||
        !resultItem.summary ||
        metadata.status !== 202 ||
        metadata.downstream?.kind !== 'task'
      ) {
        throw new Error('Chat Task handoff owner contradiction.');
      }

      const downstreamTurn = store.getTurnById(metadata.downstream.turnId);

      if (
        downstreamTurn.id === currentTurn.id ||
        downstreamTurn.workspaceId !== workspaceId ||
        downstreamTurn.threadId !== threadId ||
        downstreamTurn.id !==
          chatTaskModeTurnId(actorId, workspaceId, threadId, record.requestId) ||
        (!(downstreamTurn.status === 'pending' || downstreamTurn.status === 'running') &&
          !downstreamTurn.items.some(
            (item) =>
              item.id === `it_user_${downstreamTurn.id}` &&
              item.type === 'user-message' &&
              item.status === 'completed'
          ))
      ) {
        throw new Error('Chat Task downstream owner contradiction.');
      }

      if (downstreamTurn.status === 'pending' || downstreamTurn.status === 'running') {
        if (!coreDb) throw new Error('Chat Task runtime owners are unavailable.');
        const workspaceDb = repositoryWorkspaceDb(workspaceId);
        try {
          // The existing handoff checkpoint binds the Assistant's initiating text.
          validateLiveTaskAdmission({
            coreDb,
            store,
            workspaceDb,
            actorId,
            workspaceId,
            threadId,
            requestId: record.requestId,
            requestInputHash: commandInputHash({ input: userItem.text }),
            turnId: downstreamTurn.id,
          });
        } finally {
          workspaceDb.sqlite.close();
        }
      }
      outcome = 'task-handoff';
      explanation = resultItem.summary;
      handoff = { targetMode: 'task', reason: resultItem.summary, statusItemId: resultItem.id };
    } else if (metadata.resultKind === 'goal-intent') {
      if (resultItem.type !== 'status' || metadata.downstream?.kind !== 'goal')
        throw new Error('Goal intent result contradicts its receipt.');
      outcome = 'accepted';
      explanation = resultItem.summary ?? 'Goal intent revised.';
    } else if (metadata.resultKind === 'goal-handoff') {
      if (
        resultItem.type !== 'status' ||
        resultItem.status !== 'completed' ||
        !resultItem.summary ||
        metadata.status !== 202 ||
        metadata.downstream?.kind !== 'goal'
      ) {
        throw new Error('Chat Goal handoff owner contradiction.');
      }

      // Shared handoff history remains readable when its former Goal owner is absent.

      outcome = 'goal-handoff';
      explanation = resultItem.summary;
      handoff = { targetMode: 'goal', reason: resultItem.summary, statusItemId: resultItem.id };
    } else {
      if (
        resultItem.type !== 'status' ||
        resultItem.status !== 'completed' ||
        !resultItem.summary ||
        metadata.downstream !== null
      ) {
        throw new Error('Chat refusal owner contradiction.');
      }

      outcome = 'refused';
      explanation = resultItem.summary;
    }

    return {
      body: ConversationCommandBodySchema.parse({
        outcome,
        explanation,
        turn: {
          ...currentTurn,
          items: [userItem, resultItem],
        },
        item: resultItem,
        handoff,
      }),
      downstream: metadata.downstream,
      resultKind: metadata.resultKind,
      status: metadata.status,
    };
  } catch {
    throw new TurnStartValidationError(
      'recovery_required',
      'The Chat command receipt does not match its durable Turn lineage.',
      409
    );
  }
}

/** Derives the provider Chat Turn identity from its exact command scope, excluding private input. */
function providerChatTurnId(
  actorId: string,
  workspaceId: string,
  threadId: string,
  requestId: string
): string {
  return `tu_conversation_${commandInputHash({ command: 'conversation.submit', actorId, workspaceId, threadId, requestId }).slice(-24)}`;
}

/**
 * Rebuilds one accepted Task Mode response from its receipt and durable Turn owners.
 *
 * @param store Store that owns the original Task Turn and Items.
 * @param coreDb Optional Core storage needed for Goal and review owners.
 * @param repositoryWorkspaceDb Opens the Workspace database for Goal-owner validation.
 * @param workspaceId Workspace bound into the command scope.
 * @param threadId Thread bound into the command scope.
 * @param record Completed command receipt.
 * @returns Original Task response without rerunning Coordinator or downstream effects.
 * @throws TurnStartValidationError when the receipt and durable owners disagree.
 */
function replayTaskModeCommand(
  store: FsStore,
  actorId: string,
  coreDb: CoreDb | undefined,
  repositoryWorkspaceDb: (workspaceId: string) => WorkspaceDb,
  workspaceId: string,
  threadId: string,
  record: CommandRequestRecord
): StartTaskModeResponse {
  try {
    const currentTurn = store.getTurnById(record.response.id);

    if (
      record.response.kind !== 'turn' ||
      currentTurn.workspaceId !== workspaceId ||
      currentTurn.threadId !== threadId
    ) {
      throw new Error('Task command owner contradiction.');
    }

    if (currentTurn.id === directTaskModeTurnId(actorId, workspaceId, threadId, record.requestId)) {
      if (currentTurn.status === 'pending' || currentTurn.status === 'running') {
        if (!coreDb) throw new Error('Task runtime owners are unavailable.');
        const workspaceDb = repositoryWorkspaceDb(workspaceId);
        try {
          validateLiveTaskAdmission({
            coreDb,
            store,
            workspaceDb,
            actorId,
            workspaceId,
            threadId,
            requestId: record.requestId,
            requestInputHash: record.inputHash,
            turnId: currentTurn.id,
          });
          return StartTaskModeResponseSchema.parse({
            state: pendingRequestTaskState(store, workspaceDb, workspaceId, threadId, 'running'),
            turn: currentTurn,
            completion: null,
            evidence: taskModeEvidenceForTurn(
              store,
              workspaceDb,
              workspaceId,
              threadId,
              currentTurn
            ),
          });
        } finally {
          workspaceDb.sqlite.close();
        }
      }
      // A receipt published at admission cannot bypass an unfinished or contradictory closeout.
      if (coreDb) {
        const workspaceDb = repositoryWorkspaceDb(workspaceId);
        try {
          const checkpoint = getWorkerCheckpoint(
            workspaceDb,
            workspaceId,
            threadId,
            currentTurn.id
          );
          if (checkpoint)
            return recoverDirectTaskModeCheckpoint({
              coreDb,
              store,
              workspaceDb,
              workspaceId,
              threadId,
              requestId: record.requestId,
              requestInputHash: record.inputHash,
              turnId: currentTurn.id,
              checkpoint,
            });
          if (currentTurn.status === 'failed' && !currentTurn.agentSessionId)
            return recoverSessionlessTaskAdmission({
              coreDb,
              store,
              workspaceDb,
              workspaceId,
              threadId,
              turnId: currentTurn.id,
              requestId: record.requestId,
              requestInputHash: record.inputHash,
              checkpoint: null,
            });
        } finally {
          workspaceDb.sqlite.close();
        }
      }
      const initiatingItem = currentTurn.items.find(
        (item) => item.id === `it_user_${currentTurn.id}`
      );
      const closedGate =
        classifyClosedWorkerApprovalGate(store, currentTurn) ??
        classifyClosedWorkerUserInputGate(store, currentTurn);
      if (
        !closedGate &&
        currentTurn.items.some(
          (item) => item.type === 'approval-decision' || item.type === 'user-input-response'
        )
      ) {
        throw new Error('Task worker Gate owner contradiction.');
      }
      const stopReason =
        closedGate?.stopReason ?? taskModeTerminalStopReason(store, currentTurn.id);

      if (
        initiatingItem?.type !== 'user-message' ||
        initiatingItem.status !== 'completed' ||
        !stopReason ||
        currentTurn.status !== turnStatusForCanonicalWorkerStopReason(stopReason)
      ) {
        throw new Error('Task worker Turn owner contradiction.');
      }

      const workspaceDb = coreDb ? repositoryWorkspaceDb(workspaceId) : null;

      try {
        return StartTaskModeResponseSchema.parse({
          state: pendingRequestTaskState(
            store,
            workspaceDb,
            workspaceId,
            threadId,
            closedGate
              ? closedGate.stopReason === 'aborted'
                ? 'cancelled'
                : 'blocked'
              : taskModeStateForStopReason(stopReason)
          ),
          turn: currentTurn,
          completion: closedGate
            ? null
            : taskModeCompletionForTurn(store, workspaceId, threadId, currentTurn),
          evidence: taskModeEvidenceForTurn(store, workspaceDb, workspaceId, threadId, currentTurn),
        });
      } finally {
        workspaceDb?.sqlite.close();
      }
    }

    const statusItemSuffix = `_${currentTurn.id}`;
    const statusItems = currentTurn.items.filter(
      (item) =>
        item.type === 'status' &&
        item.id.startsWith('it_task_goal_') &&
        item.id.endsWith(statusItemSuffix)
    );

    const statusItem = statusItems[0];

    if (statusItems.length !== 1 || statusItem?.type !== 'status' || !coreDb) {
      throw new Error('Task escalation owner contradiction.');
    }

    const goalId = statusItem.id.slice('it_task_goal_'.length, -statusItemSuffix.length);
    const workspaceDb = repositoryWorkspaceDb(workspaceId);

    try {
      if (statusItem.status !== 'completed' || !statusItem.completedAt || !statusItem.summary)
        throw new Error('Task handoff Item contradicts its receipt.');
      return StartTaskModeResponseSchema.parse({
        state: 'escalated-to-goal',
        turn: currentTurn,
        evidence: taskModeEvidenceForTurn(store, workspaceDb, workspaceId, threadId, currentTurn),
        escalation: {
          targetMode: 'goal',
          goalId,
          reason: statusItem.summary,
        },
      });
    } finally {
      workspaceDb.sqlite.close();
    }
  } catch {
    throw new TurnStartValidationError(
      'recovery_required',
      'The Task command receipt does not match its durable owner lineage.',
      409
    );
  }
}

/**
 * Validates durable Task admission before the executor has necessarily written its input Item.
 *
 * @param input Exact command, checkpoint, Turn and scheduler owners.
 * @throws TurnStartValidationError when live admission authority is absent or contradictory.
 */
function validateLiveTaskAdmission(input: {
  readonly coreDb: CoreDb;
  readonly store: FsStore;
  readonly workspaceDb: WorkspaceDb;
  readonly actorId: string;
  readonly workspaceId: string;
  readonly threadId: string;
  readonly requestId: string;
  readonly requestInputHash: string;
  readonly turnId: string;
  readonly contextDigest?: string;
}): void {
  const checkpoint = getWorkerCheckpoint(
    input.workspaceDb,
    input.workspaceId,
    input.threadId,
    input.turnId
  );
  const { attempt, admission } = validateLiveProductTurnAdmission(input);
  if (
    !checkpoint ||
    checkpoint.requestId !== input.requestId ||
    checkpoint.requestInputHash !== input.requestInputHash ||
    checkpoint.goalId !== null ||
    checkpoint.taskId !== null ||
    checkpoint.iteration !== 0 ||
    !['preparing', 'running_worker'].includes(checkpoint.stage) ||
    checkpoint.stopReason !== null ||
    !checkpoint.contextDigest ||
    (input.contextDigest !== undefined && checkpoint.contextDigest !== input.contextDigest) ||
    parseWorkerCheckpointContextAssembly(checkpoint.diagnosticsSummary)?.contextDigest !==
      checkpoint.contextDigest ||
    (checkpoint.workerSessionId !== null && checkpoint.workerSessionId !== attempt?.agentSessionId)
  )
    throw directTaskModeRecoveryError('The Task live admission owner tuple requires recovery.');
  const workerRequest = StructuredWorkerDelegationRequestSchema.parse(
    JSON.parse(admission.turnInput)
  );
  if (commandInputHash(workerRequest) !== checkpoint.contextDigest)
    throw directTaskModeRecoveryError('The Task scheduler input contradicts its checkpoint.');
}

/**
 * Completes product publication only after the initiating mode has established its command owner.
 * @param input Existing exact checkpoint and product owners.
 * @throws Error when retained proof or a product publication is contradictory or fails.
 */
function publishCheckpointNeverSubmittedFailure(input: {
  readonly coreDb: CoreDb;
  readonly store: FsStore;
  readonly workspaceDb: WorkspaceDb;
  readonly checkpoint: WorkerCheckpointRecord;
}): void {
  if (
    !hasWorkerCheckpointNeverSubmittedProof(
      input.coreDb,
      input.store,
      input.workspaceDb,
      input.checkpoint
    )
  )
    return;
  const turn = input.store.getTurnById(input.checkpoint.turnId);
  const session = input.store.getAgentSession(input.checkpoint.workerSessionId!);
  terminalizeGovernedWorkerTurn({
    store: input.store,
    turnId: turn.id,
    agentSessionId: session.id,
    requestId: input.checkpoint.requestId,
    completedAt:
      turn.completedAt ??
      (session.status === 'failed' ? session.updatedAt : new Date().toISOString()),
    outcome: 'failed',
    errorCode: turn.error?.code ?? 'worker_governance_turn_failed',
    message: turn.error?.message ?? session.message ?? 'The worker attempt failed to start.',
  });
}

/**
 * Rebuilds one direct Task result from its exact request-bound worker checkpoint.
 *
 * @param input Direct Task command identity and durable owners.
 * @returns Current Task projection without rerunning Coordinator or the worker.
 * @throws TurnStartValidationError when the checkpoint owner tuple is incomplete.
 */
function recoverDirectTaskModeCheckpoint(input: {
  readonly coreDb: CoreDb;
  readonly store: FsStore;
  readonly workspaceDb: WorkspaceDb;
  readonly workspaceId: string;
  readonly threadId: string;
  readonly requestId: string;
  readonly requestInputHash: string;
  readonly turnId: string;
  readonly checkpoint: WorkerCheckpointRecord;
}): StartTaskModeResponse {
  const { checkpoint } = input;
  if (
    checkpoint.requestId === input.requestId &&
    checkpoint.requestInputHash !== input.requestInputHash
  ) {
    throw new IdempotencyKeyConflictError();
  }
  if (
    checkpoint.workspaceId !== input.workspaceId ||
    checkpoint.threadId !== input.threadId ||
    checkpoint.turnId !== input.turnId ||
    checkpoint.requestId !== input.requestId ||
    checkpoint.requestInputHash !== input.requestInputHash ||
    checkpoint.goalId !== null ||
    checkpoint.taskId !== null ||
    checkpoint.iteration !== 0
  ) {
    throw directTaskModeRecoveryError('The Task checkpoint contradicts its command identity.');
  }

  let turn: z.infer<typeof TurnSchema>;
  try {
    turn = input.store.getTurn(input.workspaceId, input.threadId, input.turnId);
  } catch {
    throw directTaskModeRecoveryError('The Task checkpoint is missing its worker Turn.');
  }
  if (turn.status === 'failed' && !turn.agentSessionId && checkpoint.workerSessionId === null)
    return recoverSessionlessTaskAdmission(input);
  const initiatingItem = turn.items.find((item) => item.id === `it_user_${turn.id}`);
  if (
    initiatingItem?.type !== 'user-message' ||
    initiatingItem.status !== 'completed' ||
    initiatingItem.workspaceId !== input.workspaceId ||
    initiatingItem.threadId !== input.threadId ||
    initiatingItem.turnId !== input.turnId ||
    !checkpoint.contextDigest
  ) {
    throw directTaskModeRecoveryError('The Task checkpoint is missing its worker input Item.');
  }
  try {
    const workerRequest = StructuredWorkerDelegationRequestSchema.parse(
      JSON.parse(initiatingItem.text)
    );
    if (commandInputHash(workerRequest) !== checkpoint.contextDigest) {
      throw new Error('Worker request digest mismatch.');
    }
  } catch {
    throw directTaskModeRecoveryError('The Task checkpoint worker input is not authoritative.');
  }

  publishCheckpointNeverSubmittedFailure(input);
  turn = input.store.getTurn(input.workspaceId, input.threadId, input.turnId);

  let stopReason: StopReason;
  let stage = checkpoint.stage;
  let evidence = parseWorkerCheckpointEvidence(checkpoint.diagnosticsSummary);
  const currentEvidence = taskModeEvidenceForTurn(
    input.store,
    input.workspaceDb,
    input.workspaceId,
    input.threadId,
    turn
  );
  const recoveringAcceptedFinalStatus =
    stage === 'running_worker' && checkpoint.stopReason === null;

  try {
    stopReason = recoverWorkerCheckpointStopReason(
      input.coreDb,
      input.store,
      input.workspaceDb,
      checkpoint
    );
  } catch {
    throw directTaskModeRecoveryError('The Task checkpoint has no complete worker closeout.');
  }
  if (recoveringAcceptedFinalStatus) {
    const contextAssembly = parseWorkerCheckpointContextAssembly(checkpoint.diagnosticsSummary);
    evidence = {
      itemIds: currentEvidence.itemIds,
      artifactIds: currentEvidence.artifactIds,
    };
    stage = workerTurnStageForStopReason(stopReason);
    updateWorkerCheckpoint(input.workspaceDb, {
      authorityActor: turn.triggerActor,
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      turnId: input.turnId,
      stage,
      stopReason,
      diagnosticsSummary: createWorkerCheckpointEvidenceDiagnostics(evidence, contextAssembly),
    });
  }

  if (stage !== workerTurnStageForStopReason(stopReason) || !evidence) {
    throw directTaskModeRecoveryError('The Task checkpoint contradicts its terminal outcome.');
  }

  const closedGate =
    classifyClosedWorkerApprovalGate(input.store, turn) ??
    classifyClosedWorkerUserInputGate(input.store, turn);
  if (
    (!closedGate &&
      turn.items.some(
        (item) => item.type === 'approval-decision' || item.type === 'user-input-response'
      )) ||
    (closedGate !== null &&
      (closedGate.stopReason !== stopReason ||
        !evidence.itemIds.includes(closedGate.requestItemId) ||
        !evidence.itemIds.includes(closedGate.responseItemId))) ||
    evidence.itemIds.some((itemId) => !currentEvidence.itemIds.includes(itemId)) ||
    evidence.artifactIds.some((artifactId) => !currentEvidence.artifactIds.includes(artifactId))
  ) {
    throw directTaskModeRecoveryError('The Task checkpoint evidence has no matching owner.');
  }

  return StartTaskModeResponseSchema.parse({
    state: pendingRequestTaskState(
      input.store,
      input.workspaceDb,
      input.workspaceId,
      input.threadId,
      closedGate
        ? closedGate.stopReason === 'aborted'
          ? 'cancelled'
          : 'blocked'
        : taskModeStateForStopReason(stopReason)
    ),
    turn,
    completion: closedGate
      ? null
      : taskModeCompletionForTurn(input.store, input.workspaceId, input.threadId, turn),
    evidence: currentEvidence,
  });
}

/**
 * Classifies one conversation-owned Task checkpoint or one direct task.start checkpoint after scheduler restart fencing.
 *
 * @param input Exact Core, product, Workspace, and checkpoint owners.
 * @returns `live` for queued or reconnectable work, otherwise `complete` after receipt-first cleanup.
 * @throws TurnStartValidationError when the durable owner tuple cannot prove one safe outcome.
 */
export async function classifyDirectTaskCheckpointAfterSchedulerRecovery(input: {
  readonly coreDb: CoreDb;
  readonly store: FsStore;
  readonly workspaceDb: WorkspaceDb;
  readonly checkpoint: WorkerCheckpointRecord;
}): Promise<'complete' | 'live'> {
  const { checkpoint } = input;
  const attempts = listSchedulerExecutionAttemptsForTurn(input.coreDb, {
    workspaceId: checkpoint.workspaceId,
    threadId: checkpoint.threadId,
    turnId: checkpoint.turnId,
  }).filter((attempt) => !isSchedulerExecutionBusyRefusal(attempt));
  const attempt = attempts[0];
  if (checkpoint.workerSessionId === null && attempts.length <= 1 && !attempt?.agentSessionId) {
    const entries = input.coreDb.sqlite
      .prepare('SELECT queue_entry_id AS id FROM scheduler_admission_entries WHERE turn_id = ?')
      .all(checkpoint.turnId) as { id: string }[];
    if (entries.length > 0) {
      if (entries.length !== 1)
        throw directTaskModeRecoveryError('The sessionless Task has no unique admission owner.');
      const recovered = recoverSessionlessTaskAdmission({ ...checkpoint, ...input });
      if (recovered.turn.status !== 'failed') return 'live';
      if (!(await clearWorkerCheckpointAfterTerminalState(input.workspaceDb, checkpoint)))
        throw directTaskModeRecoveryError(
          'The sessionless Task checkpoint is not ready for cleanup.'
        );
      return 'complete';
    }
  }
  if (attempts.length !== 1 || !attempt || attempt.agentSessionId !== checkpoint.workerSessionId) {
    return clearStaleDirectTaskCheckpointWithoutExactAttempt(input, attempts);
  }
  let admission: ReturnType<typeof requireSchedulerExecutionAttemptAdmissionContext>;
  try {
    admission = requireSchedulerExecutionAttemptAdmissionContext(input.coreDb, attempt.attemptId);
  } catch {
    throw directTaskModeRecoveryError('The boot Task checkpoint has no scheduler admission owner.');
  }
  if (admission.requestId !== checkpoint.requestId || admission.triggerActor.kind !== 'user') {
    throw directTaskModeRecoveryError(
      'The boot Task scheduler admission contradicts its human command identity.'
    );
  }
  const conversationOwner = findExactConversationWorkerOwnerReceipt(input.store, {
    actorId: admission.triggerActor.id,
    workspaceId: checkpoint.workspaceId,
    receivingThreadId: checkpoint.threadId,
    requestId: checkpoint.requestId,
    requestInputHash: checkpoint.requestInputHash,
    turnId: checkpoint.turnId,
  });
  if (conversationOwner) {
    if (checkpoint.goalId !== null || checkpoint.taskId !== null || checkpoint.iteration !== 0) {
      throw directTaskModeRecoveryError(
        'The boot Task checkpoint contradicts its command identity.'
      );
    }
    const conversationRetryDecision = resolveInterruptedWorkerRetryDecision(
      input.coreDb,
      input.store,
      input.workspaceDb,
      checkpoint
    );
    if (conversationRetryDecision.status === 'reconnect-pending') {
      return 'live';
    }
    const conversationTurn = input.store.getTurnById(checkpoint.turnId);
    const neverSubmitted = hasWorkerCheckpointNeverSubmittedProof(
      input.coreDb,
      input.store,
      input.workspaceDb,
      checkpoint
    );
    if (neverSubmitted) {
      const resultItem = conversationTurn.items.find(
        (item) => item.id === `it_worker_result_${conversationTurn.id}`
      );
      if (
        resultItem?.type !== 'status' ||
        resultItem.status !== 'completed' ||
        resultItem.workspaceId !== checkpoint.workspaceId ||
        resultItem.threadId !== checkpoint.threadId ||
        resultItem.turnId !== checkpoint.turnId
      )
        throw directTaskModeRecoveryError('The conversation Worker result is contradictory.');
      publishCheckpointNeverSubmittedFailure(input);
    }
    const stopReason = recoverWorkerCheckpointStopReason(
      input.coreDb,
      input.store,
      input.workspaceDb,
      checkpoint
    );
    if (neverSubmitted)
      persistConversationWorkerResultItem(
        input.store,
        checkpoint.workspaceId,
        checkpoint.threadId,
        checkpoint.turnId,
        conversationTurn.agentId!
      );
    if (checkpoint.stage === 'running_worker' && checkpoint.stopReason === null) {
      const turn = input.store.getTurn(
        checkpoint.workspaceId,
        checkpoint.threadId,
        checkpoint.turnId
      );
      const evidence = taskModeEvidenceForTurn(
        input.store,
        input.workspaceDb,
        checkpoint.workspaceId,
        checkpoint.threadId,
        turn
      );
      updateWorkerCheckpoint(input.workspaceDb, {
        authorityActor: turn.triggerActor,
        workspaceId: checkpoint.workspaceId,
        threadId: checkpoint.threadId,
        turnId: checkpoint.turnId,
        stage: workerTurnStageForStopReason(stopReason),
        stopReason,
        diagnosticsSummary: createWorkerCheckpointEvidenceDiagnostics(
          evidence,
          parseWorkerCheckpointContextAssembly(checkpoint.diagnosticsSummary)
        ),
      });
    }
    const recoveredConversationCheckpoint = getWorkerCheckpoint(
      input.workspaceDb,
      checkpoint.workspaceId,
      checkpoint.threadId,
      checkpoint.turnId
    );
    if (!recoveredConversationCheckpoint) {
      throw directTaskModeRecoveryError(
        'The boot Task checkpoint disappeared during classification.'
      );
    }
    if (recoveredConversationCheckpoint.stage === 'waiting_for_user') {
      return 'live';
    }
    if (
      !(await clearWorkerCheckpointAfterTerminalState(input.workspaceDb, {
        coreDb: input.coreDb,
        store: input.store,
        workspaceId: checkpoint.workspaceId,
        threadId: checkpoint.threadId,
        turnId: checkpoint.turnId,
      }))
    ) {
      throw directTaskModeRecoveryError('The boot Task checkpoint is not ready for cleanup.');
    }
    return 'complete';
  }
  const expectedTurnId = directTaskModeTurnId(
    admission.triggerActor.id,
    checkpoint.workspaceId,
    checkpoint.threadId,
    checkpoint.requestId
  );
  if (
    checkpoint.goalId !== null ||
    checkpoint.taskId !== null ||
    checkpoint.iteration !== 0 ||
    checkpoint.turnId !== expectedTurnId
  ) {
    throw directTaskModeRecoveryError('The boot Task checkpoint contradicts its command identity.');
  }

  const scope = {
    actorId: admission.triggerActor.id,
    workspaceId: checkpoint.workspaceId,
    threadId: checkpoint.threadId,
  };
  const receipt = input.store.getCommandRequest(
    'task.start',
    checkpoint.requestId,
    scope,
    input.workspaceDb
  );
  if (
    receipt &&
    (receipt.inputHash !== checkpoint.requestInputHash ||
      receipt.response.kind !== 'turn' ||
      receipt.response.id !== checkpoint.turnId)
  ) {
    throw directTaskModeRecoveryError('The boot Task receipt contradicts its checkpoint owner.');
  }
  const retryDecision = resolveInterruptedWorkerRetryDecision(
    input.coreDb,
    input.store,
    input.workspaceDb,
    checkpoint
  );
  if (retryDecision.status === 'reconnect-pending') {
    return 'live';
  }

  const response = recoverDirectTaskModeCheckpoint({
    coreDb: input.coreDb,
    store: input.store,
    workspaceDb: input.workspaceDb,
    workspaceId: checkpoint.workspaceId,
    threadId: checkpoint.threadId,
    requestId: checkpoint.requestId,
    requestInputHash: checkpoint.requestInputHash,
    turnId: checkpoint.turnId,
    checkpoint,
  });
  const recoveredCheckpoint = getWorkerCheckpoint(
    input.workspaceDb,
    checkpoint.workspaceId,
    checkpoint.threadId,
    checkpoint.turnId
  );
  if (!recoveredCheckpoint) {
    throw directTaskModeRecoveryError(
      'The boot Task checkpoint disappeared during classification.'
    );
  }
  if (recoveredCheckpoint.stage === 'waiting_for_user' && response.state !== 'awaiting-human') {
    throw directTaskModeRecoveryError('The active Task Gate contradicts its Task projection.');
  }
  if (!hasClosedDirectTaskGateReceipt(input.store, TurnSchema.parse(response.turn))) {
    throw directTaskModeRecoveryError('The closed Task Gate has no response command receipt.');
  }
  if (!receipt) {
    input.store.recordCommandRequest(
      {
        command: 'task.start',
        requestId: checkpoint.requestId,
        scope,
        inputHash: checkpoint.requestInputHash,
        response: { kind: 'turn', id: checkpoint.turnId },
      },
      input.workspaceDb
    );
  }
  if (recoveredCheckpoint.stage === 'waiting_for_user') {
    return 'live';
  }
  if (
    !(await clearWorkerCheckpointAfterTerminalState(input.workspaceDb, {
      coreDb: input.coreDb,
      store: input.store,
      workspaceId: checkpoint.workspaceId,
      threadId: checkpoint.threadId,
      turnId: checkpoint.turnId,
    }))
  ) {
    throw directTaskModeRecoveryError('The boot Task checkpoint is not ready for cleanup.');
  }
  return 'complete';
}

/**
 * Recovers accepted Task admission before any AgentSession or native execution exists.
 *
 * Scheduler input is authoritative before the executor publishes its input Item.
 * A failed preparation closes only with its original receipt and complete canonical failure proof; missing or contradictory execution owners remain inspectable.
 * After checkpoint collection, replay validates the retained admission, receipt, canonical failure and execution absence without synthesizing checkpoint or session authority.
 *
 * @param input Exact Core, product, Workspace and checkpoint owners.
 * @returns Current Task projection; a retained preparing checkpoint is projected failed only after complete proof.
 * @throws TurnStartValidationError when admission, execution absence or terminal proof conflicts.
 */
function recoverSessionlessTaskAdmission(input: {
  readonly coreDb: CoreDb;
  readonly store: FsStore;
  readonly workspaceDb: WorkspaceDb;
  readonly checkpoint: WorkerCheckpointRecord | null;
  readonly workspaceId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly requestId: string;
  readonly requestInputHash: string;
}): StartTaskModeResponse {
  const { checkpoint } = input;
  const entries = input.coreDb.sqlite
    .prepare('SELECT queue_entry_id AS id FROM scheduler_admission_entries WHERE turn_id = ?')
    .all(input.turnId) as { id: string }[];
  const attempts = listSchedulerExecutionAttemptsForTurn(input.coreDb, input).filter(
    (attempt) => !isSchedulerExecutionBusyRefusal(attempt)
  );
  if (entries.length !== 1 || attempts.length > 1)
    throw directTaskModeRecoveryError('The sessionless Task has no unique admission owner.');
  const admission = requireSchedulerAdmissionEntry(input.coreDb, entries[0]!.id);
  let turn: ReturnType<FsStore['getTurn']>;
  try {
    turn = input.store.getTurn(input.workspaceId, input.threadId, input.turnId);
  } catch {
    throw directTaskModeRecoveryError('The Task checkpoint is missing its worker Turn.');
  }
  const attempt = attempts[0];
  const workerRequest = StructuredWorkerDelegationRequestSchema.parse(
    JSON.parse(admission.turnInput)
  );
  const context = checkpoint
    ? parseWorkerCheckpointContextAssembly(checkpoint.diagnosticsSummary)
    : null;
  if (
    (checkpoint !== null &&
      (checkpoint.goalId !== null ||
        checkpoint.taskId !== null ||
        checkpoint.iteration !== 0 ||
        checkpoint.workerSessionId !== null ||
        checkpoint.workspaceId !== input.workspaceId ||
        checkpoint.threadId !== input.threadId ||
        checkpoint.turnId !== input.turnId ||
        checkpoint.requestId !== input.requestId ||
        checkpoint.requestInputHash !== input.requestInputHash ||
        !checkpoint.contextDigest ||
        context?.contextDigest !== checkpoint.contextDigest ||
        commandInputHash(workerRequest) !== checkpoint.contextDigest)) ||
    turn.agentSessionId ||
    admission.workspaceId !== input.workspaceId ||
    admission.threadId !== input.threadId ||
    admission.turnId !== input.turnId ||
    admission.requestId !== input.requestId ||
    admission.inputHash !== schedulerAdmissionInputHash(admission) ||
    admission.triggerActor.kind !== 'user' ||
    turn.triggerActor.kind !== 'user' ||
    admission.triggerActor.id !== turn.triggerActor.id ||
    admission.requestedAgentId !== turn.agentId ||
    (attempt &&
      (attempt.queueEntryId !== admission.queueEntryId ||
        attempt.backendId !== admission.backendId ||
        attempt.agentSessionId !== null ||
        attempt.phase === 'closing' ||
        attempt.disposition !== 'not_accepted' ||
        attempt.operationId !== null ||
        attempt.inputRef !== null ||
        attempt.bindingRef !== null ||
        attempt.deadline !== null ||
        attempt.outcomeRef !== null ||
        attempt.fenceRef !== null ||
        !hasNanoHostAttemptPreEffectProof(input.coreDb, attempt.attemptId)))
  )
    throw directTaskModeRecoveryError(
      'The sessionless Task admission owner tuple requires recovery.'
    );
  const initiatingItem = turn.items.find((item) => item.id === `it_user_${turn.id}`);
  if (
    initiatingItem &&
    (initiatingItem.type !== 'user-message' ||
      initiatingItem.status !== 'completed' ||
      initiatingItem.workspaceId !== input.workspaceId ||
      initiatingItem.threadId !== input.threadId ||
      initiatingItem.turnId !== input.turnId ||
      initiatingItem.text !== admission.turnInput)
  )
    throw directTaskModeRecoveryError('The sessionless Task input contradicts its admission.');
  const scope = {
    actorId: admission.triggerActor.id,
    workspaceId: input.workspaceId,
    threadId: input.threadId,
  };
  const directReceipt = input.store.getCommandRequest(
    'task.start',
    input.requestId,
    scope,
    input.workspaceDb
  );
  const conversationReceipt = findExactConversationWorkerOwnerReceipt(input.store, {
    actorId: admission.triggerActor.id,
    workspaceId: input.workspaceId,
    receivingThreadId: input.threadId,
    requestId: input.requestId,
    requestInputHash: input.requestInputHash,
    turnId: input.turnId,
  });
  if (
    directReceipt
      ? conversationReceipt !== null ||
        directReceipt.inputHash !== input.requestInputHash ||
        directReceipt.response.kind !== 'turn' ||
        directReceipt.response.id !== input.turnId ||
        input.turnId !==
          directTaskModeTurnId(scope.actorId, scope.workspaceId, scope.threadId, input.requestId)
      : !conversationReceipt
  )
    throw directTaskModeRecoveryError(
      'The sessionless Task has no exact initiating command receipt.'
    );

  // Null session alone is not absence proof: retained package, control or backend owners contradict it.
  const executionOwner = input.coreDb.sqlite
    .prepare(`
    SELECT 1 FROM scheduler_execution_attempts WHERE turn_id = @turn AND (workspace_id <> @workspace OR thread_id <> @thread)
    UNION ALL SELECT 1 FROM worker_backend_sessions WHERE turn_id = @turn
    UNION ALL SELECT 1 FROM worker_control_records WHERE turn_id = @turn
    UNION ALL SELECT 1 FROM worker_control_rejected_evidence WHERE turn_id = @turn
    UNION ALL SELECT 1 FROM worker_control_sequence_fingerprints WHERE turn_id = @turn
    UNION ALL SELECT 1 FROM agent_session_runtime_bindings WHERE current_turn_id = @turn
    LIMIT 1`)
    .get({
      turn: input.turnId,
      workspace: input.workspaceId,
      thread: input.threadId,
    });
  if (
    executionOwner ||
    listExportableAgentEnvironmentPackageSnapshots(input.workspaceDb, input.workspaceId).some(
      (record) => record.turnId === input.turnId
    )
  )
    throw directTaskModeRecoveryError('The sessionless Task has contradictory execution evidence.');

  if (
    turn.status === 'pending' &&
    checkpoint?.stage === 'preparing' &&
    checkpoint.stopReason === null
  ) {
    validateLiveTaskAdmission({
      ...input,
      ...scope,
    });
    return StartTaskModeResponseSchema.parse({
      state: pendingRequestTaskState(
        input.store,
        input.workspaceDb,
        input.workspaceId,
        input.threadId,
        'running'
      ),
      turn,
      completion: null,
      evidence: taskModeEvidenceForTurn(
        input.store,
        input.workspaceDb,
        input.workspaceId,
        input.threadId,
        turn
      ),
    });
  }
  const terminalEvents = input.store
    .getTurnEvents(input.turnId)
    .filter((event) => event.event === 'turn.completed');
  const terminal = terminalEvents[0];
  if (
    turn.status !== 'failed' ||
    !turn.completedAt ||
    !turn.error ||
    typeof turn.error.code !== 'string' ||
    !['worker_preparation_failed', 'turn_start_failed'].includes(turn.error.code) ||
    (attempt
      ? attempt.phase !== 'closed' ||
        attempt.terminalCause !== 'turn-start-failed' ||
        admission.status !== 'admitted'
      : !['denied', 'cancelled'].includes(admission.status)) ||
    (checkpoint !== null &&
      !(
        (checkpoint.stage === 'preparing' && checkpoint.stopReason === null) ||
        (checkpoint.stage === 'failed' && checkpoint.stopReason === 'error')
      )) ||
    terminalEvents.length !== 1 ||
    terminal?.data.type !== 'turn-completed' ||
    terminal.data.stopReason !== 'error' ||
    terminal.requestId !== input.requestId ||
    terminal.workspaceId !== input.workspaceId ||
    terminal.threadId !== input.threadId ||
    terminal.turnId !== input.turnId ||
    terminal.data.turn.id !== turn.id ||
    terminal.data.turn.workspaceId !== turn.workspaceId ||
    terminal.data.turn.threadId !== turn.threadId ||
    terminal.data.turn.agentSessionId ||
    terminal.data.turn.status !== 'failed' ||
    terminal.data.turn.completedAt !== turn.completedAt ||
    terminal.data.turn.agentId !== turn.agentId ||
    commandInputHash(terminal.data.turn.triggerActor) !== commandInputHash(turn.triggerActor) ||
    commandInputHash(terminal.data.turn.error) !== commandInputHash(turn.error)
  )
    throw directTaskModeRecoveryError(
      'The sessionless Task has no complete pre-effect failure proof.'
    );
  const evidence = taskModeEvidenceForTurn(
    input.store,
    input.workspaceDb,
    input.workspaceId,
    input.threadId,
    turn
  );
  const recorded = checkpoint ? parseWorkerCheckpointEvidence(checkpoint.diagnosticsSummary) : null;
  if (
    evidence.artifactIds.length > 0 ||
    (checkpoint?.stage === 'failed' && !recorded) ||
    recorded?.itemIds.some((id) => !evidence.itemIds.includes(id)) ||
    recorded?.artifactIds.some((id) => !evidence.artifactIds.includes(id))
  )
    throw directTaskModeRecoveryError(
      'The sessionless Task failure evidence contradicts its owners.'
    );
  if (checkpoint?.stage === 'preparing')
    updateWorkerCheckpoint(input.workspaceDb, {
      authorityActor: turn.triggerActor,
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      turnId: input.turnId,
      stage: 'failed',
      stopReason: 'error',
      diagnosticsSummary: createWorkerCheckpointEvidenceDiagnostics(evidence, context),
    });
  return StartTaskModeResponseSchema.parse({
    state: pendingRequestTaskState(
      input.store,
      input.workspaceDb,
      input.workspaceId,
      input.threadId,
      'failed'
    ),
    turn,
    completion: taskModeCompletionForTurn(input.store, input.workspaceId, input.threadId, turn),
    evidence,
  });
}

/**
 * Clears one terminal Task checkpoint that no longer has a matching execution attempt.
 *
 * A live, interrupted, missing-Turn, or contradictory owner tuple stays fail-closed.
 * Only an already collectable terminal Turn permits checkpoint cleanup here.
 * A null-session checkpoint whose sole attempt proves a failed start skips runtime provenance; every other attempt tuple keeps that check.
 *
 * @param input Exact Core, product, Workspace, and checkpoint owners.
 * @param attempts execution attempts for the checkpoint Turn, which are already not an exact match.
 * @returns `complete` after terminal checkpoint cleanup.
 * @throws TurnStartValidationError when the leftover cannot be proved terminal and without held execution.
 */
async function clearStaleDirectTaskCheckpointWithoutExactAttempt(
  input: {
    readonly coreDb: CoreDb;
    readonly store: FsStore;
    readonly workspaceDb: WorkspaceDb;
    readonly checkpoint: WorkerCheckpointRecord;
  },
  attempts: ReturnType<typeof listSchedulerExecutionAttemptsForTurn>
): Promise<'complete'> {
  const { checkpoint } = input;
  if (!isTerminalWorkerTurnStage(checkpoint.stage)) {
    throw directTaskModeRecoveryError('The boot Task checkpoint has no exact execution attempt.');
  }
  if (attempts.some((candidate) => candidate.phase !== 'closed')) {
    throw directTaskModeRecoveryError(
      'The boot Task checkpoint still has a live execution attempt.'
    );
  }
  if (attempts.length > 1) {
    throw directTaskModeRecoveryError('The boot Task checkpoint has no exact execution attempt.');
  }
  const leftoverAttempt = attempts[0];
  if (
    leftoverAttempt &&
    checkpoint.workerSessionId !== null &&
    leftoverAttempt.agentSessionId !== checkpoint.workerSessionId
  ) {
    throw directTaskModeRecoveryError('The boot Task checkpoint has no exact execution attempt.');
  }
  if (checkpoint.goalId !== null || checkpoint.taskId !== null || checkpoint.iteration !== 0) {
    throw directTaskModeRecoveryError('The boot Task checkpoint contradicts its command identity.');
  }

  let turn: ReturnType<FsStore['getTurn']>;
  try {
    turn = input.store.getTurn(checkpoint.workspaceId, checkpoint.threadId, checkpoint.turnId);
  } catch {
    throw directTaskModeRecoveryError('The Task checkpoint is missing its worker Turn.');
  }
  // Interrupted Turns are sealed terminals whose checkpoint recovery may still have an owner.
  if (turn.status === 'interrupted') {
    throw directTaskModeRecoveryError(
      'The boot Task checkpoint has a terminal interrupted Turn with unresolved checkpoint recovery.'
    );
  }
  if (!isCheckpointCollectableTurnStatus(turn.status)) {
    throw directTaskModeRecoveryError('The boot Task checkpoint still has a live product Turn.');
  }
  if (
    checkpoint.workerSessionId !== null &&
    turn.agentSessionId &&
    turn.agentSessionId !== checkpoint.workerSessionId
  ) {
    throw directTaskModeRecoveryError('The boot Task checkpoint has no exact AgentSession owner.');
  }

  const provedTurnStartFailureWithoutSession =
    checkpoint.workerSessionId === null &&
    leftoverAttempt?.phase === 'closed' &&
    leftoverAttempt.disposition === 'not_accepted' &&
    leftoverAttempt.operationId === null &&
    leftoverAttempt.terminalCause !== null;
  if (
    !(await clearWorkerCheckpointAfterTerminalState(input.workspaceDb, {
      workspaceId: checkpoint.workspaceId,
      threadId: checkpoint.threadId,
      turnId: checkpoint.turnId,
      ...(provedTurnStartFailureWithoutSession ? { skipRuntimeProvenance: true } : {}),
    }))
  ) {
    throw directTaskModeRecoveryError('The boot Task checkpoint is not ready for cleanup.');
  }
  return 'complete';
}

/**
 * Checks whether a closed direct Task Gate retained its exact response command receipt.
 *
 * @param store Product store containing Gate receipts.
 * @param turn Direct Task Turn returned by owner recovery.
 * @returns True for a non-Gate outcome or one exact receipt-backed Gate closure.
 */
function hasClosedDirectTaskGateReceipt(store: FsStore, turn: z.infer<typeof TurnSchema>): boolean {
  const approval = classifyClosedWorkerApprovalGate(store, turn);
  if (approval) {
    const request = turn.items.find((item) => item.id === approval.requestItemId);
    if (request?.type !== 'approval-request') {
      return false;
    }
    const receipt = store.getCommandRequest('approval.respond', approval.responseRequestId, {
      workspaceId: turn.workspaceId,
      threadId: turn.threadId,
      turnId: turn.id,
      approvalRequestId: request.approvalRequestId,
    });
    return (
      receipt?.response.kind === 'approval' && receipt.response.id === request.approvalRequestId
    );
  }

  const userInput = classifyClosedWorkerUserInputGate(store, turn);
  if (!userInput) {
    return true;
  }
  const receipt = store.getCommandRequest('turn.input.submit', userInput.responseRequestId, {
    workspaceId: turn.workspaceId,
    threadId: turn.threadId,
    turnId: turn.id,
  });
  return receipt?.response.kind === 'turn' && receipt.response.id === turn.id;
}

/**
 * Creates the strict recovery error shared by direct Task replay and closeout.
 *
 * @param message Product-safe owner contradiction.
 * @returns Typed recovery-required error.
 */
function directTaskModeRecoveryError(message: string): TurnStartValidationError {
  return new TurnStartValidationError('recovery_required', message, 409);
}

/**
 * Derives one direct Task Turn id from the complete command identity.
 *
 * @param actorId Authenticated actor id.
 * @param workspaceId Workspace command scope.
 * @param threadId Thread command scope.
 * @param requestId Caller-supplied command request id.
 * @returns Stable direct Task worker Turn id.
 */
function directTaskModeTurnId(
  actorId: string,
  workspaceId: string,
  threadId: string,
  requestId: string
): string {
  const suffix = commandInputHash({
    command: 'task.start',
    actorId,
    workspaceId,
    threadId,
    requestId,
  }).slice(-16);
  return `turn_${requestId}_${suffix}`;
}

/**
 * Clears caller-inaccessible Goal lineage from one direct Task storage admission.
 *
 * @param choice Public retained-storage choice for the Task command.
 * @returns Scheduler choice bound to direct Task lineage.
 */
function directTaskWorkerStorageChoice(
  choice: WorkerEnvironmentStorageChoice | undefined
): SchedulerWorkerStorageChoice | undefined {
  if (!choice) return undefined;
  if (choice.kind === 'fresh') return { kind: 'fresh', goalId: null, taskId: null };
  return { ...choice, goalId: null, taskId: null };
}

/**
 * Builds the canonical conversation.submit input hashed for idempotency and Worker checkpoint identity.
 *
 * @param chatInput Parsed conversation submission.
 * @returns Closed command input used for hashing.
 */
function conversationCommandInput(chatInput: {
  readonly input: string;
  readonly targetRef: string;
  readonly logicalModelId?: string | undefined;
  readonly reasoningEffort?: z.infer<typeof TurnSchema>['reasoningEffort'];
  readonly artifactRefs: unknown;
  readonly workerStorageChoice?: WorkerEnvironmentStorageChoice | undefined;
}) {
  return {
    artifactRefs: chatInput.artifactRefs,
    input: chatInput.input,
    logicalModelId: chatInput.logicalModelId ?? null,
    ...(chatInput.reasoningEffort !== undefined
      ? { reasoningEffort: chatInput.reasoningEffort }
      : {}),
    targetRef: chatInput.targetRef,
    workerStorageChoice: chatInput.workerStorageChoice,
  };
}

/**
 * Returns whether the selected conversation target may carry a Worker storage choice.
 *
 * @param kind Accepted conversation target kind.
 * @returns Whether structured submit may forward a Worker storage choice.
 */
function conversationTargetAcceptsWorkerStorageChoice(
  kind: z.infer<typeof ConversationTargetCatalogSchema>['targets'][number]['kind']
): boolean {
  return kind === 'warm-worker' || kind === 'new-task-worker';
}

/**
 * Detects one Chat-subordinate worker checkpoint whose owning Chat receipt is absent.
 *
 * @param store Store that owns the outer Chat command receipt.
 * @param workspaceDb Workspace database that owns the worker checkpoint.
 * @param actorId Authenticated actor id.
 * @param workspaceId Workspace command scope.
 * @param threadId Thread command scope.
 * @param requestId Caller-supplied Chat command request id.
 * @returns Whether the exact checkpoint exists without its outer receipt.
 */
function hasChatTaskCheckpointWithoutReceipt(
  store: FsStore,
  workspaceDb: WorkspaceDb,
  actorId: string,
  workspaceId: string,
  threadId: string,
  requestId: string
): boolean {
  const turnId = chatTaskModeTurnId(actorId, workspaceId, threadId, requestId);
  return (
    getWorkerCheckpoint(workspaceDb, workspaceId, threadId, turnId) !== null &&
    store.getCommandRequest('conversation.submit', requestId, {
      actorId,
      workspaceId,
      threadId,
    }) === null
  );
}

/**
 * Derives one canonical UUID-shaped S61 trace id from the complete direct Task command identity.
 *
 * @param actorId Authenticated actor id.
 * @param workspaceId Workspace command scope.
 * @param threadId Thread command scope.
 * @param requestId Caller-supplied command request id.
 * @returns Stable server-owned S61 retrieval trace id.
 */
function directTaskKnowledgeRetrievalTraceId(
  actorId: string,
  workspaceId: string,
  threadId: string,
  requestId: string
): string {
  const digest = commandInputHash({
    command: 'task.start.knowledge-retrieval',
    actorId,
    workspaceId,
    threadId,
    requestId,
  }).slice('sha256:'.length);
  const variant = ((Number.parseInt(digest[16] ?? '0', 16) & 0x3) | 0x8).toString(16);
  const uuid = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-${variant}${digest.slice(17, 20)}-${digest.slice(20, 32)}`;

  return `krt_${uuid}`;
}

/**
 * Builds the first V1 Task Mode delegation decision from the rule-based Worker Coordinator.
 *
 * @param input Task Mode request context.
 * @returns Coordinator decision plus the public Task Mode projection when launchable.
 */
function createTaskModeDelegation(input: {
  /** Trusted selection made by the owning mode entry, never inferred from the prompt. */
  readonly entryIntent: 'explicit_task' | 'conversation';
  /** Store that owns workspace resources. */
  readonly store: FsStore;
  /** Workspace id for the task. */
  readonly workspaceId: string;
  /** Thread id for the task. */
  readonly threadId: string;
  /** User task prompt. */
  readonly prompt: string;
  /** Resolves ready worker candidates for the workspace. */
  readonly workerCoordinatorCandidates: (
    store: FsStore,
    workspaceId: string
  ) => WorkerCoordinatorCandidate[];
}): { coordinator: WorkerCoordinatorDecision; taskDecision: TaskDelegationDecision | null } {
  const coordinatorInput = {
    entryIntent: input.entryIntent,
    prompt: input.prompt,
    readiness: input.workerCoordinatorCandidates(input.store, input.workspaceId),
    threadState: { status: 'idle', threadId: input.threadId },
    workspaceSummary: {
      name: input.store.getWorkspace(input.workspaceId).name,
      workspaceId: input.workspaceId,
    },
  } as const;
  const coordinator = createWorkerCoordinatorDecision(coordinatorInput);

  if (
    coordinator.decision !== 'worker_turn' ||
    !coordinator.selectedWorkerCandidate ||
    !coordinator.workerRequest ||
    coordinator.requiredUserAction !== 'none'
  ) {
    return { coordinator, taskDecision: null };
  }

  return {
    coordinator,
    taskDecision: {
      mode: 'task',
      sourceAgentId: 'worker-coordinator',
      worker: {
        agentId: coordinator.selectedWorkerCandidate.agentId,
        displayName: coordinator.selectedWorkerCandidate.displayName,
      },
      confidence: coordinator.confidence,
      rationale: coordinator.explanation,
      requiredApprovals: [],
      expectedStopCondition: 'one bounded worker turn',
      escalationRecommended: false,
      contextRefs: coordinator.workerRequest.contextRefs,
    },
  };
}

/**
 * Returns true when Chat Mode needs one bounded clarification before routing.
 *
 * @param prompt User prompt.
 * @returns Whether the prompt is too vague to answer or hand off safely.
 */
function isClarificationChatPrompt(prompt: string): boolean {
  const normalized = prompt
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/g, '');

  return [
    'help',
    'help me',
    'please help',
    'can you help',
    'can you help me',
    'can you help with this',
    'i need help',
    'help with this',
    'what should i do',
    'what do i do',
    'do it',
    'do something',
    'start',
    'continue',
    'go',
  ].includes(normalized);
}

/**
 * Returns true when Chat Mode is being asked to perform explicit external search or browsing.
 *
 * @param prompt User prompt.
 * @returns Whether the prompt asks for unavailable external search or browsing.
 */
function isExternalSearchChatPrompt(prompt: string): boolean {
  const text = prompt.trim();
  return (
    /(?:\bsearch\s+(?:the\s+)?(?:web|internet)\b|\b(?:web|internet)\s+search\b|\bsearch\s+online\b|\bbrowse\s+(?:the\s+)?(?:web|internet)\b|\bbrowse\s+(?:an\s+)?external\s+(?:url|site)\b|\bbrowse\s+https?:\/\/|\blook\s+up(?:\s+\S+)*\s+online\b|\blook\s+up\s+(?:on\s+)?(?:google|(?:the\s+)?(?:web|internet))\b)/i.test(
      text
    ) ||
    /^(?:(?:please|can you)\s+)?google\s+(?:for\s+|search\s+|(?!is\b|are\b|was\b|were\b)\S+)/i.test(
      text
    )
  );
}

/**
 * Returns true when a Quick Chat prompt is asking for project-bound work.
 *
 * @param prompt User prompt.
 * @returns Whether the prompt should require a project workspace.
 */
function isProjectWorkChatPrompt(prompt: string): boolean {
  return /\b(implement|fix|edit|change|modify|patch|refactor|build|ship|worker|task mode|goal mode|repository|repo|git|commit|push)\b/i.test(
    prompt
  );
}

/**
 * Maps a protocol turn status to the Task Mode attempt state vocabulary.
 *
 * @param status Stored turn status.
 * @returns Task Mode attempt state.
 */
function pendingRequestTaskState(
  store: FsStore,
  workspaceDb: { sqlite: import('better-sqlite3').Database } | null,
  workspaceId: string,
  threadId: string,
  fallback: 'awaiting-human' | 'blocked' | 'cancelled' | 'completed' | 'failed' | 'running'
) {
  const turns = store.listThreadTurns(workspaceId, threadId);
  if (turns.some((turn) => turn.status === 'running')) return 'running';
  if (turns.some((turn) => turn.status === 'pending')) return 'queued';
  if (
    workspaceDb &&
    listThreadPendingRequests(workspaceDb.sqlite, workspaceId, threadId).some((record) =>
      isBlockingPendingRequest(record, turns)
    )
  ) {
    return 'awaiting-human';
  }
  return fallback;
}

function taskModeStateForTurn(status: z.infer<typeof TurnSchema>['status']) {
  switch (status) {
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'interrupted':
      return 'blocked';
    default:
      return 'running';
  }
}

/**
 * Maps a canonical worker stop reason to the Task Mode state vocabulary.
 *
 * @param stopReason Canonical terminal worker outcome.
 * @returns Task Mode state owned by that outcome.
 */
function taskModeStateForStopReason(stopReason: StopReason) {
  if (stopReason === 'aborted') return 'cancelled';
  return stopReason === 'length' || stopReason === 'budget_exhausted'
    ? 'blocked'
    : taskModeStateForTurn(turnStatusForCanonicalWorkerStopReason(stopReason));
}

/**
 * Reads the unique durable worker outcome or exact active human Gate for one Task Turn.
 *
 * @param store Store that owns the Turn event stream.
 * @param turnId Worker Turn id.
 * @returns Canonical stop reason, or null when durable outcome evidence is absent or ambiguous.
 */
function taskModeTerminalStopReason(store: FsStore, turnId: string): StopReason | null {
  const terminalEvents = store
    .getTurnEvents(turnId)
    .filter((event) => event.event === 'turn.completed' && event.data.type === 'turn-completed');

  if (terminalEvents.length > 1) {
    return null;
  }
  const terminalEvent = terminalEvents[0];
  const eventStopReason =
    terminalEvent?.data.type === 'turn-completed' ? terminalEvent.data.stopReason : null;
  return eventStopReason;
}

/**
 * Projects the final assistant item for a completed Task Mode worker attempt.
 *
 * @param store Store that owns the thread items.
 * @param workspaceId Workspace that owns the task thread.
 * @param threadId Thread that owns the task turn.
 * @param turn Turn whose assistant result should be projected.
 * @returns Final assistant item summary, or null when the turn has not produced one.
 */
function taskModeCompletionForTurn(
  store: FsStore,
  workspaceId: string,
  threadId: string,
  turn: z.infer<typeof TurnSchema>
): { readonly itemId: string; readonly text: string } | null {
  if (turn.status !== 'completed') {
    return null;
  }

  let completion: { readonly itemId: string; readonly text: string } | null = null;

  for (const item of store.listThreadItems(workspaceId, threadId)) {
    if (
      item.turnId === turn.id &&
      item.type === 'assistant-message' &&
      item.status === 'completed'
    ) {
      completion = {
        itemId: item.id,
        text: item.text,
      };
    }
  }

  return completion;
}

/**
 * Projects existing thread item and artifact references that evidence one Task Mode attempt.
 *
 * @param store Store that owns the thread items.
 * @param workspaceDb Optional workspace database used to link staged workspace reviews.
 * @param workspaceId Workspace that owns the task thread.
 * @param threadId Thread that owns the task turn.
 * @param turn Turn whose visible records should be projected.
 * @returns Existing item, artifact, and review ids for callers to read through stable APIs.
 */
function taskModeEvidenceForTurn(
  store: FsStore,
  workspaceDb: WorkspaceDb | null,
  workspaceId: string,
  threadId: string,
  turn: z.infer<typeof TurnSchema>
): TaskModeEvidence {
  const itemIds: string[] = [];
  const artifactIds = new Set<string>();

  for (const item of store.listThreadItems(workspaceId, threadId)) {
    if (item.turnId !== turn.id) {
      continue;
    }

    itemIds.push(item.id);

    if (item.type === 'artifact-reference') {
      artifactIds.add(item.artifactId);
    }
  }

  for (const artifact of store.listArtifacts(workspaceId)) {
    if (artifact.turnId === turn.id) {
      artifactIds.add(artifact.id);
    }
  }

  const reviewIds = workspaceDb
    ? listWorkspaceSyncReviews(workspaceDb, workspaceId)
        .filter((review) => artifactIds.has(review.artifactId))
        .map((review) => review.review.id)
    : [];

  return { itemIds, artifactIds: [...artifactIds], reviewIds };
}

/**
 * Supplies the existing direct Quick Chat and conversation entry owners.
 *
 * @param dependencies Existing domain and app composition callbacks.
 * @returns Conversation commands and explicit interrupt and pending-input controls.
 */
export function createConversationService({
  assertProjectWorkspace,
  coreDb,
  inflightCommands,
  workspaceMutationAdmission,
  llmGatewayDispatcher,
  providerSubscriptionAccountManager,
  providerCredentialConfigured,
  repositoryWorkspaceDb,
  resolveGatewayProvider,
  runtimeConfig,
  startModeWorkerTurn,
  workerCoordinatorCandidates,
  goalServices,
}: {
  readonly assertProjectWorkspace: (
    workspace: ReturnType<FsStore['getWorkspace']>,
    action: string
  ) => void;
  readonly coreDb: CoreDb | undefined;
  readonly workspaceMutationAdmission: WorkspaceMutationAdmission;
  readonly inflightCommands: WeakMap<FsStore, Map<string, InflightIdempotentCommand>>;
  readonly llmGatewayDispatcher: Pick<LLMGatewayProviderDispatcher, 'createChatCompletion'>;
  readonly providerSubscriptionAccountManager?: ProviderSubscriptionAccountManager;
  /** Current API-key presence without resolving Vault material. */
  readonly providerCredentialConfigured?: ProviderCredentialConfigured;
  readonly repositoryWorkspaceDb: (workspaceId: string) => WorkspaceDb;
  readonly resolveGatewayProvider: (providerId: string, model: string) => ResolvedLLMProviderConfig;
  readonly runtimeConfig: () => RuntimeConfigSnapshot;
  readonly startModeWorkerTurn: (input: {
    readonly triggerActor: ActorRef;
    readonly requestActor?: Actor;
    readonly store: FsStore;
    readonly workspaceId: string;
    readonly threadId: string;
    readonly prompt: string;
    readonly modelId?: string | undefined;
    readonly profileId?: string | undefined;
    /** Explicit submission preference forwarded to canonical Turn admission. */
    readonly reasoningEffort?: z.infer<typeof TurnSchema>['reasoningEffort'];
    readonly requestId: string;
    readonly requestedAgentId: string;
    readonly reservedTurnId?: string | undefined;
    readonly workerStorageChoice?: SchedulerWorkerStorageChoice;
    readonly onTurnCreated?: (
      turn: z.infer<typeof TurnSchema>,
      agentSessionId: string | null
    ) => void;
  }) => Promise<z.infer<typeof TurnSchema>>;
  readonly goalServices?: () => GoalOwnerServices;
  readonly workerCoordinatorCandidates: (
    store: FsStore,
    workspaceId: string
  ) => WorkerCoordinatorCandidate[];
}) {
  // App-local handoff execution ownership survives the admission response until closeout settles.
  const activeTaskCloseouts = new Map<string, Promise<void>>();
  // These process-local handles stop admitted model work; the Turn remains the durable owner.
  const activeChatRuns = new WeakMap<
    FsStore,
    Map<string, { controller: AbortController; finished: Promise<void> }>
  >();
  /** Resolves one internal-role profile and logical model for one User and Workspace. */
  function internalRoleSelection(
    roleId: string,
    userId: string,
    workspaceId: string,
    requestedLogicalModelId?: string
  ) {
    const snapshot = runtimeConfig();
    return resolveInternalRoleProfile({
      roleId,
      workspaceId,
      gatewayConfig: snapshot.gatewayConfig,
      profilesConfig: snapshot.internalRoleProfiles,
      providerRegistry: snapshot.providerRegistry,
      providerSubscriptionAccountManager,
      providerCredentialConfigured,
      ...(requestedLogicalModelId ? { requestedLogicalModelId } : {}),
      ...(findWorkspaceConfig(snapshot, workspaceId)?.config
        ? { workspaceConfig: findWorkspaceConfig(snapshot, workspaceId)!.config }
        : {}),
      ...(snapshot.userConfigs.find((entry) => entry.userId === userId)?.config
        ? { userConfig: snapshot.userConfigs.find((entry) => entry.userId === userId)!.config }
        : {}),
    });
  }

  /** Resolves the Assistant role used by Quick Chat and direct Assistant submissions. */
  function quickChatSelection(
    userId: string,
    workspaceId: string,
    requestedLogicalModelId?: string
  ) {
    return internalRoleSelection('assistant', userId, workspaceId, requestedLogicalModelId);
  }

  /** Projects one resolved logical model without private Gateway routes. */
  function conversationModelChoice(model: ResolvedLogicalModel) {
    return {
      id: model.id,
      label: model.displayName,
      capabilities: [...model.capabilities],
      ...(model.reasoningEffortLevels !== undefined
        ? { reasoningEffortLevels: [...model.reasoningEffortLevels] }
        : {}),
    };
  }

  /** Builds the single target projection shared by catalog reads and command acceptance. */
  function conversationTargetCatalog(
    store: FsStore,
    workspaceId: string,
    requestedThreadId: string | null,
    userId: string
  ): z.infer<typeof ConversationTargetCatalogSchema> {
    const snapshot = runtimeConfig();
    const workspaceConfig = findWorkspaceConfig(snapshot, workspaceId)?.config;
    const userConfig = snapshot.userConfigs.find((entry) => entry.userId === userId)?.config;
    const assistant = quickChatSelection(userId, workspaceId);
    const knowledgeManager = internalRoleSelection('knowledge-manager', userId, workspaceId);
    const targets: Array<z.infer<typeof ConversationTargetCatalogSchema>['targets'][number]> = [
      {
        targetRef: 'internal-role:assistant',
        kind: 'assistant',
        label: 'Assistant',
        description: 'OpenKit Core Assistant.',
        availability: assistant ? 'available' : 'unavailable',
        unavailableReason: assistant ? null : 'No admitted logical model is configured.',
        threadId: requestedThreadId,
        profileId: assistant?.profile?.id ?? null,
        logicalModels: assistant?.logicalModels.map(conversationModelChoice) ?? [],
        defaultLogicalModelId: assistant?.logicalModel.id ?? null,
      },
      {
        targetRef: 'internal-role:knowledge-manager',
        kind: 'knowledge-manager',
        label: 'Knowledge Manager',
        description: 'Answers from Workspace Knowledge.',
        availability: knowledgeManager ? 'available' : 'unavailable',
        unavailableReason: knowledgeManager ? null : 'No admitted logical model is configured.',
        threadId: requestedThreadId,
        profileId: null,
        logicalModels: knowledgeManager?.logicalModels.map(conversationModelChoice) ?? [],
        defaultLogicalModelId: knowledgeManager?.logicalModel.id ?? null,
      },
    ];

    if (requestedThreadId && coreDb) {
      const workspaceDb = repositoryWorkspaceDb(workspaceId);
      try {
        const goal = listGoalsForThread(workspaceDb, requestedThreadId).findLast(
          (candidate) => candidate.disposition === null
        );
        if (goal) {
          const goalOrchestrator = internalRoleSelection('goal-orchestrator', userId, workspaceId);
          targets.push({
            targetRef: `goal-coordinator:${goal.goalId}`,
            kind: 'goal-coordinator',
            label: 'Goal Coordinator',
            description: 'Revise this Goal’s current intent.',
            availability: 'available',
            unavailableReason: null,
            threadId: requestedThreadId,
            profileId: null,
            logicalModels: goalOrchestrator?.logicalModels.map(conversationModelChoice) ?? [],
            defaultLogicalModelId: goalOrchestrator?.logicalModel.id ?? null,
          });
        }
      } finally {
        workspaceDb.sqlite.close();
      }
    }

    const pinnedAgentIds = new Set([
      ...(workspaceConfig?.workspace.agents.map((binding) => binding.agentId) ?? []),
      ...(workspaceConfig?.workspace.defaultAgentId
        ? [workspaceConfig.workspace.defaultAgentId]
        : []),
    ]);
    for (const candidate of workerCoordinatorCandidates(store, workspaceId)) {
      if (!pinnedAgentIds.has(candidate.agentId)) continue;
      const manifest = snapshot.agentManifests.find((entry) => entry.id === candidate.agentId);
      if (!manifest) continue;
      const setup = resolveAgentSetup(manifest, {
        gatewayConfig: snapshot.gatewayConfig,
        providerRegistry: snapshot.providerRegistry,
        workspaceId,
        ...(workspaceConfig ? { workspaceConfig } : {}),
        ...(userConfig ? { userConfig } : {}),
      }).setup;
      targets.push({
        targetRef: `warm-worker:${encodeURIComponent(candidate.agentId)}:${encodeURIComponent(setup?.profileId ?? manifest.defaultProfileId ?? '')}`,
        kind: 'warm-worker',
        label: candidate.displayName,
        description: 'Reusable Worker supply configured for this Workspace.',
        availability: candidate.readiness === 'ready' && setup ? 'available' : 'unavailable',
        unavailableReason:
          candidate.readiness === 'ready' && setup
            ? null
            : candidate.reasons?.join(' ') || 'Worker is not ready.',
        threadId: null,
        profileId: setup?.profileId ?? manifest.defaultProfileId ?? null,
        logicalModels: setup?.logicalModels.allowed.map(conversationModelChoice) ?? [],
        defaultLogicalModelId: setup?.logicalModels.preferredLogicalModelId ?? null,
      });
    }

    for (const session of requestedThreadId
      ? store.listThreadAgentSessions(workspaceId, requestedThreadId)
      : []) {
      if (!session.threadId || !isCurrentAgentSessionStatus(session.status)) continue;
      const manifest = snapshot.agentManifests.find((entry) => entry.id === session.agentId);
      if (!manifest) continue;
      const setup = resolveAgentSetup(manifest, {
        gatewayConfig: snapshot.gatewayConfig,
        providerRegistry: snapshot.providerRegistry,
        workspaceId,
        ...(workspaceConfig ? { workspaceConfig } : {}),
        ...(userConfig ? { userConfig } : {}),
      }).setup;
      const ready = !session.stale && ['ready', 'idle'].includes(session.status) && setup;
      const busy = !session.stale && session.status === 'busy';
      targets.push({
        targetRef: `running-worker:${encodeURIComponent(session.threadId)}:${encodeURIComponent(session.agentId)}`,
        kind: 'running-worker',
        label: `${manifest.displayName} · This conversation`,
        description: 'Continue work in this conversation.',
        availability: busy ? 'busy' : ready ? 'available' : 'unavailable',
        unavailableReason: busy ? 'Worker is busy.' : ready ? null : 'Worker is not ready.',
        threadId: session.threadId,
        profileId: setup?.profileId ?? manifest.defaultProfileId ?? null,
        logicalModels: setup?.logicalModels.allowed.map(conversationModelChoice) ?? [],
        defaultLogicalModelId: setup?.logicalModels.preferredLogicalModelId ?? null,
      });
    }

    const defaultAgentId = resolveDefaultAgentId(snapshot, workspaceId, userId);
    const defaultManifest = snapshot.agentManifests.find((entry) => entry.id === defaultAgentId);
    const defaultSetup = defaultManifest
      ? resolveAgentSetup(defaultManifest, {
          gatewayConfig: snapshot.gatewayConfig,
          providerRegistry: snapshot.providerRegistry,
          workspaceId,
          ...(workspaceConfig ? { workspaceConfig } : {}),
          ...(userConfig ? { userConfig } : {}),
        }).setup
      : null;
    targets.push({
      targetRef: 'new-task-worker',
      kind: 'new-task-worker',
      label: 'New Shard + Worker',
      description: 'Create a linked Task execution Thread and start a Worker.',
      availability: defaultSetup ? 'available' : 'unavailable',
      unavailableReason: defaultSetup ? null : 'No default Worker is ready.',
      threadId: null,
      profileId: defaultSetup?.profileId ?? null,
      logicalModels: defaultSetup?.logicalModels.allowed.map(conversationModelChoice) ?? [],
      defaultLogicalModelId: defaultSetup?.logicalModels.preferredLogicalModelId ?? null,
    });

    const uniqueTargets = [
      ...new Map(targets.map((target) => [target.targetRef, target])).values(),
    ];
    const defaultTargetRef = assistant
      ? 'internal-role:assistant'
      : defaultSetup
        ? 'new-task-worker'
        : null;
    if (!defaultTargetRef) {
      throw new TurnStartValidationError(
        'conversation_target_not_configured',
        'No default Assistant or Worker is configured for this Workspace.',
        409
      );
    }
    return ConversationTargetCatalogSchema.parse({
      workspaceId,
      threadId: requestedThreadId,
      targets: uniqueTargets,
      defaultTargetRef,
    });
  }

  /** Reads the context-sensitive catalog after native Workspace and optional Thread admission. */
  function targets(
    store: FsStore,
    input: { workspaceId: string; threadId?: string | undefined },
    actor: Actor
  ) {
    store.getWorkspace(input.workspaceId);
    return conversationTargetCatalog(
      store,
      input.workspaceId,
      input.threadId ?? null,
      actor.userId
    );
  }

  /**
   * Executes one bounded Quick Chat provider call without creating a private runtime.
   *
   * @param input Provider selection, prompt, lineage metadata, and caller cancellation signal.
   * @returns Provider response identity, text, and optional usage payload.
   * @throws TurnStartValidationError for timeout, caller cancellation, or invalid content.
   * @throws Error when provider resolution or dispatch fails.
   */
  async function callQuickChatProvider(input: {
    /** Authenticated actor responsible for the existing Workspace usage attribution. */
    readonly authorityActor: ActorRef;
    /** Existing command request lineage, when this invocation belongs to a submitted Chat Turn. */
    readonly requestId?: string;
    /** Entry-admitted Chat Turn; standalone Quick Chat remains an explicit no-Turn gap. */
    readonly capture?: Omit<ModelCaptureContext, 'corr'>;
    /** Selected logical-model contract. */
    readonly logicalModel: ResolvedLogicalModel;
    /** User prompt. */
    readonly prompt: string;
    /** Canonical messages from this Thread, captured before admitting the current input. */
    readonly history?: readonly OpenAICompatibleChatMessage[];
    /** Stable cache and diagnostics session id. */
    readonly sessionId: string;
    /** Workspace lineage. */
    readonly workspaceId: string;
    /** Caller cancellation signal. */
    readonly signal: AbortSignal;
  }): Promise<{
    readonly id: string;
    readonly content: string;
    readonly providerId: string;
    readonly usage?: unknown;
  }> {
    const workspaceDb =
      input.capture?.workspaceDb ??
      (coreDb ? openWorkspaceDb(coreDb.dataRoot, input.workspaceId) : undefined);
    if (workspaceDb) applyScopedMigrations(workspaceDb);
    const call = workspaceDb
      ? startCapabilityCall({
          workspaceDb,
          workspaceId: input.workspaceId,
          authorityActor: input.authorityActor,
          agentId: QUICK_CHAT_AGENT_ID,
          agentSessionId: null,
          capabilityId: 'inference.local.quick_chat',
          family: 'llm',
          operation: 'quick_chat',
          providerRef: null,
          redactionClass: 'metadata-only',
          requestId: normalizeCapabilityRequestId(input.requestId),
          serviceRef: 'llm-gateway',
          threadId: input.capture?.threadId ?? null,
          turnId: input.capture?.turnId ?? null,
          summary: input.capture
            ? 'QuickChatAgent LLM call.'
            : 'QuickChatAgent LLM call. Model capture unavailable: no Turn admission.',
        })
      : undefined;
    let callFinished = false;
    const timeoutSignal = AbortSignal.timeout(QUICK_CHAT_TIMEOUT_MS);
    const signal = AbortSignal.any([input.signal, timeoutSignal]);
    let abortListener: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      abortListener = () => reject(signal.reason);
      signal.addEventListener('abort', abortListener, { once: true });
    });
    let selected: {
      response: Awaited<ReturnType<LLMGatewayProviderDispatcher['createChatCompletion']>>;
      providerId: string;
      content: string;
    };

    try {
      signal.throwIfAborted();
      selected = await dispatchLogicalModel({
        ...(workspaceDb && call ? { ledger: { workspaceDb, call } } : {}),
        logicalModel: input.logicalModel,
        signal,
        resolveGatewayProvider,
        ...(providerSubscriptionAccountManager ? { providerSubscriptionAccountManager } : {}),
        attempt: async ({
          provider,
          providerModel,
          subscriptionModels,
          corr,
          attempt,
          execution,
        }) => {
          const response = await Promise.race([
            llmGatewayDispatcher.createChatCompletion(
              provider,
              {
                model: providerModel,
                messages: [
                  { role: 'system', content: assembleBuiltInSystemPrompt('quick-chat') },
                  ...(input.history ?? []),
                  { role: 'user', content: input.prompt },
                ],
              },
              {
                ...(subscriptionModels ? { models: subscriptionModels } : {}),
                ...(input.capture
                  ? {
                      capture: {
                        ...input.capture,
                        ...(call ? { capabilityCallId: call.id } : {}),
                        corr,
                        attempt,
                      },
                    }
                  : {}),
                promptCacheScope: {
                  sessionId: input.sessionId,
                  workspaceId: input.workspaceId,
                },
                usageEndpoint: 'quick_chat',
                onUsage: (usage) => {
                  if (workspaceDb && call && !callFinished)
                    execution.addUsageRecordIds(
                      recordInternalLlmGatewayUsage({
                        workspaceDb,
                        call,
                        logicalModelId: input.logicalModel.id,
                        providerId: provider.id,
                        usage,
                        succeeded: false,
                      })
                    );
                },
                transport: { signal, deadline: execution.deadline },
              }
            ),
            aborted,
          ]);
          const content = response.choices[0]?.message.content;
          if (typeof content !== 'string' || content.trim().length === 0)
            throw new TurnStartValidationError(
              'provider_response_invalid',
              'Quick chat provider returned invalid assistant content.',
              502
            );
          if (workspaceDb && call)
            execution.addUsageRecordIds(
              recordInternalLlmGatewayUsage({
                workspaceDb,
                call,
                logicalModelId: input.logicalModel.id,
                providerId: provider.id,
                usage: response.usage,
                succeeded: true,
              })
            );
          return { response, providerId: provider.id, content };
        },
      });
      if (workspaceDb && call)
        finishCapabilityCall({ workspaceDb, callId: call.id, status: 'succeeded' });
    } catch (error) {
      if (workspaceDb && call)
        finishCapabilityCall({
          workspaceDb,
          callId: call.id,
          status: 'failed',
          errorCode: projectGatewayFailure(error, 'quick_chat_inference_failed').code,
        });
      if (input.signal.aborted) {
        throw new TurnStartValidationError(
          'provider_call_aborted',
          'Quick chat provider call was aborted.',
          499
        );
      }

      if (timeoutSignal.aborted) {
        throw new TurnStartValidationError(
          'provider_call_timeout',
          'Quick chat provider call timed out.',
          504
        );
      }

      throw error;
    } finally {
      callFinished = true;
      if (!input.capture) workspaceDb?.sqlite.close();
      if (abortListener) {
        signal.removeEventListener('abort', abortListener);
      }
    }
    return {
      id: selected.response.id,
      content: selected.content,
      providerId: selected.providerId,
      ...(selected.response.usage === undefined ? {} : { usage: selected.response.usage }),
    };
  }

  /** Runs direct Quick Chat after actor-derived Workspace admission, preserving provider and timeout refusals. */
  async function quick(
    input: z.infer<typeof QuickChatRequestSchema>,
    actor: Actor,
    workspaceId: string,
    signal: AbortSignal
  ) {
    try {
      const selection = quickChatSelection(actor.userId, workspaceId);
      if (!selection)
        throw new TurnStartValidationError(
          'quick_chat_not_configured',
          'Quick chat requires an admitted logical model.',
          400
        );
      const result = await callQuickChatProvider({
        authorityActor: { kind: 'user', id: actor.userId },
        logicalModel: selection.logicalModel,
        prompt: input.input,
        sessionId: `quick-chat:${workspaceId}`,
        workspaceId,
        signal,
      });
      return QuickChatResponseSchema.parse({
        id: result.id,
        status: 'completed',
        workspaceId,
        modelId: selection.logicalModel.id,
        content: result.content,
      });
    } catch (error) {
      if (
        error instanceof OpenAICompatibleProviderError ||
        error instanceof LogicalModelRoutesExhaustedError
      )
        throw providerCommandError(error);
      if (error instanceof TurnStartValidationError)
        throw new TurnStartValidationError(
          error.code,
          redactInternalAgentText(error.message),
          error.status
        );
      console.error(
        'quick_chat_failed',
        redactInternalAgentText(error instanceof Error ? error.message : String(error))
      );
      throw new TurnStartValidationError('quick_chat_failed', 'Quick chat failed.', 500);
    }
  }

  /** Executes the existing conversation command with its exact receipt-owned success status. */
  async function submit(
    store: FsStore,
    chatInput: z.infer<typeof SubmitConversationRequestSchema> & {
      workspaceId: string;
      threadId: string;
    },
    actor: Actor
  ): Promise<{ body: z.infer<typeof SubmitConversationResponseSchema>; status: 200 | 202 }> {
    const { workspaceId, threadId } = chatInput;
    try {
      const thread = store.getThread(workspaceId, threadId);
      if (thread.entryPath !== 'conversation') {
        throw new TurnStartValidationError(
          'thread_entry_path_mismatch',
          'Conversation submission cannot continue this Thread.',
          409
        );
      }
    } catch (error) {
      if (error instanceof HTTPException || error instanceof TurnStartValidationError) throw error;
      throw new TurnStartValidationError(
        'target_missing',
        'Conversation Thread is unavailable.',
        409
      );
    }
    const triggerActor = {
      kind: 'user',
      id: actor.userId,
    } as const satisfies ActorRef;
    const actorId = triggerActor.id;
    let freshLogicalModelId: string | null = null;

    /**
     * Executes one fresh Chat command after the command ledger accepts its identity.
     *
     * @param store Store that owns the Chat Thread.
     * @param workspaceId Workspace bound into the command scope.
     * @param threadId Thread bound into the command scope.
     * @returns Accepted Chat response and HTTP status.
     */
    async function executeChatCommand(
      store: FsStore,
      workspaceId: string,
      threadId: string
    ): Promise<ConversationCommandResult> {
      // A missing receipt cannot make an existing provider attempt fresh through changed routing.
      const providerTurnId = providerChatTurnId(
        actorId,
        workspaceId,
        threadId,
        chatInput.requestId
      );
      if (store.listThreadTurns(workspaceId, threadId).some((turn) => turn.id === providerTurnId)) {
        throw new TurnStartValidationError(
          'recovery_required',
          'The Chat provider attempt is missing its command receipt.',
          409
        );
      }
      const workspace = store.getWorkspace(workspaceId);
      const isQuickChatWorkspace = workspace.kind === 'quick-chat';
      const acceptedTarget = conversationTargetCatalog(
        store,
        workspaceId,
        threadId,
        actorId
      ).targets.find((candidate) => candidate.targetRef === chatInput.targetRef);
      if (!acceptedTarget) {
        throw new TurnStartValidationError(
          'target_missing',
          'Conversation target no longer exists.',
          409
        );
      }
      if (acceptedTarget.availability === 'busy') {
        throw new TurnStartValidationError(
          'target_busy',
          acceptedTarget.unavailableReason ?? 'Conversation target is busy.',
          409
        );
      }
      if (acceptedTarget.availability !== 'available') {
        throw new TurnStartValidationError(
          'target_unavailable',
          acceptedTarget.unavailableReason ?? 'Conversation target is unavailable.',
          409
        );
      }
      const logicalModelId = chatInput.logicalModelId ?? acceptedTarget.defaultLogicalModelId;
      if (
        logicalModelId &&
        !acceptedTarget.logicalModels.some((logicalModel) => logicalModel.id === logicalModelId)
      ) {
        throw new TurnStartValidationError(
          'model_not_allowed',
          'The selected logical model is not admitted for this target.',
          409
        );
      }
      freshLogicalModelId = logicalModelId;
      if (
        chatInput.workerStorageChoice &&
        !conversationTargetAcceptsWorkerStorageChoice(acceptedTarget.kind)
      ) {
        throw new TurnStartValidationError(
          'worker_storage_choice_not_applicable',
          'Worker environment choice is not accepted for this conversation target.',
          409
        );
      }
      const outputs = new Map(
        (chatInput.artifactRefs.length
          ? listOutputArtifacts(store, coreDb, workspaceId, actorId)
          : []
        ).map((artifact) => [artifact.id, artifact])
      );
      const artifacts: Array<ReturnType<FsStore['getArtifact']>> = [];
      for (const reference of chatInput.artifactRefs) {
        const artifact = outputs.get(reference.artifactId);
        if (!artifact) {
          throw new TurnStartValidationError(
            'artifact_not_found',
            'The selected Artifact is unavailable.',
            409
          );
        }
        if (artifact.version !== reference.artifactVersion) {
          throw new TurnStartValidationError(
            'artifact_version_mismatch',
            'The selected Artifact version is no longer current.',
            409
          );
        }
        artifacts.push(artifact);
      }
      const conversationPrompt = [
        chatInput.input,
        ...artifacts.map(
          (artifact) =>
            `Artifact ${artifact.title} (${artifact.id} v${artifact.version}):\n${artifact.content.body}`
        ),
      ]
        .filter(Boolean)
        .join('\n\n');

      /**
       * Creates the durable Chat Mode turn and its user-message item.
       *
       * @param completedAt Completion timestamp shared by first-slice Chat Mode items.
       * @param turnId Request-derived identity for provider work whose receipt may fail to persist.
       * @returns Created turn.
       */
      const createChatTurn = (completedAt: string, turnId?: string) => {
        const turn = store.createTurn(workspaceId, threadId, chatInput.input, triggerActor, null, {
          ...(turnId ? { turnId } : {}),
          ...(chatInput.reasoningEffort !== undefined
            ? { reasoningEffort: chatInput.reasoningEffort }
            : {}),
        });
        store.updateTurn(turn.id, {
          agentId:
            acceptedTarget.kind === 'knowledge-manager' ? 'knowledge-manager' : QUICK_CHAT_AGENT_ID,
        });

        store.createItem({
          id: `it_chat_user_${turn.id}`,
          workspaceId,
          threadId,
          turnId: turn.id,
          type: 'user-message',
          status: 'completed',
          actor: triggerActor,
          text: chatInput.input,
          createdAt: turn.startedAt ?? completedAt,
          completedAt,
        });

        for (const artifact of artifacts) {
          store.createItem({
            id: artifactReferenceItemId(artifact.id, turn.id),
            workspaceId,
            threadId,
            turnId: turn.id,
            type: 'artifact-reference',
            status: 'completed',
            artifactId: artifact.id,
            artifactVersion: artifact.version,
            title: artifact.title,
            summary: artifact.summary,
            lastMutationRequestId: chatInput.requestId,
            createdAt: turn.startedAt ?? completedAt,
            completedAt,
          });
        }

        return store.getTurn(workspaceId, threadId, turn.id);
      };

      /**
       * Records one item-backed Chat Mode handoff response.
       *
       * @param targetMode Target product mode.
       * @param reason User-visible handoff reason.
       * @returns Parsed Chat Mode response.
       */
      const createHandoffResponse = (targetMode: 'task' | 'goal', reason: string) => {
        const completedAt = new Date().toISOString();
        const turn = createChatTurn(completedAt);
        const title = targetMode === 'task' ? 'Task Mode handoff' : 'Goal Mode handoff';
        const handoffItem = store.createItem({
          id: `it_chat_${targetMode}_${turn.id}`,
          workspaceId,
          threadId,
          turnId: turn.id,
          type: 'status',
          status: 'completed',
          level: 'info',
          title,
          summary: reason,
          createdAt: turn.startedAt ?? completedAt,
          completedAt,
        });
        const completedTurn = store.updateTurn(turn.id, {
          status: 'completed',
          completedAt,
        });

        return ConversationCommandBodySchema.parse({
          outcome: `${targetMode}-handoff`,
          explanation: reason,
          turn: completedTurn,
          item: handoffItem,
          handoff: {
            targetMode,
            reason,
            statusItemId: handoffItem.id,
          },
        });
      };

      /**
       * Records a bounded Chat Mode clarification gate.
       *
       * @returns Parsed Chat Mode response.
       */
      const createClarificationResponse = () => {
        const completedAt = new Date().toISOString();
        const turn = createChatTurn(completedAt);
        const requestId = `ui_chat_clarify_${turn.id}`;
        const questionItem = store.createItem({
          id: `it_chat_clarify_${turn.id}`,
          workspaceId,
          threadId,
          turnId: turn.id,
          type: 'user-input-request',
          status: 'completed',
          responsibleUserId: triggerActor.id,
          userInputRequestId: requestId,
          prompt: 'Chat Mode needs a more specific request.',
          questions: [
            {
              id: 'chat_clarification',
              header: 'Clarify',
              question: 'What should the Assistant answer or help route?',
              options: null,
              isOther: true,
              isSecret: false,
            },
          ],
          createdAt: turn.startedAt ?? completedAt,
          completedAt: turn.startedAt ?? completedAt,
        });
        const completedTurn = store.updateTurn(turn.id, {
          status: 'completed',
          completedAt,
        });
        if (coreDb) {
          const workspaceDb = repositoryWorkspaceDb(workspaceId);
          try {
            raiseRecordedPendingRequest(store, workspaceDb.sqlite, {
              requestId,
              workspaceId,
              threadId,
              raisingTurnId: turn.id,
              requestItemId: questionItem.id,
              kind: 'user-input',
              requesterKind: 'assistant',
              responsibleUserId: triggerActor.id,
              questions: questionItem.type === 'user-input-request' ? questionItem.questions : [],
              now: completedAt,
            });
          } finally {
            workspaceDb.sqlite.close();
          }
        }

        return ConversationCommandBodySchema.parse({
          outcome: 'clarification-needed',
          explanation: 'The Assistant needs a concrete request before choosing a mode.',
          turn: completedTurn,
          item: questionItem,
          handoff: null,
        });
      };

      /**
       * Records one item-backed Chat Mode refusal.
       *
       * @param explanation Refusal reason safe for diagnostics.
       * @returns Parsed Chat Mode response.
       */
      const createRefusedResponse = (explanation: string) => {
        const completedAt = new Date().toISOString();
        const turn = createChatTurn(completedAt);
        const refusedItem = store.createItem({
          id: `it_chat_refused_${turn.id}`,
          workspaceId,
          threadId,
          turnId: turn.id,
          type: 'status',
          status: 'completed',
          level: 'warning',
          title: 'Chat Mode request refused',
          summary: explanation,
          createdAt: turn.startedAt ?? completedAt,
          completedAt,
        });
        const completedTurn = store.updateTurn(turn.id, {
          status: 'completed',
          completedAt,
        });

        return ConversationCommandBodySchema.parse({
          outcome: 'refused',
          explanation,
          turn: completedTurn,
          item: refusedItem,
          handoff: null,
        });
      };

      /** Runs the explicitly selected Knowledge Manager and projects its answer into this Thread. */
      const answerFromWorkspaceKnowledge = async (): Promise<ConversationCommandResult | null> => {
        if (!store.getDataRoot()) return null;
        const knowledgeAnswer = await createOperationInvocation({
          coreDb,
          store,
          inflightCommands,
          repositoryWorkspaceDb,
          workspaceMutationAdmission,
        })(
          'knowledge.answer',
          { workspaceId, query: conversationPrompt, limit: 3 },
          {
            kind: 'public',
            actor: actor,
          }
        );
        const completedAt = new Date().toISOString();
        const turn = createChatTurn(completedAt);
        const sourceTitles = knowledgeAnswer.citations.map((citation) => citation.title).join(', ');
        const answerItem = store.createItem({
          id: `it_chat_answer_${turn.id}`,
          workspaceId,
          threadId,
          turnId: turn.id,
          type: 'assistant-message',
          status: 'completed',
          text: sourceTitles
            ? `${knowledgeAnswer.answer}\n\nSources: ${sourceTitles}`
            : knowledgeAnswer.answer,
          createdAt: turn.startedAt ?? completedAt,
          completedAt,
        });
        const completedTurn = store.updateTurn(turn.id, { status: 'completed', completedAt });
        return {
          body: ConversationCommandBodySchema.parse({
            outcome: 'answered',
            explanation:
              knowledgeAnswer.outcome === 'answered'
                ? 'The Knowledge Manager answered from Workspace Knowledge.'
                : 'The Knowledge Manager found insufficient Workspace evidence.',
            turn: completedTurn,
            item: answerItem,
            handoff: null,
          }),
          downstream: null,
          resultKind: 'knowledge-answer',
          status: 200,
        };
      };

      /** Validates the objective before creating receiving work through the existing product Turn owner. */
      const startSelectedWorker = async (): Promise<ConversationCommandResult> => {
        const objective =
          StructuredWorkerDelegationRequestSchema.shape.objective.safeParse(conversationPrompt);
        if (!objective.success) {
          throw new TurnStartValidationError(
            'invalid_request',
            objective.error.issues.map((issue) => issue.message).join('; '),
            400
          );
        }
        const snapshot = runtimeConfig();
        let receivingThreadId = threadId;
        let agentId: string | null = null;
        if (acceptedTarget.kind === 'warm-worker') {
          agentId = decodeURIComponent(
            acceptedTarget.targetRef.slice('warm-worker:'.length).split(':', 1)[0] ?? ''
          );
        } else if (acceptedTarget.kind === 'running-worker') {
          const session = store
            .listWorkspaceAgentSessions(workspaceId)
            .find(
              (candidate) =>
                candidate.threadId &&
                `running-worker:${encodeURIComponent(candidate.threadId)}:${encodeURIComponent(candidate.agentId)}` ===
                  acceptedTarget.targetRef
            );
          if (!session?.threadId) {
            throw new TurnStartValidationError(
              'target_missing',
              'The selected running Worker no longer exists.',
              409
            );
          }
          receivingThreadId = session.threadId;
          agentId = session.agentId;
        } else {
          agentId = resolveDefaultAgentId(snapshot, workspaceId, actorId);
          const createdThreadId = `th_task_${createHash('sha256')
            .update(JSON.stringify([actorId, workspaceId, threadId, chatInput.requestId]))
            .digest('hex')
            .slice(0, 24)}`;
          if (
            store.listThreads(workspaceId).some((candidate) => candidate.id === createdThreadId)
          ) {
            throw new TurnStartValidationError(
              'recovery_required',
              'The Task execution Thread exists without its conversation receipt.',
              409
            );
          }
          const title = chatInput.input.trim().split(/\r?\n/, 1)[0] || 'Artifact task';
          receivingThreadId = store.createThread(
            workspaceId,
            title,
            createdThreadId,
            'conversation',
            { visibility: 'workspace' }
          ).id;
        }
        if (!agentId) {
          throw new TurnStartValidationError(
            'target_unavailable',
            'The selected Worker has no Agent configuration.',
            409
          );
        }
        const workerRequest = createStructuredWorkerDelegationRequest({
          objective: conversationPrompt,
          acceptanceCriteria: [
            'The bounded worker task satisfies the requested objective.',
            'The worker reports verification evidence or a clear blocker.',
          ],
          contextRefs: [
            { kind: 'workspace', id: workspaceId },
            { kind: 'thread', id: receivingThreadId },
            ...artifacts.map((artifact) => ({ kind: 'artifact' as const, id: artifact.id })),
          ],
          resources: artifacts.map((artifact) => ({
            kind: 'artifact',
            reference: `${artifact.id}:v${artifact.version}`,
            reason: 'Selected by the user for this conversation Turn.',
          })),
          expectedArtifacts: [],
          constraints: { maxContextTokens: 240_000, maxWorkerIterations: 1 },
          verification: [
            {
              kind: 'manual',
              description: 'Report the focused verification performed for the requested work.',
            },
          ],
          reviewPolicy: {
            required: false,
            reviewers: ['human'],
            instructions: 'Review the worker result and its verification evidence.',
          },
          escalationConditions: ['Escalate instead of inventing missing scope or authority.'],
          reviewContext: null,
        });
        const reservedTurnId = `tu_conversation_${createHash('sha256')
          .update(
            JSON.stringify([actorId, workspaceId, threadId, receivingThreadId, chatInput.requestId])
          )
          .digest('hex')
          .slice(0, 24)}`;
        if (
          store
            .listThreadTurns(workspaceId, receivingThreadId)
            .some((candidate) => candidate.id === reservedTurnId)
        ) {
          throw new TurnStartValidationError(
            'recovery_required',
            'The Worker Turn exists without its conversation receipt.',
            409
          );
        }
        const workspaceDb = repositoryWorkspaceDb(workspaceId);
        let resolveAccepted!: () => void;
        const accepted = new Promise<void>((resolve) => {
          resolveAccepted = resolve;
        });
        let acceptSignalled = false;
        const persistWorkerResult = () =>
          persistConversationWorkerResultItem(
            store,
            workspaceId,
            receivingThreadId,
            reservedTurnId,
            agentId
          );
        const workerLoop = (async () => {
          try {
            await runWorkerTurnLoop({
              store,
              coreDb: coreDb!,
              triggerActor,
              requestActor: actor,
              workspaceDb,
              workspaceId,
              threadId: receivingThreadId,
              requestId: chatInput.requestId,
              requestInputHash: commandInputHash(conversationCommandInput(chatInput)),
              reviewRequired: false,
              prepare: async () => {
                const dataRoot = store.getDataRoot();
                if (!dataRoot) {
                  throw directTaskModeRecoveryError(
                    'Task Knowledge retrieval requires a file-backed data root.'
                  );
                }
                let knowledgeSelectionInput: { readonly retrievalTraceId: string };
                try {
                  knowledgeSelectionInput = await createTaskKnowledgePreparation({
                    coreDb,
                    store,
                    repositoryWorkspaceDb,
                    workspaceMutationAdmission,
                  })(
                    { workspaceId, query: chatInput.input },
                    {
                      actor: actor,
                      traceId: directTaskKnowledgeRetrievalTraceId(
                        actorId,
                        workspaceId,
                        receivingThreadId,
                        chatInput.requestId
                      ),
                    }
                  );
                } catch (error) {
                  throw directTaskModeRecoveryError(
                    error instanceof Error &&
                      error.message === 'Duplicate Knowledge retrieval trace id.'
                      ? 'Task Knowledge retrieval exists without a provable worker owner.'
                      : 'Task Knowledge retrieval could not establish one coherent selection.'
                  );
                }
                return {
                  delegationRequest: workerRequest,
                  contextPackageDigest: commandInputHash(workerRequest),
                  knowledgeSelectionInput,
                };
              },
              reservedTurnId,
              reserveTurn: () => ({ turnId: reservedTurnId }),
              startWorker: async ({ turnId, prepared, onAdmitted }) => {
                const workerStorageChoice = directTaskWorkerStorageChoice(
                  chatInput.workerStorageChoice
                );
                const turn = await startModeWorkerTurn({
                  triggerActor,
                  requestActor: actor,
                  store,
                  workspaceId,
                  threadId: receivingThreadId,
                  prompt: serializeStructuredWorkerDelegationRequest(prepared.delegationRequest),
                  ...(logicalModelId ? { modelId: logicalModelId } : {}),
                  ...(chatInput.reasoningEffort !== undefined
                    ? { reasoningEffort: chatInput.reasoningEffort }
                    : {}),
                  ...(acceptedTarget.profileId ? { profileId: acceptedTarget.profileId } : {}),
                  requestId: chatInput.requestId,
                  requestedAgentId: agentId!,
                  reservedTurnId: turnId,
                  ...(workerStorageChoice ? { workerStorageChoice } : {}),
                  onTurnCreated: (created, agentSessionId) => {
                    onAdmitted(created, agentSessionId);
                    const createdAt = created.startedAt ?? new Date().toISOString();
                    for (const artifact of artifacts) {
                      store.createItem({
                        id: artifactReferenceItemId(artifact.id, created.id),
                        workspaceId,
                        threadId: receivingThreadId,
                        turnId: created.id,
                        type: 'artifact-reference',
                        status: 'completed',
                        artifactId: artifact.id,
                        artifactVersion: artifact.version,
                        title: artifact.title,
                        summary: artifact.summary,
                        lastMutationRequestId: chatInput.requestId,
                        createdAt,
                        completedAt: createdAt,
                      });
                    }
                    persistWorkerResult();
                    acceptSignalled = true;
                    resolveAccepted();
                  },
                });
                return { workerSessionId: turn.agentSessionId ?? null };
              },
              awaitWorker: ({ turnId }) => {
                const turn = store.getTurn(workspaceId, receivingThreadId, turnId);
                const stopReason = taskModeTerminalStopReason(store, turnId);
                if (!stopReason) {
                  throw new Error('Selected Worker Turn has no unique terminal outcome.');
                }
                const evidence = taskModeEvidenceForTurn(
                  store,
                  workspaceDb,
                  workspaceId,
                  receivingThreadId,
                  turn
                );
                return {
                  stopReason,
                  itemIds: evidence.itemIds,
                  artifactIds: evidence.artifactIds,
                  diagnosticsSummary:
                    turn.error?.message ??
                    (turn.status === 'completed' ? null : 'Worker turn ended without success.'),
                };
              },
            });
          } finally {
            workspaceDb.sqlite.close();
          }
        })();
        const observedLoop = workerLoop.then(
          () => persistWorkerResult(),
          (error: unknown) => {
            if (!acceptSignalled) {
              throw error;
            }
            persistWorkerResult();
            throw error;
          }
        );
        void observedLoop.catch(() => {
          if (acceptSignalled) {
            console.error('selected_worker_closeout_failed_after_acceptance');
          }
        });
        await Promise.race([accepted, observedLoop]);
        if (!acceptSignalled) {
          throw new Error('Selected Worker Turn completed without an acceptance signal.');
        }
        const item = persistWorkerResult();
        const started = store.getTurn(workspaceId, receivingThreadId, reservedTurnId);
        const presentation = conversationWorkerTurnPresentation(started, agentId);
        return {
          body: ConversationCommandBodySchema.parse({
            outcome: 'accepted',
            explanation: presentation.explanation,
            turn: started,
            item,
            handoff: null,
          }),
          downstream: { kind: 'task', turnId: started.id },
          resultKind: 'worker-turn',
          status: 202,
        };
      };

      if (coreDb) {
        const workspaceDb = repositoryWorkspaceDb(workspaceId);
        try {
          if (
            hasChatTaskCheckpointWithoutReceipt(
              store,
              workspaceDb,
              actorId,
              workspaceId,
              threadId,
              chatInput.requestId
            )
          ) {
            throw new TurnStartValidationError(
              'recovery_required',
              'The Chat Task checkpoint is missing its outer Chat command receipt.',
              409
            );
          }
        } finally {
          workspaceDb.sqlite.close();
        }
      }

      if (acceptedTarget.kind === 'knowledge-manager') {
        const response = await answerFromWorkspaceKnowledge();
        if (response) return response;
        return {
          body: createRefusedResponse('Workspace Knowledge storage is unavailable.'),
          downstream: null,
          resultKind: 'refused',
          status: 200,
        };
      }

      /** Private Artifact bytes need disclosure admission even when a Goal is explicitly addressed. */
      const privateGoalArtifact = artifacts.some(
        (artifact) =>
          artifact.origin.kind !== 'imported' &&
          store.getThread(workspaceId, artifact.origin.threadId).visibility === 'private'
      );
      if (acceptedTarget.kind === 'goal-coordinator' && privateGoalArtifact)
        return {
          body: createRefusedResponse(
            'Share private Artifact input explicitly before sending it to Goal work.'
          ),
          downstream: null,
          resultKind: 'refused',
          status: 200,
        };
      if (acceptedTarget.kind === 'goal-coordinator') {
        const goalDb = repositoryWorkspaceDb(workspaceId);
        try {
          const goalId = acceptedTarget.targetRef.slice('goal-coordinator:'.length);
          const goal = readGoalView(store, goalDb, goalId).goal;
          if (!goal || goal.disposition)
            throw new TurnStartValidationError('target_unavailable', 'Goal is unavailable.', 409);
          await executeGoalOperation(
            'goal.intent.revise',
            {
              workspaceId,
              threadId: goal.threadId,
              goalId,
              requestId: goalHandoffRequestId(actorId, workspaceId, threadId, chatInput.requestId),
              intent: conversationPrompt,
              expectedRevision: goal.intentRevision,
            },
            { actor: actor },
            store,
            goalDb,
            goalServices?.()
          );
          const turn = createChatTurn(new Date().toISOString());
          const at = new Date().toISOString();
          const item = store.createItem({
            id: `it_chat_goal_intent_${turn.id}`,
            workspaceId,
            threadId,
            turnId: turn.id,
            type: 'status',
            status: 'completed',
            level: 'info',
            title: 'Goal intent revised',
            summary: 'The Coordinator will consider the current intent.',
            createdAt: at,
            completedAt: at,
          });
          const ended = store.updateTurn(turn.id, { status: 'completed', completedAt: at });
          return {
            body: ConversationCommandBodySchema.parse({
              outcome: 'accepted',
              explanation: 'Goal intent revised.',
              turn: ended,
              item,
              handoff: null,
            }),
            downstream: { kind: 'goal', goalId, turnId: ended.id },
            resultKind: 'goal-intent',
            status: 202,
          };
        } finally {
          goalDb.sqlite.close();
        }
      }

      if (
        acceptedTarget.kind === 'warm-worker' ||
        acceptedTarget.kind === 'running-worker' ||
        acceptedTarget.kind === 'new-task-worker'
      ) {
        return startSelectedWorker();
      }

      if (isClarificationChatPrompt(chatInput.input)) {
        return {
          body: createClarificationResponse(),
          downstream: null,
          resultKind: 'clarification',
          status: 202,
        };
      }

      if (isExternalSearchChatPrompt(chatInput.input)) {
        return {
          body: createRefusedResponse('External search is not enabled for Chat Mode.'),
          downstream: null,
          resultKind: 'refused',
          status: 200,
        };
      }

      if (isQuickChatWorkspace && isProjectWorkChatPrompt(chatInput.input)) {
        assertProjectWorkspace(workspace, 'handle project work');
      }

      const delegation = isQuickChatWorkspace
        ? null
        : createTaskModeDelegation({
            entryIntent: 'conversation',
            store,
            workspaceId,
            threadId,
            prompt: chatInput.input,
            workerCoordinatorCandidates,
          });

      if (delegation?.taskDecision && delegation.coordinator.workerRequest) {
        const taskDecision = delegation.taskDecision;
        const workerRequest = delegation.coordinator.workerRequest;
        if (!coreDb) {
          throw new TurnStartValidationError(
            'scheduler_unavailable',
            'Durable scheduler storage is required to start Task Mode.',
            503
          );
        }
        const workspaceDb = repositoryWorkspaceDb(workspaceId);
        const reservedTurnId = chatTaskModeTurnId(
          actorId,
          workspaceId,
          threadId,
          chatInput.requestId
        );

        const observed = observeTurnAdmission({
          execute: async (admit) => {
            try {
              await runWorkerTurnLoop({
                store,
                coreDb,
                triggerActor,
                requestActor: actor,
                workspaceDb,
                workspaceId,
                threadId,
                requestId: chatInput.requestId,
                requestInputHash: commandInputHash({ input: chatInput.input }),
                reviewRequired: false,
                prepare: () => ({
                  delegationRequest: workerRequest,
                  contextPackageDigest: commandInputHash(workerRequest),
                  knowledgeSelectionInput: null,
                }),
                reservedTurnId,
                reserveTurn: () => ({ turnId: reservedTurnId }),
                startWorker: async ({ turnId, prepared, onAdmitted }) => {
                  const turn = await startModeWorkerTurn({
                    triggerActor,
                    requestActor: actor,
                    store,
                    workspaceId,
                    threadId,
                    prompt: serializeStructuredWorkerDelegationRequest(prepared.delegationRequest),
                    requestId: chatInput.requestId,
                    requestedAgentId: taskDecision.worker.agentId,
                    reservedTurnId: turnId,
                    onTurnCreated: (created, agentSessionId) => {
                      onAdmitted(created, agentSessionId);
                      validateLiveTaskAdmission({
                        coreDb,
                        store,
                        workspaceDb,
                        actorId,
                        workspaceId,
                        threadId,
                        requestId: chatInput.requestId,
                        requestInputHash: commandInputHash({ input: chatInput.input }),
                        turnId,
                        contextDigest: prepared.contextPackageDigest,
                      });
                      admit(created);
                    },
                  });
                  return { workerSessionId: turn.agentSessionId ?? null };
                },
                awaitWorker: ({ turnId }) => {
                  const turn = store.getTurn(workspaceId, threadId, turnId);
                  const stopReason = taskModeTerminalStopReason(store, turnId);
                  if (!stopReason) {
                    throw new Error('Task worker Turn has no unique terminal outcome.');
                  }
                  const evidence = taskModeEvidenceForTurn(
                    store,
                    workspaceDb,
                    workspaceId,
                    threadId,
                    turn
                  );
                  return {
                    stopReason,
                    itemIds: evidence.itemIds,
                    artifactIds: evidence.artifactIds,
                    diagnosticsSummary:
                      turn.error?.message ??
                      (turn.status === 'completed' ? null : 'Worker turn ended without success.'),
                  };
                },
              });
            } finally {
              workspaceDb.sqlite.close();
            }
          },
          settled: () => activeTaskCloseouts.delete(reservedTurnId),
          failed: () => console.error('assistant_task_closeout_failed_after_admission'),
        });
        activeTaskCloseouts.set(reservedTurnId, observed.closeout);
        await observed.accepted;

        return {
          body: createHandoffResponse('task', taskDecision.rationale),
          downstream: { kind: 'task', turnId: reservedTurnId },
          resultKind: 'task-handoff',
          status: 202,
        };
      }

      if (delegation?.coordinator.decision === 'goal') {
        // Thread sharing owns private-to-shared disclosure; automatic routing supplies no confirmation.
        if (store.getThread(workspaceId, threadId).visibility === 'private' || privateGoalArtifact)
          return {
            body: createRefusedResponse(
              'Explicit disclosure admission is required before a private Assistant input becomes shared Goal work.'
            ),
            downstream: null,
            resultKind: 'refused',
            status: 200,
          };
        const db = repositoryWorkspaceDb(workspaceId);
        try {
          const created = await executeGoalOperation(
            'goal.create',
            {
              workspaceId,
              requestId: goalHandoffRequestId(actorId, workspaceId, threadId, chatInput.requestId),
              intent: conversationPrompt,
            },
            { actor: actor },
            store,
            db,
            goalServices?.()
          );
          const body = createHandoffResponse('goal', delegation.coordinator.explanation);
          return {
            body,
            downstream: { kind: 'goal', goalId: created.goal!.goalId, turnId: body.turn.id },
            resultKind: 'goal-handoff',
            status: 202,
          };
        } finally {
          db.sqlite.close();
        }
      }

      if (delegation && delegation.coordinator.decision !== 'quick_chat') {
        return {
          body: createRefusedResponse(delegation.coordinator.explanation),
          downstream: null,
          resultKind: 'refused',
          status: 200,
        };
      }

      const selection = quickChatSelection(actor.userId, workspaceId, logicalModelId ?? undefined);
      const sessionId = `chat-mode:${workspaceId}:${threadId}`;

      if (!selection) {
        throw new TurnStartValidationError(
          'chat_mode_not_configured',
          'Chat Mode requires an admitted logical model.',
          400
        );
      }

      // Read canonical history before createChatTurn persists the current user message.
      const history = store
        .listThreadItems(workspaceId, threadId)
        .flatMap<OpenAICompatibleChatMessage>((item) =>
          item.status === 'completed' &&
          (item.type === 'user-message' || item.type === 'assistant-message')
            ? [{ role: item.type === 'user-message' ? 'user' : 'assistant', content: item.text }]
            : []
        );
      const turn = createChatTurn(new Date().toISOString(), providerTurnId);
      const controller = new AbortController();
      let cancellationPersisted = false;
      const execution = (async (): Promise<ConversationCommandResult> => {
        let result: Awaited<ReturnType<typeof callQuickChatProvider>>;
        try {
          result = await withTurnModelCapture(
            {
              store,
              turn,
              environment: { systemPrompt: assembleBuiltInSystemPrompt('quick-chat'), tools: [] },
            },
            (capture) =>
              callQuickChatProvider({
                authorityActor: triggerActor,
                requestId: chatInput.requestId,
                logicalModel: selection.logicalModel,
                prompt: conversationPrompt,
                history,
                sessionId,
                workspaceId,
                signal: controller.signal,
                capture,
              })
          );
          if (controller.signal.aborted) {
            throw new TurnStartValidationError(
              'provider_call_aborted',
              'Quick chat provider call was aborted.',
              499
            );
          }
        } catch (error) {
          const aborted =
            error instanceof TurnStartValidationError && error.code === 'provider_call_aborted';
          try {
            store.updateTurn(turn.id, {
              status: aborted ? 'interrupted' : 'failed',
              completedAt: new Date().toISOString(),
              error: aborted
                ? {
                    code: 'provider_call_aborted',
                    message: 'Quick chat provider call was aborted.',
                  }
                : { code: 'chat_provider_failed', message: 'Chat model work did not complete.' },
            });
            if (aborted) {
              store.recordCommandRequest({
                command: 'conversation.submit',
                requestId: chatInput.requestId,
                scope: { actorId, workspaceId, threadId },
                inputHash: commandInputHash(conversationCommandInput(chatInput)),
                response: { kind: 'turn', id: turn.id },
              });
            }
          } catch {
            throw new TurnStartValidationError(
              'recovery_required',
              'The Chat terminal failure could not be persisted.',
              409
            );
          }
          cancellationPersisted = aborted;
          throw error;
        }
        const completedAt = new Date().toISOString();

        const item = store.createItem({
          id: `it_chat_answer_${turn.id}`,
          workspaceId,
          threadId,
          turnId: turn.id,
          type: 'assistant-message',
          status: 'completed',
          text: result.content,
          createdAt: turn.startedAt ?? completedAt,
          completedAt,
        });
        const completedTurn = store.updateTurn(turn.id, {
          status: 'completed',
          completedAt,
        });

        return {
          body: ConversationCommandBodySchema.parse({
            outcome: 'answered',
            explanation: 'The Assistant answered directly.',
            turn: completedTurn,
            item,
            handoff: null,
          }),
          downstream: null,
          resultKind: 'provider-answer',
          status: 200,
        };
      })();
      const finished = execution.then(
        () => undefined,
        (error: unknown) => {
          if (!cancellationPersisted) throw error;
        }
      );
      // Observe rejection when no interrupt is waiting; the command still propagates the failure.
      void finished.catch(() => undefined);
      let runs = activeChatRuns.get(store);
      if (!runs) {
        runs = new Map();
        activeChatRuns.set(store, runs);
      }
      runs.set(turn.id, { controller, finished });
      try {
        return await execution;
      } finally {
        runs.delete(turn.id);
      }
    }

    try {
      const result = await runIdempotentCommand({
        command: 'conversation.submit',
        execute: () => executeChatCommand(store, workspaceId, threadId),
        inflightCommands,
        input: conversationCommandInput(chatInput),
        replay: async (record) => {
          const downstream = record.response.conversationMetadata?.downstream;
          if (coreDb && record.response.conversationMetadata?.resultKind === 'worker-turn') {
            const receivingWorkspaceId = record.response.conversationMetadata.receivingWorkspaceId;
            const workerDb = repositoryWorkspaceDb(receivingWorkspaceId);
            try {
              const checkpoint = getWorkerCheckpoint(
                workerDb,
                receivingWorkspaceId,
                record.response.conversationMetadata.receivingThreadId,
                record.response.id
              );
              if (
                checkpoint &&
                hasWorkerCheckpointNeverSubmittedProof(coreDb, store, workerDb, checkpoint)
              ) {
                await classifyDirectTaskCheckpointAfterSchedulerRecovery({
                  coreDb,
                  store,
                  workspaceDb: workerDb,
                  checkpoint,
                });
              }
            } finally {
              workerDb.sqlite.close();
            }
          }
          if (
            record.response.conversationMetadata?.resultKind === 'task-handoff' &&
            downstream?.kind === 'task' &&
            downstream.turnId ===
              chatTaskModeTurnId(actorId, workspaceId, threadId, record.requestId)
          ) {
            const closeout = activeTaskCloseouts.get(downstream.turnId);
            if (closeout) {
              try {
                const turn = store.getTurnById(downstream.turnId);
                if (turn.status !== 'pending' && turn.status !== 'running') await closeout;
              } catch {
                throw directTaskModeRecoveryError('The original Assistant Task closeout failed.');
              }
            }
          }
          return replayConversationCommand(
            store,
            actorId,
            repositoryWorkspaceDb,
            workspaceId,
            threadId,
            record,
            coreDb
          );
        },
        requestId: chatInput.requestId,
        responseId: ({ body }) => body.turn.id,
        responseKind: 'turn',
        conversationResponseMetadata: ({ body, downstream, resultKind, status }) => ({
          downstream,
          targetRef: chatInput.targetRef,
          logicalModelId: freshLogicalModelId,
          receivingWorkspaceId: body.turn.workspaceId,
          receivingThreadId: body.turn.threadId,
          resultKind,
          status,
        }),
        scope: { actorId, threadId, workspaceId },
        store,
      });
      const receipt = store.getCommandRequest('conversation.submit', chatInput.requestId, {
        actorId,
        threadId,
        workspaceId,
      });
      const metadata = receipt?.response.conversationMetadata;
      if (!metadata) {
        throw new TurnStartValidationError(
          'recovery_required',
          'Conversation result is missing its command receipt metadata.',
          409
        );
      }

      return {
        body: SubmitConversationResponseSchema.parse({
          ...result.body,
          originatingWorkspaceId: workspaceId,
          originatingThreadId: threadId,
          receivingWorkspaceId: metadata.receivingWorkspaceId,
          receivingThreadId: metadata.receivingThreadId,
          targetRef: metadata.targetRef,
          logicalModelId: metadata.logicalModelId,
        }),
        status: result.status,
      };
    } catch (error) {
      if (error instanceof HTTPException) {
        throw error;
      }
      if (
        !(error instanceof TurnStartValidationError) &&
        !(error instanceof OpenAICompatibleProviderError) &&
        !(error instanceof IdempotencyKeyConflictError) &&
        coreDb
      ) {
        const workspaceDb = repositoryWorkspaceDb(workspaceId);
        try {
          if (
            hasChatTaskCheckpointWithoutReceipt(
              store,
              workspaceDb,
              actorId,
              workspaceId,
              threadId,
              chatInput.requestId
            )
          ) {
            throw new TurnStartValidationError(
              'recovery_required',
              'The Chat Task checkpoint is missing its outer Chat command receipt.',
              409
            );
          }
        } finally {
          workspaceDb.sqlite.close();
        }
      }
      if (error instanceof TurnStartValidationError) {
        throw new TurnStartValidationError(
          error.code,
          redactInternalAgentText(error.message),
          error.status
        );
      }
      if (
        error instanceof OpenAICompatibleProviderError ||
        error instanceof LogicalModelRoutesExhaustedError
      ) {
        throw providerCommandError(error);
      }
      if (error instanceof IdempotencyKeyConflictError) {
        throw new TurnStartValidationError(
          error.code,
          redactInternalAgentText(error.message),
          error.status
        );
      }

      console.error(
        'chat_mode_failed',
        redactInternalAgentText(error instanceof Error ? error.message : String(error))
      );
      throw new TurnStartValidationError('chat_mode_failed', 'Chat Mode failed.', 500);
    }
  }

  return {
    quick,
    targets,
    submit,
    async interrupt(store: FsStore, turnId: string) {
      const run = activeChatRuns.get(store)?.get(turnId);
      if (!run) return false;
      run.controller.abort();
      // Success requires the product owner to persist interruption, not just signal the provider.
      await run.finished;
      return true;
    },
    async acceptPendingInput(store: FsStore, turnId: string) {
      const turn = store.getTurnById(turnId);
      const actorId = responsibleUserIdForActor(turn.triggerActor);
      if (
        !actorId ||
        !coreDb ||
        !currentWorkspaceAuthority(coreDb, turn.workspaceId, turn.triggerActor, 'turn.run', true)
      )
        throw new TurnStartValidationError(
          'workspace_access_denied',
          'Workspace access denied.',
          403
        );
      const workspaceDb = repositoryWorkspaceDb(turn.workspaceId);
      let prompt: string;
      let sourceInputHash: string;
      let sourceItemIds: string[];
      let selection: ReturnType<typeof quickChatSelection>;
      try {
        const frozen = listThreadPendingRequests(
          workspaceDb.sqlite,
          turn.workspaceId,
          turn.threadId
        ).filter(
          (record) =>
            record.delivery === 'frozen' &&
            record.deliveryTurnId === turn.id &&
            record.requesterKind === 'assistant'
        );
        if (!frozen.length)
          throw new TurnStartValidationError(
            'recovery_required',
            'The Assistant input association is missing.',
            409
          );
        prompt = frozen.every((record) => record.resolution === 'answered')
          ? frozen
              .flatMap((record) => Object.values(record.answerMap ?? {}).map((answer) => answer[0]))
              .join('\n')
          : frozenPendingOutcomeInput(
              workspaceDb.sqlite,
              turn.id,
              'Receive pending request outcomes.'
            );
        sourceInputHash = assistantPendingOutcomeSourceHash(turn, frozen, actorId);
        sourceItemIds = frozen.map((record) => record.requestItemId);
        selection = quickChatSelection(actorId, turn.workspaceId);
        if (!selection)
          throw new TurnStartValidationError(
            'target_unavailable',
            'The Assistant model is unavailable.',
            409
          );
        // The frozen association and admitted Assistant Turn are the durable input owner.
        // Acceptance precedes model contact and does not fabricate a conversation command.
        proveFrozenDelivery(workspaceDb.sqlite, turn.id, new Date().toISOString());
      } finally {
        workspaceDb.sqlite.close();
      }
      try {
        const delegation = createTaskModeDelegation({
          entryIntent: 'conversation',
          store,
          workspaceId: turn.workspaceId,
          threadId: turn.threadId,
          prompt,
          workerCoordinatorCandidates,
        });
        if (delegation.taskDecision && delegation.coordinator.workerRequest) {
          assertProjectWorkspace(store.getWorkspace(turn.workspaceId), 'handle project work');
          const requestId = `pending_${sourceInputHash}`;
          const receivingThreadId = `th_task_${sourceInputHash.slice(0, 24)}`;
          const taskTurnId = `tu_task_${sourceInputHash.slice(0, 24)}`;
          if (store.listThreads(turn.workspaceId).some((thread) => thread.id === receivingThreadId))
            throw new TurnStartValidationError(
              'recovery_required',
              'The Assistant handoff tuple already exists.',
              409
            );
          store.createThread(
            turn.workspaceId,
            prompt.split(/\r?\n/, 1)[0] || 'Clarified task',
            receivingThreadId,
            'conversation',
            { visibility: 'workspace' }
          );
          const taskDb = repositoryWorkspaceDb(turn.workspaceId);
          const workerRequest = {
            ...delegation.coordinator.workerRequest,
            contextRefs: [
              ...delegation.coordinator.workerRequest.contextRefs,
              ...sourceItemIds.map((id) => ({ kind: 'item' as const, id })),
            ],
          };
          try {
            await runWorkerTurnLoop({
              store,
              coreDb,
              triggerActor: turn.triggerActor,
              workspaceDb: taskDb,
              workspaceId: turn.workspaceId,
              threadId: receivingThreadId,
              requestId,
              requestInputHash: sourceInputHash,
              reviewRequired: false,
              prepare: () => ({
                delegationRequest: workerRequest,
                contextPackageDigest: commandInputHash(workerRequest),
                knowledgeSelectionInput: null,
              }),
              reservedTurnId: taskTurnId,
              reserveTurn: () => ({ turnId: taskTurnId }),
              startWorker: async ({ turnId: reservedTurnId, prepared, onAdmitted }) => {
                const worker = await startModeWorkerTurn({
                  store,
                  triggerActor: turn.triggerActor,
                  workspaceId: turn.workspaceId,
                  threadId: receivingThreadId,
                  prompt: serializeStructuredWorkerDelegationRequest(prepared.delegationRequest),
                  requestId,
                  requestedAgentId: delegation.taskDecision!.worker.agentId,
                  reservedTurnId,
                  onTurnCreated: onAdmitted,
                });
                return { workerSessionId: worker.agentSessionId ?? null };
              },
              awaitWorker: ({ turnId: workerTurnId }) => {
                const worker = store.getTurnById(workerTurnId);
                const stopReason = taskModeTerminalStopReason(store, workerTurnId);
                if (!stopReason)
                  throw new TurnStartValidationError(
                    'recovery_required',
                    'The Assistant Task has no unique terminal outcome.',
                    409
                  );
                const evidence = taskModeEvidenceForTurn(
                  store,
                  taskDb,
                  turn.workspaceId,
                  receivingThreadId,
                  worker
                );
                return {
                  stopReason,
                  itemIds: evidence.itemIds,
                  artifactIds: evidence.artifactIds,
                  diagnosticsSummary: worker.error?.message ?? null,
                };
              },
            });
          } finally {
            taskDb.sqlite.close();
          }
          const completedAt = new Date().toISOString();
          store.createItem({
            id: `it_chat_task_${turn.id}`,
            workspaceId: turn.workspaceId,
            threadId: turn.threadId,
            turnId: turn.id,
            type: 'status',
            status: 'completed',
            level: 'info',
            title: 'Task Mode handoff',
            summary: delegation.taskDecision.rationale,
            causationId: taskTurnId,
            createdAt: turn.startedAt ?? completedAt,
            completedAt,
          });
          store.updateTurn(turn.id, { status: 'completed', completedAt });
          return;
        }
        if (delegation.coordinator.decision === 'goal') {
          if (store.getThread(turn.workspaceId, turn.threadId).visibility === 'private')
            throw new TurnStartValidationError(
              'handoff_disclosure_required',
              'Private Assistant outcomes need explicit disclosure admission before shared Goal work.',
              409
            );
          const db = repositoryWorkspaceDb(turn.workspaceId);
          try {
            await executeGoalOperation(
              'goal.create',
              {
                workspaceId: turn.workspaceId,
                requestId: goalHandoffRequestId(
                  actorId,
                  turn.workspaceId,
                  turn.threadId,
                  sourceInputHash
                ),
                intent: prompt,
                originThreadId: turn.threadId,
              },
              { actor: { kind: 'session', userId: actorId }, originTurnId: turn.id },
              store,
              db,
              goalServices?.()
            );
          } finally {
            db.sqlite.close();
          }
          store.updateTurn(turn.id, { status: 'completed', completedAt: new Date().toISOString() });
          return;
        }
        const history = store
          .listThreadItems(turn.workspaceId, turn.threadId)
          .flatMap<OpenAICompatibleChatMessage>((item) =>
            item.status === 'completed' &&
            (item.type === 'user-message' || item.type === 'assistant-message')
              ? [{ role: item.type === 'user-message' ? 'user' : 'assistant', content: item.text }]
              : []
          );
        const result = await withTurnModelCapture(
          {
            store,
            turn,
            environment: { systemPrompt: assembleBuiltInSystemPrompt('quick-chat'), tools: [] },
          },
          (capture) =>
            callQuickChatProvider({
              authorityActor: turn.triggerActor,
              logicalModel: selection.logicalModel,
              prompt,
              history,
              sessionId: `chat:${turn.workspaceId}:${turn.threadId}`,
              workspaceId: turn.workspaceId,
              signal: new AbortController().signal,
              capture,
            })
        );
        const completedAt = new Date().toISOString();
        store.createItem({
          id: `it_chat_answer_${turn.id}`,
          workspaceId: turn.workspaceId,
          threadId: turn.threadId,
          turnId: turn.id,
          type: 'assistant-message',
          status: 'completed',
          text: result.content,
          createdAt: turn.startedAt ?? completedAt,
          completedAt,
        });
        store.updateTurn(turn.id, { status: 'completed', completedAt });
      } catch (error) {
        store.updateTurn(turn.id, {
          status: 'failed',
          completedAt: new Date().toISOString(),
          error: { code: 'chat_provider_failed', message: 'Chat model work did not complete.' },
        });
        throw error;
      }
    },
  };
}

/**
 * Creates the ordinary bounded Task command, preserving its receipt and checkpoint owners.
 *
 * @param dependencies Existing Task admission and worker owners.
 * @returns Transport-free Task start command.
 */
export function createTaskStartOperation({
  assertProjectWorkspace,
  coreDb,
  inflightCommands,
  workspaceMutationAdmission,
  repositoryWorkspaceDb,
  startModeWorkerTurn,
  workerCoordinatorCandidates,
}: {
  readonly assertProjectWorkspace: (
    workspace: ReturnType<FsStore['getWorkspace']>,
    action: string
  ) => void;
  readonly coreDb: CoreDb | undefined;
  readonly workspaceMutationAdmission: WorkspaceMutationAdmission;
  readonly inflightCommands: WeakMap<FsStore, Map<string, InflightIdempotentCommand>>;
  readonly repositoryWorkspaceDb: (workspaceId: string) => WorkspaceDb;
  readonly startModeWorkerTurn: (input: {
    readonly triggerActor: ActorRef;
    readonly requestActor?: Actor;
    readonly store: FsStore;
    readonly workspaceId: string;
    readonly threadId: string;
    readonly prompt: string;
    readonly modelId?: string | undefined;
    readonly requestId: string;
    readonly requestedAgentId: string;
    readonly reservedTurnId?: string | undefined;
    readonly workerStorageChoice?: SchedulerWorkerStorageChoice;
    readonly onTurnCreated?: (
      turn: z.infer<typeof TurnSchema>,
      agentSessionId: string | null
    ) => void;
  }) => Promise<z.infer<typeof TurnSchema>>;
  readonly workerCoordinatorCandidates: (
    store: FsStore,
    workspaceId: string
  ) => WorkerCoordinatorCandidate[];
}) {
  // One App-local owner per original Turn prevents replay from competing with its collector.
  const activeTaskCloseouts = new Map<string, Promise<void>>();
  return async (
    store: FsStore,
    taskInput: z.infer<typeof StartTaskModeRequestSchema> & {
      workspaceId: string;
      threadId: string;
    },
    actor: Actor
  ): Promise<StartTaskModeResponse> => {
    const { workspaceId, threadId } = taskInput;
    const triggerActor = {
      kind: 'user',
      id: actor.userId,
    } as const satisfies ActorRef;
    const actorId = triggerActor.id;
    const requestInputHash = commandInputHash({
      input: taskInput.input,
      modelId: taskInput.modelId,
      workerStorageChoice: taskInput.workerStorageChoice,
    });

    let resolveReceiptPublished!: () => void;
    const receiptPublished = new Promise<void>((resolve) => {
      resolveReceiptPublished = resolve;
    });
    let backgroundCloseout: Promise<void> | undefined;
    let joinedCloseout = false;

    /**
     * Collects a terminal checkpoint only after the exact receipt and closeout owners agree.
     *
     * @param workspaceDb Database retained by worker execution through closeout.
     */
    async function closeoutTaskCommand(workspaceDb: WorkspaceDb): Promise<void> {
      const turnId = directTaskModeTurnId(actorId, workspaceId, threadId, taskInput.requestId);
      const checkpoint = getWorkerCheckpoint(workspaceDb, workspaceId, threadId, turnId);
      if (!checkpoint) return;
      const receipt = store.getCommandRequest('task.start', taskInput.requestId, {
        actorId,
        workspaceId,
        threadId,
      });
      if (
        !receipt ||
        receipt.inputHash !== requestInputHash ||
        receipt.response.kind !== 'turn' ||
        receipt.response.id !== turnId
      ) {
        throw directTaskModeRecoveryError('The Task receipt contradicts its worker checkpoint.');
      }
      const recovered = recoverDirectTaskModeCheckpoint({
        coreDb: coreDb!,
        store,
        workspaceDb,
        workspaceId,
        threadId,
        requestId: taskInput.requestId,
        requestInputHash,
        turnId,
        checkpoint,
      });
      if (
        classifyClosedWorkerApprovalGate(store, TurnSchema.parse(recovered.turn)) ??
        classifyClosedWorkerUserInputGate(store, TurnSchema.parse(recovered.turn))
      ) {
        throw directTaskModeRecoveryError('The Task Gate response receipt is not durable.');
      }
      if (
        checkpoint.stage !== 'waiting_for_user' &&
        !(await clearWorkerCheckpointAfterTerminalState(workspaceDb, {
          coreDb: coreDb!,
          store,
          workspaceId,
          threadId,
          turnId,
        }))
      ) {
        throw directTaskModeRecoveryError(
          'The Task worker checkpoint is not ready for terminal cleanup.'
        );
      }
    }

    /**
     * Executes one fresh direct Task command after the ledger accepts its identity.
     *
     * @param store Store that owns the Task Thread.
     * @param workspaceId Workspace bound into the command scope.
     * @param threadId Thread bound into the command scope.
     * @returns Accepted Task response.
     */
    async function executeTaskCommand(
      store: FsStore,
      workspaceId: string,
      threadId: string
    ): Promise<StartTaskModeResponse> {
      const workspace = store.getWorkspace(workspaceId);

      assertProjectWorkspace(workspace, 'start Task Mode');
      if (store.getThread(workspaceId, threadId).visibility !== 'workspace') {
        throw new TurnStartValidationError(
          'shared_thread_required',
          'Formal work requires a new Workspace-shared Thread and admitted inputs.',
          409
        );
      }
      if (!coreDb) {
        throw new TurnStartValidationError(
          'scheduler_unavailable',
          'Durable scheduler storage is required to start Task Mode.',
          503
        );
      }

      const reservedTurnId = directTaskModeTurnId(
        actorId,
        workspaceId,
        threadId,
        taskInput.requestId
      );
      const recoveryDb = repositoryWorkspaceDb(workspaceId);
      try {
        const checkpoint = getWorkerCheckpoint(recoveryDb, workspaceId, threadId, reservedTurnId);
        if (checkpoint) {
          return recoverDirectTaskModeCheckpoint({
            coreDb,
            store,
            workspaceDb: recoveryDb,
            workspaceId,
            threadId,
            requestId: taskInput.requestId,
            requestInputHash,
            turnId: reservedTurnId,
            checkpoint,
          });
        }
        // The cancelled scheduler row survives live preparation removal and still owns this request.
        if (
          coreDb.sqlite
            .prepare('SELECT 1 FROM scheduler_admission_entries WHERE turn_id = ? LIMIT 1')
            .get(reservedTurnId)
        ) {
          throw directTaskModeRecoveryError(
            'The Task request has retained admission effects without its checkpoint.'
          );
        }
      } finally {
        recoveryDb.sqlite.close();
      }

      const delegation = createTaskModeDelegation({
        entryIntent: 'explicit_task',
        store,
        workspaceId,
        threadId,
        prompt: taskInput.input,
        workerCoordinatorCandidates,
      });

      const taskDecision = delegation.taskDecision;
      const workerRequest = delegation.coordinator.workerRequest;
      if (!taskDecision || !workerRequest) {
        throw new TurnStartValidationError(
          'task_mode_not_delegated',
          delegation.coordinator.explanation,
          409
        );
      }
      const workerStorageChoice = directTaskWorkerStorageChoice(taskInput.workerStorageChoice);

      const workspaceDb = repositoryWorkspaceDb(workspaceId);
      const observed = observeTurnAdmission({
        execute: async (admit) => {
          await runWorkerTurnLoop({
            store,
            coreDb,
            triggerActor,
            requestActor: actor,
            workspaceDb,
            workspaceId,
            threadId,
            requestId: taskInput.requestId,
            requestInputHash,
            reviewRequired: false,
            prepare: async () => {
              const dataRoot = store.getDataRoot();
              if (!dataRoot) {
                throw directTaskModeRecoveryError(
                  'Task Knowledge retrieval requires a file-backed data root.'
                );
              }

              let knowledgeSelectionInput: { readonly retrievalTraceId: string };
              try {
                knowledgeSelectionInput = await createTaskKnowledgePreparation({
                  coreDb,
                  store,
                  repositoryWorkspaceDb,
                  workspaceMutationAdmission,
                })(
                  { workspaceId, query: taskInput.input },
                  {
                    actor: actor,
                    traceId: directTaskKnowledgeRetrievalTraceId(
                      actorId,
                      workspaceId,
                      threadId,
                      taskInput.requestId
                    ),
                  }
                );
              } catch (error) {
                throw directTaskModeRecoveryError(
                  error instanceof Error &&
                    error.message === 'Duplicate Knowledge retrieval trace id.'
                    ? 'Task Knowledge retrieval exists without a provable worker owner.'
                    : 'Task Knowledge retrieval could not establish one coherent selection.'
                );
              }

              return {
                delegationRequest: workerRequest,
                contextPackageDigest: commandInputHash(workerRequest),
                knowledgeSelectionInput,
              };
            },
            reservedTurnId,
            reserveTurn: () => ({ turnId: reservedTurnId }),
            startWorker: async ({ turnId, prepared, onAdmitted }) => {
              const turn = await startModeWorkerTurn({
                triggerActor,
                requestActor: actor,
                store,
                workspaceId,
                threadId,
                prompt: serializeStructuredWorkerDelegationRequest(prepared.delegationRequest),
                modelId: taskInput.modelId,
                requestId: taskInput.requestId,
                requestedAgentId: taskDecision.worker.agentId,
                reservedTurnId: turnId,
                ...(workerStorageChoice ? { workerStorageChoice } : {}),
                onTurnCreated: (created, agentSessionId) => {
                  onAdmitted(created, agentSessionId);
                  validateLiveTaskAdmission({
                    coreDb,
                    store,
                    workspaceDb,
                    actorId,
                    workspaceId,
                    threadId,
                    requestId: taskInput.requestId,
                    requestInputHash,
                    turnId,
                    contextDigest: prepared.contextPackageDigest,
                  });
                  admit(created);
                },
              });
              return { workerSessionId: turn.agentSessionId ?? null };
            },
            awaitWorker: ({ turnId }) => {
              const turn = store.getTurn(workspaceId, threadId, turnId);
              const stopReason = taskModeTerminalStopReason(store, turnId);
              if (!stopReason) {
                throw new Error('Task worker Turn has no unique terminal outcome.');
              }
              const evidence = taskModeEvidenceForTurn(
                store,
                workspaceDb,
                workspaceId,
                threadId,
                turn
              );
              return {
                stopReason,
                itemIds: evidence.itemIds,
                artifactIds: evidence.artifactIds,
                diagnosticsSummary:
                  turn.error?.message ??
                  (turn.status === 'completed' ? null : 'Worker turn ended without success.'),
              };
            },
          });
          const checkpoint = getWorkerCheckpoint(
            workspaceDb,
            workspaceId,
            threadId,
            reservedTurnId
          );
          if (!checkpoint) {
            throw directTaskModeRecoveryError('The Task worker checkpoint is unavailable.');
          }
          return recoverDirectTaskModeCheckpoint({
            coreDb,
            store,
            workspaceDb,
            workspaceId,
            threadId,
            requestId: taskInput.requestId,
            requestInputHash,
            turnId: reservedTurnId,
            checkpoint,
          });
        },
        closeout: async () => {
          await receiptPublished;
          await closeoutTaskCommand(workspaceDb);
        },
        settled: () => {
          activeTaskCloseouts.delete(reservedTurnId);
          workspaceDb.sqlite.close();
        },
        failed: () => console.error('task_worker_closeout_failed_after_admission'),
      });
      backgroundCloseout = observed.closeout;
      activeTaskCloseouts.set(reservedTurnId, backgroundCloseout);
      await observed.accepted;
      const turn = store.getTurn(workspaceId, threadId, reservedTurnId);
      if (turn.status !== 'pending' && turn.status !== 'running') return observed.execution;
      validateLiveTaskAdmission({
        coreDb,
        store,
        workspaceDb,
        actorId,
        workspaceId,
        threadId,
        requestId: taskInput.requestId,
        requestInputHash,
        turnId: reservedTurnId,
      });
      return StartTaskModeResponseSchema.parse({
        state: pendingRequestTaskState(store, workspaceDb, workspaceId, threadId, 'running'),
        turn,
        completion: null,
        evidence: taskModeEvidenceForTurn(store, workspaceDb, workspaceId, threadId, turn),
      });
    }

    try {
      store.getThread(workspaceId, threadId);
      const result = await runIdempotentCommand({
        command: 'task.start',
        execute: () => executeTaskCommand(store, workspaceId, threadId),
        inflightCommands,
        input: {
          input: taskInput.input,
          modelId: taskInput.modelId,
          workerStorageChoice: taskInput.workerStorageChoice,
        },
        replay: async (record) => {
          const turnId = directTaskModeTurnId(actorId, workspaceId, threadId, record.requestId);
          const closeout = activeTaskCloseouts.get(turnId);
          if (
            !closeout &&
            coreDb &&
            record.response.kind === 'turn' &&
            record.response.id === turnId
          ) {
            const workspaceDb = repositoryWorkspaceDb(workspaceId);
            try {
              const checkpoint = getWorkerCheckpoint(workspaceDb, workspaceId, threadId, turnId);
              if (
                checkpoint &&
                hasWorkerCheckpointNeverSubmittedProof(coreDb, store, workspaceDb, checkpoint)
              ) {
                await classifyDirectTaskCheckpointAfterSchedulerRecovery({
                  coreDb,
                  store,
                  workspaceDb,
                  checkpoint,
                });
              }
            } finally {
              workspaceDb.sqlite.close();
            }
          }
          if (closeout && record.response.kind === 'turn' && record.response.id === turnId) {
            try {
              const turn = store.getTurnById(turnId);
              if (turn.status !== 'pending' && turn.status !== 'running') {
                joinedCloseout = true;
                await closeout;
              }
            } catch {
              throw directTaskModeRecoveryError('The original Task worker closeout failed.');
            }
          }
          return replayTaskModeCommand(
            store,
            actorId,
            coreDb,
            repositoryWorkspaceDb,
            workspaceId,
            threadId,
            record
          );
        },
        requestId: taskInput.requestId,
        responseId: ({ turn }) => turn.id,
        responseKind: 'turn',
        scope: { actorId, threadId, workspaceId },
        store,
      });

      resolveReceiptPublished();
      if (coreDb && !backgroundCloseout && !joinedCloseout) {
        const workspaceDb = repositoryWorkspaceDb(workspaceId);
        try {
          const turn = store.getTurnById(result.turn.id);
          if (
            turn.id === directTaskModeTurnId(actorId, workspaceId, threadId, taskInput.requestId) &&
            turn.status !== 'pending' &&
            turn.status !== 'running'
          ) {
            // A live replay can become terminal while the ledger result is being delivered.
            const closeout = activeTaskCloseouts.get(turn.id);
            if (closeout) {
              try {
                await closeout;
              } catch {
                throw directTaskModeRecoveryError('The original Task worker closeout failed.');
              }
            } else await closeoutTaskCommand(workspaceDb);
          }
        } finally {
          workspaceDb.sqlite.close();
        }
      }

      return result;
    } catch (error) {
      if (error instanceof HTTPException) {
        throw error;
      }
      if (error instanceof TurnStartValidationError) {
        throw error;
      }
      if (error instanceof IdempotencyKeyConflictError) {
        throw error;
      }

      if (coreDb) {
        const workspaceDb = repositoryWorkspaceDb(workspaceId);
        let checkpoint: WorkerCheckpointRecord | null = null;
        try {
          checkpoint = getWorkerCheckpoint(
            workspaceDb,
            workspaceId,
            threadId,
            directTaskModeTurnId(actorId, workspaceId, threadId, taskInput.requestId)
          );
        } finally {
          workspaceDb.sqlite.close();
        }
        if (checkpoint?.requestId === taskInput.requestId) {
          throw new TurnStartValidationError(
            'recovery_required',
            redactInternalAgentText(
              publishedErrorMessage(error, error instanceof Error ? undefined : String(error))
            ),
            409
          );
        }
      }

      console.error(
        'task_mode_start_failed',
        redactInternalAgentText(error instanceof Error ? error.message : String(error))
      );
      throw new TurnStartValidationError(
        'task_mode_start_failed',
        publishedErrorMessage(error),
        404
      );
    } finally {
      resolveReceiptPublished();
    }
  };
}

/** Stable Goal command identity derived from the originating command, including opaque historical request ids. */
function goalHandoffRequestId(
  actorId: string,
  workspaceId: string,
  threadId: string,
  requestId: string
): string {
  const hex = createHash('sha256')
    .update(JSON.stringify([actorId, workspaceId, threadId, requestId]))
    .digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Preserves provider status and bounded refusal text for transport-free conversation invocation. */
function providerCommandError(
  error: OpenAICompatibleProviderError | LogicalModelRoutesExhaustedError
): TurnStartValidationError {
  if (error instanceof LogicalModelRoutesExhaustedError)
    return new TurnStartValidationError(error.code, error.message, error.status);
  return new TurnStartValidationError(
    error.status === 429 ? 'provider_rate_limited' : 'provider_request_failed',
    error.status === 429 ? 'Provider rate limit exceeded.' : 'Provider request failed.',
    error.status
  );
}
