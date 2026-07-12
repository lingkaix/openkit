import { describe, expect, it } from 'vitest';

import {
  createLockedVaultBackend,
  VaultBackendError,
  type VaultSecretMaterial,
} from './vault-backend.js';

describe('vault backend boundary', () => {
  it('reports locked health without blocking NanoCore boot', () => {
    const backend = createLockedVaultBackend({
      diagnostic: 'No unlock source is configured.',
      kind: 'encrypted-file',
    });

    expect(backend.health()).toEqual({
      diagnostic: 'No unlock source is configured.',
      kind: 'encrypted-file',
      state: 'locked',
    });
  });

  it('fails locked operations with typed redacted errors', () => {
    const backend = createLockedVaultBackend({
      diagnostic: 'No unlock source is configured.',
      kind: 'encrypted-file',
    });
    const material: VaultSecretMaterial = 'live_secret_value';

    expect(() => backend.resolve({ referenceId: 'vault_demo' })).toThrow(VaultBackendError);
    expect(() => backend.resolve({ referenceId: 'vault_demo' })).toThrow('vault-locked');

    try {
      backend.store({
        material,
        metadata: {
          ownerScope: 'workspace',
          workspaceId: 'ws_demo',
        },
        referenceId: 'vault_demo',
      });
    } catch (error) {
      expect(error).toBeInstanceOf(VaultBackendError);
      expect(error).toMatchObject({ code: 'vault-locked' });
      expect(String(error)).not.toContain(material);
      return;
    }

    throw new Error('Expected locked vault store to fail.');
  });
});
