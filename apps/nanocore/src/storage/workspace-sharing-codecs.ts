import {
  AcceptWorkspaceInvitationRequestSchema,
  AuthorizedWorkspaceSummarySchema,
  CreateWorkspaceInvitationRequestSchema,
  DeclineWorkspaceInvitationRequestSchema,
  DisableUserRequestSchema,
  LeaveWorkspaceRequestSchema,
  RecoverWorkspaceAccessRequestSchema,
  RemoveWorkspaceMemberRequestSchema,
  RevokeWorkspaceInvitationRequestSchema,
  TransferWorkspaceOwnershipRequestSchema,
  WorkspaceAccessRecoveryStateSchema,
  WorkspaceInvitationSchema,
  WorkspaceMemberSchema,
} from '@openkit/app-api-schemas';
import { UserIdSchema, WorkspaceIdSchema, WorkspaceRecordSchema } from '@openkit/protocol';
import { z } from 'zod';

const actor = z
  .object({
    userId: UserIdSchema,
    kind: z.enum(['local', 'session', 'token']),
    sessionId: z.string().optional(),
    tokenId: z.string().optional(),
    tokenScope: z.enum(['server-admin', 'workspace', 'workspace-readonly']).optional(),
    tokenWorkspaceIds: z.array(WorkspaceIdSchema).optional(),
    adminTokenId: z.string().optional(),
  })
  .strict();

/** Existing authenticated actor wire facts, shared by Core lifecycle tuples. */
export { actor as ControlCoreSharingActorSchema };

const receipt = z
  .object({
    key: z.string().min(1),
    command: z.enum([
      'workspace.invitation.create',
      'workspace.invitation.accept',
      'workspace.invitation.decline',
      'workspace.invitation.revoke',
      'workspace.member.remove',
      'workspace.leave',
      'workspace.ownership.transfer',
      'workspace.access.recover',
      'user.disable',
    ]),
    requestId: z.string().min(1),
    scope: z.record(z.string(), z.string()),
    inputHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    responseKind: z.enum([
      'workspace_invitation',
      'workspace_member',
      'workspace',
      'workspace_recovery',
      'user',
    ]),
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
  })
  .strict();
const common = { actor, receipt };
/** Complete existing Core command tuple, including only the authenticated actor and exact domain request. */
export const ControlCoreSharingSchema = z.discriminatedUnion('command', [
  z
    .object({
      ...common,
      command: z.literal('workspace.invitation.create'),
      workspaceId: WorkspaceIdSchema,
      request: CreateWorkspaceInvitationRequestSchema,
    })
    .strict(),
  z
    .object({
      ...common,
      command: z.literal('workspace.invitation.accept'),
      invitationId: z.string().min(1),
      request: AcceptWorkspaceInvitationRequestSchema,
    })
    .strict(),
  z
    .object({
      ...common,
      command: z.literal('workspace.invitation.decline'),
      invitationId: z.string().min(1),
      request: DeclineWorkspaceInvitationRequestSchema,
    })
    .strict(),
  z
    .object({
      ...common,
      command: z.literal('workspace.invitation.revoke'),
      workspaceId: WorkspaceIdSchema,
      invitationId: z.string().min(1),
      request: RevokeWorkspaceInvitationRequestSchema,
    })
    .strict(),
  z
    .object({
      ...common,
      command: z.literal('workspace.member.remove'),
      workspaceId: WorkspaceIdSchema,
      memberUserId: UserIdSchema,
      request: RemoveWorkspaceMemberRequestSchema,
    })
    .strict(),
  z
    .object({
      ...common,
      command: z.literal('workspace.leave'),
      workspaceId: WorkspaceIdSchema,
      memberUserId: UserIdSchema,
      request: LeaveWorkspaceRequestSchema,
    })
    .strict(),
  z
    .object({
      ...common,
      command: z.literal('workspace.ownership.transfer'),
      workspaceId: WorkspaceIdSchema,
      workspace: WorkspaceRecordSchema,
      request: TransferWorkspaceOwnershipRequestSchema,
    })
    .strict(),
  z
    .object({
      ...common,
      command: z.literal('workspace.access.recover'),
      workspaceId: WorkspaceIdSchema,
      request: RecoverWorkspaceAccessRequestSchema,
    })
    .strict(),
  z
    .object({
      ...common,
      command: z.literal('user.disable'),
      targetUserId: UserIdSchema,
      request: DisableUserRequestSchema,
    })
    .strict(),
]);
/** Closed family input; its metadata uses the existing cloned-envelope reservation. */
export type ControlCoreSharing = z.infer<typeof ControlCoreSharingSchema>;
/** Main adds the original receipt and the existing non-authority Workspace projection after native preparation. */
export type CoreSharingDraft = ControlCoreSharing extends infer T
  ? T extends ControlCoreSharing
    ? Omit<T, 'receipt' | 'workspace'>
    : never
  : never;
/** Complete current domain responses, never truncated or reread after acknowledgement. */
export const ControlCoreSharingResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('invitation'), value: WorkspaceInvitationSchema }).strict(),
  z.object({ kind: z.literal('member'), value: WorkspaceMemberSchema }).strict(),
  z.object({ kind: z.literal('workspace'), value: AuthorizedWorkspaceSummarySchema }).strict(),
  z.object({ kind: z.literal('recovery'), value: WorkspaceAccessRecoveryStateSchema }).strict(),
  z
    .object({
      kind: z.literal('user'),
      // Preserve the original mutation snapshot; public timestamp validation still follows the ACK and hook.
      value: z
        .object({ userId: UserIdSchema, status: z.literal('disabled'), disabledAt: z.string() })
        .strict(),
    })
    .strict(),
]);
/** Typed success emitted only after the outer FULL commit. */
export type ControlCoreSharingResult = z.infer<typeof ControlCoreSharingResultSchema>;
const refusalBase = { operation: z.literal('core-sharing') };
/** Exact original public refusals; mixed status, message or current-record families fail closed. */
export const ControlCoreSharingRefusalSchema = z.union([
  z
    .object({
      ...refusalBase,
      code: z.literal('workspace_access_denied'),
      message: z.literal('Workspace access denied.'),
      status: z.literal(403),
    })
    .strict(),
  z
    .object({
      ...refusalBase,
      code: z.literal('invitee_unavailable'),
      message: z.literal('The invitation target is unavailable.'),
      status: z.literal(404),
    })
    .strict(),
  z
    .object({
      ...refusalBase,
      code: z.literal('owner_transfer_required'),
      message: z.literal('Workspace ownership must be transferred first.'),
      status: z.literal(409),
    })
    .strict(),
  z
    .object({
      ...refusalBase,
      code: z.literal('quick_chat_not_shareable'),
      message: z.literal('Personal Workspaces cannot be shared.'),
      status: z.literal(409),
    })
    .strict(),
  z
    .object({
      ...refusalBase,
      code: z.literal('recovery_required'),
      message: z.literal('The command outcome cannot be proven from its current durable owners.'),
      status: z.literal(409),
    })
    .strict(),
  z
    .object({
      ...refusalBase,
      code: z.literal('recovery_required'),
      message: z.literal('The command effect exists without its matching receipt.'),
      status: z.literal(409),
    })
    .strict(),
  z
    .object({
      ...refusalBase,
      code: z.literal('deployment_admin_required'),
      message: z.literal('Current deployment administrator authority is required.'),
      status: z.literal(403),
    })
    .strict(),
  z
    .object({
      ...refusalBase,
      code: z.literal('idempotency_key_conflict'),
      message: z.literal('The requestId was already used for different command input.'),
      status: z.literal(409),
    })
    .strict(),
  z
    .object({
      ...refusalBase,
      code: z.literal('invalid_request'),
      message: z.literal('The retained record could not be read.'),
      status: z.literal(400),
    })
    .strict(),
  z
    .object({
      ...refusalBase,
      code: z.literal('invitation_not_pending'),
      message: z.literal('Workspace invitation is not pending.'),
      status: z.literal(409),
      details: z.object({ current: WorkspaceInvitationSchema }).strict(),
    })
    .strict(),
  z
    .object({
      ...refusalBase,
      code: z.literal('revision_conflict'),
      message: z.literal('Workspace invitation revision conflict.'),
      status: z.literal(409),
      details: z
        .object({ current: WorkspaceInvitationSchema, resource: z.literal('invitation') })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...refusalBase,
      code: z.literal('revision_conflict'),
      message: z.literal('Workspace membership revision conflict.'),
      status: z.literal(409),
      details: z
        .object({ current: WorkspaceMemberSchema, resource: z.literal('membership') })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...refusalBase,
      code: z.literal('revision_conflict'),
      message: z.literal('Workspace recovery revision conflict.'),
      status: z.literal(409),
      details: z
        .object({
          current: WorkspaceAccessRecoveryStateSchema,
          resource: z.literal('workspace_recovery'),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...refusalBase,
      code: z.literal('revision_conflict'),
      message: z.literal('Workspace revision conflict.'),
      status: z.literal(409),
      details: z
        .object({ current: AuthorizedWorkspaceSummarySchema, resource: z.literal('workspace') })
        .strict(),
    })
    .strict(),
]);
/** Family-only refusal, not an extension of unrelated native error details. */
export type ControlCoreSharingRefusal = z.infer<typeof ControlCoreSharingRefusalSchema> & {
  readonly kind?: never;
};
