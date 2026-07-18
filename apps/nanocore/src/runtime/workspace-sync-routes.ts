import {
  GetWorkspaceApplyResultResponseSchema,
  GetWorkspaceSyncReviewResponseSchema,
  ListBackendWorkspaceHandlesResponseSchema,
  ListStagedWorkspaceReviewsResponseSchema,
  ListWorkerOutputManifestsResponseSchema,
  ListWorkspaceApplyPlansResponseSchema,
  ListWorkspaceApplyResultsResponseSchema,
  ListWorkspaceChangeSetsResponseSchema,
  ListWorkspaceInputSnapshotsResponseSchema,
  ListWorkspaceMaterializationRecordsResponseSchema,
  ListWorkspaceQuarantineRecordsResponseSchema,
  ListWorkspaceReconciliationRecordsResponseSchema,
  ListWorkspaceSyncReviewsResponseSchema,
  SubmitWorkspaceRecoveryDecisionRequestSchema,
  SubmitWorkspaceRecoveryDecisionResponseSchema,
  SubmitWorkspaceSyncReviewDecisionRequestSchema,
  SubmitWorkspaceSyncReviewDecisionResponseSchema,
  type WorkspaceApplyResult,
  type WorkspaceSyncReviewItem,
} from '@openkit/app-api-schemas';
import type { Context, Hono } from 'hono';

import { asApiError, asCommandError, asInvalidRequestError } from '../api-errors.js';
import type { AuthVariables } from '../auth/middleware.js';
import type { FsStore } from '../lib/store.js';
import { registerAppApiRoute } from '../openapi.js';
import type { WorkspaceDb } from '../storage/db.js';
import { type InflightIdempotentCommand, runIdempotentCommand } from './idempotent-command.js';
import { listWorkspaceApplyPlans } from './workspace-apply-plans.js';
import {
  getWorkspaceApplyResult,
  listWorkspaceApplyResults,
  requireWorkspaceApplyResult,
} from './workspace-apply-results.js';
import { listWorkspaceQuarantineRecords } from './workspace-quarantine-records.js';
import {
  listWorkspaceReconciliationRecords,
  resolveWorkspaceReconciliationRecord,
} from './workspace-reconciliation-records.js';
import {
  decideWorkspaceSyncReview,
  listWorkspaceSyncReviewsForRead,
} from './workspace-review-application.js';
import {
  getWorkspaceSyncReview,
  listBackendWorkspaceHandles,
  listWorkerOutputManifests,
  listWorkspaceChangeSets,
  listWorkspaceInputSnapshots,
  listWorkspaceMaterializationRecords,
  listWorkspaceSyncReviews,
} from './workspace-sync-records.js';

/**
 * Registers the complete workspace synchronization App API feature path.
 *
 * @param dependencies Hono app and request-scoped storage dependencies.
 */
export function registerWorkspaceSyncRoutes({
  app,
  inflightCommands,
  repositoryWorkspaceDb,
  requestStore,
}: {
  readonly app: Hono<{ Variables: AuthVariables }>;
  readonly inflightCommands: WeakMap<FsStore, Map<string, InflightIdempotentCommand>>;
  readonly repositoryWorkspaceDb: (store: FsStore, workspaceId: string) => WorkspaceDb;
  readonly requestStore: (context: Context<{ Variables: AuthVariables }>) => FsStore;
}): void {
  registerAppApiRoute(app, 'listWorkspaceSyncReviews', (c) => {
    try {
      const store = requestStore(c);
      const workspaceId = c.req.param('workspaceId');
      const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
      try {
        const items = listWorkspaceSyncReviewsForRead(
          store.listArtifacts(workspaceId),
          workspaceDb,
          workspaceId
        );

        return c.json(ListWorkspaceSyncReviewsResponseSchema.parse({ items }));
      } finally {
        workspaceDb.sqlite.close();
      }
    } catch (error) {
      return asApiError((error as Error).message);
    }
  });

  registerAppApiRoute(app, 'getWorkspaceSyncReview', (c) => {
    try {
      const store = requestStore(c);
      const workspaceId = c.req.param('workspaceId');
      const reviewId = c.req.param('reviewId');
      const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
      let review: WorkspaceSyncReviewItem | null;
      try {
        review =
          listWorkspaceSyncReviewsForRead(
            store.listArtifacts(workspaceId),
            workspaceDb,
            workspaceId
          ).find((item) => item.review.id === reviewId) ?? null;
      } finally {
        workspaceDb.sqlite.close();
      }

      if (!review) {
        return asApiError(`Workspace synchronization review not found: ${reviewId}`);
      }

      return c.json(GetWorkspaceSyncReviewResponseSchema.parse(review));
    } catch (error) {
      return asApiError((error as Error).message);
    }
  });

  registerAppApiRoute(app, 'submitWorkspaceSyncReviewDecision', async (c) => {
    try {
      const parsed = SubmitWorkspaceSyncReviewDecisionRequestSchema.safeParse(
        await c.req.json().catch(() => ({}))
      );

      if (!parsed.success) {
        return asInvalidRequestError(parsed.error);
      }

      const store = requestStore(c);
      const workspaceId = c.req.param('workspaceId');
      const reviewId = c.req.param('reviewId');
      const input = parsed.data;

      if (!input.requestId) {
        return asApiError('requestId is required.', 'invalid_request', 400);
      }

      const requestId = input.requestId;
      const response = await runIdempotentCommand({
        store,
        inflightCommands,
        command: 'workspace_sync.review.decide',
        requestId,
        scope: { workspaceId, reviewId },
        input,
        responseKind: 'workspace_sync_review',
        execute: async () => {
          const decidedAt = new Date().toISOString();
          const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
          try {
            return await decideWorkspaceSyncReview({
              decidedAt,
              decision: input.decision,
              requestId,
              reviewId,
              store,
              workspaceDb,
              workspaceId,
            });
          } finally {
            workspaceDb.sqlite.close();
          }
        },
        replay: (record) => {
          const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
          try {
            const review = getWorkspaceSyncReview(workspaceDb, workspaceId, record.response.id);

            if (!review) {
              throw new Error(`Workspace synchronization review not found: ${reviewId}`);
            }

            return {
              review: review.review,
              workspaceApplyResult:
                review.review.status === 'accepted'
                  ? requireWorkspaceApplyResult(workspaceDb, workspaceId, `war_${review.review.id}`)
                  : null,
            };
          } finally {
            workspaceDb.sqlite.close();
          }
        },
        responseId: (result) => result.review.id,
      });

      return c.json(SubmitWorkspaceSyncReviewDecisionResponseSchema.parse(response));
    } catch (error) {
      return asCommandError(error, 'workspace_sync_review_failed');
    }
  });

  registerAppApiRoute(app, 'listWorkspaceInputSnapshots', (c) => {
    try {
      const workspaceId = c.req.param('workspaceId');
      const store = requestStore(c);
      const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
      try {
        const items = listWorkspaceInputSnapshots(workspaceDb, workspaceId);

        return c.json(ListWorkspaceInputSnapshotsResponseSchema.parse({ items }));
      } finally {
        workspaceDb.sqlite.close();
      }
    } catch (error) {
      return asApiError((error as Error).message);
    }
  });

  registerAppApiRoute(app, 'listWorkspaceMaterializationRecords', (c) => {
    try {
      const workspaceId = c.req.param('workspaceId');
      const store = requestStore(c);
      const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
      try {
        const items = listWorkspaceMaterializationRecords(workspaceDb, workspaceId);

        return c.json(ListWorkspaceMaterializationRecordsResponseSchema.parse({ items }));
      } finally {
        workspaceDb.sqlite.close();
      }
    } catch (error) {
      return asApiError((error as Error).message);
    }
  });

  registerAppApiRoute(app, 'listBackendWorkspaceHandles', (c) => {
    try {
      const workspaceId = c.req.param('workspaceId');
      const store = requestStore(c);
      const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
      try {
        const items = listBackendWorkspaceHandles(workspaceDb, workspaceId);

        return c.json(ListBackendWorkspaceHandlesResponseSchema.parse({ items }));
      } finally {
        workspaceDb.sqlite.close();
      }
    } catch (error) {
      return asApiError((error as Error).message);
    }
  });

  registerAppApiRoute(app, 'listWorkerOutputManifests', (c) => {
    try {
      const workspaceId = c.req.param('workspaceId');
      const store = requestStore(c);
      const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
      try {
        const items = listWorkerOutputManifests(workspaceDb, workspaceId);

        return c.json(ListWorkerOutputManifestsResponseSchema.parse({ items }));
      } finally {
        workspaceDb.sqlite.close();
      }
    } catch (error) {
      return asApiError((error as Error).message);
    }
  });

  registerAppApiRoute(app, 'listWorkspaceChangeSets', (c) => {
    try {
      const workspaceId = c.req.param('workspaceId');
      const store = requestStore(c);
      const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
      try {
        const items = listWorkspaceChangeSets(workspaceDb, workspaceId);

        return c.json(ListWorkspaceChangeSetsResponseSchema.parse({ items }));
      } finally {
        workspaceDb.sqlite.close();
      }
    } catch (error) {
      return asApiError((error as Error).message);
    }
  });

  registerAppApiRoute(app, 'listStagedWorkspaceReviews', (c) => {
    try {
      const workspaceId = c.req.param('workspaceId');
      const store = requestStore(c);
      const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
      try {
        const items = listWorkspaceSyncReviews(workspaceDb, workspaceId).map((item) => item.review);

        return c.json(ListStagedWorkspaceReviewsResponseSchema.parse({ items }));
      } finally {
        workspaceDb.sqlite.close();
      }
    } catch (error) {
      return asApiError((error as Error).message);
    }
  });

  registerAppApiRoute(app, 'listWorkspaceApplyPlans', (c) => {
    try {
      const workspaceId = c.req.param('workspaceId');
      const store = requestStore(c);
      const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
      try {
        const items = listWorkspaceApplyPlans(workspaceDb, workspaceId);

        return c.json(ListWorkspaceApplyPlansResponseSchema.parse({ items }));
      } finally {
        workspaceDb.sqlite.close();
      }
    } catch (error) {
      return asApiError((error as Error).message);
    }
  });

  registerAppApiRoute(app, 'listWorkspaceReconciliationRecords', (c) => {
    try {
      const workspaceId = c.req.param('workspaceId');
      const store = requestStore(c);
      const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
      try {
        const items = listWorkspaceReconciliationRecords(workspaceDb, workspaceId);

        return c.json(ListWorkspaceReconciliationRecordsResponseSchema.parse({ items }));
      } finally {
        workspaceDb.sqlite.close();
      }
    } catch (error) {
      return asApiError((error as Error).message);
    }
  });

  registerAppApiRoute(app, 'submitWorkspaceRecoveryDecision', async (c) => {
    try {
      const parsed = SubmitWorkspaceRecoveryDecisionRequestSchema.safeParse(
        await c.req.json().catch(() => ({}))
      );

      if (!parsed.success) {
        return asInvalidRequestError(parsed.error);
      }

      const store = requestStore(c);
      const workspaceId = c.req.param('workspaceId');
      const reconciliationRecordId = c.req.param('reconciliationRecordId');
      const input = parsed.data;

      if (!input.requestId) {
        return asApiError('requestId is required.', 'invalid_request', 400);
      }

      const response = await runIdempotentCommand({
        store,
        inflightCommands,
        command: 'workspace_sync.recovery.decide',
        requestId: input.requestId,
        scope: { reconciliationRecordId, workspaceId },
        input,
        responseKind: 'workspace_sync_review',
        execute: () => {
          const decidedAt = new Date().toISOString();
          const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
          try {
            return {
              reconciliationRecord: resolveWorkspaceReconciliationRecord({
                workspaceDb,
                workspaceId,
                reconciliationRecordId,
                decision: input.decision,
                decidedAt,
                workerOutputManifests: listWorkerOutputManifests(workspaceDb, workspaceId),
              }),
            };
          } finally {
            workspaceDb.sqlite.close();
          }
        },
        replay: (record) => {
          const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
          try {
            const reconciliationRecord = listWorkspaceReconciliationRecords(
              workspaceDb,
              workspaceId
            ).find((candidate) => candidate.id === record.response.id);

            if (!reconciliationRecord) {
              throw new Error(
                `Workspace reconciliation record not found: ${reconciliationRecordId}`
              );
            }

            return { reconciliationRecord };
          } finally {
            workspaceDb.sqlite.close();
          }
        },
        responseId: (result) => result.reconciliationRecord.id,
      });

      return c.json(SubmitWorkspaceRecoveryDecisionResponseSchema.parse(response));
    } catch (error) {
      return asCommandError(error, 'workspace_recovery_decision_failed');
    }
  });

  registerAppApiRoute(app, 'listWorkspaceQuarantineRecords', (c) => {
    try {
      const workspaceId = c.req.param('workspaceId');
      const store = requestStore(c);
      const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
      try {
        const items = listWorkspaceQuarantineRecords(workspaceDb, workspaceId);

        return c.json(ListWorkspaceQuarantineRecordsResponseSchema.parse({ items }));
      } finally {
        workspaceDb.sqlite.close();
      }
    } catch (error) {
      return asApiError((error as Error).message);
    }
  });

  registerAppApiRoute(app, 'listWorkspaceApplyResults', (c) => {
    try {
      const workspaceId = c.req.param('workspaceId');
      const store = requestStore(c);
      const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
      try {
        const items = listWorkspaceApplyResults(workspaceDb, workspaceId);

        return c.json(ListWorkspaceApplyResultsResponseSchema.parse({ items }));
      } finally {
        workspaceDb.sqlite.close();
      }
    } catch (error) {
      return asApiError((error as Error).message);
    }
  });

  registerAppApiRoute(app, 'getWorkspaceApplyResult', (c) => {
    try {
      const workspaceId = c.req.param('workspaceId');
      const applyResultId = c.req.param('applyResultId');
      const store = requestStore(c);
      const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
      let result: WorkspaceApplyResult | null;
      try {
        result = getWorkspaceApplyResult(workspaceDb, workspaceId, applyResultId);
      } finally {
        workspaceDb.sqlite.close();
      }

      if (!result) {
        return asApiError(`Workspace apply result not found: ${applyResultId}`);
      }

      return c.json(GetWorkspaceApplyResultResponseSchema.parse(result));
    } catch (error) {
      return asApiError((error as Error).message);
    }
  });
}
