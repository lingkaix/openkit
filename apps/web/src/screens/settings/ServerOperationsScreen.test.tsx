import { ApiCallError, type CoreClient } from '@openkit/core-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { CoreClientProvider } from '../../app/core-client';
import { SURFACE_ELEMENTS } from '../../app/routes';
import { surfaceById, surfacesInGroup } from '../../app/surfaces';

describe('Server operations destination', () => {
  it('publishes independent server reads and links to the existing maintenance owners', async () => {
    expect(surfaceById('server-operations')).toMatchObject({
      path: '/settings/server-operations',
      tier: 'A',
      nav: 'settings-admin',
    });
    expect(surfacesInGroup('settings-admin').map((surface) => surface.id)).toContain(
      'server-operations'
    );
    const denied = new ApiCallError(403, 'denied', {});
    const diagnostics = vi.fn().mockRejectedValue(denied);
    const cleanup = vi.fn().mockRejectedValue(denied);
    const client = {
      operations: { 'diagnostics.app': diagnostics, 'administration.cleanup-read': cleanup },
    } as unknown as CoreClient;
    render(
      <MemoryRouter>
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <CoreClientProvider client={client}>
            {SURFACE_ELEMENTS['server-operations']}
          </CoreClientProvider>
        </QueryClientProvider>
      </MemoryRouter>
    );
    expect(screen.getByRole('heading', { name: 'Server operations' })).toBeInTheDocument();
    expect(await screen.findByText('Access denied')).toBeInTheDocument();
    expect(await screen.findByText('Administrator access required.')).toBeInTheDocument();
    expect(diagnostics).toHaveBeenCalledExactlyOnceWith({});
    expect(cleanup).toHaveBeenCalledExactlyOnceWith({});
    for (const [name, path] of [
      ['Configuration and Policy', '/settings/configuration'],
      ['Vault backend and secrets', '/settings/vault-admin'],
      ['Server audit', '/settings/server-audit'],
      ['App update', '/settings/app-update'],
      ['Administration', '/settings/administration'],
      ['Workspace access recovery', '/settings/workspace-access-recovery'],
      ['Deployment data-root backup', '/settings/data-root-backup'],
      ['Portability', '/settings/portability'],
    ]) {
      expect(screen.getByRole('link', { name })).toHaveAttribute('href', path);
    }
    expect(screen.getByText(/does not provide whole-server recovery/)).toBeInTheDocument();
  });
});
