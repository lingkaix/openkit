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
    gatewayCapabilities: { chatCompletions: 'native', responses: 'native' },
    id: 'openai',
    models: ['gpt-test'],
    requiresApiKey: true,
    ...overrides,
  } as unknown as ResolvedLLMProviderConfig;
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

  it('hashes the configured provider, model, and exact subscription pair without raw ids', () => {
    const resolver = new PromptCacheKeyResolver({ randomId: () => 'fallback' });
    const subscription = {
      accountSlotId: 'shared_slot',
      subscriptionProviderId: 'openai-codex',
    } as Partial<ResolvedLLMProviderConfig>;
    const first = resolver.withPromptCacheKey(
      providerConfig({ id: 'codex-team-a', ...subscription }),
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
      providerConfig({ id: 'codex-team-a', ...subscription }),
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
    const variants = [
      providerConfig({ id: 'codex-team-b', ...subscription }),
      providerConfig({ id: 'codex-team-a', ...subscription, models: ['gpt-5.2'] }),
      providerConfig({
        id: 'codex-team-a',
        ...subscription,
        accountSlotId: 'other_slot',
      } as Partial<ResolvedLLMProviderConfig>),
      providerConfig({
        id: 'codex-team-a',
        ...subscription,
        subscriptionProviderId: 'xai',
      } as Partial<ResolvedLLMProviderConfig>),
    ].map((provider, index) =>
      resolver.withPromptCacheKey(
        provider,
        responsesRequest({ model: index === 1 ? 'gpt-5.2' : 'gpt-5.1' }),
        {
          agentSessionId: 'session_demo',
          threadId: 'th_demo',
          workspaceId: 'ws_demo',
        }
      )
    );

    expect(first.prompt_cache_key).toMatch(/^openkit:responses:[a-f0-9]{32}$/);
    expect(first.prompt_cache_key).toBe(second.prompt_cache_key);
    expect(variants.every((variant) => variant.prompt_cache_key !== first.prompt_cache_key)).toBe(
      true
    );
    expect(
      JSON.stringify([first, second, ...variants].map((request) => request.prompt_cache_key))
    ).not.toMatch(/codex-team|openai-codex|shared_slot|other_slot|ws_demo|th_demo|session_demo/);
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
  const resolveSubscriptionWorkerPromptCacheKey =
    resolveWorkerPromptCacheKey as unknown as (input: {
      readonly accountSlotId: string;
      readonly model: string;
      readonly nativeCacheLineageId?: string;
      readonly providerId: string;
      readonly runtimeFamily: string;
      readonly subscriptionProviderId: 'openai-codex' | 'xai';
      readonly workspaceId: string;
    }) => ReturnType<typeof resolveWorkerPromptCacheKey>;
  const input = {
    accountSlotId: 'team_a',
    model: 'gpt-5.1',
    nativeCacheLineageId: 'cache_parent',
    providerId: 'openai_codex',
    runtimeFamily: 'codex',
    subscriptionProviderId: 'openai-codex' as const,
    workspaceId: 'ws_demo',
  };

  it('keeps the same explicit native lineage stable', () => {
    const first = resolveSubscriptionWorkerPromptCacheKey(input);
    const second = resolveSubscriptionWorkerPromptCacheKey(input);

    expect(first).toEqual(second);
    expect(first).toMatchObject({ degraded: false });
    expect(first.promptCacheKey).toMatch(/^openkit:responses:[a-f0-9]{32}$/);
    expect(first.runtimeCacheLineageRef).toMatch(/^rcl_[a-f0-9]{24}$/);
  });

  it('keeps distinct sibling lineages isolated', () => {
    const parent = resolveSubscriptionWorkerPromptCacheKey(input);
    const childA = resolveSubscriptionWorkerPromptCacheKey({
      ...input,
      nativeCacheLineageId: 'cache_child_a',
    });
    const childB = resolveSubscriptionWorkerPromptCacheKey({
      ...input,
      nativeCacheLineageId: 'cache_child_b',
    });

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
    ['subscription provider', { subscriptionProviderId: 'xai' as const }],
    ['account', { accountSlotId: 'team_b' }],
    ['model', { model: 'gpt-5.2' }],
    ['workspace', { workspaceId: 'ws_other' }],
  ])('isolates %s identity', (_label, override) => {
    const baseline = resolveSubscriptionWorkerPromptCacheKey(input);
    const isolated = resolveSubscriptionWorkerPromptCacheKey({ ...input, ...override });

    expect(isolated.promptCacheKey).not.toBe(baseline.promptCacheKey);
    expect(isolated.runtimeCacheLineageRef).not.toBe(baseline.runtimeCacheLineageRef);
  });

  it('uses a random request fallback without a product cache ref', () => {
    const { nativeCacheLineageId: _omitted, ...withoutLineage } = input;
    const first = resolveSubscriptionWorkerPromptCacheKey(withoutLineage);
    const second = resolveSubscriptionWorkerPromptCacheKey(withoutLineage);

    expect(first).toMatchObject({ degraded: true, runtimeCacheLineageRef: null });
    expect(first.promptCacheKey).toMatch(/^openkit:responses:request:[0-9a-f-]{36}$/);
    expect(second.promptCacheKey).not.toBe(first.promptCacheKey);
  });

  it('shares one explicit lineage across distinct runtime origins', () => {
    const results = ['rto_parent', 'rto_child'].map(() =>
      resolveSubscriptionWorkerPromptCacheKey(input)
    );

    expect(results[0]).toEqual(results[1]);
  });
});
