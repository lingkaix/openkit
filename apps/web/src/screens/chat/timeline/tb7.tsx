import type { TimelineItem, TimelineRunEntry } from '@openkit/app-api-schemas';
import { type QueryClient, QueryClientContext } from '@tanstack/react-query';
import { useContext } from 'react';
import { Link } from 'react-router-dom';
import { fillCopy, timelineCopy } from './copy';

type RecordedPlan = NonNullable<TimelineRunEntry['planSegments']>;

function isRecordedItem(value: unknown): value is TimelineItem {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    typeof (value as { id?: unknown }).id === 'string'
  );
}

/** Timeline items already held by the thread reads. This does not start another read. */
function recordedItems(value: unknown): TimelineItem[] {
  if (!value || typeof value !== 'object') return [];
  const row = value as {
    items?: unknown[];
    runs?: { narrative?: unknown[]; plan?: unknown }[];
    itemWindow?: { items?: unknown[] } | null;
  };
  const found: TimelineItem[] = [];
  for (const item of row.items ?? []) if (isRecordedItem(item)) found.push(item);
  for (const item of row.itemWindow?.items ?? []) if (isRecordedItem(item)) found.push(item);
  for (const run of row.runs ?? []) {
    for (const item of run.narrative ?? []) if (isRecordedItem(item)) found.push(item);
    if (isRecordedItem(run.plan)) found.push(run.plan);
  }
  return found;
}

function heldRows(client: QueryClient): unknown[] {
  return [
    ...client.getQueriesData({ queryKey: ['thread-timeline'] }),
    ...client.getQueriesData({ queryKey: ['thread-timeline-items'] }),
  ].map(([, data]) => data);
}

/** Empty when a run renders outside the timeline query. No badge and no segments. */
function useHeldRows(): unknown[] {
  const client = useContext(QueryClientContext);
  return client ? heldRows(client) : [];
}

function policyFor(rows: readonly unknown[], itemId: string): TimelineItem['policy'] {
  for (const row of rows) {
    for (const item of recordedItems(row)) {
      if (item.id === itemId) return item.policy ?? null;
    }
  }
  return null;
}

function segmentsFor(rows: readonly unknown[], turnId: string): RecordedPlan | null {
  for (const row of rows) {
    if (!row || typeof row !== 'object' || !('runs' in row)) continue;
    const runs = (
      row as { runs?: { id?: string; planSegments?: TimelineRunEntry['planSegments'] }[] }
    ).runs;
    const match = runs?.find((run) => run.id === turnId)?.planSegments;
    if (match && match.segments.length > 0) return match;
  }
  return null;
}

function policyLabel(outcome: string): string | null {
  if (outcome === 'allowed') return timelineCopy.allowedByPolicy;
  if (outcome === 'denied') return timelineCopy.deniedByPolicy;
  if (outcome === 'waiting-approval') return timelineCopy.waitingForApproval;
  return null;
}

/** Full-lens tool-call badge. A missing or null policy renders nothing. */
export function PolicyBadge({ itemId }: { itemId: string }) {
  const rows = useHeldRows();
  const policy = policyFor(rows, itemId);
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

/** Recorded plan intervals. Partial coverage says the counts are incomplete. */
export function PlanSegments({ turnId }: { turnId: string }) {
  const recorded = segmentsFor(useHeldRows(), turnId);
  if (!recorded) return null;
  return (
    <div data-plan-coverage={recorded.coverage}>
      <ul aria-label={timelineCopy.planSegments}>
        {recorded.segments.map((segment) => (
          <li key={`${segment.planItemId}:${segment.stepId}:${segment.startSequence}`}>
            {fillCopy(timelineCopy.segmentSteps, { title: segment.title, count: segment.steps })}
          </li>
        ))}
      </ul>
      {recorded.coverage === 'partial' ? <p>{timelineCopy.segmentsPartial}</p> : null}
    </div>
  );
}
