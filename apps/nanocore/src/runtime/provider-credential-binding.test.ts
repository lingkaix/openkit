import type { AgentEnvironmentPackage } from '@openkit/config-schema';
import { describe, expect, it } from 'vitest';
import {
  requireWorkerProviderBindings,
  requireWorkerProviderProtection,
  type WorkerProviderCredentialBinding,
  WorkerProviderCredentialBindingSchema,
  WorkerProviderEffectIntentSchema,
  type WorkerProviderProtectionProof,
} from './provider-credential-binding.js';

// Prior contract: reference-only dormant data port; no Vault, Policy or runtime authority is minted.
const binding: WorkerProviderCredentialBinding = {
  declarationId: 'static_provider',
  grantId: 'grant_00000000-0000-7000-8000-000000000001',
  planId: 'plan_static_provider',
  receiptId: 'receipt_static_provider',
  vaultReferenceId: 'vault_00000000-0000-7000-8000-000000000001',
  materialVersion: 1,
  providerInstanceId: 'logical_provider',
  providerType: 'generic',
  credentialKey: 'API_TOKEN',
  profileId: 'fixture_static',
  accessShape: {
    id: 'fixture_static',
    credentialKey: 'API_TOKEN',
    endpoints: [
      { name: 'fixture_api', host: 'api.example.test', port: 443, binaries: ['/usr/bin/curl'] },
    ],
  },
};

// This pure function consumes the declaration projection, not an AEP admission or stored snapshot.
const declarationProjection = {
  credentials: {
    declarations: [
      {
        id: binding.declarationId,
        vaultGrantId: binding.grantId,
        visibility: 'sandbox-provider',
        provider: {
          instanceId: binding.providerInstanceId,
          type: binding.providerType,
          credentialKey: binding.credentialKey,
          profileId: binding.profileId,
        },
      },
    ],
  },
} as AgentEnvironmentPackage;

const proof: WorkerProviderProtectionProof = {
  declarationId: binding.declarationId,
  grantId: binding.grantId,
  planId: binding.planId,
  receiptId: binding.receiptId,
  vaultReferenceId: binding.vaultReferenceId,
  materialVersion: 1,
  mappingVersion: 1,
  profileDigest: '1'.repeat(64),
  expectedPolicyDigest: '2'.repeat(64),
  observedPolicyDigest: '2'.repeat(64),
  placeholderOnly: true,
  exposure: 'sandbox-provider',
};

const intent = {
  ...binding,
  deploymentId: 'fixture_deployment',
  workspaceId: 'fixture_workspace',
  policyIntent: { additionalFilesystemGrants: [], additionalNetworkEndpoints: [] },
};

describe('dormant Provider reference and protection port', () => {
  it('accepts exact references and matching configured intent without material', () => {
    expect(WorkerProviderCredentialBindingSchema.safeParse(binding).success).toBe(true);
    expect(WorkerProviderEffectIntentSchema.safeParse(intent).success).toBe(true);
    const accepted = requireWorkerProviderBindings(declarationProjection, [binding], (id) => {
      expect(id).toBe(binding.profileId);
      return binding.accessShape;
    });
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toMatchObject(binding);
    expect(requireWorkerProviderProtection(binding, proof)).toEqual(proof);
  });

  it('refuses raw values, synthetic overrides and unknown authority in closed metadata', () => {
    expect(
      WorkerProviderCredentialBindingSchema.safeParse({
        credentialKey: 'API_TOKEN',
        credentialValue: 'synthetic-private-material',
        providerInstanceId: 'logical_provider',
        providerType: 'generic',
      }).success
    ).toBe(false);
    for (const extra of [
      { credentialValue: 'synthetic-private-material' },
      { synthetic: true },
      { futureAuthority: true },
    ]) {
      expect(
        WorkerProviderCredentialBindingSchema.safeParse({ ...binding, ...extra }).success
      ).toBe(false);
      expect(WorkerProviderEffectIntentSchema.safeParse({ ...intent, ...extra }).success).toBe(
        false
      );
    }
    expect(
      WorkerProviderCredentialBindingSchema.safeParse({
        ...binding,
        accessShape: { ...binding.accessShape, refresh: {} },
      }).success
    ).toBe(false);
  });

  it('refuses mismatched, unknown or incomplete protection rather than granting completion', () => {
    for (const candidate of [
      undefined,
      { ...proof, observedPolicyDigest: '3'.repeat(64) },
      { ...proof, observedPolicyDigest: undefined },
      { ...proof, mappingVersion: 2 },
      { ...proof, materialVersion: 2 },
      { ...proof, receiptId: 'receipt_other' },
      { ...proof, placeholderOnly: false },
      { ...proof, futureAuthority: true },
    ])
      expect(() => requireWorkerProviderProtection(binding, candidate)).toThrow();
  });

  it('refuses a missing or changed current configured shape', () => {
    expect(() => requireWorkerProviderBindings(declarationProjection, [binding])).toThrow();
    expect(() =>
      requireWorkerProviderBindings(declarationProjection, [binding], () => undefined)
    ).toThrow();
    const changed = {
      ...binding.accessShape,
      endpoints: [{ ...binding.accessShape.endpoints[0]!, host: 'other.example.test' }],
    };
    expect(() =>
      requireWorkerProviderBindings(declarationProjection, [binding], () => changed)
    ).toThrow();
  });
});
