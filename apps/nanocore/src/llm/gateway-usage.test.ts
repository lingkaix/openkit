import { describe, expect, it } from 'vitest';

import { GatewayUsageTracker } from './gateway-usage.js';
import type { ResolvedLLMProviderConfig } from './provider-config.js';
import { findProviderSpec } from './provider-registry.js';

/**
 * Creates a provider config suitable for usage-tracker tests.
 *
 * @returns Resolved provider config.
 */
function providerConfig(): ResolvedLLMProviderConfig {
  const spec = findProviderSpec('openai');

  if (!spec) {
    throw new Error('Missing OpenAI provider spec');
  }

  return {
    id: 'openai',
    specId: 'openai',
    displayName: 'OpenAI',
    model: 'gpt-5.1',
    baseUrl: 'https://api.example.test/v1',
    hasApiKey: true,
    apiKeySource: 'stored',
    gatewayCapabilities: spec.gatewayCapabilities,
    extraHeaders: {},
    extraBody: {},
    spec,
    apiKey: 'sk-test',
  };
}

describe('GatewayUsageTracker', () => {
  it('aggregates Chat-style cached token usage', () => {
    const tracker = new GatewayUsageTracker({ now: () => new Date('2026-05-26T00:00:00.000Z') });

    tracker.recordUsage({
      endpoint: 'chat_completions',
      model: 'gpt-5.1',
      provider: providerConfig(),
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        prompt_tokens_details: {
          cached_tokens: 80,
        },
      },
    });

    expect(tracker.snapshot()).toEqual({
      summaries: [
        {
          cachedInputTokens: 80,
          cacheHitRate: 0.8,
          completionTokens: 20,
          endpoint: 'chat_completions',
          inputTokens: 100,
          lastObservedAt: '2026-05-26T00:00:00.000Z',
          model: 'gpt-5.1',
          providerId: 'openai',
          requestCount: 1,
          totalTokens: 120,
        },
      ],
    });
  });

  it('aggregates Responses-style input token usage', () => {
    const tracker = new GatewayUsageTracker({ now: () => new Date('2026-05-26T00:00:00.000Z') });

    tracker.recordUsage({
      endpoint: 'responses',
      model: 'gpt-5.1',
      provider: providerConfig(),
      usage: {
        input_tokens: 200,
        output_tokens: 30,
        total_tokens: 230,
        input_tokens_details: {
          cached_tokens: 150,
        },
      },
    });

    expect(tracker.snapshot().summaries[0]).toMatchObject({
      cachedInputTokens: 150,
      cacheHitRate: 0.75,
      inputTokens: 200,
      completionTokens: 30,
      totalTokens: 230,
    });
  });

  it('observes usage from terminal SSE chunks without modifying the stream', async () => {
    const tracker = new GatewayUsageTracker({ now: () => new Date('2026-05-26T00:00:00.000Z') });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            [
              'data: {"type":"response.output_text.delta","delta":"Hi"}',
              '',
              'data: {"type":"response.completed","response":{"usage":{"input_tokens":50,"output_tokens":5,"total_tokens":55,"input_tokens_details":{"cached_tokens":25}}}}',
              '',
              'data: [DONE]',
              '',
            ].join('\n')
          )
        );
        controller.close();
      },
    });

    const observed = tracker.observeSseUsage(stream, {
      endpoint: 'responses',
      model: 'gpt-5.1',
      onUsage: (usage) => {
        expect(usage).toMatchObject({ input_tokens: 50, output_tokens: 5 });
      },
      provider: providerConfig(),
    });

    await expect(new Response(observed).text()).resolves.toContain('response.completed');
    expect(tracker.snapshot().summaries[0]).toMatchObject({
      cachedInputTokens: 25,
      inputTokens: 50,
      requestCount: 1,
    });
  });
});
