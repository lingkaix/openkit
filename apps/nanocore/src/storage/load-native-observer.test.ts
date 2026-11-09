/** Observer qualification through real Store -> native Worker -> SQLite -> actual ACK. */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BroadcastChannel, type Worker as NativeWorker } from 'node:worker_threads';
import { allocateEntityId, ItemSchema } from '@openkit/protocol';
import { afterEach, expect, it, vi } from 'vitest';
import { DISPLAY_PROJECTION_REFRESH_ADMISSION, FsStore } from '../lib/store.js';
import { createTestStore } from '../test-support/store.js';
import { closeWorkspaceProductReadHandles } from './control-store-product-records.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';

const interception = vi.hoisted(() => ({
  config: undefined as
    | undefined
    | { channel: string; output: string; observer: string; gate: SharedArrayBuffer },
  workers: [] as NativeWorker[],
  workspaceHosts: new Map<string, NativeWorker>(),
  requests: [] as Array<{ id: number; operation: string }>,
  replies: [] as Array<{ id: number; operation: string; status: string }>,
  reached: undefined as undefined | (() => void),
  returned: undefined as undefined | (() => void),
}));
vi.mock('node:worker_threads', async (load) => {
  const actual = await load<typeof import('node:worker_threads')>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      private booted = false;
      private queued: Array<Parameters<NativeWorker['postMessage']>> = [];
      constructor(filename: string | URL, options?: import('node:worker_threads').WorkerOptions) {
        const config = interception.config;
        if (!config) throw new Error('Observer fixture configuration missing');
        const bootstrap = `
        (async () => {
          const { parentPort, workerData } = require('node:worker_threads');
          const { createRequire } = require('node:module');
          const { pathToFileURL } = require('node:url');
          const cfg = workerData.observerFixture;
          process.env.R2_CLOSE_CHANNEL = cfg.channel;
          process.env.OPENKIT_R2_ATTR_OUTPUT_DIR = cfg.output;
          process.env.R2_LOAD_PROFILE = 'rep2-one';
          const Database = createRequire(cfg.observer)('better-sqlite3');
          const exec = Database.prototype.exec;
          const gate = new Int32Array(cfg.gate);
          Database.prototype.exec = function(...args) {
            const held = Atomics.load(gate, 0) === 1 && /^COMMIT\\s*;?$/i.test(String(args[0]).trim()) && /[\\\\/]workspaces[\\\\/].+[\\\\/]workspace\\.sqlite$/.test(this.name);
            if (held) {
              Atomics.store(gate, 0, 2);
              parentPort.postMessage({ observerFixture: 'before-commit' });
              while (Atomics.load(gate, 1) === 0) Atomics.wait(gate, 1, 0);
            }
            const result = Reflect.apply(exec, this, args);
            if (held) parentPort.postMessage({ observerFixture: 'commit-returned' });
            return result;
          };
          require(cfg.observer);
          await import(workerData.entry);
          parentPort.postMessage({ observerFixture: 'booted' });
        })().catch(error => { setImmediate(() => { throw error; }); });`;
        super(bootstrap, {
          ...options,
          eval: true,
          workerData: {
            entry: filename instanceof URL ? filename.href : new URL(`file://${filename}`).href,
            observerFixture: config,
          },
        });
        interception.workers.push(this);
      }
      override postMessage(...args: Parameters<NativeWorker['postMessage']>): void {
        if (!this.booted) {
          this.queued.push(args);
          return;
        }
        const value = args[0] as {
          id: number;
          operation: string;
          productOwner?: { kind: string; workspaceId?: string };
          requests?: Array<{
            id: number;
            operation: string;
            productOwner?: { kind: string; workspaceId?: string };
          }>;
        };
        for (const request of value.requests ?? [value]) {
          interception.requests.push({ id: request.id, operation: request.operation });
          if (
            request.operation === 'open' &&
            request.productOwner?.kind === 'workspace' &&
            request.productOwner.workspaceId
          )
            interception.workspaceHosts.set(request.productOwner.workspaceId, this);
        }
        super.postMessage(...args);
      }
      override emit(event: string | symbol, ...args: unknown[]): boolean {
        const value = args[0] as
          | { observerFixture?: string; id: number; operation: string; status: string }
          | undefined;
        if (event === 'message' && value?.observerFixture) {
          if (value.observerFixture === 'booted') {
            this.booted = true;
            for (const args of this.queued.splice(0)) this.postMessage(...args);
          } else if (value.observerFixture === 'before-commit') interception.reached?.();
          else if (value.observerFixture === 'commit-returned') interception.returned?.();
          return true;
        }
        if (event === 'message' && value?.id !== undefined)
          interception.replies.push({
            id: value.id,
            operation: value.operation,
            status: value.status,
          });
        return super.emit(event, ...args);
      }
    },
  };
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
let root: string | undefined;
let channel: BroadcastChannel | undefined;
let gate: Int32Array | undefined;
let pending: Promise<unknown> | undefined;
afterEach(async () => {
  if (gate) {
    Atomics.store(gate, 1, 1);
    Atomics.notify(gate, 1);
  }
  await pending?.catch(() => {});
  await shutdownControlStoreWorkerClient();
  channel?.close();
  if (root) {
    closeWorkspaceProductReadHandles(root);
    rmSync(root, { recursive: true, force: true });
  }
  root = undefined;
  channel = undefined;
  gate = undefined;
  pending = undefined;
  interception.config = undefined;
  interception.requests.length = 0;
  interception.replies.length = 0;
  interception.workers.length = 0;
  interception.workspaceHosts.clear();
  interception.reached = undefined;
  interception.returned = undefined;
});
for (const operation of ['item', 'event', 'publication'] as const) {
  it(`binds one real native ${operation} request to COMMIT before its same-ID ACK`, async () => {
    root = mkdtempSync(join(tmpdir(), 'native-observer-real-'));
    const name = `native-observer-${randomUUID()}`;
    const shared = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
    gate = new Int32Array(shared);
    interception.config = {
      channel: name,
      output: root,
      observer: fileURLToPath(new URL('../test-support/load-native-observer.cjs', import.meta.url)),
      gate: shared,
    };
    channel = new BroadcastChannel(name);
    const ready = deferred(),
      finished = deferred();
    let reportThread: number | undefined;
    let workspaceThread: number | undefined;
    channel.onmessage = ({ data }) => {
      // Core and Workspace have separate real hosts. Only the exact Workspace opening owns this proof.
      if (data.threadId !== workspaceThread) return;
      if (data.kind === 'ready') ready.resolve();
      if (data.kind === 'finished') {
        reportThread = data.threadId;
        finished.resolve();
      }
    };
    const store = createTestStore({ dataRoot: root });
    const workspace = await store.createWorkspace('Observer qualification');
    const thread = await store.createThread(workspace.id, 'One genuine publication');
    const actor = { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' } as const;
    const turn = await store.createTurn(workspace.id, thread.id, 'Qualify observer', actor);
    const item = ItemSchema.parse({
      id: allocateEntityId('it'),
      owner: turn.owner,
      threadId: thread.id,
      turnId: turn.id,
      type: 'status',
      actor,
      level: 'info',
      title: 'Before observer window',
      summary: 'Exact retained progress',
      status: 'completed',
      createdAt: turn.startedAt!,
      completedAt: turn.startedAt!,
    });
    if (operation !== 'item') await store.createItem(item);
    if (operation === 'publication')
      await store.completeTurn(turn.id, { status: 'completed', completedAt: turn.startedAt! });
    const workspaceHost = interception.workspaceHosts.get(workspace.id);
    expect(workspaceHost).toBeDefined();
    workspaceThread = workspaceHost!.threadId;
    expect(workspaceThread).toBeGreaterThan(0);
    interception.requests.length = 0;
    interception.replies.length = 0;
    channel.postMessage({ kind: 'window', lower: 0, upper: Number.MAX_SAFE_INTEGER });
    await ready.promise;
    const reached = deferred(),
      returned = deferred();
    interception.reached = reached.resolve;
    interception.returned = returned.resolve;
    Atomics.store(gate, 0, 1);
    let settled = false;
    const producer =
      operation === 'item'
        ? store.createItem(item)
        : operation === 'event'
          ? store.persistTurnEvent(turn.id, {
              event: 'item.created',
              workspaceId: workspace.id,
              threadId: thread.id,
              turnId: turn.id,
              data: { type: 'item-created', item },
            })
          : store.updateItem(
              item.id,
              { title: 'After observer window' },
              DISPLAY_PROJECTION_REFRESH_ADMISSION
            );
    pending = producer.then(
      (value) => {
        settled = true;
        return value;
      },
      (error) => {
        settled = true;
        throw error;
      }
    );
    await Promise.race([
      reached.promise,
      pending.then(() => {
        throw new Error('Producer settled before genuine pre-COMMIT hold');
      }),
    ]);
    expect(Atomics.load(gate, 0)).toBe(2);
    expect(settled).toBe(false);
    expect(interception.replies.filter((reply) => reply.operation === operation)).toEqual([]);
    const posted = interception.requests.filter((request) => request.operation === operation);
    expect(posted).toHaveLength(1);
    Atomics.store(gate, 1, 1);
    Atomics.notify(gate, 1);
    await returned.promise;
    const acknowledged = await pending;
    expect(acknowledged).toBeDefined();
    expect(interception.replies.filter((reply) => reply.operation === operation)).toEqual([
      { id: posted[0]!.id, operation, status: 'ok' },
    ]);
    channel.postMessage({ kind: 'finish' });
    await finished.promise;
    expect(reportThread).toBe(workspaceThread);
    const report = JSON.parse(
      readFileSync(join(root, `native-observation-thread${reportThread}.json`), 'utf8')
    );
    expect(report).toMatchObject({
      observerErrors: 0,
      activeAtFinish: 0,
      successfulProductReplies: 1,
      earlyProductReplyInsideSql: 0,
      oneReplyWithoutPriorCommit: 0,
      oneUnclassifiedTransactions: 0,
      maxActiveWorkspaceSqlTransactions: 1,
    });
    expect(report.records).toHaveLength(1);
    expect(report.records[0]).toMatchObject({
      workspaceId: workspace.id,
      commit: true,
      ok: true,
      attempts: 1,
      released: 1,
      rolledBackMembers: 0,
      inWindow: true,
    });
    await shutdownControlStoreWorkerClient();
    closeWorkspaceProductReadHandles(root);
    const reopened = new FsStore({ dataRoot: root });
    if (operation === 'event')
      expect(reopened.getTurnEventsForExport(turn.id)).toEqual([acknowledged]);
    else
      expect(reopened.getTurnById(turn.id).items).toEqual([
        operation === 'item' ? item : { ...item, title: 'After observer window' },
      ]);
  });
}
