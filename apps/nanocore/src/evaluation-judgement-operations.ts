import { isDeepStrictEqual } from 'node:util';
import {
  EVALUATION_JUDGEMENT_OPERATION_DEFINITIONS,
  JudgementRecordSchema,
  type RecordEvaluationJudgementRequest,
} from '@openkit/app-api-schemas';
import { UserActorRefSchema, writeRetainedV1 } from '@openkit/protocol';
import { appendArtifactJudgement, readArtifactJudgement } from './artifact-judgements.js';
import { isWorkspaceOperationAuthorized } from './auth/operation-authorizer.js';
import {
  appendCandidateSetJudgement,
  type CandidateSetCommands,
  readCandidateSet,
} from './evaluation-candidates.js';
import { StoreRecordNotFoundError } from './lib/store.js';
import { readMaterialJudgement } from './material-range-corrections.js';
import type { OperationInvocationDependencies } from './operation-composition.js';
import type { AdmittedOperationContext, FamilyImplementations } from './operation-contract.js';
import { OperationError } from './operation-error.js';
import { IdempotencyKeyConflictError, runIdempotentCommand } from './runtime/idempotent-command.js';
import {
  assertWorkspaceMaterialRange,
  ControlMaterialCommandInputSchema,
  executeControlMaterialCommand,
  readWorkspaceMaterialSensitivity,
} from './workspace-materials.js';

type Operation = keyof typeof EVALUATION_JUDGEMENT_OPERATION_DEFINITIONS;
type Assessment = RecordEvaluationJudgementRequest['judgement'];

/** A missing retained result is an existing command-owner unknown result, not a request to reconstruct it. */
function missingResult(): never {
  throw new OperationError(
    'recovery_required',
    'The accepted judgement record is unavailable.',
    409
  );
}

/** Checks current source access before new assessment or exact command replay. */
function admitTarget(access: CandidateSetCommands, assessment: Assessment, requestId: string) {
  const target = assessment.target;
  switch (target.kind) {
    case 'artifact-version':
      return readArtifactJudgement(access, { ...target, ...assessment, requestId });
    case 'material-range':
      assertWorkspaceMaterialRange(access.workspaceDb, target);
      return readMaterialJudgement(access.workspaceDb, target, requestId);
    case 'candidate-set':
      return (
        readCandidateSet(access, target.candidateSetId).judgements.find(
          (entry) => entry.requestId === requestId
        ) ?? null
      );
  }
}

/** Appends only a candidate-set annotation inside its unchanged Main-owned command transaction. */
function appendCandidateAssessment(
  access: CandidateSetCommands,
  input: RecordEvaluationJudgementRequest
) {
  const assessment = input.judgement;
  if (assessment.target.kind !== 'candidate-set')
    throw new OperationError('invalid_request', 'Candidate-set target is required.', 400);
  const updated = appendCandidateSetJudgement(access, {
    ...assessment,
    candidateSetId: assessment.target.candidateSetId,
    requestId: input.requestId,
  });
  return updated.judgements.find((entry) => entry.requestId === input.requestId) ?? missingResult();
}

/** Joins human judgements and exact corrections to the existing Workspace command transaction. */
export function createEvaluationJudgementOperationImplementations(
  dependencies: Pick<
    OperationInvocationDependencies,
    'store' | 'coreDb' | 'inflightCommands' | 'repositoryWorkspaceDb'
  >
) {
  /** Owns current human admission and the database lifetime for both explicit commands. */
  async function withWorkspace<T>(
    workspaceId: string,
    operation: Operation,
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
      !dependencies.store ||
      !dependencies.coreDb ||
      !dependencies.inflightCommands ||
      !dependencies.repositoryWorkspaceDb
    )
      throw new OperationError(
        'operation_storage_unavailable',
        'Judgement storage is unavailable.',
        503
      );
    if (
      !isWorkspaceOperationAuthorized(
        dependencies.coreDb,
        context.actor,
        workspaceId,
        EVALUATION_JUDGEMENT_OPERATION_DEFINITIONS[operation]
      )
    )
      throw new OperationError('workspace_access_denied', 'Workspace access denied.', 403);
    const db = dependencies.repositoryWorkspaceDb(workspaceId);
    try {
      dependencies.store.getWorkspace(workspaceId);
      UserActorRefSchema.parse(context.actorRef);
      return await execute({
        store: dependencies.store,
        coreDb: dependencies.coreDb,
        inflightCommands: dependencies.inflightCommands,
        workspaceDb: db,
        actor: context.actor,
      });
    } catch (error) {
      if (error instanceof OperationError) throw error;
      if (error instanceof StoreRecordNotFoundError)
        throw new OperationError('not_found', 'Judgement target not found.', 404, { cause: error });
      if (error instanceof IdempotencyKeyConflictError)
        throw new OperationError(error.code, error.message, error.status, { cause: error });
      const failure = error as { code?: string; message?: string };
      if (
        failure &&
        typeof failure.message === 'string' &&
        ['stale', 'conflict', 'recovery_required', 'source_digest_mismatch'].includes(
          failure.code ?? ''
        )
      )
        throw new OperationError(
          failure.code!,
          failure.message,
          failure.code === 'source_digest_mismatch' ? 400 : 409,
          { cause: error }
        );
      throw error;
    } finally {
      db.sqlite.close();
    }
  }
  return {
    'evaluation.judgement-add': (input, context) =>
      withWorkspace(input.workspaceId, 'evaluation.judgement-add', context, async (access) => {
        if (
          context.delivery === 'model' &&
          input.judgement.target.kind === 'material-range' &&
          readWorkspaceMaterialSensitivity(
            access.workspaceDb,
            input.judgement.target.materialId
          ) === 'restricted'
        )
          throw new OperationError(
            'sensitive_content',
            'Restricted Material content is unavailable through model delivery.',
            409
          );
        admitTarget(access, input.judgement, input.requestId);
        const common = {
          store: access.store,
          inflightCommands: access.inflightCommands,
          workspaceDb: access.workspaceDb,
          command: 'evaluation.judgement-add' as const,
          requestId: input.requestId,
          scope: { workspaceId: input.workspaceId },
          input: { actor: context.actorRef, judgement: input.judgement },
          responseKind: 'evaluation_judgement' as const,
          responseId: () => input.requestId,
          replay: (receipt: import('./lib/store.js').CommandRequestRecord) => {
            if (
              receipt.response.kind !== 'evaluation_judgement' ||
              receipt.response.id !== input.requestId
            )
              missingResult();
            const judgement =
              admitTarget(access, input.judgement, input.requestId) ?? missingResult();
            const expected = {
              ...input.judgement,
              actor: context.actorRef,
              workspaceId: input.workspaceId,
              requestId: input.requestId,
            };
            for (const key of [
              'kind',
              'target',
              'choice',
              'note',
              'extensions',
              'actor',
              'workspaceId',
              'requestId',
            ] as const)
              if (!isDeepStrictEqual(judgement[key], expected[key])) missingResult();
            return { judgement };
          },
        };
        if (input.judgement.target.kind === 'candidate-set')
          return runIdempotentCommand({
            ...common,
            workspaceTransaction: true,
            execute: () => ({ judgement: appendCandidateAssessment(access, input) }),
          });
        return runIdempotentCommand({
          ...common,
          execute: async (receipt) => {
            const assessment = input.judgement;
            if (assessment.target.kind === 'artifact-version')
              return {
                judgement: await appendArtifactJudgement(
                  access,
                  { ...assessment.target, ...assessment, requestId: input.requestId },
                  receipt
                ),
              };
            const judgement = JudgementRecordSchema.parse(
              writeRetainedV1({
                ...assessment,
                workspaceId: input.workspaceId,
                requestId: input.requestId,
                actor: { kind: 'user', id: access.actor.userId },
                recordedAt: receipt.createdAt,
              })
            );
            const result = await executeControlMaterialCommand(
              access.workspaceDb,
              ControlMaterialCommandInputSchema.parse({
                mode: 'range-judgement',
                input: judgement,
                receipt,
              })
            );
            if (result.mode !== 'range-judgement')
              throw new Error('Material judgement returned the wrong native result.');
            return result.value;
          },
        });
      }),
    'material.range-correct': (input, context) =>
      withWorkspace(input.workspaceId, 'material.range-correct', context, async (access) => {
        if (
          context.delivery === 'model' &&
          readWorkspaceMaterialSensitivity(access.workspaceDb, input.target.materialId) ===
            'restricted'
        )
          throw new OperationError(
            'sensitive_content',
            'Restricted Material content is unavailable through model delivery.',
            409
          );
        assertWorkspaceMaterialRange(access.workspaceDb, input.target);
        return runIdempotentCommand({
          store: access.store,
          inflightCommands: access.inflightCommands,
          workspaceDb: access.workspaceDb,
          command: 'material.range-correct',
          requestId: input.requestId,
          scope: { workspaceId: input.workspaceId },
          input: { ...input, actor: context.actorRef },
          responseKind: 'evaluation_judgement',
          responseId: () => input.requestId,
          execute: async (receipt) => {
            const result = await executeControlMaterialCommand(
              access.workspaceDb,
              ControlMaterialCommandInputSchema.parse({
                mode: 'range-correct',
                receipt,
                input: {
                  ...input,
                  actor: UserActorRefSchema.parse(context.actorRef),
                  acceptedAt: receipt.createdAt,
                },
              })
            );
            if (result.mode !== 'range-correct')
              throw new Error('Material correction returned the wrong native result.');
            return result.value;
          },
          replay: (receipt) => {
            if (
              receipt.response.kind !== 'evaluation_judgement' ||
              receipt.response.id !== input.requestId
            )
              missingResult();
            const judgement =
              readMaterialJudgement(access.workspaceDb, input.target, input.requestId) ??
              missingResult();
            if (
              judgement.kind !== 'correct' ||
              judgement.choice.outcome !== input.decision ||
              judgement.choice.replacementText !== input.replacementText ||
              !isDeepStrictEqual(judgement.actor, context.actorRef) ||
              judgement.note !== input.note ||
              !isDeepStrictEqual(judgement.extensions, input.extensions)
            )
              missingResult();
            return { judgement };
          },
        });
      }),
  } satisfies FamilyImplementations<typeof EVALUATION_JUDGEMENT_OPERATION_DEFINITIONS>;
}
