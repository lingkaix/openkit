import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  cancelSchedulerAdmissionEntry,
  createSchedulerAdmissionEntry,
  listQueuedSchedulerAdmissionEntries,
  requireSchedulerAdmissionEntry,
} from './scheduler-records.js';
import { openCoreDb } from './storage/db.js';
import { applyMigrations } from './storage/migrate.js';

/** Supplies exact accepted command input at the existing admission boundary. */
function command(index = 0) {
  return {
    backendId: 'configured-backend',
    now: () => '2026-10-06T00:00:00.000Z',
    priorityClass: 'interactive' as const,
    queueEntryId: `queue_contract_${index}`,
    requestId: `command_contract_${index}`,
    requestedAgentId: 'agent_worker',
    requiredPoolConstraints: [],
    serverAdminTokenId: null as string | null,
    threadId: `thread_contract_${index}`,
    triggerActor: { kind: 'user' as const, id: 'user_local' },
    turnId: `turn_contract_${index}`,
    turnInput: '  Preserve the exact instruction.\nRun its focused checks.  ',
    workspaceId: 'workspace_contract',
  };
}

/** Opens a real fresh Core database; no runtime or provider is involved. */
function database() {
  const db = openCoreDb(mkdtempSync(join(tmpdir(), 'route-b-admission-')));
  applyMigrations(db);
  return db;
}

describe('route B exact admission (Durable Scheduler Design: Admission And Launch)', () => {
  it.each([
    'same-handle',
    'reload',
  ] as const)('replays the same command through %s without another admission or Turn', (mode) => {
    let db = database();
    try {
      const original = createSchedulerAdmissionEntry(db, command());
      if (mode === 'reload') {
        const root = db.dataRoot;
        db.sqlite.close();
        db = openCoreDb(root);
      }
      expect(createSchedulerAdmissionEntry(db, command())).toEqual(original);
      expect(listQueuedSchedulerAdmissionEntries(db)).toEqual([original]);
    } finally {
      db.sqlite.close();
    }
  });

  it.each([
    { name: 'instruction bytes', change: { turnInput: command().turnInput.trim() } },
    { name: 'request lineage', change: { threadId: 'another-thread' } },
    { name: 'Agent supply', change: { requestedAgentId: 'another-agent' } },
    { name: 'administrator provenance', change: { serverAdminTokenId: 'token_other' } },
    {
      name: 'trigger actor',
      change: { triggerActor: { kind: 'user' as const, id: 'other-user' } },
    },
  ])('refuses changed $name without mutating the accepted input', ({ change }) => {
    const db = database();
    try {
      const original = createSchedulerAdmissionEntry(db, command());
      expect(() =>
        createSchedulerAdmissionEntry(db, {
          backendId: 'nanohost',
          ...command(),
          ...change,
        })
      ).toThrow();
      expect(requireSchedulerAdmissionEntry(db, original.queueEntryId)).toEqual(original);
      expect(listQueuedSchedulerAdmissionEntries(db)).toEqual([original]);
    } finally {
      db.sqlite.close();
    }
  });

  it('orders equal-timestamp admissions by insertion and excludes cancelled work', () => {
    const db = database();
    try {
      // Lexical identity must not reorder an already committed FIFO.
      const first = createSchedulerAdmissionEntry(db, command(9));
      const cancelled = createSchedulerAdmissionEntry(db, command(5));
      const last = createSchedulerAdmissionEntry(db, command(1));
      cancelSchedulerAdmissionEntry(db, {
        queueEntryId: cancelled.queueEntryId,
        workspaceId: cancelled.workspaceId,
      });
      expect(listQueuedSchedulerAdmissionEntries(db).map((entry) => entry.queueEntryId)).toEqual([
        first.queueEntryId,
        last.queueEntryId,
      ]);
    } finally {
      db.sqlite.close();
    }
  });

  it('checks the default bound of 20 in insertion, while exact replay consumes no extra queue slot', () => {
    const db = database();
    try {
      for (let index = 0; index < 20; index += 1) createSchedulerAdmissionEntry(db, command(index));
      const original = requireSchedulerAdmissionEntry(db, command(0).queueEntryId);
      // The refusal oracle is the unchanged retained queue, before any dispatcher can run.
      expect(() => createSchedulerAdmissionEntry(db, command(20))).toThrow();
      expect(listQueuedSchedulerAdmissionEntries(db)).toHaveLength(20);
      expect(createSchedulerAdmissionEntry(db, command(0))).toEqual(original);
    } finally {
      db.sqlite.close();
    }
  });

  it.each([
    { goalId: null, kind: 'fresh' as const, taskId: null },
    {
      expectedRevision: 1,
      goalId: null,
      kind: 'selected' as const,
      purpose: 'work' as const,
      storageRef: `wst_${'1'.repeat(32)}`,
      taskId: null,
    },
  ])('reads inert stored storage-choice additions without changing $kind identity', (choice) => {
    const db = database();
    try {
      const original = createSchedulerAdmissionEntry(db, {
        backendId: 'nanohost',
        ...command(),
        workerStorageChoice: choice,
      });
      const retained = JSON.stringify({ ...choice, description: { note: 'retained annotation' } });
      db.sqlite
        .prepare(
          'UPDATE scheduler_admission_entries SET worker_storage_choice_json = ? WHERE queue_entry_id = ?'
        )
        .run(retained, original.queueEntryId);
      expect(requireSchedulerAdmissionEntry(db, original.queueEntryId)).toEqual(original);
      expect(
        db.sqlite
          .prepare(
            'SELECT worker_storage_choice_json AS bytes FROM scheduler_admission_entries WHERE queue_entry_id = ?'
          )
          .get(original.queueEntryId)
      ).toEqual({ bytes: retained });
    } finally {
      db.sqlite.close();
    }
  });

  it.each([
    { kind: 'future-choice', goalId: null, taskId: null },
    { kind: 'fresh', goalId: null, taskId: null, requiredFeatures: ['future-authority'] },
    {
      kind: 'selected',
      goalId: null,
      taskId: null,
      expectedRevision: 0,
      purpose: 'work',
      storageRef: `wst_${'1'.repeat(32)}`,
    },
  ])('refuses unknown or invalid required stored selection semantics %#', (choice) => {
    const db = database();
    try {
      const original = createSchedulerAdmissionEntry(db, command());
      const retained = JSON.stringify(choice);
      db.sqlite
        .prepare(
          'UPDATE scheduler_admission_entries SET worker_storage_choice_json = ? WHERE queue_entry_id = ?'
        )
        .run(retained, original.queueEntryId);
      expect(() => requireSchedulerAdmissionEntry(db, original.queueEntryId)).toThrow();
      expect(
        db.sqlite
          .prepare(
            'SELECT worker_storage_choice_json AS bytes FROM scheduler_admission_entries WHERE queue_entry_id = ?'
          )
          .get(original.queueEntryId)
      ).toEqual({ bytes: retained });
    } finally {
      db.sqlite.close();
    }
  });

  it('keeps authored storage selection exact at effect admission', () => {
    const db = database();
    try {
      const workerStorageChoice = {
        kind: 'fresh' as const,
        goalId: null,
        taskId: null,
        description: 'not authored command input',
      };
      expect(() =>
        createSchedulerAdmissionEntry(db, {
          backendId: 'nanohost',
          ...command(),
          workerStorageChoice,
        })
      ).toThrow();
      expect(listQueuedSchedulerAdmissionEntries(db)).toEqual([]);
    } finally {
      db.sqlite.close();
    }
  });
});
