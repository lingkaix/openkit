import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

describe('nanocore e2e agent readiness', () => {
  it('updates readiness when local agent configs change', async () => {
    const emptyBin = join(tmpdir(), `openkit-empty-bin-${Date.now()}`);

    mkdirSync(emptyBin, { recursive: true });
    const env = {
      OPENAI_API_KEY: 'openkit-e2e-openai-key',
      OPENROUTER_API_KEY: 'openkit-e2e-openrouter-key',
      PATH: emptyBin,
    };

    harness = await startNanoCoreHarness({ env });

    let diagnostics = await readDiagnostics(harness.baseUrl);

    expect(diagnostics.agents).toContainEqual(
      expect.objectContaining({ id: 'agent_codex_host', readiness: 'degraded' })
    );
    expect(diagnostics.agents).toContainEqual(
      expect.objectContaining({ id: 'agent_opencode_server', readiness: 'degraded' })
    );

    const dataRoot = harness.dataRoot;
    rmSync(join(dataRoot, 'config', 'agents', 'opencode-server.agent.jsonc'));
    await harness.stop();
    harness = await startNanoCoreHarness({ dataRoot, env });
    diagnostics = await readDiagnostics(harness.baseUrl);

    expect(diagnostics.agents.map((agent) => agent.id)).not.toContain('agent_opencode_server');

    writeFileSync(
      join(dataRoot, 'config', 'agents', 'opencode-server.agent.jsonc'),
      JSON.stringify({
        schemaVersion: 1,
        id: 'agent_opencode_server',
        displayName: 'OpenCode Server Agent',
        runtime: { kind: 'opencode', adapter: 'opencode-server', version: '0.0.2' },
        mode: 'local',
        deployment: { local: { command: 'opencode', args: ['serve'] } },
        provider: { ref: 'openrouter', model: 'openai/gpt-5.1' },
        readiness: {
          status: 'unknown',
          message: 'OpenCode server availability has not been probed yet.',
        },
      })
    );
    await harness.stop();
    harness = await startNanoCoreHarness({ dataRoot, env });
    diagnostics = await readDiagnostics(harness.baseUrl);

    expect(diagnostics.agents).toContainEqual(
      expect.objectContaining({ id: 'agent_opencode_server', readiness: 'degraded' })
    );
    rmSync(emptyBin, { force: true, recursive: true });
  });
});

/**
 * Reads aggregate diagnostics for agent readiness assertions.
 */
async function readDiagnostics(
  baseUrl: string
): Promise<{ agents: Array<{ id: string; readiness: string }> }> {
  return (await (await fetch(`${baseUrl}/api/diagnostics`)).json()) as {
    agents: Array<{ id: string; readiness: string }>;
  };
}
