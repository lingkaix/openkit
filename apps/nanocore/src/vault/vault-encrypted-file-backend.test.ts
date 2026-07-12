import { existsSync, lstatSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { VaultBackendError } from './vault-backend.js';
import { createEncryptedFileVaultBackend } from './vault-encrypted-file-backend.js';

describe('encrypted-file vault backend', () => {
  it('initializes an empty store header and reopens existing entries with the same key', () => {
    const storeDir = mkdtempSync(join(tmpdir(), 'openkit-vault-backend-'));
    const masterKey = Buffer.alloc(32, 9);
    const headerPath = join(storeDir, 'header.json');
    const firstBackend = createEncryptedFileVaultBackend({
      masterKey,
      now: () => '2026-07-05T01:00:00.000Z',
      storeDir,
    });

    const headerText = readFileSync(headerPath, 'utf8');
    const header = JSON.parse(headerText) as Record<string, unknown>;

    expect(header).toMatchObject({
      createdAt: expect.any(String),
      formatVersion: 1,
      masterKeyVerification: { algorithm: 'aes-256-gcm' },
    });
    expect(Number.isFinite(Date.parse(header.createdAt as string))).toBe(true);
    expect(header.kdf).toEqual({ kind: 'raw-key-file' });
    expect(Object.keys(header.masterKeyVerification as Record<string, unknown>).sort()).toEqual([
      'algorithm',
      'nonce',
      'tag',
    ]);
    expect(lstatSync(headerPath).mode & 0o777).toBe(0o600);
    expect(headerText).not.toContain(masterKey.toString('base64'));
    expect(headerText).not.toContain(masterKey.toString('hex'));

    firstBackend.store({
      material: 'ghp_live_secret',
      metadata: { ownerScope: 'server' },
      referenceId: 'vault_github',
    });

    const reopenedBackend = createEncryptedFileVaultBackend({ masterKey, storeDir });

    expect(
      Buffer.from(reopenedBackend.resolve({ referenceId: 'vault_github' })).toString('utf8')
    ).toBe('ghp_live_secret');
  });

  it('rejects a wrong key before replacing or mutating an existing store', () => {
    const storeDir = mkdtempSync(join(tmpdir(), 'openkit-vault-backend-'));
    const masterKey = Buffer.alloc(32, 9);
    const wrongKey = Buffer.alloc(32, 8);
    const masterKeyBase64 = masterKey.toString('base64');
    const masterKeyHex = masterKey.toString('hex');
    const wrongKeyBase64 = wrongKey.toString('base64');
    const wrongKeyHex = wrongKey.toString('hex');
    const headerPath = join(storeDir, 'header.json');
    const backend = createEncryptedFileVaultBackend({ masterKey, storeDir });

    backend.store({
      material: 'ghp_live_secret',
      metadata: { ownerScope: 'server' },
      referenceId: 'vault_github',
    });

    const headerBefore = readFileSync(headerPath, 'utf8');
    let replacement: ReturnType<typeof createEncryptedFileVaultBackend> | undefined;
    let failure: unknown;

    try {
      replacement = createEncryptedFileVaultBackend({ masterKey: wrongKey, storeDir });
    } catch (error) {
      failure = error;
    }

    expect(replacement).toBeUndefined();
    expect(failure).toBeInstanceOf(VaultBackendError);
    expect(readFileSync(headerPath, 'utf8')).toBe(headerBefore);
    expect(String(failure)).not.toContain(storeDir);
    expect(String(failure)).not.toContain(masterKeyBase64);
    expect(String(failure)).not.toContain(masterKeyHex);
    expect(String(failure)).not.toContain(wrongKeyBase64);
    expect(String(failure)).not.toContain(wrongKeyHex);
    expect(wrongKey).toEqual(Buffer.alloc(32));
    expect(String(failure)).not.toContain('ghp_live_secret');
    expect(Buffer.from(backend.resolve({ referenceId: 'vault_github' })).toString('utf8')).toBe(
      'ghp_live_secret'
    );
  });

  it.each([
    'tampered-tag',
    'tampered-created-at',
    'unsupported-kdf',
    'malformed-json',
  ] as const)('rejects a %s header without exposing or repairing protected inputs', (corruption) => {
    const storeDir = mkdtempSync(join(tmpdir(), 'openkit-vault-backend-'));
    const masterKey = Buffer.alloc(32, 9);
    const masterKeyBase64 = masterKey.toString('base64');
    const masterKeyHex = masterKey.toString('hex');
    const headerPath = join(storeDir, 'header.json');

    createEncryptedFileVaultBackend({ masterKey, storeDir });

    const header = JSON.parse(readFileSync(headerPath, 'utf8')) as Record<string, unknown>;
    let corruptedHeader: string;

    if (corruption === 'tampered-tag') {
      const verification = header.masterKeyVerification as Record<string, unknown>;
      verification.tag = Buffer.alloc(16, 13).toString('base64');
      corruptedHeader = `${JSON.stringify(header, null, 2)}\n`;
    } else if (corruption === 'tampered-created-at') {
      header.createdAt = '2026-07-06T01:00:00.000Z';
      corruptedHeader = `${JSON.stringify(header, null, 2)}\n`;
    } else if (corruption === 'unsupported-kdf') {
      header.kdf = { kind: 'argon2id' };
      corruptedHeader = `${JSON.stringify(header, null, 2)}\n`;
    } else {
      corruptedHeader = '{"formatVersion":';
    }

    writeFileSync(headerPath, corruptedHeader, { mode: 0o600 });

    let failure: unknown;

    try {
      createEncryptedFileVaultBackend({ masterKey, storeDir });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(VaultBackendError);
    expect(readFileSync(headerPath, 'utf8')).toBe(corruptedHeader);
    expect(String(failure)).not.toContain(storeDir);
    expect(String(failure)).not.toContain(masterKeyBase64);
    expect(String(failure)).not.toContain(masterKeyHex);
  });

  it('rejects a non-empty headerless store without creating or rewriting files', () => {
    const storeDir = mkdtempSync(join(tmpdir(), 'openkit-vault-backend-'));
    const masterKey = Buffer.alloc(32, 9);
    const masterKeyBase64 = masterKey.toString('base64');
    const masterKeyHex = masterKey.toString('hex');
    const existingPath = join(storeDir, 'existing-store-data');
    const existingContent = 'existing_store_marker_must_not_change';

    writeFileSync(existingPath, existingContent, { mode: 0o600 });

    let backend: ReturnType<typeof createEncryptedFileVaultBackend> | undefined;
    let failure: unknown;

    try {
      backend = createEncryptedFileVaultBackend({ masterKey, storeDir });
    } catch (error) {
      failure = error;
    }

    expect(backend).toBeUndefined();
    expect(failure).toBeInstanceOf(VaultBackendError);
    expect(existsSync(join(storeDir, 'header.json'))).toBe(false);
    expect(readFileSync(existingPath, 'utf8')).toBe(existingContent);
    expect(String(failure)).not.toContain(storeDir);
    expect(String(failure)).not.toContain(existingContent);
    expect(String(failure)).not.toContain(masterKeyBase64);
    expect(String(failure)).not.toContain(masterKeyHex);
  });

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
