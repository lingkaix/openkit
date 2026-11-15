import type {
  InboundCredentialRecord,
  NanoHostTransportTokenRecord,
  OpenKitAccessTokenRecord,
  OpenKitAccessTokenScope,
} from '@openkit/app-api-schemas';
import { ApiCallError } from '@openkit/core-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useCoreClient } from '../../app/core-client';
import {
  Button,
  Card,
  Dialog,
  EmptyState,
  ErrorBanner,
  ListRow,
  Modal,
  Page,
  PageHeader,
  Select,
  Skeleton,
  TextField,
} from '../../primitives';
import {
  attentionClause,
  attentionSentence,
  isAttention,
  LongList,
  matchesLoadedRow,
  usePhoneLayout,
} from './LongList';

const QUERY_KEY = ['settings', 'access-tokens'] as const;
const SCOPE_ITEMS = [
  { id: 'server-admin', label: 'server-admin' },
  { id: 'workspace', label: 'workspace' },
  { id: 'workspace-readonly', label: 'workspace-readonly' },
];

/** One credential list with own revocation and current administrator token issuance and rotation. */
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
    queryFn: () => client.operations['credential.list']({}),
    retry: false,
  });
  const issue = useMutation({
    mutationFn: () =>
      client.operations['token.create']({
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
    mutationFn: (item: InboundCredentialRecord) =>
      client.operations['credential.revoke']({ kind: item.kind, id: item.id }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    },
  });
  const rotate = useMutation({
    gcTime: 0,
    mutationFn: (tokenId: string) => client.operations['token.rotate']({ tokenId: tokenId }),
    onSuccess: (result) => {
      setIssuedSecret(result.token);
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    },
  });

  const [reviewId, setReviewId] = useState<string | null>(null);
  const phone = usePhoneLayout();
  const denied = isAccessDenied(listed.error);
  const canIssue = Boolean(ownerUserId.trim() && expiresAt.trim());
  const dismissIssued = () => {
    setIssuedSecret(null);
    issue.reset();
    rotate.reset();
  };

  return (
    <Page>
      <PageHeader
        eyebrow="User"
        title="Credentials"
        subtitle="Manage your inbound credentials. Administrators can also issue and rotate tokens. Newly issued secrets appear once."
      />

      {issuedSecret ? (
        phone ? (
          <Modal trigger={<Button className="min-h-11">Show issued token</Button>}>
            <Dialog title="Copy this token now">
              <p>
                The plaintext secret is shown once and is not stored in this page after you dismiss
                it.
              </p>
              <TextField label="Issued token" value={issuedSecret} isReadOnly />
              <div className="flex justify-end gap-2">
                <Button
                  variant="outline"
                  className="min-h-11"
                  onPress={() => void navigator.clipboard?.writeText(issuedSecret)}
                >
                  Copy
                </Button>
                <Button variant="outline" className="min-h-11" onPress={dismissIssued}>
                  Dismiss
                </Button>
              </div>
            </Dialog>
          </Modal>
        ) : (
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
              <Button variant="outline" className="min-h-11" onPress={dismissIssued}>
                Dismiss
              </Button>
            </div>
          </Card>
        )
      ) : null}

      {listed.data?.canManageServerCredentials ? (
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
        <LongList
          summary={(filter) => {
            const lines = (listed.data?.items ?? [])
              .filter(
                (item) =>
                  isAttention(credentialStatus(item)) &&
                  matchesLoadedRow(filter, {
                    outcome: credentialStatus(item),
                    title: item.kind,
                    at: credentialIssuedAt(item),
                  })
              )
              .map((item) => (
                <p key={`${item.kind}:${item.id}`}>
                  {attentionSentence(
                    attentionClause(credentialStatus(item)),
                    item.kind,
                    credentialIssuedAt(item)
                  )}
                </p>
              ));
            return lines.length > 0 ? (
              lines
            ) : (
              <p>Nothing failed, was denied, or needs a decision.</p>
            );
          }}
          records={(filter) =>
            (listed.data?.items ?? [])
              .filter((item) =>
                matchesLoadedRow(filter, {
                  outcome: credentialStatus(item),
                  title: item.id,
                  at: credentialIssuedAt(item),
                })
              )
              .map((item) =>
                item.kind === 'access-token' ? (
                  <TokenRow
                    key={`${item.kind}:${item.id}`}
                    item={item.record}
                    busy={revoke.isPending || rotate.isPending}
                    canRotate={listed.data?.canManageServerCredentials === true}
                    onRevoke={() => revoke.mutate(item)}
                    onRotate={() => rotate.mutate(item.id)}
                  />
                ) : item.kind === 'nanohost-transport' ? (
                  <NanoHostTokenRow
                    key={`${item.kind}:${item.id}`}
                    item={item.record}
                    reviewing={reviewId === item.id}
                    busy={revoke.isPending}
                    failed={revoke.isError && revoke.variables?.id === item.id}
                    onReview={() => setReviewId(reviewId === item.id ? null : item.id)}
                    onRevoke={() => revoke.mutate(item)}
                  />
                ) : (
                  <ListRow key={`${item.kind}:${item.id}`}>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-bold text-fg-strong">
                        {item.kind === 'auth-session'
                          ? `Web session${item.current ? ' (current)' : ''}`
                          : item.kind === 'discord-pairing'
                            ? 'Discord pairing'
                            : 'Worker run'}
                      </p>
                      <p className="truncate text-xs text-fg-muted">
                        {item.id} · {credentialStatus(item)}
                      </p>
                    </div>
                    <Button
                      variant="quiet"
                      isDisabled={revoke.isPending || credentialStatus(item) === 'closing'}
                      onPress={() => revoke.mutate(item)}
                    >
                      {item.kind === 'worker-run' ? 'End run' : 'Revoke'}
                    </Button>
                  </ListRow>
                )
              )
          }
        />
      )}
      {revoke.isError && revoke.variables?.kind !== 'nanohost-transport' ? (
        <ErrorBanner message="Couldn’t revoke the credential." />
      ) : null}
    </Page>
  );
}

function NanoHostTokenRow({
  item,
  reviewing,
  busy,
  failed,
  onReview,
  onRevoke,
}: {
  item: NanoHostTransportTokenRecord;
  reviewing: boolean;
  busy: boolean;
  failed: boolean;
  onReview: () => void;
  onRevoke: () => void;
}) {
  const revoked = item.status === 'revoked';
  return (
    <ListRow className="flex-wrap">
      <div className="min-w-0 flex-1 basis-full sm:basis-auto">
        <p className="truncate text-sm font-bold text-fg-strong">{item.tokenId}</p>
        <p className="text-xs text-fg-muted">
          {item.scope} · {item.status} · host {item.ownerNanoHostIdentityId}
        </p>
      </div>
      {failed ? (
        <div className="basis-full">
          <ErrorBanner message="Couldn't revoke the NanoHost transport token." />
        </div>
      ) : null}
      <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
        <Button
          size="sm"
          variant="outline"
          className="min-h-11"
          isDisabled={busy || revoked}
          onPress={onReview}
        >
          {reviewing ? 'Keep transport token' : 'Review revoke'}
        </Button>
        {reviewing ? (
          <Button
            size="sm"
            variant="quiet"
            className="min-h-11"
            isDisabled={busy || revoked}
            onPress={onRevoke}
          >
            Revoke transport token
          </Button>
        ) : null}
      </div>
    </ListRow>
  );
}

function TokenRow({
  item,
  busy,
  onRevoke,
  onRotate,
  canRotate,
}: {
  item: OpenKitAccessTokenRecord;
  canRotate: boolean;
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
        className="min-h-11"
        isDisabled={busy || !canRotate || item.status !== 'active'}
        onPress={onRotate}
      >
        Rotate
      </Button>
      <Button
        size="sm"
        variant="quiet"
        className="min-h-11"
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

/** Reads the shared row vocabulary without exposing any credential material. */
function credentialStatus(item: InboundCredentialRecord): string {
  return 'record' in item ? item.record.status : 'status' in item ? item.status : 'active';
}

/** Uses each original owner's issued timestamp for the common list. */
function credentialIssuedAt(item: InboundCredentialRecord): string {
  return 'record' in item ? item.record.issuedAt : item.issuedAt;
}
