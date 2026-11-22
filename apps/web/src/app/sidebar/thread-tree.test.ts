import { describe, expect, it } from 'vitest';
import {
  type ConversationRow,
  filterThreadRows,
  nestThreadRows,
  threadIndicator,
  threadRowDescription,
} from './thread-tree';

function row(
  id: string,
  activity: ConversationRow['activity'],
  parent?: string,
  extra: Partial<Pick<ConversationRow, 'state' | 'unreadCount'>> = {}
): ConversationRow {
  return {
    thread: {
      id,
      ...(parent ? { parentThreadId: parent } : {}),
      name: id,
      preview: id,
    },
    activity,
    state: 'idle',
    lastActivityAt: '2026-11-19T00:00:00.000Z',
    unreadCount: 0,
    ...extra,
  } as unknown as ConversationRow;
}

const ids = (nodes: ReturnType<typeof nestThreadRows>) =>
  nodes.map((node) => [node.row.thread.id, node.children.map((child) => child.row.thread.id)]);

describe('nestThreadRows', () => {
  it('puts a Task under its visible Goal and keeps the input order', () => {
    const nodes = nestThreadRows([
      row('chat', 'chat'),
      row('task-b', 'task', 'goal'),
      row('goal', 'goal'),
      row('task-a', 'task', 'goal'),
    ]);
    expect(ids(nodes)).toEqual([
      ['chat', []],
      ['goal', ['task-b', 'task-a']],
    ]);
  });

  it('keeps a row whose parent is not listed at the top level', () => {
    expect(ids(nestThreadRows([row('task', 'task', 'missing')]))).toEqual([['task', []]]);
  });

  it('flattens a deeper row under its top ancestor and names the direct parent', () => {
    const nodes = nestThreadRows([
      row('goal', 'goal'),
      row('task', 'task', 'goal'),
      row('handoff', 'chat', 'task'),
    ]);
    expect(ids(nodes)).toEqual([['goal', ['task', 'handoff']]]);
    expect(nodes[0]?.children.map((child) => child.via)).toEqual([null, 'task']);
  });

  it('never hides rows in a parent cycle', () => {
    const nodes = nestThreadRows([row('a', 'task', 'b'), row('b', 'task', 'a')]);
    const shown = nodes.flatMap((node) => [node.row, ...node.children.map((c) => c.row)]);
    expect(shown.map((item) => item.thread.id).toSorted()).toEqual(['a', 'b']);
  });

  it('un-nests Tasks when the filter hides their Goal', () => {
    const rows = [row('goal', 'goal'), row('task', 'task', 'goal')];
    expect(ids(nestThreadRows(filterThreadRows(rows, 'task')))).toEqual([['task', []]]);
    expect(ids(nestThreadRows(filterThreadRows(rows, 'goal')))).toEqual([['goal', []]]);
  });
});

describe('threadIndicator', () => {
  it('shows one indicator by priority: needs you, unread, working', () => {
    expect(threadIndicator({ state: 'needs-you', unreadCount: 3 }, false)).toEqual({
      kind: 'needs-you',
    });
    expect(threadIndicator({ state: 'working', unreadCount: 2 }, false)).toEqual({
      kind: 'unread',
      count: 2,
    });
    expect(threadIndicator({ state: 'working', unreadCount: 0 }, false)).toEqual({
      kind: 'working',
    });
    expect(threadIndicator({ state: 'idle', unreadCount: null }, true)).toEqual({
      kind: 'working',
    });
    expect(threadIndicator({ state: 'idle', unreadCount: null }, false)).toEqual({ kind: 'none' });
  });

  it('describes type, status, unread replies and the via parent', () => {
    const task = row('task', 'task', 'goal', { state: 'working', unreadCount: 1 });
    expect(threadRowDescription(task, false, 'Plan')).toBe(
      'Task · Working · 1 unread reply · via Plan'
    );
    const chat = row('chat', 'chat');
    expect(threadRowDescription(chat, true, null)).toBe('Chat · Waiting for response');
    const waiting = row('waiting', 'chat', undefined, { unreadCount: 2 });
    // The count outranks the spinner, but the description still names the pending reply.
    expect(threadIndicator(waiting, true)).toEqual({ kind: 'unread', count: 2 });
    expect(threadRowDescription(waiting, true, null)).toBe(
      'Chat · Waiting for response · 2 unread replies'
    );
  });

  it('reads an activity this build does not know as Needs repair', () => {
    const odd = row('odd', 'later-kind' as ConversationRow['activity']);
    expect(threadRowDescription(odd, false, null)).toBe('Needs repair · Idle');
  });
});
