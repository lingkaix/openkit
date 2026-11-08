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

function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

export interface StepStats {
  stepCount: number;
  fileCount: number;
  failedCommandCount: number;
  failedStepCount: number;
}

function toolFailed(item: ThreadItem): boolean {
  return item.type === 'tool-call' && (item.status === 'failed' || Boolean(item.error));
}

function commandFailed(item: ThreadItem): boolean {
  return item.type === 'command-execution' && item.exitCode != null && item.exitCode !== 0;
}

/** Counts taken from the loaded items. Server statistics replace this after TB2. */
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
      : `${input.running ? 'running' : 'worked'} ${formatDuration(input.durationMs)}`;
  return [
    input.actor,
    pace,
    fillCopy(timelineCopy.stepsFold, { count: input.stats.stepCount }),
    fillCopy(timelineCopy.filesChanged, { count: input.stats.fileCount }),
    fillCopy(timelineCopy.commandsFailed, { count: input.stats.failedCommandCount }),
  ].join(' · ');
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
}

function singleStepLabel(item: ThreadItem): string {
  if (item.type === 'tool-call') return item.tool;
  if (item.type === 'command-execution') return item.command;
  if (item.type === 'file-change') return item.path;
  if (item.type === 'reasoning') return item.summary[0] ?? timelineCopy.reasoning;
  return timelineCopy['tool-call'];
}

/**
 * R2 and R4 over a loaded step list.
 * // TB2: argument digests for R3, and exact windows, arrive with the timeline read.
 */
export function groupSteps(items: readonly ThreadItem[]): StepGroup[] {
  const groups: StepGroup[] = [];
  for (const item of items) {
    if (!isStepItem(item)) continue;
    const last = groups.at(-1);
    const lastItem = last?.items[0];
    const sameFiles = item.type === 'file-change' && lastItem?.type === 'file-change';
    const sameTool =
      item.type === 'tool-call' && lastItem?.type === 'tool-call' && lastItem.tool === item.tool;
    if (last && (sameFiles || sameTool)) {
      last.items.push(item);
      if (sameFiles) {
        last.label = fillCopy(timelineCopy.filesChanged, { count: last.items.length });
      } else if (lastItem?.type === 'tool-call') {
        const failedEarlier = last.items.slice(0, -1).some((entry) => toolFailed(entry));
        const succeeded = !toolFailed(item);
        last.label =
          failedEarlier && succeeded
            ? `Tried ${last.items.length}×, succeeded on the last`
            : `${lastItem.tool} × ${last.items.length}`;
      }
      continue;
    }
    groups.push({ key: item.id, label: singleStepLabel(item), items: [item] });
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

export function stepsFoldLabel(count: number, failed: number): string {
  const base = fillCopy(timelineCopy.stepsFold, { count });
  if (failed <= 0) return base;
  return `${base} · ${fillCopy(timelineCopy.failedCount, { count: failed })}`;
}
