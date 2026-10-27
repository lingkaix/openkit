import { isDeepStrictEqual } from 'node:util';
import {
  type ArtifactSchema,
  compareCodeUnits,
  type ThreadSchema,
  workspaceIdForOwner,
} from '@openkit/protocol';
import { type FsStore, quickChatWorkspaceIdForUser } from '../lib/store.js';

import {
  evaluateThreadAuthorization,
  type ResourcePolicyActor,
} from '../policy/workspace-resource-access.js';

type Artifact = import('zod').infer<typeof ArtifactSchema>;
type Thread = import('zod').infer<typeof ThreadSchema>;

/** Unique Thread audience predicate after Workspace eligibility; administrator eligibility must come from the current credential owner. */
export function isThreadVisible(
  store: Pick<FsStore, 'getWorkspace' | 'getWorkspaceResourceAccess' | 'getDataRoot'>,
  thread: Thread,
  userId: string | undefined,
  administratorEligible = false,
  operation: string = 'thread.read',
  policyActor?: ResourcePolicyActor
): boolean {
  if (!userId) return false;
  try {
    if (thread.owner.kind !== 'workspace') return false;
    const workspaceId = workspaceIdForOwner(thread.owner);
    const workspace = store.getWorkspace(workspaceId);
    return (
      evaluateThreadAuthorization({
        thread,
        workspaceId,
        userId,
        administrator: administratorEligible,
        personalWorkspaceId:
          workspace.kind === 'personal'
            ? quickChatWorkspaceIdForUser(userId, store.getDataRoot())
            : undefined,
        operation,
        policy: store.getWorkspaceResourceAccess(workspaceId),
        actor: policyActor,
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
  operation: string = 'thread.read',
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
  administratorEligible = false,
  policyActor?: ResourcePolicyActor
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
    administratorEligible,
    'thread.read',
    policyActor
  );
}

/** Preserves the source audience on product-managed transfers; matching Policy facts never grant source read authority. */
// Deny-only audience containment stays here until Kernel support: GitHub #534 (after v0.1.0).
export function canDiscloseThreadToAudience(
  store: Pick<FsStore, 'getWorkspaceResourceAccess'>,
  source: Thread,
  destination: Thread | null
): boolean {
  if (source.owner.kind !== 'workspace' || (destination && destination.owner.kind !== 'workspace'))
    return false;
  if (destination && workspaceIdForOwner(source.owner) !== workspaceIdForOwner(destination.owner))
    return false;
  if (destination?.id === source.id) return true;
  if (source.visibility === 'private')
    return (
      destination?.visibility === 'private' &&
      destination.privateOwnerUserId === source.privateOwnerUserId
    );
  try {
    const document = store.getWorkspaceResourceAccess(workspaceIdForOwner(source.owner));
    const statementsFor = (threadId: string) =>
      document.statements.filter(
        (statement) =>
          statement.state === 'active' &&
          statement.scope.resources.some(
            (resource) =>
              resource.kind === 'container' &&
              resource.container.kind === 'thread' &&
              resource.container.id === threadId
          )
      );
    const sourceStatements = statementsFor(source.id);
    if (!sourceStatements.some((statement) => statement.kind === 'managed-boundary')) return true;
    if (destination?.visibility !== 'workspace') return false;
    const destinationStatements = statementsFor(destination.id);
    if (!destinationStatements.some((statement) => statement.kind === 'managed-boundary'))
      return false;
    // Compare effective recipient/operation restrictions, excluding ids and attributable authorship.
    const restrictions = (statements: typeof sourceStatements) =>
      statements
        .flatMap((statement) =>
          statement.kind === 'permission'
            ? [
                {
                  effect: statement.effect,
                  subjects: statement.scope.subjects,
                  actions: statement.scope.actions,
                  grant: statement.grant,
                },
              ]
            : []
        )
        .sort((left, right) => compareCodeUnits(JSON.stringify(left), JSON.stringify(right)));
    return isDeepStrictEqual(restrictions(sourceStatements), restrictions(destinationStatements));
  } catch {
    return false;
  }
}
