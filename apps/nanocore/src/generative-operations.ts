import type {
  GENERATIVE_UI_OPERATION_DEFINITIONS,
  KERNEL_REMAINING_OPERATION_DEFINITIONS,
} from '@openkit/app-api-schemas';
import type { ActorRef } from '@openkit/protocol';
import { isCurrentDeploymentAdministrator } from './auth/operation-authorizer.js';
import {
  batchRecords,
  createLightApp,
  getRecord,
  type KernelCommandContext,
  listLightApps,
  listRecords,
  retireLightApp,
  updateLightAppSchema,
  updateRecord,
} from './generative-kernel/commands.js';
import { KernelCommandError } from './generative-kernel/errors.js';
import {
  getGenerativePresentation,
  getGenerativePresentationResource,
  publishGenerativePresentation,
  refreshGenerativePresentation,
  submitGenerativePresentationAction,
} from './generative-ui/commands.js';
import { StoreRecordNotFoundError } from './lib/store.js';
import type { OperationInvocationDependencies } from './operation-composition.js';
import type { OperationImplementations, OperationInvocationContext } from './operation-contract.js';
import { OperationError } from './operation-error.js';
import { IdempotencyKeyConflictError } from './runtime/idempotent-command.js';

type KernelId = keyof typeof KERNEL_REMAINING_OPERATION_DEFINITIONS;
type UiId = keyof typeof GENERATIVE_UI_OPERATION_DEFINITIONS;

/** Binds the existing Workspace availability proof and Kernel command identity after shared admission. */
function kernelContext(
  dependencies: Pick<
    OperationInvocationDependencies,
    'store' | 'repositoryWorkspaceDb' | 'inflightCommands' | 'coreDb'
  >,
  input: { workspaceId: string; requestId?: string },
  actor: ActorRef
): KernelCommandContext {
  const store = dependencies.store!;
  try {
    store.getWorkspace(input.workspaceId);
  } catch (error) {
    if (error instanceof StoreRecordNotFoundError)
      throw new OperationError('invalid_request', error.message, 400, { cause: error });
    throw error;
  }
  const db = dependencies.repositoryWorkspaceDb!(input.workspaceId);
  db.sqlite.close();
  const dataRoot = store.getDataRoot();
  if (!dataRoot) throw new KernelCommandError('unavailable', 'Workspace storage is unavailable.');
  return {
    store,
    dataRoot,
    workspaceId: input.workspaceId,
    requestId: input.requestId ?? '',
    actor,
    inflightCommands: dependencies.inflightCommands!,
  };
}

/** Kernel-local translation preserves known metadata while every unclassified exception escapes. */
export function kernelOperationFailure(error: unknown): never {
  if (error instanceof KernelCommandError)
    throw new OperationError(error.code, error.message, error.status, {
      cause: error,
      ...(error.path === undefined ? {} : { path: [error.path] }),
      ...(error.limit !== undefined || error.maximum !== undefined
        ? {
            details: {
              ...(error.limit === undefined ? {} : { limit: error.limit }),
              ...(error.maximum === undefined ? {} : { maximum: error.maximum }),
            },
          }
        : {}),
    });
  if (error instanceof IdempotencyKeyConflictError)
    throw new OperationError(error.code, error.message, error.status, { cause: error });
  throw error;
}

/** Exact remaining Kernel join; local app receipts, revision checks and transactions stay with the native commands. */
export function createRemainingKernelOperationImplementations(
  dependencies: Pick<
    OperationInvocationDependencies,
    'store' | 'repositoryWorkspaceDb' | 'inflightCommands' | 'coreDb'
  >
) {
  const execute = async <T>(
    input: { workspaceId: string; requestId?: string },
    actor: ActorRef,
    run: (context: KernelCommandContext) => T | Promise<T>
  ) => {
    try {
      return await run(kernelContext(dependencies, input, actor));
    } catch (error) {
      return kernelOperationFailure(error);
    }
  };
  return {
    'kernel.apps.list': (input, context) => {
      const actor = context.actorRef;
      return execute(input, actor, (c) =>
        listLightApps(c.dataRoot, c.workspaceId, input.page, input.perPage)
      );
    },
    'kernel.apps.create': (input, context) => {
      const actor = context.actorRef;
      return execute(input, actor, (c) => {
        const { workspaceId: _workspaceId, requestId: _requestId, ...schema } = input;
        return createLightApp(c, schema);
      });
    },
    'kernel.schema.update': (input, context) => {
      const actor = context.actorRef;
      return execute(input, actor, (c) =>
        updateLightAppSchema(
          c,
          input.appId,
          input.expectedAppRevision,
          input.expectedSchemaRevision,
          input.schema
        )
      );
    },
    'kernel.apps.retire': (input, context) => {
      const actor = context.actorRef;
      return execute(input, actor, (c) =>
        retireLightApp(c, input.appId, input.expectedAppRevision)
      );
    },
    'kernel.records.list': (input, context) => {
      const actor = context.actorRef;
      return execute(input, actor, (c) =>
        listRecords(c.dataRoot, c.workspaceId, input.appId, input.collection, input)
      );
    },
    'kernel.records.get': (input, context) => {
      const actor = context.actorRef;
      return execute(input, actor, (c) =>
        getRecord(
          c.dataRoot,
          c.workspaceId,
          input.appId,
          input.collection,
          input.recordId,
          input.schemaRevision,
          input.fields
        )
      );
    },
    'kernel.records.update': (input, context) => {
      const actor = context.actorRef;
      return execute(input, actor, (c) =>
        updateRecord(c, input.appId, input.collection, input.recordId, {
          schemaRevision: input.schemaRevision,
          expectedRecordRevision: input.expectedRecordRevision,
          data: input.data,
        })
      );
    },
    'kernel.records.batch': (input, context) => {
      const actor = context.actorRef;
      return execute(input, actor, (c) =>
        batchRecords(c, input.appId, {
          schemaRevision: input.schemaRevision,
          requests: input.requests,
        })
      );
    },
  } satisfies Pick<OperationImplementations, KernelId>;
}

/** Exact Generative UI join, retaining database lifetime, source audience and native action admission. */
export function createGenerativeUiOperationImplementations(
  dependencies: Pick<
    OperationInvocationDependencies,
    'store' | 'repositoryWorkspaceDb' | 'inflightCommands' | 'coreDb'
  >
) {
  const execute = async <T>(
    input: { workspaceId: string; requestId?: string },
    actor: ActorRef,
    invocation: OperationInvocationContext,
    run: (
      context: import('./generative-ui/commands.js').GenerativeUiCommandContext
    ) => T | Promise<T>
  ) => {
    const store = dependencies.store!;
    try {
      store.getWorkspace(input.workspaceId);
    } catch (error) {
      if (error instanceof StoreRecordNotFoundError)
        throw new OperationError('internal_error', 'Internal Server Error', 500, { cause: error });
      throw error;
    }
    const db = dependencies.repositoryWorkspaceDb!(input.workspaceId);
    const dataRoot = store.getDataRoot();
    if (!dataRoot) {
      db.sqlite.close();
      throw new OperationError('unavailable', 'Workspace storage is unavailable.', 503);
    }
    const context = {
      store,
      dataRoot,
      workspaceId: input.workspaceId,
      requestId: input.requestId ?? '',
      actor,
      inflightCommands: dependencies.inflightCommands!,
      workspaceDb: db,
      administratorEligible:
        invocation.kind !== 'worker' &&
        isCurrentDeploymentAdministrator(dependencies.coreDb!, invocation.actor),
    };
    try {
      return await run(context);
    } catch (error) {
      return kernelOperationFailure(error);
    } finally {
      db.sqlite.close();
    }
  };
  return {
    'generative-ui.publish': (input, context) => {
      const actor = context.actorRef;
      return execute(input, actor, context, (c) => {
        const { workspaceId: _workspaceId, requestId: _requestId, ...body } = input;
        return publishGenerativePresentation(c, body);
      });
    },
    'generative-ui.get': (input, context) => {
      const actor = context.actorRef;
      return execute(input, actor, context, (c) =>
        getGenerativePresentation(c, input.presentationId)
      );
    },
    'generative-ui.resource': (input, context) => {
      const actor = context.actorRef;
      return execute(input, actor, context, (c) =>
        getGenerativePresentationResource(c, input.presentationId)
      );
    },
    'generative-ui.refresh': (input, context) => {
      const actor = context.actorRef;
      return execute(input, actor, context, (c) =>
        refreshGenerativePresentation(c, input.presentationId, {
          version: input.version,
          action: input.action,
        })
      );
    },
    'generative-ui.action': (input, context) => {
      const actor = context.actorRef;
      return execute(input, actor, context, (c) =>
        submitGenerativePresentationAction(c, input.presentationId, {
          version: input.version,
          action: input.action,
        })
      );
    },
  } satisfies Pick<OperationImplementations, UiId>;
}
