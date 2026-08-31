import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { createVaultUnlockState } from '../vault/vault-unlock-state.js';
import { listVaultUseRecords } from '../vault/vault-use-records.js';
import { createVaultProviderCredentialResolver } from './vault-credential-resolver.js';

/**
 * Creates a migrated Core DB and unlocked vault with one provider secret.
 *
 * @returns Test database, data root, and vault unlock state.
 */
function createVaultProviderFixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-vault-provider-credentials-'));
  const coreDb = openCoreDb(dataRoot);
  const vaultUnlockState = createVaultUnlockState({
    backendKind: 'encrypted-file',
    storeDir: join(dataRoot, 'server', 'vault'),
  });

  applyMigrations(coreDb);
  vaultUnlockState.unlock({ masterKey: Buffer.alloc(32, 6) });
  vaultUnlockState.backend().store({
    material: 'sk-vault-provider',
    metadata: { ownerScope: 'server' },
    referenceId: 'vault_provider',
  });

  return { coreDb, dataRoot, vaultUnlockState };
}

describe('vault provider credential resolver', () => {
  it('does not fall back to env references by default', () => {
    const previousKey = process.env.OPENKIT_VAULT_RESOLVER_ENV_CANARY;
    process.env.OPENKIT_VAULT_RESOLVER_ENV_CANARY = 'sk-env-canary';
    const { coreDb, vaultUnlockState } = createVaultProviderFixture();

    try {
      const resolver = createVaultProviderCredentialResolver({
        coreDb,
        vaultBackend: () => vaultUnlockState.backend(),
      });

      expect(resolver('env:OPENKIT_VAULT_RESOLVER_ENV_CANARY')).toBeNull();
      expect(listVaultUseRecords(coreDb)).toEqual([]);
    } finally {
      if (previousKey === undefined) {
        delete process.env.OPENKIT_VAULT_RESOLVER_ENV_CANARY;
      } else {
        process.env.OPENKIT_VAULT_RESOLVER_ENV_CANARY = previousKey;
      }
      coreDb.sqlite.close();
    }
  });

  it('resolves vault secret refs through the audited backend without storing material', () => {
    const { coreDb, vaultUnlockState } = createVaultProviderFixture();

    try {
      const resolver = createVaultProviderCredentialResolver({
        coreDb,
        vaultBackend: () => vaultUnlockState.backend(),
      });

      expect(resolver('vault://vault_provider')).toBe('sk-vault-provider');
      expect(listVaultUseRecords(coreDb)).toEqual([
        expect.objectContaining({
          backendKind: 'encrypted-file',
          materialVersion: 1,
          outcome: 'succeeded',
          ownerScope: 'server',
          resolvingPath: 'provider',
          vaultReferenceId: 'vault_provider',
        }),
      ]);
      expect(JSON.stringify(listVaultUseRecords(coreDb))).not.toContain('sk-vault-provider');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('preserves locked vault failures for vault-backed provider refs', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-vault-provider-locked-'));
    const coreDb = openCoreDb(dataRoot);
    const vaultUnlockState = createVaultUnlockState({
      backendKind: 'encrypted-file',
      storeDir: join(dataRoot, 'server', 'vault'),
    });

    try {
      applyMigrations(coreDb);
      const resolver = createVaultProviderCredentialResolver({
        coreDb,
        vaultBackend: () => vaultUnlockState.backend(),
      });

      expect(() => resolver('vault://vault_locked_provider')).toThrow('vault-locked');
      expect(listVaultUseRecords(coreDb)).toEqual([
        expect.objectContaining({
          failureCode: 'vault-locked',
          outcome: 'failed',
          resolvingPath: 'provider',
          vaultReferenceId: 'vault_locked_provider',
        }),
      ]);
    } finally {
      coreDb.sqlite.close();
    }
  });
});
