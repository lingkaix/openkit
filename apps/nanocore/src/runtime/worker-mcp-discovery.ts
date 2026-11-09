import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import {
  type CallToolResult,
  ProtocolError,
  ProtocolErrorCode,
} from '@modelcontextprotocol/server';
import { OPERATION_REGISTRY } from '@openkit/app-api-schemas';
import { WorkspaceMcpServerIdSchema } from '@openkit/config-schema';
import { isRecord } from '@openkit/protocol';
import { z } from 'zod';
import { MCP_RESULT_MAX_BYTES, MCP_RESULT_TOO_LARGE_MESSAGE } from './worker-mcp-gateway.js';

const discoveryInputs = {
  'mcp.list-servers': z.object({}).strict(),
  'mcp.list-tools': z.object({ serverId: WorkspaceMcpServerIdSchema }).strict(),
  'mcp.call-tool': OPERATION_REGISTRY['mcp.call-tool'].inputSchema,
};
const descriptions = {
  'mcp.list-servers':
    'Discover the admitted servers and their uses. Then read the selected server with mcp.list-tools.',
  'mcp.list-tools':
    'Read the exact admitted tool names and argument schemas for one server. These definitions are reference material; invoke them with mcp.call-tool.',
  'mcp.call-tool':
    'Call one discovered tool with its exact arguments. Discovery does not grant permission; current schema, Policy and credentials are checked on every call.',
};

/** Fixed Worker-only fallback definitions; selected vendor schemas never enter this native prefix. */
export const WORKER_MCP_DISCOVERY_TOOLS = Object.entries(discoveryInputs).map(([name, schema]) => {
  const inputSchema = z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input' });
  delete inputSchema.$schema;
  return { name, description: descriptions[name as keyof typeof descriptions], inputSchema };
});

/** Forwards one Worker fallback request to the original admitted handler, without a second ledger or replay. */
export async function dispatchWorkerMcpDiscovery(input: {
  readonly name: string;
  readonly arguments: Record<string, unknown>;
  readonly protocolRequestId: string | number;
  readonly metadata: unknown;
  readonly request: Request;
  readonly signal: AbortSignal;
  readonly forward: (request: Request) => Response | Promise<Response>;
}): Promise<CallToolResult> {
  const name = input.name as keyof typeof discoveryInputs;
  const schema = Object.hasOwn(discoveryInputs, name) ? discoveryInputs[name] : undefined;
  const parsed = schema?.safeParse(input.arguments);
  if (!parsed?.success) throw invalidArguments();
  const args = parsed.data as {
    serverId?: string;
    toolName?: string;
    arguments?: Record<string, unknown>;
  };
  // Private underscore endpoints cannot become recursive or unselected fallback targets.
  if (name !== 'mcp.list-servers' && !WorkspaceMcpServerIdSchema.safeParse(args.serverId).success)
    throw invalidArguments();
  const listing = name === 'mcp.list-servers';
  const path = listing ? '_list-servers' : encodeURIComponent(args.serverId!);
  const headers = new Headers({
    authorization: input.request.headers.get('authorization') ?? '',
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
  });
  const version = input.request.headers.get('mcp-protocol-version');
  if (version) headers.set('mcp-protocol-version', version);
  // Preserve the SDK envelope, not the fallback Tool's cached header or progress identity.
  const envelope = isRecord(input.metadata)
    ? Object.fromEntries(
        [PROTOCOL_VERSION_META_KEY, CLIENT_INFO_META_KEY, CLIENT_CAPABILITIES_META_KEY]
          .filter((key) => Object.hasOwn(input.metadata as object, key))
          .map((key) => [key, (input.metadata as Record<string, unknown>)[key]])
      )
    : undefined;
  const endpoint = new URL(`/api/worker-capabilities/mcp/${path}`, input.request.url);
  let body: unknown;
  if (listing) {
    body = await (
      await input.forward(
        new Request(endpoint, {
          method: 'POST',
          headers,
          signal: input.signal,
          body: '{}',
        })
      )
    ).json();
  } else {
    const id = `discovery:${typeof input.protocolRequestId}:${input.protocolRequestId}`;
    const reply = Promise.withResolvers<unknown>();
    const transport = new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers },
      // The SDK owns protocol headers, name encoding and response framing; the destination stays in process.
      fetch: async (request, init) => {
        const response = await input.forward(
          new Request(request, {
            ...init,
            signal: AbortSignal.any([input.signal, ...(init?.signal ? [init.signal] : [])]),
          })
        );
        // Original admission refusals are already public JSON-RPC errors, even at a non-2xx status.
        if (!response.ok) {
          const refused: unknown = await response.clone().json();
          if (
            isRecord(refused) &&
            isRecord(refused.error) &&
            typeof refused.error.code === 'number'
          )
            throw new ProtocolError(
              refused.error.code,
              String(refused.error.message),
              refused.error.data
            );
        }
        return response;
      },
    });
    transport.onmessage = (message) => {
      if ('id' in message && message.id === id && ('result' in message || 'error' in message))
        reply.resolve(message);
    };
    transport.onerror = reply.reject;
    try {
      await transport.start();
      const [, response] = await Promise.all([
        transport.send({
          jsonrpc: '2.0',
          id,
          method: name === 'mcp.list-tools' ? 'tools/list' : 'tools/call',
          params: {
            ...(envelope ? { _meta: envelope } : {}),
            ...(name === 'mcp.list-tools'
              ? {}
              : { name: args.toolName, arguments: args.arguments }),
          },
        }),
        reply.promise,
      ]);
      body = response;
    } finally {
      await transport.close();
    }
  }
  if (isRecord(body) && isRecord(body.error)) {
    const error = body.error;
    throw new ProtocolError(
      typeof error.code === 'number' ? error.code : ProtocolErrorCode.InternalError,
      typeof error.message === 'string' ? error.message : 'MCP request failed.',
      error.data
    );
  }
  if (!isRecord(body))
    throw new ProtocolError(ProtocolErrorCode.InternalError, 'MCP request failed.', {
      code: 'mcp-call-failed',
    });
  if (name === 'mcp.call-tool') {
    if (!isRecord(body.result))
      throw new ProtocolError(ProtocolErrorCode.InternalError, 'MCP request failed.', {
        code: 'mcp-call-failed',
      });
    return body.result as CallToolResult;
  }
  const metadata =
    listing && Array.isArray(body.servers)
      ? {
          servers: body.servers.map(
            (server: { id: string; toolNames: string[]; health: string; transport: string }) => ({
              id: server.id,
              health: server.health,
              transport: server.transport,
              description: `Use ${server.id} for ${server.toolNames.slice(0, 4).join(', ') || 'its selected operations'}. Read mcp.list-tools before calling.`,
            })
          ),
        }
      : body.result;
  const result: CallToolResult = { content: [{ type: 'text', text: JSON.stringify(metadata) }] };
  // JSON text escaping adds bytes beyond the original discovery envelope.
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MCP_RESULT_MAX_BYTES)
    throw new ProtocolError(ProtocolErrorCode.InvalidRequest, MCP_RESULT_TOO_LARGE_MESSAGE, {
      code: 'mcp-result-too-large',
    });
  return result;
}

/** Refuses malformed fallback routing before any original handler or upstream contact. */
function invalidArguments(): ProtocolError {
  return new ProtocolError(
    ProtocolErrorCode.InvalidParams,
    'MCP discovery arguments are invalid.',
    { code: 'mcp-invalid-arguments' }
  );
}
