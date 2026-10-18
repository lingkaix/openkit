import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AutomationStore } from '../lib/automation-store.js';
import {
  createSchedulerAdmissionEntry,
  requireSchedulerAdmissionEntry,
} from '../scheduler-records.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import { type CoreDb, openCoreDb } from './db.js';
import {
  findExternalTriggerAdmission,
  insertExternalTriggerAdmission,
  listWorkspaceExternalTriggerAdmissions,
} from './external-trigger-admissions.js';
import { applyMigrations } from './migrate.js';

const fixtures: { root: string; db: CoreDb }[] = [];
const workspaceId = testEntityId('ws', 'external-events');
const sourceTurnId = testEntityId('tu', 'poll');

/** Creates ordinary Core schedule and queue owners for the retained join regressions. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'external-trigger-admissions-'));
  const db = openCoreDb(root);
  applyMigrations(db);
  fixtures.push({ root, db });
  const schedules = new AutomationStore(db, new WorkspaceMutationAdmission());
  const schedule = schedules.createAutomation(testEntityId('usr', 'owner'), {
    workspaceId,
    threadId: testEntityId('th', 'poll'),
    name: 'Poll source',
    intervalSeconds: 60,
    prompt: 'Read selected source',
  });
  return { root, db, schedule };
}

/** Creates a real scheduler queue entry inside its caller's Core transaction. */
function queue(
  db: CoreDb,
  schedule: ReturnType<typeof fixture>['schedule'],
  key: string,
  targetWorkspaceId = workspaceId
) {
  return createSchedulerAdmissionEntry(db, {
    queueEntryId: `queue_${randomUUID()}_event`,
    backendId: 'backend',
    triggerActor: schedule.actor,
    workspaceId: targetWorkspaceId,
    threadId: testEntityId('th', key),
    turnId: testEntityId('tu', key),
    turnInput: `Handle ${key}`,
    requestedAgentId: 'worker',
  });
}

afterEach(() => {
  const remaining = fixtures.splice(0);
  for (const { db } of remaining) if (db.sqlite.open) db.sqlite.close();
  for (const root of new Set(remaining.map((entry) => entry.root)))
    rmSync(root, { recursive: true, force: true });
});

describe('ExternalTriggerAdmission Core joins', () => {
  it('retains immutable event admission across reopen and allows distinct events from one poll', () => {
    const { root, db, schedule } = fixture();
    const admissions = db.sqlite.transaction(() =>
      ['mail:one', 'mail:two'].map((eventKey) => {
        const entry = queue(db, schedule, eventKey);
        return insertExternalTriggerAdmission(db, {
          scheduleId: schedule.id,
          eventKey,
          sourceTurnId,
          queueEntryId: entry.queueEntryId,
        });
      })
    )();
    expect(admissions).toHaveLength(2);
    expect(new Set(admissions.map((record) => record.queueEntryId)).size).toBe(2);
    db.sqlite.close();
    const reopened = openCoreDb(root);
    fixtures.push({ root, db: reopened });
    applyMigrations(reopened);
    expect(listWorkspaceExternalTriggerAdmissions(reopened, workspaceId)).toEqual(admissions);
    expect(listWorkspaceExternalTriggerAdmissions(reopened, testEntityId('ws', 'other'))).toEqual(
      []
    );
    expect(findExternalTriggerAdmission(reopened, schedule.id, 'mail:absent')).toBeNull();
    const original = admissions[0]!;
    const duplicate = reopened.sqlite.transaction(() =>
      insertExternalTriggerAdmission(reopened, {
        ...original,
        sourceTurnId: testEntityId('tu', 'later-poll'),
        queueEntryId: randomUUID(),
      })
    )();
    expect(duplicate).toEqual(original);
    expect(requireSchedulerAdmissionEntry(reopened, original.queueEntryId).turnInput).toBe(
      'Handle mail:one'
    );
    expect(listWorkspaceExternalTriggerAdmissions(reopened, workspaceId)).toHaveLength(2);
  });

  it('rolls back the join and the real queue entry together', () => {
    const { db, schedule } = fixture();
    let queueEntryId = '';
    expect(() =>
      db.sqlite.transaction(() => {
        const entry = queue(db, schedule, 'rollback');
        queueEntryId = entry.queueEntryId;
        insertExternalTriggerAdmission(db, {
          scheduleId: schedule.id,
          eventKey: 'mail:rollback',
          sourceTurnId,
          queueEntryId,
        });
        throw new Error('abort enclosing admission');
      })()
    ).toThrow('abort enclosing admission');
    expect(findExternalTriggerAdmission(db, schedule.id, 'mail:rollback')).toBeNull();
    expect(() => requireSchedulerAdmissionEntry(db, queueEntryId)).toThrow();
  });

  it('refuses missing or cross-Workspace lineage and invalid required fields without retaining a join', () => {
    const { db, schedule } = fixture();
    const entry = queue(db, schedule, 'invalid', testEntityId('ws', 'other'));
    const record = {
      scheduleId: schedule.id,
      eventKey: 'mail:invalid',
      sourceTurnId,
      queueEntryId: entry.queueEntryId,
    };
    expect(() => insertExternalTriggerAdmission(db, record)).toThrow(/transaction/);
    expect(() => db.sqlite.transaction(() => insertExternalTriggerAdmission(db, record))()).toThrow(
      /Workspace/
    );
    for (const patch of [
      { scheduleId: testEntityId('auto', 'missing') },
      { sourceTurnId: 'invalid' },
      { eventKey: '' },
      { eventKey: 'x'.repeat(1025) },
      { queueEntryId: randomUUID() },
    ])
      expect(() =>
        db.sqlite.transaction(() => insertExternalTriggerAdmission(db, { ...record, ...patch }))()
      ).toThrow();
    expect(listWorkspaceExternalTriggerAdmissions(db, workspaceId)).toEqual([]);
  });

  it('refuses invalid retained core fields', () => {
    const { db, schedule } = fixture();
    const record = db.sqlite.transaction(() => {
      const entry = queue(db, schedule, 'retained');
      return insertExternalTriggerAdmission(db, {
        scheduleId: schedule.id,
        eventKey: 'mail:retained',
        sourceTurnId,
        queueEntryId: entry.queueEntryId,
      });
    })();
    expect(findExternalTriggerAdmission(db, schedule.id, record.eventKey)).toEqual(record);
    db.sqlite.prepare('UPDATE external_trigger_admissions SET source_turn_id = ?').run('invalid');
    expect(() => findExternalTriggerAdmission(db, schedule.id, record.eventKey)).toThrow();
    expect(() => listWorkspaceExternalTriggerAdmissions(db, workspaceId)).toThrow();
  });
});
