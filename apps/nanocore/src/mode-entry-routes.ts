import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, relative, resolve, sep } from 'node:path';

import {
  QuickChatRequestSchema,
  QuickChatResponseSchema,
  StartChatModeRequestSchema,
  StartChatModeResponseSchema,
  StartTaskModeRequestSchema,
  StartTaskModeResponseSchema,
  type TaskDelegationDecision,
  type TaskModeEvidence,
} from '@openkit/app-api-schemas';
import type { TurnSchema } from '@openkit/protocol';
import type { Context, Hono } from 'hono';
import type { z } from 'zod';

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
import { startGoalModeObjective } from './goal-routes.js';
import type { DelegationContextRef } from './internal-agents/delegation.js';
import { QUICK_CHAT_AGENT_ID, type QuickChatAgentOutput } from './internal-agents/quick-chat.js';
import type { InternalAgentRunner } from './internal-agents/runner.js';
import {
  createWorkerCoordinatorDecision,
  type WorkerCoordinatorCandidate,
  type WorkerCoordinatorDecision,
} from './internal-agents/worker-coordinator.js';
import { answerKnowledgeManager, prepareKnowledgeContext } from './knowledge-manager.js';
import type { FsStore } from './lib/store.js';
import { parseUsage } from './llm/gateway-usage.js';
import { OpenAICompatibleProviderError } from './llm/openai-compatible-client.js';
import { registerAppApiRoute } from './openapi.js';
import { TurnStartValidationError } from './runtime/orchestrator.js';
import { listWorkspaceSyncReviews } from './runtime/workspace-sync-records.js';
import { type CoreDb, openWorkspaceDb, type WorkspaceDb } from './storage/db.js';
import { applyScopedMigrations } from './storage/migrate.js';
import {
  getDefaultWorkspaceRepositoryResource,
  type WorkspaceRepositoryResourceRecord,
} from './workspace/repository-store.js';

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
  if (error.status === 429) {
    return Response.json(
      apiErrorPayload({
        code: 'provider_rate_limited',
        message: error.message,
        details: {
          providerCode: error.code,
          providerStatus: error.status,
          providerType: error.type,
        },
      }),
      { status: 429 }
    );
  }

  return Response.json(
    apiErrorPayload({
      code: 'provider_request_failed',
      message: error.message,
      details: {
        providerCode: error.code,
        providerStatus: error.status,
        providerType: error.type,
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

  if (coordinator.decision !== 'worker_turn' || !coordinator.selectedWorkerCandidate) {
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
      requiredApprovals:
        coordinator.requiredUserAction === 'none' ||
        coordinator.requiredUserAction === 'confirm_worker_turn'
          ? []
          : [coordinator.requiredUserAction],
      expectedStopCondition: 'one bounded worker turn',
      escalationRecommended: false,
      contextRefs: coordinator.workerRequest?.contextRefs ?? [
        { kind: 'workspace', id: input.workspaceId },
        { kind: 'thread', id: input.threadId },
      ],
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
  readonly prompt: string;
  readonly modelId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly decision: TaskDelegationDecision;
  readonly startModeWorkerTurn: (input: {
    readonly store: FsStore;
    readonly workspaceId: string;
    readonly threadId: string;
    readonly prompt: string;
    readonly modelId?: string | undefined;
    readonly requestId?: string | undefined;
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
    prompt: input.prompt,
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
  getInternalAgentRunner,
  repositoryWorkspaceDb,
  requestStore,
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
  readonly getInternalAgentRunner: () => Pick<InternalAgentRunner, 'run'>;
  readonly repositoryWorkspaceDb: (store: FsStore, workspaceId: string) => WorkspaceDb;
  readonly requestStore: (context: Context<{ Variables: AuthVariables }>) => FsStore;
  readonly runtimeConfig: () => RuntimeConfigSnapshot;
  readonly startModeWorkerTurn: (input: {
    readonly store: FsStore;
    readonly workspaceId: string;
    readonly threadId: string;
    readonly prompt: string;
    readonly modelId?: string | undefined;
    readonly requestId?: string | undefined;
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

  registerAppApiRoute(app, 'quickChat', async (c) => {
    try {
      const input = QuickChatRequestSchema.parse(await c.req.json());
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

      const result = await getInternalAgentRunner().run<QuickChatAgentOutput>({
        agentId: QUICK_CHAT_AGENT_ID,
        providerId,
        model,
        messages: [{ role: 'user', content: input.input }],
        metadata: {
          openkit: {
            sessionId,
            workspaceId,
          },
        },
        dispatchContext: {
          promptCacheScope: {
            sessionId,
            workspaceId,
          },
          usageEndpoint: 'quick_chat',
        },
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
          content: result.output.content,
        })
      );
    } catch (error) {
      if (error instanceof OpenAICompatibleProviderError) {
        return asProviderApiError(error);
      }

      return c.json(
        apiErrorPayload({
          code: 'quick_chat_failed',
          message: (error as Error).message,
        }),
        400
      );
    }
  });

  registerAppApiRoute(app, 'startChatMode', async (c) => {
    const parsed = StartChatModeRequestSchema.safeParse(await c.req.json().catch(() => ({})));

    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    try {
      const workspaceId = c.req.param('workspaceId');
      const threadId = c.req.param('threadId');
      const store = requestStore(c);
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
        const turn = store.createTurn(workspaceId, threadId, parsed.data.input);

        store.createItem({
          id: `it_chat_user_${turn.id}`,
          workspaceId,
          threadId,
          turnId: turn.id,
          type: 'user-message',
          status: 'completed',
          text: parsed.data.input,
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

      if (isClarificationChatPrompt(parsed.data.input)) {
        return c.json(createClarificationResponse(), 202);
      }

      if (isExternalSearchChatPrompt(parsed.data.input)) {
        return c.json(createRefusedResponse('External search is not enabled for Chat Mode.'));
      }

      if (isQuickChatWorkspace && isProjectWorkChatPrompt(parsed.data.input)) {
        assertProjectWorkspace(workspace, 'handle project work');
      }

      const delegation = isQuickChatWorkspace
        ? null
        : createTaskModeDelegation({
            store,
            workspaceId,
            threadId,
            prompt: parsed.data.input,
            workerCoordinatorCandidates,
          });

      if (delegation?.taskDecision) {
        await startTaskModeAttempt({
          store,
          workspaceId,
          threadId,
          prompt: parsed.data.input,
          requestId: parsed.data.requestId,
          decision: delegation.taskDecision,
          startModeWorkerTurn,
        });

        return c.json(createHandoffResponse('task', delegation.taskDecision.rationale), 202);
      }

      if (delegation?.coordinator.decision === 'goal') {
        startGoalModeObjective({
          assertProjectWorkspace,
          coreDb,
          repositoryWorkspaceDb,
          store,
          workspaceId,
          threadId,
          objective: parsed.data.input,
        });

        return c.json(createHandoffResponse('goal', delegation.coordinator.explanation), 202);
      }

      if (delegation && delegation.coordinator.decision !== 'quick_chat') {
        return c.json(createRefusedResponse(delegation.coordinator.explanation));
      }

      const knowledgeAnswer = answerKnowledgeManager({
        operationId: `km_answer_${randomUUID()}`,
        workspaceId,
        caller: 'assistant',
        query: parsed.data.input,
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

        return c.json(
          StartChatModeResponseSchema.parse({
            outcome: 'answered',
            explanation: 'The Assistant answered from workspace knowledge.',
            turn: completedTurn,
            item: answerItem,
            handoff: null,
          })
        );
      }

      if (
        (isRepositoryFileListChatPrompt(parsed.data.input) ||
          isRepositoryFileReadChatPrompt(parsed.data.input)) &&
        coreDb
      ) {
        const repositoryInspectionPolicy = chatRepositoryInspectionPolicy(
          runtimeConfig(),
          store,
          workspaceId
        );

        if (!repositoryInspectionPolicy.enabled) {
          return c.json(
            createRefusedResponse('Workspace policy disables Chat Mode repository inspection.'),
            202
          );
        }

        const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
        let repository: WorkspaceRepositoryResourceRecord | null;

        try {
          repository = getDefaultWorkspaceRepositoryResource(workspaceDb, workspaceId);

          if (repository) {
            let repositoryFileList: RepositoryFileListResult;

            try {
              repositoryFileList = isRepositoryFileReadChatPrompt(parsed.data.input)
                ? formatRepositoryFileRead(
                    repository,
                    parsed.data.input,
                    repositoryInspectionPolicy
                  )
                : formatRepositoryFileList(
                    repository,
                    parsed.data.input,
                    repositoryInspectionPolicy
                  );
            } catch (error) {
              if (error instanceof ChatRepositoryInspectionPolicyError) {
                return c.json(createRefusedResponse(error.message), 202);
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
              requestId: parsed.data.requestId ?? null,
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

            return c.json(
              StartChatModeResponseSchema.parse({
                outcome: 'answered',
                explanation: 'The Assistant answered from a read-only repository inspection.',
                turn: completedTurn,
                item: answerItem,
                handoff: null,
              }),
              202
            );
          }
        } finally {
          workspaceDb.sqlite.close();
        }
      }

      const { model, providerId } = quickChatSelection(parsed.data.providerId, parsed.data.model);
      const sessionId = `chat-mode:${workspaceId}:${threadId}`;

      if (!providerId || !model) {
        return c.json(
          apiErrorPayload({
            code: 'chat_mode_not_configured',
            message: 'Chat Mode requires a default provider and model.',
          }),
          400
        );
      }

      const result = await getInternalAgentRunner().run<QuickChatAgentOutput>({
        agentId: QUICK_CHAT_AGENT_ID,
        providerId,
        model,
        messages: [{ role: 'user', content: parsed.data.input }],
        metadata: {
          openkit: {
            sessionId,
            workspaceId,
          },
        },
        dispatchContext: {
          promptCacheScope: {
            sessionId,
            workspaceId,
          },
          usageEndpoint: 'quick_chat',
        },
      });
      const completedAt = new Date().toISOString();
      const turn = createChatTurn(completedAt);
      recordQuickChatLlmUsage({
        ...(coreDb ? { coreDb } : {}),
        model,
        providerId: result.providerId,
        ...(parsed.data.requestId === undefined ? {} : { requestId: parsed.data.requestId }),
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
        text: result.output.content,
        createdAt: turn.startedAt ?? completedAt,
        completedAt,
      });
      const completedTurn = store.updateTurn(turn.id, {
        status: 'completed',
        completedAt,
      });

      return c.json(
        StartChatModeResponseSchema.parse({
          outcome: 'answered',
          explanation: 'The Assistant answered directly.',
          turn: completedTurn,
          item,
          handoff: null,
        })
      );
    } catch (error) {
      if (error instanceof TurnStartValidationError) {
        return asApiError(error.message, error.code, error.status);
      }
      if (error instanceof OpenAICompatibleProviderError) {
        return asProviderApiError(error);
      }

      return asCommandError(error, 'chat_mode_failed');
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
  readonly repositoryWorkspaceDb: (store: FsStore, workspaceId: string) => WorkspaceDb;
  readonly requestStore: (context: Context<{ Variables: AuthVariables }>) => FsStore;
  readonly startModeWorkerTurn: (input: {
    readonly store: FsStore;
    readonly workspaceId: string;
    readonly threadId: string;
    readonly prompt: string;
    readonly modelId?: string | undefined;
    readonly requestId?: string | undefined;
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

    try {
      const workspaceId = c.req.param('workspaceId');
      const threadId = c.req.param('threadId');
      const store = requestStore(c);
      const workspace = store.getWorkspace(workspaceId);

      assertProjectWorkspace(workspace, 'start Task Mode');
      store.getThread(workspaceId, threadId);

      const delegation = createTaskModeDelegation({
        store,
        workspaceId,
        threadId,
        prompt: parsed.data.input,
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
          objective: parsed.data.input,
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

        return c.json(
          StartTaskModeResponseSchema.parse({
            decision: null,
            state: 'escalated-to-goal',
            turn: store.getTurnById(goalStart.turn.id),
            evidence: taskModeEvidenceForTurn(store, null, workspaceId, threadId, goalStart.turn),
            escalation: {
              targetMode: 'goal',
              goalId: goalStart.response.goal.goalId,
              reason,
            },
          }),
          202
        );
      }

      if (!delegation.taskDecision) {
        return Response.json(
          apiErrorPayload({
            code: 'task_mode_not_delegated',
            message: delegation.coordinator.explanation,
          }),
          { status: 409 }
        );
      }

      const attempt = await startTaskModeAttempt({
        store,
        workspaceId,
        threadId,
        prompt: parsed.data.input,
        modelId: parsed.data.modelId,
        requestId: parsed.data.requestId,
        decision: delegation.taskDecision,
        startModeWorkerTurn,
      });

      const workspaceDb = coreDb ? repositoryWorkspaceDb(store, workspaceId) : null;
      let evidence: TaskModeEvidence;

      try {
        evidence = taskModeEvidenceForTurn(store, workspaceDb, workspaceId, threadId, attempt.turn);
      } finally {
        workspaceDb?.sqlite.close();
      }

      return c.json(
        StartTaskModeResponseSchema.parse({
          decision: attempt.decision,
          state: attempt.state,
          turn: attempt.turn,
          completion: taskModeCompletionForTurn(store, workspaceId, threadId, attempt.turn),
          evidence,
        }),
        202
      );
    } catch (error) {
      if (error instanceof TurnStartValidationError) {
        return asApiError(error.message, error.code, error.status);
      }

      return asCommandError(error, 'task_mode_start_failed');
    }
  });
}
