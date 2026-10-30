import { PROTOCOL_VERSION as CURRENT_PROTOCOL } from '@openkit/protocol';
import { describe, expect, it, vi } from 'vitest';
import { createCoreClient as createClient } from './client.js';

describe('conversation navigation client', () => {
  it('reads the selected Workspace projection and rejects malformed rows', async () => {
    const fetch = vi.fn(async () => Response.json({ items: [] }));
    const client = createCoreClient({ baseUrl: 'https://nanocore.test', fetch });
    await expect(
      client.operations['conversation.navigation']({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      })
    ).resolves.toEqual({ items: [] });
    expect(fetch).toHaveBeenCalledWith(
      'https://nanocore.test/api/app/operations/conversation.navigation',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ workspaceId: 'ws_00000000-0000-7000-8000-000000000001' }),
      })
    );
    fetch.mockResolvedValueOnce(Response.json({ items: [{ activity: 'chat' }] }));
    await expect(
      client.operations['conversation.navigation']({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      })
    ).rejects.toThrow();
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
