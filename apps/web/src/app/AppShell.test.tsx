import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApiCallError, type CoreClient } from '@openkit/core-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONVERSATION_NAVIGATION_PAGE_LIMIT } from '../screens/chat/data';
import { useWorkspaceStore } from '../screens/workspace-store';
import { CoreClientProvider } from './core-client';
import { AppRoutes } from './routes';
import { surfaceById } from './surfaces';

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

function register_p1_shell_behavior_test_tsx_0() {
  /**
   * P1 shell behavior (design.md "Installable app", "Visual language", and P1
   * "Shell, type, phone floor, install"; review amendment A5).
   *
   * These checks pin the accepted shell behavior, install metadata, naming,
   * offline status, update prompt, and Noir text tokens. They are written against
   * the design rather than the current implementation, so they fail until the P1
   * product change lands.
   */

  const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

  const PERSISTENT_NAV_QUERY = '(min-width: 800px)';

  const WORKSPACE_ID = 'ws_00000000-0000-7b10-9af8-12fd37a880e0';

  const USER_ID = 'usr_00000000-0000-7000-8000-000000000001';

  const WORKSPACE = {
    id: WORKSPACE_ID,
    name: 'Market research',
    kind: 'general',
    status: 'active',
    counts: { threadCount: 0, artifactCount: 0, knowledgeEntryCount: 0 },
    createdAt: '2026-07-21T12:00:00.000Z',
    updatedAt: '2026-07-21T12:00:00.000Z',
  };

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
        'thread.list': vi.fn().mockResolvedValue({ items: [] }),
        'conversation.navigation': vi.fn().mockResolvedValue({ items: [] }),
        'workspace.list': vi.fn().mockResolvedValue({
          items: [
            {
              membershipStatus: 'active' as const,
              accessCause: 'membership' as const,
              workspace: { id: WORKSPACE_ID, name: WORKSPACE.name },
              isOwner: true,
              membershipRevision: 1,
              ownerUserId: USER_ID,
              registryRevision: 1,
            },
          ],
        }),
        'workspace.read': vi.fn().mockResolvedValue(WORKSPACE),
        'workspace.resources': vi.fn().mockResolvedValue({
          knowledge: [],
          skills: [],
          agents: [],
          models: [],
        }),
        'provider-subscription.provider-list': vi.fn().mockResolvedValue({ providers: [] }),
        'provider-subscription.account-list': vi.fn().mockResolvedValue({ accounts: [] }),
        'diagnostics.app': vi.fn().mockResolvedValue({}),
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

  /**
   * Reads a file relative to the `apps/web` package root.
   *
   * @param relativePath Path under `apps/web`.
   * @returns The file content.
   */
  function readAppFile(relativePath: string): string {
    return readFileSync(join(appRoot, relativePath), 'utf8');
  }

  /**
   * Extracts one declaration from the Noir theme block in `tokens.css`.
   *
   * @param css Token stylesheet text.
   * @param name Custom property name, including the leading `--`.
   * @returns The declared value.
   */
  function readNoirToken(css: string, name: string): string {
    const noir = css.match(/\.ok-theme-noir\s*\{([^}]*)\}/)?.[1] ?? '';
    const value = noir.match(new RegExp(`${name}\\s*:\\s*([^;]+);`))?.[1];
    if (!value) throw new Error(`Missing Noir token ${name}`);
    return value.trim().toLowerCase();
  }

  describe('P1 phone floor', () => {
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
            if (type === 'change')
              mediaListeners.add(listener as (event: MediaQueryListEvent) => void);
          },
          removeEventListener: (_type: string, listener: EventListener) => {
            mediaListeners.delete(listener as (event: MediaQueryListEvent) => void);
          },
          addListener: () => undefined,
          removeListener: () => undefined,
          dispatchEvent: () => true,
        }) as MediaQueryList;
      useWorkspaceStore.setState({ currentWorkspaceId: WORKSPACE_ID });
    });
    afterEach(() => {
      window.matchMedia = originalMatchMedia;
    });

    it('does not force a 600px minimum at a 360px viewport', async () => {
      setViewportWidth(360);
      const { container } = await renderShell('/');

      expect(container.querySelector('.min-w-\\[600px\\]')).toBeNull();
      expect(container.querySelector('.min-h-\\[600px\\]')).toBeNull();
      expect(screen.getByRole('main', { name: 'Workspace' })).toBeInTheDocument();
    });
  });

  describe('P1 install metadata', () => {
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
            if (type === 'change')
              mediaListeners.add(listener as (event: MediaQueryListEvent) => void);
          },
          removeEventListener: (_type: string, listener: EventListener) => {
            mediaListeners.delete(listener as (event: MediaQueryListEvent) => void);
          },
          addListener: () => undefined,
          removeListener: () => undefined,
          dispatchEvent: () => true,
        }) as MediaQueryList;
      useWorkspaceStore.setState({ currentWorkspaceId: WORKSPACE_ID });
    });
    afterEach(() => {
      window.matchMedia = originalMatchMedia;
    });

    it('links the manifest and pads the viewport for the safe area', () => {
      const html = readAppFile('index.html');
      const manifestLink = html.match(/<link[^>]*rel="manifest"[^>]*>/i)?.[0] ?? '';
      expect(manifestLink).toContain('manifest.webmanifest');
      expect(html).toMatch(/<meta[^>]*name="viewport"[^>]*>/i);
      expect(html).toMatch(/viewport-fit=cover/i);
    });

    it('publishes a standalone OpenKit manifest with 512 and 192 marks', () => {
      const manifest = JSON.parse(readAppFile('public/manifest.webmanifest')) as {
        name?: string;
        short_name?: string;
        display?: string;
        start_url?: string;
        icons?: Array<{ src?: string; sizes?: string; purpose?: string }>;
      };

      expect(manifest.name).toBe('OpenKit');
      expect(manifest.short_name).toBe('OpenKit');
      expect(manifest.display).toBe('standalone');
      expect(manifest.start_url).toBe('/');

      const icons = manifest.icons ?? [];
      expect(icons.some((icon) => icon.sizes?.includes('512x512'))).toBe(true);
      expect(icons.some((icon) => icon.sizes?.includes('192x192'))).toBe(true);
      expect(icons.some((icon) => icon.src?.includes('openkit-mark-512.png'))).toBe(true);
    });
  });

  describe('P1 accessible routes and naming', () => {
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
            if (type === 'change')
              mediaListeners.add(listener as (event: MediaQueryListEvent) => void);
          },
          removeEventListener: (_type: string, listener: EventListener) => {
            mediaListeners.delete(listener as (event: MediaQueryListEvent) => void);
          },
          addListener: () => undefined,
          removeListener: () => undefined,
          dispatchEvent: () => true,
        }) as MediaQueryList;
      useWorkspaceStore.setState({ currentWorkspaceId: WORKSPACE_ID });
    });
    afterEach(() => {
      window.matchMedia = originalMatchMedia;
    });

    it('opens the Gateway heading from the retired ai-interface address', async () => {
      await renderShell('/settings/ai-interface');
      expect(await screen.findByRole('heading', { level: 1, name: 'Gateway' })).toBeInTheDocument();
    });

    it('publishes the Gateway catalog path as /settings/gateway', () => {
      expect(surfaceById('ai-interface')).toMatchObject({ path: '/settings/gateway' });
    });

    it('opens the General settings heading from the retired workspace address', async () => {
      await renderShell('/workspace');
      expect(await screen.findByRole('heading', { level: 1, name: 'General' })).toBeInTheDocument();
    });

    it('publishes the General catalog path as /settings/general', () => {
      expect(surfaceById('settings')).toMatchObject({ path: '/settings/general' });
    });
  });

  describe('P1 Noir text', () => {
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
            if (type === 'change')
              mediaListeners.add(listener as (event: MediaQueryListEvent) => void);
          },
          removeEventListener: (_type: string, listener: EventListener) => {
            mediaListeners.delete(listener as (event: MediaQueryListEvent) => void);
          },
          addListener: () => undefined,
          removeListener: () => undefined,
          dispatchEvent: () => true,
        }) as MediaQueryList;
      useWorkspaceStore.setState({ currentWorkspaceId: WORKSPACE_ID });
    });
    afterEach(() => {
      window.matchMedia = originalMatchMedia;
    });

    it('is not gold body or primary text', () => {
      const css = readAppFile('src/styles/tokens.css');
      expect(readNoirToken(css, '--text-color-default')).not.toBe('#d4b15a');
      expect(readNoirToken(css, '--text-color-primary')).not.toBe('#ebce7a');
    });
  });

  describe('P1 offline state', () => {
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
            if (type === 'change')
              mediaListeners.add(listener as (event: MediaQueryListEvent) => void);
          },
          removeEventListener: (_type: string, listener: EventListener) => {
            mediaListeners.delete(listener as (event: MediaQueryListEvent) => void);
          },
          addListener: () => undefined,
          removeListener: () => undefined,
          dispatchEvent: () => true,
        }) as MediaQueryList;
      useWorkspaceStore.setState({ currentWorkspaceId: WORKSPACE_ID });
    });
    afterEach(() => {
      window.matchMedia = originalMatchMedia;
    });

    it('shows Offline when the browser reports no connection', async () => {
      Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
      try {
        await renderShell('/');
        await waitFor(() => expect(screen.getByText('Offline')).toBeInTheDocument());
        expect(screen.getByText('Last opened on this device.')).toBeInTheDocument();
      } finally {
        delete (navigator as { onLine?: boolean }).onLine;
      }
    });
  });

  describe('P1 update prompt', () => {
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
            if (type === 'change')
              mediaListeners.add(listener as (event: MediaQueryListEvent) => void);
          },
          removeEventListener: (_type: string, listener: EventListener) => {
            mediaListeners.delete(listener as (event: MediaQueryListEvent) => void);
          },
          addListener: () => undefined,
          removeListener: () => undefined,
          dispatchEvent: () => true,
        }) as MediaQueryList;
      useWorkspaceStore.setState({ currentWorkspaceId: WORKSPACE_ID });
    });
    afterEach(() => {
      window.matchMedia = originalMatchMedia;
    });

    it('offers A new version is ready with a Reload button when a worker is waiting', async () => {
      const waiting = {
        state: 'installed',
        postMessage: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      };
      const registration = {
        waiting,
        installing: null,
        active: null,
        scope: '/',
        update: vi.fn().mockResolvedValue(undefined),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      };
      const serviceWorker = {
        register: vi.fn().mockResolvedValue(registration),
        ready: Promise.resolve(registration),
        controller: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      };
      Object.defineProperty(navigator, 'serviceWorker', {
        configurable: true,
        value: serviceWorker,
      });
      try {
        await renderShell('/');
        await act(async () => {
          await Promise.resolve();
        });
        expect(await screen.findByText('A new version is ready')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
      } finally {
        delete (navigator as { serviceWorker?: unknown }).serviceWorker;
      }
    });
  });
}
register_p1_shell_behavior_test_tsx_0();

function register_p2_nav_behavior_test_tsx_1() {
  const PERSISTENT_NAV_QUERY = '(min-width: 800px)';

  const WORKSPACE_ID = 'ws_019a0000-0000-7000-8000-000000000101';

  const TIMESTAMP = '2026-11-05T00:00:00.000Z';

  let viewportWidth = 1024;

  const mediaListeners = new Set<(event: MediaQueryListEvent) => void>();

  const originalMatchMedia = window.matchMedia;

  /**
   * Reports the current route so redirects are observable without reading component internals.
   */
  function Location() {
    const location = useLocation();
    return <output aria-label="Location">{`${location.pathname}${location.search}`}</output>;
  }

  /**
   * Sets the next `(min-width: 800px)` result and notifies installed listeners.
   *
   * @param width Viewport width in pixels.
   */
  function setViewportWidth(width: number) {
    viewportWidth = width;
    const event = { matches: viewportWidth >= 800 } as MediaQueryListEvent;
    for (const listener of mediaListeners) listener(event);
  }

  /**
   * Installs the shell's 800px breakpoint as a controllable media query.
   */
  function installMatchMedia() {
    window.matchMedia = (query: string) =>
      ({
        get matches() {
          return query === PERSISTENT_NAV_QUERY ? viewportWidth >= 800 : true;
        },
        media: query,
        onchange: null,
        addEventListener: (type: string, listener: EventListener) => {
          if (type === 'change')
            mediaListeners.add(listener as (event: MediaQueryListEvent) => void);
        },
        removeEventListener: (_type: string, listener: EventListener) => {
          mediaListeners.delete(listener as (event: MediaQueryListEvent) => void);
        },
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => true,
      }) as MediaQueryList;
  }

  /** Builds one retained Thread record for conversation navigation. */
  function threadRecord(id: string, name: string) {
    return {
      id,
      owner: { kind: 'workspace' as const, workspaceId: WORKSPACE_ID },
      name,
      preview: '',
      status: 'active' as const,
      visibility: 'workspace' as const,
      entryPath: 'conversation' as const,
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
    };
  }

  /** Builds one server-classified activity row. */
  function navigationRow(
    id: string,
    name: string,
    activity: 'chat' | 'task' | 'goal' | 'unknown',
    state: 'idle' | 'working' | 'needs-you' = 'idle'
  ) {
    return {
      thread: threadRecord(id, name),
      activity,
      state,
      lastActivityAt: TIMESTAMP,
      unreadCount: 0,
    };
  }

  /** Builds one open decision that Action Center shows without an approval dashboard read. */
  function attentionRow(id: string, title: string, threadId: string) {
    return {
      id: `question:${id}`,
      kind: 'question',
      workspaceId: WORKSPACE_ID,
      threadId,
      turnId: 'tu_019a0000-0000-7000-8000-000000000201',
      itemId: 'it_019a0000-0000-7000-8000-000000000202',
      title,
      summary: 'The Worker is waiting for an answer.',
      severity: 'needs_input',
      createdAt: TIMESTAMP,
      recommendedAction: 'Answer the question.',
      source: {
        type: 'protocol_item',
        itemType: 'user-input-request',
        workspaceId: WORKSPACE_ID,
        threadId,
        turnId: 'tu_019a0000-0000-7000-8000-000000000201',
        itemId: 'it_019a0000-0000-7000-8000-000000000202',
      },
      actions: [
        {
          kind: 'open_thread',
          label: 'Open',
          method: 'GET',
          href: `/api/workspaces/${WORKSPACE_ID}/threads/${threadId}`,
        },
      ],
    };
  }

  interface ClientOptions {
    navigation?: ReturnType<typeof navigationRow>[];
    attention?: ReturnType<typeof attentionRow>[];
    threads?: ReturnType<typeof threadRecord>[];
    readThread?: ReturnType<typeof threadRecord>;
    createThread?: ReturnType<typeof vi.fn>;
  }

  /** Builds the minimal Core Client used by the routed shell, lists, and Action Center. */
  function makeClient(options: ClientOptions = {}): CoreClient {
    const readThread =
      options.readThread ?? threadRecord('th_019a0000-0000-7000-8000-000000000103', 'Assistant');
    return {
      core: { meta: vi.fn().mockResolvedValue({}) },
      operations: {
        'workspace.list': vi.fn().mockResolvedValue({
          items: [
            {
              workspace: { id: WORKSPACE_ID, name: 'Alpha', kind: 'general' },
              membershipStatus: 'active',
              accessCause: 'membership',
              effectiveRole: 'owner',
              isOwner: true,
              ownerUserId: 'usr_019a0000-0000-7000-8000-000000000104',
              membershipRevision: 1,
              registryRevision: 1,
            },
          ],
        }),
        'workspace.resources': vi
          .fn()
          .mockResolvedValue({ knowledge: [], skills: [], agents: [], models: [] }),
        'conversation.navigation': vi.fn().mockResolvedValue({ items: options.navigation ?? [] }),
        'attention.list': vi.fn().mockResolvedValue({ items: options.attention ?? [] }),
        'thread.list': vi.fn().mockResolvedValue({ items: options.threads ?? [] }),
        'thread.create': options.createThread ?? vi.fn().mockResolvedValue(readThread),
        'conversation.submit': vi.fn(),
        'thread.read': vi.fn().mockResolvedValue(readThread),
        'thread.dashboard': vi.fn().mockResolvedValue({
          turns: [],
          pendingRequests: [],
          artifacts: [],
          taskInputs: [],
          participants: [],
          thread: readThread,
          viewerUserId: null,
          workStatus: null,
          composer: { disabled: false, defaultAgentId: null },
          itemLog: { href: '' },
        }),
        'thread.items': vi.fn().mockResolvedValue({ items: [] }),
        'conversation.targets': vi.fn().mockResolvedValue({
          targets: [],
          defaultTargetRef: null,
        }),
        'worker-environment.list': vi.fn().mockResolvedValue({ items: [] }),
        'artifact.list': vi.fn().mockResolvedValue({ items: [] }),
        'goal.read': vi.fn().mockRejectedValue(new Error('No Goal projection.')),
      },
    } as unknown as CoreClient;
  }

  /**
   * Renders the live route tree with one isolated server state.
   *
   * @param path Initial route.
   * @param client Core Client fake.
   */
  function renderAt(path: string, client: CoreClient) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(
      <QueryClientProvider client={queryClient}>
        <CoreClientProvider client={client}>
          <MemoryRouter initialEntries={[path]}>
            <AppRoutes />
            <Location />
          </MemoryRouter>
        </CoreClientProvider>
      </QueryClientProvider>
    );
    return { ...view, queryClient };
  }

  /**
   * Asserts that one node precedes another in document order.
   *
   * @param first Node that must come first.
   * @param second Node that must come later.
   */
  function expectBefore(first: Node, second: Node) {
    expect(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  }

  describe('P2 desktop navigation and lists', () => {
    beforeEach(() => {
      mediaListeners.clear();
      viewportWidth = 1024;
      installMatchMedia();
      useWorkspaceStore.setState({ currentWorkspaceId: null });
    });
    afterEach(() => {
      window.matchMedia = originalMatchMedia;
    });

    it('shows Personal Assistant, Tasks, and Goals without a Conversations bucket or Agents row', async () => {
      const client = makeClient({
        navigation: [
          navigationRow(
            'th_019a0000-0000-7000-8000-000000000110',
            'Launch notes',
            'goal',
            'needs-you'
          ),
          navigationRow('th_019a0000-0000-7000-8000-000000000111', 'Fix the export', 'task'),
          navigationRow(
            'th_019a0000-0000-7000-8000-000000000112',
            'Conversation 2',
            'chat',
            'idle'
          ),
          navigationRow('th_019a0000-0000-7000-8000-000000000113', 'Conversation 3', 'unknown'),
        ],
      });
      renderAt('/attention', client);

      const navigation = await screen.findByRole('navigation', {
        name: 'Primary workspace navigation',
      });

      const assistantRows = within(navigation).getAllByRole('button', {
        name: 'Personal Assistant',
      });
      expect(assistantRows).toHaveLength(1);
      expect(within(navigation).queryByText('Conversations')).not.toBeInTheDocument();
      expect(within(navigation).queryByRole('button', { name: 'Agents' })).not.toBeInTheDocument();

      expect(within(navigation).getByRole('button', { name: 'Knowledge' })).toBeVisible();
      expect(within(navigation).getByRole('button', { name: 'Artifacts' })).toBeVisible();
      expect(within(navigation).getByRole('button', { name: 'Action Center' })).toBeVisible();

      const taskRow = await within(navigation).findByRole('button', { name: 'Fix the export' });
      expect(taskRow).toHaveAccessibleDescription(/^Task(?: ·|$)/);
      expect(taskRow).not.toHaveAccessibleDescription(/Worker task/);
      const goalRow = await within(navigation).findByRole('button', { name: 'Launch notes' });
      expect(goalRow).toHaveAccessibleDescription(/^Goal(?: ·|$)/);
      expect(
        await within(navigation).findByRole('button', { name: 'Conversation 3' })
      ).toHaveAccessibleDescription(/^Activity type unknown(?: ·|$)/);

      const tasksLabel = within(navigation).getAllByText('Tasks', { exact: true })[0];
      const goalsLabel = within(navigation).getAllByText('Goals', { exact: true })[0];
      expect(tasksLabel, 'Tasks must label the Task list').toBeTruthy();
      expect(goalsLabel, 'Goals must label the Goal list').toBeTruthy();
      expectBefore(tasksLabel!, taskRow);
      expectBefore(goalsLabel!, goalRow);
      expectBefore(tasksLabel!, goalsLabel!);

      expect(screen.queryByRole('button', { name: 'Navigation' })).not.toBeInTheDocument();
      expect(within(navigation).queryByRole('button', { name: 'Work' })).not.toBeInTheDocument();
      expect(within(navigation).queryByRole('button', { name: 'More' })).not.toBeInTheDocument();
    });

    it('makes Action Center the decisions screen at /attention and keeps the decisions Overview shows today', async () => {
      const client = makeClient({
        attention: [
          attentionRow('q1', 'Answer required', 'th_019a0000-0000-7000-8000-000000000120'),
          attentionRow('q2', 'Pick the export scope', 'th_019a0000-0000-7000-8000-000000000121'),
        ],
      });
      renderAt('/attention', client);

      expect(
        await screen.findByRole('heading', { level: 1, name: 'Action Center' })
      ).toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: 'Overview' })).not.toBeInTheDocument();
      const decision = await screen.findByRole('heading', { name: 'Answer required' });
      expect(decision).toBeVisible();
      const decisionRow = decision.closest('.border-b');
      expect(decisionRow).toBeTruthy();
      expect(
        within(decisionRow as HTMLElement).getByRole('link', { name: 'Open thread' })
      ).toHaveAttribute('href', `/chat/${WORKSPACE_ID}/th_019a0000-0000-7000-8000-000000000120`);

      const actionCenter = await screen.findByRole('button', { name: /^Action Center/ });
      expect(await within(actionCenter).findByText('2')).toBeInTheDocument();
    });

    it('opens Action Center at / when the selected Workspace has no Assistant timeline', async () => {
      const createThread = vi.fn().mockResolvedValue(threadRecord('th_assistant', 'Assistant'));
      const client = makeClient({
        createThread,
        navigation: [
          navigationRow('th_019a0000-0000-7000-8000-000000000130', 'Fix the export', 'task'),
        ],
      });
      renderAt('/', client);

      await waitFor(() =>
        expect(screen.getByLabelText('Location')).toHaveTextContent('/attention')
      );
      expect(
        await screen.findByRole('heading', { level: 1, name: 'Action Center' })
      ).toBeInTheDocument();
      expect(createThread).not.toHaveBeenCalled();
    });

    it('opens the existing Assistant timeline at / when a chat-classified thread exists', async () => {
      const user = userEvent.setup();
      const chat = threadRecord('th_019a0000-0000-7000-8000-000000000140', 'Ship the notes');
      const createThread = vi.fn();
      const client = makeClient({
        readThread: chat,
        createThread,
        navigation: [
          navigationRow(chat.id, 'Ship the notes', 'chat'),
          navigationRow('th_019a0000-0000-7000-8000-000000000141', 'Fix the export', 'task'),
        ],
      });
      renderAt('/', client);

      await waitFor(() =>
        expect(screen.getByLabelText('Location')).toHaveTextContent(
          `/chat/${WORKSPACE_ID}/${chat.id}`
        )
      );
      expect(createThread).not.toHaveBeenCalled();
      expect(
        await screen.findByRole('heading', { level: 1, name: 'Ship the notes' })
      ).toBeInTheDocument();

      await user.click(await screen.findByRole('button', { name: 'Personal Assistant' }));
      expect(createThread).not.toHaveBeenCalled();
      expect(screen.getByLabelText('Location')).toHaveTextContent(
        `/chat/${WORKSPACE_ID}/${chat.id}`
      );
    });

    it('creates a missing Assistant timeline with thread.create and never submits a conversation', async () => {
      const user = userEvent.setup();
      const created = threadRecord('th_019a0000-0000-7000-8000-000000000150', 'Assistant');
      const createThread = vi.fn().mockResolvedValue(created);
      const client = makeClient({ createThread });
      renderAt('/attention', client);

      await user.click(await screen.findByRole('button', { name: 'Personal Assistant' }));

      await waitFor(() =>
        expect(screen.getByLabelText('Location')).toHaveTextContent(
          `/chat/${WORKSPACE_ID}/${created.id}`
        )
      );
      expect(createThread).toHaveBeenCalledWith({
        workspaceId: WORKSPACE_ID,
        name: 'Assistant',
        requestId: expect.any(String),
      });
      expect(createThread).toHaveBeenCalledTimes(1);
      expect(client.operations['conversation.submit']).not.toHaveBeenCalled();
    });
  });

  describe('P2 phone navigation', () => {
    beforeEach(() => {
      mediaListeners.clear();
      viewportWidth = 1024;
      installMatchMedia();
      useWorkspaceStore.setState({ currentWorkspaceId: null });
    });
    afterEach(() => {
      window.matchMedia = originalMatchMedia;
    });

    it('creates the missing Assistant timeline from the phone home without submitting', async () => {
      setViewportWidth(360);
      const user = userEvent.setup();
      const created = threadRecord('th_019a0000-0000-7000-8000-000000000190', 'Assistant');
      const createThread = vi.fn().mockResolvedValue(created);
      const client = makeClient({ createThread });
      renderAt('/', client);

      await waitFor(() =>
        expect(screen.getByLabelText('Location')).toHaveTextContent('/attention')
      );
      expect(
        await screen.findByRole('heading', { level: 1, name: 'Action Center' })
      ).toBeInTheDocument();
      expect(
        screen.queryByRole('navigation', { name: 'Primary workspace navigation' })
      ).not.toBeInTheDocument();
      expect(createThread).not.toHaveBeenCalled();

      await user.click(screen.getByRole('button', { name: 'Personal Assistant' }));

      await waitFor(() =>
        expect(screen.getByLabelText('Location')).toHaveTextContent(
          `/chat/${WORKSPACE_ID}/${created.id}`
        )
      );
      expect(createThread).toHaveBeenCalledTimes(1);
      expect(createThread).toHaveBeenCalledWith({
        workspaceId: WORKSPACE_ID,
        name: 'Assistant',
        requestId: expect.any(String),
      });
      expect(client.operations['conversation.submit']).not.toHaveBeenCalled();
    });

    it('shows exactly Assistant, Work, Knowledge, Artifacts, and More below 800px', async () => {
      const user = userEvent.setup();
      setViewportWidth(360);
      const client = makeClient({
        attention: [
          attentionRow('q1', 'Answer required', 'th_019a0000-0000-7000-8000-000000000160'),
        ],
      });
      renderAt('/attention', client);

      const navigation = await screen.findByRole('navigation', { name: 'Sections' });
      const buttons = within(navigation).getAllByRole('button');
      expect(buttons).toHaveLength(5);
      expect(buttons[0]).toHaveAccessibleName('Assistant');
      expect(buttons[1]).toHaveAccessibleName('Work');
      expect(buttons[2]).toHaveAccessibleName('Knowledge');
      expect(buttons[3]).toHaveAccessibleName('Artifacts');
      expect(buttons[4]).toHaveAccessibleName('More');

      expect(
        within(navigation).queryByRole('button', { name: /^Needs you/ })
      ).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Navigation' })).not.toBeInTheDocument();

      await user.click(buttons[4]!);
      const drawer = await screen.findByRole('dialog');
      expect(within(drawer).getByRole('button', { name: /^Action Center/ })).toBeVisible();
      expect(within(drawer).queryByRole('button', { name: 'Artifacts' })).not.toBeInTheDocument();
    });

    it('shows the attention count on the Tasks segment when a decision is waiting', async () => {
      setViewportWidth(360);
      const client = makeClient({
        attention: [
          attentionRow('q1', 'Answer required', 'th_019a0000-0000-7000-8000-000000000170'),
          attentionRow('q2', 'Pick the export scope', 'th_019a0000-0000-7000-8000-000000000171'),
        ],
      });
      renderAt('/work', client);

      const tasks = await screen.findByRole('tab', { name: /^Tasks/ });
      expect(await within(tasks).findByText('2')).toBeInTheDocument();
    });

    it('keeps the desktop sidebar destinations and drops the bottom row at 800px', async () => {
      setViewportWidth(800);
      const client = makeClient({
        navigation: [
          navigationRow('th_019a0000-0000-7000-8000-000000000180', 'Fix the export', 'task'),
        ],
      });
      renderAt('/attention', client);

      const navigation = await screen.findByRole('navigation', {
        name: 'Primary workspace navigation',
      });
      expect(within(navigation).getByRole('button', { name: 'Personal Assistant' })).toBeVisible();
      expect(within(navigation).getByRole('button', { name: 'Knowledge' })).toBeVisible();
      expect(within(navigation).getByRole('button', { name: 'Artifacts' })).toBeVisible();
      expect(within(navigation).getByRole('button', { name: 'Action Center' })).toBeVisible();
      expect(
        within(navigation).queryByRole('button', { name: 'Needs you' })
      ).not.toBeInTheDocument();
      expect(within(navigation).queryByRole('button', { name: 'More' })).not.toBeInTheDocument();
      expect(
        within(navigation).queryByRole('button', { name: 'Load more' })
      ).not.toBeInTheDocument();
    });

    it('loads the next conversation page only when the server returns a cursor', async () => {
      const user = userEvent.setup();
      const first = navigationRow(
        'th_019a0000-0000-7000-8000-000000000181',
        'Fix the export',
        'task'
      );
      const second = navigationRow(
        'th_019a0000-0000-7000-8000-000000000182',
        'Weekly notes',
        'task'
      );
      const list = vi.fn(async (input: { cursor?: string }) =>
        input.cursor === 'cursor-2'
          ? { items: [second], nextCursor: null }
          : { items: [first], nextCursor: 'cursor-2' }
      );
      const client = makeClient();
      (
        client.operations as unknown as {
          'conversation.navigation': typeof list;
        }
      )['conversation.navigation'] = list;
      renderAt('/attention', client);

      const navigation = await screen.findByRole('navigation', {
        name: 'Primary workspace navigation',
      });
      expect(
        await within(navigation).findByRole('button', { name: 'Fix the export' })
      ).toBeVisible();
      expect(
        within(navigation).queryByRole('button', { name: 'Weekly notes' })
      ).not.toBeInTheDocument();
      await waitFor(() =>
        expect(list).toHaveBeenCalledWith({
          workspaceId: WORKSPACE_ID,
          limit: CONVERSATION_NAVIGATION_PAGE_LIMIT,
        })
      );
      await user.click(within(navigation).getByRole('button', { name: 'Load more' }));
      expect(await within(navigation).findByRole('button', { name: 'Weekly notes' })).toBeVisible();
      expect(list).toHaveBeenCalledWith({
        workspaceId: WORKSPACE_ID,
        limit: CONVERSATION_NAVIGATION_PAGE_LIMIT,
        cursor: 'cursor-2',
      });
      expect(
        within(navigation).queryByRole('button', { name: 'Load more' })
      ).not.toBeInTheDocument();
    });
  });
}
register_p2_nav_behavior_test_tsx_1();
