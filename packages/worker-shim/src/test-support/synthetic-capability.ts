import { createServer, type Server } from 'node:http';

/** One captured MCP HTTP call. */
export interface CapabilityHit {
  readonly authorization: string | null;
  readonly method: string;
  readonly serverId: string;
}

/** Running synthetic MCP server mounted at `/mcp/:serverId`. */
export interface SyntheticCapability {
  close(): Promise<void>;
  /** When true, `tools/call` accepts the connection and never replies. */
  hangCalls: boolean;
  readonly hits: CapabilityHit[];
  /** Origin used as the adapter capability base URL. */
  readonly url: string;
}

/**
 * Starts a loopback Streamable HTTP MCP server. Each server id exposes one `echo-<id>` tool.
 *
 * @returns The server, its origin, and every captured call.
 */
export async function startSyntheticCapability(): Promise<SyntheticCapability> {
  const hits: CapabilityHit[] = [];
  const endpoint = {
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    hangCalls: false,
    hits,
    url: '',
  };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const serverId = req.url?.split('/').filter(Boolean).at(-1) ?? '';
      let message: { id?: unknown; method?: string } = {};
      try {
        message = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as typeof message;
      } catch {
        message = {};
      }
      const authorization = req.headers.authorization;
      hits.push({
        authorization: typeof authorization === 'string' ? authorization : null,
        method: message.method ?? req.method ?? '',
        serverId,
      });
      if (message.id === undefined) {
        res.writeHead(202);
        res.end();
        return;
      }
      if (message.method === 'tools/call' && endpoint.hangCalls) return;
      let result: unknown = {};
      if (message.method === 'initialize') {
        result = {
          capabilities: { tools: {} },
          protocolVersion: '2024-11-05',
          serverInfo: { name: serverId, version: '0' },
        };
      } else if (message.method === 'tools/list') {
        result = {
          tools: [
            {
              description: 'echo',
              inputSchema: { properties: {}, type: 'object' },
              name: `echo-${serverId}`,
            },
          ],
        };
      } else if (message.method === 'tools/call') {
        result = { content: [{ text: 'echo', type: 'text' }] };
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: message.id, jsonrpc: '2.0', result }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  endpoint.url = `http://127.0.0.1:${port}`;
  return endpoint;
}
