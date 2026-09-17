import { ListRow, StatusChip, type StatusTone } from '../../primitives';
import type { AuditEventDisplayRow, PermissionDecisionDisplayRow } from './data';

/**
 * Maps producer status values to the fixed Design vocabulary.
 *
 * @param value Capability, audit, or permission status.
 * @returns Plain status label and semantic tone.
 */
export function evidenceStatus(value: string): { label: string; tone: StatusTone } {
  switch (value) {
    case 'queued':
      return { label: 'Queued', tone: 'neutral' };
    case 'running':
      return { label: 'Running', tone: 'informative' };
    case 'succeeded':
      return { label: 'Done', tone: 'positive' };
    case 'allow':
      return { label: 'Approved', tone: 'positive' };
    case 'require_approval':
      return { label: 'Awaiting approval', tone: 'notice' };
    case 'require_escalation':
    case 'defer':
    case 'not_applicable':
      return { label: 'Blocked', tone: 'notice' };
    case 'cancelled':
      return { label: 'Cancelled', tone: 'neutral' };
    case 'denied':
    case 'deny':
      return { label: 'Rejected', tone: 'negative' };
    case 'failed':
      return { label: 'Failed', tone: 'negative' };
    case 'error':
      return { label: 'Error', tone: 'negative' };
  }
  return { label: 'Error', tone: 'negative' };
}

/** Renders one recorded instant, or an explicit unavailable label when the producer omitted it. */
export function RecordedTime({ value }: { value?: string }) {
  return (
    <p className="text-xs text-fg-muted">
      {value ? (
        <time dateTime={value} title={value}>
          {new Date(value).toLocaleString(undefined, { timeZoneName: 'short' })}
        </time>
      ) : (
        'Not recorded'
      )}
    </p>
  );
}

/**
 * Renders one whitelisted audit-event row.
 *
 * @param props Safe audit metadata.
 */
export function AuditEventRow({ event }: { event: AuditEventDisplayRow }) {
  const status = evidenceStatus(event.outcome);
  return (
    <ListRow>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-bold text-fg-strong">{event.action}</p>
        <p className="text-xs text-fg-muted">{event.summary}</p>
        <p className="text-xs text-fg-muted">{event.category}</p>
        <RecordedTime value={event.recordedAt} />
      </div>
      <StatusChip tone={status.tone} dot>
        {status.label}
      </StatusChip>
    </ListRow>
  );
}

/**
 * Renders one whitelisted permission-decision row.
 *
 * @param props Safe decision metadata.
 */
export function PermissionDecisionRow({ decision }: { decision: PermissionDecisionDisplayRow }) {
  const status = evidenceStatus(decision.result);
  return (
    <ListRow>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-bold text-fg-strong">{decision.action}</p>
        <RecordedTime value={decision.createdAt} />
      </div>
      <StatusChip tone={status.tone} dot>
        {status.label}
      </StatusChip>
    </ListRow>
  );
}
