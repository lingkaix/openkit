import type { CoreClient } from '@openkit/core-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { parse } from 'jsonc-parser';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CoreClientProvider } from '../../app/core-client';
import { AiInterfaceScreen } from './AiInterfaceScreen';

const TIMESTAMP = '2026-08-30T00:00:00.000Z';

const SERVER_JSONC = `{
  "schemaVersion": 1,
  "mode": "local",
  "defaults": {
    // Keep this comment
    "defaultAgentId": "agent_demo"
  }
}
`;

const GATEWAY_JSONC = `{
  "schemaVersion": 1,
  "enabled": true,
  "defaultLogicalModelId": "notes",
  "logicalModels": [
    {
      "id": "notes",
      "displayName": "Notes model",
      "routing": { "autoFailover": true },
      "contextManagement": [{ "type": "compaction", "compactThreshold": 100000 }],
      "routes": [
        { "id": "route-notes-primary", "providerProfileId": "provider_anthropic", "providerModel": "claude-x" },
        { "id": "route-notes-backup", "providerProfileId": "provider_openai_sub", "providerModel": "gpt-y" },
        { "id": "route-notes-backup-2", "providerProfileId": "provider_deepseek", "providerModel": "v4" }
      ]
    }
  ]
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

const ACCOUNTS = [
  {
    subscriptionProviderId: 'openai-codex' as const,
    accountSlotId: 'primary',
    displayName: 'Work account',
    boundProviderIds: ['provider_openai_sub'],
    status: 'logged_out' as const,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  },
  {
    subscriptionProviderId: 'openai-codex' as const,
    accountSlotId: 'secondary',
    displayName: 'Personal account',
    boundProviderIds: ['provider_openai_secondary'],
    status: 'logged_out' as const,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  },
];

type RouteFixture = {
  id: string;
  providerProfileId: string;
  providerModel: string;
  available: boolean;
  unavailableReason: string | null;
};

type ModelFixture = {
  id: string;
  displayName: string;
  capabilities: string[];
  autoFailover?: boolean;
  routes?: RouteFixture[];
  modelFamilyId?: string | null;
  contract?: {
    context: number | null;
    output: number | null;
    inputModalities: string[] | null;
    reasoning: boolean | null;
    modelFamilyId?: string | null;
  };
  reasoningEffortLevels?: string[];
};

type RegistryFixture = {
  id: string;
  displayName: string;
  kind: string;
  gatewayCapabilities: { chatCompletions: string; responses: string };
  models: string[];
  subscriptionAccount?: { subscriptionProviderId: string; accountSlotId: string };
};

const PROVIDER_REGISTRY: RegistryFixture[] = [
  {
    id: 'provider_anthropic',
    displayName: 'Anthropic',
    kind: 'custom',
    gatewayCapabilities: { chatCompletions: 'native', responses: 'unsupported' },
    models: ['claude-x', 'claude-fast'],
  },
  {
    id: 'provider_openai_sub',
    displayName: 'OpenAI sub',
    kind: 'custom',
    gatewayCapabilities: { chatCompletions: 'native', responses: 'native' },
    models: ['gpt-y'],
    subscriptionAccount: { subscriptionProviderId: 'openai-codex', accountSlotId: 'primary' },
  },
  {
    id: 'provider_deepseek',
    displayName: 'DeepSeek',
    kind: 'custom',
    gatewayCapabilities: { chatCompletions: 'native', responses: 'unsupported' },
    models: ['v4', 'v4-fast'],
  },
  {
    id: 'provider_openai_primary',
    displayName: 'OpenAI primary',
    kind: 'custom',
    gatewayCapabilities: { chatCompletions: 'native', responses: 'native' },
    models: ['gpt-y'],
    subscriptionAccount: { subscriptionProviderId: 'openai-codex', accountSlotId: 'primary' },
  },
  {
    id: 'provider_openai_secondary',
    displayName: 'OpenAI secondary',
    kind: 'custom',
    gatewayCapabilities: { chatCompletions: 'native', responses: 'native' },
    models: ['gpt-y'],
    subscriptionAccount: { subscriptionProviderId: 'openai-codex', accountSlotId: 'secondary' },
  },
];

const MODELS: ModelFixture[] = [
  {
    id: 'notes',
    displayName: 'Notes model',
    capabilities: ['chat'],
    autoFailover: true,
    routes: [
      {
        id: 'route-notes-primary',
        providerProfileId: 'provider_anthropic',
        providerModel: 'claude-x',
        available: true,
        unavailableReason: null,
      },
      {
        id: 'route-notes-backup',
        providerProfileId: 'provider_openai_sub',
        providerModel: 'gpt-y',
        available: false,
        unavailableReason: 'subscription_account_logged_out',
      },
      {
        id: 'route-notes-backup-2',
        providerProfileId: 'provider_deepseek',
        providerModel: 'v4',
        available: true,
        unavailableReason: null,
      },
    ],
    contract: {
      context: 128000,
      output: 16384,
      inputModalities: ['text', 'image'],
      reasoning: true,
    },
    reasoningEffortLevels: ['low', 'medium'],
  },
  {
    id: 'fast',
    displayName: 'Fast model',
    capabilities: ['chat'],
    autoFailover: false,
    routes: [
      {
        id: 'route-fast-primary',
        providerProfileId: 'provider_anthropic',
        providerModel: 'claude-fast',
        available: false,
        unavailableReason: 'provider_api_key_missing',
      },
      {
        id: 'route-fast-backup',
        providerProfileId: 'provider_deepseek',
        providerModel: 'v4-fast',
        available: true,
        unavailableReason: null,
      },
    ],
    contract: {
      context: 64000,
      output: 8192,
      inputModalities: ['text'],
      reasoning: false,
    },
    reasoningEffortLevels: ['low'],
  },
  {
    id: 'mystery',
    displayName: 'Mystery model',
    capabilities: [],
  },
  {
    id: 'rotation',
    displayName: 'Rotation model',
    capabilities: ['chat'],
    autoFailover: true,
    routes: [
      {
        id: 'route-rotation-primary',
        providerProfileId: 'provider_openai_primary',
        providerModel: 'gpt-y',
        available: true,
        unavailableReason: null,
      },
      {
        id: 'route-rotation-backup',
        providerProfileId: 'provider_openai_secondary',
        providerModel: 'gpt-y',
        available: true,
        unavailableReason: null,
      },
    ],
    contract: {
      context: 128000,
      output: 16384,
      inputModalities: ['text'],
      reasoning: true,
    },
    reasoningEffortLevels: ['low'],
  },
];

function diagnosticsFixture(
  options: {
    models?: ModelFixture[];
    registry?: RegistryFixture[];
    pendingRestart?: unknown[];
  } = {}
) {
  return {
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
      memory: { rssBytes: 1, heapUsedBytes: 1, heapTotalBytes: 1 },
      telemetry: { enabled: false, exportConfigured: false },
    },
    gateway: {
      status: 'ok',
      endpoints: ['/v1/chat/completions'],
      defaultModelId: 'notes',
      titleModelId: null,
      models: options.models ?? MODELS,
    },
    providers: {
      diagnostics: [],
      registry: options.registry ?? PROVIDER_REGISTRY,
    },
    capabilities: [],
    runtimeConfig: {
      currentVersion: 3,
      loadedAt: TIMESTAMP,
      lastReload: null,
      lastFailedReload: null,
      pendingRestart: options.pendingRestart ?? [],
    },
  };
}

const GATEWAY_DIAGNOSTICS = diagnosticsFixture();

function fileSummary(id: string) {
  const isGateway = id.includes('gateway');
  return {
    id,
    kind: isGateway ? ('gateway' as const) : ('server' as const),
    path: isGateway ? 'gateway.jsonc' : 'server.jsonc',
    exists: true,
    revision: 'revision-1',
    updatedAt: TIMESTAMP,
  };
}

function makeClient(
  overrides: {
    diagnostics?: Record<string, unknown>;
    providers?: Record<string, unknown>;
    accounts?: unknown[];
    operations?: Record<string, unknown>;
  } = {}
): CoreClient {
  let currentServerContent = SERVER_JSONC;
  let currentGatewayContent = GATEWAY_JSONC;
  const accounts = overrides.accounts ?? ACCOUNTS;

  return {
    core: {
      meta: vi.fn().mockResolvedValue({}),
    },
    app: {},
    operations: {
      'diagnostics.app': vi.fn().mockResolvedValue(overrides.diagnostics ?? GATEWAY_DIAGNOSTICS),
      'runtime.file-read': vi.fn().mockImplementation((input: { id: string }) => {
        const isGateway = input.id.includes('gateway');
        return Promise.resolve({
          file: fileSummary(input.id),
          content: isGateway ? currentGatewayContent : currentServerContent,
        });
      }),
      'runtime.validate': vi.fn().mockResolvedValue({
        valid: true,
        diagnostics: [],
        plan: PLAN,
        runtimeConfig: RUNTIME_CONFIG,
      }),
      'runtime.file-update': vi
        .fn()
        .mockImplementation((input: { id?: string; kind?: string; content?: string }) => {
          const isGateway = (input.id ?? '').includes('gateway') || input.kind === 'gateway';
          if (isGateway) {
            currentGatewayContent = input.content ?? currentGatewayContent;
          } else {
            currentServerContent = input.content ?? currentServerContent;
          }
          return Promise.resolve({
            file: fileSummary(input.id ?? 'server.jsonc'),
            diagnostics: [],
          });
        }),
      'runtime.file-create': vi.fn().mockResolvedValue({
        file: fileSummary('providers/openrouter.provider.jsonc'),
        diagnostics: [],
      }),
      'runtime.file-delete': vi.fn().mockResolvedValue(null),
      'runtime.reload': vi.fn().mockResolvedValue({
        status: 'applied',
        plan: PLAN,
        runtimeConfig: RUNTIME_CONFIG,
      }),
      'provider-subscription.provider-list': vi
        .fn()
        .mockResolvedValue(overrides.providers ?? PROVIDERS),
      'provider-subscription.account-list': vi
        .fn()
        .mockImplementation(({ subscriptionProviderId }: { subscriptionProviderId: string }) =>
          Promise.resolve({
            accounts: subscriptionProviderId === 'openai-codex' ? accounts : [],
          })
        ),
      'provider-subscription.account-create': vi.fn().mockResolvedValue(accounts[0] ?? null),
      'provider-subscription.account-update': vi.fn().mockResolvedValue(accounts[0] ?? null),
      'provider-subscription.account-delete': vi.fn().mockResolvedValue(null),
      'provider-subscription.account-status': vi
        .fn()
        .mockImplementation(
          ({
            subscriptionProviderId,
            accountSlotId,
          }: {
            subscriptionProviderId: string;
            accountSlotId: string;
          }) =>
            Promise.resolve(
              accounts.find(
                (account) =>
                  (account as { subscriptionProviderId: string }).subscriptionProviderId ===
                    subscriptionProviderId &&
                  (account as { accountSlotId: string }).accountSlotId === accountSlotId
              ) ?? accounts[0]
            )
        ),
      'provider-subscription.login-start': vi.fn().mockResolvedValue(accounts[0] ?? null),
      'provider-subscription.login-cancel': vi.fn().mockResolvedValue(accounts[0] ?? null),
      'provider-subscription.account-logout': vi.fn().mockResolvedValue(accounts[0] ?? null),
      'provider-subscription.account-quota': vi
        .fn()
        .mockRejectedValue(new Error('Quota unavailable in this fixture.')),
      'vault.provider-api-key-set': vi
        .fn()
        .mockResolvedValue({ providerId: 'provider_anthropic', configured: true }),
      'local-ai.status': vi.fn().mockResolvedValue({
        backends: [
          {
            backendId: 'sherpa-onnx-asr',
            enabled: false,
            selectedModelId: null,
            phase: 'disabled',
            bytesReceived: 0,
            bytesTotal: null,
          },
        ],
      }),
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
        <MemoryRouter>
          <AiInterfaceScreen />
        </MemoryRouter>
      </CoreClientProvider>
    </QueryClientProvider>
  );
  return { ...rendered, queryClient };
}

beforeEach(() => {
  localStorage.clear();
});

describe('Gateway piles', () => {
  it('renders a level-1 Gateway heading', async () => {
    renderScreen(makeClient());
    expect(await screen.findByRole('heading', { level: 1, name: 'Gateway' })).toBeVisible();
  });

  it('renders the three named piles', async () => {
    renderScreen(makeClient());
    expect(await screen.findByRole('region', { name: 'In use' })).toBeVisible();
    expect(screen.getByRole('region', { name: 'Providers' })).toBeVisible();
    expect(screen.getByRole('region', { name: 'Not set up' })).toBeVisible();
  });

  it('uses the three empty sentences when no logical models or providers exist', async () => {
    renderScreen(
      makeClient({
        diagnostics: diagnosticsFixture({ models: [], registry: [] }),
        providers: { providers: [] },
        accounts: [],
      })
    );
    const inUse = await screen.findByRole('region', { name: 'In use' });
    const providers = screen.getByRole('region', { name: 'Providers' });
    const notSetUp = screen.getByRole('region', { name: 'Not set up' });
    expect(within(inUse).getByText('No Logical models yet')).toBeVisible();
    expect(within(providers).getByText('No Providers connected')).toBeVisible();
    expect(within(notSetUp).getByText('Nothing waiting to be set up')).toBeVisible();
  });

  it('renders a logical model as an ordered member chain with profile, native model, and account label', async () => {
    renderScreen(makeClient());
    const card = await screen.findByRole('region', { name: 'Notes model' });
    const rows = within(card).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('Primary');
    expect(rows[0]).toHaveTextContent('Anthropic');
    expect(rows[0]).toHaveTextContent('claude-x');
    expect(rows[1]).toHaveTextContent('Backup 1');
    expect(rows[1]).toHaveTextContent('OpenAI sub');
    expect(rows[1]).toHaveTextContent('gpt-y');
    expect(rows[1]).toHaveTextContent('Work account');
    expect(rows[2]).toHaveTextContent('Backup 2');
    expect(rows[2]).toHaveTextContent('DeepSeek');
    expect(rows[2]).toHaveTextContent('v4');
  });

  it('renders server availability and the closed reason prose instead of the raw reason token', async () => {
    renderScreen(makeClient());

    const notes = await screen.findByRole('region', { name: 'Notes model' });
    const notesRows = within(notes).getAllByRole('listitem');
    expect(notesRows[0]).toHaveTextContent('available');
    expect(notesRows[1]).toHaveTextContent('unavailable: slot not signed in');
    expect(notesRows[1]).not.toHaveTextContent('subscription_account_logged_out');

    const fast = screen.getByRole('region', { name: 'Fast model' });
    const fastRows = within(fast).getAllByRole('listitem');
    expect(fastRows[0]).toHaveTextContent('unavailable: missing key');

    const mystery = screen.getByRole('region', { name: 'Mystery model' });
    expect(within(mystery).getByText('status unknown')).toBeVisible();
    expect(within(mystery).queryByRole('listitem')).toBeNull();
    expect(within(mystery).queryByText(/Primary/)).toBeNull();
  });

  it('states the failover behaviour as the two exact sentences', async () => {
    renderScreen(makeClient());
    const notes = await screen.findByRole('region', { name: 'Notes model' });
    const fast = screen.getByRole('region', { name: 'Fast model' });
    expect(
      within(notes).getByText('If the primary fails, the next available member is used.')
    ).toBeVisible();
    expect(within(fast).getByText('Only the primary is used. Backups stay dormant.')).toBeVisible();
  });

  it('collapses the derived contract under a Contract summary and shows the server values', async () => {
    renderScreen(makeClient());
    const card = await screen.findByRole('region', { name: 'Notes model' });

    const hiddenFamily = within(card).queryByText('Family unknown');
    if (hiddenFamily) {
      expect(hiddenFamily).not.toBeVisible();
    }

    await userEvent.click(within(card).getByText('Contract'));

    expect(await within(card).findByText('Family unknown')).toBeVisible();
    expect(within(card).getByText(/128,000|128k|128000/)).toBeVisible();
    expect(within(card).getByText(/16,384|16k|16384/)).toBeVisible();
    expect(within(card).getAllByText(/\btext\b/).length).toBeGreaterThan(0);
    expect(within(card).getAllByText(/\bimage\b/).length).toBeGreaterThan(0);
    expect(within(card).getAllByText(/chat/i).length).toBeGreaterThan(0);
    expect(within(card).getAllByText(/low/).length).toBeGreaterThan(0);
    expect(within(card).getAllByText(/med/).length).toBeGreaterThan(0);
    expect(within(card).queryByText(/mixed/i)).toBeNull();
  });

  it('shows the published model family, and mixed only when that family is null', async () => {
    const models = MODELS.map((model) => {
      if (model.id === 'notes' && model.contract) {
        return {
          ...model,
          modelFamilyId: 'claude',
          contract: { ...model.contract, modelFamilyId: 'claude' },
        };
      }
      if (model.id === 'fast' && model.contract) {
        return {
          ...model,
          modelFamilyId: null,
          contract: { ...model.contract, modelFamilyId: null },
        };
      }
      return model;
    });
    renderScreen(makeClient({ diagnostics: diagnosticsFixture({ models }) }));

    const notes = await screen.findByRole('region', { name: 'Notes model' });
    await userEvent.click(within(notes).getByText('Contract'));
    expect(await within(notes).findByText('Family claude')).toBeVisible();
    expect(within(notes).queryByText('mixed')).toBeNull();
    expect(within(notes).queryByText('Family unknown')).toBeNull();

    const fast = screen.getByRole('region', { name: 'Fast model' });
    await userEvent.click(within(fast).getByText('Contract'));
    expect(await within(fast).findByText('mixed')).toBeVisible();
    expect(within(fast).queryByText('Family unknown')).toBeNull();
  });

  it('labels account rotation once above the members that differ only in account slot', async () => {
    renderScreen(makeClient());
    const card = await screen.findByRole('region', { name: 'Rotation model' });
    const rows = within(card).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('gpt-y');
    expect(rows[1]).toHaveTextContent('gpt-y');
    expect(rows[0]).toHaveTextContent('Work account');
    expect(rows[1]).toHaveTextContent('Personal account');

    const label = within(card).getByText('Account rotation: 2 accounts');
    expect(label.compareDocumentPosition(rows[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('lists the logical model and member place in a provider region', async () => {
    renderScreen(makeClient());
    const provider = await screen.findByRole('region', { name: 'Anthropic' });
    expect(within(provider).getByText(/Used by:/)).toBeVisible();
    expect(within(provider).getByText(/Notes model \(primary\)/)).toBeVisible();
  });

  it('edits the route order without drag and reloads only after Reload configuration', async () => {
    const client = makeClient();
    const update = client.operations['runtime.file-update'] as ReturnType<typeof vi.fn>;
    const reload = client.operations['runtime.reload'] as ReturnType<typeof vi.fn>;
    renderScreen(client);

    const card = await screen.findByRole('region', { name: 'Notes model' });
    await userEvent.click(within(card).getByRole('button', { name: 'Edit route' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'Move up Primary' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Move down Backup 1' })).toBeInTheDocument();
    expect(document.querySelector('[draggable="true"]')).toBeNull();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Move up Backup 1' }));
    await userEvent.click(within(dialog).getAllByRole('button', { name: /save|apply/i })[0]);

    await waitFor(() => expect(update).toHaveBeenCalled());
    const gatewayWrite = update.mock.calls.find(([input]) =>
      String((input as { content?: string }).content ?? '').includes('gpt-y')
    ) as [{ content: string }] | undefined;
    expect(gatewayWrite).toBeDefined();

    const parsed = parse(gatewayWrite?.[0].content ?? '') as {
      logicalModels?: Array<{ id: string; routes: Array<{ id: string }> }>;
      models?: Array<{ id: string; routes: Array<{ id: string }> }>;
    };
    const models = parsed.logicalModels ?? parsed.models ?? [];
    const notes = models.find((model) => model.id === 'notes');
    expect(notes).toBeDefined();
    expect(notes?.routes.map((route) => route.id)).toEqual([
      'route-notes-backup',
      'route-notes-primary',
      'route-notes-backup-2',
    ]);
    expect(reload).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Reload configuration' }));
    await waitFor(() => expect(reload).toHaveBeenCalled());
  });

  it('keeps reload and restart distinct and does not expose a restart-required button', async () => {
    renderScreen(
      makeClient({
        diagnostics: diagnosticsFixture({
          pendingRestart: [
            {
              path: 'gateway.jsonc',
              category: 'restart-required',
              action: 'requires-restart',
              summary: 'Gateway routes changed',
            },
          ],
        }),
      })
    );

    const reload = await screen.findByRole('button', { name: 'Reload configuration' });
    expect(reload).toBeVisible();
    expect(reload).not.toHaveTextContent(/restart/i);
    expect(screen.queryByRole('button', { name: /restart required/i })).toBeNull();
  });

  it('keeps guided setup reachable inside Not set up', async () => {
    renderScreen(makeClient());
    const notSetUp = await screen.findByRole('region', { name: 'Not set up' });
    expect(await within(notSetUp).findByLabelText('Setup Provider id')).toBeVisible();
    expect(
      within(notSetUp).getByRole('button', { name: 'Add subscription Provider' })
    ).toBeVisible();
  });

  it('removes a provider through Remove Provider without rewriting routes', async () => {
    const client = makeClient();
    const update = client.operations['runtime.file-update'] as ReturnType<typeof vi.fn>;
    renderScreen(client);

    const provider = await screen.findByRole('region', { name: 'Anthropic' });
    expect(within(provider).getByText(/Notes model \(primary\)/)).toBeVisible();

    await userEvent.click(within(provider).getByRole('button', { name: 'Remove Provider' }));

    const routeWrites = update.mock.calls.filter(([input]) =>
      String((input as { content?: string }).content ?? '').includes('routes')
    );
    expect(routeWrites).toHaveLength(0);
  });

  it('keeps route member ids off the primary member line', async () => {
    renderScreen(makeClient());
    const card = await screen.findByRole('region', { name: 'Notes model' });
    const rows = within(card).getAllByRole('listitem');
    const ids = ['route-notes-primary', 'route-notes-backup', 'route-notes-backup-2'];
    for (const [index, id] of ids.entries()) {
      expect((rows[index].textContent ?? '').trim().startsWith(id)).toBe(false);
    }
  });
});
