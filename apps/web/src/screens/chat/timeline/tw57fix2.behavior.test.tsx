import { GoalCompletionCandidateSchema, GoalViewSchema } from '@openkit/app-api-schemas';
import { ApiCallError } from '@openkit/core-client';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GoalScreen } from '../../goal/GoalScreen';
import { ThreadStream } from '../ThreadStream';
import {
  AT,
  client,
  Harness,
  ITEM,
  page,
  queryOwner,
  THREAD,
  USER,
  WS,
} from './__fixtures__/tw57fix';

// Workspace selection is outside these read/freshness and effect-disclosure checks.
vi.mock('../data', async (load) => ({
  ...(await load<typeof import('../data')>()),
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

describe('TW57FIX2 independent behavior regressions', () => {
  // Conversation Timeline / Degraded Conditions: a recoverable non-denial
  // refresh failure cannot erase the history admitted on this mount.
  it('e retains admitted history and a stale explanation after 504, but hides it after denial', async () => {
    const cache = queryOwner();
    owners.push(cache);
    let status: number | null = null;
    const api = client({
      'thread.timeline': async () => {
        if (status) throw new ApiCallError(status, status === 504 ? 'Gateway timeout' : 'Denied');
        return page('History admitted before the gateway timeout');
      },
    });
    render(
      <Harness api={api} cache={cache}>
        <ThreadStream workspaceId={WS} threadId={THREAD} mode="task" />
      </Harness>
    );
    await screen.findByText('History admitted before the gateway timeout');
    status = 504;
    await act(async () => {
      await cache.refetchQueries({ queryKey: ['thread-timeline', WS, THREAD], type: 'active' });
    });
    expect
      .soft(
        screen.queryByText('History admitted before the gateway timeout'),
        'A 504 refresh must retain the history admitted on this mount'
      )
      .not.toBeNull();
    expect
      .soft(
        screen.queryAllByText(/Updated|stale|last (loaded|load)/i),
        'Retained history must identify its stale or last-loaded state'
      )
      .not.toHaveLength(0);
    // This control must still run when either 504 assertion fails.
    status = 403;
    await act(async () => {
      await cache.refetchQueries({ queryKey: ['thread-timeline', WS, THREAD], type: 'active' });
    });
    expect(
      screen.queryByText('History admitted before the gateway timeout'),
      'A denied source read must hide the previously admitted history'
    ).not.toBeInTheDocument();
  });

  // Conversation Timeline / Exact effect gate and Goal / Completion:
  // evidence belongs to the captured effect, not merely its summary.
  it('g discloses captured completion evidence or disables acceptance, and always keeps Decline available', async () => {
    const candidate = GoalCompletionCandidateSchema.parse({
      intentRevision: 0,
      intent: 'Finish the release safely',
      planVersionId: 'captured-plan',
      evidence: [{ kind: 'item', id: ITEM, digest: `sha256:${'ab'.repeat(32)}` }],
      unresolvedWork: ['An external result still needs confirmation'],
      summary: 'The release is ready for a human decision',
    });
    const view = GoalViewSchema.parse({
      goal: {
        goalId: 'goal-with-captured-evidence',
        workspaceId: WS,
        threadId: THREAD,
        responsibleUserId: USER,
        responsibleActorContext: { kind: 'local', userId: USER },
        intent: candidate.intent,
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
          requestId: 'completion-with-captured-evidence',
          operation: 'goal.completion.accept',
          state: 'pending',
          resolution: null,
          reason: null,
          decidingActorId: null,
          claim: 'unclaimed',
          disposition: null,
          exactIntent: { candidate },
        },
      ],
    });
    const cache = queryOwner();
    owners.push(cache);
    const api = client({
      'goal.read': async () => view,
      'thread.timeline': async () => page('Coordinator progress'),
    });
    render(
      <Harness api={api} cache={cache} entry={`/goals/${WS}/${THREAD}`}>
        <Routes>
          <Route path="/goals/:workspaceId/:threadId" element={<GoalScreen />} />
        </Routes>
      </Harness>
    );
    const grant = await screen.findByRole('button', { name: 'Accept completion' });
    const decision = grant.closest('article');
    if (!decision) throw new Error('The completion action must belong to its decision');
    expect(within(decision).getByRole('button', { name: 'Decline' })).toBeEnabled();
    const evidence = within(decision).queryByText(candidate.evidence[0]!.digest, { exact: false });
    // Both owner-permitted repairs are valid: disclose the captured effect in
    // full, or keep its grant disabled. Missing evidence is never a green escape.
    if ((grant as HTMLButtonElement).disabled) {
      expect(grant).toBeDisabled();
    } else {
      expect(
        evidence,
        'Enabled completion acceptance must disclose its captured evidence'
      ).not.toBeNull();
      expect(evidence).toBeVisible();
    }
  });
});
