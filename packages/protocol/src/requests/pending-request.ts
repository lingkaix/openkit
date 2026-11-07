import { z } from 'zod';
import { ThreadIdSchema, WorkspaceIdSchema } from '../common/ids.js';

/** Answer command for one pending user-input request. */
export const AnswerUserInputRequestSchema = z
  .object({
    userInputRequestId: z.string().min(1),
    workspaceId: WorkspaceIdSchema,
    threadId: ThreadIdSchema,
    requestId: z.string().min(1),
    answers: z.record(z.string().min(1), z.tuple([z.string().min(1)])),
  })
  .strip();

/** Withdrawal command for one pending request. */
export const WithdrawPendingRequestSchema = z
  .object({
    pendingRequestId: z.string().min(1),
    workspaceId: WorkspaceIdSchema,
    threadId: ThreadIdSchema,
    requestId: z.string().min(1),
  })
  .strip();

/** Lifecycle of one pending request. */
export const PendingRequestStateSchema = z.enum(['pending', 'resolved', 'ended']);

/** Closed resolution recorded when a pending request is resolved. */
export const PendingRequestResolutionSchema = z.enum(['granted', 'denied', 'answered']);

/** Closed ending recorded when a pending request ends without a resolution. */
export const PendingRequestEndingSchema = z.enum(['withdrawn', 'invalidated']);

/** Claim lifecycle shared by pending-request projections. */
export const PendingRequestClaimSchema = z.enum(['unclaimed', 'claimed', 'finished']);

/** Execution disposition recorded after a pending request is decided. */
export const PendingRequestDispositionSchema = z.enum([
  'approved-executed',
  'denied-not-executed',
  'execution-error',
  'outcome-unknown',
]);

/** Command outcome returned by answer and withdraw. */
export const PendingRequestOutcomeSchema = z
  .object({
    requestId: z.string().min(1),
    workspaceId: WorkspaceIdSchema,
    threadId: ThreadIdSchema,
    state: PendingRequestStateSchema,
    resolution: PendingRequestResolutionSchema.nullable(),
    ending: PendingRequestEndingSchema.nullable(),
  })
  .strip();

/** Answer command body. */
export type AnswerUserInputRequest = z.infer<typeof AnswerUserInputRequestSchema>;
/** Withdrawal command body. */
export type WithdrawPendingRequest = z.infer<typeof WithdrawPendingRequestSchema>;
/** Answer or withdrawal outcome. */
export type PendingRequestOutcome = z.infer<typeof PendingRequestOutcomeSchema>;
