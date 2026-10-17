import { ApiCallError } from '@openkit/core-client';
import { ArtifactSchema } from '@openkit/protocol';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArtifactVersionHistory } from './ArtifactVersionHistory';

const { list, read } = vi.hoisted(() => ({ list: vi.fn(), read: vi.fn() }));
vi.mock('../../app/core-client', () => ({
  useCoreClient: () => ({
    operations: { 'artifact.version-list': list, 'artifact.version-read': read },
    artifactFiles: {
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
});

/** Mounts real query state around controlled exact-version operations. */
function mount(artifact = current) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  const onVersionChange = vi.fn();
  const view = render(
    <QueryClientProvider client={client}>
      <ArtifactVersionHistory
        currentArtifact={artifact}
        disabled={false}
        onVersionChange={onVersionChange}
      />
    </QueryClientProvider>
  );
  return { ...view, client, onVersionChange };
}

describe('Artifact version history', () => {
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
    expect(view.onVersionChange).toHaveBeenLastCalledWith(1);
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
