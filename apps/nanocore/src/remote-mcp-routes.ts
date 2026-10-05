import { ToolSchema } from '@modelcontextprotocol/core';
import { Server, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import {
  type BootReadinessSnapshot,
  type JsonOperationId,
  OPERATION_DEFINITIONS,
  type OperationId,
  operationMcpEligible,
} from '@openkit/app-api-schemas';
import type { Hono } from 'hono';
import { z } from 'zod';
import { recordServerAuditEvent } from './audit-events.js';
import type { AuthVariables } from './auth/middleware.js';
import {
  createOperationInvocation,
  type OperationInvocationDependencies,
} from './operation-composition.js';
import { OperationError, projectOperationError } from './operation-error.js';

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
const GUIDE = `Use search to discover an operation, then describe it to learn its complete input and mutation posture. Call one operation at a time with that input. Discovery is metadata, never a permission decision. Remote MCP reaches the release operation definitions except one-time-secret results and the three streaming Workspace archives.

NanoCore owns authorization, durable state, approval, idempotency, audit, recovery and execution. Ask the user for each server-required human approval and convey only their explicit decision for the exact proposal and Pending Request identity. A client approval prompt is not an OpenKit human decision. Existing authorization for a bounded action remains valid; do not repeatedly request it. Never answer a secret question or infer approval, spending authority, review acceptance or budget extension.

Follow the product loop: select a Workspace, inspect resources and repositories within the user's authority, select or create a Thread, and read its durable state. Use Chat for a lightweight answer, Task for bounded delegated work, or Goal for a continuous outcome with immutable Plan approval and completion acceptance. Describe Goal operations before use; card and intent edits do not steer running workers, and there is no Goal step, pause or resume. Formal Task/Goal Threads use workspace visibility explicitly. Read Action Center, the exact receiving Thread and Turn, artifacts, evidence, audit and usage before reporting completion. Command acceptance and configured Worker health do not prove Worker success. Private audiences and credential limits remain enforced even when operation metadata is visible.

Read durable state after a mutation. A transport failure does not prove that an effect did not happen. Inspect the owner outcome before retrying; reuse the exact requestId only for an exact replay with unchanged input. Never claim cancellation from a disconnected client. Follow long work through bounded reads with a deadline. For recovery_required, stale lineage, denied admission or contradictory evidence, retain the typed refusal and inspect the owning records; do not manufacture receipts, edit storage, silently substitute Worker storage or automatically rerun work. Worker storage selection is an eligibility preview, not attachment or checkout recovery. Preserve exact storage revisions and predecessor work-slot lineage. Administrator-originated Tasks retain the presented credential for later effect revalidation.

Use knowledge discovery for sources, observations, claims, retrieval, context packages, conflicts and proposals. Read provenance and health, preserve contradictory evidence, and request the responsible user's exact decision before accepting, rejecting or reversing proposals. Artifacts and evidence are review inputs; compare their actual content with the user's objective and constraints. Artifact introduction alone starts no work. Restricted Material content remains unavailable to model delivery even for administrators; use the authorized human Web path. App update is discoverable but model delivery remains refused until its owner admits exact approval binding; administrators use Web or the administrator CLI.

Keep credentials and one-time secrets out of conversation, logs, artifacts and knowledge. Token issuance, rotation and bootstrap secret responses are unavailable over MCP. Authorized operators use the openkit-ops administrator CLI with preflighted local secret-safe sinks; bootstrap and offline host recovery need their separate authority. Workspace archive operations are streaming-only: ordinary users use Web Portability, and administrators use the administrator CLI with local archive files. Host diagnosis, source editing, installation and process replacement use separately authorized host tools, never arbitrary MCP routes or shell calls. Worker-side MCP and product Skill catalogs remain separate capability supply.

For real-use acceptance, reuse the persistent deployment and normal public operations. Keep the user's objective open-ended; do not inspect story answers, seed hidden state, or require a fixed call trajectory. Independently read back meaningful results and distinguish product, environment, tool and insufficient-evidence outcomes. Optional telemetry is diagnostic support. Preserve unknown effects and attempt attribution; a repair or upgrade begins a new attempt. Report actual identifiers, evidence and remaining limitations without closing untested work or user-reserved gates.

For external Codex clients, set default_tools_approval_mode = "approve" for this OpenKit MCP server. NanoCore still enforces its own permission and approval requirements.`;

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
    .filter(([, definition]) => operationMcpEligible(definition))
    .map(([id, definition]) => {
      const tokens = terms(`${id} ${definition.description}`);
      return {
        id,
        description: definition.description,
        mutating: definition.mutating,
        // An exact id must remain reachable even when many descriptions share its terms.
        score:
          id === query.trim().toLowerCase()
            ? wanted.length + 1
            : wanted.filter((term) => tokens.some((token) => token.startsWith(term))).length,
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
              throw new OperationError(
                'product_work_unavailable',
                'NanoCore is not accepting product work during the current boot readiness state.',
                503
              );
            result = await createOperationInvocation(dependencies)(
              operation as JsonOperationId,
              input,
              { kind: 'public', actor, delivery: 'model', signal: c.req.raw.signal }
            );
            break;
          }
          default:
            throw new OperationError('unsupported_operation', 'Unknown tool.', 400);
        }
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (error) {
        refused = true;
        const result =
          projectOperationError(error) ??
          (error instanceof z.ZodError
            ? { code: 'invalid_request', message: 'Invalid tool input.' }
            : {
                code: 'operation_failed',
                message: 'Operation failed. Inspect the owner outcome before retrying.',
              });
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
    throw new OperationError('unsupported_operation', 'Unknown operation.', 400);
  const definition = OPERATION_DEFINITIONS[id as OperationId];
  if (!operationMcpEligible(definition))
    throw new OperationError(
      definition.returnsOneTimeSecret
        ? 'mcp_secret_returning_operation'
        : 'mcp_streaming_operation',
      definition.returnsOneTimeSecret
        ? 'One-time secret operations are unavailable over MCP.'
        : 'Streaming operations are unavailable over MCP. Use the retained archive transfer interface.',
      400
    );
  return definition;
}
