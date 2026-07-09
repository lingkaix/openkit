import { cleanup, render, screen } from '@solidjs/testing-library';
import { afterEach, describe, expect, it } from 'vitest';

import type {
  Thread,
  Workspace,
  WorkspaceDashboard as WorkspaceDashboardModel,
} from '../lib/app-types';
import { WorkspaceDashboard } from './WorkspaceDashboard';

const workspace: Workspace = {
  id: 'ws_demo',
  name: 'Demo Workspace',
  kind: 'code',
  status: 'active',
  defaults: {
    defaultModelId: 'model_gpt_5_4',
    defaultAgentId: 'agent_planner',
    defaultSkillIds: ['skill_protocol'],
  },
  counts: {
    threadCount: 2,
    artifactCount: 1,
    knowledgeEntryCount: 3,
  },
  createdAt: '2026-04-15T09:00:00.000Z',
  updatedAt: '2026-04-15T09:00:00.000Z',
};

const recentThread: Thread = {
  id: 'th_demo',
  workspaceId: workspace.id,
  name: 'Protocol design review',
  preview: 'Review protocol updates.',
  status: 'active',
  createdAt: '2026-04-15T09:00:00.000Z',
  updatedAt: '2026-04-15T09:30:00.000Z',
};

const dashboard: WorkspaceDashboardModel = {
  workspace,
  counts: {
    threadCount: 2,
    artifactCount: 1,
    knowledgeEntryCount: 3,
    providerCount: 4,
  },
  defaultContext: {
    modelId: 'model_gpt_5_4',
    agentId: 'agent_planner',
    skillIds: ['skill_protocol'],
  },
  agentHealth: [
    {
      agentId: 'agent_planner',
      status: 'ready',
      message: null,
      checkedAt: '2026-04-15T09:00:00.000Z',
    },
  ],
  recentThreads: [recentThread],
  activeWork: [
    {
      threadId: 'th_active',
      title: 'Ship v0.0.5',
      status: 'running',
      mode: 'automation',
      agentId: 'agent_codex_host',
      summary: 'Worker is validating the release branch.',
      updatedAt: '2026-04-15T09:40:00.000Z',
    },
  ],
  recentCompletions: [
    {
      threadId: 'th_complete',
      title: 'Review core docs',
      turnId: 'tu_complete',
      completedAt: '2026-04-15T09:35:00.000Z',
      artifactCount: 1,
      summary: 'Core docs review finished.',
    },
  ],
  attentionNeeded: [
    {
      threadId: 'th_attention',
      title: 'Approve worker edit',
      turnId: 'tu_attention',
      kind: 'approval',
      itemId: 'it_attention',
      summary: 'Approve file edit',
      updatedAt: '2026-04-15T09:32:00.000Z',
    },
  ],
};

afterEach(() => {
  cleanup();
});

describe('WorkspaceDashboard', () => {
  it('renders counts, default context, agent health, and recent threads', () => {
    render(() => <WorkspaceDashboard dashboard={dashboard} workspace={workspace} />);

    expect(screen.getByRole('heading', { name: /demo workspace dashboard/i })).toBeInTheDocument();
    expect(screen.getByText(/2 threads/i)).toBeInTheDocument();
    expect(screen.getAllByText(/1 artifact/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/3 knowledge/i)).toBeInTheDocument();
    expect(screen.getByText(/4 providers/i)).toBeInTheDocument();
    expect(screen.getByText(/model_gpt_5_4/i)).toBeInTheDocument();
    expect(screen.getAllByText(/agent_planner/i)).toHaveLength(2);
    expect(screen.getByText(/ready/i)).toBeInTheDocument();
    expect(screen.getByText(/protocol design review/i)).toBeInTheDocument();
  });

  it('renders active work, recent completions, and attention-needed items', () => {
    render(() => <WorkspaceDashboard dashboard={dashboard} workspace={workspace} />);

    expect(screen.getByRole('heading', { name: /active work/i })).toBeInTheDocument();
    expect(screen.getByText(/ship v0\.0\.5/i)).toBeInTheDocument();
    expect(screen.getByText(/agent_codex_host/i)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /recent completions/i })).toBeInTheDocument();
    expect(screen.getByText(/review core docs/i)).toBeInTheDocument();
    expect(screen.getAllByText(/1 artifact/i).length).toBeGreaterThan(0);
    expect(screen.getByRole('heading', { name: /attention needed/i })).toBeInTheDocument();
    expect(screen.getByText(/approve file edit/i)).toBeInTheDocument();
  });

  it('renders empty states for zero resources', () => {
    render(() => (
      <WorkspaceDashboard
        dashboard={{
          ...dashboard,
          counts: {
            threadCount: 0,
            artifactCount: 0,
            knowledgeEntryCount: 0,
            providerCount: 0,
          },
          defaultContext: {
            modelId: null,
            agentId: null,
            skillIds: [],
          },
          agentHealth: [],
          recentThreads: [],
          activeWork: [],
          recentCompletions: [],
          attentionNeeded: [],
        }}
        workspace={{
          ...workspace,
          counts: { threadCount: 0, artifactCount: 0, knowledgeEntryCount: 0 },
        }}
      />
    ));

    expect(screen.getByText(/no recent threads/i)).toBeInTheDocument();
    expect(screen.getByText(/no threads yet/i)).toBeInTheDocument();
    expect(screen.getByText(/no artifacts yet/i)).toBeInTheDocument();
    expect(screen.getByText(/no knowledge entries yet/i)).toBeInTheDocument();
    expect(screen.getByText(/no agents configured/i)).toBeInTheDocument();
    expect(screen.getByText(/no default model/i)).toBeInTheDocument();
  });
});
