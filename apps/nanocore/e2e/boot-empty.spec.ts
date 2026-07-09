import { existsSync, statSync } from 'node:fs';
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

describe('nanocore e2e local boot', () => {
  it('boots local mode from an empty data root and initializes fs and sqlite layout', async () => {
    harness = await startNanoCoreHarness();

    const response = await fetch(`${harness.baseUrl}/api/health`);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body.status).toBe('ok');
    expect(
      statSync(join(harness.dataRoot, 'users', 'user_local', 'workspaces')).isDirectory()
    ).toBe(true);
    expect(existsSync(join(harness.dataRoot, 'server', 'db', 'core.sqlite'))).toBe(true);
  });
});
