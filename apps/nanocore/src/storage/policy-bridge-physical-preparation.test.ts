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
import type { CoreDb, WorkspaceDb } from './db.js';
import { coreDbPath } from './fs-layout.js';
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
  physical: new SharedArrayBuffer(8 * Int32Array.BYTES_PER_ELEMENT),
  physicalBorrower: undefined as NativeWorker | undefined,
  owners: new Map<string, NativeWorker>(),
  idle: new Map<NativeWorker, () => void>(),
  exited: new Set<NativeWorker>(),
  trace: [] as Array<{ worker: NativeWorker; direction: 'to' | 'from'; frame: Wire }>,
  holds: [] as Array<{
    worker: NativeWorker;
    direction: 'to' | 'from';
    match(value: Wire): boolean;
    resolve(value: Capture): void;
  }>,
  releases: [] as Array<() => void>,
}));

// Test-local holds retain ORIGINAL messages and receivers. Native close observations wrap
// the actual SQLite instances; no SQL, grant, receipt or reply result is manufactured.
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
        const prelude = `
          const {parentPort, workerData} = require('node:worker_threads');
          const Database = require(workerData.databaseModule);
          const nativeImmediate = global.setImmediate;
          const jobs = new Set();
          let physicalCorePath;
          let physicalRole;
          let preparedCoreReader;
          const physical = new Int32Array(workerData.physical);
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
              if (value?.policyBridgeFixturePhysical) {
                physicalCorePath = value.policyBridgeFixturePhysical.path;
                physicalRole = value.policyBridgeFixturePhysical.role;
                return;
              }
              if (value?.policyBridgeFixtureIdle) { idle(); return; }
              return listener.call(this, value, ...args);
            });
          };

          // openSupportedScopeReadOnlySqlite applies query_only on the actual new connection.
          // Arm only after all fixture setup, so this is the late prepared Core source.
          const pragma = Database.prototype.pragma;
          Database.prototype.pragma = function(sql, ...args) {
            const result = pragma.call(this, sql, ...args);
            if (physicalRole === 'borrower' && this.readonly && this.name === physicalCorePath &&
                /^query_only\\s*=\\s*ON$/i.test(sql)) {
              if (preparedCoreReader?.open) throw new Error('Another prepared Core reader is alive.');
              preparedCoreReader = this;
              Atomics.store(physical, 0, this.open ? 1 : 0);
              Atomics.add(physical, 7, 1);
            }
            return result;
          };
          const close = Database.prototype.close;
          Database.prototype.close = function(...args) {
            const source = this === preparedCoreReader;
            const writer = physicalRole === 'core' && this.name === physicalCorePath && !this.readonly;
            const result = close.apply(this, args);
            if (source) {
              Atomics.store(physical, 0, this.open ? 1 : 0);
              Atomics.add(physical, 1, 1);
            }
            if (writer) {
              // Original native close has executed. This is physical retirement, not an ACK.
              Atomics.store(physical, 2, this.open ? 0 : 1);
              Atomics.store(physical, 3, Atomics.load(physical, 0));
              Atomics.add(physical, 4, 1);
            }
            return result;
          };
          const post = parentPort.postMessage;
          parentPort.postMessage = function(value, ...args) {
            if (physicalRole === 'borrower' && value?.status === 'runtime-policy-borrow-needed') {
              if (!preparedCoreReader?.open || !preparedCoreReader.readonly ||
                  preparedCoreReader.name !== physicalCorePath)
                throw new Error('BorrowNeeded has no exact live prepared Core source.');
              Atomics.add(physical, 5, 1);
            }
            return post.call(this, value, ...args);
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
            physical: transport.physical,
          },
        });
        transport.workers.push(this);
        this.on('exit', () => {
          transport.exited.add(this);
          if (transport.physicalBorrower === this) {
            Atomics.store(new Int32Array(transport.physical), 0, 0);
            Atomics.store(new Int32Array(transport.physical), 6, 1);
          }
        });
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
  transport.exited.clear();
  transport.trace.length = 0;
  transport.holds.length = 0;
  transport.physicalBorrower = undefined;
  new Int32Array(transport.physical).fill(0);
});

describe('Physical custody of the original pre-grant Core source', () => {
  it('keeps Core RW retirement behind the exact live prepared Core RO before BorrowNeeded is delivered', async () => {
    const f = await fixture();
    const api = entry(f.client);
    const physical = new Int32Array(transport.physical);
    physical.fill(0);
    transport.physicalBorrower = f.borrowerHost;
    f.coreHost.postMessage({
      policyBridgeFixturePhysical: { role: 'core', path: coreDbPath(f.root) },
    });
    f.borrowerHost.postMessage({
      policyBridgeFixturePhysical: { role: 'borrower', path: coreDbPath(f.root) },
    });
    await quiet(f.coreHost);
    await quiet(f.borrowerHost);
    expect(Atomics.load(physical, 7)).toBe(0);

    const needed = hold(
      f.borrowerHost,
      'from',
      (frame) => frame.status === 'runtime-policy-borrow-needed'
    );
    const activation = retained(
      api.activateHarnessLoginWithPolicyBorrow(f.core, f.workspace, f.record).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error })
      )
    );
    const original = await needed;
    // The query-only hook captured the actual SQLite instance returned by the source owner.
    // The worker checked that SAME instance immediately before posting this original frame.
    expect(Atomics.load(physical, 7)).toBe(1);
    expect(Atomics.load(physical, 5)).toBe(1);
    expect(Atomics.load(physical, 0)).toBe(1);
    expect(Atomics.load(physical, 1)).toBe(0);
    expect(
      transport.trace.some(
        ({ frame }) =>
          frame.id === original.frame.id && frame.status === 'runtime-policy-borrow-granted'
      )
    ).toBe(false);

    const retirement = retained(f.client.close(f.coreKey));
    try {
      // Existing real-worker idle barriers drain scheduled native work without a sleep.
      // They do not wait on the held Workspace message or manufacture a close result.
      await nextTurn();
      await quiet(f.coreHost);
      await nextTurn();
      await quiet(f.coreHost);
      expect(Atomics.load(physical, 0)).toBe(1);

      // Core is retiring: the real original late borrow must refuse, not mint a grant.
      original.forward();
      const outcome = await activation;
      await retirement;
      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error('Retiring Core allowed the original activation.');
      expect(outcome.error).toBeInstanceOf(ControlStoreWorkerError);
      expect(outcome.error).toMatchObject({
        code: 'precondition',
        commit: 'not-committed',
      });
      expect(f.login()).toBeUndefined();
      expect(
        transport.trace.some(
          ({ frame }) =>
            frame.id === original.frame.id && frame.status === 'runtime-policy-borrow-granted'
        )
      ).toBe(false);
      expect(Atomics.load(physical, 1) === 1 || Atomics.load(physical, 6) === 1).toBe(true);
      expect(Atomics.load(physical, 0)).toBe(0);
      expect(Atomics.load(physical, 4)).toBe(1);
      expect(Atomics.load(physical, 2)).toBe(1);
      // Deciding oracle: native RW close ran, but never while its exact source RO was alive.
      // Unpinned source is expected to record 1; no public Promise/ACK substitutes for this fact.
      expect(Atomics.load(physical, 3)).toBe(0);
    } finally {
      original.forward();
      await Promise.allSettled([activation, retirement]);
    }
  }, 30_000);
});
