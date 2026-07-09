import type { BootReadinessSnapshot } from '@openkit/app-api-schemas';
import { computeBootReadinessSnapshot } from './readiness.js';

type BootSubsystemName = keyof BootReadinessSnapshot['subsystems'];
type BootReadinessReason = BootReadinessSnapshot['subsystems']['config']['reasons'][number];

/** Successful boot phase outcome. */
export interface BootPhaseOkOutcome {
  /** Phase completed without degraded behavior. */
  status: 'ok';
}

/** Degraded boot phase outcome. */
export interface BootPhaseDegradedOutcome {
  /** Phase completed with a bounded degraded mode. */
  status: 'degraded';
  /** Machine-readable degraded reason. */
  reason: BootReadinessReason;
}

/** Failed boot phase outcome. */
export interface BootPhaseFailedOutcome {
  /** Phase failed. */
  status: 'failed';
  /** Machine-readable failure reason. */
  reason: BootReadinessReason;
}

/** Result returned by one boot phase executor. */
export type BootPhaseOutcome =
  | BootPhaseOkOutcome
  | BootPhaseDegradedOutcome
  | BootPhaseFailedOutcome;

/** Boot phase executor definition. */
export interface BootPhase {
  /** Stable phase name for audit and diagnostics. */
  name: string;
  /** Readiness subsystem owned by this phase. */
  subsystem: BootSubsystemName;
  /** Whether a failed outcome stops boot immediately. */
  critical: boolean;
  /** Executes the phase. */
  run(): BootPhaseOutcome | Promise<BootPhaseOutcome>;
}

/** Input for running boot phases. */
export interface BootPhaseRunInput {
  /** Stable boot id for this process run. */
  bootId: string;
  /** Ordered phase list. */
  phases: BootPhase[];
}

/** Recorded boot phase outcome. */
export interface RecordedBootPhaseOutcome {
  /** Stable phase name. */
  name: string;
  /** Readiness subsystem owned by the phase. */
  subsystem: BootSubsystemName;
  /** Whether a failed outcome stopped boot. */
  critical: boolean;
  /** Phase executor result. */
  outcome: BootPhaseOutcome;
}

/** Output from running boot phases. */
export interface BootPhaseRunResult {
  /** Ordered outcomes for phases that ran. */
  outcomes: RecordedBootPhaseOutcome[];
  /** Readiness projection derived from phase outcomes. */
  readiness: BootReadinessSnapshot;
}

/**
 * Formats the product-work blocking boot failure for logs and process exits.
 *
 * @param result Completed boot phase run result.
 * @returns Human-readable failure summary.
 */
export function formatBootFailureMessage(result: BootPhaseRunResult): string {
  const failed = result.outcomes.find(
    (outcome) => outcome.critical && outcome.outcome.status === 'failed'
  );

  if (failed?.outcome.status === 'failed') {
    return `NanoCore boot failed during critical phase "${failed.name}": ${failed.outcome.reason.message}`;
  }

  const blocked = Object.entries(result.readiness.subsystems).find(([, subsystem]) =>
    subsystem.reasons.some((reason) => reason.blocks.includes('product_work'))
  );
  const reason = blocked?.[1].reasons.find((candidate) =>
    candidate.blocks.includes('product_work')
  );

  return `NanoCore boot blocked product work${reason ? `: ${reason.message}` : '.'}`;
}

/**
 * Runs boot phases in order and computes the resulting readiness projection.
 *
 * @param input Boot phase run input.
 * @returns Ordered outcomes and derived readiness.
 */
export async function runBootPhases(input: BootPhaseRunInput): Promise<BootPhaseRunResult> {
  const outcomes: RecordedBootPhaseOutcome[] = [];

  for (const phase of input.phases) {
    const outcome = await runBootPhase(phase);
    outcomes.push({
      name: phase.name,
      subsystem: phase.subsystem,
      critical: phase.critical,
      outcome,
    });

    if (phase.critical && outcome.status === 'failed') {
      break;
    }
  }

  return {
    outcomes,
    readiness: computeBootReadinessSnapshot({
      bootId: input.bootId,
      subsystems: readinessSubsystemsForOutcomes(outcomes),
    }),
  };
}

/**
 * Runs one boot phase and converts thrown errors into failed outcomes.
 *
 * @param phase Boot phase to run.
 * @returns Phase outcome.
 */
async function runBootPhase(phase: BootPhase): Promise<BootPhaseOutcome> {
  try {
    return await phase.run();
  } catch (error) {
    return {
      status: 'failed',
      reason: {
        code: `${phase.name}.failed`,
        message: error instanceof Error ? error.message : String(error),
        blocks: ['product_work'],
      },
    };
  }
}

/**
 * Converts phase outcomes into subsystem readiness overrides.
 *
 * @param outcomes Phase outcomes that ran.
 * @returns Readiness subsystem overrides.
 */
function readinessSubsystemsForOutcomes(
  outcomes: RecordedBootPhaseOutcome[]
): Partial<BootReadinessSnapshot['subsystems']> {
  const subsystems: Partial<BootReadinessSnapshot['subsystems']> = {};

  for (const outcome of outcomes) {
    if (outcome.outcome.status === 'ok') {
      subsystems[outcome.subsystem] ??= { state: 'ready', reasons: [] };
      continue;
    }

    subsystems[outcome.subsystem] = {
      state: outcome.outcome.status,
      reasons: [outcome.outcome.reason],
    };
  }

  return subsystems;
}
