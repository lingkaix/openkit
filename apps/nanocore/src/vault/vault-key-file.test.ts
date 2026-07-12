import { chmodSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { VaultBackendError } from './vault-backend.js';
import { loadEncryptedFileVaultKeyFile } from './vault-key-file.js';

describe('encrypted-file vault key file source', () => {
  it('loads only the 32 bytes from an absolute owner-only regular file', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-vault-key-file-'));
    const keyPath = join(dataRoot, 'vault.key');
    const key = Buffer.alloc(32, 7);
    writeFileSync(keyPath, key);
    chmodSync(keyPath, 0o600);

    const loaded = loadEncryptedFileVaultKeyFile({ keyFilePath: keyPath });

    expect(loaded).toEqual(key);
    expect(loaded.byteLength).toBe(32);
  });

  it('rejects relative paths with a typed redacted error', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-vault-key-file-'));
    const keyPath = join(dataRoot, 'vault.key');
    const relativeKeyPath = relative(process.cwd(), keyPath);
    const key = Buffer.alloc(32, 'r');
    writeFileSync(keyPath, key);
    chmodSync(keyPath, 0o600);

    expectRedactedFailure(relativeKeyPath, [keyPath, key.toString('utf8')]);
  });

  it('rejects symlinks with a typed redacted error', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-vault-key-file-'));
    const keyPath = join(dataRoot, 'vault.key');
    const linkPath = join(dataRoot, 'vault-link.key');
    const key = Buffer.alloc(32, 's');
    writeFileSync(keyPath, key);
    chmodSync(keyPath, 0o600);
    symlinkSync(keyPath, linkPath);

    expectRedactedFailure(linkPath, [keyPath, key.toString('utf8')]);
  });

  it('rejects weak permissions with a typed redacted error', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-vault-key-file-'));
    const keyPath = join(dataRoot, 'vault.key');
    const key = Buffer.alloc(32, 'p');
    writeFileSync(keyPath, key);
    chmodSync(keyPath, 0o640);

    expectRedactedFailure(keyPath, [key.toString('utf8')]);
  });

  it('rejects owner mismatches with a typed redacted error', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-vault-key-file-'));
    const keyPath = join(dataRoot, 'vault.key');
    const key = Buffer.alloc(32, 'o');
    writeFileSync(keyPath, key);
    chmodSync(keyPath, 0o600);
    const currentEuid = process.geteuid();
    const getEuid = vi.spyOn(process, 'geteuid').mockReturnValue(currentEuid + 1);

    try {
      expectRedactedFailure(keyPath, [key.toString('utf8')]);
    } finally {
      getEuid.mockRestore();
    }
  });

  it.each([31, 33])('rejects a %i-byte key with a typed redacted error', (byteLength) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-vault-key-file-'));
    const keyPath = join(dataRoot, 'vault.key');
    const key = Buffer.alloc(byteLength, 'k');
    writeFileSync(keyPath, key);
    chmodSync(keyPath, 0o600);

    expectRedactedFailure(keyPath, [key.toString('utf8')]);
  });

  it('rejects a missing file with a typed redacted error', () => {
    const keyPath = join(mkdtempSync(join(tmpdir(), 'openkit-vault-key-file-')), 'missing.key');

    expectRedactedFailure(keyPath);
  });
});

/**
 * Requires key-file loading to fail without exposing filesystem or key details.
 *
 * @param keyFilePath Candidate key-file path.
 * @param forbiddenValues Additional sensitive values that must stay redacted.
 */
function expectRedactedFailure(keyFilePath: string, forbiddenValues: readonly string[] = []): void {
  let failure: unknown;

  try {
    loadEncryptedFileVaultKeyFile({ keyFilePath });
  } catch (error) {
    failure = error;
  }

  expect(failure).toBeInstanceOf(VaultBackendError);
  expect(failure).toMatchObject({ code: 'backend-unavailable' });
  expect(String(failure)).not.toContain(keyFilePath);
  expect(String(failure)).not.toMatch(/\bE[A-Z0-9_]{2,}\b/);
  expect(String(failure)).not.toMatch(/errno|syscall/i);

  for (const forbiddenValue of forbiddenValues) {
    expect(String(failure)).not.toContain(forbiddenValue);
  }
}
