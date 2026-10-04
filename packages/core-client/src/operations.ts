import {
  type JsonOperationId,
  OPERATION_DEFINITIONS,
  type OperationOutput,
  operationHttpPath,
} from '@openkit/app-api-schemas';
import type { z } from 'zod';
import { createRequestId } from './request-id.js';
import type { ClientTransport } from './transport.js';

/** Caller arguments retain schema defaults; handlers consume the parsed output type. */
type OperationArguments<K extends JsonOperationId> = z.input<
  (typeof OPERATION_DEFINITIONS)[K]['inputSchema']
>;

/** Typed operation methods derived solely from the shared definition table. */
export type OperationClient = {
  readonly [K in JsonOperationId]: (
    input: (typeof OPERATION_DEFINITIONS)[K]['mutating'] extends true
      ? OperationArguments<K> extends { requestId: string }
        ? Omit<OperationArguments<K>, 'requestId'> & { requestId?: string }
        : OperationArguments<K>
      : OperationArguments<K>
  ) => Promise<OperationOutput<K>>;
};

/** Projects definition-driven JSON methods onto the existing shared client transport. */
export function createOperationClient(transport: ClientTransport): OperationClient {
  return Object.fromEntries(
    Object.entries(OPERATION_DEFINITIONS)
      .filter(([, definition]) => definition.binding === 'json')
      .map(([id, definition]) => [
        id,
        async (value: Record<string, unknown>) => {
          const parsed = definition.inputSchema.parse(
            definition.mutating && 'requestId' in definition.inputSchema.shape
              ? { ...value, requestId: value.requestId ?? createRequestId() }
              : value
          );
          const { requestId, ...body } = parsed as typeof parsed & { requestId?: string };
          return transport.postJson(
            operationHttpPath(id),
            definition.mutating ? body : parsed,
            definition.outputSchema,
            definition.mutating && requestId ? { 'x-openkit-request-id': requestId } : undefined,
            'successStatus' in definition && definition.successStatus === 204
          );
        },
      ])
  ) as unknown as OperationClient;
}
