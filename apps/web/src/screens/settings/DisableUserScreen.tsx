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

/** Disable one deliberately entered canonical user using session-derived administrator authority. */
export function DisableUserScreen() {
  const client = useCoreClient();
  const [userInput, setUserInput] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const userId = userInput.trim();
  const adminAccess = useQuery({
    queryKey: ['settings', 'disable-user', 'admin-access'],
    queryFn: async () => {
      await client.app.listOpenKitAccessTokens();
      return true;
    },
    retry: false,
  });
  const disable = useMutation({
    mutationFn: async (targetUserId: string) => {
      const response = await client.app.disableUser(encodeURIComponent(targetUserId), {
        requestId: crypto.randomUUID(),
      });
      const { userId, status, disabledAt } = response.user;
      return { userId, status, disabledAt };
    },
    retry: false,
  });
  const denied = [adminAccess.error, disable.error].some(
    (error) => error instanceof ApiCallError && (error.status === 401 || error.status === 403)
  );
  const busy = disable.isPending || adminAccess.isFetching;
  const canDisable = !!userId && confirmation === userId && !busy;
  const summary = disable.data;

  return (
    <Page>
      <PageHeader
        eyebrow="Administration"
        title="Disable user"
        subtitle="Disable one exact user while preserving their identity and history. This screen cannot re-enable a user."
      />
      {adminAccess.isLoading ? (
        <Skeleton lines={6} />
      ) : denied ? (
        <EmptyState
          icon="key"
          title="Access denied"
          hint="Disabling users requires derived server-admin authority on the signed-in session."
          action={
            <Button
              variant="outline"
              onPress={() => {
                disable.reset();
                setUserInput('');
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
          {disable.isError ? (
            <ErrorBanner
              message="User disable request failed. Its outcome may be unknown. Inspect the user before explicitly submitting another request."
              onRetry={() => {
                disable.reset();
                setConfirmation('');
              }}
            />
          ) : null}
          <Card className="flex flex-col gap-4">
            <TextField
              label="User ID"
              value={userInput}
              onChange={(value) => {
                setUserInput(value);
                setConfirmation('');
                disable.reset();
              }}
              isDisabled={busy}
            />
            <TextField
              label="Confirm user ID"
              description="This user will lose access. Type the exact user ID to confirm disabling them."
              value={confirmation}
              onChange={setConfirmation}
              isDisabled={!userId || busy}
            />
            <Button
              variant="outline"
              isDisabled={!canDisable}
              onPress={() => {
                if (!canDisable) return;
                setConfirmation('');
                disable.mutate(userId);
              }}
            >
              Disable user
            </Button>
          </Card>
          {disable.isPending ? (
            <p role="status" className="text-sm text-fg-muted">
              Disabling user…
            </p>
          ) : null}
          {summary ? (
            <Card className="flex flex-col gap-3">
              <h2 className="text-sm font-bold text-fg-strong">User disabled</h2>
              <dl className="grid grid-cols-2 gap-2 text-sm text-fg">
                <dt>User ID</dt>
                <dd>{summary.userId}</dd>
                <dt>Status</dt>
                <dd>{summary.status}</dd>
                <dt>Disabled at</dt>
                <dd>{summary.disabledAt}</dd>
              </dl>
            </Card>
          ) : null}
        </>
      )}
    </Page>
  );
}
