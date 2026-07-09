import { For, Show } from 'solid-js';

import type { Workspace, WorkspaceDashboard as WorkspaceDashboardModel } from '../lib/app-types';

/**
 * Props for the workspace dashboard read model component.
 */
export interface WorkspaceDashboardProps {
  dashboard: WorkspaceDashboardModel | null;
  workspace: Workspace | null;
}

/**
 * Renders the workspace dashboard read model returned by nanocore.
 */
export function WorkspaceDashboard(props: WorkspaceDashboardProps) {
  const workspace = () => props.dashboard?.workspace ?? props.workspace;
  const counts = () =>
    props.dashboard?.counts ?? {
      threadCount: props.workspace?.counts.threadCount ?? 0,
      artifactCount: props.workspace?.counts.artifactCount ?? 0,
      knowledgeEntryCount: props.workspace?.counts.knowledgeEntryCount ?? 0,
      providerCount: 0,
    };
  const defaultContext = () =>
    props.dashboard?.defaultContext ?? {
      modelId: props.workspace?.defaults?.defaultModelId ?? null,
      agentId: props.workspace?.defaults?.defaultAgentId ?? null,
      skillIds: props.workspace?.defaults?.defaultSkillIds ?? [],
    };
  const agentHealth = () => props.dashboard?.agentHealth ?? [];
  const recentThreads = () => props.dashboard?.recentThreads ?? [];
  const activeWork = () => props.dashboard?.activeWork ?? [];
  const recentCompletions = () => props.dashboard?.recentCompletions ?? [];
  const attentionNeeded = () => props.dashboard?.attentionNeeded ?? [];

  return (
    <section class="workspace-panel" aria-label="Workspace dashboard">
      <div class="main-panel-head main-panel-head-stacked">
        <div class="space-y-2">
          <p class="eyebrow">Workspace</p>
          <h2 class="font-display text-2xl font-semibold text-base-content">
            {workspace()?.name ?? 'Workspace'} Dashboard
          </h2>
          <p class="max-w-2xl text-sm leading-7 opacity-70">
            {workspace()?.status ?? 'loading'} workspace with protocol-owned threads, artifacts,
            knowledge, agents, and default execution preferences.
          </p>
        </div>
      </div>
      <div class="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <div class="metric-tile">
          <span class="metric-label">Threads</span>
          <span class="metric-value">{counts().threadCount} threads</span>
        </div>
        <div class="metric-tile">
          <span class="metric-label">Artifacts</span>
          <span class="metric-value">
            {counts().artifactCount} {counts().artifactCount === 1 ? 'artifact' : 'artifacts'}
          </span>
        </div>
        <div class="metric-tile">
          <span class="metric-label">Knowledge</span>
          <span class="metric-value">{counts().knowledgeEntryCount} knowledge</span>
        </div>
        <div class="metric-tile">
          <span class="metric-label">Providers</span>
          <span class="metric-value">{counts().providerCount} providers</span>
        </div>
      </div>
      <div class="mt-4 grid gap-3 xl:grid-cols-3">
        <section class="metric-tile" aria-label="Active work">
          <div class="ui-section-header mb-2">
            <h3 class="font-display text-lg font-semibold text-base-content">Active work</h3>
            <span class="badge badge-outline">{activeWork().length}</span>
          </div>
          <Show when={activeWork().length > 0} fallback={<span>No active work</span>}>
            <For each={activeWork()}>
              {(work) => (
                <div class="space-y-1 text-sm">
                  <div class="flex flex-wrap items-center gap-2">
                    <span class="font-semibold">{work.title}</span>
                    <span class="badge badge-outline badge-sm">{work.status}</span>
                  </div>
                  <p class="opacity-70">{work.summary ?? work.mode}</p>
                  <span class="text-xs opacity-60">{work.agentId ?? 'No agent selected'}</span>
                </div>
              )}
            </For>
          </Show>
        </section>
        <section class="metric-tile" aria-label="Recent completions">
          <div class="ui-section-header mb-2">
            <h3 class="font-display text-lg font-semibold text-base-content">Recent completions</h3>
            <span class="badge badge-outline">{recentCompletions().length}</span>
          </div>
          <Show when={recentCompletions().length > 0} fallback={<span>No completed work yet</span>}>
            <For each={recentCompletions()}>
              {(completion) => (
                <div class="space-y-1 text-sm">
                  <div class="flex flex-wrap items-center gap-2">
                    <span class="font-semibold">{completion.title}</span>
                    <span class="badge badge-outline badge-sm">
                      {completion.artifactCount}{' '}
                      {completion.artifactCount === 1 ? 'artifact' : 'artifacts'}
                    </span>
                  </div>
                  <p class="opacity-70">{completion.summary ?? completion.turnId}</p>
                </div>
              )}
            </For>
          </Show>
        </section>
        <section class="metric-tile" aria-label="Attention needed">
          <div class="ui-section-header mb-2">
            <h3 class="font-display text-lg font-semibold text-base-content">Attention needed</h3>
            <span class="badge badge-outline">{attentionNeeded().length}</span>
          </div>
          <Show when={attentionNeeded().length > 0} fallback={<span>No attention needed</span>}>
            <For each={attentionNeeded()}>
              {(attention) => (
                <div class="space-y-1 text-sm">
                  <div class="flex flex-wrap items-center gap-2">
                    <span class="font-semibold">{attention.title}</span>
                    <span class="badge badge-warning badge-sm">{attention.kind}</span>
                  </div>
                  <p class="opacity-70">{attention.summary}</p>
                </div>
              )}
            </For>
          </Show>
        </section>
      </div>
      <div class="mt-4 grid gap-3 lg:grid-cols-3">
        <section class="metric-tile" aria-label="Default context">
          <span class="metric-label">Default context</span>
          <span class="metric-value">{defaultContext().modelId ?? 'No default model'}</span>
          <span class="text-sm opacity-70">{defaultContext().agentId ?? 'No default agent'}</span>
          <Show when={defaultContext().skillIds.length > 0}>
            <span class="text-sm opacity-70">{defaultContext().skillIds.join(', ')}</span>
          </Show>
        </section>
        <section class="metric-tile" aria-label="Agent health">
          <span class="metric-label">Agent health</span>
          <Show when={agentHealth().length > 0} fallback={<span>No agents configured</span>}>
            <For each={agentHealth()}>
              {(agent) => (
                <span class="text-sm">
                  {agent.agentId}: {agent.status}
                </span>
              )}
            </For>
          </Show>
        </section>
        <section class="metric-tile" aria-label="Recent threads">
          <span class="metric-label">Recent threads</span>
          <Show when={recentThreads().length > 0} fallback={<span>No recent threads</span>}>
            <For each={recentThreads()}>
              {(thread) => <span class="text-sm">{thread.name ?? thread.preview}</span>}
            </For>
          </Show>
        </section>
      </div>
      <div class="mt-4 grid gap-3 md:grid-cols-2">
        <Show when={counts().threadCount === 0}>
          <div class="empty-state">No threads yet for this workspace.</div>
        </Show>
        <Show when={counts().artifactCount === 0}>
          <div class="empty-state">No artifacts yet for this workspace.</div>
        </Show>
        <Show when={counts().knowledgeEntryCount === 0}>
          <div class="empty-state">No knowledge entries yet for this workspace.</div>
        </Show>
      </div>
    </section>
  );
}
