import type { StatusTone } from '../../primitives';
import type { ThreadGoalSummary } from './data';

/** Goal surface lens — Thread (time), Plan (lifecycle), Board (status). */
export type GoalLens = 'thread' | 'plan' | 'board';

export interface GoalPhaseView {
  /** Lifecycle phase lit on the stepper. */
  phase: 'draft' | 'plan' | 'execute' | 'review';
  /** When true, the current phase is an approval gate (notice tone). */
  gate: boolean;
  /** Default lens when the URL does not specify one. */
  defaultLens: GoalLens;
}

/**
 * Map a Goal Mode read-model status to the phase stepper, gate flag, and default
 * lens (DESIGN.md §9.5, D-008). Chips carry point-in-time detail; the stepper
 * only reflects lifecycle.
 */
export function mapGoalPhase(status: ThreadGoalSummary['status']): GoalPhaseView {
  switch (status) {
    case 'planning':
      return { phase: 'draft', gate: false, defaultLens: 'thread' };
    case 'awaiting_plan_approval':
      return { phase: 'plan', gate: true, defaultLens: 'thread' };
    case 'running':
    case 'paused':
    case 'awaiting_user':
      return { phase: 'execute', gate: false, defaultLens: 'plan' };
    case 'reviewing':
      return { phase: 'review', gate: true, defaultLens: 'plan' };
    case 'completed':
    case 'blocked':
    case 'aborted':
    case 'failed':
      return { phase: 'review', gate: false, defaultLens: 'plan' };
  }
}

/**
 * Resolve the active lens from the URL search param, falling back to the
 * phase-derived default. Board is always opt-in.
 */
export function resolveLens(searchLens: string | null, fallback: GoalLens): GoalLens {
  if (searchLens === 'thread' || searchLens === 'plan' || searchLens === 'board') {
    return searchLens;
  }
  return fallback;
}

/** One display step derived from the plan payload or the goal summary. */
export interface DisplayPlanStep {
  taskId: string;
  title: string;
  /** Pre-approval steps read "Planned"; live chips use task status labels. */
  chip: string;
  /** Semantic tone for the status chip. */
  tone: StatusTone;
}

/**
 * Build plan-lens steps. Prefer the reviewable plan tasks (all "Planned" at the
 * gate); otherwise derive a truthful display from `currentTask` + `taskCounts`.
 */
export function buildDisplaySteps(
  goal: ThreadGoalSummary,
  planTasks?: ReadonlyArray<{ taskId: string; title: string }> | null,
  preApproval = false
): DisplayPlanStep[] {
  if (planTasks && planTasks.length > 0) {
    return planTasks.map((task) => {
      if (preApproval) {
        return { taskId: task.taskId, title: task.title, chip: 'Planned', tone: 'neutral' };
      }
      const current = goal.currentTask;
      if (current && current.taskId === task.taskId) {
        return {
          taskId: task.taskId,
          title: task.title,
          chip: labelForTaskStatus(current.status),
          tone: toneForTaskStatus(current.status),
        };
      }
      return { taskId: task.taskId, title: task.title, chip: 'Queued', tone: 'neutral' };
    });
  }

  const steps: DisplayPlanStep[] = [];
  if (goal.currentTask) {
    steps.push({
      taskId: goal.currentTask.taskId,
      title: goal.currentTask.title,
      chip: labelForTaskStatus(goal.currentTask.status),
      tone: toneForTaskStatus(goal.currentTask.status),
    });
  }
  if (goal.taskCounts.pending > 0) {
    steps.push({
      taskId: 'pending-summary',
      title: `${goal.taskCounts.pending} pending task${goal.taskCounts.pending === 1 ? '' : 's'}`,
      chip: 'Queued',
      tone: 'neutral',
    });
  }
  if (goal.taskCounts.completed > 0 && !goal.terminalSummary) {
    steps.push({
      taskId: 'completed-summary',
      title: `${goal.taskCounts.completed} completed`,
      chip: 'Done',
      tone: 'positive',
    });
  }
  return steps;
}

/** Human label for a goal task status. */
function labelForTaskStatus(status: string): string {
  switch (status) {
    case 'pending':
      return 'Queued';
    case 'ready':
      return 'Ready';
    case 'running':
      return 'Running';
    case 'reviewing':
      return 'Review';
    case 'completed':
      return 'Done';
    case 'blocked':
      return 'Blocked';
    case 'failed':
      return 'Failed';
    default:
      return status;
  }
}

/** Status-chip tone for a goal task status. */
function toneForTaskStatus(status: string): StatusTone {
  switch (status) {
    case 'running':
    case 'ready':
      return 'informative';
    case 'reviewing':
      return 'notice';
    case 'completed':
      return 'positive';
    case 'blocked':
    case 'failed':
      return 'negative';
    default:
      return 'neutral';
  }
}
