import { describe, expect, it } from 'vitest';

import { VaultBackendError } from './vault-backend.js';
import {
  createOsKeychainVaultBackend,
  type OsKeychainVaultAdapter,
  type OsKeychainVaultItemInput,
} from './vault-os-keychain-backend.js';

describe('os-keychain vault backend', () => {
  it('uses Windows Credential Manager through PowerShell without secret argv leakage', () => {
    const execFileSync = createWindowsCredentialManagerExec();
    const backend = createOsKeychainVaultBackend({
      deploymentId: 'dev',
      execFileSync,
      now: () => '2026-07-05T01:00:00.000Z',
      platform: 'win32',
    });

    backend.store({
      material: 'windows_secret',
      metadata: { ownerScope: 'server' },
      referenceId: 'vault_windows',
    });

    expect(backend.health()).toEqual({
      diagnostic: 'os-keychain vault backend is available',
      kind: 'os-keychain',
      state: 'available',
    });
    expect(Buffer.from(backend.resolve({ referenceId: 'vault_windows' })).toString('utf8')).toBe(
      'windows_secret'
    );
    expect(JSON.stringify(execFileSync.calls.map((call) => call.args))).not.toContain(
      'windows_secret'
    );
    expect(
      execFileSync.calls.some((call) =>
        call.options?.input?.includes(Buffer.from('windows_secret').toString('base64'))
      )
    ).toBe(true);

    backend.revoke({ referenceId: 'vault_windows' });

    expect(() => backend.resolve({ referenceId: 'vault_windows' })).toThrow('reference-revoked');
  });

  it('uses Linux Secret Service through secret-tool when platform is linux', () => {
    const execFileSync = createSecretToolExec();
    const backend = createOsKeychainVaultBackend({
      deploymentId: 'dev',
      execFileSync,
      now: () => '2026-07-05T01:00:00.000Z',
      platform: 'linux',
    });

    backend.store({
      material: 'linux_secret',
      metadata: { ownerScope: 'server' },
      referenceId: 'vault_linux',
    });

    expect(backend.health()).toEqual({
      diagnostic: 'os-keychain vault backend is available',
      kind: 'os-keychain',
      state: 'available',
    });
    expect(Buffer.from(backend.resolve({ referenceId: 'vault_linux' })).toString('utf8')).toBe(
      'linux_secret'
    );

    backend.revoke({ referenceId: 'vault_linux' });

    expect(() => backend.resolve({ referenceId: 'vault_linux' })).toThrow('reference-revoked');
  });

  it('stores, resolves, and lists material through the keychain adapter', () => {
    const adapter = new MemoryKeychainAdapter();
    const backend = createOsKeychainVaultBackend({
      adapter,
      deploymentId: 'dev',
      now: () => '2026-07-05T01:00:00.000Z',
    });

    const inventory = backend.store({
      material: 'ghp_live_secret',
      metadata: {
        ownerScope: 'workspace',
        workspaceId: 'ws_1',
      },
      referenceId: 'vault_github',
    });
    const resolved = backend.resolve({ referenceId: 'vault_github' });

    expect(inventory).toEqual({
      backendKind: 'os-keychain',
      currentVersion: 1,
      ownerScope: 'workspace',
      referenceId: 'vault_github',
      revoked: false,
      updatedAt: '2026-07-05T01:00:00.000Z',
      versionCount: 1,
      workspaceId: 'ws_1',
    });
    expect(Buffer.from(resolved).toString('utf8')).toBe('ghp_live_secret');
    expect(backend.listReferences()).toEqual([inventory]);
    expect(backend.listReferences({ ownerScope: 'server' })).toEqual([]);
    expect(adapter.item('openkit.dev.vault', '__index__')).not.toContain('ghp_live_secret');
    expect(backend.health()).toEqual({
      diagnostic: 'os-keychain vault backend is available',
      kind: 'os-keychain',
      state: 'available',
    });
  });

  it('rotates current material, expires prior versions, and revokes every version', () => {
    const adapter = new MemoryKeychainAdapter();
    const timestamps = [
      '2026-07-05T01:00:00.000Z',
      '2026-07-05T01:10:00.000Z',
      '2026-07-05T01:10:30.000Z',
      '2026-07-05T01:11:01.000Z',
      '2026-07-05T01:20:00.000Z',
    ];
    const backend = createOsKeychainVaultBackend({
      adapter,
      deploymentId: 'dev',
      now: () => timestamps.shift() ?? '2026-07-05T01:30:00.000Z',
      rotationGraceMs: 60_000,
    });

    backend.store({
      material: 'first_secret',
      metadata: { ownerScope: 'server' },
      referenceId: 'vault_github',
    });

    const rotated = backend.rotate({ material: 'second_secret', referenceId: 'vault_github' });

    expect(rotated).toMatchObject({
      currentVersion: 2,
      referenceId: 'vault_github',
      updatedAt: '2026-07-05T01:10:00.000Z',
      versionCount: 2,
    });
    expect(Buffer.from(backend.resolve({ referenceId: 'vault_github' })).toString('utf8')).toBe(
      'second_secret'
    );
    expect(
      Buffer.from(backend.resolve({ referenceId: 'vault_github', version: 1 })).toString('utf8')
    ).toBe('first_secret');
    expect(() => backend.resolve({ referenceId: 'vault_github', version: 1 })).toThrow(
      'version-expired'
    );

    const revoked = backend.revoke({ referenceId: 'vault_github' });

    expect(revoked).toMatchObject({
      currentVersion: 2,
      referenceId: 'vault_github',
      revoked: true,
      updatedAt: '2026-07-05T01:20:00.000Z',
      versionCount: 2,
    });
    expect(adapter.item('openkit.dev.vault', 'vault_github')).toBeNull();
    expect(() => backend.resolve({ referenceId: 'vault_github' })).toThrow('reference-revoked');
  });

  it('fails unavailable adapters and duplicate stores with typed redacted errors', () => {
    const adapter = new MemoryKeychainAdapter({ available: false });
    const backend = createOsKeychainVaultBackend({
      adapter,
      deploymentId: 'dev',
      now: () => '2026-07-05T01:00:00.000Z',
    });

    expect(backend.health()).toEqual({
      diagnostic: 'keychain unavailable',
      kind: 'os-keychain',
      state: 'unavailable',
    });
    expect(() => backend.resolve({ referenceId: 'vault_missing' })).toThrow(VaultBackendError);
    expect(() => backend.resolve({ referenceId: 'vault_missing' })).toThrow('backend-unavailable');

    const availableBackend = createOsKeychainVaultBackend({
      adapter: new MemoryKeychainAdapter(),
      deploymentId: 'dev',
      now: () => '2026-07-05T01:00:00.000Z',
    });

    availableBackend.store({
      material: 'ghp_live_secret',
      metadata: { ownerScope: 'server' },
      referenceId: 'vault_github',
    });

    try {
      availableBackend.store({
        material: 'changed_secret',
        metadata: { ownerScope: 'server' },
        referenceId: 'vault_github',
      });
    } catch (error) {
      expect(error).toBeInstanceOf(VaultBackendError);
      expect(String(error)).not.toContain('changed_secret');
      return;
    }

    throw new Error('Expected duplicate os-keychain store to fail.');
  });

  it('rejects inconsistent owner metadata before storing material', () => {
    const adapter = new MemoryKeychainAdapter();
    const backend = createOsKeychainVaultBackend({
      adapter,
      deploymentId: 'dev',
      now: () => '2026-07-05T01:00:00.000Z',
    });

    expect(() =>
      backend.store({
        material: 'ghp_live_secret',
        metadata: { ownerScope: 'user', workspaceId: 'ws_1' },
        referenceId: 'vault_github',
      })
    ).toThrow('backend-unavailable: Vault entry metadata does not match its owner scope.');
    expect(adapter.item('openkit.dev.vault', 'vault_github')).toBeNull();
  });
});

type ExecFileSync = typeof import('node:child_process').execFileSync;

function createWindowsCredentialManagerExec(): ExecFileSync & {
  calls: Array<{ file: string; args: string[]; options?: { input?: string } }>;
} {
  const calls: Array<{ file: string; args: string[]; options?: { input?: string } }> = [];
  const items = new Map<string, string>();
  const exec = ((file: string, args: string[], options?: { input?: string }) => {
    calls.push({ args, file, options });
    expect(file).toBe('powershell.exe');

    if (args[5]?.includes('$PSVersionTable')) {
      return '';
    }

    const service = args.at(-2) ?? '';
    const account = args.at(-1) ?? '';
    const key = `${service}:${account}`;
    const script = args[5] ?? '';

    if (script.includes('CredWriteW')) {
      items.set(key, options?.input ?? '');
      return '';
    }
    if (script.includes('CredReadW')) {
      const value = items.get(key);

      if (value === undefined) {
        throw new Error('missing credential');
      }

      return value;
    }
    if (script.includes('CredDeleteW')) {
      items.delete(key);
      return '';
    }

    throw new Error(`unexpected PowerShell command: ${args.join(' ')}`);
  }) as ExecFileSync & {
    calls: Array<{ file: string; args: string[]; options?: { input?: string } }>;
  };
  exec.calls = calls;

  return exec;
}

function createSecretToolExec(): ExecFileSync {
  const items = new Map<string, string>();

  return ((file: string, args: string[], options?: { input?: string | Buffer }) => {
    expect(file).toBe('secret-tool');

    if (args[0] === '--version') {
      return '';
    }

    const key = secretToolKey(args);

    if (args[0] === 'store') {
      items.set(key, String(options?.input ?? ''));
      return '';
    }
    if (args[0] === 'lookup') {
      const value = items.get(key);

      if (value === undefined) {
        throw new Error('missing secret');
      }

      return value;
    }
    if (args[0] === 'clear') {
      items.delete(key);
      return '';
    }

    throw new Error(`unexpected secret-tool command: ${args.join(' ')}`);
  }) as ExecFileSync;
}

function secretToolKey(args: string[]): string {
  const serviceIndex = args.indexOf('openkit-service');
  const accountIndex = args.indexOf('openkit-account');

  return `${args[serviceIndex + 1]}:${args[accountIndex + 1]}`;
}

class MemoryKeychainAdapter implements OsKeychainVaultAdapter {
  private readonly available: boolean;
  private readonly items = new Map<string, string>();

  public constructor(options: { available?: boolean } = {}) {
    this.available = options.available ?? true;
  }

  public health(): ReturnType<OsKeychainVaultAdapter['health']> {
    return this.available
      ? { diagnostic: 'memory keychain available', state: 'available' }
      : { diagnostic: 'keychain unavailable', state: 'unavailable' };
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

  public item(service: string, account: string): string | null {
    return this.items.get(`${service}:${account}`) ?? null;
  }

  private key(input: OsKeychainVaultItemInput): string {
    return `${input.service}:${input.account}`;
  }
}
