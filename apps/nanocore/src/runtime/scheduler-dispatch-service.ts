import type { RuntimeConfigSnapshot } from '../config/runtime-config.js';
import { addSchedulerHoldReleaseListener } from '../scheduler-hold-release.js';
import type { HandoffSource } from './scheduler-dispatch-handoff.js';
import {
  type RunSchedulerDispatchLoopInput,
  registerSchedulerDispatchWake,
  releaseSchedulerBackendCapacity,
  releaseSchedulerDispatchHold,
  runSchedulerDispatchLoop,
  type SchedulerDispatchCurrentConfig,
  type SchedulerDispatchLoopResult,
} from './scheduler-dispatch-loop.js';

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
  extends Omit<RunSchedulerDispatchLoopInput, RuntimeConfigDispatchInput>,
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
  /** Runs one dispatch retry iteration immediately; a handoff wake passes source `wake`. */
  readonly runOnce: (source?: HandoffSource) => Promise<SchedulerDispatchLoopResult | null>;
  /** Stops future scheduled dispatch retries. */
  readonly stop: () => void;
}

/** The configuration fields of one runtime snapshot that a dispatch selection uses. */
function currentDispatchConfig(snapshot: RuntimeConfigSnapshot): SchedulerDispatchCurrentConfig {
  return {
    agentManifests: snapshot.agentManifests,
    configVersion: snapshot.version,
    gatewayConfig: snapshot.gatewayConfig,
    providerRegistry: snapshot.providerRegistry,
    userConfigs: snapshot.userConfigs,
    workspaceConfigs: snapshot.workspaceConfigs,
    workspaceDataSourceCatalogs: snapshot.workspaceDataSourceCatalogs,
    workspaceMcpServerCatalogs: snapshot.workspaceMcpServerCatalogs,
  };
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
  const runOnce = async (
    source: HandoffSource = 'external'
  ): Promise<SchedulerDispatchLoopResult | null> => {
    if (stopped) {
      return null;
    }

    try {
      return await runSchedulerDispatchLoop({
        ...input,
        agentWorkPaused: () =>
          input.runtimeConfigSnapshot().openKitConfig.security?.pauseAgentWork === true,
        ...currentDispatchConfig(input.runtimeConfigSnapshot()),
        dispatchSource: source,
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

  // A handoff wake starts one run with source `wake`. Startup and the timer stay fallbacks for a
  // lost wake and for the first scan after restart.
  // A5: each selection also reads the configuration that the owner reports as current.
  const unregisterWake = registerSchedulerDispatchWake(
    input.coreDb,
    () => {
      void runOnce('wake');
    },
    () => currentDispatchConfig(input.runtimeConfigSnapshot())
  );
  // The owner release edges of this Core data root reach only its own handoff.
  const removeHoldReleases = addSchedulerHoldReleaseListener(input.coreDb.dataRoot, {
    hold: (hold) => releaseSchedulerDispatchHold(input.coreDb, hold),
    capacity: (change) => {
      if (change.kind === 'login-close')
        releaseSchedulerDispatchHold(input.coreDb, 'backend-capacity', change);
      // A cleared Login close or a backend owner change is an acknowledged change of the backend
      // owner, so the marks of that backend read their carried refusal again.
      releaseSchedulerBackendCapacity(
        input.coreDb,
        change.kind === 'backend-changed' ? change.backendId : undefined
      );
    },
  });
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
      unregisterWake();
      removeHoldReleases();
      clearTimer(timer);
    },
  };
}
