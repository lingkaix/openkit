import { ItemSchema } from '@openkit/protocol';
import { useState } from 'react';
import { ItemView } from '../ItemView';
import { planEmphasis } from './emphasis';
import { NeedsYouBar } from './NeedsYouBar';
import type { NeedsYouRow } from './needs-you';
import { TimelineTime } from './TimelineTime';

const DECISIONS = ['one', 'two', 'three', 'four'] as const;

const ROWS: NeedsYouRow[] = [
  {
    id: 'row-block',
    title: 'Choose a date format',
    blocking: true,
    ageSeconds: 120,
    createdAt: '2026-11-08T11:00:00.000Z',
    threadId: 'th_fixture',
    turnId: 'tu_fixture',
    itemId: 'it_fixture',
  },
  {
    id: 'row-next',
    title: 'Approve the summary',
    blocking: false,
    ageSeconds: 30,
    createdAt: '2026-11-08T11:30:00.000Z',
    threadId: 'th_fixture',
  },
  {
    id: 'row-third',
    title: 'Review the notes',
    blocking: false,
    ageSeconds: 10,
    createdAt: '2026-11-08T11:40:00.000Z',
    threadId: 'th_fixture',
  },
  {
    id: 'row-fourth',
    title: 'Accept the plan',
    blocking: false,
    ageSeconds: 5,
    createdAt: '2026-11-08T11:50:00.000Z',
    threadId: 'th_fixture',
  },
];

const ACCEPTED = ItemSchema.parse({
  id: 'it_00000000-0000-76eb-a38d-371253d2bde1',
  owner: { kind: 'workspace', workspaceId: 'ws_00000000-0000-7b10-9af8-12fd37a880e0' },
  threadId: 'th_00000000-0000-7b47-b9e3-5a516884858f',
  turnId: 'tu_00000000-0000-7a1a-a69e-d1682e886e7c',
  type: 'status',
  status: 'completed',
  level: 'warning',
  title: 'Worker Turn accepted',
  summary: 'Conversation continued with agent_codex.',
  createdAt: '2026-09-16T05:20:01.000Z',
  completedAt: '2026-09-16T05:20:01.000Z',
});

/**
 * Dev-only fixture for the emphasis budget, the neutral Run accepted line, and motion.
 * The isolated browser check opens this route. It is not a product surface.
 */
export function TimelineFixtureScreen() {
  const live = new URLSearchParams(window.location.search).get('motion') === 'live';
  const [open, setOpen] = useState(false);
  const emphasis = planEmphasis({
    needsYou: true,
    nowWaiting: false,
    decisionIds: [...DECISIONS],
  });
  const emphasized = new Set(emphasis.decisions);
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-4 px-6 py-8">
      <h1>Timeline fixture</h1>
      <NeedsYouBar
        rows={ROWS}
        threadId="th_fixture"
        emphasize={emphasis.bar}
        reducedMotion={!live}
        now={Date.parse('2026-11-08T12:00:00.000Z')}
      />
      <button type="button" onClick={() => setOpen((value) => !value)}>
        {open ? 'Hide decisions' : 'Show decisions'}
      </button>
      {open ? null : (
        <div className="flex flex-col gap-2">
          {DECISIONS.map((id) => (
            <button
              key={id}
              type="button"
              {...(emphasized.has(id) ? { 'data-emphasis': 'true' } : {})}
            >
              Approve
            </button>
          ))}
        </div>
      )}
      <ItemView item={ACCEPTED} />
      <TimelineTime iso="2026-11-08T11:00:00.000Z" now={Date.parse('2026-11-08T12:00:00.000Z')} />
      <span className="ok-now-dot" data-live={live ? 'true' : 'false'} aria-hidden="true" />
    </main>
  );
}
