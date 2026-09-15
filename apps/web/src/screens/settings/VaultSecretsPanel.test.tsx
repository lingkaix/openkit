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
  const app = {
    listWorkspaceVaultReferences: vi.fn().mockResolvedValue({ items: [reference] }),
    listWorkspaceVaultGrants: vi.fn().mockResolvedValue({
      items: [{ grantId: 'grant_existing', vaultReferenceId: 'vault_example', status: 'active' }],
    }),
    createWorkspaceVaultSecret: vi.fn().mockResolvedValue({ ...reference, material: SECRET }),
    rotateWorkspaceVaultSecret: vi.fn().mockResolvedValue(reference),
    revokeWorkspaceVaultSecret: vi.fn().mockResolvedValue({ ...reference, status: 'revoked' }),
    createWorkspaceVaultGrant: vi.fn().mockResolvedValue({ grantId: 'grant_example' }),
    revokeWorkspaceVaultGrant: vi.fn().mockResolvedValue({ status: 'revoked' }),
  };
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={cache}>
      <CoreClientProvider client={{ app } as unknown as CoreClient}>
        <VaultSecretsPanel workspaceId="ws_demo" />
      </CoreClientProvider>
    </QueryClientProvider>
  );
  return { app, cache, ...view };
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
  it('clears password on submit and excludes material from caches and rendered results', async () => {
    const { app, cache } = setup();
    const field = await screen.findByLabelText('Secret value');
    expect(field).toHaveAttribute('type', 'password');
    await waitFor(() => expect(field).toBeEnabled());
    await userEvent.type(field, SECRET);
    await userEvent.click(screen.getByRole('button', { name: 'Add secret' }));
    await waitFor(() =>
      expect(app.createWorkspaceVaultSecret).toHaveBeenCalledWith('ws_demo', {
        secretKind: 'github-token',
        material: SECRET,
      })
    );
    expect(field).toHaveValue('');
    expect(document.body.textContent).not.toContain(SECRET);
    expect(cacheBytes(cache)).not.toContain(SECRET);
  });
  it('rotates and revokes explicitly, and creates a host-push grant', async () => {
    const { app, cache } = setup();
    await userEvent.click(await screen.findByRole('button', { name: 'Rotate vault_example' }));
    await userEvent.type(screen.getByLabelText('Secret value'), SECRET);
    await userEvent.click(screen.getByRole('button', { name: 'Save replacement' }));
    await waitFor(() =>
      expect(app.rotateWorkspaceVaultSecret).toHaveBeenCalledWith('ws_demo', 'vault_example', {
        material: SECRET,
      })
    );
    await userEvent.click(
      await screen.findByRole('button', { name: 'Grant host push for vault_example' })
    );
    await waitFor(() =>
      expect(app.createWorkspaceVaultGrant).toHaveBeenCalledWith('ws_demo', {
        referenceId: 'vault_example',
      })
    );
    await userEvent.click(screen.getByRole('button', { name: 'Revoke vault_example' }));
    await waitFor(() =>
      expect(app.revokeWorkspaceVaultSecret).toHaveBeenCalledWith('ws_demo', 'vault_example')
    );
    await userEvent.click(
      await screen.findByRole('button', { name: 'Revoke grant grant_existing' })
    );
    await waitFor(() =>
      expect(app.revokeWorkspaceVaultGrant).toHaveBeenCalledWith('ws_demo', 'grant_existing')
    );
    expect(cacheBytes(cache)).not.toContain(SECRET);
  });
  it('sanitizes failures and refreshes without replaying a secret', async () => {
    const { app, cache } = setup();
    app.createWorkspaceVaultSecret.mockRejectedValue(new Error(SECRET));
    const field = await screen.findByLabelText('Secret value');
    await waitFor(() => expect(field).toBeEnabled());
    await userEvent.type(field, SECRET);
    await userEvent.click(screen.getByRole('button', { name: 'Add secret' }));
    await screen.findByText(/Vault request failed/);
    expect(cacheBytes(cache)).not.toContain(SECRET);
    expect(screen.getByLabelText('Secret value')).toHaveValue('');
    await userEvent.click(screen.getByRole('button', { name: 'Refresh inventory' }));
    expect(app.createWorkspaceVaultSecret).toHaveBeenCalledTimes(1);
  });
});
