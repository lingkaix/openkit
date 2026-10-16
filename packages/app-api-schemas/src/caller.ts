import { TimestampSchema, WorkspaceIdSchema } from '@openkit/protocol';
import { z } from 'zod';
import { OpenKitAccessTokenScopeSchema } from './auth.js';
import { WorkspaceAccessRelationSchema } from './workspace-sharing.js';

/** Exact optional Workspace selection for a content-free current-caller read. */
export const ReadCallerRequestSchema = z
  .object({ workspaceId: WorkspaceIdSchema.optional() })
  .strict();

/** Non-secret authentication facts; derived administrator authority does not change credential kind. */
export const CallerCredentialSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('local'), scope: z.null() }),
  z.object({ kind: z.literal('session'), scope: z.null() }),
  z.object({ kind: z.literal('token'), scope: OpenKitAccessTokenScopeSchema }),
]);

/** Counts of canonical records currently readable under the caller's source audiences. */
export const CallerRetainedWorkCountsSchema = z.object({
  threads: z.number().int().nonnegative(),
  turns: z.number().int().nonnegative(),
  items: z.number().int().nonnegative(),
  artifacts: z.number().int().nonnegative(),
});

/** One explicitly selected, pre-existing caller-owned Workspace observation, never a continuity claim. */
export const CallerWorkspaceObservationSchema = WorkspaceAccessRelationSchema.safeExtend({
  workspaceId: WorkspaceIdSchema,
  observedAt: TimestampSchema.datetime({ offset: true }),
  counts: CallerRetainedWorkCountsSchema,
});

/** Current identity with no contact, credential value, global inventory, or retained summary. */
export const ReadCallerResponseSchema = z
  .object({
    userId: z.string().min(1),
    credential: CallerCredentialSchema,
    workspace: CallerWorkspaceObservationSchema.optional(),
  })
  .superRefine((value, context) => {
    if (value.workspace && value.workspace.ownerUserId !== value.userId) {
      context.addIssue({
        code: 'custom',
        path: ['workspace', 'ownerUserId'],
        message: 'Caller observation requires the caller-owned Workspace.',
      });
    }
  });

/** Definition-derived current-caller response. */
export type ReadCallerResponse = z.infer<typeof ReadCallerResponseSchema>;
