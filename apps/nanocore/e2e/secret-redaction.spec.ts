import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type NanoCoreHarness, removeDataRoot, startNanoCoreHarness } from './_lib/harness.js';
import { postJson } from './_lib/http.js';

const rawUserInfo = 'user:pass';
const rawSecret = 'sk-openkit-e2e-secret-value';

let harness: NanoCoreHarness | null = null;

afterEach(async () => {
  const current = harness;
  harness = null;

  if (current) {
    await current.stop();
    await removeDataRoot(current.dataRoot);
  }
});

describe('nanocore e2e secret redaction', () => {
  it('keeps provider secrets out of diagnostics, workspace, and knowledge payloads', async () => {
    harness = await startNanoCoreHarness();
    const providerRoot = join(harness.dataRoot, 'config', 'providers');

    mkdirSync(providerRoot, { recursive: true });
    writeFileSync(
      join(providerRoot, 'secret-redaction.provider.jsonc'),
      JSON.stringify({
        id: 'provider_secret_e2e',
        displayName: 'Secret Provider',
        kind: 'local',
        baseUrl: `https://${rawUserInfo}@secret.example.com/v1`,
        models: ['model-secret'],
        extensions: { audit: { value: rawSecret } },
      })
    );

    await harness.stop();
    harness = await startNanoCoreHarness({ dataRoot: harness.dataRoot });

    await postJson(`${harness.baseUrl}/api/workspaces/ws_demo/knowledge`, {
      kind: 'project-context',
      title: 'Safe knowledge',
      content: 'No provider secrets should appear here.',
      requestId: randomUUID(),
    });

    const diagnostics = await fetchJson(`${harness.baseUrl}/api/diagnostics`);
    const workspace = await fetchJson(`${harness.baseUrl}/api/app/workspaces/ws_demo/dashboard`);
    const knowledge = await fetchJson(`${harness.baseUrl}/api/workspaces/ws_demo/knowledge`);
    const payload = JSON.stringify({ diagnostics, knowledge, workspace });

    expect(payload).not.toContain(rawUserInfo);
    expect(payload).not.toContain(rawSecret);
  });
});

/**
 * Fetches a JSON payload from the local e2e server.
 */
async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`GET ${url} failed with ${response.status}: ${await response.text()}`);
  }

  return await response.json();
}
