import {
  OPERATION_DEFINITIONS,
  type OperationDefinition,
  operationToolName,
} from '@openkit/app-api-schemas';

/** Builds the current remote invocation envelope for table-driven owner tests. */
export function remoteMcpInvocation(operation: string, input: unknown) {
  const definitions: Readonly<Record<string, OperationDefinition>> = OPERATION_DEFINITIONS;
  const definition = Object.hasOwn(definitions, operation) ? definitions[operation] : undefined;
  if (!definition) throw new Error(`Unknown operation in remote MCP fixture: ${operation}`);
  if (definition.remoteMcp === 'native') {
    return { name: operationToolName(operation), arguments: input };
  }
  return {
    name: definition.mutating ? 'openkit_call' : 'openkit_read',
    arguments: { operation, input },
  };
}
