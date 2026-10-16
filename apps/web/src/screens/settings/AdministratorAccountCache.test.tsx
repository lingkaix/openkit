import type { CoreClient } from '@openkit/core-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { CoreClientProvider } from '../../app/core-client';
import {
  type AccountMutationRequest,
  accountAdmissionKey,
  useAccountAdmission,
  useAccountMutation,
} from '../account/session';
import { operationsKeys } from '../operations/data';
import { MyAdminAccessScreen } from './MyAdminAccessScreen';

const OPERATIONS = ['signIn', 'signUp', 'signOut'] as const;
const ADMIN_KEY = ['settings', 'my-admin-tokens'] as const;

/** Keeps a transport result under the test's control, including after query removal. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

/** Exercises the real account hooks with a shared query owner and stubbed auth transports. */
function accountHarness(
  onAdmission: () => void = () => {},
  operations: Partial<CoreClient['operations']> = {}
) {
  const queryClient = new QueryClient({
    defaultOptions: {
      mutations: { retry: false },
      queries: { retry: false, staleTime: Infinity },
    },
  });
  queryClient.setQueryData(accountAdmissionKey, { items: [] });
  const auth = {
    signIn: vi.fn().mockResolvedValue(undefined),
    signUp: vi.fn().mockResolvedValue(undefined),
    signOut: vi.fn().mockResolvedValue(undefined),
  };
  const admission = vi.fn(async () => {
    onAdmission();
    return { items: [] };
  });
  const client = {
    auth: { email: auth },
    operations: { 'workspace.list': admission, ...operations },
  } as unknown as CoreClient;
  const hooks = renderHook(
    () => ({ admission: useAccountAdmission(), mutation: useAccountMutation() }),
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>
          <CoreClientProvider client={client}>{children}</CoreClientProvider>
        </QueryClientProvider>
      ),
    }
  );
  const transition = async (operation: AccountMutationRequest['operation']) => {
    await act(async () => {
      await hooks.result.current.mutation.mutateAsync({
        operation,
        email: '',
        password: '',
        name: '',
      });
    });
  };
  return { admission, auth, client, hooks, queryClient, transition };
}

/** Builds redacted owned-token metadata without token credentials. */
function adminRows(ownerUserId: string, tokenIds: string[]) {
  return {
    defaultTokenId: tokenIds[0],
    items: tokenIds.map((tokenId) => ({
      tokenId,
      ownerUserId,
      scope: 'server-admin' as const,
      workspaceIds: [],
      status: 'active' as const,
      issuedAt: '2026-08-30T00:00:00.000Z',
      expiresAt: '2027-08-30T00:00:00.000Z',
      revokedAt: null,
      predecessorTokenId: null,
      rotatedGraceExpiresAt: null,
      lastUsedAt: null,
      lastUsedChannel: null,
      lastUsedSource: null,
    })),
  };
}

describe('administrator read cache at account transitions', () => {
  it('does not publish an earlier account default-selection result into the current account list', async () => {
    const oldRows = adminRows('previous-user', ['previous-default', 'previous-selection']);
    const currentRows = adminRows('current-user', ['current-default']);
    const selection = deferred<ReturnType<typeof adminRows>>();
    const list = vi.fn().mockResolvedValueOnce(oldRows).mockResolvedValue(currentRows);
    const select = vi.fn(() => selection.promise);
    const { client, queryClient, transition } = accountHarness(() => {}, {
      'token.my-admin-list': list,
      'token.my-admin-default': select,
    });
    queryClient.setDefaultOptions({ queries: { retry: false }, mutations: { retry: false } });
    const mountSettings = () =>
      render(
        <QueryClientProvider client={queryClient}>
          <CoreClientProvider client={client}>
            <MyAdminAccessScreen />
          </CoreClientProvider>
        </QueryClientProvider>
      );
    const previousView = mountSettings();
    await screen.findByText('previous-selection');
    await userEvent.click(screen.getByRole('radio', { name: 'previous-selection (active)' }));
    await waitFor(() => expect(select).toHaveBeenCalledTimes(1));
    const mutation = queryClient
      .getMutationCache()
      .getAll()
      .find((candidate) => candidate.state.variables === 'previous-selection');
    expect(mutation?.state.status).toBe('pending');
    const pendingState = mutation?.state;

    await transition('signIn');
    previousView.unmount();
    expect(queryClient.getMutationCache().getAll()).toContain(mutation);
    expect(mutation?.state).toBe(pendingState);
    mountSettings();
    await screen.findByText('current-default');
    expect(queryClient.getQueryData(ADMIN_KEY)).toEqual(currentRows);

    await act(async () => {
      selection.resolve({ ...oldRows, defaultTokenId: 'previous-selection' });
      await selection.promise;
    });
    await waitFor(() => expect(mutation?.state.status).toBe('success'));
    expect(queryClient.getMutationCache().getAll()).toContain(mutation);
    expect(queryClient.getQueryData(ADMIN_KEY)).toEqual(currentRows);
    expect(screen.getByText('current-default')).toBeInTheDocument();
    expect(screen.queryByText('previous-default')).not.toBeInTheDocument();
    expect(screen.queryByText('previous-selection')).not.toBeInTheDocument();
  });

  describe.each([
    { name: 'Settings', prefix: ['settings'], readKey: ADMIN_KEY },
    { name: 'Operations', prefix: ['operations'], readKey: operationsKeys.search('private') },
  ])('$name reads', ({ prefix, readKey }) => {
    it.each(
      OPERATIONS
    )('%s removes fresh reads before protected admission and preserves other state', async (operation) => {
      let settingsAtAdmission: unknown;
      const harness = accountHarness(() => {
        settingsAtAdmission = harness.queryClient
          .getQueryCache()
          .findAll({ queryKey: prefix })
          .map((query) => ({ key: query.queryKey, data: query.state.data }));
      });
      const { queryClient, transition } = harness;
      const oldRows = { items: [{ ownerUserId: 'previous-user' }] };
      queryClient.setQueryData(readKey, oldRows);
      queryClient.setQueryData([...prefix, 'nested', 'rows'], { items: ['previous-grant'] });
      queryClient.setQueryData(prefix, { previous: true });

      const settledKey = ['settings-adjacent', 'settled'] as const;
      const pendingKey = ['unrelated', 'pending'] as const;
      const settledRows = { retained: 'settled-query' };
      queryClient.setQueryData(settledKey, settledRows);
      const pendingRead = deferred<{ retained: string }>();
      const pendingQueryPromise = queryClient.fetchQuery({
        queryKey: pendingKey,
        queryFn: () => pendingRead.promise,
      });
      const settledQuery = queryClient.getQueryCache().find({ queryKey: settledKey, exact: true });
      const pendingQuery = queryClient.getQueryCache().find({ queryKey: pendingKey, exact: true });
      const pendingCommand = deferred<{ retained: string }>();
      const pendingMutation = queryClient.getMutationCache().build(queryClient, {
        mutationKey: [...prefix, 'command'],
        mutationFn: () => pendingCommand.promise,
      });
      const pendingMutationPromise = pendingMutation.execute(undefined);
      const settledMutation = queryClient.getMutationCache().build(queryClient, {
        mutationKey: ['unrelated', 'settled-command'],
        mutationFn: async () => ({ retained: 'settled-command' }),
      });
      await settledMutation.execute(undefined);
      const states = {
        pendingMutation: pendingMutation.state,
        pendingQuery: pendingQuery?.state,
        settledMutation: settledMutation.state,
        settledQuery: settledQuery?.state,
      };

      await transition(operation);

      expect(harness.auth[operation]).toHaveBeenCalledTimes(1);
      expect(harness.admission).toHaveBeenCalledTimes(1);
      expect(settingsAtAdmission).toEqual([]);
      expect(queryClient.getQueryCache().findAll({ queryKey: prefix })).toEqual([]);
      expect(queryClient.getQueryCache().find({ queryKey: pendingKey, exact: true })).toBe(
        pendingQuery
      );
      expect(queryClient.getQueryCache().find({ queryKey: settledKey, exact: true })).toBe(
        settledQuery
      );
      expect(pendingQuery?.state).toBe(states.pendingQuery);
      expect(settledQuery?.state).toBe(states.settledQuery);
      expect(queryClient.getMutationCache().getAll()).toContain(pendingMutation);
      expect(queryClient.getMutationCache().getAll()).toContain(settledMutation);
      expect(pendingMutation.state).toBe(states.pendingMutation);
      expect(settledMutation.state).toBe(states.settledMutation);

      const newRows = { items: [{ ownerUserId: 'current-user' }] };
      const freshRead = vi.fn().mockResolvedValue(newRows);
      await expect(
        queryClient.ensureQueryData({ queryKey: readKey, queryFn: freshRead })
      ).resolves.toEqual(newRows);
      expect(freshRead).toHaveBeenCalledTimes(1);
      expect(queryClient.getQueryData(readKey)).toEqual(newRows);
      pendingRead.resolve({ retained: 'pending-query' });
      pendingCommand.resolve({ retained: 'pending-command' });
      await Promise.all([pendingQueryPromise, pendingMutationPromise]);
      expect(queryClient.getQueryData(pendingKey)).toEqual({ retained: 'pending-query' });
      expect(pendingMutation.state.data).toEqual({ retained: 'pending-command' });
    });

    it.each(
      OPERATIONS
    )('%s disposes pending reads even when the transport ignores cancellation', async (operation) => {
      const { queryClient, transition } = accountHarness();
      const oldRead = deferred<{ items: string[] }>();
      const oldPromise = queryClient
        .fetchQuery({ queryKey: readKey, queryFn: () => oldRead.promise })
        .catch((error: unknown) => error);
      const oldQuery = queryClient.getQueryCache().find({ queryKey: readKey, exact: true });
      expect(oldQuery?.state.fetchStatus).toBe('fetching');

      await transition(operation);

      const retainedAtTransition = queryClient
        .getQueryCache()
        .find({ queryKey: readKey, exact: true });
      const currentRead = deferred<{ items: string[] }>();
      const freshRead = vi.fn(() => currentRead.promise);
      const currentPromise = queryClient.ensureQueryData({ queryKey: readKey, queryFn: freshRead });
      const currentQuery = queryClient.getQueryCache().find({ queryKey: readKey, exact: true });
      oldRead.resolve({ items: ['previous-user-private-row'] });
      await oldPromise;
      expect(queryClient.getQueryData(readKey)).toBeUndefined();
      expect(retainedAtTransition).toBeUndefined();
      expect(freshRead).toHaveBeenCalledTimes(1);
      expect(currentQuery).not.toBe(oldQuery);
      expect(queryClient.getQueryCache().find({ queryKey: readKey, exact: true })).toBe(
        currentQuery
      );
      expect(currentQuery?.state.fetchStatus).toBe('fetching');
      currentRead.resolve({ items: ['current-user-row'] });
      await expect(currentPromise).resolves.toEqual({ items: ['current-user-row'] });
      expect(queryClient.getQueryData(readKey)).toEqual({ items: ['current-user-row'] });
      expect(oldQuery?.state.data).toBeUndefined();
    });

    it.each(
      OPERATIONS
    )('%s failure leaves settled and pending reads unchanged', async (operation) => {
      const { admission, auth, queryClient, transition } = accountHarness();
      auth[operation].mockRejectedValue(new Error('Account transport failed.'));
      queryClient.setQueryData(readKey, { items: ['same-user-row'] });
      const pendingKey = [...prefix, 'pending'] as const;
      const pendingRead = deferred<{ items: string[] }>();
      const pendingPromise = queryClient.fetchQuery({
        queryKey: pendingKey,
        queryFn: () => pendingRead.promise,
      });
      const settledQuery = queryClient.getQueryCache().find({ queryKey: readKey, exact: true });
      const pendingQuery = queryClient.getQueryCache().find({ queryKey: pendingKey, exact: true });
      const settledState = settledQuery?.state;
      const pendingState = pendingQuery?.state;

      await expect(transition(operation)).rejects.toThrow('The account operation failed.');

      await waitFor(() => expect(auth[operation]).toHaveBeenCalledTimes(1));
      expect(admission).not.toHaveBeenCalled();
      expect(queryClient.getQueryCache().find({ queryKey: readKey, exact: true })).toBe(
        settledQuery
      );
      expect(queryClient.getQueryCache().find({ queryKey: pendingKey, exact: true })).toBe(
        pendingQuery
      );
      expect(settledQuery?.state).toBe(settledState);
      expect(pendingQuery?.state).toBe(pendingState);
      pendingRead.resolve({ items: ['same-user-late-row'] });
      await pendingPromise;
      expect(queryClient.getQueryData(pendingKey)).toEqual({ items: ['same-user-late-row'] });
    });
  });
});
