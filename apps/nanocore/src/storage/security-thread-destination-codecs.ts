import { ThreadIdSchema, UserIdSchema, WorkspaceIdSchema } from '@openkit/protocol';
import { z } from 'zod';

/** Native-assigned original destination, not a name-based Thread classification or caller grant. */
export const SecurityThreadDestinationSchema = z
  .object({
    recipientUserId: UserIdSchema,
    generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    workspaceId: WorkspaceIdSchema,
    threadId: ThreadIdSchema,
    sourceRequestId: z.string().uuid(),
    status: z.enum(['reserved', 'ready']),
  })
  .strict();
export type SecurityThreadDestination = z.infer<typeof SecurityThreadDestinationSchema>;
