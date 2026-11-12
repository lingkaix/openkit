import type { CoreClient } from '@openkit/core-client';
import { ApiCallError } from '@openkit/core-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CoreClientProvider } from '../../../app/core-client';
import { Composer, type ComposerDraft } from '../../../primitives/Composer';
import { useConversationTargets, useThreadDashboard } from '../data';
import { lintCopyText, timelineCopy } from './copy';
import { SteerOutcome } from './SteerOutcome';
import {
  composerLiveMode,
  type SteerCatalogTarget,
  type SteerReceiptView,
  steerCopy,
  steerReasonSentence,
} from './steer';
import { SteerProvider } from './steer-context';

vi.mock('../data', async (original) => ({
  ...(await original<typeof import('../data')>()),
  useCurrentWorkspaceId: (id: string) => id,
}));

const TURN = 'tu_fixture';
const REQUEST = 'req_fixture';
const NOTE = 'Bring the note into this run.';

function receipt(state: SteerReceiptView['state'], text: string | null = NOTE): SteerReceiptView {
  return { requestId: REQUEST, turnId: TURN, text, state, reason: null };
}

describe('steer outcomes', () => {
  it('renders all four outcomes from the receipt', () => {
    const { rerender } = render(<SteerOutcome receipt={receipt('sending')} />);
    expect(screen.getByRole('status').textContent).toBe(steerCopy.sending);
    rerender(<SteerOutcome receipt={receipt('accepted')} />);
    expect(screen.getByRole('status').textContent).toBe(steerCopy.accepted);
    rerender(<SteerOutcome receipt={receipt('not-delivered')} />);
    expect(screen.getByRole('status').textContent).toBe(steerCopy.notDelivered);
    expect(screen.getByText(steerCopy.notDeliveredDetail)).toBeTruthy();
    rerender(<SteerOutcome receipt={receipt('unknown')} />);
    expect(screen.getByRole('status').textContent).toBe(steerCopy.unknown);
    expect(screen.getByText(steerCopy.unknownDetail)).toBeTruthy();
  });

  it('keeps the same outcome after the view is remounted', () => {
    const view = <SteerOutcome receipt={receipt('accepted')} />;
    const first = render(view);
    expect(screen.getByRole('status').textContent).toBe(steerCopy.accepted);
    first.unmount();
    render(view);
    expect(screen.getByRole('status').textContent).toBe(steerCopy.accepted);
  });

  it('reuses the exact target, text, and request id for Check and Retry', async () => {
    const user = userEvent.setup();
    const onReplay = vi.fn();
    const { rerender } = render(
      <SteerOutcome onReplay={onReplay} receipt={receipt('not-delivered')} />
    );
    await user.click(screen.getByRole('button', { name: steerCopy.retry }));
    expect(onReplay).toHaveBeenCalledWith({ turnId: TURN, requestId: REQUEST, text: NOTE });
    rerender(<SteerOutcome onReplay={onReplay} receipt={receipt('unknown')} />);
    await user.click(screen.getByRole('button', { name: steerCopy.check }));
    expect(onReplay).toHaveBeenLastCalledWith({ turnId: TURN, requestId: REQUEST, text: NOTE });
    expect(onReplay.mock.calls[1]?.[0].requestId).toBe(REQUEST);
  });

  it('hides Check and Retry when the read has no exact text', () => {
    render(<SteerOutcome onReplay={vi.fn()} receipt={receipt('unknown', null)} />);
    expect(screen.getByRole('status').textContent).toBe(steerCopy.unknown);
    expect(screen.queryByRole('button', { name: steerCopy.check })).toBeNull();
    expect(screen.queryByRole('button', { name: steerCopy.retry })).toBeNull();
  });
});

const worker = (
  steerAvailability: SteerCatalogTarget['steerAvailability'],
  activeTurnId: string | null = TURN,
  steerUnavailableReason: string | null = null
): SteerCatalogTarget => ({
  kind: 'running-worker',
  activeTurnId,
  steerAvailability,
  steerUnavailableReason,
});

describe('steer qualification', () => {
  it('offers Steer only for an available Worker and that exact Turn', () => {
    expect(
      composerLiveMode({
        task: false,
        runningTurnId: TURN,
        targets: [worker('available', TURN, null)],
      })
    ).toBeNull();
    expect(
      composerLiveMode({
        task: true,
        runningTurnId: null,
        targets: [worker('available', 'tu_stale', null)],
      })
    ).toBeNull();
    expect(
      composerLiveMode({
        task: true,
        runningTurnId: 'tu_exact',
        targets: [worker('available', 'tu_exact', null)],
      })
    ).toMatchObject({
      mode: 'steer',
      turnId: 'tu_exact',
      consequence: steerCopy.consequence,
    });
    expect(
      composerLiveMode({
        task: true,
        runningTurnId: TURN,
        targets: [worker('available', 'tu_exact', null)],
      })
    ).toMatchObject({ mode: 'keep-draft' });
    expect(
      composerLiveMode({
        task: true,
        runningTurnId: TURN,
        targets: [worker('busy', TURN, 'steer_busy')],
      })
    ).toMatchObject({ mode: 'keep-draft', consequence: timelineCopy.keepDraft });
    expect(
      composerLiveMode({
        task: true,
        runningTurnId: TURN,
        targets: [worker('unavailable', TURN, 'steer_turn_run_denied')],
      })
    ).toMatchObject({ mode: 'keep-draft', consequence: timelineCopy.keepDraft });
    expect(
      composerLiveMode({
        task: true,
        runningTurnId: TURN,
        targets: [worker('unsupported', TURN, 'steer_unsupported')],
      })
    ).toMatchObject({ mode: 'keep-draft', consequence: steerCopy.unqualified });
  });

  it('does not invent Steer when the catalog omits it or names the Coordinator', () => {
    expect(composerLiveMode({ task: true, runningTurnId: TURN, targets: undefined })).toMatchObject(
      { mode: 'keep-draft', consequence: steerCopy.unqualified }
    );
    expect(
      composerLiveMode({ task: true, runningTurnId: TURN, targets: [{ kind: 'running-worker' }] })
    ).toMatchObject({ mode: 'keep-draft', consequence: steerCopy.unqualified });
    expect(
      composerLiveMode({
        task: true,
        runningTurnId: TURN,
        targets: [worker('available', null, null)],
      })
    ).toMatchObject({ mode: 'keep-draft' });
    expect(
      composerLiveMode({
        task: true,
        runningTurnId: TURN,
        targets: [
          {
            kind: 'goal-coordinator',
            activeTurnId: TURN,
            steerAvailability: 'available',
            steerUnavailableReason: null,
          },
        ],
      })
    ).toMatchObject({ mode: 'keep-draft', consequence: steerCopy.unqualified });
    expect(
      composerLiveMode({
        task: true,
        runningTurnId: TURN,
        targets: [{ kind: 'running-worker', steerAvailability: 'true' }],
      })
    ).toMatchObject({ mode: 'keep-draft' });
  });

  it('keeps raw error codes off the outcome line', () => {
    expect(steerReasonSentence('steer_busy')).toBe(steerCopy.busy);
    expect(steerReasonSentence('steer_unsupported')).toBe(steerCopy.unqualified);
    expect(steerReasonSentence('steer_target_stale')).toBe(steerCopy.ended);
    expect(steerReasonSentence('tu_secret')).toBeNull();
  });

  it('passes the same copy lint as the rest of the timeline', () => {
    expect(Object.values(steerCopy).flatMap((text) => lintCopyText(text))).toEqual([]);
  });
});

describe('composer steer', () => {
  it('keeps the draft when the worker cannot take a note, and does not send it later', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const liveInput = {
      mode: 'keep-draft' as const,
      turnId: TURN,
      consequence: steerCopy.unqualified,
      actionLabel: steerCopy.keepDraft,
    };
    const onStop = vi.fn();
    const { rerender } = render(
      <Composer
        liveInput={liveInput}
        onSubmit={onSubmit}
        phoneRun={{
          stop: {
            label: timelineCopy.stopRun,
            pending: false,
            consequence: timelineCopy.stopConsequence,
            waitReason: timelineCopy.waitForStop,
            onStop,
          },
        }}
      />
    );
    expect(screen.getByText(steerCopy.unqualified)).toBeTruthy();
    const input = screen.getByRole('textbox', { name: 'Message' });
    await user.type(input, NOTE);
    await user.click(screen.getByRole('button', { name: steerCopy.keepDraft }));
    await user.click(screen.getByRole('button', { name: timelineCopy.stopRun }));
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(input).toHaveValue(NOTE);
    rerender(<Composer onSubmit={onSubmit} />);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(input).toHaveValue(NOTE);
  });

  it('keeps the draft and the request id when delivery is refused', async () => {
    const user = userEvent.setup();
    const onSubmit = vi
      .fn()
      .mockRejectedValue(new ApiCallError(409, 'busy', { code: 'steer_busy' }));
    render(
      <Composer
        initialDraft={{ input: NOTE, targetRef: '', requestId: REQUEST }}
        liveInput={{
          mode: 'steer',
          turnId: TURN,
          consequence: steerCopy.consequence,
          actionLabel: steerCopy.steer,
        }}
        onSubmit={onSubmit}
      />
    );
    const steer = screen.getByRole('button', { name: steerCopy.steer });
    await user.click(steer);
    await user.click(steer);
    expect(onSubmit).toHaveBeenCalledTimes(2);
    const first = onSubmit.mock.calls[0]?.[0] as ComposerDraft;
    const second = onSubmit.mock.calls[1]?.[0] as ComposerDraft;
    expect(first.requestId).toBe(REQUEST);
    expect(second.requestId).toBe(REQUEST);
    expect(first.input).toBe(NOTE);
    expect(second.input).toBe(NOTE);
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue(NOTE);
  });

  it('does not send a blank note', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <Composer
        liveInput={{
          mode: 'steer',
          turnId: TURN,
          consequence: steerCopy.consequence,
          actionLabel: steerCopy.steer,
        }}
        onSubmit={onSubmit}
      />
    );
    const input = screen.getByRole('textbox', { name: 'Message' });
    await user.type(input, '   ');
    expect(screen.getByRole('button', { name: steerCopy.steer })).toBeDisabled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('blocks a note that includes more than text until those choices are removed', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <Composer
        initialDraft={{
          input: NOTE,
          targetRef: '',
          requestId: REQUEST,
          reasoningEffort: 'high',
        }}
        liveInput={{
          mode: 'steer',
          turnId: TURN,
          consequence: steerCopy.consequence,
          actionLabel: steerCopy.steer,
        }}
        onSubmit={onSubmit}
      />
    );
    expect(screen.getByText(steerCopy.inapplicable)).toBeTruthy();
    expect(screen.getByRole('button', { name: steerCopy.steer })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: steerCopy.clearExtras }));
    await user.click(screen.getByRole('button', { name: steerCopy.steer }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    const draft = onSubmit.mock.calls[0]?.[0] as ComposerDraft;
    expect(draft.input).toBe(NOTE);
    expect(draft.reasoningEffort).toBeUndefined();
    expect(draft.files).toBeUndefined();
  });
});

const WS = 'ws_00000000-0000-7000-8000-0000000000aa';
const THREAD = 'th_00000000-0000-7000-8000-0000000000aa';
const LIVE = 'tu_00000000-0000-7000-8000-0000000000bb';
const RAW = 'steer_turn_run_denied';

function CatalogLoaded() {
  const targets = useConversationTargets(WS, THREAD);
  const dashboard = useThreadDashboard(WS, THREAD, true, false);
  return <p>{targets.isSuccess && dashboard.isSuccess ? 'Catalog loaded' : 'Loading catalog'}</p>;
}

function renderCatalog(options: {
  targets: readonly SteerCatalogTarget[];
  turns: readonly { id: string; status: string }[];
  stop?: boolean;
}) {
  const steer = vi.fn(async () => ({ delivery: 'accepted' }));
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const client = {
    core: { meta: vi.fn().mockResolvedValue({}), subscribeTurnEvents: vi.fn() },
    operations: {
      'thread.timeline': vi.fn(async () => ({
        workspaceId: WS,
        threadId: THREAD,
        view: 'runs',
        runs: [],
        items: [],
        beforeCursor: null,
        afterCursor: null,
        itemWindow: null,
        anchor: null,
        catchUpAnchor: null,
        digest: { lines: [], coverage: 'complete' },
        restrictedReferences: false,
      })),
      'thread.dashboard': vi.fn(async () => ({ turns: options.turns, pendingRequests: [] })),
      'conversation.targets': vi.fn(async () => ({
        targets: options.targets,
        defaultTargetRef: 'worker',
      })),
      'task.steer': steer,
    },
  } as unknown as CoreClient;
  render(
    <QueryClientProvider client={queryClient}>
      <CoreClientProvider client={client}>
        <MemoryRouter initialEntries={[`/tasks/${WS}/${THREAD}`]}>
          <Routes>
            <Route
              path="/tasks/:workspaceId/:threadId"
              element={
                <SteerProvider mode="task">
                  <CatalogLoaded />
                  <Composer
                    onSubmit={vi.fn()}
                    phoneRun={
                      options.stop
                        ? {
                            stop: {
                              label: timelineCopy.stopRun,
                              pending: false,
                              consequence: timelineCopy.stopConsequence,
                              waitReason: timelineCopy.waitForStop,
                              onStop: vi.fn(),
                            },
                          }
                        : undefined
                    }
                  />
                </SteerProvider>
              }
            />
          </Routes>
        </MemoryRouter>
      </CoreClientProvider>
    </QueryClientProvider>
  );
  return steer;
}

describe('steer availability on the composer', () => {
  it('sends task.steer for the catalog Turn when the server says available', async () => {
    const user = userEvent.setup();
    const steer = renderCatalog({
      turns: [{ id: LIVE, status: 'running' }],
      targets: [worker('available', LIVE, null)],
    });
    expect(await screen.findByText('Catalog loaded')).toBeTruthy();
    const input = await screen.findByRole('textbox', { name: 'Message' });
    await user.type(input, NOTE);
    await user.click(await screen.findByRole('button', { name: steerCopy.steer }));
    expect(steer).toHaveBeenCalledWith(
      expect.objectContaining({ turnId: LIVE, threadId: THREAD, input: NOTE })
    );
    expect(screen.getByText(steerCopy.consequence)).toBeTruthy();
    expect(screen.queryByRole('button', { name: steerCopy.keepDraft })).toBeNull();
  });

  it.each(['busy', 'unavailable'] as const)(
    'keeps the draft and hides the raw reason when steer is %s',
    async (availability) => {
      const steer = renderCatalog({
        turns: [{ id: TURN, status: 'running' }],
        targets: [worker(availability, TURN, RAW)],
      });
      expect(await screen.findByText('Catalog loaded')).toBeTruthy();
      expect(screen.getByRole('button', { name: steerCopy.keepDraft })).toBeTruthy();
      expect(screen.getByText(timelineCopy.keepDraft)).toBeTruthy();
      expect(screen.queryByRole('button', { name: steerCopy.steer })).toBeNull();
      expect(screen.queryByText(RAW)).toBeNull();
      expect(screen.queryByText(steerCopy.busy)).toBeNull();
      expect(steer).not.toHaveBeenCalled();
    }
  );

  it('shows the unsupported sentence with Keep draft and Stop', async () => {
    const steer = renderCatalog({
      turns: [{ id: TURN, status: 'running' }],
      targets: [worker('unsupported', TURN, RAW)],
      stop: true,
    });
    expect(await screen.findByText('Catalog loaded')).toBeTruthy();
    expect(screen.getByText(steerCopy.unqualified)).toBeTruthy();
    expect(screen.getByRole('button', { name: steerCopy.keepDraft })).toBeTruthy();
    expect(screen.getByRole('button', { name: timelineCopy.stopRun })).toBeTruthy();
    expect(screen.queryByRole('button', { name: steerCopy.steer })).toBeNull();
    expect(screen.queryByText(RAW)).toBeNull();
    expect(steer).not.toHaveBeenCalled();
  });

  it('does not show Steer to a readonly viewer', async () => {
    renderCatalog({
      turns: [{ id: TURN, status: 'running' }],
      targets: [worker('unavailable', LIVE, RAW)],
    });
    expect(await screen.findByText('Catalog loaded')).toBeTruthy();
    expect(screen.getByRole('button', { name: steerCopy.keepDraft })).toBeTruthy();
    expect(screen.getByText(timelineCopy.keepDraft)).toBeTruthy();
    expect(screen.queryByRole('button', { name: steerCopy.steer })).toBeNull();
    expect(screen.queryByText(RAW)).toBeNull();
  });

  it('does not offer Steer when metadata is absent', async () => {
    renderCatalog({
      turns: [{ id: TURN, status: 'running' }],
      targets: [{ kind: 'running-worker' }],
    });
    expect(await screen.findByText('Catalog loaded')).toBeTruthy();
    expect(screen.getByRole('button', { name: steerCopy.keepDraft })).toBeTruthy();
    expect(screen.getByText(steerCopy.unqualified)).toBeTruthy();
    expect(screen.queryByRole('button', { name: steerCopy.steer })).toBeNull();
  });

  it('does not offer Steer for a stale active Turn after the run ends', async () => {
    renderCatalog({
      turns: [{ id: LIVE, status: 'completed' }],
      targets: [worker('available', LIVE, null)],
    });
    expect(await screen.findByText('Catalog loaded')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Send message' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: steerCopy.steer })).toBeNull();
    expect(screen.queryByRole('button', { name: steerCopy.keepDraft })).toBeNull();
  });

  it('never steers the Coordinator, even when that row says available', async () => {
    renderCatalog({
      turns: [{ id: TURN, status: 'running' }],
      targets: [
        {
          kind: 'goal-coordinator',
          activeTurnId: LIVE,
          steerAvailability: 'available',
          steerUnavailableReason: null,
        },
      ],
    });
    expect(await screen.findByText('Catalog loaded')).toBeTruthy();
    expect(screen.getByText(steerCopy.unqualified)).toBeTruthy();
    expect(screen.getByRole('button', { name: steerCopy.keepDraft })).toBeTruthy();
    expect(screen.queryByRole('button', { name: steerCopy.steer })).toBeNull();
  });
});

afterEach(() => {
  cleanup();
});
