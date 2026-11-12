import { GoalViewSchema } from '@openkit/app-api-schemas';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { useAccountMutation } from '../../account/session';
import { useGoalView } from '../../goal/data';
import {
  client,
  deferred,
  Harness,
  page,
  queryOwner,
  THREAD,
  TURN,
  USER,
  WS,
} from './__fixtures__/tw57fix';
import { useTimelineAttention } from './NeedsYouBar';
import { useRunItemWindow, useTimelineWindow } from './use-timeline-window';

const OLD = 'Previous viewer private fact';
const CURRENT = 'Current viewer fact';
const sources = ['Goal', 'attention', 'timeline', 'Item window'] as const;
type Source = (typeof sources)[number];
const owners: ReturnType<typeof queryOwner>[] = [];
afterEach(() => {
  cleanup();
  for (const cache of owners.splice(0)) cache.clear();
});

function GoalReader() {
  const result = useGoalView(WS, THREAD);
  return <p>{result.data?.goal?.intent ?? 'Checking Goal'}</p>;
}
function AttentionReader() {
  const result = useTimelineAttention(WS);
  return <p>{result.data?.map((row) => row.title).join(' ') ?? 'Checking attention'}</p>;
}
function TimelineReader() {
  const result = useTimelineWindow({
    workspaceId: WS,
    threadId: THREAD,
    anchor: { kind: 'latest' },
    enabled: true,
    running: false,
    pending: false,
  });
  const item = result.data?.runs[0]?.narrative[0];
  return (
    <p>
      {item?.detail.kind === 'complete' && 'text' in item.detail.value
        ? item.detail.value.text
        : 'Checking timeline'}
    </p>
  );
}
function ItemReader() {
  const result = useRunItemWindow({
    workspaceId: WS,
    threadId: THREAD,
    turnId: TURN,
    enabled: true,
  });
  const item = result.completeItems[0];
  return <p>{item && 'text' in item ? item.text : 'Checking Item window'}</p>;
}
function Reader({ source }: { source: Source }) {
  if (source === 'Goal') return <GoalReader />;
  if (source === 'attention') return <AttentionReader />;
  if (source === 'timeline') return <TimelineReader />;
  return <ItemReader />;
}
function ChangeAccount() {
  const mutation = useAccountMutation();
  return (
    <>
      <button
        type="button"
        onClick={() => mutation.mutate({ operation: 'signIn', email: '', password: '', name: '' })}
      >
        Change account
      </button>
      {mutation.isSuccess ? <p>Account changed</p> : null}
    </>
  );
}
function response(source: Source, text: string) {
  if (source === 'Goal')
    return GoalViewSchema.parse({
      goal: {
        goalId: 'goal-one',
        workspaceId: WS,
        threadId: THREAD,
        responsibleUserId: USER,
        responsibleActorContext: { kind: 'local', userId: USER },
        intent: text,
        intentRevision: 0,
        intentHistory: [],
        activePlanVersionId: null,
        proposedPlanVersionId: null,
        disposition: null,
        changeRevision: 0,
        consideredRevision: 0,
        createdAt: '2026-11-08T12:00:00.000Z',
        updatedAt: '2026-11-08T12:00:00.000Z',
      },
      cards: [],
      versions: [],
      tasks: [],
      requests: [],
    });
  if (source === 'attention')
    return {
      items: [
        {
          id: 'question:one',
          kind: 'question',
          workspaceId: WS,
          threadId: THREAD,
          title: text,
          summary: text,
          severity: 'needs_input',
          createdAt: '2026-11-08T12:00:00.000Z',
          blocking: true,
          source: {
            type: 'protocol_item',
            workspaceId: WS,
            threadId: THREAD,
            turnId: TURN,
            itemId: 'it_00000000-0000-7000-8000-000000000004',
            itemType: 'user-input-request',
          },
          actions: [],
        },
      ],
    };
  return page(text, source === 'Item window' ? 'items' : 'runs');
}
function operation(source: Source) {
  return source === 'Goal'
    ? 'goal.read'
    : source === 'attention'
      ? 'attention.list'
      : 'thread.timeline';
}

// Conversation Timeline / Freshness and admission: account changes clear caches and
// discard earlier-account responses. Real account and read owners share one QueryClient.
describe('TW57FIX account isolation', () => {
  it.each(sources)('does not show cached %s facts after an account transition', async (source) => {
    const cache = queryOwner();
    owners.push(cache);
    cache.setDefaultOptions({ queries: { retry: false, staleTime: Infinity } });
    let current = false;
    const api = client({
      [operation(source)]: async () => response(source, current ? CURRENT : OLD),
    });
    const tree = (show: boolean) => (
      <Harness api={api} cache={cache}>
        <ChangeAccount />
        {show ? <Reader source={source} /> : null}
      </Harness>
    );
    const view = render(tree(true));
    await screen.findByText(OLD);
    view.rerender(tree(false));
    current = true;
    await userEvent.click(screen.getByRole('button', { name: 'Change account' }));
    await screen.findByText('Account changed');
    view.rerender(tree(true));
    expect(
      screen.queryByText(OLD),
      `${source} must not disclose the previous viewer's cached fact`
    ).not.toBeInTheDocument();
    await screen.findByText(CURRENT);
  });

  it.each(sources)(
    'discards a late previous-viewer %s response after switching accounts',
    async (source) => {
      const cache = queryOwner();
      owners.push(cache);
      const late = deferred<ReturnType<typeof response>>();
      let current = false;
      let requested = false;
      const api = client({
        [operation(source)]: () => {
          requested = true;
          return current ? Promise.resolve(response(source, CURRENT)) : late.promise;
        },
      });
      const tree = (show: boolean) => (
        <Harness api={api} cache={cache}>
          <ChangeAccount />
          {show ? <Reader source={source} /> : null}
        </Harness>
      );
      const view = render(tree(true));
      await waitFor(() => expect(requested).toBe(true));
      view.rerender(tree(false));
      current = true;
      await userEvent.click(screen.getByRole('button', { name: 'Change account' }));
      await screen.findByText('Account changed');
      view.rerender(tree(true));
      await act(async () => {
        late.resolve(response(source, OLD));
        await late.promise;
      });
      await waitFor(() => expect(screen.queryByText(/^Checking/)).not.toBeInTheDocument());
      expect(
        screen.queryByText(OLD),
        `${source} must reject a late response owned by the previous viewer`
      ).not.toBeInTheDocument();
      await screen.findByText(CURRENT);
    }
  );
});
