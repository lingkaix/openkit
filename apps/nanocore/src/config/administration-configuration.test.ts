import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerAdministrationRoutes } from '../administration/administration-routes.js';
import { createAdministrationConfigurationTools } from '../administration/configuration-tools.js';
import {
  createOpenKitAccessTokenRecord,
  revokeOpenKitAccessTokenRecord,
} from '../auth/access-token-store.js';
import { type Actor, ensureLocalUser } from '../auth/identity.js';
import type { AuthVariables } from '../auth/middleware.js';
import { FsStore, quickChatWorkspaceIdForUser } from '../lib/store.js';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { createAdministrationConfiguration } from './administration-configuration.js';
import { createRuntimeConfigManager } from './runtime-config.js';
import { RuntimeConfigFileService } from './runtime-config-files.js';

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

/** Real temporary configuration, private Artifact store and current durable token authority. */
function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-config-proposal-'));
  const coreDb = openCoreDb(dataRoot);
  cleanup.push(() => {
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  const token = createOpenKitAccessTokenRecord(coreDb, {
    tokenId: `tok_${randomUUID()}`,
    ownerUserId: 'user_local',
    scope: 'server-admin',
    workspaceIds: [],
    expiresAt: '2999-01-01T00:00:00.000Z',
  });
  const actor: Actor = {
    kind: 'token',
    userId: 'user_local',
    tokenId: token.tokenId,
    tokenScope: 'server-admin',
    tokenWorkspaceIds: [],
  };
  const store = createDemoStore({ dataRoot });
  const workspaceId = quickChatWorkspaceIdForUser(actor.userId);
  const thread = store.createThread(
    workspaceId,
    'Catalog update',
    `thread_${randomUUID()}`,
    'administration'
  );
  const turn = store.createTurn(
    workspaceId,
    thread.id,
    'Update catalog',
    { kind: 'user', id: actor.userId },
    null
  );
  const home = { threadId: thread.id, turnId: turn.id, requestId: randomUUID() };
  const provider = {
    id: 'codex',
    vendor: 'openai-codex',
    kind: 'oauth',
    displayName: 'Codex',
    models: ['gpt-5'],
    modelMetadata: { 'gpt-5': { limit: { context: 200000, output: 10000 }, tool_call: true } },
    extensions: {
      openkit: { subscriptionAccount: { accountSlotId: 'primary' } },
      private: { path: '/private/provider-account' },
    },
  };
  mkdirSync(join(dataRoot, 'config/providers'), { recursive: true });
  writeFileSync(join(dataRoot, 'config/server.jsonc'), JSON.stringify({ schemaVersion: 1 }));
  const providerPath = join(dataRoot, 'config/providers/catalog.provider.jsonc');
  writeFileSync(providerPath, JSON.stringify(provider));
  const logicalModel = {
    id: 'reasoning',
    displayName: 'Reasoning',
    contextManagement: [{ type: 'compaction', compactThreshold: 8000 }],
    routes: [{ id: 'primary', providerProfileId: 'codex', providerModel: 'gpt-5' }],
  };
  const gatewayPath = join(dataRoot, 'config/gateway.jsonc');
  writeFileSync(
    gatewayPath,
    JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      logicalModels: [logicalModel],
      defaultLogicalModelId: 'reasoning',
    })
  );
  const manager = createRuntimeConfigManager({ dataRoot });
  const files = new RuntimeConfigFileService({
    dataRoot,
    userId: actor.userId,
    workspaceIds: [workspaceId],
    runtimeConfigManager: manager,
    readRuntimeConfigStatus: () => manager.status(),
  });
  const reload = vi.fn(() => manager.reload({ mode: 'safe', dryRun: false }));
  const inflightCommands = new WeakMap();
  const options = { actor, coreDb, store, files, reload, inflightCommands };
  const service = createAdministrationConfiguration(options);
  const request = {
    targetFamily: 'provider' as const,
    targetId: 'codex',
    expectedRevision: files.readFile('providers/catalog.provider.jsonc').file.revision!,
    changes: {
      models: ['gpt-5', 'gpt-6'],
      modelMetadata: {
        ...provider.modelMetadata,
        'gpt-6': { limit: { context: 200000, output: 10000 }, tool_call: true },
      },
    },
  };
  const confirm = (proposal: ReturnType<typeof service.propose>) => ({
    requestId: randomUUID(),
    candidate: proposal.candidate,
    confirmation: proposal.confirmation,
  });
  return {
    ...options,
    dataRoot,
    home,
    manager,
    provider,
    providerPath,
    gatewayPath,
    logicalModel,
    service,
    request,
    confirm,
    token,
    workspaceId,
  };
}

describe('administration catalog configuration', () => {
  it('proposes through the Tool without writes, then applies exact Provider and Gateway catalogs', async () => {
    const f = fixture();
    const original = readFileSync(f.providerPath, 'utf8');
    const tools = createAdministrationConfigurationTools(f.manager.current(), f.files, {
      ...f.service,
      propose: (value) => f.service.propose(value, f.home),
    });
    const result = await tools[2].execute(f.request, {
      callId: 'provider',
      signal: new AbortController().signal,
    });
    expect(result.isError).not.toBe(true);
    const proposal = JSON.parse(
      result.content[0]!.type === 'text' ? result.content[0]!.text : '{}'
    );
    expect(proposal.preview.after.models).toEqual(['gpt-5', 'gpt-6']);
    expect(readFileSync(f.providerPath, 'utf8')).toBe(original);
    expect(JSON.stringify(proposal)).not.toContain('/private/provider-account');
    expect(JSON.stringify(proposal)).not.toContain('accountSlotId');
    expect(
      f.store
        .listThreadItems(f.workspaceId, f.home.threadId)
        .filter(
          (item) =>
            item.type === 'artifact-reference' && item.artifactId === proposal.candidate.artifactId
        )
    ).toHaveLength(1);
    const request = f.confirm(proposal);
    const applied = await f.service.apply(request);
    expect(applied).toMatchObject({ persisted: true, reload: 'applied', restartRequired: true });
    expect(JSON.parse(readFileSync(f.providerPath, 'utf8'))).toMatchObject({
      models: ['gpt-5', 'gpt-6'],
      extensions: f.provider.extensions,
    });
    expect(await f.service.apply(request)).toEqual(applied);
    expect(f.reload).toHaveBeenCalledTimes(1);
    const reopened = createAdministrationConfiguration({
      ...f,
      store: new FsStore({ dataRoot: f.dataRoot }),
    });
    expect(await reopened.apply(request)).toEqual(applied);
    expect(f.reload).toHaveBeenCalledTimes(1);
    const gateway = f.service.propose(
      {
        targetFamily: 'gateway',
        targetId: 'gateway',
        expectedRevision: f.files.readFile('gateway.jsonc').file.revision,
        changes: {
          logicalModels: [
            {
              ...f.logicalModel,
              routes: [{ id: 'primary', providerProfileId: 'codex', providerModel: 'gpt-6' }],
            },
          ],
        },
      },
      f.home
    );
    expect((await f.service.apply(f.confirm(gateway))).persisted).toBe(true);
    expect(
      JSON.parse(readFileSync(f.gatewayPath, 'utf8')).logicalModels[0].routes[0].providerModel
    ).toBe('gpt-6');
  });

  it('rejects unsupported fields, missing dependencies, stale revisions and changed confirmations without writes', async () => {
    const f = fixture();
    const original = readFileSync(f.providerPath, 'utf8');
    for (const changes of [
      { secretRef: 'secret' },
      { extensions: {} },
      { baseUrl: 'https://bad.invalid' },
      { models: [] },
      { modelMetadata: { missing: { tool_call: true } } },
    ]) {
      expect(() => f.service.propose({ ...f.request, changes }, f.home)).toThrow();
    }
    const gateway = {
      targetFamily: 'gateway',
      targetId: 'gateway',
      expectedRevision: f.files.readFile('gateway.jsonc').file.revision,
      changes: {
        logicalModels: [
          {
            ...f.logicalModel,
            routes: [{ id: 'primary', providerProfileId: 'missing', providerModel: 'gpt-6' }],
          },
        ],
      },
    };
    expect(() => f.service.propose(gateway, f.home)).toThrow();
    const proposal = f.service.propose(f.request, f.home);
    const request = f.confirm(proposal);
    await expect(
      f.service.apply({
        ...request,
        confirmation: { ...request.confirmation, contentDigest: `sha256:${'0'.repeat(64)}` },
      })
    ).rejects.toThrow();
    await expect(
      f.service.apply({
        ...request,
        candidate: { ...request.candidate, contentDigest: `sha256:${'0'.repeat(64)}` },
        confirmation: { ...request.confirmation, contentDigest: `sha256:${'0'.repeat(64)}` },
      })
    ).rejects.toMatchObject({ code: 'configuration_candidate_conflict' });
    expect(readFileSync(f.providerPath, 'utf8')).toBe(original);
    writeFileSync(f.providerPath, `${original}\n`);
    await expect(f.service.apply(request)).rejects.toMatchObject({
      code: 'config_revision_conflict',
    });
    expect(readFileSync(f.providerPath, 'utf8')).toBe(`${original}\n`);
    expect(f.reload).not.toHaveBeenCalled();
  });

  it('rechecks revoked authority before discovery, proposal, application and replay', async () => {
    const f = fixture();
    const proposal = f.service.propose(f.request, f.home);
    revokeOpenKitAccessTokenRecord(f.coreDb, f.token.tokenId);
    expect(() => f.service.read('provider')).toThrow();
    expect(() => f.service.propose(f.request, f.home)).toThrow();
    await expect(f.service.apply(f.confirm(proposal))).rejects.toThrow('administrator authority');
    expect(f.reload).not.toHaveBeenCalled();
  });

  it('retains persisted bytes and reports reload failure without repeating the effect', async () => {
    const f = fixture();
    const proposal = f.service.propose(f.request, f.home);
    f.reload.mockImplementation(() => {
      throw new Error('reload failed');
    });
    const request = f.confirm(proposal);
    const result = await f.service.apply(request);
    expect(result).toMatchObject({ persisted: true, reload: 'failed' });
    expect(JSON.parse(readFileSync(f.providerPath, 'utf8')).models).toContain('gpt-6');
    expect(await f.service.apply(request)).toEqual(result);
    expect(f.reload).toHaveBeenCalledTimes(1);
    await expect(
      f.service.apply({ ...request, candidate: { ...request.candidate, artifactId: 'missing' } })
    ).rejects.toThrow();
  });

  it('accepts Token-derived session authority, denies Workspace Tokens and hides foreign candidates', async () => {
    const f = fixture();
    const session = createAdministrationConfiguration({
      ...f,
      actor: { kind: 'session', userId: f.actor.userId },
    });
    const proposal = session.propose(f.request, f.home);
    expect(JSON.stringify(session.read('provider', 'codex'))).not.toContain('accountSlotId');
    expect(JSON.stringify(session.schema('provider'))).not.toContain('secretRef');
    const scoped = createAdministrationConfiguration({
      ...f,
      actor: {
        ...f.actor,
        kind: 'token',
        tokenId: f.token.tokenId,
        tokenScope: 'workspace',
        tokenWorkspaceIds: [f.workspaceId],
      },
    });
    await expect(scoped.apply(f.confirm(proposal))).rejects.toThrow('administrator authority');
    const foreign = f.store.createThread(
      'ws_demo',
      'Project thread',
      'thread_foreign',
      'administration'
    );
    expect(() => session.propose(f.request, { ...f.home, threadId: foreign.id })).toThrow();
    expect((await session.apply(f.confirm(proposal))).persisted).toBe(true);
  });

  it('conflicts on changed input under one request ID and fences interrupted writes', async () => {
    const f = fixture();
    const first = f.service.propose(f.request, f.home);
    const second = f.service.propose(
      { ...f.request, changes: { displayName: 'Renamed Codex' } },
      f.home
    );
    const request = f.confirm(first);
    await f.service.apply(request);
    await expect(
      f.service.apply({ ...f.confirm(second), requestId: request.requestId })
    ).rejects.toMatchObject({ code: 'idempotency_key_conflict' });
    const next = f.service.propose(
      {
        ...f.request,
        expectedRevision: f.files.readFile('providers/catalog.provider.jsonc').file.revision,
        changes: { displayName: 'Updated Codex' },
      },
      f.home
    );
    const nextRequest = f.confirm(next);
    const write = vi.spyOn(f.files, 'updateFile').mockImplementation(() => {
      throw new Error('interrupted write');
    });
    await expect(f.service.apply(nextRequest)).rejects.toMatchObject({
      code: 'configuration_recovery_required',
    });
    await expect(f.service.apply(nextRequest)).rejects.toMatchObject({
      code: 'configuration_recovery_required',
    });
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('exposes human apply through the administration route and denies revoked tokens', async () => {
    const f = fixture();
    const app = new Hono<{ Variables: AuthVariables }>();
    app.use('*', async (context, next) => {
      context.set('actor', f.actor);
      await next();
    });
    registerAdministrationRoutes({
      app,
      coreDb: f.coreDb,
      requestStore: () => f.store,
      runtimeConfigFiles: () => f.files,
      reloadRuntimeConfig: f.reload,
      inflightCommands: f.inflightCommands,
      mode: 'server',
      quickChatWorkspaceIdForUser,
      runtimeConfig: () => f.manager.current(),
    } as never);
    const request = f.confirm(f.service.propose(f.request, f.home));
    const send = () =>
      app.request('/api/app/administration/configuration/apply', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
      });
    const response = await send();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ persisted: true });
    revokeOpenKitAccessTokenRecord(f.coreDb, f.token.tokenId);
    expect((await send()).status).toBe(403);
  });
});
