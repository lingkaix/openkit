import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { Worker as NativeWorker } from 'node:worker_threads';
import { allocateEntityId, type Item, ItemSchema, writeRetainedV1 } from '@openkit/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getArtifactReview } from '../artifact-reviews.js';
import { initializeDefaultKnowledgeBaseId } from '../config/knowledge-base.js';
import { dispatchOpenkitWorkTool } from '../runtime/openkit-work-mcp.js';
import type { WorkerArtifactCapture } from '../runtime/worker-governance-backend.js';
import { importWorkerTranscript } from '../runtime/worker-transcript.js';
import { FileStorageAdmission } from '../storage/artifacts/file-admission.js';
import { closeWorkspaceProductReadHandles } from '../storage/control-store-product-records.js';
import {
  ControlStoreWorkerError,
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from '../storage/control-store-worker-client.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { nativeProductScope, readNativeProduct } from '../storage/workspace-file-records.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { resolveAgentEnvironmentPackage } from '../test-support/prepared-agent-environment.js';
import { createTestStore } from '../test-support/store.js';
import {
  ALREADY_DECIDED_PUBLICATION_ADMISSION,
  DISPLAY_PROJECTION_REFRESH_ADMISSION,
  FsStore,
} from './store.js';

// Independent trusted-producer token; old createItem accepts the extra runtime argument without this feature.
const RETAINED_PROGRESS_PUBLICATION = 'progress' as const;

const transport = vi.hoisted(() => ({
  workers: [] as NativeWorker[],
  postedItemIds: [] as string[],
  postedItemRpcIds: new Map<number, string>(),
  beforeExit: undefined as undefined | ((worker: NativeWorker) => void),
  hold: undefined as
    | {
        operation: string;
        entered: () => void;
        deliver?: () => void;
        itemIds?: ReadonlySet<string>;
        worker?: NativeWorker;
      }
    | undefined,
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
      override postMessage(...args: Parameters<NativeWorker['postMessage']>): void {
        const request = args[0] as {
          id?: number;
          operation?: string;
          input?: { item?: { id?: string } };
        };
        if (request.operation === 'item' && request.input?.item?.id) {
          transport.postedItemIds.push(request.input.item.id);
          if (request.id !== undefined)
            transport.postedItemRpcIds.set(request.id, request.input.item.id);
        }
        super.postMessage(...args);
      }
      override emit(event: string | symbol, ...args: unknown[]): boolean {
        if (event === 'exit') transport.beforeExit?.(this);
        const reply = args[0],
          hold = transport.hold;
        if (
          event === 'message' &&
          hold &&
          !hold.deliver &&
          typeof reply === 'object' &&
          reply !== null &&
          'operation' in reply &&
          reply.operation === hold.operation &&
          (!hold.itemIds ||
            ('id' in reply &&
              typeof reply.id === 'number' &&
              hold.itemIds.has(transport.postedItemRpcIds.get(reply.id) ?? '')))
        ) {
          hold.worker = this;
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
function holdReply(operation: string, itemIds?: ReadonlySet<string>) {
  const { reached, release: entered } = barrier();
  const hold: NonNullable<typeof transport.hold> = {
    operation,
    entered,
    ...(itemIds ? { itemIds } : {}),
  };
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
  const environmentPackage = await resolveAgentEnvironmentPackage({
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
      loopbackDigests: [digest('a'.repeat(43)), digest('b'.repeat(43))],
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
  return { root, store, workspace, turn, peer, workspaceDb, submit, environmentPackage };
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
  transport.postedItemIds.length = 0;
  transport.postedItemRpcIds.clear();
  transport.beforeExit = undefined;
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
  it('preserves a committed Item prefix and healthy sibling while refusing a failed Item and its queued successor', async () => {
    const f = await fixture();
    const prefix = message(f.turn, 'Committed prefix');
    const failed = message(f.turn, 'Refused middle Item');
    const successor = message(f.turn, 'Must not survive its failed predecessor');
    const sibling = message(f.peer, 'Independent sibling');
    // Fault injection follows real public Workspace, Thread and Turn creation; no row is fabricated.
    f.workspaceDb.sqlite.exec(`CREATE TRIGGER refuse_middle_item BEFORE INSERT ON control_product_entries
      WHEN NEW.kind = 'item' AND NEW.id = '${failed.id}'
      BEGIN SELECT RAISE(ABORT, 'injected Item publication refusal'); END`);
    const gate = holdReply('item');
    const first = observe(f.store.createItem(prefix));
    let middle: typeof first | undefined;
    let last: typeof first | undefined;
    try {
      await gate.reached;
      middle = observe(f.store.createItem(failed));
      last = observe(f.store.createItem(successor));
      expect(await f.store.createItem(sibling)).toEqual(sibling);
      // A successor cannot reach its native publication before the covering predecessor ACK.
      expect(await beforeRelease(middle)).toBe('pending');
    } finally {
      gate.release();
      await first;
      if (middle) await middle;
      if (last) await last;
    }
    expect(await first).toEqual({ status: 'ok', value: prefix });
    expect(await middle!).toMatchObject({
      status: 'error',
      error: { code: 'constraint', commit: 'not-committed' },
    });
    expect(await last!).toMatchObject({ status: 'error', error: { commit: 'not-committed' } });
    expect(f.store.getTurnById(f.turn.id).items).toEqual([prefix]);
    expect(f.store.getTurnById(f.peer.id).items).toEqual([sibling]);
    f.workspaceDb.sqlite.exec('DROP TRIGGER refuse_middle_item');
    await shutdownControlStoreWorkerClient();
    f.workspaceDb.sqlite.close();
    closeWorkspaceProductReadHandles(f.root);
    const reopened = new FsStore({ dataRoot: f.root });
    expect(reopened.getTurnById(f.turn.id).items).toEqual([prefix]);
    expect(reopened.getTurnById(f.peer.id).items).toEqual([sibling]);
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
    const gate = holdReply('item');
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
    const gate = holdReply('item');
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

// Progress Durability Consent: progress may refuse first; durable final responses must not starve.
// The class is a trusted producer annotation, separate from the existing post-terminal category.
for (const pressure of [
  'same-Turn-count',
  'same-database-bytes',
  'nested-progress-bytes',
  'same-Turn-refused-predecessor',
  'same-Turn-later-byte-pressure',
  'same-Turn-unmarked-status',
] as const) {
  it(`retains ${pressure === 'same-Turn-unmarked-status' ? 'unmarked durable status' : 'the final transcript'} while eight explicit progress offers exert ${pressure} pressure`, async () => {
    const f = await fixture();
    const bytePressure = pressure === 'same-database-bytes';
    const nestedProgress = pressure === 'nested-progress-bytes';
    const refusedPredecessor = pressure === 'same-Turn-refused-predecessor';
    const laterBytePressure = pressure === 'same-Turn-later-byte-pressure';
    const unmarkedStatus = pressure === 'same-Turn-unmarked-status';
    const progressTurn = bytePressure || nestedProgress ? f.peer : f.turn;
    expect(f.store.getTurnById(f.turn.id).status).toBe('running');
    const stamp = new Date().toISOString();
    const progress = Array.from({ length: 8 }, (_, index) =>
      ItemSchema.parse({
        id: allocateEntityId('it'),
        owner: progressTurn.owner,
        threadId: progressTurn.threadId,
        turnId: progressTurn.id,
        type: 'status',
        level: 'info',
        title: 'Observed product progress',
        status: 'completed',
        createdAt: stamp,
        completedAt: stamp,
        summary: `${index}:${'p'.repeat((nestedProgress || refusedPredecessor) && index === 0 ? 30 * 1024 * 1024 : bytePressure && index === 0 ? 14 * 1024 * 1024 : 1024)}`,
      })
    );
    // 31 MiB is below the original immutable-body bound; both outer/inner clones must still fit 64 MiB.
    // The peer Turn prevents ordinary same-Turn FIFO from concealing database-wide byte starvation.
    const text =
      bytePressure || nestedProgress || refusedPredecessor || laterBytePressure
        ? 'Final durable response. '.repeat(
            Math.floor(((bytePressure ? 31 : 4) * 1024 * 1024) / 24)
          )
        : 'Exact final transcript response.';
    const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
    const payload = {
      credentialCheckValues: {
        sensitiveValues: [],
        loopbackDigests: [hash('a'.repeat(43)), hash('b'.repeat(43))] as [string, string],
        routeTokenHashes: {
          workerControl: hash(Buffer.alloc(32, 17)),
          inference: hash(Buffer.alloc(32, 34)),
          capability: hash(Buffer.alloc(32, 51)),
        },
      },
      itemsJsonl: JSON.stringify({
        schemaVersion: 1,
        kind: 'item',
        sequence: 1,
        lineage: {
          agentSessionId: f.environmentPackage.scope.agentSessionId,
          packageSnapshotId: f.environmentPackage.snapshotId,
          requestId: f.environmentPackage.scope.requestId,
          threadId: f.turn.threadId,
          turnId: f.turn.id,
          workspaceId: f.workspace.id,
        },
        item: { type: 'assistant-message', status: 'completed', text },
      }),
    };
    const client = getControlStoreWorkerClient();
    const state = client as unknown as {
      backing: Map<string, { inputBytes: number }>;
      progressCopyBytes?: Map<string, number>;
      outstanding: Map<string, number>;
      turnTails: Map<string, { pending: number }>;
      pending: Map<number, unknown>;
      pendingTurnPublications(key: string): number;
    };
    let peakBytes = 0,
      peakAggregateBytes = 0,
      peakCount = 0,
      peakTurn = 0,
      observations = 0,
      observerErrors = 0;
    const progressCopyBytes = state.progressCopyBytes ?? new Map<string, number>(); // Passive OLD observation: no future credit feature exists.
    const acceptedProgressBytes: number[] = [];
    const acceptedProgressIds = new Set<string>();
    const restore: Array<() => void> = [];
    const aggregate = (database: string) =>
      (state.backing.get(database)?.inputBytes ?? 0) + (progressCopyBytes.get(database) ?? 0);
    const sample = () => {
      try {
        observations++;
        peakBytes = Math.max(
          peakBytes,
          0,
          ...[...state.backing.values()].map((value) => value.inputBytes)
        );
        const databases = new Set([...state.backing.keys(), ...progressCopyBytes.keys()]);
        peakAggregateBytes = Math.max(peakAggregateBytes, 0, ...[...databases].map(aggregate));
        if (
          [...progressCopyBytes.values()].some((value) => !Number.isSafeInteger(value) || value < 0)
        )
          observerErrors++;
        peakCount = Math.max(peakCount, 0, ...state.outstanding.values());
        peakTurn = Math.max(
          peakTurn,
          0,
          ...[...state.turnTails.keys()].map((key) => state.pendingTurnPublications(key))
        );
      } catch {
        observerErrors++;
      }
    };
    const originalPublication = client.runTurnPublication;
    const publication = vi.spyOn(client, 'runTurnPublication').mockImplementation((...args) => {
      const before = state.outstanding.get(args[0]) ?? 0;
      const result = Reflect.apply(originalPublication, client, args);
      // Reservation and tail installation are synchronous before first preparation await.
      try {
        const preview = args[5];
        const owned = args[2] as unknown;
        const caller =
          Array.isArray(owned) && owned[2] === RETAINED_PROGRESS_PUBLICATION
            ? (owned[0] as Item)
            : undefined;
        const selected = preview
          ? preview.opening.database === args[0]
            ? preview.input.item
            : undefined
          : caller;
        if (
          selected?.turnId === progressTurn.id &&
          progress.some((item) => item.id === selected.id) &&
          (state.outstanding.get(args[0]) ?? 0) > before
        ) {
          acceptedProgressBytes.push(aggregate(args[0]));
          acceptedProgressIds.add(selected.id);
        }
      } catch {
        observerErrors++;
      }
      return result;
    });
    restore.push(() => publication.mockRestore());
    // Observe actual original accounting mutations, forwarding each exactly once; no admission/result override.
    for (const map of [
      state.backing,
      progressCopyBytes,
      state.outstanding,
      state.turnTails,
      state.pending,
    ]) {
      for (const method of ['set', 'delete'] as const) {
        const descriptor = Object.getOwnPropertyDescriptor(map, method);
        const original = map[method];
        Object.defineProperty(map, method, {
          configurable: true,
          writable: true,
          value: function (...args: unknown[]) {
            const result = Reflect.apply(original, this, args);
            sample();
            return result;
          },
        });
        restore.push(() => {
          if (descriptor) Object.defineProperty(map, method, descriptor);
          else Reflect.deleteProperty(map, method);
        });
      }
    }
    const durableStatus = { ...progress[0]!, id: allocateEntityId('it') };
    const gate = holdReply('item', new Set(progress.map((item) => item.id)));
    const offers = [
      observe(
        f.store.createItem(
          progress[0]!,
          DISPLAY_PROJECTION_REFRESH_ADMISSION,
          RETAINED_PROGRESS_PUBLICATION
        )
      ),
    ];
    const terminal = vi.spyOn(f.store, 'createItem');
    let final:
      | Promise<
          | { status: 'ok'; value: { diagnostics: unknown[]; itemIds: string[] } }
          | { status: 'error'; error: unknown }
        >
      | undefined;
    let calls: Array<Parameters<FsStore['createItem']>> = [];
    const laterDurable = laterBytePressure
      ? ItemSchema.parse({
          ...progress[0]!,
          id: allocateEntityId('it'),
          owner: f.peer.owner,
          threadId: f.peer.threadId,
          turnId: f.peer.id,
          summary: 'd'.repeat(Math.floor(27.25 * 1024 * 1024)),
        })
      : undefined;
    let competing:
      | Promise<{ status: 'ok'; value: Item } | { status: 'error'; error: unknown }>
      | undefined;
    try {
      if (refusedPredecessor || laterBytePressure) {
        // Offer both genuine caller continuations before the progress inner-copy refusal can settle.
        for (const item of progress.slice(1))
          offers.push(
            observe(
              f.store.createItem(
                item,
                DISPLAY_PROJECTION_REFRESH_ADMISSION,
                RETAINED_PROGRESS_PUBLICATION
              )
            )
          );
        final = observe(
          importWorkerTranscript(f.store, f.environmentPackage, payload, { recordedAt: stamp })
        );
        if (laterBytePressure) competing = observe(f.store.createItem(laterDurable!));
        const entered = await Promise.race([
          gate.reached.then(() => ({ status: 'held' as const })),
          final,
        ]);
        if (entered.status === 'held') expect(await beforeRelease(final)).toBe('pending');
        else
          expect(entered).toMatchObject({
            status: 'ok',
            value: { diagnostics: [], itemIds: [expect.any(String)] },
          });
      } else {
        const first = await Promise.race([
          gate.reached.then(() => ({ status: 'held' as const })),
          offers[0]!,
        ]);
        const held = first.status === 'held';
        if (nestedProgress) {
          expect(first).toMatchObject({
            status: 'error',
            error: { code: 'busy', commit: 'not-committed' },
          });
          expect(transport.postedItemIds).not.toContain(progress[0]!.id);
        }
        if (!held) {
          // Oversized progress may be the first explicit resource refusal; it never grants a loss window.
          expect(nestedProgress).toBe(true);
          expect(first).toMatchObject({
            status: 'error',
            error: { code: 'busy', commit: 'not-committed' },
          });
          gate.release();
        }
        for (const item of progress.slice(1))
          offers.push(
            observe(
              f.store.createItem(
                item,
                DISPLAY_PROJECTION_REFRESH_ADMISSION,
                RETAINED_PROGRESS_PUBLICATION
              )
            )
          );
        final = observe(
          unmarkedStatus
            ? f.store
                .createItem(durableStatus, DISPLAY_PROJECTION_REFRESH_ADMISSION)
                .then((item) => ({ diagnostics: [], itemIds: [item.id] }))
            : importWorkerTranscript(f.store, f.environmentPackage, payload, { recordedAt: stamp })
        );
        // A genuine predecessor ACK is held; admission success cannot become an early durable ACK.
        if (held) {
          // Deciding OLD criterion first: the original real transcript must admit, not refuse busy.
          expect(await beforeRelease(final)).toBe('pending');
        }
        // All eight caller offers remain genuine; refusal is explicit, definite and has no retained Item.
        const excess = await beforeRelease(offers[held ? 7 : 0]!);
        expect(excess).toMatchObject({
          status: 'error',
          error: { code: 'busy', commit: 'not-committed' },
        });
        if (excess === 'pending' || excess.status !== 'error')
          throw new Error('Excess progress did not refuse explicitly.');
        expect(excess.error).toBeInstanceOf(ControlStoreWorkerError);
      }
    } finally {
      gate.release();
      await Promise.all(offers);
      await final;
      await competing;
      calls = terminal.mock.calls
        .filter(([item]) =>
          unmarkedStatus ? item.id === durableStatus.id : item.type === 'assistant-message'
        )
        .map((args) => [...args]);
      terminal.mockRestore();
      for (const reset of restore.reverse()) reset();
    }
    const results = await Promise.all(offers);
    if (refusedPredecessor) {
      expect(results[0]).toMatchObject({
        status: 'error',
        error: { code: 'busy', commit: 'not-committed' },
      });
      expect(transport.postedItemIds).not.toContain(progress[0]!.id);
    }
    expect(results).toHaveLength(8);
    const admitted = progress.filter((_, index) => results[index]!.status === 'ok');
    const refused = progress.filter((_, index) => results[index]!.status === 'error');
    if (!laterBytePressure) expect(admitted.length).toBeGreaterThan(0);
    expect(refused.length).toBeGreaterThan(0);
    expect([...acceptedProgressIds].sort()).toEqual(admitted.map((item) => item.id).sort());
    for (const [index, result] of results.entries()) {
      if (result.status === 'ok') expect(result.value).toEqual(progress[index]);
      else {
        expect(acceptedProgressIds.has(progress[index]!.id)).toBe(false);
        expect(transport.postedItemIds).not.toContain(progress[index]!.id);
        expect(result.error).toBeInstanceOf(ControlStoreWorkerError);
        expect(result.error).toMatchObject({ code: 'busy', commit: 'not-committed' });
      }
    }
    expect(await final).toMatchObject({
      status: 'ok',
      value: { diagnostics: [], itemIds: [expect.any(String)] },
    });
    const outcome = await final!;
    if (outcome.status !== 'ok') throw new Error('The original final transcript failed.');
    expect(calls).toHaveLength(1); // No hidden owner retry substitutes for guaranteed admission.
    expect(calls[0]![1]).toEqual(
      unmarkedStatus ? DISPLAY_PROJECTION_REFRESH_ADMISSION : ALREADY_DECIDED_PUBLICATION_ADMISSION
    );
    expect(calls[0]![2]).toBeUndefined(); // Generic status/terminal category must not imply progress.
    if (laterBytePressure) expect(await competing).toEqual({ status: 'ok', value: laterDurable });
    expect(state.progressCopyBytes).toBeInstanceOf(Map);
    expect(observations).toBeGreaterThan(0);
    expect(observerErrors).toBe(0);
    expect(acceptedProgressBytes.length).toBeGreaterThan(0);
    expect(acceptedProgressBytes.every((bytes) => bytes <= 31 * 1024 * 1024)).toBe(true);
    expect(peakAggregateBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
    expect([...progressCopyBytes.values()].every((bytes) => bytes === 0)).toBe(true);
    expect(peakBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
    expect(peakCount).toBeLessThanOrEqual(1024);
    expect(peakTurn).toBeLessThanOrEqual(8);
    const expected = f.store.getTurnById(f.turn.id).items;
    if (unmarkedStatus)
      expect(expected.find((item) => item.id === durableStatus.id)).toEqual(durableStatus);
    else
      expect(expected.filter((item) => item.type === 'assistant-message')).toEqual([
        expect.objectContaining({ id: outcome.value.itemIds[0], type: 'assistant-message', text }),
      ]);
    expect(
      f.store
        .getTurnById(progressTurn.id)
        .items.filter((item) => progress.some((selected) => selected.id === item.id))
    ).toEqual(admitted);
    for (const item of refused)
      expect(
        f.store.getTurnById(progressTurn.id).items.some((retained) => retained.id === item.id)
      ).toBe(false);
    await shutdownControlStoreWorkerClient();
    closeWorkspaceProductReadHandles(f.root);
    const cold = new FsStore({ dataRoot: f.root });
    expect(cold.getTurnById(f.turn.id).items).toEqual(expected);
    if (laterBytePressure) expect(cold.getTurnById(f.peer.id).items).toEqual([laterDurable]);
    expect(
      cold
        .getTurnById(progressTurn.id)
        .items.filter((item) => progress.some((selected) => selected.id === item.id))
    ).toEqual(admitted);
  });
}

it('does not wait for progress queued behind its own durable predecessor under cross-Turn byte pressure', async () => {
  // A genuinely cyclic candidate cannot drain via shutdown. Isolate only this finite owner scenario
  // in a child; on test failure terminate/join only that child before removing its private root.
  const root = mkdtempSync(join(tmpdir(), 'durable-progress-cycle-'));
  const script = `
    import { createRequire } from 'node:module';
    import { Worker } from 'node:worker_threads';
    const { FsStore } = await import(${JSON.stringify(new URL('../../dist/lib/store.js', import.meta.url).href)});
    const RETAINED_PROGRESS_PUBLICATION = 'progress';
    const { openCoreDb } = await import(${JSON.stringify(new URL('../../dist/storage/db.js', import.meta.url).href)});
    const { applyMigrations } = await import(${JSON.stringify(new URL('../../dist/storage/migrate.js', import.meta.url).href)});
    const { shutdownControlStoreWorkerClient } = await import(${JSON.stringify(new URL('../../dist/storage/control-store-worker-client.js', import.meta.url).href)});
    const { closeWorkspaceProductReadHandles } = await import(${JSON.stringify(new URL('../../dist/storage/control-store-product-records.js', import.meta.url).href)});
    const { allocateEntityId, ItemSchema } = createRequire(${JSON.stringify(new URL('../../package.json', import.meta.url).href)})('@openkit/protocol');
    const root = ${JSON.stringify(root)};
    const db = openCoreDb(root); applyMigrations(db); db.sqlite.close();
    const store = new FsStore({ dataRoot: root });
    const workspace = await store.createWorkspace('Dependency-safe byte reservation');
    const turns = [];
    for (const name of ['Native predecessor', 'Durable then progress', 'Large durable']) {
      const thread = await store.createThread(workspace.id, name);
      turns.push(await store.createTurn(workspace.id, thread.id, name,
        { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' }));
    }
    const status = (turn, bytes, title) => ItemSchema.parse({
      id: allocateEntityId('it'), owner: turn.owner, threadId: turn.threadId, turnId: turn.id,
      type: 'status', level: 'info', status: 'completed', title, summary: 'd'.repeat(bytes),
      createdAt: turn.startedAt, completedAt: turn.startedAt,
    });
    const p0 = status(turns[0], 8 * 1024 * 1024, 'Actual held progress');
    const d1 = status(turns[1], 14 * 1024 * 1024, 'Unmarked durable status');
    const p1 = status(turns[1], 1024, 'Actual later progress');
    const d2 = status(turns[2], 31 * 1024 * 1024, 'Unmarked large durable status');
    const originalPost = Worker.prototype.postMessage, originalEmit = Worker.prototype.emit;
    let selected, release;
    let entered;
    const held = new Promise(resolve => { entered = resolve; });
    Worker.prototype.postMessage = function (...args) {
      const request = args[0];
      if (request?.operation === 'item' && request.input.item.id === p0.id) selected = request.id;
      return Reflect.apply(originalPost, this, args);
    };
    Worker.prototype.emit = function (event, ...args) {
      const reply = args[0];
      if (event === 'message' && reply?.id === selected && reply.operation === 'item' && reply.status === 'ok') {
        release = () => Reflect.apply(originalEmit, this, [event, ...args]);
        entered(); return true;
      }
      return Reflect.apply(originalEmit, this, [event, ...args]);
    };
    const observe = promise => promise.then(value => ({ status: 'ok', value }),
      error => ({ status: 'error', code: error.code, commit: error.commit }));
    const first = observe(store.createItem(p0, undefined, RETAINED_PROGRESS_PUBLICATION));
    await held;
    // No await between these three authentic caller admissions: later large input is owned before D1 prepares.
    const middle = observe(store.createItem(d1));
    const laterProgress = observe(store.createItem(p1, undefined, RETAINED_PROGRESS_PUBLICATION));
    const large = observe(store.createItem(d2));
    process.send({ phase: 'three-public-offers-after-real-progress-ACK' });
    // Later progress must refuse BEFORE it can become a byte-drain dependency of its predecessor.
    const beforeRelease = await Promise.race([laterProgress, new Promise(resolve => setImmediate(() => resolve({ status: 'pending' })))]);
    if (beforeRelease.status !== 'error' || beforeRelease.code !== 'busy' || beforeRelease.commit !== 'not-committed') throw new Error('Later progress was admitted behind an unsettled durable predecessor');
    release();
    const results = await Promise.all([first, middle, laterProgress, large]);
    for (const [index, item] of [p0, d1].entries()) {
      if (results[index].status !== 'ok' || JSON.stringify(results[index].value) !== JSON.stringify(item)) throw new Error('Original progress/durable ACK or bytes changed');
    }
    // These two durable copies contend with each other under the ORIGINAL64MiB bound; no new queue is authorized.
    if (results[3].status !== 'error' || results[3].code !== 'busy' || results[3].commit !== 'not-committed') throw new Error('Original durable-vs-durable bounded refusal changed');
    const expected = turns.map(turn => store.getTurnById(turn.id).items);
    if (JSON.stringify(expected) !== JSON.stringify([[p0], [d1], []])) throw new Error('Refused progress/durable input acquired retained authority');
    await shutdownControlStoreWorkerClient(); closeWorkspaceProductReadHandles(root);
    const cold = new FsStore({ dataRoot: root });
    if (JSON.stringify(turns.map(turn => cold.getTurnById(turn.id).items)) !== JSON.stringify(expected)) throw new Error('Cold retained tuple changed');
    process.send({ phase: 'all-ACKed-and-cold-exact', count: 2 });
    await shutdownControlStoreWorkerClient();
    process.disconnect();
  `;
  const scriptPath = join(root, 'durable-progress-cycle.mjs');
  writeFileSync(scriptPath, script);
  // File Workers inherit execArgv; an eval parent's --input-type would reject the genuine native file entry.
  const child = spawn(process.execPath, [scriptPath], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let armed = false,
    finished = false,
    stderr = '';
  child.stderr!.setEncoding('utf8');
  child.stderr!.on('data', (chunk) => {
    stderr += chunk;
  });
  child.on('message', (message) => {
    if (typeof message !== 'object' || message === null) return;
    if ('phase' in message && message.phase === 'three-public-offers-after-real-progress-ACK')
      armed = true;
    if (
      'phase' in message &&
      message.phase === 'all-ACKed-and-cold-exact' &&
      'count' in message &&
      message.count === 2
    )
      finished = true;
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<'deadline'>((resolve) => {
      timer = setTimeout(() => resolve('deadline'), 20_000);
    });
    const exit = await Promise.race([exited, deadline]);
    expect(armed, stderr).toBe(true);
    expect(exit, stderr).toBe(0);
    expect(finished, stderr).toBe(true);
  } finally {
    if (timer) clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
    rmSync(root, { recursive: true, force: true });
  }
});

it('releases only unallocated progress booking after a genuine lost Item ACK and retains the original unknown outcome', async () => {
  const f = await fixture();
  const stamp = new Date().toISOString();
  const item = ItemSchema.parse({
    id: allocateEntityId('it'),
    owner: f.turn.owner,
    threadId: f.turn.threadId,
    turnId: f.turn.id,
    type: 'status',
    level: 'info',
    title: 'Genuine progress before host loss',
    summary: 'p'.repeat(1024),
    status: 'completed',
    createdAt: stamp,
    completedAt: stamp,
  });
  const database = `workspace:${join(f.root, 'workspaces', f.workspace.id, 'db', 'workspace.sqlite')}`;
  const client = getControlStoreWorkerClient();
  const state = client as unknown as {
    backing: Map<string, { inputBytes: number }>;
    progressCopyBytes?: Map<string, number>;
  };
  const gate = holdReply('item', new Set([item.id]));
  const original = observe(
    f.store.createItem(item, DISPLAY_PROJECTION_REFRESH_ADMISSION, RETAINED_PROGRESS_PUBLICATION)
  );
  let settled = false;
  void original.then(() => {
    settled = true;
  });
  const exitSnapshots: Array<{ inputBytes: number; settled: boolean }> = [];
  let observationErrors = 0;
  try {
    await Promise.race([
      gate.reached,
      original.then(() => {
        throw new Error('Actual progress Item ACK was not held');
      }),
    ]);
    const worker = transport.hold!.worker;
    expect(worker).toBeDefined();
    expect(state.progressCopyBytes).toBeInstanceOf(Map);
    expect(transport.postedItemIds.filter((id) => id === item.id)).toHaveLength(1);
    transport.beforeExit = (current) => {
      if (current !== worker) return;
      try {
        exitSnapshots.push({ inputBytes: state.backing.get(database)?.inputBytes ?? 0, settled });
      } catch {
        observationErrors++;
      }
    };
    // Only the original real post-COMMIT reply is lost; the original native host actually exits.
    await worker!.terminate();
    gate.release(false);
    const result = await original;
    expect(result).toMatchObject({
      status: 'error',
      error: { code: 'unavailable', commit: 'unknown' },
    });
    if (result.status !== 'error') throw new Error('Lost original ACK must remain unknown.');
    expect(result.error).toBeInstanceOf(ControlStoreWorkerError);
    expect(observationErrors).toBe(0);
    expect(exitSnapshots).toHaveLength(1);
    expect(exitSnapshots[0]!.settled).toBe(false);
    expect(exitSnapshots[0]!.inputBytes).toBeGreaterThan(0); // Actual request backing survived until real exit processing.
    expect(state.backing.get(database)?.inputBytes ?? 0).toBe(0);
    expect([...state.progressCopyBytes!.values()].every((bytes) => bytes === 0)).toBe(true);
    const dependent = message(f.turn, 'No automatic writer replacement');
    expect(await observe(f.store.createItem(dependent))).toMatchObject({
      status: 'error',
      error: { code: 'unavailable', commit: 'not-committed' },
    });
    expect(transport.postedItemIds.filter((id) => id === item.id)).toHaveLength(1);
    expect(transport.postedItemIds).not.toContain(dependent.id);
    await shutdownControlStoreWorkerClient();
    closeWorkspaceProductReadHandles(f.root);
    expect(new FsStore({ dataRoot: f.root }).getTurnById(f.turn.id).items).toEqual([item]);
  } finally {
    gate.release(false);
    transport.beforeExit = undefined;
    await original;
  }
});
