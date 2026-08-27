import { Button, Dialog, ErrorBanner, Modal, StatusChip } from '../../primitives';
import {
  type AccountWorkspaceInvitation,
  type MyInvitationDecisionVariables,
  useMyWorkspaceInvitations,
  useSelfLeave,
} from './data';

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

/** Account-level current-user invitation lifecycle and selected-membership self-leave. */
export function InvitationsPanel() {
  const myInvitations = useMyWorkspaceInvitations();
  const selfLeave = useSelfLeave();

  /** Sends one exact pending invitation decision. */
  function decide(
    invitation: AccountWorkspaceInvitation,
    operation: MyInvitationDecisionVariables['operation']
  ) {
    myInvitations.decision.mutate({
      expectedRevision: invitation.revision,
      invitationId: invitation.invitationId,
      operation,
    });
  }

  /** Issues a new invitation request only after the applicable bounded reread settles. */
  function retryDecision() {
    const prior = myInvitations.decision.variables;
    const current = myInvitations.invitations.data?.items.find(
      (item) => item.invitationId === prior?.invitationId
    );
    if (!prior || current?.effectiveStatus !== 'pending') return;
    decide(current, prior.operation);
  }

  const decisionError = myInvitations.decision.error;
  const retryableDecision =
    decisionError?.code === 'workspace_access_denied' ||
    decisionError?.code === 'idempotency_key_conflict' ||
    decisionError?.code === 'recovery_required';
  const retryInvitation = myInvitations.invitations.data?.items.find(
    (item) => item.invitationId === myInvitations.decision.variables?.invitationId
  );
  const canRetryDecision =
    retryableDecision &&
    myInvitations.invitations.isSuccess &&
    !myInvitations.invitations.isFetching &&
    retryInvitation?.effectiveStatus === 'pending';
  const selectedWorkspace = selfLeave.selectedWorkspace;

  return (
    <div className="flex flex-col gap-4">
      <section aria-label="My invitations" className="rounded-ok border border-border bg-card p-4">
        <div className="mb-3">
          <h2 className="text-lg font-extrabold text-fg-strong">My invitations</h2>
          <p className="mt-1 text-xs text-fg-muted">
            Invitations addressed to this account across Workspaces.
          </p>
        </div>

        {myInvitations.invitations.isPending ? (
          <div role="status" aria-live="polite" className="flex flex-col gap-2 py-3">
            <span className="sr-only">Loading My invitations.</span>
            <span className="h-3 w-full rounded bg-skeleton" />
            <span className="h-3 w-3/4 rounded bg-skeleton" />
            <span className="h-3 w-1/2 rounded bg-skeleton" />
          </div>
        ) : null}
        {myInvitations.invitations.isError ? (
          <ErrorBanner
            message="Couldn't load My invitations."
            onRetry={() => void myInvitations.invitations.refetch()}
          />
        ) : null}
        {myInvitations.decision.isError ? (
          <div className="mb-3">
            <ErrorBanner
              message={myInvitations.decision.error.message}
              onRetry={canRetryDecision ? retryDecision : undefined}
            />
          </div>
        ) : null}
        {myInvitations.invitations.isSuccess ? (
          myInvitations.invitations.data.items.length > 0 ? (
            <table aria-label="My invitation records" className="w-full divide-y divide-separator">
              <tbody>
                {myInvitations.invitations.data.items.map((invitation) => (
                  <tr key={invitation.invitationId} className="align-top">
                    <td className="min-w-0 py-3 pr-3">
                      <p className="text-sm font-bold text-fg-strong">{invitation.workspaceId}</p>
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
                        <div className="flex justify-end gap-2">
                          <Button
                            size="sm"
                            isDisabled={myInvitations.decision.isPending}
                            onPress={() => decide(invitation, 'accept')}
                          >
                            Accept
                          </Button>
                          <Button
                            size="sm"
                            variant="negative-outline"
                            isDisabled={myInvitations.decision.isPending}
                            onPress={() => decide(invitation, 'decline')}
                          >
                            Decline
                          </Button>
                        </div>
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

      {selfLeave.canLeave && selectedWorkspace && selfLeave.selectedWorkspaceId ? (
        <section
          aria-label="Workspace membership"
          className="flex items-center justify-between gap-4 rounded-ok border border-border bg-card p-4"
        >
          <div>
            <p className="text-sm font-bold text-fg-strong">Leave Workspace</p>
            <p className="mt-1 text-xs text-fg-muted">{selectedWorkspace.workspace.name}</p>
          </div>
          <LeaveConfirmation
            errorMessage={selfLeave.leave.error?.message}
            pending={selfLeave.leave.isPending}
            workspaceName={selectedWorkspace.workspace.name}
            onConfirm={() =>
              selfLeave.leave.mutate({
                expectedRevision: selectedWorkspace.membershipRevision,
                workspaceId: selectedWorkspace.workspace.id,
              })
            }
          />
        </section>
      ) : null}
      {selfLeave.leave.isError ? <ErrorBanner message={selfLeave.leave.error.message} /> : null}
    </div>
  );
}
