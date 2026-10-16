import { testEntityId } from '../test-support/entity-ids.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureLocalUser } from '../auth/identity.js';
import { startRecurringScheduleService } from '../runtime/recurring-schedule-service.js';
import {
  cancelSchedulerAdmissionEntry,
  denySchedulerAdmissionEntry,
  requireSchedulerAdmissionEntry,
  retryDeniedSchedulerAdmissionEntry,
} from '../scheduler-records.js';
import { type CoreDb, openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { findAcceptedRecurringOccurrenceForQueue } from '../storage/recurring-records.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import { AutomationMutationError, AutomationStore } from './automation-store.js';
import { FsStore } from './store.js';

const fixtures: { root: string; db: CoreDb }[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'recurrence-store-'));
  const db = openCoreDb(root);
  applyMigrations(db);
  fixtures.push({ root, db });
  let instant = '2026-10-16T00:00:00.000Z';
  const clock = () => instant;
  const gate = new WorkspaceMutationAdmission();
  const store = new AutomationStore(db, gate, clock);
  return {
    root,
    db,
    clock,
    store,
    gate,
    setTime: (value: string) => {
      instant = value;
    },
  };
}
afterEach(() => {
  const remaining = fixtures.splice(0);
  for (const { db } of remaining) if (db.sqlite.open) db.sqlite.close();
  for (const root of new Set(remaining.map((entry) => entry.root)))
    rmSync(root, { recursive: true, force: true });
});
const definition = {
  workspaceId: testEntityId('ws', 'ws_test'),
  threadId: testEntityId('th', 'th_test'),
  name: 'Poll',
  intervalSeconds: 5,
  prompt: 'Inspect status',
};
const payload = {
  backendId: 'backend_test',
  requestedAgentId: 'worker',
  profileRef: 'provider/main',
  modelId: 'model-exact',
  workspaceCwd: null,
  workspaceRoots: [],
};

describe('durable fixed-interval recurrence', () => {
  it('starts paused and preserves identity across a database reopen', () => {
    const { db, root, clock, store } = fixture();
    const schedule = store.createAutomation(testEntityId('usr', 'user_creator'), definition);
    expect(schedule).toMatchObject({
      status: 'paused',
      actor: { kind: 'automation', id: schedule.id, responsibleUserId: testEntityId('usr', 'user_creator') },
    });
    db.sqlite.close();
    const reopened = openCoreDb(root);
    fixtures.push({ root, db: reopened });
    expect(
      new AutomationStore(reopened, new WorkspaceMutationAdmission(), clock).getAutomation(
        schedule.id
      )
    ).toEqual(schedule);
  });
  it('atomically accepts one deterministic queue row and never retries accepted work', () => {
    const { db, store } = fixture();
    const created = store.createAutomation(testEntityId('usr', 'user_creator'), definition);
    const active = store.updateAutomation(testEntityId('usr', 'user_creator'), created.id, {
      expectedRevision: 1,
      status: 'active',
      scheduledAt: '2026-10-16T00:00:00.000Z',
    });
    const [occurrence] = store.collectScanCandidates('2026-10-16T00:00:00.000Z');
    const accepted = store.commitAttempt(occurrence!.id, active.revision, {
      kind: 'ready',
      payload,
    });
    expect(accepted?.state).toBe('admission-accepted');
    expect(accepted?.attempts).toHaveLength(1);
    expect(
      db.sqlite.prepare('SELECT count(*) AS n FROM scheduler_admission_entries').get()
    ).toEqual({ n: 1 });
    expect(store.collectScanCandidates('2026-10-16T00:00:00.000Z')).toEqual([]);
    store.commitAttempt(occurrence!.id, active.revision, { kind: 'ready', payload });
    expect(
      db.sqlite.prepare('SELECT count(*) AS n FROM scheduler_admission_entries').get()
    ).toEqual({ n: 1 });
  });
});

it('limits committed outcomes to three and keeps admission-failed terminal at expiry', () => {
  const { store, setTime } = fixture();
  const schedule = store.createAutomation(testEntityId('usr', 'user_creator'), definition);
  store.updateAutomation(testEntityId('usr', 'user_creator'), schedule.id, {
    expectedRevision: 1,
    status: 'active',
    scheduledAt: '2026-10-16T00:00:00.000Z',
  });
  const [first] = store.collectScanCandidates('2026-10-16T00:00:00.000Z');
  for (let attempt = 1; attempt <= 3; attempt++) {
    const result = store.commitAttempt(first!.id, 2, { kind: 'failure', code: 'authority_denied' });
    expect(result?.attempts).toHaveLength(attempt);
    expect(result?.state).toBe(attempt === 3 ? 'admission-failed' : 'pending');
  }
  setTime('2026-10-16T00:10:00.000Z');
  store.collectScanCandidates('2026-10-16T00:10:00.000Z');
  expect(store.getOccurrence(first!.id).state).toBe('admission-failed');
});

it('expires at the exact deadline and leaves a backward-clock candidate pending without an outcome', () => {
  const { db, store, setTime } = fixture();
  const schedule = store.createAutomation(testEntityId('usr', 'user_creator'), definition);
  store.updateAutomation(testEntityId('usr', 'user_creator'), schedule.id, {
    expectedRevision: 1,
    status: 'active',
    scheduledAt: '2026-10-16T00:00:00.000Z',
  });
  const [occurrence] = store.collectScanCandidates('2026-10-16T00:00:00.000Z');
  setTime('2026-10-15T23:59:59.000Z');
  expect(store.commitAttempt(occurrence!.id, 2, { kind: 'ready', payload })?.attempts).toEqual([]);
  setTime('2026-10-16T00:10:00.000Z');
  expect(store.commitAttempt(occurrence!.id, 2, { kind: 'ready', payload })).toMatchObject({
    state: 'expired',
    attempts: [],
    resolvedPayload: null,
  });
  expect(db.sqlite.prepare('SELECT count(*) AS n FROM scheduler_admission_entries').get()).toEqual({
    n: 0,
  });
});

it('rolls back the queue, attempt, frozen payload and acceptance together', () => {
  const { db, store } = fixture();
  const schedule = store.createAutomation(testEntityId('usr', 'user_creator'), definition);
  store.updateAutomation(testEntityId('usr', 'user_creator'), schedule.id, {
    expectedRevision: 1,
    status: 'active',
    scheduledAt: '2026-10-16T00:00:00.000Z',
  });
  const [occurrence] = store.collectScanCandidates('2026-10-16T00:00:00.000Z');
  db.sqlite.exec(`CREATE TRIGGER reject_occurrence_acceptance BEFORE UPDATE ON recurring_occurrences
    WHEN NEW.state = 'admission-accepted' BEGIN SELECT RAISE(ABORT, 'injected rollback'); END;`);
  expect(() => store.commitAttempt(occurrence!.id, 2, { kind: 'ready', payload })).toThrow(
    'injected rollback'
  );
  expect(store.getOccurrence(occurrence!.id)).toMatchObject({
    state: 'pending',
    attempts: [],
    resolvedPayload: null,
  });
  expect(db.sqlite.prepare('SELECT count(*) AS n FROM scheduler_admission_entries').get()).toEqual({
    n: 0,
  });
  db.sqlite.exec('DROP TRIGGER reject_occurrence_acceptance');
  expect(store.commitAttempt(occurrence!.id, 2, { kind: 'ready', payload })?.attempts).toHaveLength(
    1
  );
});

it('bounds each schedule to one queued occurrence while allowing a running predecessor', () => {
  const { db, store, setTime } = fixture();
  const schedule = store.createAutomation(testEntityId('usr', 'user_creator'), definition);
  store.updateAutomation(testEntityId('usr', 'user_creator'), schedule.id, {
    expectedRevision: 1,
    status: 'active',
    scheduledAt: '2026-10-16T00:00:00.000Z',
  });
  const [first] = store.collectScanCandidates('2026-10-16T00:00:00.000Z');
  const accepted = store.commitAttempt(first!.id, 2, { kind: 'ready', payload })!;
  setTime('2026-10-16T00:00:05.000Z');
  const [second] = store.collectScanCandidates('2026-10-16T00:00:05.000Z');
  expect(store.commitAttempt(second!.id, 2, { kind: 'ready', payload })).toMatchObject({
    state: 'pending',
    attempts: [{ code: 'queue_backlog_full' }],
    resolvedPayload: payload,
  });
  db.sqlite
    .prepare("UPDATE scheduler_admission_entries SET status = 'admitted' WHERE queue_entry_id = ?")
    .run(accepted.queueEntryId);
  expect(store.commitAttempt(second!.id, 2, { kind: 'ready', payload })?.state).toBe(
    'admission-accepted'
  );
  expect(store.getOccurrence(first!.id).attempts).toHaveLength(1);
});

it('freezes the complete first resolved payload on failure and fences substitution', () => {
  const { db, store } = fixture();
  const schedule = store.createAutomation(testEntityId('usr', 'user_creator'), definition);
  store.updateAutomation(testEntityId('usr', 'user_creator'), schedule.id, {
    expectedRevision: 1,
    status: 'active',
    scheduledAt: '2026-10-16T00:00:00.000Z',
  });
  const [occurrence] = store.collectScanCandidates('2026-10-16T00:00:00.000Z');
  expect(
    store.commitAttempt(occurrence!.id, 2, { kind: 'failure', code: 'preparation_failed', payload })
      ?.resolvedPayload
  ).toEqual(payload);
  const changed = { ...payload, modelId: 'replacement' };
  expect(store.commitAttempt(occurrence!.id, 2, { kind: 'ready', payload: changed })).toMatchObject(
    {
      state: 'recovery_required',
      resolvedPayload: payload,
      attempts: [{ code: 'preparation_failed' }],
    }
  );
  expect(db.sqlite.prepare('SELECT count(*) AS n FROM scheduler_admission_entries').get()).toEqual({
    n: 0,
  });
});

it.each([
  'queued',
  'admitted',
  'denied',
  'cancelled',
  'expired',
])('reconciles exact deterministic queue replay in %s without resubmission', (status) => {
  const { db, store } = fixture();
  const schedule = store.createAutomation(testEntityId('usr', 'user_creator'), definition);
  store.updateAutomation(testEntityId('usr', 'user_creator'), schedule.id, {
    expectedRevision: 1,
    status: 'active',
    scheduledAt: '2026-10-16T00:00:00.000Z',
  });
  const [occurrence] = store.collectScanCandidates('2026-10-16T00:00:00.000Z');
  const accepted = store.commitAttempt(occurrence!.id, 2, { kind: 'ready', payload })!;
  db.sqlite
    .prepare('UPDATE scheduler_admission_entries SET status = ? WHERE queue_entry_id = ?')
    .run(status, accepted.queueEntryId);
  const replay = { ...accepted, state: 'pending', terminalAt: null };
  db.sqlite
    .prepare('UPDATE recurring_occurrences SET state = ?, record_json = ? WHERE id = ?')
    .run('pending', JSON.stringify(replay), replay.id);
  expect(
    store.commitAttempt(occurrence!.id, 2, { kind: 'failure', code: 'authority_denied' })
  ).toMatchObject({
    state: 'admission-accepted',
    queueEntryId: accepted.queueEntryId,
    turnId: accepted.turnId,
    attempts: accepted.attempts,
  });
  expect(db.sqlite.prepare('SELECT count(*) AS n FROM scheduler_admission_entries').get()).toEqual({
    n: 1,
  });
});

it('fences a conflicting deterministic queue row without overwriting it', () => {
  const { db, store } = fixture();
  const schedule = store.createAutomation(testEntityId('usr', 'user_creator'), definition);
  store.updateAutomation(testEntityId('usr', 'user_creator'), schedule.id, {
    expectedRevision: 1,
    status: 'active',
    scheduledAt: '2026-10-16T00:00:00.000Z',
  });
  const [occurrence] = store.collectScanCandidates('2026-10-16T00:00:00.000Z');
  const accepted = store.commitAttempt(occurrence!.id, 2, { kind: 'ready', payload })!;
  db.sqlite
    .prepare(
      "UPDATE scheduler_admission_entries SET input_hash = 'contradiction' WHERE queue_entry_id = ?"
    )
    .run(accepted.queueEntryId);
  db.sqlite
    .prepare("UPDATE recurring_occurrences SET state = 'pending', record_json = ? WHERE id = ?")
    .run(JSON.stringify({ ...accepted, state: 'pending', terminalAt: null }), accepted.id);
  expect(store.commitAttempt(accepted.id, 2, { kind: 'ready', payload })?.state).toBe(
    'recovery_required'
  );
  expect(db.sqlite.prepare('SELECT input_hash FROM scheduler_admission_entries').get()).toEqual({
    input_hash: 'contradiction',
  });
});

it('seals pause history with the old snapshot, cancels pending work, and rejects a stale scan', () => {
  const { store, setTime } = fixture();
  const schedule = store.createAutomation(testEntityId('usr', 'user_creator'), definition);
  store.updateAutomation(testEntityId('usr', 'user_creator'), schedule.id, {
    expectedRevision: 1,
    status: 'active',
    scheduledAt: '2026-10-16T00:00:00.000Z',
  });
  const [pending] = store.collectScanCandidates('2026-10-16T00:00:00.000Z');
  setTime('2026-10-16T01:00:00.000Z');
  const paused = store.updateAutomation(testEntityId('usr', 'user_other'), schedule.id, {
    expectedRevision: 2,
    status: 'paused',
  });
  expect(paused).toMatchObject({
    status: 'paused',
    nextScheduledAt: null,
    greatestAccountedScheduledAt: '2026-10-16T01:00:00.000Z',
  });
  expect(store.getOccurrence(pending!.id).state).toBe('cancelled');
  const history = store.listHistory(schedule.id, 128).items;
  const range = history.find((entry) => entry.kind === 'expired-range')!;
  expect(range.record).toMatchObject({
    definitionRevision: 2,
    firstScheduledAt: '2026-10-16T00:00:05.000Z',
    lastScheduledAt: '2026-10-16T00:50:00.000Z',
    count: 600,
    snapshot: { prompt: definition.prompt, threadId: definition.threadId },
  });
  expect(
    history.filter((entry) => entry.kind === 'occurrence' && entry.record.state === 'cancelled')
  ).toHaveLength(121);
  expect(store.commitAttempt(pending!.id, 2, { kind: 'ready', payload })?.state).toBe('cancelled');
  const edited = store.updateAutomation(testEntityId('usr', 'user_other'), schedule.id, {
    expectedRevision: paused.revision,
    prompt: 'New input',
    intervalSeconds: 10,
  });
  expect(() =>
    store.updateAutomation(testEntityId('usr', 'user_other'), schedule.id, {
      expectedRevision: edited.revision,
      status: 'active',
      scheduledAt: '2026-10-16T01:00:00.000Z',
    })
  ).toThrow('new current-or-future');
  const resumed = store.updateAutomation(testEntityId('usr', 'user_other'), schedule.id, {
    expectedRevision: edited.revision,
    status: 'active',
    scheduledAt: '2026-10-16T01:00:10.000Z',
  });
  expect(resumed.responsibleUserId).toBe(testEntityId('usr', 'user_creator'));
});

it('records a huge outage as a lossless range and serves live work without unbounded replay', () => {
  const { store, setTime } = fixture();
  const schedule = store.createAutomation(testEntityId('usr', 'user_creator'), definition);
  store.updateAutomation(testEntityId('usr', 'user_creator'), schedule.id, {
    expectedRevision: 1,
    status: 'active',
    scheduledAt: '2026-10-16T00:00:00.000Z',
  });
  setTime('2036-10-16T00:00:00.000Z');
  const candidates = store.collectScanCandidates('2036-10-16T00:00:00.000Z');
  expect(candidates).toHaveLength(120);
  expect(candidates[0]!.scheduledAt).toBe('2036-10-15T23:50:05.000Z');
  const history = store.listHistory(schedule.id, 128);
  expect(history.items).toHaveLength(121);
  const range = history.items.find((entry) => entry.kind === 'expired-range')!.record;
  expect(range).toMatchObject({
    firstScheduledAt: '2026-10-16T00:00:00.000Z',
    lastScheduledAt: '2036-10-15T23:50:00.000Z',
    count: 63_123_721,
  });
  expect(store.getAutomation(schedule.id).nextScheduledAt).toBe('2036-10-16T00:00:05.000Z');
});

it('retains accepted admissions on delete and cannot resume the identity tombstone', () => {
  const { store } = fixture();
  const schedule = store.createAutomation(testEntityId('usr', 'user_creator'), definition);
  store.updateAutomation(testEntityId('usr', 'user_creator'), schedule.id, {
    expectedRevision: 1,
    status: 'active',
    scheduledAt: '2026-10-16T00:00:00.000Z',
  });
  const [occurrence] = store.collectScanCandidates('2026-10-16T00:00:00.000Z');
  const accepted = store.commitAttempt(occurrence!.id, 2, { kind: 'ready', payload });
  store.deleteAutomation(testEntityId('usr', 'user_other'), schedule.id);
  expect(store.getAutomation(schedule.id)).toMatchObject({
    status: 'deleted',
    responsibleUserId: testEntityId('usr', 'user_creator'),
  });
  expect(store.getOccurrence(occurrence!.id)).toEqual(accepted);
  expect(store.listAuthorizedAutomations([definition.workspaceId])).toEqual([
    store.getAutomation(schedule.id),
  ]);
  expect(store.collectScanCandidates('2026-10-16T00:00:00.000Z')).toEqual([]);
  expect(() =>
    store.updateAutomation(testEntityId('usr', 'user_creator'), schedule.id, {
      expectedRevision: 3,
      status: 'active',
      scheduledAt: '2026-10-16T00:01:00.000Z',
    })
  ).toThrow('lifecycle conflicts');
});

it('commits every definition and terminal transition with its Workspace AuditEvent and rolls back audit failure', () => {
  const { db, store } = fixture();
  const schedule = store.createAutomation(testEntityId('usr', 'user_creator'), definition);
  expect(
    db.sqlite.prepare('SELECT action, actor_json, workspace_id FROM audit_events').get()
  ).toMatchObject({
    action: 'recurring.schedule.create',
    actor_json: JSON.stringify({ kind: 'user', id: testEntityId('usr', 'user_creator') }),
    workspace_id: definition.workspaceId,
  });
  store.updateAutomation(testEntityId('usr', 'user_creator'), schedule.id, {
    expectedRevision: 1,
    status: 'active',
    scheduledAt: '2026-10-16T00:00:00.000Z',
  });
  const [occurrence] = store.collectScanCandidates('2026-10-16T00:00:00.000Z');
  db.sqlite.exec(`CREATE TRIGGER reject_recurrence_audit BEFORE INSERT ON audit_events
    WHEN NEW.action LIKE 'recurring.occurrence.%' BEGIN SELECT RAISE(ABORT, 'audit rejected'); END;`);
  expect(() => store.commitAttempt(occurrence!.id, 2, { kind: 'ready', payload })).toThrow(
    'audit rejected'
  );
  expect(store.getOccurrence(occurrence!.id)).toMatchObject({ state: 'pending', attempts: [] });
  expect(db.sqlite.prepare('SELECT count(*) AS n FROM scheduler_admission_entries').get()).toEqual({
    n: 0,
  });
  db.sqlite.exec('DROP TRIGGER reject_recurrence_audit');
  store.commitAttempt(occurrence!.id, 2, { kind: 'ready', payload });
  expect(
    db.sqlite
      .prepare(
        `SELECT action, actor_json, ${testEntityId('tu', 'turn_id')} FROM audit_events WHERE action = 'recurring.occurrence.terminal'`
      )
      .get()
  ).toEqual({
    action: 'recurring.occurrence.terminal',
    actor_json: JSON.stringify(schedule.actor),
    turn_id: null,
  });
});

it('does not advance the definition cursor when materialization rolls back', () => {
  const { db, store } = fixture();
  const schedule = store.createAutomation(testEntityId('usr', 'user_creator'), definition);
  const active = store.updateAutomation(testEntityId('usr', 'user_creator'), schedule.id, {
    expectedRevision: 1,
    status: 'active',
    scheduledAt: '2026-10-16T00:00:00.000Z',
  });
  db.sqlite.exec(`CREATE TRIGGER reject_materialization BEFORE INSERT ON recurring_occurrences
    BEGIN SELECT RAISE(ABORT, 'materialization rejected'); END;`);
  expect(() => store.collectScanCandidates('2026-10-16T00:00:00.000Z')).toThrow(
    'materialization rejected'
  );
  expect(store.getAutomation(schedule.id)).toEqual(active);
});

it('uses the shared Workspace fence for definition changes and admission', async () => {
  const { store, gate } = fixture();
  const schedule = store.createAutomation(testEntityId('usr', 'user_creator'), definition);
  store.updateAutomation(testEntityId('usr', 'user_creator'), schedule.id, {
    expectedRevision: 1,
    status: 'active',
    scheduledAt: '2026-10-16T00:00:00.000Z',
  });
  const [occurrence] = store.collectScanCandidates('2026-10-16T00:00:00.000Z');
  await gate.close(definition.workspaceId);
  expect(() => store.commitAttempt(occurrence!.id, 2, { kind: 'ready', payload })).toThrow(
    'fenced'
  );
  expect(() =>
    store.updateAutomation(testEntityId('usr', 'user_creator'), schedule.id, { expectedRevision: 2, status: 'paused' })
  ).toThrow('fenced');
  expect(() => store.deleteAutomation(testEntityId('usr', 'user_creator'), schedule.id)).toThrow('fenced');
  expect(store.getOccurrence(occurrence!.id)).toMatchObject({ state: 'pending', attempts: [] });
});

it('reopens pending work with its attempt count, immutable payload, and original deadline', () => {
  const { db, root, store, clock } = fixture();
  const schedule = store.createAutomation(testEntityId('usr', 'user_creator'), definition);
  store.updateAutomation(testEntityId('usr', 'user_creator'), schedule.id, {
    expectedRevision: 1,
    status: 'active',
    scheduledAt: '2026-10-16T00:00:00.000Z',
  });
  const [occurrence] = store.collectScanCandidates('2026-10-16T00:00:00.000Z');
  store.commitAttempt(occurrence!.id, 2, { kind: 'failure', code: 'preparation_failed', payload });
  db.sqlite.close();
  const reopened = openCoreDb(root);
  fixtures.push({ root, db: reopened });
  const restarted = new AutomationStore(reopened, new WorkspaceMutationAdmission(), clock);
  const [pending] = restarted.collectScanCandidates('2026-10-16T00:00:00.000Z');
  expect(pending).toMatchObject({
    id: occurrence!.id,
    attempts: [{ number: 1, code: 'preparation_failed' }],
    resolvedPayload: payload,
    deadline: '2026-10-16T00:10:00.000Z',
  });
  expect(
    restarted.commitAttempt(pending!.id, 2, { kind: 'ready', payload })?.attempts
  ).toHaveLength(2);
});

it('caps live selection at 128 globally in nominal deadline order', () => {
  const { db, store, setTime } = fixture();
  // One transaction amortizes fixture setup; the real owner still performs each mutation and Audit write.
  const schedules = db.sqlite.transaction(() =>
    Array.from({ length: 140 }, (_, index) => {
      const schedule = store.createAutomation(testEntityId('usr', 'user_creator'), {
        ...definition,
        intervalSeconds: 3600,
      });
      store.updateAutomation(testEntityId('usr', 'user_creator'), schedule.id, {
        expectedRevision: 1,
        status: 'active',
        scheduledAt: new Date(Date.parse('2026-10-16T00:00:00.000Z') + index * 1000).toISOString(),
      });
      return schedule;
    })
  )();
  setTime('2026-10-16T00:02:20.000Z');
  const candidates = store.collectScanCandidates('2026-10-16T00:02:20.000Z');
  expect(candidates).toHaveLength(128);
  expect(candidates.map((occurrence) => occurrence.scheduleId)).toEqual(
    schedules.slice(0, 128).map((schedule) => schedule.id)
  );
  expect(store.getAutomation(schedules[128]!.id).nextScheduledAt).toBe('2026-10-16T00:02:08.000Z');
});

it('verifies the retained queue bytes as well as its stored hash before publishing acceptance', () => {
  const { db, store } = fixture();
  const schedule = store.createAutomation(testEntityId('usr', 'user_creator'), definition);
  store.updateAutomation(testEntityId('usr', 'user_creator'), schedule.id, {
    expectedRevision: 1,
    status: 'active',
    scheduledAt: '2026-10-16T00:00:00.000Z',
  });
  const [occurrence] = store.collectScanCandidates('2026-10-16T00:00:00.000Z');
  const accepted = store.commitAttempt(occurrence!.id, 2, { kind: 'ready', payload })!;
  expect(findAcceptedRecurringOccurrenceForQueue(db, accepted.queueEntryId!)).toEqual(accepted);
  db.sqlite
    .prepare(
      `UPDATE scheduler_admission_entries SET ${testEntityId('tu', 'turn_input')} = 'changed bytes' WHERE queue_entry_id = ?`
    )
    .run(accepted.queueEntryId);
  expect(() => findAcceptedRecurringOccurrenceForQueue(db, accepted.queueEntryId!)).toThrow(
    'contradicts'
  );
  db.sqlite
    .prepare("UPDATE recurring_occurrences SET state = 'pending', record_json = ? WHERE id = ?")
    .run(JSON.stringify({ ...accepted, state: 'pending', terminalAt: null }), accepted.id);
  expect(store.commitAttempt(accepted.id, 2, { kind: 'ready', payload })?.state).toBe(
    'recovery_required'
  );
});

const monthlyDefinition = {
  workspaceId: testEntityId('ws', 'ws_test'),
  threadId: testEntityId('th', 'th_test'),
  name: 'Monthly',
  prompt: 'Inspect status',
  monthlyUtc: { zone: 'UTC' as const, dayOfMonth: 28, hour: 9, minute: 0, second: 0 },
};

describe('monthly UTC recurrence lifecycle', () => {
  it('materializes the monthly nominal instant and advances its exact cursor', () => {
    const { db, store, gate, clock, setTime } = fixture();
    setTime('2027-01-28T09:00:00.000Z');
    const paused = store.createAutomation(testEntityId('usr', 'user_creator'), monthlyDefinition);
    expect(paused.status).toBe('paused');
    expect(store.collectScanCandidates(clock())).toEqual([]);
    const active = store.updateAutomation(testEntityId('usr', 'user_creator'), paused.id, {
      expectedRevision: 1,
      status: 'active',
      scheduledAt: clock(),
    });
    const candidates = store.collectScanCandidates(clock());
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      scheduledAt: clock(),
      snapshot: { monthlyUtc: monthlyDefinition.monthlyUtc },
      definitionRevision: active.revision,
    });
    expect(store.getAutomation(paused.id)).toMatchObject({
      nextScheduledAt: '2027-02-28T09:00:00.000Z',
      greatestAccountedScheduledAt: clock(),
    });
    const secondStore = new AutomationStore(db, gate, clock);
    expect(secondStore.collectScanCandidates(clock()).map((record) => record.id)).toEqual(
      candidates.map((record) => record.id)
    );
  });
});

it('rejects off-rule monthly resume without mutation and replaces complete paused timing', () => {
  const { store, setTime } = fixture();
  setTime('2027-01-01T00:00:00.000Z');
  const original = store.createAutomation(testEntityId('usr', 'user_creator'), monthlyDefinition);
  for (const scheduledAt of [
    '2027-01-29T09:00:00.000Z',
    '2027-01-28T09:01:00.000Z',
    '2027-01-28T09:00:00.001Z',
    '2027-01-28T09:00:00.0001Z',
  ]) {
    expect(() =>
      store.updateAutomation(testEntityId('usr', 'user_creator'), original.id, {
        expectedRevision: 1,
        status: 'active',
        scheduledAt,
      })
    ).toThrow(AutomationMutationError);
    expect(store.getAutomation(original.id)).toEqual(original);
  }
  const fixed = store.updateAutomation(testEntityId('usr', 'user_creator'), original.id, {
    expectedRevision: 1,
    intervalSeconds: 7,
  });
  expect(fixed.intervalSeconds).toBe(7);
  expect(fixed).not.toHaveProperty('monthlyUtc');
  const monthly = store.updateAutomation(testEntityId('usr', 'user_creator'), original.id, {
    expectedRevision: 2,
    monthlyUtc: monthlyDefinition.monthlyUtc,
  });
  expect(monthly.monthlyUtc).toEqual(monthlyDefinition.monthlyUtc);
  expect(monthly).not.toHaveProperty('intervalSeconds');
});

it('seals a monthly outage with an exact immutable range and cancels the live instant before editing', () => {
  const { store, setTime } = fixture();
  setTime('2020-01-28T09:00:00.000Z');
  const created = store.createAutomation(testEntityId('usr', 'user_creator'), monthlyDefinition);
  store.updateAutomation(testEntityId('usr', 'user_creator'), created.id, {
    expectedRevision: 1,
    status: 'active',
    scheduledAt: '2020-01-28T09:00:00.000Z',
  });
  setTime('2027-01-28T09:00:00.000Z');
  const paused = store.updateAutomation(testEntityId('usr', 'user_creator'), created.id, {
    expectedRevision: 2,
    status: 'paused',
  });
  expect(paused).toMatchObject({
    nextScheduledAt: null,
    greatestAccountedScheduledAt: '2027-01-28T09:00:00.000Z',
  });
  const history = store.listHistory(created.id).items;
  expect(history).toHaveLength(2);
  expect(history[0]).toMatchObject({
    kind: 'occurrence',
    record: {
      state: 'cancelled',
      scheduledAt: '2027-01-28T09:00:00.000Z',
      snapshot: { monthlyUtc: monthlyDefinition.monthlyUtc },
      definitionRevision: 2,
    },
  });
  expect(history[1]).toMatchObject({
    kind: 'expired-range',
    record: {
      count: 84,
      firstScheduledAt: '2020-01-28T09:00:00.000Z',
      lastScheduledAt: '2026-12-28T09:00:00.000Z',
      monthlyUtc: monthlyDefinition.monthlyUtc,
      definitionRevision: 2,
    },
  });
  store.updateAutomation(testEntityId('usr', 'user_creator'), created.id, {
    expectedRevision: 3,
    monthlyUtc: { ...monthlyDefinition.monthlyUtc, dayOfMonth: 27 },
    prompt: 'New request',
  });
  expect(store.listHistory(created.id).items).toEqual(history);
  expect(() =>
    store.updateAutomation(testEntityId('usr', 'user_creator'), created.id, {
      expectedRevision: 4,
      status: 'active',
      scheduledAt: '2027-01-27T09:00:00.000Z',
    })
  ).toThrow(AutomationMutationError);
  store.deleteAutomation(testEntityId('usr', 'user_creator'), created.id);
  expect(store.getAutomation(created.id).status).toBe('deleted');
  expect(store.listHistory(created.id).items).toEqual(history);
});

it('orders actual fixed and monthly live frontiers before the shared 128 schedule limit', () => {
  const { store, setTime } = fixture();
  setTime('2020-01-28T09:00:00.000Z');
  for (let index = 0; index < 129; index++) {
    const created = store.createAutomation(testEntityId('usr', 'user_creator'), monthlyDefinition);
    store.updateAutomation(testEntityId('usr', 'user_creator'), created.id, {
      expectedRevision: 1,
      status: 'active',
      scheduledAt: '2020-01-28T09:00:00.000Z',
    });
  }
  const fixed = store.createAutomation(testEntityId('usr', 'user_creator'), { ...definition, intervalSeconds: 3600 });
  store.updateAutomation(testEntityId('usr', 'user_creator'), fixed.id, {
    expectedRevision: 1,
    status: 'active',
    scheduledAt: '2027-01-28T08:59:59.000Z',
  });
  setTime('2027-01-28T09:00:00.000Z');
  const selected = store.collectScanCandidates('2027-01-28T09:00:00.000Z');
  expect(selected).toHaveLength(128);
  expect(selected[0]).toMatchObject({
    scheduleId: fixed.id,
    scheduledAt: '2027-01-28T08:59:59.000Z',
  });
  expect(
    selected.slice(1).every((record) => record.scheduledAt === '2027-01-28T09:00:00.000Z')
  ).toBe(true);
  expect(store.collectScanCandidates('2027-01-28T09:00:00.000Z')).toHaveLength(128);
});

it('admits Jan 28, Feb 28 and Mar 28 once through the native scanner across a Core restart', async () => {
  const state = fixture();
  let db = state.db;
  ensureLocalUser(db);
  let files = new FsStore({ dataRoot: state.root });
  const workspace = files.createWorkspace('Monthly proof');
  const thread = files.createThread(workspace.id, 'Existing target');
  recordWorkspaceOwnerMembership({
    coreDb: db,
    workspaceId: workspace.id,
    ownerUserId: ensureLocalUser(db),
  });
  state.setTime('2027-01-28T09:00:00.000Z');
  let schedules = state.store;
  const created = schedules.createAutomation(ensureLocalUser(db), {
    ...monthlyDefinition,
    workspaceId: workspace.id,
    threadId: thread.id,
  });
  const errors = vi.fn();
  const prepare = vi.fn(async () => ({ kind: 'ready' as const, payload }));
  const start = () =>
    startRecurringScheduleService({
      schedules,
      store: files,
      prepare,
      now: state.clock,
      onError: errors,
      setInterval: () => 'timer',
      clearInterval: () => undefined,
    });
  let service = start();
  try {
    await service.runOnce();
    expect(prepare).not.toHaveBeenCalled();
    schedules.updateAutomation(ensureLocalUser(db), created.id, {
      expectedRevision: 1,
      status: 'active',
      scheduledAt: state.clock(),
    });
    await service.runOnce();
    const january = schedules.listHistory(created.id).items[0]!;
    expect(january.kind).toBe('occurrence');
    if (january.kind !== 'occurrence') throw new Error('Expected individual January occurrence.');
    expect(january.record).toMatchObject({
      state: 'admission-accepted',
      scheduledAt: state.clock(),
      attempts: [{ number: 1, code: 'accepted' }],
      snapshot: {
        monthlyUtc: monthlyDefinition.monthlyUtc,
        actor: created.actor,
        threadId: thread.id,
      },
    });
    expect(files.getTurnById(january.record.turnId!)).toMatchObject({
      status: 'pending',
      threadId: thread.id,
    });
    expect(requireSchedulerAdmissionEntry(db, january.record.queueEntryId!)).toMatchObject({
      triggerActor: created.actor,
      turnInput: monthlyDefinition.prompt,
      threadId: thread.id,
      ...payload,
    });
    cancelSchedulerAdmissionEntry(db, {
      queueEntryId: january.record.queueEntryId!,
      workspaceId: workspace.id,
    });
    state.setTime('2027-02-28T08:59:59.999Z');
    await service.runOnce();
    expect(prepare).toHaveBeenCalledTimes(1);
    service.stop();
    await service.runOnce();
    db.sqlite.close();
    db = openCoreDb(state.root);
    fixtures.push({ root: state.root, db });
    files = new FsStore({ dataRoot: state.root });
    schedules = new AutomationStore(db, new WorkspaceMutationAdmission(), state.clock);
    state.setTime('2027-02-28T09:00:00.000Z');
    service = start();
    await service.runOnce();
    const february = schedules.listHistory(created.id).items[0]!;
    if (february.kind !== 'occurrence') throw new Error('Expected individual February occurrence.');
    expect(february.record).toMatchObject({
      state: 'admission-accepted',
      scheduledAt: state.clock(),
      definitionRevision: 2,
      snapshot: { monthlyUtc: monthlyDefinition.monthlyUtc },
    });
    cancelSchedulerAdmissionEntry(db, {
      queueEntryId: february.record.queueEntryId!,
      workspaceId: workspace.id,
    });
    state.setTime('2027-03-28T09:00:00.000Z');
    await service.runOnce();
    await service.runOnce();
    expect(errors).not.toHaveBeenCalled();
    expect(prepare).toHaveBeenCalledTimes(3);
    const history = schedules.listHistory(created.id).items;
    expect(history).toHaveLength(3);
    expect(history.map(({ record }) => record)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scheduledAt: '2027-01-28T09:00:00.000Z',
          state: 'admission-accepted',
        }),
        expect.objectContaining({
          scheduledAt: '2027-02-28T09:00:00.000Z',
          state: 'admission-accepted',
        }),
        expect.objectContaining({
          scheduledAt: '2027-03-28T09:00:00.000Z',
          state: 'admission-accepted',
        }),
      ])
    );
    expect(
      db.sqlite.prepare('SELECT count(*) AS n FROM scheduler_admission_entries').get()
    ).toEqual({ n: 3 });
    expect(new Set(history.map(({ record }) => record.id)).size).toBe(3);
    expect(schedules.getAutomation(created.id).nextScheduledAt).toBe('2027-04-28T09:00:00.000Z');
    for (const item of history) {
      if (item.kind !== 'occurrence') throw new Error('Expected accepted monthly occurrence.');
      expect(item.record.snapshot).toMatchObject({
        actor: created.actor,
        prompt: monthlyDefinition.prompt,
        monthlyUtc: monthlyDefinition.monthlyUtc,
      });
      expect(files.getTurnById(item.record.turnId!)).toMatchObject({
        status: 'pending',
        threadId: thread.id,
      });
    }
    expect(
      db.sqlite.prepare('SELECT status FROM scheduler_admission_entries ORDER BY enqueued_at').all()
    ).toEqual([{ status: 'cancelled' }, { status: 'cancelled' }, { status: 'queued' }]);
    service.stop();
    await service.runOnce();
    db.sqlite.close();
    db = openCoreDb(state.root);
    fixtures.push({ root: state.root, db });
    files = new FsStore({ dataRoot: state.root });
    schedules = new AutomationStore(db, new WorkspaceMutationAdmission(), state.clock);
    service = start();
    await service.runOnce();
    expect(schedules.listHistory(created.id).items).toEqual(history);
    expect(
      db.sqlite.prepare('SELECT count(*) AS n FROM scheduler_admission_entries').get()
    ).toEqual({ n: 3 });
    expect(prepare).toHaveBeenCalledTimes(3);
    expect(errors).not.toHaveBeenCalled();
  } finally {
    service.stop();
    await service.runOnce();
  }
});

it('rolls back monthly range, cursor and Audit together before retrying the same exact prefix', () => {
  const { db, store, setTime } = fixture();
  setTime('2020-01-28T09:00:00.000Z');
  const created = store.createAutomation(testEntityId('usr', 'user_creator'), monthlyDefinition);
  const active = store.updateAutomation(testEntityId('usr', 'user_creator'), created.id, {
    expectedRevision: 1,
    status: 'active',
    scheduledAt: '2020-01-28T09:00:00.000Z',
  });
  setTime('2027-01-28T09:00:00.000Z');
  db.sqlite.exec(`CREATE TRIGGER reject_monthly_range_audit BEFORE INSERT ON audit_events
    WHEN NEW.action = 'recurring.expired-range.record' BEGIN SELECT RAISE(ABORT, 'range audit rejected'); END;`);
  expect(() => store.collectScanCandidates('2027-01-28T09:00:00.000Z')).toThrow(
    'range audit rejected'
  );
  expect(store.getAutomation(created.id)).toEqual(active);
  expect(store.listHistory(created.id).items).toEqual([]);
  db.sqlite.exec('DROP TRIGGER reject_monthly_range_audit');
  expect(store.collectScanCandidates('2027-01-28T09:00:00.000Z')).toHaveLength(1);
  expect(store.listHistory(created.id).items).toHaveLength(2);
  const row = store.listHistory(created.id).items.find((item) => item.kind === 'expired-range');
  expect(row).toMatchObject({ record: { count: 84, lastScheduledAt: '2026-12-28T09:00:00.000Z' } });
});

it('fails the SQL frontier closed on contradictory retained core timing', () => {
  const { db, store, setTime } = fixture();
  setTime('2027-01-28T09:00:00.000Z');
  const created = store.createAutomation(testEntityId('usr', 'user_creator'), monthlyDefinition);
  const active = store.updateAutomation(testEntityId('usr', 'user_creator'), created.id, {
    expectedRevision: 1,
    status: 'active',
    scheduledAt: '2027-01-28T09:00:00.000Z',
  });
  db.sqlite
    .prepare('UPDATE recurring_schedules SET record_json = ? WHERE id = ?')
    .run(JSON.stringify({ ...active, intervalSeconds: 5 }), created.id);
  expect(() => store.collectScanCandidates('2027-01-28T09:00:00.000Z')).toThrow();
  expect(db.sqlite.prepare('SELECT count(*) AS n FROM recurring_occurrences').get()).toEqual({
    n: 0,
  });
});

it('selects a live monthly instant ahead of more than 128 expired-only fixed prefixes', () => {
  const { db, store, setTime } = fixture();
  setTime('2020-01-28T09:00:00.000Z');
  db.sqlite.transaction(() => {
    for (let index = 0; index < 129; index++) {
      const old = store.createAutomation(testEntityId('usr', 'user_creator'), { ...definition, intervalSeconds: 86400 });
      store.updateAutomation(testEntityId('usr', 'user_creator'), old.id, {
        expectedRevision: 1,
        status: 'active',
        scheduledAt: '2020-01-28T09:01:00.000Z',
      });
    }
  })();
  const monthly = store.createAutomation(testEntityId('usr', 'user_creator'), monthlyDefinition);
  store.updateAutomation(testEntityId('usr', 'user_creator'), monthly.id, {
    expectedRevision: 1,
    status: 'active',
    scheduledAt: '2027-01-28T09:00:00.000Z',
  });
  setTime('2027-01-28T09:00:00.000Z');
  const selected = store.collectScanCandidates('2027-01-28T09:00:00.000Z');
  expect(selected).toHaveLength(1);
  expect(selected[0]).toMatchObject({
    scheduleId: monthly.id,
    scheduledAt: '2027-01-28T09:00:00.000Z',
  });
  expect(db.sqlite.prepare('SELECT count(*) AS n FROM recurring_expired_ranges').get()).toEqual({
    n: 128,
  });
});

it('preserves one series waiting slot during explicit retry, including after restart', () => {
  const { root, db, clock, store, setTime } = fixture();
  const created = store.createAutomation(testEntityId('usr', 'user_creator'), definition);
  const active = store.updateAutomation(testEntityId('usr', 'user_creator'), created.id, {
    expectedRevision: 1,
    status: 'active',
    scheduledAt: clock(),
  });
  const first = store.commitAttempt(store.collectScanCandidates(clock())[0]!.id, active.revision, {
    kind: 'ready',
    payload,
  })!;
  denySchedulerAdmissionEntry(db, {
    queueEntryId: first.queueEntryId!,
    denialReason: 'authority-denied',
  });
  setTime('2026-10-16T00:00:05.000Z');
  const later = store.commitAttempt(store.collectScanCandidates(clock())[0]!.id, active.revision, {
    kind: 'ready',
    payload,
  })!;
  const other = store.createAutomation(testEntityId('usr', 'user_creator'), {
    ...definition,
    name: 'Independent series',
  });
  const otherActive = store.updateAutomation(testEntityId('usr', 'user_creator'), other.id, {
    expectedRevision: 1,
    status: 'active',
    scheduledAt: clock(),
  });
  const otherDue = store
    .collectScanCandidates(clock())
    .find((occurrence) => occurrence.scheduleId === other.id)!;
  const otherAccepted = store.commitAttempt(otherDue.id, otherActive.revision, {
    kind: 'ready',
    payload,
  })!;
  expect(() =>
    retryDeniedSchedulerAdmissionEntry(db, {
      workspaceId: created.workspaceId,
      queueEntryId: first.queueEntryId!,
    })
  ).toThrow('already has a queued occurrence');
  expect(requireSchedulerAdmissionEntry(db, first.queueEntryId!).status).toBe('denied');
  expect(store.getOccurrence(first.id)).toEqual(first);
  expect(store.getOccurrence(later.id)).toEqual(later);
  db.sqlite.close();
  const reopened = openCoreDb(root);
  fixtures.push({ root, db: reopened });
  const restored = new AutomationStore(reopened, new WorkspaceMutationAdmission(), clock);
  expect(() =>
    retryDeniedSchedulerAdmissionEntry(reopened, {
      workspaceId: created.workspaceId,
      queueEntryId: first.queueEntryId!,
    })
  ).toThrow('already has a queued occurrence');
  cancelSchedulerAdmissionEntry(reopened, {
    workspaceId: created.workspaceId,
    queueEntryId: later.queueEntryId!,
  });
  const retried = retryDeniedSchedulerAdmissionEntry(reopened, {
    workspaceId: created.workspaceId,
    queueEntryId: first.queueEntryId!,
  });
  expect(retried).toMatchObject({
    queueEntryId: first.queueEntryId,
    turnId: first.turnId,
    status: 'queued',
  });
  expect(requireSchedulerAdmissionEntry(reopened, otherAccepted.queueEntryId!).status).toBe(
    'queued'
  );
  expect(requireSchedulerAdmissionEntry(reopened, later.queueEntryId!).status).toBe('cancelled');
  expect(restored.getOccurrence(first.id)).toEqual(first);
  expect(restored.getOccurrence(later.id)).toEqual(later);
  expect(restored.getOccurrence(otherAccepted.id)).toEqual(otherAccepted);
  expect(
    reopened.sqlite
      .prepare(`SELECT count(*) AS count FROM recurring_occurrences occurrence
    JOIN scheduler_admission_entries entry ON entry.queue_entry_id = occurrence.queue_entry_id
    WHERE occurrence.schedule_id = ? AND occurrence.state = 'admission-accepted' AND entry.status = 'queued'`)
      .get(created.id)
  ).toEqual({ count: 1 });
});
