import { existsSync } from 'node:fs';
import type { MEMORY_OPERATION_DEFINITIONS } from '@openkit/app-api-schemas';
import { z } from 'zod';
import { applyMemoryForget, prepareMemoryForget } from './knowledge/memory-forget.js';
import {
  diffMemoryHistory,
  readMemoryHistory,
  restoreMemoryHistory,
} from './knowledge/memory-history.js';
import {
  editMemoryPage,
  listMemoryPages,
  type MemoryWriter,
  readMemoryPage,
  saveMemoryPage,
} from './knowledge/memory-lifecycle.js';
import { MemoryPageUnavailableError } from './knowledge/memory-maintenance.js';
import { NotebookError } from './knowledge/notebook.js';
import {
  initializeScopedNotebook,
  resolveScopedNotebookOwner,
  ScopedNotebookAccessError,
} from './knowledge/scoped-notebook-owner.js';
import type { OperationInvocationDependencies } from './operation-composition.js';
import {
  type AdmittedOperationContext,
  type FamilyImplementations,
  publicOperationActor,
} from './operation-contract.js';
import { OperationError } from './operation-error.js';
import { IdempotencyKeyConflictError } from './runtime/idempotent-command.js';
import { PendingRequestCommandError } from './runtime/pending-requests.js';
import { openUserDb } from './storage/db.js';
import { userDbPath } from './storage/fs-layout.js';
import { applyScopedMigrations } from './storage/migrate.js';

/** Fixed public errors preserve scope privacy and never expose Git, decoder or filesystem details. */
function memoryFailure(error: unknown): never {
  if (error instanceof OperationError) throw error;
  if (error instanceof ScopedNotebookAccessError)
    throw new OperationError('memory_access_denied', 'Memory access denied.', 403);
  if (error instanceof MemoryPageUnavailableError)
    throw new OperationError('memory_unavailable', 'Memory page unavailable.', 404);
  if (error instanceof NotebookError)
    throw new OperationError(
      error.code,
      error.message,
      error.code === 'invalid_request' ? 400 : error.code === 'recovery_required' ? 503 : 409
    );
  if (error instanceof IdempotencyKeyConflictError || error instanceof PendingRequestCommandError)
    throw new OperationError(error.code, error.message, error.status);
  if (error instanceof z.ZodError)
    throw new OperationError('invalid_request', 'Invalid Memory request.', 400);
  throw error;
}

/** Joins explicit authenticated-self Memory operations to the existing User notebook and command owners. */
export function createMemoryOperationImplementations(
  dependencies: OperationInvocationDependencies
) {
  const self = async <T>(
    context: AdmittedOperationContext,
    run: (writer: MemoryWriter) => T | Promise<T>,
    initialize = false
  ): Promise<T> => {
    const { coreDb, store, runtimeConfigManager, inflightCommands } = dependencies;
    if (!coreDb || !store || !runtimeConfigManager || !inflightCommands)
      throw new OperationError('recovery_required', 'Memory storage is unavailable.', 503);
    const actor = publicOperationActor(context);
    const target = { kind: 'user' } as const;
    try {
      resolveScopedNotebookOwner({ coreDb, actor, target });
    } catch (error) {
      return memoryFailure(error);
    }
    if (!initialize && !existsSync(userDbPath(coreDb.dataRoot, actor.userId)))
      throw new OperationError('recovery_required', 'Memory storage is unavailable.', 503);
    const userDb = openUserDb(coreDb.dataRoot, actor.userId);
    try {
      applyScopedMigrations(userDb);
      return await run({ coreDb, userDb, actor, store, runtimeConfigManager, inflightCommands });
    } catch (error) {
      return memoryFailure(error);
    } finally {
      userDb.sqlite.close();
    }
  };
  const forget = async <T>(
    context: AdmittedOperationContext,
    workspaceId: string,
    run: (
      writer: MemoryWriter & {
        workspaceDb: ReturnType<
          NonNullable<OperationInvocationDependencies['repositoryWorkspaceDb']>
        >;
      }
    ) => T | Promise<T>
  ) =>
    self(context, async (writer) => {
      if (!dependencies.repositoryWorkspaceDb)
        throw new OperationError('recovery_required', 'Confirmation storage is unavailable.', 503);
      const workspaceDb = dependencies.repositoryWorkspaceDb(workspaceId);
      try {
        return await run({ ...writer, workspaceDb });
      } finally {
        workspaceDb.sqlite.close();
      }
    });
  return {
    'memory.notebook.initialize': (input, context) =>
      self(
        context,
        (writer) => ({
          ownerScope: { kind: 'user' as const, userId: writer.userDb.userId },
          notebookRevision: initializeScopedNotebook({
            ...writer,
            target: { kind: 'user' },
            initialization: {
              requestId: input.requestId,
              instructionReference: `memory.notebook.initialize:${input.requestId}`,
            },
          }),
        }),
        true
      ),
    'memory.list': (_input, context) => self(context, (writer) => listMemoryPages(writer)),
    'memory.read': (input, context) =>
      self(context, (writer) => ({ page: readMemoryPage(writer, input.pageId) })),
    'memory.create': (input, context) => self(context, (writer) => saveMemoryPage(writer, input)),
    'memory.update': (input, context) => self(context, (writer) => editMemoryPage(writer, input)),
    'memory.notebook.history': (input, context) =>
      self(context, (writer) => readMemoryHistory(writer, input)),
    'memory.notebook.diff': (input, context) =>
      self(context, (writer) => diffMemoryHistory(writer, input)),
    'memory.notebook.restore': (input, context) =>
      self(context, (writer) => restoreMemoryHistory(writer, input)),
    'memory.forget.prepare': (input, context) =>
      forget(context, input.workspaceId, (writer) => prepareMemoryForget(writer, input)),
    'memory.forget': (input, context) =>
      forget(context, input.workspaceId, (writer) => applyMemoryForget(writer, input)),
  } satisfies FamilyImplementations<typeof MEMORY_OPERATION_DEFINITIONS>;
}
