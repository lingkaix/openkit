import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Worker as NativeWorker } from 'node:worker_threads';
import type { OperationId } from '@openkit/app-api-schemas';
import { expect, it, onTestFinished, vi } from 'vitest';
import {
  createOpenKitAccessTokenRecord,
  revokeOpenKitAccessTokenRecord,
} from '../auth/access-token-store.js';
import { loadResourceCatalog, loadWorkspaceResourceCatalog } from '../catalog/resource-catalog.js';
import { createRuntimeConfigManager } from '../config/runtime-config.js';
import { commandRequestKey, FsStore } from '../lib/store.js';
import { createOperationInvocation } from '../operation-composition.js';
import { OperationError } from '../operation-error.js';
import { commandInputHash } from '../runtime/idempotent-command.js';
import { createAppWithLocalIdentity } from '../test-support/app.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import { isControlNativeReceiptCommand } from './control-store-admission-codecs.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
import { openCoreDb, openWorkspaceDb } from './db.js';
import { applyMigrations } from './migrate.js';

// Real public owner -> original file/session -> evidence/receipt stages.
// SQL results, Actor authority, native COMMITs and acknowledgements are never fabricated.
const fault = vi.hoisted(() => ({
  queryOnly: false,
  workers: [] as NativeWorker[],
  posts: [] as unknown[],
  // Stage: 1 started Audit, 2 completed Audit, 3 receipt, 4 later maintenance.
  // Slots: armed, reached, release, synchronous, Worker index, actual SQL-cause bits.
  gate: new SharedArrayBuffer(6 * Int32Array.BYTES_PER_ELEMENT),
  request: new SharedArrayBuffer(36),
}));

vi.mock('./db.js', async (load) => {
  const actual = await load<typeof import('./db.js')>();
  const observe = <
    T extends ReturnType<typeof actual.openCoreDb> | ReturnType<typeof actual.openWorkspaceDb>,
  >(
    db: T
  ): T => {
    if (fault.queryOnly) db.sqlite.pragma('query_only=ON');
    const prepare = db.sqlite.prepare.bind(db.sqlite);
    db.sqlite.prepare = ((sql: string) => {
      const statement = prepare(sql),
        run = statement.run.bind(statement);
      statement.run = (...parameters) => {
        try {
          return run(...parameters);
        } catch (error) {
          const { code, message } = error as { code?: string; message?: string };
          const gate = new Int32Array(fault.gate);
          const requestId = Buffer.from(fault.request).toString('ascii');
          const record = /^\s*INSERT(?:\s+OR\s+REPLACE)?\s+INTO\s+idempotency_requests/i.test(sql);
          const prune = /^\s*DELETE\s+FROM\s+idempotency_requests/i.test(sql);
          const audit = /^\s*INSERT\s+INTO\s+audit_events/i.test(sql);
          if (parameters.includes(requestId) && code?.startsWith('SQLITE_CONSTRAINT')) {
            if (record && message === 'MCP receipt INSERT') Atomics.or(gate, 5, 1);
            if (audit && message === 'MCP started Audit') Atomics.or(gate, 5, 4);
            if (audit && message === 'MCP completed Audit') Atomics.or(gate, 5, 8);
          }
          if (
            prune &&
            code?.startsWith('SQLITE_CONSTRAINT') &&
            message === 'MCP receipt DELETE' &&
            prepare('SELECT 1 FROM idempotency_requests WHERE request_id=?').get(requestId)
          )
            Atomics.or(gate, 5, 2);
          if (code?.startsWith('SQLITE_READONLY'))
            console.info('Original Main MCP SQLite refused', {
              scope: db.scope,
              sqlOperation: /^\s*([a-z]+)/i.exec(sql)?.[1]?.toUpperCase(),
              code,
            });
          throw error;
        }
      };
      return statement;
    }) as typeof db.sqlite.prepare;
    return db;
  };
  return {
    ...actual,
    openCoreDb: (...args: Parameters<typeof actual.openCoreDb>) =>
      observe(actual.openCoreDb(...args)),
    openWorkspaceDb: (...args: Parameters<typeof actual.openWorkspaceDb>) =>
      observe(actual.openWorkspaceDb(...args)),
  };
});

vi.mock('node:worker_threads', async (load) => {
  const actual = await load<typeof import('node:worker_threads')>();
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(filename: string | URL, options?: import('node:worker_threads').WorkerOptions) {
        const workerIndex = fault.workers.length;
        const prelude = String.raw`
        const {workerData} = require('node:worker_threads');
        const Database = require(workerData.mcpDatabaseModule);
        const prepare = Database.prototype.prepare, exec = Database.prototype.exec;
        const gate = workerData.mcpGate, stages = new WeakMap();
        const requestId = () => Buffer.from(workerData.mcpRequest).toString('ascii');
        const hasReceipt = db => !!prepare.call(db,'SELECT 1 FROM idempotency_requests WHERE request_id=?').get(requestId());
        Database.prototype.prepare = function(sql) {
          const statement = prepare.call(this, sql), db = this;
          const record = /^\s*INSERT(?:\s+OR\s+REPLACE)?\s+INTO\s+idempotency_requests/i.test(sql);
          const prune = /^\s*DELETE\s+FROM\s+idempotency_requests/i.test(sql);
          const audit = /^\s*INSERT\s+INTO\s+audit_events/i.test(sql);
          if (!record && !prune && !audit) return statement;
          const run = statement.run;
          statement.run = function(...parameters) {
            try {
              const result = run.apply(this, parameters);
              if (record && parameters.includes(requestId())) stages.set(db, 3);
              if (prune && hasReceipt(db)) stages.set(db, 4);
              if (audit && parameters.includes(requestId())) {
                const completed = prepare.call(db,"SELECT 1 FROM audit_events WHERE request_id=? AND outcome='succeeded'").get(requestId());
                stages.set(db, completed ? 2 : 1);
              }
              return result;
            } catch (error) {
              if (parameters.includes(requestId()) && error.code?.startsWith('SQLITE_CONSTRAINT')) {
                if (record && error.message === 'MCP receipt INSERT') Atomics.or(gate,5,1);
                if (audit && error.message === 'MCP started Audit') Atomics.or(gate,5,4);
                if (audit && error.message === 'MCP completed Audit') Atomics.or(gate,5,8);
              }
              if (prune && error.code?.startsWith('SQLITE_CONSTRAINT') && error.message === 'MCP receipt DELETE' && hasReceipt(db)) Atomics.or(gate,5,2);
              throw error;
            }
          };
          return statement;
        };
        Database.prototype.exec = function(sql) {
          const result = exec.call(this,sql);
          if (!/^COMMIT$/i.test(sql)) return result;
          const stage = stages.get(this); stages.delete(this);
          if (!stage || Atomics.compareExchange(gate,0,stage,0)!==stage) return result;
          Atomics.store(gate,3,this.pragma('synchronous',{simple:true}));
          Atomics.store(gate,4,workerData.mcpWorkerIndex);
          Atomics.store(gate,1,stage); Atomics.notify(gate,1);
          Atomics.wait(gate,2,0);
          return result;
        };
      `;
        super(
          prelude +
            (options?.eval ? String(filename) : `import(${JSON.stringify(String(filename))});`),
          {
            ...options,
            eval: true,
            workerData: {
              ...options?.workerData,
              mcpDatabaseModule: require.resolve('better-sqlite3'),
              mcpGate: new Int32Array(fault.gate),
              mcpRequest: new Uint8Array(fault.request),
              mcpWorkerIndex: workerIndex,
            },
          }
        );
        fault.workers.push(this);
      }
      override postMessage(...args: Parameters<NativeWorker['postMessage']>) {
        fault.posts.push(args[0]);
        return super.postMessage(...args);
      }
    },
  };
});

const coreCommands = [
  'administration.server-mcp-create',
  'administration.server-mcp-stage-version',
  'administration.server-mcp-select-version',
  'administration.server-mcp-update-binding',
  'administration.server-mcp-remove',
] as const;
const workspaceCommand = 'catalog.shared-mcp-set-disabled' as const;
const commands = [...coreCommands, workspaceCommand] as const;
type Command = (typeof commands)[number];
const DAY = 24 * 60 * 60 * 1000;
const declaration = { kind: 'http' as const, endpoint: 'https://mcp.example.test/mcp' };
const nextDeclaration = { kind: 'http' as const, endpoint: 'https://mcp.example.test/next' };
const creation = {
  id: 'shared',
  displayName: 'Shared',
  declaration,
  allowedTools: ['echo'],
  expectedRevision: 0,
};
const gate = () => new Int32Array(fault.gate);
const release = () => {
  Atomics.store(gate(), 0, 0);
  Atomics.store(gate(), 2, 1);
  Atomics.notify(gate(), 2);
};
const arm = (stage: number) => {
  Atomics.store(gate(), 1, 0);
  Atomics.store(gate(), 2, 0);
  Atomics.store(gate(), 0, stage);
};
async function held(stage: number, pending: Promise<unknown>) {
  // Wait on the actual COMMIT signal without vi.waitFor advancing the fake Date
  // before the original command has captured its receipt timestamp.
  const signal = Atomics.waitAsync(gate(), 1, 0, 5000);
  await Promise.race([
    Promise.resolve(signal.value),
    pending.then(
      () => 'settled',
      () => 'settled'
    ),
  ]);
  expect(
    Atomics.load(gate(), 1),
    'Original operation settled or timed out before the genuine native COMMIT hold.'
  ).toBe(stage);
  expect(Atomics.load(gate(), 3)).toBe(2);
}

const refusal = (error: unknown, code = 'recovery_required', status = 409) => {
  expect(error).toBeInstanceOf(OperationError);
  expect(error).toMatchObject({ code, status });
};

async function fixture(command: Command) {
  release();
  fault.queryOnly = false;
  fault.workers.length = 0;
  fault.posts.length = 0;
  gate().fill(0);
  const dataRoot = mkdtempSync(join(tmpdir(), 'mcp-command-receipts-'));
  let coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  const admin = createOpenKitAccessTokenRecord(coreDb, {
    ownerUserId: userId,
    scope: 'server-admin',
    workspaceIds: [],
    expiresAt: '2999-01-01T00:00:00.000Z',
  });
  const actor = {
    kind: 'token' as const,
    userId,
    tokenScope: 'server-admin' as const,
    tokenId: admin.tokenId,
  };
  // A separate setup-owned handle is used only for genuine later revocation faults.
  let authorityDb = openCoreDb(dataRoot);
  let store = new FsStore({ dataRoot });
  const workspace = await store.createWorkspace('MCP receipt physical scope');
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
  let workspaceDb = openWorkspaceDb(dataRoot, workspace.id);
  const manager = createRuntimeConfigManager({ dataRoot });
  const closed: [string | null, string | null][] = [];
  let sessionReached!: () => void, sessionRelease!: () => void;
  let sessionHold: Promise<void> | undefined;
  let sessionEntered: Promise<void> | undefined;
  const closeServerMcpSessions = async (workspaceId?: string, mcpId?: string) => {
    closed.push([workspaceId ?? null, mcpId ?? null]);
    if (sessionHold) {
      sessionReached();
      await sessionHold;
    }
  };
  const compose = () =>
    createOperationInvocation({
      coreDb,
      dataRoot,
      store,
      runtimeConfigManager: manager,
      inflightCommands: new WeakMap(),
      workspaceMutationAdmission: new WorkspaceMutationAdmission(),
      repositoryWorkspaceDb: (id: string) => openWorkspaceDb(dataRoot, id),
      closeServerMcpSessions,
    });
  let invoke = compose();
  const pending = new Set<Promise<unknown>>();
  const send = (
    operation: OperationId,
    input: Record<string, unknown>,
    requestId = randomUUID()
  ) => {
    const result = invoke(operation, { ...input, requestId }, { kind: 'public', actor });
    pending.add(result);
    void result.then(
      () => pending.delete(result),
      () => pending.delete(result)
    );
    return result;
  };
  onTestFinished(async () => {
    release();
    sessionRelease?.();
    fault.queryOnly = false;
    vi.useRealTimers();
    await Promise.allSettled([...pending]);
    await shutdownControlStoreWorkerClient();
    if (workspaceDb.sqlite.open) workspaceDb.sqlite.close();
    if (authorityDb.sqlite.open) authorityDb.sqlite.close();
    if (coreDb.sqlite.open) coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  // Both physical peers are owner-produced, even in a one-scope subject case.
  const corePeerRequest = randomUUID(),
    workspacePeerRequest = randomUUID();
  await send(coreCommands[0], { ...creation, id: 'peer', displayName: 'Peer' }, corePeerRequest);
  await send(
    workspaceCommand,
    { workspaceId: workspace.id, mcpId: 'peer', disabled: true, expectedRevision: 0 },
    workspacePeerRequest
  );
  if (command !== coreCommands[0])
    await send(coreCommands[0], {
      ...creation,
      expectedRevision: loadResourceCatalog(dataRoot, { kind: 'server' }).revision,
    });
  let stagedDigest: string | undefined;
  if (command === coreCommands[2]) {
    const staged = (await send(coreCommands[1], {
      ...creation,
      mcpId: 'shared',
      declaration: nextDeclaration,
      expectedRevision: 2,
    })) as { versionDigest: string };
    stagedDigest = staged.versionDigest;
  }
  const serverCatalog = () => loadResourceCatalog(dataRoot, { kind: 'server' });
  const localCatalog = () =>
    loadResourceCatalog(dataRoot, { kind: 'workspace', workspaceId: workspace.id });
  const beforeServer = serverCatalog(),
    beforeWorkspace = localCatalog();
  const input: Record<string, unknown> =
    command === coreCommands[0]
      ? { ...creation, expectedRevision: beforeServer.revision }
      : command === coreCommands[1]
        ? {
            ...creation,
            mcpId: 'shared',
            declaration: nextDeclaration,
            expectedRevision: beforeServer.revision,
          }
        : command === coreCommands[2]
          ? { mcpId: 'shared', digest: stagedDigest, expectedRevision: beforeServer.revision }
          : command === coreCommands[3]
            ? {
                mcpId: 'shared',
                expectedRevision: beforeServer.revision,
                bindingRevision: beforeServer.mcp.bindings.find(
                  (binding) => binding.entryId === 'shared'
                )!.revision,
                enabled: true,
                allowedTools: ['echo'],
                schemaPolicy: 'tracking',
                timeoutMs: 60_000,
              }
            : command === coreCommands[4]
              ? { mcpId: 'shared', expectedRevision: beforeServer.revision }
              : {
                  workspaceId: workspace.id,
                  mcpId: 'shared',
                  disabled: true,
                  expectedRevision: beforeWorkspace.revision,
                };
  const requestId = randomUUID();
  new Uint8Array(fault.request).set(Buffer.from(requestId));
  closed.length = 0;
  const physical = command === workspaceCommand ? 'workspace' : 'core';
  const scope = {
    actorId: userId,
    ...(physical === 'workspace' ? { workspaceId: workspace.id } : { coreId: 'server' }),
  };
  const targetDb = () => (physical === 'core' ? coreDb : workspaceDb);
  const rows = (db = targetDb(), id = requestId) =>
    db.sqlite
      .prepare('SELECT * FROM idempotency_requests WHERE request_id=? ORDER BY request_key')
      .all(id);
  const audits = () =>
    coreDb.sqlite
      .prepare('SELECT * FROM audit_events WHERE request_id=? ORDER BY outcome')
      .all(requestId);
  const file = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : null);
  const snapshot = () => ({
    server: file(join(dataRoot, 'server/catalog/catalog.json')),
    workspace: file(join(dataRoot, 'workspaces', workspace.id, 'catalog/catalog.json')),
    coreAudits: audits(),
    workspaceAudits: workspaceDb.sqlite
      .prepare('SELECT * FROM audit_events WHERE request_id=?')
      .all(requestId),
    coreReceipts: rows(coreDb),
    workspaceReceipts: rows(workspaceDb),
    closed: structuredClone(closed),
  });
  return {
    dataRoot,
    userId,
    workspaceId: workspace.id,
    command,
    input,
    requestId,
    physical,
    scope,
    actor,
    corePeerRequest,
    workspacePeerRequest,
    beforeServer,
    beforeWorkspace,
    stagedDigest,
    closed,
    get coreDb() {
      return coreDb;
    },
    get workspaceDb() {
      return workspaceDb;
    },
    targetDb,
    rows,
    audits,
    snapshot,
    serverCatalog,
    localCatalog,
    call: () => send(command, input, requestId),
    protect() {
      fault.queryOnly = true;
      coreDb.sqlite.pragma('query_only=ON');
      workspaceDb.sqlite.pragma('query_only=ON');
    },
    revoke() {
      revokeOpenKitAccessTokenRecord(authorityDb, admin.tokenId);
    },
    holdSession() {
      sessionEntered = new Promise((resolve) => {
        sessionReached = resolve;
      });
      sessionHold = new Promise((resolve) => {
        sessionRelease = resolve;
      });
      return sessionEntered;
    },
    releaseSession() {
      sessionRelease?.();
      sessionHold = undefined;
    },
    async cold() {
      await shutdownControlStoreWorkerClient();
      workspaceDb.sqlite.close();
      authorityDb.sqlite.close();
      coreDb.sqlite.close();
      coreDb = openCoreDb(dataRoot);
      authorityDb = openCoreDb(dataRoot);
      workspaceDb = openWorkspaceDb(dataRoot, workspace.id);
      store = new FsStore({ dataRoot });
      invoke = compose();
    },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function audit(f: Fixture, count = 2) {
  const events = f.audits() as {
    outcome: string;
    workspace_id: string | null;
    actor_json: string;
    resource: string;
    action: string;
    category: string;
    error_code: string | null;
    vault_grant_id: string | null;
  }[];
  expect(events).toHaveLength(count);
  const started = events.find((event) => event.outcome === 'unknown');
  expect(started).toBeDefined();
  expect(started!.resource).toBe(
    `mcp-command:${commandInputHash({ name: f.command, scope: f.scope, requestId: f.requestId })}`
  );
  for (const event of events) {
    expect(event).toMatchObject({
      action: f.command,
      category: 'system',
      error_code: null,
      vault_grant_id: null,
    });
    expect(event.workspace_id).toBe(f.physical === 'workspace' ? f.workspaceId : null);
    expect(JSON.parse(event.actor_json)).toEqual({ kind: 'user', id: f.userId });
  }
  if (count === 2)
    expect(events.find((event) => event.outcome === 'succeeded')?.resource).toBe(
      'catalog_mcp:shared'
    );
  expect(
    f.workspaceDb.sqlite.prepare('SELECT 1 FROM audit_events WHERE request_id=?').all(f.requestId)
  ).toEqual([]);
  return events;
}
function receipt(f: Fixture) {
  const records = f.rows();
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({
    request_key: commandRequestKey(f.command, f.requestId, f.scope),
    command_name: f.command,
    request_id: f.requestId,
    scope_json: JSON.stringify(f.scope),
    input_hash: commandInputHash({ ...f.input, requestId: f.requestId }),
    response_kind: 'catalog_mcp',
    response_id: 'shared',
  });
  expect(f.rows(f.physical === 'core' ? f.workspaceDb : f.coreDb)).toEqual([]);
  return records;
}
function effect(f: Fixture) {
  expect(f.closed).toEqual([[f.physical === 'workspace' ? f.workspaceId : null, 'shared']]);
  const catalog = f.physical === 'core' ? f.serverCatalog() : f.localCatalog();
  expect(catalog.revision).toBe(Number(f.input.expectedRevision) + 1);
  if (f.physical === 'workspace') {
    expect(catalog.mcp.disabledServerIds).toEqual(['peer', 'shared']);
    expect(f.serverCatalog()).toEqual(f.beforeServer);
  } else {
    expect(f.localCatalog()).toEqual(f.beforeWorkspace);
    const entry = catalog.mcp.entries.find((entry) => entry.id === 'shared');
    expect(entry).toBeDefined();
    if (f.command === coreCommands[0]) {
      expect(catalog.mcp.versions).toHaveLength(f.beforeServer.mcp.versions.length + 1);
      expect(entry!.availability).toBe('available');
    }
    if (f.command === coreCommands[1]) {
      expect(catalog.mcp.versions).toHaveLength(f.beforeServer.mcp.versions.length + 1);
      expect(entry!.currentVersionDigest).toBe(
        f.beforeServer.mcp.entries.find((entry) => entry.id === 'shared')!.currentVersionDigest
      );
    }
    if (f.command === coreCommands[2]) expect(entry!.currentVersionDigest).toBe(f.stagedDigest);
    if (f.command === coreCommands[3])
      expect(catalog.mcp.bindings.find((binding) => binding.entryId === 'shared')).toMatchObject({
        enabled: true,
        revision: Number(f.input.bindingRevision) + 1,
        allowedTools: ['echo'],
        credentialBindings: [],
      });
    if (f.command === coreCommands[4]) {
      expect(entry!.availability).toBe('removed');
      expect(catalog.mcp.versions).toEqual(f.beforeServer.mcp.versions);
    }
  }
}
function success(f: Fixture, result: unknown) {
  expect(result).toMatchObject({ revision: Number(f.input.expectedRevision) + 1 });
  if (f.command === coreCommands[0] || f.command === coreCommands[1])
    expect(result).toMatchObject({
      entry: { id: 'shared' },
      versionDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    });
}
function clocks() {
  const now = Date.now();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now - 8 * DAY);
  return { lookup: now - 2 * DAY, after: now };
}
async function lateBoundary(f: Fixture) {
  if (f.physical === 'core') {
    arm(2);
    const pending = f.call();
    await held(2, pending);
    return { pending, release };
  }
  const entered = f.holdSession(),
    pending = f.call();
  await entered;
  return { pending, release: () => f.releaseSession() };
}

it.each(commands)(
  'preserves original %s late receipt INSERT failure, exact effects and cold missing-receipt refusal',
  async (command) => {
    const f = await fixture(command);
    f.targetDb().sqlite.exec(
      `CREATE TRIGGER refuse_mcp_receipt BEFORE INSERT ON idempotency_requests WHEN NEW.request_id='${f.requestId}' BEGIN SELECT RAISE(ABORT,'MCP receipt INSERT'); END`
    );
    const error = await f.call().catch((error: unknown) => error);
    expect(Atomics.load(gate(), 5)).toBe(1);
    effect(f);
    audit(f);
    expect(f.rows()).toEqual([]);
    refusal(error);
    f.targetDb().sqlite.exec('DROP TRIGGER refuse_mcp_receipt');
    const retained = f.snapshot();
    await f.cold();
    expect(f.snapshot()).toEqual(retained);
    refusal(await f.call().catch((error: unknown) => error));
    expect(f.snapshot()).toEqual(retained);
  }
);
it.each(commands)(
  'preserves original %s separate committed receipt after a genuine late DELETE failure',
  async (command) => {
    const time = clocks(),
      f = await fixture(command);
    vi.setSystemTime(time.lookup);
    const peerId = f.physical === 'core' ? f.corePeerRequest : f.workspacePeerRequest;
    const peer = f.rows(f.targetDb(), peerId);
    expect(peer).toHaveLength(1);
    const boundary = await lateBoundary(f);
    effect(f);
    expect(Date.parse((peer[0] as { expires_at: string }).expires_at)).toBeGreaterThan(time.lookup);
    vi.setSystemTime(time.after);
    f.targetDb().sqlite.exec(
      `CREATE TRIGGER refuse_mcp_prune BEFORE DELETE ON idempotency_requests WHEN OLD.request_id='${peerId}' BEGIN SELECT RAISE(ABORT,'MCP receipt DELETE'); END`
    );
    boundary.release();
    const error = await boundary.pending.catch((error: unknown) => error);
    expect(Atomics.load(gate(), 5)).toBe(2);
    receipt(f);
    audit(f);
    effect(f);
    expect(f.rows(f.targetDb(), peerId)).toEqual(peer);
    refusal(error);
    expect(Date.parse((f.rows()[0] as { created_at: string }).created_at)).toBe(time.lookup);
    expect(Date.parse((f.rows()[0] as { expires_at: string }).expires_at)).toBeGreaterThan(
      time.after
    );
    f.targetDb().sqlite.exec('DROP TRIGGER refuse_mcp_prune');
    const retained = f.snapshot();
    await f.cold();
    expect(f.snapshot()).toEqual(retained);
    success(f, await f.call());
    expect(f.snapshot()).toEqual(retained);
  }
);
it.each([coreCommands[0], workspaceCommand] as const)(
  'samples original %s maintenance clock after its authentic completion boundary',
  async (command) => {
    const time = clocks(),
      f = await fixture(command);
    vi.setSystemTime(time.lookup);
    const peerId = f.physical === 'core' ? f.corePeerRequest : f.workspacePeerRequest;
    expect(f.rows(f.targetDb(), peerId)).toHaveLength(1);
    const boundary = await lateBoundary(f);
    vi.setSystemTime(time.after);
    boundary.release();
    success(f, await boundary.pending);
    expect(f.rows(f.targetDb(), peerId)).toEqual([]);
    receipt(f);
    audit(f);
    effect(f);
    expect(Date.parse((f.rows()[0] as { created_at: string }).created_at)).toBe(time.lookup);
    expect(Date.parse((f.rows()[0] as { expires_at: string }).expires_at)).toBeGreaterThan(
      time.after
    );
    const retained = f.snapshot();
    await f.cold();
    expect(f.snapshot()).toEqual(retained);
  }
);
it.each(['unknown', 'succeeded'] as const)(
  'preserves original shared-disable %s Core Audit failure prefix and Workspace association',
  async (outcome) => {
    const f = await fixture(workspaceCommand),
      before = f.snapshot();
    const message = outcome === 'unknown' ? 'MCP started Audit' : 'MCP completed Audit';
    f.coreDb.sqlite.exec(
      `CREATE TRIGGER refuse_shared_audit BEFORE INSERT ON audit_events WHEN NEW.request_id='${f.requestId}' AND NEW.outcome='${outcome}' BEGIN SELECT RAISE(ABORT,'${message}'); END`
    );
    const error = await f.call().catch((error: unknown) => error);
    expect(Atomics.load(gate(), 5)).toBe(outcome === 'unknown' ? 4 : 8);
    expect(f.rows()).toEqual([]);
    refusal(error);
    if (outcome === 'unknown') {
      expect(f.audits()).toEqual([]);
      expect(f.snapshot()).toEqual(before);
    } else {
      audit(f, 1);
      effect(f);
    }
    f.coreDb.sqlite.exec('DROP TRIGGER refuse_shared_audit');
    const retained = f.snapshot();
    await f.cold();
    expect(f.snapshot()).toEqual(retained);
    if (outcome === 'succeeded') {
      refusal(await f.call().catch((error: unknown) => error));
      expect(f.snapshot()).toEqual(retained);
    }
  }
);

it.each(commands)(
  'natively publishes %s exact receipt with all ordinary Main handles query-only',
  async (command) => {
    const f = await fixture(command);
    f.protect();
    const result = await f.call();
    success(f, result);
    effect(f);
    audit(f);
    receipt(f);
    expect(isControlNativeReceiptCommand(command, 'core')).toBe(command !== workspaceCommand);
    expect(isControlNativeReceiptCommand(command, 'workspace')).toBe(command === workspaceCommand);
    expect(isControlNativeReceiptCommand(command, 'user')).toBe(false);
    const retained = f.snapshot();
    await f.cold();
    expect(f.snapshot()).toEqual(retained);
    expect(await f.call()).toEqual(result);
    expect(f.snapshot()).toEqual(retained);
  }
);
it.each(commands.flatMap((command) => [3, 4].map((stage) => ({ command, stage }))))(
  'natively retains $command stage $stage FULL through lost ACK and warm/cold replay',
  async ({ command, stage }) => {
    const f = await fixture(command);
    f.protect();
    arm(stage);
    const pending = f.call();
    await held(stage, pending);
    effect(f);
    audit(f);
    receipt(f);
    const retained = f.snapshot(),
      posts = fault.posts.length;
    await fault.workers[Atomics.load(gate(), 4)]!.terminate();
    release();
    refusal(await pending.catch((error: unknown) => error));
    expect(f.snapshot()).toEqual(retained);
    expect(fault.posts).toHaveLength(posts);
    success(f, await f.call());
    expect(f.snapshot()).toEqual(retained);
    expect(fault.posts).toHaveLength(posts);
    await f.cold();
    expect(f.snapshot()).toEqual(retained);
    success(f, await f.call());
    expect(f.snapshot()).toEqual(retained);
  }
);
it.each([1, 2] as const)(
  'natively retains shared-disable Core Audit stage %i FULL without a Workspace receipt after lost ACK',
  async (stage) => {
    const f = await fixture(workspaceCommand);
    f.protect();
    const before = f.snapshot();
    arm(stage);
    const pending = f.call();
    await held(stage, pending);
    audit(f, stage);
    expect(f.rows()).toEqual([]);
    if (stage === 1) {
      expect(f.snapshot().server).toBe(before.server);
      expect(f.snapshot().workspace).toBe(before.workspace);
      expect(f.closed).toEqual([]);
    } else effect(f);
    const retained = f.snapshot(),
      posts = fault.posts.length;
    await fault.workers[Atomics.load(gate(), 4)]!.terminate();
    release();
    refusal(await pending.catch((error: unknown) => error));
    expect(f.snapshot()).toEqual(retained);
    expect(fault.posts).toHaveLength(posts);
    refusal(await f.call().catch((error: unknown) => error));
    expect(f.snapshot()).toEqual(retained);
    await f.cold();
    expect(f.snapshot()).toEqual(retained);
    refusal(await f.call().catch((error: unknown) => error));
    expect(f.snapshot()).toEqual(retained);
  }
);
it('natively repeats actual Workspace authority after shared-disable started Core Audit ACK before any effect', async () => {
  const f = await fixture(workspaceCommand);
  f.protect();
  const before = f.snapshot();
  arm(1);
  const pending = f.call();
  await held(1, pending);
  audit(f, 1);
  f.revoke();
  release();
  refusal(await pending.catch((error: unknown) => error), 'workspace_access_denied', 403);
  expect(f.snapshot().server).toBe(before.server);
  expect(f.snapshot().workspace).toBe(before.workspace);
  expect(f.closed).toEqual([]);
  expect(f.rows()).toEqual([]);
  audit(f, 1);
  const retained = f.snapshot();
  await f.cold();
  expect(f.snapshot()).toEqual(retained);
});
it('natively settles shared-disable evidence before strict current Workspace disclosure refusal across receipt ACK', async () => {
  const f = await fixture(workspaceCommand);
  f.protect();
  arm(3);
  const pending = f.call();
  await held(3, pending);
  effect(f);
  audit(f);
  receipt(f);
  const retained = f.snapshot();
  f.revoke();
  release();
  refusal(await pending.catch((error: unknown) => error), 'workspace_access_denied', 403);
  expect(f.snapshot()).toEqual(retained);
  await f.cold();
  expect(f.snapshot()).toEqual(retained);
});
it.each([coreCommands[0], workspaceCommand] as const)(
  'natively prunes %s only in its exact physical receipt database',
  async (command) => {
    const time = clocks(),
      f = await fixture(command);
    vi.setSystemTime(time.lookup);
    const peerId = f.physical === 'core' ? f.corePeerRequest : f.workspacePeerRequest;
    const otherDb = f.physical === 'core' ? f.workspaceDb : f.coreDb,
      otherId = f.physical === 'core' ? f.workspacePeerRequest : f.corePeerRequest;
    const other = f.rows(otherDb, otherId);
    expect(other).toHaveLength(1);
    expect(f.rows(f.targetDb(), peerId)).toHaveLength(1);
    arm(2);
    const pending = f.call();
    await held(2, pending);
    vi.setSystemTime(time.after);
    release();
    success(f, await pending);
    receipt(f);
    audit(f);
    effect(f);
    expect(f.rows(f.targetDb(), peerId)).toEqual([]);
    expect(f.rows(otherDb, otherId)).toEqual(other);
    const retained = f.snapshot();
    await f.cold();
    expect(f.snapshot()).toEqual(retained);
    expect(f.rows(f.physical === 'core' ? f.workspaceDb : f.coreDb, otherId)).toEqual(other);
  }
);

// This initial Original diagnostic qualifies actual public/catalog admission.
// It is not a claim that this absent upstream server is configured or executable.
it('preserves an Original public shared-disable identity beyond the structured Audit envelope', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'shared-mcp-large-identity-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  let store = new FsStore({ dataRoot });
  const workspace = await store.createWorkspace('Shared disable identity');
  const thread = await store.createThread(workspace.id, 'Unrelated protected Thread');
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
  let app = createAppWithLocalIdentity({ coreDb, dataRoot, store });
  let db = openWorkspaceDb(dataRoot, workspace.id);
  onTestFinished(async () => {
    await shutdownControlStoreWorkerClient();
    if (db.sqlite.open) db.sqlite.close();
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  const command = 'catalog.shared-mcp-set-disabled';
  const requestId = randomUUID();
  const mcpId = 'a'.repeat(1_048_608);
  const scope = { actorId: userId, workspaceId: workspace.id };
  const input = {
    workspaceId: workspace.id,
    requestId,
    mcpId,
    disabled: true,
    expectedRevision: 0,
  };
  const body = JSON.stringify(input);
  expect(Buffer.byteLength(body)).toBeGreaterThan(1_048_576);
  const registry = coreDb.sqlite
    .prepare('SELECT * FROM workspace_registry ORDER BY workspace_id')
    .all();
  const call = () =>
    app.request(`/api/app/operations/${command}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-openkit-request-id': requestId },
      body,
    });
  const response = await call();
  // A public/body/catalog refusal here is a resource-admission finding, not a
  // qualified Original transport regression. Preserve the actual failure first.
  expect(response.status, await response.clone().text()).toBe(200);
  expect(await response.json()).toEqual({ revision: 1 });
  expect(
    loadWorkspaceResourceCatalog(dataRoot, workspace.id).mcp.disabledServerIds[0] === mcpId
  ).toBe(true);
  expect(store.getThread(workspace.id, thread.id)).toEqual(thread);
  expect(
    coreDb.sqlite.prepare('SELECT * FROM workspace_registry ORDER BY workspace_id').all()
  ).toEqual(registry);
  const audits = () =>
    coreDb.sqlite
      .prepare('SELECT * FROM audit_events WHERE request_id=? ORDER BY outcome')
      .all(requestId) as { outcome: string; workspace_id: string; resource: string }[];
  const receipt = () =>
    db.sqlite.prepare('SELECT * FROM idempotency_requests WHERE request_id=?').all(requestId) as {
      response_id: string;
    }[];
  expect(audits()).toHaveLength(2);
  const started = audits().find((event) => event.outcome === 'unknown');
  const completed = audits().find((event) => event.outcome === 'succeeded');
  expect(started?.resource).toBe(
    `mcp-command:${commandInputHash({ name: command, scope, requestId })}`
  );
  expect(audits().map((event) => event.workspace_id)).toEqual([workspace.id, workspace.id]);
  expect(completed?.resource === `catalog_mcp:${mcpId}`).toBe(true);
  expect(receipt()).toHaveLength(1);
  expect(receipt()[0]).toMatchObject({
    request_key: commandRequestKey(command, requestId, scope),
    command_name: command,
    request_id: requestId,
    scope_json: JSON.stringify(scope),
    input_hash: commandInputHash(input),
    response_kind: 'catalog_mcp',
  });
  expect(receipt()[0]!.response_id === mcpId).toBe(true);
  expect(db.sqlite.prepare('SELECT 1 FROM audit_events WHERE request_id=?').all(requestId)).toEqual(
    []
  );
  expect(
    coreDb.sqlite.prepare('SELECT 1 FROM idempotency_requests WHERE request_id=?').all(requestId)
  ).toEqual([]);
  const digest = (value: unknown) =>
    createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const auditDigest = digest(audits()),
    receiptDigest = digest(receipt());
  const catalogBytes = readFileSync(
    join(dataRoot, 'workspaces', workspace.id, 'catalog/catalog.json')
  );
  await shutdownControlStoreWorkerClient();
  db.sqlite.close();
  db = openWorkspaceDb(dataRoot, workspace.id);
  store = new FsStore({ dataRoot });
  app = createAppWithLocalIdentity({ coreDb, dataRoot, store });
  expect(digest(audits())).toBe(auditDigest);
  expect(digest(receipt())).toBe(receiptDigest);
  expect(
    readFileSync(join(dataRoot, 'workspaces', workspace.id, 'catalog/catalog.json')).equals(
      catalogBytes
    )
  ).toBe(true);
  expect((await call()).status).toBe(200);
  expect(digest(audits())).toBe(auditDigest);
  expect(digest(receipt())).toBe(receiptDigest);
  expect(store.getThread(workspace.id, thread.id)).toEqual(thread);
  expect(
    coreDb.sqlite.prepare('SELECT * FROM workspace_registry ORDER BY workspace_id').all()
  ).toEqual(registry);
});
