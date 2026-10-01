import { ProviderApiKeyProfileIdSchema } from '@openkit/app-api-schemas';
import { ApiCallError, type CoreClient } from '@openkit/core-client';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useConnection, useCoreClient } from '../../app/core-client';
import {
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  Page,
  PageHeader,
  Select,
  Skeleton,
  StatusChip,
  TextField,
} from '../../primitives';
import {
  type ConnectedAppProviderRow,
  type ConnectedAppQuotaWindow,
  type ConnectedAppRow,
  overlayConnectedAppQuota,
  projectConnectedApps,
  settingsKeys,
} from './data';
import {
  affectedLogicalModels,
  GatewayConfiguration,
  GuidedSubscriptionSetup,
  KeyProviderCard,
  ProfileRemoval,
  ProviderHeader,
} from './GatewayConfiguration';
import { projectSafeValue, providerSubscriptionAccountStatusLabel } from './secret-safe';

type SubscriptionProviderId = ConnectedAppProviderRow['subscriptionProviderId'];
type ProviderSubscriptionAccount = Awaited<
  ReturnType<CoreClient['providerSubscriptions']['getAccountStatus']>
>;
type ProviderRegistryEntry = Awaited<
  ReturnType<CoreClient['app']['getDiagnostics']>
>['providers']['registry'][number];
type ProviderDiagnostic = Awaited<
  ReturnType<CoreClient['app']['getDiagnostics']>
>['providers']['diagnostics'][number];
type GatewayDiagnostics = Awaited<ReturnType<CoreClient['app']['getDiagnostics']>>['gateway'];

const OAUTH_VENDORS: Record<SubscriptionProviderId, string> = {
  'openai-codex': 'openai_codex',
  xai: 'xai',
};

const PROVIDER_KINDS = ['direct', 'gateway', 'local', 'oauth', 'custom'] as const;
const STATUS_POLL_MS = 2_000;

/** Checks whether a failed list read is a typed access denial. */
function isAdminDenied(error: unknown): boolean {
  return error instanceof ApiCallError && (error.status === 401 || error.status === 403);
}

/**
 * Gateway settings — active deployment-admin Provider, model, and routing workflow.
 *
 * Uses the signed-in session client. Derived server-admin authority is required.
 * Web never asks for a bearer token. Honors §9.13.
 */
export function AiInterfaceScreen() {
  const client = useCoreClient();
  const queryClient = useQueryClient();
  const { failed: disconnected } = useConnection();
  const [initialAccountsObserved, setInitialAccountsObserved] = useState(false);
  const [quotaAccessDenied, setQuotaAccessDenied] = useState<{
    providerId: SubscriptionProviderId;
    slot: string;
  } | null>(null);
  const accountsKey = [...settingsKeys.aiInterface, 'accounts'] as const;
  const diagnosticsKey = [...settingsKeys.aiInterface, 'diagnostics'] as const;

  const inventory = useQuery({
    queryKey: [...settingsKeys.aiInterface, 'inventory'],
    queryFn: () => client.providerSubscriptions.listProviders(),
    gcTime: 0,
    retry: false,
  });
  const accountLists = useQueries({
    queries: (inventory.data?.providers ?? []).map((provider) => ({
      queryKey: [...accountsKey, provider.subscriptionProviderId],
      queryFn: async () => {
        const listed = await client.providerSubscriptions.listAccounts(
          provider.subscriptionProviderId
        );
        return projectConnectedApps(
          provider,
          listed,
          listed.accounts.map(() => null)
        );
      },
      gcTime: 0,
      retry: false,
    })),
  });
  const listedAccounts = accountLists.flatMap((query) => (query.data ? [query.data] : []));
  const quotaPairs = listedAccounts.flatMap((provider) =>
    provider.accounts.map(
      (account) => `${provider.subscriptionProviderId}/${account.accountSlotId}`
    )
  );
  const quotaQueries = useQueries({
    queries: listedAccounts.flatMap((provider) =>
      provider.accounts.map((account) => ({
        queryKey: [
          ...settingsKeys.aiInterface,
          'quota',
          provider.subscriptionProviderId,
          account.accountSlotId,
        ],
        queryFn: () =>
          readAccountQuota(client, provider.subscriptionProviderId, account.accountSlotId),
        retry: false,
        gcTime: 0,
        staleTime: Infinity,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
      }))
    ),
  });
  const accounts = quotaQueries.reduce(
    (rows, query) =>
      query.data && !query.isError ? overlayConnectedAppQuota(rows, query.data) : rows,
    listedAccounts
  );
  const accountsReady =
    accountLists.every((query) => !query.isPending) &&
    quotaQueries.every((query) => !query.isPending);
  const diagnostics = useQuery({
    queryKey: diagnosticsKey,
    queryFn: async () =>
      projectSafeValue(await client.app.getDiagnostics()) as Awaited<
        ReturnType<CoreClient['app']['getDiagnostics']>
      >,
    enabled: inventory.isSuccess,
    gcTime: 0,
    retry: false,
  });

  useEffect(() => {
    if (inventory.isSuccess && accountsReady && diagnostics.isSuccess)
      setInitialAccountsObserved(true);
  }, [inventory.isSuccess, accountsReady, diagnostics.isSuccess]);

  function retry() {
    if (quotaAccessDenied) {
      const { providerId, slot } = quotaAccessDenied;
      void queryClient
        .fetchQuery({
          queryKey: [...settingsKeys.aiInterface, 'quota', providerId, slot],
          queryFn: () => readAccountQuota(client, providerId, slot),
          retry: false,
          staleTime: 0,
        })
        .catch(() => undefined);
    }
    setQuotaAccessDenied(null);
    queryClient.removeQueries({
      queryKey: [...settingsKeys.aiInterface, 'status'],
    });
    void inventory.refetch();
    for (const query of accountLists) void query.refetch();
    for (const query of quotaQueries) if (query.isError) void query.refetch();
    void diagnostics.refetch();
  }

  const adminDenied =
    quotaAccessDenied !== null ||
    isAdminDenied(inventory.error) ||
    accountLists.some((query) => isAdminDenied(query.error)) ||
    quotaQueries.some((query) => isAdminDenied(query.error));
  const onAccountsChanged = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: [...settingsKeys.aiInterface, 'status'] });
    void queryClient.invalidateQueries({ queryKey: [...settingsKeys.aiInterface, 'diagnostics'] });
    void queryClient.invalidateQueries({
      queryKey: [...settingsKeys.aiInterface, 'accounts'],
    });
  }, [queryClient]);
  const onProfilesChanged = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: [...settingsKeys.aiInterface, 'accounts'],
    });
    void queryClient.invalidateQueries({
      queryKey: [...settingsKeys.aiInterface, 'diagnostics'],
    });
    void queryClient.invalidateQueries({
      queryKey: [...settingsKeys.aiInterface, 'server'],
    });
  }, [queryClient]);

  return (
    <Page>
      <PageHeader
        eyebrow="Deployment administration"
        title="Gateway"
        subtitle="Manage Providers, effective model metadata, and logical model routing for this deployment."
        actions={
          <Button
            size="sm"
            variant="outline"
            isDisabled={
              disconnected ||
              inventory.isFetching ||
              accountLists.some((query) => query.isFetching) ||
              adminDenied
            }
            onPress={retry}
          >
            Refresh status
          </Button>
        }
      />

      {inventory.isLoading ? (
        <Skeleton lines={6} />
      ) : adminDenied ? (
        <EmptyState
          icon="key"
          title="Access denied"
          hint="Gateway requires derived server-admin authority on the signed-in session."
          action={
            <div className="flex flex-col gap-2">
              <Button variant="outline" onPress={retry}>
                Retry
              </Button>
              {isAdminDenied(inventory.error) ? (
                <Button variant="outline" onPress={() => void inventory.refetch()}>
                  Retry subscription inventory
                </Button>
              ) : null}
              {accountLists.map((query, index) =>
                isAdminDenied(query.error) ? (
                  <Button
                    key={inventory.data!.providers[index]!.subscriptionProviderId}
                    variant="outline"
                    onPress={() => void query.refetch()}
                  >
                    Retry {inventory.data!.providers[index]!.displayName} account slots
                  </Button>
                ) : null
              )}
              {quotaQueries.map((query, index) =>
                isAdminDenied(query.error) ? (
                  <Button
                    key={quotaPairs[index]}
                    variant="outline"
                    onPress={() => void query.refetch()}
                  >
                    Retry quota{' '}
                    {
                      listedAccounts.flatMap((provider) =>
                        provider.accounts.map(
                          (account) => `${provider.displayName} / ${account.accountSlotId}`
                        )
                      )[index]
                    }
                  </Button>
                ) : null
              )}
              {quotaAccessDenied ? (
                <p className="text-xs text-fg-muted">
                  Quota denied: {quotaAccessDenied.providerId} / {quotaAccessDenied.slot}. Retry
                  rechecks that exact dependency.
                </p>
              ) : null}
            </div>
          }
        />
      ) : inventory.isError ? (
        <ErrorBanner
          message="Couldn't load Gateway subscription inventory."
          onRetry={() => void inventory.refetch()}
        />
      ) : (
        <>
          {accountLists.map((query, index) =>
            query.isError ? (
              <ErrorBanner
                key={inventory.data!.providers[index]!.subscriptionProviderId}
                message={dependencyMessage(
                  query.error,
                  `${inventory.data!.providers[index]!.displayName} account slots`
                )}
                onRetry={() => void query.refetch()}
              />
            ) : query.isLoading ? (
              <Skeleton key={inventory.data!.providers[index]!.subscriptionProviderId} lines={3} />
            ) : null
          )}
          {diagnostics.isError ? (
            <ErrorBanner
              message={dependencyMessage(diagnostics.error, 'Gateway diagnostics')}
              onRetry={() => void diagnostics.refetch()}
            />
          ) : diagnostics.isLoading || (!initialAccountsObserved && !accountsReady) ? (
            <Skeleton lines={4} />
          ) : (
            <ProviderProfiles
              client={client}
              disconnected={disconnected}
              profiles={diagnostics.data?.providers.registry ?? []}
              diagnostics={diagnostics.data?.providers.diagnostics ?? []}
              accounts={accounts}
              gateway={diagnostics.data?.gateway ?? null}
              onProfilesChanged={onProfilesChanged}
              onAccountsChanged={onAccountsChanged}
              onAccessDenied={(providerId, slot) => setQuotaAccessDenied({ providerId, slot })}
            />
          )}
          {initialAccountsObserved || accountsReady ? (
            <SubscriptionAccounts
              client={client}
              disconnected={disconnected}
              providers={accounts.map((provider) => ({
                ...provider,
                accounts: provider.accounts.filter(
                  (account) =>
                    !diagnostics.data?.providers.registry.some(
                      (profile) =>
                        profile.subscriptionAccount?.subscriptionProviderId ===
                          provider.subscriptionProviderId &&
                        profile.subscriptionAccount.accountSlotId === account.accountSlotId
                    )
                ),
              }))}
              onAccountsChanged={onAccountsChanged}
              onAccessDenied={(providerId, slot) => setQuotaAccessDenied({ providerId, slot })}
            />
          ) : null}
          {diagnostics.data ? (
            <GatewayConfiguration
              client={client}
              disconnected={disconnected}
              diagnostics={diagnostics.data}
              onChanged={onProfilesChanged}
            />
          ) : null}
        </>
      )}
      {/* Keep admitted setup progress mounted when a dependency projection is loading or fails. */}
      {initialAccountsObserved ? (
        <GuidedSubscriptionSetup
          client={client}
          disconnected={
            disconnected || adminDenied || !inventory.isSuccess || !diagnostics.isSuccess
          }
          accounts={accounts}
          onChanged={onProfilesChanged}
        />
      ) : null}
    </Page>
  );
}

/** Subscription-account lifecycle for the fixed Codex and xAI providers. */
function SubscriptionAccounts({
  client,
  disconnected,
  providers,
  onAccountsChanged,
  onAccessDenied,
}: {
  client: CoreClient;
  disconnected: boolean;
  providers: ConnectedAppProviderRow[];
  onAccountsChanged: () => void;
  onAccessDenied: (providerId: SubscriptionProviderId, slot: string) => void;
}) {
  return (
    <section className="flex min-w-0 w-full flex-col gap-3" aria-labelledby="ai-connected-apps">
      <div className="flex min-w-0 w-full flex-wrap items-baseline gap-2">
        <h2
          id="ai-connected-apps"
          className="text-eyebrow font-bold uppercase tracking-eyebrow text-fg-muted"
        >
          Retained subscription slots
        </h2>
        <span className="text-wrap text-xs text-fg-muted">
          OpenAI Codex and xAI device-code login
        </span>
      </div>
      {providers.length === 0 ? (
        <EmptyState
          icon="connect"
          title="No subscription providers"
          hint="Supported subscription providers appear here once inventory loads."
        />
      ) : (
        <div className="flex min-w-0 w-full flex-col gap-4">
          {providers.map((provider) => (
            <ProviderAccounts
              key={provider.subscriptionProviderId}
              client={client}
              disconnected={disconnected}
              provider={provider}
              onAccountsChanged={onAccountsChanged}
              onAccessDenied={onAccessDenied}
            />
          ))}
        </div>
      )}
    </section>
  );
}

/** Account list and slot controls for one subscription provider. */
function ProviderAccounts({
  client,
  disconnected,
  provider,
  onAccountsChanged,
  onAccessDenied,
}: {
  client: CoreClient;
  disconnected: boolean;
  provider: ConnectedAppProviderRow;
  onAccountsChanged: () => void;
  onAccessDenied: (providerId: SubscriptionProviderId, slot: string) => void;
}) {
  const [slotId, setSlotId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const headingId = `provider-${provider.subscriptionProviderId}`;
  const create = useMutation({
    mutationFn: () =>
      client.providerSubscriptions.createAccount(provider.subscriptionProviderId, {
        accountSlotId: slotId.trim(),
        ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
      }),
    onSuccess: () => {
      setSlotId('');
      setDisplayName('');
      onAccountsChanged();
    },
  });

  return (
    <section
      className="flex min-w-0 w-full flex-col gap-2"
      aria-label={provider.displayName}
      aria-labelledby={headingId}
    >
      <div className="flex min-w-0 w-full flex-wrap items-baseline justify-between gap-2">
        <h3 id={headingId} className="min-w-0 text-wrap text-sm font-bold text-fg-strong">
          {provider.displayName}
        </h3>
        <span className="text-xs text-fg-muted">
          {provider.accounts.length} account{provider.accounts.length === 1 ? '' : 's'}
        </span>
      </div>
      {provider.accounts.length === 0 ? (
        <p className="text-wrap text-xs text-fg-muted">No account slots configured.</p>
      ) : (
        <div className="flex min-w-0 w-full flex-col gap-3">
          {provider.accounts.map((account) => (
            <AccountControls
              key={account.identity}
              account={account}
              client={client}
              disconnected={disconnected}
              providerId={provider.subscriptionProviderId}
              onAccountsChanged={onAccountsChanged}
              onAccessDenied={onAccessDenied}
            />
          ))}
        </div>
      )}
      <details className="min-w-0 w-full">
        <summary className="cursor-pointer text-sm font-medium text-fg">Add account slot</summary>
        <div className="mt-3 flex min-w-0 w-full flex-col gap-3">
          <TextField
            className="min-w-0 w-full"
            label="Account slot id"
            value={slotId}
            onChange={setSlotId}
            isDisabled={disconnected || create.isPending}
          />
          <TextField
            className="min-w-0 w-full"
            label="Display name"
            value={displayName}
            onChange={setDisplayName}
            isDisabled={disconnected || create.isPending}
          />
          {create.isError ? (
            <ErrorBanner
              message={dependencyMessage(create.error, "Couldn't create that account slot.")}
              onRetry={() => create.mutate()}
            />
          ) : null}
          <div className="flex min-w-0 w-full flex-wrap justify-end gap-2">
            <Button
              size="sm"
              isDisabled={disconnected || create.isPending || !slotId.trim()}
              onPress={() => create.mutate()}
            >
              Create account slot
            </Button>
          </div>
        </div>
      </details>
    </section>
  );
}

/** Lifecycle controls for one provider-subscription account slot. */
function AccountControls({
  account,
  client,
  disconnected,
  providerId,
  onAccountsChanged,
  onAccessDenied,
  profile,
  affected = [],
}: {
  account: ConnectedAppRow;
  profile?: ProviderRegistryEntry;
  affected?: string[];
  client: CoreClient;
  disconnected: boolean;
  providerId: SubscriptionProviderId;
  onAccountsChanged: () => void;
  onAccessDenied: (providerId: SubscriptionProviderId, slot: string) => void;
}) {
  const queryClient = useQueryClient();
  const [displayName, setDisplayName] = useState(account.displayName);
  const [costsOpen, setCostsOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<ProviderSubscriptionAccount | undefined>(undefined);
  const statusKey = [
    ...settingsKeys.aiInterface,
    'status',
    providerId,
    account.accountSlotId,
  ] as const;
  const cachedStatus = queryClient.getQueryData<ProviderSubscriptionAccount>(statusKey);
  const overlay = overlayAccount(account, snapshot ?? cachedStatus);
  const shouldPoll = overlay.status === 'pending';
  const status = useQuery({
    queryKey: statusKey,
    queryFn: () => client.providerSubscriptions.getAccountStatus(providerId, account.accountSlotId),
    enabled: true,
    refetchInterval: shouldPoll ? STATUS_POLL_MS : false,
    gcTime: 0,
    retry: false,
  });
  const quotaKey = [...settingsKeys.aiInterface, 'quota', providerId, account.accountSlotId];
  const quotaRead = useQuery({
    queryKey: quotaKey,
    queryFn: () => readAccountQuota(client, providerId, account.accountSlotId),
    gcTime: 0,
    retry: false,
    enabled: false,
  });
  const quotaAccount = overlayConnectedAppQuota(
    [{ subscriptionProviderId: providerId, displayName: '', accounts: [account] }],
    quotaRead.isError || !quotaRead.data
      ? { subscriptionProviderId: providerId, accountSlotId: account.accountSlotId }
      : quotaRead.data
  )[0]!.accounts[0]!;
  const live = overlayAccount(quotaAccount, status.data ?? snapshot ?? cachedStatus);
  useEffect(() => {
    if (isAdminDenied(quotaRead.error)) onAccessDenied(providerId, account.accountSlotId);
  }, [quotaRead.error, onAccessDenied, providerId, account.accountSlotId]);
  const rejectedLogin =
    live.status === 'logged_in' && live.quotaAvailability === 'authentication_required';
  const statusLabel = rejectedLogin
    ? { label: 'Access rejected', tone: 'negative' as const }
    : live.status === 'logged_in' && live.quotaAvailability !== 'available'
      ? { label: 'Login saved', tone: 'neutral' as const }
      : providerSubscriptionAccountStatusLabel(live.status);

  useEffect(() => {
    if (!status.data) return;
    setSnapshot(status.data);
  }, [status.data]);

  useEffect(() => {
    if (account.updatedAt) {
      setSnapshot(undefined);
    }
  }, [account.updatedAt]);

  const previousStatus = useRef(live.status);
  useEffect(() => {
    if (previousStatus.current === 'pending' && live.status !== 'pending') onAccountsChanged();
    previousStatus.current = live.status;
  }, [live.status, onAccountsChanged]);

  const rename = useMutation({
    mutationFn: () =>
      client.providerSubscriptions.updateAccount(providerId, account.accountSlotId, {
        displayName: displayName.trim(),
      }),
    onSuccess: onAccountsChanged,
  });
  const remove = useMutation({
    mutationFn: () => client.providerSubscriptions.deleteAccount(providerId, account.accountSlotId),
    onSuccess: onAccountsChanged,
  });
  const login = useMutation({
    mutationFn: () =>
      client.providerSubscriptions.startAccountLogin(providerId, account.accountSlotId, {
        mode: 'device_code',
      }),
    onSuccess: (next) => {
      queryClient.setQueryData(statusKey, next);
      setSnapshot(next);
      onAccountsChanged();
    },
  });
  const cancel = useMutation({
    mutationFn: () =>
      client.providerSubscriptions.cancelAccountLogin(providerId, account.accountSlotId, {
        interactionId: live.interactionId as string,
      }),
    onSuccess: (next) => {
      setSnapshot(next);
      onAccountsChanged();
    },
  });
  const logout = useMutation({
    mutationFn: () => client.providerSubscriptions.logoutAccount(providerId, account.accountSlotId),
    onSuccess: (next) => {
      setSnapshot(next);
      onAccountsChanged();
    },
  });
  const quota = useMutation({
    mutationFn: async () => {
      const result = await quotaRead.refetch({ throwOnError: true });
      if (!result.data) throw new Error('Quota observation unavailable.');
      return result.data;
    },
    onError: (error) => {
      if (isAdminDenied(error)) onAccessDenied(providerId, account.accountSlotId);
    },
  });

  const autoTopup = useMutation({
    mutationFn: async () => {
      const result = await client.providerSubscriptions.getAccountAutoTopup(
        providerId,
        account.accountSlotId
      );
      if (
        result.subscriptionProviderId !== providerId ||
        result.accountSlotId !== account.accountSlotId
      ) {
        throw new Error('Provider subscription projection failed.');
      }
      return result;
    },
  });
  const rule =
    !autoTopup.isError && autoTopup.data?.availability === 'available' ? autoTopup.data : null;
  const refresh = () => {
    void status.refetch();
    quota.mutate();
    if (costsOpen) autoTopup.mutate();
  };

  return (
    <Card>
      <section className="flex min-w-0 w-full flex-col gap-3" aria-label={profile?.displayName}>
        {profile ? (
          <>
            <ProviderHeader profile={profile} />
            <p className="text-xs text-fg-muted">
              Affected logical models: {affected.join(', ') || 'None'}
            </p>
            <ProfileRemoval
              client={client}
              profile={profile}
              disconnected={disconnected}
              onChanged={onAccountsChanged}
            />
          </>
        ) : null}
        <div className="flex min-w-0 w-full flex-wrap items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <p className="text-wrap text-sm font-bold text-fg-strong">{live.displayName}</p>
            <p className="text-wrap text-xs text-fg-muted">
              {live.quotaPlanType ?? live.planLabel ?? 'Plan not reported'}
              {live.quotaBilling?.sharedAllowance === true ? ' · Shared allowance' : ''}
            </p>
          </div>
          <StatusChip tone={disconnected ? 'notice' : statusLabel.tone} dot>
            {disconnected ? `${statusLabel.label} · may be stale` : statusLabel.label}
          </StatusChip>
        </div>
        <QuotaStatus account={live} />
        {live.message ? <p className="text-wrap text-xs text-fg-muted">{live.message}</p> : null}
        {live.status === 'pending' && live.verificationUrl && live.userCode ? (
          <p className="min-w-0 w-full text-wrap text-xs text-fg">
            Open{' '}
            <a
              className="font-bold text-accent outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus"
              href={live.verificationUrl}
              rel="noreferrer"
              target="_blank"
            >
              {live.verificationUrl}
            </a>{' '}
            and enter <code>{live.userCode}</code>
          </p>
        ) : null}
        {quotaRead.isError && !quota.isError ? (
          <ErrorBanner
            message={dependencyMessage(quotaRead.error, 'account quota')}
            onRetry={() => void quotaRead.refetch()}
          />
        ) : null}
        {login.isError ? (
          <ErrorBanner
            message={dependencyMessage(login.error, "Couldn't start login.")}
            onRetry={() => login.mutate()}
          />
        ) : null}
        {cancel.isError ? (
          <ErrorBanner
            message={dependencyMessage(cancel.error, "Couldn't cancel login.")}
            onRetry={() => cancel.mutate()}
          />
        ) : null}
        {quota.isError ? (
          <ErrorBanner
            message={dependencyMessage(quota.error, "Couldn't refresh quota.")}
            onRetry={refresh}
          />
        ) : null}
        {status.isError ? (
          <ErrorBanner
            message={dependencyMessage(status.error, "Couldn't refresh login status.")}
            onRetry={() => void status.refetch()}
          />
        ) : null}
        <div className="flex min-w-0 w-full flex-wrap gap-2">
          <Button size="sm" isDisabled={disconnected || quota.isPending} onPress={refresh}>
            Refresh quota
          </Button>
          {live.status === 'pending' ? (
            <Button
              size="sm"
              variant="outline"
              isDisabled={disconnected || cancel.isPending || !live.interactionId}
              onPress={() => cancel.mutate()}
            >
              Cancel login
            </Button>
          ) : rejectedLogin ||
            live.status === 'logged_out' ||
            live.status === 'error' ||
            live.status === 'unavailable' ? (
            <Button
              size="sm"
              isDisabled={disconnected || login.isPending}
              onPress={() => login.mutate()}
            >
              {rejectedLogin ? 'Sign in again' : 'Start login'}
            </Button>
          ) : null}
        </div>
        {providerId === 'xai' ? (
          <details
            className="min-w-0 w-full border-t border-border pt-3"
            onToggle={(event) => {
              const open = event.currentTarget.open;
              setCostsOpen(open);
              if (
                open &&
                !autoTopup.data &&
                !autoTopup.isPending &&
                !autoTopup.isError &&
                !disconnected
              )
                autoTopup.mutate();
            }}
          >
            <summary className="cursor-pointer text-sm font-medium text-fg">
              Balance and costs
            </summary>
            <div className="mt-3 flex min-w-0 w-full flex-col gap-2">
              <BillingAmount label="Prepaid" cents={live.quotaBilling?.prepaidBalanceCents} />
              <BillingAmount label="Extra spend" cents={live.quotaBilling?.onDemandUsedCents} />
              <BillingAmount label="Spend cap" cents={live.quotaBilling?.onDemandCapCents} />
              {autoTopup.isPending ? (
                <p className="text-xs text-fg-muted">Checking auto top-up…</p>
              ) : autoTopup.isError ||
                autoTopup.data?.availability === 'temporarily_unavailable' ? (
                <ErrorBanner
                  message={
                    isAdminDenied(autoTopup.error)
                      ? dependencyMessage(autoTopup.error, 'auto top-up')
                      : 'Auto top-up query failed.'
                  }
                  onRetry={() => autoTopup.mutate()}
                />
              ) : (
                <>
                  <p className="text-xs text-fg">
                    Auto top-up{' '}
                    {rule?.enabled === true
                      ? 'enabled'
                      : rule?.enabled === false
                        ? 'disabled'
                        : 'not reported'}
                  </p>
                  {rule?.thresholdCents !== undefined ? (
                    <BillingAmount label="Top-up threshold" cents={rule.thresholdCents} />
                  ) : null}
                  {rule?.amountCents !== undefined ? (
                    <BillingAmount label="Top-up amount" cents={rule.amountCents} />
                  ) : null}
                  {rule?.monthlyCapCents !== undefined ? (
                    <BillingAmount label="Monthly top-up cap" cents={rule.monthlyCapCents} />
                  ) : null}
                </>
              )}
              {autoTopup.data && !autoTopup.isError ? (
                <QuotaInstant label="Auto top-up checked" value={autoTopup.data.observedAt} />
              ) : null}
            </div>
          </details>
        ) : null}
        <details className="min-w-0 w-full border-t border-border pt-3">
          <summary className="cursor-pointer text-sm font-medium text-fg">Account settings</summary>
          <div className="mt-3 flex min-w-0 w-full flex-col gap-3">
            <p className="text-wrap text-xs text-fg-muted">
              Slot {live.accountSlotId} · {live.boundProviderCount} provider bindings
            </p>
            {live.accountLabel ? (
              <p className="text-wrap text-xs text-fg-muted">{live.accountLabel}</p>
            ) : null}
            {live.quotaSubscriptionActive !== null ? (
              <p className="text-xs text-fg-muted">
                Build subscription eligibility:{' '}
                {live.quotaSubscriptionActive ? 'eligible' : 'not eligible'}
              </p>
            ) : null}
            {live.quotaAccountObservedAt ? (
              <QuotaInstant label="Account checked" value={live.quotaAccountObservedAt} />
            ) : null}
            <TextField
              className="min-w-0 w-full"
              label="Account display name"
              value={displayName}
              onChange={setDisplayName}
              isDisabled={disconnected}
            />
            {rename.isError ? (
              <ErrorBanner
                message={dependencyMessage(rename.error, "Couldn't rename this account.")}
                onRetry={() => rename.mutate()}
              />
            ) : null}
            {remove.isError ? (
              <ErrorBanner
                message={dependencyMessage(remove.error, "Couldn't delete this account.")}
                onRetry={() => remove.mutate()}
              />
            ) : null}
            {logout.isError ? (
              <ErrorBanner
                message={dependencyMessage(logout.error, "Couldn't log out this account.")}
                onRetry={() => logout.mutate()}
              />
            ) : null}
            <div className="flex min-w-0 w-full flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                isDisabled={disconnected || rename.isPending || !displayName.trim()}
                onPress={() => rename.mutate()}
              >
                Rename account
              </Button>
              <Button
                size="sm"
                variant="outline"
                isDisabled={disconnected || logout.isPending}
                onPress={() => logout.mutate()}
              >
                Log out
              </Button>
              <Button
                size="sm"
                variant="negative-outline"
                isDisabled={disconnected || remove.isPending}
                onPress={() => {
                  if (!window.confirm('Delete this account slot?')) return;
                  remove.mutate();
                }}
              >
                Remove account
              </Button>
            </div>
          </div>
        </details>
      </section>
    </Card>
  );
}

/** Formats observed USD cents; absent amounts remain unknown, including a missing cap. */
function BillingAmount({ label, cents }: { label: string; cents: number | null | undefined }) {
  return (
    <p className="text-wrap text-xs text-fg">
      {label}{' '}
      {cents == null
        ? 'not reported'
        : new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(
            cents / 100
          )}
    </p>
  );
}

/** Merges a polled account snapshot onto the safe list row without dropping quota. */
function overlayAccount(
  account: ConnectedAppRow,
  snapshot: ProviderSubscriptionAccount | undefined
): ConnectedAppRow {
  if (!snapshot) return account;
  const interaction = snapshot.status === 'pending' ? snapshot.interaction : undefined;
  return {
    ...account,
    displayName: snapshot.displayName
      ? (projectSafeValue(snapshot.displayName) as string)
      : account.displayName,
    status: snapshot.status,
    accountLabel: snapshot.accountLabel
      ? (projectSafeValue(snapshot.accountLabel) as string)
      : account.accountLabel,
    planLabel: snapshot.planLabel
      ? (projectSafeValue(snapshot.planLabel) as string)
      : account.planLabel,
    boundProviderCount: snapshot.boundProviderIds.length,
    verificationUrl: interaction?.verificationUrl
      ? (projectSafeValue(interaction.verificationUrl) as string)
      : null,
    userCode: interaction?.userCode ? (projectSafeValue(interaction.userCode) as string) : null,
    interactionId: interaction?.interactionId ?? null,
    message:
      snapshot.status === 'unavailable' || snapshot.status === 'error'
        ? (projectSafeValue(snapshot.message) as string)
        : null,
    updatedAt: snapshot.updatedAt,
  };
}

/** Labels Codex windows by exact reported duration, falling back to stable window ids. */
function subscriptionQuotaWindowLabel(window: ConnectedAppQuotaWindow): string {
  const seconds = window.limitWindowSeconds;
  if ((window.id === 'primary' || window.id === 'secondary') && seconds !== undefined) {
    if (seconds === 604_800) return 'Weekly';
    if (seconds % 86_400 === 0) return `${seconds / 86_400}-day`;
    if (seconds % 3_600 === 0) return `${seconds / 3_600}-hour`;
    if (seconds % 60 === 0) return `${seconds / 60}-minute`;
    return `${seconds}-second`;
  }
  switch (window.id) {
    case 'primary':
      return 'Primary';
    case 'secondary':
      return 'Secondary';
    case 'included':
      return 'Included';
    default:
      return window.id;
  }
}

/** Renders a browser-local instant, or an explicit unknown label when missing or invalid. */
function QuotaInstant({ label, value }: { label: string; value: string | null }) {
  const parsed = value ? Date.parse(value) : Number.NaN;
  if (!value || !Number.isFinite(parsed)) {
    return <p className="text-wrap text-xs text-fg-muted">{label} unknown</p>;
  }
  return (
    <p className="text-wrap text-xs text-fg-muted">
      {label}{' '}
      <time
        dateTime={value}
        title={`${new Date(value).toLocaleString(undefined, { timeZoneName: 'long' })} (${Intl.DateTimeFormat().resolvedOptions().timeZone}) · ${value}`}
      >
        {new Date(value).toLocaleString(undefined, { timeZoneName: 'short' })}
      </time>
    </p>
  );
}

/** Formats a quota percent without rounding positive tiny values to 0% or near-full values to 100%. */
function formatQuotaPercent(value: number): string {
  if (value > 0 && value < 0.01) {
    return '<0.01%';
  }
  if (value < 100 && value > 99.99) {
    return '>99.99%';
  }
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value)}%`;
}

/** Renders one quota window with remaining as the prominent labeled meter. */
function QuotaWindow({ window }: { window: ConnectedAppQuotaWindow }) {
  const label = subscriptionQuotaWindowLabel(window);
  const remaining =
    window.remainingPercent === null ? null : formatQuotaPercent(window.remainingPercent);
  return (
    <li className="min-w-0 w-full text-wrap">
      {remaining !== null && window.remainingPercent !== null ? (
        <>
          <p className="text-sm font-bold text-fg-strong">
            {label} {remaining} remaining
          </p>
          <meter
            className="h-2 w-full min-w-0"
            min={0}
            max={100}
            value={window.remainingPercent}
            aria-label={`${label} remaining ${remaining}`}
          />
        </>
      ) : (
        <>
          <p className="text-sm font-bold text-fg-strong">{label}</p>
          {window.usedPercent === null ? (
            <p className="text-xs text-fg-muted">Provider did not report usage</p>
          ) : null}
        </>
      )}
      {remaining === null && window.usedPercent !== null ? (
        <p className="text-xs text-fg-muted">{formatQuotaPercent(window.usedPercent)} used</p>
      ) : null}
      {window.periodType ? (
        <p className="text-xs text-fg-muted">
          {window.periodType === 'weekly' ? 'Weekly' : 'Monthly'}
        </p>
      ) : null}
      {window.startsAt ? <QuotaInstant label="Period starts" value={window.startsAt} /> : null}
      <QuotaInstant label="Resets" value={window.resetsAt} />
    </li>
  );
}

/** Renders the bounded quota posture for one provider-subscription account. */
function QuotaStatus({ account }: { account: ConnectedAppRow }) {
  if (account.quotaAvailability === null) {
    return <p className="text-wrap text-xs text-fg-muted">Quota query failed</p>;
  }
  const lastChecked = <QuotaInstant label="Last checked" value={account.quotaObservedAt} />;
  if (account.quotaAvailability === 'authentication_required') {
    return (
      <div className="flex min-w-0 w-full flex-col gap-1">
        <p className="text-wrap text-xs text-fg-muted">
          Saved access was rejected; the login may still be refreshable.
        </p>
        {lastChecked}
      </div>
    );
  }
  if (account.quotaAvailability === 'temporarily_unavailable') {
    return (
      <div className="flex min-w-0 w-full flex-col gap-1">
        <p className="text-wrap text-xs text-fg-muted">Quota query failed</p>
        {account.quotaRetryAfter ? (
          <QuotaInstant label="Retry after" value={account.quotaRetryAfter} />
        ) : null}
        {lastChecked}
      </div>
    );
  }
  return (
    <div className="flex min-w-0 w-full flex-col gap-1">
      {account.quotaWindows.length === 0 ? (
        <p className="text-wrap text-xs text-fg-muted">Provider did not report usage</p>
      ) : (
        <ul className="flex min-w-0 w-full flex-col gap-2">
          {account.quotaWindows.map((window) => (
            <QuotaWindow key={window.id} window={window} />
          ))}
        </ul>
      )}
      {lastChecked}
    </div>
  );
}

/** Composes each active profile with its exact account slot; unbound retained slots stay separately reachable. */
function ProviderProfiles({
  client,
  disconnected,
  profiles,
  diagnostics,
  accounts,
  gateway,
  onProfilesChanged,
  onAccountsChanged,
  onAccessDenied,
}: {
  client: CoreClient;
  disconnected: boolean;
  profiles: ProviderRegistryEntry[];
  diagnostics: ProviderDiagnostic[];
  accounts: ConnectedAppProviderRow[];
  gateway: GatewayDiagnostics | null;
  onProfilesChanged: () => void;
  onAccountsChanged: () => void;
  onAccessDenied: (providerId: SubscriptionProviderId, slot: string) => void;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-3" aria-labelledby="gateway-providers">
      <h2
        id="gateway-providers"
        className="text-eyebrow font-bold uppercase tracking-eyebrow text-fg-muted"
      >
        Providers
      </h2>
      <p className="text-xs text-fg-muted">
        Active server state. Provider registry changes require restart.
      </p>
      {profiles.length === 0 ? (
        <EmptyState
          icon="connect"
          title="No provider profiles"
          hint="Add a Provider or edit authored configuration."
        />
      ) : (
        profiles.map((profile) => {
          const pair = profile.subscriptionAccount;
          const account = accounts
            .find((provider) => provider.subscriptionProviderId === pair?.subscriptionProviderId)
            ?.accounts.find((slot) => slot.accountSlotId === pair?.accountSlotId);
          const affected = affectedLogicalModels(
            gateway,
            profiles
              .filter((candidate) =>
                pair
                  ? candidate.subscriptionAccount?.subscriptionProviderId ===
                      pair.subscriptionProviderId &&
                    candidate.subscriptionAccount.accountSlotId === pair.accountSlotId
                  : candidate.id === profile.id
              )
              .map((candidate) => candidate.id)
          );
          return pair && account ? (
            <AccountControls
              key={profile.id}
              profile={profile}
              affected={affected}
              account={account}
              providerId={pair.subscriptionProviderId}
              client={client}
              disconnected={disconnected}
              onAccountsChanged={onAccountsChanged}
              onAccessDenied={onAccessDenied}
            />
          ) : pair ? (
            <Card key={profile.id}>
              <section aria-label={profile.displayName} className="flex flex-col gap-3">
                <ProviderHeader profile={profile} />
                <p className="text-xs text-fg-muted">
                  Account slot {pair.subscriptionProviderId} / {pair.accountSlotId} is missing or
                  unavailable.
                </p>
                <Button variant="outline" onPress={onAccountsChanged}>
                  Retry account slots
                </Button>
                <p className="text-xs text-fg-muted">
                  Affected logical models: {affected.join(', ') || 'None'}
                </p>
                <ProfileRemoval
                  client={client}
                  profile={profile}
                  disconnected={disconnected}
                  onChanged={onProfilesChanged}
                />
              </section>
            </Card>
          ) : (
            <KeyProviderCard
              key={profile.id}
              client={client}
              profile={profile}
              affected={affected}
              disconnected={disconnected}
              onChanged={onProfilesChanged}
            />
          );
        })
      )}
      {diagnostics.length > 0 ? (
        <Card aria-label="Provider diagnostics" className="flex flex-col gap-2">
          <h3 className="text-sm font-bold text-fg-strong">Provider diagnostics</h3>
          {diagnostics.map((diagnostic) => (
            <p
              key={`${diagnostic.source}:${diagnostic.profileId}:${diagnostic.code}`}
              className="text-xs text-fg-muted"
            >
              {diagnostic.status} · {diagnostic.code} · {diagnostic.message}
            </p>
          ))}
        </Card>
      ) : null}
      <details>
        <summary className="cursor-pointer text-sm text-fg">
          Add a Provider profile manually
        </summary>
        <ProviderProfileForm
          client={client}
          disconnected={disconnected}
          accounts={accounts}
          onCreated={onProfilesChanged}
        />
      </details>
    </section>
  );
}

/** Labels typed denial without displaying private error payloads; every caller supplies its own retry. */
export function dependencyMessage(error: unknown, dependency: string): string {
  return isAdminDenied(error)
    ? `Access denied: ${dependency}. Retry with deployment-admin authority.`
    : dependency.startsWith("Couldn't")
      ? dependency
      : `Couldn't load ${dependency}.`;
}

/** Creates one provider profile document through runtime-config createFile. */
function ProviderProfileForm({
  client,
  disconnected,
  accounts,
  onCreated,
}: {
  client: CoreClient;
  disconnected: boolean;
  accounts: ConnectedAppProviderRow[];
  onCreated: () => void;
}) {
  const [id, setId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [kind, setKind] = useState<(typeof PROVIDER_KINDS)[number]>('custom');
  const [vendor, setVendor] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [models, setModels] = useState('');
  const [defaultModel, setDefaultModel] = useState('');
  const [oauthAccountKey, setOauthAccountKey] = useState<string | null>(null);
  const providerIdValid = ProviderApiKeyProfileIdSchema.safeParse(id.trim()).success;
  const oauthSlots = accounts.flatMap((provider) =>
    provider.accounts.map((account) => ({
      id: `${provider.subscriptionProviderId}:${account.accountSlotId}`,
      label: `${provider.displayName} · ${account.accountSlotId}`,
      subscriptionProviderId: provider.subscriptionProviderId,
      accountSlotId: account.accountSlotId,
    }))
  );
  const create = useMutation({
    mutationFn: async () => {
      const modelList = models
        .split(/[,\n]/)
        .map((model) => model.trim())
        .filter(Boolean);
      const profile: Record<string, unknown> = {
        id: id.trim(),
        displayName: displayName.trim(),
        kind,
        models: modelList,
        defaultModel: defaultModel.trim(),
      };
      if (kind === 'oauth') {
        const selected = oauthSlots.find((slot) => slot.id === oauthAccountKey);
        if (!selected) {
          throw new Error('Select an existing subscription account slot.');
        }
        profile.vendor = OAUTH_VENDORS[selected.subscriptionProviderId];
        profile.extensions = {
          openkit: {
            subscriptionAccount: { accountSlotId: selected.accountSlotId },
          },
        };
      } else {
        if (vendor.trim()) profile.vendor = vendor.trim();
        if (baseUrl.trim()) profile.baseUrl = baseUrl.trim();
        if (kind === 'direct' || kind === 'gateway' || kind === 'custom') {
          profile.secretRef = `vault://provider_${id.trim()}`;
        }
      }
      const content = `${JSON.stringify(profile, null, 2)}\n`;
      return client.runtimeConfig.createFile({
        id: `providers/${id.trim()}.provider.jsonc`,
        kind: 'provider',
        content,
      });
    },
    onSuccess: () => {
      setId('');
      setDisplayName('');
      setVendor('');
      setBaseUrl('');
      setModels('');
      setDefaultModel('');
      setOauthAccountKey(null);
      onCreated();
    },
  });

  return (
    <Card className="flex flex-col gap-3">
      <h3 className="text-sm font-bold text-fg-strong">New provider profile</h3>
      <TextField
        label="Provider id"
        value={id}
        onChange={setId}
        isDisabled={disconnected}
        isInvalid={id.length > 0 && !providerIdValid}
        description="Use 1–119 letters, numbers, underscores, or hyphens; secret-shaped prefixes are not allowed."
      />
      <TextField
        label="Provider display name"
        value={displayName}
        onChange={setDisplayName}
        isDisabled={disconnected}
      />
      <Select
        label="Provider kind"
        items={PROVIDER_KINDS.map((item) => ({ id: item, label: item }))}
        selectedKey={kind}
        onSelectionChange={(key) => {
          if (
            typeof key === 'string' &&
            PROVIDER_KINDS.includes(key as (typeof PROVIDER_KINDS)[number])
          ) {
            setKind(key as (typeof PROVIDER_KINDS)[number]);
          }
        }}
        isDisabled={disconnected}
      />
      {kind === 'oauth' ? (
        <Select
          label="Subscription account"
          items={oauthSlots.map((slot) => ({ id: slot.id, label: slot.label }))}
          selectedKey={oauthAccountKey}
          onSelectionChange={(key) => {
            if (typeof key === 'string') setOauthAccountKey(key);
          }}
          isDisabled={disconnected || oauthSlots.length === 0}
        />
      ) : (
        <>
          <TextField label="Vendor" value={vendor} onChange={setVendor} isDisabled={disconnected} />
          <TextField
            label="Base URL"
            value={baseUrl}
            onChange={setBaseUrl}
            isDisabled={disconnected}
          />
        </>
      )}
      <TextField
        label="Provider models"
        value={models}
        onChange={setModels}
        isDisabled={disconnected}
      />
      <TextField
        label="Default model"
        value={defaultModel}
        onChange={setDefaultModel}
        isDisabled={disconnected}
      />
      {create.isError ? (
        <ErrorBanner
          message={dependencyMessage(create.error, "Couldn't create that provider profile.")}
          onRetry={() => create.mutate()}
        />
      ) : null}
      {create.isSuccess ? (
        <p role="status" className="text-xs text-fg-muted">
          Provider persisted revision: {create.data?.file.revision}. Provider activation: restart
          required; apply saved configuration to inspect the reload plan.
        </p>
      ) : null}
      <div className="flex justify-end">
        <Button
          size="sm"
          isDisabled={
            disconnected ||
            create.isPending ||
            !providerIdValid ||
            !displayName.trim() ||
            !models.trim() ||
            !defaultModel.trim() ||
            (kind === 'oauth' && !oauthAccountKey)
          }
          onPress={() => create.mutate()}
        >
          Create provider profile
        </Button>
      </div>
    </Card>
  );
}

/** Keeps quota cache identity exact before any card consumes the typed observation. */
async function readAccountQuota(
  client: CoreClient,
  providerId: SubscriptionProviderId,
  slot: string
) {
  const result = await client.providerSubscriptions.getAccountQuota(providerId, slot);
  if (result.subscriptionProviderId !== providerId || result.accountSlotId !== slot)
    throw new Error('Provider subscription projection failed.');
  return result;
}
