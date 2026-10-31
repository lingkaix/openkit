import { createModels } from '@earendil-works/pi-ai';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { describe, expect, it, vi } from 'vitest';
import type { ResolvedLLMProviderConfig } from '../providers/llm-config.js';
import type { OpenAICompatibleResponsesRequest } from './openai-compatible-client.js';
import { PiAiGatewayClient } from './pi-ai-client.js';
import { LLMGatewayProviderDispatcher } from './provider-dispatcher.js';

function responsesProvider(
  input: Partial<ResolvedLLMProviderConfig> = {}
): ResolvedLLMProviderConfig {
  return {
    adapterId: 'openai',
    apiKey: 'explicit-secret',
    backend: 'pi-ai',
    baseUrl: null,
    displayName: 'OpenAI',
    gatewayCapabilities: { chatCompletions: 'native', responses: 'native' },
    id: 'openai_primary',
    models: ['gpt-test'],
    requiresApiKey: true,
    ...input,
  } as unknown as ResolvedLLMProviderConfig;
}

function reasoningResponsesModel(models: ReturnType<typeof createModels>, reasoning: boolean) {
  const stock = openaiProvider();
  models.setProvider(stock);
  const template = models.getModels().find((model) => model.api === 'openai-responses')!;
  models.setProvider({
    ...stock,
    models: [{ ...template, id: 'gpt-test', reasoning }],
  });
}

describe('OpenKit default Responses reasoning summary', () => {
  it.each([
    { label: 'internal-agent', context: { usageEndpoint: 'responses' as const } },
    {
      label: 'worker-lineage',
      context: {
        transport: {
          rawOutput: {
            sourceStarted: () => () => {},
            sourceEvent: () => {},
            observe: () => {},
            fail: (error: Error) => {
              throw error;
            },
          },
        },
      },
    },
  ])('defaults omitted summary to auto for $label dispatch', async ({ context }) => {
    const models = createModels();
    reasoningResponsesModel(models, true);
    const client = new PiAiGatewayClient({ models });
    const createResponses = vi
      .spyOn(client, 'createResponses')
      .mockResolvedValue({ id: 'resp', object: 'response', status: 'completed' } as never);
    const dispatcher = new LLMGatewayProviderDispatcher({ piAiClient: client });
    const request: OpenAICompatibleResponsesRequest = { model: 'gpt-test', input: 'Hi' };
    await dispatcher.createResponses(responsesProvider(), request, context);
    expect(createResponses.mock.calls[0]?.[1]?.reasoning).toEqual({ summary: 'auto' });
  });

  it('keeps explicit summary values and public passthrough', async () => {
    const models = createModels();
    reasoningResponsesModel(models, true);
    const client = new PiAiGatewayClient({ models });
    const createResponses = vi
      .spyOn(client, 'createResponses')
      .mockResolvedValue({ id: 'resp', object: 'response', status: 'completed' } as never);
    const dispatcher = new LLMGatewayProviderDispatcher({ piAiClient: client });
    const provider = responsesProvider();
    await dispatcher.createResponses(
      provider,
      { model: 'gpt-test', input: 'Hi', reasoning: { summary: 'off' } },
      { usageEndpoint: 'responses' }
    );
    expect(createResponses.mock.calls.at(-1)?.[1]?.reasoning).toEqual({ summary: 'off' });
    await dispatcher.createResponses(
      provider,
      { model: 'gpt-test', input: 'Hi', reasoning: { summary: 'detailed' } },
      { usageEndpoint: 'responses' }
    );
    expect(createResponses.mock.calls.at(-1)?.[1]?.reasoning).toEqual({ summary: 'detailed' });
    await dispatcher.createResponses(provider, { model: 'gpt-test', input: 'Hi' }, {});
    expect(createResponses.mock.calls.at(-1)?.[1]?.reasoning).toBeUndefined();
  });

  it('does not add summary when the model lacks reasoning support', async () => {
    const models = createModels();
    reasoningResponsesModel(models, false);
    const client = new PiAiGatewayClient({ models });
    expect(
      client.withOpenKitResponsesReasoningSummary(
        responsesProvider(),
        { model: 'gpt-test', input: 'Hi' },
        true,
        models
      ).reasoning
    ).toBeUndefined();
  });
});
