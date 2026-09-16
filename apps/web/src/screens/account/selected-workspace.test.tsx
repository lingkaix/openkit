import type { CoreClient, WorkspaceRecord } from '@openkit/core-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CoreClientProvider } from '../../app/core-client';
import { chatKeys } from '../chat/data';
import { useWorkspaceStore, WORKSPACE_SELECTION_STORAGE_KEY } from '../workspace-store';
import { type AccountWorkspaceSummary, useSelfLeave, useWorkspaceOwnerManagement } from './data';
import { accountAdmissionKey } from './session';

const PROJECT_WORKSPACE: WorkspaceRecord = {
  counts: { artifactCount: 0, knowledgeEntryCount: 0, threadCount: 0 },
  createdAt: '2026-08-04T00:00:00.000Z',
  id: 'ws_project',
  kind: 'general',
  name: 'Project Workspace',
  status: 'active',
  updatedAt: '2026-08-04T00:00:00.000Z',
};
const OTHER_WORKSPACE: WorkspaceRecord = {
  ...PROJECT_WORKSPACE,
  id: 'ws_other',
  name: 'Other Workspace',
};
const USER_A_QUICK_CHAT: WorkspaceRecord = {
  ...PROJECT_WORKSPACE,
  id: 'ws_quick_a',
  kind: 'quick-chat',
  name: 'Quick Chat',
};
const USER_B_QUICK_CHAT: WorkspaceRecord = {
  ...PROJECT_WORKSPACE,
  id: 'ws_quick_b',
  kind: 'quick-chat',
  name: 'Quick Chat',
};

function summary(
  workspace: WorkspaceRecord,
  effectiveRole: 'owner' | 'editor' | 'viewer'
): AccountWorkspaceSummary {
  return {
    effectiveRole,
    membershipRevision: 17,
    ownerUserId: 'user-owner',
    registryRevision: 9,
    workspace,
  };
}

const REMOVED_MEMBER = {
  accessLevel: 'editor' as const,
  createdAt: '2026-08-01T00:00:00.000Z',
  effectiveRole: null,
  invitationId: 'inv-current',
  joinedAt: '2026-08-01T00:00:00.000Z',
  removedAt: '2026-08-04T00:00:00.000Z',
  revision: 18,
  status: 'removed' as const,
  updatedAt: '2026-08-04T00:00:00.000Z',
  userId: 'user-current',
  workspaceId: PROJECT_WORKSPACE.id,
};

/** Reads Account's selected Workspace through the live self-leave owner. */
function AccountSelectionProbe() {
  const { leave, selectedWorkspaceId } = useSelfLeave();
  return (
    <>
      <output aria-label="Account workspace">{selectedWorkspaceId ?? ''}</output>
      <button
        type="button"
        onClick={() =>
          leave.mutate({
            expectedRevision: 17,
            workspaceId: PROJECT_WORKSPACE.id,
          })
        }
      >
        leave
      </button>
    </>
  );
}

/** Reads Account selection through owner management so project owner reads are observable. */
function AccountOwnerSelectionProbe() {
  const { selectedWorkspaceId } = useWorkspaceOwnerManagement();
  return <output aria-label="Account workspace">{selectedWorkspaceId ?? ''}</output>;
}

function renderAccountSelection(options: {
  admission: AccountWorkspaceSummary[];
  items: WorkspaceRecord[];
  leaveWorkspace?: ReturnType<typeof vi.fn>;
}) {
  let discovery = options.items;
  const listWorkspaces = vi.fn(async () => ({ items: discovery }));
  const client = {
    app: {
      leaveWorkspace: options.leaveWorkspace ?? vi.fn(),
    },
    core: { listWorkspaces },
  } as unknown as CoreClient;
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  queryClient.setQueryData(accountAdmissionKey, { items: options.admission });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <CoreClientProvider client={client}>
        <AccountSelectionProbe />
      </CoreClientProvider>
    </QueryClientProvider>
  );
  return {
    ...view,
    listWorkspaces,
    queryClient,
    setDiscovery(items: WorkspaceRecord[]) {
      discovery = items;
    },
  };
}

beforeEach(() => {
  localStorage.clear();
  useWorkspaceStore.setState({ currentWorkspaceId: null, selectionUserKey: null });
});

describe('account selected Workspace', () => {
  it('restores a validated explicit selection on Account after reload', async () => {
    useWorkspaceStore.getState().bindSelectionUserKey(USER_A_QUICK_CHAT.id);
    useWorkspaceStore.getState().setCurrentWorkspaceId(PROJECT_WORKSPACE.id);
    renderAccountSelection({
      admission: [summary(PROJECT_WORKSPACE, 'editor'), summary(OTHER_WORKSPACE, 'viewer')],
      items: [PROJECT_WORKSPACE, USER_A_QUICK_CHAT],
    });
    await waitFor(() => {
      expect(screen.getByLabelText('Account workspace')).toHaveTextContent(PROJECT_WORKSPACE.id);
    });
  });

  it('does not prefer a raw persisted id over the validated switcher Workspace', async () => {
    let releaseDiscovery!: (items: WorkspaceRecord[]) => void;
    const listWorkspaces = vi.fn(
      () =>
        new Promise<{ items: WorkspaceRecord[] }>((resolve) => {
          releaseDiscovery = (items) => resolve({ items });
        })
    );
    const listWorkspaceMembers = vi.fn().mockResolvedValue({ items: [] });
    const listWorkspaceInvitations = vi.fn().mockResolvedValue({ items: [] });
    const client = {
      app: {
        leaveWorkspace: vi.fn(),
        listWorkspaceInvitations,
        listWorkspaceMembers,
      },
      core: { listWorkspaces },
    } as unknown as CoreClient;
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
    });
    queryClient.setQueryData(accountAdmissionKey, {
      items: [summary(PROJECT_WORKSPACE, 'owner'), summary(USER_B_QUICK_CHAT, 'owner')],
    });
    useWorkspaceStore.getState().bindSelectionUserKey(USER_A_QUICK_CHAT.id);
    useWorkspaceStore.getState().setCurrentWorkspaceId(PROJECT_WORKSPACE.id);
    render(
      <QueryClientProvider client={queryClient}>
        <CoreClientProvider client={client}>
          <AccountOwnerSelectionProbe />
        </CoreClientProvider>
      </QueryClientProvider>
    );

    await waitFor(() => expect(listWorkspaces).toHaveBeenCalled());
    expect(screen.getByLabelText('Account workspace')).toHaveTextContent('');
    expect(listWorkspaceMembers).not.toHaveBeenCalled();
    expect(listWorkspaceInvitations).not.toHaveBeenCalled();

    releaseDiscovery([PROJECT_WORKSPACE, USER_B_QUICK_CHAT]);
    await waitFor(() => {
      expect(screen.getByLabelText('Account workspace')).toHaveTextContent(USER_B_QUICK_CHAT.id);
    });
    expect(
      listWorkspaceMembers.mock.calls.every(([workspaceId]) => workspaceId !== PROJECT_WORKSPACE.id)
    ).toBe(true);
    expect(
      listWorkspaceInvitations.mock.calls.every(
        ([workspaceId]) => workspaceId !== PROJECT_WORKSPACE.id
      )
    ).toBe(true);
  });

  it('clears the departed selection and Core discovery row after confirmed leave', async () => {
    const leaveWorkspace = vi.fn().mockResolvedValue({ member: REMOVED_MEMBER });
    useWorkspaceStore.getState().bindSelectionUserKey(USER_A_QUICK_CHAT.id);
    useWorkspaceStore.getState().setCurrentWorkspaceId(PROJECT_WORKSPACE.id);
    const { queryClient, setDiscovery } = renderAccountSelection({
      admission: [summary(PROJECT_WORKSPACE, 'editor'), summary(OTHER_WORKSPACE, 'viewer')],
      items: [PROJECT_WORKSPACE, OTHER_WORKSPACE, USER_A_QUICK_CHAT],
      leaveWorkspace,
    });
    await waitFor(() => {
      expect(screen.getByLabelText('Account workspace')).toHaveTextContent(PROJECT_WORKSPACE.id);
    });
    setDiscovery([OTHER_WORKSPACE, USER_A_QUICK_CHAT]);
    await userEvent.click(screen.getByRole('button', { name: 'leave' }));
    await waitFor(() => {
      expect(useWorkspaceStore.getState().currentWorkspaceId).toBeNull();
    });
    expect(localStorage.getItem(WORKSPACE_SELECTION_STORAGE_KEY) ?? '').not.toContain(
      PROJECT_WORKSPACE.id
    );
    const admission = queryClient.getQueryData<{ items: Array<{ workspace: { id: string } }> }>(
      accountAdmissionKey
    );
    expect(admission?.items.map((item) => item.workspace.id)).toEqual([OTHER_WORKSPACE.id]);
    await waitFor(() => {
      const discovered = queryClient.getQueryData<Array<{ id: string }>>(chatKeys.workspaces);
      expect(discovered?.map((item) => item.id)).toEqual([
        OTHER_WORKSPACE.id,
        USER_A_QUICK_CHAT.id,
      ]);
    });
  });
});
