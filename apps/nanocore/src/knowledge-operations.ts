import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type {
  KNOWLEDGE_NOTEBOOK_OPERATION_DEFINITIONS,
  OperationId,
  PreviewKnowledgeSchemaRequest,
} from '@openkit/app-api-schemas';
import {
  KNOWLEDGE_OPERATION_DEFINITIONS,
  KnowledgeDerivedIndexesResponseSchema,
  KnowledgeManagerAnswerResponseSchema,
  KnowledgeManagerDraftProposalResponseSchema,
  KnowledgeManagerHealthCheckResponseSchema,
  KnowledgeManagerPrepareContextResponseSchema,
  KnowledgeManagerSuggestRepairResponseSchema,
  KnowledgeRetrievalResponseSchema,
  ListKnowledgeNotebookResponseSchema,
  ListKnowledgeSourcesResponseSchema,
  ReadKnowledgeSourceResponseSchema,
  RegisterKnowledgeSourceResponseSchema,
  ReverseKnowledgeProposalResponseSchema,
} from '@openkit/app-api-schemas';
import {
  type ActorRef,
  allocateEntityId,
  canonicalJsonText,
  deriveEntityId,
  parseReferenceScope,
  parseReferenceUri,
} from '@openkit/protocol';
import { z } from 'zod';
import { publishedErrorMessage } from './api-errors.js';
import { listWorkspaceAuditEvents, prepareAuditEvent } from './audit-events.js';
import { isWorkspaceOperationAuthorized } from './auth/operation-authorizer.js';
import {
  finishCapabilityCall,
  normalizeCapabilityRequestId,
  recordUsage,
  startCapabilityCall,
} from './capability/usage-ledger.js';
import { readDefaultKnowledgeBaseId } from './config/knowledge-base.js';
import { createKnowledgeAgentOperations } from './knowledge/knowledge-agent-operations.js';
import { NotebookError } from './knowledge/notebook.js';
import { createNotebookHistoryOperations } from './knowledge/notebook-history.js';
import {
  type NotebookPublicationDependencies,
  type NotebookUpdate,
  publishWorkspaceNotebook,
} from './knowledge/notebook-publication.js';
import { readWorkspaceNotebookAdmission } from './knowledge/notebook-workspace-admission.js';
import { readWorkspaceNotebookSelection } from './knowledge/notebook-workspace-selection.js';
import {
  KnowledgePageValidationError,
  parseOkfDocument,
  stringFrontmatterField,
} from './knowledge/okf.js';
import {
  prepareSchemaApplicationHistory,
  readSchemaApplicationHistory,
} from './knowledge/schema-application.js';
import { previewWorkspaceSchema } from './knowledge/schema-dependency-preview.js';
import { publishCapturedSource } from './knowledge/source-publication.js';
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
import {
  prepareWorkspaceKnowledgeProposal,
  prepareWorkspaceKnowledgeSelection,
} from './storage/control-store-knowledge.js';
import { getControlStoreWorkerClient } from './storage/control-store-worker-client.js';
import type { CoreDb, WorkspaceDb } from './storage/db.js';
import { openWorkspaceDb } from './storage/db.js';
import {
  readWorkspaceKnowledgeDerivedIndexes,
  retrieveWorkspaceKnowledge,
} from './storage/index-rebuild.js';
import { knowledgeProposalDocumentDigest } from './storage/knowledge-proposal-codecs.js';
import { applyScopedMigrations } from './storage/migrate.js';
import { readBlockers } from './storage/workspace-backup.js';
import type { WorkspaceFrozenAdmission } from './workspace-mutation-admission.js';

/** Projects known Knowledge command, record and decoder refusals; arbitrary exceptions escape. */
function commandFailure(error: unknown, code: string, status = 404): OperationError {
  if (error instanceof NotebookError) notebookCommandFailure(error);
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
async function recordKnowledgeGatewayUsage(input: {
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
}): Promise<void> {
  if (!input.coreDb) {
    return;
  }

  const workspaceDb = openWorkspaceDb(input.coreDb.dataRoot, input.workspaceId);

  try {
    applyScopedMigrations(workspaceDb);
    const call = await startCapabilityCall({
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
    await recordUsage({
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
    await finishCapabilityCall({ workspaceDb, callId: call.id, status: 'succeeded' });
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
    | keyof typeof KNOWLEDGE_NOTEBOOK_OPERATION_DEFINITIONS,
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

  const agentOperations = createKnowledgeAgentOperations(dependencies);

  /** Binds governed Workspace changes to one SQL-selected Notebook/schema and current authority. */
  const withGovernedNotebook = async <T>(
    request: NotebookUpdate,
    context: AdmittedOperationContext,
    run: (dependencies: NotebookPublicationDependencies) => T | Promise<T>,
    schemaFreeze?: () => WorkspaceFrozenAdmission | undefined
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
    try {
      const workspaceRoot = join(dataRoot, 'workspaces', request.workspaceId);
      const knowledgeBaseId = readDefaultKnowledgeBaseId({
        dataRoot,
        scope: { kind: 'workspace', workspaceId: request.workspaceId },
      });
      const { notebook, scopeSchemaText } = readWorkspaceNotebookSelection({
        workspaceDb,
        workspaceRoot,
        knowledgeBaseId,
      });
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
            scopeSchemaText,
            request,
            requestActor: publicOperationActor(context),
            actor,
            runtimeConfigManager,
            workspaceMutationAdmission,
            ...(schemaFreeze?.() ? { schemaFreeze: schemaFreeze()! } : {}),
          }),
      });
    } catch (error) {
      notebookCommandFailure(error);
    } finally {
      workspaceDb.sqlite.close();
    }
  };
  /** Existing receipt/in-flight identity precedes path or digest conflicts for page intents. */
  function assertNotebookPageCommandIdentity(
    name: 'knowledge.notebook.create' | 'knowledge.notebook.delete',
    input: { readonly workspaceId: string; readonly requestId: string },
    owner: NotebookPublicationDependencies
  ): void {
    const scope = { workspaceId: input.workspaceId, actorId: owner.producer.id };
    const receipt = store.getCommandRequest(name, input.requestId, scope, owner.workspaceDb);
    const inflight = inflightCommands
      .get(store)
      ?.get(commandRequestKey(name, input.requestId, scope));
    const inputHash = commandInputHash(input);
    if (
      (receipt && receipt.inputHash !== inputHash) ||
      (inflight && inflight.inputHash !== inputHash)
    )
      throw new IdempotencyKeyConflictError();
  }

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

  /** The same complete native inventory serves inspection and exact reviewed application. */
  const inspectSchema = (
    input: PreviewKnowledgeSchemaRequest,
    context: AdmittedOperationContext,
    owner: NotebookPublicationDependencies,
    schemaFreeze?: WorkspaceFrozenAdmission
  ) => {
    const access = sourceReadInput(input.workspaceId, context);
    admitKnowledgeRetrieval(access);
    const admission = owner.revalidate();
    if (owner.notebook.publishedRevision() !== input.baseRevision)
      throw new NotebookError('conflict');
    const entries = Object.keys(owner.notebook.inspectRevision(input.baseRevision).entries);
    const pageIds = entries
      .filter((path) => !['index.md', 'log.md'].includes(path.split('/').at(-1)!))
      .map((path) => path.slice(0, -3));
    const sources = Object.keys(owner.notebook.readSourcePointers(input.baseRevision));
    const revalidate = () => {
      const current = owner.revalidate();
      const selectedHead = readWorkspaceNotebookSelection({
        workspaceDb: owner.workspaceDb,
        workspaceRoot: join(store.getDataRoot()!, 'workspaces', input.workspaceId),
        knowledgeBaseId: readDefaultKnowledgeBaseId({
          dataRoot: store.getDataRoot()!,
          scope: { kind: 'workspace', workspaceId: input.workspaceId },
        }),
      });
      if (
        current.scopeSchemaText !== admission.scopeSchemaText ||
        selectedHead.scopeSchemaText !== admission.scopeSchemaText ||
        selectedHead.head.notebookCommit !== input.baseRevision
      )
        throw new NotebookError('conflict');
      const selected = readAuthorizedWorkspaceNotebookPages({
        ...access,
        dataRoot: store.getDataRoot()!,
        notebookRevision: input.baseRevision,
        pageIds,
      });
      if (selected.notebookRevision !== input.baseRevision) throw new NotebookError('conflict');
      for (const id of sources) requireSourceAudience(input.workspaceId, id, context);
    };
    return previewWorkspaceSchema({
      dataRoot: store.getDataRoot()!,
      coreDb: coreDb!,
      store,
      workspaceDb: owner.workspaceDb,
      access: access.access,
      admitProposal: (proposal) => {
        const candidate = owner.notebook.readRevision(proposal.candidateRevision);
        const trees = [proposal.baseRevision, proposal.candidateRevision].map((revision) =>
          owner.notebook.readContent(revision)
        );
        const paths = [...new Set(trees.flatMap((files) => Object.keys(files)))];
        for (const files of trees)
          readWorkspaceNotebookAdmission({
            store,
            coreDb: coreDb!,
            workspaceDb: owner.workspaceDb,
            notebook: owner.notebook,
            scopeSchemaText: admission.scopeSchemaText,
            actor: owner.actor!,
            requestActor: publicOperationActor(context),
            runtimeConfigManager: dependencies.runtimeConfigManager!,
            workspaceMutationAdmission: dependencies.workspaceMutationAdmission!,
            ...(schemaFreeze ? { schemaFreeze } : {}),
            request: {
              workspaceId: input.workspaceId,
              requestId: candidate.metadata.changeRequest.requestId,
              baseRevision: proposal.baseRevision,
              summary: proposal.rationale,
              changes: paths.map((path) => ({ path, content: files[path] ?? null })),
            },
          });
      },
      workspaceId: input.workspaceId,
      notebook: owner.notebook,
      scopeSchemaText: admission.scopeSchemaText,
      candidateSchemaText: input.schemaText,
      pageScopeId: admission.pageScopeId!,
      registeredSources: admission.registeredSources,
      revalidate,
    });
  };

  return {
    ...agentOperations,
    ...createNotebookHistoryOperations(dependencies, notebookCommandFailure),
    'knowledge.schema.preview': (input, context) =>
      withGovernedNotebook(
        { ...input, changes: [], summary: 'Inspect a draft Scope Schema' },
        context,
        (owner) => inspectSchema(input, context, owner)
      ),
    'knowledge.schema.apply': async (input, context) => {
      if (dependencies.workspaceMutationAdmission?.isClosed(input.workspaceId))
        throw new OperationError('workspace_frozen', 'Workspace is temporarily frozen.', 409, {
          details: {
            workspaceId: input.workspaceId,
            operation: 'capture',
            retryable: true,
            blockers: [
              {
                kind: 'publication',
                reason: 'frozen',
                reference: { workspaceId: input.workspaceId },
                actions: [],
              },
            ],
          },
        });
      let freeze: WorkspaceFrozenAdmission | undefined;
      return withGovernedNotebook(
        { ...input, changes: [], summary: 'Apply the exact reviewed Scope Schema' },
        context,
        (owner) => {
          owner.revalidate();
          const workspaceRoot = join(owner.workspaceDb.dataRoot, 'workspaces', input.workspaceId);
          return runIdempotentCommand({
            store,
            inflightCommands,
            command: 'knowledge.schema.apply',
            requestId: input.requestId,
            scope: { workspaceId: input.workspaceId, actorId: owner.producer.id },
            input,
            responseKind: 'knowledge_schema_report',
            workspaceDb: owner.workspaceDb,
            replay: (record) => {
              owner.revalidate();
              const result = readSchemaApplicationHistory(workspaceRoot, record.response.id);
              if (
                record.response.kind !== 'knowledge_schema_report' ||
                result.workspaceId !== input.workspaceId
              )
                throw new NotebookError('recovery_required');
              return result;
            },
            responseId: (result) => result.reportDigest,
            execute: async (receipt) => {
              const admission = dependencies.workspaceMutationAdmission!;
              const client = getControlStoreWorkerClient(admission);
              let drained: Promise<() => void> | null = null;
              const wasClosed = admission.isClosed(input.workspaceId);
              const candidate = admission.tryFreeze(input.workspaceId, () => {
                const blockers = readBlockers({
                  coreDb: coreDb!,
                  store,
                  workspaceId: input.workspaceId,
                  operation: 'capture',
                  canReadThread: (threadId) =>
                    threadReadable(sourceReadInput(input.workspaceId, context), threadId),
                });
                if (blockers.length) return blockers;
                drained = client.tryPauseForWorkspaceCapture(
                  `workspace:${owner.workspaceDb.sqlite.name}`,
                  admission
                );
                return drained
                  ? []
                  : [
                      {
                        kind: 'publication',
                        reason: 'pending-publication',
                        reference: { workspaceId: input.workspaceId },
                        actions: [],
                      },
                    ];
              });
              if (candidate.status !== 'frozen')
                throw new OperationError(
                  wasClosed ? 'workspace_frozen' : 'workspace_blocked',
                  'Workspace schema application is not admitted.',
                  409,
                  {
                    details: {
                      workspaceId: input.workspaceId,
                      operation: 'capture',
                      retryable: wasClosed,
                      blockers:
                        candidate.status === 'blocked'
                          ? candidate.blockers
                          : [
                              {
                                kind: 'publication',
                                reason: wasClosed ? 'frozen' : 'pending-publication',
                                reference: { workspaceId: input.workspaceId },
                                actions: [],
                              },
                            ],
                    },
                  }
                );
              freeze = candidate;
              try {
                // Drain only previously posted ACKs, then keep the lifecycle freeze as the sole exclusion.
                const resume = await drained!;
                resume();
                owner.revalidate();
                const reviewed = input.reviewedReport;
                if (
                  !reviewed.inventoryComplete ||
                  reviewed.schemaDiagnostics.length ||
                  reviewed.records.some(
                    (row) => row.status !== 'valid' || row.diagnostics.length
                  ) ||
                  reviewed.dependencyInventory.some(
                    (row) =>
                      !row.complete ||
                      !row.inventoryDigest ||
                      row.diagnostics.length ||
                      row.records.some(
                        (record) => record.status !== 'valid' || record.diagnostics.length
                      )
                  )
                )
                  throw new NotebookError('invalid_request');
                const report = inspectSchema(input, context, owner, freeze);
                if (canonicalJsonText(report) !== canonicalJsonText(reviewed))
                  throw new NotebookError('conflict');
                const selected = readWorkspaceNotebookSelection({
                  workspaceDb: owner.workspaceDb,
                  workspaceRoot,
                  knowledgeBaseId: readDefaultKnowledgeBaseId({
                    dataRoot: owner.workspaceDb.dataRoot,
                    scope: { kind: 'workspace', workspaceId: input.workspaceId },
                  }),
                });
                const result = await prepareSchemaApplicationHistory({
                  workspaceRoot,
                  previousSchemaText: selected.scopeSchemaText,
                  candidateSchemaText: input.schemaText,
                  report,
                });
                owner.revalidate();
                const nextHead = await prepareWorkspaceKnowledgeSelection({
                  db: owner.workspaceDb,
                  workspaceRoot,
                  notebook: owner.notebook,
                  knowledgeBaseId: selected.head.knowledgeBaseId,
                  notebookCommit: input.baseRevision,
                  schemaText: input.schemaText,
                });
                const revalidatePublication = () => {
                  owner.revalidate();
                  if (
                    canonicalJsonText(inspectSchema(input, context, owner, freeze)) !==
                    canonicalJsonText(report)
                  )
                    throw new NotebookError('conflict');
                };
                const { responseKind, ...original } = receipt;
                await store.commitWorkspaceKnowledge({
                  workspaceDb: owner.workspaceDb,
                  expectedHead: selected.head,
                  nextHead,
                  audits: [
                    prepareAuditEvent({
                      workspaceId: input.workspaceId,
                      requestId: input.requestId,
                      actor: owner.producer,
                      category: 'knowledge',
                      action: 'knowledge.schema.apply',
                      outcome: 'succeeded',
                      resource: `knowledge-schema-report:${result.reportDigest}`,
                      summary: 'Reviewed Workspace schema applied.',
                    }),
                  ],
                  receipt: {
                    ...original,
                    response: { kind: responseKind, id: result.reportDigest },
                  },
                  schemaApplication: {
                    schemaFreeze: freeze,
                    requestId: input.requestId,
                    reportDigest: result.reportDigest,
                  },
                  revalidatePublication,
                });
                return result;
              } finally {
                freeze.release();
                freeze = undefined;
              }
            },
          });
        },
        () => freeze
      );
    },
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
        const { notebook, scopeSchemaText } = readWorkspaceNotebookSelection({
          workspaceDb,
          workspaceRoot: join(dataRoot, 'workspaces', input.workspaceId),
          knowledgeBaseId: readDefaultKnowledgeBaseId({
            dataRoot,
            scope: { kind: 'workspace', workspaceId: input.workspaceId },
          }),
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
                scopeSchemaText,
                request: input,
                requestActor,
                actor,
                runtimeConfigManager,
                workspaceMutationAdmission,
              }),
          },
          input
        );
        await recordKnowledgeGatewayUsage({
          authorityActor: context.actorRef,
          capabilityId: 'knowledge.notebook.update',
          operation: 'knowledge.notebook.update',
          requestId: input.requestId,
          serviceRef: 'knowledge-store',
          summary: 'Human Notebook update published.',
          usageSource: 'knowledge-notebook-update',
          workspaceId: input.workspaceId,
          ...(coreDb ? { coreDb } : {}),
        });
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
        const result = await agentOperations['knowledge.ask'](
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
          const observedAt = new Date().toISOString();
          const document = parseOkfDocument({ path: page.path, content: page.content }).document!;
          const title = stringFrontmatterField(document, 'title')!;
          const body = document.body.replace(/\s+/g, ' ').trim();
          return {
            reference: { scopeId, objectId: id },
            revision: citation.revision,
            contentDigest: citation.contentDigest,
            observedAt,
            // Ask resolved these pins within the admitted page's Source owner.
            // Bare or unresolved proof strings are not exact Source citations.
            sourceCitations: citation.sourceReferences.flatMap((reference) => {
              const source = /^source:([^@]+)@(sha256:[a-f0-9]{64})$/.exec(reference);
              return source
                ? [
                    {
                      ownerScope: server
                        ? { kind: 'server' as const }
                        : { kind: 'workspace' as const, workspaceId: input.workspaceId },
                      sourceId: source[1]!,
                      contentDigest: source[2]!,
                    },
                  ]
                : [];
            }),
            title,
            excerpt: body.length > 240 ? `${body.slice(0, 237)}...` : body || title,
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
        if (error instanceof NotebookError) notebookCommandFailure(error);
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
          execute: async (receipt) => {
            if (
              !coreDb ||
              !store.getDataRoot() ||
              (actor.kind !== 'user' && actor.kind !== 'agent')
            )
              throw new OperationError(
                'knowledge_source_unavailable',
                'Knowledge Source publication is unavailable.',
                503
              );
            const sourceId = allocateEntityId('ks');
            const workspaceDb = repositoryWorkspaceDb(workspaceId);
            try {
              const source = await publishCapturedSource(
                {
                  owner: {
                    dataRoot: coreDb.dataRoot,
                    ownerScope: { kind: 'workspace', workspaceId },
                  },
                  database: { kind: 'workspace', workspaceDb },
                  access: current.access,
                  producer: actor.kind === 'user' ? actor : { ...actor, kind: 'agent' },
                  requestId: commandInput.requestId,
                  commandInput: { ...commandInput, workspaceId },
                  captureChannel: 'knowledge.source.register',
                  receipt,
                  revalidatePublication: () => {
                    admitKnowledgeRetrieval(current);
                    if (
                      !isWorkspaceOperationAuthorized(
                        coreDb,
                        publicOperationActor(context),
                        workspaceId,
                        {
                          mutating: true,
                          policyOperation: 'knowledge.write',
                        }
                      )
                    )
                      return false;
                    if (
                      commandInput.originatingThreadId &&
                      !threadReadable(current, commandInput.originatingThreadId)
                    )
                      throw new OperationError(
                        'workspace_access_denied',
                        'Knowledge Source is unavailable.',
                        403
                      );
                    if (commandInput.originatingTurnId) {
                      if (!commandInput.originatingThreadId)
                        throw new OperationError(
                          'knowledge_source_register_failed',
                          `Knowledge source turn requires a thread: ${sourceId}`,
                          404
                        );
                      store.getTurn(
                        workspaceId,
                        commandInput.originatingThreadId,
                        commandInput.originatingTurnId
                      );
                    }
                  },
                },
                {
                  id: sourceId,
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
                Buffer.from(commandInput.content)
              );
              return { ...source.source, workspaceId };
            } finally {
              workspaceDb.sqlite.close();
            }
          },
          replay: (record) => store.getKnowledgeSource(workspaceId, record.response.id),
          responseId: (result) => result.id,
        });
        requireSourceAudience(workspaceId, source.id, context);
        await recordKnowledgeGatewayUsage({
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
          derivedRepresentations: [],
        });
        requireSourceAudience(workspaceId, source.id, context);
        return response;
      } catch (error) {
        if (error instanceof NotebookError) notebookCommandFailure(error);
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
          derivedRepresentations: [],
        });
        await recordKnowledgeGatewayUsage({
          authorityActor: actor,
          capabilityId: 'knowledge.source.read',
          operation: 'knowledge.source.read',
          serviceRef: 'knowledge-store',
          summary: `Knowledge source ${sourceId} read.`,
          usageSource: 'knowledge-source-read',
          workspaceId,
          ...(coreDb ? { coreDb: coreDb } : {}),
        });

        // Source metadata and its usage accounting must not outlive current disclosure authority.
        requireSourceAudience(workspaceId, sourceId, context);
        return response;
      } catch (error) {
        if (error instanceof OperationError) throw error;
        if (error instanceof NotebookError) notebookCommandFailure(error);
        throw commandFailure(error, 'knowledge_source_not_found', 404);
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
            types: commandInput.types,
            appliesTo: commandInput.appliesTo,
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
            beforeDisclosure: (response) =>
              recordKnowledgeGatewayUsage({
                authorityActor: actor,
                capabilityId: 'knowledge.retrieval',
                operation: 'knowledge.retrieval',
                serviceRef: 'knowledge-store',
                summary: `Knowledge retrieval selected ${response.selected.length} candidates.`,
                usageSource: 'knowledge-retrieval',
                workspaceId,
                ...(coreDb ? { coreDb: coreDb } : {}),
              }),
          })
        );

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
          beforeDisclosure: (response) =>
            recordKnowledgeGatewayUsage({
              authorityActor: actor,
              capabilityId: 'knowledge.context.prepare',
              operation: 'knowledge.context.prepare',
              serviceRef: 'knowledge-manager',
              summary: `Knowledge context selected ${response.selected.length} knowledge entries.`,
              usageSource: 'knowledge-context-prepare',
              workspaceId,
              ...(coreDb ? { coreDb: coreDb } : {}),
            }),
          access: {
            store,
            coreDb,
            actor: context.actorRef,
            requestActor: publicOperationActor(context),
            outputThreadId: context.queryContext?.threadId,
            outputTurnId: context.queryContext?.turnId,
          },
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
        let proposal: Awaited<ReturnType<FsStore['createKnowledgeProposal']>>;
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
            execute: async (receipt) => {
              const release = store.enterWorkspaceMutation(workspaceId);
              try {
                const executionVerification = verifyKnowledgeProposalWorkHistory({
                  coreDb,
                  sourceReferences: commandInput.sourceReferences,
                  store,
                  workspaceDb,
                  workspaceId,
                });
                return await withGovernedNotebook(
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
                  async (owner) => {
                    owner.revalidate();
                    const dataRoot = owner.workspaceDb.dataRoot;
                    const workspaceRoot = join(dataRoot, 'workspaces', workspaceId);
                    const knowledgeBaseId = readDefaultKnowledgeBaseId({
                      dataRoot,
                      scope: { kind: 'workspace', workspaceId },
                    });
                    const selected = readWorkspaceNotebookSelection({
                      workspaceDb: owner.workspaceDb,
                      workspaceRoot,
                      knowledgeBaseId,
                    });
                    if (selected.head.notebookCommit !== commandInput.baseRevision)
                      throw new NotebookError('conflict');
                    const proposal = store.prepareKnowledgeProposal({
                      ...commandInput,
                      workspaceId,
                      producer,
                      createdAt: new Date().toISOString(),
                      verifiedExternalReferences: executionVerification.verifiedExternalReferences,
                    });
                    const immutable = await prepareWorkspaceKnowledgeProposal({
                      db: owner.workspaceDb,
                      workspaceRoot,
                      notebook: selected.notebook,
                      knowledgeBaseId,
                      proposal,
                    });
                    const revalidatePublication = (): void => {
                      owner.revalidate();
                      verifyKnowledgeProposalWorkHistory({
                        coreDb,
                        sourceReferences: proposal.sourceReferences,
                        store,
                        workspaceDb: owner.workspaceDb,
                        workspaceId,
                      });
                    };
                    revalidatePublication();
                    const { responseKind, ...originalReceipt } = receipt;
                    await store.commitWorkspaceKnowledge({
                      workspaceDb: owner.workspaceDb,
                      expectedHead: selected.head,
                      newProposal: immutable,
                      audits: [
                        prepareAuditEvent({
                          workspaceId,
                          requestId: commandInput.requestId,
                          actor,
                          category: 'knowledge',
                          action: 'knowledge.proposal.draft',
                          outcome: 'succeeded',
                          resource: `knowledge-proposal:${proposal.id}`,
                          summary: 'Knowledge proposal drafted.',
                        }),
                      ],
                      receipt: {
                        ...originalReceipt,
                        response: { kind: responseKind, id: proposal.id },
                      },
                      revalidatePublication,
                    });
                    revalidatePublication();
                    return store.projectKnowledgeProposalDraft(workspaceId, proposal.id);
                  }
                );
              } finally {
                release();
              }
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
            async (owner) => {
              await recordKnowledgeGatewayUsage({
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
        await recordKnowledgeGatewayUsage({
          authorityActor: actor,
          capabilityId: 'knowledge.repair.suggest',
          operation: 'knowledge.repair.suggest',
          serviceRef: 'knowledge-manager',
          summary: `Knowledge repair suggestions returned ${response.suggestions.length} suggestions.`,
          usageSource: 'knowledge-repair-suggest',
          workspaceId,
          ...(coreDb ? { coreDb: coreDb } : {}),
        });

        admitKnowledgeRetrieval(sourceReadInput(workspaceId, context));
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
        await recordKnowledgeGatewayUsage({
          authorityActor: actor,
          capabilityId: 'knowledge.health.check',
          operation: 'knowledge.health.check',
          serviceRef: 'knowledge-manager',
          summary: `Knowledge health completed with ${response.checks.length} checks.`,
          usageSource: 'knowledge-health-check',
          workspaceId,
          ...(coreDb ? { coreDb: coreDb } : {}),
        });

        admitKnowledgeRetrieval(sourceReadInput(workspaceId, context));
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
      let proposal: ReturnType<typeof requireAuthorizedKnowledgeProposal>;
      // Inventory refusals precede governed publication and need the same public projection.
      try {
        proposal = requireAuthorizedKnowledgeProposal(store, workspaceId, proposalId);
      } catch (error) {
        notebookCommandFailure(error);
      }
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
            knowledgeProposalDocumentDigest(saved) !== commandInput.proposalDigest
          )
            throw new NotebookError('conflict');
          return owner.revalidate();
        };
        current();
        const prepareDecision = () =>
          store.prepareKnowledgeProposalReviewDecision({
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
          const preparedDecision = receipt ? undefined : prepareDecision();
          await publishWorkspaceNotebook(
            {
              ...owner,
              command: { name: 'knowledge.proposal.decide', input },
              producer: proposal.producer,
              revalidate: current,
              reviewedCandidate: {
                proposalId,
                candidateRevision: proposal.candidateRevision,
                ...(preparedDecision
                  ? {
                      review: preparedDecision.review,
                    }
                  : {}),
              },
            },
            request
          );
          return store.projectKnowledgeProposalDecision(workspaceId, reviewId);
        }
        const response = await runIdempotentCommand<
          Awaited<ReturnType<FsStore['projectKnowledgeProposalDecision']>>
        >({
          store,
          workspaceDb: owner.workspaceDb,
          inflightCommands,
          command: 'knowledge.proposal.decide',
          requestId: commandInput.requestId,
          scope: { workspaceId, actorId: context.actorRef.id },
          input,
          responseKind: 'knowledge_proposal_review',
          responseId: (result) => result.review.reviewId,
          execute: async (receipt) => {
            const release = store.enterWorkspaceMutation(workspaceId);
            try {
              const workspaceRoot = join(owner.workspaceDb.dataRoot, 'workspaces', workspaceId);
              const knowledgeBaseId = readDefaultKnowledgeBaseId({
                dataRoot: owner.workspaceDb.dataRoot,
                scope: { kind: 'workspace', workspaceId },
              });
              const selected = readWorkspaceNotebookSelection({
                workspaceDb: owner.workspaceDb,
                workspaceRoot,
                knowledgeBaseId,
              });
              current();
              const result = prepareDecision();
              const { responseKind, ...originalReceipt } = receipt;
              await store.commitWorkspaceKnowledge({
                workspaceDb: owner.workspaceDb,
                expectedHead: selected.head,
                review: { proposalId, review: result.review },
                audits: [
                  prepareAuditEvent({
                    workspaceId,
                    requestId: commandInput.requestId,
                    actor: context.actorRef,
                    category: 'knowledge',
                    action: 'knowledge.proposal.decide',
                    outcome: 'succeeded',
                    resource: `knowledge-proposal:${proposalId}`,
                    summary: 'Knowledge proposal decision recorded.',
                  }),
                ],
                receipt: { ...originalReceipt, response: { kind: responseKind, id: reviewId } },
                revalidatePublication: current,
              });
              current();
              return store.projectKnowledgeProposalDecision(workspaceId, reviewId);
            } finally {
              release();
            }
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
        current();
        return response;
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
        await store.projectKnowledgeProposalDraft(workspaceId, proposalId);
        const decision = await store.projectKnowledgeProposalDecision(workspaceId, input.reviewId);
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
        const readDb = repositoryWorkspaceDb(workspaceId);
        let original: string | null;
        let baseBytes: string | undefined;
        const path = `${input.knowledgePageId}.md`;
        try {
          const { notebook } = readWorkspaceNotebookSelection({
            workspaceDb: readDb,
            workspaceRoot: join(dataRoot, 'workspaces', workspaceId),
            knowledgeBaseId: readDefaultKnowledgeBaseId({
              dataRoot,
              scope: { kind: 'workspace', workspaceId },
            }),
          });
          original = notebook.readContent(proposal.baseRevision)[path] ?? null;
          baseBytes = notebook.readContent(input.baseRevision)[path];
        } finally {
          readDb.sqlite.close();
        }
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
          const content = owner.notebook.readContent(publication.notebookRevision)[path];
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
    'knowledge.notebook.list': async (input, context) => {
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
          workspaceId: input.workspaceId,
          access: {
            store,
            coreDb,
            actor: context.actorRef,
            requestActor: publicOperationActor(context),
            outputThreadId: context.queryContext?.threadId,
            outputTurnId: context.queryContext?.turnId,
          },
        });
        return ListKnowledgeNotebookResponseSchema.parse({
          knowledgeBaseId: snapshot.knowledgeBaseId,
          notebookRevision: snapshot.notebookRevision,
          pages: snapshot.pages,
        });
      } catch (error) {
        throw commandFailure(error, 'not_found');
      }
    },
    'knowledge.notebook.create': async (input, context) => {
      const request: NotebookUpdate = {
        workspaceId: input.workspaceId,
        requestId: input.requestId,
        baseRevision: input.baseRevision,
        changes: [{ path: input.path, content: input.content }],
        summary: input.summary,
      };
      const publication = await withGovernedNotebook(request, context, (owner) => {
        assertNotebookPageCommandIdentity('knowledge.notebook.create', input, owner);
        if (owner.notebook.inspectRevision(input.baseRevision).entries[input.path])
          throw new OperationError(
            'conflict',
            'Notebook page already exists at the selected base.',
            409
          );
        return publishWorkspaceNotebook(
          { ...owner, command: { name: 'knowledge.notebook.create', input } },
          request
        );
      });
      await recordKnowledgeGatewayUsage({
        authorityActor: context.actorRef,
        capabilityId: 'knowledge.notebook.create',
        operation: 'knowledge.notebook.create',
        requestId: input.requestId,
        serviceRef: 'knowledge-store',
        summary: 'Human Notebook create published.',
        usageSource: 'knowledge-notebook-create',
        workspaceId: input.workspaceId,
        ...(coreDb ? { coreDb } : {}),
      });
      return {
        ...publication,
        changedPageIds: [...publication.changedPageIds],
        receiptRef: { ...publication.receiptRef, operation: 'knowledge.notebook.create' as const },
      };
    },
    'knowledge.notebook.delete': async (input, context) => {
      const request: NotebookUpdate = {
        workspaceId: input.workspaceId,
        requestId: input.requestId,
        baseRevision: input.baseRevision,
        changes: [{ path: input.path, content: null }],
        summary: input.summary,
      };
      const publication = await withGovernedNotebook(request, context, (owner) => {
        assertNotebookPageCommandIdentity('knowledge.notebook.delete', input, owner);
        const content = owner.notebook.readRevision(input.baseRevision, [input.path]).files[
          input.path
        ];
        if (
          content === undefined ||
          `sha256:${createHash('sha256').update(content).digest('hex')}` !==
            input.expectedContentDigest
        )
          throw new OperationError(
            'conflict',
            'Knowledge removal conflicts with its fixed base.',
            409
          );
        return publishWorkspaceNotebook(
          {
            ...owner,
            command: { name: 'knowledge.notebook.delete', input },
            confirmedRemovals: { [input.path]: content },
          },
          request
        );
      });
      await recordKnowledgeGatewayUsage({
        authorityActor: context.actorRef,
        capabilityId: 'knowledge.notebook.delete',
        operation: 'knowledge.notebook.delete',
        requestId: input.requestId,
        serviceRef: 'knowledge-store',
        summary: 'Human Notebook delete published.',
        usageSource: 'knowledge-notebook-delete',
        workspaceId: input.workspaceId,
        ...(coreDb ? { coreDb } : {}),
      });
      return {
        ...publication,
        changedPageIds: [...publication.changedPageIds],
        receiptRef: { ...publication.receiptRef, operation: 'knowledge.notebook.delete' as const },
      };
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
    const admitted = await admitOperation(
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
