// openkit-test-platform: posix
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { createRequire, isBuiltin } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  CONTROL_WORKER_VERSION,
  type ControlSqlStatement,
  type ControlWorkerReply,
} from './control-store-worker-protocol.js';
import { openCoreDb } from './db.js';
import { nativeProductScope } from './workspace-file-records.js';

const require = createRequire(import.meta.url);
const roots: string[] = [];
const fixtures: ReturnType<typeof fixture>[] = [];
let artifactRoot: string;
let bundle: string;
let metadata: {
  inputs: Record<string, unknown>;
  outputs: Record<string, { imports: { path: string; kind: string; external?: boolean }[] }>;
};

beforeAll(async () => {
  const original = mkdtempSync(join(tmpdir(), 'native-bundle-build-'));
  roots.push(original);
  const output = join(original, 'dist', 'storage', 'control-store-worker.bundle.mjs');
  const { buildControlStoreWorker } = await import(
    new URL('../../scripts/build-control-store-worker.mjs', import.meta.url).href
  );
  metadata = (await buildControlStoreWorker(output)).metafile;
  // Move the artifact before execution. No absolute build-checkout URL may locate its resources.
  artifactRoot = `${original}-relocated`;
  renameSync(original, artifactRoot);
  roots.push(artifactRoot);
  const appRoot = fileURLToPath(new URL('../..', import.meta.url));
  for (const resource of ['node_modules', 'drizzle', 'data-templates']) {
    symlinkSync(join(appRoot, resource), join(artifactRoot, resource), 'dir');
  }
  bundle = join(artifactRoot, 'dist', 'storage', 'control-store-worker.bundle.mjs');
}, 30_000);

/** Starts the production artifact, not the ordinary Vitest/source worker. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'native-bundle-data-'));
  roots.push(root);
  const path = join(root, 'control.sqlite');
  const gate = new Int32Array(new SharedArrayBuffer(8));
  const worker = new Worker(
    `const { parentPort, workerData } = require('node:worker_threads');
     const Database = require(workerData.databaseModule);
     const pragma = Database.prototype.pragma;
     Database.prototype.pragma = function(source, ...rest) {
       const result = Reflect.apply(pragma, this, [source, ...rest]);
       if (/^synchronous\\s*=\\s*FULL$/i.test(String(source).trim())) {
         parentPort.postMessage({ fixture: 'full', value: pragma.call(this, 'synchronous', { simple: true }) });
       }
       return result;
     };
     const exec = Database.prototype.exec;
     Database.prototype.exec = function(sql) {
       if (/^COMMIT$/i.test(sql) && Atomics.compareExchange(workerData.gate, 0, 1, 2) === 1) {
         parentPort.postMessage({ fixture: 'held' });
         Atomics.wait(workerData.gate, 1, 0);
       }
       return exec.call(this, sql);
     };
     import(workerData.entry);`,
    {
      eval: true,
      workerData: {
        databaseModule: require.resolve('better-sqlite3'),
        entry: pathToFileURL(bundle).href,
        gate,
      },
    }
  );
  let nextId = 0;
  const full: number[] = [];
  const pending = new Map<
    number,
    { resolve: (reply: ControlWorkerReply) => void; reject: (error: Error) => void }
  >();
  let markHeld: () => void;
  const held = new Promise<void>((resolve) => {
    markHeld = resolve;
  });
  worker.on('message', (reply) => {
    if (reply.fixture === 'full') {
      full.push(reply.value);
      return;
    }
    if (reply.fixture === 'held') {
      markHeld();
      return;
    }
    pending.get(reply.id)?.resolve(reply);
    pending.delete(reply.id);
  });
  worker.on('error', (error) => {
    for (const operation of pending.values()) operation.reject(error);
    pending.clear();
  });
  /** Posts the real bounded native protocol and correlates the actual worker reply. */
  function send(body: Record<string, unknown>) {
    return new Promise<ControlWorkerReply>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      worker.postMessage({ version: CONTROL_WORKER_VERSION, database: 'workspace', id, ...body });
    });
  }
  const result = { worker, root, path, gate, held, full, send };
  fixtures.push(result);
  return result;
}

afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    Atomics.store(f.gate, 1, 1);
    Atomics.notify(f.gate, 1);
    await f.worker.terminate();
  }
});
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Actual owned User schema for a transport tuple; not a substitute product owner. */
const setup: readonly ControlSqlStatement[] = ['0000_setup', '0001_thread_read_receipts'].map(
  (journal) => ({
    mode: 'run',
    sql: readFileSync(new URL(`../../drizzle/user/${journal}.sql`, import.meta.url), 'utf8'),
    parameters: [],
  })
);

describe('shipped native worker bundle', () => {
  it('keeps internal lazy modules and JSONC in one graph, and only the PDF engine dynamic', () => {
    expect(existsSync(`${bundle}.map`)).toBe(true);
    expect(Object.keys(metadata.outputs)).toHaveLength(2);
    expect(
      Object.keys(metadata.inputs).some((path) => path.includes('jsonc-parser/lib/esm/'))
    ).toBe(true);
    const imports = Object.values(metadata.outputs).flatMap((output) => output.imports);
    expect(
      imports.some(
        (item) => item.kind === 'dynamic-import' && item.path === 'pdfjs-dist/legacy/build/pdf.mjs'
      )
    ).toBe(true);
    for (const item of imports.filter((item) => item.external)) {
      expect(
        isBuiltin(item.path) ||
          ['better-sqlite3', '@napi-rs/canvas'].includes(item.path) ||
          (item.kind === 'dynamic-import' && item.path === 'pdfjs-dist/legacy/build/pdf.mjs')
      ).toBe(true);
    }
    expect(readFileSync(bundle, 'utf8')).not.toContain(
      fileURLToPath(new URL('../..', import.meta.url))
    );
  });

  it('opens a real Core through the relocated bundled entry and its shipped migration resources', async () => {
    const f = fixture();
    const scope = nativeProductScope(f.root, { kind: 'server' });
    // Main owns the safe Core path; migrations still run in the relocated native artifact.
    const setup = openCoreDb(f.root);
    setup.sqlite.close();
    expect(
      await f.send({
        operation: 'open',
        database: `core:${scope.path}`,
        path: scope.path,
        dataRoot: f.root,
        create: false,
        initialize: 'core',
        productOwner: scope.owner,
        contentMount: scope.contentMount,
      })
    ).toMatchObject({ status: 'ok', operation: 'open' });
    expect(f.full).toContain(2);
    expect(await f.send({ operation: 'close', database: `core:${scope.path}` })).toMatchObject({
      status: 'ok',
    });
    const reader = new Database(scope.path, { readonly: true, fileMustExist: true });
    try {
      const migration = reader
        .prepare('SELECT count(*) AS count FROM __drizzle_migrations')
        .get() as { count: number };
      expect(migration.count).toBeGreaterThan(0);
    } finally {
      reader.close();
    }
  }, 30_000);

  it('withholds the real write ACK and ordered close fence until the covering FULL commit', async () => {
    const f = fixture();
    expect(await f.send({ operation: 'open', path: f.path, create: true })).toMatchObject({
      status: 'ok',
    });
    expect(f.full).toContain(2);
    expect(await f.send({ operation: 'write', statements: setup })).toMatchObject({ status: 'ok' });
    Atomics.store(f.gate, 0, 1);
    const statements: readonly ControlSqlStatement[] = [
      {
        mode: 'run',
        sql: "INSERT INTO thread_read_receipts VALUES ('fixture', 'bundled', '[]')",
        parameters: [],
        expectChanges: 1,
      },
      {
        mode: 'run',
        sql: "INSERT INTO idempotency_requests (request_key, command_name, request_id, scope_json, input_hash, response_kind, response_id, created_at, expires_at) VALUES ('bundled', 'fixture', 'bundled', '{}', 'fixture', 'thread', 'bundled', 'fixture', 'fixture')",
        parameters: [],
        expectChanges: 1,
      },
    ];
    let writeAcknowledged = false;
    const write = f.send({ operation: 'write', statements }).then((reply) => {
      writeAcknowledged = true;
      return reply;
    });
    await f.held;
    let closeAcknowledged = false;
    const close = f.send({ operation: 'close' }).then((reply) => {
      closeAcknowledged = true;
      return reply;
    });
    await nextTurn();
    expect(writeAcknowledged).toBe(false);
    expect(closeAcknowledged).toBe(false);
    const before = new Database(f.path, { readonly: true, fileMustExist: true });
    try {
      expect(before.prepare('SELECT thread_id FROM thread_read_receipts').all()).toEqual([]);
      expect(before.prepare('SELECT request_key FROM idempotency_requests').all()).toEqual([]);
    } finally {
      before.close();
    }
    Atomics.store(f.gate, 1, 1);
    Atomics.notify(f.gate, 1);
    expect(await write).toMatchObject({ status: 'ok', operation: 'write' });
    expect(await close).toMatchObject({ status: 'ok', operation: 'close' });
    const after = new Database(f.path, { readonly: true, fileMustExist: true });
    try {
      expect(after.prepare('SELECT thread_id FROM thread_read_receipts').all()).toEqual([
        { thread_id: 'bundled' },
      ]);
      expect(after.prepare('SELECT request_key FROM idempotency_requests').all()).toEqual([
        { request_key: 'bundled' },
      ]);
    } finally {
      after.close();
    }
    expect(await f.send({ operation: 'write', statements })).toMatchObject({
      status: 'error',
      code: 'not-open',
    });
  }, 30_000);
});
