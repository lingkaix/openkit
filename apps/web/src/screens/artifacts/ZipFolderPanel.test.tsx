import { allocateEntityId } from '@openkit/protocol';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZipFolderPanel } from './ZipFolderPanel';

const { read, extract } = vi.hoisted(() => ({ read: vi.fn(), extract: vi.fn() }));
vi.mock('../../app/core-client', () => ({
  useCoreClient: () => ({
    operations: { 'artifact.folder-read': read, 'artifact.folder-extract': extract },
  }),
}));
const source = {
  workspaceId: allocateEntityId('ws'),
  artifactId: allocateEntityId('ar'),
  artifactVersion: 1,
  originalDigest: `sha256:${'a'.repeat(64)}`,
};
const original = {
  artifactId: source.artifactId,
  artifactVersion: 1,
  originalDigest: source.originalDigest,
  originalRetained: true,
};
const unavailable = { status: 'unavailable', ...original, reason: 'not_extracted' };
const ready = {
  status: 'ready',
  ...original,
  processor: 'openkit.zip.v1',
  representationDigest: `sha256:${'b'.repeat(64)}`,
  fileCount: 1,
  directoryCount: 0,
  expandedBytes: 9,
  entries: [{ relativePath: 'note.txt', byteLength: 9, contentDigest: `sha256:${'c'.repeat(64)}` }],
  nextOffset: null,
};
const clients: QueryClient[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.clear();
});
beforeEach(() => {
  vi.clearAllMocks();
  read.mockResolvedValue(unavailable);
  extract.mockResolvedValue(ready);
});

/** Real query and mutation state with controlled source-bound API responses. */
function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  const rendered = render(
    <QueryClientProvider client={client}>
      <ZipFolderPanel source={source} disabled={false} />
    </QueryClientProvider>
  );
  return { client, ...rendered };
}

describe('explicit ZIP folder choice', () => {
  it('does not extract automatically and shows only the verified inventory after the explicit choice', async () => {
    mount();
    const button = await screen.findByRole('button', { name: 'Extract ZIP as folder' });
    await waitFor(() => expect(button).toBeEnabled());
    expect(extract).not.toHaveBeenCalled();
    expect(screen.queryByText(/note.txt/)).not.toBeInTheDocument();
    read.mockResolvedValue(ready);
    await userEvent.click(button);
    expect(await screen.findByText('note.txt · 9 bytes')).toBeInTheDocument();
    expect(extract).toHaveBeenCalledWith({
      workspaceId: source.workspaceId,
      artifactId: source.artifactId,
      artifactVersion: 1,
      offset: 0,
    });
  });

  it('reports failure and retries extraction from the same original without importing again', async () => {
    extract.mockResolvedValue({ ...unavailable, reason: 'extraction_failed' });
    mount();
    const button = await screen.findByRole('button', { name: 'Extract ZIP as folder' });
    await waitFor(() => expect(button).toBeEnabled());
    await userEvent.click(button);
    expect(await screen.findByText(/Folder extraction did not complete/)).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Retry folder extraction' })).toBeEnabled()
    );
    await userEvent.click(screen.getByRole('button', { name: 'Retry folder extraction' }));
    expect(extract.mock.calls[1]).toEqual(extract.mock.calls[0]);
  });

  it('hides previously cached names when a current read fails', async () => {
    read.mockResolvedValue(ready);
    const view = mount();
    expect(await screen.findByText('note.txt · 9 bytes')).toBeInTheDocument();
    read.mockRejectedValue(new Error('current access refused'));
    await act(async () => {
      await view.client.invalidateQueries({ queryKey: ['artifact-folder'] });
    });
    expect(
      await screen.findByText('Folder status is unavailable. Check the original download.')
    ).toBeInTheDocument();
    expect(screen.queryByText('note.txt · 9 bytes')).not.toBeInTheDocument();
  });

  it('hides cached names after a current extraction request fails', async () => {
    read.mockResolvedValue(ready);
    extract.mockRejectedValue(new Error('current access refused'));
    mount();
    expect(await screen.findByText('note.txt · 9 bytes')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Recheck folder snapshot' }));
    expect(await screen.findByText(/Folder extraction is unconfirmed/)).toBeInTheDocument();
    expect(screen.queryByText('note.txt · 9 bytes')).not.toBeInTheDocument();
  });

  it('refuses a response for a different original digest', async () => {
    read.mockResolvedValue({ ...ready, originalDigest: `sha256:${'d'.repeat(64)}` });
    mount();
    expect(
      await screen.findByText('Folder status is unavailable. Check the original download.')
    ).toBeInTheDocument();
    expect(screen.queryByText('note.txt · 9 bytes')).not.toBeInTheDocument();
  });
});
