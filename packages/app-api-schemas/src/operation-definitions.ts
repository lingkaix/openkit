import type { z } from 'zod';
import { ARTIFACT_OPERATION_DEFINITIONS } from './artifact-operations.js';
import { ATTENTION_OPERATION_DEFINITIONS } from './attention-operations.js';
import { AUTOMATION_OPERATION_DEFINITIONS } from './automation-operations.js';
import {
  CONVERSATION_OPERATION_DEFINITIONS,
  TASK_OPERATION_DEFINITIONS,
} from './conversation-operations.js';
import { DATA_ROOT_ADMIN_OPERATION_DEFINITIONS } from './data-root-admin-operations.js';
import {
  GENERATIVE_UI_OPERATION_DEFINITIONS,
  KERNEL_REMAINING_OPERATION_DEFINITIONS,
} from './generative-operations.js';
import { GOAL_OPERATION_DEFINITIONS } from './goal.js';
import { KERNEL_OPERATION_DEFINITIONS } from './kernel-operations.js';
import {
  KNOWLEDGE_ENTRY_OPERATION_DEFINITIONS,
  KNOWLEDGE_OPERATION_DEFINITIONS,
} from './knowledge-operation-definitions.js';
import { NANOHOST_OPERATION_DEFINITIONS } from './nanohost-operations.js';
import { composeOperationTables } from './operation-contract.js';
import { PENDING_REQUEST_OPERATION_DEFINITIONS } from './pending-request-operations.js';
import { PROVIDER_SUBSCRIPTION_OPERATION_DEFINITIONS } from './provider-subscription-operations.js';
import { RECOVERY_OPERATION_DEFINITIONS } from './recovery-operations.js';
import { RUNTIME_CONFIG_OPERATION_DEFINITIONS } from './runtime-config-operations.js';
import { SCHEDULER_OPERATION_DEFINITIONS } from './scheduler-operations.js';
import { SYNC_OPERATION_DEFINITIONS } from './sync-operations.js';
import { THREAD_OPERATION_DEFINITIONS } from './thread-operations.js';
import { TURN_OPERATION_DEFINITIONS } from './turn-operations.js';
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
  OperationDefinition,
  OperationMutationTarget,
  OperationProjectionFacts,
  OperationScope,
  OperationTarget,
} from './operation-contract.js';
export { composeOperationTables, operationMcpEligible } from './operation-contract.js';
export { PENDING_REQUEST_OPERATION_DEFINITIONS } from './pending-request-operations.js';
export { PROVIDER_SUBSCRIPTION_OPERATION_DEFINITIONS } from './provider-subscription-operations.js';
export { RUNTIME_CONFIG_OPERATION_DEFINITIONS } from './runtime-config-operations.js';
export { THREAD_OPERATION_DEFINITIONS } from './thread-operations.js';
export { TURN_OPERATION_DEFINITIONS } from './turn-operations.js';
export { WORKSPACE_OPERATION_DEFINITIONS } from './workspace-operations.js';

/** Statically composed deployment administration; bootstrap retains its separate authentication procedure. */
export const ADMINISTRATION_OPERATION_DEFINITIONS = composeOperationTables(
  NANOHOST_OPERATION_DEFINITIONS,
  DATA_ROOT_ADMIN_OPERATION_DEFINITIONS
);

/** Statically composed product contracts. */
export const PRODUCT_OPERATION_DEFINITIONS = composeOperationTables(
  RUNTIME_CONFIG_OPERATION_DEFINITIONS,
  PROVIDER_SUBSCRIPTION_OPERATION_DEFINITIONS,
  AUTOMATION_OPERATION_DEFINITIONS,
  SCHEDULER_OPERATION_DEFINITIONS,
  RECOVERY_OPERATION_DEFINITIONS,
  KERNEL_OPERATION_DEFINITIONS,
  KERNEL_REMAINING_OPERATION_DEFINITIONS,
  GENERATIVE_UI_OPERATION_DEFINITIONS,
  WORKSPACE_OPERATION_DEFINITIONS,
  WORKSPACE_TRANSFER_OPERATION_DEFINITIONS,
  WORKSPACE_LIFECYCLE_OPERATION_DEFINITIONS,
  THREAD_OPERATION_DEFINITIONS,
  TURN_OPERATION_DEFINITIONS,
  KNOWLEDGE_OPERATION_DEFINITIONS,
  KNOWLEDGE_ENTRY_OPERATION_DEFINITIONS,
  ARTIFACT_OPERATION_DEFINITIONS,
  GOAL_OPERATION_DEFINITIONS,
  SYNC_OPERATION_DEFINITIONS,
  CONVERSATION_OPERATION_DEFINITIONS,
  TASK_OPERATION_DEFINITIONS,
  ATTENTION_OPERATION_DEFINITIONS,
  PENDING_REQUEST_OPERATION_DEFINITIONS
);

/** Static composition of the implemented families; this is not a registration surface. */
export const OPERATION_DEFINITIONS = composeOperationTables(
  PRODUCT_OPERATION_DEFINITIONS,
  ADMINISTRATION_OPERATION_DEFINITIONS
);
/** JSON product ids inferred from the static public composition. */
export type ProductOperationId = keyof typeof PRODUCT_OPERATION_DEFINITIONS;
/** Exact implemented ids inferred from the definitions. */
export type OperationId = keyof typeof OPERATION_DEFINITIONS;
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
/** Derives the provider/MCP spelling; assemblers check collisions across supplied Tools. */
export function operationToolName(id: string): string {
  return id.replaceAll('.', '_').replaceAll('-', '_');
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
