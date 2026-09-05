import type { RuntimeConfigSnapshot } from '../config/runtime-config.js';
import {
  type RunSchedulerDispatchLoopInput,
  runSchedulerDispatchLoop,
  type SchedulerDispatchLoopResult,
} from './scheduler-dispatch-loop.js';

/** Input for one background scheduler dispatch retry. */
export type RunSchedulerDispatchRetryOnceInput = RunSchedulerDispatchLoopInput;

type RuntimeConfigDispatchInput =
  | 'agentManifests'
  | 'configVersion'
  | 'gatewayConfig'
  | 'providerRegistry'
  | 'userConfigs'
  | 'workspaceConfigs'
  | 'workspaceDataSourceCatalogs'
  | 'workspaceMcpServerCatalogs';

/** Timer hooks used by the dispatch retry service. */
export interface SchedulerDispatchRetryTimerHooks {
  /** Schedules repeated dispatch retries. */
  readonly setInterval?: (callback: () => void, intervalMs: number) => unknown;
  /** Clears the scheduled dispatch retry handle. */
  readonly clearInterval?: (handle: unknown) => void;
}

/** Input used to start the dispatch retry service. */
export interface StartSchedulerDispatchRetryServiceInput
  extends Omit<RunSchedulerDispatchRetryOnceInput, RuntimeConfigDispatchInput>,
    SchedulerDispatchRetryTimerHooks {
  /** Repeated dispatch retry interval. */
  readonly intervalMs: number;
  /** Reads one current runtime config snapshot for each retry iteration. */
  readonly runtimeConfigSnapshot: () => RuntimeConfigSnapshot;
  /** Optional error sink. */
  readonly onError?: (error: unknown) => void;
}

/** Running dispatch retry service handle. */
export interface SchedulerDispatchRetryService {
  /** Runs one dispatch retry iteration immediately. */
  readonly runOnce: () => Promise<SchedulerDispatchLoopResult | null>;
  /** Stops future scheduled dispatch retries. */
  readonly stop: () => void;
}

/**
 * Runs one background dispatch retry through the shared Workspace store.
 *
 * @param input Dispatch retry dependencies.
 * @returns Dispatch loop result.
 */
export function runSchedulerDispatchRetryOnce(
  input: RunSchedulerDispatchRetryOnceInput
): Promise<SchedulerDispatchLoopResult> {
  return runSchedulerDispatchLoop(input);
}

/**
 * Starts periodic scheduler dispatch retry for queued admissions.
 *
 * @param input Service dependencies and timer hooks.
 * @returns Service handle.
 */
export function startSchedulerDispatchRetryService(
  input: StartSchedulerDispatchRetryServiceInput
): SchedulerDispatchRetryService {
  if (input.intervalMs <= 0) {
    throw new Error('Scheduler dispatch retry interval must be positive.');
  }

  let stopped = false;
  const runOnce = async (): Promise<SchedulerDispatchLoopResult | null> => {
    if (stopped) {
      return null;
    }

    try {
      const snapshot = input.runtimeConfigSnapshot();
      return await runSchedulerDispatchRetryOnce({
        ...input,
        agentManifests: snapshot.agentManifests,
        configVersion: snapshot.version,
        gatewayConfig: snapshot.gatewayConfig,
        providerRegistry: snapshot.providerRegistry,
        userConfigs: snapshot.userConfigs,
        workspaceConfigs: snapshot.workspaceConfigs,
        workspaceDataSourceCatalogs: snapshot.workspaceDataSourceCatalogs,
        workspaceMcpServerCatalogs: snapshot.workspaceMcpServerCatalogs,
      });
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
