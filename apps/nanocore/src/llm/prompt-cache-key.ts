import { createHash, randomUUID } from 'node:crypto';
import type { ResolvedLLMProviderConfig } from '../providers/llm-config.js';
import type {
  OpenAICompatibleChatCompletionRequest,
  OpenAICompatibleResponsesRequest,
} from './openai-compatible-client.js';

/**
 * OpenAI-compatible text generation request shape that accepts prompt cache fields.
 */
export type OpenAICompatiblePromptCacheRequest =
  | OpenAICompatibleChatCompletionRequest
  | OpenAICompatibleResponsesRequest;

/**
 * Stable OpenKit scope values that can improve prompt-cache routing without exposing raw prompts.
 */
export interface PromptCacheKeyScope {
  /** Workspace that owns the request, when known. */
  readonly workspaceId?: string;
  /** Thread that owns the request, when known. */
  readonly threadId?: string;
  /** Agent session that owns the request, when known. */
  readonly agentSessionId?: string;
  /** Client or app session that owns the request, when known. */
  readonly sessionId?: string;
}

/**
 * Construction options for PromptCacheKeyResolver.
 */
export interface PromptCacheKeyResolverOptions {
  /** Random id source used for request-scoped fallback keys. */
  readonly randomId?: () => string;
}

/**
 * Adds OpenAI-compatible prompt cache keys to text-generation requests.
 */
export class PromptCacheKeyResolver {
  private readonly randomId: () => string;

  /**
   * Creates one prompt cache key resolver.
   *
   * @param options Resolver dependencies and deterministic test hooks.
   */
  public constructor(options: PromptCacheKeyResolverOptions = {}) {
    this.randomId = options.randomId ?? randomUUID;
  }

  /**
   * Returns a text-generation request with a prompt cache key.
   *
   * @param provider Provider selected for the upstream request.
   * @param request Chat Completions or Responses-shaped request.
   * @param scope Optional stable OpenKit scope supplied by the caller.
   * @returns Request with a prompt_cache_key field.
   */
  public withPromptCacheKey<TRequest extends OpenAICompatiblePromptCacheRequest>(
    provider: ResolvedLLMProviderConfig,
    request: TRequest,
    scope: PromptCacheKeyScope = {}
  ): TRequest {
    const explicit = readNonEmptyString(request.prompt_cache_key);

    if (explicit) {
      return request;
    }

    const metadataScope = readOpenKitMetadataScope(request.metadata);
    const metadataKey = readNonEmptyString(metadataScope.promptCacheKey);

    if (metadataKey) {
      return { ...request, prompt_cache_key: metadataKey };
    }

    const stableScope = mergeStableScope(scope, metadataScope);

    if (hasStableScope(stableScope)) {
      return {
        ...request,
        prompt_cache_key: derivePromptCacheKey(provider, request.model, stableScope),
      };
    }

    return {
      ...request,
      prompt_cache_key: `openkit:responses:request:${this.randomId()}`,
    };
  }
}

interface OpenKitMetadataScope extends PromptCacheKeyScope {
  promptCacheKey?: string;
}

interface MutableOpenKitMetadataScope {
  promptCacheKey?: string;
  workspaceId?: string;
  threadId?: string;
  agentSessionId?: string;
  sessionId?: string;
}

function readOpenKitMetadataScope(metadata: unknown): OpenKitMetadataScope {
  if (!metadata || typeof metadata !== 'object') {
    return {};
  }

  const openkit = (metadata as Record<string, unknown>).openkit;

  if (!openkit || typeof openkit !== 'object') {
    return {};
  }

  const record = openkit as Record<string, unknown>;
  const promptCacheKey = readNonEmptyString(record.promptCacheKey);
  const workspaceId = readNonEmptyString(record.workspaceId);
  const threadId = readNonEmptyString(record.threadId);
  const agentSessionId = readNonEmptyString(record.agentSessionId);
  const sessionId = readNonEmptyString(record.sessionId);
  const output: MutableOpenKitMetadataScope = {};

  if (promptCacheKey) {
    output.promptCacheKey = promptCacheKey;
  }
  if (workspaceId) {
    output.workspaceId = workspaceId;
  }
  if (threadId) {
    output.threadId = threadId;
  }
  if (agentSessionId) {
    output.agentSessionId = agentSessionId;
  }
  if (sessionId) {
    output.sessionId = sessionId;
  }

  return output;
}

function mergeStableScope(
  callerScope: PromptCacheKeyScope,
  metadataScope: PromptCacheKeyScope
): PromptCacheKeyScope {
  const workspaceId = metadataScope.workspaceId ?? callerScope.workspaceId;
  const threadId = metadataScope.threadId ?? callerScope.threadId;
  const agentSessionId = metadataScope.agentSessionId ?? callerScope.agentSessionId;
  const sessionId = metadataScope.sessionId ?? callerScope.sessionId;
  const output: MutableOpenKitMetadataScope = {};

  if (workspaceId) {
    output.workspaceId = workspaceId;
  }
  if (threadId) {
    output.threadId = threadId;
  }
  if (agentSessionId) {
    output.agentSessionId = agentSessionId;
  }
  if (sessionId) {
    output.sessionId = sessionId;
  }

  return output;
}

function hasStableScope(scope: PromptCacheKeyScope): boolean {
  return Boolean(scope.workspaceId ?? scope.threadId ?? scope.agentSessionId ?? scope.sessionId);
}

function derivePromptCacheKey(
  provider: ResolvedLLMProviderConfig,
  model: string,
  scope: PromptCacheKeyScope
): string {
  const digest = createHash('sha256')
    .update(
      stableStringify({
        accountSlotId: provider.codexOAuthAccountSlotId ?? null,
        agentSessionId: scope.agentSessionId ?? null,
        model,
        providerId: provider.id,
        sessionId: scope.sessionId ?? null,
        threadId: scope.threadId ?? null,
        workspaceId: scope.workspaceId ?? null,
      })
    )
    .digest('hex')
    .slice(0, 32);

  return `openkit:responses:${digest}`;
}

function stableStringify(value: Record<string, unknown>): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)))
  );
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}
