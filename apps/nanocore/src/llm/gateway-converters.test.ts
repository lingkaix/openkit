import { describe, expect, it } from 'vitest';

import {
  convertChatCompletionResponseToResponsesResponse,
  convertChatCompletionToResponsesRequest,
  convertResponsesRequestToChatCompletionRequest,
  convertResponsesResponseToChatCompletionResponse,
  GatewayUnsupportedFeatureError,
} from './gateway-converters.js';

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
});
