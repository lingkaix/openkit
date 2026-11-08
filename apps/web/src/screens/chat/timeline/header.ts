import { fillCopy, timelineCopy } from './copy';
import { taskSpecObjective } from './present';
import { formatRelativeAge, stalenessLabel } from './time';

/** A plan older than this is labeled with its age. */
export const STALE_PLAN_MS = 2 * 60 * 1000;

export interface HeaderPlanStep {
  title: string;
  status: string;
}

export interface HeaderItem {
  id?: string;
  type: string;
  createdAt: string;
  turnId: string;
  text?: string;
  steps?: readonly HeaderPlanStep[];
}

export interface AlignmentModel {
  objective: string | null;
  progress: string | null;
  staleLabel: string | null;
  planCreatedAt: string | null;
  statusLabel: string;
  finishedAt: string | null;
}

function latestPlan(
  items: readonly HeaderItem[]
): (HeaderItem & { steps: readonly HeaderPlanStep[] }) | null {
  const plans = items.filter(
    (item): item is HeaderItem & { steps: readonly HeaderPlanStep[] } =>
      item.type === 'plan' && Array.isArray(item.steps)
  );
  if (plans.length === 0) return null;
  return plans.reduce((best, plan) =>
    Date.parse(plan.createdAt) >= Date.parse(best.createdAt) ? plan : best
  );
}

/**
 * Task header: objective, plan progress across runs, and status.
 * Assistant and every other profile keep the title the screen already shows.
 * // The latest plan is the newest plan item on any run, not only the latest run.
 */
export function buildAlignment(input: {
  profileId: string;
  now: number;
  taskInputs?: readonly { itemId?: string; objective: string }[];
  items: readonly HeaderItem[];
  turn?: { status: string; completedAt?: string | null; startedAt?: string | null } | null;
}): AlignmentModel | null {
  if (input.profileId !== 'task') return null;
  const loaded = new Set(input.items.flatMap((item) => (item.id ? [item.id] : [])));
  // A summary belongs to the message it names. A mismatched id is not the task objective.
  const recorded = input.taskInputs
    ?.filter((entry) => !entry.itemId || loaded.has(entry.itemId))
    .map((entry) => entry.objective.trim())
    .find((value) => value.length > 0);
  let objective = recorded ?? null;
  if (!objective) {
    for (const item of input.items) {
      if (item.type !== 'user-message' || !item.text) continue;
      objective = taskSpecObjective(item.text);
      if (objective) break;
    }
  }
  const plan = latestPlan(input.items);
  let progress: string | null = null;
  let staleLabel: string | null = null;
  if (plan) {
    const done = plan.steps.filter((step) => step.status === 'completed').length;
    const current = plan.steps.find((step) => step.status === 'in_progress');
    progress = fillCopy(timelineCopy.planProgress, { done, total: plan.steps.length });
    if (current)
      progress = `${progress} · ${fillCopy(timelineCopy.planNow, { step: current.title })}`;
    const age = input.now - Date.parse(plan.createdAt);
    if (Number.isFinite(age) && age >= STALE_PLAN_MS) staleLabel = stalenessLabel(age);
  }
  const turn = input.turn;
  let statusLabel = 'Idle';
  let finishedAt: string | null = null;
  if (turn?.status === 'completed') {
    finishedAt = turn.completedAt ?? turn.startedAt ?? null;
    const age = finishedAt ? input.now - Date.parse(finishedAt) : Number.NaN;
    statusLabel =
      Number.isFinite(age) && age >= 0
        ? fillCopy(timelineCopy.finishedAgo, { ago: formatRelativeAge(age) })
        : timelineCopy.statusCompleted;
  } else if (turn?.status === 'running') statusLabel = timelineCopy.statusRunning;
  else if (turn?.status === 'pending') statusLabel = timelineCopy.statusPending;
  else if (turn?.status === 'failed') statusLabel = timelineCopy.statusFailed;
  else if (turn?.status === 'interrupted') statusLabel = timelineCopy.statusInterrupted;
  else if (turn?.status === 'cancelled') statusLabel = timelineCopy.statusCancelled;
  else if (turn) statusLabel = timelineCopy.statusUnknown;
  return {
    objective,
    progress,
    staleLabel,
    planCreatedAt: plan?.createdAt ?? null,
    statusLabel,
    finishedAt,
  };
}
