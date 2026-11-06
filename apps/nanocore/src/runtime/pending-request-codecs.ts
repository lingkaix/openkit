import { z } from 'zod';

/** Responses carry only affected identities and the existing CAS outcome; captured input/results stay in their owner. */
export const ControlPendingCommandResultSchema = z
  .object({
    requestIds: z.array(z.string().min(1)),
    applied: z.enum(['claimed', 'refused', 'ended', 'lost']).nullable(),
    created: z.boolean().nullable(),
  })
  .strict();
