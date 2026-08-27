import type { CoreClient } from '@openkit/core-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { CoreClientProvider } from '../../app/core-client';
import { isSurfaceLive } from '../../app/flags';
import { AppRoutes } from '../../app/routes';
import { SURFACES, surfaceById, surfacesInGroup } from '../../app/surfaces';
import { TIER_B_SURFACE_IDS } from './data';

const EXPECTED_TIER_B_SURFACE_IDS = ['automations', 'channels'] as const;

/** Minimal client — Tier-B demos use sample fixtures, not live reads. */
function makeClient(): CoreClient {
  return {
    app: {
      listAuthorizedWorkspaces: vi
        .fn()
        .mockResolvedValue({ items: [] } satisfies Awaited<
          ReturnType<CoreClient['app']['listAuthorizedWorkspaces']>
        >),
    },
    core: {
      meta: vi.fn().mockResolvedValue({}),
    },
  } as unknown as CoreClient;
}

function Providers({ children, path }: { children?: ReactNode; path: string }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={queryClient}>
      <CoreClientProvider client={makeClient()}>
        <MemoryRouter initialEntries={[path]}>{children ?? <AppRoutes />}</MemoryRouter>
      </CoreClientProvider>
    </QueryClientProvider>
  );
}

function renderRoute(path: string) {
  return render(<Providers path={path} />);
}

describe('WP-8 Tier-B surface catalog', () => {
  it('keeps fixture ownership limited to the remaining Tier-B demos', () => {
    expect(TIER_B_SURFACE_IDS).toEqual(EXPECTED_TIER_B_SURFACE_IDS);
  });

  it.each(EXPECTED_TIER_B_SURFACE_IDS)('keeps %s flag-off (isSurfaceLive false)', (id) => {
    const surface = surfaceById(id);
    expect(surface).toBeDefined();
    expect(surface?.tier).toBe('B');
    expect(isSurfaceLive(surface!)).toBe(false);
  });

  it('keeps Tier-B surfaces out of primary navigation', () => {
    const primaryIds = surfacesInGroup('primary').map((s) => s.id);
    for (const id of EXPECTED_TIER_B_SURFACE_IDS) {
      expect(primaryIds).not.toContain(id);
    }
    const demoIds = [
      ...surfacesInGroup('demos').map((s) => s.id),
      ...surfacesInGroup('settings-demos').map((s) => s.id),
    ];
    for (const id of EXPECTED_TIER_B_SURFACE_IDS) {
      expect(demoIds).toContain(id);
    }
  });

  it('registers every Tier-B WP-8 surface in the catalog', () => {
    const wp8 = SURFACES.filter((s) => s.wp === 'WP-8' && s.tier === 'B');
    expect(wp8.map((s) => s.id).sort()).toEqual([...EXPECTED_TIER_B_SURFACE_IDS].sort());
  });
});

describe('WP-8 Tier-B routes — concept demo + inert', () => {
  const cases = [
    { path: '/automations', title: 'Automations' },
    { path: '/settings/channels', title: 'Channels' },
  ] as const;

  it.each(cases)('wraps $title in ConceptDemo with inert content', async ({ path, title }) => {
    const { container } = renderRoute(path);
    expect(await screen.findByText(/not yet backed by the kernel/i)).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: title })).toBeInTheDocument();
    const inert = container.querySelector('[inert]');
    expect(inert).not.toBeNull();
    expect(inert?.textContent).toContain(title);
  });
});

describe('WP-8 Tier-B screens — frame headings', () => {
  it('Automations renders list and create panel', async () => {
    renderRoute('/automations');
    expect(await screen.findByRole('heading', { name: 'Automations' })).toBeInTheDocument();
    expect(screen.getByText('Monday interview digest')).toBeInTheDocument();
    expect(screen.getByText('New automation')).toBeInTheDocument();
    expect(screen.getByText('Ask me before sharing results')).toBeInTheDocument();
  });

  it('Channels renders connected channels and interrupt preview', async () => {
    renderRoute('/settings/channels');
    expect(await screen.findByRole('heading', { name: 'Channels' })).toBeInTheDocument();
    expect(screen.getByText('Connected channels')).toBeInTheDocument();
    expect(screen.getByText('What travels out')).toBeInTheDocument();
    expect(screen.getByText('How an interrupt looks in a channel')).toBeInTheDocument();
    expect(screen.getByText('Slack')).toBeInTheDocument();
  });
});
