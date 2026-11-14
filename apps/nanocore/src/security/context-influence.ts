import type { ActorRef, Item } from '@openkit/protocol';

/** Missing ancestry is unknown/influenced, not a newly established clear context. */
export function contextIsExternallyInfluenced(context: {
  externallyInfluenced?: unknown;
}): boolean {
  return context.externallyInfluenced !== false;
}

/** A lifecycle replacement may not turn unknown/true into false, or erase retained true. */
export function contextInfluenceWasCleared(
  before: { externallyInfluenced?: unknown },
  after: { externallyInfluenced?: unknown }
): boolean {
  return (
    (contextIsExternallyInfluenced(before) && after.externallyInfluenced === false) ||
    (before.externallyInfluenced === true && after.externallyInfluenced !== true)
  );
}

/** Current and frozen retained Items share only these receiving facts; no release-coupled decoding. */
type ReceivedItem = Pick<Item, 'ingress' | 'type' | 'status'> & {
  actor?: Pick<ActorRef, 'kind' | 'id'>;
};

/** Classifies an actual received Item; Tool arguments alone are not a received result. */
export function receivedItemInfluences(
  item: ReceivedItem,
  owner: Pick<ActorRef, 'kind' | 'id'>
): boolean {
  if (item.ingress === undefined || item.ingress === 'import') return true;
  if (item.type === 'tool-call' || item.type === 'command-execution')
    return item.status !== 'in_progress';
  if (item.ingress === 'remote-mcp' || item.ingress === 'tool') return true;
  if (item.ingress === 'api' || item.ingress === 'channel') {
    return !(
      item.type === 'user-message' &&
      owner.kind === 'user' &&
      item.actor?.kind === 'user' &&
      item.actor.id === owner.id
    );
  }
  // Ordinary model output does not independently taint a known-clear source context.
  // Core/Provider derivatives still inherit their actual source context through its owner.
  return false;
}
