import { describe, expect, it } from 'vitest';

import type { OpenKitConfig } from '../config/openkit-config.js';
import { resolveDefaultProviderStates } from './default-provider.js';
import { ProviderRegistry } from './registry.js';

/**
 * Creates a provider registry with local providers that do not require credentials.
 *
 * @returns Provider registry keyed by configured provider IDs.
 */
function createRegistry(): ProviderRegistry {
  return new ProviderRegistry([
    {
      displayName: 'Core Provider',
      id: 'core-openrouter',
      kind: 'local',
      models: ['openai/gpt-5.1'],
    },
    {
      displayName: 'Gateway Provider',
      id: 'agent-openrouter',
      kind: 'local',
      models: ['openai/gpt-5.1'],
    },
  ]);
}

/**
 * Resolves default provider states for one config.
 *
 * @param config OpenKit config to inspect.
 * @returns Resolved default provider states.
 */
function resolve(config: OpenKitConfig): ReturnType<typeof resolveDefaultProviderStates> {
  return resolveDefaultProviderStates(config, createRegistry());
}

describe('resolveDefaultProviderStates', () => {
  it('resolves both canonical core and gateway defaults when both are set', () => {
    expect(
      resolve({
        defaults: {
          coreProviderId: 'core-openrouter',
          coreModel: 'openai/gpt-5.1',
          gatewayProviderId: 'agent-openrouter',
          gatewayModel: 'openai/gpt-5.1',
        },
      })
    ).toEqual({
      core: {
        configured: true,
        model: 'openai/gpt-5.1',
        origin: 'canonical',
        providerId: 'core-openrouter',
      },
      gateway: {
        configured: true,
        model: 'openai/gpt-5.1',
        origin: 'canonical',
        providerId: 'agent-openrouter',
      },
    });
  });

  it('does not use the core default as an implicit gateway default', () => {
    expect(resolve({ defaults: { coreProviderId: 'core-openrouter' } })).toEqual({
      core: {
        configured: true,
        model: null,
        origin: 'canonical',
        providerId: 'core-openrouter',
      },
      gateway: {
        configured: false,
        origin: 'unset',
        reason: 'unset',
      },
    });
  });

  it('does not use the gateway default as an implicit core default', () => {
    expect(resolve({ defaults: { gatewayProviderId: 'agent-openrouter' } })).toEqual({
      core: {
        configured: false,
        origin: 'unset',
        reason: 'unset',
      },
      gateway: {
        configured: true,
        model: null,
        origin: 'canonical',
        providerId: 'agent-openrouter',
      },
    });
  });
});
