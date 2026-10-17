import { ApiCallError, type CoreClient } from '@openkit/core-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CoreClientProvider } from '../../app/core-client';
import { SharedMcpPanel } from './SharedMcpPanel';

/** Render current shared supply with observable exact Workspace writes. */
function setup({ shadowed = false, disabled = false, removed = false } = {}) {
  const operations = {
    'catalog.shared-mcp-list': vi.fn().mockResolvedValue({
      revision: 7,
      items: [
        {
          id: 'shared-example',
          availability: removed ? 'removed' : 'available',
          displayName: 'Shared example',
          enabled: true,
          disabled,
          shadowed,
          allowedTools: ['read'],
          deniedTools: [],
          approvalRequiredTools: ['read'],
        },
      ],
    }),
    'catalog.shared-mcp-set-disabled': vi.fn().mockResolvedValue({ revision: 8 }),
  };
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={cache}>
      <CoreClientProvider client={{ operations } as unknown as CoreClient}>
        <SharedMcpPanel workspaceId="workspace-test" blocked={false} />
      </CoreClientProvider>
    </QueryClientProvider>
  );
  return { operations, cache };
}

describe('Workspace shared MCP supply', () => {
  it('disables only the exact Workspace projection at its observed revision', async () => {
    const { operations } = setup();
    await screen.findByText('Shared example');
    await userEvent.click(screen.getByRole('button', { name: 'Disable Shared example here' }));
    await waitFor(() =>
      expect(operations['catalog.shared-mcp-set-disabled']).toHaveBeenCalledTimes(1)
    );
    expect(operations['catalog.shared-mcp-set-disabled']).toHaveBeenCalledWith({
      workspaceId: 'workspace-test',
      mcpId: 'shared-example',
      disabled: true,
      expectedRevision: 7,
      requestId: expect.any(String),
    });
    await waitFor(() => expect(operations['catalog.shared-mcp-list']).toHaveBeenCalledTimes(2));
  });
  it('explains a retained local collision without offering a false restoration', async () => {
    const { operations } = setup({ shadowed: true, disabled: true });
    await screen.findByText(
      /A local configuration or retained removal suppresses this shared server/
    );
    expect(screen.queryByRole('button', { name: /Restore/ })).not.toBeInTheDocument();
    expect(operations['catalog.shared-mcp-set-disabled']).not.toHaveBeenCalled();
  });
  it('requires inspection after an unknown result and never replays on refresh', async () => {
    const { operations, cache } = setup();
    operations['catalog.shared-mcp-set-disabled'].mockRejectedValue(new Error('okt_fake_canary'));
    await userEvent.click(
      await screen.findByRole('button', { name: 'Disable Shared example here' })
    );
    await screen.findByText(/Its outcome may be unknown/);
    expect(screen.getByRole('button', { name: 'Disable Shared example here' })).toBeDisabled();
    expect(document.body.textContent).not.toContain('okt_fake_canary');
    expect(
      JSON.stringify(
        cache
          .getMutationCache()
          .getAll()
          .map((m) => m.state)
      )
    ).not.toContain('okt_fake_canary');
    await userEvent.click(screen.getByRole('button', { name: 'Refresh shared supply' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Disable Shared example here' })).toBeEnabled()
    );
    expect(operations['catalog.shared-mcp-set-disabled']).toHaveBeenCalledTimes(1);
  });
  it('hides previously read supply when current authority is denied', async () => {
    const { operations } = setup();
    await screen.findByText('Shared example');
    operations['catalog.shared-mcp-list'].mockRejectedValue(
      new ApiCallError(403, 'private detail')
    );
    await userEvent.click(screen.getByRole('button', { name: 'Refresh shared supply' }));
    await screen.findByText('Shared supply access denied');
    expect(screen.queryByText('Shared example')).not.toBeInTheDocument();
    expect(screen.queryByText('private detail')).not.toBeInTheDocument();
  });
  it('labels retained Server removal and offers no ineffective restoration', async () => {
    setup({ removed: true, disabled: true });
    await screen.findByText(/removed on Server/);
    expect(screen.queryByRole('button', { name: /Restore/ })).not.toBeInTheDocument();
  });
});
