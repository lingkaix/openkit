import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  resolveEffectiveModelMetadata,
  resolveLogicalModelCatalog,
} from '../llm/logical-models.js';
import { createRuntimeConfigManager, loadRuntimeConfig } from './runtime-config.js';
import { RuntimeConfigFileService } from './runtime-config-files.js';

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
      '../../../../packages/models-dev-catalog/snapshots/2026-07-11/api.json',
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
    expect(manager.reload({ mode: 'safe' }).plan.requiresRestart).toContainEqual(
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
    expect(manager.reload({ mode: 'safe' }).status).toBe('rejected');
    expect(manager.current()).toBe(active);
  });
});
