import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { VaultBackendError } from './vault-backend.js';
import type {
  OsKeychainVaultAdapter,
  OsKeychainVaultItemInput,
} from './vault-os-keychain-backend.js';
import { createVaultUnlockState } from './vault-unlock-state.js';

describe('vault unlock state', () => {
  it('starts locked, unlocks an encrypted-file backend, and locks again', () => {
    const storeDir = mkdtempSync(join(tmpdir(), 'openkit-vault-unlock-'));
    const masterKey = Buffer.alloc(32, 9);
    const state = createVaultUnlockState({
      backendKind: 'encrypted-file',
      storeDir,
    });

    expect(state.backend().health()).toEqual({
      diagnostic: 'Vault backend is locked.',
      kind: 'encrypted-file',
      state: 'locked',
    });
    expect(() => state.backend().resolve({ referenceId: 'vault_github' })).toThrow('vault-locked');

    const unlocked = state.unlock({
      masterKey,
    });

    expect(unlocked.health()).toEqual({
      diagnostic: 'encrypted-file vault backend is unlocked',
      kind: 'encrypted-file',
      state: 'available',
    });

    unlocked.store({
      material: 'ghp_live_secret',
      metadata: { ownerScope: 'server' },
      referenceId: 'vault_github',
    });
    expect(
      Buffer.from(state.backend().resolve({ referenceId: 'vault_github' })).toString('utf8')
    ).toBe('ghp_live_secret');

    const locked = state.lock();

    expect(locked.health()).toEqual({
      diagnostic: 'Vault backend is locked.',
      kind: 'encrypted-file',
      state: 'locked',
    });
    expect(() => state.backend().resolve({ referenceId: 'vault_github' })).toThrow('vault-locked');

    let retainedBackendFailure: unknown;

    try {
      unlocked.resolve({ referenceId: 'vault_github' });
    } catch (error) {
      retainedBackendFailure = error;
    }

    expect(retainedBackendFailure).toBeInstanceOf(VaultBackendError);
    expect(unlocked.health()).toMatchObject({ state: 'locked' });
    expect(() =>
      unlocked.store({
        material: 'must_not_write',
        metadata: { ownerScope: 'server' },
        referenceId: 'vault_after_lock',
      })
    ).toThrow('vault-locked');
    expect(existsSync(join(storeDir, 'entries', 'vault_after_lock'))).toBe(false);
    expect(String(retainedBackendFailure)).not.toContain(storeDir);
    expect(String(retainedBackendFailure)).not.toContain(masterKey.toString('base64'));
    expect(String(retainedBackendFailure)).not.toContain(masterKey.toString('hex'));
    expect(String(retainedBackendFailure)).not.toContain('ghp_live_secret');
  });

  it('keeps the current backend usable when a replacement unlock fails', () => {
    const storeDir = mkdtempSync(join(tmpdir(), 'openkit-vault-unlock-'));
    const masterKey = Buffer.alloc(32, 9);
    const wrongKey = Buffer.alloc(32, 8);
    const state = createVaultUnlockState({ backendKind: 'encrypted-file', storeDir });
    const currentBackend = state.unlock({ masterKey });

    currentBackend.store({
      material: 'ghp_live_secret',
      metadata: { ownerScope: 'server' },
      referenceId: 'vault_github',
    });

    let replacement: ReturnType<typeof state.unlock> | undefined;
    let failure: unknown;

    try {
      replacement = state.unlock({ masterKey: wrongKey });
    } catch (error) {
      failure = error;
    }

    expect(replacement).toBeUndefined();
    expect(failure).toBeInstanceOf(VaultBackendError);
    expect(state.backend()).toBe(currentBackend);
    expect(
      Buffer.from(state.backend().resolve({ referenceId: 'vault_github' })).toString('utf8')
    ).toBe('ghp_live_secret');
    expect(String(failure)).not.toContain(storeDir);
    expect(String(failure)).not.toContain(wrongKey.toString('base64'));
    expect(String(failure)).not.toContain(wrongKey.toString('hex'));
    expect(String(failure)).not.toContain('ghp_live_secret');
  });

  it('rejects invalid encrypted-file unlock keys without keeping an available backend', () => {
    const state = createVaultUnlockState({
      backendKind: 'encrypted-file',
      storeDir: mkdtempSync(join(tmpdir(), 'openkit-vault-unlock-')),
    });

    expect(() => state.unlock({ masterKey: Buffer.alloc(16, 9) })).toThrow(
      'Vault unlock key must contain exactly 32 bytes.'
    );
    expect(state.backend().health()).toMatchObject({
      state: 'locked',
    });
  });

  it('starts os-keychain state from the platform adapter without encrypted-file unlock', () => {
    const state = createVaultUnlockState({
      adapter: new MemoryKeychainAdapter(),
      backendKind: 'os-keychain',
      deploymentId: 'dev',
    });

    expect(state.backend().health()).toEqual({
      diagnostic: 'os-keychain vault backend is available',
      kind: 'os-keychain',
      state: 'available',
    });
    expect(() => state.unlock({ masterKey: Buffer.alloc(32, 9) })).toThrow(
      'os-keychain vault backend does not use encrypted-file unlock keys.'
    );
    expect(state.lock().health()).toMatchObject({
      kind: 'os-keychain',
      state: 'available',
    });
  });
});

class MemoryKeychainAdapter implements OsKeychainVaultAdapter {
  private readonly items = new Map<string, string>();

  public health(): ReturnType<OsKeychainVaultAdapter['health']> {
    return { diagnostic: 'memory keychain available', state: 'available' };
  }

  public get(input: OsKeychainVaultItemInput): string | null {
    return this.items.get(this.key(input)) ?? null;
  }

  public set(input: OsKeychainVaultItemInput & { value: string }): void {
    this.items.set(this.key(input), input.value);
  }

  public delete(input: OsKeychainVaultItemInput): void {
    this.items.delete(this.key(input));
  }

  private key(input: OsKeychainVaultItemInput): string {
    return `${input.service}:${input.account}`;
  }
}
