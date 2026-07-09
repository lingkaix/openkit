import { lstatSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  openEncryptedFileVaultEntry,
  readEncryptedFileVaultEntry,
  readEncryptedFileVaultStoreHeader,
  sealEncryptedFileVaultEntry,
  writeEncryptedFileVaultEntry,
  writeEncryptedFileVaultStoreHeader,
} from './vault-encrypted-file-store.js';

describe('encrypted-file vault store format', () => {
  it('writes and reads a non-secret header and entry envelope with owner-only files', () => {
    const storeDir = mkdtempSync(join(tmpdir(), 'openkit-vault-store-format-'));

    const header = writeEncryptedFileVaultStoreHeader({
      createdAt: '2026-07-05T00:00:00.000Z',
      kdf: {
        kind: 'raw-key-file',
        salt: 'salt_base64',
      },
      masterKeyVerification: {
        algorithm: 'aes-256-gcm',
        nonce: 'verify_nonce_base64',
        tag: 'verify_tag_base64',
      },
      storeDir,
    });
    const entry = writeEncryptedFileVaultEntry({
      ciphertext: 'ciphertext_base64',
      createdAt: '2026-07-05T00:05:00.000Z',
      dataKey: {
        algorithm: 'aes-256-gcm',
        nonce: 'wrap_nonce_base64',
        tag: 'wrap_tag_base64',
        wrapped: 'wrapped_data_key_base64',
      },
      metadata: {
        ownerScope: 'workspace',
        workspaceId: 'ws_1',
      },
      nonce: 'entry_nonce_base64',
      referenceId: 'vault_github',
      storeDir,
      tag: 'entry_tag_base64',
      version: 1,
    });

    expect(header).toEqual(readEncryptedFileVaultStoreHeader({ storeDir }));
    expect(entry).toEqual(
      readEncryptedFileVaultEntry({ referenceId: 'vault_github', storeDir, version: 1 })
    );
    expect(entry).toMatchObject({
      associatedData: {
        referenceId: 'vault_github',
        version: 1,
      },
      referenceId: 'vault_github',
      version: 1,
    });
    expect(lstatSync(join(storeDir, 'header.json')).mode & 0o777).toBe(0o600);
    expect(lstatSync(join(storeDir, 'entries', 'vault_github', '1.enc')).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(storeDir, 'entries', 'vault_github', '1.enc'), 'utf8')).not.toContain(
      'ghp_live_secret'
    );
  });

  it('rejects unsafe reference ids before writing entry files', () => {
    const storeDir = mkdtempSync(join(tmpdir(), 'openkit-vault-store-format-'));

    expect(() =>
      writeEncryptedFileVaultEntry({
        ciphertext: 'ciphertext_base64',
        createdAt: '2026-07-05T00:05:00.000Z',
        dataKey: {
          algorithm: 'aes-256-gcm',
          nonce: 'wrap_nonce_base64',
          tag: 'wrap_tag_base64',
          wrapped: 'wrapped_data_key_base64',
        },
        metadata: {
          ownerScope: 'server',
        },
        nonce: 'entry_nonce_base64',
        referenceId: '../vault_github',
        storeDir,
        tag: 'entry_tag_base64',
        version: 1,
      })
    ).toThrow('Vault reference id is not safe for encrypted-file store paths.');
  });

  it('rejects entry envelopes whose associated data does not match the path', () => {
    const storeDir = mkdtempSync(join(tmpdir(), 'openkit-vault-store-format-'));
    const entryPath = join(storeDir, 'entries', 'vault_github', '1.enc');

    writeEncryptedFileVaultEntry({
      ciphertext: 'ciphertext_base64',
      createdAt: '2026-07-05T00:05:00.000Z',
      dataKey: {
        algorithm: 'aes-256-gcm',
        nonce: 'wrap_nonce_base64',
        tag: 'wrap_tag_base64',
        wrapped: 'wrapped_data_key_base64',
      },
      metadata: {
        ownerScope: 'server',
      },
      nonce: 'entry_nonce_base64',
      referenceId: 'vault_github',
      storeDir,
      tag: 'entry_tag_base64',
      version: 1,
    });

    const envelope = JSON.parse(readFileSync(entryPath, 'utf8')) as {
      associatedData: { version: number };
    };
    envelope.associatedData.version = 2;
    writeFileSync(entryPath, `${JSON.stringify(envelope, null, 2)}\n`, { mode: 0o600 });

    expect(() =>
      readEncryptedFileVaultEntry({ referenceId: 'vault_github', storeDir, version: 1 })
    ).toThrow('Encrypted-file vault entry identity does not match its path.');
  });

  it('seals and opens secret material without storing plaintext', () => {
    const storeDir = mkdtempSync(join(tmpdir(), 'openkit-vault-store-format-'));
    const masterKey = Buffer.alloc(32, 7);

    const entry = sealEncryptedFileVaultEntry({
      createdAt: '2026-07-05T00:10:00.000Z',
      masterKey,
      material: Buffer.from('ghp_live_secret'),
      metadata: {
        ownerScope: 'workspace',
        workspaceId: 'ws_1',
      },
      referenceId: 'vault_github',
      storeDir,
      version: 1,
    });
    const entryFile = readFileSync(join(storeDir, 'entries', 'vault_github', '1.enc'), 'utf8');
    const opened = openEncryptedFileVaultEntry({
      masterKey,
      referenceId: 'vault_github',
      storeDir,
      version: 1,
    });

    expect(Buffer.from(opened).toString('utf8')).toBe('ghp_live_secret');
    expect(entry.ciphertext).not.toContain('ghp_live_secret');
    expect(entryFile).not.toContain('ghp_live_secret');
    expect(entry.algorithm).toBe('aes-256-gcm');
  });

  it('rejects encrypted entries opened with the wrong master key', () => {
    const storeDir = mkdtempSync(join(tmpdir(), 'openkit-vault-store-format-'));

    sealEncryptedFileVaultEntry({
      createdAt: '2026-07-05T00:10:00.000Z',
      masterKey: Buffer.alloc(32, 7),
      material: Buffer.from('ghp_live_secret'),
      metadata: {
        ownerScope: 'server',
      },
      referenceId: 'vault_github',
      storeDir,
      version: 1,
    });

    expect(() =>
      openEncryptedFileVaultEntry({
        masterKey: Buffer.alloc(32, 8),
        referenceId: 'vault_github',
        storeDir,
        version: 1,
      })
    ).toThrow('Encrypted-file vault entry failed authentication.');
  });
});
