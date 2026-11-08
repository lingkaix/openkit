import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import '../../../styles/timeline.css';
import { lintCopyText } from './copy';
import { longRunFixture } from './fixture';
import { RunEntry } from './RunEntry';
import { projectTimeline } from './source';

function renderFixture(lens: 'work' | 'full') {
  const fixture = longRunFixture();
  const timeline = projectTimeline({
    items: fixture.items,
    turns: [fixture.turn],
    latestTurnId: fixture.turn.id,
  });
  const entry = timeline.entries[0]!;
  return render(
    <MemoryRouter>
      <div data-timeline-lens={lens}>
        <RunEntry
          entry={entry}
          items={fixture.items}
          turn={fixture.turn}
          lens={lens}
          expanded={false}
          actorName="Worker"
          omitTrigger={false}
          durationMs={3 * 60 * 60 * 1000}
          hiddenIds={new Set()}
          renderItem={(item) => {
            if (item.type === 'assistant-message') return <p className="ok-prose">{item.text}</p>;
            if (item.type === 'user-message')
              return <p className="ok-prose">Check the export dates</p>;
            if (item.type === 'approval-request') return <p>{item.title}</p>;
            if (item.type === 'tool-call') return <p>{item.tool}</p>;
            if (item.type === 'file-change') return <p>{item.path}</p>;
            if (item.type === 'command-execution') return <p>{item.command}</p>;
            return null;
          }}
          inspected={false}
          onInspect={() => {}}
          showActivity={false}
        />
      </div>
    </MemoryRouter>
  );
}

describe('run entry presentation', () => {
  it('keeps identifiers out of Work and shows the plan plus three notes', () => {
    renderFixture('work');
    const work = document.querySelector('[data-timeline-lens="work"]');
    expect(work).not.toBeNull();
    expect(lintCopyText(work?.textContent ?? '')).toEqual([]);
    expect(screen.getByText('✓ Reproduce')).toBeInTheDocument();
    expect(screen.getByText('● Update tests')).toBeInTheDocument();
    expect(screen.getByText('Fifth note')).toBeInTheDocument();
    expect(screen.getByText('Fourth note')).toBeInTheDocument();
    expect(screen.getByText('Third note')).toBeInTheDocument();
    expect(screen.queryByText('First note')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '105 steps · 6 failed' })).toBeInTheDocument();
    expect(screen.getByText(/counted from records/)).toBeInTheDocument();
    expect(document.querySelector('[data-voice="fact"]')).not.toBeNull();
    expect(document.querySelector('[data-voice="claim"]')).not.toBeNull();
    const depths = [...document.querySelectorAll('[data-fold-depth]')].map((node) =>
      Number(node.getAttribute('data-fold-depth'))
    );
    expect(Math.max(...depths)).toBeLessThanOrEqual(2);
  });

  it('shows the same decision in Full and keeps the fold control when expanded', async () => {
    const user = userEvent.setup();
    const { unmount } = renderFixture('work');
    expect(screen.getByText('Approve the export')).toBeInTheDocument();
    expect(screen.queryByText('npm test')).not.toBeInTheDocument();
    unmount();
    renderFixture('full');
    expect(screen.getByText('Approve the export')).toBeInTheDocument();
    const fullControl = screen.getByRole('button', { name: '105 steps · 6 failed' });
    const before = fullControl.getBoundingClientRect().top;
    await user.click(fullControl);
    expect(fullControl.getBoundingClientRect().top).toBe(before);
    expect(fullControl.isConnected).toBe(true);
  });

  it('uses the prose measure on notes', () => {
    document.documentElement.style.setProperty('--ok-measure-prose', '72ch');
    renderFixture('work');
    const note = screen.getByText('Fifth note');
    const probe = document.createElement('div');
    probe.style.maxWidth = '72ch';
    document.body.append(probe);
    const style = getComputedStyle(note);
    expect(style.fontSize).toBe('16px');
    expect(style.lineHeight).toBe('24px');
    expect(style.maxWidth).toBe(getComputedStyle(probe).maxWidth);
    probe.remove();
  });
});
