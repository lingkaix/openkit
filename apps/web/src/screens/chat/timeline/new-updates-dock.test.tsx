import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TimelineScroll } from './TimelineScroll';

class StubObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

function scroll({
  host,
  count,
  showJump = false,
}: {
  host: HTMLElement | null;
  count: number;
  showJump?: boolean;
}) {
  return (
    <div data-timeline-scroll>
      <button type="button">Inspect</button>
      <TimelineScroll
        topEntryId={null}
        initiallyFollowing={false}
        canEarlier={false}
        canLater={false}
        paging={false}
        onEarlier={() => {}}
        onLater={() => {}}
        showJump={showJump}
        onJump={() => {}}
        newCount={count}
        decisionNew={false}
        updatesHost={host}
        onFollowChange={() => {}}
        onCatchUp={() => {}}
      >
        <p>A note from Ada</p>
      </TimelineScroll>
    </div>
  );
}

describe('new updates dock', () => {
  beforeEach(() => {
    vi.stubGlobal('IntersectionObserver', StubObserver);
  });

  it('places the new-updates control outside the scrolling entries', () => {
    const host = document.createElement('div');
    host.setAttribute('data-new-updates-dock', 'bar');
    document.body.appendChild(host);
    render(scroll({ host, count: 3, showJump: true }));
    const pill = screen.getByRole('button', { name: '↓ 3 new' });
    expect(pill.closest('[data-new-updates-dock]')).toBe(host);
    expect(pill.closest('[data-timeline-scroll]')).toBeNull();
    const jump = screen.getByRole('button', { name: 'Jump to latest' });
    expect(jump.closest('[data-timeline-scroll]')).not.toBeNull();
    expect(jump.className).toContain('sticky');
    host.remove();
  });

  it('does not stick the new-updates control over entries when no dock is mounted', () => {
    render(scroll({ host: null, count: 2 }));
    const pill = screen.getByRole('button', { name: '↓ 2 new' });
    expect(pill.className).not.toContain('sticky');
  });
});
