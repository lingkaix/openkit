import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { Server as HttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { serve } from '@hono/node-server';
import { resolveWorkspaceMcpServer, type WorkspaceMcpServerCatalog } from '@openkit/config-schema';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDefaultWorkerControlGateway } from './app.js';
import { createOpenKitAccessTokenRecord } from './auth/access-token-store.js';
import { ensureLocalUser } from './auth/identity.js';
import {
  composeWorkspaceMcpCatalog,
  createMcpConfig,
  loadResourceCatalog,
  removeMcpEntry,
  setSharedMcpDisabled,
  updateMcpBinding,
} from './catalog/resource-catalog.js';
import {
  createInMemoryRuntimeConfigSnapshot,
  createRuntimeConfigManager,
} from './config/runtime-config.js';
import { FsStore } from './lib/store.js';
import { ProviderRegistry } from './providers/registry.js';
import { recordAgentEnvironmentPackageSnapshot } from './runtime/aep-snapshot-ledger.js';
import { resolveAgentEnvironmentPackage } from './runtime/agent-environment.js';
import {
  acceptSchedulerExecutionObservation,
  schedulerExecutionCorrelation,
} from './runtime/execution-attempt-records.js';
import { bindNanoHostAttemptRouteTokenHashes } from './runtime/nanohost-attempt-records.js';
import { listThreadPendingRequests, readPendingRequest } from './runtime/pending-requests.js';
import { createDefaultWorkerMcpGateway } from './runtime/worker-mcp-gateway.js';
import { createSchedulerAdmissionEntry } from './scheduler-records.js';
import { openCoreDb, openWorkspaceDb } from './storage/db.js';
import { applyMigrations, applyScopedMigrations } from './storage/migrate.js';
import { createTestAgentSetup, createTestGatewayConfig } from './test-support/agent-environment.js';
import { createApp } from './test-support/app.js';
import { recordTestExecutionAttempt } from './test-support/execution-attempt.js';
import { createMcpHttpStub } from './test-support/mcp-http-stub.js';
import { admitTestNativeEnvironment } from './test-support/native-environment.js';
import { advanceActiveVaultReferenceVersion } from './vault/vault-references.js';
import { createVaultUnlockState } from './vault/vault-unlock-state.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

const serverId = 'shared-echo';
const canary = 'synthetic-server-mcp-"quoted\\slash-canary';
const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0).reverse()) await close();
});

/** Holds a real upstream discovery response while canonical authority changes. */
async function controlledUpstream() {
  const upstream = await createMcpHttpStub({ protocolEra: '2026-07-28' });
  cleanups.push(() => upstream.close());
  let hold = false;
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const methods: string[] = [];
  const relay = new Hono();
  relay.all('/mcp', async (context) => {
    const request = context.req.raw;
    const body = request.method === 'POST' ? await request.clone().text() : undefined;
    const method = body ? String(JSON.parse(body).method ?? '') : request.method;
    methods.push(method);
    const headers = new Headers(request.headers);
    headers.delete('host');
    const response = await fetch(upstream.url, {
      method: request.method,
      headers,
      body,
      signal: request.signal,
      redirect: 'error',
    });
    if (hold && (method === 'server/discover' || method === 'tools/list')) {
      entered.resolve();
      await release.promise;
    }
    return response;
  });
  const http = await new Promise<HttpServer>((resolve) => {
    const listener = serve({ fetch: relay.fetch, hostname: '127.0.0.1', port: 0 }, () =>
      resolve(listener as HttpServer)
    );
  });
  cleanups.push(async () => {
    release.resolve();
    await new Promise<void>((resolve, reject) =>
      http.close((error) => (error ? reject(error) : resolve()))
    );
  });
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('Local MCP relay did not bind.');
  return {
    upstream,
    methods,
    url: `http://127.0.0.1:${address.port}/mcp`,
    holdDiscovery: () => {
      hold = true;
      return entered.promise;
    },
    releaseDiscovery: () => {
      hold = false;
      release.resolve();
    },
  };
}

/** Real administrator, catalog consumers, Vault, token binding and Worker MCP route assembly. */
async function fixture() {
  const upstream = await controlledUpstream();
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-server-shared-mcp-'));
  cleanups.push(() => rmSync(dataRoot, { recursive: true, force: true }));
  const coreDb = openCoreDb(dataRoot);
  cleanups.push(() => coreDb.sqlite.close());
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  const store = new FsStore({ dataRoot });
  const workspaces = [
    store.createWorkspace('First consumer'),
    store.createWorkspace('Second consumer'),
  ];
  const workspaceDbs = workspaces.map((workspace) => {
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'user_local',
      workspaceId: workspace.id,
    });
    const db = openWorkspaceDb(dataRoot, workspace.id);
    applyScopedMigrations(db);
    cleanups.push(() => db.sqlite.close());
    return db;
  });
  const admin = createOpenKitAccessTokenRecord(coreDb, {
    ownerUserId: 'user_local',
    scope: 'server-admin',
    workspaceIds: [],
    expiresAt: '2999-01-01T00:00:00.000Z',
  });
  const vaultUnlockState = createVaultUnlockState({
    backendKind: 'encrypted-file',
    storeDir: join(dataRoot, 'server/vault'),
  });
  vaultUnlockState.unlock({ masterKey: Buffer.alloc(32, 7) });
  cleanups.push(() => {
    vaultUnlockState.lock();
  });
  const materialResolution = vi.spyOn(vaultUnlockState.backend(), 'resolve');
  const manager = createRuntimeConfigManager({
    dataRoot,
    initialSnapshot: createInMemoryRuntimeConfigSnapshot({
      dataRoot,
      openKitConfig: { mode: 'server' },
      agentManifests: [createTestAgentSetup({ mcpIds: [serverId] }).manifest],
      gatewayConfig: createTestGatewayConfig(),
      providerRegistry: new ProviderRegistry([
        {
          id: 'agent-openrouter',
          displayName: 'Synthetic provider',
          kind: 'local',
          models: ['openai/gpt-5.2'],
        },
      ]),
    }),
  });
  const workerControlGateway = createDefaultWorkerControlGateway(coreDb);
  const workerMcpGateway = createDefaultWorkerMcpGateway(coreDb);
  cleanups.push(() => workerMcpGateway.close());
  const app = createApp({
    coreDb,
    dataRoot,
    store,
    mode: 'server',
    runtimeConfigManager: manager,
    vaultUnlockState,
    workerControlGateway,
    workerMcpGateway,
    auth: {
      api: { getSession: async () => null },
      handler: async () => new Response(null, { status: 404 }),
    },
  });
  const outputs: unknown[] = [];
  const send = (operation: string, input: Record<string, unknown> = {}, secret = admin.secret) => {
    const { requestId = randomUUID(), ...body } = input;
    return app.request(`/api/app/operations/${operation}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${secret}`,
        'content-type': 'application/json',
        'x-openkit-request-id': String(requestId),
      },
      body: JSON.stringify(body),
    });
  };
  const call = async (operation: string, input: Record<string, unknown> = {}) => {
    const response = await send(operation, input);
    expect([200, 201], await response.clone().text()).toContain(response.status);
    const body = await response.json();
    outputs.push(body);
    return body;
  };

  /** Resolves and registers one exact package using actual capability tokens and durable hashes. */
  const worker = async (workspaceId: string, catalog?: WorkspaceMcpServerCatalog) => {
    const admittedCatalog =
      catalog ??
      manager
        .current()
        .workspaceMcpServerCatalogs.find((entry) => entry.workspaceId === workspaceId)?.catalog;
    const thread = store.createThread(workspaceId, 'Consume shared MCP', randomUUID());
    const turn = store.createTurn(workspaceId, thread.id, 'Call echo', {
      kind: 'user',
      id: 'user_local',
    });
    const setup = createTestAgentSetup({ mcpIds: [serverId] });
    admitTestNativeEnvironment(coreDb, setup.manifest);
    const pkg = resolveAgentEnvironmentPackage({
      coreDb,
      agentSetup: setup,
      agentSessionId: randomUUID(),
      backend: { kind: 'openshell' },
      captureCoverage: { scope: 'server', value: 'off' },
      requestId: randomUUID(),
      turn,
      triggerActor: turn.triggerActor,
      workspaceCwd: '/workspace',
      workspaceRoots: [],
      ...(admittedCatalog ? { workspaceMcpServerCatalog: admittedCatalog } : {}),
    });
    const db = workspaceDbs.find((candidate) => candidate.workspaceId === workspaceId)!;
    recordAgentEnvironmentPackageSnapshot(db, {
      environmentPackage: pkg,
      createdAt: new Date().toISOString(),
    });
    store.createAgentSession({
      id: pkg.scope.agentSessionId,
      workspaceId,
      threadId: thread.id,
      agentId: pkg.agent.agentId,
      status: 'busy',
      message: null,
      environmentPackageSnapshotId: pkg.snapshotId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    store.updateTurn(turn.id, {
      agentId: pkg.agent.agentId,
      agentSessionId: pkg.scope.agentSessionId,
    });
    const admission = createSchedulerAdmissionEntry(coreDb, {
      backendId: 'nanohost',
      queueEntryId: randomUUID(),
      requestId: pkg.scope.requestId,
      triggerActor: pkg.scope.triggerActor,
      workspaceId,
      threadId: thread.id,
      turnId: turn.id,
      turnInput: 'Call echo',
      requestedAgentId: pkg.agent.agentId,
    });
    const bindingRef = `binding_${turn.id}`;
    const attempt = recordTestExecutionAttempt(coreDb, {
      entry: admission,
      attemptId: randomUUID(),
      agentSessionId: pkg.scope.agentSessionId,
      inputRef: pkg.snapshotId,
      bindingRef,
      sessionCompatibilityKey: 'shared-mcp-fixture',
      operationId: randomUUID(),
      now: () => new Date().toISOString(),
    });
    const registration = workerControlGateway.registerSession(pkg, {
      sandboxBindingRef: bindingRef,
    });
    bindNanoHostAttemptRouteTokenHashes(coreDb, {
      attemptId: attempt.attemptId,
      sandboxBindingRef: bindingRef,
      workerControlTokenHash: registration.workerControlTokenHash,
      workerInferenceTokenHash: registration.workerInferenceTokenHash,
      workerCapabilityTokenHash: registration.workerCapabilityTokenHash,
    });
    expect(
      acceptSchedulerExecutionObservation(coreDb, {
        ...schedulerExecutionCorrelation(attempt),
        disposition: 'accepted',
        execution: 'running',
        fenceRef: null,
        outcomeRef: null,
      })?.disposition
    ).toBe('accepted');
    outputs.push(pkg);
    const invokeMcp = async (
      method: 'tools/call' | 'tools/list',
      params: Record<string, unknown>
    ) => {
      const response = await app.request(`/api/worker-capabilities/mcp/${serverId}`, {
        method: 'POST',
        headers: {
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
          authorization: `Bearer ${registration.workerCapabilityToken}`,
        },
        body: JSON.stringify({
          id: randomUUID(),
          jsonrpc: '2.0',
          method,
          params,
        }),
      });
      const body = await response.json();
      outputs.push(body);
      return { status: response.status, body };
    };
    return {
      pkg,
      workspaceId,
      call: (message: string) => invokeMcp('tools/call', { name: 'echo', arguments: { message } }),
      list: () => invokeMcp('tools/list', {}),
    };
  };
  const noLocalCatalog = () => {
    for (const workspace of workspaces)
      expect(existsSync(join(dataRoot, 'workspaces', workspace.id, 'catalog/catalog.json'))).toBe(
        false
      );
  };
  return {
    app,
    call,
    send,
    coreDb,
    store,
    dataRoot,
    manager,
    admin,
    vaultUnlockState,
    upstream,
    workspaces,
    workspaceDbs,
    worker,
    noLocalCatalog,
    outputs,
    materialResolution,
  };
}

/** Creates shared material and an explicit tool allowlist through current-admin operations. */
async function sharedSetup(f: Awaited<ReturnType<typeof fixture>>) {
  const reference = await f.call('vault.server-mcp-secret-create', { material: canary });
  expect(reference).toMatchObject({
    ownerScope: 'server',
    workspaceId: null,
    secretKind: 'mcp-credential',
  });
  const grant = await f.call('vault.server-mcp-grant-create', {
    referenceId: reference.referenceId,
  });
  expect(grant).toMatchObject({
    ownerScope: 'server',
    workspaceId: null,
    lifetime: 'server',
    allowedInjectionPaths: ['gateway-only'],
  });
  await f.call('administration.server-mcp-create', {
    id: serverId,
    displayName: 'Shared echo',
    expectedRevision: 0,
    allowedTools: ['echo'],
    declaration: { kind: 'http', endpoint: f.upstream.url },
  });
  const catalog = loadResourceCatalog(f.dataRoot, { kind: 'server' });
  const binding = catalog.mcp.bindings.find((entry) => entry.entryId === serverId)!;
  await f.call('administration.server-mcp-update-binding', {
    mcpId: serverId,
    expectedRevision: catalog.revision,
    bindingRevision: binding.revision,
    enabled: true,
    allowedTools: ['echo'],
    schemaPolicy: 'tracking',
    credentialBindings: [
      {
        slot: 'auth',
        vaultGrantId: grant.grantId,
        presentation: 'bearer',
        sink: { kind: 'header', name: 'Authorization' },
      },
    ],
  });
  f.noLocalCatalog();
  return { reference, grant };
}

/** Checks the normalized refusal while excluding broken authentication or test routing. */
function expectRefusal(result: { status: number; body: unknown }) {
  expect(result.body).toMatchObject({
    error: {
      data: {
        code: expect.stringMatching(/^mcp-(denied|server-unavailable|call-failed)$/),
      },
    },
  });
  expect(result.status).not.toBe(401);
}

/** Seeds canonical Server metadata through its actual scoped owner, without an HTTP account. */
function catalogFixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-shared-mcp-origin-'));
  cleanups.push(() => rmSync(dataRoot, { recursive: true, force: true }));
  const owner = { kind: 'server' as const };
  const created = createMcpConfig({
    owner,
    dataRoot,
    id: serverId,
    displayName: 'Shared origin',
    expectedRevision: 0,
    createdAt: '2026-10-16T00:00:00.000Z',
    selectCurrent: true,
    allowedTools: ['echo'],
    declaration: { kind: 'http', endpoint: 'https://mcp.example.test/mcp' },
  });
  const server = updateMcpBinding({
    owner,
    dataRoot,
    entryId: serverId,
    expectedRevision: created.catalog.revision,
    binding: { ...created.catalog.mcp.bindings[0]!, enabled: true },
  });
  return { dataRoot, server };
}

describe('shared catalog origin', () => {
  it('projects the Server origin into two unpublished Workspaces without creating copied catalogs or Server process data', () => {
    const f = catalogFixture();
    const first = composeWorkspaceMcpCatalog({ dataRoot: f.dataRoot, workspaceId: 'first' });
    const second = composeWorkspaceMcpCatalog({ dataRoot: f.dataRoot, workspaceId: 'second' });
    expect(first.servers).toHaveLength(1);
    expect(first.servers[0]).toMatchObject({ id: serverId, scope: 'server' });
    expect(second).toEqual(first);
    const local = structuredClone(first);
    delete local.servers[0]!.scope;
    expect(resolveWorkspaceMcpServer({ catalog: first, serverId }).catalogDigest).not.toBe(
      resolveWorkspaceMcpServer({ catalog: local, serverId }).catalogDigest
    );
    for (const id of ['first', 'second'])
      expect(existsSync(join(f.dataRoot, 'workspaces', id, 'catalog/catalog.json'))).toBe(false);
    expect(existsSync(join(f.dataRoot, 'server/catalog/mcp-data'))).toBe(false);
  });

  it('suppresses shared credentials behind an inactive local entry and its later tombstone', () => {
    const f = catalogFixture();
    const path = join(f.dataRoot, 'server/catalog/catalog.json');
    const before = readFileSync(path, 'utf8');
    const owner = { kind: 'workspace' as const, workspaceId: 'consumer' };
    const local = createMcpConfig({
      owner,
      dataRoot: f.dataRoot,
      id: serverId,
      displayName: 'Local collision',
      expectedRevision: 0,
      createdAt: '2026-10-16T00:00:00.000Z',
      selectCurrent: true,
      allowedTools: ['echo'],
      declaration: { kind: 'http', endpoint: 'https://local.example.test/mcp' },
    });
    const inactive = composeWorkspaceMcpCatalog({ dataRoot: f.dataRoot, workspaceId: 'consumer' });
    expect(inactive.servers).toHaveLength(1);
    expect(inactive.servers[0]).toMatchObject({ id: serverId, enabled: false });
    expect(inactive.servers[0]?.scope).toBeUndefined();
    removeMcpEntry({
      owner,
      dataRoot: f.dataRoot,
      mcpId: serverId,
      expectedRevision: local.catalog.revision,
    });
    expect(
      composeWorkspaceMcpCatalog({ dataRoot: f.dataRoot, workspaceId: 'consumer' }).servers
    ).toEqual([]);
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('keeps exact disabled Server ids in the consuming Workspace owner', () => {
    const f = catalogFixture();
    setSharedMcpDisabled({
      dataRoot: f.dataRoot,
      workspaceId: 'first',
      mcpId: serverId,
      disabled: true,
      expectedRevision: 0,
    });
    expect(
      loadResourceCatalog(f.dataRoot, { kind: 'workspace', workspaceId: 'first' }).mcp
        .disabledServerIds
    ).toEqual([serverId]);
    expect(
      composeWorkspaceMcpCatalog({ dataRoot: f.dataRoot, workspaceId: 'first' }).servers
    ).toEqual([]);
    expect(
      composeWorkspaceMcpCatalog({ dataRoot: f.dataRoot, workspaceId: 'second' }).servers
    ).toHaveLength(1);
    expect(loadResourceCatalog(f.dataRoot, { kind: 'server' })).toEqual(f.server);
  });
});

it('reaches the existing Workspace Gateway with real registered capability tokens', async () => {
  const f = await fixture();
  const workspaceId = f.workspaces[0]!.id;
  const reference = await f.call('vault.secret-create', {
    workspaceId,
    secretKind: 'github-token',
    material: canary,
  });
  const grant = await f.call('vault.grant-create', {
    workspaceId,
    referenceId: reference.referenceId,
  });
  const owner = { kind: 'workspace' as const, workspaceId };
  const created = createMcpConfig({
    owner,
    dataRoot: f.dataRoot,
    id: serverId,
    displayName: 'Workspace baseline',
    expectedRevision: 0,
    createdAt: new Date().toISOString(),
    selectCurrent: true,
    allowedTools: ['echo'],
    declaration: { kind: 'http', endpoint: f.upstream.url },
  });
  updateMcpBinding({
    owner,
    dataRoot: f.dataRoot,
    entryId: serverId,
    expectedRevision: created.catalog.revision,
    binding: {
      ...created.catalog.mcp.bindings[0]!,
      enabled: true,
      credentialBindings: [
        {
          slot: 'auth',
          vaultGrantId: grant.grantId,
          presentation: 'bearer',
          sink: { kind: 'header', name: 'Authorization' },
        },
      ],
    },
  });
  expect(f.manager.reload({ mode: 'safe', dryRun: false }).status).toBe('applied');
  const worker = await f.worker(
    workspaceId,
    composeWorkspaceMcpCatalog({ dataRoot: f.dataRoot, workspaceId })
  );
  const result = await worker.call('baseline');
  expect(result.status).toBe(200);
  expect(result.body).toMatchObject({ result: { content: [{ type: 'text', text: 'baseline' }] } });
});

describe('Server-shared MCP through governed Worker routes', () => {
  it('does not activate a saved Workspace MCP declaration when the admitted Workspace catalog is absent', async () => {
    const f = await fixture();
    const workspaceId = f.workspaces[0]!.id;
    const owner = { kind: 'workspace' as const, workspaceId };
    const created = createMcpConfig({
      dataRoot: f.dataRoot,
      owner,
      createdAt: new Date().toISOString(),
      declaration: { kind: 'http', endpoint: f.upstream.url },
      displayName: 'Saved local entry',
      expectedRevision: 0,
      id: serverId,
      allowedTools: ['echo'],
      selectCurrent: true,
    });
    updateMcpBinding({
      dataRoot: f.dataRoot,
      owner,
      entryId: serverId,
      expectedRevision: 1,
      binding: { ...created.catalog.mcp.bindings[0]!, enabled: true },
    });
    expect(loadResourceCatalog(f.dataRoot, owner).mcp.bindings[0]!.enabled).toBe(true);
    await expect(f.worker(workspaceId)).rejects.toThrow(
      'Workspace MCP server catalog is required by the selected Agent.'
    );
    expect(f.materialResolution).not.toHaveBeenCalled();
    expect(f.upstream.methods).toEqual([]);
  });

  it('serves two Workspaces without copied catalogs and keeps one Workspace disable local', async () => {
    const f = await fixture();
    const { grant } = await sharedSetup(f);
    const workers = await Promise.all(f.workspaces.map((workspace) => f.worker(workspace.id)));
    for (const [index, worker] of workers.entries()) {
      const result = await worker.call(`safe-${index}`);
      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({
        result: { content: [{ type: 'text', text: `safe-${index}` }] },
      });
    }
    f.noLocalCatalog();
    expect(f.upstream.upstream.observedHeaders.length).toBeGreaterThan(0);
    expect(
      f.upstream.upstream.observedHeaders.every(
        (headers) => headers.get('authorization') === `Bearer ${canary}`
      )
    ).toBe(true);
    const uses = f.coreDb.sqlite
      .prepare(
        'SELECT owner_scope, workspace_id, grant_id, audit_event_id, agent_session_id, capability_call_id FROM vault_use_records WHERE outcome = ?'
      )
      .all('succeeded') as {
      owner_scope: string;
      workspace_id: string | null;
      grant_id: string;
      audit_event_id: string | null;
      agent_session_id: string;
      capability_call_id: string;
    }[];
    expect(uses.length).toBeGreaterThanOrEqual(2);
    expect(
      uses.every(
        (use) =>
          use.owner_scope === 'server' &&
          use.workspace_id === null &&
          use.grant_id === grant.grantId &&
          use.audit_event_id !== null
      )
    ).toBe(true);
    const audits = [f.coreDb, ...f.workspaceDbs].flatMap((db) =>
      db.sqlite.prepare('SELECT * FROM audit_events').all()
    ) as Record<string, unknown>[];
    for (const use of uses) {
      const worker = workers.find(
        (entry) => entry.pkg.scope.agentSessionId === use.agent_session_id
      )!;
      expect(worker).toBeDefined();
      const audit = audits.find((entry) => entry.audit_event_id === use.audit_event_id);
      expect(audit).toMatchObject({
        workspace_id: worker.workspaceId,
        capability_call_id: use.capability_call_id,
        vault_grant_id: grant.grantId,
      });
      expect(JSON.parse(String(audit!.actor_json))).toEqual({ kind: 'user', id: 'user_local' });
    }
    for (const db of f.workspaceDbs) {
      expect(db.sqlite.prepare('SELECT COUNT(*) AS count FROM vault_use_records').get()).toEqual({
        count: 0,
      });
      const calls = db.sqlite
        .prepare('SELECT COUNT(*) AS count FROM capability_calls WHERE status = ?')
        .get('succeeded') as { count: number };
      expect(calls.count).toBeGreaterThan(0);
    }
    await f.call('catalog.shared-mcp-set-disabled', {
      workspaceId: f.workspaces[0]!.id,
      mcpId: serverId,
      disabled: true,
      expectedRevision: 0,
    });
    const contacts = f.upstream.methods.length;
    const resolutions = f.materialResolution.mock.calls.length;
    expectRefusal(await workers[0]!.call('blocked'));
    expect(f.upstream.methods).toHaveLength(contacts);
    expect(f.materialResolution).toHaveBeenCalledTimes(resolutions);
    expect((await workers[1]!.call('still-available')).body).toMatchObject({
      result: { content: [{ text: 'still-available' }] },
    });
    expect(
      existsSync(join(f.dataRoot, 'workspaces', f.workspaces[1]!.id, 'catalog/catalog.json'))
    ).toBe(false);
    for (const workspace of f.workspaces) {
      f.outputs.push(await f.call('catalog.shared-mcp-list', { workspaceId: workspace.id }));
    }
    f.outputs.push(f.store.listAllItems(), f.store.listCommandRequests());
    for (const db of [f.coreDb]) {
      for (const table of [
        'audit_events',
        'vault_use_records',
        'vault_injection_plans',
        'vault_injection_receipts',
      ]) {
        f.outputs.push(db.sqlite.prepare(`SELECT * FROM ${table}`).all());
      }
    }
    for (const db of f.workspaceDbs) {
      for (const table of [
        'audit_events',
        'vault_use_records',
        'capability_calls',
        'mcp_tool_schema_snapshots',
        'usage_records',
      ]) {
        f.outputs.push(db.sqlite.prepare(`SELECT * FROM ${table}`).all());
      }
    }
    const publicBytes = JSON.stringify(f.outputs);
    expect(publicBytes).not.toContain(canary);
    expect(publicBytes).not.toContain(JSON.stringify(canary).slice(1, -1));
  });

  it('refuses a canonical Workspace copy of the endpoint, binding and Server grant before resolution or contact', async () => {
    const f = await fixture();
    const { grant } = await sharedSetup(f);
    const workspaceId = f.workspaces[0]!.id;
    const owner = { kind: 'workspace' as const, workspaceId };
    const created = createMcpConfig({
      owner,
      dataRoot: f.dataRoot,
      id: serverId,
      displayName: 'Local copy',
      expectedRevision: 0,
      createdAt: new Date().toISOString(),
      selectCurrent: true,
      allowedTools: ['echo'],
      declaration: { kind: 'http', endpoint: f.upstream.url },
    });
    updateMcpBinding({
      owner,
      dataRoot: f.dataRoot,
      entryId: serverId,
      expectedRevision: created.catalog.revision,
      binding: {
        ...created.catalog.mcp.bindings[0]!,
        enabled: true,
        credentialBindings: [
          {
            slot: 'auth',
            vaultGrantId: grant.grantId,
            presentation: 'bearer',
            sink: { kind: 'header', name: 'Authorization' },
          },
        ],
      },
    });
    expect(f.manager.reload({ mode: 'safe', dryRun: false }).status).toBe('applied');
    for (const forgedOrigin of [false, true]) {
      const catalog = composeWorkspaceMcpCatalog({ dataRoot: f.dataRoot, workspaceId });
      if (forgedOrigin) catalog.servers[0]!.scope = 'server';
      const contacts = f.upstream.methods.length;
      const resolutions = f.materialResolution.mock.calls.length;
      if (forgedOrigin) {
        await expect(f.worker(workspaceId, catalog)).rejects.toThrow(
          'Workspace MCP server not found'
        );
      } else {
        const worker = await f.worker(workspaceId);
        expectRefusal(await worker.call('must-not-contact'));
      }
      expect(f.materialResolution).toHaveBeenCalledTimes(resolutions);
      expect(f.upstream.methods).toHaveLength(contacts);
    }
  });

  it('refuses contradictory Server backend classification before material resolution or upstream contact', async () => {
    const f = await fixture();
    await sharedSetup(f);
    const worker = await f.worker(f.workspaces[0]!.id);
    const backend = f.vaultUnlockState.backend();
    const inventory = backend.listReferences.bind(backend);
    vi.spyOn(backend, 'listReferences').mockImplementation((input) =>
      inventory(input).map((item) => ({
        ...item,
        providerSubscriptionAccount: {
          accountSlotId: 'synthetic-slot',
          subscriptionProviderId: 'openai-codex' as const,
        },
      }))
    );
    expectRefusal(await worker.call('must-not-resolve'));
    expect(f.materialResolution).not.toHaveBeenCalled();
    expect(f.upstream.methods).toEqual([]);
  });

  it.each([
    'current',
    'grant-revoked',
    'server-disabled',
  ] as const)('executes captured shared approval only with %s authority', async (authority) => {
    const f = await fixture();
    const { grant } = await sharedSetup(f);
    const catalog = loadResourceCatalog(f.dataRoot, { kind: 'server' });
    const binding = catalog.mcp.bindings.find((item) => item.entryId === serverId)!;
    await f.call('administration.server-mcp-update-binding', {
      mcpId: serverId,
      expectedRevision: catalog.revision,
      bindingRevision: binding.revision,
      enabled: true,
      allowedTools: ['echo'],
      approvalRequiredTools: ['echo'],
      schemaPolicy: 'tracking',
    });
    const worker = await f.worker(f.workspaces[0]!.id);
    expect((await worker.list()).body).toMatchObject({ result: { tools: expect.any(Array) } });
    expect((await worker.call('approved-shared-message')).body).toMatchObject({
      result: { structuredContent: { status: 'pending-approval' } },
    });
    const db = f.workspaceDbs[0]!;
    const records = listThreadPendingRequests(
      db.sqlite,
      worker.workspaceId,
      worker.pkg.scope.threadId
    );
    expect(records).toHaveLength(1);
    const pending = records[0]!;
    expect(f.upstream.methods).not.toContain('tools/call');
    if (authority === 'grant-revoked') {
      await f.call('vault.server-mcp-grant-revoke', { grantId: grant.grantId });
    } else if (authority === 'server-disabled') {
      const current = loadResourceCatalog(f.dataRoot, { kind: 'server' });
      const currentBinding = current.mcp.bindings.find((item) => item.entryId === serverId)!;
      await f.call('administration.server-mcp-update-binding', {
        mcpId: serverId,
        expectedRevision: current.revision,
        bindingRevision: currentBinding.revision,
        enabled: false,
        allowedTools: ['echo'],
        approvalRequiredTools: ['echo'],
        schemaPolicy: 'tracking',
      });
    }
    await f.call('approval.respond', {
      workspaceId: worker.workspaceId,
      threadId: pending.threadId,
      turnId: pending.raisingTurnId,
      approvalRequestId: pending.requestId,
      decision: 'granted',
    });
    const settled = readPendingRequest(db.sqlite, pending.requestId)!;
    if (authority === 'current') {
      expect(settled.disposition).toBe('approved-executed');
      expect(f.upstream.methods.filter((method) => method === 'tools/call')).toHaveLength(1);
    } else {
      expect(settled.disposition).not.toBe('approved-executed');
      expect(f.upstream.methods).not.toContain('tools/call');
    }
    expect(JSON.stringify(f.outputs)).not.toContain(canary);
  });

  it.each([
    'rotate',
    'rotate-canonical-only',
    'lock',
  ] as const)('rechecks %s material after asynchronous discovery and sends no tools/call', async (change) => {
    const f = await fixture();
    const { reference } = await sharedSetup(f);
    const worker = await f.worker(f.workspaces[0]!.id);
    const entered = f.upstream.holdDiscovery();
    const pending = worker.call('must-not-use-stale-material');
    try {
      await Promise.race([
        entered,
        pending.then(() => {
          throw new Error('Worker request settled before the discovery gate.');
        }),
      ]);
      let mutation: Promise<unknown> = Promise.resolve();
      if (change === 'lock') {
        f.vaultUnlockState.lock();
      } else if (change === 'rotate-canonical-only') {
        // Keep the connection alive to isolate the final material identity check from teardown.
        const rotated = f.vaultUnlockState.backend().rotate({
          referenceId: reference.referenceId,
          material: 'synthetic-rotated-shared-material',
        });
        advanceActiveVaultReferenceVersion(f.coreDb, {
          referenceId: reference.referenceId,
          currentVersion: rotated.currentVersion,
        });
      } else {
        mutation = f.call('vault.server-mcp-secret-rotate', {
          referenceId: reference.referenceId,
          material: 'synthetic-rotated-shared-material',
        });
        await vi.waitFor(() => {
          expect(
            f.vaultUnlockState
              .backend()
              .listReferences()
              .find((item) => item.referenceId === reference.referenceId)?.currentVersion
          ).toBe(2);
        });
      }
      f.upstream.releaseDiscovery();
      await mutation;
      expectRefusal(await pending);
      expect(f.upstream.methods).not.toContain('tools/call');
    } finally {
      f.upstream.releaseDiscovery();
      await pending;
    }
  });

  it.each([
    'grant-revoke',
    'server-disable',
    'server-disable-canonical-only',
  ] as const)('rechecks %s after asynchronous discovery and sends no tools/call', async (change) => {
    const f = await fixture();
    const { grant } = await sharedSetup(f);
    const workspaceId = f.workspaces[0]!.id;
    const worker = await f.worker(workspaceId);
    const entered = f.upstream.holdDiscovery();
    const pending = worker.call('must-not-dispatch');
    try {
      await Promise.race([
        entered,
        pending.then(() => {
          throw new Error('Worker request settled before the discovery gate.');
        }),
      ]);
      const mutation =
        change === 'grant-revoke'
          ? f.call('vault.server-mcp-grant-revoke', { grantId: grant.grantId })
          : (() => {
              const catalog = loadResourceCatalog(f.dataRoot, { kind: 'server' });
              const binding = catalog.mcp.bindings.find((entry) => entry.entryId === serverId)!;
              if (change === 'server-disable-canonical-only') {
                // Keep the transport alive and loaded config unchanged to isolate the final canonical effect check.
                return Promise.resolve(
                  updateMcpBinding({
                    dataRoot: f.dataRoot,
                    owner: { kind: 'server' },
                    entryId: serverId,
                    expectedRevision: catalog.revision,
                    binding: { ...binding, enabled: false },
                  })
                );
              }
              return f.call('administration.server-mcp-update-binding', {
                mcpId: serverId,
                expectedRevision: catalog.revision,
                bindingRevision: binding.revision,
                enabled: false,
                allowedTools: ['echo'],
                schemaPolicy: 'tracking',
              });
            })();
      // The catalog/Vault mutation may also await connection cleanup; release after authority commits.
      await vi.waitFor(() => {
        if (change !== 'grant-revoke') {
          expect(
            loadResourceCatalog(f.dataRoot, { kind: 'server' }).mcp.bindings.find(
              (entry) => entry.entryId === serverId
            )?.enabled
          ).toBe(false);
        } else {
          expect(
            f.coreDb.sqlite
              .prepare('SELECT status FROM vault_grants WHERE grant_id = ?')
              .get(grant.grantId)
          ).toEqual({ status: 'revoked' });
        }
      });
      f.upstream.releaseDiscovery();
      await mutation;
      expectRefusal(await pending);
      expect(f.upstream.methods).not.toContain('tools/call');
    } finally {
      f.upstream.releaseDiscovery();
      await pending;
    }
  });
});
