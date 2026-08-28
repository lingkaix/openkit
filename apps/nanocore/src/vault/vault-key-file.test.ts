// openkit-test-platform: posix
import { chmodSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { VaultBackendError } from './vault-backend.js';
import { loadEncryptedFileVaultKeyFile } from './vault-key-file.js';

describe('encrypted-file vault key file source', () => {
  it('loads only the 32 bytes from an absolute owner-only regular file', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-vault-key-file-'));
    const keyRoot = mkdtempSync(join(tmpdir(), 'openkit-vault-key-root-'));
    const keyPath = join(keyRoot, 'vault.key');
    const key = Buffer.alloc(32, 7);
    writeFileSync(keyPath, key);
    chmodSync(keyPath, 0o600);

    const loaded = loadEncryptedFileVaultKeyFile({ dataRoot, keyFilePath: keyPath } as never);

    expect(loaded).toEqual(key);
    expect(loaded.byteLength).toBe(32);
  });

  it('rejects a key whose canonical path equals the Data Root', () => {
    const keyPath = join(mkdtempSync(join(tmpdir(), 'openkit-vault-key-file-')), 'vault.key');
    const key = Buffer.alloc(32, 'e');
    writeFileSync(keyPath, key);
    chmodSync(keyPath, 0o600);

    expectRedactedFailure({ dataRoot: keyPath, keyFilePath: keyPath }, [key.toString('utf8')]);
  });

  it('rejects a key whose canonical path is beneath the Data Root', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-vault-data-root-'));
    const keyPath = join(dataRoot, 'vault.key');
    const key = Buffer.alloc(32, 'b');
    writeFileSync(keyPath, key);
    chmodSync(keyPath, 0o600);

    expectRedactedFailure({ dataRoot, keyFilePath: keyPath }, [key.toString('utf8')]);
  });

  it('rejects a parent-directory symlink whose key resolves beneath the Data Root', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-vault-data-root-'));
    const aliasRoot = mkdtempSync(join(tmpdir(), 'openkit-vault-key-alias-'));
    const keyPath = join(dataRoot, 'vault.key');
    const aliasPath = join(aliasRoot, 'data-root');
    const configuredKeyPath = join(aliasPath, 'vault.key');
    const key = Buffer.alloc(32, 'a');
    writeFileSync(keyPath, key);
    chmodSync(keyPath, 0o600);
    symlinkSync(dataRoot, aliasPath, 'dir');

    expectRedactedFailure({ dataRoot, keyFilePath: configuredKeyPath }, [
      keyPath,
      key.toString('utf8'),
    ]);
  });

  it('rejects relative paths with a typed redacted error', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-vault-key-file-'));
    const keyRoot = mkdtempSync(join(tmpdir(), 'openkit-vault-key-root-'));
    const keyPath = join(keyRoot, 'vault.key');
    const relativeKeyPath = relative(process.cwd(), keyPath);
    const key = Buffer.alloc(32, 'r');
    writeFileSync(keyPath, key);
    chmodSync(keyPath, 0o600);

    expectRedactedFailure({ dataRoot, keyFilePath: relativeKeyPath }, [
      keyPath,
      key.toString('utf8'),
    ]);
  });

  it('rejects symlinks with a typed redacted error', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-vault-key-file-'));
    const keyRoot = mkdtempSync(join(tmpdir(), 'openkit-vault-key-root-'));
    const keyPath = join(keyRoot, 'vault.key');
    const linkPath = join(keyRoot, 'vault-link.key');
    const key = Buffer.alloc(32, 's');
    writeFileSync(keyPath, key);
    chmodSync(keyPath, 0o600);
    symlinkSync(keyPath, linkPath);

    expectRedactedFailure({ dataRoot, keyFilePath: linkPath }, [keyPath, key.toString('utf8')]);
  });

  it('rejects weak permissions with a typed redacted error', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-vault-key-file-'));
    const keyRoot = mkdtempSync(join(tmpdir(), 'openkit-vault-key-root-'));
    const keyPath = join(keyRoot, 'vault.key');
    const key = Buffer.alloc(32, 'p');
    writeFileSync(keyPath, key);
    chmodSync(keyPath, 0o640);

    expectRedactedFailure({ dataRoot, keyFilePath: keyPath }, [key.toString('utf8')]);
  });

  it('rejects owner mismatches with a typed redacted error', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-vault-key-file-'));
    const keyRoot = mkdtempSync(join(tmpdir(), 'openkit-vault-key-root-'));
    const keyPath = join(keyRoot, 'vault.key');
    const key = Buffer.alloc(32, 'o');
    writeFileSync(keyPath, key);
    chmodSync(keyPath, 0o600);
    const currentEuid = process.geteuid();
    const getEuid = vi.spyOn(process, 'geteuid').mockReturnValue(currentEuid + 1);

    try {
      expectRedactedFailure({ dataRoot, keyFilePath: keyPath }, [key.toString('utf8')]);
    } finally {
      getEuid.mockRestore();
    }
  });

  it.each([31, 33])('rejects a %i-byte key with a typed redacted error', (byteLength) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-vault-key-file-'));
    const keyRoot = mkdtempSync(join(tmpdir(), 'openkit-vault-key-root-'));
    const keyPath = join(keyRoot, 'vault.key');
    const key = Buffer.alloc(byteLength, 'k');
    writeFileSync(keyPath, key);
    chmodSync(keyPath, 0o600);

    expectRedactedFailure({ dataRoot, keyFilePath: keyPath }, [key.toString('utf8')]);
  });

  it('rejects a missing file with a typed redacted error', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-vault-key-file-'));
    const keyRoot = mkdtempSync(join(tmpdir(), 'openkit-vault-key-root-'));
    const keyPath = join(keyRoot, 'missing.key');

    expectRedactedFailure({ dataRoot, keyFilePath: keyPath });
  });
});

/**
 * Requires key-file loading to fail without exposing filesystem or key details.
 *
 * @param input Candidate Data Root and key-file path.
 * @param forbiddenValues Additional sensitive values that must stay redacted.
 */
function expectRedactedFailure(
  input: { dataRoot: string; keyFilePath: string },
  forbiddenValues: readonly string[] = []
): void {
  let failure: unknown;

  try {
    loadEncryptedFileVaultKeyFile(input as never);
  } catch (error) {
    failure = error;
  }

  expect(failure).toBeInstanceOf(VaultBackendError);
  expect(failure).toMatchObject({ code: 'backend-unavailable' });
  expect(String(failure)).not.toContain(input.dataRoot);
  expect(String(failure)).not.toContain(input.keyFilePath);
  expect(String(failure)).not.toMatch(/\bE[A-Z0-9_]{2,}\b/);
  expect(String(failure)).not.toMatch(/errno|syscall/i);

  for (const forbiddenValue of forbiddenValues) {
    expect(String(failure)).not.toContain(forbiddenValue);
  }
}
