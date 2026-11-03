import { UserIdSchema, WorkspaceIdSchema } from '@openkit/protocol';
import { z } from 'zod';

/** Three original Core stages; physical provisioning and the later User receipt remain outside. */
export const ControlPrivateWorkspaceInputSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('reserve'), userId: UserIdSchema }),
  z.strictObject({
    action: z.literal('bind'),
    userId: UserIdSchema,
    expectedWorkspaceId: WorkspaceIdSchema,
    workspaceId: WorkspaceIdSchema,
    at: z.string().datetime(),
  }),
  z.strictObject({
    action: z.literal('register'),
    userId: UserIdSchema,
    workspaceId: WorkspaceIdSchema,
    at: z.string().datetime(),
  }),
]);
/** Exact stage input, without SQL or a carried authorization result. */
export type ControlPrivateWorkspaceInput = z.infer<typeof ControlPrivateWorkspaceInputSchema>;
/** Reservation returns the selected identity; the other original stages return no value. */
export const ControlPrivateWorkspaceResultSchema = WorkspaceIdSchema.nullable();
/** Closed original domain failures; arbitrary native diagnostics remain redacted. */
export const PrivateWorkspaceMessageSchema = z.enum([
  'Personal workspace requires an active canonical user.',
  'Personal Workspace ownership is contradictory.',
  'Personal Workspace requires active owner membership.',
  'Personal Workspace requires an active registry.',
  'Current personal Workspace binding changed.',
  'Workspace owner requires an active canonical user.',
  'Workspace is already owned by another user.',
  'Workspace owner requires an active registry.',
  'Workspace owner requires an active membership.',
]);
/** Preserves the existing removed-membership class and original domain messages across the private wire. */
export const ControlPrivateWorkspaceRefusalSchema = z.discriminatedUnion('code', [
  z.strictObject({
    operation: z.literal('private-workspace'),
    code: z.literal('membership_removed'),
    message: z.literal('Workspace owner membership has been removed.'),
    status: z.literal(409),
  }),
  z.strictObject({
    operation: z.literal('private-workspace'),
    code: z.literal('personal_workspace_refused'),
    message: PrivateWorkspaceMessageSchema,
    status: z.literal(409),
  }),
]);
