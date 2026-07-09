import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { VaultBackendError } from './vault-backend.js';
import { createEncryptedFileVaultBackend } from './vault-encrypted-file-backend.js';

describe('encrypted-file vault backend', () => {
  it('stores, resolves, and lists encrypted material without plaintext files', () => {
    const storeDir = mkdtempSync(join(tmpdir(), 'openkit-vault-backend-'));
    const backend = createEncryptedFileVaultBackend({
      masterKey: Buffer.alloc(32, 9),
      now: () => '2026-07-05T01:00:00.000Z',
      storeDir,
    });

    const inventory = backend.store({
      material: Buffer.from('ghp_live_secret'),
      metadata: {
        ownerScope: 'workspace',
        workspaceId: 'ws_1',
      },
      referenceId: 'vault_github',
    });
    const resolved = backend.resolve({ referenceId: 'vault_github' });
    const entryPath = join(storeDir, 'entries', 'vault_github', '1.enc');

    expect(inventory).toEqual({
      backendKind: 'encrypted-file',
      currentVersion: 1,
      ownerScope: 'workspace',
      referenceId: 'vault_github',
      revoked: false,
      updatedAt: '2026-07-05T01:00:00.000Z',
      versionCount: 1,
      workspaceId: 'ws_1',
    });
    expect(Buffer.from(resolved).toString('utf8')).toBe('ghp_live_secret');
    expect(readFileSync(entryPath, 'utf8')).not.toContain('ghp_live_secret');
    expect(backend.listReferences()).toEqual([inventory]);
    expect(backend.listReferences({ ownerScope: 'server' })).toEqual([]);
    expect(backend.health()).toEqual({
      diagnostic: 'encrypted-file vault backend is unlocked',
      kind: 'encrypted-file',
      state: 'available',
    });
  });

  it('fails unknown references and duplicate stores with typed redacted errors', () => {
    const storeDir = mkdtempSync(join(tmpdir(), 'openkit-vault-backend-'));
    const backend = createEncryptedFileVaultBackend({
      masterKey: Buffer.alloc(32, 9),
      now: () => '2026-07-05T01:00:00.000Z',
      storeDir,
    });

    expect(() => backend.resolve({ referenceId: 'vault_missing' })).toThrow(VaultBackendError);
    expect(() => backend.resolve({ referenceId: 'vault_missing' })).toThrow('reference-not-found');
    expect(existsSync(join(storeDir, 'entries'))).toBe(false);

    backend.store({
      material: 'ghp_live_secret',
      metadata: { ownerScope: 'server' },
      referenceId: 'vault_github',
    });

    expect(() =>
      backend.store({
        material: 'changed_secret',
        metadata: { ownerScope: 'server' },
        referenceId: 'vault_github',
      })
    ).toThrow('backend-unavailable: Vault reference material already exists.');
  });

  it('rejects inconsistent owner metadata before storing material', () => {
    const storeDir = mkdtempSync(join(tmpdir(), 'openkit-vault-backend-'));
    const backend = createEncryptedFileVaultBackend({
      masterKey: Buffer.alloc(32, 9),
      now: () => '2026-07-05T01:00:00.000Z',
      storeDir,
    });

    expect(() =>
      backend.store({
        material: 'ghp_live_secret',
        metadata: { ownerScope: 'server', workspaceId: 'ws_1' },
        referenceId: 'vault_github',
      })
    ).toThrow('backend-unavailable: Vault entry metadata does not match its owner scope.');
    expect(existsSync(join(storeDir, 'entries'))).toBe(false);
  });

  it('rotates current material and revokes every version', () => {
    const timestamps = [
      '2026-07-05T01:00:00.000Z',
      '2026-07-05T01:10:00.000Z',
      '2026-07-05T01:15:00.000Z',
      '2026-07-05T01:20:00.000Z',
    ];
    const storeDir = mkdtempSync(join(tmpdir(), 'openkit-vault-backend-'));
    const backend = createEncryptedFileVaultBackend({
      masterKey: Buffer.alloc(32, 9),
      now: () => timestamps.shift() ?? '2026-07-05T01:30:00.000Z',
      rotationGraceMs: 900_000,
      storeDir,
    });
    const firstEntryPath = join(storeDir, 'entries', 'vault_github', '1.enc');
    const secondEntryPath = join(storeDir, 'entries', 'vault_github', '2.enc');

    backend.store({
      material: 'first_secret',
      metadata: { ownerScope: 'server' },
      referenceId: 'vault_github',
    });

    const rotated = backend.rotate({ material: 'second_secret', referenceId: 'vault_github' });

    expect(rotated).toMatchObject({
      currentVersion: 2,
      referenceId: 'vault_github',
      revoked: false,
      updatedAt: '2026-07-05T01:10:00.000Z',
      versionCount: 2,
    });
    expect(Buffer.from(backend.resolve({ referenceId: 'vault_github' })).toString('utf8')).toBe(
      'second_secret'
    );
    expect(
      Buffer.from(backend.resolve({ referenceId: 'vault_github', version: 1 })).toString('utf8')
    ).toBe('first_secret');

    const revoked = backend.revoke({ referenceId: 'vault_github' });

    expect(existsSync(firstEntryPath)).toBe(false);
    expect(existsSync(secondEntryPath)).toBe(false);
    expect(revoked).toMatchObject({
      currentVersion: 2,
      referenceId: 'vault_github',
      revoked: true,
      updatedAt: '2026-07-05T01:20:00.000Z',
      versionCount: 2,
    });
    expect(() => backend.resolve({ referenceId: 'vault_github' })).toThrow('reference-revoked');
    expect(() => backend.resolve({ referenceId: 'vault_github', version: 1 })).toThrow(
      'reference-revoked'
    );
    expect(
      readFileSync(join(storeDir, 'entries', 'vault_github', 'state.json'), 'utf8')
    ).not.toContain('second_secret');
    expect(backend.listReferences()).toEqual([revoked]);
  });

  it('expires prior versions after rotation grace', () => {
    const timestamps = [
      '2026-07-05T01:00:00.000Z',
      '2026-07-05T01:10:00.000Z',
      '2026-07-05T01:10:30.000Z',
      '2026-07-05T01:11:01.000Z',
    ];
    const storeDir = mkdtempSync(join(tmpdir(), 'openkit-vault-backend-'));
    const backend = createEncryptedFileVaultBackend({
      masterKey: Buffer.alloc(32, 9),
      now: () => timestamps.shift() ?? '2026-07-05T01:12:00.000Z',
      rotationGraceMs: 60_000,
      storeDir,
    });
    const priorEntryPath = join(storeDir, 'entries', 'vault_github', '1.enc');

    backend.store({
      material: 'first_secret',
      metadata: { ownerScope: 'server' },
      referenceId: 'vault_github',
    });
    backend.rotate({ material: 'second_secret', referenceId: 'vault_github' });

    expect(
      Buffer.from(backend.resolve({ referenceId: 'vault_github', version: 1 })).toString('utf8')
    ).toBe('first_secret');
    expect(existsSync(priorEntryPath)).toBe(true);
    expect(() => backend.resolve({ referenceId: 'vault_github', version: 1 })).toThrow(
      'version-expired'
    );
    expect(existsSync(priorEntryPath)).toBe(false);
    expect(Buffer.from(backend.resolve({ referenceId: 'vault_github' })).toString('utf8')).toBe(
      'second_secret'
    );
    expect(readFileSync(join(storeDir, 'entries', 'vault_github', 'state.json'), 'utf8')).toContain(
      '"1": "2026-07-05T01:11:00.000Z"'
    );
  });
});
