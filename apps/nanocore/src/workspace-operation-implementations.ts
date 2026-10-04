import type { WORKSPACE_OPERATION_DEFINITIONS } from '@openkit/app-api-schemas';
import {
  type CreateWorkspaceRequestSchema,
  type UpdateWorkspaceRequestSchema,
  WorkspaceRecordSchema,
} from '@openkit/protocol';
import type { z } from 'zod';
import { readWorkspaceDashboard } from './app-dashboard.js';
import { listOutputArtifacts } from './artifact-catalog.js';
import type { Actor } from './auth/identity.js';
import { isCurrentDeploymentAdministrator } from './auth/operation-authorizer.js';
import { isThreadVisible } from './auth/thread-visibility.js';
import { KernelCommandError } from './generative-kernel/errors.js';
import { KnowledgePageValidationError } from './knowledge/okf.js';
import type { FsStore } from './lib/store.js';
import { StoreRecordNotFoundError } from './lib/store.js';
import type { OperationInvocationDependencies } from './operation-composition.js';
import type { AdmittedOperationContext } from './operation-contract.js';
import { type FamilyImplementations, publicOperationActor } from './operation-contract.js';
import { OperationError } from './operation-error.js';
import {
  IdempotencyKeyConflictError,
  type InflightIdempotentCommand,
  runIdempotentCommand,
} from './runtime/idempotent-command.js';
import type { CoreDb } from './storage/db.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';
import { readAuthorizedWorkspaces } from './workspace-sharing-operations.js';

/** Existing persistence and receipt owners used by Workspace commands. */
interface WorkspaceCommandDependencies {
  store: FsStore;
  coreDb: CoreDb | undefined;
  inflightCommands: WeakMap<FsStore, Map<string, InflightIdempotentCommand>>;
}

/** Projects current viewer-visible counts without rewriting retained history. */
function projectWorkspace(
  store: FsStore,
  coreDb: CoreDb | undefined,
  workspaceId: string,
  userId: string,
  administratorEligible: boolean
) {
  const workspace = store.getWorkspace(workspaceId);
  return WorkspaceRecordSchema.parse({
    ...workspace,
    counts: {
      ...workspace.counts,
      threadCount: store
        .listThreads(workspaceId)
        .filter((thread) => isThreadVisible(store, thread, userId, administratorEligible)).length,
      artifactCount: listOutputArtifacts(store, coreDb, workspaceId, userId, administratorEligible)
        .length,
    },
  });
}

/** Projects admitted viewer counts and keeps known missing-record refusals. */
function readWorkspace(
  store: FsStore,
  coreDb: CoreDb | undefined,
  workspaceId: string,
  userId: string,
  administratorEligible: boolean
) {
  try {
    return projectWorkspace(store, coreDb, workspaceId, userId, administratorEligible);
  } catch (error) {
    workspaceCommandFailure(error, 'not_found');
  }
}

/** Creates or replays the existing actor-owned Workspace command. */
async function createWorkspace(
  input: z.infer<typeof CreateWorkspaceRequestSchema>,
  dependencies: WorkspaceCommandDependencies,
  actor: Actor,
  administratorEligible: boolean
) {
  const { store, coreDb, inflightCommands } = dependencies;
  try {
    const workspace = await runIdempotentCommand({
      store,
      inflightCommands,
      command: 'workspace.create',
      requestId: input.requestId,
      scope: { userId: actor.userId },
      input: input,
      responseKind: 'workspace',
      execute: () => {
        const workspace = WorkspaceRecordSchema.parse(store.createWorkspace(input.name));
        if (coreDb) {
          recordWorkspaceOwnerMembership({
            coreDb,
            ownerUserId: actor.userId,
            workspaceId: workspace.id,
          });
        }

        return workspace;
      },
      replay: (record) => WorkspaceRecordSchema.parse(store.getWorkspace(record.response.id)),
      responseId: (result) => result.id,
    });

    // A committed command keeps its owned count-projection fallback; this neither retries nor claims rollback.
    try {
      return projectWorkspace(store, coreDb, workspace.id, actor.userId, administratorEligible);
    } catch (error) {
      throw new OperationError('workspace_create_failed', 'Count projection unavailable.', 404, {
        cause: error,
      });
    }
  } catch (error) {
    workspaceCommandFailure(error, 'workspace_create_failed');
  }
}

/** Updates or replays the existing Workspace command with its original logical input hash. */
async function updateWorkspace(
  input: z.infer<typeof UpdateWorkspaceRequestSchema> & { workspaceId: string },
  dependencies: WorkspaceCommandDependencies,
  actor: Actor,
  administratorEligible: boolean
) {
  const { store, coreDb, inflightCommands } = dependencies;
  const { workspaceId, ...body } = input;
  try {
    const workspace = await runIdempotentCommand({
      store,
      inflightCommands,
      command: 'workspace.update',
      requestId: body.requestId,
      scope: { workspaceId },
      input: { ...body, workspaceId },
      responseKind: 'workspace',
      execute: () => WorkspaceRecordSchema.parse(store.updateWorkspace(workspaceId, body)),
      replay: (record) => WorkspaceRecordSchema.parse(store.getWorkspace(record.response.id)),
      responseId: (result) => result.id,
    });

    // The receipt is already owned by the command; a failed viewer projection does not undo it.
    try {
      return projectWorkspace(store, coreDb, workspace.id, actor.userId, administratorEligible);
    } catch (error) {
      throw new OperationError('workspace_update_failed', 'Count projection unavailable.', 404, {
        cause: error,
      });
    }
  } catch (error) {
    workspaceCommandFailure(error, 'workspace_update_failed');
  }
}

/** Joins Workspace commands and reads to their existing receipts, viewer projection and admitted-set owners. */
export function createWorkspaceOperationImplementations(
  dependencies: Pick<
    OperationInvocationDependencies,
    'coreDb' | 'store' | 'inflightCommands' | 'runtimeConfigManager'
  >
) {
  const workspaceDependencies = {
    store: dependencies.store!,
    coreDb: dependencies.coreDb,
    inflightCommands: dependencies.inflightCommands!,
  };
  const administrator = (context: AdmittedOperationContext) =>
    isCurrentDeploymentAdministrator(dependencies.coreDb!, publicOperationActor(context));
  return {
    'workspace.create': (input, context) =>
      createWorkspace(
        input,
        workspaceDependencies,
        publicOperationActor(context),
        administrator(context)
      ),
    'workspace.read': (input, context) =>
      readWorkspace(
        dependencies.store!,
        dependencies.coreDb,
        input.workspaceId,
        publicOperationActor(context).userId,
        administrator(context)
      ),
    'workspace.update': (input, context) =>
      updateWorkspace(
        input,
        workspaceDependencies,
        publicOperationActor(context),
        administrator(context)
      ),
    'workspace.dashboard': (input, context) =>
      readWorkspaceDashboard({
        ...input,
        ...workspaceDependencies,
        actor: publicOperationActor(context),
        runtimeConfigManager: dependencies.runtimeConfigManager!,
        administratorEligible: administrator(context),
      }),
    'workspace.list': async (_input, context) => {
      try {
        const workspaceIds =
          context.scope.kind === 'authorized-workspace-set' ? context.scope.workspaceIds : [];
        return readAuthorizedWorkspaces(
          dependencies.coreDb!,
          dependencies.store!,
          publicOperationActor(context),
          workspaceIds
        );
      } catch (error) {
        if (error instanceof StoreRecordNotFoundError)
          throw new OperationError('not_found', error.message, 404, { cause: error });
        throw error;
      }
    },
    'workspace.resources': async (input) => {
      try {
        return await dependencies.store!.getWorkspaceResources(input.workspaceId);
      } catch (error) {
        if (error instanceof StoreRecordNotFoundError)
          throw new OperationError('not_found', error.message, 404, { cause: error });
        throw error;
      }
    },
  } satisfies FamilyImplementations<typeof WORKSPACE_OPERATION_DEFINITIONS>;
}

/** Classifies known Workspace command refusals; unknown execution failures stay unknown. */
function workspaceCommandFailure(error: unknown, missingCode: string): never {
  if (error instanceof OperationError) throw error;
  if (error instanceof KernelCommandError) {
    const details = {
      ...(error.limit === undefined ? {} : { limit: error.limit }),
      ...(error.maximum === undefined ? {} : { maximum: error.maximum }),
    };
    throw new OperationError(error.code, error.message, error.status, {
      cause: error,
      ...(Object.keys(details).length ? { details } : {}),
      ...(error.path === undefined ? {} : { path: [error.path] }),
    });
  }
  if (error instanceof KnowledgePageValidationError || error instanceof IdempotencyKeyConflictError)
    throw new OperationError(error.code, error.message, error.status, { cause: error });
  if (error instanceof StoreRecordNotFoundError)
    throw new OperationError(missingCode, error.message, 404, { cause: error });
  throw error;
}
