import type { CoreClient, GetArtifactResponse } from '@openkit/core-client';
import { createRequestId } from '@openkit/core-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCoreClient } from '../../app/core-client';
import { useCurrentWorkspaceId } from '../chat/data';
import { type AttentionRow, workspaceKeys } from '../workspace/data';

/** Thread goal summary response from `app.getThreadGoalSummary`. */
export type ThreadGoalSummaryResponse = Awaited<
  ReturnType<CoreClient['app']['getThreadGoalSummary']>
>;
/** Thread-level Goal Mode summary when a goal is present. */
export type ThreadGoalSummary = NonNullable<ThreadGoalSummaryResponse['goal']>;
/** Reviewable plan payload returned by `app.createThreadGoalPlan`. */
export type CreateThreadGoalPlanResponse = Awaited<
  ReturnType<CoreClient['app']['createThreadGoalPlan']>
>;
/** One server-owned, version-keyed Artifact Review projection. */
export type ArtifactReview = Awaited<
  ReturnType<CoreClient['app']['listArtifactReviews']>
>['reviews'][number];
/** Public decision input accepted by the exact Artifact Review endpoint. */
export type ArtifactReviewDecisionInput = Parameters<
  CoreClient['app']['submitArtifactReviewDecision']
>[3];

/**
 * Goal Mode data hooks (WP-5). All goal, plan, steering, and artifact-review
 * access flows through `@openkit/core-client` under TanStack Query — server state
 * is never copied into Zustand.
 */
export const goalKeys = {
  summary: (workspaceId: string, threadId: string) =>
    ['goal-summary', workspaceId, threadId] as const,
  plan: (workspaceId: string, threadId: string) => ['goal-plan', workspaceId, threadId] as const,
  artifact: (workspaceId: string, artifactId: string) =>
    ['artifact', workspaceId, artifactId] as const,
  reviews: (workspaceId: string, artifactId: string) =>
    ['artifact-reviews', workspaceId, artifactId] as const,
};

/** Re-export workspace selection for goal screens (same owner as chat). */
export { useCurrentWorkspaceId };

/** Load the thread-scoped Goal Mode summary. */
export function useGoalSummary(workspaceId: string | null, threadId: string) {
  const client = useCoreClient();
  return useQuery({
    queryKey: goalKeys.summary(workspaceId ?? '', threadId),
    queryFn: (): Promise<ThreadGoalSummaryResponse> =>
      client.app.getThreadGoalSummary(workspaceId as string, threadId),
    enabled: Boolean(workspaceId && threadId),
  });
}

/** Install one authoritative Goal projection without refetching or touching another summary. */
function installGoalSummary(
  queryClient: ReturnType<typeof useQueryClient>,
  workspaceId: string,
  threadId: string,
  goal: ThreadGoalSummary
) {
  queryClient.setQueryData(goalKeys.summary(workspaceId, threadId), { goal });
}

/** Start Goal Mode with one caller-owned intent id and cache its returned Goal projection. */
export function useStartThreadGoal(workspaceId: string, threadId: string) {
  const client = useCoreClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { objective: string; requestId: string }) =>
      client.app.startThreadGoal(workspaceId, threadId, input),
    onSuccess: (response) => {
      installGoalSummary(queryClient, workspaceId, threadId, response.goal);
    },
  });
}

/** Pause the current running Goal and cache its returned Goal projection. */
export function usePauseThreadGoal(workspaceId: string, threadId: string) {
  const client = useCoreClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => client.app.pauseThreadGoal(workspaceId, threadId),
    onSuccess: (response) => {
      installGoalSummary(queryClient, workspaceId, threadId, response.goal);
    },
  });
}

/** Resume the current paused Goal and cache its returned Goal projection. */
export function useResumeThreadGoal(workspaceId: string, threadId: string) {
  const client = useCoreClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => client.app.resumeThreadGoal(workspaceId, threadId),
    onSuccess: (response) => {
      installGoalSummary(queryClient, workspaceId, threadId, response.goal);
    },
  });
}

/** Run exactly one bounded Goal worker step and cache its returned Goal projection. */
export function useRunThreadGoalStep(workspaceId: string, threadId: string) {
  const client = useCoreClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => client.app.runThreadGoalStep(workspaceId, threadId),
    onSuccess: (response) => {
      installGoalSummary(queryClient, workspaceId, threadId, response.goal);
    },
  });
}

/**
 * Select the unresolved Action Center row for the Goal's exact current review lineage.
 *
 * Terminal, non-reviewing, cross-scope, malformed, and non-current Task rows are ignored;
 * a row is returned only when exactly one fully valid candidate remains.
 */
export function selectCurrentGoalReview(
  rows: readonly AttentionRow[],
  goal: ThreadGoalSummary
): AttentionRow | null {
  if (goal.status !== 'reviewing' || !goal.currentTask || goal.currentTask.status !== 'reviewing') {
    return null;
  }

  const matches = rows.filter((row) => {
    const source = row.source;
    const actionKinds = new Set(row.actions.map((action) => action.kind));
    return (
      source.type === 'goal_review' &&
      source.reviewId.trim().length > 0 &&
      source.workspaceId === goal.workspaceId &&
      source.threadId === goal.threadId &&
      source.goalId === goal.goalId &&
      source.taskId === goal.currentTask?.taskId &&
      row.id ===
        `goal-review:${source.workspaceId}:${source.threadId}:${source.goalId}:${source.reviewId}` &&
      row.kind === 'artifact_review' &&
      row.workspaceId === source.workspaceId &&
      row.threadId === source.threadId &&
      row.goalId === source.goalId &&
      row.taskId === source.taskId &&
      row.actions.length === 4 &&
      actionKinds.size === 4 &&
      (['accept_review', 'request_refinement', 'retry_work', 'abort'] as const).every((kind) =>
        actionKinds.has(kind)
      ) &&
      row.actions.every((action) => action.method === 'POST' && action.disabled !== true)
    );
  });

  return matches.length === 1 ? matches[0] : null;
}

/**
 * Map one Goal Review Action Center action to its canonical decision input.
 *
 * Required text must come from the user; absent text leaves the action unresolved.
 */
export function goalReviewDecisionInput(
  actionKind: AttentionRow['actions'][number]['kind'],
  userText?: string
): Parameters<CoreClient['app']['submitGoalReviewDecision']>[4] | null {
  const detail = userText?.trim();
  if (actionKind === 'accept_review') return { verdict: 'accept' };
  if (actionKind === 'request_refinement' && detail) {
    return { verdict: 'refine', revisionInstruction: detail };
  }
  if (actionKind === 'retry_work' && detail) return { verdict: 'retry', reason: detail };
  if (actionKind === 'abort' && detail) return { verdict: 'abort', reason: detail };
  return null;
}

/** Submit one exact Goal Review decision, then re-read both authoritative query owners. */
export function useSubmitGoalReviewDecision(
  workspaceId: string,
  threadId: string,
  goalId: string,
  reviewId: string
) {
  const client = useCoreClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: Parameters<CoreClient['app']['submitGoalReviewDecision']>[4]) =>
      client.app.submitGoalReviewDecision(workspaceId, threadId, goalId, reviewId, input),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: goalKeys.summary(workspaceId, threadId),
          exact: true,
        }),
        queryClient.invalidateQueries({
          queryKey: workspaceKeys.attention(workspaceId),
          exact: true,
        }),
      ]);
    },
  });
}

/**
 * Load (or create) the reviewable Goal Mode plan when the goal is still in the
 * planning gate. `createThreadGoalPlan` is the App API owner of the plan payload
 * — the summary read model does not embed plan steps.
 */
export function useGoalPlan(
  workspaceId: string | null,
  threadId: string,
  status: ThreadGoalSummary['status'] | undefined
) {
  const client = useCoreClient();
  const needsPlan = status === 'planning' || status === 'awaiting_plan_approval';
  return useQuery({
    queryKey: goalKeys.plan(workspaceId ?? '', threadId),
    queryFn: (): Promise<CreateThreadGoalPlanResponse> =>
      client.app.createThreadGoalPlan(workspaceId as string, threadId, {
        requestId: createRequestId(),
      }),
    enabled: Boolean(workspaceId && threadId && needsPlan),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/** Approve the active Goal Mode plan draft. */
export function useApproveGoalPlan(workspaceId: string, threadId: string) {
  const client = useCoreClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (planItemId: string) =>
      client.app.approveThreadGoalPlan(workspaceId, threadId, {
        planItemId,
        requestId: createRequestId(),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: goalKeys.summary(workspaceId, threadId) });
      void queryClient.invalidateQueries({ queryKey: goalKeys.plan(workspaceId, threadId) });
    },
  });
}

/** Ask Goal Mode to revise the active plan draft. */
export function useReviseGoalPlan(workspaceId: string, threadId: string) {
  const client = useCoreClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (revision: string) =>
      client.app.reviseThreadGoalPlan(workspaceId, threadId, {
        revision,
        requestId: createRequestId(),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: goalKeys.summary(workspaceId, threadId) });
      void queryClient.invalidateQueries({ queryKey: goalKeys.plan(workspaceId, threadId) });
    },
  });
}

/** Submit steering (steer bar) into an active Goal Mode thread. */
export function useSteerGoal(workspaceId: string, threadId: string) {
  const client = useCoreClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (message: string) =>
      client.app.submitThreadGoalSteering(workspaceId, threadId, { message }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: goalKeys.summary(workspaceId, threadId) });
      void queryClient.invalidateQueries({
        queryKey: ['items', workspaceId, threadId],
      });
    },
  });
}

/** Load one artifact for the review surface. */
export function useArtifact(workspaceId: string | null, artifactId: string) {
  const client = useCoreClient();
  return useQuery({
    queryKey: goalKeys.artifact(workspaceId ?? '', artifactId),
    queryFn: (): Promise<GetArtifactResponse> =>
      client.core.getArtifact(workspaceId as string, artifactId),
    enabled: Boolean(workspaceId && artifactId),
  });
}

/** List version-keyed Artifact Reviews for one artifact. */
export function useArtifactReviews(workspaceId: string | null, artifactId: string) {
  const client = useCoreClient();
  return useQuery({
    queryKey: goalKeys.reviews(workspaceId ?? '', artifactId),
    queryFn: async () =>
      (await client.app.listArtifactReviews(workspaceId as string, artifactId)).reviews,
    enabled: Boolean(workspaceId && artifactId),
  });
}

/** Submit one exact version-keyed decision and await its authoritative Review refetch. */
export function useSubmitArtifactReview(
  workspaceId: string,
  artifactId: string,
  artifactVersion: number
) {
  const client = useCoreClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ArtifactReviewDecisionInput) =>
      client.app.submitArtifactReviewDecision(workspaceId, artifactId, artifactVersion, input),
    onSuccess: () =>
      queryClient.refetchQueries({
        queryKey: goalKeys.reviews(workspaceId, artifactId),
        exact: true,
      }),
  });
}
