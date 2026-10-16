import { ApiCallError, type CoreClient } from '@openkit/core-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { CoreClientProvider } from '../../app/core-client';
import { ServerVaultSecretsPanel } from './ServerVaultSecretsPanel';

const CANARY = 'ghp_synthetic_private_test_value';
/** Observe secret input custody and the existing Server administration commands. */
function setup() {
  const reference = {
    referenceId: 'vault_shared',
    status: 'active',
    currentVersion: 1,
    secretKind: 'mcp-credential',
    material: CANARY,
  };
  const grant = {
    grantId: 'grant_shared',
    vaultReferenceId: 'vault_shared',
    status: 'active',
    targetAgentId: null,
    targetAgentSessionId: null,
    targetCapabilityId: null,
    allowedInjectionPaths: ['gateway-only'],
    lifetime: 'server',
    expiresAt: null,
    approvalId: null,
    policyDecisionId: null,
    material: CANARY,
  };
  const operations = {
    'vault.server-mcp-injection-plan-list': vi.fn().mockResolvedValue({ items: [] }),
    'vault.server-mcp-injection-receipt-list': vi.fn().mockResolvedValue({ items: [] }),
    'vault.server-use-list': vi.fn().mockResolvedValue({ vaultUseRecords: [] }),
    'vault.server-mcp-reference-list': vi.fn().mockResolvedValue({ items: [reference] }),
    'vault.server-mcp-grant-list': vi.fn().mockResolvedValue({ items: [grant] }),
    'vault.server-mcp-secret-create': vi.fn().mockResolvedValue(reference),
    'vault.server-mcp-secret-rotate': vi.fn().mockResolvedValue(reference),
    'vault.server-mcp-secret-revoke': vi
      .fn()
      .mockResolvedValue({ ...reference, status: 'revoked' }),
    'vault.server-mcp-grant-create': vi.fn().mockResolvedValue(grant),
    'vault.server-mcp-grant-narrow': vi.fn().mockResolvedValue({ grant, revokedGrant: grant }),
    'vault.server-mcp-grant-revoke': vi.fn().mockResolvedValue({ ...grant, status: 'revoked' }),
  };
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const mounted = render(
    <QueryClientProvider client={cache}>
      <CoreClientProvider client={{ operations } as unknown as CoreClient}>
        <ServerVaultSecretsPanel />
      </CoreClientProvider>
    </QueryClientProvider>
  );
  return { operations, cache, ...mounted };
}

it('creates Server material only through transient input and excludes it from caches and rendering', async () => {
  const { operations, cache } = setup();
  const material = await screen.findByLabelText('Shared MCP secret value');
  await waitFor(() => expect(material).toBeEnabled());
  await userEvent.type(material, CANARY);
  await userEvent.click(screen.getByRole('button', { name: 'Add shared MCP secret' }));
  await waitFor(() =>
    expect(operations['vault.server-mcp-secret-create']).toHaveBeenCalledWith(
      expect.objectContaining({ material: CANARY })
    )
  );
  await waitFor(() => expect(material).toHaveValue(''));
  const retained = JSON.stringify([
    cache
      .getQueryCache()
      .getAll()
      .map((entry) => entry.state),
    cache
      .getMutationCache()
      .getAll()
      .map((entry) => entry.state),
  ]);
  expect(retained).not.toContain(CANARY);
  expect(document.body.textContent).not.toContain(CANARY);
});

it('uses the existing Server grant narrowing command and requires explicit replacement binding', async () => {
  const { operations } = setup();
  await screen.findByText('grant_shared');
  await userEvent.type(screen.getByLabelText('Shared grant Agent'), 'agent_review');
  await userEvent.click(screen.getByRole('button', { name: 'Narrow shared grant grant_shared' }));
  await waitFor(() =>
    expect(operations['vault.server-mcp-grant-narrow']).toHaveBeenCalledWith(
      expect.objectContaining({
        grantId: 'grant_shared',
        constraints: { targetAgentId: 'agent_review' },
      })
    )
  );
  expect(await screen.findByRole('status')).toHaveTextContent('explicitly');
});

it('clears submitted material after an uncertain failure and refreshes without replay', async () => {
  const { operations, cache } = setup();
  const material = await screen.findByLabelText('Shared MCP secret value');
  await waitFor(() => expect(material).toBeEnabled());
  operations['vault.server-mcp-secret-create'].mockRejectedValueOnce(new Error(CANARY));
  await userEvent.type(material, CANARY);
  await userEvent.click(screen.getByRole('button', { name: 'Add shared MCP secret' }));
  await waitFor(() =>
    expect(operations['vault.server-mcp-secret-create']).toHaveBeenCalledTimes(1)
  );
  await waitFor(() => expect(material).toHaveValue(''));
  expect(await screen.findByRole('button', { name: 'Add shared MCP secret' })).toBeDisabled();
  expect(
    JSON.stringify(
      cache
        .getMutationCache()
        .getAll()
        .map((entry) => entry.state)
    )
  ).not.toContain(CANARY);
  await userEvent.click(screen.getByRole('button', { name: 'Refresh shared MCP secrets' }));
  await waitFor(() =>
    expect(operations['vault.server-mcp-reference-list']).toHaveBeenCalledTimes(2)
  );
  expect(operations['vault.server-mcp-secret-create']).toHaveBeenCalledTimes(1);
  expect(document.body.textContent).not.toContain(CANARY);
});

it('clears transient material and removes mutation controls after current authority is lost', async () => {
  const { operations, cache } = setup();
  const material = await screen.findByLabelText('Shared MCP secret value');
  await waitFor(() => expect(material).toBeEnabled());
  await userEvent.type(material, CANARY);
  operations['vault.server-mcp-reference-list'].mockRejectedValueOnce(
    new ApiCallError(403, CANARY)
  );
  await cache.invalidateQueries({ queryKey: ['settings', 'server-mcp-vault'] });
  await screen.findByText('Access denied. Current administrator authority is required.');
  expect(screen.queryByLabelText('Shared MCP secret value')).not.toBeInTheDocument();
  expect(
    JSON.stringify(
      cache
        .getQueryCache()
        .getAll()
        .map((entry) => entry.state)
    )
  ).not.toContain(CANARY);
  expect(operations['vault.server-mcp-secret-create']).not.toHaveBeenCalled();
});

it.each([
  'Create shared gateway grant vault_shared',
  'Narrow shared grant grant_shared',
])('rejects secret-shaped restrictions before %s enters mutation retention', async (name) => {
  const { operations, cache } = setup();
  await screen.findByText('grant_shared');
  const canary = 'ghp_synthetic_private_grant_canary';
  await userEvent.type(screen.getByLabelText('Shared grant Agent'), canary);
  await userEvent.click(screen.getByRole('button', { name }));
  expect(await screen.findByRole('status')).toHaveTextContent(
    'Grant restriction fields are invalid.'
  );
  expect(operations['vault.server-mcp-grant-create']).not.toHaveBeenCalled();
  expect(operations['vault.server-mcp-grant-narrow']).not.toHaveBeenCalled();
  expect(cache.getMutationCache().getAll()).toHaveLength(0);
  expect(screen.getByLabelText('Shared grant Agent')).toHaveValue('');
  expect(document.body.textContent).not.toContain(canary);
});
