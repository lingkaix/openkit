import { OPERATION_DEFINITIONS, type OperationDefinition } from '@openkit/app-api-schemas';
import type { Context, Hono } from 'hono';
import { apiErrorPayload } from './api-errors.js';
import type { AuthVariables } from './auth/middleware.js';
import type { FsStore } from './lib/store.js';
import { registerAppApiRoute } from './openapi.js';
import {
  createOperationInvocation,
  type OperationInvocationDependencies,
} from './operation-composition.js';
import { OperationError, projectOperationError } from './operation-error.js';
import { parseOperationInput } from './operation-resolvers.js';

/** JSON framing assembles trusted headers and per-request facts; native invocation owns complete parsing and admission. */
export function registerOperationJsonRoutes(
  dependencies: OperationInvocationDependencies & {
    app: Hono<{ Variables: AuthVariables }>;
    requestStore: (context: Context<{ Variables: AuthVariables }>) => FsStore;
  }
): void {
  const { app, requestStore } = dependencies;
  for (const [id, declared] of Object.entries(OPERATION_DEFINITIONS)) {
    const definition: OperationDefinition = declared;
    if (definition.binding !== 'json') continue;
    registerAppApiRoute(app, id as keyof typeof OPERATION_DEFINITIONS, async (c) => {
      // Initialize response headers so returned Responses and the HTTP error handler inherit the same cache policy.
      c.res.headers.set('Cache-Control', 'no-store');
      try {
        const body: unknown = await c.req.json().catch((error: unknown) => {
          if (error instanceof SyntaxError) return null;
          throw error;
        });
        if (typeof body !== 'object' || body === null || Array.isArray(body))
          throw new OperationError(
            definition.invalidInputCode ?? 'invalid_request',
            'Invalid operation input.',
            400
          );
        const args = body as Record<string, unknown>;
        const requestId = c.req.header('x-openkit-request-id');
        if (definition.mutating && Object.hasOwn(args, 'requestId') && args.requestId !== requestId)
          throw new OperationError(
            'bound_input_conflict',
            'Request identity conflicts with its header.',
            403
          );
        const input =
          definition.mutating && 'requestId' in definition.inputSchema.shape
            ? { ...args, requestId }
            : args;
        // HTTP must refuse malformed input before selecting a request store; native entries independently use the same validator.
        parseOperationInput(definition, input, { kind: 'public', actor: c.get('actor') });
        let successStatus: 200 | 201 | 202 | 204 = definition.successStatus;
        const invoke = createOperationInvocation({ ...dependencies, store: requestStore(c) });
        const output = await invoke(id as keyof typeof OPERATION_DEFINITIONS, input, {
          kind: 'public',
          actor: c.get('actor'),
          delivery: 'human',
          signal: c.req.raw.signal,
          observeSuccessStatus: (status) => {
            successStatus = status;
          },
        });
        return successStatus === 204 ? c.body(null, 204) : c.json(output, successStatus);
      } catch (error) {
        const projected = projectOperationError(error);
        if (!projected) throw error;
        const { status, ...body } = projected;
        return Response.json(apiErrorPayload(body), { status });
      }
    });
  }
}
