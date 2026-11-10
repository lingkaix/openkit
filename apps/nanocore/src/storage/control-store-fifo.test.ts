// openkit-test-platform: posix
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { Worker } from 'node:worker_threads';
import { allocateEntityId, ItemSchema, type TurnSchema, writeRetainedV1 } from '@openkit/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArtifactReviewError, type ControlReviewCommandInput } from '../artifact-review-codecs.js';
import { executeControlReviewCommand, getArtifactReview } from '../artifact-reviews.js';
import { initializeDefaultKnowledgeBaseId } from '../config/knowledge-base.js';
import {
  createRuntimeConfigManager,
  diffRuntimeConfig,
  loadRuntimeConfig,
} from '../config/runtime-config.js';
import { EMPTY_POLICY_DOCUMENT, policyDigest } from '../policy/statements.js';
import { closeRetrievalServices } from '../retrieval-service.js';
import { dispatchOpenkitWorkTool } from '../runtime/openkit-work-mcp.js';
import type { WorkerArtifactCapture } from '../runtime/worker-governance-backend.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { resolveAgentEnvironmentPackage } from '../test-support/prepared-agent-environment.js';
import { createTestStore } from '../test-support/store.js';
import { FileStorageAdmission } from './artifacts/file-admission.js';
import { artifactFilePayloadPath } from './artifacts/file-records.js';
import type { ControlProductTransition } from './control-store-product-records.js';
import {
  type ControlProductEntry,
  type ControlStoreProductReadHandle,
  openControlStoreProductReadHandle,
} from './control-store-product-records.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './control-store-worker-client.js';
import { openCoreDb, openWorkspaceDb } from './db.js';
import { prepareImmutableProductJson } from './immutable-content.js';
import {
  type RuntimePolicyPublicationInput,
  type RuntimePolicyPublicationResult,
  RuntimePolicyPublicationResultSchema,
} from './runtime-policy-publication.js';
import { appendWorkObservation } from './work-observations.js';
import { nativeProductScope, readNativeProductEntries } from './workspace-file-records.js';

const interception = vi.hoisted(() => ({
  shared: undefined as SharedArrayBuffer | undefined,
  source: '',
}));

// Only native file barriers and COMMIT are gated; entry, transport and replies stay real.
vi.mock('node:worker_threads', async (load) => {
  const actual = await load<typeof import('node:worker_threads')>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(filename: string | URL, options?: import('node:worker_threads').WorkerOptions) {
        if (!interception.shared) {
          super(filename, options);
          return;
        }
        const prelude = `(${interception.source})(require,
          require('node:worker_threads').workerData.fifoTrace,
          require('node:worker_threads').workerData.databaseModule);`;
        const entry = options?.eval
          ? String(filename)
          : `import(${JSON.stringify(String(filename))});`;
        super(prelude + entry, {
          ...options,
          eval: true,
          workerData: {
            ...options?.workerData,
            fifoTrace: interception.shared,
            databaseModule: createRequire(import.meta.url).resolve('better-sqlite3'),
          },
        });
      }
    },
  };
});

/** Wraps actual async file synchronization and actual SQL without replacing their results. */
function installObservation(
  require: NodeRequire,
  shared: SharedArrayBuffer,
  databaseModule: string
) {
  const state = new Int32Array(shared, 0, 16);
  const bytes = new Uint8Array(shared, 128);
  const fs = require('node:fs/promises') as typeof import('node:fs/promises');
  const open = fs.open;
  /** Shared fixed slots preserve observations from separate real Workspace workers. */
  function record(row: unknown[]) {
    if (!Atomics.load(state, 0)) return;
    const at = Atomics.add(state, 1, 1) * 512;
    const value = Buffer.from(JSON.stringify(row));
    if (value.length >= 512 || at + 512 > bytes.length) {
      Atomics.store(state, 2, 1);
      return;
    }
    bytes.set(value, at);
    bytes[at + value.length] = 0;
  }
  fs.open = (async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    let tracked = Boolean(Atomics.load(state, 0)) && (await handle.stat()).isFile();
    if (tracked) Atomics.add(state, 10, 1);
    const close = handle.close.bind(handle);
    handle.close = async () => {
      try {
        return await close();
      } finally {
        if (tracked) {
          tracked = false;
          Atomics.sub(state, 10, 1);
          record(['file-closed', String(args[0])]);
        }
      }
    };
    for (const name of ['sync', 'datasync'] as const) {
      const synchronize = handle[name].bind(handle);
      handle[name] = async () => {
        const target = Buffer.from(shared, 64, 64).toString();
        if (
          Atomics.load(state, 0) &&
          String(args[0]).includes(target) &&
          Atomics.compareExchange(state, 3, 0, 1) === 0
        ) {
          record(['file-held']);
          await Atomics.waitAsync(state, 4, 0).value;
          if (Atomics.load(state, 5)) {
            record(['file-failed']);
            throw new Error('Injected native file synchronization failure');
          }
        }
        await synchronize();
      };
    }
    return handle;
  }) as typeof fs.open;
  require('node:module').syncBuiltinESMExports();
  const Database = require(databaseModule);
  const execute = Database.prototype.exec;
  Database.prototype.exec = function (
    this: { pragma(sql: string, options: { simple: boolean }): number },
    sql: string
  ) {
    if (/^COMMIT$/i.test(sql) && Atomics.load(state, 0)) {
      record(['commit-before', this.pragma('synchronous', { simple: true })]);
      if (Atomics.load(state, 6) && Atomics.compareExchange(state, 7, 0, 1) === 0)
        Atomics.wait(state, 8, 0);
    }
    const result = execute.call(this, sql);
    if (/^COMMIT$/i.test(sql)) {
      record(['commit-after']);
      // A real completed FULL COMMIT followed by a lost result has unknown caller certainty.
      if (Atomics.compareExchange(state, 9, 1, 0) === 1) {
        record(['commit-result-lost']);
        throw new Error('Injected failure after actual outer COMMIT');
      }
    }
    if (/^ROLLBACK TO\b/i.test(sql)) record(['item-rollback']);
    return result;
  };
}

type Lane = {
  turn: ReturnType<typeof TurnSchema.parse>;
  scope: ReturnType<typeof nativeProductScope>;
  database: string;
  reader: ControlStoreProductReadHandle;
};
const roots: string[] = [];
const readers: ControlStoreProductReadHandle[] = [];
const actor = { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' } as const;

/** Releases every real native wait even when an assertion or qualification fails. */
function release(index: 4 | 8) {
  if (!interception.shared) return;
  const state = new Int32Array(interception.shared, 0, 16);
  Atomics.store(state, index, 1);
  Atomics.notify(state, index);
}

afterEach(async () => {
  release(4);
  release(8);
  await shutdownControlStoreWorkerClient();
  for (const reader of readers.splice(0)) reader.close();
  interception.shared = undefined;
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Shared Store setup produces valid Workspaces, Threads and Turns before fault admission. */
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'native-fifo-'));
  roots.push(root);
  const shared = new SharedArrayBuffer(128 + 512 * 512);
  interception.shared = shared;
  interception.source = installObservation.toString();
  const state = new Int32Array(shared, 0, 16);
  const store = createTestStore({ dataRoot: root });
  const workspace = await store.createWorkspace('FIFO');
  const other = await store.createWorkspace('Independent scope');
  const client = getControlStoreWorkerClient();
  const lanes: Lane[] = [];
  for (const workspaceId of [workspace.id, workspace.id, other.id]) {
    const thread = await store.createThread(workspaceId, 'Independent Turn');
    const turn = await store.createTurn(workspaceId, thread.id, 'Input', actor);
    const scope = nativeProductScope(root, turn.owner);
    const database = `workspace:${scope.path}`;
    await client.open({
      database,
      path: scope.path,
      dataRoot: root,
      create: false,
      initialize: 'workspace',
      productOwner: scope.owner,
      contentMount: scope.contentMount,
    });
    const reader = openControlStoreProductReadHandle(scope.path, scope.owner);
    readers.push(reader);
    expect(reader.entries(turn.id, 'item')).toEqual([]);
    lanes.push({ turn, scope, database, reader });
  }
  /** Builds a public native request, not a stored row or a fabricated successful receipt. */
  async function entry(
    lane: Lane,
    sequence: number,
    original?: { item: ReturnType<typeof ItemSchema.parse> }
  ) {
    const item = ItemSchema.parse({
      ...(original?.item ?? {
        id: allocateEntityId('it'),
        owner: lane.turn.owner,
        threadId: lane.turn.threadId,
        turnId: lane.turn.id,
        type: 'assistant-message',
        status: 'completed',
        createdAt: lane.turn.startedAt!,
        completedAt: lane.turn.startedAt!,
      }),
      // Store terminal publication must retain this real native file-sync subject.
      text: `Exact FIFO body ${sequence}`.padEnd(70_000, '.'),
    });
    const prepared = await prepareImmutableProductJson(
      lane.scope.contentMount,
      lane.scope.owner,
      join(dirname(dirname(lane.scope.path)), 'runtime', 'staging'),
      writeRetainedV1(item)
    );
    return {
      item,
      input: {
        kind: 'item',
        turnId: lane.turn.id,
        sequence,
        expectedRevision: 0,
        ...prepared,
      } satisfies ControlProductEntry,
    };
  }
  return {
    root,
    store,
    client,
    lanes,
    state,
    entry,
    arm(input: ControlProductEntry, fail = false) {
      new Uint8Array(shared, 64, 64).set(
        Buffer.from(input.content.reference.contentDigest.slice(7))
      );
      Atomics.store(state, 5, Number(fail));
      Atomics.store(state, 0, 1);
    },
    wait(index: 3 | 7) {
      return vi.waitFor(() => expect(Atomics.load(state, index)).toBe(1), { timeout: 3000 });
    },
    send(lane: Lane, entries: ControlProductEntry[], acknowledged: () => void = () => {}) {
      const input: ControlProductTransition = { products: [], entries };
      return client.products(lane.database, input).then(
        () => {
          acknowledged();
          return { ok: true as const };
        },
        (error: unknown) => ({ ok: false as const, error })
      );
    },
    trace() {
      expect(Atomics.load(state, 2)).toBe(0);
      const bytes = new Uint8Array(shared, 128);
      return Array.from({ length: Atomics.load(state, 1) }, (_, index) => {
        const slot = bytes.subarray(index * 512, (index + 1) * 512);
        return JSON.parse(Buffer.from(slot.subarray(0, slot.indexOf(0))).toString()) as unknown[];
      });
    },
  };
}

describe('natural native same-Turn FIFO', () => {
  it('keeps delayed and queued Items ordered and invisible until FULL acknowledgement', async () => {
    const f = await fixture();
    const [lane, sibling, scope] = f.lanes as [Lane, Lane, Lane];
    const [one, two, three, independent, remote] = await Promise.all([
      f.entry(lane, 1),
      f.entry(lane, 2),
      f.entry(lane, 3),
      f.entry(sibling, 1),
      f.entry(scope, 1),
    ]);
    const acknowledgements: number[] = [];
    f.arm(one.input);
    const first = f.send(lane, [one.input], () => acknowledgements.push(1));
    await f.wait(3);
    const second = f.send(lane, [two.input], () => acknowledgements.push(2));
    const third = f.send(lane, [three.input], () => acknowledgements.push(3));
    // DX: independent Turns/scopes do not inherit this Turn's blocked file preparation.
    expect(await f.send(sibling, [independent.input])).toEqual({ ok: true });
    expect(await f.send(scope, [remote.input])).toEqual({ ok: true });
    expect(acknowledgements).toEqual([]);
    expect(lane.reader.entries(lane.turn.id, 'item')).toEqual([]);
    Atomics.store(f.state, 6, 1);
    release(4);
    await f.wait(7);
    // DX: queued is not visible or durably accepted; every ACK follows outer FULL COMMIT.
    expect(acknowledgements).toEqual([]);
    expect(lane.reader.entries(lane.turn.id, 'item')).toEqual([]);
    release(8);
    expect(await Promise.all([first, second, third])).toEqual([
      { ok: true },
      { ok: true },
      { ok: true },
    ]);
    expect(acknowledgements).toEqual([1, 2, 3]);
    expect(
      lane.reader.entries(lane.turn.id, 'item').map(({ id, sequence }) => [id, sequence])
    ).toEqual([
      [one.item.id, 1],
      [two.item.id, 2],
      [three.item.id, 3],
    ]);
    const commits = f.trace().filter(([phase]) => phase === 'commit-before');
    expect(commits.length).toBeGreaterThan(0);
    expect(commits.every(([, synchronous]) => synchronous === 2)).toBe(true);
  });

  it.each(['preparation', 'revision'] as const)(
    'refuses applicable queued successors after %s failure and preserves independent work',
    async (failure) => {
      const f = await fixture();
      const [lane, sibling, scope] = f.lanes as [Lane, Lane, Lane];
      const accepted = await f.entry(lane, 1);
      expect(await f.send(lane, [accepted.input])).toEqual({ ok: true });
      const before = lane.reader.entries(lane.turn.id, 'item');
      const retainedBefore = readNativeProductEntries(lane.scope, lane.turn.id, 'item');
      const [partial, stale, successor, independent, remote] = await Promise.all([
        f.entry(lane, 2),
        f.entry(lane, 3, accepted),
        f.entry(lane, 2),
        f.entry(sibling, 1),
        f.entry(scope, 1),
      ]);
      f.arm(partial.input, failure === 'preparation');
      // The second entry has a stale revision for the accepted Item; the first entry is valid.
      // The SQL failure must not rebase the stale request or retain partial rows.
      const failed = f.send(
        lane,
        failure === 'revision' ? [partial.input, stale.input] : [partial.input]
      );
      await f.wait(3);
      const queued = f.send(lane, [successor.input]);
      expect(await f.send(sibling, [independent.input])).toEqual({ ok: true });
      expect(await f.send(scope, [remote.input])).toEqual({ ok: true });
      release(4);
      expect(await failed).toMatchObject({ ok: false, error: { commit: 'not-committed' } });
      // Sequence two would apply after rollback. Its refusal must come from its failed Turn prefix.
      expect(await queued).toMatchObject({ ok: false, error: { commit: 'not-committed' } });
      expect(lane.reader.entries(lane.turn.id, 'item')).toEqual(before);
      expect(sibling.reader.entries(sibling.turn.id, 'item').map(({ id }) => id)).toEqual([
        independent.item.id,
      ]);
      expect(scope.reader.entries(scope.turn.id, 'item').map(({ id }) => id)).toEqual([
        remote.item.id,
      ]);
      expect(
        f
          .trace()
          .some(
            ([phase]) => phase === (failure === 'preparation' ? 'file-failed' : 'item-rollback')
          )
      ).toBe(true);
      await shutdownControlStoreWorkerClient();
      expect(readNativeProductEntries(lane.scope, lane.turn.id, 'item')).toEqual(retainedBefore);
      expect(createTestStore({ dataRoot: f.root }).getTurnById(lane.turn.id).items).toEqual([
        accepted.item,
      ]);
    }
  );
});

/** Records both successful and refused public responses without leaving a rejection unobserved. */
function observe<T>(promise: Promise<T>, settled: () => void) {
  return promise.then(
    (value) => {
      settled();
      return { ok: true as const, value };
    },
    (error: unknown) => {
      settled();
      return { ok: false as const, error };
    }
  );
}

/** The real Pending owner validates this Turn and generates an empty, receipt-free native tuple. */
function releasePending(f: Awaited<ReturnType<typeof fixture>>, lane: Lane) {
  if (lane.turn.owner.kind !== 'workspace') throw new Error('Workspace Turn required.');
  return f.store.applyPendingRequestCommand(lane.turn.owner.workspaceId, {
    action: 'delivery-release',
    workspaceId: lane.turn.owner.workspaceId,
    turnId: lane.turn.id,
    now: lane.turn.startedAt!,
  });
}

describe('native FIFO dependency and poisoned-drain crossings', () => {
  it.each([false, true])(
    'orders owner-generated empty Pending work behind an Item (failure=%s)',
    async (fail) => {
      const f = await fixture();
      const [lane, sibling] = f.lanes as [Lane, Lane, Lane];
      const [item, independent] = await Promise.all([f.entry(lane, 1), f.entry(sibling, 1)]);
      const responses: string[] = [];
      const posted = vi.spyOn(f.client, 'pendingCommand');
      f.arm(item.input, fail);
      const first = f.send(lane, [item.input]).then((result) => {
        responses.push('item');
        return result;
      });
      await f.wait(3);
      const pending = observe(releasePending(f, lane), () => responses.push('pending'));
      expect(await f.send(sibling, [independent.input])).toEqual({ ok: true });
      await vi.waitFor(() => expect(posted).toHaveBeenCalled(), { timeout: 3000 });
      expect(posted.mock.calls[0]![1]).toMatchObject({ products: [], entries: [], receipt: null });
      // DX: a valid empty native tuple still acts on its named Turn and cannot pass its causal prefix.
      expect(responses).toEqual([]);
      release(4);
      expect(await first).toMatchObject({ ok: !fail });
      expect(await pending).toMatchObject(
        fail ? { ok: false, error: { commit: 'not-committed' } } : { ok: true }
      );
      expect(responses).toEqual(['item', 'pending']);
      expect(lane.reader.entries(lane.turn.id, 'item').map(({ id }) => id)).toEqual(
        fail ? [] : [item.item.id]
      );
    }
  );

  it('keeps poisoned refusals in Turn order until started native files drain', async () => {
    const f = await fixture();
    const [lane, sibling] = f.lanes as [Lane, Lane, Lane];
    const [item, independent] = await Promise.all([f.entry(lane, 1), f.entry(sibling, 1)]);
    const responses: string[] = [];
    f.arm(item.input);
    const first = f.send(lane, [item.input]).then((result) => {
      responses.push('A');
      return result;
    });
    await f.wait(3);
    const posted = vi.spyOn(f.client, 'products');
    const second = observe(f.store.updateTurn(lane.turn.id, { status: 'running' }), () =>
      responses.push('B')
    );
    await vi.waitFor(() => expect(posted).toHaveBeenCalled(), { timeout: 3000 });
    expect(posted.mock.calls[0]![1]).toMatchObject({
      entries: [],
      products: [{ kind: 'turn', record: { id: lane.turn.id } }],
    });
    Atomics.store(f.state, 9, 1);
    const poisoned = f.send(sibling, [independent.input]).then((result) => {
      responses.push('C');
      return result;
    });
    expect(await poisoned).toMatchObject({ ok: false, error: { commit: 'unknown' } });
    expect(f.trace().some(([phase]) => phase === 'commit-result-lost')).toBe(true);
    // C really committed; only its result was lost. A's actual open file remains gated.
    expect(sibling.reader.entries(sibling.turn.id, 'item').map(({ id }) => id)).toEqual([
      independent.item.id,
    ]);
    expect(Atomics.load(f.state, 10)).toBeGreaterThan(0);
    release(4);
    expect(await first).toMatchObject({ ok: false, error: { commit: 'not-committed' } });
    expect(await second).toMatchObject({ ok: false, error: { commit: 'not-committed' } });
    expect(responses.filter((name) => name !== 'C')).toEqual(['A', 'B']);
    await vi.waitFor(() => expect(Atomics.load(f.state, 10)).toBe(0), { timeout: 3000 });
    await f.client.close(lane.database);
    expect(lane.reader.entries(lane.turn.id, 'item')).toEqual([]);
    expect(
      f
        .trace()
        .some(
          ([phase, path]) =>
            phase === 'file-closed' &&
            String(path).includes(item.input.content.reference.contentDigest.slice(7))
        )
    ).toBe(true);
  });

  it('prepares an exact queued publication against its terminal predecessor canonical result', async () => {
    const f = await fixture();
    const [lane, sibling] = f.lanes as [Lane, Lane, Lane];
    const [item, independent] = await Promise.all([f.entry(lane, 1), f.entry(sibling, 1)]);
    if (lane.turn.owner.kind !== 'workspace') throw new Error('Workspace Turn required.');
    const db = openWorkspaceDb(f.root, lane.turn.owner.workspaceId);
    try {
      // Establish the observation-family manifest through its owner before measuring terminal CAS.
      await appendWorkObservation(db, {
        threadId: lane.turn.threadId,
        turnId: lane.turn.id,
        observation: {
          id: `fifo-capture:${lane.turn.id}`,
          type: 'capture.unavailable',
          ts: lane.turn.startedAt!,
          obs: 'nanocore',
          payload: { family: 'model-response', reason: 'unsupported' },
        },
        bodies: [],
      });
    } finally {
      db.sqlite.close();
    }
    expect(lane.reader.get('turn', lane.turn.id)!.record.requiredFeatures).toContain(
      'openkit.work-observations.v1'
    );
    const revision = lane.reader.get('turn', lane.turn.id)!.revision;
    const responses: string[] = [];
    f.arm(item.input);
    // The real terminal owner supplies the complete Item, terminal event and deciding metadata.
    const terminal = observe(
      f.store.completeTurn(
        lane.turn.id,
        {
          status: 'completed',
          completedAt: lane.turn.startedAt!,
        },
        { items: [item.item] }
      ),
      () => responses.push('terminal')
    );
    await f.wait(3);
    const publication = observe(
      f.client.publication(lane.database, {
        category: 'already-decided-publication',
        turnId: lane.turn.id,
        expectedRevision: revision + 1,
        entries: [item.input],
      }),
      () => responses.push('publication')
    );
    expect(await f.send(sibling, [independent.input])).toEqual({ ok: true });
    expect(responses).toEqual([]);
    release(4);
    expect(await terminal).toMatchObject({ ok: true });
    expect(await publication).toMatchObject({ ok: true });
    expect(responses).toEqual(['terminal', 'publication']);
    expect(lane.reader.get('turn', lane.turn.id)).toMatchObject({
      revision: revision + 1,
      record: { status: 'completed' },
    });
    expect(
      lane.reader.entries(lane.turn.id, 'item').map(({ id, revision }) => [id, revision])
    ).toEqual([[item.item.id, 1]]);
    expect(f.store.getTurnById(lane.turn.id).items).toEqual([item.item]);
  });
});

it('prepares an exact native Review decision after its queued Artifact submission commits', async () => {
  const f = await fixture();
  const [lane, sibling] = f.lanes as [Lane, Lane, Lane];
  if (lane.turn.owner.kind !== 'workspace') throw new Error('Workspace Turn required.');
  const workspaceId = lane.turn.owner.workspaceId;
  const coreDb = openCoreDb(f.root);
  let db: ReturnType<typeof openWorkspaceDb> | undefined;
  const entered: Promise<unknown>[] = [];
  try {
    const userId = ensureLocalUser(coreDb);
    initializeDefaultKnowledgeBaseId({
      dataRoot: f.root,
      scope: { kind: 'server' },
      knowledgeBaseId: allocateEntityId('kb'),
    });
    const environmentPackage = await resolveAgentEnvironmentPackage({
      coreDb,
      agentSetup: createTestAgentSetup(),
      agentSessionId: allocateEntityId('as'),
      triggerActor: lane.turn.triggerActor,
      backend: { kind: 'openshell' },
      createdAt: lane.turn.startedAt!,
      requestId: randomUUID(),
      turn: lane.turn,
      workspaceCwd: '/workspace/output',
      workspaceRoots: [],
    });
    await f.store.createAgentSession({
      id: environmentPackage.scope.agentSessionId,
      workspaceId,
      threadId: lane.turn.threadId,
      agentId: environmentPackage.agent.agentId,
      status: 'ready',
      message: null,
      createdAt: lane.turn.startedAt!,
      updatedAt: lane.turn.startedAt!,
    });
    await f.store.updateTurn(lane.turn.id, {
      agentId: environmentPackage.agent.agentId,
      agentSessionId: environmentPackage.scope.agentSessionId,
    });
    db = openWorkspaceDb(f.root, workspaceId);
    const bytes = Buffer.from('Exact queued Review original.\n');
    // Only the external capture effect is doubled, as in the existing real Artifact tuple fixture.
    const captureArtifact: WorkerArtifactCapture = async () => ({
      source: Readable.from([bytes]),
      byteLength: bytes.length,
      contentDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      credentialCheckValues: {
        sensitiveValues: ['synthetic-injected-secret'],
        loopbackDigests: [
          createHash('sha256').update('a'.repeat(43)).digest('hex'),
          createHash('sha256').update('b'.repeat(43)).digest('hex'),
        ],
        routeTokenHashes: {
          workerControl: createHash('sha256').update(Buffer.alloc(32, 17)).digest('hex'),
          inference: createHash('sha256').update(Buffer.alloc(32, 34)).digest('hex'),
          capability: createHash('sha256').update(Buffer.alloc(32, 51)).digest('hex'),
        },
      },
      remove: async () => {},
    });
    type Submitted = Extract<ControlReviewCommandInput, { mode: 'submit' }>;
    let submitted!: (input: Submitted) => void;
    const posted = new Promise<Submitted>((resolve) => {
      submitted = resolve;
    });
    const responses: string[] = [];
    const review = f.client.review.bind(f.client);
    const commands = vi.spyOn(f.client, 'review').mockImplementation((database, input) => {
      if (input.mode === 'submit') {
        f.arm(input.transition.entries[0]!);
        submitted(input);
      }
      return review(database, input).finally(() => responses.push(input.mode));
    });
    const submission = observe(
      dispatchOpenkitWorkTool(
        {
          coreDb,
          store: f.store,
          workspaceDb: db,
          environmentPackage,
          captureArtifact,
          fileAdmission: new FileStorageAdmission(f.root, () => 0n),
        },
        'work_artifact_submit',
        {
          requestId: randomUUID(),
          path: `/openkit/sessions/${environmentPackage.scope.agentSessionId}/outputs/report.md`,
          kind: 'report',
          // Keep the original first-entry file barrier with a valid large public title.
          title: 'Queued report'.padEnd(70_000, '.'),
          mediaType: 'text/markdown',
        }
      ),
      () => {}
    );
    entered.push(submission);
    const native = await Promise.race([
      posted,
      submission.then((result) => {
        if (!result.ok) throw result.error;
        throw new Error('Artifact submission completed without its native submit operation.');
      }),
    ]);
    await f.wait(3);
    expect(() => getArtifactReview(db!, native.artifact.id, 1)).toThrowError(ArtifactReviewError);
    const decision = observe(
      executeControlReviewCommand(db, {
        mode: 'decide',
        input: {
          actorId: userId,
          actor: { kind: 'user', id: userId },
          artifactId: native.artifact.id,
          artifactVersion: native.artifact.version,
          requestId: randomUUID(),
          decidedAt: new Date().toISOString(),
          decision: 'needs_refinement',
          feedback: 'Refine this exact report.',
          artifactContent: null,
          artifactMediaType: 'text/markdown',
          artifactOriginal: {
            byteLength: bytes.length,
            contentDigest: native.artifact.contentDigest,
          },
        },
        // This existing first refinement phase reserves its follow-up; it owns no final API receipt.
        receipt: null,
      }),
      () => {}
    );
    entered.push(decision);
    await vi.waitFor(
      () => expect(commands.mock.calls.some(([, input]) => input.mode === 'decide')).toBe(true),
      { timeout: 3000 }
    );
    const independent = await f.entry(sibling, 1);
    expect(await f.send(sibling, [independent.input])).toEqual({ ok: true });
    expect(responses).toEqual([]);
    release(4);
    expect(await submission).toMatchObject({
      ok: true,
      value: { isError: false, structuredContent: { artifactId: native.artifact.id } },
    });
    expect(await decision).toMatchObject({
      ok: true,
      value: {
        mode: 'decide',
        value: {
          artifactId: native.artifact.id,
          artifactVersion: 1,
          decision: 'needs_refinement',
        },
      },
    });
    expect(responses).toEqual(['submit', 'decide']);
    expect(getArtifactReview(db, native.artifact.id, 1)).toMatchObject({
      contentDigest: native.artifact.contentDigest,
      decision: 'needs_refinement',
      sourceThreadId: lane.turn.threadId,
      sourceTurnId: lane.turn.id,
    });
    expect(
      readFileSync(
        artifactFilePayloadPath(join(f.root, 'workspaces', workspaceId), native.artifact.id, 1)
      )
    ).toEqual(bytes);
  } finally {
    release(4);
    await Promise.allSettled(entered);
    await closeRetrievalServices();
    db?.sqlite.close();
    coreDb.sqlite.close();
  }
});

// Runtime Policy publication oracles. No state-inspection case proves Vault refusal.
// Owner: config identity Reload And Failure Contract; Storage native FIFO.
// These cases inspect publication only; none claims a Vault effect was refused.

type PolicyClient = ReturnType<typeof getControlStoreWorkerClient>;
type PolicyAction = RuntimePolicyPublicationInput;
type PolicyCore = ReturnType<typeof openCoreDb>;

/** Parses only an actual native inspect result with the published closed ABI. */
async function inspectPublication(client: PolicyClient, db: PolicyCore) {
  return RuntimePolicyPublicationResultSchema.parse(
    await client.runtimePolicyPublication(db, { kind: 'inspect' })
  );
}

/** Requires a real active Workspace entry; no empty-map or absent-entry fallback qualifies. */
function selectedWorkspaceRevision(
  observed: RuntimePolicyPublicationResult,
  workspaceId: string
): string {
  expect(observed.state).toBe('active');
  const matches =
    observed.identity?.workspaceRevisions.filter((entry) => entry.workspaceId === workspaceId) ??
    [];
  expect(matches).toHaveLength(1);
  return matches[0]!.revision;
}

const policyDatabases: PolicyCore[] = [];
const policyWork: Promise<unknown>[] = [];
const policyTraffic: ReturnType<typeof observePublicationTraffic>[] = [];

/** Joins original work during cleanup without converting a rejection into successful evidence. */
function retainPolicyWork<T>(work: Promise<T>): Promise<T> {
  policyWork.push(work);
  void work.catch(() => undefined);
  return work;
}

/**
 * Captures actual method arguments and actual Worker requests/replies.
 * Delays occur only at the existing transport crossing. No ACK is constructed.
 */
function observePublicationTraffic(client: PolicyClient) {
  const calls = new AsyncLocalStorage<{ readonly db: PolicyCore; readonly action: PolicyAction }>();
  const actions: { readonly db: PolicyCore; readonly action: PolicyAction }[] = [];
  const frames: {
    readonly worker: Worker;
    readonly id: number;
    readonly action: PolicyAction;
    forwarded: boolean;
    acknowledged: boolean;
    forward: () => void;
  }[] = [];
  const heldReplies: { readonly kind: PolicyAction['kind']; deliver: () => void }[] = [];
  const events: string[] = [];
  const emission = new Set<Worker>();
  const faults: { post?: 'close' | 'activate'; ack?: 'close' | 'activate' } = {};
  const originalCall = client.runtimePolicyPublication.bind(client);
  vi.spyOn(client, 'runtimePolicyPublication').mockImplementation((db, action) => {
    if (action.kind !== 'inspect') actions.push({ db, action: structuredClone(action) });
    return calls.run({ db, action }, () => originalCall(db, action));
  });
  const post = Worker.prototype.postMessage;
  vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (
    this: Worker,
    ...args: Parameters<Worker['postMessage']>
  ) {
    const call = calls.getStore();
    const request = args[0] as {
      id?: number;
      database?: string;
      operation?: string;
      input?: RuntimePolicyPublicationInput;
    };
    if (
      !call ||
      request?.operation !== 'runtime-policy-publication' ||
      request.input?.kind !== call.action.kind
    ) {
      post.apply(this, args);
      return;
    }
    const scope = nativeProductScope(call.db.dataRoot, { kind: 'server' });
    // Match the actual closed family, original input kind and canonical Core target.
    // Opening, capacity work and unrelated native commands cannot select the ACK.
    if (request?.database !== `core:${scope.path}` || typeof request.id !== 'number') {
      post.apply(this, args);
      return;
    }
    const frame: (typeof frames)[number] = {
      worker: this,
      id: request.id,
      action: structuredClone(call.action),
      forwarded: false,
      acknowledged: false,
      forward: () => {
        if (frame.forwarded) return;
        frame.forwarded = true;
        post.apply(this, args);
      },
    };
    frames.push(frame);
    if (!emission.has(this)) {
      emission.add(this);
      const emit = this.emit;
      vi.spyOn(this, 'emit').mockImplementation((event, ...eventArgs) => {
        const reply = eventArgs[0] as { id?: number; status?: string } | undefined;
        const selected =
          event === 'message'
            ? frames.find(
                (candidate) => candidate.worker === frame.worker && candidate.id === reply?.id
              )
            : undefined;
        if (selected && reply?.status === 'ok') events.push(`${selected.action.kind}-native-ack`);
        if (selected && reply?.status === 'ok' && faults.ack === selected.action.kind) {
          heldReplies.push({
            kind: selected.action.kind,
            deliver: () => {
              selected.acknowledged = true;
              emit.call(selected.worker, event, ...eventArgs);
            },
          });
          return true;
        }
        if (selected) selected.acknowledged = true;
        return emit.call(frame.worker, event, ...eventArgs);
      });
    }
    if (faults.post === call.action.kind) {
      // Select only this original frame. A deliberate replay has its own request
      // identity and must reach native while the selected frame remains held.
      delete faults.post;
    } else frame.forward();
  });
  const result = {
    actions,
    events,
    frames,
    heldReplies,
    faults,
    deliverReplies() {
      delete faults.ack;
      for (const reply of heldReplies.splice(0)) reply.deliver();
    },
    releasePosts() {
      delete faults.post;
      for (const frame of frames) frame.forward();
    },
  };
  policyTraffic.push(result);
  return result;
}

/** Authored inactive inputs supply distinct revisions and confer no effect authority. */
function policySource(
  f: Awaited<ReturnType<typeof fixture>>,
  revision: 'A' | 'B' | 'C',
  extra = {}
) {
  const workspaceId = f.lanes[0]!.scope.owner;
  if (workspaceId.kind !== 'workspace') throw new Error('Expected actual fixture Workspace.');
  const document = {
    schemaVersion: 1,
    statements: [
      {
        id: `publication-input-${revision}`,
        kind: 'permission',
        state: 'inactive',
        effect: 'prohibit',
        grant: { kind: 'ordinary' },
        author: { kind: 'human', id: actor.id },
        authority: { kind: 'human', userId: actor.id },
        authoredAt: '2026-11-10T00:00:00.000Z',
        scope: {
          subjects: [{ kind: 'human', id: actor.id }],
          actions: ['vault.use'],
          resources: [
            {
              kind: 'container',
              container: {
                owner: workspaceId,
                kind: 'workspace',
                id: workspaceId.workspaceId,
              },
            },
          ],
        },
        lifetime: {
          anchor: { owner: workspaceId, kind: 'workspace', id: workspaceId.workspaceId },
        },
      },
    ],
  };
  // This is an external authored file consumed by the real loader, not a Policy
  // admission or a simulated loaded snapshot. No active statement is manufactured.
  mkdirSync(join(f.root, 'config'), { recursive: true });
  writeFileSync(
    join(f.root, 'config/server.jsonc'),
    JSON.stringify({
      schemaVersion: 1,
      policy: { mediation: document },
      ...extra,
    })
  );
  return document;
}

/** Adds a real Core Turn to the unchanged existing asynchronous file-preparation fixture. */
async function publicationFixture(initialServerBindPort?: number) {
  const f = await fixture();
  const db = openCoreDb(f.root);
  policyDatabases.push(db);
  const thread = await f.store.createServerThread('Policy publication predecessor');
  const turn = await f.store.createServerTurn(thread.id, 'Publish this original Core Item.', actor);
  const scope = nativeProductScope(f.root, { kind: 'server' });
  const reader = openControlStoreProductReadHandle(scope.path, scope.owner);
  readers.push(reader);
  const coreLane: Lane = { turn, scope, database: `core:${scope.path}`, reader };
  const document = policySource(
    f,
    'A',
    initialServerBindPort === undefined
      ? {}
      : {
          server: { bind: { host: '127.0.0.1', port: initialServerBindPort } },
        }
  );
  const workspaceOwner = f.lanes[0]!.turn.owner;
  if (workspaceOwner.kind !== 'workspace') throw new Error('Expected actual selected Workspace.');
  const workspaceId = workspaceOwner.workspaceId;
  const workspaceConfigRoot = join(f.root, 'workspaces', workspaceId, 'config');
  mkdirSync(workspaceConfigRoot, { recursive: true });
  // Actual authored Workspace input joins the loaded snapshot; the test does not
  // rely on the absent-loaded-Workspace EMPTY fallback or claim an active grant.
  writeFileSync(
    join(workspaceConfigRoot, 'workspace.jsonc'),
    JSON.stringify({
      schemaVersion: 1,
      workspace: {
        name: f.store.getWorkspace(workspaceId).name,
        policy: { mediation: EMPTY_POLICY_DOCUMENT },
      },
    })
  );
  const manager = createRuntimeConfigManager({ dataRoot: f.root });
  const loadedWorkspace = manager
    .current()
    .workspaceConfigs.filter((entry) => entry.workspaceId === workspaceId);
  expect(loadedWorkspace).toHaveLength(1);
  expect(policyDigest(loadedWorkspace[0]!.config.workspace.policy!.mediation)).toBe(
    policyDigest(EMPTY_POLICY_DOCUMENT)
  );
  return { ...f, db, coreLane, manager, document, workspaceId };
}

describe('runtime Policy publication through the actual native FIFO', () => {
  afterEach(async () => {
    release(4);
    release(8);
    for (const traffic of policyTraffic.splice(0)) {
      traffic.releasePosts();
      traffic.deliverReplies();
    }
    await Promise.allSettled(policyWork.splice(0));
    await shutdownControlStoreWorkerClient();
    for (const db of policyDatabases.splice(0)) if (db.sqlite.open) db.sqlite.close();
  });

  it('withholds initial binding readiness until the actual native activation ACK', async () => {
    const f = await publicationFixture();
    const traffic = observePublicationTraffic(f.client);
    traffic.faults.ack = 'activate';
    let ready = false;
    const binding = retainPolicyWork(
      f.manager.bindNativePolicyPublication(f.db).then(() => {
        ready = true;
      })
    );
    await vi.waitFor(() =>
      expect(traffic.heldReplies.some((reply) => reply.kind === 'activate')).toBe(true)
    );
    expect(ready).toBe(false);
    expect((await inspectPublication(f.client, f.db)).state).toBe('active');
    traffic.deliverReplies();
    await binding;
    expect(ready).toBe(true);
  });

  it('keeps close behind actual asynchronous Core preparation and observes both closed intervals', async () => {
    const f = await publicationFixture();
    const traffic = observePublicationTraffic(f.client);
    await f.manager.bindNativePolicyPublication(f.db);
    const before = await inspectPublication(f.client, f.db);
    expect(before.state).toBe('active');
    expect(before.identity!.serverRevision).toBe(policyDigest(f.document));
    expect(selectedWorkspaceRevision(before, f.workspaceId)).toBe(
      policyDigest(EMPTY_POLICY_DOCUMENT)
    );
    traffic.events.length = 0;
    traffic.frames.length = 0;
    traffic.faults.ack = 'close';
    traffic.faults.post = 'close';
    const one = await f.entry(f.coreLane, 1);
    const sibling = await f.entry(f.lanes[1]!, 1);
    const initialSnapshot = f.manager.current();
    const documentB = policySource(f, 'B');
    const reload = retainPolicyWork(
      Promise.resolve(f.manager.reload({ mode: 'safe', dryRun: false }))
    );
    // Let the manager's actual inspect finish before delaying its original close frame.
    // Otherwise that inspect barrier would wait for the held Item before close was posted.
    await vi.waitFor(() =>
      expect(
        traffic.frames.some((frame) => frame.action.kind === 'close' && !frame.forwarded)
      ).toBe(true)
    );
    f.arm(one.input);
    const first = retainPolicyWork(
      f.send(f.coreLane, [one.input], () => traffic.events.push('predecessor-ack'))
    );
    await f.wait(3);
    traffic.faults.post = 'activate';
    const close = traffic.frames.find(
      (frame) => frame.action.kind === 'close' && !frame.forwarded
    )!;
    close.forward();
    // Actual sibling Workspace service progresses on a different host.
    // This completion does not establish liveness of the dedicated Core host.
    expect(await f.send(f.lanes[1]!, [sibling.input])).toEqual({ ok: true });
    expect(f.manager.current()).toBe(initialSnapshot);
    expect(
      traffic.frames.filter((frame) => frame.action.kind === 'close' && frame.acknowledged)
    ).toEqual([]);
    expect(f.coreLane.reader.entries(f.coreLane.turn.id, 'item')).toEqual([]);
    release(4);
    expect(await first).toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(traffic.heldReplies.some((reply) => reply.kind === 'close')).toBe(true)
    );
    expect(f.coreLane.reader.entries(f.coreLane.turn.id, 'item').map(({ id }) => id)).toEqual([
      one.item.id,
    ]);
    // Compare actual arrival order, not the delivery suppressed by this test's ACK hold.
    expect(traffic.events.indexOf('predecessor-ack')).toBeGreaterThanOrEqual(0);
    expect(traffic.events.indexOf('close-native-ack')).toBeGreaterThan(
      traffic.events.indexOf('predecessor-ack')
    );
    expect((await inspectPublication(f.client, f.db)).state).toBe('closed');
    expect(f.manager.current()).toBe(initialSnapshot);
    traffic.deliverReplies();
    await vi.waitFor(() =>
      expect(
        traffic.frames.some((frame) => frame.action.kind === 'activate' && !frame.forwarded)
      ).toBe(true)
    );
    expect(policyDigest(f.manager.current().openKitConfig.policy!.mediation)).toBe(
      policyDigest(documentB)
    );
    expect((await inspectPublication(f.client, f.db)).state).toBe('closed');
    traffic.releasePosts();
    expect((await reload).status).toBe('applied');
    const after = await inspectPublication(f.client, f.db);
    expect(after.state).toBe('active');
    expect(after.identity!.serverRevision).toBe(policyDigest(documentB));
    // Selected Workspace policy did not change; unrelated snapshot version is not revocation.
    expect(selectedWorkspaceRevision(after, f.workspaceId)).toBe(
      selectedWorkspaceRevision(before, f.workspaceId)
    );
  });

  it('refuses stale captured close and activate actions without changing the actual current publication', async () => {
    const f = await publicationFixture();
    const traffic = observePublicationTraffic(f.client);
    await f.manager.bindNativePolicyPublication(f.db);
    traffic.actions.length = 0;
    traffic.frames.length = 0;
    traffic.events.length = 0;
    policySource(f, 'B');
    expect((await f.manager.reload({ mode: 'safe', dryRun: false })).status).toBe('applied');
    const previous = traffic.actions.map(({ action }) => action);
    expect(previous.some((action) => action.kind === 'close')).toBe(true);
    expect(previous.some((action) => action.kind === 'activate')).toBe(true);
    traffic.faults.post = 'activate';
    policySource(f, 'C');
    const replacement = retainPolicyWork(
      Promise.resolve(f.manager.reload({ mode: 'safe', dryRun: false }))
    );
    await vi.waitFor(() =>
      expect(
        traffic.frames.some((frame) => frame.action.kind === 'activate' && !frame.forwarded)
      ).toBe(true)
    );
    const closed = await inspectPublication(f.client, f.db);
    expect(closed.state).toBe('closed');
    // A matching closed state for the later transition cannot revive an older packet.
    for (const kind of ['activate', 'close'] as const) {
      const action = previous.find((candidate) => candidate.kind === kind)!;
      const previousFrameCount = traffic.frames.length;
      await expect(f.client.runtimePolicyPublication(f.db, action)).rejects.toBeDefined();
      expect(
        traffic.frames
          .slice(previousFrameCount)
          .some((frame) => frame.action.kind === kind && frame.forwarded)
      ).toBe(true);
      expect(await inspectPublication(f.client, f.db)).toEqual(closed);
    }
    traffic.releasePosts();
    expect((await replacement).status).toBe('applied');
    const current = await inspectPublication(f.client, f.db);
    for (const kind of ['activate', 'close'] as const) {
      const action = previous.find((candidate) => candidate.kind === kind)!;
      const previousFrameCount = traffic.frames.length;
      await expect(f.client.runtimePolicyPublication(f.db, action)).rejects.toBeDefined();
      expect(
        traffic.frames
          .slice(previousFrameCount)
          .some((frame) => frame.action.kind === kind && frame.forwarded)
      ).toBe(true);
      expect(await inspectPublication(f.client, f.db)).toEqual(current);
    }
  });

  it.each(['close', 'activate'] as const)(
    'reports actual loaded state after loss of the original %s ACK',
    async (phase) => {
      const f = await publicationFixture(4100);
      const traffic = observePublicationTraffic(f.client);
      await f.manager.bindNativePolicyPublication(f.db);
      traffic.actions.length = 0;
      traffic.frames.length = 0;
      traffic.events.length = 0;
      traffic.faults.ack = phase;
      const before = f.manager.current();
      const previousRestart = structuredClone(f.manager.status().pendingRestart);
      const next = policySource(f, 'B', {
        server: { bind: { host: '127.0.0.1', port: phase === 'activate' ? 4101 : 4100 } },
      });
      const expectedPlan = diffRuntimeConfig(
        before,
        loadRuntimeConfig(f.root, { version: before.version + 1 })
      );
      if (phase === 'activate')
        expect(expectedPlan.requiresRestart).toEqual([
          expect.objectContaining({
            path: 'server',
            action: 'requires-restart',
            category: 'restart-required',
          }),
        ]);
      else expect(expectedPlan.requiresRestart).toEqual([]);
      const reload = retainPolicyWork(
        Promise.resolve(f.manager.reload({ mode: 'safe', dryRun: false }))
      );
      await vi.waitFor(() =>
        expect(traffic.heldReplies.some((reply) => reply.kind === phase)).toBe(true)
      );
      const observed = await inspectPublication(f.client, f.db);
      expect(observed.state).toBe(phase === 'close' ? 'closed' : 'active');
      if (phase === 'close') expect(f.manager.current()).toBe(before);
      else expect(observed.identity!.serverRevision).toBe(policyDigest(next));
      const selected = traffic.frames.find(
        (frame) => frame.action.kind === phase && frame.forwarded
      )!;
      const originalFrames = traffic.frames.filter((frame) => frame.action.kind === phase).length;
      // Original reply existed; no synthetic reply, timeout or graceful shutdown substitutes for loss.
      traffic.heldReplies.length = 0;
      await selected.worker.terminate();
      expect((await reload).status).toBe('failed');
      expect(f.manager.status().currentVersion).toBe(f.manager.current().version);
      expect(f.manager.current().version).toBe(before.version + (phase === 'activate' ? 1 : 0));
      expect(f.manager.current().openKitConfig.server?.bind).toEqual(
        before.openKitConfig.server?.bind
      );
      expect(f.manager.status().pendingRestart).toEqual(
        phase === 'activate' ? expectedPlan.requiresRestart : previousRestart
      );
      expect((await reload).runtimeConfig.pendingRestart).toEqual(
        f.manager.status().pendingRestart
      );
      if (phase === 'close') expect(f.manager.current()).toBe(before);
      else
        expect(policyDigest(f.manager.current().openKitConfig.policy!.mediation)).toBe(
          policyDigest(next)
        );
      await expect(
        f.client.runtimePolicyPublication(f.db, { kind: 'inspect' })
      ).rejects.toBeDefined();
      expect(traffic.frames.filter((frame) => frame.action.kind === phase)).toHaveLength(
        originalFrames
      );
    }
  );

  it.each(['dry-run', 'strict-rejected', 'invalid'] as const)(
    'does not change loaded publication after %s input',
    async (mode) => {
      const f = await publicationFixture();
      const traffic = observePublicationTraffic(f.client);
      await f.manager.bindNativePolicyPublication(f.db);
      const before = await inspectPublication(f.client, f.db);
      const snapshot = f.manager.current();
      traffic.actions.length = 0;
      policySource(
        f,
        'B',
        mode === 'strict-rejected' ? { server: { publicBaseUrl: 'https://openkit.invalid' } } : {}
      );
      if (mode === 'invalid') writeFileSync(join(f.root, 'config/server.jsonc'), '{ invalid input');
      const result = await f.manager.reload({
        mode: mode === 'strict-rejected' ? 'strict' : 'safe',
        dryRun: mode === 'dry-run',
      });
      expect(result.status).toBe(
        mode === 'dry-run' ? 'dry-run' : mode === 'invalid' ? 'failed' : 'rejected'
      );
      expect(f.manager.current()).toBe(snapshot);
      expect(await inspectPublication(f.client, f.db)).toEqual(before);
      expect(traffic.actions).toEqual([]);
    }
  );

  it('preserves relevant Policy identity across an unrelated applied snapshot version', async () => {
    const f = await publicationFixture();
    await f.manager.bindNativePolicyPublication(f.db);
    const before = await inspectPublication(f.client, f.db);
    const version = f.manager.current().version;
    expect(selectedWorkspaceRevision(before, f.workspaceId)).toBe(
      policyDigest(EMPTY_POLICY_DOCUMENT)
    );
    // Safe reload retains this restart-required Server field; Policy is unchanged.
    policySource(f, 'A', { server: { publicBaseUrl: 'https://openkit.invalid' } });
    expect((await f.manager.reload({ mode: 'safe', dryRun: false })).status).toBe('applied');
    expect(f.manager.current().version).toBeGreaterThan(version);
    const after = await inspectPublication(f.client, f.db);
    expect(after.state).toBe('active');
    expect(after.identity).toEqual(before.identity);
    expect(selectedWorkspaceRevision(after, f.workspaceId)).toBe(
      selectedWorkspaceRevision(before, f.workspaceId)
    );
  });

  it('keeps distinct actual Core roots separate while one publication is closed', async () => {
    const first = await publicationFixture();
    const second = await publicationFixture();
    const traffic = observePublicationTraffic(first.client);
    await first.manager.bindNativePolicyPublication(first.db);
    await second.manager.bindNativePolicyPublication(second.db);
    const sibling = await inspectPublication(second.client, second.db);
    traffic.actions.length = 0;
    traffic.frames.length = 0;
    traffic.events.length = 0;
    traffic.faults.ack = 'close';
    policySource(first, 'B');
    const reload = retainPolicyWork(
      Promise.resolve(first.manager.reload({ mode: 'safe', dryRun: false }))
    );
    await vi.waitFor(() =>
      expect(traffic.heldReplies.some((reply) => reply.kind === 'close')).toBe(true)
    );
    expect((await inspectPublication(first.client, first.db)).state).toBe('closed');
    expect(await inspectPublication(second.client, second.db)).toEqual(sibling);
    traffic.deliverReplies();
    expect((await reload).status).toBe('applied');
  });

  it('requires fresh publication after explicit native restart and after a new manager startup', async () => {
    const f = await publicationFixture();
    const traffic = observePublicationTraffic(f.client);
    await f.manager.bindNativePolicyPublication(f.db);
    const before = await inspectPublication(f.client, f.db);
    const previousActivation = traffic.actions.find(
      ({ action }) => action.kind === 'activate'
    )!.action;
    await shutdownControlStoreWorkerClient();
    let client = getControlStoreWorkerClient();
    const reopened = await inspectPublication(client, f.db);
    expect(reopened.state).toBe('unavailable');
    expect(reopened.openingId).not.toBe(before.openingId);
    await expect(client.runtimePolicyPublication(f.db, previousActivation)).rejects.toBeDefined();
    await f.manager.bindNativePolicyPublication(f.db);
    const rebound = await inspectPublication(client, f.db);
    expect(rebound.identity!.serverRevision).toBe(before.identity!.serverRevision);
    await expect(client.runtimePolicyPublication(f.db, previousActivation)).rejects.toBeDefined();
    expect(await inspectPublication(client, f.db)).toEqual(rebound);
    await shutdownControlStoreWorkerClient();
    client = getControlStoreWorkerClient();
    const restartedManager = createRuntimeConfigManager({ dataRoot: f.root });
    const restartedOpening = await inspectPublication(client, f.db);
    expect(restartedOpening.state).toBe('unavailable');
    expect(restartedOpening.openingId).not.toBe(rebound.openingId);
    await restartedManager.bindNativePolicyPublication(f.db);
    const current = await inspectPublication(client, f.db);
    expect(current.state).toBe('active');
    expect(current.identity!.serverRevision).toBe(
      policyDigest(restartedManager.current().openKitConfig.policy!.mediation)
    );
  });
});
