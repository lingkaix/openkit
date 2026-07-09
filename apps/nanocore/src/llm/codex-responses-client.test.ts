import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  CodexAuthTokenResolver,
  CodexResponsesClient,
  type CodexTokenResolutionAccountStore,
} from './codex-responses-client.js';
import type { ResolvedLLMProviderConfig } from './provider-config.js';
import { findProviderSpec } from './provider-registry.js';

class FakeAccountStore implements CodexTokenResolutionAccountStore {
  public readonly refreshes: boolean[] = [];

  /**
   * Creates a fake store.
   *
   * @param codexHome Codex home returned to the token resolver.
   */
  public constructor(private readonly codexHome: string) {}

  /**
   * Records the refresh request made before token resolution.
   *
   * @returns Minimal logged-in account state.
   */
  public async readAccountForTokenRefresh() {
    this.refreshes.push(true);
    return {
      account: { type: 'chatgpt' as const, email: 'user@example.com', planType: 'plus' },
      requiresOpenaiAuth: true,
    };
  }

  /**
   * Returns the fake Codex home path.
   *
   * @returns Codex home path.
   */
  public async getCodexHome() {
    return this.codexHome;
  }
}

/**
 * Creates an OpenAI Codex provider config for client tests.
 *
 * @returns Resolved provider config.
 */
function codexProvider(
  overrides: Partial<ResolvedLLMProviderConfig> = {}
): ResolvedLLMProviderConfig {
  const spec = findProviderSpec('openai_codex');

  if (!spec) {
    throw new Error('Missing OpenAI Codex provider spec');
  }

  return {
    id: 'openai_codex',
    specId: 'openai_codex',
    displayName: 'OpenAI Codex',
    model: 'openai-codex/gpt-5.1-codex',
    baseUrl: 'https://chatgpt.example.test/backend-api',
    hasApiKey: false,
    apiKeySource: 'not-required',
    gatewayCapabilities: spec.gatewayCapabilities,
    extraHeaders: {},
    extraBody: {},
    spec,
    apiKey: null,
    ...overrides,
  };
}

describe('Codex Responses client', () => {
  it('resolves Codex ChatGPT tokens from auth.json without exposing token material', async () => {
    const codexHome = mkdtempSync(join(tmpdir(), 'openkit-codex-auth-'));
    const store = new FakeAccountStore(codexHome);

    writeFileSync(
      join(codexHome, 'auth.json'),
      JSON.stringify({
        tokens: {
          access_token: 'access-secret',
          account_id: 'account_123',
        },
      })
    );

    const resolver = new CodexAuthTokenResolver({ accountStore: store, platform: 'linux' });
    const token = await resolver.resolve();

    expect(token).toEqual({ accessToken: 'access-secret', chatgptAccountId: 'account_123' });
    expect(store.refreshes).toEqual([true]);
    expect(JSON.stringify(token)).not.toContain('auth.json');
  });

  it('prefers macOS Keychain tokens before auth.json fallback', async () => {
    const codexHome = mkdtempSync(join(tmpdir(), 'openkit-codex-keychain-'));
    const store = new FakeAccountStore(codexHome);
    const resolver = new CodexAuthTokenResolver({
      accountStore: store,
      platform: 'darwin',
      readKeychainPassword: async () =>
        JSON.stringify({ access_token: 'keychain-access', account_id: 'account_keychain' }),
    });

    await expect(resolver.resolve()).resolves.toEqual({
      accessToken: 'keychain-access',
      chatgptAccountId: 'account_keychain',
    });
  });

  it('calls the ChatGPT Codex Responses endpoint with subscription headers and store disabled', async () => {
    const requests: Request[] = [];
    const client = new CodexResponsesClient({
      tokenResolver: {
        resolve: async () => ({ accessToken: 'access-secret', chatgptAccountId: 'account_123' }),
      },
      fetch: async (request) => {
        requests.push(request);
        return Response.json({
          id: 'resp_1',
          object: 'response',
          status: 'completed',
          model: 'gpt-5.1-codex',
          output: [],
        });
      },
    });

    await client.createResponses(codexProvider(), {
      model: 'openai-codex/gpt-5.1-codex',
      input: 'Hello',
    });

    expect(requests[0]?.url).toBe('https://chatgpt.example.test/backend-api/codex/responses');
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer access-secret');
    expect(requests[0]?.headers.get('chatgpt-account-id')).toBe('account_123');
    expect(requests[0]?.headers.get('openai-beta')).toBe('responses=experimental');
    expect(requests[0]?.headers.get('originator')).toBe('openkit');
    await expect(requests[0]?.json()).resolves.toMatchObject({
      model: 'gpt-5.1-codex',
      input: 'Hello',
      stream: false,
      store: false,
    });
  });

  it('refreshes the Codex token and retries once after a 401 response', async () => {
    const requests: Request[] = [];
    let tokenCounter = 0;
    const client = new CodexResponsesClient({
      tokenResolver: {
        resolve: async () => {
          tokenCounter += 1;
          return { accessToken: `access-${tokenCounter}`, chatgptAccountId: 'account_123' };
        },
      },
      fetch: async (request) => {
        requests.push(request);
        if (requests.length === 1) {
          return Response.json({ error: { message: 'expired' } }, { status: 401 });
        }

        return Response.json({ id: 'resp_2', object: 'response', status: 'completed', output: [] });
      },
    });

    await expect(
      client.createResponses(codexProvider(), { model: 'codex', input: 'Hi' })
    ).resolves.toMatchObject({ id: 'resp_2' });
    expect(requests.map((request) => request.headers.get('authorization'))).toEqual([
      'Bearer access-1',
      'Bearer access-2',
    ]);
  });

  it('selects the token resolver from the resolved provider account slot for every retry', async () => {
    const seenSlots: Array<string | null | undefined> = [];
    const requests: Request[] = [];
    const client = new CodexResponsesClient({
      tokenResolverForProvider: (provider) => ({
        resolve: async () => {
          seenSlots.push(provider.codexOAuthAccountSlotId);
          return {
            accessToken: `access-${provider.codexOAuthAccountSlotId}`,
            chatgptAccountId: 'account_123',
          };
        },
      }),
      fetch: async (request) => {
        requests.push(request);

        if (requests.length === 1) {
          return Response.json({ error: { message: 'expired' } }, { status: 401 });
        }

        return Response.json({ id: 'resp_3', object: 'response', status: 'completed', output: [] });
      },
    });

    await expect(
      client.createResponses(codexProvider({ codexOAuthAccountSlotId: 'team_a' }), {
        model: 'codex',
        input: 'Hi',
      })
    ).resolves.toMatchObject({ id: 'resp_3' });
    expect(seenSlots).toEqual(['team_a', 'team_a']);
    expect(requests.map((request) => request.headers.get('authorization'))).toEqual([
      'Bearer access-team_a',
      'Bearer access-team_a',
    ]);
  });
});
