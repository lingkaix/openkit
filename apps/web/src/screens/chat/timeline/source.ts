import type { TimelineItem, TimelineRunEntry } from '@openkit/app-api-schemas';
import { groupItemsByTurn, type ThreadItem } from '../data';
import { fillCopy, timelineCopy } from './copy';
import { countSteps, isLongRun, isStepItem, outcomeLine, type StepStats } from './present';
import type { EntryKind } from './registry';

/**
 * Entry shape named by the timeline spec.
 * Today's reads fill the fields they can. Components render the existing transcript
 * from `groups` and `detailItems`; TW2 switches the visible structure to these fields.
 */
export interface TimelineEntry {
  turnId: string;
  header: { copyKey: 'run-trigger' } | null;
  narrative: { kind: EntryKind; itemId: string }[];
  notes: { kind: 'assistant-message-earlier'; itemId: string }[];
  plan: { itemId: string } | null;
  stats: StepStats;
  /** True for a running run, a run over 30 minutes, or a run with more than 100 steps. */
  long: boolean;
  stepWindow: { kind: EntryKind; itemId: string }[];
  outcome: { copyKey: 'run-outcome'; text: string } | null;
  /** Facts from the run that produced this entry. Omission is not filled from another window. */
  usage?: TimelineRunEntry['usage'];
  fallback?: TimelineRunEntry['fallback'];
  planSegments?: TimelineRunEntry['planSegments'] | null;
  policies?: readonly { id: string; policy: TimelineItem['policy'] }[];
}

export interface TimelineTurn {
  id: string;
  status: string;
  error?: { message?: string } | null;
  startedAt?: string | null;
  completedAt?: string | null;
}

export interface ProjectedTimeline {
  entries: TimelineEntry[];
  items: ThreadItem[];
  /** tool-call, file-change, and reasoning, in read order. TW2 folds the other step kinds. */
  detailItems: ThreadItem[];
  groups: { turnId: string; items: ThreadItem[] }[];
}

/** Item-log groups plus dashboard activity or historical failures for runs with no items. */
function groupsForTurns(
  items: ThreadItem[],
  turns: readonly { id: string; status: string }[] | undefined,
  latestTurnId: string | undefined,
  activityTurnIds: ReadonlySet<string>,
  focusTurnId?: string | null
): { turnId: string; items: ThreadItem[] }[] {
  const groups = groupItemsByTurn(items);
  const orderedTurns = turns ?? [];
  const turnOrder = new Map(orderedTurns.map((turn, index) => [turn.id, index]));
  for (const [index, turn] of orderedTurns.entries()) {
    const historicalFailure = turn.status === 'failed' && turn.id !== latestTurnId;
    if (
      (!historicalFailure && !activityTurnIds.has(turn.id) && turn.id !== focusTurnId) ||
      groups.some((group) => group.turnId === turn.id)
    )
      continue;
    const next = groups.findIndex((group) => (turnOrder.get(group.turnId) ?? -1) > index);
    groups.splice(next < 0 ? groups.length : next, 0, { turnId: turn.id, items: [] });
  }
  return groups;
}

function kindOf(item: ThreadItem): EntryKind {
  return item.type;
}

/**
 * Adapt `thread.items` and `thread.dashboard` turns into the entry model.
 * // TW2: render narrative, notes, and plan from each entry. Order stays the item read.
 * // TB2: switch this function to `thread.timeline` without changing callers.
 */
export function projectTimeline(input: {
  items: readonly ThreadItem[];
  turns?: readonly TimelineTurn[];
  latestTurnId?: string;
  focusTurnId?: string | null;
  activityTurnIds?: ReadonlySet<string>;
}): ProjectedTimeline {
  const items = [...input.items];
  const turns = input.turns ?? [];
  const byTurn = new Map(turns.map((turn) => [turn.id, turn]));
  const groups = groupsForTurns(
    items,
    turns,
    input.latestTurnId,
    input.activityTurnIds ?? new Set<string>(),
    input.focusTurnId
  );
  const entries = groups.map((group) => {
    const turn = byTurn.get(group.turnId);
    const assistants = group.items.filter((item) => item.type === 'assistant-message');
    // A running run has no final message yet, so every agent message is a note.
    const running = turn?.status === 'running';
    const finalId = running ? undefined : assistants.at(-1)?.id;
    const plans = group.items.filter((item) => item.type === 'plan');
    const steps = group.items.filter((item) => isStepItem(item));
    const stats = countSteps(group.items);
    const failed =
      turn?.status === 'failed' && turn.id !== input.latestTurnId
        ? (turn.error?.message ?? timelineCopy.runFailed)
        : null;
    const otherOutcome = failed || !turn ? null : outcomeLine(turn.status, turn.error?.message);
    return {
      turnId: group.turnId,
      header: turn ? { copyKey: 'run-trigger' as const } : null,
      narrative: group.items
        .filter((item) => !isStepItem(item))
        .map((item) => ({ kind: kindOf(item), itemId: item.id })),
      notes: assistants
        .filter((item) => item.id !== finalId)
        .map((item) => ({ kind: 'assistant-message-earlier' as const, itemId: item.id })),
      plan: plans.at(-1) ? { itemId: plans.at(-1)!.id } : null,
      stats,
      // TB2: exact segment counts are not on today's reads. `long` uses loaded steps and timestamps.
      long: isLongRun({
        status: turn?.status,
        startedAt: turn?.startedAt,
        completedAt: turn?.completedAt,
        stepCount: stats.stepCount,
      }),
      stepWindow: steps.map((item) => ({ kind: kindOf(item), itemId: item.id })),
      outcome: failed
        ? { copyKey: 'run-outcome' as const, text: failed }
        : otherOutcome
          ? { copyKey: 'run-outcome' as const, text: otherOutcome }
          : null,
    };
  });
  return {
    entries,
    items,
    detailItems: items.filter((item) => isStepItem(item)),
    groups,
  };
}

export function coverageCopy(coverage: string | undefined): string {
  if (coverage === 'collecting') return timelineCopy.activityCollecting;
  if (coverage === 'partial') return timelineCopy.activityPartial;
  return timelineCopy.activityCoverageUnavailable;
}

export function captureCopy(capture: string | undefined): string {
  if (capture === 'on') return timelineCopy.captureOn;
  if (capture === 'off') return timelineCopy.captureOff;
  return timelineCopy.captureUnknown;
}

export function omittedActivityCopy(count: number): string {
  return fillCopy(timelineCopy.omittedActivity, { count });
}

export function runSeparatorCopy(index: number): string {
  return fillCopy(timelineCopy.runSeparator, { index });
}

export function contextSummaryCopy(count: number): string {
  return fillCopy(timelineCopy.contextSummaryMeta, { count });
}
