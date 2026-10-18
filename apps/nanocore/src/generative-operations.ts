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
import { type FsStore, StoreRecordNotFoundError } from './lib/store.js';
import type { OperationInvocationDependencies } from './operation-composition.js';
import type {
  AdmittedOperationContext,
  OperationImplementations,
  OperationInvocationContext,
} from './operation-contract.js';
import { OperationError } from './operation-error.js';
import { IdempotencyKeyConflictError } from './runtime/idempotent-command.js';

type KernelId = keyof typeof KERNEL_REMAINING_OPERATION_DEFINITIONS;
type UiId = keyof typeof GENERATIVE_UI_OPERATION_DEFINITIONS;

/**
 * Preserves actual execution identity from trusted entry assembly, never presentation or input fields.
 *
 * @param store Existing Turn and Thread authority.
 * @param workspaceId Admitted mutation Workspace.
 * @param invocation Trusted Worker, Coordinator or internal Assistant entry.
 * @returns Verified execution context, or no execution identity for direct human calls.
 */
export function kernelExecutionLineage(
  store: FsStore,
  workspaceId: string,
  invocation: OperationInvocationContext
): Pick<KernelCommandContext, 'execution'> {
  const lineage =
    invocation.kind === 'worker'
      ? invocation.lineage
      : invocation.kind === 'coordinator'
        ? invocation
        : invocation.queryContext?.turnId
          ? {
              workspaceId,
              threadId: invocation.queryContext.threadId,
              turnId: invocation.queryContext.turnId,
            }
          : undefined;
  if (!lineage) return {};
  if (lineage.workspaceId !== workspaceId)
    throw new OperationError('workspace_access_denied', 'Workspace access denied.', 403);
  try {
    store.getThread(workspaceId, lineage.threadId);
    store.getTurn(workspaceId, lineage.threadId, lineage.turnId);
  } catch (error) {
    if (error instanceof StoreRecordNotFoundError)
      throw new OperationError('workspace_access_denied', 'Workspace access denied.', 403, {
        cause: error,
      });
    throw error;
  }
  return { execution: { threadId: lineage.threadId, turnId: lineage.turnId } };
}

/** Binds the existing Workspace availability proof and Kernel command identity after shared admission. */
function kernelContext(
  dependencies: Pick<
    OperationInvocationDependencies,
    'store' | 'repositoryWorkspaceDb' | 'inflightCommands' | 'coreDb'
  >,
  input: { workspaceId: string; requestId?: string },
  invocation: AdmittedOperationContext
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
    actor: invocation.actorRef,
    ...(input.requestId === undefined
      ? {}
      : kernelExecutionLineage(store, input.workspaceId, invocation)),
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
    invocation: AdmittedOperationContext,
    run: (context: KernelCommandContext) => T | Promise<T>
  ) => {
    try {
      return await run(kernelContext(dependencies, input, invocation));
    } catch (error) {
      return kernelOperationFailure(error);
    }
  };
  return {
    'kernel.apps.list': (input, context) => {
      return execute(input, context, (c) =>
        listLightApps(c.dataRoot, c.workspaceId, input.page, input.perPage)
      );
    },
    'kernel.apps.create': (input, context) => {
      return execute(input, context, (c) => {
        const { workspaceId: _workspaceId, requestId: _requestId, ...schema } = input;
        return createLightApp(c, schema);
      });
    },
    'kernel.schema.update': (input, context) => {
      return execute(input, context, (c) =>
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
      return execute(input, context, (c) =>
        retireLightApp(c, input.appId, input.expectedAppRevision)
      );
    },
    'kernel.records.list': (input, context) => {
      return execute(input, context, (c) =>
        listRecords(c.dataRoot, c.workspaceId, input.appId, input.collection, input)
      );
    },
    'kernel.records.get': (input, context) => {
      return execute(input, context, (c) =>
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
      return execute(input, context, (c) =>
        updateRecord(c, input.appId, input.collection, input.recordId, {
          schemaRevision: input.schemaRevision,
          expectedRecordRevision: input.expectedRecordRevision,
          data: input.data,
        })
      );
    },
    'kernel.records.batch': (input, context) => {
      return execute(input, context, (c) =>
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
    const execution =
      input.requestId === undefined
        ? {}
        : kernelExecutionLineage(store, input.workspaceId, invocation);
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
      ...execution,
      inflightCommands: dependencies.inflightCommands!,
      workspaceDb: db,
      administratorEligible:
        invocation.kind !== 'worker' &&
        invocation.kind !== 'bootstrap' &&
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
