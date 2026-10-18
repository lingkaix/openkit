import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { KNOWLEDGE_ENTRY_OPERATION_DEFINITIONS, OperationId } from '@openkit/app-api-schemas';
import {
  KNOWLEDGE_OPERATION_DEFINITIONS,
  KnowledgeDerivedIndexesResponseSchema,
  KnowledgeManagerAnswerResponseSchema,
  KnowledgeManagerDraftProposalResponseSchema,
  KnowledgeManagerHealthCheckResponseSchema,
  KnowledgeManagerPrepareContextResponseSchema,
  KnowledgeManagerSuggestRepairResponseSchema,
  KnowledgeRetrievalResponseSchema,
  ListKnowledgeClaimsResponseSchema,
  ListKnowledgeConflictsResponseSchema,
  ListKnowledgeObservationsResponseSchema,
  ListKnowledgeSourcesResponseSchema,
  ReadKnowledgeSourceResponseSchema,
  RecordKnowledgeClaimResponseSchema,
  RecordKnowledgeConflictResponseSchema,
  RecordKnowledgeObservationResponseSchema,
  RegisterKnowledgeSourceResponseSchema,
  ResolveKnowledgeConflictResponseSchema,
  ReverseKnowledgeProposalResponseSchema,
} from '@openkit/app-api-schemas';
import {
  type ActorRef,
  allocateEntityId,
  deriveEntityId,
  ListKnowledgeEntriesResponseSchema,
  parseReferenceScope,
  parseReferenceUri,
} from '@openkit/protocol';
import { z } from 'zod';
import { publishedErrorMessage } from './api-errors.js';
import { listWorkspaceAuditEvents, recordWorkspaceAuditEvent } from './audit-events.js';
import { isWorkspaceOperationAuthorized } from './auth/operation-authorizer.js';
import {
  finishCapabilityCall,
  normalizeCapabilityRequestId,
  recordUsage,
  startCapabilityCall,
} from './capability/usage-ledger.js';
import { readDefaultKnowledgeBaseId } from './config/knowledge-base.js';
import { KnowledgeNotebook, NotebookError } from './knowledge/notebook.js';
import {
  type NotebookEntryEdit,
  publishWorkspaceNotebookEntry,
} from './knowledge/notebook-entry-publication.js';
import { createNotebookHistoryOperations } from './knowledge/notebook-history.js';
import {
  type NotebookPublicationDependencies,
  type NotebookUpdate,
  publishWorkspaceNotebook,
} from './knowledge/notebook-publication.js';
import { readWorkspaceNotebookAdmission } from './knowledge/notebook-workspace-admission.js';
import {
  KnowledgePageValidationError,
  resolveRegisteredKnowledgeSourceReference,
} from './knowledge/okf.js';
import {
  checkKnowledgeHealth,
  draftKnowledgeProposal,
  prepareKnowledgeContext,
  prepareTaskKnowledgeContext,
  suggestKnowledgeRepairs,
} from './knowledge-manager.js';
import { verifyKnowledgeProposalWorkHistory } from './knowledge-source-authority.js';
import {
  commandRequestKey,
  type FsStore,
  KnowledgeProposalAuthorityError,
  knowledgeAuthorityId,
  knowledgeProposalAuthorityError as knowledgeProposalAuthorityFailure,
  StoreRecordNotFoundError,
} from './lib/store.js';
import type { OperationInvocationDependencies } from './operation-composition.js';
import {
  type AdmittedOperationContext,
  type OperationImplementations,
  publicOperationActor,
} from './operation-contract.js';
import { OperationError } from './operation-error.js';
import { admitOperation } from './operation-resolvers.js';
import {
  admitKnowledgeRetrieval,
  knowledgeSourceAudienceReadable,
  readAuthorizedServerNotebookPages,
  readAuthorizedWorkspaceNotebookPages,
  threadReadable,
} from './retrieval-knowledge-adapter.js';
import {
  commandInputHash,
  IdempotencyKeyConflictError,
  runIdempotentCommand,
} from './runtime/idempotent-command.js';
import type { CoreDb, WorkspaceDb } from './storage/db.js';
import { openWorkspaceDb } from './storage/db.js';
import {
  readWorkspaceKnowledgeDerivedIndexes,
  retrieveWorkspaceKnowledge,
} from './storage/index-rebuild.js';
import { applyScopedMigrations } from './storage/migrate.js';
import { parseOwnedKnowledgeEntry } from './storage/workspace-file-records.js';

/** Projects known Knowledge command, record and decoder refusals; arbitrary exceptions escape. */
function commandFailure(error: unknown, code: string, status = 404): OperationError {
  if (error instanceof OperationError) return error;
  if (error instanceof IdempotencyKeyConflictError || error instanceof KnowledgePageValidationError)
    return new OperationError(error.code, error.message, error.status);
  if (
    error instanceof StoreRecordNotFoundError ||
    error instanceof SyntaxError ||
    error instanceof z.ZodError
  )
    return new OperationError(code, publishedErrorMessage(error), status, { cause: error });
  throw error;
}

/** Keeps native notebook partial outcomes visible without exposing Git or filesystem diagnostics. */
function notebookCommandFailure(error: unknown): never {
  if (error instanceof OperationError) throw error;
  if (error instanceof KnowledgeProposalAuthorityError)
    knowledgeProposalCommandFailure(error, 'knowledge_proposal_failed');
  if (error instanceof IdempotencyKeyConflictError || error instanceof KnowledgePageValidationError)
    throw commandFailure(error, 'invalid_request', 400);
  if (error instanceof NotebookError)
    throw new OperationError(
      error.code,
      error.message,
      error.code === 'invalid_request' ? 400 : 409,
      {
        ...(error.currentRevision ? { details: { currentRevision: error.currentRevision } } : {}),
      }
    );
  throw new OperationError(
    'recovery_required',
    'Notebook publication evidence is unavailable.',
    503,
    { cause: error }
  );
}

/** Requires a scoped child from its current owner after native Workspace admission; no foreign Workspace is scanned. */
function readAuthorizedKnowledgeOwner<T extends { readonly workspaceId: string }>(
  workspaceId: string,
  readOwner: () => T
): T {
  try {
    const owner = readOwner();
    if (owner.workspaceId !== workspaceId)
      throw new OperationError('workspace_access_denied', 'Workspace access denied.', 403);
    return owner;
  } catch (error) {
    if (
      !(
        error instanceof StoreRecordNotFoundError ||
        error instanceof OperationError ||
        error instanceof SyntaxError ||
        error instanceof z.ZodError
      )
    )
      throw error;
    throw new OperationError('workspace_access_denied', 'Workspace access denied.', 403);
  }
}

/**
 * Maps one proposal draft failure to the closed public error vocabulary.
 *
 * @param error Caught draft command failure.
 * @throws The retained typed owner refusal or its bounded fallback.
 */
function knowledgeProposalDraftFailure(error: unknown): never {
  if (error instanceof OperationError) throw error;
  if (error instanceof NotebookError) notebookCommandFailure(error);
  if (
    error instanceof IdempotencyKeyConflictError ||
    error instanceof KnowledgePageValidationError
  ) {
    throw commandFailure(error, 'knowledge_manager_proposal_draft_failed');
  }
  if (error instanceof KnowledgeProposalAuthorityError)
    throw new OperationError(error.code, error.message, error.status, { cause: error });
  // The proposal owner retains a fixed, safe failure for preparation; this catch cannot include shared admission or output validation.
  throw new OperationError(
    'knowledge_manager_proposal_draft_failed',
    'Knowledge Manager proposal draft failed.',
    500,
    { cause: error }
  );
}

/**
 * Records durable usage for one successful Knowledge Store gateway operation.
 *
 * @param input Knowledge operation attribution and usage source.
 */
function recordKnowledgeGatewayUsage(input: {
  /** Exact actor that authorized the workspace effect. */
  authorityActor: ActorRef;
  /** Optional Core database handle for durable workspace storage. */
  coreDb?: CoreDb;
  /** Workspace that owns the knowledge request. */
  workspaceId: string;
  /** Product capability id. */
  capabilityId: string;
  /** Durable gateway operation. */
  operation: string;
  /** Usage measurement source. */
  usageSource: string;
  /** Redacted service reference. */
  serviceRef: string;
  /** Product-safe summary. */
  summary: string;
  /** Request id used by the originating caller. */
  requestId?: string | null;
}): void {
  if (!input.coreDb) {
    return;
  }

  const workspaceDb = openWorkspaceDb(input.coreDb.dataRoot, input.workspaceId);

  try {
    applyScopedMigrations(workspaceDb);
    const call = startCapabilityCall({
      authorityActor: input.authorityActor,
      capabilityId: input.capabilityId,
      family: 'knowledge',
      operation: input.operation,
      providerRef: 'nanocore-knowledge',
      redactionClass: 'metadata-only',
      requestId: normalizeCapabilityRequestId(input.requestId) ?? randomUUID(),
      serviceRef: input.serviceRef,
      summary: input.summary,
      workspaceDb,
      workspaceId: input.workspaceId,
    });

    recordUsage({
      call,
      records: [
        {
          category: 'tool',
          providerRef: 'nanocore-knowledge',
          quantity: 1,
          source: input.usageSource,
          unit: 'capability_calls',
        },
      ],
      workspaceDb,
    });
    finishCapabilityCall({ workspaceDb, callId: call.id, status: 'succeeded' });
  } finally {
    workspaceDb.sqlite.close();
  }
}

/**
 * Maps one Knowledge Proposal command failure to the closed public vocabulary.
 *
 * @param error Caught command failure.
 * @param fallbackCode Stable fallback code for unexpected internal failures.
 * @throws The retained typed owner refusal or its bounded fallback.
 */
function knowledgeProposalCommandFailure(error: unknown, fallbackCode: string): never {
  if (error instanceof IdempotencyKeyConflictError) {
    throw commandFailure(error, fallbackCode);
  }
  if (error instanceof KnowledgeProposalAuthorityError)
    throw new OperationError(error.code, error.message, error.status, { cause: error });
  // This owner fallback reports an unproved command outcome without publishing native storage details or claiming rollback.
  throw new OperationError(fallbackCode, 'Knowledge Proposal command failed.', 500, {
    cause: error,
  });
}

/**
 * Counts exact Audit evidence for one Knowledge Proposal command.
 *
 * @param workspaceDb Workspace Audit owner.
 * @param input Exact command and actor lineage.
 * @param requireActor Whether the count requires exact actor lineage.
 * @returns Number of matching successful Audit events.
 */
function knowledgeProposalAuditCount(
  workspaceDb: WorkspaceDb,
  input: {
    /** Exact internal command action. */
    readonly action: 'knowledge.proposal.decide' | 'knowledge.proposal.reverse';
    /** Authenticated responsible actor supplied by native invocation. */
    readonly actor: ActorRef;
    /** Proposal resource named by the Audit event. */
    readonly proposalId: string;
    /** Command request identity named by the Audit event. */
    readonly requestId: string;
    /** Workspace that owns the Audit event. */
    readonly workspaceId: string;
  },
  requireActor = true
): number {
  return listWorkspaceAuditEvents(workspaceDb, input.workspaceId).filter(
    (event) =>
      event.action === input.action &&
      event.category === 'knowledge' &&
      event.outcome === 'succeeded' &&
      event.requestId === input.requestId &&
      event.resource === `knowledge-proposal:${input.proposalId}` &&
      (!requireActor ||
        (event.actor?.kind === input.actor.kind && event.actor.id === input.actor.id))
  ).length;
}

/**
 * Reads one Proposal through the authorized path Workspace without exposing foreign lineage.
 *
 * @param store Existing Proposal owner.
 * @param workspaceId Authorized path Workspace.
 * @param proposalId Addressed Proposal identity.
 * @returns Exact Proposal owned by the path Workspace.
 * @throws Uniform access denial when the Proposal is missing or belongs to another Workspace.
 */
function requireAuthorizedKnowledgeProposal(
  store: FsStore,
  workspaceId: string,
  proposalId: string
): NonNullable<ReturnType<FsStore['getKnowledgeProposal']>> {
  const proposal = store.getKnowledgeProposal(proposalId);
  if (!proposal || proposal.workspaceId !== workspaceId) {
    throw new OperationError('workspace_access_denied', 'Workspace access denied.', 403);
  }
  return proposal;
}

/** Exact typed executable join for the two Knowledge definition tables. */
type KnowledgeImplementations = Pick<
  OperationImplementations,
  Extract<
    | Exclude<keyof typeof KNOWLEDGE_OPERATION_DEFINITIONS, 'knowledge.proposal.read'>
    | keyof typeof KNOWLEDGE_ENTRY_OPERATION_DEFINITIONS,
    OperationId
  >
>;

/** Binds the current Knowledge Store, command, trace and proposal owners without a transport or second authorizer. */
export function createKnowledgeOperationImplementations(
  dependencies: Pick<
    OperationInvocationDependencies,
    | 'coreDb'
    | 'store'
    | 'inflightCommands'
    | 'repositoryWorkspaceDb'
    | 'runtimeConfigManager'
    | 'workspaceMutationAdmission'
    | 'knowledgeAgent'
  >
) {
  const store = dependencies.store!;
  const coreDb = dependencies.coreDb;
  const inflightCommands = dependencies.inflightCommands!;
  const repositoryWorkspaceDb = dependencies.repositoryWorkspaceDb!;

  /** The asking call retains delivery bytes; the separate role Turn owns inference and usage. */
  const ask = async (
    input: { workspaceId: string; question: string },
    context: AdmittedOperationContext
  ) => {
    if (!dependencies.knowledgeAgent || !coreDb)
      throw new OperationError('knowledge_unavailable', 'Knowledge Manager is unavailable.', 503);
    const db = repositoryWorkspaceDb(input.workspaceId);
    const call = startCapabilityCall({
      workspaceDb: db,
      workspaceId: input.workspaceId,
      authorityActor: context.actorRef,
      family: 'knowledge',
      operation: 'knowledge.ask',
      capabilityId: 'knowledge.ask',
      requestId: null,
      providerRef: null,
      serviceRef: 'knowledge-manager',
      redactionClass: 'metadata-only',
      summary: 'Knowledge question.',
      threadId: context.queryContext?.threadId ?? null,
      turnId: context.queryContext?.turnId ?? null,
    });
    try {
      const result = await dependencies.knowledgeAgent.ask({
        ...input,
        caller: context.delivery === 'model' ? 'internal-agent' : 'app-api',
        capabilityCallId: call.id,
        signal: context.signal ?? new AbortController().signal,
        access: {
          store,
          coreDb,
          actor: context.actorRef,
          ...(context.kind === 'worker' ? {} : { requestActor: context.actor }),
          outputThreadId: context.queryContext?.threadId,
          outputTurnId: context.queryContext?.turnId,
        },
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
  };

  /** Binds existing entry commands to current native authority and the one Git/Audit/receipt publisher. */
  const publishEntry = async (input: NotebookEntryEdit, context: AdmittedOperationContext) => {
    const dataRoot = store.getDataRoot();
    const { runtimeConfigManager, workspaceMutationAdmission } = dependencies;
    if (!coreDb || !dataRoot || !runtimeConfigManager || !workspaceMutationAdmission)
      throw new OperationError(
        'operation_storage_unavailable',
        'Notebook publication storage is unavailable.',
        503
      );
    const requestActor = publicOperationActor(context);
    const actor = context.actorRef;
    if (actor.kind !== 'user')
      throw new OperationError(
        'workspace_access_denied',
        'Notebook publication access denied.',
        403
      );
    const workspaceDb = repositoryWorkspaceDb(input.workspaceId);
    try {
      const notebook = new KnowledgeNotebook({
        repositoryPath: join(
          dataRoot,
          'workspaces',
          input.workspaceId,
          'knowledge',
          'notebook.git'
        ),
      });
      return await publishWorkspaceNotebookEntry(
        {
          store,
          workspaceDb,
          notebook,
          producer: actor,
          inflightCommands,
          revalidate: (request) =>
            readWorkspaceNotebookAdmission({
              store,
              coreDb,
              workspaceDb,
              notebook,
              request,
              requestActor,
              actor,
              runtimeConfigManager,
              workspaceMutationAdmission,
            }),
        },
        input
      );
    } catch (error) {
      notebookCommandFailure(error);
    } finally {
      workspaceDb.sqlite.close();
    }
  };

  /** Binds governed changes to the same current authority and single Git publication sequence. */
  const withGovernedNotebook = async <T>(
    request: NotebookUpdate,
    context: AdmittedOperationContext,
    run: (dependencies: NotebookPublicationDependencies) => T | Promise<T>
  ): Promise<T> => {
    const dataRoot = store.getDataRoot();
    const { runtimeConfigManager, workspaceMutationAdmission } = dependencies;
    const actor = context.actorRef;
    if (
      !coreDb ||
      !dataRoot ||
      !runtimeConfigManager ||
      !workspaceMutationAdmission ||
      actor.kind !== 'user'
    )
      throw new OperationError(
        'workspace_access_denied',
        'Notebook publication access denied.',
        403
      );
    const workspaceDb = repositoryWorkspaceDb(request.workspaceId);
    const notebook = new KnowledgeNotebook({
      repositoryPath: join(
        dataRoot,
        'workspaces',
        request.workspaceId,
        'knowledge',
        'notebook.git'
      ),
    });
    try {
      return await run({
        store,
        workspaceDb,
        notebook,
        producer: actor,
        actor,
        inflightCommands,
        revalidate: () =>
          readWorkspaceNotebookAdmission({
            store,
            coreDb,
            workspaceDb,
            notebook,
            request,
            requestActor: publicOperationActor(context),
            actor,
            runtimeConfigManager,
            workspaceMutationAdmission,
          }),
      });
    } catch (error) {
      notebookCommandFailure(error);
    } finally {
      workspaceDb.sqlite.close();
    }
  };
  /** Trusted current caller and query audience for the existing Source reader. */
  function sourceReadInput(workspaceId: string, context: AdmittedOperationContext) {
    return {
      workspaceId,
      access: {
        store,
        coreDb,
        actor: context.actorRef,
        requestActor: publicOperationActor(context),
        outputThreadId: context.queryContext?.threadId,
        outputTurnId: context.queryContext?.turnId,
      },
    };
  }

  /** Source identity and derived metadata share the same current disclosure admission. */
  function requireSourceAudience(
    workspaceId: string,
    sourceId: string,
    context: AdmittedOperationContext
  ): void {
    if (!knowledgeSourceAudienceReadable(sourceReadInput(workspaceId, context), sourceId))
      throw new OperationError('workspace_access_denied', 'Knowledge source is unavailable.', 403);
  }

  /** Source selection preserves private origin restrictions; selection itself grants no sharing authority. */
  function requireSourceReferenceAudience(
    workspaceId: string,
    references: readonly string[],
    context: AdmittedOperationContext
  ): void {
    if (!references.some((reference) => reference.startsWith('source:'))) return;
    const sources = new Map(
      store.listKnowledgeSources(workspaceId).map((source) => [source.id, source.contentDigest])
    );
    for (const reference of references) {
      if (!reference.startsWith('source:')) continue;
      const resolution = resolveRegisteredKnowledgeSourceReference(reference, sources);
      // The existing save validator retains invalid reference and digest failure semantics.
      if (!resolution.resolved || !resolution.targetId) continue;
      requireSourceAudience(workspaceId, resolution.targetId, context);
      const source = store.getKnowledgeSource(workspaceId, resolution.targetId);
      if (
        source.originatingThreadId &&
        store.getWorkspace(workspaceId).kind !== 'personal' &&
        store.getThread(workspaceId, source.originatingThreadId).visibility === 'private'
      )
        throw new OperationError(
          'workspace_access_denied',
          'Knowledge source is unavailable.',
          403
        );
    }
  }

  return {
    'knowledge.ask': ask,
    'knowledge.tell': async (input, context) => {
      if (!dependencies.knowledgeAgent)
        throw new OperationError('knowledge_unavailable', 'Knowledge Manager is unavailable.', 503);
      return dependencies.knowledgeAgent.maintain({
        workspaceId: input.workspaceId,
        requestId: input.requestId,
        instructions: 'Integrate the supplied information and keep the notebook overview current.',
        sources: input.sources,
        tellContent: input.content,
        ...(context.queryContext?.threadId
          ? { askingThreadId: context.queryContext.threadId }
          : {}),
        ...(context.queryContext?.turnId ? { askingTurnId: context.queryContext.turnId } : {}),
        trigger: 'request',
        actor: context.actorRef,
        requestActor: publicOperationActor(context),
        signal: context.signal ?? new AbortController().signal,
      });
    },
    'knowledge.maintain': async (input, context) => {
      if (!dependencies.knowledgeAgent)
        throw new OperationError('knowledge_unavailable', 'Knowledge Manager is unavailable.', 503);
      return dependencies.knowledgeAgent.maintain({
        workspaceId: input.workspaceId,
        requestId: input.requestId,
        instructions: input.instruction,
        ...(input.pageIds ? { pageIds: input.pageIds } : {}),
        sources: input.sourceIds?.map((id) => `source:${id}`) ?? [],
        trigger: 'request',
        actor: context.actorRef,
        requestActor: publicOperationActor(context),
        signal: context.signal ?? new AbortController().signal,
      });
    },
    ...createNotebookHistoryOperations(dependencies, notebookCommandFailure),
    'knowledge.notebook.update': async (input, context) => {
      const dataRoot = store.getDataRoot();
      const { runtimeConfigManager, workspaceMutationAdmission } = dependencies;
      if (!coreDb || !dataRoot || !runtimeConfigManager || !workspaceMutationAdmission)
        throw new OperationError(
          'operation_storage_unavailable',
          'Notebook publication storage is unavailable.',
          503
        );
      const requestActor = publicOperationActor(context);
      const actor = context.actorRef;
      if (actor.kind !== 'user')
        throw new OperationError(
          'workspace_access_denied',
          'Notebook publication access denied.',
          403
        );
      const workspaceDb = repositoryWorkspaceDb(input.workspaceId);
      try {
        const notebook = new KnowledgeNotebook({
          repositoryPath: join(
            dataRoot,
            'workspaces',
            input.workspaceId,
            'knowledge',
            'notebook.git'
          ),
        });
        const publication = await publishWorkspaceNotebook(
          {
            store,
            workspaceDb,
            notebook,
            producer: actor,
            inflightCommands,
            revalidate: () =>
              readWorkspaceNotebookAdmission({
                store,
                coreDb,
                workspaceDb,
                notebook,
                request: input,
                requestActor,
                actor,
                runtimeConfigManager,
                workspaceMutationAdmission,
              }),
          },
          input
        );
        return {
          ...publication,
          changedPageIds: [...publication.changedPageIds],
          receiptRef: {
            ...publication.receiptRef,
            operation: 'knowledge.notebook.update' as const,
          },
        };
      } catch (error) {
        notebookCommandFailure(error);
      } finally {
        workspaceDb.sqlite.close();
      }
    },
    'knowledge.answer': async (input, context) => {
      try {
        const result = await ask(
          { workspaceId: input.workspaceId, question: input.query },
          context
        );
        const dataRoot = store.getDataRoot();
        if (!dataRoot)
          throw new OperationError(
            'knowledge_unavailable',
            'Knowledge Manager is unavailable.',
            503
          );
        const access = {
          store,
          coreDb,
          actor: context.actorRef,
          requestActor: publicOperationActor(context),
          outputThreadId: context.queryContext?.threadId,
          outputTurnId: context.queryContext?.turnId,
        };
        const citations = result.citations.map((citation) => {
          const parsed = parseReferenceUri(citation.reference);
          const scope = parsed ? parseReferenceScope(parsed.reference.scopeId) : null;
          if (
            !parsed ||
            !scope ||
            scope.family !== 'page' ||
            scope.kind === 'user' ||
            (scope.kind === 'workspace' && scope.workspaceId !== input.workspaceId) ||
            scope.knowledgeBaseId !==
              readDefaultKnowledgeBaseId({
                dataRoot,
                scope:
                  scope.kind === 'server'
                    ? { kind: 'server' }
                    : { kind: 'workspace', workspaceId: input.workspaceId },
              }) ||
            (parsed.contentDigest !== undefined && parsed.contentDigest !== citation.contentDigest)
          )
            throw new OperationError(
              'knowledge_manager_answer_failed',
              'Knowledge Manager citation is unavailable.',
              500
            );
          const server = scope.kind === 'server';
          const { scopeId, objectId: id } = parsed.reference;
          const page = (
            server ? readAuthorizedServerNotebookPages : readAuthorizedWorkspaceNotebookPages
          )({
            dataRoot,
            workspaceId: input.workspaceId,
            access,
            notebookRevision: citation.revision,
            pageIds: [id],
          }).pages[0];
          if (!page || page.contentDigest !== citation.contentDigest)
            throw new OperationError(
              'knowledge_manager_answer_failed',
              'Knowledge Manager citation is unavailable.',
              500
            );
          const entry = parseOwnedKnowledgeEntry(page.path, page.id, page.content);
          const body = entry.content.replace(/\s+/g, ' ').trim();
          return {
            reference: { scopeId, objectId: id },
            kind: entry.kind,
            title: entry.title,
            excerpt: body.length > 240 ? `${body.slice(0, 237)}...` : body || entry.title,
          };
        });
        return KnowledgeManagerAnswerResponseSchema.parse({
          operationId: result.turnId,
          operation: 'answer',
          workspaceId: input.workspaceId,
          caller: 'app-api',
          query: input.query,
          answer: result.answer,
          citations,
          outcome: citations.length ? 'answered' : 'insufficient-evidence',
          uncertainty: result.uncertainty,
        });
      } catch (error) {
        if (error instanceof OperationError) throw error;
        throw new OperationError(
          'knowledge_manager_answer_failed',
          'Knowledge Manager answer failed.',
          500
        );
      }
    },
    'knowledge.source.list': async (input, context) => {
      const { workspaceId } = input;

      try {
        const current = sourceReadInput(workspaceId, context);
        admitKnowledgeRetrieval(current);
        const response = ListKnowledgeSourcesResponseSchema.parse({
          items: store
            .listKnowledgeSources(workspaceId)
            .filter((source) => knowledgeSourceAudienceReadable(current, source.id)),
        });
        admitKnowledgeRetrieval(current);
        return response;
      } catch (error) {
        throw commandFailure(error, 'knowledge_source_list_failed', 404);
      }
    },
    'knowledge.source.register': async (input, context) => {
      const actor = context.actorRef;
      const { workspaceId, ...commandInput } = input;

      try {
        const current = sourceReadInput(workspaceId, context);
        admitKnowledgeRetrieval(current);
        if (
          commandInput.originatingThreadId &&
          !threadReadable(current, commandInput.originatingThreadId)
        )
          throw new OperationError(
            'workspace_access_denied',
            'Knowledge source is unavailable.',
            403
          );
        const now = new Date().toISOString();
        const source = await runIdempotentCommand({
          store,
          inflightCommands,
          command: 'knowledge.source.register',
          requestId: commandInput.requestId,
          scope: { workspaceId, title: commandInput.title },
          input: { ...commandInput, workspaceId },
          responseKind: 'knowledge_source',
          execute: () =>
            store.createKnowledgeSource(
              {
                id: allocateEntityId('ks'),
                workspaceId,
                kind: commandInput.kind,
                title: commandInput.title,
                uri: commandInput.uri ?? null,
                contentDigest: `sha256:${createHash('sha256')
                  .update(commandInput.content)
                  .digest('hex')}`,
                originatingThreadId: commandInput.originatingThreadId ?? null,
                originatingTurnId: commandInput.originatingTurnId ?? null,
                originatingFileId: commandInput.originatingFileId ?? null,
                capturedAt: now,
                createdAt: now,
                updatedAt: now,
              },
              commandInput.content
            ),
          replay: (record) => store.getKnowledgeSource(workspaceId, record.response.id),
          responseId: (result) => result.id,
        });
        requireSourceAudience(workspaceId, source.id, context);
        recordKnowledgeGatewayUsage({
          authorityActor: actor,
          capabilityId: 'knowledge.source.register',
          operation: 'knowledge.source.register',
          requestId: commandInput.requestId,
          serviceRef: 'knowledge-store',
          summary: `Knowledge source ${source.id} registered.`,
          usageSource: 'knowledge-source-register',
          workspaceId,
          ...(coreDb ? { coreDb: coreDb } : {}),
        });

        const response = RegisterKnowledgeSourceResponseSchema.parse({
          source,
          derivedRepresentations: store.listKnowledgeSourceDerivedRepresentations(
            workspaceId,
            source.id
          ),
        });
        requireSourceAudience(workspaceId, source.id, context);
        return response;
      } catch (error) {
        throw commandFailure(error, 'knowledge_source_register_failed');
      }
    },
    'knowledge.source.read': async (input, context) => {
      const actor = context.actorRef;
      const { workspaceId, sourceId } = input;

      try {
        requireSourceAudience(workspaceId, sourceId, context);
        const source = readAuthorizedKnowledgeOwner(workspaceId, () =>
          store.getKnowledgeSource(workspaceId, sourceId)
        );
        requireSourceAudience(workspaceId, sourceId, context);
        const response = ReadKnowledgeSourceResponseSchema.parse({
          source,
          derivedRepresentations: store.listKnowledgeSourceDerivedRepresentations(
            workspaceId,
            sourceId
          ),
        });
        recordKnowledgeGatewayUsage({
          authorityActor: actor,
          capabilityId: 'knowledge.source.read',
          operation: 'knowledge.source.read',
          serviceRef: 'knowledge-store',
          summary: `Knowledge source ${sourceId} read.`,
          usageSource: 'knowledge-source-read',
          workspaceId,
          ...(coreDb ? { coreDb: coreDb } : {}),
        });

        // Derived metadata and its usage accounting must not outlive current disclosure authority.
        requireSourceAudience(workspaceId, sourceId, context);
        return response;
      } catch (error) {
        if (error instanceof OperationError) throw error;
        throw commandFailure(error, 'knowledge_source_not_found', 404);
      }
    },
    'knowledge.observation.list': async (input, _context) => {
      const { workspaceId } = input;

      try {
        return ListKnowledgeObservationsResponseSchema.parse({
          items: store.listKnowledgeObservations(workspaceId),
        });
      } catch (error) {
        throw commandFailure(error, 'knowledge_observation_list_failed', 404);
      }
    },
    'knowledge.observation.record': async (input, context) => {
      const actor = context.actorRef;
      const { workspaceId, ...commandInput } = input;

      try {
        const now = new Date().toISOString();
        const observedAt = commandInput.observedAt ?? now;
        const observation = await runIdempotentCommand({
          store,
          inflightCommands,
          command: 'knowledge.observation.record',
          requestId: commandInput.requestId,
          scope: { workspaceId, summary: commandInput.summary },
          input: { ...commandInput, workspaceId },
          responseKind: 'knowledge_observation',
          execute: () =>
            store.recordKnowledgeObservation({
              id: allocateEntityId('ko'),
              workspaceId,
              kind: commandInput.kind,
              summary: commandInput.summary,
              sourceReferences: commandInput.sourceReferences,
              scope: commandInput.scope,
              producer: commandInput.producer,
              confidence: commandInput.confidence,
              freshness: commandInput.freshness,
              status: commandInput.status,
              observedAt,
              createdAt: now,
            }),
          replay: (record) => store.getKnowledgeObservation(workspaceId, record.response.id),
          responseId: (result) => result.id,
        });
        recordKnowledgeGatewayUsage({
          authorityActor: actor,
          capabilityId: 'knowledge.observation.record',
          operation: 'knowledge.observation.record',
          requestId: commandInput.requestId,
          serviceRef: 'knowledge-store',
          summary: `Knowledge observation ${observation.id} recorded.`,
          usageSource: 'knowledge-observation-record',
          workspaceId,
          ...(coreDb ? { coreDb: coreDb } : {}),
        });

        return RecordKnowledgeObservationResponseSchema.parse({ observation });
      } catch (error) {
        throw commandFailure(error, 'knowledge_observation_record_failed');
      }
    },
    'knowledge.claim.list': async (input, _context) => {
      const { workspaceId } = input;

      try {
        return ListKnowledgeClaimsResponseSchema.parse({
          items: store.listKnowledgeClaims(workspaceId),
        });
      } catch (error) {
        throw commandFailure(error, 'knowledge_claim_list_failed', 404);
      }
    },
    'knowledge.claim.record': async (input, context) => {
      const actor = context.actorRef;
      const { workspaceId, ...commandInput } = input;

      try {
        const now = new Date().toISOString();
        const claim = await runIdempotentCommand({
          store,
          inflightCommands,
          command: 'knowledge.claim.record',
          requestId: commandInput.requestId,
          scope: { workspaceId, statement: commandInput.statement },
          input: { ...commandInput, workspaceId },
          responseKind: 'knowledge_claim',
          execute: () =>
            store.recordKnowledgeClaim({
              id: allocateEntityId('kc'),
              workspaceId,
              statement: commandInput.statement,
              sourceReferences: commandInput.sourceReferences,
              scope: commandInput.scope,
              producer: commandInput.producer,
              confidence: commandInput.confidence,
              freshness: commandInput.freshness,
              reviewState: commandInput.reviewState,
              conflictStatus: commandInput.conflictStatus,
              createdAt: now,
              updatedAt: now,
            }),
          replay: (record) => store.getKnowledgeClaim(workspaceId, record.response.id),
          responseId: (result) => result.id,
        });
        recordKnowledgeGatewayUsage({
          authorityActor: actor,
          capabilityId: 'knowledge.claim.record',
          operation: 'knowledge.claim.record',
          requestId: commandInput.requestId,
          serviceRef: 'knowledge-store',
          summary: `Knowledge claim ${claim.id} recorded.`,
          usageSource: 'knowledge-claim-record',
          workspaceId,
          ...(coreDb ? { coreDb: coreDb } : {}),
        });

        return RecordKnowledgeClaimResponseSchema.parse({ claim });
      } catch (error) {
        throw commandFailure(error, 'knowledge_claim_record_failed');
      }
    },
    'knowledge.conflict.list': async (input, _context) => {
      const { workspaceId } = input;

      try {
        return ListKnowledgeConflictsResponseSchema.parse({
          items: store.listKnowledgeConflicts(workspaceId),
        });
      } catch (error) {
        throw commandFailure(error, 'knowledge_conflict_list_failed', 404);
      }
    },
    'knowledge.conflict.record': async (input, context) => {
      const actor = context.actorRef;
      const { workspaceId, ...commandInput } = input;

      try {
        const now = new Date().toISOString();
        const conflict = await runIdempotentCommand({
          store,
          inflightCommands,
          command: 'knowledge.conflict.record',
          requestId: commandInput.requestId,
          scope: { workspaceId, summary: commandInput.summary },
          input: { ...commandInput, workspaceId },
          responseKind: 'knowledge_conflict',
          execute: () =>
            store.recordKnowledgeConflict({
              id: allocateEntityId('kf'),
              workspaceId,
              subjectReferences: commandInput.subjectReferences,
              sourceReferences: commandInput.sourceReferences,
              status: commandInput.status,
              summary: commandInput.summary,
              suggestedActions: commandInput.suggestedActions,
              producer: commandInput.producer,
              createdAt: now,
              updatedAt: now,
            }),
          replay: (record) => store.getKnowledgeConflict(workspaceId, record.response.id),
          responseId: (result) => result.id,
        });
        recordKnowledgeGatewayUsage({
          authorityActor: actor,
          capabilityId: 'knowledge.conflict.record',
          operation: 'knowledge.conflict.record',
          requestId: commandInput.requestId,
          serviceRef: 'knowledge-store',
          summary: `Knowledge conflict ${conflict.id} recorded.`,
          usageSource: 'knowledge-conflict-record',
          workspaceId,
          ...(coreDb ? { coreDb: coreDb } : {}),
        });

        return RecordKnowledgeConflictResponseSchema.parse({ conflict });
      } catch (error) {
        throw commandFailure(error, 'knowledge_conflict_record_failed');
      }
    },
    'knowledge.conflict.resolve': async (input, context) => {
      const actor = context.actorRef;
      const { workspaceId, conflictId, ...commandInput } = input;

      try {
        readAuthorizedKnowledgeOwner(workspaceId, () =>
          store.getKnowledgeConflict(workspaceId, conflictId)
        );
        const now = new Date().toISOString();
        const conflict = await runIdempotentCommand({
          store,
          inflightCommands,
          command: 'knowledge.conflict.resolve',
          requestId: commandInput.requestId,
          scope: { workspaceId, conflictId },
          input: { ...commandInput, workspaceId, conflictId },
          responseKind: 'knowledge_conflict',
          execute: () =>
            store.resolveKnowledgeConflict({
              workspaceId,
              conflictId,
              status: commandInput.status,
              resolution: commandInput.resolution,
              resolvedBy: commandInput.resolvedBy,
              resolvedAt: now,
            }),
          replay: (record) => store.getKnowledgeConflict(workspaceId, record.response.id),
          responseId: (result) => result.id,
        });
        recordKnowledgeGatewayUsage({
          authorityActor: actor,
          capabilityId: 'knowledge.conflict.resolve',
          operation: 'knowledge.conflict.resolve',
          requestId: commandInput.requestId,
          serviceRef: 'knowledge-store',
          summary: `Knowledge conflict ${conflict.id} resolved.`,
          usageSource: 'knowledge-conflict-resolve',
          workspaceId,
          ...(coreDb ? { coreDb: coreDb } : {}),
        });

        return ResolveKnowledgeConflictResponseSchema.parse({ conflict });
      } catch (error) {
        if (error instanceof OperationError) throw error;
        throw commandFailure(error, 'knowledge_conflict_resolve_failed');
      }
    },
    'knowledge.indexes': async (input, _context) => {
      const { workspaceId } = input;

      try {
        const dataRoot = store.getDataRoot();

        if (!dataRoot) {
          throw new OperationError(
            'data_root_required',
            'Knowledge indexes require a file-backed data root.',
            409
          );
        }

        return KnowledgeDerivedIndexesResponseSchema.parse(
          readWorkspaceKnowledgeDerivedIndexes({
            dataRoot,
            workspaceId: workspaceId,
          })
        );
      } catch (error) {
        if (error instanceof OperationError) throw error;
        throw commandFailure(error, 'knowledge_indexes_read_failed', 404);
      }
    },
    'knowledge.retrieval': async (input, context) => {
      const actor = context.actorRef;
      const { workspaceId, ...commandInput } = input;

      try {
        const dataRoot = store.getDataRoot();

        if (!dataRoot) {
          throw new OperationError(
            'data_root_required',
            'Knowledge retrieval requires a file-backed data root.',
            409
          );
        }

        const response = KnowledgeRetrievalResponseSchema.parse(
          await retrieveWorkspaceKnowledge({
            dataRoot,
            workspaceId,
            caller: 'app-api',
            query: commandInput.query,
            limit: commandInput.limit,
            pinnedReferences: commandInput.pinnedReferences,
            sourceScope: commandInput.sourceScope,
            states: commandInput.states,
            access: {
              store,
              coreDb,
              actor: context.actorRef,
              requestActor: publicOperationActor(context),
              outputThreadId: context.queryContext?.threadId,
              outputTurnId: context.queryContext?.turnId,
            },
            traceId: allocateEntityId('krt'),
          })
        );
        recordKnowledgeGatewayUsage({
          authorityActor: actor,
          capabilityId: 'knowledge.retrieval',
          operation: 'knowledge.retrieval',
          serviceRef: 'knowledge-store',
          summary: `Knowledge retrieval selected ${response.selected.length} candidates.`,
          usageSource: 'knowledge-retrieval',
          workspaceId,
          ...(coreDb ? { coreDb: coreDb } : {}),
        });

        return response;
      } catch (error) {
        if (error instanceof OperationError) throw error;
        throw new OperationError('knowledge_retrieval_failed', 'Knowledge retrieval failed.', 500);
      }
    },
    'knowledge.context.prepare': async (input, context) => {
      const actor = context.actorRef;
      const { workspaceId, ...commandInput } = input;

      try {
        const dataRoot = store.getDataRoot();

        if (!dataRoot) {
          throw new Error('Knowledge Manager context requires a file-backed data root.');
        }

        const response = await prepareKnowledgeContext({
          dataRoot,
          operationId: `km_context_${randomUUID()}`,
          workspaceId,
          caller: 'app-api',
          query: commandInput.query,
          limit: commandInput.limit,
          access: {
            store,
            coreDb,
            actor: context.actorRef,
            requestActor: publicOperationActor(context),
            outputThreadId: context.queryContext?.threadId,
            outputTurnId: context.queryContext?.turnId,
          },
        });
        recordKnowledgeGatewayUsage({
          authorityActor: actor,
          capabilityId: 'knowledge.context.prepare',
          operation: 'knowledge.context.prepare',
          serviceRef: 'knowledge-manager',
          summary: `Knowledge context selected ${response.selected.length} knowledge entries.`,
          usageSource: 'knowledge-context-prepare',
          workspaceId,
          ...(coreDb ? { coreDb: coreDb } : {}),
        });

        return KnowledgeManagerPrepareContextResponseSchema.parse(response);
      } catch {
        throw new OperationError(
          'knowledge_manager_context_failed',
          'Knowledge Manager context preparation failed.',
          500
        );
      }
    },
    'knowledge.proposal.draft': async (input, context) => {
      const actor = context.actorRef;
      const { workspaceId, ...commandInput } = input;

      try {
        const producer: ActorRef = actor;
        const proposalId = knowledgeAuthorityId('kp_', {
          workspaceId,
          requestId: commandInput.requestId,
        });
        const scope = { workspaceId };
        const workspaceDb = coreDb ? repositoryWorkspaceDb(workspaceId) : undefined;
        let proposal: ReturnType<FsStore['createKnowledgeProposal']>;
        let generatedFromCompletedWorkHistory: boolean;
        try {
          const existingReceipt = store.getCommandRequest(
            'knowledge.proposal.draft',
            commandInput.requestId,
            scope,
            workspaceDb
          );
          if (!existingReceipt && store.getKnowledgeProposal(proposalId)) {
            throw knowledgeProposalAuthorityFailure('recovery_required');
          }

          proposal = await runIdempotentCommand({
            store,
            inflightCommands,
            command: 'knowledge.proposal.draft',
            requestId: commandInput.requestId,
            scope,
            input: { ...commandInput, producer },
            responseKind: 'knowledge_proposal',
            ...(workspaceDb ? { workspaceDb } : {}),
            execute: async () => {
              const executionVerification = verifyKnowledgeProposalWorkHistory({
                coreDb,
                sourceReferences: commandInput.sourceReferences,
                store,
                workspaceDb,
                workspaceId,
              });
              await withGovernedNotebook(
                {
                  workspaceId,
                  requestId: commandInput.requestId,
                  baseRevision: commandInput.baseRevision,
                  changes: [
                    {
                      path: `${commandInput.knowledgePageId}.md`,
                      content: commandInput.canonicalPageBytes,
                    },
                  ],
                  summary: commandInput.rationale,
                },
                context,
                (owner) => {
                  owner.revalidate();
                }
              );
              return store.createKnowledgeProposal({
                ...commandInput,
                workspaceId,
                producer,
                createdAt: new Date().toISOString(),
                verifiedExternalReferences: executionVerification.verifiedExternalReferences,
              });
            },
            replay: (record) => {
              if (
                record.response.kind !== 'knowledge_proposal' ||
                record.response.id !== proposalId
              ) {
                throw knowledgeProposalAuthorityFailure('recovery_required');
              }
              const replayed = store.projectKnowledgeProposalDraft(workspaceId, record.response.id);
              if (
                replayed.id !== proposalId ||
                replayed.workspaceId !== workspaceId ||
                replayed.operation !== 'notebook-change' ||
                replayed.baseRevision !== commandInput.baseRevision ||
                replayed.knowledgePageId !== commandInput.knowledgePageId ||
                replayed.canonicalPageBytes !== commandInput.canonicalPageBytes ||
                replayed.contentDigest !== commandInput.contentDigest ||
                JSON.stringify(replayed.sourceReferences) !==
                  JSON.stringify(commandInput.sourceReferences) ||
                replayed.rationale !== commandInput.rationale ||
                replayed.confidence !== commandInput.confidence ||
                JSON.stringify(replayed.producer) !== JSON.stringify(producer)
              ) {
                throw knowledgeProposalAuthorityFailure('recovery_required');
              }
              return replayed;
            },
            responseId: (result) => result.id,
          });
          await withGovernedNotebook(
            {
              workspaceId,
              requestId: commandInput.requestId,
              baseRevision: proposal.baseRevision,
              changes: proposal.changes ?? [
                { path: `${proposal.knowledgePageId}.md`, content: proposal.canonicalPageBytes! },
              ],
              summary: proposal.rationale,
            },
            context,
            (owner) => {
              owner.revalidate();
            }
          );
          const completedWorkReferences = proposal.sourceReferences.filter((reference) =>
            /^(?:turn|item|context-package):/.test(reference)
          );
          generatedFromCompletedWorkHistory =
            completedWorkReferences.length === 3 &&
            ['turn:', 'item:', 'context-package:'].every(
              (prefix) =>
                completedWorkReferences.filter((reference) => reference.startsWith(prefix))
                  .length === 1
            );
        } finally {
          workspaceDb?.sqlite.close();
        }
        const response = draftKnowledgeProposal({
          operationId: `km_proposal_${randomUUID()}`,
          workspaceId,
          caller: 'app-api',
          proposal,
          generatedFromCompletedWorkHistory,
        });
        recordKnowledgeGatewayUsage({
          authorityActor: actor,
          capabilityId: 'knowledge.proposal.draft',
          operation: 'knowledge.proposal.draft',
          requestId: commandInput.requestId,
          serviceRef: 'knowledge-manager',
          summary: `Knowledge proposal ${proposal.id} drafted.`,
          usageSource: 'knowledge-proposal-draft',
          workspaceId,
          ...(coreDb ? { coreDb: coreDb } : {}),
        });

        return KnowledgeManagerDraftProposalResponseSchema.parse(response);
      } catch (error) {
        return knowledgeProposalDraftFailure(error);
      }
    },
    'knowledge.repair.suggest': async (input, context) => {
      const actor = context.actorRef;
      const { workspaceId, ...commandInput } = input;

      try {
        const response = suggestKnowledgeRepairs({
          operationId: `km_repair_${randomUUID()}`,
          workspaceId,
          caller: 'app-api',
          entries: store.listKnowledge(workspaceId),
          limit: commandInput.limit,
        });
        recordKnowledgeGatewayUsage({
          authorityActor: actor,
          capabilityId: 'knowledge.repair.suggest',
          operation: 'knowledge.repair.suggest',
          serviceRef: 'knowledge-manager',
          summary: `Knowledge repair suggestions returned ${response.suggestions.length} suggestions.`,
          usageSource: 'knowledge-repair-suggest',
          workspaceId,
          ...(coreDb ? { coreDb: coreDb } : {}),
        });

        return KnowledgeManagerSuggestRepairResponseSchema.parse(response);
      } catch {
        throw new OperationError(
          'knowledge_manager_repair_suggest_failed',
          'Knowledge Manager repair suggestion failed.',
          500
        );
      }
    },
    'knowledge.health.check': async (input, context) => {
      const actor = context.actorRef;
      const { workspaceId, ...commandInput } = input;

      try {
        const response = checkKnowledgeHealth({
          operationId: `km_health_${randomUUID()}`,
          workspaceId,
          caller: 'app-api',
          entries: store.listKnowledge(workspaceId),
          limit: commandInput.limit,
        });
        recordKnowledgeGatewayUsage({
          authorityActor: actor,
          capabilityId: 'knowledge.health.check',
          operation: 'knowledge.health.check',
          serviceRef: 'knowledge-manager',
          summary: `Knowledge health completed with ${response.checks.length} checks.`,
          usageSource: 'knowledge-health-check',
          workspaceId,
          ...(coreDb ? { coreDb: coreDb } : {}),
        });

        return KnowledgeManagerHealthCheckResponseSchema.parse(response);
      } catch {
        throw new OperationError(
          'knowledge_manager_health_check_failed',
          'Knowledge Manager health check failed.',
          500
        );
      }
    },
    'knowledge.proposal.decide': async (input, context) => {
      const { workspaceId, proposalId, ...commandInput } = input;
      const proposal = requireAuthorizedKnowledgeProposal(store, workspaceId, proposalId);
      const request: NotebookUpdate = {
        workspaceId,
        requestId: commandInput.requestId,
        baseRevision: commandInput.baseRevision,
        changes: proposal.changes ?? [
          { path: `${proposal.knowledgePageId}.md`, content: proposal.canonicalPageBytes! },
        ],
        summary: proposal.rationale,
      };
      return withGovernedNotebook(request, context, async (owner) => {
        const reviewId = deriveEntityId('kr', {
          ownerScope: { kind: 'workspace', workspaceId },
          proposalId,
          requestId: commandInput.requestId,
        });
        const commandScope = { workspaceId, actorId: context.actorRef.id };
        const receipt = store.getCommandRequest(
          'knowledge.proposal.decide',
          commandInput.requestId,
          commandScope,
          owner.workspaceDb
        );
        const inflight = inflightCommands
          .get(store)
          ?.get(
            commandRequestKey('knowledge.proposal.decide', commandInput.requestId, commandScope)
          );
        if (
          (receipt && receipt.inputHash !== commandInputHash(input)) ||
          (inflight && inflight.inputHash !== commandInputHash(input))
        )
          throw new IdempotencyKeyConflictError();
        // A retained terminal decision without completion evidence requires inspection, not resumption.
        if (
          !receipt &&
          !inflight &&
          store
            .listKnowledgeProposalReviewDecisions(workspaceId)
            .some((review) => review.reviewId === reviewId)
        )
          throw new NotebookError('recovery_required');
        const current = () => {
          if (
            !coreDb ||
            !isWorkspaceOperationAuthorized(coreDb, publicOperationActor(context), workspaceId, {
              mutating: true,
              policyOperation: 'review.apply',
            })
          )
            throw new OperationError(
              'workspace_access_denied',
              'Knowledge Review access denied.',
              403
            );
          const saved = store.projectKnowledgeProposalDraft(workspaceId, proposalId);
          if (
            saved.baseRevision !== commandInput.baseRevision ||
            saved.candidateRevision !== commandInput.candidateRevision ||
            store.knowledgeProposalDigest(workspaceId, proposalId) !== commandInput.proposalDigest
          )
            throw new NotebookError('conflict');
          return owner.revalidate();
        };
        current();
        const recordDecision = () =>
          store.recordKnowledgeProposalReviewDecision({
            ...commandInput,
            workspaceId,
            proposalId,
            actor: context.actorRef,
            decidedAt: new Date().toISOString(),
            verifiedExternalReferences: verifyKnowledgeProposalWorkHistory({
              coreDb,
              store,
              workspaceDb: owner.workspaceDb,
              workspaceId,
              sourceReferences: proposal.sourceReferences,
            }).verifiedExternalReferences,
          });
        if (commandInput.decision === 'accepted') {
          await publishWorkspaceNotebook(
            {
              ...owner,
              command: { name: 'knowledge.proposal.decide', input },
              producer: proposal.producer,
              revalidate: current,
              reviewedCandidate: {
                proposalId,
                candidateRevision: proposal.candidateRevision,
                recordDecision,
              },
            },
            request
          );
          return store.projectKnowledgeProposalDecision(workspaceId, reviewId);
        }
        return runIdempotentCommand({
          store,
          workspaceDb: owner.workspaceDb,
          inflightCommands,
          command: 'knowledge.proposal.decide',
          requestId: commandInput.requestId,
          scope: { workspaceId, actorId: context.actorRef.id },
          input,
          responseKind: 'knowledge_proposal_review',
          responseId: (result) => result.review.reviewId,
          execute: () => {
            current();
            const result = recordDecision();
            recordWorkspaceAuditEvent({
              workspaceDb: owner.workspaceDb,
              workspaceId,
              requestId: commandInput.requestId,
              actor: context.actorRef,
              category: 'knowledge',
              action: 'knowledge.proposal.decide',
              outcome: 'succeeded',
              resource: `knowledge-proposal:${proposalId}`,
              summary: 'Knowledge proposal decision recorded.',
            });
            return result;
          },
          replay: (receipt) => {
            current();
            if (
              receipt.response.id !== reviewId ||
              knowledgeProposalAuditCount(owner.workspaceDb, {
                workspaceId,
                proposalId,
                requestId: commandInput.requestId,
                actor: context.actorRef,
                action: 'knowledge.proposal.decide',
              }) !== 1
            )
              throw new NotebookError('recovery_required');
            return store.projectKnowledgeProposalDecision(workspaceId, reviewId);
          },
        });
      });
    },
    'knowledge.proposal.reverse': async (input, context) => {
      try {
        const { workspaceId, proposalId } = input;
        const proposal = requireAuthorizedKnowledgeProposal(store, workspaceId, proposalId);
        // A completed request owns its original input before later content conflict checks.
        const receipt =
          context.actorRef.kind === 'user'
            ? store.getCommandRequest('knowledge.proposal.reverse', input.requestId, {
                workspaceId,
                actorId: context.actorRef.id,
              })
            : null;
        if (receipt && receipt.inputHash !== commandInputHash(input))
          throw new IdempotencyKeyConflictError();
        store.projectKnowledgeProposalDraft(workspaceId, proposalId);
        const decision = store.projectKnowledgeProposalDecision(workspaceId, input.reviewId);
        if (
          decision.review.proposalId !== proposalId ||
          decision.review.decision !== 'accepted' ||
          (proposal.changes
            ? !proposal.changes.some((change) => change.path === `${input.knowledgePageId}.md`)
            : input.knowledgePageId !== proposal.knowledgePageId) ||
          input.expectedContentDigest !== proposal.contentDigest
        )
          throw new OperationError(
            'conflict',
            'Knowledge reversal conflicts with its Review.',
            409
          );
        // Restore only the selected path from the original base; keep every unrelated current path.
        const dataRoot = store.getDataRoot();
        if (!dataRoot)
          throw new OperationError('recovery_required', 'Notebook storage is unavailable.', 503);
        const notebook = new KnowledgeNotebook({
          repositoryPath: join(dataRoot, 'workspaces', workspaceId, 'knowledge', 'notebook.git'),
        });
        const path = `${input.knowledgePageId}.md`;
        const original = notebook.readRevision(proposal.baseRevision).files[path] ?? null;
        const baseBytes = notebook.readRevision(input.baseRevision).files[path];
        const candidateBytes = proposal.changes
          ? proposal.changes.find((change) => change.path === path)!.content
          : proposal.canonicalPageBytes;
        if ((baseBytes ?? null) !== candidateBytes)
          throw new OperationError('conflict', 'Knowledge page changed after Review.', 409);
        const request: NotebookUpdate = {
          workspaceId,
          requestId: input.requestId,
          baseRevision: input.baseRevision,
          changes: [{ path, content: original }],
          summary: 'Reverse reviewed Knowledge change',
        };
        return withGovernedNotebook(request, context, async (owner) => {
          const publication = await publishWorkspaceNotebook(
            {
              ...owner,
              command: { name: 'knowledge.proposal.reverse', input },
              ...(original === null && baseBytes !== undefined && input.confirmRemoval
                ? { confirmedRemovals: { [path]: baseBytes } }
                : {}),
            },
            request
          );
          const content = owner.notebook.readRevision(publication.notebookRevision).files[path];
          return ReverseKnowledgeProposalResponseSchema.parse({
            proposalId,
            reviewId: input.reviewId,
            application: {
              knowledgePageId: input.knowledgePageId,
              contentDigest:
                content === undefined
                  ? proposal.contentDigest
                  : `sha256:${createHash('sha256').update(content).digest('hex')}`,
              present: content !== undefined,
              notebookRevision: publication.notebookRevision,
            },
          });
        });
      } catch (error) {
        notebookCommandFailure(error);
      }
    },
    'knowledge.list': async (input, context) => {
      const { workspaceId } = input;

      try {
        const dataRoot = store.getDataRoot();
        if (!dataRoot)
          throw new OperationError(
            'operation_storage_unavailable',
            'Notebook storage is unavailable.',
            503
          );
        const snapshot = readAuthorizedWorkspaceNotebookPages({
          dataRoot,
          workspaceId,
          access: {
            store,
            coreDb,
            actor: context.actorRef,
            requestActor: publicOperationActor(context),
            outputThreadId: context.queryContext?.threadId,
            outputTurnId: context.queryContext?.turnId,
          },
        });
        return ListKnowledgeEntriesResponseSchema.parse({
          knowledgeBaseId: readDefaultKnowledgeBaseId({
            dataRoot,
            scope: { kind: 'workspace', workspaceId },
          }),
          notebookRevision: snapshot.notebookRevision,
          items: snapshot.pages.map(({ path, id, content }) => ({
            ...parseOwnedKnowledgeEntry(path, id, content),
            contentDigest: `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`,
          })),
        });
      } catch (error) {
        throw commandFailure(error, 'not_found');
      }
    },
    'knowledge.create': async (input, context) => {
      const actor = context.actorRef;
      const { workspaceId, ...commandInput } = input;

      try {
        requireSourceReferenceAudience(workspaceId, commandInput.sourceReferences ?? [], context);
        const knowledge = await publishEntry({ ...input, operation: 'knowledge.create' }, context);
        requireSourceReferenceAudience(workspaceId, knowledge.sourceReferences ?? [], context);
        recordKnowledgeGatewayUsage({
          authorityActor: actor,
          capabilityId: 'knowledge.entry.create',
          operation: 'knowledge.entry.create',
          requestId: commandInput.requestId,
          serviceRef: 'knowledge-store',
          summary: `Knowledge entry ${knowledge.id} created.`,
          usageSource: 'knowledge-entry-create',
          workspaceId,
          ...(coreDb ? { coreDb: coreDb } : {}),
        });

        return knowledge;
      } catch (error) {
        throw commandFailure(error, 'knowledge_create_failed');
      }
    },
    'knowledge.update': async (input, context) => {
      const actor = context.actorRef;
      const { workspaceId, ...commandInput } = input;

      try {
        // The publisher rechecks the fixed candidate's Sources before replay; a later removal must not hide its completed result.
        const knowledge = await publishEntry({ ...input, operation: 'knowledge.update' }, context);
        requireSourceReferenceAudience(workspaceId, knowledge.sourceReferences ?? [], context);
        recordKnowledgeGatewayUsage({
          authorityActor: actor,
          capabilityId: 'knowledge.entry.update',
          operation: 'knowledge.entry.update',
          requestId: commandInput.requestId,
          serviceRef: 'knowledge-store',
          summary: `Knowledge entry ${knowledge.id} updated.`,
          usageSource: 'knowledge-entry-update',
          workspaceId,
          ...(coreDb ? { coreDb: coreDb } : {}),
        });

        return knowledge;
      } catch (error) {
        throw commandFailure(error, 'knowledge_update_failed');
      }
    },
    'knowledge.delete': async (input, context) => {
      const actor = context.actorRef;
      const { workspaceId, knowledgeEntryId, ...commandInput } = input;

      try {
        const dataRoot = store.getDataRoot();
        if (!dataRoot)
          throw new OperationError('recovery_required', 'Notebook storage is unavailable.', 503);
        const notebook = new KnowledgeNotebook({
          repositoryPath: join(dataRoot, 'workspaces', workspaceId, 'knowledge', 'notebook.git'),
        });
        const path = `${knowledgeEntryId}.md`;
        const content = notebook.readRevision(commandInput.baseRevision).files[path];
        if (
          content === undefined ||
          `sha256:${createHash('sha256').update(content).digest('hex')}` !==
            commandInput.expectedContentDigest
        )
          throw new OperationError(
            'conflict',
            'Knowledge removal conflicts with its fixed base.',
            409
          );
        const request: NotebookUpdate = {
          workspaceId,
          requestId: commandInput.requestId,
          baseRevision: commandInput.baseRevision,
          changes: [{ path, content: null }],
          summary: 'Explicit Knowledge removal; Git history retained',
        };
        await withGovernedNotebook(request, context, (owner) =>
          publishWorkspaceNotebook(
            {
              ...owner,
              command: { name: 'knowledge.delete', input },
              confirmedRemovals: { [path]: content },
            },
            request
          )
        );
        recordKnowledgeGatewayUsage({
          authorityActor: actor,
          capabilityId: 'knowledge.entry.delete',
          operation: 'knowledge.entry.delete',
          requestId: commandInput.requestId,
          serviceRef: 'knowledge-store',
          summary: `Knowledge entry ${knowledgeEntryId} deleted.`,
          usageSource: 'knowledge-entry-delete',
          workspaceId,
          ...(coreDb ? { coreDb: coreDb } : {}),
        });

        return null;
      } catch (error) {
        if (error instanceof NotebookError) notebookCommandFailure(error);
        throw commandFailure(error, 'knowledge_delete_failed');
      }
    },
  } satisfies KnowledgeImplementations;
}

/** Knowledge-owned private Task entry shares public preparation's parsing, knowledge.read admission and retrieval owner. */
export function createTaskKnowledgePreparation(
  dependencies: Pick<
    OperationInvocationDependencies,
    'store' | 'coreDb' | 'repositoryWorkspaceDb' | 'workspaceMutationAdmission'
  >
) {
  return async (
    value: unknown,
    context: {
      readonly actor: import('./auth/identity.js').Actor;
      readonly traceId: string;
      readonly threadId: string;
      readonly turnId?: string;
    }
  ): Promise<import('./knowledge-manager.js').PreparedTaskKnowledgeContext> => {
    const admitted = admitOperation(
      KNOWLEDGE_OPERATION_DEFINITIONS['knowledge.context.prepare'],
      value,
      { kind: 'public', actor: context.actor, delivery: 'model' },
      dependencies
    );
    try {
      const dataRoot = dependencies.store?.getDataRoot();
      if (!dataRoot)
        throw new OperationError(
          'knowledge_context_unavailable',
          'Task Knowledge retrieval requires file-backed storage.',
          503
        );
      if (admitted.context.kind === 'bootstrap')
        throw new OperationError(
          'workspace_access_denied',
          'Knowledge retrieval access denied.',
          403
        );
      const input =
        admitted.input as import('@openkit/app-api-schemas').OperationInput<'knowledge.context.prepare'>;
      const output = await prepareTaskKnowledgeContext({
        dataRoot,
        workspaceId: input.workspaceId,
        query: input.query,
        traceId: context.traceId,
        access: {
          store: dependencies.store!,
          coreDb: dependencies.coreDb,
          actor: admitted.context.actorRef,
          requestActor: context.actor,
          outputThreadId: context.threadId,
          outputTurnId: context.turnId,
        },
      });
      const validated = KNOWLEDGE_OPERATION_DEFINITIONS['knowledge.context.prepare'].outputSchema
        .pick({ retrievalTraceRef: true })
        .required({ retrievalTraceRef: true })
        .safeParse(output);
      if (!validated.success)
        throw new OperationError(
          'invalid_operation_output',
          'Task Knowledge preparation output is invalid. Inspect the effect outcome; output validation does not undo committed effects.',
          500
        );
      return validated.data;
    } finally {
      admitted.release?.();
    }
  };
}
