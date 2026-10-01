import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppDiagnosticsResponseSchema } from '@openkit/app-api-schemas';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRuntimeConfigManager } from './config/runtime-config.js';
import type { ProviderSubscriptionAccountManager } from './llm/provider-subscription-accounts.js';
import { createApp } from './test-support/app.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Builds real authored files so active provenance and restart retention use the production loader. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'gateway-settings-'));
  roots.push(root);
  mkdirSync(join(root, 'config', 'providers'), { recursive: true });
  writeFileSync(
    join(root, 'config', 'server.jsonc'),
    JSON.stringify({ schemaVersion: 1, mode: 'local' })
  );
  const profile = {
    id: 'codex',
    displayName: 'Codex',
    kind: 'oauth',
    vendor: 'openai_codex',
    models: ['openai-codex/gpt-5', 'unlisted-model'],
    extensions: { openkit: { subscriptionAccount: { accountSlotId: 'work' } } },
    modelMetadata: {
      'openai-codex/gpt-5': { reasoning: false, cost: { input: 0 }, modalities: { output: [] } },
    },
  };
  const profilePath = join(root, 'config', 'providers', 'codex.provider.jsonc');
  writeFileSync(profilePath, JSON.stringify(profile));
  const catalogPath = join(root, 'config', 'model-catalog.jsonc');
  const catalog = {
    schemaVersion: 1,
    providers: {
      openai_codex: {
        models: {
          'openai-codex/gpt-5': {
            limit: { context: 300000 },
            modalities: { input: [] },
            reasoning_options: [{ type: 'effort', values: ['high', 'low'] }],
          },
          'unlisted-model': { limit: { context: 50000 }, reasoning: true, reasoning_options: [] },
        },
      },
    },
  };
  writeFileSync(catalogPath, JSON.stringify(catalog));
  writeFileSync(
    join(root, 'config', 'gateway.jsonc'),
    JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      logicalModels: [
        {
          id: 'tier',
          displayName: 'Tier',
          contextManagement: [{ type: 'compaction', compactThreshold: 8000 }],
          routing: { autoFailover: false },
          routes: [
            { id: 'primary', providerProfileId: 'missing', providerModel: 'missing' },
            { id: 'backup', providerProfileId: 'codex', providerModel: 'openai-codex/gpt-5' },
          ],
        },
      ],
    })
  );
  const manager = createRuntimeConfigManager({ dataRoot: root });
  const app = createApp({ dataRoot: root, runtimeConfigManager: manager });
  return { app, manager, profile, profilePath, catalog, catalogPath };
}

describe('Gateway settings active diagnostics', () => {
  it('projects active binding, exact catalog key, every leaf source, unknown, false, zero and empty arrays', async () => {
    const { app } = fixture();
    const response = await app.request('/api/app/diagnostics');
    expect(response.status).toBe(200);
    const body = AppDiagnosticsResponseSchema.parse(await response.json());
    expect(body.providers.registry[0]).toMatchObject({
      subscriptionAccount: { subscriptionProviderId: 'openai-codex', accountSlotId: 'work' },
      metadataKey: 'openai_codex',
    });
    expect(body.providers.registry[0]?.modelDetails?.[0]).toMatchObject({
      id: 'openai-codex/gpt-5',
      context: { value: 300000, source: 'deployment-extension' },
      output: { value: 128000, source: 'upstream-snapshot' },
      inputModalities: { value: [], source: 'deployment-extension' },
      outputModalities: { value: [], source: 'profile-override' },
      reasoning: { value: false, source: 'profile-override' },
      reasoningEffortLevels: { value: [], source: 'deployment-extension' },
      cost: { input: { value: 0, source: 'profile-override' } },
    });
    expect(body.providers.registry[0]?.modelDetails?.[1]).toMatchObject({
      output: { value: null, source: null },
      inputModalities: { value: null, source: null },
      reasoningEffortLevels: { value: [], source: 'deployment-extension' },
    });
    expect(JSON.stringify(body)).not.toMatch(
      /secretRef|accessToken|refreshToken|modelMetadata|account\.json/
    );
  });

  it('retains the active binding and metadata during pending restart and exposes ordered unavailable routes', async () => {
    const { app, manager, profile, profilePath, catalog, catalogPath } = fixture();
    writeFileSync(
      profilePath,
      JSON.stringify({
        ...profile,
        extensions: { openkit: { subscriptionAccount: { accountSlotId: 'later' } } },
      })
    );
    catalog.providers.openai_codex.models['openai-codex/gpt-5'].limit.context = 280000;
    writeFileSync(catalogPath, JSON.stringify(catalog));
    const reload = manager.reload({ mode: 'safe', dryRun: false });
    expect(reload.status).toBe('applied');
    const body = await (await app.request('/api/app/diagnostics')).json();
    expect(body.runtimeConfig.pendingRestart.map((entry: { path: string }) => entry.path)).toEqual([
      'modelCatalog',
      'providers',
    ]);
    expect(body.providers.registry[0].subscriptionAccount.accountSlotId).toBe('work');
    expect(body.providers.registry[0].modelDetails[0].context.value).toBe(300000);
    expect(body.gateway.models[0]).toMatchObject({
      autoFailover: false,
      contract: { context: 300000, output: 128000, inputModalities: [], reasoning: false },
      routes: [
        {
          id: 'primary',
          providerProfileId: 'missing',
          available: false,
          unavailableReason: 'provider_profile_absent',
        },
        { id: 'backup', providerProfileId: 'codex' },
      ],
    });
    const discovery = await (await app.request('/v1/models')).json();
    expect(JSON.stringify(discovery)).not.toMatch(
      /routes|codex|accountSlotId|autoFailover|contract/
    );
  });

  it('keeps the deployment-admin gate ahead of the new reads', async () => {
    const { manager } = fixture();
    const app = createApp({
      runtimeConfigManager: manager,
      mode: 'server',
      auth: {
        api: {
          getSession: async () => ({ session: { id: 'private-session' }, user: { id: 'member' } }),
        },
        handler: async () => new Response(),
      },
    });
    const response = await app.request('/api/app/diagnostics');
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'diagnostics_admin_forbidden' });
  });
});

it('uses the existing network-free pair check for exact active subscription binding', async () => {
  const { manager } = fixture();
  const gatewayUnavailableReason = vi.fn().mockReturnValue('subscription_account_logged_out');
  const accountManager = {
    gatewayUnavailableReason,
  } as unknown as ProviderSubscriptionAccountManager;
  const app = createApp({
    runtimeConfigManager: manager,
    providerSubscriptionAccountManager: accountManager,
  });
  const response = await app.request('/api/app/diagnostics');
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(gatewayUnavailableReason).toHaveBeenCalledWith({
    subscriptionProviderId: 'openai-codex',
    accountSlotId: 'work',
  });
  expect(body.gateway.models[0].routes[1]).toMatchObject({
    available: false,
    unavailableReason: 'subscription_account_logged_out',
  });
});
