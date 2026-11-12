import { describe, expect, it } from 'vitest';
import {
  classifyAttentionEvent,
  dismissToast,
  emptyToastSession,
  type PolicyRow,
  stepToastPolicy,
} from './toast-policy';

function decision(id: string, blocking = true, threadId = 'th_launch'): PolicyRow {
  return {
    id,
    objectId: id,
    blocking,
    threadId,
    threadName: 'Launch notes',
    audience: 'open',
    event: 'decision',
    title: 'Review the draft',
    ageLabel: 'now',
    href: `/tasks/ws/${threadId}?turn=tu_1&turnId=tu_1`,
  };
}

function input(
  rows: PolicyRow[],
  extra: Partial<Parameters<typeof stepToastPolicy>[1]> = {}
): Parameters<typeof stepToastPolicy>[1] {
  return {
    now: 1_000,
    phone: false,
    focused: true,
    sheetOrDialogOpen: false,
    viewingThreadId: null,
    rows,
    ...extra,
  };
}

function primed(rows: PolicyRow[] = []) {
  return stepToastPolicy(emptyToastSession(), input(rows, { now: 0 })).session;
}

describe('toast policy', () => {
  it('merges five decisions in one thread into one toast', () => {
    const rows = ['a', 'b', 'c', 'd', 'e'].map((id) => decision(id));
    const step = stepToastPolicy(primed(), input(rows));
    expect(step.visible).toHaveLength(1);
    expect(step.visible[0]?.message).toBe('5 decisions need you in Launch notes');
    expect(step.visible[0]?.actionLabel).toBe('View');
    expect(JSON.stringify(step.visible)).not.toContain('Deny');
    expect(step.visible[0]).not.toHaveProperty('approve');
  });

  it('does not toast another member failing a shared workspace when the viewer is uninvolved', () => {
    expect(
      classifyAttentionEvent(
        {
          kind: 'blocked_turn',
          blocking: true,
          actions: [],
          source: { type: 'execution_attempt', disposition: 'unknown' },
        },
        { viewerWaitsOn: false }
      )
    ).toBe('ignore');
    const row: PolicyRow = {
      ...decision('run_1'),
      event: 'failure',
      viewerWaitsOn: false,
      title: 'The run failed',
    };
    const step = stepToastPolicy(primed(), input([row]));
    expect(step.visible).toEqual([]);
  });

  it('toasts a request that becomes blocking once', () => {
    const quiet = decision('ap_1', false);
    const blocking = decision('ap_1', true);
    const seen = stepToastPolicy(primed(), input([quiet])).session;
    const first = stepToastPolicy(seen, input([blocking], { now: 2_000 }));
    expect(first.visible).toHaveLength(1);
    const again = stepToastPolicy(first.session, input([blocking], { now: 3_000 }));
    expect(again.visible).toHaveLength(1);
    expect(again.visible[0]?.id).toBe(first.visible[0]?.id);
  });

  it('leaves the rows in place when a toast is dismissed', () => {
    const rows = [decision('ap_1')];
    const shown = stepToastPolicy(primed(), input(rows));
    const toastId = shown.visible[0]?.id ?? '';
    const dismissed = dismissToast(shown.session, toastId);
    const next = stepToastPolicy(dismissed, input(rows, { now: 5_000 }));
    expect(next.visible.find((toast) => toast.id === toastId)).toBeUndefined();
    expect(next.retainedRowIds).toEqual(['ap_1']);
    expect(rows.map((row) => row.id)).toEqual(['ap_1']);
  });

  it('shows nothing in an unfocused tab, then shows the toast after focus rechecks it', () => {
    const hidden = stepToastPolicy(primed(), input([decision('ap_1')], { focused: false }));
    expect(hidden.visible).toEqual([]);
    expect(hidden.session.queued).toHaveLength(1);
    const gone = stepToastPolicy(hidden.session, input([], { focused: true, now: 2_000 }));
    expect(gone.visible).toEqual([]);
    const held = stepToastPolicy(primed(), input([decision('ap_2')], { focused: false }));
    const shown = stepToastPolicy(held.session, input([decision('ap_2')], { now: 2_000 }));
    expect(shown.visible).toHaveLength(1);
  });

  it('queues while a sheet is open and rechecks before showing', () => {
    const waiting = stepToastPolicy(
      primed(),
      input([decision('ap_1')], { sheetOrDialogOpen: true })
    );
    expect(waiting.visible).toEqual([]);
    expect(waiting.session.queued).toHaveLength(1);
    const stale = stepToastPolicy(waiting.session, input([], { now: 2_000 }));
    expect(stale.visible).toEqual([]);
    const open = stepToastPolicy(primed(), input([decision('ap_3')], { sheetOrDialogOpen: true }));
    const released = decision('ap_3', false);
    const dropped = stepToastPolicy(open.session, input([released], { now: 2_000 }));
    expect(dropped.visible).toEqual([]);
    const kept = stepToastPolicy(primed(), input([decision('ap_4')], { sheetOrDialogOpen: true }));
    const shown = stepToastPolicy(kept.session, input([decision('ap_4')], { now: 2_000 }));
    expect(shown.visible).toHaveLength(1);
  });

  it('collapses past the desktop cap and uses one slot on a phone', () => {
    const rows = ['t1', 't2', 't3', 't4'].map((threadId) => decision(threadId, true, threadId));
    const desktop = stepToastPolicy(primed(), input(rows));
    expect(desktop.visible).toHaveLength(3);
    expect(desktop.visible[2]?.message).toBe('+2 more · Open Action Center');
    expect(desktop.visible[2]?.href).toBe('/attention');
    const again = stepToastPolicy(desktop.session, input(rows, { now: 2_000 }));
    expect(again.visible.map((toast) => toast.message)).toEqual(
      desktop.visible.map((toast) => toast.message)
    );
    const phone = stepToastPolicy(primed(), input(rows, { phone: true }));
    expect(phone.visible).toHaveLength(1);
    expect(phone.visible[0]?.message).toBe('+4 more · Open Action Center');
  });

  it('does not toast the thread being viewed', () => {
    const step = stepToastPolicy(
      primed(),
      input([decision('ap_1')], { viewingThreadId: 'th_launch' })
    );
    expect(step.visible).toEqual([]);
  });

  it('merges a later decision into the thread toast already on screen', () => {
    const first = stepToastPolicy(primed(), input([decision('a')]));
    expect(first.visible).toHaveLength(1);
    expect(first.visible[0]?.objectIds).toEqual(['a']);
    expect(first.visible[0]?.message).not.toContain('2 decisions');
    const second = stepToastPolicy(
      first.session,
      input([decision('a'), decision('b')], { now: 2_000 })
    );
    expect(second.visible).toHaveLength(1);
    expect(second.visible[0]?.objectIds).toEqual(['a', 'b']);
    expect(second.visible[0]?.message).toBe('2 decisions need you in Launch notes');
  });

  it('keeps earlier overflow objects when another thread arrives', () => {
    const rows = ['t1', 't2', 't3', 't4'].map((threadId) => decision(threadId, true, threadId));
    const desktop = stepToastPolicy(primed(), input(rows));
    expect(desktop.visible[2]?.objectIds).toEqual(['t3', 't4']);
    const next = stepToastPolicy(
      desktop.session,
      input([...rows, decision('t5', true, 't5')], { now: 2_000 })
    );
    const overflow = next.visible.find((toast) => toast.message.includes('more'));
    expect(overflow?.objectIds).toEqual(expect.arrayContaining(['t3', 't4', 't5']));
    expect(overflow?.message).toBe('+3 more · Open Action Center');
    expect(next.visible.filter((toast) => !toast.message.includes('more'))).toHaveLength(2);
  });

  it('removes a visible toast when its source becomes denied and leaves the row', () => {
    const shown = stepToastPolicy(primed(), input([decision('ap_1')]));
    expect(shown.visible).toHaveLength(1);
    const denied = { ...decision('ap_1'), audience: 'denied' as const };
    const next = stepToastPolicy(shown.session, input([denied], { now: 2_000 }));
    expect(next.visible).toEqual([]);
    expect(next.retainedRowIds).toEqual(['ap_1']);
  });
});
