import type { CandidateSetRecord, EvaluationCandidate } from '@openkit/app-api-schemas';
import { ApiCallError, type CoreClient } from '@openkit/core-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCoreClient } from '../../app/core-client';

/** Comparison projections keep Workspace, immutable set and exact byte identities in their keys. */
export const candidateSetKeys = {
  list: (workspaceId: string) => ['candidate-sets', workspaceId] as const,
  read: (workspaceId: string, candidateSetId: string) =>
    ['candidate-set', workspaceId, candidateSetId] as const,
};

/** Exact tuples never alias another version or another digest of the same Artifact. */
export function sameCandidate(left: EvaluationCandidate, right: EvaluationCandidate): boolean {
  return (
    left.artifactId === right.artifactId &&
    left.artifactVersion === right.artifactVersion &&
    left.contentDigest === right.contentDigest
  );
}

/** Rejects a foreign response before its protected membership or judgements enter this view. */
function assertSetOwner(
  set: CandidateSetRecord,
  workspaceId: string,
  candidateSetId = set.candidateSetId
): void {
  if (set.workspaceId !== workspaceId || set.candidateSetId !== candidateSetId)
    throw new ApiCallError(409, 'Candidate set response has a different owner.', {
      code: 'recovery_required',
    });
}

/** Lists current authorized comparisons; errors do not authorize cached membership. */
export function useCandidateSets(workspaceId: string) {
  const client = useCoreClient();
  return useQuery({
    queryKey: candidateSetKeys.list(workspaceId),
    queryFn: async () => {
      const result = await client.operations['evaluation.candidate-set-list']({ workspaceId });
      for (const set of result.items) assertSetOwner(set, workspaceId);
      return result.items;
    },
    retry: false,
  });
}

/** Reads one explicitly inspected immutable comparison and its current judgement history. */
export function useCandidateSet(workspaceId: string, candidateSetId: string | null) {
  const client = useCoreClient();
  return useQuery({
    queryKey: candidateSetKeys.read(workspaceId, candidateSetId ?? ''),
    queryFn: async () => {
      const result = await client.operations['evaluation.candidate-set-read']({
        workspaceId,
        candidateSetId: candidateSetId as string,
      });
      assertSetOwner(result, workspaceId, candidateSetId as string);
      return result;
    },
    enabled: candidateSetId !== null,
    retry: false,
  });
}

/** Admits all exact originals together so a failed member cannot leave a partial comparison. */
export function useCandidateVersions(workspaceId: string, set: CandidateSetRecord | undefined) {
  const client = useCoreClient();
  return useQuery({
    queryKey: ['candidate-set-versions', workspaceId, set?.candidateSetId, set?.candidates],
    queryFn: async () =>
      Promise.all(
        (set?.candidates ?? []).map(async (candidate) => {
          const result = await client.operations['artifact.version-read']({
            workspaceId,
            artifactId: candidate.artifactId,
            artifactVersion: candidate.artifactVersion,
          });
          if (
            result.artifact.workspaceId !== workspaceId ||
            result.artifact.id !== candidate.artifactId ||
            result.artifact.version !== candidate.artifactVersion ||
            result.artifact.contentDigest !== candidate.contentDigest ||
            result.version.workspaceId !== workspaceId ||
            !sameCandidate(result.version, candidate)
          )
            throw new ApiCallError(
              409,
              'Exact candidate original does not match its retained reference.',
              { code: 'stale' }
            );
          return result;
        })
      ),
    enabled: set !== undefined,
    retry: false,
  });
}

/** Creates immutable membership under one retained request identity; no automatic replay occurs. */
export function useCreateCandidateSet() {
  const client = useCoreClient();
  const cache = useQueryClient();
  return useMutation({
    mutationFn: async (
      input: Parameters<CoreClient['operations']['evaluation.candidate-set-create']>[0]
    ) => {
      const result = await client.operations['evaluation.candidate-set-create'](input);
      assertSetOwner(result, input.workspaceId, input.requestId);
      if (
        result.candidates.length !== input.candidates.length ||
        result.candidates.some(
          (candidate, index) => !sameCandidate(candidate, input.candidates[index])
        )
      )
        throw new ApiCallError(
          409,
          'Candidate set membership does not match the accepted request.',
          { code: 'recovery_required' }
        );
      return result;
    },
    onSuccess: (_result, input) => {
      void cache.invalidateQueries({ queryKey: candidateSetKeys.list(input.workspaceId) });
    },
    retry: false,
  });
}

/** Records one explicit human choice and refetches current history without replacing it with an older receipt. */
export function useSelectCandidate() {
  const client = useCoreClient();
  const cache = useQueryClient();
  return useMutation({
    mutationFn: async (
      input: Parameters<CoreClient['operations']['evaluation.candidate-set-select']>[0]
    ) => {
      const result = await client.operations['evaluation.candidate-set-select'](input);
      assertSetOwner(result, input.workspaceId, input.candidateSetId);
      const judgement = result.judgements.find(
        (entry) => entry.kind === 'select' && entry.requestId === input.requestId
      );
      if (
        !judgement ||
        judgement.kind !== 'select' ||
        !sameCandidate(judgement.choice, input.choice) ||
        judgement.note !== (input.note ?? null)
      )
        throw new ApiCallError(
          409,
          'Candidate choice settlement does not match its frozen request.',
          { code: 'recovery_required' }
        );
      return result;
    },
    onSuccess: (_result, input) => {
      void cache.invalidateQueries({ queryKey: candidateSetKeys.list(input.workspaceId) });
      void cache.invalidateQueries({
        queryKey: candidateSetKeys.read(input.workspaceId, input.candidateSetId),
      });
    },
    retry: false,
  });
}

/** Unknown outcomes require reconciliation with the same request rather than another human-choice command. */
export function canRetryCandidateCommand(error: unknown): boolean {
  if (!(error instanceof ApiCallError)) return true;
  return ![
    'workspace_access_denied',
    'not_found',
    'stale',
    'conflict',
    'invalid_request',
    'idempotency_key_conflict',
    'recovery_required',
    'source_digest_mismatch',
  ].includes(error.code ?? '');
}

/** Only a confirmed no-effect refusal permits a fresh request after a successful current read. */
export function canEditCandidateCommand(error: unknown): boolean {
  return (
    error instanceof ApiCallError &&
    error.code !== 'recovery_required' &&
    !canRetryCandidateCommand(error)
  );
}

/** Fixed public copy does not expose raw server errors or infer an unproved command result. */
export function candidateCommandError(error: unknown): string {
  if (error instanceof ApiCallError) {
    switch (error.code) {
      case 'workspace_access_denied':
        return 'Access denied. Refresh the comparison before making another choice.';
      case 'stale':
      case 'not_found':
      case 'source_digest_mismatch':
        return 'An exact candidate is unavailable. Refresh the comparison.';
      case 'conflict':
      case 'idempotency_key_conflict':
        return 'Request conflict. Refresh the comparison before making another request.';
      case 'invalid_request':
        return 'That comparison request was refused. Check its exact candidates.';
      case 'recovery_required':
        return 'Recovery required. Inspect the comparison before continuing.';
    }
  }
  return 'The result is unknown. Retry the same comparison request to check it.';
}
