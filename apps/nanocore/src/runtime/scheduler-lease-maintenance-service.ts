import {
  listSchedulerLeasesNeedingWorkspaceRecovery,
  requireSchedulerSessionLeaseAdmissionContext,
  type SchedulerSessionLeaseRecord,
} from '../scheduler-records.js';
import type { CoreDb } from '../storage/db.js';
import { openWorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import {
  type RunSchedulerLeaseRenewalLoopInput,
  runSchedulerLeaseRenewalLoop,
  type SchedulerLeaseRenewalLoopResult,
} from './scheduler-lease-renewal-loop.js';
import {
  runSchedulerLeaseWatchLoop,
  type SchedulerLeaseWatchLoopResult,
} from './scheduler-lease-watch-loop.js';
import {
  listWorkspaceReconciliationRecords,
  recordWorkspaceReconciliationRecord,
} from './workspace-reconciliation-records.js';
import { listBackendWorkspaceHandles } from './workspace-sync-records.js';

/** Result of one lease-maintenance iteration. */
export interface SchedulerLeaseMaintenanceResult {
  /** Lease-watch loop result. */
  readonly leaseWatch: SchedulerLeaseWatchLoopResult;
  /** Lease-renewal loop result. */
  readonly renewal: SchedulerLeaseRenewalLoopResult;
}

/** Timer hooks used by the lease-maintenance service. */
export interface SchedulerLeaseMaintenanceTimerHooks {
  /** Schedules repeated maintenance. */
  readonly setInterval?: (callback: () => void, intervalMs: number) => unknown;
  /** Clears the scheduled maintenance handle. */
  readonly clearInterval?: (handle: unknown) => void;
}

/** Input used to start the lease-maintenance service. */
export interface StartSchedulerLeaseMaintenanceServiceInput
  extends RunSchedulerLeaseRenewalLoopInput,
    SchedulerLeaseMaintenanceTimerHooks {
  /** Repeated maintenance interval. */
  readonly intervalMs: number;
  /** Optional error sink. */
  readonly onError?: (error: unknown) => void;
}

/** Running lease-maintenance service handle. */
export interface SchedulerLeaseMaintenanceService {
  /** Runs one maintenance iteration immediately. */
  readonly runOnce: () => SchedulerLeaseMaintenanceResult | null;
  /** Stops future scheduled maintenance. */
  readonly stop: () => void;
}

/**
 * Runs one scheduler lease-maintenance iteration.
 *
 * @param coreDb Open Core database handle.
 * @param input Maintenance timing input.
 * @returns Watch and renewal results.
 */
export function runSchedulerLeaseMaintenanceOnce(
  coreDb: CoreDb,
  input: RunSchedulerLeaseRenewalLoopInput
): SchedulerLeaseMaintenanceResult {
  const leaseWatch = runSchedulerLeaseWatchLoop(coreDb, {
    ...(input.now ? { now: input.now } : {}),
  });
  recordWorkspaceRecoveryTriggersForLeases(
    coreDb,
    listSchedulerLeasesNeedingWorkspaceRecovery(coreDb),
    input.now
  );
  const renewal = runSchedulerLeaseRenewalLoop(coreDb, input);

  return { leaseWatch, renewal };
}

/**
 * Records workspace synchronization recovery triggers for leases needing backend recovery.
 *
 * @param coreDb Open Core database handle.
 * @param leases Leases requiring backend recovery after scheduler transition.
 * @param now Optional deterministic clock.
 */
export function recordWorkspaceRecoveryTriggersForLeases(
  coreDb: CoreDb,
  leases: readonly SchedulerSessionLeaseRecord[],
  now?: () => string
): void {
  const timestamp = now?.() ?? new Date().toISOString();

  for (const lease of leases) {
    const { userId } = requireSchedulerSessionLeaseAdmissionContext(coreDb, lease.leaseId);
    const stateBefore = lease.status === 'lost' ? 'lease-releasing' : 'lease-stale';
    const workspaceDb = openWorkspaceDb(coreDb.dataRoot, userId, lease.workspaceId);
    try {
      applyScopedMigrations(workspaceDb);
      for (const handle of listBackendWorkspaceHandles(workspaceDb, lease.workspaceId)) {
        const retainedReleaseTimeout =
          handle.cleanupStatus === 'retained' &&
          stateBefore === 'lease-releasing' &&
          lease.releaseReason === 'release-grace-timeout';
        if (
          handle.packageSnapshotId !== lease.packageSnapshotId ||
          (handle.cleanupStatus !== 'pending' && !retainedReleaseTimeout)
        ) {
          continue;
        }

        const reconciliationRecordId = `wrr_${lease.leaseId}_${handle.id}`;
        if (
          listWorkspaceReconciliationRecords(workspaceDb, lease.workspaceId).some(
            (record) => record.id === reconciliationRecordId
          )
        ) {
          continue;
        }

        recordWorkspaceReconciliationRecord(workspaceDb, {
          affectedRecordIds: [handle.materializationRecordId, handle.id],
          backendHandleSummary: {
            backendKind: handle.backendKind,
            cleanupStatus: handle.cleanupStatus,
            handleId: handle.id,
            workerSessionId: handle.workerSessionId,
          },
          backendReachability: {
            checkedAt: timestamp,
            detail: lease.releaseReason,
            status: 'unavailable',
          },
          collectedOutputManifestIds: [],
          evidenceBundleIds: [`evb_workspace_materialization_${handle.materializationRecordId}`],
          finishedAt: null,
          id: reconciliationRecordId,
          quarantineRefs: [],
          requiredHumanDecision: 'inspect_recovery',
          retentionDecision: 'retain-backend',
          startedAt: timestamp,
          stateAfter: 'requires-human',
          stateBefore,
          triggerReason: 'backend_takeover',
          workspaceId: lease.workspaceId,
        });
      }
    } finally {
      workspaceDb.sqlite.close();
    }
  }
}

/**
 * Starts periodic scheduler lease maintenance for one NanoCore process.
 *
 * @param coreDb Open Core database handle.
 * @param input Service timing and timer hooks.
 * @returns Service handle.
 */
export function startSchedulerLeaseMaintenanceService(
  coreDb: CoreDb,
  input: StartSchedulerLeaseMaintenanceServiceInput
): SchedulerLeaseMaintenanceService {
  if (input.intervalMs <= 0) {
    throw new Error('Scheduler lease maintenance interval must be positive.');
  }

  let stopped = false;
  const runOnce = (): SchedulerLeaseMaintenanceResult | null => {
    if (stopped) {
      return null;
    }

    try {
      return runSchedulerLeaseMaintenanceOnce(coreDb, input);
    } catch (error) {
      input.onError?.(error);
      return null;
    }
  };
  const setTimer = input.setInterval ?? setInterval;
  const clearTimer =
    input.clearInterval ??
    ((handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>));

  runOnce();
  const timer = setTimer(runOnce, input.intervalMs);

  return {
    runOnce,
    stop: () => {
      if (stopped) {
        return;
      }

      stopped = true;
      clearTimer(timer);
    },
  };
}
