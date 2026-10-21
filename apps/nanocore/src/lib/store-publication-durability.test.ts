// openkit-test-platform: posix
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { feedbackFilePath } from '../runtime/feedback.js';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { openWorkspaceDb } from '../storage/db.js';
import { createTestStore } from '../test-support/store.js';
import { FsStore } from './store.js';

const actor = { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' } as const;
const sessionId = 'as_00000000-0000-7000-8000-000000000001';
const roots: string[] = [];
afterEach(async () => {
  await shutdownControlStoreWorkerClient();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Creates canonical records with the real Store and file writers. */
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'store-publication-'));
  roots.push(root);
  const store = createTestStore({ dataRoot: root });
  const workspace = await store.createWorkspace('Publication');
  const thread = await store.createThread(workspace.id, 'Before');
  const turn = await store.createTurn(workspace.id, thread.id, 'Before request', actor);
  const sessionInput = {
    id: sessionId,
    agentId: 'agent_codex_host',
    workspaceId: workspace.id,
    threadId: thread.id,
    status: 'initializing' as const,
    message: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  };
  const threadRoot = join(root, 'workspaces', workspace.id, 'threads', thread.id);
  return {
    root,
    store,
    workspace,
    thread: store.getThread(workspace.id, thread.id),
    turn,
    sessionInput,
    threadRoot,
  };
}

/** Reads the exact canonical metadata independently of Store projections. */
function record(
  f: Awaited<ReturnType<typeof fixture>>,
  table: 'control_threads' | 'control_agent_sessions' | 'control_turns',
  id: string
): string {
  const db = openWorkspaceDb(f.root, f.workspace.id);
  try {
    return (
      db.sqlite.prepare(`SELECT record_json FROM ${table} WHERE id=?`).get(id) as {
        record_json: string;
      }
    ).record_json;
  } finally {
    db.sqlite.close();
  }
}

/** Refuses the real native SQL write; Main filesystem mocks cannot fault its commit. */
function refuse(
  f: Awaited<ReturnType<typeof fixture>>,
  table: 'control_threads' | 'control_agent_sessions' | 'control_turns',
  event: 'INSERT' | 'UPDATE'
) {
  const db = openWorkspaceDb(f.root, f.workspace.id);
  try {
    db.sqlite.exec(
      `CREATE TRIGGER refuse_publication BEFORE ${event} ON ${table} BEGIN SELECT RAISE(ABORT, 'injected native publication refusal'); END`
    );
  } finally {
    db.sqlite.close();
  }
}

describe('Store publishes only persisted record candidates', () => {
  it('keeps a refused new Thread and its derived count out of live reads', async () => {
    const f = await fixture();
    const before = f.store.getWorkspace(f.workspace.id);
    const id = 'th_00000000-0000-7000-8000-000000000099';
    refuse(f, 'control_threads', 'INSERT');
    await expect(f.store.createThread(f.workspace.id, 'Refused', id)).rejects.toMatchObject({
      commit: 'not-committed',
    });
    expect.soft(() => f.store.getThread(f.workspace.id, id)).toThrow(/not found/);
    expect.soft(f.store.getWorkspace(f.workspace.id)).toEqual(before);
    const reopened = new FsStore({ dataRoot: f.root });
    expect(() => reopened.getThread(f.workspace.id, id)).toThrow(/not found/);
    expect(reopened.getWorkspace(f.workspace.id).counts).toEqual(before.counts);
  });

  it('keeps the live Thread and canonical bytes unchanged after a refused update', async () => {
    const f = await fixture();
    const before = record(f, 'control_threads', f.thread.id);
    refuse(f, 'control_threads', 'UPDATE');
    await expect(
      f.store.updateThread(f.workspace.id, f.thread.id, { name: 'Refused' })
    ).rejects.toMatchObject({ commit: 'not-committed' });
    expect.soft(f.store.getThread(f.workspace.id, f.thread.id)).toEqual(f.thread);
    expect(record(f, 'control_threads', f.thread.id)).toBe(before);
    expect(new FsStore({ dataRoot: f.root }).getThread(f.workspace.id, f.thread.id)).toEqual(
      f.thread
    );
  });

  it('keeps a refused new AgentSession out of live and reopened reads', async () => {
    const f = await fixture();
    refuse(f, 'control_agent_sessions', 'INSERT');
    await expect(f.store.createAgentSession(f.sessionInput)).rejects.toMatchObject({
      commit: 'not-committed',
    });
    expect.soft(() => f.store.getAgentSession(sessionId)).toThrow(/not found/);
    expect.soft(f.store.listThreadAgentSessions(f.workspace.id, f.thread.id)).toEqual([]);
    expect(() => new FsStore({ dataRoot: f.root }).getAgentSession(sessionId)).toThrow(/not found/);
  });

  it('keeps the live AgentSession and canonical bytes unchanged after a refused update', async () => {
    const f = await fixture();
    const session = await f.store.createAgentSession(f.sessionInput);
    const before = record(f, 'control_agent_sessions', session.id);
    refuse(f, 'control_agent_sessions', 'UPDATE');
    await expect(
      f.store.updateAgentSession(session.id, { status: 'closed', message: 'Refused' })
    ).rejects.toMatchObject({ commit: 'not-committed' });
    expect.soft(f.store.getAgentSession(session.id)).toEqual(session);
    expect(record(f, 'control_agent_sessions', session.id)).toBe(before);
    expect(new FsStore({ dataRoot: f.root }).getAgentSession(session.id)).toEqual(session);
  });

  it('keeps a refused terminal Turn out of live reads, feedback and terminal notifications', async () => {
    const f = await fixture();
    const before = record(f, 'control_turns', f.turn.id);
    const onTerminal = vi.fn();
    // Native terminal facts share the deciding transaction; no pre-commit Main hook may publish them.
    const onTerminalFact = vi.fn();
    f.store.setTurnAdmissionHooks({ onTerminal, onTerminalFact });
    refuse(f, 'control_turns', 'UPDATE');
    await expect(
      f.store.completeTurn(f.turn.id, {
        status: 'completed',
        completedAt: '2026-10-19T00:00:00.000Z',
      })
    ).rejects.toMatchObject({ commit: 'not-committed' });
    expect.soft(f.store.getTurnById(f.turn.id)).toEqual(f.turn);
    expect(onTerminal).not.toHaveBeenCalled();
    expect(onTerminalFact).not.toHaveBeenCalled();
    expect(f.store.getTurnEvents(f.turn.id)).toEqual([]);
    expect(existsSync(feedbackFilePath(f.store, f.turn))).toBe(false);
    expect(record(f, 'control_turns', f.turn.id)).toBe(before);
    expect(new FsStore({ dataRoot: f.root }).getTurnById(f.turn.id)).toEqual(f.turn);
  });

  it('persists successful candidate values and exposes them after reopen', async () => {
    const f = await fixture();
    const created = await f.store.createThread(f.workspace.id, 'Created');
    expect(new FsStore({ dataRoot: f.root }).getThread(f.workspace.id, created.id)).toEqual(
      created
    );
    expect(new FsStore({ dataRoot: f.root }).getWorkspace(f.workspace.id).counts.threadCount).toBe(
      2
    );
    const updated = await f.store.updateThread(f.workspace.id, f.thread.id, { name: 'Committed' });
    expect(new FsStore({ dataRoot: f.root }).getThread(f.workspace.id, f.thread.id)).toEqual(
      updated
    );
    const session = await f.store.createAgentSession(f.sessionInput);
    expect(new FsStore({ dataRoot: f.root }).getAgentSession(session.id)).toEqual(session);
    const updatedSession = await f.store.updateAgentSession(session.id, {
      status: 'closed',
      message: 'Committed',
    });
    expect(new FsStore({ dataRoot: f.root }).getAgentSession(session.id)).toEqual(updatedSession);
    const publications: string[] = [];
    f.store.setTurnAdmissionHooks({
      onTerminalFact: () => {
        publications.push('fact');
      },
      onTerminal: (turn) => {
        expect(JSON.parse(record(f, 'control_turns', turn.id)).status).toBe('completed');
        expect(existsSync(feedbackFilePath(f.store, turn))).toBe(true);
        publications.push('terminal');
      },
    });
    const completed = await f.store.completeTurn(f.turn.id, {
      status: 'completed',
      completedAt: '2026-10-19T00:00:00.000Z',
    });
    const reopened = new FsStore({ dataRoot: f.root });
    expect(reopened.getThread(f.workspace.id, created.id)).toEqual(created);
    expect(reopened.getThread(f.workspace.id, f.thread.id)).toEqual(updated);
    expect(reopened.getWorkspace(f.workspace.id).counts.threadCount).toBe(2);
    expect(reopened.getAgentSession(session.id)).toEqual(updatedSession);
    expect(reopened.getTurnById(f.turn.id)).toEqual(completed);
    expect(publications).toEqual(['terminal']);
  });
});
