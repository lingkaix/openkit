import type { WorkerGovernanceEvidenceRecord } from './worker-governance-backend.js';

/** Collector used by the OpenShell refresh-status polling service. */
export interface OpenShellRefreshStatusCollector {
  /**
   * Polls product-safe refresh status evidence for active provider-backed sessions.
   *
   * @returns Product-safe refresh status evidence records.
   */
  collectProviderRefreshStatuses(): Promise<WorkerGovernanceEvidenceRecord[]>;
}

/** Timer hooks used by the OpenShell refresh-status polling service. */
export interface OpenShellRefreshStatusPollingTimerHooks {
  /** Clears the scheduled polling handle. */
  readonly clearInterval?: (handle: unknown) => void;
  /** Schedules repeated refresh status polling. */
  readonly setInterval?: (callback: () => void, intervalMs: number) => unknown;
}

/** Input used to start OpenShell refresh-status polling. */
export interface StartOpenShellRefreshStatusPollingServiceInput
  extends OpenShellRefreshStatusPollingTimerHooks {
  /** Active worker governance collector. */
  readonly collector: OpenShellRefreshStatusCollector;
  /** Repeated polling interval. */
  readonly intervalMs: number;
  /** Optional error sink. */
  readonly onError?: (error: unknown) => void;
}

/** Running OpenShell refresh-status polling service handle. */
export interface OpenShellRefreshStatusPollingService {
  /** Runs one polling iteration immediately. */
  readonly runOnce: () => Promise<WorkerGovernanceEvidenceRecord[] | null>;
  /** Stops future scheduled polling. */
  readonly stop: () => void;
}

/**
 * Starts periodic OpenShell provider refresh-status polling.
 *
 * @param input Collector, cadence, and timer hooks.
 * @returns Service handle.
 */
export function startOpenShellRefreshStatusPollingService(
  input: StartOpenShellRefreshStatusPollingServiceInput
): OpenShellRefreshStatusPollingService {
  if (input.intervalMs <= 0) {
    throw new Error('OpenShell refresh status polling interval must be positive.');
  }

  let stopped = false;
  const runOnce = async (): Promise<WorkerGovernanceEvidenceRecord[] | null> => {
    if (stopped) {
      return null;
    }

    try {
      return await input.collector.collectProviderRefreshStatuses();
    } catch (error) {
      input.onError?.(error);
      return null;
    }
  };
  const setTimer = input.setInterval ?? setInterval;
  const clearTimer =
    input.clearInterval ??
    ((handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>));

  void runOnce();
  const timer = setTimer(() => {
    void runOnce();
  }, input.intervalMs);

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
