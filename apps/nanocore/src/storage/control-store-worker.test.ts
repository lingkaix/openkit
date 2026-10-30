import { linkSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CONTROL_WORKER_VERSION,
  type ControlSqlStatement,
  type ControlWorkerReply,
  type ControlWorkerRequest,
  isControlWorkerRequest,
} from './control-store-worker-protocol.js';

const require = createRequire(import.meta.url);
const roots: string[] = [];
const workers: Worker[] = [];

/** Starts the actual source entrypoint; only this fixture installs native fault interception. */
function fixture(holdCommit = false) {
  const root = mkdtempSync(join(tmpdir(), 'control-worker-'));
  roots.push(root);
  const path = join(root, 'control.sqlite');
  const gate = new Int32Array(new SharedArrayBuffer(8));
  const worker = new Worker(
    `const {parentPort, workerData} = require('node:worker_threads');
     const Database = require(workerData.databaseModule);
     const original = Database.prototype.exec;
     Database.prototype.exec = function(sql) {
       if (/^COMMIT$/i.test(sql)) {
         parentPort.postMessage({checkpoint: 'commit'});
         if (workerData.holdCommit && Atomics.compareExchange(workerData.gate, 0, 0, 1) === 0) {
           parentPort.postMessage({checkpoint: 'held'});
           Atomics.wait(workerData.gate, 1, 0);
         }
       }
       return original.call(this, sql);
     };
     import(workerData.loader).then(({tsImport}) => tsImport(workerData.entry, workerData.parent));`,
    {
      eval: true,
      workerData: {
        databaseModule: require.resolve('better-sqlite3'),
        loader: pathToFileURL(require.resolve('tsx/esm/api')).href,
        entry: new URL('./control-store-worker.ts', import.meta.url).href,
        parent: import.meta.url,
        holdCommit,
        gate,
      },
    }
  );
  workers.push(worker);
  let nextId = 0;
  let commits = 0;
  const pending = new Map<
    number,
    { resolve: (value: ControlWorkerReply) => void; reject: (error: Error) => void }
  >();
  let heldResolve: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    heldResolve = resolve;
  });
  worker.on('message', (value) => {
    if (value.checkpoint === 'commit') {
      commits++;
      return;
    }
    if (value.checkpoint === 'held') {
      heldResolve?.();
      return;
    }
    pending.get(value.id)?.resolve(value);
    pending.delete(value.id);
  });
  worker.on('error', (error) => {
    for (const promise of pending.values()) promise.reject(error);
    pending.clear();
  });
  /** Correlates only transient RPC replies; this is not a command receipt. */
  function send(
    body: Omit<ControlWorkerRequest, 'version' | 'id' | 'database'> | Record<string, unknown>
  ) {
    return new Promise<ControlWorkerReply>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      worker.postMessage({ version: CONTROL_WORKER_VERSION, id, database: 'workspace', ...body });
    });
  }
  /** Posts a whole conditional transition without a callback or SQL handle on the caller. */
  const write = (statements: readonly ControlSqlStatement[]) =>
    send({ operation: 'write', statements });
  return { worker, path, root, send, write, held, gate, commits: () => commits };
}

/** Transport fixture reuses owned native setup SQL, not a new schema or completed product cohort. */
const setup: readonly ControlSqlStatement[] = ['0000_setup', '0001_thread_read_receipts'].map(
  (journal) => ({
    mode: 'run',
    sql: readFileSync(new URL(`../../drizzle/user/${journal}.sql`, import.meta.url), 'utf8'),
    parameters: [],
  })
);

/** One metadata/receipt pair for transport isolation; no product admission is claimed. */
function tuple(id: string): ControlSqlStatement[] {
  return [
    {
      mode: 'run',
      sql: "INSERT INTO thread_read_receipts (workspace_id, thread_id, item_ids_json) VALUES ('fixture', ?, '[]')",
      parameters: [id],
      expectChanges: 1,
    },
    {
      mode: 'run',
      sql: "INSERT INTO idempotency_requests (request_key, command_name, request_id, scope_json, input_hash, response_kind, response_id, created_at, expires_at) VALUES (?, 'fixture', ?, '{}', 'fixture', 'thread', ?, 'fixture', 'fixture')",
      parameters: [id, id, id],
      expectChanges: 1,
    },
  ];
}

afterEach(async () => {
  for (const worker of workers.splice(0)) await worker.terminate();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('native control database worker', () => {
  it('rejects a non-string recovery action without coercion', () => {
    // Contract Evolution's closed core refuses unsupported values at effect admission.
    expect(
      isControlWorkerRequest({
        version: CONTROL_WORKER_VERSION,
        id: 0,
        database: 'workspace',
        operation: 'recovery-cleanup',
        input: {
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          action: ['workspace.restore'],
          summary: '{}',
          preparation: {
            now: '2026-10-30T00:00:00.000Z',
            requiredFeatures: [],
            restricted: false,
            ownerId: 'usr_00000000-0000-7000-8000-000000000001',
            memberMappings: [],
          },
        },
      })
    ).toBe(false);
  });

  it('does not misreport a pending write when a malformed message reuses its identity', async () => {
    const f = fixture();
    expect(await f.send({ operation: 'open', path: f.path, create: true })).toMatchObject({
      status: 'ok',
    });
    const write = f.write(setup);
    f.worker.postMessage({ version: 99, id: 1, database: 'workspace', operation: 'write' });
    await expect(write).rejects.toThrow('Duplicate database writer message identity.');
  });

  it('isolates failed entries and rechecks a condition before dependent writes', async () => {
    const f = fixture();
    expect(await f.send({ operation: 'open', path: f.path, create: true })).toMatchObject({
      status: 'ok',
    });
    expect(await f.write(setup)).toMatchObject({ status: 'ok' });
    const before = f.commits();
    const results = await Promise.all([
      f.write(tuple('one')),
      f.write([
        ...tuple('failed'),
        {
          mode: 'get',
          sql: 'SELECT thread_id FROM thread_read_receipts WHERE thread_id = ?',
          parameters: ['missing'],
          expectRow: 'present',
        },
      ]),
      f.write(tuple('two')),
    ]);
    expect(results.map((r) => r.status)).toEqual(['ok', 'error', 'ok']);
    expect(results[1]).toMatchObject({ code: 'precondition', commit: 'not-committed' });
    expect(f.commits() - before).toBe(1);
    const reader = new Database(f.path, { readonly: true, fileMustExist: true });
    try {
      reader.pragma('query_only = ON');
      expect(
        reader
          .prepare('SELECT thread_id FROM thread_read_receipts ORDER BY thread_id')
          .pluck()
          .all()
      ).toEqual(['one', 'two']);
      expect(
        reader
          .prepare('SELECT request_key FROM idempotency_requests ORDER BY request_key')
          .pluck()
          .all()
      ).toEqual(['one', 'two']);
      expect(() => reader.prepare('DELETE FROM thread_read_receipts').run()).toThrow();
    } finally {
      reader.close();
    }
  });

  it.each([
    "INSERT OR ROLLBACK INTO thread_read_receipts VALUES ('fixture', 'failed', '[]')",
    "INSERT OR --\r'\nROLLBACK INTO thread_read_receipts VALUES ('fixture', 'failed', '[]'); --'",
  ])('rejects transaction-wide rollback before batching without failing successful siblings %#', async (sql) => {
    const f = fixture();
    expect(await f.send({ operation: 'open', path: f.path, create: true })).toMatchObject({
      status: 'ok',
    });
    expect(await f.write(setup)).toMatchObject({ status: 'ok' });
    const results = await Promise.all([
      f.write(tuple('one')),
      f.write([
        ...tuple('failed'),
        {
          mode: 'run',
          sql,
          parameters: [],
        },
      ]),
      f.write(tuple('two')),
    ]);
    expect(results.map((r) => r.status)).toEqual(['ok', 'error', 'ok']);
    expect(results[1]).toMatchObject({ code: 'invalid-request', commit: 'not-committed' });
    const reader = new Database(f.path, { readonly: true, fileMustExist: true });
    try {
      expect(
        reader
          .prepare('SELECT request_key FROM idempotency_requests ORDER BY request_key')
          .pluck()
          .all()
      ).toEqual(['one', 'two']);
    } finally {
      reader.close();
    }
  });

  it('refuses an already populated schema with transaction-wide rollback semantics', async () => {
    const f = fixture();
    const creator = new Database(f.path);
    creator.exec(setup[0]!.sql.replace('NOT NULL', 'NOT NULL ON CONFLICT ROLLBACK'));
    creator.close();
    expect(await f.send({ operation: 'open', path: f.path, create: false })).toMatchObject({
      status: 'error',
    });
  });

  it('refuses unknown effect fields and assertions belonging to another statement mode', async () => {
    const f = fixture();
    expect(
      await f.send({
        operation: 'open',
        path: f.path,
        create: true,
        expectedAuthority: 'unrecognized',
      })
    ).toMatchObject({ status: 'error', code: 'invalid-request' });
    expect(await f.send({ operation: 'open', path: f.path, create: true })).toMatchObject({
      status: 'ok',
    });
    expect(await f.write(setup)).toMatchObject({ status: 'ok' });
    expect(
      await f.send({
        operation: 'write',
        statements: [{ ...tuple('ignored')[0], expectRow: 'present' }],
      })
    ).toMatchObject({ status: 'error', code: 'invalid-request' });
    expect(
      await f.write([{ mode: 'get', sql: "SELECT 'ROLLBACK' AS word", parameters: [] }])
    ).toMatchObject({ status: 'ok' });
  });

  it('does not acknowledge before outer COMMIT and is visible to a read-only reader after ack', async () => {
    const f = fixture(true);
    expect(await f.send({ operation: 'open', path: f.path, create: true })).toMatchObject({
      status: 'ok',
    });
    let acknowledged = false;
    const result = f.write(setup).then((reply) => {
      acknowledged = true;
      return reply;
    });
    try {
      await f.held;
      expect(acknowledged).toBe(false);
      const reader = new Database(f.path, { readonly: true, fileMustExist: true });
      try {
        reader.pragma('query_only = ON');
        expect(
          reader.prepare("SELECT name FROM sqlite_schema WHERE name = 'thread_read_receipts'").get()
        ).toBeUndefined();
        Atomics.store(f.gate, 1, 1);
        Atomics.notify(f.gate, 1);
        expect(await result).toMatchObject({ status: 'ok' });
        expect(
          reader.prepare("SELECT name FROM sqlite_schema WHERE name = 'thread_read_receipts'").get()
        ).toEqual({ name: 'thread_read_receipts' });
      } finally {
        reader.close();
      }
    } finally {
      Atomics.store(f.gate, 1, 1);
      Atomics.notify(f.gate, 1);
    }
  });

  it('sets fresh durability policy and rejects aliases and transaction escape', async () => {
    const f = fixture();
    expect(await f.send({ operation: 'open', path: f.path, create: true })).toMatchObject({
      status: 'ok',
    });
    const policy = await f.write([
      {
        mode: 'get',
        sql: 'SELECT (SELECT auto_vacuum FROM pragma_auto_vacuum) AS vacuum, (SELECT secure_delete FROM pragma_secure_delete) AS deletion, (SELECT synchronous FROM pragma_synchronous) AS synchronization',
        parameters: [],
      },
    ]);
    expect(policy).toMatchObject({
      status: 'ok',
      results: [{ row: { vacuum: 2n, deletion: 1n, synchronization: 2n } }],
    });
    const alias = join(f.root, 'alias.sqlite');
    linkSync(f.path, alias);
    expect(
      await f.send({ operation: 'open', database: 'alias', path: alias, create: false })
    ).toMatchObject({ status: 'error', code: 'invalid-request' });
    expect(
      await f.write([{ mode: 'run', sql: '/* escape */ COMMIT', parameters: [] }])
    ).toMatchObject({ status: 'error', code: 'invalid-request' });
    expect(
      await f.send({
        operation: 'write',
        statements: [{ mode: 'unknown', sql: 'SELECT 1', parameters: [] }],
      })
    ).toMatchObject({ status: 'error', code: 'invalid-request' });
  });

  it('rolls back unsupported native results before COMMIT instead of losing acknowledgement afterward', async () => {
    const f = fixture();
    expect(await f.send({ operation: 'open', path: f.path, create: true })).toMatchObject({
      status: 'ok',
    });
    expect(await f.write(setup)).toMatchObject({ status: 'ok' });
    expect(
      await f.write([
        ...tuple('invalid-result'),
        { mode: 'get', sql: 'SELECT 1e999 AS value', parameters: [] },
      ])
    ).toMatchObject({ status: 'error', code: 'sql-failed', commit: 'not-committed' });
    const reader = new Database(f.path, { readonly: true, fileMustExist: true });
    try {
      reader.pragma('query_only = ON');
      expect(reader.prepare('SELECT request_key FROM idempotency_requests').all()).toEqual([]);
      expect(reader.prepare('SELECT thread_id FROM thread_read_receipts').all()).toEqual([]);
    } finally {
      reader.close();
    }
    expect(await f.write(tuple('valid-result'))).toMatchObject({ status: 'ok' });
  });

  it('preserves signed SQLite integer results without a lossy number conversion', async () => {
    const f = fixture();
    expect(await f.send({ operation: 'open', path: f.path, create: true })).toMatchObject({
      status: 'ok',
    });
    expect(await f.write(setup)).toMatchObject({ status: 'ok' });
    const id = 9223372036854775806n;
    expect(
      await f.write([
        {
          mode: 'run',
          sql: "INSERT INTO thread_read_receipts (rowid, workspace_id, thread_id, item_ids_json) VALUES (?, 'fixture', 'wide', '[]')",
          parameters: [id],
        },
        { mode: 'get', sql: 'SELECT rowid FROM thread_read_receipts', parameters: [] },
      ])
    ).toMatchObject({ status: 'ok', results: [{ lastInsertRowid: id }, { row: { rowid: id } }] });
  });

  it('does not create missing existing-only databases and supports ordered maintenance/close', async () => {
    const f = fixture();
    expect(await f.send({ operation: 'open', path: f.path, create: false })).toMatchObject({
      status: 'error',
    });
    expect(await f.send({ operation: 'open', path: f.path, create: true })).toMatchObject({
      status: 'ok',
    });
    const write = f.write(setup);
    expect(await f.send({ operation: 'checkpoint' })).toMatchObject({
      status: 'ok',
      operation: 'checkpoint',
    });
    expect(await write).toMatchObject({ status: 'ok' });
    expect(await f.send({ operation: 'reclaim' })).toMatchObject({ status: 'ok' });
    expect(await f.send({ operation: 'close' })).toMatchObject({ status: 'ok' });
    expect(await f.write(tuple('closed'))).toMatchObject({ status: 'error', code: 'not-open' });
  });
});
