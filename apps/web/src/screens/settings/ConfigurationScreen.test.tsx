import { ApiCallError, type CoreClient } from '@openkit/core-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CoreClientProvider } from '../../app/core-client';
import { ConfigurationScreen } from './ConfigurationScreen';

const TIMESTAMP = '2026-08-30T00:00:00.000Z';
const PLAN = {
  previousVersion: 1,
  nextVersion: 2,
  applied: [],
  deferred: [],
  requiresRestart: [],
  rejected: [],
  warnings: [],
};
const RUNTIME_CONFIG = {
  currentVersion: 1,
  loadedAt: TIMESTAMP,
  lastReload: null,
  lastFailedReload: null,
  pendingRestart: [],
};
const FILES = {
  files: [
    {
      id: 'server.jsonc',
      kind: 'server' as const,
      path: 'server.jsonc',
      exists: true,
      revision: 'revision-1',
      updatedAt: TIMESTAMP,
    },
    {
      id: 'providers/openai.provider.jsonc',
      kind: 'provider' as const,
      path: 'providers/openai.provider.jsonc',
      exists: true,
      revision: 'provider-revision-1',
      updatedAt: TIMESTAMP,
    },
  ],
};

function makeClient(listFiles: CoreClient['runtimeConfig']['listFiles']): CoreClient {
  return {
    runtimeConfig: {
      listFiles,
      getSchemas: vi.fn().mockResolvedValue({
        schemas: [
          {
            kind: 'server',
            title: 'Server configuration',
            schema: { type: 'object', properties: { bind: { type: 'object' } } },
          },
          {
            kind: 'provider',
            title: 'Provider configuration',
            schema: { type: 'object', properties: { baseUrl: { type: 'string' } } },
          },
        ],
      }),
      getFile: vi.fn().mockResolvedValue({
        file: FILES.files[0],
        content: '{\n  // Public URL\n  "mode": "server"\n}\n',
      }),
      validate: vi.fn().mockResolvedValue({
        valid: true,
        diagnostics: [],
        plan: PLAN,
        runtimeConfig: RUNTIME_CONFIG,
      }),
      updateFile: vi.fn().mockResolvedValue({
        file: { ...FILES.files[0], revision: 'revision-2' },
        diagnostics: [],
      }),
      reload: vi.fn().mockResolvedValue({
        status: 'applied',
        plan: PLAN,
        runtimeConfig: RUNTIME_CONFIG,
      }),
    },
  } as unknown as CoreClient;
}

function renderScreen(client: CoreClient) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rendered = render(
    <QueryClientProvider client={queryClient}>
      <CoreClientProvider client={client}>
        <ConfigurationScreen />
      </CoreClientProvider>
    </QueryClientProvider>
  );
  return { ...rendered, queryClient };
}

beforeEach(() => {
  localStorage.clear();
});

describe('Configuration settings', () => {
  it('lists config files as a tree and validates, saves, and applies one JSONC draft', async () => {
    const user = userEvent.setup();
    const client = makeClient(vi.fn().mockResolvedValue(FILES));
    const { container } = renderScreen(client);

    expect(await screen.findByRole('tree', { name: 'Configuration files' })).toBeInTheDocument();
    expect(screen.getByText('providers')).toBeInTheDocument();
    const editor = await screen.findByRole('textbox', { name: 'server.jsonc source' });
    expect(container.querySelector('[data-jsonc-token="comment"]')).not.toBeNull();

    const draft = '{\n  "mode": "local"\n}\n';
    fireEvent.change(editor, { target: { value: draft } });
    await user.click(screen.getByRole('button', { name: 'Validate draft' }));
    await waitFor(() =>
      expect(client.runtimeConfig.validate).toHaveBeenLastCalledWith({
        files: [{ id: 'server.jsonc', content: draft }],
        mode: 'safe',
      })
    );
    expect(await screen.findByText('Draft is valid')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Save file' }));
    await waitFor(() =>
      expect(client.runtimeConfig.updateFile).toHaveBeenCalledWith({
        id: 'server.jsonc',
        kind: 'server',
        content: draft,
        expectedRevision: 'revision-1',
      })
    );
    expect(await screen.findByText('Saved')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Apply saved configuration' }));
    await waitFor(() =>
      expect(client.runtimeConfig.reload).toHaveBeenCalledWith({ dryRun: false, mode: 'safe' })
    );
    expect(await screen.findByText('Configuration applied')).toBeInTheDocument();
  });

  it('shows access denied with retry and never asks for a server-admin token', async () => {
    const user = userEvent.setup();
    const listFiles = vi.fn().mockRejectedValue(
      new ApiCallError(403, 'Server-admin authority is required.', {
        code: 'runtime_config_admin_forbidden',
      })
    );
    const client = makeClient(listFiles);
    renderScreen(client);

    expect(await screen.findByText('Access denied')).toBeInTheDocument();
    expect(screen.queryByLabelText('Server admin token')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show schema' })).not.toBeInTheDocument();
    expect(client.runtimeConfig.getSchemas).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(listFiles).toHaveBeenCalledTimes(2));
  });

  it('keeps a conflicting draft until the user explicitly reloads the file', async () => {
    const user = userEvent.setup();
    const client = makeClient(vi.fn().mockResolvedValue(FILES));
    const getFile = vi.mocked(client.runtimeConfig.getFile);
    getFile
      .mockResolvedValueOnce({
        file: FILES.files[0],
        content: '{\n  "mode": "server"\n}\n',
      })
      .mockResolvedValueOnce({
        file: { ...FILES.files[0], revision: 'revision-remote' },
        content: '{\n  "mode": "remote"\n}\n',
      });
    vi.mocked(client.runtimeConfig.updateFile).mockRejectedValueOnce(
      new ApiCallError(409, 'revision conflict', { code: 'config_file_revision_conflict' })
    );
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderScreen(client);

    const editor = await screen.findByRole('textbox', { name: 'server.jsonc source' });
    const localDraft = '{\n  "mode": "local"\n}\n';
    fireEvent.change(editor, { target: { value: localDraft } });
    await user.click(screen.getByRole('button', { name: 'Save file' }));

    expect(
      await screen.findByText(
        'This file changed after it was opened. Reload it before saving your draft.'
      )
    ).toBeInTheDocument();
    expect(editor).toHaveValue(localDraft);

    await user.click(screen.getByRole('button', { name: 'Reload file' }));
    await waitFor(() => expect(editor).toHaveValue('{\n  "mode": "remote"\n}\n'));
    expect(getFile).toHaveBeenCalledTimes(2);
  });

  it('loads the server-owned schema on demand and follows the selected file kind', async () => {
    const user = userEvent.setup();
    const client = makeClient(vi.fn().mockResolvedValue(FILES));
    renderScreen(client);

    await screen.findByRole('textbox', { name: 'server.jsonc source' });
    expect(client.runtimeConfig.getSchemas).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Show schema' }));
    expect(
      await screen.findByRole('heading', { name: 'Server configuration' })
    ).toBeInTheDocument();
    expect(screen.getByLabelText('server JSON Schema')).toHaveTextContent('"bind"');
    expect(client.runtimeConfig.getSchemas).toHaveBeenCalledWith();

    vi.mocked(client.runtimeConfig.getFile).mockResolvedValue({
      file: FILES.files[1],
      content: '{}',
    });
    await user.click(screen.getByRole('treeitem', { name: 'openai.provider.jsonc' }));
    expect(
      await screen.findByRole('heading', { name: 'Provider configuration' })
    ).toBeInTheDocument();
    expect(screen.getByLabelText('provider JSON Schema')).toHaveTextContent('"baseUrl"');
    expect(screen.queryByLabelText('server JSON Schema')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Hide schema' }));
    expect(screen.queryByLabelText('provider JSON Schema')).not.toBeInTheDocument();
    expect(client.runtimeConfig.updateFile).not.toHaveBeenCalled();
    expect(client.runtimeConfig.reload).not.toHaveBeenCalled();
  });

  it.each([
    403, 500,
  ])('retries a schema failure (%s) without losing the configuration draft', async (status) => {
    const user = userEvent.setup();
    const client = makeClient(vi.fn().mockResolvedValue(FILES));
    vi.mocked(client.runtimeConfig.getSchemas).mockRejectedValueOnce(
      new ApiCallError(status, 'Unavailable')
    );
    renderScreen(client);

    const editor = await screen.findByRole('textbox', { name: 'server.jsonc source' });
    fireEvent.change(editor, { target: { value: '{"mode":"local"}' } });
    await user.click(screen.getByRole('button', { name: 'Show schema' }));
    expect(
      await screen.findByText(
        status === 403
          ? 'Schema access denied. Deployment-admin authority is required.'
          : "Couldn't load configuration schemas."
      )
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('server JSON Schema')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Server admin token')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByLabelText('server JSON Schema')).toHaveTextContent('"bind"');
    expect(editor).toHaveValue('{"mode":"local"}');
    expect(client.runtimeConfig.getSchemas).toHaveBeenCalledTimes(2);
  });

  it('reports a missing file-kind schema without inventing one', async () => {
    const user = userEvent.setup();
    const client = makeClient(vi.fn().mockResolvedValue(FILES));
    vi.mocked(client.runtimeConfig.getSchemas).mockResolvedValue({ schemas: [] });
    renderScreen(client);
    await user.click(await screen.findByRole('button', { name: 'Show schema' }));
    expect(await screen.findByText('No schema available for server.')).toBeInTheDocument();
    expect(screen.queryByLabelText('server JSON Schema')).not.toBeInTheDocument();
  });
});
