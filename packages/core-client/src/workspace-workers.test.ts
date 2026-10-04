import { describe, expect, it, vi } from 'vitest';
import { createCoreClient } from './client.js';

describe('Workspace Worker client', () => {
  it('reads the selected Workspace and rejects malformed Worker records', async () => {
    const fetch = vi.fn(async () => Response.json({ workspaceId: 'ws_demo', items: [] }));
    const client = createCoreClient({ baseUrl: 'https://nanocore.test', fetch });
    await expect(client.operations['worker.list']({ workspaceId: 'ws_demo' })).resolves.toEqual({
      workspaceId: 'ws_demo',
      items: [],
    });
    expect(fetch).toHaveBeenCalledWith(
      'https://nanocore.test/api/app/operations/worker.list',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ workspaceId: 'ws_demo' }) })
    );
    fetch.mockResolvedValueOnce(Response.json({ workspaceId: 'ws /demo', items: [] }));
    await client.operations['worker.list']({ workspaceId: 'ws /demo' });
    expect(fetch).toHaveBeenLastCalledWith(
      'https://nanocore.test/api/app/operations/worker.list',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ workspaceId: 'ws /demo' }) })
    );
    fetch.mockResolvedValueOnce(
      Response.json({ workspaceId: 'ws_demo', items: [{ threadId: 'th_1' }] })
    );
    await expect(client.operations['worker.list']({ workspaceId: 'ws_demo' })).rejects.toThrow();
  });
});
