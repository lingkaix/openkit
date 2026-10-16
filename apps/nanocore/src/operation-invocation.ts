import {
  type JsonOperationId,
  OPERATION_DEFINITIONS,
  type OperationInput,
  type OperationOutput,
} from '@openkit/app-api-schemas';
import type { z } from 'zod';
import type {
  AssistantOperationInvocationContext,
  InternalOperationDefinition,
  InternalOperationImplementations,
  OperationImplementations,
  OperationInvocationContext,
} from './operation-contract.js';
import { OperationError } from './operation-error.js';
import {
  admitInternalOperation,
  admitOperation,
  type OperationAdmissionDependencies,
} from './operation-resolvers.js';

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
      return (await invokeDefinedOperation(definition, () =>
        implementations[id](
          admitted.input as OperationInput<K>,
          admitted.context as Parameters<OperationImplementations[K]>[1]
        )
      )) as OperationOutput<K>;
    } finally {
      admitted.release?.();
    }
  };
}

/** Creates one transient exact-key private binding; neither public dispatch nor registration can reach it. */
export function createInternalOperationEngine<
  const T extends Readonly<Record<string, InternalOperationDefinition>>,
>(
  definitions: T,
  implementations: InternalOperationImplementations<T>,
  dependencies: OperationAdmissionDependencies,
  binding: AssistantOperationInvocationContext
) {
  // Copy trusted identity and handler joins so later caller mutation cannot replace this run's binding.
  const retained = binding && { ...binding, actor: structuredClone(binding.actor) };
  const handlers = { ...implementations };
  return async <K extends keyof T & string>(
    id: K,
    value: unknown,
    entry: AssistantOperationInvocationContext | OperationInvocationContext
  ): Promise<z.output<T[K]['outputSchema']>> => {
    if (
      !Object.hasOwn(definitions, id) ||
      !Object.hasOwn(handlers, id) ||
      typeof handlers[id] !== 'function'
    )
      throw new OperationError('unsupported_operation', 'Unknown operation.', 400);
    const definition = definitions[id]!;
    const admitted = admitInternalOperation(definition, value, entry, retained, dependencies);
    return (await invokeDefinedOperation(
      definition,
      () => handlers[id](admitted.input as z.output<T[K]['inputSchema']>, admitted.context),
      admitted.context.signal
    )) as z.output<T[K]['outputSchema']>;
  };
}

/** Runs an admitted handler and validates its logical output through the same native mechanism. */
async function invokeDefinedOperation(
  definition: Pick<InternalOperationDefinition, 'outputSchema'> & { readonly mutating: boolean },
  run: () => unknown | Promise<unknown>,
  signal?: AbortSignal
): Promise<unknown> {
  signal?.throwIfAborted();
  const output = await run();
  signal?.throwIfAborted();
  const validated = definition.outputSchema.safeParse(output);
  if (!validated.success)
    throw new OperationError(
      'invalid_operation_output',
      definition.mutating
        ? 'Operation output is invalid. Inspect the effect outcome; output validation does not undo committed effects.'
        : 'Operation output is invalid.',
      500
    );
  return validated.data;
}
