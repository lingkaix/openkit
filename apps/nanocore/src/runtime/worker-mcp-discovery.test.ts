import { describe, expect, it, vi } from 'vitest';
import { dispatchWorkerMcpDiscovery } from './worker-mcp-discovery.js';

const request = new Request('http://nanocore.test/api/worker-capabilities/mcp/_discovery', {
  headers: { authorization: 'Bearer discovery-fixture' },
});
const base = {
  request,
  signal: new AbortController().signal,
  metadata: undefined,
  protocolRequestId: 7,
};

describe('Worker MCP discovery transport', () => {
  it.each(['_discovery', '_list-servers', '../echo', 'echo?token=value'])(
    'refuses private or non-catalog target %s without delegation',
    async (serverId) => {
      const forward = vi.fn();
      await expect(
        dispatchWorkerMcpDiscovery({
          ...base,
          forward,
          name: 'mcp.call-tool',
          arguments: { serverId, toolName: 'echo', arguments: {} },
        })
      ).rejects.toMatchObject({ data: { code: 'mcp-invalid-arguments' } });
      expect(forward).not.toHaveBeenCalled();
    }
  );

  it('bounds the escaped discovery result without truncating its schema', async () => {
    const forward = vi.fn(async (request: Request) => {
      const { id } = await request.json();
      return Response.json({
        jsonrpc: '2.0',
        id,
        result: {
          tools: [
            { name: 'echo', inputSchema: { type: 'object', description: '"'.repeat(140_000) } },
          ],
        },
      });
    });
    await expect(
      dispatchWorkerMcpDiscovery({
        ...base,
        forward,
        name: 'mcp.list-tools',
        arguments: { serverId: 'echo' },
      })
    ).rejects.toMatchObject({ data: { code: 'mcp-result-too-large' } });
    expect(forward).toHaveBeenCalledTimes(1);
  });

  it('preserves the original admission refusal without retrying the target', async () => {
    const forward = vi.fn(async () =>
      Response.json(
        {
          jsonrpc: '2.0',
          id: null,
          error: {
            code: -32600,
            message: 'MCP server is unavailable.',
            data: { code: 'mcp-server-unavailable' },
          },
        },
        { status: 503 }
      )
    );
    await expect(
      dispatchWorkerMcpDiscovery({
        ...base,
        forward,
        name: 'mcp.call-tool',
        arguments: { serverId: 'echo', toolName: 'echo', arguments: {} },
      })
    ).rejects.toMatchObject({ data: { code: 'mcp-server-unavailable' } });
    expect(forward).toHaveBeenCalledTimes(1);
  });
});
