import { ToolSchema } from '@modelcontextprotocol/core';
import { Server, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import {
  type BootReadinessSnapshot,
  CreateOpenKitAccessTokenResponseSchema,
  OPERATION_DEFINITIONS,
  type OperationId,
  RotateOpenKitAccessTokenResponseSchema,
} from '@openkit/app-api-schemas';
import type { Hono } from 'hono';
import { z } from 'zod';
import { recordServerAuditEvent } from './audit-events.js';
import type { AuthVariables } from './auth/middleware.js';
import { KernelCommandError } from './generative-kernel/errors.js';
import {
  createOperationInvocation,
  type OperationInvocationDependencies,
  OperationInvocationError,
} from './operation-invocation.js';

const SEARCH_LIMIT = 20;
const querySchema = z.object({ query: z.string().max(500) }).strict();
const describeSchema = z.object({ operation: z.string() }).strict();
const guideSchema = z.object({}).strict();
const callSchema = z
  .object({ operation: z.string(), input: z.record(z.string(), z.unknown()) })
  .strict();

/** Admits the generated object schema through the SDK's actual Tool contract. */
function mcpInputSchema(schema: z.ZodObject) {
  return ToolSchema.shape.inputSchema.parse(z.toJSONSchema(schema));
}

/** Product guidance for plain MCP clients; tool presence and client approval never grant authority. */
const GUIDE = `Use search to discover an operation, then describe it to learn its complete input and mutation posture. Call one operation at a time with that input. Discovery is metadata, never a permission decision. Only operations currently migrated into the definition tables are available here; the user-facing OpenKit Skill remains available for the remaining product surface.

NanoCore owns authorization, durable state, approval, idempotency, audit, recovery and execution. Ask the user for each server-required human approval and convey only their explicit decision for the exact proposal. A client approval prompt is not an OpenKit human decision. Existing authorization for a bounded action remains valid; do not repeatedly request it.

Read durable state after a mutation. A transport failure does not prove that an effect did not happen. Inspect the owner outcome before retrying; reuse the exact requestId only for an exact replay. Never claim cancellation from a disconnected client. Keep credentials and one-time secrets out of conversation, logs, artifacts and knowledge. Token issuance, rotation and bootstrap secret responses are unavailable over MCP.

For external Codex clients, set default_tools_approval_mode = "approve" for this OpenKit MCP server. NanoCore still enforces its own permission and approval requirements.

Follow the product loop: select a Workspace, inspect resources, select or create a Thread, use Chat for a lightweight answer or Task for bounded work, read Action Center and durable results, present required decisions to the user, then continue or recover from current state. New Goal execution remains unavailable until its implementation lands. Use the retained OpenKit Skill's relevant setup, loop, knowledge, recovery, administration or acceptance reference when the needed operation is not yet migrated.`;

/** Truthful operation metadata derived from the single definition, never a grant. */
function descriptor(id: string, definition: (typeof OPERATION_DEFINITIONS)[OperationId]) {
  return {
    id,
    description: definition.description,
    mutating: definition.mutating,
    credentials: definition.credentials,
    annotations: { readOnlyHint: !definition.mutating, destructiveHint: definition.mutating },
    inputSchema: z.toJSONSchema(definition.inputSchema),
    outputSchema: z.toJSONSchema(definition.outputSchema),
  };
}

/** Excludes the credential owner's actual one-time-secret result contracts before any invocation. */
function returnsOneTimeSecret(definition: { readonly outputSchema: z.ZodType }): boolean {
  // Bootstrap aliases issuance's schema. Future credential cutover reuses these existing contracts.
  // This is a schema boundary, not an operation-id denylist or an inference from result values.
  return (
    definition.outputSchema === CreateOpenKitAccessTokenResponseSchema ||
    definition.outputSchema === RotateOpenKitAccessTokenResponseSchema
  );
}

/** Tokenizes semantic ids and prose so multiple query terms rank independent of word order. */
function terms(value: string): string[] {
  return [
    ...new Set(
      value
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter(Boolean)
    ),
  ];
}

/** Bounded metadata search over every currently composed definition family. */
function search(query: string) {
  const wanted = terms(query);
  const matches = Object.entries(OPERATION_DEFINITIONS)
    .filter(([, definition]) => !returnsOneTimeSecret(definition))
    .map(([id, definition]) => {
      const tokens = terms(`${id} ${definition.description}`);
      return {
        id,
        description: definition.description,
        mutating: definition.mutating,
        score: wanted.filter((term) => tokens.some((token) => token.startsWith(term))).length,
      };
    })
    .filter((entry) => wanted.length === 0 || entry.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return {
    items: matches.slice(0, SEARCH_LIMIT).map(({ score: _score, ...entry }) => entry),
    total: matches.length,
    hasMore: matches.length > SEARCH_LIMIT,
  };
}

/** Registers stateless Streamable HTTP after Token admission, gating mutations on the shared current boot readiness. */
export function registerRemoteMcpRoutes({
  app,
  getBootReadiness,
  ...dependencies
}: OperationInvocationDependencies & {
  readonly app: Hono<{ Variables: AuthVariables }>;
  readonly getBootReadiness: () => BootReadinessSnapshot;
}): void {
  app.all('/mcp', async (c) => {
    const actor = c.get('actor');
    let refused = false;
    let operationId: string | undefined;
    let requestId: string | undefined;
    const server = new Server(
      { name: 'openkit', version: '0.0.0' },
      {
        capabilities: { tools: {} },
        instructions: GUIDE,
      }
    );
    server.setRequestHandler('tools/list', async () => ({
      tools: [
        {
          name: 'search',
          description:
            'Search bounded operation metadata by semantic id and description; discovery is not permission.',
          inputSchema: mcpInputSchema(querySchema),
          annotations: { readOnlyHint: true, destructiveHint: false },
        },
        {
          name: 'describe',
          description:
            'Read one operation contract and its mutation annotations from the definition table.',
          inputSchema: mcpInputSchema(describeSchema),
          annotations: { readOnlyHint: true, destructiveHint: false },
        },
        {
          name: 'guide',
          description: 'Read product workflow, human-decision and recovery guidance.',
          inputSchema: mcpInputSchema(guideSchema),
          annotations: { readOnlyHint: true, destructiveHint: false },
        },
        // A multiplexed call can mutate; describe carries the exact selected operation's posture.
        {
          name: 'call',
          description:
            'Invoke one described operation as the authenticated Token user. May mutate; use describe for the selected operation. Ask the user for every server-required human decision.',
          inputSchema: mcpInputSchema(callSchema),
          annotations: {
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: false,
            openWorldHint: true,
          },
        },
      ],
    }));
    server.setRequestHandler('tools/call', async (request) => {
      try {
        const args = request.params.arguments ?? {};
        let result: unknown;
        switch (request.params.name) {
          case 'search':
            result = search(querySchema.parse(args).query);
            break;
          case 'guide':
            guideSchema.parse(args);
            return { content: [{ type: 'text', text: GUIDE }] };
          case 'describe': {
            const { operation } = describeSchema.parse(args);
            const definition = definitionFor(operation);
            result = descriptor(operation, definition);
            break;
          }
          case 'call': {
            const { operation, input } = callSchema.parse(args);
            const definition = definitionFor(operation);
            operationId = operation;
            // Only the canonical id and UUID correlate audit; never record arbitrary tool input.
            requestId = z.uuid().safeParse(input.requestId).data;
            if (definition.mutating && !getBootReadiness().acceptingProductWork)
              throw new OperationInvocationError(
                'product_work_unavailable',
                'NanoCore is not accepting product work during the current boot readiness state.',
                503
              );
            result = await createOperationInvocation(dependencies)(
              operation as OperationId,
              input,
              { kind: 'public', actor }
            );
            break;
          }
          default:
            throw new OperationInvocationError('unsupported_operation', 'Unknown tool.', 400);
        }
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (error) {
        refused = true;
        const result =
          error instanceof OperationInvocationError ||
          error instanceof KernelCommandError ||
          error instanceof RemoteMcpSecretRefusal
            ? { code: error.code, message: error.message }
            : error instanceof z.ZodError
              ? { code: 'invalid_request', message: 'Invalid tool input.' }
              : {
                  code: 'operation_failed',
                  message: 'Operation failed. Inspect the owner outcome before retrying.',
                };
        return { isError: true, content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
    });
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    try {
      await server.connect(transport);
      const response = await transport.handleRequest(c.req.raw);
      if (dependencies.coreDb)
        recordServerAuditEvent({
          coreDb: dependencies.coreDb,
          actor: { kind: 'user', id: actor.userId },
          action: 'remote-mcp.request',
          resource: operationId ? `operation:${operationId}` : '/mcp',
          requestId: requestId ?? null,
          outcome: refused ? 'denied' : response.ok ? 'succeeded' : 'failed',
          summary: `remote-mcp request using Token ${actor.tokenId}.`,
        });
      return response;
    } finally {
      await server.close();
    }
  });
}

/** Resolves only the composed tables and refuses excluded contracts before dispatch. */
function definitionFor(id: string) {
  if (!Object.hasOwn(OPERATION_DEFINITIONS, id))
    throw new OperationInvocationError('unsupported_operation', 'Unknown operation.', 400);
  const definition = OPERATION_DEFINITIONS[id as OperationId];
  if (returnsOneTimeSecret(definition)) throw new RemoteMcpSecretRefusal();
  return definition;
}

/** Projection-owned refusal for the credential owner's secret-returning contracts. */
class RemoteMcpSecretRefusal extends Error {
  readonly code = 'mcp_secret_returning_operation';
  constructor() {
    super('One-time secret operations are unavailable over MCP.');
  }
}
