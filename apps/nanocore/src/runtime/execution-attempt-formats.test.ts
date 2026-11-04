import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, onTestFinished, vi } from 'vitest';
import {
  createSchedulerAdmissionEntry,
  requireSchedulerAdmissionEntry,
} from '../scheduler-records.js';
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
  listSchedulerExecutionAttemptsForTurn,
  markSchedulerExecutionAttemptClosing,
  readSchedulerExecutionAttemptPagesForTurn,
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

/** Builds real closed retry history and one final open attempt through the existing owner. */
function attemptHistory(count: number) {
  const { db, attempt } = fixture();
  const entry = requireSchedulerAdmissionEntry(db, attempt.queueEntryId);
  const expected = [attempt];
  for (let index = 1; index < count; index += 1) {
    expected[index - 1] = closeSchedulerExecutionAttemptWithoutEffects(db, {
      attemptId: expected[index - 1]!.attemptId,
      noOutstandingEffects: true,
      cause: 'test-no-effects',
      requeue: true,
    });
    expected.push(
      createSchedulerExecutionAttempt(db, {
        entry,
        preparationInput: { admission: entry, index },
      })
    );
  }
  const scope = {
    workspaceId: entry.workspaceId,
    threadId: entry.threadId,
    turnId: entry.turnId,
  };
  return { db, entry, expected, scope };
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

it('keeps the original attempt snapshot when another WAL owner closes the last attempt during enumeration', () => {
  const { db, expected, scope } = attemptHistory(129);
  const current = expected.at(-1)!;
  const writer = openCoreDb(db.dataRoot);
  const prepare = db.sqlite.prepare.bind(db.sqlite);
  let crossed = false;
  // Keep every real SELECT result. Schedule the real writer after the first inventory
  // statement completes, independent of its page size or whether it is paged at all.
  const observation = vi.spyOn(db.sqlite, 'prepare').mockImplementation((sql) => {
    const statement = prepare(sql);
    if (sql.includes('FROM scheduler_execution_attempts') && sql.includes('ORDER BY rowid')) {
      const all = statement.all.bind(statement);
      vi.spyOn(statement, 'all').mockImplementation((...parameters) => {
        const rows = all(...parameters);
        if (!crossed) {
          crossed = true;
          closeSchedulerExecutionAttemptWithoutEffects(writer, {
            attemptId: current.attemptId,
            noOutstandingEffects: true,
            cause: 'test-no-effects',
            requeue: true,
          });
        }
        return rows;
      });
    }
    return statement;
  });
  try {
    expect(db.sqlite.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(writer.sqlite.pragma('journal_mode', { simple: true })).toBe('wal');
    const observed = listSchedulerExecutionAttemptsForTurn(db, scope);
    expect(crossed).toBe(true);
    expect(requireSchedulerExecutionAttempt(writer, current.attemptId).phase).toBe('closed');
    expect(requireSchedulerAdmissionEntry(writer, current.queueEntryId).status).toBe('queued');
    expect(observed.at(-1)?.phase).toBe('open');
    expect(observed).toEqual(expected);
  } finally {
    observation.mockRestore();
    writer.sqlite.close();
  }
});

it('reads exact signed 64-bit attempt rowids without changing retained records or enclosing transactions', () => {
  const { db, expected, scope } = attemptHistory(257);
  const retained = db.sqlite
    .prepare('SELECT * FROM scheduler_execution_attempts ORDER BY rowid')
    .all();
  // Only physical continuation positions change; all records came from their actual owner.
  const relocate = db.sqlite.prepare(
    'UPDATE scheduler_execution_attempts SET rowid=CAST(? AS INTEGER) WHERE attempt_id=?'
  );
  expected.forEach((attempt, index) => {
    const rowid =
      index === 0
        ? '-9223372036854775808'
        : index === 1
          ? '0'
          : index === 256
            ? '9223372036854775807'
            : (9007199254740990n + BigInt(index - 2)).toString();
    relocate.run(rowid, attempt.attemptId);
  });
  expect(
    db.sqlite.prepare('SELECT * FROM scheduler_execution_attempts ORDER BY rowid').all()
  ).toEqual(retained);
  const pages = [...readSchedulerExecutionAttemptPagesForTurn(db, scope)];
  expect(pages.length).toBeGreaterThan(1);
  for (const page of pages) {
    expect(page.length).toBeGreaterThan(0);
    expect(page.length).toBeLessThanOrEqual(128);
  }
  expect(pages.flat()).toEqual(expected);
  expect(listSchedulerExecutionAttemptsForTurn(db, scope)).toEqual(expected);
  db.sqlite
    .transaction(() => {
      expect(db.sqlite.inTransaction).toBe(true);
      expect(listSchedulerExecutionAttemptsForTurn(db, scope)).toEqual(expected);
      expect(db.sqlite.inTransaction).toBe(true);
    })
    .deferred();
  expect(db.sqlite.inTransaction).toBe(false);
  expect([
    ...readSchedulerExecutionAttemptPagesForTurn(db, {
      ...scope,
      turnId: 'tu_00000000-0000-7000-8000-000000000002',
    }),
  ]).toEqual([]);
  expect(
    db.sqlite.prepare('SELECT * FROM scheduler_execution_attempts ORDER BY rowid').all()
  ).toEqual(retained);
  db.sqlite
    .prepare('UPDATE scheduler_execution_attempts SET schema_version=2 WHERE attempt_id=?')
    .run(expected.at(-1)!.attemptId);
  const unsupported = db.sqlite
    .prepare('SELECT * FROM scheduler_execution_attempts ORDER BY rowid')
    .all();
  expect(() => [...readSchedulerExecutionAttemptPagesForTurn(db, scope)]).toThrow(
    'Unsupported retained record format.'
  );
  expect(() => listSchedulerExecutionAttemptsForTurn(db, scope)).toThrow(
    'Unsupported retained record format.'
  );
  expect(db.sqlite.inTransaction).toBe(false);
  expect(
    db.sqlite.prepare('SELECT * FROM scheduler_execution_attempts ORDER BY rowid').all()
  ).toEqual(unsupported);
});

it('releases the attempt read before cooperative suspension and early return', () => {
  const { db, expected, scope } = attemptHistory(129);
  const writer = openCoreDb(db.dataRoot);
  const pages = readSchedulerExecutionAttemptPagesForTurn(db, scope);
  try {
    const first = pages.next();
    if (first.done) throw new Error('Expected the owner-authored attempt inventory.');
    const firstPage = first.value;
    expect(firstPage.length).toBeGreaterThan(0);
    expect(firstPage.length).toBeLessThan(expected.length);
    expect(firstPage).toEqual(expected.slice(0, firstPage.length));
    expect(db.sqlite.inTransaction).toBe(false);
    const closed = closeSchedulerExecutionAttemptWithoutEffects(writer, {
      attemptId: expected.at(-1)!.attemptId,
      noOutstandingEffects: true,
      cause: 'test-no-effects',
      requeue: true,
    });
    expect(closed.phase).toBe('closed');
    expect(writer.sqlite.pragma('wal_checkpoint(TRUNCATE)')).toEqual([
      expect.objectContaining({ busy: 0 }),
    ]);
    expect([...pages].flat()).toEqual([...expected.slice(firstPage.length, -1), closed]);
    const early = readSchedulerExecutionAttemptPagesForTurn(db, scope);
    expect(early.next().done).toBe(false);
    expect(db.sqlite.inTransaction).toBe(false);
    early.return(undefined);
    expect(db.sqlite.inTransaction).toBe(false);
    expect(writer.sqlite.pragma('wal_checkpoint(TRUNCATE)')).toEqual([
      expect.objectContaining({ busy: 0 }),
    ]);
  } finally {
    pages.return(undefined);
    writer.sqlite.close();
  }
});
