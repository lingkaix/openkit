import { ApiCallError, type CoreClient } from '@openkit/core-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkspaceStore } from '../screens/workspace-store';
import { CoreClientProvider } from './core-client';
import { AppRoutes } from './routes';

const PERSISTENT_NAV_QUERY = '(min-width: 800px)';

let viewportWidth = 1024;
const mediaListeners = new Set<(event: MediaQueryListEvent) => void>();
const originalMatchMedia = window.matchMedia;

/**
 * Builds the shell's minimal Core Client fake.
 *
 * @returns A client fake for rendered shell checks.
 */
function makeClient(): CoreClient {
  return {
    core: {
      meta: vi.fn().mockResolvedValue({}),
    },
    operations: {
      'token.list': vi.fn().mockRejectedValue(
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
      'workspace.list': vi.fn().mockResolvedValue({
        items: [{ id: 'ws_00000000-0000-7b10-9af8-12fd37a880e0', name: 'Market research' }].map(
          (workspace) => ({
            membershipStatus: 'active' as const,
            accessCause: 'membership' as const,
            workspace,
            isOwner: true,
            membershipRevision: 1,
            ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
            registryRevision: 1,
          })
        ),
      }),
      'workspace.resources': vi.fn().mockResolvedValue({
        knowledge: [],
        skills: [],
        agents: [],
        models: [],
      }),
    },
  } as unknown as CoreClient;
}

/**
 * Installs a matchMedia stub whose `(min-width: 800px)` result follows `viewportWidth`.
 *
 * @param width Initial viewport width in pixels.
 */
function setViewportWidth(width: number) {
  viewportWidth = width;
  const event = { matches: viewportWidth >= 800 } as MediaQueryListEvent;
  for (const listener of mediaListeners) listener(event);
}

/**
 * Renders the live route tree inside the app shell.
 *
 * @param path Initial route.
 */
async function renderShell(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <CoreClientProvider client={makeClient()}>
        <MemoryRouter initialEntries={[path]}>
          <AppRoutes />
        </MemoryRouter>
      </CoreClientProvider>
    </QueryClientProvider>
  );
  await screen.findByRole('main', { name: 'Workspace' });
  return view;
}

beforeEach(() => {
  mediaListeners.clear();
  viewportWidth = 1024;
  window.matchMedia = (query: string) =>
    ({
      get matches() {
        return query === PERSISTENT_NAV_QUERY ? viewportWidth >= 800 : true;
      },
      media: query,
      onchange: null,
      addEventListener: (type: string, listener: EventListener) => {
        if (type === 'change') mediaListeners.add(listener as (event: MediaQueryListEvent) => void);
      },
      removeEventListener: (_type: string, listener: EventListener) => {
        mediaListeners.delete(listener as (event: MediaQueryListEvent) => void);
      },
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => true,
    }) as MediaQueryList;
  useWorkspaceStore.setState({ currentWorkspaceId: null });
});

afterEach(() => {
  window.matchMedia = originalMatchMedia;
});

describe('AppShell navigation breakpoints (DESIGN.md §3.4 / §12)', () => {
  it('has no 600px floor and keeps persistent navigation at 800px', async () => {
    const { container } = await renderShell('/');
    expect(container.querySelector('.min-w-\\[600px\\]')).toBeNull();
    expect(container.querySelector('.min-h-\\[600px\\]')).toBeNull();
    expect(container.querySelector('.min-w-\\[800px\\]')).toBeNull();
    expect(
      screen.getByRole('navigation', { name: 'Primary workspace navigation' })
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Navigation' })).not.toBeInTheDocument();
  });

  it('shows the five phone destinations below 800px and opens the More drawer', async () => {
    const user = userEvent.setup();
    setViewportWidth(600);
    await renderShell('/');
    const phoneNavigation = screen.getByRole('navigation');
    const destinations = within(phoneNavigation).getAllByRole('button');
    expect(destinations).toHaveLength(5);
    expect(destinations[0]).toHaveAccessibleName('Assistant');
    expect(destinations[1]).toHaveAccessibleName('Work');
    expect(destinations[2]).toHaveAccessibleName('Knowledge');
    expect(destinations[3]).toHaveAccessibleName('Artifacts');
    expect(destinations[4]).toHaveAccessibleName('More');
    for (const destination of destinations) {
      expect(destination.className).toContain('whitespace-nowrap');
    }
    expect(screen.queryByRole('button', { name: 'Navigation' })).not.toBeInTheDocument();

    await user.click(destinations[4]!);
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(dialog).toContainElement(document.activeElement as HTMLElement));

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(destinations[4]).toHaveFocus());

    await user.click(destinations[4]!);
    await screen.findByRole('dialog');
    await user.click(screen.getByRole('button', { name: 'Close navigation' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(destinations[4]).toHaveFocus());

    await user.click(destinations[4]!);
    await user.click(await screen.findByRole('button', { name: 'Settings' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await screen.findByRole('heading', { name: 'Account' })).toBeInTheDocument();
  });

  it('keeps the phone destinations on Settings at 742px until More opens the drawer', async () => {
    setViewportWidth(742);
    await renderShell('/settings/account');
    expect(screen.getByRole('navigation')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'More' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Navigation' })).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Account' })).toBeInTheDocument();
  });

  it('drops the phone row when the sidebar returns at 800px and restores it when narrowing', async () => {
    const user = userEvent.setup();
    setViewportWidth(600);
    await renderShell('/chat');
    await user.click(screen.getByRole('button', { name: 'More' }));
    await screen.findByRole('dialog');

    await act(async () => {
      setViewportWidth(800);
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(
      screen.getByRole('navigation', { name: 'Primary workspace navigation' })
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'More' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Navigation' })).not.toBeInTheDocument();

    await act(async () => {
      setViewportWidth(600);
    });
    expect(screen.getByRole('button', { name: 'More' })).toBeVisible();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
