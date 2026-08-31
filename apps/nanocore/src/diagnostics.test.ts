import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import type { AgentManifest } from './agents/manifest.js';
import type { BetterAuthServer } from './auth/middleware.js';
import { ProviderRegistry } from './providers/registry.js';
import { createTestAgentSetup } from './test-support/agent-environment.js';
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
 * Creates an agent manifest aligned with the authored agent config.
 *
 * @param overrides Manifest fields to override.
 * @returns Agent manifest.
 */
function createAgentManifest(overrides: Partial<AgentManifest> = {}): AgentManifest {
  return {
    ...createTestAgentSetup().manifest,
    ...overrides,
  };
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
    });
    expect(body).not.toHaveProperty('oauth');
    for (const provider of body.providers.registry) {
      expect(provider).not.toHaveProperty('dispatchFamily');
    }
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
      expect(body).not.toHaveProperty('oauth');
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

  it('keeps generic internal-agent runtime state out of App Diagnostics', async () => {
    const app = createApp();
    const res = await app.request('/api/app/diagnostics');
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).not.toHaveProperty('internalAgents');
    expect(body).not.toHaveProperty('internalTasks');
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
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-diagnostics-'));
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
      openKitConfig: {},
      providerRegistry,
      providerCredentialResolver: (secretRef) =>
        secretRef === 'env:OPENROUTER_API_KEY' ? rawSecrets[1] : null,
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
          defaultAgentId: null,
          schemaVersion: null,
        },
      },
      providers: [
        {
          id: 'agent-openrouter',
          vendor: 'openrouter',
          role: 'available',
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
            deploymentMode: null,
            logicalModelId: 'openai/gpt-5.2',
          },
        },
      ],
    });
    expect(serialized).not.toContain(rawSecrets[0]);
    expect(serialized).not.toContain(rawSecrets[1]);
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
      agentManifests: [createAgentManifest({ requiredFeatures: ['workspace.mount.fuse'] })],
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
