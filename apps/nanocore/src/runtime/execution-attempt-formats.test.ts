import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, onTestFinished } from 'vitest';
import { createSchedulerAdmissionEntry } from '../scheduler-records.js';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import {
  acceptSchedulerExecutionObservation,
  bindSchedulerExecutionAttemptSession,
  closeSchedulerExecutionAttemptWithoutEffects,
  createSchedulerExecutionAttempt,
  finalizeSchedulerExecutionAttemptInput,
  listOpenSchedulerExecutionAttempts,
  markSchedulerExecutionAttemptClosing,
  recordSchedulerExecutionOperation,
  requireSchedulerExecutionAttempt,
  schedulerExecutionCorrelation,
} from './execution-attempt-records.js';

/** Creates one current admitted attempt without launching a Worker. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'openkit-attempt-format-'));
  const db = openCoreDb(root);
  onTestFinished(() => {
    db.sqlite.close();
    rmSync(root, { recursive: true, force: true });
  });
  applyMigrations(db);
  ensureLocalUser(db);
  const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
  const actor = { kind: 'user' as const, id: 'usr_00000000-0000-7000-8000-000000000001' };
  recordWorkspaceOwnerMembership({ coreDb: db, workspaceId, ownerUserId: actor.id });
  const entry = createSchedulerAdmissionEntry(db, {
    queueEntryId: 'queue-attempt-format',
    backendId: 'nanohost',
    triggerActor: actor,
    workspaceId,
    threadId: 'th_00000000-0000-7000-8000-000000000001',
    turnId: 'tu_00000000-0000-7000-8000-000000000001',
    turnInput: 'Inspect retained format.',
    requestedAgentId: 'agent_worker',
  });
  const attempt = createSchedulerExecutionAttempt(db, {
    entry,
    preparationInput: { admission: entry, descriptiveNote: 'Retain this evidence.' },
  });
  return { db, attempt };
}

it('writes v1 attempts and reads their exact preparation bytes without rewriting them', () => {
  const { db, attempt } = fixture();
  const before = db.sqlite.prepare('SELECT * FROM scheduler_execution_attempts').get();
  expect(before).toMatchObject({ schema_version: 1 });
  expect(requireSchedulerExecutionAttempt(db, attempt.attemptId)).toEqual(attempt);
  expect(listOpenSchedulerExecutionAttempts(db)).toEqual([attempt]);
  expect(db.sqlite.prepare('SELECT * FROM scheduler_execution_attempts').get()).toEqual(before);
});

it('refuses unknown attempt versions before recovery reads or lifecycle mutation', () => {
  const { db, attempt } = fixture();
  bindSchedulerExecutionAttemptSession(db, {
    attemptId: attempt.attemptId,
    agentSessionId: 'as_00000000-0000-7000-8000-000000000001',
  });
  finalizeSchedulerExecutionAttemptInput(db, {
    attemptId: attempt.attemptId,
    inputRef: 'input-format',
    bindingRef: 'binding-format',
  });
  const submitted = recordSchedulerExecutionOperation(db, {
    attemptId: attempt.attemptId,
    operationId: 'operation-format',
    submission: true,
  });
  const correlation = schedulerExecutionCorrelation(submitted);
  expect(
    acceptSchedulerExecutionObservation(db, {
      ...correlation,
      disposition: 'unknown',
      execution: 'unknown',
      outcomeRef: null,
      fenceRef: null,
    })
  ).toMatchObject({ disposition: 'unknown' });
  db.sqlite.exec(
    "UPDATE scheduler_execution_attempts SET schema_version = 2, preparation_input_json = '{'"
  );
  const before = db.sqlite.prepare('SELECT * FROM scheduler_execution_attempts').get();
  db.sqlite.exec(
    "CREATE TRIGGER refuse_unknown_attempt_update BEFORE UPDATE ON scheduler_execution_attempts BEGIN SELECT RAISE(FAIL, 'Unknown attempt reached UPDATE'); END"
  );
  expect(() => requireSchedulerExecutionAttempt(db, attempt.attemptId)).toThrow(
    'Unsupported retained record format.'
  );
  expect(() =>
    acceptSchedulerExecutionObservation(db, {
      ...correlation,
      disposition: 'accepted',
      execution: 'terminal',
      outcomeRef: 'outcome-format',
      fenceRef: 'fence-format',
    })
  ).toThrow('Unsupported retained record format.');
  expect(() => listOpenSchedulerExecutionAttempts(db)).toThrow(
    'Unsupported retained record format.'
  );
  expect(() =>
    markSchedulerExecutionAttemptClosing(db, { attemptId: attempt.attemptId, cause: 'cancelled' })
  ).toThrow('Unsupported retained record format.');
  expect(() =>
    closeSchedulerExecutionAttemptWithoutEffects(db, {
      attemptId: attempt.attemptId,
      noOutstandingEffects: true,
      cause: 'cancelled',
      requeue: true,
    })
  ).toThrow('Unsupported retained record format.');
  expect(db.sqlite.prepare('SELECT * FROM scheduler_execution_attempts').get()).toEqual(before);
});
