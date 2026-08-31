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
    expect(config.defaults?.defaultAgentId).toBeUndefined();
  });

  it('treats a config without defaults as having no default Agent', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-config-'));
    mkdirSync(join(dataRoot, 'config'), { recursive: true });
    writeFileSync(join(dataRoot, 'config', 'server.jsonc'), '{ "mode": "local" }');

    const config = loadOpenKitConfig(dataRoot);

    expect(config).toEqual({ mode: 'local' });
    expect(config.defaults?.defaultAgentId).toBeUndefined();
  });

  it('loads defaults.defaultAgentId when it is a valid string', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-config-'));
    mkdirSync(join(dataRoot, 'config'), { recursive: true });
    writeFileSync(
      join(dataRoot, 'config', 'server.jsonc'),
      JSON.stringify({
        defaults: {
          defaultAgentId: 'agent_codex',
        },
      })
    );

    const config = loadOpenKitConfig(dataRoot);

    if (!config.defaults?.defaultAgentId) {
      throw new Error('expected defaultAgentId to be loaded');
    }

    const agentId: string = config.defaults.defaultAgentId;
    expect(agentId).toBe('agent_codex');
  });

  it('rejects non-string defaults.defaultAgentId values with a boot error', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-config-'));
    mkdirSync(join(dataRoot, 'config'), { recursive: true });
    writeFileSync(
      join(dataRoot, 'config', 'server.jsonc'),
      JSON.stringify({
        defaults: {
          defaultAgentId: 123,
        },
      })
    );

    try {
      loadOpenKitConfig(dataRoot);
      throw new Error('expected defaultAgentId validation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(BootConfigError);
      expect((error as Error).message).toMatch(/defaults\.defaultAgentId/);
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
          "defaultAgentId": "agent_codex",
        },
      }`
    );

    expect(loadOpenKitConfig(dataRoot)).toEqual({
      mode: 'server',
      defaults: {
        defaultAgentId: 'agent_codex',
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
          "cors": {
            "origins": ["https://console.openkit.example.com"]
          }
        },
        "auth": {
          "signup": {
            "enabled": false
          }
        },
        "defaults": {
          "defaultAgentId": "agent_codex"
        }
      }`
    );

    const { config, diagnostics, source } = loadOpenKitConfigWithDiagnostics(dataRoot);

    expect(source).toBe('config');
    expect(diagnostics).toEqual([]);
    expect(config).toMatchObject({
      schemaVersion: 1,
      mode: 'server',
      defaults: {
        defaultAgentId: 'agent_codex',
      },
    });
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
      JSON.stringify({ defaults: { defaultAgentId: 'removed-agent' } })
    );

    const result = loadOpenKitConfigWithDiagnostics(dataRoot);

    expect(result).toEqual({ config: {}, diagnostics: [], source: 'absent' });
  });

  it('ignores removed OpenKit-specific config filenames when server.jsonc exists', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-config-'));
    mkdirSync(join(dataRoot, 'config'), { recursive: true });
    writeFileSync(
      join(dataRoot, 'config', 'openkit.server.jsonc'),
      JSON.stringify({ defaults: { defaultAgentId: 'legacy-agent' } })
    );
    writeFileSync(
      join(dataRoot, 'config', `openkit.${'config'}.jsonc`),
      JSON.stringify({ defaults: { defaultAgentId: 'removed-agent' } })
    );
    writeFileSync(
      join(dataRoot, 'config', 'server.jsonc'),
      JSON.stringify({ defaults: { defaultAgentId: 'current-agent' } })
    );

    const result = loadOpenKitConfigWithDiagnostics(dataRoot);

    expect(result.source).toBe('config');
    expect(result.config.defaults?.defaultAgentId).toBe('current-agent');
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

    expect(() => loadOpenKitConfig(dataRoot)).toThrow();
  });

  it.each([
    ['extraBody', { service_tier: 'auto' }],
    ['extraHeaders', { 'x-provider-feature': 'enabled' }],
  ] as const)('rejects unowned provider field %s', (field, value) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-config-'));
    mkdirSync(join(dataRoot, 'config'), { recursive: true });
    writeFileSync(
      join(dataRoot, 'config', 'server.jsonc'),
      JSON.stringify({
        providers: [
          {
            displayName: 'OpenRouter',
            id: 'openrouter',
            kind: 'gateway',
            models: ['openai/gpt-5.1'],
            vendor: 'openrouter',
            [field]: value,
          },
        ],
      })
    );

    expect(() => loadOpenKitConfig(dataRoot)).toThrow(BootConfigError);
  });

  it('rejects removed internal OpenAI-compatible facade settings', () => {
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

    expect(() => loadOpenKitConfig(dataRoot)).toThrow();
  });

  it('rejects invalid config values with a boot error', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-config-'));
    mkdirSync(join(dataRoot, 'config'), { recursive: true });
    writeFileSync(join(dataRoot, 'config', 'server.jsonc'), '{ "mode": "desktop" }');

    expect(() => loadOpenKitConfig(dataRoot)).toThrow(/Invalid OpenKit config/);
  });
});
