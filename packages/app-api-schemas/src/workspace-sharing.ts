import {
  ApiErrorSchema,
  RequestIdSchema,
  TimestampSchema,
  WorkspaceIdSchema,
  WorkspaceRecordSchema,
} from '@openkit/protocol';
import { z } from 'zod';

/** Workspace access level granted by one active membership. */
export const WorkspaceAccessLevelSchema = z.enum(['editor', 'viewer']);

/** Effective Workspace role after ownership and membership are combined. */
export const WorkspaceEffectiveRoleSchema = z.enum(['owner', 'editor', 'viewer']);

/** Durable lifecycle state of one Workspace membership. */
export const WorkspaceMembershipStatusSchema = z.enum(['active', 'removed']);

/** Current invitation outcome, including the computed expired projection. */
export const WorkspaceInvitationEffectiveStatusSchema = z.enum([
  'pending',
  'expired',
  'accepted',
  'declined',
  'revoked',
]);

/** Positive revision used by Workspace sharing compare-and-set mutations. */
export const WorkspaceRevisionSchema = z.number().int().positive();

/** Closed projection returned after one canonical user is disabled. */
export const UserLifecycleSummarySchema = z
  .object({
    userId: z.string().min(1),
    status: z.literal('disabled'),
    disabledAt: TimestampSchema,
  })
  .strict();

/** Authorized Workspace projection returned to one current caller. */
export const AuthorizedWorkspaceSummarySchema = z
  .object({
    workspace: WorkspaceRecordSchema,
    ownerUserId: z.string().min(1),
    effectiveRole: WorkspaceEffectiveRoleSchema,
    registryRevision: WorkspaceRevisionSchema,
    membershipRevision: WorkspaceRevisionSchema,
  })
  .strict();

/** Administrator-safe Workspace access recovery projection. */
export const WorkspaceAccessRecoveryStateSchema = z
  .object({
    workspaceId: WorkspaceIdSchema,
    ownerUserId: z.string().min(1),
    administratorRole: WorkspaceEffectiveRoleSchema.nullable(),
    registryRevision: WorkspaceRevisionSchema,
  })
  .strict();

/** Fields shared by every Workspace membership projection variant. */
const WorkspaceMemberBaseSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  userId: z.string().min(1),
  invitationId: z.string().min(1).nullable(),
  joinedAt: TimestampSchema,
  revision: WorkspaceRevisionSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

/** Closed public projection of one Workspace membership. */
export const WorkspaceMemberSchema = z.union([
  WorkspaceMemberBaseSchema.extend({
    status: z.literal('active'),
    accessLevel: z.literal('editor'),
    effectiveRole: z.literal('owner'),
    removedAt: z.null(),
  }).strict(),
  WorkspaceMemberBaseSchema.extend({
    status: z.literal('active'),
    accessLevel: z.literal('editor'),
    effectiveRole: z.literal('editor'),
    removedAt: z.null(),
  }).strict(),
  WorkspaceMemberBaseSchema.extend({
    status: z.literal('active'),
    accessLevel: z.literal('viewer'),
    effectiveRole: z.literal('viewer'),
    removedAt: z.null(),
  }).strict(),
  WorkspaceMemberBaseSchema.extend({
    status: z.literal('removed'),
    accessLevel: WorkspaceAccessLevelSchema,
    effectiveRole: z.null(),
    removedAt: TimestampSchema,
  }).strict(),
]);

/** Fields shared by every Workspace invitation projection variant. */
const WorkspaceInvitationBaseSchema = z.object({
  invitationId: z.string().min(1),
  workspaceId: WorkspaceIdSchema,
  inviteeUserId: z.string().min(1),
  proposedAccessLevel: WorkspaceAccessLevelSchema,
  inviterUserId: z.string().min(1),
  expiresAt: TimestampSchema,
  revision: WorkspaceRevisionSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

/** Pending invitation projection with no terminal decision. */
const PendingWorkspaceInvitationSchema = WorkspaceInvitationBaseSchema.extend({
  effectiveStatus: z.literal('pending'),
  acceptedAt: z.null(),
  declinedAt: z.null(),
  revokedAt: z.null(),
}).strict();

/** Deadline-expired invitation projection with no terminal decision. */
const ExpiredWorkspaceInvitationSchema = WorkspaceInvitationBaseSchema.extend({
  effectiveStatus: z.literal('expired'),
  acceptedAt: z.null(),
  declinedAt: z.null(),
  revokedAt: z.null(),
}).strict();

/** Accepted invitation projection. */
const AcceptedWorkspaceInvitationSchema = WorkspaceInvitationBaseSchema.extend({
  effectiveStatus: z.literal('accepted'),
  acceptedAt: TimestampSchema,
  declinedAt: z.null(),
  revokedAt: z.null(),
}).strict();

/** Declined invitation projection. */
const DeclinedWorkspaceInvitationSchema = WorkspaceInvitationBaseSchema.extend({
  effectiveStatus: z.literal('declined'),
  acceptedAt: z.null(),
  declinedAt: TimestampSchema,
  revokedAt: z.null(),
}).strict();

/** Revoked invitation projection. */
const RevokedWorkspaceInvitationSchema = WorkspaceInvitationBaseSchema.extend({
  effectiveStatus: z.literal('revoked'),
  acceptedAt: z.null(),
  declinedAt: z.null(),
  revokedAt: TimestampSchema,
}).strict();

/** Closed public projection of one Workspace invitation. */
export const WorkspaceInvitationSchema = z.union([
  PendingWorkspaceInvitationSchema,
  ExpiredWorkspaceInvitationSchema,
  AcceptedWorkspaceInvitationSchema,
  DeclinedWorkspaceInvitationSchema,
  RevokedWorkspaceInvitationSchema,
]);

/** Invitation projection that can no longer accept a terminal transition. */
const NonPendingWorkspaceInvitationSchema = z.union([
  ExpiredWorkspaceInvitationSchema,
  AcceptedWorkspaceInvitationSchema,
  DeclinedWorkspaceInvitationSchema,
  RevokedWorkspaceInvitationSchema,
]);

/** Request that creates one Workspace invitation for an existing user email. */
export const CreateWorkspaceInvitationRequestSchema = z
  .object({
    requestId: RequestIdSchema,
    inviteeEmail: z.string().email(),
    proposedAccessLevel: WorkspaceAccessLevelSchema,
  })
  .strict();

/** Shared request body for one invitation terminal transition. */
const WorkspaceInvitationTransitionRequestSchema = z
  .object({
    requestId: RequestIdSchema,
    expectedRevision: WorkspaceRevisionSchema,
  })
  .strict();

/** Request that accepts one pending Workspace invitation. */
export const AcceptWorkspaceInvitationRequestSchema = WorkspaceInvitationTransitionRequestSchema;

/** Request that declines one pending Workspace invitation. */
export const DeclineWorkspaceInvitationRequestSchema = WorkspaceInvitationTransitionRequestSchema;

/** Request that revokes one pending Workspace invitation. */
export const RevokeWorkspaceInvitationRequestSchema = WorkspaceInvitationTransitionRequestSchema;

/** Request that changes one active member's Workspace access level. */
export const ChangeWorkspaceMemberAccessRequestSchema = z
  .object({
    requestId: RequestIdSchema,
    expectedRevision: WorkspaceRevisionSchema,
    accessLevel: WorkspaceAccessLevelSchema,
  })
  .strict();

/** Shared request body for removing one current Workspace membership. */
const WorkspaceMembershipRemovalRequestSchema = z
  .object({
    requestId: RequestIdSchema,
    expectedRevision: WorkspaceRevisionSchema,
  })
  .strict();

/** Request that removes one non-owner Workspace member. */
export const RemoveWorkspaceMemberRequestSchema = WorkspaceMembershipRemovalRequestSchema;

/** Request that removes the current caller's non-owner Workspace membership. */
export const LeaveWorkspaceRequestSchema = WorkspaceMembershipRemovalRequestSchema;

/** Request that transfers Workspace ownership to one active editor. */
export const TransferWorkspaceOwnershipRequestSchema = z
  .object({
    requestId: RequestIdSchema,
    targetUserId: z.string().min(1),
    expectedRegistryRevision: WorkspaceRevisionSchema,
  })
  .strict();

/** Administrator-only bounded action for restoring the caller's Workspace access. */
export const RecoverWorkspaceAccessRequestSchema = z
  .object({
    action: z.enum(['add-self-as-editor', 'transfer-ownership-to-self']),
    requestId: RequestIdSchema,
    expectedRegistryRevision: WorkspaceRevisionSchema,
  })
  .strict();

/** Request that disables one exact canonical user. */
export const DisableUserRequestSchema = z.object({ requestId: RequestIdSchema }).strict();

/** Response listing every Workspace authorized for the current caller. */
export const ListAuthorizedWorkspacesResponseSchema = z
  .object({ items: z.array(AuthorizedWorkspaceSummarySchema) })
  .strict();

/** Response listing Workspace memberships visible to the current caller. */
export const ListWorkspaceMembersResponseSchema = z
  .object({ items: z.array(WorkspaceMemberSchema) })
  .strict();

/** Response listing Workspace invitations visible to the current caller. */
export const ListWorkspaceInvitationsResponseSchema = z
  .object({ items: z.array(WorkspaceInvitationSchema) })
  .strict();

/** Response returned after one invitation mutation. */
export const WorkspaceInvitationMutationResponseSchema = z
  .object({ invitation: WorkspaceInvitationSchema })
  .strict();

/** Response returned after one membership mutation. */
export const WorkspaceMemberMutationResponseSchema = z
  .object({ member: WorkspaceMemberSchema })
  .strict();

/** Response returned after ownership transfer. */
export const WorkspaceOwnershipMutationResponseSchema = z
  .object({ workspace: AuthorizedWorkspaceSummarySchema })
  .strict();

/** Response returned by Workspace access recovery reads and mutations. */
export const WorkspaceAccessRecoveryResponseSchema = z
  .object({ recovery: WorkspaceAccessRecoveryStateSchema })
  .strict();

/** Response returned after one canonical user is disabled. */
export const DisableUserResponseSchema = z.object({ user: UserLifecycleSummarySchema }).strict();

/** Safe current record returned by one Workspace sharing revision conflict. */
export const WorkspaceRevisionConflictDetailsSchema = z.discriminatedUnion('resource', [
  z
    .object({ resource: z.literal('workspace'), current: AuthorizedWorkspaceSummarySchema })
    .strict(),
  z.object({ resource: z.literal('membership'), current: WorkspaceMemberSchema }).strict(),
  z.object({ resource: z.literal('invitation'), current: WorkspaceInvitationSchema }).strict(),
  z
    .object({
      resource: z.literal('workspace_recovery'),
      current: WorkspaceAccessRecoveryStateSchema,
    })
    .strict(),
]);

/** Workspace sharing failure that intentionally exposes no record details. */
const WorkspaceSharingErrorWithoutDetailsSchema = ApiErrorSchema.extend({
  code: z.enum([
    'workspace_access_denied',
    'invitee_unavailable',
    'quick_chat_not_shareable',
    'owner_transfer_required',
  ]),
  details: z.never().optional(),
}).strict();

/** Failure returned when an invitation no longer permits a terminal transition. */
const WorkspaceInvitationNotPendingErrorSchema = ApiErrorSchema.extend({
  code: z.literal('invitation_not_pending'),
  details: z.object({ current: NonPendingWorkspaceInvitationSchema }).strict(),
}).strict();

/** Failure returned when a Workspace sharing compare-and-set predicate is stale. */
const WorkspaceRevisionConflictErrorSchema = ApiErrorSchema.extend({
  code: z.literal('revision_conflict'),
  details: WorkspaceRevisionConflictDetailsSchema,
}).strict();

/** Closed typed error family for Workspace sharing operations. */
export const WorkspaceSharingErrorSchema = z.union([
  WorkspaceSharingErrorWithoutDetailsSchema,
  WorkspaceInvitationNotPendingErrorSchema,
  WorkspaceRevisionConflictErrorSchema,
]);

/** Workspace access level granted by one active membership. */
export type WorkspaceAccessLevel = z.infer<typeof WorkspaceAccessLevelSchema>;
/** Effective Workspace role after ownership and membership are combined. */
export type WorkspaceEffectiveRole = z.infer<typeof WorkspaceEffectiveRoleSchema>;
/** Durable lifecycle state of one Workspace membership. */
export type WorkspaceMembershipStatus = z.infer<typeof WorkspaceMembershipStatusSchema>;
/** Current invitation outcome, including the computed expired projection. */
export type WorkspaceInvitationEffectiveStatus = z.infer<
  typeof WorkspaceInvitationEffectiveStatusSchema
>;
/** Closed projection returned after one canonical user is disabled. */
export type UserLifecycleSummary = z.infer<typeof UserLifecycleSummarySchema>;
/** Authorized Workspace projection returned to one current caller. */
export type AuthorizedWorkspaceSummary = z.infer<typeof AuthorizedWorkspaceSummarySchema>;
/** Administrator-safe Workspace access recovery projection. */
export type WorkspaceAccessRecoveryState = z.infer<typeof WorkspaceAccessRecoveryStateSchema>;
/** Closed public projection of one Workspace membership. */
export type WorkspaceMember = z.infer<typeof WorkspaceMemberSchema>;
/** Closed public projection of one Workspace invitation. */
export type WorkspaceInvitation = z.infer<typeof WorkspaceInvitationSchema>;
/** Request that creates one Workspace invitation. */
export type CreateWorkspaceInvitationRequest = z.infer<
  typeof CreateWorkspaceInvitationRequestSchema
>;
/** Request that accepts one pending Workspace invitation. */
export type AcceptWorkspaceInvitationRequest = z.infer<
  typeof AcceptWorkspaceInvitationRequestSchema
>;
/** Request that declines one pending Workspace invitation. */
export type DeclineWorkspaceInvitationRequest = z.infer<
  typeof DeclineWorkspaceInvitationRequestSchema
>;
/** Request that revokes one pending Workspace invitation. */
export type RevokeWorkspaceInvitationRequest = z.infer<
  typeof RevokeWorkspaceInvitationRequestSchema
>;
/** Request that changes one active member's Workspace access level. */
export type ChangeWorkspaceMemberAccessRequest = z.infer<
  typeof ChangeWorkspaceMemberAccessRequestSchema
>;
/** Request that removes one non-owner Workspace member. */
export type RemoveWorkspaceMemberRequest = z.infer<typeof RemoveWorkspaceMemberRequestSchema>;
/** Request that removes the current caller's non-owner Workspace membership. */
export type LeaveWorkspaceRequest = z.infer<typeof LeaveWorkspaceRequestSchema>;
/** Request that transfers Workspace ownership to one active editor. */
export type TransferWorkspaceOwnershipRequest = z.infer<
  typeof TransferWorkspaceOwnershipRequestSchema
>;
/** Administrator-only bounded request for restoring the caller's Workspace access. */
export type RecoverWorkspaceAccessRequest = z.infer<typeof RecoverWorkspaceAccessRequestSchema>;
/** Request that disables one exact canonical user. */
export type DisableUserRequest = z.infer<typeof DisableUserRequestSchema>;
/** Response listing every Workspace authorized for the current caller. */
export type ListAuthorizedWorkspacesResponse = z.infer<
  typeof ListAuthorizedWorkspacesResponseSchema
>;
/** Response listing Workspace memberships visible to the current caller. */
export type ListWorkspaceMembersResponse = z.infer<typeof ListWorkspaceMembersResponseSchema>;
/** Response listing Workspace invitations visible to the current caller. */
export type ListWorkspaceInvitationsResponse = z.infer<
  typeof ListWorkspaceInvitationsResponseSchema
>;
/** Response returned after one invitation mutation. */
export type WorkspaceInvitationMutationResponse = z.infer<
  typeof WorkspaceInvitationMutationResponseSchema
>;
/** Response returned after one membership mutation. */
export type WorkspaceMemberMutationResponse = z.infer<typeof WorkspaceMemberMutationResponseSchema>;
/** Response returned after ownership transfer. */
export type WorkspaceOwnershipMutationResponse = z.infer<
  typeof WorkspaceOwnershipMutationResponseSchema
>;
/** Response returned by Workspace access recovery reads and mutations. */
export type WorkspaceAccessRecoveryResponse = z.infer<typeof WorkspaceAccessRecoveryResponseSchema>;
/** Response returned after one canonical user is disabled. */
export type DisableUserResponse = z.infer<typeof DisableUserResponseSchema>;
/** Safe current record returned by one Workspace sharing revision conflict. */
export type WorkspaceRevisionConflictDetails = z.infer<
  typeof WorkspaceRevisionConflictDetailsSchema
>;
/** Closed typed error family for Workspace sharing operations. */
export type WorkspaceSharingError = z.infer<typeof WorkspaceSharingErrorSchema>;
