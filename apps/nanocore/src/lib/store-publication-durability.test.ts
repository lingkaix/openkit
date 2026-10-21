// openkit-test-platform: posix
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { feedbackFilePath } from '../runtime/feedback.js';
import { createTestStore } from '../test-support/store.js';
import { FsStore } from './store.js';

const fault = vi.hoisted(() => ({ root: '', filename: '', injections: 0 }));

// Refuse the real writer's exclusive staging-file open before canonical publication.
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  return {
    ...fs,
    openSync: ((...args: Parameters<typeof fs.openSync>) => {
      const path = String(args[0]);
      if (fault.root && path.startsWith(fault.root) && path.includes(`/.${fault.filename}.`)) {
        fault.injections++;
        throw new Error('injected durable write refusal');
      }
      return fs.openSync(...args);
    }) as typeof fs.openSync,
  };
});

const actor = { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' } as const;
const sessionId = 'as_00000000-0000-7000-8000-000000000001';
const roots: string[] = [];
afterEach(() => {
  fault.root = '';
  fault.filename = '';
  fault.injections = 0;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Creates canonical records with the real Store and file writers. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'store-publication-'));
  roots.push(root);
  const store = createTestStore({ dataRoot: root });
  const workspace = store.createWorkspace('Publication');
  const thread = store.createThread(workspace.id, 'Before');
  const turn = store.createTurn(workspace.id, thread.id, 'Before request', actor);
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

describe('Store publishes only persisted record candidates', () => {
  it('keeps a refused new Thread and its derived count out of live reads', () => {
    const f = fixture();
    const before = f.store.getWorkspace(f.workspace.id);
    const id = 'th_00000000-0000-7000-8000-000000000099';
    fault.root = f.root;
    fault.filename = 'thread.json';
    expect(() => f.store.createThread(f.workspace.id, 'Refused', id)).toThrow(
      'injected durable write refusal'
    );
    expect(fault.injections).toBe(1);
    expect.soft(() => f.store.getThread(f.workspace.id, id)).toThrow(/not found/);
    expect.soft(f.store.getWorkspace(f.workspace.id)).toEqual(before);
    fault.root = '';
    const reopened = new FsStore({ dataRoot: f.root });
    expect(() => reopened.getThread(f.workspace.id, id)).toThrow(/not found/);
    expect(reopened.getWorkspace(f.workspace.id).counts).toEqual(before.counts);
  });

  it('keeps the live Thread and canonical bytes unchanged after a refused update', () => {
    const f = fixture();
    const path = join(f.threadRoot, 'thread.json');
    const before = readFileSync(path);
    fault.root = f.root;
    fault.filename = 'thread.json';
    expect(() => f.store.updateThread(f.workspace.id, f.thread.id, { name: 'Refused' })).toThrow(
      'injected durable write refusal'
    );
    expect(fault.injections).toBe(1);
    expect.soft(f.store.getThread(f.workspace.id, f.thread.id)).toEqual(f.thread);
    expect(readFileSync(path)).toEqual(before);
    fault.root = '';
    expect(new FsStore({ dataRoot: f.root }).getThread(f.workspace.id, f.thread.id)).toEqual(
      f.thread
    );
  });

  it('keeps a refused new AgentSession out of live and reopened reads', () => {
    const f = fixture();
    fault.root = f.root;
    fault.filename = 'session.json';
    expect(() => f.store.createAgentSession(f.sessionInput)).toThrow(
      'injected durable write refusal'
    );
    expect(fault.injections).toBe(1);
    expect.soft(() => f.store.getAgentSession(sessionId)).toThrow(/not found/);
    expect.soft(f.store.listThreadAgentSessions(f.workspace.id, f.thread.id)).toEqual([]);
    fault.root = '';
    expect(() => new FsStore({ dataRoot: f.root }).getAgentSession(sessionId)).toThrow(/not found/);
  });

  it('keeps the live AgentSession and canonical bytes unchanged after a refused update', () => {
    const f = fixture();
    const session = f.store.createAgentSession(f.sessionInput);
    const path = join(
      f.root,
      'workspaces',
      f.workspace.id,
      'runtime',
      'agent-sessions',
      session.id,
      'session.json'
    );
    const before = readFileSync(path);
    fault.root = f.root;
    fault.filename = 'session.json';
    expect(() =>
      f.store.updateAgentSession(session.id, { status: 'closed', message: 'Refused' })
    ).toThrow('injected durable write refusal');
    expect(fault.injections).toBe(1);
    expect.soft(f.store.getAgentSession(session.id)).toEqual(session);
    expect(readFileSync(path)).toEqual(before);
    fault.root = '';
    expect(new FsStore({ dataRoot: f.root }).getAgentSession(session.id)).toEqual(session);
  });

  it('keeps a refused terminal Turn out of live reads, feedback and terminal notifications', () => {
    const f = fixture();
    const path = join(f.threadRoot, 'turns', f.turn.id, 'turn.json');
    const before = readFileSync(path);
    const onTerminal = vi.fn();
    // Goal-linked Task terminal SQL facts have their own earlier commit, per S96 Goal.
    const onTerminalFact = vi.fn();
    f.store.setTurnAdmissionHooks({ onTerminal, onTerminalFact });
    fault.root = f.root;
    fault.filename = 'turn.json';
    expect(() =>
      f.store.updateTurn(f.turn.id, {
        status: 'completed',
        completedAt: '2026-10-19T00:00:00.000Z',
      })
    ).toThrow('injected durable write refusal');
    expect(fault.injections).toBe(1);
    expect.soft(f.store.getTurnById(f.turn.id)).toEqual(f.turn);
    expect(onTerminal).not.toHaveBeenCalled();
    expect(onTerminalFact).toHaveBeenCalledOnce();
    expect(existsSync(feedbackFilePath(f.store, f.turn))).toBe(false);
    expect(readFileSync(path)).toEqual(before);
    fault.root = '';
    expect(new FsStore({ dataRoot: f.root }).getTurnById(f.turn.id)).toEqual(f.turn);
  });

  it('persists successful candidate values and exposes them after reopen', () => {
    const f = fixture();
    const created = f.store.createThread(f.workspace.id, 'Created');
    expect(new FsStore({ dataRoot: f.root }).getThread(f.workspace.id, created.id)).toEqual(
      created
    );
    expect(new FsStore({ dataRoot: f.root }).getWorkspace(f.workspace.id).counts.threadCount).toBe(
      2
    );
    const updated = f.store.updateThread(f.workspace.id, f.thread.id, { name: 'Committed' });
    expect(new FsStore({ dataRoot: f.root }).getThread(f.workspace.id, f.thread.id)).toEqual(
      updated
    );
    const session = f.store.createAgentSession(f.sessionInput);
    expect(new FsStore({ dataRoot: f.root }).getAgentSession(session.id)).toEqual(session);
    const updatedSession = f.store.updateAgentSession(session.id, {
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
        const path = join(f.threadRoot, 'turns', turn.id, 'turn.json');
        expect(JSON.parse(readFileSync(path, 'utf8')).status).toBe('completed');
        expect(existsSync(feedbackFilePath(f.store, turn))).toBe(true);
        publications.push('terminal');
      },
    });
    const completed = f.store.updateTurn(f.turn.id, {
      status: 'completed',
      completedAt: '2026-10-19T00:00:00.000Z',
    });
    const reopened = new FsStore({ dataRoot: f.root });
    expect(reopened.getThread(f.workspace.id, created.id)).toEqual(created);
    expect(reopened.getThread(f.workspace.id, f.thread.id)).toEqual(updated);
    expect(reopened.getWorkspace(f.workspace.id).counts.threadCount).toBe(2);
    expect(reopened.getAgentSession(session.id)).toEqual(updatedSession);
    expect(reopened.getTurnById(f.turn.id)).toEqual(completed);
    expect(publications).toEqual(['fact', 'terminal']);
  });
});
