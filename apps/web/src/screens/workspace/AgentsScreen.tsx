import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useConnection } from '../../app/core-client';
import {
  Avatar,
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  Eyebrow,
  Page,
  PageHeader,
  Skeleton,
  StatusChip,
  type StatusChipProps,
} from '../../primitives';
import {
  type AgentEntry,
  agentHue,
  agentInitials,
  agentLane,
  readinessLabel,
  taskThreadPath,
  useAgent,
  useAgents,
  useCurrentWorkspaceId,
  useRefreshAgentHealth,
  useWorkspaces,
  useWorkspaceWorkers,
  type WorkspaceWorkerRow,
} from './data';

/**
 * Agents surface (WP-6, board 08).
 *
 * Current Workers come from `client.app.listWorkspaceWorkers` for the selected
 * Workspace and sit above the configured catalog. Catalog health refresh stays
 * on `client.agents.refreshHealth` and does not refill a failed Worker read.
 * Worker rows use the server Thread key, recorded status, Last recorded
 * timestamp, exact known Goal/Task assignment, and the existing Task
 * conversation route. Package
 * preference, last-used model, MCP policy, and bounded policy counts stay behind
 * native details. Empty Worker success is only an empty `items` list for a
 * selected Workspace. An absent selection is not an empty inventory.
 */
export function AgentsScreen() {
  const workspaceId = useCurrentWorkspaceId();
  const workspaces = useWorkspaces();
  const agents = useAgents(workspaceId);
  const workers = useWorkspaceWorkers(workspaceId);
  const refresh = useRefreshAgentHealth();
  const { checking, failed: disconnected } = useConnection();
  const healthRefreshBlocked =
    checking || disconnected || !workspaceId || refresh.isPending || agents.isFetching;
  const workersRefreshBlocked = checking || disconnected || !workspaceId || workers.isFetching;
  const failedRefreshWorkspaceId = refresh.isError ? refresh.variables : undefined;

  /** Refetches the selected Workspace Worker read without touching catalog health. */
  function refreshWorkers() {
    if (!workspaceId || checking || disconnected || workers.isFetching) {
      return;
    }
    void workers.refetch();
  }

  /** Refreshes one Workspace health identity; retry keeps that originating Workspace. */
  async function refreshHealth(commandWorkspaceId = workspaceId) {
    if (!commandWorkspaceId || checking || disconnected || refresh.isPending || agents.isFetching) {
      return;
    }
    try {
      await refresh.mutateAsync(commandWorkspaceId);
    } catch {
      // TanStack Query retains the typed error for an explicit retry.
    }
  }

  return (
    <Page>
      <PageHeader
        title="Agents"
        subtitle="Your team of workers — who they are and what they're doing."
        actions={
          <>
            <Button size="sm" isDisabled={workersRefreshBlocked} onPress={refreshWorkers}>
              Refresh workers
            </Button>
            <Button
              size="sm"
              isDisabled={healthRefreshBlocked}
              onPress={() => void refreshHealth()}
            >
              Refresh health
            </Button>
            {disconnected ? <StatusChip tone="notice">Worker read may be stale</StatusChip> : null}
            {disconnected ? <StatusChip tone="notice">Readiness may be stale</StatusChip> : null}
          </>
        }
      />

      {failedRefreshWorkspaceId && failedRefreshWorkspaceId === workspaceId ? (
        <fieldset disabled={healthRefreshBlocked} className="contents">
          <ErrorBanner
            message="Couldn't refresh agent health."
            onRetry={() => void refreshHealth(failedRefreshWorkspaceId)}
          />
        </fieldset>
      ) : null}

      {workspaces.isLoading ? (
        <Skeleton lines={5} />
      ) : (
        <>
          <section className="flex flex-col gap-3" aria-label="Workers">
            <Eyebrow>Workers</Eyebrow>
            {workspaceId == null ? (
              <p className="text-sm text-fg-muted">Select a Workspace to see current workers.</p>
            ) : workers.isLoading ? (
              <Skeleton lines={3} />
            ) : workers.isError ? (
              <fieldset disabled={workersRefreshBlocked} className="contents">
                <ErrorBanner
                  message="Couldn't load workers."
                  onRetry={() => void workers.refetch()}
                />
              </fieldset>
            ) : (workers.data?.items.length ?? 0) === 0 ? (
              <p className="text-sm text-fg-muted">No current workers</p>
            ) : (
              <div className="flex flex-col gap-3">
                {workers.data?.items.map((worker, index) => (
                  <WorkerCard
                    key={worker.threadId}
                    hueIndex={index}
                    worker={worker}
                    workspaceId={workspaceId}
                  />
                ))}
              </div>
            )}
          </section>

          <section className="flex flex-col gap-3" aria-label="Configured agents">
            <Eyebrow>Configured agents</Eyebrow>
            {agents.isLoading ? (
              <Skeleton lines={5} />
            ) : agents.isError ? (
              <ErrorBanner message="Couldn't load agents." onRetry={() => void agents.refetch()} />
            ) : (agents.data?.length ?? 0) === 0 ? (
              <EmptyState
                icon="agents"
                title="No agents yet"
                hint="When agents are configured for this runtime, they will show up here."
              />
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                {agents.data?.map((agent, index) => (
                  <AgentCard
                    key={agent.id}
                    agent={agent}
                    hueIndex={index}
                    workspaceId={workspaceId}
                  />
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </Page>
  );
}

/** Displays recorded Worker state and progressively disclosed package details for one Thread. */
function WorkerCard({
  hueIndex,
  worker,
  workspaceId,
}: {
  hueIndex: number;
  worker: WorkspaceWorkerRow;
  workspaceId: string | null;
}) {
  const conversationHref = workspaceId ? taskThreadPath(workspaceId, worker.threadId) : null;
  return (
    <Card>
      <div className="flex min-w-0 items-start gap-3">
        <Avatar
          hue={agentHue(hueIndex)}
          initials={agentInitials(worker.agentName)}
          name={worker.agentName}
        />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <p className="min-w-0 break-words text-sm font-bold text-fg-strong">
              {worker.agentName}
            </p>
            <StatusChip tone={workerStatusTone(worker.status)} dot>
              {capitalizeStatus(worker.status)}
            </StatusChip>
            {worker.stale ? <StatusChip tone="notice">Setup outdated</StatusChip> : null}
          </div>
          <p className="mt-0.5 min-w-0 break-words text-xs text-fg-muted">{worker.threadTitle}</p>
          <p className="mt-2 min-w-0 break-words text-sm text-fg">{workAssignmentLabel(worker)}</p>
          <p className="mt-1 text-xs text-fg-muted">
            Last recorded{' '}
            <time dateTime={worker.recordUpdatedAt} title={worker.recordUpdatedAt}>
              {new Date(worker.recordUpdatedAt).toLocaleString(undefined, {
                timeZoneName: 'short',
              })}
            </time>
          </p>
          {conversationHref ? (
            <Link
              to={conversationHref}
              aria-label={`Open conversation ${worker.threadTitle}`}
              className="mt-2 inline-flex h-7 max-w-full items-center rounded-full border border-border bg-card px-3 text-xs font-bold text-fg outline-none hover:bg-sunken focus-visible:ring-2 focus-visible:ring-focus"
            >
              Open conversation
            </Link>
          ) : null}
        </div>
      </div>

      <details className="mt-3">
        <summary className="cursor-pointer text-xs font-bold text-accent outline-none focus-visible:ring-2 focus-visible:ring-focus">
          View details
        </summary>
        <dl className="mt-2 space-y-2 text-xs text-fg-muted">
          <div className="flex min-w-0 flex-col gap-0.5 sm:flex-row sm:gap-2">
            <dt className="shrink-0 font-bold text-fg">Package preference</dt>
            <dd className="min-w-0 break-words">{packagePreferenceLabel(worker)}</dd>
          </div>
          <div className="flex min-w-0 flex-col gap-0.5 sm:flex-row sm:gap-2">
            <dt className="shrink-0 font-bold text-fg">Last-used model</dt>
            <dd className="min-w-0 break-words">{lastUsedModelLabel(worker)}</dd>
          </div>
        </dl>
        <details className="mt-2">
          <summary className="cursor-pointer text-xs font-bold text-accent outline-none focus-visible:ring-2 focus-visible:ring-focus">
            MCP and tool policy
          </summary>
          <div className="mt-2 min-w-0 text-xs text-fg-muted">{mcpPolicySummary(worker)}</div>
        </details>
        <details className="mt-2">
          <summary className="cursor-pointer text-xs font-bold text-accent outline-none focus-visible:ring-2 focus-visible:ring-focus">
            Policy summary
          </summary>
          <div className="mt-2 min-w-0 text-xs text-fg-muted">{policySummary(worker)}</div>
        </details>
      </details>
    </Card>
  );
}

function AgentCard({
  agent,
  hueIndex,
  workspaceId,
}: {
  agent: AgentEntry;
  hueIndex: number;
  workspaceId: string | null;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detail = useAgent(workspaceId, agent.id, detailsOpen);
  const shown = detail.isSuccess ? detail.data : agent;
  const readiness = readinessLabel(agent);
  return (
    <Card>
      <div className="flex min-w-0 items-start gap-3">
        <Avatar hue={agentHue(hueIndex)} initials={agentInitials(agent.name)} name={agent.name} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <p className="min-w-0 break-words text-sm font-bold text-fg-strong">{agent.name}</p>
            <StatusChip tone={readiness.tone} dot>
              {readiness.label}
            </StatusChip>
          </div>
          <p className="mt-0.5 min-w-0 break-words text-xs text-fg-muted">
            {agentLane(agent.kind)}
          </p>
          <p className="mt-2 min-w-0 break-words text-sm text-fg">
            {agent.health.message ??
              (readiness.label === 'Working'
                ? 'In progress'
                : readiness.label === 'Ready'
                  ? '—'
                  : readiness.label)}
          </p>
        </div>
      </div>

      <details
        className="mt-3"
        onToggle={(event) => {
          setDetailsOpen(event.currentTarget.open);
        }}
      >
        <summary className="cursor-pointer text-xs font-bold text-accent outline-none focus-visible:ring-2 focus-visible:ring-focus">
          View details
        </summary>
        {detailsOpen && detail.isError ? (
          <div className="mt-2">
            <ErrorBanner
              message="Couldn't load agent details."
              onRetry={() => void detail.refetch()}
            />
          </div>
        ) : (
          <dl className="mt-2 space-y-1 text-xs text-fg-muted">
            <div className="flex min-w-0 gap-2">
              <dt className="shrink-0 font-bold text-fg">Health</dt>
              <dd className="min-w-0 break-words">
                {shown.health.status}
                {shown.health.message ? ` — ${shown.health.message}` : ''}
              </dd>
            </div>
            <div className="flex min-w-0 gap-2">
              <dt className="font-bold text-fg">Model</dt>
              <dd className="min-w-0 break-words">{shown.modelId ?? 'None'}</dd>
            </div>
            {shown.capabilities.length > 0 ? (
              <div className="flex min-w-0 gap-2">
                <dt className="font-bold text-fg">Capabilities</dt>
                <dd className="min-w-0 break-words">
                  {shown.capabilities.map((cap) => cap.label).join(', ')}
                </dd>
              </div>
            ) : null}
            {shown.sandboxSummary?.summary ? (
              <div className="flex min-w-0 gap-2">
                <dt className="font-bold text-fg">Sandbox</dt>
                <dd className="min-w-0 break-words">{shown.sandboxSummary.summary}</dd>
              </div>
            ) : null}
            {shown.health.checkedAt ? (
              <div className="flex min-w-0 gap-2">
                <dt className="font-bold text-fg">Checked</dt>
                <dd className="min-w-0 break-words">
                  {new Date(shown.health.checkedAt).toLocaleString()}
                </dd>
              </div>
            ) : null}
          </dl>
        )}
      </details>
    </Card>
  );
}

/** Maps a recorded Worker status onto the existing chip tone vocabulary. */
function workerStatusTone(status: WorkspaceWorkerRow['status']): StatusChipProps['tone'] {
  switch (status) {
    case 'busy':
    case 'created':
    case 'initializing':
      return 'informative';
    case 'ready':
      return 'positive';
    case 'degraded':
    case 'suspended':
      return 'notice';
    default:
      return 'neutral';
  }
}

/** Capitalizes the recorded Worker status for ordinary display. */
function capitalizeStatus(status: WorkspaceWorkerRow['status']): string {
  return `${status.slice(0, 1).toUpperCase()}${status.slice(1)}`;
}

/** Renders the exact known current assignment without inferring later Goal state. */
function workAssignmentLabel(worker: WorkspaceWorkerRow): string {
  if (worker.work.kind === 'none') {
    return 'No current assignment';
  }
  if (worker.work.kind === 'unavailable') {
    return 'Current assignment unavailable';
  }
  if (worker.work.kind === 'task') {
    return 'Task';
  }
  return `Goal ${worker.work.goalId} · Task ${worker.work.taskId}`;
}

/** Renders the package preferred logical model, or an explicit unavailable label. */
function packagePreferenceLabel(worker: WorkspaceWorkerRow): string {
  return worker.packageDetails.kind === 'available'
    ? worker.packageDetails.preferredLogicalModelId
    : 'Unavailable';
}

/** Renders last-used model identity, Restricted, or Unavailable from the Worker row. */
function lastUsedModelLabel(worker: WorkspaceWorkerRow): string {
  if (worker.lastUsedModel.kind === 'restricted') {
    return 'Restricted';
  }
  if (worker.lastUsedModel.kind === 'unavailable') {
    return 'Unavailable';
  }
  return `${worker.lastUsedModel.modelId} · ${new Date(worker.lastUsedModel.recordedAt).toLocaleString(undefined, { timeZoneName: 'short' })}`;
}

/** Renders package-selected MCP ids and tool names, or an explicit unavailable label. */
function mcpPolicySummary(worker: WorkspaceWorkerRow) {
  if (worker.packageDetails.kind !== 'available') {
    return <p>Unavailable</p>;
  }
  if (worker.packageDetails.mcpServers.length === 0) {
    return <p>No selected MCP servers</p>;
  }
  return (
    <ul className="space-y-2">
      {worker.packageDetails.mcpServers.map((server) => (
        <li key={server.id} className="min-w-0 break-words">
          <p className="font-bold text-fg">{server.id}</p>
          <p>Allowed: {namedList(server.allowedTools)}</p>
          <p>Denied: {namedList(server.deniedTools)}</p>
          <p>Approval required: {namedList(server.approvalRequiredTools)}</p>
        </li>
      ))}
    </ul>
  );
}

/** Renders allowlisted filesystem, network, and process policy counts. */
function policySummary(worker: WorkspaceWorkerRow) {
  if (worker.packageDetails.kind !== 'available') {
    return <p>Unavailable</p>;
  }
  const details = worker.packageDetails;
  return (
    <ul className="space-y-1">
      <li className="min-w-0 break-words">
        {policyDimensionLabel('Filesystem', details.filesystem)}
      </li>
      <li className="min-w-0 break-words">{policyDimensionLabel('Network', details.network)}</li>
      <li className="min-w-0 break-words">{policyDimensionLabel('Process', details.process)}</li>
    </ul>
  );
}

/** Formats one allowlisted policy dimension; null is Not recorded, unknown labels are Not reported. */
function policyDimensionLabel(
  name: string,
  dimension: Extract<WorkspaceWorkerRow['packageDetails'], { kind: 'available' }>['filesystem']
): string {
  if (!dimension) {
    return `${name}: Not recorded`;
  }
  const defaultLabel = dimension.default ?? 'Not reported';
  const enforcement = dimension.enforcement ?? 'Not reported';
  const rules = `${dimension.ruleCount} ${dimension.ruleCount === 1 ? 'rule' : 'rules'}`;
  return `${name}: default ${defaultLabel}, enforcement ${enforcement}, ${rules}`;
}

/** Joins tool names, or None when the allowlist is empty. */
function namedList(names: string[]): string {
  return names.length > 0 ? names.join(', ') : 'None';
}
