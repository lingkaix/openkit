import { describe, expect, it, vi } from 'vitest';

import type { ResolvedLLMProviderConfig } from '../providers/llm-config.js';
import { dispatchLogicalModel } from './gateway-routes.js';
import type { ResolvedLogicalModel } from './logical-models.js';

/** Builds ordered members with an unavailable primary and a ready backup. */
function unavailablePrimary(autoFailover: boolean): ResolvedLogicalModel {
  return {
    id: 'tier',
    displayName: 'Tier',
    modelFamilyId: null,
    capabilities: [],
    autoFailover,
    contextManagement: { type: 'compaction', compactThreshold: 8_000 },
    routes: [
      {
        id: 'primary',
        providerProfileId: 'missing',
        providerModel: 'model',
        available: false,
        unavailableReason: 'provider_profile_absent',
      },
      {
        id: 'backup',
        providerProfileId: 'ready',
        providerModel: 'model',
        available: true,
        unavailableReason: null,
      },
    ],
  };
}

describe('dispatchLogicalModel member selection', () => {
  it.each([
    true,
    false,
  ])('skips an unavailable primary without an attempt; failover=%s', async (autoFailover) => {
    const resolveGatewayProvider = vi.fn((id: string) => {
      expect(id).toBe('ready');
      return { id, models: ['model'] } as ResolvedLLMProviderConfig;
    });
    const attempt = vi.fn(async () => 'backup-result');
    const dispatched = dispatchLogicalModel({
      logicalModel: unavailablePrimary(autoFailover),
      signal: new AbortController().signal,
      resolveGatewayProvider,
      attempt,
    });
    if (autoFailover) {
      await expect(dispatched).resolves.toBe('backup-result');
      expect(resolveGatewayProvider).toHaveBeenCalledExactlyOnceWith('ready', 'model');
      expect(attempt).toHaveBeenCalledTimes(1);
    } else {
      await expect(dispatched).rejects.toMatchObject({ code: 'gateway_logical_model_unavailable' });
      expect(resolveGatewayProvider).not.toHaveBeenCalled();
      expect(attempt).not.toHaveBeenCalled();
    }
  });
});

/** Accepted closed-kind oracle, fixed before exercising the old dispatcher. */
const decisionTable = [
  ['auth_rejected', false, true],
  ['quota_exhausted', false, true],
  ['rate_limited', true, true],
  ['provider_unavailable', true, true],
  ['context_overflow', false, false],
  ['unsupported', false, false],
  ['output_limit', false, false],
  ['refused', false, false],
  ['invalid_request', false, false],
  ['cancelled', false, false],
  ['unknown', false, false],
] as const;

describe('settled Gateway failures follow the accepted decision table', () => {
  it.each(
    decisionTable
  )('%s retries and advances independently of the routing switch', async (kind, retry, advance) => {
    vi.useFakeTimers();
    try {
      for (const autoFailover of [false, true]) {
        const model = unavailablePrimary(autoFailover);
        const ready = {
          ...model,
          routes: model.routes.map((route) => ({
            ...route,
            available: true,
            unavailableReason: null,
          })),
        };
        const calls: string[] = [];
        const attempt = vi.fn(async ({ provider }: { provider: ResolvedLLMProviderConfig }) => {
          calls.push(provider.id);
          if (provider.id === 'ready') return 'backup-result';
          throw Object.assign(new Error('private provider failure'), {
            failure: { kind, settled: true },
          });
        });
        const operation = dispatchLogicalModel({
          logicalModel: ready,
          signal: new AbortController().signal,
          resolveGatewayProvider: (id) => ({ id, models: ['model'] }) as ResolvedLLMProviderConfig,
          attempt,
        }).then(
          (result) => ({ result }),
          (error) => ({ error })
        );
        await vi.runAllTimersAsync();
        const outcome = await operation;
        expect(calls.filter((id) => id === 'missing')).toHaveLength(retry ? 4 : 1);
        expect(calls.filter((id) => id === 'ready')).toHaveLength(autoFailover && advance ? 1 : 0);
        if (autoFailover && advance) expect(outcome).toEqual({ result: 'backup-result' });
        else expect(outcome).toMatchObject({ error: { failure: { kind } } });
      }
    } finally {
      vi.useRealTimers();
    }
  });
});

import { createModels, fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { PiAiGatewayClient } from './pi-ai-client.js';
import { LLMGatewayProviderDispatcher } from './provider-dispatcher.js';

describe('real pi-ai terminal evidence reaches the same executor path', () => {
  it.each([
    ['thrown', false],
    ['terminal', false],
    ['thrown', true],
    ['terminal', true],
  ] as const)('%s failure; streaming=%s', async (source, streaming) => {
    const synthetic = fauxProvider({
      provider: 'provider',
      api: 'openai-responses',
      models: [{ id: 'model' }],
    });
    synthetic.setResponses([
      fauxAssistantMessage([], {
        stopReason: 'error',
        errorMessage: 'usage_limit_reached: allowance exhausted',
      }),
    ]);
    const thrown = vi.fn(() => {
      throw new Error('usage_limit_reached: allowance exhausted');
    });
    if (source === 'thrown') synthetic.provider.stream = thrown;
    const models = createModels();
    models.setProvider(synthetic.provider);
    const dispatcher = new LLMGatewayProviderDispatcher({
      piAiClient: new PiAiGatewayClient({ models }),
    });
    const selected: string[] = [];
    const tier = unavailablePrimary(true);
    const result = await dispatchLogicalModel({
      logicalModel: {
        ...tier,
        routes: tier.routes.map((route) => ({
          ...route,
          available: true,
          unavailableReason: null,
        })),
      },
      signal: new AbortController().signal,
      resolveGatewayProvider: (id) => ({
        id,
        adapterId: 'provider',
        apiKey: 'test',
        baseUrl: null,
        displayName: id,
        models: ['model'],
        requiresApiKey: true,
        gatewayCapabilities: { chatCompletions: 'bridged', responses: 'native' },
      }),
      attempt: async ({ provider, execution }) => {
        selected.push(provider.id);
        if (provider.id === 'ready') return 'backup';
        const context = { transport: { signal: execution.signal } };
        try {
          if (streaming)
            await execution.prepareStream(
              await dispatcher.createResponsesStream(
                provider,
                { model: 'model', input: 'hello', stream: true },
                context
              )
            );
          else
            await dispatcher.createResponses(provider, { model: 'model', input: 'hello' }, context);
        } catch (error) {
          expect(error).toMatchObject({ failure: { kind: 'quota_exhausted', settled: true } });
          throw error;
        }
        return 'unexpected primary success';
      },
    });
    expect(result).toBe('backup');
    expect(selected).toEqual(['missing', 'ready']);
    if (source === 'thrown') expect(thrown).toHaveBeenCalledTimes(1);
    else expect(synthetic.state.callCount).toBe(1);
  });
});
