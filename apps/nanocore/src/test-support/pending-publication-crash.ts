import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { type FileHandle, open } from 'node:fs/promises';
import { connect as connectHttp2, createServer as createHttp2Server } from 'node:http2';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type Database from 'better-sqlite3';
import { createApp } from '../app.js';
import { importArtifactFile } from '../artifact-file-commands.js';
import {
  createNanoHostTransportSessionAuthority,
  readNanoHostPhysicalConnectionContext,
} from '../auth/nanohost-transport-session.js';
import {
  createInMemoryRuntimeConfigSnapshot,
  type RuntimeConfigManager,
} from '../config/runtime-config.js';
import { SimulatedTurnExecutor } from '../lib/simulator.js';
import { FsStore } from '../lib/store.js';
import { ProviderRegistry } from '../providers/registry.js';
import { allocateNanoHostRuntimeTargetConnectionGeneration } from '../runtime/nanohost-runtime-target.js';
import { createNanoHostSessionDispatch } from '../runtime/nanohost-session-dispatch.js';
import {
  raiseRecordedPendingRequest,
  recoverPendingRequestsAtBoot,
} from '../runtime/pending-request-flow.js';
import {
  pendingRequestItemId,
  readPendingRequest,
  validateCanonicalLoad,
} from '../runtime/pending-requests.js';
import { startProductTurn } from '../runtime/product-turn-start.js';
import { runSchedulerDispatchLoop } from '../runtime/scheduler-dispatch-loop.js';
import { createConfiguredWorkerLifecycleRuntime } from '../runtime/turn-executor-factory.js';
import { readWorkerImageSettlement } from '../runtime/worker-image-settlements.js';
import { listSchedulerAdmissionEntriesForWorkspace } from '../scheduler-records.js';
import { FileStorageAdmission } from '../storage/artifacts/file-admission.js';
import { artifactFilePayloadPath } from '../storage/artifacts/file-records.js';
import { listExistingWorkspaceDatabaseScopes, openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { readDataRootLayoutMarker, workspaceDbPath } from '../storage/fs-layout.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import {
  createWorkerEnvironmentActivation,
  type ReplaceWorkerEnvironmentResidentWork,
} from '../worker-environments/worker-environment-activation.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { createTestAgentSetup, createTestGatewayConfig } from './agent-environment.js';
import { createDemoStore } from './demo-store.js';
import { ensureLocalUser } from './local-user.js';
import { admitTestNativeEnvironment } from './native-environment.js';
import { operationRequest } from './operation-request.js';

/** Loses only Core process state after a refused server image write, then observes ordinary discovery with a retained external result. */
async function probeServerImageSettlement(): Promise<void> {
  const { effect, result } = JSON.parse(process.argv[5]!);
  const authority = createNanoHostTransportSessionAuthority();
  const fileAdmission = new FileStorageAdmission(dataRoot, () => 0n);
  const dispatch = createNanoHostSessionDispatch({
    coreDb,
    fileAdmission,
    sessionAuthority: authority,
  });
  const identity = {
    deploymentId: readDataRootLayoutMarker(dataRoot).deploymentId,
    identityId: 'host-image-restart',
    targetId: 'host-image-restart',
  };
  const target = allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
    ...identity,
    observedAt: new Date().toISOString(),
  });
  let resolveConnected!: (value: object) => void;
  let rejectConnected!: (reason: Error) => void;
  const connected = new Promise<object>((resolve, reject) => {
    resolveConnected = resolve;
    rejectConnected = reject;
  });
  const server = createHttp2Server((request, response) => {
    const physical = readNanoHostPhysicalConnectionContext(request);
    if (physical) resolveConnected(physical);
    else rejectConnected(new Error('Native H2 physical context is missing.'));
    response.writeHead(204).end();
  });
  let client: ReturnType<typeof connectHttp2> | undefined;
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing image fixture address.');
    client = connectHttp2(`http://127.0.0.1:${address.port}`);
    client.request({ ':method': 'POST', ':path': '/' }).end();
    const physical = await connected;
    authority.admit({
      connectionGeneration: target.connectionGeneration,
      identityId: identity.identityId,
      physicalConnection: physical,
    });
    await dispatch.readiness!(
      physical,
      Buffer.from(JSON.stringify({ physicalEpoch: 'a'.repeat(64) })),
      { coreDb, ...identity }
    );
    if (!authority.mayCarryWork(physical))
      throw new Error('Image fixture connection is not admitted.');
    const scopes = listExistingWorkspaceDatabaseScopes(dataRoot);
    if (scopes.length)
      throw new Error('Server-only fixture unexpectedly contains a Workspace database.');
    if (phase === 'before-local-result') {
      const pending = dispatch.effect(effect).then(
        () => null,
        (error: unknown) => error
      );
      const command = await dispatch.poll(physical, 'image.acquire');
      if (
        !command ||
        command.requestId !== effect.requestId ||
        command.imageReference !== effect.input.imageReference
      )
        throw new Error('Image effect delivery checkpoint was not reached.');
      // This targets the actual writer on the frozen main, not a future main-thread read connection.
      coreDb.sqlite.exec('PRAGMA query_only = ON');
      let refusal: unknown;
      try {
        await dispatch.result(physical, 'image.acquire', result);
      } catch (error) {
        refusal = error;
      }
      const deferred = await pending;
      if (
        (refusal as { status?: number } | undefined)?.status !== 503 ||
        !deferred ||
        typeof deferred !== 'object' ||
        !('code' in deferred) ||
        deferred.code !== 'recovery_required'
      )
        throw new Error('Server image persistence fault was not reached.');
      if (readWorkerImageSettlement(coreDb, effect.requestId) !== null)
        throw new Error('Image result unexpectedly committed before process loss.');
      writeSync(
        1,
        `${JSON.stringify({ checkpoint: 'server-image-result-before-local-store', command, workspaceScopes: scopes })}\n`
      );
      process.kill(process.pid, 'SIGKILL');
      throw new Error('Image fixture missed SIGKILL.');
    }
    if (phase !== 'ordinary-restart') throw new Error('Unknown server image fixture phase.');
    const serverStore = new FsStore({ dataRoot });
    const runtime = createConfiguredWorkerLifecycleRuntime({
      coreDb,
      env: {},
      store: serverStore,
      fileAdmission,
      nanoHostSessionDispatch: dispatch,
    });
    const backend = runtime.turnExecutor.executionBackend;
    if (!backend) throw new Error('Real runtime has no execution backend.');
    let resolveRegistration!: () => void;
    const registered = new Promise<void>((resolve) => {
      resolveRegistration = resolve;
    });
    const original = dispatch.expectResultOnly;
    const descriptor = Object.getOwnPropertyDescriptor(dispatch, 'expectResultOnly');
    if (!original || !descriptor) throw new Error('Native result-only receiver is missing.');
    let resultOnlyRegistrations = 0;
    const observeRegistration: typeof original = (expectations) => {
      const waiting = original.call(dispatch, expectations);
      resultOnlyRegistrations++;
      resolveRegistration();
      return waiting;
    };
    Object.defineProperty(dispatch, 'expectResultOnly', {
      ...descriptor,
      value: observeRegistration,
    });
    try {
      // Observe the real registration; never install a recovery expectation on behalf of the ordinary owner.
      const pass = runSchedulerDispatchLoop({
        coreDb,
        store: serverStore,
        turnExecutor: runtime.turnExecutor,
        executionBackend: backend,
        agentManifests: [],
        providerRegistry: new ProviderRegistry([]),
        gatewayConfig: createTestGatewayConfig(),
        maxDispatches: 1,
      });
      void pass.catch(() => undefined);
      await Promise.race([pass, registered]);
      let resultError: { status: number | null; message: string } | null = null;
      try {
        await dispatch.result(physical, 'image.acquire', result);
      } catch (error) {
        resultError = {
          status: (error as { status?: number } | null)?.status ?? null,
          message: error instanceof Error ? error.message : String(error),
        };
      }
      const nextCommand = await dispatch.poll(physical, 'image.acquire');
      const ordinaryPass = await pass;
      console.log(
        JSON.stringify({
          workspaceScopes: listExistingWorkspaceDatabaseScopes(dataRoot),
          resultOnlyRegistrations,
          resultError,
          nextCommand,
          ordinaryPass,
          settlement: readWorkerImageSettlement(coreDb, effect.requestId),
        })
      );
    } finally {
      Object.defineProperty(dispatch, 'expectResultOnly', descriptor);
    }
  } finally {
    client?.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** Crosses real activation and product-admission owners, with configuration and image observations outside the tested boundary. */
async function probeCrossWorkspaceActivation(): Promise<void> {
  const fixture = JSON.parse(process.argv[5]!);
  const { pair, request, actor } = fixture;
  const manifest = createTestAgentSetup({
    agentId: request.target.agentId,
    imageRef: pair.resolved.image.digest,
  }).manifest;
  const providerRegistry = new ProviderRegistry([
    {
      baseUrl: 'http://127.0.0.1:11434/v1',
      defaultModel: 'openai/gpt-5.2',
      displayName: 'Activation fixture provider',
      id: 'agent-openrouter',
      kind: 'local',
      models: ['openai/gpt-5.2'],
      modelMetadata: { 'openai/gpt-5.2': { temperature: false } },
    },
  ]);
  const snapshot = createInMemoryRuntimeConfigSnapshot({
    agentManifests: [manifest],
    dataRoot: null,
    gatewayConfig: createTestGatewayConfig(),
    providerRegistry,
  });
  const executor = new SimulatedTurnExecutor({ coreDb });
  const observeTarget = () => ({
    turns: store.listThreadTurns(request.replaceNow.workspaceId, request.replaceNow.threadId),
    admissions: listSchedulerAdmissionEntriesForWorkspace(coreDb, {
      workspaceId: request.replaceNow.workspaceId,
      statuses: ['queued', 'admitted', 'denied', 'cancelled'],
    }),
    receipts: db.sqlite
      .prepare('SELECT * FROM idempotency_requests WHERE request_id = ?')
      .all(request.requestId),
  });
  if (phase === 'inspect') {
    const target = observeTarget();
    const sourceReads: string[] = [];
    const selected: Array<string | null> = [];
    const prototype = Object.getPrototypeOf(coreDb.sqlite);
    const originalPrepare = prototype.prepare;
    prototype.prepare = function (this: Database.Database, sql: string) {
      if (
        this.name === workspaceDbPath(dataRoot, pair.workspaceId) &&
        /SELECT[\s\S]*idempotency_requests/i.test(sql)
      )
        sourceReads.push(sql);
      return originalPrepare.call(this, sql);
    };
    let dispatchResult: unknown;
    let dispatchError: string | null = null;
    try {
      dispatchResult = await runSchedulerDispatchLoop({
        coreDb,
        store,
        turnExecutor: executor,
        executionBackend: executor.executionBackend,
        agentManifests: [manifest],
        providerRegistry,
        gatewayConfig: snapshot.gatewayConfig,
        dependencies: { providerCredentialResolver: () => null },
        maxDispatches: 2,
        onDispatchAttribution(id) {
          selected.push(id);
          throw new Error('activation-test-stop-before-physical-effects');
        },
      });
    } catch (error) {
      dispatchError = error instanceof Error ? error.message : String(error);
      if (dispatchError !== 'activation-test-stop-before-physical-effects') throw error;
    } finally {
      prototype.prepare = originalPrepare;
    }
    console.log(JSON.stringify({ target, selected, sourceReads, dispatchResult, dispatchError }));
    return;
  }
  if (phase === 'before-source-outcome') {
    admitTestNativeEnvironment(coreDb, manifest);
  }
  const acceptedTurnIds: string[] = [];
  // Same-key target admission remains permitted on replay; the existing callback stops before physical preparation.
  const admitTarget: ReplaceWorkerEnvironmentResidentWork = async (input) => {
    const observedAcceptance = new Error('activation-test-observed-durable-acceptance');
    try {
      await startProductTurn({
        coreDb,
        store,
        turnExecutor: executor,
        snapshot,
        workerPlacement: 'local',
        providerCredentialResolver: () => null,
        triggerActor: { kind: 'user', id: input.actor.userId },
        requestActor: input.actor,
        requestedAgentId: input.target.agentId,
        workerStorageChoice: {
          kind: 'selected',
          storageRef: input.affectedStorage[0]!.storageRef,
          expectedRevision: input.affectedStorage[0]!.expectedRevision,
          purpose: 'work',
          goalId: null,
          taskId: null,
        },
        input: {
          requestId: input.requestId,
          workspaceId: input.replaceNow.workspaceId,
          threadId: input.replaceNow.threadId,
          input: input.replaceNow.prompt,
        },
        onTurnCreated(turn) {
          acceptedTurnIds.push(turn.id);
          if (phase === 'before-source-outcome') {
            writeSync(
              1,
              `${JSON.stringify({ checkpoint: 'target-admitted-before-source-outcome', turnId: turn.id })}\n`
            );
            process.kill(process.pid, 'SIGKILL');
            throw new Error('Activation fixture missed SIGKILL.');
          }
          throw observedAcceptance;
        },
      });
      throw new Error('Activation fixture missed its acceptance callback.');
    } catch (error) {
      if (error !== observedAcceptance) throw error;
    }
    // Host replacement is outside this fixture; its retained association has not changed.
    return input.affectedStorage.map((ref) => ({ ...ref, disposition: 'unchanged' as const }));
  };
  if (phase === 'target-replay' || phase === 'target-conflict') {
    let errorCode: string | null = null;
    let errorStatus: number | null = null;
    try {
      await admitTarget({
        actor,
        affectedStorage: request.affectedStorage,
        residentMembers: [],
        configuration: { fileId: request.configuration.fileId, revision: fixture.writtenRevision },
        replaceNow: {
          ...request.replaceNow,
          prompt: request.replaceNow.prompt + (phase === 'target-conflict' ? ' changed' : ''),
        },
        requestId: request.requestId,
        resolvedCandidate: request.resolvedCandidate,
        target: request.target,
      });
    } catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error)) throw error;
      errorCode = String(error.code);
      errorStatus = 'status' in error ? Number(error.status) : null;
    }
    console.log(
      JSON.stringify({ errorCode, errorStatus, acceptedTurnIds, target: observeTarget() })
    );
    return;
  }
  let configuration = fixture.configuration;
  const activation = createWorkerEnvironmentActivation({
    coreDb,
    store,
    now: () => fixture.now,
    preparation: { readResolved: () => pair },
    requireCurrentAdministrator: () => undefined,
    runtimeEffects: {
      inspectImage: async () => ({
        imageDigest: pair.resolved.image.digest,
        layout: fixture.layout,
        layoutDigest: `sha256:${'f'.repeat(64)}`,
        environmentDefaults: {
          defaultsDigest: pair.resolved.image.environmentDefaults.defaultsDigest,
          values: {},
        },
      }),
    },
    configFilesForActor: () => ({
      readFile: () => configuration,
      updateFile(input) {
        if (input.expectedRevision !== configuration.file.revision || !input.content)
          throw new Error('Activation fixture CAS failed.');
        configuration = {
          content: input.content,
          file: { ...configuration.file, revision: fixture.writtenRevision },
        };
        return { diagnostics: [], file: configuration.file };
      },
    }),
    reloadRuntimeConfig: () =>
      ({ status: 'applied' }) as ReturnType<RuntimeConfigManager['reload']>,
    replaceResidentWork: admitTarget,
  });
  let response: unknown = null;
  let errorCode: string | null = null;
  try {
    response = await activation.activate({ actor }, request);
  } catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error)) throw error;
    errorCode = String(error.code);
  }
  console.log(JSON.stringify({ response, errorCode, acceptedTurnIds, target: observeTarget() }));
}

// Separate processes cross the actual retained-file/SQLite boundary, not an in-memory restart.
const [mode, phase, retainedRoot] = process.argv.slice(2);
const dataRoot = retainedRoot ?? mkdtempSync(join(tmpdir(), 'pending-publication-crash-'));
const coreDb = openCoreDb(dataRoot);
applyMigrations(coreDb);
if (mode === 'server-image') {
  await probeServerImageSettlement();
  coreDb.sqlite.close();
  process.exit(0);
}
ensureLocalUser(coreDb);
const store = retainedRoot ? new FsStore({ dataRoot }) : createDemoStore({ dataRoot });
const db = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
applyScopedMigrations(db);
if (mode === 'command-commit' || mode === 'artifact-commit' || mode === 'activation-local') {
  if (mode === 'command-commit') await probeCommandCommit();
  else if (mode === 'artifact-commit') await probeArtifactCommit();
  else await probeCrossWorkspaceActivation();
  db.sqlite.close();
  coreDb.sqlite.close();
  process.exit(0);
}
if (retainedRoot) {
  if (mode === 'local-outcome') {
    await probePendingOutcome(readPendingRequest(db.sqlite, 'ap_crash_0')!.raisingTurnId);
    db.sqlite.close();
    coreDb.sqlite.close();
    process.exit(0);
  }
  if (phase === 'before-association' || phase === 'missing-turn') {
    if (phase === 'missing-turn') {
      db.sqlite
        .prepare(
          'UPDATE pending_requests SET publication_turn_id = ? WHERE publication_turn_id IS NOT NULL'
        )
        .run('tu_01890f3e-0000-7000-8000-000000000099');
    }
    const observe = () => ({
      turns: store.listThreadTurns(
        'ws_00000000-0000-7000-8000-000000000001',
        'th_00000000-0000-7000-8000-000000000001'
      ),
      requests: db.sqlite.prepare('SELECT * FROM pending_requests ORDER BY request_id').all(),
      items: store.listThreadItems(
        'ws_00000000-0000-7000-8000-000000000001',
        'th_00000000-0000-7000-8000-000000000001'
      ),
    });
    const before = observe();
    let recoveryCode: string | null = null;
    try {
      recoverPendingRequestsAtBoot(store, {
        coreDb,
        openWorkspace: (id) => openWorkspaceDb(dataRoot, id),
      });
    } catch (error) {
      recoveryCode =
        error && typeof error === 'object' && 'code' in error ? String(error.code) : 'unexpected';
    }
    console.log(JSON.stringify({ recoveryCode, before, after: observe() }));
    db.sqlite.close();
    coreDb.sqlite.close();
    process.exit(0);
  }
  recoverPendingRequestsAtBoot(store, {
    coreDb,
    openWorkspace: (id) => openWorkspaceDb(dataRoot, id),
  });
} else {
  recordWorkspaceOwnerMembership({
    coreDb,
    ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
  });
  const app = createApp({ coreDb, store, dataRoot });
  const now = new Date().toISOString();
  const turn = store.createTurn(
    'ws_00000000-0000-7000-8000-000000000001',
    'th_00000000-0000-7000-8000-000000000001',
    'Crash publication',
    { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
    null
  );
  for (let index = 0; index < 2; index++) {
    const requestId = `ap_crash_${index}`;
    store.createItem({
      id: pendingRequestItemId(requestId, 'request'),
      owner: { kind: 'workspace', workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
      threadId: 'th_00000000-0000-7000-8000-000000000001',
      turnId: turn.id,
      type: 'approval-request',
      status: 'completed',
      approvalRequestId: requestId,
      title: 'Exact command',
      description: 'One command.',
      kind: 'permission',
      createdAt: now,
      completedAt: now,
    });
    raiseRecordedPendingRequest(store, db.sqlite, {
      requestId,
      requestItemId: pendingRequestItemId(requestId, 'request'),
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      threadId: 'th_00000000-0000-7000-8000-000000000001',
      raisingTurnId: turn.id,
      kind: 'approval',
      requesterKind: 'person',
      responsibleUserId: 'usr_00000000-0000-7000-8000-000000000001',
      approval: { kind: 'permission', title: 'Exact command', description: 'One command.' },
      governedIntent: { operation: 'fixture', index },
      now,
    });
  }
  const respond = (index: number) =>
    app.request(
      ...operationRequest(
        'approval.respond',
        { approvalRequestId: `ap_crash_${index}` },
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            threadId: 'th_00000000-0000-7000-8000-000000000001',
            turnId: turn.id,
            requestId: randomUUID(),
            decision: 'granted',
          }),
        }
      )
    );
  if (
    mode === 'invalidation' ||
    mode === 'shared-closeout' ||
    (mode === 'delivery' && phase === 'between')
  ) {
    for (let index = 0; index < 2; index++) {
      const response = await respond(index);
      if (response.status !== 200) throw new Error(await response.text());
    }
  }
  // Explicitly interrupted barrier is the reviewer's F4 entry point.
  if (mode !== 'invalidation') store.setTurnAdmissionHooks(null);
  if (!(mode === 'delivery' && phase === 'between'))
    store.updateTurn(turn.id, { status: 'completed', completedAt: now });
  if (mode === 'delivery' || mode === 'throw' || mode === 'local-outcome') {
    // Restore the ordinary owner hook before the deciding response command.
    const { installPendingRequestAdmission } = await import('../runtime/pending-request-flow.js');
    installPendingRequestAdmission(store, {
      coreDb,
      openWorkspace: (id) => openWorkspaceDb(dataRoot, id),
    });
  }
  if (mode === 'local-outcome') {
    await probePendingOutcome(turn.id, app);
    db.sqlite.close();
    coreDb.sqlite.close();
    process.exit(0);
  }
  if (phase === 'before-association') {
    const originalCreateTurn = store.createTurn.bind(store);
    store.createTurn = (...args) => {
      // The real canonical write completes, then the process dies before the freeze hook can run.
      store.setTurnAdmissionHooks(null);
      originalCreateTurn(...args);
      console.log(JSON.stringify({ dataRoot }));
      process.exit(23);
    };
  }
  const original = store.createItem.bind(store);
  let writes = 0;
  store.createItem = (item, ...args) => {
    if (
      [0, 1].some(
        (index) => item.causationId === pendingRequestItemId(`ap_crash_${index}`, 'request')
      )
    ) {
      if (writes++ === (phase === 'between' ? 1 : 0) && mode !== 'shared-closeout') {
        if (mode === 'throw')
          throw new Error('review injected publication crash before first outcome Item');
        console.log(JSON.stringify({ dataRoot }));
        process.exit(23);
      }
    }
    return original(item, ...args);
  };
  if (mode === 'delivery' && phase === 'between')
    store.updateTurn(turn.id, { status: 'completed', completedAt: now });
  const response =
    mode === 'delivery' || mode === 'throw'
      ? await respond(0)
      : await app.request(
          ...operationRequest(
            'thread.archive',
            {
              workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
              threadId: 'th_00000000-0000-7000-8000-000000000001',
            },
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
                threadId: 'th_00000000-0000-7000-8000-000000000001',
                requestId: randomUUID(),
              }),
            }
          )
        );
  console.log(JSON.stringify({ responseStatus: response.status, dataRoot }));
}
const records = [0, 1]
  .map((index) => readPendingRequest(db.sqlite, `ap_crash_${index}`)!)
  .map((record) => ({
    requestId: record.requestId,
    delivery: record.delivery,
    state: record.state,
    resolution: record.resolution,
    publicationTurnId: record.publicationTurnId,
    invalidationTurnId: record.invalidationTurnId,
    status: (mode === 'invalidation' ? record.invalidationTurnId : record.publicationTurnId)
      ? store.getTurnById(
          (mode === 'invalidation' ? record.invalidationTurnId : record.publicationTurnId)!
        ).status
      : null,
    items: store
      .listThreadItems(
        'ws_00000000-0000-7000-8000-000000000001',
        'th_00000000-0000-7000-8000-000000000001'
      )
      .filter((item) => item.causationId === record.requestItemId)
      .map((item) => item.type),
    validation: validateCanonicalLoad(
      record,
      store.listThreadTurns(
        'ws_00000000-0000-7000-8000-000000000001',
        'th_00000000-0000-7000-8000-000000000001'
      )
    ),
  }));
console.log(JSON.stringify({ dataRoot, records }));
db.sqlite.close();
coreDb.sqlite.close();

/** Crosses the real product/receipt seam; cold inspection never calls a recovery owner. */
async function probeCommandCommit(): Promise<void> {
  const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
  const requestId = '10000000-0000-4000-8000-000000000101';
  const snapshot = (reader: FsStore) => ({
    threads: reader
      .listThreads(workspaceId)
      .map(({ id, name }) => ({ id, name }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    receipts: db.sqlite
      .prepare(
        'SELECT request_id, response_kind, response_id FROM idempotency_requests WHERE request_id = ?'
      )
      .all(requestId),
  });
  if (phase === 'inspect') {
    console.log(JSON.stringify({ dataRoot, state: snapshot(store) }));
    return;
  }
  if (!retainedRoot) {
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      workspaceId,
    });
  }
  const app = createApp({ coreDb, store, dataRoot });
  console.log(JSON.stringify({ dataRoot, before: snapshot(store) }));
  let checkpoint = false;
  const restore = interceptReceiptWrite(requestId, () => {
    if (phase !== 'before-receipt' && phase !== 'receipt-failure') return;
    checkpoint = true;
    if (phase === 'before-receipt') {
      console.log(JSON.stringify({ dataRoot, checkpoint: 'before-receipt' }));
      process.exit(23);
    }
    throw new Error('Injected local receipt write failure.');
  });
  let response: Response;
  try {
    response = await app.request(
      ...operationRequest(
        'thread.create',
        { workspaceId },
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            workspaceId,
            requestId,
            name:
              phase === 'conflict'
                ? 'Different input under the same request'
                : 'One committed Thread',
          }),
        }
      )
    );
  } finally {
    restore();
  }
  const responseBody: unknown = response.ok ? await response.json() : await response.text();
  if (phase === 'after-commit') {
    console.log(
      JSON.stringify({
        dataRoot,
        checkpoint: 'response-ready',
        responseStatus: response.status,
        responseBody,
      })
    );
    process.exit(23);
  }
  console.log(
    JSON.stringify({
      dataRoot,
      checkpoint,
      responseStatus: response.status,
      responseBody,
      commandFailed: !response.ok,
      live: snapshot(store),
      cold: snapshot(new FsStore({ dataRoot })),
    })
  );
}

/** Observes the native receipt statement on real connections without replacing either owner. */
function interceptReceiptWrite(requestId: string, crossing: () => void): () => void {
  const prototype = Object.getPrototypeOf(db.sqlite.prepare('SELECT 1')) as Database.Statement;
  const run = prototype.run;
  prototype.run = function (...parameters) {
    if (
      /^\s*INSERT\b/i.test(this.source) &&
      this.source.includes('idempotency_requests') &&
      parameters.includes(requestId)
    )
      crossing();
    return run.apply(this, parameters);
  };
  return () => {
    prototype.run = run;
  };
}

/** Keeps decision, delivery, Items, Turn events and receipts under one independently observed cut. */
async function probePendingOutcome(
  raisingTurnId: string,
  existingApp?: ReturnType<typeof createApp>
): Promise<void> {
  const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
  const threadId = 'th_00000000-0000-7000-8000-000000000001';
  const requestId = '10000000-0000-4000-8000-000000000102';
  const snapshot = (reader: FsStore) => {
    const turns = reader.listThreadTurns(workspaceId, threadId);
    return {
      turns,
      items: reader.listThreadItems(workspaceId, threadId),
      events: turns.flatMap((turn) => reader.getTurnEvents(turn.id)),
      requests: [0, 1].map((index) => readPendingRequest(db.sqlite, `ap_crash_${index}`)),
      receipts: db.sqlite
        .prepare(
          'SELECT request_id, command_name, response_kind, response_id FROM idempotency_requests ORDER BY request_key'
        )
        .all(),
    };
  };
  if (phase === 'inspect') {
    console.log(JSON.stringify({ dataRoot, state: snapshot(store) }));
    return;
  }
  const app = existingApp ?? createApp({ coreDb, store, dataRoot });
  console.log(JSON.stringify({ dataRoot, before: snapshot(store) }));
  const notifications: unknown[] = [];
  const unsubscribe = store.addTurnListener(raisingTurnId, (event) => notifications.push(event));
  let checkpoint = false;
  const restore = interceptReceiptWrite(requestId, () => {
    if (phase !== 'before-receipt' && phase !== 'receipt-failure') return;
    checkpoint = true;
    if (phase === 'before-receipt') {
      console.log(JSON.stringify({ dataRoot, checkpoint: 'before-receipt' }));
      process.exit(23);
    }
    throw new Error('Injected Pending Request receipt write failure.');
  });
  let response: Response;
  try {
    response = await app.request(
      ...operationRequest(
        'approval.respond',
        { approvalRequestId: 'ap_crash_0' },
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            workspaceId,
            threadId,
            turnId: raisingTurnId,
            requestId,
            decision: phase === 'conflict' ? 'denied' : 'granted',
          }),
        }
      )
    );
  } finally {
    restore();
    unsubscribe();
  }
  const responseBody: unknown = response.ok ? await response.json() : await response.text();
  if (phase === 'after-commit') {
    console.log(
      JSON.stringify({
        dataRoot,
        checkpoint: 'response-ready',
        responseStatus: response.status,
        responseBody,
      })
    );
    process.exit(23);
  }
  console.log(
    JSON.stringify({
      dataRoot,
      checkpoint,
      responseStatus: response.status,
      responseBody,
      notifications,
      live: snapshot(store),
      cold: snapshot(new FsStore({ dataRoot })),
    })
  );
}

/** Composes the real streamed Storage producer and Artifact/receipt consumer across native faults. */
async function probeArtifactCommit(): Promise<void> {
  const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
  const userId = 'usr_00000000-0000-7000-8000-000000000001';
  const requestId = '10000000-0000-4000-8000-000000000103';
  const bytes = Buffer.from('00ff800d0a', 'hex');
  const title = 'Immutable handoff original';
  const snapshot = (reader: FsStore) => {
    const artifacts = reader.listArtifacts(workspaceId);
    const target = artifacts.find((artifact) => artifact.title === title);
    return {
      artifacts: artifacts
        .map(({ id, version, contentDigest }) => ({ id, version, contentDigest }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      receipts: db.sqlite
        .prepare(
          'SELECT request_id, response_kind, response_id FROM idempotency_requests WHERE request_id = ?'
        )
        .all(requestId),
      payload: target
        ? {
            content: reader.getArtifact(workspaceId, target.id).content,
            hex: readFileSync(
              artifactFilePayloadPath(
                join(dataRoot, 'workspaces', workspaceId),
                target.id,
                target.version
              )
            ).toString('hex'),
          }
        : null,
    };
  };
  if (phase === 'inspect') {
    console.log(JSON.stringify({ dataRoot, state: snapshot(store) }));
    return;
  }
  console.log(JSON.stringify({ dataRoot, before: snapshot(store) }));
  const probePath = join(dataRoot, '.sync-probe');
  const handle = await open(probePath, 'wx');
  const handlePrototype = Object.getPrototypeOf(handle) as FileHandle;
  await handle.close();
  rmSync(probePath);
  const sync = handlePrototype.sync;
  let contentSynchronized = false;
  let checkpoint: string | null = null;
  // Directory synchronization remains real. The fixture has one five-byte content file.
  handlePrototype.sync = async function () {
    const stat = await this.stat();
    if (stat.isFile() && stat.size === bytes.length) {
      if (phase === 'before-sync') {
        console.log(
          JSON.stringify({ dataRoot, checkpoint: 'before-content-sync', contentSynchronized })
        );
        process.exit(23);
      }
      if (phase === 'sync-failure') {
        checkpoint = 'content-sync-failure';
        throw new Error('Injected content synchronization failure.');
      }
      await sync.call(this);
      contentSynchronized = true;
      return;
    }
    await sync.call(this);
  };
  const restore = interceptReceiptWrite(requestId, () => {
    if (phase !== 'before-receipt' && phase !== 'receipt-failure') return;
    checkpoint = 'before-receipt';
    if (phase === 'before-receipt') {
      console.log(JSON.stringify({ dataRoot, checkpoint, contentSynchronized }));
      process.exit(23);
    }
    throw new Error('Injected Artifact receipt write failure.');
  });
  let result: Awaited<ReturnType<typeof importArtifactFile>> | undefined;
  let failure: string | undefined;
  try {
    result = await importArtifactFile({
      store,
      workspaceDb: db,
      admission: new FileStorageAdmission(dataRoot, () => 0n),
      inflightCommands: new WeakMap(),
      metadata: {
        workspaceId,
        requestId,
        title,
        mediaType: 'application/octet-stream',
        byteLength: bytes.length,
        contentDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      },
      source: Readable.from([bytes]),
      // Authorization is outside this storage fault; both data owners remain real.
      assertAuthorized: () => {},
      context: {
        kind: 'public',
        actor: { kind: 'session', userId },
        actorRef: { kind: 'user', id: userId },
        scope: { kind: 'workspace', workspaceId },
      },
    });
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    restore();
    handlePrototype.sync = sync;
  }
  if (phase === 'after-commit') {
    console.log(
      JSON.stringify({ dataRoot, checkpoint: 'result-ready', contentSynchronized, result, failure })
    );
    process.exit(23);
  }
  console.log(
    JSON.stringify({
      dataRoot,
      checkpoint,
      contentSynchronized,
      result,
      failure,
      live: snapshot(store),
      cold: snapshot(new FsStore({ dataRoot })),
    })
  );
}
