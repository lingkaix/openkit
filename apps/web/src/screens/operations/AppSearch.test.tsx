import { ApiCallError, type CoreClient } from '@openkit/core-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { CoreClientProvider } from '../../app/core-client';
import { AppSearch } from './AppSearch';
import { operationsKeys } from './data';

const QUERY = 'planning';
const RESPONSE = {
  items: [{ kind: 'thread', id: 'private-thread', workspaceId: 'ws1', title: 'Private plan' }],
};

/** Controls transport completion independently of query cancellation. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

/** Uses the published search and discovery hooks with the production stale time. */
function searchHarness(search = vi.fn().mockResolvedValue(RESPONSE)) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 5_000 } },
  });
  const client = {
    core: { meta: vi.fn().mockResolvedValue({}) },
    operations: {
      'workspace.list': vi.fn().mockResolvedValue({
        items: [{ workspace: { id: 'ws1', name: 'Team' } }],
      }),
      'app.search': search,
    },
  } as unknown as CoreClient;
  const mount = () =>
    render(
      <QueryClientProvider client={queryClient}>
        <CoreClientProvider client={client}>
          <MemoryRouter>
            <AppSearch />
          </MemoryRouter>
        </CoreClientProvider>
      </QueryClientProvider>
    );
  const submit = async () => {
    const field = screen.getByRole('searchbox', { name: 'Search' });
    await userEvent.type(field, `${QUERY}{Enter}`);
  };
  return { mount, queryClient, search, submit };
}

describe('current search observations', () => {
  it.each([
    401, 403, 500,
  ])('hides prior private hits after a current %s and during retry', async (status) => {
    const { mount, queryClient, search, submit } = searchHarness();
    mount();
    await submit();
    expect(await screen.findByRole('button', { name: 'Private plan' })).toBeEnabled();
    search.mockRejectedValueOnce(new ApiCallError(status, 'Private failure body'));
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: operationsKeys.search(QUERY), exact: true });
    });
    expect(await screen.findByText("Couldn't search.")).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Private plan' })).not.toBeInTheDocument();
    expect(screen.queryByText('No search results')).not.toBeInTheDocument();
    const current = deferred<typeof RESPONSE>();
    search.mockImplementationOnce(() => current.promise);
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(search).toHaveBeenCalledTimes(3));
    expect(screen.queryByRole('button', { name: 'Private plan' })).not.toBeInTheDocument();
    await act(async () => {
      current.resolve({ items: [{ ...RESPONSE.items[0]!, title: 'Current plan' }] });
      await current.promise;
    });
    expect(await screen.findByRole('button', { name: 'Current plan' })).toBeEnabled();
    expect(screen.queryByText('Private plan')).not.toBeInTheDocument();
  });

  it('checks a fresh cached query before showing hits on a later mount', async () => {
    const { mount, search, submit } = searchHarness();
    const previous = mount();
    await submit();
    await screen.findByRole('button', { name: 'Private plan' });
    previous.unmount();
    const current = deferred<typeof RESPONSE>();
    search.mockImplementationOnce(() => current.promise);
    mount();
    await submit();
    await waitFor(() => expect(search).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('button', { name: 'Private plan' })).not.toBeInTheDocument();
    await act(async () => {
      current.resolve({ items: [{ ...RESPONSE.items[0]!, title: 'Current plan' }] });
      await current.promise;
    });
    expect(await screen.findByRole('button', { name: 'Current plan' })).toBeEnabled();
  });

  it('does not reuse a departed mount transport for a later search', async () => {
    const previousRead = deferred<typeof RESPONSE>();
    const currentRead = deferred<typeof RESPONSE>();
    const search = vi
      .fn()
      .mockImplementationOnce(() => previousRead.promise)
      .mockImplementationOnce(() => currentRead.promise);
    const { mount, submit } = searchHarness(search);
    const previous = mount();
    await submit();
    await waitFor(() => expect(search).toHaveBeenCalledTimes(1));
    previous.unmount();
    mount();
    await submit();
    await waitFor(() => expect(search).toHaveBeenCalledTimes(2));
    await act(async () => {
      previousRead.resolve(RESPONSE);
      await previousRead.promise;
    });
    expect(screen.queryByRole('button', { name: 'Private plan' })).not.toBeInTheDocument();
    await act(async () => {
      currentRead.resolve({ items: [{ ...RESPONSE.items[0]!, title: 'Current plan' }] });
      await currentRead.promise;
    });
    expect(await screen.findByRole('button', { name: 'Current plan' })).toBeEnabled();
  });
});
