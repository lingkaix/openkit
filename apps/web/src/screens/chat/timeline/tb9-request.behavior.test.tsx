import type { ThreadTimelineResponse } from '@openkit/app-api-schemas';
import { ApiCallError, type CoreClient } from '@openkit/core-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CoreClientProvider } from '../../../app/core-client';
import { NeedsYouBar } from './NeedsYouBar';
import { useTimelineWindow } from './use-timeline-window';
import type { TimelineAnchorRequest } from './window';

const workspaceId = 'ws_request';
const threadId = 'th_request';

function page(runId: string, itemId: string): ThreadTimelineResponse {
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
    itemWindow: { turnId: runId, items: [], beforeCursor: null, afterCursor: null },
    anchor: { turnId: runId, itemId },
    catchUpAnchor: null,
    digest: { lines: [], coverage: 'complete' },
    restrictedReferences: false,
  } as ThreadTimelineResponse;
}

function Harness({ anchor }: { anchor: TimelineAnchorRequest }) {
  const timeline = useTimelineWindow({
    workspaceId,
    threadId,
    anchor,
    enabled: true,
    running: false,
    pending: false,
  });
  return (
    <>
      <p>{timeline.data?.runs[0]?.id ?? ''}</p>
      <NeedsYouBar rows={[]} threadId={threadId} emphasize={false} reducedMotion />
    </>
  );
}

function setup(
  read: (input: { anchor?: TimelineAnchorRequest }) => Promise<ThreadTimelineResponse>
) {
  const client = {
    operations: { 'thread.timeline': read },
  } as unknown as CoreClient;
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function ui(anchor: TimelineAnchorRequest, search: string) {
    window.history.replaceState(null, '', search || '/');
    return (
      <QueryClientProvider client={query}>
        <CoreClientProvider client={client}>
          <Harness anchor={anchor} />
        </CoreClientProvider>
      </QueryClientProvider>
    );
  }
  return { ui };
}

afterEach(() => {
  cleanup();
});

describe('request timeline anchors', () => {
  it('locates a request outside the loaded window when it is pending, answered, or withdrawn', async () => {
    const read = vi.fn(async (input: { anchor?: TimelineAnchorRequest }) => {
      const anchor = input.anchor;
      if (anchor?.kind === 'approval-request')
        return page(`run-${anchor.approvalRequestId}`, 'it-approval');
      if (anchor?.kind === 'user-input-request')
        return page(`run-${anchor.userInputRequestId}`, 'it-question');
      return page('run-nearby', 'it-nearby');
    });
    const { ui } = setup(read);
    const view = render(ui({ kind: 'latest' }, ''));
    await waitFor(() => expect(screen.getByText('run-nearby')).toBeInTheDocument());

    for (const state of ['pending', 'answered', 'withdrawn'] as const) {
      view.rerender(
        ui({ kind: 'approval-request', approvalRequestId: state }, `?approvalRequest=${state}`)
      );
      await waitFor(() => expect(screen.getByText(`run-${state}`)).toBeInTheDocument());
      expect(screen.queryByText('This request is no longer available')).not.toBeInTheDocument();
    }

    view.rerender(
      ui(
        { kind: 'user-input-request', userInputRequestId: 'question' },
        '?userInputRequest=question'
      )
    );
    await waitFor(() => expect(screen.getByText('run-question')).toBeInTheDocument());
  });

  it('keeps the current view when the request is no longer available', async () => {
    const read = vi.fn(async (input: { anchor?: TimelineAnchorRequest }) => {
      if (input.anchor?.kind === 'approval-request') {
        throw new ApiCallError(404, 'missing', { code: 'not_found' });
      }
      return page('run-nearby', 'it-nearby');
    });
    const { ui } = setup(read);
    const view = render(ui({ kind: 'latest' }, ''));
    await waitFor(() => expect(screen.getByText('run-nearby')).toBeInTheDocument());
    view.rerender(
      ui({ kind: 'approval-request', approvalRequestId: 'gone' }, '?approvalRequest=gone')
    );
    await waitFor(() =>
      expect(screen.getByText('This request is no longer available')).toBeInTheDocument()
    );
    expect(screen.getByText('run-nearby')).toBeInTheDocument();
  });
});
