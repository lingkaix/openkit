import { createServer, type Server } from 'node:http';
import { zstdDecompressSync } from 'node:zlib';
import {
  type CredentialStore,
  createAssistantMessageEventStream,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
  getCurrentTools,
  type OAuthCredential,
  type TranscriptContext,
} from '@earendil-works/pi-ai';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { admitModelRequest } from '../context/model-request-admission.js';
import type { ResolvedLLMProviderConfig } from '../providers/llm-config.js';
import { GatewayUnsupportedFeatureError, PiAiGatewayClient } from './pi-ai-client.js';
import { REASONING_ATTRIBUTION_LIMIT, ReasoningAttribution } from './reasoning-attribution.js';

/**
 * Chat-native bridged provider used as the worker-inference Responses test double.
 *
 * `subscriptionProviderId` is only the faux pi-ai Models lookup key. It is not an OAuth
 * subscription profile and does not claim catalog `tool_call` metadata for any live Orca id.
 */
function bridgedChatNativeProvider(): ResolvedLLMProviderConfig {
  return {
    adapterId: 'orcarouter-bridged',
    apiKey: 'bridged-secret',
    backend: 'pi-ai',
    baseUrl: null,
    displayName: 'Bridged Chat Native',
    gatewayCapabilities: { chatCompletions: 'native', responses: 'bridged' },
    id: 'orcarouter-bridged',
    models: ['faux-bridged-chat'],
    requiresApiKey: true,
    subscriptionProviderId: 'orcarouter-bridged',
  } as unknown as ResolvedLLMProviderConfig;
}

/**
 * Builds one worker-inference Responses request after current additional_tools lowering.
 *
 * @param tools Message-anchored local tool declarations.
 * @returns OpenAI-compatible Responses stream request with empty top-level tools.
 */
function workerResponsesRequest(tools: readonly Record<string, unknown>[]) {
  return {
    input: [
      { role: 'developer', tools, type: 'additional_tools' },
      { content: [{ text: 'Read README.md at git HEAD.', type: 'input_text' }], role: 'user' },
    ],
    model: 'faux-bridged-chat',
    store: false,
    stream: true,
    tools: [],
  };
}

const READ_FILE_FUNCTION = {
  description: 'Read one file from the attached workspace.',
  name: 'read_file',
  parameters: {
    properties: { path: { type: 'string' } },
    required: ['path'],
    type: 'object',
  },
  strict: false,
  type: 'function',
} as const;

const EXEC_CUSTOM = {
  description: 'Run one command.',
  format: { type: 'text' },
  name: 'exec',
  type: 'custom',
} as const;

describe('bridged worker Responses function tools', () => {
  it('advertises function-only additional_tools on a chat-native bridge', async () => {
    let providerCalls = 0;
    let seenContext: TranscriptContext | undefined;
    const faux = fauxProvider({
      api: 'openai-completions',
      models: [{ id: 'faux-bridged-chat' }],
      provider: 'orcarouter-bridged',
    });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      async (context) => {
        providerCalls += 1;
        seenContext = context;
        return fauxAssistantMessage(
          [fauxToolCall('read_file', { path: 'README.md' }, { id: 'call_read' }), fauxText('ok')],
          { stopReason: 'toolUse' }
        );
      },
    ]);

    const stream = await new PiAiGatewayClient().createResponsesStream(
      bridgedChatNativeProvider(),
      workerResponsesRequest([READ_FILE_FUNCTION]),
      undefined,
      {},
      models
    );
    const body = await new Response(stream).text();
    const events = body
      .split('\n')
      .filter((line) => line.startsWith('data: {'))
      .map((line) => JSON.parse(line.slice('data: '.length)) as Record<string, unknown>);

    expect(providerCalls).toBe(1);
    expect(seenContext ? getCurrentTools(seenContext.messages) : undefined).toEqual([
      expect.objectContaining({
        description: READ_FILE_FUNCTION.description,
        name: 'read_file',
      }),
    ]);
    expect(events.map((event) => event.type)).toContain('response.function_call_arguments.done');
    expect(events.some((event) => event.type === 'response.custom_tool_call_input.done')).toBe(
      false
    );
  });

  it('rejects custom additional_tools before the bridged provider effect', async () => {
    let providerCalls = 0;
    const faux = fauxProvider({
      api: 'openai-completions',
      models: [{ id: 'faux-bridged-chat' }],
      provider: 'orcarouter-bridged',
    });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      async () => {
        providerCalls += 1;
        return fauxAssistantMessage('should not run');
      },
    ]);

    await expect(
      new PiAiGatewayClient().createResponsesStream(
        bridgedChatNativeProvider(),
        workerResponsesRequest([EXEC_CUSTOM]),
        undefined,
        {},
        models
      )
    ).rejects.toBeInstanceOf(GatewayUnsupportedFeatureError);
    expect(providerCalls).toBe(0);
  });

  it('rejects mixed function and custom additional_tools before the bridged provider effect', async () => {
    let providerCalls = 0;
    const faux = fauxProvider({
      api: 'openai-completions',
      models: [{ id: 'faux-bridged-chat' }],
      provider: 'orcarouter-bridged',
    });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      async () => {
        providerCalls += 1;
        return fauxAssistantMessage('should not run');
      },
    ]);

    await expect(
      new PiAiGatewayClient().createResponsesStream(
        bridgedChatNativeProvider(),
        workerResponsesRequest([READ_FILE_FUNCTION, EXEC_CUSTOM]),
        undefined,
        {},
        models
      )
    ).rejects.toBeInstanceOf(GatewayUnsupportedFeatureError);
    expect(providerCalls).toBe(0);
  });

  it('rejects native Responses builtins in additional_tools before the bridged provider effect', async () => {
    let providerCalls = 0;
    const faux = fauxProvider({
      api: 'openai-completions',
      models: [{ id: 'faux-bridged-chat' }],
      provider: 'orcarouter-bridged',
    });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      async () => {
        providerCalls += 1;
        return fauxAssistantMessage('should not run');
      },
    ]);

    await expect(
      new PiAiGatewayClient().createResponsesStream(
        bridgedChatNativeProvider(),
        workerResponsesRequest([{ name: 'web_search', type: 'web_search' }]),
        undefined,
        {},
        models
      )
    ).rejects.toBeInstanceOf(GatewayUnsupportedFeatureError);
    expect(providerCalls).toBe(0);
  });
});

/** Encodes native provider items through the stock parser, including terminal output. */
function nativeStream(items: Record<string, unknown>[], id: string): Response {
  const events: Record<string, unknown>[] = [
    { type: 'response.created', response: { id, output: [], status: 'in_progress' } },
  ];
  items.forEach((item, output_index) => {
    events.push(
      { type: 'response.output_item.added', output_index, item },
      { type: 'response.output_item.done', output_index, item }
    );
  });
  events.push({
    type: 'response.completed',
    response: {
      id,
      output: items,
      status: 'completed',
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    },
  });
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });
}

/** Parses the actual SSE frames returned to a worker. */
async function eventsFrom(stream: ReadableStream<Uint8Array>) {
  const body = await new Response(stream).text();
  return body
    .split('\n')
    .filter((line) => line.startsWith('data: {'))
    .map((line) => JSON.parse(line.slice(6)));
}

/** Projects the pinned Codex ResponseItem serde fields; output annotations and status are not replayed. */
function workerHistoryItem(item: Record<string, unknown>): Record<string, unknown> {
  const { status: _status, ...history } = item;
  if (Array.isArray(history.content)) {
    history.content = history.content.map(({ type, text }) => ({ type, text }));
  }
  return history;
}

afterEach(() => vi.unstubAllGlobals());

it('preserves native commentary and final-answer identity across a successful tool result', async () => {
  const credential: OAuthCredential = {
    access: `e30.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-account' } })).toString('base64url')}.signature`,
    expires: Date.now() + 3600000,
    refresh: 'fixture-refresh',
    type: 'oauth',
  };
  const credentials: CredentialStore = {
    async delete() {},
    async list() {
      return [{ providerId: 'openai-codex', type: 'oauth' }];
    },
    async modify(_providerId, fn) {
      return fn(credential);
    },
    async read() {
      return credential;
    },
  };
  const models = createModels({ credentials });
  models.setProvider(openaiCodexProvider());
  const provider = {
    accountSlotId: 'fixture',
    adapterId: 'openai-codex',
    apiKey: null,
    backend: 'pi-ai',
    baseUrl: null,
    displayName: 'Fixture',
    gatewayCapabilities: { chatCompletions: 'bridged', responses: 'native' },
    id: 'fixture',
    models: ['gpt-6'],
    modelMetadata: { 'gpt-6': { limit: { context: 200000 } } },
    requiresApiKey: false,
    subscriptionProviderId: 'openai-codex',
  } as ResolvedLLMProviderConfig;
  const commentary = {
    id: 'msg_before_tool',
    type: 'message',
    role: 'assistant',
    status: 'completed',
    phase: 'commentary',
    content: [{ type: 'output_text', text: 'I will read the file.' }],
  };
  const call = {
    id: 'fc_read',
    call_id: 'call_read',
    type: 'function_call',
    name: 'read_file',
    arguments: '{"path":"proof.txt"}',
    status: 'completed',
  };
  const reply = {
    id: 'msg_after_tool',
    type: 'message',
    role: 'assistant',
    status: 'completed',
    phase: 'final_answer',
    content: [{ type: 'output_text', text: 'Verified: openkit-tool-smoke-ok' }],
  };
  const requests: Record<string, unknown>[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: unknown, init: RequestInit) => {
      const bytes = Buffer.from(init.body as Uint8Array);
      requests.push(
        JSON.parse(
          (new Headers(init.headers).get('content-encoding') === 'zstd'
            ? zstdDecompressSync(bytes)
            : bytes
          ).toString()
        )
      );
      return requests.length === 1
        ? nativeStream([commentary, call], 'resp_before')
        : nativeStream([reply], 'resp_after');
    })
  );
  const prefix = [
    {
      type: 'additional_tools',
      role: 'developer',
      tools: [
        {
          type: 'function',
          name: 'read_file',
          parameters: { type: 'object', properties: { path: { type: 'string' } } },
        },
      ],
    },
    { role: 'user', content: 'Read proof.txt and report its contents.' },
  ];
  const client = new PiAiGatewayClient();
  const before = await eventsFrom(
    await client.createResponsesStream(
      provider,
      { model: 'gpt-6', input: prefix, tools: [], stream: true },
      undefined,
      {},
      models
    )
  );
  const output = before
    .filter((event) => event.type === 'response.output_item.done')
    .map((event) => workerHistoryItem(event.item));
  expect(before.at(-1)).toMatchObject({
    type: 'response.completed',
    response: { id: 'resp_before' },
  });
  expect(
    before.find(
      (event) => event.type === 'response.output_item.added' && event.item.type === 'message'
    )
  ).toMatchObject({ item: { id: commentary.id, phase: 'commentary' } });
  expect(
    before
      .filter(
        (event) =>
          event.type.startsWith('response.output_text.') ||
          event.type.startsWith('response.content_part.')
      )
      .map((event) => event.item_id)
  ).toEqual([commentary.id, commentary.id, commentary.id, commentary.id]);
  // Replay the worker-visible output, not a hand-authored copy of provider history.
  const result = {
    type: 'function_call_output',
    call_id: 'call_read',
    output: 'openkit-tool-smoke-ok',
  };
  const after = await eventsFrom(
    await client.createResponsesStream(
      provider,
      { model: 'gpt-6', input: [...prefix, ...output, result], tools: [], stream: true },
      undefined,
      {},
      models
    )
  );
  expect(requests[1]?.input).toEqual([
    ...prefix,
    workerHistoryItem(commentary),
    workerHistoryItem(call),
    result,
  ]);
  expect(
    after.filter((event) => event.type === 'response.output_item.done').map((event) => event.item)
  ).toMatchObject([reply]);
  expect(after.at(-1)).toMatchObject({
    type: 'response.completed',
    response: { id: 'resp_after', output: [reply] },
  });
  const nonStreaming = await client.createResponses(
    provider,
    { model: 'gpt-6', input: [...prefix, ...output, result], tools: [] },
    undefined,
    {},
    models
  );
  expect(nonStreaming.output).toEqual([reply]);
});

/** Creates a real pi-ai runtime with a synthetic provider that exposes received history. */
function fixture() {
  const faux = fauxProvider({
    api: 'openai-responses',
    provider: 'openai-codex',
    models: [
      { id: 'gpt-test', reasoning: true },
      { id: 'gpt-other', reasoning: true },
    ],
  });
  const models = createModels();
  const history: unknown[] = [];
  const capsule = {
    id: `rs_${crypto.randomUUID()}`,
    type: 'reasoning',
    encrypted_content: 'opaque-ciphertext',
    content: null,
    summary: [{ type: 'summary_text', text: 'Readable reasoning.' }],
  };
  const block = {
    ...fauxThinking('Readable reasoning.'),
    thinkingSignature: JSON.stringify(capsule),
  };
  const message = fauxAssistantMessage([block, fauxText('Answer.')]);
  Object.assign(faux.provider, {
    stream: (_model: unknown, context: TranscriptContext) => {
      history.push(context.messages);
      const events = createAssistantMessageEventStream();
      events.push({ type: 'start', partial: { ...message, content: [] } });
      events.push({
        type: 'thinking_end',
        contentIndex: 0,
        content: block.thinking,
        partial: message,
      });
      events.push({ type: 'text_end', contentIndex: 1, content: 'Answer.', partial: message });
      events.push({ type: 'done', reason: 'stop', message });
      events.end(message);
      return events;
    },
  });
  models.setProvider(faux.provider);
  const provider = {
    id: 'account-a',
    adapterId: 'openai-codex',
    subscriptionProviderId: 'openai-codex',
    backend: 'pi-ai',
    apiKey: null,
    requiresApiKey: false,
    baseUrl: null,
    models: ['gpt-test', 'gpt-other'],
    gatewayCapabilities: { chatCompletions: 'bridged', responses: 'native' },
  } as unknown as ResolvedLLMProviderConfig;
  return { capsule, history, models, provider };
}

/** Builds a reasoning/tool history with an fc_ identity tied to the capsule. */
function replay(capsule: Record<string, unknown>) {
  return {
    model: 'gpt-test',
    input: [
      capsule,
      {
        type: 'function_call',
        id: 'fc_paired',
        call_id: 'call_paired',
        name: 'check',
        arguments: '{}',
      },
      { type: 'function_call_output', call_id: 'call_paired', output: 'ok' },
    ],
    tools: [{ type: 'function', name: 'check', parameters: { type: 'object', properties: {} } }],
  };
}

describe('pi-ai reasoning attribution', () => {
  it('hands external capsules off as readable assistant text and drops the paired fc_ id', async () => {
    const { capsule, history, models, provider } = fixture();
    await new PiAiGatewayClient().createResponses(provider, replay(capsule), undefined, {}, models);
    const bytes = JSON.stringify(history.at(-1));
    expect(bytes).toContain('Readable reasoning.');
    expect(bytes).not.toContain('opaque-ciphertext');
    expect(bytes).not.toContain('thinkingSignature');
    expect(bytes).not.toContain('fc_paired');
    expect(bytes).toContain('call_paired');
  });
  it.each(['restart', 'eviction'])(
    'uses readable handoff after %s even for the original member',
    async (loss) => {
      const { history, models, provider } = fixture();
      const association = new ReasoningAttribution();
      const client = new PiAiGatewayClient({ reasoningAttribution: association });
      const response = await client.createResponses(
        provider,
        { model: 'gpt-test', input: 'hello' },
        undefined,
        {},
        models
      );
      if (loss === 'eviction') {
        for (let index = 0; index < REASONING_ATTRIBUTION_LIMIT; index++)
          association.record(`rs_other_${index}`, { providerId: provider.id, modelId: 'gpt-test' });
      }
      const restarted =
        loss === 'restart'
          ? new PiAiGatewayClient({ reasoningAttribution: new ReasoningAttribution() })
          : client;
      await restarted.createResponses(
        provider,
        replay(response.output![0]!),
        undefined,
        {},
        models
      );
      const bytes = JSON.stringify(history.at(-1));
      expect(bytes).toContain('Readable reasoning.');
      expect(bytes).not.toContain('opaque-ciphertext');
      expect(bytes).not.toContain('thinkingSignature');
      expect(bytes).not.toContain('fc_paired');
    }
  );
  it('matches two logical-model dispatches using the same profile and native model across clients', async () => {
    const { history, models, provider } = fixture();
    // Logical route ids are resolved above the client; both dispatches arrive with this same native id.
    const first = await new PiAiGatewayClient().createResponses(
      provider,
      { model: 'gpt-test', input: 'first logical model' },
      undefined,
      {},
      models
    );
    await new PiAiGatewayClient().createResponses(
      provider,
      replay(first.output![0]!),
      undefined,
      {},
      models
    );
    expect(JSON.stringify(history.at(-1))).toContain('opaque-ciphertext');
    expect(JSON.stringify(history.at(-1))).toContain('fc_paired');
  });
  it.each([[[]], [[{ type: 'summary_text', text: '  ' }]]])(
    'omits unattributed empty/redacted thinking (%j)',
    async (summary) => {
      const { history, models, provider, capsule } = fixture();
      await new PiAiGatewayClient().createResponses(
        provider,
        replay({ ...capsule, summary }),
        undefined,
        {},
        models
      );
      const bytes = JSON.stringify(history.at(-1));
      expect(bytes).not.toContain('opaque-ciphertext');
      expect(bytes).not.toContain('thinkingSignature');
      expect(bytes).not.toContain('fc_paired');
      expect(bytes).not.toContain('"type":"thinking"');
    }
  );
  it.each([false, true])(
    'preserves only same-profile/native-model round trips (stream=%s)',
    async (stream) => {
      const { capsule, history, models, provider } = fixture();
      const client = new PiAiGatewayClient();
      const request = { model: 'gpt-test', input: 'hello' };
      const response = stream
        ? JSON.parse(
            (
              await new Response(
                await client.createResponsesStream(provider, request, undefined, {}, models)
              ).text()
            )
              .split('\n')
              .find((line) => line.includes('"type":"response.completed"'))!
              .slice(6)
          ).response
        : await client.createResponses(provider, request, undefined, {}, models);
      expect(response.output[0]).toEqual({ ...capsule, status: 'completed' });
      await client.createResponses(provider, replay(response.output[0]), undefined, {}, models);
      expect(JSON.stringify(history.at(-1))).toContain('opaque-ciphertext');
      expect(JSON.stringify(history.at(-1))).toContain('fc_paired');
      await client.createResponses(
        { ...provider, id: 'account-b' },
        replay(response.output[0]),
        undefined,
        {},
        models
      );
      expect(JSON.stringify(history.at(-1))).not.toContain('opaque-ciphertext');
      expect(JSON.stringify(history.at(-1))).not.toContain('fc_paired');
      await client.createResponses(
        provider,
        { ...replay(response.output[0]), model: 'gpt-other' },
        undefined,
        {},
        models
      );
      expect(JSON.stringify(history.at(-1))).not.toContain('opaque-ciphertext');
    }
  );
});

function registerPiAiImageInputTests() {
  const png =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
  const jpeg =
    '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAABAAEDAREAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAb/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCwAB//2Q==';
  const servers: Server[] = [];
  afterEach(async () => {
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });

  /** Uses the pinned stock Codex serializer with a test-owned HTTP endpoint and synthetic auth. */
  async function fixture(imageInput = true, contextWindowTokens = 131_072) {
    const bodies: Record<string, unknown>[] = [];
    const server = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const encoded = Buffer.concat(chunks);
        const decoded =
          request.headers['content-encoding'] === 'zstd' ? zstdDecompressSync(encoded) : encoded;
        bodies.push(JSON.parse(decoded.toString('utf8')));
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(
          `data: ${JSON.stringify({
            type: 'response.completed',
            response: {
              id: 'resp_image',
              status: 'completed',
              output: [],
              usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
            },
          })}\n\n`
        );
      })().catch((error: unknown) => response.destroy(error as Error));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture endpoint unavailable.');
    const models = createModels();
    const stock = openaiCodexProvider();
    models.setProvider(stock);
    const model = models.getModels().find((entry) => entry.api === 'openai-codex-responses');
    if (!model) throw new Error('Stock Codex fixture model unavailable.');
    const provider: ResolvedLLMProviderConfig = {
      id: 'image-fixture',
      displayName: 'Image fixture',
      adapterId: stock.id,
      apiKey: `synthetic.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture' } })).toString('base64url')}.synthetic`,
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      models: [model.id],
      modelMetadata: {
        [model.id]: {
          modalities: { input: imageInput ? ['text', 'image'] : ['text'] },
          limit: { context: contextWindowTokens, output: 8_192 },
        },
      },
      requiresApiKey: true,
      gatewayCapabilities: { responses: 'native', chatCompletions: 'bridged' },
    };
    const attribution = new ReasoningAttribution();
    attribution.record('rs_image', { providerId: provider.id, modelId: model.id });
    return {
      client: new PiAiGatewayClient({ models, reasoningAttribution: attribution }),
      provider,
      model,
      bodies,
    };
  }

  /** Carries inline user PNG and native function-result JPEG with retained text and reasoning history. */
  function request(model: string) {
    return {
      model,
      instructions: 'Keep the selected source identity.',
      max_output_tokens: 32,
      tools: [
        {
          type: 'function',
          name: 'work_source_view',
          parameters: { type: 'object', properties: {} },
          strict: false,
        },
      ],
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'Read this PNG.' },
            { type: 'input_image', image_url: `data:image/png;base64,${png}`, detail: 'auto' },
          ],
        },
        {
          type: 'reasoning',
          id: 'rs_image',
          summary: [{ type: 'summary_text', text: 'Preserve earlier reasoning.' }],
          encrypted_content: 'synthetic-opaque-reasoning',
        },
        {
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Read the bounded source view.' }],
        },
        {
          type: 'function_call',
          id: 'fc_view',
          call_id: 'call_view',
          name: 'work_source_view',
          arguments: '{}',
        },
        {
          type: 'function_call_output',
          call_id: 'call_view',
          output: [
            { type: 'input_text', text: 'Exact source and crop facts.' },
            { type: 'input_image', image_url: `data:image/jpeg;base64,${jpeg}`, detail: 'high' },
            { type: 'input_text', text: 'Keep the complete trailing facts.' },
          ],
        },
      ],
    };
  }

  it('preserves native PNG/JPEG bytes and history through stock HTTP and final request admission', async () => {
    const f = await fixture();
    const input = request(f.model.id);
    const before = structuredClone(input);
    const admitted: unknown[] = [];
    const response = await f.client.createResponses(f.provider, input, undefined, {
      finalRequestAdmission: (final) => {
        admitted.push(final.payload);
        admitModelRequest({
          payload: final.payload,
          contextWindowTokens: final.contextWindowTokens,
          outputReserveTokens: final.outputReserveTokens,
        });
      },
    });

    expect(response.status).toBe('completed');
    expect(f.bodies).toHaveLength(1);
    expect(f.bodies[0]!.input).toEqual(input.input);
    expect(f.bodies[0]!.instructions).toBe(input.instructions);
    expect(admitted).toEqual(f.bodies);
    expect(input).toEqual(before);
  });

  it('refuses the same images on a text-only selected model before HTTP or final handoff', async () => {
    const f = await fixture(false);
    const admission = vi.fn();
    await expect(
      f.client.createResponses(f.provider, request(f.model.id), undefined, {
        finalRequestAdmission: admission,
      })
    ).rejects.toMatchObject({
      code: 'unsupported_gateway_feature',
      feature: 'pi-ai Responses model image input',
    });
    expect(f.bodies).toEqual([]);
    expect(admission).not.toHaveBeenCalled();
  });

  it('refuses the approximate image allowance at the actual final callback before any stock HTTP effect', async () => {
    // The two image allowances, fixed margin and actual reserve already exceed this physical capacity, before text metadata.
    const capacity = 2 * 8_192 + 4_096 + 32 - 1;
    const f = await fixture(true, capacity);
    const input = request(f.model.id);
    const before = structuredClone(input);
    let admissionFailure: unknown;
    const admission = vi.fn(
      (
        final: Parameters<typeof admitModelRequest>[0] & { codexTurnState?: string | undefined }
      ) => {
        expect(final.contextWindowTokens).toBe(capacity);
        expect(final.outputReserveTokens).toBe(32);
        expect(final.payload).toMatchObject({
          input: input.input,
          instructions: input.instructions,
        });
        try {
          admitModelRequest({ ...final, continuity: final.codexTurnState });
        } catch (error) {
          admissionFailure = error;
          throw error;
        }
      }
    );
    await expect(
      f.client.createResponses(f.provider, input, undefined, {
        finalRequestAdmission: admission,
      })
    ).rejects.toThrow();
    expect(admission).toHaveBeenCalledOnce();
    expect(admissionFailure).toMatchObject({ code: 'internal_agent_context_exceeded' });
    expect(f.bodies).toEqual([]);
    expect(input).toEqual(before);
  });
}
registerPiAiImageInputTests();
