import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { JsonRpcNotification } from '../runtime/codex/protocol.js';
import type { CodexAccountClient } from './codex-oauth.js';
import {
  CODEX_OAUTH_DEFAULT_ACCOUNT_SLOT_ID,
  CodexOAuthAccountManager,
} from './codex-oauth-accounts.js';

class FakeCodexAccountClient implements CodexAccountClient {
  public readonly requests: Array<{ method: string; params: unknown }> = [];
  public account = { account: null, requiresOpenaiAuth: true };
  private readonly listeners = new Set<(message: JsonRpcNotification) => void>();

  /**
   * Handles one fake Codex app-server request.
   *
   * @param method JSON-RPC method name.
   * @param params JSON-RPC params.
   * @returns Fake method response.
   */
  public async request<TResult>(method: string, params: unknown): Promise<TResult> {
    this.requests.push({ method, params });

    if (method === 'account/read') {
      return this.account as TResult;
    }

    if (method === 'account/login/start') {
      return {
        authUrl: 'https://chatgpt.com/auth/codex/login',
        loginId: 'login_browser',
        type: 'chatgpt',
      } as TResult;
    }

    if (method === 'account/login/cancel') {
      return { status: 'canceled' } as TResult;
    }

    if (method === 'account/logout') {
      this.account = { account: null, requiresOpenaiAuth: true };
      return {} as TResult;
    }

    throw new Error(`Unexpected request: ${method}`);
  }

  /**
   * Registers a fake notification listener.
   *
   * @param listener Notification listener.
   * @returns Unsubscribe callback.
   */
  public onNotification(listener: (message: JsonRpcNotification) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Closes the fake client.
   *
   * @returns Resolved close operation.
   */
  public async close(): Promise<void> {}
}

describe('Codex OAuth account slots', () => {
  it('creates account metadata and an isolated Codex home under DATA_ROOT/server/files', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-codex-slots-'));
    const manager = new CodexOAuthAccountManager({
      dataRoot,
      now: () => '2026-05-26T00:00:00.000Z',
      resolveBoundProviderIds: (slotId) => (slotId === 'team_a' ? ['codex-team-a'] : []),
      resolveDefaultAccountSlotId: () => 'team_a',
    });

    await manager.createAccount({ accountSlotId: 'team_a', displayName: 'Team A' });
    const accountRoot = join(
      dataRoot,
      'server',
      'files',
      'oauth',
      'openai-codex',
      'accounts',
      'team_a'
    );
    const accountJson = JSON.parse(
      readFileSync(join(accountRoot, 'account.json'), 'utf8')
    ) as Record<string, unknown>;

    expect(existsSync(join(accountRoot, 'codex-home'))).toBe(true);
    expect(accountJson).toMatchObject({
      accountSlotId: 'team_a',
      displayName: 'Team A',
      schemaVersion: 1,
      status: 'logged_out',
    });
    expect(JSON.stringify(accountJson)).not.toMatch(/access|bearer|refresh|token|chatgpt-account/i);

    await expect(manager.listAccounts()).resolves.toMatchObject({
      defaultAccountSlotId: 'team_a',
      accounts: [
        {
          accountSlotId: 'team_a',
          boundProviderIds: ['codex-team-a'],
          displayName: 'Team A',
          isDefault: true,
          status: 'logged_out',
        },
      ],
    });
  });

  it('rejects absolute and traversal account slot ids before resolving paths', async () => {
    const manager = new CodexOAuthAccountManager({
      dataRoot: mkdtempSync(join(tmpdir(), 'openkit-codex-slots-')),
    });

    await expect(manager.createAccount({ accountSlotId: '../escape' })).rejects.toThrow(
      'Invalid Codex OAuth account slot id'
    );
    await expect(manager.createAccount({ accountSlotId: '/tmp/escape' })).rejects.toThrow(
      'Invalid Codex OAuth account slot id'
    );
  });

  it('starts each account slot with its own CODEX_HOME and refuses deleting pending slots', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-codex-home-'));
    const seenCodexHomes: string[] = [];
    const manager = new CodexOAuthAccountManager({
      clientFactory: async ({ codexHome }) => {
        seenCodexHomes.push(codexHome);
        return new FakeCodexAccountClient();
      },
      dataRoot,
    });

    await manager.createAccount({ accountSlotId: 'team_b', displayName: 'Team B' });
    const status = await manager.start('team_b', 'browser');

    expect(status).toMatchObject({
      accountSlotId: 'team_b',
      displayName: 'Team B',
      mode: 'browser',
      status: 'pending',
    });
    expect(seenCodexHomes).toEqual([
      join(
        dataRoot,
        'server',
        'files',
        'oauth',
        'openai-codex',
        'accounts',
        'team_b',
        'codex-home'
      ),
    ]);
    await expect(manager.deleteAccount('team_b')).rejects.toThrow('pending login');
  });

  it('requires callers to pass the default account slot explicitly', async () => {
    const manager = new CodexOAuthAccountManager({
      clientFactory: async () => new FakeCodexAccountClient(),
      dataRoot: mkdtempSync(join(tmpdir(), 'openkit-codex-default-')),
    });

    await expect(manager.getStatus(CODEX_OAUTH_DEFAULT_ACCOUNT_SLOT_ID)).resolves.toMatchObject({
      accountSlotId: CODEX_OAUTH_DEFAULT_ACCOUNT_SLOT_ID,
      status: 'logged_out',
    });
  });
});
