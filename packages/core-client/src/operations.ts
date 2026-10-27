import {
  AppDiagnosticsClientResponseSchema,
  type JsonOperationId,
  OPERATION_DEFINITIONS,
  type OperationOutput,
  operationHttpPath,
} from '@openkit/app-api-schemas';
import type { z } from 'zod';
import { createRequestId } from './request-id.js';
import type { ClientTransport } from './transport.js';

type ClientOperationId = JsonOperationId | 'workspace.backup-download';

/** Caller arguments retain schema defaults; handlers consume the parsed output type. */
type OperationArguments<K extends ClientOperationId> = z.input<
  (typeof OPERATION_DEFINITIONS)[K]['inputSchema']
>;

/** diagnostics.app is read through the tolerant client schema; every other result stays the server output. */
type OperationClientResult<K extends ClientOperationId> = K extends 'workspace.backup-download'
  ? ReadableStream<Uint8Array>
  : K extends 'diagnostics.app'
    ? z.output<typeof AppDiagnosticsClientResponseSchema>
    : K extends JsonOperationId
      ? OperationOutput<K>
      : never;

/** Typed operation methods derived solely from the shared definition table. */
export type OperationClient = {
  readonly [K in ClientOperationId]: (
    input: (typeof OPERATION_DEFINITIONS)[K]['mutating'] extends true
      ? OperationArguments<K> extends { requestId: string }
        ? Omit<OperationArguments<K>, 'requestId'> & { requestId?: string }
        : OperationArguments<K>
      : OperationArguments<K>
  ) => Promise<OperationClientResult<K>>;
};

/** Projects composed JSON operations and the operational backup stream through the shared transport. */
export function createOperationClient(transport: ClientTransport): OperationClient {
  return Object.fromEntries(
    Object.entries(OPERATION_DEFINITIONS)
      .filter(
        ([id, definition]) => definition.binding === 'json' || id === 'workspace.backup-download'
      )
      .map(([id, definition]) => [
        id,
        async (value: Record<string, unknown>) => {
          const parsed = definition.inputSchema.parse(
            definition.mutating && 'requestId' in definition.inputSchema.shape
              ? { ...value, requestId: value.requestId ?? createRequestId() }
              : value
          );
          const { requestId, ...body } = parsed as typeof parsed & { requestId?: string };
          if (id === 'workspace.backup-download')
            return transport.getStream(operationHttpPath(id), 'application/octet-stream', parsed);
          return transport.postJson(
            operationHttpPath(id),
            definition.mutating ? body : parsed,
            id === 'diagnostics.app' ? AppDiagnosticsClientResponseSchema : definition.outputSchema,
            definition.mutating && requestId ? { 'x-openkit-request-id': requestId } : undefined,
            'successStatus' in definition && definition.successStatus === 204
          );
        },
      ])
  ) as unknown as OperationClient;
}
