/** Policy candidate validation reads this metadata without loading native execution or composition. */
import { createHash } from 'node:crypto';
import {
  composeOperationTables,
  GENERATIVE_UI_OPERATION_DEFINITIONS,
  KERNEL_OPERATION_DEFINITIONS,
  KERNEL_REMAINING_OPERATION_DEFINITIONS,
  LIGHT_APP_DEFINITION_OPERATION_DEFINITIONS,
  operationMcpEligible,
  operationModelInput,
  operationToolName,
  VAULT_OPERATION_DEFINITIONS,
} from '@openkit/app-api-schemas';
import type { AgentEnvironmentPackage } from '@openkit/config-schema';
import { z } from 'zod';

/** Reserved built-in Worker MCP server id. */
export const OPENKIT_GENERATIVE_MCP_ID = 'openkit-generative';

/** Exact operation table shared by supply projection and native dispatch. */
export const OPENKIT_GENERATIVE_OPERATION_DEFINITIONS = composeOperationTables(
  KERNEL_OPERATION_DEFINITIONS,
  KERNEL_REMAINING_OPERATION_DEFINITIONS,
  LIGHT_APP_DEFINITION_OPERATION_DEFINITIONS,
  GENERATIVE_UI_OPERATION_DEFINITIONS,
  {
    'vault.grant-request': VAULT_OPERATION_DEFINITIONS['vault.grant-request'],
    'vault.grant-request-list': VAULT_OPERATION_DEFINITIONS['vault.grant-request-list'],
  }
);

function mcpInputSchema(schema: z.ZodType): Record<string, unknown> {
  const projection = z.toJSONSchema(schema, { target: 'draft-2020-12' }) as Record<string, unknown>;
  delete projection.$schema;
  return projection;
}

/** Built-in tool descriptors used for ListTools and catalog digest. */
export const OPENKIT_GENERATIVE_TOOLS = Object.entries(OPENKIT_GENERATIVE_OPERATION_DEFINITIONS)
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
  Record<string, keyof typeof OPENKIT_GENERATIVE_OPERATION_DEFINITIONS>
> = Object.fromEntries(
  Object.keys(OPENKIT_GENERATIVE_OPERATION_DEFINITIONS).map((id) => [operationToolName(id), id])
) as Record<string, keyof typeof OPENKIT_GENERATIVE_OPERATION_DEFINITIONS>;

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
    schemaPolicy: 'pinned',
    pinnedSchemaSnapshotId: null,
  };
}
