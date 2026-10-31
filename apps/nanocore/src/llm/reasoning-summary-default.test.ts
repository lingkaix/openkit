import { createModels } from '@earendil-works/pi-ai';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { describe, expect, it, vi } from 'vitest';
import type { ResolvedLLMProviderConfig } from '../providers/llm-config.js';
import type { OpenAICompatibleResponsesRequest } from './openai-compatible-client.js';
import { PiAiGatewayClient } from './pi-ai-client.js';
import { LLMGatewayProviderDispatcher } from './provider-dispatcher.js';

function openAiResponsesFixture(reasoning: boolean) {
  const models = createModels();
  const stock = openaiProvider();
  models.setProvider(stock);
  const template = models.getModels().find((model) => model.api === 'openai-responses')!;
  const modelId = template.id;
  models.setProvider({ ...stock, models: [{ ...template, reasoning }] });
  const provider = {
    adapterId: stock.id,
    apiKey: 'explicit-secret',
    backend: 'pi-ai',
    baseUrl: null,
    displayName: 'OpenAI',
    gatewayCapabilities: { chatCompletions: 'native', responses: 'native' },
    id: stock.id,
    models: [modelId],
    requiresApiKey: true,
  } as unknown as ResolvedLLMProviderConfig;
  return { models, provider, modelId };
}

describe('OpenKit default Responses reasoning summary', () => {
  it.each([
    { label: 'internal-agent', context: { openkitGatewayDispatch: 'internal_agent' as const } },
    {
      label: 'worker-lineage without raw capture',
      context: { openkitGatewayDispatch: 'worker_inference' as const },
    },
  ])('defaults omitted summary to auto for $label dispatch', async ({ context }) => {
    const { models, provider, modelId } = openAiResponsesFixture(true);
    const client = new PiAiGatewayClient({ models });
    vi.spyOn(client as unknown as { resolveModel: () => unknown }, 'resolveModel').mockReturnValue({
      model: { reasoning: true, api: 'openai-responses' },
      knownCost: false,
    });
    const createResponses = vi
      .spyOn(client, 'createResponses')
      .mockResolvedValue({ id: 'resp', object: 'response', status: 'completed' } as never);
    const dispatcher = new LLMGatewayProviderDispatcher({ piAiClient: client });
    const request: OpenAICompatibleResponsesRequest = { model: modelId, input: 'Hi' };
    await dispatcher.createResponses(provider, request, context);
    expect(createResponses.mock.calls[0]?.[1]?.reasoning).toEqual({ summary: 'auto' });
  });

  it('keeps explicit summary values and public passthrough', async () => {
    const { models, provider, modelId } = openAiResponsesFixture(true);
    const client = new PiAiGatewayClient({ models });
    const createResponses = vi
      .spyOn(client, 'createResponses')
      .mockResolvedValue({ id: 'resp', object: 'response', status: 'completed' } as never);
    const dispatcher = new LLMGatewayProviderDispatcher({ piAiClient: client });
    await dispatcher.createResponses(
      provider,
      { model: modelId, input: 'Hi', reasoning: { summary: 'off' } },
      { openkitGatewayDispatch: 'internal_agent' }
    );
    expect(createResponses.mock.calls.at(-1)?.[1]?.reasoning).toEqual({ summary: 'off' });
    await dispatcher.createResponses(
      provider,
      { model: modelId, input: 'Hi', reasoning: { summary: 'detailed' } },
      { openkitGatewayDispatch: 'internal_agent' }
    );
    expect(createResponses.mock.calls.at(-1)?.[1]?.reasoning).toEqual({ summary: 'detailed' });
    await dispatcher.createResponses(provider, { model: modelId, input: 'Hi' }, {});
    expect(createResponses.mock.calls.at(-1)?.[1]?.reasoning).toBeUndefined();
    await dispatcher.createResponses(
      provider,
      { model: modelId, input: 'Hi' },
      { usageEndpoint: 'responses' }
    );
    expect(createResponses.mock.calls.at(-1)?.[1]?.reasoning).toBeUndefined();
  });

  it('does not add summary when the model lacks reasoning support', async () => {
    const { models, provider, modelId } = openAiResponsesFixture(false);
    const client = new PiAiGatewayClient({ models });
    expect(
      client.withOpenKitResponsesReasoningSummary(
        provider,
        { model: modelId, input: 'Hi' },
        true,
        models
      ).reasoning
    ).toBeUndefined();
  });
});
