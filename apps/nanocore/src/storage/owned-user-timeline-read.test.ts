// openkit-test-platform: posix
/** Storage65 and Timeline: a public read preserves exact User membership and its physical lifecycle. */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Worker as NativeWorker } from 'node:worker_threads';
import type { ThreadTimelineResponse } from '@openkit/app-api-schemas';
import { allocateEntityId, type Item } from '@openkit/protocol';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest';
import { createApp } from '../test-support/app.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { operationRequest } from '../test-support/operation-request.js';
import { createTestStore, disposeTestStore } from '../test-support/store.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './control-store-worker-client.js';
import { openCoreDb, openUserReadDb } from './db.js';
import { userDbPath } from './fs-layout.js';
import { applyMigrations } from './migrate.js';
import { readThreadReadReceipt } from './thread-read-receipts.js';

type Frame = { worker: NativeWorker; message: Record<string, unknown>; order: number };
type Handle = { ref: WeakRef<Database.Database>; file: string; readonly: boolean; order: number };
type Closed = {
  file: string;
  readonly: boolean;
  queryOnly: unknown;
  refusal: unknown;
  rollbackError: string | null;
  physicallyClosed: boolean;
  order: number;
};
const observation = vi.hoisted(() => ({
  path: '',
  workspaceId: '',
  threadId: '',
  measuring: false,
  order: 0,
  handles: [] as Handle[],
  closes: [] as Closed[],
  requests: [] as Frame[],
  replies: [] as Frame[],
}));
vi.mock('better-sqlite3', async (load) => {
  const actual = await load<{ default: typeof Database }>();
  return {
    ...actual,
    default: new Proxy(actual.default, {
      construct(target, args, newTarget) {
        const sqlite = Reflect.construct(target, args, newTarget) as Database.Database;
        if (observation.measuring && args[0] === observation.path) {
          const main = (
            sqlite.pragma('database_list') as Array<{ name: string; file: string }>
          ).find((row) => row.name === 'main');
          observation.handles.push({
            ref: new WeakRef(sqlite),
            file: main?.file ?? '',
            readonly: sqlite.readonly,
            order: ++observation.order,
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
        observation.requests.push({
          worker: this,
          message: args[0] as Record<string, unknown>,
          order: ++observation.order,
        });
        super.postMessage(...args);
      }
      override emit(event: string | symbol, ...args: unknown[]): boolean {
        if (event === 'message' && typeof args[0] === 'object' && args[0] !== null)
          observation.replies.push({
            worker: this,
            message: args[0] as Record<string, unknown>,
            order: ++observation.order,
          });
        return super.emit(event, ...args);
      }
    },
  };
});
beforeEach(() => {
  observation.path = '';
  observation.workspaceId = '';
  observation.threadId = '';
  observation.measuring = false;
  observation.order = 0;
  observation.handles = [];
  observation.closes = [];
  observation.requests = [];
  observation.replies = [];
});
afterEach(() => {
  observation.measuring = false;
  vi.restoreAllMocks();
});
function posts(operation: string, database?: string) {
  return observation.requests.filter(
    (row) =>
      row.message.operation === operation &&
      (database === undefined || row.message.database === database)
  );
}
function acks(operation: string, database?: string) {
  return posts(operation, database).flatMap((request) =>
    observation.replies.filter(
      (reply) =>
        reply.worker === request.worker &&
        reply.message.id === request.message.id &&
        reply.message.operation === operation &&
        reply.message.status === 'ok'
    )
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
function observeUser(path: string, workspaceId: string, threadId: string) {
  observation.path = existsSync(path) ? realpathSync(path) : path;
  observation.workspaceId = workspaceId;
  observation.threadId = threadId;
  const close = Database.prototype.close;
  vi.spyOn(Database.prototype, 'close').mockImplementation(function (this: Database.Database) {
    const selected =
      observation.measuring && observation.handles.some((handle) => handle.ref.deref() === this);
    let policy: Omit<Closed, 'physicallyClosed' | 'order'> | undefined;
    if (selected) {
      const rollback = new Error('Test-owned protected User DML rollback.');
      let refusal: unknown = null,
        rollbackError: string | null = null;
      try {
        this.transaction(() => {
          try {
            this.prepare(
              'UPDATE thread_read_receipts SET schema_version = schema_version WHERE workspace_id = ? AND thread_id = ?'
            ).run(observation.workspaceId, observation.threadId);
          } catch (error) {
            refusal = (error as { code?: unknown }).code ?? null;
          }
          throw rollback;
        })();
      } catch (error) {
        if (error !== rollback) rollbackError = String(error);
      }
      policy = {
        file: observation.path,
        readonly: this.readonly,
        queryOnly: this.pragma('query_only', { simple: true }),
        refusal,
        rollbackError,
      };
    }
    const result = close.call(this);
    if (policy)
      observation.closes.push({
        ...policy,
        physicallyClosed: !this.open,
        order: ++observation.order,
      });
    return result;
  });
  observation.measuring = true;
}
function actualReaders(path: string) {
  expect(observation.handles.length).toBeGreaterThan(0);
  expect(observation.closes).toHaveLength(observation.handles.length);
  for (const handle of observation.handles) {
    expect(handle.file).toBe(path);
    expect(handle.readonly).toBe(true);
    const actual = handle.ref.deref();
    if (actual) expect(actual.open).toBe(false);
  }
  for (const row of observation.closes)
    expect(row).toMatchObject({
      file: path,
      readonly: true,
      queryOnly: 1,
      refusal: 'SQLITE_READONLY',
      rollbackError: null,
      physicallyClosed: true,
    });
}
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'openkit-owned-user-timeline-')),
    coreDb = openCoreDb(root);
  onTestFinished(async () => {
    observation.measuring = false;
    await disposeTestStore(root, coreDb);
  });
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb),
    store = createTestStore({ dataRoot: root });
  const workspace = await store.createWorkspace('Owned User Timeline');
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
  const thread = await store.createThread(
    workspace.id,
    'Exact retained Timeline',
    undefined,
    'conversation',
    { visibility: 'workspace' }
  );
  const turn = await store.createTurn(workspace.id, thread.id, 'Original public Timeline input', {
    kind: 'user',
    id: userId,
  });
  const app = createApp({ coreDb, dataRoot: root, store });
  const selectors = { workspaceId: workspace.id, threadId: thread.id };
  const operation = (
    name: Parameters<typeof operationRequest>[0],
    input: Record<string, unknown>
  ) =>
    app.request(
      ...operationRequest(name, input, { headers: { 'x-openkit-request-id': randomUUID() } })
    );
  const timeline = async (input: Record<string, unknown> = {}) => {
    const response = await operation('thread.timeline', { ...selectors, ...input });
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as ThreadTimelineResponse;
  };
  const message = (text: string) => {
    const at = new Date().toISOString();
    return store.createItem({
      id: allocateEntityId('it'),
      owner: turn.owner,
      threadId: thread.id,
      turnId: turn.id,
      type: 'assistant-message',
      status: 'completed',
      text,
      createdAt: at,
      completedAt: at,
    });
  };
  const path = userDbPath(root, userId),
    database = `user:${path}`,
    client = getControlStoreWorkerClient();
  return {
    root,
    coreDb,
    userId,
    store,
    workspace,
    thread,
    turn,
    selectors,
    operation,
    timeline,
    message,
    path,
    database,
    client,
  };
}
function exactTimeline(
  body: ThreadTimelineResponse,
  f: Awaited<ReturnType<typeof fixture>>,
  items: Item[],
  boundary?: Item
) {
  expect(body).toMatchObject({
    workspaceId: f.workspace.id,
    threadId: f.thread.id,
    view: 'runs',
    restrictedReferences: false,
    beforeCursor: null,
    afterCursor: null,
  });
  expect(body.runs).toHaveLength(1);
  const run = body.runs[0]!;
  expect(run).toMatchObject({
    id: f.turn.id,
    status: f.turn.status,
    triggerActor: f.turn.triggerActor,
    agentId: f.turn.agentId ?? null,
    restrictedReferences: false,
    statistics: { messages: items.length, coverage: 'complete' },
  });
  expect(run.narrative.map((item) => item.id)).toEqual(items.map((item) => item.id));
  expect(run.narrative.map((item) => item.detail)).toEqual(
    items.map((value) => ({ kind: 'complete', value }))
  );
  if (boundary) {
    expect(body.catchUpAnchor).toEqual({ turnId: f.turn.id, itemId: boundary.id });
    expect(body.anchor).toEqual(body.catchUpAnchor);
    expect(body.itemWindow?.items.map((item) => item.detail)).toEqual(
      items.map((value) => ({ kind: 'complete', value }))
    );
  } else expect(body.catchUpAnchor).toBeNull();
}
function report(
  f: Awaited<ReturnType<typeof fixture>>,
  name: string,
  extra: Record<string, unknown>
) {
  process.stderr.write(
    `${JSON.stringify({ userTimelineEvidence: { name, database: f.database, nativeUserOpenOffers: posts('open', f.database).map(({ message, order }) => ({ message, order })), nativeUserOpenAcks: acks('open', f.database).map(({ message, order }) => ({ message, order })), nativeUserCloseAcks: acks('close', f.database).map(({ message, order }) => ({ message, order })), nativeShutdownAcks: acks('shutdown').map(({ message, order }) => ({ message, order })), selectedMainReaders: observation.handles.map(({ ref: _ref, ...row }) => row), selectedMainCloses: observation.closes, sidecars: sidecars(f.path), ...extra } })}\n`
  );
}

it('keeps exact public Timeline membership, run and message projections through a current cold User read and genuine final native shutdown', async () => {
  const f = await fixture(),
    earlier = await f.message('An earlier unread message.'),
    boundary = await f.message('Actually displayed boundary.\r\n🚀');
  const marked = await f.operation('thread.mark-read', { ...f.selectors, itemIds: [boundary.id] });
  expect(marked.status, await marked.clone().text()).toBe(200);
  expect(await marked.json()).toEqual({ scope: 'window', acknowledgedItemIds: [boundary.id] });
  expect(acks('open', f.database).length).toBeGreaterThan(0);
  const membershipAck = acks('thread-read-membership', f.database);
  expect(membershipAck).toHaveLength(1);
  expect(membershipAck[0]!.message.itemIds).toEqual([boundary.id]);
  const incoming = await f.message('One actual message after the displayed boundary.'),
    items = [earlier, boundary, incoming];
  const warm = await f.timeline({ anchor: { kind: 'catch-up' } });
  exactTimeline(warm, f, items, boundary);
  expect(warm.digest).toEqual({
    coverage: 'complete',
    lines: [{ kind: 'new-messages', count: 1, anchor: { kind: 'item', itemId: incoming.id } }],
  });
  const warmReader = openUserReadDb(f.root, f.userId);
  let membership: string[], ledger: number[];
  try {
    membership = readThreadReadReceipt(warmReader, f.workspace.id, f.thread.id);
    expect(membership).toEqual([boundary.id]);
    ledger = warmReader.sqlite
      .prepare('SELECT created_at FROM __drizzle_migrations ORDER BY created_at')
      .pluck()
      .all() as number[];
    const journal = JSON.parse(
      readFileSync(new URL('../../drizzle/user/meta/_journal.json', import.meta.url), 'utf8')
    ) as { entries: Array<{ when: number }> };
    expect(ledger).toEqual(journal.entries.map((entry) => entry.when).sort((a, b) => a - b));
  } finally {
    warmReader.sqlite.close();
  }
  await f.client.close(f.database);
  expect(acks('close', f.database)).toHaveLength(1);
  clean(f.path);
  const original = source(f.path),
    openBefore = posts('open', f.database).length;
  observeUser(f.path, f.workspace.id, f.thread.id);
  const body = await f.timeline({ anchor: { kind: 'catch-up' } });
  exactTimeline(body, f, items, boundary);
  expect(body).toEqual(warm);
  actualReaders(f.path);
  expect(source(f.path)).toEqual(original);
  const laterOpens = posts('open', f.database).slice(openBefore);
  if (laterOpens.length) {
    const firstReader = observation.handles[0]!.order;
    expect(
      acks('open', f.database).some(
        (reply) => reply.order > acks('close', f.database)[0]!.order && reply.order < firstReader
      )
    ).toBe(true);
  }
  const shutdownBefore = acks('shutdown').length;
  await shutdownControlStoreWorkerClient();
  expect(acks('shutdown').length).toBeGreaterThan(shutdownBefore);
  expect(source(f.path)).toEqual(original);
  report(f, 'current-cold-public-timeline', {
    original,
    sourceAfter: source(f.path),
    exactMembership: membership!,
    appliedJournal: ledger!,
    response: body,
    coldNativeUserOpenOffers: laterOpens.length,
  });
  clean(f.path);
});

it('preserves a genuinely absent User file while the admitted public Timeline still returns its original run and message', async () => {
  const f = await fixture(),
    message = await f.message('Unread without any User receipt.');
  expect(existsSync(f.path)).toBe(false);
  const openBefore = posts('open', f.database).length;
  observeUser(f.path, f.workspace.id, f.thread.id);
  const body = await f.timeline();
  exactTimeline(body, f, [message]);
  expect(existsSync(f.path)).toBe(false);
  expect(posts('open', f.database)).toHaveLength(openBefore);
  expect(observation.handles).toHaveLength(0);
  expect(observation.closes).toHaveLength(0);
  const shutdownBefore = acks('shutdown').length;
  await shutdownControlStoreWorkerClient();
  expect(acks('shutdown').length).toBeGreaterThan(shutdownBefore);
  report(f, 'missing-user-no-initialization-control', {
    userFileStillAbsent: !existsSync(f.path),
    response: body,
  });
  expect(existsSync(f.path)).toBe(false);
  clean(f.path);
});
