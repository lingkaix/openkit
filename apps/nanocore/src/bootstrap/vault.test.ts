// openkit-test-platform: posix
import { Buffer } from 'node:buffer';
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createVaultUnlockState } from '../vault/vault-unlock-state.js';
import { checkBootVaultBackend } from './vault.js';

describe('boot vault backend check', () => {
  it('unlocks an encrypted-file backend from a valid owner-only key file', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-boot-vault-valid-key-'));
    const keyRoot = mkdtempSync(join(tmpdir(), 'openkit-boot-vault-key-root-'));
    const keyFilePath = join(keyRoot, 'vault.key');
    const masterKey = Buffer.alloc(32, 0x11);
    const vaultUnlockState = createVaultUnlockState({
      backendKind: 'encrypted-file',
      storeDir: join(dataRoot, 'vault'),
    });
    writeFileSync(keyFilePath, masterKey, { mode: 0o600 });

    try {
      expect(checkBootVaultBackend({ dataRoot, keyFilePath, vaultUnlockState } as never)).toEqual({
        status: 'ok',
      });
      expect(vaultUnlockState.backend().health()).toMatchObject({
        kind: 'encrypted-file',
        state: 'available',
      });
    } finally {
      vaultUnlockState.lock();
      masterKey.fill(0);
      rmSync(dataRoot, { force: true, recursive: true });
      rmSync(keyRoot, { force: true, recursive: true });
    }
  });

  it('keeps an encrypted-file backend locked when the configured key file is missing', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-boot-vault-missing-key-'));
    const keyRoot = mkdtempSync(join(tmpdir(), 'openkit-boot-vault-key-root-'));
    const vaultUnlockState = createVaultUnlockState({
      backendKind: 'encrypted-file',
      storeDir: join(dataRoot, 'vault'),
    });

    try {
      expect(
        checkBootVaultBackend({
          dataRoot,
          keyFilePath: join(keyRoot, 'missing.key'),
          vaultUnlockState,
        } as never)
      ).toMatchObject({
        status: 'degraded',
        reason: {
          code: 'vault.locked',
          blocks: ['vault.read', 'vault.use', 'secret.inject'],
        },
      });
      expect(vaultUnlockState.backend().health()).toMatchObject({
        kind: 'encrypted-file',
        state: 'locked',
      });
    } finally {
      rmSync(dataRoot, { force: true, recursive: true });
      rmSync(keyRoot, { force: true, recursive: true });
    }
  });

  it('keeps an existing encrypted-file store locked when the key is wrong without leaking secrets', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-boot-vault-wrong-key-'));
    const keyRoot = mkdtempSync(join(tmpdir(), 'openkit-boot-vault-key-root-'));
    const keyFilePath = join(keyRoot, 'wrong-vault.key');
    const storeDir = join(dataRoot, 'vault');
    const correctKey = Buffer.alloc(32, 0x22);
    const wrongKey = Buffer.alloc(32, 0x33);
    const initializingState = createVaultUnlockState({ backendKind: 'encrypted-file', storeDir });
    const vaultUnlockState = createVaultUnlockState({ backendKind: 'encrypted-file', storeDir });

    try {
      initializingState.unlock({ masterKey: correctKey });
      initializingState.lock();
      writeFileSync(keyFilePath, wrongKey, { mode: 0o600 });

      const outcome = checkBootVaultBackend({ dataRoot, keyFilePath, vaultUnlockState } as never);
      const serializedOutcome = JSON.stringify(outcome);

      expect(outcome).toMatchObject({
        status: 'degraded',
        reason: {
          code: 'vault.locked',
          blocks: ['vault.read', 'vault.use', 'secret.inject'],
        },
      });
      expect(vaultUnlockState.backend().health()).toMatchObject({
        kind: 'encrypted-file',
        state: 'locked',
      });
      expect(serializedOutcome).not.toContain(keyFilePath);
      expect(serializedOutcome).not.toContain(wrongKey.toString('base64'));
      expect(serializedOutcome).not.toContain(wrongKey.toString('hex'));
    } finally {
      initializingState.lock();
      vaultUnlockState.lock();
      correctKey.fill(0);
      wrongKey.fill(0);
      rmSync(dataRoot, { force: true, recursive: true });
      rmSync(keyRoot, { force: true, recursive: true });
    }
  });

  it.each([
    ['direct path', false],
    ['parent-directory symlink', true],
  ] as const)('keeps the backend locked when a %s resolves beneath the Data Root', (_, useAlias) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-boot-vault-internal-key-'));
    const aliasRoot = mkdtempSync(join(tmpdir(), 'openkit-boot-vault-key-alias-'));
    const keyFilePath = join(dataRoot, 'vault.key');
    const aliasPath = join(aliasRoot, 'data-root');
    const configuredKeyFilePath = useAlias ? join(aliasPath, 'vault.key') : keyFilePath;
    const masterKey = Buffer.alloc(32, 0x44);
    const vaultUnlockState = createVaultUnlockState({
      backendKind: 'encrypted-file',
      storeDir: join(dataRoot, 'vault'),
    });
    writeFileSync(keyFilePath, masterKey, { mode: 0o600 });
    if (useAlias) {
      symlinkSync(dataRoot, aliasPath, 'dir');
    }

    try {
      expect
        .soft(
          checkBootVaultBackend({
            dataRoot,
            keyFilePath: configuredKeyFilePath,
            vaultUnlockState,
          } as never)
        )
        .toMatchObject({
          status: 'degraded',
          reason: {
            code: 'vault.locked',
            blocks: ['vault.read', 'vault.use', 'secret.inject'],
          },
        });
      expect.soft(vaultUnlockState.backend().health()).toMatchObject({
        kind: 'encrypted-file',
        state: 'locked',
      });
      expect(existsSync(join(dataRoot, 'vault', 'header.json'))).toBe(false);
    } finally {
      vaultUnlockState.lock();
      masterKey.fill(0);
      rmSync(dataRoot, { force: true, recursive: true });
      rmSync(aliasRoot, { force: true, recursive: true });
    }
  });
});
