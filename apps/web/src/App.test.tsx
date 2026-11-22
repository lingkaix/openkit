import { ApiCallError, type CoreClient } from '@openkit/core-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CoreClientProvider } from './app/core-client';
import { isSurfaceLive } from './app/flags';
import { AppRoutes, SURFACE_ELEMENTS } from './app/routes';
import { SURFACES } from './app/surfaces';
import { useThemeStore } from './app/theme-store';
import { useWorkspaceStore } from './screens/workspace-store';

/**
 * Builds the shell's minimal Core Client fake.
 *
 * @param metaOk Whether the connection probe succeeds.
 * @param workspaces Authorized Workspaces returned by discovery.
 * @returns A client fake for rendered shell checks.
 */
function makeClient(
  metaOk: boolean,
  workspaces = [{ id: 'ws_00000000-0000-7b10-9af8-12fd37a880e0', name: 'Market research' }]
): CoreClient {
  return {
    core: {
      meta: metaOk ? vi.fn().mockResolvedValue({}) : vi.fn().mockRejectedValue(new Error('down')),
    },
    operations: {
      'credential.list': vi.fn().mockRejectedValue(
        new ApiCallError(403, 'Server-admin authority is required.', {
          code: 'forbidden',
        })
      ),

      'runtime.file-list': vi.fn().mockRejectedValue(
        new ApiCallError(403, 'Current deployment administrator authority is required.', {
          code: 'deployment_admin_required',
        })
      ),
      'provider-subscription.provider-list': vi.fn().mockRejectedValue(
        new ApiCallError(403, 'Current deployment administrator authority is required.', {
          code: 'deployment_admin_required',
        })
      ),
      'thread.list': vi.fn().mockResolvedValue({ items: [] }),
      'conversation.navigation': vi.fn().mockResolvedValue({ items: [] }),
      'attention.list': vi.fn().mockResolvedValue({ items: [] }),
      'workspace.resources': vi.fn().mockResolvedValue({
        knowledge: [],
        skills: [],
        agents: [],
        models: [],
      }),
      'workspace.list': vi
        .fn()
        .mockResolvedValueOnce({
          items: workspaces.map((workspace) => ({
            membershipStatus: 'active' as const,
            accessCause: 'membership' as const,
            workspace,
            isOwner: true,
            membershipRevision: 1,
            ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
            registryRevision: 1,
          })),
        })
        .mockImplementation(
          vi.fn().mockResolvedValue({
            items: workspaces.map((workspace) => ({
              membershipStatus: 'active' as const,
              accessCause: 'membership' as const,
              workspace,
              isOwner: true,
              membershipRevision: 1,
              ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
              registryRevision: 1,
            })),
          })
        ),
    },
  } as unknown as CoreClient;
}

/**
 * Renders one application route with isolated server state.
 *
 * @param path Initial route.
 * @param options Connection and authorized-Workspace responses.
 */
async function renderAt(
  path: string,
  {
    metaOk = true,
    workspaces,
  }: { metaOk?: boolean; workspaces?: { id: string; name: string }[] } = {}
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <CoreClientProvider client={makeClient(metaOk, workspaces)}>
        <MemoryRouter initialEntries={[path]}>
          <AppRoutes />
        </MemoryRouter>
      </CoreClientProvider>
    </QueryClientProvider>
  );
  await screen.findByRole('navigation');
}

beforeEach(() => {
  localStorage.clear();
  useThemeStore.setState({ theme: 'system' });
  delete document.documentElement.dataset.colorScheme;
  useWorkspaceStore.setState({ currentWorkspaceId: null });
});

describe('app shell — routing', () => {
  const concretePaths = SURFACES.filter(isSurfaceLive).map((surface) => ({
    id: surface.id,
    path: surface.path.replace(/:\w+/g, 'x'),
  }));

  it('registers a concrete screen for every catalog surface (no placeholders)', () => {
    for (const surface of SURFACES) {
      expect(SURFACE_ELEMENTS[surface.id], `missing screen for ${surface.id}`).toBeTruthy();
    }
    expect(Object.keys(SURFACE_ELEMENTS).sort()).toEqual([...SURFACES.map((s) => s.id)].sort());
  });

  it.each(concretePaths)('resolves the $id route under the shell', async ({ id, path }) => {
    await renderAt(path);
    const main = screen.getByRole('main', { name: 'Workspace' });
    // NotFound stays mounted under the shell, so navigation alone cannot see a missed route.
    expect(within(main).queryByRole('heading', { name: 'Not found' })).not.toBeInTheDocument();
    expect(within(main).queryByText(/doesn't exist/i)).not.toBeInTheDocument();
    await waitFor(() => {
      const rendered =
        within(main).queryAllByRole('heading').length > 0 ||
        within(main).queryAllByRole('status').length > 0 ||
        within(main).queryAllByRole('alert').length > 0 ||
        (main.textContent?.trim().length ?? 0) > 0;
      expect(rendered, `${id} at ${path} did not render a screen`).toBe(true);
    });
  });

  it('renders a not-found page for an unknown route', async () => {
    await renderAt('/nope');
    expect(screen.getByText(/doesn't exist/i)).toBeInTheDocument();
  });
});

describe('app shell — build-tier gating (DESIGN.md §11)', () => {
  const unpublishedPaths = SURFACES.filter((surface) => !isSurfaceLive(surface)).map((surface) => ({
    path: surface.path,
    title: surface.title,
  }));

  it.each(unpublishedPaths)('does not publish $title at $path', async ({ path, title }) => {
    await renderAt(path);
    expect(screen.getByText(/doesn't exist/i)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: title })).not.toBeInTheDocument();
  });

  it('keeps unpublished app surfaces out of navigation', async () => {
    await renderAt('/');
    for (const label of [
      'Personal Assistant',
      'Knowledge',
      'Artifacts',
      'Needs you',
      'Automations',
    ]) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    }
    expect(screen.queryByRole('button', { name: 'Overview' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Agents' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Chat' })).not.toBeInTheDocument();
    expect(screen.queryByText('Concept demos')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Generative UI' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Components' })).not.toBeInTheDocument();
  });

  it('shows published settings without concept demos', async () => {
    await renderAt('/settings');
    expect(screen.queryByText('Concept demos')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Channels' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Models and providers' })).toBeInTheDocument();
  });

  it('opens the component gallery under Settings → Appearance → All components', async () => {
    await renderAt('/settings/appearance/components');
    const sections = screen.getByRole('navigation', { name: 'Settings sections' });
    expect(within(sections).getByRole('button', { name: 'Appearance' })).toHaveAttribute(
      'aria-current',
      'page'
    );
    expect(within(sections).queryByRole('button', { name: 'Components' })).not.toBeInTheDocument();
    expect(within(sections).queryByRole('button', { name: 'Debug' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Appearance' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Generative UI' })).toBeInTheDocument();
  });

  it('redirects the retired Debug address to Diagnostics with a link to the gallery', async () => {
    await renderAt('/settings/debug');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Diagnostics' })
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Appearance → All components' })).toHaveAttribute(
      'href',
      '/settings/appearance/components'
    );
  });

  it('mounts the deployment configuration editor under Settings without a credential prompt', async () => {
    await renderAt('/settings/configuration');
    expect(screen.getByRole('navigation')).toHaveAccessibleName('Settings sections');
    expect(screen.getByRole('button', { name: 'Configuration' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Configuration' })).toBeInTheDocument();
    expect(await screen.findByText('Access denied')).toBeInTheDocument();
    expect(screen.queryByLabelText('Server admin token')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('mounts App update administration under Settings without a credential prompt', async () => {
    await renderAt('/settings/app-update');
    expect(screen.getByRole('navigation')).toHaveAccessibleName('Settings sections');
    expect(screen.getByRole('button', { name: 'App update' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'App update' })).toBeInTheDocument();
    expect(await screen.findByText('Access denied')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Prepare' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Server admin token')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('mounts the published Gateway under Settings without a credential prompt', async () => {
    await renderAt('/settings/ai-interface');
    expect(screen.getByRole('navigation')).toHaveAccessibleName('Settings sections');
    expect(screen.getByRole('button', { name: 'Models and providers' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Models and providers' })).toBeInTheDocument();
    expect(await screen.findByText('Access denied')).toBeInTheDocument();
    expect(screen.queryByLabelText('Server admin token')).not.toBeInTheDocument();
    expect(screen.queryByText(/status only/i)).not.toBeInTheDocument();
    expect(screen.queryByText('Concept demos')).not.toBeInTheDocument();
  });

  it('does not retain the old /components route', async () => {
    await renderAt('/components');
    expect(screen.getByText(/doesn't exist/i)).toBeInTheDocument();
  });

  it('groups Settings into Workspace, User, Server, and Administration', async () => {
    await renderAt('/settings/account');
    expect(screen.getByRole('navigation')).toHaveAccessibleName('Settings sections');
    expect(await screen.findByText('Workspace')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'General' })).toBeInTheDocument();
    expect(screen.getByText('User')).toBeInTheDocument();
    expect(screen.getByText('Server')).toBeInTheDocument();
    expect(screen.getAllByText('Administration')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Account' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Appearance' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'My admin access' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New workspace' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Portability' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Configuration' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'App update' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Models and providers' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Administration' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Credentials' })).toBeInTheDocument();
  });

  it('lists Workspace places in the group menu and switches Workspaces in Settings', async () => {
    const user = userEvent.setup();
    await renderAt('/', {
      workspaces: [
        { id: 'ws_00000000-0000-703e-a6be-9a9f8ac8f52c', name: 'Authoritative Workspace' },
        { id: 'ws_00000000-0000-71f5-922f-6fd42f52f580', name: 'Other Workspace' },
      ],
    });

    expect(
      await screen.findByRole('region', { name: 'Authoritative Workspace' })
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Personal Assistant' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Knowledge' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Artifacts' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Search' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'OpenKit' })).toBeInTheDocument();
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    expect(screen.queryByText('Conversations')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Portability' })).not.toBeInTheDocument();
    // B2: the group ⋯ menu replaces the 4x2 icon grid.
    expect(screen.queryByRole('group', { name: 'Sidebar shortcuts' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Authoritative Workspace options' }));
    const places = await screen.findByRole('menu');
    for (const name of [
      'Workspace settings',
      'Workspace changes',
      'Recovery',
      'Archived threads',
      'Vault',
      'Usage & audit',
    ]) {
      expect(within(places).getByRole('menuitem', { name })).toBeInTheDocument();
    }
    expect(
      within(places).queryByRole('menuitem', { name: 'Repositories' })
    ).not.toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('button', { name: 'Repositories' })).not.toBeInTheDocument();
    const settings = screen.getByRole('button', { name: 'Settings' });
    expect(settings.textContent).toBe('');
    expect(screen.getAllByRole('button', { name: 'Settings' })).toHaveLength(1);
    settings.focus();
    await user.keyboard('{Enter}');
    expect(
      await screen.findByRole('navigation', { name: 'Settings sections' })
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'General' }));
    expect(screen.getByRole('navigation')).toHaveAccessibleName('Settings sections');
    expect(screen.getByRole('button', { name: 'General' })).toHaveAttribute('aria-current', 'page');

    await user.click(screen.getByRole('button', { name: 'Authoritative Workspace' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Other Workspace' }));
    expect(useWorkspaceStore.getState().currentWorkspaceId).toBe(
      'ws_00000000-0000-71f5-922f-6fd42f52f580'
    );
    expect(await screen.findByRole('button', { name: 'Other Workspace' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'General' })).toHaveAttribute('aria-current', 'page');
    await user.click(screen.getByRole('button', { name: 'Account' }));
    expect(screen.getByRole('button', { name: 'Account' })).toHaveAttribute('aria-current', 'page');
  });

  it('opens existing Search from the brand-row icon instead of a pinned main strip', async () => {
    const user = userEvent.setup();
    await renderAt('/');
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByRole('searchbox', { name: /search/i })).toBeInTheDocument();
  });

  it('keeps the Settings gear and no Workspace group without a selected workspace', async () => {
    await renderAt('/', { workspaces: [] });
    const user = userEvent.setup();
    expect(screen.queryByRole('button', { name: / options$/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    expect(
      await screen.findByRole('navigation', { name: 'Settings sections' })
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'General' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Repositories' })).not.toBeInTheDocument();
  });

  it('retires the Repositories route and navigation', async () => {
    await renderAt('/repositories', { workspaces: [] });

    expect(await screen.findByRole('heading', { name: 'Not found' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Repositories' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Repositories' })).not.toBeInTheDocument();
    expect(screen.queryByText(/not yet backed by the kernel/i)).not.toBeInTheDocument();
  });
});

describe('app shell — theme lives in Settings, not a header (DESIGN.md §4.5)', () => {
  it('redirects an admitted /login visit to Needs you', async () => {
    await renderAt('/login');
    expect(await screen.findByRole('heading', { name: 'Needs you' })).toBeInTheDocument();
  });

  it('syncs a pre-A1 theme from another tab, migrated to the Dark scheme', async () => {
    await renderAt('/settings/appearance');
    localStorage.setItem('openkit-theme', JSON.stringify({ state: { theme: 'noir' }, version: 0 }));
    await act(async () => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'openkit-theme' }));
    });
    expect(document.documentElement).toHaveAttribute('data-color-scheme', 'dark');
    expect(screen.getByRole('radio', { name: /^Dark/ })).toBeChecked();
  });

  it('offers no theme switcher on the home surface', async () => {
    await renderAt('/');
    expect(screen.queryByRole('radio', { name: /^Dark/ })).not.toBeInTheDocument();
  });

  it('follows the system by default and persists a Light or Dark choice', async () => {
    const user = userEvent.setup();
    await renderAt('/settings/appearance');
    expect(screen.getByRole('radio', { name: /^System/ })).toBeChecked();
    expect(document.documentElement).not.toHaveAttribute('data-color-scheme');

    await user.click(screen.getByRole('radio', { name: /^Dark/ }));
    expect(useThemeStore.getState().theme).toBe('dark');
    expect(document.documentElement).toHaveAttribute('data-color-scheme', 'dark');
    expect(localStorage.getItem('openkit-theme')).toContain('"dark"');

    await user.click(screen.getByRole('radio', { name: /^System/ }));
    expect(document.documentElement).not.toHaveAttribute('data-color-scheme');
  });
});

describe('app shell — disconnected affordance (DESIGN.md §9.12)', () => {
  it('shows a global banner when the runtime is unreachable', async () => {
    await renderAt('/', { metaOk: false });
    // useConnection retries once, so the error (and banner) can arrive after ~1s.
    expect(await screen.findByText(/Offline/i, undefined, { timeout: 3000 })).toBeInTheDocument();
  });

  it('stays silent while connected', async () => {
    await renderAt('/', { metaOk: true });
    await waitFor(() => expect(screen.queryByText(/Offline/i)).not.toBeInTheDocument());
  });

  it('has no 600x600 workbench floor', async () => {
    const { container } = render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <CoreClientProvider client={makeClient(true)}>
          <MemoryRouter initialEntries={['/']}>
            <AppRoutes />
          </MemoryRouter>
        </CoreClientProvider>
      </QueryClientProvider>
    );
    await screen.findByRole('navigation');
    expect(container.querySelector('.min-w-\\[600px\\]')).toBeNull();
    expect(container.querySelector('.min-h-\\[600px\\]')).toBeNull();
    expect(container.querySelector('.min-w-\\[800px\\]')).toBeNull();
  });
});
