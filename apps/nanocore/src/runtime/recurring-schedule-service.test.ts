import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureLocalUser } from '../auth/identity.js';
import { AutomationStore } from '../lib/automation-store.js';
import { FsStore } from '../lib/store.js';
import { openCoreDb, type CoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import type { RecurringPreparation } from '../storage/recurring-records.js';
import { initializeRecurringScheduleStorage } from '../storage/recurring-schema.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import {
  startRecurringScheduleService,
  type RecurringScheduleService,
} from './recurring-schedule-service.js';

const owned: { root: string; db: CoreDb; services: RecurringScheduleService[] }[] = [];
const ready: Extract<RecurringPreparation, { kind: 'ready' }> = {
  kind: 'ready',
  payload: {
    backendId: 'test-backend',
    requestedAgentId: 'worker',
    profileRef: 'provider/main',
    modelId: 'exact-model',
    workspaceCwd: null,
    workspaceRoots: [],
  },
};
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'recurrence-service-'));
  const db = openCoreDb(root);
  applyMigrations(db);
  initializeRecurringScheduleStorage(db.sqlite);
  ensureLocalUser(db);
  const store = new FsStore({ dataRoot: root });
  const workspace = store.createWorkspace('Recurring');
  const thread = store.createThread(workspace.id, 'Target');
  recordWorkspaceOwnerMembership({
    coreDb: db,
    workspaceId: workspace.id,
    ownerUserId: 'user_local',
  });
  const gate = new WorkspaceMutationAdmission();
  let instant = '2026-10-16T00:00:00.000Z';
  const clock = () => instant;
  const schedules = new AutomationStore(db, gate, clock);
  const created = schedules.createAutomation('user_local', {
    name: 'Poll',
    workspaceId: workspace.id,
    threadId: thread.id,
    intervalSeconds: 5,
    prompt: 'Inspect status',
  });
  const schedule = schedules.updateAutomation('user_local', created.id, {
    expectedRevision: 1,
    status: 'active',
    scheduledAt: instant,
  });
  const services: RecurringScheduleService[] = [];
  owned.push({ root, db, services });
  const start = (
    prepare: (
      occurrence: Parameters<Parameters<typeof startRecurringScheduleService>[0]['prepare']>[0]
    ) => Promise<RecurringPreparation> = async () => structuredClone(ready)
  ) => {
    const setTimer = vi.fn(() => 'timer');
    const clearTimer = vi.fn();
    const onError = vi.fn();
    const service = startRecurringScheduleService({
      schedules,
      store,
      prepare,
      now: clock,
      setInterval: setTimer,
      clearInterval: clearTimer,
      onError,
    });
    services.push(service);
    return { service, setTimer, clearTimer, onError };
  };
  return {
    root,
    db,
    store,
    schedules,
    schedule,
    gate,
    workspace,
    thread,
    clock,
    start,
    setTime: (value: string) => {
      instant = value;
    },
  };
}
afterEach(() => {
  for (const { root, db, services } of owned.splice(0)) {
    for (const service of services) service.stop();
    db.sqlite.close();
    rmSync(root, { recursive: true, force: true });
  }
});

describe('serialized recurring scanner', () => {
  it('uses one five-second timer, admits only to the existing queue, and never creates or launches a Turn', async () => {
    const { db, store, schedules, schedule, start } = fixture();
    const createTurn = vi.spyOn(store, 'createTurn');
    const { service, setTimer } = start();
    await service.runOnce();
    expect(setTimer).toHaveBeenCalledWith(expect.any(Function), 5000);
    expect(createTurn).not.toHaveBeenCalled();
    const occurrence = schedules.listHistory(schedule.id).items[0]!.record;
    expect(occurrence).toMatchObject({
      state: 'admission-accepted',
      snapshot: { actor: schedule.actor },
    });
    await service.runOnce();
    expect(
      db.sqlite.prepare('SELECT count(*) AS n FROM scheduler_admission_entries').get()
    ).toEqual({ n: 1 });
  });

  it('coalesces overlapping callbacks and retries a failure only on a later scan', async () => {
    const { schedules, schedule, start } = fixture();
    let release!: (value: RecurringPreparation) => void;
    const prepare = vi.fn(
      () =>
        new Promise<RecurringPreparation>((resolve) => {
          release = resolve;
        })
    );
    const { service } = start(prepare);
    const first = service.runOnce();
    expect(service.runOnce()).toBe(first);
    expect(prepare).toHaveBeenCalledTimes(1);
    release({ kind: 'failure', code: 'selection_unavailable' });
    await first;
    expect(schedules.listHistory(schedule.id).items[0]!.record).toMatchObject({
      state: 'pending',
      attempts: [{ code: 'selection_unavailable' }],
    });
    const second = service.runOnce();
    expect(prepare).toHaveBeenCalledTimes(2);
    release({ kind: 'failure', code: 'selection_unavailable' });
    await second;
    const third = service.runOnce();
    release({ kind: 'failure', code: 'selection_unavailable' });
    await third;
    expect(schedules.listHistory(schedule.id).items[0]!.record).toMatchObject({
      state: 'admission-failed',
      attempts: [{ number: 1 }, { number: 2 }, { number: 3 }],
    });
    await service.runOnce();
    expect(prepare).toHaveBeenCalledTimes(3);
  });

  it('rechecks the exact responsible membership after slow preparation without actor substitution', async () => {
    const { db, schedules, schedule, workspace, start } = fixture();
    let release!: (value: RecurringPreparation) => void;
    const prepare = vi.fn(
      () =>
        new Promise<RecurringPreparation>((resolve) => {
          release = resolve;
        })
    );
    const { service } = start(prepare);
    const scan = service.runOnce();
    db.sqlite.transaction(() => {
      const timestamp = '2026-10-16T00:00:00.000Z';
      db.sqlite
        .prepare(`INSERT INTO users
        (id, display_name, email, email_verified, created_at, updated_at, kind)
        VALUES ('user_replacement', 'Replacement', 'recurrence-replacement@example.com', false, ?, ?, 'human')`)
        .run(Date.parse(timestamp), Date.parse(timestamp));
      db.sqlite
        .prepare(`INSERT INTO workspace_members
        (workspace_id, user_id, status, access_level, invitation_id, joined_at, removed_at, revision, created_at, updated_at)
        VALUES (?, 'user_replacement', 'active', 'editor', NULL, ?, NULL, 1, ?, ?)`)
        .run(workspace.id, timestamp, timestamp, timestamp);
      db.sqlite
        .prepare(`UPDATE workspace_registry SET owner_user_id = 'user_replacement', revision = revision + 1, updated_at = ?
        WHERE workspace_id = ?`)
        .run(timestamp, workspace.id);
      db.sqlite
        .prepare(`UPDATE workspace_members SET status = 'removed', removed_at = ?, revision = revision + 1, updated_at = ?
        WHERE workspace_id = ? AND user_id = 'user_local'`)
        .run(timestamp, timestamp, workspace.id);
    })();
    release(structuredClone(ready));
    await scan;
    expect(schedules.listHistory(schedule.id).items[0]!.record).toMatchObject({
      state: 'pending',
      attempts: [{ code: 'authority_denied' }],
      snapshot: { actor: schedule.actor },
    });
    expect(
      db.sqlite.prepare('SELECT count(*) AS n FROM scheduler_admission_entries').get()
    ).toEqual({ n: 0 });
    await service.runOnce();
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  it('expires when preparation crosses the original deadline without counting an outcome', async () => {
    const { db, schedules, schedule, setTime, start } = fixture();
    let release!: (value: RecurringPreparation) => void;
    const { service } = start(
      () =>
        new Promise<RecurringPreparation>((resolve) => {
          release = resolve;
        })
    );
    const scan = service.runOnce();
    setTime('2026-10-16T00:10:00.000Z');
    release(structuredClone(ready));
    await scan;
    expect(schedules.listHistory(schedule.id).items[0]!.record).toMatchObject({
      state: 'expired',
      attempts: [],
      resolvedPayload: null,
    });
    expect(
      db.sqlite.prepare('SELECT count(*) AS n FROM scheduler_admission_entries').get()
    ).toEqual({ n: 0 });
  });

  it('lets pause win against a scanner awaiting preparation', async () => {
    const { db, schedules, schedule, start } = fixture();
    let release!: (value: RecurringPreparation) => void;
    const { service } = start(
      () =>
        new Promise<RecurringPreparation>((resolve) => {
          release = resolve;
        })
    );
    const scan = service.runOnce();
    schedules.updateAutomation('user_local', schedule.id, {
      expectedRevision: schedule.revision,
      status: 'paused',
    });
    release(structuredClone(ready));
    await scan;
    expect(schedules.listHistory(schedule.id).items[0]!.record.state).toBe('cancelled');
    expect(
      db.sqlite.prepare('SELECT count(*) AS n FROM scheduler_admission_entries').get()
    ).toEqual({ n: 0 });
  });

  it('fences unknown preparation effects and does not retry them', async () => {
    const { schedules, schedule, start } = fixture();
    const prepare = vi.fn(async () => {
      throw new Error('unknown owner effect');
    });
    const { service, onError } = start(prepare);
    await service.runOnce();
    await service.runOnce();
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(schedules.listHistory(schedule.id).items[0]!.record).toMatchObject({
      state: 'recovery_required',
      attempts: [],
    });
  });

  it('honors the existing Workspace mutation fence before materialization', async () => {
    const { db, gate, workspace, start } = fixture();
    await gate.close(workspace.id);
    const prepare = vi.fn(async () => structuredClone(ready));
    const { service } = start(prepare);
    await service.runOnce();
    expect(prepare).not.toHaveBeenCalled();
    expect(db.sqlite.prepare('SELECT count(*) AS n FROM recurring_occurrences').get()).toEqual({
      n: 0,
    });
  });
});

it('inspects durable acceptance after an unknown commit result and never submits it again', async () => {
  const { db, schedules, schedule, start } = fixture();
  const original = schedules.commitAttempt.bind(schedules);
  let loseResult = true;
  vi.spyOn(schedules, 'commitAttempt').mockImplementation((...input) => {
    const accepted = original(...input);
    if (loseResult) {
      loseResult = false;
      throw new Error('commit acknowledgement lost');
    }
    return accepted;
  });
  const prepare = vi.fn(async () => structuredClone(ready));
  const { service, onError } = start(prepare);
  await service.runOnce();
  await service.runOnce();
  expect(onError).toHaveBeenCalledTimes(1);
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(schedules.listHistory(schedule.id).items[0]!.record).toMatchObject({
    state: 'admission-accepted',
    attempts: [{ number: 1, code: 'accepted' }],
  });
  expect(db.sqlite.prepare('SELECT count(*) AS n FROM scheduler_admission_entries').get()).toEqual({
    n: 1,
  });
});

it('does not accept into a private Thread owned by another responsible user', async () => {
  const { store, schedules, schedule, workspace, thread, start } = fixture();
  const original = store.getThread.bind(store);
  vi.spyOn(store, 'getThread').mockImplementation((workspaceId, threadId) =>
    workspaceId === workspace.id && threadId === thread.id
      ? {
          ...original(workspaceId, threadId),
          visibility: 'private',
          privateOwnerUserId: 'user_other',
        }
      : original(workspaceId, threadId)
  );
  const prepare = vi.fn(async () => structuredClone(ready));
  const { service } = start(prepare);
  await service.runOnce();
  expect(prepare).not.toHaveBeenCalled();
  expect(schedules.listHistory(schedule.id).items[0]!.record).toMatchObject({
    state: 'pending',
    attempts: [{ code: 'authority_denied' }],
  });
});

it('holds mutation admission through bounded preparation so backup waits for the scanner to leave', async () => {
  const { db, gate, workspace, start } = fixture();
  let release!: (value: RecurringPreparation) => void;
  const { service } = start(
    () =>
      new Promise<RecurringPreparation>((resolve) => {
        release = resolve;
      })
  );
  const scan = service.runOnce();
  let closed = false;
  const closing = gate.close(workspace.id).then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  release(structuredClone(ready));
  await scan;
  await closing;
  expect(closed).toBe(true);
  expect(db.sqlite.prepare('SELECT count(*) AS n FROM scheduler_admission_entries').get()).toEqual({
    n: 0,
  });
});
