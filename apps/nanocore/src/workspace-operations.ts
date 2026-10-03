import {
  type CreateWorkspaceRequestSchema,
  type UpdateWorkspaceRequestSchema,
  WorkspaceRecordSchema,
} from '@openkit/protocol';
import type { z } from 'zod';
import { publishedErrorMessage } from './api-errors.js';
import { listOutputArtifacts } from './artifact-catalog.js';
import type { Actor } from './auth/identity.js';
import { isThreadVisible } from './auth/thread-visibility.js';
import { CoreCommandError, throwCoreCommandError } from './core-command-errors.js';
import type { FsStore } from './lib/store.js';
import {
  type InflightIdempotentCommand,
  runIdempotentCommand,
} from './runtime/idempotent-command.js';
import type { CoreDb } from './storage/db.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

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

/** Preserves the read fallback while commands keep their own post-commit projection errors. */
export function readWorkspace(
  store: FsStore,
  coreDb: CoreDb | undefined,
  workspaceId: string,
  userId: string,
  administratorEligible: boolean
) {
  try {
    return projectWorkspace(store, coreDb, workspaceId, userId, administratorEligible);
  } catch (error) {
    throw new CoreCommandError('not_found', publishedErrorMessage(error), 404);
  }
}

/** Creates or replays the existing actor-owned Workspace command. */
export async function createWorkspace(
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

    return projectWorkspace(store, coreDb, workspace.id, actor.userId, administratorEligible);
  } catch (error) {
    throwCoreCommandError(error, 'workspace_create_failed');
  }
}

/** Updates or replays the existing Workspace command with its original logical input hash. */
export async function updateWorkspace(
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

    return projectWorkspace(store, coreDb, workspace.id, actor.userId, administratorEligible);
  } catch (error) {
    throwCoreCommandError(error, 'workspace_update_failed');
  }
}
