import {
  createServer,
  type IncomingHttpHeaders,
  type Server,
  type ServerResponse,
} from 'node:http';

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
  /** Base URL the Harness hands the host, ending in `/capabilities`. */
  readonly base: string;
  /** Whether a Turn is bound; while false every request is refused. */
  bound: boolean;
  /** Requests whose held response the client cancelled by closing the connection. */
  readonly cancelledHeld: string[];
  close(): Promise<void>;
  /** Cuts every open standalone GET stream, as the plane does at a Turn barrier. */
  cutStreams(): void;
  /** While true, accepted `initialize` requests are logged and never answered. */
  holdInitialize: boolean;
  readonly log: CapabilityRequest[];
}

/** Catalog and message variants for one synthetic plane. Defaults match a single echo tool. */
export interface SyntheticCapabilityOptions {
  /**
   * `echo` lists one echo tool. `empty` lists none. `paged` returns that echo tool on the second
   * `tools/list` page.
   */
  catalog?: 'echo' | 'empty' | 'paged' | 'malformed';
  /** Append one logging notification on the GET stream whose data is the Authorization header. */
  logAuthorization?: boolean;
  /** Return the Authorization header as the `tools/call` text. */
  reflectAuthorization?: boolean;
  /** Place the bearer in a JSON member name in a server logging notification. */
  logAuthorizationKey?: boolean;
  /** Return a failed tool request whose HTTP body reflects the bearer. */
  rejectToolWithAuthorization?: boolean;
  /** Return a text resource whose base64 blob decodes to the bearer. */
  resourceAuthorization?: boolean;
  /** Hold the initialized notification response after initialize succeeds. */
  holdInitialized?: boolean;
  /** Hold tools/list and send an unrelated result on the standalone event stream. */
  unrelatedListResponse?: boolean;
  /** Refuse the first initialize with a transient status. */
  retryInitialize?: boolean;
}

/**
 * Starts a hand-rolled Streamable HTTP MCP endpoint behind a bearer check.
 *
 * Each server exposes one `echo` tool. Requests with another bearer, or any request while no
 * Turn is bound, are refused with 401 or 403 and still logged.
 *
 * @param credential Capability loopback credential the plane accepts, or null for a plane that
 *   checks no bearer, as a user's own in-Sandbox MCP server does not.
 * @param serverIds MCP server ids served under `/capabilities/mcp/:serverId`.
 * @param options Catalog shape and optional credential-bearing server messages.
 * @returns The running plane.
 */
export async function startSyntheticCapability(
  credential: string | null,
  serverIds: readonly string[],
  options: SyntheticCapabilityOptions = {}
): Promise<SyntheticCapability> {
  const log: CapabilityRequest[] = [];
  const streams = new Set<ServerResponse>();
  const cancelledHeld: string[] = [];
  const listPages = new Map<string, number>();
  let initializeAttempts = 0;
  const catalog = options.catalog ?? 'echo';
  const echoTool = {
    description: 'Echo text back.',
    inputSchema: {
      properties: { text: { type: 'string' } },
      required: ['text'],
      type: 'object',
    },
    name: 'echo',
  };
  const plane = { bound: false, holdInitialize: false };
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString('utf8');
    const body = text ? (JSON.parse(text) as Record<string, unknown>) : null;
    const path = req.url ?? '';
    const serverId = /^\/capabilities\/mcp\/([^/?]+)$/.exec(path)?.[1];
    const authorized = credential === null || req.headers.authorization === `Bearer ${credential}`;
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
      if (options.logAuthorization || options.logAuthorizationKey) {
        const note = {
          jsonrpc: '2.0',
          method: 'notifications/message',
          params: {
            data: options.logAuthorizationKey
              ? { [req.headers.authorization ?? '']: 'key' }
              : (req.headers.authorization ?? ''),
            level: 'info',
          },
        };
        res.write(`event: message\ndata: ${JSON.stringify(note)}\n\n`);
      }
      if (options.unrelatedListResponse)
        res.write('event: message\ndata: {"jsonrpc":"2.0","id":99999,"result":{"tools":[]}}\n\n');
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
      if (options.holdInitialized && body?.method === 'notifications/initialized') {
        streams.add(res);
        res.on('close', () => streams.delete(res));
        return;
      }
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
    switch (body.method) {
      case 'initialize':
        if (options.retryInitialize && initializeAttempts++ === 0) {
          res.writeHead(503, { 'content-type': 'text/plain' });
          res.end('transient');
          return;
        }
        if (plane.holdInitialize) {
          streams.add(res);
          res.on('close', () => {
            streams.delete(res);
            if (!res.writableEnded) cancelledHeld.push('initialize');
          });
          return;
        }
        return reply({
          capabilities: { tools: {} },
          protocolVersion: params.protocolVersion,
          serverInfo,
        });
      case 'tools/list': {
        if (options.unrelatedListResponse) {
          streams.add(res);
          res.on('close', () => streams.delete(res));
          return;
        }
        if (catalog === 'malformed') return reply({ tools: [{}] });
        if (catalog === 'empty') return reply({ tools: [] });
        if (catalog === 'paged') {
          const page = listPages.get(serverId) ?? 0;
          listPages.set(serverId, page + 1);
          if (page === 0) return reply({ nextCursor: 'page-2', tools: [] });
        }
        return reply({ tools: [echoTool] });
      }
      case 'tools/call':
        if (options.rejectToolWithAuthorization) {
          res.writeHead(400, { 'content-type': 'text/plain' });
          res.end(req.headers.authorization ?? '');
          return;
        }
        return reply({
          content: [
            options.resourceAuthorization
              ? {
                  type: 'resource',
                  resource: {
                    uri: 'test://reflection',
                    mimeType: 'text/plain',
                    blob: Buffer.from(req.headers.authorization ?? '').toString('base64'),
                  },
                }
              : {
                  text: options.reflectAuthorization
                    ? (req.headers.authorization ?? '')
                    : `echo:${String(params.arguments?.text)}`,
                  type: 'text',
                },
          ],
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
