import {
  ProviderSubscriptionAccountSchema,
  ProviderSubscriptionAccountsResponseSchema,
} from '@openkit/app-api-schemas';
import { ApiCallError, type CoreClient } from '@openkit/core-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CoreClientProvider } from '../../app/core-client';
import { AiInterfaceScreen } from './AiInterfaceScreen';
import { settingsKeys } from './data';

const TIMESTAMP = '2026-08-30T00:00:00.000Z';
const REFRESHED_AT = '2026-08-30T01:00:00.000Z';
const API_KEY = 'sk-live-provider-key-never-store';
const SERVER_JSONC = `{
  "schemaVersion": 1,
  "mode": "local",
  "defaults": {
    // Keep this comment
    "defaultAgentId": "agent_demo"
  }
}
`;
const PLAN = {
  previousVersion: 1,
  nextVersion: 2,
  applied: [],
  deferred: [],
  requiresRestart: [],
  rejected: [],
  warnings: [],
};
const RUNTIME_CONFIG = {
  currentVersion: 1,
  loadedAt: TIMESTAMP,
  lastReload: null,
  lastFailedReload: null,
  pendingRestart: [],
};
const PROVIDERS = {
  providers: [
    {
      subscriptionProviderId: 'openai-codex' as const,
      displayName: 'OpenAI Codex' as const,
      loginModes: ['device_code'] as ['device_code'],
      quotaCapability: 'available' as const,
    },
    {
      subscriptionProviderId: 'xai' as const,
      displayName: 'xAI' as const,
      loginModes: ['device_code'] as ['device_code'],
      quotaCapability: 'available' as const,
    },
  ],
};
const CODEX_ACCOUNT = {
  subscriptionProviderId: 'openai-codex' as const,
  accountSlotId: 'primary',
  displayName: 'Codex primary',
  boundProviderIds: ['provider_codex'],
  status: 'logged_out' as const,
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};
const PENDING_ACCOUNT = {
  ...CODEX_ACCOUNT,
  status: 'pending' as const,
  interaction: {
    mode: 'device_code' as const,
    interactionId: 'interaction-pending',
    verificationUrl: 'https://example.com/device',
    userCode: 'ABCD-EFGH',
  },
};
const LOGGED_IN_ACCOUNT = {
  ...CODEX_ACCOUNT,
  status: 'logged_in' as const,
};
const CODEX_QUOTA = {
  subscriptionProviderId: 'openai-codex' as const,
  accountSlotId: 'primary',
  availability: 'available' as const,
  observedAt: TIMESTAMP,
  planType: 'plus',
  windows: [
    { id: 'primary', usedPercent: 40.4, remainingPercent: 59.6, resetsAt: TIMESTAMP },
    { id: 'secondary', usedPercent: 99.6, remainingPercent: 0.4 },
  ],
};
const XAI_QUOTA = {
  subscriptionProviderId: 'xai' as const,
  accountSlotId: 'primary',
  availability: 'available' as const,
  observedAt: TIMESTAMP,
  windows: [{ id: 'included', usedPercent: 12.5, remainingPercent: 87.5, resetsAt: TIMESTAMP }],
};
const DIAGNOSTICS = {
  service: 'nanocore',
  boot: {
    bootId: 'boot_1',
    acceptingProductWork: true,
    overall: 'ready',
    subsystems: {
      config: { state: 'ready', reasons: [] },
      storage: { state: 'ready', reasons: [] },
      policy: { state: 'ready', reasons: [] },
      vault: { state: 'ready', reasons: [] },
      scheduler: { state: 'ready', reasons: [] },
      llmGateway: { state: 'ready', reasons: [] },
      knowledgeIndex: { state: 'ready', reasons: [] },
    },
  },
  process: {
    observedAt: TIMESTAMP,
    nodeVersion: 'v24.0.0',
    uptimeSeconds: 1.5,
    memory: {
      rssBytes: 1,
      heapUsedBytes: 1,
      heapTotalBytes: 1,
    },
    telemetry: {
      enabled: false,
      exportConfigured: false,
    },
  },
  gateway: {
    status: 'ok',
    endpoints: ['/v1/chat/completions'],
    defaultModelId: 'default',
    models: [{ id: 'default', displayName: 'Default', capabilities: ['chat'] }],
  },
  providers: {
    diagnostics: [
      {
        code: 'ready',
        message: 'Provider is ready.',
        profileId: 'provider_demo',
        source: 'registry',
        status: 'ready',
      },
    ],
    registry: [
      {
        id: 'provider_demo',
        displayName: 'Demo provider',
        kind: 'custom',
        gatewayCapabilities: { chatCompletions: 'native', responses: 'unsupported' },
        models: ['gpt-demo', 'gpt-strong'],
        defaultModel: 'gpt-demo',
        readiness: { status: 'ready', message: null, checkedAt: TIMESTAMP },
      },
    ],
  },
  capabilities: [],
  runtimeConfig: {
    currentVersion: 3,
    loadedAt: TIMESTAMP,
    lastReload: null,
    lastFailedReload: null,
    pendingRestart: [],
    staleSessions: [],
  },
};

function makeClient(
  overrides: {
    app?: Record<string, unknown>;
    operations?: Record<string, unknown>;
    listProviders?: CoreClient['operations']['provider-subscription.provider-list'];
  } = {}
): CoreClient {
  let currentServerContent = SERVER_JSONC;
  let currentServerRevision = 'revision-1';
  return {
    core: {
      meta: vi.fn().mockResolvedValue({}),
    },
    app: {
      getDiagnostics: vi.fn().mockResolvedValue(DIAGNOSTICS),
      setProviderApiKey: vi
        .fn()
        .mockResolvedValue({ providerId: 'provider_demo', configured: true }),
      ...overrides.app,
    },
    operations: {
      'runtime.file-read': vi.fn().mockImplementation(() =>
        Promise.resolve({
          file: {
            id: 'server.jsonc',
            kind: 'server',
            path: 'server.jsonc',
            exists: true,
            revision: currentServerRevision,
            updatedAt: TIMESTAMP,
          },
          content: currentServerContent,
        })
      ),
      'runtime.validate': vi.fn().mockResolvedValue({
        valid: true,
        diagnostics: [],
        plan: PLAN,
        runtimeConfig: RUNTIME_CONFIG,
      }),
      'runtime.file-update': vi.fn().mockImplementation((input: { content: string }) => {
        currentServerContent = input.content;
        currentServerRevision = 'revision-2';
        return Promise.resolve({
          file: {
            id: 'server.jsonc',
            kind: 'server',
            path: 'server.jsonc',
            exists: true,
            revision: currentServerRevision,
            updatedAt: TIMESTAMP,
          },
          diagnostics: [],
        });
      }),
      'runtime.file-create': vi.fn().mockResolvedValue({
        file: {
          id: 'providers/openrouter.provider.jsonc',
          kind: 'provider',
          path: 'providers/openrouter.provider.jsonc',
          exists: true,
          revision: 'provider-1',
          updatedAt: TIMESTAMP,
        },
        diagnostics: [],
      }),
      'runtime.reload': vi.fn().mockResolvedValue({
        status: 'applied',
        plan: PLAN,
        runtimeConfig: RUNTIME_CONFIG,
      }),
      'provider-subscription.provider-list':
        overrides.listProviders ?? vi.fn().mockResolvedValue(PROVIDERS),
      'provider-subscription.account-list': vi
        .fn()
        .mockImplementation(
          ({ subscriptionProviderId: providerId }: { subscriptionProviderId: string }) =>
            Promise.resolve({
              accounts: providerId === 'openai-codex' ? [CODEX_ACCOUNT] : [],
            })
        ),
      'provider-subscription.account-create': vi.fn().mockResolvedValue({
        ...CODEX_ACCOUNT,
        accountSlotId: 'secondary',
        displayName: 'Codex secondary',
      }),
      'provider-subscription.account-update': vi.fn().mockResolvedValue({
        ...CODEX_ACCOUNT,
        displayName: 'Renamed Codex',
      }),
      'provider-subscription.account-delete': vi.fn().mockResolvedValue(null),
      'provider-subscription.account-status': vi
        .fn()
        .mockImplementation(
          ({
            subscriptionProviderId: provider,
            accountSlotId: slot,
          }: {
            subscriptionProviderId: string;
            accountSlotId: string;
          }) =>
            Promise.resolve({
              ...(provider === 'xai' ? CODEX_ACCOUNT : CODEX_ACCOUNT),
              subscriptionProviderId: provider,
              accountSlotId: slot,
            })
        ),
      'provider-subscription.account-login-start': vi.fn().mockResolvedValue(PENDING_ACCOUNT),
      'provider-subscription.account-login-cancel': vi.fn().mockResolvedValue(CODEX_ACCOUNT),
      'provider-subscription.account-logout': vi.fn().mockResolvedValue(CODEX_ACCOUNT),
      'provider-subscription.account-quota': vi
        .fn()
        .mockImplementation(
          ({
            subscriptionProviderId: providerId,
            accountSlotId,
          }: {
            subscriptionProviderId: string;
            accountSlotId: string;
          }) =>
            Promise.resolve(
              providerId === 'xai'
                ? { ...XAI_QUOTA, accountSlotId }
                : { ...CODEX_QUOTA, accountSlotId }
            )
        ),
      ...overrides.operations,
    },
  } as unknown as CoreClient;
}

function renderScreen(
  client: CoreClient,
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
) {
  const rendered = render(
    <QueryClientProvider client={queryClient}>
      <CoreClientProvider client={client}>
        <AiInterfaceScreen />
      </CoreClientProvider>
    </QueryClientProvider>
  );
  return { ...rendered, queryClient };
}

beforeEach(() => {
  localStorage.clear();
});

describe('AI interface deployment-admin workflow', () => {
  describe.each(['openai-codex', 'xai'] as const)('%s inference observations', (providerId) => {
    const accessAt = '2026-10-02T01:00:00.000Z';
    const exhaustedAt = '2026-10-02T02:00:00.000Z';
    const quotaResponse = providerId === 'xai' ? XAI_QUOTA : CODEX_QUOTA;
    const quotaLabel =
      providerId === 'xai' ? 'Included 87.5% remaining' : 'Primary 59.6% remaining';
    const providerName = providerId === 'xai' ? 'xAI' : 'OpenAI Codex';

    it.each([
      { state: 'access rejection alone', access: true, exhausted: false },
      { state: 'quota exhaustion alone', access: false, exhausted: true },
      { state: 'both parts', access: true, exhausted: true },
      { state: 'absence', access: false, exhausted: false },
    ])('shows $state beside unchanged live quota without requesting it', async ({
      access,
      exhausted,
    }) => {
      const user = userEvent.setup();
      const account = ProviderSubscriptionAccountSchema.parse({
        ...LOGGED_IN_ACCOUNT,
        subscriptionProviderId: providerId,
        ...(access || exhausted
          ? {
              inferenceObservation: {
                ...(access ? { accessRejected: { observedAt: accessAt } } : {}),
                ...(exhausted ? { quotaExhausted: { observedAt: exhaustedAt } } : {}),
              },
            }
          : {}),
      });
      const getAccountQuota = vi.fn().mockResolvedValue(quotaResponse);
      const client = makeClient({
        operations: {
          'provider-subscription.account-list': vi
            .fn()
            .mockImplementation(
              ({ subscriptionProviderId: id }: { subscriptionProviderId: string }) =>
                Promise.resolve(
                  ProviderSubscriptionAccountsResponseSchema.parse({
                    accounts: id === providerId ? [account] : [],
                  })
                )
            ),
          'provider-subscription.account-status': vi.fn().mockResolvedValue(account),
          'provider-subscription.account-quota': getAccountQuota,
          'provider-subscription.account-login-start': vi.fn().mockResolvedValue(
            ProviderSubscriptionAccountSchema.parse({
              ...PENDING_ACCOUNT,
              subscriptionProviderId: providerId,
            })
          ),
        },
      });
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      // Reuse a supplied live quota response to isolate rendering from the existing page-load read.
      queryClient.setQueryData(
        [...settingsKeys.aiInterface, 'quota', providerId, 'primary'],
        quotaResponse
      );
      renderScreen(client, queryClient);
      const card = await screen.findByRole('region', { name: providerName });
      await waitFor(() =>
        expect(client.operations['provider-subscription.account-status']).toHaveBeenCalled()
      );
      expect(within(card).getByText(quotaLabel)).toBeInTheDocument();
      expect(card.querySelector(`time[datetime="${TIMESTAMP}"]`)).toBeInTheDocument();
      if (access) expect(within(card).queryByText('Inference access rejected')).toBeInTheDocument();
      else expect(within(card).queryByText('Inference access rejected')).not.toBeInTheDocument();
      if (exhausted)
        expect(within(card).queryByText('Inference quota exhausted')).toBeInTheDocument();
      else expect(within(card).queryByText('Inference quota exhausted')).not.toBeInTheDocument();
      if (access) expect(card.querySelector(`time[datetime="${accessAt}"]`)).toBeInTheDocument();
      else expect(card.querySelector(`time[datetime="${accessAt}"]`)).not.toBeInTheDocument();
      if (exhausted)
        expect(card.querySelector(`time[datetime="${exhaustedAt}"]`)).toBeInTheDocument();
      else expect(card.querySelector(`time[datetime="${exhaustedAt}"]`)).not.toBeInTheDocument();
      if (access)
        expect(within(card).queryByRole('button', { name: 'Sign in again' })).toBeInTheDocument();
      else
        expect(
          within(card).queryByRole('button', { name: 'Sign in again' })
        ).not.toBeInTheDocument();
      expect(getAccountQuota).not.toHaveBeenCalled();
      expect(client.operations['provider-subscription.account-logout']).not.toHaveBeenCalled();
      expect(client.operations['runtime.file-update']).not.toHaveBeenCalled();
      await user.click(screen.getByRole('button', { name: 'Refresh status' }));
      await waitFor(() =>
        expect(client.operations['provider-subscription.account-list']).toHaveBeenCalledTimes(4)
      );
      expect(getAccountQuota).not.toHaveBeenCalled();
      if (access) {
        expect(
          within(card).getByText(/Inference was rejected for the current credential/)
        ).toBeInTheDocument();
        await user.click(within(card).getByRole('button', { name: 'Sign in again' }));
        expect(
          client.operations['provider-subscription.account-login-start']
        ).toHaveBeenCalledExactlyOnceWith({
          subscriptionProviderId: providerId,
          accountSlotId: 'primary',
          ...{ mode: 'device_code' },
        });
        expect(getAccountQuota).not.toHaveBeenCalled();
      } else {
        expect(
          client.operations['provider-subscription.account-login-start']
        ).not.toHaveBeenCalled();
      }
      if (exhausted) {
        await user.click(within(card).getByRole('button', { name: 'Refresh quota' }));
        await waitFor(() =>
          expect(getAccountQuota).toHaveBeenCalledExactlyOnceWith({
            subscriptionProviderId: providerId,
            accountSlotId: 'primary',
          })
        );
        expect(within(card).getByText(quotaLabel)).toBeInTheDocument();
      }
    });

    it('projects list observations, replaces them from detail and honors owner-cleared absence', async () => {
      const user = userEvent.setup();
      const account = ProviderSubscriptionAccountSchema.parse({
        ...LOGGED_IN_ACCOUNT,
        subscriptionProviderId: providerId,
        inferenceObservation: { accessRejected: { observedAt: accessAt } },
      });
      const detail = ProviderSubscriptionAccountSchema.parse({
        ...account,
        inferenceObservation: { quotaExhausted: { observedAt: exhaustedAt } },
      });
      const cleared = ProviderSubscriptionAccountSchema.parse({
        ...LOGGED_IN_ACCOUNT,
        subscriptionProviderId: providerId,
      });
      let resolveDetail!: (value: typeof detail) => void;
      const getAccountStatus = vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<typeof detail>((resolve) => {
              resolveDetail = resolve;
            })
        )
        .mockResolvedValue(cleared);
      const getAccountQuota = vi.fn();
      const client = makeClient({
        operations: {
          'provider-subscription.account-list': vi
            .fn()
            .mockImplementation(
              ({ subscriptionProviderId: id }: { subscriptionProviderId: string }) =>
                Promise.resolve(
                  ProviderSubscriptionAccountsResponseSchema.parse({
                    accounts: id === providerId ? [account] : [],
                  })
                )
            ),
          'provider-subscription.account-status': getAccountStatus,
          'provider-subscription.account-quota': getAccountQuota,
        },
      });
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      queryClient.setQueryData([...settingsKeys.aiInterface, 'quota', providerId, 'primary'], {
        subscriptionProviderId: providerId,
        accountSlotId: 'primary',
        availability: 'temporarily_unavailable',
        observedAt: TIMESTAMP,
      });
      renderScreen(client, queryClient);
      const card = await screen.findByRole('region', { name: providerName });
      expect(within(card).getByText('Inference access rejected')).toBeInTheDocument();
      expect(within(card).getByRole('button', { name: 'Sign in again' })).toBeInTheDocument();
      resolveDetail(detail);
      await waitFor(() =>
        expect(within(card).getByText('Inference quota exhausted')).toBeInTheDocument()
      );
      expect(within(card).queryByText('Inference access rejected')).not.toBeInTheDocument();
      expect(within(card).queryByRole('button', { name: 'Sign in again' })).not.toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Refresh status' }));
      await waitFor(() =>
        expect(within(card).queryByText('Inference quota exhausted')).not.toBeInTheDocument()
      );
      expect(within(card).queryByText('Inference access rejected')).not.toBeInTheDocument();
      expect(within(card).getByText('Login saved')).toBeInTheDocument();
      expect(within(card).queryByText('Connected')).not.toBeInTheDocument();
      expect(within(card).queryByRole('meter')).not.toBeInTheDocument();
      expect(getAccountQuota).not.toHaveBeenCalled();
    });
  });

  it('offers pair-scoped re-login when Codex rejects a saved login', async () => {
    const user = userEvent.setup();
    const startAccountLogin = vi.fn().mockResolvedValue(PENDING_ACCOUNT);
    const client = makeClient({
      operations: {
        'provider-subscription.account-list': vi
          .fn()
          .mockImplementation(
            ({ subscriptionProviderId: providerId }: { subscriptionProviderId: string }) =>
              Promise.resolve({
                accounts: providerId === 'openai-codex' ? [LOGGED_IN_ACCOUNT] : [],
              })
          ),
        'provider-subscription.account-status': vi.fn().mockResolvedValue(LOGGED_IN_ACCOUNT),
        'provider-subscription.account-quota': vi.fn().mockResolvedValue({
          subscriptionProviderId: 'openai-codex',
          accountSlotId: 'primary',
          availability: 'authentication_required',
          observedAt: TIMESTAMP,
        }),
        'provider-subscription.account-login-start': startAccountLogin,
      },
    });
    renderScreen(client);
    const codex = await screen.findByRole('region', { name: 'OpenAI Codex' });
    expect(within(codex).getByText('Access rejected')).toBeInTheDocument();
    expect(within(codex).getByText(/login may still be refreshable/)).toBeInTheDocument();
    expect(within(codex).queryByText('Connected')).not.toBeInTheDocument();
    expect(within(codex).queryByRole('meter')).not.toBeInTheDocument();
    expect(within(codex).getByText(/Last checked/)).toBeInTheDocument();
    await user.click(within(codex).getByRole('button', { name: 'Sign in again' }));
    expect(startAccountLogin).toHaveBeenCalledExactlyOnceWith({
      subscriptionProviderId: 'openai-codex',
      accountSlotId: 'primary',
      ...{
        mode: 'device_code',
      },
    });
  });

  it('keeps a temporary Codex quota failure separate from rejected authentication', async () => {
    const client = makeClient({
      operations: {
        'provider-subscription.account-list': vi
          .fn()
          .mockImplementation(
            ({ subscriptionProviderId: providerId }: { subscriptionProviderId: string }) =>
              Promise.resolve({
                accounts: providerId === 'openai-codex' ? [LOGGED_IN_ACCOUNT] : [],
              })
          ),
        'provider-subscription.account-status': vi.fn().mockResolvedValue(LOGGED_IN_ACCOUNT),
        'provider-subscription.account-quota': vi.fn().mockResolvedValue({
          subscriptionProviderId: 'openai-codex',
          accountSlotId: 'primary',
          availability: 'temporarily_unavailable',
          observedAt: TIMESTAMP,
        }),
      },
    });
    renderScreen(client);
    const codex = await screen.findByRole('region', { name: 'OpenAI Codex' });
    expect(within(codex).getByText('Login saved')).toBeInTheDocument();
    expect(within(codex).getByText('Quota query failed')).toBeInTheDocument();
    expect(within(codex).queryByText('Access rejected')).not.toBeInTheDocument();
    expect(within(codex).queryByRole('button', { name: 'Sign in again' })).not.toBeInTheDocument();
  });

  it.each([
    { seconds: 18_000, label: '5-hour' },
    { seconds: 604_800, label: 'Weekly' },
    { seconds: 900, label: '15-minute' },
    { seconds: 937, label: '937-second' },
    { seconds: undefined, label: 'Primary' },
  ])('labels Codex with only the supplied duration ($label)', async ({ seconds, label }) => {
    const client = makeClient({
      operations: {
        'provider-subscription.account-quota': vi.fn().mockResolvedValue({
          ...CODEX_QUOTA,
          windows: [
            {
              ...CODEX_QUOTA.windows[0],
              ...(seconds === undefined ? {} : { limitWindowSeconds: seconds }),
            },
            CODEX_QUOTA.windows[1],
          ],
        }),
      },
    });
    renderScreen(client);
    const codex = await screen.findByRole('region', { name: 'OpenAI Codex' });
    expect(within(codex).getByText(`${label} 59.6% remaining`)).toBeInTheDocument();
    expect(
      within(codex).getByRole('meter', { name: `${label} remaining 59.6%` })
    ).toBeInTheDocument();
    expect(within(codex).getByText('Secondary 0.4% remaining')).toBeInTheDocument();
    expect(within(codex).getByText('Resets').querySelector('time')).toHaveAttribute(
      'datetime',
      TIMESTAMP
    );
  });

  it('shows one percentage per quota window for Codex and xAI', async () => {
    const client = makeClient({
      operations: {
        'provider-subscription.account-list': vi
          .fn()
          .mockImplementation(
            ({ subscriptionProviderId: providerId }: { subscriptionProviderId: string }) =>
              Promise.resolve({
                accounts: [{ ...CODEX_ACCOUNT, subscriptionProviderId: providerId }],
              })
          ),
      },
    });
    renderScreen(client);
    const codex = await screen.findByRole('region', { name: 'OpenAI Codex' });
    const xai = screen.getByRole('region', { name: 'xAI' });
    expect(within(codex).getByText('Primary 59.6% remaining')).toBeInTheDocument();
    expect(within(codex).queryByText('40.4% used')).not.toBeInTheDocument();
    expect(within(xai).getByText('Included 87.5% remaining')).toBeInTheDocument();
    expect(within(xai).queryByText('12.5% used')).not.toBeInTheDocument();
  });

  it('keeps account management available when one quota read fails without an observation', async () => {
    const user = userEvent.setup();
    const client = makeClient({
      operations: {
        'provider-subscription.account-list': vi
          .fn()
          .mockImplementation(
            ({ subscriptionProviderId: providerId }: { subscriptionProviderId: string }) =>
              Promise.resolve({
                accounts: [{ ...CODEX_ACCOUNT, subscriptionProviderId: providerId }],
              })
          ),
        'provider-subscription.account-quota': vi
          .fn()
          .mockImplementation(
            ({ subscriptionProviderId: providerId }: { subscriptionProviderId: string }) =>
              providerId === 'xai'
                ? Promise.reject(new ApiCallError(500, 'private-quota-error-canary'))
                : Promise.resolve(CODEX_QUOTA)
          ),
      },
    });
    renderScreen(client);
    const xai = await screen.findByRole('region', { name: 'xAI' });
    expect(within(xai).getByText('Quota query failed')).toBeInTheDocument();
    expect(within(xai).queryByRole('time')).not.toBeInTheDocument();
    expect(screen.getByRole('meter', { name: 'Primary remaining 59.6%' })).toBeInTheDocument();
    expect(screen.queryByText(/private-quota-error-canary/)).not.toBeInTheDocument();
    await user.click(within(xai).getByText('Account settings'));
    expect(within(xai).getByRole('button', { name: 'Rename account' })).toBeEnabled();
  });

  it.each([401, 403])('keeps quota HTTP %s access denial global', async (status) => {
    renderScreen(
      makeClient({
        operations: {
          'provider-subscription.account-quota': vi
            .fn()
            .mockRejectedValue(new ApiCallError(status, 'private-denial')),
        },
      })
    );
    expect(await screen.findByText('Access denied')).toBeInTheDocument();
    expect(screen.queryByText('Account settings')).not.toBeInTheDocument();
    expect(screen.queryByText(/private-denial/)).not.toBeInTheDocument();
  });

  it.each([401, 403])('closes account controls after a refresh returns HTTP %s', async (status) => {
    const user = userEvent.setup();
    const getAccountQuota = vi
      .fn()
      .mockResolvedValueOnce(CODEX_QUOTA)
      .mockRejectedValue(new ApiCallError(status, 'private-denial'));
    renderScreen(
      makeClient({ operations: { 'provider-subscription.account-quota': getAccountQuota } })
    );
    await user.click(await screen.findByRole('button', { name: 'Refresh quota' }));
    expect(await screen.findByText('Access denied')).toBeInTheDocument();
    expect(screen.queryByText('Account settings')).not.toBeInTheDocument();
    getAccountQuota.mockResolvedValue(CODEX_QUOTA);
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Account settings')).toBeInTheDocument();
  });

  it('shows access denied with retry and never asks for a server-admin token', async () => {
    const user = userEvent.setup();
    const listProviders = vi.fn().mockRejectedValue(
      new ApiCallError(403, 'Current deployment administrator authority is required.', {
        code: 'deployment_admin_required',
      })
    );
    const client = makeClient({ listProviders });
    renderScreen(client);

    expect(await screen.findByText('Access denied')).toBeInTheDocument();
    expect(screen.queryByLabelText('Server admin token')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(listProviders).toHaveBeenCalledTimes(2));
  });

  it('creates, renames, and deletes a provider-subscription slot', async () => {
    const user = userEvent.setup();
    const client = makeClient();
    renderScreen(client);

    const codex = await screen.findByRole('region', { name: 'OpenAI Codex' });
    await user.click(within(codex).getByText('Add account slot'));
    await user.type(within(codex).getByLabelText('Account slot id'), 'secondary');
    await user.type(within(codex).getByLabelText('Display name'), 'Codex secondary');
    await user.click(within(codex).getByRole('button', { name: 'Create account slot' }));

    await waitFor(() =>
      expect(client.operations['provider-subscription.account-create']).toHaveBeenCalledWith({
        subscriptionProviderId: 'openai-codex',
        ...{
          accountSlotId: 'secondary',
          displayName: 'Codex secondary',
        },
      })
    );

    await user.click(within(codex).getByText('Account settings'));
    const rename = within(codex).getByLabelText('Account display name');
    await user.clear(rename);
    await user.type(rename, 'Renamed Codex');
    await user.click(within(codex).getByRole('button', { name: 'Rename account' }));
    await waitFor(() =>
      expect(client.operations['provider-subscription.account-update']).toHaveBeenCalledWith({
        subscriptionProviderId: 'openai-codex',
        accountSlotId: 'primary',
        ...{ displayName: 'Renamed Codex' },
      })
    );

    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await user.click(within(codex).getByRole('button', { name: 'Remove account' }));
    await waitFor(() =>
      expect(client.operations['provider-subscription.account-delete']).toHaveBeenCalledWith({
        subscriptionProviderId: 'openai-codex',
        accountSlotId: 'primary',
      })
    );
  });

  it('starts device-code login, shows the verification URL and user code, polls status, and can cancel', async () => {
    const user = userEvent.setup();
    const getAccountStatus = vi
      .fn()
      .mockResolvedValueOnce(CODEX_ACCOUNT)
      .mockResolvedValue(PENDING_ACCOUNT);
    const client = makeClient({
      operations: {
        'provider-subscription.account-list': vi
          .fn()
          .mockImplementation(
            ({ subscriptionProviderId: providerId }: { subscriptionProviderId: string }) =>
              Promise.resolve({
                accounts: providerId === 'openai-codex' ? [CODEX_ACCOUNT] : [],
              })
          ),
        'provider-subscription.account-status': getAccountStatus,
        'provider-subscription.account-login-start': vi.fn().mockResolvedValue(PENDING_ACCOUNT),
      },
    });
    renderScreen(client);

    const codex = await screen.findByRole('region', { name: 'OpenAI Codex' });
    await user.click(within(codex).getByRole('button', { name: 'Start login' }));

    expect(await screen.findByText('ABCD-EFGH')).toBeInTheDocument();
    const verification = screen.getByRole('link', { name: 'https://example.com/device' });
    expect(verification).toHaveAttribute('href', 'https://example.com/device');
    expect(client.operations['provider-subscription.account-login-start']).toHaveBeenCalledWith({
      subscriptionProviderId: 'openai-codex',
      accountSlotId: 'primary',
      ...{ mode: 'device_code' },
    });

    await waitFor(() => expect(getAccountStatus).toHaveBeenCalled(), { timeout: 4000 });
    expect(getAccountStatus).toHaveBeenCalledWith({
      subscriptionProviderId: 'openai-codex',
      accountSlotId: 'primary',
    });

    await user.click(within(codex).getByRole('button', { name: 'Cancel login' }));
    await waitFor(() =>
      expect(client.operations['provider-subscription.account-login-cancel']).toHaveBeenCalledWith({
        subscriptionProviderId: 'openai-codex',
        accountSlotId: 'primary',
        ...{ interactionId: 'interaction-pending' },
      })
    );
  });

  it('shows a failed device-code status poll and retries it explicitly', async () => {
    const user = userEvent.setup();
    const getAccountStatus = vi
      .fn()
      .mockRejectedValueOnce(new ApiCallError(500, 'Status failed.'))
      .mockResolvedValue(PENDING_ACCOUNT);
    const client = makeClient({
      operations: {
        'provider-subscription.account-list': vi
          .fn()
          .mockImplementation(
            ({ subscriptionProviderId: providerId }: { subscriptionProviderId: string }) =>
              Promise.resolve({
                accounts: providerId === 'openai-codex' ? [PENDING_ACCOUNT] : [],
              })
          ),
        'provider-subscription.account-status': getAccountStatus,
      },
    });
    renderScreen(client);

    expect(await screen.findByText("Couldn't refresh login status.")).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(getAccountStatus).toHaveBeenCalledTimes(2));
  });

  it('logs out and refreshes quota without swallowing a failed mutation', async () => {
    const user = userEvent.setup();
    const logoutAccount = vi
      .fn()
      .mockRejectedValueOnce(new ApiCallError(500, 'Internal Server Error'))
      .mockResolvedValue(CODEX_ACCOUNT);
    const client = makeClient({
      operations: {
        'provider-subscription.account-list': vi
          .fn()
          .mockImplementation(
            ({ subscriptionProviderId: providerId }: { subscriptionProviderId: string }) =>
              Promise.resolve({
                accounts: providerId === 'openai-codex' ? [LOGGED_IN_ACCOUNT] : [],
              })
          ),
        'provider-subscription.account-status': vi.fn().mockResolvedValue(LOGGED_IN_ACCOUNT),
        'provider-subscription.account-logout': logoutAccount,
      },
    });
    renderScreen(client);

    const codex = await screen.findByRole('region', { name: 'OpenAI Codex' });
    expect(within(codex).queryByRole('button', { name: 'Start login' })).not.toBeInTheDocument();
    await user.click(within(codex).getByText('Account settings'));
    await user.click(within(codex).getByRole('button', { name: 'Log out' }));
    expect(await screen.findByText(/Couldn't log out this account/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(logoutAccount).toHaveBeenCalledTimes(2));
  });

  it('refreshes only the selected quota pair and updates last checked and reset times', async () => {
    const user = userEvent.setup();
    const listProviders = vi.fn().mockResolvedValue(PROVIDERS);
    const listAccounts = vi
      .fn()
      .mockImplementation(
        ({ subscriptionProviderId: providerId }: { subscriptionProviderId: string }) =>
          Promise.resolve({
            accounts: providerId === 'openai-codex' ? [LOGGED_IN_ACCOUNT] : [],
          })
      );
    let codexQuotaReads = 0;
    const getAccountQuota = vi
      .fn()
      .mockImplementation(
        ({
          subscriptionProviderId: providerId,
          accountSlotId,
        }: {
          subscriptionProviderId: string;
          accountSlotId: string;
        }) => {
          if (providerId === 'openai-codex' && accountSlotId === 'primary') {
            codexQuotaReads += 1;
            return Promise.resolve(
              codexQuotaReads === 1
                ? CODEX_QUOTA
                : {
                    ...CODEX_QUOTA,
                    observedAt: REFRESHED_AT,
                    windows: [
                      {
                        id: 'primary',
                        usedPercent: 40.4,
                        remainingPercent: 59.6,
                        resetsAt: REFRESHED_AT,
                      },
                      { id: 'secondary', usedPercent: 99.6, remainingPercent: 0.4 },
                    ],
                  }
            );
          }
          return Promise.resolve({ ...XAI_QUOTA, accountSlotId });
        }
      );
    const client = makeClient({
      listProviders,
      operations: {
        'provider-subscription.account-list': listAccounts,
        'provider-subscription.account-quota': getAccountQuota,
      },
    });
    renderScreen(client);

    const codex = await screen.findByRole('region', { name: 'OpenAI Codex' });
    expect(await screen.findByText('Last checked', { exact: false })).toBeInTheDocument();
    expect(
      within(codex)
        .getAllByRole('time')
        .some((node) => node.getAttribute('datetime') === TIMESTAMP)
    ).toBe(true);
    const accountsAfterLoad = listAccounts.mock.calls.length;
    const quotaAfterLoad = getAccountQuota.mock.calls.length;
    expect(quotaAfterLoad).toBe(1);
    expect(codexQuotaReads).toBe(1);

    await user.click(within(codex).getByRole('button', { name: 'Refresh quota' }));
    await waitFor(() => {
      expect(
        within(codex)
          .getAllByRole('time')
          .some((node) => node.getAttribute('datetime') === REFRESHED_AT)
      ).toBe(true);
    });
    expect(codexQuotaReads).toBe(2);
    expect(getAccountQuota).toHaveBeenCalledTimes(quotaAfterLoad + 1);
    expect(getAccountQuota).toHaveBeenLastCalledWith({
      subscriptionProviderId: 'openai-codex',
      accountSlotId: 'primary',
    });
    expect(listAccounts.mock.calls.length).toBe(accountsAfterLoad);
    expect(listProviders).toHaveBeenCalledTimes(1);
  });

  it('shows configured provider profiles and the logical Gateway catalog', async () => {
    const client = makeClient();
    renderScreen(client);

    expect((await screen.findAllByText('Demo provider')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('gpt-strong').length).toBeGreaterThan(0);
    expect(screen.getByText('Default: default')).toBeInTheDocument();
    expect(screen.getByText(/Provider is ready\./)).toBeInTheDocument();
    expect(client.operations['runtime.file-update']).not.toHaveBeenCalled();
    expect(client.operations['runtime.reload']).not.toHaveBeenCalled();
  });

  it('creates an oauth provider profile bound to an existing subscription account slot', async () => {
    const user = userEvent.setup();
    const client = makeClient();
    renderScreen(client);

    await user.type(await screen.findByLabelText('Provider id'), 'codex-work');
    await user.type(screen.getByLabelText('Provider display name'), 'Codex work');
    await user.click(screen.getByRole('button', { name: /Provider kind/ }));
    await user.click(
      within(await screen.findByRole('listbox')).getByRole('option', { name: 'oauth' })
    );
    expect(screen.queryByLabelText('Vendor')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Base URL')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Subscription account/ }));
    await user.click(
      within(await screen.findByRole('listbox')).getByRole('option', {
        name: 'OpenAI Codex · primary',
      })
    );
    await user.type(screen.getByLabelText('Provider models'), 'gpt-5');
    await user.type(screen.getByLabelText('Default model'), 'gpt-5');
    await user.click(screen.getByRole('button', { name: 'Create provider profile' }));

    await waitFor(() => expect(client.operations['runtime.file-create']).toHaveBeenCalled());
    const created = vi.mocked(client.operations['runtime.file-create']).mock.calls[0]?.[0];
    expect(created).toMatchObject({
      id: 'providers/codex-work.provider.jsonc',
      kind: 'provider',
    });
    expect(created?.content).toContain('"kind": "oauth"');
    expect(created?.content).toContain('"vendor": "openai_codex"');
    expect(created?.content).toContain('"accountSlotId": "primary"');
    expect(created?.content).not.toContain('secretRef');
    expect(created?.content).not.toContain('baseUrl');
    expect(await screen.findByText(/Provider persisted revision:/)).toBeInTheDocument();
  });

  it('creates a provider profile file with vault://provider_<id> for API-key kinds', async () => {
    const user = userEvent.setup();
    const client = makeClient();
    renderScreen(client);

    await user.type(await screen.findByLabelText('Provider id'), 'openrouter');
    await user.type(screen.getByLabelText('Provider display name'), 'OpenRouter');
    await user.click(screen.getByRole('button', { name: /Provider kind/ }));
    await user.click(
      within(await screen.findByRole('listbox')).getByRole('option', { name: 'custom' })
    );
    await user.type(screen.getByLabelText('Vendor'), 'openrouter');
    await user.type(screen.getByLabelText('Base URL'), 'https://openrouter.ai/api/v1');
    await user.type(screen.getByLabelText('Provider models'), 'openai/gpt-5.1, openai/gpt-4.1');
    await user.type(screen.getByLabelText('Default model'), 'openai/gpt-5.1');
    await user.click(screen.getByRole('button', { name: 'Create provider profile' }));

    await waitFor(() => expect(client.operations['runtime.file-create']).toHaveBeenCalled());
    const created = vi.mocked(client.operations['runtime.file-create']).mock.calls[0]?.[0];
    expect(created).toMatchObject({
      id: 'providers/openrouter.provider.jsonc',
      kind: 'provider',
    });
    expect(created?.content).toContain('"id": "openrouter"');
    expect(created?.content).toContain('"secretRef": "vault://provider_openrouter"');
    expect(created?.content).toContain('"defaultModel": "openai/gpt-5.1"');
  });

  it('rejects provider ids that cannot form a writable redacted API-key profile', async () => {
    const user = userEvent.setup();
    const client = makeClient();
    renderScreen(client);

    const id = await screen.findByLabelText('Provider id');
    await user.type(id, 'openrouter.ai');
    await user.type(screen.getByLabelText('Provider display name'), 'OpenRouter');
    await user.type(screen.getByLabelText('Provider models'), 'model-demo');
    await user.type(screen.getByLabelText('Default model'), 'model-demo');

    expect(
      screen.getByText(/Use 1–119 letters, numbers, underscores, or hyphens/)
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create provider profile' })).toBeDisabled();
    await user.clear(id);
    await user.type(id, 'foo-sk-demo');
    expect(screen.getByRole('button', { name: 'Create provider profile' })).toBeDisabled();
    await user.clear(id);
    await user.type(id, 'openrouter');
    expect(screen.getByRole('button', { name: 'Create provider profile' })).toBeEnabled();
    expect(client.operations['runtime.file-create']).not.toHaveBeenCalled();
  });

  it('submits a masked API key through setProviderApiKey and never keeps it in query or rendered state', async () => {
    const user = userEvent.setup();
    const client = makeClient();
    const { queryClient } = renderScreen(client);

    const keyField = await screen.findByLabelText('Provider API key');
    await user.type(keyField, API_KEY);
    await user.click(screen.getByRole('button', { name: 'Save or Replace API key' }));

    const apiKeys = client.app as unknown as {
      setProviderApiKey: ReturnType<typeof vi.fn>;
    };
    await waitFor(() =>
      expect(apiKeys.setProviderApiKey).toHaveBeenCalledWith('provider_demo', { apiKey: API_KEY })
    );
    expect(keyField).toHaveValue('');
    expect(document.body.textContent).not.toContain(API_KEY);
    expect(
      JSON.stringify(
        queryClient
          .getQueryCache()
          .findAll()
          .map((query) => query.queryKey)
      )
    ).not.toContain(API_KEY);
    expect(
      JSON.stringify(
        queryClient
          .getMutationCache()
          .getAll()
          .map((mutation) => ({ data: mutation.state.data, variables: mutation.state.variables }))
      )
    ).not.toContain(API_KEY);
    expect(
      JSON.stringify(
        queryClient
          .getQueryCache()
          .findAll()
          .map((query) => query.state.data)
      )
    ).not.toContain(API_KEY);
    expect(screen.queryByRole('button', { name: 'Remove API key' })).not.toBeInTheDocument();
    expect('clearProviderApiKey' in client.app).toBe(false);
  });

  it('does not refetch the account inventory in a loop after login status becomes terminal', async () => {
    const listAccounts = vi
      .fn()
      .mockImplementation(
        ({ subscriptionProviderId: providerId }: { subscriptionProviderId: string }) =>
          Promise.resolve({
            accounts: providerId === 'openai-codex' ? [PENDING_ACCOUNT] : [],
          })
      );
    const getAccountStatus = vi.fn().mockResolvedValue(LOGGED_IN_ACCOUNT);
    const client = makeClient({
      operations: {
        'provider-subscription.account-list': listAccounts,
        'provider-subscription.account-status': getAccountStatus,
      },
    });
    renderScreen(client);

    const codex = await screen.findByRole('region', { name: 'OpenAI Codex' });
    await waitFor(() =>
      expect(getAccountStatus).toHaveBeenCalledWith({
        subscriptionProviderId: 'openai-codex',
        accountSlotId: 'primary',
      })
    );
    const settled = listAccounts.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(listAccounts.mock.calls.length).toBe(settled);
    expect(within(codex).queryByRole('button', { name: 'Start login' })).not.toBeInTheDocument();
  });

  it('keeps quota refresh and login reachable while secondary account controls stay collapsed', async () => {
    const user = userEvent.setup();
    const client = makeClient();
    renderScreen(client);

    const codex = await screen.findByRole('region', { name: 'OpenAI Codex' });
    expect(within(codex).getByRole('button', { name: 'Refresh quota' })).toBeInTheDocument();
    expect(within(codex).getByRole('button', { name: 'Start login' })).toBeInTheDocument();
    expect(
      within(codex).getByRole('meter', { name: 'Primary remaining 59.6%' })
    ).toBeInTheDocument();
    const settings = within(codex).getByText('Account settings').closest('details');
    const createSlot = within(codex).getByText('Add account slot').closest('details');
    expect(settings).not.toBeNull();
    expect(createSlot).not.toBeNull();
    expect(settings?.open).toBe(false);
    expect(createSlot?.open).toBe(false);
    await user.click(within(codex).getByText('Account settings'));
    expect(settings?.open).toBe(true);
    expect(within(codex).getByRole('button', { name: 'Remove account' })).toBeInTheDocument();
    await user.click(within(codex).getByText('Add account slot'));
    expect(createSlot?.open).toBe(true);
    expect(within(codex).getByRole('textbox', { name: 'Account slot id' })).toBeInTheDocument();
  });

  it('formats remaining percents without rounding tiny or near-full values to 0 or 100', async () => {
    const client = makeClient({
      operations: {
        'provider-subscription.account-list': vi
          .fn()
          .mockImplementation(
            ({ subscriptionProviderId: providerId }: { subscriptionProviderId: string }) =>
              Promise.resolve({
                accounts: providerId === 'openai-codex' ? [CODEX_ACCOUNT] : [],
              })
          ),
        'provider-subscription.account-quota': vi.fn().mockResolvedValue({
          ...CODEX_QUOTA,
          windows: [
            { id: 'primary', remainingPercent: 99.996 },
            { id: 'secondary', remainingPercent: 0.004, usedPercent: 7.1 },
            { id: 'usage-only', usedPercent: 7.1 },
          ],
        }),
      },
    });
    renderScreen(client);

    const codex = await screen.findByRole('region', { name: 'OpenAI Codex' });
    expect(within(codex).getByText('Primary >99.99% remaining')).toBeInTheDocument();
    expect(within(codex).getByText('Secondary <0.01% remaining')).toBeInTheDocument();
    expect(
      within(codex).getByRole('meter', { name: 'Primary remaining >99.99%' })
    ).toBeInTheDocument();
    expect(
      within(codex).getByRole('meter', { name: 'Secondary remaining <0.01%' })
    ).toBeInTheDocument();
    expect(within(codex).getByText('7.1% used')).toBeInTheDocument();
    expect(within(codex).queryByText(/92\.9/)).not.toBeInTheDocument();
  });

  it('shows unknown usage with reset and last checked when xAI omits credit percent', async () => {
    const client = makeClient({
      operations: {
        'provider-subscription.account-list': vi
          .fn()
          .mockImplementation(
            ({ subscriptionProviderId: providerId }: { subscriptionProviderId: string }) =>
              Promise.resolve({
                accounts:
                  providerId === 'openai-codex'
                    ? [CODEX_ACCOUNT]
                    : [
                        {
                          ...CODEX_ACCOUNT,
                          subscriptionProviderId: 'xai' as const,
                          displayName: 'xAI primary',
                        },
                      ],
              })
          ),
        'provider-subscription.account-quota': vi
          .fn()
          .mockImplementation(
            ({ subscriptionProviderId: providerId }: { subscriptionProviderId: string }) =>
              Promise.resolve(
                providerId === 'xai'
                  ? {
                      subscriptionProviderId: 'xai' as const,
                      accountSlotId: 'primary',
                      availability: 'available' as const,
                      observedAt: TIMESTAMP,
                      windows: [{ id: 'included', periodType: 'weekly', resetsAt: TIMESTAMP }],
                    }
                  : CODEX_QUOTA
              )
          ),
      },
    });
    renderScreen(client);

    const xai = await screen.findByRole('region', { name: 'xAI' });
    expect(within(xai).getByText('Provider did not report usage')).toBeInTheDocument();
    expect(within(xai).getByText('Included')).toBeInTheDocument();
    expect(within(xai).getByText('Weekly')).toBeInTheDocument();
    expect(within(xai).queryByRole('meter')).not.toBeInTheDocument();
    expect(within(xai).queryByText(/0%/)).not.toBeInTheDocument();
    expect(within(xai).queryByText(/remaining/)).not.toBeInTheDocument();
    expect(within(xai).queryByText(/used/)).not.toBeInTheDocument();
    expect(
      within(xai)
        .getAllByRole('time')
        .filter((node) => node.getAttribute('datetime') === TIMESTAMP)
    ).toHaveLength(2);
    expect(within(xai).getByText('Resets', { exact: false })).toBeInTheDocument();
    expect(within(xai).getByText('Last checked', { exact: false })).toBeInTheDocument();
    expect(screen.getByRole('meter', { name: 'Primary remaining 59.6%' })).toBeInTheDocument();
  });

  it('loads auto-top-up only from costs expand and clears stale usage after a failed refresh', async () => {
    const user = userEvent.setup();
    // The provider-subscription spec requires explicit USD zero; normalize Intl spaces for text queries.
    const prepaidZero = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' })
      .format(0)
      .replace(/\s/g, ' ');
    const autoTopupResponse = {
      subscriptionProviderId: 'xai',
      accountSlotId: 'primary',
      observedAt: TIMESTAMP,
      availability: 'available',
      currency: 'USD',
    };
    // Billing is already visible when the separate lazy auto-top-up read is still pending.
    let finishAutoTopup = () => {};
    const getAccountAutoTopup = vi
      .fn()
      .mockResolvedValue(autoTopupResponse)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishAutoTopup = () => resolve(autoTopupResponse);
          })
      );
    const getAccountQuota = vi
      .fn()
      .mockImplementation(
        ({ subscriptionProviderId: providerId }: { subscriptionProviderId: string }) =>
          providerId === 'xai'
            ? Promise.resolve({
                subscriptionProviderId: 'xai' as const,
                accountSlotId: 'primary',
                availability: 'available' as const,
                observedAt: TIMESTAMP,
                planType: 'SuperGrok',
                subscriptionActive: true,
                accountObservedAt: TIMESTAMP,
                windows: [
                  {
                    id: 'included',
                    usedPercent: 0,
                    remainingPercent: 100,
                    periodType: 'weekly',
                    resetsAt: TIMESTAMP,
                  },
                ],
                billing: {
                  currency: 'USD' as const,
                  prepaidBalanceCents: 0,
                  sharedAllowance: true,
                },
              })
            : Promise.resolve(CODEX_QUOTA)
      );
    const client = makeClient({
      operations: {
        'provider-subscription.account-list': vi
          .fn()
          .mockImplementation(
            ({ subscriptionProviderId: providerId }: { subscriptionProviderId: string }) =>
              Promise.resolve({
                accounts:
                  providerId === 'openai-codex'
                    ? [CODEX_ACCOUNT]
                    : [
                        {
                          ...CODEX_ACCOUNT,
                          subscriptionProviderId: 'xai' as const,
                          displayName: 'xAI primary',
                        },
                      ],
              })
          ),
        'provider-subscription.account-quota': getAccountQuota,
        'provider-subscription.account-auto-topup': getAccountAutoTopup,
      },
    });
    renderScreen(client);

    const xai = await screen.findByRole('region', { name: 'xAI' });
    expect(within(xai).getByText('Build subscription eligibility: eligible')).toBeInTheDocument();
    expect(within(xai).getByText(/Shared allowance/)).toBeInTheDocument();
    expect(within(xai).getByText('Included 100% remaining')).toBeInTheDocument();
    expect(within(xai).queryByText('0% used')).not.toBeInTheDocument();
    expect(getAccountAutoTopup).not.toHaveBeenCalled();
    expect(getAccountQuota).toHaveBeenCalledTimes(2);

    await user.click(within(xai).getByText('Balance and costs'));
    expect(await within(xai).findByText(`Prepaid ${prepaidZero}`)).toBeInTheDocument();
    expect(within(xai).getByText('Extra spend not reported')).toBeInTheDocument();
    expect(within(xai).getByText('Spend cap not reported')).toBeInTheDocument();
    expect(await within(xai).findByText('Checking auto top-up…')).toBeInTheDocument();
    expect(within(xai).queryByText('Auto top-up not reported')).not.toBeInTheDocument();
    expect(within(xai).queryByText(/exhaust/i)).not.toBeInTheDocument();
    await waitFor(() => expect(getAccountAutoTopup).toHaveBeenCalledTimes(1));
    expect(getAccountAutoTopup).toHaveBeenCalledWith({
      subscriptionProviderId: 'xai',
      accountSlotId: 'primary',
    });
    finishAutoTopup();
    expect(await within(xai).findByText('Auto top-up not reported')).toBeInTheDocument();
    expect(within(xai).queryByText('Checking auto top-up…')).not.toBeInTheDocument();

    getAccountQuota.mockImplementation(
      ({ subscriptionProviderId: providerId }: { subscriptionProviderId: string }) =>
        providerId === 'xai'
          ? Promise.reject(new ApiCallError(500, 'private-refresh-canary'))
          : Promise.resolve(CODEX_QUOTA)
    );
    await user.click(within(xai).getByRole('button', { name: 'Refresh quota' }));
    expect(await within(xai).findByText('Quota query failed')).toBeInTheDocument();
    expect(within(xai).queryByText('Included 100% remaining')).not.toBeInTheDocument();
    expect(within(xai).queryByRole('meter')).not.toBeInTheDocument();
    expect(within(xai).queryByText(/private-refresh-canary/)).not.toBeInTheDocument();
    await waitFor(() => expect(getAccountAutoTopup).toHaveBeenCalledTimes(2));
    expect(
      getAccountQuota.mock.calls.filter(
        ([{ subscriptionProviderId: provider }]) => provider === 'openai-codex'
      )
    ).toHaveLength(1);
    expect(screen.getByRole('meter', { name: 'Primary remaining 59.6%' })).toBeInTheDocument();

    getAccountAutoTopup.mockRejectedValue(new ApiCallError(500, 'private-rule-canary'));
    await user.click(within(xai).getByRole('button', { name: 'Refresh quota' }));
    expect(await within(xai).findByText('Auto top-up query failed.')).toBeInTheDocument();
    expect(within(xai).queryByText('Auto top-up not reported')).not.toBeInTheDocument();
    expect(within(xai).queryByText(/private-rule-canary/)).not.toBeInTheDocument();
  });
});

const GATEWAY_DIAGNOSTICS = {
  ...DIAGNOSTICS,
  providers: {
    ...DIAGNOSTICS.providers,
    registry: [
      {
        ...DIAGNOSTICS.providers.registry[0],
        metadataKey: 'openai',
        modelDetails: [
          {
            id: 'gpt-demo',
            context: { value: 300000, source: 'deployment-extension' },
            output: { value: null, source: null },
            inputModalities: { value: [], source: 'profile-override' },
            outputModalities: { value: ['text'], source: 'upstream-snapshot' },
            reasoning: { value: false, source: 'profile-override' },
            reasoningEffortLevels: { value: [], source: 'deployment-extension' },
            cost: {
              input: { value: 0, source: 'profile-override' },
              output: { value: null, source: null },
              cache_read: { value: null, source: null },
              cache_write: { value: null, source: null },
            },
          },
        ],
      },
      {
        ...DIAGNOSTICS.providers.registry[0],
        id: 'provider_codex',
        displayName: 'Codex work',
        kind: 'oauth',
        metadataKey: 'openai_codex',
        subscriptionAccount: { subscriptionProviderId: 'openai-codex', accountSlotId: 'primary' },
      },
    ],
  },
  gateway: {
    ...DIAGNOSTICS.gateway,
    models: [
      {
        id: 'tier',
        displayName: 'Tier',
        capabilities: ['responses'],
        autoFailover: false,
        contract: { context: 300000, output: null, inputModalities: [], reasoning: false },
        routes: [
          {
            id: 'primary',
            providerProfileId: 'provider_codex',
            providerModel: 'gpt-demo',
            available: false,
            unavailableReason: 'subscription_account_logged_out',
          },
          {
            id: 'backup',
            providerProfileId: 'provider_demo',
            providerModel: 'gpt-demo',
            available: true,
            unavailableReason: null,
          },
        ],
      },
    ],
  },
};

describe('Unified Gateway acceptance', () => {
  it('composes cards and displays active model sources and ordered unavailable routes without promotion', async () => {
    const client = makeClient({
      app: { getDiagnostics: vi.fn().mockResolvedValue(GATEWAY_DIAGNOSTICS) },
    });
    renderScreen(client);
    expect(await screen.findByRole('heading', { name: 'Gateway', level: 1 })).toBeInTheDocument();
    for (const name of ['Providers', 'Models', 'Logical models'])
      expect(await screen.findByRole('heading', { name, level: 2 })).toBeInTheDocument();
    const card = screen.getByRole('region', { name: 'Codex work' });
    expect(within(card).getByText('Codex primary')).toBeInTheDocument();
    expect(within(card).getByText(/Affected logical models: Tier/)).toBeInTheDocument();
    expect(screen.getByText('Context: 300000 · deployment extension')).toBeInTheDocument();
    expect(screen.getByText('Output: Unknown · not reported')).toBeInTheDocument();
    expect(screen.getByText('Input price: 0 · profile override')).toBeInTheDocument();
    const logical = screen.getByRole('region', { name: 'Tier' });
    expect(
      within(logical).getByText(/Primary.*provider_codex.*subscription_account_logged_out/)
    ).toBeInTheDocument();
    expect(within(logical).getByText(/Backup 1.*provider_demo.*Available/)).toBeInTheDocument();
    expect(client.operations['runtime.file-update']).not.toHaveBeenCalled();
    expect(client.operations['runtime.reload']).not.toHaveBeenCalled();
  });

  it('discovers pending status on mount and leaves Log out and Remove enabled with references', async () => {
    const user = userEvent.setup();
    const client = makeClient({
      app: { getDiagnostics: vi.fn().mockResolvedValue(GATEWAY_DIAGNOSTICS) },
      operations: {
        'provider-subscription.account-status': vi.fn().mockResolvedValue(PENDING_ACCOUNT),
      },
    });
    renderScreen(client);
    const card = await screen.findByRole('region', { name: 'Codex work' });
    expect(await within(card).findByText('Connecting')).toBeInTheDocument();
    await user.click(within(card).getByText('Account settings'));
    expect(within(card).getByRole('button', { name: 'Log out' })).toBeEnabled();
    expect(within(card).getByRole('button', { name: 'Remove account' })).toBeEnabled();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await user.click(within(card).getByRole('button', { name: 'Remove account' }));
    expect(client.operations['provider-subscription.account-delete']).toHaveBeenCalledWith({
      subscriptionProviderId: 'openai-codex',
      accountSlotId: 'primary',
    });
    expect(client.operations['runtime.file-update']).not.toHaveBeenCalled();
  });

  it('reports completed setup steps after profile failure and retries only the failed step', async () => {
    const user = userEvent.setup();
    const createFile = vi
      .fn()
      .mockRejectedValueOnce(new ApiCallError(403, 'private-canary'))
      .mockResolvedValue({ file: { revision: 'profile-2' } });
    const client = makeClient({ operations: { 'runtime.file-create': createFile } });
    renderScreen(client);
    await user.type(await screen.findByLabelText('Setup Provider id'), 'codex-new');
    await user.type(screen.getByLabelText('Setup account slot'), 'secondary');
    await user.type(screen.getByLabelText('Setup models'), 'gpt-5');
    await user.click(screen.getByRole('button', { name: 'Add subscription Provider' }));
    expect(await screen.findByText(/Slot creation: completed/)).toBeInTheDocument();
    expect(await screen.findByText(/Profile creation: Access denied/)).toBeInTheDocument();
    expect(client.operations['provider-subscription.account-login-start']).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Retry profile creation' }));
    expect(await screen.findByText(/Profile persisted revision: profile-2/)).toBeInTheDocument();
    expect(client.operations['provider-subscription.account-create']).toHaveBeenCalledTimes(1);
    expect(client.operations['provider-subscription.account-login-start']).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Provider activation: restart required/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('private-canary');
  });

  it('removes a key profile through its source revision without rewriting routes', async () => {
    const user = userEvent.setup();
    const client = makeClient({
      app: { getDiagnostics: vi.fn().mockResolvedValue(GATEWAY_DIAGNOSTICS) },
      operations: {
        'runtime.file-list': vi.fn().mockResolvedValue({
          files: [{ id: 'providers/provider_demo.provider.jsonc', kind: 'provider' }],
        }),
        'runtime.file-read': vi.fn().mockResolvedValue({
          file: {
            id: 'providers/provider_demo.provider.jsonc',
            kind: 'provider',
            revision: 'profile-read',
          },
          content: '{"id":"provider_demo"}',
        }),
        'runtime.file-delete': vi.fn().mockResolvedValue(null),
      },
    });
    renderScreen(client);
    const card = await screen.findByRole('region', { name: 'Demo provider' });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await user.click(within(card).getByRole('button', { name: 'Remove Provider' }));
    await waitFor(() =>
      expect(client.operations['runtime.file-delete']).toHaveBeenCalledWith({
        id: 'providers/provider_demo.provider.jsonc',
        kind: 'provider',
        expectedRevision: 'profile-read',
      })
    );
    expect(await screen.findByText(/Profile removed.*restart required/)).toBeInTheDocument();
    expect(client.operations['runtime.file-update']).not.toHaveBeenCalled();
  });

  it('validates an exact extension key, saves with the read revision and distinguishes persistence, reload and restart', async () => {
    const user = userEvent.setup();
    const client = makeClient({
      app: { getDiagnostics: vi.fn().mockResolvedValue(GATEWAY_DIAGNOSTICS) },
      operations: {
        'runtime.file-read': vi.fn().mockResolvedValue({
          file: { id: 'model-catalog.jsonc', kind: 'model-catalog', revision: 'catalog-read' },
          content: '{\n// preserve\n"schemaVersion":1,"providers":{}}',
        }),
        'runtime.file-update': vi.fn().mockResolvedValue({ file: { revision: 'catalog-saved' } }),
        'runtime.reload': vi.fn().mockResolvedValue({
          status: 'applied',
          plan: {
            ...PLAN,
            requiresRestart: [{ path: 'modelCatalog', summary: 'Catalog needs restart' }],
          },
          runtimeConfig: {
            ...RUNTIME_CONFIG,
            pendingRestart: [{ path: 'modelCatalog', summary: 'Catalog needs restart' }],
          },
        }),
      },
    });
    renderScreen(client);
    await user.click(
      await screen.findByRole('button', { name: 'Edit metadata openai / gpt-demo' })
    );
    const metadata = await screen.findByLabelText('Extension metadata JSON');
    await user.clear(metadata);
    await user.paste('{"cost":{"input":0},"reasoning":false,"modalities":{"input":[]}}');
    await user.click(screen.getByRole('button', { name: 'Save extension' }));
    await waitFor(() => expect(client.operations['runtime.file-update']).toHaveBeenCalled());
    const request = vi.mocked(client.operations['runtime.file-update']).mock.calls[0]![0];
    expect(request.expectedRevision).toBe('catalog-read');
    expect(request.content).toContain('// preserve');
    expect(request.content).toContain('"gpt-demo"');
    expect(request.content).toContain('"input": 0');
    expect(client.operations['runtime.validate']).toHaveBeenCalledBefore(
      vi.mocked(client.operations['runtime.file-update'])
    );
    expect(screen.getByText('Persisted revision: catalog-saved')).toBeInTheDocument();
    expect(client.operations['runtime.reload']).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Apply saved Gateway configuration' }));
    expect(await screen.findByText(/Reload application: applied/)).toBeInTheDocument();
    expect(screen.getByText(/Restart-required activation: modelCatalog/)).toBeInTheDocument();
    expect(screen.getByText('Context: 300000 · deployment extension')).toBeInTheDocument();
  });
});

describe('Gateway dependency and routing completion', () => {
  it('edits primary, ordered backups and failover through validation/CAS while active routes remain unchanged until reload', async () => {
    const user = userEvent.setup();
    const original = {
      schemaVersion: 1,
      enabled: true,
      logicalModels: [
        {
          id: 'tier',
          displayName: 'Tier',
          contextManagement: [{ type: 'compaction', compactThreshold: 8000 }],
          routes: GATEWAY_DIAGNOSTICS.gateway.models[0]!.routes,
          routing: { autoFailover: false },
        },
      ],
    };
    const updateFile = vi.fn().mockResolvedValue({ file: { revision: 'routes-saved' } });
    const client = makeClient({
      app: { getDiagnostics: vi.fn().mockResolvedValue(GATEWAY_DIAGNOSTICS) },
      operations: {
        'runtime.file-read': vi.fn().mockResolvedValue({
          file: { id: 'gateway.jsonc', kind: 'gateway', revision: 'routes-read' },
          content: JSON.stringify(original),
        }),
        'runtime.file-update': updateFile,
      },
    });
    renderScreen(client);
    await user.click(await screen.findByRole('button', { name: 'Edit routes tier' }));
    const routes = await screen.findByLabelText('Ordered routes JSON');
    await user.clear(routes);
    const edited = [
      { id: 'primary', providerProfileId: 'provider_demo', providerModel: 'gpt-demo' },
      { id: 'backup', providerProfileId: 'provider_codex', providerModel: 'gpt-demo' },
    ];
    await user.paste(JSON.stringify(edited));
    await user.click(screen.getByRole('switch', { name: 'Automatic failover' }));
    await user.click(screen.getByRole('button', { name: 'Save routes' }));
    await waitFor(() => expect(updateFile).toHaveBeenCalled());
    const request = updateFile.mock.calls[0]![0];
    expect(request).toMatchObject({
      id: 'gateway.jsonc',
      kind: 'gateway',
      expectedRevision: 'routes-read',
    });
    expect(JSON.parse(request.content).logicalModels[0]).toMatchObject({
      routes: edited,
      routing: { autoFailover: true },
    });
    expect(client.operations['runtime.validate']).toHaveBeenCalledBefore(updateFile);
    expect(client.operations['runtime.reload']).not.toHaveBeenCalled();
    expect(
      screen.getByText(/Primary.*provider_codex.*subscription_account_logged_out/)
    ).toBeInTheDocument();
    expect(await screen.findByText('Persisted revision: routes-saved')).toBeInTheDocument();
  });

  it('retains the exact draft and original revision after conflict until explicit source reload', async () => {
    const user = userEvent.setup();
    const read = vi.fn().mockResolvedValue({
      file: { id: 'model-catalog.jsonc', kind: 'model-catalog', revision: 'read-1' },
      content: '{"schemaVersion":1,"providers":{}}',
    });
    const write = vi
      .fn()
      .mockRejectedValueOnce(new ApiCallError(409, 'private-conflict'))
      .mockResolvedValue({ file: { revision: 'saved-3' } });
    const client = makeClient({
      app: { getDiagnostics: vi.fn().mockResolvedValue(GATEWAY_DIAGNOSTICS) },
      operations: { 'runtime.file-read': read, 'runtime.file-update': write },
    });
    renderScreen(client);
    await user.click(
      await screen.findByRole('button', { name: 'Edit metadata openai / gpt-demo' })
    );
    const field = await screen.findByLabelText('Extension metadata JSON');
    await user.clear(field);
    await user.paste('{"reasoning":false}');
    await user.click(screen.getByRole('button', { name: 'Save extension' }));
    expect(await screen.findByText(/source revision changed/)).toBeInTheDocument();
    expect(field).toHaveValue('{"reasoning":false}');
    expect(read).toHaveBeenCalledTimes(1);
    read.mockResolvedValue({
      file: { id: 'model-catalog.jsonc', kind: 'model-catalog', revision: 'read-2' },
      content: '{"schemaVersion":1,"providers":{"other":{"models":{}}}}',
    });
    await user.click(screen.getByRole('button', { name: 'Reload source revision' }));
    expect(await screen.findByText('Read revision: read-2')).toBeInTheDocument();
    expect(field).toHaveValue('{"reasoning":false}');
    await user.click(screen.getByRole('button', { name: 'Save extension' }));
    await waitFor(() => expect(write).toHaveBeenCalledTimes(2));
    expect(write.mock.calls[1]![0].expectedRevision).toBe('read-2');
    expect(JSON.parse(write.mock.calls[1]![0].content).providers.other).toEqual({ models: {} });
    expect(document.body.textContent).not.toContain('private-conflict');
  });

  it('keeps guided step evidence when the new retained slot appears and retries only a failed post-login observation', async () => {
    const user = userEvent.setup();
    let created = false;
    const createdAccount = { ...CODEX_ACCOUNT, accountSlotId: 'secondary' };
    const listAccounts = vi
      .fn()
      .mockImplementation(
        ({ subscriptionProviderId: provider }: { subscriptionProviderId: string }) =>
          Promise.resolve({
            accounts:
              provider === 'openai-codex'
                ? created
                  ? [CODEX_ACCOUNT, createdAccount]
                  : [CODEX_ACCOUNT]
                : [],
          })
      );
    const status = vi
      .fn()
      .mockImplementation(({ accountSlotId: slot }: { accountSlotId: string }) =>
        slot === 'secondary'
          ? Promise.reject(new ApiCallError(403, 'private-status-denial'))
          : Promise.resolve(CODEX_ACCOUNT)
      );
    const startAccountLogin = vi
      .fn()
      .mockResolvedValue({ ...PENDING_ACCOUNT, accountSlotId: 'secondary' });
    const client = makeClient({
      operations: {
        'provider-subscription.account-list': listAccounts,
        'provider-subscription.account-create': vi.fn().mockImplementation(() => {
          created = true;
          return Promise.resolve(createdAccount);
        }),
        'provider-subscription.account-status': status,
        'provider-subscription.account-login-start': startAccountLogin,
      },
    });
    renderScreen(client);
    await user.type(await screen.findByLabelText('Setup Provider id'), 'codex-new');
    await user.type(screen.getByLabelText('Setup account slot'), 'secondary');
    await user.type(screen.getByLabelText('Setup models'), 'gpt-5');
    await user.click(screen.getByRole('button', { name: 'Add subscription Provider' }));
    expect(await screen.findByText(/Login observation: Access denied/)).toBeInTheDocument();
    for (const step of ['Slot creation', 'Profile creation', 'Device login'])
      expect(screen.getByText(`${step}: completed`)).toBeInTheDocument();
    status.mockResolvedValue({ ...PENDING_ACCOUNT, accountSlotId: 'secondary' });
    await user.click(screen.getByRole('button', { name: 'Retry login observation' }));
    expect(await screen.findByText('Login observation: completed')).toBeInTheDocument();
    expect(startAccountLogin).toHaveBeenCalledTimes(1);
    expect(client.operations['runtime.file-create']).toHaveBeenCalledTimes(1);
    expect(client.operations['provider-subscription.account-create']).toHaveBeenCalledTimes(1);
  });

  it('keeps typed diagnostics denial visible and retries only that read', async () => {
    const user = userEvent.setup();
    const getDiagnostics = vi
      .fn()
      .mockRejectedValueOnce(new ApiCallError(403, 'private-diagnostics-denial'))
      .mockResolvedValue(GATEWAY_DIAGNOSTICS);
    const client = makeClient({ app: { getDiagnostics } });
    renderScreen(client);
    const denial = await screen.findByText(/Access denied: Gateway diagnostics/);
    await user.click(
      within(denial.closest('[role="alert"]')!).getByRole('button', { name: 'Try again' })
    );
    expect(await screen.findByRole('heading', { name: 'Models', level: 2 })).toBeInTheDocument();
    expect(getDiagnostics).toHaveBeenCalledTimes(2);
    expect(client.operations['provider-subscription.provider-list']).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).not.toContain('private-diagnostics-denial');
  });

  it('retries an initially denied quota pair without refreshing another account', async () => {
    const user = userEvent.setup();
    const quota = vi
      .fn()
      .mockImplementation(
        ({ subscriptionProviderId: provider }: { subscriptionProviderId: string }) =>
          provider === 'openai-codex'
            ? Promise.reject(new ApiCallError(403, 'private-quota-denial'))
            : Promise.resolve(XAI_QUOTA)
      );
    const client = makeClient({
      operations: {
        'provider-subscription.account-list': vi
          .fn()
          .mockImplementation(
            ({ subscriptionProviderId: provider }: { subscriptionProviderId: string }) =>
              Promise.resolve({
                accounts: [{ ...CODEX_ACCOUNT, subscriptionProviderId: provider }],
              })
          ),
        'provider-subscription.account-quota': quota,
      },
    });
    renderScreen(client);
    const retry = await screen.findByRole('button', { name: 'Retry quota OpenAI Codex / primary' });
    quota.mockImplementation(
      ({ subscriptionProviderId: provider }: { subscriptionProviderId: string }) =>
        Promise.resolve(provider === 'openai-codex' ? CODEX_QUOTA : XAI_QUOTA)
    );
    await user.click(retry);
    expect(await screen.findByText('Primary 59.6% remaining')).toBeInTheDocument();
    expect(
      quota.mock.calls.filter(([{ subscriptionProviderId: provider }]) => provider === 'xai')
    ).toHaveLength(1);
  });
});

it('retries the source observation after a successful save without repeating the persisted write', async () => {
  const user = userEvent.setup();
  const source = {
    file: { id: 'model-catalog.jsonc', kind: 'model-catalog', revision: 'catalog-read' },
    content: '{"schemaVersion":1,"providers":{}}',
  };
  const getFile = vi
    .fn()
    .mockResolvedValueOnce(source)
    .mockRejectedValueOnce(new ApiCallError(403, 'private-source-denial'))
    .mockResolvedValue({ ...source, file: { ...source.file, revision: 'catalog-saved' } });
  const updateFile = vi.fn().mockResolvedValue({ file: { revision: 'catalog-saved' } });
  const client = makeClient({
    app: { getDiagnostics: vi.fn().mockResolvedValue(GATEWAY_DIAGNOSTICS) },
    operations: { 'runtime.file-read': getFile, 'runtime.file-update': updateFile },
  });
  renderScreen(client);
  await user.click(await screen.findByRole('button', { name: 'Edit metadata openai / gpt-demo' }));
  await screen.findByLabelText('Extension metadata JSON');
  await user.click(screen.getByRole('button', { name: 'Save extension' }));
  const failure = await screen.findByText(/Access denied: Source read/);
  expect(screen.getByText('Persisted revision: catalog-saved')).toBeInTheDocument();
  expect(screen.queryByText(/Configuration save failed/)).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Save extension' })).toBeDisabled();
  await user.click(
    within(failure.closest('[role="alert"]')!).getByRole('button', { name: 'Try again' })
  );
  expect(await screen.findByText('Read revision: catalog-saved')).toBeInTheDocument();
  expect(updateFile).toHaveBeenCalledTimes(1);
  expect(getFile).toHaveBeenCalledTimes(3);
  expect(document.body.textContent).not.toContain('private-source-denial');
});

describe('Round 2 Gateway dependency recovery', () => {
  it.each([
    { dependency: 'diagnostics', status: 500 },
    { dependency: 'diagnostics', status: 403 },
    { dependency: 'accounts', status: 403 },
  ])('retains completed setup and exact failed-step retry after $dependency refresh fails with $status', async ({
    dependency,
    status,
  }) => {
    const user = userEvent.setup();
    const getDiagnostics = vi
      .fn()
      .mockResolvedValueOnce(GATEWAY_DIAGNOSTICS)
      .mockImplementation(() =>
        dependency === 'diagnostics'
          ? Promise.reject(new ApiCallError(status, 'private-diagnostics-refresh'))
          : Promise.resolve(GATEWAY_DIAGNOSTICS)
      );
    let slotCreated = false;
    const listAccounts = vi
      .fn()
      .mockImplementation(
        ({ subscriptionProviderId: provider }: { subscriptionProviderId: string }) =>
          dependency === 'accounts' && slotCreated
            ? Promise.reject(new ApiCallError(403, 'private-account-list-refresh'))
            : Promise.resolve({ accounts: provider === 'openai-codex' ? [CODEX_ACCOUNT] : [] })
      );
    const createAccount = vi.fn().mockImplementation(() => {
      slotCreated = true;
      return Promise.resolve({ ...CODEX_ACCOUNT, accountSlotId: 'secondary' });
    });
    const createFile = vi.fn().mockRejectedValue(new ApiCallError(403, 'private-profile-create'));
    const client = makeClient({
      app: { getDiagnostics },
      operations: {
        'runtime.file-create': createFile,
        'provider-subscription.account-list': listAccounts,
        'provider-subscription.account-create': createAccount,
      },
    });
    renderScreen(client);
    await user.type(await screen.findByLabelText('Setup Provider id'), 'codex-new');
    await user.type(screen.getByLabelText('Setup account slot'), 'secondary');
    await user.type(screen.getByLabelText('Setup models'), 'gpt-5');
    await user.click(screen.getByRole('button', { name: 'Add subscription Provider' }));
    const diagnosticsFailure =
      dependency === 'diagnostics'
        ? await screen.findByText(
            status === 403
              ? /Access denied: Gateway diagnostics/
              : "Couldn't load Gateway diagnostics."
          )
        : await screen.findByText('Access denied');
    await waitFor(() => expect(createFile).toHaveBeenCalledTimes(1));
    expect(screen.getByText('Slot creation: completed')).toBeInTheDocument();
    expect(screen.getByText(/Profile creation: Access denied/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry profile creation' })).toBeDisabled();
    getDiagnostics.mockResolvedValue(GATEWAY_DIAGNOSTICS);
    listAccounts.mockImplementation(
      ({ subscriptionProviderId: provider }: { subscriptionProviderId: string }) =>
        Promise.resolve({ accounts: provider === 'openai-codex' ? [CODEX_ACCOUNT] : [] })
    );
    await user.click(
      dependency === 'diagnostics'
        ? within(diagnosticsFailure.closest('[role="alert"]')!).getByRole('button', {
            name: 'Try again',
          })
        : screen.getByRole('button', { name: 'Retry' })
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Retry profile creation' })).toBeEnabled()
    );
    createFile.mockResolvedValue({ file: { revision: 'profile-recovered' } });
    await user.click(screen.getByRole('button', { name: 'Retry profile creation' }));
    expect(await screen.findByText('Profile creation: completed')).toBeInTheDocument();
    expect(screen.getByText(/Profile persisted revision: profile-recovered/)).toBeInTheDocument();
    expect(client.operations['provider-subscription.account-create']).toHaveBeenCalledTimes(1);
    expect(createFile).toHaveBeenCalledTimes(2);
    expect(createFile.mock.calls[0]).toEqual(createFile.mock.calls[1]);
    expect(document.body.textContent).not.toMatch(
      /private-diagnostics-refresh|private-profile-create|private-account-list-refresh/
    );
  });

  it('discloses affected tiers and preserves removal and read retry when the bound slot is initially absent', async () => {
    const user = userEvent.setup();
    const client = makeClient({
      app: { getDiagnostics: vi.fn().mockResolvedValue(GATEWAY_DIAGNOSTICS) },
      operations: {
        'provider-subscription.account-list': vi.fn().mockResolvedValue({ accounts: [] }),
      },
    });
    renderScreen(client);
    const card = await screen.findByRole('region', { name: 'Codex work' });
    expect(within(card).getByText(/Account slot openai-codex/)).toBeInTheDocument();
    expect(within(card).getByText('Affected logical models: Tier')).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Remove Provider' })).toBeEnabled();
    await user.click(within(card).getByRole('button', { name: 'Retry account slots' }));
    await waitFor(() =>
      expect(client.operations['provider-subscription.account-list']).toHaveBeenCalledTimes(4)
    );
    expect(screen.getByText(/Primary · primary · provider_codex/)).toBeInTheDocument();
    expect(screen.getByText(/Backup 1 · backup · provider_demo/)).toBeInTheDocument();
    expect(client.operations['runtime.file-update']).not.toHaveBeenCalled();
    expect(client.operations['runtime.reload']).not.toHaveBeenCalled();
  });

  it('retains affected tiers after account deletion with active profiles and ordered routes unchanged', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    let removed = false;
    const listAccounts = vi
      .fn()
      .mockImplementation(
        ({ subscriptionProviderId: provider }: { subscriptionProviderId: string }) =>
          Promise.resolve({
            accounts: provider === 'openai-codex' && !removed ? [CODEX_ACCOUNT] : [],
          })
      );
    const deleteAccount = vi.fn().mockImplementation(() => {
      removed = true;
      return Promise.resolve(null);
    });
    const client = makeClient({
      app: { getDiagnostics: vi.fn().mockResolvedValue(GATEWAY_DIAGNOSTICS) },
      operations: {
        'provider-subscription.account-list': listAccounts,
        'provider-subscription.account-delete': deleteAccount,
        'runtime.file-delete': vi.fn(),
      },
    });
    renderScreen(client);
    const card = await screen.findByRole('region', { name: 'Codex work' });
    await user.click(within(card).getByText('Account settings'));
    await user.click(within(card).getByRole('button', { name: 'Remove account' }));
    const warning = await screen.findByText(/Account slot openai-codex/);
    const absentCard = warning.closest('section')!;
    expect(within(absentCard).getByText('Affected logical models: Tier')).toBeInTheDocument();
    expect(within(absentCard).getByRole('button', { name: 'Remove Provider' })).toBeEnabled();
    expect(within(absentCard).getByRole('button', { name: 'Retry account slots' })).toBeEnabled();
    expect(deleteAccount).toHaveBeenCalledExactlyOnceWith({
      subscriptionProviderId: 'openai-codex',
      accountSlotId: 'primary',
    });
    expect(screen.getByText(/Primary · primary · provider_codex/)).toBeInTheDocument();
    expect(screen.getByText(/Backup 1 · backup · provider_demo/)).toBeInTheDocument();
    expect(client.operations['runtime.file-update']).not.toHaveBeenCalled();
    expect(client.operations['runtime.file-delete']).not.toHaveBeenCalled();
    expect(client.operations['runtime.reload']).not.toHaveBeenCalled();
  });
});
