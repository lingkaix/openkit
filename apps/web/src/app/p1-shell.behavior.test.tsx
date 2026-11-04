import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CoreClient } from '@openkit/core-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkspaceStore } from '../screens/workspace-store';
import { CoreClientProvider } from './core-client';
import { AppRoutes } from './routes';
import { surfaceById } from './surfaces';

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
  useWorkspaceStore.setState({ currentWorkspaceId: WORKSPACE_ID });
});

afterEach(() => {
  window.matchMedia = originalMatchMedia;
});

describe('P1 phone floor', () => {
  it('does not force a 600px minimum at a 360px viewport', async () => {
    setViewportWidth(360);
    const { container } = await renderShell('/');

    expect(container.querySelector('.min-w-\\[600px\\]')).toBeNull();
    expect(container.querySelector('.min-h-\\[600px\\]')).toBeNull();
    expect(screen.getByRole('main', { name: 'Workspace' })).toBeInTheDocument();
  });
});

describe('P1 install metadata', () => {
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
  it('is not gold body or primary text', () => {
    const css = readAppFile('src/styles/tokens.css');
    expect(readNoirToken(css, '--text-color-default')).not.toBe('#d4b15a');
    expect(readNoirToken(css, '--text-color-primary')).not.toBe('#ebce7a');
  });
});

describe('P1 offline state', () => {
  it('shows Offline when the browser reports no connection', async () => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
    try {
      await renderShell('/');
      await waitFor(() => expect(screen.getByText('Offline')).toBeInTheDocument());
    } finally {
      delete (navigator as { onLine?: boolean }).onLine;
    }
  });
});

describe('P1 update prompt', () => {
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
