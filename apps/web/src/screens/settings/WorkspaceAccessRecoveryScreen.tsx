import type { RecoverWorkspaceAccessRequest } from '@openkit/app-api-schemas';
import { ApiCallError } from '@openkit/core-client';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useCoreClient } from '../../app/core-client';
import {
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  Page,
  PageHeader,
  Skeleton,
  TextField,
} from '../../primitives';

/** Explicit administrator self-recovery, bound to the last loaded registry revision. */
export function WorkspaceAccessRecoveryScreen() {
  const client = useCoreClient();
  const [workspaceInput, setWorkspaceInput] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const workspaceId = workspaceInput.trim();
  const adminAccess = useQuery({
    queryKey: ['settings', 'workspace-access-recovery', 'admin-access'],
    queryFn: async () => {
      await client.app.listOpenKitAccessTokens();
      return true;
    },
    retry: false,
  });
  const recovery = useMutation({
    mutationFn: async (operation: {
      workspaceId: string;
      request?: RecoverWorkspaceAccessRequest;
    }) => {
      const target = encodeURIComponent(operation.workspaceId);
      const response = operation.request
        ? await client.app.recoverWorkspaceAccess(target, operation.request)
        : await client.app.getWorkspaceAccessRecoveryState(target);
      const { workspaceId, ownerUserId, administratorRole, registryRevision } = response.recovery;
      return { workspaceId, ownerUserId, administratorRole, registryRevision };
    },
    retry: false,
  });
  const denied = [adminAccess.error, recovery.error].some(
    (error) => error instanceof ApiCallError && (error.status === 401 || error.status === 403)
  );
  const summary = recovery.data;
  const busy = recovery.isPending || adminAccess.isFetching;
  const canRecover = !busy && !!summary && summary.workspaceId === workspaceId;

  /** Every recovery is a new explicit decision; retries only clear the previous observation. */
  function recover(action: RecoverWorkspaceAccessRequest['action']) {
    if (!canRecover || !summary) return;
    if (action === 'transfer-ownership-to-self' && confirmation !== workspaceId) return;
    setConfirmation('');
    recovery.mutate({
      workspaceId,
      request: {
        action,
        requestId: crypto.randomUUID(),
        expectedRegistryRevision: summary.registryRevision,
      },
    });
  }

  return (
    <Page>
      <PageHeader
        eyebrow="Administration"
        title="Workspace access recovery"
        subtitle="Inspect a workspace's access state and explicitly restore your own access."
      />
      {adminAccess.isLoading ? (
        <Skeleton lines={6} />
      ) : denied ? (
        <EmptyState
          icon="key"
          title="Access denied"
          hint="Workspace access recovery requires derived server-admin authority on the signed-in session."
          action={
            <Button
              variant="outline"
              onPress={() => {
                recovery.reset();
                setWorkspaceInput('');
                setConfirmation('');
                void adminAccess.refetch();
              }}
            >
              Retry
            </Button>
          }
        />
      ) : adminAccess.isError ? (
        <ErrorBanner
          message="Couldn't verify deployment-admin authority."
          onRetry={() => void adminAccess.refetch()}
        />
      ) : (
        <>
          {recovery.isError ? (
            <ErrorBanner
              message="Recovery request failed. Its outcome may be unknown. Load the current recovery state before explicitly choosing another action."
              onRetry={() => {
                recovery.reset();
                setConfirmation('');
              }}
            />
          ) : null}
          <Card className="flex flex-col gap-4">
            <TextField
              label="Workspace ID"
              value={workspaceInput}
              onChange={(value) => {
                setWorkspaceInput(value);
                setConfirmation('');
                recovery.reset();
              }}
              isDisabled={busy}
            />
            <Button
              variant="outline"
              isDisabled={!workspaceId || busy}
              onPress={() => {
                setConfirmation('');
                recovery.mutate({ workspaceId });
              }}
            >
              Load recovery state
            </Button>
          </Card>
          {recovery.isPending ? (
            <p role="status" className="text-sm text-fg-muted">
              {recovery.variables.request ? 'Recovering access…' : 'Loading recovery state…'}
            </p>
          ) : null}
          {summary ? (
            <Card className="flex flex-col gap-3">
              <h2 className="text-sm font-bold text-fg-strong">Recovery state</h2>
              <dl className="grid grid-cols-2 gap-2 text-sm text-fg">
                <dt>Workspace ID</dt>
                <dd>{summary.workspaceId}</dd>
                <dt>Owner user ID</dt>
                <dd>{summary.ownerUserId}</dd>
                <dt>Administrator role</dt>
                <dd>{summary.administratorRole ?? 'No active membership'}</dd>
                <dt>Registry revision</dt>
                <dd>{summary.registryRevision}</dd>
              </dl>
            </Card>
          ) : null}
          <Card className="flex flex-col gap-4">
            <Button isDisabled={!canRecover} onPress={() => recover('add-self-as-editor')}>
              Add myself as editor
            </Button>
            <TextField
              label="Confirm workspace ID"
              description="Transferring ownership replaces the current owner with your signed-in user. Type the workspace ID to confirm."
              value={confirmation}
              onChange={setConfirmation}
              isDisabled={!canRecover}
            />
            <Button
              variant="outline"
              isDisabled={!canRecover || confirmation !== workspaceId}
              onPress={() => recover('transfer-ownership-to-self')}
            >
              Transfer ownership to myself
            </Button>
          </Card>
        </>
      )}
    </Page>
  );
}
