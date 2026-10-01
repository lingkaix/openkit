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
