import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { Worker as NativeWorker } from 'node:worker_threads';
import type { GoalView } from '@openkit/app-api-schemas';
import { deriveEntityId } from '@openkit/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FsStore } from '../lib/store.js';
import { ProviderRegistry } from '../providers/registry.js';
import { executeGoalOperation } from '../runtime/goal-owner.js';
import { recoverPendingRequestsAtBoot } from '../runtime/pending-request-flow.js';
import { createTestGatewayConfig } from '../test-support/agent-environment.js';
import { createApp } from '../test-support/app.js';
import { ensureLocalUser, FIXTURE_LOCAL_USER_ID } from '../test-support/local-user.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './control-store-worker-client.js';
import { openCoreDb, openWorkspaceDb, type WorkspaceDb } from './db.js';
import { workspaceDbPath } from './fs-layout.js';
import { applyMigrations } from './migrate.js';
import { nativeProductScope } from './workspace-file-records.js';

const transport = vi.hoisted(() => ({
  workers: [] as NativeWorker[],
  hold: undefined as
    | {
        operation: string;
        entered: () => void;
        deliver?: () => void;
      }
    | undefined,
}));

// Delay only a real transport reply. The actual Worker, deciding body and durable COMMIT run unchanged.
vi.mock('node:worker_threads', async (load) => {
  const actual = await load<typeof import('node:worker_threads')>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(filename: string | URL, options?: import('node:worker_threads').WorkerOptions) {
        super(filename, options);
        transport.workers.push(this);
      }

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
          reply.operation === hold.operation
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

const roots: string[] = [];
const readers: WorkspaceDb[] = [];
const actor = { kind: 'local' as const, userId: FIXTURE_LOCAL_USER_ID };

/** Arms one acknowledgement barrier without changing request admission, SQL or product outcomes. */
function holdReply(operation: string) {
  let entered!: () => void;
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const hold: NonNullable<typeof transport.hold> = { operation, entered };
  transport.hold = hold;
  return {
    reached,
    release() {
      if (transport.hold === hold) transport.hold = undefined;
      const deliver = hold.deliver;
      hold.deliver = undefined;
      deliver?.();
    },
    discard() {
      if (transport.hold === hold) transport.hold = undefined;
      hold.deliver = undefined;
    },
  };
}

/** Attaches rejection handling before transport delivery can settle a producer. */
function observe<T>(promise: Promise<T>) {
  return promise.then(
    (value) => ({ status: 'ok' as const, value }),
    (error: unknown) => ({ status: 'error' as const, error })
  );
}

/** Creates current product authority through the real Store and opens only a short-read observer. */
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'native-producer-lifetime-'));
  roots.push(root);
  const core = openCoreDb(root);
  try {
    applyMigrations(core);
    ensureLocalUser(core);
  } finally {
    core.sqlite.close();
  }
  const store = new FsStore({ dataRoot: root });
  const workspace = await store.createWorkspace('Native producer lifetime');
  const db = openWorkspaceDb(root, workspace.id);
  readers.push(db);
  const client = getControlStoreWorkerClient();
  const database = `workspace:${workspaceDbPath(root, workspace.id)}`;
  const scope = nativeProductScope(root, { kind: 'workspace', workspaceId: workspace.id });
  await client.open({
    database,
    path: scope.path,
    dataRoot: root,
    create: false,
    initialize: 'workspace',
    productOwner: scope.owner,
    contentMount: scope.contentMount,
  });
  return { root, store, workspace, db, client, database };
}

/** Explicitly registers a producer that uses the real Goal owner and its optional origin publication. */
function startGoalProducer(f: Awaited<ReturnType<typeof fixture>>, originThreadId?: string) {
  const requestId = randomUUID();
  const input = {
    workspaceId: f.workspace.id,
    requestId,
    intent: 'Preserve admitted work through shutdown',
    ...(originThreadId ? { originThreadId } : {}),
  };
  return {
    requestId,
    result: observe(
      f.client.runOperation(() =>
        executeGoalOperation('goal.create', input, { actor }, f.store, f.db)
      )
    ),
  };
}

afterEach(async () => {
  const held = transport.hold;
  transport.hold = undefined;
  held?.deliver?.();
  try {
    await shutdownControlStoreWorkerClient();
  } finally {
    // Cleanup remains explicit even when a transport-loss regression fails.
    for (const worker of transport.workers.splice(0)) await worker.terminate();
    for (const db of readers.splice(0)) db.sqlite.close();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  }
});

// These tests decide explicit producer retention, not automatic registration of application entrypoints.
describe('registered native producer lifetime during shutdown', () => {
  it('drains a registered Goal producer before its open ACK and refuses a new producer', async () => {
    const f = await fixture();
    await f.client.close(f.database);
    const gate = holdReply('open');
    const admitted = startGoalProducer(f);
    await gate.reached;
    const shutdown = observe(f.client.shutdown());
    const unrelated = startGoalProducer(f);
    const refused = await unrelated.result;
    gate.release();
    const result = await admitted.result;
    const stopped = await shutdown;

    expect(refused).toMatchObject({
      status: 'error',
      error: { code: 'unavailable', commit: 'not-committed' },
    });
    expect(result).toMatchObject({
      status: 'ok',
      value: { goal: { intent: 'Preserve admitted work through shutdown' } },
    });
    expect(stopped).toMatchObject({ status: 'ok' });
    expect(f.db.sqlite.prepare('SELECT request_id FROM idempotency_requests').all()).toEqual([
      { request_id: admitted.requestId },
    ]);
    expect(f.db.sqlite.prepare('SELECT goal_id FROM goals').all()).toEqual([
      { goal_id: `g_${admitted.requestId}` },
    ]);
    expect(
      f.db.sqlite
        .prepare('SELECT request_id FROM idempotency_requests WHERE request_id=?')
        .get(unrelated.requestId)
    ).toBeUndefined();
  });

  it('keeps a registered Goal producer alive through its awaited native origin handoff', async () => {
    const f = await fixture();
    const origin = await f.store.createThread(f.workspace.id, 'Goal origin');
    const goalAck = holdReply('goal');
    const admitted = startGoalProducer(f, origin.id);
    await goalAck.reached;
    const order: string[] = [];
    const produced = admitted.result.then((result) => {
      order.push('producer');
      return result;
    });
    const shutdown = observe(f.client.shutdown()).then((result) => {
      order.push('shutdown');
      return result;
    });
    const terminalAck = holdReply('terminal');
    goalAck.release();
    const next = await Promise.race([
      terminalAck.reached.then(() => ({ status: 'nested-ack' as const })),
      produced,
      shutdown.then((result) => ({ status: 'early-shutdown' as const, result })),
    ]);
    try {
      expect(next).toEqual({ status: 'nested-ack' });
      await nextTurn();
      expect(order).toEqual([]);
    } finally {
      terminalAck.release();
    }
    expect(await produced).toMatchObject({ status: 'ok' });
    expect(await shutdown).toMatchObject({ status: 'ok' });
    expect(order).toEqual(['producer', 'shutdown']);
    const handoffId = deriveEntityId('tu', ['goal_handoff', admitted.requestId]);
    const handoffItem = deriveEntityId('it', ['goal_handoff', `g_${admitted.requestId}`]);
    expect(new FsStore({ dataRoot: f.root }).getTurnById(handoffId)).toMatchObject({
      status: 'completed',
      threadId: origin.id,
      items: [expect.objectContaining({ id: handoffItem, type: 'assistant-message' })],
    });
    expect(
      f.db.sqlite
        .prepare('SELECT command_name FROM idempotency_requests WHERE request_id=?')
        .get(admitted.requestId)
    ).toEqual({ command_name: 'goal.create' });
  });

  it('drains explicitly registered Pending boot recovery across its native scope ACK', async () => {
    const f = await fixture();
    await f.client.close(f.database);
    const gate = holdReply('open');
    const boot = observe(
      f.client.runOperation(() =>
        recoverPendingRequestsAtBoot(f.store, {
          openWorkspace: (workspaceId) => openWorkspaceDb(f.root, workspaceId),
        })
      )
    );
    await gate.reached;
    const shutdown = observe(f.client.shutdown());
    gate.release();
    expect(await boot).toMatchObject({ status: 'ok' });
    expect(await shutdown).toMatchObject({ status: 'ok' });
    expect(f.db.sqlite.prepare('SELECT * FROM pending_requests').all()).toEqual([]);
    expect(f.db.sqlite.prepare('SELECT * FROM control_turns').all()).toEqual([]);
  });

  it('drains an explicitly registered local terminal producer across its scope ACK', async () => {
    const f = await fixture();
    const thread = await f.store.createThread(f.workspace.id, 'Local terminal');
    const turn = await f.store.createTurn(f.workspace.id, thread.id, 'Complete local work', {
      kind: 'user',
      id: FIXTURE_LOCAL_USER_ID,
    });
    await f.client.close(f.database);
    const gate = holdReply('open');
    const completedAt = new Date().toISOString();
    const terminal = observe(
      f.client.runOperation(() =>
        f.store.completeTurn(turn.id, { status: 'completed', completedAt })
      )
    );
    await gate.reached;
    const shutdown = observe(f.client.shutdown());
    gate.release();
    expect(await terminal).toMatchObject({
      status: 'ok',
      value: { id: turn.id, status: 'completed', completedAt },
    });
    expect(await shutdown).toMatchObject({ status: 'ok' });
    const reopened = new FsStore({ dataRoot: f.root });
    expect(reopened.getTurnById(turn.id)).toMatchObject({ status: 'completed', completedAt });
    expect(
      reopened.getTurnEventsForExport(turn.id).filter((event) => event.event === 'turn.completed')
    ).toHaveLength(1);
    expect(
      f.db.sqlite.prepare('SELECT id FROM control_work_observations WHERE turn_id=?').all(turn.id)
    ).toEqual([{ id: `turn.reap:${turn.id}` }]);
    // Local terminality is not Worker execution, runtime evidence or physical-release proof.
    expect(f.db.sqlite.prepare('SELECT * FROM control_executions').all()).toEqual([]);
    expect(f.db.sqlite.prepare('SELECT * FROM runtime_evidence').all()).toEqual([]);
  });

  it('does not start a Worker when getting and shutting down an unused client lifetime', async () => {
    await shutdownControlStoreWorkerClient();
    const before = transport.workers.length;
    const unused = getControlStoreWorkerClient();
    expect(transport.workers).toHaveLength(before);
    await unused.shutdown();
    expect(transport.workers).toHaveLength(before);
  });

  it('retains unknown after a committed Goal loses its actual Worker acknowledgement', async () => {
    const f = await fixture();
    const gate = holdReply('goal');
    const admitted = startGoalProducer(f);
    await gate.reached;
    expect(
      f.db.sqlite
        .prepare('SELECT request_id FROM idempotency_requests WHERE request_id=?')
        .get(admitted.requestId)
    ).toEqual({ request_id: admitted.requestId });
    expect(f.db.sqlite.prepare('SELECT goal_id FROM goals').all()).toEqual([
      { goal_id: `g_${admitted.requestId}` },
    ]);
    gate.discard();
    const workersBeforeLoss = transport.workers.length;
    await transport.workers.at(-1)!.terminate();
    expect(await admitted.result).toMatchObject({
      status: 'error',
      error: { code: 'unavailable', commit: 'unknown' },
    });
    await f.client.shutdown();
    expect(transport.workers).toHaveLength(workersBeforeLoss);
    expect(f.db.sqlite.prepare('SELECT request_id FROM idempotency_requests').all()).toEqual([
      { request_id: admitted.requestId },
    ]);
    expect(new FsStore({ dataRoot: f.root }).listThreads(f.workspace.id)).toHaveLength(1);
  });
});

it('automatically retains the detached HTTP Goal Coordinator through its real terminal ACK', async () => {
  const root = mkdtempSync(join(tmpdir(), 'http-goal-producer-lifetime-'));
  roots.push(root);
  const coreDb = openCoreDb(root);
  let enterModel!: () => void;
  const modelEntered = new Promise<void>((resolve) => {
    enterModel = resolve;
  });
  let releaseModel!: () => void;
  const modelHeld = new Promise<void>((resolve) => {
    releaseModel = resolve;
  });
  let terminalAck: ReturnType<typeof holdReply> | undefined;
  try {
    applyMigrations(coreDb);
    const userId = ensureLocalUser(coreDb);
    const store = new FsStore({ dataRoot: root });
    const workspace = await store.createWorkspace('HTTP Goal shutdown lifetime');
    recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
    const gatewayConfig = createTestGatewayConfig();
    gatewayConfig.logicalModels[0]!.contextManagement = [
      { type: 'compaction', compactThreshold: 64000 },
    ];
    // The provider is outside the native producer subject; hold only its bounded final response.
    const dispatch = vi.fn(async () => {
      enterModel();
      await modelHeld;
      return {
        id: randomUUID(),
        object: 'response',
        status: 'completed',
        output: [
          {
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'Finished this bounded Goal Turn.' }],
          },
        ],
      };
    });
    const app = createApp({
      coreDb,
      dataRoot: root,
      store,
      gatewayConfig,
      providerRegistry: new ProviderRegistry([
        {
          id: 'agent-openrouter',
          kind: 'local',
          displayName: 'Held Goal model transport',
          models: ['openai/gpt-5.2'],
        },
      ]),
      llmGatewayDispatcher: { createResponses: dispatch } as never,
    });
    const db = openWorkspaceDb(root, workspace.id);
    readers.push(db);
    const requestId = randomUUID();
    const response = await app.request('/api/app/operations/goal.create', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-openkit-request-id': requestId },
      body: JSON.stringify({
        workspaceId: workspace.id,
        intent: 'Complete a bounded Coordinator Turn before writer shutdown',
      }),
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const created = (await response.json()) as GoalView;
    expect(created.goal).not.toBeNull();
    await modelEntered;
    const admitted = store.listThreadTurns(workspace.id, created.goal!.threadId);
    expect(admitted).toHaveLength(1);
    const turn = admitted[0]!;
    expect(turn).toMatchObject({ agentId: 'goal-coordinator', status: 'running' });

    // No manual runOperation registration: the app's actual Coordinator owns this detached work.
    const order: string[] = [];
    const shutdown = observe(getControlStoreWorkerClient().shutdown()).then((result) => {
      order.push('shutdown');
      return result;
    });
    await nextTurn();
    expect(order).toEqual([]);
    terminalAck = holdReply('terminal');
    releaseModel();
    const next = await Promise.race([
      terminalAck.reached.then(() => ({ status: 'terminal-ack' as const })),
      shutdown.then((result) => ({ status: 'early-shutdown' as const, result })),
    ]);
    expect(next).toEqual({ status: 'terminal-ack' });
    expect(order).toEqual([]);
    expect(db.sqlite.prepare('SELECT status FROM control_turns WHERE id=?').get(turn.id)).toEqual({
      status: 'completed',
    });
    terminalAck.release();
    order.push('terminal-ack');
    expect(await shutdown).toMatchObject({ status: 'ok' });
    expect(order).toEqual(['terminal-ack', 'shutdown']);

    db.sqlite.close();
    readers.splice(readers.indexOf(db), 1);
    const coldDb = openWorkspaceDb(root, workspace.id);
    readers.push(coldDb);
    const reopened = new FsStore({ dataRoot: root });
    expect(reopened.listThreadTurns(workspace.id, created.goal!.threadId)).toEqual([
      expect.objectContaining({ id: turn.id, status: 'completed', error: null }),
    ]);
    expect(reopened.getTurnById(turn.id).items).toContainEqual(
      expect.objectContaining({
        type: 'assistant-message',
        text: 'Finished this bounded Goal Turn.',
      })
    );
    expect(
      reopened.getTurnEventsForExport(turn.id).filter((event) => event.event === 'turn.completed')
    ).toEqual([
      expect.objectContaining({
        turnId: turn.id,
        data: expect.objectContaining({ type: 'turn-completed', stopReason: 'completed' }),
      }),
    ]);
    expect(
      coldDb.sqlite
        .prepare('SELECT command_name,response_id FROM idempotency_requests WHERE request_id=?')
        .all(requestId)
    ).toEqual([{ command_name: 'goal.create', response_id: created.goal!.goalId }]);
    expect(dispatch).toHaveBeenCalledTimes(1);
  } finally {
    releaseModel();
    terminalAck?.release();
    try {
      await shutdownControlStoreWorkerClient();
    } finally {
      coreDb.sqlite.close();
    }
  }
});
