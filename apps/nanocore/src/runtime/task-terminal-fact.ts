import { isSealedTurnTerminal, TurnSchema } from '@openkit/protocol';
import { z } from 'zod';
import type { FsStore } from '../lib/store.js';
import type { WorkspaceDb } from '../storage/db.js';
import { advanceGoalRevision } from './goal-owner.js';

/** Minimal Task-owned result; canonical Turn files publish this already committed fact. */
export const TaskTerminalFactSchema = z.object({
  id: TurnSchema.shape.id,
  workspaceId: TurnSchema.shape.workspaceId,
  threadId: TurnSchema.shape.threadId,
  status: z.enum(['completed', 'failed', 'interrupted']),
  error: TurnSchema.shape.error,
  completedAt: TurnSchema.shape.completedAt,
  durationMs: TurnSchema.shape.durationMs,
});
/** Commits a linked Task terminal fact and its Goal wake together, exactly once. */
export function recordTaskTerminalFact(db: WorkspaceDb, turn: z.infer<typeof TurnSchema>): void {
  if (!isSealedTurnTerminal(turn.status)) return;
  const link = db.sqlite
    .prepare('SELECT goal_id FROM goal_card_tasks WHERE thread_id=?')
    .get(turn.threadId) as { goal_id: string } | undefined;
  if (!link) return;
  const bytes = JSON.stringify(TaskTerminalFactSchema.parse(turn));
  db.sqlite.transaction(() => {
    const prior = db.sqlite
      .prepare('SELECT payload_json FROM task_turn_terminal_facts WHERE turn_id=?')
      .get(turn.id) as { payload_json: string } | undefined;
    if (prior) {
      if (prior.payload_json !== bytes)
        throw new Error('Task terminal fact conflicts with its committed result.');
      return;
    }
    db.sqlite
      .prepare('INSERT INTO task_turn_terminal_facts VALUES (?,?,?)')
      .run(turn.id, turn.threadId, bytes);
    advanceGoalRevision(db, link.goal_id);
  })();
}
/** Finishes file publication after a crash; never asks a model to infer a Task result. */
export function recoverTaskTerminalFacts(store: FsStore, db: WorkspaceDb): void {
  for (const row of db.sqlite
    .prepare('SELECT payload_json FROM task_turn_terminal_facts')
    .all() as { payload_json: string }[]) {
    const fact = TaskTerminalFactSchema.parse(JSON.parse(row.payload_json));
    // Lost ordinary history stays an unresolved Task; recovery must not fabricate it.
    if (!store.listThreads(db.workspaceId).some((thread) => thread.id === fact.threadId)) continue;
    const turn = store
      .listThreadTurns(db.workspaceId, fact.threadId)
      .find((turn) => turn.id === fact.id);
    if (!turn) continue;
    if (turn.workspaceId !== fact.workspaceId || turn.threadId !== fact.threadId)
      throw new Error('Task terminal fact lineage conflicts with the Turn owner.');
    if (!isSealedTurnTerminal(turn.status))
      store.updateTurn(turn.id, {
        status: fact.status,
        error: fact.error,
        completedAt: fact.completedAt,
        durationMs: fact.durationMs,
      });
    else if (JSON.stringify(TaskTerminalFactSchema.parse(turn)) !== JSON.stringify(fact))
      throw new Error('Task terminal fact conflicts with its published result.');
  }
}
