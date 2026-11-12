import { ApiCallError } from '@openkit/core-client';
import { onlineManager } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DisconnectedBanner } from '../../../app/DisconnectedBanner';
import { ThreadStream } from '../ThreadStream';
import {
  approval,
  client,
  dashboard,
  Harness,
  ITEM,
  page,
  queryOwner,
  question,
  THREAD,
  TURN,
  WS,
} from './__fixtures__/tw57fix';
import { DecisionSheet } from './decision-sheet';

vi.mock('../../../app/AppShell', () => ({ usePersistentNavigation: () => false }));
const owners: ReturnType<typeof queryOwner>[] = [];
beforeEach(() => {
  onlineManager.setOnline(true);
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
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
  onlineManager.setOnline(true);
  act(() => {
    window.dispatchEvent(new Event('online'));
  });
  vi.unstubAllGlobals();
});

// Intervention permits non-secret answers only. Match the inline form's refusal,
// rather than collecting a secret and relying on the server to reject it.
describe('TW57FIX phone decision safety', () => {
  it('refuses a secret question without collecting or submitting its answer', async () => {
    const item = question(true);
    if (item.type !== 'user-input-request') throw new Error('question fixture');
    const submit = vi.fn();
    render(
      <DecisionSheet
        item={item}
        actor="Worker"
        blocking
        effectText={null}
        more={0}
        onSubmitAnswers={submit}
        onClose={() => {}}
      />
    );
    expect(
      screen.queryByRole('textbox', { name: 'Value' }),
      'A secret must not be collected by the ordinary answer form'
    ).not.toBeInTheDocument();
    const action = screen.queryByRole('button', { name: 'Submit answers' });
    if (action) {
      expect(action).toBeDisabled();
      await userEvent.click(action);
    }
    expect(submit).not.toHaveBeenCalled();
  });

  it('disables a stale approval and exposes the hold reason', () => {
    const item = approval();
    if (item.type !== 'approval-request') throw new Error('approval fixture');
    const reason = 'Updated 2 min ago';
    render(
      <DecisionSheet
        item={item}
        actor="Worker"
        blocking
        effectText="Post the exact summary once"
        holdReason={reason}
        more={0}
        onApprove={() => {}}
        onDeny={() => {}}
        onClose={() => {}}
      />
    );
    const approve = screen.getByRole('button', { name: 'Approve' });
    expect(approve, 'A stale decision must not authorize an effect').toBeDisabled();
    expect(approve).toHaveAccessibleDescription(new RegExp(reason));
  });
});

function mountSheet(
  kind: 'approval' | 'question',
  overrides: Record<string, unknown> = {},
  meta = async () => ({})
) {
  const cache = queryOwner();
  owners.push(cache);
  const item = kind === 'approval' ? approval() : question();
  const read = dashboard();
  const requestId = kind === 'approval' ? 'approval-one' : 'question-one';
  const readWithDecision = {
    ...read,
    pendingRequests: [
      {
        requestId,
        canRespond: true,
        state: 'pending',
        resolution: null,
        ending: null,
        approvalEffect: {
          status: 'available',
          summary: 'Post the summary once',
          detail: 'Post the exact summary once',
        },
      },
    ],
  };
  const response = page('A previous note');
  response.runs[0]!.narrative = [
    {
      id: item.id,
      turnId: TURN,
      type: item.type,
      placement: 'narrative',
      status: item.status,
      createdAt: item.createdAt,
      completedAt: item.completedAt ?? null,
      actor: null,
      detail: { kind: 'complete', value: item },
      steer: null,
    },
  ];
  const api = client(
    {
      'thread.timeline': async () => response,
      'thread.dashboard': async () => readWithDecision,
      ...overrides,
    },
    { meta }
  );
  const sheets = {
    phone: true,
    decisionId: ITEM,
    stepsTurnId: null,
    inspectTurnId: null,
    open: () => {},
    close: () => {},
  };
  const tree = (readOnly = false) => (
    <Harness api={api} cache={cache}>
      <DisconnectedBanner />
      <ThreadStream workspaceId={WS} threadId={THREAD} readOnly={readOnly} sheets={sheets} />
    </Harness>
  );
  return { cache, tree };
}

// Same admitted sheet, then the real connection/read-only gate changes. No mock
// replaces the connection owner or the sheet's command owner.
describe('TW57FIX sheet admission gates', () => {
  it.each(['offline', 'busy', 'read-only'] as const)(
    'blocks approval while %s and explains why',
    async (state) => {
      let busy = false;
      const meta = async () => {
        if (busy) throw new ApiCallError(503, 'busy', { details: { retryAfter: 30 } });
        return {};
      };
      const { tree, cache } = mountSheet('approval', {}, meta);
      const view = render(tree());
      const dialog = await screen.findByRole('dialog', { name: 'Decision' });
      const approve = within(dialog).getByRole('button', { name: 'Approve' });
      await waitFor(() => expect(approve).toBeEnabled());
      if (state === 'offline') {
        Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
        act(() => {
          window.dispatchEvent(new Event('offline'));
        });
        await screen.findByText('Offline');
      } else if (state === 'busy') {
        busy = true;
        await act(async () => {
          await cache.invalidateQueries({ queryKey: ['core', 'meta'] });
        });
        await screen.findByText(/OpenKit is busy/);
      } else view.rerender(tree(true));
      expect(
        approve,
        `An admitted sheet must stop effect submission while ${state}`
      ).toBeDisabled();
      expect(approve).toHaveAccessibleDescription(
        /offline|connection|paused|busy|read.only|reconnect|unavailable/i
      );
    }
  );

  it('blocks an answer in a read-only sheet and explains why', async () => {
    const { tree } = mountSheet('question');
    const view = render(tree());
    const dialog = await screen.findByRole('dialog', { name: 'Decision' });
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Value' }), 'Use this value');
    const submit = within(dialog).getByRole('button', { name: 'Submit answers' });
    expect(submit).toBeEnabled();
    view.rerender(tree(true));
    expect(submit, 'Read-only state must also stop question submission').toBeDisabled();
    expect(submit).toHaveAccessibleDescription(
      /connection|paused|read.only|reconnect|unavailable/i
    );
  });
});

// A lost response is an unknown command result, not permission for a new command.
describe('TW57FIX sheet retry identity', () => {
  it('checks a failed approval using its exact original request identifier', async () => {
    const respond = vi.fn().mockRejectedValue(new TypeError('Response lost'));
    const { tree } = mountSheet('approval', { 'approval.respond': respond });
    render(tree());
    const dialog = await screen.findByRole('dialog', { name: 'Decision' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
    const check = await within(dialog).findByRole('button', { name: /^(Check|Retry)$/ });
    await userEvent.click(check);
    await waitFor(() => expect(respond).toHaveBeenCalledTimes(2));
    expect(respond.mock.calls[1]![0]).toEqual(respond.mock.calls[0]![0]);
  });
});
