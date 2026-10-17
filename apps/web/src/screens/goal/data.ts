import type {
  GOAL_OPERATION_DEFINITIONS,
  GoalView,
  OperationInput,
} from '@openkit/app-api-schemas';
import type { CoreClient, GetArtifactResponse } from '@openkit/core-client';
import { ApiCallError, createRequestId } from '@openkit/core-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useCoreClient } from '../../app/core-client';

export { useCurrentWorkspaceId } from '../chat/data';
/** One server-owned, version-keyed Artifact Review projection. */
export type ArtifactReview = Awaited<
  ReturnType<CoreClient['operations']['artifact.review-list']>
>['reviews'][number];
/** Public decision input accepted by the exact Artifact Review endpoint. */
export type ArtifactReviewDecisionInput = Omit<
  Parameters<CoreClient['operations']['artifact.review.decide']>[0],
  'workspaceId' | 'artifactId' | 'artifactVersion'
>;

/** Query identity follows the ordinary Coordinator Thread and retains Artifact Review ownership. */
export const goalKeys = {
  view: (workspaceId: string, threadId: string) => ['goal', workspaceId, threadId] as const,
  artifact: (workspaceId: string, artifactId: string) =>
    ['artifact', workspaceId, artifactId] as const,
  reviews: (workspaceId: string, artifactId: string) =>
    ['artifact-reviews', workspaceId, artifactId] as const,
};
/** Reads only current owner projections; reading never proposes or admits work. */
export function useGoalView(workspaceId: string | null, threadId: string) {
  const client = useCoreClient();
  return useQuery({
    queryKey: goalKeys.view(workspaceId ?? '', threadId),
    queryFn: () => client.operations['goal.read']({ workspaceId: workspaceId!, threadId }),
    enabled: Boolean(workspaceId && threadId),
    refetchInterval: 5000,
    refetchIntervalInBackground: false,
  });
}
type Command = Exclude<keyof typeof GOAL_OPERATION_DEFINITIONS, 'goal.read'>;
type GoalCommandInput = {
  [K in Command]: { operation: K; input: Omit<OperationInput<K>, 'requestId'> };
}[Command];
/** Keeps one exact command identity through uncertain retries and installs the returned owner view. */
export function useGoalCommand(workspaceId: string, threadId: string) {
  const client = useCoreClient();
  const cache = useQueryClient();
  const pending = useRef<{ signature: string; requestId: string } | null>(null);
  return useMutation({
    mutationFn: async (command: GoalCommandInput): Promise<GoalView> => {
      const signature = JSON.stringify(command);
      if (pending.current?.signature !== signature)
        pending.current = { signature, requestId: createRequestId() };
      return await client.operations[command.operation]({
        ...command.input,
        requestId: pending.current.requestId,
      } as never);
    },
    onSuccess: (view) => {
      pending.current = null;
      cache.setQueryData(goalKeys.view(workspaceId, view.goal?.threadId ?? threadId), view);
      void cache.invalidateQueries({ queryKey: goalKeys.view(workspaceId, threadId) });
    },
  });
}
/** Load one artifact for the review surface. */
export function useArtifact(workspaceId: string | null, artifactId: string) {
  const client = useCoreClient();
  return useQuery({
    queryKey: goalKeys.artifact(workspaceId ?? '', artifactId),
    queryFn: (): Promise<GetArtifactResponse> =>
      client.operations['artifact.read']({ workspaceId: workspaceId as string, artifactId }),
    enabled: Boolean(workspaceId && artifactId),
  });
}

/** List version-keyed Artifact Reviews for one artifact. */
export function useArtifactReviews(workspaceId: string | null, artifactId: string) {
  const client = useCoreClient();
  return useQuery({
    queryKey: goalKeys.reviews(workspaceId ?? '', artifactId),
    queryFn: async () =>
      (
        await client.operations['artifact.review-list']({
          workspaceId: workspaceId as string,
          artifactId,
        })
      ).reviews,
    enabled: Boolean(workspaceId && artifactId),
  });
}

/** Identifies contract-defined refusal before any Review or follow-up effect. */
function reviewCommandRefused(error: unknown) {
  return (
    error instanceof ApiCallError &&
    ['conflict', 'thread_busy', 'invalid_request', 'forbidden', 'not_found', 'stale'].includes(
      error.code ?? ''
    )
  );
}

/** Submit one exact decision, retaining its identity until an authoritative outcome or refusal. */
export function useSubmitArtifactReview(
  workspaceId: string,
  artifactId: string,
  artifactVersion: number
) {
  const client = useCoreClient();
  const queryClient = useQueryClient();
  const pending = useRef<{ signature: string; requestId: string } | null>(null);
  const mutation = useMutation({
    mutationFn: (input: ArtifactReviewDecisionInput) => {
      const signature = JSON.stringify({ workspaceId, artifactId, artifactVersion, input });
      if (pending.current && pending.current.signature !== signature)
        throw new Error('Inspect or retry the unconfirmed Review decision before changing it.');
      pending.current ??= { signature, requestId: input.requestId ?? createRequestId() };
      return client.operations['artifact.review.decide']({
        workspaceId,
        artifactId,
        artifactVersion,
        ...input,
        requestId: pending.current.requestId,
      });
    },
    onError: (error) => {
      if (reviewCommandRefused(error)) pending.current = null;
    },
    onSuccess: async () => {
      pending.current = null;
      await queryClient.refetchQueries({
        queryKey: goalKeys.reviews(workspaceId, artifactId),
        exact: true,
      });
    },
  });
  return { ...mutation, isUncertain: mutation.isError && !reviewCommandRefused(mutation.error) };
}

/** Records an exact candidate choice with one request identity retained through uncertain retry. */
export function useSelectArtifactCandidate(
  workspaceId: string,
  artifactId: string,
  artifactVersion: number,
  contentDigest: string
) {
  const client = useCoreClient();
  const cache = useQueryClient();
  const pending = useRef<{ signature: string; requestId: string } | null>(null);
  const mutation = useMutation({
    mutationFn: (reason: string | undefined) => {
      const signature = JSON.stringify({
        workspaceId,
        artifactId,
        artifactVersion,
        contentDigest,
        reason,
      });
      if (pending.current && pending.current.signature !== signature)
        throw new Error('Inspect or retry the unconfirmed candidate choice before changing it.');
      pending.current ??= { signature, requestId: createRequestId() };
      return client.operations['artifact.review.select']({
        workspaceId,
        artifactId,
        artifactVersion,
        contentDigest,
        requestId: pending.current.requestId,
        ...(reason ? { reason } : {}),
      });
    },
    onError: (error) => {
      if (reviewCommandRefused(error)) pending.current = null;
    },
    onSuccess: async () => {
      pending.current = null;
      await cache.refetchQueries({
        queryKey: goalKeys.reviews(workspaceId, artifactId),
        exact: true,
      });
    },
  });
  return { ...mutation, isUncertain: mutation.isError && !reviewCommandRefused(mutation.error) };
}
