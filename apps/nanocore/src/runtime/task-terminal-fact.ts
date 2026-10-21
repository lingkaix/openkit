import { isDeepStrictEqual } from 'node:util';
import {
  isSealedTurnTerminal,
  readRetainedV1,
  type TurnSchema,
  workspaceIdForOwner,
  writeRetainedV1,
} from '@openkit/protocol';
import type { z } from 'zod';
import type { FsStore } from '../lib/store.js';
import type { WorkspaceDb } from '../storage/db.js';
import { advanceGoalRevision } from './goal-owner.js';
import { StoredGoalV1Schema, StoredTaskTerminalFactV1Schema } from './goal-retained-v1.js';

/** Minimal Task-owned result; terminal publication joins this fact to its owning native tuple. */
export const TaskTerminalFactSchema = StoredTaskTerminalFactV1Schema;
/** Joins a linked Task fact and Goal revision to the caller's existing native terminal transaction, or owns a standalone transaction for current non-product callers. */
export function recordTaskTerminalFact(
  db: Pick<WorkspaceDb, 'sqlite'>,
  turn: z.infer<typeof TurnSchema>
): void {
  if (!isSealedTurnTerminal(turn.status)) return;
  const commit = () => {
    const link = db.sqlite
      .prepare(
        'SELECT schema_version AS schemaVersion,goal_id FROM goal_card_tasks WHERE thread_id=?'
      )
      .get(turn.threadId) as { schemaVersion: unknown; goal_id: string } | undefined;
    if (!link) return;
    const goalId = readRetainedV1(link, () => link.goal_id);
    const fact = TaskTerminalFactSchema.parse({
      ...turn,
      workspaceId: workspaceIdForOwner(turn.owner),
    });
    const bytes = JSON.stringify(fact);
    const goal = db.sqlite
      .prepare('SELECT schema_version AS schemaVersion,payload_json FROM goals WHERE goal_id=?')
      .get(goalId) as { schemaVersion: unknown; payload_json: string } | undefined;
    if (!goal) throw new Error('Task terminal fact requires its linked Goal owner.');
    readRetainedV1(goal, () => StoredGoalV1Schema.parse(JSON.parse(goal.payload_json)));
    const prior = db.sqlite
      .prepare(
        'SELECT schema_version AS schemaVersion,payload_json FROM task_turn_terminal_facts WHERE turn_id=?'
      )
      .get(turn.id) as { schemaVersion: unknown; payload_json: string } | undefined;
    if (prior) {
      readRetainedV1(prior, () => {
        // Descriptive additions are not a different Task result and must keep their original retained bytes.
        if (!isDeepStrictEqual(TaskTerminalFactSchema.parse(JSON.parse(prior.payload_json)), fact))
          throw new Error('Task terminal fact conflicts with its committed result.');
      });
      return;
    }
    db.sqlite
      .prepare(
        'INSERT INTO task_turn_terminal_facts (turn_id,thread_id,payload_json,schema_version) VALUES (?,?,?,?)'
      )
      .run(turn.id, turn.threadId, bytes, writeRetainedV1({}).schemaVersion);
    advanceGoalRevision(db, goalId);
  };
  if (db.sqlite.inTransaction) commit();
  else db.sqlite.transaction(commit)();
}
/** Finishes file publication after a crash; never asks a model to infer a Task result. */
export function recoverTaskTerminalFacts(store: FsStore, db: WorkspaceDb): void {
  for (const row of db.sqlite
    .prepare('SELECT schema_version AS schemaVersion,payload_json FROM task_turn_terminal_facts')
    .all() as { schemaVersion: unknown; payload_json: string }[]) {
    const fact = readRetainedV1(row, () =>
      StoredTaskTerminalFactV1Schema.parse(JSON.parse(row.payload_json))
    );
    // Lost ordinary history stays an unresolved Task; recovery must not fabricate it.
    if (!store.listThreads(db.workspaceId).some((thread) => thread.id === fact.threadId)) continue;
    const turn = store
      .listThreadTurns(db.workspaceId, fact.threadId)
      .find((turn) => turn.id === fact.id);
    if (!turn) continue;
    if (workspaceIdForOwner(turn.owner) !== fact.workspaceId || turn.threadId !== fact.threadId)
      throw new Error('Task terminal fact lineage conflicts with the Turn owner.');
    if (!isSealedTurnTerminal(turn.status))
      store.updateTurn(turn.id, {
        status: fact.status,
        error: fact.error,
        completedAt: fact.completedAt,
        durationMs: fact.durationMs,
      });
    else if (
      JSON.stringify(
        TaskTerminalFactSchema.parse({ ...turn, workspaceId: workspaceIdForOwner(turn.owner) })
      ) !== JSON.stringify(fact)
    )
      throw new Error('Task terminal fact conflicts with its published result.');
  }
}
