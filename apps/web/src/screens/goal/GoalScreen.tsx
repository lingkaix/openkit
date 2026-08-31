import { createRequestId } from '@openkit/core-client';
import { useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useConnection } from '../../app/core-client';
import {
  Button,
  Composer,
  ContextChip,
  EmptyState,
  ErrorBanner,
  PhaseStepper,
  Skeleton,
  StatusChip,
  Tabs,
} from '../../primitives';
import { BoardLens } from './BoardLens';
import { CompletedView } from './CompletedView';
import {
  useCurrentWorkspaceId,
  useGoalSummary,
  usePauseThreadGoal,
  useResumeThreadGoal,
  useRunThreadGoalStep,
  useStartThreadGoal,
  useSteerGoal,
} from './data';
import { PlanLens } from './PlanLens';
import { type GoalLens, mapGoalPhase, resolveLens } from './phase';
import { ThreadLens } from './ThreadLens';

const LENS_TABS: { id: GoalLens; label: string }[] = [
  { id: 'thread', label: 'Thread' },
  { id: 'plan', label: 'Plan' },
  { id: 'board', label: 'Board' },
];

/**
 * Goal screen shell (WP-5) — boards 05 / 05b / 05c / 06 / 21.
 *
 * One dataset, three lenses (Thread / Plan / Board) switched via `?lens=`, with
 * a phase stepper for lifecycle and a bottom steer bar (disabled when
 * disconnected). Completed goals show the board-21 closeout on the plan lens.
 */
export function GoalScreen() {
  const { workspaceId: routeWorkspaceId = '', threadId = '' } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const [objective, setObjective] = useState('');
  const startIntent = useRef<{ objective: string; requestId: string } | null>(null);
  const workspaceId = useCurrentWorkspaceId(routeWorkspaceId);
  const summary = useGoalSummary(workspaceId, threadId);
  const { failed: disconnected } = useConnection();
  const start = useStartThreadGoal(workspaceId ?? '', threadId);
  const pause = usePauseThreadGoal(workspaceId ?? '', threadId);
  const resume = useResumeThreadGoal(workspaceId ?? '', threadId);
  const step = useRunThreadGoalStep(workspaceId ?? '', threadId);
  const steer = useSteerGoal(workspaceId ?? '', threadId);
  const lifecyclePending = pause.isPending || resume.isPending || step.isPending;

  /** Submit one trimmed objective with a stable request id across unchanged retries. */
  function submitStart() {
    const trimmed = objective.trim();
    if (!trimmed || disconnected || start.isPending) return;
    const intent =
      startIntent.current?.objective === trimmed
        ? startIntent.current
        : { objective: trimmed, requestId: createRequestId() };
    startIntent.current = intent;
    start.mutate(intent);
  }

  if (summary.isLoading || !workspaceId) {
    return (
      <div className="mx-auto w-full max-w-[760px] px-6 py-8" aria-busy="true">
        <Skeleton lines={2} />
        <div className="mt-6">
          <Skeleton lines={5} />
        </div>
      </div>
    );
  }

  if (summary.isError) {
    return (
      <div className="mx-auto w-full max-w-[760px] px-6 py-8">
        <ErrorBanner message="Couldn't load this goal." onRetry={() => void summary.refetch()} />
      </div>
    );
  }

  const goal = summary.data?.goal;
  if (!goal) {
    return (
      <div className="mx-auto w-full max-w-[760px] px-6 py-8">
        <EmptyState
          icon="folder"
          title="No goal on this thread"
          hint="Start Goal Mode from Chat when you have a multi-step objective."
          action={
            <div className="flex w-full max-w-sm flex-col gap-3">
              <label htmlFor="goal-objective" className="sr-only">
                Goal objective
              </label>
              <textarea
                id="goal-objective"
                value={objective}
                onChange={(event) => setObjective(event.target.value)}
                placeholder="Describe the objective"
                rows={3}
                className="w-full resize-y rounded-ok border border-border bg-card p-3 text-sm text-fg outline-none placeholder:text-fg-muted focus:border-accent focus:ring-2 focus:ring-focus disabled:bg-disabled-bg disabled:text-disabled-fg"
                disabled={disconnected || start.isPending}
              />
              {start.isError ? (
                <ErrorBanner
                  message="Couldn't start Goal Mode."
                  onRetry={disconnected || start.isPending ? undefined : submitStart}
                />
              ) : null}
              <Button
                onPress={submitStart}
                isDisabled={disconnected || start.isPending || !objective.trim()}
              >
                Start Goal
              </Button>
            </div>
          }
        />
      </div>
    );
  }

  const atSafeBoundary = goal.currentTask === null && goal.taskCounts.running === 0;
  const canPause = goal.status === 'running' && atSafeBoundary;
  const canResume = goal.status === 'paused' && atSafeBoundary;
  const canStep = canPause && goal.taskCounts.ready > 0;
  const phaseView = mapGoalPhase(goal.status);
  const lens = resolveLens(searchParams.get('lens'), phaseView.defaultLens);
  function setLens(next: GoalLens) {
    setSearchParams(
      (prev) => {
        const params = new URLSearchParams(prev);
        params.set('lens', next);
        return params;
      },
      { replace: true }
    );
  }

  const lensItems = LENS_TABS.map((tab) => ({
    ...tab,
    content: (
      <div className="mx-auto w-full max-w-[960px] px-6 py-6">
        {tab.id === 'plan' ? (
          goal.status === 'completed' ? (
            <CompletedView goal={goal} />
          ) : (
            <PlanLens
              workspaceId={workspaceId}
              threadId={threadId}
              goal={goal}
              readOnly={disconnected}
            />
          )
        ) : tab.id === 'board' ? (
          <BoardLens
            workspaceId={workspaceId}
            threadId={threadId}
            goal={goal}
            onOpenThread={() => setLens('thread')}
          />
        ) : (
          <ThreadLens
            workspaceId={workspaceId}
            threadId={threadId}
            goal={goal}
            readOnly={disconnected}
          />
        )}
      </div>
    ),
  }));

  return (
    <div className="flex h-full flex-col">
      {pause.isError || resume.isError || step.isError ? (
        <div className="px-6 pt-3">
          <ErrorBanner message="Couldn't update Goal Mode. Try again." />
        </div>
      ) : null}
      <Tabs
        className="flex-1"
        selectedKey={lens}
        onSelectionChange={(key) => setLens(resolveLens(String(key), lens))}
        items={lensItems}
        leading={
          <>
            <PhaseStepper current={phaseView.phase} gate={phaseView.gate} />
            {goal.pendingHumanAttention.required ? (
              <StatusChip tone="notice" dot>
                Needs you
              </StatusChip>
            ) : (
              <StatusChip tone="informative">{goal.status}</StatusChip>
            )}
            {canPause ? (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  onPress={() => pause.mutate()}
                  isDisabled={disconnected || lifecyclePending}
                >
                  Pause Goal
                </Button>
                {canStep ? (
                  <Button
                    size="sm"
                    onPress={() => step.mutate()}
                    isDisabled={disconnected || lifecyclePending}
                  >
                    One bounded step
                  </Button>
                ) : null}
              </>
            ) : canResume ? (
              <Button
                size="sm"
                onPress={() => resume.mutate()}
                isDisabled={disconnected || lifecyclePending}
              >
                Resume Goal
              </Button>
            ) : null}
          </>
        }
        aria-label="Goal lens"
      />

      <div className="border-t border-separator px-6 py-3">
        <div className="mx-auto w-full max-w-[760px]">
          {steer.isError ? (
            <p className="mb-2 text-xs font-medium text-negative-fg">
              Couldn't send that steer. Try again.
            </p>
          ) : null}
          <Composer
            placeholder="Steer the goal — a nudge lands in the Thread lens"
            chips={<ContextChip>Steer</ContextChip>}
            disabledReason={disconnected ? "Couldn't reach the local runtime." : undefined}
            onSubmit={(draft) => steer.mutateAsync(draft.input)}
          />
        </div>
      </div>
    </div>
  );
}
