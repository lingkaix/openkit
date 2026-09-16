import { describe, expect, it, vi } from 'vitest';
import { createCoreClient } from './client.js';

describe('conversation navigation client', () => {
  it('reads the selected Workspace projection and rejects malformed rows', async () => {
    const fetch = vi.fn(async () => Response.json({ items: [] }));
    const client = createCoreClient({ baseUrl: 'https://nanocore.test', fetch });
    await expect(client.app.listConversationNavigation('ws_demo')).resolves.toEqual({ items: [] });
    expect(fetch).toHaveBeenCalledWith(
      'https://nanocore.test/api/app/workspaces/ws_demo/conversations',
      expect.objectContaining({ method: 'GET' })
    );
    fetch.mockResolvedValueOnce(Response.json({ items: [{ activity: 'chat' }] }));
    await expect(client.app.listConversationNavigation('ws_demo')).rejects.toThrow();
  });
});
