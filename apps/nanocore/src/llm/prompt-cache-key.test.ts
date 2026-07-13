import { describe, expect, it } from 'vitest';
import type { ResolvedLLMProviderConfig } from '../providers/llm-config.js';
import type {
  OpenAICompatibleChatCompletionRequest,
  OpenAICompatibleResponsesRequest,
} from './openai-compatible-client.js';
import { PromptCacheKeyResolver, resolveWorkerPromptCacheKey } from './prompt-cache-key.js';

/**
 * Creates a provider config suitable for prompt-cache-key tests.
 *
 * @param overrides Provider fields to override.
 * @returns Resolved provider config.
 */
function providerConfig(
  overrides: Partial<ResolvedLLMProviderConfig> = {}
): ResolvedLLMProviderConfig {
  return {
    adapterId: 'openai',
    apiKey: 'sk-test',
    backend: 'pi-ai',
    baseUrl: 'https://api.example.test/v1',
    displayName: 'OpenAI',
    extraBody: {},
    extraHeaders: {},
    gatewayCapabilities: { chatCompletions: 'native', responses: 'native' },
    id: 'openai',
    requiresApiKey: true,
    ...overrides,
  };
}

/**
 * Creates a minimal Responses request.
 *
 * @param input Additional request fields.
 * @returns Responses request.
 */
function responsesRequest(
  input: Partial<OpenAICompatibleResponsesRequest> = {}
): OpenAICompatibleResponsesRequest {
  return {
    model: 'gpt-5.1',
    input: 'Hello',
    ...input,
  };
}

/**
 * Creates a minimal Chat Completions request.
 *
 * @param input Additional request fields.
 * @returns Chat Completions request.
 */
function chatRequest(
  input: Partial<OpenAICompatibleChatCompletionRequest> = {}
): OpenAICompatibleChatCompletionRequest {
  return {
    model: 'gpt-5.1',
    messages: [{ role: 'user', content: 'Hello' }],
    ...input,
  };
}

describe('PromptCacheKeyResolver', () => {
  it('keeps an explicit request prompt cache key', () => {
    const resolver = new PromptCacheKeyResolver({ randomId: () => 'fallback' });
    const request = resolver.withPromptCacheKey(
      providerConfig(),
      responsesRequest({ prompt_cache_key: 'client-key' })
    );

    expect(request.prompt_cache_key).toBe('client-key');
  });

  it('uses metadata.openkit.promptCacheKey before derived scopes', () => {
    const resolver = new PromptCacheKeyResolver({ randomId: () => 'fallback' });
    const request = resolver.withPromptCacheKey(
      providerConfig(),
      responsesRequest({
        metadata: {
          openkit: {
            promptCacheKey: 'metadata-key',
            workspaceId: 'ws_1',
            threadId: 'th_1',
          },
        },
      })
    );

    expect(request.prompt_cache_key).toBe('metadata-key');
  });

  it('derives a stable hashed key from non-secret OpenKit scope metadata', () => {
    const resolver = new PromptCacheKeyResolver({ randomId: () => 'fallback' });
    const first = resolver.withPromptCacheKey(
      providerConfig({ id: 'codex-team-a', codexOAuthAccountSlotId: 'team_a' }),
      responsesRequest({
        metadata: {
          openkit: {
            workspaceId: 'ws_demo',
            threadId: 'th_demo',
            agentSessionId: 'session_demo',
          },
        },
      })
    );
    const second = resolver.withPromptCacheKey(
      providerConfig({ id: 'codex-team-a', codexOAuthAccountSlotId: 'team_a' }),
      responsesRequest({
        metadata: {
          openkit: {
            workspaceId: 'ws_demo',
            threadId: 'th_demo',
            agentSessionId: 'session_demo',
          },
        },
      })
    );
    const otherSlot = resolver.withPromptCacheKey(
      providerConfig({ id: 'codex-team-a', codexOAuthAccountSlotId: 'team_b' }),
      responsesRequest({
        metadata: {
          openkit: {
            workspaceId: 'ws_demo',
            threadId: 'th_demo',
            agentSessionId: 'session_demo',
          },
        },
      })
    );

    expect(first.prompt_cache_key).toMatch(/^openkit:responses:[a-f0-9]{32}$/);
    expect(first.prompt_cache_key).toBe(second.prompt_cache_key);
    expect(first.prompt_cache_key).not.toBe(otherSlot.prompt_cache_key);
    expect(first.prompt_cache_key).not.toContain('ws_demo');
    expect(first.prompt_cache_key).not.toContain('team_a');
  });

  it('falls back to a request-scoped key when no stable scope exists', () => {
    const resolver = new PromptCacheKeyResolver({ randomId: () => 'req_1' });
    const request = resolver.withPromptCacheKey(providerConfig(), responsesRequest());

    expect(request.prompt_cache_key).toBe('openkit:responses:request:req_1');
  });

  it('adds prompt cache keys to Chat Completions-shaped requests', () => {
    const resolver = new PromptCacheKeyResolver({ randomId: () => 'fallback' });
    const explicit = resolver.withPromptCacheKey(
      providerConfig(),
      chatRequest({ prompt_cache_key: 'chat-client-key' })
    );
    const metadata = resolver.withPromptCacheKey(
      providerConfig(),
      chatRequest({
        metadata: {
          openkit: {
            promptCacheKey: 'chat-metadata-key',
            workspaceId: 'ws_chat',
          },
        },
      })
    );
    const derived = resolver.withPromptCacheKey(
      providerConfig(),
      chatRequest({
        metadata: {
          openkit: {
            sessionId: 'session_chat',
            workspaceId: 'ws_chat',
          },
        },
      })
    );

    expect(explicit.prompt_cache_key).toBe('chat-client-key');
    expect(metadata.prompt_cache_key).toBe('chat-metadata-key');
    expect(derived.prompt_cache_key).toMatch(/^openkit:responses:[a-f0-9]{32}$/);
    expect(derived.prompt_cache_key).not.toContain('ws_chat');
  });
});

describe('resolveWorkerPromptCacheKey', () => {
  const input = {
    codexOAuthAccountSlotId: 'team_a',
    model: 'gpt-5.1',
    nativeCacheLineageId: 'cache_parent',
    providerId: 'openai_codex',
    runtimeFamily: 'codex',
    workspaceId: 'ws_demo',
  };

  it('keeps the same explicit native lineage stable', () => {
    const first = resolveWorkerPromptCacheKey(input);
    const second = resolveWorkerPromptCacheKey(input);

    expect(first).toEqual(second);
    expect(first).toMatchObject({ degraded: false });
    expect(first.promptCacheKey).toMatch(/^openkit:responses:[a-f0-9]{32}$/);
    expect(first.runtimeCacheLineageRef).toMatch(/^rcl_[a-f0-9]{24}$/);
  });

  it('keeps distinct sibling lineages isolated', () => {
    const parent = resolveWorkerPromptCacheKey(input);
    const childA = resolveWorkerPromptCacheKey({ ...input, nativeCacheLineageId: 'cache_child_a' });
    const childB = resolveWorkerPromptCacheKey({ ...input, nativeCacheLineageId: 'cache_child_b' });

    expect(
      new Set([parent.promptCacheKey, childA.promptCacheKey, childB.promptCacheKey])
    ).toHaveProperty('size', 3);
    expect(
      new Set([
        parent.runtimeCacheLineageRef,
        childA.runtimeCacheLineageRef,
        childB.runtimeCacheLineageRef,
      ])
    ).toHaveProperty('size', 3);
  });

  it.each([
    ['provider', { providerId: 'openrouter' }],
    ['account', { codexOAuthAccountSlotId: 'team_b' }],
    ['model', { model: 'gpt-5.2' }],
    ['workspace', { workspaceId: 'ws_other' }],
    ['runtime family', { runtimeFamily: 'other-runtime' }],
  ])('isolates %s identity', (_label, override) => {
    const baseline = resolveWorkerPromptCacheKey(input);
    const isolated = resolveWorkerPromptCacheKey({ ...input, ...override });

    expect(isolated.promptCacheKey).not.toBe(baseline.promptCacheKey);
    expect(isolated.runtimeCacheLineageRef).not.toBe(baseline.runtimeCacheLineageRef);
  });

  it('uses a random request fallback without a product cache ref', () => {
    const { nativeCacheLineageId: _omitted, ...withoutLineage } = input;
    const first = resolveWorkerPromptCacheKey(withoutLineage);
    const second = resolveWorkerPromptCacheKey(withoutLineage);

    expect(first).toMatchObject({ degraded: true, runtimeCacheLineageRef: null });
    expect(first.promptCacheKey).toMatch(/^openkit:responses:request:[0-9a-f-]{36}$/);
    expect(second.promptCacheKey).not.toBe(first.promptCacheKey);
  });

  it('shares one explicit lineage across distinct runtime origins', () => {
    const results = ['rto_parent', 'rto_child'].map(() => resolveWorkerPromptCacheKey(input));

    expect(results[0]).toEqual(results[1]);
  });
});
