import { describe, expect, it, vi } from 'vitest';
import { createCoreClient } from './client.js';

describe('Workspace Worker client', () => {
  it('reads the selected Workspace and rejects malformed Worker records', async () => {
    const fetch = vi.fn(async () =>
      Response.json({ workspaceId: 'ws_00000000-0000-7000-8000-000000000001', items: [] })
    );
    const client = createCoreClient({ baseUrl: 'https://nanocore.test', fetch });
    await expect(
      client.operations['worker.list']({ workspaceId: 'ws_00000000-0000-7000-8000-000000000001' })
    ).resolves.toEqual({
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      items: [],
    });
    expect(fetch).toHaveBeenCalledWith(
      'https://nanocore.test/api/app/operations/worker.list',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ workspaceId: 'ws_00000000-0000-7000-8000-000000000001' }),
      })
    );
    const callsBeforeInvalidScope = fetch.mock.calls.length;
    await expect(client.operations['worker.list']({ workspaceId: 'ws /demo' })).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(callsBeforeInvalidScope);
    fetch.mockResolvedValueOnce(
      Response.json({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        items: [{ threadId: 'th_00000000-0000-7267-800d-a65e1b6a22d7' }],
      })
    );
    await expect(
      client.operations['worker.list']({ workspaceId: 'ws_00000000-0000-7000-8000-000000000001' })
    ).rejects.toThrow();
  });
});
