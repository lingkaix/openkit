import { createServer, type Server } from 'node:http';
import { isRecord } from '@openkit/protocol';

/** One captured MCP HTTP call. */
export interface CapabilityHit {
  readonly authorization: string | null;
  readonly method: string;
  readonly params?: unknown;
  readonly serverId: string;
}

/** Protocol observations kept separate from the existing captured-call shape and bearer. */
export interface CapabilityProtocolHit {
  readonly method: string;
  readonly params?: unknown;
  readonly protocolHeaders: Readonly<Record<string, string>>;
  readonly requestUrl: string;
  readonly serverId: string;
}

/** Running synthetic MCP server mounted at `/mcp/:serverId`. */
export interface SyntheticCapability {
  /** Static MCP `tools/call` result used to qualify real native result consumers. */
  callResult: unknown;
  close(): Promise<void>;
  /** When true, `tools/call` accepts the connection and never replies. */
  hangCalls: boolean;
  readonly hits: CapabilityHit[];
  /** Protocol metadata for every method, without changing existing call observations. */
  readonly protocolHits: CapabilityProtocolHit[];
  /** Origin used as the adapter capability base URL. */
  readonly url: string;
}

/**
 * Starts a loopback Streamable HTTP MCP server. By default, each server exposes one `echo-<id>` tool.
 *
 * @param tools Optional descriptors in place of the default parameterless echo tool.
 * @returns The server, its origin, and every captured call.
 */
export async function startSyntheticCapability(
  tools?: readonly { readonly name: string; readonly inputSchema: Record<string, unknown> }[]
): Promise<SyntheticCapability> {
  const hits: CapabilityHit[] = [];
  const protocolHits: CapabilityProtocolHit[] = [];
  const endpoint = {
    callResult: { content: [{ text: 'echo', type: 'text' }] } as unknown,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    hangCalls: false,
    hits,
    protocolHits,
    url: '',
  };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      // Native CodeMode appends a query; production routing identifies servers by pathname.
      const serverId =
        new URL(req.url ?? '/', 'http://127.0.0.1').pathname.split('/').filter(Boolean).at(-1) ??
        '';
      let message: { id?: unknown; method?: string; params?: unknown } = {};
      try {
        message = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as typeof message;
      } catch {
        message = {};
      }
      const authorization = req.headers.authorization;
      hits.push({
        authorization: typeof authorization === 'string' ? authorization : null,
        method: message.method ?? req.method ?? '',
        ...(message.method === 'tools/call' ? { params: message.params } : {}),
        serverId,
      });
      protocolHits.push({
        method: message.method ?? req.method ?? '',
        params: message.params,
        protocolHeaders: Object.fromEntries(
          Object.entries(req.headers).filter(
            (entry): entry is [string, string] =>
              entry[0].startsWith('mcp-') && typeof entry[1] === 'string'
          )
        ),
        requestUrl: req.url ?? '/',
        serverId,
      });
      if (message.id === undefined) {
        res.writeHead(202);
        res.end();
        return;
      }
      if (message.method === 'tools/call' && endpoint.hangCalls) return;
      const meta = isRecord(message.params) ? message.params._meta : undefined;
      const modern =
        isRecord(meta) && meta['io.modelcontextprotocol/protocolVersion'] === '2026-07-28';
      let result: unknown = {};
      if (message.method === 'initialize') {
        result = {
          capabilities: { tools: {} },
          protocolVersion: '2024-11-05',
          serverInfo: { name: serverId, version: '0' },
        };
      } else if (message.method === 'server/discover' && modern) {
        result = { supportedVersions: ['2026-07-28'], capabilities: { tools: {} } };
      } else if (message.method === 'tools/list') {
        result = {
          tools: tools ?? [
            {
              description: 'echo',
              inputSchema: { properties: {}, type: 'object' },
              name: `echo-${serverId}`,
            },
          ],
        };
      } else if (message.method === 'tools/call') {
        result = endpoint.callResult;
      }
      // Modern SDK clients validate result framing before accepting the native tool list/result.
      if (modern && isRecord(result)) {
        result = {
          ...result,
          resultType: 'complete',
          _meta: { 'io.modelcontextprotocol/serverInfo': { name: serverId, version: '0' } },
          ...(['server/discover', 'tools/list'].includes(message.method ?? '')
            ? { ttlMs: 0, cacheScope: 'private' }
            : {}),
        };
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
