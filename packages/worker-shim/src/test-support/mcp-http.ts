import { createServer, type Server, type ServerResponse } from 'node:http';

/** One MCP HTTP request observed by the synthetic server. */
export interface CapturedMcpRequest {
  readonly authorization: string | undefined;
  readonly method: string;
  readonly serverId: string;
}

/** One local HTTP MCP server that answers the DeepSeek client's initialize and tools/list. */
export interface SyntheticMcp {
  close(): Promise<void>;
  readonly requests: CapturedMcpRequest[];
  /** Capability base URL. Server `id` is served at `${url}/mcp/${id}`. */
  readonly url: string;
}

/** Refusal and tool-call controls for one synthetic capability server. */
export interface SyntheticMcpOptions {
  /** When this returns false, every request is refused with HTTP 403. */
  readonly allow?: () => boolean;
  /** Leave `tools/call` unanswered so a Turn can be cancelled inside the tool. */
  readonly hangToolCalls?: boolean;
}

/**
 * Serves one tool per MCP server id on a single loopback port.
 *
 * The DeepSeek client posts `initialize`, `notifications/initialized`, and `tools/list`, and it
 * also probes `server/discover`. Tool names are returned as declared so the model sees
 * `mcp__<id>__<tool>`.
 *
 * @param tools Map of server id to the single tool name that id exposes.
 * @param options Optional idle refusal and a hanging tool call.
 * @returns The running server.
 */
export async function startSyntheticMcp(
  tools: Readonly<Record<string, string>>,
  options?: SyntheticMcpOptions
): Promise<SyntheticMcp> {
  const requests: CapturedMcpRequest[] = [];
  const open = new Set<ServerResponse>();
  const server: Server = createServer(async (req, res) => {
    const serverId = (req.url ?? '').split('/').filter(Boolean).at(-1) ?? '';
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    let message: { id?: unknown; method?: unknown } = {};
    try {
      message = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        id?: unknown;
        method?: unknown;
      };
    } catch {
      message = {};
    }
    const method = typeof message.method === 'string' ? message.method : '';
    requests.push({
      authorization:
        typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined,
      method,
      serverId,
    });
    if (options?.allow && !options.allow()) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'capability refused' }));
      return;
    }
    if (options?.hangToolCalls && method === 'tools/call') {
      open.add(res);
      res.on('close', () => open.delete(res));
      return;
    }
    if (method === 'initialize') {
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': serverId });
      res.end(
        JSON.stringify({
          id: message.id,
          jsonrpc: '2.0',
          result: {
            capabilities: { tools: {} },
            protocolVersion: '2025-11-25',
            serverInfo: { name: serverId, version: '0' },
          },
        })
      );
      return;
    }
    if (method === 'tools/list') {
      const tool = tools[serverId] ?? 'unknown_tool';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: message.id,
          jsonrpc: '2.0',
          result: {
            tools: [
              { description: tool, inputSchema: { properties: {}, type: 'object' }, name: tool },
            ],
          },
        })
      );
      return;
    }
    if (method === 'server/discover') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: message.id,
          jsonrpc: '2.0',
          result: { protocolVersions: ['2025-11-25'] },
        })
      );
      return;
    }
    if (message.id === undefined) {
      res.writeHead(202);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: message.id, jsonrpc: '2.0', result: {} }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    close: async () => {
      for (const response of open) response.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    requests,
    url: `http://127.0.0.1:${port}`,
  };
}
