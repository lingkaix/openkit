import type { TimelineRunEntry } from '@openkit/app-api-schemas';
import { fillCopy, timelineCopy } from './copy';
import { captureCopy, coverageCopy, omittedActivityCopy } from './source';

type ReportedActivity = NonNullable<TimelineRunEntry['reportedActivity']>;
type ReportedEntry = ReportedActivity['entries'][number];

const KIND_WORD: Record<ReportedEntry['kind'], string> = {
  'child-started': 'started',
  progress: 'progress',
  result: 'result',
  failure: 'failure',
};

/** Fixed labels grouped together. The latest fact is the highest recorded sequence. */
export function groupReportedLabels(entries: readonly ReportedEntry[]): {
  label: string;
  count: number;
  line: string;
}[] {
  const order: string[] = [];
  const buckets = new Map<string, ReportedEntry[]>();
  for (const entry of entries) {
    const label = entry.label.trim() || timelineCopy.otherReportedActivity;
    const bucket = buckets.get(label);
    if (bucket) bucket.push(entry);
    else {
      order.push(label);
      buckets.set(label, [entry]);
    }
  }
  return order.map((label) => {
    const members = buckets.get(label) ?? [];
    const latest = members.reduce((current, entry) =>
      entry.sequence >= current.sequence ? entry : current
    );
    const updates = fillCopy(
      members.length === 1 ? timelineCopy.activityUpdate : timelineCopy.activityUpdates,
      { count: members.length }
    );
    const latestText = fillCopy(timelineCopy.latestReport, { kind: KIND_WORD[latest.kind] });
    return {
      label,
      count: members.length,
      line: `${label} · ${updates} · ${latestText}`,
    };
  });
}

/**
 * Grouped worker reports for one run.
 * Coverage is stated. Nothing here is a heartbeat or a live status.
 */
export function ReportedActivityView({ activity }: { activity: ReportedActivity | null }) {
  const groups = activity ? groupReportedLabels(activity.entries) : [];
  return (
    <section aria-label={timelineCopy.reportedActivityHeading} className="mt-4 text-sm">
      <h3 className="font-semibold text-fg">{timelineCopy.reportedActivityHeading}</h3>
      <p className="mt-1 text-fg-muted">
        {coverageCopy(activity?.coverage === 'partial' ? 'partial' : 'unavailable')}
      </p>
      {activity ? (
        <p className="mt-1 text-fg-muted">{captureCopy(activity.contentCapture)}</p>
      ) : null}
      {activity && activity.omittedEntryCount > 0 ? (
        <p className="mt-1 text-fg-muted">{omittedActivityCopy(activity.omittedEntryCount)}</p>
      ) : null}
      {groups.length > 0 ? (
        <ul className="mt-3 flex flex-col gap-2">
          {groups.map((group) => (
            <li
              key={group.label}
              data-activity-group={group.label}
              data-activity-count={group.count}
            >
              <p>{group.line}</p>
              <p className="text-fg-muted">{timelineCopy.reportedByWorker}</p>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
