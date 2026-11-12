import type { TimelineItem, TimelineRunEntry } from '@openkit/app-api-schemas';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '../../../primitives';
import { fillCopy, timelineCopy } from './copy';

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

/** One finished interval. Expansion contains that recorded interval and no other. */
function FinishedSegment({ segment }: { segment: PlanSegment }) {
  const [open, setOpen] = useState(false);
  const line = segmentLine(segment);
  return (
    <li data-fold-depth="1" data-plan-segment={segment.stepId}>
      <Button
        variant="quiet"
        size="sm"
        aria-expanded={open}
        onPress={() => setOpen((value) => !value)}
      >
        {line}
      </Button>
      {open ? (
        <ul data-fold-depth="2" data-plan-members={segment.stepId}>
          <li data-plan-member={segmentKey(segment)}>{line}</li>
        </ul>
      ) : null}
    </li>
  );
}

/** Recorded plan intervals for this run. Omitted or null coverage renders nothing. */
export function PlanSegments({ recorded }: { recorded?: RecordedPlan | null }) {
  if (!recorded) return null;
  if (recorded.segments.length === 0 && recorded.coverage !== 'partial') return null;
  return (
    <div data-plan-coverage={recorded.coverage}>
      {recorded.segments.length > 0 ? (
        <ul aria-label={timelineCopy.planSegments}>
          {recorded.segments.map((segment) =>
            segment.endSequence == null ? (
              <li
                key={segmentKey(segment)}
                data-plan-segment={segment.stepId}
                data-plan-open="true"
              >
                {segmentLine(segment)}
              </li>
            ) : (
              <FinishedSegment key={segmentKey(segment)} segment={segment} />
            )
          )}
        </ul>
      ) : null}
      {recorded.coverage === 'partial' ? <p>{timelineCopy.segmentsPartial}</p> : null}
    </div>
  );
}
