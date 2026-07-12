import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createApp } from '../app.js';
import type { BetterAuthServer } from '../auth/middleware.js';
import type { OpenAICompatibleChatCompletionRequest } from '../llm/openai-compatible-client.js';
import type { PiAiGatewayClient } from '../llm/pi-ai-client.js';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { createVaultUnlockState } from '../vault/vault-unlock-state.js';
import { listVaultUseRecords } from '../vault/vault-use-records.js';
import type { ResolvedLLMProviderConfig } from './llm-config.js';
import { ProviderRegistry } from './registry.js';

/**
 * Creates a minimal Better Auth stub for internal facade auth tests.
 *
 * @param session Session payload returned by getSession.
 * @returns Better Auth-compatible test double.
 */
function createAuthStub(
  session: Awaited<ReturnType<BetterAuthServer['api']['getSession']>>
): BetterAuthServer {
  return {
    api: {
      getSession: async () => session,
    },
    handler: async () => Response.json({ status: 'auth-ok' }),
  };
}

/**
 * Creates a provider registry with one custom provider.
 *
 * @returns Provider registry for internal facade tests.
 */
function createRegistry(): ProviderRegistry {
  return new ProviderRegistry([
    {
      baseUrl: 'https://api.example.com/v1',
      defaultModel: 'default-model',
      displayName: 'Internal Custom',
      id: 'internal-custom',
      kind: 'custom',
      models: ['default-model', 'override-model'],
      secretRef: 'env:INTERNAL_CUSTOM_KEY',
    },
  ]);
}

/**
 * Resolves test provider credential references.
 *
 * @param secretRef Provider credential reference.
 * @returns Test secret value when known.
 */
function resolveTestCredential(secretRef: string): string | null {
  return secretRef === 'env:INTERNAL_CUSTOM_KEY' ? 'sk-secret-ref' : null;
}

describe('OpenAI-compatible internal facade', () => {
  it('routes non-streaming chat completions through the configured default provider', async () => {
    const calls: Array<{
      provider: ResolvedLLMProviderConfig;
      request: OpenAICompatibleChatCompletionRequest;
    }> = [];
    const app = createApp({
      internalOpenAICompatFacade: {
        defaultProviderId: 'internal-custom',
        enabled: true,
      },
      llmPiAiClient: {
        createChatCompletion: async (provider, request) => {
          calls.push({ provider, request });

          return {
            choices: [
              {
                finish_reason: 'stop',
                index: 0,
                message: { content: 'Facade response', role: 'assistant' },
              },
            ],
            created: 1,
            id: 'chatcmpl_internal',
            model: request.model,
            object: 'chat.completion',
          };
        },
      } as unknown as PiAiGatewayClient,
      providerCredentialResolver: resolveTestCredential,
      providerRegistry: createRegistry(),
    });

    const res = await app.request('/internal/v1/chat/completions', {
      body: JSON.stringify({
        messages: [{ content: 'Hello', role: 'user' }],
        model: 'override-model',
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      choices: [{ message: { content: 'Facade response' } }],
      id: 'chatcmpl_internal',
      model: 'override-model',
    });
    expect(calls).toEqual([
      {
        provider: expect.objectContaining({
          apiKey: 'sk-secret-ref',
          baseUrl: 'https://api.example.com/v1',
          id: 'internal-custom',
        }),
        request: expect.objectContaining({
          messages: [{ content: 'Hello', role: 'user' }],
          model: 'override-model',
          stream: false,
        }),
      },
    ]);
  });

  it('routes internal facade provider credentials through audited vault references', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-internal-facade-vault-'));
    const coreDb = openCoreDb(dataRoot);
    const vaultUnlockState = createVaultUnlockState({
      backendKind: 'encrypted-file',
      storeDir: join(dataRoot, 'server', 'vault'),
    });
    const calls: Array<{
      provider: ResolvedLLMProviderConfig;
      request: OpenAICompatibleChatCompletionRequest;
    }> = [];

    try {
      applyMigrations(coreDb);
      vaultUnlockState.unlock({ masterKey: Buffer.alloc(32, 8) });
      vaultUnlockState.backend().store({
        material: 'sk-vault-internal',
        metadata: { ownerScope: 'server' },
        referenceId: 'vault_internal_provider',
      });

      const app = createApp({
        coreDb,
        dataRoot,
        internalOpenAICompatFacade: {
          defaultProviderId: 'internal-vault',
          enabled: true,
        },
        llmPiAiClient: {
          createChatCompletion: async (provider, request) => {
            calls.push({ provider, request });

            return {
              choices: [
                {
                  finish_reason: 'stop',
                  index: 0,
                  message: { content: 'Vault facade response', role: 'assistant' },
                },
              ],
              created: 1,
              id: 'chatcmpl_internal_vault',
              model: request.model,
              object: 'chat.completion',
            };
          },
        } as unknown as PiAiGatewayClient,
        providerRegistry: new ProviderRegistry([
          {
            baseUrl: 'https://api.example.com/v1',
            defaultModel: 'vault-model',
            displayName: 'Internal Vault',
            id: 'internal-vault',
            kind: 'custom',
            models: ['vault-model'],
            secretRef: 'vault://vault_internal_provider',
          },
        ]),
        vaultUnlockState,
      });

      const res = await app.request('/internal/v1/chat/completions', {
        body: JSON.stringify({
          messages: [{ content: 'Hello', role: 'user' }],
          model: 'vault-model',
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({ id: 'chatcmpl_internal_vault' });
      expect(calls).toEqual([
        {
          provider: expect.objectContaining({
            apiKey: 'sk-vault-internal',
            id: 'internal-vault',
          }),
          request: expect.objectContaining({
            model: 'vault-model',
            stream: false,
          }),
        },
      ]);
      expect(listVaultUseRecords(coreDb)).toEqual([
        expect.objectContaining({
          outcome: 'succeeded',
          resolvingPath: 'provider',
          vaultReferenceId: 'vault_internal_provider',
        }),
      ]);
      expect(JSON.stringify(listVaultUseRecords(coreDb))).not.toContain('sk-vault-internal');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('streams OpenAI-compatible chunks through the configured default provider', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n')
        );
        controller.close();
      },
    });
    const app = createApp({
      internalOpenAICompatFacade: { enabled: true },
      llmPiAiClient: {
        createChatCompletionStream: async () => stream,
      } as unknown as PiAiGatewayClient,
      providerCredentialResolver: resolveTestCredential,
      providerRegistry: createRegistry(),
    });

    const res = await app.request('/internal/v1/chat/completions', {
      body: JSON.stringify({
        messages: [{ content: 'Hello', role: 'user' }],
        model: 'default-model',
        stream: true,
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    await expect(res.text()).resolves.toContain('data:');
  });

  it('returns an OpenAI-compatible error when no usable provider is configured', async () => {
    const app = createApp({
      internalOpenAICompatFacade: { enabled: true },
      providerRegistry: new ProviderRegistry([
        {
          displayName: 'OAuth Only',
          id: 'oauth-only',
          kind: 'oauth',
          models: ['model'],
        },
      ]),
    });

    const res = await app.request('/internal/v1/chat/completions', {
      body: JSON.stringify({
        messages: [{ content: 'Hello', role: 'user' }],
        model: 'model',
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: {
        code: 'internal_provider_not_configured',
        type: 'invalid_request_error',
      },
    });
  });

  it('is not exposed in server mode unless explicitly enabled', async () => {
    const app = createApp({
      auth: createAuthStub(null),
      mode: 'server',
      providerCredentialResolver: resolveTestCredential,
      providerRegistry: createRegistry(),
    });

    const res = await app.request('/internal/v1/chat/completions', {
      method: 'POST',
    });

    expect(res.status).toBe(404);
  });

  it('requires a server-mode session when explicitly enabled', async () => {
    const app = createApp({
      auth: createAuthStub(null),
      internalOpenAICompatFacade: { enabled: true },
      mode: 'server',
      providerCredentialResolver: resolveTestCredential,
      providerRegistry: createRegistry(),
    });

    const res = await app.request('/internal/v1/chat/completions', {
      method: 'POST',
    });

    expect(res.status).toBe(401);
  });
});
