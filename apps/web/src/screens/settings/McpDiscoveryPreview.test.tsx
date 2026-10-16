import type { OperationInput } from '@openkit/app-api-schemas';
import { ApiCallError, type CoreClient } from '@openkit/core-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CoreClientProvider } from '../../app/core-client';
import { McpDiscoveryPreview } from './McpDiscoveryPreview';

const digest = `sha256:${'a'.repeat(64)}`;
const retained = `sha256:${'b'.repeat(64)}`;
const observation = {
  mcpId: 'shared-example',
  versionDigest: digest,
  observedAt: '2026-10-16T14:00:00Z',
  serverVersion: 'example 1',
  tools: [{ name: 'read', description: 'Read one record.', inputSchema: { type: 'object' } }],
};
const configuration = {
  entry: {
    id: 'shared-example',
    displayName: 'Shared example',
    availability: 'available' as const,
    enabled: false,
    currentVersionDigest: digest,
    allowedTools: [],
    approvalRequiredTools: [],
    deniedTools: [],
    bindingRevision: 0,
    timeoutMs: null,
    schemaPolicy: null,
    versions: [],
    transportKind: 'http' as const,
  },
  revision: 7,
  credentialBindings: [],
  pinnedSchemaSnapshotId: null,
  versions: [digest, retained].map((value) => ({
    digest: value,
    createdAt: '2026-10-16T12:00:00Z',
    declaration: { kind: 'http' as const, endpoint: 'https://example.invalid/mcp', headers: {} },
    packageRootDigest: null,
  })),
};
/** Isolate the typed preview consumer, transport and mutation cache without an upstream service. */
function setup(preview = vi.fn().mockResolvedValue(observation)) {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const failure = vi.fn();
  const busy = vi.fn();
  const client = {
    operations: { 'administration.mcp-discovery-preview': preview },
  } as unknown as CoreClient;
  const tree = (data = configuration, blocked = false) => (
    <QueryClientProvider client={cache}>
      <CoreClientProvider client={client}>
        <McpDiscoveryPreview
          data={data}
          blocked={blocked}
          onFailure={failure}
          onBusyChange={busy}
        />
      </CoreClientProvider>
    </QueryClientProvider>
  );
  const view = render(tree());
  return { ...view, cache, preview, failure, busy, tree };
}

/** Select a retained immutable version without changing the catalog's current version. */
async function selectRetained() {
  await userEvent.click(screen.getByRole('button', { name: /Preview retained version/ }));
  await userEvent.click(screen.getByRole('option', { name: retained }));
}

describe('explicit MCP discovery preview', () => {
  it('contacts nothing before a deliberate click and sends an exact unselected no-binding version', async () => {
    const view = setup(vi.fn().mockResolvedValue({ ...observation, versionDigest: retained }));
    expect(view.preview).not.toHaveBeenCalled();
    expect(view.cache.getMutationCache().getAll()).toHaveLength(0);
    await selectRetained();
    expect(view.preview).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Preview tools once' }));
    await screen.findByText('Read one record.');
    expect(view.preview).toHaveBeenCalledExactlyOnceWith({
      catalogScope: { kind: 'server' },
      mcpId: 'shared-example',
      versionDigest: retained,
      expectedRevision: 7,
      expectedBindingRevision: null,
      credentialBindings: [],
      timeoutMs: 10000,
    });
    expect(screen.getByText(/Observed at 2026-10-16T14:00:00Z/)).toBeVisible();
    expect(screen.getByText(/does not activate supply/)).toBeVisible();
  });

  it('sends explicitly added temporary grant metadata and the actual binding revision', async () => {
    const view = setup();
    view.rerender(
      view.tree({ ...configuration, entry: { ...configuration.entry, bindingRevision: 3 } })
    );
    await userEvent.type(screen.getByLabelText('Preview credential slot'), 'api-token');
    await userEvent.type(
      screen.getByLabelText('Preview Vault grant id'),
      'grant_00000000-0000-7a77-8a56-84fc4fb5c8ba'
    );
    await userEvent.type(screen.getByLabelText('Preview sink name'), 'Authorization');
    await userEvent.click(screen.getByRole('button', { name: 'Add temporary grant' }));
    expect(view.preview).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Preview tools once' }));
    await waitFor(() => expect(view.preview).toHaveBeenCalledTimes(1));
    expect(view.preview.mock.calls[0]?.[0]).toMatchObject({
      expectedBindingRevision: 3,
      credentialBindings: [
        {
          slot: 'api-token',
          vaultGrantId: 'grant_00000000-0000-7a77-8a56-84fc4fb5c8ba',
          sink: { kind: 'header', name: 'Authorization' },
          presentation: 'raw',
        },
      ],
    });
  });

  it.each([
    ['Preview Vault grant id', 'ghp_fake_preview_canary'],
    ['Preview credential slot', 'invalid_slot'],
    ['Preview sink name', 'not a header'],
  ])('rejects %s before a transport or mutation cache entry', async (field, value) => {
    const view = setup();
    await userEvent.type(screen.getByLabelText('Preview credential slot'), 'api-token');
    await userEvent.type(
      screen.getByLabelText('Preview Vault grant id'),
      'grant_00000000-0000-7a77-8a56-84fc4fb5c8ba'
    );
    await userEvent.type(screen.getByLabelText('Preview sink name'), 'Authorization');
    await userEvent.clear(screen.getByLabelText(field));
    await userEvent.type(screen.getByLabelText(field), value);
    await userEvent.click(screen.getByRole('button', { name: 'Add temporary grant' }));
    expect(screen.getByText(/Check preview fields. No discovery request was sent./)).toBeVisible();
    expect(view.preview).not.toHaveBeenCalled();
    expect(view.cache.getMutationCache().getAll()).toHaveLength(0);
    expect(screen.getByLabelText(field)).toHaveValue('');
    expect(document.body.textContent).not.toContain(value);
  });

  it('applies the timeout schema before mutation admission', async () => {
    const view = setup();
    await userEvent.clear(screen.getByLabelText('Preview timeout in milliseconds'));
    await userEvent.type(screen.getByLabelText('Preview timeout in milliseconds'), '30001');
    await userEvent.click(screen.getByRole('button', { name: 'Preview tools once' }));
    expect(screen.getByText(/Check preview fields. No discovery request was sent./)).toBeVisible();
    expect(view.preview).not.toHaveBeenCalled();
    expect(view.cache.getMutationCache().getAll()).toHaveLength(0);
  });

  it.each([
    401, 403, 409, 503,
  ])('reports safe %i failure, drops prior data and never retries automatically', async (status) => {
    const preview = vi
      .fn()
      .mockResolvedValueOnce(observation)
      .mockRejectedValue(new ApiCallError(status, 'ghp_fake_error_canary'));
    const view = setup(preview);
    await userEvent.click(screen.getByRole('button', { name: 'Preview tools once' }));
    await screen.findByText('Read one record.');
    await userEvent.click(screen.getByRole('button', { name: 'Preview tools once' }));
    await waitFor(() => expect(view.failure).toHaveBeenCalledWith(status));
    expect(screen.queryByText('Read one record.')).not.toBeInTheDocument();
    expect(screen.getByText(/Reload current configuration/)).toBeVisible();
    if (status > 403)
      expect(
        screen.getByText(
          /Reload current configuration only reads configuration and does not prove cleanup/
        )
      ).toBeVisible();
    if (status > 403)
      expect(screen.getByRole('button', { name: 'Preview tools once' })).toBeDisabled();
    expect(preview).toHaveBeenCalledTimes(2);
    const states = view.cache
      .getMutationCache()
      .getAll()
      .map((item) => item.state);
    expect(JSON.stringify(states)).not.toContain('ghp_fake_error_canary');
  });

  it('rejects recognizable credential-shaped results before mutation data admission', async () => {
    const view = setup(
      vi.fn().mockResolvedValue({
        ...observation,
        tools: [{ ...observation.tools[0], description: 'ghp_fake_response_canary' }],
      })
    );
    await userEvent.click(screen.getByRole('button', { name: 'Preview tools once' }));
    await waitFor(() => expect(view.failure).toHaveBeenCalledWith(0));
    expect(document.body.textContent).not.toContain('ghp_fake_response_canary');
    expect(
      JSON.stringify(
        view.cache
          .getMutationCache()
          .getAll()
          .map((item) => item.state)
      )
    ).not.toContain('ghp_fake_response_canary');
  });

  it('discards an observation on version selection, current reread and blocked authority', async () => {
    const view = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Preview tools once' }));
    await screen.findByText('Read one record.');
    await selectRetained();
    expect(screen.queryByText('Read one record.')).not.toBeInTheDocument();
    view.rerender(view.tree({ ...configuration, revision: 8 }));
    expect(screen.queryByText('Read one record.')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Preview tools once' }));
    await screen.findByText('Read one record.');
    view.rerender(view.tree({ ...configuration, revision: 8 }, true));
    expect(screen.queryByText('Read one record.')).not.toBeInTheDocument();
  });

  it('does not republish an in-flight observation after account-boundary disposal', async () => {
    let finish!: (value: typeof observation) => void;
    const preview = vi
      .fn<
        (
          input: OperationInput<'administration.mcp-discovery-preview'>
        ) => Promise<typeof observation>
      >()
      .mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          })
      );
    const view = setup(preview);
    await userEvent.click(screen.getByRole('button', { name: 'Preview tools once' }));
    view.unmount();
    await act(async () => finish(observation));
    const next = setup();
    expect(screen.queryByText('Read one record.')).not.toBeInTheDocument();
    expect(next.preview).not.toHaveBeenCalled();
    expect(view.cache.getMutationCache().getAll()[0]?.state.data).toBeUndefined();
    expect(view.failure).not.toHaveBeenCalled();
  });
});
