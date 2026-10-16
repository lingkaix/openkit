import type { GatewayConfig, ProviderProfile } from '@openkit/config-schema';
import { Hono } from 'hono';
import { expect, it, vi } from 'vitest';
import type { AuthVariables } from '../auth/middleware.js';
import type { RuntimeConfigSnapshot } from '../config/runtime-config.js';
import { type ProviderCredentialConfigured, ProviderRegistry } from '../providers/registry.js';
import { registerLlmGatewayRoutes } from './gateway-routes.js';
import type { LLMGatewayProviderDispatcher } from './provider-dispatcher.js';

type PrimarySupply = 'ready' | 'absent' | 'missing-api-key';

/** Exercises discovery with the real catalog and planner, without Provider or credential effects. */
function fixture(primary: PrimarySupply, backup: boolean, autoFailover?: boolean) {
  const config: GatewayConfig = {
    schemaVersion: 1,
    enabled: true,
    defaultLogicalModelId: 'logical',
    requiredFeatures: [],
    logicalModels: [
      {
        id: 'logical',
        displayName: 'Logical model',
        ...(autoFailover === undefined ? {} : { routing: { autoFailover } }),
        contextManagement: [{ type: 'compaction', compactThreshold: 8_000 }],
        routes: [
          { id: 'primary', providerProfileId: 'primary', providerModel: 'native-primary' },
          { id: 'backup', providerProfileId: 'backup', providerModel: 'native-backup' },
        ],
      },
    ],
  };
  const profiles: ProviderProfile[] = [];
  if (primary !== 'absent')
    profiles.push({
      id: 'primary',
      displayName: 'Primary',
      kind: 'gateway',
      vendor: 'openai',
      secretRef: 'test:primary',
      models: ['native-primary'],
      modelMetadata: { 'native-primary': { limit: { context: 128_000 } } },
    });
  if (backup)
    profiles.push({
      id: 'backup',
      displayName: 'Backup',
      kind: 'local',
      vendor: 'ollama',
      models: ['native-backup'],
      modelMetadata: { 'native-backup': { limit: { context: 128_000 } } },
    });
  const providerCredentialConfigured = vi.fn<ProviderCredentialConfigured>(
    (secretRef) => secretRef !== 'test:primary' || primary !== 'missing-api-key'
  );
  const resolveGatewayProvider = vi.fn(() => {
    throw new Error('Discovery must not resolve secret-bearing Provider configuration.');
  });
  const app = new Hono<{ Variables: AuthVariables }>();
  registerLlmGatewayRoutes({
    app,
    providerCredentialConfigured,
    resolveGatewayProvider,
    llmGatewayDispatcher: {} as LLMGatewayProviderDispatcher,
    runtimeConfig: () =>
      ({
        gatewayConfig: config,
        providerRegistry: new ProviderRegistry(profiles),
      }) as RuntimeConfigSnapshot,
  });
  return { app, config, resolveGatewayProvider };
}

it.each([
  { primary: 'absent', backup: true, autoFailover: false, visible: false },
  { primary: 'absent', backup: true, autoFailover: true, visible: true },
  { primary: 'absent', backup: true, autoFailover: undefined, visible: true },
  { primary: 'missing-api-key', backup: true, autoFailover: false, visible: false },
  { primary: 'missing-api-key', backup: true, autoFailover: true, visible: true },
  { primary: 'ready', backup: false, autoFailover: false, visible: true },
  { primary: 'ready', backup: false, autoFailover: true, visible: true },
  { primary: 'absent', backup: false, autoFailover: false, visible: false },
  { primary: 'absent', backup: false, autoFailover: true, visible: false },
] as const)('advertises $primary primary with backup=$backup and failover=$autoFailover: $visible', async (scenario) => {
  const f = fixture(scenario.primary, scenario.backup, scenario.autoFailover);
  const response = await f.app.request('/v1/models');
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.object).toBe('list');
  expect(body.data.map((model: { id: string }) => model.id)).toEqual(
    scenario.visible ? ['logical'] : []
  );
  if (scenario.visible)
    expect(body.data[0]).toMatchObject({
      id: 'logical',
      object: 'model',
      display_name: 'Logical model',
      owned_by: 'openkit',
    });
  expect(f.resolveGatewayProvider).not.toHaveBeenCalled();
  expect(JSON.stringify(body)).not.toMatch(/native-primary|native-backup|test:primary/);
});

it('recomputes discovery from the current routing switch', async () => {
  const f = fixture('absent', true, false);
  const ids = async () =>
    (await (await f.app.request('/v1/models')).json()).data.map(
      (model: { id: string }) => model.id
    );
  expect(await ids()).toEqual([]);
  f.config.logicalModels[0]!.routing = { autoFailover: true };
  expect(await ids()).toEqual(['logical']);
  f.config.logicalModels[0]!.routing = { autoFailover: false };
  expect(await ids()).toEqual([]);
  expect(f.resolveGatewayProvider).not.toHaveBeenCalled();
});
