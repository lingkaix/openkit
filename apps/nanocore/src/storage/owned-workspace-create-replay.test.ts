// openkit-test-platform: posix
/** Storage65 and command idempotency: cold public Workspace replay keeps its original User receipt and current authority. */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Worker as NativeWorker } from 'node:worker_threads';
import { WorkspaceRecordSchema } from '@openkit/protocol';
import Database from 'better-sqlite3';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { createApp } from '../test-support/app.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { operationRequest } from '../test-support/operation-request.js';
import { createTestStore, disposeTestStore } from '../test-support/store.js';
import * as workspaceMembership from '../workspace-membership.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './control-store-worker-client.js';
import { openCoreDb, openUserReadDb, openWorkspaceReadDb } from './db.js';
import { coreDbPath, userDbPath } from './fs-layout.js';
import { applyMigrations } from './migrate.js';

type Frame = { worker: NativeWorker; message: Record<string, unknown>; order: number };
type MainReader = {
  ref: WeakRef<Database.Database>;
  path: string;
  readonly: boolean;
  order: number;
};
type ClosedReader = {
  path: string;
  readonly: boolean;
  queryOnly: unknown;
  refusal: unknown;
  receipts: unknown[];
  probeError: string | null;
  physicallyClosed: boolean;
  order: number;
};
const observed = vi.hoisted(() => ({
  path: '',
  requestId: '',
  measuring: false,
  order: 0,
  readers: [] as MainReader[],
  closes: [] as ClosedReader[],
  posts: [] as Frame[],
  replies: [] as Frame[],
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
        if (observed.measuring && args[0] === observed.path) {
          const main = (
            sqlite.pragma('database_list') as Array<{ name: string; file: string }>
          ).find((row) => row.name === 'main');
          observed.readers.push({
            ref: new WeakRef(sqlite),
            path: main?.file ?? '',
            readonly: sqlite.readonly,
            order: ++observed.order,
          });
        }
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
        if (event === 'message' && typeof args[0] === 'object' && args[0] !== null) {
          const message = args[0] as Record<string, unknown>;
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
            if (observed.release) throw new Error('The original User OPEN acknowledged twice.');
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
afterEach(() => {
  observed.release?.();
  observed.measuring = false;
  vi.restoreAllMocks();
  observed.path = '';
  observed.requestId = '';
  observed.order = 0;
  observed.readers = [];
  observed.closes = [];
  observed.posts = [];
  observed.replies = [];
  observed.holdPath = '';
  observed.captured = undefined;
});
function posts(operation: string, database?: string) {
  return observed.posts.filter(
    (row) =>
      row.message.operation === operation &&
      (database === undefined || row.message.database === database)
  );
}
function acks(operation: string, database?: string) {
  return posts(operation, database).flatMap((request) =>
    observed.replies
      .filter(
        (reply) =>
          reply.worker === request.worker &&
          reply.message.id === request.message.id &&
          reply.message.status === 'ok' &&
          reply.message.operation === operation
      )
      .map((reply) => ({ request, reply }))
  );
}
function sidecars(path: string) {
  return Object.fromEntries(
    ['-wal', '-shm'].map((suffix) => [
      suffix,
      {
        exists: existsSync(path + suffix),
        bytes: statSync(path + suffix, { throwIfNoEntry: false })?.size ?? null,
      },
    ])
  );
}
function clean(path: string) {
  expect(existsSync(`${path}-wal`), JSON.stringify(sidecars(path))).toBe(false);
  expect(existsSync(`${path}-shm`), JSON.stringify(sidecars(path))).toBe(false);
}
function source(path: string) {
  const metadata = statSync(path);
  return {
    dev: metadata.dev,
    ino: metadata.ino,
    bytes: metadata.size,
    sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
  };
}
function measureUser(path: string, requestId: string) {
  observed.path = path;
  observed.requestId = requestId;
  observed.readers = [];
  observed.closes = [];
  const close = Database.prototype.close;
  vi.spyOn(Database.prototype, 'close').mockImplementation(function (this: Database.Database) {
    const selected =
      observed.measuring && this.open && observed.readers.some((row) => row.ref.deref() === this);
    let row: Omit<ClosedReader, 'physicallyClosed' | 'order'> | undefined;
    if (selected) {
      let refusal: unknown = null,
        receipts: unknown[] = [],
        probeError: string | null = null;
      const rollback = new Error('Test-owned protected receipt DML rollback.');
      try {
        receipts = this.prepare('SELECT * FROM idempotency_requests WHERE request_id=?').all(
          observed.requestId
        );
        try {
          this.transaction(() => {
            try {
              this.prepare(
                'UPDATE idempotency_requests SET input_hash=input_hash WHERE request_id=?'
              ).run(observed.requestId);
            } catch (error) {
              refusal = (error as { code?: unknown }).code ?? null;
            }
            throw rollback;
          })();
        } catch (error) {
          if (error !== rollback) throw error;
        }
      } catch (error) {
        probeError = String(error);
      }
      row = {
        path: observed.path,
        readonly: this.readonly,
        queryOnly: this.pragma('query_only', { simple: true }),
        refusal,
        receipts,
        probeError,
      };
    }
    const result = close.call(this);
    if (row)
      observed.closes.push({ ...row, physicallyClosed: !this.open, order: ++observed.order });
    return result;
  });
  observed.measuring = true;
}
function actualReaders(path: string, receipt: unknown[]) {
  expect(observed.readers.length).toBeGreaterThan(0);
  expect(observed.closes).toHaveLength(observed.readers.length);
  for (const row of observed.readers) {
    expect(row.path).toBe(path);
    expect(row.readonly).toBe(true);
    const actual = row.ref.deref();
    if (actual) expect(actual.open).toBe(false);
  }
  for (const row of observed.closes)
    expect(row).toMatchObject({
      path,
      readonly: true,
      queryOnly: 1,
      refusal: 'SQLITE_READONLY',
      receipts: receipt,
      probeError: null,
      physicallyClosed: true,
    });
}
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'openkit-workspace-cold-replay-')),
    core = openCoreDb(root);
  onTestFinished(() => disposeTestStore(root, core));
  applyMigrations(core);
  const userId = ensureLocalUser(core),
    store = createTestStore({ dataRoot: root }),
    path = userDbPath(root, userId),
    database = `user:${path}`,
    coreKey = `core:${coreDbPath(root)}`;
  const app = createApp({ coreDb: core, store, dataRoot: root }),
    requestId = randomUUID(),
    name = 'Exact original cold Workspace replay 🚀';
  const effects: Array<{
    kind: 'workspace' | 'membership';
    workspaceId: string;
    order: number;
    userFileExists: boolean;
    userOpenOffers: number;
    coreMembershipAcks: number;
    membershipAckOrder: number | null;
  }> = [];
  const create = store.createWorkspace.bind(store);
  const createSpy = vi.spyOn(store, 'createWorkspace').mockImplementation(async (...args) => {
    const value = await create(...args);
    effects.push({
      kind: 'workspace',
      workspaceId: value.id,
      order: ++observed.order,
      userFileExists: existsSync(path),
      userOpenOffers: posts('open', database).length,
      coreMembershipAcks: acks('private-workspace', coreKey).length,
      membershipAckOrder: null,
    });
    return value;
  });
  const publish = workspaceMembership.publishWorkspaceOwnerMembership;
  const membershipSpy = vi
    .spyOn(workspaceMembership, 'publishWorkspaceOwnerMembership')
    .mockImplementation(async (input) => {
      const priorMembershipAcks = acks('private-workspace', coreKey).length;
      await publish(input);
      if (input.ownerUserId === userId)
        effects.push({
          kind: 'membership',
          workspaceId: input.workspaceId,
          order: ++observed.order,
          userFileExists: existsSync(path),
          userOpenOffers: posts('open', database).length,
          coreMembershipAcks: acks('private-workspace', coreKey).length - priorMembershipAcks,
          membershipAckOrder: acks('private-workspace', coreKey).at(-1)?.reply.order ?? null,
        });
    });
  const lookup = store.getCommandRequest.bind(store),
    lookups: Array<{ command: string; requestId: string; order: number }> = [];
  vi.spyOn(store, 'getCommandRequest').mockImplementation((...args) => {
    lookups.push({ command: args[0], requestId: args[1], order: ++observed.order });
    return lookup(...args);
  });
  const call = () =>
    app.request(
      ...operationRequest('workspace.create', {}, { body: JSON.stringify({ requestId, name }) })
    );
  const client = getControlStoreWorkerClient();
  return {
    root,
    core,
    userId,
    store,
    path,
    database,
    coreKey,
    app,
    requestId,
    name,
    effects,
    createSpy,
    membershipSpy,
    lookups,
    call,
    client,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function readOriginalReceipt(f: Fixture) {
  const reader = openUserReadDb(f.root, f.userId);
  try {
    const rows = reader.sqlite
      .prepare('SELECT * FROM idempotency_requests WHERE request_id=?')
      .all(f.requestId) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      command_name: 'workspace.create',
      request_id: f.requestId,
      response_kind: 'workspace',
    });
    expect(JSON.parse(String(rows[0]!.scope_json))).toEqual({ userId: f.userId });
    const journal = JSON.parse(
      readFileSync(new URL('../../drizzle/user/meta/_journal.json', import.meta.url), 'utf8')
    ) as { entries: Array<{ when: number }> };
    expect(
      reader.sqlite
        .prepare('SELECT created_at FROM __drizzle_migrations ORDER BY created_at')
        .pluck()
        .all()
    ).toEqual(journal.entries.map((entry) => entry.when).sort((a, b) => a - b));
    return rows;
  } finally {
    reader.sqlite.close();
  }
}
function history(f: Fixture, workspaceId: string) {
  const reader = openWorkspaceReadDb(f.root, workspaceId);
  try {
    const rows: Record<string, unknown[]> = {};
    for (const table of [
      'control_workspaces',
      'control_threads',
      'control_turns',
      'control_product_entries',
      'idempotency_requests',
      'audit_events',
      'pending_requests',
    ])
      rows[table] = reader.sqlite
        .prepare(`SELECT * FROM "${table}"`)
        .all()
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    return {
      rows,
      configSha256: createHash('sha256')
        .update(readFileSync(join(f.root, 'workspaces', workspaceId, 'config', 'workspace.jsonc')))
        .digest('hex'),
      registry: f.core.sqlite
        .prepare('SELECT * FROM workspace_registry WHERE workspace_id=?')
        .all(workspaceId),
      members: f.core.sqlite
        .prepare('SELECT * FROM workspace_members WHERE workspace_id=?')
        .all(workspaceId),
      workspaceIds: f.store
        .listWorkspaces()
        .map((row) => row.id)
        .sort(),
    };
  } finally {
    reader.sqlite.close();
  }
}
async function first(f: Fixture) {
  expect(existsSync(f.path)).toBe(false);
  const response = await f.call();
  expect(response.status, await response.clone().text()).toBe(201);
  const body = WorkspaceRecordSchema.parse(await response.json());
  expect(body).toMatchObject({ name: f.name, status: 'active', kind: 'general' });
  expect(f.createSpy).toHaveBeenCalledTimes(1);
  expect(f.membershipSpy).toHaveBeenCalledTimes(1);
  expect(acks('open', f.database).length).toBeGreaterThan(0);
  expect(acks('workspace-command-receipt', f.database).length).toBeGreaterThan(0);
  const wasMeasuring = observed.measuring;
  observed.measuring = false;
  let receipt: ReturnType<typeof readOriginalReceipt>;
  try {
    receipt = readOriginalReceipt(f);
  } finally {
    observed.measuring = wasMeasuring;
  }
  expect(receipt[0]!.response_id).toBe(body.id);
  return { body, receipt };
}
async function cold(f: Fixture) {
  await f.client.close(f.database);
  expect(acks('close', f.database)).toHaveLength(1);
  clean(f.path);
  return source(f.path);
}
function report(f: Fixture, name: string, extra: Record<string, unknown>) {
  process.stderr.write(
    `${JSON.stringify({ workspaceCreateColdReplay: { name, database: f.database, effects: f.effects, userOpenOffers: posts('open', f.database).map(({ message, order }) => ({ message, order })), userOpenAcks: acks('open', f.database).map(({ request, reply }) => ({ request: request.message, ack: reply.message, order: reply.order })), userCloseAcks: acks('close', f.database).map(({ reply }) => ({ message: reply.message, order: reply.order })), shutdownAcks: acks('shutdown').map(({ reply }) => ({ message: reply.message, order: reply.order })), mainReaders: observed.readers.map(({ ref: _ref, ...row }) => row), mainCloses: observed.closes, sidecars: sidecars(f.path), ...extra } })}\n`
  );
}

it('replays the exact public Workspace command from its cold existing User receipt without another effect or final sidecars', async () => {
  const f = await fixture(),
    original = await first(f),
    beforeHistory = history(f, original.body.id),
    retained = await cold(f);
  const opensBefore = posts('open', f.database).length,
    receiptsBefore = posts('workspace-command-receipt', f.database).length;
  measureUser(f.path, f.requestId);
  const response = await f.call();
  expect(response.status, await response.clone().text()).toBe(201);
  const body = WorkspaceRecordSchema.parse(await response.json());
  observed.measuring = false;
  expect(body).toEqual(original.body);
  expect(f.createSpy).toHaveBeenCalledTimes(1);
  expect(f.membershipSpy).toHaveBeenCalledTimes(1);
  expect(history(f, original.body.id)).toEqual(beforeHistory);
  expect(posts('workspace-command-receipt', f.database)).toHaveLength(receiptsBefore);
  actualReaders(f.path, original.receipt);
  expect(source(f.path)).toEqual(retained);
  const later = posts('open', f.database).slice(opensBefore);
  if (
    later.length &&
    !acks('close', f.database).some((row) => row.reply.order > later.at(-1)!.order)
  )
    await f.client.close(f.database); // Close only an observed live lifetime; never create an owner to clean a failed observation.
  const shutdownBefore = acks('shutdown').length;
  await shutdownControlStoreWorkerClient();
  expect(acks('shutdown').length).toBeGreaterThan(shutdownBefore);
  expect(source(f.path)).toEqual(retained);
  report(f, 'cold-public-replay', {
    workspace: body,
    originalReceipt: original.receipt,
    retainedSourceUnchanged: true,
    coldNativeOpenOffers: later.length,
  });
  clean(f.path); // OLD must expose actual at-rest residue after all preceding public/data/physical/ACK prerequisites.
  expect(later.length).toBeGreaterThan(0);
  const lastReaderClose = Math.max(...observed.closes.map((row) => row.order));
  expect(
    acks('close', f.database).some(
      (row) => row.reply.order > lastReaderClose && row.reply.order > later.at(-1)!.order
    )
  ).toBe(true);
  const firstReader = Math.min(...observed.readers.map((row) => row.order));
  expect(
    acks('open', f.database).some(
      (row) => row.request.order >= later[0]!.order && row.reply.order < firstReader
    )
  ).toBe(true);
});

it('keeps the genuinely missing User database absent until original Workspace and membership effects acknowledge', async () => {
  const f = await fixture();
  expect(existsSync(f.path)).toBe(false);
  expect(posts('open', f.database)).toHaveLength(0);
  measureUser(f.path, f.requestId);
  const original = await first(f);
  observed.measuring = false;
  expect(f.effects).toHaveLength(2);
  const [workspace, membership] = f.effects;
  expect(workspace).toMatchObject({
    kind: 'workspace',
    workspaceId: original.body.id,
    userFileExists: false,
    userOpenOffers: 0,
  });
  expect(membership).toMatchObject({ kind: 'membership', workspaceId: original.body.id });
  expect(membership!.order).toBeGreaterThan(workspace!.order);
  expect(membership!.coreMembershipAcks).toBeGreaterThan(0);
  const firstOpen = posts('open', f.database)[0]!;
  expect(membership!.membershipAckOrder).not.toBeNull();
  expect(firstOpen.order).toBeGreaterThan(membership!.membershipAckOrder!);
  for (const actual of observed.readers)
    expect(actual.order).toBeGreaterThan(membership!.membershipAckOrder!);
  expect(firstOpen.message).toMatchObject({ path: f.path, create: true, initialize: 'user' });
  actualReaders(f.path, original.receipt);
  await f.client.close(f.database);
  expect(acks('close', f.database)).toHaveLength(1);
  const shutdownBefore = acks('shutdown').length;
  await shutdownControlStoreWorkerClient();
  expect(acks('shutdown').length).toBeGreaterThan(shutdownBefore);
  report(f, 'missing-first-create-order', {
    workspace: original.body,
    originalReceipt: original.receipt,
  });
  clean(f.path);
});

it('rechecks current admission after the real cold User OPEN wait before replaying a disabled canonical User receipt', async () => {
  const f = await fixture(),
    original = await first(f),
    beforeHistory = history(f, original.body.id),
    retained = await cold(f);
  const receiptsBefore = posts('workspace-command-receipt', f.database).length,
    lookupsBefore = f.lookups.filter(
      (row) => row.command === 'workspace.create' && row.requestId === f.requestId
    ).length;
  measureUser(f.path, f.requestId);
  observed.holdPath = f.path;
  const captured = new Promise<void>((resolve) => {
    observed.captured = resolve;
  });
  let replaySettled = false;
  const replay = Promise.resolve(f.call()).then((response) => {
    replaySettled = true;
    return response;
  });
  const boundary = await Promise.race([
    captured.then(() => ({ kind: 'held' as const })),
    replay.then(() => ({ kind: 'completed' as const })),
  ]);
  try {
    report(f, 'current-admission-wait-boundary', { boundary: boundary.kind });
    expect(
      boundary.kind,
      'The real cold User owner must cover this replay before receipt disclosure.'
    ).toBe('held');
    await f.client.checkpoint(f.coreKey);
    expect(replaySettled).toBe(false);
    expect(
      f.lookups.filter((row) => row.command === 'workspace.create' && row.requestId === f.requestId)
    ).toHaveLength(lookupsBefore);
    const disableBefore = acks('core-sharing', f.coreKey).length;
    const disabled = await f.app.request(
      ...operationRequest(
        'user.disable',
        { targetUserId: f.userId },
        { body: JSON.stringify({ requestId: randomUUID() }) }
      )
    );
    expect(disabled.status, await disabled.clone().text()).toBe(200);
    expect(await disabled.json()).toMatchObject({
      user: { userId: f.userId, status: 'disabled', disabledAt: expect.any(String) },
    });
    expect(acks('core-sharing', f.coreKey).length).toBeGreaterThan(disableBefore);
    expect(f.core.sqlite.prepare('SELECT status FROM users WHERE id=?').get(f.userId)).toEqual({
      status: 'disabled',
    });
  } finally {
    observed.release?.();
  }
  const response = await replay;
  observed.measuring = false;
  expect(response.status).toBe(403);
  const denied = await response.json();
  expect(denied).toMatchObject({
    code: 'workspace_access_denied',
    message: 'Workspace access denied.',
  });
  expect(denied).not.toHaveProperty('name');
  expect(denied).not.toHaveProperty('id');
  expect(
    f.lookups.filter((row) => row.command === 'workspace.create' && row.requestId === f.requestId)
  ).toHaveLength(lookupsBefore);
  expect(f.createSpy).toHaveBeenCalledTimes(1);
  expect(f.membershipSpy).toHaveBeenCalledTimes(1);
  expect(posts('workspace-command-receipt', f.database)).toHaveLength(receiptsBefore);
  expect(history(f, original.body.id)).toEqual(beforeHistory);
  if (observed.readers.length) actualReaders(f.path, original.receipt);
  else expect(observed.closes).toHaveLength(0); // Admission refusal may precede all Main User reads.
  const latestOpen = posts('open', f.database).at(-1)!;
  if (!acks('close', f.database).some((row) => row.reply.order > latestOpen.order))
    await f.client.close(f.database);
  expect(acks('close', f.database).some((row) => row.reply.order > latestOpen.order)).toBe(true);
  const shutdownBefore = acks('shutdown').length;
  await shutdownControlStoreWorkerClient();
  expect(acks('shutdown').length).toBeGreaterThan(shutdownBefore);
  expect(source(f.path)).toEqual(retained);
  report(f, 'current-admission-after-original-native-open', {
    denied,
    originalReceipt: original.receipt,
    retainedSourceUnchanged: true,
  });
  clean(f.path);
});
