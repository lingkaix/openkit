import type { CoreClient } from '@openkit/core-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoreClientProvider } from '../../app/core-client';
import { useThreadDashboard } from './data';

const WS = 'ws_poll';
const THREAD = 'th_poll';

function dashboard(status: 'completed' | 'running') {
  return {
    serverTime: '2026-11-13T03:00:00.000Z',
    turns: [{ id: 'tu_poll', status }],
  };
}

function client(read: () => Promise<unknown>): CoreClient {
  return {
    core: { meta: async () => ({}) },
    operations: { 'thread.dashboard': read },
  } as unknown as CoreClient;
}

function Probe() {
  useThreadDashboard(WS, THREAD, true, true);
  return null;
}

describe('dashboard poll cadence', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
  });

  it('polls an idle thread every 15s, a running thread every 5s, and not while hidden', async () => {
    let status: 'completed' | 'running' = 'completed';
    const read = vi.fn(async () => dashboard(status));
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <CoreClientProvider client={client(read)}>
          <Probe />
        </CoreClientProvider>
      </QueryClientProvider>
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(read).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(14_999);
    });
    expect(read).toHaveBeenCalledTimes(1);

    status = 'running';
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(read).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_999);
    });
    expect(read).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(read).toHaveBeenCalledTimes(3);

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(read).toHaveBeenCalledTimes(3);
  });
});
