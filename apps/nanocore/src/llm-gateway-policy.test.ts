import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PiAiGatewayClient } from './llm/pi-ai-client.js';
import { ProviderRegistry } from './providers/registry.js';
import { type CoreDb, openCoreDb } from './storage/db.js';
import { applyMigrations } from './storage/migrate.js';
import { createApp } from './test-support/app.js';

function createConfiguredProviderOptions(gateway: { enabled?: boolean } = {}) {
  return {
    gatewayConfig: {
      schemaVersion: 1 as const,
      enabled: gateway.enabled ?? true,
      defaultLogicalModelId: 'quick-chat',
      logicalModels: [
        {
          id: 'quick-chat',
          displayName: 'Quick Chat',
          routes: [
            {
              id: 'primary',
              providerProfileId: 'ollama',
              providerModel: 'openai/gpt-5.2',
            },
          ],
        },
      ],
      requiredFeatures: [],
    },
    providerRegistry: new ProviderRegistry([
      {
        defaultModel: 'openai/gpt-5.2',
        displayName: 'Ollama',
        id: 'ollama',
        kind: 'local',
        models: ['openai/gpt-5.2'],
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
          model: 'quick-chat',
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
          model: 'quick-chat',
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
