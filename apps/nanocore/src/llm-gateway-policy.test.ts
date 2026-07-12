import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import type { PiAiGatewayClient } from './llm/pi-ai-client.js';
import { ProviderRegistry } from './providers/registry.js';
import { type CoreDb, openCoreDb } from './storage/db.js';
import { applyMigrations } from './storage/migrate.js';

function createConfiguredProviderOptions(
  gateway: { allowedProviderIds?: string[]; enabled?: boolean } = {}
) {
  return {
    openKitConfig: {
      defaults: { gatewayProviderId: 'ollama', gatewayModel: 'llama3.2' },
      gateway: { openaiCompatible: gateway },
    },
    providerRegistry: new ProviderRegistry([
      {
        defaultModel: 'llama3.2',
        displayName: 'Ollama',
        id: 'ollama',
        kind: 'local',
        models: ['llama3.2'],
        vendor: 'ollama',
      },
    ]),
  };
}

describe('LLM gateway policy controls', () => {
  it('does not list models while the agent gateway is disabled', async () => {
    const app = createApp({
      ...createConfiguredProviderOptions({ enabled: false }),
    });

    const res = await app.request('/v1/models');

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      error: { code: 'gateway_disabled' },
    });
  });

  it('can disable agent gateway chat completions', async () => {
    const coreDb = createTestCoreDb();
    const app = createApp({
      ...createConfiguredProviderOptions({ enabled: false }),
      coreDb,
    });

    try {
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({
          model: 'llama3.2',
          messages: [{ role: 'user', content: 'Hello' }],
        }),
        headers: { 'content-type': 'application/json' },
      });

      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toMatchObject({
        error: { code: 'gateway_disabled' },
      });
      expect(latestPermissionDecision(coreDb)).toMatchObject({
        action: 'llm.gateway.chat_completions',
        enforcement_point: 'llm.gateway.policy',
        reason_code: 'gateway_disabled',
        result: 'deny',
      });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('can restrict gateway routing to approved providers', async () => {
    const coreDb = createTestCoreDb();
    const app = createApp({
      ...createConfiguredProviderOptions({ allowedProviderIds: ['openai'] }),
      coreDb,
      llmPiAiClient: {
        createChatCompletion: async () => {
          throw new Error('Policy should block before provider call');
        },
      } as unknown as PiAiGatewayClient,
    });

    try {
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({
          model: 'llama3.2',
          messages: [{ role: 'user', content: 'Hello' }],
        }),
        headers: { 'content-type': 'application/json' },
      });

      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toMatchObject({
        error: { code: 'gateway_provider_not_allowed' },
      });
      expect(latestPermissionDecision(coreDb)).toMatchObject({
        action: 'llm.gateway.chat_completions',
        enforcement_point: 'llm.gateway.policy',
        reason_code: 'gateway_provider_not_allowed',
        result: 'deny',
      });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('records allowed gateway chat completion policy decisions', async () => {
    const coreDb = createTestCoreDb();
    const app = createApp({
      ...createConfiguredProviderOptions(),
      coreDb,
      llmPiAiClient: {
        createChatCompletion: async (_provider, request) => ({
          id: 'chatcmpl_policy_allowed',
          object: 'chat.completion',
          created: 1,
          model: request.model,
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'Allowed' },
              finish_reason: 'stop',
            },
          ],
        }),
      } as unknown as PiAiGatewayClient,
    });

    try {
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({
          model: 'llama3.2',
          messages: [{ role: 'user', content: 'Hello' }],
        }),
        headers: { 'content-type': 'application/json' },
      });

      expect(res.status).toBe(200);
      expect(latestPermissionDecision(coreDb)).toMatchObject({
        action: 'llm.gateway.chat_completions',
        enforcement_point: 'llm.gateway.policy',
        reason_code: 'gateway_allowed',
        result: 'allow',
      });
    } finally {
      coreDb.sqlite.close();
    }
  });
});

/**
 * Creates a migrated Core database for gateway policy tests.
 *
 * @returns Migrated Core database.
 */
function createTestCoreDb(): CoreDb {
  const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-gateway-policy-')));
  applyMigrations(coreDb);
  return coreDb;
}

/**
 * Reads the newest permission decision row.
 *
 * @param coreDb Core database handle.
 * @returns Newest permission decision row.
 */
function latestPermissionDecision(coreDb: CoreDb): {
  action: string;
  enforcement_point: string;
  reason_code: string;
  result: string;
} {
  return coreDb.sqlite
    .prepare(
      `SELECT action, enforcement_point, reason_code, result
       FROM permission_decisions
       ORDER BY created_at DESC, decision_id DESC
       LIMIT 1`
    )
    .get() as {
    action: string;
    enforcement_point: string;
    reason_code: string;
    result: string;
  };
}
