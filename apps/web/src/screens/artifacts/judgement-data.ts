import type { JudgementRecord } from '@openkit/app-api-schemas';
import { ApiCallError, type CoreClient } from '@openkit/core-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCoreClient } from '../../app/core-client';
import { materialKeys } from '../material/data';

/** Inputs derive from the composed public operation contracts. */
export type AssessmentInput = Parameters<CoreClient['operations']['evaluation.judgement-add']>[0];
/** Exact correction input retains its original range and explicit decision. */
export type CorrectionInput = Parameters<CoreClient['operations']['material.range-correct']>[0];

/** Compares the closed exact target without treating descriptive additions as identity. */
export function sameJudgementTarget(
  left: JudgementRecord['target'],
  right: JudgementRecord['target']
): boolean {
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case 'artifact-version':
      return (
        right.kind === left.kind &&
        left.artifactId === right.artifactId &&
        left.artifactVersion === right.artifactVersion &&
        left.contentDigest === right.contentDigest
      );
    case 'material-range':
      return (
        right.kind === left.kind &&
        left.materialId === right.materialId &&
        left.revisionId === right.revisionId &&
        left.contentDigest === right.contentDigest &&
        left.start === right.start &&
        left.end === right.end &&
        left.originalText === right.originalText
      );
    case 'candidate-set':
      return right.kind === left.kind && left.candidateSetId === right.candidateSetId;
  }
}

/** Uses the existing Review owner; an imported version can have no Review yet. */
export function useArtifactJudgements(
  workspaceId: string,
  artifactId: string,
  artifactVersion: number,
  contentDigest: string
) {
  const client = useCoreClient();
  return useQuery({
    queryKey: ['artifact-reviews', workspaceId, artifactId],
    queryFn: async () =>
      (await client.operations['artifact.review-list']({ workspaceId, artifactId })).reviews,
    select: (reviews) =>
      reviews
        .filter(
          (review) =>
            review.workspaceId === workspaceId &&
            review.artifactId === artifactId &&
            review.artifactVersion === artifactVersion &&
            review.contentDigest === contentDigest
        )
        .flatMap((review) => review.judgements)
        .filter(
          (judgement) =>
            judgement.workspaceId === workspaceId &&
            sameJudgementTarget(judgement.target, {
              kind: 'artifact-version',
              artifactId,
              artifactVersion,
              contentDigest,
            })
        ),
    retry: false,
  });
}

/** Invalidates existing owners after an accepted judgement, without installing a receipt as current content. */
function useInvalidateJudgement() {
  const cache = useQueryClient();
  return async (workspaceId: string, target: JudgementRecord['target']) => {
    if (target.kind === 'artifact-version') {
      await cache.invalidateQueries({
        queryKey: ['artifact-reviews', workspaceId, target.artifactId],
      });
    } else if (target.kind === 'material-range') {
      await Promise.all([
        cache.invalidateQueries({
          queryKey: materialKeys.revision(workspaceId, target.materialId, target.revisionId),
        }),
        cache.invalidateQueries({
          queryKey: materialKeys.material(workspaceId, target.materialId),
        }),
        cache.invalidateQueries({
          queryKey: materialKeys.revisions(workspaceId, target.materialId),
        }),
        cache.invalidateQueries({ queryKey: materialKeys.list(workspaceId) }),
        cache.invalidateQueries({ queryKey: ['thread-material', workspaceId] }),
      ]);
    }
  };
}

/** A malformed settlement is uncertain, so it cannot authorize a new assessment. */
function requireSettlement(valid: boolean): void {
  if (!valid)
    throw new ApiCallError(409, 'Judgement settlement does not match its exact request.', {
      code: 'recovery_required',
    });
}

/** Records a human assessment once; retries remain explicit and retain the original request. */
export function useAddJudgement() {
  const client = useCoreClient();
  const invalidate = useInvalidateJudgement();
  return useMutation({
    mutationFn: async (input: AssessmentInput) => {
      const result = await client.operations['evaluation.judgement-add'](input);
      const record = result.judgement;
      requireSettlement(
        record.workspaceId === input.workspaceId &&
          record.requestId === input.requestId &&
          record.kind === input.judgement.kind &&
          sameJudgementTarget(record.target, input.judgement.target) &&
          record.note === input.judgement.note
      );
      if (input.judgement.kind === 'rate')
        requireSettlement(
          record.kind === 'rate' &&
            record.choice.value === input.judgement.choice.value &&
            record.choice.lowerBound === input.judgement.choice.lowerBound &&
            record.choice.upperBound === input.judgement.choice.upperBound
        );
      return record;
    },
    onSuccess: (record) => invalidate(record.workspaceId, record.target),
    retry: false,
  });
}

/** Applies or rejects only the submitted original range; the server owns the resulting revision. */
export function useCorrectMaterialRange() {
  const client = useCoreClient();
  const invalidate = useInvalidateJudgement();
  return useMutation({
    mutationFn: async (input: CorrectionInput) => {
      const result = await client.operations['material.range-correct'](input);
      const record = result.judgement;
      requireSettlement(
        record.workspaceId === input.workspaceId &&
          record.requestId === input.requestId &&
          record.kind === 'correct' &&
          sameJudgementTarget(record.target, input.target) &&
          record.note === input.note
      );
      requireSettlement(
        record.kind === 'correct' &&
          record.choice.outcome === input.decision &&
          record.choice.replacementText === input.replacementText &&
          (record.choice.outcome !== 'apply' ||
            record.choice.resultingRevision.materialId === input.target.materialId)
      );
      return record;
    },
    onSuccess: (record) => invalidate(record.workspaceId, record.target),
    retry: false,
  });
}

/** Only a typed refusal proves that editing cannot duplicate an uncertain effect. */
export function judgementRefused(error: unknown): boolean {
  return (
    error instanceof ApiCallError &&
    [
      'stale',
      'conflict',
      'invalid_request',
      'not_found',
      'forbidden',
      'workspace_access_denied',
      'source_digest_mismatch',
      'idempotency_key_conflict',
    ].includes(error.code ?? '')
  );
}

/** Recovery-required settlements need inspection; other uncertain results can replay the same command. */
export function judgementRetryable(error: unknown): boolean {
  return (
    !judgementRefused(error) &&
    !(error instanceof ApiCallError && error.code === 'recovery_required')
  );
}

/** Public failure copy never exposes internal errors or claims a content effect. */
export function judgementError(error: unknown): string {
  if (error instanceof ApiCallError) {
    if (
      error.code === 'stale' ||
      error.code === 'source_digest_mismatch' ||
      error.code === 'not_found'
    )
      return 'The exact target is stale or unavailable. Refresh before another request.';
    if (error.code === 'conflict' || error.code === 'idempotency_key_conflict')
      return 'Request conflict. Refresh before another request.';
    if (error.code === 'workspace_access_denied' || error.code === 'forbidden')
      return 'Access denied. Refresh before another request.';
    if (error.code === 'invalid_request')
      return 'The request was refused. Check its target and values.';
    if (error.code === 'recovery_required')
      return 'Recovery required. Inspect the exact target before continuing.';
  }
  return 'The result is unknown. Retry the same request to check it.';
}
