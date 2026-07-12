import { chmodSync, lstatSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { VaultBackendError } from './vault-backend.js';
import { ensureEncryptedFileVaultStoreDirectory } from './vault-store-directory.js';

describe('encrypted-file vault store directory', () => {
  it('creates the store directory with owner-only permissions', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-vault-store-dir-'));
    const storeDir = join(dataRoot, 'server', 'vault');

    expect(ensureEncryptedFileVaultStoreDirectory({ storeDir })).toEqual({
      mode: 0o700,
      storeDir,
    });
    expect(lstatSync(storeDir).mode & 0o777).toBe(0o700);
  });

  it('repairs empty broad-permission directories before material exists', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-vault-store-dir-'));
    const storeDir = join(dataRoot, 'server', 'vault');
    mkdirSync(storeDir, { recursive: true });
    chmodSync(storeDir, 0o755);

    expect(ensureEncryptedFileVaultStoreDirectory({ storeDir })).toEqual({
      mode: 0o700,
      storeDir,
    });
    expect(lstatSync(storeDir).mode & 0o777).toBe(0o700);
  });

  it('rejects non-empty broad permissions without leaking the store path', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-vault-store-dir-'));
    const storeDir = join(dataRoot, 'server', 'vault');
    mkdirSync(storeDir, { recursive: true });
    writeFileSync(join(storeDir, 'header.json'), '{}\n');
    chmodSync(storeDir, 0o755);

    try {
      ensureEncryptedFileVaultStoreDirectory({ storeDir });
    } catch (error) {
      expect(error).toBeInstanceOf(VaultBackendError);
      expect(error).toMatchObject({ code: 'backend-unavailable' });
      expect(String(error)).not.toContain(storeDir);
      return;
    }

    throw new Error('Expected broad vault store directory to fail.');
  });
});
