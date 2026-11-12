import type { TimelineItem, TimelineRunEntry } from '@openkit/app-api-schemas';
import { allocateEntityId, ItemSchema } from '@openkit/protocol';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { ThreadItem } from '../data';
import { Inspector } from './Inspector';
import { RunEntry } from './RunEntry';
import { projectTimeline, type TimelineTurn } from './source';

const owner = { kind: 'workspace' as const, workspaceId: allocateEntityId('ws') };
const threadId = allocateEntityId('th');
const turnId = allocateEntityId('tu');

function item(extra: Record<string, unknown>): ThreadItem {
  return ItemSchema.parse({
    id: allocateEntityId('it'),
    owner,
    threadId,
    turnId,
    status: 'completed',
    createdAt: '2026-11-08T02:00:00.000Z',
    completedAt: '2026-11-08T02:01:00.000Z',
    ...extra,
  }) as ThreadItem;
}

function badge(
  outcome: 'allowed' | 'denied' | 'waiting-approval',
  capabilityCallId: string,
  permissionDecisionId: string
): NonNullable<TimelineItem['policy']> {
  return {
    outcome,
    capabilityCallId,
    permissionDecisionId,
    connectionRef: 'do-not-show-connection',
  };
}

function renderRun(lens: 'work' | 'full', coverage: 'complete' | 'partial') {
  const plan = item({
    type: 'plan',
    title: 'Current plan',
    summary: 'In progress',
    steps: [{ id: 'fix', title: 'Fix formatter', status: 'completed' }],
  });
  const allowed = item({
    type: 'tool-call',
    tool: 'format',
    server: null,
    arguments: null,
    result: 'ok',
    error: null,
    durationMs: 10,
  });
  const waiting = item({
    type: 'tool-call',
    tool: 'lint',
    server: null,
    arguments: null,
    result: null,
    error: null,
    durationMs: null,
  });
  const denied = item({
    type: 'tool-call',
    tool: 'search',
    server: null,
    arguments: null,
    result: null,
    error: 'no',
    durationMs: 10,
  });
  const unlabeled = item({
    type: 'tool-call',
    tool: 'preview',
    server: null,
    arguments: null,
    result: null,
    error: null,
    durationMs: null,
  });
  const command = item({
    type: 'command-execution',
    command: 'npm test',
    cwd: '/workspace',
    output: '',
    exitCode: 0,
    durationMs: 10,
  });
  const items = [plan, allowed, waiting, denied, unlabeled, command];
  const turn: TimelineTurn = {
    id: turnId,
    status: 'completed',
    startedAt: '2026-11-08T02:00:00.000Z',
    completedAt: '2026-11-08T02:05:00.000Z',
  };
  const timeline = projectTimeline({ items, turns: [turn], latestTurnId: turn.id });
  const segments: TimelineRunEntry['planSegments'] = {
    coverage,
    segments: [
      {
        planItemId: plan.id,
        planRevision: 1,
        stepId: 'fix',
        title: 'Fix formatter',
        startSequence: 1,
        endSequence: null,
        steps: 18,
      },
      {
        planItemId: plan.id,
        planRevision: 1,
        stepId: 'notes',
        title: 'Write notes',
        startSequence: 19,
        endSequence: 22,
        steps: 4,
      },
    ],
  };
  const policies = [
    { id: allowed.id, policy: badge('allowed', 'call-allowed', 'decision-allowed') },
    { id: waiting.id, policy: badge('waiting-approval', 'call-waiting', 'decision-waiting') },
    { id: denied.id, policy: badge('denied', 'call-denied', 'decision-denied') },
    { id: unlabeled.id, policy: null },
    { id: command.id, policy: badge('allowed', 'call-command', 'decision-command') },
  ];
  render(
    <MemoryRouter>
      <RunEntry
        entry={{ ...timeline.entries[0]!, planSegments: segments, policies }}
        items={items}
        turn={turn}
        lens={lens}
        expanded={false}
        actorName="Worker"
        omitTrigger={false}
        durationMs={null}
        hiddenIds={new Set()}
        renderItem={(entry) => {
          if (entry.type === 'tool-call') return <p>{entry.tool}</p>;
          if (entry.type === 'command-execution') return <p>{entry.command}</p>;
          if (entry.type === 'plan') return <p>{entry.title}</p>;
          return null;
        }}
        inspected={false}
        onInspect={() => {}}
        showActivity={false}
      />
    </MemoryRouter>
  );
}

describe('timeline evidence, policy, and plan segments', () => {
  it('opens audit records for this run on the filtered usage page', () => {
    render(
      <MemoryRouter>
        <Inspector turnId={turnId} items={[]} onClose={() => {}} />
      </MemoryRouter>
    );
    expect(screen.getByRole('link', { name: 'Audit records for this run' })).toHaveAttribute(
      'href',
      `/workspace/usage?turnId=${turnId}`
    );
  });

  it('shows waiting, denied, and allowed badges only for full tool calls', () => {
    renderRun('work', 'complete');
    expect(screen.queryByRole('link', { name: 'Waiting for approval' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Denied by policy' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Allowed by policy' })).not.toBeInTheDocument();

    cleanup();
    renderRun('full', 'complete');
    const waiting = screen.getByRole('link', { name: 'Waiting for approval' });
    expect(waiting).toHaveAttribute(
      'href',
      '/workspace/usage?capabilityCallId=call-waiting&decision=decision-waiting'
    );
    expect(waiting.textContent).not.toMatch(/denied/i);
    expect(screen.getByRole('link', { name: 'Denied by policy' })).toHaveAttribute(
      'href',
      '/workspace/usage?capabilityCallId=call-denied&decision=decision-denied'
    );
    expect(screen.getByRole('link', { name: 'Allowed by policy' })).toHaveAttribute(
      'href',
      '/workspace/usage?capabilityCallId=call-allowed&decision=decision-allowed'
    );
    expect(screen.getByText('preview')).toBeInTheDocument();
    expect(screen.getByText('npm test')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /policy|approval/ })).toHaveLength(3);
    expect(screen.queryByText('do-not-show-connection')).not.toBeInTheDocument();
  });

  it('shows recorded segment counts and says when coverage is partial', () => {
    renderRun('full', 'partial');
    const list = screen.getByRole('list', { name: 'Plan progress' });
    expect(within(list).getByText('Fix formatter · 18 steps')).toBeInTheDocument();
    expect(within(list).getByText('Write notes · 4 steps')).toBeInTheDocument();
    expect(list.textContent).not.toMatch(/min/);
    expect(screen.getByText('These counts are incomplete.')).toBeInTheDocument();

    cleanup();
    renderRun('full', 'complete');
    expect(screen.getByRole('list', { name: 'Plan progress' })).toBeInTheDocument();
    expect(screen.queryByText('These counts are incomplete.')).not.toBeInTheDocument();
  });
});
