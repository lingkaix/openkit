import type {
  ThreadTimelineInput,
  ThreadTimelineResponse,
  TimelineItem,
  TimelineRunEntry,
} from '@openkit/app-api-schemas';
import type { ThreadItem } from '../data';
import { noteAdmittedArgumentDigest } from './argument-digest';
import { recordedFailureText } from './owner-error';
import { outcomeLine, recordedCount } from './present';
import type { AgentProfileId } from './profiles';
import type { TimelineEntry } from './source';

/** Distance from the end that keeps follow mode on. */
export const FOLLOW_DISTANCE_PX = 48;
/** Sentinels sit this many viewports beyond each edge. */
export const SENTINEL_VIEWPORTS = 1.5;
/** Level-2 page size. The read rejects a larger item page. */
export const LEVEL2_PAGE_SIZE = 50;
/** Above this many steps the entry offers the paged steps sheet. */
export const OPEN_ALL_STEPS_THRESHOLD = 500;
/** Text deltas render at most ten times a second. */
export const TEXT_RENDER_INTERVAL_MS = 100;
/** Now moves at most twice a second. */
export const NOW_MAX_INTERVAL_MS = 500;
/** Idle window refresh. Hidden tabs do not poll. */
export const IDLE_POLL_MS = 15_000;
/** Running or waiting window refresh, plus the live stream. */
export const RUNNING_POLL_MS = 5_000;

/**
 * Fields the spec names that `thread.timeline` does not return.
 * Web renders the documented fallback and does not invent the values.
 */
export const TIMELINE_READ_GAPS = [
  'Run statistics have no failed-step or failed-command count.',
  'The catch-up digest is not in this read.',
] as const;

export type TimelineAnchorRequest =
  | { kind: 'latest' }
  | { kind: 'turn'; turnId: string }
  | { kind: 'item'; itemId: string }
  | { kind: 'approval-request'; approvalRequestId: string }
  | { kind: 'user-input-request'; userInputRequestId: string }
  | { kind: 'attention'; rowId: string }
  | { kind: 'catch-up' };

export interface HeldTimeline {
  runs: TimelineRunEntry[];
  beforeCursor: string | null;
  afterCursor: string | null;
  anchor: ThreadTimelineResponse['anchor'];
  catchUpAnchor: ThreadTimelineResponse['catchUpAnchor'];
  /** Present, null, or omitted exactly as `thread.timeline` returned it. */
  earlierUnread?: ThreadTimelineResponse['earlierUnread'];
  itemWindow: ThreadTimelineResponse['itemWindow'];
  restrictedReferences: boolean;
  /** True after the reader pages earlier. A latest poll must not drop that page. */
  pagedEarlier?: boolean;
  /** True after the reader pages later. A poll must not rewind that page. */
  pagedLater?: boolean;
  /** The request anchor was not found. The held runs stay the current view. */
  requestUnavailable?: boolean;
  digest?: ThreadTimelineResponse['digest'];
}

export interface HeldItems {
  items: TimelineItem[];
  beforeCursor: string | null;
  afterCursor: string | null;
}

/** Anchor named by the thread URL. A request id wins over a loaded Item. Otherwise item, row, run, then catch-up. */
export function anchorFromSearch(search: string): TimelineAnchorRequest {
  const params = new URLSearchParams(search);
  const approvalRequestId = params.get('approvalRequest');
  if (approvalRequestId) return { kind: 'approval-request', approvalRequestId };
  const userInputRequestId = params.get('userInputRequest');
  if (userInputRequestId) return { kind: 'user-input-request', userInputRequestId };
  const itemId = params.get('item');
  if (itemId) return { kind: 'item', itemId };
  const rowId = params.get('row') || params.get('attention');
  if (rowId) return { kind: 'attention', rowId };
  const turnId = params.get('turn') || params.get('turnId');
  if (turnId) return { kind: 'turn', turnId };
  if (params.get('catchUp') === '1') return { kind: 'catch-up' };
  return { kind: 'latest' };
}

/** Selector the timeline operation accepts. Cursors are not mixed with anchors. */
export function anchorInput(
  anchor: TimelineAnchorRequest
): NonNullable<ThreadTimelineInput['anchor']> {
  switch (anchor.kind) {
    case 'latest':
      return { kind: 'latest' };
    case 'turn':
      return { kind: 'turn', turnId: anchor.turnId };
    case 'item':
      return { kind: 'item', itemId: anchor.itemId };
    case 'approval-request':
      return { kind: 'approval-request', approvalRequestId: anchor.approvalRequestId };
    case 'user-input-request':
      return { kind: 'user-input-request', userInputRequestId: anchor.userInputRequestId };
    case 'attention':
      return { kind: 'attention', rowId: anchor.rowId };
    case 'catch-up':
      return { kind: 'catch-up' };
  }
}

/** First window. The server places 20 entries before an anchor and up to 10 after. */
export function openingInput(
  workspaceId: string,
  threadId: string,
  anchor: TimelineAnchorRequest
): ThreadTimelineInput {
  return { workspaceId, threadId, anchor: anchorInput(anchor) };
}

/** One cursor page. The cursor already carries its window. */
export function cursorInput(
  workspaceId: string,
  threadId: string,
  cursor: string
): ThreadTimelineInput {
  return { workspaceId, threadId, cursor };
}

/** Fifty Items or steps inside one run, in either direction. */
export function level2Input(
  workspaceId: string,
  threadId: string,
  turnId: string,
  placement: 'all' | 'narrative' | 'step' = 'step'
): ThreadTimelineInput {
  return {
    workspaceId,
    threadId,
    view: 'items',
    turnId,
    placement,
    limit: LEVEL2_PAGE_SIZE,
  };
}

export function holdFromResponse(page: ThreadTimelineResponse): HeldTimeline {
  return {
    runs: page.runs,
    beforeCursor: page.beforeCursor,
    afterCursor: page.afterCursor,
    anchor: page.anchor,
    catchUpAnchor: page.catchUpAnchor,
    earlierUnread: page.earlierUnread,
    itemWindow: page.itemWindow,
    restrictedReferences: page.restrictedReferences,
  };
}

/** One row per run, admission order, overlapping ids kept once. */
export function mergeRuns(
  current: readonly TimelineRunEntry[],
  page: readonly TimelineRunEntry[]
): TimelineRunEntry[] {
  const byId = new Map<string, TimelineRunEntry>();
  for (const run of current) byId.set(run.id, run);
  for (const run of page) byId.set(run.id, run);
  return [...byId.values()].sort((left, right) => left.admissionOrder - right.admissionOrder);
}

/** Holes and duplicates in an admission sequence. Concurrent appends must create neither. */
export function admissionGaps(orders: readonly number[]): {
  duplicate: boolean;
  missing: number[];
} {
  const seen = new Set<number>();
  let duplicate = false;
  for (const order of orders) {
    if (seen.has(order)) duplicate = true;
    seen.add(order);
  }
  const sorted = [...seen].sort((left, right) => left - right);
  const missing: number[] = [];
  if (sorted.length === 0) return { duplicate, missing };
  for (let order = sorted[0]!; order <= sorted[sorted.length - 1]!; order += 1) {
    if (!seen.has(order)) missing.push(order);
  }
  return { duplicate, missing };
}

type TimelinePage = Pick<
  ThreadTimelineResponse,
  | 'runs'
  | 'beforeCursor'
  | 'afterCursor'
  | 'anchor'
  | 'catchUpAnchor'
  | 'itemWindow'
  | 'restrictedReferences'
>;

function admissionSpan(
  runs: readonly { admissionOrder: number }[]
): { min: number; max: number } | null {
  if (runs.length === 0) return null;
  let min = runs[0]!.admissionOrder;
  let max = min;
  for (const run of runs) {
    if (run.admissionOrder < min) min = run.admissionOrder;
    if (run.admissionOrder > max) max = run.admissionOrder;
  }
  return { min, max };
}

function spansDisjoint(
  held: { min: number; max: number },
  fresh: { min: number; max: number }
): boolean {
  return held.max + 1 < fresh.min || fresh.max + 1 < held.min;
}

/**
 * A poll keeps reachable history.
 * Disjoint windows are not spliced into one list: the gap stays behind a cursor.
 * A reader who already reached the newest run keeps that later cursor.
 * An unpaged latest window is the fresh page, so a sliding tail does not grow forever.
 */
export function absorbPoll(held: HeldTimeline, fresh: TimelinePage): HeldTimeline {
  const heldEdge = admissionSpan(held.runs);
  const freshEdge = admissionSpan(fresh.runs);
  const kept = {
    anchor: fresh.anchor,
    catchUpAnchor: fresh.catchUpAnchor,
    itemWindow: fresh.itemWindow ?? held.itemWindow,
    restrictedReferences: held.restrictedReferences || fresh.restrictedReferences,
    pagedEarlier: held.pagedEarlier === true,
    pagedLater: held.pagedLater === true,
  };
  const readerPaged = kept.pagedEarlier || kept.pagedLater;
  if (heldEdge && freshEdge && spansDisjoint(heldEdge, freshEdge)) {
    if (heldEdge.max < freshEdge.min) {
      if (readerPaged) {
        return {
          ...kept,
          runs: held.runs,
          beforeCursor: held.beforeCursor,
          afterCursor: held.afterCursor ?? fresh.beforeCursor,
        };
      }
      if (fresh.beforeCursor) {
        return {
          ...kept,
          runs: fresh.runs,
          beforeCursor: fresh.beforeCursor,
          afterCursor: fresh.afterCursor,
          pagedEarlier: false,
          pagedLater: false,
        };
      }
      return {
        ...kept,
        runs: held.runs,
        beforeCursor: held.beforeCursor,
        afterCursor: held.afterCursor,
      };
    }
    return {
      ...kept,
      runs: held.runs,
      beforeCursor: held.beforeCursor,
      afterCursor: held.afterCursor,
    };
  }
  const keepOlderCursor =
    readerPaged && heldEdge !== null && freshEdge !== null && heldEdge.min <= freshEdge.min;
  const heldReachesNewest =
    freshEdge === null || (heldEdge !== null && heldEdge.max >= freshEdge.max);
  const runs = readerPaged || freshEdge === null ? mergeRuns(held.runs, fresh.runs) : fresh.runs;
  return {
    ...kept,
    runs,
    beforeCursor: !freshEdge || keepOlderCursor ? held.beforeCursor : fresh.beforeCursor,
    afterCursor: heldReachesNewest ? held.afterCursor : fresh.afterCursor,
  };
}

/** A cursor page replaces only the edge it came from. */
export function absorbEdge(
  held: HeldTimeline,
  page: TimelinePage,
  edge: 'before' | 'after'
): HeldTimeline {
  return {
    ...held,
    runs: mergeRuns(held.runs, page.runs),
    beforeCursor: edge === 'before' ? page.beforeCursor : held.beforeCursor,
    afterCursor: edge === 'after' ? page.afterCursor : held.afterCursor,
    restrictedReferences: held.restrictedReferences || page.restrictedReferences,
    pagedEarlier: edge === 'before' ? true : held.pagedEarlier === true,
    pagedLater: edge === 'after' ? true : held.pagedLater === true,
  };
}

/** Level-2 pages keep the first copy of an id and the requested edge order. */
export function mergeItemPage(
  current: readonly TimelineItem[],
  page: readonly TimelineItem[],
  edge: 'before' | 'after'
): TimelineItem[] {
  const ordered = edge === 'before' ? [...page, ...current] : [...current, ...page];
  const seen = new Set<string>();
  const items: TimelineItem[] = [];
  for (const item of ordered) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    items.push(item);
  }
  return items;
}

export function holdItems(
  items: readonly TimelineItem[],
  beforeCursor: string | null,
  afterCursor: string | null
): HeldItems {
  return { items: [...items], beforeCursor, afterCursor };
}

export function absorbItemEdge(
  held: HeldItems,
  page: { items: TimelineItem[]; beforeCursor: string | null; afterCursor: string | null },
  edge: 'before' | 'after'
): HeldItems {
  return {
    items: mergeItemPage(held.items, page.items, edge),
    beforeCursor: edge === 'before' ? page.beforeCursor : held.beforeCursor,
    afterCursor: edge === 'after' ? page.afterCursor : held.afterCursor,
  };
}

export function offersOpenAllSteps(stepCount: number): boolean {
  return stepCount > OPEN_ALL_STEPS_THRESHOLD;
}

export function isFollowing(distanceFromEndPx: number): boolean {
  return distanceFromEndPx <= FOLLOW_DISTANCE_PX;
}

export function sentinelDistancePx(viewportHeight: number): number {
  return viewportHeight * SENTINEL_VIEWPORTS;
}

export function shouldPageEdge(distanceToEdgePx: number, viewportHeight: number): boolean {
  return distanceToEdgePx <= sentinelDistancePx(viewportHeight);
}

/** Pixels to add to scrollTop so a prepended page leaves the anchor entry where it was. */
export function scrollCorrection(beforeTop: number, afterTop: number): number {
  return afterTop - beforeTop;
}

/** How many text frames  `deltaCount` events may paint in `elapsedMs`. */
export function textFrames(deltaCount: number, elapsedMs: number): number {
  const budget = Math.max(1, Math.floor(elapsedMs / TEXT_RENDER_INTERVAL_MS));
  return Math.min(deltaCount, budget);
}

export function showJumpToLatest(
  anchor: TimelineAnchorRequest,
  afterCursor: string | null
): boolean {
  return anchor.kind !== 'latest' || afterCursor !== null;
}

/** An Item anchor is useful only when the read also returned its Level-2 window. */
export function itemAnchorHasLevel2(
  page: Pick<ThreadTimelineResponse, 'anchor' | 'itemWindow'>
): boolean {
  return Boolean(
    page.anchor?.itemId && page.itemWindow && page.itemWindow.turnId === page.anchor.turnId
  );
}

function carryDigest(item: TimelineItem): ThreadItem | null {
  if (item.detail.kind !== 'complete') return null;
  const value = item.detail.value;
  if (!value || typeof value !== 'object') return null;
  noteAdmittedArgumentDigest(value, item.argumentDigest);
  return value as ThreadItem;
}

export function completeDetails(items: readonly TimelineItem[]): ThreadItem[] {
  return items.flatMap((item) => {
    const value = carryDigest(item);
    return value ? [value] : [];
  });
}

export function completeThreadItems(runs: readonly TimelineRunEntry[]): ThreadItem[] {
  const items: ThreadItem[] = [];
  for (const run of runs) {
    for (const item of run.narrative) {
      const value = carryDigest(item);
      if (value) items.push(value);
    }
    if (run.plan) {
      const value = carryDigest(run.plan);
      if (value) items.push(value);
    }
  }
  return items;
}

export function previewItems(run: TimelineRunEntry): TimelineItem[] {
  return run.narrative.filter((item) => item.detail.kind === 'preview');
}

/** A preview drawn at its narrative position. `afterItemId` null means it is first. */
export interface NarrativePreview {
  id: string;
  afterItemId: string | null;
  text: string;
  truncated: boolean;
  placement: 'narrative' | 'step';
}

/** Every preview, including one that is not truncated, in read order. */
export function narrativePreviews(items: readonly TimelineItem[]): NarrativePreview[] {
  const previews: NarrativePreview[] = [];
  let afterItemId: string | null = null;
  for (const item of items) {
    if (item.detail.kind === 'preview') {
      previews.push({
        id: item.id,
        afterItemId,
        text: item.detail.text,
        truncated: item.detail.truncated,
        placement: item.placement,
      });
      continue;
    }
    afterItemId = item.id;
  }
  return previews;
}

/**
 * The previous window stays on screen while the same thread loads another anchor.
 * A different thread does not keep it.
 */
export function retainWindowWhileAnchorLoads<T>(
  workspaceId: string,
  threadId: string,
  previous: T | undefined,
  previousKey: readonly unknown[] | undefined
): T | undefined {
  if (previous === undefined || previousKey === undefined) return undefined;
  if (previousKey[1] !== workspaceId || previousKey[2] !== threadId) return undefined;
  return previous;
}

/** Live Items win on id so a streamed body replaces the snapshot copy. */
export function mergeDisplayedItems(
  runs: readonly TimelineRunEntry[],
  live: readonly ThreadItem[]
): ThreadItem[] {
  const fromRuns = completeThreadItems(runs);
  const liveById = new Map(live.map((item) => [item.id, item]));
  const merged = fromRuns.map((item) => liveById.get(item.id) ?? item);
  const seen = new Set(merged.map((item) => item.id));
  for (const item of live) {
    if (!seen.has(item.id)) merged.push(item);
  }
  return merged;
}

export function entryFromRun(run: TimelineRunEntry): TimelineEntry {
  const failed =
    run.status === 'failed'
      ? recordedFailureText(run.error, outcomeLine('failed'))
      : outcomeLine(run.status, run.error?.message);
  const failedCommandCount = recordedCount(run.statistics.failedCommandCount);
  const failedStepCount = recordedCount(run.statistics.failedStepCount);
  return {
    turnId: run.id,
    header: { copyKey: 'run-trigger' },
    narrative: run.narrative.map((item) => ({ kind: item.type, itemId: item.id })),
    notes: run.noteItemIds.map((itemId) => ({
      kind: 'assistant-message-earlier' as const,
      itemId,
    })),
    plan: run.plan ? { itemId: run.plan.id } : null,
    stats: {
      stepCount: run.statistics.steps,
      fileCount: run.statistics.filesChanged,
      ...(failedCommandCount == null ? {} : { failedCommandCount }),
      ...(failedStepCount == null ? {} : { failedStepCount }),
    },
    long: run.long,
    stepWindow: [],
    outcome: failed ? { copyKey: 'run-outcome', text: failed } : null,
    usage: run.usage ?? null,
    fallback: run.fallback ?? null,
    planSegments: run.planSegments ?? null,
    errorPresentation: run.error?.presentation ?? null,
    reportedActivity: Object.hasOwn(run, 'reportedActivity')
      ? (run.reportedActivity ?? null)
      : null,
    policies: [
      ...run.narrative.map((item) => ({ id: item.id, policy: item.policy ?? null })),
      ...(run.plan ? [{ id: run.plan.id, policy: run.plan.policy ?? null }] : []),
    ],
  };
}

export function turnHasCompletedAnswer(runs: readonly TimelineRunEntry[], turnId: string): boolean {
  const run = runs.find((candidate) => candidate.id === turnId);
  if (!run) return false;
  return run.narrative.some(
    (item) =>
      item.type === 'assistant-message' &&
      item.status === 'completed' &&
      item.detail.kind === 'complete'
  );
}

export function runHasDecision(run: TimelineRunEntry): boolean {
  return run.narrative.some(
    (item) => item.type === 'approval-request' || item.type === 'user-input-request'
  );
}

/** Poll cadence. Hidden pages do not refresh. */
export function windowPollMs(state: {
  hidden: boolean;
  running: boolean;
  pending: boolean;
}): number | false {
  if (state.hidden) return false;
  if (state.running || state.pending) return RUNNING_POLL_MS;
  return IDLE_POLL_MS;
}

const MEASURED_OPENING = new Set<AgentProfileId>(['task', 'default', 'goal', 'knowledge']);

/** Task, goal, knowledge, and default open at B when the new tail is long. */
export function wantsMeasuredOpening(profile: AgentProfileId): boolean {
  return MEASURED_OPENING.has(profile);
}

/**
 * First read when the URL has no anchor.
 * An explicit anchor wins. Assistant and administration open at the end.
 * The other profiles start at the catch-up anchor so the tail can be measured.
 */
export function provisionalOpeningAnchor(
  profile: AgentProfileId,
  explicit: TimelineAnchorRequest
): TimelineAnchorRequest {
  if (explicit.kind !== 'latest') return explicit;
  if (wantsMeasuredOpening(profile)) return { kind: 'catch-up' };
  return { kind: 'latest' };
}

/** After that measurement. A short tail follows the end. */
export function settledOpeningAnchor(
  profile: AgentProfileId,
  explicit: TimelineAnchorRequest,
  longerThanScreen: boolean
): TimelineAnchorRequest {
  if (explicit.kind !== 'latest') return explicit;
  if (!wantsMeasuredOpening(profile)) return { kind: 'latest' };
  return longerThanScreen ? { kind: 'catch-up' } : { kind: 'latest' };
}

/**
 * New content is longer than one screen when the loaded tail already is,
 * or when the read still has a continuation after B.
 */
export function newContentExceedsScreen(input: {
  continues: boolean;
  contentAfterPx: number;
  viewportPx: number;
}): boolean {
  if (input.continues) return true;
  return input.contentAfterPx > input.viewportPx;
}

/** Administration has no divider. Assistant shows one only for an unread answer. */
export function showCatchUpDivider(input: {
  profile: AgentProfileId;
  catchUp: { turnId: string } | null;
  hasUnreadAnswer: boolean;
}): boolean {
  if (!input.catchUp) return false;
  if (input.profile === 'administration') return false;
  if (input.profile === 'assistant') return input.hasUnreadAnswer;
  return true;
}

export interface CatchUpItemRef {
  id: string;
  turnId: string;
  index: number;
  type: string;
}

/**
 * The divider sits just after B. Inside that run when B's item is loaded;
 * otherwise at the start of B's run. Absent when that run is not loaded.
 */
export function dividerPlacement(input: {
  runs: readonly { id: string }[];
  items: readonly CatchUpItemRef[];
  catchUp: { turnId: string; itemId?: string } | null;
}): { turnId: string; afterItemId: string | null } | null {
  if (!input.catchUp) return null;
  if (!input.runs.some((run) => run.id === input.catchUp?.turnId)) return null;
  const itemId = input.catchUp.itemId;
  if (
    itemId &&
    input.items.some((item) => item.id === itemId && item.turnId === input.catchUp?.turnId)
  ) {
    return { turnId: input.catchUp.turnId, afterItemId: itemId };
  }
  return { turnId: input.catchUp.turnId, afterItemId: null };
}

/**
 * Unread messages before B, in window order. The receipt set is not trimmed.
 * An unread id that neither the loaded items nor `located` places has no order,
 * so the result is empty instead of a nearer loaded message.
 */
export function earlierUnread(input: {
  items: readonly CatchUpItemRef[];
  unreadIds: ReadonlySet<string>;
  catchUp: { turnId: string; itemId?: string } | null;
  runOrder: ReadonlyMap<string, number>;
  /** Placements from item-anchor reads for ids outside `items`. */
  located?: readonly CatchUpItemRef[];
}): { count: number; oldestId: string | null } {
  if (!input.catchUp) return { count: 0, oldestId: null };
  const located = input.located ?? [];
  const byId = new Map<string, CatchUpItemRef>();
  for (const item of input.items) byId.set(item.id, item);
  for (const item of located) if (!byId.has(item.id)) byId.set(item.id, item);
  for (const id of input.unreadIds) {
    if (!byId.has(id)) return { count: 0, oldestId: null };
  }
  const anchorOrder = input.runOrder.get(input.catchUp.turnId);
  if (anchorOrder === undefined) return { count: 0, oldestId: null };
  const anchorIndex = input.catchUp.itemId ? (byId.get(input.catchUp.itemId)?.index ?? null) : null;
  const ordered = [...byId.values()].sort((left, right) => {
    const leftOrder = input.runOrder.get(left.turnId) ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = input.runOrder.get(right.turnId) ?? Number.MAX_SAFE_INTEGER;
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    return left.index - right.index;
  });
  const ids = ordered
    .filter((item) => {
      if (item.type !== 'user-message' && item.type !== 'assistant-message') return false;
      if (!input.unreadIds.has(item.id)) return false;
      const order = input.runOrder.get(item.turnId);
      if (order === undefined) return false;
      if (order < anchorOrder) return true;
      if (order > anchorOrder) return false;
      if (anchorIndex === null) return false;
      return item.index < anchorIndex;
    })
    .map((item) => item.id);
  return { count: ids.length, oldestId: ids[0] ?? null };
}

/** Receipt membership is the mark. Position relative to B does not clear it. */
export function keepsUnreadMark(itemId: string, unreadIds: ReadonlySet<string>): boolean {
  return unreadIds.has(itemId);
}

const ENDED_RUN = new Set(['completed', 'failed', 'interrupted', 'cancelled']);

/** A run that ended with no message stays new until a seen-through marker exists. */
export function runStaysNew(input: {
  status: string;
  messages: number;
  admissionOrder: number;
  catchUpOrder: number | null;
}): boolean {
  if (input.catchUpOrder === null) return false;
  if (!ENDED_RUN.has(input.status)) return false;
  if (input.messages !== 0) return false;
  return input.admissionOrder > input.catchUpOrder;
}

/**
 * Loaded Item named by a request address.
 * The request card wins over a later decision that repeats the same id.
 * Null when that Item is not in the loaded window.
 */
export function itemIdForRequest(
  items: readonly {
    id: string;
    type: string;
    approvalRequestId?: string;
    userInputRequestId?: string;
  }[],
  requestId: string
): string | null {
  let fallback: string | null = null;
  for (const item of items) {
    const named = item.approvalRequestId === requestId || item.userInputRequestId === requestId;
    if (!named) continue;
    if (item.type === 'approval-request' || item.type === 'user-input-request') return item.id;
    fallback ??= item.id;
  }
  return fallback;
}

/** Jumps inside the timeline replace history, so Back leaves the thread. */
export function timelineJump(input: {
  pathname: string;
  search: string;
  jump: { kind: 'item'; itemId: string } | { kind: 'catch-up' } | { kind: 'latest' };
}): { pathname: string; search: string; replace: true } {
  const params = new URLSearchParams(
    input.search.startsWith('?') ? input.search.slice(1) : input.search
  );
  params.delete('item');
  params.delete('attention');
  params.delete('row');
  params.delete('turnId');
  params.delete('turn');
  params.delete('catchUp');
  params.delete('request');
  params.delete('approvalRequest');
  params.delete('userInputRequest');
  if (input.jump.kind === 'item') params.set('item', input.jump.itemId);
  if (input.jump.kind === 'catch-up') params.set('catchUp', '1');
  const search = params.toString();
  return {
    pathname: input.pathname,
    search: search ? `?${search}` : '',
    replace: true,
  };
}
