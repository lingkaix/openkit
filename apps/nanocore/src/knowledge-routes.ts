import { createHash, randomUUID } from 'node:crypto';

import {
  KnowledgeDerivedIndexesResponseSchema,
  KnowledgeManagerAnswerRequestSchema,
  KnowledgeManagerAnswerResponseSchema,
  KnowledgeManagerDraftProposalRequestSchema,
  KnowledgeManagerDraftProposalResponseSchema,
  KnowledgeManagerHealthCheckRequestSchema,
  KnowledgeManagerHealthCheckResponseSchema,
  KnowledgeManagerPrepareContextRequestSchema,
  KnowledgeManagerPrepareContextResponseSchema,
  KnowledgeManagerSuggestRepairRequestSchema,
  KnowledgeManagerSuggestRepairResponseSchema,
  KnowledgeRetrievalResponseSchema,
  ListKnowledgeClaimsResponseSchema,
  ListKnowledgeConflictsResponseSchema,
  ListKnowledgeObservationsResponseSchema,
  ListKnowledgeSourcesResponseSchema,
  MaterializeKnowledgeContextPackageResponseSchema,
  ReadKnowledgeManagerContextPackageTraceResponseSchema,
  ReadKnowledgeSourceResponseSchema,
  RecordKnowledgeClaimRequestSchema,
  RecordKnowledgeClaimResponseSchema,
  RecordKnowledgeConflictRequestSchema,
  RecordKnowledgeConflictResponseSchema,
  RecordKnowledgeObservationRequestSchema,
  RecordKnowledgeObservationResponseSchema,
  RegisterKnowledgeSourceRequestSchema,
  RegisterKnowledgeSourceResponseSchema,
  ResolveKnowledgeConflictRequestSchema,
  ResolveKnowledgeConflictResponseSchema,
  RetrieveKnowledgeRequestSchema,
} from '@openkit/app-api-schemas';
import type { MaterializedWorkspaceRoot as ConfigMaterializedWorkspaceRoot } from '@openkit/config-schema';
import {
  type ActorRef,
  CreateKnowledgeEntryRequestSchema,
  DeleteKnowledgeEntryRequestSchema,
  KnowledgeEntrySchema,
  ListKnowledgeEntriesResponseSchema,
  UpdateKnowledgeEntryRequestSchema,
} from '@openkit/protocol';
import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

import { asApiError, asCommandError, asInvalidRequestError } from './api-errors.js';
import type { AuthVariables } from './auth/middleware.js';
import { assertAuthorizedWorkspaceLineage } from './auth/operation-authorizer.js';
import {
  finishCapabilityCall,
  normalizeCapabilityRequestId,
  recordUsage,
  startCapabilityCall,
} from './capability/usage-ledger.js';
import {
  answerKnowledgeManager,
  checkKnowledgeHealth,
  draftKnowledgeProposal,
  prepareKnowledgeContext,
  resolveRetrievedKnowledgeEntries,
  suggestKnowledgeRepairs,
} from './knowledge-manager.js';
import type { FsStore } from './lib/store.js';
import { registerAppApiRoute } from './openapi.js';
import {
  IdempotencyKeyConflictError,
  type InflightIdempotentCommand,
  runIdempotentCommand,
} from './runtime/idempotent-command.js';
import type { CoreDb } from './storage/db.js';
import { openWorkspaceDb } from './storage/db.js';
import {
  readWorkspaceKnowledgeDerivedIndexes,
  retrieveWorkspaceKnowledge,
} from './storage/index-rebuild.js';
import { applyScopedMigrations } from './storage/migrate.js';

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
 * Registers the complete workspace Knowledge API feature path.
 *
 * @param dependencies Hono app and request-scoped Knowledge dependencies.
 */
export function registerKnowledgeRoutes({
  app,
  coreDb,
  inflightCommands,
  requestStore,
  workspaceRootsForContextPackage,
}: {
  readonly app: Hono<{ Variables: AuthVariables }>;
  readonly coreDb: CoreDb | undefined;
  readonly inflightCommands: WeakMap<FsStore, Map<string, InflightIdempotentCommand>>;
  readonly requestStore: (context: Context<{ Variables: AuthVariables }>) => FsStore;
  readonly workspaceRootsForContextPackage: (
    store: FsStore,
    workspaceId: string
  ) => ConfigMaterializedWorkspaceRoot[];
}): void {
  app.get('/api/workspaces/:workspaceId/knowledge', (c) => {
    try {
      return c.json(
        ListKnowledgeEntriesResponseSchema.parse({
          items: requestStore(c).listKnowledge(c.req.param('workspaceId')),
        })
      );
    } catch (error) {
      return asApiError((error as Error).message);
    }
  });

  app.post('/api/workspaces/:workspaceId/knowledge', async (c) => {
    const parsed = CreateKnowledgeEntryRequestSchema.safeParse(
      await c.req.json().catch(() => ({}))
    );

    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    try {
      const store = requestStore(c);
      const workspaceId = c.req.param('workspaceId');
      const knowledge = await runIdempotentCommand({
        store,
        inflightCommands,
        command: 'knowledge.create',
        requestId: parsed.data.requestId,
        scope: { workspaceId },
        input: { ...parsed.data, workspaceId },
        responseKind: 'knowledge',
        execute: () =>
          KnowledgeEntrySchema.parse(store.createKnowledgeEntry(workspaceId, parsed.data)),
        replay: (record) =>
          KnowledgeEntrySchema.parse(store.getKnowledgeEntry(workspaceId, record.response.id)),
        responseId: (result) => result.id,
      });
      recordKnowledgeGatewayUsage({
        authorityActor: { kind: 'user', id: c.get('actor').userId },
        capabilityId: 'knowledge.entry.create',
        operation: 'knowledge.entry.create',
        requestId: parsed.data.requestId,
        serviceRef: 'knowledge-store',
        summary: `Knowledge entry ${knowledge.id} created.`,
        usageSource: 'knowledge-entry-create',
        workspaceId,
        ...(coreDb ? { coreDb: coreDb } : {}),
      });

      return c.json(knowledge, 201);
    } catch (error) {
      return asCommandError(error, 'knowledge_create_failed');
    }
  });

  app.patch('/api/workspaces/:workspaceId/knowledge/:knowledgeEntryId', async (c) => {
    const parsed = UpdateKnowledgeEntryRequestSchema.safeParse(
      await c.req.json().catch(() => ({}))
    );

    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    const store = requestStore(c);
    const workspaceId = c.req.param('workspaceId');
    const knowledgeEntryId = c.req.param('knowledgeEntryId');
    assertKnowledgeEntryWorkspaceLineage(c, store, workspaceId, knowledgeEntryId);

    try {
      const knowledge = await runIdempotentCommand({
        store,
        inflightCommands,
        command: 'knowledge.update',
        requestId: parsed.data.requestId,
        scope: { workspaceId, knowledgeEntryId },
        input: { ...parsed.data, workspaceId, knowledgeEntryId },
        responseKind: 'knowledge',
        execute: () =>
          KnowledgeEntrySchema.parse(
            store.updateKnowledgeEntry(workspaceId, knowledgeEntryId, parsed.data)
          ),
        replay: (record) =>
          KnowledgeEntrySchema.parse(store.getKnowledgeEntry(workspaceId, record.response.id)),
        responseId: (result) => result.id,
      });
      recordKnowledgeGatewayUsage({
        authorityActor: { kind: 'user', id: c.get('actor').userId },
        capabilityId: 'knowledge.entry.update',
        operation: 'knowledge.entry.update',
        requestId: parsed.data.requestId,
        serviceRef: 'knowledge-store',
        summary: `Knowledge entry ${knowledge.id} updated.`,
        usageSource: 'knowledge-entry-update',
        workspaceId,
        ...(coreDb ? { coreDb: coreDb } : {}),
      });

      return c.json(knowledge);
    } catch (error) {
      return asCommandError(error, 'knowledge_update_failed');
    }
  });

  app.delete('/api/workspaces/:workspaceId/knowledge/:knowledgeEntryId', async (c) => {
    const parsed = DeleteKnowledgeEntryRequestSchema.safeParse(
      await c.req.json().catch(() => ({}))
    );

    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    const store = requestStore(c);
    const workspaceId = c.req.param('workspaceId');
    const knowledgeEntryId = c.req.param('knowledgeEntryId');
    assertKnowledgeEntryWorkspaceLineage(c, store, workspaceId, knowledgeEntryId);

    try {
      await runIdempotentCommand({
        store,
        inflightCommands,
        command: 'knowledge.delete',
        requestId: parsed.data.requestId,
        scope: { workspaceId, knowledgeEntryId },
        input: { ...parsed.data, workspaceId, knowledgeEntryId },
        responseKind: 'knowledge',
        execute: () => {
          store.deleteKnowledgeEntry(workspaceId, knowledgeEntryId);
        },
        replay: () => undefined,
        responseId: () => knowledgeEntryId,
      });
      recordKnowledgeGatewayUsage({
        authorityActor: { kind: 'user', id: c.get('actor').userId },
        capabilityId: 'knowledge.entry.delete',
        operation: 'knowledge.entry.delete',
        requestId: parsed.data.requestId,
        serviceRef: 'knowledge-store',
        summary: `Knowledge entry ${knowledgeEntryId} deleted.`,
        usageSource: 'knowledge-entry-delete',
        workspaceId,
        ...(coreDb ? { coreDb: coreDb } : {}),
      });

      return c.body(null, 204);
    } catch (error) {
      return asCommandError(error, 'knowledge_delete_failed');
    }
  });

  registerAppApiRoute(app, 'registerKnowledgeSource', async (c) => {
    const parsed = RegisterKnowledgeSourceRequestSchema.safeParse(
      await c.req.json().catch(() => ({}))
    );

    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    try {
      const store = requestStore(c);
      const workspaceId = c.req.param('workspaceId');
      const now = new Date().toISOString();
      const source = await runIdempotentCommand({
        store,
        inflightCommands,
        command: 'knowledge.source.register',
        requestId: parsed.data.requestId,
        scope: { workspaceId, title: parsed.data.title },
        input: { ...parsed.data, workspaceId },
        responseKind: 'knowledge_source',
        execute: () =>
          store.createKnowledgeSource(
            {
              id: `ks_${randomUUID()}`,
              workspaceId,
              kind: parsed.data.kind,
              title: parsed.data.title,
              uri: parsed.data.uri ?? null,
              contentDigest: `sha256:${createHash('sha256')
                .update(parsed.data.content)
                .digest('hex')}`,
              originatingThreadId: parsed.data.originatingThreadId ?? null,
              originatingTurnId: parsed.data.originatingTurnId ?? null,
              originatingFileId: parsed.data.originatingFileId ?? null,
              capturedAt: now,
              createdAt: now,
              updatedAt: now,
            },
            parsed.data.content
          ),
        replay: (record) => store.getKnowledgeSource(workspaceId, record.response.id),
        responseId: (result) => result.id,
      });
      recordKnowledgeGatewayUsage({
        authorityActor: { kind: 'user', id: c.get('actor').userId },
        capabilityId: 'knowledge.source.register',
        operation: 'knowledge.source.register',
        requestId: parsed.data.requestId,
        serviceRef: 'knowledge-store',
        summary: `Knowledge source ${source.id} registered.`,
        usageSource: 'knowledge-source-register',
        workspaceId,
        ...(coreDb ? { coreDb: coreDb } : {}),
      });

      return c.json(
        RegisterKnowledgeSourceResponseSchema.parse({
          source,
          derivedRepresentations: store.listKnowledgeSourceDerivedRepresentations(
            workspaceId,
            source.id
          ),
        }),
        201
      );
    } catch (error) {
      return asCommandError(error, 'knowledge_source_register_failed');
    }
  });

  registerAppApiRoute(app, 'listKnowledgeSources', (c) => {
    try {
      return c.json(
        ListKnowledgeSourcesResponseSchema.parse({
          items: requestStore(c).listKnowledgeSources(c.req.param('workspaceId')),
        })
      );
    } catch (error) {
      return asApiError((error as Error).message, 'knowledge_source_list_failed', 404);
    }
  });

  registerAppApiRoute(app, 'recordKnowledgeObservation', async (c) => {
    const parsed = RecordKnowledgeObservationRequestSchema.safeParse(
      await c.req.json().catch(() => ({}))
    );

    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    try {
      const store = requestStore(c);
      const workspaceId = c.req.param('workspaceId');
      const now = new Date().toISOString();
      const observedAt = parsed.data.observedAt ?? now;
      const observation = await runIdempotentCommand({
        store,
        inflightCommands,
        command: 'knowledge.observation.record',
        requestId: parsed.data.requestId,
        scope: { workspaceId, summary: parsed.data.summary },
        input: { ...parsed.data, workspaceId },
        responseKind: 'knowledge_observation',
        execute: () =>
          store.recordKnowledgeObservation({
            id: `ko_${randomUUID()}`,
            workspaceId,
            kind: parsed.data.kind,
            summary: parsed.data.summary,
            sourceReferences: parsed.data.sourceReferences,
            scope: parsed.data.scope,
            producer: parsed.data.producer,
            confidence: parsed.data.confidence,
            freshness: parsed.data.freshness,
            status: parsed.data.status,
            observedAt,
            createdAt: now,
          }),
        replay: (record) => store.getKnowledgeObservation(workspaceId, record.response.id),
        responseId: (result) => result.id,
      });
      recordKnowledgeGatewayUsage({
        authorityActor: { kind: 'user', id: c.get('actor').userId },
        capabilityId: 'knowledge.observation.record',
        operation: 'knowledge.observation.record',
        requestId: parsed.data.requestId,
        serviceRef: 'knowledge-store',
        summary: `Knowledge observation ${observation.id} recorded.`,
        usageSource: 'knowledge-observation-record',
        workspaceId,
        ...(coreDb ? { coreDb: coreDb } : {}),
      });

      return c.json(RecordKnowledgeObservationResponseSchema.parse({ observation }), 201);
    } catch (error) {
      return asCommandError(error, 'knowledge_observation_record_failed');
    }
  });

  registerAppApiRoute(app, 'listKnowledgeObservations', (c) => {
    try {
      return c.json(
        ListKnowledgeObservationsResponseSchema.parse({
          items: requestStore(c).listKnowledgeObservations(c.req.param('workspaceId')),
        })
      );
    } catch (error) {
      return asApiError((error as Error).message, 'knowledge_observation_list_failed', 404);
    }
  });

  registerAppApiRoute(app, 'recordKnowledgeClaim', async (c) => {
    const parsed = RecordKnowledgeClaimRequestSchema.safeParse(
      await c.req.json().catch(() => ({}))
    );

    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    try {
      const store = requestStore(c);
      const workspaceId = c.req.param('workspaceId');
      const now = new Date().toISOString();
      const claim = await runIdempotentCommand({
        store,
        inflightCommands,
        command: 'knowledge.claim.record',
        requestId: parsed.data.requestId,
        scope: { workspaceId, statement: parsed.data.statement },
        input: { ...parsed.data, workspaceId },
        responseKind: 'knowledge_claim',
        execute: () =>
          store.recordKnowledgeClaim({
            id: `kc_${randomUUID()}`,
            workspaceId,
            statement: parsed.data.statement,
            sourceReferences: parsed.data.sourceReferences,
            scope: parsed.data.scope,
            producer: parsed.data.producer,
            confidence: parsed.data.confidence,
            freshness: parsed.data.freshness,
            reviewState: parsed.data.reviewState,
            conflictStatus: parsed.data.conflictStatus,
            createdAt: now,
            updatedAt: now,
          }),
        replay: (record) => store.getKnowledgeClaim(workspaceId, record.response.id),
        responseId: (result) => result.id,
      });
      recordKnowledgeGatewayUsage({
        authorityActor: { kind: 'user', id: c.get('actor').userId },
        capabilityId: 'knowledge.claim.record',
        operation: 'knowledge.claim.record',
        requestId: parsed.data.requestId,
        serviceRef: 'knowledge-store',
        summary: `Knowledge claim ${claim.id} recorded.`,
        usageSource: 'knowledge-claim-record',
        workspaceId,
        ...(coreDb ? { coreDb: coreDb } : {}),
      });

      return c.json(RecordKnowledgeClaimResponseSchema.parse({ claim }), 201);
    } catch (error) {
      return asCommandError(error, 'knowledge_claim_record_failed');
    }
  });

  registerAppApiRoute(app, 'listKnowledgeClaims', (c) => {
    try {
      return c.json(
        ListKnowledgeClaimsResponseSchema.parse({
          items: requestStore(c).listKnowledgeClaims(c.req.param('workspaceId')),
        })
      );
    } catch (error) {
      return asApiError((error as Error).message, 'knowledge_claim_list_failed', 404);
    }
  });

  registerAppApiRoute(app, 'recordKnowledgeConflict', async (c) => {
    const parsed = RecordKnowledgeConflictRequestSchema.safeParse(
      await c.req.json().catch(() => ({}))
    );

    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    try {
      const store = requestStore(c);
      const workspaceId = c.req.param('workspaceId');
      const now = new Date().toISOString();
      const conflict = await runIdempotentCommand({
        store,
        inflightCommands,
        command: 'knowledge.conflict.record',
        requestId: parsed.data.requestId,
        scope: { workspaceId, summary: parsed.data.summary },
        input: { ...parsed.data, workspaceId },
        responseKind: 'knowledge_conflict',
        execute: () =>
          store.recordKnowledgeConflict({
            id: `kf_${randomUUID()}`,
            workspaceId,
            subjectReferences: parsed.data.subjectReferences,
            sourceReferences: parsed.data.sourceReferences,
            status: parsed.data.status,
            summary: parsed.data.summary,
            suggestedActions: parsed.data.suggestedActions,
            producer: parsed.data.producer,
            createdAt: now,
            updatedAt: now,
          }),
        replay: (record) => store.getKnowledgeConflict(workspaceId, record.response.id),
        responseId: (result) => result.id,
      });
      recordKnowledgeGatewayUsage({
        authorityActor: { kind: 'user', id: c.get('actor').userId },
        capabilityId: 'knowledge.conflict.record',
        operation: 'knowledge.conflict.record',
        requestId: parsed.data.requestId,
        serviceRef: 'knowledge-store',
        summary: `Knowledge conflict ${conflict.id} recorded.`,
        usageSource: 'knowledge-conflict-record',
        workspaceId,
        ...(coreDb ? { coreDb: coreDb } : {}),
      });

      return c.json(RecordKnowledgeConflictResponseSchema.parse({ conflict }), 201);
    } catch (error) {
      return asCommandError(error, 'knowledge_conflict_record_failed');
    }
  });

  registerAppApiRoute(app, 'listKnowledgeConflicts', (c) => {
    try {
      return c.json(
        ListKnowledgeConflictsResponseSchema.parse({
          items: requestStore(c).listKnowledgeConflicts(c.req.param('workspaceId')),
        })
      );
    } catch (error) {
      return asApiError((error as Error).message, 'knowledge_conflict_list_failed', 404);
    }
  });

  registerAppApiRoute(app, 'resolveKnowledgeConflict', async (c) => {
    const parsed = ResolveKnowledgeConflictRequestSchema.safeParse(
      await c.req.json().catch(() => ({}))
    );

    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    try {
      const store = requestStore(c);
      const workspaceId = c.req.param('workspaceId');
      const conflictId = c.req.param('conflictId');
      readAuthorizedKnowledgeOwner(c, () => store.getKnowledgeConflict(workspaceId, conflictId));
      const now = new Date().toISOString();
      const conflict = await runIdempotentCommand({
        store,
        inflightCommands,
        command: 'knowledge.conflict.resolve',
        requestId: parsed.data.requestId,
        scope: { workspaceId, conflictId },
        input: { ...parsed.data, workspaceId, conflictId },
        responseKind: 'knowledge_conflict',
        execute: () =>
          store.resolveKnowledgeConflict({
            workspaceId,
            conflictId,
            status: parsed.data.status,
            resolution: parsed.data.resolution,
            resolvedBy: parsed.data.resolvedBy,
            resolvedAt: now,
          }),
        replay: (record) => store.getKnowledgeConflict(workspaceId, record.response.id),
        responseId: (result) => result.id,
      });
      recordKnowledgeGatewayUsage({
        authorityActor: { kind: 'user', id: c.get('actor').userId },
        capabilityId: 'knowledge.conflict.resolve',
        operation: 'knowledge.conflict.resolve',
        requestId: parsed.data.requestId,
        serviceRef: 'knowledge-store',
        summary: `Knowledge conflict ${conflict.id} resolved.`,
        usageSource: 'knowledge-conflict-resolve',
        workspaceId,
        ...(coreDb ? { coreDb: coreDb } : {}),
      });

      return c.json(ResolveKnowledgeConflictResponseSchema.parse({ conflict }));
    } catch (error) {
      if (error instanceof HTTPException) {
        throw error;
      }
      return asCommandError(error, 'knowledge_conflict_resolve_failed');
    }
  });

  registerAppApiRoute(app, 'readKnowledgeIndexes', (c) => {
    try {
      const store = requestStore(c);
      const dataRoot = store.getDataRoot();

      if (!dataRoot) {
        return asApiError(
          'Knowledge indexes require a file-backed data root.',
          'data_root_required',
          409
        );
      }

      return c.json(
        KnowledgeDerivedIndexesResponseSchema.parse(
          readWorkspaceKnowledgeDerivedIndexes({
            dataRoot,
            workspaceId: c.req.param('workspaceId'),
          })
        )
      );
    } catch (error) {
      return asApiError((error as Error).message, 'knowledge_indexes_read_failed', 404);
    }
  });

  registerAppApiRoute(app, 'retrieveKnowledge', async (c) => {
    const parsed = RetrieveKnowledgeRequestSchema.safeParse(await c.req.json().catch(() => ({})));

    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    try {
      const store = requestStore(c);
      const dataRoot = store.getDataRoot();
      const workspaceId = c.req.param('workspaceId');

      if (!dataRoot) {
        return asApiError(
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
          query: parsed.data.query,
          limit: parsed.data.limit,
          pinnedConceptIds: parsed.data.pinnedConceptIds,
          traceId: `krt_${randomUUID()}`,
        })
      );
      recordKnowledgeGatewayUsage({
        authorityActor: { kind: 'user', id: c.get('actor').userId },
        capabilityId: 'knowledge.retrieval',
        operation: 'knowledge.retrieval',
        serviceRef: 'knowledge-store',
        summary: `Knowledge retrieval selected ${response.selected.length} candidates.`,
        usageSource: 'knowledge-retrieval',
        workspaceId,
        ...(coreDb ? { coreDb: coreDb } : {}),
      });

      return c.json(response);
    } catch {
      return asApiError('Knowledge retrieval failed.', 'knowledge_retrieval_failed', 500);
    }
  });

  registerAppApiRoute(app, 'readKnowledgeSource', (c) => {
    try {
      const store = requestStore(c);
      const workspaceId = c.req.param('workspaceId');
      const sourceId = c.req.param('sourceId');
      const source = readAuthorizedKnowledgeOwner(c, () =>
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
        authorityActor: { kind: 'user', id: c.get('actor').userId },
        capabilityId: 'knowledge.source.read',
        operation: 'knowledge.source.read',
        serviceRef: 'knowledge-store',
        summary: `Knowledge source ${sourceId} read.`,
        usageSource: 'knowledge-source-read',
        workspaceId,
        ...(coreDb ? { coreDb: coreDb } : {}),
      });

      return c.json(response);
    } catch (error) {
      if (error instanceof HTTPException) {
        throw error;
      }
      return asApiError((error as Error).message, 'knowledge_source_not_found', 404);
    }
  });

  registerAppApiRoute(app, 'answerKnowledgeManager', async (c) => {
    const parsed = KnowledgeManagerAnswerRequestSchema.safeParse(
      await c.req.json().catch(() => ({}))
    );

    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    try {
      const store = requestStore(c);
      const workspaceId = c.req.param('workspaceId');
      const dataRoot = store.getDataRoot();

      if (!dataRoot) {
        throw new Error('Knowledge Manager answer requires a file-backed data root.');
      }

      const retrieval = retrieveWorkspaceKnowledge({
        dataRoot,
        workspaceId,
        caller: 'app-api',
        query: parsed.data.query,
        limit: parsed.data.limit,
        traceId: `krt_${randomUUID()}`,
      });
      const response = answerKnowledgeManager({
        operationId: `km_answer_${randomUUID()}`,
        workspaceId,
        caller: 'app-api',
        query: parsed.data.query,
        retrievalTraceId: retrieval.traceId,
        entries: resolveRetrievedKnowledgeEntries(
          store.listKnowledge(workspaceId),
          retrieval.selected
        ),
      });
      recordKnowledgeGatewayUsage({
        authorityActor: { kind: 'user', id: c.get('actor').userId },
        capabilityId: 'knowledge.answer',
        operation: 'knowledge.answer',
        serviceRef: 'knowledge-manager',
        summary: `Knowledge answer completed with ${response.citations.length} citations.`,
        usageSource: 'knowledge-answer',
        workspaceId,
        ...(coreDb ? { coreDb: coreDb } : {}),
      });

      return c.json(KnowledgeManagerAnswerResponseSchema.parse(response));
    } catch {
      return asApiError('Knowledge Manager answer failed.', 'knowledge_manager_answer_failed', 500);
    }
  });

  registerAppApiRoute(app, 'prepareKnowledgeContext', async (c) => {
    const parsed = KnowledgeManagerPrepareContextRequestSchema.safeParse(
      await c.req.json().catch(() => ({}))
    );

    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    try {
      const store = requestStore(c);
      const workspaceId = c.req.param('workspaceId');
      const dataRoot = store.getDataRoot();

      if (!dataRoot) {
        throw new Error('Knowledge Manager context requires a file-backed data root.');
      }

      const workspaceRoots =
        (parsed.data.workspaceRootFiles ?? []).length > 0
          ? workspaceRootsForContextPackage(store, workspaceId)
          : [];
      const retrieval = retrieveWorkspaceKnowledge({
        dataRoot,
        workspaceId,
        caller: 'app-api',
        query: parsed.data.query,
        limit: parsed.data.limit,
        traceId: `krt_${randomUUID()}`,
      });
      const response = prepareKnowledgeContext({
        operationId: `km_context_${randomUUID()}`,
        workspaceId,
        caller: 'app-api',
        query: parsed.data.query,
        limit: parsed.data.limit,
        retrievalTraceId: retrieval.traceId,
        entries: resolveRetrievedKnowledgeEntries(
          store.listKnowledge(workspaceId),
          retrieval.selected
        ),
        claims: store.listKnowledgeClaims(workspaceId),
        conflicts: store.listKnowledgeConflicts(workspaceId),
        artifacts: parsed.data.artifactIds.map((artifactId) =>
          store.getArtifact(workspaceId, artifactId)
        ),
        workspaceFiles: (parsed.data.workspaceFiles ?? []).map(({ path }) => {
          const file = store.readWorkspaceContextFileMaterial(workspaceId, path);

          return {
            contentBytes: file.contentBytes,
            contentDigest: file.contentDigest,
            path: file.path,
          };
        }),
        workspaceRootFiles: (parsed.data.workspaceRootFiles ?? []).map(({ rootId, path }) => {
          const root = workspaceRoots.find((candidate) => candidate.id === rootId);

          if (!root) {
            throw new Error(`Workspace root not available for context file: ${rootId}`);
          }

          const file = store.readWorkspaceRootContextFileMaterial(root, path);

          return {
            contentBytes: file.contentBytes,
            contentDigest: file.contentDigest,
            path: file.path,
            rootId: file.rootId,
          };
        }),
      });
      store.recordKnowledgeContextPackageTrace({
        id: response.packageTrace.contextPackageId,
        workspaceId,
        operationId: response.operationId,
        createdAt: new Date().toISOString(),
        response,
      });
      recordKnowledgeGatewayUsage({
        authorityActor: { kind: 'user', id: c.get('actor').userId },
        capabilityId: 'knowledge.context.prepare',
        operation: 'knowledge.context.prepare',
        serviceRef: 'knowledge-manager',
        summary: `Knowledge context prepared ${response.packageTrace.selectedKnowledgeEntryIds.length} knowledge entries.`,
        usageSource: 'knowledge-context-prepare',
        workspaceId,
        ...(coreDb ? { coreDb: coreDb } : {}),
      });

      return c.json(KnowledgeManagerPrepareContextResponseSchema.parse(response));
    } catch {
      return asApiError(
        'Knowledge Manager context preparation failed.',
        'knowledge_manager_context_failed',
        500
      );
    }
  });

  registerAppApiRoute(app, 'readKnowledgeContextPackageTrace', async (c) => {
    try {
      const store = requestStore(c);
      const workspaceId = c.req.param('workspaceId');
      const contextPackageId = c.req.param('contextPackageId');
      const trace = readAuthorizedKnowledgeOwner(c, () =>
        store.readKnowledgeContextPackageTrace(workspaceId, contextPackageId)
      );
      if (!trace) {
        return asApiError(
          'Knowledge context package trace not found.',
          'knowledge_context_package_trace_not_found',
          404
        );
      }

      return c.json(ReadKnowledgeManagerContextPackageTraceResponseSchema.parse({ trace }));
    } catch (error) {
      if (error instanceof HTTPException) {
        throw error;
      }
      return asApiError(
        (error as Error).message,
        'knowledge_context_package_trace_read_failed',
        500
      );
    }
  });

  registerAppApiRoute(app, 'materializeKnowledgeContextPackage', async (c) => {
    try {
      const store = requestStore(c);
      const workspaceId = c.req.param('workspaceId');
      const contextPackageId = c.req.param('contextPackageId');
      const trace = readAuthorizedKnowledgeOwner(c, () =>
        store.readKnowledgeContextPackageTrace(workspaceId, contextPackageId)
      );
      if (!trace) {
        return asApiError(
          'Knowledge context package trace not found.',
          'knowledge_context_package_trace_not_found',
          404
        );
      }

      const workspaceRoots =
        (trace.response.workspaceRootFiles ?? []).length > 0
          ? workspaceRootsForContextPackage(store, trace.workspaceId)
          : [];

      return c.json(
        MaterializeKnowledgeContextPackageResponseSchema.parse(
          store.materializeKnowledgeContextPackageTrace(trace, { workspaceRoots })
        )
      );
    } catch (error) {
      if (error instanceof HTTPException) {
        throw error;
      }
      return asApiError(
        (error as Error).message,
        'knowledge_context_package_materialization_failed',
        500
      );
    }
  });

  registerAppApiRoute(app, 'readKnowledgeContextPackageMaterialization', async (c) => {
    try {
      const store = requestStore(c);
      const workspaceId = c.req.param('workspaceId');
      const contextPackageId = c.req.param('contextPackageId');
      readAuthorizedKnowledgeOwner(c, () =>
        store.readKnowledgeContextPackageTrace(workspaceId, contextPackageId)
      );
      const materialization = store.readKnowledgeContextPackageMaterialization(
        workspaceId,
        contextPackageId
      );

      if (!materialization) {
        return asApiError(
          'Knowledge context package materialization not found.',
          'knowledge_context_package_materialization_not_found',
          404
        );
      }

      return c.json(MaterializeKnowledgeContextPackageResponseSchema.parse(materialization));
    } catch (error) {
      if (error instanceof HTTPException) {
        throw error;
      }
      return asApiError(
        (error as Error).message,
        'knowledge_context_package_materialization_read_failed',
        500
      );
    }
  });

  registerAppApiRoute(app, 'draftKnowledgeProposal', async (c) => {
    const parsed = KnowledgeManagerDraftProposalRequestSchema.safeParse(
      await c.req.json().catch(() => ({}))
    );

    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    try {
      const store = requestStore(c);
      const workspaceId = c.req.param('workspaceId');
      const now = new Date().toISOString();
      const proposalId = `kp_${randomUUID()}`;
      const proposal = await runIdempotentCommand({
        store,
        inflightCommands,
        command: 'knowledge.proposal.draft',
        requestId: parsed.data.requestId,
        scope: { workspaceId, title: parsed.data.title },
        input: parsed.data,
        responseKind: 'knowledge_proposal',
        execute: () =>
          store.createKnowledgeProposal({
            createdAt: now,
            id: proposalId,
            status: 'pending',
            summary: parsed.data.summary,
            title: parsed.data.title,
            updatedAt: now,
            workspaceId,
          }),
        replay: (record) => {
          const replayed = store.getKnowledgeProposal(record.response.id);

          if (!replayed) {
            throw new Error(`Knowledge proposal not found: ${record.response.id}`);
          }

          return replayed;
        },
        responseId: (result) => result.id,
      });
      const response = draftKnowledgeProposal({
        operationId: `km_proposal_${randomUUID()}`,
        workspaceId,
        caller: 'app-api',
        proposal,
        sourceReferences: parsed.data.sourceReferences,
        entries: store.listKnowledge(workspaceId),
        sources: store.listKnowledgeSources(workspaceId),
        confidence: parsed.data.confidence,
      });
      recordKnowledgeGatewayUsage({
        authorityActor: { kind: 'user', id: c.get('actor').userId },
        capabilityId: 'knowledge.proposal.draft',
        operation: 'knowledge.proposal.draft',
        requestId: parsed.data.requestId,
        serviceRef: 'knowledge-manager',
        summary: `Knowledge proposal ${proposal.id} drafted.`,
        usageSource: 'knowledge-proposal-draft',
        workspaceId,
        ...(coreDb ? { coreDb: coreDb } : {}),
      });

      return c.json(KnowledgeManagerDraftProposalResponseSchema.parse(response));
    } catch (error) {
      if (error instanceof IdempotencyKeyConflictError) {
        return asCommandError(error, 'knowledge_manager_proposal_draft_failed');
      }
      return asApiError(
        'Knowledge Manager proposal draft failed.',
        'knowledge_manager_proposal_draft_failed',
        500
      );
    }
  });

  registerAppApiRoute(app, 'suggestKnowledgeRepairs', async (c) => {
    const parsed = KnowledgeManagerSuggestRepairRequestSchema.safeParse(
      await c.req.json().catch(() => ({}))
    );

    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    try {
      const store = requestStore(c);
      const workspaceId = c.req.param('workspaceId');
      const response = suggestKnowledgeRepairs({
        operationId: `km_repair_${randomUUID()}`,
        workspaceId,
        caller: 'app-api',
        entries: store.listKnowledge(workspaceId),
        limit: parsed.data.limit,
      });
      recordKnowledgeGatewayUsage({
        authorityActor: { kind: 'user', id: c.get('actor').userId },
        capabilityId: 'knowledge.repair.suggest',
        operation: 'knowledge.repair.suggest',
        serviceRef: 'knowledge-manager',
        summary: `Knowledge repair suggestions returned ${response.suggestions.length} suggestions.`,
        usageSource: 'knowledge-repair-suggest',
        workspaceId,
        ...(coreDb ? { coreDb: coreDb } : {}),
      });

      return c.json(KnowledgeManagerSuggestRepairResponseSchema.parse(response));
    } catch {
      return asApiError(
        'Knowledge Manager repair suggestion failed.',
        'knowledge_manager_repair_suggest_failed',
        500
      );
    }
  });

  registerAppApiRoute(app, 'checkKnowledgeHealth', async (c) => {
    const parsed = KnowledgeManagerHealthCheckRequestSchema.safeParse(
      await c.req.json().catch(() => ({}))
    );

    if (!parsed.success) {
      return asInvalidRequestError(parsed.error);
    }

    try {
      const store = requestStore(c);
      const workspaceId = c.req.param('workspaceId');
      const response = checkKnowledgeHealth({
        operationId: `km_health_${randomUUID()}`,
        workspaceId,
        caller: 'app-api',
        entries: store.listKnowledge(workspaceId),
        limit: parsed.data.limit,
      });
      recordKnowledgeGatewayUsage({
        authorityActor: { kind: 'user', id: c.get('actor').userId },
        capabilityId: 'knowledge.health.check',
        operation: 'knowledge.health.check',
        serviceRef: 'knowledge-manager',
        summary: `Knowledge health completed with ${response.checks.length} checks.`,
        usageSource: 'knowledge-health-check',
        workspaceId,
        ...(coreDb ? { coreDb: coreDb } : {}),
      });

      return c.json(KnowledgeManagerHealthCheckResponseSchema.parse(response));
    } catch {
      return asApiError(
        'Knowledge Manager health check failed.',
        'knowledge_manager_health_check_failed',
        500
      );
    }
  });
}

/**
 * Requires one scoped Knowledge entry owner to match the centrally authorized Workspace.
 *
 * @param context Request context carrying optional central Workspace authorization.
 * @param store Product store containing the Knowledge entry owner.
 * @param workspaceId Workspace named by the route path.
 * @param knowledgeEntryId Knowledge entry named by the route path.
 */
function assertKnowledgeEntryWorkspaceLineage(
  context: Context<{ Variables: AuthVariables }>,
  store: FsStore,
  workspaceId: string,
  knowledgeEntryId: string
): void {
  if (!context.get('workspaceAccess')) {
    return;
  }
  readAuthorizedKnowledgeOwner(context, () => {
    store.getKnowledgeEntry(workspaceId, knowledgeEntryId);
    return { workspaceId };
  });
}

/**
 * Reads one scoped Knowledge owner and applies the uniform child-lineage fallback.
 *
 * @param context Request context carrying optional central Workspace authorization.
 * @param readOwner Existing scoped owner lookup.
 * @returns The owner, or null when the underlying nullable owner is absent without central authorization.
 * @throws The original lookup failure without central authorization, or uniform access denial when central authorization cannot prove the child lineage.
 */
function readAuthorizedKnowledgeOwner<T extends { readonly workspaceId: string }>(
  context: Context<{ Variables: AuthVariables }>,
  readOwner: () => T
): T;
function readAuthorizedKnowledgeOwner<T extends { readonly workspaceId: string }>(
  context: Context<{ Variables: AuthVariables }>,
  readOwner: () => T | null
): T | null;
function readAuthorizedKnowledgeOwner<T extends { readonly workspaceId: string }>(
  context: Context<{ Variables: AuthVariables }>,
  readOwner: () => T | null
): T | null {
  const access = context.get('workspaceAccess');

  try {
    const owner = readOwner();
    if (access) {
      assertAuthorizedWorkspaceLineage(access, owner?.workspaceId ?? null);
    }
    return owner;
  } catch (error) {
    if (access) {
      assertAuthorizedWorkspaceLineage(access, null);
    }
    throw error;
  }
}
