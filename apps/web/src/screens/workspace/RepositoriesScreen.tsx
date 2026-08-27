import { ApiCallError, type CoreClient, createRequestId } from '@openkit/core-client';
import { useState } from 'react';
import { useConnection } from '../../app/core-client';
import {
  Button,
  Card,
  ContextChip,
  EmptyState,
  ErrorBanner,
  Eyebrow,
  ListRow,
  Page,
  PageHeader,
  Select,
  Skeleton,
  StatusChip,
  type StatusTone,
  TextField,
} from '../../primitives';
import {
  type GitPushApprovalCommand,
  useCurrentWorkspaceId,
  useExecuteGitPush,
  useRepositoryProjection,
  useRequestGitPushApproval,
  useWorkspaces,
} from './data';

/** Server-owned approval response for one exact repository push request. */
type GitPushApproval = Awaited<ReturnType<CoreClient['repositories']['requestGitPushApproval']>>;
/** Authoritative durable record read after one normally closed push attempt. */
type GitPushRecord = Awaited<ReturnType<CoreClient['repositories']['getGitPushRecord']>>;

/** Fixed product labels for server-owned approval states. */
const APPROVAL_STATUS = {
  pending: { label: 'Awaiting approval', tone: 'notice' },
  granted: { label: 'Approved', tone: 'positive' },
  denied: { label: 'Denied', tone: 'negative' },
  expired: { label: 'Expired', tone: 'neutral' },
  superseded: { label: 'Superseded', tone: 'neutral' },
  withdrawn: { label: 'Withdrawn', tone: 'neutral' },
} satisfies Record<GitPushApproval['approval']['status'], { label: string; tone: StatusTone }>;

/** Fixed product labels for durable Git push outcomes. */
const PUSH_OUTCOME = {
  pushed: { label: 'Pushed', tone: 'positive' },
  'rejected-non-fast-forward': { label: 'Rejected', tone: 'negative' },
  'rejected-protected': { label: 'Protected', tone: 'negative' },
  'auth-failed': { label: 'Authentication failed', tone: 'negative' },
  'remote-unreachable': { label: 'Remote unavailable', tone: 'negative' },
  'refused-policy': { label: 'Policy refused', tone: 'negative' },
  'refused-linkage': { label: 'Linkage refused', tone: 'negative' },
  'unsupported-provider': { label: 'Unsupported provider', tone: 'negative' },
} satisfies Record<GitPushRecord['outcome'], { label: string; tone: StatusTone }>;

/** Live selected-Workspace repositories, diagnostics, and approval-gated push surface. */
export function RepositoriesScreen() {
  const workspaces = useWorkspaces();
  const currentWorkspaceId = useCurrentWorkspaceId();
  const workspace =
    workspaces.data?.find((candidate) => candidate.id === currentWorkspaceId) ?? null;
  const repositories = useRepositoryProjection(currentWorkspaceId);
  const request = useRequestGitPushApproval();
  const execute = useExecuteGitPush();
  const { checking, failed: disconnected } = useConnection();
  const [resourceSelection, setResourceSelection] = useState<string | null>(null);
  const [threadId, setThreadId] = useState('');
  const [turnId, setTurnId] = useState('');
  const [sourceRef, setSourceRef] = useState('');
  const [targetBranch, setTargetBranch] = useState('');
  const [commitIds, setCommitIds] = useState('');
  const [approvalCommand, setApprovalCommand] = useState<GitPushApprovalCommand | null>(null);
  const approval = request.data ?? null;
  const authoritativeRecord = execute.data ?? null;

  if (workspaces.isLoading || repositories.isLoading) {
    return (
      <Page>
        <Skeleton lines={8} />
      </Page>
    );
  }

  if (workspaces.isError) {
    return (
      <Page>
        <RepositoriesHeader />
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
        <RepositoriesHeader />
        <EmptyState
          icon="repository"
          title="No workspace selected"
          hint="Select or create a Workspace to inspect its linked repositories."
        />
      </Page>
    );
  }

  if (repositories.isError || !repositories.data) {
    return (
      <Page>
        <RepositoriesHeader workspaceName={workspace.name} />
        <ErrorBanner
          message="Couldn't load repositories."
          onRetry={() => void repositories.refetch()}
        />
      </Page>
    );
  }

  const workspaceId = workspace.id;
  const resourceItems = repositories.data.resources.items;
  const selectedResourceId = resourceItems.some(
    (resource) => resource.resourceId === resourceSelection
  )
    ? (resourceSelection as string)
    : (repositories.data.resources.defaultResourceId ?? resourceItems[0]?.resourceId ?? null);
  const selectedResource =
    resourceItems.find((resource) => resource.resourceId === selectedResourceId) ?? null;
  const parsedCommitIds = commitIds
    .split(/\s+/)
    .map((commitId) => commitId.trim())
    .filter(Boolean);
  const requestReady = Boolean(
    selectedResource &&
      threadId.trim() &&
      turnId.trim() &&
      sourceRef.trim() &&
      targetBranch.trim() &&
      parsedCommitIds.length
  );
  const approvalMatches = Boolean(
    approval &&
      approvalCommand &&
      approval.approval.workspaceId === approvalCommand.workspaceId &&
      approval.approval.threadId === approvalCommand.input.threadId &&
      approval.approval.turnId === approvalCommand.input.turnId &&
      workspaceId === approvalCommand.workspaceId &&
      selectedResourceId === approvalCommand.resourceId
  );
  const approvalStatus = approval ? APPROVAL_STATUS[approval.approval.status] : null;
  const terminalRecordCandidates = authoritativeRecord
    ? [authoritativeRecord, ...repositories.data.pushRecords]
    : repositories.data.pushRecords;
  const matchingTerminalRecord =
    approval && approvalCommand
      ? terminalRecordCandidates.find(
          (record) =>
            record.workspaceId === approvalCommand.workspaceId &&
            record.repositoryResourceId === approvalCommand.resourceId &&
            record.approvalRowId === approval.approvalItemId &&
            record.policyDecisionId === approval.policyDecisionId &&
            record.sourceRef === approvalCommand.input.sourceRef &&
            record.targetBranch === approvalCommand.input.targetBranch &&
            record.commitIds.length === approvalCommand.input.commitIds.length &&
            record.commitIds.every(
              (commitId, index) => commitId === approvalCommand.input.commitIds[index]
            )
        )
      : undefined;
  const approvalHasTerminalRecord = Boolean(matchingTerminalRecord);
  const authoritativeRecordMatches = matchingTerminalRecord === authoritativeRecord;
  const pushRecords = [...repositories.data.pushRecords];
  if (authoritativeRecord && authoritativeRecordMatches) {
    const existingRecordIndex = pushRecords.findIndex((row) => row.id === authoritativeRecord.id);
    if (existingRecordIndex === -1) pushRecords.unshift(authoritativeRecord);
    else pushRecords[existingRecordIndex] = authoritativeRecord;
  }
  const commandError = request.error ?? execute.error;
  const commandErrorMessage =
    commandError instanceof ApiCallError && commandError.code === 'idempotency_key_conflict'
      ? 'Request conflict'
      : commandError instanceof ApiCallError && commandError.code === 'recovery_required'
        ? 'Recovery required'
        : request.error
          ? "Couldn't request push approval."
          : execute.error
            ? "Couldn't execute the push."
            : authoritativeRecord && !authoritativeRecordMatches
              ? 'Recovery required'
              : null;
  const writeBlocked = checking || disconnected || repositories.isFetching;

  /** Starts one fresh approval request from the exact visible target fields. */
  async function requestApproval() {
    if (!selectedResourceId || !requestReady) return;
    request.reset();
    execute.reset();
    const command: GitPushApprovalCommand = {
      workspaceId,
      resourceId: selectedResourceId,
      input: {
        requestId: createRequestId(),
        threadId: threadId.trim(),
        turnId: turnId.trim(),
        sourceRef: sourceRef.trim(),
        targetBranch: targetBranch.trim(),
        commitIds: parsedCommitIds,
      },
    };
    setApprovalCommand(command);
    try {
      await request.mutateAsync(command);
      await repositories.refetch();
    } catch {
      // TanStack Query retains the typed error for an explicit read-only retry.
    }
  }

  /** Replays the frozen approval command to read its authoritative current status. */
  async function checkApproval() {
    if (!approvalCommand) return;
    try {
      await request.mutateAsync(approvalCommand);
      await repositories.refetch();
    } catch {
      // TanStack Query retains the typed error without replaying automatically.
    }
  }

  /** Executes only the exact matching granted approval and waits for its record read. */
  async function executeApprovedPush() {
    if (
      !approvalCommand ||
      !approval ||
      !approvalMatches ||
      approval.approval.status !== 'granted' ||
      approvalHasTerminalRecord
    )
      return;
    try {
      await execute.mutateAsync({
        workspaceId: approvalCommand.workspaceId,
        resourceId: approvalCommand.resourceId,
        input: {
          requestId: createRequestId(),
          approvalRequestId: approval.approval.id,
        },
      });
      await repositories.refetch();
    } catch {
      // TanStack Query retains the typed error without replaying automatically.
    }
  }

  /** Refetches authoritative records, then clears the failed command for a fresh request. */
  async function retryAfterCommandError() {
    await repositories.refetch();
    request.reset();
    execute.reset();
    setApprovalCommand(null);
  }

  return (
    <Page>
      <RepositoriesHeader workspaceName={workspace.name} stale={disconnected} />

      <section className="flex flex-col gap-3" aria-labelledby="linked-repositories">
        <Eyebrow>
          <span id="linked-repositories">Linked repositories</span>
        </Eyebrow>
        {resourceItems.length === 0 ? (
          <EmptyState
            icon="repository"
            title="No linked repositories"
            hint="Repository resources linked to this Workspace will appear here."
          />
        ) : (
          <Card className="py-0">
            {resourceItems.map((resource) => (
              <ListRow key={resource.resourceId}>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-bold text-fg-strong">{resource.displayName}</p>
                  <p className="text-xs text-fg-muted">{resource.pathSummary}</p>
                </div>
                <StatusChip tone={resource.diagnosticsStatus === 'ready' ? 'positive' : 'notice'}>
                  {resource.diagnosticsStatus === 'ready' ? 'Ready' : 'Needs attention'}
                </StatusChip>
              </ListRow>
            ))}
          </Card>
        )}
      </section>

      <section className="flex flex-col gap-3" aria-labelledby="repository-diagnostics">
        <Eyebrow>
          <span id="repository-diagnostics">Repository diagnostics</span>
        </Eyebrow>
        {repositories.data.diagnostics.resources.length === 0 ? (
          <EmptyState
            icon="repository"
            title="No repository diagnostics"
            hint="Readiness diagnostics will appear after a repository is linked."
          />
        ) : (
          <Card className="py-0">
            {repositories.data.diagnostics.resources.map((diagnostic) => (
              <ListRow key={diagnostic.resourceId}>
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-fg">{diagnostic.summary}</p>
                  <p className="text-xs text-fg-muted">{diagnostic.pathSummary}</p>
                </div>
                <StatusChip tone={diagnostic.ready ? 'positive' : 'negative'}>
                  {diagnostic.ready ? 'Ready' : 'Unavailable'}
                </StatusChip>
              </ListRow>
            ))}
          </Card>
        )}
      </section>

      {selectedResource ? (
        <section className="flex flex-col gap-3" aria-labelledby="governed-push">
          <Eyebrow>
            <span id="governed-push">Governed push</span>
          </Eyebrow>
          <Card className="flex flex-col gap-4">
            <Select
              label="Repository"
              items={resourceItems.map((resource) => ({
                id: resource.resourceId,
                label: `${resource.displayName} — ${resource.resourceId}`,
              }))}
              selectedKey={selectedResourceId}
              isDisabled={Boolean(approvalCommand)}
              onSelectionChange={(key) => setResourceSelection(String(key))}
            />
            <div className="grid gap-3 sm:grid-cols-2">
              <TextField
                label="Thread ID"
                value={threadId}
                isDisabled={Boolean(approvalCommand)}
                onChange={setThreadId}
              />
              <TextField
                label="Turn ID"
                value={turnId}
                isDisabled={Boolean(approvalCommand)}
                onChange={setTurnId}
              />
              <TextField
                label="Source ref"
                value={sourceRef}
                isDisabled={Boolean(approvalCommand)}
                onChange={setSourceRef}
              />
              <TextField
                label="Target branch"
                value={targetBranch}
                isDisabled={Boolean(approvalCommand)}
                onChange={setTargetBranch}
              />
              <TextField
                className="sm:col-span-2"
                label="Commit IDs"
                description="Separate multiple commit IDs with spaces or new lines."
                value={commitIds}
                isDisabled={Boolean(approvalCommand)}
                onChange={setCommitIds}
              />
            </div>

            {commandErrorMessage ? (
              <ErrorBanner
                message={commandErrorMessage}
                onRetry={() => void retryAfterCommandError()}
              />
            ) : null}

            <div className="flex flex-wrap items-center gap-2">
              {approvalStatus ? (
                <StatusChip tone={approvalMatches ? approvalStatus.tone : 'negative'} dot>
                  {approvalMatches ? approvalStatus.label : 'Approval mismatch'}
                </StatusChip>
              ) : null}
              {!approvalCommand ? (
                <Button
                  size="sm"
                  isDisabled={writeBlocked || request.isPending || !requestReady}
                  onPress={() => void requestApproval()}
                >
                  Request approval
                </Button>
              ) : approval?.approval.status === 'pending' && !request.error ? (
                <Button
                  size="sm"
                  variant="outline"
                  isDisabled={writeBlocked || request.isPending}
                  onPress={() => void checkApproval()}
                >
                  Check approval
                </Button>
              ) : approval?.approval.status === 'granted' &&
                approvalMatches &&
                !execute.error &&
                !execute.isPending &&
                !approvalHasTerminalRecord &&
                !authoritativeRecord ? (
                <Button
                  size="sm"
                  isDisabled={writeBlocked}
                  onPress={() => void executeApprovedPush()}
                >
                  Execute push
                </Button>
              ) : null}
            </div>
          </Card>
        </section>
      ) : null}

      <section className="flex flex-col gap-3" aria-labelledby="push-records">
        <Eyebrow>
          <span id="push-records">Push records</span>
        </Eyebrow>
        {pushRecords.length === 0 ? (
          <EmptyState
            icon="repository"
            title="No push records"
            hint="Durable terminal push outcomes will appear here."
          />
        ) : (
          <Card className="py-0">
            {pushRecords.map((record) => {
              const outcome = PUSH_OUTCOME[record.outcome];
              return (
                <ListRow key={record.id}>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-bold text-fg-strong">{record.remoteSummary}</p>
                    <p className="text-xs text-fg-muted">
                      {record.sourceRef} to {record.targetBranch} · {record.commitIds.join(', ')}
                    </p>
                    {record.errorSummary ? (
                      <p className="text-xs text-negative-fg">{record.errorSummary}</p>
                    ) : null}
                  </div>
                  <StatusChip tone={outcome.tone} dot>
                    {outcome.label}
                  </StatusChip>
                </ListRow>
              );
            })}
          </Card>
        )}
      </section>
    </Page>
  );
}

/** Renders the selected-Workspace Repositories header and stale-state evidence. */
function RepositoriesHeader({
  workspaceName,
  stale = false,
}: {
  workspaceName?: string;
  stale?: boolean;
}) {
  return (
    <PageHeader
      eyebrow="Workspace"
      title="Repositories"
      subtitle="Repository readiness and separately approved Git push outcomes."
      actions={
        workspaceName ? (
          <>
            <ContextChip>{workspaceName}</ContextChip>
            {stale ? <StatusChip tone="notice">Status may be stale</StatusChip> : null}
          </>
        ) : null
      }
    />
  );
}
