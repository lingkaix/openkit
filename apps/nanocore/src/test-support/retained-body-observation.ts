import { vi } from 'vitest';

/** Counts actual decoded retained Item bodies, independently of their byte storage. */
export interface RetainedBodyObservation {
  itemIds: ReadonlySet<string>;
  bodies: number;
}

/**
 * Observes the public JSON decoder without replacing storage reads or their results.
 * Exact Item identities and the retained header exclude descriptors and API projections.
 * This observes only decodes in the current JavaScript realm, not native worker reads.
 */
export function observeRetainedItemBodies(observed: RetainedBodyObservation) {
  const bodyReads = new Map<string, { count: number; byteLength: number }>();
  const parse = JSON.parse;
  const spy = vi
    .spyOn(JSON, 'parse')
    .mockImplementation((...args: Parameters<typeof JSON.parse>) => {
      const value = Reflect.apply(parse, JSON, args);
      if (value && typeof value === 'object' && 'schemaVersion' in value) {
        const id = value.id;
        if (typeof id === 'string' && observed.itemIds.has(id)) {
          observed.bodies++;
          bodyReads.set(id, {
            count: (bodyReads.get(id)?.count ?? 0) + 1,
            byteLength: Buffer.byteLength(args[0], 'utf8'),
          });
        }
      }
      return value;
    });
  return { bodyReads, restore: () => spy.mockRestore() };
}
