import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentEnvironmentLlmModelParametersSchema } from '@openkit/config-schema';
import { afterEach, describe, expect, it } from 'vitest';

import { resolveAgentSetup } from '../agents/setup-resolver.js';
import { resolveInternalRoleProfile } from '../internal-agents/profile-resolver.js';
import {
  resolveEffectiveModelMetadata,
  resolveLogicalModelCatalog,
} from '../llm/logical-models.js';
import { ProviderRegistry } from '../providers/registry.js';
import { createProviderCredentialConfigured } from '../providers/vault-credential-resolver.js';
import { ensureConfigTemplateSurface } from '../storage/fs-layout.js';
import { loadRuntimeConfig } from './runtime-config.js';

const roots: string[] = [];

/** Copies the actual shipped templates into an isolated, credential-free Data Root. */
function freshDataRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'openkit-shipped-tiers-'));
  roots.push(root);
  ensureConfigTemplateSurface(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('shipped tier templates', () => {
  it('resolves ordered explicit members with coherent runtime contracts and per-member compaction headroom', () => {
    const providerCredentialConfigured = createProviderCredentialConfigured({
      fallback: () => null,
    });
    const snapshot = loadRuntimeConfig(freshDataRoot(), { providerCredentialConfigured });
    const catalog = resolveLogicalModelCatalog(
      snapshot.gatewayConfig,
      snapshot.providerRegistry,
      undefined,
      providerCredentialConfigured
    );
    expect(
      catalog.every((model) =>
        model.routes.every(
          (route) => !route.available && route.unavailableReason === 'provider_api_key_missing'
        )
      )
    ).toBe(true);
    expect(catalog.every((model) => model.reasoningEffortLevels === undefined)).toBe(true);
    expect(catalog.map((model) => model.id)).toEqual(['free', 'flash', 'smart', 'pro']);
    expect(catalog.map((model) => model.routes.map((route) => route.providerModel))).toEqual([
      ['poolside/laguna-s-2.1:free', 'poolside/laguna-xs-2.1:free', 'cohere/north-mini-code:free'],
      ['gpt-6-luna', 'gemini-3.8-flash'],
      ['gpt-6.1-sol', 'claude-sonnet-5-5', 'grok-4.3'],
      ['gpt-6-astra', 'claude-opus-5-5'],
    ]);
    const contracts = [
      {
        contextWindow: 256_000,
        maxOutputTokens: 32_768,
        inputModalities: ['text'],
        reasoning: true,
      },
      {
        contextWindow: 1_048_576,
        maxOutputTokens: 65_536,
        inputModalities: ['text', 'image', 'pdf'],
        reasoning: true,
      },
      {
        contextWindow: 1_000_000,
        maxOutputTokens: 30_000,
        inputModalities: ['text', 'image', 'pdf'],
        reasoning: true,
      },
      {
        contextWindow: 1_000_000,
        maxOutputTokens: 128_000,
        inputModalities: ['text', 'image', 'pdf'],
        reasoning: true,
      },
    ];
    for (const [index, model] of catalog.entries()) {
      expect(model.routes.length).toBeGreaterThanOrEqual(2);
      expect(model.modelParameters).toEqual(contracts[index]);
      expect(
        AgentEnvironmentLlmModelParametersSchema.safeParse(model.modelParameters).success
      ).toBe(true);
      expect(model.capabilities).toEqual(
        expect.arrayContaining(['chat-completions', 'responses', 'tool-calling'])
      );
      expect(model.autoFailover).toBe(true);
      expect(snapshot.gatewayConfig.logicalModels[index]).not.toHaveProperty('routing');
      for (const route of model.routes) {
        const profile = snapshot.providerRegistry.get(route.providerProfileId)!;
        expect(profile.models).toContain(route.providerModel);
        const metadata = resolveEffectiveModelMetadata(profile, route.providerModel);
        expect(metadata.limit?.context).toBeGreaterThan(0);
        expect(metadata.limit?.output).toBeGreaterThan(0);
        expect(model.contextManagement.compactThreshold).toBeLessThanOrEqual(
          metadata.limit!.context!
        );
        expect(
          model.contextManagement.compactThreshold + metadata.limit!.output!
        ).toBeLessThanOrEqual(metadata.limit!.context!);
        if (model.id === 'free') expect(metadata.cost).toMatchObject({ input: 0, output: 0 });
      }
    }
    // Authored limits still constrain the contract when every member is unavailable.
    const blocked = new ProviderRegistry(
      snapshot.providerRegistry.list().map((profile) => ({
        ...profile,
        readiness: { status: 'disabled' as const },
      }))
    );
    const unavailable = resolveLogicalModelCatalog(snapshot.gatewayConfig, blocked);
    expect(unavailable.map((model) => model.modelParameters)).toEqual(contracts);
    expect(unavailable.every((model) => model.routes.every((route) => !route.available))).toBe(
      true
    );
  });

  it('resolves every shipped Agent and internal-role profile against the shipped tiers', () => {
    const snapshot = loadRuntimeConfig(freshDataRoot());
    expect(snapshot.agentManifests.map((manifest) => manifest.runtime.adapter).sort()).toEqual([
      'codex',
      'deepseek',
      'opencode',
      'pi',
    ]);
    for (const manifest of snapshot.agentManifests) {
      expect(manifest.models).toEqual({
        preferredLogicalModelId: 'smart',
        allowedLogicalModelIds: 'all',
      });
      const result = resolveAgentSetup(manifest, {
        gatewayConfig: snapshot.gatewayConfig,
        providerRegistry: snapshot.providerRegistry,
      });
      expect(result.diagnostics).toEqual([]);
      expect(result.setup?.logicalModels.preferredLogicalModelId).toBe('smart');
      expect(result.setup?.logicalModels.allowed.map((model) => model.id)).toEqual([
        'free',
        'flash',
        'smart',
        'pro',
      ]);
      // Native adapters project their supported subset and diagnose omissions; the
      // Gateway contract preserves the members' complete intersected modalities.
      for (const model of result.setup!.logicalModels.allowed) {
        expect(model.modelParameters?.inputModalities).toContain('text');
      }
    }
    expect(snapshot.internalRoleProfiles.profiles.length).toBeGreaterThan(0);
    for (const profile of snapshot.internalRoleProfiles.profiles) {
      const resolved = resolveInternalRoleProfile({
        roleId: profile.roleId,
        workspaceId: 'template-proof',
        profilesConfig: snapshot.internalRoleProfiles,
        gatewayConfig: snapshot.gatewayConfig,
        providerRegistry: snapshot.providerRegistry,
      });
      expect(resolved?.profile?.id).toBe(profile.id);
      expect(resolved?.logicalModel.id).toBe('smart');
      expect(resolved?.logicalModels.map((model) => model.id)).toEqual([
        'smart',
        'free',
        'flash',
        'pro',
      ]);
    }
  });

  it('leaves all existing authored config, Provider and Agent bytes unchanged on copy-on-init', () => {
    const root = freshDataRoot();
    const config = join(root, 'config');
    const files = [
      'server.jsonc',
      'gateway.jsonc',
      'internal-role-profiles.jsonc',
      'model-catalog.jsonc',
      ...['providers', 'agents'].flatMap((directory) =>
        readdirSync(join(config, directory))
          .filter((file) => file.endsWith('.jsonc'))
          .map((file) => join(directory, file))
      ),
    ];
    const authored = files.map(
      (file) =>
        [file, `// Operator-authored ${file}\n${readFileSync(join(config, file), 'utf8')}`] as const
    );
    for (const [file, bytes] of authored) writeFileSync(join(config, file), bytes);
    ensureConfigTemplateSurface(root);
    for (const [file, bytes] of authored)
      expect(readFileSync(join(config, file), 'utf8')).toBe(bytes);
  });
});
