import { ApiCallError } from '@openkit/core-client';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DisconnectedBanner } from '../../../app/DisconnectedBanner';
import { useLiveThreadItems } from '../data';
import { ThreadStream } from '../ThreadStream';
import {
  client,
  deferred,
  Harness,
  page,
  queryOwner,
  THREAD,
  TURN,
  WS,
} from './__fixtures__/tw57fix';
import { useRunItemWindow, useTimelineWindow } from './use-timeline-window';

const owners: ReturnType<typeof queryOwner>[] = [];
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
  for (const cache of owners.splice(0)) cache.clear();
  vi.unstubAllGlobals();
});

// Degraded Conditions: a non-denial failure keeps this mount's admitted view;
// denial must instead hide it. Drive the real read owner through its refresh boundary.
it('TW57FIX keeps admitted history readable and stale on 503, but hides it on denial', async () => {
  const cache = queryOwner();
  owners.push(cache);
  let status: number | null = null;
  const read = vi.fn(async () => {
    if (status) throw new ApiCallError(status, status === 503 ? 'Server busy' : 'Denied');
    return page('Admitted progress remains readable');
  });
  const api = client({ 'thread.timeline': read });
  render(
    <Harness api={api} cache={cache}>
      <ThreadStream workspaceId={WS} threadId={THREAD} mode="task" />
    </Harness>
  );
  await screen.findByText('Admitted progress remains readable');
  status = 503;
  await act(async () => {
    await cache.refetchQueries({ type: 'active' });
  });
  expect
    .soft(
      screen.queryByText('Admitted progress remains readable'),
      '503 must preserve the view admitted on this mount'
    )
    .not.toBeNull();
  expect
    .soft(
      screen.queryAllByText(/Updated|stale|last (loaded|load)/i),
      'The retained view must identify stale data'
    )
    .not.toHaveLength(0);
  status = 403;
  await act(async () => {
    await cache.refetchQueries({ type: 'active' });
  });
  expect(
    screen.queryByText('Admitted progress remains readable'),
    'Denied source data must disappear'
  ).not.toBeInTheDocument();
});

function ResyncReader() {
  const runs = useTimelineWindow({
    workspaceId: WS,
    threadId: THREAD,
    anchor: { kind: 'latest' },
    enabled: true,
    running: true,
    pending: false,
  });
  const items = useRunItemWindow({
    workspaceId: WS,
    threadId: THREAD,
    turnId: TURN,
    placement: 'narrative',
    enabled: true,
  });
  useLiveThreadItems(WS, THREAD, runs.isSuccess, runs.isSuccess && items.isSuccess);
  const runItem = runs.data?.runs[0]?.narrative[0];
  const stepItem = items.completeItems[0];
  return (
    <>
      <p>
        {runItem?.detail.kind === 'complete' && 'text' in runItem.detail.value
          ? runItem.detail.value.text
          : 'Checking run'}
      </p>
      <p>{stepItem && 'text' in stepItem ? stepItem.text : 'Checking open Item window'}</p>
    </>
  );
}

// Reconnect: cursor expiry requires authoritative snapshots, including in-place
// edits. TB4's dashboard fixture deliberately has items: [], as the contract requires.
describe('TW57FIX bounded resync', () => {
  it.each(['run', 'open Item window'] as const)(
    'recovers a lost edit in the active %s after cursor expiry',
    async (target) => {
      const cache = queryOwner();
      owners.push(cache);
      let edited = false;
      const dropped = deferred<IteratorResult<never>>();
      let reads = 0;
      const api = client(
        {
          'thread.timeline': async (input: { view?: string }) =>
            page(
              `${input.view === 'items' ? 'Open Item window' : 'Run'} ${edited ? 'recovered edit' : 'old text'}`,
              input.view === 'items' ? 'items' : 'runs'
            ),
        },
        {
          subscribeTurnEvents: () => ({
            [Symbol.asyncIterator]: () => ({
              next: () => {
                reads += 1;
                return reads === 1 ? dropped.promise : new Promise(() => {});
              },
              return: async () => ({ done: true }),
            }),
          }),
        }
      );
      render(
        <Harness api={api} cache={cache}>
          <DisconnectedBanner />
          <ResyncReader />
        </Harness>
      );
      await screen.findByText('Run old text');
      await screen.findByText('Open Item window old text');
      await waitFor(() => expect(reads).toBeGreaterThan(0));
      edited = true;
      await act(async () => {
        dropped.reject(
          new ApiCallError(410, 'Cursor expired', { code: 'core.stream.cursor_expired' })
        );
        await Promise.resolve();
      });
      await screen.findByText(
        target === 'run' ? 'Run recovered edit' : 'Open Item window recovered edit'
      );
      expect(
        screen.queryByText(target === 'run' ? 'Run old text' : 'Open Item window old text')
      ).not.toBeInTheDocument();
    }
  );
});
