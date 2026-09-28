import type { FsStore } from '../lib/store.js';

/** Creates a completed user Turn and immutable initial Goal objective Item for tests. */
export function createInitialGoalIntentItem(input: {
  readonly store: FsStore;
  readonly workspaceId: string;
  readonly threadId: string;
  readonly objective: string;
  readonly userId: string;
  readonly at?: string;
}): string {
  const actor = { kind: 'user', id: input.userId } as const;
  const completedAt = input.at ?? '2026-01-01T00:00:00.000Z';
  const turn = input.store.createTurn(
    input.workspaceId,
    input.threadId,
    input.objective,
    actor,
    null,
    {
      startedAt: completedAt,
    }
  );
  const item = input.store.createItem({
    id: `it_goal_intent_${turn.id}`,
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    turnId: turn.id,
    type: 'user-message',
    status: 'completed',
    actor,
    text: input.objective,
    createdAt: completedAt,
    completedAt,
  });
  input.store.updateTurn(turn.id, { status: 'completed', completedAt });
  return item.id;
}
