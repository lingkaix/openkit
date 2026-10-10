import type { CoreClient } from '@openkit/core-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CoreClientProvider } from '../../app/core-client';
import { VaultSecretsPanel } from './VaultSecretsPanel';

const SECRET = 'ghp_fake_test_only_canary';
const reference = {
  referenceId: 'vault_example',
  secretKind: 'github-token',
  currentVersion: 1,
  status: 'active',
};

/** Render the production secret form with observable network and cache boundaries. */
function setup() {
  const operations = {
    'vault.reference-list': vi.fn().mockResolvedValue({ items: [reference] }),
    'vault.grant-list': vi.fn().mockResolvedValue({
      items: [{ grantId: 'grant_existing', vaultReferenceId: 'vault_example', status: 'active' }],
    }),
    'vault.secret-create': vi.fn().mockResolvedValue({ ...reference, material: SECRET }),
    'vault.secret-rotate': vi.fn().mockResolvedValue(reference),
    'vault.secret-revoke': vi.fn().mockResolvedValue({ ...reference, status: 'revoked' }),
    'vault.grant-create': vi.fn().mockResolvedValue({ grantId: 'grant_example' }),
    'vault.grant-revoke': vi.fn().mockResolvedValue({ status: 'revoked' }),
  };
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={cache}>
      <CoreClientProvider client={{ operations } as unknown as CoreClient}>
        <VaultSecretsPanel workspaceId="ws_demo" />
      </CoreClientProvider>
    </QueryClientProvider>
  );
  return { operations, cache, ...view };
}

/** Inspect query and mutation state including non-enumerable error messages. */
function cacheBytes(cache: QueryClient) {
  return JSON.stringify(
    [
      ...cache
        .getQueryCache()
        .getAll()
        .map((q) => q.state),
      ...cache
        .getMutationCache()
        .getAll()
        .map((m) => m.state),
    ],
    (_key, value) =>
      value instanceof Error ? { message: value.message, stack: value.stack } : value
  );
}

describe('Vault secret administration', () => {
  it('requires an entered secret kind and points gateway grants at the current MCP binding', async () => {
    const { operations } = setup();
    const kind = await screen.findByLabelText('Secret kind');
    await waitFor(() => expect(kind).toBeEnabled());
    expect(kind).toHaveValue('');
    await userEvent.type(screen.getByLabelText('Secret value'), SECRET);
    expect(screen.getByRole('button', { name: 'Add secret' })).toBeDisabled();
    expect(operations['vault.secret-create']).not.toHaveBeenCalled();
    expect(
      screen.getByText(
        'Bind a gateway grant ID to the selected MCP server through catalog.mcp-binding.'
      )
    ).toBeInTheDocument();
  });
  it('clears password on submit and excludes material from caches and rendered results', async () => {
    const { operations, cache } = setup();
    const field = await screen.findByLabelText('Secret value');
    expect(field).toHaveAttribute('type', 'password');
    await waitFor(() => expect(field).toBeEnabled());
    await userEvent.type(screen.getByLabelText('Secret kind'), 'github-token');
    await userEvent.type(field, SECRET);
    await userEvent.click(screen.getByRole('button', { name: 'Add secret' }));
    await waitFor(() =>
      expect(operations['vault.secret-create']).toHaveBeenCalledWith({
        workspaceId: 'ws_demo',
        secretKind: 'github-token',
        material: SECRET,
      })
    );
    expect(field).toHaveValue('');
    expect(document.body.textContent).not.toContain(SECRET);
    expect(cacheBytes(cache)).not.toContain(SECRET);
  });
  it('rotates and revokes explicitly, and creates a gateway grant', async () => {
    const { operations, cache } = setup();
    await userEvent.click(await screen.findByRole('button', { name: 'Rotate vault_example' }));
    await userEvent.type(screen.getByLabelText('Secret value'), SECRET);
    await userEvent.click(screen.getByRole('button', { name: 'Save replacement' }));
    await waitFor(() =>
      expect(operations['vault.secret-rotate']).toHaveBeenCalledWith({
        workspaceId: 'ws_demo',
        referenceId: 'vault_example',
        material: SECRET,
      })
    );
    await userEvent.click(
      await screen.findByRole('button', { name: 'Create gateway grant for vault_example' })
    );
    await waitFor(() =>
      expect(operations['vault.grant-create']).toHaveBeenCalledWith({
        workspaceId: 'ws_demo',
        referenceId: 'vault_example',
      })
    );
    await userEvent.click(screen.getByRole('button', { name: 'Revoke vault_example' }));
    await waitFor(() =>
      expect(operations['vault.secret-revoke']).toHaveBeenCalledWith({
        workspaceId: 'ws_demo',
        referenceId: 'vault_example',
      })
    );
    await userEvent.click(
      await screen.findByRole('button', { name: 'Revoke grant grant_existing' })
    );
    await waitFor(() =>
      expect(operations['vault.grant-revoke']).toHaveBeenCalledWith({
        workspaceId: 'ws_demo',
        grantId: 'grant_existing',
      })
    );
    expect(cacheBytes(cache)).not.toContain(SECRET);
  });
  it('sanitizes failures and refreshes without replaying a secret', async () => {
    const { operations, cache } = setup();
    operations['vault.secret-create'].mockRejectedValue(new Error(SECRET));
    const field = await screen.findByLabelText('Secret value');
    await waitFor(() => expect(field).toBeEnabled());
    await userEvent.type(screen.getByLabelText('Secret kind'), 'github-token');
    await userEvent.type(field, SECRET);
    await userEvent.click(screen.getByRole('button', { name: 'Add secret' }));
    await screen.findByText(/Vault request failed/);
    expect(cacheBytes(cache)).not.toContain(SECRET);
    expect(screen.getByLabelText('Secret value')).toHaveValue('');
    await userEvent.click(screen.getByRole('button', { name: 'Refresh inventory' }));
    expect(operations['vault.secret-create']).toHaveBeenCalledTimes(1);
  });
});
