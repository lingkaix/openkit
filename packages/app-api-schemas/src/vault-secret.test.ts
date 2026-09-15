import { describe, expect, it } from 'vitest';
import * as vault from './vault-admin.js';

describe('workspace Vault secret input', () => {
  it('accepts request-only material and rejects unsafe metadata and extra fields', () => {
    expect(
      vault.CreateWorkspaceVaultSecretRequestSchema.parse({
        secretKind: 'github-token',
        material: 'synthetic-only',
      })
    ).toEqual({ secretKind: 'github-token', material: 'synthetic-only' });
    for (const value of [
      { secretKind: '../unsafe', material: 'test' },
      { secretKind: 'sk-secret', material: 'test' },
      { secretKind: 'github-token', material: '' },
      { secretKind: 'github-token', material: 'test', referenceId: 'chosen' },
    ])
      expect(vault.CreateWorkspaceVaultSecretRequestSchema.safeParse(value).success).toBe(false);
    expect(
      vault.RotateWorkspaceVaultSecretRequestSchema.safeParse({ material: 'replacement' }).success
    ).toBe(true);
    expect(
      vault.CreateWorkspaceVaultGrantRequestSchema.safeParse({
        referenceId: 'vault_example',
        expiresAt: 'invalid',
      }).success
    ).toBe(false);
    expect(
      vault.CreateWorkspaceVaultGrantRequestSchema.parse({ referenceId: 'vault_example' })
    ).toMatchObject({ referenceId: 'vault_example' });
    expect(
      vault.CreateWorkspaceVaultGrantRequestSchema.parse({
        referenceId: 'vault_example',
        injectionPath: 'runtime-env',
      })
    ).toMatchObject({ injectionPath: 'runtime-env' });
    expect(
      vault.CreateWorkspaceVaultGrantRequestSchema.safeParse({
        referenceId: 'vault_example',
        injectionPath: 'gateway-only',
        targetCapabilityId: null,
      }).success
    ).toBe(false);
  });
});
