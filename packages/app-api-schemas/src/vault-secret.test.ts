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
      {
        secretKind: 'github-token',
        material: 'test',
        referenceId: 'vault_00000000-0000-7377-a5ad-28032ca327ae',
      },
    ])
      expect(vault.CreateWorkspaceVaultSecretRequestSchema.safeParse(value).success).toBe(false);
    expect(
      vault.RotateWorkspaceVaultSecretRequestSchema.safeParse({ material: 'replacement' }).success
    ).toBe(true);
    expect(
      vault.CreateWorkspaceVaultGrantRequestSchema.safeParse({
        referenceId: 'vault_00000000-0000-7665-b682-3d8ade3ac72a',
        expiresAt: 'invalid',
      }).success
    ).toBe(false);
    expect(
      vault.CreateWorkspaceVaultGrantRequestSchema.parse({
        referenceId: 'vault_00000000-0000-7665-b682-3d8ade3ac72a',
        targetAgentId: 'agent-selected',
        targetCapabilityId: 'mcp.call_tool',
      })
    ).toMatchObject({ targetAgentId: 'agent-selected', targetCapabilityId: 'mcp.call_tool' });
    for (const constraints of [
      { targetCapabilityId: 'mcp' },
      { targetAgentId: null },
      { allowedInjectionPaths: [] },
      { lifetime: 'until-revoked' },
    ])
      expect(vault.NarrowWorkspaceVaultGrantRequestSchema.safeParse({ constraints }).success).toBe(
        false
      );
    expect(
      vault.CreateWorkspaceVaultGrantRequestSchema.parse({ referenceId: 'vault_00000000-0000-7665-b682-3d8ade3ac72a' })
    ).toMatchObject({ referenceId: 'vault_00000000-0000-7665-b682-3d8ade3ac72a' });
    expect(
      vault.CreateWorkspaceVaultGrantRequestSchema.parse({
        referenceId: 'vault_00000000-0000-7665-b682-3d8ade3ac72a',
        injectionPath: 'runtime-env',
      })
    ).toMatchObject({ injectionPath: 'runtime-env' });
    expect(
      vault.CreateWorkspaceVaultGrantRequestSchema.safeParse({
        referenceId: 'vault_00000000-0000-7665-b682-3d8ade3ac72a',
        injectionPath: 'gateway-only',
        targetCapabilityId: null,
      }).success
    ).toBe(false);
  });
});
