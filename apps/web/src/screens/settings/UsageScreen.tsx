import { useConnection } from '../../app/core-client';
import {
  Button,
  Card,
  ContextChip,
  EmptyState,
  ErrorBanner,
  ListRow,
  Page,
  PageHeader,
  Skeleton,
  StatusChip,
} from '../../primitives';
import {
  AuditEventRow,
  evidenceStatus,
  PermissionDecisionRow,
  RecordedTime,
  ThreadLink,
  useThreadActivity,
} from './AuditRows';
import {
  type CapabilityUsageCallRow,
  type UsageRecordRow,
  useCurrentWorkspaceId,
  useUsageAndAudit,
  useWorkspaces,
} from './data';
import {
  attentionClause,
  attentionSentence,
  isAttention,
  LongList,
  matchesLoadedRow,
} from './LongList';
import { projectSafeValue } from './secret-safe';

/** Live, read-only selected-Workspace usage and governance projection for board 17. */
export function UsageScreen() {
  const workspaces = useWorkspaces();
  const workspaceId = useCurrentWorkspaceId();
  const workspace = workspaces.data?.find((candidate) => candidate.id === workspaceId) ?? null;
  const evidence = useUsageAndAudit(workspaceId);
  const activity = useThreadActivity([
    workspaceId,
    ...(evidence.data?.auditEvents.map((event) => event.workspaceId) ?? []),
  ]);
  const { failed: disconnected } = useConnection();

  if (workspaces.isLoading || evidence.isLoading || activity.pending) {
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
        <UsageRecords
          evidence={evidence.data}
          activity={activity}
          hasNextPage={evidence.hasNextPage}
          isFetchingNextPage={evidence.isFetchingNextPage}
          fetchNextPage={() => void evidence.fetchNextPage()}
        />
      ) : null}
    </Page>
  );
}

/**
 * Renders the selected-Workspace Usage & audit header.
 *
 * @param props Optional Workspace and connection-status chips.
 */
function UsageRecords({
  evidence,
  activity,
  hasNextPage,
  isFetchingNextPage,
  fetchNextPage,
}: {
  evidence: NonNullable<ReturnType<typeof useUsageAndAudit>['data']>;
  activity: ReturnType<typeof useThreadActivity>;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => void;
}) {
  const empty =
    evidence.capabilityCalls.length === 0 &&
    evidence.usageRecords.length === 0 &&
    evidence.auditEvents.length === 0 &&
    evidence.permissionDecisions.length === 0;
  if (empty) {
    return (
      <>
        <EmptyState
          icon="usage"
          title="No usage recorded"
          hint="Capability calls and measured usage for this Workspace will appear here."
        />
        <EmptyState
          icon="usage"
          title="No audit events"
          hint="Workspace audit events will appear here as Core records them."
        />
        <EmptyState
          icon="usage"
          title="No permission decisions"
          hint="Workspace permission decisions will appear here as policy is evaluated."
        />
      </>
    );
  }
  return (
    <>
      <LongList
        summary={(filter) => {
          const lines = [
            ...evidence.capabilityCalls
              .filter(
                (call) =>
                  isAttention(call.status) &&
                  matchesLoadedRow(filter, {
                    outcome: call.status,
                    title: call.operation,
                    at: call.startedAt,
                  })
              )
              .map((call) => (
                <p key={call.id}>
                  {attentionSentence(attentionClause(call.status), call.operation, call.startedAt)}
                </p>
              )),
            ...evidence.auditEvents
              .filter(
                (event) =>
                  isAttention(event.outcome) &&
                  matchesLoadedRow(filter, {
                    outcome: event.outcome,
                    title: event.summary || event.action,
                    at: event.recordedAt,
                  })
              )
              .map((event) => (
                <div key={event.id} className="flex flex-col gap-1">
                  <p>
                    {attentionSentence(
                      attentionClause(event.outcome),
                      event.summary || event.action,
                      event.recordedAt
                    )}
                  </p>
                  <ThreadLink
                    workspaceId={event.workspaceId}
                    threadId={event.threadId}
                    activity={activity.activityFor(event.threadId)}
                  />
                </div>
              )),
            ...evidence.permissionDecisions
              .filter(
                (decision) =>
                  isAttention(decision.result) &&
                  matchesLoadedRow(filter, {
                    outcome: decision.result,
                    title: decision.action,
                    at: decision.createdAt,
                  })
              )
              .map((decision) => (
                <p key={decision.decisionId}>
                  {attentionSentence(
                    attentionClause(decision.result),
                    decision.action,
                    decision.createdAt
                  )}
                </p>
              )),
          ];
          return lines.length > 0 ? lines : <p>Nothing failed, was denied, or needs a decision.</p>;
        }}
        records={(filter) => (
          <>
            <UsageSection
              id="usage-records"
              title="Usage"
              empty={evidence.usageRecords.length === 0 && evidence.capabilityCalls.length === 0}
            >
              {evidence.usageRecords
                .filter((record) =>
                  matchesLoadedRow(filter, {
                    outcome: 'succeeded',
                    title: record.measurement,
                    at: record.recordedAt,
                  })
                )
                .map((record) => (
                  <UsageRow key={record.id} record={record} />
                ))}
              {evidence.capabilityCalls
                .filter((call) =>
                  matchesLoadedRow(filter, {
                    outcome: call.status,
                    title: call.operation,
                    at: call.startedAt,
                  })
                )
                .map((call) => (
                  <CapabilityCallRow key={call.id} call={call} />
                ))}
            </UsageSection>
            <UsageSection
              id="workspace-audit-events"
              title="Audit events"
              empty={evidence.auditEvents.length === 0}
              emptyTitle="No audit events"
              emptyHint="Workspace audit events will appear here as Core records them."
            >
              {evidence.auditEvents
                .filter((event) =>
                  matchesLoadedRow(filter, {
                    outcome: event.outcome,
                    title: event.summary || event.action,
                    at: event.recordedAt,
                  })
                )
                .map((event) => (
                  <AuditEventRow
                    key={event.id}
                    event={event}
                    activity={activity.activityFor(event.threadId)}
                  />
                ))}
            </UsageSection>
            <UsageSection
              id="permission-decisions"
              title="Permission decisions"
              empty={evidence.permissionDecisions.length === 0}
              emptyTitle="No permission decisions"
              emptyHint="Workspace permission decisions will appear here as policy is evaluated."
            >
              {evidence.permissionDecisions
                .filter((decision) =>
                  matchesLoadedRow(filter, {
                    outcome: decision.result,
                    title: decision.action,
                    at: decision.createdAt,
                  })
                )
                .map((decision) => (
                  <PermissionDecisionRow key={decision.decisionId} decision={decision} />
                ))}
            </UsageSection>
          </>
        )}
      />
      {hasNextPage ? (
        <Button
          variant="quiet"
          className="min-h-11 justify-start px-3"
          isDisabled={isFetchingNextPage}
          onPress={fetchNextPage}
        >
          Load more
        </Button>
      ) : null}
    </>
  );
}

function UsageSection({
  id,
  title,
  empty,
  emptyTitle,
  emptyHint,
  children,
}: {
  id: string;
  title: string;
  empty?: boolean;
  emptyTitle?: string;
  emptyHint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3" aria-labelledby={id}>
      <h2 id={id} className="text-eyebrow font-bold tracking-eyebrow text-fg-muted">
        {title}
      </h2>
      {empty ? (
        <EmptyState icon="usage" title={emptyTitle ?? 'No usage recorded'} hint={emptyHint ?? ''} />
      ) : (
        <Card className="py-0">{children}</Card>
      )}
    </section>
  );
}

function UsageHeader({ actions }: { actions?: React.ReactNode }) {
  return (
    <PageHeader
      eyebrow="Workspace"
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
        <RecordedTime value={call.startedAt} />
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
          <span>{record.measurement}</span> ·{' '}
          <span>
            {record.quantity} {record.unit}
          </span>
        </p>
        <p className="text-xs text-fg-muted">{record.category}</p>
        {record.category === 'llm' ? (
          <p className="text-xs text-fg-muted">Logical model: {record.modelId ?? 'Not recorded'}</p>
        ) : null}
        <RecordedTime value={record.recordedAt} />
      </div>
    </ListRow>
  );
}
