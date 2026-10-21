// openkit-test-platform: posix
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId, PROTOCOL_VERSION, SseEventEnvelopeSchema } from '@openkit/protocol';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { scopeAdmissionFailures } from '../bootstrap/readiness.js';
import { FsStore } from '../lib/store.js';
import { createTestStore } from '../test-support/store.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
import { WorkOwnershipViolationError } from './fs-layout.js';
import {
  nativeProductScope,
  readNativeProduct,
  readNativeTurnHistory,
} from './workspace-file-records.js';

const roots: string[] = [];
const actor = { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' } as const;

afterEach(async () => {
  await shutdownControlStoreWorkerClient();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Publishes real acknowledged records, then stops the writer before any retained-fixture mutation. */
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'native-agent-session-lineage-'));
  roots.push(root);
  const store = createTestStore({ dataRoot: root });
  const workspace = await store.createWorkspace('Reference owner');
  const healthy = await store.createWorkspace('Healthy sibling');
  const thread = await store.createThread(workspace.id, 'Bound Thread');
  const otherThread = await store.createThread(workspace.id, 'Other Thread');
  const healthyThread = await store.createThread(healthy.id, 'Healthy Thread');
  const timestamp = new Date().toISOString();
  const session = await store.createAgentSession({
    id: allocateEntityId('as'),
    workspaceId: workspace.id,
    threadId: thread.id,
    agentId: 'agent_codex_host',
    status: 'ready',
    message: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  const otherSession = await store.createAgentSession({
    ...session,
    id: allocateEntityId('as'),
    threadId: otherThread.id,
  });
  const turn = await store.createTurn(workspace.id, thread.id, 'Queued work', actor, null, {
    status: 'pending',
    agentId: session.agentId,
    agentSessionId: session.id,
  });
  const healthyTurn = await store.createTurn(
    healthy.id,
    healthyThread.id,
    'Queued sibling',
    actor,
    null,
    {
      status: 'pending',
      agentSessionId: null,
    }
  );
  await shutdownControlStoreWorkerClient();
  const scope = nativeProductScope(root, { kind: 'workspace', workspaceId: workspace.id });
  return {
    root,
    store,
    workspace: store.getWorkspace(workspace.id),
    healthy: store.getWorkspace(healthy.id),
    thread,
    healthyThread,
    turn,
    healthyTurn,
    session,
    otherSession,
    scope,
  };
}

/** Compares exact canonical SQL values and retained file bytes, excluding only SQLite WAL/SHM bookkeeping. */
function canonicalTree(root: string): Record<string, Buffer | string> {
  const result: Record<string, Buffer | string> = {};
  const databasePathPattern =
    /^(?:server\/db\/core|workspaces\/ws_[^/]+\/db\/workspace|users\/usr_[^/]+\/db\/user)\.sqlite$/;
  const visit = (directory: string, prefix = '') => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const key = join(prefix, entry.name);
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        result[key] = `link:${readlinkSync(path)}`;
      } else if (entry.isDirectory()) {
        result[key] = 'directory';
        visit(path, key);
      } else if (entry.isFile() && databasePathPattern.test(key)) {
        const sqlite = new Database(path, { readonly: true, fileMustExist: true });
        try {
          result[key] = sqlite.transaction(() => {
            const schema = sqlite
              .prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name')
              .all();
            const tables = sqlite
              .prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name")
              .all() as { name: string }[];
            const rows = tables.map(({ name }) => [
              name,
              sqlite
                .prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`)
                .raw(true)
                .safeIntegers(true)
                .all()
                .map((row) =>
                  JSON.stringify(row, (_key, value) =>
                    typeof value === 'bigint' ? { integer: value.toString() } : value
                  )
                )
                .sort(),
            ]);
            return Buffer.from(JSON.stringify({ schema, rows }));
          })();
        } finally {
          sqlite.close();
        }
      } else if (entry.isFile()) {
        if (!databasePathPattern.test(key.replace(/-(?:wal|shm)$/, '')))
          result[key] = readFileSync(path);
      } else {
        throw new Error('Canonical fixture contains an unsupported filesystem entry.');
      }
    }
  };
  visit(root);
  return result;
}

/** Injects only retained identity faults; SQL selectors agree with their JSON records and no live status changes. */
function corruptStoppedFixture(
  f: Awaited<ReturnType<typeof fixture>>,
  fault: 'missing' | 'other-thread' | 'other-workspace'
): void {
  const sqlite = new Database(f.scope.path, { fileMustExist: true });
  try {
    // The writer has stopped. Broken retained references must reach the reader rather than the FK insertion guard.
    sqlite.pragma('foreign_keys = OFF');
    if (fault === 'missing') {
      expect(
        sqlite.prepare('DELETE FROM control_agent_sessions WHERE id=?').run(f.session.id).changes
      ).toBe(1);
    } else if (fault === 'other-thread') {
      const row = sqlite
        .prepare('SELECT record_json FROM control_turns WHERE id=?')
        .get(f.turn.id) as { record_json: string };
      const record = { ...JSON.parse(row.record_json), agentSessionId: f.otherSession.id };
      expect(
        sqlite
          .prepare('UPDATE control_turns SET agent_session_id=?,record_json=? WHERE id=?')
          .run(f.otherSession.id, JSON.stringify(record), f.turn.id).changes
      ).toBe(1);
    } else {
      const row = sqlite
        .prepare('SELECT record_json FROM control_agent_sessions WHERE id=?')
        .get(f.session.id) as { record_json: string };
      const record = { ...JSON.parse(row.record_json), workspaceId: f.healthy.id };
      expect(
        sqlite
          .prepare('UPDATE control_agent_sessions SET workspace_id=?,record_json=? WHERE id=?')
          .run(f.healthy.id, JSON.stringify(record), f.session.id).changes
      ).toBe(1);
    }
    const turn = sqlite
      .prepare('SELECT thread_id,agent_session_id,record_json FROM control_turns WHERE id=?')
      .get(f.turn.id) as { thread_id: string; agent_session_id: string; record_json: string };
    expect(turn.thread_id).toBe(JSON.parse(turn.record_json).threadId);
    expect(turn.agent_session_id).toBe(JSON.parse(turn.record_json).agentSessionId);
    for (const row of sqlite
      .prepare('SELECT workspace_id,thread_id,record_json FROM control_agent_sessions')
      .all() as { workspace_id: string; thread_id: string; record_json: string }[]) {
      expect(row.workspace_id).toBe(JSON.parse(row.record_json).workspaceId);
      expect(row.thread_id).toBe(JSON.parse(row.record_json).threadId);
    }
  } finally {
    sqlite.close();
  }
}

// Predicates were frozen in main-native-session-reference-prior.md before source inspection.
// AgentSession identity comes from its allocating record; retained reference checks grant no runtime readiness.
describe('native Turn AgentSession reference meaning', () => {
  for (const fault of ['missing', 'other-thread'] as const) {
    it(`refuses ${fault} AgentSession authority within its Workspace without repair`, async () => {
      const f = await fixture();
      corruptStoppedFixture(f, fault);
      const before = canonicalTree(f.root);
      try {
        expect.soft(() => readNativeTurnHistory(f.scope, f.turn.id)).toThrow();
        expect.soft(() => f.store.getTurn(f.workspace.id, f.thread.id, f.turn.id)).toThrow();
        expect.soft(() => FsStore.validateFileAuthority(f.root)).not.toThrow();
        const reopened = new FsStore({ dataRoot: f.root });
        expect
          .soft(() => reopened.getWorkspace(f.workspace.id))
          .toThrow(expect.objectContaining({ code: 'recovery_required' }));
        expect
          .soft(() => reopened.getTurn(f.workspace.id, f.thread.id, f.turn.id))
          .toThrow(expect.objectContaining({ code: 'recovery_required' }));
        expect
          .soft(scopeAdmissionFailures(f.root))
          .toEqual([{ scope: 'workspace', id: f.workspace.id, check: 'records' }]);
        expect(reopened.getWorkspace(f.healthy.id)).toEqual(f.healthy);
        expect(reopened.getTurn(f.healthy.id, f.healthyThread.id, f.healthyTurn.id)).toEqual(
          f.healthyTurn
        );
      } finally {
        await shutdownControlStoreWorkerClient();
        expect(canonicalTree(f.root)).toEqual(before);
      }
    });
  }

  it('refuses a canonical AgentSession claim on another Workspace at the shared ownership boundary', async () => {
    const f = await fixture();
    corruptStoppedFixture(f, 'other-workspace');
    const before = canonicalTree(f.root);
    try {
      expect.soft(() => readNativeTurnHistory(f.scope, f.turn.id)).toThrow();
      expect.soft(() => f.store.getTurn(f.workspace.id, f.thread.id, f.turn.id)).toThrow();
      expect.soft(() => FsStore.validateFileAuthority(f.root)).toThrow(WorkOwnershipViolationError);
      expect.soft(() => new FsStore({ dataRoot: f.root })).toThrow(WorkOwnershipViolationError);
    } finally {
      await shutdownControlStoreWorkerClient();
      expect(canonicalTree(f.root)).toEqual(before);
    }
  });

  it('retains a valid null binding on a queued pending Turn without inventing an AgentSession', async () => {
    const f = await fixture();
    const scope = nativeProductScope(f.root, { kind: 'workspace', workspaceId: f.healthy.id });
    const before = canonicalTree(f.root);
    try {
      expect(readNativeTurnHistory(scope, f.healthyTurn.id)!.turn).toEqual(f.healthyTurn);
      expect(
        f.store.getTurn(f.healthy.id, f.healthyThread.id, f.healthyTurn.id).agentSessionId
      ).toBeNull();
      FsStore.validateFileAuthority(f.root);
      const reopened = new FsStore({ dataRoot: f.root });
      expect(reopened.getTurn(f.healthy.id, f.healthyThread.id, f.healthyTurn.id)).toEqual(
        f.healthyTurn
      );
      expect(reopened.listWorkspaceAgentSessions(f.healthy.id)).toEqual([]);
      expect(scopeAdmissionFailures(f.root)).toEqual([]);
    } finally {
      await shutdownControlStoreWorkerClient();
      expect(canonicalTree(f.root)).toEqual(before);
    }
  });

  it('retains a settled historical Turn reference to its closed AgentSession without reopening it', async () => {
    const f = await fixture();
    const workspaceId = allocateEntityId('ws');
    const threadId = allocateEntityId('th');
    const turnId = allocateEntityId('tu');
    const sessionId = allocateEntityId('as');
    const owner = { kind: 'workspace', workspaceId } as const;
    const completedAt = f.turn.startedAt!;
    const turn = {
      ...f.turn,
      id: turnId,
      owner,
      threadId,
      agentSessionId: sessionId,
      status: 'completed' as const,
      completedAt,
      durationMs: 0,
    };
    const session = {
      ...f.session,
      id: sessionId,
      workspaceId,
      threadId,
      status: 'closed' as const,
      updatedAt: completedAt,
    };
    // Historical import is the admitted producer. Do not bypass live terminal publication with invented execution/release facts.
    await f.store.importWorkspaceSnapshot({
      workspace: { ...f.workspace, id: workspaceId },
      threads: [{ ...f.thread, id: threadId, owner }],
      turns: [turn],
      agentSessions: [session],
      knowledge: [],
      itemRevisions: [],
      artifacts: [],
      turnEvents: [
        [
          turnId,
          [
            SseEventEnvelopeSchema.parse({
              protocolVersion: PROTOCOL_VERSION,
              requestId: null,
              workspaceId,
              threadId,
              turnId,
              sequence: 1,
              timestamp: completedAt,
              event: 'turn.completed',
              data: { type: 'turn-completed', turn, stopReason: 'completed' },
            }),
          ],
        ],
      ],
      notebookInitialization: {
        requestId: randomUUID(),
        producer: actor,
        instructionReference: 'native-agent-session-history-fixture',
      },
    });
    await shutdownControlStoreWorkerClient();
    const scope = nativeProductScope(f.root, owner);
    const before = canonicalTree(f.root);
    try {
      expect(readNativeTurnHistory(scope, turnId)!.turn).toEqual(turn);
      expect(readNativeProduct(scope, 'agent-session', sessionId)!.record).toMatchObject(session);
      FsStore.validateFileAuthority(f.root);
      const reopened = new FsStore({ dataRoot: f.root });
      expect(reopened.getTurn(workspaceId, threadId, turnId)).toEqual(turn);
      expect(reopened.getAgentSession(sessionId)).toEqual(session);
      expect(scopeAdmissionFailures(f.root)).toEqual([]);
    } finally {
      await shutdownControlStoreWorkerClient();
      expect(canonicalTree(f.root)).toEqual(before);
    }
  });
});
