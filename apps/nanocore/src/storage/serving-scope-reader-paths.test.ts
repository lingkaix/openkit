// openkit-test-platform: posix
/** Serving readers preserve genuine native publication and exact cold readback. */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { allocateEntityId } from '@openkit/protocol';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { expect, it, onTestFinished, vi } from 'vitest';
import { listWorkspaceCapabilityCalls } from '../capability/usage-ledger.js';
import { createInMemoryRuntimeConfigSnapshot } from '../config/runtime-config.js';
import { readWorkObservationBody } from '../evidence-bundles.js';
import { SimulatedTurnExecutor } from '../lib/simulator.js';
import { FsStore } from '../lib/store.js';
import { ModelCapture, withTurnModelCapture } from '../llm/model-capture.js';
import { listExportableAgentEnvironmentPackageSnapshots } from '../runtime/aep-snapshot-ledger.js';
import {
  bindSchedulerExecutionAttemptSession,
  createSchedulerExecutionAttempt,
} from '../runtime/execution-attempt-records.js';
import type { WorkerControlGateway } from '../runtime/worker-control-gateway.js';
import { createDefaultWorkerMcpGateway } from '../runtime/worker-mcp-gateway.js';
import { createSchedulerAdmissionEntry } from '../scheduler-records.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { heldCommit, releaseCommit } from '../test-support/control-native-transport.js';
import { createMeasurementEffectFixture } from '../test-support/load-effect.fixture.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import {
  admitTestNativeEnvironment,
  recordTestNativeRuntimeTarget,
} from '../test-support/native-environment.js';
import { createTestCoreDb, createTestStore, disposeTestStore } from '../test-support/store.js';
import { registerWorkerMcpRoutes } from '../worker-mcp-routes.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import { FileStorageAdmission } from './artifacts/file-admission.js';
import { closeWorkspaceProductReadHandles } from './control-store-product-records.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
import { bindCoreSqlite, openSupportedScopeReadOnlySqlite, openWorkspaceReadDb } from './db.js';
import { coreDbPath, workspaceDbPath } from './fs-layout.js';
import { readWorkObservations } from './work-observations.js';

const observation = vi.hoisted(() => ({
  active: false,
  paths: new Set<string>(),
  opened: new Map<import('better-sqlite3').Database, { readonlyAtOpen: boolean }>(),
}));
vi.mock('better-sqlite3', async (load) => {
  const actual = await load<{ default: typeof import('better-sqlite3') }>();
  return {
    ...actual,
    default: new Proxy(actual.default, {
      construct(target, args, newTarget) {
        const db = Reflect.construct(target, args, newTarget) as import('better-sqlite3').Database;
        if (observation.active && observation.paths.has(db.name))
          observation.opened.set(db, { readonlyAtOpen: db.readonly });
        return db; // No policy changes, alternate connection, SQL or business reply.
      },
    }),
  };
});
vi.mock('node:worker_threads', async (load) => {
  const actual = await load<typeof import('node:worker_threads')>();
  const { nativeCommitWorker } = await import('../test-support/control-native-transport.js');
  return { ...actual, Worker: nativeCommitWorker(actual.Worker) };
});

/** Observes only new handles on exact already-published fixture owners, after setup. */
function observeServingOpens(paths: readonly string[]) {
  observation.paths = new Set(paths.map((path) => realpathSync(path)));
  observation.opened.clear();
  observation.active = true;
  let challenging = false;
  const writes: string[] = [];
  const challenges: Array<{
    path: string;
    readonly: boolean;
    queryOnly: unknown;
    code: unknown;
    unchanged: boolean;
  }> = [];
  const prepare = Database.prototype.prepare,
    exec = Database.prototype.exec,
    close = Database.prototype.close;
  const selected = (db: Database.Database) => observation.active && observation.opened.has(db);
  const transaction = /^\s*(?:BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i;
  vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (
    this: Database.Database,
    sql: string
  ) {
    const statement = prepare.call(this, sql) as Database.Statement;
    if (!statement.readonly && !transaction.test(sql))
      for (const method of ['run', 'get', 'all', 'iterate'] as const) {
        const original = statement[method];
        Object.defineProperty(statement, method, {
          value: function (this: Database.Statement, ...args: unknown[]) {
            if (!challenging && selected(this.database)) writes.push(sql);
            return Reflect.apply(original, this, args);
          },
        });
      }
    return statement;
  });
  vi.spyOn(Database.prototype, 'exec').mockImplementation(function (
    this: Database.Database,
    sql: string
  ) {
    if (
      !challenging &&
      selected(this) &&
      /^\s*(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP|VACUUM|REINDEX|ANALYZE)\b/i.test(sql)
    )
      writes.push(sql);
    return exec.call(this, sql);
  });
  vi.spyOn(Database.prototype, 'close').mockImplementation(function (this: Database.Database) {
    if (selected(this) && this.open) {
      challenging = true;
      try {
        // The protected journal exists through real boot/setup, never hand-assembled SQL state.
        expect(this.inTransaction).toBe(false);
        const before = prepare.call(this, 'SELECT * FROM __drizzle_migrations ORDER BY id').all();
        expect(before.length).toBeGreaterThan(0);
        const queryOnly = this.pragma('query_only', { simple: true });
        let code: unknown;
        exec.call(this, 'SAVEPOINT serving_reader_challenge');
        try {
          prepare
            .call(
              this,
              'DELETE FROM __drizzle_migrations WHERE id=(SELECT id FROM __drizzle_migrations ORDER BY id LIMIT 1)'
            )
            .run();
        } catch (error) {
          code =
            typeof error === 'object' && error !== null && 'code' in error
              ? error.code
              : 'UNCLASSIFIED';
        } finally {
          exec.call(this, 'ROLLBACK TO serving_reader_challenge');
          exec.call(this, 'RELEASE serving_reader_challenge');
        }
        const after = prepare.call(this, 'SELECT * FROM __drizzle_migrations ORDER BY id').all();
        challenges.push({
          path: this.name,
          readonly: this.readonly,
          queryOnly,
          code,
          unchanged: JSON.stringify(after) === JSON.stringify(before),
        });
      } finally {
        challenging = false;
      }
    }
    return close.call(this);
  });
  return {
    stop() {
      observation.active = false;
    },
    assert() {
      // Core Storage65/79; Durable Execution589: actual separate reader must refuse writes.
      expect(observation.opened.size).toBeGreaterThan(0);
      expect([...observation.opened.values()].every((x) => x.readonlyAtOpen)).toBe(true);
      expect([...observation.opened.keys()].every((db) => !db.open)).toBe(true);
      expect(new Set(challenges.map((x) => x.path))).toEqual(
        new Set(paths.map((path) => realpathSync(path)))
      );
      expect(
        challenges.every(
          (x) => x.readonly && x.queryOnly === 1 && x.code === 'SQLITE_READONLY' && x.unchanged
        )
      ).toBe(true);
      expect(writes).toEqual([]); // Includes Main schema/migration execution, never native SQL.
    },
  };
}

/** Fresh real storage owners; no runtime producer, discovery or capture is pre-run. */
async function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'serving-reader-paths-'));
  const coreDb = createTestCoreDb(dataRoot);
  const userId = ensureLocalUser(coreDb);
  const store = createTestStore({ dataRoot });
  const workspace = await store.createWorkspace('Serving readers');
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
  const thread = await store.createThread(workspace.id, 'First use');
  onTestFinished(async () => {
    observation.active = false;
    releaseCommit();
    vi.restoreAllMocks();
    await disposeTestStore(dataRoot, coreDb);
  });
  return { dataRoot, coreDb, userId, store, workspace, thread };
}

/** Preserves a real producer's first native FULL commit and result rather than replacing its ACK. */
async function throughFullCommit<T>(run: () => Promise<T>) {
  const held = await heldCommit(2, run);
  try {
    expect(held.completed()).toBe(false);
  } finally {
    releaseCommit();
  }
  return held.result;
}

it('keeps cold remote MCP and built-in Tool serving opens read-only while retaining their real lifecycle', async () => {
  const f = await fixture();
  const db = openWorkspaceReadDb(f.dataRoot, f.workspace.id);
  onTestFinished(() => {
    if (db.sqlite.open) db.sqlite.close();
  });
  const effect = await createMeasurementEffectFixture({
    ...f,
    workspaces: [{ workspace: f.workspace, db }],
  });
  const aep = listExportableAgentEnvironmentPackageSnapshots(db, f.workspace.id)[0]!.snapshot;
  const gateway = createDefaultWorkerMcpGateway(f.coreDb);
  const app = new Hono();
  const admission = new WorkspaceMutationAdmission();
  const runtime = createInMemoryRuntimeConfigSnapshot({ dataRoot: f.dataRoot });
  registerWorkerMcpRoutes({
    app,
    coreDb: f.coreDb,
    store: f.store,
    runtimeConfig: () => runtime,
    workerMcpGateway: gateway,
    workspaceMutationAdmission: admission,
    // Existing fixture boundary supplies an authenticated outside AEP; every durable/current
    // Turn, Workspace, policy and capability predicate remains in the actual Tool route.
    workerControlGateway: {
      authenticatePackageToken: () => aep,
    } as unknown as WorkerControlGateway,
  });
  const client = new Client({ name: 'serving-reader-builtin', version: '1' });
  const transport = new StreamableHTTPClientTransport(
    new URL('http://nanocore.test/api/worker-capabilities/mcp/openkit-generative'),
    {
      fetch: (request, init) => app.fetch(new Request(request, init)),
      requestInit: { headers: { authorization: `Bearer synthetic-${randomUUID()}` } },
    }
  );
  await client.connect(transport); // Protocol initialization, no tools/list or tools/call warm-up.
  onTestFinished(async () => {
    await client.close();
    await effect.close();
    await gateway.close();
  });
  db.sqlite.close();
  await shutdownControlStoreWorkerClient();
  closeWorkspaceProductReadHandles(f.dataRoot);
  // Keep the effect fixture's captured WorkspaceDb identity, using a fresh physical reader.
  Object.defineProperties(
    db,
    Object.getOwnPropertyDescriptors(openWorkspaceReadDb(f.dataRoot, f.workspace.id))
  );
  const fence = observeServingOpens([workspaceDbPath(f.dataRoot, f.workspace.id)]);
  const witness = await throughFullCommit(() => effect.call(f.workspace.id, 1));
  expect(witness.cold).toBe(true);
  expect(effect.firstEffectCount()).toBe(1);
  const verified = effect.verify(witness);
  expect(verified).toEqual({ capability: 1, permission: 1, toolUsage: 1, terminalItems: 1 });
  const builtin = await client.callTool({ name: 'kernel_apps_list', arguments: {} });
  expect(builtin.isError).not.toBe(true);
  expect(builtin.content).toEqual([
    {
      type: 'text',
      text: JSON.stringify({ page: 1, perPage: 30, totalItems: 0, totalPages: 0, items: [] }),
    },
  ]);
  const builtinCalls = listWorkspaceCapabilityCalls(db, f.workspace.id).filter(
    (x) => x.capabilityId === 'mcp.call-tool.kernel_apps_list'
  );
  expect(builtinCalls).toHaveLength(1);
  expect(builtinCalls[0]!.status).toBe('succeeded');
  const retainedCall = builtinCalls[0]!;
  await client.close();
  await effect.close();
  await gateway.close();
  db.sqlite.close();
  await shutdownControlStoreWorkerClient();
  closeWorkspaceProductReadHandles(f.dataRoot);
  fence.stop();
  const cold = openWorkspaceReadDb(f.dataRoot, f.workspace.id);
  try {
    expect(effect.verify(witness, cold)).toEqual(verified);
    expect(
      listWorkspaceCapabilityCalls(cold, f.workspace.id).find((x) => x.id === retainedCall.id)
    ).toEqual(retainedCall);
    expect(
      new FsStore({ dataRoot: f.dataRoot }).getThreadItem(
        witness.workspaceId,
        effect.turns[0]!.threadId,
        witness.itemId
      ).status
    ).toBe('completed');
  } finally {
    cold.sqlite.close();
    closeWorkspaceProductReadHandles(f.dataRoot);
  }
  fence.assert();
});

it('opens unborrowed Workspace and Server model capture as readers before native retained publication', async () => {
  const f = await fixture();
  const serverThread = await f.store.createServerThread('Server capture');
  const actor = { kind: 'user' as const, id: f.userId };
  const workspaceTurn = await f.store.createTurn(
    f.workspace.id,
    f.thread.id,
    'Workspace capture',
    actor,
    null,
    { captureCoverage: { scope: 'server', value: 'on' } }
  );
  const serverTurn = await f.store.createServerTurn(
    serverThread.id,
    'Server capture',
    actor,
    null,
    { captureCoverage: { scope: 'server', value: 'on' } }
  );
  await shutdownControlStoreWorkerClient();
  closeWorkspaceProductReadHandles(f.dataRoot);
  const fence = observeServingOpens([
    coreDbPath(f.dataRoot),
    workspaceDbPath(f.dataRoot, f.workspace.id),
  ]);
  const expected: Array<{
    turn: typeof workspaceTurn | typeof serverTurn;
    rows: ReturnType<typeof readWorkObservations>;
    bodies: Array<Uint8Array | null>;
  }> = [];
  for (const turn of [workspaceTurn, serverTurn]) {
    const label = turn.owner.kind === 'server' ? 'server' : 'workspace';
    await throughFullCommit(() =>
      withTurnModelCapture(
        { store: f.store, turn, environment: { systemPrompt: `Exact ${label} prompt`, tools: [] } },
        async (context) => {
          const capture = new ModelCapture(
            { ...context, corr: `first-${label}` },
            [],
            'fixture-provider'
          );
          await capture.request({ model: 'fixture-model', input: `Exact ${label} request` });
          await capture.event({ type: 'text_delta', delta: `Exact ${label} reply` });
          await capture.event({ type: 'done' });
          // These are public capture-owner input methods, not fabricated provider/business responses.
          const rows = readWorkObservations(context.workspaceDb, {
            threadId: turn.threadId,
            turnId: turn.id,
          });
          expect(rows[0]).toMatchObject({ type: 'env.bound', turnId: turn.id });
          const publications = rows.flatMap((row) =>
            (row.refs ?? [])
              .filter((ref) => ref.edge === 'publication')
              .map((ref) => ({ row, ref }))
          );
          expect(publications.length).toBeGreaterThan(0);
          const bodies = publications.map(({ row, ref }) =>
            readWorkObservationBody(context.workspaceDb, {
              bundleId: ref.locator,
              threadId: turn.threadId,
              turnId: turn.id,
              createdAt: row.ts,
              sha256: ref.digest!,
            })
          );
          expect(bodies.every((body) => body !== null)).toBe(true);
          expected.push({ turn, rows, bodies });
        }
      )
    );
  }
  await shutdownControlStoreWorkerClient();
  closeWorkspaceProductReadHandles(f.dataRoot);
  fence.stop();
  for (const { turn, rows, bodies } of expected) {
    const db =
      turn.owner.kind === 'server'
        ? bindCoreSqlite(
            openSupportedScopeReadOnlySqlite(coreDbPath(f.dataRoot), 'core'),
            f.dataRoot
          )
        : openWorkspaceReadDb(f.dataRoot, f.workspace.id);
    try {
      expect(readWorkObservations(db, { threadId: turn.threadId, turnId: turn.id })).toEqual(rows);
      const coldBodies = rows.flatMap((row) =>
        (row.refs ?? [])
          .filter((ref) => ref.edge === 'publication')
          .map((ref) =>
            readWorkObservationBody(db, {
              bundleId: ref.locator,
              threadId: turn.threadId,
              turnId: turn.id,
              createdAt: row.ts,
              sha256: ref.digest!,
            })
          )
      );
      expect(coldBodies).toEqual(bodies);
    } finally {
      db.sqlite.close();
    }
  }
  fence.assert();
});

it('uses reader opens through the first real simulator execution and retains its terminal Turn', async () => {
  const f = await fixture();
  const agentSetup = createTestAgentSetup();
  admitTestNativeEnvironment(f.coreDb, agentSetup.manifest);
  await recordTestNativeRuntimeTarget(f.coreDb);
  const executor = new SimulatedTurnExecutor({
    coreDb: f.coreDb,
    fileAdmission: new FileStorageAdmission(f.dataRoot, () => 1_000_000_000n),
  });
  const text = 'Create one simulator Artifact';
  const actor = { kind: 'user' as const, id: f.userId };
  const turn = await f.store.createTurn(f.workspace.id, f.thread.id, text, actor, null, {
    agentId: agentSetup.manifest.id,
    captureCoverage: { scope: 'server', value: 'off' },
  });
  const requestId = randomUUID();
  const entry = createSchedulerAdmissionEntry(f.coreDb, {
    backendId: executor.executionBackend.id,
    queueEntryId: randomUUID(),
    requestId,
    requestedAgentId: agentSetup.manifest.id,
    profileRef: agentSetup.manifest.defaultProfileId ?? null,
    modelId: agentSetup.logicalModels.preferredLogicalModelId ?? null,
    workspaceId: f.workspace.id,
    threadId: turn.threadId,
    turnId: turn.id,
    turnInput: text,
    triggerActor: actor,
    workspaceCwd: null,
    workspaceRoots: [],
  });
  const attempt = createSchedulerExecutionAttempt(f.coreDb, {
    entry,
    preparationInput: { admission: entry, manifest: agentSetup.manifest },
  });
  const preparation = {
    attemptId: attempt.attemptId,
    agentSetup,
    freshAgentSessionId: allocateEntityId('as'),
    requestId,
    turn: f.store.getTurnById(turn.id),
    turnInput: text,
    workspaceCwd: null,
    workspaceRoots: [],
  };
  const prepared = await executor.prepareAgentSessionForTurn(f.store, preparation);
  bindSchedulerExecutionAttemptSession(f.coreDb, {
    attemptId: attempt.attemptId,
    agentSessionId: prepared.agentSessionId,
  });
  await executor.commitPreparedAgentSessionForTurn(f.store, {
    attemptId: attempt.attemptId,
    preparation,
    prepared,
  });
  await shutdownControlStoreWorkerClient();
  closeWorkspaceProductReadHandles(f.dataRoot);
  const fence = observeServingOpens([workspaceDbPath(f.dataRoot, f.workspace.id)]);
  await throughFullCommit(() =>
    executor.startTurn(f.store, turn.id, text, {
      attemptId: attempt.attemptId,
      agentSessionId: prepared.agentSessionId,
      sessionCompatibilityKey: prepared.sessionCompatibilityKey,
      agentSetup,
      requestId,
      triggerActor: actor,
      workspaceRoots: [],
    })
  );
  const retained = f.store.getTurnById(turn.id);
  expect(retained.status).toBe('completed');
  expect(f.store.listArtifacts(f.workspace.id)).toEqual([
    expect.objectContaining({
      content: { body: 'Simulator answer: Concise', format: 'markdown' },
      lastMutationRequestId: requestId,
    }),
  ]);
  await shutdownControlStoreWorkerClient();
  closeWorkspaceProductReadHandles(f.dataRoot);
  fence.stop();
  expect(new FsStore({ dataRoot: f.dataRoot }).getTurnById(turn.id)).toEqual(retained);
  closeWorkspaceProductReadHandles(f.dataRoot);
  fence.assert();
});
