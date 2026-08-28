// openkit-test-platform: posix
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { VaultBackendError } from './vault-backend.js';
import { createEncryptedFileVaultBackend } from './vault-encrypted-file-backend.js';
import { sealEncryptedFileVaultEntry } from './vault-encrypted-file-store.js';

const STALE_WRITER_PID = process.pid === 1_234_567 ? 1_234_568 : 1_234_567;

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

  it('rejects a valid header reached through a symlink without changing its target', () => {
    const sourceStoreDir = mkdtempSync(join(tmpdir(), 'openkit-vault-header-source-'));
    const targetStoreDir = mkdtempSync(join(tmpdir(), 'openkit-vault-header-symlink-'));
    const sourceHeaderPath = join(sourceStoreDir, 'header.json');
    const targetHeaderPath = join(targetStoreDir, 'header.json');
    const sourceMasterKey = Buffer.alloc(32, 9);

    createEncryptedFileVaultBackend({ masterKey: sourceMasterKey, storeDir: sourceStoreDir });
    const sourceHeaderBefore = readFileSync(sourceHeaderPath, 'utf8');
    symlinkSync(sourceHeaderPath, targetHeaderPath, 'file');

    let failure: unknown;
    try {
      createEncryptedFileVaultBackend({
        masterKey: Buffer.alloc(32, 9),
        storeDir: targetStoreDir,
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(VaultBackendError);
    expect(failure).toMatchObject({ code: 'backend-unavailable' });
    expect(lstatSync(targetHeaderPath).isSymbolicLink()).toBe(true);
    expect(readFileSync(sourceHeaderPath, 'utf8')).toBe(sourceHeaderBefore);
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

  it('rejects reads and writes through symlinked entries without changing the external target', () => {
    const storeDir = mkdtempSync(join(tmpdir(), 'openkit-vault-backend-'));
    const externalStoreDir = mkdtempSync(join(tmpdir(), 'openkit-vault-external-store-'));
    const backend = createEncryptedFileVaultBackend({
      masterKey: Buffer.alloc(32, 9),
      storeDir,
    });
    const externalBackend = createEncryptedFileVaultBackend({
      masterKey: Buffer.alloc(32, 9),
      storeDir: externalStoreDir,
    });
    const externalReferenceId = 'vault_external_read';
    externalBackend.store({
      material: 'external_secret_must_not_escape',
      metadata: { ownerScope: 'server' },
      referenceId: externalReferenceId,
    });
    const externalEntriesDir = join(externalStoreDir, 'entries');
    const externalReferenceDir = join(externalEntriesDir, externalReferenceId);
    const externalNamesBefore = readdirSync(externalEntriesDir).sort();
    const externalReferenceNamesBefore = readdirSync(externalReferenceDir).sort();
    const externalFilesBefore = externalReferenceNamesBefore.map(
      (fileName) => [fileName, readFileSync(join(externalReferenceDir, fileName))] as const
    );
    symlinkSync(externalEntriesDir, join(storeDir, 'entries'), 'dir');

    expect.soft(() => backend.listReferences()).toThrow('backend-unavailable');
    expect
      .soft(() => {
        const material = backend.resolve({ referenceId: externalReferenceId });
        material.fill(0);
      })
      .toThrow('backend-unavailable');
    expect
      .soft(() =>
        backend.store({
          material: 'must_not_escape_the_store',
          metadata: { ownerScope: 'server' },
          referenceId: 'vault_symlinked_entries',
        })
      )
      .toThrow(VaultBackendError);
    expect.soft(readdirSync(externalEntriesDir).sort()).toEqual(externalNamesBefore);
    expect.soft(readdirSync(externalReferenceDir).sort()).toEqual(externalReferenceNamesBefore);
    for (const [fileName, content] of externalFilesBefore) {
      expect.soft(readFileSync(join(externalReferenceDir, fileName))).toEqual(content);
    }
  });

  it('rejects reads and writes through a symlinked reference without changing the external target', () => {
    const storeDir = mkdtempSync(join(tmpdir(), 'openkit-vault-backend-'));
    const externalRoot = mkdtempSync(join(tmpdir(), 'openkit-vault-external-reference-'));
    const timestamps = ['2026-07-05T01:00:00.000Z', '2026-07-05T01:10:00.000Z'];
    const backend = createEncryptedFileVaultBackend({
      masterKey: Buffer.alloc(32, 9),
      now: () => timestamps.shift() ?? '2026-07-05T01:10:00.000Z',
      storeDir,
    });
    const referenceId = 'vault_symlinked_reference';
    const referenceDir = join(storeDir, 'entries', referenceId);
    const externalReferenceDir = join(externalRoot, referenceId);

    backend.store({
      material: 'first_secret',
      metadata: { ownerScope: 'server' },
      referenceId,
    });
    renameSync(referenceDir, externalReferenceDir);
    symlinkSync(externalReferenceDir, referenceDir, 'dir');
    const externalNamesBefore = readdirSync(externalReferenceDir).sort();
    const externalFilesBefore = externalNamesBefore.map(
      (fileName) => [fileName, readFileSync(join(externalReferenceDir, fileName))] as const
    );

    expect.soft(() => backend.listReferences()).toThrow('backend-unavailable');
    expect
      .soft(() => {
        const material = backend.resolve({ referenceId });
        material.fill(0);
      })
      .toThrow('backend-unavailable');
    expect
      .soft(() => backend.rotate({ material: 'must_not_escape_the_store', referenceId }))
      .toThrow(VaultBackendError);
    expect.soft(readdirSync(externalReferenceDir).sort()).toEqual(externalNamesBefore);
    for (const [fileName, content] of externalFilesBefore) {
      expect.soft(readFileSync(join(externalReferenceDir, fileName))).toEqual(content);
    }
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

  it('round-trips authenticated provider-subscription inventory metadata', () => {
    const storeDir = mkdtempSync(join(tmpdir(), 'openkit-vault-backend-'));
    const masterKey = Buffer.alloc(32, 9);
    const backend = createEncryptedFileVaultBackend({ masterKey, storeDir });

    const stored = backend.store({
      material: 'subscription_secret',
      metadata: {
        ownerScope: 'server',
        providerSubscriptionAccount: {
          accountSlotId: 'slot_1',
          subscriptionProviderId: 'xai',
        },
      },
      referenceId: 'vault_subscription',
    } as never);

    expect(stored).toMatchObject({
      providerSubscriptionAccount: {
        accountSlotId: 'slot_1',
        subscriptionProviderId: 'xai',
      },
    });
    backend.rotate({ material: 'rotated_subscription_secret', referenceId: 'vault_subscription' });
    expect(createEncryptedFileVaultBackend({ masterKey, storeDir }).listReferences()).toEqual([
      expect.objectContaining({
        providerSubscriptionAccount: {
          accountSlotId: 'slot_1',
          subscriptionProviderId: 'xai',
        },
      }),
    ]);
  });

  it('fails closed when an entry exists without strict state', () => {
    const storeDir = mkdtempSync(join(tmpdir(), 'openkit-vault-backend-'));
    const backend = createEncryptedFileVaultBackend({ masterKey: Buffer.alloc(32, 9), storeDir });

    backend.store({
      material: 'entry_only_secret',
      metadata: { ownerScope: 'server' },
      referenceId: 'vault_entry_only',
    });
    rmSync(join(storeDir, 'entries', 'vault_entry_only', 'state.json'));

    expect(() => backend.listReferences()).toThrow('backend-unavailable');
    expect(() => backend.resolve({ referenceId: 'vault_entry_only' })).toThrow(
      'backend-unavailable'
    );
  });

  it('fails closed when active state exists without its current entry', () => {
    const storeDir = mkdtempSync(join(tmpdir(), 'openkit-vault-backend-'));
    const backend = createEncryptedFileVaultBackend({ masterKey: Buffer.alloc(32, 9), storeDir });

    backend.store({
      material: 'state_only_secret',
      metadata: { ownerScope: 'server' },
      referenceId: 'vault_state_only',
    });
    rmSync(join(storeDir, 'entries', 'vault_state_only', '1.enc'));

    expect(() => backend.listReferences()).toThrow('backend-unavailable');
    expect(() => backend.resolve({ referenceId: 'vault_state_only' })).toThrow(
      'backend-unavailable'
    );
  });

  it('fails closed when an extra material version is absent from state', () => {
    const storeDir = mkdtempSync(join(tmpdir(), 'openkit-vault-backend-'));
    const masterKey = Buffer.alloc(32, 9);
    const backend = createEncryptedFileVaultBackend({ masterKey, storeDir });

    backend.store({
      material: 'current_secret',
      metadata: { ownerScope: 'server' },
      referenceId: 'vault_extra_version',
    });
    sealEncryptedFileVaultEntry({
      createdAt: '2026-07-05T01:10:00.000Z',
      masterKey,
      material: 'orphan_secret',
      metadata: { ownerScope: 'server' },
      referenceId: 'vault_extra_version',
      storeDir,
      version: 2,
      versionExpirations: {},
    } as never);

    expect(() => backend.listReferences()).toThrow('backend-unavailable');
    expect(() => backend.resolve({ referenceId: 'vault_extra_version', version: 2 })).toThrow(
      'backend-unavailable'
    );
  });

  it('fails closed when current entry metadata contradicts state', () => {
    const storeDir = mkdtempSync(join(tmpdir(), 'openkit-vault-backend-'));
    const backend = createEncryptedFileVaultBackend({ masterKey: Buffer.alloc(32, 9), storeDir });
    const statePath = join(storeDir, 'entries', 'vault_mismatch', 'state.json');

    backend.store({
      material: 'mismatched_secret',
      metadata: { ownerScope: 'server' },
      referenceId: 'vault_mismatch',
    });
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, unknown>;
    state.metadata = { ownerScope: 'user', userId: 'user_other' };
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });

    expect(() => backend.listReferences()).toThrow('backend-unavailable');
    expect(() => backend.resolve({ referenceId: 'vault_mismatch' })).toThrow('backend-unavailable');
  });

  it('rejects a huge integral state version with a typed bounded failure instead of RangeError', () => {
    const storeDir = mkdtempSync(join(tmpdir(), 'openkit-vault-backend-'));
    const backend = createEncryptedFileVaultBackend({ masterKey: Buffer.alloc(32, 9), storeDir });
    const statePath = join(storeDir, 'entries', 'vault_huge_state', 'state.json');

    backend.store({
      material: 'huge_state_secret',
      metadata: { ownerScope: 'server' },
      referenceId: 'vault_huge_state',
    });
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, unknown>;
    state.currentVersion = Number.MAX_SAFE_INTEGER;
    state.versionCount = Number.MAX_SAFE_INTEGER;
    const stateBefore = `${JSON.stringify(state, null, 2)}\n`;
    writeFileSync(statePath, stateBefore, { mode: 0o600 });

    let failure: unknown;
    try {
      backend.listReferences();
    } catch (error) {
      failure = error;
    }

    expect.soft(failure).toBeInstanceOf(VaultBackendError);
    expect.soft(failure).toMatchObject({ code: 'backend-unavailable' });
    expect(failure).not.toBeInstanceOf(RangeError);
    expect(readFileSync(statePath, 'utf8')).toBe(stateBefore);
  });

  it('rejects an unsafe numeric entry filename as an unknown artifact before coercion', () => {
    const storeDir = mkdtempSync(join(tmpdir(), 'openkit-vault-backend-'));
    const backend = createEncryptedFileVaultBackend({ masterKey: Buffer.alloc(32, 9), storeDir });
    const referenceDir = join(storeDir, 'entries', 'vault_unsafe_filename');
    const entryPath = join(referenceDir, '1.enc');
    const unsafeEntryPath = join(referenceDir, '9007199254740993.enc');

    backend.store({
      material: 'unsafe_filename_secret',
      metadata: { ownerScope: 'server' },
      referenceId: 'vault_unsafe_filename',
    });
    writeFileSync(unsafeEntryPath, readFileSync(entryPath), { mode: 0o600 });

    let failure: unknown;
    try {
      backend.listReferences();
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(VaultBackendError);
    expect(failure).toMatchObject({
      code: 'backend-unavailable',
      message: 'backend-unavailable: Encrypted-file vault reference contains an unknown artifact.',
    });
    expect(failure).not.toBeInstanceOf(RangeError);
    expect(String(failure)).not.toContain(storeDir);
    expect(String(failure)).not.toContain('9007199254740993.enc');
  });

  it('rejects a direct unsafe numeric version with a typed redacted failure', () => {
    const storeDir = mkdtempSync(join(tmpdir(), 'openkit-vault-backend-'));
    const backend = createEncryptedFileVaultBackend({ masterKey: Buffer.alloc(32, 9), storeDir });
    const referenceId = 'vault_unsafe_direct_version';

    backend.store({
      material: 'unsafe_direct_version_secret',
      metadata: { ownerScope: 'server' },
      referenceId,
    });

    let failure: unknown;
    try {
      backend.resolve({ referenceId, version: Number.MAX_SAFE_INTEGER + 1 });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(VaultBackendError);
    expect(failure).toMatchObject({ code: 'backend-unavailable' });
    expect(failure).not.toBeInstanceOf(RangeError);
    expect(String(failure)).not.toContain(storeDir);
    expect(String(failure)).not.toContain('unsafe_direct_version_secret');
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

  it('fails closed on attributable revoked residue and explicit revoke destroys every version', () => {
    const storeDir = mkdtempSync(join(tmpdir(), 'openkit-vault-backend-'));
    const masterKey = Buffer.alloc(32, 9);
    const backend = createEncryptedFileVaultBackend({
      masterKey,
      now: () => '2026-07-05T01:00:00.000Z',
      rotationGraceMs: 60_000,
      storeDir,
    });
    const referenceDir = join(storeDir, 'entries', 'vault_revoked_residue');
    const statePath = join(referenceDir, 'state.json');
    const entryPaths = [1, 2, 3].map((version) => join(referenceDir, `${version}.enc`));

    backend.store({
      material: 'first_secret',
      metadata: { ownerScope: 'server' },
      referenceId: 'vault_revoked_residue',
    });
    backend.rotate({
      material: 'second_secret',
      referenceId: 'vault_revoked_residue',
    });
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, unknown>;
    sealEncryptedFileVaultEntry({
      createdAt: '2026-07-05T01:01:00.000Z',
      masterKey,
      material: 'attributable_third_secret',
      metadata: { ownerScope: 'server' },
      referenceId: 'vault_revoked_residue',
      storeDir,
      version: 3,
      versionExpirations: {
        ...(state.versionExpirations as Record<string, string>),
        '2': '2026-07-05T01:02:00.000Z',
      },
    } as never);
    state.revoked = true;
    state.updatedAt = '2026-07-05T01:01:30.000Z';
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });

    expect.soft(() => backend.listReferences()).toThrow('backend-unavailable');
    expect
      .soft(() => backend.resolve({ referenceId: 'vault_revoked_residue' }))
      .toThrow('backend-unavailable');

    const revoked = backend.revoke({ referenceId: 'vault_revoked_residue' });

    expect(revoked).toMatchObject({ referenceId: 'vault_revoked_residue', revoked: true });
    for (const entryPath of entryPaths) {
      expect(existsSync(entryPath)).toBe(false);
    }
    expect(backend.listReferences()).toEqual([revoked]);
  });

  it('revokes every attributable version discovered beyond stale state', () => {
    const storeDir = mkdtempSync(join(tmpdir(), 'openkit-vault-backend-'));
    const masterKey = Buffer.alloc(32, 9);
    const backend = createEncryptedFileVaultBackend({ masterKey, storeDir });
    const firstEntryPath = join(storeDir, 'entries', 'vault_cleanup', '1.enc');
    const extraEntryPath = join(storeDir, 'entries', 'vault_cleanup', '2.enc');

    backend.store({
      material: 'first_secret',
      metadata: { ownerScope: 'server' },
      referenceId: 'vault_cleanup',
    });
    sealEncryptedFileVaultEntry({
      createdAt: '2026-07-05T01:10:00.000Z',
      masterKey,
      material: 'attributable_orphan_secret',
      metadata: { ownerScope: 'server' },
      referenceId: 'vault_cleanup',
      storeDir,
      version: 2,
      versionExpirations: {},
    } as never);

    expect(backend.revoke({ referenceId: 'vault_cleanup' })).toMatchObject({ revoked: true });
    expect(existsSync(firstEntryPath)).toBe(false);
    expect(existsSync(extraEntryPath)).toBe(false);
    expect(() => backend.resolve({ referenceId: 'vault_cleanup' })).toThrow('reference-revoked');
  });

  it('fails ordinary operations closed but explicit revoke cleans an exact complete entry temp', () => {
    const storeDir = mkdtempSync(join(tmpdir(), 'openkit-vault-backend-'));
    const masterKey = Buffer.alloc(32, 9);
    const timestamps = ['2026-07-05T01:00:00.000Z', '2026-07-05T01:20:00.000Z'];
    const backend = createEncryptedFileVaultBackend({
      masterKey,
      now: () => timestamps.shift() ?? '2026-07-05T01:20:00.000Z',
      storeDir,
    });
    const referenceDir = join(storeDir, 'entries', 'vault_complete_entry_temp');
    const firstEntryPath = join(referenceDir, '1.enc');
    const secondEntryPath = join(referenceDir, '2.enc');
    const entryTempPath = join(referenceDir, `.2.enc.${STALE_WRITER_PID}.tmp`);

    backend.store({
      material: 'first_secret',
      metadata: { ownerScope: 'server' },
      referenceId: 'vault_complete_entry_temp',
    });
    sealEncryptedFileVaultEntry({
      createdAt: '2026-07-05T01:10:00.000Z',
      masterKey,
      material: 'complete_temp_secret',
      metadata: { ownerScope: 'server' },
      referenceId: 'vault_complete_entry_temp',
      storeDir,
      version: 2,
      versionExpirations: { '1': '2026-07-05T01:11:00.000Z' },
    } as never);
    const completeEntry = readFileSync(secondEntryPath);
    rmSync(secondEntryPath);
    writeFileSync(entryTempPath, completeEntry, { mode: 0o600 });

    expect.soft(() => backend.listReferences()).toThrow('backend-unavailable');
    expect
      .soft(() => backend.resolve({ referenceId: 'vault_complete_entry_temp' }))
      .toThrow('backend-unavailable');

    const revoked = backend.revoke({ referenceId: 'vault_complete_entry_temp' });

    expect(revoked).toMatchObject({
      currentVersion: 2,
      referenceId: 'vault_complete_entry_temp',
      revoked: true,
      versionCount: 2,
    });
    expect(existsSync(firstEntryPath)).toBe(false);
    expect(existsSync(entryTempPath)).toBe(false);
    expect(existsSync(secondEntryPath)).toBe(false);
    expect(backend.listReferences()).toEqual([revoked]);
  });

  it('fails ordinary operations closed but explicit revoke cleans an exact complete state temp', () => {
    const storeDir = mkdtempSync(join(tmpdir(), 'openkit-vault-backend-'));
    const backend = createEncryptedFileVaultBackend({
      masterKey: Buffer.alloc(32, 9),
      now: () => '2026-07-05T01:00:00.000Z',
      storeDir,
    });
    const referenceDir = join(storeDir, 'entries', 'vault_complete_state_temp');
    const entryPath = join(referenceDir, '1.enc');
    const statePath = join(referenceDir, 'state.json');
    const stateTempPath = join(referenceDir, `.state.json.${STALE_WRITER_PID}.tmp`);

    backend.store({
      material: 'state_temp_secret',
      metadata: { ownerScope: 'server' },
      referenceId: 'vault_complete_state_temp',
    });
    writeFileSync(stateTempPath, readFileSync(statePath), { mode: 0o600 });

    expect.soft(() => backend.listReferences()).toThrow('backend-unavailable');
    expect
      .soft(() => backend.resolve({ referenceId: 'vault_complete_state_temp' }))
      .toThrow('backend-unavailable');

    const revoked = backend.revoke({ referenceId: 'vault_complete_state_temp' });

    expect(revoked).toMatchObject({
      referenceId: 'vault_complete_state_temp',
      revoked: true,
    });
    expect(existsSync(entryPath)).toBe(false);
    expect(existsSync(stateTempPath)).toBe(false);
    expect(backend.listReferences()).toEqual([revoked]);
  });

  it.each([
    'malformed',
    'unverifiable',
  ] as const)('leaves state and every file untouched for an exact %s entry temp', (corruption) => {
    const storeDir = mkdtempSync(join(tmpdir(), 'openkit-vault-backend-'));
    const backend = createEncryptedFileVaultBackend({
      masterKey: Buffer.alloc(32, 9),
      storeDir,
    });
    const referenceId = `vault_${corruption}_entry_temp`;
    const referenceDir = join(storeDir, 'entries', referenceId);
    const firstEntryPath = join(referenceDir, '1.enc');
    const entryTempPath = join(referenceDir, `.2.enc.${STALE_WRITER_PID}.tmp`);

    backend.store({
      material: 'must_remain_until_attribution_succeeds',
      metadata: { ownerScope: 'server' },
      referenceId,
    });

    if (corruption === 'malformed') {
      writeFileSync(entryTempPath, '{"formatVersion":', { mode: 0o600 });
    } else {
      const entry = JSON.parse(readFileSync(firstEntryPath, 'utf8')) as {
        associatedData: { version: number };
        version: number;
      };
      entry.version = 2;
      entry.associatedData.version = 2;
      writeFileSync(entryTempPath, `${JSON.stringify(entry, null, 2)}\n`, { mode: 0o600 });
    }

    const fileNamesBefore = readdirSync(referenceDir).sort();
    const filesBefore = fileNamesBefore.map(
      (fileName) => [fileName, readFileSync(join(referenceDir, fileName))] as const
    );

    expect.soft(() => backend.listReferences()).toThrow('backend-unavailable');
    expect.soft(() => backend.resolve({ referenceId })).toThrow('backend-unavailable');
    expect.soft(() => backend.revoke({ referenceId })).toThrow('backend-unavailable');

    expect(readdirSync(referenceDir).sort()).toEqual(fileNamesBefore);
    for (const [fileName, content] of filesBefore) {
      expect(readFileSync(join(referenceDir, fileName))).toEqual(content);
    }
  });

  it('does not mutate revocation state when discovered material is unverifiable', () => {
    const storeDir = mkdtempSync(join(tmpdir(), 'openkit-vault-backend-'));
    const backend = createEncryptedFileVaultBackend({ masterKey: Buffer.alloc(32, 9), storeDir });
    const referenceDir = join(storeDir, 'entries', 'vault_unverifiable');
    const statePath = join(referenceDir, 'state.json');
    const firstEntryPath = join(referenceDir, '1.enc');
    const malformedEntryPath = join(referenceDir, '2.enc');

    backend.store({
      material: 'first_secret',
      metadata: { ownerScope: 'server' },
      referenceId: 'vault_unverifiable',
    });
    writeFileSync(malformedEntryPath, '{"formatVersion":', { mode: 0o600 });
    const stateBefore = readFileSync(statePath, 'utf8');

    expect(() => backend.revoke({ referenceId: 'vault_unverifiable' })).toThrow(
      'backend-unavailable'
    );
    expect(readFileSync(statePath, 'utf8')).toBe(stateBefore);
    expect(existsSync(firstEntryPath)).toBe(true);
    expect(existsSync(malformedEntryPath)).toBe(true);
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
