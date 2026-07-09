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

describe('nanocore e2e server unauthenticated rejection', () => {
  it('returns a typed unauthenticated error for protected workspace reads', async () => {
    harness = await startNanoCoreHarness({ coreMode: 'server' });

    const response = await fetch(`${harness.baseUrl}/api/workspaces`);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(401);
    expect(body).toEqual({
      protocolVersion: PROTOCOL_VERSION,
      code: 'core.auth.unauthenticated',
      message: 'Authentication required.',
    });
  });
});
