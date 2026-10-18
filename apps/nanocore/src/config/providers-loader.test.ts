import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AuthoredProviderProfileSchema, ProviderProfileSchema } from '@openkit/config-schema';
import { isEntityId, RETAINED_FORMAT_VERSION } from '@openkit/protocol';
import { describe, expect, it, vi } from 'vitest';

import {
  assertConfiguredModelsHaveKnownContext,
  resolveEffectiveModelMetadata,
  resolveLogicalModelCatalog,
} from '../llm/logical-models.js';
import { ProviderRegistry } from '../providers/registry.js';
import { ensureLayout } from '../storage/fs-layout.js';
import { parseJsoncObject } from './jsonc.js';
import { loadProviderProfiles } from './providers-loader.js';

const EXPECTED_V003_PROVIDER_TEMPLATES = [
  {
    baseUrl: 'https://api.anthropic.com',
    displayName: 'Anthropic',
    fileName: 'anthropic-worker-direct.provider.jsonc',
    id: 'anthropic',
    kind: 'direct',
  },
  {
    baseUrl: 'https://api.openai.com/v1',
    displayName: 'OpenAI',
    fileName: 'openai-default.provider.jsonc',
    id: 'openai',
    kind: 'direct',
  },
  {
    baseUrl: 'https://openrouter.ai/api/v1',
    displayName: 'OpenRouter',
    fileName: 'openrouter-default.provider.jsonc',
    id: 'openrouter',
    kind: 'gateway',
  },
  {
    baseUrl: 'https://api.x.ai/v1',
    displayName: 'xAI Grok',
    fileName: 'xai-grok-default.provider.jsonc',
    id: 'xai',
    kind: 'direct',
  },
  {
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    displayName: 'Google Gemini',
    fileName: 'google-gemini-default.provider.jsonc',
    id: 'google',
    kind: 'direct',
  },
] as const;

const EXPECTED_V003_EXAMPLE_PROVIDER_TEMPLATE = {
  baseUrl: 'https://example.invalid/v1',
  displayName: 'Custom OpenAI-Compatible',
  fileName: 'openai-compatible-custom.provider.jsonc.example',
  id: 'openai-compatible-custom',
  kind: 'custom',
} as const;

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
  it.each([
    { fileName: 'openai-flagship.provider.jsonc', prefix: '', id: 'openai', context: 1_050_000 },
    {
      fileName: 'openai-codex-subscription.provider.jsonc',
      prefix: 'openai-codex/',
      id: 'openai_codex',
      context: 256_000,
    },
  ])('seeds $fileName as an opt-in profile with exact flagship metadata and routes', ({
    fileName,
    prefix,
    id,
    context,
  }) => {
    const { dataRoot, providersRoot } = createProviderRoot();
    ensureLayout(dataRoot);
    const examplePath = join(providersRoot, `${fileName}.example`);
    expect(existsSync(examplePath)).toBe(true);
    expect(existsSync(join(providersRoot, fileName))).toBe(false);
    const parsed = AuthoredProviderProfileSchema.parse(
      parseJsoncObject(readFileSync(examplePath, 'utf8'), examplePath)
    );
    expect(parsed.id).toBe(id);
    const expected = [
      { id: 'gpt-6-astra', input: 10, output: 50 },
      { id: 'gpt-5.6-sol', input: 4, output: 20 },
      { id: 'gpt-5.6-terra', input: 2, output: 12 },
      { id: 'gpt-5.6-luna', input: 0.2, output: 1.2 },
    ];
    expect(parsed.models).toEqual(expected.map((model) => `${prefix}${model.id}`));
    const registry = new ProviderRegistry([ProviderProfileSchema.parse(parsed)]);
    expect(() => assertConfiguredModelsHaveKnownContext(registry)).not.toThrow();
    for (const model of expected) {
      const nativeId = `${prefix}${model.id}`;
      expect(resolveEffectiveModelMetadata(parsed, nativeId)).toMatchObject({
        limit: { context, output: 128_000 },
        reasoning: true,
        tool_call: true,
        modalities: { input: ['text', 'image'], output: ['text'] },
        cost: { input: model.input, output: model.output },
      });
    }
    expect(parsed.modelMetadata?.[`${prefix}gpt-6-astra`]?.cost?.cache_read).toBe(1);
    const route = {
      id: 'astra',
      providerProfileId: parsed.id,
      providerModel: `${prefix}gpt-6-astra`,
    };
    const config = {
      schemaVersion: 1 as const,
      enabled: true,
      defaultLogicalModelId: 'gpt-6-astra',
      logicalModels: [
        {
          id: 'gpt-6-astra',
          displayName: 'GPT-6 Astra',
          contextManagement: [{ type: 'compaction' as const, compactThreshold: context - 128_000 }],
          routes: [route],
        },
      ],
    };
    expect(resolveLogicalModelCatalog(config, registry)).toEqual([
      expect.objectContaining({
        id: 'gpt-6-astra',
        routes: [
          {
            ...route,
            available: true,
            unavailableReason: null,
          },
        ],
      }),
    ]);
    config.logicalModels[0]!.contextManagement[0]!.compactThreshold = context - 128_000 + 1;
    expect(() => resolveLogicalModelCatalog(config, registry)).toThrow(
      'Logical model context management exceeds a route limit'
    );
    writeFileSync(examplePath, '// Operator copy remains unchanged.');
    ensureLayout(dataRoot);
    expect(readFileSync(examplePath, 'utf8')).toBe('// Operator copy remains unchanged.');
  });

  it('loads the provider templates through AuthoredProviderProfileSchema', () => {
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
        })
      );
      expect(profile?.secretRef?.startsWith('vault://')).toBe(true);
      expect(isEntityId('vault', profile?.secretRef?.slice('vault://'.length))).toBe(true);
      expect(parsed.secretRef).toBe(profile?.secretRef);
    }

    expect(existsSync(join(providersRoot, EXPECTED_V003_EXAMPLE_PROVIDER_TEMPLATE.fileName))).toBe(
      true
    );
    expect(profilesById.has(EXPECTED_V003_EXAMPLE_PROVIDER_TEMPLATE.id)).toBe(false);

    const exampleParsed = parseJsoncObject(
      readFileSync(join(providersRoot, EXPECTED_V003_EXAMPLE_PROVIDER_TEMPLATE.fileName), 'utf8'),
      EXPECTED_V003_EXAMPLE_PROVIDER_TEMPLATE.fileName
    );

    expect(exampleParsed).toEqual(
      expect.objectContaining({
        baseUrl: EXPECTED_V003_EXAMPLE_PROVIDER_TEMPLATE.baseUrl,
        displayName: EXPECTED_V003_EXAMPLE_PROVIDER_TEMPLATE.displayName,
        id: EXPECTED_V003_EXAMPLE_PROVIDER_TEMPLATE.id,
        kind: EXPECTED_V003_EXAMPLE_PROVIDER_TEMPLATE.kind,
        models: ['custom-model'],
      })
    );
    expect(isEntityId('vault', String(exampleParsed.secretRef).slice('vault://'.length))).toBe(
      true
    );
    expect(String(exampleParsed.secretRef).startsWith('vault://')).toBe(true);
    const references = [
      ...result.profiles.map((profile) => profile.secretRef),
      exampleParsed.secretRef,
    ];
    expect(new Set(references).size).toBe(references.length);
    expect(loadProviderProfiles(dataRoot)).toEqual(result);
  });

  it('preserves published Provider candidates when a missing template cannot allocate', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-provider-template-entropy-'));
    try {
      ensureLayout(dataRoot);
      const providersRoot = join(dataRoot, 'config', 'providers');
      const missing = join(providersRoot, 'openai-default.provider.jsonc');
      rmSync(missing);
      const retained = readdirSync(providersRoot).map(
        (name) => [name, readFileSync(join(providersRoot, name), 'utf8')] as const
      );
      const entropy = vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(() => {
        throw new Error('Synthetic Provider template entropy failure.');
      });
      try {
        expect(() => ensureLayout(dataRoot)).toThrow(
          'Synthetic Provider template entropy failure.'
        );
      } finally {
        entropy.mockRestore();
      }
      expect(existsSync(missing)).toBe(false);
      for (const [name, bytes] of retained)
        expect(readFileSync(join(providersRoot, name), 'utf8')).toBe(bytes);
      ensureLayout(dataRoot);
      const profile = parseJsoncObject(readFileSync(missing, 'utf8'), 'provider');
      expect(String(profile.secretRef).startsWith('vault://')).toBe(true);
      expect(isEntityId('vault', String(profile.secretRef).slice('vault://'.length))).toBe(true);
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it('loads JSONC provider profiles from data/config/providers', () => {
    const { dataRoot, providersRoot } = createProviderRoot();
    writeFileSync(
      join(providersRoot, 'openai.provider.jsonc'),
      `{
        // Comments and trailing commas are accepted.
        "schemaVersion": 1,
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

  it.each([
    {
      accountSlotId: 'codex_primary',
      displayName: 'OpenAI Codex',
      id: 'openai_codex',
      models: ['openai-codex/gpt-5.6-sol'],
      vendor: 'openai_codex',
    },
    {
      accountSlotId: 'xai_primary',
      displayName: 'xAI',
      id: 'xai',
      models: ['grok-4'],
      vendor: 'xai',
    },
  ])('loads strict $vendor subscription-account profiles without blocking them', (profile) => {
    const { dataRoot, providersRoot } = createProviderRoot();
    writeFileSync(
      join(providersRoot, `${profile.id}.provider.jsonc`),
      JSON.stringify({
        schemaVersion: RETAINED_FORMAT_VERSION,
        displayName: profile.displayName,
        extensions: {
          openkit: {
            subscriptionAccount: { accountSlotId: profile.accountSlotId },
          },
        },
        id: profile.id,
        kind: 'oauth',
        models: profile.models,
        vendor: profile.vendor,
      })
    );

    const result = loadProviderProfiles(dataRoot);

    expect.soft(result.diagnostics).toEqual([]);
    expect(result.profiles).toEqual([
      {
        displayName: profile.displayName,
        extensions: {
          openkit: {
            subscriptionAccount: { accountSlotId: profile.accountSlotId },
          },
        },
        id: profile.id,
        kind: 'oauth',
        models: profile.models,
        vendor: profile.vendor,
      },
    ]);
  });

  it('rejects the removed codexOAuth extension without a compatibility alias', () => {
    const { dataRoot, providersRoot } = createProviderRoot();
    writeFileSync(
      join(providersRoot, 'legacy-openai-codex.provider.jsonc'),
      JSON.stringify({
        schemaVersion: RETAINED_FORMAT_VERSION,
        displayName: 'Legacy OpenAI Codex',
        extensions: {
          openkit: {
            codexOAuth: { accountSlotId: 'default' },
            subscriptionAccount: { accountSlotId: 'default' },
          },
        },
        id: 'legacy-openai-codex',
        kind: 'oauth',
        models: ['openai-codex/gpt-5.6-sol'],
        vendor: 'openai_codex',
      })
    );

    const result = loadProviderProfiles(dataRoot);

    expect(result.profiles).toEqual([]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'provider.invalid_profile',
        profileId: 'legacy-openai-codex',
        severity: 'error',
      }),
    ]);
  });

  it('rejects raw API keys and obvious raw-secret variants', () => {
    const { dataRoot, providersRoot } = createProviderRoot();
    writeFileSync(
      join(providersRoot, 'unsafe.provider.jsonc'),
      JSON.stringify({
        schemaVersion: RETAINED_FORMAT_VERSION,
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
        schemaVersion: RETAINED_FORMAT_VERSION,
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
        schemaVersion: RETAINED_FORMAT_VERSION,
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
