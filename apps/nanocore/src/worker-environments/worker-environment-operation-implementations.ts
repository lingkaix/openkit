import type {
  ActivateWorkerEnvironmentRequest,
  ActivateWorkerEnvironmentResponse,
  PrepareWorkerEnvironmentRequest,
  PrepareWorkerEnvironmentResponse,
  WORKER_ENVIRONMENT_OPERATION_DEFINITIONS,
} from '@openkit/app-api-schemas';
import type { Actor } from '../auth/identity.js';
import { DeploymentAdminRequiredError } from '../auth/operation-authorizer.js';
import { RuntimeConfigFileServiceError } from '../config/runtime-config-files.js';
import { type FamilyImplementations, publicOperationActor } from '../operation-contract.js';
import { OperationError } from '../operation-error.js';
import { IdempotencyKeyConflictError } from '../runtime/idempotent-command.js';
import { WorkerStorageBindingError } from '../runtime/worker-storage-bindings.js';
import {
  WorkerEnvironmentOperationError,
  type WorkerEnvironmentOperations,
} from './worker-environment-operations.js';

/** Joins public definitions to the same retained-storage, preparation and activation owners used by administration. */
export function createWorkerEnvironmentOperationImplementations(dependencies: {
  readonly operations: WorkerEnvironmentOperations | null;
  readonly prepare?: (
    context: { actor: Actor },
    request: PrepareWorkerEnvironmentRequest
  ) => Promise<PrepareWorkerEnvironmentResponse>;
  readonly activate?: (
    context: { actor: Actor },
    request: ActivateWorkerEnvironmentRequest
  ) => Promise<ActivateWorkerEnvironmentResponse>;
}) {
  /** Classifies only known owner refusals; unknown exceptions retain the shared error boundary. */
  async function run<T>(owner: (() => T | Promise<T>) | undefined): Promise<T> {
    if (!owner)
      throw new OperationError(
        'worker_environment_unavailable',
        'Worker environment operations are not configured.',
        503
      );
    try {
      return await owner();
    } catch (error) {
      if (error instanceof DeploymentAdminRequiredError)
        throw new OperationError(
          'deployment_admin_required',
          'Current deployment administrator authority is required.',
          403,
          { cause: error }
        );
      if (
        error instanceof RuntimeConfigFileServiceError ||
        error instanceof IdempotencyKeyConflictError
      )
        throw new OperationError(error.code, error.message, error.status, { cause: error });
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
        throw new OperationError(error.code, error.message, status, { cause: error });
      }
      if (error instanceof WorkerStorageBindingError)
        throw new OperationError(
          error.code,
          error.message,
          error.code === 'not_found' ? 404 : error.code === 'authorization_denied' ? 403 : 409,
          { cause: error }
        );
      throw error;
    }
  }
  return {
    'worker-environment.list': (input, context) => {
      const { workspaceId, ...request } = input;
      return run(
        dependencies.operations
          ? () =>
              dependencies.operations!.list(
                { actor: publicOperationActor(context), workspaceId },
                request
              )
          : undefined
      );
    },
    'worker-environment.select': (input, context) => {
      const { workspaceId, ...request } = input;
      return run(
        dependencies.operations
          ? () =>
              dependencies.operations!.select(
                { actor: publicOperationActor(context), workspaceId },
                request
              )
          : undefined
      );
    },
    'worker-environment.status': (input, context) =>
      run(
        dependencies.operations
          ? () =>
              dependencies.operations!.status(
                { actor: publicOperationActor(context), workspaceId: input.workspaceId },
                input
              )
          : undefined
      ),
    'worker-environment.purge': (input, context) => {
      const { workspaceId, ...request } = input;
      return run(
        dependencies.operations
          ? () =>
              dependencies.operations!.purge(
                { actor: publicOperationActor(context), workspaceId },
                request
              )
          : undefined
      );
    },
    // Fixed internal modes preserve the canonical command and retained receipt normalization.
    'worker-environment.prepare': (input, context) =>
      run(
        dependencies.prepare
          ? () =>
              dependencies.prepare!(
                { actor: publicOperationActor(context) },
                { ...input, replaceNow: input.replaceNow ?? null, mode: 'prepare' }
              )
          : undefined
      ),
    'worker-environment.recover': (input, context) =>
      run(
        dependencies.prepare
          ? () =>
              dependencies.prepare!(
                { actor: publicOperationActor(context) },
                { ...input, mode: 'recover' }
              )
          : undefined
      ),
    'worker-environment.activate': (input, context) =>
      run(
        dependencies.activate
          ? () => dependencies.activate!({ actor: publicOperationActor(context) }, input)
          : undefined
      ),
  } satisfies FamilyImplementations<typeof WORKER_ENVIRONMENT_OPERATION_DEFINITIONS>;
}
