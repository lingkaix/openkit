import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeGatewayPlan, planLogicalModel } from '../llm/gateway-execution.js';
import { resolveLogicalModelCatalog } from '../llm/logical-models.js';
import { createRuntimeConfigManager, loadRuntimeConfig } from './runtime-config.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Authored files include one catalogued model and one model whose metadata disappeared. */
function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-context-isolation-'));
  roots.push(dataRoot);
  mkdirSync(join(dataRoot, 'config', 'providers'), { recursive: true });
  writeFileSync(join(dataRoot, 'config', 'server.jsonc'), JSON.stringify({ schemaVersion: 1 }));
  writeFileSync(
    join(dataRoot, 'config', 'providers', 'mixed.provider.jsonc'),
    JSON.stringify({
      schemaVersion: 1,
      id: 'mixed',
      displayName: 'Mixed metadata',
      kind: 'custom',
      vendor: 'openrouter',
      baseUrl: 'http://127.0.0.1:9/v1',
      models: ['openai/gpt-5.1', 'handwritten/metadata-lost'],
    })
  );
  writeFileSync(
    join(dataRoot, 'config', 'gateway.jsonc'),
    JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      defaultLogicalModelId: 'healthy',
      logicalModels: ['healthy', 'metadata-lost'].map((id) => ({
        id,
        displayName: id,
        contextManagement: [{ type: 'compaction', compactThreshold: 8_000 }],
        routes: [
          {
            id: 'primary',
            providerProfileId: 'mixed',
            providerModel: id === 'healthy' ? 'openai/gpt-5.1' : 'handwritten/metadata-lost',
          },
        ],
      })),
    })
  );
  return dataRoot;
}

describe('unknown model context isolation (T5)', () => {
  it('admits a mixed profile with a warning and refuses only the unroutable model before dispatch', async () => {
    const dataRoot = fixture();
    const snapshot = loadRuntimeConfig(dataRoot, { version: 1 });
    expect(snapshot.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'provider.unknown_model_context',
        severity: 'warning',
      })
    );
    expect(snapshot.diagnostics.filter((row) => row.severity === 'error')).toEqual([]);
    const manager = createRuntimeConfigManager({ dataRoot, initialSnapshot: snapshot });
    const models = resolveLogicalModelCatalog(
      manager.current().gatewayConfig,
      manager.current().providerRegistry
    );
    const healthy = models.find((model) => model.id === 'healthy')!;
    const unavailable = models.find((model) => model.id === 'metadata-lost')!;
    expect(healthy.routes[0]).toMatchObject({ available: true, unavailableReason: null });
    expect(unavailable.routes[0]).toMatchObject({
      available: false,
      unavailableReason: 'provider_not_dispatchable',
    });
    expect(unavailable.contract?.context).toBeNull();
    const contact = vi.fn(async () => 'healthy response');
    await expect(
      executeGatewayPlan({
        selections: planLogicalModel(healthy, [], () => true),
        autoFailover: healthy.autoFailover,
        signal: new AbortController().signal,
        attempt: contact,
      })
    ).resolves.toBe('healthy response');
    contact.mockClear();
    await expect(
      executeGatewayPlan({
        selections: planLogicalModel(unavailable, [], () => true),
        autoFailover: unavailable.autoFailover,
        signal: new AbortController().signal,
        attempt: contact,
      })
    ).rejects.toMatchObject({ code: 'gateway_logical_model_unavailable', status: 503 });
    expect(contact).not.toHaveBeenCalled();
  });

  it('continues rejecting a known context bound that cannot fit its authored compaction policy', () => {
    const dataRoot = fixture();
    writeFileSync(
      join(dataRoot, 'config', 'providers', 'mixed.provider.jsonc'),
      JSON.stringify({
        schemaVersion: 1,
        id: 'mixed',
        displayName: 'Mixed metadata',
        kind: 'custom',
        vendor: 'openrouter',
        models: ['openai/gpt-5.1', 'handwritten/metadata-lost'],
        modelMetadata: { 'handwritten/metadata-lost': { limit: { context: 7_000 } } },
      })
    );
    expect(loadRuntimeConfig(dataRoot, { version: 1 }).diagnostics).toContainEqual(
      expect.objectContaining({ code: 'gateway.invalid_logical_model', severity: 'error' })
    );
  });
});
