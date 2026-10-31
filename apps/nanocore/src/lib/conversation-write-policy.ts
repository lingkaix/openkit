import { isDeepStrictEqual } from 'node:util';
import type { Item, Turn, TurnStatus } from '@openkit/protocol';

/**
 * Returns whether one Item's display fields match a named projection.
 *
 * @param item Recorded Item.
 * @param projection Candidate level, title, and summary.
 * @returns True when those three display fields already match.
 */
export function displayProjectionFieldsEqual(
  item: Item,
  projection: { readonly level: unknown; readonly title: unknown; readonly summary: unknown }
): boolean {
  const recorded = item as unknown as Record<string, unknown>;
  return (
    recorded.level === projection.level &&
    recorded.title === projection.title &&
    recorded.summary === projection.summary
  );
}

/**
 * Returns whether a terminal completion stopReason matches a sealed Turn status.
 *
 * @param stopReason Event stopReason.
 * @param status Sealed Turn status.
 * @returns True when the pair is the already-decided terminal mapping.
 */
export function stopReasonMatchesSealedStatus(stopReason: unknown, status: TurnStatus): boolean {
  if (status === 'completed') {
    return (
      stopReason === 'completed' || stopReason === 'length' || stopReason === 'budget_exhausted'
    );
  }
  if (status === 'failed') {
    return stopReason === 'error';
  }
  if (status === 'cancelled' || status === 'interrupted') {
    return stopReason === 'aborted';
  }
  return false;
}

/**
 * Returns whether a parsed Turn rewrite would change already-set decided fields.
 *
 * @param current Recorded terminal Turn.
 * @param next Candidate merged Turn.
 * @returns True when an already-set decided field would change.
 */
export function decidedTurnFieldsConflict(current: Turn, next: Turn): boolean {
  if (next.status !== current.status) {
    return true;
  }
  const keys = [
    'error',
    'completedAt',
    'agentId',
    'agentProfileId',
    'agentSessionId',
    'triggerSource',
    'configVersion',
  ] as const;
  for (const key of keys) {
    const recorded = current[key];
    if (recorded !== undefined && recorded !== null && !isDeepStrictEqual(recorded, next[key])) {
      return true;
    }
  }
  return false;
}

/**
 * Creates the rejection for a new write against a sealed-terminal Turn.
 *
 * @param turnId Terminal Turn id.
 * @returns Error for a write that is not an admitted post-terminal publication.
 */
export function terminalTurnWriteRejected(turnId: string): Error {
  return new Error(`Turn ${turnId} is terminal and does not admit this write.`);
}

/**
 * Creates the rejection for a conflicting publication against a sealed-terminal Turn.
 *
 * @param turnId Terminal Turn id.
 * @returns Error for a publication that disagrees with already-decided bytes.
 */
export function terminalTurnPublicationConflict(turnId: string): Error {
  return new Error(
    `Turn ${turnId} is terminal and the publication conflicts with the already-decided record.`
  );
}
