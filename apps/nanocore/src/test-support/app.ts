import { type CreateAppOptions, createApp as createNanoCoreApp } from '../app.js';
import { SimulatedTurnExecutor } from '../lib/simulator.js';
import { ProviderRegistry } from '../providers/registry.js';
import { createTestAgentSetup, createTestGatewayConfig } from './agent-environment.js';
import { admitTestNativeEnvironment } from './native-environment.js';

export type { CreateAppOptions } from '../app.js';

/**
 * Creates a NanoCore app with an explicit deterministic executor for unit tests.
 *
 * @param options Production app options, including an optional executor override.
 * @returns NanoCore app configured for deterministic unit tests.
 */
export function createApp(options: CreateAppOptions = {}): ReturnType<typeof createNanoCoreApp> {
  if (options.coreDb) {
    admitTestNativeEnvironment(options.coreDb, createTestAgentSetup().manifest);
    for (const manifest of options.agentManifests ??
      options.runtimeConfigManager?.current().agentManifests ??
      [])
      admitTestNativeEnvironment(options.coreDb, manifest);
  }
  const ownsRuntimeConfig = !options.runtimeConfigManager && !options.gatewayConfig;
  const defaultProviderRegistry = new ProviderRegistry([
    {
      defaultModel: 'openai/gpt-5.2',
      displayName: 'Test inference provider',
      id: 'agent-openrouter',
      kind: 'local',
      models: ['openai/gpt-5.2'],
    },
  ]);
  const providerSupportsDefaultGateway =
    !options.providerRegistry ||
    options.providerRegistry.get('agent-openrouter')?.models.includes('openai/gpt-5.2') === true;
  return createNanoCoreApp({
    ...(ownsRuntimeConfig && providerSupportsDefaultGateway
      ? { gatewayConfig: createTestGatewayConfig() }
      : {}),
    ...(ownsRuntimeConfig && !options.providerRegistry
      ? { providerRegistry: defaultProviderRegistry }
      : {}),
    turnExecutor: new SimulatedTurnExecutor(),
    ...options,
  });
}
