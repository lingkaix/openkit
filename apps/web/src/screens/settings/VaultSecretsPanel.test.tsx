import type { CoreClient } from '@openkit/core-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CoreClientProvider } from '../../app/core-client';
import { VaultSecretsPanel } from './VaultSecretsPanel';

const SECRET = 'ghp_fake_test_only_canary';
const reference = {
  referenceId: 'vault_00000000-0000-7665-b682-3d8ade3ac72a',
  secretKind: 'github-token',
  currentVersion: 1,
  status: 'active',
};
const grant = {
  grantId: 'grant_existing',
  vaultReferenceId: 'vault_example',
  status: 'active',
  targetAgentId: 'agent_review',
  targetAgentSessionId: null,
  targetCapabilityId: null,
  allowedInjectionPaths: ['gateway-only'],
  lifetime: 'workspace',
  expiresAt: '2099-01-01T00:00:00.000Z',
  approvalId: null,
  policyDecisionId: null,
};

/** Render the production secret form with observable network and cache boundaries. */
function setup() {
  const operations = {
    'vault.reference-list': vi.fn().mockResolvedValue({ items: [reference] }),
    'vault.grant-list': vi.fn().mockResolvedValue({
      items: [grant],
    }),
    'vault.secret-create': vi.fn().mockResolvedValue({ ...reference, material: SECRET }),
    'vault.secret-rotate': vi.fn().mockResolvedValue(reference),
    'vault.secret-revoke': vi.fn().mockResolvedValue({ ...reference, status: 'revoked' }),
    'vault.grant-create': vi
      .fn()
      .mockResolvedValue({ grantId: 'grant_00000000-0000-7384-bb27-4e38ade00776' }),
    'vault.grant-revoke': vi.fn().mockResolvedValue({ status: 'revoked' }),
    'vault.grant-narrow': vi.fn().mockResolvedValue({}),
  };
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={cache}>
      <CoreClientProvider client={{ operations } as unknown as CoreClient}>
        <VaultSecretsPanel workspaceId="ws_00000000-0000-7000-8000-000000000001" />
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
  it('issues exact entered restrictions instead of first creating a broad grant', async () => {
    const { operations } = setup();
    const agent = await screen.findByLabelText('Grant target Agent');
    await waitFor(() => expect(agent).toBeEnabled());
    await userEvent.type(agent, 'agent_selected');
    await userEvent.type(screen.getByLabelText('Grant expiry (UTC)'), '2098-01-01T00:00:00.000Z');
    await userEvent.click(
      screen.getByRole('button', { name: 'Create gateway grant for vault_example' })
    );
    await waitFor(() =>
      expect(operations['vault.grant-create']).toHaveBeenCalledWith({
        workspaceId: 'ws_demo',
        referenceId: reference.referenceId,
        targetAgentId: 'agent_selected',
        expiresAt: '2098-01-01T00:00:00.000Z',
      })
    );
    expect(operations['vault.grant-create']).toHaveBeenCalledTimes(1);
    expect(operations['vault.grant-narrow']).not.toHaveBeenCalled();
  });
  it('sanitizes an unknown narrowing failure and refreshes without replay', async () => {
    const { operations, cache } = setup();
    operations['vault.grant-narrow'].mockRejectedValue(new Error(SECRET));
    const expiry = await screen.findByLabelText('Grant expiry (UTC)');
    await waitFor(() => expect(expiry).toBeEnabled());
    await userEvent.type(expiry, '2098-01-01T00:00:00.000Z');
    await userEvent.click(screen.getByRole('button', { name: 'Narrow grant grant_existing' }));
    await screen.findByText(/Vault request failed/);
    expect(cacheBytes(cache)).not.toContain(SECRET);
    expect(document.body.textContent).not.toContain(SECRET);
    expect(screen.getByRole('button', { name: 'Narrow grant grant_existing' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Refresh inventory' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Narrow grant grant_existing' })).toBeEnabled()
    );
    expect(operations['vault.grant-narrow']).toHaveBeenCalledTimes(1);
    expect(operations['vault.grant-create']).not.toHaveBeenCalled();
  });
  it('shows retained constraints and narrows only through an explicit replacement action', async () => {
    const { operations } = setup();
    expect(await screen.findByText('Agent: agent_review')).toBeInTheDocument();
    expect(screen.getByText('Visibility: gateway-only')).toBeInTheDocument();
    expect(screen.getByText('Lifetime: workspace')).toBeInTheDocument();
    expect(screen.getByText('Expiry: 2099-01-01T00:00:00.000Z')).toBeInTheDocument();
    const narrow = screen.getByRole('button', { name: 'Narrow grant grant_existing' });
    expect(narrow).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Grant expiry (UTC)'), '2098-01-01T00:00:00.000Z');
    await userEvent.click(narrow);
    await waitFor(() =>
      expect(operations['vault.grant-narrow']).toHaveBeenCalledWith({
        workspaceId: 'ws_demo',
        grantId: grant.grantId,
        constraints: { expiresAt: '2098-01-01T00:00:00.000Z' },
      })
    );
    expect(screen.getByLabelText('Grant expiry (UTC)')).toHaveValue('');
    expect(screen.getByText(/Bind the replacement explicitly/)).toBeInTheDocument();
    expect(operations['vault.grant-create']).not.toHaveBeenCalled();
  });
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
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
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
    await userEvent.click(
      await screen.findByRole('button', {
        name: 'Rotate vault_00000000-0000-7665-b682-3d8ade3ac72a',
      })
    );
    await userEvent.type(screen.getByLabelText('Secret value'), SECRET);
    await userEvent.click(screen.getByRole('button', { name: 'Save replacement' }));
    await waitFor(() =>
      expect(operations['vault.secret-rotate']).toHaveBeenCalledWith({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        referenceId: 'vault_00000000-0000-7665-b682-3d8ade3ac72a',
        material: SECRET,
      })
    );
    await userEvent.click(
      await screen.findByRole('button', {
        name: 'Create gateway grant for vault_00000000-0000-7665-b682-3d8ade3ac72a',
      })
    );
    await waitFor(() =>
      expect(operations['vault.grant-create']).toHaveBeenCalledWith({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        referenceId: 'vault_00000000-0000-7665-b682-3d8ade3ac72a',
      })
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Revoke vault_00000000-0000-7665-b682-3d8ade3ac72a' })
    );
    await waitFor(() =>
      expect(operations['vault.secret-revoke']).toHaveBeenCalledWith({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        referenceId: 'vault_00000000-0000-7665-b682-3d8ade3ac72a',
      })
    );
    await userEvent.click(
      await screen.findByRole('button', {
        name: 'Revoke grant grant_00000000-0000-7304-a220-7c8803035355',
      })
    );
    await waitFor(() =>
      expect(operations['vault.grant-revoke']).toHaveBeenCalledWith({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        grantId: 'grant_00000000-0000-7304-a220-7c8803035355',
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
