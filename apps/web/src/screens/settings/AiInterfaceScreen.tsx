import { ProviderApiKeyProfileIdSchema } from '@openkit/app-api-schemas';
import { ApiCallError, type CoreClient } from '@openkit/core-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { useConnection, useCoreClient } from '../../app/core-client';
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
  StatusChip,
  TextField,
} from '../../primitives';
import {
  type ConnectedAppProviderRow,
  type ConnectedAppRow,
  projectConnectedApps,
  settingsKeys,
} from './data';
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
 * AI interface settings — published deployment-admin provider, account, and default workflow.
 *
 * Uses the signed-in session client. Derived server-admin authority is required.
 * Web never asks for a bearer token. Honors §9.13.
 */
export function AiInterfaceScreen() {
  const client = useCoreClient();
  const queryClient = useQueryClient();
  const { failed: disconnected } = useConnection();
  const accountsKey = [...settingsKeys.aiInterface, 'accounts'] as const;
  const diagnosticsKey = [...settingsKeys.aiInterface, 'diagnostics'] as const;

  const accounts = useQuery({
    queryKey: accountsKey,
    queryFn: async () => {
      const inventory = await client.providerSubscriptions.listProviders();
      return Promise.all(
        inventory.providers.map(async (provider) => {
          const listed = await client.providerSubscriptions.listAccounts(
            provider.subscriptionProviderId
          );
          const quotas = await Promise.all(
            listed.accounts.map((account) =>
              client.providerSubscriptions.getAccountQuota(
                provider.subscriptionProviderId,
                account.accountSlotId
              )
            )
          );
          return projectConnectedApps(provider, listed, quotas);
        })
      );
    },
    gcTime: 0,
    retry: false,
  });

  const diagnostics = useQuery({
    queryKey: diagnosticsKey,
    queryFn: async () =>
      projectSafeValue(await client.app.getDiagnostics()) as Awaited<
        ReturnType<CoreClient['app']['getDiagnostics']>
      >,
    enabled: accounts.isSuccess,
    gcTime: 0,
    retry: false,
  });

  function retry() {
    queryClient.removeQueries({
      queryKey: [...settingsKeys.aiInterface, 'status'],
    });
    void accounts.refetch();
    void diagnostics.refetch();
  }

  const adminDenied = isAdminDenied(accounts.error);
  const onAccountsChanged = useCallback(() => {
    queryClient.removeQueries({
      queryKey: [...settingsKeys.aiInterface, 'status'],
    });
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
        title="AI interface"
        subtitle="Manage subscription accounts, provider profiles, API keys, and the core and gateway default models for this deployment."
        actions={
          <Button
            size="sm"
            variant="outline"
            isDisabled={disconnected || accounts.isFetching || adminDenied}
            onPress={retry}
          >
            Refresh status
          </Button>
        }
      />

      {accounts.isLoading ? (
        <Skeleton lines={6} />
      ) : accounts.isError && adminDenied ? (
        <EmptyState
          icon="key"
          title="Access denied"
          hint="AI interface requires derived server-admin authority on the signed-in session."
          action={
            <Button variant="outline" onPress={() => void accounts.refetch()}>
              Retry
            </Button>
          }
        />
      ) : accounts.isError ? (
        <ErrorBanner
          message="Couldn't load AI interface."
          onRetry={() => void accounts.refetch()}
        />
      ) : (
        <>
          <SubscriptionAccounts
            client={client}
            disconnected={disconnected}
            providers={accounts.data ?? []}
            onAccountsChanged={onAccountsChanged}
          />
          {diagnostics.isError ? (
            <ErrorBanner
              message="Couldn't load provider profiles."
              onRetry={() => void diagnostics.refetch()}
            />
          ) : diagnostics.isLoading ? (
            <Skeleton lines={4} />
          ) : (
            <ProviderProfiles
              client={client}
              disconnected={disconnected}
              profiles={diagnostics.data?.providers.registry ?? []}
              diagnostics={diagnostics.data?.providers.diagnostics ?? []}
              accounts={accounts.data ?? []}
              gateway={diagnostics.data?.gateway ?? null}
              onProfilesChanged={onProfilesChanged}
            />
          )}
        </>
      )}
    </Page>
  );
}

/** Subscription-account lifecycle for the fixed Codex and xAI providers. */
function SubscriptionAccounts({
  client,
  disconnected,
  providers,
  onAccountsChanged,
}: {
  client: CoreClient;
  disconnected: boolean;
  providers: ConnectedAppProviderRow[];
  onAccountsChanged: () => void;
}) {
  return (
    <section className="flex flex-col gap-3" aria-labelledby="ai-connected-apps">
      <div className="flex items-baseline gap-2">
        <h2
          id="ai-connected-apps"
          className="text-eyebrow font-bold uppercase tracking-eyebrow text-fg-muted"
        >
          Subscription accounts
        </h2>
        <span className="text-xs text-fg-muted">OpenAI Codex and xAI device-code login</span>
      </div>
      {providers.length === 0 ? (
        <EmptyState
          icon="connect"
          title="No subscription providers"
          hint="Supported subscription providers appear here once inventory loads."
        />
      ) : (
        <div className="flex flex-col gap-4">
          {providers.map((provider) => (
            <ProviderAccounts
              key={provider.subscriptionProviderId}
              client={client}
              disconnected={disconnected}
              provider={provider}
              onAccountsChanged={onAccountsChanged}
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
}: {
  client: CoreClient;
  disconnected: boolean;
  provider: ConnectedAppProviderRow;
  onAccountsChanged: () => void;
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
      className="flex flex-col gap-2"
      aria-label={provider.displayName}
      aria-labelledby={headingId}
    >
      <div className="flex items-baseline justify-between gap-2">
        <h3 id={headingId} className="text-sm font-bold text-fg-strong">
          {provider.displayName}
        </h3>
        <span className="text-xs text-fg-muted">
          {provider.accounts.length} account{provider.accounts.length === 1 ? '' : 's'}
        </span>
      </div>
      {provider.accounts.length === 0 ? (
        <Card>
          <p className="text-xs text-fg-muted">No account slots configured.</p>
        </Card>
      ) : (
        <Card className="flex flex-col gap-3 p-4">
          {provider.accounts.map((account) => (
            <AccountControls
              key={account.identity}
              account={account}
              client={client}
              disconnected={disconnected}
              providerId={provider.subscriptionProviderId}
              onAccountsChanged={onAccountsChanged}
            />
          ))}
        </Card>
      )}
      <Card className="flex flex-col gap-3">
        <TextField
          label="Account slot id"
          value={slotId}
          onChange={setSlotId}
          isDisabled={disconnected || create.isPending}
        />
        <TextField
          label="Display name"
          value={displayName}
          onChange={setDisplayName}
          isDisabled={disconnected || create.isPending}
        />
        {create.isError ? (
          <ErrorBanner
            message="Couldn't create that account slot."
            onRetry={() => create.mutate()}
          />
        ) : null}
        <div className="flex justify-end">
          <Button
            size="sm"
            isDisabled={disconnected || create.isPending || !slotId.trim()}
            onPress={() => create.mutate()}
          >
            Create account slot
          </Button>
        </div>
      </Card>
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
}: {
  account: ConnectedAppRow;
  client: CoreClient;
  disconnected: boolean;
  providerId: SubscriptionProviderId;
  onAccountsChanged: () => void;
}) {
  const queryClient = useQueryClient();
  const [displayName, setDisplayName] = useState(account.displayName);
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
    enabled: shouldPoll,
    refetchInterval: shouldPoll ? STATUS_POLL_MS : false,
    gcTime: 0,
    retry: false,
  });
  const live = overlayAccount(account, status.data ?? snapshot ?? cachedStatus);
  const statusLabel = providerSubscriptionAccountStatusLabel(live.status);

  useEffect(() => {
    if (!status.data) return;
    setSnapshot(status.data);
  }, [status.data]);

  useEffect(() => {
    if (account.updatedAt) {
      setSnapshot(undefined);
    }
  }, [account.updatedAt]);

  useEffect(() => {
    if (status.data && status.data.status !== 'pending') {
      onAccountsChanged();
    }
  }, [onAccountsChanged, status.data]);

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
    mutationFn: () =>
      client.providerSubscriptions.getAccountQuota(providerId, account.accountSlotId),
    onSuccess: onAccountsChanged,
  });

  return (
    <ListRow>
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="truncate text-sm font-bold text-fg-strong">{live.displayName}</p>
          <p className="text-xs text-fg-muted">
            {live.accountLabel ?? `Slot ${live.accountSlotId}`}
            {live.planLabel ? ` · ${live.planLabel}` : ''}
            {live.boundProviderCount > 0
              ? ` · ${live.boundProviderCount} provider binding${live.boundProviderCount === 1 ? '' : 's'}`
              : ''}
          </p>
          <QuotaStatus account={live} />
          {live.message ? <p className="text-xs text-fg-muted">{live.message}</p> : null}
          {live.status === 'pending' && live.verificationUrl && live.userCode ? (
            <p className="text-xs text-fg">
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
        </div>
        <TextField
          label="Account display name"
          value={displayName}
          onChange={setDisplayName}
          isDisabled={disconnected}
        />
        {rename.isError ? (
          <ErrorBanner message="Couldn't rename this account." onRetry={() => rename.mutate()} />
        ) : null}
        {remove.isError ? (
          <ErrorBanner message="Couldn't delete this account." onRetry={() => remove.mutate()} />
        ) : null}
        {login.isError ? (
          <ErrorBanner message="Couldn't start login." onRetry={() => login.mutate()} />
        ) : null}
        {cancel.isError ? (
          <ErrorBanner message="Couldn't cancel login." onRetry={() => cancel.mutate()} />
        ) : null}
        {logout.isError ? (
          <ErrorBanner message="Couldn't log out this account." onRetry={() => logout.mutate()} />
        ) : null}
        {quota.isError ? (
          <ErrorBanner message="Couldn't refresh quota." onRetry={() => quota.mutate()} />
        ) : null}
        {status.isError ? (
          <ErrorBanner
            message="Couldn't refresh login status."
            onRetry={() => void status.refetch()}
          />
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            isDisabled={disconnected || rename.isPending || !displayName.trim()}
            onPress={() => rename.mutate()}
          >
            Rename account
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
          ) : live.status === 'logged_out' ||
            live.status === 'error' ||
            live.status === 'unavailable' ? (
            <Button
              size="sm"
              isDisabled={disconnected || login.isPending}
              onPress={() => login.mutate()}
            >
              Start login
            </Button>
          ) : null}
          {live.status === 'logged_in' ||
          live.status === 'error' ||
          live.status === 'unavailable' ? (
            <Button
              size="sm"
              variant="outline"
              isDisabled={disconnected || logout.isPending}
              onPress={() => logout.mutate()}
            >
              Log out
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            isDisabled={disconnected || quota.isPending}
            onPress={() => quota.mutate()}
          >
            Refresh quota
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
            Delete account
          </Button>
        </div>
      </div>
      <StatusChip tone={disconnected ? 'notice' : statusLabel.tone} dot>
        {disconnected ? `${statusLabel.label} · may be stale` : statusLabel.label}
      </StatusChip>
    </ListRow>
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
    displayName: snapshot.displayName ?? account.displayName,
    status: snapshot.status,
    accountLabel: snapshot.accountLabel ?? account.accountLabel,
    planLabel: snapshot.planLabel ?? account.planLabel,
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

/** Renders the bounded quota posture for one provider-subscription account. */
function QuotaStatus({ account }: { account: ConnectedAppRow }) {
  if (account.quotaAvailability === 'unsupported') {
    return <p className="text-xs text-fg-muted">Quota unsupported</p>;
  }
  if (account.quotaAvailability === 'temporarily_unavailable') {
    return <p className="text-xs text-fg-muted">Quota temporarily unavailable</p>;
  }
  return (
    <div className="flex flex-wrap gap-2 text-xs text-fg-muted">
      {account.quotaRemainingPercents.length === 0 ? (
        <span>Quota available</span>
      ) : (
        <span>
          {account.quotaRemainingPercents.map((percent) => `${percent}% remaining`).join(' · ')}
        </span>
      )}
    </div>
  );
}

/** Configured Provider profiles, logical Gateway catalog, profile creation, and API-key controls. */
function ProviderProfiles({
  client,
  disconnected,
  profiles,
  diagnostics,
  accounts,
  gateway,
  onProfilesChanged,
}: {
  client: CoreClient;
  disconnected: boolean;
  profiles: ProviderRegistryEntry[];
  diagnostics: ProviderDiagnostic[];
  accounts: ConnectedAppProviderRow[];
  gateway: GatewayDiagnostics | null;
  onProfilesChanged: () => void;
}) {
  const [apiKey, setApiKey] = useState('');
  const [apiKeyProviderId, setApiKeyProviderId] = useState<string | null>(null);
  const apiKeyProfiles = profiles.filter(
    (profile) =>
      profile.kind === 'direct' || profile.kind === 'gateway' || profile.kind === 'custom'
  );
  const apiKeyProfile = apiKeyProfiles.find((profile) => profile.id === apiKeyProviderId) ?? null;
  useEffect(() => {
    setApiKeyProviderId((current) => {
      const eligible = profiles.filter(
        (profile) =>
          profile.kind === 'direct' || profile.kind === 'gateway' || profile.kind === 'custom'
      );
      if (current && eligible.some((profile) => profile.id === current)) {
        return current;
      }
      return eligible[0]?.id ?? null;
    });
  }, [profiles]);
  const saveKey = useMutation({
    mutationFn: () => {
      if (!apiKeyProfile) {
        throw new Error('Select an API-key provider profile.');
      }
      return client.app.setProviderApiKey(apiKeyProfile.id, { apiKey });
    },
    onSuccess: () => {
      setApiKey('');
      onProfilesChanged();
    },
  });

  return (
    <section className="flex flex-col gap-3" aria-labelledby="ai-provider-profiles">
      <div className="flex items-baseline gap-2">
        <h2
          id="ai-provider-profiles"
          className="text-eyebrow font-bold uppercase tracking-eyebrow text-fg-muted"
        >
          Provider profiles
        </h2>
        <span className="text-xs text-fg-muted">Models, defaults, and API keys</span>
      </div>
      {profiles.length === 0 ? (
        <EmptyState
          icon="connect"
          title="No provider profiles"
          hint="Create a provider profile to choose a core default model."
        />
      ) : (
        <Card className="flex flex-col gap-3 p-4">
          {profiles.map((profile) => (
            <div key={profile.id} className="flex flex-col gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-bold text-fg-strong">{profile.displayName}</p>
                <StatusChip tone={profile.readiness?.status === 'ready' ? 'positive' : 'notice'}>
                  {profile.readiness?.status ?? 'unknown'}
                </StatusChip>
              </div>
              <p className="text-xs text-fg-muted">{profile.id}</p>
              <ul className="flex flex-wrap gap-2 text-xs text-fg">
                {profile.models.map((model) => (
                  <li key={model}>{model}</li>
                ))}
              </ul>
            </div>
          ))}
        </Card>
      )}
      {diagnostics.length > 0 ? (
        <Card className="flex flex-col gap-2" aria-label="Provider diagnostics">
          <h3 className="text-sm font-bold text-fg-strong">Provider diagnostics</h3>
          {diagnostics.map((diagnostic) => (
            <div
              key={`${diagnostic.source}:${diagnostic.profileId ?? 'none'}:${diagnostic.code}:${diagnostic.message}`}
              className="text-xs"
            >
              <p className="font-bold text-fg-strong">
                {diagnostic.status} · {diagnostic.code}
              </p>
              <p className="text-fg-muted">
                {diagnostic.profileId ? `${diagnostic.profileId} · ` : ''}
                {diagnostic.message}
              </p>
            </div>
          ))}
        </Card>
      ) : null}

      {gateway ? (
        <Card className="flex flex-col gap-2" aria-label="Logical Gateway models">
          <h3 className="text-sm font-bold text-fg-strong">Logical Gateway models</h3>
          <p className="text-xs text-fg-muted">
            Default: {gateway.defaultModelId ?? 'Not configured'}
          </p>
          {gateway.models.map((model) => (
            <div key={model.id} className="flex flex-wrap items-center gap-2 text-sm text-fg">
              <span className="font-bold">{model.displayName}</span>
              <span className="text-xs text-fg-muted">{model.id}</span>
              {model.id === gateway.defaultModelId ? (
                <StatusChip tone="positive">Default</StatusChip>
              ) : null}
            </div>
          ))}
        </Card>
      ) : null}

      {apiKeyProfiles.length > 0 ? (
        <Card className="flex flex-col gap-3">
          <Select
            label="API key provider"
            items={apiKeyProfiles.map((profile) => ({
              id: profile.id,
              label: profile.displayName,
            }))}
            selectedKey={apiKeyProviderId}
            onSelectionChange={(key) => {
              if (typeof key !== 'string') return;
              setApiKeyProviderId(key);
              setApiKey('');
              saveKey.reset();
            }}
            isDisabled={disconnected || saveKey.isPending}
          />
          <TextField
            label="Provider API key"
            type="password"
            value={apiKey}
            onChange={setApiKey}
            autoComplete="off"
            isDisabled={disconnected || saveKey.isPending}
          />
          {saveKey.isError ? (
            <ErrorBanner message="Couldn't save that API key." onRetry={() => saveKey.mutate()} />
          ) : null}
          {saveKey.isSuccess ? (
            <p role="status" className="text-xs text-positive-fg">
              API key saved.
            </p>
          ) : null}
          <div className="flex justify-end">
            <Button
              size="sm"
              isDisabled={disconnected || saveKey.isPending || !apiKey.trim()}
              onPress={() => saveKey.mutate()}
            >
              Save or Replace API key
            </Button>
          </div>
        </Card>
      ) : null}

      <ProviderProfileForm
        client={client}
        disconnected={disconnected}
        accounts={accounts}
        onCreated={onProfilesChanged}
      />
    </section>
  );
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
      <TextField label="Models" value={models} onChange={setModels} isDisabled={disconnected} />
      <TextField
        label="Default model"
        value={defaultModel}
        onChange={setDefaultModel}
        isDisabled={disconnected}
      />
      {create.isError ? (
        <ErrorBanner
          message="Couldn't create that provider profile."
          onRetry={() => create.mutate()}
        />
      ) : null}
      {create.isSuccess ? (
        <p role="status" className="text-xs text-fg-muted">
          Provider file saved. Apply configuration to load it.
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
