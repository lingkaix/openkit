import type { ServerTurnEventEnvelope, Turn } from '@openkit/protocol';

/** Checks Server transcript lineage without granting authority from nested snapshots. */
export function assertServerTurnEventLineage(event: ServerTurnEventEnvelope, turn: Turn): void {
  if (
    event.owner.kind !== 'server' ||
    turn.owner.kind !== 'server' ||
    event.threadId !== turn.threadId ||
    event.turnId !== turn.id ||
    event.event !== event.data.type.replaceAll('-', '.')
  )
    throw new Error('Server event has invalid Turn lineage.');
  const data = event.data;
  const validTurn = (candidate: Turn) =>
    candidate.owner.kind === 'server' &&
    candidate.id === turn.id &&
    candidate.threadId === turn.threadId &&
    candidate.items.every(
      (item) =>
        item.owner.kind === 'server' && item.threadId === turn.threadId && item.turnId === turn.id
    );
  if (
    ('turnId' in data && data.turnId !== turn.id) ||
    ('thread' in data &&
      (data.thread.owner.kind !== 'server' || data.thread.id !== turn.threadId)) ||
    ('item' in data &&
      (data.item.owner.kind !== 'server' ||
        data.item.threadId !== turn.threadId ||
        data.item.turnId !== turn.id ||
        !turn.items.some((item) => item.id === data.item.id))) ||
    ('itemId' in data && !turn.items.some((item) => item.id === data.itemId)) ||
    ('turn' in data && !validTurn(data.turn))
  )
    throw new Error('Server event payload has invalid lineage.');
}
