import type { TimelineItem, TimelineRunEntry } from '@openkit/app-api-schemas';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '../../../primitives';
import type { ThreadItem } from '../data';
import { ItemView } from '../ItemView';
import { fillCopy, timelineCopy } from './copy';
import { finishedIntervalView } from './interval-members';
import type { TimelineEntry } from './source';
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

type AdmittedRun = NonNullable<TimelineEntry['admittedRun']>;

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

/**
 * Recorded plan intervals for this run.
 * Open state stays on this owner, so a second stream and a remount start closed.
 * The admitted run comes from the parent entry. Coverage uses this step page only.
 */
export function PlanSegments({
  recorded,
  admittedRun = null,
  workspaceId = null,
  threadId = null,
}: {
  recorded?: RecordedPlan | null;
  admittedRun?: AdmittedRun | null;
  workspaceId?: string | null;
  threadId?: string | null;
}) {
  const [openKeys, setOpenKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [stepPage, setStepPage] = useState<StepAdmission | null>(null);
  const onStepPage = useCallback((next: StepAdmission) => {
    setStepPage((current) => (current && sameAdmission(current, next) ? current : next));
  }, []);
  const anyOpen =
    recorded?.segments.some(
      (segment) => segment.endSequence != null && openKeys.has(segmentKey(segment))
    ) ?? false;
  useEffect(() => {
    if (!anyOpen) setStepPage(null);
  }, [anyOpen]);
  const earlier = Boolean(stepPage?.beforeCursor);
  const later = Boolean(stepPage?.afterCursor);
  const sources: TimelineItem[] = [];
  const stepItems: TimelineItem[] = [];
  if (admittedRun) {
    sources.push(...admittedRun.narrative);
    if (admittedRun.plan) sources.push(admittedRun.plan);
    if (stepPage) {
      for (const item of stepPage.items) {
        if (item.turnId !== admittedRun.id) continue;
        sources.push(item);
        stepItems.push(item);
      }
    }
  }
  const toggle = (key: string, allowClose: boolean) => {
    setOpenKeys((current) => {
      const open = current.has(key);
      if (open && !allowClose) return current;
      const next = new Set(current);
      if (open) next.delete(key);
      else next.add(key);
      return next;
    });
  };
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
            stepItems,
            { earlier, later, settled }
          );
    return { segment, key, open, view };
  });
  const showEarlier = rows.some(
    (row) => row.open && row.view?.extendsEarlier && stepPage?.beforeCursor
  );
  const showLater = rows.some((row) => row.open && row.view?.extendsLater && stepPage?.afterCursor);
  return (
    <div data-plan-coverage={recorded.coverage}>
      {admittedRun && workspaceId && threadId && anyOpen ? (
        <IntervalStepPage
          workspaceId={workspaceId}
          threadId={threadId}
          turnId={admittedRun.id}
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
                    toggle(key, allowClose);
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
