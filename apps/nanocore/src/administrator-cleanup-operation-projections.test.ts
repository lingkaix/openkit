import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import fs, {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import {
  type AdministratorCleanupReadResponse,
  AdministratorCleanupReadResponseSchema,
} from '@openkit/app-api-schemas';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCoreClient } from '../../../packages/core-client/src/index.js';
import {
  createOpenKitAccessTokenRecord,
  revokeOpenKitAccessTokenRecord,
} from './auth/access-token-store.js';
import type { Actor } from './auth/identity.js';
import type { AuthVariables } from './auth/middleware.js';
import { disableCanonicalUser } from './auth/user-lifecycle.js';
import { createOperationInvocation } from './operation-composition.js';
import { OperationError } from './operation-error.js';
import { registerOperationJsonRoutes } from './operation-json-routes.js';
import {
  createNanoHostHarnessRuntime,
  openNanoHostAgentSessionBinding,
} from './runtime/nanohost-harness-records.js';
import {
  allocateNanoHostRuntimeTargetConnectionGeneration,
  recordNanoHostRuntimeTargetConnectionClose,
  upsertNanoHostRuntimeTarget,
} from './runtime/nanohost-runtime-target.js';
import {
  recordWorkerBackendSessionMaterializing,
  transitionWorkerBackendSessionState,
} from './runtime/worker-backend-sessions.js';
import { createWorkerStorageBinding } from './runtime/worker-storage-bindings.js';
import { createSchedulerAdmissionEntry } from './scheduler-records.js';
import { type CoreDb, openCoreDb } from './storage/db.js';
import { applyMigrations } from './storage/migrate.js';
import { createApp } from './test-support/app.js';
import { createDemoStore } from './test-support/demo-store.js';
import { testEntityId } from './test-support/entity-ids.js';
import { recordTestExecutionAttempt } from './test-support/execution-attempt.js';
import { ensureLocalUser } from './test-support/local-user.js';
import {
  createWorkspaceDeletionRequest,
  readWorkspaceDeletionRequest,
  writeWorkspaceDeletionRequest,
} from './workspace-deletion-request.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';
import { WorkspaceMutationAdmission } from './workspace-mutation-admission.js';
import { beginWorkspaceDeletion } from './workspace-sharing.js';

const OPERATION = 'administration.cleanup-read';
const CREATED = '2026-10-16T00:00:00.000Z';
const CHANGED = '2026-10-16T00:00:01.000Z';
const PRIVATE = 'private-cleanup-operation-canary';
const REQUEST = '00000000-0000-4000-8000-000000000226';
const SOURCES = [
  'workspace-deletion',
  'execution-attempt',
  'backend-session',
  'agent-session-binding',
  'sandbox-runtime',
  'worker-storage',
];
const fixtures: Array<{ coreDb: CoreDb; dataRoot: string }> = [];

/** Composes public invocation with real identity and canonical source owners. */
function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'cleanup-operation-'));
  const coreDb = openCoreDb(dataRoot);
  fixtures.push({ coreDb, dataRoot });
  applyMigrations(coreDb);
  coreDb.sqlite.pragma('journal_mode = WAL');
  ensureLocalUser(coreDb);
  const store = createDemoStore({ dataRoot });
  recordWorkspaceOwnerMembership({
    coreDb,
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
  });
  const token = createOpenKitAccessTokenRecord(coreDb, {
    ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
    scope: 'server-admin',
    workspaceIds: [],
    expiresAt: '2099-01-01T00:00:00.000Z',
  });
  const actor: Actor = {
    kind: 'token',
    userId: 'usr_00000000-0000-7000-8000-000000000001',
    tokenScope: 'server-admin',
    tokenId: token.tokenId,
  };
  const dependencies = {
    coreDb,
    dataRoot,
    store,
    inflightCommands: new WeakMap(),
    workspaceMutationAdmission: new WorkspaceMutationAdmission(),
  };
  const invoke = createOperationInvocation(dependencies);
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use('*', async (context, next) => {
    context.set('actor', actor);
    await next();
  });
  registerOperationJsonRoutes({ ...dependencies, app, requestStore: () => store });
  const native = (input: unknown = {}, currentActor = actor) =>
    invoke(OPERATION, input as never, { kind: 'public', actor: currentActor });
  const json = (input: unknown = {}) =>
    app.request(`/api/app/operations/${OPERATION}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
  return { ...dependencies, token, actor, invoke, native, json, app };
}

/** Creates the deletion owner's durable request without advancing deletion. */
function deletion(f: ReturnType<typeof fixture>, requestId = REQUEST) {
  return createWorkspaceDeletionRequest(f.dataRoot, {
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    requestId,
    originalOwnerUserId: 'usr_00000000-0000-7000-8000-000000000001',
    initiatingUserId: 'usr_00000000-0000-7000-8000-000000000001',
    confirmation: 'permanently-delete-workspace:ws_00000000-0000-7000-8000-000000000001:1',
    expectedRegistryRevision: 1,
    createdAt: CREATED,
  });
}

/** Creates a real prepared Scheduler attempt with no execution or Host contact. */
function attempt(coreDb: CoreDb, label = 'attempt_cleanup_operation') {
  const id = testEntityId('attempt', label);
  const entry = createSchedulerAdmissionEntry(coreDb, {
    backendId: 'nanohost',
    queueEntryId: `queue_${id}`,
    triggerActor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    threadId: testEntityId('th', `thread_${id}`),
    turnId: testEntityId('tu', `turn_${id}`),
    turnInput: PRIVATE,
    requestedAgentId: 'agent_cleanup',
    now: () => CREATED,
  });
  return recordTestExecutionAttempt(coreDb, {
    entry,
    attemptId: id,
    agentSessionId: testEntityId('as', `session_${id}`),
    inputRef: `package_${id}`,
    bindingRef: `binding_${id}`,
    sessionCompatibilityKey: 'b'.repeat(64),
    now: () => CREATED,
  });
}

/** Creates a native Sandbox identity to exercise complete UTF-8 response bounds without invalid Core IDs. */
function sandbox(coreDb: CoreDb, id: string) {
  const target = allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
    deploymentId: testEntityId('dep', 'deployment_cleanup'),
    identityId: 'identity_cleanup',
    targetId: 'target_cleanup',
    observedAt: CREATED,
  });
  upsertNanoHostRuntimeTarget(coreDb, {
    ...target,
    freshEmpty: true,
    predecessorFenced: true,
    ready: true,
    physicalEpoch: 'a'.repeat(64),
    observedAt: CREATED,
  });
  createNanoHostHarnessRuntime(coreDb, {
    adapterId: 'pi',
    adapterVersion: '1',
    harnessInstanceId: `harness_${id}`,
    harnessBindingRef: `harness_binding_${id}`,
    harnessCompatibilityKey: 'b'.repeat(64),
    imageDigest: `sha256:${'c'.repeat(64)}`,
    originPhysicalEpoch: 'a'.repeat(64),
    sandboxBindingRef: `sandbox_binding_${id}`,
    sandboxCompatibilityKey: 'd'.repeat(64),
    sandboxIntegrationBindingRef: `integration_${id}`,
    sandboxRuntimeId: id,
    runtimeTargetId: 'target_cleanup',
    timestamp: CREATED,
  });
}

/** Populates all six source families through their retained record producers. */
function populate(f: ReturnType<typeof fixture>) {
  const request = deletion(f);
  const execution = attempt(f.coreDb);
  const target = allocateNanoHostRuntimeTargetConnectionGeneration(f.coreDb, {
    deploymentId: testEntityId('dep', 'deployment_cleanup'),
    identityId: 'identity_cleanup',
    targetId: 'target_cleanup',
    observedAt: CREATED,
  });
  upsertNanoHostRuntimeTarget(f.coreDb, {
    ...target,
    freshEmpty: true,
    predecessorFenced: true,
    ready: true,
    physicalEpoch: 'a'.repeat(64),
    observedAt: CREATED,
  });
  recordWorkerBackendSessionMaterializing(f.coreDb, {
    identity: {
      agentSessionId: execution.agentSessionId!,
      backendKind: 'openshell',
      backendSessionId: PRIVATE,
      deploymentId: testEntityId('dep', 'deployment_cleanup'),
      packageSnapshotId: execution.inputRef!,
      runtimeTargetId: 'target_cleanup',
      stagingDirectoryRef: `server/runtime/${PRIVATE}`,
    },
    lineage: {
      workspaceId: execution.workspaceId,
      threadId: execution.threadId,
      turnId: execution.turnId,
    },
    backendLineage: { kind: 'reference', imageRef: `registry.example/${PRIVATE}` },
    sandboxBindingRef: execution.bindingRef!,
    now: () => CREATED,
  });
  createNanoHostHarnessRuntime(f.coreDb, {
    adapterId: 'pi',
    adapterVersion: '1',
    harnessInstanceId: 'harness_cleanup',
    harnessBindingRef: 'harness_binding_cleanup',
    harnessCompatibilityKey: 'b'.repeat(64),
    imageDigest: `sha256:${'c'.repeat(64)}`,
    originPhysicalEpoch: 'a'.repeat(64),
    sandboxBindingRef: 'sandbox_binding_cleanup',
    sandboxCompatibilityKey: 'd'.repeat(64),
    sandboxIntegrationBindingRef: 'integration_cleanup',
    sandboxRuntimeId: 'sandbox_cleanup',
    runtimeTargetId: 'target_cleanup',
    timestamp: CREATED,
  });
  openNanoHostAgentSessionBinding(f.coreDb, {
    agentSessionCompatibilityKey: 'b'.repeat(64),
    agentSessionId: execution.agentSessionId!,
    agentSessionRuntimeBindingId: 'binding_cleanup',
    effectiveSetupGeneration: 1,
    harnessInstanceId: 'harness_cleanup',
    threadId: execution.threadId,
    workspaceId: execution.workspaceId,
    timestamp: CREATED,
  });
  const storage = createWorkerStorageBinding(f.coreDb, {
    deploymentId: testEntityId('dep', 'deployment_cleanup'),
    runtimeTargetId: 'target_cleanup',
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    now: CREATED,
    layout: {
      family: 'worker',
      version: '1',
      uid: 1000,
      gid: 1000,
      workingDirectory: '/workspace',
      platform: { architecture: 'amd64', os: 'linux' },
      targets: [{ target: '/workspace' }],
    },
  });
  return { request, execution, storage };
}

/** Captures every Core table so a read cannot silently mutate a different lifecycle owner. */
function rows(coreDb: CoreDb) {
  const tables = coreDb.sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as Array<{ name: string }>;
  return tables.map(({ name }) => ({
    name,
    rows: coreDb.sqlite
      .prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`)
      .all(),
  }));
}

/** Captures file bytes and names, excluding SQLite's own read bookkeeping. */
function files(root: string, directory = root): Array<[string, string]> {
  return readdirSync(directory)
    .sort()
    .flatMap((name): Array<[string, string]> => {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) return files(root, path);
      if (/\.(?:db|sqlite)(?:-(?:wal|shm))?$/.test(name)) return [];
      return [
        [relative(root, path), createHash('sha256').update(readFileSync(path)).digest('hex')],
      ];
    });
}

/** Validates the complete known-field response and independently measures the fixed wire ceiling. */
function bounded(value: unknown): AdministratorCleanupReadResponse {
  const response = AdministratorCleanupReadResponseSchema.parse(value);
  expect(response).toEqual(value);
  expect(response.sources.map((source) => source.source)).toEqual(SOURCES);
  expect(response.items.length).toBeLessThanOrEqual(100);
  expect(Buffer.byteLength(JSON.stringify(response), 'utf8')).toBeLessThanOrEqual(262144);
  return response;
}

afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  for (const f of fixtures.splice(0)) {
    if (f.coreDb.sqlite.open) f.coreDb.sqlite.close();
    rmSync(f.dataRoot, { recursive: true, force: true });
  }
});

describe('administrator cleanup public operation composition', () => {
  it('returns complete empty six-source coverage through native and JSON invocation', async () => {
    const f = fixture();
    const native = bounded(await f.native());
    expect(native.items).toEqual([]);
    expect(native.sources).toEqual(
      SOURCES.map((source) => ({
        source,
        availability: 'available',
        incomplete: false,
        reasons: [],
      }))
    );
    expect(native.incomplete).toBe(false);
    const http = await f.json();
    expect(http.status).toBe(200);
    expect(http.headers.get('cache-control')).toBe('no-store');
    expect(bounded(await http.json())).toMatchObject({
      items: [],
      sources: native.sources,
      incomplete: false,
    });
  });

  it.each([
    null,
    [],
    { workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
    { maxEntries: 1 },
    { maxBytes: 1 },
    { now: CREATED },
  ])('refuses nonempty or nonobject input %j before source access', async (input) => {
    const f = fixture();
    const read = vi.spyOn(f.coreDb.sqlite, 'prepare');
    await expect(f.native(input)).rejects.toMatchObject({ code: 'invalid_request', status: 400 });
    expect(read).not.toHaveBeenCalled();
    const http = await f.json(input);
    expect(http.status).toBe(400);
    expect(await http.json()).toMatchObject({ code: 'invalid_request' });
  });

  it('refuses caller-supplied authority before source access', async () => {
    const f = fixture();
    const read = vi.spyOn(f.coreDb.sqlite, 'prepare');
    await expect(
      f.native({ actor: 'usr_00000000-0000-7000-8000-000000000001' })
    ).rejects.toMatchObject({
      code: 'bound_input_conflict',
      status: 403,
    });
    expect(read).not.toHaveBeenCalled();
    expect((await f.json({ actor: 'usr_00000000-0000-7000-8000-000000000001' })).status).toBe(403);
  });

  it('joins every real source, preserves waiting and unknown facts, and exposes no private payload', async () => {
    const f = fixture();
    const { execution, storage } = populate(f);
    const result = bounded(await f.native());
    expect(result.items.map((item) => item.source)).toEqual(SOURCES);
    expect(result.incomplete).toBe(false);
    expect(result.items[0]).toMatchObject({
      source: 'workspace-deletion',
      target: { workspaceId: 'ws_00000000-0000-7000-8000-000000000001', requestId: REQUEST },
      state: { phase: 'requested', retainedStaging: false, cleanedAt: null },
      sourceUpdatedAt: null,
      evidence: { kind: 'unknown' },
    });
    expect(result.items[1]).toMatchObject({
      target: { attemptId: execution.attemptId },
      state: { phase: 'open', disposition: 'not_accepted' },
      evidence: { kind: 'unknown' },
    });
    expect(result.items[2]).toMatchObject({
      target: { attemptId: execution.attemptId },
      state: { state: 'materializing', workspaceHandoffState: 'pending', physicalCleanedAt: null },
      evidence: { kind: 'unknown' },
    });
    expect(result.items[5]).toMatchObject({
      target: { storageRef: storage.storageRef },
      state: { state: 'idle', revision: 1, purgedAt: null },
      evidence: { kind: 'unknown' },
    });
    for (const item of result.items) {
      expect(item.observedAt).toBe(result.observedAt);
      expect(item.nextInspection).toEqual({
        kind: 'source-record',
        sourceOwner: item.sourceOwner,
        target: item.target,
      });
    }
    expect(JSON.stringify(result)).not.toContain(PRIVATE);
    expect(JSON.stringify(result)).not.toMatch(
      /stagingRelativePath|confirmation|preparationInput|backendSessionId|imageDigest|terminalCause|compatibilityKey/
    );
  });

  it.each([
    'workspace',
    'workspace-readonly',
  ] as const)('denies the %s credential despite current Workspace ownership', async (scope) => {
    const f = fixture();
    populate(f);
    const token = createOpenKitAccessTokenRecord(f.coreDb, {
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      scope,
      workspaceIds: ['ws_00000000-0000-7000-8000-000000000001'],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    await expect(
      f.native(
        {},
        {
          kind: 'token',
          userId: 'usr_00000000-0000-7000-8000-000000000001',
          tokenId: token.tokenId,
          tokenScope: scope,
        }
      )
    ).rejects.toMatchObject({ status: 403 });
  });

  it('rechecks the original credential on every invocation after revocation', async () => {
    const f = fixture();
    populate(f);
    bounded(await f.native());
    revokeOpenKitAccessTokenRecord(f.coreDb, f.token.tokenId);
    await expect(f.native()).rejects.toMatchObject({ status: 403 });
    const http = await f.json();
    expect(http.status).toBe(403);
    expect(JSON.stringify(await http.json())).not.toContain('attempt_cleanup_operation');
  });

  it('denies the next read after the current administrator is disabled', async () => {
    const f = fixture();
    populate(f);
    bounded(await f.native());
    f.coreDb.sqlite.transaction(() => disableCanonicalUser(f.coreDb, f.actor.userId))();
    await expect(f.native()).rejects.toMatchObject({ status: 403 });
    const http = await f.json();
    expect(http.status).toBe(403);
    expect(JSON.stringify(await http.json())).not.toMatch(
      /ws_00000000-0000-7000-8000-000000000001|attempt_cleanup_operation/
    );
  });

  it.each([
    'worker',
    'coordinator',
    'bootstrap',
  ] as const)('refuses %s invocation before any source access', async (kind) => {
    const f = fixture();
    const { execution } = populate(f);
    const contexts = {
      worker: {
        kind: 'worker' as const,
        actor: { kind: 'user' as const, id: 'usr_00000000-0000-7000-8000-000000000001' },
        lineage: {
          workspaceId: execution.workspaceId,
          threadId: execution.threadId,
          turnId: execution.turnId,
          agentSessionId: execution.agentSessionId!,
          packageSnapshotId: execution.inputRef!,
        },
        requestId: REQUEST,
        bindings: {},
      },
      coordinator: {
        kind: 'coordinator' as const,
        actor: f.actor,
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: execution.threadId,
        turnId: execution.turnId,
        goalId: 'goal_cleanup',
        requestId: REQUEST,
      },
      bootstrap: { kind: 'bootstrap' as const },
    };
    const sqlRead = vi.spyOn(f.coreDb.sqlite, 'prepare');
    const fileRead = vi.spyOn(fs, 'readFileSync');
    syncBuiltinESMExports();
    const error = await f
      .invoke(OPERATION, {}, contexts[kind])
      .catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(OperationError);
    // These trusted entry families have different existing refusal classes; all must refuse before reads.
    expect([400, 401, 403]).toContain(error instanceof OperationError ? error.status : null);
    expect(sqlRead).not.toHaveBeenCalled();
    expect(fileRead).not.toHaveBeenCalled();
  });

  it('denies publication when the administrator is revoked during a real source read', async () => {
    const f = fixture();
    populate(f);
    const prepare = f.coreDb.sqlite.prepare.bind(f.coreDb.sqlite);
    let revoked = false;
    vi.spyOn(f.coreDb.sqlite, 'prepare').mockImplementation((sql: string) => {
      if (!revoked && /\bFROM\s+worker_storage_bindings\b/i.test(sql)) {
        revoked = true;
        revokeOpenKitAccessTokenRecord(f.coreDb, f.token.tokenId);
      }
      return prepare(sql);
    });
    await expect(f.native()).rejects.toMatchObject({ status: 403 });
    expect(revoked).toBe(true);
  });

  it('returns a safe unavailable operation error when current authority storage is lost', async () => {
    const f = fixture();
    populate(f);
    const prepare = f.coreDb.sqlite.prepare.bind(f.coreDb.sqlite);
    vi.spyOn(f.coreDb.sqlite, 'prepare').mockImplementation((sql: string) => {
      if (sql.includes('openkit_access_tokens')) {
        throw new Database.SqliteError('injected authority storage failure', 'SQLITE_ERROR');
      }
      return prepare(sql);
    });
    const http = await f.json();
    expect(http.status).toBe(503);
    const error = await http.json();
    expect(error).toMatchObject({ code: 'operation_storage_unavailable' });
    expect(JSON.stringify(error)).not.toMatch(
      /openkit_access_tokens|attempt_cleanup_operation|ws_00000000-0000-7000-8000-000000000001|SQLITE|injected authority storage failure/
    );
  });

  it('propagates an unclassified administrator-admission error to the existing HTTP error handler', async () => {
    const f = fixture();
    const sentinel = new Error('unclassified-admission-canary');
    const observed = vi.fn();
    f.app.onError((error, context) => {
      observed(error);
      return context.text('Internal Server Error', 500);
    });
    vi.spyOn(f.coreDb.sqlite, 'prepare').mockImplementation(() => {
      throw sentinel;
    });
    await expect(f.native()).rejects.toBe(sentinel);
    const http = await f.json();
    expect(http.status).toBe(500);
    expect(await http.text()).toBe('Internal Server Error');
    expect(observed).toHaveBeenCalledExactlyOnceWith(sentinel);
  });

  it('observes a deleting Workspace without opening its content gate or changing any source', async () => {
    const f = fixture();
    const { request } = populate(f);
    f.coreDb.sqlite.transaction(() =>
      beginWorkspaceDeletion({
        coreDb: f.coreDb,
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        originalOwnerUserId: 'usr_00000000-0000-7000-8000-000000000001',
        expectedRegistryRevision: 1,
      })
    )();
    writeWorkspaceDeletionRequest(f.dataRoot, { ...request, phase: 'deleting' });
    writeFileSync(join(f.dataRoot, 'orphan-cleanup-canary'), PRIVATE);
    const beforeRows = rows(f.coreDb);
    const beforeFiles = files(f.dataRoot);
    f.coreDb.sqlite.pragma('query_only = ON');
    const result = bounded(await f.native());
    expect(result.items).toHaveLength(6);
    expect(result.items[0]).toMatchObject({
      state: { phase: 'deleting' },
      evidence: { kind: 'unknown' },
    });
    await expect(
      f.invoke(
        'workspace.read',
        { workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
        {
          kind: 'public',
          actor: { kind: 'local', userId: 'usr_00000000-0000-7000-8000-000000000001' },
        }
      )
    ).rejects.toMatchObject({ code: 'workspace_access_denied' });
    expect(rows(f.coreDb)).toEqual(beforeRows);
    expect(files(f.dataRoot)).toEqual(beforeFiles);
  });

  it.each([
    'workspace-deletion',
    'backend-session',
  ])('preserves other sources when %s becomes unavailable', async (source) => {
    const f = fixture();
    populate(f);
    if (source === 'workspace-deletion') {
      const path = join(
        f.dataRoot,
        'server',
        'exports',
        'workspace-deletions',
        'ws_00000000-0000-7000-8000-000000000001',
        REQUEST,
        'request.json'
      );
      writeFileSync(path, PRIVATE);
    } else {
      const prepare = f.coreDb.sqlite.prepare.bind(f.coreDb.sqlite);
      vi.spyOn(f.coreDb.sqlite, 'prepare').mockImplementation((sql: string) => {
        if (sql.includes('worker_backend_sessions')) {
          throw new Database.SqliteError('unavailable_backend_sessions', 'SQLITE_ERROR');
        }
        return prepare(sql);
      });
    }
    const result = bounded(await f.native());
    expect(result.sources.find((entry) => entry.source === source)).toMatchObject({
      availability: 'unavailable',
      incomplete: true,
      reasons: ['source_unavailable'],
    });
    expect(result.items.some((entry) => entry.source === source)).toBe(false);
    expect(result.items.filter((entry) => entry.source !== source)).toHaveLength(5);
    expect(result.incomplete).toBe(true);
    expect(JSON.stringify(result)).not.toContain(PRIVATE);
    expect(JSON.stringify(result)).not.toContain('unavailable_backend_sessions');
  });

  it('preserves contradictory and stale proof as unknown across the public boundary', async () => {
    const f = fixture();
    populate(f);
    f.coreDb.sqlite
      .prepare('UPDATE worker_backend_sessions SET physical_cleaned_at = ?')
      .run(CREATED);
    let result = bounded(await f.native());
    expect(result.items.find((entry) => entry.source === 'backend-session')).toMatchObject({
      state: { state: 'materializing', physicalCleanedAt: CREATED },
      evidence: { kind: 'unknown', reason: 'contradictory' },
    });
    recordNanoHostRuntimeTargetConnectionClose(f.coreDb, {
      targetId: 'target_cleanup',
      closedGeneration: 1,
      authoritativeGeneration: null,
      observedAt: CHANGED,
    });
    result = bounded(await f.native());
    expect(result.items.find((entry) => entry.source === 'sandbox-runtime')).toMatchObject({
      state: { physicalEpochRelation: 'unknown' },
      evidence: { kind: 'unknown', reason: 'stale' },
    });
    expect(result.incomplete).toBe(false);
  });

  it('applies one stable 100-item count bound across deletion and runtime sources', async () => {
    const f = fixture();
    deletion(f);
    for (let index = 0; index < 102; index++)
      attempt(f.coreDb, `attempt_${String(index).padStart(3, '0')}`);
    const first = bounded(await f.native());
    const second = bounded(await f.native());
    expect(first.items).toHaveLength(100);
    expect(first.items[0]).toMatchObject({ source: 'workspace-deletion' });
    expect(first.items.slice(1).map((item) => item.target)).toEqual(
      second.items.slice(1).map((item) => item.target)
    );
    expect(first.items.slice(1).map((item) => item.target)).toEqual(
      Array.from({ length: 102 }, (_, index) =>
        testEntityId('attempt', `attempt_${String(index).padStart(3, '0')}`)
      )
        .sort()
        .slice(0, 99)
        .map((attemptId) => expect.objectContaining({ attemptId }))
    );
    expect(first.sources[1]).toMatchObject({
      incomplete: true,
      reasons: expect.arrayContaining(['count_limit']),
    });
    expect(first.incomplete).toBe(true);
  });

  it('bounds canonical deletion request reads and preserves a stable 100-item prefix', async () => {
    const f = fixture();
    const requests = Array.from(
      { length: 101 },
      (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
    );
    for (const requestId of requests) {
      const request = deletion(f, requestId);
      writeWorkspaceDeletionRequest(f.dataRoot, { ...request, phase: 'blocked' });
    }
    attempt(f.coreDb);
    const fileRead = vi.spyOn(fs, 'readFileSync');
    syncBuiltinESMExports();
    const canonicalRoot = join(
      f.dataRoot,
      'server',
      'exports',
      'workspace-deletions',
      'ws_00000000-0000-7000-8000-000000000001'
    );
    const canonicalReadPaths = () =>
      fileRead.mock.calls
        .map(([path]) => String(path))
        .filter((path) => path.startsWith(`${canonicalRoot}/`) && path.endsWith('/request.json'));
    const first = bounded(await f.native());
    expect(first.items).toHaveLength(100);
    expect(first.items.every((item) => item.source === 'workspace-deletion')).toBe(true);
    expect(
      first.items.map((item) =>
        item.source === 'workspace-deletion' ? item.target.requestId : null
      )
    ).toEqual(requests.slice(0, 100));
    const firstPaths = canonicalReadPaths();
    expect(firstPaths.length).toBeGreaterThanOrEqual(100);
    expect(firstPaths.length).toBeLessThanOrEqual(101);
    expect(first.sources[0]).toMatchObject({
      availability: 'available',
      incomplete: true,
      reasons: expect.arrayContaining(['count_limit']),
    });
    for (const source of first.sources.slice(1)) {
      expect(source).toMatchObject({
        availability: 'unavailable',
        incomplete: true,
        reasons: expect.arrayContaining(['count_limit', 'source_unavailable']),
      });
    }
    fileRead.mockClear();
    const second = bounded(await f.native());
    expect(second.items.map((item) => item.target)).toEqual(first.items.map((item) => item.target));
    expect(canonicalReadPaths()).toEqual(firstPaths);
    expect(first.incomplete).toBe(true);
  });

  it.each([
    'missing',
    'invalid',
  ] as const)('withholds deletion identifiers when the current Workspace registry is %s', async (state) => {
    const f = fixture();
    deletion(f);
    if (state === 'missing')
      f.coreDb.sqlite
        .prepare(
          "DELETE FROM workspace_registry WHERE workspace_id = 'ws_00000000-0000-7000-8000-000000000001'"
        )
        .run();
    else {
      // Model a corrupted retained registry row; restore constraint enforcement before the public read.
      f.coreDb.sqlite.pragma('ignore_check_constraints = ON');
      f.coreDb.sqlite
        .prepare(
          "UPDATE workspace_registry SET status = ? WHERE workspace_id = 'ws_00000000-0000-7000-8000-000000000001'"
        )
        .run(PRIVATE);
      f.coreDb.sqlite.pragma('ignore_check_constraints = OFF');
    }
    const result = bounded(await f.native());
    expect(result.items).toEqual([]);
    expect(result.sources[0]).toMatchObject({
      availability: 'unavailable',
      incomplete: true,
      reasons: expect.arrayContaining(['source_unavailable']),
    });
    expect(result.incomplete).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(
      /ws_00000000-0000-7000-8000-000000000001|00000000-0000-4000-8000-000000000226|private-cleanup-operation-canary/
    );
  });

  it('counts UTF-8 bytes on the complete six-source response and preserves bounded native identities intact', async () => {
    const f = fixture();
    deletion(f);
    const ids = Array.from(
      { length: 96 },
      (_, index) => `sandbox_${String(index).padStart(3, '0')}_${'界'.repeat(470)}`
    );
    for (const id of ids) sandbox(f.coreDb, id);

    const result = bounded(await f.native());
    const serialized = JSON.stringify(result);
    expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThanOrEqual(262144);
    expect(Buffer.byteLength(serialized, 'utf8')).toBeGreaterThan(serialized.length);
    expect(result.items[0]?.source).toBe('workspace-deletion');
    const runtimes = result.items.filter((item) => item.source === 'sandbox-runtime');
    expect(runtimes.length).toBeGreaterThan(0);
    expect(runtimes.length).toBeLessThan(ids.length);
    for (const item of runtimes) {
      expect(item.target.kind).toBe('sandbox-runtime');
      if (item.target.kind === 'sandbox-runtime') {
        expect(ids).toContain(item.target.sandboxRuntimeId);
      }
    }
    expect(result.sources[4]).toMatchObject({
      incomplete: true,
      reasons: expect.arrayContaining(['byte_limit']),
    });
    expect(result.sources.flatMap((source) => source.reasons)).not.toContain('count_limit');
    expect(result.incomplete).toBe(true);
  });

  it('retains complete native runtime items when the complete response fits its byte ceiling', async () => {
    const f = fixture();
    deletion(f);
    const ids = Array.from(
      { length: 4 },
      (_, index) => `sandbox_${String(index).padStart(3, '0')}_${'界'.repeat(470)}`
    );
    for (const id of ids) sandbox(f.coreDb, id);

    const result = bounded(await f.native());
    expect(result.items).toHaveLength(ids.length + 1);
    expect(result.items.slice(1).map((item) => item.target)).toEqual(
      ids.map((sandboxRuntimeId) => ({
        kind: 'sandbox-runtime',
        sandboxRuntimeId,
        runtimeTargetId: 'target_cleanup',
      }))
    );
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThan(262144);
    expect(result.sources.every((source) => source.reasons.length === 0)).toBe(true);
    expect(result.incomplete).toBe(false);
  });

  it('preserves coherent current owner facts during a concurrent source transition', async () => {
    const f = fixture();
    const { execution } = populate(f);
    const concurrent = openCoreDb(f.dataRoot);
    const prepare = f.coreDb.sqlite.prepare.bind(f.coreDb.sqlite);
    let changed = false;
    try {
      const fault = vi.spyOn(f.coreDb.sqlite, 'prepare').mockImplementation((sql: string) => {
        if (!changed && /\bFROM\s+scheduler_execution_attempts\b/i.test(sql)) {
          changed = true;
          transitionWorkerBackendSessionState(concurrent, {
            attemptId: execution.attemptId,
            fromState: 'materializing',
            toState: 'cleanup-pending',
            now: () => CHANGED,
          });
        }
        return prepare(sql);
      });
      const result = bounded(await f.native());
      expect(changed).toBe(true);
      const backend = result.items.find((item) => item.source === 'backend-session');
      expect(backend?.source).toBe('backend-session');
      if (backend?.source !== 'backend-session') throw new Error('Backend observation is absent.');
      expect([
        { state: 'materializing', sourceUpdatedAt: CREATED },
        { state: 'cleanup-pending', sourceUpdatedAt: CHANGED },
      ]).toContainEqual({ state: backend.state.state, sourceUpdatedAt: backend.sourceUpdatedAt });
      expect(backend.evidence.kind).toBe('unknown');
      fault.mockRestore();
      expect(
        bounded(await f.native()).items.find((item) => item.source === 'backend-session')
      ).toMatchObject({ sourceUpdatedAt: CHANGED, state: { state: 'cleanup-pending' } });
    } finally {
      concurrent.sqlite.close();
    }
  });

  it('keeps truthful uncertainty when a canonical deletion request is replaced during its read', async () => {
    const f = fixture();
    const request = deletion(f);
    const path = join(
      f.dataRoot,
      'server',
      'exports',
      'workspace-deletions',
      'ws_00000000-0000-7000-8000-000000000001',
      REQUEST,
      'request.json'
    );
    const beforeRows = rows(f.coreDb);
    const beforeFiles = files(f.dataRoot);
    const read = fs.readFileSync;
    let replaced = false;
    const fault = vi
      .spyOn(fs, 'readFileSync')
      .mockImplementation((...args: Parameters<typeof read>) => {
        const value = read(...args);
        if (!replaced && String(args[0]) === path) {
          replaced = true;
          writeWorkspaceDeletionRequest(f.dataRoot, { ...request, phase: 'blocked' });
        }
        return value;
      });
    syncBuiltinESMExports();
    const result = bounded(await f.native());
    expect(replaced).toBe(true);
    fault.mockRestore();
    syncBuiltinESMExports();
    const item = result.items.find((entry) => entry.source === 'workspace-deletion');
    if (item?.source === 'workspace-deletion') {
      expect(['requested', 'blocked']).toContain(item.state.phase);
      expect(item.state).toMatchObject({ retainedStaging: false, cleanedAt: null });
      expect(item.evidence.kind).toBe('unknown');
    } else
      expect(result.sources[0]).toMatchObject({
        incomplete: true,
        reasons: expect.arrayContaining(['source_changed']),
      });
    expect(
      readWorkspaceDeletionRequest(f.dataRoot, 'ws_00000000-0000-7000-8000-000000000001', REQUEST)
        .phase
    ).toBe('blocked');
    expect(rows(f.coreDb)).toEqual(beforeRows);
    const afterFiles = files(f.dataRoot);
    expect(afterFiles.map(([name]) => name)).toEqual(beforeFiles.map(([name]) => name));
    expect(
      afterFiles
        .filter(([, digest], index) => digest !== beforeFiles[index]?.[1])
        .map(([name]) => name)
    ).toEqual([relative(f.dataRoot, path)]);
  });

  it('reads current deletion and runtime records after reopening Core storage', async () => {
    const f = fixture();
    const { request, execution } = populate(f);
    bounded(await f.native());
    f.coreDb.sqlite.close();
    f.coreDb = openCoreDb(f.dataRoot);
    fixtures[fixtures.length - 1]!.coreDb = f.coreDb;
    writeWorkspaceDeletionRequest(f.dataRoot, { ...request, phase: 'blocked' });
    transitionWorkerBackendSessionState(f.coreDb, {
      attemptId: execution.attemptId,
      fromState: 'materializing',
      toState: 'cleanup-pending',
      now: () => CHANGED,
    });
    const invoke = createOperationInvocation({ ...f, coreDb: f.coreDb });
    const result = bounded(await invoke(OPERATION, {}, { kind: 'public', actor: f.actor }));
    expect(result.items[0]).toMatchObject({ state: { phase: 'blocked' } });
    expect(result.items.find((item) => item.source === 'backend-session')).toMatchObject({
      sourceUpdatedAt: CHANGED,
      state: { state: 'cleanup-pending' },
    });
    expect(
      readWorkspaceDeletionRequest(f.dataRoot, 'ws_00000000-0000-7000-8000-000000000001', REQUEST)
        .phase
    ).toBe('blocked');
  });

  it('uses the same real JSON operation through generated CLI and eligible remote MCP', async () => {
    const f = fixture();
    populate(f);
    const app = createApp({
      coreDb: f.coreDb,
      dataRoot: f.dataRoot,
      store: f.store,
      mode: 'server',
    });
    const client = createCoreClient({
      baseUrl: 'http://127.0.0.1',
      headers: { authorization: `Bearer ${f.token.secret}` },
      fetch: (input, init) => app.fetch(new Request(input, init)),
    });
    const { operationCatalog } = await import(
      new URL('../../../skills/openkit-operations.mjs', import.meta.url).href
    );
    const operation = operationCatalog.find((entry: { id: string }) => entry.id === OPERATION);
    expect(operation).toBeDefined();
    expect(
      bounded(await operation.handler({ client }, operation.inputSchema.parse({}))).items.map(
        (item) => item.source
      )
    ).toEqual(SOURCES);
    const response = await app.request('http://127.0.0.1/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${f.token.secret}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'openkit_call', arguments: { operation: OPERATION, input: {} } },
      }),
    });
    expect(response.status).toBe(200);
    const message = await response.json();
    expect(message.error).toBeUndefined();
    expect(message.result.isError).not.toBe(true);
    expect(
      bounded(JSON.parse(message.result.content[0].text)).items.map((item) => item.source)
    ).toEqual(SOURCES);
  });
});
