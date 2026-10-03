import type {
  GENERATIVE_UI_OPERATION_DEFINITIONS,
  KERNEL_REMAINING_OPERATION_DEFINITIONS,
} from '@openkit/app-api-schemas';
import type { ActorRef } from '@openkit/protocol';
import { publishedErrorMessage } from './api-errors.js';
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
import type {
  OperationImplementations,
  OperationInvocationContext,
  OperationInvocationDependencies,
} from './operation-invocation.js';
import { IdempotencyKeyConflictError } from './runtime/idempotent-command.js';

type KernelId = keyof typeof KERNEL_REMAINING_OPERATION_DEFINITIONS;
type UiId = keyof typeof GENERATIVE_UI_OPERATION_DEFINITIONS;

/** Old route fallback, kept separate from typed native command refusals. */
export class GenerativeOperationError extends Error {
  public readonly code = 'invalid_request';
  public readonly status = 400;
}

/** Binds the existing Workspace availability proof and Kernel command identity after shared admission. */
function kernelContext(
  dependencies: OperationInvocationDependencies,
  input: { workspaceId: string; requestId?: string },
  actor: ActorRef
): KernelCommandContext {
  const store = dependencies.store!;
  store.getWorkspace(input.workspaceId);
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

/** Preserves these old handlers' invalid-request fallback without rewriting typed owner failures. */
function ownerFailure(error: unknown): never {
  if (error instanceof KernelCommandError || error instanceof IdempotencyKeyConflictError)
    throw error;
  throw new GenerativeOperationError(publishedErrorMessage(error));
}

/** Exact remaining Kernel join; local app receipts, revision checks and transactions stay with the native commands. */
export function createRemainingKernelOperationImplementations(
  dependencies: OperationInvocationDependencies
): Pick<OperationImplementations, KernelId> {
  const execute = async <T>(
    input: { workspaceId: string; requestId?: string },
    actor: ActorRef,
    run: (context: KernelCommandContext) => T | Promise<T>
  ) => {
    try {
      return await run(kernelContext(dependencies, input, actor));
    } catch (error) {
      return ownerFailure(error);
    }
  };
  return {
    'kernel.apps.list': (input, actor) =>
      execute(input, actor, (c) =>
        listLightApps(c.dataRoot, c.workspaceId, input.page, input.perPage)
      ),
    'kernel.apps.create': (input, actor) =>
      execute(input, actor, (c) => {
        const { workspaceId: _workspaceId, requestId: _requestId, ...schema } = input;
        return createLightApp(c, schema);
      }),
    'kernel.schema.update': (input, actor) =>
      execute(input, actor, (c) =>
        updateLightAppSchema(
          c,
          input.appId,
          input.expectedAppRevision,
          input.expectedSchemaRevision,
          input.schema
        )
      ),
    'kernel.apps.retire': (input, actor) =>
      execute(input, actor, (c) => retireLightApp(c, input.appId, input.expectedAppRevision)),
    'kernel.records.list': (input, actor) =>
      execute(input, actor, (c) =>
        listRecords(c.dataRoot, c.workspaceId, input.appId, input.collection, input)
      ),
    'kernel.records.get': (input, actor) =>
      execute(input, actor, (c) =>
        getRecord(
          c.dataRoot,
          c.workspaceId,
          input.appId,
          input.collection,
          input.recordId,
          input.schemaRevision,
          input.fields
        )
      ),
    'kernel.records.update': (input, actor) =>
      execute(input, actor, (c) =>
        updateRecord(c, input.appId, input.collection, input.recordId, {
          schemaRevision: input.schemaRevision,
          expectedRecordRevision: input.expectedRecordRevision,
          data: input.data,
        })
      ),
    'kernel.records.batch': (input, actor) =>
      execute(input, actor, (c) =>
        batchRecords(c, input.appId, {
          schemaRevision: input.schemaRevision,
          requests: input.requests,
        })
      ),
  };
}

/** Exact Generative UI join, retaining database lifetime, source audience and native action admission. */
export function createGenerativeUiOperationImplementations(
  dependencies: OperationInvocationDependencies
): Pick<OperationImplementations, UiId> {
  const execute = async <T>(
    input: { workspaceId: string; requestId?: string },
    actor: ActorRef,
    invocation: OperationInvocationContext,
    run: (
      context: import('./generative-ui/commands.js').GenerativeUiCommandContext
    ) => T | Promise<T>
  ) => {
    const store = dependencies.store!;
    store.getWorkspace(input.workspaceId);
    const db = dependencies.repositoryWorkspaceDb!(input.workspaceId);
    const dataRoot = store.getDataRoot();
    if (!dataRoot) {
      db.sqlite.close();
      throw new KernelCommandError('unavailable', 'Workspace storage is unavailable.');
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
      return ownerFailure(error);
    } finally {
      db.sqlite.close();
    }
  };
  return {
    'generative-ui.publish': (input, actor, context) =>
      execute(input, actor, context, (c) => {
        const { workspaceId: _workspaceId, requestId: _requestId, ...body } = input;
        return publishGenerativePresentation(c, body);
      }),
    'generative-ui.get': (input, actor, context) =>
      execute(input, actor, context, (c) => getGenerativePresentation(c, input.presentationId)),
    'generative-ui.resource': (input, actor, context) =>
      execute(input, actor, context, (c) =>
        getGenerativePresentationResource(c, input.presentationId)
      ),
    'generative-ui.refresh': (input, actor, context) =>
      execute(input, actor, context, (c) =>
        refreshGenerativePresentation(c, input.presentationId, {
          version: input.version,
          action: input.action,
        })
      ),
    'generative-ui.action': (input, actor, context) =>
      execute(input, actor, context, (c) =>
        submitGenerativePresentationAction(c, input.presentationId, {
          version: input.version,
          action: input.action,
        })
      ),
  };
}
