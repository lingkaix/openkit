import { existsSync } from 'node:fs';
import type {
  GetLightAppResponse,
  LIGHT_APP_DEFINITION_OPERATION_DEFINITIONS,
} from '@openkit/app-api-schemas';
import { recordWorkspaceAuditEvent } from './audit-events.js';
import { isWorkspaceOperationAuthorized } from './auth/operation-authorizer.js';
import { catalogFailure } from './catalog/catalog-operations.js';
import {
  exportWorkspaceLightAppDefinition,
  importWorkspaceLightAppDefinition,
  importWorkspaceLightAppDefinitionHistory,
  listWorkspaceLightAppDefinitions,
  readWorkspaceLightAppDefinition,
  resolveWorkspaceLightAppDefinition,
  selectWorkspaceLightAppDefinitionDefault,
  setWorkspaceLightAppDefinitionPin,
} from './catalog/light-app-catalog.js';
import {
  CatalogConflictError,
  CatalogForbiddenError,
  CatalogIntegrityError,
  loadWorkspaceResourceCatalog,
} from './catalog/resource-catalog.js';
import {
  createLightApp,
  getLightApp,
  type KernelCommandContext,
  listLightAppSnapshots,
  rollbackLightAppSnapshot,
  updateLightAppSchema,
  upgradeLightAppFormat,
} from './generative-kernel/commands.js';
import { KernelCommandError } from './generative-kernel/errors.js';
import { allocateAppId } from './generative-kernel/uuid.js';
import { kernelExecutionLineage, kernelOperationFailure } from './generative-operations.js';
import type { CommandRequestResponseKind } from './lib/store.js';
import type { OperationInvocationDependencies } from './operation-composition.js';
import {
  type AdmittedOperationContext,
  type FamilyImplementations,
  publicOperationActor,
} from './operation-contract.js';
import { OperationError } from './operation-error.js';
import {
  commandInputHash,
  IdempotencyKeyConflictError,
  runIdempotentCommand,
} from './runtime/idempotent-command.js';
import { lightAppDbPath, openExistingAppDb } from './storage/app-db.js';

type MutationId =
  | 'catalog.light-app-import'
  | 'catalog.light-app-history-import'
  | 'catalog.light-app-select'
  | 'catalog.light-app-pin';
type CatalogCommand = { workspaceId: string; requestId: string; expectedRevision: number };

/** Joins declarative templates and explicit data activation to their existing catalog and Kernel owners. */
export function createLightAppDefinitionOperationImplementations(
  dependencies: OperationInvocationDependencies
) {
  const dataRoot = () => {
    const root = dependencies.dataRoot ?? dependencies.store?.getDataRoot();
    if (!root)
      throw new OperationError(
        'operation_storage_unavailable',
        'Light App storage is unavailable.',
        503
      );
    return root;
  };
  const scope = (workspaceId: string) => ({ dataRoot: dataRoot(), workspaceId });
  const kernel = (
    input: { workspaceId: string; requestId?: string },
    context: AdmittedOperationContext
  ): KernelCommandContext => {
    if (!dependencies.store || !dependencies.inflightCommands)
      throw new OperationError(
        'operation_storage_unavailable',
        'Light App command storage is unavailable.',
        503
      );
    dependencies.store.getWorkspace(input.workspaceId);
    return {
      ...scope(input.workspaceId),
      store: dependencies.store,
      inflightCommands: dependencies.inflightCommands,
      actor: context.actorRef,
      ...kernelExecutionLineage(dependencies.store, input.workspaceId, context),
      requestId: input.requestId ?? '',
    };
  };
  /** Keeps public failure classification with the existing two domain owners. */
  const execute = async <T>(work: () => T | Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      if (error instanceof KernelCommandError) return kernelOperationFailure(error);
      return catalogFailure(error, 'light_app_definition_failed');
    }
  };
  /** Reads the existing native receipt before consulting mutable catalog selections. */
  const replayDefinition = (
    context: KernelCommandContext,
    appId: string,
    command: 'kernel.apps.create' | 'kernel.schema.update',
    input: object
  ): GetLightAppResponse | null => {
    if (!existsSync(lightAppDbPath(context.dataRoot, context.workspaceId, appId))) return null;
    const appDb = openExistingAppDb(context.dataRoot, context.workspaceId, appId, 'format-upgrade');
    try {
      const receipt = context.store.getCommandRequest(
        command,
        context.requestId,
        { workspaceId: context.workspaceId, appId, actorId: context.actor.id },
        appDb
      );
      if (!receipt) return null;
      if (receipt.inputHash !== commandInputHash({ actor: context.actor, ...input }))
        throw new IdempotencyKeyConflictError();
      if (receipt.response.kind !== 'light_app' || receipt.response.id !== appId)
        throw new KernelCommandError(
          'recovery_required',
          'Definition command receipt does not identify this app.'
        );
    } finally {
      appDb.sqlite.close();
    }
    return getLightApp(context.dataRoot, context.workspaceId, appId);
  };
  /** Existing completed receipts point to catalog resources; publication adds no separate ledger. */
  const mutate = async <T>(
    operation: MutationId,
    input: CatalogCommand,
    context: AdmittedOperationContext,
    options: {
      kind: Extract<CommandRequestResponseKind, 'light_app_definition' | 'light_app_catalog'>;
      responseId: (result: T) => string;
      work: () => T;
      replay: (id: string) => T;
    }
  ): Promise<T> => {
    const { store, inflightCommands, coreDb, repositoryWorkspaceDb } = dependencies;
    if (!store || !inflightCommands || !coreDb || !repositoryWorkspaceDb)
      throw new OperationError(
        'operation_storage_unavailable',
        'Definition command storage is unavailable.',
        503
      );
    const authorize = () => {
      if (
        context.kind !== 'worker' &&
        !isWorkspaceOperationAuthorized(coreDb, publicOperationActor(context), input.workspaceId, {
          mutating: true,
          policyOperation: 'workspace.configure',
        })
      )
        throw new CatalogForbiddenError('Current definition command authority is unavailable.');
    };
    const workspaceDb = repositoryWorkspaceDb(input.workspaceId);
    let published = false;
    try {
      return await runIdempotentCommand({
        store,
        inflightCommands,
        workspaceDb,
        command: operation,
        requestId: input.requestId,
        scope: { workspaceId: input.workspaceId, actorId: context.actorRef.id },
        input,
        responseKind: options.kind,
        responseId: options.responseId,
        replay: (receipt) => {
          authorize();
          if (receipt.response.kind !== options.kind)
            throw new CatalogIntegrityError('Definition receipt has an invalid resource kind.');
          return options.replay(receipt.response.id);
        },
        execute: () => {
          authorize();
          if (
            loadWorkspaceResourceCatalog(dataRoot(), input.workspaceId).revision !==
            input.expectedRevision
          )
            throw new CatalogConflictError();
          const result = options.work();
          published = true;
          recordWorkspaceAuditEvent({
            workspaceDb,
            workspaceId: input.workspaceId,
            requestId: input.requestId,
            actor: context.actorRef,
            action: operation,
            resource: `light-app-definition:${options.responseId(result)}`,
            outcome: 'succeeded',
            summary: 'Updated a reusable Light App definition without changing live app data.',
          });
          return result;
        },
      });
    } catch (error) {
      if (published)
        throw new CatalogIntegrityError(
          'Definition publication completed but its command outcome is unavailable. Inspect the catalog before a new request.'
        );
      throw error;
    } finally {
      workspaceDb.sqlite.close();
    }
  };
  return {
    'catalog.light-app-list': (input) =>
      execute(() => listWorkspaceLightAppDefinitions(scope(input.workspaceId))),
    'catalog.light-app-read': (input) =>
      execute(() =>
        readWorkspaceLightAppDefinition({ ...scope(input.workspaceId), entryId: input.entryId })
      ),
    'catalog.light-app-export': (input) =>
      execute(() =>
        exportWorkspaceLightAppDefinition({ ...scope(input.workspaceId), entryId: input.entryId })
      ),
    'catalog.light-app-import': (input, context) =>
      execute(() =>
        mutate('catalog.light-app-import', input, context, {
          kind: 'light_app_definition',
          responseId: (result) => result.version.digest,
          work: () => {
            const producer = context.actorRef;
            if (producer.kind !== 'user' && producer.kind !== 'agent' && producer.kind !== 'system')
              throw new CatalogForbiddenError('Definition producer kind is unavailable.');
            const result = importWorkspaceLightAppDefinition({
              ...scope(input.workspaceId),
              expectedRevision: input.expectedRevision,
              entryId: input.entryId,
              displayName: input.displayName,
              definition: input.definition,
              ...(input.parentDigest === undefined ? {} : { parentDigest: input.parentDigest }),
              selectDefault: input.selectDefault,
              producer: { kind: producer.kind, id: producer.id },
              createdAt: new Date().toISOString(),
            });
            return { revision: result.catalog.revision, version: result.version };
          },
          replay: (digest) => {
            const current = readWorkspaceLightAppDefinition({
              ...scope(input.workspaceId),
              entryId: input.entryId,
            });
            const version = current.versions.find((item) => item.digest === digest);
            if (!version)
              throw new CatalogIntegrityError('Retained definition version is missing.');
            return { revision: current.revision, version };
          },
        })
      ),
    'catalog.light-app-history-import': (input, context) =>
      execute(() =>
        mutate('catalog.light-app-history-import', input, context, {
          kind: 'light_app_catalog',
          responseId: () => input.workspaceId,
          work: () => {
            const result = importWorkspaceLightAppDefinitionHistory({
              ...scope(input.workspaceId),
              expectedRevision: input.expectedRevision,
              export: input.export,
              ...(input.entryId === undefined ? {} : { entryId: input.entryId }),
            });
            return { revision: result.catalog.revision, entry: result.entry };
          },
          replay: () => {
            const current = readWorkspaceLightAppDefinition({
              ...scope(input.workspaceId),
              entryId: input.entryId ?? input.export.entry.id,
            });
            return { revision: current.revision, entry: current.entry };
          },
        })
      ),
    'catalog.light-app-select': (input, context) =>
      execute(() =>
        mutate('catalog.light-app-select', input, context, {
          kind: 'light_app_catalog',
          responseId: () => input.workspaceId,
          work: () => ({
            revision: selectWorkspaceLightAppDefinitionDefault({
              ...scope(input.workspaceId),
              expectedRevision: input.expectedRevision,
              entryId: input.entryId,
              digest: input.digest,
              expectedCurrentDigest: input.expectedCurrentDigest,
            }).revision,
          }),
          replay: () => ({
            revision: loadWorkspaceResourceCatalog(dataRoot(), input.workspaceId).revision,
          }),
        })
      ),
    'catalog.light-app-pin': (input, context) =>
      execute(() =>
        mutate('catalog.light-app-pin', input, context, {
          kind: 'light_app_catalog',
          responseId: () => input.workspaceId,
          work: () => ({
            revision: setWorkspaceLightAppDefinitionPin({
              ...scope(input.workspaceId),
              expectedRevision: input.expectedRevision,
              entryId: input.entryId,
              digest: input.digest,
              expectedPinDigest: input.expectedPinDigest,
            }).revision,
          }),
          replay: () => ({
            revision: loadWorkspaceResourceCatalog(dataRoot(), input.workspaceId).revision,
          }),
        })
      ),
    'kernel.apps.instantiate': (input, context) =>
      execute(() => {
        const command = kernel(input, context);
        const requestedDefinition = {
          entryId: input.entryId,
          ...(input.digest === undefined ? {} : { digest: input.digest }),
        };
        const replay = replayDefinition(
          command,
          allocateAppId(input.workspaceId, input.requestId),
          'kernel.apps.create',
          { requestedDefinition }
        );
        if (replay) return replay;
        const selected = resolveWorkspaceLightAppDefinition({
          ...scope(input.workspaceId),
          entryId: input.entryId,
          ...(input.digest === undefined ? {} : { digest: input.digest }),
        });
        return createLightApp(
          command,
          selected.definition,
          { entryId: input.entryId, digest: selected.version.digest },
          requestedDefinition
        );
      }),
    'kernel.schema.activate': (input, context) =>
      execute(() => {
        const command = kernel(input, context);
        const requestedDefinition = {
          entryId: input.entryId,
          ...(input.digest === undefined ? {} : { digest: input.digest }),
        };
        const replay = replayDefinition(command, input.appId, 'kernel.schema.update', {
          expectedAppRevision: input.expectedAppRevision,
          expectedSchemaRevision: input.expectedSchemaRevision,
          requestedDefinition,
        });
        if (replay) return replay;
        const selected = resolveWorkspaceLightAppDefinition({
          ...scope(input.workspaceId),
          entryId: input.entryId,
          ...(input.digest === undefined ? {} : { digest: input.digest }),
        });
        return updateLightAppSchema(
          command,
          input.appId,
          input.expectedAppRevision,
          input.expectedSchemaRevision,
          selected.definition,
          { entryId: input.entryId, digest: selected.version.digest },
          requestedDefinition
        );
      }),
    'kernel.snapshots.list': (input) =>
      execute(() => listLightAppSnapshots(dataRoot(), input.workspaceId, input.appId)),
    'kernel.snapshots.rollback': (input, context) =>
      execute(() =>
        rollbackLightAppSnapshot(
          kernel(input, context),
          input.appId,
          input.expectedAppRevision,
          input.snapshotId
        )
      ),
    'kernel.format.upgrade': (input, context) =>
      execute(() =>
        upgradeLightAppFormat(kernel(input, context), input.appId, input.expectedAppRevision)
      ),
  } satisfies FamilyImplementations<typeof LIGHT_APP_DEFINITION_OPERATION_DEFINITIONS>;
}
