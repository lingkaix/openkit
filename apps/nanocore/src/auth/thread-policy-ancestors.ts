import { ThreadSchema, workspaceIdForOwner } from '@openkit/protocol';
import type { FsStore } from '../lib/store.js';

type Thread = import('zod').infer<typeof ThreadSchema>;

/** Restores only native containment; malformed, missing, cyclic and cross-owner parents never widen scope. */
export function readThreadPolicyAncestors(
  store: Partial<Pick<FsStore, 'getThread'>>,
  addressed: Thread
): string[] {
  const workspaceId = workspaceIdForOwner(addressed.owner);
  const ancestors: string[] = [];
  const seen = new Set([addressed.id]);
  let thread = addressed;
  while (thread.parentThreadId) {
    const id = thread.parentThreadId;
    if (!store.getThread || seen.has(id)) throw new Error('Thread Policy lineage is unavailable.');
    seen.add(id);
    thread = ThreadSchema.parse(store.getThread(workspaceId, id));
    if (
      thread.id !== id ||
      thread.owner.kind !== 'workspace' ||
      workspaceIdForOwner(thread.owner) !== workspaceId
    )
      throw new Error('Thread Policy lineage belongs to another owner.');
    ancestors.push(id);
  }
  return ancestors;
}
