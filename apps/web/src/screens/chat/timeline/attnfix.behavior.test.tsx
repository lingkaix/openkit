import { type HumanAttentionRow, ListHumanAttentionResponseSchema } from '@openkit/app-api-schemas';
import { ApiCallError } from '@openkit/core-client';
import { ProductTurnSchema } from '@openkit/protocol';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider, toastQueue } from '../../../primitives';
import { useAccountMutation } from '../../account/session';
import { useWorkspaceStore } from '../../workspace-store';
import { client, Harness, queryOwner, THREAD, TURN, USER, WS } from './__fixtures__/tw57fix';
import { BackLink } from './BackLink';
import { TimelineToasts } from './TimelineToasts';
import { getToastSession, resetToastPolicy } from './toast-policy';

const RUN_START = '2026-11-08T10:02:00.000Z';
const OTHER_TIME = '2026-11-08T11:11:00.000Z';
const NEXT_TURN = 'tu_00000000-0000-7000-8000-000000000006';
const NEXT_ITEM = 'it_00000000-0000-7000-8000-000000000007';
const QUESTION_ID = '00000000-0000-7000-8000-000000000008';
const caches: ReturnType<typeof queryOwner>[] = [];

beforeEach(() => {
  resetToastPolicy();
  toastQueue.clear();
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('min-width: 800'),
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => true,
  }));
});

afterEach(() => {
  cleanup();
  for (const cache of caches.splice(0)) cache.clear();
  resetToastPolicy();
  toastQueue.clear();
  useWorkspaceStore.setState({ currentWorkspaceId: null, selectionUserKey: null });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** A real query owner shared across account and read hooks, not a cached-result double. */
function cacheOwner() {
  const cache = queryOwner();
  caches.push(cache);
  return cache;
}

/** Complete outward Turn metadata at the external read boundary. */
function recordedTurn() {
  return ProductTurnSchema.parse({
    id: TURN,
    owner: { kind: 'workspace', workspaceId: WS },
    threadId: THREAD,
    triggerActor: { kind: 'user', id: USER },
    status: 'completed',
    items: [],
    error: null,
    configVersion: null,
    startedAt: RUN_START,
    completedAt: OTHER_TIME,
    durationMs: null,
  });
}

function Clock() {
  return (
    <BackLink
      workspaceId={WS}
      threadId={THREAD}
      turnId={TURN}
      recordedAt={OTHER_TIME}
      audience={{ status: 'open', name: 'Launch notes', activity: 'chat' }}
    />
  );
}

/** The real account mutation owns cancellation and account-generation changes. */
function ChangeAccount() {
  const mutation = useAccountMutation();
  return (
    <>
      <button
        type="button"
        onClick={() => mutation.mutate({ operation: 'signIn', email: '', password: '', name: '' })}
      >
        Change account
      </button>
      {mutation.isSuccess ? <p>Account changed</p> : null}
    </>
  );
}

/** These are schema-checked read projections, never retained records or receipts. */
function attentionRow(value: unknown): HumanAttentionRow {
  return ListHumanAttentionResponseSchema.parse({ items: [value] }).items[0]!;
}

function runOrigin(startedAt = RUN_START) {
  return {
    startedBy: { kind: 'user' as const, id: USER },
    startedAt,
    viewerStartedRun: true,
    viewerCausedHandoff: false,
  };
}

/** Matches the existing unresolved-attempt attention source, not a fabricated protocol failure Item. */
function unknownOutcome() {
  return attentionRow({
    id: 'execution-attempt:00000000-0000-7000-8000-000000000009',
    kind: 'blocked_turn',
    workspaceId: WS,
    threadId: THREAD,
    turnId: TURN,
    title: 'Worker attempt needs recovery review',
    summary: 'Execution attempt is closing with unknown acceptance.',
    severity: 'risk',
    createdAt: OTHER_TIME,
    blocking: false,
    origin: runOrigin(),
    source: {
      type: 'execution_attempt',
      attemptId: 'attempt_00000000-0000-7000-8000-000000000009',
      backendId: 'nanohost',
      phase: 'closing',
      disposition: 'unknown',
      workspaceId: WS,
      threadId: THREAD,
      turnId: TURN,
    },
    actions: [{ kind: 'open_thread', label: 'Open', method: 'GET' }],
  });
}

function laterDecision() {
  return attentionRow({
    id: `question:${QUESTION_ID}`,
    kind: 'question',
    workspaceId: WS,
    threadId: THREAD,
    turnId: NEXT_TURN,
    itemId: NEXT_ITEM,
    title: 'Answer the deployment question',
    summary: 'Answer the question on its pending request.',
    severity: 'needs_input',
    createdAt: OTHER_TIME,
    blocking: true,
    origin: runOrigin('2026-11-08T10:03:00.000Z'),
    source: {
      type: 'protocol_item',
      itemType: 'user-input-request',
      workspaceId: WS,
      threadId: THREAD,
      turnId: NEXT_TURN,
      itemId: NEXT_ITEM,
    },
    actions: [{ kind: 'answer_question', label: 'Answer', method: 'POST' }],
  });
}

/** The genuine query, audience, policy and rendered queue consume only controlled HTTP projections. */
async function notifications() {
  const cache = cacheOwner();
  let rows: HumanAttentionRow[] = [];
  const api = client({
    'workspace.list': async () => ({
      items: [
        {
          membershipStatus: 'active',
          accessCause: 'membership',
          workspace: { id: WS, name: 'Shared workspace', kind: 'code' },
          isOwner: true,
          membershipRevision: 1,
          ownerUserId: USER,
          registryRevision: 1,
        },
      ],
    }),
    'attention.list': async () => ({ items: rows }),
    'conversation.navigation': async () => ({
      items: [{ activity: 'chat', thread: { id: THREAD, name: 'Launch notes' } }],
    }),
  });
  useWorkspaceStore.setState({ currentWorkspaceId: WS, selectionUserKey: null });
  render(
    <Harness api={api} cache={cache} entry="/artifacts">
      <ToastProvider />
      <TimelineToasts />
    </Harness>
  );
  // Read the exported policy owner only to synchronize its documented initial baseline.
  await waitFor(() => expect(getToastSession().priming).toBe(false));
  return {
    async publish(next: HumanAttentionRow[]) {
      rows = next;
      await act(async () => {
        await cache.invalidateQueries({ queryKey: ['attention', WS] });
      });
      // Processing, not a copy of the policy result, is the setup precondition.
      await waitFor(() => {
        for (const row of next) expect(getToastSession().seen.has(row.id)).toBe(true);
      });
    },
  };
}

describe('Independent ATTNFIX admission and notification oracles', () => {
  it('W1 hides a previously read run clock when its exact turn.read becomes denied', async () => {
    const cache = cacheOwner();
    let denied = false;
    const read = vi.fn(async () => {
      if (denied)
        throw new ApiCallError(403, 'Source is no longer admitted.', {
          code: 'workspace_access_denied',
        });
      return recordedTurn();
    });
    render(
      <Harness api={client({ 'turn.read': read })} cache={cache}>
        <Clock />
      </Harness>
    );
    expect(await screen.findByRole('link', { name: /run at/ })).toBeVisible();
    expect(read).toHaveBeenCalledWith({ workspaceId: WS, threadId: THREAD, turnId: TURN });
    denied = true;
    await act(async () => {
      await cache.refetchQueries({ type: 'active' });
    });
    expect(read).toHaveBeenCalledTimes(2);
    // Conversation Timeline: a failed current source admission cannot retain its old disclosure.
    expect(
      screen.queryAllByText(/run at/),
      'Denied turn.read must remove its previously admitted clock'
    ).toHaveLength(0);
  });

  it('W2 a blocking decision after an unknown outcome is counted once and does not expire', async () => {
    const feed = await notifications();
    const outcome = unknownOutcome();
    await feed.publish([outcome]);
    expect(
      (await screen.findAllByText(/Worker attempt needs recovery review · Launch notes/)).length
    ).toBeGreaterThan(0);
    const decision = laterDecision();
    // The old recovery row can disappear after recovery; its eight-second toast is still visible.
    await feed.publish([decision]);
    await waitFor(() => {
      expect(getToastSession().visible.some((toast) => toast.objectIds.includes(decision.id))).toBe(
        true
      );
    });
    // Conversation Timeline / Notifications: an earlier outcome is not another decision.
    expect
      .soft(
        screen.queryAllByText(/2 decisions need you/),
        'One blocking decision must not count the earlier unknown outcome as another decision'
      )
      .toHaveLength(0);
    // P7 gives failure/unknown-outcome toasts eight seconds, but blocking decisions never time out.
    // Use the actual timer and rendered queue, not lifetimeMs or a replacement scheduler.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 8_200));
    });
    expect(
      screen.queryAllByRole('alertdialog').length,
      'The blocking decision must remain visible beyond the earlier outcome timeout'
    ).toBeGreaterThan(0);
  }, 30_000);

  it('W3 an account transition cannot disclose a previous viewer cached run clock', async () => {
    const cache = cacheOwner();
    // The same retained-cache control as the frozen account-isolation oracle: expiry is not admission.
    cache.setDefaultOptions({ queries: { retry: false, staleTime: Infinity } });
    let changed = false;
    const read = vi.fn(async () => {
      if (changed)
        throw new ApiCallError(403, 'The new viewer cannot read this source.', {
          code: 'workspace_access_denied',
        });
      return recordedTurn();
    });
    const api = client({ 'turn.read': read });
    const tree = (show: boolean) => (
      <Harness api={api} cache={cache}>
        <ChangeAccount />
        {show ? <Clock /> : null}
      </Harness>
    );
    const view = render(tree(true));
    expect(await screen.findByRole('link', { name: /run at/ })).toBeVisible();
    view.rerender(tree(false));
    changed = true;
    await userEvent.click(screen.getByRole('button', { name: 'Change account' }));
    await screen.findByText('Account changed');
    view.rerender(tree(true));
    // The real mutation must invalidate every account-owned read, including this new namespace.
    expect(
      screen.queryAllByText(/run at/),
      'A new account must not inherit the previous viewer run-start cache'
    ).toHaveLength(0);
  });

  it('S2 MISSING-FEED a handoff-looking attention row alone is not an admitted handoff event', async () => {
    const feed = await notifications();
    // Deliberate read-boundary fault injection, NOT a producer positive or a retained handoff record.
    // Even true run-origin facts do not create the missing admitted handoff event/notification feed.
    const candidate = attentionRow({
      id: 'budget:handoff-looking',
      kind: 'budget',
      workspaceId: WS,
      threadId: THREAD,
      turnId: TURN,
      title: 'Hand off the deployment work',
      summary: 'A row label is not a published handoff event.',
      severity: 'info',
      createdAt: OTHER_TIME,
      blocking: false,
      origin: { ...runOrigin(), viewerCausedHandoff: true },
      source: {
        type: 'protocol_item',
        itemType: 'agent-handoff',
        workspaceId: WS,
        threadId: THREAD,
        turnId: TURN,
        itemId: NEXT_ITEM,
      },
      actions: [{ kind: 'open_thread', label: 'Open', method: 'GET' }],
    });
    await feed.publish([candidate]);
    expect(
      screen.queryAllByRole('alertdialog'),
      'An attention row alone must not manufacture the missing handoff notification'
    ).toHaveLength(0);
  });
});
