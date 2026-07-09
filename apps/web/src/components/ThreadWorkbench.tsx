import { ItemDeltaEventSchema, ItemSchema } from '@openkit/protocol';
import { createMemo, createSignal, For, Match, Show, Switch } from 'solid-js';
import type { z } from 'zod';

import type {
  Item,
  ThreadGoalPlanReview,
  ThreadGoalSummary,
  Turn,
  TurnEvent,
} from '../lib/app-types';
import { ApprovalCard } from './ApprovalCard';
import { ChatComposer, type ChatComposerMode, type ChatComposerModelOption } from './ChatComposer';
import { QuestionCard } from './QuestionCard';

type ApprovalRequestItem = Extract<Item, { type: 'approval-request' }>;
type ApprovalDecision = 'granted' | 'denied';
type UserInputRequestItem = Extract<Item, { type: 'user-input-request' }>;
type ProductWorkMode = 'chat' | 'automation' | 'plan' | 'review' | 'organize' | 'delegation';
type TerminalAttentionStatus = Extract<Turn['status'], 'failed' | 'interrupted' | 'cancelled'>;
/**
 * Known item-created payload that passed strict item validation.
 */
type StrictItemCreatedEvent = Extract<TurnEvent['data'], { type: 'item-created' }> & {
  item: Item;
};
/**
 * Known item-completed payload that passed strict item validation.
 */
type StrictItemCompletedEvent = Extract<TurnEvent['data'], { type: 'item-completed' }> & {
  item: Item;
};
/**
 * Known item-delta payload that passed strict delta validation.
 */
type StrictItemDeltaEvent = z.infer<typeof ItemDeltaEventSchema>;

/**
 * Latest artifact summary shown in the work status band.
 */
export interface ThreadWorkbenchArtifact {
  id: string;
  title: string;
  status: string;
  summary: string | null;
  updatedAt: string;
}

/**
 * Props for the active thread composer and streamed item list.
 */
export interface ThreadWorkbenchProps {
  activeTurnStatus: Turn['status'] | 'idle';
  canInterrupt: boolean;
  canQuickChat: boolean;
  canStartTurn: boolean;
  composerMode: ChatComposerMode;
  goal: ThreadGoalSummary | null;
  goalPlan: ThreadGoalPlanReview | null;
  goalPlanFeedback: string | null;
  isApprovingGoalPlan: boolean;
  isAnsweringUserInput: boolean;
  isCreatingGoalPlan: boolean;
  isInterrupting: boolean;
  isRunningGoalStep: boolean;
  isSubmittingGoalSteering: boolean;
  isStartingGoal: boolean;
  isStartingTurn: boolean;
  isRespondingToApproval: boolean;
  items: Item[];
  currentMode: ProductWorkMode;
  latestArtifact: ThreadWorkbenchArtifact | null;
  models: ChatComposerModelOption[];
  pendingApprovalCount: number;
  pendingQuestionCount: number;
  goalSteeringFeedback: string | null;
  quickChatDisabledMessage: string;
  quickChatResponse: string | null;
  routingExplanation: string;
  selectedAgentId: string | null;
  selectedModelId: string | null;
  selectedWorkspaceId: string | null;
  threadArtifacts: ThreadWorkbenchArtifact[];
  workerConnectionStatus: string;
  workspaceName: string;
  onInterrupt(): Promise<void>;
  onModelChange(modelId: string | null): void;
  onModeChange(mode: ChatComposerMode): void;
  onApproveGoalPlan(planReview: ThreadGoalPlanReview): Promise<void>;
  onCreateGoalPlan(): Promise<void>;
  onOpenArtifact(artifactId: string): void;
  /** Opens the workspace-level Action Center for the current thread context. */
  onOpenActionCenter?(): void;
  onOpenItemLog(): void;
  onRejectGoalPlan(): void;
  onReviseGoalPlan(): void;
  onRunGoalStep(): Promise<void>;
  onStartGoal(objective: string): Promise<void>;
  onSubmitGoalSteering(message: string): Promise<void>;
  onSubmitQuickChat(prompt: string, modelId: string | null): Promise<void>;
  onRespondApproval(item: ApprovalRequestItem, decision: ApprovalDecision): Promise<void>;
  onSubmitUserInput(item: UserInputRequestItem, answer: string): Promise<void>;
  onSubmitTurn(prompt: string, modelId: string | null): Promise<void>;
}

/**
 * Upserts one item into the streamed item list.
 */
function upsertItem(items: Item[], item: Item): Item[] {
  const exists = items.some((candidate) => candidate.id === item.id);

  if (!exists) {
    return [...items, item];
  }

  return items.map((candidate) => (candidate.id === item.id ? item : candidate));
}

/**
 * Applies text-like item deltas to the optimistic item snapshot.
 */
function appendItemDelta(items: Item[], itemId: string, delta: string): Item[] {
  return items.map((item) => {
    if (item.id !== itemId) {
      return item;
    }

    if (item.type === 'assistant-message') {
      return { ...item, text: `${item.text}${delta}` };
    }

    if (item.type === 'reasoning') {
      return { ...item, content: [...item.content, delta] };
    }

    if (item.type === 'command-execution') {
      return { ...item, output: `${item.output ?? ''}${delta}` };
    }

    return item;
  });
}

/**
 * Checks whether a tolerant stream payload contains a strict item-created event.
 */
function isItemCreatedEvent(data: TurnEvent['data']): data is StrictItemCreatedEvent {
  return data.type === 'item-created' && 'item' in data && ItemSchema.safeParse(data.item).success;
}

/**
 * Checks whether a tolerant stream payload contains a strict item-completed event.
 */
function isItemCompletedEvent(data: TurnEvent['data']): data is StrictItemCompletedEvent {
  return (
    data.type === 'item-completed' && 'item' in data && ItemSchema.safeParse(data.item).success
  );
}

/**
 * Checks whether a tolerant stream payload contains a strict item-delta event.
 */
function isItemDeltaEvent(data: TurnEvent['data']): data is StrictItemDeltaEvent {
  return data.type === 'item-delta' && ItemDeltaEventSchema.safeParse(data).success;
}

/**
 * Extracts a text-like delta from a bounded item delta payload.
 */
function textFromItemDelta(event: StrictItemDeltaEvent): string | null {
  switch (event.deltaKind) {
    case 'text-delta':
    case 'indexed-text-delta':
    case 'output-delta':
    case 'interaction-delta':
      return event.delta;
    case 'progress-updated':
      return event.progress.message;
    case 'artifact-updated':
      return event.summary ?? event.artifactId;
    case 'knowledge-injection-updated':
      return event.summary ?? event.knowledgeEntryIds.join(', ');
    case 'part-started':
    case 'request-started':
    case 'request-resolved':
    case 'snapshot-updated':
      return null;
  }
}

/**
 * Reconciles streamed turn item events into the rendered item list.
 */
export function reconcileTurnItems(items: Item[], event: TurnEvent): Item[] {
  if (isItemCreatedEvent(event.data)) {
    return upsertItem(items, event.data.item);
  }

  if (isItemDeltaEvent(event.data)) {
    const delta = textFromItemDelta(event.data);
    return delta === null ? items : appendItemDelta(items, event.data.itemId, delta);
  }

  if (isItemCompletedEvent(event.data)) {
    return upsertItem(items, event.data.item);
  }

  return items;
}

/**
 * Returns display text for one streamed item.
 */
function itemContent(item: Item): string {
  switch (item.type) {
    case 'user-message':
    case 'assistant-message':
      return item.text;
    case 'reasoning':
      return [...item.summary, ...item.content].join('\n');
    case 'command-execution':
      return [
        item.command,
        item.cwd,
        item.exitCode === null ? null : `exit ${item.exitCode}`,
        item.output ? item.output : null,
      ]
        .filter(Boolean)
        .join('\n');
    case 'file-change':
      return `${item.changeKind}: ${item.path}`;
    case 'artifact-reference':
      return [item.title, item.summary].filter(Boolean).join('\n');
    case 'approval-request':
      return `${item.title}\n${item.description}`;
    case 'approval-decision':
      return item.decision;
    case 'user-input-request':
      return item.prompt;
    case 'user-input-response':
      return JSON.stringify(item.answers);
    case 'tool-call':
      return [item.tool, item.result, item.error].filter(Boolean).join('\n');
    case 'agent-handoff':
      return [item.fromAgentId, item.toAgentId, item.reason].filter(Boolean).join('\n');
    case 'status':
      return [item.title, item.summary].filter(Boolean).join('\n');
    case 'plan':
      return [
        item.title,
        item.summary,
        ...item.steps.map((step) => `${step.status}: ${step.title}`),
      ]
        .filter(Boolean)
        .join('\n');
    case 'knowledge-injection':
      return [item.summary, item.policySummary, ...item.knowledgeEntryIds]
        .filter(Boolean)
        .join('\n');
  }
}

/**
 * Returns whether a terminal turn status needs a visible recovery action.
 */
function isTerminalAttentionStatus(
  status: Turn['status'] | 'idle'
): status is TerminalAttentionStatus {
  return status === 'failed' || status === 'interrupted' || status === 'cancelled';
}

/**
 * Returns whether the worker connection needs user attention.
 */
function workerConnectionNeedsAttention(status: string): boolean {
  return status === 'failed' || status === 'closed' || status === 'degraded';
}

/**
 * Formats one Goal Mode lifecycle status for product-facing display.
 */
function formatGoalStatus(status: string): string {
  return status
    .split('_')
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

/**
 * Summarizes recent Goal Mode task progress.
 */
function goalProgressSummary(goal: ThreadGoalSummary): string {
  return [
    `${goal.taskCounts.completed} completed`,
    `${goal.taskCounts.running} running`,
    `${goal.taskCounts.reviewing} in review`,
    `${goal.taskCounts.ready} ready`,
  ].join(', ');
}

/**
 * Summarizes the current Goal Mode task for display.
 */
function goalCurrentTaskText(goal: ThreadGoalSummary): string {
  if (goal.currentTask) {
    return `${goal.currentTask.title} (${formatGoalStatus(goal.currentTask.status)})`;
  }

  return goal.status === 'planning' ? 'Waiting for plan review.' : 'No active task.';
}

/**
 * Checks whether a goal status can still accept steering input.
 */
function canGoalAcceptSteering(goal: ThreadGoalSummary): boolean {
  return !['completed', 'blocked', 'aborted', 'failed'].includes(goal.status);
}

/**
 * Formats a compact list of ids for terminal summaries.
 */
function formatIdList(ids: readonly string[]): string {
  return ids.length > 0 ? ids.join(', ') : 'None';
}

/**
 * Renders the thread prompt composer and streamed conversation items.
 */
export function ThreadWorkbench(props: ThreadWorkbenchProps) {
  const [turnPromptDraft, setTurnPromptDraft] = createSignal('');
  const [goalObjectiveDraft, setGoalObjectiveDraft] = createSignal('');
  const [goalSteeringDraft, setGoalSteeringDraft] = createSignal('');
  const canSubmitTurn = createMemo(
    () =>
      turnPromptDraft().trim().length > 0 &&
      !props.isStartingTurn &&
      (props.composerMode === 'quick' ? props.canQuickChat : props.canStartTurn)
  );
  const completedApprovalIds = createMemo(
    () =>
      new Set(
        props.items
          .filter((item): item is Extract<Item, { type: 'approval-decision' }> => {
            return item.type === 'approval-decision';
          })
          .map((item) => item.approvalRequestId)
      )
  );
  const completedUserInputIds = createMemo(
    () =>
      new Set(
        props.items
          .filter((item): item is Extract<Item, { type: 'user-input-response' }> => {
            return item.type === 'user-input-response';
          })
          .map((item) => item.userInputRequestId)
      )
  );
  const pendingApprovals = createMemo(() =>
    props.items.filter((item): item is ApprovalRequestItem => {
      return (
        item.type === 'approval-request' && !completedApprovalIds().has(item.approvalRequestId)
      );
    })
  );
  const pendingQuestions = createMemo(() =>
    props.items.filter((item): item is UserInputRequestItem => {
      return (
        item.type === 'user-input-request' && !completedUserInputIds().has(item.userInputRequestId)
      );
    })
  );
  const visibleArtifacts = createMemo(() =>
    (props.threadArtifacts ?? []).length > 0
      ? props.threadArtifacts
      : props.latestArtifact
        ? [props.latestArtifact]
        : []
  );
  const attentionCount = createMemo(
    () =>
      pendingApprovals().length +
      pendingQuestions().length +
      (isTerminalAttentionStatus(props.activeTurnStatus) ? 1 : 0) +
      (workerConnectionNeedsAttention(props.workerConnectionStatus) ? 1 : 0)
  );
  const canStartGoal = createMemo(
    () => goalObjectiveDraft().trim().length > 0 && !props.goal && !props.isStartingGoal
  );
  const canCreateGoalPlan = createMemo(
    () =>
      props.goal?.status === 'planning' &&
      !props.goalPlan &&
      !props.isCreatingGoalPlan &&
      !props.isApprovingGoalPlan
  );
  const canActOnGoalPlan = createMemo(
    () => !!props.goalPlan && !props.isApprovingGoalPlan && !props.isCreatingGoalPlan
  );
  const canSubmitGoalSteering = createMemo(
    () =>
      !!props.goal &&
      canGoalAcceptSteering(props.goal) &&
      goalSteeringDraft().trim().length > 0 &&
      !props.isSubmittingGoalSteering
  );
  const canRunGoalStep = createMemo(
    () =>
      !!props.goal &&
      props.goal.status === 'running' &&
      props.goal.taskCounts.ready + props.goal.taskCounts.running > 0 &&
      props.activeTurnStatus === 'idle' &&
      !props.isRunningGoalStep
  );

  /**
   * Finds a known artifact summary by id.
   */
  function findThreadArtifact(artifactId: string): ThreadWorkbenchArtifact | null {
    return props.threadArtifacts.find((artifact) => artifact.id === artifactId) ?? null;
  }

  /**
   * Submits the current prompt through the parent thread runner.
   */
  async function submitTurn(prompt: string, mode: ChatComposerMode, modelId: string | null) {
    if (!prompt || !canSubmitTurn()) {
      return;
    }

    if (mode === 'quick') {
      await props.onSubmitQuickChat(prompt, modelId);
    } else {
      await props.onSubmitTurn(prompt, modelId);
    }
    setTurnPromptDraft('');
  }

  /**
   * Starts Goal Mode for the current thread.
   */
  async function submitGoal(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const objective = goalObjectiveDraft().trim();

    if (!objective || !canStartGoal()) {
      return;
    }

    await props.onStartGoal(objective);
    setGoalObjectiveDraft('');
  }

  /**
   * Submits Goal Mode steering for the active goal.
   */
  async function submitGoalSteering(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const message = goalSteeringDraft().trim();

    if (!message || !canSubmitGoalSteering()) {
      return;
    }

    await props.onSubmitGoalSteering(message);
    setGoalSteeringDraft('');
  }

  return (
    <>
      <section class="workspace-panel mt-6" aria-label="Goal Mode">
        <div class="ui-section-header mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 class="font-display text-xl font-semibold text-base-content">Goal Mode</h2>
          <span class="badge badge-outline">
            {props.goal ? formatGoalStatus(props.goal.status) : 'Ready'}
          </span>
        </div>
        <Show
          when={props.goal}
          fallback={
            <form class="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto]" onSubmit={submitGoal}>
              <label class="form-control ui-field">
                <span class="label-text">Goal objective</span>
                <textarea
                  class="textarea textarea-bordered min-h-24"
                  name="goalObjective"
                  value={goalObjectiveDraft()}
                  onInput={(event) => setGoalObjectiveDraft(event.currentTarget.value)}
                  placeholder="Make this release ready for end users."
                />
              </label>
              <div class="flex items-end">
                <button
                  class="btn btn-neutral w-full md:w-auto"
                  disabled={!canStartGoal()}
                  type="submit"
                >
                  {props.isStartingGoal ? 'Starting goal' : 'Start goal'}
                </button>
              </div>
            </form>
          }
        >
          {(goal) => (
            <div class="space-y-4">
              <div class="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto]">
                <div class="space-y-2">
                  <h3 class="font-semibold">{goal().title}</h3>
                  <p class="text-sm leading-7 opacity-70">{goal().objective}</p>
                </div>
                <div class="flex flex-wrap items-start gap-2">
                  <span class="badge badge-outline">{formatGoalStatus(goal().status)}</span>
                  <span class="badge badge-outline">{goal().taskCounts.ready} ready</span>
                  <span class="badge badge-outline">{goal().taskCounts.completed} completed</span>
                  <button
                    class="btn btn-sm btn-neutral"
                    disabled={!canRunGoalStep()}
                    onClick={() => void props.onRunGoalStep()}
                    type="button"
                  >
                    {props.isRunningGoalStep ? 'Running step' : 'Run next step'}
                  </button>
                </div>
              </div>
              <div class="grid gap-3 md:grid-cols-2">
                <div class="space-y-1">
                  <span class="metric-label">Current task</span>
                  <p class="text-sm font-semibold">{goalCurrentTaskText(goal())}</p>
                </div>
                <div class="space-y-1">
                  <span class="metric-label">Progress</span>
                  <p class="text-sm font-semibold">{goalProgressSummary(goal())}</p>
                </div>
              </div>
              <div class="flex flex-wrap gap-2">
                <Show when={goal().steering.pendingSteeringCount > 0}>
                  <span class="badge badge-info badge-outline">
                    Queued steering: {goal().steering.pendingSteeringCount}
                  </span>
                </Show>
                <Show when={goal().steering.appliedSteeringCount > 0}>
                  <span class="badge badge-success badge-outline">
                    Applied steering: {goal().steering.appliedSteeringCount}
                  </span>
                </Show>
                <Show when={goal().steering.pendingFollowUpCount > 0}>
                  <span class="badge badge-warning badge-outline">
                    Blocked input: {goal().steering.pendingFollowUpCount}
                  </span>
                </Show>
              </div>
              <Show when={canGoalAcceptSteering(goal())}>
                <form
                  class="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto]"
                  onSubmit={submitGoalSteering}
                >
                  <label class="form-control ui-field">
                    <span class="label-text">Steering input</span>
                    <textarea
                      class="textarea textarea-bordered min-h-20"
                      name="goalSteering"
                      value={goalSteeringDraft()}
                      onInput={(event) => setGoalSteeringDraft(event.currentTarget.value)}
                      placeholder="Adjust priority, constraints, or next steps."
                    />
                  </label>
                  <div class="flex items-end">
                    <button
                      class="btn btn-outline w-full md:w-auto"
                      disabled={!canSubmitGoalSteering()}
                      type="submit"
                    >
                      {props.isSubmittingGoalSteering ? 'Submitting' : 'Submit steering'}
                    </button>
                  </div>
                </form>
              </Show>
              <Show when={props.goalSteeringFeedback}>
                {(feedback) => (
                  <div class="rounded-md border border-info/40 bg-info/10 p-3 text-sm">
                    {feedback()}
                  </div>
                )}
              </Show>
              <Show when={goal().pendingHumanAttention.required}>
                <div class="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
                  <div class="flex flex-wrap items-center justify-between gap-2">
                    <span>
                      {goal().pendingHumanAttention.reason ??
                        'Human input is needed before continuing.'}
                    </span>
                    <Show when={props.onOpenActionCenter}>
                      {(onOpenActionCenter) => (
                        <button
                          class="btn btn-warning btn-xs"
                          onClick={onOpenActionCenter()}
                          type="button"
                        >
                          Open Action Center
                        </button>
                      )}
                    </Show>
                  </div>
                </div>
              </Show>
              <Show when={goal().terminalState}>
                {(terminalState) => (
                  <div class="space-y-3 rounded-md border border-success/40 bg-success/10 p-3 text-sm">
                    <p class="font-semibold">
                      Finished with {formatGoalStatus(terminalState().status)}.
                    </p>
                    <Show when={goal().terminalSummary}>
                      {(terminalSummary) => (
                        <div class="grid gap-3 md:grid-cols-2">
                          <div>
                            <p class="metric-label">Completed tasks</p>
                            <p>{formatIdList(terminalSummary().completedTaskIds)}</p>
                          </div>
                          <div>
                            <p class="metric-label">Blocked tasks</p>
                            <p>{formatIdList(terminalSummary().blockedTaskIds)}</p>
                          </div>
                          <Show when={terminalSummary().verificationEvidence.length > 0}>
                            <div class="md:col-span-2">
                              <p class="metric-label">Verification evidence</p>
                              <ul class="mt-2 space-y-2">
                                <For each={terminalSummary().verificationEvidence}>
                                  {(evidence) => (
                                    <li>
                                      <span class="font-semibold">
                                        {formatGoalStatus(evidence.status)}
                                      </span>
                                      <span>{`: ${evidence.summary}`}</span>
                                      <Show when={evidence.command}>
                                        {(command) => (
                                          <code class="ml-2 rounded bg-base-100 px-2 py-1">
                                            {command()}
                                          </code>
                                        )}
                                      </Show>
                                    </li>
                                  )}
                                </For>
                              </ul>
                            </div>
                          </Show>
                          <Show when={terminalSummary().artifactIds.length > 0}>
                            <div class="md:col-span-2">
                              <p class="metric-label">Artifacts</p>
                              <div class="mt-2 flex flex-wrap gap-2">
                                <For each={terminalSummary().artifactIds}>
                                  {(artifactId) => {
                                    const artifact = findThreadArtifact(artifactId);

                                    return (
                                      <button
                                        class="btn btn-xs btn-outline"
                                        onClick={() => props.onOpenArtifact(artifactId)}
                                        type="button"
                                      >
                                        Open {artifact?.title ?? artifactId}
                                      </button>
                                    );
                                  }}
                                </For>
                              </div>
                            </div>
                          </Show>
                          <Show when={terminalSummary().risks.length > 0}>
                            <div>
                              <p class="metric-label">Risks</p>
                              <ul class="mt-2 list-disc space-y-1 pl-5">
                                <For each={terminalSummary().risks}>
                                  {(risk) => <li>{risk}</li>}
                                </For>
                              </ul>
                            </div>
                          </Show>
                          <Show when={terminalSummary().suggestedNextWork.length > 0}>
                            <div>
                              <p class="metric-label">Next steps</p>
                              <ul class="mt-2 list-disc space-y-1 pl-5">
                                <For each={terminalSummary().suggestedNextWork}>
                                  {(work) => <li>{work}</li>}
                                </For>
                              </ul>
                            </div>
                          </Show>
                        </div>
                      )}
                    </Show>
                  </div>
                )}
              </Show>
            </div>
          )}
        </Show>
      </section>
      <Show when={props.goal?.status === 'planning' || props.goalPlan}>
        <section class="workspace-panel mt-6" aria-label="Goal plan review">
          <div class="ui-section-header mb-4 flex flex-wrap items-center justify-between gap-3">
            <h2 class="font-display text-xl font-semibold text-base-content">Plan review</h2>
            <span class="badge badge-outline">
              {props.goalPlan ? 'Ready for review' : 'Plan needed'}
            </span>
          </div>
          <Show
            when={props.goalPlan}
            fallback={
              <div class="flex flex-wrap items-center justify-between gap-3">
                <p class="text-sm leading-7 opacity-70">
                  Draft a bounded plan before work starts so each task can be reviewed first.
                </p>
                <button
                  class="btn btn-outline"
                  disabled={!canCreateGoalPlan()}
                  onClick={() => void props.onCreateGoalPlan()}
                  type="button"
                >
                  {props.isCreatingGoalPlan ? 'Drafting plan' : 'Draft plan'}
                </button>
              </div>
            }
          >
            {(planReview) => (
              <div class="space-y-4">
                <div>
                  <h3 class="font-semibold">{planReview().plan.goalSummary}</h3>
                  <p class="mt-2 text-sm leading-7 opacity-70">
                    {planReview().plan.verificationApproach}
                  </p>
                </div>
                <Show when={planReview().plan.assumptions.length > 0}>
                  <div>
                    <p class="metric-label">Assumptions</p>
                    <ul class="mt-2 list-disc space-y-1 pl-5 text-sm leading-7">
                      <For each={planReview().plan.assumptions}>
                        {(assumption) => <li>{assumption}</li>}
                      </For>
                    </ul>
                  </div>
                </Show>
                <div class="grid gap-3 md:grid-cols-2">
                  <For each={planReview().plan.tasks}>
                    {(task) => (
                      <article class="metric-tile">
                        <div class="flex flex-wrap items-center justify-between gap-2">
                          <h3 class="font-semibold">{task.title}</h3>
                          <span class="badge badge-outline badge-sm">{task.taskId}</span>
                        </div>
                        <p class="mt-2 text-sm leading-7 opacity-70">{task.objective}</p>
                        <ul class="mt-2 list-disc space-y-1 pl-5 text-sm leading-7">
                          <For each={task.acceptanceCriteria}>
                            {(criterion) => <li>{criterion}</li>}
                          </For>
                        </ul>
                      </article>
                    )}
                  </For>
                </div>
                <Show when={planReview().plan.questions.length > 0}>
                  <div>
                    <p class="metric-label">Questions to answer</p>
                    <ul class="mt-2 list-disc space-y-1 pl-5 text-sm leading-7">
                      <For each={planReview().plan.questions}>
                        {(question) => <li>{question}</li>}
                      </For>
                    </ul>
                  </div>
                </Show>
                <Show when={props.goalPlanFeedback}>
                  <div class="rounded-md border border-info/40 bg-info/10 p-3 text-sm">
                    {props.goalPlanFeedback}
                  </div>
                </Show>
                <div class="flex flex-wrap gap-2">
                  <button
                    class="btn btn-neutral"
                    disabled={!canActOnGoalPlan()}
                    onClick={() => void props.onApproveGoalPlan(planReview())}
                    type="button"
                  >
                    {props.isApprovingGoalPlan ? 'Approving plan' : 'Approve plan'}
                  </button>
                  <button
                    class="btn btn-outline"
                    disabled={!canActOnGoalPlan()}
                    onClick={props.onRejectGoalPlan}
                    type="button"
                  >
                    Reject plan
                  </button>
                  <button
                    class="btn btn-outline"
                    disabled={!canActOnGoalPlan()}
                    onClick={props.onReviseGoalPlan}
                    type="button"
                  >
                    Request changes
                  </button>
                </div>
              </div>
            )}
          </Show>
        </section>
      </Show>
      <section class="workspace-panel mt-6" aria-label="Work status">
        <div class="ui-section-header mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 class="font-display text-xl font-semibold text-base-content">Work status</h2>
          <div class="flex flex-wrap items-center gap-2">
            <span class="badge badge-outline">{props.currentMode}</span>
            <span class="badge badge-outline">{props.activeTurnStatus}</span>
          </div>
        </div>
        <div class="grid gap-3 md:grid-cols-4">
          <div class="space-y-1">
            <span class="metric-label">Selected agent</span>
            <p class="text-sm font-semibold">{props.selectedAgentId ?? 'No agent selected'}</p>
          </div>
          <div class="space-y-1">
            <span class="metric-label">Pending approval</span>
            <p class="text-sm font-semibold">
              {props.pendingApprovalCount}{' '}
              {props.pendingApprovalCount === 1 ? 'approval' : 'approvals'}
            </p>
          </div>
          <div class="space-y-1">
            <span class="metric-label">Pending question</span>
            <p class="text-sm font-semibold">
              {props.pendingQuestionCount}{' '}
              {props.pendingQuestionCount === 1 ? 'question' : 'questions'}
            </p>
          </div>
          <div class="space-y-1">
            <span class="metric-label">Latest artifact</span>
            <p class="text-sm font-semibold">{props.latestArtifact?.title ?? 'No artifact yet'}</p>
          </div>
        </div>
        <p class="mt-4 text-sm leading-7 opacity-70">{props.routingExplanation}</p>
        <Show when={isTerminalAttentionStatus(props.activeTurnStatus)}>
          <div class="mt-4 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
            This turn is {props.activeTurnStatus}. Start a follow-up turn or inspect the latest
            artifacts before continuing.
          </div>
        </Show>
        <Show when={workerConnectionNeedsAttention(props.workerConnectionStatus)}>
          <div class="mt-3 rounded-md border border-error/40 bg-error/10 p-3 text-sm">
            Worker connection needs attention. Refresh agent health or open Settings before starting
            more work.
          </div>
        </Show>
      </section>
      <section class="workspace-panel mt-6" aria-label="Artifacts">
        <div class="ui-section-header mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 class="font-display text-xl font-semibold text-base-content">Artifacts</h2>
          <span class="badge badge-outline">{visibleArtifacts().length}</span>
        </div>
        <Show
          when={visibleArtifacts().length > 0}
          fallback={<div class="empty-state">No current thread artifacts yet.</div>}
        >
          <div class="grid gap-3 md:grid-cols-2">
            <For each={visibleArtifacts()}>
              {(artifact) => (
                <article class="metric-tile">
                  <div class="flex flex-wrap items-center justify-between gap-2">
                    <h3 class="font-semibold">{artifact.title}</h3>
                    <span class="badge badge-outline badge-sm">{artifact.status}</span>
                  </div>
                  <p class="mt-2 text-sm opacity-70">{artifact.summary ?? artifact.id}</p>
                  <button
                    class="btn btn-outline btn-sm mt-3"
                    onClick={() => props.onOpenArtifact(artifact.id)}
                    type="button"
                  >
                    Open {artifact.title}
                  </button>
                </article>
              )}
            </For>
          </div>
        </Show>
      </section>
      <Show when={attentionCount() > 0}>
        <section class="workspace-panel mt-6" aria-label="Attention needed">
          <div class="ui-section-header mb-4 flex flex-wrap items-center justify-between gap-3">
            <h2 class="font-display text-xl font-semibold text-base-content">Attention needed</h2>
            <span class="badge badge-warning">{attentionCount()} pending</span>
          </div>
          <div class="space-y-3">
            <Show when={isTerminalAttentionStatus(props.activeTurnStatus)}>
              <div class="approval-placeholder">
                This turn is {props.activeTurnStatus}. Start a follow-up turn or inspect artifacts
                before continuing.
              </div>
            </Show>
            <Show when={workerConnectionNeedsAttention(props.workerConnectionStatus)}>
              <div class="approval-placeholder">
                Worker connection needs attention. Refresh agent health before continuing.
              </div>
            </Show>
            <For each={pendingApprovals()}>
              {(item) => (
                <article class="approval-placeholder">
                  <span class="badge badge-outline badge-sm">approval</span>
                  <h3 class="mt-2 font-semibold">{item.title}</h3>
                  <p class="mt-1 text-sm opacity-70">{item.description}</p>
                  <p class="mt-2 text-xs uppercase tracking-[0.16em] opacity-60">
                    Respond in the conversation below
                  </p>
                </article>
              )}
            </For>
            <For each={pendingQuestions()}>
              {(item) => (
                <article class="approval-placeholder">
                  <span class="badge badge-outline badge-sm">question</span>
                  <h3 class="mt-2 font-semibold">{item.questions[0]?.header ?? 'Question'}</h3>
                  <p class="mt-1 text-sm opacity-70">{item.prompt}</p>
                  <p class="mt-2 text-xs uppercase tracking-[0.16em] opacity-60">
                    Answer in the conversation below
                  </p>
                </article>
              )}
            </For>
          </div>
        </section>
      </Show>
      <section class="mt-6 space-y-3" aria-label="Turn composer">
        <ChatComposer
          ariaLabel="Turn composer form"
          canSubmit={canSubmitTurn()}
          inputLabel="Turn prompt"
          isSubmitting={props.isStartingTurn}
          mode={props.composerMode}
          models={props.models}
          onInput={setTurnPromptDraft}
          onModeChange={props.onModeChange}
          onModelChange={props.onModelChange}
          onSubmit={(input) => void submitTurn(input.input, input.mode, input.modelId)}
          placeholder="Review the protocol and surface the next approval gate."
          quickChatDisabledMessage={props.quickChatDisabledMessage}
          quickChatEnabled={props.canQuickChat}
          selectedModelId={props.selectedModelId}
          selectedWorkspaceId={props.selectedWorkspaceId}
          submitLabel="Send turn"
          value={turnPromptDraft()}
          workspaceLocked={true}
          workspaces={
            props.selectedWorkspaceId
              ? [{ id: props.selectedWorkspaceId, name: props.workspaceName }]
              : []
          }
        />
        <div class="flex flex-wrap gap-2">
          <button
            class="btn btn-outline"
            disabled={!props.canInterrupt}
            onClick={() => void props.onInterrupt()}
            type="button"
          >
            Stop turn
          </button>
          <button class="btn btn-outline" onClick={props.onOpenItemLog} type="button">
            Open item log
          </button>
        </div>
      </section>

      <div class="workspace-panel conversation-panel">
        <div class="ui-section-header mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 class="font-display text-xl font-semibold text-base-content">Conversation</h2>
          <div class="flex flex-wrap items-center gap-2">
            <Show when={props.isInterrupting}>
              <span class="badge badge-warning">interrupting</span>
            </Show>
            <span class="badge badge-outline">{props.activeTurnStatus}</span>
          </div>
        </div>

        <div class="space-y-3">
          <Show when={props.quickChatResponse}>
            <article class="conversation-item conversation-item-assistant">
              <span class="badge badge-outline badge-sm">quick-chat</span>
              <p class="mt-3 whitespace-pre-wrap text-sm leading-7 text-base-content">
                {props.quickChatResponse}
              </p>
            </article>
          </Show>
          <Show
            when={props.items.length > 0}
            fallback={
              <div class="empty-state">
                No streamed items yet. Start a turn to watch the protocol shape become visible.
              </div>
            }
          >
            <For each={props.items}>
              {(item) => (
                <article
                  class={`conversation-item ${
                    item.type === 'user-message'
                      ? 'conversation-item-user'
                      : 'conversation-item-assistant'
                  }`}
                >
                  <div class="flex items-center justify-between gap-3">
                    <span class="badge badge-outline badge-sm">{item.type}</span>
                    <span class="text-xs uppercase tracking-[0.16em] opacity-60">
                      {item.status}
                    </span>
                  </div>
                  <Switch>
                    <Match when={item.type === 'approval-request'}>
                      <div class="mt-3">
                        <ApprovalCard
                          disabled={
                            props.isRespondingToApproval ||
                            completedApprovalIds().has(
                              (item as ApprovalRequestItem).approvalRequestId
                            )
                          }
                          item={item as ApprovalRequestItem}
                          onRespond={(approvalRequestId, decision) => {
                            void approvalRequestId;
                            void props.onRespondApproval(item as ApprovalRequestItem, decision);
                          }}
                        />
                      </div>
                    </Match>
                    <Match when={item.type === 'user-input-request'}>
                      <div class="mt-3">
                        <QuestionCard
                          disabled={
                            props.isAnsweringUserInput ||
                            completedUserInputIds().has(
                              (item as UserInputRequestItem).userInputRequestId
                            )
                          }
                          item={item as UserInputRequestItem}
                          onSubmit={(requestItem, answer) => {
                            void props.onSubmitUserInput(requestItem, answer);
                          }}
                        />
                      </div>
                    </Match>
                    <Match when={item.type === 'artifact-reference'}>
                      <div class="mt-3">
                        <p class="whitespace-pre-wrap text-sm leading-7 text-base-content">
                          {itemContent(item)}
                        </p>
                        <button
                          class="btn btn-outline btn-sm mt-3"
                          onClick={() =>
                            props.onOpenArtifact(
                              (item as Extract<Item, { type: 'artifact-reference' }>).artifactId
                            )
                          }
                          type="button"
                        >
                          View artifact
                        </button>
                      </div>
                    </Match>
                    <Match when={itemContent(item).length > 0}>
                      <p class="mt-3 whitespace-pre-wrap text-sm leading-7 text-base-content">
                        {itemContent(item)}
                      </p>
                    </Match>
                  </Switch>
                </article>
              )}
            </For>
          </Show>
        </div>
      </div>
    </>
  );
}
