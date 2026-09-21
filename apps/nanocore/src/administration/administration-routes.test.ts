import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createOpenKitAccessTokenRecord,
  revokeOpenKitAccessTokenRecord,
} from '../auth/access-token-store.js';
import type { Actor } from '../auth/identity.js';
import { ensureLocalUser } from '../auth/identity.js';
import type { AuthVariables } from '../auth/middleware.js';
import { createInMemoryRuntimeConfigSnapshot } from '../config/runtime-config.js';
import type { ResolvedInternalRoleProfile } from '../internal-agents/profile-resolver.js';
import { quickChatWorkspaceIdForUser } from '../lib/store.js';
import type { ResolvedLLMProviderConfig } from '../providers/llm-config.js';
import { ProviderRegistry } from '../providers/registry.js';
import { type CoreDb, openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { registerAdministrationRoutes } from './administration-routes.js';
import {
  ADMINISTRATION_TOOL_NAMES,
  type AdministrationEnvironmentTools,
} from './administration-tools.js';

const profileResolverFixture = vi.hoisted(() => ({
  actual: undefined as
    | undefined
    | typeof import('../internal-agents/profile-resolver.js').resolveInternalRoleProfile,
  resolveInternalRoleProfile: vi.fn(),
}));

vi.mock('../internal-agents/profile-resolver.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../internal-agents/profile-resolver.js')>();
  profileResolverFixture.actual = actual.resolveInternalRoleProfile;
  profileResolverFixture.resolveInternalRoleProfile.mockImplementation(
    actual.resolveInternalRoleProfile
  );
  return {
    ...actual,
    resolveInternalRoleProfile: profileResolverFixture.resolveInternalRoleProfile,
  };
});

const openDatabases: CoreDb[] = [];

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.sqlite.close();
  profileResolverFixture.resolveInternalRoleProfile.mockReset();
  if (profileResolverFixture.actual) {
    profileResolverFixture.resolveInternalRoleProfile.mockImplementation(
      profileResolverFixture.actual
    );
  }
});

describe('administration conversation route', () => {
  it('supplies server-authored private context for a two-round environment list call', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-administration-private-context-'));
    const coreDb = openCoreDb(dataRoot);
    openDatabases.push(coreDb);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const token = createOpenKitAccessTokenRecord(coreDb, {
      expiresAt: '2999-01-01T00:00:00.000Z',
      ownerUserId: 'user_local',
      scope: 'server-admin',
      tokenId: 'tok_administration_private_context',
      workspaceIds: [],
    });
    const actor: Actor = {
      kind: 'token',
      tokenId: token.tokenId,
      tokenScope: 'server-admin',
      tokenWorkspaceIds: [],
      userId: 'user_local',
    };
    const store = createDemoStore({ dataRoot });
    const workspaceId = quickChatWorkspaceIdForUser(actor.userId);
    const thread = store.createThread(
      workspaceId,
      'Administration',
      'thread_administration_private_context',
      'administration'
    );
    const providerProfile = {
      baseUrl: 'https://provider.invalid/v1',
      displayName: 'Provider',
      id: 'provider',
      kind: 'custom' as const,
      modelMetadata: {
        model: {
          family: 'test',
          limit: { context: 20_000, output: 1_000 },
          modalities: { input: ['text'], output: ['text'] },
          tool_call: true,
        },
      },
      models: ['model'],
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
            // 10000 stays inside the 20000 physical context and leaves headroom for seven Tool schemas plus instructions.
            contextManagement: [{ type: 'compaction', compactThreshold: 10_000 }],
            routes: [
              { id: 'primary', providerProfileId: providerProfile.id, providerModel: 'model' },
            ],
          },
        ],
      },
      internalRoleProfiles: {
        schemaVersion: 1,
        defaultLogicalModelId: 'administration',
        profiles: [],
      },
      providerRegistry: new ProviderRegistry([providerProfile]),
    });
    const listEnvironments = vi.fn(async () => ({
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ environments: [], nextAfter: null, workspaceId }),
        },
      ],
    }));
    const inertTools = inertEnvironmentTools();
    const environmentTools = [
      {
        name: 'worker_environment.list',
        description: 'List retained Worker environments in one exact Workspace.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: { workspaceId: { type: 'string', minLength: 1 } },
          required: ['workspaceId'],
        },
        execute: listEnvironments,
      },
      inertTools[1],
      inertTools[2],
    ] as const satisfies AdministrationEnvironmentTools;
    const createResponses = vi
      .fn()
      .mockImplementationOnce(async (_provider, request) => {
        expect(request.instructions).toContain(
          `{"workspaceId":"${workspaceId}","threadId":"${thread.id}","workspaceKind":"quick-chat"}`
        );
        expect(request.instructions).toContain(
          'NanoHost is the execution host, not an LLM Provider.'
        );
        expect(request.instructions).toContain(
          'Use nanohost.runtime-target to read host RuntimeTarget readiness'
        );
        expect(request.instructions).toContain(
          'returns Core stored projection at observedAt rather than a live host probe'
        );
        expect(request.instructions).toContain(
          'Never infer that NanoHost is unconfigured or unready from Provider catalog absence or zero Worker environments.'
        );
        expect(request.tools.map((tool: { name: string }) => tool.name)).toEqual([
          ...ADMINISTRATION_TOOL_NAMES,
        ]);
        return {
          id: 'resp_administration_private_context_tool',
          object: 'response',
          status: 'completed',
          output: [
            {
              type: 'function_call',
              call_id: 'call_environment_list',
              name: 'worker_environment.list',
              arguments: JSON.stringify({ workspaceId }),
            },
          ],
        };
      })
      .mockResolvedValueOnce({
        id: 'resp_administration_private_context_answer',
        object: 'response',
        status: 'completed',
        output: [
          {
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'No retained Worker environments.' }],
          },
        ],
      });
    const app = new Hono<{ Variables: AuthVariables }>();
    app.use('*', async (context, next) => {
      context.set('actor', actor);
      await next();
    });
    registerAdministrationRoutes({
      app,
      coreDb,
      environmentToolsForTurn: () => environmentTools,
      inflightCommands: new WeakMap(),
      llmGatewayDispatcher: { createResponses },
      mode: 'server',
      quickChatWorkspaceIdForUser,
      requestStore: () => store,
      runtimeConfigFiles: () => ({ listFiles: () => ({ files: [] }), readFile: vi.fn() }) as never,
      resolveGatewayProvider: () =>
        ({
          adapterId: 'provider',
          apiKey: 'unused',
          baseUrl: providerProfile.baseUrl,
          displayName: providerProfile.displayName,
          gatewayCapabilities: { chatCompletions: 'native', responses: 'native' },
          id: providerProfile.id,
          models: providerProfile.models,
          requiresApiKey: true,
        }) satisfies ResolvedLLMProviderConfig,
      runtimeConfig: () => snapshot,
    });

    const response = await app.request('/api/app/administration/conversation-turns', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        input: 'List retained Worker environments in my current Quick Chat Workspace.',
        requestId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        threadId: thread.id,
      }),
    });
    const body = (await response.json()) as { outcome: string; turn: { status: string } };

    expect(response.status).toBe(200);
    expect(body, JSON.stringify(body)).toMatchObject({
      outcome: 'answered',
      turn: { status: 'completed' },
    });
    expect(listEnvironments).toHaveBeenCalledWith(
      { workspaceId },
      expect.objectContaining({ callId: 'call_environment_list' })
    );
    expect(createResponses).toHaveBeenCalledTimes(2);
  });

  it('does not republish a prior answer when the final provider response is empty', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-administration-empty-answer-'));
    const coreDb = openCoreDb(dataRoot);
    openDatabases.push(coreDb);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const token = createOpenKitAccessTokenRecord(coreDb, {
      expiresAt: '2999-01-01T00:00:00.000Z',
      ownerUserId: 'user_local',
      scope: 'server-admin',
      tokenId: 'tok_administration_empty_answer',
      workspaceIds: [],
    });
    const actor: Actor = {
      kind: 'token',
      tokenId: token.tokenId,
      tokenScope: 'server-admin',
      tokenWorkspaceIds: [],
      userId: 'user_local',
    };
    const store = createDemoStore({ dataRoot });
    const providerProfile = {
      baseUrl: 'https://provider.invalid/v1',
      displayName: 'Provider',
      id: 'provider',
      kind: 'custom' as const,
      modelMetadata: {
        model: {
          family: 'test',
          limit: { context: 20_000, output: 1_000 },
          modalities: { input: ['text'], output: ['text'] },
          tool_call: true,
        },
      },
      models: ['model'],
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
            // 10000 stays inside the 20000 physical context and leaves headroom for seven Tool schemas plus instructions.
            contextManagement: [{ type: 'compaction', compactThreshold: 10_000 }],
            routes: [
              { id: 'primary', providerProfileId: providerProfile.id, providerModel: 'model' },
            ],
          },
        ],
      },
      internalRoleProfiles: {
        schemaVersion: 1,
        defaultLogicalModelId: 'administration',
        profiles: [],
      },
      providerRegistry: new ProviderRegistry([providerProfile]),
    });
    const createResponses = vi
      .fn()
      .mockResolvedValueOnce({
        id: 'resp_administration_prior',
        object: 'response',
        status: 'completed',
        output: [
          {
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'Prior administration answer.' }],
          },
        ],
      })
      .mockResolvedValueOnce({
        id: 'resp_administration_empty',
        object: 'response',
        status: 'completed',
        output: [
          {
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: '' }],
          },
        ],
      });
    const app = new Hono<{ Variables: AuthVariables }>();
    app.use('*', async (context, next) => {
      context.set('actor', actor);
      await next();
    });
    registerAdministrationRoutes({
      app,
      coreDb,
      environmentToolsForTurn: () => inertEnvironmentTools(),
      inflightCommands: new WeakMap(),
      llmGatewayDispatcher: { createResponses },
      mode: 'server',
      quickChatWorkspaceIdForUser,
      requestStore: () => store,
      runtimeConfigFiles: () => ({ listFiles: () => ({ files: [] }), readFile: vi.fn() }) as never,
      resolveGatewayProvider: () =>
        ({
          adapterId: 'provider',
          apiKey: 'unused',
          baseUrl: providerProfile.baseUrl,
          displayName: providerProfile.displayName,
          gatewayCapabilities: { chatCompletions: 'native', responses: 'native' },
          id: providerProfile.id,
          models: providerProfile.models,
          requiresApiKey: true,
        }) satisfies ResolvedLLMProviderConfig,
      runtimeConfig: () => snapshot,
    });

    const first = await app.request('/api/app/administration/conversation-turns', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        input: 'Give the first answer.',
        requestId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      }),
    });
    const firstBody = (await first.json()) as { receivingThreadId: string };
    expect(first.status).toBe(200);

    const second = await app.request('/api/app/administration/conversation-turns', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        input: 'Give the second answer.',
        requestId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        threadId: firstBody.receivingThreadId,
      }),
    });
    const secondBody = (await second.json()) as {
      outcome: string;
      turn: { error: { code: string } | null; items: { text?: string }[]; status: string };
    };

    expect(second.status).toBe(200);
    expect(secondBody).toMatchObject({
      outcome: 'refused',
      turn: { error: { code: 'internal_agent_empty_answer' }, status: 'failed' },
    });
    expect(JSON.stringify(secondBody)).not.toContain('Prior administration answer.');
    expect(createResponses).toHaveBeenCalledTimes(2);
  });

  it('settles revocation after provider return and replays the receipt under fresh authority', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-administration-route-'));
    const coreDb = openCoreDb(dataRoot);
    openDatabases.push(coreDb);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const firstToken = createOpenKitAccessTokenRecord(coreDb, {
      expiresAt: '2999-01-01T00:00:00.000Z',
      ownerUserId: 'user_local',
      scope: 'server-admin',
      tokenId: 'tok_administration_first',
      workspaceIds: [],
    });
    const actorState: { current: Actor } = {
      current: {
        kind: 'token',
        tokenId: firstToken.tokenId,
        tokenScope: 'server-admin',
        tokenWorkspaceIds: [],
        userId: 'user_local',
      },
    };
    const store = createDemoStore({ dataRoot });
    const providerProfile = {
      baseUrl: 'https://provider.invalid/v1',
      displayName: 'Provider',
      id: 'provider',
      kind: 'custom' as const,
      modelMetadata: {
        model: {
          family: 'test',
          limit: { context: 20_000, output: 1_000 },
          modalities: { input: ['text'], output: ['text'] },
          tool_call: true,
        },
      },
      models: ['model'],
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
            // 10000 stays inside the 20000 physical context and leaves headroom for seven Tool schemas plus instructions.
            contextManagement: [{ type: 'compaction', compactThreshold: 10_000 }],
            routes: [
              { id: 'primary', providerProfileId: providerProfile.id, providerModel: 'model' },
            ],
          },
        ],
      },
      internalRoleProfiles: {
        schemaVersion: 1,
        defaultLogicalModelId: 'administration',
        profiles: [],
      },
      providerRegistry: new ProviderRegistry([providerProfile]),
    });
    const createResponses = vi.fn(async () => {
      revokeOpenKitAccessTokenRecord(coreDb, firstToken.tokenId);
      return {
        id: 'resp_administration',
        object: 'response',
        status: 'completed',
        output: [
          {
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'This answer must not publish.' }],
          },
        ],
      };
    });
    const app = new Hono<{ Variables: AuthVariables }>();
    app.use('*', async (context, next) => {
      context.set('actor', actorState.current);
      await next();
    });
    registerAdministrationRoutes({
      app,
      coreDb,
      environmentToolsForTurn: () => inertEnvironmentTools(),
      inflightCommands: new WeakMap(),
      llmGatewayDispatcher: { createResponses },
      mode: 'server',
      quickChatWorkspaceIdForUser,
      requestStore: () => store,
      runtimeConfigFiles: () => ({ listFiles: () => ({ files: [] }), readFile: vi.fn() }) as never,
      resolveGatewayProvider: () =>
        ({
          adapterId: 'provider',
          apiKey: 'unused',
          baseUrl: providerProfile.baseUrl,
          displayName: providerProfile.displayName,
          gatewayCapabilities: { chatCompletions: 'native', responses: 'native' },
          id: providerProfile.id,
          models: providerProfile.models,
          requiresApiKey: true,
        }) satisfies ResolvedLLMProviderConfig,
      runtimeConfig: () => snapshot,
    });
    const request = {
      input: 'Inspect the Worker environment.',
      requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    };

    const first = await app.request('/api/app/administration/conversation-turns', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });
    const firstBody = (await first.json()) as {
      outcome: string;
      turn: { id: string; status: string };
    };
    expect(first.status).toBe(200);
    expect(firstBody).toMatchObject({ outcome: 'refused', turn: { status: 'failed' } });
    expect(JSON.stringify(firstBody)).not.toContain('This answer must not publish.');

    const secondToken = createOpenKitAccessTokenRecord(coreDb, {
      expiresAt: '2999-01-01T00:00:00.000Z',
      ownerUserId: 'user_local',
      scope: 'server-admin',
      tokenId: 'tok_administration_second',
      workspaceIds: [],
    });
    actorState.current = {
      kind: 'token',
      tokenId: secondToken.tokenId,
      tokenScope: 'server-admin',
      tokenWorkspaceIds: [],
      userId: 'user_local',
    };
    const replay = await app.request('/api/app/administration/conversation-turns', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });
    const replayBody = (await replay.json()) as typeof firstBody;

    expect(replay.status).toBe(200);
    expect(replayBody.turn.id).toBe(firstBody.turn.id);
    expect(replayBody.turn.status).toBe('failed');
    expect(createResponses).toHaveBeenCalledOnce();

    const readTurn = store.getTurnById.bind(store);
    vi.spyOn(store, 'getTurnById').mockImplementationOnce((turnId) => {
      const turn = readTurn(turnId);
      return {
        ...turn,
        items: turn.items.filter((item) => item.id !== `it_administration_user_${turn.id}`),
      };
    });
    const missingUserReplay = await app.request('/api/app/administration/conversation-turns', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });
    expect(missingUserReplay.status).toBe(409);
    await expect(missingUserReplay.json()).resolves.toMatchObject({ code: 'recovery_required' });

    expect(() =>
      store.updateTurn(firstBody.turn.id, { status: 'running', completedAt: null, error: null })
    ).toThrow(/is terminal and does not admit this write/);

    vi.spyOn(store, 'updateTurn').mockImplementationOnce(() => {
      throw new Error('completion persistence failed');
    });
    const partialRequest = {
      input: 'Inspect another Worker environment.',
      requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    };
    const partial = await app.request('/api/app/administration/conversation-turns', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(partialRequest),
    });
    expect(partial.status).toBe(409);
    await expect(partial.json()).resolves.toMatchObject({ code: 'recovery_required' });
    const partialReplay = await app.request('/api/app/administration/conversation-turns', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(partialRequest),
    });
    expect(partialReplay.status).toBe(409);
    await expect(partialReplay.json()).resolves.toMatchObject({ code: 'recovery_required' });
    expect(createResponses).toHaveBeenCalledTimes(2);
  });

  it('rejects a foreign private administration Thread in the actor home without a new Turn', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-administration-foreign-thread-'));
    const coreDb = openCoreDb(dataRoot);
    openDatabases.push(coreDb);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const token = createOpenKitAccessTokenRecord(coreDb, {
      expiresAt: '2999-01-01T00:00:00.000Z',
      ownerUserId: 'user_local',
      scope: 'server-admin',
      tokenId: 'tok_administration_foreign_thread',
      workspaceIds: [],
    });
    const actor: Actor = {
      kind: 'token',
      tokenId: token.tokenId,
      tokenScope: 'server-admin',
      tokenWorkspaceIds: [],
      userId: 'user_local',
    };
    const store = createDemoStore({ dataRoot });
    const actorWorkspaceId = quickChatWorkspaceIdForUser(actor.userId);
    store.ensureQuickChatWorkspace('user_other');
    const foreignPrivateThread = store.createThread(
      quickChatWorkspaceIdForUser('user_other'),
      'Foreign private administration',
      undefined,
      'administration',
      { privateOwnerUserId: 'user_other', visibility: 'private' }
    );
    const actorThreadIds = store.listThreads(actorWorkspaceId).map((thread) => thread.id);
    const createTurn = vi.spyOn(store, 'createTurn');
    const createResponses = vi.fn();
    const providerProfile = {
      baseUrl: 'https://provider.invalid/v1',
      displayName: 'Provider',
      id: 'provider',
      kind: 'custom' as const,
      models: ['model'],
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
            contextManagement: [{ type: 'compaction', compactThreshold: 8_000 }],
            routes: [
              { id: 'primary', providerProfileId: providerProfile.id, providerModel: 'model' },
            ],
          },
        ],
      },
      internalRoleProfiles: {
        schemaVersion: 1,
        defaultLogicalModelId: 'administration',
        profiles: [],
      },
      providerRegistry: new ProviderRegistry([
        {
          ...providerProfile,
          modelMetadata: {
            model: {
              family: 'test',
              limit: { context: 20_000, output: 1_000 },
              modalities: { input: ['text'], output: ['text'] },
              tool_call: true,
            },
          },
        },
      ]),
    });
    const app = new Hono<{ Variables: AuthVariables }>();
    app.use('*', async (context, next) => {
      context.set('actor', actor);
      await next();
    });
    registerAdministrationRoutes({
      app,
      coreDb,
      environmentToolsForTurn: () => inertEnvironmentTools(),
      inflightCommands: new WeakMap(),
      llmGatewayDispatcher: { createResponses },
      mode: 'server',
      quickChatWorkspaceIdForUser,
      requestStore: () => store,
      runtimeConfigFiles: () => ({ listFiles: () => ({ files: [] }), readFile: vi.fn() }) as never,
      resolveGatewayProvider: () =>
        ({
          adapterId: 'provider',
          apiKey: 'unused',
          baseUrl: providerProfile.baseUrl,
          displayName: providerProfile.displayName,
          gatewayCapabilities: { chatCompletions: 'native', responses: 'native' },
          id: providerProfile.id,
          models: providerProfile.models,
          requiresApiKey: true,
        }) satisfies ResolvedLLMProviderConfig,
      runtimeConfig: () => snapshot,
    });

    const response = await app.request('/api/app/administration/conversation-turns', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        input: 'Continue the other private administration thread.',
        requestId: '22222222-2222-4222-8222-222222222222',
        threadId: foreignPrivateThread.id,
      }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: 'target_missing',
      message: 'Administration Thread is unavailable.',
    });
    expect(createTurn).not.toHaveBeenCalled();
    expect(createResponses).not.toHaveBeenCalled();
    expect(store.listThreads(actorWorkspaceId).map((thread) => thread.id)).toEqual(actorThreadIds);
  });

  it('refuses missing tool-calling as administration_execution_failed rather than compaction unavailability', async () => {
    const { body, createResponses, status } = await postAdministrationAdmissionTurn({
      label: 'missing-tool-calling',
      toolCall: false,
    });

    expect(status).toBe(200);
    expect(body, JSON.stringify(body)).toMatchObject({
      outcome: 'refused',
      explanation:
        'Administration requires an admitted logical model with responses and tool-calling capabilities.',
      turn: {
        status: 'failed',
        error: {
          code: 'administration_execution_failed',
          message:
            'Administration requires an admitted logical model with responses and tool-calling capabilities.',
        },
      },
      item: {
        summary:
          'Administration requires an admitted logical model with responses and tool-calling capabilities.',
      },
    });
    expect(body.turn.error?.code).not.toBe('context_compaction_unavailable');
    expect(createResponses).not.toHaveBeenCalled();
  });

  it('refuses missing context policy as context_compaction_unavailable after capabilities admit', async () => {
    const { body, createResponses, status } = await postAdministrationAdmissionTurn({
      label: 'missing-context-policy',
      toolCall: true,
      stripContextManagement: true,
    });

    expect(status).toBe(200);
    expect(body, JSON.stringify(body)).toMatchObject({
      outcome: 'refused',
      explanation:
        'Administration requires an admitted Tool-capable logical model with context policy.',
      turn: {
        status: 'failed',
        error: {
          code: 'context_compaction_unavailable',
          message:
            'Administration requires an admitted Tool-capable logical model with context policy.',
        },
      },
      item: {
        summary:
          'Administration requires an admitted Tool-capable logical model with context policy.',
      },
    });
    expect(createResponses).not.toHaveBeenCalled();
  });
});

function inertEnvironmentTools(): AdministrationEnvironmentTools {
  return ['list', 'status', 'prepare'].map((operation) => ({
    name: `worker_environment.${operation}`,
    description: `Inert ${operation} Tool.`,
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    execute: async () => ({ content: [] }),
  })) as unknown as AdministrationEnvironmentTools;
}

/** Exercises model admission through the real administration route without provider effects. */
async function postAdministrationAdmissionTurn(options: {
  readonly label: string;
  readonly toolCall: boolean;
  readonly stripContextManagement?: boolean;
}): Promise<{
  readonly status: number;
  readonly body: {
    readonly outcome: string;
    readonly explanation: string;
    readonly turn: { readonly status: string; readonly error: { readonly code: string } | null };
    readonly item: { readonly summary: string };
  };
  readonly createResponses: ReturnType<typeof vi.fn>;
}> {
  const dataRoot = mkdtempSync(join(tmpdir(), `openkit-administration-${options.label}-`));
  const coreDb = openCoreDb(dataRoot);
  openDatabases.push(coreDb);
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  const token = createOpenKitAccessTokenRecord(coreDb, {
    expiresAt: '2999-01-01T00:00:00.000Z',
    ownerUserId: 'user_local',
    scope: 'server-admin',
    tokenId: `tok_administration_${options.label}`,
    workspaceIds: [],
  });
  const actor: Actor = {
    kind: 'token',
    tokenId: token.tokenId,
    tokenScope: 'server-admin',
    tokenWorkspaceIds: [],
    userId: 'user_local',
  };
  const store = createDemoStore({ dataRoot });
  const workspaceId = quickChatWorkspaceIdForUser(actor.userId);
  const thread = store.createThread(
    workspaceId,
    'Administration',
    `thread_administration_${options.label}`,
    'administration'
  );
  const providerProfile = {
    baseUrl: 'https://provider.invalid/v1',
    displayName: 'Provider',
    id: 'provider',
    kind: 'custom' as const,
    modelMetadata: {
      model: {
        family: 'test',
        limit: { context: 20_000, output: 1_000 },
        modalities: { input: ['text'], output: ['text'] },
        ...(options.toolCall ? { tool_call: true } : {}),
      },
    },
    models: ['model'],
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
          contextManagement: [{ type: 'compaction', compactThreshold: 8_000 }],
          routes: [
            { id: 'primary', providerProfileId: providerProfile.id, providerModel: 'model' },
          ],
        },
      ],
    },
    internalRoleProfiles: {
      schemaVersion: 1,
      defaultLogicalModelId: 'administration',
      profiles: [],
    },
    providerRegistry: new ProviderRegistry([providerProfile]),
  });
  if (options.stripContextManagement) {
    profileResolverFixture.resolveInternalRoleProfile.mockImplementationOnce((input) => {
      const selection = profileResolverFixture.actual?.(input) ?? null;
      if (!selection) return null;
      return {
        ...selection,
        logicalModel: {
          ...selection.logicalModel,
          contextManagement: undefined,
        },
      } as ResolvedInternalRoleProfile;
    });
  }
  const createResponses = vi.fn();
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use('*', async (context, next) => {
    context.set('actor', actor);
    await next();
  });
  registerAdministrationRoutes({
    app,
    coreDb,
    environmentToolsForTurn: () => inertEnvironmentTools(),
    inflightCommands: new WeakMap(),
    llmGatewayDispatcher: { createResponses },
    mode: 'server',
    quickChatWorkspaceIdForUser,
    requestStore: () => store,
    runtimeConfigFiles: () => ({ listFiles: () => ({ files: [] }), readFile: vi.fn() }) as never,
    resolveGatewayProvider: () =>
      ({
        adapterId: 'provider',
        apiKey: 'unused',
        baseUrl: providerProfile.baseUrl,
        displayName: providerProfile.displayName,
        gatewayCapabilities: { chatCompletions: 'native', responses: 'native' },
        id: providerProfile.id,
        models: providerProfile.models,
        requiresApiKey: true,
      }) satisfies ResolvedLLMProviderConfig,
    runtimeConfig: () => snapshot,
  });

  const response = await app.request('/api/app/administration/conversation-turns', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      input: 'List retained Worker environments in my current Quick Chat Workspace.',
      requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      threadId: thread.id,
    }),
  });
  return {
    status: response.status,
    body: (await response.json()) as {
      outcome: string;
      explanation: string;
      turn: { status: string; error: { code: string } | null };
      item: { summary: string };
    },
    createResponses,
  };
}
