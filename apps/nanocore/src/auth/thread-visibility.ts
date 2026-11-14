import {
  type ArtifactSchema,
  canonicalIdentifierName,
  type ThreadSchema,
  workspaceIdForOwner,
} from '@openkit/protocol';
import { type FsStore, quickChatWorkspaceIdForUser } from '../lib/store.js';
import {
  evaluateThreadAuthorization,
  evaluateWorkspaceResourceAccess,
  parseWorkspacePolicy,
  type ResourcePolicyActor,
  workspacePolicySubject,
} from '../policy/workspace-resource-access.js';
import type { CoreDb } from '../storage/db.js';
import { resolvePersonalWorkspaceIdInDb } from '../storage/workspace-owner-records.js';

type Artifact = import('zod').infer<typeof ArtifactSchema>;
type Thread = import('zod').infer<typeof ThreadSchema>;

/** Canonical product and loaded-Policy reads used by both Main and native visibility checks. */
export type ThreadVisibilityReadPort = Pick<
  FsStore,
  'getWorkspaceResourceAccess' | 'getDataRoot' | 'getThread'
> & {
  /** Visibility needs canonical Workspace kind, not aggregate product counts. */
  getWorkspace(workspaceId: string): Pick<ReturnType<FsStore['getWorkspace']>, 'kind'>;
  /** Native readers borrow the actual Core instead of opening it inside their deciding SQL. */
  readonly personalWorkspaceCore?: Pick<CoreDb, 'sqlite'>;
};

/** Unique Thread audience predicate after Workspace eligibility; administrator eligibility must come from the current credential owner. */
export function isThreadVisible(
  store: Pick<
    ThreadVisibilityReadPort,
    'getWorkspace' | 'getWorkspaceResourceAccess' | 'getDataRoot' | 'personalWorkspaceCore'
  >,
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
            ? store.personalWorkspaceCore
              ? resolvePersonalWorkspaceIdInDb(store.personalWorkspaceCore, userId)
              : quickChatWorkspaceIdForUser(userId, store.getDataRoot())
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
  store: ThreadVisibilityReadPort,
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
    const workspaceId = workspaceIdForOwner(source.owner);
    const document = parseWorkspacePolicy(
      workspaceId,
      store.getWorkspaceResourceAccess(workspaceId)
    );
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
    // Managed recipients are finite: an unlisted User or Agent has no positive allocation,
    // including administrators. Probe every destination allocation/right through the Kernel;
    // splitting statements or adding a prohibition cannot manufacture a wider audience.
    const actors = new Map<string, ResourcePolicyActor>();
    const operations = new Set<string>();
    for (const statement of destinationStatements) {
      if (statement.kind !== 'permission' || statement.effect !== 'allow') continue;
      const recipient = workspacePolicySubject(statement);
      if (!recipient) return false;
      actors.set(
        canonicalIdentifierName(recipient),
        recipient.kind === 'user'
          ? recipient
          : {
              ...recipient,
              // A transient NGAC witness, not an authenticated run, Turn or retained identity.
              processId: 'audience-containment',
            }
      );
      for (const operation of statement.scope.actions) operations.add(operation);
    }
    for (const actor of actors.values()) {
      for (const operation of operations) {
        const evaluate = (threadId: string) =>
          evaluateWorkspaceResourceAccess({
            actor,
            administrator: false,
            visibility: 'workspace',
            workspaceId,
            policy: document,
            resource: { family: 'thread', id: threadId },
            operation,
          });
        const recipient = evaluate(destination.id);
        if (
          recipient.reasons.some(
            (reason) => reason.code === 'invalid-policy' || reason.code === 'invalid-request'
          )
        )
          return false;
        if (recipient.effect === 'allow' && evaluate(source.id).effect !== 'allow') return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}
