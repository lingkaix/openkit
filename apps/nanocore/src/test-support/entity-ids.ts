import { allocateEntityId, type EntityKind } from '@openkit/protocol';

const ids = new Map<string, string>();

/**
 * Allocates one process-local fixture identity for a named synthetic record.
 * The fixture key is not a production derivation or replay authority; process-boundary fixtures pass their recorded IDs explicitly.
 *
 * @param kind Entity kind admitted by the shared codec.
 * @param key Fixture-local key shared by setup and assertions.
 * @returns The original allocation for this kind and fixture key.
 */
export function testEntityId(kind: EntityKind, key: string): string {
  const mapKey = `${kind}:${key}`;
  const recorded = ids.get(mapKey);
  if (recorded) return recorded;
  const id = allocateEntityId(kind);
  ids.set(mapKey, id);
  return id;
}
