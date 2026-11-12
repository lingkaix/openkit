// openkit-test-platform: posix
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { Worker as NativeWorker } from 'node:worker_threads';
import { allocateEntityId } from '@openkit/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRuntimeConfigManager } from '../config/runtime-config.js';
import { resolveHarnessLogicalModelCatalog } from '../llm/logical-models.js';
import { createOperationInvocation } from '../operation-composition.js';
import { PolicyInterception } from '../policy/interception.js';
import { EMPTY_POLICY_DOCUMENT, policyDigest } from '../policy/statements.js';
import { ProviderRegistry } from '../providers/registry.js';
import { recordAgentEnvironmentPackageSnapshot } from '../runtime/aep-snapshot-ledger.js';
import { resolveAgentEnvironmentPackage } from '../runtime/agent-environment.js';
import { requireHarnessLoginBinding } from '../runtime/harness-login-authority.js';
import {
  createNanoHostHarnessRuntime,
  dispatchNanoHostHarnessOperation,
  openNanoHostAgentSessionBinding,
  prepareNanoHostHarnessOperation,
  queueNanoHostHarnessOperation,
} from '../runtime/nanohost-harness.js';
import {
  allocateNanoHostRuntimeTargetConnectionGeneration,
  upsertNanoHostRuntimeTarget,
} from '../runtime/nanohost-runtime-target.js';
import type { TurnExecutor } from '../runtime/types.js';
import { createSchedulerAdmissionEntry } from '../scheduler-records.js';
import {
  createTestAgentSetup,
  createTestGatewayConfig,
} from '../test-support/agent-environment.js';
import { recordTestExecutionAttempt } from '../test-support/execution-attempt.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { admitTestNativeEnvironment } from '../test-support/native-environment.js';
import { createTestCoreDb, createTestStore, createTestWorkspaceDb } from '../test-support/store.js';
import { refreshWorkerCodexLogin } from '../vault/codex-login-refresh.js';
import { vaultSecretMaterialToString } from '../vault/vault-backend.js';
import { createEncryptedFileVaultBackend } from '../vault/vault-encrypted-file-backend.js';
import { createVaultGrant } from '../vault/vault-grants.js';
import { createVaultReference } from '../vault/vault-references.js';
import { createVaultUseAuditedBackend } from '../vault/vault-use-audited-backend.js';
import { getVaultInjectionPlan } from '../vault-injection-plans.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import { closeWorkspaceProductReadHandles, readProduct } from './control-store-product-records.js';
import {
  ControlStoreWorkerError,
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './control-store-worker-client.js';
import { CONTROL_WORKER_LIMITS } from './control-store-worker-protocol.js';
import type { CoreDb, WorkspaceDb } from './db.js';
import { coreDbPath } from './fs-layout.js';
import type { RuntimePolicyPublicationResult } from './runtime-policy-publication.js';
import type { ControlVaultMainInputMap } from './vault-native-codecs.js';

// The only new production ingress. Private correlation below follows the frozen wire ABI, not internal maps.
interface Entry {
  activateHarnessLoginWithPolicyBorrow(
    core: CoreDb,
    workspace: WorkspaceDb,
    record: ControlVaultMainInputMap['thread-login-activate'],
    beforeSubmit?: () => Promise<void> | void
  ): Promise<null>;
}

// Frozen private ABI from policy-bridge-private-abi-draft.md; all grants come from real Core frames.
type Binding = {
  coreDatabase: string;
  coreIdentity: string;
  openingId: string;
  publisherId: string;
  transitionId: string;
  borrower: {
    host: number;
    database: string;
    openingRequestId: number;
    requestId: number;
    workspaceId: string;
  };
};
type Grant = {
  binding: Binding;
  policy: { serverRevision: string; workspaceRevision: string | null };
};
type Wire = {
  version?: number;
  id?: number;
  operation?: string;
  status?: string;
  database?: string;
  decision?: string;
  grant?: Grant;
  binding?: Binding;
  outcome?: string;
  code?: string;
  commit?: string;
};
type Capture = { worker: NativeWorker; frame: Wire; forward(): void; discard(): void };
const transport = vi.hoisted(() => ({
  workers: [] as NativeWorker[],
  owners: new Map<string, NativeWorker>(),
  idle: new Map<NativeWorker, () => void>(),
  exitHolds: new Map<NativeWorker, ReturnType<typeof Promise.withResolvers<void>>>(),
  exitSignals: new Map<NativeWorker, () => void>(),
  exitRequested: new Set<NativeWorker>(),
  exited: new Set<NativeWorker>(),
  faults: new Map<NativeWorker, Int32Array>(),
  trace: [] as Array<{ worker: NativeWorker; direction: 'to' | 'from'; frame: Wire }>,
  holds: [] as Array<{
    worker: NativeWorker;
    direction: 'to' | 'from';
    match(value: Wire): boolean;
    resolve(value: Capture): void;
  }>,
  releases: [] as Array<() => void>,
}));

// Test-local transport holds retain ORIGINAL messages and receivers. The owner, SQL and replies
// are real. The SQLite fault runs COMMIT before throwing; it never claims rollback.
vi.mock('node:worker_threads', async (load) => {
  const actual = await load<typeof import('node:worker_threads')>();
  const observe = (
    worker: NativeWorker,
    direction: 'to' | 'from',
    frame: Wire,
    forward: () => void
  ) => {
    transport.trace.push({ worker, direction, frame: structuredClone(frame) });
    const index = transport.holds.findIndex(
      (hold) => hold.worker === worker && hold.direction === direction && hold.match(frame)
    );
    if (index < 0) return false;
    const selected = transport.holds.splice(index, 1)[0]!;
    let finished = false;
    const resume = () => {
      if (!finished) {
        finished = true;
        forward();
      }
    };
    transport.releases.push(resume);
    selected.resolve({
      worker,
      frame: structuredClone(frame),
      forward: resume,
      discard() {
        finished = true;
      },
    });
    return true;
  };
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(filename: string | URL, options?: import('node:worker_threads').WorkerOptions) {
        const gate = new Int32Array(new SharedArrayBuffer(16));
        const prelude = `
          const {parentPort, workerData} = require('node:worker_threads');
          const Database = require(workerData.databaseModule);
          const nativeImmediate = global.setImmediate;
          const jobs = new Set();
          let commitTarget;
          for (const [set, clear] of [['setTimeout','clearTimeout'],['setImmediate','clearImmediate']]) {
            const schedule = global[set], cancel = global[clear];
            global[set] = (fn, ...args) => {
              let handle;
              handle = schedule((...values) => { jobs.delete(handle); fn(...values); }, ...args);
              jobs.add(handle); return handle;
            };
            global[clear] = handle => { jobs.delete(handle); return cancel(handle); };
          }
          function idle() {
            nativeImmediate(() => {
              if (jobs.size) return idle();
              nativeImmediate(() => {
                if (jobs.size) return idle();
                parentPort.postMessage({policyBridgeFixtureIdle: true});
              });
            });
          }
          const on = parentPort.on.bind(parentPort);
          parentPort.on = function(event, listener) {
            return on(event, event !== 'message' ? listener : function(value, ...args) {
              if (value?.policyBridgeFixtureIdle) { idle(); return; }
              if (value?.policyBridgeFixtureCommit) { commitTarget = value.policyBridgeFixtureCommit; return; }
              return listener.call(this, value, ...args);
            });
          };
          function hold(sqlite, point) {
            if (commitTarget?.path !== sqlite.name || commitTarget.point !== point) return;
            if (Atomics.compareExchange(workerData.gate, 2, 0, 1) === 0) Atomics.wait(workerData.gate, 3, 0);
          }
          const exec = Database.prototype.exec;
          Database.prototype.exec = function(sql) {
            const commit = /^COMMIT$/i.test(sql);
            if (commit) hold(this, 1);
            const result = exec.call(this, sql);
            if (commit) {
              hold(this, 2);
              if (Atomics.compareExchange(workerData.gate, 0, 1, 0) === 1)
                throw new Database.SqliteError('Injected lost commit completion', 'SQLITE_IOERR');
            }
            return result;
          };
        `;
        const originalEntry = options?.eval
          ? String(filename)
          : `import(${JSON.stringify(String(filename))});`;
        super(prelude + originalEntry, {
          ...options,
          eval: true,
          workerData: {
            ...options?.workerData,
            databaseModule: createRequire(import.meta.url).resolve('better-sqlite3'),
            gate,
          },
        });
        transport.workers.push(this);
        transport.faults.set(this, gate);
        this.on('exit', () => transport.exited.add(this));
      }
      override postMessage(...args: Parameters<NativeWorker['postMessage']>): void {
        const value = args[0] as Wire;
        if (value?.operation === 'open' && value.database)
          transport.owners.set(value.database, this);
        if (observe(this, 'to', value, () => super.postMessage(...args))) return;
        super.postMessage(...args);
      }
      override emit(event: string | symbol, ...args: unknown[]): boolean {
        if (
          event === 'message' &&
          (args[0] as { policyBridgeFixtureIdle?: boolean })?.policyBridgeFixtureIdle
        ) {
          transport.idle.get(this)?.();
          return true;
        }
        if (
          event === 'message' &&
          observe(this, 'from', args[0] as Wire, () => {
            super.emit(event, ...args);
          })
        )
          return true;
        return super.emit(event, ...args);
      }
      override async terminate(): Promise<number> {
        transport.exitRequested.add(this);
        transport.exitSignals.get(this)?.();
        const hold = transport.exitHolds.get(this);
        if (hold) await hold.promise;
        return super.terminate();
      }
    },
  };
});
const resources: Array<{ root: string; core: CoreDb; workspace?: WorkspaceDb }> = [];
const work: Promise<unknown>[] = [];
function retained<T>(promise: Promise<T>): Promise<T> {
  work.push(promise);
  void promise.catch(() => undefined);
  return promise;
}
function hold(worker: NativeWorker, direction: 'to' | 'from', match: (frame: Wire) => boolean) {
  const reached = Promise.withResolvers<Capture>();
  transport.holds.push({ worker, direction, match, resolve: reached.resolve });
  return reached.promise;
}
async function quiet(worker: NativeWorker): Promise<void> {
  if (transport.exited.has(worker)) return;
  const done = Promise.withResolvers<void>();
  const exited = () => done.resolve();
  worker.once('exit', exited);
  transport.idle.set(worker, () => done.resolve());
  worker.postMessage({ policyBridgeFixtureIdle: true });
  await done.promise;
  worker.off('exit', exited);
  transport.idle.delete(worker);
}
function entry(client: ReturnType<typeof getControlStoreWorkerClient>): Entry {
  expect(
    typeof (client as unknown as Entry).activateHarnessLoginWithPolicyBorrow,
    'Missing agreed activateHarnessLoginWithPolicyBorrow entry on base'
  ).toBe('function');
  return client as unknown as Entry;
}
function closeAction(state: RuntimePolicyPublicationResult) {
  if (!state.publisherId) throw new Error('Fixture publication has no publisher.');
  return {
    kind: 'close' as const,
    openingId: state.openingId,
    publisherId: state.publisherId,
    expectedTransitionId: state.transitionId,
    transitionId: randomUUID(),
  };
}
async function publish(
  client: ReturnType<typeof getControlStoreWorkerClient>,
  core: CoreDb,
  workspaceId: string
) {
  const initial = await client.runtimePolicyPublication(core, { kind: 'inspect' });
  const target = {
    openingId: initial.openingId,
    publisherId: initial.publisherId ?? randomUUID(),
    transitionId: randomUUID(),
  };
  await client.runtimePolicyPublication(core, {
    kind: 'close',
    ...target,
    expectedTransitionId: initial.transitionId,
  });
  return client.runtimePolicyPublication(core, {
    kind: 'activate',
    ...target,
    identity: {
      serverRevision: policyDigest(EMPTY_POLICY_DOCUMENT),
      workspaceRevisions: [{ workspaceId, revision: policyDigest(EMPTY_POLICY_DOCUMENT) }],
    },
  });
}
// Storage-owner SQL probe only. Never inserts credential, Policy, grant, receipt or lifecycle rows.
function scalarWrite(
  client: ReturnType<typeof getControlStoreWorkerClient>,
  database: string,
  id = randomUUID()
) {
  return client.write(database, [
    {
      mode: 'run' as const,
      sql: "INSERT INTO idempotency_requests (request_key,command_name,request_id,scope_json,input_hash,response_kind,response_id,created_at,expires_at) VALUES (?,'fixture',?,'{}','fixture','thread','fixture','fixture','fixture')",
      parameters: [id, id],
      expectChanges: 1,
    },
  ]);
}
function heldGrant(f: Awaited<ReturnType<typeof fixture>>) {
  return hold(
    f.borrowerHost,
    'to',
    (frame) => frame.operation === 'runtime-policy-borrow' && frame.decision === 'granted'
  );
}
function assertIssued(captured: Capture) {
  const binding = captured.frame.grant?.binding ?? captured.frame.binding;
  expect(binding).toBeDefined();
  const issued = transport.trace.find(
    ({ direction, frame }) =>
      direction === 'from' &&
      frame.status === 'runtime-policy-borrow-granted' &&
      frame.id === captured.frame.id
  );
  expect(issued?.frame.grant?.binding).toEqual(binding);
}
async function commitHold(f: Awaited<ReturnType<typeof fixture>>, point: 1 | 2 = 1) {
  const gate = transport.faults.get(f.borrowerHost)!;
  Atomics.store(gate, 2, 0);
  Atomics.store(gate, 3, 0);
  f.borrowerHost.postMessage({
    policyBridgeFixtureCommit: { path: f.workspace.sqlite.name, point },
  });
  await quiet(f.borrowerHost);
  return {
    async reached(activation: Promise<unknown>) {
      let stop = false;
      const native = (async () => {
        while (!stop && Atomics.load(gate, 2) === 0) await nextTurn();
      })();
      try {
        await Promise.race([
          native,
          activation.then(() => {
            throw new Error('Activation returned before its real COMMIT barrier.');
          }),
        ]);
      } finally {
        stop = true;
      }
    },
    release() {
      Atomics.store(gate, 3, 1);
      Atomics.notify(gate, 3);
    },
  };
}

/** Owner-produced synthetic metadata, not a claim about remote Login delivery or reviewed sharing. */
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'policy-bridge-entry-'));
  const core = createTestCoreDb(root);
  const resource: (typeof resources)[number] = { root, core };
  resources.push(resource);
  const client = getControlStoreWorkerClient();
  // Establish the canonical Core first; it owns host0, not the later Workspace's host.
  await client.runtimePolicyPublication(core, { kind: 'inspect' });
  const userId = ensureLocalUser(core);
  const store = createTestStore({ dataRoot: root });
  const workspaceRecord = await store.createWorkspace('Policy bridge');
  const workspaceId = workspaceRecord.id;
  recordWorkspaceOwnerMembership({ coreDb: core, workspaceId, ownerUserId: userId });
  const thread = await store.createThread(workspaceId, 'Original native activation');
  const turn = await store.createTurn(workspaceId, thread.id, 'Prepare binding', {
    kind: 'user',
    id: userId,
  });
  await store.updateTurn(turn.id, { agentId: 'agent_codex_host' });
  const workspace = createTestWorkspaceDb(root, workspaceId);
  resource.workspace = workspace;
  const timestamp = new Date().toISOString();
  const now = () => timestamp;
  const agentSessionId = allocateEntityId('as');
  const admission = createSchedulerAdmissionEntry(core, {
    backendId: 'nanohost',
    queueEntryId: `queue:${turn.id}`,
    requestId: randomUUID(),
    requestedAgentId: 'agent_codex_host',
    workspaceId,
    threadId: thread.id,
    turnId: turn.id,
    turnInput: 'Prepare binding',
    triggerActor: turn.triggerActor,
    now,
  });
  const sandboxBindingRef = `sandbox-binding:${randomUUID()}`;
  const attempt = recordTestExecutionAttempt(core, {
    entry: admission,
    attemptId: allocateEntityId('attempt'),
    agentSessionId,
    inputRef: `aepsnap_${turn.id}_${agentSessionId}`,
    bindingRef: sandboxBindingRef,
    sessionCompatibilityKey: 'b'.repeat(64),
    operationId: `submit:${turn.id}`,
    now,
  });
  const backend = createEncryptedFileVaultBackend({
    masterKey: randomBytes(32),
    storeDir: join(root, 'fixture-material'),
    now,
  });
  const referenceId = allocateEntityId('vault');
  const accountId = randomUUID();
  const access = (generation: number) =>
    [
      Buffer.from('{}').toString('base64url'),
      Buffer.from(
        JSON.stringify({
          generation,
          'https://api.openai.com/auth': { chatgpt_account_id: accountId },
        })
      ).toString('base64url'),
      'synthetic-signature',
    ].join('.');
  backend.store({
    referenceId,
    material: JSON.stringify({
      tokens: { access_token: access(0), refresh_token: randomUUID(), account_id: accountId },
    }),
    metadata: { ownerScope: 'user', userId },
  });
  let reference = await createVaultReference(core, {
    referenceId,
    ownerScope: 'user',
    userId,
    displayName: 'Synthetic bridge metadata',
    secretKind: 'codex-auth-json',
    backendKind: backend.kind,
    login: { provider: 'codex', accountId, quarantined: false },
    now,
  });
  const grant = await createVaultGrant(core, {
    grantId: allocateEntityId('grant'),
    vaultReferenceId: referenceId,
    ownerScope: 'workspace',
    workspaceId,
    lifetime: 'workspace',
    allowedInjectionPaths: ['runtime-token'],
    now,
  });
  const privateRoute = { providerProfileId: 'native-metadata', providerModel: 'gpt-5.1-codex' };
  const setup = createTestAgentSetup({
    privateRoute,
    credentialDeclarations: [
      {
        id: 'login',
        requirementId: 'login',
        vaultGrantId: grant.grantId,
        visibility: 'runtime-token',
        consumer: 'codex-login',
      },
    ],
  });
  setup.logicalModels.allowed = resolveHarnessLogicalModelCatalog(
    createTestGatewayConfig({ privateRoute }),
    new ProviderRegistry([
      {
        id: privateRoute.providerProfileId,
        displayName: 'Synthetic metadata',
        kind: 'oauth',
        vendor: 'openai-codex',
        models: [privateRoute.providerModel],
        modelMetadata: {
          [privateRoute.providerModel]: {
            limit: { context: 128_000, output: 16_000 },
            modalities: { input: ['text', 'image'], output: ['text'] },
            reasoning: true,
          },
        },
      },
    ]),
    setup.logicalModels.allowed.map((model) => model.id)
  );
  admitTestNativeEnvironment(core, setup.manifest);
  const pkg = await resolveAgentEnvironmentPackage({
    coreDb: core,
    agentSetup: setup,
    agentSessionId,
    backend: { kind: 'openshell' },
    captureCoverage: { scope: 'server', value: 'off' },
    turn,
    triggerActor: turn.triggerActor,
    workspaceRoots: [],
    vaultBackend: () => backend,
    requestId: admission.requestId,
    now,
    createdAt: timestamp,
  });
  await recordAgentEnvironmentPackageSnapshot(workspace, {
    environmentPackage: pkg,
    createdAt: timestamp,
  });
  expect(pkg.llm.mode).toBe('harness');
  const target = await allocateNanoHostRuntimeTargetConnectionGeneration(core, {
    deploymentId: 'policy-bridge',
    identityId: 'policy-bridge',
    targetId: 'policy-bridge',
    observedAt: timestamp,
  });
  const physicalEpoch = 'e'.repeat(64);
  await upsertNanoHostRuntimeTarget(core, {
    ...target,
    ready: true,
    freshEmpty: true,
    predecessorFenced: true,
    physicalEpoch,
    observedAt: timestamp,
  });
  const harnessInstanceId = `harness:${randomUUID()}`;
  const bindingId = `binding:${randomUUID()}`;
  const integrationRef = `integration:${randomUUID()}`;
  await createNanoHostHarnessRuntime(core, {
    maxActiveTurns: 1,
    adapterId: 'codex',
    adapterVersion: 'test',
    harnessBindingRef: `harness-binding:${randomUUID()}`,
    harnessInstanceId,
    harnessCompatibilityKey: 'd'.repeat(64),
    imageDigest: `sha256:${'a'.repeat(64)}`,
    originPhysicalEpoch: physicalEpoch,
    sandboxBindingRef,
    sandboxCompatibilityKey: 'a'.repeat(64),
    sandboxIntegrationBindingRef: integrationRef,
    sandboxRuntimeId: `sandbox:${randomUUID()}`,
    runtimeTargetId: target.targetId,
    timestamp,
  });
  await openNanoHostAgentSessionBinding(core, {
    agentSessionCompatibilityKey: 'b'.repeat(64),
    agentSessionId,
    agentSessionRuntimeBindingId: bindingId,
    effectiveSetupGeneration: 1,
    harnessInstanceId,
    workspaceId,
    threadId: thread.id,
    timestamp,
  });
  const lineage = {
    agentSessionId,
    agentSessionRuntimeBindingId: bindingId,
    workspaceId,
    threadId: thread.id,
    turnId: turn.id,
    leaseId: attempt.attemptId,
    packageSnapshotId: pkg.snapshotId,
    turnSequence: 0,
  };
  const body = {
    ...lineage,
    aepRef: 'sandbox://bridge/aep',
    contextRef: 'sandbox://bridge/context',
    contextPackageId: 'bridge-context',
    deadline: attempt.deadline!,
  };
  const prepared = prepareNanoHostHarnessOperation(core, {
    body,
    harnessInstanceId,
    operation: 'turn.start',
    timestamp,
  });
  await queueNanoHostHarnessOperation(core, {
    body,
    prepared,
    harnessInstanceId,
    operation: 'turn.start',
    timestamp,
  });
  const dispatched = await dispatchNanoHostHarnessOperation(core, {
    sandboxIntegrationBindingRef: integrationRef,
    now,
  });
  expect(dispatched?.operation).toBe('turn.start');
  const context = {
    ...lineage,
    runtimeTargetId: target.targetId,
    physicalEpoch,
    connectionGeneration: target.connectionGeneration,
  };
  expect(requireHarnessLoginBinding(core, context, new Date().toISOString())).toBe(integrationRef);
  const plan = getVaultInjectionPlan(core, `plan_${pkg.snapshotId}_login`);
  if (!plan) throw new Error('Package producer did not publish its original Login plan.');
  const receiptId = `receipt_${pkg.snapshotId}_login`;
  const manager = createRuntimeConfigManager({ dataRoot: root });
  await manager.bindNativePolicyPublication(core);
  // The non-subject placement is modeled; actual operation mediation, canonical authority,
  // audited material resolution and native receipt publication are NOT mocked or seeded.
  const placement: Pick<TurnExecutor, 'credentialBindingOperation'> = {
    async credentialBindingOperation(_store, input, recheck) {
      expect(input.action).toBe('deliver');
      if (!input.policyProof) throw new Error('Governed producer supplied no Policy proof.');
      await recheck();
      const audited = createVaultUseAuditedBackend({
        backend,
        db: workspace,
        ownerScope: 'workspace',
        workspaceId,
        actor: pkg.scope.triggerActor,
        agentSessionId,
        grantId: grant.grantId,
        planId: plan.planId,
        receiptId,
        resolvingPath: 'grant',
      });
      const binding = () => ({
        binding: {
          consumer: {
            snapshotId: pkg.snapshotId,
            scope: pkg.scope,
            agent: { agentId: pkg.agent.agentId },
          },
          declaration: pkg.credentials.declarations[0]!,
          materialVersion: reference.currentVersion,
        },
        requester: input.coreAuthority,
        attemptId: attempt.attemptId,
        planId: plan.planId,
        receiptId,
        reference,
        policyProof: input.policyProof,
      });
      const material = vaultSecretMaterialToString(
        await audited.resolve({ referenceId, version: reference.currentVersion })
      );
      await recheck();
      const provider = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async (url) => {
        expect(String(url)).toBe('https://auth.openai.com/oauth/token');
        return Response.json({
          access_token: access(1),
          refresh_token: randomUUID(),
          expires_in: 3600,
        });
      });
      let refreshed: Awaited<ReturnType<typeof refreshWorkerCodexLogin>>;
      try {
        refreshed = await refreshWorkerCodexLogin(core, {
          binding: binding(),
          material,
          signal: new AbortController().signal,
          now: () => new Date().toISOString(),
          recheck,
        });
      } finally {
        provider.mockRestore();
      }
      const rotated = backend.rotate({ referenceId, material: refreshed.material });
      reference = await client.vault(
        core,
        'reference-advance',
        { referenceId, currentVersion: rotated.currentVersion, loginBinding: binding() },
        recheck
      );
      await recheck(reference);
      await audited.resolve({ referenceId, version: reference.currentVersion });
      await recheck();
      return client.vault(
        core,
        'receipt-create',
        {
          receiptId,
          planId: plan.planId,
          grantId: grant.grantId,
          agentSessionId,
          backendSummary: 'Modeled placement completed; real governed receipt.',
          injectedAt: new Date().toISOString(),
          expiresAt: grant.expiresAt,
          revocationStatus: 'active',
          loginBinding: binding(),
        },
        recheck
      );
    },
  };
  const invoke = createOperationInvocation({
    coreDb: core,
    dataRoot: root,
    store,
    repositoryWorkspaceDb: (id) => createTestWorkspaceDb(root, id),
    runtimeConfigManager: manager,
    policyInterception: new PolicyInterception(),
    workspaceMutationAdmission: new WorkspaceMutationAdmission(),
    inflightCommands: new WeakMap(),
    turnExecutor: placement as TurnExecutor,
  });
  const receipt = await invoke(
    'vault.binding-deliver',
    {
      workspaceId,
      bindingThreadId: thread.id,
      planId: plan.planId,
      receiptId,
      materialVersion: reference.currentVersion,
      requestId: randomUUID(),
    },
    { kind: 'public', actor: { kind: 'local', userId } }
  );
  const record: ControlVaultMainInputMap['thread-login-activate'] = {
    context,
    referenceId,
    grantId: grant.grantId,
    planId: plan.planId,
    receiptId: receipt.receiptId,
    materialGeneration: reference.currentVersion,
    accountId: reference.login!.accountId,
    expectedReferenceId: null,
    now: () => new Date().toISOString(),
  };
  const publication = await publish(client, core, workspaceId);
  const coreKey = `core:${coreDbPath(root)}`;
  const workspaceKey = `workspace:${workspace.sqlite.name}`;
  const coreHost = transport.owners.get(coreKey)!;
  const borrowerHost = transport.owners.get(workspaceKey)!;
  expect(coreHost).toBe(transport.workers[0]);
  expect(borrowerHost).toBeDefined();
  expect(borrowerHost).not.toBe(coreHost);
  const login = () =>
    readProduct(workspace.sqlite, { kind: 'workspace', workspaceId }, 'thread', thread.id)?.record
      .login;
  expect(login()).toBeUndefined();
  return {
    root,
    client,
    core,
    workspace,
    workspaceId,
    record,
    publication,
    coreKey,
    workspaceKey,
    coreHost,
    borrowerHost,
    login,
  };
}

afterEach(async () => {
  for (const release of transport.releases.splice(0)) release();
  for (const gate of transport.faults.values()) {
    Atomics.store(gate, 3, 1);
    Atomics.notify(gate, 3);
  }
  for (const hold of transport.exitHolds.values()) hold.resolve();
  transport.exitHolds.clear();
  await Promise.allSettled(transport.workers.map((worker) => worker.terminate()));
  await Promise.allSettled(work.splice(0));
  await shutdownControlStoreWorkerClient();
  for (const { root, core, workspace } of resources.splice(0)) {
    if (workspace?.sqlite.open) workspace.sqlite.close();
    if (core.sqlite.open) core.sqlite.close();
    closeWorkspaceProductReadHandles(root);
    rmSync(root, { recursive: true, force: true });
  }
  transport.workers.length = 0;
  transport.owners.clear();
  transport.idle.clear();
  transport.exitRequested.clear();
  transport.exitSignals.clear();
  transport.exited.clear();
  transport.faults.clear();
  transport.trace.length = 0;
  transport.holds.length = 0;
});

describe('Policy reservation through the real two-host activation entry', () => {
  it('E1 commits the existing activation and returns its reservation', async () => {
    const f = await fixture();
    const api = entry(f.client);
    let checked = 0;
    await expect(
      api.activateHarnessLoginWithPolicyBorrow(f.core, f.workspace, f.record, () => {
        checked++;
      })
    ).resolves.toBeNull();
    expect(checked).toBe(1);
    expect(f.login()).toMatchObject({ referenceId: f.record.referenceId });
    const granted = transport.trace.find(
      ({ frame }) => frame.status === 'runtime-policy-borrow-granted'
    );
    expect(granted?.worker).toBe(f.coreHost);
    expect(granted?.frame.grant?.binding.borrower.workspaceId).toBe(f.workspaceId);
    expect(granted?.frame.grant?.binding.borrower.host).toBeGreaterThan(0);
    expect(
      transport.trace.some(
        ({ frame }) => frame.status === 'runtime-policy-returned' && frame.id === granted?.frame.id
      )
    ).toBe(true);
    const before = transport.trace.filter(
      ({ frame }) => frame.status === 'runtime-policy-borrow-granted'
    ).length;
    const refusal = new Error('Fixture beforeSubmit refusal');
    await expect(
      api.activateHarnessLoginWithPolicyBorrow(f.core, f.workspace, f.record, () => {
        throw refusal;
      })
    ).rejects.toBe(refusal);
    expect(
      transport.trace.filter(({ frame }) => frame.status === 'runtime-policy-borrow-granted')
    ).toHaveLength(before);
    await expect(
      f.client.runtimePolicyPublication(f.core, closeAction(f.publication))
    ).resolves.toMatchObject({ state: 'closed' });
  });

  it('E2 borrow before close holds publication through the actual outer COMMIT', async () => {
    const f = await fixture();
    const api = entry(f.client);
    const sql = await commitHold(f);
    const activation = retained(
      api.activateHarnessLoginWithPolicyBorrow(f.core, f.workspace, f.record)
    );
    await sql.reached(activation);
    expect(
      transport.trace.some(
        ({ worker, frame }) =>
          worker === f.coreHost && frame.status === 'runtime-policy-borrow-granted'
      )
    ).toBe(true);
    let closed = false;
    const closing = retained(
      f.client.runtimePolicyPublication(f.core, closeAction(f.publication)).then((value) => {
        closed = true;
        return value;
      })
    );
    await nextTurn();
    await quiet(f.coreHost);
    expect(closed).toBe(false);
    expect(f.login()).toBeUndefined();
    sql.release();
    await expect(activation).resolves.toBeNull();
    await expect(closing).resolves.toMatchObject({ state: 'closed' });
    expect(f.login()).toMatchObject({ referenceId: f.record.referenceId });
  });

  it('E3 close wins against an admitted request before its actual late borrow', async () => {
    const f = await fixture();
    const api = entry(f.client);
    const needed = hold(
      f.borrowerHost,
      'from',
      (frame) => frame.status === 'runtime-policy-borrow-needed'
    );
    let checked = false;
    const activation = retained(
      api.activateHarnessLoginWithPolicyBorrow(f.core, f.workspace, f.record, () => {
        checked = true;
      })
    );
    const original = await needed;
    // beforeSubmit retains its pre-post meaning; this is a different, native prepared barrier.
    expect(checked).toBe(true);
    expect(
      transport.trace.some(
        ({ frame }) =>
          frame.id === original.frame.id && frame.status === 'runtime-policy-borrow-granted'
      )
    ).toBe(false);
    await f.client.runtimePolicyPublication(f.core, closeAction(f.publication));
    original.forward();
    await expect(activation).rejects.toMatchObject({
      code: 'precondition',
      commit: 'not-committed',
    });
    expect(f.login()).toBeUndefined();
  });

  it('E4 borrower channel loss retains the fence until actual worker exit', async () => {
    const f = await fixture();
    const api = entry(f.client);
    const sql = await commitHold(f);
    const activation = retained(
      api.activateHarnessLoginWithPolicyBorrow(f.core, f.workspace, f.record)
    );
    await sql.reached(activation);
    expect(
      transport.trace.some(
        ({ worker, frame }) =>
          worker === f.coreHost && frame.status === 'runtime-policy-borrow-granted'
      )
    ).toBe(true);
    const exit = Promise.withResolvers<void>();
    transport.exitHolds.set(f.borrowerHost, exit);
    const requested = Promise.withResolvers<void>();
    transport.exitSignals.set(f.borrowerHost, () => requested.resolve());
    f.borrowerHost.emit('messageerror', new Error('Fixture channel loss; worker is still alive'));
    await requested.promise;
    expect(transport.exitRequested.has(f.borrowerHost)).toBe(true);
    let closed = false;
    const closing = retained(
      f.client.runtimePolicyPublication(f.core, closeAction(f.publication)).then((value) => {
        expect(transport.exited.has(f.borrowerHost)).toBe(true);
        closed = true;
        return value;
      })
    );
    await nextTurn();
    await quiet(f.coreHost);
    expect(f.borrowerHost.threadId).not.toBe(-1);
    expect(closed).toBe(false);
    exit.resolve();
    await f.borrowerHost.terminate();
    sql.release();
    await expect(activation).rejects.toMatchObject({ code: 'unavailable', commit: 'unknown' });
    await expect(closing).resolves.toMatchObject({ state: 'closed' });
    expect(f.login()).toBeUndefined();
  });

  it('E5 Core poison cannot publish a successor while the original borrower can commit', async () => {
    const f = await fixture();
    const api = entry(f.client);
    const grant = heldGrant(f);
    const activation = retained(
      api.activateHarnessLoginWithPolicyBorrow(f.core, f.workspace, f.record)
    );
    const original = await grant;
    assertIssued(original);
    const ended = () =>
      transport.exited.has(f.borrowerHost) ||
      (f.login() as { referenceId?: string } | undefined)?.referenceId === f.record.referenceId ||
      transport.trace.some(
        ({ worker, direction, frame }) =>
          worker === f.borrowerHost &&
          direction === 'from' &&
          frame.id === original.frame.id &&
          frame.status === 'error' &&
          frame.commit === 'not-committed'
      );
    Atomics.store(transport.faults.get(f.coreHost)!, 0, 1);
    await expect(scalarWrite(f.client, f.coreKey)).rejects.toMatchObject({ commit: 'unknown' });
    let successor = false;
    const reopening = retained(
      (async () => {
        await f.client.close(f.coreKey);
        const value = await publish(f.client, f.core, f.workspaceId);
        expect(ended()).toBe(true);
        successor = true;
        return value;
      })()
    );
    await nextTurn();
    await quiet(f.coreHost);
    if (!ended()) expect(successor).toBe(false);
    original.forward();
    const results = await Promise.allSettled([activation, reopening]);
    for (const result of results)
      if (result.status === 'rejected')
        expect(result.reason).toBeInstanceOf(ControlStoreWorkerError);
    await shutdownControlStoreWorkerClient();
    await expect(
      publish(getControlStoreWorkerClient(), f.core, f.workspaceId)
    ).resolves.toMatchObject({ state: 'active' });
  });

  it('E6 Core loss itself drains the dependent borrower before any fresh publication', async () => {
    const f = await fixture();
    const api = entry(f.client);
    const grant = heldGrant(f);
    const activation = retained(
      api.activateHarnessLoginWithPolicyBorrow(f.core, f.workspace, f.record)
    );
    const original = await grant;
    assertIssued(original);
    const exit = Promise.withResolvers<void>();
    transport.exitHolds.set(f.borrowerHost, exit);
    const dependencyDrain = Promise.withResolvers<void>();
    transport.exitSignals.set(f.borrowerHost, () => dependencyDrain.resolve());
    f.coreHost.emit('messageerror', new Error('Fixture Core channel loss'));
    await f.coreHost.terminate();
    // Crucially, no shutdown-all is invoked to cause this dependency termination request.
    await dependencyDrain.promise;
    expect(transport.exitRequested.has(f.borrowerHost)).toBe(true);
    expect(f.borrowerHost.threadId).not.toBe(-1);
    await expect(
      f.client.runtimePolicyPublication(f.core, { kind: 'inspect' })
    ).rejects.toMatchObject({ code: 'unavailable' });
    exit.resolve();
    await f.borrowerHost.terminate();
    original.forward();
    await expect(activation).rejects.toMatchObject({ code: 'unavailable', commit: 'unknown' });
    await shutdownControlStoreWorkerClient();
    await expect(
      publish(getControlStoreWorkerClient(), f.core, f.workspaceId)
    ).resolves.toMatchObject({ state: 'active' });
    expect(f.login()).toBeUndefined();
  });

  it('E7 unrelated Core SQL progresses during the real Workspace transaction borrow', async () => {
    const f = await fixture();
    const api = entry(f.client);
    const sql = await commitHold(f);
    const activation = retained(
      api.activateHarnessLoginWithPolicyBorrow(f.core, f.workspace, f.record)
    );
    await sql.reached(activation);
    expect(
      transport.trace.some(
        ({ worker, frame }) =>
          worker === f.coreHost && frame.status === 'runtime-policy-borrow-granted'
      )
    ).toBe(true);
    await expect(scalarWrite(f.client, f.coreKey)).resolves.toHaveLength(1);
    expect(f.login()).toBeUndefined();
    sql.release();
    await expect(activation).resolves.toBeNull();
    expect(f.login()).toMatchObject({ referenceId: f.record.referenceId });
  });

  it('E8 original return drains close despite saturated ordinary Core admission', async () => {
    const f = await fixture();
    const api = entry(f.client);
    const sql = await commitHold(f);
    const activation = retained(
      api.activateHarnessLoginWithPolicyBorrow(f.core, f.workspace, f.record)
    );
    await sql.reached(activation);
    expect(
      transport.trace.some(
        ({ worker, frame }) =>
          worker === f.coreHost && frame.status === 'runtime-policy-borrow-granted'
      )
    ).toBe(true);
    const closing = retained(f.client.runtimePolicyPublication(f.core, closeAction(f.publication)));
    await nextTurn();
    await quiet(f.coreHost);
    const writes = Array.from({ length: CONTROL_WORKER_LIMITS.pendingTransitions + 1 }, () =>
      retained(scalarWrite(f.client, f.coreKey))
    );
    const outcomes = writes.map((p) =>
      p.then(
        () => 'committed' as const,
        (error: unknown) => {
          expect(error).toBeInstanceOf(ControlStoreWorkerError);
          expect(error).toMatchObject({ code: 'busy', commit: 'not-committed' });
          return 'busy' as const;
        }
      )
    );
    const full = Promise.any(
      writes.map((p) =>
        p.then(
          () => Promise.reject(new Error('Queue drained before return')),
          (error) => error
        )
      )
    );
    expect(await full).toMatchObject({ code: 'busy', commit: 'not-committed' });
    sql.release();
    await expect(activation).resolves.toBeNull();
    await expect(closing).resolves.toMatchObject({ state: 'closed' });
    const results = await Promise.all(outcomes);
    expect(results).toContain('busy');
    expect(results).toContain('committed');
    expect(f.login()).toMatchObject({ referenceId: f.record.referenceId });
  });
});
