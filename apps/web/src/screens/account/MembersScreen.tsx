import { type FormEvent, useState } from 'react';
import {
  Button,
  Dialog,
  ErrorBanner,
  Modal,
  Select,
  StatusChip,
  TextField,
} from '../../primitives';
import {
  type AccountWorkspaceInvitation,
  type AccountWorkspaceMember,
  useWorkspaceOwnerManagement,
} from './data';

/** Access levels offered by both owner-managed account controls. */
const accessLevelOptions = [
  { id: 'editor', label: 'Editor' },
  { id: 'viewer', label: 'Viewer' },
];

/** Compact collection placeholder labelled for its independently loading owner read. */
function CollectionLoading({ label }: { label: string }) {
  return (
    <div
      role="status"
      aria-label={`${label} loading`}
      aria-live="polite"
      className="flex flex-col gap-2 py-3"
    >
      <span className="h-3 w-full rounded bg-skeleton" />
      <span className="h-3 w-3/4 rounded bg-skeleton" />
      <span className="h-3 w-1/2 rounded bg-skeleton" />
    </div>
  );
}

/** Confirmation surface for one destructive owner command. */
function ConfirmAction({
  label,
  message,
  pending,
  onConfirm,
}: {
  label: string;
  message: string;
  pending: boolean;
  onConfirm: () => void;
}) {
  return (
    <Modal
      trigger={
        <Button aria-label={label} variant="negative-outline" size="sm">
          {label === 'Transfer ownership' ? 'Transfer' : label}
        </Button>
      }
    >
      <Dialog title={`Confirm ${label.toLowerCase()}`}>
        <p>{message}</p>
        <div className="flex justify-end gap-2">
          <Button slot="close" variant="quiet">
            Cancel
          </Button>
          <Button slot="close" variant="negative" isDisabled={pending} onPress={onConfirm}>
            Confirm
          </Button>
        </div>
      </Dialog>
    </Modal>
  );
}

/** Selected-Workspace owner projection for members and issued invitations. */
export function MembersScreen() {
  const owner = useWorkspaceOwnerManagement();
  const [inviteeEmail, setInviteeEmail] = useState('');
  const [inviteAccess, setInviteAccess] = useState<'editor' | 'viewer'>('editor');
  const [accessDrafts, setAccessDrafts] = useState<Record<string, 'editor' | 'viewer'>>({});
  const workspaceId = owner.selectedWorkspaceId;
  const workspace = owner.effectiveWorkspace;

  /** Submits one exact live email and scrubs the field after either settlement. */
  function createInvitation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!workspaceId) return;
    owner.createInvitation.mutate(
      { inviteeEmail, proposedAccessLevel: inviteAccess, workspaceId },
      { onSettled: () => setInviteeEmail('') }
    );
  }

  const transferSuccess = owner.transferOwnership.data?.workspace;
  const transferConflict =
    owner.transferOwnership.error?.resource === 'workspace'
      ? owner.transferOwnership.error.current
      : undefined;

  return (
    <div className="flex flex-col gap-4">
      <section
        className="rounded-ok border border-border bg-card p-4"
        aria-label="Current Workspace role"
      >
        {workspace ? (
          <>
            <p className="text-sm font-bold text-fg-strong">{workspace.workspace.name}</p>
            <p className="mt-1 text-sm text-fg-muted">
              Current Workspace role: {workspace.effectiveRole}
            </p>
          </>
        ) : (
          <p className="text-sm text-fg-muted">No Workspace selected.</p>
        )}
      </section>

      {transferSuccess ? (
        <p
          role="status"
          aria-label="Workspace ownership transfer"
          className="text-sm text-positive-fg"
        >
          Ownership transferred to {transferSuccess.ownerUserId}. Owner role uses editor access.
        </p>
      ) : null}
      {transferConflict && 'ownerUserId' in transferConflict ? (
        <p role="status" aria-label="Workspace sharing conflict" className="text-sm text-notice-fg">
          Current owner: {transferConflict.ownerUserId}. Owner role uses editor access.
        </p>
      ) : null}
      {owner.transferOwnership.isError ? (
        <ErrorBanner message={owner.transferOwnership.error.message} />
      ) : null}

      {owner.isOwner && workspaceId && workspace ? (
        <>
          <section
            aria-label="Workspace members"
            className="rounded-ok border border-border bg-card p-4"
          >
            <div className="mb-3">
              <h2 className="text-lg font-extrabold text-fg-strong">Workspace members</h2>
              <p className="mt-1 text-xs text-fg-muted">Current owner: {workspace.ownerUserId}</p>
            </div>
            {owner.members.isPending ? <CollectionLoading label="Workspace members" /> : null}
            {owner.members.isError ? (
              <ErrorBanner
                message="Couldn't load Workspace members."
                onRetry={() => void owner.members.refetch()}
              />
            ) : null}
            {owner.changeMemberAccess.isError ? (
              <ErrorBanner message={owner.changeMemberAccess.error.message} />
            ) : null}
            {owner.removeMember.isError ? (
              <ErrorBanner message={owner.removeMember.error.message} />
            ) : null}
            {owner.members.isSuccess ? (
              owner.members.data.items.length > 0 ? (
                <table
                  aria-label="Workspace member records"
                  className="w-full divide-y divide-separator"
                >
                  <tbody>
                    {owner.members.data.items.map((member: AccountWorkspaceMember) => {
                      const activeNonOwner =
                        member.status === 'active' &&
                        (member.effectiveRole === 'editor' || member.effectiveRole === 'viewer');
                      const draft = accessDrafts[member.userId] ?? member.accessLevel;
                      return (
                        <tr key={member.userId} className="align-top">
                          <td className="min-w-0 py-3 pr-3">
                            <p className="text-sm font-bold text-fg-strong">{member.userId}</p>
                            <div className="mt-1 flex items-center gap-2">
                              <StatusChip
                                tone={member.status === 'removed' ? 'neutral' : 'informative'}
                              >
                                {member.status === 'removed' ? (
                                  'removed'
                                ) : (
                                  <span role="status" aria-label={member.effectiveRole}>
                                    {member.effectiveRole === 'editor'
                                      ? 'Can edit'
                                      : member.effectiveRole === 'viewer'
                                        ? 'Read only'
                                        : member.effectiveRole}
                                  </span>
                                )}
                              </StatusChip>
                              {member.status === 'active' ? (
                                <span className="text-xs text-fg-muted">
                                  Stored access: {member.accessLevel === 'editor' ? 'edit' : 'view'}
                                </span>
                              ) : null}
                            </div>
                          </td>
                          {activeNonOwner ? (
                            <td className="py-3">
                              <div className="flex flex-wrap items-end justify-end gap-2">
                                <Select
                                  label="Access level"
                                  items={accessLevelOptions}
                                  selectedKey={draft}
                                  isDisabled={owner.changeMemberAccess.isPending}
                                  onSelectionChange={(key) =>
                                    setAccessDrafts((current) => ({
                                      ...current,
                                      [member.userId]: key === 'viewer' ? 'viewer' : 'editor',
                                    }))
                                  }
                                />
                                <Button
                                  size="sm"
                                  variant="outline"
                                  isDisabled={
                                    owner.changeMemberAccess.isPending ||
                                    draft === member.accessLevel
                                  }
                                  onPress={() =>
                                    owner.changeMemberAccess.mutate({
                                      accessLevel: draft,
                                      expectedRevision: member.revision,
                                      userId: member.userId,
                                      workspaceId,
                                    })
                                  }
                                >
                                  Save access
                                </Button>
                                <ConfirmAction
                                  label="Remove member"
                                  message={`Remove ${member.userId} from this Workspace?`}
                                  pending={owner.removeMember.isPending}
                                  onConfirm={() =>
                                    owner.removeMember.mutate({
                                      expectedRevision: member.revision,
                                      userId: member.userId,
                                      workspaceId,
                                    })
                                  }
                                />
                                <ConfirmAction
                                  label="Transfer ownership"
                                  message={`Transfer Workspace ownership to ${member.userId}?`}
                                  pending={owner.transferOwnership.isPending}
                                  onConfirm={() =>
                                    owner.transferOwnership.mutate({
                                      expectedRegistryRevision: workspace.registryRevision,
                                      targetUserId: member.userId,
                                      workspaceId,
                                    })
                                  }
                                />
                              </div>
                            </td>
                          ) : null}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              ) : (
                <p className="py-3 text-sm text-fg-muted">No members.</p>
              )
            ) : null}
          </section>

          <section
            aria-label="Workspace invitations"
            className="rounded-ok border border-border bg-card p-4"
          >
            <h2 className="text-lg font-extrabold text-fg-strong">Workspace invitations</h2>
            <form
              className="mt-3 flex flex-wrap items-end gap-2"
              aria-label="Create Workspace invitation"
              onSubmit={createInvitation}
            >
              <TextField
                label="Invitee email"
                type="email"
                value={inviteeEmail}
                onChange={setInviteeEmail}
                isDisabled={owner.createInvitation.isPending}
                isRequired
              />
              <Select
                label="Access level"
                items={accessLevelOptions}
                selectedKey={inviteAccess}
                isDisabled={owner.createInvitation.isPending}
                onSelectionChange={(key) => setInviteAccess(key === 'viewer' ? 'viewer' : 'editor')}
              />
              <Button type="submit" isDisabled={owner.createInvitation.isPending || !inviteeEmail}>
                Create invitation
              </Button>
            </form>
            {owner.createInvitation.isPending ? (
              <p role="status" aria-live="polite" className="mt-3 text-sm text-fg-muted">
                Creating invitation…
              </p>
            ) : null}
            {owner.createInvitation.isError ? (
              <div className="mt-3">
                <ErrorBanner message={owner.createInvitation.error.message} />
              </div>
            ) : null}
            {owner.revokeInvitation.isError ? (
              <div className="mt-3">
                <ErrorBanner message={owner.revokeInvitation.error.message} />
              </div>
            ) : null}
            {owner.invitations.isPending ? (
              <CollectionLoading label="Workspace invitations" />
            ) : null}
            {owner.invitations.isError ? (
              <ErrorBanner
                message="Couldn't load Workspace invitations."
                onRetry={() => void owner.invitations.refetch()}
              />
            ) : null}
            {owner.invitations.isSuccess ? (
              owner.invitations.data.items.length > 0 ? (
                <table
                  aria-label="Workspace invitation records"
                  className="mt-3 w-full divide-y divide-separator"
                >
                  <tbody>
                    {owner.invitations.data.items.map((invitation: AccountWorkspaceInvitation) => (
                      <tr key={invitation.invitationId}>
                        <td className="min-w-0 py-3 pr-3">
                          <p className="text-sm font-bold text-fg-strong">
                            {invitation.inviteeUserId}
                          </p>
                          <div className="mt-1 flex items-center gap-2">
                            <StatusChip
                              tone={invitation.effectiveStatus === 'pending' ? 'notice' : 'neutral'}
                            >
                              {invitation.effectiveStatus}
                            </StatusChip>
                            <span className="text-xs text-fg-muted">
                              {invitation.proposedAccessLevel}
                            </span>
                          </div>
                        </td>
                        {invitation.effectiveStatus === 'pending' ? (
                          <td className="py-3 text-right">
                            <ConfirmAction
                              label="Revoke invitation"
                              message={`Revoke the invitation for ${invitation.inviteeUserId}?`}
                              pending={owner.revokeInvitation.isPending}
                              onConfirm={() =>
                                owner.revokeInvitation.mutate({
                                  expectedRevision: invitation.revision,
                                  invitationId: invitation.invitationId,
                                  workspaceId,
                                })
                              }
                            />
                          </td>
                        ) : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="py-3 text-sm text-fg-muted">No invitations.</p>
              )
            ) : null}
          </section>
        </>
      ) : null}
    </div>
  );
}
