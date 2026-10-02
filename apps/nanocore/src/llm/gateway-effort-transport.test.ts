import { zstdDecompressSync } from 'node:zlib';
import { createModels, createProvider, type Provider } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { deepseekProvider } from '@earendil-works/pi-ai/providers/deepseek';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter';
import { xaiProvider } from '@earendil-works/pi-ai/providers/xai';
import { ProviderProfileSchema } from '@openkit/config-schema';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type ResolvedLLMProviderConfig,
  resolveProviderProfileToLLMConfig,
} from '../providers/llm-config.js';
import { PiAiGatewayClient } from './pi-ai-client.js';
import * as subscriptions from './provider-subscription-accounts.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Supplies valid stock-adapter terminal events after intercepting the serialized HTTP request. */
function syntheticResponse(api: string) {
  if (api === 'openai-completions') {
    const chunk = {
      id: 'chat_synthetic',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'gpt-5.1',
      choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }],
    };
    return new Response(
      `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
      { headers: { 'content-type': 'text/event-stream' } }
    );
  }
  const item = {
    id: 'msg_synthetic',
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text: 'ok', annotations: [] }],
  };
  const response = {
    id: 'resp_synthetic',
    object: 'response',
    status: 'completed',
    output: [item],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  };
  const events =
    api === 'anthropic-messages'
      ? [
          {
            type: 'message_start',
            message: {
              id: 'msg_synthetic',
              type: 'message',
              role: 'assistant',
              model: 'synthetic',
              content: [],
              stop_reason: null,
              usage: { input_tokens: 1, output_tokens: 0 },
            },
          },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
          { type: 'content_block_stop', index: 0 },
          {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn', stop_sequence: null },
            usage: { output_tokens: 1 },
          },
          { type: 'message_stop' },
        ]
      : [
          {
            type: 'response.created',
            response: { ...response, status: 'in_progress', output: [] },
          },
          { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
          {
            type: 'response.content_part.added',
            output_index: 0,
            content_index: 0,
            item_id: item.id,
            part: { ...item.content[0], text: '' },
          },
          {
            type: 'response.output_text.delta',
            output_index: 0,
            content_index: 0,
            item_id: item.id,
            delta: 'ok',
          },
          {
            type: 'response.output_text.done',
            output_index: 0,
            content_index: 0,
            item_id: item.id,
            text: 'ok',
          },
          {
            type: 'response.content_part.done',
            output_index: 0,
            content_index: 0,
            item_id: item.id,
            part: item.content[0],
          },
          { type: 'response.output_item.done', output_index: 0, item },
          { type: 'response.completed', response },
        ];
  return new Response(
    events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''),
    { headers: { 'content-type': 'text/event-stream' } }
  );
}

/** Uses the stock OpenAI catalog/auth and native Chat serializer, with its actual API on the selected model. */
function openaiCompletionsProvider() {
  const stock = openaiProvider();
  const model = stock.getModels().find((candidate) => candidate.id === 'gpt-5.1')!;
  return createProvider({
    id: stock.id,
    name: stock.name,
    baseUrl: stock.baseUrl,
    auth: stock.auth,
    models: [{ ...model, api: 'openai-completions' }],
    api: openAICompletionsApi(),
  });
}

const adapters = [
  {
    name: 'budget Anthropic',
    provider: anthropicProvider,
    model: 'claude-sonnet-4-5',
    kind: 'budget',
  },
  {
    name: 'adaptive Anthropic',
    provider: anthropicProvider,
    model: 'claude-sonnet-4-6',
    kind: 'adaptive',
  },
  { name: 'OpenAI Responses', provider: openaiProvider, model: 'gpt-5.1', kind: 'openai' },
] as const;
const paths = [
  { endpoint: 'chat', stream: false },
  { endpoint: 'responses', stream: false },
  { endpoint: 'chat', stream: true },
  { endpoint: 'responses', stream: true },
] as const;

/** Uses the actual catalog and serializer; no faux Provider constructs this body. */
function transport(providerFactory: () => Provider, model: string) {
  const models = createModels();
  const provider = providerFactory();
  models.setProvider(provider);
  expect(models.getModel(provider.id, model)).toBeDefined();
  const bytes: string[] = [];
  vi.stubGlobal('fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(url, init);
    const raw = Buffer.from(await request.arrayBuffer());
    bytes.push(
      (request.headers.get('content-encoding') === 'zstd' ? zstdDecompressSync(raw) : raw).toString(
        'utf8'
      )
    );
    return syntheticResponse(models.getModel(provider.id, model)!.api);
  });
  const apiKey =
    provider.id === 'openai-codex'
      ? `synthetic.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'synthetic-account' } })).toString('base64')}.synthetic`
      : 'synthetic-secret';
  const config = {
    adapterId: provider.id,
    vendor: provider.id,
    apiKey,
    backend: 'pi-ai',
    baseUrl: null,
    displayName: 'Synthetic',
    gatewayCapabilities: { chatCompletions: 'native', responses: 'bridged' },
    id: 'synthetic',
    models: [model],
    requiresApiKey: true,
    ...(provider.id === 'openai-codex' ? { subscriptionProviderId: 'openai-codex' } : {}),
  } as ResolvedLLMProviderConfig;
  const client = new PiAiGatewayClient({ models });
  return { bytes, client, config, models, provider };
}

/** Admits the shipped custom-profile shape through its real schema/resolver and captures the stock body. */
function customTransport(baseUrl = 'https://example.invalid/v1') {
  const models = createModels();
  const profile = ProviderProfileSchema.parse({
    id: 'openai-compatible-custom',
    displayName: 'Custom OpenAI-Compatible',
    kind: 'custom',
    baseUrl,
    models: ['custom-model'],
    secretRef: 'vault://provider_openai_compatible_custom',
    modelMetadata: {
      'custom-model': {
        reasoning: true,
        reasoning_options: [{ type: 'toggle' }, { type: 'effort', values: ['high'] }],
        limit: { context: 4096, output: 4000 },
      },
    },
  });
  const config = resolveProviderProfileToLLMConfig(profile, () => 'synthetic-secret');
  const client = new PiAiGatewayClient({ models });
  const bytes: string[] = [];
  vi.stubGlobal('fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
    bytes.push(await new Request(url, init).text());
    return syntheticResponse('openai-completions');
  });
  return { bytes, client, config, models };
}

/** Fully consumes streaming paths so their terminal serializer result is verified too. */
async function send(
  f: Pick<ReturnType<typeof transport>, 'bytes' | 'client' | 'config'>,
  path: (typeof paths)[number],
  effort?: string,
  tools = false,
  onProviderHandoff?: () => void
) {
  const request = {
    model: f.config.models[0]!,
    prompt_cache_retention: 'none',
    ...(f.config.subscriptionProviderId ? {} : { temperature: 0.5 }),
    ...(path.endpoint === 'chat'
      ? {
          messages: [{ role: 'user', content: 'Hello' }],
          max_tokens: 1000,
          ...(effort === undefined ? {} : { reasoning_effort: effort }),
        }
      : {
          input: 'Hello',
          max_output_tokens: 1000,
          ...(effort === undefined ? {} : { reasoning: { effort } }),
          ...(tools
            ? { tools: [{ type: 'function', name: 'declared', parameters: { type: 'object' } }] }
            : {}),
        }),
  };
  // The branch-specific input shape is deliberately constructed above.
  const result =
    path.endpoint === 'chat'
      ? path.stream
        ? await f.client.createChatCompletionStream(f.config, request as never, undefined, {
            onProviderHandoff,
          })
        : await f.client.createChatCompletion(f.config, request as never, undefined, {
            onProviderHandoff,
          })
      : path.stream
        ? await f.client.createResponsesStream(f.config, request as never, undefined, {
            onProviderHandoff,
          })
        : await f.client.createResponses(f.config, request as never, undefined, {
            onProviderHandoff,
          });
  expect(
    result instanceof ReadableStream ? await new Response(result).text() : JSON.stringify(result)
  ).toContain('ok');
  expect(f.bytes).toHaveLength(1);
  return JSON.parse(f.bytes[0]!) as Record<string, unknown>;
}

describe('stock serialized canonical effort delivery', () => {
  for (const effort of ['none', 'high', undefined]) {
    it.each(paths)(`custom stock ${effort} control in $endpoint stream=$stream`, async (path) => {
      const f = customTransport();
      const entry = vi.spyOn(f.models, path.stream ? 'stream' : 'complete');
      const body = await send(f, path, effort);
      expect(body).toHaveProperty('max_completion_tokens', 1000);
      if (effort === undefined) expect(body).not.toHaveProperty('reasoning_effort');
      else expect(body).toHaveProperty('reasoning_effort', effort);
      expect(f.models.getModel(f.config.id, 'custom-model')).toMatchObject({
        api: 'openai-completions',
        reasoning: true,
        contextWindow: 4096,
        maxTokens: 4000,
      });
      expect(f.models.getModel(f.config.id, 'custom-model')).not.toHaveProperty('thinkingLevelMap');
      if (effort === 'none')
        expect(entry.mock.calls[0]?.[0]).toHaveProperty('thinkingLevelMap.off', 'none');
      else expect(entry.mock.calls[0]?.[0]).not.toHaveProperty('thinkingLevelMap');
    });
  }
  it.each(
    paths
  )('custom stock subscription none uses its attempt model in $endpoint stream=$stream', async (path) => {
    const f = customTransport();
    const handoff = vi.fn();
    const stockAuth = vi.spyOn(f.models, 'getAuth');
    const calls: unknown[][] = [];
    const resolveInferenceAuth = vi.fn(async () => {
      expect(handoff).toHaveBeenCalledTimes(1);
      const provider = f.models.getProvider(f.config.id)!;
      const original = provider.stream;
      vi.spyOn(provider, 'stream').mockImplementation((...args) => {
        calls.push(args);
        return original.apply(provider, args);
      });
      return {
        auth: { apiKey: 'synthetic-secret' },
        presented: { version: 'synthetic-material', auth: { apiKey: 'synthetic-secret' } },
      };
    });
    vi.spyOn(subscriptions, 'subscriptionInferenceHandle').mockReturnValue({
      resolveInferenceAuth,
      observeInference: vi.fn(async () => {}),
    } as unknown as subscriptions.ProviderSubscriptionPairHandle);
    const body = await send(f, path, 'none', false, handoff);
    expect(body).toHaveProperty('reasoning_effort', 'none');
    expect(body).toHaveProperty('max_completion_tokens', 1000);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toHaveProperty('thinkingLevelMap.off', 'none');
    expect(calls[0]?.[2]).not.toHaveProperty('reasoningEffort');
    expect(f.models.getModel(f.config.id, 'custom-model')).not.toHaveProperty('thinkingLevelMap');
    expect(stockAuth).not.toHaveBeenCalled();
    expect(resolveInferenceAuth).toHaveBeenCalledTimes(1);
    expect(handoff).toHaveBeenCalledTimes(1);
  });
  it.each([
    { model: '~anthropic/claude-sonnet-latest', off: null },
    { model: '~deepseek/deepseek-flash-latest', off: 'none' },
  ])('keeps stock catalog off=$off disabled body unchanged for $model', async ({ model, off }) => {
    const f = transport(openrouterProvider, model);
    const selected = f.models.getModel(f.provider.id, model)!;
    expect(selected).toHaveProperty('api', 'openai-completions');
    expect(selected).toHaveProperty('thinkingLevelMap.off', off);
    const before = structuredClone(selected);
    f.config.modelMetadata = {
      [model]: { reasoning: true, limit: { context: 4096, output: 4000 } },
    };
    const body = await send(f, { endpoint: 'chat', stream: false }, 'none');
    const native = f.provider.stream(
      { ...selected, contextWindow: 4096, maxTokens: 4000 },
      { messages: [{ role: 'user', content: 'Hello', timestamp: 1 }] },
      { apiKey: 'synthetic-secret', maxTokens: 1000, temperature: 0.5, cacheRetention: 'none' }
    );
    expect((await native.result()).stopReason).toBe('stop');
    const control = JSON.parse(f.bytes[1]!);
    expect(body).toHaveProperty('max_completion_tokens', 1000);
    expect(body.reasoning).toEqual(control.reasoning);
    if (off === null) expect(body).not.toHaveProperty('reasoning');
    else expect(body).toHaveProperty('reasoning.effort', off);
    expect(selected).toEqual(before);
  });
  for (const effort of ['none', 'high']) {
    it.each(paths)(`DeepSeek stock ${effort} control in $endpoint stream=$stream`, async (path) => {
      const f = transport(deepseekProvider, 'deepseek-v4-pro');
      expect(f.models.getModel(f.provider.id, f.config.models[0]!)).toHaveProperty(
        'api',
        'openai-completions'
      );
      f.config.modelMetadata = {
        'deepseek-v4-pro': {
          reasoning: true,
          reasoning_options: [{ type: 'toggle' }, { type: 'effort', values: ['high'] }],
          limit: { context: 4096, output: 4000 },
        },
      };
      const body = await send(f, path, effort);
      expect(body).toHaveProperty('max_tokens', 1000);
      expect(body).toHaveProperty('thinking.type', effort === 'none' ? 'disabled' : 'enabled');
      if (effort === 'none') expect(body).not.toHaveProperty('reasoning_effort');
      else expect(body).toHaveProperty('reasoning_effort', 'high');
    });
    it.each(
      paths
    )(`shipped OpenRouter stock ${effort} control in $endpoint stream=$stream`, async (path) => {
      const f = transport(openrouterProvider, 'poolside/laguna-s-2.1:free');
      expect(f.models.getModel(f.provider.id, f.config.models[0]!)).toHaveProperty(
        'api',
        'openai-completions'
      );
      f.config.modelMetadata = {
        [f.config.models[0]!]: { reasoning: true, limit: { context: 4096, output: 4000 } },
      };
      const body = await send(f, path, effort);
      expect(body).toHaveProperty('max_completion_tokens', 1000);
      expect(body).toHaveProperty('reasoning.effort', effort);
    });
    it.each(
      paths
    )(`shipped xAI stock ${effort} control in $endpoint stream=$stream`, async (path) => {
      const f = transport(xaiProvider, 'grok-4.3');
      expect(f.models.getModel(f.provider.id, f.config.models[0]!)).toHaveProperty(
        'api',
        'openai-responses'
      );
      const body = await send(f, path, effort);
      expect(body).toHaveProperty('max_output_tokens', 1000);
      expect(body).toHaveProperty('reasoning.effort', effort);
    });
  }
  it.each(
    paths
  )('DeepSeek subscription disabled options precede handoff in $endpoint stream=$stream', async (path) => {
    const f = transport(deepseekProvider, 'deepseek-v4-pro');
    f.config.modelMetadata = {
      'deepseek-v4-pro': { reasoning: true, limit: { context: 4096, output: 4000 } },
    };
    const selected = vi.spyOn(f.provider, 'stream');
    const simple = vi.spyOn(f.provider, 'streamSimple');
    const stockAuth = vi.spyOn(f.models, 'getAuth');
    const handoff = vi.fn(() => expect(selected).not.toHaveBeenCalled());
    const resolveInferenceAuth = vi.fn(async () => {
      expect(handoff).toHaveBeenCalledTimes(1);
      return {
        auth: { apiKey: 'synthetic-secret' },
        presented: { version: 'synthetic-material', auth: { apiKey: 'synthetic-secret' } },
      };
    });
    vi.spyOn(subscriptions, 'subscriptionInferenceHandle').mockReturnValue({
      resolveInferenceAuth,
      observeInference: vi.fn(async () => {}),
    } as unknown as subscriptions.ProviderSubscriptionPairHandle);
    const body = await send(f, path, 'none', false, handoff);
    expect(body).toHaveProperty('max_tokens', 1000);
    expect(body).toHaveProperty('thinking.type', 'disabled');
    expect(body).not.toHaveProperty('reasoning_effort');
    expect(selected).toHaveBeenCalledTimes(1);
    expect(selected.mock.calls[0]?.[2]).not.toHaveProperty('reasoningEffort');
    expect(simple).not.toHaveBeenCalled();
    expect(stockAuth).not.toHaveBeenCalled();
    expect(resolveInferenceAuth).toHaveBeenCalledTimes(1);
    expect(handoff).toHaveBeenCalledTimes(1);
  });
  for (const api of [
    {
      name: 'openai-responses',
      provider: openaiProvider,
      cap: 'max_output_tokens',
      effort: 'reasoning.effort',
    },
    {
      name: 'openai-completions',
      provider: openaiCompletionsProvider,
      cap: 'max_completion_tokens',
      effort: 'reasoning_effort',
    },
  ]) {
    for (const effort of ['none', 'high']) {
      it.each(
        paths
      )(`${api.name} preserves near-context cap with ${effort} in $endpoint stream=$stream`, async (path) => {
        const bodies: Record<string, unknown>[] = [];
        for (const requested of [undefined, effort]) {
          const f = transport(api.provider, 'gpt-5.1');
          f.config.modelMetadata = {
            'gpt-5.1': { reasoning: true, limit: { context: 4096, output: 4000 } },
          };
          expect(f.models.getModel(f.provider.id, 'gpt-5.1')).toHaveProperty('api', api.name);
          bodies.push(await send(f, path, requested));
        }
        expect(bodies[0]).toHaveProperty(api.cap, 1000);
        expect(bodies[1]).toHaveProperty(api.cap, 1000);
        expect(bodies[1]).toHaveProperty(api.effort, effort);
      });
    }
  }
  for (const effort of [undefined, 'high']) {
    it.each(
      paths
    )(`observes handoff once before unchanged stock entry effort=${effort} $endpoint stream=$stream`, async (path) => {
      const f = transport(openaiProvider, 'gpt-5.1');
      const method = path.stream ? 'stream' : 'complete';
      const entry = vi.spyOn(f.models, method);
      const handoff = vi.fn(() => expect(entry).not.toHaveBeenCalled());
      await send(f, path, effort, false, handoff);
      expect(handoff).toHaveBeenCalledTimes(1);
      expect(entry).toHaveBeenCalledTimes(1);
    });
  }
  it.each([
    { stream: false, native: true },
    { stream: true, native: true },
    { stream: false, native: false },
    { stream: true, native: false },
  ])('selects stock subscription entry native=$native without changing observation stream=$stream', async ({
    stream,
    native,
  }) => {
    const f = native
      ? transport(openaiProvider, 'gpt-5.1')
      : transport(anthropicProvider, 'claude-sonnet-4-6');
    const selected = vi.spyOn(f.provider, native ? 'stream' : 'streamSimple');
    const other = vi.spyOn(f.provider, native ? 'streamSimple' : 'stream');
    const stockAuth = vi.spyOn(f.models, 'getAuth');
    const handoff = vi.fn();
    const presented = { version: 'synthetic-material', auth: { apiKey: 'synthetic-secret' } };
    const resolveInferenceAuth = vi.fn(async (_signal?: AbortSignal) => {
      expect(handoff).toHaveBeenCalledTimes(1);
      return {
        auth: {
          apiKey: 'synthetic-secret',
          headers: { 'x-synthetic-auth': 'retained' },
          baseUrl: 'https://synthetic.invalid/v1',
        },
        env: { SYNTHETIC: 'retained' },
        presented,
      };
    });
    const observeInference = vi.fn(async () => {});
    vi.spyOn(subscriptions, 'subscriptionInferenceHandle').mockReturnValue({
      resolveInferenceAuth,
      observeInference,
    } as unknown as subscriptions.ProviderSubscriptionPairHandle);
    const signal = new AbortController().signal;
    const request = {
      model: f.config.models[0]!,
      messages: [{ role: 'user' as const, content: 'Hello' }],
      reasoning_effort: 'high',
    };
    const result = stream
      ? await f.client.createChatCompletionStream(f.config, request, undefined, {
          signal,
          deadline: 777,
          onProviderHandoff: handoff,
        })
      : await f.client.createChatCompletion(f.config, request, undefined, {
          signal,
          deadline: 777,
          onProviderHandoff: handoff,
        });
    expect(
      result instanceof ReadableStream ? await new Response(result).text() : JSON.stringify(result)
    ).toContain('ok');
    expect(resolveInferenceAuth).toHaveBeenCalledTimes(1);
    expect(handoff).toHaveBeenCalledTimes(1);
    expect(stockAuth).not.toHaveBeenCalled();
    expect(selected).toHaveBeenCalledTimes(1);
    expect(other).not.toHaveBeenCalled();
    expect(selected.mock.calls[0]?.[0]).toHaveProperty('baseUrl', 'https://synthetic.invalid/v1');
    expect(selected.mock.calls[0]?.[2]).toMatchObject({
      ...(native ? { reasoningEffort: 'high' } : { reasoning: 'high' }),
      headers: { 'x-synthetic-auth': 'retained' },
      env: { SYNTHETIC: 'retained' },
    });
    expect(observeInference).toHaveBeenCalledExactlyOnceWith(
      presented,
      undefined,
      777,
      resolveInferenceAuth.mock.calls[0]?.[0]
    );
    expect(JSON.parse(f.bytes[0]!)).toHaveProperty(
      native ? 'reasoning.effort' : 'output_config.effort',
      'high'
    );
  });
  for (const adapter of adapters) {
    it.each(paths)(`${adapter.name} delivers high in $endpoint stream=$stream`, async (path) => {
      const f = transport(adapter.provider, adapter.model);
      const body = await send(f, path, 'high');
      if (adapter.kind === 'adaptive') expect(body).toHaveProperty('output_config.effort', 'high');
      else if (adapter.kind === 'budget') expect(body).toHaveProperty('thinking.type', 'enabled');
      else expect(body).toHaveProperty('reasoning.effort', 'high');
      if (adapter.kind === 'budget') expect(body).toHaveProperty('thinking.budget_tokens', 16360);
    });
    it.each(
      paths
    )(`${adapter.name} serializes disabled effort in $endpoint stream=$stream`, async (path) => {
      const body = await send(transport(adapter.provider, adapter.model), path, 'none');
      if (adapter.kind === 'openai') expect(body).toHaveProperty('reasoning.effort', 'none');
      else expect(body).toHaveProperty('thinking.type', 'disabled');
      expect(body).not.toHaveProperty('output_config');
    });
    it.each(
      paths
    )(`${adapter.name} omitted effort preserves native serialization in $endpoint stream=$stream`, async (path) => {
      const f = transport(adapter.provider, adapter.model);
      const body = await send(f, path);
      expect(f.bytes[0]).toMatchSnapshot();
      if (adapter.kind === 'openai') {
        expect(body).toHaveProperty('reasoning.effort', 'none');
        expect(body).toHaveProperty('max_output_tokens', 1000);
      } else {
        expect(f.bytes[0]).toBe(
          JSON.stringify({
            model: adapter.model,
            messages: [{ role: 'user', content: 'Hello' }],
            max_tokens: 1000,
            stream: true,
            temperature: 0.5,
          })
        );
      }
      expect(body).not.toHaveProperty('thinking');
    });
  }
  it.each(
    paths
  )('pins accepted Anthropic cap/temperature consequence in $endpoint stream=$stream', async (path) => {
    const body = await send(transport(anthropicProvider, 'claude-sonnet-4-5'), path, 'low');
    expect(body).toHaveProperty('max_tokens', 3048);
    expect(body).toHaveProperty('thinking.budget_tokens', 2024);
    expect(body).not.toHaveProperty('temperature');
  });
  it.each([
    false,
    true,
  ])('Anthropic tool-aware Responses carries stock thinking stream=%s', async (stream) => {
    const body = await send(
      transport(anthropicProvider, 'claude-sonnet-4-6'),
      { endpoint: 'responses', stream },
      'high',
      true
    );
    expect(body).toHaveProperty('output_config.effort', 'high');
    expect(body.tools).toHaveLength(1);
  });
  it.each([
    false,
    true,
  ])('OpenAI tool-aware Responses retains native effort and cap stream=%s', async (stream) => {
    const body = await send(
      transport(openaiProvider, 'gpt-5.1'),
      { endpoint: 'responses', stream },
      'high',
      true
    );
    expect(body).toHaveProperty('reasoning.effort', 'high');
    expect(body).toHaveProperty('max_output_tokens', 1000);
  });
  it.each([
    { stream: false, effort: 'high' },
    { stream: true, effort: 'high' },
    { stream: false, effort: 'none' },
    { stream: true, effort: 'none' },
  ])('Codex Responses retains native $effort and payload cap stream=$stream', async ({
    stream,
    effort,
  }) => {
    const body = await send(
      transport(openaiCodexProvider, 'gpt-5.5'),
      { endpoint: 'responses', stream },
      effort
    );
    expect(body).toHaveProperty('reasoning.effort', effort);
    expect(body).toHaveProperty('max_output_tokens', 1000);
  });
});
