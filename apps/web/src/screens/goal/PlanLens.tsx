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
  useCreateGoalPlan,
  useGoalPlan,
  useReviseGoalIntent,
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
  const planQuery = useGoalPlan(workspaceId, threadId, goal.goalId);
  const approve = useApproveGoalPlan(workspaceId, threadId);
  const create = useCreateGoalPlan(workspaceId, threadId, goal.goalId);
  const reviseIntent = useReviseGoalIntent(workspaceId, threadId, goal.goalId);
  const revise = useReviseGoalPlan(workspaceId, threadId, goal.goalId);
  const [spendGrant, setSpendGrant] = useState(false);
  const [pushGrant, setPushGrant] = useState(false);
  const [reviseOpen, setReviseOpen] = useState(false);
  const [revision, setRevision] = useState('');
  const [intentOpen, setIntentOpen] = useState(false);
  const [nextObjective, setNextObjective] = useState('');
  const [intentRevision, setIntentRevision] = useState('');
  const [intentScope, setIntentScope] = useState<'all' | 'named' | 'none'>('all');
  const [selectedAffectedTaskIds, setSelectedAffectedTaskIds] = useState<string[]>([]);

  const plan = planQuery.data?.pendingPlan;
  const activePlan = planQuery.data?.activePlan;
  const planTasks = plan?.tasks;
  const planItemId = planQuery.data?.pendingPlanItemId;
  const steps = buildDisplaySteps(goal, planTasks, Boolean(plan));
  const planningAction = planQuery.data?.planningAction;
  const draftRevision = planQuery.data?.draftRevision;
  const continuePlanning = planQuery.data?.continuePlanning;
  const selectableAffectedTasks = planQuery.data?.selectableAffectedTasks ?? [];
  const namedScopeValid =
    selectedAffectedTaskIds.length > 0 &&
    selectedAffectedTaskIds.every((id) =>
      selectableAffectedTasks.some((task) => task.taskId === id)
    );
  const terminal = ['completed', 'blocked', 'aborted', 'failed'].includes(goal.status);

  /** Submit exact intent scope: omission means all, an empty array means none. */
  function submitIntentRevision() {
    const objective = nextObjective.trim();
    const revision = intentRevision.trim();
    if (!objective || !revision || (intentScope === 'named' && !namedScopeValid)) return;
    const affectedTaskIds =
      intentScope === 'all'
        ? undefined
        : intentScope === 'none'
          ? []
          : selectableAffectedTasks
              .filter((task) => selectedAffectedTaskIds.includes(task.taskId))
              .map((task) => task.taskId);
    reviseIntent.mutate(
      { objective, revision, ...(affectedTaskIds === undefined ? {} : { affectedTaskIds }) },
      {
        onSuccess: () => {
          setIntentOpen(false);
          setIntentRevision('');
        },
      }
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1.5">
        <h1 className="text-title font-extrabold text-fg-strong">
          {goal.title === goal.objective ? 'Goal plan' : goal.title}
        </h1>
        <p className="text-sm text-fg-muted whitespace-pre-wrap">{goal.objective}</p>
        {goal.pendingHumanAttention.required && goal.pendingHumanAttention.reason ? (
          <div>
            <StatusChip tone="notice" dot>
              Needs you
            </StatusChip>
            <p className="mt-1.5 whitespace-pre-wrap text-sm text-fg-muted">
              {goal.pendingHumanAttention.reason}
            </p>
          </div>
        ) : null}
      </header>

      <GoalReviewGate
        workspaceId={workspaceId}
        threadId={threadId}
        goal={goal}
        readOnly={readOnly}
      />

      {!terminal && !readOnly ? (
        <Card>
          <div className="flex items-center justify-between gap-3">
            <div>
              <Eyebrow>Goal intent</Eyebrow>
              <p className="mt-1 text-sm text-fg-muted">
                Revise this Goal's objective. Remaining work waits for a Plan that addresses it.
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              onPress={() => {
                setNextObjective(goal.objective);
                setIntentScope('all');
                setSelectedAffectedTaskIds([]);
                setIntentOpen((open) => !open);
              }}
              isDisabled={reviseIntent.isPending}
            >
              Revise goal intent
            </Button>
          </div>
          {intentOpen ? (
            <div className="mt-3 flex flex-col gap-3">
              <label htmlFor="revised-goal-objective" className="text-sm font-medium text-fg">
                Revised objective
              </label>
              <textarea
                id="revised-goal-objective"
                rows={3}
                value={nextObjective}
                onChange={(event) => setNextObjective(event.target.value)}
                className="w-full resize-y rounded-ok border border-border bg-card p-2 text-sm text-fg outline-none focus-visible:ring-2 focus-visible:ring-focus"
              />
              <TextField
                label="What changed and why"
                value={intentRevision}
                onChange={setIntentRevision}
              />
              <fieldset className="flex flex-col gap-2 text-sm text-fg">
                <legend className="mb-1 font-medium">Current approved work to reassess</legend>
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="intent-affected-scope"
                    checked={intentScope === 'all'}
                    onChange={() => setIntentScope('all')}
                  />
                  All remaining work
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="intent-affected-scope"
                    checked={intentScope === 'named'}
                    onChange={() => setIntentScope('named')}
                    disabled={selectableAffectedTasks.length === 0}
                  />
                  Named Tasks
                </label>
                {intentScope === 'named' ? (
                  <div className="ml-5 flex flex-col gap-1">
                    {selectableAffectedTasks.map((task) => (
                      <label key={task.taskId} className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={selectedAffectedTaskIds.includes(task.taskId)}
                          onChange={(event) =>
                            setSelectedAffectedTaskIds((current) =>
                              event.target.checked
                                ? [...current, task.taskId]
                                : current.filter((id) => id !== task.taskId)
                            )
                          }
                        />
                        {task.title} ({task.taskId}, {task.status})
                      </label>
                    ))}
                    {!namedScopeValid && selectedAffectedTaskIds.length > 0 ? (
                      <p className="text-xs text-negative-fg">
                        A selected Task is no longer available. Update the selection.
                      </p>
                    ) : null}
                  </div>
                ) : null}
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="intent-affected-scope"
                    checked={intentScope === 'none'}
                    onChange={() => setIntentScope('none')}
                  />
                  No current work
                </label>
              </fieldset>
              {reviseIntent.isError ? (
                <ErrorBanner message="Couldn't revise the Goal intent." />
              ) : null}
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="quiet" onPress={() => setIntentOpen(false)}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  onPress={submitIntentRevision}
                  isDisabled={
                    reviseIntent.isPending ||
                    !nextObjective.trim() ||
                    !intentRevision.trim() ||
                    (intentScope === 'named' && !namedScopeValid)
                  }
                >
                  Save revised intent
                </Button>
              </div>
            </div>
          ) : null}
        </Card>
      ) : null}

      <Card>
        <Eyebrow>Plan</Eyebrow>
        {planQuery.isError ? (
          <div className="mt-3">
            <ErrorBanner
              message="Couldn't load the current Goal plan."
              onRetry={() => void planQuery.refetch()}
            />
          </div>
        ) : planQuery.isLoading ? (
          <div className="mt-3" aria-busy="true">
            <Skeleton lines={4} />
          </div>
        ) : plan ? (
          <div className="mt-3 flex flex-col gap-3">
            {planQuery.data?.pendingPlanItemSummary ? (
              <section aria-label="Proposal context" className="text-sm text-fg">
                <p className="text-xs font-bold uppercase tracking-eyebrow text-fg-muted">
                  Proposal context
                </p>
                <p className="mt-1 whitespace-pre-wrap">{planQuery.data.pendingPlanItemSummary}</p>
              </section>
            ) : null}
            <details className="text-sm text-fg">
              <summary className="cursor-pointer text-sm text-fg-muted">Plan details</summary>
              <div className="mt-2 flex min-w-0 flex-col gap-3">
                <div>
                  <p className="text-xs font-bold uppercase tracking-eyebrow text-fg-muted">
                    Plan summary
                  </p>
                  <p className="mt-1 whitespace-pre-wrap">{plan.goalSummary}</p>
                </div>
                {plan.assumptions.length > 0 ? (
                  <div>
                    <p className="text-xs font-bold uppercase tracking-eyebrow text-fg-muted">
                      Assumptions
                    </p>
                    <ul className="mt-1 list-disc pl-5">
                      {plan.assumptions.map((assumption, index) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: immutable plan order identifies duplicate-allowed entries
                        <li key={`${index}:${assumption}`} className="whitespace-pre-wrap">
                          {assumption}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {plan.risks.length > 0 ? (
                  <div>
                    <p className="text-xs font-bold uppercase tracking-eyebrow text-fg-muted">
                      Risks
                    </p>
                    <ul className="mt-1 list-disc pl-5">
                      {plan.risks.map((risk, index) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: immutable plan order identifies duplicate-allowed entries
                        <li key={`${index}:${risk}`} className="whitespace-pre-wrap">
                          {risk}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                <div>
                  <p className="text-xs font-bold uppercase tracking-eyebrow text-fg-muted">
                    Questions
                  </p>
                  {plan.questions.length > 0 ? (
                    <ul className="mt-1 list-disc pl-5">
                      {plan.questions.map((question, index) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: immutable plan order identifies duplicate-allowed entries
                        <li key={`${index}:${question}`} className="whitespace-pre-wrap">
                          {question}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-1 text-fg-muted">No open questions</p>
                  )}
                </div>
                <div>
                  <p className="text-xs font-bold uppercase tracking-eyebrow text-fg-muted">
                    Verification approach
                  </p>
                  <p className="mt-1 whitespace-pre-wrap">{plan.verificationApproach}</p>
                </div>
              </div>
            </details>
            <ol className="flex flex-col">
              {plan.tasks.map((task, index) => {
                const step = steps.find((candidate) => candidate.taskId === task.taskId);
                return (
                  <li
                    key={task.taskId}
                    className="border-t border-separator py-2.5 first:border-t-0"
                  >
                    <div className="flex items-center gap-3">
                      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-sunken text-xs font-bold text-fg-muted">
                        {index + 1}
                      </span>
                      <span className="min-w-0 flex-1 text-sm font-medium text-fg">
                        {task.title}
                      </span>
                      {step ? <StatusChip tone={step.tone}>{step.chip}</StatusChip> : null}
                    </div>
                    <details className="mt-2 text-sm text-fg">
                      <summary className="cursor-pointer text-sm text-fg-muted">
                        Task details
                      </summary>
                      <div className="mt-2 flex min-w-0 flex-col gap-3">
                        <div>
                          <p className="text-xs font-bold uppercase tracking-eyebrow text-fg-muted">
                            Objective
                          </p>
                          <p className="mt-1 whitespace-pre-wrap">{task.objective}</p>
                        </div>
                        <div>
                          <p className="text-xs font-bold uppercase tracking-eyebrow text-fg-muted">
                            Acceptance criteria
                          </p>
                          <ul className="mt-1 list-disc pl-5">
                            {task.acceptanceCriteria.map((criterion, index) => (
                              // biome-ignore lint/suspicious/noArrayIndexKey: immutable plan order identifies duplicate-allowed entries
                              <li key={`${index}:${criterion}`} className="whitespace-pre-wrap">
                                {criterion}
                              </li>
                            ))}
                          </ul>
                        </div>
                        <div>
                          <p className="text-xs font-bold uppercase tracking-eyebrow text-fg-muted">
                            Context token budget
                          </p>
                          <p className="mt-1 whitespace-pre-wrap">
                            {String(task.contextBudgetTokens)}
                          </p>
                        </div>
                        {task.resources.length > 0 ? (
                          <div>
                            <p className="text-xs font-bold uppercase tracking-eyebrow text-fg-muted">
                              Declared resources
                            </p>
                            <ul className="mt-1 list-disc pl-5">
                              {task.resources.map((resource, index) => (
                                <li
                                  // biome-ignore lint/suspicious/noArrayIndexKey: immutable plan order identifies duplicate-allowed entries
                                  key={`${index}:${resource.kind}:${resource.reference}:${resource.reason}`}
                                  className="whitespace-pre-wrap"
                                >
                                  {resource.kind}: {resource.reference} — {resource.reason}
                                </li>
                              ))}
                            </ul>
                          </div>
                        ) : null}
                        {task.expectedArtifacts.length > 0 ? (
                          <div>
                            <p className="text-xs font-bold uppercase tracking-eyebrow text-fg-muted">
                              Expected outputs
                            </p>
                            <ul className="mt-1 list-disc pl-5">
                              {task.expectedArtifacts.map((artifact, index) => (
                                <li
                                  // biome-ignore lint/suspicious/noArrayIndexKey: immutable plan order identifies duplicate-allowed entries
                                  key={`${index}:${artifact.kind}:${artifact.description}`}
                                  className="whitespace-pre-wrap"
                                >
                                  {artifact.kind}: {artifact.description}
                                </li>
                              ))}
                            </ul>
                          </div>
                        ) : null}
                        <div>
                          <p className="text-xs font-bold uppercase tracking-eyebrow text-fg-muted">
                            Checks
                          </p>
                          <ul className="mt-1 list-disc pl-5">
                            {task.verificationChecks.map((check, index) => (
                              <li
                                // biome-ignore lint/suspicious/noArrayIndexKey: immutable plan order identifies duplicate-allowed entries
                                key={`${index}:${check.kind}:${check.description}:${check.command ?? ''}`}
                                className="min-w-0"
                              >
                                <p className="whitespace-pre-wrap">
                                  {check.kind}: {check.description}
                                </p>
                                {check.command ? (
                                  <p className="mt-0.5 whitespace-pre-wrap">{check.command}</p>
                                ) : null}
                              </li>
                            ))}
                          </ul>
                        </div>
                        <div>
                          <p className="text-xs font-bold uppercase tracking-eyebrow text-fg-muted">
                            Human review
                          </p>
                          <p className="mt-1 whitespace-pre-wrap">
                            {task.reviewPolicy.required ? 'Required' : 'Not required'}.{' '}
                            {task.reviewPolicy.instructions}
                          </p>
                        </div>
                        {task.dependsOnTaskIds.length > 0 ? (
                          <div>
                            <p className="text-xs font-bold uppercase tracking-eyebrow text-fg-muted">
                              Dependencies
                            </p>
                            <ul className="mt-1 list-disc pl-5">
                              {task.dependsOnTaskIds.map((dependencyId, index) => (
                                <li
                                  // biome-ignore lint/suspicious/noArrayIndexKey: immutable plan order identifies duplicate-allowed entries
                                  key={`${index}:${dependencyId}`}
                                  className="whitespace-pre-wrap"
                                >
                                  {dependencyId}
                                </li>
                              ))}
                            </ul>
                          </div>
                        ) : null}
                        {task.escalationConditions.length > 0 ? (
                          <div>
                            <p className="text-xs font-bold uppercase tracking-eyebrow text-fg-muted">
                              Escalation conditions
                            </p>
                            <ul className="mt-1 list-disc pl-5">
                              {task.escalationConditions.map((condition, index) => (
                                // biome-ignore lint/suspicious/noArrayIndexKey: immutable plan order identifies duplicate-allowed entries
                                <li key={`${index}:${condition}`} className="whitespace-pre-wrap">
                                  {condition}
                                </li>
                              ))}
                            </ul>
                          </div>
                        ) : null}
                      </div>
                    </details>
                  </li>
                );
              })}
            </ol>
            {plan.taskDispositions.length > 0 ? (
              <section
                aria-label="Remaining work changes"
                className="border-t border-separator pt-3"
              >
                <p className="text-xs font-bold uppercase tracking-eyebrow text-fg-muted">
                  Remaining work changes
                </p>
                <ol className="mt-2 flex flex-col gap-3">
                  {plan.taskDispositions.map((disposition) => {
                    const predecessor = activePlan?.tasks.find(
                      (task) => task.taskId === disposition.taskId
                    );
                    const successor = plan.tasks.find(
                      (task) => task.taskId === disposition.successorTaskId
                    );
                    return (
                      <li key={disposition.taskId} className="text-sm text-fg">
                        <p className="font-medium">
                          {predecessor?.title ?? disposition.taskId} →{' '}
                          {successor?.title ?? 'Ends without successor'}
                        </p>
                        <p className="mt-0.5 text-xs text-fg-muted">
                          {disposition.taskId} → {disposition.successorTaskId ?? 'none'}
                        </p>
                        <p className="mt-1 whitespace-pre-wrap">{disposition.reason}</p>
                      </li>
                    );
                  })}
                </ol>
              </section>
            ) : null}
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
                <span className="min-w-0 flex-1 text-sm font-medium text-fg">{step.title}</span>
                <StatusChip tone={step.tone}>{step.chip}</StatusChip>
              </li>
            ))}
          </ol>
        )}
      </Card>

      {plan && activePlan ? (
        <Card>
          <Eyebrow>Current approved work</Eyebrow>
          <p className="mt-1 text-xs text-fg-muted">
            This Plan remains active until the candidate is approved. Affected Tasks wait for the
            revision.
          </p>
          <ol className="mt-3 flex flex-col">
            {activePlan.tasks.map((task) => (
              <li
                key={task.taskId}
                className="flex items-center gap-3 border-t border-separator py-2.5 first:border-t-0"
              >
                <span className="min-w-0 flex-1 text-sm text-fg">{task.title}</span>
                {goal.currentTask?.taskId === task.taskId ? (
                  <StatusChip tone="informative">{goal.currentTask.status}</StatusChip>
                ) : null}
              </li>
            ))}
          </ol>
        </Card>
      ) : null}

      {plan ? (
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

      {planItemId && planQuery.data?.canApprovePendingPlan && !readOnly ? (
        <div className="flex items-center gap-3 rounded-ok-lg bg-info-bg px-4 py-3">
          <p className="min-w-0 flex-1 text-sm font-medium text-info-fg">
            Review this exact Plan before it authorizes affected work.
          </p>
          {planningAction === 'await_approval' ? (
            <Button
              size="sm"
              variant="outline"
              onPress={() => setReviseOpen((v) => !v)}
              isDisabled={revise.isPending}
            >
              Adjust plan
            </Button>
          ) : null}
          <Button
            size="sm"
            onPress={() => approve.mutate(planItemId)}
            isDisabled={approve.isPending || revise.isPending}
          >
            Approve plan
          </Button>
        </div>
      ) : null}

      {planItemId &&
      !planQuery.data?.canApprovePendingPlan &&
      planningAction === 'await_approval' &&
      !readOnly ? (
        <Card>
          <Eyebrow>Plan needs a new draft</Eyebrow>
          <p className="mt-1 text-sm text-fg-muted">
            This candidate is no longer eligible for approval. Request a revision from the current
            Goal state.
          </p>
          <Button size="sm" variant="outline" onPress={() => setReviseOpen((open) => !open)}>
            Request revised plan
          </Button>
        </Card>
      ) : null}

      {!readOnly && !terminal && planQuery.data?.activePlanItemId && planningAction === 'none' ? (
        <Button size="sm" variant="outline" onPress={() => setReviseOpen((open) => !open)}>
          Request revised plan
        </Button>
      ) : null}

      {approve.isError ? (
        <ErrorBanner
          message="Couldn't approve this Plan. Refresh its status before retrying."
          onRetry={() => void planQuery.refetch()}
        />
      ) : null}
      {revise.isError ? (
        <ErrorBanner
          message="Couldn't request that Plan revision. Refresh its status before retrying."
          onRetry={() => void planQuery.refetch()}
        />
      ) : null}

      {!readOnly && !terminal && planningAction === 'draft_revision' && draftRevision ? (
        <Card>
          <Eyebrow>Revised Plan requested</Eyebrow>
          <p className="mt-1 text-sm text-fg-muted">
            The revision instruction is recorded. Draft its successor Plan for review.
          </p>
          <Button
            size="sm"
            onPress={() =>
              create.mutate({
                previousPendingPlanItemId: planItemId ?? null,
                source: draftRevision.itemId,
              })
            }
            isDisabled={create.isPending}
          >
            Draft revised plan
          </Button>
        </Card>
      ) : null}
      {!readOnly && !terminal && planningAction === 'retry' ? (
        <Card>
          <Eyebrow>Planning needs another attempt</Eyebrow>
          <p className="mt-1 text-sm text-fg-muted">
            The last attempt failed. Start a new request from the current Goal.
          </p>
          <Button
            size="sm"
            onPress={() =>
              create.mutate({ previousPendingPlanItemId: planItemId ?? null, source: 'retry' })
            }
            isDisabled={create.isPending}
          >
            Retry planning
          </Button>
        </Card>
      ) : null}
      {planningAction === 'answer_question' ? (
        <Card>
          <Eyebrow>Planning question</Eyebrow>
          <p className="mt-1 text-sm text-fg-muted">
            Answer the open question in the Thread lens before planning continues.
          </p>
          <Button size="sm" variant="outline" onPress={() => void planQuery.refetch()}>
            Refresh planning status
          </Button>
        </Card>
      ) : null}
      {!readOnly && !terminal && planningAction === 'continue_planning' && continuePlanning ? (
        <Card>
          <Eyebrow>Planning answer recorded</Eyebrow>
          <p className="mt-1 text-sm text-fg-muted">
            Continue from the answered question with a new planning request.
          </p>
          <Button
            size="sm"
            onPress={() =>
              create.mutate({
                previousPendingPlanItemId: planItemId ?? null,
                source: continuePlanning.responseItemId,
              })
            }
            isDisabled={create.isPending}
          >
            Continue planning
          </Button>
        </Card>
      ) : null}
      {planningAction === 'in_progress' ? (
        <p className="text-sm text-fg-muted">Planning is in progress.</p>
      ) : null}
      {create.isError ? (
        <ErrorBanner
          message="Couldn't draft the Plan. Refresh its status before trying again."
          onRetry={() => void planQuery.refetch()}
        />
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
                revise.mutate(
                  {
                    revision: trimmed,
                    predecessorPlanItemId: planItemId ?? planQuery.data?.activePlanItemId ?? null,
                  },
                  {
                    onSuccess: () => {
                      setRevision('');
                      setReviseOpen(false);
                    },
                  }
                );
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
