import {
  createMcpHandler,
  isLegacyRequest,
  type Server,
  WebStandardStreamableHTTPServerTransport,
} from '@modelcontextprotocol/server';

/**
 * Serves one stateless MCP request on both protocol eras.
 * Legacy requests stay JSON and stateless. Modern requests use the SDK's per-request handler.
 * The factory runs once for the era that actually serves the request.
 */
export async function serveStatelessMcp(
  request: Request,
  parsedBody: unknown,
  factory: () => Server
): Promise<Response> {
  const handler = createMcpHandler(() => factory(), {
    legacy: 'reject',
    responseMode: 'json',
  });
  const parsed = parsedBody === null ? undefined : parsedBody;
  try {
    if (await isLegacyRequest(request, parsed)) {
      const server = factory();
      const transport = new WebStandardStreamableHTTPServerTransport({
        enableJsonResponse: true,
      });
      await server.connect(transport);
      try {
        return await transport.handleRequest(
          request,
          parsed === undefined ? undefined : { parsedBody: parsed }
        );
      } finally {
        await server.close().catch(() => undefined);
      }
    }
    return await handler.fetch(request, parsed === undefined ? undefined : { parsedBody: parsed });
  } finally {
    await handler.close().catch(() => undefined);
  }
}
