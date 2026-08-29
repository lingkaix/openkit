import { useState } from 'react';
import { useConnection } from '../../app/core-client';
import {
  Avatar,
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  Page,
  PageHeader,
  Skeleton,
  StatusChip,
} from '../../primitives';
import {
  type AgentEntry,
  agentHue,
  agentInitials,
  agentLane,
  readinessLabel,
  useAgent,
  useAgents,
  useCurrentWorkspaceId,
  useRefreshAgentHealth,
  useWorkspaces,
} from './data';

/**
 * Agents roster (WP-6, board 08).
 *
 * Plain-language readiness first (Ready / Working / Needs attention). Technical
 * diagnostics sit behind a "View details" disclosure (DESIGN.md §13) and are
 * replaced only after `client.agents.get` succeeds for that exact id. Health
 * refresh uses one Workspace identity, consumes the `{items}` response, then
 * invalidates the catalog list and each exact returned agent detail.
 * Empty when no agents are configured; readiness is marked stale when disconnected.
 */
export function AgentsScreen() {
  const workspaceId = useCurrentWorkspaceId();
  const workspaces = useWorkspaces();
  const agents = useAgents();
  const refresh = useRefreshAgentHealth();
  const { checking, failed: disconnected } = useConnection();
  const refreshBlocked =
    checking || disconnected || !workspaceId || refresh.isPending || agents.isFetching;
  const failedRefreshWorkspaceId = refresh.isError ? refresh.variables : undefined;

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
            <Button size="sm" isDisabled={refreshBlocked} onPress={() => void refreshHealth()}>
              Refresh health
            </Button>
            {disconnected ? <StatusChip tone="notice">Readiness may be stale</StatusChip> : null}
          </>
        }
      />

      {failedRefreshWorkspaceId && failedRefreshWorkspaceId === workspaceId ? (
        <fieldset disabled={refreshBlocked} className="contents">
          <ErrorBanner
            message="Couldn't refresh agent health."
            onRetry={() => void refreshHealth(failedRefreshWorkspaceId)}
          />
        </fieldset>
      ) : null}

      {agents.isLoading || workspaces.isLoading ? (
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
            <AgentCard key={agent.id} agent={agent} hueIndex={index} />
          ))}
        </div>
      )}
    </Page>
  );
}

function AgentCard({ agent, hueIndex }: { agent: AgentEntry; hueIndex: number }) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detail = useAgent(agent.id, detailsOpen);
  const shown = detail.isSuccess ? detail.data : agent;
  const readiness = readinessLabel(agent);
  return (
    <Card>
      <div className="flex items-start gap-3">
        <Avatar hue={agentHue(hueIndex)} initials={agentInitials(agent.name)} name={agent.name} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-bold text-fg-strong">{agent.name}</p>
            <StatusChip tone={readiness.tone} dot>
              {readiness.label}
            </StatusChip>
          </div>
          <p className="mt-0.5 text-xs text-fg-muted">{agentLane(agent.kind)}</p>
          <p className="mt-2 text-sm text-fg">
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
            <div className="flex gap-2">
              <dt className="font-bold text-fg">Health</dt>
              <dd>
                {shown.health.status}
                {shown.health.message ? ` — ${shown.health.message}` : ''}
              </dd>
            </div>
            <div className="flex gap-2">
              <dt className="font-bold text-fg">Model</dt>
              <dd>{shown.modelId ?? 'None'}</dd>
            </div>
            {shown.capabilities.length > 0 ? (
              <div className="flex gap-2">
                <dt className="font-bold text-fg">Capabilities</dt>
                <dd>{shown.capabilities.map((cap) => cap.label).join(', ')}</dd>
              </div>
            ) : null}
            {shown.sandboxSummary?.summary ? (
              <div className="flex gap-2">
                <dt className="font-bold text-fg">Sandbox</dt>
                <dd>{shown.sandboxSummary.summary}</dd>
              </div>
            ) : null}
            {shown.health.checkedAt ? (
              <div className="flex gap-2">
                <dt className="font-bold text-fg">Checked</dt>
                <dd>{new Date(shown.health.checkedAt).toLocaleString()}</dd>
              </div>
            ) : null}
          </dl>
        )}
      </details>
    </Card>
  );
}
