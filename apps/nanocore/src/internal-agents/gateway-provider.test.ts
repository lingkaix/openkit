import { createModels, fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { describe, expect, it, vi } from 'vitest';

import type { ResolvedLogicalModel } from '../llm/logical-models.js';
import { PiAiGatewayClient } from '../llm/pi-ai-client.js';
import { LLMGatewayProviderDispatcher } from '../llm/provider-dispatcher.js';
import { createInternalAgentGatewayProvider } from './gateway-provider.js';

const logicalModel: ResolvedLogicalModel = {
  id: 'assistant',
  displayName: 'Assistant',
  capabilities: ['responses', 'tool-calling'],
  contextManagement: { type: 'compaction', compactThreshold: 8_000 },
  modelFamilyId: 'gpt-5',
  routes: [{ id: 'primary', providerProfileId: 'provider', providerModel: 'model' }],
};

function request(input = 'Read status.') {
  return {
    systemPrompt: 'Admin role.',
    messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: input }] }],
    tools: [
      {
        name: 'environment.status',
        description: 'Read status.',
        inputSchema: { type: 'object' },
      },
    ],
    model: {
      logicalModelId: 'assistant',
      capabilities: logicalModel.capabilities,
      modelFamilyId: logicalModel.modelFamilyId,
    },
    contextManagement: {
      type: 'compaction' as const,
      compactThreshold: 8_000,
      authority: 'openkit' as const,
    },
    signal: new AbortController().signal,
  };
}

describe('internal Agent Gateway provider', () => {
  it('projects only fixed Tools and preserves provider output interleaving', async () => {
    const createResponses = vi.fn().mockResolvedValue({
      id: 'response',
      object: 'response',
      status: 'completed',
      output: [
        {
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'Checking.' }],
        },
        {
          type: 'function_call',
          call_id: 'call_status',
          name: 'environment.status',
          arguments: '{"workspaceId":"ws_target"}',
        },
      ],
    });
    const onDispatch = vi.fn();
    const provider = createInternalAgentGatewayProvider({
      logicalModel,
      dispatcher: { createResponses } as Pick<LLMGatewayProviderDispatcher, 'createResponses'>,
      resolveGatewayProvider: () =>
        ({ id: 'provider', models: ['model'], gatewayCapabilities: {} }) as never,
      metadata: { openkit: { workspaceId: 'ws_private' } },
      promptCacheScope: { sessionId: 'admin:th_private', workspaceId: 'ws_private' },
      usageEndpoint: 'responses',
      onDispatch,
    });

    const response = await provider(request());

    expect(createResponses).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        parallel_tool_calls: false,
        tools: [
          {
            type: 'function',
            name: 'environment.status',
            description: 'Read status.',
            parameters: { type: 'object' },
            strict: true,
          },
        ],
      }),
      expect.objectContaining({ transport: { signal: expect.any(AbortSignal) } })
    );
    expect(response.message).toEqual({
      role: 'assistant',
      truncated: false,
      content: [
        { type: 'text', text: 'Checking.' },
        {
          type: 'toolCall',
          callId: 'call_status',
          name: 'environment.status',
          arguments: { workspaceId: 'ws_target' },
        },
      ],
    });
    expect(onDispatch).toHaveBeenCalledWith({ providerId: 'provider' });
  });

  it('fails before provider contact when unsupported compaction is required', async () => {
    const createResponses = vi.fn();
    const provider = createInternalAgentGatewayProvider({
      logicalModel,
      dispatcher: { createResponses } as Pick<LLMGatewayProviderDispatcher, 'createResponses'>,
      resolveGatewayProvider: () => ({}) as never,
      metadata: {},
      promptCacheScope: { sessionId: 'admin:th_private', workspaceId: 'ws_private' },
      usageEndpoint: 'responses',
    });

    await expect(provider(request('x'.repeat(8_000)))).rejects.toMatchObject({
      code: 'context_compaction_unavailable',
    });
    expect(createResponses).not.toHaveBeenCalled();
  });

  it('passes the below-threshold request through real Gateway admission', async () => {
    const faux = fauxProvider({
      provider: 'provider',
      models: [{ id: 'model' }],
    });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage('Admitted.')]);
    const provider = createInternalAgentGatewayProvider({
      logicalModel,
      dispatcher: new LLMGatewayProviderDispatcher({
        piAiClient: new PiAiGatewayClient({ models }),
      }),
      resolveGatewayProvider: () => ({
        adapterId: 'provider',
        apiKey: 'test-key',
        baseUrl: null,
        displayName: 'Provider',
        gatewayCapabilities: { chatCompletions: 'native', responses: 'native' },
        id: 'provider',
        models: ['model'],
        requiresApiKey: true,
      }),
      metadata: {},
      promptCacheScope: { sessionId: 'administration:th_private', workspaceId: 'ws_private' },
      usageEndpoint: 'responses',
    });

    const response = await provider(request());

    expect(response.message.content).toEqual([{ type: 'text', text: 'Admitted.' }]);
    expect(faux.state.callCount).toBe(1);
  });

  it('fails before provider contact when Tool image content cannot be preserved', async () => {
    const createResponses = vi.fn();
    const provider = createInternalAgentGatewayProvider({
      logicalModel,
      dispatcher: { createResponses } as Pick<LLMGatewayProviderDispatcher, 'createResponses'>,
      resolveGatewayProvider: () => ({}) as never,
      metadata: {},
      promptCacheScope: { sessionId: 'administration:th_private', workspaceId: 'ws_private' },
      usageEndpoint: 'responses',
    });
    const input = request();

    await expect(
      provider({
        ...input,
        messages: [
          ...input.messages,
          {
            role: 'tool',
            callId: 'call_image',
            content: [{ type: 'image', mimeType: 'image/png', data: 'private-image-bytes' }],
          },
        ],
      })
    ).rejects.toMatchObject({ code: 'tool_image_content_unavailable' });
    expect(createResponses).not.toHaveBeenCalled();
  });
});
