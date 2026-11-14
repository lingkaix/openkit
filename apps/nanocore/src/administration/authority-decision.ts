import type { PolicyDecision } from '@openkit/policy-kernel';
import {
  type RecordPermissionDecisionInput,
  recordPermissionDecision,
  recordProductPermissionDecision,
} from '../policy/permission-decisions.js';

/** Shared administration projection through the existing Policy recorder; grants no authority. */
export async function recordAdministrationAuthorityDecision(
  input: Omit<RecordPermissionDecisionInput, 'policyDecision'>,
  decision: PolicyDecision,
  investigation: boolean
): Promise<void> {
  if (!investigation) {
    await recordPermissionDecision({ ...input, policyDecision: decision });
    return;
  }
  await recordProductPermissionDecision({
    ...input,
    result: decision.effect,
    reasonCode:
      decision.reasons[0]?.code === 'missing-privilege'
        ? 'not_granted'
        : (decision.reasons[0]?.code ?? 'unknown'),
    contextSummary: {
      ...input.contextSummary,
      kernelTrace: {
        matchedAssociations: decision.trace.matchedAssociations,
        matchedProhibitions: decision.trace.matchedProhibitions,
      },
    },
  });
}
