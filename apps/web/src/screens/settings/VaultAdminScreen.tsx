import { ApiCallError } from '@openkit/core-client';
import { useIsMutating, useMutation, useQuery } from '@tanstack/react-query';
import { useCoreClient } from '../../app/core-client';
import {
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  Page,
  PageHeader,
  Skeleton,
} from '../../primitives';
import { useCurrentWorkspaceId } from './data';
import { ServerVaultSecretsPanel } from './ServerVaultSecretsPanel';
import { redactSecretShapedText } from './secret-safe';
import { VaultSecretsPanel } from './VaultSecretsPanel';

/** Preserve only HTTP status for denial handling; raw errors never enter either cache. */
function vaultRequestError(error: unknown) {
  return new ApiCallError(
    error instanceof ApiCallError ? error.status : 0,
    'Vault backend request failed.'
  );
}

/** Administer the deployment Vault with session-derived authority. */
export function VaultAdminScreen() {
  const client = useCoreClient();
  const secretWrites = useIsMutating({ mutationKey: ['vault-admin-secret'] });
  const status = useQuery({
    queryKey: ['settings', 'vault-admin'],
    queryFn: async () => {
      try {
        const { backendKind, state, diagnostic } = await client.operations['vault.status']({});
        return { backendKind, state, diagnostic: redactSecretShapedText(diagnostic) };
      } catch (error) {
        throw vaultRequestError(error);
      }
    },
    retry: false,
  });
  const operation = useMutation({
    mutationFn: async (action: 'unlock' | 'lock') => {
      try {
        if (action === 'unlock') {
          await client.operations['vault.unlock']({});
        } else {
          await client.operations['vault.lock']({});
        }
      } catch (error) {
        throw vaultRequestError(error);
      }
    },
    retry: false,
    onSuccess: async () => {
      await status.refetch();
    },
  });
  const denied = [status.error, operation.error].some(
    (error) => error instanceof ApiCallError && (error.status === 401 || error.status === 403)
  );
  const busy = status.isFetching || operation.isPending || secretWrites > 0;
  const canUnlock =
    !busy && !status.isError && !operation.isError && status.data?.state === 'locked';
  const canLock =
    !busy && !status.isError && !operation.isError && status.data?.state === 'available';

  /** Recheck current authority and state without replaying a prior mutation. */
  function retry() {
    operation.reset();
    void status.refetch();
  }

  return (
    <Page>
      <PageHeader
        eyebrow="Administration"
        title="Vault backend"
        subtitle="Inspect and control the deployment Vault. Locking makes Vault-dependent operations unavailable until unlocked."
      />
      {status.isFetching && !operation.isPending ? (
        <Skeleton lines={6} />
      ) : denied ? (
        <EmptyState
          icon="key"
          title="Access denied"
          hint="Vault administration requires derived server-admin authority on the signed-in session."
          action={
            <Button variant="outline" onPress={retry}>
              Retry
            </Button>
          }
        />
      ) : status.isError ? (
        <ErrorBanner message="Couldn't load Vault backend status." onRetry={retry} />
      ) : (
        <>
          {operation.isError ? (
            <ErrorBanner
              message="Vault request failed. Its outcome may be unknown. Refresh status before explicitly trying again; rate-limited unlock attempts may require waiting."
              onRetry={retry}
            />
          ) : null}
          {status.data ? (
            <Card className="flex flex-col gap-3">
              <dl className="grid grid-cols-2 gap-2 text-sm text-fg">
                <dt>Backend kind</dt>
                <dd>{status.data.backendKind}</dd>
                <dt>State</dt>
                <dd>{status.data.state}</dd>
                <dt>Diagnostic</dt>
                <dd>{status.data.diagnostic}</dd>
              </dl>
            </Card>
          ) : null}
          <Card className="flex flex-col gap-4">
            <p className="text-sm text-fg-muted">
              Unlock reloads the Vault key file configured on the server.
            </p>
            <Button
              isDisabled={!canUnlock}
              onPress={() => {
                if (!canUnlock) return;
                operation.mutate('unlock');
              }}
            >
              Unlock
            </Button>
            <Button
              variant="outline"
              isDisabled={!canLock}
              onPress={() => {
                if (canLock) operation.mutate('lock');
              }}
            >
              Lock
            </Button>
            <Button variant="outline" isDisabled={busy} onPress={retry}>
              Refresh status
            </Button>
          </Card>
          {status.data?.state === 'available' &&
          !status.isFetching &&
          !status.isError &&
          !operation.isPending &&
          !operation.isError ? (
            <>
              <SelectedWorkspaceSecrets />
              <ServerVaultSecretsPanel />
            </>
          ) : null}
          {operation.isPending ? (
            <p role="status" className="text-sm text-fg-muted">
              Updating Vault backend…
            </p>
          ) : null}
        </>
      )}
    </Page>
  );
}

/** Keep backend administration available even when no Workspace is selected. */
function SelectedWorkspaceSecrets() {
  const workspaceId = useCurrentWorkspaceId();
  return workspaceId ? (
    <VaultSecretsPanel key={workspaceId} workspaceId={workspaceId} />
  ) : (
    <p className="text-sm text-fg-muted">Select a Workspace to manage its secrets.</p>
  );
}
