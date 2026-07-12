import { Buffer } from 'node:buffer';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { OsKeychainVaultAdapter } from '../vault/vault-os-keychain-backend.js';
import { createVaultUnlockState } from '../vault/vault-unlock-state.js';
import { checkBootVaultBackend } from './vault.js';

describe('boot vault backend check', () => {
  it('unlocks an encrypted-file backend from a valid owner-only key file', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-boot-vault-valid-key-'));
    const keyFilePath = join(dataRoot, 'vault.key');
    const masterKey = Buffer.alloc(32, 0x11);
    const vaultUnlockState = createVaultUnlockState({
      backendKind: 'encrypted-file',
      storeDir: join(dataRoot, 'vault'),
    });
    writeFileSync(keyFilePath, masterKey, { mode: 0o600 });

    try {
      expect(checkBootVaultBackend({ keyFilePath, vaultUnlockState })).toEqual({ status: 'ok' });
      expect(vaultUnlockState.backend().health()).toMatchObject({
        kind: 'encrypted-file',
        state: 'available',
      });
    } finally {
      vaultUnlockState.lock();
      masterKey.fill(0);
      rmSync(dataRoot, { force: true, recursive: true });
    }
  });

  it('keeps an encrypted-file backend locked when the configured key file is missing', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-boot-vault-missing-key-'));
    const vaultUnlockState = createVaultUnlockState({
      backendKind: 'encrypted-file',
      storeDir: join(dataRoot, 'vault'),
    });

    try {
      expect(
        checkBootVaultBackend({
          keyFilePath: join(dataRoot, 'missing.key'),
          vaultUnlockState,
        })
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
    }
  });

  it('keeps an existing encrypted-file store locked when the key is wrong without leaking secrets', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-boot-vault-wrong-key-'));
    const keyFilePath = join(dataRoot, 'wrong-vault.key');
    const storeDir = join(dataRoot, 'vault');
    const correctKey = Buffer.alloc(32, 0x22);
    const wrongKey = Buffer.alloc(32, 0x33);
    const initializingState = createVaultUnlockState({ backendKind: 'encrypted-file', storeDir });
    const vaultUnlockState = createVaultUnlockState({ backendKind: 'encrypted-file', storeDir });

    try {
      initializingState.unlock({ masterKey: correctKey });
      initializingState.lock();
      writeFileSync(keyFilePath, wrongKey, { mode: 0o600 });

      const outcome = checkBootVaultBackend({ keyFilePath, vaultUnlockState });
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
    }
  });

  it('keeps an available os-keychain backend ready without reading the configured key path', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-boot-vault-os-keychain-'));
    const adapter = {
      /** Deletes no items in this health-only test adapter. */
      delete() {},
      /** Returns no items in this health-only test adapter. */
      get() {
        return null;
      },
      /** Reports the injected keychain as available. */
      health() {
        return { diagnostic: 'test keychain available', state: 'available' as const };
      },
      /** Stores no items in this health-only test adapter. */
      set() {},
    } satisfies OsKeychainVaultAdapter;
    const vaultUnlockState = createVaultUnlockState({
      adapter,
      backendKind: 'os-keychain',
      deploymentId: 'boot-test',
    });

    try {
      expect(
        checkBootVaultBackend({
          keyFilePath: join(dataRoot, 'missing.key'),
          vaultUnlockState,
        })
      ).toEqual({ status: 'ok' });
      expect(vaultUnlockState.backend().health()).toMatchObject({
        kind: 'os-keychain',
        state: 'available',
      });
    } finally {
      rmSync(dataRoot, { force: true, recursive: true });
    }
  });
});
