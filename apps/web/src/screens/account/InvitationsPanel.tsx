import { Button, Card, ErrorBanner, StatusChip } from '../../primitives';
import {
  type AccountWorkspaceInvitation,
  type MyInvitationDecisionVariables,
  useMyWorkspaceInvitations,
} from './data';
import { useAccountAdmission } from './session';

/** Account-level current-user invitation lifecycle across Workspaces. */
export function InvitationsPanel() {
  const admission = useAccountAdmission({ enabled: false });
  const myInvitations = useMyWorkspaceInvitations();
  const authorizedWorkspaces = admission.data?.items ?? [];

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

  return (
    <section aria-label="My invitations">
      <Card className="flex flex-col gap-3">
        <div>
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
          <ErrorBanner
            message={myInvitations.decision.error.message}
            onRetry={canRetryDecision ? retryDecision : undefined}
          />
        ) : null}
        {myInvitations.invitations.isSuccess ? (
          myInvitations.invitations.data.items.length > 0 ? (
            <table aria-label="My invitation records" className="w-full divide-y divide-separator">
              <tbody>
                {myInvitations.invitations.data.items.map((invitation) => {
                  const authorizedName = authorizedWorkspaces.find(
                    (item) => item.workspace.id === invitation.workspaceId
                  )?.workspace.name;
                  const workspaceName =
                    authorizedName && authorizedName.trim() !== '' ? authorizedName : null;
                  return (
                    <tr key={invitation.invitationId} className="align-top">
                      <td className="min-w-0 py-3 pr-3">
                        <p className="text-sm font-bold text-fg-strong">
                          {workspaceName ?? invitation.workspaceId}
                        </p>
                        {workspaceName ? (
                          <p className="mt-1 text-xs text-fg-muted">{invitation.workspaceId}</p>
                        ) : null}
                        <div className="mt-2 flex flex-wrap items-center gap-2">
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
                      <td className="py-3">
                        {invitation.effectiveStatus === 'pending' ? (
                          <div className="flex flex-wrap justify-end gap-2">
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
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <p className="py-3 text-sm text-fg-muted">No invitations.</p>
          )
        ) : null}
      </Card>
    </section>
  );
}
