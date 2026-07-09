import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { VaultBackendError } from './vault-backend.js';
import { loadEncryptedFileVaultKeyFile } from './vault-key-file.js';

describe('encrypted-file vault key file source', () => {
  it('loads an owner-only 32-byte raw key file', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-vault-key-file-'));
    const keyPath = join(dataRoot, 'vault.key');
    const key = Buffer.alloc(32, 7);
    writeFileSync(keyPath, key);
    chmodSync(keyPath, 0o600);

    expect(loadEncryptedFileVaultKeyFile({ keyFilePath: keyPath })).toEqual(key);
  });

  it('rejects broad permissions and invalid key lengths without leaking key material', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-vault-key-file-'));
    const broadKeyPath = join(dataRoot, 'broad.key');
    const shortKeyPath = join(dataRoot, 'short.key');
    const key = Buffer.alloc(32, 9);
    writeFileSync(broadKeyPath, key);
    chmodSync(broadKeyPath, 0o644);
    writeFileSync(shortKeyPath, 'live_secret_value');
    chmodSync(shortKeyPath, 0o600);

    expect(() => loadEncryptedFileVaultKeyFile({ keyFilePath: broadKeyPath })).toThrow(
      VaultBackendError
    );

    try {
      loadEncryptedFileVaultKeyFile({ keyFilePath: shortKeyPath });
    } catch (error) {
      expect(error).toBeInstanceOf(VaultBackendError);
      expect(error).toMatchObject({ code: 'backend-unavailable' });
      expect(String(error)).not.toContain(shortKeyPath);
      expect(String(error)).not.toContain('live_secret_value');
      return;
    }

    throw new Error('Expected invalid key file to fail.');
  });
});
