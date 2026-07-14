import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedLLMProviderConfig } from '../providers/llm-config.js';
import {
  CodexAuthTokenResolver,
  CodexResponsesClient,
  type CodexTokenResolutionAccountStore,
} from './codex-responses-client.js';

const undiciAgentConstructions = vi.hoisted(() => ({
  fetchCalls: [] as Array<{
    init: (RequestInit & { dispatcher?: object }) | undefined;
    request: RequestInfo | URL;
  }>,
  instances: [] as object[],
  options: [] as Array<Record<string, unknown>>,
}));

vi.mock('undici', () => ({
  /** Minimal Agent fake that records production dispatcher construction. */
  Agent: class FakeUndiciAgent {
    /** Records the production Agent options without opening a network connection. */
    public constructor(options: Record<string, unknown>) {
      undiciAgentConstructions.instances.push(this);
      undiciAgentConstructions.options.push(options);
    }
  },
  fetch: async (
    request: RequestInfo | URL,
    init: (RequestInit & { dispatcher?: object }) | undefined
  ) => {
    undiciAgentConstructions.fetchCalls.push({ init, request });
    return Response.json({
      id: 'resp_long',
      object: 'response',
      status: 'completed',
      output: [],
    });
  },
}));

afterEach(() => vi.unstubAllGlobals());

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
  return {
    adapterId: 'openai_codex',
    apiKey: null,
    backend: 'codex-oauth',
    baseUrl: 'https://chatgpt.example.test/backend-api',
    displayName: 'OpenAI Codex',
    extraBody: {},
    extraHeaders: {},
    gatewayCapabilities: { chatCompletions: 'bridged', responses: 'native' },
    id: 'openai_codex',
    requiresApiKey: false,
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

  it('uses a local signal-driven Undici dispatcher without transport deadlines', async () => {
    vi.stubGlobal('fetch', async () => Response.json({ status: 'completed', output: [] }));
    const controller = new AbortController();
    const client = new CodexResponsesClient({
      tokenResolver: {
        resolve: async () => ({ accessToken: 'access-secret', chatgptAccountId: 'account_123' }),
      },
    });

    await client.createResponses(
      codexProvider(),
      { model: 'codex', input: 'Long task' },
      { signal: controller.signal }
    );

    expect(undiciAgentConstructions.options.at(-1)).toEqual({
      bodyTimeout: 0,
      headersTimeout: 0,
    });
    expect(undiciAgentConstructions.fetchCalls).toHaveLength(1);
    expect(undiciAgentConstructions.fetchCalls[0]?.init?.dispatcher).toBe(
      undiciAgentConstructions.instances.at(-1)
    );
    const upstreamSignal = undiciAgentConstructions.fetchCalls[0]?.init?.signal;
    expect(upstreamSignal?.aborted).toBe(false);
    controller.abort();
    expect(upstreamSignal?.aborted).toBe(true);
  });

  it('binds the caller signal to the upstream request and skips a 401 retry after abort', async () => {
    const abortController = new AbortController();
    const requests: Request[] = [];
    let tokenResolutions = 0;
    const client = new CodexResponsesClient({
      tokenResolver: {
        resolve: async () => {
          tokenResolutions += 1;
          return { accessToken: 'access-secret', chatgptAccountId: 'account_123' };
        },
      },
      fetch: async (request) => {
        requests.push(request);
        abortController.abort();
        return Response.json({ error: { message: 'expired' } }, { status: 401 });
      },
    });
    let failure: unknown;

    try {
      await client.createResponses(
        codexProvider(),
        { model: 'codex', input: 'Hi' },
        { signal: abortController.signal }
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({ name: 'AbortError' });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.signal.aborted).toBe(true);
    expect(tokenResolutions).toBe(1);
  });

  it('refreshes the Codex token and retries once after a 401 response', async () => {
    const requests: Request[] = [];
    const turnStates: string[] = [];
    let rejectedBodyCancellations = 0;
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
          return new Response(
            new ReadableStream<Uint8Array>({
              cancel() {
                rejectedBodyCancellations += 1;
              },
            }),
            {
              headers: {
                'content-type': 'application/json',
                'x-codex-turn-state': 'discarded-401-state',
                'x-request-id': 'discarded-private-request-id',
              },
              status: 401,
            }
          );
        }

        return Response.json(
          { id: 'resp_2', object: 'response', status: 'completed', output: [] },
          {
            headers: {
              'x-codex-turn-state': 'accepted-final-state',
              'x-request-id': 'private-final-request-id',
            },
          }
        );
      },
    });

    await expect(
      client.createResponses(
        codexProvider(),
        { model: 'codex', input: 'Hi' },
        {
          codexTurnState: 'replayed-request-state',
          onCodexTurnState: (turnState) => turnStates.push(turnState),
        }
      )
    ).resolves.toMatchObject({ id: 'resp_2' });
    expect(requests.map((request) => request.headers.get('authorization'))).toEqual([
      'Bearer access-1',
      'Bearer access-2',
    ]);
    expect(requests.map((request) => request.headers.get('x-codex-turn-state'))).toEqual([
      'replayed-request-state',
      'replayed-request-state',
    ]);
    expect(rejectedBodyCancellations).toBe(1);
    expect(turnStates).toEqual(['accepted-final-state']);
  });

  it('preserves Codex turn state before returning an upstream Responses stream', async () => {
    const requests: Request[] = [];
    const turnStates: string[] = [];
    const client = new CodexResponsesClient({
      tokenResolver: {
        resolve: async () => ({ accessToken: 'access-secret', chatgptAccountId: 'account_123' }),
      },
      fetch: async (request) => {
        requests.push(request);
        return new Response('data: {"type":"response.completed"}\n\ndata: [DONE]\n\n', {
          headers: {
            'content-type': 'text/event-stream',
            'x-codex-turn-state': 'stream-response-state',
            'x-request-id': 'private-stream-request-id',
          },
        });
      },
    });

    const stream = await client.createResponsesStream(
      codexProvider(),
      { model: 'codex', input: 'Hi', stream: true },
      {
        codexTurnState: 'stream-request-state',
        onCodexTurnState: (turnState) => turnStates.push(turnState),
      }
    );

    expect(requests[0]?.headers.get('x-codex-turn-state')).toBe('stream-request-state');
    expect(turnStates).toEqual(['stream-response-state']);
    await expect(new Response(stream).text()).resolves.toContain('response.completed');
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
