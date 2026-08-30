import { ApiCallError } from '@openkit/core-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCoreClient } from '../../app/core-client';
import {
  Button,
  EmptyState,
  ErrorBanner,
  Page,
  PageHeader,
  RadioGroup,
  Skeleton,
} from '../../primitives';

const QUERY_KEY = ['settings', 'my-admin-tokens'] as const;

/** Signed-in user's redacted server-admin tokens and effective default selection. */
export function MyAdminAccessScreen() {
  const client = useCoreClient();
  const queryClient = useQueryClient();
  const listed = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => client.app.listMyAdminAccessTokens(),
    retry: false,
  });
  const setDefault = useMutation({
    mutationFn: (tokenId: string) => client.app.setMyAdminAccessTokenDefault({ tokenId }),
    onSuccess: (data) => {
      queryClient.setQueryData(QUERY_KEY, data);
    },
  });

  const denied = isAccessDenied(listed.error);

  return (
    <Page>
      <PageHeader
        eyebrow="User"
        title="My admin access"
        subtitle="Choose which owned server-admin token this session uses for deployment administration."
      />

      {listed.isLoading ? (
        <Skeleton lines={4} />
      ) : listed.isError && denied ? (
        <EmptyState
          icon="key"
          title="Access denied"
          hint="My admin access is available only to a signed-in canonical session."
          action={
            <Button variant="outline" onPress={() => void listed.refetch()}>
              Retry
            </Button>
          }
        />
      ) : listed.isError ? (
        <ErrorBanner
          message="Couldn't load your server-admin tokens."
          onRetry={() => void listed.refetch()}
        />
      ) : listed.data?.items.length === 0 ? (
        <EmptyState
          icon="key"
          title="No server-admin tokens"
          hint="Owned server-admin token metadata appears here once issued; only currently usable tokens can become the default."
        />
      ) : (
        <div className="flex flex-col gap-3">
          {setDefault.isError ? (
            <ErrorBanner message="Couldn't change the default server-admin token." />
          ) : null}
          <RadioGroup
            aria-label="Effective default server-admin token"
            value={listed.data?.defaultTokenId ?? undefined}
            isDisabled={setDefault.isPending}
            onChange={(tokenId) => setDefault.mutate(tokenId)}
            items={(listed.data?.items ?? []).map((item) => ({
              id: item.tokenId,
              label: `${item.tokenId} (${item.status})`,
              content: (
                <div className="flex flex-col gap-0.5">
                  <p className="text-sm font-bold text-fg-strong">{item.tokenId}</p>
                  <p className="text-xs text-fg-muted">
                    {item.status} · expires {item.expiresAt}
                  </p>
                </div>
              ),
            }))}
          />
        </div>
      )}
    </Page>
  );
}

function isAccessDenied(error: unknown): boolean {
  return error instanceof ApiCallError && (error.status === 401 || error.status === 403);
}
