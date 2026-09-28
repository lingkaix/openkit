import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { expect, it, vi } from 'vitest';
import { createOpenKitAccessTokenRecord } from '../auth/access-token-store.js';
import { ensureLocalUser } from '../auth/identity.js';
import type { AuthVariables } from '../auth/middleware.js';
import { createInMemoryRuntimeConfigSnapshot } from '../config/runtime-config.js';
import { assembleBuiltInSystemPrompt } from '../internal-agents/builtin-prompts.js';
import { quickChatWorkspaceIdForUser } from '../lib/store.js';
import { digestLlmSystemPrompt } from '../llm/system-prompt-digest.js';
import { ProviderRegistry } from '../providers/registry.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import {
  readWorkObservations,
  readWorkObservationTurnBinding,
  type WorkObservationRecord,
} from '../storage/work-observations.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { registerAdministrationRoutes } from './administration-routes.js';
import {
  ADMINISTRATION_TOOL_NAMES,
  type AdministrationEnvironmentTools,
} from './administration-tools.js';

it('binds the actual Administration prompt and ordered tools before model access with capture off', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'administration-capture-'));
  const coreDb = openCoreDb(dataRoot);
  try {
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const token = createOpenKitAccessTokenRecord(coreDb, {
      expiresAt: '2999-01-01T00:00:00.000Z',
      ownerUserId: 'user_local',
      scope: 'server-admin',
      tokenId: 'tok_administration_capture',
      workspaceIds: [],
    });
    const store = createDemoStore({ dataRoot });
    const workspaceId = quickChatWorkspaceIdForUser('user_local');
    const thread = store.createThread(
      workspaceId,
      'Administration',
      'th_administration_capture',
      'administration'
    );
    const profile = {
      id: 'provider',
      displayName: 'Provider',
      kind: 'custom' as const,
      baseUrl: 'https://provider.invalid/v1',
      models: ['model'],
      modelMetadata: {
        model: {
          family: 'test',
          limit: { context: 20_000, output: 1_000 },
          modalities: { input: ['text'], output: ['text'] },
          tool_call: true,
        },
      },
    };
    const snapshot = createInMemoryRuntimeConfigSnapshot({
      dataRoot,
      gatewayConfig: {
        schemaVersion: 1,
        enabled: true,
        defaultLogicalModelId: 'administration',
        logicalModels: [
          {
            id: 'administration',
            displayName: 'Administration',
            contextManagement: [{ type: 'compaction', compactThreshold: 10_000 }],
            routes: [{ id: 'primary', providerProfileId: profile.id, providerModel: 'model' }],
          },
        ],
      },
      internalRoleProfiles: {
        schemaVersion: 1,
        defaultLogicalModelId: 'administration',
        profiles: [],
      },
      providerRegistry: new ProviderRegistry([profile]),
    });
    let rowsAtModelAccess: readonly WorkObservationRecord[] = [];
    const createResponses = vi.fn(async (_provider, _request, context) => {
      rowsAtModelAccess = readWorkObservations(context.capture.workspaceDb, context.capture);
      return {
        id: 'resp_administration_capture',
        object: 'response',
        status: 'completed',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Ready.' }],
          },
        ],
      };
    });
    const app = new Hono<{ Variables: AuthVariables }>();
    app.use('*', async (context, next) => {
      context.set('actor', {
        kind: 'token',
        tokenId: token.tokenId,
        tokenScope: 'server-admin',
        tokenWorkspaceIds: [],
        userId: 'user_local',
      });
      await next();
    });
    registerAdministrationRoutes({
      app,
      coreDb,
      environmentToolsForTurn: () =>
        ['list', 'status', 'prepare'].map((operation) => ({
          name: `worker_environment.${operation}`,
          description: 'PRIVATE_TOOL_DESCRIPTION',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          execute: async () => ({ content: [] }),
        })) as unknown as AdministrationEnvironmentTools,
      inflightCommands: new WeakMap(),
      llmGatewayDispatcher: { createResponses },
      mode: 'server',
      quickChatWorkspaceIdForUser,
      requestStore: () => store,
      runtimeConfigFiles: () => ({ listFiles: () => ({ files: [] }), readFile: vi.fn() }) as never,
      reloadRuntimeConfig: vi.fn(),
      resolveGatewayProvider: () => ({
        adapterId: 'provider',
        apiKey: 'unused-fixture',
        backend: 'pi-ai',
        baseUrl: profile.baseUrl,
        displayName: profile.displayName,
        gatewayCapabilities: { chatCompletions: 'native', responses: 'native' },
        id: profile.id,
        models: profile.models,
        requiresApiKey: true,
      }),
      runtimeConfig: () => snapshot,
    });
    const response = await app.request('/api/app/administration/conversation-turns', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        input: 'Describe current administration options.',
        requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        threadId: thread.id,
      }),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).outcome).toBe('answered');
    expect(createResponses).toHaveBeenCalledOnce();
    const request = createResponses.mock.calls[0]![1];
    expect(rowsAtModelAccess).toHaveLength(1);
    const turn = store.listThreadTurns(workspaceId, thread.id)[0]!;
    expect(request.instructions).toBe(
      assembleBuiltInSystemPrompt('administration', {
        workspaceId,
        threadId: thread.id,
        workspaceKind: 'quick-chat',
      })
    );
    expect(rowsAtModelAccess[0]).toMatchObject({ type: 'env.bound', obs: 'core', turnId: turn.id });
    expect(rowsAtModelAccess[0]!.payload).toEqual({
      version: JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
        .version,
      workspaceId,
      systemPromptDigest: digestLlmSystemPrompt({ endpoint: 'responses', request }),
      tools: request.tools.map((tool: { name: string; parameters: unknown }) => ({
        name: tool.name,
        inputSchemaDigest: createHash('sha256')
          .update(JSON.stringify(tool.parameters))
          .digest('hex'),
      })),
    });
    expect(
      (rowsAtModelAccess[0]!.payload.tools as { name: string }[]).map(({ name }) => name)
    ).toEqual([...ADMINISTRATION_TOOL_NAMES]);
    expect(JSON.stringify(rowsAtModelAccess)).not.toContain('PRIVATE_TOOL_DESCRIPTION');
    expect(JSON.stringify(rowsAtModelAccess)).not.toContain(request.instructions);
    const db = openWorkspaceDb(dataRoot, workspaceId);
    try {
      expect(
        readWorkObservationTurnBinding(db, { threadId: thread.id, turnId: turn.id }).coverage
      ).toEqual({ scope: 'server', value: 'off' });
      expect(readWorkObservations(db, { threadId: thread.id, turnId: turn.id })).toHaveLength(1);
      expect(db.sqlite.prepare('SELECT COUNT(*) AS count FROM evidence_bundles').get()).toEqual({
        count: 0,
      });
    } finally {
      db.sqlite.close();
    }
  } finally {
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
