import { z } from 'zod';

const id = z.string();
const observed = { observedAt: z.string() };
const configured = { targetId: id, identityId: id, deploymentId: id, ...observed };
/** Closed original RuntimeTarget tuples, not physical authority or credential mutation. */
export const ControlRuntimeTargetInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('allocate'), ...configured }).strict(),
  z
    .object({
      kind: z.literal('ready'),
      ...configured,
      connectionGeneration: z.number().int().nonnegative().safe(),
      predecessorFenced: z.boolean(),
      ready: z.boolean(),
      freshEmpty: z.boolean(),
      physicalEpoch: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('close'),
      targetId: id,
      closedGeneration: z.number().int().nonnegative().safe(),
      authoritativeGeneration: z.number().int().nonnegative().safe().nullable(),
      ...observed,
    })
    .strict(),
  z.object({ kind: z.literal('restart'), ...observed }).strict(),
]);
/** Exact internal message for the current target owner. */
export type ControlRuntimeTargetInput = z.infer<typeof ControlRuntimeTargetInputSchema>;
/** Complete original current projection; an absent restart target stays absent. */
export const ControlRuntimeTargetResultSchema = z
  .object({
    targetId: id,
    identityId: id,
    deploymentId: id,
    connectionGeneration: z.number().int().nonnegative().safe(),
    predecessorFenced: z.boolean(),
    ready: z.boolean(),
    freshEmpty: z.boolean(),
    physicalEpoch: z.string().nullable(),
    observedAt: z.string(),
    slotCount: z.literal(1),
  })
  .nullable();
/** Original row after covering FULL acknowledgement. */
export type ControlRuntimeTargetResult = z.infer<typeof ControlRuntimeTargetResultSchema>;
/** Only known target refusals cross the trusted private error projection. */
export class RuntimeTargetRefusal extends Error {}
/** Exact domain refusal, never a raw SQLite failure. */
export const ControlRuntimeTargetRefusalSchema = z
  .object({
    operation: z.literal('runtime-target'),
    code: z.literal('runtime_target_refused'),
    message: z.string(),
    status: z.literal(409),
  })
  .strict();
