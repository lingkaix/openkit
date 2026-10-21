import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { Worker as NativeWorker } from 'node:worker_threads';
import { Worker } from 'node:worker_threads';
import { allocateEntityId } from '@openkit/protocol';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FsStore } from '../lib/store.js';
import { createDemoStore, DEMO_THREAD_ID, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import { FIXTURE_LOCAL_USER_ID } from '../test-support/local-user.js';
import { getControlStoreWorkerClient } from './control-store-worker-client.js';
import {
  CONTROL_WORKER_LIMITS,
  CONTROL_WORKER_VERSION,
  type ControlSqlStatement,
  isControlWorkerReply,
  isControlWorkerRequest,
} from './control-store-worker-protocol.js';
import { createDataRootAdminOperationImplementations } from './data-root-admin-operations.js';
import * as dataRootBackup from './data-root-backup.js';
import {
  coreDbPath,
  ensureLayout,
  ensureUserLayout,
  userDbPath,
  workspaceDbPath,
} from './fs-layout.js';
import { nativeProductScope } from './workspace-file-records.js';

const interception = vi.hoisted(() => ({
  workers: [] as NativeWorker[],
  gate: undefined as SharedArrayBuffer | undefined,
  point: 'before' as 'before' | 'after',
}));

// This fixture wraps the actual entry, not a fake SQL service or a production fault option.
vi.mock('node:worker_threads', async (load) => {
  const actual = await load<typeof import('node:worker_threads')>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(filename: string | URL, options?: import('node:worker_threads').WorkerOptions) {
        if (interception.gate !== undefined) {
          const prelude = `
            const {workerData} = require('node:worker_threads');
            const Database = require(workerData.databaseModule);
            const original = Database.prototype.exec;
            function hold() {
              if (Atomics.compareExchange(workerData.gate, 0, 0, 1) === 0) Atomics.wait(workerData.gate, 1, 0);
            }
            Database.prototype.exec = function(sql) {
              const commit = /^COMMIT$/i.test(sql);
              if (commit && workerData.point === 'before') hold();
              const result = original.call(this, sql);
              if (commit && workerData.point === 'after') hold();
              return result;
            };
          `;
          const entry = options?.eval
            ? String(filename)
            : `import(${JSON.stringify(String(filename))});`;
          const require = createRequire(import.meta.url);
          super(prelude + entry, {
            ...options,
            eval: true,
            workerData: {
              databaseModule: require.resolve('better-sqlite3'),
              gate: new Int32Array(interception.gate),
              point: interception.point,
            },
          });
        } else {
          super(filename, options);
        }
        interception.workers.push(this);
      }
    },
  };
});

const roots: string[] = [];
let client: ReturnType<typeof getControlStoreWorkerClient> | undefined;

/** Uses the real worker and current User journal in a private database, never a product fixture default. */
async function fixture(point?: 'before' | 'after', layout: 'private' | 'data-root' = 'private') {
  const root = mkdtempSync(join(tmpdir(), 'control-client-'));
  roots.push(root);
  if (layout === 'data-root') {
    ensureLayout(root);
    ensureUserLayout(root, FIXTURE_LOCAL_USER_ID);
  }
  const path =
    layout === 'data-root' ? userDbPath(root, FIXTURE_LOCAL_USER_ID) : join(root, 'user.sqlite');
  if (point !== undefined) {
    interception.gate = new SharedArrayBuffer(8);
    interception.point = point;
  }
  client = getControlStoreWorkerClient();
  await client.open({ database: 'user', path, create: true, initialize: 'user' });
  return {
    client,
    path,
    root,
    gate: interception.gate === undefined ? undefined : new Int32Array(interception.gate),
  };
}

/** A scalar metadata insert in an already owned native table, not a new product contract. */
function metadata(id: string): ControlSqlStatement[] {
  return [
    {
      mode: 'run',
      sql: "INSERT INTO thread_read_receipts (workspace_id, thread_id, item_ids_json) VALUES ('fixture', ?, '[]')",
      parameters: [id],
      expectChanges: 1,
    },
  ];
}

/** Waits without blocking the main thread or choosing a shorter product deadline. */
async function waitForHold(gate: Int32Array): Promise<void> {
  while (Atomics.load(gate, 0) === 0) await nextTurn();
}

/** Releases only this fixture's native COMMIT gate. */
function release(gate?: Int32Array): void {
  if (gate === undefined) return;
  Atomics.store(gate, 1, 1);
  Atomics.notify(gate, 1);
}

/** Inspects committed truth through an independent short read-only connection. */
function count(path: string): number {
  const reader = new Database(path, { readonly: true, fileMustExist: true });
  try {
    reader.pragma('query_only = ON');
    return reader.prepare('SELECT count(*) FROM thread_read_receipts').pluck().get() as number;
  } finally {
    reader.close();
  }
}

afterEach(async () => {
  if (interception.gate !== undefined) release(new Int32Array(interception.gate));
  await client?.shutdown();
  client = undefined;
  interception.gate = undefined;
  interception.workers.length = 0;
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('control writer parent admission', () => {
  it('distinguishes descriptive row extensions from unsupported native object values', () => {
    const header = { version: CONTROL_WORKER_VERSION, id: 0, status: 'ok', operation: 'write' };
    expect(isControlWorkerReply({ ...header, results: [{ mode: 'get', row: new Date() }] })).toBe(
      false
    );
    expect(
      isControlWorkerReply({ ...header, results: [{ mode: 'get', row: new Uint8Array() }] })
    ).toBe(false);
    expect(
      isControlWorkerReply({
        ...header,
        description: 'ignored descriptive extension',
        results: [
          { mode: 'get', row: { payload: new Uint8Array([1]), futureColumn: 'retained scalar' } },
        ],
      })
    ).toBe(true);
    expect(
      isControlWorkerRequest({
        version: 1,
        id: 0,
        database: 'user',
        operation: 'open',
        path: '/unused.sqlite',
        create: true,
        initialize: 'user',
      })
    ).toBe(false);
  });

  it('shares one host, applies the real native journal, and preserves read-after-ack', async () => {
    const f = await fixture();
    expect(getControlStoreWorkerClient()).toBe(f.client);
    expect(interception.workers).toHaveLength(1);
    const result = await f.client.write('user', metadata('acknowledged'));
    expect(result).toMatchObject([{ mode: 'run', changes: 1 }]);
    expect(count(f.path)).toBe(1);
    const reader = new Database(f.path, { readonly: true, fileMustExist: true });
    try {
      reader.pragma('query_only = ON');
      expect(reader.prepare('SELECT schema_version FROM thread_read_receipts').pluck().get()).toBe(
        1
      );
      expect(reader.pragma('auto_vacuum', { simple: true })).toBe(2);
      expect(() => reader.prepare('DELETE FROM thread_read_receipts').run()).toThrow();
    } finally {
      reader.close();
    }
    expect((await f.client.checkpoint('user')).walBytes).toBe(0);
    expect(await f.client.reclaim('user')).toBe(true);
    await f.client.close('user');
    await f.client.open({ database: 'user', path: f.path, create: false, initialize: 'user' });
    expect(count(f.path)).toBe(1);
  });

  it('refuses excess work before postMessage and keeps sibling admission separate', async () => {
    const f = await fixture();
    await f.client.open({
      database: 'sibling',
      path: join(f.root, 'sibling.sqlite'),
      create: true,
      initialize: 'user',
    });
    const posted = vi.spyOn(Worker.prototype, 'postMessage');
    const sql: ControlSqlStatement[] = [{ mode: 'get', sql: 'SELECT 1 AS value', parameters: [] }];
    const accepted = Array.from({ length: CONTROL_WORKER_LIMITS.pendingTransitions }, () =>
      f.client.write('user', sql)
    );
    const excess = f.client.write('user', sql);
    expect(posted.mock.calls.filter(([message]) => message.operation === 'write')).toHaveLength(
      CONTROL_WORKER_LIMITS.pendingTransitions
    );
    await expect(excess).rejects.toMatchObject({ code: 'busy', commit: 'not-committed' });
    const sibling = f.client.write('sibling', sql);
    await Promise.all(accepted);
    await expect(sibling).resolves.toMatchObject([{ mode: 'get', row: { value: 1n } }]);
    await expect(f.client.write('user', sql)).resolves.toHaveLength(1);
  });

  it('never acknowledges a write held before COMMIT', async () => {
    const f = await fixture('before');
    let acknowledged = false;
    const write = f.client.write('user', metadata('held')).then((result) => {
      acknowledged = true;
      return result;
    });
    try {
      await waitForHold(f.gate!);
      expect(acknowledged).toBe(false);
      expect(count(f.path)).toBe(0);
    } finally {
      release(f.gate);
    }
    await write;
    expect(count(f.path)).toBe(1);
  });

  it('refuses shared binary backing before posting while another COMMIT is blocked', async () => {
    const f = await fixture('before');
    const barrier = f.client.write('user', metadata('barrier'));
    await waitForHold(f.gate!);
    const posted = vi.spyOn(Worker.prototype, 'postMessage');
    const bytes = new Uint8Array(new SharedArrayBuffer(4));
    bytes.set([1, 2, 3, 4]);
    const submitted = f.client
      .write('user', [{ mode: 'get', sql: 'SELECT ? AS payload', parameters: [bytes] }])
      .catch((error: unknown) => error);
    bytes[0] = 9;
    release(f.gate);
    await barrier;
    expect(await submitted).toMatchObject({ code: 'invalid-request', commit: 'not-committed' });
    expect(posted).not.toHaveBeenCalled();
  });

  it('reports a lost reply as unknown even when the original receipt committed', async () => {
    const f = await fixture('after');
    const write = f.client
      .write('user', [
        {
          mode: 'run',
          sql: "INSERT INTO idempotency_requests (request_key, command_name, request_id, scope_json, input_hash, response_kind, response_id, created_at, expires_at) VALUES ('original-key', 'fixture', 'original-request', '{}', 'original-hash', 'thread', 'fixture', 'fixture', 'fixture')",
          parameters: [],
        },
      ])
      .catch((error: unknown) => error);
    await waitForHold(f.gate!);
    const reader = new Database(f.path, { readonly: true, fileMustExist: true });
    try {
      reader.pragma('query_only = ON');
      expect(
        reader
          .prepare('SELECT input_hash FROM idempotency_requests WHERE request_key = ?')
          .pluck()
          .get('original-key')
      ).toBe('original-hash');
    } finally {
      reader.close();
    }
    await interception.workers[0]!.terminate();
    expect(await write).toMatchObject({ code: 'unavailable', commit: 'unknown' });
    expect(getControlStoreWorkerClient()).toBe(f.client);
    await expect(f.client.write('user', metadata('not-replayed'))).rejects.toMatchObject({
      commit: 'not-committed',
    });
    expect(interception.workers).toHaveLength(1);
  });

  it('fails closed on an unsupported reply rather than satisfying a pending command', async () => {
    const f = await fixture('before');
    const write = f.client.write('user', metadata('unknown')).catch((error: unknown) => error);
    await waitForHold(f.gate!);
    interception.workers[0]!.emit('message', {
      version: 99,
      id: 1,
      status: 'ok',
      operation: 'write',
      results: [],
    });
    expect(await write).toMatchObject({ commit: 'unknown' });
    expect(getControlStoreWorkerClient()).toBe(f.client);
  });

  it('terminates a transport that cannot decode messages instead of retaining its writer', async () => {
    const f = await fixture('before');
    const write = f.client.write('user', metadata('unreadable')).catch((error: unknown) => error);
    await waitForHold(f.gate!);
    const terminate = vi.spyOn(interception.workers[0]!, 'terminate');
    interception.workers[0]!.emit('messageerror', new Error('fixture unreadable reply'));
    expect(await write).toMatchObject({ commit: 'unknown' });
    expect(terminate).toHaveBeenCalled();
  });

  it('drains accepted work on shutdown and rejects new unposted work', async () => {
    const f = await fixture();
    const accepted = ['one', 'two', 'three'].map((id) => f.client.write('user', metadata(id)));
    const shutdown = f.client.shutdown();
    await expect(f.client.write('user', metadata('late'))).rejects.toMatchObject({
      commit: 'not-committed',
    });
    await Promise.all(accepted);
    await shutdown;
    expect(f.client.isClosed).toBe(true);
    expect(count(f.path)).toBe(3);
  });

  it('holds backup copying until native acknowledgement and captures the complete Item closure', async () => {
    const root = mkdtempSync(join(tmpdir(), 'control-backup-'));
    roots.push(root, `${root}.backups`);
    interception.gate = new SharedArrayBuffer(8);
    interception.point = 'before';
    const gate = new Int32Array(interception.gate);
    Atomics.store(gate, 0, 1); // Setup commits are outside the controlled publication.
    client = getControlStoreWorkerClient();
    const store = await createDemoStore({ dataRoot: root });
    const turn = await store.createTurn(
      DEMO_WORKSPACE_ID,
      DEMO_THREAD_ID,
      'Capture the acknowledged result.',
      { kind: 'user', id: FIXTURE_LOCAL_USER_ID }
    );
    const capture = vi.spyOn(dataRootBackup, 'writeHotDataRootBackup');
    const posted = vi.spyOn(interception.workers[0]!, 'postMessage');
    Atomics.store(gate, 0, 0);
    let acknowledged = false;
    const publication = store
      .createItem({
        id: allocateEntityId('it'),
        owner: turn.owner,
        threadId: turn.threadId,
        turnId: turn.id,
        type: 'assistant-message',
        status: 'completed',
        text: 'Exact immutable backup bytes.\n',
        createdAt: turn.startedAt!,
        completedAt: turn.startedAt!,
      })
      .then((item) => {
        acknowledged = true;
        return item;
      });
    await waitForHold(gate);
    expect(posted).toHaveBeenCalled();
    expect(acknowledged).toBe(false);
    const operations = createDataRootAdminOperationImplementations(root);
    const backup = operations['backup.create']();
    let copiesWhileHeld = -1;
    let destinationWhileHeld = true;
    try {
      await nextTurn();
      copiesWhileHeld = capture.mock.calls.length;
      destinationWhileHeld = existsSync(`${root}.backups`);
    } finally {
      release(gate);
    }
    // Settle both real owners so a failed ordering check leaves no in-flight request.
    await Promise.allSettled([publication, backup]);
    expect(copiesWhileHeld).toBe(0);
    expect(destinationWhileHeld).toBe(false);
    const item = await publication;
    const result = await backup;
    expect(acknowledged).toBe(true);
    expect(capture).toHaveBeenCalledTimes(1);
    const backupRoot = join(`${root}.backups`, result.backupId);
    const verified = dataRootBackup.verifyDataRootBackupManifest({ backupRoot });
    expect(verified.manifest).toEqual(result.manifest);
    expect(operations['backup.verify']({ backupId: result.backupId }).manifest).toEqual(
      result.manifest
    );
    expect(
      new FsStore({ dataRoot: backupRoot }).listThreadItems(DEMO_WORKSPACE_ID, DEMO_THREAD_ID)
    ).toEqual([item]);
    for (const path of [coreDbPath(backupRoot), workspaceDbPath(backupRoot, DEMO_WORKSPACE_ID)]) {
      const reader = new Database(path, { readonly: true, fileMustExist: true });
      try {
        expect(reader.pragma('quick_check', { simple: true })).toBe('ok');
      } finally {
        reader.close();
      }
    }
    const reader = new Database(workspaceDbPath(backupRoot, DEMO_WORKSPACE_ID), {
      readonly: true,
      fileMustExist: true,
    });
    try {
      const entries = reader
        .prepare('SELECT content_json FROM control_product_entries ORDER BY sequence')
        .pluck()
        .all() as string[];
      expect(entries.length).toBeGreaterThan(0);
      const scope = nativeProductScope(backupRoot, turn.owner);
      for (const json of entries) {
        const content = JSON.parse(json);
        const bytes = readFileSync(join(scope.contentMount.root, content.reference.locator.path));
        expect(bytes.length).toBe(content.byteLength);
        expect(`sha256:${createHash('sha256').update(bytes).digest('hex')}`).toBe(
          content.reference.contentDigest
        );
      }
    } finally {
      reader.close();
    }
  });

  it('bounds capture waiters before posting and commits them only after backup resumes', async () => {
    const f = await fixture(undefined, 'data-root');
    roots.push(`${f.root}.backups`);
    const posted = vi.spyOn(interception.workers[0]!, 'postMessage');
    const capture = dataRootBackup.writeHotDataRootBackup;
    const operations = createDataRootAdminOperationImplementations(f.root);
    const accepted: Promise<unknown>[] = [];
    let excess: Promise<unknown> | undefined;
    let postedDuringCapture = -1;
    let rowsDuringCapture = -1;
    vi.spyOn(dataRootBackup, 'writeHotDataRootBackup').mockImplementationOnce((input) => {
      accepted.push(f.client.write('user', metadata('after-capture')));
      for (let index = 1; index < CONTROL_WORKER_LIMITS.pendingTransitions; index += 1) {
        accepted.push(
          f.client.write('user', [{ mode: 'get', sql: 'SELECT 1 AS value', parameters: [] }])
        );
      }
      excess = f.client.write('user', metadata('excess')).catch((error: unknown) => error);
      postedDuringCapture = posted.mock.calls.length;
      rowsDuringCapture = count(f.path);
      return capture(input);
    });
    const result = await operations['backup.create']();
    await Promise.all(accepted);
    expect(postedDuringCapture).toBe(0);
    expect(rowsDuringCapture).toBe(0);
    expect(await excess).toMatchObject({ code: 'busy', commit: 'not-committed' });
    expect(
      count(userDbPath(join(`${f.root}.backups`, result.backupId), FIXTURE_LOCAL_USER_ID))
    ).toBe(0);
    expect(count(f.path)).toBe(1);
    expect(posted.mock.calls.filter(([request]) => request.operation === 'write')).toHaveLength(
      CONTROL_WORKER_LIMITS.pendingTransitions
    );
    expect(interception.workers).toHaveLength(1);
  });

  it('resumes native commands after a real backup capture failure', async () => {
    const f = await fixture(undefined, 'data-root');
    roots.push(`${f.root}.backups`);
    writeFileSync(`${f.root}.backups`, 'The private backup destination is a file.');
    const posted = vi.spyOn(interception.workers[0]!, 'postMessage');
    const capture = dataRootBackup.writeHotDataRootBackup;
    let waiting: Promise<unknown> | undefined;
    let postedDuringCapture = -1;
    vi.spyOn(dataRootBackup, 'writeHotDataRootBackup').mockImplementationOnce((input) => {
      waiting = f.client.write('user', metadata('resumed'));
      postedDuringCapture = posted.mock.calls.length;
      return capture(input);
    });
    await expect(
      createDataRootAdminOperationImplementations(f.root)['backup.create']()
    ).rejects.toMatchObject({ code: 'data_root_backup_failed', status: 400 });
    expect(await waiting).toMatchObject([{ mode: 'run', changes: 1 }]);
    expect(postedDuringCapture).toBe(0);
    await expect(f.client.write('user', metadata('later'))).resolves.toMatchObject([
      { mode: 'run', changes: 1 },
    ]);
    expect(count(f.path)).toBe(2);
  });

  it('keeps posted loss unknown and unposted backup waiters not committed without replay', async () => {
    const f = await fixture('after', 'data-root');
    roots.push(`${f.root}.backups`);
    const posted = vi.spyOn(interception.workers[0]!, 'postMessage');
    const original = f.client
      .write('user', metadata('committed-before-lost-ack'))
      .catch((error: unknown) => error);
    await waitForHold(f.gate!);
    expect(count(f.path)).toBe(1);
    const capture = vi.spyOn(dataRootBackup, 'writeHotDataRootBackup');
    const backup = createDataRootAdminOperationImplementations(f.root)
      ['backup.create']()
      .catch((error: unknown) => error);
    const waiting = f.client
      .write('user', metadata('never-posted'))
      .catch((error: unknown) => error);
    await interception.workers[0]!.terminate();
    expect(await original).toMatchObject({ code: 'unavailable', commit: 'unknown' });
    expect(await waiting).toMatchObject({ code: 'unavailable', commit: 'not-committed' });
    expect(await backup).toMatchObject({ code: 'data_root_backup_failed', status: 400 });
    expect(capture).not.toHaveBeenCalled();
    expect(posted.mock.calls.filter(([request]) => request.operation === 'write')).toHaveLength(1);
    expect(count(f.path)).toBe(1);
    expect(getControlStoreWorkerClient()).toBe(f.client);
    await expect(f.client.write('user', metadata('no-retry'))).rejects.toMatchObject({
      code: 'unavailable',
      commit: 'not-committed',
    });
    expect(interception.workers).toHaveLength(1);
  });

  it('retains closed initialization errors without exposing native diagnostic data', async () => {
    const f = await fixture();
    const bad = join(f.root, 'bad.sqlite');
    writeFileSync(bad, 'private invalid database marker');
    await expect(
      f.client.open({ database: 'bad', path: bad, create: false, initialize: 'user' })
    ).rejects.toMatchObject({ code: 'integrity' });
    await expect(
      f.client.open({
        database: 'bad-scope',
        path: join(f.root, 'unopened.sqlite'),
        create: true,
        initialize: 'app' as never,
      })
    ).rejects.toMatchObject({ code: 'invalid-request', commit: 'not-committed' });
    await expect(f.client.write('user', metadata('healthy'))).resolves.toHaveLength(1);
  });
});
