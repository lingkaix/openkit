import { createMemo, createSignal, For, Show } from 'solid-js';

import type {
  AppDiagnostics,
  MetaResponse,
  SetupDiagnostics,
  Turn,
  TurnEvent,
} from '../lib/app-types';
import { type RuntimeConfigReloadInput, SetupReadinessPanel } from './SetupReadinessPanel';

const ENVELOPE_LIMIT = 200;
const CODEX_ACCOUNT_SLOT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

type InspectMode = 'product' | 'protocol';

type RoleDefaultProviderDiagnostics = NonNullable<AppDiagnostics['defaultProviders']>['core'];
type CodexOAuthAccountSummary = NonNullable<
  AppDiagnostics['oauth']['openaiCodexAccounts']
>['accounts'][number];
type CodexOAuthStatusPayload = CodexOAuthAccountSummary;
type CodexOAuthLoginMode = NonNullable<CodexOAuthStatusPayload['mode']>;

/**
 * Display state for the default-provider diagnostics metric.
 */
interface DefaultProviderDisplay {
  /** Detail text describing the current provider state. */
  detail: string;
  /** Main value shown in the metric tile. */
  value: string;
}

interface AccountActionFeedback {
  /** Feedback severity. */
  kind: 'error' | 'success';
  /** Feedback text. */
  message: string;
}

/**
 * Props for the Settings diagnostics protocol inspection panel.
 */
export interface DiagnosticsPanelProps {
  appDiagnostics?: AppDiagnostics | null;
  events: TurnEvent[];
  inspectMode?: InspectMode;
  isUpdatingCodexOAuth?: boolean;
  isReloadingRuntimeConfig?: boolean;
  isRefreshingSetupDiagnostics?: boolean;
  meta: MetaResponse | null;
  onCancelCodexOAuth?: (loginId: string | undefined, accountSlotId: string) => void | Promise<void>;
  onCreateCodexOAuthAccount?: (input: {
    accountSlotId: string;
    displayName?: string;
  }) => void | Promise<void>;
  onDeleteCodexOAuthAccount?: (accountSlotId: string) => void | Promise<void>;
  onRefreshSetupDiagnostics?: () => void;
  onLogoutCodexOAuth?: (accountSlotId: string) => void | Promise<void>;
  onReloadRuntimeConfig?: (input: RuntimeConfigReloadInput) => void | Promise<void>;
  onStartCodexOAuth?: (mode: CodexOAuthLoginMode, accountSlotId: string) => void | Promise<void>;
  onUpdateCodexOAuthAccount?: (
    accountSlotId: string,
    input: { displayName: string }
  ) => void | Promise<void>;
  setupDiagnostics?: SetupDiagnostics | null;
  turns: Turn[];
}

/**
 * Formats one event envelope name.
 */
function formatEventName(event: TurnEvent): string {
  return event.event;
}

/**
 * Returns the capped FIFO event envelope list.
 */
function cappedEvents(events: TurnEvent[]): TurnEvent[] {
  return events.slice(Math.max(0, events.length - ENVELOPE_LIMIT));
}

/**
 * Formats a default-provider source value for human display.
 */
function formatProviderOrigin(origin: string): string {
  return origin.replaceAll('-', ' ');
}

/**
 * Formats one role-specific default-provider diagnostic.
 */
function formatRoleDefaultProvider(
  provider: RoleDefaultProviderDiagnostics
): DefaultProviderDisplay {
  const origin = formatProviderOrigin(provider.origin);

  if (provider.configured) {
    return {
      detail: `Ready from ${origin}${provider.model ? ` using ${provider.model}` : ''}.`,
      value: provider.providerId,
    };
  }

  if (provider.reason === 'unset') {
    return {
      detail: 'No provider configured.',
      value: 'Unset',
    };
  }

  if (provider.reason === 'unknown-id') {
    return {
      detail: `Unknown provider id from ${origin}.`,
      value: provider.providerId,
    };
  }

  return {
    detail: `Credentials missing from ${origin}.`,
    value: provider.providerId,
  };
}

/**
 * Formats Codex ChatGPT account state for display.
 */
function formatCodexOAuthStatus(oauth?: CodexOAuthStatusPayload | null): DefaultProviderDisplay {
  if (!oauth) {
    return {
      detail: 'Diagnostics loading.',
      value: 'loading',
    };
  }

  if (oauth.status === 'logged_in') {
    return {
      detail: 'Ready.',
      value: oauth.accountLabel ?? 'ChatGPT',
    };
  }

  if (oauth.status === 'pending') {
    return {
      detail:
        oauth.mode === 'device_code'
          ? 'Enter the device code in ChatGPT.'
          : 'Open the ChatGPT login URL to continue.',
      value: 'Pending',
    };
  }

  if (oauth.status === 'unavailable') {
    return {
      detail: oauth.message ?? 'Codex app-server is unavailable.',
      value: 'Unavailable',
    };
  }

  if (oauth.status === 'error') {
    return {
      detail: oauth.message ?? 'ChatGPT login failed.',
      value: 'Error',
    };
  }

  return {
    detail: 'Sign in with a Codex or ChatGPT subscription.',
    value: 'Logged out',
  };
}

/**
 * Formats account status values for visible badges.
 *
 * @param status Account OAuth status.
 * @returns Raw status label used by diagnostics.
 */
function formatAccountStatusBadge(status: CodexOAuthStatusPayload['status']): string {
  return status;
}

/**
 * Builds a filesystem-safe slot id suggestion from a display name.
 *
 * @param value Display name draft.
 * @returns Lowercase slot id suggestion.
 */
function suggestAccountSlotId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

/**
 * Returns whether one slot id is valid for server-owned account storage.
 *
 * @param value Slot id draft.
 * @returns True when the value is valid.
 */
function isValidAccountSlotId(value: string): boolean {
  return CODEX_ACCOUNT_SLOT_ID_PATTERN.test(value);
}

/**
 * Formats provider gateway capabilities for compact diagnostics chips.
 */
function formatProviderGatewayCapabilities(
  provider: AppDiagnostics['providers']['registry'][number]
): string[] {
  const { gatewayCapabilities: capabilities } = provider;

  if (!capabilities) {
    return [];
  }

  return [`chat ${capabilities.chatCompletions}`, `responses ${capabilities.responses}`];
}

/**
 * Formats a cache hit ratio as a compact percentage.
 *
 * @param value Ratio from zero to one.
 * @returns Percentage label.
 */
function formatCacheHitRate(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/**
 * Renders protocol diagnostics for meta, event envelopes, and turn lifecycle state.
 */
export function DiagnosticsPanel(props: DiagnosticsPanelProps) {
  const [eventFilter, setEventFilter] = createSignal('');
  const [newAccountSlotId, setNewAccountSlotId] = createSignal('');
  const [newAccountDisplayName, setNewAccountDisplayName] = createSignal('');
  const [displayNameDrafts, setDisplayNameDrafts] = createSignal<Record<string, string>>({});
  const [accountActionKey, setAccountActionKey] = createSignal<string | null>(null);
  const [accountFeedback, setAccountFeedback] = createSignal<AccountActionFeedback | null>(null);
  const codexOAuthAccounts = createMemo(
    () => props.appDiagnostics?.oauth.openaiCodexAccounts.accounts ?? []
  );
  const coreDefaultProvider = createMemo(() =>
    props.appDiagnostics?.defaultProviders
      ? formatRoleDefaultProvider(props.appDiagnostics.defaultProviders.core)
      : null
  );
  const gatewayDefaultProvider = createMemo(() =>
    props.appDiagnostics?.defaultProviders
      ? formatRoleDefaultProvider(props.appDiagnostics.defaultProviders.gateway)
      : null
  );
  const runtimeConfig = createMemo(
    () => props.setupDiagnostics?.runtimeConfig ?? props.appDiagnostics?.runtimeConfig ?? null
  );
  const suggestedAccountSlotId = createMemo(() => suggestAccountSlotId(newAccountDisplayName()));
  const newAccountSlotIdError = createMemo(() => {
    const value = newAccountSlotId().trim();

    if (!value || isValidAccountSlotId(value)) {
      return null;
    }

    return 'Use lowercase letters, numbers, hyphens, or underscores. Start with a letter or number.';
  });
  const inspectMode = createMemo<InspectMode>(() => props.inspectMode ?? 'protocol');
  const latestEvents = createMemo(() => cappedEvents(props.events));
  const filteredEvents = createMemo(() => {
    const filter = eventFilter().trim().toLowerCase();

    if (!filter) {
      return latestEvents();
    }

    return latestEvents().filter((event) => event.event.toLowerCase().includes(filter));
  });

  /**
   * Updates the local display-name draft for one account card.
   */
  function updateDisplayNameDraft(accountSlotId: string, value: string): void {
    setDisplayNameDrafts((current) => ({ ...current, [accountSlotId]: value }));
  }

  /**
   * Reads the current draft display name for one account card.
   */
  function displayNameDraft(account: CodexOAuthAccountSummary): string {
    return displayNameDrafts()[account.accountSlotId] ?? account.displayName ?? '';
  }

  /**
   * Runs one account action and stores local feedback.
   *
   * @param key Busy-state key for the action.
   * @param successMessage Message shown after success.
   * @param action Async account operation to run.
   */
  async function runAccountAction(
    key: string,
    successMessage: string,
    action: () => Promise<void>
  ): Promise<void> {
    setAccountActionKey(key);
    setAccountFeedback(null);

    try {
      await action();
      setAccountFeedback({ kind: 'success', message: successMessage });
    } catch (error) {
      setAccountFeedback({ kind: 'error', message: (error as Error).message });
    } finally {
      setAccountActionKey(null);
    }
  }

  /**
   * Submits the add-account form.
   */
  async function submitNewAccount(): Promise<void> {
    const accountSlotId = newAccountSlotId().trim();
    const displayName = newAccountDisplayName().trim();

    if (!accountSlotId) {
      return;
    }

    if (!isValidAccountSlotId(accountSlotId)) {
      setAccountFeedback({
        kind: 'error',
        message: newAccountSlotIdError() ?? 'Account slot id is invalid.',
      });
      return;
    }

    await runAccountAction('create', `Created account slot ${accountSlotId}.`, async () => {
      await props.onCreateCodexOAuthAccount?.({
        accountSlotId,
        ...(displayName ? { displayName } : {}),
      });
      setNewAccountSlotId('');
      setNewAccountDisplayName('');
    });
  }

  /**
   * Starts login for one rendered account card.
   */
  async function startAccountLogin(
    account: CodexOAuthAccountSummary,
    mode: CodexOAuthLoginMode
  ): Promise<void> {
    const key = `login:${account.accountSlotId}:${mode}`;

    await runAccountAction(key, `Started ${mode} login for ${account.accountSlotId}.`, async () => {
      await props.onStartCodexOAuth?.(mode, account.accountSlotId);
    });
  }

  /**
   * Cancels login for one rendered account card.
   */
  async function cancelAccountLogin(account: CodexOAuthAccountSummary): Promise<void> {
    const key = `cancel:${account.accountSlotId}`;

    await runAccountAction(key, `Cancelled login for ${account.accountSlotId}.`, async () => {
      await props.onCancelCodexOAuth?.(account.loginId, account.accountSlotId);
    });
  }

  /**
   * Logs out one rendered account card.
   */
  async function logoutAccount(account: CodexOAuthAccountSummary): Promise<void> {
    const key = `logout:${account.accountSlotId}`;

    await runAccountAction(key, `Signed out ${account.accountSlotId}.`, async () => {
      await props.onLogoutCodexOAuth?.(account.accountSlotId);
    });
  }

  return (
    <section class="support-card settings-content-panel">
      <h3 class="font-display text-lg font-semibold">Diagnostics</h3>

      <div class="mt-4 grid gap-3">
        <div class="metric-tile">
          <span class="metric-label">Service</span>
          <span class="metric-value">{props.appDiagnostics?.service ?? 'loading'}</span>
        </div>
        <div class="metric-tile">
          <span class="metric-label">Gateway</span>
          <span class="metric-value">
            {props.appDiagnostics ? `gateway ${props.appDiagnostics.gateway.status}` : 'loading'}
          </span>
          <div class="mt-2 flex flex-wrap gap-1">
            <For each={props.appDiagnostics?.gateway.endpoints ?? []}>
              {(endpoint) => <span class="badge badge-outline badge-sm">{endpoint}</span>}
            </For>
          </div>
          <div class="mt-2 flex flex-wrap gap-1">
            <For each={props.appDiagnostics?.gateway.usage?.summaries ?? []}>
              {(summary) => (
                <span class="badge badge-outline badge-sm">
                  {`${summary.providerId} ${summary.model} ${summary.cachedInputTokens} cached input tokens - ${formatCacheHitRate(summary.cacheHitRate)} cache hit rate`}
                </span>
              )}
            </For>
          </div>
        </div>
        <div class="metric-tile">
          <span class="metric-label">Providers</span>
          <span class="metric-value">{props.appDiagnostics?.providers.registry.length ?? 0}</span>
        </div>
        <Show when={coreDefaultProvider()}>
          {(provider) => (
            <div class="metric-tile">
              <span class="metric-label">Core default provider</span>
              <span class="metric-value">{provider().value}</span>
              <p class="text-xs opacity-70">{provider().detail}</p>
            </div>
          )}
        </Show>
        <Show when={gatewayDefaultProvider()}>
          {(provider) => (
            <div class="metric-tile">
              <span class="metric-label">Gateway default provider</span>
              <span class="metric-value">{provider().value}</span>
              <p class="text-xs opacity-70">{provider().detail}</p>
            </div>
          )}
        </Show>
      </div>

      <section class="mt-5">
        <div class="ui-section-header mb-3 flex flex-wrap items-center justify-between gap-3">
          <h4 class="font-display text-base font-semibold">Codex ChatGPT accounts</h4>
          <span class="badge badge-outline">
            {props.appDiagnostics?.oauth.openaiCodexAccounts.defaultAccountSlotId ?? 'default'}
          </span>
        </div>
        <article class="event-line mb-3">
          <div class="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
            <label class="form-control ui-field" for="codex-account-slot-id">
              <span class="label-text">Slot/folder ID</span>
              <span class="sr-only">Account slot id</span>
              <input
                class={`input input-bordered input-sm w-full ${
                  newAccountSlotIdError() ? 'input-error' : ''
                }`}
                id="codex-account-slot-id"
                onInput={(event) => setNewAccountSlotId(event.currentTarget.value)}
                placeholder={suggestedAccountSlotId() || 'slot-id'}
                value={newAccountSlotId()}
              />
              <span class="label-text-alt">
                Lowercase storage id. Display names can use mixed case.
              </span>
            </label>
            <label class="form-control ui-field" for="codex-account-display-name">
              <span class="label-text">Display name</span>
              <input
                aria-label="Display name"
                class="input input-bordered input-sm w-full"
                id="codex-account-display-name"
                onInput={(event) => setNewAccountDisplayName(event.currentTarget.value)}
                placeholder="SlotMeID"
                value={newAccountDisplayName()}
              />
              <Show when={suggestedAccountSlotId()}>
                {(suggestion) => (
                  <span class="label-text-alt">Suggested slot id: {suggestion()}</span>
                )}
              </Show>
            </label>
            <button
              class="btn btn-primary btn-sm self-end"
              disabled={
                props.isUpdatingCodexOAuth ||
                accountActionKey() === 'create' ||
                !props.onCreateCodexOAuthAccount ||
                !newAccountSlotId().trim()
              }
              onClick={() => void submitNewAccount()}
              type="button"
            >
              {accountActionKey() === 'create' ? 'Adding...' : 'Add account'}
            </button>
          </div>
          <Show when={newAccountSlotIdError()}>
            {(message) => <p class="mt-2 text-xs text-error">{message()}</p>}
          </Show>
          <Show when={accountFeedback()}>
            {(feedback) => (
              <p
                class={`mt-2 text-xs ${
                  feedback().kind === 'error' ? 'text-error' : 'text-success'
                }`}
                role={feedback().kind === 'error' ? 'alert' : 'status'}
              >
                {feedback().message}
              </p>
            )}
          </Show>
        </article>
        <div class="space-y-2">
          <For each={codexOAuthAccounts()}>
            {(account) => {
              const display = createMemo(() => formatCodexOAuthStatus(account));

              return (
                <article class="event-line">
                  <div class="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <span class="font-semibold">
                        {account.displayName ?? account.accountSlotId}
                      </span>
                      <p class="text-xs opacity-70">{display().detail}</p>
                      <div class="mt-2 flex flex-wrap gap-1">
                        <Show when={account.accountLabel}>
                          {(label) => <span class="badge badge-outline badge-sm">{label()}</span>}
                        </Show>
                        <Show when={account.planType}>
                          {(plan) => <span class="badge badge-outline badge-sm">{plan()}</span>}
                        </Show>
                      </div>
                    </div>
                    <div class="flex flex-wrap gap-1">
                      <span class="badge badge-outline badge-sm">
                        {formatAccountStatusBadge(account.status)}
                      </span>
                      <span class="badge badge-outline badge-sm">{account.accountSlotId}</span>
                      <Show when={account.isDefault}>
                        <span class="badge badge-primary badge-sm">default</span>
                      </Show>
                    </div>
                  </div>
                  <Show when={account.authUrl}>
                    {(authUrl) => (
                      <p class="text-xs">
                        <a
                          class="link link-primary"
                          href={authUrl()}
                          rel="noreferrer"
                          target="_blank"
                        >
                          Open ChatGPT login
                        </a>
                      </p>
                    )}
                  </Show>
                  <Show when={account.verificationUrl}>
                    {(verificationUrl) => (
                      <p class="text-xs">
                        <a
                          class="link link-primary"
                          href={verificationUrl()}
                          rel="noreferrer"
                          target="_blank"
                        >
                          Open device login
                        </a>
                      </p>
                    )}
                  </Show>
                  <Show when={account.userCode}>
                    {(userCode) => (
                      <p class="text-xs">
                        Code <code>{userCode()}</code>
                      </p>
                    )}
                  </Show>
                  <Show when={account.boundProviderIds.length > 0}>
                    <div class="mt-2 flex flex-wrap gap-1">
                      <For each={account.boundProviderIds}>
                        {(providerId) => (
                          <span class="badge badge-outline badge-sm">{providerId}</span>
                        )}
                      </For>
                    </div>
                  </Show>
                  <div class="mt-3 grid gap-2 md:grid-cols-[minmax(0,1fr)_auto_auto]">
                    <input
                      aria-label={`Display name for ${account.accountSlotId}`}
                      class="input input-bordered input-sm w-full"
                      onInput={(event) =>
                        updateDisplayNameDraft(account.accountSlotId, event.currentTarget.value)
                      }
                      value={displayNameDraft(account)}
                    />
                    <button
                      class="btn btn-outline btn-sm"
                      disabled={
                        props.isUpdatingCodexOAuth ||
                        accountActionKey() === `name:${account.accountSlotId}` ||
                        !props.onUpdateCodexOAuthAccount
                      }
                      onClick={() =>
                        void runAccountAction(
                          `name:${account.accountSlotId}`,
                          `Saved name for ${account.accountSlotId}.`,
                          async () => {
                            await props.onUpdateCodexOAuthAccount?.(account.accountSlotId, {
                              displayName: displayNameDraft(account),
                            });
                          }
                        )
                      }
                      type="button"
                    >
                      {accountActionKey() === `name:${account.accountSlotId}`
                        ? 'Saving...'
                        : 'Save name'}
                    </button>
                    <button
                      class="btn btn-ghost btn-sm"
                      disabled={
                        props.isUpdatingCodexOAuth ||
                        accountActionKey() === `delete:${account.accountSlotId}` ||
                        !props.onDeleteCodexOAuthAccount ||
                        account.status === 'pending'
                      }
                      onClick={() =>
                        void runAccountAction(
                          `delete:${account.accountSlotId}`,
                          `Deleted ${account.accountSlotId}.`,
                          async () => {
                            await props.onDeleteCodexOAuthAccount?.(account.accountSlotId);
                          }
                        )
                      }
                      type="button"
                    >
                      {accountActionKey() === `delete:${account.accountSlotId}`
                        ? 'Deleting...'
                        : 'Delete'}
                    </button>
                  </div>
                  <div class="mt-3 flex flex-wrap gap-2">
                    <button
                      class="btn btn-primary btn-sm"
                      disabled={
                        props.isUpdatingCodexOAuth ||
                        accountActionKey() === `login:${account.accountSlotId}:browser` ||
                        !props.onStartCodexOAuth
                      }
                      onClick={() => void startAccountLogin(account, 'browser')}
                      type="button"
                    >
                      <iconify-icon icon="ri:login-circle-line" />
                      Continue with ChatGPT
                    </button>
                    <button
                      class="btn btn-outline btn-sm"
                      disabled={
                        props.isUpdatingCodexOAuth ||
                        accountActionKey() === `login:${account.accountSlotId}:device_code` ||
                        !props.onStartCodexOAuth
                      }
                      onClick={() => void startAccountLogin(account, 'device_code')}
                      type="button"
                    >
                      <iconify-icon icon="ri:key-2-line" />
                      Use device code
                    </button>
                    <Show when={account.status === 'pending'}>
                      <button
                        class="btn btn-ghost btn-sm"
                        disabled={
                          props.isUpdatingCodexOAuth ||
                          accountActionKey() === `cancel:${account.accountSlotId}` ||
                          !props.onCancelCodexOAuth
                        }
                        onClick={() => void cancelAccountLogin(account)}
                        type="button"
                      >
                        Cancel login
                      </button>
                    </Show>
                    <Show when={account.status === 'logged_in'}>
                      <button
                        class="btn btn-ghost btn-sm"
                        disabled={
                          props.isUpdatingCodexOAuth ||
                          accountActionKey() === `logout:${account.accountSlotId}` ||
                          !props.onLogoutCodexOAuth
                        }
                        onClick={() => void logoutAccount(account)}
                        type="button"
                      >
                        Sign out
                      </button>
                    </Show>
                  </div>
                </article>
              );
            }}
          </For>
        </div>
      </section>

      <SetupReadinessPanel
        isRefreshing={props.isRefreshingSetupDiagnostics}
        isReloadingRuntimeConfig={props.isReloadingRuntimeConfig}
        onRefresh={props.onRefreshSetupDiagnostics}
        onReloadRuntimeConfig={props.onReloadRuntimeConfig}
        runtimeConfig={runtimeConfig()}
        setupDiagnostics={props.setupDiagnostics}
      />

      <section class="mt-5">
        <div class="ui-section-header mb-3 flex flex-wrap items-center justify-between gap-3">
          <h4 class="font-display text-base font-semibold">Providers</h4>
          <span class="badge badge-outline">
            {props.appDiagnostics?.defaults.quickChat.providerId ?? 'quick chat unset'}
          </span>
        </div>
        <div class="space-y-2">
          <Show
            when={(props.appDiagnostics?.providers.registry.length ?? 0) > 0}
            fallback={<div class="empty-state">No providers configured.</div>}
          >
            <For each={props.appDiagnostics?.providers.registry ?? []}>
              {(provider) => (
                <article class="event-line">
                  <span class="font-semibold">{provider.displayName}</span>
                  <p class="text-xs opacity-70">
                    {provider.id} / {provider.kind}
                    {provider.defaultModel ? ` / ${provider.defaultModel}` : ''}
                  </p>
                  <div class="mt-2 flex flex-wrap gap-1">
                    <For each={formatProviderGatewayCapabilities(provider)}>
                      {(capability) => (
                        <span class="badge badge-outline badge-sm">{capability}</span>
                      )}
                    </For>
                  </div>
                </article>
              )}
            </For>
          </Show>
          <Show when={(props.appDiagnostics?.providers.diagnostics.length ?? 0) > 0}>
            <div class="mt-3 space-y-2">
              <For each={props.appDiagnostics?.providers.diagnostics ?? []}>
                {(diagnostic) => (
                  <article class="event-line">
                    <span class="font-semibold">
                      {diagnostic.profileId ?? 'provider diagnostics'}
                    </span>
                    <p class="text-xs opacity-70">{diagnostic.status}</p>
                    <p class="text-xs opacity-70">{diagnostic.code}</p>
                    <p class="text-xs opacity-70">{diagnostic.source}</p>
                  </article>
                )}
              </For>
            </div>
          </Show>
        </div>
      </section>

      <Show when={inspectMode() === 'protocol'}>
        <section class="mt-5">
          <h4 class="font-display text-base font-semibold">/api/meta snapshot</h4>
          <pre class="protocol-pre protocol-pre-wrap mt-3">
            {JSON.stringify(props.meta ?? { status: 'loading' }, null, 2)}
          </pre>
        </section>

        <section class="mt-5">
          <div class="ui-section-header mb-3 flex flex-wrap items-center justify-between gap-3">
            <h4 class="font-display text-base font-semibold">Latest event envelopes</h4>
            <span class="badge badge-outline">{latestEvents().length} envelopes</span>
          </div>
          <label class="form-control ui-field">
            <span class="label-text">Filter event family</span>
            <input
              class="input input-bordered input-sm"
              onInput={(event) => setEventFilter(event.currentTarget.value)}
              value={eventFilter()}
            />
          </label>
          <ul aria-label="Latest event envelopes" class="mt-3 space-y-2">
            <Show
              when={filteredEvents().length > 0}
              fallback={
                <li class="empty-state">
                  Events appear here once the server streams turn updates.
                </li>
              }
            >
              <For each={filteredEvents()}>
                {(event) => (
                  <li class="event-line">
                    <span class="font-semibold">{formatEventName(event)}</span>
                    <p class="text-xs opacity-70">#{event.sequence}</p>
                  </li>
                )}
              </For>
            </Show>
          </ul>
        </section>
      </Show>

      <section class="mt-5">
        <div class="ui-section-header mb-3 flex flex-wrap items-center justify-between gap-3">
          <h4 class="font-display text-base font-semibold">Turn lifecycle timeline</h4>
          <span class="badge badge-outline">{props.turns.length} turns</span>
        </div>
        <ul aria-label="Turn lifecycle timeline" class="space-y-2">
          <Show
            when={props.turns.length > 0}
            fallback={<li class="empty-state">No turn lifecycle state yet.</li>}
          >
            <For each={props.turns}>
              {(turn) => (
                <li class="event-line">
                  <span class="font-semibold">{turn.id}</span>
                  <p class="text-xs opacity-70">
                    {turn.status}
                    {turn.completedAt ? ` -> ${turn.completedAt}` : ''}
                  </p>
                  <Show when={turn.error}>
                    {(error) => (
                      <p class="text-xs text-error">
                        {error().code} - {error().message}
                      </p>
                    )}
                  </Show>
                </li>
              )}
            </For>
          </Show>
        </ul>
      </section>
    </section>
  );
}
