import type { TimelineItem, TimelineRunEntry } from '@openkit/app-api-schemas';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '../../../primitives';
import type { ThreadItem } from '../data';
import { ItemView } from '../ItemView';
import { fillCopy, timelineCopy } from './copy';
import { getDisplayedTimeline, subscribeDisplayedTimeline } from './displayed-timeline';
import { finishedIntervalView } from './interval-members';
import { useRunItemWindow } from './use-timeline-window';

type RecordedPlan = NonNullable<TimelineRunEntry['planSegments']>;

function policyLabel(outcome: string): string | null {
  if (outcome === 'allowed') return timelineCopy.allowedByPolicy;
  if (outcome === 'denied') return timelineCopy.deniedByPolicy;
  if (outcome === 'waiting-approval') return timelineCopy.waitingForApproval;
  return null;
}

/** Full-lens tool-call badge. A missing or null policy renders nothing. */
export function PolicyBadge({ policy }: { policy: TimelineItem['policy'] }) {
  const label = policy ? policyLabel(policy.outcome) : null;
  if (!policy || !label) return null;
  const params = new URLSearchParams();
  if (policy.capabilityCallId.length > 0) params.set('capabilityCallId', policy.capabilityCallId);
  if (policy.permissionDecisionId.length > 0) params.set('decision', policy.permissionDecisionId);
  const search = params.toString();
  if (search.length === 0) return <span>{label}</span>;
  return (
    <Link to={`/workspace/usage?${search}`} className="text-accent-content underline">
      {label}
    </Link>
  );
}

type PlanSegment = RecordedPlan['segments'][number];

function segmentKey(segment: PlanSegment): string {
  return `${segment.planItemId}:${segment.stepId}:${segment.startSequence}`;
}

function segmentLine(segment: PlanSegment): string {
  return fillCopy(timelineCopy.segmentSteps, { title: segment.title, count: segment.steps });
}

function emptyDisplayedTimeline() {
  return null;
}

/**
 * Finished intervals the user opened, kept outside the instance.
 * A step read can replace the disclosure before a pointer gesture ends.
 * A pointer press does not close an interval until that read has settled.
 * Keyboard presses toggle immediately. Membership still comes only from
 * the current admitted window.
 */
const closedIntervals: ReadonlySet<string> = new Set();
let openIntervals: ReadonlySet<string> = closedIntervals;
const openIntervalListeners = new Set<() => void>();

function subscribeOpenIntervals(listener: () => void): () => void {
  openIntervalListeners.add(listener);
  return () => {
    openIntervalListeners.delete(listener);
  };
}

function getOpenIntervals(): ReadonlySet<string> {
  return openIntervals;
}

function getServerOpenIntervals(): ReadonlySet<string> {
  return closedIntervals;
}

function toggleInterval(key: string, allowClose: boolean): void {
  const open = openIntervals.has(key);
  if (open && !allowClose) return;
  const next = new Set(openIntervals);
  if (open) next.delete(key);
  else next.add(key);
  openIntervals = next;
  for (const listener of openIntervalListeners) listener();
}

/** Test isolation. The latch outlives one disclosure so a step read cannot close it. */
export function resetOpenIntervals(): void {
  if (openIntervals.size === 0) return;
  openIntervals = closedIntervals;
  for (const listener of openIntervalListeners) listener();
}

interface StepAdmission {
  items: readonly TimelineItem[];
  beforeCursor: string | null;
  afterCursor: string | null;
  settled: boolean;
  paging: boolean;
  pageEarlier: () => void;
  pageLater: () => void;
}

function sameAdmission(left: StepAdmission, right: StepAdmission): boolean {
  return (
    left.settled === right.settled &&
    left.paging === right.paging &&
    left.beforeCursor === right.beforeCursor &&
    left.afterCursor === right.afterCursor &&
    left.items === right.items
  );
}

/** The run's existing step page. Mounted only for the admitted displayed run. */
function IntervalStepPage({
  workspaceId,
  threadId,
  turnId,
  onPage,
}: {
  workspaceId: string;
  threadId: string;
  turnId: string;
  onPage: (page: StepAdmission) => void;
}) {
  const page = useRunItemWindow({
    workspaceId,
    threadId,
    turnId,
    enabled: true,
    placement: 'step',
  });
  useEffect(() => {
    onPage({
      items: page.data?.items ?? [],
      beforeCursor: page.data?.beforeCursor ?? null,
      afterCursor: page.data?.afterCursor ?? null,
      settled: page.isSuccess || page.isError,
      paging: page.paging,
      pageEarlier: page.pageEarlier,
      pageLater: page.pageLater,
    });
  }, [
    onPage,
    page.data,
    page.isError,
    page.isSuccess,
    page.pageEarlier,
    page.pageLater,
    page.paging,
  ]);
  return null;
}

function IntervalMemberRow({ item }: { item: TimelineItem }) {
  if (item.detail.kind === 'preview') return <p>{item.detail.text}</p>;
  if (item.detail.kind !== 'complete' || item.detail.value == null) return null;
  return <ItemView item={item.detail.value as ThreadItem} readOnly />;
}

/** Recorded plan intervals for this run. Omitted or null coverage renders nothing. */
export function PlanSegments({ recorded }: { recorded?: RecordedPlan | null }) {
  const displayed = useSyncExternalStore(
    subscribeDisplayedTimeline,
    getDisplayedTimeline,
    emptyDisplayedTimeline
  );
  const openKeys = useSyncExternalStore(
    subscribeOpenIntervals,
    getOpenIntervals,
    getServerOpenIntervals
  );
  const [stepPage, setStepPage] = useState<StepAdmission | null>(null);
  const onStepPage = useCallback((next: StepAdmission) => {
    setStepPage((current) => (current && sameAdmission(current, next) ? current : next));
  }, []);
  const run =
    recorded == null
      ? null
      : (displayed?.data?.runs.find((candidate) => candidate.planSegments === recorded) ?? null);
  const anyOpen =
    recorded?.segments.some(
      (segment) => segment.endSequence != null && openKeys.has(segmentKey(segment))
    ) ?? false;
  useEffect(() => {
    if (!anyOpen) setStepPage(null);
  }, [anyOpen]);
  const itemWindow =
    run && displayed?.data?.itemWindow?.turnId === run.id ? displayed.data.itemWindow : null;
  const earlier = Boolean(stepPage?.beforeCursor || itemWindow?.beforeCursor);
  const later = Boolean(stepPage?.afterCursor || itemWindow?.afterCursor || run?.narrativeCursor);
  const frameEarlier = Boolean(displayed?.data?.beforeCursor);
  const frameLater = Boolean(displayed?.data?.afterCursor);
  const sources: TimelineItem[] = [];
  if (run) {
    sources.push(...run.narrative);
    if (run.plan) sources.push(run.plan);
    if (itemWindow) sources.push(...itemWindow.items);
    if (stepPage) sources.push(...stepPage.items.filter((item) => item.turnId === run.id));
  }
  if (!recorded || (recorded.segments.length === 0 && recorded.coverage !== 'partial')) return null;
  const settled = stepPage?.settled === true;
  const rows = recorded.segments.map((segment) => {
    const key = segmentKey(segment);
    const open = segment.endSequence != null && openKeys.has(key);
    const view =
      segment.endSequence == null
        ? null
        : finishedIntervalView(
            {
              startSequence: segment.startSequence,
              endSequence: segment.endSequence,
              steps: segment.steps,
            },
            sources,
            { earlier, later, settled }
          );
    return { segment, key, open, view };
  });
  const showEarlier = rows.some(
    (row) => row.open && row.view?.extendsEarlier && stepPage?.beforeCursor && !frameEarlier
  );
  const showLater = rows.some(
    (row) => row.open && row.view?.extendsLater && stepPage?.afterCursor && !frameLater
  );
  return (
    <div data-plan-coverage={recorded.coverage}>
      {run && displayed && anyOpen ? (
        <IntervalStepPage
          workspaceId={displayed.workspaceId}
          threadId={displayed.threadId}
          turnId={run.id}
          onPage={onStepPage}
        />
      ) : null}
      {rows.length > 0 ? (
        <ul aria-label={timelineCopy.planSegments}>
          {rows.map(({ segment, key, open, view }) =>
            view == null ? (
              <li key={key} data-plan-segment={segment.stepId} data-plan-open="true">
                {segmentLine(segment)}
              </li>
            ) : (
              <li key={key} data-fold-depth="1" data-plan-segment={segment.stepId}>
                <Button
                  variant="quiet"
                  size="sm"
                  aria-expanded={open}
                  onPress={(event) => {
                    const allowClose =
                      event.pointerType === 'keyboard' || stepPage?.settled === true;
                    toggleInterval(key, allowClose);
                  }}
                >
                  {segmentLine(segment)}
                </Button>
                {open && view.unavailable ? (
                  <p data-fold-depth="2">{timelineCopy.intervalMembersUnavailable}</p>
                ) : null}
                {open && view.members.length > 0 ? (
                  <ul data-plan-members>
                    {view.members.map((member) => (
                      <li key={member.id} data-plan-member={member.id}>
                        <IntervalMemberRow item={member.item} />
                      </li>
                    ))}
                  </ul>
                ) : null}
                {open && view.partial && recorded.coverage !== 'partial' ? (
                  <p>{timelineCopy.segmentsPartial}</p>
                ) : null}
              </li>
            )
          )}
        </ul>
      ) : null}
      {recorded.coverage === 'partial' ? <p>{timelineCopy.segmentsPartial}</p> : null}
      {showEarlier && stepPage ? (
        <Button
          variant="quiet"
          size="sm"
          isDisabled={stepPage.paging}
          onPress={stepPage.pageEarlier}
        >
          {timelineCopy.loadEarlier}
        </Button>
      ) : null}
      {showLater && stepPage ? (
        <Button variant="quiet" size="sm" isDisabled={stepPage.paging} onPress={stepPage.pageLater}>
          {timelineCopy.loadLater}
        </Button>
      ) : null}
    </div>
  );
}
