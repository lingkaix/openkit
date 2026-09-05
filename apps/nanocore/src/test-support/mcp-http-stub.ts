import { randomUUID } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';

import { serve } from '@hono/node-server';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { Hono } from 'hono';

/** Isolated official-SDK Streamable HTTP MCP fixture. */
export interface McpHttpStub {
  /** Stops the MCP transport and its private listener. */
  close(): Promise<void>;
  /** Redacted-or-test-only request observations captured by the fixture. */
  readonly observed: string[];
  /** Loopback endpoint exposed by the fixture. */
  readonly url: string;
}

/** Starts one isolated official-SDK Streamable HTTP MCP server. */
export async function createMcpHttpStub(
  options: {
    readonly chunkedCallResultBytes?: number;
    readonly chunkedInitializeResultBytes?: number;
    readonly credentialEcho?: string;
    readonly credentialListEcho?: string;
    readonly delayMs?: number;
    readonly hangDelete?: boolean;
    readonly listError?: boolean;
    readonly nextCursor?: string;
  } = {}
): Promise<McpHttpStub> {
  const observed: string[] = [];
  const sessions = new Map<
    string,
    { mcp: Server; transport: WebStandardStreamableHTTPServerTransport }
  >();
  const servers = new Set<Server>();
  const createSession = async () => {
    const mcp = new Server(
      { name: 'http-test', version: '1.0.0' },
      { capabilities: { tools: {} } }
    );
    mcp.setRequestHandler(ListToolsRequestSchema, () => {
      if (options.listError) throw new McpError(ErrorCode.InternalError, 'Injected list failure.');
      return {
        ...(options.nextCursor ? { nextCursor: options.nextCursor } : {}),
        tools: [
          {
            ...(options.credentialListEcho ? { description: options.credentialListEcho } : {}),
            inputSchema: {
              properties: { message: { type: 'string' } },
              required: ['message'],
              type: 'object',
            },
            name: 'echo',
          },
        ],
      };
    });
    mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
      if (request.params.arguments?.message === 'delayed' && options.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      }
      return {
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
      };
    });
    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true,
      sessionIdGenerator: randomUUID,
    });
    await mcp.connect(transport);
    servers.add(mcp);
    return { mcp, transport };
  };
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
    observed.push(
      `${context.req.header('authorization') ?? ''}|${url.searchParams.get('token') ?? ''}|${context.req.method}|${body && typeof body === 'object' && 'method' in body ? String(body.method) : ''}`
    );
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
      await new Promise<void>((resolve, reject) =>
        activeHttp.close((error) => (error ? reject(error) : resolve()))
      );
    },
    observed,
    url: `http://127.0.0.1:${address.port}/mcp`,
  };
}
