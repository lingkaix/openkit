import { describe, expect, it, vi } from 'vitest';
import { createCoreClient } from './client.js';

describe('Workspace Worker client', () => {
  it('reads the selected Workspace and rejects malformed Worker records', async () => {
    const fetch = vi.fn(async () => Response.json({ workspaceId: 'ws_demo', items: [] }));
    const client = createCoreClient({ baseUrl: 'https://nanocore.test', fetch });
    await expect(client.app.listWorkspaceWorkers('ws_demo')).resolves.toEqual({
      workspaceId: 'ws_demo',
      items: [],
    });
    expect(fetch).toHaveBeenCalledWith(
      'https://nanocore.test/api/app/workspaces/ws_demo/workers',
      expect.objectContaining({ method: 'GET' })
    );
    fetch.mockResolvedValueOnce(Response.json({ workspaceId: 'ws /demo', items: [] }));
    await client.app.listWorkspaceWorkers('ws /demo');
    expect(fetch).toHaveBeenLastCalledWith(
      'https://nanocore.test/api/app/workspaces/ws%20%2Fdemo/workers',
      expect.objectContaining({ method: 'GET' })
    );
    fetch.mockResolvedValueOnce(
      Response.json({ workspaceId: 'ws_demo', items: [{ threadId: 'th_1' }] })
    );
    await expect(client.app.listWorkspaceWorkers('ws_demo')).rejects.toThrow();
  });
});
