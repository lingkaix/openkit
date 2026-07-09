import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { BootConfigError } from './mode.js';
import {
  loadOpenKitConfig,
  loadOpenKitConfigWithDiagnostics,
  openKitConfigPath,
} from './openkit-config.js';

describe('loadOpenKitConfig', () => {
  it('keeps openKitConfigPath pointed at server.jsonc', () => {
    expect(openKitConfigPath('/tmp/openkit')).toBe('/tmp/openkit/config/server.jsonc');
  });

  it('returns defaults when server.jsonc is absent', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-config-'));
    const config = loadOpenKitConfig(dataRoot);

    expect(config).toEqual({});
    expect(config.defaults?.coreProviderId).toBeUndefined();
  });

  it('treats a config without defaults as having no default provider', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-config-'));
    mkdirSync(join(dataRoot, 'config'), { recursive: true });
    writeFileSync(join(dataRoot, 'config', 'server.jsonc'), '{ "mode": "local" }');

    const config = loadOpenKitConfig(dataRoot);

    expect(config).toEqual({ mode: 'local' });
    expect(config.defaults?.coreProviderId).toBeUndefined();
  });

  it('treats defaults without coreProviderId as having no Core default provider', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-config-'));
    mkdirSync(join(dataRoot, 'config'), { recursive: true });
    writeFileSync(
      join(dataRoot, 'config', 'server.jsonc'),
      JSON.stringify({
        defaults: {
          gatewayProviderId: 'gateway-openrouter',
        },
      })
    );

    const config = loadOpenKitConfig(dataRoot);

    expect(config.defaults).toEqual({ gatewayProviderId: 'gateway-openrouter' });
    expect(config.defaults?.coreProviderId).toBeUndefined();
  });

  it('loads defaults.coreProviderId when it is a valid string', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-config-'));
    mkdirSync(join(dataRoot, 'config'), { recursive: true });
    writeFileSync(
      join(dataRoot, 'config', 'server.jsonc'),
      JSON.stringify({
        defaults: {
          coreProviderId: 'openai',
        },
      })
    );

    const config = loadOpenKitConfig(dataRoot);

    if (!config.defaults?.coreProviderId) {
      throw new Error('expected coreProviderId to be loaded');
    }

    const providerId: string = config.defaults.coreProviderId;
    expect(providerId).toBe('openai');
  });

  it('rejects non-string defaults.coreProviderId values with a boot error', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-config-'));
    mkdirSync(join(dataRoot, 'config'), { recursive: true });
    writeFileSync(
      join(dataRoot, 'config', 'server.jsonc'),
      JSON.stringify({
        defaults: {
          coreProviderId: 123,
        },
      })
    );

    try {
      loadOpenKitConfig(dataRoot);
      throw new Error('expected coreProviderId validation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(BootConfigError);
      expect((error as Error).message).toMatch(/defaults\.coreProviderId/);
      expect((error as Error).message).toMatch(/string/);
    }
  });

  it('loads and validates server.jsonc from data/config', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-config-'));
    mkdirSync(join(dataRoot, 'config'), { recursive: true });
    writeFileSync(
      join(dataRoot, 'config', 'server.jsonc'),
      `{
        // Explicit mode from file-backed config.
        "mode": "server",
        "defaults": {
          "workspaceId": "ws_demo",
          "agentId": "agent_codex_host",
          "coreModel": "model_codex",
        },
      }`
    );

    expect(loadOpenKitConfig(dataRoot)).toEqual({
      mode: 'server',
      defaults: {
        workspaceId: 'ws_demo',
        agentId: 'agent_codex_host',
        coreModel: 'model_codex',
      },
    });
  });

  it('loads the canonical server.jsonc shape from data/config', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-config-'));
    mkdirSync(join(dataRoot, 'config'), { recursive: true });
    writeFileSync(
      join(dataRoot, 'config', 'server.jsonc'),
      `{
        "schemaVersion": 1,
        "mode": "server",
        "server": {
          "publicBaseUrl": "https://openkit.example.com",
          "bind": {
            "host": "127.0.0.1",
            "port": 3000
          },
          "trustedProxies": [],
          "cors": {
            "origins": []
          }
        },
        "auth": {
          "enabled": true,
          "provider": "better-auth",
          "localModeUserId": "user_local",
          "signup": {
            "enabled": false
          }
        },
        "data": {
          "root": "/data/openkit",
          "layoutVersion": 1
        },
        "providers": [
          {
            "id": "core-openrouter",
            "vendor": "openrouter",
            "kind": "gateway",
            "displayName": "OpenRouter for Core",
            "baseUrl": "https://openrouter.ai/api/v1",
            "models": ["openai/gpt-5.1"],
            "defaultModel": "openai/gpt-5.1",
            "secretRef": "env:CORE_OPENROUTER_API_KEY",
            "extraHeaders": {},
            "extraBody": {},
            "metadata": {
              "modelsDevProviderId": "openrouter"
            }
          },
          {
            "id": "agent-openrouter",
            "vendor": "openrouter",
            "kind": "gateway",
            "displayName": "OpenRouter for Agents",
            "baseUrl": "https://openrouter.ai/api/v1",
            "models": ["openai/gpt-5.1"],
            "defaultModel": "openai/gpt-5.1",
            "secretRef": "env:AGENT_OPENROUTER_API_KEY",
            "metadata": {
              "modelsDevProviderId": "openrouter"
            }
          }
        ],
        "defaults": {
          "coreProviderId": "core-openrouter",
          "coreModel": "openai/gpt-5.1",
          "gatewayProviderId": "agent-openrouter",
          "gatewayModel": "openai/gpt-5.1",
          "agentId": "agent_codex_host"
        },
        "gateway": {
          "openaiCompatible": {
            "enabled": true,
            "route": "/v1",
            "defaultProviderId": "agent-openrouter",
            "defaultModel": "openai/gpt-5.1",
            "allowedProviderIds": ["agent-openrouter"],
            "auth": "agent-session"
          }
        },
        "features": {
          "internalOpenAICompatFacade": {
            "enabled": false
          }
        },
        "diagnostics": {
          "redactSecrets": true,
          "emitConfigOrigins": true
        },
        "extensions": {}
      }`
    );

    const { config, diagnostics, source } = loadOpenKitConfigWithDiagnostics(dataRoot);

    expect(source).toBe('config');
    expect(diagnostics).toEqual([]);
    expect(config).toMatchObject({
      schemaVersion: 1,
      mode: 'server',
      defaults: {
        coreProviderId: 'core-openrouter',
        gatewayProviderId: 'agent-openrouter',
      },
      providers: [
        expect.objectContaining({ id: 'core-openrouter', vendor: 'openrouter' }),
        expect.objectContaining({ id: 'agent-openrouter', vendor: 'openrouter' }),
      ],
    });
    expect(config.providers?.[0]).toMatchObject({ secretRef: 'env:CORE_OPENROUTER_API_KEY' });
    expect(config.providers?.[1]).toMatchObject({ secretRef: 'env:AGENT_OPENROUTER_API_KEY' });
  });

  it('ignores removed OpenKit-specific config filenames', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-config-'));
    mkdirSync(join(dataRoot, 'config'), { recursive: true });
    writeFileSync(
      join(dataRoot, 'config', 'openkit.server.jsonc'),
      JSON.stringify({ defaults: { providerId: 'openrouter' } })
    );
    writeFileSync(
      join(dataRoot, 'config', `openkit.${'config'}.jsonc`),
      JSON.stringify({ defaults: { coreProviderId: 'removed-openrouter' } })
    );

    const result = loadOpenKitConfigWithDiagnostics(dataRoot);

    expect(result).toEqual({ config: {}, diagnostics: [], source: 'absent' });
  });

  it('ignores removed OpenKit-specific config filenames when server.jsonc exists', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-config-'));
    mkdirSync(join(dataRoot, 'config'), { recursive: true });
    writeFileSync(
      join(dataRoot, 'config', 'openkit.server.jsonc'),
      JSON.stringify({ defaults: { coreProviderId: 'core-openrouter' } })
    );
    writeFileSync(
      join(dataRoot, 'config', `openkit.${'config'}.jsonc`),
      JSON.stringify({ defaults: { coreProviderId: 'removed-openrouter' } })
    );
    writeFileSync(
      join(dataRoot, 'config', 'server.jsonc'),
      JSON.stringify({ defaults: { coreProviderId: 'current-openrouter' } })
    );

    const result = loadOpenKitConfigWithDiagnostics(dataRoot);

    expect(result.source).toBe('config');
    expect(result.config.defaults?.coreProviderId).toBe('current-openrouter');
    expect(result.diagnostics).toEqual([]);
  });

  it('rejects raw API keys in provider config fields', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-config-'));
    mkdirSync(join(dataRoot, 'config'), { recursive: true });
    writeFileSync(
      join(dataRoot, 'config', 'server.jsonc'),
      JSON.stringify({
        providers: [
          {
            apiKey: 'sk-raw-secret',
            displayName: 'Raw OpenRouter',
            id: 'openrouter',
            kind: 'gateway',
            models: ['openai/gpt-5.1'],
            vendor: 'openrouter',
          },
        ],
      })
    );

    expect(() => loadOpenKitConfig(dataRoot)).toThrow(/apiKey is not supported/);
  });

  it('loads internal OpenAI-compatible facade settings', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-config-'));
    mkdirSync(join(dataRoot, 'config'), { recursive: true });
    writeFileSync(
      join(dataRoot, 'config', 'server.jsonc'),
      JSON.stringify({
        internal: {
          openaiCompatFacade: {
            defaultModel: 'gpt-5.1',
            defaultProviderId: 'openai',
            enabled: true,
          },
        },
      })
    );

    expect(loadOpenKitConfig(dataRoot)).toEqual({
      internal: {
        openaiCompatFacade: {
          defaultModel: 'gpt-5.1',
          defaultProviderId: 'openai',
          enabled: true,
        },
      },
    });
  });

  it('rejects invalid config values with a boot error', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-config-'));
    mkdirSync(join(dataRoot, 'config'), { recursive: true });
    writeFileSync(join(dataRoot, 'config', 'server.jsonc'), '{ "mode": "desktop" }');

    expect(() => loadOpenKitConfig(dataRoot)).toThrow(/Invalid OpenKit config/);
  });
});
