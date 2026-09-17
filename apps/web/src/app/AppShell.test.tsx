import { ApiCallError, type CoreClient } from '@openkit/core-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
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
    app: {
      listConversationNavigation: vi.fn().mockResolvedValue({ items: [] }),
      listAuthorizedWorkspaces: vi.fn().mockResolvedValue({ items: [] }),
      listOpenKitAccessTokens: vi.fn().mockRejectedValue(
        new ApiCallError(403, 'Server-admin authority is required.', {
          code: 'forbidden',
        })
      ),
    },
    core: {
      meta: vi.fn().mockResolvedValue({}),
      listWorkspaces: vi.fn().mockResolvedValue({
        items: [{ id: 'ws1', name: 'Market research' }],
      }),
      listThreads: vi.fn().mockResolvedValue({ items: [] }),
      getWorkspaceResources: vi.fn().mockResolvedValue({
        knowledge: [],
        skills: [],
        agents: [],
        models: [],
      }),
    },
    runtimeConfig: {
      listFiles: vi.fn().mockRejectedValue(
        new ApiCallError(403, 'deployment admin required', {
          code: 'runtime_config_admin_forbidden',
        })
      ),
    },
    providerSubscriptions: {
      listProviders: vi.fn().mockRejectedValue(
        new ApiCallError(403, 'Deployment-admin authority is required.', {
          code: 'forbidden',
        })
      ),
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

describe('AppShell narrow navigation (DESIGN.md §3.4 / §12)', () => {
  it('holds the 600×600 floor and keeps persistent navigation at 800px', async () => {
    const { container } = await renderShell('/');
    expect(container.querySelector('.min-w-\\[600px\\]')).not.toBeNull();
    expect(container.querySelector('.min-h-\\[600px\\]')).not.toBeNull();
    expect(container.querySelector('.min-w-\\[800px\\]')).toBeNull();
    expect(
      screen.getByRole('navigation', { name: 'Primary workspace navigation' })
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Navigation' })).not.toBeInTheDocument();
  });

  it('starts with the left navigation closed below 800px and restores it at 800px', async () => {
    const user = userEvent.setup();
    setViewportWidth(600);
    await renderShell('/');
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    const opener = screen.getByRole('button', { name: 'Navigation' });
    expect(opener).toHaveAttribute('aria-expanded', 'false');

    await user.click(opener);
    const dialog = await screen.findByRole('dialog', { name: 'Navigation' });
    expect(
      screen.getByRole('navigation', { name: 'Primary workspace navigation' })
    ).toBeInTheDocument();
    await waitFor(() => expect(dialog).toContainElement(document.activeElement as HTMLElement));
    expect(opener).toHaveAttribute('aria-expanded', 'true');

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(opener).toHaveFocus());
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();

    await user.click(opener);
    await screen.findByRole('dialog', { name: 'Navigation' });
    await user.click(screen.getByRole('button', { name: 'Close navigation' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(opener).toHaveFocus());

    await user.click(opener);
    await user.click(await screen.findByRole('button', { name: 'Settings' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await screen.findByRole('heading', { name: 'Account' })).toBeInTheDocument();
  });

  it('keeps Settings closed at 742px until the labelled Navigation button opens the drawer', async () => {
    setViewportWidth(742);
    await renderShell('/settings/account');
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Navigation' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Account' })).toBeInTheDocument();
  });

  it('dismisses an open drawer at 800px and starts closed when narrowing again', async () => {
    const user = userEvent.setup();
    setViewportWidth(600);
    await renderShell('/chat');
    await user.click(screen.getByRole('button', { name: 'Navigation' }));
    await screen.findByRole('dialog', { name: 'Navigation' });

    await act(async () => {
      setViewportWidth(800);
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(
      screen.getByRole('navigation', { name: 'Primary workspace navigation' })
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Navigation' })).not.toBeInTheDocument();

    await act(async () => {
      setViewportWidth(600);
    });
    await waitFor(() => expect(screen.queryByRole('navigation')).not.toBeInTheDocument());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Navigation' })).toHaveAttribute(
      'aria-expanded',
      'false'
    );
  });
});
