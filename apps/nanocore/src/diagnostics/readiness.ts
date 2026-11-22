import type { BootReadinessSnapshot, OperationalReadiness } from '@openkit/app-api-schemas';
import { observeAppUpdatePreflight } from '../app-update/preflight.js';
import type { OperationInvocationDependencies } from '../operation-composition.js';
import { OperationError } from '../operation-error.js';
import { readConfiguredNanoHostRuntimeTargetStatus } from '../runtime/nanohost-runtime-target.js';

/** Projects independent readiness dimensions without claiming helper eligibility or a live host probe. */
export async function observeOperationalReadiness(
  dependencies: Pick<
    OperationInvocationDependencies,
    | 'coreDb'
    | 'store'
    | 'inflightCommands'
    | 'nanoHostConfig'
    | 'mode'
    | 'appUpdateServices'
    | 'readNanoHostTarget'
    | 'afterNanoHostTransportAcknowledgement'
  >,
  boot: BootReadinessSnapshot,
  now: () => number = Date.now,
  signal?: AbortSignal
): Promise<OperationalReadiness> {
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
  const config = dependencies.nanoHostConfig;
  if (config) {
    const readTarget = () =>
      readConfiguredNanoHostRuntimeTargetStatus({
        coreDb: dependencies.coreDb,
        mode: dependencies.mode ?? 'local',
        nanoHostConfig: config,
        ...(dependencies.readNanoHostTarget
          ? { readNanoHostTarget: dependencies.readNanoHostTarget }
          : {}),
      });
    try {
      const result = dependencies.afterNanoHostTransportAcknowledgement
        ? await dependencies.afterNanoHostTransportAcknowledgement(readTarget, signal)
        : readTarget();
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
    } catch (error) {
      if (
        !(error instanceof OperationError) ||
        error.code !== 'nanohost_transport_storage_unavailable'
      )
        throw error;
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
