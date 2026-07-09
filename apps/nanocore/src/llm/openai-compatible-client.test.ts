import { describe, expect, it } from 'vitest';

import { OpenAICompatibleChatClient } from './openai-compatible-client.js';
import type { ResolvedLLMProviderConfig } from './provider-config.js';
import { findProviderSpec } from './provider-registry.js';

function providerConfig(input: Partial<ResolvedLLMProviderConfig> = {}): ResolvedLLMProviderConfig {
  const spec = findProviderSpec('openai');

  if (!spec) {
    throw new Error('Missing OpenAI provider spec');
  }

  return {
    id: 'openai',
    specId: 'openai',
    displayName: 'OpenAI',
    model: 'gpt-5.1',
    baseUrl: 'https://api.example.test/v1/',
    hasApiKey: true,
    apiKeySource: 'stored',
    gatewayCapabilities: spec.gatewayCapabilities,
    extraHeaders: {},
    extraBody: {},
    spec,
    apiKey: 'sk-secret',
    ...input,
  };
}

describe('OpenAICompatibleChatClient', () => {
  it('posts non-streaming chat completions to the OpenAI-compatible endpoint', async () => {
    const requests: Request[] = [];
    const client = new OpenAICompatibleChatClient({
      fetch: async (request) => {
        requests.push(request);
        return Response.json({
          id: 'chatcmpl_1',
          object: 'chat.completion',
          created: 1,
          model: 'gpt-5.1',
          choices: [
            { index: 0, message: { role: 'assistant', content: 'Hello' }, finish_reason: 'stop' },
          ],
        });
      },
    });

    const response = await client.createChatCompletion(providerConfig(), {
      model: 'gpt-5.1',
      messages: [{ role: 'user', content: 'Say hello' }],
      prompt_cache_key: 'chat-cache-key',
      prompt_cache_retention: 'in-memory',
    });

    expect(response.choices[0]?.message.content).toBe('Hello');
    expect(requests[0]?.url).toBe('https://api.example.test/v1/chat/completions');
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer sk-secret');
    expect(await requests[0]?.json()).toMatchObject({
      model: 'gpt-5.1',
      messages: [{ role: 'user', content: 'Say hello' }],
      prompt_cache_key: 'chat-cache-key',
      prompt_cache_retention: 'in-memory',
      stream: false,
    });
  });

  it('merges configured extra headers and body fields', async () => {
    const requests: Request[] = [];
    const client = new OpenAICompatibleChatClient({
      fetch: async (request) => {
        requests.push(request);
        return Response.json({ data: [] });
      },
    });

    await client.listModels(
      providerConfig({
        extraHeaders: { 'x-provider': 'demo' },
        extraBody: { provider_option: true },
      })
    );
    await client.createChatCompletion(
      providerConfig({
        extraHeaders: { 'x-provider': 'demo' },
        extraBody: { provider_option: true },
      }),
      {
        model: 'gpt-5.1',
        messages: [{ role: 'user', content: 'Hi' }],
      }
    );

    expect(requests[0]?.url).toBe('https://api.example.test/v1/models');
    expect(requests[0]?.headers.get('x-provider')).toBe('demo');
    expect(await requests[1]?.json()).toMatchObject({
      provider_option: true,
      model: 'gpt-5.1',
    });
  });

  it('posts non-streaming Responses requests to the OpenAI responses endpoint', async () => {
    const requests: Request[] = [];
    const client = new OpenAICompatibleChatClient({
      fetch: async (request) => {
        requests.push(request);
        return Response.json({
          id: 'resp_1',
          object: 'response',
          status: 'completed',
          model: 'gpt-5.1',
          output: [],
        });
      },
    });

    const response = await client.createResponses(providerConfig(), {
      model: 'gpt-5.1',
      input: 'Hello',
      prompt_cache_key: 'responses-cache-key',
      prompt_cache_retention: 'in-memory',
    });

    expect(response.id).toBe('resp_1');
    expect(requests[0]?.url).toBe('https://api.example.test/v1/responses');
    expect(await requests[0]?.json()).toMatchObject({
      model: 'gpt-5.1',
      input: 'Hello',
      prompt_cache_key: 'responses-cache-key',
      prompt_cache_retention: 'in-memory',
      stream: false,
    });
  });

  it('normalizes upstream provider errors', async () => {
    const client = new OpenAICompatibleChatClient({
      fetch: async () =>
        Response.json(
          {
            error: {
              message: 'Invalid API key',
              type: 'invalid_request_error',
              code: 'invalid_api_key',
            },
          },
          { status: 401 }
        ),
    });

    await expect(
      client.createChatCompletion(providerConfig(), {
        model: 'gpt-5.1',
        messages: [{ role: 'user', content: 'Hi' }],
      })
    ).rejects.toMatchObject({
      status: 401,
      code: 'invalid_api_key',
      message: 'Invalid API key',
    });
  });
});
