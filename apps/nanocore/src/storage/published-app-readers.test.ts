// openkit-test-platform: posix
/** Actual App User/Workspace readers must reject SQL writes while native owners retain publication. */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { allocateEntityId } from '@openkit/protocol';
import Database from 'better-sqlite3';
import { expect, it, onTestFinished, vi } from 'vitest';
import { SimulatedTurnExecutor } from '../lib/simulator.js';
import { FsStore } from '../lib/store.js';
import { ProviderRegistry } from '../providers/registry.js';
import * as goalOwner from '../runtime/goal-coordinator.js';
import { createTestGatewayConfig } from '../test-support/agent-environment.js';
import { createAppWithLocalIdentity } from '../test-support/app.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { operationRequest } from '../test-support/operation-request.js';
import { createTestStore, createTestUserDb, disposeTestStore } from '../test-support/store.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { FileStorageAdmission } from './artifacts/file-admission.js';
import { closeWorkspaceProductReadHandles } from './control-store-product-records.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
import { openCoreDb, openUserReadDb } from './db.js';
import { userDbPath, workspaceDbPath } from './fs-layout.js';
import { applyMigrations } from './migrate.js';
import { readThreadReadReceipt } from './thread-read-receipts.js';

// Storage65/79 and Durable Execution589 require actual query-only readers and native acknowledgement.
// This L2 App composition observes the physical responsibility that public success alone cannot prove.
// Serving Core admission has its separate complete fence and is outside these two scoped readers.
it.each(['established', 'absent'] as const)(
  'keeps actual App User/Workspace handles read-only with an %s User database',
  async (userStorage) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-f1-app-main-fence-'));
    let phase: 'construct' | 'public' | 'native-ack' | 'stopped' = 'stopped';
    const listeners: Array<{ worker: Worker; listener: (reply: unknown) => void }> = [];
    const coreDb = openCoreDb(dataRoot);
    onTestFinished(async () => {
      phase = 'stopped';
      for (const { worker, listener } of listeners) worker.off('message', listener);
      vi.restoreAllMocks();
      await disposeTestStore(dataRoot, coreDb);
    });
    applyMigrations(coreDb);
    const userId = ensureLocalUser(coreDb);
    const store = createTestStore({ dataRoot });
    const workspace = await store.createWorkspace('F1 established Workspace');
    recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
    const thread = await store.createThread(workspace.id, 'F1 established conversation');
    const turn = await store.createTurn(workspace.id, thread.id, 'Fixture input', {
      kind: 'user',
      id: userId,
    });
    const item = await store.createItem({
      id: allocateEntityId('it'),
      owner: turn.owner,
      threadId: thread.id,
      turnId: turn.id,
      type: 'assistant-message',
      text: 'Exact F1 retained reply.',
      status: 'completed',
      createdAt: turn.startedAt!,
      completedAt: turn.startedAt!,
    });
    if (userStorage === 'established') createTestUserDb(dataRoot, userId).close();
    expect(existsSync(userDbPath(dataRoot, userId))).toBe(userStorage === 'established');
    const paths = new Map<string, 'user' | 'workspace'>([
      [userDbPath(dataRoot, userId), 'user'],
      [realpathSync(workspaceDbPath(dataRoot, workspace.id)), 'workspace'],
    ]);
    type Scope = 'user' | 'workspace';
    phase = 'construct';
    let insideObserver = false;
    const handles = new Map<Database.Database, { scope: Scope; firstObservedPhase: string }>();
    const policies: Array<{ scope: Scope; phase: string; readonly: boolean; queryOnly: unknown }> =
      [];
    const probes: Array<{
      scope: Scope;
      code: string | null;
      unchanged: boolean;
      inTransaction: boolean;
      queryOnly: unknown;
    }> = [];
    const ordinaryMainWrites: Array<{ scope: Scope; operation: string }> = [];
    const nativeAcks: Array<{ scope: Scope; operation: string; id: number }> = [];
    const prepare = Database.prototype.prepare;
    const exec = Database.prototype.exec;
    const close = Database.prototype.close;
    const postMessage = Worker.prototype.postMessage;
    const requests = new Map<Worker, Map<number, { scope: Scope; operation: string }>>();

    const observe = (db: Database.Database, at = phase) => {
      if (insideObserver || phase === 'stopped' || !db.open) return;
      const scope = paths.get(db.name);
      if (!scope) return; // Exact selected canonical User and Workspace paths, never a filename/category guess.
      insideObserver = true;
      try {
        handles.set(db, handles.get(db) ?? { scope, firstObservedPhase: at });
        policies.push({
          scope,
          phase: at,
          readonly: db.readonly,
          queryOnly: db.pragma('query_only', { simple: true }),
        });
      } finally {
        insideObserver = false;
      }
    };
    const probe = (db: Database.Database) => {
      if (insideObserver || phase === 'stopped' || !db.open) return;
      const scope = paths.get(db.name);
      if (!scope) return;
      observe(db);
      insideObserver = true;
      try {
        const inTransaction = db.inTransaction;
        if (inTransaction) {
          probes.push({
            scope,
            code: null,
            unchanged: false,
            inTransaction,
            queryOnly: db.pragma('query_only', { simple: true }),
          });
          return;
        }
        const before = prepare.call(db, 'SELECT * FROM __drizzle_migrations ORDER BY id').all();
        expect(before.length).toBeGreaterThan(0);
        let code: string | null = null;
        exec.call(db, 'SAVEPOINT f1_readonly_challenge');
        try {
          // Genuine protected DML against a real setup-owned journal row. Always rolled back.
          prepare
            .call(
              db,
              'DELETE FROM __drizzle_migrations WHERE id = (SELECT id FROM __drizzle_migrations ORDER BY id LIMIT 1)'
            )
            .run();
        } catch (error) {
          code =
            typeof error === 'object' && error !== null && 'code' in error
              ? String(error.code)
              : 'UNCLASSIFIED';
        } finally {
          exec.call(db, 'ROLLBACK TO f1_readonly_challenge');
          exec.call(db, 'RELEASE f1_readonly_challenge');
        }
        const after = prepare.call(db, 'SELECT * FROM __drizzle_migrations ORDER BY id').all();
        probes.push({
          scope,
          code,
          unchanged: JSON.stringify(after) === JSON.stringify(before),
          inTransaction,
          queryOnly: db.pragma('query_only', { simple: true }),
        });
      } finally {
        insideObserver = false;
      }
    };
    vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (
      this: Database.Database,
      sql: string
    ) {
      observe(this);
      const statement = prepare.call(this, sql) as Database.Statement;
      if (!insideObserver && phase !== 'stopped' && paths.has(this.name) && !statement.readonly) {
        const db = this;
        const run = statement.run;
        statement.run = function (...args: unknown[]) {
          const result = Reflect.apply(run, this, args);
          if (
            !insideObserver &&
            phase !== 'stopped' &&
            !/^\s*(?:BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(sql)
          )
            ordinaryMainWrites.push({
              scope: paths.get(db.name)!,
              operation: sql.trim().split(/\s+/, 1)[0]!,
            });
          return result;
        };
      }
      return statement;
    });
    vi.spyOn(Database.prototype, 'exec').mockImplementation(function (
      this: Database.Database,
      sql: string
    ) {
      observe(this);
      const result = exec.call(this, sql);
      if (
        !insideObserver &&
        phase !== 'stopped' &&
        paths.has(this.name) &&
        /^\s*(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP|VACUUM|REINDEX|ANALYZE)\b/i.test(sql)
      )
        ordinaryMainWrites.push({
          scope: paths.get(this.name)!,
          operation: sql.trim().split(/\s+/, 1)[0]!,
        });
      return result;
    });
    vi.spyOn(Database.prototype, 'close').mockImplementation(function (this: Database.Database) {
      try {
        probe(this);
      } catch (error) {
        close.call(this);
        throw error;
      }
      return close.call(this);
    });
    const databaseScopes = new Map<string, Scope>(
      [...paths].map(([path, scope]) => [`${scope}:${path}`, scope])
    );
    vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (
      this: Worker,
      ...args: Parameters<Worker['postMessage']>
    ) {
      if (!requests.has(this)) {
        requests.set(this, new Map());
        const listener = (reply: unknown) => {
          if (typeof reply !== 'object' || reply === null) return;
          const value = reply as { id?: number; status?: string };
          if (value.id === undefined || (value.status !== 'ok' && value.status !== 'error')) return;
          const request = requests.get(this)?.get(value.id);
          if (!request) return;
          requests.get(this)!.delete(value.id);
          if (value.status !== 'ok') return;
          nativeAcks.push({ ...request, id: value.id });
          for (const db of handles.keys()) observe(db, 'native-ack');
        };
        this.on('message', listener);
        listeners.push({ worker: this, listener });
      }
      if (typeof args[0] !== 'object' || args[0] === null)
        return Reflect.apply(postMessage, this, args);
      const request = args[0] as {
        id?: number;
        database?: string;
        operation?: string;
        path?: string;
      };
      if (request.operation === 'open' && request.path && request.database) {
        const scope = paths.get(request.path);
        if (scope) databaseScopes.set(request.database, scope);
      }
      const scope = request.database ? databaseScopes.get(request.database) : undefined;
      if (scope && typeof request.id === 'number' && request.operation)
        requests.get(this)!.set(request.id, { scope, operation: request.operation });
      return Reflect.apply(postMessage, this, args); // No fabricated reply, content read or ACK hold.
    });
    const createCoordinator = goalOwner.createGoalCoordinator;
    const coordinators = vi
      .spyOn(goalOwner, 'createGoalCoordinator')
      .mockImplementation((options) => {
        const coordinator = createCoordinator(options);
        vi.spyOn(coordinator, 'boot'); // Original owner and SAME original Promise.
        return coordinator;
      });
    const fileAdmission = new FileStorageAdmission(dataRoot, () => 1_000_000_000n);
    const app = createAppWithLocalIdentity({
      coreDb,
      dataRoot,
      store,
      fileAdmission,
      turnExecutor: new SimulatedTurnExecutor({ coreDb, fileAdmission }),
      gatewayConfig: createTestGatewayConfig(),
      providerRegistry: new ProviderRegistry([
        {
          id: 'agent-openrouter',
          kind: 'local',
          displayName: 'Fixture provider',
          defaultModel: 'openai/gpt-5.2',
          models: ['openai/gpt-5.2'],
        },
      ]),
    });
    for (const result of coordinators.mock.results)
      await vi.mocked(result.value.boot).mock.results[0]!.value;
    phase = 'public';
    const call = (id: Parameters<typeof operationRequest>[0], input: Record<string, unknown>) =>
      app.request(
        ...operationRequest(id, input, { headers: { 'x-openkit-request-id': randomUUID() } })
      );
    const attention = await call('attention.list', { workspaceId: workspace.id });
    expect(attention.status).toBe(200);
    expect(Array.isArray((await attention.json()).items)).toBe(true);
    const logins = await call('vault.login-list', {});
    expect(logins.status).toBe(200);
    expect(await logins.json()).toEqual({ items: [] }); // No real credential or Login fixture is read/created.
    const read = await call('thread.mark-read', {
      workspaceId: workspace.id,
      threadId: thread.id,
      itemIds: [item.id],
    });
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ scope: 'window', acknowledgedItemIds: [item.id] });
    const created = await call('thread.create', {
      workspaceId: workspace.id,
      name: 'F1 native publication',
    });
    expect(created.status).toBe(200);
    const published = await created.json();
    const retainedThread = store.getThread(workspace.id, published.id);
    expect(retainedThread.name).toBe('F1 native publication');
    expect(published).toEqual(retainedThread);
    expect(new Set([...handles.values()].map(({ scope }) => scope))).toEqual(
      new Set(['user', 'workspace'])
    );
    expect(
      nativeAcks.some(
        ({ scope, operation }) => scope === 'user' && operation === 'thread-read-membership'
      )
    ).toBe(true);
    expect(
      nativeAcks.some(({ scope, operation }) => scope === 'workspace' && operation !== 'open')
    ).toBe(true);
    expect(
      nativeAcks.some(({ scope, operation }) => scope === 'user' && operation === 'open')
    ).toBe(true);

    // No Main transaction is retained across this native drain or any public await.
    await shutdownControlStoreWorkerClient();
    closeWorkspaceProductReadHandles(dataRoot);
    coreDb.sqlite.close();
    expect([...handles.keys()].every((db) => !db.open)).toBe(true);
    phase = 'stopped';
    const coldUser = openUserReadDb(dataRoot, userId);
    try {
      expect(readThreadReadReceipt(coldUser, workspace.id, thread.id)).toEqual([item.id]);
    } finally {
      coldUser.sqlite.close();
    }
    const coldStore = new FsStore({ dataRoot });
    expect(coldStore.getThread(workspace.id, retainedThread.id)).toEqual(retainedThread);

    // Storage requires both physical readonly and query_only. The rollback-only DML challenge
    // must fail with SQLITE_READONLY on those same observed Main handles, before any retained change.
    // Public success, native ACKs, exact receipt and cold Thread checks above remain prerequisites.
    // Readonly admission can inspect its journal before setting connection-local query_only.
    expect(policies.filter(({ readonly }) => !readonly)).toEqual([]);
    expect(new Set(probes.map(({ scope }) => scope))).toEqual(new Set(['user', 'workspace']));
    expect(
      probes.every(
        ({ code, unchanged, inTransaction, queryOnly }) =>
          code === 'SQLITE_READONLY' && unchanged && !inTransaction && queryOnly === 1
      )
    ).toBe(true);
    expect(ordinaryMainWrites).toEqual([]);
  }
);
