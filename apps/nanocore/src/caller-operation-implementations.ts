import type { CALLER_OPERATION_DEFINITIONS, ReadCallerResponse } from '@openkit/app-api-schemas';
import type { Actor } from './auth/identity.js';
import { isCurrentDeploymentAdministrator } from './auth/operation-authorizer.js';
import { isArtifactVisible, isThreadVisible } from './auth/thread-visibility.js';
import type { OperationInvocationDependencies } from './operation-composition.js';
import { type FamilyImplementations, publicOperationActor } from './operation-contract.js';
import { OperationError } from './operation-error.js';
import type { CoreDb } from './storage/db.js';
import { getWorkspaceRegistryFact } from './workspace-sharing.js';
import { readAuthorizedWorkspaceRelation } from './workspace-sharing-operations.js';

/** Joins current caller facts to existing identity, membership and source-audience owners without retaining a summary. */
export function createCallerOperationImplementations(
  dependencies: Pick<OperationInvocationDependencies, 'coreDb' | 'store'>
) {
  return {
    'caller.read': (input, context) => {
      const actor = publicOperationActor(context);
      const identity: ReadCallerResponse = {
        userId: actor.userId,
        credential:
          actor.kind === 'token'
            ? { kind: 'token', scope: actor.tokenScope! }
            : { kind: actor.kind, scope: null },
      };
      if (input.workspaceId === undefined) return identity;
      const workspaceId = input.workspaceId;

      const coreDb = dependencies.coreDb!;
      readOwnedCallerWorkspace(coreDb, actor, workspaceId);
      const administratorEligible = isCurrentDeploymentAdministrator(coreDb, actor);
      const store = dependencies.store!;
      let counts: NonNullable<ReadCallerResponse['workspace']>['counts'];
      try {
        // Existence is required even when a list owner would otherwise return an empty collection.
        store.getWorkspace(workspaceId);
        readOwnedCallerWorkspace(coreDb, actor, workspaceId, administratorEligible);
        const threads = store
          .listThreads(workspaceId)
          .filter((thread) => isThreadVisible(store, thread, actor.userId, administratorEligible));
        let turns = 0;
        let items = 0;
        for (const thread of threads) {
          readOwnedCallerWorkspace(coreDb, actor, workspaceId, administratorEligible);
          turns += store.listThreadTurns(workspaceId, thread.id).length;
          readOwnedCallerWorkspace(coreDb, actor, workspaceId, administratorEligible);
          items += store.listThreadItems(workspaceId, thread.id).length;
        }
        readOwnedCallerWorkspace(coreDb, actor, workspaceId, administratorEligible);
        counts = {
          threads: threads.length,
          turns,
          items,
          artifacts: store
            .listArtifacts(workspaceId)
            .filter((artifact) =>
              isArtifactVisible(store, artifact, actor.userId, administratorEligible)
            ).length,
        };
      } catch (error) {
        if (error instanceof OperationError) throw error;
        throw new OperationError(
          'caller_observation_unavailable',
          'Current retained-work observation is unavailable.',
          503,
          { cause: error }
        );
      }
      // Source acquisition can observe a concurrent credential, membership or lifecycle change.
      // Publish only under current ownership and access; prior admission is not retained authority.
      const relation = readOwnedCallerWorkspace(coreDb, actor, workspaceId, administratorEligible);
      return {
        ...identity,
        workspace: {
          workspaceId,
          ownerUserId: relation.ownerUserId,
          membershipStatus: relation.membershipStatus,
          accessCause: relation.accessCause,
          observedAt: new Date().toISOString(),
          counts,
        },
      };
    },
  } satisfies FamilyImplementations<typeof CALLER_OPERATION_DEFINITIONS>;
}

/** Requires current ownership and ordinary source admission without provisioning or enumerating. */
function readOwnedCallerWorkspace(
  coreDb: CoreDb,
  actor: Actor,
  workspaceId: string,
  admittedAdministrator = false
) {
  const registry = getWorkspaceRegistryFact(coreDb, workspaceId);
  if (
    !registry ||
    registry.ownerUserId !== actor.userId ||
    (admittedAdministrator && !isCurrentDeploymentAdministrator(coreDb, actor))
  ) {
    throw new OperationError('workspace_access_denied', 'Workspace access denied.', 403);
  }
  return readAuthorizedWorkspaceRelation(coreDb, actor, workspaceId);
}
