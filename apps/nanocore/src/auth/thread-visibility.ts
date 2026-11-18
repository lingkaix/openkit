import { parseWorkspacePolicyDocument, workspacePolicyRecipient } from '@openkit/config-schema';
import {
  type ArtifactSchema,
  canonicalIdentifierName,
  ThreadSchema,
  workspaceIdForOwner,
} from '@openkit/protocol';
import { type FsStore, quickChatWorkspaceIdForUser } from '../lib/store.js';
import { evaluatePolicyKernel, selectThreadBoundaries } from '../policy/workspace-access.js';
import type { CoreDb } from '../storage/db.js';
import { resolvePersonalWorkspaceIdInDb } from '../storage/workspace-owner-records.js';
import type { ThreadPolicyActor } from './identity.js';
import { readThreadPolicyAncestors } from './thread-policy-ancestors.js';

export { readThreadPolicyAncestors } from './thread-policy-ancestors.js';

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

/** Collects validated native Thread facts; the shared Kernel alone evaluates them. */
export function readThreadPolicyFacts(input: {
  readonly thread: Thread;
  readonly workspaceId: string;
  readonly userId: string;
  readonly administrator: boolean;
  readonly personalWorkspaceId?: string | undefined;
  readonly policy: unknown;
  readonly operation: string;
  readonly actor?: ThreadPolicyActor | undefined;
  /** Same-Workspace ancestors restored by the native Thread reader, nearest first. */
  readonly ancestorThreadIds?: readonly string[];
  /** Exact current native MCP conditions; these ids can only restrict Tool use. */
  readonly toolProhibitions?: readonly string[];
}): Extract<Parameters<typeof evaluatePolicyKernel>[0], { readonly thread: unknown }> {
  if (
    !input.userId ||
    !ThreadSchema.safeParse(input.thread).success ||
    input.thread.visibility === 'server' ||
    input.thread.owner.kind !== 'workspace' ||
    workspaceIdForOwner(input.thread.owner) !== input.workspaceId ||
    (input.actor && input.actor.userId !== input.userId)
  )
    throw new Error('Thread authorization requires exact current audience and actor facts.');
  const ancestors = input.ancestorThreadIds ?? [];
  if (
    (input.thread.parentThreadId ?? undefined) !== ancestors[0] ||
    new Set([input.thread.id, ...ancestors]).size !== ancestors.length + 1
  )
    throw new Error('Thread Policy lineage is unavailable.');
  return {
    thread: {
      workspaceId: input.workspaceId,
      actor: input.actor ?? { kind: 'user', userId: input.userId },
      administrator: input.administrator,
      visibility: input.thread.visibility,
      privateOwnerUserId: input.thread.privateOwnerUserId,
      personalWorkspaceId: input.personalWorkspaceId,
      policy: input.policy,
      resource: { family: 'thread', id: input.thread.id, ancestors },
      operation: input.operation,
      toolProhibitions: input.toolProhibitions ?? [],
    },
  };
}

/** Unique Thread audience predicate after Workspace eligibility; administrator eligibility must come from the current credential owner. */
export function isThreadVisible(
  store: Pick<
    ThreadVisibilityReadPort,
    'getWorkspace' | 'getWorkspaceResourceAccess' | 'getDataRoot' | 'personalWorkspaceCore'
  > &
    Partial<Pick<ThreadVisibilityReadPort, 'getThread'>>,
  thread: Thread,
  userId: string | undefined,
  administratorEligible = false,
  operation: string = 'thread.read',
  policyActor?: ThreadPolicyActor
): boolean {
  if (!userId) return false;
  try {
    if (thread.owner.kind !== 'workspace') return false;
    const workspaceId = workspaceIdForOwner(thread.owner);
    const workspace = store.getWorkspace(workspaceId);
    return (
      evaluatePolicyKernel(
        readThreadPolicyFacts({
          thread,
          ancestorThreadIds: readThreadPolicyAncestors(store, thread),
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
        })
      ).effect === 'allow'
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
  policyActor?: ThreadPolicyActor
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
  policyActor?: ThreadPolicyActor
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
  store: Pick<FsStore, 'getWorkspaceResourceAccess'> & Partial<Pick<FsStore, 'getThread'>>,
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
    const document = parseWorkspacePolicyDocument(
      workspaceId,
      store.getWorkspaceResourceAccess(workspaceId)
    );
    const ancestry = (thread: Thread) => [thread.id, ...readThreadPolicyAncestors(store, thread)];
    const sourceIds = ancestry(source);
    const destinationIds = destination ? ancestry(destination) : [];
    // Scope selection is the Kernel's own; this only enumerates candidate recipients to probe.
    const sourceBoundaries = selectThreadBoundaries(document, sourceIds);
    if (!sourceBoundaries.some((boundary) => boundary.managed)) return true;
    if (destination?.visibility !== 'workspace') return false;
    const destinationBoundaries = selectThreadBoundaries(document, destinationIds);
    if (!destinationBoundaries.some((boundary) => boundary.managed)) return false;
    const destinationStatements = destinationBoundaries.flatMap((boundary) => boundary.statements);
    // Managed recipients are finite: an unlisted User or Agent has no positive allocation,
    // including administrators. Probe every destination allocation/right through the Kernel;
    // splitting statements or adding a prohibition cannot manufacture a wider audience.
    const actors = new Map<string, ThreadPolicyActor>();
    const operations = new Set<string>();
    for (const statement of destinationStatements) {
      if (statement.kind !== 'permission' || statement.effect !== 'allow') continue;
      const recipient = workspacePolicyRecipient(statement);
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
        const evaluate = (thread: Thread, ids: string[]) =>
          evaluatePolicyKernel(
            readThreadPolicyFacts({
              actor,
              userId: actor.userId,
              administrator: false,
              thread,
              ancestorThreadIds: ids.slice(1),
              workspaceId,
              policy: document,
              operation,
            })
          );
        const recipient = evaluate(destination, destinationIds);
        if (
          recipient.reasons.some(
            (reason) => reason.code === 'invalid-policy' || reason.code === 'invalid-request'
          )
        )
          return false;
        if (recipient.effect === 'allow' && evaluate(source, sourceIds).effect !== 'allow')
          return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}
