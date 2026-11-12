import type { ThreadItem } from '../data';
import { fillCopy, lintCopyText, timelineCopy } from './copy';
import type { LensName, VoiceCategory } from './types';

/** A run is long above this many steps. Calibrated later on real runs. */
export const LONG_RUN_STEP_THRESHOLD = 100;

/** A run is long at or above this duration. */
export const LONG_RUN_DURATION_MS = 30 * 60 * 1000;

const STEP_TYPES = new Set(['tool-call', 'command-execution', 'file-change', 'reasoning']);

const STATUS_TITLES: Record<string, string> = {
  'Worker Turn accepted': timelineCopy.runAccepted,
  'Worker Turn failed': timelineCopy.runFailedTitle,
  'Worker Turn interrupted': timelineCopy.runStoppedTitle,
};

/** Tool calls, commands, file changes, and reasoning are steps. */
export function isStepItem(item: { type: string }): boolean {
  return STEP_TYPES.has(item.type);
}

/** True when the visible string would fail the U11 lint. */
export function looksLikeIdentifier(text: string): boolean {
  return /^(?:agent|usr|auto|tu|th|it|itm|ws|art)_/i.test(text) || lintCopyText(text).length > 0;
}

export interface RunClock {
  status?: string;
  startedAt?: string | null;
  completedAt?: string | null;
}

/** Elapsed milliseconds, or null when the start cannot be read. */
export function runDurationMs(turn: RunClock | undefined, now: number): number | null {
  if (!turn?.startedAt) return null;
  const started = Date.parse(turn.startedAt);
  if (!Number.isFinite(started)) return null;
  const end =
    turn.status === 'running' || turn.status === 'pending'
      ? now
      : turn.completedAt
        ? Date.parse(turn.completedAt)
        : now;
  if (!Number.isFinite(end)) return null;
  return Math.max(0, end - started);
}

/** Running, 30 minutes or more, or more than 100 steps. */
export function isLongRun(input: {
  status?: string;
  startedAt?: string | null;
  completedAt?: string | null;
  stepCount: number;
  now?: number;
}): boolean {
  if (input.status === 'running') return true;
  if (input.stepCount > LONG_RUN_STEP_THRESHOLD) return true;
  const duration = runDurationMs(input, input.now ?? Date.now());
  return duration != null && duration >= LONG_RUN_DURATION_MS;
}

/** Minutes-and-hours label used by the run summary. */
export function formatRunDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

export interface StepStats {
  stepCount: number;
  fileCount: number;
  /** Absent when the server statistics did not include the field. Never a stand-in zero. */
  failedCommandCount?: number;
  /** Absent when the server statistics did not include the field. Never a stand-in zero. */
  failedStepCount?: number;
}

/** A recorded count, or nothing when the server field is absent. */
export function recordedCount(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function toolFailed(item: ThreadItem): boolean {
  return item.type === 'tool-call' && (item.status === 'failed' || Boolean(item.error));
}

function commandFailed(item: ThreadItem): boolean {
  return item.type === 'command-execution' && item.exitCode != null && item.exitCode !== 0;
}

/** Counts taken from the loaded items. The timeline window uses server statistics instead. */
export function countSteps(items: readonly ThreadItem[]): StepStats {
  let stepCount = 0;
  let fileCount = 0;
  let failedCommandCount = 0;
  let failedStepCount = 0;
  for (const item of items) {
    if (!isStepItem(item)) continue;
    stepCount += 1;
    if (item.type === 'file-change') fileCount += 1;
    if (commandFailed(item)) {
      failedCommandCount += 1;
      failedStepCount += 1;
    } else if (toolFailed(item)) failedStepCount += 1;
  }
  return { stepCount, fileCount, failedCommandCount, failedStepCount };
}

/** Summary counted from records. The actor is already a plain name. */
export function summaryLine(input: {
  actor: string;
  running: boolean;
  durationMs: number | null;
  stats: StepStats;
}): string {
  const pace =
    input.durationMs == null
      ? input.running
        ? timelineCopy.statusRunning
        : timelineCopy.statusCompleted
      : `${input.running ? 'running' : 'worked'} ${formatRunDuration(input.durationMs)}`;
  const commands = recordedCount(input.stats.failedCommandCount);
  return [
    input.actor,
    pace,
    fillCopy(timelineCopy.stepsFold, { count: input.stats.stepCount }),
    fillCopy(timelineCopy.filesChanged, { count: input.stats.fileCount }),
    commands == null ? null : fillCopy(timelineCopy.commandsFailed, { count: commands }),
  ]
    .filter((part) => part != null)
    .join(' · ');
}

/**
 * Outcome line for a run that did not finish cleanly.
 * Unknown is never called failed.
 */
export function outcomeLine(status: string | undefined, message?: string | null): string | null {
  if (status === 'failed') return message ? `Failed: ${message}` : timelineCopy.runFailed;
  if (status === 'interrupted') return timelineCopy.statusInterrupted;
  if (status === 'cancelled') return timelineCopy.statusCancelled;
  if (status === 'completed' || status === 'running' || status === 'pending' || status == null)
    return null;
  return timelineCopy.statusUnknown;
}

/** Map a known server status title onto registry copy. Unlisted titles stay, unless they fail U11. */
export function visibleStatusTitle(title: string): string {
  const mapped = STATUS_TITLES[title];
  if (mapped) return mapped;
  if (lintCopyText(title).length > 0) return timelineCopy['status-info'];
  return title;
}

/** Map a known server status summary. The original stays in the Inspector. */
export function visibleStatusSummary(summary: string | null | undefined): string | null {
  if (summary == null) return null;
  if (summary.startsWith('Conversation continued with ')) return timelineCopy.runContinued;
  if (summary === 'Worker turn ended without success.') return timelineCopy.runEndedPlain;
  if (lintCopyText(summary).length > 0) return null;
  return summary;
}

/** Objective from a task specification message. Other JSON stays verbatim. */
export function taskSpecObjective(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(trimmed) as { schemaVersion?: unknown; objective?: unknown };
    if (parsed.schemaVersion !== 1 || typeof parsed.objective !== 'string') return null;
    const objective = parsed.objective.trim();
    return objective.length > 0 ? objective : null;
  } catch {
    return null;
  }
}

export interface StepGroup {
  key: string;
  label: string;
  items: ThreadItem[];
  /** Shared recorded digest, only when every member has that same non-null value. */
  digest: string | null;
}

const ARGUMENT_DIGEST = /^sha256:[a-f0-9]{64}$/;

function singleStepLabel(item: ThreadItem): string {
  if (item.type === 'tool-call') return item.tool;
  if (item.type === 'command-execution') return item.command;
  if (item.type === 'file-change') return item.path;
  if (item.type === 'reasoning') return item.summary[0] ?? timelineCopy.reasoning;
  return timelineCopy['tool-call'];
}

function recordedDigest(
  item: ThreadItem,
  digests: ReadonlyMap<string, string | null> | undefined
): string | null {
  const value = digests?.get(item.id);
  return typeof value === 'string' && ARGUMENT_DIGEST.test(value) ? value : null;
}

function stepFailed(item: ThreadItem): boolean {
  return toolFailed(item) || commandFailed(item);
}

/** A recorded success. Unknown, running, and missing outcomes are not success. */
function stepSucceeded(item: ThreadItem): boolean {
  if (item.type === 'tool-call') return item.status === 'completed' && !item.error;
  if (item.type === 'command-execution') return item.status === 'completed' && item.exitCode === 0;
  return false;
}

function callName(item: ThreadItem): string {
  if (item.type === 'tool-call') return item.tool;
  if (item.type === 'command-execution') return item.command;
  return singleStepLabel(item);
}

/** Span of the recorded timestamps. Missing clocks add no duration. */
function recordedSpan(items: readonly ThreadItem[]): string | null {
  const start = Date.parse(items[0]?.createdAt ?? '');
  const endItem = items.at(-1);
  const end = Date.parse(endItem?.completedAt ?? endItem?.createdAt ?? '');
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  if (end - start < 60_000) return null;
  return formatRunDuration(end - start);
}

/**
 * Exact repeat or retry label. The count is this group's membership, not a run total.
 * A retry is named only when an earlier member failed and the last member succeeded.
 */
function exactLabel(items: ThreadItem[]): string {
  const name = callName(items[0]!);
  if (items.length < 2) return name;
  const earlierFailed = items.slice(0, -1).some((entry) => stepFailed(entry));
  if (earlierFailed && stepSucceeded(items.at(-1)!)) {
    return fillCopy(timelineCopy.triedSucceeded, { count: items.length });
  }
  const head = fillCopy(timelineCopy.exactRepeats, { name, count: items.length });
  const span = recordedSpan(items);
  const withSpan = span ? `${head} · ${fillCopy(timelineCopy.overSpan, { duration: span })}` : head;
  return stepFailed(items.at(-1)!) ? `${withSpan} · ${timelineCopy.lastFailing}` : withSpan;
}

/**
 * R2 stays a same-tool or same-file count when the digest is null.
 * R3/R4 group only consecutive steps that share one non-null argumentDigest.
 * A null digest never joins an exact group, and a preview is never an identity.
 */
export function groupSteps(
  items: readonly ThreadItem[],
  digests?: ReadonlyMap<string, string | null>
): StepGroup[] {
  const groups: StepGroup[] = [];
  for (const item of items) {
    if (!isStepItem(item)) continue;
    const digest = recordedDigest(item, digests);
    const last = groups.at(-1);
    const lastItem = last?.items[0];
    if (digest && last?.digest === digest) {
      last.items.push(item);
      last.label = exactLabel(last.items);
      continue;
    }
    const sameFiles =
      item.type === 'file-change' && lastItem?.type === 'file-change' && last?.digest == null;
    const sameTool =
      digest == null &&
      item.type === 'tool-call' &&
      last?.digest == null &&
      lastItem?.type === 'tool-call' &&
      lastItem.tool === item.tool;
    if (last && (sameFiles || sameTool)) {
      last.items.push(item);
      if (sameFiles) {
        last.label = fillCopy(timelineCopy.filesChanged, { count: last.items.length });
      } else if (lastItem?.type === 'tool-call') {
        last.label = fillCopy(timelineCopy.exactRepeats, {
          name: lastItem.tool,
          count: last.items.length,
        });
      }
      continue;
    }
    groups.push({
      key: item.id,
      label: singleStepLabel(item),
      items: [item],
      digest:
        digest && (item.type === 'tool-call' || item.type === 'command-execution') ? digest : null,
    });
  }
  return groups;
}

/**
 * Latest three notes on a long Work run.
 * Short Work runs fold every earlier note. Full shows every note.
 */
export function noteWindow(
  noteIds: readonly string[],
  lens: LensName,
  long: boolean
): { visible: string[]; earlierCount: number } {
  if (lens === 'full') return { visible: [...noteIds], earlierCount: 0 };
  if (!long) return { visible: [], earlierCount: noteIds.length };
  const visible = noteIds.slice(-3);
  return { visible, earlierCount: Math.max(0, noteIds.length - visible.length) };
}

/** Voice class for the four U1 treatments. The data-voice attribute stays the registry category. */
export function voiceClass(voice: VoiceCategory): string {
  if (voice === 'human') return 'ok-voice-human';
  if (voice === 'claim' || voice === 'process') return 'ok-voice-claim';
  if (voice === 'output' || voice === 'derived') return 'ok-voice-generated';
  return 'ok-voice-fact';
}

/** Plain stand-in when the only recorded name is an identifier. */
export function plainActorName(
  name: string | undefined,
  kind: 'self' | 'person' | 'automation' | 'worker' | 'agent'
): string {
  if (name && !looksLikeIdentifier(name)) return name;
  if (kind === 'self') return 'You';
  if (kind === 'automation') return timelineCopy.automationActor;
  if (kind === 'person') return timelineCopy.someone;
  if (kind === 'agent') return 'Agent';
  return 'Worker';
}

/** Admitted request lifecycle. A missing row is not a closed result. */
export interface RequestLifecycle {
  state: 'pending' | 'resolved' | 'ended' | 'inspect-only';
  resolution: 'granted' | 'denied' | 'answered' | null;
  ending: 'withdrawn' | 'invalidated' | null;
  disposition:
    | 'approved-executed'
    | 'denied-not-executed'
    | 'execution-error'
    | 'outcome-unknown'
    | null;
}

export type ClosedFold =
  | { fold: false }
  | {
      fold: true;
      kind: 'approved' | 'denied' | 'answered' | 'closed';
      result: 'executed' | 'not-executed' | null;
    };

/**
 * R8 folds a closed approval or question only when the published decision is in
 * this run and the admitted lifecycle is safe. A lifecycle row before that
 * publication stays a card, so the request remains visible. Pending, unknown,
 * failed, and not-yet-consumed grants stay open (R9). Delivery is not on this
 * read, so an answer does not claim it was delivered.
 */
export function closedDecisionFold(input: {
  decision: 'granted' | 'denied' | 'answered' | null;
  request: RequestLifecycle | null;
}): ClosedFold {
  const request = input.request;
  if (
    !input.decision ||
    !request ||
    request.state === 'pending' ||
    request.state === 'inspect-only'
  ) {
    return { fold: false };
  }
  if (input.decision === 'granted') {
    if (request.disposition === 'approved-executed') {
      return { fold: true, kind: 'approved', result: 'executed' };
    }
    return { fold: false };
  }
  if (input.decision === 'denied') {
    return {
      fold: true,
      kind: 'denied',
      result: request.disposition === 'denied-not-executed' ? 'not-executed' : null,
    };
  }
  if (input.decision === 'answered') {
    return { fold: true, kind: 'answered', result: null };
  }
  return { fold: false };
}

/** One line: who decided, plus a recorded result only when the lifecycle has one. */
export function closedDecisionLine(
  name: string,
  kind: 'approved' | 'denied' | 'answered' | 'closed',
  result: 'executed' | 'not-executed' | null
): string {
  const head =
    kind === 'approved'
      ? fillCopy(timelineCopy.approvedBy, { name })
      : kind === 'denied'
        ? fillCopy(timelineCopy.deniedBy, { name })
        : kind === 'answered'
          ? fillCopy(timelineCopy.answeredBy, { name })
          : timelineCopy.closedWithoutDecision;
  if (result === 'executed') return `${head} · ${timelineCopy.executedResult}`;
  if (result === 'not-executed') return `${head} · ${timelineCopy.notExecutedResult}`;
  return head;
}

export function stepsFoldLabel(count: number, failed?: number): string {
  const base = fillCopy(timelineCopy.stepsFold, { count });
  const recorded = recordedCount(failed);
  if (recorded == null || recorded <= 0) return base;
  return `${base} · ${fillCopy(timelineCopy.failedCount, { count: recorded })}`;
}
