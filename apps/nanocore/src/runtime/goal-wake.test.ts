import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { FsStore } from '../lib/store.js';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { executeGoalOperation, readGoalView } from './goal-owner.js';
import { installPendingRequestAdmission } from './pending-request-flow.js';
import { recordTaskTerminalFact, recoverTaskTerminalFacts } from './task-terminal-fact.js';

describe('Task terminal and Goal wake shared commit', () => {
  it('commits the terminal fact and one wake revision through the installed production hook', async () => {
    const root = mkdtempSync(join(tmpdir(), 'goal-terminal-hook-'));
    const core = openCoreDb(root);
    applyMigrations(core);
    core.sqlite.close();
    const store = new FsStore({ dataRoot: root });
    const ws = await store.createWorkspace('Terminal hook');
    let db = openWorkspaceDb(root, ws.id);
    applyScopedMigrations(db);
    try {
      const view = await executeGoalOperation(
        'goal.create',
        { workspaceId: ws.id, requestId: '66666666-6666-4666-8666-666666666666', intent: 'Design' },
        { actor: { kind: 'local', userId: 'usr_00000000-0000-7000-8000-000000000001' } },
        store,
        db
      );
      const goal = view.goal!;
      const task = await store.createThread(ws.id, 'Task');
      db.sqlite
        .prepare(
          'INSERT INTO goal_card_tasks (thread_id,goal_id,card_id,payload_json) VALUES (?,?,?,?)'
        )
        .run(
          task.id,
          goal.goalId,
          'gc_hook',
          JSON.stringify({
            goalId: goal.goalId,
            cardId: 'gc_hook',
            threadId: task.id,
            planVersionId: 'gp_hook',
            cardRevision: 0,
            admittedAt: new Date().toISOString(),
          })
        );
      const turn = await store.createTurn(ws.id, task.id, 'Design', {
        kind: 'user',
        id: 'usr_00000000-0000-7000-8000-000000000001',
      });
      installPendingRequestAdmission(store, {
        openWorkspace: (workspaceId) => openWorkspaceDb(root, workspaceId),
      });
      const before = readGoalView(store, db, goal.goalId).goal!.changeRevision;
      expect(db.sqlite.prepare('SELECT * FROM task_turn_terminal_facts').all()).toEqual([]);
      const completed = await store.updateTurn(turn.id, {
        status: 'completed',
        completedAt: new Date().toISOString(),
      });
      await store.updateTurn(turn.id, { status: 'completed', completedAt: completed.completedAt });
      db.sqlite.close();
      db = openWorkspaceDb(root, ws.id);
      applyScopedMigrations(db);
      expect(db.sqlite.prepare('SELECT * FROM task_turn_terminal_facts').all()).toEqual([
        {
          schema_version: 1,
          turn_id: turn.id,
          thread_id: task.id,
          payload_json: JSON.stringify({
            id: turn.id,
            workspaceId: ws.id,
            threadId: task.id,
            status: 'completed',
            error: completed.error,
            completedAt: completed.completedAt,
            durationMs: completed.durationMs,
          }),
        },
      ]);
      const reopened = new FsStore({ dataRoot: root });
      expect(reopened.getTurnById(turn.id).status).toBe('completed');
      expect(readGoalView(reopened, db, goal.goalId).goal).toMatchObject({
        changeRevision: before + 1,
        disposition: null,
      });
      await recoverTaskTerminalFacts(reopened, db);
      expect(readGoalView(reopened, db, goal.goalId).goal!.changeRevision).toBe(before + 1);
    } finally {
      db.sqlite.close();
    }
  });
  it('survives closing and reopening SQLite and leaves the Goal open', async () => {
    const root = mkdtempSync(join(tmpdir(), 'goal-wake-'));
    const absentRoot = mkdtempSync(join(tmpdir(), 'goal-wake-absent-history-'));
    let core: ReturnType<typeof openCoreDb> | undefined;
    let db: ReturnType<typeof openWorkspaceDb> | undefined;
    onTestFinished(async () => {
      if (db?.sqlite.open) db.sqlite.close();
      if (core?.sqlite.open) core.sqlite.close();
      await shutdownControlStoreWorkerClient();
      rmSync(absentRoot, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    });
    core = openCoreDb(root);
    applyMigrations(core);
    core.sqlite.close();
    const store = new FsStore({ dataRoot: root });
    const ws = await store.createWorkspace('Wake');
    // Retain valid empty authority before the original Goal and Task history exists.
    await shutdownControlStoreWorkerClient();
    cpSync(root, absentRoot, { recursive: true });
    db = openWorkspaceDb(root, ws.id);
    applyScopedMigrations(db);
    const view = await executeGoalOperation(
      'goal.create',
      { workspaceId: ws.id, requestId: '99999999-9999-4999-8999-999999999999', intent: 'Design' },
      { actor: { kind: 'local', userId: 'usr_00000000-0000-7000-8000-000000000001' } },
      store,
      db
    );
    const goal = view.goal!;
    const task = await store.createThread(ws.id, 'Task');
    db.sqlite
      .prepare(
        'INSERT INTO goal_card_tasks (thread_id,goal_id,card_id,payload_json) VALUES (?,?,?,?)'
      )
      .run(
        task.id,
        goal.goalId,
        'gc_1',
        JSON.stringify({
          goalId: goal.goalId,
          cardId: 'gc_1',
          threadId: task.id,
          planVersionId: 'gp_1',
          cardRevision: 2,
          admittedAt: new Date().toISOString(),
        })
      );
    const turn = await store.createTurn(ws.id, task.id, 'Design', {
      kind: 'user',
      id: 'usr_00000000-0000-7000-8000-000000000001',
    });
    const terminal = {
      ...turn,
      status: 'completed' as const,
      completedAt: '2026-10-03T00:00:00.000Z',
      durationMs: turn.startedAt
        ? Math.max(0, Date.parse('2026-10-03T00:00:00.000Z') - Date.parse(turn.startedAt))
        : null,
    };
    const before = readGoalView(store, db, goal.goalId).goal!.changeRevision;
    recordTaskTerminalFact(db, terminal);
    db.sqlite.close();
    db = openWorkspaceDb(root, ws.id);
    applyScopedMigrations(db);
    try {
      expect(
        db.sqlite
          .prepare('SELECT turn_id FROM task_turn_terminal_facts WHERE turn_id=?')
          .get(turn.id)
      ).toEqual({ turn_id: turn.id });
      const restarted = new FsStore({ dataRoot: root });
      expect(restarted.getTurnById(turn.id).status).toBe('running');
      await recoverTaskTerminalFacts(restarted, db);
      expect(restarted.getTurnById(turn.id).status).toBe('completed');
      await recoverTaskTerminalFacts(restarted, db);
      const absentHistory = new FsStore({ dataRoot: absentRoot });
      await recoverTaskTerminalFacts(absentHistory, db);
      expect(absentHistory.listThreads(ws.id)).toEqual([]);
      const recovered = readGoalView(store, db, goal.goalId).goal!;
      expect(recovered.changeRevision).toBe(before + 1);
      expect(recovered.disposition).toBeNull();
      recordTaskTerminalFact(db, terminal);
      expect(readGoalView(store, db, goal.goalId).goal!.changeRevision).toBe(before + 1);
    } finally {
      db.sqlite.close();
    }
  });
});

import { considerGoal } from './goal-coordinator.js';

describe('Coordinator marker admission', () => {
  it('admits one ordinary Turn and acknowledges only its read revision', async () => {
    const root = mkdtempSync(join(tmpdir(), 'goal-turn-'));
    const core = openCoreDb(root);
    applyMigrations(core);
    core.sqlite.close();
    const store = new FsStore({ dataRoot: root });
    const ws = await store.createWorkspace('Coordinator wake');
    const db = openWorkspaceDb(root, ws.id);
    applyScopedMigrations(db);
    try {
      const view = await executeGoalOperation(
        'goal.create',
        { workspaceId: ws.id, requestId: '88888888-8888-4888-8888-888888888888', intent: 'Design' },
        { actor: { kind: 'local', userId: 'usr_00000000-0000-7000-8000-000000000001' } },
        store,
        db
      );
      const goal = view.goal!;
      const turn = await considerGoal(store, db, goal.goalId);
      expect(turn?.agentId).toBe('goal-coordinator');
      expect(turn?.agentSessionId).toBeUndefined();
      expect(await considerGoal(store, db, goal.goalId)).toBeNull();
      await executeGoalOperation(
        'goal.intent.revise',
        {
          workspaceId: ws.id,
          threadId: goal.threadId,
          goalId: goal.goalId,
          requestId: '77777777-7777-4777-8777-777777777777',
          intent: 'Design only',
          expectedRevision: 0,
        },
        { actor: { kind: 'local', userId: 'usr_00000000-0000-7000-8000-000000000001' } },
        store,
        db
      );
      expect(readGoalView(store, db, goal.goalId).goal!.consideredRevision).toBe(
        goal.changeRevision
      );
      expect(await considerGoal(store, db, goal.goalId)).toBeNull();
      await store.updateTurn(turn!.id, {
        status: 'completed',
        completedAt: new Date().toISOString(),
      });
      const next = await considerGoal(store, db, goal.goalId);
      expect(next?.agentId).toBe('goal-coordinator');
      await store.updateTurn(next!.id, {
        status: 'failed',
        completedAt: new Date().toISOString(),
        error: { code: 'provider_unavailable', message: 'Provider unavailable.' },
      });
      expect(await considerGoal(store, db, goal.goalId)).toBeNull();
      expect(readGoalView(store, db, goal.goalId).goal!.disposition).toBeNull();
    } finally {
      db.sqlite.close();
    }
  });
});
