import { type ReasoningEffort, ReasoningEffortSchema } from '@openkit/protocol';
import type { WorkerResidentTurnInput } from './adapter-registry.js';

/**
 * Checks closed Core effort values before an adapter starts any native Turn effects.
 * @param input The admitted per-Turn package projection.
 * @returns Its recorded effort, retaining absence without a default.
 */
export function validateTurnReasoningEffort(
  input: WorkerResidentTurnInput
): ReasoningEffort | undefined {
  for (const route of [input.llmRoute, ...input.allowedLlmRoutes]) {
    if (route.reasoningEffortLevels !== undefined)
      ReasoningEffortSchema.array().parse(route.reasoningEffortLevels);
  }
  return ReasoningEffortSchema.optional().parse(input.reasoningEffort);
}
