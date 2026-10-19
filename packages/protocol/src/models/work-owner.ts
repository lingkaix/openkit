import { z } from 'zod';
import { WorkspaceIdSchema } from '../common/ids.js';

/** Immutable authority of narrative records; addressing inputs do not select another owner. */
export const WorkOwnerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('workspace'), workspaceId: WorkspaceIdSchema }),
  z.object({ kind: z.literal('server'), workspaceId: z.never().optional() }),
]);

/** Exactly one Workspace or the CoreServer owns each narrative record. */
export type WorkOwner = z.infer<typeof WorkOwnerSchema>;

/**
 * Reads Workspace addressing only from explicit Workspace authority.
 * @param owner Immutable record owner, or absent when the record itself is absent.
 * @returns The owning Workspace id; absent records remain absent.
 * @throws Error when a Workspace consumer receives Server-owned work.
 */
export function workspaceIdForOwner(owner: WorkOwner): string;
export function workspaceIdForOwner(owner: WorkOwner | undefined): string | undefined;
export function workspaceIdForOwner(owner: WorkOwner | undefined): string | undefined {
  if (owner === undefined) return undefined;
  if (owner.kind !== 'workspace') throw new Error('Workspace-owned work is required.');
  return owner.workspaceId;
}
