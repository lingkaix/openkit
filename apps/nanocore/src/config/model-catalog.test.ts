import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  type Model,
} from '@earendil-works/pi-ai';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import type { Actor } from '../auth/identity.js';
import type { AuthVariables } from '../auth/middleware.js';
import {
  resolveEffectiveModelMetadata,
  resolveLogicalModelCatalog,
} from '../llm/logical-models.js';
import { PiAiGatewayClient } from '../llm/pi-ai-client.js';
import { resolveProviderProfileToLLMConfig } from '../providers/llm-config.js';
import { ensureLayout } from '../storage/fs-layout.js';
import { loadProviderProfiles } from './providers-loader.js';
import { createRuntimeConfigManager, loadRuntimeConfig } from './runtime-config.js';
import { RuntimeConfigFileService } from './runtime-config-files.js';
import { registerRuntimeConfigRoutes } from './runtime-config-routes.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Creates a real temporary configuration tree with a catalog-only model. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'openkit-model-catalog-'));
  roots.push(root);
  mkdirSync(join(root, 'config', 'providers'), { recursive: true });
  const profile = {
    id: 'primary',
    vendor: 'openai',
    displayName: 'Primary',
    kind: 'direct',
    models: ['future-model', 'gpt-5'],
    modelMetadata: { 'gpt-5': { cost: { input: 0 }, reasoning: false } },
  };
  const profilePath = join(root, 'config', 'providers', 'primary.provider.jsonc');
  writeFileSync(profilePath, JSON.stringify(profile));
  const catalog = {
    schemaVersion: 1,
    providers: {
      openai: {
        models: {
          'future-model': {
            limit: { context: 300000, output: 10000 },
            family: 'future',
            reasoning: true,
          },
          'gpt-5': {
            limit: { context: 300000 },
            cost: { input: 3, output: 4 },
            modalities: { input: [] },
            reasoning: true,
          },
        },
      },
    },
  };
  const path = join(root, 'config', 'model-catalog.jsonc');
  writeFileSync(path, JSON.stringify(catalog));
  writeFileSync(
    join(root, 'config', 'gateway.jsonc'),
    JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      logicalModels: [
        {
          id: 'future',
          displayName: 'Future',
          contextManagement: [{ type: 'compaction', compactThreshold: 200000 }],
          routes: [{ id: 'primary', providerProfileId: 'primary', providerModel: 'future-model' }],
        },
      ],
    })
  );
  return { root, path, profilePath, profile, catalog };
}

describe('deployment model extension catalog', () => {
  it('resolves snapshot → extension → profile without changing authored or vendored bytes', () => {
    const { root, profilePath } = fixture();
    const snapshotPath = new URL(
      '../../../../packages/models-dev-catalog/snapshots/2026-09-17/api.json',
      import.meta.url
    );
    const before = readFileSync(snapshotPath, 'utf8');
    const authored = readFileSync(profilePath, 'utf8');
    const runtime = loadRuntimeConfig(root);
    expect(runtime.diagnostics.filter((entry) => entry.severity === 'error')).toEqual([]);
    const profile = runtime.providerRegistry.get('primary')!;
    expect(resolveEffectiveModelMetadata(profile, 'future-model').limit).toEqual({
      context: 300000,
      output: 10000,
    });
    expect(resolveEffectiveModelMetadata(profile, 'gpt-5')).toMatchObject({
      reasoning: false,
      modalities: { input: [] },
      limit: { context: 300000, output: 128000 },
      cost: { input: 0, output: 4 },
    });
    expect(
      resolveLogicalModelCatalog(runtime.gatewayConfig, runtime.providerRegistry)[0]
    ).toMatchObject({
      id: 'future',
      modelFamilyId: 'future',
      capabilities: expect.arrayContaining(['reasoning']),
    });
    expect(readFileSync(snapshotPath, 'utf8')).toBe(before);
    expect(readFileSync(profilePath, 'utf8')).toBe(authored);
    expect(JSON.parse(before).openai.models['future-model']).toBeUndefined();
  });

  it('edits through the generic file service and retains active metadata until restart', () => {
    const { root, path, catalog } = fixture();
    const manager = createRuntimeConfigManager({ dataRoot: root });
    const service = new RuntimeConfigFileService({
      dataRoot: root,
      workspaceIds: [],
      userId: 'admin',
      runtimeConfigManager: manager,
      readRuntimeConfigStatus: () => manager.status(),
    });
    expect(service.listFiles().files).toContainEqual(
      expect.objectContaining({ id: 'model-catalog.jsonc', kind: 'model-catalog' })
    );
    expect(service.schemaCatalog().schemas.some((entry) => entry.kind === 'model-catalog')).toBe(
      true
    );
    const revision = service.readFile('model-catalog.jsonc').file.revision;
    catalog.providers.openai.models['future-model'].limit.context = 280000;
    const content = JSON.stringify(catalog);
    expect(
      service.validate({ files: [{ id: 'model-catalog.jsonc', kind: 'model-catalog', content }] })
        .valid
    ).toBe(true);
    service.updateFile({
      id: 'model-catalog.jsonc',
      kind: 'model-catalog',
      content,
      expectedRevision: revision,
    });
    expect(() =>
      service.updateFile({
        id: 'model-catalog.jsonc',
        kind: 'model-catalog',
        content,
        expectedRevision: revision,
      })
    ).toThrow();
    expect(manager.reload({ mode: 'safe', dryRun: false }).plan.requiresRestart).toContainEqual(
      expect.objectContaining({ path: 'modelCatalog' })
    );
    expect(
      resolveEffectiveModelMetadata(
        manager.current().providerRegistry.get('primary')!,
        'future-model'
      ).limit?.context
    ).toBe(300000);
    expect(
      resolveEffectiveModelMetadata(
        loadRuntimeConfig(root).providerRegistry.get('primary')!,
        'future-model'
      ).limit?.context
    ).toBe(280000);
    const active = manager.current();
    writeFileSync(
      path,
      '{"schemaVersion":1,"providers":{"openai":{"models":{"bad":{"limit":{"context":0}}}}}}'
    );
    expect(manager.reload({ mode: 'safe', dryRun: false }).status).toBe('failed');
    expect(manager.current()).toBe(active);
  });
  it('creates catalog files through the generic service and rejects malformed writes without changing bytes', () => {
    const { root, path } = fixture();
    const manager = createRuntimeConfigManager({ dataRoot: root });
    const service = new RuntimeConfigFileService({
      dataRoot: root,
      workspaceIds: [],
      userId: 'admin',
      runtimeConfigManager: manager,
      readRuntimeConfigStatus: () => manager.status(),
    });
    rmSync(path);
    service.createFile({ id: 'model-catalog.jsonc', kind: 'model-catalog' });
    const before = readFileSync(path, 'utf8');
    expect(JSON.parse(before)).toEqual({ schemaVersion: 1, providers: {} });
    const content =
      '{"schemaVersion":1,"providers":{"openai":{"models":{"bad":{"cost":{"input":-1}}}}}}';
    expect(
      service.validate({ files: [{ id: 'model-catalog.jsonc', content }], mode: 'safe' }).valid
    ).toBe(false);
    expect(() =>
      service.updateFile({
        id: 'model-catalog.jsonc',
        kind: 'model-catalog',
        content,
        expectedRevision: service.readFile('model-catalog.jsonc').file.revision,
      })
    ).toThrow();
    expect(() =>
      service.createFile({ id: '../model-catalog.jsonc', kind: 'model-catalog' })
    ).toThrow();
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('keeps unused catalog edits restart-required and rejects strict reload without changing the active snapshot', () => {
    const { root, path, catalog } = fixture();
    const manager = createRuntimeConfigManager({ dataRoot: root });
    const active = manager.current();
    writeFileSync(
      path,
      JSON.stringify({
        ...catalog,
        providers: { ...catalog.providers, other: { models: { unused: { reasoning: true } } } },
      })
    );
    const result = manager.reload({ mode: 'strict', dryRun: false });
    expect(result.status).toBe('rejected');
    expect(result.plan.requiresRestart.map((change) => change.path)).toEqual(['modelCatalog']);
    expect(manager.current()).toBe(active);
    manager.reload({ mode: 'safe', dryRun: false });
    expect(manager.current().modelCatalog).toEqual(active.modelCatalog);
    expect(manager.current().providerRegistry).toBe(active.providerRegistry);
  });

  it('does not match another vendor or a shortened native ID and rejects removal of required context', () => {
    const { root, path, profilePath, profile } = fixture();
    const manager = createRuntimeConfigManager({ dataRoot: root });
    const active = manager.current();
    rmSync(path);
    expect(manager.reload({ mode: 'safe', dryRun: false }).status).toBe('failed');
    expect(manager.current()).toBe(active);
    writeFileSync(
      path,
      JSON.stringify({
        schemaVersion: 1,
        providers: {
          different: { models: { 'future-model': { limit: { context: 300000 } } } },
          openai: { models: { model: { limit: { context: 300000 } } } },
        },
      })
    );
    expect(
      resolveEffectiveModelMetadata(loadProviderProfiles(root).profiles[0]!, 'future-model').limit
    ).toBeUndefined();
    writeFileSync(profilePath, JSON.stringify({ ...profile, vendor: undefined }));
    writeFileSync(
      path,
      JSON.stringify({
        schemaVersion: 1,
        providers: { primary: { models: { 'future-model': { limit: { context: 320000 } } } } },
      })
    );
    expect(
      resolveEffectiveModelMetadata(loadProviderProfiles(root).profiles[0]!, 'future-model').limit
        ?.context
    ).toBe(320000);
  });

  it.each([
    'openai-codex',
    'openai_codex',
  ])('passes catalog-only %s context 268000 through the shared resolver and request-local adapter, then a smaller profile overlay wins', async (vendor) => {
    const { root, path, profilePath } = fixture();
    const nativeId = 'openai-codex/future-subscription-model';
    const catalogOnlyProfile = {
      id: 'primary',
      vendor,
      displayName: 'Subscription',
      kind: 'oauth',
      models: [nativeId],
      extensions: { openkit: { subscriptionAccount: { accountSlotId: 'work' } } },
    };
    writeFileSync(profilePath, JSON.stringify(catalogOnlyProfile));
    writeFileSync(
      path,
      JSON.stringify({
        schemaVersion: 1,
        providers: {
          [vendor]: {
            models: {
              [nativeId]: {
                limit: { context: 268000, output: 10000 },
                reasoning: true,
                cost: { input: 2, output: 3, cache_read: 0, cache_write: 0 },
              },
            },
          },
        },
      })
    );
    const catalogOnly = loadProviderProfiles(root).profiles[0]!;
    expect(resolveEffectiveModelMetadata(catalogOnly, nativeId).limit?.context).toBe(268000);
    let seen: Model<string> | undefined;
    const faux = fauxProvider({
      api: 'openai-codex-responses',
      provider: 'openai-codex',
      models: [{ id: 'stock-fixture' }],
    });
    const models = createModels();
    models.setProvider({ ...faux.provider, baseUrl: openaiCodexProvider().baseUrl });
    const stock = models.getModels('openai-codex');
    faux.setResponses([
      (_context, _options, _state, model) => {
        seen = model;
        return fauxAssistantMessage('Catalog response');
      },
    ]);
    const observed: unknown[] = [];
    const client = new PiAiGatewayClient();
    await client.createChatCompletion(
      resolveProviderProfileToLLMConfig(catalogOnly),
      { model: nativeId, messages: [{ role: 'user', content: 'Hello' }] },
      (usage) => observed.push(usage),
      {},
      models
    );
    expect(seen).toMatchObject({
      id: 'future-subscription-model',
      contextWindow: 268000,
      maxTokens: 10000,
      reasoning: true,
      cost: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0 },
    });
    expect(observed).toHaveLength(1);
    const usage = observed[0] as { input: number; output: number; cost: { total: number } };
    expect(usage.input).toBeGreaterThan(0);
    expect(usage.cost.total).toBeCloseTo((2 * usage.input + 3 * usage.output) / 1_000_000, 12);
    expect(models.getModels('openai-codex')).toEqual(stock);
    expect(models.getModel('openai-codex', 'future-subscription-model')).toBeUndefined();

    writeFileSync(
      profilePath,
      JSON.stringify({
        ...catalogOnlyProfile,
        modelMetadata: { [nativeId]: { limit: { context: 100000 } } },
      })
    );
    const overlay = loadProviderProfiles(root).profiles[0]!;
    expect(resolveEffectiveModelMetadata(overlay, nativeId).limit?.context).toBe(100000);
    seen = undefined;
    faux.setResponses([
      (_context, _options, _state, model) => {
        seen = model;
        return fauxAssistantMessage('Overlay response');
      },
    ]);
    await client.createChatCompletion(
      resolveProviderProfileToLLMConfig(overlay),
      { model: nativeId, messages: [{ role: 'user', content: 'Hello' }] },
      () => undefined,
      {},
      models
    );
    expect(seen).toMatchObject({
      id: 'future-subscription-model',
      contextWindow: 100000,
    });
    expect(models.getModels('openai-codex')).toEqual(stock);
    expect(models.getModel('openai-codex', 'future-subscription-model')).toBeUndefined();
  });

  it('seeds an editable empty catalog without replacing an admin edit', () => {
    const { root, path } = fixture();
    rmSync(path);
    ensureLayout(root);
    expect(JSON.parse(readFileSync(path, 'utf8').replace(/^\s*\/\/.*$/gm, ''))).toEqual({
      schemaVersion: 1,
      providers: {},
    });
    const content = '{"schemaVersion":1,"providers":{"custom":{"models":{}}}}';
    writeFileSync(path, content);
    ensureLayout(root);
    expect(readFileSync(path, 'utf8')).toBe(content);
  });

  it.each([
    { kind: 'session', userId: 'member' },
    { kind: 'token', userId: 'member', tokenScope: 'workspace', tokenWorkspaceIds: ['workspace'] },
    { kind: 'token', userId: 'admin', tokenScope: 'server-admin' },
    { kind: 'session', userId: 'admin', adminTokenId: 'admin-token' },
  ] as Actor[])('enforces deployment authority before generic catalog access for %j', async (actor) => {
    const { root, path } = fixture();
    const manager = createRuntimeConfigManager({ dataRoot: root });
    const service = new RuntimeConfigFileService({
      dataRoot: root,
      workspaceIds: [],
      userId: actor.userId,
      runtimeConfigManager: manager,
      readRuntimeConfigStatus: () => manager.status(),
    });
    const app = new Hono<{ Variables: AuthVariables }>();
    app.use('*', async (context, next) => {
      context.set('actor', actor);
      await next();
    });
    registerRuntimeConfigRoutes({
      app,
      runtimeConfigFileService: () => service,
      runtimeConfigManager: manager,
    });
    const authorized = actor.tokenScope === 'server-admin' || actor.adminTokenId !== undefined;
    const read = await app.request('/api/admin/config/file?id=model-catalog.jsonc');
    expect(read.status).toBe(authorized ? 200 : 403);
    const before = readFileSync(path, 'utf8');
    const content = '{"schemaVersion":1,"providers":{}}';
    const response = await app.request('/api/admin/config/file', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'model-catalog.jsonc',
        kind: 'model-catalog',
        content,
        expectedRevision: service.readFile('model-catalog.jsonc').file.revision,
      }),
    });
    expect(response.status).toBe(authorized ? 200 : 403);
    expect(readFileSync(path, 'utf8')).toBe(authorized ? content : before);
  });
});
