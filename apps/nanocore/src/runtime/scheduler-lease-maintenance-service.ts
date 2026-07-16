import {
  listSchedulerLeasesNeedingWorkspaceRecovery,
  markSchedulerLeaseWorkspaceRecoveryProjected,
  requireSchedulerSessionLeaseAdmissionContext,
  type SchedulerSessionLeaseRecord,
} from '../scheduler-records.js';
import type { CoreDb } from '../storage/db.js';
import { openWorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import { requireAgentEnvironmentPackageSnapshot } from './aep-snapshot-ledger.js';
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
import { requireCompleteBackendWorkspaceHandleHandoff } from './workspace-sync-records.js';

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

/** Input for one scheduler lease-maintenance iteration. */
export interface RunSchedulerLeaseMaintenanceOnceInput extends RunSchedulerLeaseRenewalLoopInput {
  /** Optional sink for isolated workspace recovery projection errors. */
  readonly onError?: (error: unknown) => void;
}

/** Input used to start the lease-maintenance service. */
export interface StartSchedulerLeaseMaintenanceServiceInput
  extends RunSchedulerLeaseMaintenanceOnceInput,
    SchedulerLeaseMaintenanceTimerHooks {
  /** Cleans reconnect leases whose durable adoption deadline expired. */
  readonly cleanupExpiredReconnects: () => Promise<void>;
  /** Repeated maintenance interval. */
  readonly intervalMs: number;
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
  input: RunSchedulerLeaseMaintenanceOnceInput
): SchedulerLeaseMaintenanceResult {
  const leaseWatch = runSchedulerLeaseWatchLoop(coreDb, {
    ...(input.now ? { now: input.now } : {}),
  });
  const renewal = runSchedulerLeaseRenewalLoop(coreDb, input);
  recordWorkspaceRecoveryTriggersForLeases(
    coreDb,
    listSchedulerLeasesNeedingWorkspaceRecovery(coreDb),
    input.now,
    input.onError
  );

  return { leaseWatch, renewal };
}

/**
 * Records workspace synchronization recovery triggers for leases needing backend recovery.
 *
 * @param coreDb Open Core database handle.
 * @param leases Leases requiring backend recovery after scheduler transition.
 * @param now Optional deterministic clock.
 * @param onError Optional sink for one isolated lease projection failure.
 */
export function recordWorkspaceRecoveryTriggersForLeases(
  coreDb: CoreDb,
  leases: readonly SchedulerSessionLeaseRecord[],
  now?: () => string,
  onError?: (error: unknown) => void
): void {
  const timestamp = now?.() ?? new Date().toISOString();

  for (const lease of leases) {
    try {
      const { userId } = requireSchedulerSessionLeaseAdmissionContext(coreDb, lease.leaseId);
      const stateBefore = lease.status === 'lost' ? 'lease-releasing' : 'lease-stale';
      const workspaceDb = openWorkspaceDb(coreDb.dataRoot, userId, lease.workspaceId);
      let handoffComplete = false;
      try {
        applyScopedMigrations(workspaceDb);
        const environmentPackage = requireAgentEnvironmentPackageSnapshot(
          workspaceDb,
          lease.workspaceId,
          lease.packageSnapshotId
        ).snapshot;
        const packageHandles = requireCompleteBackendWorkspaceHandleHandoff(
          workspaceDb,
          environmentPackage
        );
        handoffComplete = true;
        const reconciliationRecordIds = new Set(
          listWorkspaceReconciliationRecords(workspaceDb, lease.workspaceId).map(
            (record) => record.id
          )
        );
        for (const handle of packageHandles) {
          const retainedReleaseTimeout =
            handle.cleanupStatus === 'retained' &&
            stateBefore === 'lease-releasing' &&
            lease.releaseReason === 'release-grace-timeout';
          if (handle.cleanupStatus !== 'pending' && !retainedReleaseTimeout) {
            continue;
          }

          const reconciliationRecordId = `wrr_${lease.leaseId}_${handle.id}`;
          if (reconciliationRecordIds.has(reconciliationRecordId)) {
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
          reconciliationRecordIds.add(reconciliationRecordId);
        }
      } finally {
        workspaceDb.sqlite.close();
      }

      if (handoffComplete) {
        markSchedulerLeaseWorkspaceRecoveryProjected(coreDb, lease.leaseId);
      }
    } catch (error) {
      onError?.(error);
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
      const result = runSchedulerLeaseMaintenanceOnce(coreDb, input);
      void input.cleanupExpiredReconnects().catch((error) => input.onError?.(error));
      return result;
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
