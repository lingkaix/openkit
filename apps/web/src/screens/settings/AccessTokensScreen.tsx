import type { OpenKitAccessTokenRecord, OpenKitAccessTokenScope } from '@openkit/app-api-schemas';
import { ApiCallError } from '@openkit/core-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useCoreClient } from '../../app/core-client';
import {
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  ListRow,
  Page,
  PageHeader,
  Select,
  Skeleton,
  TextField,
} from '../../primitives';

const QUERY_KEY = ['settings', 'access-tokens'] as const;
const SCOPE_ITEMS = [
  { id: 'server-admin', label: 'server-admin' },
  { id: 'workspace', label: 'workspace' },
  { id: 'workspace-readonly', label: 'workspace-readonly' },
];

/** Deployment-admin list, issue, revoke, and rotate for redacted access tokens. */
export function AccessTokensScreen() {
  const client = useCoreClient();
  const queryClient = useQueryClient();
  const [ownerUserId, setOwnerUserId] = useState('');
  const [scope, setScope] = useState<OpenKitAccessTokenScope>('server-admin');
  const [workspaceIdsText, setWorkspaceIdsText] = useState('');
  const [expiresAt, setExpiresAt] = useState(() =>
    new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString()
  );
  const [issuedSecret, setIssuedSecret] = useState<string | null>(null);
  const listed = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => client.app.listOpenKitAccessTokens(),
    retry: false,
  });
  const issue = useMutation({
    mutationFn: () =>
      client.app.createOpenKitAccessToken({
        ownerUserId: ownerUserId.trim(),
        scope,
        expiresAt,
        workspaceIds: parseWorkspaceIds(scope, workspaceIdsText),
      }),
    gcTime: 0,
    onSuccess: (result) => {
      setIssuedSecret(result.token);
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    },
  });
  const revoke = useMutation({
    mutationFn: (tokenId: string) => client.app.revokeOpenKitAccessToken(tokenId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    },
  });
  const rotate = useMutation({
    gcTime: 0,
    mutationFn: (tokenId: string) => client.app.rotateOpenKitAccessToken(tokenId),
    onSuccess: (result) => {
      setIssuedSecret(result.token);
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    },
  });

  const denied = isAccessDenied(listed.error);
  const canIssue = Boolean(ownerUserId.trim() && expiresAt.trim());

  return (
    <Page>
      <PageHeader
        eyebrow="Administration"
        title="Access tokens"
        subtitle="Issue, revoke, and rotate redacted OpenKit access tokens. Newly returned secrets appear once in this page only."
      />

      {issuedSecret ? (
        <Card className="flex flex-col gap-3">
          <div>
            <h2 className="text-sm font-bold text-fg-strong">Copy this token now</h2>
            <p className="mt-1 text-sm text-fg-muted">
              The plaintext secret is shown once and is not stored in this page after you dismiss
              it.
            </p>
          </div>
          <TextField label="Issued token" value={issuedSecret} isReadOnly />
          <div className="flex justify-end">
            <Button
              variant="outline"
              onPress={() => {
                setIssuedSecret(null);
                issue.reset();
                rotate.reset();
              }}
            >
              Dismiss
            </Button>
          </div>
        </Card>
      ) : null}

      {listed.isSuccess ? (
        <Card className="flex flex-col gap-3">
          <h2 className="text-sm font-bold text-fg-strong">Issue token</h2>
          <TextField
            label="Owner user id"
            value={ownerUserId}
            onChange={setOwnerUserId}
            autoComplete="off"
          />
          <Select
            label="Scope"
            items={SCOPE_ITEMS}
            selectedKey={scope}
            onSelectionChange={(key) => {
              if (key == null) return;
              setScope(String(key) as OpenKitAccessTokenScope);
            }}
          />
          {scope !== 'server-admin' ? (
            <TextField
              label="Workspace ids"
              value={workspaceIdsText}
              onChange={setWorkspaceIdsText}
              description="Comma-separated workspace ids. Membership is checked for the target owner."
            />
          ) : null}
          <TextField label="Expires at" value={expiresAt} onChange={setExpiresAt} />
          {issue.isError ? <ErrorBanner message="Couldn't issue the access token." /> : null}
          <div className="flex justify-end">
            <Button isDisabled={!canIssue || issue.isPending} onPress={() => issue.mutate()}>
              Issue token
            </Button>
          </div>
        </Card>
      ) : null}

      {listed.isLoading ? (
        <Skeleton lines={4} />
      ) : listed.isError && denied ? (
        <EmptyState
          icon="key"
          title="Access denied"
          hint="Access-token administration requires derived server-admin authority on the signed-in session."
          action={
            <Button variant="outline" onPress={() => void listed.refetch()}>
              Retry
            </Button>
          }
        />
      ) : listed.isError ? (
        <ErrorBanner message="Couldn't load access tokens." onRetry={() => void listed.refetch()} />
      ) : listed.data?.items.length === 0 ? (
        <EmptyState
          icon="key"
          title="No access tokens"
          hint="Issued tokens appear here with redacted metadata only."
        />
      ) : (
        <div>
          {(listed.data?.items ?? []).map((item) => (
            <TokenRow
              key={item.tokenId}
              item={item}
              busy={revoke.isPending || rotate.isPending}
              onRevoke={() => revoke.mutate(item.tokenId)}
              onRotate={() => rotate.mutate(item.tokenId)}
            />
          ))}
        </div>
      )}
    </Page>
  );
}

function TokenRow({
  item,
  busy,
  onRevoke,
  onRotate,
}: {
  item: OpenKitAccessTokenRecord;
  busy: boolean;
  onRevoke: () => void;
  onRotate: () => void;
}) {
  return (
    <ListRow>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-bold text-fg-strong">{item.tokenId}</p>
        <p className="text-xs text-fg-muted">
          {item.scope} · {item.status} · owner {item.ownerUserId}
        </p>
      </div>
      <Button
        size="sm"
        variant="outline"
        isDisabled={busy || item.status !== 'active'}
        onPress={onRotate}
      >
        Rotate
      </Button>
      <Button
        size="sm"
        variant="quiet"
        isDisabled={busy || item.status === 'revoked'}
        onPress={onRevoke}
      >
        Revoke
      </Button>
    </ListRow>
  );
}

function parseWorkspaceIds(scope: OpenKitAccessTokenScope, value: string): string[] {
  if (scope === 'server-admin') return [];
  return value
    .split(/[\s,]+/)
    .map((id) => id.trim())
    .filter(Boolean);
}

function isAccessDenied(error: unknown): boolean {
  return error instanceof ApiCallError && (error.status === 401 || error.status === 403);
}
