// openkit-test-platform: posix
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId } from '@openkit/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { refuseScope } from '../bootstrap/readiness.js';
import { feedbackFilePath } from '../runtime/feedback.js';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { openWorkspaceDb } from '../storage/db.js';
import { createTestStore } from '../test-support/store.js';
import { createThread as createThreadCommand } from '../thread-routes.js';
import { FsStore } from './store.js';

const allocation = vi.hoisted(() => ({ threadId: undefined as string | undefined }));
// Inject one Thread allocator collision; all command facts and other IDs stay owner-produced.
vi.mock('@openkit/protocol', async (load) => {
  const actual = await load<typeof import('@openkit/protocol')>();
  return {
    ...actual,
    allocateEntityId: ((...args: Parameters<typeof actual.allocateEntityId>) =>
      args[0] === 'th' && allocation.threadId
        ? allocation.threadId
        : actual.allocateEntityId(...args)) as typeof actual.allocateEntityId,
  };
});

const transport = vi.hoisted(() => ({
  hold: undefined as { entered: () => void; deliver?: () => void } | undefined,
}));
// Hold one real post-COMMIT reply; preparation, SQL and every other reply stay unchanged.
vi.mock('node:worker_threads', async (load) => {
  const actual = await load<typeof import('node:worker_threads')>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      override emit(event: string | symbol, ...args: unknown[]): boolean {
        const reply = args[0];
        const hold = transport.hold;
        if (
          event === 'message' &&
          hold &&
          !hold.deliver &&
          typeof reply === 'object' &&
          reply !== null &&
          'operation' in reply &&
          reply.operation === 'products' &&
          'status' in reply &&
          reply.status === 'ok'
        ) {
          hold.deliver = () => super.emit(event, ...args);
          hold.entered();
          return true;
        }
        return super.emit(event, ...args);
      }
    },
  };
});

const actor = { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' } as const;
const sessionId = 'as_00000000-0000-7000-8000-000000000001';
const roots: string[] = [];
const pending: Promise<unknown>[] = [];
afterEach(async () => {
  const hold = transport.hold;
  transport.hold = undefined;
  hold?.deliver?.();
  await Promise.allSettled(pending.splice(0));
  await shutdownControlStoreWorkerClient();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Defers one real successful products reply and releases it on every assertion path. */
function holdProductReply() {
  let entered!: () => void;
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const hold: NonNullable<typeof transport.hold> = { entered };
  transport.hold = hold;
  return {
    reached,
    release() {
      if (transport.hold === hold) transport.hold = undefined;
      const deliver = hold.deliver;
      delete hold.deliver;
      deliver?.();
    },
  };
}

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

  it.each([
    'create',
    'update',
  ] as const)('returns its own acknowledged Thread %s while later heads remain current reads', async (operation) => {
    const f = await fixture();
    const other = new FsStore({ dataRoot: f.root });
    const threadId = operation === 'create' ? allocateEntityId('th') : f.thread.id;
    const gate = holdProductReply();
    let firstSettled = false;
    const mutation =
      operation === 'create'
        ? f.store.createThread(f.workspace.id, 'First acknowledged candidate', threadId)
        : f.store.updateThread(f.workspace.id, threadId, { name: 'First acknowledged candidate' });
    const first = mutation.then(
      (value) => {
        firstSettled = true;
        return { value };
      },
      (error: unknown) => {
        firstSettled = true;
        return { error };
      }
    );
    pending.push(first);
    try {
      await gate.reached;
      const acknowledged = other.getThread(f.workspace.id, threadId);
      expect(acknowledged).toMatchObject({
        id: threadId,
        owner: { kind: 'workspace', workspaceId: f.workspace.id },
        name: 'First acknowledged candidate',
      });
      const later = other.updateThread(f.workspace.id, threadId, { name: 'Later committed head' });
      pending.push(later);
      const current = await later;
      expect(current.name).toBe('Later committed head');
      expect(firstSettled).toBe(false);
      gate.release();
      expect.soft(await first).toEqual({ value: acknowledged });
      expect(f.store.getThread(f.workspace.id, threadId)).toEqual(current);
      await shutdownControlStoreWorkerClient();
      expect(new FsStore({ dataRoot: f.root }).getThread(f.workspace.id, threadId)).toEqual(
        current
      );
    } finally {
      gate.release();
    }
  });

  it('reads native private-Thread selection and original receipt replay from their current acknowledged owner', async () => {
    const f = await fixture();
    const dependencies = { store: f.store, inflightCommands: new WeakMap() };
    const create = vi.spyOn(f.store, 'createThread');
    try {
      const original = await createThreadCommand(
        {
          workspaceId: f.workspace.id,
          requestId: randomUUID(),
          name: 'Original Timeline',
          visibility: 'private',
        },
        dependencies,
        actor.id
      );
      const current = await f.store.updateThread(f.workspace.id, original.id, {
        name: 'Current Timeline',
      });
      const selected = await createThreadCommand(
        {
          workspaceId: f.workspace.id,
          requestId: randomUUID(),
          name: 'Unpublished fresh candidate',
          visibility: 'private',
        },
        dependencies,
        actor.id
      );
      const admittedCall = create.mock.calls.at(-1)!;
      expect(admittedCall[2]).not.toBe(original.id);
      expect(admittedCall[5]).toBeDefined();
      expect(selected).toEqual(current);
      expect(() => f.store.getThread(f.workspace.id, admittedCall[2]!)).toThrow(/not found/);
      const later = await f.store.updateThread(f.workspace.id, original.id, {
        name: 'Head after receipt',
      });
      // Replay the exact real command-produced admission; its unused candidate was never published.
      // No receipt, Audit or durable row is fabricated by this fixture.
      expect(await f.store.createThread(...admittedCall)).toEqual(later);
      expect(
        f.store
          .listThreads(f.workspace.id)
          .filter(
            (thread) => thread.visibility === 'private' && thread.privateOwnerUserId === actor.id
          )
      ).toEqual([later]);
    } finally {
      create.mockRestore();
    }
  });

  it('returns retained history when fresh private admissions race with the same candidate ID', async () => {
    const f = await fixture();
    const dependencies = { store: f.store, inflightCommands: new WeakMap() };
    const threadId = allocateEntityId('th');
    const requestIds = [randomUUID(), randomUUID()];
    const originalCreate = f.store.createThread.bind(f.store);
    let release!: () => void;
    const bothEntered = new Promise<void>((resolve) => {
      release = resolve;
    });
    let arrivals = 0;
    const create = vi.spyOn(f.store, 'createThread').mockImplementation(async (...args) => {
      if (++arrivals === 2) release();
      // Release both actual Store calls before either can submit its native transition.
      await bothEntered;
      return originalCreate(...args);
    });
    allocation.threadId = threadId;
    try {
      const commands = ['First admitted Timeline', 'Unwritten second candidate'].map(
        (name, index) =>
          createThreadCommand(
            {
              workspaceId: f.workspace.id,
              requestId: requestIds[index]!,
              name,
              visibility: 'private',
            },
            dependencies,
            actor.id
          )
      );
      pending.push(...commands);
      const [first, second] = await Promise.all(commands);
      expect(create.mock.calls.map((call) => call[2])).toEqual([threadId, threadId]);
      expect(create.mock.calls.map((call) => call[5]?.receipt.requestId)).toEqual(requestIds);
      const retained = f.store.getThread(f.workspace.id, threadId);
      expect(retained).toMatchObject({
        id: threadId,
        name: 'First admitted Timeline',
        visibility: 'private',
        privateOwnerUserId: actor.id,
      });
      expect(first).toEqual(retained);
      expect.soft(second).toEqual(retained);
      expect(
        f.store
          .listThreads(f.workspace.id)
          .filter(
            (thread) => thread.visibility === 'private' && thread.privateOwnerUserId === actor.id
          )
      ).toEqual([retained]);
      await shutdownControlStoreWorkerClient();
      expect(new FsStore({ dataRoot: f.root }).getThread(f.workspace.id, threadId)).toEqual(
        retained
      );
    } finally {
      allocation.threadId = undefined;
      release();
      create.mockRestore();
    }
  });

  it.each([
    'quarantine',
    'missing-database',
  ] as const)('preserves the current Thread refusal after FULL COMMIT and before reply delivery: %s', async (fault) => {
    const f = await fixture();
    const other = new FsStore({ dataRoot: f.root });
    const gate = holdProductReply();
    const result = f.store
      .updateThread(f.workspace.id, f.thread.id, { name: 'Acknowledged before refusal' })
      .then(
        (value) => ({ value }),
        (error: unknown) => ({ error })
      );
    pending.push(result);
    const databasePath = join(f.root, 'workspaces', f.workspace.id, 'db', 'workspace.sqlite');
    const heldPath = `${databasePath}.held`;
    try {
      await gate.reached;
      expect(other.getThread(f.workspace.id, f.thread.id).name).toBe('Acknowledged before refusal');
      if (fault === 'quarantine')
        refuseScope(f.root, { scope: 'workspace', id: f.workspace.id, check: 'recovery' });
      else renameSync(databasePath, heldPath);
      let expected: unknown;
      try {
        other.getThread(f.workspace.id, f.thread.id);
      } catch (error) {
        expected = error;
      }
      expect(expected).toBeInstanceOf(Error);
      if (!(expected instanceof Error)) throw new Error('The selected Thread must be unavailable.');
      expect(expected).toMatchObject({
        code: fault === 'quarantine' ? 'recovery_required' : 'ENOENT',
      });
      gate.release();
      expect(await result).toEqual({
        error: expect.objectContaining({
          name: expected.name,
          message: expected.message,
          ...('code' in expected ? { code: expected.code } : {}),
        }),
      });
    } finally {
      gate.release();
      if (existsSync(heldPath)) renameSync(heldPath, databasePath);
    }
  });

  it('returns its own AgentSession candidate when a later revision commits before its reply arrives', async () => {
    const f = await fixture();
    const session = await f.store.createAgentSession(f.sessionInput);
    const other = new FsStore({ dataRoot: f.root });
    const firstPatch = {
      message: 'First acknowledged candidate',
      updatedAt: '2026-10-02T00:00:00.000Z',
    };
    const laterPatch = {
      message: 'Later committed head',
      updatedAt: '2026-10-03T00:00:00.000Z',
    };
    const gate = holdProductReply();
    let firstSettled = false;
    const first = f.store.updateAgentSession(session.id, firstPatch).then(
      (value) => {
        firstSettled = true;
        return { value };
      },
      (error: unknown) => {
        firstSettled = true;
        return { error };
      }
    );
    pending.push(first);
    try {
      await gate.reached;
      const later = other.updateAgentSession(session.id, laterPatch);
      pending.push(later);
      // Completing this real public update establishes that the overtaking schedule is supported.
      // A timeout here is an inconclusive setup result, not the selected-head failure below.
      expect(await later).toEqual({ ...session, ...laterPatch });
      expect(firstSettled).toBe(false);
      gate.release();
      expect.soft(await first).toEqual({ value: { ...session, ...firstPatch } });
      expect(new FsStore({ dataRoot: f.root }).getAgentSession(session.id)).toEqual({
        ...session,
        ...laterPatch,
      });
    } finally {
      gate.release();
    }
  });

  it('refuses an acknowledged AgentSession result when its scope is refused before reply delivery', async () => {
    const f = await fixture();
    const session = await f.store.createAgentSession(f.sessionInput);
    const patch = { message: 'Committed before scope refusal' };
    const gate = holdProductReply();
    const result = f.store.updateAgentSession(session.id, patch).then(
      (value) => ({ value }),
      (error: unknown) => ({ error })
    );
    pending.push(result);
    try {
      await gate.reached;
      expect(new FsStore({ dataRoot: f.root }).getAgentSession(session.id).message).toBe(
        patch.message
      );
      refuseScope(f.root, { scope: 'workspace', id: f.workspace.id, check: 'recovery' });
      gate.release();
      expect(await result).toEqual({ error: expect.any(Error) });
    } finally {
      gate.release();
    }
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
    // The mutation result must preserve the admitted fields and existing absent-value defaults.
    expect(session).toEqual({
      ...f.sessionInput,
      configVersion: null,
      environmentPackageSnapshotId: null,
      nativeHandleDigest: null,
      retainedStorage: null,
      policySnapshotId: null,
      sandboxSummary: null,
      sessionCompatibilityKey: null,
      stale: false,
      workspaceRoots: [],
    });
    expect(new FsStore({ dataRoot: f.root }).getAgentSession(session.id)).toEqual(session);
    const sessionPatch = {
      status: 'closed' as const,
      message: 'Committed',
      configVersion: 7,
      environmentPackageSnapshotId: 'aepsnap_session-result',
      nativeHandleDigest: 'a'.repeat(64),
      retainedStorage: {
        storageRef: 'wst_00000000-0000-7000-8000-000000000001',
        workSlotRef: 'session-result',
        attachmentGeneration: 1,
      },
      stale: true,
      updatedAt: '2026-10-02T00:00:00.000Z',
    };
    const updatedSession = await f.store.updateAgentSession(session.id, sessionPatch);
    expect(updatedSession).toEqual({ ...session, ...sessionPatch });
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
