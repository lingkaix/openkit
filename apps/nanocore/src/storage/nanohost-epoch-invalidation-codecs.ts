import { z } from 'zod';
import { ControlRuntimeTargetInputSchema } from './runtime-target-codecs.js';

export const NanoHostEpochPlacementSchema = z.object({
  deploymentId: z.string().min(1),
  runtimeTargetId: z.string().min(1),
  physicalEpoch: z.string().regex(/^[a-f0-9]{64}$/),
  generation: z.string().regex(/^[1-9][0-9]*$/),
});

const predecessorSchema = z.object({
  targetId: z.string().min(1),
  generation: z.number().int().nonnegative().safe(),
  fence: NanoHostEpochPlacementSchema.nullable(),
});

const transitionOccurrenceId = z.string().min(1).max(128);

/** Private Worker tuple. A logical transition retains this entire tuple on retry. */
export const NanoHostRuntimeTargetTransitionSchema = z
  .object({
    occurrenceId: transitionOccurrenceId,
    input: ControlRuntimeTargetInputSchema,
    predecessor: predecessorSchema.nullable(),
    retirement: NanoHostEpochPlacementSchema.nullable(),
  })
  .strict();

export type NanoHostRuntimeTargetTransition = z.infer<typeof NanoHostRuntimeTargetTransitionSchema>;
