import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PROTOCOL_VERSION } from '@openkit/protocol';
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

describe('nanocore e2e local boot', () => {
  it('boots local mode from an empty data root and initializes fs and sqlite layout', async () => {
    harness = await startNanoCoreHarness();

    const [response, openApiResponse] = await Promise.all([
      fetch(`${harness.baseUrl}/api/health`),
      fetch(`${harness.baseUrl}/api/openapi.json`),
    ]);
    const [body, openApi] = (await Promise.all([response.json(), openApiResponse.json()])) as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];

    expect(response.status).toBe(200);
    expect(body.status).toBe('ok');
    expect(openApiResponse.status).toBe(200);
    expect(openApi).toMatchObject({
      info: { version: '0.1.0' },
      openapi: '3.1.0',
      'x-openkit-protocol-version': PROTOCOL_VERSION,
      'x-openkit-source-digest': expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
    expect(statSync(join(harness.dataRoot, 'workspaces')).isDirectory()).toBe(true);
    expect(existsSync(join(harness.dataRoot, 'server', 'db', 'core.sqlite'))).toBe(true);
  });
});
