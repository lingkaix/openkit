import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { WorkerOptions } from 'node:worker_threads';
import { allocateEntityId, deriveEntityId } from '@openkit/protocol';
import { expect, it, onTestFinished, vi } from 'vitest';
import { getArtifactReview } from '../artifact-reviews.js';
import { initializeDefaultKnowledgeBaseId } from '../config/knowledge-base.js';
import { FsStore } from '../lib/store.js';
import { closeRetrievalServices } from '../retrieval-service.js';
import { FileStorageAdmission } from '../storage/artifacts/file-admission.js';
import { artifactFilePayloadPath } from '../storage/artifacts/file-records.js';
import { controlStoreFor } from '../storage/control-store.js';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { resolveAgentEnvironmentPackage } from '../test-support/prepared-agent-environment.js';
import {
  createExecutionStepJournalReader,
  WORKSPACE_WORKER_TURN_EXECUTION_DEFINITION,
  writeExecutionJournalIntent,
} from './execution-journal.js';
import type { ExecutionJournalSpan } from './execution-step-journal.js';
import { dispatchOpenkitWorkTool } from './openkit-work-mcp.js';
import type { WorkerArtifactCapture } from './worker-governance-backend.js';

const native = vi.hoisted(() => ({ buffer: undefined as SharedArrayBuffer | undefined }));

// Decorate the real worker only to observe SQL writer identity and hold a real COMMIT's ACK.
// SQL, transaction bodies, SQLite results and transport replies are never replaced.
vi.mock('node:worker_threads', async (load) => {
  const actual = await load<typeof import('node:worker_threads')>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(filename: string | URL, options?: WorkerOptions) {
        if (!native.buffer) {
          super(filename, options);
          return;
        }
        const prelude = `
          const {workerData,threadId}=require('node:worker_threads');
          const Database=require(workerData.databaseModule);
          const state=new Int32Array(workerData.buffer), registered=new WeakSet();
          const register=db=>{
            if(registered.has(db)) return;
            registered.add(db);
            db.function('fixture_submission_writer',kind=>{
              Atomics.add(state,kind===3?10:kind===1?6:7,1);
              const prior=Atomics.compareExchange(state,8,0,threadId);
              if(prior!==0 && prior!==threadId) Atomics.store(state,9,1);
              return 0;
            });
          };
          const prepare=Database.prototype.prepare, exec=Database.prototype.exec;
          Database.prototype.prepare=function(sql){register(this);return prepare.call(this,sql)};
          Database.prototype.exec=function(sql){
            register(this);
            const result=exec.call(this,sql);
            if(/^COMMIT$/i.test(sql) && Atomics.compareExchange(state,0,1,0)===1){
              Atomics.store(state,1,1);
              Atomics.wait(state,2,0,10000);
              Atomics.store(state,3,1);
            }
            return result;
          };
        `;
        super(
          prelude +
            (options?.eval ? String(filename) : `import(${JSON.stringify(String(filename))});`),
          {
            ...options,
            eval: true,
            workerData: {
              databaseModule: createRequire(import.meta.url).resolve('better-sqlite3'),
              buffer: native.buffer,
            },
          }
        );
      }
    },
  };
});

/** Uses acknowledged public Store setup and the real Work owner; only external capture is doubled. */
async function fixture() {
  native.buffer = new SharedArrayBuffer(11 * Int32Array.BYTES_PER_ELEMENT);
  const state = new Int32Array(native.buffer);
  const dataRoot = mkdtempSync(join(tmpdir(), 'worker-artifact-tuple-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  initializeDefaultKnowledgeBaseId({
    dataRoot,
    scope: { kind: 'server' },
    knowledgeBaseId: allocateEntityId('kb'),
  });
  let store = new FsStore({ dataRoot });
  const workspace = await store.createWorkspace('Submission');
  const thread = await store.createThread(workspace.id, 'Worker output');
  const turn = await store.createTurn(workspace.id, thread.id, 'Produce report', {
    kind: 'user',
    id: userId,
  });
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
  let workspaceDb = openWorkspaceDb(dataRoot, workspace.id);
  workspaceDb.sqlite.function('fixture_submission_writer', (kind) => {
    Atomics.add(state, kind === 3 ? 10 : kind === 1 ? 4 : 5, 1);
    return 0;
  });
  workspaceDb.sqlite.exec(`
    CREATE TRIGGER observe_submission_review AFTER INSERT ON artifact_reviews
    BEGIN SELECT fixture_submission_writer(1); END;
    CREATE TRIGGER observe_submission_receipt AFTER INSERT ON idempotency_requests
    WHEN NEW.command_name='artifact.submit'
    BEGIN SELECT fixture_submission_writer(2); END;
  `);
  const bytes = Buffer.from('Finished report\n');
  const captureArtifact = vi.fn<WorkerArtifactCapture>(async () => ({
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
  }));
  const fileAdmission = new FileStorageAdmission(dataRoot, () => 0n);
  // Observe, without replacing, the existing owner promises so a broken detached write cannot
  // escape the test or continue after its private database is removed.
  let creations = vi.spyOn(store, 'createArtifact');
  const drain = () =>
    Promise.allSettled(
      creations.mock.results.flatMap((result) => (result.type === 'return' ? [result.value] : []))
    );
  const release = () => {
    Atomics.store(state, 2, 1);
    Atomics.notify(state, 2);
  };
  onTestFinished(async () => {
    release();
    await drain();
    await shutdownControlStoreWorkerClient();
    await closeRetrievalServices();
    vi.restoreAllMocks();
    native.buffer = undefined;
    workspaceDb.sqlite.close();
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
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
  const snapshot = () => ({
    artifacts: store.listArtifacts(workspace.id).map((artifact) => artifact.id),
    references: store
      .listThreadItems(workspace.id, thread.id)
      .filter((item) => item.type === 'artifact-reference')
      .map((item) => item.artifactId),
    reviews: workspaceDb.sqlite.prepare('SELECT artifact_id FROM artifact_reviews').pluck().all(),
    receipts: workspaceDb.sqlite
      .prepare("SELECT response_id FROM idempotency_requests WHERE command_name='artifact.submit'")
      .pluck()
      .all(),
  });
  const reopen = async () => {
    await drain();
    await shutdownControlStoreWorkerClient();
    workspaceDb.sqlite.close();
    workspaceDb = openWorkspaceDb(dataRoot, workspace.id);
    store = new FsStore({ dataRoot });
    creations = vi.spyOn(store, 'createArtifact');
  };
  return {
    get store() {
      return store;
    },
    get workspaceDb() {
      return workspaceDb;
    },
    state,
    dataRoot,
    workspace,
    thread,
    turn,
    bytes,
    environmentPackage,
    captureArtifact,
    submit,
    snapshot,
    reopen,
    drain,
    release,
    id: (requestId: string) =>
      deriveEntityId('ar', [environmentPackage.snapshotId, turn.id, requestId]),
  };
}

it('acknowledges the complete Artifact, native reference, Review and one original receipt', async () => {
  const f = await fixture();
  const requestId = randomUUID();
  const [result] = await Promise.allSettled([f.submit(requestId)]);
  const atAcknowledgement = f.snapshot();
  await f.drain();
  const id = f.id(requestId);
  expect({ status: result!.status, tuple: atAcknowledgement }).toEqual({
    status: 'fulfilled',
    tuple: { artifacts: [id], references: [id], reviews: [id], receipts: [id] },
  });
  expect(getArtifactReview(f.workspaceDb, id, 1)).toMatchObject({
    sourceThreadId: f.thread.id,
    sourceTurnId: f.turn.id,
    sourceAgentId: f.environmentPackage.agent.agentId,
  });
  expect(
    readFileSync(artifactFilePayloadPath(join(f.dataRoot, 'workspaces', f.workspace.id), id, 1))
  ).toEqual(f.bytes);
});

it.each([
  'artifact_reviews',
  'idempotency_requests',
] as const)('leaves no new tuple or orphan Item after an abort at %s', async (table) => {
  const f = await fixture();
  f.workspaceDb.sqlite.exec(`CREATE TRIGGER reject_submission
    BEFORE INSERT ON ${table}
    ${table === 'idempotency_requests' ? "WHEN NEW.command_name='artifact.submit'" : ''}
    BEGIN SELECT fixture_submission_writer(3); SELECT RAISE(ABORT,'submission rejected'); END`);
  const [result] = await Promise.allSettled([f.submit(randomUUID())]);
  expect(result!.status).toBe('rejected');
  expect(Atomics.load(f.state, 10)).toBe(1);
  await f.drain();
  const live = f.snapshot();
  const reopened = await f
    .reopen()
    .then(() => f.snapshot())
    .catch((error: Error) => ({
      reopenError: error.message,
    }));
  expect({ live, reopened }).toEqual({
    live: { artifacts: [], references: [], reviews: [], receipts: [] },
    reopened: { artifacts: [], references: [], reviews: [], receipts: [] },
  });
});

it('keeps competing submissions on one native writer while its real commit acknowledgement is held', async () => {
  const f = await fixture();
  const firstId = randomUUID();
  const secondId = randomUUID();
  Atomics.store(f.state, 0, 1);
  let firstSettled = false;
  let secondSettled = false;
  const first = Promise.allSettled([f.submit(firstId)]).then((result) => {
    firstSettled = true;
    return result;
  });
  let second: typeof first | undefined;
  try {
    await vi.waitFor(() => expect(Atomics.load(f.state, 1)).toBe(1));
    second = Promise.allSettled([f.submit(secondId)]).then((result) => {
      secondSettled = true;
      return result;
    });
    // Write And Space Budget keeps one Turn's commits in order through FULL ACK.
    // Artifact capture stays independent of that ordered SQL publication boundary.
    await vi.waitFor(() => expect(f.captureArtifact).toHaveBeenCalledTimes(2));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect({ firstSettled, secondSettled }).toEqual({ firstSettled: false, secondSettled: false });
    expect(Atomics.load(f.state, 3)).toBe(0);
    expect({
      nativeReviews: Atomics.load(f.state, 6),
      nativeReceipts: Atomics.load(f.state, 7),
    }).toEqual({ nativeReviews: 1, nativeReceipts: 1 });
    expect({
      mainReviews: Atomics.load(f.state, 4),
      mainReceipts: Atomics.load(f.state, 5),
      differentNativeWriters: Atomics.load(f.state, 9),
    }).toEqual({ mainReviews: 0, mainReceipts: 0, differentNativeWriters: 0 });
  } finally {
    f.release();
    await first;
    await second;
    await f.drain();
  }
  expect((await first)[0]!.status).toBe('fulfilled');
  expect((await second!)[0]!.status).toBe('fulfilled');
  const ids = [f.id(firstId), f.id(secondId)].sort();
  await f.reopen();
  for (const members of Object.values(f.snapshot())) expect([...members].sort()).toEqual(ids);
  expect(Atomics.load(f.state, 8)).toBeGreaterThan(0);
  expect({
    nativeReviews: Atomics.load(f.state, 6),
    nativeReceipts: Atomics.load(f.state, 7),
    differentNativeWriters: Atomics.load(f.state, 9),
  }).toEqual({ nativeReviews: 2, nativeReceipts: 2, differentNativeWriters: 0 });
});

it('replays the same single acknowledged outcome after a cold reopen without recapturing bytes', async () => {
  const f = await fixture();
  const requestId = randomUUID();
  const [first] = await Promise.allSettled([f.submit(requestId)]);
  await f.reopen();
  const [replay] = await Promise.allSettled([f.submit(requestId)]);
  const id = f.id(requestId);
  expect(f.captureArtifact).toHaveBeenCalledTimes(1);
  expect({ first: first!.status, replay: replay!.status, tuple: f.snapshot() }).toEqual({
    first: 'fulfilled',
    replay: 'fulfilled',
    tuple: { artifacts: [id], references: [id], reviews: [id], receipts: [id] },
  });
  expect(replay).toEqual(first);
});

/** Admits the terminal and cleanup intents through the journal owner, without bypassing its seal guard. */
async function terminalPublication(f: Awaited<ReturnType<typeof fixture>>) {
  const started = BigInt(Date.now()) * 1_000_000n;
  const span = (id: number): ExecutionJournalSpan & { endTimeUnixNano: null } => ({
    traceId: '1'.repeat(32),
    spanId: id.toString(16).padStart(16, '0'),
    flags: 1,
    name: 'Private Artifact terminal',
    kind: 'INTERNAL',
    startTimeUnixNano: started,
    endTimeUnixNano: null,
    status: { code: 'UNSET' },
    attributes: [],
    droppedAttributesCount: 0,
    events: [],
    droppedEventsCount: 0,
    links: [],
    droppedLinksCount: 0,
    instrumentationScope: {
      name: 'openkit.artifact-test',
      attributes: [],
      droppedAttributesCount: 0,
    },
    resource: { attributes: [], droppedAttributesCount: 0 },
  });
  const execution = {
    ref: { owner: f.turn.owner, executionId: randomUUID() },
    definitionVersion: WORKSPACE_WORKER_TURN_EXECUTION_DEFINITION,
    workId: f.turn.id,
    fingerprint: 'a'.repeat(64),
    exclusionRefs: [f.environmentPackage.scope.agentSessionId],
    span: span(1),
  };
  for (const [index, kind] of (['terminal-publication', 'inspect-cleanup'] as const).entries()) {
    controlStoreFor(f.workspaceDb.sqlite).write(() =>
      writeExecutionJournalIntent(f.workspaceDb, {
        execution,
        stepId: kind,
        parentStepId: null,
        parent: null,
        inspectedStep: null,
        carriage: { operation: kind, requestId: randomUUID(), sequence: null, bindingRef: null },
        control: {
          definitionVersion: execution.definitionVersion,
          kind,
          target: null,
          workId: f.turn.id,
          operationId: null,
          attemptId: null,
          invocationId: randomUUID(),
          actor: f.turn.triggerActor,
          inputRefs: [],
          outputRefs: [],
          fingerprint: 'b'.repeat(64),
          permittingDecisionRef: null,
          authorityRefs: [],
          retryDeclarationRef: null,
          retryPermitted: false,
          deadlineUnixNano: started + 60_000_000_000n,
          physicalFenceRefs: [],
        },
        span: { ...span(index + 2), parentSpanId: execution.span.spanId },
      })
    );
  }
  const root = await createExecutionStepJournalReader(f.workspaceDb, f.turn.owner).readExecution(
    execution.ref
  );
  const at = new Date().toISOString();
  return {
    execution: {
      executionId: execution.ref.executionId,
      expectedRevision: root.revision,
      terminalStepId: 'terminal-publication',
      cleanupStepId: 'inspect-cleanup',
    },
    evidence: [
      {
        id: randomUUID(),
        workspaceId: f.workspace.id,
        threadId: f.thread.id,
        turnId: f.turn.id,
        goalId: null,
        taskId: null,
        agentSessionId: f.environmentPackage.scope.agentSessionId,
        backendType: null,
        backendVersion: null,
        placement: 'unknown' as const,
        phase: 'checkpoint' as const,
        summary: 'Private local submission completed',
        policyDigest: null,
        workerImage: null,
        sandboxSummary: null,
        capabilitySummary: null,
        uploadManifest: [],
        downloadManifest: [],
        transcriptSummary: null,
        workspaceChangeSummary: null,
        controlSummary: 'Terminal publication; cleanup remains pending',
        outcome: 'succeeded' as const,
        exitCode: null,
        signal: null,
        stopReason: null,
        errorCode: null,
        errorMessage: null,
        redactedStdoutSummary: null,
        redactedStderrSummary: null,
        evidenceBundleIds: [],
        contentDigests: [],
        requiredFeatures: ['runtime.evidence.v1'],
        createdAt: at,
        startedAt: at,
        completedAt: at,
        collectedAt: at,
      },
    ],
  };
}

it('publishes the complete Artifact tuple before a real native Turn seal and refuses late submission', async () => {
  const f = await fixture();
  const publication = await terminalPublication(f);
  const seal = () =>
    f.store.completeTurn(
      f.turn.id,
      { status: 'completed', completedAt: new Date().toISOString() },
      publication
    );
  let sealing: ReturnType<typeof seal> | undefined;
  const requestId = randomUUID();
  const publications: { event: string; status: string; tuple: ReturnType<typeof f.snapshot> }[] =
    [];
  f.store.addTurnListener(f.turn.id, (event) => {
    publications.push({
      event: event.event,
      status: f.store.getTurnById(f.turn.id).status,
      tuple: f.snapshot(),
    });
    if (event.event === 'artifact.created') sealing = seal();
  });
  await Promise.allSettled([f.submit(requestId)]);
  await f.drain();
  await (sealing ?? seal());
  expect(f.store.getTurnById(f.turn.id).status).toBe('completed');
  await expect(f.submit(randomUUID())).rejects.toMatchObject({ code: 'turn_not_active' });
  expect(f.captureArtifact).toHaveBeenCalledTimes(1);
  const id = f.id(requestId);
  expect(publications).toEqual(
    ['item.created', 'item.completed', 'artifact.created'].map((event) => ({
      event,
      status: 'running',
      tuple: { artifacts: [id], references: [id], reviews: [id], receipts: [id] },
    }))
  );
  expect(f.store.getTurnEvents(f.turn.id).map((event) => event.event)).toEqual([
    ...publications.map((event) => event.event),
    'turn.completed',
  ]);
});
