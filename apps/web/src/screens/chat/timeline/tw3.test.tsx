import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ItemView } from '../ItemView';
import { AlignmentHeader } from './AlignmentHeader';
import { openDecisionIds, planEmphasis } from './emphasis';
import { buildAlignment } from './header';
import { NeedsYouBar } from './NeedsYouBar';
import {
  attentionDisplayTitle,
  attentionWalk,
  type NeedsYouRow,
  needsYouActivation,
  needsYouSummary,
  orderNeedsYou,
  toNeedsYouRow,
} from './needs-you';
import { deriveNow, nowFromThread, nowStepFromDashboard } from './now';
import { TimelineTime } from './TimelineTime';
import { formatDuration, formatTimelineTime, stalenessLabel } from './time';

const NOW = Date.parse('2026-11-08T12:00:00.000Z');

function row(
  partial: Partial<NeedsYouRow> & Pick<NeedsYouRow, 'id' | 'title' | 'createdAt'>
): NeedsYouRow {
  return {
    blocking: false,
    ...partial,
  };
}

describe('Needs you', () => {
  const blockingOld = row({
    id: 'block-old',
    title: 'Choose a date format',
    blocking: true,
    createdAt: '2026-11-08T09:00:00.000Z',
    ageSeconds: 10_800,
  });
  const blockingNew = row({
    id: 'block-new',
    title: 'Approve the summary',
    blocking: true,
    createdAt: '2026-11-08T11:00:00.000Z',
  });
  const waiting = row({
    id: 'waiting',
    title: 'Review the notes',
    blocking: false,
    createdAt: '2026-11-08T08:00:00.000Z',
  });

  it('puts blocking rows first, then oldest', () => {
    expect(orderNeedsYou([waiting, blockingNew, blockingOld]).map((entry) => entry.id)).toEqual([
      'block-old',
      'block-new',
      'waiting',
    ]);
  });

  it('collapses several rows to the count and the next title', () => {
    const ordered = orderNeedsYou([waiting, blockingNew, blockingOld]);
    expect(needsYouSummary(ordered)).toBe('3 need you · Next: Choose a date format ›');
  });

  it('scrolls to the anchored card and focuses it', async () => {
    const user = userEvent.setup();
    const anchored = row({
      id: 'jump',
      title: 'Choose a date format',
      createdAt: '2026-11-08T11:00:00.000Z',
      threadId: 'th_task',
      turnId: 'tu_run',
      itemId: 'it_card',
    });
    render(
      <>
        <NeedsYouBar rows={[anchored]} threadId="th_task" emphasize={false} reducedMotion />
        <div id="timeline-item-it_card" tabIndex={-1}>
          Decision card
        </div>
      </>
    );
    await user.click(screen.getByRole('button', { name: /Choose a date format/ }));
    expect(document.activeElement).toHaveTextContent('Decision card');
  });

  it('opens the owning surface when the row has no timeline anchor', async () => {
    const user = userEvent.setup();
    const opened = vi.fn();
    const recovery = row({
      id: 'recover',
      title: 'Recover the workspace',
      createdAt: '2026-11-08T11:00:00.000Z',
      threadId: 'th_task',
      surfaceHref: '/workspace-changes',
    });
    expect(needsYouActivation(recovery)).toEqual({ type: 'surface', href: '/workspace-changes' });
    render(
      <NeedsYouBar
        rows={[recovery]}
        threadId="th_task"
        emphasize={false}
        reducedMotion
        onOpen={opened}
      />
    );
    await user.click(screen.getByRole('button', { name: /Recover the workspace/ }));
    expect(opened).toHaveBeenCalledWith('/workspace-changes');
  });

  it('keeps a row until the authoritative outcome drops it', () => {
    const pending = row({
      id: 'stay',
      title: 'Choose a date format',
      createdAt: '2026-11-08T11:00:00.000Z',
    });
    const { rerender } = render(<NeedsYouBar rows={[pending]} emphasize={false} reducedMotion />);
    expect(screen.getByRole('button', { name: /Choose a date format/ })).toBeInTheDocument();
    rerender(<NeedsYouBar rows={[pending]} emphasize={false} reducedMotion />);
    expect(screen.getByRole('button', { name: /Choose a date format/ })).toBeInTheDocument();
    rerender(<NeedsYouBar rows={[]} emphasize={false} reducedMotion />);
    expect(screen.queryByRole('button', { name: /Choose a date format/ })).not.toBeInTheDocument();
  });

  it('shows the row age from ageSeconds and does not replace it', () => {
    render(
      <NeedsYouBar
        rows={[
          row({
            id: 'age',
            title: 'Choose a date format',
            createdAt: '2020-01-01T00:00:00.000Z',
            ageSeconds: 90,
          }),
        ]}
        emphasize={false}
        reducedMotion
        now={NOW}
      />
    );
    expect(screen.getByText('1 min ago')).toBeInTheDocument();
  });
});

describe('Now', () => {
  const base = {
    now: NOW,
    readFailed: false,
    stopPending: false,
    blockingCount: 0,
    steps: [],
  };

  it('hides a finished run and keeps the finished age for the header', () => {
    const model = deriveNow({
      ...base,
      turn: { status: 'completed', completedAt: new Date(NOW - 3 * 60 * 60 * 1000).toISOString() },
    });
    expect(model.kind).toBe('hidden');
    if (model.kind === 'hidden') expect(model.text).toBe('Finished 3 h ago');
  });

  it('says a run is waiting to start, and includes the queue only when it is known', () => {
    expect(deriveNow({ ...base, turn: { status: 'pending' }, queueAhead: 2 }).text).toBe(
      'Waiting for a free worker · 2 ahead'
    );
    const omitted = deriveNow({ ...base, turn: { status: 'pending' } });
    expect(omitted.text).toBe('Waiting for a free worker');
    expect(omitted.text).not.toContain('ahead');
  });

  it('shows only the elapsed time for a 40-minute command and never Quiet', () => {
    const started = new Date(NOW - 40 * 60 * 1000).toISOString();
    const model = deriveNow({
      ...base,
      turn: { status: 'running', startedAt: started, reasoningEffort: 'medium' },
      steps: [{ kind: 'command', inProgress: true, startedAt: started }],
      lastEventAt: started,
    });
    expect(model.kind).toBe('step');
    expect(model.text).toBe('Running a command · 40 min');
    expect(model.text).not.toMatch(/no activity|Quiet|Working/);
    const fromThread = nowFromThread({
      now: NOW,
      readFailed: false,
      stopPending: false,
      blockingCount: 0,
      turns: [{ id: 'tu', status: 'running', startedAt: started, reasoningEffort: 'medium' }],
      items: [
        {
          type: 'command-execution',
          turnId: 'tu',
          status: 'in_progress',
          createdAt: started,
          exitCode: null,
          completedAt: null,
        },
      ],
    });
    expect(fromThread.kind).toBe('step');
    expect(fromThread.text).not.toMatch(/no activity/);
  });

  it('says the run is thinking when no step is in progress and an event is recent', () => {
    const started = new Date(NOW - 2 * 60 * 1000).toISOString();
    const model = deriveNow({
      ...base,
      turn: { status: 'running', startedAt: started, reasoningEffort: 'medium' },
      lastEventAt: new Date(NOW - 30 * 1000).toISOString(),
    });
    expect(model.kind).toBe('thinking');
    expect(model.text).toBe('Thinking · 2 min');
  });

  it('uses the quiet threshold for medium effort, high effort, and finish-only adapters', () => {
    const running = (minutes: number, effort: string, finished = false) =>
      deriveNow({
        ...base,
        turn: {
          status: 'running',
          startedAt: new Date(NOW - minutes * 60 * 1000).toISOString(),
          reasoningEffort: effort,
        },
        lastEventAt: new Date(NOW - minutes * 60 * 1000).toISOString(),
        stepsReportedWhenFinished: finished,
      });
    expect(running(4, 'medium').kind).toBe('thinking');
    expect(running(6, 'medium').kind).toBe('quiet');
    expect(running(6, 'medium').text).toContain('no activity for 6 min');
    expect(running(6, 'high').kind).toBe('thinking');
    expect(running(11, 'high').kind).toBe('quiet');
    expect(running(11, 'max').text).toContain('no activity for 11 min');
    const under = running(20, 'medium', true);
    const over = running(31, 'medium', true);
    expect(under.kind).toBe('thinking');
    expect(under.text ?? '').toMatch(/^Working/);
    expect(under.text ?? '').not.toContain('no activity');
    expect(over.kind).toBe('quiet');
    expect(over.text ?? '').toMatch(/^Working/);
  });

  it('omits Quiet when no event time was loaded', () => {
    const started = new Date(NOW - 40 * 60 * 1000).toISOString();
    const model = nowFromThread({
      now: NOW,
      readFailed: false,
      stopPending: false,
      blockingCount: 0,
      turns: [{ id: 'tu', status: 'running', startedAt: started, reasoningEffort: 'medium' }],
      items: [],
    });
    expect(model.kind).toBe('thinking');
    expect(model.text).not.toContain('no activity');
  });

  it('does not treat historical window items as live activity of a running turn', () => {
    const started = new Date(NOW - 15_000).toISOString();
    const historical = new Date(NOW - 60 * 60 * 60 * 1000).toISOString();
    const model = nowFromThread({
      now: NOW,
      readFailed: false,
      stopPending: false,
      blockingCount: 0,
      turns: [{ id: 'tu', status: 'running', startedAt: started, reasoningEffort: 'medium' }],
      items: [
        {
          type: 'command-execution',
          turnId: 'tu',
          status: 'in_progress',
          createdAt: historical,
          exitCode: null,
          completedAt: null,
        },
        { type: 'note', turnId: 'tu', status: 'completed', createdAt: historical },
      ],
    });
    expect(model.kind).toBe('thinking');
    expect(model.text).toBe('Thinking · 15 s');
    expect(model.text).not.toMatch(/no activity/);
  });

  it('uses the live event of this run when the window items are older than the run', () => {
    const started = new Date(NOW - 10 * 60 * 1000).toISOString();
    const historical = new Date(NOW - 60 * 60 * 60 * 1000).toISOString();
    const model = nowFromThread({
      now: NOW,
      readFailed: false,
      stopPending: false,
      blockingCount: 0,
      turns: [{ id: 'tu', status: 'running', startedAt: started, reasoningEffort: 'medium' }],
      liveEventAt: new Date(NOW - 6 * 60 * 1000).toISOString(),
      items: [{ type: 'note', turnId: 'tu', status: 'completed', createdAt: historical }],
    });
    expect(model.kind).toBe('quiet');
    expect(model.text).toContain('no activity for 6 min');
    expect(model.text).not.toMatch(/60 h/);
  });

  it('uses the dashboard step and queue when the window does not have them', () => {
    const started = new Date(NOW - 15_000).toISOString();
    const historical = new Date(NOW - 60 * 60 * 60 * 1000).toISOString();
    const step = nowStepFromDashboard({
      kind: 'command-execution',
      title: 'npm test',
      startedAt: new Date(NOW - 10_000).toISOString(),
    });
    const model = nowFromThread({
      now: NOW,
      readFailed: false,
      stopPending: false,
      blockingCount: 0,
      turns: [{ id: 'tu', status: 'running', startedAt: started, reasoningEffort: 'medium' }],
      items: [
        {
          type: 'command-execution',
          turnId: 'tu',
          status: 'in_progress',
          createdAt: historical,
          exitCode: null,
          completedAt: null,
        },
      ],
      liveStep: step,
    });
    expect(model.kind).toBe('step');
    expect(model.text).toBe('Running a command · 10 s');
    expect(model.text).not.toMatch(/no activity|60 h/);
    expect(
      nowFromThread({
        now: NOW,
        readFailed: false,
        stopPending: false,
        blockingCount: 0,
        turns: [{ id: 'tu', status: 'pending' }],
        items: [],
        queueAhead: 2,
      }).text
    ).toBe('Waiting for a free worker · 2 ahead');
    expect(nowStepFromDashboard({ kind: 'file-change', startedAt: started })).toBeNull();
  });

  it('says the run is waiting for you when a blocking request exists', () => {
    const model = deriveNow({
      ...base,
      turn: { status: 'completed', completedAt: new Date(NOW - 60_000).toISOString() },
      blockingCount: 1,
    });
    expect(model).toMatchObject({
      kind: 'waiting-for-you',
      text: 'Waiting for you · 1 decision',
      accent: true,
    });
  });

  it('says the run is stopping until the final state arrives', () => {
    expect(
      deriveNow({
        ...base,
        stopPending: true,
        turn: { status: 'running', startedAt: new Date(NOW).toISOString() },
      }).text
    ).toBe('Stopping…');
  });

  it('says a run ended with a problem within 24 hours', () => {
    const model = deriveNow({
      ...base,
      turn: {
        status: 'interrupted',
        completedAt: new Date(NOW - 20 * 60 * 1000).toISOString(),
        errorMessage: 'tests failed',
      },
    });
    expect(model.text).toBe('Stopped 20 min ago: tests failed');
  });

  it('says status is unavailable when the read fails, and never calls an unknown status failed', () => {
    const unavailable = deriveNow({
      ...base,
      readFailed: true,
      lastKnown: { status: 'running', at: '2026-11-08T10:42:00.000Z' },
    });
    expect(unavailable.text).toBe('Status unavailable · last known: running at 10:42');
    const unknown = deriveNow({ ...base, turn: { status: 'mystery' } });
    expect(unknown.kind).toBe('unavailable');
    expect(unknown.text).not.toMatch(/Failed/);
  });
});

describe('alignment header', () => {
  it('shows the task objective and plan progress across runs, and labels a stale plan', () => {
    const model = buildAlignment({
      profileId: 'task',
      now: NOW,
      taskInputs: [{ objective: 'Fix the CSV export so dates use the Workspace time zone' }],
      items: [
        {
          type: 'plan',
          turnId: 'later-run',
          createdAt: '2026-11-08T11:50:00.000Z',
          steps: [
            { title: 'Reproduce', status: 'completed' },
            { title: 'Fix formatter', status: 'completed' },
            { title: 'Old step', status: 'pending' },
          ],
        },
        {
          type: 'plan',
          turnId: 'earlier-run',
          createdAt: '2026-11-08T10:00:00.000Z',
          steps: [
            { title: 'Reproduce', status: 'completed' },
            { title: 'Fix formatter', status: 'completed' },
            { title: 'Update tests', status: 'in_progress' },
            { title: 'Docs', status: 'pending' },
            { title: 'Final check', status: 'pending' },
          ],
        },
      ],
      turn: { status: 'running', startedAt: '2026-11-08T11:00:00.000Z' },
    });
    expect(model?.objective).toBe('Fix the CSV export so dates use the Workspace time zone');
    expect(model?.progress).toBe('2 of 3 done');
    expect(model?.staleLabel).toBe('Updated 10 min ago');
  });

  it('uses the newest plan even when an older plan sits on a later run', () => {
    const model = buildAlignment({
      profileId: 'task',
      now: Date.parse('2026-11-08T12:00:00.000Z'),
      items: [
        {
          type: 'plan',
          turnId: 'run-1',
          createdAt: '2026-11-08T11:59:30.000Z',
          steps: [
            { title: 'Reproduce', status: 'completed' },
            { title: 'Fix formatter', status: 'completed' },
            { title: 'Update tests', status: 'in_progress' },
            { title: 'Docs', status: 'pending' },
            { title: 'Final check', status: 'pending' },
          ],
        },
        {
          type: 'plan',
          turnId: 'run-2',
          createdAt: '2026-11-08T09:00:00.000Z',
          steps: [{ title: 'Old', status: 'completed' }],
        },
      ],
      turn: { status: 'running' },
    });
    expect(model?.progress).toBe('2 of 5 done · now: Update tests');
    expect(model?.staleLabel).toBeNull();
  });

  it('says the task is waiting, not finished, while a decision is open', () => {
    const model = buildAlignment({
      profileId: 'task',
      now: NOW,
      items: [],
      turn: { status: 'completed', completedAt: '2026-11-08T11:00:00.000Z' },
      awaitingDecision: true,
    });
    render(<AlignmentHeader model={model} />);
    expect(screen.getByText('Status · Waiting for you')).toBeInTheDocument();
    expect(screen.queryByText(/Finished/)).not.toBeInTheDocument();
  });

  it('keeps Finished when no decision is open', () => {
    const model = buildAlignment({
      profileId: 'task',
      now: NOW,
      items: [],
      turn: { status: 'completed', completedAt: '2026-11-08T11:59:00.000Z' },
    });
    expect(model?.statusLabel).toMatch(/Finished/);
  });

  it('uses the request question when the attention title is generic', () => {
    const row = toNeedsYouRow(
      {
        id: 'question:1',
        title: 'Answer required',
        summary: 'Answer the question on its pending request.',
        blocking: true,
        createdAt: '2026-11-08T11:00:00.000Z',
        threadId: 'th_task',
        turnId: 'tu_run',
        itemId: 'it_question',
      },
      '/tasks/ws/th',
      'Weekly notes',
      'Which summary tone should the weekly note use?'
    );
    expect(row.title).toBe('Which summary tone should the weekly note use?');
    expect(row.taskLabel).toBe('Weekly notes');
    const long = 'Which summary tone should the weekly note use for the shared workspace? '.repeat(
      3
    );
    expect(attentionDisplayTitle('Answer required', undefined, long).endsWith('…')).toBe(true);
    expect(attentionDisplayTitle('Answer required', undefined, long).length).toBeLessThanOrEqual(
      80
    );
  });

  it('keeps the assistant header to the title', () => {
    expect(
      buildAlignment({
        profileId: 'assistant',
        now: NOW,
        taskInputs: [{ objective: 'Should not show' }],
        items: [],
        turn: { status: 'running' },
      })
    ).toBeNull();
  });
});

describe('attention walk', () => {
  it('keeps every attention row, including one whose item is not loaded', () => {
    const rows = [
      { id: 'row-1', itemId: 'it_loaded' },
      { id: 'row-2', itemId: 'it_missing' },
      { id: 'row-3' },
      { id: 'row-4', itemId: 'it_other' },
    ];
    const walk = attentionWalk(rows, [{ id: 'it_loaded' }]);
    expect(walk).toHaveLength(rows.length);
    expect(walk.filter((entry) => entry.item != null)).toHaveLength(1);
    expect(walk.map((entry) => entry.key)).toEqual([
      'it_loaded',
      'it_missing',
      'row-3',
      'it_other',
    ]);
  });
});

describe('U2 emphasis budget', () => {
  it('folds extra decision rows into the bar count', () => {
    const plan = planEmphasis({
      needsYou: true,
      nowWaiting: false,
      decisionIds: openDecisionIds([
        { id: 'a', type: 'approval-request', approvalRequestId: '1' },
        { id: 'b', type: 'approval-request', approvalRequestId: '2' },
        { id: 'c', type: 'user-input-request', userInputRequestId: '3' },
        { id: 'd', type: 'approval-request', approvalRequestId: '4' },
        { id: 'done', type: 'approval-decision', approvalRequestId: '4' },
      ]),
    });
    expect(plan.bar).toBe(true);
    expect(plan.decisions).toEqual(['a', 'b']);
    expect(plan.decisions).not.toContain('d');
  });
});

describe('U5 time', () => {
  it('switches at 24 hours and at one second', () => {
    const inside = formatTimelineTime(
      new Date(NOW - 24 * 60 * 60 * 1000 + 1000).toISOString(),
      NOW
    );
    const beyond = formatTimelineTime(new Date(NOW - 24 * 60 * 60 * 1000).toISOString(), NOW);
    expect(inside.text).toMatch(/ago$/);
    expect(beyond.text).not.toMatch(/ago$/);
    expect(beyond.dateTime).toContain('2026-11-07');
    const ahead = formatTimelineTime(new Date(NOW + 30_000).toISOString(), NOW);
    expect(ahead.text).toBe('0 s ago');
    expect(ahead.title).not.toBe(ahead.text);
    const dayAhead = formatTimelineTime(new Date(NOW + 24 * 60 * 60 * 1000).toISOString(), NOW);
    expect(dayAhead.text).not.toMatch(/ago$/);
    expect(formatDuration(999)).toBeNull();
    expect(formatDuration(1000)).toBe('1 s');
    expect(formatDuration(60_000)).toBe('1 min');
    expect(stalenessLabel(2 * 60 * 1000)).toBe('Updated 2 min ago');
  });

  it('renders a time element with a datetime', () => {
    render(<TimelineTime iso="2026-11-08T11:00:00.000Z" now={NOW} />);
    const time = screen.getByText('1 h ago');
    expect(time.tagName).toBe('TIME');
    expect(time).toHaveAttribute('datetime', '2026-11-08T11:00:00.000Z');
    expect(time).toHaveAttribute('title');
  });
});

describe('Run accepted', () => {
  it('renders as a neutral fact line, not a warning card', () => {
    render(
      <ItemView
        item={{
          id: 'it_status',
          type: 'status',
          level: 'warning',
          title: 'Worker Turn accepted',
          summary: 'Conversation continued with agent_codex.',
          createdAt: '2026-11-08T11:00:00.000Z',
          status: 'completed',
          threadId: 'th',
          turnId: 'tu',
          owner: { kind: 'workspace', workspaceId: 'ws' },
          completedAt: '2026-11-08T11:00:00.000Z',
        }}
      />
    );
    const line = screen.getByText('Run accepted');
    expect(line.closest('[data-status="fact"]')).not.toBeNull();
    expect(line.closest('[class*="bg-notice"]')).toBeNull();
    expect(screen.getByText('The run continued.')).toBeInTheDocument();
  });
});
