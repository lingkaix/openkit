import {
  type AssistantMessage,
  type AssistantMessageEvent,
  createAssistantMessageEventStream,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  isRetryableAssistantError,
} from '@earendil-works/pi-ai';
import { describe, expect, it, vi } from 'vitest';
import type { ResolvedLLMProviderConfig } from '../providers/llm-config.js';
import { dispatchLogicalModel } from './gateway-routes.js';
import type { ResolvedLogicalModel } from './logical-models.js';
import { PiAiGatewayClient } from './pi-ai-client.js';
import { attachPiAiFailure, classifyPiAiFailure } from './pi-ai-failure.js';
import { LLMGatewayProviderDispatcher } from './provider-dispatcher.js';

/** Fixed oracle covering pinned provider wording and terminal/transport pattern collisions. */
const failureProbes = [
  [
    'OpenAI quota over 429',
    {
      status: 429,
      code: 'insufficient_quota',
      message: 'You exceeded your current quota, please check your plan and billing details.',
    },
    'quota_exhausted',
  ],
  ['Codex code', { status: 429, code: 'usage_limit_reached' }, 'quota_exhausted'],
  [
    'Codex friendly',
    new Error('You have hit your ChatGPT usage limit (plus plan). Try again in ~120 min.'),
    'quota_exhausted',
  ],
  [
    'Codex failed event text',
    new Error('usage_limit_reached: Usage limit reached'),
    'quota_exhausted',
  ],
  [
    'ChatGPT sharing allowance',
    new Error('subscription_sharing_usage_limit_exceeded'),
    'quota_exhausted',
  ],
  ['OpenCode free allowance', new Error('429 FreeUsageLimitError'), 'quota_exhausted'],
  [
    'OpenAI transient throttle',
    { status: 429, code: 'rate_limit_exceeded', headers: { 'retry-after': '2' } },
    'rate_limited',
  ],
  [
    'Bedrock throttle',
    new Error('Throttling error: Too many tokens, please wait before trying again.'),
    'rate_limited',
  ],
  [
    'OpenAI context',
    new Error('Your input exceeds the context window of this model'),
    'context_overflow',
  ],
  [
    'Anthropic context',
    new Error('prompt is too long: 213462 tokens > 200000 maximum'),
    'context_overflow',
  ],
  [
    'Gemini context',
    new Error(
      'The input token count (1196265) exceeds the maximum number of tokens allowed (1048575)'
    ),
    'context_overflow',
  ],
  [
    'xAI context',
    new Error(
      "This model's maximum prompt length is 131072 but the request contains 537812 tokens"
    ),
    'context_overflow',
  ],
  [
    'Cerebras bodyless context',
    {
      ...fauxAssistantMessage([], {
        stopReason: 'error',
        errorMessage: '400 status code (no body)',
      }),
      provider: 'cerebras',
    },
    'context_overflow',
  ],
  ['Credential rejection', { status: 401, code: 'invalid_api_key' }, 'auth_rejected'],
  ['Generic forbidden is not credential proof', { status: 403, message: 'Forbidden' }, 'unknown'],
  ['OpenAI refusal error', new Error('Response incomplete: content_filter'), 'refused'],
  [
    'Anthropic refusal stop',
    { ...fauxAssistantMessage([], { stopReason: 'error' }), rawStopReason: 'refusal' },
    'refused',
  ],
  [
    'Unsupported field',
    new Error("Unsupported parameter: 'temperature' is not supported with this model."),
    'unsupported',
  ],
  [
    'Output requirement rejected',
    new Error('max_tokens is too large: 8192. This model supports at most 4096 completion tokens.'),
    'output_limit',
  ],
  ['Malformed request', { status: 400, code: 'invalid_request_error' }, 'invalid_request'],
  [
    'Service outage',
    { status: 503, headers: new Headers({ 'retry-after': 'Wed, 01 Oct 2026 00:00:00 GMT' }) },
    'provider_unavailable',
  ],
  ['Fetch thrown', new TypeError('fetch failed'), 'provider_unavailable'],
  [
    'Stream truncated',
    new Error('OpenAI Responses stream ended before a terminal response event'),
    'provider_unavailable',
  ],
  ['Abort thrown', new DOMException('The operation was aborted.', 'AbortError'), 'cancelled'],
  ['Abort terminal', fauxAssistantMessage([], { stopReason: 'aborted' }), 'cancelled'],
  [
    'Unknown terminal',
    fauxAssistantMessage([], {
      stopReason: 'error',
      errorMessage: 'Unrecognized provider failure',
    }),
    'unknown',
  ],
  [
    'Normal length',
    fauxAssistantMessage([], { stopReason: 'length', rawStopReason: 'max_output_tokens' }),
    undefined,
  ],
  ['Readable refusal result', fauxAssistantMessage([], { stopReason: 'stop' }), undefined],
  ['ECONNREFUSED connect', new Error('connect ECONNREFUSED 127.0.0.1:443'), 'provider_unavailable'],
  ['Connection refused', new Error('connection refused'), 'provider_unavailable'],
  [
    'Upstream connect reset',
    new Error(
      'upstream connect error or disconnect/reset before headers. reset reason: connection termination'
    ),
    'provider_unavailable',
  ],
  ['Other side closed', new Error('other side closed'), 'provider_unavailable'],
  ['Terminated transport', new Error('terminated'), 'provider_unavailable'],
  ['WebSocket closed', new Error('websocket closed'), 'provider_unavailable'],
  ['Provider returned error', new Error('Provider returned error'), 'provider_unavailable'],
  ['ResourceExhausted', new Error('ResourceExhausted'), 'provider_unavailable'],
  ['Explicit retry guidance', new Error('You can retry your request'), 'provider_unavailable'],
  [
    'Anthropic 529 overload',
    Object.assign(new Error('Overloaded'), { status: 529, code: 'overloaded_error' }),
    'provider_unavailable',
  ],
  [
    'OpenAI TPM throttle',
    new Error('Rate limit reached for <model> in organization <org> on tokens per min (TPM)'),
    'rate_limited',
  ],
  [
    'Output limit with 5000',
    new Error('max_tokens is too large: 5000. This model supports at most 4096 completion tokens.'),
    'output_limit',
  ],
  [
    'Context overflow with 500',
    new Error('prompt is too long: 500 tokens > 400 maximum'),
    'context_overflow',
  ],
  [
    'Invalid timeout parameter with 500',
    Object.assign(new Error('Invalid request: timeout must be less than 500 seconds.'), {
      status: 400,
      code: 'invalid_request_error',
    }),
    'invalid_request',
  ],
  [
    'Unsupported timeout parameter',
    new Error("Unsupported parameter: 'timeout' is not supported with this model."),
    'unsupported',
  ],
  [
    'Quota with 500 retry guidance',
    new Error('insufficient_quota: You can retry your request after adding 500 credits.'),
    'quota_exhausted',
  ],
  [
    'Refusal code with terminated',
    Object.assign(new Error('Response terminated'), { code: 'content_filter' }),
    'refused',
  ],
  [
    'Safety code with timeout',
    Object.assign(new Error('Safety timeout'), { code: 'SAFETY' }),
    'refused',
  ],
  [
    'Auth code with terminated',
    Object.assign(new Error('Credential terminated'), { code: 'invalid_api_key' }),
    'auth_rejected',
  ],
  ['Cancellation with timeout', new DOMException('timeout terminated', 'AbortError'), 'cancelled'],
  ['Refused word without provider evidence', new Error('request refused'), 'unknown'],
  [
    'Transport mentions safety',
    new Error('connection refused: safety proxy timeout'),
    'provider_unavailable',
  ],
] as const;

describe('pi-ai failure probe table', () => {
  it('requires affirmative settled evidence instead of private/no-output inference', () => {
    const probes = [
      [new Error('connection refused'), true],
      [new Error('connect ECONNREFUSED 127.0.0.1:443'), true],
      [new Error('getaddrinfo ENOTFOUND api.example'), true],
      [new Error('connect ETIMEDOUT 127.0.0.1:443'), true],
      [Object.assign(new Error('reset'), { status: 503 }), true],
      [
        fauxAssistantMessage([], { stopReason: 'error', errorMessage: 'Rate limit reached' }),
        false,
      ],
      [new Error('Rate limit reached'), false],
      [new Error('read ECONNRESET'), false],
      [new Error('socket timeout'), false],
      [new Error('terminated'), false],
      [new Error('unclassified transport loss'), false],
      [
        fauxAssistantMessage([], {
          stopReason: 'error',
          errorMessage: 'unclassified transport loss',
        }),
        false,
      ],
      [new Error('Provider stream ended before terminal result'), false],
      [fauxAssistantMessage([], { stopReason: 'error', errorMessage: 'read ECONNRESET' }), false],
      [
        fauxAssistantMessage([], {
          stopReason: 'error',
          errorMessage: 'OpenAI Responses stream ended before a terminal response event',
        }),
        false,
      ],
    ] as const;
    expect(
      probes.map(([input]) => (classifyPiAiFailure(input) as { settled?: boolean })?.settled)
    ).toEqual(probes.map(([, settled]) => settled));
  });
  it('diffs every observed classification against the provider probe oracle', () => {
    expect(
      failureProbes.map(([probe, input]) => ({ probe, kind: classifyPiAiFailure(input)?.kind }))
    ).toEqual(failureProbes.map(([probe, , kind]) => ({ probe, kind })));
  });
  it('classifies terminal events and results identically without fabricating evidence', () => {
    for (const [, input] of failureProbes) {
      if (input && 'stopReason' in input) {
        expect(classifyPiAiFailure({ type: 'error', error: input })).toEqual(
          classifyPiAiFailure(input)
        );
      }
    }
    expect(classifyPiAiFailure(new Error('usage_limit_reached: limit'))).toEqual({
      kind: 'quota_exhausted',
      settled: false,
    });
    expect(classifyPiAiFailure(failureProbes[6][1])).toEqual({
      kind: 'rate_limited',
      settled: true,
      status: 429,
      providerCode: 'rate_limit_exceeded',
      retryAfter: '2',
    });
  });
});

/** Real Models runtime with exact synthetic terminal events, avoiding vendor network effects. */
function runtime(message: AssistantMessage) {
  const faux = fauxProvider({
    api: 'openai-responses',
    provider: 'openai-codex',
    models: [{ id: 'gpt-test', reasoning: true }],
  });
  const models = createModels();
  Object.assign(faux.provider, {
    stream: () => {
      const events = createAssistantMessageEventStream();
      events.push({
        type: 'error',
        reason: message.stopReason,
        error: message,
      } as AssistantMessageEvent);
      events.end(message);
      return events;
    },
  });
  models.setProvider(faux.provider);
  const provider = {
    id: 'profile-a',
    adapterId: 'openai-codex',
    subscriptionProviderId: 'openai-codex',
    backend: 'pi-ai',
    apiKey: null,
    requiresApiKey: false,
    baseUrl: null,
    models: ['gpt-test'],
    gatewayCapabilities: { chatCompletions: 'native', responses: 'native' },
  } as unknown as ResolvedLLMProviderConfig;
  return { models, provider, faux };
}

describe('pi-ai boundary failure attachment', () => {
  it.each([
    'chat',
    'responses',
    'chat-stream',
    'responses-stream',
  ])('carries the probe table through %s and dispatcher unchanged', async (path) => {
    for (const [, input, kind] of failureProbes) {
      if (kind === undefined) continue;
      const original = input as unknown as Record<string, unknown>;
      const message = Object.assign(
        fauxAssistantMessage([], {
          stopReason: kind === 'cancelled' ? 'aborted' : 'error',
          errorMessage: String(original.message ?? original.errorMessage ?? ''),
        }),
        original
      );
      const { models, provider } = runtime(message);
      const dispatcher = new LLMGatewayProviderDispatcher({ piAiClient: new PiAiGatewayClient() });
      const operation =
        path === 'chat'
          ? dispatcher.createChatCompletion(
              provider,
              { model: 'gpt-test', messages: [{ role: 'user', content: 'hello' }] },
              { models }
            )
          : path === 'responses'
            ? dispatcher.createResponses(
                provider,
                { model: 'gpt-test', input: 'hello' },
                { models }
              )
            : path === 'chat-stream'
              ? dispatcher
                  .createChatCompletionStream(
                    provider,
                    {
                      model: 'gpt-test',
                      messages: [{ role: 'user', content: 'hello' }],
                      stream: true,
                    },
                    { models }
                  )
                  .then((stream) => new Response(stream).text())
              : dispatcher
                  .createResponsesStream(
                    provider,
                    { model: 'gpt-test', input: 'hello', stream: true },
                    { models }
                  )
                  .then((stream) => new Response(stream).text());
      await expect(operation).rejects.toMatchObject({ failure: classifyPiAiFailure(message) });
    }
  });
  it('attaches actual thrown evidence once and preserves the original error fields', () => {
    const thrown = Object.assign(new Error('rate limit'), {
      status: 429,
      code: 'rate_limit_exceeded',
      headers: { 'retry-after': '3' },
    });
    expect(attachPiAiFailure(thrown)).toBe(thrown);
    expect(thrown).toMatchObject({
      failure: {
        kind: 'rate_limited',
        status: 429,
        providerCode: 'rate_limit_exceeded',
        retryAfter: '3',
      },
    });
    expect(attachPiAiFailure(thrown, new Error('unrelated failure'))).toBe(thrown);
    expect(Object.keys(thrown)).not.toContain('failure');
  });
  it('keeps the failure private and exposed fields intact for immutable thrown errors', () => {
    const original = Object.freeze(
      Object.assign(new Error('rate limit'), { status: 429, code: 'rate_limit_exceeded' })
    );
    const attached = attachPiAiFailure(original) as Error & { failure: unknown };
    expect(attached).toMatchObject({
      cause: original,
      status: 429,
      code: 'rate_limit_exceeded',
      failure: { kind: 'rate_limited', status: 429, providerCode: 'rate_limit_exceeded' },
    });
    expect(Object.keys(attached)).not.toContain('failure');
  });
  it('retains the exact caller cancellation reason through the real pi-ai client boundary', async () => {
    const { models, provider } = runtime(fauxAssistantMessage([], { stopReason: 'error' }));
    const reason = new Error('caller chose to stop');
    const signal = AbortSignal.abort(reason);
    await expect(
      new PiAiGatewayClient().createResponses(
        provider,
        { model: 'gpt-test', input: 'hello' },
        undefined,
        { signal },
        models
      )
    ).rejects.toBe(reason);
    expect(reason).toMatchObject({ failure: { kind: 'cancelled' } });
  });
  it('classifies stock-normalized provider throws using only the evidence pi-ai retained', async () => {
    const { models, provider, faux } = runtime(fauxAssistantMessage([], { stopReason: 'error' }));
    const thrown = Object.assign(new Error('rate limit'), {
      status: 429,
      code: 'rate_limit_exceeded',
      headers: { 'retry-after': '3' },
    });
    Object.assign(faux.provider, {
      stream: () => {
        throw thrown;
      },
    });
    const client = new PiAiGatewayClient();
    await expect(
      client.createResponses(provider, { model: 'gpt-test', input: 'hello' }, undefined, {}, models)
    ).rejects.toMatchObject({
      failure: { kind: 'rate_limited', settled: false },
    });
    try {
      await client.createResponses(
        provider,
        { model: 'gpt-test', input: 'hello' },
        undefined,
        {},
        models
      );
    } catch (error) {
      expect(error).not.toHaveProperty('status');
      expect((error as { failure: unknown }).failure).toEqual({
        kind: 'rate_limited',
        settled: false,
      });
    }
  });
});

/** Fixed transport oracle mirrors every pinned retry.js transport family and separator spelling. */
const stockTransportFamilies: readonly [string, boolean][] = [
  ...[
    'network?error',
    'connection?error',
    'connection?refused',
    'connection?lost',
    'upstream?connect',
    'websocket?closed',
    'websocket?error',
  ].flatMap((family) =>
    ['', ' ', '.', '_', '-'].map((separator): [string, boolean] => [
      family.replace('?', separator),
      family === 'connection?refused' && separator === ' ',
    ])
  ),
  ['other side closed', false],
  ['fetch failed', false],
  ['getaddrinfo', false],
  ['ENOTFOUND', true],
  ['EAI_AGAIN', true],
  ['reset before headers', false],
  ['socket hang up', false],
  ['socket connection was closed', false],
  ['time out', false],
  ['timed out', false],
  ['timeout', false],
  ['terminated', false],
  ['ended without', false],
  ['Anthropic stream ended before message_stop', false],
  ['OpenAI Responses stream ended before a terminal response event', false],
  ['http2 request did not get a response', false],
  ['Connection error.', false],
  ['upstream connect error', false],
  ['retry delay', false],
  ['you can retry your request', false],
  ['try your request again', false],
  ['please retry your request', false],
  ['ResourceExhausted', false],
  ['subscription_sharing_usage_unavailable', false],
  ['subscription_sharing_user_unavailable', false],
];

/** Named Provider and pre-send controls make the affirmative evidence boundary explicit. */
const affirmativeControls = [
  { message: 'connect ECONNREFUSED 127.0.0.1:443', kind: 'provider_unavailable', settled: true },
  { message: 'getaddrinfo ENOTFOUND api.example', kind: 'provider_unavailable', settled: true },
  { message: 'connect ETIMEDOUT 127.0.0.1:443', kind: 'provider_unavailable', settled: true },
  { message: 'connect timeout', kind: 'provider_unavailable', settled: true },
  { message: 'read ECONNRESET', kind: 'provider_unavailable', settled: false },
  { message: 'socket timeout', kind: 'provider_unavailable', settled: false },
  { message: 'unknown future transport', kind: 'unknown', settled: false },
  { message: 'Unrecognized provider failure', kind: 'unknown', settled: false },
  { message: '503 Service Unavailable', kind: 'provider_unavailable', settled: false },
  { message: 'overloaded', kind: 'provider_unavailable', settled: false },
  { message: 'Provider returned error', kind: 'provider_unavailable', settled: false },
  { message: 'socket hang up', status: 503, kind: 'provider_unavailable', settled: true },
  { message: 'Forbidden', status: 403, kind: 'unknown', settled: true },
  {
    message: 'quota',
    status: 429,
    code: 'insufficient_quota',
    kind: 'quota_exhausted',
    settled: true,
  },
  {
    message: 'rate limit',
    status: 429,
    code: 'rate_limit_exceeded',
    kind: 'rate_limited',
    settled: true,
  },
  {
    message: 'usage_limit_reached: allowance exhausted',
    kind: 'quota_exhausted',
    settled: 'wrapped',
  },
  {
    message: 'You have hit your ChatGPT usage limit (plus plan).',
    kind: 'quota_exhausted',
    settled: false,
  },
  { message: 'insufficient_quota: out of budget', kind: 'quota_exhausted', settled: 'wrapped' },
  { message: 'rate_limit_exceeded: too many requests', kind: 'rate_limited', settled: 'wrapped' },
  { message: 'Rate limit reached', kind: 'rate_limited', settled: false },
  { message: 'invalid_api_key', kind: 'auth_rejected', settled: 'wrapped' },
  { message: 'Incorrect API key provided', kind: 'auth_rejected', settled: false },
  {
    message: 'Your input exceeds the context window of this model',
    kind: 'context_overflow',
    settled: false,
  },
  {
    message: "Unsupported parameter: 'temperature' is not supported with this model.",
    kind: 'unsupported',
    settled: false,
  },
  {
    message: 'max_tokens is too large: 8192. This model supports at most 4096 completion tokens.',
    kind: 'output_limit',
    settled: false,
  },
  { message: 'Response incomplete: content_filter', kind: 'refused', settled: 'wrapped' },
  { message: 'invalid_request_error', kind: 'invalid_request', settled: 'wrapped' },
  {
    message: 'socket hang up',
    code: 'rate_limit_exceeded',
    kind: 'rate_limited',
    settled: true,
  },
  {
    message: 'socket timeout',
    code: 'usage_limit_reached',
    kind: 'quota_exhausted',
    settled: true,
  },
  { message: 'Connection error.', code: 'invalid_api_key', kind: 'auth_rejected', settled: true },
  { message: 'Safety timeout', code: 'SAFETY', kind: 'refused', settled: true },
  {
    message: 'socket hang up',
    code: 'unclassified_transport_code',
    kind: 'provider_unavailable',
    settled: false,
  },
] as const;

/** Literal evidence oracle also used by the report's read-only Round 2 byte comparison. */
const replayEvidenceProbes = [
  ...stockTransportFamilies.map(([message, settled]) => ({
    message,
    settled,
    kind: 'provider_unavailable' as const,
    stockTransport: true,
  })),
  ...affirmativeControls,
].flatMap((probe) =>
  ['unwrapped', 'wrapped'].map((form) => ({
    name: `${form}: ${probe.message}${'status' in probe ? ` status=${probe.status}` : ''}${'code' in probe ? ` code=${probe.code}` : ''}`,
    stockTransport: 'stockTransport' in probe,
    input: Object.assign(
      form === 'wrapped'
        ? fauxAssistantMessage([], { stopReason: 'error', errorMessage: probe.message })
        : new Error(probe.message),
      ...('status' in probe ? [{ status: probe.status }] : []),
      ...('code' in probe ? [{ code: probe.code }] : [])
    ),
    expected: {
      kind: probe.kind,
      settled: probe.settled === 'wrapped' ? form === 'wrapped' : probe.settled,
    },
  }))
);

describe('Round 3 affirmative replay evidence', () => {
  it.each(replayEvidenceProbes)('$name', ({ input, expected, stockTransport }) => {
    if (stockTransport)
      expect(
        isRetryableAssistantError(
          fauxAssistantMessage([], {
            stopReason: 'error',
            errorMessage: input instanceof Error ? input.message : input.errorMessage,
          })
        )
      ).toBe(true);
    expect(classifyPiAiFailure(input)).toMatchObject(expected);
  });
});

describe('Round 3 stock-wrapped transport cannot replay', () => {
  for (const endpoint of ['chat', 'responses'] as const) {
    for (const stream of [false, true]) {
      it.each([false, true])(`${endpoint} stream=${stream} failover=%s`, async (autoFailover) => {
        vi.useFakeTimers();
        try {
          const { models, provider, faux } = runtime(
            fauxAssistantMessage([], { stopReason: 'error' })
          );
          let primaryCalls = 0;
          Object.assign(faux.provider, {
            stream: () => ({
              [Symbol.asyncIterator]() {
                return {
                  async next() {
                    primaryCalls++;
                    throw Object.assign(new Error('Connection error.'), {
                      cause: new Error('read ECONNRESET'),
                    });
                  },
                  async return() {
                    return { done: true, value: undefined };
                  },
                };
              },
            }),
          });
          const backup = fauxProvider({ provider: 'anthropic', models: [{ id: 'gpt-test' }] });
          models.setProvider(backup.provider);
          backup.setResponses([fauxAssistantMessage('Backup must stay dormant.')]);
          const dispatcher = new LLMGatewayProviderDispatcher({
            piAiClient: new PiAiGatewayClient({ models }),
          });
          const logicalModel: ResolvedLogicalModel = {
            id: 'tier',
            displayName: 'Tier',
            capabilities: [],
            modelFamilyId: null,
            autoFailover,
            contextManagement: { type: 'compaction', compactThreshold: 8_000 },
            routes: ['primary', 'backup'].map((id) => ({
              id,
              providerProfileId: id,
              providerModel: 'gpt-test',
              available: true,
              unavailableReason: null,
            })),
          };
          const pending = dispatchLogicalModel({
            logicalModel,
            signal: new AbortController().signal,
            resolveGatewayProvider: (id) =>
              id === 'primary'
                ? provider
                : {
                    ...provider,
                    id: 'backup',
                    adapterId: 'anthropic',
                    subscriptionProviderId: undefined,
                  },
            attempt: async ({ provider: selected, execution }) => {
              const context = { models, transport: { signal: execution.signal } };
              if (stream) {
                const upstream =
                  endpoint === 'chat'
                    ? await dispatcher.createChatCompletionStream(
                        selected,
                        {
                          model: 'gpt-test',
                          messages: [{ role: 'user', content: 'hello' }],
                          stream: true,
                        },
                        context
                      )
                    : await dispatcher.createResponsesStream(
                        selected,
                        { model: 'gpt-test', input: 'hello', stream: true },
                        context
                      );
                return new Response(await execution.prepareStream(upstream)).text();
              }
              return endpoint === 'chat'
                ? dispatcher.createChatCompletion(
                    selected,
                    { model: 'gpt-test', messages: [{ role: 'user', content: 'hello' }] },
                    context
                  )
                : dispatcher.createResponses(
                    selected,
                    { model: 'gpt-test', input: 'hello' },
                    context
                  );
            },
          }).then(
            (result) => ({ result }),
            (error) => ({ error })
          );
          await vi.runAllTimersAsync();
          const outcome = await pending;
          expect(primaryCalls).toBe(1);
          expect(backup.state.callCount).toBe(0);
          expect(outcome).toMatchObject({
            error: { failure: { kind: 'provider_unavailable', settled: false } },
          });
          expect(vi.getTimerCount()).toBe(0);
        } finally {
          vi.useRealTimers();
        }
      });
    }
  }
});
