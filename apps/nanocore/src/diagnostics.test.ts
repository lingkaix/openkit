import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import type { AgentManifest, AuthoredAgentConfig } from './agents/manifest.js';
import type { BetterAuthServer } from './auth/middleware.js';
import { parseJsoncObject } from './config/jsonc.js';
import type { OpenKitConfig } from './config/openkit-config.js';
import { loadOpenKitConfig, openKitConfigPath } from './config/openkit-config.js';
import { InternalAgentRunner } from './internal-agents/runner.js';
import type { InternalAgentLLMClient } from './internal-agents/types.js';
import { resolveProviderProfileToLLMConfig } from './providers/llm-config.js';
import { ProviderRegistry } from './providers/registry.js';
import { ensureLayout } from './storage/fs-layout.js';
import { createApp } from './test-support/app.js';

/**
 * Creates a minimal Better Auth stub for diagnostics tests.
 *
 * @param session Session payload returned by getSession.
 * @returns Better Auth-compatible test double.
 */
function createAuthStub(
  session: Awaited<ReturnType<BetterAuthServer['api']['getSession']>>
): BetterAuthServer {
  return {
    api: {
      getSession: async () => session,
    },
    handler: async () => Response.json({ status: 'auth-ok' }),
  };
}

/**
 * Creates a registry containing one hosted direct provider.
 *
 * @returns Provider registry with the OpenAI test profile.
 */
function createProviderRegistry(): ProviderRegistry {
  return new ProviderRegistry([
    {
      baseUrl: 'https://api.openai.com/v1',
      defaultModel: 'gpt-5.1',
      displayName: 'OpenAI Default',
      id: 'openai-default',
      kind: 'direct',
      models: ['gpt-5.1'],
      secretRef: 'env:OPENKIT_TEST_PROVIDER_KEY',
    },
  ]);
}

/**
 * Builds the minimal OpenKit config override used by default-provider tests.
 *
 * @param providerId Optional configured Core default provider id.
 * @returns OpenKit config override.
 */
function createConfig(providerId?: string): OpenKitConfig {
  return providerId ? { defaults: { coreProviderId: providerId } } : {};
}

/**
 * Creates an authored agent config for setup diagnostics tests.
 *
 * @param overrides Partial config override.
 * @returns Authored agent config.
 */
function createAgentConfig(overrides: Partial<AuthoredAgentConfig> = {}): AuthoredAgentConfig {
  return {
    schemaVersion: 1,
    id: 'agent_codex_host',
    displayName: 'Codex Host Agent',
    runtime: {
      kind: 'codex',
      adapter: 'codex-app-server',
      version: '0.130.0',
    },
    mode: 'local',
    transport: { kind: 'stdio' },
    provider: {
      ref: 'agent-openrouter',
      model: 'openai/gpt-5.2',
    },
    deployment: {
      local: {
        command: 'codex',
        args: ['app-server', '--listen', 'stdio://'],
      },
    },
    extensions: {},
    ...overrides,
  };
}

/**
 * Creates an agent manifest aligned with the authored agent config.
 *
 * @returns Agent manifest.
 */
function createAgentManifest(): AgentManifest {
  return {
    adapter: 'codex-app-server',
    deployments: ['local'],
    displayName: 'Codex Host Agent',
    id: 'agent_codex_host',
    kind: 'custom',
    providerRef: 'agent-openrouter',
    runtime: 'codex',
    version: '0.0.2',
  };
}

/**
 * Creates an app backed by seeded provider templates without provider-registry injection.
 *
 * @param providerId Optional Core default provider id to write into server.jsonc.
 * @returns App configured from the temporary data root and loaded config.
 */
function createSeededDiagnosticsApp(providerId?: string): ReturnType<typeof createApp> {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-seeded-diagnostics-'));

  ensureLayout(dataRoot);
  rewriteOpenRouterBaseUrl(dataRoot, 'https://user:password@openrouter.ai/api/v1');

  if (providerId) {
    writeFileSync(
      openKitConfigPath(dataRoot),
      `${JSON.stringify({ defaults: { coreProviderId: providerId } }, null, 2)}\n`
    );
  }

  return createApp({
    dataRoot,
    openKitConfig: loadOpenKitConfig(dataRoot),
    agentManifests: [],
  });
}

/**
 * Rewrites the seeded OpenRouter profile base URL inside one temporary data root.
 *
 * @param dataRoot Temporary data root that already contains seeded provider templates.
 * @param baseUrl Replacement OpenRouter base URL.
 */
function rewriteOpenRouterBaseUrl(dataRoot: string, baseUrl: string): void {
  const profilePath = join(dataRoot, 'config', 'providers', 'openrouter-default.provider.jsonc');
  const parsed = parseJsoncObject(readFileSync(profilePath, 'utf8'), profilePath);

  writeFileSync(profilePath, `${JSON.stringify({ ...parsed, baseUrl }, null, 2)}\n`);
}

/**
 * Requests app diagnostics from a seeded data-root app.
 *
 * @param providerId Optional Core default provider id to write into server.jsonc.
 * @returns Parsed diagnostics response body.
 */
async function requestSeededDiagnostics(providerId?: string): Promise<Record<string, unknown>> {
  const app = createSeededDiagnosticsApp(providerId);
  const res = await app.request('/api/app/diagnostics');
  const body = (await res.json()) as Record<string, unknown>;

  expect(res.status).toBe(200);

  return body;
}

describe('Settings diagnostics app API', () => {
  it('exposes provider registry summaries without raw provider config', async () => {
    const providerRegistry = new ProviderRegistry([
      {
        baseUrl: 'https://user:password@example.com/v1',
        defaultModel: 'llama3.2',
        displayName: 'Ollama',
        id: 'ollama',
        kind: 'local',
        models: ['llama3.2'],
        secretRef: 'env:OLLAMA_API_KEY',
      },
    ]);
    const app = createApp({
      providerRegistry,
    });

    const res = await app.request('/api/app/diagnostics');
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      service: 'nanocore',
      boot: {
        acceptingProductWork: true,
        overall: 'ready',
        subsystems: {
          config: { state: 'ready' },
          storage: { state: 'ready' },
          policy: { state: 'ready' },
          vault: { state: 'ready' },
          scheduler: { state: 'ready' },
          llmGateway: { state: 'ready' },
          knowledgeIndex: { state: 'ready' },
        },
      },
      gateway: {
        status: 'ok',
        endpoints: ['/health', '/v1/models', '/v1/chat/completions', '/v1/responses'],
      },
      providers: {
        registry: [
          {
            baseUrl: 'https://example.com/v1',
            defaultModel: 'llama3.2',
            displayName: 'Ollama',
            id: 'ollama',
            kind: 'local',
            models: ['llama3.2'],
          },
        ],
        diagnostics: [],
      },
      defaults: {
        gateway: { providerId: null, model: null },
      },
      oauth: {
        openaiCodexAccounts: {
          accounts: [expect.objectContaining({ accountSlotId: 'default', status: 'logged_out' })],
          defaultAccountSlotId: 'default',
        },
      },
    });
    expect(body.providers.registry).not.toEqual([
      {
        providerId: 'ollama',
        status: 'healthy',
      },
    ]);
    expect(JSON.stringify(body)).not.toContain('OLLAMA_API_KEY');
    expect(JSON.stringify(body)).not.toContain('user:password');
  });

  it('keeps provider diagnostics redacted for URL credentials and secret refs', async () => {
    const previousKey = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = 'sk-openrouter-secret';

    try {
      const providerRegistry = new ProviderRegistry([
        {
          baseUrl: 'https://user:password@openrouter.ai/api/v1',
          displayName: 'OpenRouter',
          id: 'openrouter',
          kind: 'gateway',
          models: ['openai/gpt-5.1'],
          secretRef: 'env:OPENROUTER_API_KEY',
        },
      ]);
      const app = createApp({
        providerRegistry,
      });

      const res = await app.request('/api/app/diagnostics');
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.providers.registry).toEqual([
        {
          baseUrl: 'https://openrouter.ai/api/v1',
          displayName: 'OpenRouter',
          gatewayCapabilities: { chatCompletions: 'native', responses: 'bridged' },
          id: 'openrouter',
          kind: 'gateway',
          models: ['openai/gpt-5.1'],
        },
      ]);
      expect(JSON.stringify(body)).not.toContain('OPENROUTER_API_KEY');
      expect(JSON.stringify(body)).not.toContain('sk-openrouter-secret');
      expect(JSON.stringify(body)).not.toContain('user:password');
    } finally {
      if (previousKey === undefined) {
        delete process.env.OPENROUTER_API_KEY;
      } else {
        process.env.OPENROUTER_API_KEY = previousKey;
      }
    }
  });

  it('resolves default-provider diagnostics from seeded provider templates', async () => {
    const previousKey = process.env.OPENROUTER_API_KEY;

    try {
      delete process.env.OPENROUTER_API_KEY;

      const unset = await requestSeededDiagnostics();
      expect((unset.defaultProviders as { core: unknown }).core).toEqual({
        configured: false,
        origin: 'unset',
        reason: 'unset',
      });

      const unknown = await requestSeededDiagnostics('no-such-id');
      expect((unknown.defaultProviders as { core: unknown }).core).toEqual({
        configured: false,
        model: null,
        origin: 'canonical',
        providerId: 'no-such-id',
        reason: 'unknown-id',
      });

      const missingCredentials = await requestSeededDiagnostics('openrouter');
      expect((missingCredentials.defaultProviders as { core: unknown }).core).toEqual({
        configured: false,
        model: null,
        origin: 'canonical',
        providerId: 'openrouter',
        reason: 'credentials-missing',
      });

      process.env.OPENROUTER_API_KEY = 'sk-openrouter-secret';

      const stillMissingCredentials = await requestSeededDiagnostics('openrouter');
      expect((stillMissingCredentials.defaultProviders as { core: unknown }).core).toEqual({
        configured: false,
        model: null,
        origin: 'canonical',
        providerId: 'openrouter',
        reason: 'credentials-missing',
      });
      expect((stillMissingCredentials.providers as { registry: unknown[] }).registry).toHaveLength(
        5
      );
      expect(stillMissingCredentials.providers).toEqual({
        diagnostics: [],
        registry: expect.arrayContaining([
          expect.objectContaining({
            baseUrl: 'https://api.openai.com/v1',
            id: 'openai',
          }),
          expect.objectContaining({
            baseUrl: 'https://openrouter.ai/api/v1',
            id: 'openrouter',
          }),
          expect.objectContaining({
            baseUrl: 'https://api.x.ai/v1',
            id: 'xai',
          }),
          expect.objectContaining({
            baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
            id: 'google',
          }),
          expect.objectContaining({
            baseUrl: 'https://example.invalid/v1',
            id: 'openai-compatible-custom',
          }),
        ]),
      });
      expect(JSON.stringify(stillMissingCredentials)).not.toContain('OPENROUTER_API_KEY');
      expect(JSON.stringify(stillMissingCredentials)).not.toContain('sk-openrouter-secret');
      expect(JSON.stringify(stillMissingCredentials)).not.toContain('user:password');
    } finally {
      if (previousKey === undefined) {
        delete process.env.OPENROUTER_API_KEY;
      } else {
        process.env.OPENROUTER_API_KEY = previousKey;
      }
    }
  });

  it('reports role-scoped default providers on the app diagnostics route', async () => {
    const app = createApp({
      openKitConfig: createConfig(),
      providerRegistry: createProviderRegistry(),
    });

    const res = await app.request('/api/app/diagnostics');
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      service: 'nanocore',
      gateway: {
        status: 'ok',
        endpoints: ['/health', '/v1/models', '/v1/chat/completions', '/v1/responses'],
      },
      providers: {
        diagnostics: [],
        registry: expect.any(Array),
      },
      defaults: {
        gateway: { providerId: null, model: null },
      },
      oauth: {
        openaiCodexAccounts: {
          accounts: [expect.objectContaining({ accountSlotId: 'default', status: 'logged_out' })],
          defaultAccountSlotId: 'default',
        },
      },
      capabilities: expect.any(Array),
      defaultProviders: {
        core: {
          configured: false,
          reason: 'unset',
        },
        gateway: {
          configured: false,
          reason: 'unset',
        },
      },
    });
    expect(body).not.toHaveProperty('defaultProvider');
  });

  it('preserves provider diagnostic fields through shared App API schema parsing', async () => {
    const app = createApp({
      providerDiagnostics: {
        redactedSnapshot: [],
        summaries: [
          {
            code: 'invalid-provider-profile',
            message: 'Provider profile could not be parsed.',
            profileId: 'provider_demo',
            source: 'config/providers/provider-demo.provider.jsonc',
            status: 'blocked',
          },
        ],
      },
    });

    const res = await app.request('/api/app/diagnostics');
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.providers.diagnostics).toEqual([
      {
        code: 'invalid-provider-profile',
        message: 'Provider profile could not be parsed.',
        profileId: 'provider_demo',
        source: 'config/providers/provider-demo.provider.jsonc',
        status: 'blocked',
      },
    ]);
    expect(body.providers.diagnostics[0]).not.toHaveProperty('providerId');
    expect(body.providers.diagnostics[0]).not.toHaveProperty('checkedAt');
  });

  it('reports an unknown configured default provider on the existing app diagnostics route', async () => {
    const app = createApp({
      openKitConfig: createConfig('no-such-provider'),
      providerRegistry: createProviderRegistry(),
    });

    const res = await app.request('/api/app/diagnostics');
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.defaultProviders.core).toEqual({
      configured: false,
      model: null,
      origin: 'canonical',
      providerId: 'no-such-provider',
      reason: 'unknown-id',
    });
  });

  it('reports missing credentials for an existing default provider', async () => {
    const app = createApp({
      openKitConfig: createConfig('openai-default'),
      providerCredentialResolver: () => null,
      providerRegistry: createProviderRegistry(),
    });

    const res = await app.request('/api/app/diagnostics');
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.defaultProviders.core).toEqual({
      configured: false,
      model: null,
      origin: 'canonical',
      providerId: 'openai-default',
      reason: 'credentials-missing',
    });
  });

  it('reports a usable configured default provider without a reason', async () => {
    const app = createApp({
      openKitConfig: createConfig('openai-default'),
      providerCredentialResolver: () => 'sk-test',
      providerRegistry: createProviderRegistry(),
    });

    const res = await app.request('/api/app/diagnostics');
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.defaultProviders.core).toEqual({
      configured: true,
      model: null,
      origin: 'canonical',
      providerId: 'openai-default',
    });
    expect(body.defaultProviders.core).not.toHaveProperty('reason');
  });

  it('reports resolved core and gateway defaults with origins', async () => {
    const app = createApp({
      openKitConfig: {
        defaults: {
          coreProviderId: 'openai-default',
          coreModel: 'gpt-5.1',
          gatewayProviderId: 'openai-default',
          gatewayModel: 'gpt-5.1',
        },
      },
      providerCredentialResolver: () => 'sk-test',
      providerRegistry: createProviderRegistry(),
    });

    const res = await app.request('/api/app/diagnostics');
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.defaultProviders).toEqual({
      core: {
        configured: true,
        model: 'gpt-5.1',
        origin: 'canonical',
        providerId: 'openai-default',
      },
      gateway: {
        configured: true,
        model: 'gpt-5.1',
        origin: 'canonical',
        providerId: 'openai-default',
      },
    });
  });

  it('exposes internal agent diagnostics without leaking prompts or provider secrets', async () => {
    const openKitConfig: OpenKitConfig = {
      defaults: {
        coreModel: 'gpt-5.1',
        coreProviderId: 'openai',
        gatewayModel: 'gpt-5.1',
        gatewayProviderId: 'openai',
      },
    };
    const providerCredentialResolver = () => 'sk-internal-provider';
    const providerRegistry = new ProviderRegistry([
      {
        baseUrl: 'https://api.openai.com/v1',
        defaultModel: 'gpt-5.1',
        displayName: 'OpenAI',
        id: 'openai',
        kind: 'direct',
        models: ['gpt-5.1'],
        secretRef: 'env:OPENAI_API_KEY',
      },
    ]);
    const llmClient: InternalAgentLLMClient = {
      createChatCompletion: async () => {
        throw new Error(
          'upstream Authorization: Bearer tok_live_123 account_id=acct_secret secret=sk-quick-secret'
        );
      },
    };
    const internalAgentRunner = new InternalAgentRunner({
      defaultSelectionResolver: (defaultUse) => ({
        providerId:
          defaultUse === 'quickChat'
            ? (openKitConfig.defaults?.gatewayProviderId ?? null)
            : (openKitConfig.defaults?.coreProviderId ?? null),
        model:
          defaultUse === 'quickChat'
            ? (openKitConfig.defaults?.gatewayModel ?? null)
            : (openKitConfig.defaults?.coreModel ?? null),
      }),
      llmClient,
      providerResolver: (providerId) =>
        resolveProviderProfileToLLMConfig(
          providerRegistry.get(providerId)!,
          providerCredentialResolver
        ),
    });
    const app = createApp({
      internalAgentRunner,
      openKitConfig,
      providerCredentialResolver,
      providerRegistry,
    });

    await app.request('/api/app/quick-chat', {
      body: JSON.stringify({
        input: 'Summarize private roadmap token tok_live_123.',
        model: 'gpt-5.1',
        providerId: 'openai',
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });

    const res = await app.request('/api/app/diagnostics');
    const body = await res.json();
    const serialized = JSON.stringify(body);

    expect(res.status).toBe(200);
    expect(body.internalAgents).toMatchObject({
      agents: expect.arrayContaining([
        expect.objectContaining({
          defaultProviderUse: 'quickChat',
          displayName: 'QuickChatAgent',
          provider: {
            configured: true,
            model: 'gpt-5.1',
            providerId: 'openai',
          },
          supportedModes: ['chat'],
        }),
        expect.objectContaining({
          defaultProviderUse: 'internalTasks',
          displayName: 'WorkerCoordinatorAgent',
          provider: {
            configured: true,
            model: 'gpt-5.1',
            providerId: 'openai',
          },
        }),
      ]),
      recentFailures: [
        expect.objectContaining({
          agentId: 'quick-chat',
          code: 'internal_agent_failed',
          message: expect.stringContaining('[redacted]'),
        }),
      ],
    });
    expect(serialized).not.toContain('Summarize private roadmap');
    expect(serialized).not.toContain('OPENAI_API_KEY');
    expect(serialized).not.toContain('tok_live_123');
    expect(serialized).not.toContain('acct_secret');
    expect(serialized).not.toContain('sk-quick-secret');
  });

  it('exposes the aggregate diagnostics snapshot in local mode', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-diagnostics-'));
    const app = createApp({
      dataRoot,
      providerRegistry: new ProviderRegistry([]),
      agentManifests: [],
    });

    const res = await app.request('/api/diagnostics');
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      auth: { mode: 'local' },
      dataRoot: 'configured',
      migrations: { applied: [] },
      mode: 'local',
      providers: [],
      agents: [],
    });
    expect(JSON.stringify(body)).not.toContain(dataRoot);
  });

  it('rejects signed-in sessions from deployment diagnostics without leaking session tokens', async () => {
    const app = createApp({
      auth: createAuthStub({
        session: { id: 'session_secret_value' },
        user: { id: 'user_1' },
      }),
      mode: 'server',
      providerRegistry: new ProviderRegistry([]),
      agentManifests: [],
    });

    const res = await app.request('/api/diagnostics');
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body).toMatchObject({ code: 'diagnostics_admin_forbidden' });
    expect(JSON.stringify(body)).not.toContain('session_secret_value');
  });

  it('exposes redacted setup diagnostics for server config, providers, and agent setup', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-setup-diagnostics-'));
    const rawSecrets = ['sk-openkit-secret', 'ghp_openkit_secret'];
    const providerRegistry = new ProviderRegistry([
      {
        baseUrl: `https://user:${rawSecrets[0]}@openrouter.ai/api/v1`,
        defaultModel: 'openai/gpt-5.2',
        displayName: 'Agent OpenRouter',
        id: 'agent-openrouter',
        kind: 'direct',
        models: ['openai/gpt-5.2'],
        secretRef: 'env:OPENROUTER_API_KEY',
        vendor: 'openrouter',
      },
    ]);
    const app = createApp({
      dataRoot,
      openKitConfig: {
        defaults: {
          coreProviderId: 'agent-openrouter',
          gatewayProviderId: 'agent-openrouter',
        },
        gateway: {
          openaiCompatible: {
            enabled: true,
          },
        },
      },
      providerRegistry,
      providerCredentialResolver: (secretRef) =>
        secretRef === 'env:OPENROUTER_API_KEY' ? rawSecrets[1] : null,
      agentConfigs: [createAgentConfig()],
      agentManifests: [createAgentManifest()],
    });

    const res = await app.request('/api/setup/diagnostics');
    const body = await res.json();
    const serialized = JSON.stringify(body);

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      service: 'nanocore',
      server: {
        mode: 'local',
        dataRoot: 'configured',
        config: {
          defaults: {
            coreProviderId: 'agent-openrouter',
            gatewayProviderId: 'agent-openrouter',
          },
          gateway: {
            openaiCompatible: {
              enabled: true,
            },
          },
        },
      },
      providers: [
        {
          id: 'agent-openrouter',
          vendor: 'openrouter',
          role: 'core+gateway',
          secret: {
            configured: true,
            marker: 'secret-ref',
            ref: 'env:OPENROUTER_API_KEY',
          },
        },
      ],
      agents: [
        {
          id: 'agent_codex_host',
          readiness: { status: 'ready' },
          setup: {
            status: 'ready',
            deploymentMode: 'local',
            providerId: 'agent-openrouter',
          },
        },
      ],
    });
    expect(serialized).not.toContain(rawSecrets[0]);
    expect(serialized).not.toContain(rawSecrets[1]);
    expect(serialized).not.toContain(rawSecrets[2]);
    expect(serialized).not.toMatch(/sk-[A-Za-z0-9_-]+/);
    expect(serialized).not.toMatch(/hf_[A-Za-z0-9_-]+/);
    expect(serialized).not.toMatch(/ghp_[A-Za-z0-9_-]+/);
    expect(serialized).not.toContain(dataRoot);
  });

  it('projects setup resolver blockers into agent readiness reasons', async () => {
    const app = createApp({
      providerRegistry: new ProviderRegistry([
        {
          baseUrl: 'https://openrouter.ai/api/v1',
          defaultModel: 'openai/gpt-5.2',
          displayName: 'Agent OpenRouter',
          id: 'agent-openrouter',
          kind: 'direct',
          models: ['openai/gpt-5.2'],
          secretRef: 'env:OPENROUTER_API_KEY',
          vendor: 'openrouter',
        },
      ]),
      providerCredentialResolver: (secretRef) =>
        secretRef === 'env:OPENROUTER_API_KEY' ? 'configured-test-credential' : null,
      agentConfigs: [createAgentConfig({ requiredFeatures: ['workspace.mount.fuse'] })],
      agentManifests: [createAgentManifest()],
    });

    const res = await app.request('/api/setup/diagnostics');
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.agents[0]).toMatchObject({
      readiness: {
        status: 'blocked',
        reasons: ['Agent agent_codex_host requires unsupported feature: workspace.mount.fuse.'],
      },
      setup: {
        status: 'blocked',
        diagnostics: [
          expect.objectContaining({
            code: 'agent_setup.unsupported_required_feature',
          }),
        ],
      },
    });
  });
});
