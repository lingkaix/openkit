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
  it.each([
    'workspaceId',
    'threadId',
    'agentSessionId',
    'sessionId',
  ] as const)('keeps trusted %s when public metadata conflicts', (field) => {
    const resolver = new PromptCacheKeyResolver({ randomId: () => 'fallback' });
    const scope = {
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      threadId: 'th_00000000-0000-7000-8000-000000000001',
      agentSessionId: 'trusted-agent-session',
      sessionId: 'trusted-session',
    };
    const baseline = resolver.withPromptCacheKey(providerConfig(), responsesRequest(), scope);
    const conflicted = resolver.withPromptCacheKey(
      providerConfig(),
      responsesRequest({ metadata: { openkit: { [field]: `advisory-${field}` } } }),
      scope
    );

    // Cache Scope Input: public metadata cannot override server-owned authority.
    expect(conflicted.prompt_cache_key).toBe(baseline.prompt_cache_key);
  });

  it.each([
    'workspaceId',
    'threadId',
    'agentSessionId',
    'sessionId',
  ] as const)('uses advisory %s when the trusted caller omits it', (field) => {
    const resolver = new PromptCacheKeyResolver({ randomId: () => 'fallback' });
    const scope = {
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      threadId: 'th_00000000-0000-7000-8000-000000000001',
      agentSessionId: 'trusted-agent-session',
      sessionId: 'trusted-session',
    };
    const { [field]: advisoryValue, ...partialScope } = scope;
    const baseline = resolver.withPromptCacheKey(providerConfig(), responsesRequest(), scope);
    const supplemented = resolver.withPromptCacheKey(
      providerConfig(),
      responsesRequest({ metadata: { openkit: { [field]: advisoryValue } } }),
      partialScope
    );

    expect(supplemented.prompt_cache_key).toBe(baseline.prompt_cache_key);
  });

  it('removes private cache metadata before provider use without changing the caller request', () => {
    const resolver = new PromptCacheKeyResolver();
    const metadata = {
      label: 'public-label',
      openkit: { promptCacheKey: 'private-routing-label', workspaceId: 'private-workspace' },
    };
    const request = chatRequest({ metadata });
    const keyed = resolver.withPromptCacheKey(providerConfig(), request);

    expect(keyed.metadata).toEqual({ label: 'public-label' });
    expect(JSON.stringify(keyed)).not.toMatch(/private-routing-label|private-workspace/);
    expect(request.metadata).toEqual(metadata);
    expect(metadata.openkit).toEqual({
      promptCacheKey: 'private-routing-label',
      workspaceId: 'private-workspace',
    });
  });

  it.each([
    'request',
    'metadata',
  ] as const)('hashes admitted %s hints within the current provider, model, account and trusted scope', (source) => {
    const resolver = new PromptCacheKeyResolver({ randomId: () => 'fallback' });
    const hint = 'sample routing label';
    const provider = providerConfig({
      id: 'codex-team-a',
      accountSlotId: 'shared_slot',
      subscriptionProviderId: 'openai-codex',
    });
    const scope = {
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      threadId: 'th_00000000-0000-7000-8000-000000000001',
    };
    const openkit = {
      promptCacheKey: source === 'metadata' ? hint : 'secondary routing label',
      workspaceId: 'ws_00000000-0000-73c3-900f-8d310e4ba201',
      threadId: 'th_00000000-0000-7267-800d-a65e1b6a22d7',
    };
    const request = responsesRequest({
      ...(source === 'request' ? { prompt_cache_key: hint } : {}),
      metadata: { openkit },
    });
    const first = resolver.withPromptCacheKey(provider, request, scope).prompt_cache_key;
    const variants = [
      [providerConfig({ ...provider, accountSlotId: 'other_slot' }), request],
      [providerConfig({ ...provider, subscriptionProviderId: 'xai' }), request],
      [providerConfig({ ...provider, id: 'codex-team-b' }), request],
      [providerConfig({ ...provider, models: ['gpt-5.2'] }), { ...request, model: 'gpt-5.2' }],
    ] as const;
    const otherHint = responsesRequest({
      ...request,
      ...(source === 'request'
        ? { prompt_cache_key: 'alternate routing label' }
        : { metadata: { openkit: { ...openkit, promptCacheKey: 'alternate routing label' } } }),
    });
    const keys = [
      first,
      ...variants.map(
        ([variantProvider, variantRequest]) =>
          resolver.withPromptCacheKey(variantProvider, variantRequest, scope).prompt_cache_key
      ),
      resolver.withPromptCacheKey(provider, otherHint, scope).prompt_cache_key,
      resolver.withPromptCacheKey(provider, request, {
        ...scope,
        workspaceId: 'ws_00000000-0000-73c3-900f-8d310e4ba201',
      }).prompt_cache_key,
    ];

    expect(first).toMatch(/^openkit:responses:[a-f0-9]{32}$/);
    expect(resolver.withPromptCacheKey(provider, request, scope).prompt_cache_key).toBe(first);
    expect(new Set(keys)).toHaveProperty('size', keys.length);
    expect(JSON.stringify(keys)).not.toMatch(
      /sample routing label|alternate routing label|codex-team|openai-codex|shared_slot|other_slot|ws_|th_/
    );
    expect(
      resolver.withPromptCacheKey(
        provider,
        responsesRequest({
          ...request,
          metadata: {
            openkit: {
              ...openkit,
              ...(source === 'request' ? { promptCacheKey: 'ignored routing label' } : {}),
              workspaceId: 'advisory-workspace',
              threadId: 'advisory-thread',
            },
          },
        }),
        scope
      ).prompt_cache_key
    ).toBe(first);
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
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            threadId: 'th_00000000-0000-7000-8000-000000000001',
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
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            threadId: 'th_00000000-0000-7000-8000-000000000001',
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
          threadId: 'th_00000000-0000-7000-8000-000000000001',
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
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
            workspaceId: 'ws_00000000-0000-7308-ad05-7997f99b7505',
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
            workspaceId: 'ws_00000000-0000-7308-ad05-7997f99b7505',
          },
        },
      })
    );

    expect(explicit.prompt_cache_key).toMatch(/^openkit:responses:[a-f0-9]{32}$/);
    expect(explicit.prompt_cache_key).not.toContain('chat-client-key');
    expect(metadata.prompt_cache_key).toMatch(/^openkit:responses:[a-f0-9]{32}$/);
    expect(metadata.prompt_cache_key).not.toContain('chat-metadata-key');
    expect(derived.prompt_cache_key).toMatch(/^openkit:responses:[a-f0-9]{32}$/);
    expect(derived.prompt_cache_key).not.toContain('ws_00000000-0000-7308-ad05-7997f99b7505');
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
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
  };

  it('preserves exact Worker domains and ordinary cache bytes for valid Unicode tuples', () => {
    // QP-1a preserves baseline framing and truncation; hashes use independent literal UTF-8 tuples.
    const worker = resolveSubscriptionWorkerPromptCacheKey({
      ...input,
      nativeCacheLineageId: 'cache_\u00e9_\ud83d\ude00',
    });
    const ordinary = new PromptCacheKeyResolver().withPromptCacheKey(
      providerConfig(),
      responsesRequest(),
      { workspaceId: input.workspaceId, sessionId: 'session_e\u0301_\ud83d\ude00' }
    );

    expect(worker).toEqual({
      degraded: false,
      promptCacheKey: 'openkit:responses:98de1b1e1eac1c0bdb714251b61e5d2d',
      runtimeCacheLineageRef: 'rcl_0fb74cb61d433844a2308ec1',
    });
    expect(ordinary.prompt_cache_key).toBe('openkit:responses:b46220b2d3dd0c98e603593b9da74cdf');
  });

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
    ['workspace', { workspaceId: 'ws_00000000-0000-71f5-922f-6fd42f52f580' }],
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
