import { zstdDecompressSync } from 'node:zlib';
import {
  type AssistantMessageEvent,
  createAssistantMessageEventStream,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
} from '@earendil-works/pi-ai';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { deepseekProvider } from '@earendil-works/pi-ai/providers/deepseek';
import { googleProvider } from '@earendil-works/pi-ai/providers/google';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { xaiProvider } from '@earendil-works/pi-ai/providers/xai';
import { describe, expect, it, vi } from 'vitest';
import type { ResolvedLLMProviderConfig } from '../providers/llm-config.js';
import type { OpenAICompatibleResponsesResponse } from './openai-compatible-client.js';
import { PiAiGatewayClient } from './pi-ai-client.js';
import { LLMGatewayProviderDispatcher } from './provider-dispatcher.js';

/** Creates an explicitly admitted member with an independent stock API identity. */
function setup(api = 'openai-completions') {
  const faux = fauxProvider({
    api,
    provider: 'independent',
    models: [{ id: 'physical', reasoning: true }],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  const provider = {
    id: 'profile',
    adapterId: 'independent',
    apiKey: 'explicit',
    baseUrl: null,
    models: ['physical'],
    requiresApiKey: true,
    gatewayCapabilities: {
      chatCompletions: api === 'openai-completions' ? 'native' : 'bridged',
      responses: api === 'openai-completions' ? 'bridged' : 'native',
    },
  } as ResolvedLLMProviderConfig;
  const client = new PiAiGatewayClient({ models });
  return { faux, models, provider, client };
}

/** Reads the JSON data frames from one public SSE projection. */
async function frames(stream: ReadableStream<Uint8Array>) {
  return (await new Response(stream).text())
    .split('\n')
    .filter((line) => line.startsWith('data: {'))
    .map((line) => JSON.parse(line.slice(6)));
}

it.each([
  { api: 'openai-codex-responses', factory: openaiCodexProvider },
  { api: 'openai-responses', factory: openaiProvider },
  { api: 'anthropic-messages', factory: anthropicProvider },
  { api: 'openai-completions', factory: deepseekProvider },
])('preserves caller controls in decoded stock wire for $api', async ({ factory }) => {
  const stock = factory();
  const models = createModels();
  models.setProvider(stock);
  const model = models.getModels().find((model) => model.provider === stock.id);
  expect(model).toBeDefined();
  const credential =
    stock.id === 'openai-codex'
      ? `synthetic.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture' } })).toString('base64url')}.synthetic`
      : 'sk-synthetic';
  const provider = {
    id: 'stock-profile',
    adapterId: stock.id,
    apiKey: credential,
    baseUrl: null,
    models: [model!.id],
    requiresApiKey: true,
    gatewayCapabilities: {
      chatCompletions: model!.api === 'anthropic-messages' ? 'native' : 'bridged',
      responses: model!.api === 'anthropic-messages' ? 'bridged' : 'native',
    },
  } as ResolvedLLMProviderConfig;
  const payloads: Record<string, unknown>[] = [];
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const compressed = new Headers(init?.headers).get('content-encoding') === 'zstd';
    const body = compressed
      ? zstdDecompressSync(init?.body as Uint8Array).toString()
      : String(init?.body);
    payloads.push(JSON.parse(body));
    const events =
      model!.api === 'anthropic-messages'
        ? [
            {
              type: 'message_start',
              message: {
                id: 'msg_fixture',
                type: 'message',
                role: 'assistant',
                content: [],
                model: model!.id,
                usage: { input_tokens: 1, output_tokens: 0 },
              },
            },
            {
              type: 'message_delta',
              delta: { stop_reason: 'end_turn' },
              usage: { output_tokens: 1 },
            },
            { type: 'message_stop' },
          ]
        : model!.api === 'openai-completions'
          ? [
              {
                id: 'chat_fixture',
                object: 'chat.completion.chunk',
                created: 1,
                model: model!.id,
                choices: [
                  {
                    index: 0,
                    delta: { role: 'assistant', content: 'answer' },
                    finish_reason: 'stop',
                  },
                ],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
              },
            ]
          : [
              {
                type: 'response.completed',
                response: {
                  id: 'resp_fixture',
                  status: 'completed',
                  output: [],
                  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
                },
              },
            ];
    return new Response(
      events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
      { headers: { 'content-type': 'text/event-stream' } }
    );
  });
  try {
    const client = new PiAiGatewayClient({ models });
    for (const stream of [false, true]) {
      for (const parallel of [false, true, undefined]) {
        const controls = parallel === undefined ? {} : { parallel_tool_calls: parallel };
        const chat = {
          model: model!.id,
          messages: [{ role: 'user' as const, content: 'hello' }],
          max_completion_tokens: 137,
          tools: [
            {
              type: 'function',
              function: { name: 'lookup', parameters: { type: 'object', properties: {} } },
            },
          ],
          tool_choice: { type: 'function', function: { name: 'lookup' } },
          ...controls,
          stream,
        };
        const responses = {
          model: model!.id,
          input: 'hello',
          max_output_tokens: 137,
          tools: [
            { type: 'function', name: 'lookup', parameters: { type: 'object', properties: {} } },
          ],
          tool_choice: { type: 'function', name: 'lookup' },
          ...controls,
          stream,
        };
        if (stream) {
          await frames(await client.createChatCompletionStream(provider, chat));
          await frames(await client.createResponsesStream(provider, responses));
        } else {
          await client.createChatCompletion(provider, chat);
          await client.createResponses(provider, responses);
        }
        for (const payload of payloads.slice(-2)) {
          if (model!.api === 'anthropic-messages') {
            expect(payload.tool_choice).toMatchObject({ type: 'tool', name: 'lookup' });
            expect({
              cap: payload.max_tokens,
              parallel: (payload.tool_choice as Record<string, unknown> | undefined)
                ?.disable_parallel_tool_use,
            }).toEqual({ cap: 137, parallel: parallel === undefined ? undefined : !parallel });
          } else if (model!.api === 'openai-completions') {
            expect(payload.tool_choice).toEqual({ type: 'function', function: { name: 'lookup' } });
            expect({
              cap: payload.max_tokens ?? payload.max_completion_tokens,
              parallel: payload.parallel_tool_calls,
            }).toEqual({ cap: 137, parallel });
          } else {
            expect(payload.tool_choice).toEqual({ type: 'function', name: 'lookup' });
            expect({
              cap: payload.max_output_tokens,
              parallel: payload.parallel_tool_calls,
            }).toEqual({
              cap: 137,
              parallel: parallel ?? (model!.api === 'openai-codex-responses' ? true : undefined),
            });
          }
        }
      }
    }
    expect(payloads).toHaveLength(12);
  } finally {
    fetchMock.mockRestore();
  }
});

it.each(
  ['chat', 'responses'].flatMap((format) =>
    [false, true].flatMap((stream) =>
      [undefined, true, false].map((parallel) => ({ format, stream, parallel }))
    )
  )
)('completes stock Google $format with stream=$stream and parallel=$parallel', async ({
  format,
  stream,
  parallel,
}) => {
  const stock = googleProvider();
  const models = createModels();
  models.setProvider(stock);
  const model = models
    .getModels()
    .find((model) => model.provider === stock.id && model.id === 'gemini-2.5-flash')!;
  expect(model.api).toBe('google-generative-ai');
  const provider = {
    id: 'google-profile',
    adapterId: stock.id,
    apiKey: 'synthetic',
    baseUrl: null,
    models: [model.id],
    requiresApiKey: true,
    gatewayCapabilities: { chatCompletions: 'native', responses: 'bridged' },
  } as ResolvedLLMProviderConfig;
  const client = new PiAiGatewayClient({ models });
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(
    async () =>
      new Response(
        `data: ${JSON.stringify({
          candidates: [
            { content: { role: 'model', parts: [{ text: 'answer' }] }, finishReason: 'STOP' },
          ],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
        })}\n\n`,
        { headers: { 'content-type': 'text/event-stream' } }
      )
  );
  try {
    const controls = parallel === undefined ? {} : { parallel_tool_calls: parallel };
    const chat = {
      model: model.id,
      messages: [{ role: 'user' as const, content: 'hello' }],
      ...controls,
      stream,
    };
    const responses = { model: model.id, input: 'hello', ...controls, stream };
    const operation =
      format === 'chat'
        ? stream
          ? frames(await client.createChatCompletionStream(provider, chat))
          : client.createChatCompletion(provider, chat)
        : stream
          ? frames(await client.createResponsesStream(provider, responses))
          : client.createResponses(provider, responses);
    const result = await operation;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    if (stream) {
      const events = result as Awaited<ReturnType<typeof frames>>;
      if (format === 'chat') {
        expect(events.map((event) => event.choices?.[0]?.delta?.content ?? '').join('')).toBe(
          'answer'
        );
        expect(events.at(-1)?.choices[0].finish_reason).toBe('stop');
      } else {
        expect(events.at(-1)).toMatchObject({
          type: 'response.completed',
          response: {
            status: 'completed',
            output: [{ type: 'message', content: [{ type: 'output_text', text: 'answer' }] }],
          },
        });
      }
    } else if (format === 'chat') {
      expect(result).toMatchObject({
        choices: [{ finish_reason: 'stop', message: { content: 'answer' } }],
      });
    } else {
      expect(result).toMatchObject({
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'answer' }] }],
      });
    }
  } catch (error) {
    throw new Error(`Stock Google request failed after ${fetchMock.mock.calls.length} fetches.`, {
      cause: error,
    });
  } finally {
    fetchMock.mockRestore();
  }
});

describe('Gateway stock IR convergence', () => {
  it.each([
    'openai-completions',
    'openai-responses',
  ])('replays the actual streamed Responses text item as ordinary history on %s', async (api) => {
    const { faux, client, provider } = setup(api);
    faux.setResponses([fauxAssistantMessage('answer'), fauxAssistantMessage('continued')]);
    const output = await frames(
      await client.createResponsesStream(provider, {
        model: 'physical',
        input: 'hello',
        stream: true,
      })
    );
    const item = output.find((event) => event.type === 'response.output_item.done')?.item;
    expect(item.content).toEqual([
      { type: 'output_text', text: 'answer', annotations: [], logprobs: [] },
    ]);
    const continuation = await client.createResponses(provider, {
      model: 'physical',
      input: [item, { role: 'user', content: 'continue' }],
    });
    expect(continuation.output).toContainEqual(expect.objectContaining({ type: 'message' }));
    expect(faux.state.callCount).toBe(2);
  });

  it.each([
    { annotations: [{ type: 'url_citation', url: 'https://example.invalid' }] },
    { logprobs: [{ token: 'answer', logprob: -1 }] },
    { annotations: null },
    { logprobs: {} },
    { unsupported: [] },
  ])('refuses unsupported text history metadata %j before effect', async (metadata) => {
    const { faux, client, provider } = setup();
    await expect(
      client.createResponses(provider, {
        model: 'physical',
        input: [
          { role: 'assistant', content: [{ type: 'output_text', text: 'answer', ...metadata }] },
        ],
      })
    ).rejects.toMatchObject({ code: 'unsupported_gateway_feature' });
    expect(faux.state.callCount).toBe(0);
  });

  it.each([
    'openai-completions',
    'openai-responses',
  ])('maps Chat thinking once and projects readable thinking on %s', async (api) => {
    const { faux, client, provider } = setup(api);
    faux.setResponses([
      (context) => {
        expect(context.messages.find((message) => message.role === 'assistant')?.content).toEqual([
          expect.objectContaining({ type: 'thinking', thinking: 'earlier reasoning' }),
          { type: 'text', text: 'earlier answer' },
        ]);
        return fauxAssistantMessage([
          fauxThinking('visible'),
          { type: 'thinking', thinking: 'hidden', redacted: true },
          fauxText('answer'),
        ]);
      },
    ]);
    const dispatcher = new LLMGatewayProviderDispatcher({ piAiClient: client });
    const response = await dispatcher.createChatCompletion(provider, {
      model: 'physical',
      messages: [
        { role: 'assistant', content: 'earlier answer', reasoning_content: 'earlier reasoning' },
      ],
    });
    expect(response.choices[0]?.message).toMatchObject({
      content: 'answer',
      reasoning_content: 'visible',
    });
    expect(faux.state.callCount).toBe(1);
  });

  it.each([
    false,
    true,
  ])('projects plain Responses thinking, exact calls and length directly; stream=%s', async (stream) => {
    const { faux, client, provider } = setup();
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxThinking('reason'),
          fauxText('answer'),
          fauxToolCall('lookup', { path: 'README.md' }, { id: 'call_public|fc_native' }),
        ],
        { stopReason: 'length' }
      ),
    ]);
    const request = {
      model: 'physical',
      input: 'hello',
      stream,
      tools: [
        {
          type: 'function',
          name: 'lookup',
          parameters: { type: 'object', properties: { path: { type: 'string' } } },
        },
      ],
    };
    const response = stream
      ? (await frames(await client.createResponsesStream(provider, request))).find(
          (event) => event.response?.status === 'incomplete'
        )?.response
      : await client.createResponses(provider, request);
    expect(response).toMatchObject({
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
    });
    expect(response.output).toEqual([
      expect.objectContaining({
        type: 'reasoning',
        summary: [{ type: 'summary_text', text: 'reason' }],
      }),
      expect.objectContaining({
        type: 'message',
        content: [{ type: 'output_text', text: 'answer' }],
      }),
      expect.objectContaining({
        type: 'function_call',
        call_id: 'call_public',
        id: 'fc_native',
        name: 'lookup',
        arguments: '{"path":"README.md"}',
      }),
    ]);
  });

  it('reconciles terminal-only and completed Chat thinking without duplicate deltas or redacted text', async () => {
    const { faux, client, provider } = setup();
    const message = fauxAssistantMessage([
      fauxThinking('complete'),
      fauxThinking('terminal'),
      { type: 'thinking', thinking: 'secret', redacted: true },
    ]);
    const events = createAssistantMessageEventStream();
    const sequence: AssistantMessageEvent[] = [
      { type: 'start', partial: message },
      { type: 'thinking_delta', contentIndex: 0, delta: 'com', partial: message },
      { type: 'thinking_end', contentIndex: 0, content: 'complete', partial: message },
      { type: 'thinking_delta', contentIndex: 2, delta: 'secret', partial: message },
      { type: 'done', reason: 'stop', message },
    ];
    for (const event of sequence) events.push(event);
    events.end(message);
    Object.assign(faux.provider, { stream: () => events });
    const output = await frames(
      await client.createChatCompletionStream(provider, {
        model: 'physical',
        messages: [],
        stream: true,
      })
    );
    expect(output.map((event) => event.choices[0]?.delta.reasoning_content ?? '').join('')).toBe(
      'completeterminal'
    );
  });

  it.each([
    { name: 'no thinking', parts: [], completed: [], conflict: false },
    {
      name: 'one summary part',
      parts: ['first paragraph'],
      completed: ['first paragraph'],
      conflict: false,
    },
    {
      name: 'multiple summary parts',
      parts: ['first paragraph', 'second paragraph'],
      completed: ['first paragraph', 'second paragraph'],
      conflict: false,
    },
    {
      name: 'genuine whitespace',
      parts: ['  first\t paragraph', 'second paragraph \t\n'],
      completed: ['  first\t paragraph', 'second paragraph \t\n'],
      conflict: false,
    },
    {
      name: 'substantive conflict',
      parts: ['published reasoning'],
      completed: ['different reasoning'],
      conflict: true,
    },
    {
      name: 'removed substantive suffix',
      parts: ['published reasoning'],
      completed: ['published'],
      conflict: true,
    },
  ])('reconciles stock Responses summary completion in Chat: $name', async ({
    parts,
    completed,
    conflict,
  }) => {
    const models = createModels();
    models.setProvider(xaiProvider());
    const model = models.getModel('xai', 'grok-4.7');
    expect(model?.api).toBe('openai-responses');
    const provider = {
      id: 'stock-profile',
      adapterId: 'xai',
      apiKey: 'synthetic',
      baseUrl: null,
      models: ['grok-4.7'],
      requiresApiKey: true,
      gatewayCapabilities: { chatCompletions: 'bridged', responses: 'native' },
    } as ResolvedLLMProviderConfig;
    const reasoning = {
      type: 'reasoning',
      id: 'rs_fixture',
      summary: completed.map((text) => ({ type: 'summary_text', text })),
    };
    const reply = 'exact assistant reply';
    const text = {
      type: 'message',
      id: 'msg_fixture',
      role: 'assistant',
      content: [{ type: 'output_text', text: reply, annotations: [] }],
    };
    const events: Record<string, unknown>[] = [
      { type: 'response.created', response: { id: 'resp_fixture' } },
    ];
    if (parts.length) {
      events.push({
        type: 'response.output_item.added',
        output_index: 0,
        item: { ...reasoning, summary: [] },
      });
      for (const [summaryIndex, part] of parts.entries()) {
        // Split the final character so the whitespace case ends with a whitespace-only delta.
        for (const delta of [part.slice(0, -1), part.slice(-1)]) {
          events.push({
            type: 'response.reasoning_summary_text.delta',
            output_index: 0,
            summary_index: summaryIndex,
            delta,
          });
        }
        events.push({
          type: 'response.reasoning_summary_part.done',
          output_index: 0,
          summary_index: summaryIndex,
          part: { type: 'summary_text', text: part },
        });
      }
      events.push({ type: 'response.output_item.done', output_index: 0, item: reasoning });
    }
    const textIndex = parts.length ? 1 : 0;
    events.push(
      {
        type: 'response.output_item.added',
        output_index: textIndex,
        item: { ...text, content: [] },
      },
      {
        type: 'response.output_text.delta',
        output_index: textIndex,
        content_index: 0,
        delta: reply,
      },
      { type: 'response.output_item.done', output_index: textIndex, item: text },
      {
        type: 'response.completed',
        response: {
          id: 'resp_fixture',
          status: 'completed',
          output: parts.length ? [reasoning, text] : [text],
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        },
      }
    );
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(
          events
            .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
            .join(''),
          { headers: { 'content-type': 'text/event-stream' } }
        )
      );
    try {
      const client = new PiAiGatewayClient({ models });
      const usage = vi.fn();
      const stream = await client.createChatCompletionStream(
        provider,
        {
          model: 'grok-4.7',
          messages: [{ role: 'user', content: 'hello' }],
          stream: true,
        },
        usage
      );
      const result = new Response(stream).text();
      if (conflict) {
        await expect(result).rejects.toMatchObject({
          code: 'unsupported_gateway_feature',
          feature: 'pi-ai Chat conflicting reasoning completion',
        });
        expect(usage).not.toHaveBeenCalled();
        return;
      }
      const wire = await result;
      expect(wire.match(/data: \[DONE\]/g)).toHaveLength(1);
      const output = wire
        .split('\n')
        .filter((line) => line.startsWith('data: {'))
        .map((line) => JSON.parse(line.slice(6)));
      expect(output.map((event) => event.choices[0]?.delta.reasoning_content ?? '').join('')).toBe(
        completed.join('\n\n')
      );
      expect(output.map((event) => event.choices[0]?.delta.content ?? '').join('')).toBe(reply);
      expect(output.filter((event) => event.usage)).toHaveLength(1);
      expect(output.at(-1)).toMatchObject({
        choices: [{ finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
      expect(usage).toHaveBeenCalledTimes(1);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('delivers held Chat thinking and cancellation before blocked stock iterator cleanup settles', async () => {
    const { models, client, provider } = setup();
    const events = createAssistantMessageEventStream();
    const iterator = events[Symbol.asyncIterator]();
    const stockNext = iterator.next.bind(iterator);
    const prefetched = Promise.withResolvers<void>();
    let pending = false;
    const next = vi.spyOn(iterator, 'next').mockImplementation((...args) => {
      const result = stockNext(...args);
      if (next.mock.calls.length === 3) {
        pending = true;
        void result.then(() => {
          pending = false;
        });
        prefetched.resolve();
      }
      return result;
    });
    const cleanup = vi.spyOn(iterator, 'return');
    vi.spyOn(events, Symbol.asyncIterator).mockReturnValue(iterator);
    vi.spyOn(models, 'stream').mockReturnValue(events);
    const message = fauxAssistantMessage([fauxThinking('first \t')]);
    events.push({ type: 'start', partial: message });
    events.push({ type: 'thinking_delta', contentIndex: 0, delta: 'first \t', partial: message });
    const caller = new AbortController();
    const reason = new Error('caller cancelled while the stock iterator is blocked');
    const reader = (
      await client.createChatCompletionStream(
        provider,
        { model: 'physical', messages: [], stream: true },
        undefined,
        { signal: caller.signal }
      )
    ).getReader();
    const decoder = new TextDecoder();
    let wire = '';
    /** Reads one content chunk without releasing the blocked upstream fixture. */
    const readDelta = async () => {
      const result = await reader.read();
      expect(result.done).toBe(false);
      const chunk = decoder.decode(result.value);
      wire += chunk;
      return JSON.parse(
        chunk
          .split('\n')
          .find((line) => line.startsWith('data: {'))!
          .slice(6)
      ).choices[0].delta;
    };
    try {
      expect(await readDelta()).toEqual({ role: 'assistant' });
      expect(await readDelta()).toEqual({ reasoning_content: 'first' });
      await prefetched.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(pending).toBe(true);
      caller.abort(reason);
      const suffix = readDelta();
      const stillPending = Symbol('still pending at the next event-loop turn');
      expect(
        await Promise.race([
          suffix,
          new Promise((resolve) => setImmediate(() => resolve(stillPending))),
        ])
      ).toEqual({ reasoning_content: ' \t' });
      const failure = reader.read().then(
        (result) => result,
        (error) => error
      );
      expect(
        await Promise.race([
          failure,
          new Promise((resolve) => setImmediate(() => resolve(stillPending))),
        ])
      ).toBe(reason);
      expect(pending).toBe(true);
      expect(cleanup).toHaveBeenCalledTimes(1);
      expect(wire).not.toContain('[DONE]');
    } finally {
      events.end();
      await cleanup.mock.results[0]?.value;
    }
  });

  it.each([
    'terminal-error',
    'thrown-error',
  ])('preserves queued Chat thinking and the original %s when iterator cleanup rejects', async (ending) => {
    const { models, client, provider } = setup();
    const events = createAssistantMessageEventStream();
    const iterator = events[Symbol.asyncIterator]();
    const cleanup = vi.spyOn(iterator, 'return').mockRejectedValue(new Error('cleanup failed'));
    vi.spyOn(events, Symbol.asyncIterator).mockReturnValue(iterator);
    vi.spyOn(models, 'stream').mockReturnValue(events);
    const message = fauxAssistantMessage([fauxThinking('first \t')]);
    const reason = new Error('original provider failure');
    events.push({ type: 'start', partial: message });
    events.push({ type: 'thinking_delta', contentIndex: 0, delta: 'first \t', partial: message });
    if (ending === 'terminal-error') {
      events.push({
        type: 'error',
        reason: 'error',
        error: { ...message, stopReason: 'error', errorMessage: reason.message },
      });
    } else {
      const stockNext = iterator.next.bind(iterator);
      vi.spyOn(iterator, 'next')
        .mockImplementationOnce(stockNext)
        .mockImplementationOnce(stockNext)
        .mockRejectedValueOnce(reason);
    }
    const reader = (
      await client.createChatCompletionStream(provider, {
        model: 'physical',
        messages: [],
        stream: true,
      })
    ).getReader();
    let wire = '';
    let failure: unknown;
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        wire += new TextDecoder().decode(result.value);
      }
    } catch (error) {
      failure = error;
    } finally {
      events.end();
    }
    if (ending === 'thrown-error') expect(failure).toBe(reason);
    else expect(failure).toMatchObject({ message: reason.message });
    const reasoning = wire
      .split('\n')
      .filter((line) => line.startsWith('data: {'))
      .map((line) => JSON.parse(line.slice(6)).choices[0]?.delta.reasoning_content)
      .filter((text) => text !== undefined);
    expect(reasoning).toEqual(['first', ' \t']);
    expect(wire).not.toContain('[DONE]');
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it.each([
    'text',
    'tool',
    'two-thinking',
    'eof',
    'resumed-thinking',
  ])('drains held Chat thinking whitespace at the stock Responses boundary: %s', async (boundary) => {
    const models = createModels();
    models.setProvider(xaiProvider());
    expect(models.getModel('xai', 'grok-4.7')?.api).toBe('openai-responses');
    const provider = {
      id: 'stock-profile',
      adapterId: 'xai',
      apiKey: 'synthetic',
      baseUrl: null,
      models: ['grok-4.7'],
      requiresApiKey: true,
      gatewayCapabilities: { chatCompletions: 'bridged', responses: 'native' },
    } as ResolvedLLMProviderConfig;
    const first = {
      type: 'reasoning',
      id: 'rs_first',
      summary: [
        { type: 'summary_text', text: boundary === 'resumed-thinking' ? 'first \t\n' : 'first \t' },
      ],
    };
    const second = {
      type: 'reasoning',
      id: 'rs_second',
      summary: [{ type: 'summary_text', text: 'second ' }],
    };
    const answer = {
      type: 'message',
      id: 'msg_answer',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'answer', annotations: [] }],
    };
    const call = {
      type: 'function_call',
      id: 'fc_1',
      call_id: 'call_1',
      name: 'lookup',
      arguments: '{}',
    };
    // No summary-part-done event: the pending suffix is genuine observed content.
    const events: Record<string, unknown>[] = [
      { type: 'response.created', response: { id: 'resp_boundary' } },
      { type: 'response.output_item.added', output_index: 0, item: { ...first, summary: [] } },
      {
        type: 'response.reasoning_summary_text.delta',
        output_index: 0,
        summary_index: 0,
        delta: 'first \t',
      },
    ];
    const output: Record<string, unknown>[] = [first];
    if (boundary === 'text' || boundary === 'resumed-thinking') {
      events.push(
        { type: 'response.output_item.added', output_index: 1, item: { ...answer, content: [] } },
        {
          type: 'response.output_text.delta',
          output_index: 1,
          content_index: 0,
          delta: 'answer',
        },
        { type: 'response.output_item.done', output_index: 1, item: answer }
      );
      output.push(answer);
      if (boundary === 'resumed-thinking')
        events.push({
          type: 'response.reasoning_summary_text.delta',
          output_index: 0,
          summary_index: 0,
          delta: '\n',
        });
    } else if (boundary === 'tool') {
      events.push(
        { type: 'response.output_item.added', output_index: 1, item: { ...call, arguments: '' } },
        { type: 'response.output_item.done', output_index: 1, item: call }
      );
      output.push(call);
    } else if (boundary === 'two-thinking') {
      events.push(
        { type: 'response.output_item.added', output_index: 1, item: { ...second, summary: [] } },
        {
          type: 'response.reasoning_summary_text.delta',
          output_index: 1,
          summary_index: 0,
          delta: 'second ',
        }
      );
      output.push(second);
    }
    if (boundary !== 'eof') {
      events.push({ type: 'response.output_item.done', output_index: 0, item: first });
      if (boundary === 'two-thinking')
        events.push({ type: 'response.output_item.done', output_index: 1, item: second });
      events.push({
        type: 'response.completed',
        response: {
          id: 'resp_boundary',
          status: 'completed',
          output,
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        },
      });
    }
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(
          events
            .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
            .join(''),
          { headers: { 'content-type': 'text/event-stream' } }
        )
      );
    try {
      const client = new PiAiGatewayClient({ models });
      const reader = (
        await client.createChatCompletionStream(provider, {
          model: 'grok-4.7',
          messages: [],
          stream: true,
          tools: [
            {
              type: 'function',
              function: { name: 'lookup', parameters: { type: 'object', properties: {} } },
            },
          ],
        })
      ).getReader();
      let wire = '';
      let failure: unknown;
      try {
        while (true) {
          const result = await reader.read();
          if (result.done) break;
          wire += new TextDecoder().decode(result.value);
        }
      } catch (error) {
        failure = error;
      }
      if (boundary === 'eof') {
        expect(failure).toMatchObject({
          message: 'OpenAI Responses stream ended before a terminal response event',
        });
        expect(wire).not.toContain('[DONE]');
      } else {
        expect(failure).toBeUndefined();
        expect(wire.match(/data: \[DONE\]/g)).toHaveLength(1);
      }
      const deltas = wire
        .split('\n')
        .filter((line) => line.startsWith('data: {'))
        .map((line) => JSON.parse(line.slice(6)).choices[0]?.delta)
        .filter((delta) => delta && Object.keys(delta).length && !delta.role);
      const expected = [{ reasoning_content: 'first' }, { reasoning_content: ' \t' }];
      if (boundary === 'resumed-thinking') {
        expect(deltas).toEqual([...expected, { content: 'answer' }, { reasoning_content: '\n' }]);
      } else if (boundary === 'text') {
        expect(deltas).toEqual([...expected, { content: 'answer' }]);
      } else if (boundary === 'tool') {
        expect(deltas).toEqual([
          ...expected,
          {
            tool_calls: [
              {
                index: 0,
                id: 'call_1',
                type: 'function',
                function: { name: 'lookup', arguments: '' },
              },
            ],
          },
          { tool_calls: [{ index: 0, function: { arguments: '{}' } }] },
        ]);
      } else if (boundary === 'two-thinking') {
        expect(deltas).toEqual([
          ...expected,
          { reasoning_content: 'second' },
          { reasoning_content: ' ' },
        ]);
      } else {
        expect(deltas).toEqual(expected);
      }
      expect(deltas.map((delta) => delta.reasoning_content ?? '').join('')).toBe(
        boundary === 'two-thinking'
          ? 'first \tsecond '
          : boundary === 'resumed-thinking'
            ? 'first \t\n'
            : 'first \t'
      );
    } finally {
      fetchMock.mockRestore();
    }
  });

  it.each([
    false,
    true,
  ])('admits native local tools by exact API without a subscription name; stream=%s', async (stream) => {
    const { faux, client, provider } = setup('openai-responses');
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('exec', { input: 'pwd' }, { id: 'call_exec|ctc_exec' })], {
        stopReason: 'toolUse',
      }),
    ]);
    const request = {
      model: 'physical',
      input: [
        {
          type: 'additional_tools',
          role: 'developer',
          tools: [{ type: 'custom', name: 'exec', format: { type: 'text' } }],
        },
        { role: 'user', content: 'hello' },
      ],
      stream,
    };
    const response = stream
      ? (await frames(await client.createResponsesStream(provider, request))).find(
          (event) => event.type === 'response.completed'
        )?.response
      : await client.createResponses(provider, request);
    expect(response.output[0]).toMatchObject({
      type: 'custom_tool_call',
      id: 'ctc_exec',
      call_id: 'call_exec',
      input: 'pwd',
    });
  });

  it.each([
    false,
    true,
  ])('rejects unrepresented native controls on another protocol before effect; stream=%s', async (stream) => {
    const { faux, client, provider } = setup();
    const request = {
      model: 'physical',
      input: 'hello',
      reasoning: { context: 'all_turns' },
      stream,
    };
    await expect(
      stream
        ? client.createResponsesStream(provider, request)
        : client.createResponses(provider, request)
    ).rejects.toMatchObject({ code: 'unsupported_gateway_feature' });
    expect(faux.state.callCount).toBe(0);
  });

  it('keeps the Chat dispatcher on its exact public mapping seam', async () => {
    const { provider } = setup('openai-responses');
    const chat = vi.fn(async () => ({ choices: [] }));
    const responses = vi.fn();
    const dispatcher = new LLMGatewayProviderDispatcher({
      piAiClient: {
        createChatCompletion: chat,
        createResponses: responses,
      } as unknown as PiAiGatewayClient,
    });
    await dispatcher.createChatCompletion(provider, {
      model: 'physical',
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(chat).toHaveBeenCalledOnce();
    expect(responses).not.toHaveBeenCalled();
  });
});

it.each([
  false,
  true,
])('rejects duplicate public tool identities in the direct Chat projection; stream=%s', async (stream) => {
  const { faux, client, provider } = setup();
  faux.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall('one', {}, { id: 'call_duplicate|fc_first' }),
        fauxToolCall('two', {}, { id: 'call_duplicate|fc_second' }),
      ],
      { stopReason: 'toolUse' }
    ),
  ]);
  const request = { model: 'physical', messages: [], stream };
  await expect(
    stream
      ? client.createChatCompletionStream(provider, request).then(frames)
      : client.createChatCompletion(provider, request)
  ).rejects.toMatchObject({ code: 'unsupported_gateway_feature' });
});

it.each([
  false,
  true,
])('preserves terminal-only native reasoning through the stock Responses parser; stream=%s', async (stream) => {
  const item = {
    id: 'rs_terminal_producer',
    type: 'reasoning',
    summary: [{ type: 'summary_text', text: 'terminal summary' }],
    content: null,
    encrypted_content: 'sealed-terminal',
    status: 'completed',
  };
  const payloads: Record<string, unknown>[] = [];
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    payloads.push(JSON.parse(String(init?.body)));
    const events = [
      {
        type: 'response.created',
        response: { id: 'resp_terminal', output: [], status: 'in_progress' },
      },
      {
        type: 'response.completed',
        response: {
          id: 'resp_terminal',
          output: [item],
          status: 'completed',
          usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
        },
      },
    ];
    return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
      headers: { 'content-type': 'text/event-stream' },
    });
  });
  try {
    const provider = {
      id: 'independent-native',
      adapterId: 'independent-native',
      apiKey: 'explicit',
      baseUrl: 'https://provider.invalid/v1',
      models: ['physical'],
      requiresApiKey: true,
      gatewayCapabilities: { chatCompletions: 'bridged', responses: 'native' },
      modelMetadata: { physical: { limit: { context: 32000 }, reasoning: true } },
    } as unknown as ResolvedLLMProviderConfig;
    const client = new PiAiGatewayClient();
    const request = { model: 'physical', input: 'hello', stream };
    const result = stream
      ? (await frames(await client.createResponsesStream(provider, request))).find(
          (event) => event.type === 'response.completed'
        )?.response
      : await client.createResponses(provider, request);
    expect(result.output).toEqual([item]);
    expect(payloads).toHaveLength(1);
  } finally {
    fetchMock.mockRestore();
  }
});

it.each([
  false,
  true,
])('preserves exact Chat history call identity and tool names; stream=%s', async (stream) => {
  const { faux, client, provider } = setup('openai-responses');
  faux.setResponses([
    (context) => {
      const results = context.messages.filter((message) => message.role === 'toolResult');
      expect(results).toMatchObject([
        { toolCallId: 'call_second', toolName: 'second' },
        { toolCallId: 'call_first', toolName: 'first' },
      ]);
      return fauxAssistantMessage('done');
    },
  ]);
  const request = {
    model: 'physical',
    stream,
    messages: [
      {
        role: 'assistant' as const,
        content: null,
        tool_calls: [
          { id: 'call_first', type: 'function', function: { name: 'first', arguments: '{}' } },
          {
            id: 'call_second',
            type: 'function',
            function: { name: 'second', arguments: '{"nested":{"n":2}}' },
          },
        ],
      },
      { role: 'tool' as const, content: 'second result', tool_call_id: 'call_second' },
      { role: 'tool' as const, content: 'first result', tool_call_id: 'call_first' },
    ],
  };
  if (stream) await frames(await client.createChatCompletionStream(provider, request));
  else await client.createChatCompletion(provider, request);
});

it.each([
  false,
  true,
])('rejects an unmatched Chat tool result before effect; stream=%s', async (stream) => {
  const { faux, client, provider } = setup('openai-responses');
  const request = {
    model: 'physical',
    stream,
    messages: [{ role: 'tool' as const, tool_call_id: 'call_unmatched', content: 'result' }],
  };
  await expect(
    stream
      ? client.createChatCompletionStream(provider, request)
      : client.createChatCompletion(provider, request)
  ).rejects.toMatchObject({ code: 'unsupported_gateway_feature' });
  expect(faux.state.callCount).toBe(0);
});

it.each([
  '{"nested":',
  '{ "nested": { "n": 2 } }',
])('reconciles partial or equivalent formatted Chat arguments once: %s', async (delta) => {
  const { faux, client, provider } = setup('openai-responses');
  const message = fauxAssistantMessage(
    [
      fauxText('terminal answer'),
      fauxToolCall('lookup', { nested: { n: 2 } }, { id: 'call_args|fc_args' }),
    ],
    { stopReason: 'toolUse' }
  );
  const events = createAssistantMessageEventStream();
  const toolCall = message.content[1];
  if (toolCall?.type !== 'toolCall') throw new Error('fixture');
  for (const event of [
    { type: 'start', partial: message },
    { type: 'text_end', contentIndex: 0, content: 'terminal answer', partial: message },
    { type: 'toolcall_start', contentIndex: 1, partial: message },
    { type: 'toolcall_delta', contentIndex: 1, delta, partial: message },
    { type: 'toolcall_end', contentIndex: 1, toolCall, partial: message },
    { type: 'done', reason: 'toolUse', message },
  ] as AssistantMessageEvent[])
    events.push(event);
  events.end(message);
  Object.assign(faux.provider, { stream: () => events });
  const output = await frames(
    await client.createChatCompletionStream(provider, {
      model: 'physical',
      messages: [],
      stream: true,
    })
  );
  expect(output.map((event) => event.choices[0]?.delta.content ?? '').join('')).toBe(
    'terminal answer'
  );
  expect(
    JSON.parse(
      output
        .flatMap((event) => event.choices[0]?.delta.tool_calls ?? [])
        .map((call) => call.function?.arguments ?? '')
        .join('')
    )
  ).toEqual({ nested: { n: 2 } });
});

it.each([
  false,
  true,
])('hands readable Chat reasoning to stock Responses as unsigned text; stream=%s', async (stream) => {
  const payloads: Record<string, unknown>[] = [];
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    payloads.push(JSON.parse(String(init?.body)));
    return new Response(
      'data: ' +
        JSON.stringify({
          type: 'response.completed',
          response: {
            id: 'resp_readable',
            status: 'completed',
            output: [],
            usage: { input_tokens: 2, output_tokens: 0, total_tokens: 2 },
          },
        }) +
        '\n\n',
      { headers: { 'content-type': 'text/event-stream' } }
    );
  });
  try {
    const provider = {
      id: 'readable-native',
      adapterId: 'readable-native',
      apiKey: 'explicit',
      baseUrl: 'https://provider.invalid/v1',
      models: ['physical'],
      requiresApiKey: true,
      gatewayCapabilities: { chatCompletions: 'bridged', responses: 'native' },
      modelMetadata: { physical: { limit: { context: 32000 }, reasoning: true } },
    } as unknown as ResolvedLLMProviderConfig;
    const client = new PiAiGatewayClient();
    const request = {
      model: 'physical',
      stream,
      messages: [
        {
          role: 'assistant' as const,
          reasoning_content: 'readable history',
          content: 'earlier answer',
        },
      ],
    };
    if (stream) await frames(await client.createChatCompletionStream(provider, request));
    else await client.createChatCompletion(provider, request);
    const input = payloads[0]?.input as Array<Record<string, unknown>>;
    expect(
      input
        .flatMap((item) => item.content as Array<{ text: string }>)
        .map((part) => part.text)
        .join(' ')
    ).toContain('readable history');
    expect(
      input
        .flatMap((item) => item.content as Array<{ text: string }>)
        .map((part) => part.text)
        .join(' ')
    ).toContain('earlier answer');
    expect(input.every((item) => item.type !== 'reasoning')).toBe(true);
  } finally {
    fetchMock.mockRestore();
  }
});

it.each([
  false,
  true,
])('rejects an unknown required Responses history field before effect; stream=%s', async (stream) => {
  const { faux, client, provider } = setup('openai-responses');
  const request = {
    model: 'physical',
    stream,
    input: [{ role: 'user', content: 'hello', required_native_control: true }],
  };
  await expect(
    stream
      ? client.createResponsesStream(provider, request)
      : client.createResponses(provider, request)
  ).rejects.toMatchObject({ code: 'unsupported_gateway_feature' });
  expect(faux.state.callCount).toBe(0);
});

it.each([
  false,
  true,
])('maps native assistant message id and phase through the stock signature; stream=%s', async (stream) => {
  const { faux, client, provider } = setup('openai-responses');
  faux.setResponses([
    (context) => {
      expect(context.messages.find((message) => message.role === 'assistant')?.content).toEqual([
        {
          type: 'text',
          text: 'earlier',
          textSignature: JSON.stringify({ v: 1, id: 'msg_prior_native', phase: 'commentary' }),
        },
      ]);
      return fauxAssistantMessage('answer');
    },
  ]);
  const request = {
    model: 'physical',
    stream,
    input: [
      {
        type: 'message',
        role: 'assistant',
        id: 'msg_prior_native',
        phase: 'commentary',
        content: [{ type: 'output_text', text: 'earlier' }],
      },
    ],
  };
  if (stream) await frames(await client.createResponsesStream(provider, request));
  else await client.createResponses(provider, request);
});

it.each([
  false,
  true,
])('rejects an unknown Chat request control before effect; stream=%s', async (stream) => {
  const { faux, client, provider } = setup('openai-responses');
  const request = { model: 'physical', stream, messages: [], previous_response_id: 'resp_foreign' };
  await expect(
    stream
      ? client.createChatCompletionStream(provider, request)
      : client.createChatCompletion(provider, request)
  ).rejects.toMatchObject({ code: 'unsupported_gateway_feature' });
  expect(faux.state.callCount).toBe(0);
});

it.each([
  false,
  true,
])('preserves admitted Chat caps, strict tools and simple choice in stock options; stream=%s', async (stream) => {
  const { faux, client, provider } = setup('openai-responses');
  faux.setResponses([
    (context, options) => {
      expect(context.messages.find((message) => message.role === 'system')).toMatchObject({
        toolsAdded: [
          { name: 'lookup', constrainedSampling: { type: 'json_schema', strict: 'require' } },
        ],
      });
      expect(options).toMatchObject({
        maxTokens: 32,
        toolChoice: { type: 'function', name: 'lookup' },
      });
      return fauxAssistantMessage('answer');
    },
  ]);
  const request = {
    model: 'physical',
    stream,
    messages: [],
    max_output_tokens: 32,
    max_tokens: 16,
    tools: [
      {
        type: 'function',
        function: { name: 'lookup', parameters: { type: 'object', properties: {} }, strict: true },
      },
    ],
    tool_choice: { type: 'function', function: { name: 'lookup' } },
  };
  if (stream) await frames(await client.createChatCompletionStream(provider, request));
  else await client.createChatCompletion(provider, request);
});

it.each([
  false,
  true,
])('rejects an unrepresentable Chat namespace and cancels upstream; stream=%s', async (stream) => {
  const { faux, client, provider } = setup('openai-responses');
  const message = fauxAssistantMessage(
    [{ ...fauxToolCall('lookup', {}, { id: 'call_ns|fc_ns' }), namespace: 'foreign' }],
    { stopReason: 'toolUse' }
  );
  const events = createAssistantMessageEventStream();
  events.push({ type: 'start', partial: message });
  events.push({ type: 'toolcall_start', contentIndex: 0, partial: message });
  events.push({
    type: 'toolcall_end',
    contentIndex: 0,
    partial: message,
    toolCall: message.content[0] as Extract<(typeof message.content)[number], { type: 'toolCall' }>,
  });
  events.push({ type: 'done', reason: 'toolUse', message });
  events.end(message);
  let providerSignal: AbortSignal | undefined;
  Object.assign(faux.provider, {
    stream: (_model: unknown, _context: unknown, options: { signal?: AbortSignal }) => {
      providerSignal = options.signal;
      return events;
    },
  });
  await expect(
    stream
      ? client
          .createChatCompletionStream(provider, { model: 'physical', messages: [], stream })
          .then(frames)
      : client.createChatCompletion(provider, { model: 'physical', messages: [] })
  ).rejects.toMatchObject({ code: 'unsupported_gateway_feature' });
  if (stream) expect(providerSignal?.aborted).toBe(true);
});

it.each([
  false,
  true,
])('preserves native reasoning summary boundaries and opaque identity; stream=%s', async (stream) => {
  const { faux, client, provider } = setup('openai-responses');
  const native = {
    type: 'reasoning',
    id: 'rs_producer_boundaries',
    summary: [
      { type: 'summary_text', text: 'first' },
      { type: 'summary_text', text: 'second' },
    ],
    content: null,
    encrypted_content: 'sealed-producer-boundaries',
  };
  const block = { ...fauxThinking('first\n\nsecond'), thinkingSignature: JSON.stringify(native) };
  const message = fauxAssistantMessage([block]);
  const events = createAssistantMessageEventStream();
  events.push({ type: 'start', partial: { ...message, content: [] } });
  events.push({ type: 'thinking_end', contentIndex: 0, content: block.thinking, partial: message });
  events.push({ type: 'done', reason: 'stop', message });
  events.end(message);
  Object.assign(faux.provider, { stream: () => events });
  const request = { model: 'physical', input: 'hello', stream };
  const output = stream
    ? await frames(await client.createResponsesStream(provider, request))
    : undefined;
  const response = stream
    ? output?.find((event) => event.type === 'response.completed')?.response
    : await client.createResponses(provider, request);
  expect(response.output).toEqual([{ ...native, status: 'completed' }]);
  if (stream)
    expect(
      output
        ?.filter((event) => event.type === 'response.reasoning_summary_text.done')
        .map((event) => [event.summary_index, event.text])
    ).toEqual([
      [0, 'first'],
      [1, 'second'],
    ]);
});

it.each([
  false,
  true,
])('does not project native reasoning state without admitted native capability; stream=%s', async (stream) => {
  const { faux, client, provider } = setup('openai-responses');
  const native = {
    type: 'reasoning',
    id: 'rs_unadmitted_producer',
    summary: [{ type: 'summary_text', text: 'readable only' }],
    encrypted_content: 'must-not-project',
  };
  faux.setResponses([
    fauxAssistantMessage([
      { ...fauxThinking('readable only'), thinkingSignature: JSON.stringify(native) },
    ]),
  ]);
  const request = { model: 'physical', input: 'hello', stream };
  const member = {
    ...provider,
    gatewayCapabilities: { chatCompletions: 'native' as const, responses: 'bridged' as const },
  };
  const response = stream
    ? (await frames(await client.createResponsesStream(member, request))).find(
        (event) => event.type === 'response.completed'
      )?.response
    : await client.createResponses(member, request);
  expect(response.output[0]).toMatchObject({
    type: 'reasoning',
    summary: [{ type: 'summary_text', text: 'readable only' }],
  });
  expect(response.output[0]).not.toHaveProperty('encrypted_content');
  expect(response.output[0].id).not.toBe(native.id);
});

it('rejects conflicting completed Chat arguments without replaying the upstream tool', async () => {
  const { faux, client, provider } = setup('openai-responses');
  const message = fauxAssistantMessage(
    [fauxToolCall('lookup', { nested: { n: 2 } }, { id: 'call_conflict|fc_conflict' })],
    { stopReason: 'toolUse' }
  );
  const toolCall = message.content[0];
  if (toolCall?.type !== 'toolCall') throw new Error('fixture');
  const events = createAssistantMessageEventStream();
  for (const event of [
    { type: 'start', partial: message },
    { type: 'toolcall_start', contentIndex: 0, partial: message },
    { type: 'toolcall_delta', contentIndex: 0, delta: '{"nested":{"n":1}}', partial: message },
    { type: 'toolcall_end', contentIndex: 0, toolCall, partial: message },
    { type: 'done', reason: 'toolUse', message },
  ] as AssistantMessageEvent[])
    events.push(event);
  events.end(message);
  let providerSignal: AbortSignal | undefined;
  Object.assign(faux.provider, {
    stream: (_model: unknown, _context: unknown, options: { signal?: AbortSignal }) => {
      providerSignal = options.signal;
      return events;
    },
  });
  await expect(
    client
      .createChatCompletionStream(provider, { model: 'physical', messages: [], stream: true })
      .then(frames)
  ).rejects.toMatchObject({ code: 'unsupported_gateway_feature' });
  expect(providerSignal?.aborted).toBe(true);
});

it('preserves native output absent from stock blocks before the following semantic item', async () => {
  const search = {
    type: 'tool_search_call',
    id: 'tsc_gap',
    call_id: 'call_gap',
    execution: 'client',
    arguments: { query: 'files' },
    status: 'completed',
  };
  const message = {
    type: 'message',
    id: 'msg_after_search',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'search requested' }],
    status: 'completed',
  };
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    const events = [
      {
        type: 'response.created',
        response: { id: 'resp_search_gap', status: 'in_progress', output: [] },
      },
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { ...search, status: 'in_progress' },
      },
      { type: 'response.output_item.done', output_index: 0, item: search },
      {
        type: 'response.output_item.added',
        output_index: 1,
        item: { ...message, content: [], status: 'in_progress' },
      },
      {
        type: 'response.output_text.delta',
        output_index: 1,
        content_index: 0,
        item_id: message.id,
        delta: 'search requested',
      },
      { type: 'response.output_item.done', output_index: 1, item: message },
      {
        type: 'response.completed',
        response: {
          id: 'resp_search_gap',
          output: [search, message],
          status: 'completed',
          usage: { input_tokens: 2, output_tokens: 2, total_tokens: 4 },
        },
      },
    ];
    return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
      headers: { 'content-type': 'text/event-stream' },
    });
  });
  try {
    const provider = {
      id: 'native-search-gap',
      adapterId: 'native-search-gap',
      apiKey: 'explicit',
      baseUrl: 'https://provider.invalid/v1',
      models: ['physical'],
      requiresApiKey: true,
      gatewayCapabilities: { chatCompletions: 'bridged', responses: 'native' },
      modelMetadata: { physical: { limit: { context: 32000 }, reasoning: true } },
    } as unknown as ResolvedLLMProviderConfig;
    const output = await frames(
      await new PiAiGatewayClient().createResponsesStream(provider, {
        model: 'physical',
        stream: true,
        input: [
          {
            type: 'additional_tools',
            role: 'developer',
            tools: [
              {
                type: 'tool_search',
                execution: 'client',
                description: 'Find local tools.',
                parameters: { type: 'object', properties: {} },
              },
            ],
          },
          { role: 'user', content: 'find tools' },
        ],
      })
    );
    const added = output.filter((event) => event.type === 'response.output_item.added');
    expect(added.map((event) => [event.output_index, event.item.id])).toEqual([
      [0, search.id],
      [1, message.id],
    ]);
    expect(
      output.filter(
        (event) => event.type === 'response.output_item.done' && event.item.id === search.id
      )
    ).toHaveLength(1);
    expect(
      output
        .find((event) => event.type === 'response.completed')
        ?.response.output.map((item: { id: string }) => item.id)
    ).toEqual([search.id, message.id]);
    expect(fetchMock).toHaveBeenCalledOnce();
  } finally {
    fetchMock.mockRestore();
  }
});

it.each([
  false,
  true,
])('refuses unknown required function history semantics before effect; stream=%s', async (stream) => {
  const { faux, client, provider } = setup('openai-responses');
  const request = {
    model: 'physical',
    stream,
    input: [
      {
        type: 'function_call',
        call_id: 'call_required',
        name: 'lookup',
        arguments: '{}',
        required_native_control: true,
      },
      { type: 'function_call_output', call_id: 'call_required', output: 'result' },
    ],
  };
  await expect(
    stream
      ? client.createResponsesStream(provider, request)
      : client.createResponses(provider, request)
  ).rejects.toMatchObject({ code: 'unsupported_gateway_feature' });
  expect(faux.state.callCount).toBe(0);
});

it.each([
  false,
  true,
])('matches named Responses results to the actual callable producer; stream=%s', async (stream) => {
  const { faux, client, provider } = setup('openai-responses');
  const request = {
    model: 'physical',
    stream,
    input: [
      {
        type: 'function_call',
        call_id: 'call_named_left',
        name: 'lookup_left',
        arguments: '{"path":"left.txt"}',
      },
      {
        type: 'function_call',
        call_id: 'call_named_right',
        name: 'lookup_right',
        arguments: '{"path":"right.txt"}',
      },
      {
        type: 'function_call_output',
        call_id: 'call_named_right',
        name: 'lookup_right',
        namespace: 'functions',
        output: 'right result',
      },
      {
        type: 'function_call_output',
        call_id: 'call_named_left',
        name: 'lookup_left',
        output: 'left result',
      },
    ],
  };
  faux.setResponses([
    (context) => {
      expect(
        context.messages
          .filter((message) => message.role === 'toolResult')
          .map((message) => [message.toolCallId, message.toolName])
      ).toEqual([
        ['call_named_right', 'lookup_right'],
        ['call_named_left', 'lookup_left'],
      ]);
      return fauxAssistantMessage('done');
    },
  ]);
  if (stream) await frames(await client.createResponsesStream(provider, request));
  else await client.createResponses(provider, request);
  expect(faux.state.callCount).toBe(1);
  const mismatched = {
    ...request,
    input: request.input.map((item) =>
      item.type === 'function_call_output' && item.call_id === 'call_named_right'
        ? { ...item, name: 'lookup_left' }
        : item
    ),
  };
  await expect(
    stream
      ? client.createResponsesStream(provider, mismatched)
      : client.createResponses(provider, mismatched)
  ).rejects.toMatchObject({ code: 'unsupported_gateway_feature' });
  expect(faux.state.callCount).toBe(1);
});

it.each([
  'id',
  'name',
] as const)('refuses a completed Chat tool whose %s conflicts with its published start', async (field) => {
  const { faux, client, provider } = setup('openai-responses');
  const started = fauxToolCall(
    'lookup_started',
    { path: 'started.txt' },
    { id: 'call_started|fc_started' }
  );
  const completed = {
    ...started,
    [field]: field === 'id' ? 'call_other|fc_other' : 'lookup_other',
  };
  const message = fauxAssistantMessage([completed], { stopReason: 'toolUse' });
  const events = createAssistantMessageEventStream();
  events.push({ type: 'start', partial: fauxAssistantMessage([]) });
  events.push({
    type: 'toolcall_start',
    contentIndex: 0,
    partial: fauxAssistantMessage([started]),
  });
  events.push({ type: 'toolcall_end', contentIndex: 0, toolCall: completed, partial: message });
  events.push({ type: 'done', reason: 'toolUse', message });
  events.end(message);
  Object.assign(faux.provider, { stream: () => events });
  await expect(
    client
      .createChatCompletionStream(provider, { model: 'physical', messages: [], stream: true })
      .then(frames)
  ).rejects.toMatchObject({ code: 'unsupported_gateway_feature' });
});

it('fails a late native gap that would renumber an already published semantic item', async () => {
  const { faux, client, provider } = setup('openai-responses');
  const text = {
    ...fauxText('published'),
    textSignature: JSON.stringify({ v: 1, id: 'msg_published' }),
  };
  const message = fauxAssistantMessage([text]);
  const events = createAssistantMessageEventStream();
  events.push({ type: 'start', partial: fauxAssistantMessage([]) });
  events.push({ type: 'text_end', contentIndex: 0, content: 'published', partial: message });
  let observe: ((data: unknown) => void) | undefined;
  Object.assign(faux.provider, {
    stream: (
      _model: unknown,
      _context: unknown,
      options: { onProviderStreamEvent?: (data: unknown) => void }
    ) => {
      observe = options.onProviderStreamEvent;
      return events;
    },
  });
  const reader = (
    await client.createResponsesStream(provider, {
      model: 'physical',
      input: 'hello',
      stream: true,
    })
  ).getReader();
  let published = '';
  while (!published.includes('response.output_item.done')) {
    const next = await reader.read();
    if (next.done) throw new Error('fixture ended before publication');
    published += new TextDecoder().decode(next.value);
  }
  observe?.({
    type: 'response.completed',
    response: {
      output: [
        { type: 'reasoning', id: 'rs_late_gap', summary: [], encrypted_content: 'sealed-late' },
        {
          type: 'message',
          id: 'msg_published',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'published' }],
        },
      ],
    },
  });
  events.push({ type: 'done', reason: 'stop', message });
  events.end(message);
  await expect(reader.read()).rejects.toMatchObject({ code: 'unsupported_gateway_feature' });
});

it.each([
  false,
  true,
])('refuses native message phase on an incompatible upstream API; stream=%s', async (stream) => {
  const { faux, client, provider } = setup('openai-completions');
  faux.setResponses([fauxAssistantMessage('must not execute')]);
  const request = {
    model: 'physical',
    stream,
    input: [
      {
        type: 'message',
        role: 'assistant',
        id: 'msg_native_phase',
        phase: 'commentary',
        content: [{ type: 'output_text', text: 'native commentary' }],
      },
    ],
  };
  await expect(
    stream
      ? client.createResponsesStream(provider, request)
      : client.createResponses(provider, request)
  ).rejects.toMatchObject({ code: 'unsupported_gateway_feature' });
  expect(faux.state.callCount).toBe(0);
});

it.each([
  'chat',
  'responses',
] as const)('rejects conflicting or unsupported targeted %s tool-choice identity before effect', async (format) => {
  const { faux, client, provider } = setup('openai-responses');
  for (const tool_choice of [
    { type: 'function', name: 'lookup_left', function: { name: 'lookup_right' } },
    { type: 'function', name: 'lookup_left', namespace: 'ops' },
  ]) {
    for (const stream of [false, true]) {
      const request = { model: 'physical', stream, tool_choice };
      const pending =
        format === 'chat'
          ? stream
            ? client.createChatCompletionStream(provider, { ...request, messages: [] })
            : client.createChatCompletion(provider, { ...request, messages: [] })
          : stream
            ? client.createResponsesStream(provider, { ...request, input: 'hello' })
            : client.createResponses(provider, { ...request, input: 'hello' });
      await expect(pending).rejects.toMatchObject({ code: 'unsupported_gateway_feature' });
      expect(faux.state.callCount).toBe(0);
    }
  }
});

it.each([
  false,
  true,
])('preserves a terminal-only native reasoning gap ahead of semantic output using wire indices; stream=%s', async (stream) => {
  const reasoning = {
    type: 'reasoning',
    id: 'rs_terminal_before_message',
    summary: [],
    encrypted_content: 'sealed-terminal-before-message',
  };
  const message = {
    type: 'message',
    id: 'msg_wire_index_one',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'native answer' }],
    status: 'completed',
  };
  let releaseTerminal: (() => void) | undefined;
  const terminalReady = new Promise<void>((resolve) => {
    releaseTerminal = resolve;
  });
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            const encode = (event: unknown) =>
              new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
            for (const event of [
              {
                type: 'response.created',
                response: { id: 'resp_native_gap', output: [], status: 'in_progress' },
              },
              {
                type: 'response.output_item.added',
                output_index: 1,
                item: { ...message, content: [], status: 'in_progress' },
              },
              {
                type: 'response.output_text.delta',
                output_index: 1,
                content_index: 0,
                item_id: message.id,
                delta: 'native answer',
              },
              { type: 'response.output_item.done', output_index: 1, item: message },
            ])
              controller.enqueue(encode(event));
            await terminalReady;
            controller.enqueue(
              encode({
                type: 'response.completed',
                response: {
                  id: 'resp_native_gap',
                  output: [reasoning, message],
                  status: 'completed',
                  usage: { input_tokens: 2, output_tokens: 2, total_tokens: 4 },
                },
              })
            );
            controller.close();
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } }
      )
  );
  try {
    const provider = {
      id: 'native-wire-indices',
      adapterId: 'native-wire-indices',
      apiKey: 'explicit',
      baseUrl: 'https://provider.invalid/v1',
      models: ['physical'],
      requiresApiKey: true,
      gatewayCapabilities: { chatCompletions: 'bridged', responses: 'native' },
      modelMetadata: { physical: { limit: { context: 32000 }, reasoning: true } },
    } as unknown as ResolvedLLMProviderConfig;
    const client = new PiAiGatewayClient();
    const request = { model: 'physical', input: 'hello', stream };
    let response: OpenAICompatibleResponsesResponse | undefined;
    if (stream) {
      const reader = (await client.createResponsesStream(provider, request)).getReader();
      let body = '';
      while (!body.includes('response.output_item.done')) {
        const next = await reader.read();
        if (next.done) throw new Error('fixture ended early');
        body += new TextDecoder().decode(next.value);
      }
      const events = body
        .split('\n')
        .filter((line) => line.startsWith('data: {'))
        .map((line) => JSON.parse(line.slice(6)));
      expect(events.find((event) => event.type === 'response.output_item.done')?.output_index).toBe(
        1
      );
      releaseTerminal?.();
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        body += new TextDecoder().decode(next.value);
      }
      const completed = body
        .split('\n')
        .filter((line) => line.startsWith('data: {'))
        .map((line) => JSON.parse(line.slice(6)));
      expect(
        completed
          .filter(
            (event) => event.type === 'response.output_item.done' && event.item.id === reasoning.id
          )
          .map((event) => event.output_index)
      ).toEqual([0]);
      response = completed.find((event) => event.type === 'response.completed')?.response;
    } else {
      releaseTerminal?.();
      response = await client.createResponses(provider, request);
    }
    expect(response?.output?.map((item) => item.id)).toEqual([reasoning.id, message.id]);
    expect(response?.output?.[0]).toEqual(reasoning);
    expect(fetchMock).toHaveBeenCalledOnce();
  } finally {
    releaseTerminal?.();
    fetchMock.mockRestore();
  }
});

it.each([
  false,
  true,
])('refuses unknown native item kinds even when the terminal list omits them; stream=%s', async (stream) => {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(
      [
        {
          type: 'response.created',
          response: { id: 'resp_unknown_native', output: [], status: 'in_progress' },
        },
        {
          type: 'response.output_item.added',
          output_index: 0,
          item: { id: 'unknown_native_item', type: 'future_required_kind' },
        },
        {
          type: 'response.completed',
          response: {
            id: 'resp_unknown_native',
            output: [],
            status: 'completed',
            usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
          },
        },
      ]
        .map((event) => `data: ${JSON.stringify(event)}\n\n`)
        .join(''),
      { headers: { 'content-type': 'text/event-stream' } }
    )
  );
  try {
    const provider = {
      id: 'unknown-native-kind',
      adapterId: 'unknown-native-kind',
      apiKey: 'explicit',
      baseUrl: 'https://provider.invalid/v1',
      models: ['physical'],
      requiresApiKey: true,
      gatewayCapabilities: { chatCompletions: 'bridged', responses: 'native' },
      modelMetadata: { physical: { limit: { context: 32000 }, reasoning: true } },
    } as unknown as ResolvedLLMProviderConfig;
    const client = new PiAiGatewayClient();
    const request = { model: 'physical', input: 'hello', stream };
    await expect(
      stream
        ? client.createResponsesStream(provider, request).then(frames)
        : client.createResponses(provider, request)
    ).rejects.toMatchObject({
      failure: { kind: 'unknown', settled: false },
      message: expect.stringContaining('pi-ai Responses native output'),
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  } finally {
    fetchMock.mockRestore();
  }
});
