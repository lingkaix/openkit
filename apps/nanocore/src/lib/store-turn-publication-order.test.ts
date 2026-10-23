import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { Worker as NativeWorker } from 'node:worker_threads';
import { allocateEntityId, ItemSchema, writeRetainedV1 } from '@openkit/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getArtifactReview } from '../artifact-reviews.js';
import { initializeDefaultKnowledgeBaseId } from '../config/knowledge-base.js';
import { dispatchOpenkitWorkTool } from '../runtime/openkit-work-mcp.js';
import type { WorkerArtifactCapture } from '../runtime/worker-governance-backend.js';
import { FileStorageAdmission } from '../storage/artifacts/file-admission.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from '../storage/control-store-worker-client.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { nativeProductScope, readNativeProduct } from '../storage/workspace-file-records.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { resolveAgentEnvironmentPackage } from '../test-support/prepared-agent-environment.js';
import { createTestStore } from '../test-support/store.js';
import { ALREADY_DECIDED_PUBLICATION_ADMISSION, FsStore } from './store.js';

const transport = vi.hoisted(() => ({
  workers: [] as NativeWorker[],
  hold: undefined as { operation: string; entered: () => void; deliver?: () => void } | undefined,
}));
// Hold only a real post-COMMIT transport reply. Native preparation, SQL and replies stay unchanged.
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
        const reply = args[0],
          hold = transport.hold;
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
const databases: Array<{ sqlite: { open: boolean; close(): void } }> = [];
const pending: Promise<unknown>[] = [];
const actor = { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' } as const;
/** Observes every producer before its transport can reject, and retains cleanup ownership. */
function observe<T>(promise: Promise<T>) {
  const result = promise.then(
    (value) => ({ status: 'ok' as const, value }),
    (error: unknown) => ({ status: 'error' as const, error })
  );
  pending.push(result);
  return result;
}
/** Gives a public producer callback an explicit release on every assertion path. */
function barrier() {
  let release!: () => void;
  const reached = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { reached, release };
}
/** Arms one acknowledgement barrier; release and loss both detach the held reply. */
function holdReply(operation: string) {
  const { reached, release: entered } = barrier();
  const hold: NonNullable<typeof transport.hold> = { operation, entered };
  transport.hold = hold;
  return {
    reached,
    release(deliver = true) {
      if (transport.hold === hold) transport.hold = undefined;
      const reply = hold.deliver;
      delete hold.deliver;
      if (deliver) reply?.();
    },
  };
}
/** A timeout releases the test barrier on correct serialization; early success is direct failure evidence. */
async function beforeRelease<T>(result: Promise<T>): Promise<T | 'pending'> {
  const timeout = barrier();
  const timer = setTimeout(timeout.release, 1000);
  const waiting = timeout.reached.then(() => 'pending' as const);
  return Promise.race([result, waiting]).finally(() => clearTimeout(timer));
}
/** Creates actual native authority through acknowledged Store and shared AEP owners. */
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'store-turn-order-'));
  roots.push(root);
  const store = createTestStore({ dataRoot: root });
  const coreDb = openCoreDb(root);
  databases.push(coreDb);
  ensureLocalUser(coreDb);
  initializeDefaultKnowledgeBaseId({
    dataRoot: root,
    scope: { kind: 'server' },
    knowledgeBaseId: allocateEntityId('kb'),
  });
  const workspace = await store.createWorkspace('Turn producer order');
  const thread = await store.createThread(workspace.id, 'Producing Thread');
  const turn = await store.createTurn(workspace.id, thread.id, 'Produce reports', actor);
  const peerThread = await store.createThread(workspace.id, 'Independent Thread');
  const peer = await store.createTurn(workspace.id, peerThread.id, 'Independent work', actor);
  const environmentPackage = resolveAgentEnvironmentPackage({
    coreDb,
    agentSetup: createTestAgentSetup(),
    agentSessionId: allocateEntityId('as'),
    triggerActor: turn.triggerActor,
    backend: { kind: 'openshell' },
    createdAt: turn.startedAt!,
    requestId: randomUUID(),
    turn,
    workspaceCwd: '/workspace/output',
    workspaceRoots: [],
  });
  await store.createAgentSession({
    id: environmentPackage.scope.agentSessionId,
    workspaceId: workspace.id,
    threadId: thread.id,
    agentId: environmentPackage.agent.agentId,
    status: 'ready',
    message: null,
    createdAt: turn.startedAt!,
    updatedAt: turn.startedAt!,
  });
  await store.updateTurn(turn.id, {
    agentId: environmentPackage.agent.agentId,
    agentSessionId: environmentPackage.scope.agentSessionId,
  });
  const workspaceDb = openWorkspaceDb(root, workspace.id);
  databases.push(workspaceDb);
  const bytes = Buffer.from('An exact bounded report.\n');
  const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
  const captureArtifact: WorkerArtifactCapture = async () => ({
    source: Readable.from([bytes]),
    byteLength: bytes.length,
    contentDigest: `sha256:${digest(bytes)}`,
    credentialCheckValues: {
      sensitiveValues: ['synthetic-injected-secret'],
      loopbackDigests: ['a', 'b'].map((value) => digest(value.repeat(43))),
      routeTokenHashes: {
        workerControl: digest(Buffer.alloc(32, 17)),
        inference: digest(Buffer.alloc(32, 34)),
        capability: digest(Buffer.alloc(32, 51)),
      },
    },
    remove: async () => {},
  });
  const fileAdmission = new FileStorageAdmission(root, () => 0n);
  const submit = (requestId: string) =>
    dispatchOpenkitWorkTool(
      { coreDb, store, workspaceDb, environmentPackage, captureArtifact, fileAdmission },
      'work_artifact_submit',
      {
        requestId,
        path: `/openkit/sessions/${environmentPackage.scope.agentSessionId}/outputs/report.md`,
        kind: 'report',
        title: 'Report',
        mediaType: 'text/markdown',
      }
    );
  return { root, store, workspace, turn, peer, workspaceDb, submit };
}
/** Builds a valid candidate Item; its durable identity and revisions remain Store-owned. */
function message(turn: ReturnType<FsStore['getTurnById']>, text: string) {
  return ItemSchema.parse({
    id: allocateEntityId('it'),
    owner: turn.owner,
    threadId: turn.threadId,
    turnId: turn.id,
    type: 'user-message',
    actor,
    text,
    status: 'completed',
    createdAt: turn.startedAt!,
    completedAt: turn.startedAt!,
  });
}
afterEach(async () => {
  const held = transport.hold;
  transport.hold = undefined;
  held?.deliver?.();
  try {
    await Promise.allSettled(pending.splice(0));
    await shutdownControlStoreWorkerClient();
  } finally {
    for (const worker of transport.workers.splice(0)) await worker.terminate();
    for (const db of databases.splice(0)) if (db.sqlite.open) db.sqlite.close();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  }
});
// Owner: durable_execution_and_control_store, Write And Space Budget, natural batching paragraph.
describe('Store same-Turn publication order through the real native worker', () => {
  it('holds a successor Artifact submission until its predecessor FULL ACK without blocking another Turn', async () => {
    const f = await fixture();
    const gate = holdReply('review');
    const order: string[] = [],
      notifications: number[] = [];
    const detach = f.store.addTurnListener(f.turn.id, (event) =>
      notifications.push(event.sequence)
    );
    const first = observe(
      f.submit(randomUUID()).then((value) => {
        order.push('first');
        return value;
      })
    );
    let second: typeof first | undefined;
    try {
      await gate.reached;
      second = observe(
        f.submit(randomUUID()).then((value) => {
          order.push('second');
          return value;
        })
      );
      const independent = await f.store.createItem(message(f.peer, 'Independent success'));
      expect(independent).toMatchObject({ turnId: f.peer.id, text: 'Independent success' });
      const early = await beforeRelease(second);
      // Queued means pending; a held predecessor ACK forbids both successor success and notification.
      expect.soft(early).toBe('pending');
      expect.soft(notifications).toEqual([]);
    } finally {
      gate.release();
      await first;
      if (second) await second;
      detach();
    }
    expect(await first).toMatchObject({ status: 'ok', value: { isError: false } });
    expect(await second!).toMatchObject({ status: 'ok', value: { isError: false } });
    expect(order).toEqual(['first', 'second']);
    const artifacts = f.store.listArtifacts(f.workspace.id);
    expect(artifacts).toHaveLength(2);
    for (const artifact of artifacts) {
      expect(getArtifactReview(f.workspaceDb, artifact.id, 1)).toMatchObject({
        sourceTurnId: f.turn.id,
      });
    }
    expect(f.store.getTurnEventsForExport(f.turn.id).map((event) => event.sequence)).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
    expect(new FsStore({ dataRoot: f.root }).getTurnById(f.turn.id).items).toHaveLength(2);
  });
  it('selects each new Item position after its same-Turn predecessor acknowledges', async () => {
    const f = await fixture();
    const items = [message(f.turn, 'First'), message(f.turn, 'Second')];
    const results = await Promise.all(items.map((item) => observe(f.store.createItem(item))));
    expect(results).toEqual(items.map((value) => ({ status: 'ok', value })));
    expect(new FsStore({ dataRoot: f.root }).getTurnById(f.turn.id).items).toEqual(items);
  });
  it('applies queued Item patches to the acknowledged predecessor revision', async () => {
    const f = await fixture();
    const original = await f.store.createItem(message(f.turn, 'Original'));
    const completedAt = new Date(Date.parse(f.turn.startedAt!) + 1000).toISOString();
    const results = await Promise.all([
      observe(f.store.updateItem(original.id, { text: 'Updated' })),
      observe(f.store.updateItem(original.id, { completedAt })),
    ]);
    expect(results.map((result) => result.status)).toEqual(['ok', 'ok']);
    expect(new FsStore({ dataRoot: f.root }).getTurnById(f.turn.id).items).toEqual([
      { ...original, text: 'Updated', completedAt },
    ]);
    expect(f.store.listWorkspaceItemRevisions(f.workspace.id)).toEqual([
      original,
      { ...original, text: 'Updated' },
      { ...original, text: 'Updated', completedAt },
    ]);
  });
  it('retains concurrent canonical events in arrival order with separate acknowledged sequence numbers', async () => {
    const f = await fixture();
    const items = [message(f.turn, 'First event'), message(f.turn, 'Second event')];
    for (const item of items) await f.store.createItem(item);
    const results = await Promise.all(
      items.map((item) =>
        observe(
          f.store.persistTurnEvent(f.turn.id, {
            event: 'item.created',
            workspaceId: f.workspace.id,
            threadId: f.turn.threadId,
            turnId: f.turn.id,
            data: { type: 'item-created', item },
          })
        )
      )
    );
    expect(results.map((result) => result.status)).toEqual(['ok', 'ok']);
    const events = new FsStore({ dataRoot: f.root }).getTurnEventsForExport(f.turn.id);
    expect(events.map((event) => event.sequence)).toEqual([1, 2]);
    expect(events.map((event) => event.data)).toEqual(
      items.map((item) => ({ type: 'item-created', item }))
    );
  });
  it('refuses the dependent Item after a lost predecessor ACK and retains the committed predecessor', async () => {
    const f = await fixture();
    const items = [message(f.turn, 'Unknown predecessor'), message(f.turn, 'Dependent successor')];
    const gate = holdReply('products');
    const first = observe(f.store.createItem(items[0]!));
    let second: typeof first | undefined;
    try {
      await gate.reached;
      second = observe(f.store.createItem(items[1]!));
      // Let a wrongly admitted successor finish; correct serialization stays pending until transport loss.
      await beforeRelease(second);
      gate.release(false);
      await transport.workers.at(-1)!.terminate();
      expect(await first).toMatchObject({ status: 'error', error: { commit: 'unknown' } });
      expect(await second).toMatchObject({ status: 'error', error: { commit: 'not-committed' } });
      expect(new FsStore({ dataRoot: f.root }).getTurnById(f.turn.id).items).toEqual([items[0]]);
    } finally {
      gate.release();
      await first;
      if (second) await second;
    }
  });
  it('orders concurrent registered children and retains the input admitted before their wait', async () => {
    const f = await fixture();
    const client = getControlStoreWorkerClient();
    const gate = holdReply('products');
    const original = message(f.turn, 'Original queued bytes');
    const owned = structuredClone(original);
    const first = observe(f.store.createItem(message(f.turn, 'Predecessor')));
    let children: Promise<unknown> | undefined;
    try {
      await gate.reached;
      children = observe(
        client.runOperation(async () => {
          const second = f.store.createItem(original);
          const third = f.store.createItem(message(f.turn, 'Concurrent sibling'));
          if (original.type === 'user-message') original.text = 'Changed after admission';
          return Promise.all([second, third]);
        })
      );
      await nextTurn();
    } finally {
      gate.release();
      await first;
      if (children) await children;
    }
    expect(await children).toMatchObject({ status: 'ok' });
    expect(new FsStore({ dataRoot: f.root }).getTurnById(f.turn.id).items).toEqual([
      expect.objectContaining({ text: 'Predecessor' }),
      owned,
      expect.objectContaining({ text: 'Concurrent sibling' }),
    ]);
  });
  it('refuses an Item submitted after an already admitted terminal operation', async () => {
    const f = await fixture();
    const terminal = observe(
      f.store.completeTurn(f.peer.id, {
        status: 'completed',
        completedAt: f.peer.startedAt!,
      })
    );
    const late = observe(f.store.createItem(message(f.peer, 'After terminal admission')));
    expect(await terminal).toMatchObject({ status: 'ok' });
    expect(await late).toMatchObject({ status: 'error' });
    expect(new FsStore({ dataRoot: f.root }).getTurnById(f.peer.id)).toMatchObject({
      status: 'completed',
      items: [],
    });
  });
  it('flushes a mixed prefix through direct terminal update and retains its post-ACK hook during shutdown', async () => {
    const f = await fixture();
    const client = getControlStoreWorkerClient();
    const entered = barrier(),
      release = barrier();
    const item = message(f.peer, 'Before terminal');
    const decided = message(f.peer, 'Already decided terminal publication');
    const order: string[] = [];
    f.store.setTurnAdmissionHooks({
      onTerminal: async () => {
        entered.release();
        await release.reached;
        await f.store.createItem(decided, ALREADY_DECIDED_PUBLICATION_ADMISSION);
        order.push('hook');
      },
    });
    const producer = observe(
      client.runOperation(async () => {
        await Promise.all([
          f.store.createItem(item),
          f.store.persistTurnEvent(f.peer.id, {
            event: 'item.created',
            workspaceId: f.workspace.id,
            threadId: f.peer.threadId,
            turnId: f.peer.id,
            data: { type: 'item-created', item },
          }),
          f.store.updateTurn(f.peer.id, { agentProfileId: 'ordered-profile' }),
          f.store.updateTurn(f.peer.id, { status: 'completed', completedAt: f.peer.startedAt! }),
        ]);
        order.push('producer');
      })
    );
    let shutdown: Promise<unknown> | undefined;
    try {
      await Promise.race([
        entered.reached,
        producer.then((result) => {
          throw new Error(`Terminal producer settled before its hook: ${result.status}`);
        }),
      ]);
      shutdown = observe(
        client.shutdown().then(() => {
          order.push('shutdown');
        })
      );
      await nextTurn();
      expect(order).toEqual([]);
    } finally {
      release.release();
      await producer;
      if (shutdown) await shutdown;
      f.store.setTurnAdmissionHooks(null);
    }
    expect(await producer).toMatchObject({ status: 'ok' });
    expect(await shutdown).toMatchObject({ status: 'ok' });
    expect(order).toEqual(['hook', 'producer', 'shutdown']);
    const cold = new FsStore({ dataRoot: f.root });
    expect(cold.getTurnById(f.peer.id)).toMatchObject({
      status: 'completed',
      agentProfileId: 'ordered-profile',
      items: [item, decided],
    });
    expect(
      cold.getTurnEventsForExport(f.peer.id).map((event) => [event.sequence, event.event])
    ).toEqual([
      [1, 'item.created'],
      [2, 'turn.completed'],
    ]);
  });
  // DX admission and SOURCE-RETENTION: shutdown refuses new work and drains admitted producers.
  it('refuses an external terminal update during shutdown without a detached rejection', async () => {
    const f = await fixture();
    const client = getControlStoreWorkerClient();
    const release = barrier();
    const order: string[] = [];
    const producer = observe(
      client.runOperation(async () => {
        order.push('admitted');
        await release.reached;
        order.push('producer');
      })
    );
    await nextTurn();
    const shutdown = observe(
      client.shutdown().then(() => {
        order.push('shutdown');
      })
    );
    try {
      expect(order).toEqual(['admitted']);
      const refused = observe(
        f.store.updateTurn(f.peer.id, {
          status: 'completed',
          completedAt: f.peer.startedAt!,
        })
      );
      expect(await refused).toMatchObject({
        status: 'error',
        error: { code: 'unavailable', commit: 'not-committed' },
      });
      await nextTurn();
      expect(order).toEqual(['admitted']);
    } finally {
      release.release();
      await producer;
      await shutdown;
    }
    expect(await producer).toMatchObject({ status: 'ok' });
    expect(await shutdown).toMatchObject({ status: 'ok' });
    expect(order).toEqual(['admitted', 'producer', 'shutdown']);
    expect(new FsStore({ dataRoot: f.root }).getTurnById(f.peer.id).status).toBe(f.peer.status);
  });
  // Contract Evolution: descriptive additions cannot replace the closed-core Turn result.
  it('preserves a retained descriptive turn field while returning the updated actual Turn', async () => {
    const f = await fixture();
    const scope = nativeProductScope(f.root, f.peer.owner);
    const current = readNativeProduct(scope, 'turn', f.peer.id);
    const description = { annotation: 'retained' };
    expect(f.peer.agentSessionId ?? null).toBeNull();
    expect(current).toBeDefined();
    await getControlStoreWorkerClient().products(`workspace:${scope.path}`, {
      products: [
        {
          kind: 'turn',
          expectedRevision: current!.revision,
          record: writeRetainedV1({ ...current!.record, turn: description }),
        },
      ],
      entries: [],
    });
    expect(readNativeProduct(scope, 'turn', f.peer.id)?.record).toMatchObject({
      id: f.peer.id,
      turn: description,
    });
    const updated = await f.store.updateTurn(f.peer.id, { agentProfileId: 'retained-profile' });
    expect(updated).toMatchObject({ id: f.peer.id, agentProfileId: 'retained-profile' });
    expect(readNativeProduct(scope, 'turn', f.peer.id)?.record).toMatchObject({
      id: f.peer.id,
      agentProfileId: 'retained-profile',
      turn: description,
    });
    expect(new FsStore({ dataRoot: f.root }).getTurnById(f.peer.id)).toMatchObject({
      id: f.peer.id,
      agentProfileId: 'retained-profile',
    });
  });
});
