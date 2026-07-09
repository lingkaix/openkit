import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createDefaultNanoCoreCredentialStore,
  normalizeStoredNanoCoreToken,
} from './credential-store.js';

describe('NanoCore credential store', () => {
  it('normalizes only OpenKit access tokens', () => {
    expect(normalizeStoredNanoCoreToken(' okt_secret \n')).toBe('okt_secret');
    expect(normalizeStoredNanoCoreToken('Bearer okt_secret')).toBeNull();
    expect(normalizeStoredNanoCoreToken('')).toBeNull();
  });

  it('reads macOS Keychain generic passwords by NanoCore URL', () => {
    const calls: Array<{ args: string[]; command: string }> = [];
    const store = createDefaultNanoCoreCredentialStore({
      execFile: ((command: string, args: string[]) => {
        calls.push({ args, command });
        return 'okt_macos_secret\n';
      }) as never,
      platform: 'darwin',
    });

    expect(store.readNanoCoreToken({ baseUrl: 'https://nanocore.example.test/' })).toBe(
      'okt_macos_secret'
    );
    expect(calls).toEqual([
      {
        args: [
          'find-generic-password',
          '-s',
          'openkit.nanocore.token',
          '-a',
          'https://nanocore.example.test/',
          '-w',
        ],
        command: 'security',
      },
    ]);
  });

  it('reads Linux Secret Service entries by NanoCore URL', () => {
    const calls: Array<{ args: string[]; command: string }> = [];
    const store = createDefaultNanoCoreCredentialStore({
      execFile: ((command: string, args: string[]) => {
        calls.push({ args, command });
        return 'okt_linux_secret\n';
      }) as never,
      platform: 'linux',
    });

    expect(store.readNanoCoreToken({ baseUrl: 'https://nanocore.example.test/' })).toBe(
      'okt_linux_secret'
    );
    expect(calls).toEqual([
      {
        args: [
          'lookup',
          'application',
          'openkit',
          'nanocore-url',
          'https://nanocore.example.test/',
        ],
        command: 'secret-tool',
      },
    ]);
  });

  it('writes Linux Secret Service entries through stdin without secret argv', () => {
    const calls: Array<{ args: string[]; command: string; input?: string }> = [];
    const store = createDefaultNanoCoreCredentialStore({
      execFile: ((command: string, args: string[], options?: { input?: string }) => {
        calls.push({ args, command, input: options?.input });
        return '';
      }) as never,
      platform: 'linux',
    });

    expect(
      store.writeNanoCoreToken?.({
        baseUrl: 'https://nanocore.example.test/',
        token: 'okt_linux_secret',
      })
    ).toBe('os-keychain');
    expect(calls).toEqual([
      {
        args: [
          'store',
          '--label',
          'OpenKit NanoCore token',
          'application',
          'openkit',
          'nanocore-url',
          'https://nanocore.example.test/',
        ],
        command: 'secret-tool',
        input: 'okt_linux_secret',
      },
    ]);
    expect(calls[0]?.args.join(' ')).not.toContain('okt_linux_secret');
  });

  it('reads Windows Credential Manager entries by NanoCore URL without secret argv', () => {
    const calls: Array<{ args: string[]; command: string }> = [];
    const store = createDefaultNanoCoreCredentialStore({
      execFile: ((command: string, args: string[]) => {
        calls.push({ args, command });
        return 'okt_windows_secret\n';
      }) as never,
      platform: 'win32',
    });

    expect(store.readNanoCoreToken({ baseUrl: 'https://nanocore.example.test/' })).toBe(
      'okt_windows_secret'
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe('powershell.exe');
    expect(calls[0]?.args.slice(0, 5)).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
    ]);
    expect(calls[0]?.args.slice(-2)).toEqual([
      'openkit.nanocore.token',
      'https://nanocore.example.test/',
    ]);
    expect(calls[0]?.args.join(' ')).not.toContain('okt_windows_secret');
  });

  it('writes Windows Credential Manager entries through stdin without secret argv', () => {
    const calls: Array<{ args: string[]; command: string; input?: string }> = [];
    const store = createDefaultNanoCoreCredentialStore({
      execFile: ((command: string, args: string[], options?: { input?: string }) => {
        calls.push({ args, command, input: options?.input });
        return '';
      }) as never,
      platform: 'win32',
    });

    expect(
      store.writeNanoCoreToken?.({
        baseUrl: 'https://nanocore.example.test/',
        token: 'okt_windows_secret',
      })
    ).toBe('os-keychain');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe('powershell.exe');
    expect(calls[0]?.args.slice(0, 5)).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
    ]);
    expect(calls[0]?.args.slice(-2)).toEqual([
      'openkit.nanocore.token',
      'https://nanocore.example.test/',
    ]);
    expect(calls[0]?.input).toBe('okt_windows_secret');
    expect(calls[0]?.args.join(' ')).not.toContain('okt_windows_secret');
  });

  it('writes macOS tokens to encrypted fallback with a degraded-storage warning', () => {
    const configDir = mkdtempSync(join(tmpdir(), 'openkit-mcp-credentials-darwin-'));
    const warnings: string[] = [];

    try {
      const store = createDefaultNanoCoreCredentialStore({
        configDir,
        execFile: (() => {
          throw new Error('keychain write should not use secret argv');
        }) as never,
        machineId: 'machine-for-darwin-test',
        platform: 'darwin',
        warn: (message) => warnings.push(message),
      });

      expect(
        store.writeNanoCoreToken?.({
          baseUrl: 'https://nanocore.example.test/',
          token: 'okt_darwin_secret',
        })
      ).toBe('encrypted-file');
      expect(warnings).toEqual([
        'OpenKit MCP is using encrypted-file NanoCore token storage because no OS keychain token was available.',
      ]);

      const credentialRoot = join(configDir, 'credentials', 'nanocore');
      const files = readdirSync(credentialRoot);
      expect(files).toHaveLength(1);
      expect(readFileSync(join(credentialRoot, files[0]!), 'utf8')).not.toContain(
        'okt_darwin_secret'
      );
    } finally {
      rmSync(configDir, { force: true, recursive: true });
    }
  });

  it('returns null when the platform store is unavailable', () => {
    const store = createDefaultNanoCoreCredentialStore({
      execFile: (() => {
        throw new Error('missing keychain');
      }) as never,
      platform: 'darwin',
    });

    expect(store.readNanoCoreToken({ baseUrl: 'https://nanocore.example.test/' })).toBeNull();
  });

  it('stores and reads encrypted fallback tokens without plaintext file material', () => {
    const configDir = mkdtempSync(join(tmpdir(), 'openkit-mcp-credentials-'));
    const warnings: string[] = [];

    try {
      const store = createDefaultNanoCoreCredentialStore({
        configDir,
        execFile: (() => {
          throw new Error('missing keychain');
        }) as never,
        machineId: 'machine-for-test',
        platform: 'linux',
        warn: (message) => warnings.push(message),
      });

      expect(
        store.writeNanoCoreToken?.({
          baseUrl: 'https://nanocore.example.test/',
          token: 'okt_fallback_secret',
        })
      ).toBe('encrypted-file');
      expect(store.readNanoCoreToken({ baseUrl: 'https://nanocore.example.test/' })).toBe(
        'okt_fallback_secret'
      );
      expect(warnings).toEqual([
        'OpenKit MCP is using encrypted-file NanoCore token storage because no OS keychain token was available.',
      ]);

      const credentialRoot = join(configDir, 'credentials', 'nanocore');
      const files = readdirSync(credentialRoot);
      expect(files).toHaveLength(1);
      expect(readFileSync(join(credentialRoot, files[0]!), 'utf8')).not.toContain(
        'okt_fallback_secret'
      );
    } finally {
      rmSync(configDir, { force: true, recursive: true });
    }
  });
});
