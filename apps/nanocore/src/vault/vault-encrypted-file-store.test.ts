// openkit-test-platform: posix
import { lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  initializeOrVerifyEncryptedFileVaultStore,
  openEncryptedFileVaultEntry,
  readEncryptedFileVaultEntry,
  sealEncryptedFileVaultEntry,
  writeEncryptedFileVaultEntry,
} from './vault-encrypted-file-store.js';

const durability = vi.hoisted(() => ({
  paths: new Map<number, string>(),
  events: [] as Array<{
    op: 'sync' | 'rename';
    path: string;
    from?: string;
    directory?: boolean;
    mode?: number;
  }>,
  fail: undefined as ((path: string, directory: boolean) => boolean) | undefined,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    openSync: ((...args: Parameters<typeof actual.openSync>) => {
      const descriptor = actual.openSync(...args);
      durability.paths.set(descriptor, String(args[0]));
      return descriptor;
    }) as typeof actual.openSync,
    closeSync: ((descriptor: number) => {
      durability.paths.delete(descriptor);
      return actual.closeSync(descriptor);
    }) as typeof actual.closeSync,
    fsyncSync: ((descriptor: number) => {
      const path = durability.paths.get(descriptor) ?? '<untracked>';
      const directory = actual.fstatSync(descriptor).isDirectory();
      durability.events.push({
        op: 'sync',
        path,
        directory,
        mode: actual.fstatSync(descriptor).mode & 0o777,
      });
      if (durability.fail?.(path, directory)) throw new Error('Injected publication sync failure');
      return actual.fsyncSync(descriptor);
    }) as typeof actual.fsyncSync,
    renameSync: ((
      from: Parameters<typeof actual.renameSync>[0],
      to: Parameters<typeof actual.renameSync>[1]
    ) => {
      durability.events.push({ op: 'rename', from: String(from), path: String(to) });
      return actual.renameSync(from, to);
    }) as typeof actual.renameSync,
  };
});

const TEST_CIPHERTEXT = Buffer.from('ciphertext').toString('base64');
const TEST_DATA_KEY = Buffer.alloc(32, 1).toString('base64');
const TEST_NONCE = Buffer.alloc(12, 2).toString('base64');
const TEST_TAG = Buffer.alloc(16, 3).toString('base64');

describe('encrypted-file vault store format', () => {
  it('writes and reads a non-secret entry envelope with owner-only files', () => {
    const storeDir = mkdtempSync(join(tmpdir(), 'openkit-vault-store-format-'));

    const entry = writeEncryptedFileVaultEntry({
      ciphertext: TEST_CIPHERTEXT,
      createdAt: '2026-07-05T00:05:00.000Z',
      dataKey: {
        algorithm: 'aes-256-gcm',
        nonce: TEST_NONCE,
        tag: TEST_TAG,
        wrapped: TEST_DATA_KEY,
      },
      metadata: {
        ownerScope: 'workspace',
        workspaceId: 'ws_00000000-0000-73c3-900f-8d310e4ba201',
      },
      nonce: TEST_NONCE,
      referenceId: 'vault_00000000-0000-7f73-bffa-d96a61ee4d70',
      storeDir,
      tag: TEST_TAG,
      version: 1,
    });

    expect(entry).toEqual(
      readEncryptedFileVaultEntry({
        referenceId: 'vault_00000000-0000-7f73-bffa-d96a61ee4d70',
        storeDir,
        version: 1,
      })
    );
    expect(entry).toMatchObject({
      associatedData: {
        referenceId: 'vault_00000000-0000-7f73-bffa-d96a61ee4d70',
        version: 1,
      },
      referenceId: 'vault_00000000-0000-7f73-bffa-d96a61ee4d70',
      version: 1,
    });
    expect(
      lstatSync(join(storeDir, 'entries', 'vault_00000000-0000-7f73-bffa-d96a61ee4d70', '1.enc'))
        .mode & 0o777
    ).toBe(0o600);
    expect(
      readFileSync(
        join(storeDir, 'entries', 'vault_00000000-0000-7f73-bffa-d96a61ee4d70', '1.enc'),
        'utf8'
      )
    ).not.toContain('ghp_live_secret');
  });

  it('rejects unsafe reference ids before writing entry files', () => {
    const storeDir = mkdtempSync(join(tmpdir(), 'openkit-vault-store-format-'));

    expect(() =>
      writeEncryptedFileVaultEntry({
        ciphertext: TEST_CIPHERTEXT,
        createdAt: '2026-07-05T00:05:00.000Z',
        dataKey: {
          algorithm: 'aes-256-gcm',
          nonce: TEST_NONCE,
          tag: TEST_TAG,
          wrapped: TEST_DATA_KEY,
        },
        metadata: {
          ownerScope: 'server',
        },
        nonce: TEST_NONCE,
        referenceId: '../vault_00000000-0000-7f73-bffa-d96a61ee4d70',
        storeDir,
        tag: TEST_TAG,
        version: 1,
      })
    ).toThrow('Vault reference id is not safe for encrypted-file store paths.');
  });

  it('rejects entry envelopes whose associated data does not match the path', () => {
    const storeDir = mkdtempSync(join(tmpdir(), 'openkit-vault-store-format-'));
    const entryPath = join(
      storeDir,
      'entries',
      'vault_00000000-0000-7f73-bffa-d96a61ee4d70',
      '1.enc'
    );

    writeEncryptedFileVaultEntry({
      ciphertext: TEST_CIPHERTEXT,
      createdAt: '2026-07-05T00:05:00.000Z',
      dataKey: {
        algorithm: 'aes-256-gcm',
        nonce: TEST_NONCE,
        tag: TEST_TAG,
        wrapped: TEST_DATA_KEY,
      },
      metadata: {
        ownerScope: 'server',
      },
      nonce: TEST_NONCE,
      referenceId: 'vault_00000000-0000-7f73-bffa-d96a61ee4d70',
      storeDir,
      tag: TEST_TAG,
      version: 1,
    });

    const envelope = JSON.parse(readFileSync(entryPath, 'utf8')) as {
      associatedData: { version: number };
    };
    envelope.associatedData.version = 2;
    writeFileSync(entryPath, `${JSON.stringify(envelope, null, 2)}\n`, { mode: 0o600 });

    expect(() =>
      readEncryptedFileVaultEntry({
        referenceId: 'vault_00000000-0000-7f73-bffa-d96a61ee4d70',
        storeDir,
        version: 1,
      })
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
        workspaceId: 'ws_00000000-0000-73c3-900f-8d310e4ba201',
      },
      referenceId: 'vault_00000000-0000-7f73-bffa-d96a61ee4d70',
      storeDir,
      version: 1,
    });
    const entryFile = readFileSync(
      join(storeDir, 'entries', 'vault_00000000-0000-7f73-bffa-d96a61ee4d70', '1.enc'),
      'utf8'
    );
    const opened = openEncryptedFileVaultEntry({
      masterKey,
      referenceId: 'vault_00000000-0000-7f73-bffa-d96a61ee4d70',
      storeDir,
      version: 1,
    });

    expect(Buffer.from(opened).toString('utf8')).toBe('ghp_live_secret');
    expect(entry.ciphertext).not.toContain('ghp_live_secret');
    expect(entryFile).not.toContain('ghp_live_secret');
    expect(entry.algorithm).toBe('aes-256-gcm');
  });

  it('zeroes successful GCM update and final buffers after copying the plaintext result', () => {
    const storeDir = mkdtempSync(join(tmpdir(), 'openkit-vault-store-zeroize-'));
    const masterKey = Buffer.alloc(32, 7);
    const material = Buffer.from('payload with a unique non-key-sized plaintext buffer');

    sealEncryptedFileVaultEntry({
      createdAt: '2026-07-05T00:10:00.000Z',
      masterKey,
      material,
      metadata: { ownerScope: 'server' },
      referenceId: 'vault_00000000-0000-7f4d-8c03-bd56943c9b98',
      storeDir,
      version: 1,
    });

    const fillSpy = vi.spyOn(Buffer.prototype, 'fill');

    try {
      const opened = openEncryptedFileVaultEntry({
        masterKey,
        referenceId: 'vault_00000000-0000-7f4d-8c03-bd56943c9b98',
        storeDir,
        version: 1,
      });
      const filledBuffers = fillSpy.mock.instances.filter((value) => Buffer.isBuffer(value));

      expect(Buffer.from(opened)).toEqual(material);
      expect
        .soft(
          filledBuffers.some(
            (value) => value.byteLength === material.byteLength && value.every((byte) => byte === 0)
          )
        )
        .toBe(true);
      expect
        .soft(
          new Set(
            filledBuffers.filter(
              (value) => value.byteLength === 32 && value.every((byte) => byte === 0)
            )
          ).size
        )
        .toBeGreaterThanOrEqual(2);
      expect
        .soft(filledBuffers.filter((value) => value.byteLength === 0).length)
        .toBeGreaterThanOrEqual(2);
    } finally {
      fillSpy.mockRestore();
    }
  });

  it('zeroes the GCM update plaintext when final authentication rejects a tampered tag', () => {
    const storeDir = mkdtempSync(join(tmpdir(), 'openkit-vault-store-zeroize-'));
    const masterKey = Buffer.alloc(32, 7);
    const material = Buffer.from('tampered payload with a unique non-key-sized plaintext buffer');
    const entryPath = join(
      storeDir,
      'entries',
      'vault_00000000-0000-752b-836f-f18a3fd6723e',
      '1.enc'
    );

    sealEncryptedFileVaultEntry({
      createdAt: '2026-07-05T00:10:00.000Z',
      masterKey,
      material,
      metadata: { ownerScope: 'server' },
      referenceId: 'vault_00000000-0000-752b-836f-f18a3fd6723e',
      storeDir,
      version: 1,
    });

    const envelope = JSON.parse(readFileSync(entryPath, 'utf8')) as { tag: string };
    envelope.tag = Buffer.alloc(16, 0x7e).toString('base64');
    writeFileSync(entryPath, `${JSON.stringify(envelope, null, 2)}\n`, { mode: 0o600 });
    const fillSpy = vi.spyOn(Buffer.prototype, 'fill');

    try {
      expect(() =>
        openEncryptedFileVaultEntry({
          masterKey,
          referenceId: 'vault_00000000-0000-752b-836f-f18a3fd6723e',
          storeDir,
          version: 1,
        })
      ).toThrow('Encrypted-file vault entry failed authentication.');

      const filledBuffers = fillSpy.mock.instances.filter((value) => Buffer.isBuffer(value));
      expect
        .soft(
          filledBuffers.some(
            (value) => value.byteLength === material.byteLength && value.every((byte) => byte === 0)
          )
        )
        .toBe(true);
      expect
        .soft(
          new Set(
            filledBuffers.filter(
              (value) => value.byteLength === 32 && value.every((byte) => byte === 0)
            )
          ).size
        )
        .toBeGreaterThanOrEqual(2);
      expect.soft(filledBuffers.some((value) => value.byteLength === 0)).toBe(true);
    } finally {
      fillSpy.mockRestore();
    }
  });

  it.each([
    ['top-level', 'createdAt'],
    ['top-level', 'owner metadata'],
    ['associated-data', 'createdAt'],
    ['associated-data', 'owner metadata'],
    ['associated-data', 'version expirations'],
    ['associated-data', 'provider account'],
  ] as const)('rejects entry %s %s tampering', (location, corruption) => {
    const storeDir = mkdtempSync(join(tmpdir(), 'openkit-vault-store-format-'));
    const masterKey = Buffer.alloc(32, 7);
    const entryPath = join(
      storeDir,
      'entries',
      'vault_00000000-0000-74a6-9dc6-af55fa43eb8f',
      '1.enc'
    );

    sealEncryptedFileVaultEntry({
      createdAt: '2026-07-05T00:10:00.000Z',
      masterKey,
      material: Buffer.from('subscription_secret'),
      metadata: {
        ownerScope: 'server',
        providerSubscriptionAccount: {
          accountSlotId: 'slot_1',
          subscriptionProviderId: 'openai-codex',
        },
      },
      referenceId: 'vault_00000000-0000-74a6-9dc6-af55fa43eb8f',
      storeDir,
      version: 1,
      versionExpirations: {},
    } as never);

    const envelope = JSON.parse(readFileSync(entryPath, 'utf8')) as Record<string, unknown>;
    const associatedData = envelope.associatedData as Record<string, unknown>;
    const target = location === 'top-level' ? envelope : associatedData;

    if (corruption === 'createdAt') {
      target.createdAt = '2026-07-05T00:10:01.000Z';
    } else if (corruption === 'owner metadata') {
      target.metadata = {
        ownerScope: 'workspace',
        workspaceId: 'ws_00000000-0000-71f5-922f-6fd42f52f580',
      };
    } else if (corruption === 'version expirations') {
      target.versionExpirations = { '1': '2026-07-05T00:20:00.000Z' };
    } else {
      target.metadata = {
        ownerScope: 'server',
        providerSubscriptionAccount: {
          accountSlotId: 'slot_2',
          subscriptionProviderId: 'openai-codex',
        },
      };
    }

    writeFileSync(entryPath, `${JSON.stringify(envelope, null, 2)}\n`, { mode: 0o600 });

    if (location === 'top-level') {
      expect
        .soft(() =>
          readEncryptedFileVaultEntry({
            referenceId: 'vault_00000000-0000-74a6-9dc6-af55fa43eb8f',
            storeDir,
            version: 1,
          })
        )
        .toThrow();
    }
    expect(() =>
      openEncryptedFileVaultEntry({
        masterKey,
        referenceId: 'vault_00000000-0000-74a6-9dc6-af55fa43eb8f',
        storeDir,
        version: 1,
      })
    ).toThrow();
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
      referenceId: 'vault_00000000-0000-7f73-bffa-d96a61ee4d70',
      storeDir,
      version: 1,
    });

    expect(() =>
      openEncryptedFileVaultEntry({
        masterKey: Buffer.alloc(32, 8),
        referenceId: 'vault_00000000-0000-7f73-bffa-d96a61ee4d70',
        storeDir,
        version: 1,
      })
    ).toThrow('Encrypted-file vault entry failed authentication.');
  });

  it('zeroes generated data keys after successful and failed seals', () => {
    const storeDir = mkdtempSync(join(tmpdir(), 'openkit-vault-store-format-'));
    const successfulDataKey = Buffer.alloc(32, 23);
    let successfulRandomCall = 0;

    sealEncryptedFileVaultEntry({
      createdAt: '2026-07-05T00:10:00.000Z',
      masterKey: Buffer.alloc(32, 7),
      material: Buffer.from('ghp_live_secret'),
      metadata: { ownerScope: 'server' },
      randomBytes: (size) => {
        successfulRandomCall += 1;
        return successfulRandomCall === 1
          ? successfulDataKey
          : Buffer.alloc(size, successfulRandomCall);
      },
      referenceId: 'vault_00000000-0000-7f73-bffa-d96a61ee4d70',
      storeDir,
      version: 1,
    });

    expect(successfulDataKey).toEqual(Buffer.alloc(32));

    const failedDataKey = Buffer.alloc(32, 29);
    let failedRandomCall = 0;

    expect(() =>
      sealEncryptedFileVaultEntry({
        createdAt: '2026-07-05T00:10:00.000Z',
        masterKey: Buffer.alloc(32, 7),
        material: Buffer.from('ghp_live_secret'),
        metadata: { ownerScope: 'server' },
        randomBytes: () => {
          failedRandomCall += 1;

          if (failedRandomCall === 1) {
            return failedDataKey;
          }

          throw new Error('test random source failed');
        },
        referenceId: 'vault_00000000-0000-700c-bea5-82e3edf5f857',
        storeDir,
        version: 1,
      })
    ).toThrow('test random source failed');
    expect(failedDataKey).toEqual(Buffer.alloc(32));
  });
});

describe('uncommitted header initialization recovery', () => {
  it('rejects repeated initialization until the authenticated header directory entry synchronizes', () => {
    const storeDir = mkdtempSync(join(tmpdir(), 'openkit-vault-header-sync-retry-'));
    const masterKey = Buffer.alloc(32, 7);
    const input = { storeDir, masterKey };
    const header = join(storeDir, 'header.json');
    durability.events.length = 0;
    durability.fail = (path, directory) =>
      directory &&
      path === storeDir &&
      durability.events.some((event) => event.op === 'rename' && event.path === header);
    try {
      expect(() => initializeOrVerifyEncryptedFileVaultStore(input)).toThrow(
        'Encrypted-file vault file could not be written securely.'
      );
      const retainedHeader = readFileSync(header);
      expect(lstatSync(header).mode & 0o777).toBe(0o600);
      durability.events.length = 0;
      durability.fail = (path, directory) => directory && path === storeDir;
      expect(() => initializeOrVerifyEncryptedFileVaultStore(input)).toThrow(
        'Encrypted-file vault file could not be written securely.'
      );
      expect(readFileSync(header)).toEqual(retainedHeader);
      expect(durability.events.some((event) => event.op === 'rename')).toBe(false);
      durability.events.length = 0;
      durability.fail = undefined;
      expect(initializeOrVerifyEncryptedFileVaultStore(input)).toBe(storeDir);
      expect(readFileSync(header)).toEqual(retainedHeader);
      expect(
        durability.events.some(
          (event) => event.op === 'sync' && event.directory && event.path === storeDir
        )
      ).toBe(true);
      expect(() =>
        initializeOrVerifyEncryptedFileVaultStore({ storeDir, masterKey: Buffer.alloc(32, 8) })
      ).toThrow('Encrypted-file vault master key failed authentication.');
      const recoveredReferenceId = 'vault_00000000-0000-7000-8000-0000000000aa';
      sealEncryptedFileVaultEntry({
        createdAt: '2026-07-05T00:10:00.000Z',
        masterKey,
        material: Buffer.from('retained test material'),
        metadata: { ownerScope: 'server' },
        referenceId: recoveredReferenceId,
        storeDir,
        version: 1,
      });
      expect(
        Buffer.from(
          openEncryptedFileVaultEntry({
            storeDir,
            referenceId: recoveredReferenceId,
            version: 1,
            masterKey,
          })
        ).toString('utf8')
      ).toBe('retained test material');
    } finally {
      durability.fail = undefined;
      masterKey.fill(0);
      rmSync(storeDir, { recursive: true, force: true });
    }
  });
});
