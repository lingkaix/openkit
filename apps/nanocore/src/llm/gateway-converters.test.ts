import { describe, expect, it, vi } from 'vitest';
import {
  convertChatCompletionResponseToResponsesResponse,
  convertChatCompletionStreamToResponsesStream,
  convertChatCompletionToResponsesRequest,
  convertResponsesRequestToChatCompletionRequest,
  convertResponsesResponseToChatCompletionResponse,
  convertResponsesStreamToChatCompletionStream,
  GatewayUnsupportedFeatureError,
} from './gateway-converters.js';
import type {
  OpenAICompatibleChatCompletionRequest,
  OpenAICompatibleChatMessage,
} from './openai-compatible-client.js';

describe('LLM gateway format converters', () => {
  it('converts chat-completions messages, tools, reasoning, and token limits to Responses', () => {
    const request = convertChatCompletionToResponsesRequest({
      model: 'gpt-5.1',
      messages: [
        { role: 'system', content: 'You are concise.' },
        { role: 'developer', content: 'Prefer JSON.' },
        { role: 'user', content: 'Summarize this.' },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'lookup',
            description: 'Look up one value.',
            parameters: { type: 'object', properties: { id: { type: 'string' } } },
          },
        },
      ],
      max_tokens: 128,
      prompt_cache_key: 'chat-cache-key',
      prompt_cache_retention: 'in-memory',
      reasoning_effort: 'medium',
      temperature: 0.2,
      tool_choice: 'auto',
    });

    expect(request).toMatchObject({
      model: 'gpt-5.1',
      instructions: 'You are concise.\n\nPrefer JSON.',
      max_output_tokens: 128,
      prompt_cache_key: 'chat-cache-key',
      prompt_cache_retention: 'in-memory',
      reasoning: { effort: 'medium' },
      temperature: 0.2,
      tool_choice: 'auto',
      tools: [
        {
          type: 'function',
          name: 'lookup',
          description: 'Look up one value.',
          parameters: { type: 'object' },
        },
      ],
    });
    expect(request.input).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'Summarize this.' }] },
    ]);
  });

  it('converts simple Responses requests to chat completions', () => {
    const request = convertResponsesRequestToChatCompletionRequest({
      model: 'gpt-5.1',
      instructions: 'Use a terse style.',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'Ping' }] }],
      tools: [
        {
          type: 'function',
          name: 'lookup',
          description: 'Look up one value.',
          parameters: { type: 'object' },
        },
      ],
      max_output_tokens: 32,
      prompt_cache_key: 'responses-cache-key',
      prompt_cache_retention: 'in-memory',
      reasoning: { effort: 'low' },
    });

    expect(request).toMatchObject({
      model: 'gpt-5.1',
      max_tokens: 32,
      prompt_cache_key: 'responses-cache-key',
      prompt_cache_retention: 'in-memory',
      reasoning_effort: 'low',
      messages: [
        { role: 'system', content: 'Use a terse style.' },
        { role: 'user', content: 'Ping' },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'lookup',
            description: 'Look up one value.',
            parameters: { type: 'object' },
          },
        },
      ],
    });
  });

  it('rejects Responses built-in tools when bridging to chat-only providers', () => {
    expect(() =>
      convertResponsesRequestToChatCompletionRequest({
        model: 'gpt-5.1',
        input: 'Search the web.',
        tools: [{ type: 'web_search_preview' }],
      })
    ).toThrow(GatewayUnsupportedFeatureError);
  });

  it('wraps chat completion responses as Responses responses', () => {
    const response = convertChatCompletionResponseToResponsesResponse({
      id: 'chatcmpl_1',
      object: 'chat.completion',
      created: 1,
      model: 'gpt-5.1',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'Hello' },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        prompt_tokens_details: {
          cached_tokens: 80,
        },
      },
    });

    expect(response).toMatchObject({
      id: 'chatcmpl_1',
      object: 'response',
      status: 'completed',
      model: 'gpt-5.1',
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Hello' }],
        },
      ],
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        total_tokens: 120,
        input_tokens_details: {
          cached_tokens: 80,
        },
      },
    });
  });

  it('wraps Responses usage as Chat Completions cached token usage', () => {
    const response = convertResponsesResponseToChatCompletionResponse(
      {
        id: 'resp_1',
        object: 'response',
        status: 'completed',
        model: 'gpt-5.1',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Hello' }],
          },
        ],
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          total_tokens: 120,
          input_tokens_details: {
            cached_tokens: 75,
          },
        },
      },
      'gpt-5.1'
    );

    expect(response.usage).toMatchObject({
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
      prompt_tokens_details: {
        cached_tokens: 75,
      },
    });
  });

  it('continues past filtered and fragmented SSE chunks while a read is pending', async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"Hi"}}]}\n',
      '\n',
      'data: [DONE]\n\n',
    ];
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks.shift();
        if (chunk === undefined) controller.close();
        else controller.enqueue(new TextEncoder().encode(chunk));
      },
    });
    expect(
      await new Response(convertChatCompletionStreamToResponsesStream(source)).text()
    ).toContain('"delta":"Hi"');
  }, 1_000);

  it.each([
    {
      endpoint: 'Chat Completions to Responses',
      convert: convertChatCompletionStreamToResponsesStream,
      input: 'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
    },
    {
      endpoint: 'Responses to Chat Completions',
      convert: (stream: ReadableStream<Uint8Array>) =>
        convertResponsesStreamToChatCompletionStream(stream, 'gpt-5.1'),
      input: 'data: {"type":"response.output_text.delta","delta":"Hi"}\n\n',
    },
  ])('cancels the upstream $endpoint SSE stream exactly once when its converted stream is cancelled', async (testCase) => {
    const cancel = vi.fn();
    let pulled = false;
    const source = new ReadableStream<Uint8Array>({
      cancel,
      pull(controller) {
        if (!pulled) {
          pulled = true;
          controller.enqueue(new TextEncoder().encode(testCase.input));
        }
      },
    });
    const reader = testCase.convert(source).getReader();

    await reader.read();
    await reader.cancel('consumer disconnected');

    expect(cancel).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledWith('consumer disconnected');
  });
});

/** Encodes native Responses fixtures without replacing either bridge boundary. */
function responsesSse(frames: unknown[], fragment = false): ReadableStream<Uint8Array> {
  const wire = frames.map((frame) => `data: ${JSON.stringify(frame)}\r\n\r\n`).join('');
  return new ReadableStream({
    start(controller) {
      const bytes = new TextEncoder().encode(wire);
      if (fragment) {
        for (let offset = 0; offset < bytes.length; offset += 7) {
          controller.enqueue(bytes.slice(offset, offset + 7));
        }
      } else controller.enqueue(bytes);
      controller.close();
    },
  });
}

/** Native function identity and argument events from the researcher's red regression. */
function functionFrames(argumentsText = '{"command":"pwd"}', completedArguments = argumentsText) {
  const item = {
    type: 'function_call',
    id: 'fc_probe',
    call_id: 'call_probe',
    name: 'bash',
    arguments: completedArguments,
    status: 'completed',
  };
  return [
    { type: 'response.created', response: { id: 'resp_probe', status: 'in_progress', output: [] } },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { ...item, arguments: '', status: 'in_progress' },
    },
    {
      type: 'response.function_call_arguments.delta',
      item_id: item.id,
      output_index: 0,
      delta: argumentsText,
    },
    {
      type: 'response.function_call_arguments.done',
      item_id: item.id,
      output_index: 0,
      arguments: item.arguments,
    },
    { type: 'response.output_item.done', output_index: 0, item },
    {
      type: 'response.completed',
      response: { id: 'resp_probe', status: 'completed', output: [item] },
    },
  ];
}

/** Parses downstream frames so duplicated deltas cannot pass substring assertions. */
async function chatFrames(frames: unknown[], fragment = false) {
  const wire = await new Response(
    convertResponsesStreamToChatCompletionStream(responsesSse(frames, fragment), 'probe')
  ).text();
  return wire
    .split('\n\n')
    .filter(Boolean)
    .map((frame) => (frame.slice(6) === '[DONE]' ? '[DONE]' : JSON.parse(frame.slice(6))));
}

describe('Responses-native function bridge regressions', () => {
  it.each([
    ['{ "x": 1 }', '{"x":1}'],
    [
      '{"x":1e0,"nested":{"values":[true,null,"a"]}}',
      '{"nested":{"values":[true,null,"\\u0061"]},"x":1.0}',
    ],
  ])('retains raw argument deltas when completed JSON is equivalent: %s', async (raw, snapshot) => {
    const frames = await chatFrames(functionFrames(raw, snapshot), true);
    const chunks = frames.filter((frame) => frame !== '[DONE]');
    const calls = chunks.flatMap((frame) => frame.choices[0].delta.tool_calls ?? []);
    expect(calls.map((call) => call.function.arguments ?? '').join('')).toBe(raw);
    expect(chunks.at(-1).choices[0].finish_reason).toBe('tool_calls');
    expect(frames.filter((frame) => frame === '[DONE]')).toHaveLength(1);
  });

  it.each([
    ['{ "x": 1 }', '{"x":2}'],
    ['{"values":[1,2]}', '{"values":[2,1]}'],
    ['{ "x":', '{"x":1}'],
  ])('refuses conflicting or unverifiable completed arguments: %s', async (raw, snapshot) => {
    await expect(chatFrames(functionFrames(raw, snapshot))).rejects.toMatchObject({
      code: 'unsupported_gateway_feature',
      feature: 'responses function arguments',
    });
  });

  it.each([
    false,
    true,
  ])('rejects duplicate response-local function identities; stream=%s', async (stream) => {
    const item = {
      type: 'function_call',
      call_id: 'call_duplicate',
      name: 'lookup',
      arguments: '{}',
    };
    const output = [
      { ...item, id: 'fc_first' },
      { ...item, id: 'fc_second' },
    ];
    const response = { id: 'resp_duplicate', object: 'response', status: 'completed', output };
    if (stream) {
      await expect(
        chatFrames([
          ...output.map((value, output_index) => ({
            type: 'response.output_item.added',
            output_index,
            item: value,
          })),
          { type: 'response.completed', response },
        ])
      ).rejects.toMatchObject({
        code: 'unsupported_gateway_feature',
        feature: 'responses duplicate function call',
      });
    } else {
      expect(() => convertResponsesResponseToChatCompletionResponse(response, 'probe')).toThrow(
        'Gateway bridge does not support this feature: responses duplicate function call'
      );
    }
  });

  it('preserves the researcher function-only stream with exact identity and arguments', async () => {
    const frames = await chatFrames(functionFrames());
    const calls = frames
      .filter((frame) => frame !== '[DONE]')
      .flatMap((frame) => frame.choices[0].delta.tool_calls ?? []);
    expect(calls[0]).toMatchObject({
      index: 0,
      id: 'call_probe',
      type: 'function',
      function: { name: 'bash' },
    });
    expect(calls.map((call) => call.function.arguments ?? '').join('')).toBe('{"command":"pwd"}');
    expect(frames.at(-2)).toMatchObject({
      id: 'resp_probe',
      choices: [{ finish_reason: 'tool_calls' }],
    });
    expect(frames.filter((frame) => frame === '[DONE]')).toHaveLength(1);
  });

  it('preserves ordered assistant calls and correlated tool results in continuation history', () => {
    const request = convertChatCompletionToResponsesRequest({
      model: 'probe',
      messages: [
        { role: 'user', content: 'First request' },
        {
          role: 'assistant',
          content: 'Looking up',
          tool_calls: [
            {
              id: 'call_probe',
              type: 'function',
              function: { name: 'bash', arguments: '{"command":"pwd"}' },
            },
          ],
        } as OpenAICompatibleChatMessage,
        { role: 'tool', tool_call_id: 'call_probe', content: '/workspace' },
        { role: 'user', content: 'Next request' },
      ],
    });
    expect(request.input).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'First request' }] },
      { role: 'assistant', content: [{ type: 'output_text', text: 'Looking up' }] },
      {
        type: 'function_call',
        call_id: 'call_probe',
        name: 'bash',
        arguments: '{"command":"pwd"}',
      },
      { type: 'function_call_output', call_id: 'call_probe', output: '/workspace' },
      { role: 'user', content: [{ type: 'input_text', text: 'Next request' }] },
    ]);
  });

  it('preserves fragmented multiple calls and mixed text without replaying complete arguments', async () => {
    const a = {
      type: 'function_call',
      id: 'fc_a',
      call_id: 'call_a',
      name: 'one',
      arguments: '{"x":1}',
    };
    const b = {
      type: 'function_call',
      id: 'fc_b',
      call_id: 'call_b',
      name: 'two',
      arguments: '{}',
    };
    const frames = await chatFrames(
      [
        { type: 'response.created', response: { id: 'resp_many' } },
        { type: 'response.output_text.delta', delta: 'Hi 🌏' },
        { type: 'response.output_item.added', output_index: 1, item: { ...a, arguments: '' } },
        { type: 'response.output_item.added', output_index: 2, item: { ...b, arguments: '' } },
        {
          type: 'response.function_call_arguments.delta',
          output_index: 1,
          item_id: a.id,
          delta: '{"x":',
        },
        {
          type: 'response.function_call_arguments.delta',
          output_index: 2,
          item_id: b.id,
          delta: '{}',
        },
        {
          type: 'response.function_call_arguments.delta',
          output_index: 1,
          item_id: a.id,
          delta: '1}',
        },
        { type: 'response.output_item.done', output_index: 1, item: a },
        { type: 'response.output_item.done', output_index: 2, item: b },
        {
          type: 'response.completed',
          response: {
            id: 'resp_many',
            status: 'completed',
            output: [{ type: 'message', content: [{ type: 'output_text', text: 'Hi 🌏' }] }, a, b],
            usage: {
              input_tokens: 3,
              output_tokens: 2,
              total_tokens: 5,
              input_tokens_details: { cached_tokens: 1 },
            },
          },
        },
      ],
      true
    );
    const chunks = frames.filter((frame) => frame !== '[DONE]');
    expect(chunks.map((frame) => frame.choices[0]?.delta.content ?? '').join('')).toBe('Hi 🌏');
    const calls = chunks.flatMap((frame) => frame.choices[0]?.delta.tool_calls ?? []);
    expect(
      calls.filter((call) => call.id).map((call) => [call.index, call.id, call.function.name])
    ).toEqual([
      [0, 'call_a', 'one'],
      [1, 'call_b', 'two'],
    ]);
    for (const [index, args] of [
      [0, a.arguments],
      [1, b.arguments],
    ] as const)
      expect(
        calls
          .filter((call) => call.index === index)
          .map((call) => call.function.arguments ?? '')
          .join('')
      ).toBe(args);
    expect(chunks.at(-1)).toMatchObject({
      choices: [{ finish_reason: 'tool_calls' }],
      usage: {
        prompt_tokens: 3,
        completion_tokens: 2,
        total_tokens: 5,
        prompt_tokens_details: { cached_tokens: 1 },
      },
    });
  });

  it('preserves non-stream function calls alongside text and usage', () => {
    const response = convertResponsesResponseToChatCompletionResponse(
      {
        id: 'resp_nonstream',
        object: 'response',
        status: 'completed',
        output: [
          { type: 'message', content: [{ type: 'output_text', text: 'Looking up' }] },
          {
            type: 'function_call',
            call_id: 'call_probe',
            name: 'bash',
            arguments: '{"command":"pwd"}',
          },
        ],
        usage: { input_tokens: 2, output_tokens: 3 },
      },
      'probe'
    );
    expect(response.choices[0]).toEqual({
      index: 0,
      message: {
        role: 'assistant',
        content: 'Looking up',
        tool_calls: [
          {
            id: 'call_probe',
            type: 'function',
            function: { name: 'bash', arguments: '{"command":"pwd"}' },
          },
        ],
      },
      finish_reason: 'tool_calls',
    });
    expect(response.usage).toMatchObject({ prompt_tokens: 2, completion_tokens: 3 });
  });

  it.each([
    'response.failed',
    'error',
  ])('does not manufacture success from %s or leak its body', async (type) => {
    await expect(
      chatFrames([
        {
          type,
          response: { status: 'failed', error: { message: 'private-secret' } },
          error: { message: 'private-secret' },
        },
      ])
    ).rejects.toMatchObject({
      message: 'Provider request failed.',
      failure: { kind: 'unknown', settled: false },
    });
  });

  it('maps token-limit incomplete to length and other incomplete causes to failure', async () => {
    expect(
      await chatFrames([
        {
          type: 'response.incomplete',
          response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } },
        },
      ])
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ choices: [{ index: 0, delta: {}, finish_reason: 'length' }] }),
      ])
    );
    await expect(
      chatFrames([
        {
          type: 'response.incomplete',
          response: { status: 'incomplete', incomplete_details: { reason: 'content_filter' } },
        },
      ])
    ).rejects.toMatchObject({ message: 'Provider request failed.', failure: { kind: 'refused' } });
  });

  it('rejects non-stream native failure instead of returning an empty stop', () => {
    expect(() =>
      convertResponsesResponseToChatCompletionResponse(
        {
          id: 'resp_failed',
          object: 'response',
          status: 'failed',
          error: { message: 'private-secret' },
        },
        'probe'
      )
    ).toThrow('Provider request failed.');
  });

  it.each([
    { response_format: { type: 'json_schema', json_schema: {} } },
    { messages: [{ role: 'tool', content: 'unmatched', tool_call_id: 'missing' }] },
    {
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ type: 'custom', id: 'call_x', custom: { name: 'x', input: 'y' } }],
        },
      ],
    },
  ])('rejects an unsupported semantic request before conversion: %j', (fields) => {
    expect(() =>
      convertChatCompletionToResponsesRequest({
        model: 'probe',
        messages: [{ role: 'user', content: 'Hi' }],
        ...fields,
      } as OpenAICompatibleChatCompletionRequest)
    ).toThrow(GatewayUnsupportedFeatureError);
  });

  it('refuses unsupported output semantics instead of silently losing them', async () => {
    await expect(
      chatFrames([
        {
          type: 'response.output_item.done',
          output_index: 0,
          item: { type: 'custom_tool_call', call_id: 'custom', name: 'exec', input: 'code' },
        },
      ])
    ).rejects.toThrow(GatewayUnsupportedFeatureError);
    expect(() =>
      convertResponsesResponseToChatCompletionResponse(
        {
          id: 'resp_custom',
          object: 'response',
          status: 'completed',
          output: [{ type: 'custom_tool_call', name: 'exec', input: 'code' }],
        },
        'probe'
      )
    ).toThrow(GatewayUnsupportedFeatureError);
  });
});

it('preserves native quota classification without exposing a provider error body', async () => {
  await expect(
    chatFrames([
      {
        type: 'response.failed',
        response: {
          status: 'failed',
          error: { code: 'insufficient_quota', message: 'private account detail' },
        },
      },
    ])
  ).rejects.toMatchObject({
    message: 'Provider request failed.',
    failure: { kind: 'quota_exhausted' },
  });
});

it('does not manufacture a successful terminal from an uncorrelated DONE sentinel', async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  expect(
    await new Response(convertResponsesStreamToChatCompletionStream(stream, 'probe')).text()
  ).toBe('');
});

it('preserves strict function declarations, simple choice and the native completion cap', () => {
  const result = convertChatCompletionToResponsesRequest({
    model: 'probe',
    messages: [{ role: 'user', content: 'Hi' }],
    tools: [
      {
        type: 'function',
        function: { name: 'lookup', parameters: { type: 'object' }, strict: true },
      },
    ],
    tool_choice: { type: 'function', function: { name: 'lookup' } },
    max_completion_tokens: 32,
    max_tokens: 16,
    store: false,
  });
  expect(result).toMatchObject({
    max_output_tokens: 32,
    store: false,
    tool_choice: { type: 'function', name: 'lookup' },
    tools: [{ type: 'function', name: 'lookup', strict: true }],
  });
});

it('preserves completed text parts when argument and text deltas are absent', async () => {
  const item = {
    type: 'function_call',
    id: 'fc_done',
    call_id: 'call_done',
    name: 'lookup',
    arguments: '{}',
  };
  const frames = await chatFrames([
    { type: 'response.output_text.done', output_index: 0, content_index: 0, text: 'Complete text' },
    { type: 'response.output_item.done', output_index: 1, item },
    { type: 'response.completed' },
  ]);
  expect(frames[0]).toMatchObject({ choices: [{ delta: { content: 'Complete text' } }] });
  expect(frames[1]).toMatchObject({
    choices: [
      {
        delta: {
          tool_calls: [
            { index: 0, id: 'call_done', function: { name: 'lookup', arguments: '{}' } },
          ],
        },
      },
    ],
  });
  expect(frames.at(-2)).toMatchObject({ choices: [{ finish_reason: 'tool_calls' }] });
});

it('cancels an upstream inference stream when unsupported output cannot be converted', async () => {
  const cancel = vi.fn();
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"custom_tool_call","name":"exec","input":"code"}}\n\n'
        )
      );
    },
    cancel,
  });
  await expect(
    new Response(convertResponsesStreamToChatCompletionStream(source, 'probe')).text()
  ).rejects.toThrow(GatewayUnsupportedFeatureError);
  expect(cancel).toHaveBeenCalledOnce();
});
