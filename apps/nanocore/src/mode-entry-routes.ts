import { createHash, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, relative, resolve, sep } from 'node:path';

import {
  ConversationTargetCatalogSchema,
  QuickChatRequestSchema,
  QuickChatResponseSchema,
  StartTaskModeRequestSchema,
  type StartTaskModeResponse,
  StartTaskModeResponseSchema,
  SubmitConversationRequestSchema,
  SubmitConversationResponseSchema,
  type TaskDelegationDecision,
  type TaskModeEvidence,
} from '@openkit/app-api-schemas';
import { type ActorRef, type StopReason, TurnSchema } from '@openkit/protocol';
import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { z } from 'zod';
import { resolveAgentSetup } from './agents/setup-resolver.js';
import {
  apiErrorPayload,
  asApiError,
  asCommandError,
  asInvalidRequestError,
} from './api-errors.js';
import type { AuthVariables } from './auth/middleware.js';
import { assertAuthorizedWorkspaceLineage } from './auth/operation-authorizer.js';
import {
  finishCapabilityCall,
  normalizeCapabilityRequestId,
  recordUsage,
  startCapabilityCall,
} from './capability/usage-ledger.js';
import {
  findWorkspaceConfig,
  type RuntimeConfigSnapshot,
  resolveDefaultAgentId,
} from './config/runtime-config.js';
import {
  goalStartOwnerIds,
  startGoalModeObjective,
  submitGoalSteeringCommand,
} from './goal-routes.js';
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
import {
  answerKnowledgeManager,
  prepareTaskKnowledgeContext,
  resolveWorkspaceKnowledgeReferenceProofs,
} from './knowledge-manager.js';
import type {
  CommandRequestRecord,
  ConversationCommandReceiptMetadata,
  FsStore,
} from './lib/store.js';
import { dispatchLogicalModel, LogicalModelRoutesExhaustedError } from './llm/gateway-routes.js';
import { parseUsage } from './llm/gateway-usage.js';
import type { ResolvedLogicalModel } from './llm/logical-models.js';
import { OpenAICompatibleProviderError } from './llm/openai-compatible-client.js';
import type { LLMGatewayProviderDispatcher } from './llm/provider-dispatcher.js';
import type { ProviderSubscriptionAccountManager } from './llm/provider-subscription-accounts.js';
import { registerAppApiRoute } from './openapi.js';
import type { ResolvedLLMProviderConfig } from './providers/llm-config.js';
import { getGoalRecord, listGoalRecordsForThread } from './runtime/goal-store.js';
import {
  chatTaskModeTurnId,
  commandInputHash,
  IdempotencyKeyConflictError,
  type InflightIdempotentCommand,
  runIdempotentCommand,
} from './runtime/idempotent-command.js';
import { TurnStartValidationError } from './runtime/orchestrator.js';
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
  recoverWorkerCheckpointStopReason,
  resolveInterruptedWorkerRetryDecision,
} from './runtime/worker-recovery.js';
import { workerTurnStageForStopReason } from './runtime/worker-stage.js';
import { runWorkerTurnLoop } from './runtime/worker-turn-loop.js';
import { listWorkspaceSyncReviews } from './runtime/workspace-sync-records.js';
import {
  listSchedulerSessionLeasesForTurn,
  requireSchedulerSessionLeaseAdmissionContext,
} from './scheduler-records.js';
import { type CoreDb, openWorkspaceDb, type WorkspaceDb } from './storage/db.js';
import { applyScopedMigrations } from './storage/migrate.js';
import {
  getDefaultWorkspaceRepositoryResource,
  type WorkspaceRepositoryResourceRecord,
} from './workspace/repository-store.js';

/** Stable attribution id for the direct Quick Chat provider call. */
const QUICK_CHAT_AGENT_ID = 'quick-chat';

/** Fixed role instruction for the bounded Quick Chat provider call. */
const QUICK_CHAT_SYSTEM_PROMPT =
  'You are QuickChatAgent, a lightweight OpenKit Core coordination agent. Answer concise user questions without running worker agents, shell commands, browser automation, file edits, or knowledge writes.';

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
  'repository-answer': 'it_chat_repo_files_',
  'provider-answer': 'it_chat_answer_',
  clarification: 'it_chat_clarify_',
  'task-handoff': 'it_chat_task_',
  'goal-handoff': 'it_chat_goal_',
  'worker-turn': 'it_worker_result_',
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
  record: CommandRequestRecord
): ConversationCommandResult {
  try {
    const metadata = record.response.conversationMetadata;
    if (!metadata) {
      throw new Error('Chat command receipt metadata is missing.');
    }
    const currentTurn = store.getTurnById(record.response.id);
    const itemRevisions = store.listWorkspaceItemRevisions(workspaceId);
    if (
      currentTurn.workspaceId !== metadata.receivingWorkspaceId ||
      currentTurn.threadId !== metadata.receivingThreadId
    ) {
      throw new Error('Conversation receiving lineage is contradictory.');
    }
    if (metadata.resultKind === 'worker-turn') {
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
      return {
        body: ConversationCommandBodySchema.parse({
          outcome: 'accepted',
          explanation: 'The selected Worker accepted the conversation Turn.',
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
      const workspaceDb = repositoryWorkspaceDb(metadata.receivingWorkspaceId);
      try {
        const goal = getGoalRecord(
          workspaceDb,
          metadata.receivingWorkspaceId,
          metadata.receivingThreadId,
          metadata.downstream.goalId
        );
        if (!goal) throw new Error('Conversation Goal steering owner is missing.');
      } finally {
        workspaceDb.sqlite.close();
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
            status: 'awaiting_human',
            humanGate: {
              kind: 'user-input',
              userInputRequestId: resultItem.userInputRequestId,
              itemId: resultItem.id,
            },
            error: null,
            completedAt: null,
            durationMs: null,
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

    if (
      metadata.resultKind === 'knowledge-answer' ||
      metadata.resultKind === 'repository-answer' ||
      metadata.resultKind === 'provider-answer'
    ) {
      if (
        resultItem.type !== 'assistant-message' ||
        resultItem.status !== 'completed' ||
        metadata.downstream !== null ||
        (metadata.resultKind === 'repository-answer'
          ? metadata.status !== 202
          : metadata.status !== 200)
      ) {
        throw new Error('Chat answer owner contradiction.');
      }

      outcome = 'answered';
      explanation =
        metadata.resultKind === 'knowledge-answer'
          ? 'The Knowledge Manager answered from Workspace Knowledge.'
          : metadata.resultKind === 'repository-answer'
            ? 'The Assistant answered from a read-only repository inspection.'
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
        !downstreamTurn.items.some(
          (item) =>
            item.id === `it_user_${downstreamTurn.id}` &&
            item.type === 'user-message' &&
            item.status === 'completed'
        )
      ) {
        throw new Error('Chat Task downstream owner contradiction.');
      }

      outcome = 'task-handoff';
      explanation = resultItem.summary;
      handoff = { targetMode: 'task', reason: resultItem.summary, statusItemId: resultItem.id };
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

      const goalTurn = store.getTurnById(metadata.downstream.turnId);
      const ids = goalStartOwnerIds({
        actorId,
        owningCommand: 'conversation.submit',
        requestId: record.requestId,
        workspaceId,
        threadId,
      });
      const workspaceDb = repositoryWorkspaceDb(workspaceId);

      try {
        const goal = getGoalRecord(workspaceDb, workspaceId, threadId, metadata.downstream.goalId);
        const creationItem = goal?.createdByItemId
          ? goalTurn.items.find((item) => item.id === goal.createdByItemId)
          : null;

        if (
          goalTurn.id === currentTurn.id ||
          goalTurn.id !== ids.turnId ||
          goalTurn.workspaceId !== workspaceId ||
          goalTurn.threadId !== threadId ||
          goalTurn.status !== 'completed' ||
          !goalTurn.completedAt ||
          creationItem?.type !== 'user-message' ||
          creationItem.id !== ids.objectiveItemId ||
          creationItem.status !== 'completed' ||
          !creationItem.completedAt ||
          creationItem.causationId !== record.requestId ||
          goal?.goalId !== ids.goalId ||
          creationItem.text !== goal?.objective
        ) {
          throw new Error('Chat Goal downstream owner contradiction.');
        }
      } finally {
        workspaceDb.sqlite.close();
      }

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
          state: closedGate
            ? closedGate.stopReason === 'aborted'
              ? 'cancelled'
              : 'blocked'
            : taskModeStateForStopReason(stopReason),
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
    const ids = goalStartOwnerIds({
      actorId,
      owningCommand: 'task.start',
      requestId: record.requestId,
      workspaceId,
      threadId,
    });
    const workspaceDb = repositoryWorkspaceDb(workspaceId);

    try {
      const goal = goalId ? getGoalRecord(workspaceDb, workspaceId, threadId, goalId) : null;
      const creationItem = goal?.createdByItemId
        ? currentTurn.items.find((item) => item.id === goal.createdByItemId)
        : null;

      if (
        !goal ||
        goal.goalId !== ids.goalId ||
        currentTurn.id !== ids.turnId ||
        currentTurn.status !== 'completed' ||
        !currentTurn.completedAt ||
        creationItem?.type !== 'user-message' ||
        creationItem.id !== ids.objectiveItemId ||
        creationItem.status !== 'completed' ||
        !creationItem.completedAt ||
        creationItem.causationId !== record.requestId ||
        creationItem.text !== goal.objective ||
        statusItem.status !== 'completed' ||
        !statusItem.completedAt ||
        !statusItem.summary
      ) {
        throw new Error('Task escalation owner contradiction.');
      }

      return StartTaskModeResponseSchema.parse({
        state: 'escalated-to-goal',
        turn: currentTurn,
        evidence: taskModeEvidenceForTurn(store, workspaceDb, workspaceId, threadId, currentTurn),
        escalation: {
          targetMode: 'goal',
          goalId: goal.goalId,
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
    state: closedGate
      ? closedGate.stopReason === 'aborted'
        ? 'cancelled'
        : 'blocked'
      : taskModeStateForStopReason(stopReason),
    turn,
    completion: closedGate
      ? null
      : taskModeCompletionForTurn(input.store, input.workspaceId, input.threadId, turn),
    evidence: currentEvidence,
  });
}

/**
 * Classifies one direct Task checkpoint after scheduler restart fencing.
 *
 * @param input Exact Core, product, Workspace, and checkpoint owners.
 * @returns `live` for a reconnectable or human-gated Turn, otherwise `complete` after receipt-first cleanup.
 * @throws TurnStartValidationError when the durable owner tuple cannot prove one safe outcome.
 */
export async function classifyDirectTaskCheckpointAfterSchedulerRecovery(input: {
  readonly coreDb: CoreDb;
  readonly store: FsStore;
  readonly workspaceDb: WorkspaceDb;
  readonly checkpoint: WorkerCheckpointRecord;
}): Promise<'complete' | 'live'> {
  const { checkpoint } = input;
  const leases = listSchedulerSessionLeasesForTurn(input.coreDb, {
    workspaceId: checkpoint.workspaceId,
    threadId: checkpoint.threadId,
    turnId: checkpoint.turnId,
  });
  const lease = leases[0];
  if (leases.length !== 1 || !lease || lease.agentSessionId !== checkpoint.workerSessionId) {
    throw directTaskModeRecoveryError('The boot Task checkpoint has no exact scheduler lease.');
  }
  let admission: ReturnType<typeof requireSchedulerSessionLeaseAdmissionContext>;
  try {
    admission = requireSchedulerSessionLeaseAdmissionContext(input.coreDb, lease.leaseId);
  } catch {
    throw directTaskModeRecoveryError('The boot Task checkpoint has no scheduler admission owner.');
  }
  if (admission.requestId !== checkpoint.requestId || admission.triggerActor.kind !== 'user') {
    throw directTaskModeRecoveryError(
      'The boot Task scheduler admission contradicts its human command identity.'
    );
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
    if (receipt) {
      throw directTaskModeRecoveryError(
        'The reconnectable Task checkpoint already has a terminal command receipt.'
      );
    }
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
 * Records durable usage for one successful QuickChat LLM call when storage is available.
 *
 * @param input QuickChat usage attribution and provider usage payload.
 */
function recordQuickChatLlmUsage(input: {
  /** Optional Core database handle for durable workspace storage. */
  coreDb?: CoreDb;
  /** Fresh request actor responsible for this Workspace-attributed call. */
  authorityActor: ActorRef;
  /** Workspace that owns the QuickChat request. */
  workspaceId: string;
  /** Thread lineage when the call belongs to a thread-scoped mode. */
  threadId?: string | null;
  /** Turn lineage when the call belongs to a durable turn. */
  turnId?: string | null;
  /** Item lineage when the call belongs to a durable item. */
  itemId?: string | null;
  /** Request id used by the originating caller. */
  requestId?: string | null;
  /** Provider id selected for the call. */
  providerId: string;
  /** Model selected for the call. */
  model: string;
  /** Provider-native usage payload. */
  usage?: unknown;
}): void {
  if (!input.coreDb) {
    return;
  }

  const workspaceDb = openWorkspaceDb(input.coreDb.dataRoot, input.workspaceId);

  try {
    applyScopedMigrations(workspaceDb);
    const call = startCapabilityCall({
      authorityActor: input.authorityActor,
      agentId: QUICK_CHAT_AGENT_ID,
      agentSessionId: null,
      capabilityId: 'inference.local.quick_chat',
      family: 'llm',
      operation: 'quick_chat',
      providerRef: input.providerId,
      redactionClass: 'metadata-only',
      requestId: normalizeCapabilityRequestId(input.requestId) ?? randomUUID(),
      serviceRef: 'llm-gateway',
      summary: 'QuickChatAgent LLM call.',
      threadId: input.threadId ?? null,
      turnId: input.turnId ?? null,
      itemId: input.itemId ?? null,
      workspaceDb,
      workspaceId: input.workspaceId,
    });
    const parsed = parseUsage(input.usage);
    const tokenQuantity = parsed.totalTokens || parsed.inputTokens + parsed.completionTokens;

    recordUsage({
      call,
      records: [
        {
          category: 'llm',
          modelId: input.model,
          providerRef: input.providerId,
          quantity: tokenQuantity > 0 ? tokenQuantity : 1,
          source: tokenQuantity > 0 ? 'gateway-reported' : 'gateway-observed',
          unit: tokenQuantity > 0 ? 'tokens' : 'requests',
        },
      ],
      workspaceDb,
    });
    finishCapabilityCall({ workspaceDb, callId: call.id, status: 'succeeded' });
  } finally {
    workspaceDb.sqlite.close();
  }
}

/**
 * Converts upstream provider failures into status-preserving protocol errors.
 *
 * @param error Provider failure to normalize.
 * @returns Status-preserving App API error response.
 */
function asProviderApiError(
  error: OpenAICompatibleProviderError | LogicalModelRoutesExhaustedError
): Response {
  if (error instanceof LogicalModelRoutesExhaustedError) {
    return Response.json(apiErrorPayload({ code: error.code, message: error.message }), {
      status: error.status,
    });
  }

  if (error.status === 429) {
    return Response.json(
      apiErrorPayload({
        code: 'provider_rate_limited',
        message: 'Provider rate limit exceeded.',
      }),
      { status: 429 }
    );
  }

  return Response.json(
    apiErrorPayload({
      code: 'provider_request_failed',
      message: 'Provider request failed.',
    }),
    { status: error.status }
  );
}

/**
 * Builds the first V1 Task Mode delegation decision from the rule-based Worker Coordinator.
 *
 * @param input Task Mode request context.
 * @returns Coordinator decision plus the public Task Mode projection when launchable.
 */
function createTaskModeDelegation(input: {
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
 * Returns true when Chat Mode is being asked to use external search.
 *
 * @param prompt User prompt.
 * @returns Whether the prompt asks for unavailable external search.
 */
function isExternalSearchChatPrompt(prompt: string): boolean {
  return /\b(search|browse|look\s+up|google|web|internet)\b/i.test(prompt);
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
 * Returns true when Chat Mode can answer from a bounded repository root listing.
 *
 * @param prompt User prompt.
 * @returns Whether the prompt asks only for linked repository file names.
 */
function isRepositoryFileListChatPrompt(prompt: string): boolean {
  const normalized = prompt.toLowerCase();

  return (
    /\b(list|show|what|which)\b/.test(normalized) &&
    /\b(repository|repo|working directory|workdir)\b/.test(normalized) &&
    /\b(files|contents|entries)\b/.test(normalized)
  );
}

type RepositoryFileListResult = {
  answerText: string;
  operation: 'repository.root_list' | 'repository.directory_list' | 'repository.file_read';
  summary: string;
};

type ChatRepositoryInspectionPolicy = {
  enabled: boolean;
  excludedPaths: string[];
};

class ChatRepositoryInspectionPolicyError extends Error {}

const ChatModeReadableFileExtensions = new Set([
  '.css',
  '.html',
  '.js',
  '.json',
  '.jsonc',
  '.md',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.yaml',
  '.yml',
]);

/**
 * Returns true when Chat Mode can answer from one bounded repository text file.
 *
 * @param prompt User prompt.
 * @returns Whether the prompt asks to read one linked repository file.
 */
function isRepositoryFileReadChatPrompt(prompt: string): boolean {
  const normalized = prompt.toLowerCase();

  return (
    /\b(read|show|open|display)\b/.test(normalized) &&
    /\b(repository|repo|working directory|workdir)\b/.test(normalized) &&
    /\b(file|path)\b/.test(normalized)
  );
}

/**
 * Reads the Chat Mode repository inspection policy from workspace config.
 *
 * @param snapshot Runtime config snapshot containing workspace policy.
 * @param workspaceId Workspace id to inspect.
 * @returns Effective repository inspection policy.
 */
function chatRepositoryInspectionPolicy(
  snapshot: RuntimeConfigSnapshot,
  workspaceId: string
): ChatRepositoryInspectionPolicy {
  const workspaceConfig = findWorkspaceConfig(snapshot, workspaceId);
  const policy = workspaceConfig?.config.workspace?.assistant?.repositoryInspection;

  return {
    enabled: policy?.enabled !== false,
    excludedPaths: policy?.excludedPaths ?? [],
  };
}

/**
 * Extracts one optional repository-relative directory from a file-list prompt.
 *
 * @param prompt User prompt.
 * @returns Repository-relative directory when the prompt asks for one.
 */
function parseRepositoryFileListDirectory(prompt: string): string | null {
  const match = /\b(?:in|under)\s+([a-z0-9._/-]+)\b/i.exec(prompt.trim());
  const requestedDirectory = match?.[1]?.replace(/\/+$/g, '') ?? null;

  if (!requestedDirectory || ['repository', 'repo', 'workdir'].includes(requestedDirectory)) {
    return null;
  }

  return requestedDirectory;
}

/**
 * Extracts one repository-relative file path from a strict file-read prompt.
 *
 * @param prompt User prompt.
 * @returns Repository-relative file path when the prompt names one.
 */
function parseRepositoryFileReadPath(prompt: string): string | null {
  const match = /\b(?:file|path)\s+([a-z0-9._/-]+\.[a-z0-9]+)\b/i.exec(prompt.trim());
  return match?.[1]?.replace(/[.?!,;:]+$/g, '') ?? null;
}

/**
 * Returns a safe repository-relative target path.
 *
 * @param rootPath Absolute repository root path.
 * @param requestedPath Repository-relative path requested by the user.
 * @returns Absolute target and normalized repository-relative label.
 */
function safeRepositoryTarget(
  rootPath: string,
  requestedPath: string
): {
  targetPath: string;
  relativeTarget: string;
} {
  const requestedSegments = requestedPath.split('/').filter(Boolean);
  const targetPath = resolve(rootPath, requestedPath);
  const relativeTarget = relative(rootPath, targetPath);
  const relativeSegments = relativeTarget.split(sep).filter(Boolean);

  if (
    requestedSegments.some((segment) => segment === '.' || segment === '..') ||
    relativeTarget.startsWith('..') ||
    relativeSegments.some((segment) => segment.startsWith('.'))
  ) {
    throw new Error('Unsafe repository path requested.');
  }

  return { targetPath, relativeTarget };
}

/**
 * Normalizes a repository-relative path for policy matching.
 *
 * @param path Repository-relative path.
 * @returns Slash-separated path without leading or trailing separators.
 */
function normalizeRepositoryPolicyPath(path: string): string {
  return path
    .split(sep)
    .join('/')
    .replace(/^\/+|\/+$/g, '');
}

/**
 * Checks whether a repository-relative path is excluded by policy.
 *
 * @param relativePath Repository-relative path.
 * @param excludedPaths Excluded path prefixes from workspace policy.
 * @returns True when the path itself or one of its ancestors is excluded.
 */
function isRepositoryPathExcluded(relativePath: string, excludedPaths: readonly string[]): boolean {
  const normalized = normalizeRepositoryPolicyPath(relativePath);

  return excludedPaths.some((excludedPath) => {
    const excluded = normalizeRepositoryPolicyPath(excludedPath);

    return normalized === excluded || normalized.startsWith(`${excluded}/`);
  });
}

/**
 * Fails when a repository-relative path is excluded by workspace policy.
 *
 * @param relativePath Repository-relative path.
 * @param excludedPaths Excluded path prefixes from workspace policy.
 */
function assertRepositoryPathNotExcluded(
  relativePath: string,
  excludedPaths: readonly string[]
): void {
  if (relativePath && isRepositoryPathExcluded(relativePath, excludedPaths)) {
    throw new ChatRepositoryInspectionPolicyError(
      'Workspace policy excludes that repository path from Chat Mode inspection.'
    );
  }
}

/**
 * Redacts common secret-like tokens from Chat Mode file previews.
 *
 * @param text Text that may contain raw secret-looking material.
 * @returns Redacted text.
 */
function redactChatModeFilePreview(text: string): string {
  return text
    .replace(
      /(^|[^A-Za-z0-9_])(sk-[A-Za-z0-9_-]+|hf_[A-Za-z0-9_-]+|ghp_[A-Za-z0-9_-]+|okt_[A-Za-z0-9_-]+)/g,
      '$1[redacted]'
    )
    .replace(/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g, '[redacted]');
}

/**
 * Builds a read-only summary of the linked repository root or one safe child directory.
 *
 * @param repository Linked repository resource to inspect.
 * @param prompt User prompt that may name one repository-relative directory.
 * @param policy Workspace repository inspection policy.
 * @returns User-visible file and directory summary plus audit metadata.
 */
function formatRepositoryFileList(
  repository: WorkspaceRepositoryResourceRecord,
  prompt: string,
  policy: ChatRepositoryInspectionPolicy
): RepositoryFileListResult {
  const rootPath = resolve(repository.localPath);
  const requestedDirectory = parseRepositoryFileListDirectory(prompt);
  const target = requestedDirectory
    ? safeRepositoryTarget(rootPath, requestedDirectory)
    : { targetPath: rootPath, relativeTarget: '' };
  const { targetPath, relativeTarget } = target;
  assertRepositoryPathNotExcluded(relativeTarget, policy.excludedPaths);

  const entries = readdirSync(targetPath, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith('.'))
    .filter((entry) => {
      const relativeEntry = relativeTarget
        ? `${relativeTarget.split(sep).join('/')}/${entry.name}`
        : entry.name;

      return !isRepositoryPathExcluded(relativeEntry, policy.excludedPaths);
    })
    .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
    .sort((left, right) => left.localeCompare(right))
    .slice(0, 25);
  const label = relativeTarget ? `${relativeTarget.split(sep).join('/')}/` : 'root';
  const operation = relativeTarget ? 'repository.directory_list' : 'repository.root_list';
  const summary = relativeTarget
    ? 'Assistant read linked repository directory entries.'
    : 'Assistant read linked repository root entries.';

  if (entries.length === 0) {
    return {
      answerText: `Repository ${label} has no visible files or directories.`,
      operation,
      summary,
    };
  }

  return {
    answerText: `Repository ${label} entries:\n${entries.map((entry) => `- ${entry}`).join('\n')}`,
    operation,
    summary,
  };
}

/**
 * Builds a read-only preview of one safe linked repository text file.
 *
 * @param repository Linked repository resource to inspect.
 * @param prompt User prompt that names one repository-relative file.
 * @param policy Workspace repository inspection policy.
 * @returns User-visible text preview plus audit metadata.
 */
function formatRepositoryFileRead(
  repository: WorkspaceRepositoryResourceRecord,
  prompt: string,
  policy: ChatRepositoryInspectionPolicy
): RepositoryFileListResult {
  const requestedFile = parseRepositoryFileReadPath(prompt);

  if (!requestedFile) {
    throw new Error('Repository file read prompt did not name a file.');
  }

  const rootPath = resolve(repository.localPath);
  const { targetPath, relativeTarget } = safeRepositoryTarget(rootPath, requestedFile);
  assertRepositoryPathNotExcluded(relativeTarget, policy.excludedPaths);
  const extension = extname(relativeTarget).toLowerCase();
  const stat = statSync(targetPath);

  if (!stat.isFile() || !ChatModeReadableFileExtensions.has(extension) || stat.size > 16_384) {
    throw new Error('Repository file is not eligible for Chat Mode preview.');
  }

  const raw = readFileSync(targetPath, 'utf8');

  if (raw.includes('\0')) {
    throw new Error('Repository file is not text.');
  }

  const preview = redactChatModeFilePreview(raw)
    .split(/\r?\n/)
    .slice(0, 40)
    .join('\n')
    .slice(0, 4000);
  const label = relativeTarget.split(sep).join('/');

  return {
    answerText: `Repository file ${label}:\n${preview}`,
    operation: 'repository.file_read',
    summary: 'Assistant read one linked repository text file.',
  };
}

/**
 * Maps a protocol turn status to the Task Mode attempt state vocabulary.
 *
 * @param status Stored turn status.
 * @returns Task Mode attempt state.
 */
function taskModeStateForTurn(status: z.infer<typeof TurnSchema>['status']) {
  switch (status) {
    case 'completed':
      return 'completed';
    case 'awaiting_human':
      return 'awaiting-human';
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
  if (eventStopReason && eventStopReason !== 'ask_user') {
    return eventStopReason;
  }

  const turn = store.getTurnById(turnId);
  return turn.status === 'awaiting_human' && turn.humanGate ? 'ask_user' : null;
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
 * Requires one Thread to belong to the centrally authorized path Workspace.
 *
 * @param context Request context carrying optional central authorization in Core-backed mode.
 * @param store Existing Thread owner.
 * @param workspaceId Authorized path Workspace.
 * @param threadId Child Thread identifier.
 * @returns Existing Thread after lineage verification.
 * @throws The original missing error in no-Core tests, or uniform Workspace denial in guarded mode.
 */
function requireAuthorizedModeThread(
  context: Context<{ Variables: AuthVariables }>,
  store: FsStore,
  workspaceId: string,
  threadId: string
): ReturnType<FsStore['getThread']> {
  const workspaceAccess = context.get('workspaceAccess');
  let thread: ReturnType<FsStore['getThread']>;
  try {
    thread = store.getThread(workspaceId, threadId);
  } catch (error) {
    if (workspaceAccess) {
      assertAuthorizedWorkspaceLineage(workspaceAccess, null);
    }
    throw error;
  }
  if (workspaceAccess) {
    assertAuthorizedWorkspaceLineage(workspaceAccess, thread.workspaceId);
  }
  return thread;
}

/**
 * Registers Quick Chat and Chat Mode entry routes.
 *
 * @param dependencies Hono app and shared app composition callbacks.
 */
export function registerQuickAndChatModeRoutes({
  app,
  assertProjectWorkspace,
  coreDb,
  inflightCommands,
  llmGatewayDispatcher,
  providerSubscriptionAccountManager,
  repositoryWorkspaceDb,
  requestStore,
  resolveGatewayProvider,
  runtimeConfig,
  startModeWorkerTurn,
  workerCoordinatorCandidates,
}: {
  readonly app: Hono<{ Variables: AuthVariables }>;
  readonly assertProjectWorkspace: (
    workspace: ReturnType<FsStore['getWorkspace']>,
    action: string
  ) => void;
  readonly coreDb: CoreDb | undefined;
  readonly inflightCommands: WeakMap<FsStore, Map<string, InflightIdempotentCommand>>;
  readonly llmGatewayDispatcher: Pick<LLMGatewayProviderDispatcher, 'createChatCompletion'>;
  readonly providerSubscriptionAccountManager?: ProviderSubscriptionAccountManager;
  readonly repositoryWorkspaceDb: (workspaceId: string) => WorkspaceDb;
  readonly requestStore: (context: Context<{ Variables: AuthVariables }>) => FsStore;
  readonly resolveGatewayProvider: (providerId: string, model: string) => ResolvedLLMProviderConfig;
  readonly runtimeConfig: () => RuntimeConfigSnapshot;
  readonly startModeWorkerTurn: (input: {
    readonly triggerActor: ActorRef;
    readonly store: FsStore;
    readonly workspaceId: string;
    readonly threadId: string;
    readonly prompt: string;
    readonly modelId?: string | undefined;
    readonly profileId?: string | undefined;
    readonly requestId: string;
    readonly requestedAgentId: string;
    readonly reservedTurnId?: string | undefined;
  }) => Promise<z.infer<typeof TurnSchema>>;
  readonly workerCoordinatorCandidates: (
    store: FsStore,
    workspaceId: string
  ) => WorkerCoordinatorCandidate[];
}): void {
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
    return { id: model.id, label: model.displayName, capabilities: [...model.capabilities] };
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
        const goal = listGoalRecordsForThread(workspaceDb, {
          workspaceId,
          threadId: requestedThreadId,
        }).findLast((candidate) =>
          [
            'planning',
            'awaiting_plan_approval',
            'running',
            'paused',
            'awaiting_user',
            'reviewing',
          ].includes(candidate.status)
        );
        if (goal) {
          const goalOrchestrator = internalRoleSelection('goal-orchestrator', userId, workspaceId);
          targets.push({
            targetRef: `goal-orchestrator:${goal.goalId}`,
            kind: 'goal-orchestrator',
            label: 'Goal Orchestrator',
            description: 'Steers the active Goal in this Thread.',
            availability: goalOrchestrator ? 'available' : 'unavailable',
            unavailableReason: goalOrchestrator ? null : 'No admitted logical model is configured.',
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

    for (const session of store.listWorkspaceAgentSessions(workspaceId)) {
      if (!session.threadId || session.status === 'closed') continue;
      const manifest = snapshot.agentManifests.find((entry) => entry.id === session.agentId);
      if (!manifest) continue;
      const setup = resolveAgentSetup(manifest, {
        gatewayConfig: snapshot.gatewayConfig,
        providerRegistry: snapshot.providerRegistry,
        workspaceId,
        ...(workspaceConfig ? { workspaceConfig } : {}),
        ...(userConfig ? { userConfig } : {}),
      }).setup;
      targets.push({
        targetRef: `running-worker:${encodeURIComponent(session.threadId)}:${encodeURIComponent(session.agentId)}`,
        kind: 'running-worker',
        label: `${manifest.displayName} · Running`,
        description: 'Worker continuing on its existing Thread.',
        availability: session.status === 'busy' ? 'busy' : setup ? 'available' : 'unavailable',
        unavailableReason:
          session.status === 'busy' ? 'Worker is busy.' : setup ? null : 'Worker is not ready.',
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

  registerAppApiRoute(app, 'getConversationTargets', (c) => {
    const workspaceId = c.req.param('workspaceId');
    const requestedThreadId = c.req.query('threadId')?.trim() || null;
    const store = requestStore(c);
    store.getWorkspace(workspaceId);
    if (c.get('workspaceAccess')) {
      assertAuthorizedWorkspaceLineage(c.get('workspaceAccess'), workspaceId);
    }
    if (requestedThreadId) {
      requireAuthorizedModeThread(c, store, workspaceId, requestedThreadId);
    }
    return c.json(
      conversationTargetCatalog(store, workspaceId, requestedThreadId, c.get('actor').userId)
    );
  });

  /**
   * Executes one bounded Quick Chat provider call without creating a private runtime.
   *
   * @param input Provider selection, prompt, lineage metadata, and caller cancellation signal.
   * @returns Provider response identity, text, and optional usage payload.
   * @throws TurnStartValidationError for timeout, caller cancellation, or invalid content.
   * @throws Error when provider resolution or dispatch fails.
   */
  async function callQuickChatProvider(input: {
    /** Selected logical-model contract. */
    readonly logicalModel: ResolvedLogicalModel;
    /** User prompt. */
    readonly prompt: string;
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
    };

    try {
      signal.throwIfAborted();
      selected = await dispatchLogicalModel({
        logicalModel: input.logicalModel,
        signal,
        resolveGatewayProvider,
        ...(providerSubscriptionAccountManager ? { providerSubscriptionAccountManager } : {}),
        attempt: async ({ provider, providerModel, subscriptionModels }) => ({
          providerId: provider.id,
          response: await Promise.race([
            llmGatewayDispatcher.createChatCompletion(
              provider,
              {
                model: providerModel,
                messages: [
                  { role: 'system', content: QUICK_CHAT_SYSTEM_PROMPT },
                  { role: 'user', content: input.prompt },
                ],
                metadata: {
                  openkit: {
                    sessionId: input.sessionId,
                    workspaceId: input.workspaceId,
                  },
                },
              },
              {
                ...(subscriptionModels ? { subscriptionModels } : {}),
                promptCacheScope: {
                  sessionId: input.sessionId,
                  workspaceId: input.workspaceId,
                },
                usageEndpoint: 'quick_chat',
                transport: { signal },
              }
            ),
            aborted,
          ]),
        }),
      });
    } catch (error) {
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
      if (abortListener) {
        signal.removeEventListener('abort', abortListener);
      }
    }
    const content = selected.response.choices[0]?.message.content;

    if (typeof content !== 'string' || content.trim().length === 0) {
      throw new TurnStartValidationError(
        'provider_response_invalid',
        'Quick chat provider returned invalid assistant content.',
        502
      );
    }

    return {
      id: selected.response.id,
      content,
      providerId: selected.providerId,
      ...(selected.response.usage === undefined ? {} : { usage: selected.response.usage }),
    };
  }

  registerAppApiRoute(app, 'quickChat', async (c) => {
    const parsed = QuickChatRequestSchema.safeParse(await c.req.json().catch(() => ({})));

    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    try {
      const input = parsed.data;
      const userId = c.get('actor').userId;
      const workspaceAccess = c.get('workspaceAccess');
      const workspaceId =
        workspaceAccess?.kind === 'workspace'
          ? workspaceAccess.workspaceId
          : coreDb
            ? null
            : 'ws_quick_chat';

      if (!workspaceId) {
        return asApiError('Workspace access denied.', 'workspace_access_denied', 403);
      }
      const sessionId = `quick-chat:${workspaceId}`;
      const selection = quickChatSelection(userId, workspaceId);

      if (!selection) {
        return c.json(
          apiErrorPayload({
            code: 'quick_chat_not_configured',
            message: 'Quick chat requires an admitted logical model.',
          }),
          400
        );
      }

      const result = await callQuickChatProvider({
        logicalModel: selection.logicalModel,
        prompt: input.input,
        sessionId,
        workspaceId,
        signal: c.req.raw.signal,
      });
      recordQuickChatLlmUsage({
        ...(coreDb ? { coreDb } : {}),
        authorityActor: { kind: 'user', id: c.get('actor').userId },
        model: selection.logicalModel.id,
        providerId: result.providerId,
        ...(result.usage === undefined ? {} : { usage: result.usage }),
        workspaceId,
      });

      return c.json(
        QuickChatResponseSchema.parse({
          id: result.id,
          status: 'completed',
          workspaceId,
          modelId: selection.logicalModel.id,
          content: result.content,
        })
      );
    } catch (error) {
      if (
        error instanceof OpenAICompatibleProviderError ||
        error instanceof LogicalModelRoutesExhaustedError
      ) {
        return asProviderApiError(error);
      }
      if (error instanceof TurnStartValidationError) {
        return asApiError(redactInternalAgentText(error.message), error.code, error.status);
      }

      return asApiError('Quick chat failed.', 'quick_chat_failed', 500);
    }
  });

  registerAppApiRoute(app, 'submitConversation', async (c) => {
    const parsed = SubmitConversationRequestSchema.safeParse(await c.req.json().catch(() => ({})));

    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }
    const chatInput = parsed.data;
    const workspaceId = c.req.param('workspaceId');
    const threadId = c.req.param('threadId');
    const store = requestStore(c);
    try {
      requireAuthorizedModeThread(c, store, workspaceId, threadId);
    } catch (error) {
      if (error instanceof HTTPException) throw error;
      return asApiError('Conversation Thread is unavailable.', 'target_missing', 409);
    }
    const triggerActor = {
      kind: 'user',
      id: c.get('actor').userId,
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
      const artifacts: Array<ReturnType<FsStore['getArtifact']>> = [];
      for (const reference of chatInput.artifactRefs) {
        let artifact: ReturnType<FsStore['getArtifact']>;
        try {
          artifact = store.getArtifact(workspaceId, reference.artifactId);
        } catch {
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
       * @returns Created turn.
       */
      const createChatTurn = (completedAt: string) => {
        const turn = store.createTurn(workspaceId, threadId, chatInput.input, triggerActor);

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

        for (const [index, artifact] of artifacts.entries()) {
          store.createItem({
            id: `it_conversation_artifact_${turn.id}_${index + 1}`,
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

        return turn;
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
        const waitingTurn = store.updateTurn(turn.id, {
          status: 'awaiting_human',
          humanGate: {
            kind: 'user-input',
            userInputRequestId: requestId,
            itemId: questionItem.id,
          },
        });

        return ConversationCommandBodySchema.parse({
          outcome: 'clarification-needed',
          explanation: 'The Assistant needs a concrete request before choosing a mode.',
          turn: waitingTurn,
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

      /** Runs the existing Workspace Knowledge Manager and projects its answer into this Thread. */
      const answerFromWorkspaceKnowledge = (
        caller: 'assistant' | 'app-api'
      ): ConversationCommandResult | null => {
        const dataRoot = store.getDataRoot();
        if (!dataRoot) return null;
        const workspaceDb = coreDb ? repositoryWorkspaceDb(workspaceId) : undefined;
        let referenceProofs: ReturnType<typeof resolveWorkspaceKnowledgeReferenceProofs> =
          new Map();
        try {
          referenceProofs = resolveWorkspaceKnowledgeReferenceProofs({
            coreDb,
            store,
            workspaceDb,
            workspaceId,
          });
        } finally {
          workspaceDb?.sqlite.close();
        }
        const knowledgeAnswer = answerKnowledgeManager({
          dataRoot,
          operationId: `km_answer_${randomUUID()}`,
          workspaceId,
          caller,
          query: conversationPrompt,
          limit: 3,
          referenceProofs,
        });
        if (caller === 'assistant' && knowledgeAnswer.outcome !== 'answered') return null;
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

      /** Starts one selected Worker through the existing product Turn owner. */
      const startSelectedWorker = async (): Promise<ConversationCommandResult> => {
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
          receivingThreadId = store.createThread(workspaceId, title, createdThreadId).id;
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
        let started: z.infer<typeof TurnSchema>;
        try {
          await runWorkerTurnLoop({
            coreDb: coreDb!,
            triggerActor,
            workspaceDb,
            workspaceId,
            threadId: receivingThreadId,
            requestId: chatInput.requestId,
            requestInputHash: commandInputHash({
              input: chatInput.input,
              targetRef: chatInput.targetRef,
              logicalModelId: chatInput.logicalModelId ?? null,
              artifactRefs: chatInput.artifactRefs,
            }),
            reviewRequired: false,
            remainingWorkerIterations: 0,
            prepare: () => {
              const dataRoot = store.getDataRoot();
              if (!dataRoot) {
                throw directTaskModeRecoveryError(
                  'Task Knowledge retrieval requires a file-backed data root.'
                );
              }
              let knowledgeSelectionInput: { readonly retrievalTraceId: string };
              try {
                knowledgeSelectionInput = prepareTaskKnowledgeContext({
                  dataRoot,
                  workspaceId,
                  query: chatInput.input,
                  referenceProofs: resolveWorkspaceKnowledgeReferenceProofs({
                    coreDb: coreDb!,
                    store,
                    workspaceDb,
                    workspaceId,
                  }),
                  traceId: directTaskKnowledgeRetrievalTraceId(
                    actorId,
                    workspaceId,
                    receivingThreadId,
                    chatInput.requestId
                  ),
                });
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
            reserveTurn: () => ({ turnId: reservedTurnId }),
            startWorker: async ({ turnId, prepared }) => {
              const turn = await startModeWorkerTurn({
                triggerActor,
                store,
                workspaceId,
                threadId: receivingThreadId,
                prompt: serializeStructuredWorkerDelegationRequest(prepared.delegationRequest),
                ...(logicalModelId ? { modelId: logicalModelId } : {}),
                ...(acceptedTarget.profileId ? { profileId: acceptedTarget.profileId } : {}),
                requestId: chatInput.requestId,
                requestedAgentId: agentId!,
                reservedTurnId: turnId,
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
          started = store.getTurn(workspaceId, receivingThreadId, reservedTurnId);
        } finally {
          workspaceDb.sqlite.close();
        }
        const completedAt = new Date().toISOString();
        for (const [index, artifact] of artifacts.entries()) {
          store.createItem({
            id: `it_conversation_artifact_${started.id}_${index + 1}`,
            workspaceId,
            threadId: receivingThreadId,
            turnId: started.id,
            type: 'artifact-reference',
            status: 'completed',
            artifactId: artifact.id,
            artifactVersion: artifact.version,
            title: artifact.title,
            summary: artifact.summary,
            lastMutationRequestId: chatInput.requestId,
            createdAt: started.startedAt ?? completedAt,
            completedAt,
          });
        }
        const item = store.createItem({
          id: `it_worker_result_${started.id}`,
          workspaceId,
          threadId: receivingThreadId,
          turnId: started.id,
          type: 'status',
          status: 'completed',
          level: started.status === 'completed' ? 'info' : 'warning',
          title: 'Worker Turn accepted',
          summary: `Conversation continued with ${agentId}.`,
          createdAt: completedAt,
          completedAt,
        });
        return {
          body: ConversationCommandBodySchema.parse({
            outcome: 'accepted',
            explanation: 'The selected Worker accepted the conversation Turn.',
            turn: store.getTurn(workspaceId, receivingThreadId, started.id),
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
        const response = answerFromWorkspaceKnowledge('app-api');
        if (response) return response;
        return {
          body: createRefusedResponse('Workspace Knowledge storage is unavailable.'),
          downstream: null,
          resultKind: 'refused',
          status: 200,
        };
      }

      if (acceptedTarget.kind === 'goal-orchestrator') {
        if (!coreDb || !acceptedTarget.threadId) {
          throw new TurnStartValidationError(
            'target_unavailable',
            'Goal steering storage is unavailable.',
            503
          );
        }
        const workspaceDb = repositoryWorkspaceDb(workspaceId);
        try {
          const steering = await submitGoalSteeringCommand({
            coreDb,
            store,
            workspaceDb,
            inflightCommands,
            actorId,
            workspaceId,
            threadId: acceptedTarget.threadId,
            requestId: chatInput.requestId,
            commandInput: { message: conversationPrompt },
            expectedGoalId: acceptedTarget.targetRef.slice('goal-orchestrator:'.length),
          });
          const item = store
            .listThreadItems(workspaceId, acceptedTarget.threadId)
            .find((candidate) => candidate.id === steering.contentItemId);
          if (!item) {
            throw new TurnStartValidationError(
              'recovery_required',
              'Goal steering accepted without its source Item.',
              409
            );
          }
          return {
            body: ConversationCommandBodySchema.parse({
              outcome: 'accepted',
              explanation: 'The active Goal Orchestrator accepted the steering input.',
              turn: store.getTurn(workspaceId, acceptedTarget.threadId, steering.activeTurnId),
              item,
              handoff: null,
            }),
            downstream: {
              kind: 'goal',
              goalId: steering.goalId,
              turnId: steering.activeTurnId,
            },
            resultKind: 'goal-steering',
            status: 202,
          };
        } finally {
          workspaceDb.sqlite.close();
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

        try {
          await runWorkerTurnLoop({
            coreDb,
            triggerActor,
            workspaceDb,
            workspaceId,
            threadId,
            requestId: chatInput.requestId,
            requestInputHash: commandInputHash({ input: chatInput.input }),
            reviewRequired: false,
            remainingWorkerIterations: 0,
            prepare: () => ({
              delegationRequest: workerRequest,
              contextPackageDigest: commandInputHash(workerRequest),
              knowledgeSelectionInput: null,
            }),
            reserveTurn: () => ({ turnId: reservedTurnId }),
            startWorker: async ({ turnId, prepared }) => {
              const turn = await startModeWorkerTurn({
                triggerActor,
                store,
                workspaceId,
                threadId,
                prompt: serializeStructuredWorkerDelegationRequest(prepared.delegationRequest),
                requestId: chatInput.requestId,
                requestedAgentId: taskDecision.worker.agentId,
                reservedTurnId: turnId,
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

        return {
          body: createHandoffResponse('task', taskDecision.rationale),
          downstream: { kind: 'task', turnId: reservedTurnId },
          resultKind: 'task-handoff',
          status: 202,
        };
      }

      if (delegation?.coordinator.decision === 'goal') {
        const goalStart = startGoalModeObjective({
          triggerActor,
          assertProjectWorkspace,
          coreDb,
          repositoryWorkspaceDb,
          store,
          workspaceId,
          threadId,
          owningCommand: 'conversation.submit',
          requestId: chatInput.requestId,
          objective: chatInput.input,
        });

        return {
          body: createHandoffResponse('goal', delegation.coordinator.explanation),
          downstream: {
            kind: 'goal',
            goalId: goalStart.response.goal.goalId,
            turnId: goalStart.turn.id,
          },
          resultKind: 'goal-handoff',
          status: 202,
        };
      }

      if (delegation && delegation.coordinator.decision !== 'quick_chat') {
        return {
          body: createRefusedResponse(delegation.coordinator.explanation),
          downstream: null,
          resultKind: 'refused',
          status: 200,
        };
      }

      const knowledgeResponse = answerFromWorkspaceKnowledge('assistant');
      if (knowledgeResponse) return knowledgeResponse;

      if (
        (isRepositoryFileListChatPrompt(chatInput.input) ||
          isRepositoryFileReadChatPrompt(chatInput.input)) &&
        coreDb
      ) {
        const repositoryInspectionPolicy = chatRepositoryInspectionPolicy(
          runtimeConfig(),
          workspaceId
        );

        if (!repositoryInspectionPolicy.enabled) {
          return {
            body: createRefusedResponse(
              'Workspace policy disables Chat Mode repository inspection.'
            ),
            downstream: null,
            resultKind: 'refused',
            status: 202,
          };
        }

        const workspaceDb = repositoryWorkspaceDb(workspaceId);
        let repository: WorkspaceRepositoryResourceRecord | null;

        try {
          repository = getDefaultWorkspaceRepositoryResource(workspaceDb, workspaceId);

          if (repository) {
            let repositoryFileList: RepositoryFileListResult;

            try {
              repositoryFileList = isRepositoryFileReadChatPrompt(chatInput.input)
                ? formatRepositoryFileRead(repository, chatInput.input, repositoryInspectionPolicy)
                : formatRepositoryFileList(repository, chatInput.input, repositoryInspectionPolicy);
            } catch (error) {
              if (error instanceof ChatRepositoryInspectionPolicyError) {
                return {
                  body: createRefusedResponse(error.message),
                  downstream: null,
                  resultKind: 'refused',
                  status: 202,
                };
              }

              throw error;
            }

            const completedAt = new Date().toISOString();
            const turn = createChatTurn(completedAt);
            const capabilityCall = startCapabilityCall({
              authorityActor: triggerActor,
              workspaceDb,
              workspaceId,
              threadId,
              turnId: turn.id,
              requestId: chatInput.requestId,
              family: 'workspace',
              operation: repositoryFileList.operation,
              capabilityId: 'assistant.repository.read',
              summary: repositoryFileList.summary,
              serviceRef: 'workspace-repository',
              redactionClass: 'metadata',
            });
            let answerText: string;

            try {
              answerText = repositoryFileList.answerText;
              finishCapabilityCall({
                workspaceDb,
                callId: capabilityCall.id,
                status: 'succeeded',
              });
            } catch (error) {
              finishCapabilityCall({
                workspaceDb,
                callId: capabilityCall.id,
                status: 'failed',
                errorCode: 'assistant_repository_read_failed',
              });
              throw error;
            }

            const answerItem = store.createItem({
              id: `it_chat_repo_files_${turn.id}`,
              workspaceId,
              threadId,
              turnId: turn.id,
              type: 'assistant-message',
              status: 'completed',
              text: answerText,
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
                explanation: 'The Assistant answered from a read-only repository inspection.',
                turn: completedTurn,
                item: answerItem,
                handoff: null,
              }),
              downstream: null,
              resultKind: 'repository-answer',
              status: 202,
            };
          }
        } finally {
          workspaceDb.sqlite.close();
        }
      }

      const selection = quickChatSelection(
        c.get('actor').userId,
        workspaceId,
        logicalModelId ?? undefined
      );
      const sessionId = `chat-mode:${workspaceId}:${threadId}`;

      if (!selection) {
        throw new TurnStartValidationError(
          'chat_mode_not_configured',
          'Chat Mode requires an admitted logical model.',
          400
        );
      }

      const result = await callQuickChatProvider({
        logicalModel: selection.logicalModel,
        prompt: conversationPrompt,
        sessionId,
        workspaceId,
        signal: c.req.raw.signal,
      });
      const completedAt = new Date().toISOString();
      const turn = createChatTurn(completedAt);
      recordQuickChatLlmUsage({
        ...(coreDb ? { coreDb } : {}),
        authorityActor: triggerActor,
        model: selection.logicalModel.id,
        providerId: result.providerId,
        requestId: chatInput.requestId,
        threadId,
        turnId: turn.id,
        ...(result.usage === undefined ? {} : { usage: result.usage }),
        workspaceId,
      });

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
    }

    try {
      const result = await runIdempotentCommand({
        command: 'conversation.submit',
        execute: () => executeChatCommand(store, workspaceId, threadId),
        inflightCommands,
        input: {
          input: chatInput.input,
          targetRef: chatInput.targetRef,
          logicalModelId: chatInput.logicalModelId ?? null,
          artifactRefs: chatInput.artifactRefs,
        },
        replay: (record) =>
          replayConversationCommand(
            store,
            actorId,
            repositoryWorkspaceDb,
            workspaceId,
            threadId,
            record
          ),
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

      return c.json(
        SubmitConversationResponseSchema.parse({
          ...result.body,
          originatingWorkspaceId: workspaceId,
          originatingThreadId: threadId,
          receivingWorkspaceId: metadata.receivingWorkspaceId,
          receivingThreadId: metadata.receivingThreadId,
          targetRef: metadata.targetRef,
          logicalModelId: metadata.logicalModelId,
        }),
        result.status
      );
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
        const workspaceId = c.req.param('workspaceId');
        const threadId = c.req.param('threadId');
        const store = requestStore(c);
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
            return asApiError(
              'The Chat Task checkpoint is missing its outer Chat command receipt.',
              'recovery_required',
              409
            );
          }
        } finally {
          workspaceDb.sqlite.close();
        }
      }
      if (error instanceof TurnStartValidationError) {
        return asApiError(redactInternalAgentText(error.message), error.code, error.status);
      }
      if (
        error instanceof OpenAICompatibleProviderError ||
        error instanceof LogicalModelRoutesExhaustedError
      ) {
        return asProviderApiError(error);
      }
      if (error instanceof IdempotencyKeyConflictError) {
        return asApiError(redactInternalAgentText(error.message), error.code, error.status);
      }

      return asApiError('Chat Mode failed.', 'chat_mode_failed', 500);
    }
  });
}

/**
 * Registers the Task Mode entry route at its existing app registration point.
 *
 * @param dependencies Hono app and shared app composition callbacks.
 */
export function registerTaskModeRoute({
  app,
  assertProjectWorkspace,
  coreDb,
  inflightCommands,
  repositoryWorkspaceDb,
  requestStore,
  startModeWorkerTurn,
  workerCoordinatorCandidates,
}: {
  readonly app: Hono<{ Variables: AuthVariables }>;
  readonly assertProjectWorkspace: (
    workspace: ReturnType<FsStore['getWorkspace']>,
    action: string
  ) => void;
  readonly coreDb: CoreDb | undefined;
  readonly inflightCommands: WeakMap<FsStore, Map<string, InflightIdempotentCommand>>;
  readonly repositoryWorkspaceDb: (workspaceId: string) => WorkspaceDb;
  readonly requestStore: (context: Context<{ Variables: AuthVariables }>) => FsStore;
  readonly startModeWorkerTurn: (input: {
    readonly triggerActor: ActorRef;
    readonly store: FsStore;
    readonly workspaceId: string;
    readonly threadId: string;
    readonly prompt: string;
    readonly modelId?: string | undefined;
    readonly requestId: string;
    readonly requestedAgentId: string;
    readonly reservedTurnId?: string | undefined;
  }) => Promise<z.infer<typeof TurnSchema>>;
  readonly workerCoordinatorCandidates: (
    store: FsStore,
    workspaceId: string
  ) => WorkerCoordinatorCandidate[];
}): void {
  registerAppApiRoute(app, 'startTaskMode', async (c) => {
    const parsed = StartTaskModeRequestSchema.safeParse(await c.req.json().catch(() => ({})));

    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }
    const taskInput = parsed.data;
    const triggerActor = {
      kind: 'user',
      id: c.get('actor').userId,
    } as const satisfies ActorRef;
    const actorId = triggerActor.id;
    const requestInputHash = commandInputHash({
      input: taskInput.input,
      modelId: taskInput.modelId,
    });

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
      } finally {
        recoveryDb.sqlite.close();
      }

      const delegation = createTaskModeDelegation({
        store,
        workspaceId,
        threadId,
        prompt: taskInput.input,
        workerCoordinatorCandidates,
      });

      if (delegation.coordinator.decision === 'goal') {
        const goalStart = startGoalModeObjective({
          triggerActor,
          assertProjectWorkspace,
          coreDb,
          repositoryWorkspaceDb,
          store,
          workspaceId,
          threadId,
          owningCommand: 'task.start',
          requestId: taskInput.requestId,
          objective: taskInput.input,
        });
        const reason = delegation.coordinator.explanation;
        const timestamp = new Date().toISOString();
        store.createItem({
          id: `it_task_goal_${goalStart.response.goal.goalId}_${goalStart.turn.id}`,
          workspaceId,
          threadId,
          turnId: goalStart.turn.id,
          type: 'status',
          status: 'completed',
          level: 'info',
          title: 'Task Mode escalated to Goal Mode',
          summary: reason,
          createdAt: timestamp,
          completedAt: timestamp,
        });

        return StartTaskModeResponseSchema.parse({
          state: 'escalated-to-goal',
          turn: store.getTurnById(goalStart.turn.id),
          evidence: taskModeEvidenceForTurn(store, null, workspaceId, threadId, goalStart.turn),
          escalation: {
            targetMode: 'goal',
            goalId: goalStart.response.goal.goalId,
            reason,
          },
        });
      }

      const taskDecision = delegation.taskDecision;
      const workerRequest = delegation.coordinator.workerRequest;
      if (!taskDecision || !workerRequest) {
        throw new TurnStartValidationError(
          'task_mode_not_delegated',
          delegation.coordinator.explanation,
          409
        );
      }

      const workspaceDb = repositoryWorkspaceDb(workspaceId);
      try {
        await runWorkerTurnLoop({
          coreDb,
          triggerActor,
          workspaceDb,
          workspaceId,
          threadId,
          requestId: taskInput.requestId,
          requestInputHash,
          reviewRequired: false,
          remainingWorkerIterations: 0,
          prepare: () => {
            const dataRoot = store.getDataRoot();
            if (!dataRoot) {
              throw directTaskModeRecoveryError(
                'Task Knowledge retrieval requires a file-backed data root.'
              );
            }

            let knowledgeSelectionInput: { readonly retrievalTraceId: string };
            try {
              knowledgeSelectionInput = prepareTaskKnowledgeContext({
                dataRoot,
                workspaceId,
                query: taskInput.input,
                referenceProofs: resolveWorkspaceKnowledgeReferenceProofs({
                  coreDb,
                  store,
                  workspaceDb,
                  workspaceId,
                }),
                traceId: directTaskKnowledgeRetrievalTraceId(
                  actorId,
                  workspaceId,
                  threadId,
                  taskInput.requestId
                ),
              });
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
          reserveTurn: () => ({ turnId: reservedTurnId }),
          startWorker: async ({ turnId, prepared }) => {
            const turn = await startModeWorkerTurn({
              triggerActor,
              store,
              workspaceId,
              threadId,
              prompt: serializeStructuredWorkerDelegationRequest(prepared.delegationRequest),
              modelId: taskInput.modelId,
              requestId: taskInput.requestId,
              requestedAgentId: taskDecision.worker.agentId,
              reservedTurnId: turnId,
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
        const checkpoint = getWorkerCheckpoint(workspaceDb, workspaceId, threadId, reservedTurnId);
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
      } finally {
        workspaceDb.sqlite.close();
      }
    }

    try {
      const workspaceId = c.req.param('workspaceId');
      const threadId = c.req.param('threadId');
      const store = requestStore(c);
      requireAuthorizedModeThread(c, store, workspaceId, threadId);
      const result = await runIdempotentCommand({
        command: 'task.start',
        execute: () => executeTaskCommand(store, workspaceId, threadId),
        inflightCommands,
        input: { input: taskInput.input, modelId: taskInput.modelId },
        replay: (record) =>
          replayTaskModeCommand(
            store,
            actorId,
            coreDb,
            repositoryWorkspaceDb,
            workspaceId,
            threadId,
            record
          ),
        requestId: taskInput.requestId,
        responseId: ({ turn }) => turn.id,
        responseKind: 'turn',
        scope: { actorId, threadId, workspaceId },
        store,
      });

      if (coreDb) {
        const reservedTurnId = directTaskModeTurnId(
          actorId,
          workspaceId,
          threadId,
          taskInput.requestId
        );
        const workspaceDb = repositoryWorkspaceDb(workspaceId);
        try {
          const checkpoint = getWorkerCheckpoint(
            workspaceDb,
            workspaceId,
            threadId,
            reservedTurnId
          );
          if (checkpoint) {
            const recovered = recoverDirectTaskModeCheckpoint({
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
            if (recovered.turn.id !== result.turn.id) {
              throw directTaskModeRecoveryError(
                'The Task receipt contradicts its worker checkpoint.'
              );
            }
            if (
              classifyClosedWorkerApprovalGate(store, TurnSchema.parse(recovered.turn)) ??
              classifyClosedWorkerUserInputGate(store, TurnSchema.parse(recovered.turn))
            ) {
              throw directTaskModeRecoveryError('The Task Gate response receipt is not durable.');
            }
          }
          if (checkpoint && checkpoint.stage !== 'waiting_for_user') {
            const cleared = await clearWorkerCheckpointAfterTerminalState(workspaceDb, {
              workspaceId,
              threadId,
              turnId: reservedTurnId,
            });
            if (!cleared) {
              throw directTaskModeRecoveryError(
                'The Task worker checkpoint is not ready for terminal cleanup.'
              );
            }
          }
        } finally {
          workspaceDb.sqlite.close();
        }
      }

      return c.json(result, 202);
    } catch (error) {
      if (error instanceof HTTPException) {
        throw error;
      }
      if (error instanceof TurnStartValidationError) {
        return asApiError(error.message, error.code, error.status);
      }
      if (error instanceof IdempotencyKeyConflictError) {
        return asApiError(error.message, error.code, error.status);
      }

      if (coreDb) {
        const workspaceId = c.req.param('workspaceId');
        const threadId = c.req.param('threadId');
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
          return asApiError(
            redactInternalAgentText(error instanceof Error ? error.message : String(error)),
            'recovery_required',
            409
          );
        }
      }

      return asCommandError(error, 'task_mode_start_failed');
    }
  });
}
