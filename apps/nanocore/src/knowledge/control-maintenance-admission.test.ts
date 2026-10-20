import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { allocateEntityId } from '@openkit/protocol';
import { describe, expect, it, onTestFinished } from 'vitest';
import { commandRequestKey, quickChatWorkspaceIdForUser } from '../lib/store.js';
import { commandInputHash } from '../runtime/idempotent-command.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import type { ControlMaintenanceAdmissionInput } from './knowledge-agent-maintenance.js';

const timestamp = '2026-10-20T12:00:00.000Z';
const userId = allocateEntityId('usr');

/** Runs the actual owner on a real worker connection; test setup finishes before native writing starts. */
function fixture(kind: 'server' | 'workspace' | 'user' = 'workspace') {
  const root = mkdtempSync(join(tmpdir(), 'maintenance-admission-'));
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
  onTestFinished(async () => {
    await worker.terminate();
    rmSync(root, { recursive: true, force: true });
  });
  const call = async (action: string, value: unknown) => {
    await ready;
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
    apply: (value: unknown) => call('apply', value),
    sql: (sql: string) => call('sql', sql),
    exec: (sql: string) => call('exec', sql),
  };
}

describe('native Knowledge maintenance admission', () => {
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

  it('creates fresh private query identities and deduplicates scheduled days inside SQL', async () => {
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
    await f.apply(daily);
    await expect(f.apply({ ...f.input(false), trigger: 'schedule' })).resolves.toMatchObject({
      threadId: daily.threadId,
      turnId: daily.turnId,
      replayed: true,
    });
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
