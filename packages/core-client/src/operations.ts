import {
  KERNEL_OPERATION_DEFINITIONS,
  type KernelOperationId,
  type KernelOperationInput,
  type KernelOperationOutput,
  operationHttpPath,
} from '@openkit/app-api-schemas';
import { createRequestId } from './request-id.js';
import type { ClientTransport } from './transport.js';

/** Typed operation methods derived solely from the shared definition table. */
export type OperationClient = {
  readonly [K in KernelOperationId]: (
    input: KernelOperationInput<K> extends { requestId: string }
      ? Omit<KernelOperationInput<K>, 'requestId'> & { requestId?: string }
      : KernelOperationInput<K>
  ) => Promise<KernelOperationOutput<K>>;
};

/** Projects definition-driven JSON methods onto the existing shared client transport. */
export function createOperationClient(transport: ClientTransport): OperationClient {
  return Object.fromEntries(
    Object.entries(KERNEL_OPERATION_DEFINITIONS).map(([id, definition]) => [
      id,
      async (value: Record<string, unknown>) => {
        const parsed = definition.inputSchema.parse(
          definition.mutating
            ? { ...value, requestId: value.requestId ?? createRequestId() }
            : value
        );
        const { requestId, ...body } = parsed as typeof parsed & { requestId?: string };
        return transport.postJson(
          operationHttpPath(id),
          body,
          definition.outputSchema,
          definition.mutating ? { 'x-openkit-request-id': requestId! } : undefined
        );
      },
    ])
  ) as unknown as OperationClient;
}
