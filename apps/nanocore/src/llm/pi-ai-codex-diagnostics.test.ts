import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  type Model,
  normalizeContext,
  type StreamOptions,
} from '@earendil-works/pi-ai';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { xaiProvider } from '@earendil-works/pi-ai/providers/xai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedLLMProviderConfig } from '../providers/llm-config.js';
import { dispatchLogicalModel } from './gateway-routes.js';
import type { ResolvedLogicalModel } from './logical-models.js';
import { PiAiGatewayClient } from './pi-ai-client.js';
import {
  LLMGatewayProviderDispatcher,
  type LLMGatewayTransportContext,
} from './provider-dispatcher.js';

/** Synthetic auth is consumed only by an intercepted fetch; no live account is used. */
const syntheticAuth = `fixture.${Buffer.from(
  JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-only' } })
).toString('base64')}.fixture`;

/** Creates the explicit adapter configuration without consulting account or credential stores. */
function providerConfig(model: string): ResolvedLLMProviderConfig {
  return {
    adapterId: 'openai-codex',
    apiKey: syntheticAuth,
    backend: 'pi-ai',
    baseUrl: null,
    displayName: 'Fixture',
    gatewayCapabilities: { chatCompletions: 'bridged', responses: 'native' },
    id: 'fixture',
    models: [model],
    requiresApiKey: true,
  };
}

/** Selects a real stock Codex model with sufficient physical input capacity. */
function stockFixture() {
  const models = createModels();
  const stock = openaiCodexProvider();
  models.setProvider(stock);
  const model = models
    .getModels()
    .find(
      (entry) =>
        entry.api === 'openai-codex-responses' && entry.contextWindow - entry.maxTokens > 8192
    );
  if (!model) throw new Error('The stock Codex fixture requires an admitted model.');
  return { models, stock, model, provider: providerConfig(model.id) };
}

/** Returns an opaque HTTP rejection whose body supplies no classification or status evidence. */
function rejection(status: number): Response {
  return new Response(JSON.stringify({ error: { message: 'Opaque synthetic rejection.' } }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Exercises each existing dispatcher entry and consumes a stream through its terminal outcome. */
async function invoke(
  dispatcher: LLMGatewayProviderDispatcher,
  provider: ResolvedLLMProviderConfig,
  format: 'chat' | 'responses',
  stream: boolean,
  transport: LLMGatewayTransportContext
): Promise<unknown> {
  const context = { transport };
  if (format === 'chat') {
    const request = {
      model: provider.models[0]!,
      messages: [{ role: 'user' as const, content: 'Hi.' }],
    };
    if (!stream) return dispatcher.createChatCompletion(provider, request, context);
    return new Response(
      await dispatcher.createChatCompletionStream(provider, { ...request, stream: true }, context)
    ).text();
  }
  const request = { model: provider.models[0]!, input: 'Hi.' };
  if (!stream) return dispatcher.createResponses(provider, request, context);
  return new Response(
    await dispatcher.createResponsesStream(provider, { ...request, stream: true }, context)
  ).text();
}

/** Asserts the pre-existing routing metadata without granting authority to diagnostic evidence. */
function expectUnsettledUnknown(error: unknown): void {
  expect(error).toBeInstanceOf(Error);
  const failure = (error as { failure?: object }).failure;
  expect(failure).toMatchObject({ kind: 'unknown', settled: false });
  expect(failure).not.toHaveProperty('status');
}

/** Supplies controlled hook evidence through stock Models for guards the real HTTP parser cannot emit. */
function semanticFixture(
  respond: (options: StreamOptions | undefined, model: Model<string>) => Promise<void>,
  success = false
) {
  const faux = fauxProvider({
    api: 'openai-codex-responses',
    provider: 'openai-codex',
    models: [{ id: 'fixture-model', reasoning: true }],
  });
  faux.setResponses([
    async (_context, options, _state, model) => {
      await respond(options, model);
      return success
        ? fauxAssistantMessage([fauxText('Accepted.')])
        : fauxAssistantMessage([], {
            stopReason: 'error',
            errorMessage: 'Opaque synthetic failure with untrusted status=401 text.',
          });
    },
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  return {
    dispatcher: new LLMGatewayProviderDispatcher({ piAiClient: new PiAiGatewayClient({ models }) }),
    provider: providerConfig('fixture-model'),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('stock Codex HTTP rejection diagnostics', () => {
  it('observes HTTP 401 at the stock hook while the terminal result has no HTTP status', async () => {
    const { stock, model } = stockFixture();
    const fetch = vi.fn(async () => rejection(401));
    vi.stubGlobal('fetch', fetch);
    const observed: number[] = [];
    const events = stock.stream(
      model,
      normalizeContext({ messages: [{ role: 'user', content: 'Hi.', timestamp: 0 }] }),
      {
        apiKey: syntheticAuth,
        env: {},
        maxRetries: 0,
        transport: 'sse',
        onResponse: (response) => {
          observed.push(response.status);
        },
      }
    );
    const types: string[] = [];
    for await (const event of events) types.push(event.type);
    const result = await events.result();
    expect(observed).toEqual([401]);
    expect(types).toEqual(['error']);
    expect(result.stopReason).toBe('error');
    expect(result.errorMessage).toBe('Opaque synthetic rejection.');
    expect(result).not.toHaveProperty('status');
    expect(result).not.toHaveProperty('response');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['chat', false, false],
    ['chat', true, false],
    ['responses', false, false],
    ['responses', true, false],
    ['chat', false, true],
    ['chat', true, true],
    ['responses', false, true],
    ['responses', true, true],
  ] as const)('carries only diagnostic HTTP status without replay: format=%s stream=%s observerThrows=%s', async (format, stream, observerThrows) => {
    const { models, model, provider } = stockFixture();
    const dispatcher = new LLMGatewayProviderDispatcher({
      piAiClient: new PiAiGatewayClient({ models }),
    });
    const fetch = vi.fn(async () => rejection(401));
    vi.stubGlobal('fetch', fetch);
    const observe = vi.fn((_status: number) => {
      if (observerThrows) throw new Error('Diagnostic sink failed.');
    });
    const handoff = vi.fn();
    const attempted: string[] = [];
    const logicalModel: ResolvedLogicalModel = {
      id: 'fixture-logical',
      displayName: 'Fixture',
      capabilities: [],
      modelFamilyId: null,
      autoFailover: true,
      routes: ['primary', 'backup'].map((id) => ({
        id,
        providerProfileId: id,
        providerModel: model.id,
        available: true,
        unavailableReason: null,
      })),
    };
    const outcome = await dispatchLogicalModel({
      logicalModel,
      signal: new AbortController().signal,
      resolveGatewayProvider: () => provider,
      attempt: async ({ provider: selected, execution }) => {
        attempted.push(`${execution.attemptOrder}:${execution.retryIndex}`);
        return invoke(dispatcher, selected, format, stream, {
          onProviderHttpRejection: observe,
          onProviderHandoff: handoff,
        });
      },
    }).catch((error: unknown) => error);
    expectUnsettledUnknown(outcome);
    expect(outcome).toHaveProperty('cause.message', 'Opaque synthetic rejection.');
    expect(attempted).toEqual(['0:0']);
    expect(handoff).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(observe.mock.calls).toEqual([[401]]);
  });

  it('keeps overlapping call observers isolated when responses arrive in reverse order', async () => {
    const { models, provider } = stockFixture();
    const dispatcher = new LLMGatewayProviderDispatcher({
      piAiClient: new PiAiGatewayClient({ models }),
    });
    let releaseFirst!: () => void;
    let startedFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      startedFirst = resolve;
    });
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      if (++calls === 1) {
        startedFirst();
        await firstGate;
        return rejection(401);
      }
      return rejection(403);
    });
    const first = vi.fn();
    const second = vi.fn();
    const firstResult = invoke(dispatcher, provider, 'responses', false, {
      onProviderHttpRejection: first,
    }).catch((error: unknown) => error);
    await firstStarted;
    const secondResult = await invoke(dispatcher, provider, 'responses', false, {
      onProviderHttpRejection: second,
    }).catch((error: unknown) => error);
    releaseFirst();
    expectUnsettledUnknown(await firstResult);
    expectUnsettledUnknown(secondResult);
    expect(calls).toBe(2);
    expect(first.mock.calls).toEqual([[401]]);
    expect(second.mock.calls).toEqual([[403]]);
  });
});

describe('stock xAI HTTP rejection diagnostics', () => {
  it('retains bounded typed HTTP 422 details without granting replay', async () => {
    const models = createModels();
    models.setProvider(xaiProvider());
    const model = models
      .getModels()
      .find((entry) => entry.provider === 'xai' && entry.api === 'openai-responses');
    if (!model) throw new Error('The stock xAI fixture requires a native Responses model.');
    const provider = { ...providerConfig(model.id), adapterId: 'xai' };
    const dispatcher = new LLMGatewayProviderDispatcher({
      piAiClient: new PiAiGatewayClient({ models }),
    });
    const urls: string[] = [];
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      urls.push(input instanceof Request ? input.url : String(input));
      const response = new Response(
        JSON.stringify({
          error: {
            type: 'invalid_request_error',
            code: 'unsupported_tool_type',
            param: 'tools[0].type',
            message: `Unsupported custom tool; ${syntheticAuth}; ${'detail '.repeat(80)}`,
            body: 'body-canary',
          },
          private: 'unselected-canary',
        }),
        { status: 422 }
      );
      response.headers.set('x-private-provider', 'header-canary');
      return response;
    });
    vi.stubGlobal('fetch', fetch);
    const observe = vi.fn();
    const attempted: string[] = [];
    const logicalModel: ResolvedLogicalModel = {
      id: 'fixture-logical',
      displayName: 'Fixture',
      capabilities: [],
      modelFamilyId: null,
      autoFailover: true,
      routes: ['primary', 'backup'].map((id) => ({
        id,
        providerProfileId: id,
        providerModel: model.id,
        available: true,
        unavailableReason: null,
      })),
    };
    const outcome = await dispatchLogicalModel({
      logicalModel,
      signal: new AbortController().signal,
      resolveGatewayProvider: () => provider,
      attempt: async ({ provider: selected, execution }) => {
        attempted.push(`${execution.attemptOrder}:${execution.retryIndex}`);
        return invoke(dispatcher, selected, 'responses', true, {
          onProviderHttpRejection: observe,
        });
      },
    }).catch((error: unknown) => error);
    expectUnsettledUnknown(outcome);
    expect(attempted).toEqual(['0:0']);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(urls).toEqual(['https://api.x.ai/v1/responses']);
    expect(observe.mock.calls).toEqual([
      [
        422,
        {
          type: 'invalid_request_error',
          code: 'unsupported_tool_type',
          param: 'tools[0].type',
          message: `Unsupported custom tool; [redacted]; ${'detail '.repeat(80)}`.slice(0, 200),
        },
      ],
    ]);
    expect(JSON.stringify(observe.mock.calls)).not.toContain(syntheticAuth);
    expect(JSON.stringify(observe.mock.calls)).not.toMatch(
      /header-canary|body-canary|unselected-canary/
    );
  });
});

describe('controlled Codex hook evidence guards', () => {
  it('keeps the diagnostic absent when the Provider never supplies an HTTP observation', async () => {
    const { dispatcher, provider } = semanticFixture(async () => {});
    const observe = vi.fn();
    expectUnsettledUnknown(
      await invoke(dispatcher, provider, 'responses', false, {
        onProviderHttpRejection: observe,
      }).catch((error: unknown) => error)
    );
    expect(observe).not.toHaveBeenCalled();
  });

  it('keeps a terminal failure after HTTP 200 separate from accepted turn-state continuity', async () => {
    const { dispatcher, provider } = semanticFixture(async (options, model) => {
      await options?.onResponse?.(
        { status: 200, headers: { 'x-codex-turn-state': 'accepted-state' } },
        model
      );
    });
    const observe = vi.fn();
    const turnStates = vi.fn();
    expectUnsettledUnknown(
      await invoke(dispatcher, provider, 'responses', false, {
        onCodexTurnState: turnStates,
        onProviderHttpRejection: observe,
      }).catch((error: unknown) => error)
    );
    expect(turnStates.mock.calls).toEqual([['accepted-state']]);
    expect(observe).not.toHaveBeenCalled();
  });

  it.each([
    0,
    199,
    200,
    299,
    302,
    399,
    401.5,
    600,
    NaN,
    Infinity,
    '401',
    undefined,
  ])('ignores non-rejection or malformed observed status %s', async (status) => {
    const { dispatcher, provider } = semanticFixture(async (options, model) => {
      await options?.onResponse?.({ status: status as number, headers: {} }, model);
    });
    const observe = vi.fn();
    expectUnsettledUnknown(
      await invoke(dispatcher, provider, 'responses', false, {
        onProviderHttpRejection: observe,
      }).catch((error: unknown) => error)
    );
    expect(observe).not.toHaveBeenCalled();
  });

  it.each([400, 599])('accepts bounded integer HTTP rejection status %s', async (status) => {
    const { dispatcher, provider } = semanticFixture(async (options, model) => {
      await options?.onResponse?.({ status, headers: {} }, model);
    });
    const observe = vi.fn();
    expectUnsettledUnknown(
      await invoke(dispatcher, provider, 'responses', false, {
        onProviderHttpRejection: observe,
      }).catch((error: unknown) => error)
    );
    expect(observe.mock.calls).toEqual([[status]]);
  });

  it.each([
    'id',
    'provider',
  ] as const)('ignores rejection evidence for a foreign model %s', async (key) => {
    const { dispatcher, provider } = semanticFixture(async (options, model) => {
      await options?.onResponse?.({ status: 401, headers: {} }, { ...model, [key]: 'foreign' });
    });
    const observe = vi.fn();
    expectUnsettledUnknown(
      await invoke(dispatcher, provider, 'responses', false, {
        onProviderHttpRejection: observe,
      }).catch((error: unknown) => error)
    );
    expect(observe).not.toHaveBeenCalled();
  });

  it('preserves successful Codex turn-state continuity without emitting rejection evidence', async () => {
    let headers: StreamOptions['headers'];
    const { dispatcher, provider } = semanticFixture(async (options, model) => {
      headers = options?.headers;
      await options?.onResponse?.(
        { status: 200, headers: { 'x-codex-turn-state': 'foreign-state' } },
        { ...model, id: 'foreign' }
      );
      await options?.onResponse?.(
        { status: 200, headers: { 'x-codex-turn-state': 'accepted-state' } },
        model
      );
    }, true);
    const observe = vi.fn();
    const turnStates = vi.fn();
    const result = await invoke(dispatcher, provider, 'responses', false, {
      codexTurnState: 'request-state',
      onCodexTurnState: turnStates,
      onProviderHttpRejection: observe,
    });
    expect(result).toMatchObject({ status: 'completed' });
    expect(headers).toMatchObject({ 'x-codex-turn-state': 'request-state' });
    expect(turnStates.mock.calls).toEqual([['accepted-state']]);
    expect(observe).not.toHaveBeenCalled();
  });
});
