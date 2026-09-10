import {
  type ActivateWorkerEnvironmentRequest,
  ActivateWorkerEnvironmentRequestSchema,
  type ActivateWorkerEnvironmentResponse,
  ListWorkerEnvironmentsQuerySchema,
  type PrepareWorkerEnvironmentRequest,
  PrepareWorkerEnvironmentRequestSchema,
  type PrepareWorkerEnvironmentResponse,
  PurgeWorkerEnvironmentRequestSchema,
  SelectWorkerEnvironmentRequestSchema,
  WorkerEnvironmentStorageRefSchema,
} from '@openkit/app-api-schemas';
import type { Hono } from 'hono';

import { asApiError, asInvalidRequestError } from '../api-errors.js';
import type { Actor } from '../auth/identity.js';
import type { AuthVariables } from '../auth/middleware.js';
import { DeploymentAdminRequiredError } from '../auth/operation-authorizer.js';
import { RuntimeConfigFileServiceError } from '../config/runtime-config-files.js';
import { registerAppApiRoute } from '../openapi.js';
import { IdempotencyKeyConflictError } from '../runtime/idempotent-command.js';
import { WorkerStorageBindingError } from '../runtime/worker-storage-bindings.js';
import {
  WorkerEnvironmentOperationError,
  type WorkerEnvironmentOperations,
} from './worker-environment-operations.js';

/** Registers the public, authorization-guarded Worker environment operations. */
export function registerWorkerEnvironmentRoutes(input: {
  readonly app: Hono<{ Variables: AuthVariables }>;
  readonly operations: WorkerEnvironmentOperations | null;
  readonly prepare?: (
    context: { actor: Actor },
    request: PrepareWorkerEnvironmentRequest
  ) => Promise<PrepareWorkerEnvironmentResponse>;
  readonly activate?: (
    context: { actor: Actor },
    request: ActivateWorkerEnvironmentRequest
  ) => Promise<ActivateWorkerEnvironmentResponse>;
}): void {
  registerAppApiRoute(input.app, 'listWorkerEnvironments', (context) => {
    const parsed = ListWorkerEnvironmentsQuerySchema.safeParse(context.req.query());
    if (!parsed.success) return asInvalidRequestError(parsed.error);
    const actor = context.get('actor');
    if (!actor) return asApiError('Workspace access denied.', 'workspace_access_denied', 403);
    if (!input.operations) return workerEnvironmentUnavailable();
    try {
      return context.json(
        input.operations.list({ actor, workspaceId: context.req.param('workspaceId') }, parsed.data)
      );
    } catch (error) {
      return asWorkerEnvironmentError(error);
    }
  });

  registerAppApiRoute(input.app, 'selectWorkerEnvironment', async (context) => {
    const parsed = SelectWorkerEnvironmentRequestSchema.safeParse(
      await context.req.json().catch(() => ({}))
    );
    if (!parsed.success) return asInvalidRequestError(parsed.error);
    const actor = context.get('actor');
    if (!actor) return asApiError('Workspace access denied.', 'workspace_access_denied', 403);
    if (!input.operations) return workerEnvironmentUnavailable();
    try {
      return context.json(
        input.operations.select(
          { actor, workspaceId: context.req.param('workspaceId') },
          parsed.data
        )
      );
    } catch (error) {
      return asWorkerEnvironmentError(error);
    }
  });

  registerAppApiRoute(input.app, 'getWorkerEnvironmentStatus', async (context) => {
    const storageRef = WorkerEnvironmentStorageRefSchema.safeParse(context.req.param('storageRef'));
    if (!storageRef.success) return asInvalidRequestError(storageRef.error);
    const actor = context.get('actor');
    if (!actor) return asApiError('Workspace access denied.', 'workspace_access_denied', 403);
    if (!input.operations) return workerEnvironmentUnavailable();
    try {
      return context.json(
        await input.operations.status(
          { actor, workspaceId: context.req.param('workspaceId') },
          { storageRef: storageRef.data }
        )
      );
    } catch (error) {
      return asWorkerEnvironmentError(error);
    }
  });

  registerAppApiRoute(input.app, 'purgeWorkerEnvironment', async (context) => {
    const parsed = PurgeWorkerEnvironmentRequestSchema.safeParse(
      await context.req.json().catch(() => ({}))
    );
    if (!parsed.success) return asInvalidRequestError(parsed.error);
    if (parsed.data.storageRef !== context.req.param('storageRef')) {
      return asApiError(
        'Worker environment purge path and body references must match.',
        'invalid_request',
        400
      );
    }
    const actor = context.get('actor');
    if (!actor) return asApiError('Workspace access denied.', 'workspace_access_denied', 403);
    if (!input.operations) return workerEnvironmentUnavailable();
    try {
      return context.json(
        await input.operations.purge(
          { actor, workspaceId: context.req.param('workspaceId') },
          parsed.data
        )
      );
    } catch (error) {
      return asWorkerEnvironmentError(error);
    }
  });

  registerAppApiRoute(input.app, 'prepareWorkerEnvironment', async (context) => {
    if (!input.prepare) return workerEnvironmentUnavailable();
    const parsed = PrepareWorkerEnvironmentRequestSchema.safeParse(
      await context.req.json().catch(() => ({}))
    );
    if (!parsed.success) return asInvalidRequestError(parsed.error);
    try {
      return context.json(await input.prepare({ actor: context.get('actor') }, parsed.data));
    } catch (error) {
      return asWorkerEnvironmentError(error);
    }
  });
  registerAppApiRoute(input.app, 'activateWorkerEnvironment', async (context) => {
    if (!input.activate) return workerEnvironmentUnavailable();
    const parsed = ActivateWorkerEnvironmentRequestSchema.safeParse(
      await context.req.json().catch(() => ({}))
    );
    if (!parsed.success) return asInvalidRequestError(parsed.error);
    try {
      return context.json(await input.activate({ actor: context.get('actor') }, parsed.data));
    } catch (error) {
      return asWorkerEnvironmentError(error);
    }
  });
}

/** Returns the closed response used when Core and host operation owners are not composed. */
function workerEnvironmentUnavailable(): Response {
  return asApiError(
    'Worker environment operations are not configured.',
    'worker_environment_unavailable',
    503
  );
}

/** Maps bounded operation failures without disclosing private lineage. */
function asWorkerEnvironmentError(error: unknown): Response {
  if (error instanceof DeploymentAdminRequiredError) {
    return asApiError(
      'Current deployment administrator authority is required.',
      'deployment_admin_required',
      403
    );
  }
  if (error instanceof RuntimeConfigFileServiceError)
    return asApiError(error.message, error.code, error.status);
  if (error instanceof IdempotencyKeyConflictError) {
    return asApiError(error.message, error.code, error.status);
  }
  if (error instanceof WorkerEnvironmentOperationError) {
    const status =
      error.code === 'workspace_access_denied'
        ? 403
        : error.code === 'invalid_request'
          ? 400
          : error.code === 'unavailable'
            ? 503
            : error.code === 'not_found'
              ? 404
              : 409;
    return asApiError(error.message, error.code, status);
  }
  if (error instanceof WorkerStorageBindingError) {
    const status =
      error.code === 'not_found' ? 404 : error.code === 'authorization_denied' ? 403 : 409;
    return asApiError(error.message, error.code, status);
  }
  return asApiError('Worker environment operation failed.', 'worker_environment_failed', 500);
}
