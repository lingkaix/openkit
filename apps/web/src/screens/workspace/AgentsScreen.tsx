import { useConnection } from '../../app/core-client';
import {
  Avatar,
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
  useAgents,
} from './data';

/**
 * Agents roster (WP-6, board 08).
 *
 * Plain-language readiness first (Ready / Working / Needs attention). Technical
 * diagnostics sit behind a "View details" disclosure (DESIGN.md §13). Empty when
 * no agents are configured; readiness is marked stale when disconnected.
 */
export function AgentsScreen() {
  const agents = useAgents();
  const { failed: disconnected } = useConnection();

  return (
    <Page>
      <PageHeader
        title="Agents"
        subtitle="Your team of workers — who they are and what they're doing."
        actions={
          disconnected ? <StatusChip tone="notice">Readiness may be stale</StatusChip> : null
        }
      />

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
            <AgentCard key={agent.id} agent={agent} hueIndex={index} />
          ))}
        </div>
      )}
    </Page>
  );
}

function AgentCard({ agent, hueIndex }: { agent: AgentEntry; hueIndex: number }) {
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
            {readiness.label === 'Working'
              ? (agent.health.message ?? 'In progress')
              : readiness.label === 'Ready'
                ? '—'
                : (agent.health.message ?? readiness.label)}
          </p>
        </div>
      </div>

      <details className="mt-3">
        <summary className="cursor-pointer text-xs font-bold text-accent outline-none focus-visible:ring-2 focus-visible:ring-focus">
          View details
        </summary>
        <dl className="mt-2 space-y-1 text-xs text-fg-muted">
          <div className="flex gap-2">
            <dt className="font-bold text-fg">Health</dt>
            <dd>
              {agent.health.status}
              {agent.health.message ? ` — ${agent.health.message}` : ''}
            </dd>
          </div>
          <div className="flex gap-2">
            <dt className="font-bold text-fg">Model</dt>
            <dd>{agent.modelId ?? 'None'}</dd>
          </div>
          {agent.capabilities.length > 0 ? (
            <div className="flex gap-2">
              <dt className="font-bold text-fg">Capabilities</dt>
              <dd>{agent.capabilities.map((cap) => cap.label).join(', ')}</dd>
            </div>
          ) : null}
          {agent.sandboxSummary?.summary ? (
            <div className="flex gap-2">
              <dt className="font-bold text-fg">Sandbox</dt>
              <dd>{agent.sandboxSummary.summary}</dd>
            </div>
          ) : null}
          {agent.health.checkedAt ? (
            <div className="flex gap-2">
              <dt className="font-bold text-fg">Checked</dt>
              <dd>{new Date(agent.health.checkedAt).toLocaleString()}</dd>
            </div>
          ) : null}
        </dl>
      </details>
    </Card>
  );
}
