import { type ArtifactSchema, ThreadSchema } from '@openkit/protocol';

import { type FsStore, quickChatWorkspaceIdForUser } from '../lib/store.js';

type Artifact = import('zod').infer<typeof ArtifactSchema>;
type Thread = import('zod').infer<typeof ThreadSchema>;

/** Unique Thread audience predicate applied after current Workspace eligibility. */
export function isThreadVisible(
  store: FsStore,
  thread: Thread,
  userId: string | undefined
): boolean {
  if (!userId || !ThreadSchema.safeParse(thread).success) return false;
  const workspace = store.getWorkspace(thread.workspaceId);
  if (
    workspace.kind === 'quick-chat' &&
    (thread.visibility !== 'private' || workspace.id !== quickChatWorkspaceIdForUser(userId))
  )
    return false;
  return thread.visibility === 'workspace' || thread.privateOwnerUserId === userId;
}

/**
 * Loads one Thread by Workspace and id, then applies `isThreadVisible`.
 *
 * Missing and corrupt owners fail closed as not visible. Callers that already hold a Thread
 * record should keep using `isThreadVisible`.
 *
 * @param store Product store that owns Thread records.
 * @param workspaceId Canonical Workspace id.
 * @param threadId Thread id to load.
 * @param userId Authenticated viewer, or undefined when no actor is present.
 * @returns True only when the Thread exists in that Workspace and the viewer may see it.
 */
export function isThreadIdVisible(
  store: FsStore,
  workspaceId: string,
  threadId: string,
  userId: string | undefined
): boolean {
  try {
    return isThreadVisible(store, store.getThread(workspaceId, threadId), userId);
  } catch {
    return false;
  }
}

/** Resolves immutable Artifact origin before returning metadata from these read projections. */
export function isArtifactVisible(
  store: FsStore,
  artifact: Artifact,
  userId: string | undefined
): boolean {
  if (!userId) return false;
  if (artifact.origin.kind === 'imported')
    return artifact.threadId === null && artifact.turnId === null;
  if (artifact.threadId !== artifact.origin.threadId || artifact.turnId !== artifact.origin.turnId)
    return false;
  return isThreadIdVisible(store, artifact.workspaceId, artifact.origin.threadId, userId);
}
