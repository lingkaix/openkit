import type { SYNC_OPERATION_DEFINITIONS } from '@openkit/app-api-schemas';
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
  SubmitWorkspaceRecoveryDecisionResponseSchema,
  SubmitWorkspaceSyncReviewDecisionResponseSchema,
  type WorkspaceApplyResult,
  type WorkspaceSyncReviewItem,
} from '@openkit/app-api-schemas';
import { publishedErrorMessage } from '../api-errors.js';
import { listArtifactReviews } from '../artifact-reviews.js';
import type { Actor } from '../auth/identity.js';
import { KernelCommandError } from '../generative-kernel/errors.js';
import { KnowledgePageValidationError } from '../knowledge/okf.js';
import type { FsStore } from '../lib/store.js';
import type { OperationImplementations } from '../operation-invocation.js';
import type { CoreDb, WorkspaceDb } from '../storage/db.js';
import {
  IdempotencyKeyConflictError,
  type InflightIdempotentCommand,
  runIdempotentCommand,
} from './idempotent-command.js';
import { TurnStartValidationError } from './orchestrator.js';
import { PendingRequestCommandError } from './pending-requests.js';
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

/** Transport-neutral preservation of the synchronization owner's published refusal. */
export class WorkspaceSyncOperationError extends Error {
  constructor(
    message: string,
    readonly code = 'not_found',
    readonly status = 404
  ) {
    super(message);
  }
}

/** Child content is resolved only inside the admitted Workspace; missing and foreign children fail identically. */
function requireSelectedWorkspaceLineage(
  workspaceId: string,
  childWorkspaceId: string | null
): void {
  if (childWorkspaceId !== workspaceId)
    throw new WorkspaceSyncOperationError(
      'Workspace access denied.',
      'workspace_access_denied',
      403
    );
}

/** Preserve the old decision handler's typed errors and owner-specific unexpected-error fallback. */
function commandFailure(error: unknown, code: string): Error {
  if (
    error instanceof IdempotencyKeyConflictError ||
    error instanceof KernelCommandError ||
    error instanceof TurnStartValidationError ||
    error instanceof KnowledgePageValidationError ||
    error instanceof PendingRequestCommandError
  )
    return new WorkspaceSyncOperationError(error.message, error.code, error.status);
  return new WorkspaceSyncOperationError(publishedErrorMessage(error), code);
}

/** Joins synchronization definitions to existing review, apply, recovery and receipt owners. Logical selectors stay outside receipt inputs to preserve retained command replay. */
export function createWorkspaceSyncOperationImplementations({
  coreDb,
  inflightCommands,
  repositoryWorkspaceDb,
  store,
}: {
  readonly coreDb: CoreDb | undefined;
  readonly inflightCommands: WeakMap<FsStore, Map<string, InflightIdempotentCommand>>;
  readonly repositoryWorkspaceDb: (workspaceId: string) => WorkspaceDb;
  readonly store: FsStore;
}): Pick<OperationImplementations, keyof typeof SYNC_OPERATION_DEFINITIONS> {
  return {
    'sync.review-list': (logicalInput) => {
      try {
        const workspaceId = logicalInput.workspaceId;
        const workspaceDb = repositoryWorkspaceDb(workspaceId);
        try {
          const items = listWorkspaceSyncReviewsForRead(
            store.listArtifacts(workspaceId),
            workspaceDb,
            workspaceId
          );

          return ListWorkspaceSyncReviewsResponseSchema.parse({ items });
        } finally {
          workspaceDb.sqlite.close();
        }
      } catch (error) {
        throw new WorkspaceSyncOperationError(publishedErrorMessage(error));
      }
    },
    'sync.review-read': (logicalInput) => {
      try {
        const workspaceId = logicalInput.workspaceId;
        const reviewId = logicalInput.reviewId;
        const workspaceDb = repositoryWorkspaceDb(workspaceId);
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
        requireSelectedWorkspaceLineage(workspaceId, review?.review.workspaceId ?? null);

        return GetWorkspaceSyncReviewResponseSchema.parse(review);
      } catch (error) {
        if (error instanceof WorkspaceSyncOperationError) throw error;
        throw new WorkspaceSyncOperationError(publishedErrorMessage(error));
      }
    },
    'sync.review-decide': async (logicalInput, actor, context) => {
      try {
        const { workspaceId, reviewId, ...input } = logicalInput;

        const requestId = input.requestId;
        if (!coreDb) {
          throw new TurnStartValidationError(
            'workspace_access_denied',
            'Workspace access denied.',
            403
          );
        }
        const authorityActor = { kind: 'user' as const, id: actor.id };
        const ownerDb = repositoryWorkspaceDb(workspaceId);
        let owner: ReturnType<typeof getWorkspaceSyncReview>;
        try {
          owner = getWorkspaceSyncReview(ownerDb, workspaceId, reviewId);
        } finally {
          ownerDb.sqlite.close();
        }
        requireSelectedWorkspaceLineage(workspaceId, owner?.review.workspaceId ?? null);
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
            const workspaceDb = repositoryWorkspaceDb(workspaceId);
            try {
              return await decideWorkspaceSyncReview({
                authorityActor,
                requestActor: context.actor as Actor,
                coreDb,
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
            const workspaceDb = repositoryWorkspaceDb(workspaceId);
            try {
              const review = getWorkspaceSyncReview(workspaceDb, workspaceId, record.response.id);

              if (!review) {
                throw new Error(`Workspace synchronization review not found: ${reviewId}`);
              }
              if (
                listArtifactReviews(workspaceDb).some(
                  (artifactReview) => artifactReview.artifactId === review.artifactId
                )
              ) {
                throw new TurnStartValidationError(
                  'recovery_required',
                  'The Artifact has conflicting Review authorities and requires recovery.',
                  409
                );
              }

              return {
                review: review.review,
                workspaceApplyResult:
                  review.review.status === 'accepted'
                    ? requireWorkspaceApplyResult(
                        workspaceDb,
                        workspaceId,
                        `war_${review.review.id}`
                      )
                    : null,
              };
            } finally {
              workspaceDb.sqlite.close();
            }
          },
          responseId: (result) => result.review.id,
        });

        return SubmitWorkspaceSyncReviewDecisionResponseSchema.parse(response);
      } catch (error) {
        if (error instanceof WorkspaceSyncOperationError) throw error;
        throw commandFailure(error, 'workspace_sync_review_failed');
      }
    },
    'sync.input-snapshot-list': (logicalInput) => {
      try {
        const workspaceId = logicalInput.workspaceId;
        const workspaceDb = repositoryWorkspaceDb(workspaceId);
        try {
          const items = listWorkspaceInputSnapshots(workspaceDb, workspaceId);

          return ListWorkspaceInputSnapshotsResponseSchema.parse({ items });
        } finally {
          workspaceDb.sqlite.close();
        }
      } catch (error) {
        throw new WorkspaceSyncOperationError(publishedErrorMessage(error));
      }
    },
    'sync.materialization-list': (logicalInput) => {
      try {
        const workspaceId = logicalInput.workspaceId;
        const workspaceDb = repositoryWorkspaceDb(workspaceId);
        try {
          const items = listWorkspaceMaterializationRecords(workspaceDb, workspaceId);

          return ListWorkspaceMaterializationRecordsResponseSchema.parse({ items });
        } finally {
          workspaceDb.sqlite.close();
        }
      } catch (error) {
        throw new WorkspaceSyncOperationError(publishedErrorMessage(error));
      }
    },
    'sync.backend-handle-list': (logicalInput) => {
      try {
        const workspaceId = logicalInput.workspaceId;
        const workspaceDb = repositoryWorkspaceDb(workspaceId);
        try {
          const items = listBackendWorkspaceHandles(workspaceDb, workspaceId);

          return ListBackendWorkspaceHandlesResponseSchema.parse({ items });
        } finally {
          workspaceDb.sqlite.close();
        }
      } catch (error) {
        throw new WorkspaceSyncOperationError(publishedErrorMessage(error));
      }
    },
    'sync.output-manifest-list': (logicalInput) => {
      try {
        const workspaceId = logicalInput.workspaceId;
        const workspaceDb = repositoryWorkspaceDb(workspaceId);
        try {
          const items = listWorkerOutputManifests(workspaceDb, workspaceId);

          return ListWorkerOutputManifestsResponseSchema.parse({ items });
        } finally {
          workspaceDb.sqlite.close();
        }
      } catch (error) {
        throw new WorkspaceSyncOperationError(publishedErrorMessage(error));
      }
    },
    'sync.change-set-list': (logicalInput) => {
      try {
        const workspaceId = logicalInput.workspaceId;
        const workspaceDb = repositoryWorkspaceDb(workspaceId);
        try {
          const items = listWorkspaceChangeSets(workspaceDb, workspaceId);

          return ListWorkspaceChangeSetsResponseSchema.parse({ items });
        } finally {
          workspaceDb.sqlite.close();
        }
      } catch (error) {
        throw new WorkspaceSyncOperationError(publishedErrorMessage(error));
      }
    },
    'sync.staged-review-list': (logicalInput) => {
      try {
        const workspaceId = logicalInput.workspaceId;
        const workspaceDb = repositoryWorkspaceDb(workspaceId);
        try {
          const items = listWorkspaceSyncReviews(workspaceDb, workspaceId).map(
            (item) => item.review
          );

          return ListStagedWorkspaceReviewsResponseSchema.parse({ items });
        } finally {
          workspaceDb.sqlite.close();
        }
      } catch (error) {
        throw new WorkspaceSyncOperationError(publishedErrorMessage(error));
      }
    },
    'sync.apply-result-list': (logicalInput) => {
      try {
        const workspaceId = logicalInput.workspaceId;
        const workspaceDb = repositoryWorkspaceDb(workspaceId);
        try {
          const items = listWorkspaceApplyResults(workspaceDb, workspaceId);

          return ListWorkspaceApplyResultsResponseSchema.parse({ items });
        } finally {
          workspaceDb.sqlite.close();
        }
      } catch (error) {
        throw new WorkspaceSyncOperationError(publishedErrorMessage(error));
      }
    },
    'sync.apply-plan-list': (logicalInput) => {
      try {
        const workspaceId = logicalInput.workspaceId;
        const workspaceDb = repositoryWorkspaceDb(workspaceId);
        try {
          const items = listWorkspaceApplyPlans(workspaceDb, workspaceId);

          return ListWorkspaceApplyPlansResponseSchema.parse({ items });
        } finally {
          workspaceDb.sqlite.close();
        }
      } catch (error) {
        throw new WorkspaceSyncOperationError(publishedErrorMessage(error));
      }
    },
    'sync.reconciliation-list': (logicalInput) => {
      try {
        const workspaceId = logicalInput.workspaceId;
        const workspaceDb = repositoryWorkspaceDb(workspaceId);
        try {
          const items = listWorkspaceReconciliationRecords(workspaceDb, workspaceId);

          return ListWorkspaceReconciliationRecordsResponseSchema.parse({ items });
        } finally {
          workspaceDb.sqlite.close();
        }
      } catch (error) {
        throw new WorkspaceSyncOperationError(publishedErrorMessage(error));
      }
    },
    'sync.recovery-decide': async (logicalInput) => {
      try {
        const { workspaceId, reconciliationRecordId, ...input } = logicalInput;

        const ownerDb = repositoryWorkspaceDb(workspaceId);
        let owner: ReturnType<typeof listWorkspaceReconciliationRecords>[number] | undefined;
        try {
          owner = listWorkspaceReconciliationRecords(ownerDb, workspaceId).find(
            (candidate) => candidate.id === reconciliationRecordId
          );
        } finally {
          ownerDb.sqlite.close();
        }
        requireSelectedWorkspaceLineage(workspaceId, owner?.workspaceId ?? null);
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
            const workspaceDb = repositoryWorkspaceDb(workspaceId);
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
            const workspaceDb = repositoryWorkspaceDb(workspaceId);
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

        return SubmitWorkspaceRecoveryDecisionResponseSchema.parse(response);
      } catch (error) {
        if (error instanceof WorkspaceSyncOperationError) throw error;
        throw commandFailure(error, 'workspace_recovery_decision_failed');
      }
    },
    'sync.quarantine-list': (logicalInput) => {
      try {
        const workspaceId = logicalInput.workspaceId;
        const workspaceDb = repositoryWorkspaceDb(workspaceId);
        try {
          const items = listWorkspaceQuarantineRecords(workspaceDb, workspaceId);

          return ListWorkspaceQuarantineRecordsResponseSchema.parse({ items });
        } finally {
          workspaceDb.sqlite.close();
        }
      } catch (error) {
        throw new WorkspaceSyncOperationError(publishedErrorMessage(error));
      }
    },
    'sync.apply-result-read': (logicalInput) => {
      try {
        const workspaceId = logicalInput.workspaceId;
        const applyResultId = logicalInput.applyResultId;
        const workspaceDb = repositoryWorkspaceDb(workspaceId);
        let result: WorkspaceApplyResult | null;
        try {
          result = getWorkspaceApplyResult(workspaceDb, workspaceId, applyResultId);
        } finally {
          workspaceDb.sqlite.close();
        }
        requireSelectedWorkspaceLineage(workspaceId, result?.workspaceId ?? null);

        return GetWorkspaceApplyResultResponseSchema.parse(result);
      } catch (error) {
        if (error instanceof WorkspaceSyncOperationError) throw error;
        throw new WorkspaceSyncOperationError(publishedErrorMessage(error));
      }
    },
  };
}
