import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { connect, createServer } from 'node:http2';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { allocateEntityId } from '@openkit/protocol';
import { describe, expect, it, onTestFinished } from 'vitest';
import { createDefaultWorkerControlGateway } from '../app.js';
import {
  createNanoHostTransportSessionAuthority,
  readNanoHostPhysicalConnectionContext,
} from '../auth/nanohost-transport-session.js';
import { resolveHarnessLogicalModelCatalog } from '../llm/logical-models.js';
import { ProviderRegistry } from '../providers/registry.js';
import { createSchedulerAdmissionEntry } from '../scheduler-records.js';
import { openControlStoreProductReadHandle } from '../storage/control-store-product-records.js';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { agentSessionsRoot, nativeProductScope } from '../storage/workspace-file-records.js';
import {
  createTestAgentSetup,
  createTestGatewayConfig,
} from '../test-support/agent-environment.js';
import { recordTestExecutionAttempt } from '../test-support/execution-attempt.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { admitTestNativeEnvironment } from '../test-support/native-environment.js';
import {
  createTestCoreDb,
  createTestStore,
  createTestWorkspaceDb,
  disposeTestStore,
  setTestWorkspaceRevision,
} from '../test-support/store.js';
import { createEncryptedFileVaultBackend } from '../vault/vault-encrypted-file-backend.js';
import { createVaultGrant } from '../vault/vault-grants.js';
import { createVaultReference, getVaultReference } from '../vault/vault-references.js';
import { listVaultUseRecords } from '../vault/vault-use-records.js';
import { listVaultInjectionReceipts } from '../vault-injection-receipts.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { recordAgentEnvironmentPackageSnapshot } from './aep-snapshot-ledger.js';
import { resolveAgentEnvironmentPackage } from './agent-environment.js';
import {
  closeSchedulerExecutionAttemptWithoutEffects,
  requireSchedulerExecutionAttempt,
} from './execution-attempts.js';
import {
  authenticateHarnessLoginRequest,
  type HarnessLoginContext,
  requireHarnessLoginBinding,
} from './harness-login-authority.js';
import { resolveNanoHostAttemptTokenBinding } from './nanohost-attempt-records.js';
import {
  createNanoHostHarnessRuntime,
  dispatchNanoHostHarnessOperation,
  fenceNanoHostSandboxRuntime,
  openNanoHostAgentSessionBinding,
  prepareNanoHostHarnessOperation,
  queueNanoHostHarnessOperation,
} from './nanohost-harness.js';
import {
  allocateNanoHostRuntimeTargetConnectionGeneration,
  getNanoHostRuntimeTarget,
  upsertNanoHostRuntimeTarget,
} from './nanohost-runtime-target.js';
import type { NanoHostHarnessLoginPhysical } from './nanohost-session-dispatch.js';
import { createConfiguredWorkerLifecycleRuntime } from './turn-executor-factory.js';
import {
  getWorkerBackendSession,
  recordWorkerBackendSessionMaterializing,
  workerBackendLineageFromRuntimeImage,
} from './worker-backend-sessions.js';
import { WorkerGovernanceTurnExecutor } from './worker-governance-turn-executor.js';

const timestamp = '2098-08-21T00:00:00.000Z';

/**
 * Composes actual preparation, immutable package, native pending command and token-hash owners.
 * The trusted adapter port checks real branded H2/session and durable target facts. Its target
 * readiness and image metadata are explicit module inputs, not physical Worker qualification.
 * Grants here are owner-produced auth-fixture inputs, not proof of reviewed consent or vault.use.
 * No native result, active binding, Login activation, material release or handler is fabricated.
 */
async function fixture(
  mode: 'harness' | 'gateway' = 'harness',
  placement: 'original' | 'shared-resident' = 'original'
) {
  const root = mkdtempSync(join(tmpdir(), 'openkit-login-private-auth-'));
  const coreDb = createTestCoreDb(root);
  const authority = createNanoHostTransportSessionAuthority();
  let client: ReturnType<typeof connect> | undefined;
  let server: ReturnType<typeof createServer> | undefined;
  let workspaceDb: ReturnType<typeof createTestWorkspaceDb> | undefined;
  onTestFinished(async () => {
    client?.destroy();
    await authority.closeAllPhysicalConnections();
    if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
    await disposeTestStore(root, coreDb, ...(workspaceDb ? [workspaceDb] : []));
  });

  const userId = ensureLocalUser(coreDb);
  const store = createTestStore({ dataRoot: root });
  const workspace = await store.createWorkspace('Private Login authentication');
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
  const thread = await store.createThread(workspace.id, 'Authenticate the original consumer');
  const residentOrigin =
    placement === 'shared-resident' ? `sandbox-binding:${randomUUID()}` : undefined;
  let predecessorAttemptId: string | undefined;
  if (residentOrigin !== undefined) {
    const previousTurn = await store.createTurn(workspace.id, thread.id, 'Prior prepared Turn', {
      kind: 'user',
      id: userId,
    });
    const previousEntry = createSchedulerAdmissionEntry(coreDb, {
      backendId: 'nanohost',
      queueEntryId: `queue:${previousTurn.id}`,
      requestedAgentId: 'agent_codex_host',
      workspaceId: workspace.id,
      threadId: thread.id,
      turnId: previousTurn.id,
      turnInput: 'Prior prepared Turn',
      triggerActor: previousTurn.triggerActor,
      requestId: randomUUID(),
      now: () => timestamp,
    });
    const previousSessionId = allocateEntityId('as');
    const previous = recordTestExecutionAttempt(coreDb, {
      entry: previousEntry,
      attemptId: allocateEntityId('attempt'),
      agentSessionId: previousSessionId,
      inputRef: `aepsnap_${previousTurn.id}_${previousSessionId}`,
      bindingRef: residentOrigin,
      sessionCompatibilityKey: 'b'.repeat(64),
      now: () => timestamp,
    });
    // The predecessor was never submitted. Close its real scheduler record without
    // inventing a native result, execution-release proof, or accepted backend effect.
    const closed = await closeSchedulerExecutionAttemptWithoutEffects(coreDb, {
      attemptId: previous.attemptId,
      noOutstandingEffects: true,
      cause: 'fixture-predecessor-not-submitted',
      now: () => timestamp,
    });
    // Scheduler closure does not release the Workspace's active Turn slot.
    await store.completeTurn(previousTurn.id, {
      status: 'cancelled',
      completedAt: new Date().toISOString(),
    });
    predecessorAttemptId = closed.attemptId;
  }
  const turn = await store.createTurn(workspace.id, thread.id, 'Prepare private Login', {
    kind: 'user',
    id: userId,
  });
  await store.updateTurn(turn.id, { agentId: 'agent_codex_host' });
  const agentSessionId = allocateEntityId('as');
  const sandboxBindingRef = residentOrigin ?? `sandbox-binding:${randomUUID()}`;
  const attemptBindingRef =
    placement === 'shared-resident' ? `sandbox-binding:${randomUUID()}` : sandboxBindingRef;
  const entry = createSchedulerAdmissionEntry(coreDb, {
    backendId: 'nanohost',
    queueEntryId: `queue:${turn.id}`,
    requestedAgentId: 'agent_codex_host',
    workspaceId: workspace.id,
    threadId: thread.id,
    turnId: turn.id,
    turnInput: 'Prepare private Login',
    triggerActor: turn.triggerActor,
    requestId: randomUUID(),
    now: () => timestamp,
  });
  const attempt = recordTestExecutionAttempt(coreDb, {
    entry,
    attemptId: allocateEntityId('attempt'),
    agentSessionId,
    inputRef: `aepsnap_${turn.id}_${agentSessionId}`,
    bindingRef: attemptBindingRef,
    sessionCompatibilityKey: 'b'.repeat(64),
    operationId: `submit:${turn.id}`,
    now: () => timestamp,
  });
  const backend = createEncryptedFileVaultBackend({
    masterKey: randomBytes(32),
    storeDir: join(root, 'auth-fixture-vault'),
    now: () => timestamp,
  });
  const referenceId = allocateEntityId('vault');
  backend.store({
    referenceId,
    material: randomBytes(48).toString('base64url'),
    metadata: { ownerScope: 'user', userId },
  });
  const reference = await createVaultReference(coreDb, {
    referenceId,
    ownerScope: 'user',
    userId,
    displayName: 'Synthetic auth module input',
    secretKind: 'codex-auth-json',
    backendKind: backend.kind,
    login: { provider: 'codex', accountId: randomUUID(), quarantined: false },
    now: () => timestamp,
  });
  const grant = await createVaultGrant(coreDb, {
    grantId: allocateEntityId('grant'),
    vaultReferenceId: referenceId,
    ownerScope: 'workspace',
    workspaceId: workspace.id,
    lifetime: 'workspace',
    allowedInjectionPaths: ['runtime-token'],
    now: () => timestamp,
  });
  const privateRoute = { providerProfileId: 'native-metadata', providerModel: 'gpt-5.1-codex' };
  const setup = createTestAgentSetup({
    ...(placement === 'shared-resident'
      ? { requiredCapabilities: ['trusted-worker-inference-relay'] }
      : {}),
    privateRoute,
    credentialDeclarations:
      mode === 'harness'
        ? [
            {
              id: 'login',
              requirementId: 'login',
              vaultGrantId: grant.grantId,
              visibility: 'runtime-token',
              consumer: 'codex-login',
            },
          ]
        : [],
  });
  if (mode === 'harness') {
    setup.logicalModels.allowed = resolveHarnessLogicalModelCatalog(
      createTestGatewayConfig({ privateRoute }),
      new ProviderRegistry([
        {
          id: privateRoute.providerProfileId,
          displayName: 'Synthetic native model metadata',
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
  }
  admitTestNativeEnvironment(coreDb, setup.manifest);
  const environmentPackage = await resolveAgentEnvironmentPackage({
    coreDb,
    agentSetup: setup,
    agentSessionId,
    backend: { kind: 'openshell' },
    captureCoverage: { scope: 'server', value: 'off' },
    turn,
    triggerActor: turn.triggerActor,
    workspaceRoots: [],
    vaultBackend: () => backend,
    requestId: entry.requestId,
    now: () => timestamp,
    createdAt: timestamp,
  });
  workspaceDb = createTestWorkspaceDb(root, workspace.id);
  recordAgentEnvironmentPackageSnapshot(workspaceDb, {
    environmentPackage,
    createdAt: environmentPackage.createdAt,
  });

  const target = await allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
    deploymentId: 'login-auth-fixture',
    identityId: 'login-auth-fixture',
    targetId: 'login-auth-fixture',
    observedAt: timestamp,
  });
  const physicalEpoch = 'e'.repeat(64);
  await upsertNanoHostRuntimeTarget(coreDb, {
    ...target,
    freshEmpty: true,
    predecessorFenced: true,
    ready: true,
    physicalEpoch,
    observedAt: timestamp,
  });
  if (placement === 'shared-resident') {
    // Pure plan and actual pre-effect anchor. This module fixture does not launch the backend.
    const runtime = createConfiguredWorkerLifecycleRuntime({ coreDb, store, env: {} });
    const executor = runtime.turnExecutor;
    const planner =
      executor instanceof WorkerGovernanceTurnExecutor ? executor.executionBackend : undefined;
    if (!planner || !('planSession' in planner) || typeof planner.planSession !== 'function')
      throw new Error('Auth fixture lacks the actual NanoHost session planner.');
    await recordWorkerBackendSessionMaterializing(coreDb, {
      identity: planner.planSession(environmentPackage),
      backendVersion: null,
      backendLineage: workerBackendLineageFromRuntimeImage(environmentPackage.runtime.image),
      lineage: environmentPackage.scope,
      sandboxBindingRef: attemptBindingRef,
      now: () => timestamp,
    });
  }
  const harnessInstanceId = `harness:${randomUUID()}`;
  const bindingId = `session-binding:${randomUUID()}`;
  const integrationRef = `integration:${randomUUID()}`;
  await createNanoHostHarnessRuntime(coreDb, {
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
  await openNanoHostAgentSessionBinding(coreDb, {
    agentSessionCompatibilityKey: 'b'.repeat(64),
    agentSessionId,
    agentSessionRuntimeBindingId: bindingId,
    effectiveSetupGeneration: 1,
    harnessInstanceId,
    workspaceId: workspace.id,
    threadId: thread.id,
    timestamp,
  });
  const lineage = {
    agentSessionId,
    agentSessionRuntimeBindingId: bindingId,
    workspaceId: workspace.id,
    threadId: thread.id,
    turnId: turn.id,
    leaseId: attempt.attemptId,
    packageSnapshotId: environmentPackage.snapshotId,
    turnSequence: 0,
  };
  const body = {
    ...lineage,
    aepRef: 'sandbox://auth-fixture/aep',
    contextRef: 'sandbox://auth-fixture/context',
    contextPackageId: 'auth-fixture-context',
    deadline: attempt.deadline!,
  };
  const prepared = prepareNanoHostHarnessOperation(coreDb, {
    body,
    harnessInstanceId,
    operation: 'turn.start',
    timestamp,
  });
  await queueNanoHostHarnessOperation(coreDb, {
    body,
    prepared,
    harnessInstanceId,
    operation: 'turn.start',
    timestamp,
  });
  const command = await dispatchNanoHostHarnessOperation(coreDb, {
    sandboxIntegrationBindingRef: integrationRef,
    now: () => timestamp,
  });
  if (!command) throw new Error('Auth fixture did not reach the actual pending command.');
  const token = (name: string) => {
    const value = prepared.wireBody[name];
    if (typeof value !== 'string') throw new Error('Auth fixture lacks an owner-produced token.');
    return value;
  };
  const gateway = createDefaultWorkerControlGateway(coreDb);
  const registration = gateway.registerSession(environmentPackage, {
    sandboxBindingRef: attemptBindingRef,
    workerControlToken: token('workerControlToken'),
    workerInferenceToken: token('inferenceToken'),
    workerCapabilityToken: token('capabilityToken'),
  });

  const connection = Promise.withResolvers<object>();
  server = createServer((request, response) => {
    try {
      const physicalConnection = readNanoHostPhysicalConnectionContext(request);
      if (!physicalConnection) throw new Error('Auth fixture has no branded H2 connection.');
      authority.admit({
        physicalConnection,
        identityId: target.identityId,
        connectionGeneration: target.connectionGeneration,
      });
      connection.resolve(physicalConnection);
      response.end();
    } catch {
      connection.reject(new Error('Auth fixture physical admission failed.'));
      response.writeHead(500).end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Auth fixture has no H2 listener.');
  client = connect(`http://127.0.0.1:${address.port}`);
  const stream = client.request({ ':method': 'GET', ':path': '/' });
  stream.resume();
  stream.end();
  await once(stream, 'end');
  const physicalConnection = await connection.promise;
  const physical: NanoHostHarnessLoginPhysical = {
    runtimeTargetId: target.targetId,
    physicalEpoch,
    connectionGeneration: target.connectionGeneration,
    assertCurrent() {
      const current = getNanoHostRuntimeTarget(coreDb, target.targetId);
      if (
        !authority.mayCarryWork(physicalConnection) ||
        !current ||
        current.identityId !== target.identityId ||
        current.deploymentId !== target.deploymentId ||
        current.connectionGeneration !== target.connectionGeneration ||
        current.physicalEpoch !== physicalEpoch ||
        !current.ready ||
        !current.predecessorFenced ||
        !current.freshEmpty
      )
        throw new Error('Auth fixture trusted physical port is no longer current.');
    },
  };
  const context: HarnessLoginContext = {
    ...lineage,
    runtimeTargetId: target.targetId,
    physicalEpoch,
    connectionGeneration: target.connectionGeneration,
  };
  let now = timestamp;
  return {
    coreDb,
    workspaceDb,
    gateway,
    physical,
    context,
    lineage,
    environmentPackage,
    registration,
    referenceId,
    grantId: grant.grantId,
    target,
    authority,
    sandboxBindingRef,
    integrationRef,
    attemptBindingRef,
    predecessorAttemptId,
    dispatchedExactStart:
      command.operation === 'turn.start' && command.body.leaseId === attempt.attemptId,
    now: () => now,
    expire: () => {
      now = '2100-01-01T00:00:00.000Z';
    },
    request(
      fields: Record<string, unknown>,
      authorization: string | null = `Bearer ${registration.token}`
    ) {
      return new Request('http://core.invalid/worker-control/harness/login', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(authorization === null ? {} : { authorization }),
        },
        body: JSON.stringify({ ...lineage, ...fields }),
      });
    },
    removeSnapshot() {
      // Deliberate missing-owner fault only after actual immutable snapshot publication.
      rmSync(
        join(
          agentSessionsRoot(workspaceDb!),
          agentSessionId,
          'aep-snapshots',
          `${environmentPackage.snapshotId}.json`
        )
      );
    },
    // Native creation replies and canonical reads order keys differently; retain every original fact.
    noMaterialEffects: () =>
      listVaultUseRecords(coreDb).length === 0 &&
      listVaultUseRecords(workspaceDb!).length === 0 &&
      listVaultInjectionReceipts(coreDb).length === 0 &&
      isDeepStrictEqual(getVaultReference(coreDb, referenceId), reference),
  };
}

// Owners: Vault / Harness Subscription Logins; Worker Control Protocol / exact route-token family;
// Codex Worker Adapter / Host-Managed Subscription Login; private canonical pending native binding.
// No case proves serving support, physical NanoHost readiness, reviewed consent or delivery.
describe('private Harness Login request authentication', () => {
  it('authenticates the current lease on a shared resident whose origin attempt closed', async () => {
    const f = await fixture('harness', 'shared-resident');
    if (!f.predecessorAttemptId) throw new Error('Auth fixture lacks the closed predecessor.');
    const previous = requireSchedulerExecutionAttempt(f.coreDb, f.predecessorAttemptId);
    const current = resolveNanoHostAttemptTokenBinding(f.coreDb, {
      sandboxBindingRef: f.attemptBindingRef,
      lineage: f.context,
      tokenFamily: 'worker-control',
      token: f.registration.token,
      now: f.now,
    });
    const anchor = getWorkerBackendSession(f.coreDb, f.context.leaseId);
    expect(
      previous.phase === 'closed' &&
        previous.bindingRef === f.sandboxBindingRef &&
        f.attemptBindingRef !== f.sandboxBindingRef
    ).toBe(true);
    expect(f.dispatchedExactStart).toBe(true);
    expect(
      current.status === 'accepted' &&
        current.attempt.phase === 'open' &&
        current.attempt.attemptId === f.context.leaseId &&
        current.attempt.bindingRef === f.attemptBindingRef
    ).toBe(true);
    expect(
      anchor?.attemptId === f.context.leaseId &&
        anchor.sandboxBindingRef === f.attemptBindingRef &&
        anchor.workspaceId === f.context.workspaceId &&
        anchor.threadId === f.context.threadId &&
        anchor.turnId === f.context.turnId &&
        anchor.agentSessionId === f.context.agentSessionId &&
        anchor.packageSnapshotId === f.context.packageSnapshotId &&
        anchor.runtimeTargetId === f.physical.runtimeTargetId &&
        anchor.originPhysicalEpoch === f.physical.physicalEpoch
    ).toBe(true);
    f.physical.assertCurrent();
    expect(
      f.gateway.authenticatePackageToken(`Bearer ${f.registration.token}`, {
        tokenFamily: 'worker-control',
      }).snapshotId === f.environmentPackage.snapshotId
    ).toBe(true);
    const authenticate = (leaseId: string) =>
      authenticateHarnessLoginRequest({
        coreDb: f.coreDb,
        gateway: f.gateway,
        physical: f.physical,
        request: f.request({ kind: 'acquire', reason: 'activate', leaseId }),
        now: f.now,
      });
    const authenticated = await authenticate(f.context.leaseId);
    expect(isDeepStrictEqual(authenticated.context, f.context)).toBe(true);
    expect(authenticated.environmentPackage.snapshotId === f.environmentPackage.snapshotId).toBe(
      true
    );
    expect(() => authenticated.recheck()).not.toThrow();
    const refused = (leaseId: string) =>
      authenticate(leaseId).then(
        () => false,
        () => true
      );
    expect(await refused(previous.attemptId)).toBe(true);
    f.authority.fenceAuthoritative(f.target.identityId);
    expect(() => authenticated.recheck()).toThrow();
    expect(await refused(f.context.leaseId)).toBe(true);
    expect(f.noMaterialEffects()).toBe(true);
  });

  it.each([
    { kind: 'acquire', reason: 'activate' },
    { kind: 'acquire', reason: 'refresh' },
    { kind: 'complete', receiptId: 'private-receipt', materialGeneration: 1 },
    {
      kind: 'observe',
      receiptId: 'private-receipt',
      materialGeneration: 1,
      observation: { source: 'native-read', state: 'unknown', windows: [] },
    },
  ])(
    'authenticates the exact pending $kind request without a native acknowledgement',
    async (fields) => {
      const f = await fixture();
      expect(f.environmentPackage.schemaVersion).toBe(4);
      expect(f.environmentPackage.llm.mode).toBe('harness');
      expect(f.environmentPackage.credentials.declarations).toContainEqual(
        expect.objectContaining({
          visibility: 'runtime-token',
          consumer: 'codex-login',
        })
      );
      expect(requireHarnessLoginBinding(f.coreDb, f.context, f.now())).toBe(f.integrationRef);
      expect(
        f.gateway.authenticatePackageToken(`Bearer ${f.registration.token}`, {
          tokenFamily: 'worker-control',
        }).snapshotId
      ).toBe(f.environmentPackage.snapshotId);
      const authenticated = await authenticateHarnessLoginRequest({
        coreDb: f.coreDb,
        gateway: f.gateway,
        physical: f.physical,
        request: f.request(fields),
        now: f.now,
      });
      expect(authenticated.environmentPackage).toEqual(f.environmentPackage);
      expect(authenticated.context).toEqual(f.context);
      expect(authenticated.request).toEqual({ ...f.lineage, ...fields });
      await Promise.resolve();
      expect(() => authenticated.recheck()).not.toThrow();
      expect(listVaultUseRecords(f.coreDb)).toEqual([]);
      expect(listVaultUseRecords(f.workspaceDb)).toEqual([]);
      expect(listVaultInjectionReceipts(f.coreDb)).toEqual([]);
      expect(f.noMaterialEffects()).toBe(true);
    }
  );

  it.each(['missing', 'malformed', 'unknown', 'inference', 'capability'] as const)(
    'refuses the %s token before authenticating Login lineage',
    async (kind) => {
      const f = await fixture();
      const authorization =
        kind === 'missing'
          ? null
          : kind === 'malformed'
            ? 'Bearer malformed'
            : `Bearer ${
                kind === 'inference'
                  ? f.registration.workerInferenceToken
                  : kind === 'capability'
                    ? f.registration.workerCapabilityToken
                    : randomBytes(32).toString('base64url')
              }`;
      await expect(
        authenticateHarnessLoginRequest({
          coreDb: f.coreDb,
          gateway: f.gateway,
          physical: f.physical,
          request: f.request({ kind: 'acquire', reason: 'activate' }, authorization),
          now: f.now,
        })
      ).rejects.toThrow();
      expect(f.noMaterialEffects()).toBe(true);
    }
  );

  it.each([
    'workspaceId',
    'threadId',
    'turnId',
    'agentSessionId',
    'packageSnapshotId',
    'agentSessionRuntimeBindingId',
    'leaseId',
    'turnSequence',
  ] as const)(
    'refuses a request with foreign %s despite its valid worker-control token',
    async (field) => {
      const f = await fixture();
      const foreign = {
        workspaceId: allocateEntityId('ws'),
        threadId: allocateEntityId('th'),
        turnId: allocateEntityId('tu'),
        agentSessionId: allocateEntityId('as'),
        packageSnapshotId: `aepsnap_foreign_${randomUUID()}`,
        agentSessionRuntimeBindingId: `foreign-binding:${randomUUID()}`,
        leaseId: allocateEntityId('attempt'),
        turnSequence: f.lineage.turnSequence + 1,
      };
      await expect(
        authenticateHarnessLoginRequest({
          coreDb: f.coreDb,
          gateway: f.gateway,
          physical: f.physical,
          request: f.request({ kind: 'acquire', reason: 'activate', [field]: foreign[field] }),
          now: f.now,
        })
      ).rejects.toThrow();
      expect(f.noMaterialEffects()).toBe(true);
    }
  );

  it.each(['runtimeTargetId', 'physicalEpoch', 'connectionGeneration'] as const)(
    'refuses a trusted physical %s that disagrees with the canonical native binding',
    async (field) => {
      const f = await fixture();
      await expect(
        authenticateHarnessLoginRequest({
          coreDb: f.coreDb,
          gateway: f.gateway,
          physical: {
            ...f.physical,
            [field]:
              field === 'connectionGeneration'
                ? f.physical.connectionGeneration + 1
                : field === 'physicalEpoch'
                  ? 'f'.repeat(64)
                  : 'foreign-target',
          },
          request: f.request({ kind: 'acquire', reason: 'activate' }),
          now: f.now,
        })
      ).rejects.toThrow();
      expect(f.noMaterialEffects()).toBe(true);
    }
  );

  it.each([
    'referenceId',
    'grantId',
    'vaultGrantId',
    'accountId',
    'now',
    'observedAt',
    'runtimeTargetId',
    'physicalEpoch',
    'connectionGeneration',
  ])('refuses worker-selected %s rather than treating it as authority', async (field) => {
    const f = await fixture();
    const selectors: Record<string, unknown> = {
      referenceId: f.referenceId,
      grantId: f.grantId,
      vaultGrantId: f.grantId,
      accountId: 'synthetic-account',
      now: timestamp,
      observedAt: timestamp,
      runtimeTargetId: f.target.targetId,
      physicalEpoch: f.physical.physicalEpoch,
      connectionGeneration: f.physical.connectionGeneration,
    };
    await expect(
      authenticateHarnessLoginRequest({
        coreDb: f.coreDb,
        gateway: f.gateway,
        physical: f.physical,
        request: f.request({ kind: 'acquire', reason: 'activate', [field]: selectors[field] }),
        now: f.now,
      })
    ).rejects.toThrow();
    expect(f.noMaterialEffects()).toBe(true);
  });

  it.each([
    { kind: 'acquire', reason: 'select' },
    { kind: 'complete', receiptId: '', materialGeneration: 1 },
    { kind: 'complete', receiptId: 'private-receipt', materialGeneration: 0 },
    {
      kind: 'complete',
      receiptId: 'private-receipt',
      materialGeneration: 1,
      referenceId: 'untrusted-selector',
    },
    {
      kind: 'observe',
      receiptId: 'private-receipt',
      materialGeneration: 1,
      observation: { source: 'notification', state: 'unknown', windows: [] },
    },
    {
      kind: 'observe',
      receiptId: 'private-receipt',
      materialGeneration: 1,
      accountId: 'untrusted-selector',
      observation: { source: 'native-read', state: 'unknown', windows: [] },
    },
    {
      kind: 'observe',
      receiptId: 'private-receipt',
      materialGeneration: 1,
      observation: { source: 'native-read', state: 'unknown', windows: [], observedAt: timestamp },
    },
  ])('refuses malformed closed $kind facts', async (fields) => {
    const f = await fixture();
    await expect(
      authenticateHarnessLoginRequest({
        coreDb: f.coreDb,
        gateway: f.gateway,
        physical: f.physical,
        request: f.request(fields),
        now: f.now,
      })
    ).rejects.toThrow();
    expect(f.noMaterialEffects()).toBe(true);
  });

  it('refuses an actual owner-produced gateway AEP without promoting it to Login eligibility', async () => {
    const f = await fixture('gateway');
    expect(f.environmentPackage.schemaVersion).toBe(4);
    expect(f.environmentPackage.llm.mode).toBe('gateway');
    expect(f.environmentPackage.credentials.declarations).toEqual([]);
    expect(requireHarnessLoginBinding(f.coreDb, f.context, f.now())).toBe(f.integrationRef);
    await expect(
      authenticateHarnessLoginRequest({
        coreDb: f.coreDb,
        gateway: f.gateway,
        physical: f.physical,
        request: f.request({ kind: 'acquire', reason: 'activate' }),
        now: f.now,
      })
    ).rejects.toThrow();
    expect(f.noMaterialEffects()).toBe(true);
  });

  it('requires the immutable retained package even when the gateway still authenticates its token', async () => {
    const f = await fixture();
    f.removeSnapshot();
    expect(f.gateway.authenticatePackageToken(`Bearer ${f.registration.token}`).snapshotId).toBe(
      f.environmentPackage.snapshotId
    );
    await expect(
      authenticateHarnessLoginRequest({
        coreDb: f.coreDb,
        gateway: f.gateway,
        physical: f.physical,
        request: f.request({ kind: 'acquire', reason: 'activate' }),
        now: f.now,
      })
    ).rejects.toThrow();
    expect(f.noMaterialEffects()).toBe(true);
  });

  // Worker Control Protocol / typed control-envelope ceiling is inclusive and counts UTF-8 bytes.
  it.each(['at-limit', 'over-limit'] as const)(
    'enforces the existing 64 KiB body bound %s',
    async (size) => {
      const f = await fixture();
      expect(requireHarnessLoginBinding(f.coreDb, f.context, f.now())).toBe(f.integrationRef);
      expect(f.gateway.authenticatePackageToken(`Bearer ${f.registration.token}`).snapshotId).toBe(
        f.environmentPackage.snapshotId
      );
      f.physical.assertCurrent();
      const fields = { kind: 'complete', receiptId: '\u00e9'.repeat(256), materialGeneration: 1 };
      const encoded = Buffer.from(JSON.stringify({ ...f.lineage, ...fields }), 'utf8');
      const limit = 64 * 1024;
      const exact = Buffer.concat([encoded, Buffer.alloc(limit - encoded.byteLength, 0x20)]);
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(exact);
          if (size === 'over-limit') controller.enqueue(Buffer.from(' '));
          else controller.close();
        },
        cancel() {
          cancelled = true;
        },
      });
      const request = new Request(f.request(fields), { body, duplex: 'half' });
      const work = authenticateHarnessLoginRequest({
        coreDb: f.coreDb,
        gateway: f.gateway,
        physical: f.physical,
        request,
        now: f.now,
      });
      if (size === 'at-limit') {
        const authenticated = await work;
        expect(authenticated.context).toEqual(f.context);
        expect(authenticated.request).toEqual({ ...f.lineage, ...fields });
      } else {
        await expect(work).rejects.toThrow();
        expect(cancelled).toBe(true);
      }
      expect(f.noMaterialEffects()).toBe(true);
    }
  );

  it.each(['JSON', 'UTF-8'] as const)(
    'refuses malformed %s without changing lifecycle state',
    async (encoding) => {
      const f = await fixture();
      expect(requireHarnessLoginBinding(f.coreDb, f.context, f.now())).toBe(f.integrationRef);
      expect(f.gateway.authenticatePackageToken(`Bearer ${f.registration.token}`).snapshotId).toBe(
        f.environmentPackage.snapshotId
      );
      f.physical.assertCurrent();
      const fields = { kind: 'complete', receiptId: 'decode-marker', materialGeneration: 1 };
      const valid = Buffer.from(JSON.stringify({ ...f.lineage, ...fields }), 'utf8');
      const marker = Buffer.from(fields.receiptId);
      const offset = valid.indexOf(marker);
      // Invalid UTF-8 inside an otherwise valid JSON string would be accepted by lossy decoding.
      const malformed =
        encoding === 'JSON'
          ? valid.subarray(0, valid.byteLength - 1)
          : Buffer.concat([
              valid.subarray(0, offset),
              Buffer.from([0xc3, 0x28]),
              valid.subarray(offset + marker.byteLength),
            ]);
      const request = new Request(f.request(fields), { body: new Uint8Array(malformed) });
      await expect(
        authenticateHarnessLoginRequest({
          coreDb: f.coreDb,
          gateway: f.gateway,
          physical: f.physical,
          request,
          now: f.now,
        })
      ).rejects.toThrow();
      expect(f.noMaterialEffects()).toBe(true);
    }
  );

  it('cancels an actually held body read when its request signal aborts', async () => {
    const f = await fixture();
    expect(requireHarnessLoginBinding(f.coreDb, f.context, f.now())).toBe(f.integrationRef);
    expect(f.gateway.authenticatePackageToken(`Bearer ${f.registration.token}`).snapshotId).toBe(
      f.environmentPackage.snapshotId
    );
    f.physical.assertCurrent();
    const reading = Promise.withResolvers<void>();
    const held = Promise.withResolvers<void>();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>(
      {
        start(value) {
          controller = value;
        },
        pull() {
          reading.resolve();
          return held.promise;
        },
        cancel() {
          cancelled = true;
          held.resolve();
        },
      },
      { highWaterMark: 0 }
    );
    const abort = new AbortController();
    const request = new Request(f.request({ kind: 'acquire', reason: 'activate' }), {
      body,
      duplex: 'half',
      signal: abort.signal,
    });
    const work = authenticateHarnessLoginRequest({
      coreDb: f.coreDb,
      gateway: f.gateway,
      physical: f.physical,
      request,
      now: f.now,
    });
    try {
      // Zero prefetch means this observation comes from the actual consumer's pending read.
      await reading.promise;
      abort.abort();
      await expect(work).rejects.toThrow();
      expect(cancelled).toBe(true);
      expect(f.noMaterialEffects()).toBe(true);
    } finally {
      controller.error(new Error('Auth fixture body released.'));
      held.resolve();
      await work.catch(() => undefined);
    }
  });

  // Physical files, AEP and Core lineage remain available; the canonical Workspace row is authority.
  it.each(['entry', 'recheck'] as const)(
    'refuses %s after canonical Workspace authority becomes invalid',
    async (stage) => {
      const f = await fixture();
      const workspaceId = f.context.workspaceId;
      const scope = nativeProductScope(f.coreDb.dataRoot, { kind: 'workspace', workspaceId });
      let reader = openControlStoreProductReadHandle(scope.path, scope.owner);
      try {
        const original = reader.get('workspace', workspaceId);
        if (!original) throw new Error('Workspace fault requires the original canonical row.');
        expect(original.record.id).toBe(workspaceId);
        const authenticated =
          stage === 'recheck'
            ? await authenticateHarnessLoginRequest({
                coreDb: f.coreDb,
                gateway: f.gateway,
                physical: f.physical,
                request: f.request({ kind: 'acquire', reason: 'activate' }),
                now: f.now,
              })
            : undefined;
        // Stop the actual writer before the shared physical-corruption fixture changes its row.
        reader.close();
        await shutdownControlStoreWorkerClient();
        reader = openControlStoreProductReadHandle(scope.path, scope.owner);
        try {
          // Satisfy SQL's positive-revision constraint while violating the canonical safe integer.
          setTestWorkspaceRevision(f.coreDb.dataRoot, workspaceId, Number.MAX_SAFE_INTEGER + 1);
          expect(() => reader.get('workspace', workspaceId)).toThrow();
          expect(
            f.gateway.authenticatePackageToken(`Bearer ${f.registration.token}`).snapshotId
          ).toBe(f.environmentPackage.snapshotId);
          expect(requireHarnessLoginBinding(f.coreDb, f.context, f.now())).toBe(f.integrationRef);
          f.physical.assertCurrent();
          if (stage === 'entry') {
            const refused = await authenticateHarnessLoginRequest({
              coreDb: f.coreDb,
              gateway: f.gateway,
              physical: f.physical,
              request: f.request({ kind: 'acquire', reason: 'activate' }),
              now: f.now,
            }).then(
              () => false,
              () => true
            );
            expect(refused).toBe(true);
          } else {
            expect(() => authenticated!.recheck()).toThrow();
          }
        } finally {
          setTestWorkspaceRevision(f.coreDb.dataRoot, workspaceId, original.revision);
        }
        expect(f.noMaterialEffects()).toBe(true);
      } finally {
        reader.close();
      }
    }
  );

  it.each(['token', 'physical', 'generation', 'binding', 'deadline', 'package'] as const)(
    'rechecks current %s authority after an await',
    async (changed) => {
      const f = await fixture();
      const authenticated = await authenticateHarnessLoginRequest({
        coreDb: f.coreDb,
        gateway: f.gateway,
        physical: f.physical,
        request: f.request({ kind: 'acquire', reason: 'activate' }),
        now: f.now,
      });
      await Promise.resolve();
      if (changed === 'token') f.gateway.unregisterSession(f.environmentPackage.snapshotId);
      else if (changed === 'physical') f.authority.fenceAuthoritative(f.target.identityId);
      else if (changed === 'generation')
        await allocateNanoHostRuntimeTargetConnectionGeneration(f.coreDb, {
          targetId: f.target.targetId,
          identityId: f.target.identityId,
          deploymentId: f.target.deploymentId,
          observedAt: timestamp,
        });
      else if (changed === 'binding')
        await fenceNanoHostSandboxRuntime(f.coreDb, {
          sandboxBindingRef: f.sandboxBindingRef,
          timestamp,
        });
      else if (changed === 'package') f.removeSnapshot();
      else f.expire();
      expect(() => authenticated.recheck()).toThrow();
      expect(listVaultUseRecords(f.coreDb)).toEqual([]);
      expect(listVaultUseRecords(f.workspaceDb)).toEqual([]);
      expect(listVaultInjectionReceipts(f.coreDb)).toEqual([]);
      expect(f.noMaterialEffects()).toBe(true);
    }
  );
});
