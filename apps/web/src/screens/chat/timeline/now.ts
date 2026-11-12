import { fillCopy, lintCopyText, timelineCopy } from './copy';
import { looksLikeIdentifier } from './present';
import { formatClockTime, formatDuration, formatRelativeAge } from './time';

/** Quiet while a model call at or below medium effort has no event. */
export const QUIET_MEDIUM_MS = 5 * 60 * 1000;

/** Quiet while a high-effort model call has no event. */
export const QUIET_HIGH_MS = 10 * 60 * 1000;

/** Quiet when the adapter reports a step only after it finishes. The label says Working. */
export const QUIET_WHEN_FINISHED_MS = 30 * 60 * 1000;

/** The Now dot pulses only while an event arrived inside this window. */
export const NOW_PULSE_WINDOW_MS = 10 * 1000;

const ENDED_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface NowStep {
  kind: 'command' | 'tool';
  inProgress: boolean;
  startedAt?: string | null;
  title?: string | null;
  server?: string | null;
}

export interface NowTurn {
  id?: string;
  status: string;
  startedAt?: string | null;
  completedAt?: string | null;
  errorMessage?: string | null;
  reasoningEffort?: string | null;
}

export interface NowFacts {
  now: number;
  readFailed: boolean;
  lastKnown?: { status: string; at: string } | null;
  stopPending: boolean;
  turn?: NowTurn | null;
  steps: readonly NowStep[];
  /** Newest loaded item time. Null means no loaded event time. */
  lastEventAt?: string | null;
  blockingCount: number;
  /** Omitted when today's dashboard has no queue position. */
  queueAhead?: number | null;
  /**
   * Set only when a caller already knows the adapter reports steps at completion.
   * The dashboard does not carry this fact.
   */
  stepsReportedWhenFinished?: boolean;
}

export type NowModel =
  | { kind: 'hidden'; finishedAt?: string; text?: string }
  | { kind: 'waiting-to-start'; text: string }
  | { kind: 'step'; text: string; live: boolean }
  | { kind: 'thinking'; text: string; live: boolean }
  | { kind: 'quiet'; text: string; live: false }
  | { kind: 'waiting-for-you'; text: string; accent: true }
  | { kind: 'stopping'; text: string }
  | { kind: 'ended'; text: string }
  | { kind: 'unavailable'; text: string; unknown: true };

export interface NowItem {
  type: string;
  turnId?: string;
  status?: string;
  createdAt?: string;
  completedAt?: string | null;
  exitCode?: number | null;
  tool?: string;
  server?: string | null;
}

function effortHigh(effort: string | null | undefined): boolean {
  return effort === 'high' || effort === 'xhigh' || effort === 'max';
}

function effortKnown(effort: string | null | undefined): boolean {
  return (
    effort === 'none' ||
    effort === 'minimal' ||
    effort === 'low' ||
    effort === 'medium' ||
    effortHigh(effort)
  );
}

/**
 * Quiet threshold for a running turn with no step in progress.
 * A step in progress never reaches this function.
 */
function quietThreshold(facts: NowFacts): number {
  if (facts.stepsReportedWhenFinished) return QUIET_WHEN_FINISHED_MS;
  if (effortHigh(facts.turn?.reasoningEffort)) return QUIET_HIGH_MS;
  if (effortKnown(facts.turn?.reasoningEffort)) return QUIET_MEDIUM_MS;
  // TB4: reasoning effort is missing on this turn. The longer model-call threshold
  // avoids calling a high-effort think quiet at 5 minutes.
  return QUIET_HIGH_MS;
}

function finiteTime(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : null;
}

function elapsed(iso: string | null | undefined, now: number): number | null {
  const parsed = finiteTime(iso);
  if (parsed == null) return null;
  return Math.max(0, now - parsed);
}

/** Newest created or completed instant on one loaded item. */
function itemEventTime(item: NowItem): number | null {
  const times = [finiteTime(item.createdAt), finiteTime(item.completedAt)].filter(
    (value): value is number => value != null
  );
  return times.length > 0 ? Math.max(...times) : null;
}

/** A dashboard.now step, already the open step of the running turn. */
export function nowStepFromDashboard(
  step: { kind: string; title?: string | null; startedAt: string } | null | undefined
): NowStep | null {
  if (!step) return null;
  if (step.kind === 'command-execution') {
    return { kind: 'command', inProgress: true, startedAt: step.startedAt };
  }
  if (step.kind === 'tool-call') {
    return { kind: 'tool', inProgress: true, startedAt: step.startedAt, title: step.title };
  }
  return null;
}

/**
 * Last activity of this run.
 * An item older than a running turn's start is history in the window, not live activity.
 * A supplied live event is used when it is not older than that start.
 */
export function liveRunEventAt(input: {
  status?: string;
  startedAt?: string | null;
  liveEventAt?: string | null;
  items: readonly NowItem[];
}): string | null {
  const started = input.status === 'running' ? finiteTime(input.startedAt) : null;
  const live = finiteTime(input.liveEventAt);
  if (live != null && (started == null || live >= started)) return new Date(live).toISOString();
  const times = input.items
    .map(itemEventTime)
    .filter((value): value is number => value != null)
    .filter((value) => started == null || value >= started);
  if (times.length === 0) return null;
  return new Date(Math.max(...times)).toISOString();
}

function withDuration(label: string, ms: number | null): string {
  const duration = ms == null ? null : formatDuration(ms);
  return duration ? `${label} · ${duration}` : label;
}

function stepText(step: NowStep, now: number): string {
  const duration = elapsed(step.startedAt, now);
  if (step.kind === 'command') return withDuration(timelineCopy.runningCommand, duration);
  const server = step.server && !looksLikeIdentifier(step.server) ? step.server : null;
  const title = step.title && !looksLikeIdentifier(step.title) ? step.title : null;
  const name = server && title ? `${server}: ${title}` : (title ?? server ?? 'a tool');
  return withDuration(fillCopy(timelineCopy.usingNamed, { name }), duration);
}

function livePulse(facts: NowFacts): boolean {
  const age = elapsed(facts.lastEventAt, facts.now);
  return age != null && age <= NOW_PULSE_WINDOW_MS;
}

function decisionLabel(count: number): string {
  if (count === 1) return timelineCopy.oneDecision;
  return fillCopy(timelineCopy.nDecisions, { count });
}

function cause(message: string | null | undefined): string | null {
  if (!message) return null;
  const text = message.trim();
  if (!text || looksLikeIdentifier(text) || lintCopyText(text).length > 0) return null;
  return text;
}

function endedText(turn: NowTurn, now: number): string {
  const when = elapsed(turn.completedAt ?? turn.startedAt, now);
  const ago = when == null ? null : formatRelativeAge(when);
  const why = cause(turn.errorMessage);
  if (turn.status === 'failed') {
    if (ago && why) return fillCopy(timelineCopy.failedWithCause, { ago, cause: why });
    if (ago) return fillCopy(timelineCopy.failedAgo, { ago });
    return timelineCopy.runFailed;
  }
  if (turn.status === 'cancelled') {
    if (ago && why) return fillCopy(timelineCopy.cancelledWithCause, { ago, cause: why });
    if (ago) return fillCopy(timelineCopy.cancelledAgo, { ago });
    return timelineCopy.statusCancelled;
  }
  if (ago && why) return fillCopy(timelineCopy.stoppedWithCause, { ago, cause: why });
  if (ago) return fillCopy(timelineCopy.stoppedAgo, { ago });
  return timelineCopy.statusInterrupted;
}

function hidden(turn: NowTurn | null | undefined, now: number): NowModel {
  if (turn?.status === 'completed') {
    const finishedAt = turn.completedAt ?? turn.startedAt ?? undefined;
    const age = elapsed(finishedAt, now);
    return {
      kind: 'hidden',
      finishedAt: finishedAt ?? undefined,
      text:
        age == null
          ? undefined
          : fillCopy(timelineCopy.finishedAgo, { ago: formatRelativeAge(age) }),
    };
  }
  return { kind: 'hidden' };
}

/**
 * Every Now state. The timeline does not invent queue position, effort, or last-event time.
 * // TB4: queue position is not on thread.dashboard. Pass `queueAhead` only when a caller has it.
 * // A running turn ignores window items older than its start. Quiet is omitted when no live time remains.
 * // Pass `liveEventAt` from dashboard.now.lastEventAt when that read is present.
 * // TB4: effort is the turn's reasoningEffort when the turn carries it.
 * // TB4: "steps reported only when they finish" is not on the dashboard. The 30-minute Working
 * // threshold applies only when `stepsReportedWhenFinished` is already known.
 */
export function deriveNow(facts: NowFacts): NowModel {
  if (facts.readFailed) {
    const known = facts.lastKnown;
    const text = known
      ? `${timelineCopy.statusUnknown} · ${fillCopy(timelineCopy.lastKnown, {
          status: known.status,
          time: formatClockTime(known.at),
        })}`
      : timelineCopy.statusUnknown;
    return { kind: 'unavailable', text, unknown: true };
  }

  const turn = facts.turn ?? null;
  const open = facts.steps.findLast((step) => step.inProgress);
  const running = turn?.status === 'running';
  const pending = turn?.status === 'pending';

  if (facts.stopPending && (running || pending)) {
    return { kind: 'stopping', text: timelineCopy.stopping };
  }

  if (running && open) {
    return { kind: 'step', text: stepText(open, facts.now), live: livePulse(facts) };
  }

  if (running) {
    const runElapsed = elapsed(turn?.startedAt, facts.now);
    const threshold = quietThreshold(facts);
    const sinceEvent = elapsed(facts.lastEventAt, facts.now);
    const working = facts.stepsReportedWhenFinished === true;
    if (sinceEvent != null && sinceEvent >= threshold) {
      const runningLabel =
        formatDuration(runElapsed ?? 0) ?? formatRelativeAge(runElapsed ?? 0).replace(/ ago$/, '');
      const quietLabel =
        formatDuration(sinceEvent) ?? formatRelativeAge(sinceEvent).replace(/ ago$/, '');
      const template = working ? timelineCopy.workingQuiet : timelineCopy.quietLine;
      return {
        kind: 'quiet',
        text: fillCopy(template, { running: runningLabel, quiet: quietLabel }),
        live: false,
      };
    }
    const template = working ? timelineCopy.workingElapsed : timelineCopy.thinkingElapsed;
    const elapsedLabel = formatDuration(runElapsed ?? 0);
    return {
      kind: 'thinking',
      text: elapsedLabel
        ? fillCopy(template, { elapsed: elapsedLabel })
        : template.split(' · ')[0]!,
      live: livePulse(facts),
    };
  }

  if (pending) {
    const ahead =
      facts.queueAhead != null && facts.queueAhead > 0
        ? fillCopy(timelineCopy.queueAhead, { count: facts.queueAhead })
        : null;
    return {
      kind: 'waiting-to-start',
      text: ahead ? `${timelineCopy.waitingForWorker} · ${ahead}` : timelineCopy.waitingForWorker,
    };
  }

  if (facts.blockingCount > 0) {
    return {
      kind: 'waiting-for-you',
      text: fillCopy(timelineCopy.waitingForYou, { decisions: decisionLabel(facts.blockingCount) }),
      accent: true,
    };
  }

  if (
    turn &&
    (turn.status === 'failed' || turn.status === 'interrupted' || turn.status === 'cancelled')
  ) {
    const age = elapsed(turn.completedAt ?? turn.startedAt, facts.now);
    if (age == null || age <= ENDED_WINDOW_MS)
      return { kind: 'ended', text: endedText(turn, facts.now) };
    return hidden(turn, facts.now);
  }

  if (turn && turn.status !== 'completed' && turn.status !== 'idle') {
    return { kind: 'unavailable', text: timelineCopy.statusUnknown, unknown: true };
  }

  return hidden(turn, facts.now);
}

function openStep(item: NowItem): NowStep | null {
  if (item.type === 'command-execution') {
    const running =
      item.status === 'in_progress' ||
      (item.exitCode == null &&
        item.status !== 'failed' &&
        item.status !== 'declined' &&
        item.completedAt == null &&
        item.status !== 'completed');
    if (!running) return null;
    return { kind: 'command', inProgress: true, startedAt: item.createdAt };
  }
  if (item.type === 'tool-call' && item.status === 'in_progress') {
    return {
      kind: 'tool',
      inProgress: true,
      startedAt: item.createdAt,
      title: item.tool,
      server: item.server,
    };
  }
  return null;
}

/**
 * Project the loaded run into Now.
 * Last activity is the live event when it belongs to this run, otherwise an item of this run
 * that is not older than the run's start. Quiet is omitted when no such time remains.
 * Queue position and finish-only steps stay omitted until the caller passes them.
 */
export function nowFromThread(input: {
  now: number;
  readFailed: boolean;
  stopPending: boolean;
  turns: readonly NowTurn[];
  items: readonly NowItem[];
  blockingCount: number;
  lastKnown?: { status: string; at: string } | null;
  /** dashboard.now.lastEventAt. Omitted when that read is absent. */
  liveEventAt?: string | null;
  /** dashboard.now.queuePosition. Omitted when that read is absent. */
  queueAhead?: number | null;
  /** Set when dashboard.now.stepsReportedLive is false. */
  stepsReportedWhenFinished?: boolean;
  /** dashboard.now.step, used when the loaded window has no open step of this run. */
  liveStep?: NowStep | null;
}): NowModel {
  const turn =
    [...input.turns].reverse().find((candidate) => candidate.status === 'running') ??
    input.turns.at(-1) ??
    null;
  const mine = turn?.id ? input.items.filter((item) => item.turnId === turn.id) : input.items;
  const started = turn?.status === 'running' ? finiteTime(turn.startedAt) : null;
  const current = mine.filter((item) => {
    if (started == null) return true;
    const time = itemEventTime(item);
    return time == null || time >= started;
  });
  const fromItems = current.map(openStep).filter((step): step is NowStep => step != null);
  const steps =
    fromItems.length > 0 ? fromItems : input.liveStep?.inProgress ? [input.liveStep] : [];
  const lastEventAt = liveRunEventAt({
    status: turn?.status,
    startedAt: turn?.startedAt,
    liveEventAt: input.liveEventAt,
    items: mine,
  });
  return deriveNow({
    now: input.now,
    readFailed: input.readFailed,
    stopPending: input.stopPending,
    turn,
    steps,
    lastEventAt,
    blockingCount: input.blockingCount,
    lastKnown: input.lastKnown,
    queueAhead: input.queueAhead,
    stepsReportedWhenFinished: input.stepsReportedWhenFinished,
  });
}
