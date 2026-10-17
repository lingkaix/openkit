import { ApiCallError } from '@openkit/core-client';
import { ArtifactSchema } from '@openkit/protocol';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArtifactVersionHistory } from './ArtifactVersionHistory';

const { list, read, headRead, commit, commitFile, threads } = vi.hoisted(() => ({
  list: vi.fn(),
  read: vi.fn(),
  headRead: vi.fn(),
  commit: vi.fn(),
  commitFile: vi.fn(),
  threads: vi.fn(),
}));
vi.mock('../../app/core-client', () => ({
  useCoreClient: () => ({
    operations: {
      'artifact.version-list': list,
      'artifact.version-read': read,
      'artifact.read': headRead,
      'artifact.version-commit': commit,
      'thread.list': threads,
    },
    artifactFiles: {
      commitVersion: commitFile,
      browserDownloadUrl: (input: { artifactId: string; artifactVersion: number }) =>
        `/download/${input.artifactId}/${input.artifactVersion}`,
    },
  }),
}));

const recordedAt = '2026-10-17T01:00:00.000Z';
const actor = { kind: 'user' as const, id: 'usr_00000000-0000-7000-8000-000000000001' };
const first = ArtifactSchema.parse({
  id: 'ar_00000000-0000-7000-8000-000000000002',
  workspaceId: 'ws_00000000-0000-7000-8000-000000000003',
  threadId: null,
  turnId: null,
  kind: 'file',
  title: 'Retained report',
  status: 'ready',
  summary: null,
  version: 1,
  content: { format: 'markdown', body: '# Exact first version\n' },
  contentDigest: `sha256:${'a'.repeat(64)}`,
  lastMutationRequestId: 'req_first',
  origin: {
    kind: 'imported',
    sourceKind: 'direct-import',
    sourceId: 'req_first',
    sourceDigest: `sha256:${'a'.repeat(64)}`,
    actor,
    requestId: 'req_first',
    recordedAt,
  },
  createdAt: recordedAt,
  updatedAt: recordedAt,
});
const current = ArtifactSchema.parse({
  ...first,
  version: 2,
  content: { format: 'markdown', body: '# Exact second version\n' },
  contentDigest: `sha256:${'b'.repeat(64)}`,
  lastMutationRequestId: 'req_second',
});
const firstVersion = {
  workspaceId: first.workspaceId,
  artifactId: first.id,
  artifactVersion: 1,
  parentVersion: null,
  contentDigest: first.contentDigest,
  title: first.title,
  summary: first.summary,
  actor,
  threadId: null,
  turnId: null,
  requestId: 'req_first',
  recordedAt,
};
const secondVersion = {
  ...firstVersion,
  artifactVersion: 2,
  parentVersion: 1,
  contentDigest: current.contentDigest,
  threadId: 'th_00000000-0000-7000-8000-000000000004',
  turnId: 'tu_00000000-0000-7000-8000-000000000005',
  requestId: 'req_second',
};
const clients: QueryClient[] = [];

afterEach(() => {
  for (const client of clients.splice(0)) client.clear();
});
beforeEach(() => {
  vi.clearAllMocks();
  list.mockResolvedValue({ items: [firstVersion, secondVersion] });
  read.mockResolvedValue({ artifact: first, version: firstVersion });
  headRead.mockResolvedValue(current);
  threads.mockResolvedValue({
    items: [
      {
        id: secondVersion.threadId,
        name: 'Report discussion',
        visibility: 'workspace',
        status: 'active',
      },
    ],
  });
  commit.mockRejectedValue(new Error('uncertain private transport failure'));
  commitFile.mockRejectedValue(new Error('uncertain private transport failure'));
});

/** Mounts real query state around controlled exact-version operations. */
function mount(artifact = current) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  const onVersionChange = vi.fn();
  const content = (artifact: typeof current) => (
    <QueryClientProvider client={client}>
      <ArtifactVersionHistory
        currentArtifact={artifact}
        disabled={false}
        onVersionChange={onVersionChange}
      />
    </QueryClientProvider>
  );
  const view = render(content(artifact));
  return {
    ...view,
    client,
    onVersionChange,
    showHead: (next: typeof current) => view.rerender(content(next)),
  };
}

describe('Artifact version history', () => {
  it('keeps an unknown commit frozen when another version becomes the current head', async () => {
    const view = mount();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Create next version' }));
    await user.click(await screen.findByRole('button', { name: /Publishing conversation/ }));
    await user.click(await screen.findByRole('option', { name: 'Report discussion' }));
    await user.click(screen.getByRole('button', { name: 'Save new version' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The result is unknown.');
    const advanced = ArtifactSchema.parse({
      ...current,
      version: 3,
      content: { format: 'markdown', body: '# Another committed version' },
      contentDigest: `sha256:${'c'.repeat(64)}`,
      lastMutationRequestId: 'req_third',
    });
    list.mockResolvedValue({
      items: [
        firstVersion,
        secondVersion,
        {
          ...secondVersion,
          artifactVersion: 3,
          parentVersion: 2,
          contentDigest: advanced.contentDigest,
          requestId: 'req_third',
        },
      ],
    });
    headRead.mockResolvedValue(advanced);
    view.showHead(advanced);
    await user.click(await screen.findByRole('button', { name: 'View version 3' }));
    await user.click(screen.getByRole('button', { name: 'Refresh current version' }));
    await waitFor(() => expect(headRead).toHaveBeenCalledTimes(2));
    expect(
      screen.queryByRole('button', { name: 'Use version 3 as parent' })
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save new version' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Retry same version request' }));
    await waitFor(() => expect(commit).toHaveBeenCalledTimes(2));
    expect(commit.mock.calls[1]).toEqual(commit.mock.calls[0]);
    expect(commit.mock.calls[1][0].expectedArtifactVersion).toBe(2);
  });

  it('streams exact selected replacement bytes with their digest under the retained parent', async () => {
    // JSDOM needs FileReader to supply the browser Blob byte-read method.
    Object.defineProperty(Blob.prototype, 'arrayBuffer', {
      configurable: true,
      value: function (this: Blob) {
        return new Promise<ArrayBuffer>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as ArrayBuffer);
          reader.onerror = () => reject(reader.error);
          reader.readAsArrayBuffer(this);
        });
      },
    });
    mount();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Create next version' }));
    await user.click(await screen.findByRole('button', { name: /Publishing conversation/ }));
    await user.click(await screen.findByRole('option', { name: 'Report discussion' }));
    const file = new File([new Uint8Array([0, 255, 128, 13, 10])], 'replacement.bin', {
      type: 'application/octet-stream',
    });
    await user.upload(document.querySelector('input[type="file"]') as HTMLInputElement, file);
    await user.click(screen.getByRole('button', { name: 'Save new version' }));
    await waitFor(() => expect(commitFile).toHaveBeenCalledTimes(1));
    expect(commitFile.mock.calls[0]).toEqual([
      expect.objectContaining({
        workspaceId: current.workspaceId,
        artifactId: current.id,
        threadId: secondVersion.threadId,
        expectedArtifactVersion: 2,
        byteLength: 5,
        mediaType: 'application/octet-stream',
        contentDigest: 'sha256:6171db06a1c89b1ff8ab77e479d5df976ccd88a7b63567b4b18f413649e12ff3',
      }),
      file,
    ]);
    expect(commit).not.toHaveBeenCalled();
  });

  it('renders binary originals as metadata and exact downloads without a text preview', async () => {
    mount(
      ArtifactSchema.parse({
        ...current,
        content: { format: 'file', mediaType: 'application/octet-stream', byteLength: 5 },
      })
    );
    expect(await screen.findByText('application/octet-stream')).toBeInTheDocument();
    expect(screen.getByText('5 bytes')).toBeInTheDocument();
    expect(screen.queryByText('# Exact second version')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Download original' })).toHaveAttribute(
      'href',
      `/download/${current.id}/2`
    );
  });

  it('requires a current read and explicit parent choice after a version conflict', async () => {
    commit.mockRejectedValue(new ApiCallError(409, 'private conflict', { code: 'conflict' }));
    mount();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Create next version' }));
    await user.click(await screen.findByRole('button', { name: /Publishing conversation/ }));
    await user.click(await screen.findByRole('option', { name: 'Report discussion' }));
    await user.click(screen.getByRole('button', { name: 'Save new version' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The artifact changed.');
    expect(
      screen.queryByRole('button', { name: 'Retry same version request' })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Use version 2 as parent' })
    ).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Version content' })).toHaveValue(
      current.content.format === 'file' ? '' : current.content.body
    );
    await user.click(screen.getByRole('button', { name: 'Refresh current version' }));
    await user.click(await screen.findByRole('button', { name: 'Use version 2 as parent' }));
    expect(screen.getByRole('button', { name: 'Save new version' })).toBeEnabled();
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('retains the edited next-version draft and retries an uncertain commit with the same request', async () => {
    mount();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Create next version' }));
    const content = await screen.findByRole('textbox', { name: 'Version content' });
    await user.clear(content);
    await user.type(content, '# Explicit next version');
    await user.click(screen.getByRole('button', { name: /Publishing conversation/ }));
    await user.click(await screen.findByRole('option', { name: 'Report discussion' }));
    await user.click(screen.getByRole('button', { name: 'Save new version' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The result is unknown.');
    expect(alert).not.toHaveTextContent('private transport');
    expect(content).toHaveValue('# Explicit next version');
    expect(screen.getByRole('button', { name: 'Save new version' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Retry same version request' }));
    await waitFor(() => expect(commit).toHaveBeenCalledTimes(2));
    expect(commit.mock.calls[1]).toEqual(commit.mock.calls[0]);
    expect(commit.mock.calls[0][0]).toMatchObject({
      workspaceId: current.workspaceId,
      artifactId: current.id,
      threadId: secondVersion.threadId,
      expectedArtifactVersion: 2,
      content: { format: 'markdown', body: '# Explicit next version' },
    });
  });

  it('inspects exact retained content and provenance without changing the current head', async () => {
    const view = mount();
    expect(await screen.findByText('Current head: version 2')).toBeInTheDocument();
    expect(await screen.findByText('# Exact second version')).toBeInTheDocument();
    expect(screen.getByText('Version 1', { exact: true })).toBeInTheDocument();
    expect(screen.getByText(actor.id)).toBeInTheDocument();
    expect(screen.getByText(secondVersion.turnId)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'View version 1' }));
    expect(await screen.findByText('# Exact first version')).toBeInTheDocument();
    expect(screen.queryByText('# Exact second version')).not.toBeInTheDocument();
    expect(screen.getByText('No parent')).toBeInTheDocument();
    expect(screen.getByText(first.contentDigest)).toBeInTheDocument();
    expect(screen.getByText(recordedAt)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Download original' })).toHaveAttribute(
      'href',
      `/download/${first.id}/1`
    );
    expect(read).toHaveBeenCalledWith({
      workspaceId: first.workspaceId,
      artifactId: first.id,
      artifactVersion: 1,
    });
    expect(view.onVersionChange).toHaveBeenLastCalledWith(1, true);
    expect(screen.getByText('Current head: version 2')).toBeInTheDocument();
  });

  it('does not let a late historical read replace a newly selected version', async () => {
    let settle!: (value: { artifact: typeof first; version: typeof firstVersion }) => void;
    read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        })
    );
    mount();
    await userEvent.click(await screen.findByRole('button', { name: 'View version 1' }));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('# Exact second version')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'View version 2' }));
    expect(await screen.findByText('# Exact second version')).toBeInTheDocument();
    await act(async () => settle({ artifact: first, version: firstVersion }));
    expect(screen.queryByText('# Exact first version')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Download original' })).toHaveAttribute(
      'href',
      `/download/${current.id}/2`
    );
  });

  it('hides retained bytes and download when current history access fails, then retries the read', async () => {
    const view = mount();
    await userEvent.click(await screen.findByRole('button', { name: 'View version 1' }));
    expect(await screen.findByText('# Exact first version')).toBeInTheDocument();
    list.mockRejectedValue(
      new ApiCallError(403, 'private denial', { code: 'workspace_access_denied' })
    );
    await act(async () => {
      await view.client.invalidateQueries({ queryKey: ['artifact-versions'] });
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('Access denied.');
    expect(screen.queryByText('# Exact first version')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Download original' })).not.toBeInTheDocument();
    expect(screen.queryByText('private denial')).not.toBeInTheDocument();
    list.mockResolvedValue({ items: [firstVersion, secondVersion] });
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('# Exact first version')).toBeInTheDocument();
  });

  it('refuses a current-head substitution for a requested historical version', async () => {
    read.mockResolvedValue({ artifact: current, version: secondVersion });
    mount();
    await userEvent.click(await screen.findByRole('button', { name: 'View version 1' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load that version.");
    expect(screen.queryByText('# Exact second version')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Download original' })).not.toBeInTheDocument();
  });
});
