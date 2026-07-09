import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type NanoCoreHarness, removeDataRoot, startNanoCoreHarness } from './_lib/harness.js';

let harness: NanoCoreHarness | null = null;

afterEach(async () => {
  const current = harness;
  harness = null;

  if (current) {
    await current.stop();
    await removeDataRoot(current.dataRoot);
  }
});

describe('nanocore e2e config loading', () => {
  it('loads seeded provider and agent files through diagnostics', async () => {
    harness = await startNanoCoreHarness();
    const providerRoot = join(harness.dataRoot, 'config', 'providers');
    const agentRoot = join(harness.dataRoot, 'config', 'agents');

    writeFileSync(
      join(providerRoot, 'e2e.provider.jsonc'),
      JSON.stringify({
        id: 'provider_e2e',
        displayName: 'E2E Provider',
        kind: 'local',
        baseUrl: 'https://provider.example.com/v1',
        models: ['model-e2e'],
        defaultModel: 'model-e2e',
        readiness: { status: 'ready' },
      })
    );
    writeFileSync(
      join(agentRoot, 'e2e.agent.jsonc'),
      JSON.stringify({
        schemaVersion: 1,
        id: 'agent_e2e',
        displayName: 'E2E Agent',
        runtime: { kind: 'custom', adapter: 'custom-http', version: '0.0.2' },
        mode: 'local',
        deployment: { local: {} },
        readiness: { status: 'ready' },
      })
    );

    await harness.stop();
    harness = await startNanoCoreHarness({ dataRoot: harness.dataRoot });

    const diagnostics = (await (await fetch(`${harness.baseUrl}/api/diagnostics`)).json()) as {
      providers: Array<{ id: string }>;
      agents: Array<{ id: string; readiness: string }>;
    };

    expect(diagnostics.providers).toContainEqual(expect.objectContaining({ id: 'provider_e2e' }));
    expect(diagnostics.agents).toContainEqual(
      expect.objectContaining({ id: 'agent_e2e', readiness: 'ready' })
    );
  });

  it('copies template provider and agent files into an empty data root', async () => {
    harness = await startNanoCoreHarness();

    expect(
      existsSync(join(harness.dataRoot, 'config', 'providers', 'openai-default.provider.jsonc'))
    ).toBe(true);
    expect(existsSync(join(harness.dataRoot, 'config', 'agents', 'codex.agent.jsonc'))).toBe(true);
    expect(
      existsSync(join(harness.dataRoot, 'config', 'agents', 'opencode-server.agent.jsonc'))
    ).toBe(true);
    expect(existsSync(join(harness.dataRoot, 'config', 'agents', 'simulator.agent.jsonc'))).toBe(
      false
    );
  });
});
