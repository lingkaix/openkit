import {
  markExpiredSchedulerLeasesStale,
  markStartupTimedOutSchedulerLeasesFailed,
  type SchedulerSessionLeaseRecord,
} from '../scheduler-records.js';
import type { CoreDb } from '../storage/db.js';

/** Input for one scheduler lease-watch loop iteration. */
export interface RunSchedulerLeaseWatchLoopInput {
  /** Optional deterministic clock. */
  readonly now?: () => string;
}

/** Result of one scheduler lease-watch loop iteration. */
export interface SchedulerLeaseWatchLoopResult {
  /** Leases failed because startup never reached the first heartbeat. */
  readonly startupTimedOut: SchedulerSessionLeaseRecord[];
  /** Live leases marked stale because lease or heartbeat deadlines elapsed. */
  readonly stale: SchedulerSessionLeaseRecord[];
}

/**
 * Runs one durable scheduler lease-watch iteration.
 *
 * @param coreDb Open Core database handle.
 * @param input Optional deterministic clock.
 * @returns Leases changed by this iteration.
 */
export function runSchedulerLeaseWatchLoop(
  coreDb: CoreDb,
  input: RunSchedulerLeaseWatchLoopInput = {}
): SchedulerLeaseWatchLoopResult {
  const startupTimedOut = markStartupTimedOutSchedulerLeasesFailed(coreDb, input);
  const stale = markExpiredSchedulerLeasesStale(coreDb, input);

  return { startupTimedOut, stale };
}
