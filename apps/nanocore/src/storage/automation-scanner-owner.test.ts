import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { Worker } from 'node:worker_threads';
import { afterEach, expect, it, vi } from 'vitest';
import { AutomationStore } from '../lib/automation-store.js';
import { armCommit, releaseCommit } from '../test-support/control-native-transport.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './control-store-worker-client.js';
import { type CoreDb, openCoreDb } from './db.js';
import { applyMigrations } from './migrate.js';

// L2 composition uses the actual scanner client, native SQLite owner and Main mutation gate.
vi.mock('node:worker_threads', async (load) => {
  const actual = await load<typeof import('node:worker_threads')>();
  const { nativeCommitWorker } = await import('../test-support/control-native-transport.js');
  return { ...actual, Worker: nativeCommitWorker(actual.Worker) };
});

const start = '2026-10-16T00:00:00.000Z';
const finalInstant = '9948-12-22T12:26:40.000Z';
const fixtures: { root: string; db: CoreDb }[] = [];
const definition = {
  workspaceId: testEntityId('ws', 'scanner-owner'),
  threadId: testEntityId('th', 'scanner-owner'),
  name: 'Inspect',
  prompt: 'Keep this exact input.',
  intervalSeconds: 60,
};

/** Uses the existing Core, definition and mutation owners for valid fixture state. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'automation-scanner-owner-'));
  const db = openCoreDb(root);
  fixtures.push({ root, db });
  applyMigrations(db);
  const userId = ensureLocalUser(db);
  recordWorkspaceOwnerMembership({
    coreDb: db,
    workspaceId: definition.workspaceId,
    ownerUserId: userId,
  });
  let instant = start;
  const gate = new WorkspaceMutationAdmission();
  const store = new AutomationStore(db, gate, () => instant);
  return {
    db,
    userId,
    gate,
    store,
    setTime: (value: string) => {
      instant = value;
    },
  };
}

/** Reads complete original rows, including untouched Core families, at this storage-owner seam. */
function coreRows(db: CoreDb) {
  const tables = db.sqlite
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
    .all() as { name: string }[];
  return tables.map(({ name }) => [
    name,
    db.sqlite
      .prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`)
      .all()
      .map((row) => JSON.stringify(row))
      .sort(),
  ]);
}

/** Reaches an exhausted successor through admitted cadence and original scan operations. */
async function exhaustedFixture() {
  const f = fixture();
  const created = await f.store.createAutomation(f.userId, {
    ...definition,
    intervalSeconds: 250_000_000_000,
  });
  const active = await f.store.updateAutomation(f.userId, created.id, {
    expectedRevision: created.revision,
    status: 'active',
    scheduledAt: start,
  });
  const [first] = await f.store.collectScanCandidates(start);
  expect(first?.scheduleId).toBe(active.id);
  // The accepted cadence arithmetic fixes this value; it is not read as the expected value from source.
  expect(f.store.getAutomation(active.id).nextScheduledAt).toBe(finalInstant);
  f.setTime(finalInstant);
  const healthy = await f.store.createAutomation(f.userId, definition);
  await f.store.updateAutomation(f.userId, healthy.id, {
    expectedRevision: healthy.revision,
    status: 'active',
    scheduledAt: finalInstant,
  });
  return { ...f, exhausted: active, healthy };
}

afterEach(async () => {
  releaseCommit();
  vi.restoreAllMocks();
  for (const { db } of fixtures) if (db.sqlite.open) db.sqlite.pragma('query_only = OFF');
  await shutdownControlStoreWorkerClient();
  for (const { root, db } of fixtures.splice(0)) {
    if (db.sqlite.open) db.sqlite.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it('refuses a changed native scan selection and leaves the complete post-mutation rows unchanged', async () => {
  const f = fixture();
  const created = await f.store.createAutomation(f.userId, definition);
  const active = await f.store.updateAutomation(f.userId, created.id, {
    expectedRevision: created.revision,
    status: 'active',
    scheduledAt: start,
  });
  const client = getControlStoreWorkerClient();
  const native = client.automationScanner.bind(client);
  const original = coreRows(f.db);
  let beforeWrite: ReturnType<typeof coreRows> | undefined;
  let armed = true;
  // Return the real native plan unchanged. The ordinary mutation uses schedulerAdmission independently.
  const observed = vi
    .spyOn(client, 'automationScanner')
    .mockImplementation(async (database, input) => {
      const result = await native(database, input);
      if (input.action !== 'plan' || !armed) return result;
      armed = false;
      expect(result.kind).toBe('plan');
      expect(coreRows(f.db)).toEqual(original);
      await f.store.updateAutomation(f.userId, active.id, {
        expectedRevision: active.revision,
        status: 'paused',
      });
      beforeWrite = coreRows(f.db);
      return result;
    });
  f.db.sqlite.pragma('query_only = ON');
  const result = Promise.resolve().then(() => f.store.collectScanCandidates(start));
  // COORD 07:36(c): use the existing definite no-write refusal, not a synthetic error from this wrapper.
  await expect(result).rejects.toMatchObject({ code: 'precondition', commit: 'not-committed' });
  expect(beforeWrite).toBeDefined();
  expect(coreRows(f.db)).toEqual(beforeWrite);
  await nextTurn();
  // COORD 07:36: one read-only native plan and ONE deciding stage; no immediate replan or retry.
  expect(observed.mock.calls.map(([, input]) => input.action)).toEqual(['plan', 'publish']);
  expect(observed).toHaveBeenCalledTimes(2);
});

it('propagates a throwing cadence callback before native scan publication and preserves every original row', async () => {
  const f = await exhaustedFixture();
  const original = coreRows(f.db);
  const observed = vi.spyOn(getControlStoreWorkerClient(), 'automationScanner');
  const sentinel = new Error('test cadence callback refused');
  const onError = vi.fn(() => {
    throw sentinel;
  });
  f.db.sqlite.pragma('query_only = ON');
  const result = Promise.resolve().then(() => f.store.collectScanCandidates(finalInstant, onError));
  // COORD 07:36(b): the callback's own failure wins before the native write stage.
  await expect(result).rejects.toBe(sentinel);
  expect(onError).toHaveBeenCalledTimes(1);
  // The existing real client carries only the read-only plan; throwing must prevent stage posting.
  expect(observed).toHaveBeenCalledTimes(1);
  expect(observed.mock.calls[0]?.[1].action).toBe('plan');
  expect(coreRows(f.db)).toEqual(original);
  expect(f.store.getAutomation(f.exhausted.id).nextScheduledAt).toBe(finalInstant);
  expect(f.store.listHistory(f.healthy.id).items).toEqual([]);
});

it.each(['refusal', 'unknown'] as const)(
  'holds actual Workspace mutation admission until the original native %s ACK settles',
  async (outcome) => {
    const f = await exhaustedFixture();
    if (outcome === 'refusal') {
      // Deliberate failure only after valid owner setup: the actual native stage cannot publish its cursor.
      f.db.sqlite.exec(
        `CREATE TRIGGER reject_scan_cursor BEFORE UPDATE ON recurring_schedules BEGIN SELECT RAISE(ABORT, 'test scan cursor refusal'); END;`
      );
    }
    const original = coreRows(f.db);
    f.db.sqlite.pragma('query_only = ON');
    const observed = vi.spyOn(getControlStoreWorkerClient(), 'automationScanner');
    const posted = vi.spyOn(Worker.prototype, 'postMessage');
    let held: Int32Array | undefined;
    let settled = false;
    // The actual Main callback follows the plan ACK; arm only the subsequent publish COMMIT.
    const onError = vi.fn(() => {
      held = armCommit(2);
    });
    const result = Promise.resolve()
      .then(() => f.store.collectScanCandidates(finalInstant, onError))
      .finally(() => {
        settled = true;
      });
    void result.catch(() => undefined);
    await vi.waitFor(() => expect(held && Atomics.load(held, 0)).toBe(1), { timeout: 5000 });
    expect(Atomics.load(held!, 5)).toBe(2);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(observed.mock.calls.map(([, input]) => input.action)).toEqual(['plan', 'publish']);
    const committed = coreRows(f.db);
    expect(settled).toBe(false);
    // These are the real public gate operations; no spy supplies admission or release.
    expect(f.gate.tryFreeze(definition.workspaceId, () => []).status).toBe('busy');
    let closed = false;
    const closing = f.gate.close(definition.workspaceId).then(() => {
      closed = true;
    });
    await nextTurn();
    expect(closed).toBe(false);
    if (outcome === 'unknown') {
      const call = posted.mock.calls.findIndex(
        ([request]) =>
          request?.operation === 'automation-scanner' && request.input?.action === 'publish'
      );
      if (call < 0) throw new Error('No actual scanner publication was posted.');
      expect(committed).not.toEqual(original);
      expect(f.store.getAutomation(f.exhausted.id).nextScheduledAt).toBeNull();
      await (posted.mock.contexts[call] as Worker).terminate();
      await expect(result).rejects.toMatchObject({ code: 'unavailable', commit: 'unknown' });
      // Unknown is not rollback: preserve the exact committed rows observed before losing the reply.

      expect(coreRows(f.db)).toEqual(committed);
    } else {
      expect(committed).toEqual(original);
      releaseCommit();
      await expect(result).rejects.toMatchObject({ code: 'constraint', commit: 'not-committed' });
      expect(coreRows(f.db)).toEqual(original);
    }
    await nextTurn();
    expect(observed.mock.calls.map(([, input]) => input.action)).toEqual(['plan', 'publish']);
    expect(f.db.sqlite.pragma('query_only', { simple: true })).toBe(1);
    await closing;
    expect(closed).toBe(true);
    f.gate.reopen(definition.workspaceId);
    const freeze = f.gate.tryFreeze(definition.workspaceId, () => []);
    expect(freeze.status).toBe('frozen');
    if (freeze.status === 'frozen') freeze.release();
  }
);
