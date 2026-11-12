import type { TimelineItem, TimelineRunEntry } from '@openkit/app-api-schemas';
import { Link } from 'react-router-dom';
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

/** Recorded plan intervals for this run. Omitted or null coverage renders nothing. */
export function PlanSegments({ recorded }: { recorded?: RecordedPlan | null }) {
  if (!recorded) return null;
  if (recorded.segments.length === 0 && recorded.coverage !== 'partial') return null;
  return (
    <div data-plan-coverage={recorded.coverage}>
      {recorded.segments.length > 0 ? (
        <ul aria-label={timelineCopy.planSegments}>
          {recorded.segments.map((segment) => (
            <li key={`${segment.planItemId}:${segment.stepId}:${segment.startSequence}`}>
              {fillCopy(timelineCopy.segmentSteps, { title: segment.title, count: segment.steps })}
            </li>
          ))}
        </ul>
      ) : null}
      {recorded.coverage === 'partial' ? <p>{timelineCopy.segmentsPartial}</p> : null}
    </div>
  );
}
