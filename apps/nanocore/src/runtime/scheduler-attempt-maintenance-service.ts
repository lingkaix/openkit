/** The existing maintenance timer serializes attempt inspection and the adapter's recovery owner. */
export interface SchedulerAttemptMaintenanceInput {
  readonly intervalMs: number;
  readonly runRecoveryMaintenance: () => Promise<void>;
  readonly onError?: (error: unknown) => void;
  readonly setInterval?: (callback: () => void, intervalMs: number) => unknown;
  readonly clearInterval?: (handle: unknown) => void;
}
/** Existing timer handle; stopping does not fabricate cancellation or release. */
export interface SchedulerAttemptMaintenanceService {
  readonly runOnce: () => Promise<void>;
  readonly stop: () => void;
}
/** Runs one serial recovery pass and exposes failures to callers and the timer error sink. */
export function startSchedulerAttemptMaintenanceService(
  input: SchedulerAttemptMaintenanceInput
): SchedulerAttemptMaintenanceService {
  if (!Number.isFinite(input.intervalMs) || input.intervalMs <= 0)
    throw new Error('Attempt maintenance interval must be positive.');
  let stopped = false;
  let active: Promise<void> | null = null;
  const runOnce = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (active) return active;
    const operation = Promise.resolve().then(input.runRecoveryMaintenance);
    active = operation;
    void operation
      .finally(() => {
        if (active === operation) active = null;
      })
      .catch(() => {});
    return operation;
  };
  const tick = () => {
    void runOnce().catch((error) => {
      if (input.onError) input.onError(error);
      else console.error(error);
    });
  };
  const timer = (input.setInterval ?? setInterval)(tick, input.intervalMs);
  tick();
  return {
    runOnce,
    stop: () => {
      if (stopped) return;
      stopped = true;
      (
        input.clearInterval ??
        ((handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>))
      )(timer);
    },
  };
}
