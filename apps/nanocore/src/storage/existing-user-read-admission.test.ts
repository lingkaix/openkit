// openkit-test-platform: posix
/** Bootstrap Failure Scope and Storage65: existing-only reads retain quarantine and original native readiness. */
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import type { Worker as NativeWorker } from 'node:worker_threads';
import { allocateEntityId } from '@openkit/protocol';
import type Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { refuseScope } from '../bootstrap/readiness.js';
import { OperationError } from '../operation-error-core.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './control-store-worker-client.js';
import { openCoreDb } from './db.js';
import { coreDbPath, userDbPath } from './fs-layout.js';
import { applyMigrations } from './migrate.js';

const observed = vi.hoisted(() => ({
  order: 0,
  selected: new Set<string>(),
  main: [] as Array<{ sqlite: Database.Database; path: string; order: number }>,
  posts: [] as Array<{ worker: NativeWorker; message: Record<string, unknown>; order: number }>,
  replies: [] as Array<{ worker: NativeWorker; message: Record<string, unknown>; order: number }>,
  holdPath: '',
  captured: undefined as undefined | (() => void),
  release: undefined as undefined | (() => void),
}));
vi.mock('better-sqlite3', async (load) => {
  const actual = await load<{ default: typeof Database }>();
  return {
    ...actual,
    default: new Proxy(actual.default, {
      construct(target, args, newTarget) {
        const sqlite = Reflect.construct(target, args, newTarget) as Database.Database;
        if (observed.selected.has(String(args[0])))
          observed.main.push({ sqlite, path: String(args[0]), order: ++observed.order });
        return sqlite;
      },
    }),
  };
});
vi.mock('node:worker_threads', async (load) => {
  const actual = await load<typeof import('node:worker_threads')>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      override postMessage(...args: Parameters<NativeWorker['postMessage']>): void {
        observed.posts.push({
          worker: this,
          message: args[0] as Record<string, unknown>,
          order: ++observed.order,
        });
        super.postMessage(...args);
      }
      override emit(event: string | symbol, ...args: unknown[]): boolean {
        const value = args[0];
        if (event === 'message' && typeof value === 'object' && value !== null) {
          const message = value as Record<string, unknown>;
          const request = observed.posts.find(
            (row) => row.worker === this && row.message.id === message.id
          );
          const record = () =>
            observed.replies.push({ worker: this, message, order: ++observed.order });
          if (
            observed.holdPath &&
            request?.message.path === observed.holdPath &&
            message.operation === 'open' &&
            message.status === 'ok'
          ) {
            if (observed.release) throw new Error('Original native User OPEN acknowledged twice.');
            observed.release = () => {
              observed.release = undefined;
              observed.holdPath = '';
              record();
              super.emit(event, ...args);
            };
            observed.captured?.();
            return true;
          }
          record();
        }
        return super.emit(event, ...args);
      }
    },
  };
});
const cleanup: Array<() => void> = [];
const pendingReads: Array<Promise<{ sqlite: Database.Database }>> = [];
afterEach(async () => {
  observed.release?.();
  for (const result of await Promise.allSettled(pendingReads.splice(0))) {
    if (result.status === 'fulfilled' && result.value.sqlite.open) result.value.sqlite.close();
  }
  for (const { sqlite } of observed.main) if (sqlite.open) sqlite.close();
  try {
    await shutdownControlStoreWorkerClient();
  } finally {
    for (const finish of cleanup.splice(0).reverse()) finish();
  }
  observed.order = 0;
  observed.selected.clear();
  observed.main = [];
  observed.posts = [];
  observed.replies = [];
  observed.holdPath = '';
  observed.captured = undefined;
  observed.release = undefined;
});
function posts(operation: string, database: string) {
  return observed.posts.filter(
    (row) => row.message.operation === operation && row.message.database === database
  );
}
function acks(operation: string, database: string) {
  return posts(operation, database).flatMap((request) =>
    observed.replies.filter(
      (reply) =>
        reply.worker === request.worker &&
        reply.message.id === request.message.id &&
        reply.message.operation === operation &&
        reply.message.status === 'ok'
    )
  );
}
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'openkit-existing-user-read-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const core = openCoreDb(root);
  cleanup.push(() => {
    if (core.sqlite.open) core.sqlite.close();
  });
  applyMigrations(core);
  const userId = ensureLocalUser(core),
    client = getControlStoreWorkerClient(),
    corePath = coreDbPath(root),
    coreKey = `core:${corePath}`;
  await client.open({ database: coreKey, path: corePath, create: false, initialize: 'core' });
  expect(acks('open', coreKey)).toHaveLength(1);
  return { root, userId, client, coreKey, path: userDbPath(root, userId) };
}
function snapshot(root: string): unknown[] {
  if (!existsSync(root)) return [];
  const rows: unknown[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name)
  )) {
    const path = join(root, entry.name),
      metadata = statSync(path);
    if (entry.isDirectory()) {
      rows.push({ path: relative(root, path), directory: true });
      for (const row of snapshot(path)) rows.push({ parent: entry.name, row });
    } else
      rows.push({
        path: relative(root, path),
        dev: metadata.dev,
        ino: metadata.ino,
        bytes: metadata.size,
        sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
      });
  }
  return rows;
}
async function outcome<T>(value: Promise<T> | undefined) {
  if (value === undefined) return { status: 'absent' } as const;
  return value.then(
    (result) => ({ status: 'fulfilled', result }) as const,
    (error) => ({ status: 'rejected', error }) as const
  );
}
function refused(value: Awaited<ReturnType<typeof outcome>>) {
  expect(value.status).toBe('rejected');
  if (value.status !== 'rejected') throw new Error('A quarantined User was admitted.');
  expect(value.error).toBeInstanceOf(OperationError);
  expect(value.error).toMatchObject({ code: 'recovery_required', status: 409 });
}
function report(name: string, value: Record<string, unknown>) {
  process.stderr.write(`${JSON.stringify({ existingUserReadAdmission: { name, ...value } })}\n`);
}

it('refuses quarantined existing and missing Users before native admission, Main reading or layout changes', async () => {
  const f = await fixture(),
    key = `user:${f.path}`;
  const original = await f.client.openInitializedUserReadDb(f.root, f.userId);
  original.sqlite.close();
  await f.client.close(key);
  expect(acks('close', key)).toHaveLength(1);
  expect(existsSync(`${f.path}-wal`)).toBe(false);
  expect(existsSync(`${f.path}-shm`)).toBe(false);
  const missingId = allocateEntityId('usr'),
    missingPath = userDbPath(f.root, missingId),
    missingRoot = dirname(dirname(missingPath)),
    userRoot = dirname(dirname(f.path));
  expect(existsSync(missingRoot)).toBe(false);
  const retained = snapshot(userRoot),
    offerCount = posts('open', key).length;
  refuseScope(f.root, { scope: 'user', id: f.userId, check: 'records' });
  refuseScope(f.root, { scope: 'user', id: missingId, check: 'records' });
  observed.selected.add(f.path);
  observed.selected.add(missingPath);
  const existing = await outcome(
    f.client.openInitializedUserReadDb(f.root, f.userId, { existingOnly: true })
  );
  const missing = await outcome(
    f.client.openInitializedUserReadDb(f.root, missingId, { existingOnly: true })
  );
  report('quarantined', {
    existingStatus: existing.status,
    missingStatus: missing.status,
    selectedMainConstructors: observed.main.length,
    extraExistingNativeOpenOffers: posts('open', key).length - offerCount,
    missingNativeOpenOffers: posts('open', `user:${missingPath}`).length,
    retainedSourceUnchanged: JSON.stringify(snapshot(userRoot)) === JSON.stringify(retained),
    missingDirectoryCreated: existsSync(missingRoot),
  });
  refused(existing);
  refused(missing);
  expect(posts('open', key)).toHaveLength(offerCount);
  expect(posts('open', `user:${missingPath}`)).toHaveLength(0);
  expect(observed.main).toHaveLength(0);
  expect(snapshot(userRoot)).toEqual(retained);
  expect(existsSync(missingRoot)).toBe(false);
});

it('returns undefined synchronously for a genuinely absent admitted User without creating its directory or posting OPEN', async () => {
  const f = await fixture(),
    missingId = allocateEntityId('usr'),
    missingPath = userDbPath(f.root, missingId),
    scopeRoot = dirname(dirname(missingPath));
  observed.selected.add(missingPath);
  expect(existsSync(scopeRoot)).toBe(false);
  const selected = f.client.openInitializedUserReadDb(f.root, missingId, { existingOnly: true });
  expect(selected).toBeUndefined(); // A Promise resolving undefined still yields and must fail this contract.
  expect(existsSync(scopeRoot)).toBe(false);
  await f.client.checkpoint(f.coreKey);
  expect(acks('checkpoint', f.coreKey)).toHaveLength(1);
  expect(posts('open', `user:${missingPath}`)).toHaveLength(0);
  expect(observed.main).toHaveLength(0);
  expect(existsSync(scopeRoot)).toBe(false);
  report('missing-synchronous', {
    selectedWasUndefined: selected === undefined,
    mainConstructors: observed.main.length,
    nativeOpenOffers: 0,
    directoryCreated: existsSync(scopeRoot),
  });
});

it('joins the real pending original User OPEN acknowledgement before returning an existing-only readonly reader', async () => {
  const f = await fixture(),
    key = `user:${f.path}`;
  expect(existsSync(f.path)).toBe(false);
  observed.selected.add(f.path);
  observed.holdPath = f.path;
  const captured = new Promise<void>((resolve) => {
    observed.captured = resolve;
  });
  const original = f.client.openInitializedUserReadDb(f.root, f.userId);
  pendingReads.push(original);
  await captured; // Only the genuine successful native OPEN reply reaches this boundary; it is not fabricated.
  expect(existsSync(f.path)).toBe(true);
  let resolved = false;
  const selected = f.client.openInitializedUserReadDb(f.root, f.userId, { existingOnly: true });
  expect(selected).toBeDefined();
  const joined = selected!.then((reader) => {
    resolved = true;
    return reader;
  });
  pendingReads.push(joined);
  try {
    await f.client.checkpoint(f.coreKey); // A genuine sibling ACK proves event-loop progress while User readiness remains held.
    expect(resolved).toBe(false);
    expect(observed.main).toHaveLength(0);
    expect(posts('open', key)).toHaveLength(1);
    expect(acks('open', key)).toHaveLength(0);
  } finally {
    observed.release?.();
  }
  const [first, reader] = await Promise.all([original, joined]);
  try {
    expect(acks('open', key)).toHaveLength(1);
    const acknowledged = acks('open', key)[0]!.order;
    expect(observed.main.length).toBeGreaterThan(0);
    for (const actual of [first, reader])
      expect(observed.main.some((row) => row.sqlite === actual.sqlite)).toBe(true);
    for (const actual of observed.main) {
      expect(actual.order).toBeGreaterThan(acknowledged);
      expect(actual.sqlite.readonly).toBe(true);
      expect(actual.sqlite.pragma('query_only', { simple: true })).toBe(1);
    }
    const journal = JSON.parse(
      readFileSync(new URL('../../drizzle/user/meta/_journal.json', import.meta.url), 'utf8')
    ) as { entries: Array<{ when: number }> };
    const timestamps = journal.entries.map((entry) => entry.when).sort((a, b) => a - b);
    for (const actual of [first, reader])
      expect(
        actual.sqlite
          .prepare('SELECT created_at FROM __drizzle_migrations ORDER BY created_at')
          .pluck()
          .all()
      ).toEqual(timestamps);
    report('pending-original-open', {
      nativeOpenOffers: posts('open', key).length,
      originalAckCount: acks('open', key).length,
      acknowledged,
      mainReaderOrders: observed.main.map((row) => row.order),
      currentJournal: timestamps,
    });
  } finally {
    first.sqlite.close();
    reader.sqlite.close();
  }
  await f.client.close(key);
  expect(acks('close', key)).toHaveLength(1);
  for (const actual of observed.main) expect(actual.sqlite.open).toBe(false);
  expect(existsSync(`${f.path}-wal`)).toBe(false);
  expect(existsSync(`${f.path}-shm`)).toBe(false);
});
