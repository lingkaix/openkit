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
      const age = now() - Date.parse(result.status.observedAt);
      const knownAge = Number.isFinite(age) && age >= 0;
      executionHost = {
        state: knownAge ? (result.status.ready ? 'ready' : 'not-ready') : 'unknown',
        observedAt: result.status.observedAt,
        observationAgeMs: knownAge ? Math.trunc(age) : null,
        liveProbe: false,
        freshEmpty: knownAge ? result.status.freshEmpty : null,
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
