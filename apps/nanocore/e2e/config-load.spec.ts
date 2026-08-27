import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type NanoCoreHarness, removeDataRoot, startNanoCoreHarness } from './_lib/harness.js';

let harness: NanoCoreHarness | null = null;
const vaultKeyFilePath = join(tmpdir(), `openkit-vault-config-e2e-${process.pid}.key`);

afterEach(async () => {
  const current = harness;
  harness = null;

  if (current) {
    await current.stop();
    await removeDataRoot(current.dataRoot);
  }
  rmSync(vaultKeyFilePath, { force: true });
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
        runtime: {
          kind: 'custom',
          adapter: 'custom-http',
          version: '0.0.2',
          image: { kind: 'reference', ref: 'openkit/worker-e2e:dev', pullPolicy: 'never' },
          binaries: [{ id: 'node', path: '/usr/local/bin/node' }],
        },
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

  it('unlocks encrypted-file vault from config and degrades safely after a wrong-key restart', async () => {
    harness = await startNanoCoreHarness({ seedDemoWorkspace: false });
    const dataRoot = harness.dataRoot;

    await harness.stop();
    writeFileSync(vaultKeyFilePath, Buffer.alloc(32, 7), { mode: 0o600 });
    writeFileSync(
      join(dataRoot, 'config', 'server.jsonc'),
      JSON.stringify({
        schemaVersion: 1,
        vault: {
          encryptedFile: { keyFilePath: vaultKeyFilePath },
        },
      })
    );

    harness = await startNanoCoreHarness({ dataRoot, seedDemoWorkspace: false });
    const available = await fetch(`${harness.baseUrl}/api/app/vault/status`);

    expect(available.status).toBe(200);
    await expect(available.json()).resolves.toMatchObject({
      backendKind: 'encrypted-file',
      state: 'available',
    });

    await harness.stop();
    writeFileSync(vaultKeyFilePath, Buffer.alloc(32, 8));
    harness = await startNanoCoreHarness({ dataRoot, seedDemoWorkspace: false });
    const locked = await fetch(`${harness.baseUrl}/api/app/vault/status`);

    expect(locked.status).toBe(200);
    await expect(locked.json()).resolves.toMatchObject({
      backendKind: 'encrypted-file',
      state: 'locked',
    });
  });
});
