import { type FormEvent, useState } from 'react';
import { Button, Card, Dialog, ErrorBanner, Modal, StatusChip, TextField } from '../../primitives';
import {
  type AccountWorkspaceInvitation,
  type AccountWorkspaceMember,
  useSelfLeave,
  useWorkspaceMemberManagement,
} from './data';

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

/** Confirmation surface for leaving one selected active non-owner membership. */
function LeaveConfirmation({
  errorMessage,
  pending,
  workspaceName,
  onConfirm,
}: {
  errorMessage?: string;
  pending: boolean;
  workspaceName: string;
  onConfirm: () => void;
}) {
  return (
    <Modal
      trigger={
        <Button variant="negative-outline" size="sm">
          Leave Workspace
        </Button>
      }
    >
      <Dialog title="Confirm leave Workspace">
        <p>Leave {workspaceName}? You will lose access to this Workspace.</p>
        {errorMessage ? <ErrorBanner message={errorMessage} /> : null}
        <div className="flex justify-end gap-2">
          <Button slot="close" variant="quiet">
            Cancel
          </Button>
          <Button variant="negative" isDisabled={pending} onPress={onConfirm}>
            Confirm leave
          </Button>
        </div>
      </Dialog>
    </Modal>
  );
}

/** Confirmation surface for one destructive member command. */
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

/** Selected-Workspace member management and ownership projection. */
export function MembersScreen() {
  const management = useWorkspaceMemberManagement();
  const selfLeave = useSelfLeave();
  const [inviteeEmail, setInviteeEmail] = useState('');
  const workspaceId = management.selectedWorkspaceId;
  const workspace = management.effectiveWorkspace;
  const selectedWorkspace = selfLeave.selectedWorkspace;
  const membershipRevision = selectedWorkspace?.membershipRevision ?? null;

  /** Submits one exact live email and scrubs the field after either settlement. */
  function createInvitation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!workspaceId) return;
    management.createInvitation.mutate(
      { inviteeEmail, workspaceId },
      { onSettled: () => setInviteeEmail('') }
    );
  }

  const transferSuccess = management.transferOwnership.data?.workspace;
  const transferConflict =
    management.transferOwnership.error?.resource === 'workspace'
      ? management.transferOwnership.error.current
      : undefined;

  return (
    <div className="flex flex-col gap-6">
      <section aria-label="Current Workspace access">
        <Card className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          {workspace ? (
            <>
              <div className="min-w-0">
                <p className="text-sm font-bold text-fg-strong">{workspace.workspace.name}</p>
                <p className="mt-1 text-xs text-fg-muted">{workspace.workspace.id}</p>
                <p className="mt-2 text-sm text-fg-muted">
                  Workspace access:{' '}
                  {workspace.membershipStatus === 'active' ? 'Active member' : 'Administrator'}
                  {workspace.isOwner ? ' · Owner' : ''}
                </p>
              </div>
              {selfLeave.canLeave &&
              selectedWorkspace &&
              membershipRevision !== null &&
              selfLeave.selectedWorkspaceId ? (
                <LeaveConfirmation
                  key={selectedWorkspace.workspace.id}
                  errorMessage={selfLeave.leave.error?.message}
                  pending={selfLeave.leave.isPending}
                  workspaceName={selectedWorkspace.workspace.name}
                  onConfirm={() =>
                    selfLeave.leave.mutate({
                      expectedRevision: membershipRevision,
                      workspaceId: selectedWorkspace.workspace.id,
                    })
                  }
                />
              ) : null}
            </>
          ) : (
            <p className="text-sm text-fg-muted">No Workspace selected.</p>
          )}
        </Card>
      </section>
      {selfLeave.leave.isError ? <ErrorBanner message={selfLeave.leave.error.message} /> : null}

      {transferSuccess ? (
        <p
          role="status"
          aria-label="Workspace ownership transfer"
          className="text-sm text-positive-fg"
        >
          Ownership transferred to {transferSuccess.ownerUserId}. All active members have full
          Workspace eligibility.
        </p>
      ) : null}
      {transferConflict && 'ownerUserId' in transferConflict ? (
        <p role="status" aria-label="Workspace sharing conflict" className="text-sm text-notice-fg">
          Current owner: {transferConflict.ownerUserId}. All active members have full Workspace
          eligibility.
        </p>
      ) : null}
      {management.transferOwnership.isError ? (
        <ErrorBanner message={management.transferOwnership.error.message} />
      ) : null}

      {management.canManage && workspaceId && workspace ? (
        <>
          <section aria-label="Workspace members">
            <Card className="flex flex-col gap-3">
              <div>
                <h2 className="text-lg font-extrabold text-fg-strong">Workspace members</h2>
                <p className="mt-1 text-xs text-fg-muted">Current owner: {workspace.ownerUserId}</p>
              </div>
              {management.members.isPending ? (
                <CollectionLoading label="Workspace members" />
              ) : null}
              {management.members.isError ? (
                <ErrorBanner
                  message="Couldn't load Workspace members."
                  onRetry={() => void management.members.refetch()}
                />
              ) : null}
              {management.removeMember.isError ? (
                <ErrorBanner message={management.removeMember.error.message} />
              ) : null}
              {management.members.isSuccess ? (
                management.members.data.items.length > 0 ? (
                  <table
                    aria-label="Workspace member records"
                    className="w-full divide-y divide-separator"
                  >
                    <tbody>
                      {management.members.data.items.map((member: AccountWorkspaceMember) => {
                        // Transfer returns the current registry owner without changing membership revisions.
                        const isOwner = member.userId === workspace.ownerUserId;
                        const activeNonOwner = member.status === 'active' && !isOwner;
                        return (
                          <tr key={JSON.stringify([workspaceId, member.userId])} className="align-top">
                            <td className="min-w-0 py-3 pr-3">
                              <p className="text-sm font-bold text-fg-strong">{member.userId}</p>
                              <div className="mt-1 flex items-center gap-2">
                                <StatusChip
                                  tone={member.status === 'removed' ? 'neutral' : 'informative'}
                                >
                                  {member.status === 'removed' ? (
                                    'removed'
                                  ) : (
                                    <span role="status" aria-label={isOwner ? 'owner' : 'member'}>
                                      {isOwner ? 'Owner' : 'Active member'}
                                    </span>
                                  )}
                                </StatusChip>
                              </div>
                            </td>
                            {activeNonOwner ? (
                              <td className="py-3">
                                <div className="flex flex-wrap items-end justify-end gap-2">
                                  <ConfirmAction
                                    label="Remove member"
                                    message={`Remove ${member.userId} from this Workspace?`}
                                    pending={management.removeMember.isPending}
                                    onConfirm={() =>
                                      management.removeMember.mutate({
                                        expectedRevision: member.revision,
                                        userId: member.userId,
                                        workspaceId,
                                      })
                                    }
                                  />
                                  <ConfirmAction
                                    label="Transfer ownership"
                                    message={`Transfer Workspace ownership to ${member.userId}?`}
                                    pending={management.transferOwnership.isPending}
                                    onConfirm={() =>
                                      management.transferOwnership.mutate({
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
            </Card>
          </section>

          <section aria-label="Workspace invitations">
            <Card className="flex flex-col gap-3">
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
                  isDisabled={management.createInvitation.isPending}
                  isRequired
                />
                <Button
                  type="submit"
                  isDisabled={management.createInvitation.isPending || !inviteeEmail}
                >
                  Create invitation
                </Button>
              </form>
              {management.createInvitation.isPending ? (
                <p role="status" aria-live="polite" className="mt-3 text-sm text-fg-muted">
                  Creating invitation…
                </p>
              ) : null}
              {management.createInvitation.isError ? (
                <div className="mt-3">
                  <ErrorBanner message={management.createInvitation.error.message} />
                </div>
              ) : null}
              {management.revokeInvitation.isError ? (
                <div className="mt-3">
                  <ErrorBanner message={management.revokeInvitation.error.message} />
                </div>
              ) : null}
              {management.invitations.isPending ? (
                <CollectionLoading label="Workspace invitations" />
              ) : null}
              {management.invitations.isError ? (
                <ErrorBanner
                  message="Couldn't load Workspace invitations."
                  onRetry={() => void management.invitations.refetch()}
                />
              ) : null}
              {management.invitations.isSuccess ? (
                management.invitations.data.items.length > 0 ? (
                  <table
                    aria-label="Workspace invitation records"
                    className="mt-3 w-full divide-y divide-separator"
                  >
                    <tbody>
                      {management.invitations.data.items.map(
                        (invitation: AccountWorkspaceInvitation) => (
                          <tr key={invitation.invitationId}>
                            <td className="min-w-0 py-3 pr-3">
                              <p className="text-sm font-bold text-fg-strong">
                                {invitation.inviteeUserId}
                              </p>
                              <div className="mt-1 flex items-center gap-2">
                                <StatusChip
                                  tone={
                                    invitation.effectiveStatus === 'pending' ? 'notice' : 'neutral'
                                  }
                                >
                                  {invitation.effectiveStatus}
                                </StatusChip>
                                <span className="text-xs text-fg-muted">Full member access</span>
                              </div>
                            </td>
                            {invitation.effectiveStatus === 'pending' ? (
                              <td className="py-3 text-right">
                                <ConfirmAction
                                  label="Revoke invitation"
                                  message={`Revoke the invitation for ${invitation.inviteeUserId}?`}
                                  pending={management.revokeInvitation.isPending}
                                  onConfirm={() =>
                                    management.revokeInvitation.mutate({
                                      expectedRevision: invitation.revision,
                                      invitationId: invitation.invitationId,
                                      workspaceId,
                                    })
                                  }
                                />
                              </td>
                            ) : null}
                          </tr>
                        )
                      )}
                    </tbody>
                  </table>
                ) : (
                  <p className="py-3 text-sm text-fg-muted">No invitations.</p>
                )
              ) : null}
            </Card>
          </section>
        </>
      ) : null}
    </div>
  );
}
