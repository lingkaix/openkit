import { PRODUCT_OPERATION_DEFINITIONS } from '@openkit/app-api-schemas';
import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { asApiError, asCommandError, asInvalidRequestError } from './api-errors.js';
import type { AuthVariables } from './auth/middleware.js';
import { asKernelApiError } from './kernel-routes.js';
import type { FsStore } from './lib/store.js';
import { registerAppApiRoute } from './openapi.js';
import {
  createOperationInvocation,
  type OperationInvocationDependencies,
  OperationInvocationError,
} from './operation-invocation.js';

/** Projects every implemented JSON product definition onto native invocation, with trusted actor and header identity. */
export function registerOperationJsonRoutes(
  dependencies: OperationInvocationDependencies & {
    app: Hono<{ Variables: AuthVariables }>;
    requestStore: (context: Context<{ Variables: AuthVariables }>) => FsStore;
  }
): void {
  const { app, requestStore } = dependencies;
  for (const [id, definition] of Object.entries(PRODUCT_OPERATION_DEFINITIONS)) {
    registerAppApiRoute(app, id as keyof typeof PRODUCT_OPERATION_DEFINITIONS, async (c) => {
      try {
        const body: unknown = await c.req.json().catch(() => null);
        if (typeof body !== 'object' || body === null || Array.isArray(body)) {
          throw new OperationInvocationError('invalid_request', 'Invalid operation input.', 400);
        }
        const args = body as Record<string, unknown>;
        const requestId = c.req.header('x-openkit-request-id');
        if (
          definition.mutating &&
          Object.hasOwn(args, 'requestId') &&
          args.requestId !== requestId
        ) {
          throw new OperationInvocationError(
            'bound_input_conflict',
            'Request identity conflicts with its header.',
            403
          );
        }
        const input = definition.mutating ? { ...args, requestId } : args;
        const parsed = definition.inputSchema.safeParse(input);
        if (!parsed.success) return asInvalidRequestError(parsed.error);
        const invoke = createOperationInvocation({ ...dependencies, store: requestStore(c) });
        return c.json(
          await invoke(id as keyof typeof PRODUCT_OPERATION_DEFINITIONS, input, {
            kind: 'public',
            actor: c.get('actor'),
          })
        );
      } catch (error) {
        if (error instanceof HTTPException) return error.getResponse();
        if (error instanceof OperationInvocationError)
          return asApiError(error.message, error.code, error.status);
        if (id.startsWith('kernel.')) return asKernelApiError(error);
        return asCommandError(error, definition.mutating ? 'thread_create_failed' : 'not_found');
      }
    });
  }
}
