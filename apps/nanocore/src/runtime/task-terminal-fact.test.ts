import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { FsStore } from '../lib/store.js';
import { openWorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import { executeGoalOperation, readGoalView } from './goal-owner.js';
import { recordTaskTerminalFact, recoverTaskTerminalFacts } from './task-terminal-fact.js';

/** The retained association supplies terminal wake lineage; this fixture admits no Worker. */
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'task-terminal-format-'));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const store = new FsStore({ dataRoot: root });
  const workspace = store.createWorkspace('Terminal format');
  const db = openWorkspaceDb(root, workspace.id);
  onTestFinished(() => db.sqlite.close());
  applyScopedMigrations(db);
  const view = await executeGoalOperation(
    'goal.create',
    {
      workspaceId: workspace.id,
      requestId: '99999999-9999-4999-8999-999999999999',
      intent: 'Design',
    },
    { actor: { kind: 'local', userId: 'usr_00000000-0000-7000-8000-000000000001' } },
    store,
    db
  );
  const goalId = view.goal!.goalId;
  const task = store.createThread(workspace.id, 'Task');
  db.sqlite
    .prepare(
      'INSERT INTO goal_card_tasks (thread_id,goal_id,card_id,payload_json,schema_version) VALUES (?,?,?,?,1)'
    )
    .run(
      task.id,
      goalId,
      'gc_terminal',
      JSON.stringify({
        goalId,
        cardId: 'gc_terminal',
        threadId: task.id,
        planVersionId: 'gp_terminal',
        cardRevision: 0,
      })
    );
  const turn = store.createTurn(workspace.id, task.id, 'Design', {
    kind: 'user',
    id: 'usr_00000000-0000-7000-8000-000000000001',
  });
  const terminal = {
    ...turn,
    status: 'completed' as const,
    completedAt: new Date().toISOString(),
    durationMs: 0,
  };
  return { root, store, db, goalId, turn, terminal };
}

describe('retained Task terminal fact format', () => {
  it('writes v1 and recovers the result while preserving descriptive fact bytes', async () => {
    const f = await fixture();
    recordTaskTerminalFact(f.db, f.terminal);
    const row = f.db.sqlite
      .prepare('SELECT schema_version AS schemaVersion, payload_json FROM task_turn_terminal_facts')
      .get() as { schemaVersion: number; payload_json: string };
    expect(row.schemaVersion).toBe(1);
    const annotatedBytes = JSON.stringify({
      ...JSON.parse(row.payload_json),
      futureNote: 'retained',
    });
    f.db.sqlite.prepare('UPDATE task_turn_terminal_facts SET payload_json=?').run(annotatedBytes);
    const reopened = new FsStore({ dataRoot: f.root });

    recoverTaskTerminalFacts(reopened, f.db);
    expect(reopened.getTurnById(f.turn.id)).toMatchObject({
      status: 'completed',
      error: null,
      completedAt: f.terminal.completedAt,
      durationMs: 0,
    });
    expect(f.db.sqlite.prepare('SELECT payload_json FROM task_turn_terminal_facts').get()).toEqual({
      payload_json: annotatedBytes,
    });
  });

  it('refuses an unknown version before malformed JSON, repeat publication or recovery', async () => {
    const f = await fixture();
    recordTaskTerminalFact(f.db, f.terminal);
    const before = readGoalView(f.store, f.db, f.goalId).goal!.changeRevision;
    f.db.sqlite
      .prepare('UPDATE task_turn_terminal_facts SET schema_version=2,payload_json=?')
      .run('{');

    expect(() => recoverTaskTerminalFacts(f.store, f.db)).toThrow(
      'Unsupported retained record format.'
    );
    expect(() => recordTaskTerminalFact(f.db, f.terminal)).toThrow(
      'Unsupported retained record format.'
    );
    expect(f.store.getTurnById(f.turn.id).status).toBe('running');
    expect(readGoalView(f.store, f.db, f.goalId).goal!.changeRevision).toBe(before);
    expect(
      f.db.sqlite
        .prepare(
          'SELECT schema_version AS schemaVersion,payload_json FROM task_turn_terminal_facts'
        )
        .get()
    ).toEqual({ schemaVersion: 2, payload_json: '{' });
  });
});
