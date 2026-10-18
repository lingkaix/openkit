import type { CoreClient } from '@openkit/core-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { CoreClientProvider } from '../../app/core-client';
import { isSurfaceLive } from '../../app/flags';
import { SURFACES, surfaceById, surfacesInGroup } from '../../app/surfaces';
import { AutomationsScreen } from './AutomationsScreen';
import { TIER_B_SURFACE_IDS } from './data';

/** Minimal client — Tier-B demos use sample fixtures, not live reads. */
function makeClient(): CoreClient {
  return {
    app: {},
    core: {
      meta: vi.fn().mockResolvedValue({}),
    },

    operations: {
      'workspace.list': vi.fn().mockResolvedValue({
        items: [].map((workspace) => ({
          workspace,
          isOwner: true,
          membershipStatus: 'active',
          accessCause: 'membership',
          membershipRevision: 1,
          ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
          registryRevision: 1,
        })),
      } satisfies Awaited<ReturnType<CoreClient['operations']['workspace.list']>>),
    },
  } as unknown as CoreClient;
}

function Providers({ children, path }: { children?: ReactNode; path: string }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={queryClient}>
      <CoreClientProvider client={makeClient()}>
        <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>
      </CoreClientProvider>
    </QueryClientProvider>
  );
}

describe('WP-8 Tier-B surface catalog', () => {
  it('keeps the existing sample fixture inventory separate from live publication', () => {
    expect(TIER_B_SURFACE_IDS).toEqual(['automations']);
  });

  it('publishes durable automations as a live Workspace surface', () => {
    const surface = surfaceById('automations');
    expect(surface).toMatchObject({ tier: 'A', nav: 'workspace-compact' });
    expect(isSurfaceLive(surface!)).toBe(true);
  });

  it('publishes Channels as a live Settings surface', () => {
    const surface = surfaceById('channels');
    expect(surface).toMatchObject({ tier: 'A', nav: 'settings-user' });
    expect(isSurfaceLive(surface!)).toBe(true);
  });

  it('keeps published surfaces out of demo navigation', () => {
    const demoIds = [
      ...surfacesInGroup('demos').map((s) => s.id),
      ...surfacesInGroup('settings-demos').map((s) => s.id),
    ];
    expect(demoIds).not.toContain('automations');
    expect(demoIds).not.toContain('channels');
  });

  it('registers every Tier-B WP-8 surface in the catalog', () => {
    const wp8 = SURFACES.filter((s) => s.wp === 'WP-8' && s.tier === 'B');
    expect(wp8).toEqual([]);
  });
});

describe('WP-8 Tier-B screens — frame headings', () => {
  it('Automations renders list and create panel', async () => {
    render(
      <Providers path="/automations">
        <AutomationsScreen />
      </Providers>
    );
    expect(await screen.findByRole('heading', { name: 'Automations' })).toBeInTheDocument();
    expect(screen.getByText('Monday interview digest')).toBeInTheDocument();
    expect(screen.getByText('New automation')).toBeInTheDocument();
    expect(screen.getByText('Ask me before sharing results')).toBeInTheDocument();
  });
});
