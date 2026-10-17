import {
  AutomationIdSchema,
  ThreadIdSchema,
  TurnIdSchema,
  WorkspaceIdSchema,
} from '@openkit/protocol';
import { z } from 'zod';

/** Source scope is supplied by authenticated Worker invocation, never by model arguments. */
export const AdmitExternalTriggerRequestSchema = z
  .object({
    workspaceId: WorkspaceIdSchema,
    threadId: ThreadIdSchema,
    turnId: TurnIdSchema,
    eventKey: z.string().min(1).max(1024),
    input: z.string().min(1),
  })
  .strict();

/** Existing queue and Turn references project one immutable event admission. */
export const AdmitExternalTriggerResponseSchema = z.object({
  scheduleId: AutomationIdSchema,
  eventKey: z.string().min(1).max(1024),
  sourceTurnId: TurnIdSchema,
  queueEntryId: z.string().min(1),
  threadId: ThreadIdSchema,
  turnId: TurnIdSchema,
  duplicate: z.boolean(),
});
