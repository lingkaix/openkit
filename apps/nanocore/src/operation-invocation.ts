import {
  type JsonOperationId,
  OPERATION_DEFINITIONS,
  type OperationInput,
  type OperationOutput,
} from '@openkit/app-api-schemas';
import type { OperationImplementations, OperationInvocationContext } from './operation-contract.js';
import { OperationError } from './operation-error.js';
import { admitOperation, type OperationAdmissionDependencies } from './operation-resolvers.js';

/** The native engine receives already composed behavior and only the existing admission owners. */
export function createOperationEngine(
  implementations: OperationImplementations,
  dependencies: OperationAdmissionDependencies
) {
  return async <K extends JsonOperationId>(
    id: K,
    value: unknown,
    entry: OperationInvocationContext
  ): Promise<OperationOutput<K>> => {
    if (!Object.hasOwn(OPERATION_DEFINITIONS, id))
      throw new OperationError('unsupported_operation', 'Unknown operation.', 400);
    const definition = OPERATION_DEFINITIONS[id];
    if (definition.binding !== 'json')
      throw new OperationError('unsupported_operation', 'Unknown operation.', 400);
    const admitted = admitOperation(definition, value, entry, dependencies);
    try {
      const output = await implementations[id](
        admitted.input as OperationInput<K>,
        admitted.context as Parameters<OperationImplementations[K]>[1]
      );
      const validated = definition.outputSchema.safeParse(output);
      if (!validated.success)
        throw new OperationError(
          'invalid_operation_output',
          definition.mutating
            ? 'Operation output is invalid. Inspect the effect outcome; output validation does not undo committed effects.'
            : 'Operation output is invalid.',
          500
        );
      return validated.data as OperationOutput<K>;
    } finally {
      admitted.release?.();
    }
  };
}
