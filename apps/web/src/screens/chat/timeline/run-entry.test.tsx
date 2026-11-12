import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import '../../../styles/timeline.css';
import { lintCopyText } from './copy';
import { longRunFixture } from './fixture';
import { RunEntry } from './RunEntry';
import { projectTimeline } from './source';
import type { NarrativePreview } from './window';

function renderFixture(
  lens: 'work' | 'full',
  extras?: {
    previews?: readonly NarrativePreview[];
    onShowFullText?: (preview: NarrativePreview) => void;
  },
  fixture = longRunFixture()
) {
  const timeline = projectTimeline({
    items: fixture.items,
    turns: [fixture.turn],
    latestTurnId: fixture.turn.id,
  });
  const entry = timeline.entries[0]!;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
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
            previews={extras?.previews}
            onShowFullText={extras?.onShowFullText}
          />
        </div>
      </MemoryRouter>
    </QueryClientProvider>
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

  it('keeps a preview beside the item it follows', async () => {
    const user = userEvent.setup();
    const fixture = longRunFixture();
    const decision = fixture.items.find((item) => item.type === 'approval-request');
    const command = fixture.items.find((item) => item.type === 'command-execution');
    if (!decision || !command) throw new Error('The fixture is missing a decision or a command.');
    const onShowFullText = vi.fn();
    const { unmount } = renderFixture(
      'work',
      {
        onShowFullText,
        previews: [
          {
            id: 'it-plan',
            afterItemId: decision.id,
            text: 'plan head',
            truncated: false,
            placement: 'narrative',
          },
          {
            id: 'it-cut',
            afterItemId: decision.id,
            text: 'cut head',
            truncated: true,
            placement: 'narrative',
          },
        ],
      },
      fixture
    );
    const decisionText = screen.getByText('Approve the export');
    const preview = screen.getByText('plan head');
    expect(decisionText.compareDocumentPosition(preview) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
    await user.click(screen.getByRole('button', { name: 'Show the full text' }));
    expect(onShowFullText).toHaveBeenCalledOnce();
    expect(onShowFullText.mock.calls[0]?.[0].id).toBe('it-cut');
    unmount();
    renderFixture(
      'full',
      {
        previews: [
          {
            id: 'it-out',
            afterItemId: command.id,
            text: 'command head',
            truncated: false,
            placement: 'step',
          },
        ],
      },
      fixture
    );
    const commandText = screen.getAllByText('npm test')[0];
    if (!commandText) throw new Error('The open fold did not show the command.');
    const output = screen.getByText('command head');
    expect(commandText.compareDocumentPosition(output) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
    expect(screen.queryByRole('button', { name: 'Show the full text' })).toBeNull();
  });

  it('focuses the loaded request the address names', () => {
    const previous = window.location.href;
    window.history.replaceState(null, '', '?request=apr-long');
    renderFixture('work');
    const card = screen.getByText('Approve the export').closest('[id^="timeline-item-"]');
    expect(card).toHaveFocus();
    window.history.replaceState(null, '', previous);
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
