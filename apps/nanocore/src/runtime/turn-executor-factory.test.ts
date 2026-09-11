import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { connect as connectHttp2, createServer as createHttp2Server } from 'node:http2';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AgentEnvironmentPackage,
  planSessionWorkspaceMaterialization,
} from '@openkit/config-schema';
import { describe, expect, it, vi } from 'vitest';

import {
  createNanoHostTransportSessionAuthority,
  readNanoHostPhysicalConnectionContext,
} from '../auth/nanohost-transport-session.js';
import { SimulatedTurnExecutor } from '../lib/simulator.js';
import { createDemoWorkspaceForUser, FsStore } from '../lib/store.js';
import { ProviderRegistry } from '../providers/registry.js';
import {
  createSchedulerAdmissionEntry,
  dispatchNextSchedulerEntry,
  upsertSchedulerCapacityRecord,
  upsertSchedulerTargetHealthRecord,
  upsertSchedulerWorkerPool,
} from '../scheduler-records.js';
import { openCoreDb } from '../storage/db.js';
import { ensureLayout } from '../storage/fs-layout.js';
import { applyMigrations } from '../storage/migrate.js';
import {
  createTestAgentSetup,
  createTestGatewayConfig,
} from '../test-support/agent-environment.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { resolveAgentEnvironmentPackage } from './agent-environment.js';
import {
  createNanoHostHarnessRuntime,
  deriveNanoHostAgentSessionCompatibilityKey,
  dispatchNanoHostHarnessOperation,
  markNanoHostHarnessOperationUnknown,
  openNanoHostAgentSessionBinding,
  queueNanoHostHarnessOperation,
  settleNanoHostHarnessOperation,
} from './nanohost-harness-records.js';
import {
  allocateNanoHostRuntimeTargetConnectionGeneration,
  upsertNanoHostRuntimeTarget,
} from './nanohost-runtime-target.js';
import type {
  NanoHostSessionDispatch,
  NanoHostSessionEffectRequest,
} from './nanohost-session-dispatch.js';
import { createNanoHostSessionDispatch } from './nanohost-session-dispatch.js';
import { runSchedulerDispatchLoop } from './scheduler-dispatch-loop.js';
import {
  createConfiguredTurnExecutor,
  createConfiguredWorkerLifecycleRuntime,
} from './turn-executor-factory.js';
import type { PrepareAgentSessionForTurnInput } from './types.js';
import { WorkerControlGateway } from './worker-control-gateway.js';
import { recordWorkerControlAcceptedRecord } from './worker-control-records.js';
import {
  openShellFilesystemGrantsFromPackagePolicy,
  type WorkerGovernanceBackend,
  type WorkerGovernanceBackendSessionIdentity,
  WorkerGovernanceCapacityUnavailableError,
} from './worker-governance-backend.js';
import {
  activateWorkerStorageAttachment,
  createWorkerStorageBinding,
  getWorkerStorageBinding,
  getWorkerStorageBindingForSandbox,
  releaseWorkerStorageAttachment,
  reserveWorkerStorageAttachment,
  workerStorageDefaultWorkSlotRef,
} from './worker-storage-bindings.js';

/** Creates the durable deployment identity required by real executor construction. */
function createFactoryCoreDb() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-turn-executor-factory-'));
  ensureLayout(dataRoot);
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  return coreDb;
}

const factoryCoreDb = createFactoryCoreDb();

/** Returns the fixed persistent-image facts used by NanoHost materialization fixtures. */
function nanoHostImageInspection(request: NanoHostSessionEffectRequest) {
  return {
    digest: request.input.imageDigest,
    platform: { architecture: 'amd64', os: 'linux' },
    storageLayout: {
      family: 'openkit-worker',
      gid: 1000,
      targets: [{ target: '/sandbox' }, { target: '/workspace' }],
      uid: 1000,
      version: '1',
      workingDirectory: '/tmp/openkit-bootstrap',
    },
  };
}

/** Returns the exact host-proved storage attachment for one sandbox.create fixture. */
function nanoHostSandboxCreated(request: NanoHostSessionEffectRequest) {
  const storage = request.input.storage as {
    readonly attachmentGeneration: number;
    readonly layoutDigest: string;
    readonly scopeDigest: string;
    readonly storageRef: string;
    readonly targets: readonly { readonly target: string; readonly volumeRef: string }[];
  };
  return {
    sandboxId: request.input.sandboxId,
    state: 'created',
    storage: {
      ...storage,
      targets: storage.targets.map((target) => ({ ...target, initialized: true })),
    },
  };
}

/** Creates the current user, Workspace membership, and Thread facts required by storage admission. */
function authorizeNanoHostPackage(
  coreDb: ReturnType<typeof createFactoryCoreDb>,
  environmentPackage: AgentEnvironmentPackage
): void {
  const triggerActor = environmentPackage.scope.triggerActor;
  const userId = triggerActor.kind === 'user' ? triggerActor.id : triggerActor.responsibleUserId;
  if (!userId) throw new Error('Test package requires one responsible user.');
  coreDb.sqlite
    .prepare(
      `INSERT OR IGNORE INTO users (
         id, display_name, email, email_verified, kind, status, created_at, updated_at
       ) VALUES (?, ?, ?, 0, 'human', 'active', 0, 0)`
    )
    .run(userId, userId, `${userId}@worker-fixture.openkit.invalid`);
  const store = new FsStore({ dataRoot: coreDb.dataRoot });
  try {
    store.getWorkspace(environmentPackage.scope.workspaceId);
  } catch {
    const fixture = createDemoWorkspaceForUser(userId);
    store.importWorkspaceSnapshot({
      agentSessions: [],
      artifacts: [],
      itemRevisions: [],
      knowledge: [],
      threads: [],
      turnEvents: [],
      turns: [],
      workspace: {
        ...fixture.workspace,
        counts: { artifactCount: 0, knowledgeEntryCount: 0, threadCount: 0 },
        id: environmentPackage.scope.workspaceId,
      },
    });
  }
  try {
    store.getThread(environmentPackage.scope.workspaceId, environmentPackage.scope.threadId);
  } catch {
    store.createThread(
      environmentPackage.scope.workspaceId,
      'Worker storage fixture',
      environmentPackage.scope.threadId
    );
  }
  recordWorkspaceOwnerMembership({
    coreDb,
    ownerUserId: userId,
    workspaceId: environmentPackage.scope.workspaceId,
  });
}

/** Adds the already-owned pre-effect backend anchor for direct backend-unit materialization. */
function anchorNanoHostMaterialization(
  coreDb: ReturnType<typeof createFactoryCoreDb>,
  backend: WorkerGovernanceBackend,
  environmentPackage: AgentEnvironmentPackage
): void {
  const internal = backend as WorkerGovernanceBackend & {
    requireLeaseId(packageSnapshotId: string): string;
  };
  const identity = backend.planSession(environmentPackage);
  let leaseId: string;
  try {
    leaseId = internal.requireLeaseId(environmentPackage.snapshotId);
  } catch {
    leaseId = `lease-fixture:${environmentPackage.snapshotId}`;
  }
  if (
    coreDb.sqlite.prepare('SELECT 1 FROM worker_backend_sessions WHERE lease_id = ?').get(leaseId)
  ) {
    return;
  }
  const target = coreDb.sqlite
    .prepare(
      'SELECT physical_epoch AS physicalEpoch FROM nanohost_runtime_targets WHERE target_id = ?'
    )
    .get(identity.runtimeTargetId) as { readonly physicalEpoch: string | null } | undefined;
  if (!target?.physicalEpoch) throw new Error('Test materialization requires a physical Epoch.');
  let lease = coreDb.sqlite
    .prepare(
      'SELECT sandbox_binding_ref AS sandboxBindingRef FROM scheduler_session_leases WHERE lease_id = ?'
    )
    .get(leaseId) as { readonly sandboxBindingRef: string } | undefined;
  if (!lease) {
    const sandboxBindingRef = `lease-binding:${leaseId}`;
    coreDb.sqlite
      .prepare(
        `INSERT INTO scheduler_session_leases (
           lease_id, plan_id, workspace_id, thread_id, turn_id, agent_session_id,
           package_snapshot_id, pool_id, target_id, status, acquired_at, expires_at,
           heartbeat_deadline, startup_deadline, renewal_count, scheduler_epoch,
           sandbox_binding_ref
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'acquired', ?, ?, ?, ?, 0, 1, ?)`
      )
      .run(
        leaseId,
        `plan:${leaseId}`,
        environmentPackage.scope.workspaceId,
        environmentPackage.scope.threadId,
        environmentPackage.scope.turnId,
        environmentPackage.scope.agentSessionId,
        environmentPackage.snapshotId,
        `pool:${leaseId}`,
        identity.runtimeTargetId,
        environmentPackage.createdAt,
        '2999-01-01T00:00:00.000Z',
        '2999-01-01T00:00:00.000Z',
        '2999-01-01T00:00:00.000Z',
        sandboxBindingRef
      );
    lease = { sandboxBindingRef };
  }
  coreDb.sqlite
    .prepare(
      `INSERT INTO worker_backend_sessions (
         lease_id, workspace_id, thread_id, turn_id, agent_session_id,
         package_snapshot_id, backend_kind, deployment_id, backend_version,
         backend_session_id, runtime_target_id, origin_physical_epoch,
         backend_lineage_json, sandbox_binding_ref, staging_directory_ref,
         transient_provider_instance_id, workspace_handoff_state, state,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '0.0.99', ?, ?, ?, ?, ?, ?, ?,
         'pending', 'materializing', ?, ?)`
    )
    .run(
      leaseId,
      environmentPackage.scope.workspaceId,
      environmentPackage.scope.threadId,
      environmentPackage.scope.turnId,
      identity.agentSessionId,
      identity.packageSnapshotId,
      identity.backendKind,
      identity.deploymentId,
      identity.backendSessionId,
      identity.runtimeTargetId,
      target.physicalEpoch,
      JSON.stringify(
        environmentPackage.runtime.image.kind === 'reference'
          ? { imageRef: environmentPackage.runtime.image.ref }
          : { resultingImageDigest: environmentPackage.runtime.image.input.digest }
      ),
      lease?.sandboxBindingRef ?? `lease-binding:${leaseId}`,
      identity.stagingDirectoryRef,
      identity.transientProviderInstanceId,
      environmentPackage.createdAt,
      environmentPackage.createdAt
    );
}

/** Adds the attached retained-storage owner required by one directly-authored Sandbox fixture. */
function attachNanoHostStorageFixture(
  coreDb: ReturnType<typeof createFactoryCoreDb>,
  input: {
    readonly agentSessionId: string;
    readonly deploymentId: string;
    readonly runtimeTargetId: string;
    readonly sandboxBindingRef: string;
    readonly threadId: string;
    readonly workspaceId: string;
  }
) {
  const layout = {
    family: 'openkit-worker',
    gid: 1000,
    platform: { architecture: 'amd64', os: 'linux' },
    targets: [{ target: '/sandbox' }, { target: '/workspace' }],
    uid: 1000,
    version: '1',
    workingDirectory: '/tmp/openkit-bootstrap',
  };
  const binding = createWorkerStorageBinding(coreDb, {
    deploymentId: input.deploymentId,
    layout,
    runtimeTargetId: input.runtimeTargetId,
    workspaceId: input.workspaceId,
  });
  const reserved = reserveWorkerStorageAttachment(coreDb, {
    agentSessionId: input.agentSessionId,
    authorizeContributor: () => true,
    expectedRevision: binding.revision,
    layout,
    purpose: 'work',
    responsibleUserId: 'user_fixture',
    runtimeTargetId: input.runtimeTargetId,
    storageRef: binding.storageRef,
    threadId: input.threadId,
    workspaceId: input.workspaceId,
  });
  return activateWorkerStorageAttachment(coreDb, {
    attachmentGeneration: reserved.attachmentGeneration,
    expectedRevision: reserved.revision,
    sandboxBindingRef: input.sandboxBindingRef,
    storageRef: reserved.storageRef,
    targets: reserved.targets.map((target) => ({ ...target, initialized: true })),
  });
}

/** Completes the compatibility inputs omitted by narrow backend test fixtures. */
function completeNanoHostPackage(input: {
  readonly [key: string]: unknown;
  readonly scope: Record<string, unknown>;
  readonly snapshotId: string;
  readonly workspace?: Record<string, unknown>;
}): AgentEnvironmentPackage {
  const base = resolveAgentEnvironmentPackage({
    agentSessionId: 'as_factory_fixture',
    agentSetup: createTestAgentSetup(),
    backend: { kind: 'openshell' },
    createdAt: '2026-08-21T00:00:00.000Z',
    requestId: 'request_factory_fixture',
    triggerActor: { kind: 'user', id: 'user-factory' },
    turn: {
      completedAt: null,
      configVersion: null,
      durationMs: null,
      error: null,
      humanGate: null,
      id: 'turn_factory_fixture',
      items: [],
      startedAt: '2026-08-21T00:00:00.000Z',
      status: 'running',
      threadId: 'thread_factory_fixture',
      triggerActor: { kind: 'user', id: 'user-factory' },
      workspaceId: 'workspace_factory_fixture',
    },
    turnInput: 'Run fixture',
    workspaceCwd: '/workspace',
    workspaceRoots: [],
  });
  const runtime = input.runtime as Partial<AgentEnvironmentPackage['runtime']> | undefined;
  const extensions = input.extensions as AgentEnvironmentPackage['extensions'] | undefined;
  const baseOpenkit = base.extensions.openkit as Record<string, unknown>;
  const inputOpenkit = extensions?.openkit as Record<string, unknown> | undefined;
  return {
    ...base,
    ...input,
    runtime: {
      ...base.runtime,
      ...runtime,
      image: runtime?.image ?? base.runtime.image,
    },
    scope: { ...base.scope, ...input.scope },
    workspace: { ...base.workspace, ...input.workspace },
    extensions: {
      ...base.extensions,
      ...extensions,
      openkit: { ...baseOpenkit, ...inputOpenkit },
    },
  } as AgentEnvironmentPackage;
}

describe('createConfiguredTurnExecutor', () => {
  it('exposes NanoHost as the sole production runtime selector', () => {
    const runtime = createConfiguredWorkerLifecycleRuntime({
      coreDb: factoryCoreDb,
      env: {},
      workerControlGateway: new WorkerControlGateway(),
    });

    expect((runtime as unknown as { runtimeTargetKind?: string }).runtimeTargetKind).toBe(
      'nanohost'
    );
    expect(runtime).not.toHaveProperty('placement');
    expect(runtime.turnExecutor).not.toHaveProperty('environmentBackend');
  });

  it('projects OpenShell version 0.0.99 from the NanoHost backend capability observation', async () => {
    const runtime = createConfiguredWorkerLifecycleRuntime({
      coreDb: factoryCoreDb,
      env: {},
      workerControlGateway: new WorkerControlGateway(),
    });
    const backend = (
      runtime.turnExecutor as unknown as {
        readonly backend: {
          describeCapabilities(): Promise<{
            readonly kind: string;
            readonly version?: string | null;
          }>;
        };
      }
    ).backend;

    await expect(backend.describeCapabilities()).resolves.toMatchObject({
      kind: 'openshell',
      version: '0.0.99',
    });
  });

  it('keeps strict image inspection carriage closed while retaining lifecycle effect identity', async () => {
    const coreDb = createFactoryCoreDb();
    const authority = createNanoHostTransportSessionAuthority();
    const dispatch = createNanoHostSessionDispatch({ sessionAuthority: authority });
    const runtimeTarget = {
      coreDb,
      deploymentId: 'deployment_effect_carriage',
      identityId: 'identity_effect_carriage',
      targetId: 'target_effect_carriage',
    };
    allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
      ...runtimeTarget,
      observedAt: '2026-09-11T00:00:00.000Z',
    });
    let acceptPhysical!: (connection: object) => void;
    const physicalReady = new Promise<object>((resolve) => {
      acceptPhysical = resolve;
    });
    const server = createHttp2Server((request, response) => {
      const physical = readNanoHostPhysicalConnectionContext(request);
      if (physical) acceptPhysical(physical);
      response.writeHead(204).end();
    });
    let client: ReturnType<typeof connectHttp2> | undefined;
    try {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing test address.');
      client = connectHttp2(`http://127.0.0.1:${address.port}`);
      client.request({ ':method': 'POST', ':path': '/' }).end();
      const physical = await physicalReady;
      authority.admit({
        connectionGeneration: 1,
        identityId: runtimeTarget.identityId,
        physicalConnection: physical,
      });
      await dispatch.readiness!(
        physical,
        Buffer.from(JSON.stringify({ physicalEpoch: 'a'.repeat(64) })),
        runtimeTarget
      );

      const runtime = createConfiguredWorkerLifecycleRuntime({
        coreDb,
        env: {},
        nanoHostSessionDispatch: dispatch,
        workerControlGateway: new WorkerControlGateway(),
      });
      const requestBuilder = (
        runtime.turnExecutor as unknown as {
          readonly backend: {
            createEffectRequest(
              identity: WorkerGovernanceBackendSessionIdentity,
              leaseId: string,
              operation: 'image.inspect' | 'sandbox.create',
              input: Readonly<Record<string, unknown>>
            ): NanoHostSessionEffectRequest;
          };
        }
      ).backend;
      const identity: WorkerGovernanceBackendSessionIdentity = {
        agentSessionId: 'as_effect_carriage',
        backendKind: 'openshell',
        backendSessionId: 'sandbox-effect-carriage',
        deploymentId: runtimeTarget.deploymentId,
        packageSnapshotId: 'aepsnap_effect_carriage',
        runtimeTargetId: runtimeTarget.targetId,
        stagingDirectoryRef: 'runtime-staging/effect-carriage',
        transientProviderInstanceId: null,
      };
      const imageDigest = `sha256:${'d'.repeat(64)}`;
      const imageInspection = requestBuilder.createEffectRequest(
        identity,
        'lease_effect_carriage',
        'image.inspect',
        { imageDigest }
      );
      const otherLeaseInspection = requestBuilder.createEffectRequest(
        identity,
        'lease_effect_carriage_other',
        'image.inspect',
        { imageDigest }
      );
      expect(imageInspection.input).toEqual({ imageDigest });
      expect(imageInspection.requestId).toMatch(/^[0-9a-f]{64}$/);
      expect(otherLeaseInspection.input).toEqual({ imageDigest });
      expect(otherLeaseInspection.requestId).not.toBe(imageInspection.requestId);

      const pendingInspection = dispatch.effect(imageInspection);
      void pendingInspection.catch(() => undefined);
      await expect(dispatch.poll(physical, 'image.inspect')).resolves.toEqual({
        imageDigest,
        requestId: imageInspection.requestId,
      });
      await dispatch.result(physical, 'image.inspect', {
        digest: imageDigest,
        requestId: imageInspection.requestId,
      });
      await expect(pendingInspection).resolves.toEqual({ digest: imageDigest });

      const sandboxCreate = requestBuilder.createEffectRequest(
        identity,
        'lease_effect_carriage',
        'sandbox.create',
        {
          imageDigest,
          sandboxId: 'sandbox-effect-carriage',
          storage: {
            attachmentGeneration: 1,
            layoutDigest: `sha256:${'a'.repeat(64)}`,
            scopeDigest: `sha256:${'b'.repeat(64)}`,
            storageRef: 'wst_effect_carriage',
            targets: [{ target: '/workspace', volumeRef: 'wsv_effect_carriage' }],
          },
        }
      );
      expect(sandboxCreate.input).toMatchObject({
        backendSessionId: identity.backendSessionId,
        leaseId: 'lease_effect_carriage',
        packageSnapshotId: identity.packageSnapshotId,
        storage: { storageRef: 'wst_effect_carriage' },
      });
      const pendingSandbox = dispatch.effect(sandboxCreate);
      void pendingSandbox.catch(() => undefined);
      await expect(dispatch.poll(physical, 'sandbox.create')).resolves.toEqual({
        ...sandboxCreate.input,
        requestId: sandboxCreate.requestId,
      });
      await dispatch.result(physical, 'sandbox.create', {
        failureCode: 'effect_failed',
        requestId: sandboxCreate.requestId,
      });
      await expect(pendingSandbox).rejects.toMatchObject({
        message: 'NanoHost effect failed: effect_failed.',
        status: 500,
      });
    } finally {
      client?.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      coreDb.sqlite.close();
    }
  });

  it('retires one pre-witness cleanup through the first different fresh Epoch without dispatch', async () => {
    const coreDb = createFactoryCoreDb();
    const authority = createNanoHostTransportSessionAuthority();
    const dispatch = createNanoHostSessionDispatch({ coreDb, sessionAuthority: authority });
    const runtimeTarget = {
      coreDb,
      deploymentId: 'deployment_pre_witness_cleanup',
      identityId: 'identity_pre_witness_cleanup',
      targetId: 'target_pre_witness_cleanup',
    };
    allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
      ...runtimeTarget,
      observedAt: '2026-09-11T00:00:00.000Z',
    });
    let acceptPhysical!: (connection: object) => void;
    const physicalReady = new Promise<object>((resolve) => {
      acceptPhysical = resolve;
    });
    const server = createHttp2Server((request, response) => {
      const physical = readNanoHostPhysicalConnectionContext(request);
      if (physical) acceptPhysical(physical);
      response.writeHead(204).end();
    });
    let client: ReturnType<typeof connectHttp2> | undefined;
    try {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing test address.');
      client = connectHttp2(`http://127.0.0.1:${address.port}`);
      client.request({ ':method': 'POST', ':path': '/' }).end();
      const physical = await physicalReady;
      authority.admit({
        connectionGeneration: 1,
        identityId: runtimeTarget.identityId,
        physicalConnection: physical,
      });
      await dispatch.readiness!(
        physical,
        Buffer.from(JSON.stringify({ physicalEpoch: 'a'.repeat(64) })),
        runtimeTarget
      );

      const runtime = createConfiguredWorkerLifecycleRuntime({
        coreDb,
        env: {},
        nanoHostSessionDispatch: dispatch,
        workerControlGateway: new WorkerControlGateway(),
      });
      const backend = (
        runtime.turnExecutor as unknown as {
          readonly backend: WorkerGovernanceBackend & {
            requireLeaseId(packageSnapshotId: string): string;
          };
        }
      ).backend;
      backend.requireLeaseId = () => 'lease_pre_witness_cleanup';
      const identity = backend.planSession(
        completeNanoHostPackage({
          scope: {
            agentSessionId: 'as_pre_witness_cleanup',
            threadId: 'thread_pre_witness_cleanup',
            turnId: 'turn_pre_witness_cleanup',
            workspaceId: 'workspace_pre_witness_cleanup',
          },
          snapshotId: 'aepsnap_pre_witness_cleanup',
        })
      );
      const sandboxCompatibilityKey = `${identity.backendSessionId.slice(3, 19)}${'c'.repeat(48)}`;
      createNanoHostHarnessRuntime(coreDb, {
        adapterId: 'codex',
        adapterVersion: '0.153.4',
        harnessBindingRef: 'harness-binding-pre-witness-cleanup',
        harnessCompatibilityKey: 'd'.repeat(64),
        harnessInstanceId: 'harness-pre-witness-cleanup',
        imageDigest: `sha256:${'1'.repeat(64)}`,
        originPhysicalEpoch: 'a'.repeat(64),
        sandboxBindingRef: 'sandbox-binding-pre-witness-cleanup',
        sandboxCompatibilityKey,
        sandboxIntegrationBindingRef: 'integration-pre-witness-cleanup',
        sandboxRuntimeId: 'sandbox-runtime-pre-witness-cleanup',
        runtimeTargetId: identity.runtimeTargetId,
        timestamp: '2026-09-11T00:00:00.000Z',
      });
      coreDb.sqlite
        .prepare(
          `UPDATE sandbox_runtime_records SET origin_physical_epoch = 'pre-witness'
           WHERE sandbox_runtime_id = 'sandbox-runtime-pre-witness-cleanup'`
        )
        .run();
      const storage = attachNanoHostStorageFixture(coreDb, {
        agentSessionId: identity.agentSessionId,
        deploymentId: identity.deploymentId,
        runtimeTargetId: identity.runtimeTargetId,
        sandboxBindingRef: 'sandbox-binding-pre-witness-cleanup',
        threadId: 'thread_pre_witness_cleanup',
        workspaceId: 'workspace_pre_witness_cleanup',
      });
      coreDb.sqlite
        .prepare(
          `INSERT INTO worker_backend_sessions (
             lease_id, workspace_id, thread_id, turn_id, agent_session_id,
             package_snapshot_id, backend_kind, deployment_id, backend_session_id,
             runtime_target_id, origin_physical_epoch, backend_lineage_json, sandbox_binding_ref,
             staging_directory_ref, workspace_handoff_state, state, created_at, updated_at
           ) VALUES (
             'lease_pre_witness_cleanup', 'workspace_pre_witness_cleanup',
             'thread_pre_witness_cleanup', 'turn_pre_witness_cleanup', ?, ?, 'openshell', ?, ?, ?,
             'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '{}',
             'lease-binding:pre-witness-cleanup', ?, 'pending',
             'cleanup-pending', ?, ?
           )`
        )
        .run(
          identity.agentSessionId,
          identity.packageSnapshotId,
          identity.deploymentId,
          identity.backendSessionId,
          identity.runtimeTargetId,
          identity.stagingDirectoryRef,
          '2026-09-11T00:00:00.000Z',
          '2026-09-11T00:00:00.000Z'
        );

      runtime.prepareBackendCleanup(identity);
      const initialCleanup = runtime.cleanupBackendSession(identity);
      await expect(dispatch.poll(physical, 'sandbox.create')).resolves.toBeNull();
      await expect(initialCleanup).rejects.toThrow(/physical Epoch/i);
      expect(authority.mayCarryWork(physical)).toBe(true);

      runtime.prepareBackendCleanup(identity);
      await expect(runtime.cleanupBackendSession(identity)).resolves.toBeUndefined();
      await expect(dispatch.poll(physical, 'bridge.close')).resolves.toBeNull();
      await expect(dispatch.poll(physical, 'sandbox.delete')).resolves.toBeNull();
      expect(getWorkerStorageBinding(coreDb, { storageRef: storage.storageRef })).toMatchObject({
        revision: storage.revision + 2,
        state: 'idle',
      });
      expect(
        coreDb.sqlite
          .prepare(
            `SELECT COUNT(*) AS count FROM sandbox_runtime_records
             WHERE sandbox_runtime_id = 'sandbox-runtime-pre-witness-cleanup'`
          )
          .get()
      ).toEqual({ count: 0 });
    } finally {
      client?.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      coreDb.sqlite.close();
    }
  });

  it('rechecks the anchored physical Epoch immediately before effect dispatch', async () => {
    const coreDb = createFactoryCoreDb();
    const effect = vi.fn(async () => ({}));
    const sessionDispatch = {
      effect,
      async poll() {
        return null;
      },
      async result() {},
      async route() {
        throw new Error('Unexpected semantic route.');
      },
    } satisfies NanoHostSessionDispatch;
    try {
      const first = allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
        deploymentId: 'deployment_epoch_race',
        identityId: 'identity_epoch_race',
        observedAt: '2026-08-21T00:00:00.000Z',
        targetId: 'target_epoch_race',
      });
      upsertNanoHostRuntimeTarget(coreDb, {
        ...first,
        freshEmpty: true,
        observedAt: '2026-08-21T00:00:01.000Z',
        physicalEpoch: 'a'.repeat(64),
        predecessorFenced: true,
        ready: true,
      });
      const identity: WorkerGovernanceBackendSessionIdentity = {
        agentSessionId: 'as_epoch_race',
        backendKind: 'openshell',
        backendSessionId: 'backend-epoch-race',
        deploymentId: 'deployment_epoch_race',
        packageSnapshotId: 'aepsnap_epoch_race',
        runtimeTargetId: 'target_epoch_race',
        stagingDirectoryRef: 'runtime-staging/epoch-race',
        transientProviderInstanceId: null,
      };
      coreDb.sqlite
        .prepare(
          `INSERT INTO worker_backend_sessions (
             lease_id, workspace_id, thread_id, turn_id, agent_session_id,
             package_snapshot_id, backend_kind, deployment_id, backend_session_id,
             runtime_target_id, origin_physical_epoch, backend_lineage_json,
             sandbox_binding_ref, staging_directory_ref, workspace_handoff_state,
             state, created_at, updated_at
           ) VALUES ('lease_epoch_race', 'workspace_epoch_race', 'thread_epoch_race',
             'turn_epoch_race', ?, ?, 'openshell', ?, ?, ?, ?, ?,
             'sandbox-binding-epoch-race', ?, 'pending', 'materializing', ?, ?)`
        )
        .run(
          identity.agentSessionId,
          identity.packageSnapshotId,
          identity.deploymentId,
          identity.backendSessionId,
          identity.runtimeTargetId,
          'a'.repeat(64),
          JSON.stringify({ imageRef: 'openkit/worker:test' }),
          identity.stagingDirectoryRef,
          '2026-08-21T00:00:01.000Z',
          '2026-08-21T00:00:01.000Z'
        );
      const runtime = createConfiguredWorkerLifecycleRuntime({
        coreDb,
        env: {},
        nanoHostSessionDispatch: sessionDispatch,
        workerControlGateway: new WorkerControlGateway(),
      });
      const backend = (
        runtime.turnExecutor as unknown as {
          readonly backend: {
            effect(
              identity: WorkerGovernanceBackendSessionIdentity,
              leaseId: string,
              operation: 'image.inspect',
              input: Readonly<Record<string, unknown>>
            ): Promise<Record<string, unknown>>;
            requireLeaseId(packageSnapshotId: string): string;
          };
        }
      ).backend;
      backend.requireLeaseId = () => 'lease_epoch_race';
      await expect(
        backend.effect(identity, 'lease_epoch_race', 'image.inspect', {
          imageDigest: `sha256:${'d'.repeat(64)}`,
        })
      ).resolves.toEqual({});
      const replacement = allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
        deploymentId: identity.deploymentId,
        identityId: 'identity_epoch_race',
        observedAt: '2026-08-21T00:00:02.000Z',
        targetId: identity.runtimeTargetId,
      });
      upsertNanoHostRuntimeTarget(coreDb, {
        ...replacement,
        freshEmpty: true,
        observedAt: '2026-08-21T00:00:03.000Z',
        physicalEpoch: 'b'.repeat(64),
        predecessorFenced: true,
        ready: true,
      });
      await expect(
        backend.effect(identity, 'lease_epoch_race', 'image.inspect', {
          imageDigest: `sha256:${'d'.repeat(64)}`,
        })
      ).rejects.toThrow(/physical Epoch changed/i);
      expect(effect).toHaveBeenCalledTimes(1);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('keeps NanoHost session construction on the configured runtime target', () => {
    const source = readFileSync(new URL('./turn-executor-factory.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('upsertNanoHostRuntimeTarget(');
    expect(source).not.toContain('allocateNanoHostRuntimeTargetConnectionGeneration(');
    const backendSource = source
      .split('class NanoHostWorkerGovernanceBackend')[1]
      ?.split('function sessionMatchesRuntimeImage')[0];
    expect(backendSource).toBeDefined();
    expect(backendSource).not.toContain('throw nanoHostSessionUnavailable()');
    const materializeSource = backendSource
      ?.split('public async materialize(')[1]
      ?.split('public async launch(')[0];
    const launchSource = backendSource
      ?.split('public async launch(')[1]
      ?.split('/** Validates an immutable update')[0];
    const transcriptSource = backendSource
      ?.split('public async collectTranscript(')[1]
      ?.split('/** Returns workspace-change candidates')[0];
    const workspaceSource = backendSource
      ?.split('public async collectWorkspaceChanges(')[1]
      ?.split('/** Dispatches one fixed effect')[0];
    const cleanupSource = backendSource
      ?.split('public async cleanupSession(')[1]
      ?.split('/** Acquires or builds the immutable image')[0];
    expect(materializeSource).toBeDefined();
    expect(launchSource).toBeDefined();
    expect(transcriptSource).toBeDefined();
    expect(workspaceSource).toBeDefined();
    expect(cleanupSource).toBeDefined();

    const imageBuild = materializeSource?.indexOf("'image.build'") ?? -1;
    const sandboxCreate = materializeSource?.indexOf("'sandbox.create'") ?? -1;
    const contextRefCarriage = materializeSource?.indexOf('contextRef: image.contextRef') ?? -1;
    const referenceImport = launchSource?.indexOf("'reference.import'") ?? -1;
    const prepareImports = materializeSource?.indexOf('prepareNanoHostContextPackageImports') ?? -1;
    expect(imageBuild).toBeGreaterThanOrEqual(0);
    expect(contextRefCarriage).toBeGreaterThan(imageBuild);
    expect(contextRefCarriage).toBeLessThan(sandboxCreate);
    expect(sandboxCreate).toBeGreaterThanOrEqual(0);
    expect(prepareImports).toBeGreaterThan(sandboxCreate);
    expect(referenceImport).toBeGreaterThan(launchSource?.indexOf("'session.open'") ?? -1);
    expect(referenceImport).toBeGreaterThan(launchSource?.indexOf("'session.inspect'") ?? -1);
    expect(referenceImport).toBeLessThan(launchSource?.indexOf("'turn.start'") ?? -1);
    expect(materializeSource).not.toContain("'reference.import'");
    expect(launchSource).toContain('for (const file of pendingImports)');
    expect(materializeSource).toContain('this.restoreSharedHarness(');
    expect(materializeSource).toContain('await this.effect(identity, leaseId');
    for (const requiredImportOwner of [
      'pendingImports',
      'contentDigest',
      'byteLength',
      'relativePath',
      'body',
    ]) {
      expect(launchSource).toContain(requiredImportOwner);
    }
    expect(launchSource).toContain("'bridge.open'");
    const effectSource = backendSource?.split('private async effect(')[1];
    expect(effectSource).toContain('stableNanoHostEffectJson');
    expect(effectSource).toContain('operation');
    expect(effectSource).toContain("operation === 'bridge.open'");
    for (const bootstrapField of [
      'harnessBindingRef',
      'integrationReady',
      'session.open',
      'final_status',
      'processGroupAbsent',
    ]) {
      expect(backendSource).toContain(bootstrapField);
    }
    expect(materializeSource).not.toContain('workerControlToken');
    expect(materializeSource).not.toContain('workerInferenceToken');
    expect(launchSource).not.toContain('workerControlToken');
    expect(launchSource).not.toContain('workerInferenceToken');
    expect(backendSource).toContain('acceptHarnessCommand');
    expect(backendSource?.indexOf('final_status')).toBeLessThan(
      backendSource?.indexOf("'file.export'") ?? -1
    );
    for (const collectionSource of [transcriptSource, workspaceSource]) {
      expect(collectionSource).toContain('await this.effect(');
      expect(collectionSource).toContain("'file.export'");
      for (const field of ['slot', 'relativePath', 'maxByteLength']) {
        expect(collectionSource).toContain(field);
      }
      expect(collectionSource).toContain('terminalBarrierProved');
      const exportCommand = collectionSource?.indexOf("'file.export'") ?? -1;
      expect(collectionSource?.indexOf('sha256', exportCommand)).toBeGreaterThan(exportCommand);
      expect(collectionSource?.indexOf('byteLength', exportCommand)).toBeGreaterThan(exportCommand);
    }
    for (const field of ['slot', 'relativePath', 'sha256', 'byteLength']) {
      expect(launchSource).toContain(field);
    }
    expect(cleanupSource?.indexOf("'bridge.close'")).toBeLessThan(
      cleanupSource?.indexOf("'sandbox.delete'") ?? -1
    );
    expect(backendSource).not.toMatch(/\b(?:readFile|writeFile|copyFile|fetch)\s*\(/);
  });

  it('treats an absent optional workspace-change manifest as no changes', async () => {
    const coreDb = createFactoryCoreDb();
    const effects: NanoHostSessionEffectRequest[] = [];
    const sessionDispatch: NanoHostSessionDispatch = {
      async effect(
        requestOrConnection: object,
        carriedRequest?: NanoHostSessionEffectRequest
      ): Promise<unknown> {
        effects.push(carriedRequest ?? (requestOrConnection as NanoHostSessionEffectRequest));
        return { state: 'absent' };
      },
      async poll() {
        return null;
      },
      async result() {},
      async route() {
        throw new Error('Unexpected semantic route.');
      },
    };
    const runtime = createConfiguredWorkerLifecycleRuntime({
      coreDb,
      env: {},
      nanoHostSessionDispatch: sessionDispatch,
      workerControlGateway: new WorkerControlGateway(),
    });
    const backend = (
      runtime.turnExecutor as unknown as {
        readonly backend: WorkerGovernanceBackend & {
          readonly sessions: Map<string, unknown>;
        };
      }
    ).backend;
    try {
      coreDb.sqlite
        .prepare(
          `INSERT INTO nanohost_runtime_targets (
             target_id, identity_id, deployment_id, connection_generation,
             predecessor_fenced, ready, fresh_empty, physical_epoch, observed_at, slot_count
           ) VALUES ('target_optional_workspace_changes', 'identity_optional_workspace_changes',
                     'deployment_optional_workspace_changes', 1, 1, 1, 1, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', ?, 1)`
        )
        .run('2026-08-22T00:00:00.000Z');
      const packageSnapshotId = 'aepsnap_optional_workspace_changes';
      const environmentPackage = completeNanoHostPackage({
        extensions: {
          openkit: {
            sessionWorkspace: {
              layout: {
                slots: [{ access: 'read-write', id: 'turn-output', path: '/openkit/session' }],
              },
            },
          },
        },
        scope: {
          agentSessionId: 'as_optional_workspace_changes',
          threadId: 'thread_optional_workspace_changes',
          turnId: 'turn_optional_workspace_changes',
          workspaceId: 'workspace_optional_workspace_changes',
        },
        snapshotId: packageSnapshotId,
        workspace: {
          outputs: [
            {
              id: 'workspace-changes',
              path: '/openkit/session',
              registerAsArtifacts: false,
              retention: 'sync-on-turn-end',
            },
          ],
        },
      });
      const identity = backend.planSession(environmentPackage);
      anchorNanoHostMaterialization(coreDb, backend, environmentPackage);
      backend.sessions.set(packageSnapshotId, {
        environmentPackage,
        identity,
        leaseId: 'lease_optional_workspace_changes',
        sharedHarness: { sandbox: { sandboxId: identity.backendSessionId.slice(0, 19) } },
        terminalInspectionComplete: true,
      });

      await expect(backend.collectWorkspaceChanges(packageSnapshotId, true)).resolves.toEqual([]);
      expect(effects).toHaveLength(1);
      expect(effects[0]).toMatchObject({
        input: {
          presence: 'optional',
          relativePath: 'workspace-changes.json',
          slot: 'turn-output',
        },
        kind: 'file.export',
      });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('denies a fresh AgentSession before lease acquisition when RuntimeTarget is missing', async () => {
    const coreDb = createFactoryCoreDb();
    const store = createDemoStore();
    const turn = store.updateTurn(
      store.createTurn(
        'ws_demo',
        'th_demo',
        'Require configured NanoHost readiness',
        { kind: 'user', id: 'user_local' },
        null
      ).id,
      { agentId: 'agent_codex_host' }
    );
    const runtime = createConfiguredWorkerLifecycleRuntime({
      coreDb,
      env: {},
      workerControlGateway: new WorkerControlGateway(),
    });
    try {
      await expect(
        runtime.turnExecutor.prepareAgentSessionForTurn?.(store, {
          agentSetup: createTestAgentSetup(),
          freshAgentSessionId: 'as-missing-runtime-target',
          requestId: 'req-missing-runtime-target',
          turn,
          turnInput: turn.input,
          workspaceRoots: [],
        })
      ).rejects.toMatchObject({ code: 'recovery_required', status: 409 });
      expect(
        coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM scheduler_session_leases').get()
      ).toEqual({ count: 0 });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('does not close a predecessor or acquire a lease while RuntimeTarget is unready', async () => {
    const coreDb = createFactoryCoreDb();
    const firstGeneration = allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
      deploymentId: 'deployment-unready-admission',
      identityId: 'identity-unready-admission',
      observedAt: '2026-08-21T00:00:00.000Z',
      targetId: 'target-unready-admission',
    });
    upsertNanoHostRuntimeTarget(coreDb, {
      ...firstGeneration,
      freshEmpty: true,
      physicalEpoch: 'a'.repeat(64),
      predecessorFenced: true,
      ready: true,
      observedAt: '2026-08-21T00:00:01.000Z',
    });
    createNanoHostHarnessRuntime(coreDb, {
      adapterId: 'codex',
      adapterVersion: '0.153.4',
      harnessBindingRef: 'harness-binding-unready-admission',
      harnessCompatibilityKey: 'd'.repeat(64),
      harnessInstanceId: 'harness-unready-admission',
      imageDigest: `sha256:${'a'.repeat(64)}`,
      originPhysicalEpoch: 'a'.repeat(64),
      sandboxBindingRef: 'sandbox-binding-unready-admission',
      sandboxCompatibilityKey: 'b'.repeat(64),
      sandboxIntegrationBindingRef: 'integration-sandbox-binding-unready-admission',
      sandboxRuntimeId: 'sandbox-runtime-unready-admission',
      runtimeTargetId: 'target-unready-admission',
      timestamp: '2026-08-21T00:00:01.000Z',
    });
    openNanoHostAgentSessionBinding(coreDb, {
      agentSessionCompatibilityKey: 'c'.repeat(64),
      agentSessionId: 'as-unready-predecessor',
      agentSessionRuntimeBindingId: 'binding-unready-predecessor',
      effectiveSetupGeneration: 1,
      harnessInstanceId: 'harness-unready-admission',
      threadId: 'th_demo',
      timestamp: '2026-08-21T00:00:01.000Z',
      workspaceId: 'ws_demo',
    });
    allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
      deploymentId: 'deployment-unready-admission',
      identityId: 'identity-unready-admission',
      observedAt: '2026-08-21T00:00:02.000Z',
      targetId: 'target-unready-admission',
    });
    const store = createDemoStore();
    const turn = store.updateTurn(
      store.createTurn(
        'ws_demo',
        'th_demo',
        'Do not close before readiness',
        { kind: 'user', id: 'user_local' },
        null
      ).id,
      { agentId: 'agent_codex_host' }
    );
    store.createAgentSession({
      agentId: 'agent_codex_host',
      createdAt: '2026-08-21T00:00:01.000Z',
      environmentPackageSnapshotId: 'aepsnap-unready-predecessor',
      id: 'as-unready-predecessor',
      message: null,
      policySnapshotId: 'worker_turn_launch_policy',
      sessionCompatibilityKey: `sha256:${'d'.repeat(64)}`,
      status: 'idle',
      threadId: turn.threadId,
      updatedAt: '2026-08-21T00:00:01.000Z',
      workspaceId: turn.workspaceId,
      workspaceRoots: [],
    });
    const runtime = createConfiguredWorkerLifecycleRuntime({
      coreDb,
      env: {},
      workerControlGateway: new WorkerControlGateway(),
    });
    try {
      await expect(
        runtime.turnExecutor.prepareAgentSessionForTurn?.(store, {
          agentSetup: createTestAgentSetup(),
          freshAgentSessionId: 'as-after-unready-predecessor',
          requestId: 'req-unready-runtime-target',
          turn,
          turnInput: turn.input,
          workspaceRoots: [],
        })
      ).rejects.toBeInstanceOf(WorkerGovernanceCapacityUnavailableError);
      expect(store.getAgentSession('as-unready-predecessor').status).toBe('idle');
      expect(
        coreDb.sqlite
          .prepare(
            'SELECT lifecycle_state AS lifecycleState FROM agent_session_runtime_bindings WHERE agent_session_id = ?'
          )
          .get('as-unready-predecessor')
      ).toEqual({ lifecycleState: 'opening' });
      expect(
        coreDb.sqlite
          .prepare(
            'SELECT operation_state AS operationState FROM harness_instance_records WHERE harness_instance_id = ?'
          )
          .get('harness-unready-admission')
      ).toEqual({ operationState: 'idle' });
      expect(
        coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM scheduler_session_leases').get()
      ).toEqual({ count: 0 });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('rejects and fences a never-polled Harness operation from its enqueue deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-21T00:00:00.000Z'));
    const coreDb = createFactoryCoreDb();
    try {
      coreDb.sqlite
        .prepare(
          `INSERT INTO nanohost_runtime_targets (
             target_id, identity_id, deployment_id, connection_generation,
             predecessor_fenced, ready, fresh_empty, physical_epoch, observed_at, slot_count
           ) VALUES ('target_never_polled', 'identity_never_polled',
                     'deployment_never_polled', 1, 1, 1, 1,
                     'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', ?, 1)`
        )
        .run('2026-08-21T00:00:00.000Z');
      createNanoHostHarnessRuntime(coreDb, {
        adapterId: 'codex',
        adapterVersion: '0.153.4',
        harnessBindingRef: 'harness-binding-never-polled',
        harnessCompatibilityKey: 'd'.repeat(64),
        harnessInstanceId: 'harness-never-polled',
        imageDigest: `sha256:${'a'.repeat(64)}`,
        originPhysicalEpoch: 'a'.repeat(64),
        sandboxBindingRef: 'sandbox-binding-never-polled',
        sandboxCompatibilityKey: 'b'.repeat(64),
        sandboxIntegrationBindingRef: 'integration-never-polled',
        sandboxRuntimeId: 'sandbox-runtime-never-polled',
        runtimeTargetId: 'target_never_polled',
        timestamp: '2026-08-21T00:00:00.000Z',
      });
      const runtime = createConfiguredWorkerLifecycleRuntime({
        coreDb,
        env: {},
        workerControlGateway: new WorkerControlGateway(),
      });
      const backend = (
        runtime.turnExecutor as unknown as {
          readonly backend: {
            queueAndWaitForHarnessOperation(
              session: unknown,
              operation: 'harness.drain',
              body: Readonly<Record<string, unknown>>
            ): Promise<Readonly<Record<string, unknown>>>;
          };
        }
      ).backend;
      const session = {
        harnessBindingRef: 'harness-binding-never-polled',
        harnessInstanceId: 'harness-never-polled',
        pendingHarnessOperation: null,
      };
      const pending = backend.queueAndWaitForHarnessOperation(session, 'harness.drain', {});
      void pending.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(300_000);
      await expect(pending).rejects.toThrow(/outage budget expired/i);
      expect(
        dispatchNanoHostHarnessOperation(coreDb, {
          sandboxIntegrationBindingRef: 'integration-never-polled',
        })
      ).toBeNull();
      expect(
        coreDb.sqlite
          .prepare(
            'SELECT operation_state AS operationState, lifecycle_state AS lifecycleState FROM harness_instance_records WHERE harness_instance_id = ?'
          )
          .get('harness-never-polled')
      ).toEqual({ lifecycleState: 'failed', operationState: 'unknown' });
    } finally {
      vi.useRealTimers();
      coreDb.sqlite.close();
    }
  });

  it('prepares a fresh AgentSession when the sole RuntimeTarget is ready and unbound', async () => {
    const coreDb = createFactoryCoreDb();
    const generation = allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
      deploymentId: 'deployment-ready-admission',
      identityId: 'identity-ready-admission',
      observedAt: '2026-08-21T00:00:00.000Z',
      targetId: 'target-ready-admission',
    });
    upsertNanoHostRuntimeTarget(coreDb, {
      ...generation,
      freshEmpty: true,
      physicalEpoch: 'a'.repeat(64),
      predecessorFenced: true,
      ready: true,
      observedAt: '2026-08-21T00:00:01.000Z',
    });
    const store = createDemoStore();
    const turn = store.updateTurn(
      store.createTurn(
        'ws_demo',
        'th_demo',
        'Admit against ready NanoHost',
        { kind: 'user', id: 'user_local' },
        null
      ).id,
      { agentId: 'agent_codex_host' }
    );
    const runtime = createConfiguredWorkerLifecycleRuntime({
      coreDb,
      env: {},
      workerControlGateway: new WorkerControlGateway(),
    });
    try {
      await expect(
        runtime.turnExecutor.prepareAgentSessionForTurn?.(store, {
          agentSetup: createTestAgentSetup(),
          freshAgentSessionId: 'as-ready-runtime-target',
          requestId: 'req-ready-runtime-target',
          turn,
          turnInput: turn.input,
          workspaceRoots: [],
        })
      ).resolves.toEqual({
        agentSessionId: 'as-ready-runtime-target',
        currentAgentSession: null,
        replacementRequired: false,
        sessionCompatibilityKey: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      });
      expect(
        coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM scheduler_session_leases').get()
      ).toEqual({ count: 0 });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('restores every sibling AgentSession binding after a NanoCore restart', () => {
    const coreDb = createFactoryCoreDb();
    const sandboxCompatibilityKey = 'a'.repeat(64);
    try {
      coreDb.sqlite
        .prepare(
          `INSERT INTO nanohost_runtime_targets (
             target_id, identity_id, deployment_id, connection_generation,
             predecessor_fenced, ready, fresh_empty, physical_epoch, observed_at, slot_count
           ) VALUES ('target_factory_restore', 'identity_factory_restore', 'deployment_factory_restore', 1, 1, 1, 1, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', ?, 1)`
        )
        .run('2026-08-21T00:00:00.000Z');
      createNanoHostHarnessRuntime(coreDb, {
        adapterId: 'codex',
        adapterVersion: '0.153.4',
        harnessBindingRef: 'harness-binding-factory-restore',
        harnessCompatibilityKey: 'd'.repeat(64),
        harnessInstanceId: 'harness-factory-restore',
        imageDigest: `sha256:${'f'.repeat(64)}`,
        originPhysicalEpoch: 'a'.repeat(64),
        sandboxBindingRef: 'sandbox-binding-factory-restore',
        sandboxCompatibilityKey,
        sandboxIntegrationBindingRef: 'integration-sandbox-binding-factory-restore',
        sandboxRuntimeId: 'sandbox-runtime-factory-restore',
        runtimeTargetId: 'target_factory_restore',
        timestamp: '2026-08-21T00:00:00.000Z',
      });
      attachNanoHostStorageFixture(coreDb, {
        agentSessionId: 'agent-session-one',
        deploymentId: 'deployment_factory_restore',
        runtimeTargetId: 'target_factory_restore',
        sandboxBindingRef: 'sandbox-binding-factory-restore',
        threadId: 'thread-one',
        workspaceId: 'workspace-factory-restore',
      });
      for (const suffix of ['one', 'two']) {
        openNanoHostAgentSessionBinding(coreDb, {
          agentSessionCompatibilityKey: suffix === 'one' ? 'b'.repeat(64) : 'c'.repeat(64),
          agentSessionId: `agent-session-${suffix}`,
          agentSessionRuntimeBindingId: `agent-session-binding-${suffix}`,
          effectiveSetupGeneration: 1,
          harnessInstanceId: 'harness-factory-restore',
          threadId: `thread-${suffix}`,
          timestamp: '2026-08-21T00:00:00.000Z',
          workspaceId: 'workspace-factory-restore',
        });
      }
      const runtime = createConfiguredWorkerLifecycleRuntime({
        coreDb,
        env: {},
        workerControlGateway: new WorkerControlGateway(),
      });
      const backend = (
        runtime.turnExecutor as unknown as {
          readonly backend: {
            restoreSharedHarness(
              sandboxCompatibilityKey: string,
              harnessCompatibilityKey: string,
              runtimeTargetId: string,
              adapterId: 'codex',
              adapterVersion: string
            ): { readonly bindings: Map<string, unknown> } | null;
          };
        }
      ).backend;

      expect(
        [
          ...backend.restoreSharedHarness(
            sandboxCompatibilityKey,
            'd'.repeat(64),
            'target_factory_restore',
            'codex',
            '0.153.4'
          )!.bindings,
        ]
          .map(([agentSessionId]) => agentSessionId)
          .sort()
      ).toEqual(['agent-session-one', 'agent-session-two']);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('maps process-locally restored SessionCompatibilityKey to reusable continuity', async () => {
    const coreDb = createFactoryCoreDb();
    const sessionCompatibilityKey = `sha256:${'a'.repeat(64)}`;
    const runtimeCompatibilityKey = deriveNanoHostAgentSessionCompatibilityKey({
      adapterId: 'codex',
      adapterVersion: '0.153.4',
      harnessCompatibilityKey: 'd'.repeat(64),
      sessionCompatibilityKey,
      threadId: 'thread-continuity-key',
    });
    try {
      coreDb.sqlite
        .prepare(
          `INSERT INTO nanohost_runtime_targets (
             target_id, identity_id, deployment_id, connection_generation,
             predecessor_fenced, ready, fresh_empty, physical_epoch, observed_at, slot_count
           ) VALUES ('target_continuity_key', 'identity_continuity_key', 'deployment_continuity_key', 1, 1, 1, 1, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', ?, 1)`
        )
        .run('2026-08-21T00:00:00.000Z');
      createNanoHostHarnessRuntime(coreDb, {
        adapterId: 'codex',
        adapterVersion: '0.153.4',
        harnessBindingRef: 'harness-binding-continuity-key',
        harnessCompatibilityKey: 'd'.repeat(64),
        harnessInstanceId: 'harness-continuity-key',
        imageDigest: `sha256:${'b'.repeat(64)}`,
        originPhysicalEpoch: 'a'.repeat(64),
        sandboxBindingRef: 'sandbox-binding-continuity-key',
        sandboxCompatibilityKey: 'c'.repeat(64),
        sandboxIntegrationBindingRef: 'integration-sandbox-binding-continuity-key',
        sandboxRuntimeId: 'sandbox-runtime-continuity-key',
        runtimeTargetId: 'target_continuity_key',
        timestamp: '2026-08-21T00:00:00.000Z',
      });
      const storageBinding = attachNanoHostStorageFixture(coreDb, {
        agentSessionId: 'as-continuity-key',
        deploymentId: 'deployment_continuity_key',
        runtimeTargetId: 'target_continuity_key',
        sandboxBindingRef: 'sandbox-binding-continuity-key',
        threadId: 'thread-continuity-key',
        workspaceId: 'workspace-continuity-key',
      });
      openNanoHostAgentSessionBinding(coreDb, {
        agentSessionCompatibilityKey: runtimeCompatibilityKey,
        agentSessionId: 'as-continuity-key',
        agentSessionRuntimeBindingId: 'binding-continuity-key',
        effectiveSetupGeneration: 1,
        harnessInstanceId: 'harness-continuity-key',
        threadId: 'thread-continuity-key',
        timestamp: '2026-08-21T00:00:00.000Z',
        workspaceId: 'workspace-continuity-key',
      });
      queueNanoHostHarnessOperation(coreDb, {
        body: {
          adapterId: 'codex',
          agentSessionCompatibilityKey: runtimeCompatibilityKey,
          agentSessionId: 'as-continuity-key',
          agentSessionRuntimeBindingId: 'binding-continuity-key',
          effectiveSetupGeneration: 1,
          storageRef: storageBinding.storageRef,
          threadId: 'thread-continuity-key',
          workSlotRef: storageBinding.currentWorkSlotRef,
          workspaceId: 'workspace-continuity-key',
        },
        harnessInstanceId: 'harness-continuity-key',
        operation: 'session.open',
        timestamp: '2026-08-21T00:00:01.000Z',
      });
      const command = dispatchNanoHostHarnessOperation(coreDb, {
        now: () => '2026-08-21T00:00:02.000Z',
        sandboxIntegrationBindingRef: 'integration-sandbox-binding-continuity-key',
      });
      if (!command) {
        throw new Error('Expected the continuity fixture session.open command.');
      }
      settleNanoHostHarnessOperation(coreDb, {
        sandboxIntegrationBindingRef: 'integration-sandbox-binding-continuity-key',
        result: {
          body: {
            maxActiveTurns: 1,
            nativeHandleDigest: 'd'.repeat(64),
            nativeHandleState: 'ready',
            state: 'open',
          },
          disposition: 'succeeded',
          harnessInstanceId: 'harness-continuity-key',
          operationId: command.operationId,
          schemaVersion: 2,
          sequence: command.sequence,
        },
        timestamp: '2026-08-21T00:00:03.000Z',
      });
      const runtime = createConfiguredWorkerLifecycleRuntime({
        coreDb,
        env: {},
        workerControlGateway: new WorkerControlGateway(),
      });
      const backend = (
        runtime.turnExecutor as unknown as {
          readonly backend: WorkerGovernanceBackend & {
            restoreSharedHarness(
              sandboxCompatibilityKey: string,
              harnessCompatibilityKey: string,
              runtimeTargetId: string,
              adapterId: 'codex',
              adapterVersion: string
            ): unknown;
          };
        }
      ).backend;
      backend.restoreSharedHarness(
        'c'.repeat(64),
        'd'.repeat(64),
        'target_continuity_key',
        'codex',
        '0.153.4'
      );
      const input = {
        agentSessionCompatibilityKey: sessionCompatibilityKey,
        agentSessionId: 'as-continuity-key',
        reuseAllowed: true,
        threadId: 'thread-continuity-key',
        workspaceId: 'workspace-continuity-key',
      } as const;

      await expect(backend.prepareAgentSessionContinuity?.(input)).resolves.toBe('reusable');
      await expect(
        backend.prepareAgentSessionContinuity?.({
          ...input,
          agentSessionCompatibilityKey: `sha256:${'e'.repeat(64)}`,
        })
      ).resolves.toBe('replacement-required');
      upsertSchedulerWorkerPool(coreDb, {
        allowedBackendKinds: ['openshell'],
        allowedPlacements: ['local'],
        allowedWorkspaceScopes: ['local'],
        budgetClass: 'interactive',
        currentAdmittedSessionCount: 0,
        currentQueueDepth: 1,
        defaultTimeoutMs: 900_000,
        healthSummary: 'ready',
        maxConcurrentSessions: 1,
        poolId: 'pool_continuity_commit',
        queueLimit: 20,
        status: 'active',
      });
      upsertSchedulerCapacityRecord(coreDb, {
        capacityClass: 'local',
        concurrencyCeiling: 1,
        inUseCount: 0,
        observationSource: 'configured',
        observedAt: '2026-08-21T00:00:04.000Z',
        poolId: 'pool_continuity_commit',
        queueDepth: 1,
        targetId: 'target_continuity_commit',
      });
      upsertSchedulerTargetHealthRecord(coreDb, {
        checkResults: [],
        consecutiveFailureCount: 0,
        consecutiveSuccessCount: 1,
        healthState: 'healthy',
        lastProbeAt: '2026-08-21T00:00:04.000Z',
        nextProbeAt: '2026-08-21T00:01:04.000Z',
        targetId: 'target_continuity_commit',
      });
      createSchedulerAdmissionEntry(coreDb, {
        priorityClass: 'interactive',
        profileRef: 'profile_worker',
        queueEntryId: 'queue_continuity_commit',
        requestedAgentId: 'agent_codex_host',
        requiredPoolConstraints: ['openshell.local'],
        threadId: input.threadId,
        turnId: 'turn-continuity-commit',
        turnInput: 'Commit exact continuity',
        triggerActor: { kind: 'user', id: 'user-continuity-commit' },
        workspaceId: input.workspaceId,
      });
      const dispatch = dispatchNextSchedulerEntry(coreDb, {
        agentSessionId: input.agentSessionId,
        expectedControlMode: 'poll',
        expectedDataPlaneMode: 'openshell-files',
        heartbeatIntervalMs: 10_000,
        heartbeatTimeoutMs: 30_000,
        leaseDurationMs: 900_000,
        leaseId: 'lease-continuity-commit',
        planId: 'plan-continuity-commit',
        sandboxBindingRef: 'lease-binding:continuity-commit',
        schedulerEpoch: 1,
        sessionCompatibilityKey,
        startupTimeoutMs: 120_000,
      });
      expect(dispatch.status).toBe('dispatched');
      await expect(
        backend.prepareAgentSessionContinuity?.({
          ...input,
          admissionAgentSessionId: input.agentSessionId,
          admissionLeaseId: 'lease-continuity-commit',
        })
      ).resolves.toBe('reusable');
      expect(
        coreDb.sqlite
          .prepare(
            'SELECT lifecycle_state AS lifecycleState FROM agent_session_runtime_bindings WHERE agent_session_id = ?'
          )
          .get('as-continuity-key')
      ).toEqual({ lifecycleState: 'open' });
      expect(
        coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM scheduler_session_leases').get()
      ).toEqual({ count: 1 });
      const replacementGeneration = allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
        deploymentId: 'deployment_continuity_key',
        identityId: 'identity_continuity_key',
        observedAt: '2026-08-21T00:00:05.000Z',
        targetId: 'target_continuity_key',
      });
      upsertNanoHostRuntimeTarget(coreDb, {
        ...replacementGeneration,
        freshEmpty: true,
        observedAt: '2026-08-21T00:00:06.000Z',
        physicalEpoch: 'b'.repeat(64),
        predecessorFenced: true,
        ready: true,
      });
      await expect(
        backend.prepareAgentSessionContinuity?.({
          ...input,
          admissionAgentSessionId: input.agentSessionId,
          admissionLeaseId: 'lease-continuity-commit',
        })
      ).resolves.toBe('sandbox-replacement-required');
      const leasePackage = coreDb.sqlite
        .prepare(
          `SELECT package_snapshot_id AS packageSnapshotId
           FROM scheduler_session_leases WHERE lease_id = 'lease-continuity-commit'`
        )
        .get() as { readonly packageSnapshotId: string };
      coreDb.sqlite
        .prepare(
          `UPDATE scheduler_session_leases SET agent_session_id = ?
           WHERE lease_id = 'lease-continuity-commit'`
        )
        .run('as-continuity-successor');
      const retirementPackage = completeNanoHostPackage({
        scope: {
          agentSessionId: 'as-continuity-successor',
          threadId: input.threadId,
          turnId: 'turn-continuity-commit',
          workspaceId: input.workspaceId,
        },
        snapshotId: leasePackage.packageSnapshotId,
      });
      authorizeNanoHostPackage(coreDb, retirementPackage);
      await expect(
        backend.prepareAgentSessionContinuity?.({
          ...input,
          admissionAgentSessionId: retirementPackage.scope.agentSessionId,
          admissionLeaseId: 'lease-continuity-commit',
          environmentPackage: retirementPackage,
          reuseAllowed: false,
        })
      ).resolves.toBe('closed');
      expect(
        coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM sandbox_runtime_records').get()
      ).toEqual({ count: 0 });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('carries a resident predecessor handoff slot into a no-choice successor AEP and session.open', async () => {
    const coreDb = createFactoryCoreDb();
    const repositoryPath = mkdtempSync(join(tmpdir(), 'openkit-selected-work-slot-'));
    execFileSync('git', ['init'], { cwd: repositoryPath, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'openkit@example.invalid'], {
      cwd: repositoryPath,
    });
    execFileSync('git', ['config', 'user.name', 'OpenKit'], { cwd: repositoryPath });
    writeFileSync(join(repositoryPath, 'README.md'), '# Selected slot\n');
    execFileSync('git', ['add', 'README.md'], { cwd: repositoryPath });
    execFileSync('git', ['commit', '-m', 'initial'], {
      cwd: repositoryPath,
      stdio: 'ignore',
    });
    const sessionDispatch: NanoHostSessionDispatch = {
      async effect(requestOrConnection: object, carriedRequest?: NanoHostSessionEffectRequest) {
        const request = carriedRequest ?? (requestOrConnection as NanoHostSessionEffectRequest);
        if (request.kind === 'image.acquire') return { digest: `sha256:${'6'.repeat(64)}` };
        if (request.kind === 'image.inspect') return nanoHostImageInspection(request);
        if (request.kind === 'sandbox.create') return nanoHostSandboxCreated(request);
        if (request.kind === 'bridge.open') {
          return { accepted: true, integrationReady: true, state: 'open' };
        }
        throw new Error(`Unexpected NanoHost effect: ${request.kind}`);
      },
      async poll() {
        return null;
      },
      async result() {},
      async route() {
        throw new Error('Unexpected semantic route.');
      },
    };
    try {
      coreDb.sqlite
        .prepare(
          `INSERT INTO nanohost_runtime_targets (
             target_id, identity_id, deployment_id, connection_generation,
             predecessor_fenced, ready, fresh_empty, physical_epoch, observed_at, slot_count
           ) VALUES ('target_selected_slot', 'identity_selected_slot',
                     'deployment_selected_slot', 1, 1, 1, 1, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', ?, 1)`
        )
        .run('2026-09-11T00:00:00.000Z');
      const layout = {
        family: 'openkit-worker',
        gid: 1000,
        platform: { architecture: 'amd64', os: 'linux' },
        targets: [{ target: '/sandbox' }, { target: '/workspace' }],
        uid: 1000,
        version: '1',
        workingDirectory: '/tmp/openkit-bootstrap',
      };
      const created = createWorkerStorageBinding(coreDb, {
        deploymentId: 'deployment_selected_slot',
        layout,
        runtimeTargetId: 'target_selected_slot',
        workspaceId: 'workspace_selected_slot',
      });
      const predecessor = reserveWorkerStorageAttachment(coreDb, {
        agentSessionId: 'as_selected_slot_predecessor',
        authorizeContributor: () => true,
        expectedRevision: created.revision,
        layout,
        purpose: 'work',
        responsibleUserId: 'user-factory',
        runtimeTargetId: 'target_selected_slot',
        storageRef: created.storageRef,
        threadId: 'thread_selected_slot_predecessor',
        workspaceId: 'workspace_selected_slot',
      });
      const predecessorAttached = activateWorkerStorageAttachment(coreDb, {
        attachmentGeneration: predecessor.attachmentGeneration,
        expectedRevision: predecessor.revision,
        sandboxBindingRef: 'sandbox_selected_slot_predecessor',
        storageRef: predecessor.storageRef,
        targets: predecessor.targets.map((target) => ({ ...target, initialized: true })),
      });
      const idle = releaseWorkerStorageAttachment(coreDb, {
        attachmentGeneration: predecessorAttached.attachmentGeneration,
        cleanupProved: true,
        expectedRevision: predecessorAttached.revision,
        sandboxBindingRef: 'sandbox_selected_slot_predecessor',
        storageRef: predecessorAttached.storageRef,
      });
      const selectedWorkSlotRef = predecessor.currentWorkSlotRef!;
      const triggerActor = { id: 'user-factory', kind: 'user' as const };
      const environmentPackage = resolveAgentEnvironmentPackage({
        agentSessionId: 'as_selected_slot_successor',
        agentSetup: createTestAgentSetup(),
        backend: { kind: 'openshell' },
        createdAt: '2026-09-11T00:00:01.000Z',
        requestId: 'request_selected_slot_successor',
        triggerActor,
        turn: {
          completedAt: null,
          configVersion: null,
          durationMs: null,
          error: null,
          humanGate: null,
          id: 'turn_selected_slot_successor',
          items: [],
          startedAt: '2026-09-11T00:00:01.000Z',
          status: 'running',
          threadId: 'thread_selected_slot_successor',
          triggerActor,
          workspaceId: 'workspace_selected_slot',
        },
        turnInput: 'Continue predecessor work',
        workspaceCwd: null,
        workspaceDataSourceCatalog: {
          schemaVersion: 1,
          sources: [
            {
              access: 'read-write',
              allowedSlotKinds: ['worktree'],
              displayName: 'Main repository',
              id: 'main-repo',
              kind: 'git',
              locator: { defaultRef: 'main', url: 'https://example.invalid/repository.git' },
              sensitivity: 'internal',
              status: 'active',
              vaultGrantRef: null,
            },
          ],
        },
        workspaceRoots: [
          {
            access: 'read-write',
            id: 'repo',
            sourceKind: 'host-dir',
            sourcePath: repositoryPath,
            workerPath: '/workspace/legacy-root',
          },
        ],
        workspaceSourceRefs: { repo: 'main-repo' },
        workerStorageWorkSlotRef: selectedWorkSlotRef,
      });
      authorizeNanoHostPackage(coreDb, environmentPackage);
      new FsStore({ dataRoot: coreDb.dataRoot }).createThread(
        environmentPackage.scope.workspaceId,
        'Predecessor',
        'thread_selected_slot_predecessor'
      );
      coreDb.sqlite
        .prepare(
          `INSERT INTO scheduler_session_leases (
             lease_id, plan_id, workspace_id, thread_id, turn_id, agent_session_id,
             package_snapshot_id, pool_id, target_id, status, acquired_at, expires_at,
             heartbeat_deadline, startup_deadline, renewal_count, scheduler_epoch,
             sandbox_binding_ref
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'acquired', ?, ?, ?, ?, 0, 1, ?)`
        )
        .run(
          'lease_selected_slot',
          'plan_selected_slot',
          environmentPackage.scope.workspaceId,
          environmentPackage.scope.threadId,
          environmentPackage.scope.turnId,
          environmentPackage.scope.agentSessionId,
          environmentPackage.snapshotId,
          'pool_selected_slot',
          'target_selected_slot',
          '2026-09-11T00:00:01.000Z',
          '2999-01-01T00:00:00.000Z',
          '2999-01-01T00:00:00.000Z',
          '2999-01-01T00:00:00.000Z',
          'sandbox-binding:selected-slot'
        );
      const runtime = createConfiguredWorkerLifecycleRuntime({
        coreDb,
        env: {},
        nanoHostSessionDispatch: sessionDispatch,
        workerControlGateway: new WorkerControlGateway(),
      });
      const backend = (
        runtime.turnExecutor as unknown as { readonly backend: WorkerGovernanceBackend }
      ).backend;
      anchorNanoHostMaterialization(coreDb, backend, environmentPackage);
      await backend.materialize(environmentPackage, {
        workerStorageChoice: {
          expectedRevision: idle.revision,
          goalId: null,
          kind: 'selected',
          purpose: 'work',
          reuseWorkSlotRef: selectedWorkSlotRef,
          storageRef: idle.storageRef,
          taskId: null,
        },
        workspaceRoots: [],
      });
      const expectedWorktree = `/workspace/worktrees/${selectedWorkSlotRef}`;
      expect(environmentPackage.workspace.inputs[0]?.target).toBe(expectedWorktree);
      expect(environmentPackage.runtime.command.workingDirectory).toBe(expectedWorktree);
      expect(
        workerStorageDefaultWorkSlotRef(
          environmentPackage.scope.workspaceId,
          environmentPackage.scope.threadId
        )
      ).not.toBe(selectedWorkSlotRef);

      const successorTurn = {
        completedAt: null,
        configVersion: null,
        durationMs: null,
        error: null,
        humanGate: null,
        id: 'turn_selected_slot_no_choice',
        items: [],
        startedAt: '2026-09-11T00:00:02.000Z',
        status: 'running' as const,
        threadId: environmentPackage.scope.threadId,
        triggerActor,
        workspaceId: environmentPackage.scope.workspaceId,
      };
      const previewPackage = (
        runtime.turnExecutor as unknown as {
          previewAgentEnvironmentPackage(
            agentSessionId: string,
            input: Record<string, unknown>
          ): AgentEnvironmentPackage;
        }
      ).previewAgentEnvironmentPackage.bind(runtime.turnExecutor);
      const successorPreparation = {
        agentSetup: createTestAgentSetup(),
        freshAgentSessionId: 'as_selected_slot_no_choice',
        requestId: 'request_selected_slot_no_choice',
        turn: successorTurn,
        turnInput: 'Continue in the resident handoff worktree',
        workspaceCwd: null,
        workspaceDataSourceCatalog: {
          schemaVersion: 1,
          sources: [
            {
              access: 'read-write',
              allowedSlotKinds: ['worktree'],
              displayName: 'Main repository',
              id: 'main-repo',
              kind: 'git',
              locator: { defaultRef: 'main', url: 'https://example.invalid/repository.git' },
              sensitivity: 'internal',
              status: 'active',
              vaultGrantRef: null,
            },
          ],
        },
        workspaceRoots: [
          {
            access: 'read-write',
            id: 'repo',
            sourceKind: 'host-dir',
            sourcePath: repositoryPath,
            workerPath: '/workspace/legacy-root',
          },
        ],
        workspaceSourceRefs: { repo: 'main-repo' },
      };
      const successorPackage = previewPackage('as_selected_slot_no_choice', successorPreparation);
      const freshSuccessorPackage = previewPackage('as_selected_slot_fresh', {
        ...successorPreparation,
        freshAgentSessionId: 'as_selected_slot_fresh',
        requestId: 'request_selected_slot_fresh',
        turn: {
          ...successorTurn,
          id: 'turn_selected_slot_fresh',
        },
        workerStorageChoice: { goalId: null, kind: 'fresh', taskId: null },
      });
      expect(freshSuccessorPackage.workspace.inputs[0]?.target).toBe(expectedWorktree);
      expect(freshSuccessorPackage.runtime.command.workingDirectory).toBe(expectedWorktree);
      const unrelatedThreadId = 'thread_selected_slot_unrelated';
      const unrelatedPackage = previewPackage('as_selected_slot_unrelated', {
        ...successorPreparation,
        freshAgentSessionId: 'as_selected_slot_unrelated',
        requestId: 'request_selected_slot_unrelated',
        turn: {
          ...successorTurn,
          id: 'turn_selected_slot_unrelated',
          threadId: unrelatedThreadId,
        },
      });
      const unrelatedWorktree = `/workspace/worktrees/${workerStorageDefaultWorkSlotRef(
        environmentPackage.scope.workspaceId,
        unrelatedThreadId
      )}`;
      expect(unrelatedPackage.workspace.inputs[0]?.target).toBe(unrelatedWorktree);
      expect(unrelatedPackage.runtime.command.workingDirectory).toBe(unrelatedWorktree);
      coreDb.sqlite
        .prepare(
          `INSERT INTO scheduler_session_leases (
             lease_id, plan_id, workspace_id, thread_id, turn_id, agent_session_id,
             package_snapshot_id, pool_id, target_id, status, acquired_at, expires_at,
             heartbeat_deadline, startup_deadline, renewal_count, scheduler_epoch,
             sandbox_binding_ref
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'acquired', ?, ?, ?, ?, 0, 1, ?)`
        )
        .run(
          'lease_selected_slot_no_choice',
          'plan_selected_slot_no_choice',
          successorPackage.scope.workspaceId,
          successorPackage.scope.threadId,
          successorPackage.scope.turnId,
          successorPackage.scope.agentSessionId,
          successorPackage.snapshotId,
          'pool_selected_slot',
          'target_selected_slot',
          '2026-09-11T00:00:02.000Z',
          '2999-01-01T00:00:00.000Z',
          '2999-01-01T00:00:00.000Z',
          '2999-01-01T00:00:00.000Z',
          'sandbox-binding:selected-slot-no-choice'
        );
      anchorNanoHostMaterialization(coreDb, backend, successorPackage);
      const successorMaterialization = await backend.materialize(successorPackage, {
        workspaceRoots: [],
      });
      expect(successorPackage.workspace.inputs[0]?.target).toBe(expectedWorktree);
      expect(successorPackage.runtime.command.workingDirectory).toBe(expectedWorktree);

      const launch = backend.launch(successorMaterialization);
      const integration = coreDb.sqlite
        .prepare(
          `SELECT sandbox_integration_binding_ref AS integrationRef
           FROM sandbox_runtime_records LIMIT 1`
        )
        .get() as { readonly integrationRef: string };
      let command: ReturnType<typeof dispatchNanoHostHarnessOperation> = null;
      for (let attempt = 0; attempt < 20 && !command; attempt += 1) {
        command = dispatchNanoHostHarnessOperation(coreDb, {
          sandboxIntegrationBindingRef: integration.integrationRef,
        });
        if (!command) await new Promise<void>((resolve) => setImmediate(resolve));
      }
      expect(command?.operation).toBe('session.open');
      expect(command?.body).toMatchObject({
        storageRef: idle.storageRef,
        workSlotRef: selectedWorkSlotRef,
      });
      if (!command) throw new Error('Expected no-choice successor session.open command.');
      runtime.acceptNanoHostHarnessCommand(command);
      const rejection = {
        body: { reasonCode: 'unsupported' },
        disposition: 'refused' as const,
        harnessInstanceId: command.harnessInstanceId,
        operationId: command.operationId,
        schemaVersion: 2 as const,
        sequence: command.sequence,
      };
      settleNanoHostHarnessOperation(coreDb, {
        result: rejection,
        sandboxIntegrationBindingRef: integration.integrationRef,
        timestamp: '2026-09-11T00:00:02.000Z',
      });
      runtime.acceptNanoHostHarnessResult(rejection);
      await expect(launch).rejects.toThrow('unsupported');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it.each([
    ['definite delete', false],
    ['uncertain delete', true],
  ] as const)('%s updates the durable Sandbox even without a process-local session', async (_, uncertain) => {
    const coreDb = createFactoryCoreDb();
    const operations: string[] = [];
    const sessionDispatch: NanoHostSessionDispatch = {
      async effect(
        requestOrConnection: object,
        carriedRequest?: NanoHostSessionEffectRequest
      ): Promise<unknown> {
        const request = carriedRequest ?? (requestOrConnection as NanoHostSessionEffectRequest);
        operations.push(request.kind);
        if (uncertain && request.kind === 'sandbox.delete') {
          throw new Error('NanoHost sandbox delete outcome is unknown.');
        }
        return {};
      },
      async poll() {
        return null;
      },
      async result() {},
      async route() {
        throw new Error('Unexpected semantic route.');
      },
    };

    try {
      coreDb.sqlite
        .prepare(
          `INSERT INTO nanohost_runtime_targets (
             target_id, identity_id, deployment_id, connection_generation,
             predecessor_fenced, ready, fresh_empty, physical_epoch, observed_at, slot_count
           ) VALUES ('target_absent_cleanup', 'identity_absent_cleanup', 'deployment_absent_cleanup', 1, 1, 1, 1, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', ?, 1)`
        )
        .run('2026-08-21T00:00:00.000Z');
      const runtime = createConfiguredWorkerLifecycleRuntime({
        coreDb,
        env: {},
        nanoHostSessionDispatch: sessionDispatch,
        workerControlGateway: new WorkerControlGateway(),
      });
      const backend = (
        runtime.turnExecutor as unknown as {
          readonly backend: WorkerGovernanceBackend & {
            requireLeaseId(packageSnapshotId: string): string;
          };
        }
      ).backend;
      backend.requireLeaseId = () => 'lease_absent_cleanup';
      const environmentPackage = completeNanoHostPackage({
        scope: {
          agentSessionId: 'as_absent_cleanup',
          threadId: 'thread_absent_cleanup',
          turnId: 'turn_absent_cleanup',
          workspaceId: 'workspace_absent_cleanup',
        },
        snapshotId: 'aepsnap_absent_cleanup',
      });
      const identity = backend.planSession(environmentPackage);
      createNanoHostHarnessRuntime(coreDb, {
        adapterId: 'codex',
        adapterVersion: '0.153.4',
        harnessBindingRef: 'harness-binding-absent-cleanup',
        harnessCompatibilityKey: 'd'.repeat(64),
        harnessInstanceId: 'harness-absent-cleanup',
        imageDigest: `sha256:${'a'.repeat(64)}`,
        originPhysicalEpoch: 'a'.repeat(64),
        sandboxBindingRef: identity.backendSessionId,
        sandboxCompatibilityKey: `${identity.backendSessionId.slice(3, 19)}${'b'.repeat(48)}`,
        sandboxIntegrationBindingRef: 'integration-sandbox-binding-absent-cleanup',
        sandboxRuntimeId: 'sandbox-runtime-absent-cleanup',
        runtimeTargetId: 'target_absent_cleanup',
        timestamp: '2026-08-21T00:00:00.000Z',
      });
      attachNanoHostStorageFixture(coreDb, {
        agentSessionId: environmentPackage.scope.agentSessionId,
        deploymentId: 'deployment_absent_cleanup',
        runtimeTargetId: 'target_absent_cleanup',
        sandboxBindingRef: identity.backendSessionId,
        threadId: environmentPackage.scope.threadId,
        workspaceId: environmentPackage.scope.workspaceId,
      });

      const cleanup = runtime.cleanupBackendSession(identity);
      if (uncertain) {
        await expect(cleanup).rejects.toThrow(/unknown/i);
      } else {
        await expect(cleanup).resolves.toBeUndefined();
      }

      const sandbox = coreDb.sqlite
        .prepare(
          `SELECT lifecycle_state AS lifecycleState, health_state AS healthState,
                  drain_state AS drainState, cleanup_state AS cleanupState
           FROM sandbox_runtime_records WHERE sandbox_runtime_id = 'sandbox-runtime-absent-cleanup'`
        )
        .get();
      if (uncertain) {
        expect(sandbox).not.toEqual({
          cleanupState: 'clean',
          drainState: 'accepting',
          healthState: 'ready',
          lifecycleState: 'open',
        });
      } else {
        expect(sandbox).toBeUndefined();
      }
      expect(operations).toEqual(['bridge.close', 'sandbox.delete']);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('releases a no-Sandbox storage reservation only after later fresh-ready cleanup proof', async () => {
    const coreDb = createFactoryCoreDb();
    const effects: NanoHostSessionEffectRequest[] = [];
    const sessionDispatch: NanoHostSessionDispatch = {
      async effect(
        requestOrConnection: object,
        carriedRequest?: NanoHostSessionEffectRequest
      ): Promise<unknown> {
        effects.push(carriedRequest ?? (requestOrConnection as NanoHostSessionEffectRequest));
        return {};
      },
      async poll() {
        return null;
      },
      async result() {},
      async route() {
        throw new Error('Unexpected semantic route.');
      },
    };

    try {
      const failureAt = '2026-08-21T00:00:00.000Z';
      coreDb.sqlite
        .prepare(
          `INSERT INTO nanohost_runtime_targets (
             target_id, identity_id, deployment_id, connection_generation,
             predecessor_fenced, ready, fresh_empty, physical_epoch, observed_at, slot_count
           ) VALUES ('target_reserved_cleanup', 'identity_reserved_cleanup',
                     'deployment_reserved_cleanup', 1, 1, 1, 1, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', ?, 1)`
        )
        .run(failureAt);
      const runtime = createConfiguredWorkerLifecycleRuntime({
        coreDb,
        env: {},
        nanoHostSessionDispatch: sessionDispatch,
        workerControlGateway: new WorkerControlGateway(),
      });
      const backend = (
        runtime.turnExecutor as unknown as {
          readonly backend: WorkerGovernanceBackend & {
            requireLeaseId(packageSnapshotId: string): string;
          };
        }
      ).backend;
      backend.requireLeaseId = () => 'lease_reserved_cleanup';
      const environmentPackage = completeNanoHostPackage({
        scope: {
          agentSessionId: 'as_reserved_cleanup',
          threadId: 'thread_reserved_cleanup',
          turnId: 'turn_reserved_cleanup',
          workspaceId: 'workspace_reserved_cleanup',
        },
        snapshotId: 'aepsnap_reserved_cleanup',
      });
      const identity = backend.planSession(environmentPackage);
      coreDb.sqlite
        .prepare(
          `INSERT INTO worker_backend_sessions (
             lease_id, workspace_id, thread_id, turn_id, agent_session_id,
             package_snapshot_id, backend_kind, deployment_id, backend_session_id,
             runtime_target_id, origin_physical_epoch, backend_lineage_json, sandbox_binding_ref,
             staging_directory_ref, workspace_handoff_state, state, created_at, updated_at
           ) VALUES (
             'lease_reserved_cleanup', ?, ?, ?, ?, ?, 'openshell', ?, ?, ?,
             'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', ?,
             'lease-binding:reserved-cleanup', ?, 'pending', 'cleanup-failed', ?, ?
           )`
        )
        .run(
          environmentPackage.scope.workspaceId,
          environmentPackage.scope.threadId,
          environmentPackage.scope.turnId,
          identity.agentSessionId,
          identity.packageSnapshotId,
          identity.deploymentId,
          identity.backendSessionId,
          identity.runtimeTargetId,
          JSON.stringify({ imageRef: 'openkit/worker-codex:dev' }),
          identity.stagingDirectoryRef,
          failureAt,
          failureAt
        );
      const layout = {
        family: 'openkit-worker',
        gid: 1000,
        platform: { architecture: 'amd64', os: 'linux' },
        targets: [{ target: '/sandbox' }, { target: '/workspace' }],
        uid: 1000,
        version: '1',
        workingDirectory: '/tmp/openkit-bootstrap',
      };
      const created = createWorkerStorageBinding(coreDb, {
        deploymentId: identity.deploymentId,
        layout,
        runtimeTargetId: identity.runtimeTargetId,
        workspaceId: environmentPackage.scope.workspaceId,
      });
      const reserved = reserveWorkerStorageAttachment(coreDb, {
        agentSessionId: identity.agentSessionId,
        authorizeContributor: () => true,
        expectedRevision: created.revision,
        layout,
        purpose: 'work',
        responsibleUserId: 'user-factory',
        runtimeTargetId: identity.runtimeTargetId,
        storageRef: created.storageRef,
        threadId: environmentPackage.scope.threadId,
        workspaceId: environmentPackage.scope.workspaceId,
      });
      expect(reserved).toMatchObject({
        attachmentGeneration: 1,
        currentAgentSessionId: identity.agentSessionId,
        currentSandboxBindingRef: null,
        revision: 2,
        state: 'reserved',
      });
      const duplicateCreated = createWorkerStorageBinding(coreDb, {
        deploymentId: identity.deploymentId,
        layout,
        runtimeTargetId: identity.runtimeTargetId,
        workspaceId: environmentPackage.scope.workspaceId,
      });
      const duplicateReserved = reserveWorkerStorageAttachment(coreDb, {
        agentSessionId: identity.agentSessionId,
        authorizeContributor: () => true,
        expectedRevision: duplicateCreated.revision,
        layout,
        purpose: 'work',
        responsibleUserId: 'user-factory',
        runtimeTargetId: identity.runtimeTargetId,
        storageRef: duplicateCreated.storageRef,
        threadId: environmentPackage.scope.threadId,
        workspaceId: environmentPackage.scope.workspaceId,
      });

      await expect(runtime.cleanupBackendSession(identity)).rejects.toThrow(
        /no different fresh physical Epoch proof/i
      );
      expect(getWorkerStorageBinding(coreDb, { storageRef: reserved.storageRef })).toMatchObject({
        currentAgentSessionId: identity.agentSessionId,
        revision: 2,
        state: 'reserved',
      });
      expect(
        getWorkerStorageBinding(coreDb, { storageRef: duplicateReserved.storageRef })
      ).toMatchObject({ revision: 2, state: 'reserved' });
      expect(effects).toEqual([]);

      const freshAt = '2026-08-21T00:00:00.001Z';
      coreDb.sqlite
        .prepare(
          `UPDATE nanohost_runtime_targets
           SET observed_at = ?, last_fresh_ready_at = ?,
               physical_epoch = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
           WHERE target_id = ?`
        )
        .run(freshAt, freshAt, identity.runtimeTargetId);
      await expect(runtime.cleanupBackendSession(identity)).rejects.toThrow(
        /matches more than one Worker storage binding/i
      );
      expect(getWorkerStorageBinding(coreDb, { storageRef: reserved.storageRef })).toMatchObject({
        revision: 2,
        state: 'reserved',
      });
      expect(
        getWorkerStorageBinding(coreDb, { storageRef: duplicateReserved.storageRef })
      ).toMatchObject({ revision: 2, state: 'reserved' });
      releaseWorkerStorageAttachment(coreDb, {
        attachmentGeneration: duplicateReserved.attachmentGeneration,
        cleanupProved: true,
        expectedRevision: duplicateReserved.revision,
        storageRef: duplicateReserved.storageRef,
      });
      await expect(runtime.cleanupBackendSession(identity)).resolves.toBeUndefined();

      expect(getWorkerStorageBinding(coreDb, { storageRef: reserved.storageRef })).toMatchObject({
        attachmentGeneration: 1,
        currentAgentSessionId: null,
        currentSandboxBindingRef: null,
        currentThreadId: null,
        currentWorkSlotRef: null,
        revision: 3,
        state: 'idle',
      });
      expect(effects).toEqual([]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('settles one poll-first unknown fence only after strictly later fresh-ready proof', async () => {
    const coreDb = createFactoryCoreDb();
    const effects: NanoHostSessionEffectRequest[] = [];
    const resultOnlyRejectors: Array<(error: Error) => void> = [];
    let resultOnlyRegistrations = 0;
    const sessionDispatch: NanoHostSessionDispatch = {
      async effect(
        requestOrConnection: object,
        carriedRequest?: NanoHostSessionEffectRequest
      ): Promise<unknown> {
        effects.push(carriedRequest ?? (requestOrConnection as NanoHostSessionEffectRequest));
        return {};
      },
      expectResultOnly() {
        resultOnlyRegistrations += 1;
        return new Promise<never>((_, reject) => resultOnlyRejectors.push(reject));
      },
      async poll() {
        return null;
      },
      async result() {},
      async route() {
        throw new Error('Unexpected semantic route.');
      },
    };

    try {
      coreDb.sqlite
        .prepare(
          `INSERT INTO nanohost_runtime_targets (
             target_id, identity_id, deployment_id, connection_generation,
             predecessor_fenced, ready, fresh_empty, physical_epoch, observed_at, slot_count
           ) VALUES ('target_post_fence', 'identity_post_fence',
                     'deployment_post_fence', 1, 1, 1, 1, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', ?, 1)`
        )
        .run('2026-08-21T00:00:00.000Z');
      const initialRuntime = createConfiguredWorkerLifecycleRuntime({
        coreDb,
        env: {},
        nanoHostSessionDispatch: sessionDispatch,
        workerControlGateway: new WorkerControlGateway(),
      });
      const initialBackend = (
        initialRuntime.turnExecutor as unknown as {
          readonly backend: WorkerGovernanceBackend & {
            requireLeaseId(packageSnapshotId: string): string;
          };
        }
      ).backend;
      initialBackend.requireLeaseId = () => 'lease_post_fence';
      const identity = initialBackend.planSession(
        completeNanoHostPackage({
          scope: {
            agentSessionId: 'as_post_fence',
            threadId: 'thread_post_fence',
            turnId: 'turn_post_fence',
            workspaceId: 'workspace_post_fence',
          },
          snapshotId: 'aepsnap_post_fence',
        })
      );
      expect(identity.backendSessionId).toMatch(/^nh-[0-9a-f]{16}-[0-9a-f]{16}$/);
      const sandboxCompatibilityKey = `${identity.backendSessionId.slice(3, 19)}${'c'.repeat(48)}`;
      expect(identity.backendSessionId.slice(0, 19)).toBe(
        `nh-${sandboxCompatibilityKey.slice(0, 16)}`
      );
      createNanoHostHarnessRuntime(coreDb, {
        adapterId: 'codex',
        adapterVersion: '0.153.4',
        harnessBindingRef: 'harness-binding-post-fence',
        harnessCompatibilityKey: 'd'.repeat(64),
        harnessInstanceId: 'harness-post-fence',
        imageDigest: `sha256:${'1'.repeat(64)}`,
        originPhysicalEpoch: 'a'.repeat(64),
        sandboxBindingRef: 'sandbox-binding-post-fence',
        sandboxCompatibilityKey,
        sandboxIntegrationBindingRef: 'integration-sandbox-binding-post-fence',
        sandboxRuntimeId: 'sandbox-runtime-post-fence',
        runtimeTargetId: identity.runtimeTargetId,
        timestamp: '2026-08-21T00:00:00.000Z',
      });
      attachNanoHostStorageFixture(coreDb, {
        agentSessionId: identity.agentSessionId,
        deploymentId: identity.deploymentId,
        runtimeTargetId: identity.runtimeTargetId,
        sandboxBindingRef: 'sandbox-binding-post-fence',
        threadId: 'thread_post_fence',
        workspaceId: 'workspace_post_fence',
      });
      coreDb.sqlite
        .prepare(
          `INSERT INTO worker_backend_sessions (
             lease_id, workspace_id, thread_id, turn_id, agent_session_id,
             package_snapshot_id, backend_kind, deployment_id, backend_session_id,
             runtime_target_id, origin_physical_epoch, backend_lineage_json, sandbox_binding_ref,
             staging_directory_ref, workspace_handoff_state, state, created_at, updated_at
           ) VALUES (
             'lease_post_fence', 'workspace_post_fence', 'thread_post_fence',
             'turn_post_fence', ?, ?, 'openshell', ?, ?, ?, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '{}',
             'lease-binding:post-fence', ?, 'pending', 'cleanup-pending', ?, ?
           )`
        )
        .run(
          identity.agentSessionId,
          identity.packageSnapshotId,
          identity.deploymentId,
          identity.backendSessionId,
          identity.runtimeTargetId,
          identity.stagingDirectoryRef,
          '2026-08-21T00:00:00.000Z',
          '2026-08-21T00:00:00.000Z'
        );
      expect(
        coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM agent_session_runtime_bindings').get()
      ).toEqual({ count: 0 });
      expect(identity.backendSessionId).not.toBe('sandbox-binding-post-fence');
      expect('lease-binding:post-fence').not.toBe('sandbox-binding-post-fence');
      createNanoHostHarnessRuntime(coreDb, {
        adapterId: 'codex',
        adapterVersion: '0.153.4',
        harnessBindingRef: 'harness-binding-post-fence-sibling',
        harnessCompatibilityKey: 'd'.repeat(64),
        harnessInstanceId: 'harness-post-fence-sibling',
        imageDigest: `sha256:${'3'.repeat(64)}`,
        originPhysicalEpoch: 'a'.repeat(64),
        sandboxBindingRef: 'sandbox-binding-post-fence-sibling',
        sandboxCompatibilityKey: '4'.repeat(64),
        sandboxIntegrationBindingRef: 'integration-sandbox-binding-post-fence-sibling',
        sandboxRuntimeId: 'sandbox-runtime-post-fence-sibling',
        runtimeTargetId: identity.runtimeTargetId,
        timestamp: '2026-08-21T00:00:00.000Z',
      });

      initialRuntime.prepareBackendCleanup(identity);
      const initialCleanup = initialRuntime.cleanupBackendSession(identity);
      resultOnlyRejectors[0]?.(
        new Error('NanoHost accepted effect outcome is unknown; successor connection fenced.')
      );
      await expect(initialCleanup).rejects.toThrow(/unknown/i);
      const fenced = coreDb.sqlite
        .prepare(
          `SELECT s.lifecycle_state AS sandboxLifecycleState,
                  s.health_state AS healthState, s.drain_state AS sandboxDrainState,
                  s.cleanup_state AS cleanupState, s.updated_at AS updatedAt,
                  h.lifecycle_state AS harnessLifecycleState,
                  h.drain_state AS harnessDrainState
           FROM sandbox_runtime_records s
           JOIN harness_instance_records h ON h.sandbox_runtime_id = s.sandbox_runtime_id
           WHERE s.sandbox_runtime_id = 'sandbox-runtime-post-fence'`
        )
        .get() as Record<string, unknown> & { readonly updatedAt: string };
      expect(fenced).toEqual({
        cleanupState: 'unknown',
        harnessDrainState: 'draining',
        harnessLifecycleState: 'failed',
        healthState: 'unknown',
        sandboxDrainState: 'draining',
        sandboxLifecycleState: 'failed',
        updatedAt: fenced.updatedAt,
      });

      const restartedRuntime = createConfiguredWorkerLifecycleRuntime({
        coreDb,
        env: {},
        nanoHostSessionDispatch: sessionDispatch,
        workerControlGateway: new WorkerControlGateway(),
      });
      const restartedBackend = (
        restartedRuntime.turnExecutor as unknown as {
          readonly backend: WorkerGovernanceBackend & {
            requireLeaseId(packageSnapshotId: string): string;
          };
        }
      ).backend;
      restartedBackend.requireLeaseId = () => 'lease_post_fence';

      for (const mismatchedIdentity of [
        { ...identity, runtimeTargetId: 'target_post_fence_missing' },
        { ...identity, deploymentId: 'deployment_post_fence_mismatch' },
      ]) {
        expect(() => restartedRuntime.prepareBackendCleanup(mismatchedIdentity)).toThrow();
        expect(resultOnlyRegistrations).toBe(1);
        expect(effects).toEqual([]);
        expect(
          coreDb.sqlite
            .prepare(
              `SELECT COUNT(*) AS count FROM sandbox_runtime_records
               WHERE sandbox_runtime_id IN ('sandbox-runtime-post-fence',
                                             'sandbox-runtime-post-fence-sibling')`
            )
            .get()
        ).toEqual({ count: 2 });
      }

      coreDb.sqlite.pragma('foreign_keys = OFF');
      try {
        coreDb.sqlite
          .prepare('DELETE FROM nanohost_runtime_targets WHERE target_id = ?')
          .run(identity.runtimeTargetId);
        expect(() => restartedRuntime.prepareBackendCleanup(identity)).toThrow();
        expect(resultOnlyRegistrations).toBe(1);
        expect(effects).toEqual([]);
        expect(
          coreDb.sqlite
            .prepare(
              `SELECT COUNT(*) AS count FROM sandbox_runtime_records
               WHERE sandbox_runtime_id IN ('sandbox-runtime-post-fence',
                                             'sandbox-runtime-post-fence-sibling')`
            )
            .get()
        ).toEqual({ count: 2 });
      } finally {
        coreDb.sqlite
          .prepare(
            `INSERT INTO nanohost_runtime_targets (
               target_id, identity_id, deployment_id, connection_generation,
               predecessor_fenced, ready, fresh_empty, physical_epoch, observed_at, slot_count
             ) VALUES ('target_post_fence', 'identity_post_fence',
                       'deployment_post_fence', 1, 1, 1, 1, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', ?, 1)`
          )
          .run('2026-08-21T00:00:00.000Z');
        coreDb.sqlite.pragma('foreign_keys = ON');
      }

      for (const [column, invalidValue, restoredValue] of [
        ['lifecycle_state', 'open', 'failed'],
        ['health_state', 'ready', 'unknown'],
        ['drain_state', 'accepting', 'draining'],
      ] as const) {
        coreDb.sqlite
          .prepare(
            `UPDATE sandbox_runtime_records SET ${column} = ?
             WHERE sandbox_runtime_id = 'sandbox-runtime-post-fence'`
          )
          .run(invalidValue);
        expect(() => restartedRuntime.prepareBackendCleanup(identity)).toThrow(/contradictory/i);
        expect(resultOnlyRegistrations).toBe(1);
        expect(effects).toEqual([]);
        expect(
          coreDb.sqlite
            .prepare(
              `SELECT COUNT(*) AS count FROM sandbox_runtime_records
               WHERE sandbox_runtime_id IN ('sandbox-runtime-post-fence',
                                             'sandbox-runtime-post-fence-sibling')`
            )
            .get()
        ).toEqual({ count: 2 });
        coreDb.sqlite
          .prepare(
            `UPDATE sandbox_runtime_records SET ${column} = ?
             WHERE sandbox_runtime_id = 'sandbox-runtime-post-fence'`
          )
          .run(restoredValue);
      }

      for (const [observedOffsetMs, predecessorFenced, ready, freshEmpty] of [
        [-1, 1, 1, 1],
        [0, 1, 1, 1],
        [1, 0, 1, 1],
        [1, 1, 0, 1],
        [1, 1, 1, 0],
      ] as const) {
        coreDb.sqlite
          .prepare(
            `UPDATE nanohost_runtime_targets
             SET predecessor_fenced = ?, ready = ?, fresh_empty = ?, observed_at = ?
             WHERE target_id = ?`
          )
          .run(
            predecessorFenced,
            ready,
            freshEmpty,
            new Date(new Date(fenced.updatedAt).getTime() + observedOffsetMs).toISOString(),
            identity.runtimeTargetId
          );
        const rejectorIndex = resultOnlyRejectors.length;
        restartedRuntime.prepareBackendCleanup(identity);
        const rejectedCleanup = restartedRuntime.cleanupBackendSession(identity);
        resultOnlyRejectors[rejectorIndex]?.(new Error('Old result-only cleanup was rebuilt.'));
        await expect(rejectedCleanup).rejects.toThrow();
        expect.soft(resultOnlyRegistrations).toBe(1);
        expect(effects).toEqual([]);
        expect(
          coreDb.sqlite
            .prepare(
              `SELECT lifecycle_state AS lifecycleState, cleanup_state AS cleanupState
               FROM sandbox_runtime_records
               WHERE sandbox_runtime_id = 'sandbox-runtime-post-fence'`
            )
            .get()
        ).toEqual({ cleanupState: 'unknown', lifecycleState: 'failed' });
        expect(
          coreDb.sqlite
            .prepare(
              `SELECT COUNT(*) AS count FROM sandbox_runtime_records
               WHERE sandbox_runtime_id IN ('sandbox-runtime-post-fence',
                                             'sandbox-runtime-post-fence-sibling')`
            )
            .get()
        ).toEqual({ count: 2 });
      }

      coreDb.sqlite
        .prepare(
          `UPDATE nanohost_runtime_targets
           SET predecessor_fenced = 1, ready = 1, fresh_empty = 1, observed_at = ?,
               last_fresh_ready_at = ?,
               physical_epoch = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
           WHERE target_id = ?`
        )
        .run(
          new Date(new Date(fenced.updatedAt).getTime() + 1).toISOString(),
          new Date(new Date(fenced.updatedAt).getTime() + 1).toISOString(),
          identity.runtimeTargetId
        );
      const freshRejectorIndex = resultOnlyRejectors.length;
      restartedRuntime.prepareBackendCleanup(identity);
      const freshCleanup = restartedRuntime.cleanupBackendSession(identity);
      resultOnlyRejectors[freshRejectorIndex]?.(new Error('Old result-only cleanup was rebuilt.'));
      await expect(freshCleanup).resolves.toBeUndefined();

      expect(resultOnlyRegistrations).toBe(1);
      expect(effects).toEqual([]);
      expect(
        coreDb.sqlite
          .prepare(
            `SELECT h.harness_instance_id AS harnessInstanceId,
                    s.sandbox_runtime_id AS sandboxRuntimeId
             FROM harness_instance_records h
             JOIN sandbox_runtime_records s ON s.sandbox_runtime_id = h.sandbox_runtime_id
             ORDER BY h.harness_instance_id`
          )
          .all()
      ).toEqual([
        {
          harnessInstanceId: 'harness-post-fence-sibling',
          sandboxRuntimeId: 'sandbox-runtime-post-fence-sibling',
        },
      ]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('findDurableSandboxBinding keeps exact projection, uniqueness, worker binding, and AgentSession lineage', () => {
    const coreDb = createFactoryCoreDb();
    try {
      coreDb.sqlite
        .prepare(
          `INSERT INTO nanohost_runtime_targets (
             target_id, identity_id, deployment_id, connection_generation,
             predecessor_fenced, ready, fresh_empty, physical_epoch, observed_at, slot_count
           ) VALUES ('target_lookup', 'identity_lookup', 'deployment_lookup', 1, 1, 1, 1, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', ?, 1)`
        )
        .run('2026-08-21T00:00:00.000Z');
      const runtime = createConfiguredWorkerLifecycleRuntime({
        coreDb,
        env: {},
        workerControlGateway: new WorkerControlGateway(),
      });
      const backend = (
        runtime.turnExecutor as unknown as {
          readonly backend: {
            findDurableSandboxBinding(
              identity: WorkerGovernanceBackendSessionIdentity
            ): { readonly sandboxBindingRef: string } | null;
          };
        }
      ).backend;
      const projectingPrefix = 'a'.repeat(16);
      createNanoHostHarnessRuntime(coreDb, {
        adapterId: 'codex',
        adapterVersion: '0.153.4',
        harnessBindingRef: 'harness-binding-lookup-a',
        harnessCompatibilityKey: 'd'.repeat(64),
        harnessInstanceId: 'harness-lookup-a',
        imageDigest: `sha256:${'1'.repeat(64)}`,
        originPhysicalEpoch: 'a'.repeat(64),
        sandboxBindingRef: 'sandbox-binding-lookup-a',
        sandboxCompatibilityKey: `${projectingPrefix}${'c'.repeat(48)}`,
        sandboxIntegrationBindingRef: 'integration-sandbox-binding-lookup-a',
        sandboxRuntimeId: 'sandbox-runtime-lookup-a',
        runtimeTargetId: 'target_lookup',
        timestamp: '2026-08-21T00:00:00.000Z',
      });
      const nonProjectingIdentity: WorkerGovernanceBackendSessionIdentity = {
        agentSessionId: 'as_lookup_none',
        backendKind: 'openshell',
        backendSessionId: `nh-${projectingPrefix.slice(0, 15)}b-${'0'.repeat(16)}`,
        deploymentId: 'deployment_lookup',
        packageSnapshotId: 'aepsnap_lookup_none',
        runtimeTargetId: 'target_lookup',
        stagingDirectoryRef: 'server/runtime/worker-backend-sessions/aepsnap_lookup_none',
        transientProviderInstanceId: null,
      };
      expect(backend.findDurableSandboxBinding(nonProjectingIdentity)).toBeNull();

      createNanoHostHarnessRuntime(coreDb, {
        adapterId: 'codex',
        adapterVersion: '0.153.4',
        harnessBindingRef: 'harness-binding-lookup-dup',
        harnessCompatibilityKey: 'd'.repeat(64),
        harnessInstanceId: 'harness-lookup-dup',
        imageDigest: `sha256:${'2'.repeat(64)}`,
        originPhysicalEpoch: 'a'.repeat(64),
        sandboxBindingRef: 'sandbox-binding-lookup-dup',
        sandboxCompatibilityKey: `${projectingPrefix}${'d'.repeat(48)}`,
        sandboxIntegrationBindingRef: 'integration-sandbox-binding-lookup-dup',
        sandboxRuntimeId: 'sandbox-runtime-lookup-dup',
        runtimeTargetId: 'target_lookup',
        timestamp: '2026-08-21T00:00:00.000Z',
      });
      expect(() =>
        backend.findDurableSandboxBinding({
          ...nonProjectingIdentity,
          agentSessionId: 'as_lookup_ambiguous',
          backendSessionId: `nh-${projectingPrefix}-${'0'.repeat(16)}`,
          packageSnapshotId: 'aepsnap_lookup_ambiguous',
          stagingDirectoryRef: 'server/runtime/worker-backend-sessions/aepsnap_lookup_ambiguous',
        })
      ).toThrow('NanoHost cleanup lineage matches more than one durable Sandbox.');

      createNanoHostHarnessRuntime(coreDb, {
        adapterId: 'codex',
        adapterVersion: '0.153.4',
        harnessBindingRef: 'harness-binding-lookup-worker',
        harnessCompatibilityKey: 'd'.repeat(64),
        harnessInstanceId: 'harness-lookup-worker',
        imageDigest: `sha256:${'3'.repeat(64)}`,
        originPhysicalEpoch: 'a'.repeat(64),
        sandboxBindingRef: 'sandbox-binding-lookup-worker',
        sandboxCompatibilityKey: 'b'.repeat(64),
        sandboxIntegrationBindingRef: 'integration-sandbox-binding-lookup-worker',
        sandboxRuntimeId: 'sandbox-runtime-lookup-worker',
        runtimeTargetId: 'target_lookup',
        timestamp: '2026-08-21T00:00:00.000Z',
      });
      coreDb.sqlite
        .prepare(
          `INSERT INTO worker_backend_sessions (
             lease_id, workspace_id, thread_id, turn_id, agent_session_id,
             package_snapshot_id, backend_kind, deployment_id, backend_session_id,
             runtime_target_id, origin_physical_epoch, backend_lineage_json, sandbox_binding_ref,
             staging_directory_ref, workspace_handoff_state, state, created_at, updated_at
           ) VALUES (
             'lease_lookup_worker', 'workspace_lookup', 'thread_lookup_worker',
             'turn_lookup_worker', 'as_lookup_worker', 'aepsnap_lookup_worker', 'openshell',
             'deployment_lookup', 'nh-1111111111111111', 'target_lookup',
             'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '{}',
             'sandbox-binding-lookup-worker',
             'server/runtime/worker-backend-sessions/aepsnap_lookup_worker',
             'pending', 'cleanup-pending', ?, ?
           )`
        )
        .run('2026-08-21T00:00:00.000Z', '2026-08-21T00:00:00.000Z');
      const workerIdentity: WorkerGovernanceBackendSessionIdentity = {
        ...nonProjectingIdentity,
        agentSessionId: 'as_lookup_worker',
        backendSessionId: `nh-${'e'.repeat(16)}-${'0'.repeat(16)}`,
        packageSnapshotId: 'aepsnap_lookup_worker',
        stagingDirectoryRef: 'server/runtime/worker-backend-sessions/aepsnap_lookup_worker',
      };
      expect(backend.findDurableSandboxBinding(workerIdentity)?.sandboxBindingRef).toBe(
        'sandbox-binding-lookup-worker'
      );

      createNanoHostHarnessRuntime(coreDb, {
        adapterId: 'codex',
        adapterVersion: '0.153.4',
        harnessBindingRef: 'harness-binding-lookup-agent',
        harnessCompatibilityKey: 'd'.repeat(64),
        harnessInstanceId: 'harness-lookup-agent',
        imageDigest: `sha256:${'4'.repeat(64)}`,
        originPhysicalEpoch: 'a'.repeat(64),
        sandboxBindingRef: 'sandbox-binding-lookup-agent',
        sandboxCompatibilityKey: '9'.repeat(64),
        sandboxIntegrationBindingRef: 'integration-sandbox-binding-lookup-agent',
        sandboxRuntimeId: 'sandbox-runtime-lookup-agent',
        runtimeTargetId: 'target_lookup',
        timestamp: '2026-08-21T00:00:00.000Z',
      });
      openNanoHostAgentSessionBinding(coreDb, {
        agentSessionCompatibilityKey: 'e'.repeat(64),
        agentSessionId: 'as_lookup_agent',
        agentSessionRuntimeBindingId: 'binding-lookup-agent',
        effectiveSetupGeneration: 1,
        harnessInstanceId: 'harness-lookup-agent',
        threadId: 'thread_lookup_agent',
        timestamp: '2026-08-21T00:00:00.000Z',
        workspaceId: 'workspace_lookup',
      });
      const agentIdentity: WorkerGovernanceBackendSessionIdentity = {
        ...nonProjectingIdentity,
        agentSessionId: 'as_lookup_agent',
        backendSessionId: `nh-${'f'.repeat(16)}-${'0'.repeat(16)}`,
        packageSnapshotId: 'aepsnap_lookup_agent',
        stagingDirectoryRef: 'server/runtime/worker-backend-sessions/aepsnap_lookup_agent',
      };
      expect(backend.findDurableSandboxBinding(agentIdentity)?.sandboxBindingRef).toBe(
        'sandbox-binding-lookup-agent'
      );
      expect(() =>
        backend.findDurableSandboxBinding({
          ...agentIdentity,
          runtimeTargetId: 'target_lookup_missing',
        })
      ).toThrow('NanoHost cleanup lineage does not match the requested runtime owner.');
      expect(() =>
        backend.findDurableSandboxBinding({
          ...agentIdentity,
          deploymentId: 'deployment_lookup_mismatch',
        })
      ).toThrow('NanoHost cleanup lineage does not match the requested runtime owner.');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('widens a Harness-unknown operation to the owning Sandbox reuse fence', () => {
    const coreDb = createFactoryCoreDb();
    try {
      coreDb.sqlite
        .prepare(
          `INSERT INTO nanohost_runtime_targets (
             target_id, identity_id, deployment_id, connection_generation,
             predecessor_fenced, ready, fresh_empty, physical_epoch, observed_at, slot_count
           ) VALUES ('target_harness_unknown', 'identity_harness_unknown', 'deployment_harness_unknown', 1, 1, 1, 1, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', ?, 1)`
        )
        .run('2026-08-21T00:00:00.000Z');
      createNanoHostHarnessRuntime(coreDb, {
        adapterId: 'codex',
        adapterVersion: '0.153.4',
        harnessBindingRef: 'harness-binding-unknown',
        harnessCompatibilityKey: 'd'.repeat(64),
        harnessInstanceId: 'harness-unknown',
        imageDigest: `sha256:${'c'.repeat(64)}`,
        originPhysicalEpoch: 'a'.repeat(64),
        sandboxBindingRef: 'sandbox-binding-unknown',
        sandboxCompatibilityKey: 'd'.repeat(64),
        sandboxIntegrationBindingRef: 'integration-sandbox-binding-unknown',
        sandboxRuntimeId: 'sandbox-runtime-unknown',
        runtimeTargetId: 'target_harness_unknown',
        timestamp: '2026-08-21T00:00:00.000Z',
      });
      queueNanoHostHarnessOperation(coreDb, {
        body: {},
        harnessInstanceId: 'harness-unknown',
        operation: 'harness.drain',
        timestamp: '2026-08-21T00:00:01.000Z',
      });
      const command = dispatchNanoHostHarnessOperation(coreDb, {
        now: () => '2026-08-21T00:00:02.000Z',
        sandboxIntegrationBindingRef: 'integration-sandbox-binding-unknown',
      });
      if (!command) {
        throw new Error('Expected one dispatched Harness command.');
      }

      markNanoHostHarnessOperationUnknown(coreDb, {
        harnessBindingRef: 'harness-binding-unknown',
        operationId: command.operationId,
        timestamp: '2026-08-21T00:00:03.000Z',
      });

      expect(
        coreDb.sqlite
          .prepare(
            `SELECT lifecycle_state AS lifecycleState, health_state AS healthState,
                    drain_state AS drainState, cleanup_state AS cleanupState
             FROM sandbox_runtime_records WHERE sandbox_runtime_id = 'sandbox-runtime-unknown'`
          )
          .get()
      ).not.toEqual({
        cleanupState: 'clean',
        drainState: 'accepting',
        healthState: 'ready',
        lifecycleState: 'open',
      });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('keys shared Sandboxes by static isolation inputs, not Turn Context bytes', () => {
    const coreDb = createFactoryCoreDb();
    try {
      coreDb.sqlite
        .prepare(
          `INSERT INTO nanohost_runtime_targets (
             target_id, identity_id, deployment_id, connection_generation,
             predecessor_fenced, ready, fresh_empty, physical_epoch, observed_at, slot_count
           ) VALUES ('target_factory_compatibility', 'identity_factory_compatibility', 'deployment_factory_compatibility', 1, 1, 1, 1, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', ?, 1)`
        )
        .run('2026-08-21T00:00:00.000Z');
      const runtime = createConfiguredWorkerLifecycleRuntime({
        coreDb,
        env: {},
        workerControlGateway: new WorkerControlGateway(),
      });
      const backend = (
        runtime.turnExecutor as unknown as {
          readonly backend: WorkerGovernanceBackend;
        }
      ).backend;
      const packageFor = (
        turnId: string,
        overrides: {
          readonly actorId?: string;
          readonly mountLabel?: string;
          readonly sensitivity?: string;
        } = {}
      ) =>
        ({
          agent: { runtimeKind: 'codex', runtimeVersion: '0.153.4' },
          backend: {},
          capabilities: {},
          control: { adapter: { targetRuntime: 'codex' } },
          credentials: {},
          extensions: { openkit: { workerStorage: { workSlotRef: `wsl_${turnId}` } } },
          llm: {},
          policy: {
            filesystem: {
              rules: [
                {
                  access: 'read-only',
                  id: 'openkit-context-package',
                  workerPath: `/openkit/sessions/agent-session-${turnId}/context`,
                },
              ],
            },
          },
          resources: {},
          runtime: { image: { kind: 'reference', ref: 'openkit/worker:test' } },
          schemaVersion: 4,
          scope: {
            agentSessionId: `agent-session-${turnId}`,
            threadId: `thread-${turnId}`,
            triggerActor: { kind: 'user', id: overrides.actorId ?? 'user-compatible' },
            turnId,
            workspaceId: 'workspace-compatible',
          },
          snapshotId: `snapshot-${turnId}`,
          supply: { services: [] },
          vault: {},
          workspace: {
            generatedFiles: [
              {
                access: 'read-only',
                contentRef: `agent-environment-package://snapshot-${turnId}`,
                id: 'agent-environment-package',
                target: `/openkit/sessions/agent-session-${turnId}/config/package.json`,
              },
            ],
            inputs: [
              {
                access: 'read-only',
                id: `context_${turnId}`,
                kind: 'generated',
                materialization: {
                  contentDigest: `sha256:${turnId.repeat(64).slice(0, 64)}`,
                  slotId: 'context',
                  strategy: 'filesystem',
                },
                source: {
                  kind: 'generated',
                  pathRef: `threads/thread-${turnId}/turns/${turnId}/context-package`,
                },
                target: `/openkit/sessions/agent-session-${turnId}/context`,
              },
              {
                access: 'read-only',
                id: 'workspace-source',
                kind: 'directory',
                mount: { label: overrides.mountLabel ?? 'primary' },
                source: {
                  kind: 'workspace-dir',
                  pathRef: 'workspace-root://source',
                  sensitivity: overrides.sensitivity ?? 'internal',
                },
                target: '/workspace/inputs/source',
              },
            ],
            outputs: [],
            root: '/workspace',
          },
        }) as AgentEnvironmentPackage;
      const planFor = (environmentPackage: AgentEnvironmentPackage) =>
        backend.planSession(environmentPackage).backendSessionId;
      const keyFor = (environmentPackage: AgentEnvironmentPackage) =>
        planFor(environmentPackage).slice(0, 19);
      const baselinePackage = packageFor('a');
      const baseline = keyFor(baselinePackage);

      expect(keyFor(packageFor('b'))).toBe(baseline);
      expect(planFor(packageFor('b'))).not.toBe(planFor(baselinePackage));
      expect(keyFor(packageFor('c', { actorId: 'user-other' }))).not.toBe(baseline);
      expect(keyFor(packageFor('d', { mountLabel: 'secondary' }))).not.toBe(baseline);
      expect(keyFor(packageFor('e', { sensitivity: 'restricted' }))).not.toBe(baseline);
      expect(
        keyFor({ ...baselinePackage, resources: { cpu: { limitMillicores: 1000 } } })
      ).not.toBe(baseline);
      expect(
        keyFor({
          ...baselinePackage,
          runtime: { ...baselinePackage.runtime, process: { user: 'worker' } },
        })
      ).not.toBe(baseline);

      expect(openShellFilesystemGrantsFromPackagePolicy(baselinePackage)).toEqual([
        { access: 'read-only', path: '/openkit/sessions' },
      ]);
      for (const change of [
        (value: AgentEnvironmentPackage) => {
          value.policy.filesystem!.rules[0] = {
            access: 'read-only',
            id: 'other-rule',
            workerPath: value.workspace.inputs[0]!.target,
          };
        },
        (value: AgentEnvironmentPackage) => {
          value.workspace.generatedFiles[0]!.target = value.workspace.inputs[0]!.target;
        },
        (value: AgentEnvironmentPackage) => {
          value.workspace.inputs[0]!.source.pathRef = `other/${value.scope.turnId}`;
        },
      ]) {
        const first = packageFor('a');
        const second = packageFor('b');
        change(first);
        change(second);
        expect(keyFor(first)).not.toBe(keyFor(second));
      }
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('does not fall back to the bounded-turn worker command owner for NanoHost', async () => {
    const coreDb = createFactoryCoreDb();
    try {
      const workerControlGateway = new WorkerControlGateway({
        now: () => '2026-08-12T00:00:00.000Z',
      });
      const runtime = createConfiguredWorkerLifecycleRuntime({
        coreDb,
        env: {},
        workerControlGateway,
      });
      const store = createDemoStore();
      const turn = store.createTurn(
        'ws_demo',
        'th_demo',
        'Interrupt the configured worker',
        { kind: 'user', id: 'user_local' },
        null,
        { turnId: 'turn_factory_interrupt' }
      );
      const agentSessionId = 'as_factory_interrupt';
      const packageSnapshotId = 'aepsnap_factory_interrupt';
      store.createAgentSession({
        agentId: 'agent_codex_host',
        createdAt: turn.startedAt ?? '2026-08-12T00:00:00.000Z',
        environmentPackageSnapshotId: packageSnapshotId,
        id: agentSessionId,
        message: null,
        status: 'busy',
        threadId: turn.threadId,
        updatedAt: turn.startedAt ?? '2026-08-12T00:00:00.000Z',
        workspaceId: turn.workspaceId,
      });
      store.updateTurn(turn.id, { agentSessionId });
      const priorPackageSnapshotId = `${packageSnapshotId}_prior`;
      workerControlGateway.registerSession({
        scope: {
          agentSessionId,
          requestId: null,
          threadId: turn.threadId,
          turnId: turn.id,
          workspaceId: turn.workspaceId,
        },
        snapshotId: priorPackageSnapshotId,
      } as AgentEnvironmentPackage);
      workerControlGateway.registerSession({
        scope: {
          agentSessionId,
          requestId: null,
          threadId: turn.threadId,
          turnId: turn.id,
          workspaceId: turn.workspaceId,
        },
        snapshotId: packageSnapshotId,
      } as AgentEnvironmentPackage);

      await expect(
        runtime.turnExecutor.interruptTurn(store, turn.id, {
          requestId: 'req_factory_interrupt',
        })
      ).rejects.toThrow('materialized session');

      expect(workerControlGateway.getSessionSnapshot(priorPackageSnapshotId)?.commands).toEqual([]);
      expect(workerControlGateway.getSessionSnapshot(packageSnapshotId)?.commands).toEqual([]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it.each([
    'human-gate',
    'interrupt',
  ] as const)('settles %s before terminal Harness inspection', async (purpose) => {
    const coreDb = createFactoryCoreDb();
    const effects: NanoHostSessionEffectRequest[] = [];
    const sessionDispatch: NanoHostSessionDispatch = {
      async effect(requestOrConnection: object, carriedRequest?: NanoHostSessionEffectRequest) {
        const request = carriedRequest ?? (requestOrConnection as NanoHostSessionEffectRequest);
        effects.push(request);
        if (request.kind === 'image.acquire') return { digest: `sha256:${'a'.repeat(64)}` };
        if (request.kind === 'image.inspect') return nanoHostImageInspection(request);
        if (request.kind === 'sandbox.create') {
          return nanoHostSandboxCreated(request);
        }
        if (request.kind === 'reference.import') return { state: 'imported' };
        if (request.kind === 'bridge.open') {
          return { accepted: true, integrationReady: true, state: 'open' };
        }
        if (request.kind === 'bridge.close' || request.kind === 'sandbox.delete') {
          return { state: 'deleted' };
        }
        throw new Error(`Unexpected NanoHost effect: ${request.kind}`);
      },
      async poll() {
        return null;
      },
      async result() {},
      async route() {
        throw new Error('Unexpected semantic route.');
      },
    };
    try {
      coreDb.sqlite
        .prepare(
          `INSERT INTO nanohost_runtime_targets (
             target_id, identity_id, deployment_id, connection_generation,
             predecessor_fenced, ready, fresh_empty, physical_epoch, observed_at, slot_count
           ) VALUES ('target_human_gate', 'identity_human_gate', 'deployment_human_gate',
                     1, 1, 1, 1, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', ?, 1)`
        )
        .run('2026-09-03T00:00:00.000Z');
      const environmentPackage = completeNanoHostPackage({
        scope: {
          agentSessionId: 'as_human_gate',
          threadId: 'thread_human_gate',
          turnId: 'turn_human_gate',
          workspaceId: 'workspace_human_gate',
        },
        snapshotId: 'aepsnap_human_gate',
      });
      authorizeNanoHostPackage(coreDb, environmentPackage);
      coreDb.sqlite
        .prepare(
          `INSERT INTO scheduler_session_leases (
             lease_id, plan_id, workspace_id, thread_id, turn_id, agent_session_id,
             package_snapshot_id, pool_id, target_id, status, acquired_at, expires_at,
             heartbeat_deadline, startup_deadline, renewal_count, scheduler_epoch,
             sandbox_binding_ref
           ) VALUES (
             'lease_human_gate', 'plan_human_gate', 'workspace_human_gate',
             'thread_human_gate', 'turn_human_gate', 'as_human_gate', 'aepsnap_human_gate',
             'pool_human_gate', 'target_human_gate', 'acquired', ?, ?, ?, ?, 0, 1,
             'sandbox-binding:human-gate'
           )`
        )
        .run(
          '2026-09-03T00:00:00.000Z',
          '2999-01-01T00:00:00.000Z',
          '2999-01-01T00:00:00.000Z',
          '2999-01-01T00:00:00.000Z'
        );
      const runtime = createConfiguredWorkerLifecycleRuntime({
        coreDb,
        env: {},
        nanoHostSessionDispatch: sessionDispatch,
        workerControlGateway: new WorkerControlGateway(),
      });
      const backend = (
        runtime.turnExecutor as unknown as {
          readonly backend: WorkerGovernanceBackend & {
            interruptTurn(snapshotId: string): Promise<void>;
            inspectTerminalHarnessSession(session: unknown): Promise<void>;
            readonly sessions: Map<string, unknown>;
          };
        }
      ).backend;
      anchorNanoHostMaterialization(coreDb, backend, environmentPackage);
      const materialization = await backend.materialize(environmentPackage, {
        workspaceRoots: [],
      });
      expect(effects.some((effect) => effect.kind === 'reference.import')).toBe(false);
      const integration = coreDb.sqlite
        .prepare(
          `SELECT sandbox_integration_binding_ref AS integrationRef
           FROM sandbox_runtime_records
           LIMIT 1`
        )
        .get() as { integrationRef: string };
      const settleNext = async (
        operation:
          | 'session.open'
          | 'turn.start'
          | 'turn.interrupt'
          | 'session.inspect'
          | 'session.close',
        body: Readonly<Record<string, unknown>>
      ) => {
        let command: ReturnType<typeof dispatchNanoHostHarnessOperation> = null;
        for (let attempt = 0; attempt < 20 && !command; attempt += 1) {
          command = dispatchNanoHostHarnessOperation(coreDb, {
            sandboxIntegrationBindingRef: integration.integrationRef,
          });
          if (!command) await new Promise<void>((resolve) => setImmediate(resolve));
        }
        if (!command || command.operation !== operation) {
          throw new Error(`Expected queued ${operation} Harness command.`);
        }
        if (operation === 'session.open') {
          expect(effects.some((effect) => effect.kind === 'reference.import')).toBe(false);
        }
        if (operation === 'turn.start') {
          expect(
            effects
              .filter((effect) => effect.kind === 'reference.import')
              .map((effect) => effect.input.slot)
          ).toEqual(['package-config']);
          expect(command.body).toMatchObject({
            aepRef: '/openkit/sessions/as_human_gate/config/package.json',
            contextRef: '/openkit/sessions/as_human_gate/context',
          });
        }
        runtime.acceptNanoHostHarnessCommand(command);
        const result = {
          body,
          disposition: 'succeeded' as const,
          harnessInstanceId: command.harnessInstanceId,
          operationId: command.operationId,
          schemaVersion: 2 as const,
          sequence: command.sequence,
        };
        settleNanoHostHarnessOperation(coreDb, {
          result,
          sandboxIntegrationBindingRef: integration.integrationRef,
          timestamp: new Date().toISOString(),
        });
        runtime.acceptNanoHostHarnessResult(result);
        return command;
      };

      const launch = backend.launch(materialization);
      await settleNext('session.open', {
        maxActiveTurns: 1,
        nativeHandleDigest: null,
        nativeHandleState: 'pending',
        state: 'open',
      });
      await settleNext('turn.start', {
        nativeHandleDigest: null,
        nativeHandleState: 'pending',
        state: 'started',
      });
      await launch;

      const stop =
        purpose === 'interrupt'
          ? backend.interruptTurn(environmentPackage.snapshotId)
          : Promise.resolve(runtime.requestHumanGateStop(environmentPackage.snapshotId));
      recordWorkerControlAcceptedRecord(coreDb, {
        acceptedAt: '2026-09-06T00:00:01.000Z',
        lineage: {
          ...environmentPackage.scope,
          packageSnapshotId: environmentPackage.snapshotId,
        },
        operation: 'final_status',
        record: { sequence: 1, status: 'interrupted', stopReason: 'aborted' },
        recordKey: '1',
        sequence: 1,
      });
      let inspectionState = 'pending';
      const inspection = backend
        .inspectTerminalHarnessSession(backend.sessions.get(environmentPackage.snapshotId))
        .then(
          () => {
            inspectionState = 'resolved';
          },
          (error) => {
            inspectionState = 'rejected';
            throw error;
          }
        );
      void inspection.catch(() => undefined);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(inspectionState).toBe('pending');
      const interrupt = await settleNext('turn.interrupt', {
        childState: 'absent',
        state: 'interrupted',
      });
      expect(interrupt.body).toMatchObject({
        agentSessionId: 'as_human_gate',
        leaseId: 'lease_human_gate',
        purpose,
        turnId: 'turn_human_gate',
      });
      await stop;
      const inspected = await settleNext('session.inspect', {
        childState: 'absent',
        cleanupState: 'clean',
        nativeHandleDigest: null,
        nativeHandleState: 'pending',
        state: 'open',
      });
      expect(inspected.sequence).toBe(interrupt.sequence + 1);
      await inspection;
      expect(inspectionState).toBe('resolved');
      const cleanup = runtime.cleanupBackendSession(backend.planSession(environmentPackage));
      await settleNext('session.close', {
        childState: 'absent',
        privateState: 'absent',
        state: 'closed',
      });
      await cleanup;
      expect(effects.map((effect) => effect.kind)).toEqual([
        'image.acquire',
        'image.inspect',
        'sandbox.create',
        'bridge.open',
        'reference.import',
      ]);
      expect(
        coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM sandbox_runtime_records').get()
      ).toEqual({ count: 1 });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('selects durable interrupt and terminal close for a bounded-turn NanoHost binding', async () => {
    const coreDb = createFactoryCoreDb();
    try {
      const workerControlGateway = new WorkerControlGateway();
      const runtime = createConfiguredWorkerLifecycleRuntime({
        coreDb,
        env: {},
        workerControlGateway,
      });
      const backend = (
        runtime.turnExecutor as unknown as {
          readonly backend: {
            inspectTerminalHarnessSession(session: unknown): Promise<void>;
            interruptTurn(packageSnapshotId: string): Promise<void>;
            queueAndWaitForHarnessOperation(
              session: unknown,
              operation: string,
              body: Readonly<Record<string, unknown>>
            ): Promise<Readonly<Record<string, unknown>>>;
            readonly sessions: Map<string, unknown>;
          };
        }
      ).backend;
      const environmentPackage = {
        scope: {
          agentSessionId: 'as_factory_opencode',
          requestId: null,
          threadId: 'thread_factory_opencode',
          turnId: 'turn_factory_opencode',
          workspaceId: 'workspace_factory_opencode',
        },
        snapshotId: 'aepsnap_factory_opencode',
      } as AgentEnvironmentPackage;
      const bindings = new Map([
        [
          environmentPackage.scope.agentSessionId,
          {
            agentSessionCompatibilityKey: 'compatibility',
            agentSessionRuntimeBindingId: 'binding_factory_opencode',
            nativeHandleDigest: null,
            nextTurnSequence: 1,
          },
        ],
      ]);
      const session = {
        agentSessionRuntimeBindingId: 'binding_factory_opencode',
        environmentPackage,
        leaseId: 'lease_factory_opencode',
        nativeSessionReusable: false,
        sharedHarness: { adapterId: 'opencode', bindings },
        terminalInspectionComplete: false,
      };
      workerControlGateway.registerSession(environmentPackage);
      backend.sessions.set(environmentPackage.snapshotId, session);

      await backend.interruptTurn(environmentPackage.snapshotId);
      expect(
        workerControlGateway.getSessionSnapshot(environmentPackage.snapshotId)?.commands
      ).toMatchObject([{ kind: 'interrupt' }]);

      const operations: string[] = [];
      backend.queueAndWaitForHarnessOperation = async (_session, operation) => {
        operations.push(operation);
        return { childState: 'absent', privateState: 'absent', state: 'closed' };
      };
      await backend.inspectTerminalHarnessSession(session);
      expect(operations).toEqual(['session.close']);
      expect(bindings.size).toBe(0);
      expect(session).toMatchObject({
        nativeSessionReusable: false,
        terminalInspectionComplete: true,
      });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('deletes a created sandbox directly when context preparation fails before bridge admission', async () => {
    const packageSnapshotId = 'aepsnap_factory_pre_bridge_failure';
    const operations: string[] = [];
    const sessionDispatch: NanoHostSessionDispatch = {
      async effect(
        requestOrConnection: object,
        carriedRequest?: NanoHostSessionEffectRequest
      ): Promise<unknown> {
        const request = carriedRequest ?? (requestOrConnection as NanoHostSessionEffectRequest);
        operations.push(request.kind);
        if (request.kind === 'image.acquire') {
          return { digest: `sha256:${'a'.repeat(64)}` };
        }
        if (request.kind === 'image.inspect') return nanoHostImageInspection(request);
        if (request.kind === 'sandbox.create') {
          return nanoHostSandboxCreated(request);
        }
        if (request.kind === 'sandbox.delete') {
          throw new Error('NanoHost sandbox delete outcome is cleanup-required.');
        }
        if (request.kind === 'bridge.close') {
          throw new Error('NanoHost bridge identity mismatch.');
        }
        throw new Error(`Unexpected NanoHost effect ${request.kind}.`);
      },
      async poll() {
        return null;
      },
      async result() {},
      async route() {
        throw new Error('Unexpected semantic route.');
      },
    };
    factoryCoreDb.sqlite
      .prepare(
        `INSERT INTO nanohost_runtime_targets (
           target_id, identity_id, deployment_id, connection_generation,
           predecessor_fenced, ready, fresh_empty, physical_epoch, observed_at, slot_count
         ) VALUES (?, ?, ?, 1, 1, 1, 1, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', ?, 1)`
      )
      .run(
        'target_factory_pre_bridge_failure',
        'identity_factory_pre_bridge_failure',
        'deployment_factory_pre_bridge_failure',
        '2026-08-10T00:00:00.000Z'
      );
    const runtime = createConfiguredWorkerLifecycleRuntime({
      coreDb: factoryCoreDb,
      env: {},
      nanoHostSessionDispatch: sessionDispatch,
      workerControlGateway: new WorkerControlGateway(),
    });
    const backend = (
      runtime.turnExecutor as unknown as {
        readonly backend: WorkerGovernanceBackend & {
          requireLeaseId(packageSnapshotId: string): string;
        };
      }
    ).backend;
    backend.requireLeaseId = () => 'lease_factory_pre_bridge_failure';
    const environmentPackage = completeNanoHostPackage({
      policy: {
        filesystem: { default: 'deny', rules: [] },
        network: { default: 'deny', enforcement: 'openshell', rules: [] },
        process: { default: 'deny', rules: [] },
        snapshotId: 'policy_factory_pre_bridge_failure',
      },
      runtime: { image: { kind: 'reference', ref: 'openkit/worker:test' } },
      scope: {
        agentSessionId: 'as_factory_pre_bridge_failure',
        threadId: 'thread_factory_pre_bridge_failure',
        turnId: 'turn_factory_pre_bridge_failure',
        workspaceId: 'ws_factory_pre_bridge_failure',
      },
      snapshotId: packageSnapshotId,
      workspace: {
        inputs: [
          {
            access: 'read-only',
            id: 'context_turn_factory_pre_bridge_failure',
            kind: 'generated',
            source: {
              kind: 'generated',
              pathRef:
                'threads/thread_factory_pre_bridge_failure/turns/turn_factory_pre_bridge_failure/context-package',
            },
            target: '/openkit/context',
          },
        ],
      },
    });
    authorizeNanoHostPackage(factoryCoreDb, environmentPackage);
    const identity = backend.planSession(environmentPackage);

    anchorNanoHostMaterialization(factoryCoreDb, backend, environmentPackage);
    await expect(backend.materialize(environmentPackage, { workspaceRoots: [] })).rejects.toThrow(
      'NanoHost Context Package lineage or private root is invalid.'
    );
    await expect(runtime.cleanupBackendSession(identity)).rejects.toThrow('cleanup-required');
    expect(operations).toEqual([
      'image.acquire',
      'image.inspect',
      'sandbox.create',
      'sandbox.delete',
    ]);
    expect(operations).not.toContain('bridge.open');
    expect(operations).not.toContain('bridge.close');
  });

  it('rolls back fresh storage creation when contributor reservation fails', async () => {
    const packageSnapshotId = 'aepsnap_factory_reservation_failure';
    const operations: string[] = [];
    const sessionDispatch: NanoHostSessionDispatch = {
      async effect(
        requestOrConnection: object,
        carriedRequest?: NanoHostSessionEffectRequest
      ): Promise<unknown> {
        const request = carriedRequest ?? (requestOrConnection as NanoHostSessionEffectRequest);
        operations.push(request.kind);
        if (request.kind === 'image.acquire') {
          return { digest: `sha256:${'a'.repeat(64)}` };
        }
        if (request.kind === 'image.inspect') return nanoHostImageInspection(request);
        throw new Error(`Unexpected NanoHost effect ${request.kind}.`);
      },
      async poll() {
        return null;
      },
      async result() {},
      async route() {
        throw new Error('Unexpected semantic route.');
      },
    };
    factoryCoreDb.sqlite
      .prepare(
        `INSERT INTO nanohost_runtime_targets (
           target_id, identity_id, deployment_id, connection_generation,
           predecessor_fenced, ready, fresh_empty, physical_epoch, observed_at, slot_count
         ) VALUES (?, ?, ?, 1, 1, 1, 1, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', ?, 1)`
      )
      .run(
        'target_factory_reservation_failure',
        'identity_factory_reservation_failure',
        'deployment_factory_reservation_failure',
        '2026-08-10T00:00:00.000Z'
      );
    const runtime = createConfiguredWorkerLifecycleRuntime({
      coreDb: factoryCoreDb,
      env: {},
      nanoHostSessionDispatch: sessionDispatch,
      workerControlGateway: new WorkerControlGateway(),
    });
    const backend = (
      runtime.turnExecutor as unknown as {
        readonly backend: WorkerGovernanceBackend & {
          requireLeaseId(packageSnapshotId: string): string;
        };
      }
    ).backend;
    backend.requireLeaseId = () => 'lease_factory_reservation_failure';
    const environmentPackage = completeNanoHostPackage({
      policy: {
        filesystem: { default: 'deny', rules: [] },
        network: { default: 'deny', enforcement: 'openshell', rules: [] },
        process: { default: 'deny', rules: [] },
        snapshotId: 'policy_factory_reservation_failure',
      },
      runtime: { image: { kind: 'reference', ref: 'openkit/worker:test' } },
      scope: {
        agentSessionId: 'as_factory_reservation_failure',
        threadId: 'thread_factory_reservation_failure',
        turnId: 'turn_factory_reservation_failure',
        workspaceId: 'ws_factory_reservation_failure',
      },
      snapshotId: packageSnapshotId,
    });
    authorizeNanoHostPackage(factoryCoreDb, environmentPackage);
    factoryCoreDb.sqlite.exec(`CREATE TEMP TRIGGER reject_test_storage_contributor
      BEFORE INSERT ON worker_storage_contributors BEGIN
        SELECT RAISE(ABORT, 'test reservation write failure');
      END`);

    try {
      anchorNanoHostMaterialization(factoryCoreDb, backend, environmentPackage);
      await expect(backend.materialize(environmentPackage, { workspaceRoots: [] })).rejects.toThrow(
        'test reservation write failure'
      );
      expect(
        factoryCoreDb.sqlite
          .prepare('SELECT COUNT(*) AS count FROM worker_storage_bindings WHERE workspace_id = ?')
          .get(environmentPackage.scope.workspaceId)
      ).toEqual({ count: 0 });
      expect(operations).toEqual(['image.acquire', 'image.inspect']);
    } finally {
      factoryCoreDb.sqlite.exec('DROP TRIGGER reject_test_storage_contributor');
    }
  });

  it('acquires an exact local digest before inspection and stops when acquisition fails', async () => {
    const coreDb = createFactoryCoreDb();
    const packageSnapshotId = 'aepsnap_factory_newest_lease';
    const effects: NanoHostSessionEffectRequest[] = [];
    let acquisitionResult: 'failure' | 'mismatch' | 'match' = 'failure';
    const sessionDispatch: NanoHostSessionDispatch = {
      async effect(
        requestOrConnection: object,
        carriedRequest?: NanoHostSessionEffectRequest
      ): Promise<unknown> {
        const request = carriedRequest ?? (requestOrConnection as NanoHostSessionEffectRequest);
        effects.push(request);
        if (request.kind === 'image.acquire') {
          if (acquisitionResult === 'failure') throw new Error('exact local image is unavailable');
          return {
            digest:
              acquisitionResult === 'mismatch'
                ? `sha256:${'e'.repeat(64)}`
                : request.input.imageReference,
          };
        }
        if (request.kind === 'image.inspect') return nanoHostImageInspection(request);
        throw new Error('Sandbox creation reached');
      },
      async poll() {
        return null;
      },
      async result() {},
      async route() {
        throw new Error('Unexpected semantic route.');
      },
    };

    try {
      coreDb.sqlite
        .prepare(
          `INSERT INTO nanohost_runtime_targets (
             target_id, identity_id, deployment_id, connection_generation,
             predecessor_fenced, ready, fresh_empty, physical_epoch, observed_at, slot_count
           ) VALUES (?, ?, ?, 1, 1, 1, 1, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', ?, 1)`
        )
        .run(
          'target_factory_newest_lease',
          'identity_factory_newest_lease',
          'deployment_factory_newest_lease',
          '2026-08-10T00:00:00.000Z'
        );
      const insertLease = coreDb.sqlite.prepare(
        `INSERT INTO scheduler_session_leases (
           lease_id, plan_id, workspace_id, thread_id, turn_id, agent_session_id,
           package_snapshot_id, pool_id, target_id, status, acquired_at, expires_at,
           heartbeat_deadline, startup_deadline, renewal_count, scheduler_epoch,
           sandbox_binding_ref
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'acquired', ?, ?, ?, ?, 0, 1, ?)`
      );
      for (const [leaseId, acquiredAt] of [
        ['lease_z_older', '2026-08-10T00:00:00.000Z'],
        ['lease_a_current', '2026-08-10T00:00:01.000Z'],
        ['lease_b_current', '2026-08-10T00:00:01.000Z'],
      ] as const) {
        insertLease.run(
          leaseId,
          `plan_${leaseId}`,
          'ws_factory_newest_lease',
          'thread_factory_newest_lease',
          'turn_factory_newest_lease',
          'as_factory_newest_lease',
          packageSnapshotId,
          'pool_factory_newest_lease',
          'target_factory_newest_lease',
          acquiredAt,
          '2026-08-10T00:15:00.000Z',
          '2026-08-10T00:00:30.000Z',
          '2026-08-10T00:02:00.000Z',
          `binding:${leaseId}`
        );
      }

      const runtime = createConfiguredWorkerLifecycleRuntime({
        coreDb,
        env: {},
        nanoHostSessionDispatch: sessionDispatch,
        workerControlGateway: new WorkerControlGateway(),
      });
      const backend = (
        runtime.turnExecutor as unknown as {
          readonly backend: WorkerGovernanceBackend;
        }
      ).backend;
      const localDigest = `sha256:${'d'.repeat(64)}`;
      const environmentPackage = completeNanoHostPackage({
        runtime: {
          image: { kind: 'reference', pullPolicy: 'never', ref: localDigest },
        },
        scope: {
          agentSessionId: 'as_factory_newest_lease',
          threadId: 'thread_factory_newest_lease',
          turnId: 'turn_factory_newest_lease',
          workspaceId: 'ws_factory_newest_lease',
        },
        snapshotId: packageSnapshotId,
      });
      authorizeNanoHostPackage(coreDb, environmentPackage);

      anchorNanoHostMaterialization(coreDb, backend, environmentPackage);
      await expect(backend.materialize(environmentPackage, { workspaceRoots: [] })).rejects.toThrow(
        'exact local image is unavailable'
      );
      expect(effects).toEqual([
        expect.objectContaining({
          input: expect.objectContaining({ imageReference: localDigest }),
          kind: 'image.acquire',
        }),
      ]);
      expect(
        coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM worker_storage_bindings').get()
      ).toEqual({ count: 0 });
      expect(
        coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM sandbox_runtime_records').get()
      ).toEqual({ count: 0 });

      effects.length = 0;
      acquisitionResult = 'mismatch';
      await expect(backend.materialize(environmentPackage, { workspaceRoots: [] })).rejects.toThrow(
        'local image acquisition returned a different digest'
      );
      expect(effects.map((effect) => effect.kind)).toEqual(['image.acquire']);
      expect(
        coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM worker_storage_bindings').get()
      ).toEqual({ count: 0 });
      expect(
        coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM sandbox_runtime_records').get()
      ).toEqual({ count: 0 });

      effects.length = 0;
      acquisitionResult = 'match';
      await expect(backend.materialize(environmentPackage, { workspaceRoots: [] })).rejects.toThrow(
        'Sandbox creation reached'
      );
      expect(effects).toHaveLength(3);
      expect(effects[0]).toMatchObject({
        input: { imageReference: localDigest, leaseId: 'lease_b_current' },
        kind: 'image.acquire',
      });
      expect(effects[1]).toMatchObject({
        input: { imageDigest: localDigest },
        kind: 'image.inspect',
      });
      expect(effects[1]?.input).not.toHaveProperty('leaseId');
      expect(effects[2]).toMatchObject({
        input: { imageDigest: localDigest, leaseId: 'lease_b_current' },
        kind: 'sandbox.create',
      });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('materializes two adapter-keyed Harnesses without creating a second compatible Sandbox', async () => {
    const coreDb = createFactoryCoreDb();
    const effects: NanoHostSessionEffectRequest[] = [];
    const sessionDispatch = {
      async effect(request: NanoHostSessionEffectRequest) {
        effects.push(request);
        if (request.kind === 'image.acquire') {
          return { digest: `sha256:${'f'.repeat(64)}` };
        }
        if (request.kind === 'image.inspect') return nanoHostImageInspection(request);
        if (request.kind === 'reference.import') {
          return { state: 'imported' };
        }
        if (request.kind !== 'sandbox.create') {
          throw new Error(`Unexpected NanoHost effect: ${request.kind}`);
        }
        return nanoHostSandboxCreated(request);
      },
      async poll() {
        return null;
      },
      async result() {},
      async route() {
        throw new Error('Unexpected semantic route.');
      },
    } satisfies NanoHostSessionDispatch;
    try {
      coreDb.sqlite
        .prepare(
          `INSERT INTO nanohost_runtime_targets (
             target_id, identity_id, deployment_id, connection_generation,
             predecessor_fenced, ready, fresh_empty, physical_epoch, observed_at, slot_count
           ) VALUES ('target_multi_harness', 'identity_multi_harness', 'deployment_multi_harness', 1, 1, 1, 1, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', ?, 1)`
        )
        .run('2026-08-21T00:00:00.000Z');
      const runtime = createConfiguredWorkerLifecycleRuntime({
        coreDb,
        env: {},
        nanoHostSessionDispatch: sessionDispatch,
        workerControlGateway: new WorkerControlGateway(),
      });
      const backend = (
        runtime.turnExecutor as unknown as {
          readonly backend: WorkerGovernanceBackend & {
            requireLeaseId(packageSnapshotId: string): string;
          };
        }
      ).backend;
      backend.requireLeaseId = (packageSnapshotId) => `lease-${packageSnapshotId}`;
      const packageFor = (adapterId: 'codex' | 'opencode', suffix: string = adapterId) => {
        const triggerActor = { id: 'user-multi-harness', kind: 'user' as const };
        return resolveAgentEnvironmentPackage({
          agentSessionId: `agent-session-${suffix}`,
          agentSetup: createTestAgentSetup({
            adapter: adapterId,
            agentId: `agent-${adapterId}`,
            imageRef: `sha256:${'f'.repeat(64)}`,
          }),
          backend: { kind: 'openshell' },
          requestId: `request-${suffix}`,
          triggerActor,
          turn: {
            completedAt: null,
            configVersion: null,
            durationMs: null,
            error: null,
            humanGate: null,
            id: `turn-${suffix}`,
            items: [],
            startedAt: '2026-08-21T00:00:00.000Z',
            status: 'running',
            threadId: 'thread-multi-harness',
            triggerActor,
            workspaceId: 'workspace-multi-harness',
          },
          turnInput: `Run ${suffix}`,
          workspaceCwd: '/workspace',
          workspaceRoots: [],
        });
      };

      const codexPackage = packageFor('codex');
      const openCodePackage = packageFor('opencode');
      const nextCodexPackage = packageFor('codex', 'codex-next');
      authorizeNanoHostPackage(coreDb, codexPackage);
      authorizeNanoHostPackage(coreDb, openCodePackage);
      authorizeNanoHostPackage(coreDb, nextCodexPackage);
      anchorNanoHostMaterialization(coreDb, backend, codexPackage);
      await backend.materialize(codexPackage, { workspaceRoots: [] });
      anchorNanoHostMaterialization(coreDb, backend, openCodePackage);
      await backend.materialize(openCodePackage, { workspaceRoots: [] });
      anchorNanoHostMaterialization(coreDb, backend, nextCodexPackage);
      await backend.materialize(nextCodexPackage, { workspaceRoots: [] });

      expect(effects.filter((effect) => effect.kind === 'image.acquire')).toHaveLength(1);
      expect(effects.filter((effect) => effect.kind === 'sandbox.create')).toHaveLength(1);
      expect(
        coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM sandbox_runtime_records').get()
      ).toEqual({ count: 1 });
      expect(
        coreDb.sqlite
          .prepare(
            'SELECT adapter_id AS adapterId FROM harness_instance_records ORDER BY adapter_id'
          )
          .all()
      ).toEqual([{ adapterId: 'codex' }, { adapterId: 'opencode' }]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('reattaches selected storage after its proved idle Sandbox is replaced', async () => {
    const coreDb = createFactoryCoreDb();
    const effects: NanoHostSessionEffectRequest[] = [];
    const sessionDispatch: NanoHostSessionDispatch = {
      async effect(requestOrConnection: object, carriedRequest?: NanoHostSessionEffectRequest) {
        const request = carriedRequest ?? (requestOrConnection as NanoHostSessionEffectRequest);
        effects.push(request);
        if (request.kind === 'image.acquire') {
          return { digest: request.input.imageReference };
        }
        if (request.kind === 'image.inspect') return nanoHostImageInspection(request);
        if (request.kind === 'sandbox.create') {
          return nanoHostSandboxCreated(request);
        }
        if (request.kind === 'bridge.open') {
          return { accepted: true, integrationReady: true, state: 'open' };
        }
        return { state: 'deleted' };
      },
      async poll() {
        return null;
      },
      async result() {},
      async route() {
        throw new Error('Unexpected semantic route.');
      },
    };
    try {
      coreDb.sqlite
        .prepare(
          `INSERT INTO nanohost_runtime_targets (
             target_id, identity_id, deployment_id, connection_generation,
             predecessor_fenced, ready, fresh_empty, physical_epoch, observed_at, slot_count
           ) VALUES ('target_idle_eviction', 'identity_idle_eviction', 'deployment_idle_eviction',
                     1, 1, 1, 1, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', ?, 1)`
        )
        .run('2026-09-06T00:00:00.000Z');
      const runtime = createConfiguredWorkerLifecycleRuntime({
        coreDb,
        env: {},
        nanoHostSessionDispatch: sessionDispatch,
        workerControlGateway: new WorkerControlGateway(),
      });
      const backend = (
        runtime.turnExecutor as unknown as {
          readonly backend: WorkerGovernanceBackend & {
            inspectTerminalHarnessSession(session: unknown): Promise<void>;
            readonly sessions: Map<string, unknown>;
            requireLeaseId(packageSnapshotId: string): string;
          };
        }
      ).backend;
      backend.requireLeaseId = (packageSnapshotId) => `lease-${packageSnapshotId}`;
      const firstPackage = completeNanoHostPackage({
        runtime: {
          image: { kind: 'reference', pullPolicy: 'never', ref: `sha256:${'1'.repeat(64)}` },
        },
        scope: {
          agentSessionId: 'as_idle_eviction_a',
          threadId: 'thread_idle_eviction_a',
          turnId: 'turn_idle_eviction_a',
          workspaceId: 'workspace_idle_eviction_a',
        },
        snapshotId: 'snapshot_idle_eviction_a',
      });
      const secondPackage = completeNanoHostPackage({
        runtime: {
          image: { kind: 'reference', pullPolicy: 'never', ref: `sha256:${'2'.repeat(64)}` },
        },
        scope: {
          agentSessionId: 'as_idle_eviction_b',
          threadId: 'thread_idle_eviction_a',
          turnId: 'turn_idle_eviction_b',
          workspaceId: 'workspace_idle_eviction_a',
        },
        snapshotId: 'snapshot_idle_eviction_b',
      });
      authorizeNanoHostPackage(coreDb, firstPackage);
      authorizeNanoHostPackage(coreDb, secondPackage);
      coreDb.sqlite
        .prepare(
          `INSERT INTO scheduler_session_leases (
             lease_id, plan_id, workspace_id, thread_id, turn_id, agent_session_id,
             package_snapshot_id, pool_id, target_id, status, acquired_at, expires_at,
             heartbeat_deadline, startup_deadline, renewal_count, scheduler_epoch,
             sandbox_binding_ref
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'acquired', ?, ?, ?, ?, 0, 1, ?)`
        )
        .run(
          'lease-snapshot_idle_eviction_a',
          'plan_idle_eviction_a',
          firstPackage.scope.workspaceId,
          firstPackage.scope.threadId,
          firstPackage.scope.turnId,
          firstPackage.scope.agentSessionId,
          firstPackage.snapshotId,
          'pool_idle_eviction',
          'target_idle_eviction',
          '2026-09-06T00:00:00.000Z',
          '2999-01-01T00:00:00.000Z',
          '2999-01-01T00:00:00.000Z',
          '2999-01-01T00:00:00.000Z',
          'lease-binding:idle-eviction-a'
        );
      const settleNext = async (
        operation: 'session.open' | 'turn.start' | 'session.inspect' | 'session.close',
        body: Readonly<Record<string, unknown>>
      ) => {
        let command: ReturnType<typeof dispatchNanoHostHarnessOperation> = null;
        for (let attempt = 0; attempt < 20 && !command; attempt += 1) {
          const integration = coreDb.sqlite
            .prepare(
              `SELECT sandbox_integration_binding_ref AS integrationRef
               FROM sandbox_runtime_records ORDER BY created_at LIMIT 1`
            )
            .get() as { readonly integrationRef: string };
          command = dispatchNanoHostHarnessOperation(coreDb, {
            sandboxIntegrationBindingRef: integration.integrationRef,
          });
          if (!command) await new Promise<void>((resolve) => setImmediate(resolve));
        }
        if (!command || command.operation !== operation) {
          throw new Error(`Expected queued ${operation} Harness command.`);
        }
        if (operation === 'session.close') {
          expect(
            coreDb.sqlite
              .prepare(
                `SELECT s.drain_state AS sandboxDrainState,
                        h.drain_state AS harnessDrainState
                 FROM sandbox_runtime_records s
                 JOIN harness_instance_records h
                   ON h.sandbox_runtime_id = s.sandbox_runtime_id`
              )
              .get()
          ).toEqual({ harnessDrainState: 'draining', sandboxDrainState: 'draining' });
          expect(backend.inspectMaterializationCapacity?.(firstPackage)).toBe('capacity-saturated');
          anchorNanoHostMaterialization(coreDb, backend, firstPackage);
          await expect(backend.materialize(firstPackage, { workspaceRoots: [] })).rejects.toThrow(
            'NanoHost one-Sandbox capacity is occupied or unproved.'
          );
          expect(effects.map((effect) => effect.kind)).toEqual([
            'image.acquire',
            'image.inspect',
            'sandbox.create',
            'bridge.open',
            'reference.import',
          ]);
        }
        runtime.acceptNanoHostHarnessCommand(command);
        const integrationRef = (
          coreDb.sqlite
            .prepare(
              `SELECT sandbox_integration_binding_ref AS integrationRef
               FROM sandbox_runtime_records ORDER BY created_at LIMIT 1`
            )
            .get() as { readonly integrationRef: string }
        ).integrationRef;
        const result = {
          body,
          disposition: 'succeeded' as const,
          harnessInstanceId: command.harnessInstanceId,
          operationId: command.operationId,
          schemaVersion: 2 as const,
          sequence: command.sequence,
        };
        settleNanoHostHarnessOperation(coreDb, {
          result,
          sandboxIntegrationBindingRef: integrationRef,
          timestamp: '2026-09-06T00:00:01.000Z',
        });
        runtime.acceptNanoHostHarnessResult(result);
      };

      anchorNanoHostMaterialization(coreDb, backend, firstPackage);
      const firstMaterialization = await backend.materialize(firstPackage, { workspaceRoots: [] });
      const launch = backend.launch(firstMaterialization);
      await settleNext('session.open', {
        maxActiveTurns: 1,
        nativeHandleDigest: null,
        nativeHandleState: 'pending',
        state: 'open',
      });
      await settleNext('turn.start', {
        nativeHandleDigest: null,
        nativeHandleState: 'pending',
        state: 'started',
      });
      await launch;
      recordWorkerControlAcceptedRecord(coreDb, {
        acceptedAt: '2026-09-06T00:00:01.000Z',
        lineage: {
          agentSessionId: firstPackage.scope.agentSessionId,
          packageSnapshotId: firstPackage.snapshotId,
          requestId: firstPackage.scope.requestId,
          threadId: firstPackage.scope.threadId,
          turnId: firstPackage.scope.turnId,
          workspaceId: firstPackage.scope.workspaceId,
        },
        operation: 'final_status',
        record: { sequence: 1, status: 'completed', stopReason: 'completed' },
        recordKey: '1',
        sequence: 1,
      });
      const terminalInspection = backend.inspectTerminalHarnessSession(
        backend.sessions.get(firstPackage.snapshotId)
      );
      await settleNext('session.inspect', {
        childState: 'absent',
        cleanupState: 'clean',
        nativeHandleDigest: 'a'.repeat(64),
        nativeHandleState: 'ready',
        state: 'open',
      });
      await terminalInspection;
      await runtime.cleanupBackendSession(backend.planSession(firstPackage));
      coreDb.sqlite
        .prepare(
          `UPDATE scheduler_session_leases SET status = 'released'
           WHERE lease_id = 'lease-snapshot_idle_eviction_a'`
        )
        .run();
      const retainedBinding = coreDb.sqlite
        .prepare(
          `SELECT agent_session_id AS agentSessionId, lifecycle_state AS lifecycleState,
                  cleanup_state AS cleanupState
           FROM agent_session_runtime_bindings`
        )
        .get();
      expect(retainedBinding).toEqual({
        agentSessionId: 'as_idle_eviction_a',
        cleanupState: 'clean',
        lifecycleState: 'open',
      });
      const sandboxBindingRef = (
        coreDb.sqlite
          .prepare('SELECT sandbox_binding_ref AS sandboxBindingRef FROM sandbox_runtime_records')
          .get() as { readonly sandboxBindingRef: string }
      ).sandboxBindingRef;
      const selectedBinding = getWorkerStorageBindingForSandbox(coreDb, { sandboxBindingRef });
      if (!selectedBinding) throw new Error('Expected attached retained storage.');
      coreDb.sqlite
        .prepare("UPDATE sandbox_runtime_records SET pinned_goal_id = 'goal_compatible'")
        .run();
      expect(backend.inspectMaterializationCapacity?.(firstPackage)).toBe('available');
      coreDb.sqlite.prepare('UPDATE sandbox_runtime_records SET pinned_goal_id = NULL').run();
      coreDb.sqlite
        .prepare(
          `UPDATE agent_session_runtime_bindings
           SET lifecycle_state = 'active', current_turn_id = 'turn_compatible_busy',
               current_lease_id = 'lease_compatible_busy'`
        )
        .run();
      coreDb.sqlite.prepare('UPDATE harness_instance_records SET active_turn_count = 1').run();
      expect(backend.inspectMaterializationCapacity?.(firstPackage)).toBe('available');
      coreDb.sqlite
        .prepare(
          `UPDATE agent_session_runtime_bindings
           SET lifecycle_state = 'open', current_turn_id = NULL, current_lease_id = NULL`
        )
        .run();
      coreDb.sqlite.prepare('UPDATE harness_instance_records SET active_turn_count = 0').run();
      coreDb.sqlite
        .prepare(
          `INSERT INTO agent_session_runtime_bindings (
             agent_session_runtime_binding_id, harness_instance_id, agent_session_id,
             workspace_id, thread_id, agent_session_compatibility_key,
             effective_setup_generation, native_handle_state, native_handle_digest,
             lifecycle_state, current_turn_id, current_lease_id, next_turn_sequence,
             cleanup_state, created_at, updated_at
           ) SELECT 'binding_closed_history', harness_instance_id, 'as_closed_history',
                    'workspace_closed_history', 'thread_closed_history', ?, 1, 'ready', ?,
                    'closed', NULL, NULL, 1, 'clean', ?, ?
             FROM harness_instance_records LIMIT 1`
        )
        .run(
          'f'.repeat(64),
          'e'.repeat(64),
          '2026-09-06T00:00:00.000Z',
          '2026-09-06T00:00:00.000Z'
        );

      const selectedChoice = {
        expectedRevision: selectedBinding.revision,
        goalId: null,
        kind: 'selected' as const,
        purpose: 'work' as const,
        storageRef: selectedBinding.storageRef,
        taskId: null,
      };
      const effectsBeforeReplacement = effects.length;
      anchorNanoHostMaterialization(coreDb, backend, secondPackage);
      await expect(
        backend.materialize(secondPackage, {
          workerStorageChoice: {
            ...selectedChoice,
            expectedRevision: selectedBinding.revision - 1,
          },
          workspaceRoots: [],
        })
      ).rejects.toThrow('revision changed');
      expect(effects).toHaveLength(effectsBeforeReplacement);
      expect(
        coreDb.sqlite.prepare('SELECT drain_state AS drainState FROM sandbox_runtime_records').get()
      ).toEqual({ drainState: 'accepting' });

      const replacement = backend.materialize(secondPackage, {
        workerStorageChoice: selectedChoice,
        workspaceRoots: [],
      });
      await settleNext('session.close', {
        childState: 'absent',
        privateState: 'absent',
        state: 'closed',
      });
      await replacement;

      const reattachedBinding = getWorkerStorageBindingForSandbox(coreDb, {
        sandboxBindingRef: (
          coreDb.sqlite
            .prepare('SELECT sandbox_binding_ref AS sandboxBindingRef FROM sandbox_runtime_records')
            .get() as { readonly sandboxBindingRef: string }
        ).sandboxBindingRef,
      });
      expect(reattachedBinding).toMatchObject({
        attachmentGeneration: selectedBinding.attachmentGeneration + 1,
        state: 'attached',
        storageRef: selectedBinding.storageRef,
      });

      expect(effects.map((effect) => effect.kind)).toEqual([
        'image.acquire',
        'image.inspect',
        'sandbox.create',
        'bridge.open',
        'reference.import',
        'bridge.close',
        'sandbox.delete',
        'image.acquire',
        'image.inspect',
        'sandbox.create',
      ]);
      expect(
        coreDb.sqlite
          .prepare('SELECT sandbox_compatibility_key AS key FROM sandbox_runtime_records')
          .all()
      ).toHaveLength(1);
      expect(
        coreDb.sqlite.prepare('SELECT agent_session_id FROM agent_session_runtime_bindings').get()
      ).toBeUndefined();
    } finally {
      coreDb.sqlite.close();
    }
  });

  it.each([
    'busy',
    'pinned',
    'uncertain',
  ] as const)('reports one incompatible %s resident as saturated without a second Sandbox effect', async (residentState) => {
    const coreDb = createFactoryCoreDb();
    const effects: NanoHostSessionEffectRequest[] = [];
    try {
      coreDb.sqlite
        .prepare(
          `INSERT INTO nanohost_runtime_targets (
               target_id, identity_id, deployment_id, connection_generation,
               predecessor_fenced, ready, fresh_empty, physical_epoch, observed_at, slot_count
             ) VALUES ('target_capacity_guard', 'identity_capacity_guard',
                       'deployment_capacity_guard', 1, 1, 1, 1, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', ?, 1)`
        )
        .run('2026-09-06T00:00:00.000Z');
      createNanoHostHarnessRuntime(coreDb, {
        adapterId: 'codex',
        adapterVersion: '0.153.4',
        harnessBindingRef: 'harness-binding-capacity-guard',
        harnessCompatibilityKey: 'c'.repeat(64),
        harnessInstanceId: 'harness-capacity-guard',
        imageDigest: `sha256:${'1'.repeat(64)}`,
        originPhysicalEpoch: 'a'.repeat(64),
        sandboxBindingRef: 'sandbox-binding-capacity-guard',
        sandboxCompatibilityKey: 'b'.repeat(64),
        sandboxIntegrationBindingRef: 'integration-binding-capacity-guard',
        sandboxRuntimeId: 'sandbox-runtime-capacity-guard',
        runtimeTargetId: 'target_capacity_guard',
        timestamp: '2026-09-06T00:00:00.000Z',
      });
      openNanoHostAgentSessionBinding(coreDb, {
        agentSessionCompatibilityKey: 'd'.repeat(64),
        agentSessionId: 'as_capacity_guard_resident',
        agentSessionRuntimeBindingId: 'binding-capacity-guard',
        effectiveSetupGeneration: 1,
        harnessInstanceId: 'harness-capacity-guard',
        threadId: 'thread_capacity_guard_resident',
        timestamp: '2026-09-06T00:00:00.000Z',
        workspaceId: 'workspace_capacity_guard_resident',
      });
      if (residentState === 'busy') {
        coreDb.sqlite
          .prepare(
            `UPDATE agent_session_runtime_bindings
               SET lifecycle_state = 'active', current_turn_id = 'turn_busy',
                   current_lease_id = 'lease_busy'
               WHERE agent_session_runtime_binding_id = 'binding-capacity-guard'`
          )
          .run();
        coreDb.sqlite
          .prepare(
            `UPDATE harness_instance_records SET active_turn_count = 1
               WHERE harness_instance_id = 'harness-capacity-guard'`
          )
          .run();
      } else if (residentState === 'pinned') {
        coreDb.sqlite
          .prepare(
            `UPDATE sandbox_runtime_records SET pinned_goal_id = 'goal_capacity_guard'
               WHERE sandbox_runtime_id = 'sandbox-runtime-capacity-guard'`
          )
          .run();
      } else {
        coreDb.sqlite
          .prepare(
            `UPDATE sandbox_runtime_records
               SET lifecycle_state = 'failed', health_state = 'unknown',
                   drain_state = 'draining', cleanup_state = 'unknown'
               WHERE sandbox_runtime_id = 'sandbox-runtime-capacity-guard'`
          )
          .run();
      }
      const sessionDispatch: NanoHostSessionDispatch = {
        async effect(requestOrConnection: object, carriedRequest?: NanoHostSessionEffectRequest) {
          effects.push(carriedRequest ?? (requestOrConnection as NanoHostSessionEffectRequest));
          return {};
        },
        async poll() {
          return null;
        },
        async result() {},
        async route() {
          throw new Error('Unexpected semantic route.');
        },
      };
      const runtime = createConfiguredWorkerLifecycleRuntime({
        coreDb,
        env: {},
        nanoHostSessionDispatch: sessionDispatch,
        workerControlGateway: new WorkerControlGateway(),
      });
      const backend = (
        runtime.turnExecutor as unknown as { readonly backend: WorkerGovernanceBackend }
      ).backend;
      const desiredPackage = completeNanoHostPackage({
        runtime: {
          image: { kind: 'reference', pullPolicy: 'never', ref: `sha256:${'2'.repeat(64)}` },
        },
        scope: {
          agentSessionId: 'as_capacity_guard_desired',
          threadId: 'thread_capacity_guard_desired',
          turnId: 'turn_capacity_guard_desired',
          workspaceId: 'workspace_capacity_guard_desired',
        },
        snapshotId: 'snapshot_capacity_guard_desired',
      });

      expect(backend.inspectMaterializationCapacity?.(desiredPackage)).toBe('capacity-saturated');
      expect(effects).toEqual([]);
      expect(
        coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM sandbox_runtime_records').get()
      ).toEqual({ count: 1 });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('replaces same-key idle Sandbox rows that a fresh backend cannot prove process-locally', async () => {
    const coreDb = createFactoryCoreDb();
    const effects: NanoHostSessionEffectRequest[] = [];
    const sessionDispatch: NanoHostSessionDispatch = {
      async effect(requestOrConnection: object, carriedRequest?: NanoHostSessionEffectRequest) {
        const request = carriedRequest ?? (requestOrConnection as NanoHostSessionEffectRequest);
        effects.push(request);
        if (request.kind === 'image.acquire') {
          return { digest: request.input.imageReference };
        }
        if (request.kind === 'image.inspect') return nanoHostImageInspection(request);
        if (request.kind === 'sandbox.create') {
          return nanoHostSandboxCreated(request);
        }
        if (request.kind === 'bridge.close') return { state: 'closed' };
        if (request.kind === 'sandbox.delete') return { state: 'deleted' };
        throw new Error(`Unexpected NanoHost effect: ${request.kind}`);
      },
      async poll() {
        return null;
      },
      async result() {},
      async route() {
        throw new Error('Unexpected semantic route.');
      },
    };
    try {
      coreDb.sqlite
        .prepare(
          `INSERT INTO nanohost_runtime_targets (
             target_id, identity_id, deployment_id, connection_generation,
             predecessor_fenced, ready, fresh_empty, physical_epoch, observed_at, slot_count
           ) VALUES ('target_restart_unproved', 'identity_restart_unproved',
                     'deployment_restart_unproved', 1, 1, 1, 1, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', ?, 1)`
        )
        .run('2026-09-06T00:00:00.000Z');
      const packageFor = (
        agentSessionId: string,
        threadId: string,
        turnId: string,
        snapshotId: string
      ) =>
        completeNanoHostPackage({
          runtime: {
            image: { kind: 'reference', pullPolicy: 'never', ref: `sha256:${'7'.repeat(64)}` },
          },
          scope: {
            agentSessionId,
            threadId,
            turnId,
            workspaceId: 'workspace_restart_unproved',
          },
          snapshotId,
        });
      const firstPackage = packageFor(
        'as_restart_unproved_old',
        'thread_restart_unproved_old',
        'turn_restart_unproved_old',
        'snapshot_restart_unproved_old'
      );
      authorizeNanoHostPackage(coreDb, firstPackage);
      const firstRuntime = createConfiguredWorkerLifecycleRuntime({
        coreDb,
        env: {},
        nanoHostSessionDispatch: sessionDispatch,
        workerControlGateway: new WorkerControlGateway(),
      });
      const firstBackend = (
        firstRuntime.turnExecutor as unknown as {
          readonly backend: WorkerGovernanceBackend & {
            requireLeaseId(packageSnapshotId: string): string;
          };
        }
      ).backend;
      firstBackend.requireLeaseId = (snapshotId) => `lease-${snapshotId}`;
      anchorNanoHostMaterialization(coreDb, firstBackend, firstPackage);
      await firstBackend.materialize(firstPackage, { workspaceRoots: [] });
      const harness = coreDb.sqlite
        .prepare(
          `SELECT harness_instance_id AS harnessInstanceId,
                  harness_compatibility_key AS harnessCompatibilityKey,
                  adapter_id AS adapterId, adapter_version AS adapterVersion,
                  s.sandbox_runtime_id AS sandboxRuntimeId,
                  s.sandbox_binding_ref AS sandboxBindingRef,
                  s.sandbox_integration_binding_ref AS sandboxIntegrationBindingRef,
                  s.sandbox_compatibility_key AS sandboxCompatibilityKey,
                  s.image_digest AS imageDigest, s.runtime_target_id AS runtimeTargetId
           FROM harness_instance_records h
           JOIN sandbox_runtime_records s ON s.sandbox_runtime_id = h.sandbox_runtime_id`
        )
        .get() as {
        readonly adapterId: 'codex';
        readonly adapterVersion: string;
        readonly harnessCompatibilityKey: string;
        readonly harnessInstanceId: string;
        readonly imageDigest: string;
        readonly runtimeTargetId: string;
        readonly sandboxBindingRef: string;
        readonly sandboxCompatibilityKey: string;
        readonly sandboxIntegrationBindingRef: string;
        readonly sandboxRuntimeId: string;
      };
      const sessionCompatibilityKey = planSessionWorkspaceMaterialization({
        environmentPackage: firstPackage,
      }).compatibilityKey.digest;
      openNanoHostAgentSessionBinding(coreDb, {
        agentSessionCompatibilityKey: deriveNanoHostAgentSessionCompatibilityKey({
          adapterId: harness.adapterId,
          adapterVersion: harness.adapterVersion,
          harnessCompatibilityKey: harness.harnessCompatibilityKey,
          sessionCompatibilityKey,
          threadId: firstPackage.scope.threadId,
        }),
        agentSessionId: firstPackage.scope.agentSessionId,
        agentSessionRuntimeBindingId: 'binding-restart-unproved-old',
        effectiveSetupGeneration: 1,
        harnessInstanceId: harness.harnessInstanceId,
        threadId: firstPackage.scope.threadId,
        timestamp: '2026-09-06T00:00:01.000Z',
        workspaceId: firstPackage.scope.workspaceId,
      });
      coreDb.sqlite
        .prepare(
          `UPDATE agent_session_runtime_bindings
           SET lifecycle_state = 'open', native_handle_state = 'ready',
               native_handle_digest = ?, cleanup_state = 'clean'`
        )
        .run('9'.repeat(64));
      const unprovedPackage = packageFor(
        'as_restart_unproved_other_harness',
        'thread_restart_unproved_other_harness',
        'turn_restart_unproved_other_harness',
        'snapshot_restart_unproved_other_harness'
      );
      const unprovedSessionCompatibilityKey = planSessionWorkspaceMaterialization({
        environmentPackage: unprovedPackage,
      }).compatibilityKey.digest;
      createNanoHostHarnessRuntime(coreDb, {
        adapterId: harness.adapterId,
        adapterVersion: harness.adapterVersion,
        harnessBindingRef: 'harness-binding-restart-unproved-other',
        harnessCompatibilityKey: '8'.repeat(64),
        harnessInstanceId: 'harness-restart-unproved-other',
        imageDigest: harness.imageDigest,
        originPhysicalEpoch: 'a'.repeat(64),
        runtimeTargetId: harness.runtimeTargetId,
        sandboxBindingRef: harness.sandboxBindingRef,
        sandboxCompatibilityKey: harness.sandboxCompatibilityKey,
        sandboxIntegrationBindingRef: harness.sandboxIntegrationBindingRef,
        sandboxRuntimeId: harness.sandboxRuntimeId,
        timestamp: '2026-09-06T00:00:01.000Z',
      });
      openNanoHostAgentSessionBinding(coreDb, {
        agentSessionCompatibilityKey: deriveNanoHostAgentSessionCompatibilityKey({
          adapterId: harness.adapterId,
          adapterVersion: harness.adapterVersion,
          harnessCompatibilityKey: '8'.repeat(64),
          sessionCompatibilityKey: unprovedSessionCompatibilityKey,
          threadId: unprovedPackage.scope.threadId,
        }),
        agentSessionId: unprovedPackage.scope.agentSessionId,
        agentSessionRuntimeBindingId: 'binding-restart-unproved-other',
        effectiveSetupGeneration: 1,
        harnessInstanceId: 'harness-restart-unproved-other',
        threadId: unprovedPackage.scope.threadId,
        timestamp: '2026-09-06T00:00:01.000Z',
        workspaceId: unprovedPackage.scope.workspaceId,
      });
      coreDb.sqlite
        .prepare(
          `UPDATE agent_session_runtime_bindings
           SET lifecycle_state = 'open', native_handle_state = 'ready',
               native_handle_digest = ?, cleanup_state = 'clean'
           WHERE agent_session_runtime_binding_id = 'binding-restart-unproved-other'`
        )
        .run('8'.repeat(64));
      coreDb.sqlite
        .prepare(
          `UPDATE scheduler_session_leases
           SET status = 'released'
           WHERE package_snapshot_id = ?`
        )
        .run(firstPackage.snapshotId);

      const recoveringRuntime = createConfiguredWorkerLifecycleRuntime({
        coreDb,
        env: {},
        nanoHostSessionDispatch: sessionDispatch,
        workerControlGateway: new WorkerControlGateway(),
      });
      const recoveringBackend = (
        recoveringRuntime.turnExecutor as unknown as {
          readonly backend: WorkerGovernanceBackend & {
            restoreSession(environmentPackage: AgentEnvironmentPackage, leaseId: string): void;
          };
        }
      ).backend;
      recoveringBackend.restoreSession(firstPackage, `lease-${firstPackage.snapshotId}`);
      await expect(
        recoveringBackend.prepareAgentSessionContinuity?.({
          agentSessionCompatibilityKey: sessionCompatibilityKey,
          agentSessionId: firstPackage.scope.agentSessionId,
          environmentPackage: firstPackage,
          reuseAllowed: true,
          threadId: firstPackage.scope.threadId,
          workspaceId: firstPackage.scope.workspaceId,
        })
      ).resolves.toBe('reusable');

      const restartedRuntime = createConfiguredWorkerLifecycleRuntime({
        coreDb,
        env: {},
        nanoHostSessionDispatch: sessionDispatch,
        workerControlGateway: new WorkerControlGateway(),
      });
      const restartedBackend = (
        restartedRuntime.turnExecutor as unknown as {
          readonly backend: WorkerGovernanceBackend & {
            restoreSharedHarness(
              sandboxCompatibilityKey: string,
              harnessCompatibilityKey: string,
              runtimeTargetId: string,
              adapterId: 'codex',
              adapterVersion: string
            ): unknown;
          };
        }
      ).backend;
      const secondPackage = packageFor(
        'as_restart_unproved_fresh',
        unprovedPackage.scope.threadId,
        'turn_restart_unproved_fresh',
        'snapshot_restart_unproved_fresh'
      );
      authorizeNanoHostPackage(coreDb, secondPackage);
      const retainedStorageBeforeCorruption = getWorkerStorageBindingForSandbox(coreDb, {
        sandboxBindingRef: harness.sandboxBindingRef,
      });
      coreDb.sqlite
        .prepare("UPDATE sandbox_runtime_records SET origin_physical_epoch = 'malformed'")
        .run();
      expect(() => restartedBackend.inspectMaterializationCapacity?.(secondPackage)).toThrow(
        /physical Epoch/i
      );
      expect(
        getWorkerStorageBindingForSandbox(coreDb, {
          sandboxBindingRef: harness.sandboxBindingRef,
        })
      ).toEqual(retainedStorageBeforeCorruption);
      expect(
        coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM sandbox_runtime_records').get()
      ).toEqual({ count: 1 });
      coreDb.sqlite
        .prepare('UPDATE sandbox_runtime_records SET origin_physical_epoch = ?')
        .run('a'.repeat(64));
      coreDb.sqlite
        .prepare("UPDATE sandbox_runtime_records SET pinned_goal_id = 'goal_restart_unproved'")
        .run();
      expect(restartedBackend.inspectMaterializationCapacity?.(secondPackage)).toBe(
        'capacity-saturated'
      );
      coreDb.sqlite.prepare('UPDATE sandbox_runtime_records SET pinned_goal_id = NULL').run();
      coreDb.sqlite
        .prepare(
          `UPDATE agent_session_runtime_bindings
           SET lifecycle_state = 'active', current_turn_id = 'turn_restart_busy',
               current_lease_id = 'lease_restart_busy'`
        )
        .run();
      coreDb.sqlite.prepare('UPDATE harness_instance_records SET active_turn_count = 1').run();
      expect(restartedBackend.inspectMaterializationCapacity?.(secondPackage)).toBe(
        'capacity-saturated'
      );
      coreDb.sqlite
        .prepare(
          `UPDATE agent_session_runtime_bindings
           SET lifecycle_state = 'open', current_turn_id = NULL, current_lease_id = NULL`
        )
        .run();
      coreDb.sqlite.prepare('UPDATE harness_instance_records SET active_turn_count = 0').run();
      coreDb.sqlite
        .prepare(
          `UPDATE sandbox_runtime_records
           SET lifecycle_state = 'failed', health_state = 'unknown',
               drain_state = 'draining', cleanup_state = 'unknown'`
        )
        .run();
      expect(restartedBackend.inspectMaterializationCapacity?.(secondPackage)).toBe(
        'capacity-saturated'
      );
      coreDb.sqlite
        .prepare(
          `UPDATE sandbox_runtime_records
           SET lifecycle_state = 'open', health_state = 'ready',
               drain_state = 'accepting', cleanup_state = 'clean'`
        )
        .run();
      restartedBackend.restoreSharedHarness(
        harness.sandboxCompatibilityKey,
        harness.harnessCompatibilityKey,
        harness.runtimeTargetId,
        harness.adapterId,
        harness.adapterVersion
      );
      await expect(
        restartedBackend.prepareAgentSessionContinuity?.({
          agentSessionCompatibilityKey: unprovedSessionCompatibilityKey,
          agentSessionId: unprovedPackage.scope.agentSessionId,
          reuseAllowed: true,
          threadId: unprovedPackage.scope.threadId,
          workspaceId: unprovedPackage.scope.workspaceId,
        })
      ).resolves.toBe('sandbox-replacement-required');

      coreDb.sqlite
        .prepare(
          `INSERT INTO scheduler_session_leases (
             lease_id, plan_id, workspace_id, thread_id, turn_id, agent_session_id,
             package_snapshot_id, pool_id, target_id, status, acquired_at, expires_at,
             heartbeat_deadline, startup_deadline, renewal_count, scheduler_epoch,
             sandbox_binding_ref
           ) VALUES ('lease-restart-unproved-fresh', 'plan-restart-unproved-fresh',
                     ?, ?, ?, ?, ?, 'pool_restart_unproved', 'target_restart_unproved',
                     'acquired', ?, ?, ?, ?, 0, 1, 'lease-binding:restart-unproved')`
        )
        .run(
          secondPackage.scope.workspaceId,
          secondPackage.scope.threadId,
          secondPackage.scope.turnId,
          secondPackage.scope.agentSessionId,
          secondPackage.snapshotId,
          '2026-09-06T00:00:02.000Z',
          '2999-01-01T00:00:00.000Z',
          '2999-01-01T00:00:00.000Z',
          '2999-01-01T00:00:00.000Z'
        );
      await expect(
        recoveringBackend.prepareAgentSessionContinuity?.({
          admissionAgentSessionId: secondPackage.scope.agentSessionId,
          admissionLeaseId: 'lease-restart-unproved-fresh',
          agentSessionCompatibilityKey: unprovedSessionCompatibilityKey,
          agentSessionId: unprovedPackage.scope.agentSessionId,
          environmentPackage: secondPackage,
          reuseAllowed: false,
          threadId: unprovedPackage.scope.threadId,
          workspaceId: unprovedPackage.scope.workspaceId,
        })
      ).rejects.toThrow('NanoHost one-Sandbox capacity is occupied or unproved.');
      await expect(
        restartedBackend.prepareAgentSessionContinuity?.({
          admissionAgentSessionId: secondPackage.scope.agentSessionId,
          admissionLeaseId: 'lease-restart-unproved-fresh',
          agentSessionCompatibilityKey: unprovedSessionCompatibilityKey,
          agentSessionId: unprovedPackage.scope.agentSessionId,
          environmentPackage: secondPackage,
          reuseAllowed: false,
          threadId: unprovedPackage.scope.threadId,
          workspaceId: unprovedPackage.scope.workspaceId,
        })
      ).resolves.toBe('closed');
      expect(effects.map((effect) => effect.kind)).toEqual([
        'image.acquire',
        'image.inspect',
        'sandbox.create',
        'bridge.close',
        'sandbox.delete',
      ]);
      expect(
        coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM agent_session_runtime_bindings').get()
      ).toEqual({ count: 0 });

      expect(restartedBackend.planSession(secondPackage).backendSessionId.slice(0, 19)).toBe(
        firstBackend.planSession(firstPackage).backendSessionId.slice(0, 19)
      );
      anchorNanoHostMaterialization(coreDb, restartedBackend, secondPackage);
      await restartedBackend.materialize(secondPackage, { workspaceRoots: [] });

      expect(effects.map((effect) => effect.kind)).toEqual([
        'image.acquire',
        'image.inspect',
        'sandbox.create',
        'bridge.close',
        'sandbox.delete',
        'image.acquire',
        'image.inspect',
        'sandbox.create',
      ]);
      expect(
        coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM sandbox_runtime_records').get()
      ).toEqual({ count: 1 });
      expect(
        coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM agent_session_runtime_bindings').get()
      ).toEqual({ count: 0 });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it.each([
    {
      concurrentRevisionAdvance: false,
      expectedError: 'injected stop after selected storage reattachment',
      predecessorStatus: 'idle' as const,
    },
    {
      concurrentRevisionAdvance: true,
      expectedError: 'Worker storage revision changed.',
      predecessorStatus: 'idle' as const,
    },
    {
      concurrentRevisionAdvance: false,
      expectedError: 'injected stop after selected storage reattachment',
      predecessorStatus: 'failed' as const,
    },
  ])('carries only its proved cleanup revision through restart-unproved Task admission: predecessor=$predecessorStatus concurrent=$concurrentRevisionAdvance', async ({
    concurrentRevisionAdvance,
    expectedError,
    predecessorStatus,
  }) => {
    const coreDb = createFactoryCoreDb();
    const effects: NanoHostSessionEffectRequest[] = [];
    let predecessorCleanupCompleted = false;
    let concurrentAdvanceApplied = false;
    let selectedStorageRef: string | null = null;
    const sessionDispatch: NanoHostSessionDispatch = {
      async effect(requestOrConnection: object, carriedRequest?: NanoHostSessionEffectRequest) {
        const request = carriedRequest ?? (requestOrConnection as NanoHostSessionEffectRequest);
        effects.push(request);
        if (request.kind === 'bridge.close') return { state: 'closed' };
        if (request.kind === 'sandbox.delete') {
          predecessorCleanupCompleted = true;
          return { state: 'deleted' };
        }
        if (request.kind === 'image.acquire') {
          if (
            concurrentRevisionAdvance &&
            predecessorCleanupCompleted &&
            !concurrentAdvanceApplied
          ) {
            if (!selectedStorageRef) throw new Error('Selected storage fixture is unavailable.');
            const released = getWorkerStorageBinding(coreDb, {
              storageRef: selectedStorageRef,
            });
            reserveWorkerStorageAttachment(coreDb, {
              agentSessionId: 'as_restart_selected_competing',
              authorizeContributor: () => true,
              expectedRevision: released.revision,
              layout: released.layout,
              purpose: 'work',
              responsibleUserId: 'user_fixture',
              runtimeTargetId: 'target_restart_selected',
              storageRef: selectedStorageRef,
              threadId: 'thread_restart_selected',
              workspaceId: 'workspace_restart_selected',
            });
            concurrentAdvanceApplied = true;
          }
          return { digest: `sha256:${'4'.repeat(64)}` };
        }
        if (request.kind === 'image.inspect') return nanoHostImageInspection(request);
        if (request.kind === 'sandbox.create') return nanoHostSandboxCreated(request);
        if (request.kind === 'bridge.open') {
          throw new Error('injected stop after selected storage reattachment');
        }
        throw new Error(`Unexpected NanoHost effect: ${request.kind}`);
      },
      async poll() {
        return null;
      },
      async result() {},
      async route() {
        throw new Error('Unexpected semantic route.');
      },
    };

    try {
      coreDb.sqlite
        .prepare(
          `INSERT INTO nanohost_runtime_targets (
               target_id, identity_id, deployment_id, connection_generation,
               predecessor_fenced, ready, fresh_empty, physical_epoch, observed_at, slot_count
             ) VALUES ('target_restart_selected', 'identity_restart_selected',
                       'deployment_restart_selected', 1, 1, 1, 1, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', ?, 1)`
        )
        .run('2026-09-11T00:00:00.000Z');
      createNanoHostHarnessRuntime(coreDb, {
        adapterId: 'codex',
        adapterVersion: 'test',
        harnessBindingRef: 'harness-binding-restart-selected',
        harnessCompatibilityKey: '5'.repeat(64),
        harnessInstanceId: 'harness-restart-selected',
        imageDigest: `sha256:${'4'.repeat(64)}`,
        originPhysicalEpoch: 'a'.repeat(64),
        runtimeTargetId: 'target_restart_selected',
        sandboxBindingRef: 'sandbox-binding-restart-selected',
        sandboxCompatibilityKey: '6'.repeat(64),
        sandboxIntegrationBindingRef: 'integration-restart-selected',
        sandboxRuntimeId: 'sandbox-runtime-restart-selected',
        timestamp: '2026-09-11T00:00:00.000Z',
      });
      const scopePackage = completeNanoHostPackage({
        scope: {
          agentSessionId: 'as_restart_selected_idle',
          threadId: 'thread_restart_selected',
          triggerActor: { kind: 'user', id: 'user_fixture' },
          turnId: 'turn_restart_selected_previous',
          workspaceId: 'workspace_restart_selected',
        },
        snapshotId: 'snapshot_restart_selected_previous',
      });
      authorizeNanoHostPackage(coreDb, scopePackage);
      const attached = attachNanoHostStorageFixture(coreDb, {
        agentSessionId: 'as_restart_selected_idle',
        deploymentId: 'deployment_restart_selected',
        runtimeTargetId: 'target_restart_selected',
        sandboxBindingRef: 'sandbox-binding-restart-selected',
        threadId: 'thread_restart_selected',
        workspaceId: 'workspace_restart_selected',
      });
      selectedStorageRef = attached.storageRef;
      openNanoHostAgentSessionBinding(coreDb, {
        agentSessionCompatibilityKey: '7'.repeat(64),
        agentSessionId: 'as_restart_selected_idle',
        agentSessionRuntimeBindingId: 'binding-restart-selected-idle',
        effectiveSetupGeneration: 1,
        harnessInstanceId: 'harness-restart-selected',
        threadId: 'thread_restart_selected',
        timestamp: '2026-09-11T00:00:01.000Z',
        workspaceId: 'workspace_restart_selected',
      });
      coreDb.sqlite
        .prepare(
          `UPDATE agent_session_runtime_bindings
             SET lifecycle_state = 'open', native_handle_state = 'ready',
                 native_handle_digest = ?, cleanup_state = 'clean'`
        )
        .run('8'.repeat(64));
      const store = new FsStore({ dataRoot: coreDb.dataRoot });
      const requestId = '00000000-0000-4000-8000-00000000e501';
      const selectedChoice = {
        expectedRevision: attached.revision,
        goalId: null,
        kind: 'selected' as const,
        purpose: 'work' as const,
        storageRef: attached.storageRef,
        taskId: null,
      };
      const runtime = createConfiguredWorkerLifecycleRuntime({
        coreDb,
        env: {},
        nanoHostSessionDispatch: sessionDispatch,
        store,
        workerControlGateway: new WorkerControlGateway(),
      });
      const previewInput = {
        agentSetup: createTestAgentSetup(),
        freshAgentSessionId: 'as_restart_selected_next',
        requestId,
        turn: {
          completedAt: null,
          configVersion: null,
          durationMs: null,
          error: null,
          humanGate: null,
          id: 'turn_restart_selected_next',
          items: [],
          startedAt: '2999-09-11T00:00:03.000Z',
          status: 'running' as const,
          threadId: 'thread_restart_selected',
          triggerActor: { kind: 'user' as const, id: 'user_fixture' },
          workspaceId: 'workspace_restart_selected',
        },
        turnInput: 'Continue from the retained restart-selected workspace.',
        workerStorageChoice: selectedChoice,
        workspaceCwd: null,
        workspaceRoots: [],
      } satisfies PrepareAgentSessionForTurnInput;
      const currentCompatibilityKey = (
        runtime.turnExecutor as unknown as {
          previewAgentSessionCompatibilityKey(
            agentSessionId: string,
            input: PrepareAgentSessionForTurnInput
          ): string;
        }
      ).previewAgentSessionCompatibilityKey('as_restart_selected_idle', previewInput);
      store.createAgentSession({
        agentId: 'agent_codex_host',
        createdAt: '2026-09-11T00:00:01.000Z',
        environmentPackageSnapshotId: scopePackage.snapshotId,
        id: 'as_restart_selected_idle',
        message: null,
        policySnapshotId: 'worker_turn_launch_policy',
        sessionCompatibilityKey: currentCompatibilityKey,
        status: predecessorStatus,
        threadId: 'thread_restart_selected',
        updatedAt: '2026-09-11T00:00:01.000Z',
        workspaceId: 'workspace_restart_selected',
        workspaceRoots: [],
      });
      upsertSchedulerWorkerPool(coreDb, {
        allowedBackendKinds: ['openshell'],
        allowedPlacements: ['local'],
        allowedWorkspaceScopes: ['local'],
        budgetClass: 'interactive',
        currentAdmittedSessionCount: 0,
        currentQueueDepth: 1,
        defaultTimeoutMs: 900_000,
        healthSummary: 'ready',
        maxConcurrentSessions: 1,
        poolId: 'pool_restart_selected',
        queueLimit: 20,
        status: 'active',
      });
      upsertSchedulerCapacityRecord(coreDb, {
        capacityClass: 'local',
        concurrencyCeiling: 1,
        inUseCount: 0,
        observationSource: 'configured',
        observedAt: '2026-09-11T00:00:02.000Z',
        poolId: 'pool_restart_selected',
        queueDepth: 1,
        targetId: 'scheduler-target-restart-selected',
      });
      upsertSchedulerTargetHealthRecord(coreDb, {
        checkResults: [],
        consecutiveFailureCount: 0,
        consecutiveSuccessCount: 1,
        healthState: 'healthy',
        lastProbeAt: '2026-09-11T00:00:02.000Z',
        nextProbeAt: '2026-09-11T00:01:02.000Z',
        targetId: 'scheduler-target-restart-selected',
      });
      createSchedulerAdmissionEntry(coreDb, {
        now: () => '2026-09-11T00:00:02.000Z',
        priorityClass: 'interactive',
        profileRef: 'default',
        queueEntryId: 'queue_restart_selected',
        requestId,
        requestedAgentId: 'agent_codex_host',
        requiredPoolConstraints: ['openshell.local'],
        threadId: 'thread_restart_selected',
        turnId: 'turn_restart_selected_next',
        turnInput: 'Continue from the retained restart-selected workspace.',
        triggerActor: { kind: 'user', id: 'user_fixture' },
        workerStorageChoice: selectedChoice,
        workspaceId: 'workspace_restart_selected',
      });
      const providerRegistry = new ProviderRegistry([
        {
          baseUrl: 'http://127.0.0.1:11434/v1',
          defaultModel: 'openai/gpt-5.2',
          displayName: 'Restart-selected fixture provider',
          id: 'agent-openrouter',
          kind: 'local',
          models: ['openai/gpt-5.2'],
        },
      ]);

      let observedError: unknown;
      try {
        await runSchedulerDispatchLoop({
          agentManifests: [createTestAgentSetup().manifest],
          coreDb,
          createAgentSessionId: () => 'as_restart_selected_next',
          createLeaseId: () => 'lease_restart_selected_next',
          createPlanId: () => 'plan_restart_selected_next',
          expectedControlMode: 'poll',
          expectedDataPlaneMode: 'openshell-files',
          gatewayConfig: createTestGatewayConfig(),
          heartbeatIntervalMs: 10_000,
          heartbeatTimeoutMs: 30_000,
          leaseDurationMs: 900_000,
          maxDispatches: 1,
          now: () => '2999-09-11T00:00:03.000Z',
          providerRegistry,
          schedulerEpoch: 1,
          startupTimeoutMs: 120_000,
          store,
          turnExecutor: runtime.turnExecutor,
        });
      } catch (error) {
        observedError = error;
      }
      const errorMessages = (error: unknown): string[] => [
        ...(error instanceof Error ? [error.message] : [String(error)]),
        ...(error instanceof AggregateError
          ? error.errors.flatMap((nested) => errorMessages(nested))
          : []),
      ];
      expect(errorMessages(observedError)).toContain(expectedError);

      const replacementCreates = effects.filter((effect) => effect.kind === 'sandbox.create');
      if (concurrentRevisionAdvance) {
        expect(concurrentAdvanceApplied).toBe(true);
        expect(replacementCreates).toEqual([]);
      } else {
        expect(replacementCreates).toHaveLength(1);
        expect(replacementCreates[0]?.input.storage).toMatchObject({
          attachmentGeneration: attached.attachmentGeneration + 1,
          storageRef: attached.storageRef,
        });
      }
      expect(store.getAgentSession('as_restart_selected_idle').status).toBe(
        predecessorStatus === 'idle' ? 'closed' : 'failed'
      );
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('rejects persistent runtime-file credentials and unsupported Providers before effects', async () => {
    const coreDb = createFactoryCoreDb();
    const effects: NanoHostSessionEffectRequest[] = [];
    const sessionDispatch = {
      async effect(request: NanoHostSessionEffectRequest) {
        effects.push(request);
        if (request.kind === 'image.acquire') return { digest: `sha256:${'e'.repeat(64)}` };
        if (request.kind === 'image.inspect') return nanoHostImageInspection(request);
        if (request.kind === 'sandbox.create') {
          return nanoHostSandboxCreated(request);
        }
        if (request.kind === 'reference.import') return { state: 'imported' };
        throw new Error(`Unexpected NanoHost effect: ${request.kind}`);
      },
      async poll() {
        return null;
      },
      async result() {},
      async route() {
        throw new Error('Unexpected semantic route.');
      },
    } satisfies NanoHostSessionDispatch;
    try {
      coreDb.sqlite
        .prepare(
          `INSERT INTO nanohost_runtime_targets (
             target_id, identity_id, deployment_id, connection_generation,
             predecessor_fenced, ready, fresh_empty, physical_epoch, observed_at, slot_count
           ) VALUES ('target_credentials', 'identity_credentials', 'deployment_credentials', 1, 1, 1, 1, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', ?, 1)`
        )
        .run('2026-08-21T00:00:00.000Z');
      const runtime = createConfiguredWorkerLifecycleRuntime({
        coreDb,
        env: {},
        nanoHostSessionDispatch: sessionDispatch,
        workerControlGateway: new WorkerControlGateway(),
      });
      const backend = (
        runtime.turnExecutor as unknown as {
          readonly backend: WorkerGovernanceBackend & {
            requireLeaseId(packageSnapshotId: string): string;
          };
        }
      ).backend;
      backend.requireLeaseId = () => 'lease-credentials';
      const environmentPackage = completeNanoHostPackage({
        scope: {
          agentSessionId: 'agent-session-credentials',
          threadId: 'thread-credentials',
          turnId: 'turn-credentials',
          workspaceId: 'workspace-credentials',
        },
        snapshotId: 'snapshot-credentials',
      });

      await expect(
        backend.materialize(environmentPackage, {
          runtimeFileCredentials: [
            {
              credentialValue: 'runtime-file-secret',
              targetPath: '/sandbox/.config/example/credentials',
            },
          ],
          workspaceRoots: [],
        })
      ).rejects.toThrow('do not admit runtime-file credential materialization');
      expect(effects).toEqual([]);
      expect(
        coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM worker_storage_bindings').get()
      ).toEqual({ count: 0 });

      await expect(
        backend.materialize(
          { ...environmentPackage, snapshotId: 'snapshot-provider-rejected' },
          {
            providerCredentials: [
              {
                credentialKey: 'EXAMPLE_TOKEN',
                credentialValue: 'provider-secret',
                providerInstanceId: 'provider-example',
                providerType: 'generic',
              },
            ],
            workspaceRoots: [],
          }
        )
      ).rejects.toThrow('Provider credential materialization is not supported');
      expect(effects).toEqual([]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('derives deterministic distinct DNS-1123 sandbox identities before sandbox creation', async () => {
    const coreDb = createFactoryCoreDb();
    const sandboxCreates: NanoHostSessionEffectRequest[] = [];
    const sessionDispatch: NanoHostSessionDispatch = {
      async effect(
        requestOrConnection: object,
        carriedRequest?: NanoHostSessionEffectRequest
      ): Promise<unknown> {
        const request = carriedRequest ?? (requestOrConnection as NanoHostSessionEffectRequest);
        if (request.kind === 'image.acquire') {
          return { digest: `sha256:${'b'.repeat(64)}` };
        }
        if (request.kind === 'image.inspect') return nanoHostImageInspection(request);
        if (request.kind === 'sandbox.create') {
          sandboxCreates.push(request);
          throw new Error('first sandbox.create reached');
        }
        throw new Error(`Unexpected NanoHost effect ${request.kind}.`);
      },
      async poll() {
        return null;
      },
      async result() {},
      async route() {
        throw new Error('Unexpected semantic route.');
      },
    };

    try {
      coreDb.sqlite
        .prepare(
          `INSERT INTO nanohost_runtime_targets (
             target_id, identity_id, deployment_id, connection_generation,
             predecessor_fenced, ready, fresh_empty, physical_epoch, observed_at, slot_count
           ) VALUES (?, ?, ?, 1, 1, 1, 1, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', ?, 1)`
        )
        .run(
          'target_factory_dns_sandbox',
          'identity_factory_dns_sandbox',
          'deployment_factory_dns_sandbox',
          '2026-08-10T00:00:00.000Z'
        );
      const runtime = createConfiguredWorkerLifecycleRuntime({
        coreDb,
        env: {},
        nanoHostSessionDispatch: sessionDispatch,
        workerControlGateway: new WorkerControlGateway(),
      });
      const backend = (
        runtime.turnExecutor as unknown as {
          readonly backend: WorkerGovernanceBackend & {
            requireLeaseId(packageSnapshotId: string): string;
          };
        }
      ).backend;
      backend.requireLeaseId = (snapshotId) => `lease-${snapshotId}`;
      const sandboxIds: string[] = [];
      const policy = {
        filesystem: {
          default: 'deny',
          rules: [
            { access: 'read-only', workerPath: '/workspace/vendor-sdk' },
            { access: 'read-write', workerPath: '/sandbox/.cache/npm' },
          ],
        },
        network: {
          default: 'deny',
          enforcement: 'openshell',
          rules: [
            {
              access: 'read-only',
              action: 'allow',
              binaries: ['/usr/bin/curl'],
              host: 'api.example.com',
              id: 'artifact-api',
              port: 443,
              protocol: 'rest',
            },
          ],
        },
        process: { default: 'deny', rules: [] },
        snapshotId: 'policy_factory_dns_sandbox',
      };

      for (const [agentSessionId, snapshotId] of [
        ['as_wp5_gate_r3', 'aepsnap_factory_dns_lower'],
        ['AS_WP5_GATE_R3', 'aepsnap_factory_dns_upper'],
      ] as const) {
        const environmentPackage = completeNanoHostPackage({
          policy,
          runtime: { image: { kind: 'reference', ref: 'openkit/worker:test' } },
          scope: {
            agentSessionId,
            threadId: `thread_${snapshotId}`,
            turnId: `turn_${snapshotId}`,
            workspaceId: `ws_${snapshotId}`,
          },
          snapshotId,
        });
        authorizeNanoHostPackage(coreDb, environmentPackage);
        const firstPlan = backend.planSession(environmentPackage);
        const secondPlan = backend.planSession(environmentPackage);
        expect(secondPlan.backendSessionId).toBe(firstPlan.backendSessionId);

        anchorNanoHostMaterialization(coreDb, backend, environmentPackage);
        await expect(
          backend.materialize(environmentPackage, { workspaceRoots: [] })
        ).rejects.toThrow('first sandbox.create reached');
        const sandboxCreate = sandboxCreates.at(-1);
        expect(sandboxCreate?.input).toMatchObject({
          backendSessionId: firstPlan.backendSessionId,
          environment: {},
          imageDigest: `sha256:${'b'.repeat(64)}`,
          leaseId: `lease-${snapshotId}`,
          packageSnapshotId: snapshotId,
          policy: {
            filesystem: {
              includeWorkdir: false,
              readOnly: [
                '/usr',
                '/lib',
                '/proc',
                '/dev/urandom',
                '/app',
                '/etc',
                '/opt',
                '/var/log',
                '/workspace/vendor-sdk',
              ],
              readWrite: [
                '/sandbox',
                '/workspace',
                '/openkit',
                '/tmp/openkit-bootstrap',
                '/dev/null',
                '/sandbox/.cache/npm',
              ],
            },
            landlock: { compatibility: 'best_effort' },
            networkMiddlewares: {},
            networkPolicies: {
              artifact_api: {
                binaries: [{ path: '/usr/bin/curl' }],
                endpoints: [
                  {
                    access: 'read-only',
                    enforcement: 'enforce',
                    host: 'api.example.com',
                    port: 443,
                    protocol: 'rest',
                  },
                ],
                name: 'artifact_api',
              },
            },
            process: { runAsGroup: 'sandbox', runAsUser: 'sandbox' },
            version: 1,
          },
          sandboxId: firstPlan.backendSessionId.slice(0, 19),
          storage: {
            attachmentGeneration: 1,
            layoutDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
            scopeDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
            storageRef: expect.stringMatching(/^wst_[0-9a-f]{32}$/),
            targets: [
              {
                target: '/sandbox',
                volumeRef: expect.stringMatching(/^wsv_[0-9a-f]{32}$/),
              },
              {
                target: '/workspace',
                volumeRef: expect.stringMatching(/^wsv_[0-9a-f]{32}$/),
              },
            ],
          },
        });
        expect(sandboxCreate?.kind).toBe('sandbox.create');
        expect(firstPlan.backendSessionId.length).toBeLessThanOrEqual(36);
        expect(firstPlan.backendSessionId).toMatch(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/);
        sandboxIds.push(firstPlan.backendSessionId.slice(0, 19));
      }

      expect(new Set(sandboxIds).size).toBe(sandboxIds.length);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('keeps the deterministic self-check executor override outside production selection', () => {
    const executor = createConfiguredTurnExecutor({
      coreDb: factoryCoreDb,
      env: { OPENKIT_INTERNAL_SELF_CHECK_EXECUTOR: '1' },
      workerControlGateway: new WorkerControlGateway(),
    });

    expect(executor).toBeInstanceOf(SimulatedTurnExecutor);
  });
});
