import type { VaultGrantRequestTerms, VaultGrantRequestView } from '@openkit/app-api-schemas';
import type { CoreClient } from '@openkit/core-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CoreClientProvider } from '../../app/core-client';
import { VaultGrantRequestsPanel } from './VaultGrantRequestsPanel';

const terms: VaultGrantRequestTerms = {
  referenceId: 'vault_fixture',
  ownerScope: 'workspace',
  lifetime: 'workspace',
  injectionPath: 'gateway-only',
  targetAgentId: 'agent_review',
  targetCapabilityId: 'mcp.call_tool',
};
const effectDetail = JSON.stringify({ operation: 'vault.grant-issue', terms });
const request: VaultGrantRequestView = {
  approvalRequestId: 'apr_fixture',
  workspaceId: 'ws_demo',
  threadId: 'th_demo',
  raisingTurnId: 'tu_demo',
  responsibleUserId: 'user_local',
  requesterKind: 'person',
  agentId: null,
  agentSessionId: null,
  terms,
  state: 'pending',
  resolution: null,
  ending: null,
  claim: 'unclaimed',
  disposition: null,
  delivery: 'undelivered',
  decidingActorId: null,
  grantId: null,
  createdAt: '2026-10-16T00:00:00.000Z',
  canApprove: true,
  canIssue: true,
  effect: { status: 'available', summary: 'Review credential-use authority', detail: effectDetail },
};

/** Observe production controls over the definition-derived client without browser storage or material inputs. */
function setup(row: VaultGrantRequestView = request) {
  const operations = {
    'thread.list': vi
      .fn()
      .mockResolvedValue({ items: [{ id: 'th_demo', name: 'Review', status: 'active' }] }),
    'vault.grant-request-list': vi
      .fn()
      .mockResolvedValue({ workspaceId: 'ws_demo', threadId: 'th_demo', items: [row] }),
    'vault.grant-request': vi.fn().mockResolvedValue(row),
    'approval.respond': vi.fn().mockResolvedValue({}),
    'pending-request.withdraw': vi.fn().mockResolvedValue({}),
    'vault.grant-issue': vi.fn().mockResolvedValue({ ...row, grantId: 'grant_actual' }),
  };
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const mounted = render(
    <QueryClientProvider client={cache}>
      <CoreClientProvider client={{ operations } as unknown as CoreClient}>
        <VaultGrantRequestsPanel workspaceId="ws_demo" />
      </CoreClientProvider>
    </QueryClientProvider>
  );
  return { operations, cache, ...mounted };
}

describe('Vault grant request and review controls', () => {
  it('discloses complete captured terms before enabling the exact approval', async () => {
    const { operations } = setup();
    await userEvent.click(
      await screen.findByRole('button', { name: 'Review exact effect apr_fixture' })
    );
    expect(await screen.findByText(effectDetail)).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole('button', { name: 'Approve exact request apr_fixture' })
    );
    await waitFor(() =>
      expect(operations['approval.respond']).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          turnId: 'tu_demo',
          approvalRequestId: 'apr_fixture',
          decision: 'granted',
        })
      )
    );
    expect(operations['vault.grant-issue']).not.toHaveBeenCalled();
  });
  it('sends supported exact requested terms without creating a grant or collecting secret material', async () => {
    const { operations } = setup();
    await screen.findByRole('button', { name: 'Review exact effect apr_fixture' });
    await userEvent.type(screen.getByLabelText('Requested reference ID'), 'vault_requested');
    await userEvent.type(screen.getByLabelText('Requested Agent'), 'agent_selected');
    await userEvent.click(screen.getByRole('button', { name: 'Request credential-use grant' }));
    await waitFor(() =>
      expect(operations['vault.grant-request']).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          terms: {
            referenceId: 'vault_requested',
            ownerScope: 'workspace',
            lifetime: 'workspace',
            injectionPath: 'gateway-only',
            targetAgentId: 'agent_selected',
          },
        })
      )
    );
    expect(screen.queryByLabelText('Secret value')).not.toBeInTheDocument();
    expect(operations['vault.grant-issue']).not.toHaveBeenCalled();
  });
});

it('keeps unavailable exact disclosure non-approvable while deny and withdrawal remain available', async () => {
  const unavailable: VaultGrantRequestView = {
    ...request,
    effect: { status: 'unavailable', reason: 'Complete exact effect exceeds the detail limit.' },
  };
  const { operations } = setup(unavailable);
  await userEvent.click(
    await screen.findByRole('button', { name: 'Review exact effect apr_fixture' })
  );
  expect(screen.getByRole('button', { name: 'Approve exact request apr_fixture' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Deny request apr_fixture' })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Withdraw request apr_fixture' })).toBeEnabled();
  expect(operations['approval.respond']).not.toHaveBeenCalled();
});

it('shows actual current grant issue separately from approval and disables issue after an uncertain response', async () => {
  const approved: VaultGrantRequestView = { ...request, state: 'resolved', resolution: 'granted' };
  const { operations } = setup(approved);
  operations['vault.grant-issue'].mockRejectedValueOnce(new Error('Synthetic uncertain issue'));
  await userEvent.click(
    await screen.findByRole('button', { name: 'Issue approved grant apr_fixture' })
  );
  await waitFor(() => expect(operations['vault.grant-issue']).toHaveBeenCalledTimes(1));
  expect(
    await screen.findByRole('button', { name: 'Issue approved grant apr_fixture' })
  ).toBeDisabled();
  await userEvent.click(screen.getByRole('button', { name: 'Refresh credential requests' }));
  await waitFor(() => expect(operations['vault.grant-request-list']).toHaveBeenCalledTimes(2));
  expect(operations['vault.grant-issue']).toHaveBeenCalledTimes(1);
});
