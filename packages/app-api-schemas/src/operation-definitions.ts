import { PolicyWriteOutcomeV1Schema, PolicyWriteProposalV1Schema } from '@openkit/protocol';
import { z } from 'zod';
import { ACCESS_TOKEN_OPERATION_DEFINITIONS } from './access-token-operations.js';
import { ADMINISTRATION_ENTRY_OPERATION_DEFINITIONS } from './administration-operations.js';
import { ADMINISTRATOR_CLEANUP_OPERATION_DEFINITIONS } from './administrator-cleanup-operations.js';
import { AGENT_OPERATION_DEFINITIONS } from './agent-operations.js';
import { APP_SEARCH_OPERATION_DEFINITIONS } from './app-search-operations.js';
import { APP_UPDATE_OPERATION_DEFINITIONS } from './app-update-operations.js';
import { ARTIFACT_OPERATION_DEFINITIONS } from './artifact-operations.js';
import { ATTENTION_OPERATION_DEFINITIONS } from './attention-operations.js';
import { AUTOMATION_OPERATION_DEFINITIONS } from './automation-operations.js';
import { CALLER_OPERATION_DEFINITIONS } from './caller-operations.js';
import { CATALOG_OPERATION_DEFINITIONS } from './catalog-operations.js';
import { CHANNEL_OPERATION_DEFINITIONS } from './channels.js';
import {
  CONVERSATION_OPERATION_DEFINITIONS,
  TASK_OPERATION_DEFINITIONS,
} from './conversation-operations.js';
import { DATA_ROOT_ADMIN_OPERATION_DEFINITIONS } from './data-root-admin-operations.js';
import { DIAGNOSTICS_OPERATION_DEFINITIONS } from './diagnostics-operations.js';
import { ENVIRONMENT_OPERATION_DEFINITIONS } from './environment-operations.js';
import { EXTERNAL_TRIGGER_OPERATION_DEFINITIONS } from './external-trigger-operations.js';
import {
  GENERATIVE_UI_OPERATION_DEFINITIONS,
  KERNEL_REMAINING_OPERATION_DEFINITIONS,
} from './generative-operations.js';
import { GOAL_OPERATION_DEFINITIONS } from './goal.js';
import { GOVERNANCE_OPERATION_DEFINITIONS } from './governance-operations.js';
import { KERNEL_OPERATION_DEFINITIONS } from './kernel-operations.js';
import {
  KNOWLEDGE_ENTRY_OPERATION_DEFINITIONS,
  KNOWLEDGE_OPERATION_DEFINITIONS,
} from './knowledge-operation-definitions.js';
import { LIGHT_APP_DEFINITION_OPERATION_DEFINITIONS } from './light-app-definitions.js';
import { MATERIAL_OPERATION_DEFINITIONS } from './material-operations.js';
import { MEMORY_OPERATION_DEFINITIONS } from './memory.js';
import { NANOHOST_OPERATION_DEFINITIONS } from './nanohost-operations.js';
import { composeOperationTables, type NativeOperationDefinition } from './operation-contract.js';
import { PENDING_REQUEST_OPERATION_DEFINITIONS } from './pending-request-operations.js';
import { PROVIDER_SUBSCRIPTION_OPERATION_DEFINITIONS } from './provider-subscription-operations.js';
import { RECOVERY_OPERATION_DEFINITIONS } from './recovery-operations.js';
import { RESOURCE_POLICY_OPERATION_DEFINITIONS } from './resource-policy-operations.js';
import { RUNTIME_CONFIG_OPERATION_DEFINITIONS } from './runtime-config-operations.js';
import { SCHEDULER_OPERATION_DEFINITIONS } from './scheduler-operations.js';
import { SERVER_MCP_OPERATION_DEFINITIONS } from './server-mcp-operations.js';
import { SERVER_THREAD_OPERATION_DEFINITIONS } from './server-threads.js';
import { SYNC_OPERATION_DEFINITIONS } from './sync-operations.js';
import { THREAD_OPERATION_DEFINITIONS } from './thread-operations.js';
import { TURN_OPERATION_DEFINITIONS } from './turn-operations.js';
import { VAULT_OPERATION_DEFINITIONS } from './vault-operations.js';
import { WORKER_ENVIRONMENT_OPERATION_DEFINITIONS } from './worker-environment-operations.js';
import { WORKER_OPERATION_DEFINITIONS } from './worker-operations.js';
import { WORKSPACE_ARCHIVE_OPERATION_DEFINITIONS } from './workspace-archive-operations.js';
import { WORKSPACE_LIFECYCLE_OPERATION_DEFINITIONS } from './workspace-lifecycle-operations.js';
import { WORKSPACE_OPERATION_DEFINITIONS } from './workspace-operations.js';
import { WORKSPACE_TRANSFER_OPERATION_DEFINITIONS } from './workspace-transfer.js';

export { ARTIFACT_OPERATION_DEFINITIONS } from './artifact-operations.js';
export { ATTENTION_OPERATION_DEFINITIONS } from './attention-operations.js';
export {
  CONVERSATION_OPERATION_DEFINITIONS,
  TASK_OPERATION_DEFINITIONS,
} from './conversation-operations.js';
export type {
  KernelOperationId,
  KernelOperationInput,
  KernelOperationOutput,
} from './kernel-operations.js';
export { KERNEL_OPERATION_DEFINITIONS } from './kernel-operations.js';
export {
  KNOWLEDGE_ENTRY_OPERATION_DEFINITIONS,
  KNOWLEDGE_OPERATION_DEFINITIONS,
} from './knowledge-operation-definitions.js';
export type {
  NativeOperationDefinition,
  OperationCrossing,
  OperationDefinition,
  OperationMutationTarget,
  OperationParticipationMode,
  OperationProjectionFacts,
  OperationScope,
  OperationStage,
  OperationTarget,
} from './operation-contract.js';
export {
  composeOperationTables,
  operationMcpEligible,
  operationUsesBootstrapSecret,
} from './operation-contract.js';
export { PENDING_REQUEST_OPERATION_DEFINITIONS } from './pending-request-operations.js';
export { PROVIDER_SUBSCRIPTION_OPERATION_DEFINITIONS } from './provider-subscription-operations.js';
export { RUNTIME_CONFIG_OPERATION_DEFINITIONS } from './runtime-config-operations.js';
export { THREAD_OPERATION_DEFINITIONS } from './thread-operations.js';
export { TURN_OPERATION_DEFINITIONS } from './turn-operations.js';
export { WORKSPACE_OPERATION_DEFINITIONS } from './workspace-operations.js';

/** Statically composed deployment administration; bootstrap retains its separate authentication procedure. */
export const ADMINISTRATION_OPERATION_DEFINITIONS = composeOperationTables(
  WORKER_ENVIRONMENT_OPERATION_DEFINITIONS,
  ADMINISTRATION_ENTRY_OPERATION_DEFINITIONS,
  ADMINISTRATOR_CLEANUP_OPERATION_DEFINITIONS,
  APP_UPDATE_OPERATION_DEFINITIONS,
  DIAGNOSTICS_OPERATION_DEFINITIONS,
  NANOHOST_OPERATION_DEFINITIONS,
  DATA_ROOT_ADMIN_OPERATION_DEFINITIONS
);

/** Statically composed product contracts. */
export const PRODUCT_OPERATION_DEFINITIONS = composeOperationTables(
  CALLER_OPERATION_DEFINITIONS,
  CHANNEL_OPERATION_DEFINITIONS,
  RUNTIME_CONFIG_OPERATION_DEFINITIONS,
  PROVIDER_SUBSCRIPTION_OPERATION_DEFINITIONS,
  VAULT_OPERATION_DEFINITIONS,
  APP_SEARCH_OPERATION_DEFINITIONS,
  ENVIRONMENT_OPERATION_DEFINITIONS,
  AUTOMATION_OPERATION_DEFINITIONS,
  EXTERNAL_TRIGGER_OPERATION_DEFINITIONS,
  SCHEDULER_OPERATION_DEFINITIONS,
  RECOVERY_OPERATION_DEFINITIONS,
  KERNEL_OPERATION_DEFINITIONS,
  KERNEL_REMAINING_OPERATION_DEFINITIONS,
  GENERATIVE_UI_OPERATION_DEFINITIONS,
  WORKSPACE_OPERATION_DEFINITIONS,
  RESOURCE_POLICY_OPERATION_DEFINITIONS,
  WORKSPACE_TRANSFER_OPERATION_DEFINITIONS,
  WORKSPACE_ARCHIVE_OPERATION_DEFINITIONS,
  WORKSPACE_LIFECYCLE_OPERATION_DEFINITIONS,
  THREAD_OPERATION_DEFINITIONS,
  TURN_OPERATION_DEFINITIONS,
  KNOWLEDGE_OPERATION_DEFINITIONS,
  KNOWLEDGE_ENTRY_OPERATION_DEFINITIONS,
  MEMORY_OPERATION_DEFINITIONS,
  ARTIFACT_OPERATION_DEFINITIONS,
  GOAL_OPERATION_DEFINITIONS,
  SYNC_OPERATION_DEFINITIONS,
  CONVERSATION_OPERATION_DEFINITIONS,
  TASK_OPERATION_DEFINITIONS,
  ATTENTION_OPERATION_DEFINITIONS,
  PENDING_REQUEST_OPERATION_DEFINITIONS,
  AGENT_OPERATION_DEFINITIONS,
  CATALOG_OPERATION_DEFINITIONS,
  SERVER_MCP_OPERATION_DEFINITIONS,
  SERVER_THREAD_OPERATION_DEFINITIONS,
  LIGHT_APP_DEFINITION_OPERATION_DEFINITIONS,
  WORKER_OPERATION_DEFINITIONS,
  GOVERNANCE_OPERATION_DEFINITIONS,
  MATERIAL_OPERATION_DEFINITIONS
);

/** Static composition of the implemented families; this is not a registration surface. */
const API_OPERATION_DEFINITIONS = composeOperationTables(
  PRODUCT_OPERATION_DEFINITIONS,
  ADMINISTRATION_OPERATION_DEFINITIONS,
  ACCESS_TOKEN_OPERATION_DEFINITIONS
);
/** The shared registry includes native dispatch without publishing a transport projection. */
export const OPERATION_REGISTRY = composeOperationTables(API_OPERATION_DEFINITIONS, {
  'policy.write': {
    binding: 'native',
    description:
      'Apply one exact human-confirmed Policy candidate through the configuration owner.',
    inputSchema: PolicyWriteProposalV1Schema,
    outputSchema: PolicyWriteOutcomeV1Schema,
    policyOperation: 'workspace.configure',
    crossings: ['administration'],
    stages: ['propose', 'decide', 'commit', 'completed'],
    modes: [],
    participantKinds: [],
  } satisfies NativeOperationDefinition,
  'mcp.call-tool': {
    binding: 'native',
    description: 'Dispatch one admitted Worker MCP Tool call through its existing native owner.',
    inputSchema: z
      .object({
        serverId: z.string().min(1),
        toolName: z.string().min(1),
        arguments: z.record(z.string(), z.json()),
      })
      .strict(),
    // The MCP owner validates its vendor result; this boundary carries a JSON value.
    outputSchema: z.json(),
    policyOperation: 'tool.use',
    crossings: ['dispatch'],
    stages: ['propose', 'decide', 'commit', 'completed'],
    modes: ['observe', 'advise', 'gate', 'transform'],
    participantKinds: ['deterministic'],
  } satisfies NativeOperationDefinition,
});

/** Existing API projections are selected from the single composed registry. */
export const OPERATION_DEFINITIONS = Object.fromEntries(
  Object.entries(OPERATION_REGISTRY).filter(([, definition]) => definition.binding !== 'native')
) as typeof API_OPERATION_DEFINITIONS;

/** JSON product ids inferred from the static public composition. */
export type ProductOperationId = keyof typeof PRODUCT_OPERATION_DEFINITIONS;
/** Exact implemented ids inferred from the definitions. */
export type OperationId = keyof typeof OPERATION_DEFINITIONS;
/** Only JSON bindings join transport-free invocation and the generated JSON client. */
export type JsonOperationId = {
  [K in OperationId]: (typeof OPERATION_DEFINITIONS)[K]['binding'] extends 'json' ? K : never;
}[OperationId];
/** Complete logical input of an implemented operation. */
export type OperationInput<K extends OperationId> = z.infer<
  (typeof OPERATION_DEFINITIONS)[K]['inputSchema']
>;
/** Validated output of an implemented operation. */
export type OperationOutput<K extends OperationId> = z.infer<
  (typeof OPERATION_DEFINITIONS)[K]['outputSchema']
>;

/** Derives the canonical one-route JSON binding without a second path catalog. */
export function operationHttpPath<K extends string>(id: K): `/api/app/operations/${K}` {
  return `/api/app/operations/${id}`;
}
/** Derives the provider/MCP spelling by replacing dots only; assemblers check supplied Tool collisions. */
export function operationToolName(id: string): string {
  return id.replaceAll('.', '_');
}
/**
 * Checks current logical operation and Tool names before their model projection.
 *
 * Reused contracts may repeat the same id. Distinct ids must remain distinct after wrappers also fold hyphens to underscores.
 *
 * @param ids Canonical ids from the actual composed declarations or supplied Tools.
 * @throws When an id has invalid grammar, exceeds the model limit, or collides.
 */
export function assertOperationNames(ids: Iterable<string>): void {
  const projected = new Map<string, string>();
  for (const id of ids) {
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*)+$/.test(id)) {
      throw new Error(`Invalid operation name: ${id}`);
    }
    const name = operationToolName(id);
    if (name.length > 40) throw new Error(`Operation Tool name exceeds 40 characters: ${id}`);
    const folded = name.replaceAll('-', '_');
    const previous = projected.get(folded);
    if (previous !== undefined && previous !== id) {
      throw new Error(`Operation Tool name collision: ${previous} and ${id}`);
    }
    projected.set(folded, id);
  }
}
/** Mechanically omits context-bound fields while preserving the remaining schema objects. */
export function operationModelInput(
  schema: z.ZodObject,
  boundFields: readonly string[]
): z.ZodObject {
  const shape = Object.fromEntries(
    Object.entries(schema.shape).filter(([key]) => !boundFields.includes(key))
  );
  // Zod omit rejects refined objects; cloning the shape retains each field and the owner's cross-field checks.
  return schema.clone({ ...schema.def, shape });
}

export { ACCESS_TOKEN_OPERATION_DEFINITIONS } from './access-token-operations.js';
export { ADMINISTRATION_ENTRY_OPERATION_DEFINITIONS } from './administration-operations.js';
export { APP_UPDATE_OPERATION_DEFINITIONS } from './app-update-operations.js';
export { CALLER_OPERATION_DEFINITIONS } from './caller-operations.js';
export { WORKER_ENVIRONMENT_OPERATION_DEFINITIONS } from './worker-environment-operations.js';
