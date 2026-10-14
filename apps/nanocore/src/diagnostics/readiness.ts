import type { BootReadinessSnapshot, OperationalReadiness } from '@openkit/app-api-schemas';
import { observeAppUpdatePreflight } from '../app-update/preflight.js';
import type { OperationInvocationDependencies } from '../operation-composition.js';
import { OperationError } from '../operation-error.js';
import { readConfiguredNanoHostRuntimeTargetStatus } from '../runtime/nanohost-runtime-target.js';

/** Projects independent readiness dimensions without claiming helper eligibility or a live host probe. */
export function observeOperationalReadiness(
  dependencies: Pick<
    OperationInvocationDependencies,
    'coreDb' | 'store' | 'inflightCommands' | 'nanoHostConfig' | 'mode' | 'appUpdateServices'
  >,
  boot: BootReadinessSnapshot,
  now: () => number = Date.now
): OperationalReadiness {
  let observation: OperationalReadiness['maintenanceSafety']['observation'] = null;
  try {
    observation = observeAppUpdatePreflight(dependencies, now);
  } catch (error) {
    if (!(error instanceof OperationError) || error.code !== 'app_update_unavailable') throw error;
  }
  let executionHost: OperationalReadiness['executionHost'] = {
    state: dependencies.nanoHostConfig ? 'unknown' : 'unconfigured',
    observedAt: null,
    observationAgeMs: null,
    liveProbe: false,
    freshEmpty: null,
  };
  if (dependencies.nanoHostConfig) {
    const result = readConfiguredNanoHostRuntimeTargetStatus({
      coreDb: dependencies.coreDb,
      mode: dependencies.mode ?? 'local',
      nanoHostConfig: dependencies.nanoHostConfig,
    });
    if (result.ok) {
      executionHost = {
        state: result.status.ready ? 'ready' : 'not-ready',
        observedAt: result.status.observedAt,
        observationAgeMs: Math.max(0, Math.trunc(now() - Date.parse(result.status.observedAt))),
        liveProbe: false,
        freshEmpty: result.status.freshEmpty,
      };
    }
  }
  return {
    serviceAvailability: 'available',
    productWork: boot.acceptingProductWork ? 'ready' : 'blocked',
    update: {
      state: dependencies.appUpdateServices?.transport ? 'configured' : 'unconfigured',
      qualification: 'prepare-required',
    },
    maintenanceSafety: { state: observation?.state ?? 'unknown', observation },
    executionHost,
  };
}
