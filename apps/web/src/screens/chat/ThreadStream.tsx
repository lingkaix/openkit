import { createRequestId } from '@openkit/core-client';
import { useQueryClient } from '@tanstack/react-query';
import {
  type ComponentProps,
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { usePersistentNavigation } from '../../app/AppShell';
import { useConnection, useCoreClient } from '../../app/core-client';
import { useGenerativeSourceGroups } from '../../generative/source-groups';
import {
  Button,
  EmptyState,
  ErrorBanner,
  Skeleton,
  TurnSeparator,
  toastQueue,
} from '../../primitives';
import { openHrefForRow } from '../workspace/data';
import {
  type ThreadItem,
  useLiveThreadItems,
  useLoadEarlierItems,
  useRespondApproval,
  useSubmitTurnAnswers,
  useThreadItemCursor,
  useThreadItems,
  useWithdrawPendingRequest,
} from './data';
import { GenerativePresentationView } from './GenerativePresentationView';
import { ItemView } from './ItemView';
import { ThreadReadReceipts, useThreadUnreadIds } from './ThreadReadReceipts';
import { AlignmentHeader } from './timeline/AlignmentHeader';
import { CatchUpDivider } from './timeline/CatchUpDivider';
import { selectedRunLabel, timelineCopy } from './timeline/copy';
import { DecisionRowSheet, DecisionSheet } from './timeline/decision-sheet';
import { classifyRunError, freshnessCopy, isDeniedRead } from './timeline/degraded';
import { openDecisionIds, planEmphasis } from './timeline/emphasis';
import { buildAlignment } from './timeline/header';
import { Inspector } from './timeline/Inspector';
import { readStoredLens, writeStoredLens } from './timeline/lens-store';
import { NeedsYouBar, useTimelineAttention } from './timeline/NeedsYouBar';
import { NowLine } from './timeline/NowLine';
import { readTimelineHistory, writeTimelineHistory } from './timeline/navigation-state';
import {
  attentionWalk,
  barDecisionTarget,
  focusTimelineItem,
  openDecisionsAfter,
  orderNeedsYou,
  scopeNeedsYou,
  toNeedsYouRow,
} from './timeline/needs-you';
import { nowFromThread, nowStepFromDashboard } from './timeline/now';
import { PhoneBar, PhoneSheetFrame, type TimelineSheets } from './timeline/PhoneChrome';
import { shortenProgress } from './timeline/phone';
import { isStepItem, plainActorName, runDurationMs, taskSpecObjective } from './timeline/present';
import { selectAgentProfile } from './timeline/profiles';
import { RunEntry } from './timeline/RunEntry';
import {
  captureCopy,
  coverageCopy,
  omittedActivityCopy,
  projectTimeline,
  runSeparatorCopy,
} from './timeline/source';
import { scrollParent, TimelineScroll } from './timeline/TimelineScroll';
import { TimelineTime } from './timeline/TimelineTime';
import {
  durationDateTime,
  NOW_ELAPSED_CLOCK_MS,
  TIMELINE_CLOCK_MS,
  TimelineNowProvider,
  useReducedMotion,
} from './timeline/time';
import type { LensName } from './timeline/types';
import {
  timelineReadAvailable,
  useCoalescedItems,
  useRunItemWindow,
  useTimelineWindow,
} from './timeline/use-timeline-window';
import {
  type CatchUpItemRef,
  completeDetails,
  dividerPlacement,
  earlierUnread,
  entryFromRun,
  holdItems,
  itemAnchorHasLevel2,
  keepsUnreadMark,
  mergeDisplayedItems,
  narrativePreviews,
  newContentExceedsScreen,
  runHasDecision,
  runStaysNew,
  showCatchUpDivider,
  showJumpToLatest,
  type TimelineAnchorRequest,
} from './timeline/window';

/** Seconds since a running Turn started. Zero when the timestamp cannot be read. */
function itemBodyText(item: ThreadItem): string {
  if ('text' in item && typeof item.text === 'string') return item.text;
  if ('output' in item && typeof item.output === 'string') return item.output;
  if ('content' in item && typeof item.content === 'string') return item.content;
  if ('result' in item && typeof item.result === 'string') return item.result;
  return '';
}

function mergeUnique(current: readonly ThreadItem[], extra: readonly ThreadItem[]): ThreadItem[] {
  const seen = new Set(current.map((item) => item.id));
  const merged = [...current];
  for (const item of extra) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    merged.push(item);
  }
  return merged;
}

function elapsedSeconds(startedAt: string): number {
  const started = Date.parse(startedAt);
  if (!Number.isFinite(started)) return 0;
  return Math.max(0, Math.floor((Date.now() - started) / 1000));
}

/** The latest tool call that is still running, if this Turn has one. */
function latestRunningStep(
  items: readonly ThreadItem[]
): Extract<ThreadItem, { type: 'tool-call' }> | undefined {
  return items.findLast(
    (item): item is Extract<ThreadItem, { type: 'tool-call' }> =>
      item.type === 'tool-call' && item.status !== 'completed' && item.status !== 'failed'
  );
}

/**
 * Question text from the request item this attention row already names.
 * Secret questions stay off the bar. A generic row title is left unchanged when nothing is loaded.
 */
function carriedQuestion(
  items: readonly ThreadItem[] | undefined,
  itemId: string | undefined
): string | undefined {
  if (!itemId || !items) return undefined;
  const item = items.find((entry) => entry.id === itemId);
  if (item?.type !== 'user-input-request') return undefined;
  const question = item.questions.find((entry) => !entry.isSecret);
  return question?.question || item.prompt;
}

export interface ThreadStreamProps {
  workspaceId: string | null;
  threadId: string;
  /** When true (runtime disconnected), inline approval and input actions are read-only. */
  readOnly?: boolean;
  /** Empty-state title when the thread has no items yet. */
  emptyTitle?: string;
  /** Exact retained Turn selected by a link; lookup never starts or repairs work. */
  focusTurnId?: string | null;
  /** Side slot owned by the thread screen. The Inspector portals here on desktop. */
  panelHost?: RefObject<HTMLDivElement | null>;
  /** Header-owned lens. When omitted, the stream shows the switch and remembers it. */
  lens?: LensName;
  /** Chat, task, or goal framing. Task adds the alignment header. */
  mode?: 'chat' | 'task' | 'goal';
  /** Stop was pressed and the run has not reached a final state. */
  stopPending?: boolean;
  /** Item anchor from a Needs you jump. */
  focusItemId?: string | null;
  /** Window anchor. Defaults to latest. Item and run links set this from the URL. */
  anchor?: TimelineAnchorRequest;
  /** A run is in progress. The window refreshes every 5 seconds. */
  running?: boolean;
  /** A run is waiting to start. The window refreshes every 5 seconds. */
  pending?: boolean;
  /** Clears an Item, run, or catch-up anchor after Jump to latest. */
  onJumpToLatest?: () => void;
  /** Replace-history jump to one loaded item. Parents own the router. */
  onJumpToItem?: (itemId: string) => void;
  /** Profile opening is still measuring the tail. The parent owns the anchor. */
  measureOpening?: boolean;
  /** Settles the opening read on catch-up or latest. */
  onOpeningSettle?: (anchor: TimelineAnchorRequest) => void;
  /** Open a row's owning surface. Same-thread anchors scroll instead. */
  onOpen?: (href: string) => void;
  /**
   * Coordinator narrative only. The Goal screen owns the board and the merged Needs you bar.
   * This stream does not add a second one, and it has no Steer control.
   */
  narrativeOnly?: boolean;
  /** URL-backed sheets. Desktop ignores the inspector here. Steps open on both. */
  sheets?: TimelineSheets;
  /** Host for the new-updates control, outside the scrolling entries. */
  updatesHost?: HTMLElement | null;
  /**
   * A stale dashboard is already cached. Hide runs until this mount's read succeeds.
   * A pending read with no cache still shows its own checking state.
   */
  holdContent?: boolean;
}

/**
 * Thread item stream (WP-4) — the conversation column (DESIGN.md §3.2).
 *
 * Renders every applicable §9.13 state: a skeleton while the read model is in
 * flight, an inline error with retry, a calm empty block, or the populated stream
 * grouped by Turn (Thread → Turn → Item). Each durable failed Turn that is not the
 * latest keeps its recorded dashboard error beside that Turn, including Turns with no
 * Items. Authorized runtime activity appears once at each Turn's final Item group, or an empty group, as plain text with explicit coverage and presentation omissions; it creates no pending request or execution state. A failed dashboard refresh suppresses cached activity until a successful read, with retry owned by the existing dashboard query. Unresolved approvals and non-secret input requests are
 * actionable inline unless read-only. Baseline readiness stays sticky only for the current
 * Workspace and Thread so later command refetches cannot tear down its live subscription.
 */
export function ThreadStream({
  workspaceId,
  threadId,
  readOnly,
  emptyTitle,
  focusTurnId,
  panelHost,
  lens: lensProp,
  mode,
  stopPending,
  focusItemId,
  anchor: anchorProp,
  running,
  pending,
  onJumpToLatest,
  onJumpToItem,
  measureOpening,
  onOpeningSettle,
  onOpen,
  narrativeOnly,
  sheets,
  updatesHost,
  holdContent = false,
}: ThreadStreamProps) {
  const phone = !usePersistentNavigation();
  const [internalLens, setInternalLens] = useState<LensName>(() =>
    typeof window !== 'undefined' && window.matchMedia?.('(max-width: 799px)')?.matches
      ? 'work'
      : readStoredLens()
  );
  const client = useCoreClient();
  const timelineOn = timelineReadAvailable(client);
  const anchor = anchorProp ?? { kind: 'latest' as const };
  const [anchorOverride, setAnchorOverride] = useState<TimelineAnchorRequest | null>(null);
  const [anchorKey, setAnchorKey] = useState(() => JSON.stringify(anchor));
  const nextAnchorKey = JSON.stringify(anchor);
  if (nextAnchorKey !== anchorKey) {
    setAnchorKey(nextAnchorKey);
    setAnchorOverride(null);
  }
  const parentOpening = onOpeningSettle !== undefined;
  const [localSettled, setLocalSettled] = useState<TimelineAnchorRequest | null>(null);
  const localJumped = useRef(false);
  const openingMeasured = useRef(false);
  const uncontrolledCatchUp =
    !parentOpening &&
    Boolean(narrativeOnly) &&
    anchor.kind === 'latest' &&
    !localJumped.current &&
    localSettled === null;
  const baseAnchor: TimelineAnchorRequest = parentOpening
    ? anchor
    : localJumped.current
      ? { kind: 'latest' }
      : (localSettled ?? (uncontrolledCatchUp ? { kind: 'catch-up' } : anchor));
  const windowAnchor = anchorOverride ?? baseAnchor;
  const measureOpeningActive = parentOpening ? Boolean(measureOpening) : uncontrolledCatchUp;
  const settleOpening = onOpeningSettle ?? setLocalSettled;
  const [followNew, setFollowNew] = useState({ count: 0, decision: false });
  const following = useRef(windowAnchor.kind === 'latest');
  const knownRunIds = useRef<Set<string>>(new Set());
  const [localDecision, setLocalDecision] = useState<string | null>(null);
  const [localSteps, setLocalSteps] = useState<string | null>(null);
  const [localInspect, setLocalInspect] = useState<string | null>(null);
  const [sheetExpanded, setSheetExpanded] = useState(false);
  const phoneInspectId = phone ? (sheets?.inspectTurnId ?? localInspect) : null;
  const lens = lensProp ?? internalLens;
  const historyScope = `${workspaceId ?? ''}:${threadId}`;
  const restoredScope = useRef<string | null>(null);
  const restoredNavigation = useRef<ReturnType<typeof readTimelineHistory>>(null);
  if (restoredScope.current !== historyScope) {
    restoredScope.current = historyScope;
    restoredNavigation.current =
      typeof window === 'undefined' ? null : readTimelineHistory(window.history.state);
  }
  const [expandedScope, setExpandedScope] = useState(historyScope);
  const [expandedTurnId, setExpandedTurnId] = useState<string | null>(
    () => restoredNavigation.current?.expandedRunIds[0] ?? null
  );
  if (expandedScope !== historyScope) {
    setExpandedScope(historyScope);
    setExpandedTurnId(restoredNavigation.current?.expandedRunIds[0] ?? null);
  }
  function rememberExpanded(turnId: string | null) {
    setExpandedTurnId(turnId);
    if (typeof window === 'undefined') return;
    writeTimelineHistory(window.history, { expandedRunIds: turnId ? [turnId] : [] });
  }
  const [followRequest, setFollowRequest] = useState(0);
  const [inspectedTurnId, setInspectedTurnId] = useState<string | null>(null);
  const inspectButtonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const [portalNode, setPortalNode] = useState<HTMLElement | null>(null);
  const connection = useConnection();
  const queryClient = useQueryClient();
  const items = useThreadItems(workspaceId, threadId, false, !timelineOn);
  const liveSnapshot = useCoalescedItems(timelineOn ? items.data : undefined);
  const timelineWindow = useTimelineWindow({
    workspaceId,
    threadId,
    anchor: windowAnchor,
    enabled: timelineOn,
    running: Boolean(running),
    pending: Boolean(pending),
  });
  const stepsTurnId = sheets?.stepsTurnId ?? localSteps;
  const anchoredWindow =
    timelineWindow.data && itemAnchorHasLevel2(timelineWindow.data)
      ? timelineWindow.data.itemWindow
      : null;
  const fullTurnId =
    lens === 'full'
      ? (timelineWindow.data?.anchor?.turnId ?? timelineWindow.data?.runs.at(-1)?.id ?? null)
      : null;
  const level2TurnId = timelineOn
    ? (stepsTurnId ?? expandedTurnId ?? fullTurnId ?? anchoredWindow?.turnId ?? null)
    : null;
  const level2Seed =
    anchoredWindow && anchoredWindow.turnId === level2TurnId
      ? holdItems(anchoredWindow.items, anchoredWindow.beforeCursor, anchoredWindow.afterCursor)
      : null;
  const level2Run = timelineWindow.data?.runs.find((run) => run.id === level2TurnId);
  const level2Placement = stepsTurnId || expandedTurnId ? 'step' : 'all';
  const level2 = useRunItemWindow({
    workspaceId,
    threadId,
    turnId: level2TurnId,
    enabled: timelineOn && timelineWindow.isFetched && Boolean(level2TurnId),
    placement: level2Placement,
    cursor: level2Seed || level2Placement === 'step' ? null : (level2Run?.narrativeCursor ?? null),
    seed: level2Seed,
  });
  useLayoutEffect(() => {
    if (!measureOpeningActive || openingMeasured.current) return;
    if (!timelineWindow.isSuccess || !timelineWindow.data) return;
    const catchUp = timelineWindow.data.catchUpAnchor;
    if (!catchUp) {
      openingMeasured.current = true;
      settleOpening({ kind: 'latest' });
      return;
    }
    const continues = Boolean(
      timelineWindow.data.afterCursor || timelineWindow.data.itemWindow?.afterCursor
    );
    if (continues) {
      openingMeasured.current = true;
      settleOpening({ kind: 'catch-up' });
      return;
    }
    const divider = document.querySelector<HTMLElement>('[data-catch-up-divider]');
    if (!divider) return;
    const scroller = scrollParent(divider);
    if (scroller.clientHeight <= 0) return;
    const top =
      divider.getBoundingClientRect().top -
      scroller.getBoundingClientRect().top +
      scroller.scrollTop;
    const contentAfterPx = Math.max(0, scroller.scrollHeight - top - divider.offsetHeight);
    const longer = newContentExceedsScreen({
      continues: false,
      contentAfterPx,
      viewportPx: scroller.clientHeight,
    });
    openingMeasured.current = true;
    settleOpening(longer ? { kind: 'catch-up' } : { kind: 'latest' });
  });
  const [fullText, setFullText] = useState<Record<string, string>>({});
  const scopeKey = `${workspaceId ?? ''}:${threadId}`;
  const [seenScope, setSeenScope] = useState(scopeKey);
  if (seenScope !== scopeKey) {
    setSeenScope(scopeKey);
    knownRunIds.current = new Set();
    setFollowNew({ count: 0, decision: false });
    setLocalSettled(null);
    localJumped.current = false;
    openingMeasured.current = false;
  }
  useEffect(() => {
    if (!timelineOn) return;
    const next = timelineWindow.data?.runs ?? [];
    const known = knownRunIds.current;
    if (known.size === 0) {
      for (const run of next) known.add(run.id);
      return;
    }
    const oldestKnown = next.find((run) => known.has(run.id))?.admissionOrder;
    let added = 0;
    let decision = false;
    for (const run of next) {
      if (known.has(run.id)) continue;
      known.add(run.id);
      const prepended = oldestKnown !== undefined && run.admissionOrder < oldestKnown;
      if (prepended || following.current) continue;
      added += 1;
      if (runHasDecision(run)) decision = true;
    }
    if (added > 0) {
      setFollowNew((current) => ({
        count: current.count + added,
        decision: current.decision || decision,
      }));
    }
  }, [timelineOn, timelineWindow.data]);
  const seenLiveIds = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!timelineOn) return;
    const ids = liveSnapshot.map((item) => item.id);
    if (following.current) {
      seenLiveIds.current = new Set(ids);
      return;
    }
    const known = seenLiveIds.current;
    seenLiveIds.current = new Set(ids);
    if (known === null) return;
    let added = 0;
    for (const id of ids) if (!known.has(id)) added += 1;
    if (added === 0) return;
    setFollowNew((current) => ({ count: current.count + added, decision: current.decision }));
  }, [liveSnapshot, timelineOn]);
  const cursor = useThreadItemCursor(workspaceId, threadId);
  const loadEarlier = useLoadEarlierItems(workspaceId, threadId);
  const earlierCursor =
    typeof cursor.data === 'string' && cursor.data.length > 0 ? cursor.data : null;
  const decisionScope = useRef<string | null>(null);
  const knownDecisionIds = useRef<Set<string>>(new Set());
  const decisionIds = (
    timelineOn
      ? (timelineWindow.data?.runs ?? []).flatMap((run) =>
          run.narrative
            .filter(
              (item) => item.type === 'approval-request' || item.type === 'user-input-request'
            )
            .map((item) => item.id)
        )
      : (items.data ?? [])
          .filter((item) => item.type === 'approval-request' || item.type === 'user-input-request')
          .map((item) => item.id)
  ).join('\n');
  useEffect(() => {
    const ready = timelineOn ? timelineWindow.isSuccess : items.isSuccess;
    if (!workspaceId || !ready) return;
    const ids = decisionIds.length === 0 ? [] : decisionIds.split('\n');
    const scope = `${workspaceId}:${threadId}`;
    if (decisionScope.current !== scope) {
      decisionScope.current = scope;
      knownDecisionIds.current = new Set(ids);
      return;
    }
    const arrived = ids.some((id) => !knownDecisionIds.current.has(id));
    knownDecisionIds.current = new Set(ids);
    if (!arrived) return;
    if (timelineOn && !following.current) {
      setFollowNew((current) => ({ ...current, decision: true }));
    }
    void queryClient.invalidateQueries({ queryKey: ['attention', workspaceId] });
  }, [
    decisionIds,
    items.isSuccess,
    queryClient,
    threadId,
    timelineOn,
    timelineWindow.isSuccess,
    workspaceId,
  ]);
  const historySuccess = timelineOn ? timelineWindow.isSuccess : items.isSuccess;
  const historyLoading = timelineOn ? timelineWindow.isLoading : items.isLoading;
  const historyError = timelineOn ? timelineWindow.isError : items.isError;
  const historyDenied = isDeniedRead(timelineOn ? timelineWindow.error : items.error);
  const baselineCandidate =
    historySuccess &&
    (timelineOn
      ? timelineWindow.fetchStatus === 'idle' || timelineWindow.isFetchedAfterMount
      : items.fetchStatus === 'idle' || items.isFetchedAfterMount);
  const [baseline, setBaseline] = useState(() => ({
    workspaceId,
    threadId,
    ready: baselineCandidate,
  }));

  useEffect(() => {
    setBaseline((current) => {
      if (current.workspaceId !== workspaceId || current.threadId !== threadId) {
        return { workspaceId, threadId, ready: baselineCandidate };
      }
      if (baselineCandidate && !current.ready) return { ...current, ready: true };
      return current;
    });
  }, [baselineCandidate, threadId, workspaceId]);

  const baselineReady =
    baseline.workspaceId === workspaceId && baseline.threadId === threadId && baseline.ready;
  const windowRuns = timelineOn && timelineWindow.data ? timelineWindow.data.runs : null;
  const anchoredItems = timelineWindow.data?.itemWindow
    ? completeDetails(timelineWindow.data.itemWindow.items)
    : [];
  const feedItems = windowRuns
    ? mergeUnique(mergeDisplayedItems(windowRuns, liveSnapshot), [
        ...anchoredItems,
        ...level2.completeItems,
      ])
    : (items.data ?? []);
  const sourceGroups = useGenerativeSourceGroups(feedItems);
  const groupedSourceIds = new Set([...sourceGroups.values()].map((item) => item.id));
  const live = useLiveThreadItems(workspaceId, threadId, historySuccess, baselineReady);
  const dashboard = live.data;
  const attention = useTimelineAttention(workspaceId);
  const reducedMotion = useReducedMotion();
  const liveElapsed = Boolean(
    dashboard?.turns.some((turn) => turn.status === 'running' || turn.status === 'pending')
  );
  const [clock, setClock] = useState(() => Date.now());
  const itemLocated = useRef<string | null>(null);
  const openedAnchor = useRef<string | null>(null);
  useEffect(() => {
    const timer = setInterval(
      () => setClock(Date.now()),
      liveElapsed ? NOW_ELAPSED_CLOCK_MS : TIMELINE_CLOCK_MS
    );
    return () => clearInterval(timer);
  }, [liveElapsed]);
  const anchoredItemId =
    focusItemId ??
    timelineWindow.data?.anchor?.itemId ??
    timelineWindow.data?.catchUpAnchor?.itemId ??
    null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: rememberExpanded is recreated each render; openedAnchor records the one expand.
  useEffect(() => {
    if (!anchoredItemId || historyLoading || feedItems.length === 0) return;
    if (itemLocated.current === anchoredItemId) return;
    const item = feedItems.find((candidate) => candidate.id === anchoredItemId);
    if (item && isStepItem(item) && expandedTurnId !== item.turnId && lens !== 'full') {
      if (openedAnchor.current !== anchoredItemId) {
        openedAnchor.current = anchoredItemId;
        rememberExpanded(item.turnId);
      }
      return;
    }
    if (focusTimelineItem(anchoredItemId)) itemLocated.current = anchoredItemId;
  }, [anchoredItemId, expandedTurnId, feedItems, historyLoading, lens]);
  const respond = useRespondApproval(workspaceId ?? '', threadId);
  const submitAnswers = useSubmitTurnAnswers(workspaceId ?? '', threadId);
  const withdraw = useWithdrawPendingRequest(workspaceId ?? '', threadId);
  const controlsReadOnly = Boolean(readOnly || !workspaceId || !connection.connected);
  const unreadIds = useThreadUnreadIds(
    workspaceId,
    threadId,
    dashboard?.viewerUserId,
    feedItems,
    controlsReadOnly || live.isError
  );
  const itemsDenied = historyDenied;
  const [missedRefreshes, setMissedRefreshes] = useState(0);
  const seenRefreshError = useRef(0);
  useEffect(() => {
    if (itemsDenied || isDeniedRead(live.error)) toastQueue.clear();
  }, [itemsDenied, live.error]);
  useEffect(() => {
    const stamp = Math.max(
      items.errorUpdatedAt,
      live.errorUpdatedAt,
      timelineOn ? timelineWindow.errorUpdatedAt : 0
    );
    if (!items.isError && !live.isError && !historyError) {
      seenRefreshError.current = 0;
      setMissedRefreshes(0);
      return;
    }
    if (stamp > seenRefreshError.current) {
      seenRefreshError.current = stamp;
      setMissedRefreshes((count) => count + 1);
    }
  }, [
    historyError,
    items.errorUpdatedAt,
    items.isError,
    live.errorUpdatedAt,
    live.isError,
    timelineOn,
    timelineWindow.errorUpdatedAt,
  ]);
  const fresh = freshnessCopy(
    missedRefreshes,
    Math.max(
      items.dataUpdatedAt,
      live.dataUpdatedAt,
      timelineOn ? timelineWindow.dataUpdatedAt : 0
    ),
    clock
  );
  const holdReason = fresh ?? undefined;
  const focusedElement = useRef<HTMLDivElement>(null);
  const located = useRef<string | null>(null);
  const focusedDashboard =
    focusTurnId &&
    !live.isError &&
    dashboard?.thread.id === threadId &&
    dashboard.thread.owner.kind === 'workspace' &&
    dashboard.thread.owner.workspaceId === workspaceId
      ? dashboard
      : undefined;
  const selectedTurn = focusedDashboard?.turns.find((turn) => turn.id === focusTurnId);
  const focusKey = JSON.stringify([workspaceId, threadId, focusTurnId]);
  useEffect(() => {
    if (!selectedTurn || historyLoading || historyError || !focusedElement.current) {
      if (located.current !== focusKey) located.current = null;
      return;
    }
    if (located.current === focusKey) return;
    focusedElement.current.scrollIntoView({ block: 'center' });
    located.current = focusKey;
  }, [focusKey, historyError, historyLoading, selectedTurn]);
  const unavailableTurn = Boolean(focusTurnId && focusedDashboard && !selectedTurn);
  useEffect(() => {
    setPortalNode(!phone && inspectedTurnId ? (panelHost?.current ?? null) : null);
  }, [inspectedTurnId, panelHost, phone]);
  useEffect(() => {
    const openId = phone ? phoneInspectId : inspectedTurnId;
    if (!openId) return;
    if (!phone && panelHost && !portalNode) return;
    panelRef.current?.focus();
  }, [inspectedTurnId, panelHost, phone, phoneInspectId, portalNode]);

  if (holdContent) {
    return (
      <div className="flex flex-col gap-5" aria-busy="true">
        <div className="ok-run-skeleton" aria-hidden="true">
          <Skeleton lines={3} />
        </div>
      </div>
    );
  }

  if (historyLoading) {
    return (
      <div className="flex flex-col gap-5" aria-busy="true">
        <div className="ok-bar-slot" aria-hidden="true" />
        <div className="ok-run-skeleton" aria-hidden="true">
          <Skeleton lines={3} />
        </div>
      </div>
    );
  }

  if (historyDenied || historyError) {
    return (
      <ErrorBanner
        message={historyDenied ? timelineCopy.deniedRead : "Couldn't load this thread."}
        onRetry={() => void (timelineOn ? timelineWindow.refetch() : items.refetch())}
      />
    );
  }

  const latestTurnId = dashboard?.turns.at(-1)?.id;
  const activityByTurn = new Map(
    live.isError ? [] : dashboard?.runtimeActivity?.map((activity) => [activity.turnId, activity])
  );
  const timeline = windowRuns
    ? {
        groups: windowRuns.map((run) => ({
          turnId: run.id,
          items: feedItems.filter((item) => item.turnId === run.id),
        })),
        entries: windowRuns.map((run) => entryFromRun(run)),
      }
    : projectTimeline({
        items: feedItems,
        turns: dashboard?.turns,
        latestTurnId,
        focusTurnId: selectedTurn ? focusTurnId : null,
        activityTurnIds: new Set(activityByTurn.keys()),
      });
  const groups = timeline.groups;
  const entryByTurn = new Map(timeline.entries.map((entry) => [entry.turnId, entry]));
  const participantNames = new Map(
    dashboard?.participants?.map((participant) => [
      `${participant.kind}:${participant.id}`,
      participant.displayName,
    ])
  );
  const turnAuthors = new Map(
    dashboard?.turns.map((turn) => [
      turn.id,
      turn.agentId ? (participantNames.get(`agent:${turn.agentId}`) ?? turn.agentId) : undefined,
    ])
  );
  const profile = selectAgentProfile({
    entryPath: dashboard?.thread?.entryPath,
    mode,
  });
  const profileId = profile.state === 'ready' ? profile.profile.id : 'default';
  const scoped = orderNeedsYou(scopeNeedsYou(attention.data ?? [], [threadId])).map((row) =>
    toNeedsYouRow(row, openHrefForRow(row), undefined, carriedQuestion(feedItems, row.itemId))
  );
  const latestTurn = dashboard?.turns.at(-1);
  const dashboardNow = dashboard?.now;
  const lastKnownAt = latestTurn?.completedAt ?? latestTurn?.startedAt;
  const nowModel = nowFromThread({
    now: clock,
    readFailed: live.isError,
    stopPending: Boolean(stopPending),
    turns: (dashboard?.turns ?? []).map((turn) => ({
      id: turn.id,
      status: turn.status,
      startedAt: turn.startedAt,
      completedAt: turn.completedAt,
      errorMessage: turn.error?.message,
      reasoningEffort: turn.reasoningEffort,
    })),
    items: feedItems,
    blockingCount: scoped.filter((row) => row.blocking).length,
    lastKnown: latestTurn && lastKnownAt ? { status: latestTurn.status, at: lastKnownAt } : null,
    liveEventAt: dashboardNow?.lastEventAt,
    queueAhead:
      dashboardNow?.queuePosition != null && dashboardNow.queuePosition > 1
        ? dashboardNow.queuePosition - 1
        : undefined,
    stepsReportedWhenFinished: dashboardNow?.stepsReportedLive === false,
    liveStep: nowStepFromDashboard(dashboardNow?.status === 'running' ? dashboardNow.step : null),
  });
  const emphasis = planEmphasis({
    needsYou: scoped.length > 0,
    nowWaiting: nowModel.kind === 'waiting-for-you',
    decisionIds: openDecisionIds(feedItems),
  });
  const emphasized = new Set(emphasis.decisions);
  const alignment = buildAlignment({
    profileId,
    now: clock,
    taskInputs: dashboard?.taskInputs,
    items: feedItems.map((item) => ({
      id: item.id,
      type: item.type,
      createdAt: item.createdAt,
      turnId: item.turnId,
      text: item.type === 'user-message' ? item.text : undefined,
      steps: item.type === 'plan' ? item.steps : undefined,
    })),
    turn: latestTurn ?? null,
    awaitingDecision: scoped.length > 0,
  });
  const decisionId = sheets?.decisionId ?? (phone ? localDecision : null);
  function openSheet(
    kind: 'decision' | 'steps' | 'inspect',
    id: string,
    mode?: 'push' | 'replace'
  ) {
    if (sheets) {
      sheets.open(kind, id, mode);
      return;
    }
    setLocalDecision(kind === 'decision' ? id : null);
    setLocalSteps(kind === 'steps' ? id : null);
    setLocalInspect(kind === 'inspect' ? id : null);
  }
  function closeSheet() {
    setSheetExpanded(false);
    if (sheets) {
      sheets.close();
      return;
    }
    setLocalDecision(null);
    setLocalSteps(null);
    setLocalInspect(null);
  }
  const decisionItems = feedItems.filter(
    (item): item is Extract<ThreadItem, { type: 'approval-request' | 'user-input-request' }> =>
      item.type === 'approval-request' || item.type === 'user-input-request'
  );
  const decisionWalk = attentionWalk(scoped, decisionItems);
  const openDecisionItemIds = openDecisionIds(decisionItems);
  const openEntry =
    decisionId == null
      ? null
      : (decisionWalk.find(
          (entry) =>
            entry.key === decisionId || entry.itemId === decisionId || entry.rowId === decisionId
        ) ?? null);
  const openRow = openEntry ? scoped.find((row) => row.id === openEntry.rowId) : undefined;
  const openItem =
    openEntry?.item ??
    (decisionId == null
      ? null
      : (decisionItems.find(
          (item) => item.id === decisionId && openDecisionItemIds.includes(item.id)
        ) ?? null));
  const remainingDecisions = openDecisionsAfter(
    decisionWalk,
    openEntry?.key ?? decisionId,
    openDecisionItemIds
  );
  const decisionsAfter = remainingDecisions.count;
  const nextWalk = remainingDecisions.nextKey
    ? decisionWalk.find((entry) => entry.key === remainingDecisions.nextKey)
    : undefined;
  const barTarget = barDecisionTarget(decisionWalk, openDecisionItemIds);
  const chrome = narrativeOnly ? null : (
    <div className="sticky top-0 z-10 flex min-w-0 flex-col gap-2 bg-layer-1 py-2">
      {phone ? (
        <>
          {alignment?.objective ? <p className="ok-prose truncate">{alignment.objective}</p> : null}
          {alignment?.progress ? (
            <p className="ok-meta truncate">{shortenProgress(alignment.progress)}</p>
          ) : null}
          <PhoneBar
            now={nowModel}
            needsCount={decisionWalk.length}
            reducedMotion={reducedMotion}
            onOpen={
              barTarget
                ? () => {
                    openSheet('decision', barTarget);
                  }
                : undefined
            }
          />
        </>
      ) : (
        <>
          <AlignmentHeader model={alignment} />
          <NowLine model={nowModel} emphasize={emphasis.now} reducedMotion={reducedMotion} />
          <NeedsYouBar
            rows={scoped}
            threadId={threadId}
            emphasize={emphasis.bar}
            reducedMotion={reducedMotion}
            now={clock}
            onOpen={onOpen}
          />
        </>
      )}
    </div>
  );
  const inlineLens: LensName = phone ? 'work' : lens;

  if (groups.length === 0 && !live.isError) {
    if (unavailableTurn)
      return <p className="text-sm text-fg-muted">{timelineCopy.runUnavailable}</p>;
    return (
      <TimelineNowProvider now={clock}>
        {chrome}
        <div className="ok-timeline flex flex-col gap-5" data-timeline-lens={lens}>
          {lensProp === undefined ? (
            <fieldset
              aria-label={timelineCopy.lensName}
              className="m-0 flex min-w-0 gap-2 border-0 p-0"
            >
              <Button
                variant={lens === 'work' ? 'outline' : 'quiet'}
                size="sm"
                aria-label={timelineCopy.lensWorkName}
                aria-pressed={lens === 'work'}
                onPress={() => {
                  setInternalLens('work');
                  writeStoredLens('work');
                }}
              >
                {timelineCopy.lensWork}
              </Button>
              <Button
                variant={lens === 'full' ? 'outline' : 'quiet'}
                size="sm"
                aria-label={timelineCopy.lensFullName}
                aria-pressed={lens === 'full'}
                onPress={() => {
                  setInternalLens('full');
                  writeStoredLens('full');
                  if (phone && latestTurnId) openSheet('steps', latestTurnId);
                }}
              >
                {timelineCopy.lensFull}
              </Button>
            </fieldset>
          ) : null}
          <EmptyState
            icon="chat"
            title={
              narrativeOnly
                ? (emptyTitle ?? timelineCopy.emptyGoalTitle)
                : mode === 'task'
                  ? timelineCopy.emptyTaskTitle
                  : mode === 'chat'
                    ? timelineCopy.emptyChatTitle
                    : (emptyTitle ?? timelineCopy.emptyChatTitle)
            }
            hint={
              narrativeOnly
                ? timelineCopy.emptyGoalHint
                : mode === 'task'
                  ? timelineCopy.emptyTaskHint
                  : timelineCopy.emptyChatHint
            }
          />
        </div>
      </TimelineNowProvider>
    );
  }

  /** Explains why this request cannot currently be answered; the server remains the command authority. */
  function approvalUnavailableReason(item: ThreadItem): string | undefined {
    if (item.type !== 'approval-request') return undefined;
    if (controlsReadOnly) return 'Reconnect to respond to this approval.';
    if (live.isError)
      return 'Approval status could not be loaded. Reload this conversation to try again.';
    if (!dashboard) return 'Checking approval status…';
    const state = dashboard.pendingRequests?.find(
      (record) => record.requestId === item.approvalRequestId
    );
    if (!state) return 'Request status is unavailable. Reload this conversation to check again.';
    if (state.state !== 'pending')
      return state.state === 'inspect-only'
        ? 'This request requires inspection.'
        : `This request is ${state.state}.`;
    if (state.canRespond !== true) return 'Approval actions are unavailable for this viewer.';
    return undefined;
  }

  function authorFor(item: ThreadItem): string | undefined {
    const recorded =
      'actor' in item
        ? participantNames.get(`${item.actor.kind}:${item.actor.id}`)
        : turnAuthors.get(item.turnId);
    if (item.type === 'user-message') {
      const self = item.actor.kind === 'user' && item.actor.id === dashboard?.viewerUserId;
      const kind = self
        ? 'self'
        : item.actor.kind === 'automation'
          ? 'automation'
          : item.actor.kind === 'user'
            ? 'person'
            : 'agent';
      return plainActorName(recorded, kind);
    }
    if (item.type === 'assistant-message') return plainActorName(recorded, 'agent');
    return recorded ? plainActorName(recorded, 'worker') : undefined;
  }

  function renderTimelineItem(item: ThreadItem): ReactNode {
    if (groupedSourceIds.has(item.id)) return null;
    if (item.type === 'generative-ui-reference') {
      return (
        <GenerativePresentationView key={item.id} item={item} source={sourceGroups.get(item.id)} />
      );
    }
    if (
      item.type === 'user-input-request' &&
      feedItems.some(
        (candidate) =>
          candidate.type === 'user-input-response' &&
          candidate.userInputRequestId === item.userInputRequestId
      )
    ) {
      return null;
    }
    const matchedObjective =
      item.type === 'user-message'
        ? dashboard?.taskInputs?.find((entry) => entry.itemId === item.id)?.objective
        : undefined;
    const parsedObjective =
      item.type === 'user-message' &&
      !matchedObjective &&
      (dashboard?.taskInputs?.length ?? 0) === 0
        ? taskSpecObjective(item.text)
        : null;
    return (
      <ItemView
        item={item}
        viewerUserId={dashboard?.viewerUserId}
        authorName={authorFor(item)}
        requestObjective={matchedObjective ?? parsedObjective ?? undefined}
        readOnly={
          controlsReadOnly ||
          (item.type === 'user-input-request' &&
            (live.isError ||
              dashboard?.pendingRequests?.find(
                (record) => record.requestId === item.userInputRequestId
              )?.state !== 'pending'))
        }
        resolvedApproval={
          item.type === 'approval-request'
            ? feedItems.find(
                (
                  candidate
                ): candidate is Extract<typeof candidate, { type: 'approval-decision' }> =>
                  candidate.type === 'approval-decision' &&
                  candidate.approvalRequestId === item.approvalRequestId
              )
            : undefined
        }
        approvalRequestTitle={
          item.type === 'approval-decision'
            ? feedItems.find(
                (candidate): candidate is Extract<ThreadItem, { type: 'approval-request' }> =>
                  candidate.type === 'approval-request' &&
                  candidate.approvalRequestId === item.approvalRequestId
              )?.title
            : undefined
        }
        approvalEffect={
          item.type === 'approval-request'
            ? dashboard?.pendingRequests?.find((row) => row.requestId === item.approvalRequestId)
                ?.approvalEffect
            : undefined
        }
        onWithdrawApproval={(pendingRequestId) =>
          withdraw.mutate({ pendingRequestId, requestId: createRequestId() })
        }
        approvalUnavailableReason={approvalUnavailableReason(item)}
        pendingDecision={
          item.type !== 'approval-request'
            ? undefined
            : withdraw.isPending && withdraw.variables?.pendingRequestId === item.approvalRequestId
              ? 'withdraw'
              : respond.isPending && respond.variables?.approvalRequestId === item.approvalRequestId
                ? respond.variables.decision
                : undefined
        }
        holdReason={holdReason}
        approvalPending={
          item.type === 'approval-request' &&
          ((respond.isPending && respond.variables?.approvalRequestId === item.approvalRequestId) ||
            (withdraw.isPending && withdraw.variables?.pendingRequestId === item.approvalRequestId))
        }
        approvalError={
          item.type === 'approval-request' &&
          ((respond.isError && respond.variables?.approvalRequestId === item.approvalRequestId) ||
            (withdraw.isError && withdraw.variables?.pendingRequestId === item.approvalRequestId))
        }
        onRetryApproval={() => {
          if (withdraw.isError && withdraw.variables) withdraw.mutate(withdraw.variables);
          else if (respond.variables) respond.mutate(respond.variables);
        }}
        onApprovalDecision={(approvalRequestId, turnId, decision) =>
          respond.mutate({
            approvalRequestId,
            turnId,
            decision,
            requestId: createRequestId(),
          })
        }
        onSubmitAnswers={(userInputRequestId, answers) =>
          submitAnswers.mutate({
            userInputRequestId,
            answers,
            requestId: createRequestId(),
          })
        }
        answerPending={
          submitAnswers.isPending &&
          item.type === 'user-input-request' &&
          submitAnswers.variables?.userInputRequestId === item.userInputRequestId
        }
        answerError={
          submitAnswers.isError &&
          item.type === 'user-input-request' &&
          submitAnswers.variables?.userInputRequestId === item.userInputRequestId
        }
        onRetryAnswers={() => {
          if (submitAnswers.variables) submitAnswers.mutate(submitAnswers.variables);
        }}
        emphasizePrimary={emphasized.has(item.id)}
      />
    );
  }

  function closeInspector() {
    if (phone) {
      closeSheet();
      inspectButtonRef.current?.focus();
      return;
    }
    setInspectedTurnId(null);
    inspectButtonRef.current?.focus();
  }

  const activeInspectId = phone ? phoneInspectId : inspectedTurnId;
  const inspectedItems = feedItems.filter((item) => item.turnId === activeInspectId);
  const inspectedActivity = activeInspectId ? activityByTurn.get(activeInspectId) : undefined;
  const inspectedTurn = dashboard?.turns.find((turn) => turn.id === activeInspectId);
  const inspector = activeInspectId ? (
    <Inspector
      turnId={activeInspectId}
      items={inspectedItems}
      activity={inspectedActivity}
      interrupted={inspectedTurn?.status === 'interrupted'}
      onClose={closeInspector}
      panelRef={panelRef}
      sheet={phone}
      expanded={sheetExpanded}
      onExpand={() => setSheetExpanded((open) => !open)}
    />
  ) : null;
  const stepSource =
    timelineOn && stepsTurnId && level2TurnId === stepsTurnId && level2.completeItems.length > 0
      ? level2.completeItems
      : feedItems;
  const stepItems = stepSource.filter((item) => item.turnId === stepsTurnId && isStepItem(item));
  const catchUp = timelineOn ? (timelineWindow.data?.catchUpAnchor ?? null) : null;
  const catchUpRefs: CatchUpItemRef[] = windowRuns
    ? windowRuns.flatMap((run) =>
        run.narrative.map((item, index) => ({
          id: item.id,
          turnId: run.id,
          index,
          type: item.type,
        }))
      )
    : [];
  const runOrder = new Map((windowRuns ?? []).map((run) => [run.id, run.admissionOrder]));
  const hasUnreadAnswer = catchUpRefs.some(
    (item) => item.type === 'assistant-message' && unreadIds.has(item.id)
  );
  const dividerShown = showCatchUpDivider({
    profile: profileId,
    catchUp,
    hasUnreadAnswer,
  });
  const placement = dividerShown
    ? dividerPlacement({
        runs: windowRuns ?? [],
        items: catchUpRefs,
        catchUp,
      })
    : null;
  const earlier = earlierUnread({
    items: catchUpRefs,
    unreadIds,
    catchUp: dividerShown ? catchUp : null,
    runOrder,
  });
  const catchUpOrder = catchUp ? (runOrder.get(catchUp.turnId) ?? null) : null;
  function jumpToEarlierUnread() {
    const itemId = earlier.oldestId;
    if (!itemId) return;
    if (onJumpToItem) onJumpToItem(itemId);
    else setAnchorOverride({ kind: 'item', itemId });
  }

  return (
    <TimelineNowProvider now={clock}>
      {chrome}
      <ThreadReadReceipts
        key={`${workspaceId}:${threadId}:${dashboard?.viewerUserId ?? ''}`}
        workspaceId={workspaceId}
        threadId={threadId}
        viewerUserId={dashboard?.viewerUserId}
        items={feedItems}
        disabled={controlsReadOnly || live.isError}
      >
        <div className="ok-timeline flex flex-col gap-5" data-timeline-lens={lens}>
          {fresh ? (
            <p role="status" className="ok-meta">
              {fresh}
            </p>
          ) : null}
          {lensProp === undefined ? (
            <fieldset
              aria-label={timelineCopy.lensName}
              className="m-0 flex min-w-0 gap-2 border-0 p-0"
            >
              <Button
                variant={lens === 'work' ? 'outline' : 'quiet'}
                size="sm"
                aria-label={timelineCopy.lensWorkName}
                aria-pressed={lens === 'work'}
                onPress={() => {
                  setInternalLens('work');
                  writeStoredLens('work');
                }}
              >
                {timelineCopy.lensWork}
              </Button>
              <Button
                variant={lens === 'full' ? 'outline' : 'quiet'}
                size="sm"
                aria-label={timelineCopy.lensFullName}
                aria-pressed={lens === 'full'}
                onPress={() => {
                  setInternalLens('full');
                  writeStoredLens('full');
                  if (phone && latestTurnId) openSheet('steps', latestTurnId);
                }}
              >
                {timelineCopy.lensFull}
              </Button>
            </fieldset>
          ) : null}
          {!windowRuns && earlierCursor ? (
            <Button
              variant="quiet"
              size="sm"
              isDisabled={loadEarlier.isPending}
              onPress={() => loadEarlier.mutate(earlierCursor)}
            >
              Load earlier
            </Button>
          ) : null}
          {unavailableTurn ? (
            <p className="text-sm text-fg-muted">{timelineCopy.runUnavailable}</p>
          ) : null}
          {live.isError ? (
            <ErrorBanner
              message="Runtime activity is unavailable. Retry to refresh."
              onRetry={() => void live.refetch()}
            />
          ) : null}
          <TimelineFrame
            windowed={Boolean(windowRuns)}
            topEntryId={windowRuns?.[0]?.id ?? null}
            initiallyFollowing={
              windowAnchor.kind === 'latest' && restoredNavigation.current == null
            }
            restoreTop={restoredNavigation.current?.scrollTop ?? null}
            canEarlier={Boolean(timelineWindow.data?.beforeCursor)}
            canLater={Boolean(timelineWindow.data?.afterCursor)}
            paging={timelineWindow.paging}
            onEarlier={timelineWindow.pageEarlier}
            onLater={timelineWindow.pageLater}
            showJump={showJumpToLatest(windowAnchor, timelineWindow.data?.afterCursor ?? null)}
            onJump={() => {
              localJumped.current = true;
              setLocalSettled({ kind: 'latest' });
              setAnchorOverride({ kind: 'latest' });
              setFollowNew({ count: 0, decision: false });
              following.current = true;
              setFollowRequest((current) => current + 1);
              onJumpToLatest?.();
            }}
            newCount={followNew.count}
            decisionNew={followNew.decision}
            updatesHost={updatesHost ?? null}
            onFollowChange={(next) => {
              following.current = next;
              if (next) setFollowNew({ count: 0, decision: false });
            }}
            onCatchUp={() => {
              localJumped.current = true;
              setLocalSettled({ kind: 'latest' });
              setAnchorOverride({ kind: 'latest' });
              setFollowNew({ count: 0, decision: false });
              following.current = true;
              setFollowRequest((current) => current + 1);
              onJumpToLatest?.();
            }}
            followRequest={followRequest}
            pinDivider={windowAnchor.kind === 'catch-up' && restoredNavigation.current == null}
            pinKey={scopeKey}
          >
            {groups.map((group, index) => {
              const groupTurn = dashboard?.turns.find((turn) => turn.id === group.turnId);
              const isLastGroup =
                groups.findLastIndex((candidate) => candidate.turnId === group.turnId) === index;
              const activity =
                groupTurn && isLastGroup ? activityByTurn.get(group.turnId) : undefined;
              const projected = entryByTurn.get(group.turnId);
              const historicalFailure =
                groupTurn?.status === 'failed' && groupTurn.id !== latestTurnId && isLastGroup
                  ? (projected?.outcome?.text ?? timelineCopy.runFailed)
                  : null;
              const runningStep =
                groupTurn?.status === 'running' ? latestRunningStep(group.items) : undefined;
              const namedAgent = groupTurn?.agentId
                ? participantNames.get(`agent:${groupTurn.agentId}`)
                : undefined;
              const actorName = plainActorName(namedAgent, 'worker');
              const runLens =
                !phone && (lens === 'full' || expandedTurnId === group.turnId) ? 'full' : 'work';
              const firstViewerMessage = group.items.find(
                (item) =>
                  item.type === 'user-message' &&
                  item.actor.kind === 'user' &&
                  item.actor.id === dashboard?.viewerUserId
              );
              const entry =
                projected ??
                ({
                  turnId: group.turnId,
                  header: null,
                  narrative: [],
                  notes: [],
                  plan: null,
                  stats: { stepCount: 0, fileCount: 0, failedCommandCount: 0, failedStepCount: 0 },
                  long: false,
                  stepWindow: [],
                  outcome: null,
                } as const);
              const timelineRun = windowRuns?.find((run) => run.id === group.turnId);
              const staysNew = runStaysNew({
                status: timelineRun?.status ?? groupTurn?.status ?? '',
                messages:
                  timelineRun?.statistics.messages ??
                  group.items.filter(
                    (item) => item.type === 'user-message' || item.type === 'assistant-message'
                  ).length,
                admissionOrder: timelineRun?.admissionOrder ?? -1,
                catchUpOrder,
              });

              return (
                <div
                  key={group.turnId}
                  data-timeline-entry={group.turnId}
                  data-run-status={timelineRun?.status ?? groupTurn?.status}
                  className="flex flex-col gap-4"
                  ref={
                    selectedTurn?.id === group.turnId &&
                    groups.findIndex((candidate) => candidate.turnId === group.turnId) === index
                      ? focusedElement
                      : undefined
                  }
                >
                  {selectedTurn?.id === group.turnId &&
                  groups.findIndex((candidate) => candidate.turnId === group.turnId) === index ? (
                    <p className="text-sm text-fg-muted">{selectedRunLabel(selectedTurn.status)}</p>
                  ) : null}
                  {index > 0 ? (
                    <TurnSeparator
                      label={runSeparatorCopy(timelineRun?.admissionOrder ?? index + 1)}
                    />
                  ) : null}
                  {staysNew ? (
                    <p data-still-new="true" data-voice="fact" className="ok-voice-fact ok-meta">
                      {timelineCopy.stillNew}
                    </p>
                  ) : null}
                  {placement?.turnId === group.turnId && placement.afterItemId === null ? (
                    <CatchUpDivider count={earlier.count} onEarlierUnread={jumpToEarlierUnread} />
                  ) : null}
                  <RunEntry
                    entry={entry}
                    items={group.items}
                    turn={groupTurn}
                    lens={inlineLens}
                    expanded={phone ? false : expandedTurnId === group.turnId}
                    stepsInSheet={phone}
                    stepsSheetOpen={stepsTurnId === group.turnId}
                    onStepsToggle={(open) => rememberExpanded(open ? group.turnId : null)}
                    onOpenSteps={() => openSheet('steps', group.turnId)}
                    onOpenAllSteps={() => openSheet('steps', group.turnId)}
                    actorName={actorName}
                    omitTrigger={Boolean(firstViewerMessage)}
                    durationMs={runDurationMs(groupTurn, Date.now())}
                    hiddenIds={groupedSourceIds}
                    renderItem={(item) => {
                      const node = renderTimelineItem(item);
                      if (node == null) return node;
                      const unread =
                        (item.type === 'assistant-message' || item.type === 'user-message') &&
                        keepsUnreadMark(item.id, unreadIds);
                      return (
                        <>
                          {unread ? (
                            <p data-unread="true" data-voice="fact" className="ok-meta">
                              {timelineCopy.unreadMark}
                            </p>
                          ) : null}
                          {node}
                          {placement?.afterItemId === item.id ? (
                            <CatchUpDivider
                              count={earlier.count}
                              onEarlierUnread={jumpToEarlierUnread}
                            />
                          ) : null}
                        </>
                      );
                    }}
                    inspectRef={activeInspectId === group.turnId ? inspectButtonRef : undefined}
                    inspected={activeInspectId === group.turnId}
                    onInspect={() => {
                      if (phone) {
                        openSheet('inspect', group.turnId);
                        return;
                      }
                      setInspectedTurnId((current) =>
                        current === group.turnId ? null : group.turnId
                      );
                    }}
                    runningStatus={
                      runningStep && groupTurn ? (
                        <div role="status" className="ok-meta text-fg">
                          <Button
                            variant="quiet"
                            size="sm"
                            onPress={() => {
                              if (phone) openSheet('steps', group.turnId);
                              else rememberExpanded(group.turnId);
                            }}
                          >
                            <span>{actorName}</span>
                            <span aria-hidden="true"> · </span>
                            <span>running</span>
                            <span aria-hidden="true"> · </span>
                            <time
                              dateTime={durationDateTime(
                                elapsedSeconds(groupTurn.startedAt ?? '') * 1000
                              )}
                            >
                              {elapsedSeconds(groupTurn.startedAt ?? '')} seconds
                            </time>
                            <span aria-hidden="true"> · </span>
                            <span>{runningStep.tool}</span>
                          </Button>
                        </div>
                      ) : null
                    }
                    workerCue={
                      Boolean(activity && activity.entries.length > 0) && runLens === 'work'
                    }
                    previews={narrativePreviews(timelineRun?.narrative ?? []).map((preview) =>
                      fullText[preview.id]
                        ? {
                            ...preview,
                            text: fullText[preview.id] ?? preview.text,
                            truncated: false,
                          }
                        : preview
                    )}
                    onShowFullText={(preview) => {
                      if (!workspaceId || fullText[preview.id]) return;
                      void client.operations['thread.item-body']({
                        workspaceId,
                        threadId,
                        turnId: group.turnId,
                        itemId: preview.id,
                      }).then((body) => {
                        setFullText((current) => ({
                          ...current,
                          [preview.id]: itemBodyText(body.item),
                        }));
                      });
                    }}
                    showActivity={Boolean(activity) && runLens === 'full'}
                    activityLine={
                      activity ? (
                        <section
                          aria-label="Runtime activity"
                          aria-live="polite"
                          className="rounded-ok border border-border bg-sunken p-4 text-sm"
                        >
                          <h3 className="font-semibold text-fg">Runtime activity</h3>
                          {activity.entries.length > 0 ? (
                            <p className="mt-1 text-fg-muted">{timelineCopy.reportedByWorker}</p>
                          ) : null}
                          <p className="mt-1 text-fg-muted">{coverageCopy(activity.coverage)}</p>
                          <p className="mt-1 text-fg-muted">
                            {captureCopy(activity.contentCapture)}
                          </p>
                          {activity.omittedEntryCount > 0 ? (
                            <p className="mt-1 text-fg-muted">
                              {omittedActivityCopy(activity.omittedEntryCount)}
                            </p>
                          ) : null}
                          {activity.entries.length > 0 ? (
                            <ol className="mt-3 flex flex-col gap-3">
                              {activity.entries.map((report) => (
                                <li key={report.sequence}>
                                  <div className="flex flex-wrap items-baseline gap-2">
                                    <span className="font-medium text-fg">
                                      {report.label ??
                                        {
                                          'child-started': timelineCopy.childStarted,
                                          progress: timelineCopy.reportedProgress,
                                          result: timelineCopy.reportedResult,
                                          failure: timelineCopy.reportedFailure,
                                        }[report.kind]}
                                    </span>
                                    <TimelineTime iso={report.observedAt} now={clock} />
                                  </div>
                                  {report.text !== undefined ? (
                                    <p className="mt-1 whitespace-pre-wrap break-words text-fg">
                                      {report.text}
                                    </p>
                                  ) : null}
                                  {report.textTruncated ? (
                                    <p className="mt-1 text-xs text-fg-muted">
                                      {timelineCopy.textShortened}
                                    </p>
                                  ) : null}
                                </li>
                              ))}
                            </ol>
                          ) : null}
                        </section>
                      ) : null
                    }
                  />
                  {groupTurn?.status === 'failed' ? (
                    <p className="ok-meta">{classifyRunError(groupTurn.error?.code).text}</p>
                  ) : null}
                  {historicalFailure ? <ErrorBanner message={historicalFailure} /> : null}
                  {windowRuns?.find((run) => run.id === group.turnId)?.restrictedReferences ||
                  windowRuns?.find((run) => run.id === group.turnId)?.interruptedBy.visibility ===
                    'restricted' ? (
                    <p className="ok-meta">{timelineCopy.restricted}</p>
                  ) : null}
                  {!stepsTurnId &&
                  level2TurnId === group.turnId &&
                  (expandedTurnId === group.turnId || lens === 'full') ? (
                    <div className="flex gap-2">
                      {level2.data?.beforeCursor ? (
                        <Button
                          variant="quiet"
                          size="sm"
                          onPress={level2.pageEarlier}
                          isDisabled={level2.paging}
                        >
                          {timelineCopy.loadEarlier}
                        </Button>
                      ) : null}
                      {level2.data?.afterCursor ? (
                        <Button
                          variant="quiet"
                          size="sm"
                          onPress={level2.pageLater}
                          isDisabled={level2.paging}
                        >
                          {timelineCopy.loadLater}
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </TimelineFrame>
        </div>
      </ThreadReadReceipts>
      {inspector && !phone ? (portalNode ? createPortal(inspector, portalNode) : inspector) : null}
      {phone && inspector}
      {openItem ? (
        <DecisionSheet
          item={openItem}
          actor={plainActorName(authorFor(openItem), 'worker')}
          blocking={openRow?.blocking ?? false}
          effectText={
            openItem.type === 'approval-request'
              ? approvalEffectText(
                  dashboard?.pendingRequests?.find(
                    (row) => row.requestId === openItem.approvalRequestId
                  )?.approvalEffect
                )
              : null
          }
          pending={
            openItem.type === 'approval-request'
              ? respond.isPending &&
                respond.variables?.approvalRequestId === openItem.approvalRequestId
              : submitAnswers.isPending &&
                openItem.type === 'user-input-request' &&
                submitAnswers.variables?.userInputRequestId === openItem.userInputRequestId
          }
          holdReason={holdReason}
          more={decisionsAfter}
          onApprove={
            openItem.type === 'approval-request'
              ? () =>
                  respond.mutate({
                    approvalRequestId: openItem.approvalRequestId,
                    turnId: openItem.turnId,
                    decision: 'granted',
                    requestId: createRequestId(),
                  })
              : undefined
          }
          onDeny={
            openItem.type === 'approval-request'
              ? () =>
                  respond.mutate({
                    approvalRequestId: openItem.approvalRequestId,
                    turnId: openItem.turnId,
                    decision: 'denied',
                    requestId: createRequestId(),
                  })
              : undefined
          }
          onSubmitAnswers={(userInputRequestId, answers) =>
            submitAnswers.mutate({ userInputRequestId, answers, requestId: createRequestId() })
          }
          onNext={
            decisionsAfter > 0 && nextWalk
              ? () => openSheet('decision', nextWalk.key, 'replace')
              : undefined
          }
          onClose={closeSheet}
        />
      ) : openEntry && openRow ? (
        <DecisionRowSheet
          title={openRow.title}
          createdAt={openRow.createdAt}
          blocking={openRow.blocking}
          more={decisionsAfter}
          onNext={
            decisionsAfter > 0 && nextWalk
              ? () => openSheet('decision', nextWalk.key, 'replace')
              : undefined
          }
          onClose={closeSheet}
        />
      ) : null}
      {stepsTurnId ? (
        <PhoneSheetFrame
          label={timelineCopy.stepsSheet}
          mode="partial"
          expanded={sheetExpanded}
          onExpand={() => setSheetExpanded((open) => !open)}
          onClose={closeSheet}
        >
          <ul className="flex flex-col gap-2">
            {level2.data?.beforeCursor ? (
              <li>
                <Button
                  variant="quiet"
                  size="sm"
                  onPress={level2.pageEarlier}
                  isDisabled={level2.paging}
                >
                  {timelineCopy.loadEarlier}
                </Button>
              </li>
            ) : null}
            {stepItems.map((item) => (
              <li key={item.id} id={`timeline-item-${item.id}`} tabIndex={-1} className="ok-step">
                {renderTimelineItem(item)}
              </li>
            ))}
            {level2.data?.afterCursor ? (
              <li>
                <Button
                  variant="quiet"
                  size="sm"
                  onPress={level2.pageLater}
                  isDisabled={level2.paging}
                >
                  {timelineCopy.loadLater}
                </Button>
              </li>
            ) : null}
          </ul>
        </PhoneSheetFrame>
      ) : null}
    </TimelineNowProvider>
  );
}

function TimelineFrame({
  windowed,
  children,
  ...props
}: { windowed: boolean; children: ReactNode } & ComponentProps<typeof TimelineScroll>) {
  if (!windowed) return children;
  return <TimelineScroll {...props}>{children}</TimelineScroll>;
}

function approvalEffectText(
  effect: { status?: string; summary?: string | null; detail?: string | null } | null | undefined
): string | null {
  if (!effect || effect.status !== 'available') return null;
  const text = [effect.summary, effect.detail]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .join('\n');
  return text.length > 0 ? text : null;
}
