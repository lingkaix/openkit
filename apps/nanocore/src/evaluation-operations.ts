import type { EVALUATION_OPERATION_DEFINITIONS } from '@openkit/app-api-schemas';
import {
  type CandidateSetCommands,
  createCandidateSet,
  listCandidateSets,
  readCandidateSet,
  selectCandidateSet,
} from './evaluation-candidates.js';
import { StoreRecordNotFoundError } from './lib/store.js';
import type { OperationInvocationDependencies } from './operation-composition.js';
import type { AdmittedOperationContext, FamilyImplementations } from './operation-contract.js';
import { OperationError } from './operation-error.js';
import { IdempotencyKeyConflictError } from './runtime/idempotent-command.js';

/** Joins the ordinary candidate family to its single Workspace record and command transaction owner. */
export function createEvaluationOperationImplementations(
  dependencies: Pick<
    OperationInvocationDependencies,
    'coreDb' | 'store' | 'inflightCommands' | 'repositoryWorkspaceDb'
  >
) {
  /** Retains current human admission and one scoped database lifetime for every native family call. */
  async function withWorkspace<T>(
    workspaceId: string,
    context: AdmittedOperationContext,
    execute: (access: CandidateSetCommands) => T | Promise<T>
  ): Promise<T> {
    if (
      context.kind !== 'public' ||
      context.actorRef.kind !== 'user' ||
      context.actorRef.id !== context.actor.userId
    )
      throw new OperationError(
        'workspace_access_denied',
        'Human Workspace access is required.',
        403
      );
    if (
      !dependencies.coreDb ||
      !dependencies.store ||
      !dependencies.inflightCommands ||
      !dependencies.repositoryWorkspaceDb
    )
      throw new OperationError(
        'operation_storage_unavailable',
        'Candidate storage is unavailable.',
        503
      );
    const workspaceDb = dependencies.repositoryWorkspaceDb(workspaceId);
    try {
      return await execute({
        store: dependencies.store,
        coreDb: dependencies.coreDb,
        workspaceDb,
        inflightCommands: dependencies.inflightCommands,
        actor: context.actor,
      });
    } catch (error) {
      if (error instanceof IdempotencyKeyConflictError)
        throw new OperationError(error.code, error.message, error.status, { cause: error });
      if (error instanceof StoreRecordNotFoundError)
        throw new OperationError('not_found', 'Candidate Workspace not found.', 404, {
          cause: error,
        });
      throw error;
    } finally {
      workspaceDb.sqlite.close();
    }
  }
  return {
    'evaluation.candidate-set-create': (input, context) =>
      withWorkspace(input.workspaceId, context, (access) => createCandidateSet(access, input)),
    'evaluation.candidate-set-list': (input, context) =>
      withWorkspace(input.workspaceId, context, (access) => ({ items: listCandidateSets(access) })),
    'evaluation.candidate-set-read': (input, context) =>
      withWorkspace(input.workspaceId, context, (access) =>
        readCandidateSet(access, input.candidateSetId)
      ),
    'evaluation.candidate-set-select': (input, context) =>
      withWorkspace(input.workspaceId, context, (access) => selectCandidateSet(access, input)),
  } satisfies FamilyImplementations<typeof EVALUATION_OPERATION_DEFINITIONS>;
}
