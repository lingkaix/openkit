import type { CoreClient } from '@openkit/core-client';
import { allocateEntityId } from '@openkit/protocol';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ComponentProps, Profiler } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoreClientProvider } from '../../../app/core-client';
import { ThreadStream } from '../ThreadStream';
import { eventPipe, type TimelineRead, timelineFixture } from './tw4fix2-fixture';

// Owner: conversation_timeline, Two-level windows, Opening/Rendering, and Phone.
// Doubles stop at Core Client operations; production query, stream, and renderer code stays real.
let width = 1280;
const clients: QueryClient[] = [];
beforeEach(() => {
  width = 1280;
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('min-width: 800')
      ? width >= 800
      : query.includes('max-width: 799')
        ? width < 800
        : false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => true,
  }));
});
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  vi.unstubAllGlobals();
});

function mount(
  f: ReturnType<typeof timelineFixture>,
  read: TimelineRead,
  options: {
    props?: Partial<ComponentProps<typeof ThreadStream>>;
    attention?: ReturnType<typeof f.attention>;
    running?: boolean;
    onCommit?: () => void;
  } = {}
) {
  const pipe = eventPipe();
  const operations = {
    'thread.timeline': vi.fn(async (input: Parameters<TimelineRead>[0]) => read(input)),
    'thread.dashboard': vi.fn(async () => {
      const runs = read({ workspaceId: f.workspaceId, threadId: f.threadId }).runs;
      const dashboard = f.dashboard(runs);
      if (options.running && dashboard.turns[0]) {
        dashboard.turns[0].status = 'running';
        dashboard.turns[0].completedAt = null;
      }
      return dashboard;
    }),
    'attention.list': vi.fn(async () => options.attention ?? { items: [] }),
    'thread.items': vi.fn(async () => ({ items: [], nextCursor: null })),
    'thread.read-state': vi.fn(async () => ({ readItemIds: [], unreadItemIds: [] })),
    'conversation.targets': vi.fn(async () => ({ targets: [], defaultTargetRef: null })),
  };
  const subscribe = vi.fn(() => pipe);
  const client = {
    core: { meta: async () => ({}), subscribeTurnEvents: subscribe },
    operations,
  } as unknown as CoreClient;
  const query = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 0, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  clients.push(query);
  const tree = (props = options.props) => (
    <QueryClientProvider client={query}>
      <CoreClientProvider client={client}>
        <MemoryRouter initialEntries={[`/chat/${f.workspaceId}/${f.threadId}`]}>
          <Profiler id="production-thread-stream" onRender={() => options.onCommit?.()}>
            <ThreadStream
              workspaceId={f.workspaceId}
              threadId={f.threadId}
              mode="chat"
              {...props}
            />
          </Profiler>
        </MemoryRouter>
      </CoreClientProvider>
    </QueryClientProvider>
  );
  const view = render(tree());
  return {
    ...view,
    operations,
    pipe,
    subscribe,
    change: (props: Partial<ComponentProps<typeof ThreadStream>>) => view.rerender(tree(props)),
  };
}

describe('TW4FIX2 independent behavior regressions', () => {
  it('R2 Full shows each historical run’s own bounded steps', async () => {
    const f = timelineFixture();
    const old = allocateEntityId('tu'),
      latest = allocateEntityId('tu');
    const a = f.command(old, 'Historical inspection command');
    const b = f.command(latest, 'Latest inspection command');
    const runs = [
      f.run(1, old, [f.detail(f.message(old, 'Historical request'))], 1),
      f.run(2, latest, [f.detail(f.message(latest, 'Latest request'))], 1),
    ];
    mount(
      f,
      (input) =>
        input.view === 'items'
          ? f.page([], { view: 'items', items: [f.detail(input.turnId === old ? a : b)] })
          : f.page(runs),
      { props: { lens: 'full' } }
    );
    await screen.findByText('Latest inspection command');
    expect(await screen.findByText('Historical inspection command')).toBeVisible();
  });

  it('R3 a second Item anchor in the same run pages from that Item, not the first anchor', async () => {
    const f = timelineFixture(),
      turn = allocateEntityId('tu');
    const a = f.command(turn, 'First anchored command'),
      b = f.command(turn, 'Second anchored command');
    const nextA = f.command(turn, 'Neighbor of first anchor'),
      nextB = f.command(turn, 'Neighbor of second anchor');
    const runs = [f.run(1, turn, [f.detail(f.message(turn, 'Anchor request'))], 4)];
    const read: TimelineRead = (input) => {
      if (input.cursor)
        return f.page([], {
          view: 'items',
          items: [f.detail(input.cursor === 'after-second' ? nextB : nextA)],
        });
      const second = input.anchor?.kind === 'item' && input.anchor.itemId === b.id;
      return f.page(runs, {
        anchor: { turnId: turn, itemId: second ? b.id : a.id },
        itemWindow: {
          turnId: turn,
          items: [f.detail(second ? b : a)],
          beforeCursor: null,
          afterCursor: second ? 'after-second' : 'after-first',
        },
      });
    };
    const view = mount(f, read, {
      props: { lens: 'full', anchor: { kind: 'item', itemId: a.id } },
    });
    await screen.findByText('First anchored command');
    view.change({ lens: 'full', anchor: { kind: 'item', itemId: b.id } });
    await screen.findByText('Second anchored command');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Load later' }));
    await screen.findByText('Neighbor of second anchor');
  });

  it('R5 renders a Level-2 command preview and the run’s plan preview', async () => {
    const f = timelineFixture(),
      turn = allocateEntityId('tu');
    const loaded = f.command(turn, 'Complete command proves the page arrived');
    const command = f.detail(f.command(turn, 'Large command'));
    command.detail = {
      kind: 'preview',
      field: 'output',
      text: 'Retained large command output preview',
      sizeBytes: 6000,
      side: 'head',
      truncated: true,
    };
    const plan = f.detail(
      f.item(turn, {
        type: 'plan',
        title: 'Large plan',
        summary: 'Inspect the recorded inputs',
        steps: [{ id: 's', title: 'Inspect inputs', status: 'pending' }],
      })
    );
    plan.detail = {
      kind: 'preview',
      field: 'json',
      text: 'Retained large plan preview',
      sizeBytes: 6000,
      side: 'head',
      truncated: true,
    };
    const runs = [f.run(1, turn, [f.detail(f.message(turn, 'Preview request'))], 2, { plan })];
    mount(
      f,
      (input) =>
        input.view === 'items'
          ? f.page([], { view: 'items', items: [f.detail(loaded), command] })
          : f.page(runs),
      { props: { lens: 'full' } }
    );
    await screen.findByText('Complete command proves the page arrived');
    expect.soft(screen.queryByText('Retained large command output preview')).toBeVisible();
    expect.soft(screen.queryByText('Retained large plan preview')).toBeVisible();
  });

  it('R6 the phone’s two-row bar offers the second attention row in its walk', async () => {
    width = 360;
    const f = timelineFixture(),
      turn = allocateEntityId('tu');
    const first = f.question(turn, 'Choose the export format'),
      second = f.question(turn, 'Choose the export destination');
    const runs = [f.run(1, turn, [f.detail(first)])];
    mount(f, () => f.page(runs), { attention: f.attention([first, second]) });
    const bar = await screen.findByRole('button', { name: /2 needs you/ });
    await userEvent.setup().click(bar);
    expect(screen.getByRole('dialog', { name: 'Decision' })).toBeVisible();
    const next = screen.getByRole('button', { name: 'Next decision (1 more) ›' });
    await userEvent.setup().click(next);
    expect(screen.getByText('Choose option 2')).toBeVisible();
  });

  it('R7 the production renderer commits at most ten times per second during sustained deltas', async () => {
    const f = timelineFixture(),
      turn = allocateEntityId('tu');
    const live = f.item(turn, {
      type: 'assistant-message',
      text: 'Visible streamed answer',
      status: 'in_progress',
      completedAt: null,
    });
    const runs = [f.run(1, turn, [f.detail(live)], 0, { status: 'running', completedAt: null })];
    let commits = 0;
    const view = mount(f, () => f.page(runs), {
      running: true,
      onCommit: () => {
        commits += 1;
      },
    });
    await screen.findByText('Visible streamed answer');
    await waitFor(() => expect(view.subscribe).toHaveBeenCalled());
    let sequence = 1;
    const envelope = (data: unknown) => ({
      protocolVersion: '0.7.0',
      event: sequence === 1 ? 'item.created' : 'item.delta',
      sequence: sequence++,
      requestId: null,
      timestamp: new Date().toISOString(),
      workspaceId: f.workspaceId,
      threadId: f.threadId,
      turnId: turn,
      data,
    });
    await act(async () => {
      view.pipe.push(envelope({ type: 'item-created', item: live }));
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    const before = commits,
      started = performance.now();
    for (let index = 0; index < 40; index += 1) {
      await act(async () => {
        view.pipe.push(
          envelope({
            type: 'item-delta',
            itemId: live.id,
            itemType: 'assistant-message',
            deltaKind: 'text-delta',
            delta: 'x',
          })
        );
        await new Promise((resolve) => setTimeout(resolve, 25));
      });
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    expect(screen.getByText(`Visible streamed answer${'x'.repeat(40)}`)).toBeVisible();
    const seconds = (performance.now() - started) / 1000;
    const observed = commits - before;
    console.log(`R7 commits=${observed} seconds=${seconds.toFixed(3)} deltas=40`);
    expect(
      observed,
      'Production timeline commit budget under sustained visible text deltas'
    ).toBeLessThanOrEqual(Math.ceil(seconds * 10) + 1);
  });
});
