import { createHash } from 'node:crypto';
import {
  composeOperationTables,
  GENERATIVE_UI_OPERATION_DEFINITIONS,
  KERNEL_OPERATION_DEFINITIONS,
  KERNEL_REMAINING_OPERATION_DEFINITIONS,
  OPERATION_DEFINITIONS,
  operationMcpEligible,
  operationModelInput,
  operationToolName,
} from '@openkit/app-api-schemas';
import type { AgentEnvironmentPackage } from '@openkit/config-schema';
import { type ActorRef, RequestIdSchema } from '@openkit/protocol';
import { z } from 'zod';
import type { FsStore } from '../lib/store.js';
import { createOperationInvocation } from '../operation-composition.js';
import { OperationError } from '../operation-error.js';
import type { InflightIdempotentCommand } from '../runtime/idempotent-command.js';
import { type CoreDb, openWorkspaceDb, type WorkspaceDb } from '../storage/db.js';
import type { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';

/** Reserved built-in Worker MCP server id. */
export const OPENKIT_GENERATIVE_MCP_ID = 'openkit-generative';

const definitions = composeOperationTables(
  KERNEL_OPERATION_DEFINITIONS,
  KERNEL_REMAINING_OPERATION_DEFINITIONS,
  GENERATIVE_UI_OPERATION_DEFINITIONS
);

function mcpInputSchema(schema: z.ZodType): Record<string, unknown> {
  const projection = z.toJSONSchema(schema, { target: 'draft-2020-12' }) as Record<string, unknown>;
  delete projection.$schema;
  return projection;
}

/** Built-in tool descriptors used for ListTools and catalog digest. */
export const OPENKIT_GENERATIVE_TOOLS = Object.entries(definitions)
  .filter(([, definition]) => operationMcpEligible(definition))
  .map(([id, definition]) => ({
    name: operationToolName(id),
    description: definition.description,
    inputSchema: mcpInputSchema(
      operationModelInput(definition.inputSchema, [
        'workspaceId',
        'requestId',
        'threadId',
        'turnId',
      ])
    ),
  }));

/** Definition-derived admission key for each supplied built-in Tool. */
export const OPENKIT_GENERATIVE_TOOL_OPERATIONS: Readonly<
  Record<string, keyof typeof definitions>
> = Object.fromEntries(Object.keys(definitions).map((id) => [operationToolName(id), id])) as Record<
  string,
  keyof typeof definitions
>;

// A derived spelling is valid only when it cannot collide with another supplied Tool.
if (
  new Set(OPENKIT_GENERATIVE_TOOLS.map((tool) => tool.name)).size !==
  OPENKIT_GENERATIVE_TOOLS.length
) {
  throw new Error('Generative Tool spelling collision.');
}

/** SHA-256 digest of the built-in tool-schema descriptor. */
export const OPENKIT_GENERATIVE_CATALOG_DIGEST = `sha256:${createHash('sha256')
  .update(JSON.stringify(OPENKIT_GENERATIVE_TOOLS))
  .digest('hex')}`;

/**
 * Builds the built-in MCP supply entry for a Worker environment package.
 *
 * @returns Catalog-compatible supply entry.
 */
export function createOpenkitGenerativeMcpSupply(): AgentEnvironmentPackage['supply']['mcpServers'][number] {
  return {
    id: OPENKIT_GENERATIVE_MCP_ID,
    catalogDigest: OPENKIT_GENERATIVE_CATALOG_DIGEST,
    allowedTools: OPENKIT_GENERATIVE_TOOLS.map((tool) => tool.name),
    deniedTools: [],
    approvalRequiredTools: [],
    schemaPolicy: 'pinned',
    pinnedSchemaSnapshotId: null,
  };
}

/** In-process built-in MCP dispatch context. */
export interface OpenkitGenerativeMcpContext {
  /** Current record and mutation owners, required for migrated operations. */
  readonly coreDb?: CoreDb;
  readonly workspaceMutationAdmission?: WorkspaceMutationAdmission;
  /** Immutable selected package identity proved at the relay boundary. */
  readonly packageSnapshotId?: string;
  /** Store that owns Thread/Turn/Item history. */
  readonly store: FsStore;
  /** In-flight command map. */
  readonly inflightCommands: WeakMap<FsStore, Map<string, InflightIdempotentCommand>>;
  /** Data root. */
  readonly dataRoot: string;
  /** Authenticated Workspace. */
  readonly workspaceId: string;
  /** Trusted actor. */
  readonly actor: ActorRef;
  /** Open Workspace database. */
  readonly workspaceDb: WorkspaceDb;
  /** Authenticated environment scope. */
  readonly scope: AgentEnvironmentPackage['scope'];
  /** MCP protocol request identity used to stabilize Kernel request ids. */
  readonly protocolRequestId?: string | number;
}

/**
 * Dispatches one built-in openkit-generative tool in process.
 *
 * @param context Dispatch context.
 * @param toolName Tool name.
 * @param args Tool arguments.
 * @returns Structured tool result.
 */
export async function dispatchOpenkitGenerativeTool(
  context: OpenkitGenerativeMcpContext,
  toolName: string,
  args: Record<string, unknown>
): Promise<{
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'resource'; resource: { uri: string; mimeType: string; text: string } }
  >;
  structuredContent: unknown;
  _meta?: Record<string, unknown>;
}> {
  const operationId = OPENKIT_GENERATIVE_TOOL_OPERATIONS[toolName];
  if (!operationId)
    throw new OperationError('unsupported_operation', 'Unknown generative tool.', 400);
  if (!context.coreDb || !context.workspaceMutationAdmission || !context.packageSnapshotId)
    throw new OperationError('unavailable', 'Invocation authority is unavailable.', 503);
  if (!operationMcpEligible(OPERATION_DEFINITIONS[operationId]))
    throw new OperationError(
      'mcp_result_unavailable',
      'Operation result is unavailable over MCP.',
      400
    );
  const invoke = createOperationInvocation({
    coreDb: context.coreDb,
    store: context.store,
    inflightCommands: context.inflightCommands,
    workspaceMutationAdmission: context.workspaceMutationAdmission,
    repositoryWorkspaceDb: (workspaceId) => openWorkspaceDb(context.dataRoot, workspaceId),
  });
  const packageSnapshotId = context.packageSnapshotId;
  const trustedFor = (id: keyof typeof definitions) => ({
    kind: 'worker' as const,
    actor: context.actor,
    lineage: { ...context.scope, packageSnapshotId },
    requestId: requestIdFrom(context),
    bindings: {
      workspaceId: context.scope.workspaceId,
      ...(definitions[id].mutating ? { requestId: requestIdFrom(context) } : {}),
      ...(id === 'generative-ui.publish'
        ? { threadId: context.scope.threadId, turnId: context.scope.turnId }
        : {}),
      ...('threadField' in OPERATION_DEFINITIONS[id].target
        ? { threadId: context.scope.threadId }
        : {}),
      ...('turnField' in OPERATION_DEFINITIONS[id].target ? { turnId: context.scope.turnId } : {}),
    },
    delivery: 'model' as const,
  });
  const output = await invoke(operationId, args, trustedFor(operationId));
  if (operationId === 'generative-ui.publish') {
    const published =
      output as import('@openkit/app-api-schemas').PublishGenerativePresentationResponse;
    const resource = await invoke(
      'generative-ui.resource',
      { presentationId: published.id },
      trustedFor('generative-ui.resource')
    );
    return {
      content: [
        { type: 'text', text: published.fallbackText },
        { type: 'resource', resource },
      ],
      structuredContent: published,
      _meta: { ui: { resourceUri: resource.uri } },
    };
  }
  return textResult(output);
}

function textResult(value: unknown): {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: unknown;
} {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

/** Derives command identity from the authenticated relay's MCP request, never model arguments. */
function requestIdFrom(context: OpenkitGenerativeMcpContext): string {
  if (typeof context.protocolRequestId === 'string') {
    const parsed = RequestIdSchema.safeParse(context.protocolRequestId);
    if (parsed.success) {
      return parsed.data;
    }
  }
  const seed = `${context.workspaceId}:${context.scope.turnId}:${String(context.protocolRequestId ?? '')}`;
  const hex = createHash('sha256').update(seed).digest('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
