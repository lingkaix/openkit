import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ensureLayout } from '../storage/fs-layout.js';
import { parseJsoncObject } from './jsonc.js';
import { loadProviderProfiles } from './providers-loader.js';

const EXPECTED_V003_PROVIDER_TEMPLATES = [
  {
    baseUrl: 'https://api.openai.com/v1',
    displayName: 'OpenAI',
    fileName: 'openai-default.provider.jsonc',
    id: 'openai',
    kind: 'direct',
    secretRef: 'vault://provider_openai',
  },
  {
    baseUrl: 'https://openrouter.ai/api/v1',
    displayName: 'OpenRouter',
    fileName: 'openrouter-default.provider.jsonc',
    id: 'openrouter',
    kind: 'gateway',
    secretRef: 'vault://provider_openrouter',
  },
  {
    baseUrl: 'https://api.x.ai/v1',
    displayName: 'xAI Grok',
    fileName: 'xai-grok-default.provider.jsonc',
    id: 'xai',
    kind: 'direct',
    secretRef: 'vault://provider_xai',
  },
  {
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    displayName: 'Google Gemini',
    fileName: 'google-gemini-default.provider.jsonc',
    id: 'google',
    kind: 'direct',
    secretRef: 'vault://provider_google',
  },
  {
    baseUrl: 'https://example.invalid/v1',
    displayName: 'Custom OpenAI-Compatible',
    fileName: 'openai-compatible-custom.provider.jsonc',
    id: 'openai-compatible-custom',
    kind: 'custom',
    secretRef: 'vault://provider_openai_compatible_custom',
  },
] as const;

/**
 * Creates a temporary data root with a providers config directory.
 *
 * @returns Providers directory and data-root paths.
 */
function createProviderRoot(): { dataRoot: string; providersRoot: string } {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-providers-'));
  const providersRoot = join(dataRoot, 'config', 'providers');

  mkdirSync(providersRoot, { recursive: true });

  return { dataRoot, providersRoot };
}

describe('loadProviderProfiles', () => {
  it('loads the provider templates through ProviderProfileSchema', () => {
    const { dataRoot, providersRoot } = createProviderRoot();

    ensureLayout(dataRoot);

    const result = loadProviderProfiles(dataRoot);
    const profilesById = new Map(result.profiles.map((profile) => [profile.id, profile]));

    expect(result.diagnostics).toEqual([]);
    expect(
      readdirSync(providersRoot)
        .filter((fileName) => fileName.endsWith('.provider.jsonc'))
        .sort()
    ).toEqual(EXPECTED_V003_PROVIDER_TEMPLATES.map((template) => template.fileName).sort());
    expect([...profilesById.keys()].sort()).toEqual(
      EXPECTED_V003_PROVIDER_TEMPLATES.map((template) => template.id).sort()
    );

    for (const template of EXPECTED_V003_PROVIDER_TEMPLATES) {
      const profile = profilesById.get(template.id);
      const parsed = parseJsoncObject(
        readFileSync(join(providersRoot, template.fileName), 'utf8'),
        template.fileName
      );

      expect(profile).toEqual(
        expect.objectContaining({
          baseUrl: template.baseUrl,
          displayName: template.displayName,
          id: template.id,
          kind: template.kind,
          secretRef: template.secretRef,
        })
      );
      expect(parsed.secretRef).toBe(template.secretRef);
    }
  });

  it('loads JSONC provider profiles from data/config/providers', () => {
    const { dataRoot, providersRoot } = createProviderRoot();
    writeFileSync(
      join(providersRoot, 'openai.provider.jsonc'),
      `{
        // Comments and trailing commas are accepted.
        "id": "openai",
        "displayName": "OpenAI",
        "kind": "direct",
        "baseUrl": "https://api.openai.com/v1",
        "models": ["gpt-5.1"],
        "defaultModel": "gpt-5.1",
        "secretRef": "env:OPENAI_API_KEY",
      }`
    );

    const result = loadProviderProfiles(dataRoot);

    expect(result.diagnostics).toEqual([]);
    expect(result.profiles).toEqual([
      expect.objectContaining({
        baseUrl: 'https://api.openai.com/v1',
        defaultModel: 'gpt-5.1',
        displayName: 'OpenAI',
        id: 'openai',
        kind: 'direct',
        models: ['gpt-5.1'],
        secretRef: 'env:OPENAI_API_KEY',
      }),
    ]);
  });

  it('rejects raw API keys and obvious raw-secret variants', () => {
    const { dataRoot, providersRoot } = createProviderRoot();
    writeFileSync(
      join(providersRoot, 'unsafe.provider.jsonc'),
      JSON.stringify({
        id: 'unsafe',
        displayName: 'Unsafe',
        kind: 'direct',
        models: ['model'],
        apiKey: 'sk-secret',
        nested: {
          clientSecret: 'raw-secret',
        },
      })
    );

    const result = loadProviderProfiles(dataRoot);

    expect(result.profiles).toEqual([]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'provider.invalid_profile',
        profileId: 'unsafe',
        severity: 'error',
      }),
    ]);
  });

  it('preserves unknown optional extension sections', () => {
    const { dataRoot, providersRoot } = createProviderRoot();
    writeFileSync(
      join(providersRoot, 'extended.provider.jsonc'),
      JSON.stringify({
        id: 'extended',
        displayName: 'Extended',
        kind: 'custom',
        models: ['model'],
        extensions: {
          vendorFeature: {
            enabled: true,
            mode: 'preview',
          },
        },
      })
    );

    const result = loadProviderProfiles(dataRoot);

    expect(result.diagnostics).toEqual([]);
    expect(result.profiles[0]?.extensions).toEqual({
      vendorFeature: {
        enabled: true,
        mode: 'preview',
      },
    });
  });

  it('blocks readiness for unknown required extension sections', () => {
    const { dataRoot, providersRoot } = createProviderRoot();
    writeFileSync(
      join(providersRoot, 'required-extension.provider.jsonc'),
      JSON.stringify({
        id: 'required-extension',
        displayName: 'Required Extension',
        kind: 'custom',
        models: ['model'],
        extensions: {
          vendorFeature: {
            required: true,
          },
        },
      })
    );

    const result = loadProviderProfiles(dataRoot);

    expect(result.profiles[0]?.readiness).toEqual({
      message: 'Unknown required extension section: vendorFeature',
      status: 'blocked',
    });
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'provider.unknown_required_extension',
        profileId: 'required-extension',
        severity: 'error',
      }),
    ]);
  });
});
