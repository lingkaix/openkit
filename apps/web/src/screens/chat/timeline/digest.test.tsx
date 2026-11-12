import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { CatchUpDivider } from './CatchUpDivider';
import { timelineCopy } from './copy';
import {
  type DigestAnchor,
  type DigestLine,
  digestAnchorLocation,
  publishTimelineDigest,
  readTimelineDigest,
  subscribeTimelineDigest,
  visibleDigest,
} from './digest';
import { anchorFromSearch } from './window';

const itemId = 'it_00000000-0000-7000-8000-000000000001';
const turnId = 'tu_00000000-0000-7000-8000-000000000002';

function line(kind: DigestLine['kind'], count: number, anchor: DigestAnchor): DigestLine {
  return { kind, count, anchor };
}

const itemAnchor: DigestAnchor = { kind: 'item', itemId };

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="loc">{`${location.pathname}${location.search}`}</div>;
}

describe('catch-up digest lines', () => {
  it.each([
    ['needs-you', 1, '1 needs you'],
    ['needs-you', 3, '3 need you'],
    ['runs-finished', 1, '1 run finished'],
    ['runs-finished', 2, '2 runs finished'],
    ['outputs', 1, '1 output'],
    ['outputs', 4, '4 outputs'],
    ['plan-steps-finished', 1, '1 plan step finished'],
    ['plan-steps-finished', 6, '6 plan steps finished'],
    ['problems', 1, '1 problem'],
    ['problems', 2, '2 problems'],
    ['decisions-by-others', 1, '1 decision by someone else'],
    ['decisions-by-others', 3, '3 decisions by others'],
    ['new-messages', 1, '1 new message'],
    ['new-messages', 4, '4 new messages'],
  ] as const)('renders %s × %s as %s', (kind, count, label) => {
    const view = visibleDigest({
      lines: [line(kind, count, itemAnchor)],
      coverage: 'complete',
    });
    expect(view.lines.map((entry) => entry.label)).toEqual([label]);
    expect(view.partial).toBeNull();
  });

  it('omits a kind the server did not send and does not invent its count', () => {
    const view = visibleDigest({
      lines: [line('new-messages', 4, itemAnchor)],
      coverage: 'complete',
    });
    expect(view.lines.map((entry) => entry.kind)).toEqual(['new-messages']);
    expect(view.lines.some((entry) => entry.kind === 'needs-you')).toBe(false);
    expect(JSON.stringify(view)).not.toContain('"count"');
  });

  it('keeps server order and stops at seven lines', () => {
    const lines = (
      [
        'needs-you',
        'runs-finished',
        'outputs',
        'plan-steps-finished',
        'problems',
        'decisions-by-others',
        'new-messages',
        'needs-you',
      ] as const
    ).map((kind, index) => line(kind, index + 1, itemAnchor));
    const view = visibleDigest({ lines, coverage: 'complete' });
    expect(view.lines).toHaveLength(7);
    expect(view.lines.map((entry) => entry.kind)).toEqual([
      'needs-you',
      'runs-finished',
      'outputs',
      'plan-steps-finished',
      'problems',
      'decisions-by-others',
      'new-messages',
    ]);
  });

  it('marks partial counts as a lower bound and leaves complete counts exact', () => {
    const lines = [line('problems', 2, itemAnchor)];
    const partial = visibleDigest({ lines, coverage: 'partial' });
    expect(partial.lines[0]?.label).toBe('At least 2 problems');
    expect(partial.partial).toBe(timelineCopy.digestPartial);
    const complete = visibleDigest({ lines, coverage: 'complete' });
    expect(complete.lines[0]?.label).toBe('2 problems');
    expect(complete.partial).toBeNull();
  });

  it('opens each anchor through the timeline selectors', () => {
    const cases: DigestAnchor[] = [
      { kind: 'item', itemId },
      { kind: 'turn', turnId },
      { kind: 'attention', rowId: 'row-1' },
      { kind: 'catch-up' },
      { kind: 'latest' },
    ];
    for (const anchor of cases) {
      const target = digestAnchorLocation({
        pathname: '/tasks/ws/th',
        search: '?turnId=old&item=old&attention=old&catchUp=1',
        anchor,
      });
      expect(target.replace).toBe(true);
      expect(target.pathname).toBe('/tasks/ws/th');
      expect(anchorFromSearch(target.search)).toEqual(anchor);
    }
  });

  it('renders the server line and replaces history when that count is opened', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/tasks/ws/th?catchUp=1']}>
        <CatchUpDivider
          count={0}
          onEarlierUnread={() => undefined}
          digest={{
            lines: [line('new-messages', 4, itemAnchor)],
            coverage: 'complete',
          }}
        />
        <LocationProbe />
      </MemoryRouter>
    );
    expect(screen.getByRole('button', { name: '4 new messages' })).toBeVisible();
    expect(screen.queryByRole('button', { name: /need you/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: '4 new messages' }));
    expect(screen.getByTestId('loc').textContent).toBe(`/tasks/ws/th?item=${itemId}`);
  });

  it('shows the partial wording under the lines', () => {
    render(
      <MemoryRouter>
        <CatchUpDivider
          count={0}
          onEarlierUnread={() => undefined}
          digest={{ lines: [line('outputs', 2, itemAnchor)], coverage: 'partial' }}
        />
      </MemoryRouter>
    );
    expect(screen.getByRole('button', { name: 'At least 2 outputs' })).toBeVisible();
    expect(screen.getByText(timelineCopy.digestPartial)).toBeVisible();
  });

  it('publishes the read digest without copying it', () => {
    const digest = {
      lines: [line('runs-finished', 1, { kind: 'turn' as const, turnId })],
      coverage: 'complete' as const,
    };
    const seen: unknown[] = [];
    const stop = subscribeTimelineDigest(() => seen.push(readTimelineDigest()));
    publishTimelineDigest(digest);
    stop();
    publishTimelineDigest(null);
    expect(seen).toEqual([digest]);
    expect(readTimelineDigest()).toBeNull();
  });
});
