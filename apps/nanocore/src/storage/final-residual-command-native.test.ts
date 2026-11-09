import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Worker as NativeWorker } from 'node:worker_threads';
import { allocateEntityId, deriveEntityId, writeRetainedV1 } from '@openkit/protocol';
import { expect, it, onTestFinished, vi } from 'vitest';
import {
  createOpenKitAccessTokenRecord,
  revokeOpenKitAccessTokenRecord,
} from '../auth/access-token-store.js';
import { DeploymentAdminRequiredError } from '../auth/operation-authorizer.js';
import { createAdministrationConfiguration } from '../config/administration-configuration.js';
import { createRuntimeConfigManager } from '../config/runtime-config.js';
import { RuntimeConfigFileService } from '../config/runtime-config-files.js';
import { commandRequestKey, FsStore, quickChatWorkspaceIdForUser } from '../lib/store.js';
import { createOperationInvocation } from '../operation-composition.js';
import {
  buildFilesystemWorkspaceChangeSet,
  createFilesystemSnapshotManifest,
  stageFilesystemWorkspaceChanges,
} from '../runtime/filesystem-workspace-sync.js';
import { commandInputHash } from '../runtime/idempotent-command.js';
import { listWorkspaceApplyPlans } from '../runtime/workspace-apply-plans.js';
import { listWorkspaceApplyResults } from '../runtime/workspace-apply-results.js';
import { recordFilesystemWorkspaceStagingRoot } from '../runtime/workspace-filesystem-staging.js';
import {
  getWorkspaceSyncReview,
  recordWorkspaceSyncReview,
} from '../runtime/workspace-sync-records.js';
import {
  createSchedulerAdmissionEntry,
  denySchedulerAdmissionEntry,
  requireSchedulerAdmissionEntry,
} from '../scheduler-records.js';
import { createDemoStore, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { recordTestWorkspaceReviewMaterialization } from '../test-support/workspace-sync.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
import { openCoreDb, openWorkspaceDb } from './db.js';
import { applyMigrations } from './migrate.js';

// Core Storage's original independent commits; no fabricated SQL/product result or ACK.
const observation = vi.hoisted(() => ({
  readonly: false,
  workers: [] as NativeWorker[],
  posts: [] as string[],
  // armed stage, reached stage, release, actual synchronous, worker index, SQL-cause bits.
  gate: new SharedArrayBuffer(6 * Int32Array.BYTES_PER_ELEMENT),
  target: new SharedArrayBuffer(65_536),
}));
vi.mock('./db.js', async (load) => {
  const actual = await load<typeof import('./db.js')>();
  function observe<
    T extends ReturnType<typeof actual.openCoreDb> | ReturnType<typeof actual.openWorkspaceDb>,
  >(db: T): T {
    if (observation.readonly) db.sqlite.pragma('query_only=ON');
    const prepare = db.sqlite.prepare.bind(db.sqlite);
    db.sqlite.prepare = ((sql: string) => {
      const statement = prepare(sql),
        run = statement.run.bind(statement);
      statement.run = (...args) => {
        try {
          return run(...args);
        } catch (error) {
          const e = error as { code?: string; message?: string };
          const target = JSON.parse(
            Buffer.from(observation.target).toString('utf8').replace(/\0.*$/s, '') || '{}'
          );
          const receipt = /^\s*INSERT(?:\s+OR\s+REPLACE)?\s+INTO\s+idempotency_requests/i.test(sql);
          const prune = /^\s*DELETE\s+FROM\s+idempotency_requests/i.test(sql);
          const audit = /^\s*INSERT\s+INTO\s+audit_events/i.test(sql);
          if (e.code?.startsWith('SQLITE_CONSTRAINT')) {
            if (
              receipt &&
              args.includes(target.requestId) &&
              e.message === 'Residual receipt INSERT'
            )
              Atomics.or(new Int32Array(observation.gate), 5, 1);
            if (
              prune &&
              e.message === 'Residual receipt DELETE' &&
              prepare('SELECT 1 FROM idempotency_requests WHERE request_id=?').get(target.requestId)
            )
              Atomics.or(new Int32Array(observation.gate), 5, 2);
            if (
              audit &&
              args.includes(target.resource) &&
              args.includes(target.action) &&
              e.message === 'Residual Audit INSERT'
            )
              Atomics.or(new Int32Array(observation.gate), 5, 4);
          }
          if (e.code?.startsWith('SQLITE_READONLY'))
            console.info('Original residual Main SQLite refused', {
              scope: db.scope,
              sqlOperation: /^\s*([a-z]+)/i.exec(sql)?.[1]?.toUpperCase(),
              code: e.code,
            });
          throw error;
        }
      };
      return statement;
    }) as typeof db.sqlite.prepare;
    return db;
  }
  return {
    ...actual,
    openCoreDb: (...args: Parameters<typeof actual.openCoreDb>) =>
      observe(actual.openCoreDb(...args)),
    openWorkspaceDb: (...args: Parameters<typeof actual.openWorkspaceDb>) =>
      observe(actual.openWorkspaceDb(...args)),
  };
});
vi.mock('node:worker_threads', async (load) => {
  const actual = await load<typeof import('node:worker_threads')>();
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(filename: string | URL, options?: import('node:worker_threads').WorkerOptions) {
        const index = observation.workers.length;
        const prelude = String.raw`
        const {workerData}=require('node:worker_threads');
        const Database=require(workerData.residualDatabaseModule);
        const prepare=Database.prototype.prepare, exec=Database.prototype.exec, stages=new WeakMap();
        const gate=workerData.residualGate;
        const target=()=>JSON.parse(Buffer.from(workerData.residualTarget).toString('utf8').replace(/\0.*$/s,'')||'{}');
        const hasReceipt=(db,t)=>!!(t.requestId&&prepare.call(db,'SELECT 1 FROM idempotency_requests WHERE request_id=?').get(t.requestId));
        Database.prototype.prepare=function(sql){
          const statement=prepare.call(this,sql), db=this;
          const receipt=/^\s*INSERT(?:\s+OR\s+REPLACE)?\s+INTO\s+idempotency_requests/i.test(sql);
          const prune=/^\s*DELETE\s+FROM\s+idempotency_requests/i.test(sql);
          const audit=/^\s*INSERT\s+INTO\s+audit_events/i.test(sql);
          if(!receipt&&!prune&&!audit)return statement;
          const run=statement.run;
          statement.run=function(...args){
            const t=target();
            try{
              const result=run.apply(this,args);
              if(receipt&&args.includes(t.requestId))stages.set(db,1);
              if(prune&&hasReceipt(db,t))stages.set(db,2);
              if(audit&&args.includes(t.action)&&args.includes(t.resource)&&(!t.configuration||args.includes(t.requestId)))stages.set(db,t.scheduler?3:4);
              return result;
            }catch(error){
              if(error.code?.startsWith('SQLITE_CONSTRAINT')){
                if(receipt&&args.includes(t.requestId)&&error.message==='Residual receipt INSERT')Atomics.or(gate,5,1);
                if(prune&&error.message==='Residual receipt DELETE'&&hasReceipt(db,t))Atomics.or(gate,5,2);
                if(audit&&args.includes(t.action)&&args.includes(t.resource)&&error.message==='Residual Audit INSERT')Atomics.or(gate,5,4);
              }
              throw error;
            }
          };return statement;
        };
        Database.prototype.exec=function(sql){
          const result=exec.call(this,sql);
          if(!/^COMMIT$/i.test(sql))return result;
          const stage=stages.get(this);stages.delete(this);
          if(!stage||Atomics.compareExchange(gate,0,stage,0)!==stage)return result;
          Atomics.store(gate,3,this.pragma('synchronous',{simple:true}));
          Atomics.store(gate,4,workerData.residualWorkerIndex);
          Atomics.store(gate,1,stage);Atomics.notify(gate,1);Atomics.wait(gate,2,0);
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
              ...options?.workerData,
              residualDatabaseModule: require.resolve('better-sqlite3'),
              residualGate: new Int32Array(observation.gate),
              residualTarget: new Uint8Array(observation.target),
              residualWorkerIndex: index,
            },
          }
        );
        observation.workers.push(this);
      }
      override postMessage(...args: Parameters<NativeWorker['postMessage']>) {
        const value = args[0] as { operation?: string };
        if (typeof value.operation === 'string') observation.posts.push(value.operation);
        return super.postMessage(...args);
      }
    },
  };
});

const kinds = ['configuration', 'review', 'retry', 'cancel'] as const;
type Kind = (typeof kinds)[number];
const receiptKinds = ['configuration', 'review'] as const;
const DAY = 86_400_000;
const gate = () => new Int32Array(observation.gate);
function release() {
  Atomics.store(gate(), 0, 0);
  Atomics.store(gate(), 2, 1);
  Atomics.notify(gate(), 2);
}
function arm(stage: number) {
  Atomics.store(gate(), 1, 0);
  Atomics.store(gate(), 2, 0);
  Atomics.store(gate(), 0, stage);
}
async function held(stage: number, pending: Promise<unknown>) {
  const signal = Atomics.waitAsync(gate(), 1, 0, 5000);
  await Promise.race([
    Promise.resolve(signal.value),
    pending.then(
      () => 'settled',
      () => 'settled'
    ),
  ]);
  expect(
    Atomics.load(gate(), 1),
    'The original operation settled/timed out before its actual COMMIT hold.'
  ).toBe(stage);
  expect(Atomics.load(gate(), 3)).toBe(2);
}
function target(value: unknown) {
  const bytes = Buffer.from(JSON.stringify(value));
  expect(bytes.byteLength).toBeLessThan(observation.target.byteLength);
  new Uint8Array(observation.target).fill(0);
  new Uint8Array(observation.target).set(bytes);
}
function clock() {
  const now = Date.now();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now - 8 * DAY);
  return { lookup: now - 2 * DAY, after: now };
}

async function fixture(kind: Kind) {
  release();
  observation.readonly = false;
  observation.workers.length = 0;
  observation.posts.length = 0;
  gate().fill(0);
  target({});
  const dataRoot = mkdtempSync(join(tmpdir(), 'final-residual-command-'));
  const privateRoots: string[] = [];
  let coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  const token = createOpenKitAccessTokenRecord(coreDb, {
    ownerUserId: userId,
    scope: 'server-admin',
    workspaceIds: [],
    expiresAt: '2999-01-01T00:00:00.000Z',
  });
  const actor = {
    kind: 'token' as const,
    userId,
    tokenId: token.tokenId,
    tokenScope: 'server-admin' as const,
    tokenWorkspaceIds: [],
  };
  let authorityDb = openCoreDb(dataRoot);
  let store = await createDemoStore({ dataRoot });
  const workspaceId =
    kind === 'configuration' ? quickChatWorkspaceIdForUser(userId) : DEMO_WORKSPACE_ID;
  recordWorkspaceOwnerMembership({ coreDb, workspaceId, ownerUserId: userId });
  let db = openWorkspaceDb(dataRoot, workspaceId);
  const thread = await store.createThread(
    workspaceId,
    'Original residual owner',
    allocateEntityId('th'),
    kind === 'configuration' ? 'administration' : 'conversation',
    kind === 'configuration'
      ? { visibility: 'private', privateOwnerUserId: userId }
      : { visibility: 'workspace' }
  );
  const turn = await store.createTurn(
    workspaceId,
    thread.id,
    'Original residual effect',
    { kind: 'user', id: userId },
    null
  );
  const providerPath = join(dataRoot, 'config/providers/residual.provider.jsonc');
  let writes = 0,
    reloads = 0,
    selectedWrites = 0,
    selectedReloads = 0;
  let manager: ReturnType<typeof createRuntimeConfigManager>;
  let service: ReturnType<typeof createAdministrationConfiguration>;
  let invoke: ReturnType<typeof createOperationInvocation>;
  if (kind === 'configuration') {
    mkdirSync(join(dataRoot, 'config/providers'), { recursive: true });
    writeFileSync(join(dataRoot, 'config/server.jsonc'), JSON.stringify({ schemaVersion: 1 }));
    writeFileSync(
      providerPath,
      JSON.stringify(
        writeRetainedV1({
          id: 'codex',
          vendor: 'openai-codex',
          kind: 'oauth',
          displayName: 'Original',
          models: ['gpt-5'],
          modelMetadata: {
            'gpt-5': { limit: { context: 200000, output: 10000 }, tool_call: true },
          },
          extensions: { openkit: { subscriptionAccount: { accountSlotId: 'primary' } } },
        })
      )
    );
    writeFileSync(
      join(dataRoot, 'config/gateway.jsonc'),
      JSON.stringify({
        schemaVersion: 1,
        enabled: true,
        logicalModels: [
          {
            id: 'reasoning',
            displayName: 'Reasoning',
            contextManagement: [{ type: 'compaction', compactThreshold: 8000 }],
            routes: [{ id: 'primary', providerProfileId: 'codex', providerModel: 'gpt-5' }],
          },
        ],
        defaultLogicalModelId: 'reasoning',
      })
    );
  }
  function compose() {
    if (kind === 'configuration') {
      manager = createRuntimeConfigManager({ dataRoot });
      const files = new RuntimeConfigFileService({
        dataRoot,
        userId,
        workspaceIds: [workspaceId],
        runtimeConfigManager: manager,
        readRuntimeConfigStatus: () => manager.status(),
      });
      const update = files.updateFile.bind(files);
      vi.spyOn(files, 'updateFile').mockImplementation(async (...args) => {
        writes++;
        return update(...args);
      });
      service = createAdministrationConfiguration({
        actor,
        coreDb,
        store,
        files,
        reload: async () => {
          reloads++;
          return manager.reload({ mode: 'safe', dryRun: false });
        },
        runtimeConfig: () => manager.current(),
        repositoryWorkspaceDb: (id) => openWorkspaceDb(dataRoot, id),
        inflightCommands: new WeakMap(),
      });
    }
    invoke = createOperationInvocation({
      coreDb,
      store,
      dataRoot,
      inflightCommands: new WeakMap(),
      workspaceMutationAdmission: new WorkspaceMutationAdmission(),
      repositoryWorkspaceDb: (id) => openWorkspaceDb(dataRoot, id),
    });
  }
  compose();
  const pending = new Set<Promise<unknown>>();
  const track = <T>(value: Promise<T>) => {
    pending.add(value);
    void value.then(
      () => pending.delete(value),
      () => pending.delete(value)
    );
    return value;
  };
  onTestFinished(async () => {
    release();
    observation.readonly = false;
    vi.useRealTimers();
    await Promise.allSettled([...pending]);
    await shutdownControlStoreWorkerClient();
    vi.restoreAllMocks();
    for (const handle of [db, coreDb, authorityDb]) if (handle.sqlite.open) handle.sqlite.close();
    for (const root of privateRoots) rmSync(root, { recursive: true, force: true });
    rmSync(dataRoot, { recursive: true, force: true });
  });
  const command =
    kind === 'configuration'
      ? 'administration.configuration.apply'
      : kind === 'review'
        ? 'workspace_sync.review.decide'
        : undefined;
  async function prepare(label = 'subject', requestId: string = randomUUID()) {
    if (kind === 'configuration') {
      const file = join(dataRoot, 'config/providers/residual.provider.jsonc');
      const files = new RuntimeConfigFileService({
        dataRoot,
        userId,
        workspaceIds: [workspaceId],
        runtimeConfigManager: manager,
        readRuntimeConfigStatus: () => manager.status(),
      });
      const proposal = await service.propose(
        {
          targetFamily: 'provider',
          targetId: 'codex',
          expectedRevision: files.readFile('providers/residual.provider.jsonc').file.revision!,
          changes: { displayName: label },
        },
        { threadId: thread.id, turnId: turn.id, requestId: randomUUID() }
      );
      const input = {
        requestId,
        candidate: proposal.candidate,
        confirmation: proposal.confirmation,
      };
      const outcomeId = deriveEntityId('ar', ['configuration_result', { userId, request: input }]);
      return {
        requestId,
        input,
        scope: { actorId: userId, workspaceId, threadId: thread.id },
        responseId: outcomeId,
        resource: 'provider:codex',
        action: 'administration.configuration.apply',
        reviewId: undefined as string | undefined,
        targetRoot: undefined as string | undefined,
        queueEntryId: undefined as string | undefined,
      };
    }
    if (kind === 'review') {
      const root = mkdtempSync(join(tmpdir(), 'residual-review-'));
      privateRoots.push(root);
      const targetRoot = join(root, 'target'),
        workerRoot = join(root, 'worker'),
        stagingRoot = join(root, 'staging');
      for (const path of [targetRoot, workerRoot, stagingRoot]) mkdirSync(path);
      writeFileSync(join(targetRoot, 'review.txt'), 'before\n');
      writeFileSync(join(workerRoot, 'review.txt'), 'after\n');
      const createdAt = new Date().toISOString(),
        id = randomUUID(),
        reviewId = `swr_${id}`;
      const common = { createdAt, resourceId: `fs_${id}`, workspaceId };
      const before = await createFilesystemSnapshotManifest({ ...common, rootPath: targetRoot }),
        after = await createFilesystemSnapshotManifest({ ...common, rootPath: workerRoot });
      const changeSet = buildFilesystemWorkspaceChangeSet({
        before,
        after,
        changeSetId: `wcs_${id}`,
        createdAt,
        inputSnapshotId: `wis_${id}`,
        materializationRecordId: `wmr_${id}`,
      });
      await stageFilesystemWorkspaceChanges({ changeSet, sourceRoot: workerRoot, stagingRoot });
      const item = {
        artifactId: allocateEntityId('ar'),
        changeSet,
        patchPayload: null,
        review: {
          actionCenterRowId: `workspace-review:${reviewId}`,
          changeSetId: changeSet.id,
          createdAt,
          diffSummary: { additions: 1, deletions: 0, filesChanged: 1 },
          id: reviewId,
          riskSummary: 'One owned text file.',
          staging: {
            branch: null,
            ref: `filesystem-staging://${reviewId}`,
            strategy: 'filesystem_staging' as const,
          },
          status: 'pending' as const,
          updatedAt: createdAt,
          validation: [],
          workspaceId,
        },
      };
      recordTestWorkspaceReviewMaterialization(db, item);
      recordWorkspaceSyncReview(db, { item });
      recordFilesystemWorkspaceStagingRoot(db, {
        before,
        changeSetId: changeSet.id,
        createdAt,
        reviewId,
        stagingRootPath: stagingRoot,
        targetRootPath: targetRoot,
        workspaceId,
      });
      const input = { workspaceId, reviewId, requestId, decision: 'accepted' as const };
      return {
        requestId,
        input,
        scope: { workspaceId, reviewId },
        responseId: reviewId,
        resource: `workspace-review:${reviewId}`,
        action: 'workspace.review.decide',
        reviewId,
        targetRoot,
        queueEntryId: undefined as string | undefined,
      };
    }
    const queueEntryId = `queue_${randomUUID()}`;
    createSchedulerAdmissionEntry(coreDb, {
      backendId: 'nanohost',
      queueEntryId,
      requestId: kind === 'retry' ? requestId : `opaque-${requestId}`,
      triggerActor: { kind: 'user', id: userId },
      workspaceId,
      threadId: thread.id,
      turnId: turn.id,
      turnInput: 'Original residual scheduler input.',
      requestedAgentId: 'agent_codex_host',
      profileRef: 'agent_codex_host',
    });
    if (kind === 'retry')
      denySchedulerAdmissionEntry(coreDb, { queueEntryId, denialReason: 'authority-denied' });
    return {
      requestId,
      input: { workspaceId, queueEntryId },
      scope: { workspaceId },
      responseId: queueEntryId,
      resource: `scheduler-admission:${queueEntryId}`,
      action: `scheduler.admission.${kind}`,
      reviewId: undefined as string | undefined,
      targetRoot: undefined as string | undefined,
      queueEntryId,
    };
  }
  type Subject = Awaited<ReturnType<typeof prepare>>;
  let subject: Subject;
  let originalWorkspaceReceipts: unknown[] = [],
    originalCoreReceipts: unknown[] = [];
  function select(value: Subject) {
    subject = value;
    originalWorkspaceReceipts = db.sqlite
      .prepare('SELECT * FROM idempotency_requests ORDER BY request_key')
      .all();
    originalCoreReceipts = coreDb.sqlite
      .prepare('SELECT * FROM idempotency_requests ORDER BY request_key')
      .all();
    selectedWrites = writes;
    selectedReloads = reloads;
    target({
      ...value,
      scheduler: kind === 'retry' || kind === 'cancel',
      configuration: kind === 'configuration',
    });
  }
  const call = () =>
    track(
      kind === 'configuration'
        ? service.apply(subject.input as Parameters<typeof service.apply>[0])
        : invoke(
            kind === 'review'
              ? 'sync.review-decide'
              : kind === 'retry'
                ? 'scheduler.retry'
                : 'scheduler.cancel',
            subject.input,
            { kind: 'public', actor }
          )
    );
  const rows = (requestId = subject.requestId) =>
    db.sqlite
      .prepare('SELECT * FROM idempotency_requests WHERE request_id=? ORDER BY request_key')
      .all(requestId);
  const events = () =>
    (
      (kind === 'configuration' ? coreDb : db).sqlite
        .prepare('SELECT * FROM audit_events WHERE resource=? AND action=? ORDER BY audit_event_id')
        .all(subject.resource, subject.action) as Array<Record<string, unknown>>
    ).filter((row) => (kind === 'configuration' ? row.request_id === subject.requestId : true));
  const snapshot = () => ({
    receipt: rows(),
    events: events(),
    ...(kind === 'configuration'
      ? {
          provider: readFileSync(providerPath, 'utf8'),
          artifacts: store.listArtifacts(workspaceId).toSorted((a, b) => a.id.localeCompare(b.id)),
          items: store.listThreadItems(workspaceId, thread.id),
          writes: writes - selectedWrites,
          reloads: reloads - selectedReloads,
        }
      : {}),
    ...(kind === 'review'
      ? {
          target: readFileSync(join(subject.targetRoot!, 'review.txt'), 'utf8'),
          review: getWorkspaceSyncReview(db, workspaceId, subject.reviewId!),
          plans: listWorkspaceApplyPlans(db, workspaceId).filter(
            (row) => row.reviewId === subject.reviewId
          ),
          results: listWorkspaceApplyResults(db, workspaceId).filter(
            (row) => row.reviewId === subject.reviewId
          ),
        }
      : {}),
    ...(kind === 'retry' || kind === 'cancel'
      ? {
          queue: requireSchedulerAdmissionEntry(coreDb, subject.queueEntryId!),
          turn: store.getTurn(workspaceId, thread.id, turn.id),
        }
      : {}),
  });
  return {
    kind,
    dataRoot,
    userId,
    workspaceId,
    thread,
    turn,
    actor,
    command,
    prepare,
    select,
    call,
    rows,
    events,
    snapshot,
    get subject() {
      return subject;
    },
    get coreDb() {
      return coreDb;
    },
    get db() {
      return db;
    },
    get store() {
      return store;
    },
    protect() {
      observation.readonly = true;
      coreDb.sqlite.pragma('query_only=ON');
      db.sqlite.pragma('query_only=ON');
    },
    assertNoSchedulerReceipt() {
      expect(
        db.sqlite.prepare('SELECT * FROM idempotency_requests ORDER BY request_key').all()
      ).toEqual(originalWorkspaceReceipts);
      expect(
        coreDb.sqlite.prepare('SELECT * FROM idempotency_requests ORDER BY request_key').all()
      ).toEqual(originalCoreReceipts);
    },
    revoke() {
      revokeOpenKitAccessTokenRecord(authorityDb, token.tokenId);
    },
    async cold() {
      await shutdownControlStoreWorkerClient();
      for (const handle of [db, coreDb, authorityDb]) handle.sqlite.close();
      coreDb = openCoreDb(dataRoot);
      authorityDb = openCoreDb(dataRoot);
      db = openWorkspaceDb(dataRoot, workspaceId);
      store = new FsStore({ dataRoot });
      compose();
    },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function receipt(f: Fixture) {
  const records = f.rows();
  expect(records).toHaveLength(1);
  const input =
    f.kind === 'review'
      ? { requestId: f.subject.requestId, decision: 'accepted' }
      : f.subject.input;
  expect(records[0]).toMatchObject({
    request_key: commandRequestKey(f.command!, f.subject.requestId, f.subject.scope),
    command_name: f.command,
    request_id: f.subject.requestId,
    scope_json: JSON.stringify(f.subject.scope),
    input_hash: commandInputHash(input),
    response_kind: f.kind === 'configuration' ? 'artifact' : 'workspace_sync_review',
    response_id: f.subject.responseId,
  });
  expect(
    f.coreDb.sqlite
      .prepare('SELECT 1 FROM idempotency_requests WHERE request_id=?')
      .all(f.subject.requestId)
  ).toEqual([]);
  return records;
}
function effect(f: Fixture) {
  const state = f.snapshot();
  if (f.kind === 'configuration') {
    expect(state).toMatchObject({ writes: 1, reloads: 1 });
    expect(JSON.parse(state.provider!).displayName).toBe('subject');
    expect(state.artifacts!.find((row) => row.id === f.subject.responseId)?.content).toMatchObject({
      format: 'json',
    });
    const markerId = deriveEntityId('it', [
      'configuration_apply',
      { actorId: f.userId, requestId: f.subject.requestId },
    ]);
    expect(state.items!.find((row) => row.id === markerId)).toMatchObject({
      type: 'status',
      title: 'Configuration application started',
      threadId: f.thread.id,
      turnId: f.turn.id,
      status: 'completed',
    });
    expect(f.events()).toHaveLength(1);
    expect(f.events()[0]).toMatchObject({ request_id: f.subject.requestId, outcome: 'succeeded' });
    expect(JSON.parse(String(f.events()[0]!.actor_json))).toEqual({ kind: 'user', id: f.userId });
  } else if (f.kind === 'review') {
    expect(state.target).toBe('after\n');
    expect(state.review?.review.status).toBe('accepted');
    expect(state.plans).toHaveLength(1);
    expect(state.results).toHaveLength(1);
    expect(state.results![0]).toMatchObject({ status: 'applied', reviewId: f.subject.reviewId });
  } else {
    expect(state.queue?.status).toBe(f.kind === 'retry' ? 'queued' : 'cancelled');
    f.assertNoSchedulerReceipt();
    if (f.kind === 'cancel') expect(state.turn?.status).toBe('cancelled');
  }
}
function schedulerAudit(f: Fixture) {
  expect(f.events()).toHaveLength(1);
  expect(f.events()[0]).toMatchObject({
    workspace_id: f.workspaceId,
    thread_id: f.thread.id,
    turn_id: f.turn.id,
    actor_json: null,
    request_id: f.kind === 'retry' ? f.subject.requestId : null,
    action: f.subject.action,
    resource: f.subject.resource,
    category: 'system',
    severity: 'info',
    outcome: f.kind === 'retry' ? 'succeeded' : 'cancelled',
  });
  expect(f.rows()).toEqual([]);
}
function success(f: Fixture, value: unknown) {
  if (f.kind === 'configuration')
    expect(value).toMatchObject({
      persisted: true,
      reload: 'applied',
      candidate: f.subject.input.candidate,
    });
  else if (f.kind === 'review')
    expect(value).toMatchObject({
      review: { id: f.subject.reviewId, status: 'accepted' },
      workspaceApplyResult: { status: 'applied' },
    });
  else expect(value).toEqual(f.kind === 'retry' ? { retried: true } : { cancelled: true });
}

it.each(receiptKinds)(
  'preserves original %s late receipt INSERT prefix and its exact cold gap semantics',
  async (kind) => {
    const f = await fixture(kind);
    f.select(await f.prepare());
    f.db.sqlite.exec(
      `CREATE TRIGGER refuse_residual_receipt BEFORE INSERT ON idempotency_requests WHEN NEW.request_id='${f.subject.requestId}' BEGIN SELECT RAISE(ABORT,'Residual receipt INSERT'); END`
    );
    const error = await f.call().catch((error: unknown) => error);
    expect(Atomics.load(gate(), 5)).toBe(1);
    expect(error).toBeInstanceOf(Error);
    effect(f);
    expect(f.rows()).toEqual([]);
    f.db.sqlite.exec('DROP TRIGGER refuse_residual_receipt');
    const retained = f.snapshot();
    await f.cold();
    expect(f.snapshot()).toEqual(retained);
    if (kind === 'configuration') {
      await expect(f.call()).rejects.toMatchObject({ code: 'configuration_recovery_required' });
      expect(f.snapshot()).toEqual(retained);
    } else {
      success(f, await f.call());
      receipt(f);
      expect({ ...f.snapshot(), receipt: [] }).toEqual(retained);
    }
  }
);
it.each(receiptKinds)(
  'preserves original %s committed receipt after actual later expiry DELETE refusal',
  async (kind) => {
    const time = clock(),
      f = await fixture(kind),
      peer = await f.prepare('peer');
    f.select(peer);
    success(f, await f.call());
    const peerRow = f.rows(peer.requestId);
    expect(peerRow).toHaveLength(1);
    vi.setSystemTime(time.lookup);
    f.select(await f.prepare());
    arm(4);
    const pending = f.call();
    await held(4, pending);
    expect(Date.parse((peerRow[0] as { expires_at: string }).expires_at)).toBeGreaterThan(
      time.lookup
    );
    vi.setSystemTime(time.after);
    f.db.sqlite.exec(
      `CREATE TRIGGER refuse_residual_prune BEFORE DELETE ON idempotency_requests WHEN OLD.request_id='${peer.requestId}' BEGIN SELECT RAISE(ABORT,'Residual receipt DELETE'); END`
    );
    release();
    expect(await pending.catch((error: unknown) => error)).toBeInstanceOf(Error);
    expect(Atomics.load(gate(), 5)).toBe(2);
    effect(f);
    receipt(f);
    expect(f.rows(peer.requestId)).toEqual(peerRow);
    expect(Date.parse((f.rows()[0] as { created_at: string }).created_at)).toBe(time.lookup);
    expect(Date.parse((f.rows()[0] as { expires_at: string }).expires_at)).toBeGreaterThan(
      time.after
    );
    f.db.sqlite.exec('DROP TRIGGER refuse_residual_prune');
    const retained = f.snapshot();
    await f.cold();
    expect(f.snapshot()).toEqual(retained);
    success(f, await f.call());
    expect(f.snapshot()).toEqual(retained);
  }
);
it.each(receiptKinds)(
  'samples original %s expiry clock only after its authentic completed predecessor',
  async (kind) => {
    const time = clock(),
      f = await fixture(kind),
      peer = await f.prepare('peer');
    f.select(peer);
    success(f, await f.call());
    expect(f.rows(peer.requestId)).toHaveLength(1);
    vi.setSystemTime(time.lookup);
    f.select(await f.prepare());
    arm(4);
    const pending = f.call();
    await held(4, pending);
    vi.setSystemTime(time.after);
    release();
    success(f, await pending);
    effect(f);
    receipt(f);
    expect(f.rows(peer.requestId)).toEqual([]);
    expect(Date.parse((f.rows()[0] as { created_at: string }).created_at)).toBe(time.lookup);
    expect(Date.parse((f.rows()[0] as { expires_at: string }).expires_at)).toBeGreaterThan(
      time.after
    );
    const retained = f.snapshot();
    await f.cold();
    expect(f.snapshot()).toEqual(retained);
    success(f, await f.call());
    expect(f.snapshot()).toEqual(retained);
  }
);
it.each(['retry', 'cancel'] as const)(
  'preserves original scheduler %s committed queue/Turn before a real late Audit INSERT refusal',
  async (kind) => {
    const f = await fixture(kind);
    f.select(await f.prepare());
    f.db.sqlite.exec(
      `CREATE TRIGGER refuse_residual_audit BEFORE INSERT ON audit_events WHEN NEW.action='${f.subject.action}' AND NEW.resource='${f.subject.resource}' BEGIN SELECT RAISE(ABORT,'Residual Audit INSERT'); END`
    );
    expect(await f.call().catch((error: unknown) => error)).toBeInstanceOf(Error);
    expect(Atomics.load(gate(), 5)).toBe(4);
    effect(f);
    expect(f.events()).toEqual([]);
    expect(f.rows()).toEqual([]);
    f.db.sqlite.exec('DROP TRIGGER refuse_residual_audit');
    const retained = f.snapshot();
    await f.cold();
    expect(f.snapshot()).toEqual(retained);
    await expect(f.call()).rejects.toMatchObject({
      code:
        kind === 'retry' ? 'scheduler_admission_retry_failed' : 'scheduler_admission_cancel_failed',
      status: 400,
    });
    expect(f.snapshot()).toEqual(retained);
  }
);
it('preserves the original opaque escaped Review identity and exact receipt across cold replay', async () => {
  const f = await fixture('review');
  const requestId = 'opaque-review:"\\'.repeat(512);
  f.select(await f.prepare('subject', requestId));
  success(f, await f.call());
  effect(f);
  receipt(f);
  const retained = f.snapshot();
  await f.cold();
  expect(f.snapshot()).toEqual(retained);
  success(f, await f.call());
  expect(f.snapshot()).toEqual(retained);
});
it.each(kinds)(
  'natively closes %s ordinary Main writes with genuine query_only handles',
  async (kind) => {
    const f = await fixture(kind);
    f.select(await f.prepare());
    f.protect();
    success(f, await f.call());
    effect(f);
    if (kind === 'retry' || kind === 'cancel') schedulerAudit(f);
    else receipt(f);
    const retained = f.snapshot();
    await f.cold();
    expect(f.snapshot()).toEqual(retained);
    if (kind === 'configuration' || kind === 'review') {
      success(f, await f.call());
      expect(f.snapshot()).toEqual(retained);
    }
  }
);
it.each(receiptKinds.flatMap((kind) => [1, 2].map((stage) => ({ kind, stage }))))(
  'natively retains $kind stage $stage FULL after actual ACK loss and warm/cold replay',
  async ({ kind, stage }) => {
    const f = await fixture(kind);
    f.select(await f.prepare());
    f.protect();
    arm(stage);
    const pending = f.call();
    await held(stage, pending);
    effect(f);
    receipt(f);
    const retained = f.snapshot(),
      posts = observation.posts.length;
    await observation.workers[Atomics.load(gate(), 4)]!.terminate();
    release();
    expect(await pending.catch((error: unknown) => error)).toBeInstanceOf(Error);
    expect(f.snapshot()).toEqual(retained);
    expect(observation.posts).toHaveLength(posts);
    success(f, await f.call());
    expect(f.snapshot()).toEqual(retained);
    expect(observation.posts).toHaveLength(posts);
    await f.cold();
    expect(f.snapshot()).toEqual(retained);
    success(f, await f.call());
    expect(f.snapshot()).toEqual(retained);
  }
);
it.each(['retry', 'cancel'] as const)(
  'natively awaits scheduler %s Audit FULL and retains its original null-actor tuple after ACK loss',
  async (kind) => {
    const f = await fixture(kind);
    f.select(await f.prepare());
    f.protect();
    arm(3);
    const pending = f.call();
    await held(3, pending);
    effect(f);
    schedulerAudit(f);
    const retained = f.snapshot(),
      posts = observation.posts.length;
    await observation.workers[Atomics.load(gate(), 4)]!.terminate();
    release();
    expect(await pending.catch((error: unknown) => error)).toBeInstanceOf(Error);
    expect(f.snapshot()).toEqual(retained);
    expect(observation.posts).toHaveLength(posts);
    await f.cold();
    expect(f.snapshot()).toEqual(retained);
    await expect(f.call()).rejects.toMatchObject({
      code:
        kind === 'retry' ? 'scheduler_admission_retry_failed' : 'scheduler_admission_cancel_failed',
      status: 400,
    });
    expect(f.snapshot()).toEqual(retained);
  }
);
it.each(receiptKinds)(
  'natively preserves %s historical evidence but refuses disclosure after genuine revocation across receipt ACK',
  async (kind) => {
    const f = await fixture(kind);
    f.select(await f.prepare());
    f.protect();
    arm(1);
    const pending = f.call();
    await held(1, pending);
    effect(f);
    receipt(f);
    const retained = f.snapshot();
    f.revoke();
    release();
    const error = await pending.catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    if (kind === 'review')
      expect(error).toMatchObject({ code: 'workspace_access_denied', status: 403 });
    else expect(error).toBeInstanceOf(DeploymentAdminRequiredError);
    expect(f.snapshot()).toEqual(retained);
    await f.cold();
    expect(f.snapshot()).toEqual(retained);
  }
);
