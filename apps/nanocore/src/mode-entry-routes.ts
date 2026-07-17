import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, relative, resolve, sep } from 'node:path';

import {
  QuickChatRequestSchema,
  QuickChatResponseSchema,
  StartChatModeRequestSchema,
  type StartChatModeResponse,
  StartChatModeResponseSchema,
  StartTaskModeRequestSchema,
  type StartTaskModeResponse,
  StartTaskModeResponseSchema,
  type TaskDelegationDecision,
  type TaskModeEvidence,
} from '@openkit/app-api-schemas';
import type { TurnSchema } from '@openkit/protocol';
import type { Context, Hono } from 'hono';
import { z } from 'zod';

import {
  apiErrorPayload,
  asApiError,
  asCommandError,
  asInvalidRequestError,
} from './api-errors.js';
import type { AuthVariables } from './auth/middleware.js';
import {
  finishCapabilityCall,
  normalizeCapabilityRequestId,
  recordUsage,
  startCapabilityCall,
} from './capability/usage-ledger.js';
import { findWorkspaceConfig, type RuntimeConfigSnapshot } from './config/runtime-config.js';
import { goalStartOwnerIds, startGoalModeObjective } from './goal-routes.js';
import {
  type DelegationContextRef,
  type StructuredWorkerDelegationRequest,
  serializeStructuredWorkerDelegationRequest,
} from './internal-agents/delegation.js';
import { redactInternalAgentText } from './internal-agents/redaction.js';
import {
  createWorkerCoordinatorDecision,
  type WorkerCoordinatorCandidate,
  type WorkerCoordinatorDecision,
} from './internal-agents/worker-coordinator.js';
import { answerKnowledgeManager, prepareKnowledgeContext } from './knowledge-manager.js';
import type { CommandRequestRecord, FsStore } from './lib/store.js';
import { parseUsage } from './llm/gateway-usage.js';
import { OpenAICompatibleProviderError } from './llm/openai-compatible-client.js';
import type { LLMGatewayProviderDispatcher } from './llm/provider-dispatcher.js';
import { registerAppApiRoute } from './openapi.js';
import type { ResolvedLLMProviderConfig } from './providers/llm-config.js';
import { getGoalRecord } from './runtime/goal-store.js';
import {
  IdempotencyKeyConflictError,
  type InflightIdempotentCommand,
  runIdempotentCommand,
} from './runtime/idempotent-command.js';
import { TurnStartValidationError } from './runtime/orchestrator.js';
import { listWorkspaceSyncReviews } from './runtime/workspace-sync-records.js';
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

/** Closed Chat result kinds needed to reconstruct one accepted response from durable owners. */
const ChatModeCommandResultKindSchema = z.enum([
  'knowledge-answer',
  'repository-answer',
  'provider-answer',
  'clarification',
  'task-handoff',
  'goal-handoff',
  'refused',
]);

/** Closed Chat result kind retained by the bounded receipt. */
type ChatModeCommandResultKind = z.infer<typeof ChatModeCommandResultKindSchema>;

/** Deterministic durable Item prefix for each accepted Chat result kind. */
const CHAT_MODE_RESULT_ITEM_PREFIX = {
  'knowledge-answer': 'it_chat_answer_',
  'repository-answer': 'it_chat_repo_files_',
  'provider-answer': 'it_chat_answer_',
  clarification: 'it_chat_clarify_',
  'task-handoff': 'it_chat_task_',
  'goal-handoff': 'it_chat_goal_',
  refused: 'it_chat_refused_',
} satisfies Record<ChatModeCommandResultKind, string>;

/** Stable downstream business-owner identifiers for one Chat handoff. */
const ChatModeCommandDownstreamSchema = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('task'), turnId: z.string().min(1) }),
    z.object({
      kind: z.literal('goal'),
      goalId: z.string().min(1),
      turnId: z.string().min(1),
    }),
  ])
  .nullable();

/** Outcome-only receipt needed to locate durable owners of one accepted Chat response. */
const ChatModeCommandSnapshotSchema = z.object({
  downstream: ChatModeCommandDownstreamSchema,
  resultKind: ChatModeCommandResultKindSchema,
  status: z.union([z.literal(200), z.literal(202)]),
});

/** Stable downstream business-owner identifiers retained by the bounded receipt. */
type ChatModeCommandDownstream = z.infer<typeof ChatModeCommandDownstreamSchema>;

/** Accepted Chat Mode result plus its HTTP status. */
type ChatModeCommandResult = {
  /** Public response projected from durable Chat owners. */
  readonly body: StartChatModeResponse;
  /** Stable downstream owner identifiers for handoff validation. */
  readonly downstream: ChatModeCommandDownstream;
  /** Closed result kind used to reconstruct fixed response fields. */
  readonly resultKind: ChatModeCommandResultKind;
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
function replayChatModeCommand(
  store: FsStore,
  repositoryWorkspaceDb: (store: FsStore, workspaceId: string) => WorkspaceDb,
  workspaceId: string,
  threadId: string,
  record: CommandRequestRecord
): ChatModeCommandResult {
  try {
    const snapshot = ChatModeCommandSnapshotSchema.parse(record.response.snapshot);
    const currentTurn = store.getTurnById(record.response.id);
    const itemRevisions = store.listWorkspaceItemRevisions(workspaceId);
    const userItemId = `it_chat_user_${currentTurn.id}`;
    const resultItemId = `${CHAT_MODE_RESULT_ITEM_PREFIX[snapshot.resultKind]}${currentTurn.id}`;
    const userItem = itemRevisions.find((item) => item.id === userItemId);
    const resultItem = itemRevisions.find((item) => item.id === resultItemId);
    const currentUserItem = currentTurn.items.find((item) => item.id === userItemId);
    const currentResultItem = currentTurn.items.find((item) => item.id === resultItemId);

    if (
      record.response.kind !== 'turn' ||
      currentTurn.workspaceId !== workspaceId ||
      currentTurn.threadId !== threadId ||
      userItem?.type !== 'user-message' ||
      userItem.status !== 'completed' ||
      !userItem.completedAt ||
      userItem.workspaceId !== workspaceId ||
      userItem.threadId !== threadId ||
      userItem.turnId !== currentTurn.id ||
      resultItem?.workspaceId !== workspaceId ||
      resultItem.threadId !== threadId ||
      resultItem.turnId !== currentTurn.id ||
      currentTurn.startedAt !== userItem.createdAt ||
      resultItem.createdAt !== userItem.createdAt ||
      !currentUserItem ||
      currentUserItem.type !== userItem.type ||
      currentUserItem.createdAt !== userItem.createdAt ||
      !currentResultItem ||
      currentResultItem.type !== resultItem.type ||
      currentResultItem.createdAt !== resultItem.createdAt
    ) {
      throw new Error('Chat command owner contradiction.');
    }

    if (snapshot.resultKind === 'clarification') {
      if (
        snapshot.status !== 202 ||
        snapshot.downstream !== null ||
        resultItem.type !== 'user-input-request' ||
        resultItem.status !== 'in_progress' ||
        resultItem.completedAt !== null
      ) {
        throw new Error('Chat clarification owner contradiction.');
      }

      return {
        body: StartChatModeResponseSchema.parse({
          outcome: 'clarification-needed',
          explanation: 'The Assistant needs a concrete request before choosing a mode.',
          turn: {
            id: currentTurn.id,
            workspaceId,
            threadId,
            items: [userItem, resultItem],
            status: 'awaiting_human',
            humanGate: {
              kind: 'user-input',
              userInputRequestId: resultItem.userInputRequestId,
              itemId: resultItem.id,
            },
            error: null,
            configVersion: null,
            startedAt: userItem.createdAt,
            completedAt: null,
            durationMs: null,
          },
          item: resultItem,
          handoff: null,
        }),
        downstream: null,
        resultKind: snapshot.resultKind,
        status: snapshot.status,
      };
    }

    if (
      !resultItem.completedAt ||
      currentTurn.status !== 'completed' ||
      currentTurn.completedAt !== resultItem.completedAt
    ) {
      throw new Error('Chat terminal result Item is incomplete.');
    }

    let outcome: StartChatModeResponse['outcome'];
    let explanation: string;
    let handoff: StartChatModeResponse['handoff'] = null;

    if (
      snapshot.resultKind === 'knowledge-answer' ||
      snapshot.resultKind === 'repository-answer' ||
      snapshot.resultKind === 'provider-answer'
    ) {
      if (
        resultItem.type !== 'assistant-message' ||
        resultItem.status !== 'completed' ||
        snapshot.downstream !== null ||
        (snapshot.resultKind === 'repository-answer'
          ? snapshot.status !== 202
          : snapshot.status !== 200)
      ) {
        throw new Error('Chat answer owner contradiction.');
      }

      outcome = 'answered';
      explanation =
        snapshot.resultKind === 'knowledge-answer'
          ? 'The Assistant answered from workspace knowledge.'
          : snapshot.resultKind === 'repository-answer'
            ? 'The Assistant answered from a read-only repository inspection.'
            : 'The Assistant answered directly.';
    } else if (snapshot.resultKind === 'task-handoff') {
      if (
        resultItem.type !== 'status' ||
        resultItem.status !== 'completed' ||
        !resultItem.summary ||
        snapshot.status !== 202 ||
        snapshot.downstream?.kind !== 'task'
      ) {
        throw new Error('Chat Task handoff owner contradiction.');
      }

      const downstreamTurn = store.getTurnById(snapshot.downstream.turnId);

      if (
        downstreamTurn.id === currentTurn.id ||
        downstreamTurn.workspaceId !== workspaceId ||
        downstreamTurn.threadId !== threadId ||
        !downstreamTurn.id.startsWith(`turn_${record.requestId}`) ||
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
    } else if (snapshot.resultKind === 'goal-handoff') {
      if (
        resultItem.type !== 'status' ||
        resultItem.status !== 'completed' ||
        !resultItem.summary ||
        snapshot.status !== 202 ||
        snapshot.downstream?.kind !== 'goal'
      ) {
        throw new Error('Chat Goal handoff owner contradiction.');
      }

      const goalTurn = store.getTurnById(snapshot.downstream.turnId);
      const ids = goalStartOwnerIds({
        owningCommand: 'chat.start',
        requestId: record.requestId,
        store,
        workspaceId,
        threadId,
      });
      const workspaceDb = repositoryWorkspaceDb(store, workspaceId);

      try {
        const goal = getGoalRecord(workspaceDb, workspaceId, threadId, snapshot.downstream.goalId);
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
        snapshot.downstream !== null
      ) {
        throw new Error('Chat refusal owner contradiction.');
      }

      outcome = 'refused';
      explanation = resultItem.summary;
    }

    return {
      body: StartChatModeResponseSchema.parse({
        outcome,
        explanation,
        turn: {
          id: currentTurn.id,
          workspaceId,
          threadId,
          items: [userItem, resultItem],
          status: 'completed',
          humanGate: null,
          error: null,
          configVersion: null,
          startedAt: userItem.createdAt,
          completedAt: resultItem.completedAt,
          durationMs: Math.max(
            0,
            new Date(resultItem.completedAt).getTime() - new Date(userItem.createdAt).getTime()
          ),
        },
        item: resultItem,
        handoff,
      }),
      downstream: snapshot.downstream,
      resultKind: snapshot.resultKind,
      status: snapshot.status,
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
  coreDb: CoreDb | undefined,
  repositoryWorkspaceDb: (store: FsStore, workspaceId: string) => WorkspaceDb,
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

    if (currentTurn.id.startsWith(`turn_${record.requestId}`)) {
      const initiatingItem = currentTurn.items.find(
        (item) => item.id === `it_user_${currentTurn.id}`
      );

      if (initiatingItem?.type !== 'user-message' || initiatingItem.status !== 'completed') {
        throw new Error('Task worker Turn owner contradiction.');
      }

      const workspaceDb = coreDb ? repositoryWorkspaceDb(store, workspaceId) : null;

      try {
        return StartTaskModeResponseSchema.parse({
          state: taskModeStateForTurn(currentTurn.status),
          turn: currentTurn,
          completion: taskModeCompletionForTurn(store, workspaceId, threadId, currentTurn),
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
      owningCommand: 'task.start',
      requestId: record.requestId,
      store,
      workspaceId,
      threadId,
    });
    const workspaceDb = repositoryWorkspaceDb(store, workspaceId);

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
 * Records durable usage for one successful QuickChat LLM call when storage is available.
 *
 * @param input QuickChat usage attribution and provider usage payload.
 */
function recordQuickChatLlmUsage(input: {
  /** Optional Core database handle for durable workspace storage. */
  coreDb?: CoreDb;
  /** Store that owns the user/workspace mapping. */
  store: FsStore;
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

  const workspaceDb = openWorkspaceDb(
    input.coreDb.dataRoot,
    input.store.getUserId(),
    input.workspaceId
  );

  try {
    applyScopedMigrations(workspaceDb);
    const call = startCapabilityCall({
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
function asProviderApiError(error: OpenAICompatibleProviderError): Response {
  const message = redactInternalAgentText(error.message);
  const providerCode = redactInternalAgentText(error.code);
  const providerType = error.type === null ? null : redactInternalAgentText(error.type);

  if (error.status === 429) {
    return Response.json(
      apiErrorPayload({
        code: 'provider_rate_limited',
        message,
        details: {
          providerCode,
          providerStatus: error.status,
          providerType,
        },
      }),
      { status: 429 }
    );
  }

  return Response.json(
    apiErrorPayload({
      code: 'provider_request_failed',
      message,
      details: {
        providerCode,
        providerStatus: error.status,
        providerType,
      },
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
  const knowledgeContext = prepareKnowledgeContext({
    operationId: `km_context_${randomUUID()}`,
    workspaceId: input.workspaceId,
    caller: 'workflow-coordinator',
    query: input.prompt,
    limit: 5,
    entries: input.store.listKnowledge(input.workspaceId),
  });
  const contextRefs: DelegationContextRef[] =
    knowledgeContext.outcome === 'prepared'
      ? knowledgeContext.materials.map((material) => ({
          kind: 'knowledge',
          id: material.knowledgeEntryId,
        }))
      : [];
  const coordinator = createWorkerCoordinatorDecision({
    prompt: input.prompt,
    readiness: input.workerCoordinatorCandidates(input.store, input.workspaceId),
    threadState: { status: 'idle', threadId: input.threadId },
    workspaceSummary: {
      name: input.store.getWorkspace(input.workspaceId).name,
      workspaceId: input.workspaceId,
    },
    contextRefs,
  });

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
        runtime: coordinator.selectedWorkerCandidate.runtime,
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
 * @param store Actor-scoped store that owns the workspace.
 * @param workspaceId Workspace id to inspect.
 * @returns Effective repository inspection policy.
 */
function chatRepositoryInspectionPolicy(
  snapshot: RuntimeConfigSnapshot,
  store: FsStore,
  workspaceId: string
): ChatRepositoryInspectionPolicy {
  const workspaceConfig = findWorkspaceConfig(snapshot, store.getUserId(), workspaceId);
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
 * Starts one Task Mode worker attempt through the shared app composition callback.
 *
 * @param input Task Mode selection and runtime callback.
 * @returns Started Task Mode projection for the selected worker.
 */
async function startTaskModeAttempt(input: {
  readonly store: FsStore;
  readonly workspaceId: string;
  readonly threadId: string;
  readonly modelId?: string | undefined;
  readonly requestId: string;
  readonly decision: TaskDelegationDecision;
  readonly workerRequest: StructuredWorkerDelegationRequest;
  readonly startModeWorkerTurn: (input: {
    readonly store: FsStore;
    readonly workspaceId: string;
    readonly threadId: string;
    readonly prompt: string;
    readonly modelId?: string | undefined;
    readonly requestId: string;
    readonly requestedAgentId: string;
  }) => Promise<z.infer<typeof TurnSchema>>;
}): Promise<{
  readonly decision: TaskDelegationDecision;
  readonly state: ReturnType<typeof taskModeStateForTurn>;
  readonly turn: z.infer<typeof TurnSchema>;
}> {
  const turn = await input.startModeWorkerTurn({
    store: input.store,
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    prompt: serializeStructuredWorkerDelegationRequest(input.workerRequest),
    modelId: input.modelId,
    requestId: input.requestId,
    requestedAgentId: input.decision.worker.agentId,
  });

  return {
    decision: input.decision,
    state: taskModeStateForTurn(turn.status),
    turn,
  };
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
  gatewayDefaultModel,
  gatewayDefaultProviderId,
  inflightCommands,
  llmGatewayDispatcher,
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
  readonly gatewayDefaultModel: () => string | null;
  readonly gatewayDefaultProviderId: () => string | null;
  readonly inflightCommands: WeakMap<FsStore, Map<string, InflightIdempotentCommand>>;
  readonly llmGatewayDispatcher: Pick<LLMGatewayProviderDispatcher, 'createChatCompletion'>;
  readonly repositoryWorkspaceDb: (store: FsStore, workspaceId: string) => WorkspaceDb;
  readonly requestStore: (context: Context<{ Variables: AuthVariables }>) => FsStore;
  readonly resolveGatewayProvider: (providerId: string) => ResolvedLLMProviderConfig;
  readonly runtimeConfig: () => RuntimeConfigSnapshot;
  readonly startModeWorkerTurn: (input: {
    readonly store: FsStore;
    readonly workspaceId: string;
    readonly threadId: string;
    readonly prompt: string;
    readonly modelId?: string | undefined;
    readonly requestId: string;
    readonly requestedAgentId: string;
  }) => Promise<z.infer<typeof TurnSchema>>;
  readonly workerCoordinatorCandidates: (
    store: FsStore,
    workspaceId: string
  ) => WorkerCoordinatorCandidate[];
}): void {
  /**
   * Resolves provider and model for quick-chat requests.
   *
   * @param providerId Optional provider id from request body.
   * @param model Optional model from request body.
   * @returns Provider id and model selected for quick chat.
   */
  function quickChatSelection(providerId?: string, model?: string) {
    return {
      providerId: providerId ?? gatewayDefaultProviderId(),
      model: model ?? gatewayDefaultModel(),
    };
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
    /** Selected provider id. */
    readonly providerId: string;
    /** Selected model id. */
    readonly model: string;
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
    const provider = resolveGatewayProvider(input.providerId);
    const timeoutSignal = AbortSignal.timeout(QUICK_CHAT_TIMEOUT_MS);
    const signal = AbortSignal.any([input.signal, timeoutSignal]);
    let abortListener: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      abortListener = () => reject(signal.reason);
      signal.addEventListener('abort', abortListener, { once: true });
    });
    let response: Awaited<ReturnType<LLMGatewayProviderDispatcher['createChatCompletion']>>;

    try {
      signal.throwIfAborted();
      response = await Promise.race([
        llmGatewayDispatcher.createChatCompletion(
          provider,
          {
            model: input.model,
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
            promptCacheScope: {
              sessionId: input.sessionId,
              workspaceId: input.workspaceId,
            },
            usageEndpoint: 'quick_chat',
            transport: { signal },
          }
        ),
        aborted,
      ]);
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
    const content = response.choices[0]?.message.content;

    if (typeof content !== 'string' || content.trim().length === 0) {
      throw new TurnStartValidationError(
        'provider_response_invalid',
        'Quick chat provider returned invalid assistant content.',
        502
      );
    }

    return {
      id: response.id,
      content,
      providerId: provider.id,
      ...(response.usage === undefined ? {} : { usage: response.usage }),
    };
  }

  registerAppApiRoute(app, 'quickChat', async (c) => {
    const parsed = QuickChatRequestSchema.safeParse(await c.req.json().catch(() => ({})));

    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    try {
      const input = parsed.data;
      const { model, providerId } = quickChatSelection(input.providerId, input.model);
      const workspaceId = input.workspaceId ?? 'ws_quick_chat';
      const sessionId = `quick-chat:${workspaceId}`;

      if (!providerId || !model) {
        return c.json(
          apiErrorPayload({
            code: 'quick_chat_not_configured',
            message: 'Quick chat requires a default provider and model.',
          }),
          400
        );
      }

      const result = await callQuickChatProvider({
        providerId,
        model,
        prompt: input.input,
        sessionId,
        workspaceId,
        signal: c.req.raw.signal,
      });
      recordQuickChatLlmUsage({
        ...(coreDb ? { coreDb } : {}),
        model,
        providerId: result.providerId,
        store: requestStore(c),
        ...(result.usage === undefined ? {} : { usage: result.usage }),
        workspaceId,
      });

      return c.json(
        QuickChatResponseSchema.parse({
          id: result.id,
          status: 'completed',
          workspaceId,
          providerId: result.providerId,
          model,
          content: result.content,
        })
      );
    } catch (error) {
      if (error instanceof OpenAICompatibleProviderError) {
        return asProviderApiError(error);
      }
      if (error instanceof TurnStartValidationError) {
        return asApiError(redactInternalAgentText(error.message), error.code, error.status);
      }

      return asApiError(
        redactInternalAgentText(error instanceof Error ? error.message : String(error)),
        'quick_chat_failed',
        500
      );
    }
  });

  registerAppApiRoute(app, 'startChatMode', async (c) => {
    const parsed = StartChatModeRequestSchema.safeParse(await c.req.json().catch(() => ({})));

    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }
    const chatInput = parsed.data;

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
    ): Promise<ChatModeCommandResult> {
      const workspace = store.getWorkspace(workspaceId);
      const isQuickChatWorkspace = workspace.kind === 'quick-chat';

      store.getThread(workspaceId, threadId);

      /**
       * Creates the durable Chat Mode turn and its user-message item.
       *
       * @param completedAt Completion timestamp shared by first-slice Chat Mode items.
       * @returns Created turn.
       */
      const createChatTurn = (completedAt: string) => {
        const turn = store.createTurn(workspaceId, threadId, chatInput.input);

        store.createItem({
          id: `it_chat_user_${turn.id}`,
          workspaceId,
          threadId,
          turnId: turn.id,
          type: 'user-message',
          status: 'completed',
          text: chatInput.input,
          createdAt: turn.startedAt ?? completedAt,
          completedAt,
        });

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

        return StartChatModeResponseSchema.parse({
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
          status: 'in_progress',
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
          completedAt: null,
        });
        const waitingTurn = store.updateTurn(turn.id, {
          status: 'awaiting_human',
          humanGate: {
            kind: 'user-input',
            userInputRequestId: requestId,
            itemId: questionItem.id,
          },
        });

        return StartChatModeResponseSchema.parse({
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

        return StartChatModeResponseSchema.parse({
          outcome: 'refused',
          explanation,
          turn: completedTurn,
          item: refusedItem,
          handoff: null,
        });
      };

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
        const attempt = await startTaskModeAttempt({
          store,
          workspaceId,
          threadId,
          requestId: chatInput.requestId,
          decision: delegation.taskDecision,
          workerRequest: delegation.coordinator.workerRequest,
          startModeWorkerTurn,
        });

        return {
          body: createHandoffResponse('task', delegation.taskDecision.rationale),
          downstream: { kind: 'task', turnId: attempt.turn.id },
          resultKind: 'task-handoff',
          status: 202,
        };
      }

      if (delegation?.coordinator.decision === 'goal') {
        const goalStart = startGoalModeObjective({
          assertProjectWorkspace,
          coreDb,
          repositoryWorkspaceDb,
          store,
          workspaceId,
          threadId,
          owningCommand: 'chat.start',
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

      const knowledgeAnswer = answerKnowledgeManager({
        operationId: `km_answer_${randomUUID()}`,
        workspaceId,
        caller: 'assistant',
        query: chatInput.input,
        limit: 3,
        entries: store.listKnowledge(workspaceId),
      });

      if (knowledgeAnswer.outcome === 'answered') {
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
        const completedTurn = store.updateTurn(turn.id, {
          status: 'completed',
          completedAt,
        });

        return {
          body: StartChatModeResponseSchema.parse({
            outcome: 'answered',
            explanation: 'The Assistant answered from workspace knowledge.',
            turn: completedTurn,
            item: answerItem,
            handoff: null,
          }),
          downstream: null,
          resultKind: 'knowledge-answer',
          status: 200,
        };
      }

      if (
        (isRepositoryFileListChatPrompt(chatInput.input) ||
          isRepositoryFileReadChatPrompt(chatInput.input)) &&
        coreDb
      ) {
        const repositoryInspectionPolicy = chatRepositoryInspectionPolicy(
          runtimeConfig(),
          store,
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

        const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
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
              body: StartChatModeResponseSchema.parse({
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

      const { model, providerId } = quickChatSelection(chatInput.providerId, chatInput.model);
      const sessionId = `chat-mode:${workspaceId}:${threadId}`;

      if (!providerId || !model) {
        throw new TurnStartValidationError(
          'chat_mode_not_configured',
          'Chat Mode requires a default provider and model.',
          400
        );
      }

      const result = await callQuickChatProvider({
        providerId,
        model,
        prompt: chatInput.input,
        sessionId,
        workspaceId,
        signal: c.req.raw.signal,
      });
      const completedAt = new Date().toISOString();
      const turn = createChatTurn(completedAt);
      recordQuickChatLlmUsage({
        ...(coreDb ? { coreDb } : {}),
        model,
        providerId: result.providerId,
        requestId: chatInput.requestId,
        store,
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
        body: StartChatModeResponseSchema.parse({
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
      const workspaceId = c.req.param('workspaceId');
      const threadId = c.req.param('threadId');
      const store = requestStore(c);
      const result = await runIdempotentCommand({
        command: 'chat.start',
        execute: () => executeChatCommand(store, workspaceId, threadId),
        inflightCommands,
        input: {
          input: chatInput.input,
          model: chatInput.model,
          providerId: chatInput.providerId,
        },
        replay: (record) =>
          replayChatModeCommand(store, repositoryWorkspaceDb, workspaceId, threadId, record),
        requestId: chatInput.requestId,
        responseId: ({ body }) => body.turn.id,
        responseKind: 'turn',
        responseSnapshot: ({ downstream, resultKind, status }) => ({
          downstream,
          resultKind,
          status,
        }),
        scope: { threadId, workspaceId },
        store,
      });

      return c.json(result.body, result.status);
    } catch (error) {
      if (error instanceof TurnStartValidationError) {
        return asApiError(redactInternalAgentText(error.message), error.code, error.status);
      }
      if (error instanceof OpenAICompatibleProviderError) {
        return asProviderApiError(error);
      }
      if (error instanceof IdempotencyKeyConflictError) {
        return asApiError(redactInternalAgentText(error.message), error.code, error.status);
      }

      return asApiError(
        redactInternalAgentText(error instanceof Error ? error.message : String(error)),
        'chat_mode_failed',
        500
      );
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
  readonly repositoryWorkspaceDb: (store: FsStore, workspaceId: string) => WorkspaceDb;
  readonly requestStore: (context: Context<{ Variables: AuthVariables }>) => FsStore;
  readonly startModeWorkerTurn: (input: {
    readonly store: FsStore;
    readonly workspaceId: string;
    readonly threadId: string;
    readonly prompt: string;
    readonly modelId?: string | undefined;
    readonly requestId: string;
    readonly requestedAgentId: string;
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
      store.getThread(workspaceId, threadId);

      const delegation = createTaskModeDelegation({
        store,
        workspaceId,
        threadId,
        prompt: taskInput.input,
        workerCoordinatorCandidates,
      });

      if (delegation.coordinator.decision === 'goal') {
        const goalStart = startGoalModeObjective({
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

      if (!delegation.taskDecision || !delegation.coordinator.workerRequest) {
        throw new TurnStartValidationError(
          'task_mode_not_delegated',
          delegation.coordinator.explanation,
          409
        );
      }

      const attempt = await startTaskModeAttempt({
        store,
        workspaceId,
        threadId,
        modelId: taskInput.modelId,
        requestId: taskInput.requestId,
        decision: delegation.taskDecision,
        workerRequest: delegation.coordinator.workerRequest,
        startModeWorkerTurn,
      });

      const workspaceDb = coreDb ? repositoryWorkspaceDb(store, workspaceId) : null;
      let evidence: TaskModeEvidence;

      try {
        evidence = taskModeEvidenceForTurn(store, workspaceDb, workspaceId, threadId, attempt.turn);
      } finally {
        workspaceDb?.sqlite.close();
      }

      return StartTaskModeResponseSchema.parse({
        state: attempt.state,
        turn: attempt.turn,
        completion: taskModeCompletionForTurn(store, workspaceId, threadId, attempt.turn),
        evidence,
      });
    }

    try {
      const workspaceId = c.req.param('workspaceId');
      const threadId = c.req.param('threadId');
      const store = requestStore(c);
      const result = await runIdempotentCommand({
        command: 'task.start',
        execute: () => executeTaskCommand(store, workspaceId, threadId),
        inflightCommands,
        input: { input: taskInput.input, modelId: taskInput.modelId },
        replay: (record) =>
          replayTaskModeCommand(
            store,
            coreDb,
            repositoryWorkspaceDb,
            workspaceId,
            threadId,
            record
          ),
        requestId: taskInput.requestId,
        responseId: ({ turn }) => turn.id,
        responseKind: 'turn',
        scope: { threadId, workspaceId },
        store,
      });

      return c.json(result, 202);
    } catch (error) {
      if (error instanceof TurnStartValidationError) {
        return asApiError(error.message, error.code, error.status);
      }

      return asCommandError(error, 'task_mode_start_failed');
    }
  });
}
