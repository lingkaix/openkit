import { ApiCallError } from '@openkit/core-client';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DisconnectedBanner } from '../../../app/DisconnectedBanner';
import { ThreadStream } from '../ThreadStream';
import { client, Harness, page, queryOwner, THREAD, WS } from './__fixtures__/tw57fix';

vi.mock('../data', async (load) => ({
  ...(await load<typeof import('../data')>()),
  useCurrentWorkspaceId: (id: string) => id,
}));

const caches: ReturnType<typeof queryOwner>[] = [];
const HISTORY = 'Progress admitted before the source outage';

beforeEach(() => {
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
});

afterEach(() => {
  cleanup();
  for (const cache of caches.splice(0)) cache.clear();
  vi.unstubAllGlobals();
});

/** Read transports fail only after the real mount has admitted its initial history. */
function historyMount() {
  const cache = queryOwner();
  caches.push(cache);
  const failures = { history: null as unknown };
  const api = client(
    {
      'thread.timeline': async () => {
        if (failures.history) throw failures.history;
        return page(HISTORY);
      },
    },
    {
      meta: async () => {
        if (failures.history) throw failures.history;
        return {};
      },
    }
  );
  const view = render(
    <Harness api={api} cache={cache}>
      <DisconnectedBanner />
      <div data-testid="history-surface">
        <ThreadStream workspaceId={WS} threadId={THREAD} mode="task" />
      </div>
    </Harness>
  );
  return {
    surface: within(view.getByTestId('history-surface')),
    async fail(error: unknown) {
      failures.history = error;
      await act(async () => {
        await cache.refetchQueries({ type: 'active' });
      });
    },
  };
}

describe('recoverable timeline timeout', () => {
  it('keeps admitted history through HTTP 408 without a busy claim', async () => {
    const mounted = historyMount();
    await mounted.surface.findByText(HISTORY);
    await mounted.fail(new ApiCallError(408, 'Request timeout'));
    expect(mounted.surface.queryByText(HISTORY)).not.toBeNull();
    expect(mounted.surface.queryAllByText(/Updated|stale|last (loaded|load)/i)).not.toHaveLength(0);
    expect(await screen.findByText('Offline')).toBeVisible();
    expect(screen.queryByText(/OpenKit is busy/)).toBeNull();
  });

  it('still hides admitted history when the source is missing', async () => {
    const mounted = historyMount();
    await mounted.surface.findByText(HISTORY);
    await mounted.fail(new ApiCallError(404, 'Source not admitted'));
    expect(mounted.surface.queryByText(HISTORY)).toBeNull();
  });
});
