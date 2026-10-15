import {
  type AuthorizedWorkspaceSummary,
  ListAuthorizedWorkspacesResponseSchema,
} from '@openkit/app-api-schemas';
import { createCoreClient, type WorkspaceRecord } from '@openkit/core-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoreClientProvider } from '../../app/core-client';
import { Sidebar } from '../../app/Sidebar';
import { chatKeys, useCurrentWorkspaceId } from '../chat/data';
import { AdministrationScreen } from '../settings/AdministrationScreen';
import { useWorkspaceStore, WORKSPACE_SELECTION_STORAGE_KEY } from '../workspace-store';

const TIMESTAMP = '2026-10-15T00:00:00.000Z';
const CALLER_ID = 'user_current';

/** Builds complete current records; relationship expectations come from the owning contracts. */
function workspace(id: string, name: string, kind: WorkspaceRecord['kind'] = 'general') {
  return {
    counts: { artifactCount: 0, knowledgeEntryCount: 0, threadCount: 0 },
    createdAt: TIMESTAMP,
    id,
    kind,
    name,
    status: 'active' as const,
    updatedAt: TIMESTAMP,
  };
}

const FOREIGN_QUICK_CHAT = workspace('ws_foreign_quick', 'Foreign Quick Chat', 'quick-chat');
const FOREIGN_PROJECT = workspace('ws_foreign_project', 'Foreign project');
const REMOVED_PROJECT = workspace('ws_removed_project', 'Former membership');
const OWN_QUICK_CHAT = workspace('ws_own_quick', 'My Quick Chat', 'quick-chat');
const OWN_PROJECT = workspace('ws_own_project', 'My project');
const SHARED_EDITOR = workspace('ws_shared_editor', 'Shared editor project');
const SHARED_VIEWER = workspace('ws_shared_viewer', 'Shared viewer project');

/** Administrator access preserves absent or removed membership instead of creating an owner role. */
function administratorOnly(
  record: WorkspaceRecord,
  membershipStatus: 'removed' | null = null
): AuthorizedWorkspaceSummary {
  return {
    accessCause: 'administrator',
    effectiveRole: null,
    membershipRevision: membershipStatus === 'removed' ? 7 : null,
    membershipStatus,
    ownerUserId: 'user_other',
    registryRevision: 3,
    workspace: record,
  };
}

/** Active membership is independent of the current credential's administrator eligibility. */
function activeMembership(
  record: WorkspaceRecord,
  effectiveRole: 'owner' | 'editor' | 'viewer',
  accessCause: 'membership' | 'administrator' = 'administrator'
): AuthorizedWorkspaceSummary {
  return {
    accessCause,
    effectiveRole,
    membershipRevision: 5,
    membershipStatus: 'active',
    ownerUserId: effectiveRole === 'owner' ? CALLER_ID : 'user_other',
    registryRevision: 3,
    workspace: record,
  };
}

// Web projection: active memberships alone enter the switcher. Chat Assistant:
// Administration uses the caller's personal Workspace. #235 preserves actual relationships.
const RELATIONSHIPS = [
  administratorOnly(FOREIGN_QUICK_CHAT),
  administratorOnly(FOREIGN_PROJECT),
  administratorOnly(REMOVED_PROJECT, 'removed'),
  activeMembership(OWN_QUICK_CHAT, 'owner'),
  activeMembership(OWN_PROJECT, 'owner'),
  activeMembership(SHARED_EDITOR, 'editor'),
  activeMembership(SHARED_VIEWER, 'viewer'),
];

/** Observes the real selection hook and router without duplicating relationship classification. */
function SelectionProbe() {
  const workspaceId = useCurrentWorkspaceId();
  const location = useLocation();
  return (
    <>
      <output aria-label="Selected workspace">{workspaceId ?? ''}</output>
      <output aria-label="Current path">{location.pathname}</output>
    </>
  );
}

const queryClients: QueryClient[] = [];

/** Composes the real client parser, discovery hooks and views; only the HTTP source is a fixture. */
function renderConsumers(
  options: { administration?: boolean; items?: AuthorizedWorkspaceSummary[] } = {}
) {
  let items = options.items ?? RELATIONSHIPS;
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    expect(new URL(String(input)).pathname).toBe('/api/app/operations/workspace.list');
    expect(init?.method).toBe('POST');
    const response = ListAuthorizedWorkspacesResponseSchema.parse({ items });
    return new Response(JSON.stringify(response), {
      headers: { 'content-type': 'application/json' },
    });
  });
  const baseClient = createCoreClient({ baseUrl: 'http://openkit.invalid', fetch });
  const listThreads = vi.fn().mockResolvedValue({ items: [] });
  const client = {
    ...baseClient,
    auth: {
      email: {
        ...baseClient.auth.email,
        getSession: vi.fn().mockResolvedValue({ user: { id: CALLER_ID } }),
      },
    },
    core: { ...baseClient.core, meta: vi.fn().mockResolvedValue({}) },
    operations: {
      ...baseClient.operations,
      'conversation.navigation': vi.fn().mockResolvedValue({ items: [] }),
      'thread.list': listThreads,
      'token.list': vi.fn().mockResolvedValue({ items: [] }),
      'worker-environment.list': vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    },
  };
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  queryClients.push(queryClient);
  const view = render(
    <QueryClientProvider client={queryClient}>
      <CoreClientProvider client={client}>
        <MemoryRouter initialEntries={['/settings/administration']}>
          <Sidebar />
          {options.administration ? <AdministrationScreen /> : null}
          <SelectionProbe />
        </MemoryRouter>
      </CoreClientProvider>
    </QueryClientProvider>
  );
  return {
    ...view,
    listThreads,
    queryClient,
    async discoveryReady() {
      await waitFor(() => {
        expect(queryClient.getQueryState(chatKeys.workspaces)?.status).toBe('success');
        expect(queryClient.getQueryData(chatKeys.workspaceSummaries)).toEqual(items);
      });
    },
    async rediscover(nextItems: AuthorizedWorkspaceSummary[]) {
      items = nextItems;
      await act(async () => {
        await queryClient.invalidateQueries({ queryKey: chatKeys.workspaces });
      });
    },
  };
}

/** Reads the actual persisted selection, including its account-scoping identity. */
function persistedSelection() {
  return JSON.parse(localStorage.getItem(WORKSPACE_SELECTION_STORAGE_KEY) ?? 'null')?.state;
}

beforeEach(() => {
  localStorage.clear();
  useWorkspaceStore.setState({ currentWorkspaceId: null, selectionUserKey: null });
});

afterEach(() => {
  for (const queryClient of queryClients.splice(0)) queryClient.clear();
});

describe('Workspace relationship consumers', () => {
  it('keeps owner, editor and viewer choices for ordinary active membership discovery', async () => {
    const user = userEvent.setup();
    const view = renderConsumers({
      items: [
        activeMembership(OWN_QUICK_CHAT, 'owner', 'membership'),
        activeMembership(OWN_PROJECT, 'owner', 'membership'),
        activeMembership(SHARED_EDITOR, 'editor', 'membership'),
        activeMembership(SHARED_VIEWER, 'viewer', 'membership'),
      ],
    });
    await view.discoveryReady();
    await user.click(screen.getByRole('button', { name: OWN_QUICK_CHAT.name }));
    const menu = await screen.findByRole('menu');
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent)
    ).toEqual([OWN_QUICK_CHAT.name, OWN_PROJECT.name, SHARED_EDITOR.name, SHARED_VIEWER.name]);
  });

  it('offers all active memberships and excludes null and removed administrator-only relationships', async () => {
    const user = userEvent.setup();
    const view = renderConsumers();
    await view.discoveryReady();
    const navigation = screen.getByRole('navigation', { name: 'Settings sections' });
    const switcher = within(navigation)
      .getAllByRole('button')
      .find((button) => button.hasAttribute('aria-haspopup'));
    expect(switcher).toBeDefined();
    await user.click(switcher as HTMLElement);
    const menu = await screen.findByRole('menu');
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent)
    ).toEqual([OWN_QUICK_CHAT.name, OWN_PROJECT.name, SHARED_EDITOR.name, SHARED_VIEWER.name]);
  });

  it.each([
    FOREIGN_PROJECT,
    REMOVED_PROJECT,
  ])('lists administrator-only relationships separately and opens $name for inspection', async (target) => {
    const user = userEvent.setup();
    const view = renderConsumers({ administration: true });
    await view.discoveryReady();
    const others = await screen.findByRole('region', { name: 'Other workspaces' });
    expect(
      within(others)
        .getAllByRole('button')
        .map((button) => button.getAttribute('aria-label'))
    ).toEqual([
      `Open ${FOREIGN_QUICK_CHAT.name} owned by user_other`,
      `Open ${FOREIGN_PROJECT.name} owned by user_other`,
      `Open ${REMOVED_PROJECT.name} owned by user_other`,
    ]);
    await user.click(
      within(others).getByRole('button', {
        name: `Open ${target.name} owned by user_other`,
      })
    );
    expect(screen.getByLabelText('Selected workspace')).toHaveTextContent(target.id);
    expect(screen.getByLabelText('Current path')).toHaveTextContent('/chat');
    expect(useWorkspaceStore.getState().currentWorkspaceId).toBe(target.id);
  });

  it('reads the caller-owned Administration conversation when a foreign null-role Quick Chat comes first', async () => {
    const view = renderConsumers({ administration: true });
    await view.discoveryReady();
    await waitFor(() => {
      expect(view.listThreads).toHaveBeenCalledWith({ workspaceId: OWN_QUICK_CHAT.id });
    });
    expect(view.listThreads).not.toHaveBeenCalledWith({ workspaceId: FOREIGN_QUICK_CHAT.id });
  });

  it('persists an explicit selection under the caller Quick Chat and restores it after reordered discovery', async () => {
    const user = userEvent.setup();
    const view = renderConsumers();
    await view.discoveryReady();
    const navigation = screen.getByRole('navigation', { name: 'Settings sections' });
    const switcher = within(navigation)
      .getAllByRole('button')
      .find((button) => button.hasAttribute('aria-haspopup'));
    expect(switcher).toBeDefined();
    await user.click(switcher as HTMLElement);
    await user.click(await screen.findByRole('menuitem', { name: SHARED_EDITOR.name }));
    expect(persistedSelection()).toMatchObject({
      currentWorkspaceId: SHARED_EDITOR.id,
      selectionUserKey: OWN_QUICK_CHAT.id,
    });
    const savedSelection = localStorage.getItem(WORKSPACE_SELECTION_STORAGE_KEY);
    expect(savedSelection).not.toBeNull();

    view.unmount();
    view.queryClient.clear();
    act(() => useWorkspaceStore.setState({ currentWorkspaceId: null, selectionUserKey: null }));
    // setState persists too, so restore the saved browser bytes before rehydrating the store.
    localStorage.setItem(WORKSPACE_SELECTION_STORAGE_KEY, savedSelection as string);
    await act(async () => {
      await useWorkspaceStore.persist.rehydrate();
    });
    const restored = renderConsumers({ items: [...RELATIONSHIPS].reverse() });
    await restored.discoveryReady();
    expect(screen.getByLabelText('Selected workspace')).toHaveTextContent(SHARED_EDITOR.id);
    expect(persistedSelection()).toMatchObject({
      currentWorkspaceId: SHARED_EDITOR.id,
      selectionUserKey: OWN_QUICK_CHAT.id,
    });
    await restored.rediscover(RELATIONSHIPS);
    expect(screen.getByLabelText('Selected workspace')).toHaveTextContent(SHARED_EDITOR.id);
    expect(persistedSelection().selectionUserKey).toBe(OWN_QUICK_CHAT.id);
  });

  it('does not borrow a foreign Quick Chat for Administration or selection identity when the caller Quick Chat is absent', async () => {
    const view = renderConsumers({
      administration: true,
      items: [administratorOnly(FOREIGN_QUICK_CHAT), activeMembership(SHARED_EDITOR, 'editor')],
    });
    await view.discoveryReady();
    expect(await screen.findByRole('region', { name: 'Private conversation' })).toBeInTheDocument();
    expect(view.listThreads).not.toHaveBeenCalledWith({ workspaceId: FOREIGN_QUICK_CHAT.id });
    expect(useWorkspaceStore.getState().selectionUserKey).toBeNull();
    expect(persistedSelection().selectionUserKey).toBeNull();
  });
});
