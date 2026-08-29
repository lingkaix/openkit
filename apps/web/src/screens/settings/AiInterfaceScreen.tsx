import { ProviderApiKeyProfileIdSchema } from '@openkit/app-api-schemas';
import { ApiCallError, type CoreClient, createCoreClient } from '@openkit/core-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { applyEdits, modify, parse } from 'jsonc-parser';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
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

type AdminClientFactory = (token: string) => CoreClient;
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
type RuntimeConfigValidation = Awaited<ReturnType<CoreClient['runtimeConfig']['validate']>>;
type RuntimeConfigReload = Awaited<ReturnType<CoreClient['runtimeConfig']['reload']>>;
type ServerDefaults = {
  coreProviderId: string | null;
  coreModel: string | null;
  gatewayProviderId: string | null;
  gatewayModel: string | null;
};

const OAUTH_VENDORS: Record<SubscriptionProviderId, string> = {
  'openai-codex': 'openai_codex',
  xai: 'xai',
};

const PROVIDER_KINDS = ['direct', 'gateway', 'local', 'oauth', 'custom'] as const;
const STATUS_POLL_MS = 2_000;

/** Creates a same-origin Core Client whose bearer credential stays only in browser memory. */
function createDeploymentAdminClient(token: string): CoreClient {
  return createCoreClient({
    baseUrl: import.meta.env.VITE_CORE_BASE_URL ?? '',
    headers: { authorization: `Bearer ${token}` },
  });
}

/** Checks whether a failed list read needs an explicit deployment-admin credential. */
function isAdminDenied(error: unknown): boolean {
  return error instanceof ApiCallError && (error.status === 401 || error.status === 403);
}

/** Writes one JSONC path while preserving unrelated comments and formatting. */
function setJsoncPath(source: string, path: string[], value: unknown): string {
  return applyEdits(
    source,
    modify(source, path, value, { formattingOptions: { insertSpaces: true, tabSize: 2 } })
  );
}

function readOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Reads authored core and gateway defaults from the current server.jsonc text. */
function readServerDefaults(content: string): ServerDefaults {
  const parsed = parse(content) as { defaults?: Record<string, unknown> } | undefined;
  const defaults = parsed && typeof parsed === 'object' ? parsed.defaults : undefined;
  return {
    coreProviderId: readOptionalString(defaults?.coreProviderId),
    coreModel: readOptionalString(defaults?.coreModel),
    gatewayProviderId: readOptionalString(defaults?.gatewayProviderId),
    gatewayModel: readOptionalString(defaults?.gatewayModel),
  };
}

/**
 * AI interface settings — published deployment-admin provider, account, and default workflow.
 *
 * Session credentials are tried first. A `server-admin` token is requested only after a typed
 * 401/403 and is kept in mounted React memory. Honors §9.13.
 */
export function AiInterfaceScreen({
  createAdminClient = createDeploymentAdminClient,
}: {
  createAdminClient?: AdminClientFactory;
}) {
  const sessionClient = useCoreClient();
  const queryClient = useQueryClient();
  const { failed: disconnected } = useConnection();
  const [adminClient, setAdminClient] = useState<CoreClient | null>(null);
  const [clientGeneration, setClientGeneration] = useState(0);
  const [token, setToken] = useState('');
  const activeClient = adminClient ?? sessionClient;
  const accountsKey = [...settingsKeys.aiInterface(clientGeneration), 'accounts'] as const;
  const diagnosticsKey = [...settingsKeys.aiInterface(clientGeneration), 'diagnostics'] as const;
  const serverKey = [...settingsKeys.aiInterface(clientGeneration), 'server'] as const;

  const accounts = useQuery({
    queryKey: accountsKey,
    queryFn: async () => {
      const inventory = await activeClient.providerSubscriptions.listProviders();
      return Promise.all(
        inventory.providers.map(async (provider) => {
          const listed = await activeClient.providerSubscriptions.listAccounts(
            provider.subscriptionProviderId
          );
          const quotas = await Promise.all(
            listed.accounts.map((account) =>
              activeClient.providerSubscriptions.getAccountQuota(
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
      projectSafeValue(await activeClient.app.getDiagnostics()) as Awaited<
        ReturnType<CoreClient['app']['getDiagnostics']>
      >,
    enabled: accounts.isSuccess,
    gcTime: 0,
    retry: false,
  });

  const serverFile = useQuery({
    queryKey: serverKey,
    queryFn: () => activeClient.runtimeConfig.getFile('server.jsonc'),
    enabled: accounts.isSuccess,
    gcTime: 0,
    retry: false,
  });

  function forgetAdminToken() {
    setAdminClient(null);
    setClientGeneration((current) => current + 1);
    queryClient.removeQueries({ queryKey: ['settings', 'ai-interface'] });
  }

  function unlock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = token.trim();
    if (!value) return;
    setAdminClient(createAdminClient(value));
    setToken('');
    setClientGeneration((current) => current + 1);
  }

  function retry() {
    queryClient.removeQueries({
      queryKey: [...settingsKeys.aiInterface(clientGeneration), 'status'],
    });
    void accounts.refetch();
    void diagnostics.refetch();
    void serverFile.refetch();
  }

  const adminDenied = isAdminDenied(accounts.error);
  const onAccountsChanged = useCallback(() => {
    queryClient.removeQueries({
      queryKey: [...settingsKeys.aiInterface(clientGeneration), 'status'],
    });
    void queryClient.invalidateQueries({
      queryKey: [...settingsKeys.aiInterface(clientGeneration), 'accounts'],
    });
  }, [clientGeneration, queryClient]);
  const onProfilesChanged = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: [...settingsKeys.aiInterface(clientGeneration), 'accounts'],
    });
    void queryClient.invalidateQueries({
      queryKey: [...settingsKeys.aiInterface(clientGeneration), 'diagnostics'],
    });
    void queryClient.invalidateQueries({
      queryKey: [...settingsKeys.aiInterface(clientGeneration), 'server'],
    });
  }, [clientGeneration, queryClient]);

  return (
    <Page>
      <PageHeader
        eyebrow="Deployment administration"
        title="AI interface"
        subtitle="Manage subscription accounts, provider profiles, API keys, and the core and gateway default models for this deployment."
        actions={
          <div className="flex gap-2">
            {adminClient && accounts.isSuccess ? (
              <Button variant="quiet" size="sm" onPress={forgetAdminToken}>
                Forget admin token
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="outline"
              isDisabled={disconnected || accounts.isFetching || adminDenied}
              onPress={retry}
            >
              Refresh status
            </Button>
          </div>
        }
      />

      {accounts.isLoading ? (
        <Skeleton lines={6} />
      ) : accounts.isError && adminDenied ? (
        <AdminCredentialGate token={token} onTokenChange={setToken} onSubmit={unlock} />
      ) : accounts.isError ? (
        <ErrorBanner
          message="Couldn't load AI interface."
          onRetry={() => void accounts.refetch()}
        />
      ) : (
        <>
          <SubscriptionAccounts
            client={activeClient}
            clientGeneration={clientGeneration}
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
              client={activeClient}
              disconnected={disconnected}
              profiles={diagnostics.data?.providers.registry ?? []}
              diagnostics={diagnostics.data?.providers.diagnostics ?? []}
              accounts={accounts.data ?? []}
              defaultReady={Boolean(diagnostics.data?.defaultProviders.core.configured)}
              configuredCoreProviderId={
                diagnostics.data?.defaultProviders.core.configured
                  ? diagnostics.data.defaultProviders.core.providerId
                  : null
              }
              serverRevision={serverFile.data?.file.revision ?? null}
              serverContent={serverFile.data?.content ?? ''}
              serverLoading={serverFile.isLoading}
              serverError={serverFile.isError}
              onReloadServer={() => void serverFile.refetch()}
              onProfilesChanged={onProfilesChanged}
            />
          )}
        </>
      )}
    </Page>
  );
}

/** Requests an explicit server-admin bearer credential without persisting it. */
function AdminCredentialGate({
  token,
  onTokenChange,
  onSubmit,
}: {
  token: string;
  onTokenChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <Card className="mx-auto w-full max-w-lg">
      <form className="flex flex-col gap-4" onSubmit={onSubmit}>
        <div>
          <h2 className="text-sm font-bold text-fg-strong">Server-admin access required</h2>
          <p className="mt-1 text-sm text-fg-muted">
            AI provider settings are deployment-wide. The token is used for this open page only and
            is never written to browser storage.
          </p>
        </div>
        <TextField
          label="Server admin token"
          type="password"
          value={token}
          onChange={onTokenChange}
          autoComplete="off"
        />
        <div className="flex justify-end">
          <Button type="submit" isDisabled={!token.trim()}>
            Open AI interface
          </Button>
        </div>
      </form>
    </Card>
  );
}

/** Subscription-account lifecycle for the fixed Codex and xAI providers. */
function SubscriptionAccounts({
  client,
  clientGeneration,
  disconnected,
  providers,
  onAccountsChanged,
}: {
  client: CoreClient;
  clientGeneration: number;
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
              clientGeneration={clientGeneration}
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
  clientGeneration,
  disconnected,
  provider,
  onAccountsChanged,
}: {
  client: CoreClient;
  clientGeneration: number;
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
              clientGeneration={clientGeneration}
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
  clientGeneration,
  disconnected,
  providerId,
  onAccountsChanged,
}: {
  account: ConnectedAppRow;
  client: CoreClient;
  clientGeneration: number;
  disconnected: boolean;
  providerId: SubscriptionProviderId;
  onAccountsChanged: () => void;
}) {
  const queryClient = useQueryClient();
  const [displayName, setDisplayName] = useState(account.displayName);
  const [snapshot, setSnapshot] = useState<ProviderSubscriptionAccount | undefined>(undefined);
  const statusKey = [
    ...settingsKeys.aiInterface(clientGeneration),
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

/** Configured provider profiles, core and gateway defaults, profile creation, and API-key controls. */
function ProviderProfiles({
  client,
  disconnected,
  profiles,
  diagnostics,
  accounts,
  defaultReady,
  configuredCoreProviderId,
  serverRevision,
  serverContent,
  serverLoading,
  serverError,
  onReloadServer,
  onProfilesChanged,
}: {
  client: CoreClient;
  disconnected: boolean;
  profiles: ProviderRegistryEntry[];
  diagnostics: ProviderDiagnostic[];
  accounts: ConnectedAppProviderRow[];
  defaultReady: boolean;
  configuredCoreProviderId: string | null;
  serverRevision: string | null;
  serverContent: string;
  serverLoading: boolean;
  serverError: boolean;
  onReloadServer: () => void;
  onProfilesChanged: () => void;
}) {
  const [coreProviderId, setCoreProviderId] = useState<string | null>(
    () => readServerDefaults(serverContent).coreProviderId
  );
  const [coreModel, setCoreModel] = useState<string | null>(
    () => readServerDefaults(serverContent).coreModel
  );
  const [gatewayProviderId, setGatewayProviderId] = useState<string | null>(
    () => readServerDefaults(serverContent).gatewayProviderId
  );
  const [gatewayModel, setGatewayModel] = useState<string | null>(
    () => readServerDefaults(serverContent).gatewayModel
  );
  const [apiKey, setApiKey] = useState('');
  const [apiKeyProviderId, setApiKeyProviderId] = useState<string | null>(
    () => readServerDefaults(serverContent).coreProviderId
  );
  const coreProfile = profiles.find((profile) => profile.id === coreProviderId) ?? null;
  const gatewayProfile = profiles.find((profile) => profile.id === gatewayProviderId) ?? null;
  const apiKeyProfiles = profiles.filter(
    (profile) =>
      profile.kind === 'direct' || profile.kind === 'gateway' || profile.kind === 'custom'
  );
  const apiKeyProfile = apiKeyProfiles.find((profile) => profile.id === apiKeyProviderId) ?? null;
  const persistedDefaults = readServerDefaults(serverContent);
  const defaultsDirty =
    coreProviderId !== persistedDefaults.coreProviderId ||
    coreModel !== persistedDefaults.coreModel ||
    gatewayProviderId !== persistedDefaults.gatewayProviderId ||
    gatewayModel !== persistedDefaults.gatewayModel;

  useEffect(() => {
    const defaults = readServerDefaults(serverContent);
    setCoreProviderId(defaults.coreProviderId);
    setCoreModel(defaults.coreModel);
    setGatewayProviderId(defaults.gatewayProviderId);
    setGatewayModel(defaults.gatewayModel);
  }, [serverContent]);

  useEffect(() => {
    setApiKeyProviderId((current) => {
      const eligible = profiles.filter(
        (profile) =>
          profile.kind === 'direct' || profile.kind === 'gateway' || profile.kind === 'custom'
      );
      if (current && eligible.some((profile) => profile.id === current)) {
        return current;
      }
      const configured = readServerDefaults(serverContent).coreProviderId;
      return eligible.find((profile) => profile.id === configured)?.id ?? eligible[0]?.id ?? null;
    });
  }, [profiles, serverContent]);

  const saveDefaults = useMutation({
    mutationFn: async () => {
      const content = setJsoncPath(
        setJsoncPath(
          setJsoncPath(
            setJsoncPath(
              serverContent,
              ['defaults', 'coreProviderId'],
              coreProviderId ?? undefined
            ),
            ['defaults', 'coreModel'],
            coreModel ?? undefined
          ),
          ['defaults', 'gatewayProviderId'],
          gatewayProviderId ?? undefined
        ),
        ['defaults', 'gatewayModel'],
        gatewayModel ?? undefined
      );
      const checked = await client.runtimeConfig.validate({
        files: [{ id: 'server.jsonc', content }],
        mode: 'safe',
      });
      if (!checked.valid) return { checked, written: false };
      await client.runtimeConfig.updateFile({
        id: 'server.jsonc',
        kind: 'server',
        content,
        expectedRevision: serverRevision,
      });
      return { checked, written: true };
    },
    onSuccess: (result) => {
      if (result.written) onProfilesChanged();
    },
  });
  const applyConfig = useMutation({
    mutationFn: () => client.runtimeConfig.reload({ dryRun: false, mode: 'safe' }),
    onSuccess: onProfilesChanged,
  });
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
                {defaultReady && profile.id === configuredCoreProviderId ? (
                  <StatusChip tone="positive">Default ready</StatusChip>
                ) : null}
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

      {serverLoading ? (
        <Skeleton lines={3} />
      ) : serverError ? (
        <ErrorBanner message="Couldn't load server.jsonc." onRetry={onReloadServer} />
      ) : (
        <Card className="flex flex-col gap-3">
          <Select
            label="Core provider"
            items={profiles.map((profile) => ({ id: profile.id, label: profile.displayName }))}
            selectedKey={coreProviderId}
            onSelectionChange={(key) => {
              if (typeof key !== 'string') return;
              setCoreProviderId(key);
              setCoreModel(null);
            }}
            isDisabled={disconnected || profiles.length === 0}
          />
          <Select
            label="Core model"
            items={(coreProfile?.models ?? []).map((model) => ({ id: model, label: model }))}
            selectedKey={coreModel}
            onSelectionChange={(key) => {
              if (typeof key === 'string') setCoreModel(key);
            }}
            isDisabled={disconnected || !coreProfile}
          />
          <Select
            label="Gateway provider"
            items={profiles.map((profile) => ({ id: profile.id, label: profile.displayName }))}
            selectedKey={gatewayProviderId}
            onSelectionChange={(key) => {
              if (typeof key !== 'string') return;
              setGatewayProviderId(key);
              setGatewayModel(null);
            }}
            isDisabled={disconnected || profiles.length === 0}
          />
          <Select
            label="Gateway model"
            items={(gatewayProfile?.models ?? []).map((model) => ({ id: model, label: model }))}
            selectedKey={gatewayModel}
            onSelectionChange={(key) => {
              if (typeof key === 'string') setGatewayModel(key);
            }}
            isDisabled={disconnected || !gatewayProfile}
          />
          <div className="flex justify-end">
            <Button
              size="sm"
              variant="quiet"
              isDisabled={disconnected || (gatewayProviderId === null && gatewayModel === null)}
              onPress={() => {
                setGatewayProviderId(null);
                setGatewayModel(null);
              }}
            >
              Clear gateway default
            </Button>
          </div>
          {saveDefaults.isError ? (
            <ErrorBanner message="Couldn't save defaults." onRetry={() => saveDefaults.mutate()} />
          ) : null}
          {saveDefaults.data?.checked ? (
            <DefaultsValidationResult result={saveDefaults.data.checked} />
          ) : null}
          {saveDefaults.data?.written ? (
            <p role="status" className="text-xs text-fg-muted">
              Defaults file saved. Apply configuration to load it.
            </p>
          ) : null}
          {applyConfig.isError ? (
            <ErrorBanner
              message="Couldn't apply configuration."
              onRetry={() => applyConfig.mutate()}
            />
          ) : null}
          {applyConfig.data ? <DefaultsReloadResult result={applyConfig.data} /> : null}
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              variant="outline"
              isDisabled={
                disconnected || defaultsDirty || saveDefaults.isPending || applyConfig.isPending
              }
              onPress={() => applyConfig.mutate()}
            >
              Apply configuration
            </Button>
            <Button
              size="sm"
              isDisabled={disconnected || saveDefaults.isPending || !coreProviderId || !coreModel}
              onPress={() => saveDefaults.mutate()}
            >
              Save defaults
            </Button>
          </div>
        </Card>
      )}

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

/** Displays the server.jsonc validation result after an attempted defaults save. */
function DefaultsValidationResult({ result }: { result: RuntimeConfigValidation }) {
  return (
    <div
      role="status"
      className={`rounded-ok px-3 py-2 text-xs ${
        result.valid ? 'bg-positive-bg text-positive-fg' : 'bg-negative-bg text-negative-fg'
      }`}
    >
      <p className="font-bold">{result.valid ? 'Draft is valid' : 'Draft has errors'}</p>
      {result.diagnostics.map((diagnostic, index) => (
        <p key={`${diagnostic.code}:${diagnostic.range?.startLine ?? index}`}>
          {diagnostic.range ? `Line ${diagnostic.range.startLine}: ` : ''}
          {diagnostic.message}
        </p>
      ))}
    </div>
  );
}

/** Displays the truthful reload outcome after defaults were written. */
function DefaultsReloadResult({ result }: { result: RuntimeConfigReload }) {
  const applied = result.status === 'applied';
  return (
    <div
      role="status"
      className={`rounded-ok px-3 py-2 text-xs ${
        applied ? 'bg-positive-bg text-positive-fg' : 'bg-notice-bg text-notice-fg'
      }`}
    >
      <p className="font-bold">{applied ? 'Configuration applied' : `Reload ${result.status}`}</p>
      <p>
        Runtime version {result.runtimeConfig.currentVersion} · {result.plan.requiresRestart.length}{' '}
        changes require restart
      </p>
    </div>
  );
}
