import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type CoreDb, openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { findAcceptedRecurringOccurrenceForQueue } from '../storage/recurring-records.js';
import { initializeRecurringScheduleStorage } from '../storage/recurring-schema.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import { AutomationStore } from './automation-store.js';

const fixtures: { root: string; db: CoreDb }[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'recurrence-store-'));
  const db = openCoreDb(root);
  applyMigrations(db);
  initializeRecurringScheduleStorage(db.sqlite);
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
  workspaceId: 'ws_test',
  threadId: 'th_test',
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
    const schedule = store.createAutomation('user_creator', definition);
    expect(schedule).toMatchObject({
      status: 'paused',
      actor: { kind: 'automation', id: schedule.id, responsibleUserId: 'user_creator' },
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
    const created = store.createAutomation('user_creator', definition);
    const active = store.updateAutomation('user_creator', created.id, {
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
  const schedule = store.createAutomation('user_creator', definition);
  store.updateAutomation('user_creator', schedule.id, {
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
  const schedule = store.createAutomation('user_creator', definition);
  store.updateAutomation('user_creator', schedule.id, {
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
  const schedule = store.createAutomation('user_creator', definition);
  store.updateAutomation('user_creator', schedule.id, {
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
  const schedule = store.createAutomation('user_creator', definition);
  store.updateAutomation('user_creator', schedule.id, {
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
  const schedule = store.createAutomation('user_creator', definition);
  store.updateAutomation('user_creator', schedule.id, {
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
  const schedule = store.createAutomation('user_creator', definition);
  store.updateAutomation('user_creator', schedule.id, {
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
  const schedule = store.createAutomation('user_creator', definition);
  store.updateAutomation('user_creator', schedule.id, {
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
  const schedule = store.createAutomation('user_creator', definition);
  store.updateAutomation('user_creator', schedule.id, {
    expectedRevision: 1,
    status: 'active',
    scheduledAt: '2026-10-16T00:00:00.000Z',
  });
  const [pending] = store.collectScanCandidates('2026-10-16T00:00:00.000Z');
  setTime('2026-10-16T01:00:00.000Z');
  const paused = store.updateAutomation('user_other', schedule.id, {
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
  const edited = store.updateAutomation('user_other', schedule.id, {
    expectedRevision: paused.revision,
    prompt: 'New input',
    intervalSeconds: 10,
  });
  expect(() =>
    store.updateAutomation('user_other', schedule.id, {
      expectedRevision: edited.revision,
      status: 'active',
      scheduledAt: '2026-10-16T01:00:00.000Z',
    })
  ).toThrow('new current-or-future');
  const resumed = store.updateAutomation('user_other', schedule.id, {
    expectedRevision: edited.revision,
    status: 'active',
    scheduledAt: '2026-10-16T01:00:10.000Z',
  });
  expect(resumed.responsibleUserId).toBe('user_creator');
});

it('records a huge outage as a lossless range and serves live work without unbounded replay', () => {
  const { store, setTime } = fixture();
  const schedule = store.createAutomation('user_creator', definition);
  store.updateAutomation('user_creator', schedule.id, {
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
  const schedule = store.createAutomation('user_creator', definition);
  store.updateAutomation('user_creator', schedule.id, {
    expectedRevision: 1,
    status: 'active',
    scheduledAt: '2026-10-16T00:00:00.000Z',
  });
  const [occurrence] = store.collectScanCandidates('2026-10-16T00:00:00.000Z');
  const accepted = store.commitAttempt(occurrence!.id, 2, { kind: 'ready', payload });
  store.deleteAutomation('user_other', schedule.id);
  expect(store.getAutomation(schedule.id)).toMatchObject({
    status: 'deleted',
    responsibleUserId: 'user_creator',
  });
  expect(store.getOccurrence(occurrence!.id)).toEqual(accepted);
  expect(store.listAuthorizedAutomations([definition.workspaceId])).toEqual([]);
  expect(store.collectScanCandidates('2026-10-16T00:00:00.000Z')).toEqual([]);
  expect(() =>
    store.updateAutomation('user_creator', schedule.id, {
      expectedRevision: 3,
      status: 'active',
      scheduledAt: '2026-10-16T00:01:00.000Z',
    })
  ).toThrow('lifecycle conflicts');
});

it('commits every definition and terminal transition with its Workspace AuditEvent and rolls back audit failure', () => {
  const { db, store } = fixture();
  const schedule = store.createAutomation('user_creator', definition);
  expect(
    db.sqlite.prepare('SELECT action, actor_json, workspace_id FROM audit_events').get()
  ).toMatchObject({
    action: 'recurring.schedule.created',
    actor_json: JSON.stringify({ kind: 'user', id: 'user_creator' }),
    workspace_id: definition.workspaceId,
  });
  store.updateAutomation('user_creator', schedule.id, {
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
        "SELECT action, actor_json FROM audit_events WHERE action = 'recurring.occurrence.admission-accepted'"
      )
      .get()
  ).toEqual({
    action: 'recurring.occurrence.admission-accepted',
    actor_json: JSON.stringify(schedule.actor),
  });
});

it('does not advance the definition cursor when materialization rolls back', () => {
  const { db, store } = fixture();
  const schedule = store.createAutomation('user_creator', definition);
  const active = store.updateAutomation('user_creator', schedule.id, {
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
  const schedule = store.createAutomation('user_creator', definition);
  store.updateAutomation('user_creator', schedule.id, {
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
    store.updateAutomation('user_creator', schedule.id, { expectedRevision: 2, status: 'paused' })
  ).toThrow('fenced');
  expect(() => store.deleteAutomation('user_creator', schedule.id)).toThrow('fenced');
  expect(store.getOccurrence(occurrence!.id)).toMatchObject({ state: 'pending', attempts: [] });
});

it('reopens pending work with its attempt count, immutable payload, and original deadline', () => {
  const { db, root, store, clock } = fixture();
  const schedule = store.createAutomation('user_creator', definition);
  store.updateAutomation('user_creator', schedule.id, {
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
      const schedule = store.createAutomation('user_creator', {
        ...definition,
        intervalSeconds: 3600,
      });
      store.updateAutomation('user_creator', schedule.id, {
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
  const schedule = store.createAutomation('user_creator', definition);
  store.updateAutomation('user_creator', schedule.id, {
    expectedRevision: 1,
    status: 'active',
    scheduledAt: '2026-10-16T00:00:00.000Z',
  });
  const [occurrence] = store.collectScanCandidates('2026-10-16T00:00:00.000Z');
  const accepted = store.commitAttempt(occurrence!.id, 2, { kind: 'ready', payload })!;
  expect(findAcceptedRecurringOccurrenceForQueue(db, accepted.queueEntryId!)).toEqual(accepted);
  db.sqlite
    .prepare(
      "UPDATE scheduler_admission_entries SET turn_input = 'changed bytes' WHERE queue_entry_id = ?"
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
