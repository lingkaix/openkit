import {
  CancelSchedulerAdmissionResponseSchema,
  ListSchedulerAdmissionsResponseSchema,
  RetrySchedulerAdmissionResponseSchema,
} from '@openkit/app-api-schemas';
import type { Context, Hono } from 'hono';

import { asApiError } from '../api-errors.js';
import { recordWorkspaceAuditEvent } from '../audit-events.js';
import type { AuthVariables } from '../auth/middleware.js';
import type { FsStore } from '../lib/store.js';
import { registerAppApiRoute } from '../openapi.js';
import {
  cancelSchedulerAdmissionEntry,
  listQueuedSchedulerAdmissionEntries,
  listSchedulerAdmissionEntriesForWorkspace,
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
  readonly repositoryWorkspaceDb: (store: FsStore, workspaceId: string) => WorkspaceDb;
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
      const items = listSchedulerAdmissionEntriesForWorkspace(coreDb, {
        userId: store.getUserId(),
        workspaceId,
        statuses: ['queued', 'denied'],
      }).map((entry) => ({
        queueEntryId: entry.queueEntryId,
        requestId: entry.requestId,
        workspaceId: entry.workspaceId,
        threadId: entry.threadId,
        turnId: entry.turnId,
        requestedAgentId: entry.requestedAgentId,
        profileRef: entry.profileRef,
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

      const retried = retryDeniedSchedulerAdmissionEntry(coreDb, {
        queueEntryId,
        userId: store.getUserId(),
        workspaceId,
      });
      const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
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

      const cancelled = cancelSchedulerAdmissionEntry(coreDb, {
        queueEntryId,
        userId: store.getUserId(),
        workspaceId,
      });
      const workspaceDb = repositoryWorkspaceDb(store, workspaceId);
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
      return asApiError((error as Error).message, 'scheduler_admission_cancel_failed', 400);
    }
  });
}
