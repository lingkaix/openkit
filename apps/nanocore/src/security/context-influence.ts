import type { ActorRef, Item } from '@openkit/protocol';
import type { FsStore } from '../lib/store.js';
import { StoreRecordNotFoundError } from '../lib/store-errors.js';

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

/** Resolves the trusted native context without treating Server Turns as Workspace history. */
export function readContextInfluenceTurn(store: FsStore, turnId: string) {
  try {
    return store.getServerTurnById(turnId);
  } catch (error) {
    if (!(error instanceof StoreRecordNotFoundError)) throw error;
    return store.getTurnById(turnId);
  }
}

/** Commits inherited influence before governed source content reaches an executing context. */
export async function receiveContextInfluence(
  input: {
    readonly store: FsStore;
    readonly outputThreadId?: string | undefined;
    readonly outputTurnId?: string | undefined;
  },
  metadata: { readonly externallyInfluenced?: boolean | undefined }
): Promise<void> {
  if (!input.outputTurnId || !contextIsExternallyInfluenced(metadata)) return;
  const turn = readContextInfluenceTurn(input.store, input.outputTurnId);
  if (turn.threadId !== input.outputThreadId)
    throw new Error('Receiving context is contradictory.');
  if (turn.externallyInfluenced === true) return;
  if (turn.owner.kind === 'server')
    await input.store.updateServerTurn(turn.id, { externallyInfluenced: true });
  else await input.store.updateTurn(turn.id, { externallyInfluenced: true });
}
