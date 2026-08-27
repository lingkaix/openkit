import { ApiCallError, type CoreClient, parseWorkspaceSharingError } from '@openkit/core-client';
import { useIsFetching, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCoreClient } from '../../app/core-client';
import { useCurrentWorkspaceId } from '../chat/data';
import { useWorkspaceStore } from '../workspace-store';
import { accountAdmissionKey, myInvitationDecisionMutationKey, myInvitationsKey } from './session';

/** One authorized Workspace summary returned by the protected account read. */
export type AccountWorkspaceSummary = Awaited<
  ReturnType<CoreClient['app']['listAuthorizedWorkspaces']>
>['items'][number];

/** One owner-visible Workspace member. */
export type AccountWorkspaceMember = Awaited<
  ReturnType<CoreClient['app']['listWorkspaceMembers']>
>['items'][number];

/** One owner-visible Workspace invitation. */
export type AccountWorkspaceInvitation = Awaited<
  ReturnType<CoreClient['app']['listWorkspaceInvitations']>
>['items'][number];

/** Authoritative invitation mutation response. */
type InvitationMutationResponse = Awaited<
  ReturnType<CoreClient['app']['createWorkspaceInvitation']>
>;

/** Authoritative member mutation response. */
type MemberMutationResponse = Awaited<ReturnType<CoreClient['app']['changeWorkspaceMemberAccess']>>;

/** Authoritative ownership-transfer response. */
type OwnershipMutationResponse = Awaited<
  ReturnType<CoreClient['app']['transferWorkspaceOwnership']>
>;

/** Authoritative current-user invitation collection. */
type MyInvitationCollection = Awaited<ReturnType<CoreClient['app']['listMyWorkspaceInvitations']>>;

/** Authoritative current-user invitation decision response. */
type MyInvitationMutationResponse = Awaited<
  ReturnType<CoreClient['app']['acceptWorkspaceInvitation']>
>;

/** Authoritative current-user membership leave response. */
type LeaveWorkspaceMutationResponse = Awaited<ReturnType<CoreClient['app']['leaveWorkspace']>>;

/** Safe client projection of one failed sharing operation. */
export interface WorkspaceSharingFailure {
  /** Stable failure code used for bounded presentation. */
  code: string;
  /** Safe plain-language message containing no transient input. */
  message: string;
  /** Safe current record returned by the server when available. */
  current?: AccountWorkspaceSummary | AccountWorkspaceMember | AccountWorkspaceInvitation;
  /** Current record family for a compare-and-swap conflict. */
  resource?: 'workspace' | 'membership' | 'invitation' | 'workspace_recovery';
}

/** Mutable live invitation input whose email is scrubbed before settlement. */
export interface CreateInvitationVariables {
  /** Exact selected Workspace identity. */
  workspaceId: string;
  /** Exact live email input; cleared in place before TanStack retains settlement. */
  inviteeEmail: string;
  /** Fixed V1 invitation access level. */
  proposedAccessLevel: 'editor' | 'viewer';
}

/** Exact current member access-change command. */
export interface ChangeMemberAccessVariables {
  workspaceId: string;
  userId: string;
  accessLevel: 'editor' | 'viewer';
  expectedRevision: number;
}

/** Exact current member removal command. */
export interface RemoveMemberVariables {
  workspaceId: string;
  userId: string;
  expectedRevision: number;
}

/** Exact current invitation revocation command. */
export interface RevokeInvitationVariables {
  workspaceId: string;
  invitationId: string;
  expectedRevision: number;
}

/** Exact current Workspace ownership-transfer command. */
export interface TransferOwnershipVariables {
  workspaceId: string;
  targetUserId: string;
  expectedRegistryRevision: number;
}

/** One pending current-user invitation decision. */
export interface MyInvitationDecisionVariables {
  /** Exact invitation identity. */
  invitationId: string;
  /** Exact current invitation revision. */
  expectedRevision: number;
  /** Existing decision operation selected by the user. */
  operation: 'accept' | 'decline';
}

/** One confirmed leave of the selected active non-owner membership. */
export interface LeaveWorkspaceVariables {
  /** Exact selected Workspace identity. */
  workspaceId: string;
  /** Exact current membership revision. */
  expectedRevision: number;
}

/** Owner-management collection keys, scoped to one exact Workspace. */
export const ownerManagementKeys = {
  members: (workspaceId: string) => ['account', 'workspace-members', workspaceId] as const,
  invitations: (workspaceId: string) => ['account', 'workspace-invitations', workspaceId] as const,
};

/** Converts one request failure through the closed sharing parser into safe UI state. */
function safeSharingFailure(error: unknown): WorkspaceSharingFailure {
  const parsed = parseWorkspaceSharingError(error);
  if (parsed) {
    if (parsed.code === 'invitation_not_pending') {
      return {
        code: parsed.code,
        current: parsed.details.current,
        message: 'Invitation is not pending.',
        resource: 'invitation',
      };
    }
    if (parsed.code === 'revision_conflict') {
      return {
        code: parsed.code,
        current: parsed.details.current as WorkspaceSharingFailure['current'],
        message: 'Workspace sharing conflict. The record changed.',
        resource: parsed.details.resource,
      };
    }
    return {
      code: parsed.code,
      message:
        parsed.code === 'workspace_access_denied'
          ? 'Workspace access denied.'
          : parsed.code === 'invitee_unavailable'
            ? "Couldn't create invitation. Invitee unavailable."
            : parsed.code === 'owner_transfer_required'
              ? 'Transfer ownership before leaving this Workspace.'
              : 'Workspace sharing operation failed.',
    };
  }
  if (error instanceof ApiCallError && error.code === 'idempotency_key_conflict') {
    return { code: error.code, message: 'Request conflict.' };
  }
  if (error instanceof ApiCallError && error.code === 'recovery_required') {
    return { code: error.code, message: 'Recovery required.' };
  }
  return { code: 'unknown', message: 'Workspace sharing operation failed.' };
}

/** Replaces one exact invitation row while preserving collection order and siblings. */
function replaceInvitation(
  current: MyInvitationCollection | undefined,
  invitation: AccountWorkspaceInvitation
): MyInvitationCollection | undefined {
  return current
    ? {
        items: current.items.map((item) =>
          item.invitationId === invitation.invitationId ? invitation : item
        ),
      }
    : current;
}

/** Resolves the exact selected authorized Workspace without scanning another collection. */
function useSelectedAccountWorkspace() {
  const queryClient = useQueryClient();
  const sharedWorkspaceId = useCurrentWorkspaceId();
  const persistedWorkspaceId = useWorkspaceStore((state) => state.currentWorkspaceId);
  const admission =
    queryClient.getQueryData<Awaited<ReturnType<CoreClient['app']['listAuthorizedWorkspaces']>>>(
      accountAdmissionKey
    );
  const selectedWorkspaceId =
    admission?.items.find((item) => item.workspace.id === persistedWorkspaceId)?.workspace.id ??
    sharedWorkspaceId;

  return {
    selectedWorkspace:
      admission?.items.find((item) => item.workspace.id === selectedWorkspaceId) ?? null,
    selectedWorkspaceId,
  };
}

/** Owns the selected-Workspace owner reads and five exact owner mutations. */
export function useWorkspaceOwnerManagement() {
  const client = useCoreClient();
  const queryClient = useQueryClient();
  const { selectedWorkspace, selectedWorkspaceId } = useSelectedAccountWorkspace();

  const createInvitation = useMutation<
    InvitationMutationResponse,
    WorkspaceSharingFailure,
    CreateInvitationVariables
  >({
    retry: false,
    mutationFn: async (variables: CreateInvitationVariables) => {
      try {
        return await client.app.createWorkspaceInvitation(variables.workspaceId, {
          inviteeEmail: variables.inviteeEmail,
          proposedAccessLevel: variables.proposedAccessLevel,
        });
      } catch (error) {
        throw safeSharingFailure(error);
      } finally {
        variables.inviteeEmail = '';
      }
    },
    onSuccess: ({ invitation }, variables) => {
      queryClient.setQueryData<Awaited<ReturnType<CoreClient['app']['listWorkspaceInvitations']>>>(
        ownerManagementKeys.invitations(variables.workspaceId),
        (current) => ({
          items: current
            ? current.items.some((item) => item.invitationId === invitation.invitationId)
              ? current.items.map((item) =>
                  item.invitationId === invitation.invitationId ? invitation : item
                )
              : [invitation, ...current.items]
            : [invitation],
        })
      );
    },
  });

  const revokeInvitation = useMutation<
    InvitationMutationResponse,
    WorkspaceSharingFailure,
    RevokeInvitationVariables
  >({
    retry: false,
    mutationFn: async (variables: RevokeInvitationVariables) => {
      try {
        return await client.app.revokeWorkspaceInvitation(
          variables.workspaceId,
          variables.invitationId,
          { expectedRevision: variables.expectedRevision }
        );
      } catch (error) {
        throw safeSharingFailure(error);
      }
    },
    onSuccess: ({ invitation }, variables) => {
      queryClient.setQueryData<Awaited<ReturnType<CoreClient['app']['listWorkspaceInvitations']>>>(
        ownerManagementKeys.invitations(variables.workspaceId),
        (current) =>
          current
            ? {
                items: current.items.map((item) =>
                  item.invitationId === invitation.invitationId ? invitation : item
                ),
              }
            : current
      );
    },
    onError: (error, variables) => {
      if (error.resource !== 'invitation' || !error.current) return;
      const invitation = error.current as AccountWorkspaceInvitation;
      queryClient.setQueryData<Awaited<ReturnType<CoreClient['app']['listWorkspaceInvitations']>>>(
        ownerManagementKeys.invitations(variables.workspaceId),
        (current) =>
          current
            ? {
                items: current.items.map((item) =>
                  item.invitationId === invitation.invitationId ? invitation : item
                ),
              }
            : current
      );
    },
  });

  const changeMemberAccess = useMutation<
    MemberMutationResponse,
    WorkspaceSharingFailure,
    ChangeMemberAccessVariables
  >({
    retry: false,
    mutationFn: async (variables: ChangeMemberAccessVariables) => {
      try {
        return await client.app.changeWorkspaceMemberAccess(
          variables.workspaceId,
          variables.userId,
          {
            accessLevel: variables.accessLevel,
            expectedRevision: variables.expectedRevision,
          }
        );
      } catch (error) {
        throw safeSharingFailure(error);
      }
    },
    onSuccess: ({ member }, variables) => {
      queryClient.setQueryData<Awaited<ReturnType<CoreClient['app']['listWorkspaceMembers']>>>(
        ownerManagementKeys.members(variables.workspaceId),
        (current) =>
          current
            ? {
                items: current.items.map((item) => (item.userId === member.userId ? member : item)),
              }
            : current
      );
    },
    onError: (error, variables) => {
      if (error.resource !== 'membership' || !error.current) return;
      const member = error.current as AccountWorkspaceMember;
      queryClient.setQueryData<Awaited<ReturnType<CoreClient['app']['listWorkspaceMembers']>>>(
        ownerManagementKeys.members(variables.workspaceId),
        (current) =>
          current
            ? {
                items: current.items.map((item) => (item.userId === member.userId ? member : item)),
              }
            : current
      );
    },
  });

  const removeMember = useMutation<
    MemberMutationResponse,
    WorkspaceSharingFailure,
    RemoveMemberVariables
  >({
    retry: false,
    mutationFn: async (variables: RemoveMemberVariables) => {
      try {
        return await client.app.removeWorkspaceMember(variables.workspaceId, variables.userId, {
          expectedRevision: variables.expectedRevision,
        });
      } catch (error) {
        throw safeSharingFailure(error);
      }
    },
    onSuccess: ({ member }, variables) => {
      queryClient.setQueryData<Awaited<ReturnType<CoreClient['app']['listWorkspaceMembers']>>>(
        ownerManagementKeys.members(variables.workspaceId),
        (current) =>
          current
            ? {
                items: current.items.map((item) => (item.userId === member.userId ? member : item)),
              }
            : current
      );
    },
    onError: (error, variables) => {
      if (error.resource !== 'membership' || !error.current) return;
      const member = error.current as AccountWorkspaceMember;
      queryClient.setQueryData<Awaited<ReturnType<CoreClient['app']['listWorkspaceMembers']>>>(
        ownerManagementKeys.members(variables.workspaceId),
        (current) =>
          current
            ? {
                items: current.items.map((item) => (item.userId === member.userId ? member : item)),
              }
            : current
      );
    },
  });

  const transferOwnership = useMutation<
    OwnershipMutationResponse,
    WorkspaceSharingFailure,
    TransferOwnershipVariables
  >({
    retry: false,
    mutationFn: async (variables: TransferOwnershipVariables) => {
      try {
        return await client.app.transferWorkspaceOwnership(variables.workspaceId, {
          expectedRegistryRevision: variables.expectedRegistryRevision,
          targetUserId: variables.targetUserId,
        });
      } catch (error) {
        throw safeSharingFailure(error);
      }
    },
    onSuccess: ({ workspace }) => {
      queryClient.setQueryData<Awaited<ReturnType<CoreClient['app']['listAuthorizedWorkspaces']>>>(
        accountAdmissionKey,
        (current) =>
          current
            ? {
                items: current.items.map((item) =>
                  item.workspace.id === workspace.workspace.id ? workspace : item
                ),
              }
            : current
      );
    },
    onError: (error) => {
      if (error.resource !== 'workspace' || !error.current) return;
      const workspace = error.current as AccountWorkspaceSummary;
      queryClient.setQueryData<Awaited<ReturnType<CoreClient['app']['listAuthorizedWorkspaces']>>>(
        accountAdmissionKey,
        (current) =>
          current
            ? {
                items: current.items.map((item) =>
                  item.workspace.id === workspace.workspace.id ? workspace : item
                ),
              }
            : current
      );
    },
  });

  const transferCurrent =
    transferOwnership.data?.workspace ??
    (transferOwnership.error?.resource === 'workspace'
      ? (transferOwnership.error.current as AccountWorkspaceSummary | undefined)
      : undefined);
  const effectiveWorkspace =
    transferCurrent?.workspace.id === selectedWorkspaceId ? transferCurrent : selectedWorkspace;
  const isOwner = effectiveWorkspace?.effectiveRole === 'owner';
  const members = useQuery({
    queryKey: ownerManagementKeys.members(selectedWorkspaceId ?? ''),
    queryFn: () => client.app.listWorkspaceMembers(selectedWorkspaceId as string),
    enabled: Boolean(selectedWorkspaceId) && isOwner,
    retry: false,
    structuralSharing: false,
  });
  const invitations = useQuery({
    queryKey: ownerManagementKeys.invitations(selectedWorkspaceId ?? ''),
    queryFn: () => client.app.listWorkspaceInvitations(selectedWorkspaceId as string),
    enabled: Boolean(selectedWorkspaceId) && isOwner,
    retry: false,
    structuralSharing: false,
  });

  return {
    changeMemberAccess,
    createInvitation,
    effectiveWorkspace,
    invitations,
    isOwner,
    members,
    removeMember,
    revokeInvitation,
    selectedWorkspaceId,
    transferOwnership,
  };
}

/** Owns the account-level current-user invitation read and exact pending-row decisions. */
export function useMyWorkspaceInvitations() {
  const client = useCoreClient();
  const queryClient = useQueryClient();
  const admissionIsFetching = useIsFetching({ queryKey: accountAdmissionKey, exact: true }) > 0;
  const invitations = useQuery<MyInvitationCollection, WorkspaceSharingFailure>({
    queryKey: myInvitationsKey,
    queryFn: async () => {
      try {
        return await client.app.listMyWorkspaceInvitations();
      } catch (error) {
        throw safeSharingFailure(error);
      }
    },
    enabled: !admissionIsFetching,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
    structuralSharing: false,
  });
  const decision = useMutation<
    MyInvitationMutationResponse,
    WorkspaceSharingFailure,
    MyInvitationDecisionVariables
  >({
    mutationKey: myInvitationDecisionMutationKey,
    retry: false,
    mutationFn: async (variables) => {
      try {
        const input = { expectedRevision: variables.expectedRevision };
        return variables.operation === 'accept'
          ? await client.app.acceptWorkspaceInvitation(variables.invitationId, input)
          : await client.app.declineWorkspaceInvitation(variables.invitationId, input);
      } catch (error) {
        throw safeSharingFailure(error);
      }
    },
    onSuccess: ({ invitation }) => {
      queryClient.setQueryData<MyInvitationCollection>(myInvitationsKey, (current) =>
        replaceInvitation(current, invitation)
      );
    },
    onError: (error) => {
      if (error.resource === 'invitation' && error.current) {
        queryClient.setQueryData<MyInvitationCollection>(myInvitationsKey, (current) =>
          replaceInvitation(current, error.current as AccountWorkspaceInvitation)
        );
        return;
      }
      if (
        error.code === 'workspace_access_denied' ||
        error.code === 'idempotency_key_conflict' ||
        error.code === 'recovery_required'
      ) {
        void queryClient.refetchQueries({ exact: true, queryKey: myInvitationsKey });
      }
    },
  });

  return { decision, invitations };
}

/** Owns confirmed self-leave for the exact selected active non-owner membership. */
export function useSelfLeave() {
  const client = useCoreClient();
  const queryClient = useQueryClient();
  const { selectedWorkspace, selectedWorkspaceId } = useSelectedAccountWorkspace();

  /** Settles one exact membership projection into the protected authorized-Workspace cache. */
  function settleMembership(member: AccountWorkspaceMember) {
    queryClient.setQueryData<Awaited<ReturnType<CoreClient['app']['listAuthorizedWorkspaces']>>>(
      accountAdmissionKey,
      (current) =>
        current
          ? {
              items:
                member.status === 'removed' || member.effectiveRole === null
                  ? current.items.filter((item) => item.workspace.id !== member.workspaceId)
                  : current.items.map((item) =>
                      item.workspace.id === member.workspaceId
                        ? {
                            ...item,
                            effectiveRole: member.effectiveRole,
                            membershipRevision: member.revision,
                          }
                        : item
                    ),
            }
          : current
    );
  }

  const leave = useMutation<
    LeaveWorkspaceMutationResponse,
    WorkspaceSharingFailure,
    LeaveWorkspaceVariables
  >({
    retry: false,
    mutationFn: async (variables) => {
      try {
        return await client.app.leaveWorkspace(variables.workspaceId, {
          expectedRevision: variables.expectedRevision,
        });
      } catch (error) {
        throw safeSharingFailure(error);
      }
    },
    onSuccess: ({ member }) => settleMembership(member),
    onError: (error) => {
      if (error.resource === 'membership' && error.current) {
        settleMembership(error.current as AccountWorkspaceMember);
      }
    },
  });

  const canLeave =
    selectedWorkspace?.effectiveRole === 'editor' || selectedWorkspace?.effectiveRole === 'viewer';

  return { canLeave, leave, selectedWorkspace, selectedWorkspaceId };
}
