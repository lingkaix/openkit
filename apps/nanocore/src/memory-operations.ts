import { existsSync, lstatSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  MEMORY_OPERATION_DEFINITIONS,
  MemoryPublicationSchema,
  type OperationInput,
} from '@openkit/app-api-schemas';
import { z } from 'zod';
import { authorizeWorkspace } from './auth/operation-authorizer.js';
import { finishCapabilityCall, startCapabilityCall } from './capability/usage-ledger.js';
import { initializeDefaultKnowledgeBaseId } from './config/knowledge-base.js';
import { findAssistantTimeline } from './internal-agents/assistant-timeline.js';
import { applyMemoryForget, prepareMemoryForgetCommand } from './knowledge/memory-forget.js';
import {
  diffMemoryHistory,
  readMemoryHistory,
  restoreMemoryHistory,
} from './knowledge/memory-history.js';
import {
  admitMemoryContext,
  editMemoryPage,
  listMemoryPages,
  type MemoryWriter,
  memoryPageFacts,
  readMemoryPage,
  saveMemoryPage,
} from './knowledge/memory-lifecycle.js';
import {
  assertMemoryPagesNotSuppressed,
  MemoryPageUnavailableError,
} from './knowledge/memory-maintenance.js';
import { KnowledgeNotebook, NotebookError } from './knowledge/notebook.js';
import { initializeNotebook } from './knowledge/notebook-initialization.js';
import { DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT } from './knowledge/okf.js';
import {
  admitUserMemorySources,
  listUserKnowledgeSources,
  readUserKnowledgeSource,
  registerUserKnowledgeSource,
} from './knowledge/scoped-knowledge-sources.js';
import {
  resolveScopedNotebookOwner,
  ScopedNotebookAccessError,
} from './knowledge/scoped-notebook-owner.js';
import { readUserMemoryNotebookAdmission } from './knowledge/user-memory-agent-maintenance.js';
import {
  decideUserMemoryProposal,
  readUserMemoryProposal,
  readUserMemoryProposalPreview,
} from './knowledge/user-memory-proposals.js';
import type { OperationInvocationDependencies } from './operation-composition.js';
import {
  type AdmittedOperationContext,
  type FamilyImplementations,
  publicOperationActor,
} from './operation-contract.js';
import { OperationError } from './operation-error.js';
import { admitUserMemoryRetrieval } from './retrieval-knowledge-adapter.js';
import { IdempotencyKeyConflictError, runIdempotentCommand } from './runtime/idempotent-command.js';
import { PendingRequestCommandError } from './runtime/pending-requests.js';
import { openUserDb } from './storage/db.js';
import { userDbPath } from './storage/fs-layout.js';
import { retrieveUserMemory } from './storage/index-rebuild.js';
import { applyScopedMigrations } from './storage/migrate.js';

/** First explicit save owns fresh scope creation; existing or lost notebooks are never initialized again. */
function createFreshMemory(writer: MemoryWriter, input: OperationInput<'memory.create'>) {
  const owner = admitMemoryContext(writer);
  const path = `${input.pageId}.md`;
  if (!memoryPageFacts(path, input.content)) throw new NotebookError('invalid_request');
  const notebook = new KnowledgeNotebook({
    repositoryPath: join(owner.notebookRoot, 'notebook.git'),
  });
  const ownerScope = { kind: 'user' as const, userId: writer.userDb.userId };
  const project = (revision: string) => {
    admitMemoryContext(writer);
    assertMemoryPagesNotSuppressed(owner.notebookRoot, writer.userDb.userId, [path]);
    notebook.history({ revision, limit: 1 });
    const selected = notebook.readRevision(revision);
    admitUserMemorySources(writer, selected.files);
    if (
      selected.files[path] !== input.content ||
      selected.metadata.changeRequest.requestId !== input.requestId
    )
      throw new NotebookError('recovery_required');
    return {
      outcome: 'published' as const,
      ownerScope,
      baseRevision: null,
      notebookRevision: revision,
      changedPageIds: [input.pageId],
      receiptRef: {
        operation: 'knowledge.create' as const,
        requestId: input.requestId,
        ownerScope,
      },
    };
  };
  return runIdempotentCommand({
    store: writer.store,
    receiptDb: writer.userDb,
    inflightCommands: writer.inflightCommands,
    command: 'knowledge.create',
    requestId: input.requestId,
    scope: { userId: writer.userDb.userId, actorId: writer.actor!.userId },
    input,
    responseKind: 'knowledge_notebook_revision',
    responseId: (result) => result.notebookRevision,
    replay: (receipt) => project(receipt.response.id),
    execute: () => {
      if (lstatSync(owner.notebookRoot, { throwIfNoEntry: false }))
        throw new NotebookError('conflict');
      if (
        writer.userDb.sqlite
          .prepare(
            "SELECT 1 FROM audit_events WHERE action = 'knowledge.notebook.initialize' LIMIT 1"
          )
          .get()
      )
        throw new NotebookError('recovery_required');
      // The explicit first save binds its base before Notebook publication; readers never allocate it.
      const knowledgeBaseId = initializeDefaultKnowledgeBaseId({
        dataRoot: writer.coreDb.dataRoot,
        scope: ownerScope,
      });
      const revalidate = () => {
        admitMemoryContext(writer);
        const maintenance = writer.runtimeConfigManager
          .current()
          .userConfigs.find(({ userId }) => userId === writer.userDb.userId)
          ?.config.knowledgeMaintenance;
        if (maintenance?.reviewRequiredPageIds.includes(input.pageId))
          throw new NotebookError('review_required');
        return {
          pageScopeId: `page/user/${writer.userDb.userId}/${knowledgeBaseId}`,
          scopeSchemaText: DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT,
          reviewRequiredPageIds: maintenance?.reviewRequiredPageIds ?? [],
          registeredSources: admitUserMemorySources(writer, { [path]: input.content })
            .registeredSources,
          resolvedReferences: new Map<string, ReadonlySet<string>>(),
        };
      };
      return project(
        initializeNotebook({
          notebookRoot: owner.notebookRoot,
          owner: { kind: 'user', userDb: writer.userDb },
          files: { [path]: input.content },
          revalidate,
          initialization: {
            requestId: input.requestId,
            producer: { kind: 'user', id: writer.userDb.userId },
            instructionReference: `memory.create:${input.requestId}`,
          },
        })
      );
    },
  });
}

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
      const owner = resolveScopedNotebookOwner({ coreDb, actor, target });
      // First use may create a UserDb only when neither retained personal record family exists.
      if (
        !existsSync(userDbPath(coreDb.dataRoot, actor.userId)) &&
        (!initialize ||
          lstatSync(owner.notebookRoot, { throwIfNoEntry: false }) ||
          lstatSync(join(dirname(owner.notebookRoot), 'sources'), { throwIfNoEntry: false }))
      )
        throw new OperationError('recovery_required', 'Memory storage is unavailable.', 503);
    } catch (error) {
      return memoryFailure(error);
    }
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
      if (
        !authorizeWorkspace(writer.coreDb, writer.actor!, workspaceId, {
          policyOperation: 'workspace.write',
          mutating: true,
        })
      )
        throw new OperationError('workspace_access_denied', 'Workspace access denied.', 403);
      const workspaceDb = dependencies.repositoryWorkspaceDb(workspaceId);
      try {
        return await run({ ...writer, workspaceDb });
      } finally {
        workspaceDb.sqlite.close();
      }
    });
  const queryAccess = (
    writer: MemoryWriter,
    context: AdmittedOperationContext,
    workspaceId: string
  ) => {
    if (
      !authorizeWorkspace(writer.coreDb, writer.actor!, workspaceId, {
        policyOperation: 'knowledge.read',
        mutating: false,
      })
    )
      throw new OperationError('workspace_access_denied', 'Workspace access denied.', 403);
    const threadId =
      context.queryContext?.threadId ??
      findAssistantTimeline(writer.store, workspaceId, writer.userDb.userId)?.id;
    if (!threadId)
      throw new OperationError(
        'memory_access_denied',
        'Memory needs a private Assistant Timeline.',
        403
      );
    return {
      store: writer.store,
      coreDb: writer.coreDb,
      userDb: writer.userDb,
      actor: context.actorRef,
      requestActor: writer.actor!,
      outputThreadId: threadId,
      outputTurnId: context.queryContext?.turnId,
    };
  };
  const proposalContext = (writer: MemoryWriter) => ({
    ...writer,
    actor: writer.actor!,
    revalidate: (files: Readonly<Record<string, string>>, changedPaths: readonly string[] = []) =>
      readUserMemoryNotebookAdmission(writer, files, changedPaths),
  });
  const maintain = (
    input: OperationInput<'memory.maintain'> | OperationInput<'memory.tell'>,
    context: AdmittedOperationContext
  ) =>
    self(
      context,
      async (writer) => {
        if (context.queryContext) {
          const access = queryAccess(writer, context, input.workspaceId);
          // An existing shared caller cannot substitute a private Timeline for User-scoped effects.
          admitUserMemoryRetrieval({
            dataRoot: writer.coreDb.dataRoot,
            workspaceId: input.workspaceId,
            access,
          });
        } else if (
          !authorizeWorkspace(writer.coreDb, writer.actor!, input.workspaceId, {
            policyOperation: 'knowledge.read',
            mutating: false,
          })
        ) {
          throw new OperationError('workspace_access_denied', 'Workspace access denied.', 403);
        }
        if (!dependencies.knowledgeAgent?.maintainMemory)
          throw new OperationError('memory_unavailable', 'Memory maintenance is unavailable.', 503);
        return dependencies.knowledgeAgent.maintainMemory(
          {
            requestId: input.requestId,
            requestActor: writer.actor!,
            trigger: 'request',
            instructions:
              'content' in input
                ? 'Integrate this explicit personal information and keep the Memory overview current.'
                : input.instruction,
            sources: 'content' in input ? input.sources : (input.sourceIds ?? []),
            ...('content' in input ? { tellContent: input.content } : {}),
            ...('pageIds' in input && input.pageIds ? { pageIds: input.pageIds } : {}),
            ...(context.queryContext ? { askingThreadId: context.queryContext.threadId } : {}),
            ...(context.queryContext?.turnId ? { askingTurnId: context.queryContext.turnId } : {}),
            signal: context.signal ?? new AbortController().signal,
          },
          writer.userDb
        );
      },
      true
    );
  return {
    'memory.ask': (input, context) =>
      self(context, async (writer) => {
        if (!dependencies.knowledgeAgent)
          throw new OperationError('memory_unavailable', 'Memory query is unavailable.', 503);
        const access = queryAccess(writer, context, input.workspaceId);
        admitUserMemoryRetrieval({
          dataRoot: writer.coreDb.dataRoot,
          workspaceId: input.workspaceId,
          access,
        });
        if (!dependencies.repositoryWorkspaceDb)
          throw new OperationError('memory_unavailable', 'Memory delivery is unavailable.', 503);
        const db = dependencies.repositoryWorkspaceDb(input.workspaceId);
        const call = startCapabilityCall({
          workspaceDb: db,
          workspaceId: input.workspaceId,
          authorityActor: context.actorRef,
          family: 'knowledge',
          operation: 'memory.ask',
          capabilityId: 'memory.ask',
          requestId: null,
          providerRef: null,
          serviceRef: 'knowledge-manager',
          redactionClass: 'metadata-only',
          summary: 'Memory question.',
          threadId: access.outputThreadId,
          turnId: access.outputTurnId ?? null,
        });
        try {
          const result = await dependencies.knowledgeAgent.ask({
            workspaceId: input.workspaceId,
            question: input.question,
            source: 'memory',
            caller: context.delivery === 'model' ? 'internal-agent' : 'app-api',
            access,
            signal: context.signal ?? new AbortController().signal,
            capabilityCallId: call.id,
          });
          finishCapabilityCall({
            workspaceDb: db,
            callId: call.id,
            status: 'succeeded',
            deliveredKnowledgeAnswer: JSON.stringify(result),
          });
          return result;
        } catch (error) {
          finishCapabilityCall({
            workspaceDb: db,
            callId: call.id,
            status: 'failed',
            errorCode: 'knowledge_query_failed',
          });
          throw error;
        } finally {
          db.sqlite.close();
        }
      }),
    'memory.tell': maintain,
    'memory.maintain': maintain,
    'memory.proposal.read': (input, context) =>
      self(context, (writer) =>
        readUserMemoryProposalPreview(proposalContext(writer), {
          proposalId: input.proposalId,
          offset: input.offset,
          ...(input.path ? { path: input.path } : {}),
        })
      ),
    'memory.proposal.decide': (input, context) =>
      self(context, async (writer) => {
        if (context.delivery === 'model')
          throw new OperationError(
            'human_review_required',
            'A human must decide this Memory candidate.',
            403
          );
        const owner = proposalContext(writer);
        const { proposal } = readUserMemoryProposal(owner, input.proposalId);
        const result = await decideUserMemoryProposal(owner, input);
        return {
          proposalId: input.proposalId,
          status: input.decision,
          review: result.review,
          application: result.notebookRevision
            ? {
                changedPageIds: proposal.changes!.map(({ path }) => path.slice(0, -3)),
                contentDigest: proposal.contentDigest,
                present: proposal.changes!.some(({ content }) => content !== null),
                notebookRevision: result.notebookRevision,
              }
            : null,
        };
      }),
    'memory.search': (input, context) =>
      self(context, async (writer) => {
        if (
          !authorizeWorkspace(writer.coreDb, writer.actor!, input.workspaceId, {
            policyOperation: 'knowledge.read',
            mutating: false,
          })
        )
          throw new OperationError('workspace_access_denied', 'Workspace access denied.', 403);
        // Existing query lineage remains binding; a shared Thread cannot be replaced by a Timeline.
        const threadId =
          context.queryContext?.threadId ??
          findAssistantTimeline(writer.store, input.workspaceId, writer.userDb.userId)?.id;
        if (!threadId)
          throw new OperationError(
            'memory_access_denied',
            'Memory needs a private Assistant Timeline.',
            403
          );
        return MEMORY_OPERATION_DEFINITIONS['memory.search'].outputSchema.parse(
          await retrieveUserMemory({
            dataRoot: writer.coreDb.dataRoot,
            workspaceId: input.workspaceId,
            caller: 'app-api',
            query: input.query,
            limit: input.limit,
            pinnedReferences: input.pinnedReferences,
            states: input.states,
            access: {
              store: writer.store,
              coreDb: writer.coreDb,
              userDb: writer.userDb,
              actor: context.actorRef,
              requestActor: writer.actor!,
              outputThreadId: threadId,
              outputTurnId: context.queryContext?.turnId,
            },
          })
        );
      }),
    'memory.source.register': (input, context) =>
      self(
        context,
        async (writer) =>
          MEMORY_OPERATION_DEFINITIONS['memory.source.register'].outputSchema.parse({
            source: await registerUserKnowledgeSource(writer, input),
          }),
        true
      ),
    'memory.source.list': (_input, context) =>
      self(context, (writer) =>
        MEMORY_OPERATION_DEFINITIONS['memory.source.list'].outputSchema.parse({
          items: listUserKnowledgeSources(writer, context.delivery),
        })
      ),
    'memory.source.read': (input, context) =>
      self(context, (writer) => {
        const entry = readUserKnowledgeSource(writer, input.sourceId, context.delivery);
        return MEMORY_OPERATION_DEFINITIONS['memory.source.read'].outputSchema.parse({
          source: entry ? { ...entry.source, content: entry.content } : null,
        });
      }),
    'memory.list': (_input, context) =>
      self(context, (writer) =>
        MEMORY_OPERATION_DEFINITIONS['memory.list'].outputSchema.parse(listMemoryPages(writer))
      ),
    'memory.read': (input, context) =>
      self(context, (writer) =>
        MEMORY_OPERATION_DEFINITIONS['memory.read'].outputSchema.parse({
          page: readMemoryPage(writer, input.pageId),
        })
      ),
    'memory.create': (input, context) =>
      self(
        context,
        async (writer) =>
          MemoryPublicationSchema.parse(
            await (input.baseRevision === null
              ? createFreshMemory(writer, input)
              : saveMemoryPage(writer, { ...input, baseRevision: input.baseRevision }))
          ),
        input.baseRevision === null
      ),
    'memory.update': (input, context) =>
      self(context, async (writer) =>
        MemoryPublicationSchema.parse(await editMemoryPage(writer, input))
      ),
    'memory.notebook.history': (input, context) =>
      self(context, (writer) => readMemoryHistory(writer, input)),
    'memory.notebook.diff': (input, context) =>
      self(context, (writer) => diffMemoryHistory(writer, input)),
    'memory.notebook.restore': (input, context) =>
      self(context, async (writer) =>
        MemoryPublicationSchema.parse(await restoreMemoryHistory(writer, input))
      ),
    'memory.forget.prepare': (input, context) =>
      forget(context, input.workspaceId, (writer) => prepareMemoryForgetCommand(writer, input)),
    'memory.forget': (input, context) =>
      forget(context, input.workspaceId, async (writer) =>
        MemoryPublicationSchema.parse(await applyMemoryForget(writer, input))
      ),
  } satisfies FamilyImplementations<typeof MEMORY_OPERATION_DEFINITIONS>;
}
