import { GoalCompletionCandidateSchema, GoalViewSchema } from '@openkit/app-api-schemas';
import { cleanup, render, screen, within } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AT,
  client,
  Harness,
  page,
  queryOwner,
  THREAD,
  USER,
  WS,
} from '../chat/timeline/__fixtures__/tw57fix';
import { GoalScreen } from './GoalScreen';

// This test owns Goal effect disclosure, not Workspace selection.
vi.mock('../chat/data', async (load) => ({
  ...(await load<typeof import('../chat/data')>()),
  useCurrentWorkspaceId: (id: string) => id,
}));
const owners: ReturnType<typeof queryOwner>[] = [];
beforeEach(() => {
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
});
afterEach(() => {
  cleanup();
  for (const cache of owners.splice(0)) cache.clear();
  vi.unstubAllGlobals();
});

const candidate = GoalCompletionCandidateSchema.parse({
  intentRevision: 0,
  intent: 'Finish the release safely',
  planVersionId: 'plan-one',
  evidence: [],
  unresolvedWork: ['One external effect is still unconfirmed'],
  summary: 'The release work is ready for a decision',
});

function mount(complete: boolean) {
  const view = GoalViewSchema.parse({
    goal: {
      goalId: 'goal-one',
      workspaceId: WS,
      threadId: THREAD,
      responsibleUserId: USER,
      responsibleActorContext: { kind: 'local', userId: USER },
      intent: 'Finish the release safely',
      intentRevision: 0,
      intentHistory: [],
      activePlanVersionId: null,
      proposedPlanVersionId: null,
      disposition: null,
      changeRevision: 0,
      consideredRevision: 0,
      createdAt: AT,
      updatedAt: AT,
    },
    cards: [],
    versions: [],
    tasks: [],
    requests: [
      {
        requestId: 'completion-one',
        operation: 'goal.completion.accept',
        state: 'pending',
        resolution: null,
        reason: null,
        decidingActorId: null,
        claim: 'unclaimed',
        disposition: null,
        // Fault at the read seam: a summary is not proof of the complete captured effect.
        exactIntent: { candidate: complete ? candidate : { summary: candidate.summary } },
      },
    ],
  });
  const cache = queryOwner();
  owners.push(cache);
  const api = client({
    'goal.read': async () => view,
    'thread.timeline': async () => page('Coordinator note'),
  });
  render(
    <Harness api={api} cache={cache} entry={`/goals/${WS}/${THREAD}`}>
      <Routes>
        <Route path="/goals/:workspaceId/:threadId" element={<GoalScreen />} />
      </Routes>
    </Harness>
  );
}

// Intervention / Exact effect gate and Goal / Completion: a summary cannot stand
// for the captured candidate and its unresolved work. Decline does not need disclosure.
describe('TW57FIX Goal captured-effect gate', () => {
  it('keeps completion acceptance disabled when only a summary is available', async () => {
    mount(false);
    const grant = await screen.findByRole('button', { name: 'Accept completion' });
    expect(grant, 'A summary-only read must not enable completion acceptance').toBeDisabled();
    expect(screen.getByRole('button', { name: 'Decline' })).toBeEnabled();
  });

  it('does not enable acceptance while captured unresolved work is hidden', async () => {
    mount(true);
    const grant = await screen.findByRole('button', { name: 'Accept completion' });
    const decision = grant.closest('article');
    if (!decision) throw new Error('The acceptance control must belong to a decision');
    const capturedWork = within(decision).queryByText(candidate.unresolvedWork[0]!);
    if (!capturedWork) {
      expect(
        grant,
        'Grant must stay off until the captured unresolved work is disclosed'
      ).toBeDisabled();
    }
    expect(screen.getByRole('button', { name: 'Decline' })).toBeEnabled();
  });
});
