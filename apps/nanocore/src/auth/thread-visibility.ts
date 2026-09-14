import { type ArtifactSchema, ThreadSchema } from '@openkit/protocol';

import { type FsStore, quickChatWorkspaceIdForUser } from '../lib/store.js';

type Artifact = import('zod').infer<typeof ArtifactSchema>;
type Thread = import('zod').infer<typeof ThreadSchema>;

/** Requires validated immutable audience and exact ownership after current Workspace authorization. */
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
  try {
    return isThreadVisible(
      store,
      store.getThread(artifact.workspaceId, artifact.origin.threadId),
      userId
    );
  } catch {
    return false;
  }
}
