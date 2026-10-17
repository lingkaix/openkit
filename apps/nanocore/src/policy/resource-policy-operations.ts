import { isDeepStrictEqual } from 'node:util';
import {
  allocateEntityId,
  isSealedTurnTerminal,
  responsibleUserIdForActor,
} from '@openkit/protocol';
import type { z } from 'zod';
import type { OperationInvocationDependencies } from '../operation-composition.js';
import type { AdmittedOperationContext } from '../operation-contract.js';
import { OperationError } from '../operation-error.js';
import { requireUsableRecord } from '../runtime/pending-request-flow.js';
import {
  PendingRequestCommandError,
  preflightPendingRequest,
  projectApprovalRequest,
  readPendingRequest,
} from '../runtime/pending-requests.js';
import {
  applyResourcePolicyRequest,
  checkResourcePolicyCommandIntent,
  isResourcePolicyRequest,
  ResourcePolicyChangeSchema,
  type ResourcePolicyRequestDependencies,
  raiseResourcePolicyRequest,
} from './resource-policy-requests.js';

/** Existing config and Pending Request services for one Workspace database lifetime. */
export function resourcePolicyDependencies(
  dependencies: Pick<
    OperationInvocationDependencies,
    'coreDb' | 'store' | 'runtimeConfigOperations'
  >,
  workspaceDb: ResourcePolicyRequestDependencies['workspaceDb'],
  actor: import('../auth/identity.js').Actor
): ResourcePolicyRequestDependencies {
  const services = dependencies.runtimeConfigOperations;
  if (!dependencies.coreDb || !dependencies.store || !services)
    throw new PendingRequestCommandError(
      'resource_policy_unavailable',
      'Workspace resource Policy is unavailable.',
      503
    );
  return {
    coreDb: dependencies.coreDb,
    store: dependencies.store,
    workspaceDb,
    manager: services.manager,
    files: services.filesForActor(actor),
  };
}

/** Checks this intent at the existing human review seam; all other requests keep their owners. */
export function checkResourcePolicyOperationIntent(
  dependencies: Parameters<typeof resourcePolicyDependencies>[0],
  sqlite: import('better-sqlite3').Database,
  record: import('../runtime/pending-requests.js').PendingRequestRecord,
  actor: import('../auth/identity.js').Actor
): void {
  if (!isResourcePolicyRequest(record)) return;
  checkResourcePolicyCommandIntent(
    resourcePolicyDependencies(dependencies, { sqlite }, actor),
    record,
    actor
  );
}

/** Presents only the canonical approval and its caller-captured terms; incomplete lineage stays inspect-only. */
function resourcePolicyRequestView(
  record: import('../runtime/pending-requests.js').PendingRequestRecord
) {
  const approval = projectApprovalRequest(record);
  if (!approval)
    throw new PendingRequestCommandError(
      'recovery_required',
      'The resource Policy request is unavailable.',
      409
    );
  return { ...approval, change: ResourcePolicyChangeSchema.parse(record.governedIntent?.change) };
}

/** Prepares native request and confirmed application handlers; public definitions supply their one admission. */
export function createResourcePolicyOperationImplementations(
  dependencies: OperationInvocationDependencies
) {
  const withDatabase = <T>(
    workspaceId: string,
    run: (db: ResourcePolicyRequestDependencies['workspaceDb']) => T
  ): T => {
    if (!dependencies.repositoryWorkspaceDb)
      throw new OperationError(
        'resource_policy_unavailable',
        'Workspace resource Policy is unavailable.',
        503
      );
    const db = dependencies.repositoryWorkspaceDb(workspaceId);
    try {
      return run(db);
    } catch (error) {
      if (error instanceof PendingRequestCommandError)
        throw new OperationError(error.code, error.message, error.status, { cause: error });
      throw error;
    } finally {
      db.sqlite.close();
    }
  };
  return {
    'workspace.resource-access-request': (
      input: {
        workspaceId: string;
        threadId: string;
        requestId: string;
        change: Omit<z.input<typeof ResourcePolicyChangeSchema>, 'expectedRevision'>;
      },
      context: AdmittedOperationContext
    ) =>
      withDatabase(input.workspaceId, (db) => {
        const worker = context.kind === 'worker';
        const responsibleUserId = worker
          ? responsibleUserIdForActor(context.actor)
          : context.actor.userId;
        if (!responsibleUserId)
          throw new OperationError('workspace_access_denied', 'Workspace access denied.', 403);
        const actor = worker
          ? { kind: 'session' as const, userId: responsibleUserId }
          : context.actor;
        const services = resourcePolicyDependencies(dependencies, db, actor);
        const origin = worker
          ? { kind: 'worker' as const, lineage: context.lineage }
          : { kind: 'public' as const, actor };
        const prior = readPendingRequest(db.sqlite, input.requestId);
        if (prior) {
          if (
            !isResourcePolicyRequest(prior) ||
            prior.workspaceId !== input.workspaceId ||
            prior.threadId !== input.threadId
          )
            throw new PendingRequestCommandError(
              'idempotency_key_conflict',
              'This request has different captured terms.',
              409
            );
          const captured = prior.governedIntent;
          const oldChange = ResourcePolicyChangeSchema.parse(captured?.change);
          const { expectedRevision: _, ...oldTerms } = oldChange;
          if (
            !isDeepStrictEqual(oldTerms, input.change) ||
            !isDeepStrictEqual(captured?.origin, origin)
          )
            throw new PendingRequestCommandError(
              'idempotency_key_conflict',
              'This request has different captured terms.',
              409
            );
          return resourcePolicyRequestView(
            requireUsableRecord(
              services.store,
              db.sqlite,
              prior.requestId,
              prior.workspaceId,
              prior.threadId
            )
          );
        }
        const file = services.files.readFile(`workspaces/${input.workspaceId}/workspace.jsonc`);
        const change = ResourcePolicyChangeSchema.parse({
          ...input.change,
          expectedRevision: file.file.revision,
        });
        const turn = worker ? services.store.getTurnById(context.lineage.turnId) : null;
        if (
          worker &&
          (!turn ||
            turn.agentSessionId !== context.lineage.agentSessionId ||
            !turn.agentId ||
            isSealedTurnTerminal(turn.status))
        )
          throw new PendingRequestCommandError(
            'workspace_access_denied',
            'Current Worker responsibility is unavailable.',
            403
          );
        if (
          !worker &&
          services.store
            .listThreadTurns(input.workspaceId, input.threadId)
            .some((row) => !isSealedTurnTerminal(row.status))
        )
          throw new PendingRequestCommandError(
            'thread_busy',
            'The request Thread has a Turn in flight.',
            409
          );
        const now = new Date().toISOString();
        const raised = {
          requestId: input.requestId,
          workspaceId: input.workspaceId,
          threadId: input.threadId,
          raisingTurnId: turn?.id ?? allocateEntityId('tu'),
          requestItemId: allocateEntityId('it'),
          requesterKind: worker ? ('worker' as const) : ('person' as const),
          responsibleUserId,
          agentId: turn?.agentId ?? null,
          agentSessionId: turn?.agentSessionId ?? null,
          now,
        };
        preflightPendingRequest(db.sqlite, { ...raised, kind: 'approval' });
        if (!worker)
          services.store.createTurn(
            input.workspaceId,
            input.threadId,
            'Request resource access change',
            { kind: 'user', id: responsibleUserId },
            null,
            { turnId: raised.raisingTurnId, status: 'running' }
          );
        try {
          const record = raiseResourcePolicyRequest(services, raised, change, origin);
          if (!worker)
            services.store.updateTurn(raised.raisingTurnId, {
              status: 'completed',
              completedAt: now,
            });
          return resourcePolicyRequestView(record);
        } catch (error) {
          if (!worker)
            services.store.updateTurn(raised.raisingTurnId, { status: 'failed', completedAt: now });
          throw error;
        }
      }),
    'workspace.resource-access-apply': (
      input: {
        workspaceId: string;
        threadId: string;
        approvalRequestId: string;
        confirmation: string;
      },
      context: AdmittedOperationContext
    ) =>
      withDatabase(input.workspaceId, (db) => {
        if (context.kind === 'worker')
          throw new OperationError(
            'workspace_access_denied',
            'A current human administrator is required.',
            403
          );
        const result = applyResourcePolicyRequest(
          resourcePolicyDependencies(dependencies, db, context.actor),
          {
            workspaceId: input.workspaceId,
            threadId: input.threadId,
            requestId: input.approvalRequestId,
            confirmation: input.confirmation,
            actor: context.actor,
          }
        );
        return {
          approvalRequestId: input.approvalRequestId,
          workspaceId: input.workspaceId,
          threadId: input.threadId,
          savedRevision: result.saved.file.revision,
          reloadStatus: result.reload.status,
        };
      }),
  };
}
