import { describe, expect, it, vi } from 'vitest';
import type { ResolvedLLMProviderConfig } from '../providers/llm-config.js';
import { GatewayUsageTracker, parseUsage } from './gateway-usage.js';

/**
 * Creates a provider config suitable for usage-tracker tests.
 *
 * @returns Resolved provider config.
 */
function providerConfig(): ResolvedLLMProviderConfig {
  return {
    adapterId: 'openai',
    apiKey: 'sk-test',
    backend: 'pi-ai',
    baseUrl: 'https://api.example.test/v1',
    displayName: 'OpenAI',
    extraBody: {},
    extraHeaders: {},
    gatewayCapabilities: { chatCompletions: 'native', responses: 'native' },
    id: 'openai',
    requiresApiKey: true,
  };
}

describe('GatewayUsageTracker', () => {
  it('retains raw pi-ai cache-write and cost usage while rejecting invalid quantities', () => {
    expect(
      parseUsage({
        cacheRead: 7,
        cacheWrite: 5,
        cost: { total: 0.0012 },
        input: 3,
        output: 4,
        totalTokens: 19,
      })
    ).toEqual({
      cachedInputTokens: 7,
      cacheWriteTokens: 5,
      completionTokens: 4,
      costEstimateUsd: 0.0012,
      inputTokens: 3,
      totalTokens: 19,
    });
    expect(
      parseUsage({
        cacheRead: Number.NaN,
        cacheWrite: -1,
        cost: { total: Number.POSITIVE_INFINITY },
        input: -1,
        output: Number.NEGATIVE_INFINITY,
        totalTokens: -1,
      })
    ).toEqual({
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      completionTokens: 0,
      costEstimateUsd: 0,
      inputTokens: 0,
      totalTokens: 0,
    });
  });

  it('preserves public diagnostics semantics for raw pi-ai usage', () => {
    const tracker = new GatewayUsageTracker({ now: () => new Date('2026-05-26T00:00:00.000Z') });

    tracker.recordUsage({
      endpoint: 'chat_completions',
      model: 'claude-sonnet-4-5',
      provider: providerConfig(),
      usage: {
        cacheRead: 60,
        cacheWrite: 20,
        input: 40,
        output: 5,
        totalTokens: 125,
      },
    });

    expect(tracker.snapshot().summaries[0]).toMatchObject({
      cachedInputTokens: 60,
      cacheHitRate: 0.6,
      inputTokens: 100,
      requestCount: 1,
      totalTokens: 105,
    });
  });

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

  it('cancels the upstream stream exactly once when the observed stream is cancelled', async () => {
    const cancel = vi.fn();
    let pulled = false;
    const stream = new ReadableStream<Uint8Array>({
      cancel,
      pull(controller) {
        if (!pulled) {
          pulled = true;
          controller.enqueue(
            new TextEncoder().encode('data: {"type":"response.output_text.delta"}\n\n')
          );
        }
      },
    });
    const observed = new GatewayUsageTracker().observeSseUsage(stream, {
      endpoint: 'responses',
      model: 'gpt-5.1',
      provider: providerConfig(),
    });
    const reader = observed.getReader();

    await reader.read();
    await reader.cancel('consumer disconnected');

    expect(cancel).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledWith('consumer disconnected');
  });
});
