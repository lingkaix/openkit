import {
  CORE_COMMAND_OPERATION_DEFINITIONS,
  OPERATION_DEFINITIONS,
  WORKSPACE_LIFECYCLE_OPERATION_DEFINITIONS,
} from '@openkit/app-api-schemas';
import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import {
  apiErrorPayload,
  asApiError,
  asCommandError,
  asInvalidRequestError,
} from './api-errors.js';
import type { AuthVariables } from './auth/middleware.js';
import { AutomationOperationError } from './automation-operations.js';
import type { FsStore } from './lib/store.js';
import { registerAppApiRoute } from './openapi.js';
import {
  createOperationInvocation,
  type OperationInvocationDependencies,
  OperationInvocationError,
} from './operation-invocation.js';
import { GoalCommandError } from './runtime/goal-owner.js';
import { SchedulerAdmissionOperationError } from './runtime/scheduler-admission-operations.js';
import { WorkspaceDeletionOperationError } from './workspace-deletion-operations.js';
import { WorkspaceSharingOperationError } from './workspace-sharing-operations.js';

/** Projects every implemented JSON operation definition onto native invocation, with trusted actor and header identity. */
export function registerOperationJsonRoutes(
  dependencies: OperationInvocationDependencies & {
    app: Hono<{ Variables: AuthVariables }>;
    requestStore: (context: Context<{ Variables: AuthVariables }>) => FsStore;
  }
): void {
  const { app, requestStore } = dependencies;
  for (const [id, definition] of Object.entries(OPERATION_DEFINITIONS)) {
    registerAppApiRoute(app, id as keyof typeof OPERATION_DEFINITIONS, async (c) => {
      try {
        const body: unknown = await c.req.json().catch(() => null);
        if (typeof body !== 'object' || body === null || Array.isArray(body)) {
          throw new OperationInvocationError(
            'inputErrorCode' in definition ? definition.inputErrorCode : 'invalid_request',
            'Invalid operation input.',
            400
          );
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
        const input =
          definition.mutating && 'requestId' in definition.inputSchema.shape
            ? { ...args, requestId }
            : args;
        const parsed = definition.inputSchema.safeParse(input);
        if (!parsed.success)
          return asInvalidRequestError(
            parsed.error,
            'inputErrorCode' in definition ? definition.inputErrorCode : 'invalid_request'
          );
        let successStatus: 200 | 201 | 202 | 204 =
          'successStatus' in definition ? definition.successStatus : 200;
        const invoke = createOperationInvocation({
          ...dependencies,
          store: requestStore(c),
          observeSuccessStatus: (status) => {
            successStatus = status;
          },
        });
        const output = await invoke(id as keyof typeof OPERATION_DEFINITIONS, input, {
          kind: 'public',
          actor: c.get('actor'),
          signal: c.req.raw.signal,
        });
        return successStatus === 204 ? c.body(null, 204) : c.json(output, successStatus);
      } catch (error) {
        if (error instanceof HTTPException) return error.getResponse();
        if (
          error instanceof OperationInvocationError ||
          error instanceof WorkspaceSharingOperationError ||
          error instanceof WorkspaceDeletionOperationError
        ) {
          // These owners retain their former plain-text HTTP refusal projections.
          if (error.cause instanceof AutomationOperationError && error.status === 500)
            return c.text('Internal Server Error', 500);
          if (error.cause instanceof SchedulerAdmissionOperationError && error.status === 404)
            return c.text(error.message, 404);
          return Response.json(
            apiErrorPayload({
              code: error.code,
              message: error.message,
              ...('details' in error && error.details !== undefined
                ? { details: error.details }
                : {}),
            }),
            { status: error.status }
          );
        }
        if (error instanceof GoalCommandError)
          return asApiError(error.message, error.code, error.status);
        // Administration and lifecycle admission failures retain the HTTP framework's unexpected-error response.
        if (
          definition.scope.kind === 'server' ||
          Object.hasOwn(WORKSPACE_LIFECYCLE_OPERATION_DEFINITIONS, id)
        )
          throw error;
        // Export's native owner historically propagates unexpected failures to the app error handler.
        if (id === 'workspace.export') throw error;
        if (id.startsWith('generative-ui.')) throw error;
        if (id.startsWith('kernel.')) return asCommandError(error, 'invalid_request', 400);
        // Synchronization's native owners retain their handler fallbacks; unexpected admission failures reach the app error handler.
        if (id.startsWith('sync.')) throw error;
        // Temporary B1 admission debt: the generic fallback turns unexpected admission failures into Thread-shaped 404s; remove this branch in the shared family-contract change that replaces all per-family branches with one error projection.
        if (Object.hasOwn(CORE_COMMAND_OPERATION_DEFINITIONS, id)) throw error;
        return asCommandError(error, definition.mutating ? 'thread_create_failed' : 'not_found');
      }
    });
  }
}
