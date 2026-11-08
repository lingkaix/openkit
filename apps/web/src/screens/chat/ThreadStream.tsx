import { createRequestId } from '@openkit/core-client';
import { useQueryClient } from '@tanstack/react-query';
import { type ReactNode, type RefObject, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useConnection } from '../../app/core-client';
import { useGenerativeSourceGroups } from '../../generative/source-groups';
import { Button, EmptyState, ErrorBanner, Skeleton, TurnSeparator } from '../../primitives';
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
import { ThreadReadReceipts } from './ThreadReadReceipts';
import { AlignmentHeader } from './timeline/AlignmentHeader';
import { selectedRunLabel, timelineCopy } from './timeline/copy';
import { openDecisionIds, planEmphasis } from './timeline/emphasis';
import { buildAlignment } from './timeline/header';
import { Inspector } from './timeline/Inspector';
import { readStoredLens, writeStoredLens } from './timeline/lens-store';
import { NeedsYouBar, useTimelineAttention } from './timeline/NeedsYouBar';
import { NowLine } from './timeline/NowLine';
import {
  focusTimelineItem,
  orderNeedsYou,
  scopeNeedsYou,
  toNeedsYouRow,
} from './timeline/needs-you';
import { nowFromThread } from './timeline/now';
import { plainActorName, runDurationMs, taskSpecObjective } from './timeline/present';
import { selectAgentProfile } from './timeline/profiles';
import { RunEntry } from './timeline/RunEntry';
import {
  captureCopy,
  coverageCopy,
  omittedActivityCopy,
  projectTimeline,
  runSeparatorCopy,
} from './timeline/source';
import { TimelineTime } from './timeline/TimelineTime';
import {
  durationDateTime,
  NOW_ELAPSED_CLOCK_MS,
  TIMELINE_CLOCK_MS,
  TimelineNowProvider,
  useReducedMotion,
} from './timeline/time';
import type { LensName } from './timeline/types';

/** Seconds since a running Turn started. Zero when the timestamp cannot be read. */
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
  /** Chat or task framing. Task adds the alignment header. */
  mode?: 'chat' | 'task';
  /** Stop was pressed and the run has not reached a final state. */
  stopPending?: boolean;
  /** Item anchor from a Needs you jump. */
  focusItemId?: string | null;
  /** Open a row's owning surface. Same-thread anchors scroll instead. */
  onOpen?: (href: string) => void;
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
  onOpen,
}: ThreadStreamProps) {
  const [internalLens, setInternalLens] = useState<LensName>(readStoredLens);
  const lens = lensProp ?? internalLens;
  const [expandedTurnId, setExpandedTurnId] = useState<string | null>(null);
  const [inspectedTurnId, setInspectedTurnId] = useState<string | null>(null);
  const inspectButtonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const [portalNode, setPortalNode] = useState<HTMLElement | null>(null);
  const connection = useConnection();
  const queryClient = useQueryClient();
  const items = useThreadItems(workspaceId, threadId);
  const cursor = useThreadItemCursor(workspaceId, threadId);
  const loadEarlier = useLoadEarlierItems(workspaceId, threadId);
  const earlierCursor =
    typeof cursor.data === 'string' && cursor.data.length > 0 ? cursor.data : null;
  const decisionScope = useRef<string | null>(null);
  const knownDecisionIds = useRef<Set<string>>(new Set());
  const decisionIds = (items.data ?? [])
    .filter((item) => item.type === 'approval-request' || item.type === 'user-input-request')
    .map((item) => item.id)
    .join('\n');
  useEffect(() => {
    if (!workspaceId || !items.isSuccess) return;
    const ids = decisionIds.length === 0 ? [] : decisionIds.split('\n');
    const scope = `${workspaceId}:${threadId}`;
    if (decisionScope.current !== scope) {
      decisionScope.current = scope;
      knownDecisionIds.current = new Set(ids);
      return;
    }
    const arrived = ids.some((id) => !knownDecisionIds.current.has(id));
    knownDecisionIds.current = new Set(ids);
    if (arrived) void queryClient.invalidateQueries({ queryKey: ['attention', workspaceId] });
  }, [decisionIds, items.isSuccess, queryClient, threadId, workspaceId]);
  const baselineCandidate =
    items.isSuccess && (items.fetchStatus === 'idle' || items.isFetchedAfterMount);
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
  const sourceGroups = useGenerativeSourceGroups(items.data);
  const groupedSourceIds = new Set([...sourceGroups.values()].map((item) => item.id));
  const live = useLiveThreadItems(workspaceId, threadId, items.isSuccess, baselineReady);
  const dashboard = live.data;
  const attention = useTimelineAttention(workspaceId);
  const reducedMotion = useReducedMotion();
  const liveElapsed = Boolean(
    dashboard?.turns.some((turn) => turn.status === 'running' || turn.status === 'pending')
  );
  const [clock, setClock] = useState(() => Date.now());
  const itemLocated = useRef<string | null>(null);
  useEffect(() => {
    const timer = setInterval(
      () => setClock(Date.now()),
      liveElapsed ? NOW_ELAPSED_CLOCK_MS : TIMELINE_CLOCK_MS
    );
    return () => clearInterval(timer);
  }, [liveElapsed]);
  useEffect(() => {
    if (!focusItemId || items.isLoading || !items.data) return;
    if (itemLocated.current === focusItemId) return;
    if (focusTimelineItem(focusItemId)) itemLocated.current = focusItemId;
  }, [focusItemId, items.data, items.isLoading]);
  const respond = useRespondApproval(workspaceId ?? '', threadId);
  const submitAnswers = useSubmitTurnAnswers(workspaceId ?? '', threadId);
  const withdraw = useWithdrawPendingRequest(workspaceId ?? '', threadId);
  const controlsReadOnly = Boolean(readOnly || !workspaceId || !connection.connected);
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
    if (!selectedTurn || items.isLoading || items.isError || !focusedElement.current) {
      if (located.current !== focusKey) located.current = null;
      return;
    }
    if (located.current === focusKey) return;
    focusedElement.current.scrollIntoView({ block: 'center' });
    located.current = focusKey;
  }, [focusKey, selectedTurn, items.isLoading, items.isError]);
  const unavailableTurn = Boolean(focusTurnId && focusedDashboard && !selectedTurn);
  useEffect(() => {
    setPortalNode(inspectedTurnId ? (panelHost?.current ?? null) : null);
  }, [inspectedTurnId, panelHost]);
  useEffect(() => {
    if (!inspectedTurnId) return;
    if (panelHost && !portalNode) return;
    panelRef.current?.focus();
  }, [inspectedTurnId, panelHost, portalNode]);

  if (items.isLoading) {
    return (
      <div className="flex flex-col gap-5" aria-busy="true">
        <Skeleton lines={2} />
        <Skeleton lines={3} />
      </div>
    );
  }

  if (items.isError) {
    return (
      <ErrorBanner message="Couldn't load this thread." onRetry={() => void items.refetch()} />
    );
  }

  const latestTurnId = dashboard?.turns.at(-1)?.id;
  const activityByTurn = new Map(
    live.isError ? [] : dashboard?.runtimeActivity?.map((activity) => [activity.turnId, activity])
  );
  const timeline = projectTimeline({
    items: items.data ?? [],
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
    toNeedsYouRow(row, openHrefForRow(row))
  );
  const latestTurn = dashboard?.turns.at(-1);
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
    items: items.data ?? [],
    blockingCount: scoped.filter((row) => row.blocking).length,
    lastKnown: latestTurn && lastKnownAt ? { status: latestTurn.status, at: lastKnownAt } : null,
  });
  const emphasis = planEmphasis({
    needsYou: scoped.length > 0,
    nowWaiting: nowModel.kind === 'waiting-for-you',
    decisionIds: openDecisionIds(items.data ?? []),
  });
  const emphasized = new Set(emphasis.decisions);
  const alignment = buildAlignment({
    profileId,
    now: clock,
    taskInputs: dashboard?.taskInputs,
    items: (items.data ?? []).map((item) => ({
      id: item.id,
      type: item.type,
      createdAt: item.createdAt,
      turnId: item.turnId,
      text: item.type === 'user-message' ? item.text : undefined,
      steps: item.type === 'plan' ? item.steps : undefined,
    })),
    turn: latestTurn ?? null,
  });
  const chrome = (
    <div className="sticky top-0 z-10 flex flex-col gap-2 bg-layer-1 py-2">
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
    </div>
  );

  if (groups.length === 0 && !live.isError) {
    if (unavailableTurn)
      return <p className="text-sm text-fg-muted">{timelineCopy.runUnavailable}</p>;
    return (
      <TimelineNowProvider now={clock}>
        {chrome}
        <EmptyState
          icon="chat"
          title={emptyTitle ?? 'No messages yet'}
          hint="Send a message to begin."
        />
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
      (items.data ?? []).some(
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
            ? (items.data ?? []).find(
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
            ? (items.data ?? []).find(
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
    setInspectedTurnId(null);
    inspectButtonRef.current?.focus();
  }

  const inspectedItems = (items.data ?? []).filter((item) => item.turnId === inspectedTurnId);
  const inspectedActivity = inspectedTurnId ? activityByTurn.get(inspectedTurnId) : undefined;
  const inspectedTurn = dashboard?.turns.find((turn) => turn.id === inspectedTurnId);
  const inspector = inspectedTurnId ? (
    <Inspector
      turnId={inspectedTurnId}
      items={inspectedItems}
      activity={inspectedActivity}
      interrupted={inspectedTurn?.status === 'interrupted'}
      onClose={closeInspector}
      panelRef={panelRef}
    />
  ) : null;

  return (
    <TimelineNowProvider now={clock}>
      {chrome}
      <ThreadReadReceipts
        key={`${workspaceId}:${threadId}:${dashboard?.viewerUserId ?? ''}`}
        workspaceId={workspaceId}
        threadId={threadId}
        viewerUserId={dashboard?.viewerUserId}
        items={items.data ?? []}
        disabled={controlsReadOnly || live.isError}
      >
        <div className="ok-timeline flex flex-col gap-5" data-timeline-lens={lens}>
          {lensProp === undefined ? (
            <fieldset
              aria-label={timelineCopy.lensName}
              className="m-0 flex min-w-0 gap-2 border-0 p-0"
            >
              <Button
                variant={lens === 'work' ? 'outline' : 'quiet'}
                size="sm"
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
                aria-pressed={lens === 'full'}
                onPress={() => {
                  setInternalLens('full');
                  writeStoredLens('full');
                }}
              >
                {timelineCopy.lensFull}
              </Button>
            </fieldset>
          ) : null}
          {earlierCursor ? (
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
            const runLens = lens === 'full' || expandedTurnId === group.turnId ? 'full' : 'work';
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

            return (
              <div
                key={group.turnId}
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
                {index > 0 ? <TurnSeparator label={runSeparatorCopy(index + 1)} /> : null}
                <RunEntry
                  entry={entry}
                  items={group.items}
                  turn={groupTurn}
                  lens={lens}
                  expanded={expandedTurnId === group.turnId}
                  actorName={actorName}
                  omitTrigger={Boolean(firstViewerMessage)}
                  durationMs={runDurationMs(groupTurn, Date.now())}
                  hiddenIds={groupedSourceIds}
                  renderItem={(item) => renderTimelineItem(item)}
                  inspectRef={inspectedTurnId === group.turnId ? inspectButtonRef : undefined}
                  inspected={inspectedTurnId === group.turnId}
                  onInspect={() =>
                    setInspectedTurnId((current) =>
                      current === group.turnId ? null : group.turnId
                    )
                  }
                  runningStatus={
                    runningStep && groupTurn ? (
                      <div role="status" className="ok-meta text-fg">
                        <Button
                          variant="quiet"
                          size="sm"
                          onPress={() => setExpandedTurnId(group.turnId)}
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
                  workerCue={Boolean(activity) && runLens === 'work'}
                  showActivity={Boolean(activity) && runLens === 'full'}
                  activityLine={
                    activity ? (
                      <section
                        aria-label="Runtime activity"
                        aria-live="polite"
                        className="rounded-ok border border-border bg-sunken p-4 text-sm"
                      >
                        <h3 className="font-semibold text-fg">Runtime activity</h3>
                        <p className="mt-1 text-fg-muted">{timelineCopy.reportedByWorker}</p>
                        <p className="mt-1 text-fg-muted">{coverageCopy(activity.coverage)}</p>
                        <p className="mt-1 text-fg-muted">{captureCopy(activity.contentCapture)}</p>
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
                {historicalFailure ? <ErrorBanner message={historicalFailure} /> : null}
              </div>
            );
          })}
        </div>
      </ThreadReadReceipts>
      {inspector ? (portalNode ? createPortal(inspector, portalNode) : inspector) : null}
    </TimelineNowProvider>
  );
}
