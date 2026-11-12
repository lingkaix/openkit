import { GoalCompletionCandidateSchema, GoalViewSchema } from '@openkit/app-api-schemas';
import { ApiCallError } from '@openkit/core-client';
import { act, cleanup, isInaccessible, render, screen, within } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DisconnectedBanner } from '../../../app/DisconnectedBanner';
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

// Workspace selection is outside the source-freshness and captured-effect boundaries.
vi.mock('../data', async (load) => ({
  ...(await load<typeof import('../data')>()),
  useCurrentWorkspaceId: (id: string) => id,
}));
const caches: ReturnType<typeof queryOwner>[] = [];
const HISTORY = 'Progress admitted before the source outage';
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
  for (const cache of caches.splice(0)) cache.clear();
  vi.unstubAllGlobals();
});

/** Read transports fail only after the real mount has admitted its initial history. */
function historyMount(initialFailure: unknown = null) {
  const cache = queryOwner();
  caches.push(cache);
  const failures = { history: initialFailure, probe: null as unknown };
  const api = client(
    {
      'thread.timeline': async () => {
        if (failures.history) throw failures.history;
        return page(HISTORY);
      },
    },
    {
      meta: async () => {
        if (failures.probe) throw failures.probe;
        return {};
      },
    }
  );
  const view = render(
    <Harness api={api} cache={cache}>
      <DisconnectedBanner />
      <div data-testid="history-surface">
        <ThreadStream workspaceId={WS} threadId={THREAD} mode="task" />
      </div>
    </Harness>
  );
  return {
    view,
    surface: within(view.getByTestId('history-surface')),
    async fail(error: unknown, probe = false) {
      failures.history = error;
      failures.probe = probe ? error : null;
      await act(async () => {
        await cache.refetchQueries({ type: 'active' });
      });
    },
    close() {
      view.unmount();
      cache.clear();
    },
  };
}

/** Visible text or an accessible detail link can identify an exact captured reference. */
function discloses(decision: HTMLElement, value: string): boolean {
  const normalize = (text: string) => text.toLowerCase().replace(/\s+/g, '');
  const text: string[] = [];
  const walker = document.createTreeWalker(decision, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.parentElement && !isInaccessible(node.parentElement))
      text.push(node.textContent ?? '');
  }
  if (normalize(text.join('')).includes(normalize(value))) return true;
  return within(decision)
    .queryAllByRole('link')
    .some((link) => {
      const address = link.getAttribute('href') ?? '';
      let decoded = address;
      try {
        decoded = decodeURIComponent(address);
      } catch {
        // A malformed encoded address is not an additional source of identity.
      }
      return normalize(`${decoded} ${link.getAttribute('aria-label') ?? ''}`).includes(
        normalize(value)
      );
    });
}

describe('TW57FIX3 source retention and captured references', () => {
  // Conversation Timeline / Degraded Conditions and the coordinator's recovery ruling:
  // admission controls retention; the narrower busy label must not define it.
  it('e retains admitted history for recoverable failures without retaining denials or inventing busy', async () => {
    const recoverable = [
      { label: '502', error: new ApiCallError(502, 'Bad gateway'), busy: false },
      { label: '503', error: new ApiCallError(503, 'Service unavailable'), busy: true },
      { label: '504', error: new ApiCallError(504, 'Gateway timeout'), busy: true },
      { label: '429', error: new ApiCallError(429, 'Rate limited'), busy: true },
      { label: '500', error: new ApiCallError(500, 'Source unavailable'), busy: false },
      { label: 'network', error: new TypeError('Network request failed'), busy: false },
    ];
    for (const failure of recoverable) {
      const mounted = historyMount();
      try {
        await mounted.surface.findByText(HISTORY);
        // The same outage reaches the real connection banner as well as the history read.
        await mounted.fail(failure.error, true);
        expect
          .soft(
            mounted.surface.queryByText(HISTORY),
            `${failure.label}: a recoverable refresh must keep this mount's admitted history`
          )
          .not.toBeNull();
        expect
          .soft(
            mounted.surface.queryAllByText(/Updated|stale|last (loaded|load)/i),
            `${failure.label}: retained history must explain its stale or last-loaded state`
          )
          .not.toHaveLength(0);
        if (failure.busy) {
          expect(await screen.findByText(/OpenKit is busy/)).toBeVisible();
        } else {
          // Await the actual connection repaint before checking the negative posture.
          expect(await screen.findByText('Offline')).toBeVisible();
          expect
            .soft(
              screen.queryByText(/OpenKit is busy/),
              `${failure.label}: retention is not a busy claim`
            )
            .toBeNull();
        }
      } finally {
        mounted.close();
      }
    }
    for (const status of [401, 403, 404]) {
      const mounted = historyMount();
      try {
        await mounted.surface.findByText(HISTORY);
        await mounted.fail(new ApiCallError(status, 'Source not admitted'));
        expect
          .soft(
            mounted.surface.queryByText(HISTORY),
            `${status}: a denied or unavailable source must hide previously admitted history`
          )
          .toBeNull();
      } finally {
        mounted.close();
      }
    }
    // No previous admission: preserve the existing initial-read error assertion.
    const firstRead = historyMount(new ApiCallError(500, 'Initial source read failed'));
    try {
      expect(await firstRead.surface.findByText("Couldn't load this thread.")).toBeVisible();
      expect(firstRead.surface.getByRole('button', { name: 'Try again' })).toBeEnabled();
      expect(firstRead.surface.queryByText(HISTORY)).not.toBeInTheDocument();
    } finally {
      firstRead.close();
    }
  }, 30_000);

  // Conversation Timeline / Exact effect gate and Goal / Completion: a digest
  // alone cannot identify the evidence owner and exact source being accepted.
  it('g identifies every captured evidence kind, source and digest before enabling acceptance, keeping Decline available', async () => {
    const candidate = GoalCompletionCandidateSchema.parse({
      intentRevision: 0,
      intent: 'Finish the release safely',
      planVersionId: 'captured-plan',
      evidence: [
        { kind: 'item', id: ITEM, digest: `sha256:${'ab'.repeat(32)}` },
        { kind: 'artifact', id: 'captured-release-artifact', digest: `sha256:${'cd'.repeat(32)}` },
      ],
      unresolvedWork: ['An external result still needs confirmation'],
      summary: 'The release is ready for a human decision',
    });
    const response = GoalViewSchema.parse({
      goal: {
        goalId: 'goal-with-captured-references',
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
          requestId: 'completion-with-captured-references',
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
    caches.push(cache);
    const api = client({
      'goal.read': async () => response,
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
    if (!decision) throw new Error('Acceptance must belong to its captured decision');
    expect(within(decision).getByRole('button', { name: 'Decline' })).toBeEnabled();
    if ((grant as HTMLButtonElement).disabled) {
      expect(grant).toBeDisabled();
    } else {
      for (const reference of candidate.evidence) {
        for (const field of ['kind', 'id', 'digest'] as const) {
          expect
            .soft(
              discloses(decision, reference[field]),
              `Enabled acceptance must disclose captured evidence ${field}: ${reference[field]}`
            )
            .toBe(true);
        }
      }
    }
  });
});
