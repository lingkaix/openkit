import { randomUUID } from 'node:crypto';
import type { BootReadinessSnapshot } from '@openkit/app-api-schemas';

type BootSubsystemName = keyof BootReadinessSnapshot['subsystems'];

const BOOT_SUBSYSTEMS: BootSubsystemName[] = [
  'config',
  'storage',
  'policy',
  'vault',
  'scheduler',
  'llmGateway',
  'knowledgeIndex',
];
const CRITICAL_SUBSYSTEMS = new Set<BootSubsystemName>(['config', 'storage', 'policy']);

/** Input for computing a boot readiness snapshot. */
export interface BootReadinessInput {
  /** Stable boot id for this process run. */
  bootId: string;
  /** Subsystem states to override from the default ready baseline. */
  subsystems?: Partial<BootReadinessSnapshot['subsystems']>;
}

/**
 * Creates a stable boot id for one NanoCore process run.
 *
 * @returns Boot id.
 */
export function createBootId(): string {
  return `boot_${randomUUID()}`;
}

/**
 * Creates the first boot readiness projection for the current NanoCore process.
 *
 * @returns App API boot readiness read model.
 */
export function createBootReadinessSnapshot(): BootReadinessSnapshot {
  return computeBootReadinessSnapshot({ bootId: createBootId() });
}

/**
 * Computes a boot readiness projection from subsystem states.
 *
 * @param input Boot id and subsystem states.
 * @returns App API boot readiness read model.
 */
export function computeBootReadinessSnapshot(input: BootReadinessInput): BootReadinessSnapshot {
  const subsystems = Object.fromEntries(
    BOOT_SUBSYSTEMS.map((name) => [name, input.subsystems?.[name] ?? readySubsystem()])
  ) as BootReadinessSnapshot['subsystems'];
  const hasCriticalFailure = BOOT_SUBSYSTEMS.some(
    (name) => CRITICAL_SUBSYSTEMS.has(name) && subsystems[name].state === 'failed'
  );
  const hasNonReadySubsystem = BOOT_SUBSYSTEMS.some((name) => subsystems[name].state !== 'ready');

  return {
    bootId: input.bootId,
    acceptingProductWork: !hasCriticalFailure,
    overall: hasCriticalFailure ? 'failed' : hasNonReadySubsystem ? 'degraded' : 'ready',
    subsystems,
  };
}

/**
 * Creates the shutdown readiness projection that stops product-work admission.
 *
 * @param snapshot Current boot readiness snapshot.
 * @returns Readiness snapshot with product work admission closed.
 */
export function createShutdownReadinessSnapshot(
  snapshot: BootReadinessSnapshot
): BootReadinessSnapshot {
  return {
    ...snapshot,
    acceptingProductWork: false,
    overall: snapshot.overall === 'failed' ? 'failed' : 'degraded',
    subsystems: {
      ...snapshot.subsystems,
      scheduler: {
        state: snapshot.subsystems.scheduler.state === 'failed' ? 'failed' : 'degraded',
        reasons: [
          ...snapshot.subsystems.scheduler.reasons,
          {
            code: 'shutdown.in_progress',
            message: 'NanoCore is shutting down.',
            blocks: ['product_work'],
          },
        ],
      },
    },
  };
}

/**
 * Creates a ready subsystem state with no degraded reasons.
 *
 * @returns Ready subsystem readiness state.
 */
function readySubsystem(): BootReadinessSnapshot['subsystems']['config'] {
  return { state: 'ready', reasons: [] };
}
