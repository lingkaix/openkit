import { isDeepStrictEqual } from 'node:util';
import { type ArtifactSchema, ThreadSchema } from '@openkit/protocol';

import { type FsStore, quickChatWorkspaceIdForUser } from '../lib/store.js';

import {
  evaluateWorkspaceResourceAccess,
  type ResourcePolicyActor,
} from '../policy/workspace-resource-access.js';

type Artifact = import('zod').infer<typeof ArtifactSchema>;
type Thread = import('zod').infer<typeof ThreadSchema>;

/** Unique Thread audience predicate after Workspace eligibility; administrator eligibility must come from the current credential owner. */
export function isThreadVisible(
  store: Pick<FsStore, 'getWorkspace'> & Partial<Pick<FsStore, 'getWorkspaceResourceAccess'>>,
  thread: Thread,
  userId: string | undefined,
  administratorEligible = false,
  operation: string | null = 'thread.read',
  policyActor?: ResourcePolicyActor
): boolean {
  if (!userId || !ThreadSchema.safeParse(thread).success) return false;
  const workspace = store.getWorkspace(thread.workspaceId);
  if (
    !administratorEligible &&
    workspace.kind === 'personal' &&
    workspace.id !== quickChatWorkspaceIdForUser(userId)
  )
    return false;
  if (thread.visibility === 'private')
    return administratorEligible || thread.privateOwnerUserId === userId;
  if (operation === null) return true;
  try {
    return (
      evaluateWorkspaceResourceAccess({
        actor: policyActor ?? { kind: 'user', userId },
        eligible: true,
        resource: { family: 'thread', id: thread.id },
        operation,
        resourceAccess: store.getWorkspaceResourceAccess?.(thread.workspaceId) ?? [],
      }).effect === 'allow'
    );
  } catch {
    return false;
  }
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
  userId: string | undefined,
  administratorEligible = false,
  operation: string | null = 'thread.read',
  policyActor?: ResourcePolicyActor
): boolean {
  try {
    return isThreadVisible(
      store,
      store.getThread(workspaceId, threadId),
      userId,
      administratorEligible,
      operation,
      policyActor
    );
  } catch {
    return false;
  }
}

/** Resolves immutable Artifact origin before returning metadata from these read projections. */
export function isArtifactVisible(
  store: FsStore,
  artifact: Artifact,
  userId: string | undefined,
  administratorEligible = false
): boolean {
  if (!userId) return false;
  if (artifact.origin.kind === 'imported')
    return artifact.threadId === null && artifact.turnId === null;
  if (artifact.threadId !== artifact.origin.threadId || artifact.turnId !== artifact.origin.turnId)
    return false;
  return isThreadIdVisible(
    store,
    artifact.workspaceId,
    artifact.origin.threadId,
    userId,
    administratorEligible
  );
}

/** Preserves the source audience on product-managed transfers; matching Policy facts never grant source read authority. */
export function canDiscloseThreadToAudience(
  store: Pick<FsStore, 'getWorkspaceResourceAccess'>,
  source: Thread,
  destination: Thread | null
): boolean {
  if (destination && source.workspaceId !== destination.workspaceId) return false;
  if (destination?.id === source.id) return true;
  if (source.visibility === 'private')
    return (
      destination?.visibility === 'private' &&
      destination.privateOwnerUserId === source.privateOwnerUserId
    );
  try {
    const entries = store.getWorkspaceResourceAccess(source.workspaceId);
    const sourceBoundary = entries.find(
      (entry) => entry.resource.family === 'thread' && entry.resource.id === source.id
    );
    if (!sourceBoundary) return true;
    // A different or absent destination boundary cannot prove that the output retains these restrictions.
    const destinationBoundary =
      destination?.visibility === 'workspace'
        ? entries.find(
            (entry) => entry.resource.family === 'thread' && entry.resource.id === destination.id
          )
        : undefined;
    return Boolean(
      destinationBoundary &&
        isDeepStrictEqual(sourceBoundary.grants, destinationBoundary.grants) &&
        isDeepStrictEqual(sourceBoundary.prohibitions, destinationBoundary.prohibitions)
    );
  } catch {
    return false;
  }
}
