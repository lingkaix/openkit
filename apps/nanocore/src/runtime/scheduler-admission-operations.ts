import type { SCHEDULER_OPERATION_DEFINITIONS } from '@openkit/app-api-schemas';
import { ListSchedulerAdmissionsResponseSchema } from '@openkit/app-api-schemas';
import { publishedErrorMessage } from '../api-errors.js';
import { recordWorkspaceAuditEvent } from '../audit-events.js';
import { isCurrentDeploymentAdministrator } from '../auth/operation-authorizer.js';
import { isThreadIdVisible } from '../auth/thread-visibility.js';
import type { FsStore } from '../lib/store.js';
import type {
  OperationImplementations,
  OperationInvocationContext,
  OperationInvocationDependencies,
} from '../operation-invocation.js';
import {
  cancelSchedulerAdmissionEntry,
  listQueuedSchedulerAdmissionEntries,
  listSchedulerAdmissionEntriesForWorkspace,
  requireSchedulerAdmissionEntry,
  retryDeniedSchedulerAdmissionEntry,
} from '../scheduler-records.js';
import type { CoreDb } from '../storage/db.js';

/** Scheduler failure retains the native published error code and status. */
export class SchedulerAdmissionOperationError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status = 400
  ) {
    super(message);
  }
}
/** Joins scheduler views and mutations without changing queue or audit ownership. */
export function createSchedulerAdmissionOperationImplementations(
  dependencies: OperationInvocationDependencies
): Pick<OperationImplementations, keyof typeof SCHEDULER_OPERATION_DEFINITIONS> {
  const { repositoryWorkspaceDb } = dependencies;
  // Native invocation admits Core storage before entering this family.
  const coreDb = dependencies.coreDb!;
  /** Current administrator audience comes only from the credential owner. */
  function administratorEligible(context: OperationInvocationContext): boolean {
    return context.kind === 'public' && isCurrentDeploymentAdministrator(coreDb, context.actor);
  }
  return {
    'scheduler.list': (input, actor, context) => {
      try {
        const workspaceId = input.workspaceId;
        const store = dependencies.store!;

        store.getWorkspace(workspaceId);

        const queuedPositions = new Map(
          listQueuedSchedulerAdmissionEntries(coreDb).map((entry, index) => [
            entry.queueEntryId,
            index + 1,
          ])
        );
        const viewerUserId = actor.id;
        const items = listSchedulerAdmissionEntriesForWorkspace(coreDb, {
          workspaceId,
          statuses: ['queued', 'denied'],
        })
          .filter((entry) =>
            isThreadIdVisible(
              store,
              workspaceId,
              entry.threadId,
              viewerUserId,
              administratorEligible(context)
            )
          )
          .map((entry) => ({
            queueEntryId: entry.queueEntryId,
            requestId: entry.requestId,
            workspaceId: entry.workspaceId,
            threadId: entry.threadId,
            turnId: entry.turnId,
            requestedAgentId: entry.requestedAgentId,
            profileRef: entry.profileRef,
            modelId: entry.modelId,
            priorityClass: entry.priorityClass,
            enqueuedAt: entry.enqueuedAt,
            effectivePriorityAt: entry.effectivePriorityAt,
            firstCapDeferredAt: entry.firstCapDeferredAt,
            requiredPoolConstraints: entry.requiredPoolConstraints,
            status: entry.status,
            denialReason: entry.denialReason,
            queuePosition:
              entry.status === 'queued' ? (queuedPositions.get(entry.queueEntryId) ?? null) : null,
          }));

        return ListSchedulerAdmissionsResponseSchema.parse({ items });
      } catch (error) {
        throw new SchedulerAdmissionOperationError(
          publishedErrorMessage(error),
          'scheduler_admissions_failed',
          400
        );
      }
    },
    'scheduler.retry': (input, actor, context) => {
      try {
        const workspaceId = input.workspaceId;
        const queueEntryId = input.queueEntryId;
        const store = dependencies.store!;

        store.getWorkspace(workspaceId);

        requireVisibleSchedulerAdmissionEntry(
          coreDb,
          store,
          workspaceId,
          queueEntryId,
          actor.id,
          administratorEligible(context)
        );

        const retried = retryDeniedSchedulerAdmissionEntry(coreDb, {
          queueEntryId,
          workspaceId,
        });
        const workspaceDb = repositoryWorkspaceDb!(workspaceId);
        try {
          recordWorkspaceAuditEvent({
            workspaceDb,
            workspaceId,
            threadId: retried.threadId,
            turnId: retried.turnId,
            requestId: retried.requestId,
            action: 'scheduler.admission.retry',
            resource: `scheduler-admission:${retried.queueEntryId}`,
            outcome: 'succeeded',
            summary: 'Scheduler admission retried.',
          });
        } finally {
          workspaceDb.sqlite.close();
        }

        return { retried: true };
      } catch (error) {
        if (error instanceof SchedulerAdmissionOperationError) {
          throw error;
        }
        throw new SchedulerAdmissionOperationError(
          publishedErrorMessage(error),
          'scheduler_admission_retry_failed',
          400
        );
      }
    },
    'scheduler.cancel': (input, actor, context) => {
      try {
        const workspaceId = input.workspaceId;
        const queueEntryId = input.queueEntryId;
        const store = dependencies.store!;

        store.getWorkspace(workspaceId);

        requireVisibleSchedulerAdmissionEntry(
          coreDb,
          store,
          workspaceId,
          queueEntryId,
          actor.id,
          administratorEligible(context)
        );

        const cancelled = cancelSchedulerAdmissionEntry(coreDb, {
          queueEntryId,
          workspaceId,
        });
        const workspaceDb = repositoryWorkspaceDb!(workspaceId);
        try {
          recordWorkspaceAuditEvent({
            workspaceDb,
            workspaceId,
            threadId: cancelled.threadId,
            turnId: cancelled.turnId,
            requestId: cancelled.requestId,
            action: 'scheduler.admission.cancel',
            resource: `scheduler-admission:${cancelled.queueEntryId}`,
            outcome: 'cancelled',
            summary: 'Scheduler admission cancelled.',
          });
        } finally {
          workspaceDb.sqlite.close();
        }

        return { cancelled: true };
      } catch (error) {
        if (error instanceof SchedulerAdmissionOperationError) {
          throw error;
        }
        throw new SchedulerAdmissionOperationError(
          publishedErrorMessage(error),
          'scheduler_admission_cancel_failed',
          400
        );
      }
    },
  };
}

/**
 * Loads one same-Workspace admission and refuses missing, mismatched, or inaccessible ids
 * with a nondisclosing 404 before mutation.
 *
 * @param coreDb Open server-scope Core database handle.
 * @param store Request-scoped workspace store.
 * @param workspaceId Workspace that already authorized the request.
 * @param queueEntryId Queue entry id from the route.
 * @param userId Authenticated viewer.
 * @returns Admission entry visible to the viewer in this Workspace.
 * @throws SchedulerAdmissionOperationError when the entry is missing, mismatched, or not visible.
 */
function requireVisibleSchedulerAdmissionEntry(
  coreDb: CoreDb,
  store: FsStore,
  workspaceId: string,
  queueEntryId: string,
  userId: string | undefined,
  administratorEligible: boolean
): ReturnType<typeof requireSchedulerAdmissionEntry> {
  const lineage = coreDb.sqlite
    .prepare(
      'SELECT workspace_id, thread_id FROM scheduler_admission_entries WHERE queue_entry_id = ? AND workspace_id = ?'
    )
    .get(queueEntryId, workspaceId) as { workspace_id: string; thread_id: string } | undefined;
  if (
    !lineage ||
    !isThreadIdVisible(store, workspaceId, lineage.thread_id, userId, administratorEligible)
  ) {
    throw new SchedulerAdmissionOperationError('Thread not found.', 'not_found', 404);
  }
  return requireSchedulerAdmissionEntry(coreDb, queueEntryId, { workspaceId });
}
