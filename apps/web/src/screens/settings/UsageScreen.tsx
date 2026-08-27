import { useConnection } from '../../app/core-client';
import {
  Card,
  ContextChip,
  EmptyState,
  ErrorBanner,
  ListRow,
  Page,
  PageHeader,
  Skeleton,
  StatusChip,
  type StatusTone,
} from '../../primitives';
import {
  type CapabilityUsageCallRow,
  type UsageRecordRow,
  useCurrentWorkspaceId,
  useUsageAndAudit,
  useWorkspaces,
  type WorkspaceAuditEventRow,
  type WorkspacePermissionDecisionRow,
} from './data';
import { projectSafeValue } from './secret-safe';

/**
 * Maps producer status values to the fixed Design vocabulary.
 *
 * @param value Capability, audit, or permission status.
 * @returns Plain status label and semantic tone.
 */
function evidenceStatus(value: string): { label: string; tone: StatusTone } {
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

/** Live, read-only selected-Workspace usage and governance projection for board 17. */
export function UsageScreen() {
  const workspaces = useWorkspaces();
  const workspaceId = useCurrentWorkspaceId();
  const workspace = workspaces.data?.find((candidate) => candidate.id === workspaceId) ?? null;
  const evidence = useUsageAndAudit(workspaceId);
  const { failed: disconnected } = useConnection();

  if (workspaces.isLoading || evidence.isLoading) {
    return (
      <Page>
        <Skeleton lines={8} />
      </Page>
    );
  }

  if (workspaces.isError) {
    return (
      <Page>
        <UsageHeader />
        <ErrorBanner
          message="Couldn't load workspaces."
          onRetry={() => void workspaces.refetch()}
        />
      </Page>
    );
  }

  if (!workspace) {
    return (
      <Page>
        <UsageHeader />
        <EmptyState
          icon="usage"
          title="No workspace selected"
          hint="Select or create a Workspace to view its usage and governance evidence."
        />
      </Page>
    );
  }

  return (
    <Page>
      <UsageHeader
        actions={
          <>
            <ContextChip>{projectSafeValue(workspace.name) as string}</ContextChip>
            {disconnected ? <StatusChip tone="notice">Status may be stale</StatusChip> : null}
          </>
        }
      />

      {evidence.isError ? (
        <ErrorBanner
          message="Couldn't load usage and audit records."
          onRetry={() => void evidence.refetch()}
        />
      ) : evidence.data ? (
        <>
          <section className="flex flex-col gap-3" aria-labelledby="usage-records">
            <h2
              id="usage-records"
              className="text-eyebrow font-bold uppercase tracking-eyebrow text-fg-muted"
            >
              Usage
            </h2>
            {evidence.data.capabilityCalls.length === 0 &&
            evidence.data.usageRecords.length === 0 ? (
              <EmptyState
                icon="usage"
                title="No usage recorded"
                hint="Capability calls and measured usage for this Workspace will appear here."
              />
            ) : (
              <Card className="py-0">
                {evidence.data.capabilityCalls.map((call) => (
                  <CapabilityCallRow key={call.id} call={call} />
                ))}
                {evidence.data.usageRecords.map((record) => (
                  <UsageRow key={record.id} record={record} />
                ))}
              </Card>
            )}
          </section>

          <section className="flex flex-col gap-3" aria-labelledby="workspace-audit-events">
            <h2
              id="workspace-audit-events"
              className="text-eyebrow font-bold uppercase tracking-eyebrow text-fg-muted"
            >
              Audit events
            </h2>
            {evidence.data.auditEvents.length === 0 ? (
              <EmptyState
                icon="usage"
                title="No audit events"
                hint="Workspace audit events will appear here as Core records them."
              />
            ) : (
              <Card className="py-0">
                {evidence.data.auditEvents.map((event) => (
                  <AuditEventRow key={event.id} event={event} />
                ))}
              </Card>
            )}
          </section>

          <section className="flex flex-col gap-3" aria-labelledby="permission-decisions">
            <h2
              id="permission-decisions"
              className="text-eyebrow font-bold uppercase tracking-eyebrow text-fg-muted"
            >
              Permission decisions
            </h2>
            {evidence.data.permissionDecisions.length === 0 ? (
              <EmptyState
                icon="usage"
                title="No permission decisions"
                hint="Workspace permission decisions will appear here as policy is evaluated."
              />
            ) : (
              <Card className="py-0">
                {evidence.data.permissionDecisions.map((decision) => (
                  <PermissionDecisionRow key={decision.decisionId} decision={decision} />
                ))}
              </Card>
            )}
          </section>
        </>
      ) : null}
    </Page>
  );
}

/**
 * Renders the selected-Workspace Usage & audit header.
 *
 * @param props Optional Workspace and connection-status chips.
 */
function UsageHeader({ actions }: { actions?: React.ReactNode }) {
  return (
    <PageHeader
      eyebrow="Settings"
      title="Usage & audit"
      subtitle="Read-only capability usage, audit events, and permission decisions for the selected Workspace."
      actions={actions}
    />
  );
}

/**
 * Renders one whitelisted capability-call row.
 *
 * @param props Safe capability-call metadata.
 */
function CapabilityCallRow({ call }: { call: CapabilityUsageCallRow }) {
  const status = evidenceStatus(call.status);
  return (
    <ListRow>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-bold text-fg-strong">{call.operation}</p>
        {call.summary ? <p className="text-xs text-fg-muted">{call.summary}</p> : null}
        <p className="text-xs text-fg-muted">{call.family}</p>
      </div>
      <StatusChip tone={status.tone} dot>
        {status.label}
      </StatusChip>
    </ListRow>
  );
}

/**
 * Renders one whitelisted usage row.
 *
 * @param props Safe metering metadata.
 */
function UsageRow({ record }: { record: UsageRecordRow }) {
  return (
    <ListRow>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-bold text-fg-strong">
          {record.quantity} {record.unit}
        </p>
        <p className="text-xs text-fg-muted">{record.category}</p>
      </div>
    </ListRow>
  );
}

/**
 * Renders one whitelisted Workspace audit-event row.
 *
 * @param props Safe audit metadata.
 */
function AuditEventRow({ event }: { event: WorkspaceAuditEventRow }) {
  const status = evidenceStatus(event.outcome);
  return (
    <ListRow>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-bold text-fg-strong">{event.action}</p>
        <p className="text-xs text-fg-muted">{event.summary}</p>
        <p className="text-xs text-fg-muted">{event.category}</p>
      </div>
      <StatusChip tone={status.tone} dot>
        {status.label}
      </StatusChip>
    </ListRow>
  );
}

/**
 * Renders one whitelisted Workspace permission-decision row.
 *
 * @param props Safe decision metadata.
 */
function PermissionDecisionRow({ decision }: { decision: WorkspacePermissionDecisionRow }) {
  const status = evidenceStatus(decision.result);
  return (
    <ListRow>
      <p className="min-w-0 flex-1 text-sm font-bold text-fg-strong">{decision.action}</p>
      <StatusChip tone={status.tone} dot>
        {status.label}
      </StatusChip>
    </ListRow>
  );
}
