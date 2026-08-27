import { useState } from 'react';
import { useConnection } from '../../app/core-client';
import {
  Button,
  Card,
  Dialog,
  ErrorBanner,
  Eyebrow,
  Modal,
  Skeleton,
  StatusChip,
  Switch,
  TextField,
} from '../../primitives';
import { type AttentionRow, useHumanAttention } from '../workspace/data';
import type { ThreadGoalSummary } from './data';
import {
  goalReviewDecisionInput,
  selectCurrentGoalReview,
  useApproveGoalPlan,
  useGoalPlan,
  useReviseGoalPlan,
  useSubmitGoalReviewDecision,
} from './data';
import { buildDisplaySteps } from './phase';

export interface PlanLensProps {
  workspaceId: string;
  threadId: string;
  goal: ThreadGoalSummary;
  /** When true, approve/adjust actions are unavailable. */
  readOnly?: boolean;
}

/** Inputs required to project one current Goal Review gate in any Goal lens. */
export interface GoalReviewGateProps {
  /** Workspace containing the current Goal Review. */
  workspaceId: string;
  /** Thread containing the current Goal Review. */
  threadId: string;
  /** Full authoritative Goal summary used to select the current Task lineage. */
  goal: ThreadGoalSummary;
  /** Additional caller-owned read-only posture. */
  readOnly?: boolean;
}

/** Inputs for one Goal Review action that requires user-authored text. */
interface GoalReviewTextActionProps {
  /** Exact Action Center action being rendered. */
  action: AttentionRow['actions'][number];
  /** Whether the action may submit. */
  disabled: boolean;
  /** Submit user-supplied text for the exact action kind. */
  onSubmit: (actionKind: AttentionRow['actions'][number]['kind'], userText: string) => void;
}

/** Collect the required user-authored instruction or reason for one Goal Review action. */
function GoalReviewTextAction({ action, disabled, onSubmit }: GoalReviewTextActionProps) {
  const [userText, setUserText] = useState('');
  const refinement = action.kind === 'request_refinement';
  const fieldLabel = refinement ? 'Revision instruction' : 'Reason';

  return (
    <Modal
      trigger={
        <Button
          size="sm"
          variant={action.kind === 'abort' ? 'negative-outline' : 'outline'}
          isDisabled={disabled}
        >
          {action.label}
        </Button>
      }
    >
      <Dialog title={action.label}>
        <p className="text-sm text-fg-muted">
          {refinement
            ? 'Describe the exact revision the next attempt should make.'
            : 'Give the reason that should accompany this decision.'}
        </p>
        <TextField
          label={fieldLabel}
          value={userText}
          onChange={setUserText}
          isDisabled={disabled}
        />
        <div className="flex justify-end gap-2">
          <Button slot="close" size="sm" variant="quiet">
            Cancel
          </Button>
          <Button
            size="sm"
            variant={action.kind === 'abort' ? 'negative' : 'accent'}
            onPress={() => onSubmit(action.kind, userText)}
            isDisabled={disabled || !userText.trim()}
          >
            {action.label}
          </Button>
        </div>
      </Dialog>
    </Modal>
  );
}

/**
 * Render the exact current Goal Review gate from the shared Action Center query.
 *
 * The gate is shared by Plan, Board, and Thread without changing lens or route state.
 */
export function GoalReviewGate({ workspaceId, threadId, goal, readOnly }: GoalReviewGateProps) {
  const attention = useHumanAttention(goal.status === 'reviewing' ? workspaceId : null);
  const review = selectCurrentGoalReview(attention.data ?? [], goal);
  const reviewId = review?.source.type === 'goal_review' ? review.source.reviewId : '';
  const decide = useSubmitGoalReviewDecision(workspaceId, threadId, goal.goalId, reviewId);
  const { failed: disconnected } = useConnection();
  const disabled = Boolean(readOnly || disconnected || attention.isError || decide.isPending);

  /** Submit only a complete canonical input derived from this exact row action. */
  function submit(actionKind: AttentionRow['actions'][number]['kind'], userText?: string) {
    if (disabled || !review || review.source.type !== 'goal_review') return;
    const input = goalReviewDecisionInput(actionKind, userText);
    if (input) decide.mutate(input);
  }

  if (goal.status !== 'reviewing') return null;
  if (attention.isError && !review) {
    return (
      <ErrorBanner
        message="Couldn't load the current Goal Review."
        onRetry={() => void attention.refetch()}
      />
    );
  }
  if (!review && attention.isLoading) {
    return (
      <Card>
        <Eyebrow>Goal Review</Eyebrow>
        <p className="mt-1 text-sm font-medium text-fg">Current review details are loading.</p>
        {(readOnly || disconnected) && !decide.isPending ? (
          <p className="mt-2 text-sm text-fg-muted">
            Review actions are read-only while disconnected.
          </p>
        ) : (
          <Button
            size="sm"
            variant="outline"
            aria-label="Review worker output"
            onPress={() => void attention.refetch()}
          >
            Open review
          </Button>
        )}
      </Card>
    );
  }
  if (!review) return null;

  return (
    <>
      {attention.isError ? (
        <ErrorBanner
          message="Couldn't load the current Goal Review."
          onRetry={() => void attention.refetch()}
        />
      ) : null}
      <Card>
        <div className="flex items-start justify-between gap-3">
          <div>
            <Eyebrow>Goal Review</Eyebrow>
            <h2 className="mt-1 text-base font-extrabold text-fg-strong">{review.title}</h2>
            <p className="mt-1 text-sm text-fg-muted">{review.summary}</p>
          </div>
          <StatusChip tone="notice" dot>
            Needs you
          </StatusChip>
        </div>
        {decide.isError ? (
          <div className="mt-3">
            <ErrorBanner message="Couldn't submit that review decision. Try again." />
          </div>
        ) : null}
        {(readOnly || disconnected) && !decide.isPending ? (
          <p className="mt-3 text-sm text-fg-muted">
            Review actions are read-only while disconnected.
          </p>
        ) : null}
        <div className="mt-4 flex flex-wrap gap-2">
          {review.actions.map((action) =>
            action.kind === 'accept_review' ? (
              <Button
                key={action.kind}
                size="sm"
                onPress={() => submit(action.kind)}
                isDisabled={disabled}
              >
                {action.label}
              </Button>
            ) : (
              <GoalReviewTextAction
                key={action.kind}
                action={action}
                disabled={disabled}
                onSubmit={submit}
              />
            )
          )}
        </div>
      </Card>
    </>
  );
}

/**
 * Plan lens (boards 05 / 05b) — objective, plan steps, autonomy grants (local UI
 * preference), and the plan approval gate. Pre-approval chips read "Planned";
 * after approval the same steps show live status chips.
 */
export function PlanLens({ workspaceId, threadId, goal, readOnly }: PlanLensProps) {
  const preApproval = goal.status === 'planning' || goal.status === 'awaiting_plan_approval';
  const planQuery = useGoalPlan(workspaceId, threadId, goal.status);
  const approve = useApproveGoalPlan(workspaceId, threadId);
  const revise = useReviseGoalPlan(workspaceId, threadId);
  const [spendGrant, setSpendGrant] = useState(false);
  const [pushGrant, setPushGrant] = useState(false);
  const [reviseOpen, setReviseOpen] = useState(false);
  const [revision, setRevision] = useState('');

  const planTasks = planQuery.data?.plan.tasks;
  const planItemId = planQuery.data?.planItemId;
  const steps = buildDisplaySteps(goal, planTasks, preApproval);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1.5">
        <h1 className="text-title font-extrabold text-fg-strong">{goal.title}</h1>
        <p className="text-sm text-fg-muted">{goal.objective}</p>
        {goal.pendingHumanAttention.required && goal.pendingHumanAttention.reason ? (
          <StatusChip tone="notice" dot>
            {goal.pendingHumanAttention.reason}
          </StatusChip>
        ) : null}
      </header>

      <GoalReviewGate
        workspaceId={workspaceId}
        threadId={threadId}
        goal={goal}
        readOnly={readOnly}
      />

      <Card>
        <Eyebrow>Plan</Eyebrow>
        {preApproval && planQuery.isLoading ? (
          <div className="mt-3" aria-busy="true">
            <Skeleton lines={4} />
          </div>
        ) : steps.length === 0 ? (
          <p className="mt-3 text-sm text-fg-muted">No plan steps yet.</p>
        ) : (
          <ol className="mt-3 flex flex-col">
            {steps.map((step, index) => (
              <li
                key={step.taskId}
                className="flex items-center gap-3 border-t border-separator py-2.5 first:border-t-0"
              >
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-sunken text-xs font-bold text-fg-muted">
                  {index + 1}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">
                  {step.title}
                </span>
                <StatusChip tone={step.tone}>{step.chip}</StatusChip>
              </li>
            ))}
          </ol>
        )}
      </Card>

      {preApproval ? (
        <Card>
          <div className="flex flex-col gap-0.5">
            <Eyebrow>Autonomy grants</Eyebrow>
            <p className="text-xs text-fg-muted">
              Local preferences at the gate — they do not write to the kernel.
            </p>
          </div>
          <div className="mt-3 flex flex-col">
            <div className="flex items-center justify-between gap-3 border-t border-separator py-2.5 first:border-t-0">
              <div>
                <p className="text-sm font-medium text-fg">Spend up to a small budget</p>
                <p className="text-xs text-fg-muted">Ask before any paid capability call.</p>
              </div>
              <Switch isSelected={spendGrant} onChange={setSpendGrant} isDisabled={readOnly}>
                Spend grant
              </Switch>
            </div>
            <div className="flex items-center justify-between gap-3 border-t border-separator py-2.5">
              <div>
                <p className="text-sm font-medium text-fg">Push to remote</p>
                <p className="text-xs text-fg-muted">Require approval before git push.</p>
              </div>
              <Switch isSelected={pushGrant} onChange={setPushGrant} isDisabled={readOnly}>
                Push grant
              </Switch>
            </div>
          </div>
        </Card>
      ) : null}

      {preApproval && planItemId && !readOnly ? (
        <div className="flex items-center gap-3 rounded-ok-lg bg-info-bg px-4 py-3">
          <p className="min-w-0 flex-1 text-sm font-medium text-info-fg">
            Review the plan, then approve to start execution — or adjust it.
          </p>
          <Button
            size="sm"
            variant="outline"
            onPress={() => setReviseOpen((v) => !v)}
            isDisabled={revise.isPending}
          >
            Adjust plan
          </Button>
          <Button
            size="sm"
            onPress={() => approve.mutate(planItemId)}
            isDisabled={approve.isPending}
          >
            Approve plan
          </Button>
        </div>
      ) : null}

      {reviseOpen && !readOnly ? (
        <Card>
          <Eyebrow>Adjust plan</Eyebrow>
          <textarea
            className="mt-2 w-full resize-y rounded-ok border border-border bg-card p-2 text-sm text-fg outline-none focus-visible:ring-2 focus-visible:ring-focus"
            rows={3}
            aria-label="Plan revision"
            value={revision}
            onChange={(e) => setRevision(e.target.value)}
            placeholder="Describe how the plan should change…"
          />
          <div className="mt-2 flex justify-end gap-2">
            <Button size="sm" variant="quiet" onPress={() => setReviseOpen(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              onPress={() => {
                const trimmed = revision.trim();
                if (!trimmed) return;
                revise.mutate(trimmed, {
                  onSuccess: () => {
                    setRevision('');
                    setReviseOpen(false);
                  },
                });
              }}
              isDisabled={revise.isPending || !revision.trim()}
            >
              Submit revision
            </Button>
          </div>
        </Card>
      ) : null}
    </div>
  );
}
