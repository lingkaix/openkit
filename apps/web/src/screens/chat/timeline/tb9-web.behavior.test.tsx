import type { TimelineRunEntry } from '@openkit/app-api-schemas';
import { allocateEntityId } from '@openkit/protocol';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { Inspector } from './Inspector';
import { RunEntry } from './RunEntry';
import { projectTimeline, type TimelineTurn } from './source';

type Usage = NonNullable<TimelineRunEntry['usage']>;
type Fallback = NonNullable<TimelineRunEntry['fallback']>;

const turnId = allocateEntityId('tu');

function renderRun(
  lens: 'work' | 'full',
  usage: Usage | null | undefined,
  fallback: Fallback | null | undefined
) {
  const turn: TimelineTurn = {
    id: turnId,
    status: 'completed',
    startedAt: '2026-11-08T02:00:00.000Z',
    completedAt: '2026-11-08T02:05:00.000Z',
  };
  const timeline = projectTimeline({
    items: [],
    turns: [turn],
    latestTurnId: turn.id,
    focusTurnId: turn.id,
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['thread-timeline', 'held'], {
    runs: [{ id: turnId, usage: usage ?? null, fallback: fallback ?? null }],
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <RunEntry
          entry={timeline.entries[0]!}
          items={[]}
          turn={turn}
          lens={lens}
          expanded={false}
          actorName="Worker"
          omitTrigger={false}
          durationMs={null}
          hiddenIds={new Set()}
          renderItem={() => null}
          inspected={false}
          onInspect={() => {}}
          showActivity={false}
        />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function renderInspector(usage: Usage, fallback: Fallback | null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['thread-timeline', 'held'], {
    runs: [{ id: turnId, usage, fallback }],
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Inspector turnId={turnId} items={[]} sheet onClose={() => {}} />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

afterEach(() => {
  cleanup();
});

describe('per-run environment line', () => {
  it('reads partial usage as a lower bound and keeps token metrics separate', () => {
    renderRun(
      'full',
      {
        coverage: 'partial',
        measurements: [
          {
            category: 'llm',
            unit: 'tokens',
            source: 'llm-gateway-adapter-reported:input',
            quantity: 30,
          },
          {
            category: 'llm',
            unit: 'tokens',
            source: 'llm-gateway-adapter-reported:output',
            quantity: 10,
          },
          {
            category: 'llm',
            unit: 'tokens',
            source: 'llm-gateway-adapter-reported:total',
            quantity: 40,
          },
          {
            category: 'llm',
            unit: 'usd',
            source: 'llm-gateway-adapter-reported:cost_estimate',
            quantity: 1,
          },
        ],
      },
      null
    );
    expect(screen.getByText('at least 30 llm input tokens')).toBeInTheDocument();
    expect(screen.getByText('at least 10 llm output tokens')).toBeInTheDocument();
    expect(screen.getByText('at least 40 llm total tokens')).toBeInTheDocument();
    expect(screen.getByText('at least 1 llm usd')).toBeInTheDocument();
    expect(screen.queryByText(/80/)).not.toBeInTheDocument();
    expect(screen.queryByText(/llm-gateway/)).not.toBeInTheDocument();
    expect(screen.queryByText(/provider|model|price/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/fallback/)).not.toBeInTheDocument();
  });

  it('shows complete quantities without a lower-bound prefix', () => {
    renderRun(
      'full',
      {
        coverage: 'complete',
        measurements: [
          { category: 'llm', unit: 'tokens', source: null, quantity: 4 },
          { category: 'llm', unit: 'tokens', source: null, quantity: 6 },
        ],
      },
      null
    );
    expect(screen.getByText('4 llm tokens')).toBeInTheDocument();
    expect(screen.getByText('6 llm tokens')).toBeInTheDocument();
    expect(screen.queryByText('10 llm tokens')).not.toBeInTheDocument();
    expect(screen.queryByText(/at least/)).not.toBeInTheDocument();
  });

  it('shows a recorded zero and no number when usage is null or absent', () => {
    renderRun(
      'full',
      {
        coverage: 'complete',
        measurements: [
          {
            category: 'llm',
            unit: 'tokens',
            source: 'llm-gateway-adapter-reported:cache_read',
            quantity: 0,
          },
        ],
      },
      null
    );
    expect(screen.getByText('0 llm cache read tokens')).toBeInTheDocument();
    cleanup();

    renderRun('full', null, null);
    expect(screen.queryByText(/tokens/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^0 /)).not.toBeInTheDocument();
    cleanup();

    const turn: TimelineTurn = {
      id: turnId,
      status: 'completed',
      startedAt: '2026-11-08T02:00:00.000Z',
      completedAt: '2026-11-08T02:05:00.000Z',
    };
    const timeline = projectTimeline({
      items: [],
      turns: [turn],
      latestTurnId: turn.id,
      focusTurnId: turn.id,
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(['thread-timeline', 'held'], { runs: [{ id: turnId }] });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <RunEntry
            entry={timeline.entries[0]!}
            items={[]}
            turn={turn}
            lens="full"
            expanded={false}
            actorName="Worker"
            omitTrigger={false}
            durationMs={null}
            hiddenIds={new Set()}
            renderItem={() => null}
            inspected={false}
            onInspect={() => {}}
            showActivity={false}
          />
        </MemoryRouter>
      </QueryClientProvider>
    );
    expect(screen.queryByText(/tokens/)).not.toBeInTheDocument();
  });

  it('names a fallback only when calls used one', () => {
    renderRun('full', null, { callsWithFallback: 2, coverage: 'complete' });
    expect(screen.getByText('2 calls used a fallback route')).toBeInTheDocument();
    expect(screen.queryByText(/at least/)).not.toBeInTheDocument();
    expect(screen.queryByText(/provider|model/i)).not.toBeInTheDocument();
    cleanup();

    renderRun('full', null, { callsWithFallback: 2, coverage: 'partial' });
    expect(screen.getByText('at least 2 calls used a fallback route')).toBeInTheDocument();
    cleanup();

    renderRun('full', null, { callsWithFallback: 0, coverage: 'complete' });
    expect(screen.queryByText(/fallback/)).not.toBeInTheDocument();
    cleanup();

    renderRun('full', null, null);
    expect(screen.queryByText(/fallback/)).not.toBeInTheDocument();
  });

  it('keeps the environment line on Full and in the phone inspector', () => {
    const usage: Usage = {
      coverage: 'complete',
      measurements: [{ category: 'tool', unit: 'tool_calls', source: null, quantity: 2 }],
    };
    renderRun('work', usage, { callsWithFallback: 1, coverage: 'complete' });
    expect(screen.queryByText('2 tool calls')).not.toBeInTheDocument();
    expect(screen.queryByText('1 call used a fallback route')).not.toBeInTheDocument();
    cleanup();

    renderRun('full', usage, { callsWithFallback: 1, coverage: 'complete' });
    expect(screen.getByText('2 tool calls')).toBeInTheDocument();
    expect(screen.getByText('1 call used a fallback route')).toBeInTheDocument();
    cleanup();

    renderInspector(usage, null);
    expect(screen.getByRole('dialog', { name: 'Inspector' })).toBeInTheDocument();
    expect(screen.getByText('2 tool calls')).toBeInTheDocument();
  });
});
