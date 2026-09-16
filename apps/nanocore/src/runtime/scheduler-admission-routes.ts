import {
  CancelSchedulerAdmissionResponseSchema,
  ListSchedulerAdmissionsResponseSchema,
  RetrySchedulerAdmissionResponseSchema,
} from '@openkit/app-api-schemas';
import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

import { asApiError } from '../api-errors.js';
import { recordWorkspaceAuditEvent } from '../audit-events.js';
import type { AuthVariables } from '../auth/middleware.js';
import { assertAuthorizedWorkspaceLineage } from '../auth/operation-authorizer.js';
import { isThreadIdVisible } from '../auth/thread-visibility.js';
import type { FsStore } from '../lib/store.js';
import { registerAppApiRoute } from '../openapi.js';
import {
  cancelSchedulerAdmissionEntry,
  listQueuedSchedulerAdmissionEntries,
  listSchedulerAdmissionEntriesForWorkspace,
  requireSchedulerAdmissionEntry,
  retryDeniedSchedulerAdmissionEntry,
} from '../scheduler-records.js';
import type { CoreDb, WorkspaceDb } from '../storage/db.js';

/**
 * Registers Scheduler Admission list, retry, and cancel routes.
 *
 * @param dependencies Hono app and scheduler storage dependencies.
 */
export function registerSchedulerAdmissionRoutes({
  app,
  coreDb,
  repositoryWorkspaceDb,
  requestStore,
}: {
  readonly app: Hono<{ Variables: AuthVariables }>;
  readonly coreDb: CoreDb | undefined;
  readonly repositoryWorkspaceDb: (workspaceId: string) => WorkspaceDb;
  readonly requestStore: (context: Context<{ Variables: AuthVariables }>) => FsStore;
}): void {
  registerAppApiRoute(app, 'listSchedulerAdmissions', (c) => {
    try {
      const workspaceId = c.req.param('workspaceId');
      const store = requestStore(c);

      store.getWorkspace(workspaceId);

      if (!coreDb) {
        return c.json(ListSchedulerAdmissionsResponseSchema.parse({ items: [] }));
      }

      const queuedPositions = new Map(
        listQueuedSchedulerAdmissionEntries(coreDb).map((entry, index) => [
          entry.queueEntryId,
          index + 1,
        ])
      );
      const viewerUserId = c.get('actor')?.userId;
      const items = listSchedulerAdmissionEntriesForWorkspace(coreDb, {
        workspaceId,
        statuses: ['queued', 'denied'],
      })
        .filter((entry) => isThreadIdVisible(store, workspaceId, entry.threadId, viewerUserId))
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

      return c.json(ListSchedulerAdmissionsResponseSchema.parse({ items }));
    } catch (error) {
      return asApiError((error as Error).message, 'scheduler_admissions_failed', 400);
    }
  });

  registerAppApiRoute(app, 'retrySchedulerAdmission', (c) => {
    try {
      const workspaceId = c.req.param('workspaceId');
      const queueEntryId = c.req.param('queueEntryId');
      const store = requestStore(c);

      store.getWorkspace(workspaceId);

      if (!coreDb) {
        return asApiError(
          'Scheduler storage is unavailable for this NanoCore instance.',
          'scheduler_storage_unavailable',
          503
        );
      }

      const owner = requireVisibleSchedulerAdmissionEntry(
        coreDb,
        store,
        workspaceId,
        queueEntryId,
        c.get('actor')?.userId
      );
      assertAuthorizedWorkspaceLineage(c.get('workspaceAccess'), owner.workspaceId);
      const retried = retryDeniedSchedulerAdmissionEntry(coreDb, {
        queueEntryId,
        workspaceId,
      });
      const workspaceDb = repositoryWorkspaceDb(workspaceId);
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

      return c.json(RetrySchedulerAdmissionResponseSchema.parse({ retried: true }));
    } catch (error) {
      if (error instanceof HTTPException) {
        throw error;
      }
      return asApiError((error as Error).message, 'scheduler_admission_retry_failed', 400);
    }
  });

  registerAppApiRoute(app, 'cancelSchedulerAdmission', (c) => {
    try {
      const workspaceId = c.req.param('workspaceId');
      const queueEntryId = c.req.param('queueEntryId');
      const store = requestStore(c);

      store.getWorkspace(workspaceId);

      if (!coreDb) {
        return asApiError(
          'Scheduler storage is unavailable for this NanoCore instance.',
          'scheduler_storage_unavailable',
          503
        );
      }

      const owner = requireVisibleSchedulerAdmissionEntry(
        coreDb,
        store,
        workspaceId,
        queueEntryId,
        c.get('actor')?.userId
      );
      assertAuthorizedWorkspaceLineage(c.get('workspaceAccess'), owner.workspaceId);
      const cancelled = cancelSchedulerAdmissionEntry(coreDb, {
        queueEntryId,
        workspaceId,
      });
      const workspaceDb = repositoryWorkspaceDb(workspaceId);
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

      return c.json(CancelSchedulerAdmissionResponseSchema.parse({ cancelled: true }));
    } catch (error) {
      if (error instanceof HTTPException) {
        throw error;
      }
      return asApiError((error as Error).message, 'scheduler_admission_cancel_failed', 400);
    }
  });
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
 * @throws HTTPException when the entry is missing, mismatched, or not visible.
 */
function requireVisibleSchedulerAdmissionEntry(
  coreDb: CoreDb,
  store: FsStore,
  workspaceId: string,
  queueEntryId: string,
  userId: string | undefined
): ReturnType<typeof requireSchedulerAdmissionEntry> {
  let owner: ReturnType<typeof requireSchedulerAdmissionEntry> | undefined;
  try {
    owner = requireSchedulerAdmissionEntry(coreDb, queueEntryId, { workspaceId });
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !error.message.startsWith('Scheduler admission entry not found:')
    ) {
      throw error;
    }
  }
  if (!owner || !isThreadIdVisible(store, workspaceId, owner.threadId, userId)) {
    throw new HTTPException(404, { message: 'Thread not found.' });
  }
  return owner;
}
