import {
  createServer,
  type IncomingHttpHeaders,
  type Server,
  type ServerResponse,
} from 'node:http';

/**
 * Shim-local synthetic capability plane for Pi adapter tests.
 *
 * This is a reimplementation of the host package's fixture. The shim must not import
 * `@openkit/pi-runtime-host`. `holdToolCall` keeps an accepted `tools/call` open so a test can
 * interrupt that Turn.
 */

/** One request the synthetic capability plane received. */
export interface CapabilityRequest {
  readonly accepted: boolean;
  readonly headers: IncomingHttpHeaders;
  readonly httpMethod: string;
  readonly method: string;
  readonly params: Record<string, unknown> | null;
  readonly path: string;
}

/** Running synthetic capability plane with one MCP server per id. */
export interface SyntheticCapability {
  /** Base URL the adapter hands the host, ending in `/capabilities`. */
  readonly base: string;
  /** Whether a Turn is bound; while false every request is refused. */
  bound: boolean;
  /** Requests whose held response the client cancelled by closing the connection. */
  readonly cancelledHeld: string[];
  close(): Promise<void>;
  /** Cuts every open stream, as the plane does at a Turn barrier. */
  cutStreams(): void;
  /** While true, accepted `initialize` requests are logged and never answered. */
  holdInitialize: boolean;
  /** While true, accepted `tools/call` requests are logged and never answered. */
  holdToolCall: boolean;
  readonly log: CapabilityRequest[];
}

/**
 * Starts a hand-rolled Streamable HTTP MCP endpoint behind a bearer check.
 *
 * Each server exposes one `echo` tool. Requests with another bearer, or any request while no
 * Turn is bound, are refused with 401 or 403 and still logged.
 *
 * @param credential Capability loopback credential the plane accepts.
 * @param serverIds MCP server ids served under `/capabilities/mcp/:serverId`.
 * @returns The running plane.
 */
export async function startSyntheticCapability(
  credential: string,
  serverIds: readonly string[]
): Promise<SyntheticCapability> {
  const log: CapabilityRequest[] = [];
  const streams = new Set<ServerResponse>();
  const cancelledHeld: string[] = [];
  const plane = { bound: false, holdInitialize: false, holdToolCall: false };
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString('utf8');
    const body = text ? (JSON.parse(text) as Record<string, unknown>) : null;
    const path = req.url ?? '';
    const serverId = /^\/capabilities\/mcp\/([^/?]+)$/.exec(path)?.[1];
    const authorized = req.headers.authorization === `Bearer ${credential}`;
    const accepted =
      authorized && plane.bound && serverId !== undefined && serverIds.includes(serverId);
    log.push({
      accepted,
      headers: req.headers,
      httpMethod: req.method ?? '',
      method: typeof body?.method === 'string' ? body.method : '-',
      params: (body?.params as Record<string, unknown> | undefined) ?? null,
      path,
    });
    if (!accepted) {
      res.writeHead(authorized ? 403 : 401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: authorized ? 'no_turn_bound' : 'unauthorized' }));
      return;
    }
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': open\n\n');
      streams.add(res);
      res.on('close', () => streams.delete(res));
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405);
      res.end();
      return;
    }
    if (!body || body.id === undefined) {
      res.writeHead(202);
      res.end();
      return;
    }
    const reply = (result: unknown) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: body.id, jsonrpc: '2.0', result }));
    };
    const params = (body.params ?? {}) as {
      arguments?: { text?: unknown };
      protocolVersion?: string;
    };
    const serverInfo = { name: `synthetic-${serverId}`, version: '1.0.0' };
    const hold = (kind: string) => {
      streams.add(res);
      res.on('close', () => {
        streams.delete(res);
        if (!res.writableEnded) cancelledHeld.push(kind);
      });
    };
    switch (body.method) {
      case 'initialize':
        if (plane.holdInitialize) return hold('initialize');
        return reply({
          capabilities: { tools: {} },
          protocolVersion: params.protocolVersion,
          serverInfo,
        });
      case 'tools/list':
        return reply({
          tools: [
            {
              description: 'Echo text back.',
              inputSchema: {
                properties: { text: { type: 'string' } },
                required: ['text'],
                type: 'object',
              },
              name: 'echo',
            },
          ],
        });
      case 'tools/call':
        if (plane.holdToolCall) return hold('tools/call');
        return reply({
          content: [{ text: `echo:${String(params.arguments?.text)}`, type: 'text' }],
          isError: false,
        });
      default:
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            error: { code: -32601, message: 'Method not found' },
            id: body.id,
            jsonrpc: '2.0',
          })
        );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return Object.assign(plane, {
    base: `http://127.0.0.1:${port}/capabilities`,
    cancelledHeld,
    close: async () => {
      for (const stream of streams) stream.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    cutStreams: () => {
      for (const stream of streams) stream.destroy();
    },
    log,
  });
}
