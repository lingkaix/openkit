import { ApiCallError, type CoreClient } from '@openkit/core-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CoreClientProvider } from '../../app/core-client';
import { SURFACE_ELEMENTS } from '../../app/routes';
import { surfaceById } from '../../app/surfaces';
import { SharedMcpScreen } from './SharedMcpScreen';

const digest = `sha256:${'a'.repeat(64)}`;
const entry = {
  id: 'shared-example',
  displayName: 'Shared example',
  availability: 'available',
  enabled: false,
  currentVersionDigest: digest,
  allowedTools: ['read'],
  approvalRequiredTools: ['read'],
  deniedTools: [],
  bindingRevision: 3,
  timeoutMs: 60000,
  schemaPolicy: 'tracking',
  versions: [],
  transportKind: 'http',
};
/** Supply exact administrative read models without a Workspace or secret transport. */
function setup() {
  const operations = {
    'administration.mcp-discovery-preview': vi.fn().mockResolvedValue({
      mcpId: entry.id,
      versionDigest: digest,
      observedAt: '2026-10-16T14:00:00Z',
      serverVersion: null,
      tools: [{ name: 'read', description: 'Observed tool metadata.', inputSchema: {} }],
    }),
    'administration.server-mcp-list': vi.fn().mockResolvedValue({ entries: [entry], revision: 7 }),
    'administration.server-mcp-read': vi.fn().mockResolvedValue({
      entry,
      revision: 7,
      credentialBindings: [],
      pinnedSchemaSnapshotId: null,
      versions: [
        {
          digest,
          createdAt: '2026-10-16T12:00:00Z',
          declaration: { kind: 'http', endpoint: 'https://example.invalid/mcp', headers: {} },
          packageRootDigest: null,
        },
      ],
    }),
    'administration.server-mcp-create': vi
      .fn()
      .mockResolvedValue({ entry, revision: 8, versionDigest: digest }),
    'administration.server-mcp-stage-version': vi
      .fn()
      .mockResolvedValue({ entry, revision: 8, versionDigest: digest }),
    'administration.server-mcp-select-version': vi.fn().mockResolvedValue({ revision: 8 }),
    'administration.server-mcp-update-binding': vi.fn().mockResolvedValue({ revision: 8 }),
    'administration.server-mcp-remove': vi.fn().mockResolvedValue({ revision: 8 }),
  };
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={cache}>
      <CoreClientProvider
        client={
          { core: { meta: vi.fn().mockResolvedValue({}) }, operations } as unknown as CoreClient
        }
      >
        <SharedMcpScreen />
      </CoreClientProvider>
    </QueryClientProvider>
  );
  return Object.assign(operations, { cache });
}

describe('Shared MCP administration', () => {
  it('publishes the supported Server workflow in Settings Administration', () => {
    expect(surfaceById('shared-mcp')).toMatchObject({
      path: '/settings/shared-mcp',
      tier: 'A',
      nav: 'settings-admin',
    });
    expect(SURFACE_ELEMENTS['shared-mcp']).toBeTruthy();
  });
  it('creates disabled configuration through current Server authority with no Workspace input', async () => {
    const operations = setup();
    await screen.findByText('Shared example');
    await userEvent.type(screen.getByLabelText('New MCP id'), 'new-example');
    await userEvent.type(screen.getByLabelText('New display name'), 'New example');
    await userEvent.type(screen.getByLabelText('New HTTP endpoint'), 'https://new.invalid/mcp');
    await userEvent.type(screen.getByLabelText('New allowed tools'), 'read, search');
    await userEvent.click(
      screen.getByRole('button', { name: 'Add inactive shared configuration' })
    );
    await waitFor(() =>
      expect(operations['administration.server-mcp-create']).toHaveBeenCalledExactlyOnceWith({
        id: 'new-example',
        displayName: 'New example',
        declaration: { kind: 'http', endpoint: 'https://new.invalid/mcp' },
        allowedTools: ['read', 'search'],
        expectedRevision: 7,
        requestId: expect.any(String),
      })
    );
  });
  it('allows an explicit empty allowlist for inactive discovery configuration', async () => {
    const operations = setup();
    await screen.findByText('Shared example');
    await userEvent.type(screen.getByLabelText('New MCP id'), 'discover-example');
    await userEvent.type(screen.getByLabelText('New display name'), 'Discover example');
    await userEvent.type(screen.getByLabelText('New HTTP endpoint'), 'https://new.invalid/mcp');
    await userEvent.click(
      screen.getByRole('button', { name: 'Add inactive shared configuration' })
    );
    await waitFor(() =>
      expect(operations['administration.server-mcp-create']).toHaveBeenCalledWith(
        expect.objectContaining({ allowedTools: [] })
      )
    );
  });
  it('mounts deliberate discovery without selecting, enabling or automatically connecting', async () => {
    const operations = setup();
    await userEvent.click(await screen.findByRole('button', { name: 'Configure Shared example' }));
    await screen.findByRole('button', { name: 'Preview tools once' });
    expect(operations['administration.mcp-discovery-preview']).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Preview tools once' }));
    await screen.findByText('Observed tool metadata.');
    expect(operations['administration.mcp-discovery-preview']).toHaveBeenCalledExactlyOnceWith({
      catalogScope: { kind: 'server' },
      mcpId: entry.id,
      versionDigest: digest,
      expectedRevision: 7,
      expectedBindingRevision: 3,
      credentialBindings: [],
      timeoutMs: 10000,
    });
    expect(operations['administration.server-mcp-select-version']).not.toHaveBeenCalled();
    expect(operations['administration.server-mcp-update-binding']).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Reload current configuration' }));
    await waitFor(() =>
      expect(screen.queryByText('Observed tool metadata.')).not.toBeInTheDocument()
    );
    expect(operations['administration.mcp-discovery-preview']).toHaveBeenCalledTimes(1);
  });
  it('excludes configuration writes and repeat discovery while a preview is pending', async () => {
    const operations = setup();
    let finish!: (value: {
      mcpId: string;
      versionDigest: string;
      observedAt: string;
      serverVersion: null;
      tools: never[];
    }) => void;
    operations['administration.mcp-discovery-preview'].mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Configure Shared example' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Preview tools once' }));
    expect(screen.getByRole('button', { name: 'Observing tools…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Enable shared supply' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reload current configuration' })).toBeDisabled();
    await act(async () =>
      finish({
        mcpId: entry.id,
        versionDigest: digest,
        observedAt: '2026-10-16T14:00:00Z',
        serverVersion: null,
        tools: [],
      })
    );
    await screen.findByText(/Observed at/);
    expect(screen.getByRole('button', { name: 'Enable shared supply' })).toBeEnabled();
    expect(operations['administration.mcp-discovery-preview']).toHaveBeenCalledTimes(1);
    expect(operations['administration.server-mcp-update-binding']).not.toHaveBeenCalled();
  });
  it.each([
    403, 409, 503,
  ])('requires successful reread after discovery failure %i without replay', async (status) => {
    const operations = setup();
    operations['administration.mcp-discovery-preview'].mockRejectedValueOnce(
      new ApiCallError(status, 'ghp_fake_preview_error')
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Configure Shared example' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Preview tools once' }));
    if (status === 403) {
      await screen.findByText('Shared MCP administration access denied');
      expect(screen.queryByLabelText('Allowed tools')).not.toBeInTheDocument();
      expect(screen.queryByText('Shared example')).not.toBeInTheDocument();
    } else {
      await screen.findByText(
        status === 409 ? /Discovery requires inspection/ : /Discovery failed or its connection/
      );
      expect(
        screen.getByText(
          /Reload current configuration only reads configuration and does not prove cleanup/
        )
      ).toBeVisible();
      expect(screen.getByRole('button', { name: 'Preview tools once' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Enable shared supply' })).toBeDisabled();
    }
    expect(document.body.textContent).not.toContain('ghp_fake_preview_error');
    expect(operations['administration.mcp-discovery-preview']).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('button', { name: 'Reload current configuration' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Preview tools once' })).toBeEnabled()
    );
    expect(operations['administration.mcp-discovery-preview']).toHaveBeenCalledTimes(1);
    expect(
      screen.getByText(/A configuration reread does not prove cleanup of an earlier attempt/)
    ).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Preview tools once' }));
    await screen.findByText('Observed tool metadata.');
    expect(operations['administration.mcp-discovery-preview']).toHaveBeenCalledTimes(2);
  });
  it('edits exact observed binding without silently replacing credential references', async () => {
    const operations = setup();
    await userEvent.click(await screen.findByRole('button', { name: 'Configure Shared example' }));
    await screen.findByLabelText('Allowed tools');
    await userEvent.click(screen.getByRole('button', { name: 'Enable shared supply' }));
    await waitFor(() =>
      expect(operations['administration.server-mcp-update-binding']).toHaveBeenCalledTimes(1)
    );
    expect(operations['administration.server-mcp-update-binding']).toHaveBeenCalledWith({
      mcpId: 'shared-example',
      expectedRevision: 7,
      bindingRevision: 3,
      allowedTools: ['read'],
      approvalRequiredTools: ['read'],
      deniedTools: [],
      schemaPolicy: 'tracking',
      timeoutMs: 60000,
      enabled: true,
      requestId: expect.any(String),
    });
  });
  it('preserves the draft after conflict and refreshes without automatic replay', async () => {
    const operations = setup();
    operations['administration.server-mcp-update-binding'].mockRejectedValue(
      new ApiCallError(409, 'private failure')
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Configure Shared example' }));
    const tools = await screen.findByLabelText('Allowed tools');
    await userEvent.clear(tools);
    await userEvent.type(tools, 'search');
    await userEvent.click(screen.getByRole('button', { name: 'Save binding' }));
    await screen.findByText(/draft is kept/);
    expect(tools).toHaveValue('search');
    expect(screen.getByRole('button', { name: 'Save binding' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Reload current configuration' }));
    await waitFor(() => expect(screen.getByLabelText('Allowed tools')).toHaveValue('read'));
    expect(operations['administration.server-mcp-update-binding']).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).not.toContain('private failure');
  });
  it('hides cached configuration after a current administrator denial', async () => {
    const operations = setup();
    await userEvent.click(await screen.findByRole('button', { name: 'Configure Shared example' }));
    await screen.findByLabelText('Allowed tools');
    operations['administration.server-mcp-list'].mockRejectedValue(
      new ApiCallError(403, 'private denial')
    );
    await userEvent.click(screen.getByRole('button', { name: 'Reload current configuration' }));
    await screen.findByText('Shared MCP administration access denied');
    expect(screen.queryByLabelText('Allowed tools')).not.toBeInTheDocument();
    expect(screen.queryByText('Shared example')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain('private denial');
  });
  it('keeps one pending binding mutation and does not turn a failed read into success', async () => {
    const operations = setup();
    let complete!: (value: { revision: number }) => void;
    operations['administration.server-mcp-update-binding'].mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        })
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Configure Shared example' }));
    await screen.findByLabelText('Allowed tools');
    await userEvent.click(screen.getByRole('button', { name: 'Save binding' }));
    expect(screen.getByRole('button', { name: 'Save binding' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Save binding' }));
    operations['administration.server-mcp-read'].mockRejectedValue(
      new Error('private current read')
    );
    complete({ revision: 8 });
    await screen.findByText("Couldn't read the selected configuration. Reload before changing it.");
    expect(screen.queryByLabelText('Allowed tools')).not.toBeInTheDocument();
    expect(operations['administration.server-mcp-update-binding']).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).not.toContain('private current read');
  });
  it('stages an immutable version without selecting or enabling it, then requires removal confirmation', async () => {
    const operations = setup();
    await userEvent.click(await screen.findByRole('button', { name: 'Configure Shared example' }));
    const endpoint = await screen.findByLabelText('Version HTTP endpoint');
    await userEvent.clear(endpoint);
    await userEvent.type(endpoint, 'https://changed.invalid/mcp');
    await userEvent.click(screen.getByRole('button', { name: 'Stage version without selecting' }));
    await waitFor(() =>
      expect(operations['administration.server-mcp-stage-version']).toHaveBeenCalledExactlyOnceWith(
        {
          mcpId: 'shared-example',
          id: 'shared-example',
          displayName: 'Shared example',
          allowedTools: ['read'],
          expectedRevision: 7,
          requestId: expect.any(String),
          declaration: { kind: 'http', endpoint: 'https://changed.invalid/mcp', headers: {} },
        }
      )
    );
    expect(operations['administration.server-mcp-select-version']).not.toHaveBeenCalled();
    expect(operations['administration.server-mcp-update-binding']).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Review removal' })).toBeEnabled()
    );
    await userEvent.click(screen.getByRole('button', { name: 'Review removal' }));
    expect(operations['administration.server-mcp-remove']).not.toHaveBeenCalled();
    await userEvent.click(
      screen.getByRole('button', { name: 'Confirm removal of Shared example' })
    );
    await waitFor(() =>
      expect(operations['administration.server-mcp-remove']).toHaveBeenCalledExactlyOnceWith({
        mcpId: 'shared-example',
        expectedRevision: 7,
        requestId: expect.any(String),
      })
    );
  });
  it('replaces credential bindings only after an explicit draft edit and save', async () => {
    const operations = setup();
    await userEvent.click(await screen.findByRole('button', { name: 'Configure Shared example' }));
    await userEvent.type(await screen.findByLabelText('Credential slot'), 'authorization');
    await userEvent.type(screen.getByLabelText('Server MCP grant id'), 'grant-selected');
    await userEvent.type(screen.getByLabelText('Sink name'), 'Authorization');
    await userEvent.click(screen.getByRole('button', { name: 'Add grant binding to draft' }));
    expect(operations['administration.server-mcp-update-binding']).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Save binding' }));
    await waitFor(() =>
      expect(operations['administration.server-mcp-update-binding']).toHaveBeenCalledWith(
        expect.objectContaining({
          credentialBindings: [
            {
              slot: 'authorization',
              vaultGrantId: 'grant-selected',
              sink: { kind: 'header', name: 'Authorization' },
              presentation: 'raw',
            },
          ],
          expectedRevision: 7,
          bindingRevision: 3,
          enabled: false,
        })
      )
    );
  });
  it('rejects pasted material before mutation variables or transport retain it', async () => {
    const operations = setup();
    await screen.findByText('Shared example');
    await userEvent.type(screen.getByLabelText('New MCP id'), 'new-example');
    await userEvent.type(screen.getByLabelText('New display name'), 'ghp_fake_canary');
    await userEvent.type(screen.getByLabelText('New HTTP endpoint'), 'https://new.invalid/mcp');
    await userEvent.type(screen.getByLabelText('New allowed tools'), 'read');
    await userEvent.click(
      screen.getByRole('button', { name: 'Add inactive shared configuration' })
    );
    await screen.findByText(/Check configuration fields/);
    expect(operations['administration.server-mcp-create']).not.toHaveBeenCalled();
    expect(
      JSON.stringify(
        operations.cache
          .getMutationCache()
          .getAll()
          .map((mutation) => mutation.state)
      )
    ).not.toContain('ghp_fake_canary');
  });
});
