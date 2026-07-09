import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library';
import { afterEach, describe, expect, it } from 'vitest';

import type { Thread, WorkspaceSummary } from '../lib/app-types';
import { ThreadList } from './ThreadList';

const workspace: WorkspaceSummary = {
  id: 'ws_demo',
  name: 'Demo Workspace',
  kind: 'code',
  status: 'active',
  defaults: {
    defaultModelId: 'model_codex',
    defaultAgentId: 'agent_codex_host',
    defaultSkillIds: [],
  },
  counts: {
    threadCount: 1,
    artifactCount: 0,
    knowledgeEntryCount: 0,
  },
  createdAt: '2026-04-15T09:00:00.000Z',
  updatedAt: '2026-04-15T09:00:00.000Z',
};

const thread: Thread = {
  id: 'th_demo',
  workspaceId: workspace.id,
  name: 'Protocol design review',
  preview: 'Review the UI-first workspace protocol slice.',
  status: 'active',
  createdAt: '2026-04-15T09:00:00.000Z',
  updatedAt: '2026-04-15T09:30:00.000Z',
};

afterEach(() => {
  cleanup();
});

describe('ThreadList', () => {
  it('renders a collapsible workspace thread list', () => {
    let openedThreadId: string | null = null;

    render(() => (
      <ThreadList
        collapsed={false}
        isCreating={false}
        selectedWorkspaceId={workspace.id}
        selectedThreadId={thread.id}
        showCreateForm={true}
        threads={[thread]}
        workspace={workspace}
        onCreateThread={async () => undefined}
        onOpenThread={(threadId) => {
          openedThreadId = threadId;
        }}
        onOpenWorkspace={() => undefined}
        onToggle={() => undefined}
      />
    ));

    expect(screen.getByRole('navigation', { name: /threads in demo workspace/i })).toBeVisible();
    expect(screen.getByRole('button', { name: /protocol design review/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /protocol design review/i }));

    expect(openedThreadId).toBe(thread.id);
  });

  it('creates a thread and lets the app navigate to it', async () => {
    let navigatedPath = '';

    render(() => (
      <ThreadList
        collapsed={false}
        isCreating={false}
        selectedWorkspaceId={workspace.id}
        selectedThreadId={null}
        showCreateForm={true}
        threads={[]}
        workspace={{ ...workspace, counts: { ...workspace.counts, threadCount: 0 } }}
        onCreateThread={async (workspaceId, title) => {
          navigatedPath = `/workspaces/${workspaceId}/threads/th_created`;
          expect(title).toBe('New planning thread');
        }}
        onOpenThread={() => undefined}
        onOpenWorkspace={() => undefined}
        onToggle={() => undefined}
      />
    ));

    fireEvent.input(screen.getByLabelText(/new thread for demo workspace/i), {
      target: { value: 'New planning thread' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^new thread$/i }));

    expect(await screen.findByText(/no threads yet/i)).toBeInTheDocument();
    expect(navigatedPath).toBe('/workspaces/ws_demo/threads/th_created');
  });
});
