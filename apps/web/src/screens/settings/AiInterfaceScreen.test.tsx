import { ApiCallError, type CoreClient } from '@openkit/core-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CoreClientProvider } from '../../app/core-client';
import { AiInterfaceScreen } from './AiInterfaceScreen';

const TIMESTAMP = '2026-08-30T00:00:00.000Z';
const ADMIN_TOKEN = 'okt_browser_admin_test';
const API_KEY = 'sk-live-provider-key-never-store';
const SERVER_JSONC = `{
  "schemaVersion": 1,
  "mode": "local",
  "defaults": {
    // Keep this comment
    "coreProviderId": "provider_demo",
    "coreModel": "gpt-demo",
    "gatewayProviderId": "provider_demo",
    "gatewayModel": "gpt-strong"
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
  windows: [{ id: 'primary', usedPercent: 40, remainingPercent: 60 }],
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
  gateway: { status: 'ok', endpoints: ['/v1/chat/completions'] },
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
  defaultProviders: {
    core: {
      configured: true,
      model: 'gpt-demo',
      origin: 'canonical',
      providerId: 'provider_demo',
    },
    gateway: { configured: false, origin: 'unset', reason: 'unset' },
  },
  defaults: {
    quickChat: { providerId: 'provider_demo', model: 'gpt-demo' },
    gateway: { providerId: null, model: null },
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
    runtimeConfig?: Record<string, unknown>;
    providerSubscriptions?: Record<string, unknown>;
    listProviders?: CoreClient['providerSubscriptions']['listProviders'];
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
    runtimeConfig: {
      getFile: vi.fn().mockImplementation(() =>
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
      validate: vi.fn().mockResolvedValue({
        valid: true,
        diagnostics: [],
        plan: PLAN,
        runtimeConfig: RUNTIME_CONFIG,
      }),
      updateFile: vi.fn().mockImplementation((input: { content: string }) => {
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
      createFile: vi.fn().mockResolvedValue({
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
      reload: vi.fn().mockResolvedValue({
        status: 'applied',
        plan: PLAN,
        runtimeConfig: RUNTIME_CONFIG,
      }),
      ...overrides.runtimeConfig,
    },
    providerSubscriptions: {
      listProviders: overrides.listProviders ?? vi.fn().mockResolvedValue(PROVIDERS),
      listAccounts: vi.fn().mockImplementation((providerId: string) =>
        Promise.resolve({
          accounts: providerId === 'openai-codex' ? [CODEX_ACCOUNT] : [],
        })
      ),
      createAccount: vi.fn().mockResolvedValue({
        ...CODEX_ACCOUNT,
        accountSlotId: 'secondary',
        displayName: 'Codex secondary',
      }),
      updateAccount: vi.fn().mockResolvedValue({
        ...CODEX_ACCOUNT,
        displayName: 'Renamed Codex',
      }),
      deleteAccount: vi.fn().mockResolvedValue(undefined),
      getAccountStatus: vi.fn().mockResolvedValue(CODEX_ACCOUNT),
      startAccountLogin: vi.fn().mockResolvedValue(PENDING_ACCOUNT),
      cancelAccountLogin: vi.fn().mockResolvedValue(CODEX_ACCOUNT),
      logoutAccount: vi.fn().mockResolvedValue(CODEX_ACCOUNT),
      getAccountQuota: vi.fn().mockResolvedValue(CODEX_QUOTA),
      ...overrides.providerSubscriptions,
    },
  } as unknown as CoreClient;
}

function renderScreen(client: CoreClient, createAdminClient = vi.fn()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rendered = render(
    <QueryClientProvider client={queryClient}>
      <CoreClientProvider client={client}>
        <AiInterfaceScreen createAdminClient={createAdminClient} />
      </CoreClientProvider>
    </QueryClientProvider>
  );
  return { ...rendered, createAdminClient, queryClient };
}

beforeEach(() => {
  localStorage.clear();
});

describe('AI interface deployment-admin workflow', () => {
  it('accepts a server-admin token only after the session is denied and does not persist it', async () => {
    const user = userEvent.setup();
    const sessionClient = makeClient({
      listProviders: vi.fn().mockRejectedValue(
        new ApiCallError(403, 'Deployment-admin authority is required.', {
          code: 'forbidden',
        })
      ),
    });
    const adminClient = makeClient();
    const createAdminClient = vi.fn(() => adminClient);
    const { queryClient, unmount } = renderScreen(sessionClient, createAdminClient);

    const tokenInput = await screen.findByLabelText('Server admin token');
    await user.type(tokenInput, ADMIN_TOKEN);
    await user.click(screen.getByRole('button', { name: 'Open AI interface' }));

    expect(await screen.findByText('OpenAI Codex')).toBeInTheDocument();
    expect(createAdminClient).toHaveBeenCalledWith(ADMIN_TOKEN);
    expect(screen.queryByDisplayValue(ADMIN_TOKEN)).not.toBeInTheDocument();
    expect(JSON.stringify(localStorage)).not.toContain(ADMIN_TOKEN);
    expect(
      JSON.stringify(
        queryClient
          .getQueryCache()
          .findAll()
          .map((query) => query.queryKey)
      )
    ).not.toContain(ADMIN_TOKEN);

    unmount();
    await waitFor(() =>
      expect(
        queryClient.getQueryCache().findAll({ queryKey: ['settings', 'ai-interface'] })
      ).toHaveLength(0)
    );
  });

  it('creates, renames, and deletes a provider-subscription slot', async () => {
    const user = userEvent.setup();
    const client = makeClient();
    renderScreen(client);

    const codex = await screen.findByRole('region', { name: 'OpenAI Codex' });
    await user.type(within(codex).getByLabelText('Account slot id'), 'secondary');
    await user.type(within(codex).getByLabelText('Display name'), 'Codex secondary');
    await user.click(within(codex).getByRole('button', { name: 'Create account slot' }));

    await waitFor(() =>
      expect(client.providerSubscriptions.createAccount).toHaveBeenCalledWith('openai-codex', {
        accountSlotId: 'secondary',
        displayName: 'Codex secondary',
      })
    );

    const rename = within(codex).getByLabelText('Account display name');
    await user.clear(rename);
    await user.type(rename, 'Renamed Codex');
    await user.click(within(codex).getByRole('button', { name: 'Rename account' }));
    await waitFor(() =>
      expect(client.providerSubscriptions.updateAccount).toHaveBeenCalledWith(
        'openai-codex',
        'primary',
        { displayName: 'Renamed Codex' }
      )
    );

    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await user.click(within(codex).getByRole('button', { name: 'Delete account' }));
    await waitFor(() =>
      expect(client.providerSubscriptions.deleteAccount).toHaveBeenCalledWith(
        'openai-codex',
        'primary'
      )
    );
  });

  it('starts device-code login, shows the verification URL and user code, polls status, and can cancel', async () => {
    const user = userEvent.setup();
    const getAccountStatus = vi.fn().mockResolvedValue(PENDING_ACCOUNT);
    const client = makeClient({
      providerSubscriptions: {
        listAccounts: vi.fn().mockImplementation((providerId: string) =>
          Promise.resolve({
            accounts: providerId === 'openai-codex' ? [CODEX_ACCOUNT] : [],
          })
        ),
        getAccountStatus,
        startAccountLogin: vi.fn().mockResolvedValue(PENDING_ACCOUNT),
      },
    });
    renderScreen(client);

    const codex = await screen.findByRole('region', { name: 'OpenAI Codex' });
    await user.click(within(codex).getByRole('button', { name: 'Start login' }));

    expect(await screen.findByText('ABCD-EFGH')).toBeInTheDocument();
    const verification = screen.getByRole('link', { name: 'https://example.com/device' });
    expect(verification).toHaveAttribute('href', 'https://example.com/device');
    expect(client.providerSubscriptions.startAccountLogin).toHaveBeenCalledWith(
      'openai-codex',
      'primary',
      { mode: 'device_code' }
    );

    await waitFor(() => expect(getAccountStatus).toHaveBeenCalled(), { timeout: 4000 });
    expect(getAccountStatus).toHaveBeenCalledWith('openai-codex', 'primary');

    await user.click(within(codex).getByRole('button', { name: 'Cancel login' }));
    await waitFor(() =>
      expect(client.providerSubscriptions.cancelAccountLogin).toHaveBeenCalledWith(
        'openai-codex',
        'primary',
        { interactionId: 'interaction-pending' }
      )
    );
  });

  it('shows a failed device-code status poll and retries it explicitly', async () => {
    const user = userEvent.setup();
    const getAccountStatus = vi
      .fn()
      .mockRejectedValueOnce(new ApiCallError(500, 'Status failed.'))
      .mockResolvedValue(PENDING_ACCOUNT);
    const client = makeClient({
      providerSubscriptions: {
        listAccounts: vi.fn().mockImplementation((providerId: string) =>
          Promise.resolve({
            accounts: providerId === 'openai-codex' ? [PENDING_ACCOUNT] : [],
          })
        ),
        getAccountStatus,
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
      .mockRejectedValueOnce(new ApiCallError(500, 'Provider subscription request failed.'))
      .mockResolvedValue(CODEX_ACCOUNT);
    const client = makeClient({
      providerSubscriptions: {
        listAccounts: vi.fn().mockImplementation((providerId: string) =>
          Promise.resolve({
            accounts: providerId === 'openai-codex' ? [LOGGED_IN_ACCOUNT] : [],
          })
        ),
        logoutAccount,
      },
    });
    renderScreen(client);

    const codex = await screen.findByRole('region', { name: 'OpenAI Codex' });
    expect(within(codex).queryByRole('button', { name: 'Start login' })).not.toBeInTheDocument();
    await user.click(within(codex).getByRole('button', { name: 'Log out' }));
    expect(await screen.findByText(/Couldn't log out this account/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(logoutAccount).toHaveBeenCalledTimes(2));

    await user.click(within(codex).getByRole('button', { name: 'Refresh quota' }));
    await waitFor(() =>
      expect(client.providerSubscriptions.getAccountQuota).toHaveBeenCalledWith(
        'openai-codex',
        'primary'
      )
    );
  });

  it('shows configured provider profiles and saves core and gateway defaults from the current server.jsonc', async () => {
    const user = userEvent.setup();
    const client = makeClient();
    renderScreen(client);

    expect((await screen.findAllByText('Demo provider')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('gpt-strong').length).toBeGreaterThan(0);
    expect(screen.getByText(/Default ready/i)).toBeInTheDocument();
    expect(screen.getByText(/Provider is ready\./)).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Save defaults' })).toBeEnabled();

    await user.click(screen.getByRole('button', { name: /Core model/ }));
    await user.click(
      within(await screen.findByRole('listbox')).getByRole('option', { name: 'gpt-strong' })
    );
    expect(screen.getByRole('button', { name: 'Apply configuration' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Save defaults' }));

    await waitFor(() => expect(client.runtimeConfig.validate).toHaveBeenCalled());
    const saved = vi.mocked(client.runtimeConfig.updateFile).mock.calls[0]?.[0];
    expect(saved).toMatchObject({
      id: 'server.jsonc',
      kind: 'server',
      expectedRevision: 'revision-1',
    });
    expect(saved?.content).toContain('// Keep this comment');
    expect(saved?.content).toContain('"coreProviderId": "provider_demo"');
    expect(saved?.content).toContain('"coreModel": "gpt-strong"');
    expect(saved?.content).toContain('"gatewayProviderId": "provider_demo"');
    expect(saved?.content).toContain('"gatewayModel": "gpt-strong"');
    expect(client.runtimeConfig.reload).not.toHaveBeenCalled();
    expect(
      await screen.findByText('Defaults file saved. Apply configuration to load it.')
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Apply configuration' })).toBeEnabled()
    );
    const accountReadsBeforeApply = vi.mocked(client.providerSubscriptions.listAccounts).mock.calls
      .length;
    await user.click(screen.getByRole('button', { name: 'Apply configuration' }));
    expect(client.runtimeConfig.reload).toHaveBeenCalledWith({ dryRun: false, mode: 'safe' });
    expect(await screen.findByText('Configuration applied')).toBeInTheDocument();
    await waitFor(() =>
      expect(
        vi.mocked(client.providerSubscriptions.listAccounts).mock.calls.length
      ).toBeGreaterThan(accountReadsBeforeApply)
    );
  });

  it('shows a save validation failure without writing or reloading', async () => {
    const user = userEvent.setup();
    const client = makeClient({
      runtimeConfig: {
        validate: vi.fn().mockResolvedValue({
          valid: false,
          diagnostics: [
            {
              code: 'defaults.coreModel',
              message: 'coreModel is not a known model',
              severity: 'error',
            },
          ],
          plan: PLAN,
          runtimeConfig: RUNTIME_CONFIG,
        }),
      },
    });
    renderScreen(client);

    await user.click(await screen.findByRole('button', { name: 'Save defaults' }));

    expect(await screen.findByText('Draft has errors')).toBeInTheDocument();
    expect(screen.getByText('coreModel is not a known model')).toBeInTheDocument();
    expect(client.runtimeConfig.updateFile).not.toHaveBeenCalled();
    expect(client.runtimeConfig.reload).not.toHaveBeenCalled();
    expect(screen.queryByText('Configuration applied')).not.toBeInTheDocument();
  });

  it('clears optional gateway defaults through the bounded settings form', async () => {
    const user = userEvent.setup();
    const client = makeClient();
    renderScreen(client);

    await user.click(await screen.findByRole('button', { name: 'Clear gateway default' }));
    expect(screen.getByRole('button', { name: 'Apply configuration' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Save defaults' }));

    await waitFor(() => expect(client.runtimeConfig.updateFile).toHaveBeenCalled());
    const saved = vi.mocked(client.runtimeConfig.updateFile).mock.calls[0]?.[0];
    expect(saved?.content).not.toContain('"gatewayProviderId"');
    expect(saved?.content).not.toContain('"gatewayModel"');
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
    await user.type(screen.getByLabelText('Models'), 'gpt-5');
    await user.type(screen.getByLabelText('Default model'), 'gpt-5');
    await user.click(screen.getByRole('button', { name: 'Create provider profile' }));

    await waitFor(() => expect(client.runtimeConfig.createFile).toHaveBeenCalled());
    const created = vi.mocked(client.runtimeConfig.createFile).mock.calls[0]?.[0];
    expect(created).toMatchObject({
      id: 'providers/codex-work.provider.jsonc',
      kind: 'provider',
    });
    expect(created?.content).toContain('"kind": "oauth"');
    expect(created?.content).toContain('"vendor": "openai_codex"');
    expect(created?.content).toContain('"accountSlotId": "primary"');
    expect(created?.content).not.toContain('secretRef');
    expect(created?.content).not.toContain('baseUrl');
    expect(
      await screen.findByText('Provider file saved. Apply configuration to load it.')
    ).toBeInTheDocument();
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
    await user.type(screen.getByLabelText('Models'), 'openai/gpt-5.1, openai/gpt-4.1');
    await user.type(screen.getByLabelText('Default model'), 'openai/gpt-5.1');
    await user.click(screen.getByRole('button', { name: 'Create provider profile' }));

    await waitFor(() => expect(client.runtimeConfig.createFile).toHaveBeenCalled());
    const created = vi.mocked(client.runtimeConfig.createFile).mock.calls[0]?.[0];
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
    await user.type(screen.getByLabelText('Models'), 'model-demo');
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
    expect(client.runtimeConfig.createFile).not.toHaveBeenCalled();
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
    const listAccounts = vi.fn().mockImplementation((providerId: string) =>
      Promise.resolve({
        accounts: providerId === 'openai-codex' ? [PENDING_ACCOUNT] : [],
      })
    );
    const getAccountStatus = vi.fn().mockResolvedValue(LOGGED_IN_ACCOUNT);
    const client = makeClient({
      providerSubscriptions: {
        listAccounts,
        getAccountStatus,
      },
    });
    renderScreen(client);

    const codex = await screen.findByRole('region', { name: 'OpenAI Codex' });
    await waitFor(() => expect(getAccountStatus).toHaveBeenCalledWith('openai-codex', 'primary'));
    const settled = listAccounts.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(listAccounts.mock.calls.length).toBe(settled);
    expect(within(codex).queryByRole('button', { name: 'Start login' })).not.toBeInTheDocument();
  });
});
