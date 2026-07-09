import { cleanup, fireEvent, render, screen, waitFor, within } from '@solidjs/testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  AppDiagnostics,
  MetaResponse,
  SetupDiagnostics,
  Turn,
  TurnEvent,
} from '../lib/app-types';
import { DiagnosticsPanel } from './DiagnosticsPanel';

const meta: MetaResponse = {
  protocolVersion: '0.3.0',
  capabilities: ['core.approvals', 'core.artifacts'],
  eventFamilies: ['turn.started', 'item.created', 'turn.completed'],
  itemTypes: ['assistant-message'],
  itemDeltaKinds: ['text-delta'],
};

const timestamp = '2026-04-15T09:00:00.000Z';

/**
 * Creates runtime config stale-session recovery choices for diagnostics fixtures.
 */
function runtimeConfigStaleSessionChoices(): NonNullable<
  SetupDiagnostics['runtimeConfig']
>['staleSessions'][number]['choices'] {
  return [
    { kind: 'inspect', label: 'Inspect session', recommended: true },
    { kind: 'restart_session', label: 'Restart session' },
    { kind: 'request_human', label: 'Request human review' },
  ];
}

/**
 * Creates an all-ready boot readiness snapshot for diagnostics fixtures.
 */
function bootReadiness(): AppDiagnostics['boot'] {
  const ready = { state: 'ready' as const, reasons: [] };

  return {
    bootId: 'boot_web_test',
    acceptingProductWork: true,
    overall: 'ready',
    subsystems: {
      config: ready,
      storage: ready,
      policy: ready,
      vault: ready,
      scheduler: ready,
      llmGateway: ready,
      knowledgeIndex: ready,
    },
  };
}

/**
 * Builds one runtime config diagnostics fixture.
 */
function runtimeConfigStatus(): NonNullable<SetupDiagnostics['runtimeConfig']> {
  return {
    currentVersion: 2,
    loadedAt: timestamp,
    lastReload: {
      at: '2026-04-15T09:05:00.000Z',
      mode: 'safe',
      dryRun: false,
      previousVersion: 1,
      currentVersion: 2,
      status: 'applied',
      message: null,
    },
    lastFailedReload: {
      at: '2026-04-15T09:06:00.000Z',
      mode: 'strict',
      dryRun: false,
      previousVersion: 2,
      currentVersion: 2,
      status: 'failed',
      message: 'Invalid provider config.',
    },
    pendingRestart: [
      {
        path: 'gateway.openaiCompatible.route',
        category: 'restart-required',
        action: 'requires-restart',
        summary: 'Gateway route changes require restart.',
      },
    ],
    staleSessions: [
      {
        sessionId: 'session_stale',
        threadId: 'th_demo',
        agentId: 'agent_planner',
        capturedVersion: 1,
        currentVersion: 2,
        reasons: ['session-scoped config changed'],
        choices: runtimeConfigStaleSessionChoices(),
      },
    ],
  };
}

/**
 * Builds one app diagnostics fixture.
 */
function appDiagnostics(_removedDefaultProvider?: unknown): AppDiagnostics {
  return {
    service: 'nanocore',
    boot: bootReadiness(),
    gateway: {
      status: 'ok',
      endpoints: ['/health', '/v1/models', '/v1/chat/completions', '/v1/responses'],
    },
    providers: { diagnostics: [], registry: [] },
    defaultProviders: {
      core: {
        configured: true,
        model: 'gpt-5.4',
        origin: 'canonical',
        providerId: 'core-openrouter',
      },
      gateway: {
        configured: true,
        model: 'gpt-5.4',
        origin: 'canonical',
        providerId: 'gateway-openrouter',
      },
    },
    defaults: {
      quickChat: { providerId: null, model: null },
      internalTasks: { providerId: null, model: null },
      gateway: { providerId: null, model: null },
    },
    oauth: {
      openaiCodexAccounts: {
        accounts: [
          {
            providerId: 'openai_codex',
            accountSlotId: 'default',
            boundProviderIds: [],
            isDefault: true,
            status: 'logged_out',
          },
        ],
        defaultAccountSlotId: 'default',
      },
    },
    capabilities: meta.capabilities,
    runtimeConfig: runtimeConfigStatus(),
    internalAgents: { agents: [], recentFailures: [] },
  };
}

/**
 * Builds one setup diagnostics fixture.
 */
function setupDiagnostics(): SetupDiagnostics {
  return {
    service: 'nanocore',
    server: {
      mode: 'local',
      dataRoot: '/private/tmp/openkit-web-test-data-root',
      config: {
        schemaVersion: 1,
        defaults: {
          coreProviderId: 'agent-openrouter',
          gatewayProviderId: 'gateway-openai',
        },
        gateway: {
          openaiCompatible: {
            auth: { configured: true, marker: 'redacted', ref: null },
            defaultModel: 'openai/gpt-5.4',
            defaultProviderId: 'gateway-openai',
            enabled: true,
            route: '/v1',
          },
        },
      },
    },
    providers: [],
    agents: [],
    runtimeConfig: runtimeConfigStatus(),
  };
}

/**
 * Builds one diagnostics event.
 */
function event(sequence: number, name: TurnEvent['event']): TurnEvent {
  return {
    protocolVersion: '0.3.0',
    event: name,
    requestId: null,
    workspaceId: 'ws_demo',
    threadId: 'th_demo',
    turnId: 'tu_demo',
    sequence,
    timestamp,
    data:
      name === 'turn.completed'
        ? {
            type: 'turn-completed',
            turn: {
              id: 'tu_demo',
              workspaceId: 'ws_demo',
              threadId: 'th_demo',
              items: [],
              status: 'completed',
              humanGate: null,
              error: null,
              configVersion: 2,
              startedAt: timestamp,
              completedAt: timestamp,
              durationMs: 1,
            },
          }
        : name === 'turn.started'
          ? { type: 'turn-started', turnId: 'tu_demo', status: 'running' }
          : {
              type: 'item-delta',
              itemId: 'it_demo',
              deltaKind: 'text-delta',
              delta: 'hello',
            },
  };
}

afterEach(() => {
  cleanup();
});

describe('DiagnosticsPanel', () => {
  it('renders the meta snapshot', () => {
    render(() => <DiagnosticsPanel events={[]} meta={meta} turns={[]} />);

    expect(screen.getByRole('heading', { name: /api\/meta snapshot/i })).toBeInTheDocument();
    expect(screen.getByText(/"protocolVersion": "0.3.0"/i)).toBeInTheDocument();
  });

  it('renders configured usable role default providers from app diagnostics', () => {
    render(() => (
      <DiagnosticsPanel
        appDiagnostics={appDiagnostics({ configured: true, providerId: 'openrouter' })}
        events={[]}
        meta={meta}
        turns={[]}
      />
    ));

    expect(screen.getByText(/^Core default provider$/i)).toBeInTheDocument();
    expect(screen.getByText(/^Gateway default provider$/i)).toBeInTheDocument();
    expect(screen.getByText(/^core-openrouter$/i)).toBeInTheDocument();
    expect(screen.getByText(/^gateway-openrouter$/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Ready from canonical/i)).toHaveLength(2);
  });

  it('renders role default-provider failure reasons from app diagnostics', () => {
    const cases: Array<{
      coreProvider: NonNullable<AppDiagnostics['defaultProviders']>['core'];
      expectedDetail: RegExp;
      expectedValue: RegExp;
    }> = [
      {
        coreProvider: { configured: false, origin: 'unset', reason: 'unset' },
        expectedDetail: /No provider configured/i,
        expectedValue: /^Unset$/i,
      },
      {
        coreProvider: {
          configured: false,
          model: null,
          origin: 'canonical',
          providerId: 'missing-provider',
          reason: 'unknown-id',
        },
        expectedDetail: /Unknown provider id/i,
        expectedValue: /missing-provider/i,
      },
      {
        coreProvider: {
          configured: false,
          model: null,
          origin: 'canonical',
          providerId: 'openai',
          reason: 'credentials-missing',
        },
        expectedDetail: /Credentials missing/i,
        expectedValue: /openai/i,
      },
    ];

    for (const item of cases) {
      cleanup();
      render(() => (
        <DiagnosticsPanel
          appDiagnostics={{
            ...appDiagnostics(),
            defaultProviders: {
              ...appDiagnostics().defaultProviders,
              core: item.coreProvider,
            },
          }}
          events={[]}
          meta={meta}
          turns={[]}
        />
      ));

      expect(screen.getAllByText(item.expectedValue).length).toBeGreaterThan(0);
      expect(screen.getAllByText(item.expectedDetail).length).toBeGreaterThan(0);
    }
  });

  it('renders split default providers with origin details', () => {
    render(() => (
      <DiagnosticsPanel
        appDiagnostics={{
          ...appDiagnostics({ configured: true, providerId: 'test-openrouter' }),
          defaultProviders: {
            core: {
              configured: true,
              model: 'openai/gpt-5.4',
              origin: 'canonical',
              providerId: 'agent-openrouter',
            },
            gateway: {
              configured: false,
              model: null,
              origin: 'canonical',
              providerId: 'gateway-openai',
              reason: 'credentials-missing',
            },
          },
        }}
        events={[]}
        inspectMode="protocol"
        meta={meta}
        turns={[]}
      />
    ));

    expect(screen.getByText(/Core default provider/i)).toBeInTheDocument();
    expect(screen.getByText(/agent-openrouter/i)).toBeInTheDocument();
    expect(screen.getAllByText(/canonical/i)).toHaveLength(2);
    expect(screen.getByText(/Gateway default provider/i)).toBeInTheDocument();
    expect(screen.getByText(/gateway-openai/i)).toBeInTheDocument();
    expect(screen.getByText(/Credentials missing/i)).toBeInTheDocument();
  });

  it('renders LLM gateway endpoint and provider capability diagnostics', () => {
    render(() => (
      <DiagnosticsPanel
        appDiagnostics={{
          ...appDiagnostics({ configured: true, providerId: 'openrouter' }),
          gateway: {
            endpoints: ['/health', '/v1/models', '/v1/chat/completions', '/v1/responses'],
            status: 'ok',
            usage: {
              summaries: [
                {
                  cachedInputTokens: 60,
                  cacheHitRate: 0.6,
                  completionTokens: 25,
                  endpoint: 'responses',
                  inputTokens: 100,
                  lastObservedAt: '2026-05-26T00:00:00.000Z',
                  model: 'gpt-5.1',
                  providerId: 'openai-default',
                  requestCount: 1,
                  totalTokens: 125,
                },
              ],
            },
          },
          providers: {
            diagnostics: [],
            registry: [
              {
                id: 'openai-default',
                gatewayCapabilities: {
                  chatCompletions: 'native',
                  responses: 'native',
                },
                displayName: 'OpenAI default',
                kind: 'direct',
                models: ['gpt-5.1'],
              },
              {
                id: 'openai-codex',
                gatewayCapabilities: {
                  chatCompletions: 'bridged',
                  responses: 'native',
                },
                displayName: 'OpenAI Codex',
                kind: 'codex',
                models: ['gpt-5.1'],
              },
            ],
          },
        }}
        events={[]}
        meta={meta}
        turns={[]}
      />
    ));

    expect(screen.getByText('/v1/responses')).toBeInTheDocument();
    expect(screen.getByText(/chat native/i)).toBeInTheDocument();
    expect(screen.getAllByText(/responses native/i)).toHaveLength(2);
    expect(screen.getByText(/chat bridged/i)).toBeInTheDocument();
    expect(screen.getByText(/60 cached input tokens/i)).toBeInTheDocument();
    expect(screen.getByText(/60% cache hit rate/i)).toBeInTheDocument();
    expect(screen.queryByText(/prompt_cache_key/i)).not.toBeInTheDocument();
  });

  it('starts Codex ChatGPT browser and device-code login from diagnostics', () => {
    const onStartCodexOAuth = vi.fn();
    render(() => (
      <DiagnosticsPanel
        appDiagnostics={appDiagnostics({ configured: true, providerId: 'openrouter' })}
        events={[]}
        meta={meta}
        onStartCodexOAuth={onStartCodexOAuth}
        turns={[]}
      />
    ));

    fireEvent.click(screen.getByRole('button', { name: /Continue with ChatGPT/i }));
    fireEvent.click(screen.getByRole('button', { name: /Use device code/i }));

    expect(onStartCodexOAuth).toHaveBeenNthCalledWith(1, 'browser', 'default');
    expect(onStartCodexOAuth).toHaveBeenNthCalledWith(2, 'device_code', 'default');
  });

  it('renders pending Codex ChatGPT device-code login and cancels it', () => {
    const onCancelCodexOAuth = vi.fn();
    render(() => (
      <DiagnosticsPanel
        appDiagnostics={{
          ...appDiagnostics({ configured: true, providerId: 'openrouter' }),
          oauth: {
            openaiCodexAccounts: {
              accounts: [
                {
                  providerId: 'openai_codex',
                  accountSlotId: 'default',
                  boundProviderIds: [],
                  isDefault: true,
                  status: 'pending',
                  mode: 'device_code',
                  loginId: 'login_device',
                  verificationUrl: 'https://chatgpt.com/activate',
                  userCode: 'OPEN-KIT',
                },
              ],
              defaultAccountSlotId: 'default',
            },
          },
        }}
        events={[]}
        meta={meta}
        onCancelCodexOAuth={onCancelCodexOAuth}
        turns={[]}
      />
    ));

    expect(screen.getByRole('link', { name: /Open device login/i })).toHaveAttribute(
      'href',
      'https://chatgpt.com/activate'
    );
    expect(screen.getByText('OPEN-KIT')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Cancel login/i }));

    expect(onCancelCodexOAuth).toHaveBeenCalledWith('login_device', 'default');
  });

  it('renders default Codex ChatGPT sign-in actions from diagnostics account rows', () => {
    const onStartCodexOAuth = vi.fn();
    render(() => (
      <DiagnosticsPanel
        appDiagnostics={appDiagnostics({ configured: true, providerId: 'openrouter' })}
        events={[]}
        meta={meta}
        onStartCodexOAuth={onStartCodexOAuth}
        turns={[]}
      />
    ));

    expect(screen.getAllByText('default').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: /Continue with ChatGPT/i }));
    fireEvent.click(screen.getByRole('button', { name: /Use device code/i }));

    expect(onStartCodexOAuth).toHaveBeenCalledWith('browser', 'default');
    expect(onStartCodexOAuth).toHaveBeenCalledWith('device_code', 'default');
  });

  it('renders logged-in Codex ChatGPT account details and signs out', () => {
    const onLogoutCodexOAuth = vi.fn();
    render(() => (
      <DiagnosticsPanel
        appDiagnostics={{
          ...appDiagnostics({ configured: true, providerId: 'openrouter' }),
          oauth: {
            openaiCodexAccounts: {
              accounts: [
                {
                  providerId: 'openai_codex',
                  accountSlotId: 'default',
                  boundProviderIds: [],
                  isDefault: true,
                  status: 'logged_in',
                  accountLabel: 'user@example.com',
                  planType: 'plus',
                },
              ],
              defaultAccountSlotId: 'default',
            },
          },
        }}
        events={[]}
        meta={meta}
        onLogoutCodexOAuth={onLogoutCodexOAuth}
        turns={[]}
      />
    ));

    expect(screen.getByText(/user@example.com/i)).toBeInTheDocument();
    expect(screen.getByText(/plus/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Sign out/i }));

    expect(onLogoutCodexOAuth).toHaveBeenCalledOnce();
  });

  it('manages multiple Codex ChatGPT account slots without rendering secret paths', () => {
    const onCreateCodexOAuthAccount = vi.fn();
    const onUpdateCodexOAuthAccount = vi.fn();
    const onDeleteCodexOAuthAccount = vi.fn();
    const onStartCodexOAuth = vi.fn();
    render(() => (
      <DiagnosticsPanel
        appDiagnostics={{
          ...appDiagnostics({ configured: true, providerId: 'openrouter' }),
          oauth: {
            openaiCodexAccounts: {
              accounts: [
                {
                  accountSlotId: 'team_a',
                  boundProviderIds: ['codex-team-a'],
                  displayName: 'Team A',
                  isDefault: true,
                  providerId: 'openai_codex',
                  status: 'logged_out',
                },
                {
                  accountLabel: 'user@example.com',
                  accountSlotId: 'team_b',
                  boundProviderIds: ['codex-team-b'],
                  displayName: 'Team B',
                  isDefault: false,
                  planType: 'plus',
                  providerId: 'openai_codex',
                  status: 'logged_in',
                },
              ],
              defaultAccountSlotId: 'team_a',
            },
          },
        }}
        events={[]}
        meta={meta}
        onCreateCodexOAuthAccount={onCreateCodexOAuthAccount}
        onDeleteCodexOAuthAccount={onDeleteCodexOAuthAccount}
        onStartCodexOAuth={onStartCodexOAuth}
        onUpdateCodexOAuthAccount={onUpdateCodexOAuthAccount}
        turns={[]}
      />
    ));

    fireEvent.input(screen.getByLabelText(/Account slot id/i), {
      target: { value: 'team_c' },
    });
    fireEvent.input(screen.getByLabelText(/^Display name$/i), {
      target: { value: 'Team C' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Add account/i }));
    fireEvent.input(screen.getByLabelText(/Display name for team_a/i), {
      target: { value: 'Team Alpha' },
    });
    fireEvent.click(screen.getAllByRole('button', { name: /Save name/i })[0] as HTMLElement);
    fireEvent.click(screen.getAllByRole('button', { name: /Delete/i })[0] as HTMLElement);
    fireEvent.click(
      screen.getAllByRole('button', { name: /Continue with ChatGPT/i })[1] as HTMLElement
    );

    expect(screen.getAllByText('team_a').length).toBeGreaterThan(0);
    expect(screen.getByText('codex-team-b')).toBeInTheDocument();
    expect(screen.queryByText(/codex-home|auth\.json|Bearer|chatgpt-account-id/i)).toBeNull();
    expect(onCreateCodexOAuthAccount).toHaveBeenCalledWith({
      accountSlotId: 'team_c',
      displayName: 'Team C',
    });
    expect(onUpdateCodexOAuthAccount).toHaveBeenCalledWith('team_a', {
      displayName: 'Team Alpha',
    });
    expect(onDeleteCodexOAuthAccount).toHaveBeenCalledWith('team_a');
    expect(onStartCodexOAuth).toHaveBeenCalledWith('browser', 'team_b');
  });

  it('keeps account creation input and shows inline failures', async () => {
    const onCreateCodexOAuthAccount = vi
      .fn()
      .mockRejectedValue(new Error('Codex OAuth account slot already exists: slotmeid'));
    render(() => (
      <DiagnosticsPanel
        appDiagnostics={{
          ...appDiagnostics({ configured: true, providerId: 'openrouter' }),
          oauth: {
            openaiCodexAccounts: {
              accounts: [
                {
                  accountSlotId: 'default',
                  boundProviderIds: [],
                  displayName: 'hi-codex',
                  isDefault: true,
                  providerId: 'openai_codex',
                  status: 'logged_in',
                  accountLabel: 'user@example.com',
                  planType: 'prolite',
                },
                {
                  accountSlotId: 'ntd',
                  boundProviderIds: [],
                  displayName: 'codex-ntd',
                  isDefault: false,
                  providerId: 'openai_codex',
                  status: 'logged_out',
                },
              ],
              defaultAccountSlotId: 'default',
            },
          },
        }}
        events={[]}
        meta={meta}
        onCreateCodexOAuthAccount={onCreateCodexOAuthAccount}
        turns={[]}
      />
    ));

    expect(screen.getByText('logged_in')).toBeInTheDocument();
    expect(screen.getByText('logged_out')).toBeInTheDocument();
    expect(screen.getByText('hi-codex')).toBeInTheDocument();
    expect(screen.getByText('user@example.com')).toBeInTheDocument();
    expect(screen.getByText('prolite')).toBeInTheDocument();

    fireEvent.input(screen.getByLabelText(/Slot\/folder ID/i), {
      target: { value: 'slotmeid' },
    });
    fireEvent.input(screen.getByLabelText(/^Display name$/i), {
      target: { value: 'SlotMeID' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Add account/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/already exists: slotmeid/i);
    });
    expect(screen.getByLabelText(/Slot\/folder ID/i)).toHaveValue('slotmeid');
    expect(screen.getByLabelText(/^Display name$/i)).toHaveValue('SlotMeID');
  });

  it('uses product mode to hide full protocol snapshots', () => {
    render(() => (
      <DiagnosticsPanel
        events={[event(1, 'turn.started')]}
        inspectMode="product"
        meta={meta}
        turns={[]}
      />
    ));

    expect(screen.queryByRole('heading', { name: /api\/meta snapshot/i })).toBeNull();
    expect(screen.queryByLabelText(/latest event envelopes/i)).toBeNull();
  });

  it('uses protocol mode to show full protocol snapshots', () => {
    render(() => (
      <DiagnosticsPanel
        events={[event(1, 'turn.started')]}
        inspectMode="protocol"
        meta={meta}
        turns={[]}
      />
    ));

    expect(screen.getByRole('heading', { name: /api\/meta snapshot/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/latest event envelopes/i)).toBeInTheDocument();
  });

  it('renders unknown stream event names in protocol inspect mode', () => {
    render(() => (
      <DiagnosticsPanel
        events={[event(1, 'item.futureDelta')]}
        inspectMode="protocol"
        meta={meta}
        turns={[]}
      />
    ));

    expect(screen.getByText('item.futureDelta')).toBeInTheDocument();
  });

  it('renders the setup server summary', () => {
    render(() => (
      <DiagnosticsPanel
        events={[]}
        inspectMode="protocol"
        meta={meta}
        setupDiagnostics={setupDiagnostics()}
        turns={[]}
      />
    ));

    expect(screen.getByText(/Server summary/i)).toBeInTheDocument();
    expect(screen.getByText(/^local$/i)).toBeInTheDocument();
    expect(screen.getByText(/openkit-web-test-data-root/i)).toBeInTheDocument();
    expect(screen.getByText(/agent-openrouter/i)).toBeInTheDocument();
    expect(screen.getByText(/gateway-openai/i)).toBeInTheDocument();
    expect(screen.getByText(/gateway enabled/i)).toBeInTheDocument();
  });

  it('renders runtime config reload status and pending restart items', () => {
    render(() => (
      <DiagnosticsPanel
        appDiagnostics={appDiagnostics({ configured: true, providerId: 'openrouter' })}
        events={[]}
        meta={meta}
        setupDiagnostics={setupDiagnostics()}
        turns={[]}
      />
    ));

    const runtimeSection = screen.getByLabelText(/runtime config status/i);

    expect(runtimeSection).toHaveTextContent('v2');
    expect(runtimeSection).toHaveTextContent('last reload applied');
    expect(runtimeSection).toHaveTextContent('last failure failed');
    expect(runtimeSection).toHaveTextContent('gateway.openaiCompatible.route');
    expect(runtimeSection).toHaveTextContent('1 stale session');
  });

  it('submits runtime config reload controls with selected mode', () => {
    const onReloadRuntimeConfig = vi.fn();
    render(() => (
      <DiagnosticsPanel
        events={[]}
        meta={meta}
        onReloadRuntimeConfig={onReloadRuntimeConfig}
        setupDiagnostics={setupDiagnostics()}
        turns={[]}
      />
    ));

    fireEvent.input(screen.getByLabelText(/runtime config reload mode/i), {
      target: { value: 'strict' },
    });
    fireEvent.click(screen.getByRole('button', { name: /dry run runtime config reload/i }));
    fireEvent.click(screen.getByRole('button', { name: /^reload runtime config$/i }));

    expect(onReloadRuntimeConfig).toHaveBeenNthCalledWith(1, { dryRun: true, mode: 'strict' });
    expect(onReloadRuntimeConfig).toHaveBeenNthCalledWith(2, { dryRun: false, mode: 'strict' });
  });

  it('labels agent readiness and setup statuses separately', () => {
    const diagnostics = setupDiagnostics();
    diagnostics.agents = [
      {
        id: 'agent_codex_host',
        displayName: 'Codex Host Agent',
        setup: {
          status: 'ready',
          deploymentMode: 'host',
          providerId: 'agent-openrouter',
          diagnostics: [],
        },
        readiness: {
          status: 'blocked',
          reasons: ['provider_unavailable'],
        },
      },
    ];

    render(() => (
      <DiagnosticsPanel events={[]} meta={meta} setupDiagnostics={diagnostics} turns={[]} />
    ));

    expect(screen.getByText(/readiness: blocked/i)).toBeInTheDocument();
    expect(screen.getByText(/setup: ready/i)).toBeInTheDocument();
  });

  it('caps envelopes at 200 entries and filters by event family', () => {
    const events = Array.from({ length: 205 }, (_, index) =>
      event(index + 1, index === 204 ? 'turn.completed' : 'item.delta')
    );

    render(() => <DiagnosticsPanel events={events} meta={meta} turns={[]} />);

    expect(screen.getByText(/200 envelopes/i)).toBeInTheDocument();
    expect(screen.queryByText(/#1$/i)).toBeNull();

    fireEvent.input(screen.getByLabelText(/filter event family/i), {
      target: { value: 'TURN' },
    });

    const list = screen.getByLabelText(/latest event envelopes/i);
    expect(within(list).getByText(/turn.completed/i)).toBeInTheDocument();
    expect(within(list).queryByText(/item.delta/i)).toBeNull();
  });

  it('renders turn lifecycle timeline in order', () => {
    const turns: Turn[] = [
      {
        id: 'tu_1',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        items: [],
        status: 'running',
        humanGate: null,
        error: null,
        startedAt: '2026-04-15T09:00:00.000Z',
        completedAt: null,
        durationMs: null,
        configVersion: 2,
      },
      {
        id: 'tu_2',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        items: [],
        status: 'completed',
        humanGate: null,
        error: null,
        startedAt: '2026-04-15T09:01:00.000Z',
        completedAt: '2026-04-15T09:02:00.000Z',
        durationMs: 60_000,
        configVersion: 2,
      },
    ];

    render(() => <DiagnosticsPanel events={[]} meta={meta} turns={turns} />);

    const timeline = screen.getByLabelText(/turn lifecycle timeline/i);
    expect(
      within(timeline)
        .getAllByText(/tu_/i)
        .map((node) => node.textContent)
    ).toEqual(['tu_1', 'tu_2']);
  });

  it('shows failed turn error details in the lifecycle timeline', () => {
    const turns: Turn[] = [
      {
        id: 'tu_failed',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        items: [],
        status: 'failed',
        humanGate: null,
        error: {
          code: 'provider_rate_limited',
          message: 'Rate limit exceeded: 5 requests per minute.',
        },
        startedAt: '2026-04-15T09:00:00.000Z',
        completedAt: '2026-04-15T09:01:00.000Z',
        durationMs: 60_000,
        configVersion: 1,
      },
    ];

    render(() => <DiagnosticsPanel events={[]} meta={meta} turns={turns} />);

    expect(screen.getByText(/provider_rate_limited/i)).toBeInTheDocument();
    expect(screen.getByText(/rate limit exceeded/i)).toBeInTheDocument();
  });
});
