import { PROTOCOL_VERSION as CURRENT_PROTOCOL } from '@openkit/protocol';
import { describe, expect, it, vi } from 'vitest';
import { createCoreClient as createClient } from './client.js';

describe('administration catalog application client', () => {
  it('sends exact human confirmation and validates the persistence/reload response', async () => {
    const digest = `sha256:${'a'.repeat(64)}`;
    const candidate = {
      artifactId: 'ar_01890f3e-0000-7000-8000-000000000071',
      artifactVersion: 1 as const,
      contentDigest: digest,
    };
    const input = {
      requestId: '11111111-1111-4111-8111-111111111111',
      candidate,
      confirmation: {
        action: 'administration.configuration.apply' as const,
        contentDigest: digest,
      },
    };
    const result = {
      candidate,
      persisted: true,
      revision: 'revision',
      reload: 'failed',
      restartRequired: true,
    };
    const fetch = vi.fn(async () => Response.json(result));
    const client = createCoreClient({ baseUrl: 'https://nanocore.test', fetch });
    expect(await client.operations['administration.configuration-apply'](input)).toEqual(result);
    expect(fetch).toHaveBeenCalledWith(
      'https://nanocore.test/api/app/operations/administration.configuration-apply',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ candidate: input.candidate, confirmation: input.confirmation }),
      })
    );
    await expect(
      client.operations['administration.configuration-apply']({
        ...input,
        confirmation: { ...input.confirmation, contentDigest: `sha256:${'b'.repeat(64)}` },
      })
    ).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

/** Supplies current metadata without consuming the command fixture's response sequence. */
function createCoreClient(options: Parameters<typeof createClient>[0]) {
  const fetcher = options.fetch ?? globalThis.fetch;
  return createClient({
    ...options,
    fetch: (input, init) =>
      new URL(String(input)).pathname === '/api/meta'
        ? Promise.resolve(
            Response.json({
              protocolVersion: CURRENT_PROTOCOL,
              capabilities: [],
              eventFamilies: [],
            })
          )
        : fetcher(input, init),
  });
}
