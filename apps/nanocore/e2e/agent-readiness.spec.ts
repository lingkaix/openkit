import { readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    harness = await startNanoCoreHarness();

    let diagnostics = await readDiagnostics(harness.baseUrl);

    expect(diagnostics.agents).toContainEqual(
      expect.objectContaining({ id: 'agent_codex_host', readiness: 'blocked' })
    );
    expect(diagnostics.agents).toContainEqual(
      expect.objectContaining({ id: 'agent_opencode_server', readiness: 'blocked' })
    );

    const dataRoot = harness.dataRoot;
    const manifestPath = join(dataRoot, 'config', 'agents', 'opencode-server.agent.jsonc');
    const manifest = readFileSync(manifestPath, 'utf8');
    rmSync(manifestPath);
    await harness.stop();
    harness = await startNanoCoreHarness({ dataRoot });
    diagnostics = await readDiagnostics(harness.baseUrl);

    expect(diagnostics.agents.map((agent) => agent.id)).not.toContain('agent_opencode_server');

    writeFileSync(manifestPath, manifest);
    await harness.stop();
    harness = await startNanoCoreHarness({ dataRoot });
    diagnostics = await readDiagnostics(harness.baseUrl);

    expect(diagnostics.agents).toContainEqual(
      expect.objectContaining({ id: 'agent_opencode_server', readiness: 'blocked' })
    );
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
