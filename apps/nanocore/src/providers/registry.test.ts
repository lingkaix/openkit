import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { parseJsoncObject } from '../config/jsonc.js';
import { loadProviderProfiles, type ProviderProfile } from '../config/providers-loader.js';
import { createRuntimeConfigManager } from '../config/runtime-config.js';
import { RuntimeConfigFileService } from '../config/runtime-config-files.js';
import { ensureLayout } from '../storage/fs-layout.js';
import { resolveProviderProfileToLLMConfig } from './llm-config.js';
import { ProviderRegistry } from './registry.js';

// The cast admits the future spelling to unchanged typed consumers so RED is behavioral.
const llmGatewayKind = 'llm-gateway' as ProviderProfile['kind'];

describe('ProviderRegistry', () => {
  it('lists and gets loaded provider profiles', () => {
    const registry = new ProviderRegistry([
      {
        baseUrl: 'https://api.openai.com/v1',
        displayName: 'OpenAI',
        id: 'openai',
        kind: 'direct',
        models: ['gpt-5.1'],
        secretRef: 'env:OPENAI_API_KEY',
      },
    ]);

    expect(registry.list()).toEqual([
      expect.objectContaining({
        displayName: 'OpenAI',
        id: 'openai',
      }),
    ]);
    expect(registry.get('openai')).toEqual(
      expect.objectContaining({
        displayName: 'OpenAI',
        id: 'openai',
      })
    );
    expect(registry.get('missing')).toBeNull();
  });

  it('summarizes providers without secret refs or URL auth components', () => {
    const registry = new ProviderRegistry([
      {
        baseUrl: 'https://user:password@example.com/v1',
        defaultModel: 'gpt-5.1',
        displayName: 'Redacted Provider',
        gatewayCapabilities: { chatCompletions: 'native', responses: 'bridged' },
        id: 'redacted',
        kind: 'direct',
        models: ['gpt-5.1'],
        readiness: { status: 'ready' },
        secretRef: 'env:SECRET_VALUE',
      },
      {
        displayName: 'Codex Subscription',
        extensions: {
          openkit: { subscriptionAccount: { accountSlotId: 'default' } },
        },
        id: 'codex-work',
        kind: 'oauth',
        models: ['openai-codex/gpt-5.6-sol'],
        vendor: 'openai-codex',
      },
    ]);

    const summary = registry.summarize();

    expect(summary[1]?.subscriptionAccount).toEqual({
      subscriptionProviderId: 'openai-codex',
      accountSlotId: 'default',
    });
    expect(summary[0]?.metadataKey).toBe('redacted');
    expect
      .soft(
        summary.map(({ metadataKey, modelDetails, subscriptionAccount, ...existing }) => existing)
      )
      .toEqual([
        {
          baseUrl: 'https://example.com/v1',
          defaultModel: 'gpt-5.1',
          displayName: 'Redacted Provider',
          gatewayCapabilities: { chatCompletions: 'native', responses: 'bridged' },
          id: 'redacted',
          kind: 'direct',
          models: ['gpt-5.1'],
          readiness: { status: 'ready' },
        },
        {
          displayName: 'Codex Subscription',
          gatewayCapabilities: { chatCompletions: 'bridged', responses: 'native' },
          id: 'codex-work',
          kind: 'oauth',
          models: ['openai-codex/gpt-5.6-sol'],
        },
      ]);
    for (const provider of summary) {
      expect(provider).not.toHaveProperty('dispatchFamily');
    }
    expect(JSON.stringify(summary)).not.toContain('SECRET_VALUE');
    expect(JSON.stringify(summary)).not.toContain('user:password');
  });

  it('checks whether a provider has resolvable required credentials', () => {
    const registry = new ProviderRegistry([
      {
        displayName: 'Hosted Missing',
        id: 'hosted-missing',
        kind: 'direct',
        models: ['gpt-5.1'],
        secretRef: 'env:MISSING_KEY',
      },
      {
        displayName: 'Hosted Ready',
        id: 'hosted-ready',
        kind: llmGatewayKind,
        models: ['model'],
        secretRef: 'env:READY_KEY',
      },
      {
        displayName: 'Hosted Without SecretRef',
        id: 'hosted-without-secret-ref',
        kind: 'direct',
        models: ['gpt-5.1'],
      },
      {
        displayName: 'Local',
        id: 'local',
        kind: 'local',
        models: ['llama3.2'],
      },
    ]);

    const resolveSecret = (secretRef: string): string | null =>
      secretRef === 'env:READY_KEY' ? 'sk-ready' : null;

    expect(registry.hasResolvableCredentials('hosted-missing', resolveSecret)).toBe(false);
    expect(registry.hasResolvableCredentials('hosted-ready', resolveSecret)).toBe(true);
    expect(registry.hasResolvableCredentials('hosted-without-secret-ref', resolveSecret)).toBe(
      false
    );
    expect(registry.hasResolvableCredentials('local', resolveSecret)).toBe(true);
    expect(registry.hasResolvableCredentials('unknown', resolveSecret)).toBeNull();
  });

  it('does not resolve env secret refs without an explicit credential resolver', () => {
    process.env.READY_KEY = 'sk-ready';
    const registry = new ProviderRegistry([
      {
        displayName: 'Hosted Ready',
        id: 'hosted-ready',
        kind: llmGatewayKind,
        models: ['model'],
        secretRef: 'env:READY_KEY',
      },
    ]);

    try {
      expect(registry.hasResolvableCredentials('hosted-ready')).toBe(false);
    } finally {
      delete process.env.READY_KEY;
    }
  });
});

describe('Provider.kind vocabulary V5 through native profiles and the registry', () => {
  // V5 canonical-only writes: the retained-file alias must not authorize new create/update input.
  it.each([
    'create',
    'update',
  ] as const)('refuses historical gateway on Provider %s and persists only the canonical gateway kind', (operation) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-provider-kind-write-v5-'));
    try {
      const providersRoot = join(dataRoot, 'config', 'providers');
      mkdirSync(providersRoot, { recursive: true });
      const manager = createRuntimeConfigManager({ dataRoot });
      const files = new RuntimeConfigFileService({
        dataRoot,
        workspaceIds: [],
        userId: 'usr_0190f4c8-0000-7000-8000-000000000001',
        runtimeConfigManager: manager,
        readRuntimeConfigStatus: () => manager.status(),
      });
      const id = 'providers/new-profile.provider.jsonc';
      const path = join(dataRoot, 'config', id);
      const profile = {
        schemaVersion: 1,
        id: 'new-profile',
        displayName: 'New Provider',
        kind: 'direct',
        models: ['fixture-model'],
      };
      const original = `${JSON.stringify(profile, null, 2)}\n`;
      if (operation === 'update') writeFileSync(path, original);
      const revision = operation === 'update' ? files.readFile(id).file.revision : null;
      const write = (kind: string) => {
        const input = {
          id,
          kind: 'provider' as const,
          content: `${JSON.stringify({ ...profile, kind }, null, 2)}\n`,
          expectedRevision: revision,
        };
        return operation === 'create' ? files.createFile(input) : files.updateFile(input);
      };
      let refusal: unknown = null;
      try {
        write('gateway');
      } catch (error) {
        refusal = error;
      }
      expect(refusal !== null).toBe(true);
      expect(refusal).toMatchObject({ code: 'config_file_invalid', status: 400 });
      if (operation === 'create') expect(existsSync(path)).toBe(false);
      else expect(readFileSync(path, 'utf8')).toBe(original);
      expect(write('llm-gateway').file.id).toBe(id);
      expect(parseJsoncObject(readFileSync(path, 'utf8'), path)).toEqual({
        ...profile,
        kind: 'llm-gateway',
      });
      const loaded = loadProviderProfiles(dataRoot);
      expect(loaded.diagnostics).toEqual([]);
      expect(loaded.profiles[0]?.kind).toBe('llm-gateway');
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  // V5 preserves the LLM-gateway class, including credentials, adapter, and endpoint capabilities.
  it('keeps llm-gateway credential requirements and LLM dispatch projection', () => {
    const profile: ProviderProfile = {
      id: 'team-gateway',
      displayName: 'Team Gateway',
      kind: llmGatewayKind,
      baseUrl: 'https://gateway.example.invalid/v1',
      vendor: 'openrouter',
      models: ['fixture-model'],
    };
    const registry = new ProviderRegistry([profile]);

    expect(registry.get('team-gateway')).toEqual(profile);
    expect(registry.summarize()[0]?.kind).toBe('llm-gateway');
    expect(registry.hasResolvableCredentials('team-gateway')).toBe(false);
    expect(resolveProviderProfileToLLMConfig(profile)).toEqual({
      adapterId: 'openrouter',
      apiKey: null,
      baseUrl: 'https://gateway.example.invalid/v1',
      displayName: 'Team Gateway',
      gatewayCapabilities: { chatCompletions: 'native', responses: 'bridged' },
      id: 'team-gateway',
      models: ['fixture-model'],
      vendor: 'openrouter',
      requiresApiKey: true,
    });
  });

  // Config Identity: versioned authored reads are projections; V5 changes only retained kind.
  it('reads a retained v1 gateway as llm-gateway without rewriting any source bytes', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-provider-kind-v5-'));
    try {
      const providersRoot = join(dataRoot, 'config', 'providers');
      mkdirSync(providersRoot, { recursive: true });
      const path = join(providersRoot, 'gateway.provider.jsonc');
      const retained = {
        schemaVersion: 1,
        id: 'gateway',
        displayName: 'gateway',
        kind: 'gateway',
        baseUrl: 'https://gateway.example.invalid/v1',
        category: 'gateway',
        defaultModel: 'gateway',
        models: ['gateway'],
        vendor: 'gateway',
        extensions: { example: { kind: 'gateway', label: 'gateway' } },
      };
      const source = `// retained gateway profile; keep this comment\n${JSON.stringify(retained, null, 2)}\n`;
      writeFileSync(path, source);
      const { schemaVersion: _schemaVersion, ...logical } = retained;

      for (let read = 0; read < 2; read += 1) {
        const result = loadProviderProfiles(dataRoot);
        expect(result.diagnostics).toEqual([]);
        expect(result.profiles).toEqual([{ ...logical, kind: 'llm-gateway' }]);
        const registry = new ProviderRegistry(result.profiles);
        expect(registry.get('gateway')?.kind).toBe('llm-gateway');
        expect(registry.hasResolvableCredentials('gateway')).toBe(false);
        expect(resolveProviderProfileToLLMConfig(result.profiles[0]!)).toMatchObject({
          adapterId: 'gateway',
          baseUrl: 'https://gateway.example.invalid/v1',
          models: ['gateway'],
          requiresApiKey: true,
        });
        expect(readFileSync(path)).toEqual(Buffer.from(source));
      }
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  // Config Identity first publication + V5: new Provider files retain v1 and write llm-gateway.
  it('publishes a new LLM-gateway Provider profile with its canonical kind on disk', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-provider-kind-v5-'));
    try {
      ensureLayout(dataRoot);
      const path = join(dataRoot, 'config', 'providers', 'openrouter-default.provider.jsonc');
      const source = readFileSync(path, 'utf8');
      const authored = parseJsoncObject(source, path);

      expect(authored.schemaVersion).toBe(1);
      expect(authored.kind).toBe('llm-gateway');
      expect(authored.id).toBe('openrouter');
      const result = loadProviderProfiles(dataRoot);
      expect(result.diagnostics).toEqual([]);
      const registry = new ProviderRegistry(result.profiles);
      expect(registry.get('openrouter')?.kind).toBe('llm-gateway');
      expect(
        registry.summarize().find(({ id }) => id === 'openrouter')?.gatewayCapabilities
      ).toEqual({ chatCompletions: 'native', responses: 'bridged' });
      ensureLayout(dataRoot);
      expect(readFileSync(path, 'utf8')).toBe(source);
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });
});
