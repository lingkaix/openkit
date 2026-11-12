import { act, render } from '@testing-library/react';
import { memo } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { ThreadItem } from '../data';
import { useCoalescedItems } from './use-timeline-window';

const View = memo(function View({
  items,
  commits,
}: {
  items: readonly ThreadItem[];
  commits: { current: number };
}) {
  commits.current += 1;
  return <span>{items.length}</span>;
});

function Probe({ items, commits }: { items: readonly ThreadItem[]; commits: { current: number } }) {
  const shown = useCoalescedItems(items);
  return <View items={shown} commits={commits} />;
}

describe('timeline text coalescing', () => {
  it('paints one frame for a burst of item snapshots', async () => {
    let frame: FrameRequestCallback | null = null;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frame = callback;
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    const commits = { current: 0 };
    const initial = [{ id: 'a' }] as ThreadItem[];
    const latest = Array.from({ length: 8 }, (_, index) => ({
      id: `n-${index}`,
    })) as ThreadItem[];
    const view = render(<Probe items={initial} commits={commits} />);
    for (let index = 0; index < 20; index += 1) {
      const tick = [{ id: `tick-${index}` }] as ThreadItem[];
      view.rerender(<Probe items={index === 19 ? latest : tick} commits={commits} />);
    }
    expect(view.getByText('1')).toBeTruthy();
    const paint = frame as FrameRequestCallback | null;
    if (!paint) throw new Error('The burst did not schedule a paint.');
    await act(async () => {
      paint(1_000);
    });
    expect(view.getByText('8')).toBeTruthy();
    expect(commits.current).toBeLessThanOrEqual(3);
    vi.unstubAllGlobals();
  });
});
