// openkit-test-platform: posix
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId, type Item } from '@openkit/protocol';
import { afterEach, expect, it, vi } from 'vitest';
import { FsStore } from '../lib/store.js';
import { createDemoStore, DEMO_THREAD_ID, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import { FIXTURE_LOCAL_USER_ID } from '../test-support/local-user.js';
import { FileStorageAdmission } from './artifacts/file-admission.js';
import { closeWorkspaceProductReadHandles } from './control-store-products.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './control-store-worker-client.js';
import { workspaceDbPath } from './fs-layout.js';

const fault = vi.hoisted(() => ({ gate: new SharedArrayBuffer(4) }));
// Fault the actual native COMMIT, without replacing SQL execution or fabricating a reply.
vi.mock('node:worker_threads', async (load) => {
  const actual = await load<typeof import('node:worker_threads')>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(filename: string | URL, options?: import('node:worker_threads').WorkerOptions) {
        const prelude = `
        const {workerData} = require('node:worker_threads');
        const Database = require(workerData.databaseModule);
        const original = Database.prototype.exec;
        Database.prototype.exec = function(sql) {
          if (/^COMMIT$/i.test(sql) && Atomics.compareExchange(workerData.full, 0, 1, 0) === 1) {
            const error = new Error('Injected full filesystem at native COMMIT.');
            error.code = 'SQLITE_FULL'; throw error;
          }
          return original.call(this, sql);
        };
      `;
        super(
          prelude +
            (options?.eval ? String(filename) : `import(${JSON.stringify(String(filename))});`),
          {
            ...options,
            eval: true,
            workerData: {
              databaseModule: createRequire(import.meta.url).resolve('better-sqlite3'),
              full: new Int32Array(fault.gate),
            },
          }
        );
      }
    },
  };
});
const roots: string[] = [];
afterEach(async () => {
  Atomics.store(new Int32Array(fault.gate), 0, 0);
  await shutdownControlStoreWorkerClient();
  for (const root of roots.splice(0)) {
    closeWorkspaceProductReadHandles(root);
    rmSync(root, { recursive: true, force: true });
  }
});
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'database-owner-capacity-'));
  roots.push(root);
  const store = await createDemoStore({ dataRoot: root });
  const turn = await store.createTurn(DEMO_WORKSPACE_ID, DEMO_THREAD_ID, 'Capacity.', {
    kind: 'user',
    id: FIXTURE_LOCAL_USER_ID,
  });
  const item: Item = {
    id: allocateEntityId('it'),
    owner: turn.owner,
    threadId: turn.threadId,
    turnId: turn.id,
    type: 'assistant-message',
    status: 'completed',
    text: 'Exact retained capacity result.',
    createdAt: turn.startedAt!,
    completedAt: turn.startedAt!,
  };
  return { root, store, turn, item };
}
const bytes = (publicationBytes: bigint) => ({
  stagingBytes: 0n,
  extractionBytes: 0n,
  derivativeBytes: 0n,
  publicationBytes,
});

it('shares physical forecasts and reserves the watermark for admitted Turn closeout', async () => {
  const f = await fixture();
  let margin = 100n;
  let available = 1_000n;
  const availableBytes = () => available;
  const first = new FileStorageAdmission(f.root, () => margin, availableBytes);
  const second = new FileStorageAdmission(f.root, () => margin, availableBytes);
  const pending = first.reserve(bytes(550n));
  try {
    expect(() => second.reserve(bytes(400n))).toThrow();
    const control = second.reserve(bytes(400n), 'control');
    control.release();
  } finally {
    pending.release();
  }
  await f.store.createItem(f.item);
  // Explicit fixture policy: free bytes are below the margin but sufficient for a small closeout.
  margin = 128n * 1_024n * 1_024n;
  available = margin / 2n;
  const admission = new FileStorageAdmission(f.root, () => margin, availableBytes);
  getControlStoreWorkerClient().setFileStorageAdmission(f.root, admission);
  const before = f.store.listThreadTurns(DEMO_WORKSPACE_ID, DEMO_THREAD_ID);
  await expect(
    f.store.createTurn(DEMO_WORKSPACE_ID, DEMO_THREAD_ID, 'Must yield.', {
      kind: 'user',
      id: FIXTURE_LOCAL_USER_ID,
    })
  ).rejects.toMatchObject({ code: 'no-space', commit: 'not-committed' });
  await expect(f.store.createItem({ ...f.item, id: allocateEntityId('it') })).rejects.toMatchObject(
    { code: 'no-space', commit: 'not-committed' }
  );
  expect(f.store.listThreadTurns(DEMO_WORKSPACE_ID, DEMO_THREAD_ID)).toEqual(before);
  expect(f.store.listWorkspaceItemRevisions(DEMO_WORKSPACE_ID)).toEqual([f.item]);
  // An admitted closeout must also open its existing cold database inside the protected margin.
  await getControlStoreWorkerClient().close(
    `workspace:${workspaceDbPath(f.root, DEMO_WORKSPACE_ID)}`
  );
  const terminal = await f.store.completeTurn(f.turn.id, {
    status: 'completed',
    completedAt: f.turn.startedAt!,
  });
  await shutdownControlStoreWorkerClient();
  closeWorkspaceProductReadHandles(f.root);
  expect(new FsStore({ dataRoot: f.root }).getTurnById(f.turn.id)).toEqual(terminal);
  expect(terminal).toMatchObject({ status: 'completed', items: [f.item] });
});

it('proves rollback and no retained Item after native COMMIT reports a full filesystem', async () => {
  const f = await fixture();
  Atomics.store(new Int32Array(fault.gate), 0, 1);
  await expect(f.store.createItem(f.item)).rejects.toMatchObject({
    code: 'no-space',
    commit: 'not-committed',
  });
  expect(Atomics.load(new Int32Array(fault.gate), 0)).toBe(0);
  await shutdownControlStoreWorkerClient();
  closeWorkspaceProductReadHandles(f.root);
  const reopened = new FsStore({ dataRoot: f.root });
  expect(reopened.listWorkspaceItemRevisions(DEMO_WORKSPACE_ID)).toEqual([]);
  expect(reopened.getTurnById(f.turn.id)).toMatchObject({ status: 'running', items: [] });
  expect(reopened.getTurnEventsForExport(f.turn.id)).toEqual([]);
  await expect(reopened.createItem(f.item)).resolves.toEqual(f.item);
});
