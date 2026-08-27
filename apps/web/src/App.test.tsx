import type { CoreClient } from '@openkit/core-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CoreClientProvider } from './app/core-client';
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
  workspaces = [{ id: 'ws1', name: 'Market research' }]
): CoreClient {
  return {
    app: {
      listAuthorizedWorkspaces: vi
        .fn()
        .mockResolvedValue({ items: [] } satisfies Awaited<
          ReturnType<CoreClient['app']['listAuthorizedWorkspaces']>
        >),
    },
    core: {
      meta: metaOk ? vi.fn().mockResolvedValue({}) : vi.fn().mockRejectedValue(new Error('down')),
      listWorkspaces: vi.fn().mockResolvedValue({ items: workspaces }),
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
  useThemeStore.setState({ theme: 'spectrum' });
  useWorkspaceStore.setState({ currentWorkspaceId: null });
});

describe('app shell — routing', () => {
  const concretePaths = SURFACES.map((s) => ({ id: s.id, path: s.path.replace(/:\w+/g, 'x') }));

  it('registers a concrete screen for every catalog surface (no placeholders)', () => {
    for (const surface of SURFACES) {
      expect(SURFACE_ELEMENTS[surface.id], `missing screen for ${surface.id}`).toBeTruthy();
    }
    expect(Object.keys(SURFACE_ELEMENTS).sort()).toEqual([...SURFACES.map((s) => s.id)].sort());
  });

  it.each(concretePaths)('resolves the $id route under the shell', async ({ path }) => {
    await renderAt(path);
    // The shell renders a navigation landmark for every routed surface.
    expect(screen.getByRole('navigation')).toBeInTheDocument();
  });

  it('renders a not-found page for an unknown route', async () => {
    await renderAt('/nope');
    expect(screen.getByText(/doesn't exist/i)).toBeInTheDocument();
  });
});

describe('app shell — build-tier gating (DESIGN.md §11)', () => {
  it('renders a Tier-B surface inside the inert concept-demo wrapper', async () => {
    await renderAt('/automations');
    expect(screen.getByText(/not yet backed by the kernel/i)).toBeInTheDocument();
  });

  it('keeps Tier-B/C surfaces out of primary navigation', async () => {
    await renderAt('/');
    // Primary destinations are present…
    for (const label of ['Overview', 'Chat', 'Knowledge', 'Agents']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    }
    // …and disabled surfaces sit under a labeled Concept demos group, not primary.
    expect(screen.getByText('Concept demos')).toBeInTheDocument();
  });

  it('mounts the real component sheet at /components (built in WP-2)', async () => {
    await renderAt('/components');
    expect(screen.getByRole('button', { name: 'Approve plan' })).toBeInTheDocument();
  });

  it('shows Repositories once under the authoritative selected Workspace', async () => {
    await renderAt('/components', {
      workspaces: [
        { id: 'ws_authorized', name: 'Authoritative Workspace' },
        { id: 'ws_other', name: 'Other Workspace' },
      ],
    });

    const workspaceLabel = await screen.findByText('Authoritative Workspace');
    const repositories = screen.getByRole('button', { name: 'Repositories' });
    const overview = screen.getByRole('button', { name: 'Overview' });
    expect(workspaceLabel.parentElement).toContainElement(repositories);
    expect(workspaceLabel.parentElement).not.toContainElement(overview);
    expect(overview.parentElement).not.toContainElement(repositories);
    expect(screen.getAllByRole('button', { name: 'Repositories' })).toHaveLength(1);
  });

  it('hides Workspace Repositories without authorization while keeping its live route', async () => {
    await renderAt('/repositories', { workspaces: [] });

    expect(await screen.findByRole('heading', { name: 'Repositories' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Repositories' })).not.toBeInTheDocument();
    expect(screen.queryByText(/not yet backed by the kernel/i)).not.toBeInTheDocument();
  });
});

describe('app shell — theme lives in Settings, not a header (DESIGN.md §4.5)', () => {
  it('offers no theme switcher on the Overview surface', async () => {
    await renderAt('/');
    expect(screen.queryByRole('radio', { name: /Noir/ })).not.toBeInTheDocument();
  });

  it('selects and persists a theme from Settings → Appearance', async () => {
    const user = userEvent.setup();
    await renderAt('/settings/appearance');
    await user.click(screen.getByRole('radio', { name: /Noir/ }));
    expect(useThemeStore.getState().theme).toBe('noir');
    expect(localStorage.getItem('openkit-theme')).toContain('noir');
  });
});

describe('app shell — disconnected affordance (DESIGN.md §9.12)', () => {
  it('shows a global banner when the runtime is unreachable', async () => {
    await renderAt('/', { metaOk: false });
    // useConnection retries once, so the error (and banner) can arrive after ~1s.
    expect(
      await screen.findByText(/Couldn't reach the local runtime\./i, undefined, { timeout: 3000 })
    ).toBeInTheDocument();
  });

  it('stays silent while connected', async () => {
    await renderAt('/', { metaOk: true });
    await waitFor(() =>
      expect(screen.queryByText(/Couldn't reach the local runtime\./i)).not.toBeInTheDocument()
    );
  });

  it('holds the 800x600 workbench floor', async () => {
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
    expect(container.querySelector('.min-w-\\[800px\\]')).not.toBeNull();
    expect(container.querySelector('.min-h-\\[600px\\]')).not.toBeNull();
  });
});
