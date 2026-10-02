import { randomUUID } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';

import { serve } from '@hono/node-server';
import {
  createMcpHandler,
  ProtocolError,
  ProtocolErrorCode,
  Server,
  WebStandardStreamableHTTPServerTransport,
} from '@modelcontextprotocol/server';
import { Hono } from 'hono';

/** Isolated official-SDK Streamable HTTP MCP fixture. */
export interface McpHttpStub {
  /** Stops the MCP transport and its private listener. */
  close(): Promise<void>;
  /** Redacted-or-test-only request observations captured by the fixture. */
  readonly observed: string[];
  /** Makes later `server/discover` requests fail without answering. */
  stopAnswering(): void;
  /** Loopback endpoint exposed by the fixture. */
  readonly url: string;
}

const echoInputSchema = {
  properties: { message: { type: 'string' as const } },
  required: ['message'],
  type: 'object' as const,
};

/** Starts one isolated official-SDK Streamable HTTP MCP server. */
export async function createMcpHttpStub(
  options: {
    readonly chunkedCallResultBytes?: number;
    readonly chunkedInitializeResultBytes?: number;
    readonly credentialEcho?: string;
    readonly credentialListEcho?: string;
    readonly delayMs?: number;
    /** Holds the `delayed` tool response until the test explicitly releases it. */
    readonly delayedResult?: Promise<void>;
    readonly hangDelete?: boolean;
    readonly listError?: boolean;
    /** `finite` returns two pages. `nonterminating` repeats one cursor forever. */
    readonly toolPages?: 'finite' | 'nonterminating';
    /** `2026-07-28` serves the stateless era. Omitted servers stay on the session era. */
    readonly protocolEra?: '2026-07-28';
  } = {}
): Promise<McpHttpStub> {
  const observed: string[] = [];
  let answering = true;
  const sessions = new Map<
    string,
    { mcp: Server; transport: WebStandardStreamableHTTPServerTransport }
  >();
  const servers = new Set<Server>();
  const createEchoServer = () => {
    const mcp = new Server(
      { name: 'http-test', version: '1.0.0' },
      { capabilities: { tools: {} } }
    );
    let repeatedPage = 0;
    mcp.setRequestHandler('tools/list', (request) => {
      if (options.listError) {
        throw new ProtocolError(ProtocolErrorCode.InternalError, 'Injected list failure.');
      }
      const echo = {
        ...(options.credentialListEcho ? { description: options.credentialListEcho } : {}),
        inputSchema: echoInputSchema,
        name: 'echo',
      };
      if (options.toolPages === 'nonterminating') {
        repeatedPage += 1;
        return {
          nextCursor: 'next',
          tools: [{ ...echo, name: `echo-${repeatedPage}` }],
        };
      }
      if (options.toolPages === 'finite') {
        if (request.params?.cursor === 'page-2') {
          return {
            tools: [
              {
                inputSchema: echoInputSchema,
                name: 'echo-page-2',
              },
            ],
          };
        }
        return { nextCursor: 'page-2', tools: [echo] };
      }
      return { tools: [echo] };
    });
    mcp.setRequestHandler('tools/call', async (request) => {
      if (request.params.arguments?.message === 'delayed' && options.delayedResult) {
        await options.delayedResult;
      }
      if (request.params.arguments?.message === 'delayed' && options.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      }
      return mcp.projectCallToolResult(
        {
          content: [
            {
              text:
                request.params.arguments?.message === 'leak' && options.credentialEcho
                  ? options.credentialEcho
                  : String(request.params.arguments?.message),
              type: 'text' as const,
            },
          ],
          ...(request.params.arguments?.message === 'key-leak' && options.credentialEcho
            ? { structuredContent: { [options.credentialEcho]: 'leaked' } }
            : {}),
        },
        undefined
      );
    });
    return mcp;
  };
  const createSession = async () => {
    const mcp = createEchoServer();
    servers.add(mcp);
    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true,
      sessionIdGenerator: randomUUID,
    });
    await mcp.connect(transport);
    return { mcp, transport };
  };
  const modernHandler =
    options.protocolEra === '2026-07-28'
      ? createMcpHandler(() => createEchoServer(), { legacy: 'reject', responseMode: 'json' })
      : null;
  const app = new Hono();
  app.all('/mcp', async (context) => {
    const url = new URL(context.req.url);
    const body =
      context.req.method === 'POST'
        ? await context.req.raw
            .clone()
            .json()
            .catch(() => null)
        : null;
    const method = body && typeof body === 'object' && 'method' in body ? String(body.method) : '';
    observed.push(
      `${context.req.header('authorization') ?? ''}|${url.searchParams.get('token') ?? ''}|${context.req.method}|${method}`
    );
    if (!answering && method === 'server/discover') {
      return new Response('MCP server stopped answering.', { status: 503 });
    }
    if (modernHandler) {
      return modernHandler.fetch(
        context.req.raw,
        body && typeof body === 'object' ? { parsedBody: body } : undefined
      );
    }
    const requestBody = body && typeof body === 'object' ? body : null;
    const chunkedResultBytes =
      requestBody && 'method' in requestBody
        ? requestBody.method === 'initialize'
          ? options.chunkedInitializeResultBytes
          : requestBody.method === 'tools/call'
            ? options.chunkedCallResultBytes
            : undefined
        : undefined;
    if (chunkedResultBytes) {
      const bytes = new TextEncoder().encode(
        JSON.stringify({
          id: requestBody && 'id' in requestBody ? requestBody.id : null,
          jsonrpc: '2.0',
          result: { padding: 'x'.repeat(chunkedResultBytes) },
        })
      );
      let offset = 0;
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (offset >= bytes.byteLength) {
              controller.close();
              return;
            }
            controller.enqueue(bytes.subarray(offset, offset + 16 * 1024));
            offset += 16 * 1024;
          },
        }),
        { headers: { 'content-type': 'application/json' } }
      );
    }
    if (context.req.method === 'DELETE' && options.hangDelete) {
      await new Promise<void>((resolve) => {
        if (context.req.raw.signal.aborted) resolve();
        else context.req.raw.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return new Response('Injected hanging DELETE.', { status: 503 });
    }
    const requestSessionId = context.req.header('mcp-session-id');
    const session = requestSessionId
      ? sessions.get(requestSessionId)
      : body && typeof body === 'object' && 'method' in body && body.method === 'initialize'
        ? await createSession()
        : undefined;
    if (!session) return new Response('Unknown MCP session.', { status: 404 });
    const response = await session.transport.handleRequest(context.req.raw);
    const responseSessionId = response.headers.get('mcp-session-id');
    if (responseSessionId) sessions.set(responseSessionId, session);
    if (context.req.method === 'DELETE' && requestSessionId) sessions.delete(requestSessionId);
    return response;
  });
  let http: HttpServer | undefined;
  await new Promise<void>((resolve) => {
    http = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, () =>
      resolve()
    ) as HttpServer;
  });
  if (!http) throw new Error('HTTP test server did not start.');
  const activeHttp = http;
  const address = activeHttp.address();
  if (!address || typeof address === 'string') throw new Error('HTTP test server did not bind.');
  return {
    close: async () => {
      await Promise.all([...servers].map((mcp) => mcp.close()));
      await modernHandler?.close();
      await new Promise<void>((resolve, reject) =>
        activeHttp.close((error) => (error ? reject(error) : resolve()))
      );
    },
    observed,
    stopAnswering: () => {
      answering = false;
    },
    url: `http://127.0.0.1:${address.port}/mcp`,
  };
}
