import {
  type SchedulerTargetHealthRecord,
  upsertSchedulerTargetHealthRecord,
} from '../scheduler-records.js';
import type { CoreDb } from '../storage/db.js';
import type { SchedulerTargetHealthState } from '../storage/schema/index.js';

/** Per-surface scheduler target probe check result. */
export interface SchedulerTargetProbeCheck {
  /** Human-readable diagnostic message. */
  readonly message?: string;
  /** Probe status for this surface. */
  readonly status: 'ok' | 'failed';
  /** Checked surface name. */
  readonly surface: string;
}

/** Scheduler target probe result. */
export interface SchedulerTargetProbeResult {
  /** Per-surface check results stored on the health record. */
  readonly checks: readonly SchedulerTargetProbeCheck[];
  /** Required-check aggregate status. */
  readonly status: 'ok' | 'failed';
}

/** Target metadata passed to a probe implementation. */
export interface SchedulerProbeTarget {
  /** Current durable failure count. */
  readonly consecutiveFailureCount: number;
  /** Current durable success count. */
  readonly consecutiveSuccessCount: number;
  /** Current health state. */
  readonly healthState: SchedulerTargetHealthState;
  /** Whether the target currently has a live scheduler lease. */
  readonly hasLiveLease: boolean;
  /** Stable target id. */
  readonly targetId: string;
}

/** Input for one scheduler health-probe iteration. */
export interface RunSchedulerHealthProbeLoopInput {
  /** Consecutive required-check failures needed for quarantine. */
  readonly failureThreshold: number;
  /** Probe cadence for targets without live leases. */
  readonly idleIntervalMs: number;
  /** Probe cadence for targets with live leases. */
  readonly liveIntervalMs: number;
  /** Optional deterministic clock. */
  readonly now?: () => string;
  /** Probe implementation. */
  readonly probeTarget?: (target: SchedulerProbeTarget) => SchedulerTargetProbeResult;
  /** Consecutive successful probes needed to restore healthy state. */
  readonly successThreshold: number;
}

/** Result of one scheduler health-probe iteration. */
export interface SchedulerHealthProbeLoopResult {
  /** Health records updated by this iteration. */
  readonly probed: SchedulerTargetHealthRecord[];
}

/** Timer hooks used by the health-probe service. */
export interface SchedulerHealthProbeTimerHooks {
  /** Clears the scheduled probe handle. */
  readonly clearInterval?: (handle: unknown) => void;
  /** Schedules repeated health probing. */
  readonly setInterval?: (callback: () => void, intervalMs: number) => unknown;
}

/** Input used to start the health-probe service. */
export interface StartSchedulerHealthProbeServiceInput
  extends RunSchedulerHealthProbeLoopInput,
    SchedulerHealthProbeTimerHooks {
  /** Repeated service interval. */
  readonly intervalMs: number;
  /** Optional error sink. */
  readonly onError?: (error: unknown) => void;
}

/** Running health-probe service handle. */
export interface SchedulerHealthProbeService {
  /** Runs one probe iteration immediately. */
  readonly runOnce: () => SchedulerHealthProbeLoopResult | null;
  /** Stops future scheduled probe iterations. */
  readonly stop: () => void;
}

interface DueHealthRow {
  readonly consecutive_failure_count: number;
  readonly consecutive_success_count: number;
  readonly has_live_lease: 0 | 1;
  readonly health_state: SchedulerTargetHealthState;
  readonly target_id: string;
}

/**
 * Runs one durable scheduler target health-probe iteration.
 *
 * @param coreDb Open Core database handle.
 * @param input Probe policy, cadence, and clock input.
 * @returns Health records updated by this iteration.
 */
export function runSchedulerHealthProbeLoop(
  coreDb: CoreDb,
  input: RunSchedulerHealthProbeLoopInput
): SchedulerHealthProbeLoopResult {
  if (
    input.failureThreshold <= 0 ||
    input.successThreshold <= 0 ||
    input.idleIntervalMs <= 0 ||
    input.liveIntervalMs <= 0
  ) {
    throw new Error('Scheduler health probe loop requires positive thresholds and intervals.');
  }

  const timestamp = input.now?.() ?? new Date().toISOString();
  const rows = coreDb.sqlite
    .prepare(
      `SELECT
        health.target_id,
        health.health_state,
        health.consecutive_failure_count,
        health.consecutive_success_count,
        EXISTS(
          SELECT 1
          FROM scheduler_session_leases AS leases
          WHERE leases.target_id = health.target_id
            AND leases.status IN ('acquired', 'starting', 'active', 'idle')
        ) AS has_live_lease
      FROM scheduler_target_health_records AS health
      WHERE health.next_probe_at <= ?
      ORDER BY health.next_probe_at ASC, health.target_id ASC`
    )
    .all(timestamp) as DueHealthRow[];
  const probed: SchedulerTargetHealthRecord[] = [];

  for (const row of rows) {
    const probe = (input.probeTarget ?? defaultProbeTarget)({
      consecutiveFailureCount: row.consecutive_failure_count,
      consecutiveSuccessCount: row.consecutive_success_count,
      hasLiveLease: row.has_live_lease === 1,
      healthState: row.health_state,
      targetId: row.target_id,
    });
    const nextProbeAt = addMilliseconds(
      timestamp,
      row.has_live_lease === 1 ? input.liveIntervalMs : input.idleIntervalMs
    );

    probed.push(
      upsertSchedulerTargetHealthRecord(coreDb, {
        targetId: row.target_id,
        checkResults: [...probe.checks],
        lastProbeAt: timestamp,
        nextProbeAt,
        ...nextHealthCounters(row, probe, input, timestamp),
      })
    );
  }

  return { probed };
}

/**
 * Starts periodic scheduler health probing for one NanoCore process.
 *
 * @param coreDb Open Core database handle.
 * @param input Service timing and timer hooks.
 * @returns Service handle.
 */
export function startSchedulerHealthProbeService(
  coreDb: CoreDb,
  input: StartSchedulerHealthProbeServiceInput
): SchedulerHealthProbeService {
  if (input.intervalMs <= 0) {
    throw new Error('Scheduler health probe interval must be positive.');
  }

  let stopped = false;
  const runOnce = (): SchedulerHealthProbeLoopResult | null => {
    if (stopped) {
      return null;
    }

    try {
      return runSchedulerHealthProbeLoop(coreDb, input);
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

/**
 * Computes the next persisted health state and counters.
 *
 * @param row Current health row.
 * @param probe Probe result.
 * @param input Probe thresholds.
 * @param timestamp Current loop timestamp.
 * @returns Fields accepted by the target health upsert.
 */
function nextHealthCounters(
  row: DueHealthRow,
  probe: SchedulerTargetProbeResult,
  input: RunSchedulerHealthProbeLoopInput,
  timestamp: string
): Omit<
  Parameters<typeof upsertSchedulerTargetHealthRecord>[1],
  'checkResults' | 'lastProbeAt' | 'nextProbeAt' | 'targetId'
> {
  if (probe.status === 'failed') {
    const consecutiveFailureCount = row.consecutive_failure_count + 1;
    const healthState =
      consecutiveFailureCount >= input.failureThreshold ? 'quarantined' : 'degraded';

    return {
      consecutiveFailureCount,
      consecutiveSuccessCount: 0,
      healthState,
      quarantineEnteredAt: healthState === 'quarantined' ? timestamp : null,
      probationDeadline: null,
    };
  }

  const consecutiveSuccessCount = row.consecutive_success_count + 1;
  const healthState =
    row.health_state === 'quarantined' && consecutiveSuccessCount < input.successThreshold
      ? 'probation'
      : 'healthy';

  return {
    consecutiveFailureCount: 0,
    consecutiveSuccessCount,
    healthState,
    quarantineEnteredAt: null,
    probationDeadline: healthState === 'probation' ? timestamp : null,
  };
}

/**
 * Default local-baseline probe.
 *
 * @param target Target to probe.
 * @returns Optimistic local probe result.
 */
function defaultProbeTarget(target: SchedulerProbeTarget): SchedulerTargetProbeResult {
  // ponytail: local baseline has no target metadata yet; replace with backend doctor checks when target records name a backend endpoint.
  return {
    checks: [
      { status: 'ok', surface: 'scheduler-record' },
      {
        status: target.targetId === 'target_local' ? 'ok' : 'failed',
        surface: 'target-registration',
      },
    ],
    status: target.targetId === 'target_local' ? 'ok' : 'failed',
  };
}

/**
 * Adds milliseconds to an ISO timestamp.
 *
 * @param timestamp ISO timestamp.
 * @param milliseconds Milliseconds to add.
 * @returns ISO timestamp after the duration.
 */
function addMilliseconds(timestamp: string, milliseconds: number): string {
  return new Date(new Date(timestamp).getTime() + milliseconds).toISOString();
}
