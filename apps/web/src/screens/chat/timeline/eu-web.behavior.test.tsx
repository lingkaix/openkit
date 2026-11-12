import type { ThreadTimelineResponse } from '@openkit/app-api-schemas';
import { ApiCallError, type CoreClient } from '@openkit/core-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CoreClientProvider } from '../../../app/core-client';
import { CatchUpDivider } from './CatchUpDivider';
import { timelineCopy } from './copy';
import { NeedsYouBar } from './NeedsYouBar';
import { useTimelineWindow } from './use-timeline-window';
import { anchorFromSearch, type TimelineAnchorRequest } from './window';

const workspaceId = 'ws_earlier';
const threadId = 'th_earlier';
const oldest = { turnId: 'tu_old', itemId: 'it_outside' };

function page(
  runId: string,
  earlierUnread: ThreadTimelineResponse['earlierUnread'] = undefined
): ThreadTimelineResponse {
  return {
    workspaceId,
    threadId,
    view: 'runs',
    runs: [
      {
        id: runId,
        admissionOrder: 1,
        status: 'completed',
        triggerActor: { kind: 'user', id: 'usr_1' },
        agentId: null,
        triggerSource: null,
        startedAt: null,
        completedAt: null,
        durationMs: null,
        error: null,
        long: false,
        narrative: [],
        plan: null,
        noteItemIds: [],
        finalItemId: null,
        narrativeCursor: null,
        statistics: {
          steps: 0,
          failedStepCount: 0,
          failedCommandCount: 0,
          filesChanged: 0,
          messages: 0,
          itemCounts: {},
          coverage: 'complete',
        },
        interruptedBy: { visibility: 'available', actor: null },
        restrictedReferences: false,
      },
    ],
    items: [],
    beforeCursor: null,
    afterCursor: null,
    itemWindow: null,
    anchor: null,
    catchUpAnchor: { turnId: 'tu_here', itemId: 'it_here' },
    earlierUnread,
    digest: { lines: [], coverage: 'complete' },
    restrictedReferences: false,
  } as ThreadTimelineResponse;
}

function divider(
  recorded: ThreadTimelineResponse['earlierUnread'],
  onEarlierUnread = () => {
    throw new Error('loaded window count');
  }
) {
  return (
    <MemoryRouter>
      <CatchUpDivider count={99} onEarlierUnread={onEarlierUnread} recorded={recorded} />
    </MemoryRouter>
  );
}

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
});

describe('earlier unread on the catch-up divider', () => {
  it('keeps the honest fallback when the server result is null', () => {
    render(divider(null));
    expect(screen.getByText(timelineCopy.earlierUnreadUnknown)).toBeVisible();
    expect(screen.queryByRole('button', { name: /earlier unread/ })).not.toBeInTheDocument();
  });

  it('shows no earlier-unread text for a proved zero', () => {
    render(divider({ count: 0, capped: false, oldest: null }));
    expect(screen.queryByText(/earlier unread/i)).not.toBeInTheDocument();
    expect(screen.getByText(timelineCopy.newSinceHere)).toBeVisible();
  });

  it('shows the server count and the capped label', () => {
    const view = render(divider({ count: 3, capped: false, oldest }));
    expect(screen.getByRole('button', { name: '3 earlier unread ›' })).toBeVisible();
    expect(screen.queryByRole('button', { name: '99 earlier unread ›' })).not.toBeInTheDocument();
    view.rerender(divider({ count: 100, capped: true, oldest }));
    expect(screen.getByRole('button', { name: '100+ earlier unread ›' })).toBeVisible();
    expect(screen.queryByRole('button', { name: '100 earlier unread ›' })).not.toBeInTheDocument();
  });

  it('fills the reserved line when the count arrives after the divider', () => {
    const view = render(
      <MemoryRouter>
        <CatchUpDivider count={0} onEarlierUnread={() => undefined} />
      </MemoryRouter>
    );
    const before = screen.getByRole('group', { name: timelineCopy.newSinceHere });
    const children = before.childElementCount;
    const height = before.getBoundingClientRect().height;
    view.rerender(
      <MemoryRouter>
        <CatchUpDivider
          count={0}
          onEarlierUnread={() => undefined}
          recorded={{ count: 3, capped: false, oldest }}
        />
      </MemoryRouter>
    );
    const after = screen.getByRole('group', { name: timelineCopy.newSinceHere });
    expect(after.childElementCount).toBe(children);
    expect(after.getBoundingClientRect().height).toBe(height);
    expect(screen.getByRole('button', { name: '3 earlier unread ›' })).toBeVisible();
  });

  it('jumps to the oldest unread outside the loaded window', async () => {
    const user = userEvent.setup();
    const read = vi.fn(async (input: { anchor?: TimelineAnchorRequest }) => {
      if (input.anchor?.kind === 'item') return page('run-outside');
      return page('run-nearby', { count: 3, capped: false, oldest });
    });
    render(<WindowHarness read={read} />);
    await waitFor(() => expect(screen.getByText('run-nearby')).toBeInTheDocument());
    await user.click(await screen.findByRole('button', { name: '3 earlier unread ›' }));
    await waitFor(() =>
      expect(screen.getByLabelText('Current address')).toHaveTextContent('item=it_outside')
    );
    await waitFor(() => expect(screen.getByText('run-outside')).toBeInTheDocument());
    expect(screen.queryByText('run-nearby')).not.toBeInTheDocument();
    expect(read).toHaveBeenCalledWith(
      expect.objectContaining({ anchor: { kind: 'item', itemId: 'it_outside' } })
    );
  });

  it('keeps the current view when the oldest unread is no longer available', async () => {
    const user = userEvent.setup();
    const read = vi.fn(async (input: { anchor?: TimelineAnchorRequest }) => {
      if (input.anchor?.kind === 'item') {
        throw new ApiCallError(404, 'missing', { code: 'not_found' });
      }
      return page('run-nearby', {
        count: 1,
        capped: false,
        oldest: { turnId: 'tu_old', itemId: 'it_gone' },
      });
    });
    render(<WindowHarness read={read} />);
    await waitFor(() => expect(screen.getByText('run-nearby')).toBeInTheDocument());
    await user.click(await screen.findByRole('button', { name: '1 earlier unread ›' }));
    await waitFor(() =>
      expect(screen.getByText(timelineCopy.requestUnavailable)).toBeInTheDocument()
    );
    expect(screen.getByText('run-nearby')).toBeInTheDocument();
    expect(screen.queryByText('run-outside')).not.toBeInTheDocument();
  });
});

function WindowHarness({
  read,
}: {
  read: (input: { anchor?: TimelineAnchorRequest }) => Promise<ThreadTimelineResponse>;
}) {
  const client = {
    operations: { 'thread.timeline': read },
  } as unknown as CoreClient;
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={query}>
      <CoreClientProvider client={client}>
        <MemoryRouter initialEntries={['/chat?catchUp=1']}>
          <AddressedWindow />
        </MemoryRouter>
      </CoreClientProvider>
    </QueryClientProvider>
  );
}

function AddressedWindow() {
  const location = useLocation();
  if (window.location.search !== location.search) {
    window.history.replaceState(null, '', `${location.pathname}${location.search}`);
  }
  const timeline = useTimelineWindow({
    workspaceId,
    threadId,
    anchor: anchorFromSearch(location.search),
    enabled: true,
    running: false,
    pending: false,
  });
  return (
    <>
      <output aria-label="Current address">{location.search}</output>
      <p>{timeline.data?.runs[0]?.id ?? ''}</p>
      <CatchUpDivider recorded={timeline.data?.earlierUnread} />
      <NeedsYouBar
        rows={[]}
        threadId={threadId}
        emphasize={false}
        reducedMotion
        unavailable={timeline.data?.requestUnavailable === true}
      />
    </>
  );
}
