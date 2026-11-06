import { zstdDecompressSync } from 'node:zlib';
import {
  type CredentialStore,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  getCurrentTools,
  type OAuthCredential,
  type TranscriptContext,
} from '@earendil-works/pi-ai';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ResolvedLLMProviderConfig } from '../providers/llm-config.js';
import { GatewayUnsupportedFeatureError, PiAiGatewayClient } from './pi-ai-client.js';

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
