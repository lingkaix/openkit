import type { CoreClient } from '@openkit/core-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { expect, it, vi } from 'vitest';
import { CoreClientProvider } from '../../app/core-client';
import { DebugScreen } from './DebugScreen';

vi.mock('./data', async (load) => ({
  ...(await load<typeof import('./data')>()),
  useCurrentWorkspaceId: () => 'ws_test',
  useWorkspaces: () => ({ isLoading: false, isError: false }),
  useEvidenceBundles: () => ({ data: [] }),
  useRuntimeEvidence: () => ({ data: [] }),
}));

it('reads exact Turn Skill lineage on inspection without exposing the rest of the snapshot', async () => {
  const digest = `sha256:${'a'.repeat(64)}`;
  const read = vi.fn().mockResolvedValue({
    snapshotId: 'snapshot-one',
    packageId: 'package-one',
    runtimeKind: 'opencode',
    workspaceId: 'ws_test',
    threadId: 'th_test',
    turnId: 'tu_test',
    snapshot: {
      supply: {
        skills: [
          {
            id: 'admissions',
            integrity: { sha256: digest },
            selectionSource: 'pin',
            target: '/private/worker/path',
            extra: 'unpublished-skill-data',
          },
        ],
        extra: 'unpublished-supply-data',
      },
      extra: 'unpublished-snapshot-data',
    },
  });
  const client = {
    operations: {
      'environment.snapshot-list': vi
        .fn()
        .mockResolvedValue({ items: [{ snapshotId: 'snapshot-one' }] }),
      'environment.snapshot-read': read,
    },
  } as unknown as CoreClient;
  render(
    <MemoryRouter>
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <CoreClientProvider client={client}>
          <DebugScreen />
        </CoreClientProvider>
      </QueryClientProvider>
    </MemoryRouter>
  );
  expect(await screen.findByRole('button', { name: 'snapshot-one' })).toBeInTheDocument();
  expect(read).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button', { name: 'snapshot-one' }));
  expect(await screen.findByText(digest)).toBeInTheDocument();
  expect(screen.getByText('admissions')).toBeInTheDocument();
  expect(screen.getByText('Selection source: pin')).toBeInTheDocument();
  expect(screen.getByText('Turn: tu_test')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Open Thread th_test' })).toHaveAttribute(
    'href',
    '/chat/ws_test/th_test'
  );
  expect(read).toHaveBeenCalledWith({ workspaceId: 'ws_test', snapshotId: 'snapshot-one' });
  expect(document.body.textContent).not.toMatch(/unpublished-|\/private\/worker/);
});
