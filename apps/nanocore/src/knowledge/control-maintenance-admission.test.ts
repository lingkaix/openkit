import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { allocateEntityId } from '@openkit/protocol';
import Database from 'better-sqlite3';
import { describe, expect, it, onTestFinished } from 'vitest';
import {
  createInMemoryRuntimeConfigSnapshot,
  type RuntimeConfigManager,
} from '../config/runtime-config.js';
import { runKnowledgeManagerAgent } from '../internal-agents/knowledge-manager-agent.js';
import { commandRequestKey, FsStore, quickChatWorkspaceIdForUser } from '../lib/store.js';
import { commandInputHash, IdempotencyKeyConflictError } from '../runtime/idempotent-command.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from '../storage/control-store-worker-client.js';
import { openCoreDb, openUserDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { initializeTestCore } from '../test-support/store.js';
import type { ControlMaintenanceAdmissionInput } from './knowledge-agent-maintenance.js';
import { scanDailyKnowledgeMaintenance } from './knowledge-maintenance-schedule.js';
import { NotebookError } from './notebook.js';
import { runUserMemoryMaintenanceCommand } from './user-memory-agent-maintenance.js';

const timestamp = '2026-10-20T12:00:00.000Z';
const userId = allocateEntityId('usr');

/** Runs the actual owner on a real worker connection; test setup finishes before native writing starts. */
function fixture(kind: 'server' | 'workspace' | 'user' = 'workspace') {
  const root = mkdtempSync(join(tmpdir(), 'maintenance-admission-'));
  if (kind === 'user') initializeTestCore(root);
  const workspaceId =
    kind === 'user' ? quickChatWorkspaceIdForUser(userId) : allocateEntityId('ws');
  const db = kind === 'server' ? openCoreDb(root) : openWorkspaceDb(root, workspaceId);
  if (db.scope === 'core') applyMigrations(db);
  else applyScopedMigrations(db);
  db.sqlite.close();
  const require = createRequire(import.meta.url);
  const loader = pathToFileURL(require.resolve('tsx/esm/api')).href;
  const modules = {
    admission: new URL('./knowledge-agent-maintenance.ts', import.meta.url).href,
    db: new URL('../storage/db.ts', import.meta.url).href,
    products: new URL('../storage/control-store-products.ts', import.meta.url).href,
    bootstrap: new URL('../storage/control-store-admission.ts', import.meta.url).href,
  };
  const entry = join(root, 'native-admission-test.mts');
  writeFileSync(
    entry,
    `
    import ${JSON.stringify(modules.bootstrap)};
    import { parentPort, workerData } from 'node:worker_threads';
    import { openCoreDb, openWorkspaceDb } from ${JSON.stringify(modules.db)};
    import { applyControlMaintenanceAdmission } from ${JSON.stringify(modules.admission)};
    import { applyControlProducts } from ${JSON.stringify(modules.products)};
      const db = workerData.kind === 'server' ? openCoreDb(workerData.root) : openWorkspaceDb(workerData.root, workerData.workspaceId);
      if (workerData.kind !== 'server') db.sqlite.transaction(() => applyControlProducts(db.sqlite,
        {kind:'workspace', workspaceId:workerData.workspaceId}, [{kind:'workspace',expectedRevision:0,record:{
          schemaVersion:1,id:workerData.workspaceId,kind:workerData.kind === 'user' ? 'personal' : 'general',
          status:'active',createdAt:workerData.timestamp,updatedAt:workerData.timestamp
        }}], [])).immediate();
      parentPort.on('message', ({ id, action, input, sql }) => {
        try {
          let result;
          if (action === 'apply') result = db.sqlite.transaction(() => applyControlMaintenanceAdmission(db, input)).immediate();
          else if (action === 'sql') result = db.sqlite.prepare(sql).all();
          else if (action === 'exec') { db.sqlite.exec(sql); result = null; }
          parentPort.postMessage({id,result});
        } catch (error) { parentPort.postMessage({id,error:{name:error.name,message:error.message,code:error.code,stack:error.stack}}); }
      });
      parentPort.postMessage({ready:true});
  `
  );
  const worker = new Worker(
    `import(${JSON.stringify(loader)}).then(({tsImport}) => tsImport(${JSON.stringify(pathToFileURL(entry).href)}, ${JSON.stringify(import.meta.url)}));`,
    { eval: true, workerData: { root, workspaceId, kind, timestamp } }
  );
  let nextId = 0;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: unknown) => void }
  >();
  const ready = new Promise<void>((resolve, reject) => {
    worker.on('error', reject);
    worker.on('message', (reply) => {
      if (reply.ready) {
        resolve();
        return;
      }
      const call = pending.get(reply.id);
      pending.delete(reply.id);
      if (reply.error) call?.reject(reply.error);
      else call?.resolve(reply.result);
    });
  });
  let nativeClient: ReturnType<typeof getControlStoreWorkerClient> | undefined;
  const path =
    kind === 'server'
      ? join(root, 'server', 'db', 'core.sqlite')
      : join(root, 'workspaces', workspaceId, 'db', 'workspace.sqlite');
  onTestFinished(async () => {
    await nativeClient?.shutdown();
    await worker.terminate();
    rmSync(root, { recursive: true, force: true });
  });
  const call = async (action: string, value: unknown) => {
    await ready;
    if (nativeClient) {
      if (action === 'sql') {
        const reader = new Database(path, { readonly: true, fileMustExist: true });
        reader.pragma('query_only = ON');
        try {
          return reader.prepare(value as string).all();
        } finally {
          reader.close();
        }
      }
      if (action === 'exec')
        return nativeClient.write(`${kind === 'server' ? 'core' : 'workspace'}:${path}`, [
          { mode: 'run', sql: value as string, parameters: [] },
        ]);
      throw new Error('Direct owner fixture is stopped after native transport takes ownership.');
    }
    const id = ++nextId;
    return new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker.postMessage({
        id,
        action,
        ...(action === 'apply' ? { input: value } : { sql: value }),
      });
    });
  };
  const input = (receipt = kind !== 'user'): ControlMaintenanceAdmissionInput => {
    const requestId = randomUUID();
    const scope =
      kind === 'server'
        ? { coreId: 'server' as const, actorId: userId }
        : { workspaceId, actorId: userId };
    const command =
      kind === 'server' ? ('knowledge.server.maintain' as const) : ('knowledge.maintain' as const);
    return {
      purpose: 'maintenance',
      ownerScope:
        kind === 'server'
          ? { kind: 'server' }
          : kind === 'user'
            ? { kind: 'user', userId }
            : { kind: 'workspace', workspaceId },
      actor: { kind: 'user', id: userId },
      requestId,
      threadId: allocateEntityId('th'),
      turnId: allocateEntityId('tu'),
      startedAt: timestamp,
      trigger: 'request',
      instructions: 'Native maintenance',
      captureCoverage: { scope: kind === 'server' ? 'server' : 'workspace', value: 'off' },
      ...(receipt
        ? {
            receipt: {
              key: commandRequestKey(command, requestId, scope),
              command,
              requestId,
              scope,
              inputHash: commandInputHash({ instructions: 'Native maintenance' }),
              responseKind: 'turn' as const,
              createdAt: timestamp,
              expiresAt: '2026-11-20T12:00:00.000Z',
            },
          }
        : {}),
    };
  };
  return {
    input,
    transport: async () => {
      await ready;
      await worker.terminate();
      nativeClient = getControlStoreWorkerClient();
      const database = `${kind === 'server' ? 'core' : 'workspace'}:${path}`;
      await nativeClient.open({
        database,
        path,
        dataRoot: root,
        create: false,
        initialize: kind === 'server' ? 'core' : 'workspace',
        productOwner: kind === 'server' ? { kind: 'server' } : { kind: 'workspace', workspaceId },
      });
      return { client: nativeClient, database };
    },
    apply: (value: unknown) => call('apply', value),
    sql: (sql: string) => call('sql', sql),
    exec: (sql: string) => call('exec', sql),
  };
}

describe('native Knowledge maintenance admission', () => {
  it('admits only scheduled Server service metadata without a responsible User', async () => {
    const f = fixture('server');
    const { client, database } = await f.transport();
    const actor = { kind: 'system' as const, id: 'knowledge-manager', responsibleUserId: null };
    const daily = { ...f.input(false), actor, trigger: 'schedule' as const };
    await expect(client.maintenance(database, daily)).resolves.toEqual({
      threadId: daily.threadId,
      turnId: daily.turnId,
      busy: false,
      replayed: false,
    });
    const rows = (await f.sql('SELECT record_json FROM control_turns')) as {
      record_json: string;
    }[];
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.record_json)).toMatchObject({
      owner: { kind: 'server' },
      triggerActor: actor,
      triggerSource: { kind: 'automation', summary: 'Knowledge Manager scheduled maintenance.' },
    });
    expect(await f.sql('SELECT * FROM idempotency_requests')).toEqual([]);
    const tables = ['control_threads', 'control_turns', 'idempotency_requests'];
    const before = await Promise.all(tables.map((table) => f.sql(`SELECT * FROM ${table}`)));
    const original = f.input();
    const scope = { coreId: 'server' as const, actorId: actor.id };
    const receipt = {
      ...original.receipt!,
      scope,
      key: commandRequestKey('knowledge.server.maintain', original.requestId, scope),
    };
    const denied: ControlMaintenanceAdmissionInput[] = [
      { ...daily, trigger: 'request' },
      { ...daily, actor: { ...actor, id: 'unrelated-system' } },
      { ...daily, requestId: original.requestId, receipt },
      { ...daily, purpose: 'query', trigger: 'request' },
      ...(['agent', 'automation', 'integration'] as const).map((kind) => ({
        ...daily,
        actor: {
          ...actor,
          kind,
          id: kind === 'automation' ? allocateEntityId('auto') : actor.id,
        },
      })),
      { ...daily, ownerScope: { kind: 'workspace', workspaceId: allocateEntityId('ws') } },
      { ...daily, ownerScope: { kind: 'user', userId } },
    ];
    for (const variant of denied) {
      const input = { ...variant, turnId: allocateEntityId('tu') };
      const refusal: unknown = await client
        .maintenance(database, input)
        .catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(NotebookError);
      expect(refusal).toMatchObject({ code: 'invalid_request' });
      expect(await Promise.all(tables.map((table) => f.sql(`SELECT * FROM ${table}`)))).toEqual(
        before
      );
    }
  }, 30_000);

  it('does not extend Server metadata admission into Workspace or private User work', async () => {
    for (const kind of ['workspace', 'user'] as const) {
      const f = fixture(kind);
      const first = f.input(false);
      await f.apply(first);
      const { client, database } = await f.transport();
      const tables = [
        'control_workspaces',
        'control_threads',
        'control_turns',
        'idempotency_requests',
      ];
      const before = await Promise.all(tables.map((table) => f.sql(`SELECT * FROM ${table}`)));
      const actor = { kind: 'system' as const, id: 'knowledge-manager', responsibleUserId: null };
      const daily = { ...f.input(false), actor, trigger: 'schedule' as const };
      const denied: ControlMaintenanceAdmissionInput[] = [
        daily,
        { ...daily, ownerScope: { kind: 'server' } },
        { ...daily, purpose: 'query', trigger: 'request', outputThreadId: first.threadId },
        { ...daily, purpose: 'query', trigger: 'request', ownerScope: { kind: 'user', userId } },
      ];
      for (const input of denied) {
        const refusal: unknown = await client
          .maintenance(database, input)
          .catch((error: unknown) => error);
        expect(refusal).toBeInstanceOf(NotebookError);
        expect(refusal).toMatchObject({ code: 'invalid_request' });
        expect(await Promise.all(tables.map((table) => f.sql(`SELECT * FROM ${table}`)))).toEqual(
          before
        );
      }
    }
  }, 30_000);

  for (const kind of ['workspace', 'server'] as const) {
    it(`commits and replays the original ${kind} receipt through production transport after a reached-trigger rollback`, async () => {
      const f = fixture(kind);
      const input = f.input();
      await f.exec(
        "CREATE TRIGGER refuse_receipt BEFORE INSERT ON idempotency_requests BEGIN SELECT RAISE(ABORT, 'receipt refused'); END"
      );
      const { client, database } = await f.transport();
      await expect(client.maintenance(database, input)).rejects.toMatchObject({
        code: 'constraint',
        commit: 'not-committed',
        message: 'Control database writer operation failed.',
      });
      for (const table of ['control_threads', 'control_turns', 'idempotency_requests'])
        expect(await f.sql(`SELECT * FROM ${table}`)).toEqual([]);
      await f.exec('DROP TRIGGER refuse_receipt');
      await expect(client.maintenance(database, input)).resolves.toEqual({
        threadId: input.threadId,
        turnId: input.turnId,
        busy: false,
        replayed: false,
      });
      await expect(client.maintenance(database, input)).resolves.toEqual({
        threadId: input.threadId,
        turnId: input.turnId,
        busy: false,
        replayed: true,
      });
      expect(await f.sql('SELECT response_id FROM idempotency_requests')).toEqual([
        { response_id: input.turnId },
      ]);
      await expect(
        client.maintenance(database, {
          ...input,
          receipt: { ...input.receipt!, inputHash: commandInputHash({ changed: true }) },
        })
      ).rejects.toBeInstanceOf(IdempotencyKeyConflictError);
      await expect(
        client.maintenance(database, {
          ...f.input(),
          ownerScope: { kind: 'workspace', workspaceId: allocateEntityId('ws') },
        })
      ).rejects.toBeInstanceOf(NotebookError);
    }, 30_000);
  }

  for (const kind of ['workspace', 'server'] as const) {
    it(`rolls back every ${kind} product when the original receipt insert fails`, async () => {
      const f = fixture(kind);
      await f.exec(
        "CREATE TRIGGER refuse_receipt BEFORE INSERT ON idempotency_requests BEGIN SELECT RAISE(ABORT, 'receipt refused'); END"
      );
      await expect(f.apply(f.input())).rejects.toMatchObject({ code: 'SQLITE_CONSTRAINT_TRIGGER' });
      expect(await f.sql('SELECT id FROM control_threads')).toEqual([]);
      expect(await f.sql('SELECT id FROM control_turns')).toEqual([]);
      expect(await f.sql('SELECT request_key FROM idempotency_requests')).toEqual([]);
      await f.exec('DROP TRIGGER refuse_receipt');
      await expect(f.apply(f.input())).resolves.toMatchObject({ busy: false, replayed: false });
    }, 30_000);
  }

  it('selects current SQL work, retains descriptive fields, and replays only the original receipt', async () => {
    const f = fixture();
    const first = f.input();
    await expect(f.apply(first)).resolves.toMatchObject({
      threadId: first.threadId,
      turnId: first.turnId,
      busy: false,
    });
    await f.exec(
      `UPDATE control_threads SET record_json=json_set(record_json,'$.futureNote','retain me') WHERE id='${first.threadId}'`
    );
    const next = f.input();
    await expect(f.apply(next)).resolves.toMatchObject({
      threadId: first.threadId,
      turnId: next.turnId,
      busy: true,
    });
    expect(
      await f.sql("SELECT json_extract(record_json,'$.futureNote') AS note FROM control_threads")
    ).toEqual([{ note: 'retain me' }]);
    const replay = { ...first, threadId: allocateEntityId('th'), turnId: allocateEntityId('tu') };
    await expect(f.apply(replay)).resolves.toMatchObject({
      threadId: first.threadId,
      turnId: first.turnId,
      replayed: true,
    });
    await expect(
      f.apply({ ...replay, receipt: { ...first.receipt!, inputHash: commandInputHash('changed') } })
    ).rejects.toMatchObject({ name: 'IdempotencyKeyConflictError' });
    expect(await f.sql('SELECT count(*) AS count FROM control_turns')).toEqual([{ count: 2 }]);
  }, 30_000);

  it('refuses unknown required semantics before writes and does not lose extension data', async () => {
    const f = fixture();
    const first = f.input();
    await f.apply(first);
    await f.exec(
      `UPDATE control_threads SET record_json=json_set(record_json,'$.requiredFeatures',json('["unknown.authority"]')) WHERE id='${first.threadId}'`
    );
    await expect(f.apply(f.input())).rejects.toBeDefined();
    expect(await f.sql('SELECT count(*) AS count FROM control_turns')).toEqual([{ count: 1 }]);
    expect(await f.sql('SELECT count(*) AS count FROM idempotency_requests')).toEqual([
      { count: 1 },
    ]);
  }, 30_000);

  it('keeps User products private in the personal Workspace and refuses a User receipt in that commit', async () => {
    const f = fixture('user');
    const first = f.input();
    await f.apply(first);
    expect(
      await f.sql(
        "SELECT json_extract(record_json,'$.visibility') AS visibility,json_extract(record_json,'$.privateOwnerUserId') AS userId FROM control_threads"
      )
    ).toEqual([{ visibility: 'private', userId }]);
    await expect(
      f.apply({
        ...f.input(),
        receipt: { ...fixtureReceipt(), scope: { userId, actorId: userId } },
      })
    ).rejects.toBeDefined();
    expect(await f.sql('SELECT request_key FROM idempotency_requests')).toEqual([]);
    expect(await f.sql('SELECT count(*) AS count FROM control_turns')).toEqual([{ count: 1 }]);
  }, 30_000);

  it('commits a User failure result with the real role terminal and replays it after cold reopen', async () => {
    const root = mkdtempSync(join(tmpdir(), 'memory-terminal-result-'));
    const coreDb = openCoreDb(root);
    applyMigrations(coreDb);
    const userId = ensureLocalUser(coreDb);
    const userDb = openUserDb(root, userId);
    applyScopedMigrations(userDb);
    onTestFinished(async () => {
      await shutdownControlStoreWorkerClient();
      userDb.sqlite.close();
      coreDb.sqlite.close();
      rmSync(root, { recursive: true, force: true });
    });
    const store = new FsStore({ dataRoot: root });
    const snapshot = createInMemoryRuntimeConfigSnapshot({ dataRoot: root });
    let runs = 0;
    const dependencies = {
      coreDb,
      userDb,
      store,
      runtimeConfigManager: {
        current: () => ({
          userConfigs: [
            {
              userId,
              config: {
                knowledgeMaintenance: { enabled: true, reviewRequiredPageIds: [] },
              },
            },
          ],
        }),
      } as unknown as RuntimeConfigManager,
      openWorkspace: (id: string) => openWorkspaceDb(root, id),
      inflightCommands: new WeakMap(),
      pin: async () => {},
      run: (input: Parameters<typeof runKnowledgeManagerAgent>[1]) => {
        runs += 1;
        return runKnowledgeManagerAgent(
          {
            store,
            runtimeConfig: () => snapshot,
            dispatcher: {
              createResponses: async () => {
                throw new Error('No Provider is admitted.');
              },
            },
            resolveGatewayProvider: () => {
              throw new Error('No Provider is admitted.');
            },
          },
          input
        );
      },
    };
    const input = {
      requestId: randomUUID(),
      requestActor: { kind: 'local' as const, userId },
      trigger: 'request' as const,
      instructions: 'Inspect the current notebook.',
      sources: [],
      signal: new AbortController().signal,
    };
    const first = await runUserMemoryMaintenanceCommand(dependencies, input);
    expect(first.outcome).toBe('failed');
    const turn = store.getTurnById(first.turnId);
    expect(turn).toMatchObject({ status: 'failed', error: { code: 'knowledge_manager_failed' } });
    expect(turn.items.filter((item) => item.type === 'status')).toMatchObject([
      { knowledgeMaintenanceResult: first },
    ]);
    const receipt = userDb.sqlite.prepare('SELECT * FROM idempotency_requests').all();
    await shutdownControlStoreWorkerClient();
    const reopened = new FsStore({ dataRoot: root });
    await expect(
      runUserMemoryMaintenanceCommand({ ...dependencies, store: reopened }, input)
    ).resolves.toEqual(first);
    expect(runs).toBe(1);
    expect(userDb.sqlite.prepare('SELECT * FROM idempotency_requests').all()).toEqual(receipt);
  });

  it('creates fresh private query identities and deduplicates scheduled days from retained SQL', async () => {
    const f = fixture();
    const first = { ...f.input(false), purpose: 'query' as const };
    const second = { ...f.input(false), purpose: 'query' as const };
    await f.apply(first);
    await f.apply(second);
    expect(first.threadId).not.toBe(second.threadId);
    expect(
      await f.sql(
        "SELECT DISTINCT json_extract(record_json,'$.visibility') AS visibility FROM control_threads"
      )
    ).toEqual([{ visibility: 'private' }]);
    const daily = { ...f.input(false), trigger: 'schedule' as const };
    let preparations = 0;
    const errors: unknown[] = [];
    const scan = async () => {
      const rows = (await f.sql('SELECT record_json FROM control_turns')) as {
        record_json: string;
      }[];
      await scanDailyKnowledgeMaintenance({
        now: timestamp,
        scopes: [{ ownerScope: daily.ownerScope, schedule: { enabled: true } }],
        // The app projects this exact retained pre-pin lineage into the daily scanner.
        listTurns: () =>
          rows.map(({ record_json }) => {
            const turn = JSON.parse(record_json);
            return {
              startedAt: turn.startedAt,
              ...(turn.agentId === 'knowledge-manager' &&
              turn.triggerSource?.kind === 'automation' &&
              turn.triggerSource.summary === 'Knowledge Manager scheduled maintenance.'
                ? {
                    internalExecution: {
                      roleId: 'knowledge-manager',
                      knowledge: {
                        purpose: 'maintenance' as const,
                        ownerScope: daily.ownerScope,
                        trigger: 'schedule' as const,
                      },
                    },
                  }
                : {}),
            };
          }),
        prepare: async () => {
          preparations += 1;
          await f.apply(daily);
          return null;
        },
        onError: (error) => errors.push(error),
      });
    };
    await scan();
    // Stop the direct owner and reopen retained native SQL before the same-day scan.
    await f.transport();
    await scan();
    expect(preparations).toBe(1);
    expect(errors).toEqual([]);
    expect(
      await f.sql(
        `SELECT id AS turnId, thread_id AS threadId FROM control_turns
       WHERE json_extract(record_json,'$.triggerSource.kind') = 'automation'`
      )
    ).toEqual([{ threadId: daily.threadId, turnId: daily.turnId }]);
    expect(await f.sql('SELECT count(*) AS count FROM control_turns')).toEqual([{ count: 3 }]);
  }, 30_000);
});

/** Deliberately invalid cross-domain receipt; it must fail at the closed DTO boundary. */
function fixtureReceipt() {
  return {
    key: 'invalid',
    command: 'knowledge.maintain',
    requestId: randomUUID(),
    inputHash: commandInputHash('user'),
    responseKind: 'turn',
    createdAt: timestamp,
    expiresAt: '2026-11-20T12:00:00.000Z',
  };
}
