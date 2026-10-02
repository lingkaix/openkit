import { createHash, randomUUID } from 'node:crypto';
import type {
  KNOWLEDGE_ENTRY_OPERATION_DEFINITIONS,
  KNOWLEDGE_OPERATION_DEFINITIONS,
  OperationId,
} from '@openkit/app-api-schemas';
import {
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
  SubmitKnowledgeProposalDecisionResponseSchema,
} from '@openkit/app-api-schemas';
import {
  type ActorRef,
  KnowledgeEntrySchema,
  ListKnowledgeEntriesResponseSchema,
} from '@openkit/protocol';
import { publishedErrorMessage } from './api-errors.js';
import { listWorkspaceAuditEvents, recordWorkspaceAuditEvent } from './audit-events.js';
import {
  finishCapabilityCall,
  normalizeCapabilityRequestId,
  recordUsage,
  startCapabilityCall,
} from './capability/usage-ledger.js';
import { KnowledgePageValidationError } from './knowledge/okf.js';
import {
  answerKnowledgeManager,
  checkKnowledgeHealth,
  draftKnowledgeProposal,
  prepareKnowledgeContext,
  prepareTaskKnowledgeContext,
  resolveWorkspaceKnowledgeReferenceProofs,
  suggestKnowledgeRepairs,
  verifyKnowledgeProposalWorkHistory,
} from './knowledge-manager.js';
import {
  type FsStore,
  knowledgeAuthorityId,
  knowledgeProposalAuthorityError as knowledgeProposalAuthorityFailure,
} from './lib/store.js';
import type {
  OperationImplementations,
  OperationInvocationDependencies,
} from './operation-invocation.js';
import { IdempotencyKeyConflictError, runIdempotentCommand } from './runtime/idempotent-command.js';
import type { CoreDb, WorkspaceDb } from './storage/db.js';
import { openWorkspaceDb } from './storage/db.js';
import {
  readWorkspaceKnowledgeDerivedIndexes,
  retrieveWorkspaceKnowledge,
} from './storage/index-rebuild.js';
import { applyScopedMigrations } from './storage/migrate.js';
/** Domain-owned Knowledge failure; native projections preserve this exact code, message and status. */
export class KnowledgeOperationError extends Error {
  public constructor(
    message: string,
    public readonly code = 'not_found',
    public readonly status = 404
  ) {
    super(message);
    this.name = 'KnowledgeOperationError';
  }
}

/** Preserves existing command refusal classes and the existing bounded fallback at the Knowledge owner. */
function commandFailure(error: unknown, code: string, status = 404): KnowledgeOperationError {
  if (error instanceof KnowledgeOperationError) return error;
  if (error instanceof IdempotencyKeyConflictError || error instanceof KnowledgePageValidationError)
    return new KnowledgeOperationError(error.message, error.code, error.status);
  return new KnowledgeOperationError(publishedErrorMessage(error), code, status);
}

/** Requires a scoped child from its current owner after native Workspace admission; no foreign Workspace is scanned. */
function readAuthorizedKnowledgeOwner<T extends { readonly workspaceId: string }>(
  workspaceId: string,
  readOwner: () => T
): T {
  try {
    const owner = readOwner();
    if (owner.workspaceId !== workspaceId) throw new Error('Inconsistent Knowledge lineage.');
    return owner;
  } catch {
    throw new KnowledgeOperationError('Workspace access denied.', 'workspace_access_denied', 403);
  }
}

/**
 * Maps one proposal draft failure to the closed public error vocabulary.
 *
 * @param error Caught draft command failure.
 * @throws The retained typed owner refusal or its bounded fallback.
 */
function knowledgeProposalDraftFailure(error: unknown): never {
  if (
    error instanceof IdempotencyKeyConflictError ||
    error instanceof KnowledgePageValidationError
  ) {
    throw commandFailure(error, 'knowledge_manager_proposal_draft_failed');
  }
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    'status' in error &&
    ['invalid_request', 'not_found', 'conflict', 'recovery_required'].includes(
      String(error.code)
    ) &&
    [400, 404, 409].includes(Number(error.status))
  ) {
    throw new KnowledgeOperationError(
      'Knowledge Proposal authority check failed.',
      String(error.code),
      Number(error.status)
    );
  }
  throw new KnowledgeOperationError(
    'Knowledge Manager proposal draft failed.',
    'knowledge_manager_proposal_draft_failed',
    500
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
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    'status' in error &&
    ['invalid_request', 'not_found', 'conflict', 'recovery_required'].includes(
      String(error.code)
    ) &&
    [400, 404, 409].includes(Number(error.status))
  ) {
    throw new KnowledgeOperationError(
      'Knowledge Proposal authority check failed.',
      String(error.code),
      Number(error.status)
    );
  }
  throw new KnowledgeOperationError('Knowledge Proposal command failed.', fallbackCode, 500);
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
    throw new KnowledgeOperationError('Workspace access denied.', 'workspace_access_denied', 403);
  }
  return proposal;
}

/** Exact typed executable join for the two Knowledge definition tables. */
type KnowledgeImplementations = Pick<
  OperationImplementations,
  Extract<
    | keyof typeof KNOWLEDGE_OPERATION_DEFINITIONS
    | keyof typeof KNOWLEDGE_ENTRY_OPERATION_DEFINITIONS,
    OperationId
  >
>;

/** Binds the current Knowledge Store, command, trace and proposal owners without a transport or second authorizer. */
export function createKnowledgeOperationImplementations(
  dependencies: OperationInvocationDependencies
): KnowledgeImplementations {
  const store = dependencies.store!;
  const coreDb = dependencies.coreDb;
  const inflightCommands = dependencies.inflightCommands!;
  const repositoryWorkspaceDb = dependencies.repositoryWorkspaceDb!;
  /**
   * Resolves current Page-bound source authority for one retrieval request.
   *
   * @param store Product Knowledge and work-history owner.
   * @param workspaceId Workspace that owns the retrieval.
   * @returns Exact Page and digest keyed proofs whose owners remain coherent.
   */
  function knowledgeReferenceProofs(
    store: FsStore,
    workspaceId: string
  ): ReturnType<typeof resolveWorkspaceKnowledgeReferenceProofs> {
    if (!coreDb) {
      return resolveWorkspaceKnowledgeReferenceProofs({
        coreDb: undefined,
        store,
        workspaceDb: undefined,
        workspaceId,
      });
    }

    const workspaceDb = repositoryWorkspaceDb(workspaceId);
    try {
      return resolveWorkspaceKnowledgeReferenceProofs({
        coreDb,
        store,
        workspaceDb,
        workspaceId,
      });
    } finally {
      workspaceDb.sqlite.close();
    }
  }

  return {
    'knowledge.answer': async (input, actor) => {
      const { workspaceId, ...commandInput } = input;

      try {
        const dataRoot = store.getDataRoot();

        if (!dataRoot) {
          throw new Error('Knowledge Manager answer requires a file-backed data root.');
        }

        const response = answerKnowledgeManager({
          dataRoot,
          operationId: `km_answer_${randomUUID()}`,
          workspaceId,
          caller: 'app-api',
          query: commandInput.query,
          limit: commandInput.limit,
          referenceProofs: knowledgeReferenceProofs(store, workspaceId),
        });
        recordKnowledgeGatewayUsage({
          authorityActor: actor,
          capabilityId: 'knowledge.answer',
          operation: 'knowledge.answer',
          serviceRef: 'knowledge-manager',
          summary: `Knowledge answer completed with ${response.citations.length} citations.`,
          usageSource: 'knowledge-answer',
          workspaceId,
          ...(coreDb ? { coreDb: coreDb } : {}),
        });

        return KnowledgeManagerAnswerResponseSchema.parse(response);
      } catch {
        throw new KnowledgeOperationError(
          'Knowledge Manager answer failed.',
          'knowledge_manager_answer_failed',
          500
        );
      }
    },
    'knowledge.source.list': async (input, _actor) => {
      const { workspaceId } = input;

      try {
        return ListKnowledgeSourcesResponseSchema.parse({
          items: store.listKnowledgeSources(workspaceId),
        });
      } catch (error) {
        throw new KnowledgeOperationError(
          publishedErrorMessage(error),
          'knowledge_source_list_failed',
          404
        );
      }
    },
    'knowledge.source.register': async (input, actor) => {
      const { workspaceId, ...commandInput } = input;

      try {
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
                id: `ks_${randomUUID()}`,
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

        return RegisterKnowledgeSourceResponseSchema.parse({
          source,
          derivedRepresentations: store.listKnowledgeSourceDerivedRepresentations(
            workspaceId,
            source.id
          ),
        });
      } catch (error) {
        throw commandFailure(error, 'knowledge_source_register_failed');
      }
    },
    'knowledge.source.read': async (input, actor) => {
      const { workspaceId, sourceId } = input;

      try {
        const source = readAuthorizedKnowledgeOwner(workspaceId, () =>
          store.getKnowledgeSource(workspaceId, sourceId)
        );
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

        return response;
      } catch (error) {
        if (error instanceof KnowledgeOperationError) throw error;
        throw new KnowledgeOperationError(
          publishedErrorMessage(error),
          'knowledge_source_not_found',
          404
        );
      }
    },
    'knowledge.observation.list': async (input, _actor) => {
      const { workspaceId } = input;

      try {
        return ListKnowledgeObservationsResponseSchema.parse({
          items: store.listKnowledgeObservations(workspaceId),
        });
      } catch (error) {
        throw new KnowledgeOperationError(
          publishedErrorMessage(error),
          'knowledge_observation_list_failed',
          404
        );
      }
    },
    'knowledge.observation.record': async (input, actor) => {
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
              id: `ko_${randomUUID()}`,
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
    'knowledge.claim.list': async (input, _actor) => {
      const { workspaceId } = input;

      try {
        return ListKnowledgeClaimsResponseSchema.parse({
          items: store.listKnowledgeClaims(workspaceId),
        });
      } catch (error) {
        throw new KnowledgeOperationError(
          publishedErrorMessage(error),
          'knowledge_claim_list_failed',
          404
        );
      }
    },
    'knowledge.claim.record': async (input, actor) => {
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
              id: `kc_${randomUUID()}`,
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
    'knowledge.conflict.list': async (input, _actor) => {
      const { workspaceId } = input;

      try {
        return ListKnowledgeConflictsResponseSchema.parse({
          items: store.listKnowledgeConflicts(workspaceId),
        });
      } catch (error) {
        throw new KnowledgeOperationError(
          publishedErrorMessage(error),
          'knowledge_conflict_list_failed',
          404
        );
      }
    },
    'knowledge.conflict.record': async (input, actor) => {
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
              id: `kf_${randomUUID()}`,
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
    'knowledge.conflict.resolve': async (input, actor) => {
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
        if (error instanceof KnowledgeOperationError) throw error;
        throw commandFailure(error, 'knowledge_conflict_resolve_failed');
      }
    },
    'knowledge.indexes': async (input, _actor) => {
      const { workspaceId } = input;

      try {
        const dataRoot = store.getDataRoot();

        if (!dataRoot) {
          throw new KnowledgeOperationError(
            'Knowledge indexes require a file-backed data root.',
            'data_root_required',
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
        if (error instanceof KnowledgeOperationError) throw error;
        throw new KnowledgeOperationError(
          publishedErrorMessage(error),
          'knowledge_indexes_read_failed',
          404
        );
      }
    },
    'knowledge.retrieval': async (input, actor) => {
      const { workspaceId, ...commandInput } = input;

      try {
        const dataRoot = store.getDataRoot();

        if (!dataRoot) {
          throw new KnowledgeOperationError(
            'Knowledge retrieval requires a file-backed data root.',
            'data_root_required',
            409
          );
        }

        const response = KnowledgeRetrievalResponseSchema.parse(
          retrieveWorkspaceKnowledge({
            dataRoot,
            workspaceId,
            caller: 'app-api',
            query: commandInput.query,
            limit: commandInput.limit,
            pinnedConceptIds: commandInput.pinnedConceptIds,
            referenceProofs: knowledgeReferenceProofs(store, workspaceId),
            traceId: `krt_${randomUUID()}`,
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
        if (error instanceof KnowledgeOperationError) throw error;
        throw new KnowledgeOperationError(
          'Knowledge retrieval failed.',
          'knowledge_retrieval_failed',
          500
        );
      }
    },
    'knowledge.context.prepare': async (input, actor, context) => {
      const { workspaceId, ...commandInput } = input;
      if (context.kind === 'task') {
        const dataRoot = store.getDataRoot();
        if (!dataRoot)
          throw new Error('Task Knowledge retrieval requires a file-backed data root.');
        return prepareTaskKnowledgeContext({
          dataRoot,
          workspaceId,
          query: commandInput.query,
          traceId: context.traceId,
          referenceProofs: knowledgeReferenceProofs(store, workspaceId),
        });
      }

      try {
        const dataRoot = store.getDataRoot();

        if (!dataRoot) {
          throw new Error('Knowledge Manager context requires a file-backed data root.');
        }

        const response = prepareKnowledgeContext({
          dataRoot,
          operationId: `km_context_${randomUUID()}`,
          workspaceId,
          caller: 'app-api',
          query: commandInput.query,
          limit: commandInput.limit,
          referenceProofs: knowledgeReferenceProofs(store, workspaceId),
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
        throw new KnowledgeOperationError(
          'Knowledge Manager context preparation failed.',
          'knowledge_manager_context_failed',
          500
        );
      }
    },
    'knowledge.proposal.draft': async (input, actor) => {
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
            execute: () => {
              const executionVerification = verifyKnowledgeProposalWorkHistory({
                coreDb,
                sourceReferences: commandInput.sourceReferences,
                store,
                workspaceDb,
                workspaceId,
              });
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
                replayed.operation !== 'create' ||
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
    'knowledge.repair.suggest': async (input, actor) => {
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
        throw new KnowledgeOperationError(
          'Knowledge Manager repair suggestion failed.',
          'knowledge_manager_repair_suggest_failed',
          500
        );
      }
    },
    'knowledge.health.check': async (input, actor) => {
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
        throw new KnowledgeOperationError(
          'Knowledge Manager health check failed.',
          'knowledge_manager_health_check_failed',
          500
        );
      }
    },
    'knowledge.proposal.decide': async (input, actor) => {
      const { workspaceId, proposalId, ...commandInput } = input;

      try {
        const proposal = requireAuthorizedKnowledgeProposal(store, workspaceId, proposalId);
        if (!coreDb) {
          throw new KnowledgeOperationError(
            'Knowledge Proposal command storage is unavailable.',
            'knowledge_proposal_storage_unavailable',
            503
          );
        }

        const scope = { workspaceId, proposalId };
        const reviewId = knowledgeAuthorityId('kr_', {
          workspaceId,
          proposalId,
          requestId: commandInput.requestId,
        });
        const auditIdentity = {
          action: 'knowledge.proposal.decide' as const,
          actor,
          proposalId,
          requestId: commandInput.requestId,
          workspaceId,
        };
        const workspaceDb = repositoryWorkspaceDb(workspaceId);
        try {
          const receipt = store.getCommandRequest(
            'knowledge.proposal.decide',
            commandInput.requestId,
            scope,
            workspaceDb
          );
          const existingReview = store
            .listKnowledgeProposalReviewDecisions(workspaceId)
            .find((candidate) => candidate.reviewId === reviewId);
          const auditCount = knowledgeProposalAuditCount(workspaceDb, auditIdentity, false);
          if (!receipt) {
            if (auditCount !== 0) {
              throw knowledgeProposalAuthorityFailure('recovery_required');
            }
            if (existingReview) {
              if (
                existingReview.requestId !== commandInput.requestId ||
                existingReview.decision !== commandInput.decision ||
                JSON.stringify(existingReview.actor) !== JSON.stringify(actor)
              ) {
                throw knowledgeProposalAuthorityFailure('conflict');
              }
              if (
                existingReview.proposalId !== proposalId ||
                existingReview.workspaceId !== workspaceId ||
                existingReview.knowledgePageId !== proposal.knowledgePageId ||
                existingReview.contentDigest !== proposal.contentDigest
              ) {
                throw knowledgeProposalAuthorityFailure('recovery_required');
              }

              let complete = false;
              try {
                store.projectKnowledgeProposalDecision(workspaceId, reviewId);
                complete = true;
              } catch {
                // Only the accepted Review's exact missing-page path may continue below.
              }
              if (complete || existingReview.decision !== 'accepted') {
                throw knowledgeProposalAuthorityFailure('recovery_required');
              }
              try {
                store.projectKnowledgeProposalReversal({
                  workspaceId,
                  proposalId,
                  reviewId,
                  knowledgePageId: proposal.knowledgePageId,
                  expectedContentDigest: proposal.contentDigest,
                });
              } catch {
                throw knowledgeProposalAuthorityFailure('recovery_required');
              }
            }
          }

          const response = await runIdempotentCommand({
            store,
            inflightCommands,
            command: 'knowledge.proposal.decide',
            requestId: commandInput.requestId,
            scope,
            input: {
              actor,
              proposalId,
              decision: commandInput.decision,
              knowledgePageId: proposal.knowledgePageId,
              contentDigest: proposal.contentDigest,
              sourceReferences: proposal.sourceReferences,
            },
            responseKind: 'knowledge_proposal_review',
            workspaceDb,
            execute: () => {
              const verifiedExternalReferences =
                commandInput.decision === 'accepted'
                  ? verifyKnowledgeProposalWorkHistory({
                      coreDb,
                      sourceReferences: proposal.sourceReferences,
                      store,
                      workspaceDb,
                      workspaceId,
                    }).verifiedExternalReferences
                  : [];
              const executed = store.recordKnowledgeProposalReviewDecision({
                ...commandInput,
                actor,
                decidedAt: new Date().toISOString(),
                proposalId,
                verifiedExternalReferences,
                workspaceId,
              });
              recordWorkspaceAuditEvent({
                workspaceDb,
                workspaceId,
                requestId: commandInput.requestId,
                actor,
                category: 'knowledge',
                action: auditIdentity.action,
                resource: `knowledge-proposal:${proposalId}`,
                outcome: 'succeeded',
                severity: 'info',
                summary: 'Knowledge proposal decision recorded.',
              });
              return SubmitKnowledgeProposalDecisionResponseSchema.parse(executed);
            },
            replay: (record) => {
              if (
                record.response.kind !== 'knowledge_proposal_review' ||
                record.response.id !== reviewId
              ) {
                throw knowledgeProposalAuthorityFailure('recovery_required');
              }
              const replayed = store.projectKnowledgeProposalDecision(workspaceId, reviewId);
              if (
                replayed.review.proposalId !== proposalId ||
                replayed.review.workspaceId !== workspaceId ||
                replayed.review.reviewId !== reviewId ||
                replayed.review.requestId !== commandInput.requestId ||
                replayed.review.decision !== commandInput.decision ||
                replayed.review.knowledgePageId !== proposal.knowledgePageId ||
                replayed.review.contentDigest !== proposal.contentDigest ||
                JSON.stringify(replayed.review.actor) !== JSON.stringify(actor) ||
                knowledgeProposalAuditCount(workspaceDb, auditIdentity) !== 1
              ) {
                throw knowledgeProposalAuthorityFailure('recovery_required');
              }
              return SubmitKnowledgeProposalDecisionResponseSchema.parse(replayed);
            },
            responseId: (result) => result.review.reviewId,
          });

          return response;
        } finally {
          workspaceDb.sqlite.close();
        }
      } catch (error) {
        if (error instanceof KnowledgeOperationError) throw error;
        return knowledgeProposalCommandFailure(error, 'knowledge_proposal_review_failed');
      }
    },
    'knowledge.proposal.reverse': async (input, actor) => {
      const { workspaceId, proposalId, ...commandInput } = input;

      try {
        const proposal = requireAuthorizedKnowledgeProposal(store, workspaceId, proposalId);
        if (!coreDb) {
          throw new KnowledgeOperationError(
            'Knowledge Proposal command storage is unavailable.',
            'knowledge_proposal_storage_unavailable',
            503
          );
        }

        const scope = { workspaceId, proposalId };
        const auditIdentity = {
          action: 'knowledge.proposal.reverse' as const,
          actor,
          proposalId,
          requestId: commandInput.requestId,
          workspaceId,
        };
        const workspaceDb = repositoryWorkspaceDb(workspaceId);
        try {
          const receipt = store.getCommandRequest(
            'knowledge.proposal.reverse',
            commandInput.requestId,
            scope,
            workspaceDb
          );
          if (!receipt && knowledgeProposalAuditCount(workspaceDb, auditIdentity, false) !== 0) {
            throw knowledgeProposalAuthorityFailure('recovery_required');
          }

          const response = await runIdempotentCommand({
            store,
            inflightCommands,
            command: 'knowledge.proposal.reverse',
            requestId: commandInput.requestId,
            scope,
            input: { ...commandInput, actor, proposalId },
            responseKind: 'knowledge_proposal',
            workspaceDb,
            execute: () => {
              const executed = store.reverseKnowledgeProposalApplication({
                workspaceId,
                proposalId,
                reviewId: commandInput.reviewId,
                knowledgePageId: commandInput.knowledgePageId,
                expectedContentDigest: commandInput.expectedContentDigest,
              });
              recordWorkspaceAuditEvent({
                workspaceDb,
                workspaceId,
                requestId: commandInput.requestId,
                actor,
                category: 'knowledge',
                action: auditIdentity.action,
                resource: `knowledge-proposal:${proposalId}`,
                outcome: 'succeeded',
                severity: 'info',
                summary: 'Knowledge proposal application reversed.',
              });
              return ReverseKnowledgeProposalResponseSchema.parse(executed);
            },
            replay: (record) => {
              if (
                record.response.kind !== 'knowledge_proposal' ||
                record.response.id !== proposalId
              ) {
                throw knowledgeProposalAuthorityFailure('recovery_required');
              }
              const replayed = store.projectKnowledgeProposalReversal({
                workspaceId,
                proposalId,
                reviewId: commandInput.reviewId,
                knowledgePageId: commandInput.knowledgePageId,
                expectedContentDigest: commandInput.expectedContentDigest,
              });
              if (
                replayed.proposalId !== proposalId ||
                replayed.reviewId !== commandInput.reviewId ||
                replayed.application.knowledgePageId !== proposal.knowledgePageId ||
                replayed.application.contentDigest !== proposal.contentDigest ||
                replayed.application.present !== false ||
                knowledgeProposalAuditCount(workspaceDb, auditIdentity) !== 1
              ) {
                throw knowledgeProposalAuthorityFailure('recovery_required');
              }
              return ReverseKnowledgeProposalResponseSchema.parse(replayed);
            },
            responseId: (result) => result.proposalId,
          });

          return response;
        } finally {
          workspaceDb.sqlite.close();
        }
      } catch (error) {
        if (error instanceof KnowledgeOperationError) throw error;
        return knowledgeProposalCommandFailure(error, 'knowledge_proposal_reversal_failed');
      }
    },
    'knowledge.list': async (input, _actor) => {
      const { workspaceId } = input;

      try {
        return ListKnowledgeEntriesResponseSchema.parse({
          items: store.listKnowledge(workspaceId),
        });
      } catch (error) {
        throw new KnowledgeOperationError(publishedErrorMessage(error));
      }
    },
    'knowledge.create': async (input, actor) => {
      const { workspaceId, ...commandInput } = input;

      try {
        const knowledge = await runIdempotentCommand({
          store,
          inflightCommands,
          command: 'knowledge.create',
          requestId: commandInput.requestId,
          scope: { workspaceId },
          input: { ...commandInput, workspaceId },
          responseKind: 'knowledge',
          execute: () =>
            KnowledgeEntrySchema.parse(store.createKnowledgeEntry(workspaceId, commandInput)),
          replay: (record) =>
            KnowledgeEntrySchema.parse(store.getKnowledgeEntry(workspaceId, record.response.id)),
          responseId: (result) => result.id,
        });
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
    'knowledge.update': async (input, actor) => {
      const { workspaceId, knowledgeEntryId, ...commandInput } = input;

      readAuthorizedKnowledgeOwner(workspaceId, () => {
        store.getKnowledgeEntry(workspaceId, knowledgeEntryId);
        return { workspaceId };
      });

      try {
        const knowledge = await runIdempotentCommand({
          store,
          inflightCommands,
          command: 'knowledge.update',
          requestId: commandInput.requestId,
          scope: { workspaceId, knowledgeEntryId },
          input: { ...commandInput, workspaceId, knowledgeEntryId },
          responseKind: 'knowledge',
          execute: () =>
            KnowledgeEntrySchema.parse(
              store.updateKnowledgeEntry(workspaceId, knowledgeEntryId, commandInput)
            ),
          replay: (record) =>
            KnowledgeEntrySchema.parse(store.getKnowledgeEntry(workspaceId, record.response.id)),
          responseId: (result) => result.id,
        });
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
    'knowledge.delete': async (input, actor) => {
      const { workspaceId, knowledgeEntryId, ...commandInput } = input;

      try {
        await runIdempotentCommand({
          store,
          inflightCommands,
          command: 'knowledge.delete',
          requestId: commandInput.requestId,
          scope: { workspaceId, knowledgeEntryId },
          input: { ...commandInput, workspaceId, knowledgeEntryId },
          responseKind: 'knowledge',
          execute: () => {
            // A retained command receipt must replay after deletion; a new command still proves the child owner before effects.
            readAuthorizedKnowledgeOwner(workspaceId, () => {
              store.getKnowledgeEntry(workspaceId, knowledgeEntryId);
              return { workspaceId };
            });
            store.deleteKnowledgeEntry(workspaceId, knowledgeEntryId);
          },
          replay: () => undefined,
          responseId: () => knowledgeEntryId,
        });
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
        throw commandFailure(error, 'knowledge_delete_failed');
      }
    },
  };
}
