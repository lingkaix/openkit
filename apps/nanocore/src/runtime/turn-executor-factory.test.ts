import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { connect as connectHttp2, createServer as createHttp2Server } from 'node:http2';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import {
  type AgentEnvironmentPackage,
  AgentEnvironmentPackageSchema,
  planSessionWorkspaceMaterialization,
  type SessionWorkspaceMaterializationPlan,
} from '@openkit/config-schema';
import { describe, expect, it, vi } from 'vitest';
import { createOpenKitAccessTokenRecord } from '../auth/access-token-store.js';
import {
  createNanoHostTransportSessionAuthority,
  readNanoHostPhysicalConnectionContext,
} from '../auth/nanohost-transport-session.js';
import { SimulatedTurnExecutor } from '../lib/simulator.js';
import { createDemoWorkspaceForUser, FsStore } from '../lib/store.js';
import { ProviderRegistry } from '../providers/registry.js';
import {
  createSchedulerAdmissionEntry,
  createSchedulerPlacementPlan,
  createSchedulerSessionLease,
  dispatchNextSchedulerEntry,
  upsertSchedulerCapacityRecord,
  upsertSchedulerTargetHealthRecord,
  upsertSchedulerWorkerPool,
} from '../scheduler-records.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { ensureLayout } from '../storage/fs-layout.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import {
  createTestAgentSetup,
  createTestGatewayConfig,
} from '../test-support/agent-environment.js';
import { createDemoStore } from '../test-support/demo-store.js';
import {
  admitTestNativeEnvironment,
  createTestNativeEnvironmentDb,
} from '../test-support/native-environment.js';
import type { VaultBackend } from '../vault/vault-backend.js';
import { upsertWorkspaceRepositoryResource } from '../workspace/repository-store.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { recordAgentEnvironmentPackageSnapshot } from './aep-snapshot-ledger.js';
import {
  resolveAgentEnvironmentPackageMetadata as resolveMetadata,
  resolveAgentEnvironmentPackage as resolvePackage,
} from './agent-environment.js';
import {
  createNanoHostHarnessRuntime,
  deriveNanoHostAgentSessionCompatibilityKey,
  dispatchNanoHostHarnessOperation,
  markNanoHostHarnessOperationUnknown,
  openNanoHostAgentSessionBinding,
  queueNanoHostHarnessOperation,
  readNanoHostMeasuredHarnessIdentity,
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
import { runSchedulerRecoveryMaintenance } from './scheduler-restart-recovery.js';
import {
  createConfiguredTurnExecutor,
  createConfiguredWorkerLifecycleRuntime,
} from './turn-executor-factory.js';
import type { PrepareAgentSessionForTurnInput } from './types.js';
import { transitionWorkerBackendSessionState } from './worker-backend-sessions.js';
import { WorkerControlGateway } from './worker-control-gateway.js';
import { recordWorkerControlAcceptedRecord } from './worker-control-records.js';
import {
  openShellFilesystemGrantsFromPackagePolicy,
  type WorkerGovernanceBackend,
  type WorkerGovernanceBackendSessionIdentity,
  WorkerGovernanceCapacityUnavailableError,
} from './worker-governance-backend.js';
import { agentSessionCompatibilityKeyFromPackage } from './worker-governance-turn-executor.js';
import {
  activateWorkerStorageAttachment,
  createWorkerStorageBinding,
  getWorkerStorageBinding,
  getWorkerStorageBindingForSandbox,
  markWorkerStorageAttachmentUnknown,
  releaseWorkerStorageAttachment,
  reserveWorkerStorageAttachment,
  workerStorageDefaultWorkSlotRef,
} from './worker-storage-bindings.js';
import { WorkspaceCollectionRecoveryCauseSchema } from './workspace-collect-wire.js';
import {
  buildWorkspaceInputSnapshots,
  buildWorkspaceMaterializationRecords,
} from './workspace-materializer.js';
import {
  acceptWorkspaceBaseline,
  authorizeWorkspaceBaselineInitialization,
  readWorkspaceSnapshotCursor,
} from './workspace-snapshot-chain.js';
import {
  getWorkspaceSyncReview,
  recordWorkspaceInputSnapshots,
  recordWorkspaceMaterializationRecords,
  recordWorkspaceSyncReview,
} from './workspace-sync-records.js';

const packageFixtureDb = createTestNativeEnvironmentDb();
function preparedInput<T extends Parameters<typeof resolveMetadata>[0]>(
  input: T
): T & { coreDb: typeof packageFixtureDb } {
  const coreDb = input.coreDb ?? packageFixtureDb;
  admitTestNativeEnvironment(coreDb, input.agentSetup.manifest);
  return { ...input, coreDb };
}
const resolveAgentEnvironmentPackage: typeof resolvePackage = (input) =>
  resolvePackage(preparedInput(input));
const resolveAgentEnvironmentPackageMetadata: typeof resolveMetadata = (input) =>
  resolveMetadata(preparedInput(input));

/** Creates the durable deployment identity required by real executor construction. */
function createFactoryCoreDb() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-turn-executor-factory-'));
  ensureLayout(dataRoot);
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  for (const adapter of ['codex', 'pi', 'opencode'])
    admitTestNativeEnvironment(coreDb, createTestAgentSetup({ adapter }).manifest);
  for (const digit of ['1', '2', '3', '4', '5', '6', '7', 'a', 'f'])
    admitTestNativeEnvironment(
      coreDb,
      createTestAgentSetup({ imageRef: `sha256:${digit.repeat(64)}` }).manifest
    );
  return coreDb;
}

const factoryCoreDb = createFactoryCoreDb();

/** Returns the fixed persistent-image facts used by NanoHost materialization fixtures. */
function nanoHostImageInspection(request: NanoHostSessionEffectRequest) {
  return {
    digest: request.input.imageDigest,
    environmentDefaults: {
      defaultsDigest: 'sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
      values: {},
    },
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

/** Inserts one active human user used by factory storage fixtures. */
function insertFactoryUser(coreDb: ReturnType<typeof createFactoryCoreDb>, userId: string): void {
  coreDb.sqlite
    .prepare(
      `INSERT OR IGNORE INTO users (
         id, display_name, email, email_verified, kind, status, created_at, updated_at
       ) VALUES (?, ?, ?, 0, 'human', 'active', 0, 0)`
    )
    .run(userId, userId, `${userId}@worker-fixture.openkit.invalid`);
}

/** Creates the current user, Workspace registry, and Thread facts required by storage admission. */
function authorizeNanoHostPackage(
  coreDb: ReturnType<typeof createFactoryCoreDb>,
  environmentPackage: AgentEnvironmentPackage,
  options: {
    readonly membership?: boolean;
    readonly ownerUserId?: string;
  } = {}
): void {
  const triggerActor = environmentPackage.scope.triggerActor;
  const userId = triggerActor.kind === 'user' ? triggerActor.id : triggerActor.responsibleUserId;
  if (!userId) throw new Error('Test package requires one responsible user.');
  const ownerUserId = options.ownerUserId ?? userId;
  insertFactoryUser(coreDb, userId);
  insertFactoryUser(coreDb, ownerUserId);
  const store = new FsStore({ dataRoot: coreDb.dataRoot });
  try {
    store.getWorkspace(environmentPackage.scope.workspaceId);
  } catch {
    const fixture = createDemoWorkspaceForUser(ownerUserId);
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
    ownerUserId,
    workspaceId: environmentPackage.scope.workspaceId,
  });
  if (
    options.membership === false &&
    coreDb.sqlite
      .prepare('SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
      .get(environmentPackage.scope.workspaceId, userId)
  ) {
    throw new Error('Nonmember fixture accidentally recorded requester membership.');
  }
}

/** Records the exact originating admission, plan, and live lease for one Worker package. */
function bindNanoHostWorkerLineage(
  coreDb: ReturnType<typeof createFactoryCoreDb>,
  environmentPackage: AgentEnvironmentPackage,
  input: {
    readonly leaseId: string;
    readonly sandboxBindingRef: string;
    readonly selectedTargetId: string;
    readonly now?: string;
    readonly planId?: string;
    readonly queueEntryId?: string;
    readonly selectedPoolId?: string;
    readonly serverAdminTokenId?: string | null;
  }
): void {
  const now = input.now ?? environmentPackage.createdAt;
  const existingAdmission = coreDb.sqlite
    .prepare(
      `SELECT queue_entry_id AS queueEntryId, status
       FROM scheduler_admission_entries
       WHERE turn_id = ? AND status IN ('queued', 'admitted')`
    )
    .get(environmentPackage.scope.turnId) as
    | { readonly queueEntryId: string; readonly status: string }
    | undefined;
  const queueEntryId =
    existingAdmission?.queueEntryId ?? input.queueEntryId ?? `queue:${input.leaseId}`;
  if (!existingAdmission) {
    createSchedulerAdmissionEntry(coreDb, {
      now: () => now,
      priorityClass: 'interactive',
      queueEntryId,
      requestedAgentId: environmentPackage.agent.agentId,
      requiredPoolConstraints: [],
      serverAdminTokenId: input.serverAdminTokenId ?? null,
      threadId: environmentPackage.scope.threadId,
      triggerActor: environmentPackage.scope.triggerActor,
      turnId: environmentPackage.scope.turnId,
      turnInput: 'Factory worker storage fixture',
      workspaceId: environmentPackage.scope.workspaceId,
    });
  }
  const planId = input.planId ?? `plan:${input.leaseId}`;
  const existingPlan = coreDb.sqlite
    .prepare('SELECT plan_id AS planId FROM scheduler_placement_plans WHERE plan_id = ?')
    .get(planId);
  if (!existingPlan && (!existingAdmission || existingAdmission.status === 'queued')) {
    createSchedulerPlacementPlan(coreDb, {
      expectedControlMode: 'poll',
      expectedDataPlaneMode: 'openshell-files',
      heartbeatIntervalMs: 10_000,
      heartbeatTimeoutMs: 30_000,
      now: () => now,
      planId,
      plannedLeaseDurationMs: 900_000,
      policyDecisionIds: [],
      queueEntryId,
      schedulerEpoch: 1,
      selectedPoolId: input.selectedPoolId ?? `pool:${input.leaseId}`,
      selectedTargetId: input.selectedTargetId,
      degradedOptionalFeatures: [],
    });
  }
  if (
    !coreDb.sqlite
      .prepare('SELECT 1 FROM scheduler_session_leases WHERE lease_id = ?')
      .get(input.leaseId)
  ) {
    createSchedulerSessionLease(coreDb, {
      agentSessionId: environmentPackage.scope.agentSessionId,
      expiresAt: '2999-01-01T00:00:00.000Z',
      heartbeatDeadline: '2999-01-01T00:00:00.000Z',
      leaseId: input.leaseId,
      now: () => now,
      packageSnapshotId: environmentPackage.snapshotId,
      planId,
      sandboxTokenBindingRef: input.sandboxBindingRef,
      startupDeadline: '2999-01-01T00:00:00.000Z',
    });
  }
}

/** Adds the already-owned pre-effect backend anchor for direct backend-unit materialization. */
function anchorNanoHostMaterialization(
  coreDb: ReturnType<typeof createFactoryCoreDb>,
  backend: WorkerGovernanceBackend,
  environmentPackage: AgentEnvironmentPackage
): void {
  const fixtureStore = new FsStore({ dataRoot: coreDb.dataRoot });
  try {
    fixtureStore.getAgentSession(environmentPackage.scope.agentSessionId);
  } catch {
    for (const prior of fixtureStore.listThreadAgentSessions(
      environmentPackage.scope.workspaceId,
      environmentPackage.scope.threadId
    ))
      if (prior.status !== 'closed')
        fixtureStore.updateAgentSession(prior.id, {
          status: 'closed',
          updatedAt: environmentPackage.createdAt,
        });
    fixtureStore.createAgentSession({
      id: environmentPackage.scope.agentSessionId,
      agentId: environmentPackage.agent.agentId,
      workspaceId: environmentPackage.scope.workspaceId,
      threadId: environmentPackage.scope.threadId,
      environmentPackageSnapshotId: environmentPackage.snapshotId,
      status: 'busy',
      message: null,
      createdAt: environmentPackage.createdAt,
      updatedAt: environmentPackage.createdAt,
    });
  }
  const workspaceDb = openWorkspaceDb(coreDb.dataRoot, environmentPackage.scope.workspaceId);
  try {
    applyScopedMigrations(workspaceDb);
    if (AgentEnvironmentPackageSchema.safeParse(environmentPackage).success)
      recordAgentEnvironmentPackageSnapshot(workspaceDb, {
        environmentPackage,
        createdAt: environmentPackage.createdAt,
      });
  } finally {
    workspaceDb.sqlite.close();
  }
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
    bindNanoHostWorkerLineage(coreDb, environmentPackage, {
      leaseId,
      now: environmentPackage.createdAt,
      sandboxBindingRef,
      selectedTargetId: identity.runtimeTargetId,
    });
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
          : {
              buildArgumentsDigest: environmentPackage.runtime.image.argumentsDigest,
              buildContextDigest: environmentPackage.runtime.image.contextDigest,
              buildInputDigest: environmentPackage.runtime.image.input.digest,
              resultingImageDigest: `sha256:${'c'.repeat(64)}`,
            }
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
    captureCoverage: { scope: 'server', value: 'off' },
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
  // These image-effect fixtures represent retained pre-environment-aware packages.
  // New-resolution and native-environment regressions use explicit admitted records.
  delete base.runtime.environment;
  const runtime = input.runtime as Partial<AgentEnvironmentPackage['runtime']> | undefined;
  const extensions = input.extensions as AgentEnvironmentPackage['extensions'] | undefined;
  const baseOpenkit = base.extensions.openkit as Record<string, unknown>;
  const inputOpenkit = extensions?.openkit as Record<string, unknown> | undefined;
  const environmentPackage = {
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
  if (!inputOpenkit || !('workerStorage' in inputOpenkit)) {
    (environmentPackage.extensions.openkit as Record<string, unknown>).workerStorage = {
      ...(baseOpenkit.workerStorage as Record<string, unknown>),
      workSlotRef: workerStorageDefaultWorkSlotRef(
        environmentPackage.scope.workspaceId,
        environmentPackage.scope.threadId
      ),
    };
  }
  // Explicitly authored fixture changes need their own canonical key; resolver-produced AEPs bypass this fixture.
  if (!inputOpenkit || !('sessionWorkspace' in inputOpenkit)) {
    (environmentPackage.extensions.openkit as Record<string, unknown>).sessionWorkspace =
      planSessionWorkspaceMaterialization({ environmentPackage });
  }
  return environmentPackage;
}

/** Seeds an already accepted retained slot as an explicit starting fact of continuity fixtures. */
function seedAcceptedRetainedSlot(
  coreDb: ReturnType<typeof createFactoryCoreDb>,
  environmentPackage: AgentEnvironmentPackage,
  storage: ReturnType<typeof createWorkerStorageBinding>,
  workSlot: string
): void {
  const db = openWorkspaceDb(coreDb.dataRoot, environmentPackage.scope.workspaceId);
  try {
    applyScopedMigrations(db);
    const identity = {
      workspaceId: environmentPackage.scope.workspaceId,
      storageRef: storage.storageRef,
      scopeDigest: storage.scopeDigest,
      attachmentGeneration: storage.attachmentGeneration,
      sandboxId: 'historical-sandbox',
      workSlot,
      collectionId: 'baseline',
      agentSessionId: environmentPackage.scope.agentSessionId,
      threadId: environmentPackage.scope.threadId,
      turnId: environmentPackage.scope.turnId,
      packageSnapshotId: environmentPackage.snapshotId,
    };
    authorizeWorkspaceBaselineInitialization(db, identity);
    const head = {
      tree: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
      manifest: 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391',
    };
    acceptWorkspaceBaseline(db, identity, head, head.tree);
  } finally {
    db.sqlite.close();
  }
}

/** Records NanoHost effects while optionally mutating authority during image.inspect. */
function createFactoryNanoHostDispatch(
  effects: NanoHostSessionEffectRequest[],
  hooks: {
    onInspect?: () => void;
    onCollection?: (request: NanoHostSessionEffectRequest) => Promise<Record<string, unknown>>;
  } = {}
): NanoHostSessionDispatch {
  return {
    async effect(requestOrConnection: object, carriedRequest?: NanoHostSessionEffectRequest) {
      const request = carriedRequest ?? (requestOrConnection as NanoHostSessionEffectRequest);
      effects.push(request);
      if (request.kind === 'image.acquire') return { digest: `sha256:${'a'.repeat(64)}` };
      if (request.kind === 'image.inspect') {
        hooks.onInspect?.();
        return nanoHostImageInspection(request);
      }
      if (request.kind === 'sandbox.create') return nanoHostSandboxCreated(request);
      if (request.kind === 'bridge.open') {
        return { accepted: true, integrationReady: true, state: 'open' };
      }
      if (request.kind === 'workspace.collect')
        return hooks.onCollection
          ? await hooks.onCollection(request)
          : request.input.mode === 'baseline'
            ? {
                requestId: request.requestId,
                outcome: 'baseline',
                head: {
                  tree: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
                  manifest: 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391',
                },
              }
            : { requestId: request.requestId, outcome: 'no_new_head', unstable: false };
      if (request.kind === 'reference.import') return { state: 'imported' };
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
}

/**
 * Materializes until storage activation aborts, leaving a created Sandbox and a reserved association.
 *
 * @param label Fixture identity suffix.
 * @param hooks Optional delete-time mutation or failure.
 * @returns The live attempt, still in `materializing`, with the activation trigger removed.
 */
async function failLivePartialSandboxActivation(
  label: string,
  hooks: {
    readonly deleteError?: Error;
    readonly duringDelete?: (
      coreDb: ReturnType<typeof createFactoryCoreDb>,
      storageRef: string
    ) => void;
  } = {}
) {
  const coreDb = createFactoryCoreDb();
  const effects: NanoHostSessionEffectRequest[] = [];
  const expectResultOnly = vi.fn(async () => {
    throw new Error('unexpected result-only recovery');
  });
  const sessionDispatch: NanoHostSessionDispatch = {
    async effect(requestOrConnection: object, carriedRequest?: NanoHostSessionEffectRequest) {
      const request = carriedRequest ?? (requestOrConnection as NanoHostSessionEffectRequest);
      effects.push(request);
      if (request.kind === 'image.acquire') return { digest: `sha256:${'a'.repeat(64)}` };
      if (request.kind === 'image.inspect') return nanoHostImageInspection(request);
      if (request.kind === 'sandbox.create') return nanoHostSandboxCreated(request);
      if (request.kind === 'sandbox.delete') {
        const storageRef = coreDb.sqlite
          .prepare(
            `SELECT storage_ref AS storageRef FROM worker_storage_bindings WHERE state = 'reserved'`
          )
          .get() as { readonly storageRef: string } | undefined;
        if (storageRef) hooks.duringDelete?.(coreDb, storageRef.storageRef);
        if (hooks.deleteError) throw hooks.deleteError;
        return { sandboxId: request.input.sandboxId, state: 'deleted' };
      }
      throw new Error(`Unexpected NanoHost effect ${request.kind}.`);
    },
    expectResultOnly,
    async poll() {
      return null;
    },
    async result() {},
    async route() {
      throw new Error('Unexpected semantic route.');
    },
  };
  const environmentPackage = completeNanoHostPackage({
    runtime: { image: { kind: 'reference', ref: 'openkit/worker:test' } },
    scope: {
      agentSessionId: `as_${label}`,
      threadId: `thread_${label}`,
      turnId: `turn_${label}`,
      workspaceId: `ws_${label}`,
    },
    snapshotId: `aepsnap_${label}`,
  });
  coreDb.sqlite
    .prepare(
      `INSERT INTO nanohost_runtime_targets (
         target_id, identity_id, deployment_id, connection_generation,
         predecessor_fenced, ready, fresh_empty, physical_epoch, observed_at, slot_count
       ) VALUES (?, ?, ?, 1, 1, 1, 1, ?, ?, 1)`
    )
    .run(
      `target_${label}`,
      `identity_${label}`,
      `deployment_${label}`,
      'a'.repeat(64),
      environmentPackage.createdAt
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
        readonly sessions: Map<string, unknown>;
      };
    }
  ).backend;
  const leaseId = `lease_${label}`;
  backend.requireLeaseId = () => leaseId;
  authorizeNanoHostPackage(coreDb, environmentPackage);
  anchorNanoHostMaterialization(coreDb, backend, environmentPackage);
  coreDb.sqlite.exec(`CREATE TEMP TRIGGER abort_${label}_activation
    BEFORE UPDATE ON worker_storage_bindings
    WHEN OLD.state = 'reserved' AND NEW.state = 'attached'
    BEGIN
      SELECT RAISE(ABORT, 'test activation write failure');
    END`);
  try {
    await expect(backend.materialize(environmentPackage, { workspaceRoots: [] })).rejects.toThrow(
      'test activation write failure'
    );
  } finally {
    coreDb.sqlite.exec(`DROP TRIGGER abort_${label}_activation`);
  }
  const reserved = coreDb.sqlite
    .prepare(
      `SELECT storage_ref AS storageRef FROM worker_storage_bindings WHERE state = 'reserved'`
    )
    .get() as { readonly storageRef: string };
  expect(getWorkerStorageBinding(coreDb, { storageRef: reserved.storageRef })).toMatchObject({
    currentSandboxBindingRef: null,
    state: 'reserved',
  });
  expect(backend.sessions.has(environmentPackage.snapshotId)).toBe(false);
  expect(
    coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM sandbox_runtime_records').get()
  ).toEqual({ count: 0 });
  expect(effects.map((effect) => effect.kind)).toEqual([
    'image.acquire',
    'image.inspect',
    'sandbox.create',
  ]);
  return {
    backend,
    coreDb,
    effects,
    environmentPackage,
    expectResultOnly,
    identity: backend.planSession(environmentPackage),
    leaseId,
    runtime,
    storageRef: reserved.storageRef,
  };
}

/** Reports whether this process still holds live partial-create proof for one package snapshot. */
function retainsLivePartialMaterialization(backend: object, packageSnapshotId: string): boolean {
  return (
    backend as unknown as {
      readonly livePartialMaterializations: ReadonlyMap<string, unknown>;
    }
  ).livePartialMaterializations.has(packageSnapshotId);
}

/** Builds one nonmember server-admin AEP with live admission, plan, and lease records. */
function prepareNonmemberAdminWorkerStorage(label: string) {
  const coreDb = createFactoryCoreDb();
  const effects: NanoHostSessionEffectRequest[] = [];
  const hooks: { onInspect?: () => void } = {};
  const adminUserId = 'user_storage_admin';
  const ownerUserId = 'user_storage_owner';
  const tokenId = `token_${label}`;
  const workspaceId = `workspace_${label}`;
  const environmentPackage = completeNanoHostPackage({
    scope: {
      agentSessionId: `as_${label}`,
      threadId: `thread_${label}`,
      turnId: `turn_${label}`,
      triggerActor: { kind: 'user', id: adminUserId },
      workspaceId,
    },
    snapshotId: `aepsnap_${label}`,
  });
  coreDb.sqlite
    .prepare(
      `INSERT INTO nanohost_runtime_targets (
         target_id, identity_id, deployment_id, connection_generation,
         predecessor_fenced, ready, fresh_empty, physical_epoch, observed_at, slot_count
       ) VALUES (?, ?, ?, 1, 1, 1, 1, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', ?, 1)`
    )
    .run(
      `target_${label}`,
      `identity_${label}`,
      `deployment_${label}`,
      environmentPackage.createdAt
    );
  authorizeNanoHostPackage(coreDb, environmentPackage, {
    membership: false,
    ownerUserId,
  });
  createOpenKitAccessTokenRecord(coreDb, {
    expiresAt: '2099-01-01T00:00:00.000Z',
    ownerUserId: adminUserId,
    scope: 'server-admin',
    tokenId,
    workspaceIds: [],
  });
  bindNanoHostWorkerLineage(coreDb, environmentPackage, {
    leaseId: `lease_${label}`,
    now: environmentPackage.createdAt,
    planId: `plan_${label}`,
    sandboxBindingRef: `lease-binding:${label}`,
    selectedPoolId: `pool_${label}`,
    selectedTargetId: `target_${label}`,
    serverAdminTokenId: tokenId,
  });
  const runtime = createConfiguredWorkerLifecycleRuntime({
    coreDb,
    env: {},
    nanoHostSessionDispatch: createFactoryNanoHostDispatch(effects, hooks),
    workerControlGateway: new WorkerControlGateway(),
  });
  const backend = (runtime.turnExecutor as unknown as { readonly backend: WorkerGovernanceBackend })
    .backend;
  anchorNanoHostMaterialization(coreDb, backend, environmentPackage);
  return {
    adminUserId,
    backend,
    coreDb,
    effects,
    environmentPackage,
    hooks,
    ownerUserId,
    runtime,
    tokenId,
    workspaceId,
  };
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
    expect(referenceImport).toBeLessThan(launchSource?.indexOf("'session.open'") ?? -1);
    expect(referenceImport).toBeLessThan(launchSource?.indexOf("'session.inspect'") ?? -1);
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
    for (const collectionSource of [transcriptSource]) {
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

  it.each([
    {
      cleanupFailed: false,
      dispatched: false,
      expected: 'NanoHost Harness harness.drain result outage budget expired: never-dispatched.',
      label: 'never-polled',
    },
    {
      cleanupFailed: false,
      dispatched: true,
      expected:
        'NanoHost Harness harness.drain result outage budget expired: dispatched-awaiting-result.',
      label: 'dispatched no-result',
    },
    {
      cleanupFailed: true,
      dispatched: false,
      expected: 'NanoHost Harness harness.drain result outage cleanup failed: never-dispatched.',
      label: 'never-polled cleanup-failure',
    },
    {
      cleanupFailed: true,
      dispatched: true,
      expected:
        'NanoHost Harness harness.drain result outage cleanup failed: dispatched-awaiting-result.',
      label: 'dispatched no-result cleanup-failure',
    },
  ] as const)('rejects and fences a $label Harness operation from its enqueue deadline', async ({
    cleanupFailed,
    dispatched,
    expected,
  }) => {
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
      const session: {
        harnessBindingRef: string;
        harnessInstanceId: string;
        pendingHarnessOperation: { operationId: string | null } | null;
      } = {
        harnessBindingRef: 'harness-binding-never-polled',
        harnessInstanceId: 'harness-never-polled',
        pendingHarnessOperation: null,
      };
      const pending = backend.queueAndWaitForHarnessOperation(session, 'harness.drain', {});
      void pending.catch(() => undefined);
      if (dispatched) {
        const command = dispatchNanoHostHarnessOperation(coreDb, {
          sandboxIntegrationBindingRef: 'integration-never-polled',
        });
        if (!command || !session.pendingHarnessOperation) {
          throw new Error('Expected a dispatched harness.drain command.');
        }
        session.pendingHarnessOperation.operationId = command.operationId;
      }
      if (cleanupFailed) {
        coreDb.sqlite
          .prepare('DELETE FROM harness_instance_records WHERE harness_instance_id = ?')
          .run('harness-never-polled');
      }
      await vi.advanceTimersByTimeAsync(300_000);
      await expect(pending).rejects.toMatchObject({ message: expected });
      if (cleanupFailed) {
        return;
      }
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

  it('does not prove restored binding reuse from SessionCompatibilityKey alone', async () => {
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
      attachNanoHostStorageFixture(coreDb, {
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
          resume: null,
          threadId: 'thread-continuity-key',
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

      await expect(backend.prepareAgentSessionContinuity?.(input)).resolves.toBe(
        'replacement-required'
      );
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
      ).resolves.toBe('replacement-required');
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

  /**
   * Leaves one completed Turn's binding idle and process-local, with its ready digest recorded.
   *
   * @param label Fixture suffix.
   * @returns The resident package and the backend that still owns its Harness.
   */
  async function admitIdleSupplyResident(
    label: string,
    options: {
      nativeValues?: Record<string, string>;
      inspection?: 'unavailable' | 'stale';
      effects?: NanoHostSessionEffectRequest[];
      vaultBackend?: () => VaultBackend;
      configurePackage?: (
        environmentPackage: AgentEnvironmentPackage,
        coreDb: ReturnType<typeof createFactoryCoreDb>
      ) => void;
      onCollection?: (request: NanoHostSessionEffectRequest) => Promise<Record<string, unknown>>;
      beforeFirstTurn?: (input: {
        coreDb: ReturnType<typeof createFactoryCoreDb>;
        environmentPackage: AgentEnvironmentPackage;
        integrationRef: string;
        effects: NanoHostSessionEffectRequest[];
      }) => Promise<void>;
    } = {}
  ) {
    const coreDb = createFactoryCoreDb();
    const effects: NanoHostSessionEffectRequest[] = options.effects ?? [];
    const sessionDispatch = createFactoryNanoHostDispatch(
      effects,
      options.onCollection ? { onCollection: options.onCollection } : {}
    );
    const nativeValues = options.nativeValues;
    const effect = sessionDispatch.effect.bind(sessionDispatch);
    if (options.inspection)
      sessionDispatch.effect = async (...args) => {
        const result = await effect(...args);
        const request = (args[1] ?? args[0]) as NanoHostSessionEffectRequest;
        if (request.kind !== 'image.inspect') return result;
        const inspection = result as Record<string, unknown>;
        if (options.inspection === 'unavailable') {
          const { environmentDefaults: _defaults, ...rest } = inspection;
          return rest;
        }
        const values = { CHANGED: 'literal' };
        return {
          ...inspection,
          environmentDefaults: {
            values,
            defaultsDigest: `sha256:${createHash('sha256').update(JSON.stringify(values)).digest('hex')}`,
          },
        };
      };
    const readyDigest = 'a'.repeat(64);
    const workspaceId = `workspace_${label}`;
    const threadId = `thread_${label}`;
    const agentSessionId = `as_${label}`;
    coreDb.sqlite
      .prepare(
        `INSERT INTO nanohost_runtime_targets (
           target_id, identity_id, deployment_id, connection_generation,
           predecessor_fenced, ready, fresh_empty, physical_epoch, observed_at, slot_count
         ) VALUES (?, ?, ?, 1, 1, 1, 1, ?, ?, 1)`
      )
      .run(
        `target_${label}`,
        `identity_${label}`,
        `deployment_${label}`,
        'a'.repeat(64),
        '2026-09-06T00:00:00.000Z'
      );
    const runtime = createConfiguredWorkerLifecycleRuntime({
      coreDb,
      ...(options.vaultBackend ? { vaultBackend: options.vaultBackend } : {}),
      env: {},
      nanoHostSessionDispatch: sessionDispatch,
      workerControlGateway: new WorkerControlGateway(),
    });
    const backend = (
      runtime.turnExecutor as unknown as {
        readonly backend: WorkerGovernanceBackend & {
          bindNativeHandleRecorder(snapshotId: string, recorder: (digest: string) => void): void;
          inspectTerminalHarnessSession(session: unknown): Promise<void>;
          readonly sessions: Map<string, unknown>;
        };
      }
    ).backend;
    const environmentPackage = completeNanoHostPackage({
      ...(nativeValues
        ? {
            runtime: {
              image: {
                kind: 'build',
                arguments: {},
                argumentsDigest: `sha256:${createHash('sha256').update('{}').digest('hex')}`,
                contextRef: 'build-context://empty/v1',
                contextDigest: `sha256:${createHash('sha256').update('').digest('hex')}`,
                input: {
                  kind: 'dockerfile',
                  content: 'FROM scratch\n',
                  digest: `sha256:${createHash('sha256').update('FROM scratch\n').digest('hex')}`,
                },
                egress: [{ host: 'example.com', port: 443 }],
                layerLimit: 128,
                outputLimitBytes: 1024 * 1024,
                timeLimitSeconds: 60,
              },
              environment: {
                imageDigest: `sha256:${'a'.repeat(64)}`,
                defaultsDigest:
                  'sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
                values: nativeValues,
              },
            },
          }
        : {}),
      extensions: {
        openkit: {
          workerStorage: {
            workSlotRef: workerStorageDefaultWorkSlotRef(workspaceId, threadId),
          },
        },
      },
      scope: {
        agentSessionId,
        threadId,
        turnId: `turn_${label}`,
        workspaceId,
      },
      snapshotId: `snapshot_${label}`,
    });
    authorizeNanoHostPackage(coreDb, environmentPackage);
    options.configurePackage?.(environmentPackage, coreDb);
    bindNanoHostWorkerLineage(coreDb, environmentPackage, {
      leaseId: `lease_${label}`,
      now: '2026-09-06T00:00:00.000Z',
      planId: `plan_${label}`,
      sandboxBindingRef: `sandbox-binding:${label}`,
      selectedPoolId: `pool_${label}`,
      selectedTargetId: `target_${label}`,
    });
    anchorNanoHostMaterialization(coreDb, backend, environmentPackage);
    const materialization = await backend
      .materialize(environmentPackage, { workspaceRoots: [] })
      .catch((error) => {
        coreDb.sqlite.close();
        throw error;
      });
    const recordedDigests: string[] = [];
    backend.bindNativeHandleRecorder(environmentPackage.snapshotId, (digest) => {
      recordedDigests.push(digest);
    });
    const integrationRef = () =>
      (
        coreDb.sqlite
          .prepare(
            `SELECT sandbox_integration_binding_ref AS integrationRef
             FROM sandbox_runtime_records ORDER BY created_at LIMIT 1`
          )
          .get() as { readonly integrationRef: string }
      ).integrationRef;
    const settleNext = async (
      operation: 'session.open' | 'turn.start' | 'session.inspect' | 'session.close',
      body: Readonly<Record<string, unknown>>
    ) => {
      let command: ReturnType<typeof dispatchNanoHostHarnessOperation> = null;
      for (let attempt = 0; attempt < 200 && !command; attempt += 1) {
        command = dispatchNanoHostHarnessOperation(coreDb, {
          sandboxIntegrationBindingRef: integrationRef(),
        });
        if (!command) await new Promise<void>((resolve) => setTimeout(resolve, 1));
      }
      if (!command || command.operation !== operation) {
        throw new Error(
          `Expected queued ${operation} Harness command, received ${command?.operation ?? 'none'}.`
        );
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
        sandboxIntegrationBindingRef: integrationRef(),
        timestamp: '2026-09-06T00:00:01.000Z',
      });
      runtime.acceptNanoHostHarnessResult(result);
      return command;
    };
    const launch = backend.launch(materialization);
    const initialOpen = await settleNext('session.open', {
      maxActiveTurns: 1,
      nativeHandleDigest: null,
      nativeHandleState: 'pending',
      state: 'open',
    });
    if (options.nativeValues)
      expect(initialOpen.body.nativeEnvironment).toEqual(options.nativeValues);
    await options.beforeFirstTurn?.({
      coreDb,
      environmentPackage,
      integrationRef: integrationRef(),
      effects,
    });
    await Promise.race([
      settleNext('turn.start', {
        nativeHandleDigest: null,
        nativeHandleState: 'pending',
        state: 'started',
      }),
      launch,
    ]);
    await launch;
    recordWorkerControlAcceptedRecord(coreDb, {
      acceptedAt: '2026-09-06T00:00:01.000Z',
      lineage: {
        ...environmentPackage.scope,
        packageSnapshotId: environmentPackage.snapshotId,
      },
      operation: 'final_status',
      record: { sequence: 1, status: 'completed', stopReason: 'completed' },
      recordKey: '1',
      sequence: 1,
    });
    const inspection = backend.inspectTerminalHarnessSession(
      backend.sessions.get(environmentPackage.snapshotId)
    );
    await settleNext('session.inspect', {
      childState: 'running',
      cleanupState: 'clean',
      nativeHandleDigest: readyDigest,
      nativeHandleState: 'ready',
      state: 'open',
    });
    await inspection;
    expect(recordedDigests).toEqual([readyDigest]);
    const capturedSession = backend.sessions.get(environmentPackage.snapshotId);
    await backend.cleanupSession(backend.planSession(environmentPackage));
    coreDb.sqlite
      .prepare(`UPDATE scheduler_session_leases SET status = 'released' WHERE lease_id = ?`)
      .run(`lease_${label}`);
    expect(
      coreDb.sqlite
        .prepare(
          `SELECT agent_session_id AS agentSessionId, native_handle_digest AS digest
           FROM agent_session_runtime_bindings`
        )
        .all()
    ).toEqual([{ agentSessionId, digest: readyDigest }]);
    return {
      backend,
      coreDb,
      environmentPackage,
      readyDigest,
      settleNext,
      session: capturedSession,
      effects,
    };
  }

  it('waits for source-less baseline completion and its durable pair before dispatching the first Turn', async () => {
    let finish!: (result: Record<string, unknown>) => void;
    let arrived!: () => void;
    const entered = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const baseline = new Promise<Record<string, unknown>>((resolve) => {
      finish = resolve;
    });
    const f = await admitIdleSupplyResident('baseline_gate', {
      nativeValues: { HELLO_NATIVE: 'hello', EMPTY_NATIVE: '' },
      onCollection: async (request) => {
        expect(request.input).toMatchObject({
          mode: 'baseline',
          acceptedBase: null,
          previousHead: null,
        });
        arrived();
        return await baseline;
      },
      beforeFirstTurn: async ({ coreDb, environmentPackage, integrationRef, effects }) => {
        await entered;
        expect(
          dispatchNanoHostHarnessOperation(coreDb, { sandboxIntegrationBindingRef: integrationRef })
        ).toBeNull();
        expect(
          effects.filter((effect) => effect.kind === 'reference.import').length
        ).toBeGreaterThan(0);
        const db = openWorkspaceDb(coreDb.dataRoot, environmentPackage.scope.workspaceId);
        try {
          expect(
            db.sqlite
              .prepare('SELECT accepted_base_json, head_json FROM workspace_snapshot_cursors')
              .get()
          ).toEqual({ accepted_base_json: null, head_json: null });
        } finally {
          db.sqlite.close();
        }
        finish({
          outcome: 'baseline',
          head: {
            tree: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
            manifest: 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391',
          },
        });
      },
    });
    try {
      const db = openWorkspaceDb(f.coreDb.dataRoot, f.environmentPackage.scope.workspaceId);
      try {
        const row = db.sqlite
          .prepare('SELECT accepted_base_json, head_json FROM workspace_snapshot_cursors')
          .get() as { accepted_base_json: string; head_json: string };
        expect(JSON.parse(row.accepted_base_json)).toEqual({
          tree: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
          manifest: 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391',
        });
        expect(row.head_json).toBe(row.accepted_base_json);
      } finally {
        db.sqlite.close();
      }
    } finally {
      f.coreDb.sqlite.close();
    }
  });
  it.skipIf(process.platform === 'win32')(
    'accepts a different-owner linked baseline before dispatching the first Turn without trusting a sibling',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'openkit-baseline-owner-'));
      const repositoryPath = join(root, 'repository');
      const linkedPath = join(root, 'linked');
      const siblingPath = join(root, 'sibling');
      const wrapperPath = join(root, 'bin');
      const probePath = join(root, 'blocked-sibling');
      const gitBinary = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
      const git = (cwd: string, ...args: string[]) =>
        execFileSync(gitBinary, ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
      const savedPath = process.env.PATH;
      try {
        for (const path of [repositoryPath, siblingPath]) {
          mkdirSync(path);
          git(path, 'init', '--object-format=sha1');
          git(
            path,
            '-c',
            'user.name=Fixture',
            '-c',
            'user.email=fixture@example.invalid',
            'commit',
            '--allow-empty',
            '-m',
            'initial'
          );
        }
        symlinkSync(repositoryPath, linkedPath, 'dir');
        const commit = git(repositoryPath, 'rev-parse', 'HEAD');
        const tree = git(repositoryPath, 'rev-parse', `${commit}^{tree}`);
        mkdirSync(wrapperPath);
        const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
        writeFileSync(
          join(wrapperPath, 'git'),
          `#!/bin/sh\nif GIT_TEST_ASSUME_DIFFERENT_OWNER=1 ${quote(gitBinary)} -C ${quote(siblingPath)} rev-parse HEAD >/dev/null 2>&1; then echo 'Unexpected trust of sibling repository' >&2; exit 70; fi\necho blocked >> ${quote(probePath)}\nGIT_TEST_ASSUME_DIFFERENT_OWNER=1 exec ${quote(gitBinary)} "$@"\n`,
          { mode: 0o755 }
        );
        process.env.PATH = `${wrapperPath}${delimiter}${savedPath ?? ''}`;
        const f = await admitIdleSupplyResident('baseline_owner', {
          configurePackage: (env, coreDb) => {
            env.workspace.inputs = [
              {
                id: 'repo',
                kind: 'repository',
                access: 'read-write',
                target: `/workspace/worktrees/${workerStorageDefaultWorkSlotRef(env.scope.workspaceId, env.scope.threadId)}`,
                source: {
                  kind: 'git',
                  sourceId: 'source-repo',
                  url: 'https://example.invalid/repository.git',
                  commit,
                },
              },
            ];
            (env.extensions.openkit as Record<string, unknown>).sessionWorkspace =
              planSessionWorkspaceMaterialization({ environmentPackage: env });
            const db = openWorkspaceDb(coreDb.dataRoot, env.scope.workspaceId);
            try {
              applyScopedMigrations(db);
              upsertWorkspaceRepositoryResource(db, {
                workspaceId: env.scope.workspaceId,
                resourceId: 'repo',
                displayName: 'Linked source',
                localPath: linkedPath,
                workspaceExists: () => true,
              });
            } finally {
              db.sqlite.close();
            }
          },
          onCollection: async () => ({
            outcome: 'baseline',
            head: { tree, manifest: '2'.repeat(40) },
          }),
        });
        try {
          const db = openWorkspaceDb(f.coreDb.dataRoot, f.environmentPackage.scope.workspaceId);
          try {
            const row = db.sqlite
              .prepare('SELECT accepted_base_json, head_json FROM workspace_snapshot_cursors')
              .get() as { accepted_base_json: string; head_json: string };
            expect(JSON.parse(row.accepted_base_json)).toEqual({ tree, manifest: '2'.repeat(40) });
            expect(row.head_json).toBe(row.accepted_base_json);
          } finally {
            db.sqlite.close();
          }
          // The fixture settles turn.start only after observing its queued native command.
          expect(readFileSync(probePath, 'utf8').trim().split('\n')).toEqual([
            'blocked',
            'blocked',
          ]);
        } finally {
          f.coreDb.sqlite.close();
        }
      } finally {
        if (savedPath === undefined) delete process.env.PATH;
        else process.env.PATH = savedPath;
        rmSync(root, { recursive: true, force: true });
      }
    }
  );
  it('derives the baseline from the exact Core commit rather than HEAD or dirty bytes and refuses unavailable sources', async () => {
    let measuredTree = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
    const f = await admitIdleSupplyResident('expected_tree', {
      onCollection: async () => ({
        outcome: 'baseline',
        head: { tree: measuredTree, manifest: '2'.repeat(40) },
      }),
    });
    const repositoryPath = mkdtempSync(join(tmpdir(), 'n6-expected-source-'));
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', repositoryPath, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    git('init', '--object-format=sha1');
    git('config', 'user.email', 'fixture@example.invalid');
    git('config', 'user.name', 'Fixture');
    writeFileSync(join(repositoryPath, 'file.txt'), 'accepted source');
    git('add', '.');
    git('commit', '-m', 'accepted');
    const commit = git('rev-parse', 'HEAD');
    measuredTree = git('rev-parse', `${commit}^{tree}`);
    writeFileSync(join(repositoryPath, 'file.txt'), 'later commit');
    git('add', '.');
    git('commit', '-m', 'later');
    writeFileSync(join(repositoryPath, 'file.txt'), 'dirty current bytes');
    const collector = f.backend as unknown as {
      ensureWorkspaceBaseline(session: unknown, opensNewBinding: boolean): Promise<void>;
      workspaceCollectionIdentity(
        session: unknown,
        id: string
      ): import('./workspace-snapshot-chain.js').WorkspaceCollectionIdentity;
    };
    const real = f.session as { environmentPackage: AgentEnvironmentPackage };
    const session = {
      ...real,
      environmentPackage: {
        ...real.environmentPackage,
        workspace: {
          ...real.environmentPackage.workspace,
          inputs: [
            {
              id: 'repo',
              access: 'read-write',
              source: { kind: 'git', commit, url: 'https://example.invalid/repository.git' },
            },
          ],
        },
      },
    };
    const db = openWorkspaceDb(f.coreDb.dataRoot, f.environmentPackage.scope.workspaceId);
    const initialize = () => {
      db.sqlite.exec(
        'DELETE FROM workspace_snapshot_collections; DELETE FROM workspace_snapshot_cursors;'
      );
      authorizeWorkspaceBaselineInitialization(
        db,
        collector.workspaceCollectionIdentity(session, 'baseline')
      );
    };
    try {
      upsertWorkspaceRepositoryResource(db, {
        workspaceId: f.environmentPackage.scope.workspaceId,
        resourceId: 'repo',
        displayName: 'Initial source',
        localPath: repositoryPath,
        workspaceExists: () => true,
      });
      initialize();
      await collector.ensureWorkspaceBaseline(session, true);
      expect(
        readWorkspaceSnapshotCursor(db, collector.workspaceCollectionIdentity(session, 'baseline'))
          ?.acceptedBase.tree
      ).toBe(measuredTree);
      expect(git('rev-parse', 'HEAD')).not.toBe(commit);
      expect(readFileSync(join(repositoryPath, 'file.txt'), 'utf8')).toBe('dirty current bytes');
      for (const source of [
        { kind: 'git', commit: 'f'.repeat(40) },
        { kind: 'git', commit: 'f'.repeat(64) },
        { kind: 'filesystem', commit },
      ]) {
        initialize();
        const invalid = {
          ...session,
          environmentPackage: {
            ...session.environmentPackage,
            workspace: {
              ...session.environmentPackage.workspace,
              inputs: [{ ...session.environmentPackage.workspace.inputs[0], source }],
            },
          },
        };
        const scans = f.effects.filter((effect) => effect.kind === 'workspace.collect').length;
        await expect(collector.ensureWorkspaceBaseline(invalid, true)).rejects.toThrow(
          'baseline_source_unavailable'
        );
        expect(f.effects.filter((effect) => effect.kind === 'workspace.collect').length).toBe(
          scans
        );
      }
      initialize();
      measuredTree = 'e'.repeat(40);
      await expect(collector.ensureWorkspaceBaseline(session, true)).rejects.toThrow(
        'baseline_mismatch'
      );
      expect(
        readWorkspaceSnapshotCursor(db, collector.workspaceCollectionIdentity(session, 'baseline'))
      ).toBeNull();
    } finally {
      db.sqlite.close();
      f.coreDb.sqlite.close();
    }
  });
  it.each([
    'turn-end',
    'release',
    'successor',
  ] as const)('waits for %s collection before allowing its lifecycle transition', async (boundary) => {
    let finish!: (result: Record<string, unknown>) => void;
    let arrived!: () => void;
    const entered = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const capture = new Promise<Record<string, unknown>>((resolve) => {
      finish = resolve;
    });
    const f = await admitIdleSupplyResident(`capture_${boundary}`, {
      onCollection: async (request) => {
        if (request.input.mode === 'baseline')
          return {
            outcome: 'baseline',
            head: { tree: '4b825dc642cb6eb9a060e54bf8d69288fbee4904', manifest: '2'.repeat(40) },
          };
        expect(request.input.mode).toBe('capture');
        arrived();
        return await capture;
      },
    });
    const backend = f.backend as typeof f.backend & { readonly sessions: Map<string, unknown> };
    const session = f.session as { nativeSessionReusable: boolean };
    backend.sessions.set(f.environmentPackage.snapshotId, session);
    let settled = false;
    try {
      const operation =
        boundary === 'turn-end'
          ? backend.collectWorkspaceChanges!(f.environmentPackage.snapshotId, true)
          : boundary === 'release'
            ? backend.cleanupSession(backend.planSession(f.environmentPackage), {
                failedCloseout: true,
              })
            : backend.prepareAgentSessionContinuity!({
                agentSessionCompatibilityKey: sessionCompatibilityDigest(f.environmentPackage),
                agentSessionId: f.environmentPackage.scope.agentSessionId,
                environmentPackage: f.environmentPackage,
                reuseAllowed: false,
                threadId: f.environmentPackage.scope.threadId,
                workspaceId: f.environmentPackage.scope.workspaceId,
              });
      void operation.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        }
      );
      await entered;
      expect(settled).toBe(false);
      const integration = f.coreDb.sqlite
        .prepare('SELECT sandbox_integration_binding_ref AS ref FROM sandbox_runtime_records')
        .get() as { ref: string };
      expect(
        dispatchNanoHostHarnessOperation(f.coreDb, {
          sandboxIntegrationBindingRef: integration.ref,
        })
      ).toBeNull();
      finish({ outcome: 'no_new_head', unstable: false });
      if (boundary !== 'turn-end')
        await f.settleNext('session.close', { state: 'closed', privateState: 'absent' });
      await operation;
      expect(settled).toBe(true);
      expect(
        f.effects.filter(
          (effect) => effect.kind === 'workspace.collect' && effect.input.mode === 'baseline'
        )
      ).toHaveLength(1);
    } finally {
      f.coreDb.sqlite.close();
    }
  });
  it.each([
    { destination: false, format: 'text' },
    { destination: true, format: 'text' },
    { destination: true, format: 'binary' },
    { destination: true, format: 'invalid-utf8' },
  ])('retains exact cumulative candidate bytes with destination=$destination format=$format and independent review head', async ({
    destination,
    format,
  }) => {
    const repositoryPath = mkdtempSync(join(tmpdir(), 'n6-review-destination-'));
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', repositoryPath, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    git('init');
    git('config', 'user.email', 'fixture@example.invalid');
    git('config', 'user.name', 'Fixture');
    writeFileSync(
      join(repositoryPath, 'file.txt'),
      format === 'binary'
        ? Buffer.from([97, 0, 10])
        : format === 'invalid-utf8'
          ? Buffer.from([97, 255, 10])
          : 'base\n'
    );
    git('add', '.');
    git('commit', '-m', 'base');
    const commit = git('rev-parse', 'HEAD');
    const expectedTree = destination
      ? git('rev-parse', 'HEAD^{tree}')
      : '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
    writeFileSync(
      join(repositoryPath, 'file.txt'),
      format === 'binary'
        ? Buffer.from([98, 0, 10])
        : format === 'invalid-utf8'
          ? Buffer.from([98, 255, 10])
          : 'base\nfirst\n'
    );
    let bytes = execFileSync('git', [
      '-C',
      repositoryPath,
      'diff',
      '--binary',
      '--full-index',
      '--no-renames',
    ]);
    git('restore', '.');
    let serial = 1;
    let captureEmpty = false;
    const f = await admitIdleSupplyResident(`candidate_${destination}_${format}`, {
      ...(destination
        ? {
            configurePackage: (
              env: AgentEnvironmentPackage,
              coreDb: ReturnType<typeof createFactoryCoreDb>
            ) => {
              env.workspace.inputs = [
                {
                  id: 'repo',
                  kind: 'repository',
                  access: 'read-write',
                  target: `/workspace/worktrees/${workerStorageDefaultWorkSlotRef(env.scope.workspaceId, env.scope.threadId)}`,
                  source: {
                    kind: 'git',
                    sourceId: 'source-repo',
                    url: 'https://example.invalid/repository.git',
                    commit,
                  },
                },
              ];
              (env.extensions.openkit as Record<string, unknown>).sessionWorkspace =
                planSessionWorkspaceMaterialization({ environmentPackage: env });
              const db = openWorkspaceDb(coreDb.dataRoot, env.scope.workspaceId);
              applyScopedMigrations(db);
              try {
                upsertWorkspaceRepositoryResource(db, {
                  workspaceId: env.scope.workspaceId,
                  resourceId: 'repo',
                  displayName: 'Existing destination',
                  localPath: repositoryPath,
                  workspaceExists: () => true,
                });
              } finally {
                db.sqlite.close();
              }
            },
          }
        : {}),
      onCollection: async (request) => {
        if (request.input.mode === 'baseline')
          return { outcome: 'baseline', head: { tree: expectedTree, manifest: '2'.repeat(40) } };
        if (captureEmpty)
          return {
            outcome: 'empty',
            head: request.input.acceptedBase,
            previousHead: request.input.previousHead,
            acceptedBase: request.input.acceptedBase,
            unstable: false,
          };
        const stagingPath = join(
          mkdtempSync(join(tmpdir(), 'openkit-nanocore-file-export-')),
          'complete'
        );
        writeFileSync(stagingPath, bytes);
        serial += 1;
        return {
          outcome: 'candidate',
          head: { tree: String(serial + 1).repeat(40), manifest: String(serial + 2).repeat(40) },
          previousHead: request.input.previousHead,
          acceptedBase: request.input.acceptedBase,
          unstable: false,
          byteLength: bytes.length,
          sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
          stagingPath,
        };
      },
    });
    const collector = f.backend as unknown as {
      collectWorkspaceSnapshot(
        session: unknown,
        boundary: 'turn-end' | 'release' | 'successor'
      ): Promise<import('./worker-governance-backend.js').WorkerGovernanceWorkspaceChangeRecord[]>;
      setWorkspaceCollectionPublisher(publisher: (...args: unknown[]) => Promise<void>): void;
    };
    const published = vi.fn(async () => {});
    collector.setWorkspaceCollectionPublisher(published);
    const db = openWorkspaceDb(f.coreDb.dataRoot, f.environmentPackage.scope.workspaceId);
    try {
      const firstCollection = collector.collectWorkspaceSnapshot(f.session, 'turn-end');
      await expect(firstCollection).resolves.toHaveLength(destination ? 1 : 0);
      const first = await firstCollection;
      const row = db.sqlite
        .prepare('SELECT candidate, result_json FROM workspace_snapshot_collections')
        .get() as { candidate: Buffer; result_json: string };
      expect(row.candidate).toEqual(bytes);
      expect(JSON.parse(row.result_json)).toMatchObject({
        credentialCheck: 'passed',
        head: { tree: '3'.repeat(40), manifest: '4'.repeat(40) },
      });
      const scans = f.effects.length;
      expect(await collector.collectWorkspaceSnapshot(f.session, 'turn-end')).toEqual(first);
      expect(f.effects).toHaveLength(scans);
      if (destination) {
        expect(first[0]!.changeSet.base.commit).toBe(commit);
        expect(first[0]!.changeSet.createdAt).toBe(JSON.parse(row.result_json).collectedAt);
        expect(first[0]!.changeSet.createdAt).not.toBe(f.environmentPackage.createdAt);
        expect(first[0]!.changeSet.head.commit).toBeNull();
        const inputs = recordWorkspaceInputSnapshots(
          db,
          buildWorkspaceInputSnapshots({
            backendKind: 'openshell',
            backendCapabilities: [],
            createdAt: f.environmentPackage.createdAt,
            environmentPackage: f.environmentPackage,
          })
        );
        recordWorkspaceMaterializationRecords(
          db,
          buildWorkspaceMaterializationRecords({
            createdAt: f.environmentPackage.createdAt,
            inputSnapshots: inputs,
            materialization: {
              backendKind: 'openshell',
              packageSnapshotId: f.environmentPackage.snapshotId,
              requiredCapabilities: [],
              workspaceInputs: f.environmentPackage.workspace.inputs.map((input) => ({
                id: input.id,
                target: input.target!,
              })),
            },
          })
        );
        recordWorkspaceSyncReview(db, {
          item: {
            changeSet: first[0]!.changeSet,
            patchPayload: first[0]!.patchPayload,
            review: first[0]!.review,
            artifactId: `ar_${format}`,
          },
        });
        const stored = getWorkspaceSyncReview(
          db,
          f.environmentPackage.scope.workspaceId,
          first[0]!.review.id
        )!;
        if (format === 'binary') {
          expect(stored.changeSet.changedPaths[0]!.binaryReview).toMatchObject({
            mode: 'artifact-only',
            digest: stored.changeSet.patch!.digest,
            bytes: bytes.length,
            mediaType: 'application/octet-stream',
          });
          expect(stored.changeSet.changedPaths[0]!.binaryReview!.summary).toContain(
            'candidate artifact'
          );
          expect(stored.review.validation).toContainEqual({
            command: 'workspace.binary_artifact_only',
            ref: 'workspace-path:file.txt',
            status: 'skipped',
          });
          expect(stored.review.validation).toContainEqual({
            command: 'workspace-snapshot-apply',
            ref: null,
            status: 'failed',
          });
          expect(stored.review.staging.branch).toBeNull();
        } else expect(stored.review.staging.branch).not.toBeNull();

        first[0]!.changeSet.head.commit = 'd'.repeat(40);
        const retained = db.sqlite
          .prepare('SELECT head_json AS head FROM workspace_snapshot_cursors')
          .get() as { head: string };
        expect(JSON.parse(retained.head)).toEqual({
          tree: '3'.repeat(40),
          manifest: '4'.repeat(40),
        });
      }
      bytes = Buffer.from('openkit-full-mode-delta\n0644 0600 8 file.txt\n');
      const unsupported = await collector.collectWorkspaceSnapshot(f.session, 'release');
      if (destination) {
        expect(unsupported[0]!.changeSet.base.commit).toBe(commit);
        expect(unsupported[0]!.review.staging.branch).toBeNull();
        expect(unsupported[0]!.review.validation).toContainEqual({
          command: 'workspace-snapshot-apply',
          status: 'failed',
          ref: null,
        });
        expect(published).toHaveBeenCalledOnce();
      } else expect(unsupported).toEqual([]);
      const cursor = db.sqlite
        .prepare('SELECT head_json AS head FROM workspace_snapshot_cursors')
        .get() as { head: string };
      expect(JSON.parse(cursor.head)).toEqual({ tree: '4'.repeat(40), manifest: '5'.repeat(40) });
      captureEmpty = true;
      await expect(collector.collectWorkspaceSnapshot(f.session, 'successor')).resolves.toEqual([]);
      const manifests = db.sqlite
        .prepare('SELECT payload_json FROM worker_output_manifests')
        .all() as { payload_json: string }[];
      expect(manifests).toHaveLength(destination ? 2 : 0);
      if (destination)
        expect(
          manifests
            .map((row) => JSON.parse(row.payload_json))
            .find((manifest) => manifest.changedPaths.length === 0)
        ).toMatchObject({
          changedPaths: [],
          inputSnapshotId: `wis_${f.environmentPackage.snapshotId}_repo`,
          materializationRecordId: `wmr_${f.environmentPackage.snapshotId}_repo`,
          strategy: 'git',
        });
      const emptyScans = f.effects.length;
      await expect(collector.collectWorkspaceSnapshot(f.session, 'successor')).resolves.toEqual([]);
      expect(f.effects).toHaveLength(emptyScans);
      expect(
        db.sqlite.prepare('SELECT COUNT(*) AS count FROM worker_output_manifests').get()
      ).toEqual({ count: destination ? 2 : 0 });
    } finally {
      db.sqlite.close();
      f.coreDb.sqlite.close();
    }
  });
  it('preserves every closed collection failure without a cursor advance, receipt, or review', async () => {
    let failure: Record<string, unknown> = { outcome: 'effect_failed' };
    let baselineFails = false;
    const f = await admitIdleSupplyResident('closed_failures', {
      onCollection: async (request) =>
        request.input.mode === 'baseline' && !baselineFails
          ? {
              outcome: 'baseline',
              head: { tree: '4b825dc642cb6eb9a060e54bf8d69288fbee4904', manifest: '2'.repeat(40) },
            }
          : failure,
    });
    const collector = f.backend as unknown as {
      collectWorkspaceSnapshot(session: unknown, boundary: 'turn-end'): Promise<unknown>;
      ensureWorkspaceBaseline(session: unknown, opensNewBinding: boolean): Promise<void>;
    };
    const db = openWorkspaceDb(f.coreDb.dataRoot, f.environmentPackage.scope.workspaceId);
    try {
      const before = db.sqlite.prepare('SELECT * FROM workspace_snapshot_cursors').all();
      for (const result of [
        { outcome: 'credential_hit' },
        { outcome: 'effect_failed' },
        ...WorkspaceCollectionRecoveryCauseSchema.options.map((cause) => ({
          outcome: 'recovery_required',
          cause,
        })),
      ]) {
        failure = result;
        await expect(
          collector.collectWorkspaceSnapshot(f.session, 'turn-end')
        ).rejects.toMatchObject({ ...result, name: 'WorkspaceCollectionError' });
        expect(db.sqlite.prepare('SELECT * FROM workspace_snapshot_cursors').all()).toEqual(before);
        expect(
          db.sqlite.prepare('SELECT COUNT(*) AS count FROM workspace_snapshot_collections').get()
        ).toEqual({ count: 0 });
        expect(
          db.sqlite.prepare('SELECT COUNT(*) AS count FROM staged_workspace_reviews').get()
        ).toEqual({ count: 0 });
      }
      baselineFails = true;
      db.sqlite.exec(
        'UPDATE workspace_snapshot_cursors SET accepted_base_json = NULL, head_json = NULL, accepted_commit = NULL'
      );
      for (const result of [
        { outcome: 'credential_hit' },
        { outcome: 'effect_failed' },
        ...WorkspaceCollectionRecoveryCauseSchema.options.map((cause) => ({
          outcome: 'recovery_required',
          cause,
        })),
      ]) {
        failure = result;
        await expect(collector.ensureWorkspaceBaseline(f.session, true)).rejects.toMatchObject({
          ...result,
          name: 'WorkspaceCollectionError',
        });
        expect(
          db.sqlite
            .prepare('SELECT accepted_base_json, head_json FROM workspace_snapshot_cursors')
            .get()
        ).toEqual({ accepted_base_json: null, head_json: null });
      }
      await expect(collector.collectWorkspaceSnapshot(f.session, 'turn-end')).rejects.toMatchObject(
        { outcome: 'recovery_required', cause: 'accepted_base_unknown' }
      );
      const ids = f.effects
        .filter((effect) => effect.kind === 'workspace.collect')
        .map((effect) => effect.requestId);
      expect(new Set(ids).size).toBe(ids.length);
    } finally {
      db.sqlite.close();
      f.coreDb.sqlite.close();
    }
  });
  it('waits for an unfinished prior Turn collection before reusing the binding and replays its committed receipt', async () => {
    let finish!: (result: Record<string, unknown>) => void;
    let arrived!: () => void;
    const entered = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const capture = new Promise<Record<string, unknown>>((resolve) => {
      finish = resolve;
    });
    const f = await admitIdleSupplyResident('prior_capture', {
      onCollection: async (request) => {
        if (request.input.mode === 'baseline')
          return {
            outcome: 'baseline',
            head: { tree: '4b825dc642cb6eb9a060e54bf8d69288fbee4904', manifest: '2'.repeat(40) },
          };
        expect(request.input.collectionId).toMatch(/^turn-end-/);
        arrived();
        return await capture;
      },
    });
    const collector = f.backend as unknown as {
      ensureWorkspaceBaseline(session: unknown, opensNewBinding: boolean): Promise<void>;
    };
    const real = f.session as { environmentPackage: AgentEnvironmentPackage };
    const next = {
      ...real,
      environmentPackage: {
        ...real.environmentPackage,
        snapshotId: 'next-package',
        scope: { ...real.environmentPackage.scope, turnId: 'next-turn' },
      },
    };
    let settled = false;
    try {
      const gate = collector.ensureWorkspaceBaseline(next, false);
      void gate.then(() => {
        settled = true;
      });
      await entered;
      expect(settled).toBe(false);
      finish({ outcome: 'no_new_head', unstable: false });
      await gate;
      expect(settled).toBe(true);
      const count = f.effects.length;
      await collector.ensureWorkspaceBaseline(next, false);
      expect(f.effects).toHaveLength(count);
      expect(
        f.effects.filter(
          (effect) => effect.kind === 'workspace.collect' && effect.input.mode === 'baseline'
        )
      ).toHaveLength(1);
    } finally {
      f.coreDb.sqlite.close();
    }
  });
  it('restores the exact injected Vault version and refuses unavailable or incomplete evidence', async () => {
    const resolve = vi.fn((input: { referenceId: string; version?: number }) =>
      input.version === 7 ? 'original-injected-value' : 'rotated-current-value'
    );
    const vault = {
      health: vi.fn(() => ({
        kind: 'encrypted-file',
        state: 'available',
        diagnostic: 'available',
      })),
      resolve,
    } as unknown as VaultBackend;
    const f = await admitIdleSupplyResident('versions', { vaultBackend: () => vault });
    try {
      const collector = f.backend as unknown as {
        restoreCollectionRuntimeEnvironment(session: unknown): Record<string, string>;
      };
      const real = f.session as {
        agentSessionRuntimeBindingId: string;
        environmentPackage: AgentEnvironmentPackage;
      };
      const session = {
        ...real,
        environmentPackage: {
          ...real.environmentPackage,
          credentials: {
            ...real.environmentPackage.credentials,
            declarations: [{ visibility: 'runtime-env', targetEnvVarName: 'TOKEN' }],
          },
        },
      };
      const write = (versions: string | null) =>
        f.coreDb.sqlite
          .prepare(
            'UPDATE agent_session_runtime_bindings SET runtime_env_check_versions_json = ? WHERE agent_session_runtime_binding_id = ?'
          )
          .run(versions, real.agentSessionRuntimeBindingId);
      write(
        JSON.stringify([
          { targetEnvVarName: 'TOKEN', vaultReferenceId: 'version-ref', materialVersion: 7 },
        ])
      );
      expect(collector.restoreCollectionRuntimeEnvironment(session)).toEqual({
        TOKEN: 'original-injected-value',
      });
      expect(resolve).toHaveBeenCalledExactlyOnceWith({ referenceId: 'version-ref', version: 7 });
      for (const versions of [
        null,
        'invalid',
        '{}',
        '[null]',
        '[]',
        JSON.stringify([
          { targetEnvVarName: 'TOKEN', vaultReferenceId: 'version-ref', materialVersion: 0 },
        ]),
        JSON.stringify([
          {
            targetEnvVarName: 'TOKEN',
            vaultReferenceId: 'version-ref',
            materialVersion: Number.MAX_SAFE_INTEGER + 1,
          },
        ]),
        JSON.stringify([{ targetEnvVarName: 'TOKEN', vaultReferenceId: '', materialVersion: 7 }]),
      ]) {
        write(versions);
        expect(() => collector.restoreCollectionRuntimeEnvironment(session)).toThrow(
          'check_values_unavailable'
        );
      }
      write(
        JSON.stringify([
          { targetEnvVarName: 'TOKEN', vaultReferenceId: 'version-ref', materialVersion: 7 },
        ])
      );
      vi.mocked(vault.health).mockReturnValueOnce({
        kind: 'encrypted-file',
        state: 'unavailable',
        diagnostic: 'unavailable',
      } as ReturnType<VaultBackend['health']>);
      expect(() => collector.restoreCollectionRuntimeEnvironment(session)).toThrow(
        'check_values_unavailable'
      );
      resolve.mockImplementation(() => {
        throw new Error('version expired');
      });
      expect(() => collector.restoreCollectionRuntimeEnvironment(session)).toThrow(
        'check_values_unavailable'
      );
      expect(
        JSON.stringify(
          f.coreDb.sqlite
            .prepare('SELECT runtime_env_check_versions_json FROM agent_session_runtime_bindings')
            .all()
        )
      ).not.toContain('original-injected-value');
    } finally {
      f.coreDb.sqlite.close();
    }
  });
  it('constructs collection from exact attachment proof and refuses oversized or incomplete check commands', async () => {
    const f = await admitIdleSupplyResident('association');
    try {
      const collector = f.backend as unknown as {
        workspaceCollectionIdentity(
          session: unknown,
          id: string
        ): import('./workspace-snapshot-chain.js').WorkspaceCollectionIdentity;
        workspaceCollectionCommand(
          session: unknown,
          identity: unknown,
          mode: 'capture',
          cursor: unknown
        ): Record<string, unknown>;
      };
      const real = f.session as {
        environmentPackage: AgentEnvironmentPackage;
        runtimeEnvironment: Record<string, string> | null;
        sharedHarness: {
          sandbox: {
            sandboxBindingRef: string;
            workerStorageBinding: { attachmentGeneration: number; scopeDigest: string };
          };
        };
      };
      const identity = collector.workspaceCollectionIdentity(real, 'capture');
      const cursor = {
        acceptedBase: { tree: '1'.repeat(40), manifest: '2'.repeat(40) },
        head: { tree: '3'.repeat(40), manifest: '4'.repeat(40) },
      };
      expect(collector.workspaceCollectionCommand(real, identity, 'capture', cursor)).toMatchObject(
        {
          storageRef: identity.storageRef,
          scopeDigest: identity.scopeDigest,
          attachmentGeneration: identity.attachmentGeneration,
          sandboxId: identity.sandboxId,
          workSlot: identity.workSlot,
          collectionId: identity.collectionId,
          mode: 'capture',
          acceptedBase: cursor.acceptedBase,
          previousHead: cursor.head,
          checkValues: {
            runtimeEnv: [],
            loopbackDigests: [
              expect.stringMatching(/^[0-9a-f]{64}$/),
              expect.stringMatching(/^[0-9a-f]{64}$/),
            ],
          },
        }
      );
      for (const changed of [
        {
          attachmentGeneration:
            real.sharedHarness.sandbox.workerStorageBinding.attachmentGeneration + 1,
        },
        { scopeDigest: `sha256:${'f'.repeat(64)}` },
      ]) {
        const forged = {
          ...real,
          sharedHarness: {
            ...real.sharedHarness,
            sandbox: {
              ...real.sharedHarness.sandbox,
              workerStorageBinding: {
                ...real.sharedHarness.sandbox.workerStorageBinding,
                ...changed,
              },
            },
          },
        };
        expect(() => collector.workspaceCollectionIdentity(forged, 'capture')).toThrow(
          'association'
        );
      }
      for (const scope of [{ workspaceId: 'foreign' }, { threadId: 'foreign' }])
        expect(() =>
          collector.workspaceCollectionIdentity(
            {
              ...real,
              environmentPackage: {
                ...real.environmentPackage,
                scope: { ...real.environmentPackage.scope, ...scope },
              },
            },
            'capture'
          )
        ).toThrow('association');
      expect(() =>
        collector.workspaceCollectionIdentity(
          {
            ...real,
            sharedHarness: {
              ...real.sharedHarness,
              sandbox: { ...real.sharedHarness.sandbox, sandboxBindingRef: 'foreign' },
            },
          },
          'capture'
        )
      ).toThrow('association');
      expect(() =>
        collector.workspaceCollectionCommand(
          {
            ...real,
            runtimeEnvironment: Object.fromEntries(
              Array.from({ length: 128 }, (_, i) => [`VALUE_${i}`, 'x'.repeat(65536)])
            ),
          },
          identity,
          'capture',
          cursor
        )
      ).toThrow('command_too_large');
      expect(() =>
        collector.workspaceCollectionCommand(
          {
            ...real,
            runtimeEnvironment: Object.fromEntries(
              Array.from({ length: 129 }, (_, i) => [`VALUE_${i}`, 'x'])
            ),
          },
          identity,
          'capture',
          cursor
        )
      ).toThrow('check_values_unavailable');
      expect(() =>
        collector.workspaceCollectionCommand(
          { ...real, runtimeEnvironment: { VALUE: 'nul\0' } },
          identity,
          'capture',
          cursor
        )
      ).toThrow('check_values_unavailable');
    } finally {
      f.coreDb.sqlite.close();
    }
  });
  it('replays committed capture without another native scan or resolving unavailable check values', async () => {
    const f = await admitIdleSupplyResident('capture_replay');
    try {
      const collector = f.backend as unknown as {
        collectWorkspaceSnapshot(session: unknown, boundary: 'turn-end'): Promise<unknown[]>;
      };
      expect(await collector.collectWorkspaceSnapshot(f.session, 'turn-end')).toEqual([]);
      const before = f.effects.length;
      const session = { ...(f.session as object), runtimeEnvironment: null };
      f.coreDb.sqlite
        .prepare('UPDATE agent_session_runtime_bindings SET runtime_env_check_versions_json = NULL')
        .run();
      expect(await collector.collectWorkspaceSnapshot(session, 'turn-end')).toEqual([]);
      expect(f.effects).toHaveLength(before);
    } finally {
      f.coreDb.sqlite.close();
    }
  });

  function sessionCompatibilityDigest(environmentPackage: AgentEnvironmentPackage): string {
    return (
      environmentPackage.extensions.openkit as {
        sessionWorkspace: SessionWorkspaceMaterializationPlan;
      }
    ).sessionWorkspace.compatibilityKey.digest;
  }

  function packageWithAddedMcp(
    environmentPackage: AgentEnvironmentPackage,
    scope: AgentEnvironmentPackage['scope'],
    snapshotId: string
  ): AgentEnvironmentPackage {
    return {
      ...environmentPackage,
      scope,
      snapshotId,
      supply: {
        ...environmentPackage.supply,
        mcpServers: [
          ...environmentPackage.supply.mcpServers,
          {
            allowedTools: ['echo'],
            approvalRequiredTools: [],
            catalogDigest: `sha256:${'b'.repeat(64)}`,
            deniedTools: [],
            id: 'added-mcp',
            pinnedSchemaSnapshotId: null,
            schemaPolicy: 'tracking',
          },
        ],
      },
    };
  }

  /** Builds a new immutable effective map and its ordinary session compatibility projection. */
  function packageWithChangedNative(
    environmentPackage: AgentEnvironmentPackage,
    scope: AgentEnvironmentPackage['scope'],
    snapshotId: string
  ): AgentEnvironmentPackage {
    const next = {
      ...environmentPackage,
      scope,
      snapshotId,
      runtime: {
        ...environmentPackage.runtime,
        environment: {
          ...environmentPackage.runtime.environment!,
          values: { NATIVE_SETTING: 'changed', EMPTY: '' },
        },
      },
    };
    const plan = planSessionWorkspaceMaterialization({ environmentPackage: next });
    return {
      ...next,
      extensions: {
        ...next.extensions,
        openkit: {
          ...(next.extensions.openkit as Record<string, unknown>),
          sessionWorkspace: plan,
        },
      },
    };
  }

  it.each([
    'unavailable',
    'stale',
  ] as const)('refuses %s confirmed default inspection before Sandbox creation without repeating the authored build', async (inspection) => {
    const effects: NanoHostSessionEffectRequest[] = [];
    await expect(
      admitIdleSupplyResident(`native_${inspection}`, { nativeValues: {}, inspection, effects })
    ).rejects.toThrow('different digest');
    expect(effects.filter((effect) => effect.kind === 'image.acquire')).toHaveLength(1);
    expect(effects.map((effect) => effect.kind)).not.toContain('image.build');
    expect(effects.map((effect) => effect.kind)).not.toContain('sandbox.create');
  });
  it('materializes the confirmed measured image instead of repeating its authored build', async () => {
    const effects: NanoHostSessionEffectRequest[] = [];
    const admitted = await admitIdleSupplyResident('native_confirmed_build', {
      nativeValues: {},
      effects,
    });
    try {
      expect(effects.filter((effect) => effect.kind === 'image.acquire')).toEqual([
        expect.objectContaining({
          input: expect.objectContaining({
            imageReference: `sha256:${'a'.repeat(64)}`,
          }),
        }),
      ]);
      expect(effects.map((effect) => effect.kind)).not.toContain('image.build');
    } finally {
      admitted.coreDb.sqlite.close();
    }
  });

  it('reuses the resident binding when supply is unchanged', async () => {
    const admitted = await admitIdleSupplyResident('supply_same');
    const { backend, coreDb, environmentPackage, settleNext } = admitted;
    try {
      const nextPackage: AgentEnvironmentPackage = {
        ...environmentPackage,
        scope: { ...environmentPackage.scope, turnId: 'turn_supply_same_next' },
        snapshotId: 'snapshot_supply_same_next',
      };
      expect(sessionCompatibilityDigest(nextPackage)).toBe(
        sessionCompatibilityDigest(environmentPackage)
      );
      await expect(
        backend.prepareAgentSessionContinuity?.({
          agentSessionCompatibilityKey: sessionCompatibilityDigest(nextPackage),
          agentSessionId: environmentPackage.scope.agentSessionId,
          environmentPackage: nextPackage,
          reuseAllowed: true,
          threadId: environmentPackage.scope.threadId,
          workspaceId: environmentPackage.scope.workspaceId,
        })
      ).resolves.toBe('reusable');
      authorizeNanoHostPackage(coreDb, nextPackage);
      bindNanoHostWorkerLineage(coreDb, nextPackage, {
        leaseId: 'lease_supply_same_next',
        now: '2026-09-06T00:00:02.000Z',
        planId: 'plan_supply_same_next',
        sandboxBindingRef: 'sandbox-binding:supply-same-next',
        selectedPoolId: 'pool_supply_same',
        selectedTargetId: 'target_supply_same',
      });
      anchorNanoHostMaterialization(coreDb, backend, nextPackage);
      const nextLaunch = backend.launch(
        await backend.materialize(nextPackage, { workspaceRoots: [] })
      );
      const inspected = await settleNext('session.inspect', {
        childState: 'running',
        cleanupState: 'clean',
        nativeHandleDigest: admitted.readyDigest,
        nativeHandleState: 'ready',
        state: 'open',
      });
      expect(inspected.body.agentSessionId).toBe(environmentPackage.scope.agentSessionId);
      await settleNext('turn.start', {
        nativeHandleDigest: admitted.readyDigest,
        nativeHandleState: 'ready',
        state: 'started',
      });
      await nextLaunch;
      expect(
        coreDb.sqlite
          .prepare('SELECT agent_session_id AS agentSessionId FROM agent_session_runtime_bindings')
          .all()
      ).toEqual([{ agentSessionId: environmentPackage.scope.agentSessionId }]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it.each([
    'mcp',
    'native',
  ] as const)('replaces the resident binding when only %s changes and resumes its exact recorded pair', async (change) => {
    const admitted = await admitIdleSupplyResident(
      'supply_mcp',
      change === 'native' ? { nativeValues: {} } : {}
    );
    const withChange = change === 'native' ? packageWithChangedNative : packageWithAddedMcp;
    const { backend, coreDb, environmentPackage, readyDigest, settleNext } = admitted;
    try {
      const decisionPackage = withChange(
        environmentPackage,
        { ...environmentPackage.scope, turnId: 'turn_supply_mcp_next' },
        'snapshot_supply_mcp_next'
      );
      if (change === 'mcp')
        expect(sessionCompatibilityDigest(decisionPackage)).toBe(
          sessionCompatibilityDigest(environmentPackage)
        );
      else
        expect(sessionCompatibilityDigest(decisionPackage)).not.toBe(
          sessionCompatibilityDigest(environmentPackage)
        );
      await expect(
        backend.prepareAgentSessionContinuity?.({
          agentSessionCompatibilityKey: sessionCompatibilityDigest(decisionPackage),
          agentSessionId: environmentPackage.scope.agentSessionId,
          reuseAllowed: true,
          threadId: environmentPackage.scope.threadId,
          workspaceId: environmentPackage.scope.workspaceId,
        })
      ).resolves.toBe('replacement-required');
      await expect(
        backend.prepareAgentSessionContinuity?.({
          agentSessionCompatibilityKey: sessionCompatibilityDigest(decisionPackage),
          agentSessionId: environmentPackage.scope.agentSessionId,
          environmentPackage: decisionPackage,
          reuseAllowed: true,
          threadId: environmentPackage.scope.threadId,
          workspaceId: environmentPackage.scope.workspaceId,
        })
      ).resolves.toBe('replacement-required');
      const closing = backend.prepareAgentSessionContinuity?.({
        agentSessionCompatibilityKey: sessionCompatibilityDigest(decisionPackage),
        agentSessionId: environmentPackage.scope.agentSessionId,
        environmentPackage: decisionPackage,
        reuseAllowed: false,
        threadId: environmentPackage.scope.threadId,
        workspaceId: environmentPackage.scope.workspaceId,
      });
      const closeCommand = await settleNext('session.close', {
        privateState: 'absent',
        state: 'closed',
      });
      expect(closeCommand.body).toMatchObject({
        agentSessionId: environmentPackage.scope.agentSessionId,
      });
      await expect(closing).resolves.toBe('closed');
      expect(
        coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM agent_session_runtime_bindings').get()
      ).toEqual({ count: 0 });
      const successorPackage = withChange(
        environmentPackage,
        {
          ...environmentPackage.scope,
          agentSessionId: 'as_supply_mcp_successor',
          turnId: 'turn_supply_mcp_successor',
        },
        'snapshot_supply_mcp_successor'
      );
      const resume = { digest: readyDigest, locator: environmentPackage.scope.agentSessionId };
      authorizeNanoHostPackage(coreDb, successorPackage);
      bindNanoHostWorkerLineage(coreDb, successorPackage, {
        leaseId: 'lease_supply_mcp_successor',
        now: '2026-09-06T00:00:03.000Z',
        planId: 'plan_supply_mcp_successor',
        sandboxBindingRef: 'sandbox-binding:supply-mcp-successor',
        selectedPoolId: 'pool_supply_mcp',
        selectedTargetId: 'target_supply_mcp',
      });
      anchorNanoHostMaterialization(coreDb, backend, successorPackage);
      const successorMaterialization = await backend.materialize(successorPackage, {
        nativeResume: resume,
        workspaceRoots: [],
      });
      backend.bindNativeHandleRecorder(successorPackage.snapshotId, () => undefined);
      const successorLaunch = backend.launch(successorMaterialization);
      const opened = await settleNext('session.open', {
        maxActiveTurns: 1,
        nativeHandleDigest: readyDigest,
        nativeHandleState: 'ready',
        state: 'open',
      });
      expect(opened.body.resume).toEqual(resume);
      if (change === 'native') {
        expect(opened.body.nativeEnvironment).toEqual({ NATIVE_SETTING: 'changed', EMPTY: '' });
        expect(
          coreDb.sqlite
            .prepare(
              'SELECT native_environment_applied AS applied FROM agent_session_runtime_bindings'
            )
            .get()
        ).toEqual({ applied: 0 });
        expect(
          coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM harness_instance_records').get()
        ).toEqual({ count: 1 });
      }
      await settleNext('turn.start', {
        nativeHandleDigest: readyDigest,
        nativeHandleState: 'ready',
        state: 'started',
      });
      await successorLaunch;
      if (change === 'native')
        expect(
          coreDb.sqlite
            .prepare(
              'SELECT native_environment_applied AS applied FROM agent_session_runtime_bindings'
            )
            .get()
        ).toEqual({ applied: 1 });
      expect(
        coreDb.sqlite
          .prepare('SELECT agent_session_id AS agentSessionId FROM agent_session_runtime_bindings')
          .all()
      ).toEqual([{ agentSessionId: 'as_supply_mcp_successor' }]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('reuses same-epoch idle AgentSession continuity after restart without process-local warmup', async () => {
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
        if (request.kind === 'workspace.collect')
          return request.input.mode === 'baseline'
            ? {
                requestId: request.requestId,
                outcome: 'baseline',
                head: {
                  tree: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
                  manifest: 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391',
                },
              }
            : { requestId: request.requestId, outcome: 'no_new_head', unstable: false };
        if (request.kind === 'reference.import') return { state: 'imported' };
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
           ) VALUES ('target_restart_same_epoch', 'identity_restart_same_epoch', 'deployment_restart_same_epoch', 1, 1, 1, 1, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', ?, 1)`
        )
        .run('2026-09-06T00:00:00.000Z');
      const layout = {
        family: 'openkit-worker',
        gid: 1000,
        platform: { architecture: 'amd64', os: 'linux' },
        targets: [{ target: '/sandbox' }, { target: '/workspace' }],
        uid: 1000,
        version: '1',
        workingDirectory: '/tmp/openkit-bootstrap',
      };
      const createdStorage = createWorkerStorageBinding(coreDb, {
        deploymentId: 'deployment_restart_same_epoch',
        layout,
        runtimeTargetId: 'target_restart_same_epoch',
        workspaceId: 'workspace_restart_same_epoch',
      });
      const predecessor = reserveWorkerStorageAttachment(coreDb, {
        agentSessionId: 'as_restart_same_epoch_predecessor',
        authorizeContributor: () => true,
        expectedRevision: createdStorage.revision,
        layout,
        purpose: 'work',
        responsibleUserId: 'user-factory',
        runtimeTargetId: 'target_restart_same_epoch',
        storageRef: createdStorage.storageRef,
        threadId: 'thread_restart_same_epoch_predecessor',
        workspaceId: 'workspace_restart_same_epoch',
      });
      const predecessorAttached = activateWorkerStorageAttachment(coreDb, {
        attachmentGeneration: predecessor.attachmentGeneration,
        expectedRevision: predecessor.revision,
        sandboxBindingRef: 'sandbox_restart_same_epoch_predecessor',
        storageRef: predecessor.storageRef,
        targets: predecessor.targets.map((target) => ({ ...target, initialized: true })),
      });
      const idleStorage = releaseWorkerStorageAttachment(coreDb, {
        attachmentGeneration: predecessorAttached.attachmentGeneration,
        cleanupProved: true,
        expectedRevision: predecessorAttached.revision,
        sandboxBindingRef: 'sandbox_restart_same_epoch_predecessor',
        storageRef: predecessorAttached.storageRef,
      });
      const retainedWorkSlotRef = predecessor.currentWorkSlotRef;
      if (!retainedWorkSlotRef) throw new Error('Expected predecessor retained work slot.');
      expect(retainedWorkSlotRef).not.toBe(
        workerStorageDefaultWorkSlotRef('workspace_restart_same_epoch', 'thread_restart_same_epoch')
      );
      const triggerActor = { kind: 'user' as const, id: 'user-factory' };
      const packageResolution = {
        captureCoverage: { scope: 'server', value: 'off' } as const,
        agentSessionId: 'as_restart_same_epoch',
        agentSetup: createTestAgentSetup(),
        backend: { kind: 'openshell' as const },
        createdAt: '2026-08-21T00:00:00.000Z',
        requestId: 'request_factory_fixture',
        triggerActor,
        turn: {
          completedAt: null,
          configVersion: null,
          durationMs: null,
          error: null,
          id: 'turn_restart_same_epoch',
          items: [],
          startedAt: '2026-08-21T00:00:00.000Z',
          status: 'running' as const,
          threadId: 'thread_restart_same_epoch',
          triggerActor,
          workspaceId: 'workspace_restart_same_epoch',
        },
        turnInput: 'Run fixture',
        workspaceCwd: '/workspace',
        workspaceRoots: [] as const,
      };
      const digestImage = {
        kind: 'reference' as const,
        pullPolicy: 'never' as const,
        ref: `sha256:${'1'.repeat(64)}`,
      };
      const withDigestImage = (pkg: AgentEnvironmentPackage): AgentEnvironmentPackage => ({
        ...pkg,
        runtime: { ...pkg.runtime, image: digestImage },
      });
      const environmentPackage = withDigestImage(
        resolveAgentEnvironmentPackage({
          ...packageResolution,
          workerStorageWorkSlotRef: retainedWorkSlotRef,
        })
      );
      const plannedPackage = withDigestImage(
        resolveAgentEnvironmentPackageMetadata(packageResolution)
      );
      expect(
        (plannedPackage.extensions.openkit as { workerStorage: { workSlotRef: string } })
          .workerStorage.workSlotRef
      ).toBe(
        workerStorageDefaultWorkSlotRef('workspace_restart_same_epoch', 'thread_restart_same_epoch')
      );
      authorizeNanoHostPackage(coreDb, environmentPackage);
      new FsStore({ dataRoot: coreDb.dataRoot }).createThread(
        environmentPackage.scope.workspaceId,
        'Predecessor',
        'thread_restart_same_epoch_predecessor'
      );
      bindNanoHostWorkerLineage(coreDb, environmentPackage, {
        leaseId: `lease-${environmentPackage.snapshotId}`,
        now: '2026-09-06T00:00:00.000Z',
        planId: 'plan_restart_same_epoch',
        sandboxBindingRef: 'lease-binding:restart-same-epoch',
        selectedPoolId: 'pool_restart_same_epoch',
        selectedTargetId: 'target_restart_same_epoch',
      });
      const firstRuntime = createConfiguredWorkerLifecycleRuntime({
        coreDb,
        env: {},
        nanoHostSessionDispatch: sessionDispatch,
        workerControlGateway: new WorkerControlGateway(),
      });
      const firstBackend = (
        firstRuntime.turnExecutor as unknown as {
          readonly backend: WorkerGovernanceBackend & {
            inspectTerminalHarnessSession(session: unknown): Promise<void>;
            readonly sessions: Map<string, unknown>;
          };
        }
      ).backend;
      const settleNext = async (
        operation: 'session.open' | 'turn.start' | 'session.inspect',
        body: Readonly<Record<string, unknown>>
      ) => {
        let command: ReturnType<typeof dispatchNanoHostHarnessOperation> = null;
        for (let attempt = 0; attempt < 200 && !command; attempt += 1) {
          const integration = coreDb.sqlite
            .prepare(
              `SELECT sandbox_integration_binding_ref AS integrationRef
               FROM sandbox_runtime_records ORDER BY created_at LIMIT 1`
            )
            .get() as { readonly integrationRef: string } | undefined;
          if (integration) {
            command = dispatchNanoHostHarnessOperation(coreDb, {
              sandboxIntegrationBindingRef: integration.integrationRef,
            });
          }
          if (!command) await new Promise<void>((resolve) => setTimeout(resolve, 1));
        }
        if (!command || command.operation !== operation) {
          throw new Error(`Expected queued ${operation} Harness command.`);
        }
        firstRuntime.acceptNanoHostHarnessCommand(command);
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
          sandboxIntegrationBindingRef: (
            coreDb.sqlite
              .prepare(
                `SELECT sandbox_integration_binding_ref AS integrationRef
                 FROM sandbox_runtime_records ORDER BY created_at LIMIT 1`
              )
              .get() as { readonly integrationRef: string }
          ).integrationRef,
          timestamp: '2026-09-06T00:00:01.000Z',
        });
        firstRuntime.acceptNanoHostHarnessResult(result);
      };
      anchorNanoHostMaterialization(coreDb, firstBackend, environmentPackage);
      seedAcceptedRetainedSlot(coreDb, environmentPackage, idleStorage, retainedWorkSlotRef);
      const materialization = await firstBackend.materialize(environmentPackage, {
        workerStorageChoice: {
          expectedRevision: idleStorage.revision,
          goalId: null,
          kind: 'selected',
          purpose: 'work',
          reuseWorkSlotRef: retainedWorkSlotRef,
          storageRef: idleStorage.storageRef,
          taskId: null,
        },
        workspaceRoots: [],
      });
      const recordedDigests: string[] = [];
      firstBackend.bindNativeHandleRecorder?.(environmentPackage.snapshotId, (digest) => {
        recordedDigests.push(digest);
      });
      const launch = firstBackend.launch(materialization);
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
          agentSessionId: environmentPackage.scope.agentSessionId,
          packageSnapshotId: environmentPackage.snapshotId,
          requestId: environmentPackage.scope.requestId,
          threadId: environmentPackage.scope.threadId,
          turnId: environmentPackage.scope.turnId,
          workspaceId: environmentPackage.scope.workspaceId,
        },
        operation: 'final_status',
        record: { sequence: 1, status: 'completed', stopReason: 'completed' },
        recordKey: '1',
        sequence: 1,
      });
      const terminalInspection = firstBackend.inspectTerminalHarnessSession(
        firstBackend.sessions.get(environmentPackage.snapshotId)
      );
      await settleNext('session.inspect', {
        childState: 'absent',
        cleanupState: 'clean',
        nativeHandleDigest: 'a'.repeat(64),
        nativeHandleState: 'ready',
        state: 'open',
      });
      await terminalInspection;
      expect(recordedDigests).toEqual(['a'.repeat(64)]);
      await firstRuntime.cleanupBackendSession(firstBackend.planSession(environmentPackage));
      coreDb.sqlite
        .prepare(
          `UPDATE scheduler_session_leases SET status = 'released'
           WHERE lease_id = ?`
        )
        .run(`lease-${environmentPackage.snapshotId}`);
      const sandboxBindingRef = (
        coreDb.sqlite
          .prepare('SELECT sandbox_binding_ref AS sandboxBindingRef FROM sandbox_runtime_records')
          .get() as { readonly sandboxBindingRef: string }
      ).sandboxBindingRef;
      const storageBinding = getWorkerStorageBindingForSandbox(coreDb, { sandboxBindingRef });
      if (!storageBinding) throw new Error('Expected attached retained storage.');
      const sandboxCount = (
        coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM sandbox_runtime_records').get() as {
          count: number;
        }
      ).count;
      const storageCount = (
        coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM worker_storage_bindings').get() as {
          count: number;
        }
      ).count;
      expect(sandboxCount).toBe(1);
      expect(storageCount).toBe(1);
      const settledEffectCount = effects.length;
      const idleBinding = coreDb.sqlite
        .prepare(
          `SELECT b.agent_session_compatibility_key AS agentSessionCompatibilityKey,
                  b.cleanup_state AS cleanupState, b.current_lease_id AS currentLeaseId,
                  b.current_turn_id AS currentTurnId, b.lifecycle_state AS lifecycleState,
                  b.native_handle_digest AS nativeHandleDigest,
                  b.native_handle_state AS nativeHandleState,
                  h.adapter_id AS adapterId, h.adapter_version AS adapterVersion,
                  h.harness_compatibility_key AS harnessCompatibilityKey,
                  s.sandbox_compatibility_key AS sandboxCompatibilityKey
           FROM agent_session_runtime_bindings b
           JOIN harness_instance_records h ON h.harness_instance_id = b.harness_instance_id
           JOIN sandbox_runtime_records s ON s.sandbox_runtime_id = h.sandbox_runtime_id
           WHERE b.agent_session_id = ?`
        )
        .get(environmentPackage.scope.agentSessionId) as {
        readonly adapterId: string;
        readonly adapterVersion: string;
        readonly agentSessionCompatibilityKey: string;
        readonly cleanupState: string;
        readonly currentLeaseId: string | null;
        readonly currentTurnId: string | null;
        readonly harnessCompatibilityKey: string;
        readonly lifecycleState: string;
        readonly nativeHandleDigest: string | null;
        readonly nativeHandleState: string;
        readonly sandboxCompatibilityKey: string;
      };
      const sessionCompatibilityKey = (
        environmentPackage.extensions.openkit as {
          sessionWorkspace: SessionWorkspaceMaterializationPlan;
        }
      ).sessionWorkspace.compatibilityKey.digest;
      expect(idleBinding.sandboxCompatibilityKey).toMatch(/^[0-9a-f]{64}$/);
      expect(idleBinding.harnessCompatibilityKey).toMatch(/^[0-9a-f]{64}$/);
      expect(idleBinding).toMatchObject({
        agentSessionCompatibilityKey: deriveNanoHostAgentSessionCompatibilityKey({
          adapterId: idleBinding.adapterId,
          adapterVersion: idleBinding.adapterVersion,
          harnessCompatibilityKey: idleBinding.harnessCompatibilityKey,
          sessionCompatibilityKey,
          threadId: environmentPackage.scope.threadId,
        }),
        cleanupState: 'clean',
        currentLeaseId: null,
        currentTurnId: null,
        lifecycleState: 'open',
        nativeHandleDigest: 'a'.repeat(64),
        nativeHandleState: 'ready',
      });
      const slotBackend = (
        createConfiguredWorkerLifecycleRuntime({
          coreDb,
          env: {},
          nanoHostSessionDispatch: sessionDispatch,
          workerControlGateway: new WorkerControlGateway(),
        }).turnExecutor as unknown as {
          readonly backend: WorkerGovernanceBackend & {
            resolveResidentWorkerStorageWorkSlotRef(
              environmentPackage: AgentEnvironmentPackage
            ): string | null;
          };
        }
      ).backend;
      const coldLookupEffects = effects.length;
      expect(slotBackend.resolveResidentWorkerStorageWorkSlotRef(plannedPackage)).toBe(
        retainedWorkSlotRef
      );
      expect(effects.slice(coldLookupEffects)).toEqual([]);
      expect(
        coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM worker_storage_bindings').get()
      ).toEqual({ count: 1 });
      expect(getWorkerStorageBindingForSandbox(coreDb, { sandboxBindingRef })).toEqual(
        storageBinding
      );
      const prepareBackend = (
        createConfiguredWorkerLifecycleRuntime({
          coreDb,
          env: {},
          nanoHostSessionDispatch: sessionDispatch,
          workerControlGateway: new WorkerControlGateway(),
        }).turnExecutor as unknown as { readonly backend: WorkerGovernanceBackend }
      ).backend;

      await expect(
        prepareBackend.prepareAgentSessionContinuity?.({
          agentSessionCompatibilityKey: sessionCompatibilityKey,
          agentSessionId: environmentPackage.scope.agentSessionId,
          environmentPackage,
          reuseAllowed: true,
          threadId: environmentPackage.scope.threadId,
          workspaceId: environmentPackage.scope.workspaceId,
        })
      ).resolves.toBe('reusable');
      expect(getWorkerStorageBindingForSandbox(coreDb, { sandboxBindingRef })).toEqual(
        storageBinding
      );
      expect(
        coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM sandbox_runtime_records').get()
      ).toEqual({ count: 1 });
      expect(
        coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM worker_storage_bindings').get()
      ).toEqual({ count: 1 });
      expect(effects.filter((effect) => effect.kind === 'sandbox.create')).toHaveLength(1);
      expect(effects.some((effect) => effect.kind === 'sandbox.delete')).toBe(false);
      expect(effects.slice(settledEffectCount)).toEqual([]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('returns null from a cold resident work-slot lookup without a durable Sandbox', () => {
    const coreDb = createFactoryCoreDb();
    try {
      const environmentPackage = completeNanoHostPackage({
        scope: {
          agentSessionId: 'as_cold_slot_absent',
          threadId: 'thread_cold_slot_absent',
          turnId: 'turn_cold_slot_absent',
          workspaceId: 'workspace_cold_slot_absent',
        },
        snapshotId: 'snapshot_cold_slot_absent',
      });
      const backend = (
        createConfiguredWorkerLifecycleRuntime({
          coreDb,
          env: {},
          workerControlGateway: new WorkerControlGateway(),
        }).turnExecutor as unknown as {
          readonly backend: WorkerGovernanceBackend & {
            resolveResidentWorkerStorageWorkSlotRef(
              environmentPackage: AgentEnvironmentPackage
            ): string | null;
          };
        }
      ).backend;
      expect(backend.resolveResidentWorkerStorageWorkSlotRef(environmentPackage)).toBeNull();
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('carries a resident predecessor handoff slot into a no-choice successor AEP without a storage-bearing session.open', async () => {
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
        if (request.kind === 'reference.import') return { state: 'imported' };
        if (request.kind === 'workspace.collect')
          return { requestId: request.requestId, outcome: 'no_new_head', unstable: false };
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
        captureCoverage: { scope: 'server', value: 'off' },
        agentSessionId: 'as_selected_slot_successor',
        agentSetup: createTestAgentSetup({ imageRef: `sha256:${'6'.repeat(64)}` }),
        backend: { kind: 'openshell' },
        createdAt: '2026-09-11T00:00:01.000Z',
        requestId: 'request_selected_slot_successor',
        triggerActor,
        turn: {
          completedAt: null,
          configVersion: null,
          durationMs: null,
          error: null,
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
      bindNanoHostWorkerLineage(coreDb, environmentPackage, {
        leaseId: 'lease_selected_slot',
        now: '2026-09-11T00:00:01.000Z',
        planId: 'plan_selected_slot',
        sandboxBindingRef: 'sandbox-binding:selected-slot',
        selectedPoolId: 'pool_selected_slot',
        selectedTargetId: 'target_selected_slot',
      });
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
      seedAcceptedRetainedSlot(coreDb, environmentPackage, idle, selectedWorkSlotRef);
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
        agentSetup: createTestAgentSetup({ imageRef: `sha256:${'6'.repeat(64)}` }),
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
      const successorPreview = previewPackage('as_selected_slot_no_choice', successorPreparation);
      expect(successorPreview).not.toHaveProperty('observability');
      const successorPackage = AgentEnvironmentPackageSchema.parse({
        ...successorPreview,
        observability: environmentPackage.observability,
      });
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
      const freshWorktree = `/workspace/worktrees/${workerStorageDefaultWorkSlotRef(
        successorTurn.workspaceId,
        successorTurn.threadId
      )}`;
      expect(freshSuccessorPackage.workspace.inputs[0]?.target).toBe(freshWorktree);
      expect(freshSuccessorPackage.runtime.command.workingDirectory).toBe(freshWorktree);
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
      bindNanoHostWorkerLineage(coreDb, successorPackage, {
        leaseId: 'lease_selected_slot_no_choice',
        now: '2026-09-11T00:00:02.000Z',
        planId: 'plan_selected_slot_no_choice',
        sandboxBindingRef: 'sandbox-binding:selected-slot-no-choice',
        selectedPoolId: 'pool_selected_slot',
        selectedTargetId: 'target_selected_slot',
      });
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
      for (let attempt = 0; attempt < 200 && !command; attempt += 1) {
        command = dispatchNanoHostHarnessOperation(coreDb, {
          sandboxIntegrationBindingRef: integration.integrationRef,
        });
        if (!command) await new Promise<void>((resolve) => setTimeout(resolve, 1));
      }
      expect(command?.operation).toBe('session.open');
      // The selected slot reaches the worker through the AEP; `session.open` carries no storage.
      expect(command?.body).toMatchObject({ resume: null });
      expect(command?.body).not.toHaveProperty('storageRef');
      expect(command?.body).not.toHaveProperty('workSlotRef');
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
    ['definite delete', false, true],
    ['uncertain delete', true, true],
    ['definite delete with missing storage', false, false],
    ['uncertain delete with missing storage', true, false],
  ] as const)('%s updates the durable Sandbox even without a process-local session', async (_, uncertain, storagePresent) => {
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
      if (storagePresent) {
        attachNanoHostStorageFixture(coreDb, {
          agentSessionId: environmentPackage.scope.agentSessionId,
          deploymentId: 'deployment_absent_cleanup',
          runtimeTargetId: 'target_absent_cleanup',
          sandboxBindingRef: identity.backendSessionId,
          threadId: environmentPackage.scope.threadId,
          workspaceId: environmentPackage.scope.workspaceId,
        });
      }

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
      if (!storagePresent) {
        expect(
          coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM worker_storage_bindings').get()
        ).toEqual({ count: 0 });
        if (uncertain) {
          await expect(runtime.cleanupBackendSession(identity)).rejects.toThrow(
            /no different fresh physical Epoch proof/i
          );
          coreDb.sqlite
            .prepare('UPDATE nanohost_runtime_targets SET physical_epoch = ?')
            .run('b'.repeat(64));
          await expect(runtime.cleanupBackendSession(identity)).resolves.toBeUndefined();
          expect(
            coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM sandbox_runtime_records').get()
          ).toEqual({ count: 0 });
        }
      }
      expect(operations).toEqual(['bridge.close', 'sandbox.delete']);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it.each([
    ...(['reserved', 'unknown'] as const).flatMap((state) =>
      (['proved', 'failed', 'unknown', 'ambiguous', 'stale'] as const).map((outcome) => ({
        bindingRef: null,
        outcome,
        state,
      }))
    ),
    ...(['attached', 'unknown'] as const).flatMap((state) =>
      (['proved', 'contradictory'] as const).map((outcome) => ({
        bindingRef:
          outcome === 'proved' ? 'lease-binding:pending-cleanup' : 'lease-binding:other-sandbox',
        outcome,
        state,
      }))
    ),
  ])('releases no-Sandbox cleanup-pending $state storage only with current exact proof: $outcome ($bindingRef)', async ({
    bindingRef,
    state,
    outcome,
  }) => {
    const coreDb = createFactoryCoreDb();
    const effects: NanoHostSessionEffectRequest[] = [];
    let beforeCleanupResult = () => {};
    const expectResultOnly = vi.fn(async () => {
      beforeCleanupResult();
      if (outcome === 'failed' || outcome === 'unknown') {
        throw new Error(`Sandbox cleanup ${outcome}.`);
      }
      return { kind: 'sandbox.delete' as const, result: {} };
    });
    const sessionDispatch: NanoHostSessionDispatch = {
      async effect(requestOrConnection, carriedRequest) {
        effects.push(carriedRequest ?? (requestOrConnection as NanoHostSessionEffectRequest));
        return {};
      },
      expectResultOnly,
      async poll() {
        return null;
      },
      async result() {},
      async route() {
        throw new Error('Unexpected semantic route.');
      },
    };
    try {
      const timestamp = '2026-08-21T00:00:00.000Z';
      coreDb.sqlite
        .prepare(
          `INSERT INTO nanohost_runtime_targets (
               target_id, identity_id, deployment_id, connection_generation,
               predecessor_fenced, ready, fresh_empty, physical_epoch, observed_at, slot_count
             ) VALUES ('target_pending_cleanup', 'identity_pending_cleanup',
                       'deployment_pending_cleanup', 1, 1, 1, 1, ?, ?, 1)`
        )
        .run('a'.repeat(64), timestamp);
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
      backend.requireLeaseId = () => 'lease_pending_cleanup';
      const environmentPackage = completeNanoHostPackage({
        scope: {
          agentSessionId: 'as_pending_cleanup',
          threadId: 'thread_pending_cleanup',
          turnId: 'turn_pending_cleanup',
          workspaceId: 'workspace_pending_cleanup',
        },
        snapshotId: 'aepsnap_pending_cleanup',
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
               'lease_pending_cleanup', ?, ?, ?, ?, ?, 'openshell', ?, ?, ?, ?, ?,
               'lease-binding:pending-cleanup', ?, 'pending', 'cleanup-pending', ?, ?
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
          'a'.repeat(64),
          JSON.stringify({ imageRef: 'openkit/worker-codex:dev' }),
          identity.stagingDirectoryRef,
          timestamp,
          timestamp
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
      const reservationInput = {
        agentSessionId: identity.agentSessionId,
        authorizeContributor: () => true,
        expectedRevision: created.revision,
        layout,
        purpose: 'work' as const,
        responsibleUserId: 'user-factory',
        runtimeTargetId: identity.runtimeTargetId,
        storageRef: created.storageRef,
        threadId: environmentPackage.scope.threadId,
        workspaceId: environmentPackage.scope.workspaceId,
      };
      const reserved = reserveWorkerStorageAttachment(coreDb, reservationInput);
      const attached = bindingRef
        ? activateWorkerStorageAttachment(coreDb, {
            attachmentGeneration: reserved.attachmentGeneration,
            expectedRevision: reserved.revision,
            sandboxBindingRef: bindingRef,
            storageRef: reserved.storageRef,
            targets: reserved.targets.map((target) => ({ ...target, initialized: true })),
          })
        : reserved;
      if (state === 'unknown') {
        markWorkerStorageAttachmentUnknown(coreDb, {
          attachmentGeneration: reserved.attachmentGeneration,
          expectedRevision: attached.revision,
          storageRef: reserved.storageRef,
        });
      }
      const before = getWorkerStorageBinding(coreDb, { storageRef: reserved.storageRef })!;
      const siblingCreated = createWorkerStorageBinding(coreDb, {
        deploymentId: identity.deploymentId,
        layout,
        runtimeTargetId: identity.runtimeTargetId,
        workspaceId: environmentPackage.scope.workspaceId,
      });
      const sibling = reserveWorkerStorageAttachment(coreDb, {
        ...reservationInput,
        agentSessionId: 'as_sibling_cleanup',
        expectedRevision: siblingCreated.revision,
        storageRef: siblingCreated.storageRef,
        threadId: 'thread_sibling_cleanup',
      });
      let expectedAfterFailure = before;
      let duplicate: typeof before | null = null;
      if (outcome === 'ambiguous') {
        const duplicateCreated = createWorkerStorageBinding(coreDb, {
          deploymentId: identity.deploymentId,
          layout,
          runtimeTargetId: identity.runtimeTargetId,
          workspaceId: environmentPackage.scope.workspaceId,
        });
        duplicate = reserveWorkerStorageAttachment(coreDb, {
          ...reservationInput,
          expectedRevision: duplicateCreated.revision,
          storageRef: duplicateCreated.storageRef,
        });
      }
      if (outcome === 'stale') {
        beforeCleanupResult = () => {
          const released = releaseWorkerStorageAttachment(coreDb, {
            attachmentGeneration: before.attachmentGeneration,
            cleanupProved: true,
            expectedRevision: before.revision,
            storageRef: before.storageRef,
          });
          expectedAfterFailure = reserveWorkerStorageAttachment(coreDb, {
            ...reservationInput,
            expectedRevision: released.revision,
          });
        };
      }

      if (outcome === 'proved') {
        await expect(runtime.cleanupBackendSession(identity)).resolves.toBeUndefined();
      } else {
        await expect(runtime.cleanupBackendSession(identity)).rejects.toThrow(
          outcome === 'ambiguous'
            ? /matches more than one Worker storage binding/
            : outcome === 'contradictory'
              ? /Worker storage Sandbox binding contradicts cleanup ownership/
              : outcome === 'stale'
                ? /Worker storage revision changed/
                : `Sandbox cleanup ${outcome}.`
        );
        expect(getWorkerStorageBinding(coreDb, { storageRef: before.storageRef })).toEqual(
          expectedAfterFailure
        );
        expect(getWorkerStorageBinding(coreDb, { storageRef: sibling.storageRef })).toEqual(
          sibling
        );
        if (outcome === 'contradictory') {
          expect(expectResultOnly).not.toHaveBeenCalled();
        }
        if (duplicate) {
          expect(getWorkerStorageBinding(coreDb, { storageRef: duplicate.storageRef })).toEqual(
            duplicate
          );
          expect(expectResultOnly).not.toHaveBeenCalled();
        }
        expect(effects).toEqual([]);
        return;
      }

      expect(expectResultOnly).toHaveBeenCalledExactlyOnceWith([
        {
          kind: 'bridge.close',
          originPhysicalEpoch: 'a'.repeat(64),
          requestId: expect.any(String),
        },
        {
          kind: 'sandbox.delete',
          originPhysicalEpoch: 'a'.repeat(64),
          requestId: expect.any(String),
        },
      ]);
      expect(getWorkerStorageBinding(coreDb, { storageRef: reserved.storageRef })).toEqual({
        ...before,
        currentAgentSessionId: null,
        currentSandboxBindingRef: null,
        currentThreadId: null,
        currentWorkSlotRef: null,
        revision: before.revision + 1,
        state: 'idle',
        updatedAt: expect.any(String),
      });
      expect(getWorkerStorageBinding(coreDb, { storageRef: sibling.storageRef })).toEqual(sibling);
      expect(effects).toEqual([]);
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
          extensions: {
            openkit: {
              workerStorage: {
                workSlotRef: workerStorageDefaultWorkSlotRef(
                  'workspace-compatible',
                  `thread-${turnId}`
                ),
              },
            },
          },
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

  it('interrupts a NanoHost Turn only through its materialized Harness session', async () => {
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

      // No worker command queue exists to fall back to.
      for (const snapshotId of [priorPackageSnapshotId, packageSnapshotId]) {
        expect(workerControlGateway.getSessionSnapshot(snapshotId)).not.toHaveProperty('commands');
      }
    } finally {
      coreDb.sqlite.close();
    }
  });

  it.each([
    ['codex', 'interrupt'],
    ['codex', 'failed-closeout'],
    ['codex', 'failed-closeout-refused'],
    ['codex', 'completed'],
    ['codex', 'failed-ready'],
    ['codex', 'failed-ready-unrecorded'],
    ['codex', 'unproved-cleanup'],
    ['codex', 'unproved-cleanup-failed'],
    ['pi', 'interrupt'],
    ['pi', 'failed-closeout'],
    ['pi', 'failed-closeout-refused'],
    ['pi', 'completed'],
    ['pi', 'failed-ready'],
    ['pi', 'failed-ready-unrecorded'],
    ['pi', 'unproved-cleanup'],
    ['pi', 'unproved-cleanup-failed'],
  ] as const)('settles %s %s before terminal Harness inspection', async (adapterId, purpose) => {
    const completed =
      purpose === 'failed-closeout' ||
      purpose === 'failed-closeout-refused' ||
      purpose === 'completed';
    const coreDb = createFactoryCoreDb();
    const effects: NanoHostSessionEffectRequest[] = [];
    const resultOnlyCalls: string[] = [];
    const sessionDispatch: NanoHostSessionDispatch = {
      async effect(requestOrConnection: object, carriedRequest?: NanoHostSessionEffectRequest) {
        const request = carriedRequest ?? (requestOrConnection as NanoHostSessionEffectRequest);
        effects.push(request);
        if (purpose === 'unproved-cleanup-failed' && request.kind === 'sandbox.delete') {
          throw new Error('sandbox delete failed');
        }
        if (request.kind === 'image.acquire') return { digest: `sha256:${'a'.repeat(64)}` };
        if (request.kind === 'image.inspect') return nanoHostImageInspection(request);
        if (request.kind === 'sandbox.create') {
          return nanoHostSandboxCreated(request);
        }
        if (request.kind === 'workspace.collect')
          return request.input.mode === 'baseline'
            ? {
                requestId: request.requestId,
                outcome: 'baseline',
                head: {
                  tree: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
                  manifest: 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391',
                },
              }
            : { requestId: request.requestId, outcome: 'no_new_head', unstable: false };
        if (request.kind === 'reference.import') return { state: 'imported' };
        if (request.kind === 'bridge.open') {
          return { accepted: true, integrationReady: true, state: 'open' };
        }
        if (request.kind === 'bridge.close' || request.kind === 'sandbox.delete') {
          return { state: 'deleted' };
        }
        throw new Error(`Unexpected NanoHost effect: ${request.kind}`);
      },
      async expectResultOnly() {
        resultOnlyCalls.push('expectResultOnly');
        throw new Error('result-only was used before a wider effect was dispatched');
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
      let environmentPackage = completeNanoHostPackage({
        extensions: {
          openkit: {
            workerStorage: {
              workSlotRef: workerStorageDefaultWorkSlotRef(
                'workspace_human_gate',
                'thread_human_gate'
              ),
            },
          },
        },
        scope: {
          agentSessionId: 'as_human_gate',
          threadId: 'thread_human_gate',
          turnId: 'turn_human_gate',
          workspaceId: 'workspace_human_gate',
        },
        snapshotId: 'aepsnap_human_gate',
      });
      environmentPackage.control.adapter.targetRuntime = adapterId;
      environmentPackage.agent.runtimeVersion = adapterId === 'pi' ? '0.85.1' : '0.153.4';
      let fixtureRepositoryPath: string | null = null;
      if (adapterId === 'pi' && purpose === 'completed') {
        fixtureRepositoryPath = mkdtempSync(join(tmpdir(), 'n6-comparable-repository-'));
        execFileSync('git', ['init', '--object-format=sha1', fixtureRepositoryPath], {
          stdio: 'ignore',
        });
        execFileSync(
          'git',
          [
            '-C',
            fixtureRepositoryPath,
            '-c',
            'user.name=Fixture',
            '-c',
            'user.email=fixture@example.invalid',
            'commit',
            '--allow-empty',
            '-m',
            'baseline',
          ],
          { stdio: 'ignore' }
        );
        const gitCommit = execFileSync('git', ['-C', fixtureRepositoryPath, 'rev-parse', 'HEAD'], {
          encoding: 'utf8',
        }).trim();
        const setup = createTestAgentSetup({ adapter: 'pi' });
        environmentPackage = resolveAgentEnvironmentPackage({
          captureCoverage: { scope: 'server', value: 'off' },
          agentSessionId: 'as_human_gate',
          agentSetup: {
            ...setup,
            manifest: {
              ...setup.manifest,
              runtime: { ...setup.manifest.runtime, version: '0.85.1' },
              workspace: { inputs: [{ access: 'read-write', id: 'repo', sourceRef: 'main-repo' }] },
            },
          },
          backend: { kind: 'openshell' },
          createdAt: '2026-09-03T00:00:00.000Z',
          requestId: null,
          triggerActor: environmentPackage.scope.triggerActor,
          turn: {
            completedAt: null,
            configVersion: null,
            durationMs: null,
            error: null,
            id: 'turn_human_gate',
            items: [],
            startedAt: '2026-09-03T00:00:00.000Z',
            status: 'running',
            threadId: 'thread_human_gate',
            triggerActor: environmentPackage.scope.triggerActor,
            workspaceId: 'workspace_human_gate',
          },
          workspaceCwd: '/workspace/openkit',
          workspaceRoots: [
            {
              access: 'read-write',
              id: 'repo',
              sourceCommit: gitCommit,
              sourceKind: 'remote-git',
              workerPath: '/workspace/openkit',
            },
          ],
          workspaceSourceRefs: { repo: 'main-repo' },
          workspaceDataSourceCatalog: {
            schemaVersion: 1,
            requiredFeatures: [],
            extensions: {},
            sources: [
              {
                access: 'read-write',
                allowedSlotKinds: ['worktree'],
                displayName: 'Remote repository',
                extensions: {},
                id: 'main-repo',
                kind: 'git',
                locator: {
                  url: 'https://git.example.test/openkit/repository.git',
                  commit: gitCommit,
                },
                requiredFeatures: [],
                sensitivity: 'internal',
                status: 'active',
                syncHints: {},
              },
            ],
          },
        });
        const canonicalKey = (
          environmentPackage.extensions.openkit as {
            sessionWorkspace: SessionWorkspaceMaterializationPlan;
          }
        ).sessionWorkspace.compatibilityKey.digest;
        expect(environmentPackage.workspace.inputs[0]?.target).toMatch(/^\/workspace\/worktrees\//);
        expect(environmentPackage.policy.filesystem?.rules).toContainEqual(
          expect.objectContaining({
            id: 'repo',
            workerPath: environmentPackage.workspace.inputs[0]!.target,
          })
        );
        // The stored key precedes the resolver's policy-path rewrite; hashing returned bytes differs.
        expect(
          planSessionWorkspaceMaterialization({ environmentPackage }).compatibilityKey.digest
        ).not.toBe(canonicalKey);
      }
      authorizeNanoHostPackage(coreDb, environmentPackage);
      if (fixtureRepositoryPath) {
        const db = openWorkspaceDb(coreDb.dataRoot, environmentPackage.scope.workspaceId);
        try {
          applyScopedMigrations(db);
          upsertWorkspaceRepositoryResource(db, {
            workspaceId: environmentPackage.scope.workspaceId,
            resourceId: 'repo',
            displayName: 'Comparable initial source',
            localPath: fixtureRepositoryPath,
            workspaceExists: () => true,
          });
        } finally {
          db.sqlite.close();
        }
      }

      bindNanoHostWorkerLineage(coreDb, environmentPackage, {
        leaseId: 'lease_human_gate',
        now: '2026-09-03T00:00:00.000Z',
        planId: 'plan_human_gate',
        sandboxBindingRef: 'sandbox-binding:resident-session',
        selectedPoolId: 'pool_human_gate',
        selectedTargetId: 'target_human_gate',
      });
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
      if (adapterId === 'pi' && purpose === 'completed') {
        for (const digest of [undefined, 'sha256:invalid']) {
          const invalidPackage = structuredClone(environmentPackage);
          const openkit = invalidPackage.extensions.openkit as Record<string, unknown>;
          if (digest === undefined) delete openkit.sessionWorkspace;
          else {
            const plan = openkit.sessionWorkspace as SessionWorkspaceMaterializationPlan;
            plan.compatibilityKey.digest = digest;
          }
          await expect(
            backend.materialize(invalidPackage, { workspaceRoots: [] })
          ).rejects.toThrow();
          expect(effects).toEqual([]);
          expect(
            coreDb.sqlite
              .prepare('SELECT COUNT(*) AS count FROM agent_session_runtime_bindings')
              .get()
          ).toEqual({ count: 0 });
        }
      }
      anchorNanoHostMaterialization(coreDb, backend, environmentPackage);
      const materialization = await backend.materialize(environmentPackage, {
        runtimeEnvCredentials: [
          { targetEnvVarName: 'GITHUB_TOKEN', credentialValue: 'private-dispatch-env-canary' },
        ],
        workspaceRoots: [],
      });
      const recordedDigests: string[] = [];
      const proofRoot =
        purpose === 'failed-ready'
          ? mkdtempSync(join(tmpdir(), 'openkit-factory-failed-ready-'))
          : null;
      const proofStore = proofRoot ? createDemoStore({ dataRoot: proofRoot }) : null;
      if (proofStore) {
        const proofTurn = proofStore.createTurn(
          'ws_demo',
          'th_demo',
          'Failed ready proof',
          { kind: 'user', id: 'user_local' },
          null,
          { turnId: 'turn_factory_failed_ready' }
        );
        proofStore.updateTurn(proofTurn.id, { agentId: 'agent_codex_host' });
        proofStore.createAgentSession({
          agentId: 'agent_codex_host',
          createdAt: '2026-09-03T00:00:00.000Z',
          id: 'as_factory_failed_ready',
          message: null,
          status: 'idle',
          threadId: proofTurn.threadId,
          updatedAt: '2026-09-03T00:00:00.000Z',
          workspaceId: proofTurn.workspaceId,
        });
      }
      backend.bindNativeHandleRecorder?.(environmentPackage.snapshotId, (digest) => {
        if (purpose === 'failed-ready-unrecorded') {
          throw new Error('recorder failed');
        }
        recordedDigests.push(digest);
        if (
          proofStore &&
          proofStore.getAgentSession('as_factory_failed_ready').nativeHandleDigest !== digest
        ) {
          proofStore.updateAgentSession('as_factory_failed_ready', {
            nativeHandleDigest: digest,
            updatedAt: '2026-09-03T00:00:01.000Z',
          });
        }
      });
      expect(effects.some((effect) => effect.kind === 'reference.import')).toBe(false);
      const integration = coreDb.sqlite
        .prepare(
          `SELECT sandbox_integration_binding_ref AS integrationRef
           FROM sandbox_runtime_records
           LIMIT 1`
        )
        .get() as { integrationRef: string };
      let startedTurns = 0;
      const settleNext = async (
        operation:
          | 'session.open'
          | 'turn.start'
          | 'turn.interrupt'
          | 'session.inspect'
          | 'session.close',
        body: Readonly<Record<string, unknown>>,
        disposition: 'succeeded' | 'refused' = 'succeeded'
      ) => {
        let command: ReturnType<typeof dispatchNanoHostHarnessOperation> = null;
        for (let attempt = 0; attempt < 200 && !command; attempt += 1) {
          command = dispatchNanoHostHarnessOperation(coreDb, {
            sandboxIntegrationBindingRef: integration.integrationRef,
          });
          if (!command) await new Promise<void>((resolve) => setTimeout(resolve, 1));
        }
        if (!command || command.operation !== operation) {
          throw new Error(`Expected queued ${operation} Harness command.`);
        }
        if (operation === 'session.open') {
          expect(effects.some((effect) => effect.kind === 'reference.import')).toBe(true);
          expect(command.body).toMatchObject({
            capabilityLoopbackCredential: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
            inferenceLoopbackCredential: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
            resume: null,
          });
        }
        if (operation === 'turn.start') {
          startedTurns += 1;
          expect(
            effects
              .filter((effect) => effect.kind === 'reference.import')
              .map((effect) => effect.input.slot)
          ).toEqual(Array(startedTurns).fill('package-config'));
          expect(command.body).toMatchObject({
            aepRef: '/openkit/sessions/as_human_gate/config/package.json',
            contextRef: '/openkit/sessions/as_human_gate/context',
          });
        }
        const wireCommand = runtime.acceptNanoHostHarnessCommand(command);
        if (operation === 'session.open') {
          // Session-static credential material is delivered once, with the binding.
          expect(wireCommand.body.runtimeEnvironment).toEqual({
            GITHUB_TOKEN: 'private-dispatch-env-canary',
          });
          expect(command.body).not.toHaveProperty('runtimeEnvironment');
          const durable = JSON.stringify(
            coreDb.sqlite.prepare('SELECT * FROM harness_instance_records').all()
          );
          expect(JSON.stringify(effects)).not.toContain('private-dispatch-env-canary');
          expect(durable).not.toContain('private-dispatch-env-canary');
          expect(durable).not.toContain(String(command.body.inferenceLoopbackCredential));
          expect(durable).not.toContain(String(command.body.capabilityLoopbackCredential));
        }
        if (operation === 'turn.start') {
          expect(wireCommand.body).not.toHaveProperty('runtimeEnvironment');
        }
        const result = {
          body,
          disposition,
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

      if (
        purpose === 'failed-ready-unrecorded' ||
        purpose === 'unproved-cleanup' ||
        purpose === 'unproved-cleanup-failed'
      ) {
        const identity = backend.planSession(environmentPackage);
        if (purpose === 'failed-ready-unrecorded') {
          let unrecordedState = 'pending';
          const unrecorded = backend
            .inspectTerminalHarnessSession(backend.sessions.get(environmentPackage.snapshotId))
            .then(
              () => {
                unrecordedState = 'resolved';
              },
              (error) => {
                unrecordedState = 'rejected';
                throw error;
              }
            );
          void unrecorded.catch(() => undefined);
          await new Promise<void>((resolve) => setImmediate(resolve));
          expect(unrecordedState).toBe('pending');
          await settleNext('session.inspect', {
            childState: 'running',
            cleanupState: 'clean',
            nativeHandleDigest: 'a'.repeat(64),
            nativeHandleState: 'ready',
            state: 'failed',
          });
          await expect(unrecorded).rejects.toThrow(/recorder failed/);
          expect(
            coreDb.sqlite
              .prepare('SELECT native_handle_digest AS digest FROM agent_session_runtime_bindings')
              .get()
          ).toEqual({ digest: 'a'.repeat(64) });
          await expect(backend.cleanupSession(identity)).rejects.toThrow(/could not be recorded/);
          expect(
            coreDb.sqlite
              .prepare('SELECT COUNT(*) AS count FROM agent_session_runtime_bindings')
              .get()
          ).toEqual({ count: 1 });
          expect(
            coreDb.sqlite
              .prepare('SELECT cleanup_state AS cleanupState FROM sandbox_runtime_records')
              .get()
          ).toEqual({ cleanupState: 'clean' });
          expect(
            coreDb.sqlite
              .prepare(
                `SELECT drain_state AS drainState, lifecycle_state AS lifecycleState
                   FROM harness_instance_records`
              )
              .get()
          ).toEqual({ drainState: 'draining', lifecycleState: 'failed' });
          expect(effects.map((effect) => effect.kind)).not.toContain('bridge.close');
          expect(effects.map((effect) => effect.kind)).not.toContain('sandbox.delete');
          expect(backend.sessions.has(environmentPackage.snapshotId)).toBe(true);
          expect(resultOnlyCalls).toEqual([]);
          return;
        }
        const stopUnproved = backend.interruptTurn(environmentPackage.snapshotId);
        await settleNext('turn.interrupt', { reasonCode: 'cleanup_required' }, 'refused');
        await expect(stopUnproved).rejects.toThrow(/turn.interrupt refused: cleanup_required/);
        expect(
          coreDb.sqlite
            .prepare(
              `SELECT drain_state AS drainState, lifecycle_state AS lifecycleState
                 FROM harness_instance_records`
            )
            .get()
        ).toEqual({ drainState: 'draining', lifecycleState: 'failed' });
        const cleanupUnproved = backend.cleanupSession(identity);
        await settleNext('session.close', { reasonCode: 'cleanup_required' }, 'refused');
        if (purpose === 'unproved-cleanup-failed') {
          await expect(cleanupUnproved).rejects.toThrow(/sandbox delete failed/);
          expect(
            coreDb.sqlite
              .prepare(
                `SELECT cleanup_state AS cleanupState, drain_state AS drainState
                   FROM sandbox_runtime_records`
              )
              .get()
          ).toEqual({ cleanupState: 'unknown', drainState: 'draining' });
          expect(
            coreDb.sqlite
              .prepare(
                `SELECT active_turn_count AS activeTurnCount, drain_state AS drainState,
                        lifecycle_state AS lifecycleState, open_session_count AS openSessionCount
                   FROM harness_instance_records`
              )
              .get()
          ).toEqual({
            activeTurnCount: 1,
            drainState: 'draining',
            lifecycleState: 'failed',
            openSessionCount: 1,
          });
          expect(
            coreDb.sqlite
              .prepare('SELECT COUNT(*) AS count FROM agent_session_runtime_bindings')
              .get()
          ).toEqual({ count: 1 });
        } else {
          await cleanupUnproved;
          expect(
            coreDb.sqlite
              .prepare('SELECT COUNT(*) AS count FROM agent_session_runtime_bindings')
              .get()
          ).toEqual({ count: 0 });
          expect(
            coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM sandbox_runtime_records').get()
          ).toEqual({ count: 0 });
          expect(
            coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM harness_instance_records').get()
          ).toEqual({ count: 0 });
        }
        expect(effects.map((effect) => effect.kind)).toEqual([
          'image.acquire',
          'image.inspect',
          'sandbox.create',
          'bridge.open',
          'reference.import',
          'workspace.collect',
          'workspace.collect',
          'bridge.close',
          'sandbox.delete',
        ]);
        expect(resultOnlyCalls).toEqual([]);
        return;
      }

      const stop = completed
        ? Promise.resolve()
        : backend.interruptTurn(environmentPackage.snapshotId);
      recordWorkerControlAcceptedRecord(coreDb, {
        acceptedAt: '2026-09-06T00:00:01.000Z',
        lineage: {
          ...environmentPackage.scope,
          packageSnapshotId: environmentPackage.snapshotId,
        },
        operation: 'final_status',
        record: completed
          ? { sequence: 1, status: 'completed', stopReason: 'completed' }
          : { sequence: 1, status: 'interrupted', stopReason: 'aborted' },
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
      let interruptSequence: number | undefined;
      if (!completed) {
        const interrupt = await settleNext('turn.interrupt', { state: 'interrupted' });
        expect(interrupt.body).toMatchObject({
          agentSessionId: 'as_human_gate',
          leaseId: 'lease_human_gate',
          purpose: 'interrupt',
          turnId: 'turn_human_gate',
        });
        interruptSequence = interrupt.sequence;
      }
      await stop;
      // The resident host keeps running; clean disposable state, not child exit, is the barrier.
      const readyFailed = purpose === 'failed-ready';
      const inspected = await settleNext('session.inspect', {
        childState: 'running',
        cleanupState: 'clean',
        nativeHandleDigest: completed || readyFailed ? 'a'.repeat(64) : null,
        nativeHandleState: completed || readyFailed ? 'ready' : 'pending',
        state: readyFailed ? 'failed' : 'open',
      });
      if (interruptSequence !== undefined) expect(inspected.sequence).toBe(interruptSequence + 1);
      await inspection;
      expect(inspectionState).toBe('resolved');
      expect(backend.sessions.get(environmentPackage.snapshotId)).toMatchObject({
        nativeSessionReusable: completed,
        terminalInspectionComplete: true,
      });
      expect(recordedDigests).toEqual(
        completed || purpose === 'failed-ready' ? ['a'.repeat(64)] : []
      );
      const identity = backend.planSession(environmentPackage);
      const cleanup =
        purpose === 'failed-closeout' || purpose === 'failed-closeout-refused'
          ? backend.cleanupSession(identity, { failedCloseout: true })
          : backend.cleanupSession(identity);
      if (purpose === 'failed-closeout-refused') {
        await settleNext('session.close', { reasonCode: 'conflict' }, 'refused');
        await expect(cleanup).rejects.toThrow(/session.close refused/);
      } else if (purpose !== 'completed') {
        await settleNext('session.close', {
          childState: 'absent',
          privateState: 'absent',
          state: 'closed',
        });
        await cleanup;
      } else {
        await cleanup;
      }
      const retainedBinding = purpose === 'completed' || purpose === 'failed-closeout-refused';
      expect(
        coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM agent_session_runtime_bindings').get()
      ).toEqual({ count: retainedBinding ? 1 : 0 });
      if (completed) {
        const harness = coreDb.sqlite
          .prepare(
            'SELECT harness_instance_id AS harnessInstanceId FROM harness_instance_records LIMIT 1'
          )
          .get() as { readonly harnessInstanceId: string };
        const admitNext = () =>
          openNanoHostAgentSessionBinding(coreDb, {
            agentSessionCompatibilityKey: 'e'.repeat(64),
            agentSessionId: 'as_human_gate_next',
            agentSessionRuntimeBindingId: 'binding_human_gate_next',
            effectiveSetupGeneration: 1,
            harnessInstanceId: harness.harnessInstanceId,
            threadId: environmentPackage.scope.threadId,
            timestamp: '2026-09-17T00:00:02.000Z',
            workspaceId: environmentPackage.scope.workspaceId,
          });
        if (purpose === 'failed-closeout') {
          expect(admitNext).not.toThrow();
        } else {
          expect(admitNext).toThrow(
            'NanoHost Harness already has a current AgentSession for this Thread.'
          );
        }
      }
      expect(effects.map((effect) => effect.kind)).toEqual([
        'image.acquire',
        'image.inspect',
        'sandbox.create',
        'bridge.open',
        'reference.import',
        'workspace.collect',
        ...(purpose !== 'completed' && purpose !== 'failed-ready-unrecorded'
          ? ['workspace.collect']
          : []),
        ...(purpose === 'unproved-cleanup' || purpose === 'unproved-cleanup-failed'
          ? ['bridge.close', 'sandbox.delete']
          : []),
      ]);
      expect(
        coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM sandbox_runtime_records').get()
      ).toEqual({ count: 1 });
      if (purpose === 'failed-ready' && proofRoot) {
        const reloaded = createDemoStore({ dataRoot: proofRoot });
        expect(reloaded.getAgentSession('as_factory_failed_ready').nativeHandleDigest).toBe(
          'a'.repeat(64)
        );
      }
      if (purpose === 'completed') {
        coreDb.sqlite
          .prepare("UPDATE scheduler_session_leases SET status = 'released' WHERE lease_id = ?")
          .run('lease_human_gate');
        const nextPackage = {
          ...environmentPackage,
          scope: { ...environmentPackage.scope, turnId: 'turn_human_gate_next' },
          snapshotId: 'aepsnap_human_gate_next',
        };
        await expect(
          backend.prepareAgentSessionContinuity?.({
            agentSessionCompatibilityKey: (
              nextPackage.extensions.openkit as {
                sessionWorkspace: SessionWorkspaceMaterializationPlan;
              }
            ).sessionWorkspace.compatibilityKey.digest,
            agentSessionId: environmentPackage.scope.agentSessionId,
            environmentPackage: nextPackage,
            reuseAllowed: true,
            threadId: environmentPackage.scope.threadId,
            workspaceId: environmentPackage.scope.workspaceId,
          })
        ).resolves.toBe('reusable');
        bindNanoHostWorkerLineage(coreDb, nextPackage, {
          leaseId: 'lease_human_gate_next',
          selectedPoolId: 'pool_human_gate',
          selectedTargetId: 'target_human_gate',
          sandboxBindingRef: 'sandbox-binding:resident-session-next',
        });
        anchorNanoHostMaterialization(coreDb, backend, nextPackage);
        const nextMaterialization = await backend.materialize(nextPackage, {
          runtimeEnvCredentials: [
            { targetEnvVarName: 'GITHUB_TOKEN', credentialValue: 'private-dispatch-env-canary' },
          ],
          workspaceRoots: [],
        });
        const nextLaunch = backend.launch(nextMaterialization);
        // The next Turn reuses the open binding: an inspection, then turn.start, and no session.open.
        const reuseInspection = await settleNext('session.inspect', {
          childState: 'running',
          cleanupState: 'clean',
          nativeHandleDigest: 'a'.repeat(64),
          nativeHandleState: 'ready',
          state: 'open',
        });
        expect(reuseInspection.body.agentSessionId).toBe(environmentPackage.scope.agentSessionId);
        const nextStart = await settleNext('turn.start', {
          nativeHandleDigest: 'a'.repeat(64),
          nativeHandleState: 'ready',
          state: 'started',
        });
        await nextLaunch;
        expect(nextStart.body).toMatchObject({
          agentSessionId: environmentPackage.scope.agentSessionId,
          turnId: nextPackage.scope.turnId,
          turnSequence: 1,
        });
        expect(
          coreDb.sqlite
            .prepare(
              `SELECT agent_session_id AS agentSessionId, native_handle_digest AS digest,
                      current_turn_id AS turnId FROM agent_session_runtime_bindings`
            )
            .all()
        ).toEqual([
          {
            agentSessionId: environmentPackage.scope.agentSessionId,
            digest: 'a'.repeat(64),
            turnId: nextPackage.scope.turnId,
          },
        ]);
      }
    } finally {
      coreDb.sqlite.close();
    }
  });

  it.each([
    {
      expected: true,
      inspection: { cleanupState: 'clean', digest: 'a'.repeat(64), state: 'open' },
      name: 'keeps a proved binding reusable after an unsuccessful later Turn',
      proved: 'a'.repeat(64),
      recorded: ['a'.repeat(64)],
      resume: null,
    },
    {
      expected: false,
      inspection: { cleanupState: 'clean', digest: 'b'.repeat(64), state: 'open' },
      name: 'refuses reuse when the handle digest changed',
      proved: 'a'.repeat(64),
      recorded: [],
      resume: null,
    },
    {
      expected: false,
      inspection: { cleanupState: 'clean', digest: null, state: 'open' },
      name: 'refuses reuse of a first Turn that ended without completion or proof',
      proved: null,
      recorded: [],
      resume: null,
    },
    {
      expected: false,
      inspection: { cleanupState: 'clean', digest: 'c'.repeat(64), state: 'open' },
      name: 'records the proof of a first Turn that ended without completion but refuses reuse',
      proved: null,
      recorded: ['c'.repeat(64)],
      resume: null,
    },
    {
      expected: false,
      inspection: { cleanupState: 'pending', digest: 'a'.repeat(64), state: 'failed' },
      name: 'refuses reuse of a failed binding',
      proved: 'a'.repeat(64),
      recorded: ['a'.repeat(64)],
      resume: null,
    },
    {
      expected: false,
      inspection: { cleanupState: 'clean', digest: 'd'.repeat(64), state: 'failed' },
      name: 'records the ready proof of a failed first binding and refuses reuse',
      proved: null,
      recorded: ['d'.repeat(64)],
      resume: null,
    },
    {
      expected: false,
      inspection: { cleanupState: 'clean', digest: 'b'.repeat(64), state: 'open' },
      name: 'refuses a ready proof that disagrees with the carried resume digest',
      proved: null,
      recorded: [],
      resume: 'a'.repeat(64),
    },
    {
      expected: false,
      inspection: { cleanupState: 'clean', digest: 'a'.repeat(64), state: 'open' },
      name: 'records a first ready proof that agrees with the carried resume and refuses reuse without completion',
      proved: null,
      recorded: ['a'.repeat(64)],
      resume: 'a'.repeat(64),
    },
    {
      expected: 'throws',
      inspection: { cleanupState: 'pending', digest: 'a'.repeat(64), state: 'active' },
      name: 'rejects an inspection that has not reached the Turn barrier',
      proved: 'a'.repeat(64),
      recorded: ['a'.repeat(64)],
      resume: null,
    },
  ] as const)('terminal inspection $name', async ({
    expected,
    inspection,
    proved,
    recorded,
    resume,
  }) => {
    const coreDb = createFactoryCoreDb();
    try {
      const runtime = createConfiguredWorkerLifecycleRuntime({
        coreDb,
        env: {},
        workerControlGateway: new WorkerControlGateway(),
      });
      const backend = (
        runtime.turnExecutor as unknown as {
          readonly backend: {
            inspectTerminalHarnessSession(session: unknown): Promise<void>;
            queueAndWaitForHarnessOperation(
              session: unknown,
              operation: string,
              body: Readonly<Record<string, unknown>>
            ): Promise<Readonly<Record<string, unknown>>>;
          };
        }
      ).backend;
      const environmentPackage = {
        scope: {
          agentSessionId: 'as_factory_inspect',
          requestId: null,
          threadId: 'thread_factory_inspect',
          turnId: 'turn_factory_inspect',
          workspaceId: 'workspace_factory_inspect',
        },
        snapshotId: 'aepsnap_factory_inspect',
      } as AgentEnvironmentPackage;
      const recordedDigests: string[] = [];
      const binding = {
        agentSessionCompatibilityKey: 'compatibility',
        agentSessionRuntimeBindingId: 'binding_factory_inspect',
        nativeHandleDigest: proved as string | null,
        nextTurnSequence: 2,
      };
      const session = {
        agentSessionRuntimeBindingId: 'binding_factory_inspect',
        environmentPackage,
        leaseId: 'lease_factory_inspect',
        nativeResume: resume ? { digest: resume, locator: 'as_factory_predecessor' } : null,
        nativeSessionReusable: false,
        recordNativeHandleDigest: (digest: string) => {
          recordedDigests.push(digest);
        },
        sharedHarness: {
          adapterId: 'codex',
          bindings: new Map([[environmentPackage.scope.agentSessionId, binding]]),
        },
        terminalInspectionComplete: false,
        turnStopSettlement: Promise.resolve(),
      };
      const operations: string[] = [];
      backend.queueAndWaitForHarnessOperation = async (_session, operation) => {
        operations.push(operation);
        return {
          // A resident host is still running at the barrier; child state is not the proof.
          childState: 'running',
          cleanupState: inspection.cleanupState,
          nativeHandleDigest: inspection.digest,
          nativeHandleState: inspection.digest ? 'ready' : 'pending',
          state: inspection.state,
        };
      };

      if (expected === 'throws') {
        await expect(backend.inspectTerminalHarnessSession(session)).rejects.toThrow(
          'terminal session inspection is incompatible'
        );
        expect(session.terminalInspectionComplete).toBe(false);
        // Rejection of the barrier keeps the already accepted proof on the binding.
        expect(binding.nativeHandleDigest).toBe(recorded.at(-1) ?? proved);
      } else {
        await backend.inspectTerminalHarnessSession(session);
        expect(session).toMatchObject({
          nativeSessionReusable: expected,
          terminalInspectionComplete: true,
        });
        expect(binding.nativeHandleDigest).toBe(recorded.at(-1) ?? proved);
      }
      // Any exact ready proof reaches the AgentSession owner whether or not reuse follows.
      expect(recordedDigests).toEqual(recorded);
      // Inspection alone never closes the binding; closeout decides that from reusability.
      expect(operations).toEqual(['session.inspect']);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('refuses terminal inspection before dispatch when the AgentSession recorder is absent', async () => {
    const coreDb = createFactoryCoreDb();
    try {
      const runtime = createConfiguredWorkerLifecycleRuntime({
        coreDb,
        env: {},
        workerControlGateway: new WorkerControlGateway(),
      });
      const backend = (
        runtime.turnExecutor as unknown as {
          readonly backend: {
            inspectTerminalHarnessSession(session: unknown): Promise<void>;
            queueAndWaitForHarnessOperation(
              session: unknown,
              operation: string,
              body: Readonly<Record<string, unknown>>
            ): Promise<Readonly<Record<string, unknown>>>;
          };
        }
      ).backend;
      const operations: string[] = [];
      const session = {
        environmentPackage: {
          scope: {
            agentSessionId: 'as_factory_inspect',
            requestId: null,
            threadId: 'thread_factory_inspect',
            turnId: 'turn_factory_inspect',
            workspaceId: 'workspace_factory_inspect',
          },
          snapshotId: 'aepsnap_factory_inspect',
        },
        recordNativeHandleDigest: null,
        sharedHarness: { bindings: new Map() },
        terminalInspectionComplete: false,
        turnStopSettlement: Promise.resolve(),
      };
      backend.queueAndWaitForHarnessOperation = async () => {
        operations.push('session.inspect');
        return {
          cleanupState: 'clean',
          nativeHandleDigest: 'a'.repeat(64),
          nativeHandleState: 'ready',
          state: 'failed',
        };
      };
      await expect(backend.inspectTerminalHarnessSession(session)).rejects.toThrow(
        'NanoHost terminal inspection requires its AgentSession recorder before dispatch.'
      );
      expect(operations).toEqual([]);
      expect(session.terminalInspectionComplete).toBe(false);
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

  it('deletes a live created Sandbox and releases its reservation when attachment activation fails before session registration', async () => {
    const fixture = await failLivePartialSandboxActivation('live_partial_activation');
    try {
      const before = getWorkerStorageBinding(fixture.coreDb, { storageRef: fixture.storageRef })!;
      const contributors = fixture.coreDb.sqlite
        .prepare('SELECT COUNT(*) AS count FROM worker_storage_contributors WHERE storage_ref = ?')
        .get(fixture.storageRef) as { readonly count: number };
      const sibling = createWorkerStorageBinding(fixture.coreDb, {
        deploymentId: fixture.identity.deploymentId,
        layout: before.layout,
        runtimeTargetId: fixture.identity.runtimeTargetId,
        workspaceId: fixture.environmentPackage.scope.workspaceId,
      });
      const siblingReserved = reserveWorkerStorageAttachment(fixture.coreDb, {
        agentSessionId: 'as_live_partial_sibling',
        authorizeContributor: () => true,
        expectedRevision: sibling.revision,
        layout: before.layout,
        purpose: 'work',
        responsibleUserId: 'user-factory',
        runtimeTargetId: fixture.identity.runtimeTargetId,
        storageRef: sibling.storageRef,
        threadId: 'thread_live_partial_sibling',
        workspaceId: fixture.environmentPackage.scope.workspaceId,
      });
      transitionWorkerBackendSessionState(fixture.coreDb, {
        fromState: 'materializing',
        leaseId: fixture.leaseId,
        now: () => '2026-08-21T00:00:01.000Z',
        toState: 'cleanup-pending',
      });

      await expect(
        fixture.runtime.cleanupBackendSession(fixture.identity)
      ).resolves.toBeUndefined();

      expect(fixture.expectResultOnly).not.toHaveBeenCalled();
      expect(fixture.effects.slice(3).map((effect) => effect.kind)).toEqual(['sandbox.delete']);
      expect(fixture.effects[3]).toMatchObject({
        input: { leaseId: fixture.leaseId, sandboxId: fixture.effects[2]?.input.sandboxId },
      });
      expect(
        getWorkerStorageBinding(fixture.coreDb, { storageRef: fixture.storageRef })
      ).toMatchObject({
        attachmentGeneration: before.attachmentGeneration,
        currentAgentSessionId: null,
        currentSandboxBindingRef: null,
        currentThreadId: null,
        currentWorkSlotRef: null,
        revision: before.revision + 1,
        state: 'idle',
      });
      expect(
        fixture.coreDb.sqlite
          .prepare(
            'SELECT COUNT(*) AS count FROM worker_storage_contributors WHERE storage_ref = ?'
          )
          .get(fixture.storageRef)
      ).toEqual(contributors);
      expect(
        getWorkerStorageBinding(fixture.coreDb, { storageRef: siblingReserved.storageRef })
      ).toMatchObject({ revision: siblingReserved.revision, state: 'reserved' });
    } finally {
      fixture.coreDb.sqlite.close();
    }
  });

  it('keeps the reservation when live partial Sandbox deletion fails and does not replay it', async () => {
    const fixture = await failLivePartialSandboxActivation('live_partial_delete_failure', {
      deleteError: new Error('Sandbox cleanup delete-failed.'),
    });
    try {
      transitionWorkerBackendSessionState(fixture.coreDb, {
        fromState: 'materializing',
        leaseId: fixture.leaseId,
        now: () => '2026-08-21T00:00:01.000Z',
        toState: 'cleanup-pending',
      });
      await expect(fixture.runtime.cleanupBackendSession(fixture.identity)).rejects.toThrow(
        'Sandbox cleanup delete-failed.'
      );
      expect(fixture.expectResultOnly).not.toHaveBeenCalled();
      expect(fixture.effects.filter((effect) => effect.kind === 'sandbox.delete')).toHaveLength(1);
      expect(
        getWorkerStorageBinding(fixture.coreDb, { storageRef: fixture.storageRef })
      ).toMatchObject({ state: 'reserved' });

      await expect(fixture.runtime.cleanupBackendSession(fixture.identity)).rejects.toThrow(
        'already dispatched'
      );
      expect(fixture.effects.filter((effect) => effect.kind === 'sandbox.delete')).toHaveLength(1);
      expect(
        getWorkerStorageBinding(fixture.coreDb, { storageRef: fixture.storageRef })
      ).toMatchObject({ state: 'reserved' });
      expect(
        retainsLivePartialMaterialization(fixture.backend, fixture.environmentPackage.snapshotId)
      ).toBe(true);

      transitionWorkerBackendSessionState(fixture.coreDb, {
        fromState: 'cleanup-pending',
        leaseId: fixture.leaseId,
        now: () => '2026-08-21T00:00:02.000Z',
        toState: 'cleanup-failed',
      });
      fixture.coreDb.sqlite
        .prepare('UPDATE nanohost_runtime_targets SET physical_epoch = ? WHERE target_id = ?')
        .run('b'.repeat(64), fixture.identity.runtimeTargetId);
      await expect(
        fixture.runtime.cleanupBackendSession(fixture.identity)
      ).resolves.toBeUndefined();
      expect(fixture.effects.filter((effect) => effect.kind === 'sandbox.delete')).toHaveLength(1);
      expect(
        getWorkerStorageBinding(fixture.coreDb, { storageRef: fixture.storageRef })
      ).toMatchObject({
        currentAgentSessionId: null,
        currentSandboxBindingRef: null,
        state: 'idle',
      });
      expect(
        retainsLivePartialMaterialization(fixture.backend, fixture.environmentPackage.snapshotId)
      ).toBe(false);
    } finally {
      fixture.coreDb.sqlite.close();
    }
  });

  it('does not release storage when the reservation revision changes during live partial deletion', async () => {
    const fixture = await failLivePartialSandboxActivation('live_partial_revision', {
      duringDelete: (coreDb, storageRef) => {
        coreDb.sqlite
          .prepare(
            'UPDATE worker_storage_bindings SET revision = revision + 1 WHERE storage_ref = ?'
          )
          .run(storageRef);
      },
    });
    try {
      const before = getWorkerStorageBinding(fixture.coreDb, { storageRef: fixture.storageRef })!;
      transitionWorkerBackendSessionState(fixture.coreDb, {
        fromState: 'materializing',
        leaseId: fixture.leaseId,
        now: () => '2026-08-21T00:00:01.000Z',
        toState: 'cleanup-pending',
      });
      await expect(fixture.runtime.cleanupBackendSession(fixture.identity)).rejects.toThrow(
        'Worker storage revision changed.'
      );
      expect(fixture.expectResultOnly).not.toHaveBeenCalled();
      expect(fixture.effects.filter((effect) => effect.kind === 'sandbox.delete')).toHaveLength(1);
      expect(
        getWorkerStorageBinding(fixture.coreDb, { storageRef: fixture.storageRef })
      ).toMatchObject({ revision: before.revision + 1, state: 'reserved' });
    } finally {
      fixture.coreDb.sqlite.close();
    }
  });

  it('does not delete a live partial Sandbox after its physical Epoch changes', async () => {
    const fixture = await failLivePartialSandboxActivation('live_partial_epoch');
    try {
      fixture.coreDb.sqlite
        .prepare('UPDATE nanohost_runtime_targets SET physical_epoch = ? WHERE target_id = ?')
        .run('b'.repeat(64), fixture.identity.runtimeTargetId);
      transitionWorkerBackendSessionState(fixture.coreDb, {
        fromState: 'materializing',
        leaseId: fixture.leaseId,
        now: () => '2026-08-21T00:00:01.000Z',
        toState: 'cleanup-pending',
      });
      await expect(fixture.runtime.cleanupBackendSession(fixture.identity)).rejects.toThrow(
        'physical Epoch changed'
      );
      expect(fixture.expectResultOnly).not.toHaveBeenCalled();
      expect(fixture.effects.map((effect) => effect.kind)).not.toContain('sandbox.delete');
      expect(
        getWorkerStorageBinding(fixture.coreDb, { storageRef: fixture.storageRef })
      ).toMatchObject({ state: 'reserved' });
      expect(
        retainsLivePartialMaterialization(fixture.backend, fixture.environmentPackage.snapshotId)
      ).toBe(true);

      transitionWorkerBackendSessionState(fixture.coreDb, {
        fromState: 'cleanup-pending',
        leaseId: fixture.leaseId,
        now: () => '2026-08-21T00:00:02.000Z',
        toState: 'cleanup-failed',
      });
      await expect(
        fixture.runtime.cleanupBackendSession(fixture.identity)
      ).resolves.toBeUndefined();
      expect(fixture.effects.map((effect) => effect.kind)).not.toContain('sandbox.delete');
      expect(
        getWorkerStorageBinding(fixture.coreDb, { storageRef: fixture.storageRef })
      ).toMatchObject({
        currentAgentSessionId: null,
        currentSandboxBindingRef: null,
        state: 'idle',
      });
      expect(
        retainsLivePartialMaterialization(fixture.backend, fixture.environmentPackage.snapshotId)
      ).toBe(false);
    } finally {
      fixture.coreDb.sqlite.close();
    }
  });

  it.each([
    'image.acquire',
    'image.build',
    'image.inspect',
  ] as const)('keeps the ready connection usable after rejected %s and live cleanup', async (operation) => {
    const coreDb = createFactoryCoreDb();
    const authority = createNanoHostTransportSessionAuthority();
    const dispatch = createNanoHostSessionDispatch({ coreDb, sessionAuthority: authority });
    const target = {
      coreDb,
      deploymentId: 'deployment_image_failure',
      identityId: 'identity_image_failure',
      targetId: 'target_image_failure',
    };
    allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
      ...target,
      observedAt: '2026-09-14T00:00:00.000Z',
    });
    let accept!: (physical: object) => void;
    const physicalReady = new Promise<object>((resolve) => {
      accept = resolve;
    });
    const server = createHttp2Server((request, response) => {
      const physical = readNanoHostPhysicalConnectionContext(request);
      if (physical) accept(physical);
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
        identityId: target.identityId,
        physicalConnection: physical,
      });
      await dispatch.readiness!(
        physical,
        Buffer.from(JSON.stringify({ physicalEpoch: 'a'.repeat(64) })),
        target
      );
      const runtime = createConfiguredWorkerLifecycleRuntime({
        coreDb,
        env: {},
        nanoHostSessionDispatch: dispatch,
        workerControlGateway: new WorkerControlGateway(),
      });
      const backend = (runtime.turnExecutor as unknown as { backend: WorkerGovernanceBackend })
        .backend;
      const dockerfile = 'FROM scratch\n';
      const environmentPackage = completeNanoHostPackage({
        runtime: {
          image:
            operation === 'image.build'
              ? {
                  kind: 'build',
                  arguments: {},
                  argumentsDigest: `sha256:${createHash('sha256').update('{}').digest('hex')}`,
                  contextRef: 'build-context://empty/v1',
                  contextDigest: `sha256:${createHash('sha256').update('').digest('hex')}`,
                  input: {
                    kind: 'dockerfile',
                    content: dockerfile,
                    digest: `sha256:${createHash('sha256').update(dockerfile).digest('hex')}`,
                  },
                  egress: [{ host: 'example.com', port: 443 }],
                  layerLimit: 128,
                  outputLimitBytes: 1024 * 1024,
                  timeLimitSeconds: 60,
                }
              : {
                  kind: 'reference',
                  pullPolicy: 'if-not-present',
                  ref: 'openkit/worker-codex:dev',
                },
        },
        scope: {
          agentSessionId: 'as_image_failure',
          threadId: 'thread_image_failure',
          turnId: 'turn_image_failure',
          workspaceId: 'ws_image_failure',
        },
        snapshotId: 'aepsnap_image_failure',
      });
      authorizeNanoHostPackage(coreDb, environmentPackage);
      anchorNanoHostMaterialization(coreDb, backend, environmentPackage);
      const materialization = backend.materialize(environmentPackage, { workspaceRoots: [] });
      const rejected = expect(materialization).rejects.toThrow('effect_failed');
      let command: Record<string, unknown> | null = null;
      await vi.waitFor(async () => {
        command = await dispatch.poll(
          physical,
          operation === 'image.build' ? operation : 'image.acquire'
        );
        expect(command).not.toBeNull();
      });
      if (operation !== 'image.build') {
        expect(command).toMatchObject({ imageReference: 'openkit/worker-codex:dev' });
      }
      if (operation === 'image.inspect') {
        await dispatch.result(physical, 'image.acquire', {
          requestId: command!.requestId,
          digest: `sha256:${'c'.repeat(64)}`,
        });
        await vi.waitFor(async () => {
          command = await dispatch.poll(physical, 'image.inspect');
          expect(command).not.toBeNull();
        });
      }
      await dispatch.result(physical, operation, {
        requestId: command!.requestId,
        failureCode: 'effect_failed',
      });
      await rejected;
      const cleanup = runtime.cleanupBackendSession(backend.planSession(environmentPackage));
      void cleanup.catch(() => undefined);
      // The next fair poll must stay idle instead of fencing the healthy session with HTTP 409.
      await expect(dispatch.poll(physical, 'image.build')).resolves.toBeNull();
      await expect(cleanup).resolves.toBeUndefined();
      expect(authority.mayCarryWork(physical)).toBe(true);
      expect(
        coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM worker_storage_bindings').get()
      ).toEqual({ count: 0 });
      expect(
        coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM sandbox_runtime_records').get()
      ).toEqual({ count: 0 });
      // A new authorized image request still runs on this same ready connection.
      const next = dispatch.effect({
        kind: 'image.acquire',
        requestId: 'b'.repeat(64),
        input: { imageReference: `sha256:${'c'.repeat(64)}` },
      });
      await expect(dispatch.poll(physical, 'image.acquire')).resolves.toMatchObject({
        requestId: 'b'.repeat(64),
      });
      await dispatch.result(physical, 'image.acquire', {
        requestId: 'b'.repeat(64),
        digest: `sha256:${'c'.repeat(64)}`,
      });
      await expect(next).resolves.toEqual({ digest: `sha256:${'c'.repeat(64)}` });
    } finally {
      client?.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      coreDb.sqlite.close();
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
          '2999-01-01T00:00:00.000Z',
          '2999-01-01T00:00:00.000Z',
          '2999-01-01T00:00:00.000Z',
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
      coreDb.sqlite
        .prepare(
          "DELETE FROM scheduler_session_leases WHERE lease_id IN ('lease_z_older', 'lease_a_current')"
        )
        .run();
      bindNanoHostWorkerLineage(coreDb, environmentPackage, {
        leaseId: 'lease_b_current',
        now: '2026-08-10T00:00:01.000Z',
        planId: 'plan_lease_b_current',
        sandboxBindingRef: 'binding:lease_b_current',
        selectedPoolId: 'pool_factory_newest_lease',
        selectedTargetId: 'target_factory_newest_lease',
      });
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
      // A new materialization that reaches Sandbox creation cannot reuse prior image-failure proof.
      await expect(
        runtime.cleanupBackendSession(backend.planSession(environmentPackage))
      ).rejects.toThrow('Sandbox creation reached');
      expect(effects.slice(3).map((effect) => effect.kind)).toEqual(['bridge.close']);
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
          captureCoverage: { scope: 'server', value: 'off' },
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

  it('copies measured identity onto a restored existing binding during materialize', async () => {
    const coreDb = createFactoryCoreDb();
    const imageDigest = `sha256:${'f'.repeat(64)}`;
    const effects: NanoHostSessionEffectRequest[] = [];
    const sessionDispatch = createFactoryNanoHostDispatch(effects);
    sessionDispatch.effect = async (requestOrConnection, carriedRequest) => {
      const request = carriedRequest ?? (requestOrConnection as NanoHostSessionEffectRequest);
      effects.push(request);
      if (request.kind === 'image.acquire') return { digest: imageDigest };
      if (request.kind === 'image.inspect') return nanoHostImageInspection(request);
      if (request.kind === 'sandbox.create') return nanoHostSandboxCreated(request);
      if (request.kind === 'bridge.open') {
        return { accepted: true, integrationReady: true, state: 'open' };
      }
      if (request.kind === 'workspace.collect')
        return request.input.mode === 'baseline'
          ? {
              requestId: request.requestId,
              outcome: 'baseline',
              head: {
                tree: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
                manifest: 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391',
              },
            }
          : { requestId: request.requestId, outcome: 'no_new_head', unstable: false };
      if (request.kind === 'reference.import') return { state: 'imported' };
      throw new Error(`Unexpected NanoHost effect: ${request.kind}`);
    };
    try {
      coreDb.sqlite
        .prepare(
          `INSERT INTO nanohost_runtime_targets (
             target_id, identity_id, deployment_id, connection_generation,
             predecessor_fenced, ready, fresh_empty, physical_epoch, observed_at, slot_count
           ) VALUES ('target_measured_restore', 'identity_measured_restore', 'deployment_measured_restore', 1, 1, 1, 1, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', ?, 1)`
        )
        .run('2026-08-21T00:00:00.000Z');
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
      firstBackend.requireLeaseId = (packageSnapshotId) => `lease-${packageSnapshotId}`;
      const triggerActor = { id: 'user-measured-restore', kind: 'user' as const };
      const environmentPackage = resolveAgentEnvironmentPackage({
        captureCoverage: { scope: 'server', value: 'off' },
        agentSessionId: 'agent-session-measured-restore',
        agentSetup: createTestAgentSetup({
          adapter: 'codex',
          agentId: 'agent-codex',
          imageRef: imageDigest,
        }),
        backend: { kind: 'openshell' },
        requestId: 'request-measured-restore',
        triggerActor,
        turn: {
          completedAt: null,
          configVersion: null,
          durationMs: null,
          error: null,
          id: 'turn-measured-restore',
          items: [],
          startedAt: '2026-08-21T00:00:00.000Z',
          status: 'running',
          threadId: 'thread-measured-restore',
          triggerActor,
          workspaceId: 'workspace-measured-restore',
        },
        turnInput: 'Restore existing binding copy',
        workspaceCwd: '/workspace',
        workspaceRoots: [],
      });
      authorizeNanoHostPackage(coreDb, environmentPackage);
      anchorNanoHostMaterialization(coreDb, firstBackend, environmentPackage);
      await firstBackend.materialize(environmentPackage, { workspaceRoots: [] });
      const harness = coreDb.sqlite
        .prepare(
          `SELECT harness_instance_id AS harnessInstanceId,
                  harness_compatibility_key AS harnessCompatibilityKey,
                  adapter_version AS adapterVersion
           FROM harness_instance_records`
        )
        .get() as {
        readonly adapterVersion: string;
        readonly harnessCompatibilityKey: string;
        readonly harnessInstanceId: string;
      };
      const bindingId = `session-binding-${createHash('sha256')
        .update(`${harness.harnessInstanceId}\0${environmentPackage.scope.agentSessionId}`)
        .digest('hex')
        .slice(0, 24)}`;
      openNanoHostAgentSessionBinding(coreDb, {
        agentSessionCompatibilityKey: deriveNanoHostAgentSessionCompatibilityKey({
          adapterId: 'codex',
          adapterVersion: harness.adapterVersion,
          harnessCompatibilityKey: harness.harnessCompatibilityKey,
          sessionCompatibilityKey: agentSessionCompatibilityKeyFromPackage(environmentPackage),
          threadId: environmentPackage.scope.threadId,
        }),
        agentSessionId: environmentPackage.scope.agentSessionId,
        agentSessionRuntimeBindingId: bindingId,
        effectiveSetupGeneration: 1,
        harnessInstanceId: harness.harnessInstanceId,
        threadId: environmentPackage.scope.threadId,
        timestamp: environmentPackage.createdAt,
        workspaceId: environmentPackage.scope.workspaceId,
      });
      coreDb.sqlite
        .prepare(
          `UPDATE agent_session_runtime_bindings
           SET lifecycle_state = 'open', native_handle_state = 'ready',
               native_handle_digest = ?
           WHERE agent_session_runtime_binding_id = ?`
        )
        .run('9'.repeat(64), bindingId);
      coreDb.sqlite.exec(
        "UPDATE scheduler_session_leases SET status = 'released' WHERE status NOT IN ('released', 'lost', 'failed')"
      );
      coreDb.sqlite
        .prepare(
          'DELETE FROM agent_session_runtime_binding_image_digests WHERE agent_session_runtime_binding_id = ?'
        )
        .run(bindingId);
      expect(
        coreDb.sqlite
          .prepare(
            'SELECT COUNT(*) AS count FROM agent_session_runtime_binding_image_digests WHERE agent_session_runtime_binding_id = ?'
          )
          .get(bindingId)
      ).toEqual({ count: 0 });
      const restoredRuntime = createConfiguredWorkerLifecycleRuntime({
        coreDb,
        env: {},
        nanoHostSessionDispatch: sessionDispatch,
        workerControlGateway: new WorkerControlGateway(),
      });
      const restoredBackend = (
        restoredRuntime.turnExecutor as unknown as {
          readonly backend: WorkerGovernanceBackend & {
            requireLeaseId(packageSnapshotId: string): string;
          };
        }
      ).backend;
      restoredBackend.requireLeaseId = (packageSnapshotId) => `lease-${packageSnapshotId}`;
      anchorNanoHostMaterialization(coreDb, restoredBackend, environmentPackage);
      await restoredBackend.materialize(environmentPackage, { workspaceRoots: [] });
      expect(
        coreDb.sqlite
          .prepare(
            `SELECT image_digest AS imageDigest FROM agent_session_runtime_binding_image_digests
             WHERE agent_session_runtime_binding_id = ?`
          )
          .get(bindingId)
      ).toEqual({ imageDigest });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('copies measured identity onto a restored binding launched through session.inspect', async () => {
    const coreDb = createFactoryCoreDb();
    const imageDigest = `sha256:${'f'.repeat(64)}`;
    const effects: NanoHostSessionEffectRequest[] = [];
    const sessionDispatch = createFactoryNanoHostDispatch(effects);
    sessionDispatch.effect = async (requestOrConnection, carriedRequest) => {
      const request = carriedRequest ?? (requestOrConnection as NanoHostSessionEffectRequest);
      effects.push(request);
      if (request.kind === 'image.acquire') return { digest: imageDigest };
      if (request.kind === 'image.inspect') return nanoHostImageInspection(request);
      if (request.kind === 'sandbox.create') return nanoHostSandboxCreated(request);
      if (request.kind === 'bridge.open') {
        return { accepted: true, integrationReady: true, state: 'open' };
      }
      if (request.kind === 'workspace.collect')
        return request.input.mode === 'baseline'
          ? {
              requestId: request.requestId,
              outcome: 'baseline',
              head: {
                tree: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
                manifest: 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391',
              },
            }
          : { requestId: request.requestId, outcome: 'no_new_head', unstable: false };
      if (request.kind === 'reference.import') return { state: 'imported' };
      throw new Error(`Unexpected NanoHost effect: ${request.kind}`);
    };
    try {
      coreDb.sqlite
        .prepare(
          `INSERT INTO nanohost_runtime_targets (
             target_id, identity_id, deployment_id, connection_generation,
             predecessor_fenced, ready, fresh_empty, physical_epoch, observed_at, slot_count
           ) VALUES ('target_measured_inspect', 'identity_measured_inspect', 'deployment_measured_inspect', 1, 1, 1, 1, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', ?, 1)`
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
      const triggerActor = { id: 'user-measured-inspect', kind: 'user' as const };
      const firstPackage = resolveAgentEnvironmentPackage({
        captureCoverage: { scope: 'server', value: 'off' },
        agentSessionId: 'agent-session-measured-inspect',
        agentSetup: createTestAgentSetup({
          adapter: 'codex',
          agentId: 'agent-codex',
          imageRef: imageDigest,
        }),
        backend: { kind: 'openshell' },
        requestId: 'request-measured-inspect',
        triggerActor,
        turn: {
          completedAt: null,
          configVersion: null,
          durationMs: null,
          error: null,
          id: 'turn-measured-inspect',
          items: [],
          startedAt: '2026-08-21T00:00:00.000Z',
          status: 'running',
          threadId: 'thread-measured-inspect',
          triggerActor,
          workspaceId: 'workspace-measured-inspect',
        },
        turnInput: 'Inspect restored binding copy',
        workspaceCwd: '/workspace',
        workspaceRoots: [],
      });
      authorizeNanoHostPackage(coreDb, firstPackage);
      anchorNanoHostMaterialization(coreDb, backend, firstPackage);
      const firstMaterialization = await backend.materialize(firstPackage, { workspaceRoots: [] });
      const harness = coreDb.sqlite
        .prepare(
          `SELECT harness_instance_id AS harnessInstanceId,
                  harness_compatibility_key AS harnessCompatibilityKey,
                  adapter_version AS adapterVersion
           FROM harness_instance_records`
        )
        .get() as {
        readonly adapterVersion: string;
        readonly harnessCompatibilityKey: string;
        readonly harnessInstanceId: string;
      };
      const bindingId = `session-binding-${createHash('sha256')
        .update(`${harness.harnessInstanceId}\0${firstPackage.scope.agentSessionId}`)
        .digest('hex')
        .slice(0, 24)}`;
      const handleDigest = 'd'.repeat(64);
      openNanoHostAgentSessionBinding(coreDb, {
        agentSessionCompatibilityKey: deriveNanoHostAgentSessionCompatibilityKey({
          adapterId: 'codex',
          adapterVersion: harness.adapterVersion,
          harnessCompatibilityKey: harness.harnessCompatibilityKey,
          sessionCompatibilityKey: agentSessionCompatibilityKeyFromPackage(firstPackage),
          threadId: firstPackage.scope.threadId,
        }),
        agentSessionId: firstPackage.scope.agentSessionId,
        agentSessionRuntimeBindingId: bindingId,
        effectiveSetupGeneration: 1,
        harnessInstanceId: harness.harnessInstanceId,
        threadId: firstPackage.scope.threadId,
        timestamp: firstPackage.createdAt,
        workspaceId: firstPackage.scope.workspaceId,
      });
      coreDb.sqlite
        .prepare(
          `UPDATE agent_session_runtime_bindings
           SET lifecycle_state = 'open', native_handle_state = 'ready',
               native_handle_digest = ?
           WHERE agent_session_runtime_binding_id = ?`
        )
        .run(handleDigest, bindingId);
      coreDb.sqlite
        .prepare(
          'DELETE FROM agent_session_runtime_binding_image_digests WHERE agent_session_runtime_binding_id = ?'
        )
        .run(bindingId);
      expect(
        coreDb.sqlite
          .prepare(
            'SELECT COUNT(*) AS count FROM agent_session_runtime_binding_image_digests WHERE agent_session_runtime_binding_id = ?'
          )
          .get(bindingId)
      ).toEqual({ count: 0 });
      const restoredRuntime = createConfiguredWorkerLifecycleRuntime({
        coreDb,
        env: {},
        nanoHostSessionDispatch: sessionDispatch,
        workerControlGateway: new WorkerControlGateway(),
      });
      const restoredBackend = (
        restoredRuntime.turnExecutor as unknown as {
          readonly backend: WorkerGovernanceBackend & {
            requireLeaseId(packageSnapshotId: string): string;
            restoreSession(environmentPackage: AgentEnvironmentPackage, leaseId: string): void;
          };
        }
      ).backend;
      restoredBackend.requireLeaseId = (packageSnapshotId) => `lease-${packageSnapshotId}`;
      restoredBackend.restoreSession(firstPackage, `lease-${firstPackage.snapshotId}`);
      const inspectLaunch = restoredBackend.launch(firstMaterialization);
      void inspectLaunch.catch(() => undefined);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(
        coreDb.sqlite
          .prepare(
            `SELECT image_digest AS imageDigest FROM agent_session_runtime_binding_image_digests
             WHERE agent_session_runtime_binding_id = ?`
          )
          .get(bindingId)
      ).toEqual({ imageDigest });
      expect(readNanoHostMeasuredHarnessIdentity(coreDb, bindingId)).toBe(imageDigest);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it.each([
    { name: 'records the predecessor proof at open and again at restart', opened: 'a' },
    { name: 'refuses a resumed open that proves a different conversation', opened: 'b' },
  ])('resumed session.open $name', async ({ opened }) => {
    const coreDb = createFactoryCoreDb();
    const sessionDispatch: NanoHostSessionDispatch = {
      async effect(requestOrConnection: object, carriedRequest?: NanoHostSessionEffectRequest) {
        const request = carriedRequest ?? (requestOrConnection as NanoHostSessionEffectRequest);
        if (request.kind === 'image.acquire') return { digest: request.input.imageReference };
        if (request.kind === 'image.inspect') return nanoHostImageInspection(request);
        if (request.kind === 'sandbox.create') return nanoHostSandboxCreated(request);
        if (request.kind === 'bridge.open') {
          return { accepted: true, integrationReady: true, state: 'open' };
        }
        if (request.kind === 'workspace.collect')
          return request.input.mode === 'baseline'
            ? {
                requestId: request.requestId,
                outcome: 'baseline',
                head: {
                  tree: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
                  manifest: 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391',
                },
              }
            : { requestId: request.requestId, outcome: 'no_new_head', unstable: false };
        if (request.kind === 'reference.import') return { state: 'imported' };
        if (request.kind === 'workspace.collect')
          return request.input.mode === 'baseline'
            ? {
                requestId: request.requestId,
                outcome: 'baseline',
                head: {
                  tree: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
                  manifest: 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391',
                },
              }
            : { requestId: request.requestId, outcome: 'no_new_head', unstable: false };
        if (request.kind === 'reference.import') return { state: 'imported' };
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
    const predecessorDigest = 'a'.repeat(64);
    const openedDigest = opened.repeat(64);
    try {
      coreDb.sqlite
        .prepare(
          `INSERT INTO nanohost_runtime_targets (
             target_id, identity_id, deployment_id, connection_generation,
             predecessor_fenced, ready, fresh_empty, physical_epoch, observed_at, slot_count
           ) VALUES ('target_resume_open', 'identity_resume_open', 'deployment_resume_open',
                     1, 1, 1, 1, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', ?, 1)`
        )
        .run('2026-09-06T00:00:00.000Z');
      const createBackend = () => {
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
              restoreSession(environmentPackage: AgentEnvironmentPackage, leaseId: string): void;
            };
          }
        ).backend;
        backend.requireLeaseId = (packageSnapshotId) => `lease-${packageSnapshotId}`;
        return { backend, runtime };
      };
      const { backend, runtime } = createBackend();
      const environmentPackage = completeNanoHostPackage({
        runtime: {
          image: { kind: 'reference', pullPolicy: 'never', ref: `sha256:${'1'.repeat(64)}` },
        },
        scope: {
          agentSessionId: 'as_resume_open',
          threadId: 'thread_resume_open',
          turnId: 'turn_resume_open',
          workspaceId: 'workspace_resume_open',
        },
        snapshotId: 'snapshot_resume_open',
      });
      authorizeNanoHostPackage(coreDb, environmentPackage);
      bindNanoHostWorkerLineage(coreDb, environmentPackage, {
        leaseId: 'lease-snapshot_resume_open',
        now: '2026-09-06T00:00:00.000Z',
        planId: 'plan_resume_open',
        sandboxBindingRef: 'lease-binding:resume-open',
        selectedPoolId: 'pool_resume_open',
        selectedTargetId: 'target_resume_open',
      });
      const settleNext = async (
        operation: 'session.open' | 'turn.start',
        body: Readonly<Record<string, unknown>>
      ) => {
        let command: ReturnType<typeof dispatchNanoHostHarnessOperation> = null;
        let integrationRef = '';
        for (let attempt = 0; attempt < 200 && !command; attempt += 1) {
          const integration = coreDb.sqlite
            .prepare(
              `SELECT sandbox_integration_binding_ref AS integrationRef
               FROM sandbox_runtime_records ORDER BY created_at LIMIT 1`
            )
            .get() as { readonly integrationRef: string } | undefined;
          if (integration) {
            integrationRef = integration.integrationRef;
            command = dispatchNanoHostHarnessOperation(coreDb, {
              sandboxIntegrationBindingRef: integrationRef,
            });
          }
          if (!command) await new Promise<void>((resolve) => setTimeout(resolve, 1));
        }
        if (!command || command.operation !== operation) {
          throw new Error(`Expected queued ${operation} Harness command.`);
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
          sandboxIntegrationBindingRef: integrationRef,
          timestamp: '2026-09-06T00:00:01.000Z',
        });
        runtime.acceptNanoHostHarnessResult(result);
        return command;
      };

      anchorNanoHostMaterialization(coreDb, backend, environmentPackage);
      const materialization = await backend.materialize(environmentPackage, {
        nativeResume: { digest: predecessorDigest, locator: 'as_resume_predecessor' },
        workspaceRoots: [],
      });
      const recordedDigests: string[] = [];
      backend.bindNativeHandleRecorder?.(environmentPackage.snapshotId, (digest) => {
        recordedDigests.push(digest);
      });
      const launch = backend.launch(materialization);
      void launch.catch(() => undefined);
      const open = await settleNext('session.open', {
        maxActiveTurns: 1,
        nativeHandleDigest: openedDigest,
        nativeHandleState: 'ready',
        state: 'open',
      });
      expect(open.body).toMatchObject({
        resume: { digest: predecessorDigest, locator: 'as_resume_predecessor' },
      });
      if (openedDigest !== predecessorDigest) {
        await expect(launch).rejects.toThrow('session.open result is incompatible');
        expect(recordedDigests).toEqual([]);
        return;
      }
      // The proof reaches the AgentSession owner before any later import or native work.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(recordedDigests).toEqual([predecessorDigest]);
      await settleNext('turn.start', {
        nativeHandleDigest: predecessorDigest,
        nativeHandleState: 'ready',
        state: 'started',
      });
      await launch;

      // A restarted NanoCore restores the binding from its durable row and hands the recorder the
      // proof that row holds, closing the window between the row commit and the AgentSession write.
      const restored = createBackend().backend;
      restored.restoreSession(environmentPackage, 'lease-snapshot_resume_open');
      const restoredDigests: string[] = [];
      restored.bindNativeHandleRecorder?.(environmentPackage.snapshotId, (digest) => {
        restoredDigests.push(digest);
      });
      expect(restoredDigests).toEqual([predecessorDigest]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it.each([
    'codex',
    'pi',
  ] as const)('keeps a ready %s session.open proof when recording fails, then hands it off before cleanup', async (adapterId) => {
    const coreDb = createFactoryCoreDb();
    const effects: NanoHostSessionEffectRequest[] = [];
    const sessionDispatch: NanoHostSessionDispatch = {
      async effect(requestOrConnection: object, carriedRequest?: NanoHostSessionEffectRequest) {
        const request = carriedRequest ?? (requestOrConnection as NanoHostSessionEffectRequest);
        effects.push(request);
        if (request.kind === 'image.acquire') return { digest: `sha256:${'a'.repeat(64)}` };
        if (request.kind === 'image.inspect') return nanoHostImageInspection(request);
        if (request.kind === 'sandbox.create') return nanoHostSandboxCreated(request);
        if (request.kind === 'bridge.open') {
          return { accepted: true, integrationReady: true, state: 'open' };
        }
        if (request.kind === 'bridge.close' || request.kind === 'sandbox.delete') {
          return { state: 'deleted' };
        }
        if (request.kind === 'workspace.collect')
          return request.input.mode === 'baseline'
            ? {
                requestId: request.requestId,
                outcome: 'baseline',
                head: {
                  tree: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
                  manifest: 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391',
                },
              }
            : { requestId: request.requestId, outcome: 'no_new_head', unstable: false };
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
    };
    const readyDigest = 'a'.repeat(64);
    try {
      coreDb.sqlite
        .prepare(
          `INSERT INTO nanohost_runtime_targets (
               target_id, identity_id, deployment_id, connection_generation,
               predecessor_fenced, ready, fresh_empty, physical_epoch, observed_at, slot_count
             ) VALUES ('target_ready_open', 'identity_ready_open', 'deployment_ready_open',
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
            readonly sessions: Map<string, unknown>;
          };
        }
      ).backend;
      const environmentPackage = completeNanoHostPackage({
        extensions: {
          openkit: {
            workerStorage: {
              workSlotRef: workerStorageDefaultWorkSlotRef(
                'workspace_ready_open',
                'thread_ready_open'
              ),
            },
          },
        },
        scope: {
          agentSessionId: 'as_ready_open',
          threadId: 'thread_ready_open',
          turnId: 'turn_ready_open',
          workspaceId: 'workspace_ready_open',
        },
        snapshotId: 'snapshot_ready_open',
      });
      environmentPackage.control.adapter.targetRuntime = adapterId;
      environmentPackage.agent.runtimeVersion = adapterId === 'pi' ? '0.85.1' : '0.153.4';
      authorizeNanoHostPackage(coreDb, environmentPackage);
      bindNanoHostWorkerLineage(coreDb, environmentPackage, {
        leaseId: 'lease_ready_open',
        now: '2026-09-06T00:00:00.000Z',
        planId: 'plan_ready_open',
        sandboxBindingRef: 'sandbox-binding:ready-open',
        selectedPoolId: 'pool_ready_open',
        selectedTargetId: 'target_ready_open',
      });
      anchorNanoHostMaterialization(coreDb, backend, environmentPackage);
      const materialization = await backend.materialize(environmentPackage, {
        workspaceRoots: [],
      });
      backend.bindNativeHandleRecorder?.(environmentPackage.snapshotId, () => {
        throw new Error('recorder failed');
      });
      const launch = backend.launch(materialization);
      let command: ReturnType<typeof dispatchNanoHostHarnessOperation> = null;
      for (let attempt = 0; attempt < 200 && !command; attempt += 1) {
        const integration = coreDb.sqlite
          .prepare(
            `SELECT sandbox_integration_binding_ref AS integrationRef
               FROM sandbox_runtime_records ORDER BY created_at LIMIT 1`
          )
          .get() as { readonly integrationRef: string } | undefined;
        if (integration) {
          command = dispatchNanoHostHarnessOperation(coreDb, {
            sandboxIntegrationBindingRef: integration.integrationRef,
          });
        }
        if (!command) await new Promise<void>((resolve) => setTimeout(resolve, 1));
      }
      if (!command || command.operation !== 'session.open') {
        throw new Error('Expected queued session.open Harness command.');
      }
      expect(command.body).toMatchObject({ resume: null });
      runtime.acceptNanoHostHarnessCommand(command);
      const result = {
        body: {
          maxActiveTurns: 1,
          nativeHandleDigest: readyDigest,
          nativeHandleState: 'ready',
          state: 'open',
        },
        disposition: 'succeeded' as const,
        harnessInstanceId: command.harnessInstanceId,
        operationId: command.operationId,
        schemaVersion: 2 as const,
        sequence: command.sequence,
      };
      const integrationRef = (
        coreDb.sqlite
          .prepare(
            `SELECT sandbox_integration_binding_ref AS integrationRef
               FROM sandbox_runtime_records ORDER BY created_at LIMIT 1`
          )
          .get() as { readonly integrationRef: string }
      ).integrationRef;
      settleNanoHostHarnessOperation(coreDb, {
        result,
        sandboxIntegrationBindingRef: integrationRef,
        timestamp: '2026-09-06T00:00:01.000Z',
      });
      runtime.acceptNanoHostHarnessResult(result);
      await expect(launch).rejects.toThrow(/recorder failed/);
      expect(
        coreDb.sqlite
          .prepare('SELECT native_handle_digest AS digest FROM agent_session_runtime_bindings')
          .get()
      ).toEqual({ digest: readyDigest });
      const identity = backend.planSession(environmentPackage);
      // The accepted proof is only on the binding row; cleanup must keep that row and the session.
      await expect(backend.cleanupSession(identity)).rejects.toThrow(/could not be recorded/);
      expect(
        coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM agent_session_runtime_bindings').get()
      ).toEqual({ count: 1 });
      expect(
        coreDb.sqlite
          .prepare('SELECT cleanup_state AS cleanupState FROM sandbox_runtime_records')
          .get()
      ).toEqual({ cleanupState: 'clean' });
      expect(
        coreDb.sqlite
          .prepare(
            `SELECT drain_state AS drainState, lifecycle_state AS lifecycleState
                 FROM harness_instance_records`
          )
          .get()
      ).toEqual({ drainState: 'draining', lifecycleState: 'failed' });
      expect(effects.map((effect) => effect.kind)).not.toContain('bridge.close');
      expect(effects.map((effect) => effect.kind)).not.toContain('sandbox.delete');
      expect(backend.sessions.has(environmentPackage.snapshotId)).toBe(true);
      const recordedDigests: string[] = [];
      backend.bindNativeHandleRecorder?.(environmentPackage.snapshotId, (digest) => {
        recordedDigests.push(digest);
      });
      expect(recordedDigests).toEqual([readyDigest]);
      await backend.cleanupSession(identity);
      expect(backend.sessions.has(environmentPackage.snapshotId)).toBe(false);
      expect(effects.map((effect) => effect.kind)).toContain('bridge.close');
      expect(effects.map((effect) => effect.kind)).toContain('sandbox.delete');
      expect(recordedDigests).toEqual([readyDigest]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('keeps a restored ready proof when recording fails, then hands it off before cleanup', async () => {
    const coreDb = createFactoryCoreDb();
    const effects: string[] = [];
    const sessionDispatch: NanoHostSessionDispatch = {
      async effect(requestOrConnection: object, carriedRequest?: NanoHostSessionEffectRequest) {
        const request = carriedRequest ?? (requestOrConnection as NanoHostSessionEffectRequest);
        effects.push(request.kind);
        if (request.kind === 'image.acquire') return { digest: request.input.imageReference };
        if (request.kind === 'image.inspect') return nanoHostImageInspection(request);
        if (request.kind === 'sandbox.create') return nanoHostSandboxCreated(request);
        if (request.kind === 'bridge.open') {
          return { accepted: true, integrationReady: true, state: 'open' };
        }
        if (request.kind === 'workspace.collect')
          return request.input.mode === 'baseline'
            ? {
                requestId: request.requestId,
                outcome: 'baseline',
                head: {
                  tree: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
                  manifest: 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391',
                },
              }
            : { requestId: request.requestId, outcome: 'no_new_head', unstable: false };
        if (request.kind === 'reference.import') return { state: 'imported' };
        if (request.kind === 'workspace.collect')
          return request.input.mode === 'baseline'
            ? {
                requestId: request.requestId,
                outcome: 'baseline',
                head: {
                  tree: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
                  manifest: 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391',
                },
              }
            : { requestId: request.requestId, outcome: 'no_new_head', unstable: false };
        if (request.kind === 'reference.import') return { state: 'imported' };
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
    const readyDigest = 'a'.repeat(64);
    try {
      coreDb.sqlite
        .prepare(
          `INSERT INTO nanohost_runtime_targets (
             target_id, identity_id, deployment_id, connection_generation,
             predecessor_fenced, ready, fresh_empty, physical_epoch, observed_at, slot_count
           ) VALUES ('target_restored_proof', 'identity_restored_proof', 'deployment_restored_proof',
                     1, 1, 1, 1, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', ?, 1)`
        )
        .run('2026-09-06T00:00:00.000Z');
      const createBackend = () => {
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
              restoreSession(environmentPackage: AgentEnvironmentPackage, leaseId: string): void;
              readonly sessions: Map<string, unknown>;
            };
          }
        ).backend;
        backend.requireLeaseId = (packageSnapshotId) => `lease-${packageSnapshotId}`;
        return { backend, runtime };
      };
      const { backend, runtime } = createBackend();
      const environmentPackage = completeNanoHostPackage({
        runtime: {
          image: { kind: 'reference', pullPolicy: 'never', ref: `sha256:${'1'.repeat(64)}` },
        },
        scope: {
          agentSessionId: 'as_restored_proof',
          threadId: 'thread_restored_proof',
          turnId: 'turn_restored_proof',
          workspaceId: 'workspace_restored_proof',
        },
        snapshotId: 'snapshot_restored_proof',
      });
      authorizeNanoHostPackage(coreDb, environmentPackage);
      bindNanoHostWorkerLineage(coreDb, environmentPackage, {
        leaseId: 'lease-snapshot_restored_proof',
        now: '2026-09-06T00:00:00.000Z',
        planId: 'plan_restored_proof',
        sandboxBindingRef: 'lease-binding:restored-proof',
        selectedPoolId: 'pool_restored_proof',
        selectedTargetId: 'target_restored_proof',
      });
      const settleNext = async (
        operation: 'session.open' | 'turn.start',
        body: Readonly<Record<string, unknown>>
      ) => {
        let command: ReturnType<typeof dispatchNanoHostHarnessOperation> = null;
        let integrationRef = '';
        for (let attempt = 0; attempt < 200 && !command; attempt += 1) {
          const integration = coreDb.sqlite
            .prepare(
              `SELECT sandbox_integration_binding_ref AS integrationRef
               FROM sandbox_runtime_records ORDER BY created_at LIMIT 1`
            )
            .get() as { readonly integrationRef: string } | undefined;
          if (integration) {
            integrationRef = integration.integrationRef;
            command = dispatchNanoHostHarnessOperation(coreDb, {
              sandboxIntegrationBindingRef: integrationRef,
            });
          }
          if (!command) await new Promise<void>((resolve) => setTimeout(resolve, 1));
        }
        if (!command || command.operation !== operation) {
          throw new Error(`Expected queued ${operation} Harness command.`);
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
          sandboxIntegrationBindingRef: integrationRef,
          timestamp: '2026-09-06T00:00:01.000Z',
        });
        runtime.acceptNanoHostHarnessResult(result);
      };
      anchorNanoHostMaterialization(coreDb, backend, environmentPackage);
      const materialization = await backend.materialize(environmentPackage, {
        nativeResume: { digest: readyDigest, locator: 'as_restored_predecessor' },
        workspaceRoots: [],
      });
      backend.bindNativeHandleRecorder?.(environmentPackage.snapshotId, () => undefined);
      const launch = backend.launch(materialization);
      void launch.catch(() => undefined);
      await settleNext('session.open', {
        maxActiveTurns: 1,
        nativeHandleDigest: readyDigest,
        nativeHandleState: 'ready',
        state: 'open',
      });
      await settleNext('turn.start', {
        nativeHandleDigest: readyDigest,
        nativeHandleState: 'ready',
        state: 'started',
      });
      await launch;
      const restored = createBackend().backend;
      restored.restoreSession(environmentPackage, 'lease-snapshot_restored_proof');
      expect(() => {
        restored.bindNativeHandleRecorder?.(environmentPackage.snapshotId, () => {
          throw new Error('recorder failed');
        });
      }).toThrow(/recorder failed/);
      expect(
        coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM agent_session_runtime_bindings').get()
      ).toEqual({ count: 1 });
      const identity = restored.planSession(environmentPackage);
      // Restoration already holds the only durable copy; a throwing recorder must not let cleanup delete it.
      await expect(restored.cleanupSession(identity)).rejects.toThrow(/could not be recorded/);
      expect(
        coreDb.sqlite
          .prepare('SELECT native_handle_digest AS digest FROM agent_session_runtime_bindings')
          .get()
      ).toEqual({ digest: readyDigest });
      expect(
        coreDb.sqlite
          .prepare(
            `SELECT drain_state AS drainState, lifecycle_state AS lifecycleState
               FROM harness_instance_records`
          )
          .get()
      ).toEqual({ drainState: 'draining', lifecycleState: 'failed' });
      expect(effects).not.toContain('sandbox.delete');
      expect(restored.sessions.has(environmentPackage.snapshotId)).toBe(true);
      const recordedDigests: string[] = [];
      restored.bindNativeHandleRecorder?.(environmentPackage.snapshotId, (digest) => {
        recordedDigests.push(digest);
      });
      expect(recordedDigests).toEqual([readyDigest]);
      await restored.cleanupSession(identity);
      expect(restored.sessions.has(environmentPackage.snapshotId)).toBe(false);
      expect(effects).toContain('sandbox.delete');
      expect(recordedDigests).toEqual([readyDigest]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('dispatches DeepSeek after OpenCode returns to a previously evicted Sandbox identity', async () => {
    const coreDb = createFactoryCoreDb();
    const effects: NanoHostSessionEffectRequest[] = [];
    const sessionDispatch: NanoHostSessionDispatch = {
      async effect(requestOrConnection: object, carriedRequest?: NanoHostSessionEffectRequest) {
        const request = carriedRequest ?? (requestOrConnection as NanoHostSessionEffectRequest);
        effects.push(request);
        switch (request.kind) {
          case 'image.acquire':
            return { digest: request.input.imageReference };
          case 'image.inspect':
            return nanoHostImageInspection(request);
          case 'sandbox.create':
            return nanoHostSandboxCreated(request);
          case 'bridge.open':
            return { accepted: true, integrationReady: true, state: 'open' };
          case 'reference.import':
            return { state: 'imported' };
          case 'workspace.collect':
            return request.input.mode === 'baseline'
              ? {
                  requestId: request.requestId,
                  outcome: 'baseline',
                  head: {
                    tree: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
                    manifest: 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391',
                  },
                }
              : { requestId: request.requestId, outcome: 'no_new_head', unstable: false };
          case 'bridge.close':
          case 'sandbox.delete':
            return { state: 'deleted' };
          default:
            throw new Error(`Unexpected admission regression effect: ${request.kind}`);
        }
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
         ) VALUES ('target_admission_stall', 'identity_admission_stall',
                   'deployment_admission_stall', 1, 1, 1, 1, ?, ?, 1)`
        )
        .run('a'.repeat(64), '2026-09-06T00:00:00.000Z');
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
            readonly sessions: Map<
              string,
              {
                readonly sharedHarness: {
                  readonly sandbox: { readonly sandboxRuntimeId: string };
                };
              }
            >;
          };
        }
      ).backend;
      /** Uses real package resolution so returning OpenCode selects its original static identity. */
      const packageFor = (adapter: string, number: number) => {
        const setup = createTestAgentSetup({ adapter, agentId: `agent_${adapter}` });
        admitTestNativeEnvironment(coreDb, setup.manifest);
        return resolveAgentEnvironmentPackage({
          coreDb,
          captureCoverage: { scope: 'server', value: 'off' },
          agentSessionId: `as_admission_stall_${number}`,
          agentSetup: setup,
          backend: { kind: 'openshell' },
          createdAt: '2026-09-06T00:00:00.000Z',
          requestId: `request_admission_stall_${number}`,
          triggerActor: { kind: 'user', id: 'user-factory' },
          turn: {
            completedAt: null,
            configVersion: null,
            durationMs: null,
            error: null,
            id: `turn_admission_stall_${number}`,
            items: [],
            startedAt: '2026-09-06T00:00:00.000Z',
            status: 'running',
            threadId: `thread_admission_stall_${number}`,
            triggerActor: { kind: 'user', id: 'user-factory' },
            workspaceId: 'workspace_admission_stall',
          },
          turnInput: 'Complete a reusable Turn',
          workspaceCwd: '/workspace',
          workspaceRoots: [],
        });
      };
      const packages = [
        packageFor('opencode', 23),
        packageFor('deepseek', 24),
        packageFor('opencode', 25),
        packageFor('deepseek', 26),
      ];
      /** Delivers the actual queued Harness command through its durable settlement owner. */
      const settleNext = async (operation: string, body: Readonly<Record<string, unknown>>) => {
        let command: ReturnType<typeof dispatchNanoHostHarnessOperation> = null;
        let integrationRef = '';
        for (let attempt = 0; attempt < 200 && !command; attempt += 1) {
          const integration = coreDb.sqlite
            .prepare(
              'SELECT sandbox_integration_binding_ref AS integrationRef FROM sandbox_runtime_records'
            )
            .get() as { readonly integrationRef: string } | undefined;
          integrationRef = integration?.integrationRef ?? '';
          if (integration)
            command = dispatchNanoHostHarnessOperation(coreDb, {
              sandboxIntegrationBindingRef: integrationRef,
            });
          if (!command) await new Promise<void>((resolve) => setTimeout(resolve, 1));
        }
        if (!command || command.operation !== operation)
          throw new Error(`Expected queued ${operation} Harness command.`);
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
          sandboxIntegrationBindingRef: integrationRef,
          timestamp: '2026-09-06T00:00:01.000Z',
        });
        runtime.acceptNanoHostHarnessResult(result);
      };
      upsertSchedulerWorkerPool(coreDb, {
        allowedBackendKinds: ['openshell'],
        allowedPlacements: ['local'],
        allowedWorkspaceScopes: ['local'],
        budgetClass: 'interactive',
        currentAdmittedSessionCount: 0,
        currentQueueDepth: 0,
        defaultTimeoutMs: 900_000,
        healthSummary: 'ready',
        maxConcurrentSessions: 1,
        poolId: 'pool_admission_stall',
        queueLimit: 20,
        status: 'active',
      });
      upsertSchedulerCapacityRecord(coreDb, {
        capacityClass: 'local',
        concurrencyCeiling: 1,
        inUseCount: 0,
        observationSource: 'configured',
        observedAt: '2026-09-06T00:00:00.000Z',
        poolId: 'pool_admission_stall',
        queueDepth: 0,
        targetId: 'target_admission_stall',
      });
      upsertSchedulerTargetHealthRecord(coreDb, {
        checkResults: [],
        consecutiveFailureCount: 0,
        consecutiveSuccessCount: 1,
        healthState: 'healthy',
        lastProbeAt: '2026-09-06T00:00:00.000Z',
        nextProbeAt: '2999-01-01T00:00:00.000Z',
        targetId: 'target_admission_stall',
      });
      /** Enqueues product lineage before the same capacity probe and lease insertion as dispatch. */
      const enqueue = (environmentPackage: AgentEnvironmentPackage) =>
        createSchedulerAdmissionEntry(coreDb, {
          priorityClass: 'interactive',
          queueEntryId: `queue:${environmentPackage.snapshotId}`,
          requestId: environmentPackage.scope.requestId,
          requestedAgentId: environmentPackage.agent.agentId,
          requiredPoolConstraints: ['openshell.local'],
          ...environmentPackage.scope,
          turnInput: 'Complete a reusable Turn',
        });
      /** Inserts the real scheduler grant and its capacity accounting before backend effects. */
      const dispatch = (environmentPackage: AgentEnvironmentPackage) => {
        expect(backend.inspectMaterializationCapacity?.(environmentPackage)).toBe('available');
        const result = dispatchNextSchedulerEntry(coreDb, {
          agentSessionId: environmentPackage.scope.agentSessionId,
          packageSnapshotId: environmentPackage.snapshotId,
          expectedControlMode: 'poll',
          expectedDataPlaneMode: 'openshell-files',
          heartbeatIntervalMs: 10_000,
          heartbeatTimeoutMs: 30_000,
          leaseDurationMs: 900_000,
          startupTimeoutMs: 120_000,
          leaseId: `lease:${environmentPackage.snapshotId}`,
          planId: `plan:${environmentPackage.snapshotId}`,
          sandboxBindingRef: `lease-binding:${environmentPackage.snapshotId}`,
          schedulerEpoch: 1,
        });
        expect(result.status).toBe('dispatched');
        anchorNanoHostMaterialization(coreDb, backend, environmentPackage);
      };
      let originalOpenCodeSandboxId: string | undefined;
      for (const [index, environmentPackage] of packages.slice(0, 3).entries()) {
        authorizeNanoHostPackage(coreDb, environmentPackage);
        enqueue(environmentPackage);
        dispatch(environmentPackage);
        const materializing = backend.materialize(environmentPackage, { workspaceRoots: [] });
        if (index > 0)
          await settleNext('session.close', {
            state: 'closed',
            privateState: 'absent',
            childState: 'absent',
          });
        const materialized = await materializing;
        const sandboxId = backend.sessions.get(environmentPackage.snapshotId)!.sharedHarness.sandbox
          .sandboxRuntimeId;
        if (index === 0) originalOpenCodeSandboxId = sandboxId;
        if (index === 2) expect(sandboxId).toBe(originalOpenCodeSandboxId);
        backend.bindNativeHandleRecorder?.(environmentPackage.snapshotId, () => {});
        const launch = backend.launch(materialized);
        await settleNext('session.open', {
          maxActiveTurns: 1,
          state: 'open',
          nativeHandleState: 'pending',
          nativeHandleDigest: null,
        });
        await settleNext('turn.start', {
          state: 'started',
          nativeHandleState: 'pending',
          nativeHandleDigest: null,
        });
        await launch;
        recordWorkerControlAcceptedRecord(coreDb, {
          acceptedAt: '2026-09-06T00:00:01.000Z',
          lineage: {
            ...environmentPackage.scope,
            packageSnapshotId: environmentPackage.snapshotId,
          },
          operation: 'final_status',
          record: { sequence: 1, status: 'completed', stopReason: 'completed' },
          recordKey: '1',
          sequence: 1,
        });
        const inspection = backend.inspectTerminalHarnessSession(
          backend.sessions.get(environmentPackage.snapshotId)
        );
        await settleNext('session.inspect', {
          state: 'open',
          childState: 'absent',
          cleanupState: 'clean',
          nativeHandleState: 'ready',
          nativeHandleDigest: 'a'.repeat(64),
        });
        await inspection;
        const lease = coreDb.sqlite
          .prepare(
            'SELECT lease_id AS leaseId FROM scheduler_session_leases WHERE package_snapshot_id = ?'
          )
          .get(environmentPackage.snapshotId) as { readonly leaseId: string };
        coreDb.sqlite
          .prepare(
            `UPDATE worker_backend_sessions SET workspace_handoff_state = 'complete' WHERE lease_id = ?`
          )
          .run(lease.leaseId);
        transitionWorkerBackendSessionState(coreDb, {
          fromState: 'materializing',
          toState: 'cleanup-pending',
          leaseId: lease.leaseId,
        });
        await runtime.cleanupBackendSession(backend.planSession(environmentPackage));
        expect(backend.sessions.has(environmentPackage.snapshotId)).toBe(false);
        transitionWorkerBackendSessionState(coreDb, {
          fromState: 'cleanup-pending',
          toState: 'physical-cleaned',
          leaseId: lease.leaseId,
        });
        coreDb.sqlite
          .prepare(
            `UPDATE scheduler_session_leases SET status = 'releasing', release_reason = 'worker-final-status',
             backend_anchor_state = 'anchored' WHERE lease_id = ?`
          )
          .run(lease.leaseId);
        await runSchedulerRecoveryMaintenance(coreDb, 1, {
          cleanupBackendSession: runtime.cleanupBackendSession,
          restoreBackendSession: runtime.restoreBackendSession,
          projectRecoveredTurn: async () => ({ status: 'completed' }),
        });
        expect(
          coreDb.sqlite
            .prepare(
              'SELECT status, release_reason AS releaseReason FROM scheduler_session_leases WHERE lease_id = ?'
            )
            .get(lease.leaseId)
        ).toEqual({ status: 'released', releaseReason: 'scheduler-restart-turn-completed' });
      }
      const desired = packages[3]!;
      authorizeNanoHostPackage(coreDb, desired);
      enqueue(desired);
      const effectsBeforeRetry = effects.length;
      expect(
        coreDb.sqlite
          .prepare(
            `SELECT lifecycle_state AS state, cleanup_state AS cleanupState,
                current_turn_id AS turnId, current_lease_id AS leaseId FROM agent_session_runtime_bindings`
          )
          .all()
      ).toEqual([{ state: 'open', cleanupState: 'clean', turnId: null, leaseId: null }]);
      expect(
        coreDb.sqlite
          .prepare(
            `SELECT active_turn_count AS activeTurns, operation_state AS operationState FROM harness_instance_records`
          )
          .all()
      ).toEqual([{ activeTurns: 0, operationState: 'settled' }]);
      expect(backend.inspectMaterializationCapacity?.(desired)).toBe('available');
      expect(effects).toHaveLength(effectsBeforeRetry);
      dispatch(desired);
      expect(backend.sessions.size).toBe(0);
      const replacement = backend.materialize(desired, { workspaceRoots: [] });
      await settleNext('session.close', {
        state: 'closed',
        privateState: 'absent',
        childState: 'absent',
      });
      await replacement;
      expect(effects.slice(effectsBeforeRetry).map((effect) => effect.kind)).toEqual([
        'workspace.collect',
        'bridge.close',
        'sandbox.delete',
        'image.acquire',
        'image.inspect',
        'sandbox.create',
      ]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it.each([
    null,
    'eviction-cleanup-required',
    'eviction-delete-failed',
    'eviction-live-cleanup',
    'retained_baseline_unavailable',
    'retained_baseline_conflict',
    'git_fetch_commit_unavailable',
    'git_fetch_tls_failed',
    'git_fetch_transport_failed',
    'git_fetch_http_refused',
  ])('reattaches selected storage or surfaces startup failure: %s', async (startupRefused) => {
    const coreDb = createFactoryCoreDb();
    const effects: NanoHostSessionEffectRequest[] = [];
    const expectResultOnly = vi.fn(async () => {
      throw new Error('Unexpected live result-only cleanup registration.');
    });
    const sessionDispatch: NanoHostSessionDispatch = {
      async effect(requestOrConnection: object, carriedRequest?: NanoHostSessionEffectRequest) {
        const request = carriedRequest ?? (requestOrConnection as NanoHostSessionEffectRequest);
        effects.push(request);
        if (request.kind === 'bridge.close' || request.kind === 'sandbox.delete') {
          expect(
            coreDb.sqlite
              .prepare('SELECT cleanup_state AS state FROM sandbox_runtime_records')
              .get()
          ).toEqual({ state: 'clean' });
          if (request.kind === 'sandbox.delete' && startupRefused === 'eviction-delete-failed') {
            throw new Error('Eviction Sandbox delete failed.');
          }
        }
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
        if (request.kind === 'workspace.collect')
          return request.input.mode === 'baseline'
            ? {
                requestId: request.requestId,
                outcome: 'baseline',
                head: {
                  tree: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
                  manifest: 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391',
                },
              }
            : { requestId: request.requestId, outcome: 'no_new_head', unstable: false };
        if (request.kind === 'reference.import') return { state: 'imported' };
        return { state: 'deleted' };
      },
      expectResultOnly,
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
        extensions: {
          openkit: {
            workerStorage: {
              workSlotRef: workerStorageDefaultWorkSlotRef(
                'workspace_idle_eviction_a',
                'thread_idle_eviction_a'
              ),
            },
          },
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
        extensions: {
          openkit: {
            workerStorage: {
              workSlotRef: workerStorageDefaultWorkSlotRef(
                'workspace_idle_eviction_a',
                'thread_idle_eviction_a'
              ),
            },
          },
        },
        snapshotId: 'snapshot_idle_eviction_b',
      });
      authorizeNanoHostPackage(coreDb, firstPackage);
      authorizeNanoHostPackage(coreDb, secondPackage);
      bindNanoHostWorkerLineage(coreDb, firstPackage, {
        leaseId: 'lease-snapshot_idle_eviction_a',
        now: '2026-09-06T00:00:00.000Z',
        planId: 'plan_idle_eviction_a',
        sandboxBindingRef: 'lease-binding:idle-eviction-a',
        selectedPoolId: 'pool_idle_eviction',
        selectedTargetId: 'target_idle_eviction',
      });
      const settleNext = async (
        operation: 'session.open' | 'turn.start' | 'session.inspect' | 'session.close',
        body: Readonly<Record<string, unknown>>,
        disposition: 'succeeded' | 'refused' = 'succeeded'
      ) => {
        let command: ReturnType<typeof dispatchNanoHostHarnessOperation> = null;
        for (let attempt = 0; attempt < 200 && !command; attempt += 1) {
          const integration = coreDb.sqlite
            .prepare(
              `SELECT sandbox_integration_binding_ref AS integrationRef
               FROM sandbox_runtime_records ORDER BY created_at LIMIT 1`
            )
            .get() as { readonly integrationRef: string };
          command = dispatchNanoHostHarnessOperation(coreDb, {
            sandboxIntegrationBindingRef: integration.integrationRef,
          });
          if (!command) await new Promise<void>((resolve) => setTimeout(resolve, 1));
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
            'workspace.collect',
            'workspace.collect',
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
          disposition,
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
      const recordedDigests: string[] = [];
      backend.bindNativeHandleRecorder?.(firstPackage.snapshotId, (digest) => {
        recordedDigests.push(digest);
      });
      const launch = backend.launch(firstMaterialization);

      if (startupRefused && !startupRefused.startsWith('eviction-')) {
        const observedFailure =
          startupRefused === 'git_fetch_http_refused'
            ? ({
                code: 'git_fetch_http_refused',
                stage: 'workspace_materialization',
                operation: 'git.fetch',
                dependency: 'git_remote',
                producer: 'worker-shim',
                observedAt: '2026-09-22T00:00:00.000Z',
                basis: 'direct_observation',
                subprocess: 'exit',
                httpStatus: 403,
                enforcement: 'unavailable',
                evidence: { availability: 'partial', outputTruncated: false },
              } as const)
            : undefined;
        const explanation =
          startupRefused === 'git_fetch_http_refused'
            ? ' Repository access returned HTTP 403; the source of the refusal is not established. Ask an authorized operator to inspect sandbox network policy and upstream access separately, then start a new Task only after cleanup and storage admission allow it. Host repository diagnostics only confirm the local checkout, and the incomplete slot stays in place.'
            : startupRefused === 'retained_baseline_conflict'
              ? ' The retained checkout and requested commit differ; choose a fresh work environment for the requested commit, or restore the source configuration to the retained checkout’s original commit before reusing it.'
              : startupRefused === 'git_fetch_commit_unavailable'
                ? ' The configured Git remote does not serve the requested commit; publish that commit or select one the remote serves, then start a new Task. Host repository diagnostics only confirm the local checkout, and the incomplete slot stays in place.'
                : startupRefused === 'git_fetch_tls_failed'
                  ? ' The worker could not trust the configured Git remote during fetch. Repair the sandbox trust bundle, then start a new Task. Host repository diagnostics only confirm the local checkout, and the incomplete slot stays in place.'
                  : startupRefused === 'git_fetch_transport_failed'
                    ? ' The worker could not complete the Git fetch transport. This covers a subprocess, timeout, or transport failure and is not proof that the remote lacks the commit. Host repository diagnostics only confirm the local checkout, and the incomplete slot stays in place.'
                    : '';
        const observedRejection = launch.catch((error: unknown) => error);
        const rejected = expect(launch).rejects.toMatchObject({
          message: `NanoHost Harness session.open refused: dependency_failed (workspace_materialization: ${startupRefused}).${explanation}`,
          ...(observedFailure ? { explanation: observedFailure } : {}),
        });
        await settleNext(
          'session.open',
          {
            reasonCode: 'dependency_failed',
            startupFailure: {
              stage: 'workspace_materialization',
              reason: startupRefused,
              ...(observedFailure ? { explanation: observedFailure } : {}),
            },
          },
          'refused'
        );
        await rejected;
        if (observedFailure)
          expect(await observedRejection).toHaveProperty('explanation', observedFailure);
        return;
      }
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
      expect(recordedDigests).toEqual(['a'.repeat(64)]);
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
             cleanup_state, created_at, updated_at, image_digest
           ) SELECT 'binding_closed_history', harness_instance_id, 'as_closed_history',
                    'workspace_closed_history', 'thread_closed_history', ?, 1, 'ready', ?,
                    'closed', NULL, NULL, 1, 'clean', ?, ?, ?
             FROM harness_instance_records LIMIT 1`
        )
        .run(
          'f'.repeat(64),
          'e'.repeat(64),
          '2026-09-06T00:00:00.000Z',
          '2026-09-06T00:00:00.000Z',
          `sha256:${'f'.repeat(64)}`
        );

      const selectedChoice = {
        expectedRevision: selectedBinding.revision,
        goalId: null,
        kind: 'selected' as const,
        purpose: 'work' as const,
        storageRef: selectedBinding.storageRef,
        taskId: null,
      };
      anchorNanoHostMaterialization(coreDb, backend, secondPackage);
      await expect(
        backend.prepareAgentSessionContinuity?.({
          agentSessionCompatibilityKey: `sha256:${'e'.repeat(64)}`,
          agentSessionId: firstPackage.scope.agentSessionId,
          environmentPackage: secondPackage,
          reuseAllowed: false,
          threadId: firstPackage.scope.threadId,
          workspaceId: firstPackage.scope.workspaceId,
          workerStorageChoice: {
            ...selectedChoice,
            expectedRevision: selectedBinding.revision - 1,
          },
        })
      ).rejects.toThrow('revision changed');
      expect(
        coreDb.sqlite
          .prepare(
            'SELECT lifecycle_state AS state FROM agent_session_runtime_bindings WHERE agent_session_id = ?'
          )
          .get(firstPackage.scope.agentSessionId)
      ).toEqual({ state: 'open' });
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
      const observedReplacement = replacement.catch((error: unknown) => error);
      if (startupRefused?.startsWith('eviction-')) {
        await settleNext(
          'session.close',
          {
            reasonCode:
              startupRefused === 'eviction-live-cleanup' ? 'conflict' : 'cleanup_required',
          },
          'refused'
        );
      } else {
        await settleNext('session.close', {
          childState: 'absent',
          privateState: 'absent',
          state: 'closed',
        });
      }
      if (startupRefused === 'eviction-live-cleanup') {
        expect(await observedReplacement).toMatchObject({
          message: 'NanoHost Harness session.close refused: conflict.',
        });
        expect(backend.sessions.has(firstPackage.snapshotId)).toBe(false);
        const effectsBeforeCleanup = effects.length;
        await runtime.cleanupBackendSession(backend.planSession(secondPackage));
        expect(expectResultOnly).not.toHaveBeenCalled();
        expect(effects).toHaveLength(effectsBeforeCleanup);
        expect(
          coreDb.sqlite.prepare('SELECT cleanup_state AS state FROM sandbox_runtime_records').get()
        ).toEqual({ state: 'unknown' });
        return;
      }
      if (startupRefused === 'eviction-delete-failed') {
        expect(await observedReplacement).toMatchObject({
          message: 'Eviction Sandbox delete failed.',
        });
        expect(effects.slice(-2).map((effect) => effect.kind)).toEqual([
          'bridge.close',
          'sandbox.delete',
        ]);
        expect(
          coreDb.sqlite.prepare('SELECT cleanup_state AS state FROM sandbox_runtime_records').get()
        ).toEqual({ state: 'unknown' });
        expect(
          getWorkerStorageBinding(coreDb, { storageRef: selectedBinding.storageRef })
        ).toMatchObject({ state: 'unknown' });
        return;
      }
      await replacement;
      expect(backend.sessions.has(firstPackage.snapshotId)).toBe(false);
      expect(expectResultOnly).not.toHaveBeenCalled();

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
        'workspace.collect',
        'workspace.collect',
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

  it('honors explicit selected and fresh storage on a shared resident contributor', async () => {
    const coreDb = createFactoryCoreDb();
    const effects: NanoHostSessionEffectRequest[] = [];
    const imageRef = `sha256:${'a'.repeat(64)}`;
    const workspaceId = 'workspace_shared_choice';
    const threadId = 'thread_shared_choice';
    const peerThreadId = 'thread_shared_choice_peer';
    const triggerActor = { id: 'user-factory', kind: 'user' as const };
    const workSlotRef = workerStorageDefaultWorkSlotRef(workspaceId, threadId);
    try {
      coreDb.sqlite
        .prepare(
          `INSERT INTO nanohost_runtime_targets (
             target_id, identity_id, deployment_id, connection_generation,
             predecessor_fenced, ready, fresh_empty, physical_epoch, observed_at, slot_count
           ) VALUES ('target_shared_choice', 'identity_shared_choice', 'deployment_shared_choice',
                     1, 1, 1, 1, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', ?, 1)`
        )
        .run('2026-09-17T00:00:00.000Z');
      const runtime = createConfiguredWorkerLifecycleRuntime({
        coreDb,
        env: {},
        nanoHostSessionDispatch: createFactoryNanoHostDispatch(effects),
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
      const leaseIdFor = (environmentPackage: AgentEnvironmentPackage) =>
        `lease-${environmentPackage.snapshotId}`;
      const latestSandboxBindingRef = () =>
        (
          coreDb.sqlite
            .prepare(
              `SELECT sandbox_binding_ref AS sandboxBindingRef FROM sandbox_runtime_records
               ORDER BY created_at DESC LIMIT 1`
            )
            .get() as { readonly sandboxBindingRef: string }
        ).sandboxBindingRef;
      const packageFor = (
        label: string,
        input: { readonly threadId?: string; readonly workSlotRef?: string } = {}
      ) =>
        completeNanoHostPackage({
          createdAt: '2026-09-17T00:00:00.000Z',
          extensions: {
            openkit: {
              workerStorage: { workSlotRef: input.workSlotRef ?? workSlotRef },
            },
          },
          runtime: {
            image: { kind: 'reference', pullPolicy: 'never', ref: imageRef },
          },
          scope: {
            agentSessionId: `as_shared_choice_${label}`,
            requestId: `request_turn_shared_choice_${label}`,
            threadId: input.threadId ?? threadId,
            triggerActor,
            turnId: `turn_shared_choice_${label}`,
            workspaceId,
          },
          snapshotId: `snapshot_shared_choice_${label}`,
        });
      const bindAndAnchor = (environmentPackage: AgentEnvironmentPackage, now: string) => {
        bindNanoHostWorkerLineage(coreDb, environmentPackage, {
          leaseId: leaseIdFor(environmentPackage),
          now,
          sandboxBindingRef: `lease-binding:${environmentPackage.scope.turnId}`,
          selectedPoolId: 'pool_shared_choice',
          selectedTargetId: 'target_shared_choice',
        });
        anchorNanoHostMaterialization(coreDb, backend, environmentPackage);
      };
      const firstPackage = packageFor('a');
      const omittedPackage = packageFor('omitted');
      const selectedSamePackage = packageFor('same');
      const peerPackage = packageFor('peer', { threadId: peerThreadId, workSlotRef });
      const selectedOtherPackage = packageFor('other');
      const selectedOtherRetryPackage = packageFor('other_retry');
      const freshPackage = packageFor('fresh');
      for (const environmentPackage of [
        firstPackage,
        omittedPackage,
        selectedSamePackage,
        peerPackage,
        selectedOtherPackage,
        selectedOtherRetryPackage,
        freshPackage,
      ]) {
        authorizeNanoHostPackage(coreDb, environmentPackage);
      }
      bindAndAnchor(firstPackage, '2026-09-17T00:00:00.000Z');
      await backend.materialize(firstPackage, { workspaceRoots: [] });
      const residentBinding = getWorkerStorageBindingForSandbox(coreDb, {
        sandboxBindingRef: latestSandboxBindingRef(),
      });
      if (!residentBinding) throw new Error('Expected attached retained storage.');
      expect(residentBinding.currentWorkSlotRef).toBe(workSlotRef);

      const effectsAfterFirst = effects.length;
      bindAndAnchor(omittedPackage, '2026-09-17T00:00:01.000Z');
      await backend.materialize(omittedPackage, { workspaceRoots: [] });
      expect(effects.filter((effect) => effect.kind === 'sandbox.create')).toHaveLength(1);
      expect(effects.filter((effect) => effect.kind === 'sandbox.delete')).toHaveLength(0);
      expect(
        getWorkerStorageBindingForSandbox(coreDb, {
          sandboxBindingRef: residentBinding.currentSandboxBindingRef!,
        })?.storageRef
      ).toBe(residentBinding.storageRef);

      const sameRefChoice = {
        expectedRevision: residentBinding.revision,
        goalId: null,
        kind: 'selected' as const,
        purpose: 'work' as const,
        reuseWorkSlotRef: workSlotRef,
        storageRef: residentBinding.storageRef,
        taskId: null,
      };
      bindAndAnchor(selectedSamePackage, '2026-09-17T00:00:02.000Z');
      const effectsBeforeStale = effects.length;
      await expect(
        backend.materialize(selectedSamePackage, {
          workerStorageChoice: { ...sameRefChoice, expectedRevision: residentBinding.revision - 1 },
          workspaceRoots: [],
        })
      ).rejects.toThrow('revision changed');
      await expect(
        backend.materialize(selectedSamePackage, {
          workerStorageChoice: { ...sameRefChoice, reuseWorkSlotRef: 'wsl_missing_selected_slot' },
          workspaceRoots: [],
        })
      ).rejects.toThrow('work slot is unavailable');
      expect(effects).toHaveLength(effectsBeforeStale);

      await backend.materialize(selectedSamePackage, {
        workerStorageChoice: sameRefChoice,
        workspaceRoots: [],
      });
      expect(
        getWorkerStorageBinding(coreDb, { storageRef: residentBinding.storageRef })
      ).toMatchObject({
        currentWorkSlotRef: workSlotRef,
        revision: residentBinding.revision,
        state: 'attached',
      });
      expect(effects).toHaveLength(effectsBeforeStale);

      bindAndAnchor(peerPackage, '2026-09-17T00:00:03.000Z');
      await expect(
        backend.materialize(peerPackage, {
          workerStorageChoice: { ...sameRefChoice, expectedRevision: residentBinding.revision - 1 },
          workspaceRoots: [],
        })
      ).rejects.toThrow('revision changed');
      await expect(
        backend.materialize(peerPackage, {
          workerStorageChoice: { ...sameRefChoice, reuseWorkSlotRef: 'wsl_missing_peer_slot' },
          workspaceRoots: [],
        })
      ).rejects.toThrow('work slot is unavailable');
      expect(effects).toHaveLength(effectsBeforeStale);
      expect(effectsAfterFirst).toBeGreaterThan(0);

      const layout = residentBinding.layout;
      const createdOther = createWorkerStorageBinding(coreDb, {
        deploymentId: 'deployment_shared_choice',
        layout,
        runtimeTargetId: 'target_shared_choice',
        workspaceId,
      });
      const reservedOther = reserveWorkerStorageAttachment(coreDb, {
        agentSessionId: 'as_shared_choice_other_seed',
        authorizeContributor: () => true,
        expectedRevision: createdOther.revision,
        layout,
        purpose: 'work',
        responsibleUserId: 'user-factory',
        runtimeTargetId: 'target_shared_choice',
        storageRef: createdOther.storageRef,
        threadId,
        workspaceId,
      });
      const idleOtherFirst = releaseWorkerStorageAttachment(coreDb, {
        attachmentGeneration: reservedOther.attachmentGeneration,
        cleanupProved: true,
        expectedRevision: reservedOther.revision,
        storageRef: reservedOther.storageRef,
      });
      const peerSlot = workerStorageDefaultWorkSlotRef(workspaceId, peerThreadId);
      const reservedPeer = reserveWorkerStorageAttachment(coreDb, {
        agentSessionId: 'as_shared_choice_peer_seed',
        authorizeContributor: () => true,
        expectedRevision: idleOtherFirst.revision,
        layout,
        purpose: 'work',
        responsibleUserId: 'user-factory',
        runtimeTargetId: 'target_shared_choice',
        storageRef: idleOtherFirst.storageRef,
        threadId: peerThreadId,
        workspaceId,
      });
      const idleOther = releaseWorkerStorageAttachment(coreDb, {
        attachmentGeneration: reservedPeer.attachmentGeneration,
        cleanupProved: true,
        expectedRevision: reservedPeer.revision,
        storageRef: reservedPeer.storageRef,
      });
      const otherChoice = {
        expectedRevision: idleOther.revision,
        goalId: null,
        kind: 'selected' as const,
        purpose: 'work' as const,
        reuseWorkSlotRef: workSlotRef,
        storageRef: idleOther.storageRef,
        taskId: null,
      };
      bindAndAnchor(selectedOtherPackage, '2026-09-17T00:00:04.000Z');
      await expect(
        backend.materialize(selectedOtherPackage, {
          workerStorageChoice: otherChoice,
          workspaceRoots: [],
        })
      ).rejects.toThrow('capacity is occupied or unproved');
      expect(getWorkerStorageBinding(coreDb, { storageRef: idleOther.storageRef })?.state).toBe(
        'idle'
      );
      expect(
        getWorkerStorageBinding(coreDb, { storageRef: residentBinding.storageRef })?.state
      ).toBe('attached');
      expect(getWorkerStorageBinding(coreDb, { storageRef: idleOther.storageRef })?.revision).toBe(
        idleOther.revision
      );

      for (const snapshotId of [
        firstPackage.snapshotId,
        omittedPackage.snapshotId,
        selectedSamePackage.snapshotId,
      ]) {
        backend.sessions.delete(snapshotId);
      }
      coreDb.sqlite
        .prepare(
          `UPDATE scheduler_session_leases SET status = 'released'
           WHERE lease_id IN (?, ?, ?, ?, ?)`
        )
        .run(
          leaseIdFor(firstPackage),
          leaseIdFor(omittedPackage),
          leaseIdFor(selectedSamePackage),
          leaseIdFor(peerPackage),
          leaseIdFor(selectedOtherPackage)
        );

      bindAndAnchor(selectedOtherRetryPackage, '2026-09-17T00:00:05.000Z');
      const effectsBeforeStaleOther = effects.length;
      const residentSandboxBeforeStaleOther = coreDb.sqlite
        .prepare(
          `SELECT sandbox_binding_ref AS sandboxBindingRef, drain_state AS drainState
           FROM sandbox_runtime_records`
        )
        .get() as { readonly drainState: string; readonly sandboxBindingRef: string } | undefined;
      expect(residentSandboxBeforeStaleOther).toBeDefined();
      expect(residentSandboxBeforeStaleOther?.drainState).toBe('accepting');
      await expect(
        backend.materialize(selectedOtherRetryPackage, {
          workerStorageChoice: { ...otherChoice, expectedRevision: idleOther.revision - 1 },
          workspaceRoots: [],
        })
      ).rejects.toThrow('revision changed');
      await expect(
        backend.materialize(selectedOtherRetryPackage, {
          workerStorageChoice: { ...otherChoice, reuseWorkSlotRef: 'wsl_missing_other_slot' },
          workspaceRoots: [],
        })
      ).rejects.toThrow('work slot is unavailable');
      expect(effects).toHaveLength(effectsBeforeStaleOther);
      expect(
        coreDb.sqlite
          .prepare(
            `SELECT sandbox_binding_ref AS sandboxBindingRef, drain_state AS drainState
             FROM sandbox_runtime_records`
          )
          .get()
      ).toEqual(residentSandboxBeforeStaleOther);
      expect(
        getWorkerStorageBinding(coreDb, { storageRef: residentBinding.storageRef })
      ).toMatchObject({
        currentSandboxBindingRef: residentSandboxBeforeStaleOther!.sandboxBindingRef,
        state: 'attached',
      });
      expect(getWorkerStorageBinding(coreDb, { storageRef: idleOther.storageRef })).toMatchObject({
        revision: idleOther.revision,
        state: 'idle',
      });
      await backend.materialize(selectedOtherRetryPackage, {
        workerStorageChoice: otherChoice,
        workspaceRoots: [],
      });
      const replaced = getWorkerStorageBindingForSandbox(coreDb, {
        sandboxBindingRef: latestSandboxBindingRef(),
      });
      expect(replaced?.storageRef).toBe(idleOther.storageRef);
      expect(replaced?.state).toBe('attached');
      expect(
        getWorkerStorageBinding(coreDb, { storageRef: residentBinding.storageRef })?.state
      ).toBe('idle');
      expect(getWorkerStorageBinding(coreDb, { storageRef: idleOther.storageRef })?.revision).toBe(
        idleOther.revision + 2
      );

      backend.sessions.delete(selectedOtherRetryPackage.snapshotId);
      coreDb.sqlite
        .prepare(
          `UPDATE scheduler_session_leases SET status = 'released'
           WHERE lease_id = ?`
        )
        .run(leaseIdFor(selectedOtherRetryPackage));
      const alternatePackage = packageFor('alternate', { workSlotRef: peerSlot });
      authorizeNanoHostPackage(coreDb, alternatePackage);
      bindAndAnchor(alternatePackage, '2026-09-17T00:00:06.000Z');
      const beforeHandoff = effects.length;
      await backend.materialize(alternatePackage, {
        workerStorageChoice: {
          ...otherChoice,
          expectedRevision: replaced!.revision,
          reuseWorkSlotRef: peerSlot,
        },
        workspaceRoots: [],
      });
      const handedOff = getWorkerStorageBinding(coreDb, { storageRef: idleOther.storageRef });
      expect(handedOff).toMatchObject({
        attachmentGeneration: replaced!.attachmentGeneration + 1,
        currentWorkSlotRef: peerSlot,
        state: 'attached',
      });
      expect(effects.slice(beforeHandoff).map((effect) => effect.kind)).toEqual([
        'sandbox.delete',
        'image.acquire',
        'image.inspect',
        'sandbox.create',
      ]);
      backend.sessions.delete(alternatePackage.snapshotId);
      coreDb.sqlite
        .prepare("UPDATE scheduler_session_leases SET status = 'released' WHERE lease_id = ?")
        .run(leaseIdFor(alternatePackage));
      const otherAfterCleanup = getWorkerStorageBinding(coreDb, {
        storageRef: idleOther.storageRef,
      });
      bindAndAnchor(freshPackage, '2026-09-17T00:00:06.000Z');
      await backend.materialize(freshPackage, {
        workerStorageChoice: { goalId: null, kind: 'fresh', taskId: null },
        workspaceRoots: [],
      });
      const freshBinding = getWorkerStorageBindingForSandbox(coreDb, {
        sandboxBindingRef: latestSandboxBindingRef(),
      });
      expect(freshBinding?.storageRef).not.toBe(otherAfterCleanup?.storageRef);
      expect(freshBinding?.storageRef).not.toBe(residentBinding.storageRef);
      expect(getWorkerStorageBinding(coreDb, { storageRef: idleOther.storageRef })?.state).toBe(
        'idle'
      );
    } finally {
      coreDb.sqlite.close();
    }
  });

  it.each([
    { label: 'previous-Epoch A2', origin: 'f'.repeat(64), dirty: false, operation: 'dispatched' },
    { label: 'same-Epoch A2', origin: 'a'.repeat(64), dirty: false, operation: 'dispatched' },
    { label: 'previous-Epoch queued', origin: 'f'.repeat(64), dirty: false, operation: 'queued' },
    { label: 'previous-Epoch dirty', origin: 'f'.repeat(64), dirty: true, operation: 'dispatched' },
  ] as const)('handles $label resident admission without replaying old Harness work', async ({
    origin,
    dirty,
    operation,
  }) => {
    const coreDb = createFactoryCoreDb();
    const effects: NanoHostSessionEffectRequest[] = [];
    try {
      coreDb.sqlite.exec(`INSERT INTO nanohost_runtime_targets (
        target_id, identity_id, deployment_id, connection_generation,
        predecessor_fenced, ready, fresh_empty, physical_epoch, observed_at, slot_count
      ) VALUES ('target_capacity_guard', 'identity_capacity_guard', 'deployment_capacity_guard',
        83, 1, 1, 1, '${'a'.repeat(64)}', '2026-10-02T10:09:16.893Z', 1)`);
      createNanoHostHarnessRuntime(coreDb, {
        adapterId: 'codex',
        adapterVersion: '0.159.2',
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
        timestamp: '2026-10-02T07:57:21.621Z',
      });
      openNanoHostAgentSessionBinding(coreDb, {
        agentSessionCompatibilityKey: 'd'.repeat(64),
        agentSessionId: 'as_capacity_guard_resident',
        agentSessionRuntimeBindingId: 'binding-capacity-guard',
        effectiveSetupGeneration: 1,
        harnessInstanceId: 'harness-capacity-guard',
        threadId: 'thread_capacity_guard_resident',
        timestamp: '2026-10-02T07:57:21.621Z',
        workspaceId: 'workspace_capacity_guard_resident',
      });
      coreDb.sqlite.exec("UPDATE agent_session_runtime_bindings SET lifecycle_state = 'open'");
      coreDb.sqlite.exec('UPDATE harness_instance_records SET next_sequence = 3');
      queueNanoHostHarnessOperation(coreDb, {
        body: {
          agentSessionId: 'as_capacity_guard_resident',
          agentSessionRuntimeBindingId: 'binding-capacity-guard',
        },
        harnessInstanceId: 'harness-capacity-guard',
        operation: 'session.close',
        timestamp: '2026-10-02T08:02:18.267Z',
      });
      if (operation === 'dispatched') {
        expect(
          dispatchNanoHostHarnessOperation(coreDb, {
            sandboxIntegrationBindingRef: 'integration-binding-capacity-guard',
            now: () => '2026-10-02T08:02:19.267Z',
          })
        ).not.toBeNull();
      }
      coreDb.sqlite
        .prepare('UPDATE sandbox_runtime_records SET origin_physical_epoch = ?')
        .run(origin);
      if (dirty) {
        coreDb.sqlite.exec(`UPDATE sandbox_runtime_records SET lifecycle_state = 'closed',
          health_state = 'unknown', drain_state = 'draining', cleanup_state = 'unknown';
          UPDATE harness_instance_records SET lifecycle_state = 'closed', drain_state = 'draining';
          UPDATE agent_session_runtime_bindings SET lifecycle_state = 'failed', cleanup_state = 'unknown'`);
      }
      const retainedStorage = attachNanoHostStorageFixture(coreDb, {
        agentSessionId: 'as_capacity_guard_resident',
        deploymentId: 'deployment_capacity_guard',
        runtimeTargetId: 'target_capacity_guard',
        sandboxBindingRef: 'sandbox-binding-capacity-guard',
        threadId: 'thread_capacity_guard_resident',
        workspaceId: 'workspace_capacity_guard_resident',
      });
      // Observe the durable disposition at retirement, before the private row cascades away.
      coreDb.sqlite.exec(`CREATE TEMP TABLE retired_harness_operations (operation_state TEXT);
        CREATE TEMP TRIGGER observe_harness_retirement BEFORE DELETE ON harness_instance_records
        BEGIN INSERT INTO retired_harness_operations VALUES (OLD.operation_state); END;`);
      const runtime = createConfiguredWorkerLifecycleRuntime({
        coreDb,
        env: {},
        nanoHostSessionDispatch: {
          async effect(requestOrConnection: object, carriedRequest?: NanoHostSessionEffectRequest) {
            const request = carriedRequest ?? (requestOrConnection as NanoHostSessionEffectRequest);
            effects.push(request);
            if (request.kind === 'image.acquire') return { digest: request.input.imageReference };
            if (request.kind === 'image.inspect') return nanoHostImageInspection(request);
            if (request.kind === 'sandbox.create') return nanoHostSandboxCreated(request);
            throw new Error(`Unexpected old-Epoch effect: ${request.kind}`);
          },
          async poll() {
            return null;
          },
          async result() {},
          async route() {
            throw new Error('Unexpected semantic route.');
          },
        },
        workerControlGateway: new WorkerControlGateway(),
      });
      const backend = (
        runtime.turnExecutor as unknown as { readonly backend: WorkerGovernanceBackend }
      ).backend;
      const residentPackage = completeNanoHostPackage({
        scope: {
          agentSessionId: 'as_capacity_guard_resident',
          threadId: 'thread_capacity_guard_resident',
          turnId: 'turn_capacity_guard_resident',
          workspaceId: 'workspace_capacity_guard_resident',
        },
        snapshotId: 'snapshot_capacity_guard_resident',
      });
      authorizeNanoHostPackage(coreDb, residentPackage);
      anchorNanoHostMaterialization(coreDb, backend, residentPackage);
      coreDb.sqlite
        .prepare(`UPDATE scheduler_session_leases
        SET sandbox_binding_ref = 'sandbox-binding-capacity-guard', status = 'released',
          release_reason = 'scheduler-restart-backend-cleanup', backend_anchor_state = 'anchored'
        WHERE agent_session_id = 'as_capacity_guard_resident'`)
        .run();
      coreDb.sqlite
        .prepare(`UPDATE worker_backend_sessions
        SET sandbox_binding_ref = 'sandbox-binding-capacity-guard', state = 'cleaned',
          workspace_handoff_state = 'complete', physical_cleaned_at = '2026-10-02T08:01:37.559Z',
          origin_physical_epoch = ? WHERE agent_session_id = 'as_capacity_guard_resident'`)
        .run(origin);
      const oldLease = coreDb.sqlite
        .prepare(
          "SELECT * FROM scheduler_session_leases WHERE agent_session_id = 'as_capacity_guard_resident'"
        )
        .get();
      const oldBackend = coreDb.sqlite
        .prepare(
          "SELECT * FROM worker_backend_sessions WHERE agent_session_id = 'as_capacity_guard_resident'"
        )
        .get();
      expect(
        coreDb.sqlite
          .prepare(
            'SELECT open_session_count, active_turn_count, operation, result_json FROM harness_instance_records'
          )
          .get()
      ).toEqual({
        open_session_count: 1,
        active_turn_count: 0,
        operation: 'session.close',
        result_json: null,
      });
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
      authorizeNanoHostPackage(coreDb, desiredPackage);
      if (origin === 'a'.repeat(64)) {
        expect(backend.inspectMaterializationCapacity?.(desiredPackage)).toBe('capacity-saturated');
        anchorNanoHostMaterialization(coreDb, backend, desiredPackage);
        await expect(backend.materialize(desiredPackage, { workspaceRoots: [] })).rejects.toThrow(
          'capacity is occupied or unproved'
        );
        expect(effects).toEqual([]);
        expect(
          coreDb.sqlite.prepare('SELECT operation_state FROM harness_instance_records').all()
        ).toEqual([{ operation_state: 'dispatched' }]);
        expect(getWorkerStorageBinding(coreDb, { storageRef: retainedStorage.storageRef })).toEqual(
          retainedStorage
        );
        return;
      }
      // Physical absence cannot settle a live scheduler owner or a current Turn reference.
      coreDb.sqlite.exec(
        "UPDATE scheduler_session_leases SET status = 'active' WHERE agent_session_id = 'as_capacity_guard_resident'"
      );
      expect(backend.inspectMaterializationCapacity?.(desiredPackage)).toBe('capacity-saturated');
      coreDb.sqlite.exec(
        "UPDATE scheduler_session_leases SET status = 'released' WHERE agent_session_id = 'as_capacity_guard_resident'"
      );
      for (const field of ['current_turn_id', 'current_lease_id']) {
        coreDb.sqlite.exec(
          `UPDATE agent_session_runtime_bindings SET ${field} = 'unsettled-owner'`
        );
        expect(backend.inspectMaterializationCapacity?.(desiredPackage)).toBe('capacity-saturated');
        coreDb.sqlite.exec(`UPDATE agent_session_runtime_bindings SET ${field} = NULL`);
      }
      expect(backend.inspectMaterializationCapacity?.(desiredPackage)).toBe('available');
      expect(effects).toEqual([]);
      expect(
        coreDb.sqlite.prepare('SELECT operation_state FROM harness_instance_records').all()
      ).toEqual([{ operation_state: operation }]);
      anchorNanoHostMaterialization(coreDb, backend, desiredPackage);
      await backend.materialize(desiredPackage, { workspaceRoots: [] });
      expect(effects.map((effect) => effect.kind)).toEqual([
        'image.acquire',
        'image.inspect',
        'sandbox.create',
      ]);
      expect(coreDb.sqlite.prepare('SELECT * FROM retired_harness_operations').all()).toEqual([
        { operation_state: 'unknown' },
      ]);
      expect(
        coreDb.sqlite
          .prepare('SELECT origin_physical_epoch AS origin FROM sandbox_runtime_records')
          .all()
      ).toEqual([{ origin: 'a'.repeat(64) }]);
      expect(
        coreDb.sqlite
          .prepare(
            "SELECT 1 FROM agent_session_runtime_bindings WHERE agent_session_runtime_binding_id = 'binding-capacity-guard'"
          )
          .get()
      ).toBeUndefined();
      expect(
        getWorkerStorageBinding(coreDb, { storageRef: retainedStorage.storageRef })
      ).toMatchObject({
        state: 'idle',
        revision: retainedStorage.revision + 1,
        attachmentGeneration: retainedStorage.attachmentGeneration,
        contributors: retainedStorage.contributors,
        targets: retainedStorage.targets,
      });
      expect(
        coreDb.sqlite
          .prepare(
            "SELECT * FROM scheduler_session_leases WHERE agent_session_id = 'as_capacity_guard_resident'"
          )
          .get()
      ).toEqual(oldLease);
      expect(
        coreDb.sqlite
          .prepare(
            "SELECT * FROM worker_backend_sessions WHERE agent_session_id = 'as_capacity_guard_resident'"
          )
          .get()
      ).toEqual(oldBackend);
      expect(
        coreDb.sqlite
          .prepare("SELECT state FROM worker_storage_bindings WHERE state = 'attached'")
          .all()
      ).toEqual([{ state: 'attached' }]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it.each([
    ['pre-witness', true, false, 'idle'],
    ['pre-witness', false, false, 'idle'],
    ['pre-witness', true, true, 'idle'],
    ['f'.repeat(64), true, true, 'unknown'],
  ] as const)('retires a failed resident from %s (Harness: %s, storage: %s, operation: %s) before fresh materialization', async (originPhysicalEpoch, withHarness, withStorage, operationState) => {
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
      coreDb.sqlite
        .prepare(
          `UPDATE sandbox_runtime_records
           SET origin_physical_epoch = ?, lifecycle_state = 'failed',
               health_state = 'unknown', drain_state = 'draining', cleanup_state = 'unknown'`
        )
        .run(originPhysicalEpoch);
      coreDb.sqlite.exec(
        `UPDATE harness_instance_records SET lifecycle_state = 'failed', drain_state = 'draining'${
          operationState === 'unknown'
            ? ", operation = 'session.close', operation_state = 'unknown'"
            : ''
        }`
      );
      if (!withHarness) coreDb.sqlite.exec('DELETE FROM harness_instance_records');
      expect(
        coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM worker_storage_bindings').get()
      ).toEqual({ count: 0 });
      const sessionDispatch: NanoHostSessionDispatch = {
        async effect(requestOrConnection: object, carriedRequest?: NanoHostSessionEffectRequest) {
          const request = carriedRequest ?? (requestOrConnection as NanoHostSessionEffectRequest);
          effects.push(request);
          if (request.kind === 'image.acquire') return { digest: request.input.imageReference };
          if (request.kind === 'image.inspect') return nanoHostImageInspection(request);
          if (request.kind === 'sandbox.create') return nanoHostSandboxCreated(request);
          throw new Error(`Unexpected stale Sandbox effect: ${request.kind}`);
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

      const retainedStorage = withStorage
        ? attachNanoHostStorageFixture(coreDb, {
            agentSessionId: 'as_capacity_guard_resident',
            deploymentId: 'deployment_capacity_guard',
            runtimeTargetId: 'target_capacity_guard',
            sandboxBindingRef: 'sandbox-binding-capacity-guard',
            threadId: 'thread_capacity_guard_resident',
            workspaceId: 'workspace_capacity_guard_resident',
          })
        : null;
      for (const readinessField of ['ready', 'fresh_empty', 'predecessor_fenced']) {
        coreDb.sqlite.exec(`UPDATE nanohost_runtime_targets SET ${readinessField} = 0`);
        expect(backend.inspectMaterializationCapacity?.(desiredPackage)).toBe('capacity-saturated');
        coreDb.sqlite.exec(`UPDATE nanohost_runtime_targets SET ${readinessField} = 1`);
      }
      coreDb.sqlite
        .prepare('UPDATE sandbox_runtime_records SET origin_physical_epoch = ?')
        .run('a'.repeat(64));
      expect(backend.inspectMaterializationCapacity?.(desiredPackage)).toBe('capacity-saturated');
      coreDb.sqlite
        .prepare('UPDATE sandbox_runtime_records SET origin_physical_epoch = ?, pinned_goal_id = ?')
        .run(originPhysicalEpoch, 'goal_guard');
      expect(backend.inspectMaterializationCapacity?.(desiredPackage)).toBe('capacity-saturated');
      coreDb.sqlite.exec('UPDATE sandbox_runtime_records SET pinned_goal_id = NULL');
      if (withHarness) {
        // Fresh Epoch absence also retires stale binding lifecycle projections.
        expect(backend.inspectMaterializationCapacity?.(desiredPackage)).toBe('available');
        coreDb.sqlite.exec("UPDATE agent_session_runtime_bindings SET lifecycle_state = 'open'");
        coreDb.sqlite.exec('UPDATE harness_instance_records SET active_turn_count = 1');
        expect(backend.inspectMaterializationCapacity?.(desiredPackage)).toBe('capacity-saturated');
        coreDb.sqlite.exec('UPDATE harness_instance_records SET active_turn_count = 0');
        coreDb.sqlite.exec(
          "UPDATE agent_session_runtime_bindings SET current_lease_id = 'lease_busy'"
        );
        expect(backend.inspectMaterializationCapacity?.(desiredPackage)).toBe('capacity-saturated');
        coreDb.sqlite.exec('UPDATE agent_session_runtime_bindings SET current_lease_id = NULL');
        if (operationState === 'unknown') {
          for (const blockedState of ['queued', 'dispatched'] as const) {
            coreDb.sqlite.exec(
              `UPDATE harness_instance_records SET operation_state = '${blockedState}'`
            );
            expect(backend.inspectMaterializationCapacity?.(desiredPackage)).toBe('available');
          }
          coreDb.sqlite.exec("UPDATE harness_instance_records SET operation_state = 'unknown'");
        }
      }
      authorizeNanoHostPackage(coreDb, desiredPackage);
      expect(backend.inspectMaterializationCapacity?.(desiredPackage)).toBe('available');
      expect(effects).toEqual([]);
      expect(
        coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM sandbox_runtime_records').get()
      ).toEqual({ count: 1 });
      anchorNanoHostMaterialization(coreDb, backend, desiredPackage);
      const lease = coreDb.sqlite
        .prepare(
          'SELECT lease_id AS leaseId, sandbox_binding_ref AS bindingRef FROM scheduler_session_leases'
        )
        .get() as { leaseId: string; bindingRef: string };
      coreDb.sqlite
        .prepare('UPDATE scheduler_session_leases SET sandbox_binding_ref = ? WHERE lease_id = ?')
        .run('sandbox-binding-capacity-guard', lease.leaseId);
      expect(backend.inspectMaterializationCapacity?.(desiredPackage)).toBe('capacity-saturated');
      coreDb.sqlite
        .prepare('UPDATE scheduler_session_leases SET sandbox_binding_ref = ? WHERE lease_id = ?')
        .run(lease.bindingRef, lease.leaseId);
      await backend.materialize(desiredPackage, { workspaceRoots: [] });
      expect(effects.map((effect) => effect.kind)).toEqual([
        'image.acquire',
        'image.inspect',
        'sandbox.create',
      ]);
      expect(
        coreDb.sqlite
          .prepare(
            "SELECT 1 FROM sandbox_runtime_records WHERE sandbox_runtime_id = 'sandbox-runtime-capacity-guard'"
          )
          .get()
      ).toBeUndefined();
      expect(
        coreDb.sqlite
          .prepare('SELECT origin_physical_epoch AS origin FROM sandbox_runtime_records')
          .all()
      ).toEqual([{ origin: 'a'.repeat(64) }]);
      expect(
        coreDb.sqlite
          .prepare("SELECT state FROM worker_storage_bindings WHERE state = 'attached'")
          .all()
      ).toEqual([{ state: 'attached' }]);
      if (retainedStorage) {
        expect(
          getWorkerStorageBinding(coreDb, { storageRef: retainedStorage.storageRef })
        ).toMatchObject({
          state: 'idle',
          revision: retainedStorage.revision + 1,
          attachmentGeneration: retainedStorage.attachmentGeneration,
        });
      } else {
        expect(
          coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM worker_storage_bindings').get()
        ).toEqual({ count: 1 });
      }
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

      bindNanoHostWorkerLineage(coreDb, secondPackage, {
        leaseId: 'lease-restart-unproved-fresh',
        now: '2026-09-06T00:00:02.000Z',
        planId: 'plan-restart-unproved-fresh',
        sandboxBindingRef: 'lease-binding:restart-unproved',
        selectedPoolId: 'pool_restart_unproved',
        selectedTargetId: 'target_restart_unproved',
      });
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
      missingStorage: false,
      concurrentRevisionAdvance: false,
      expectedError: 'injected stop after selected storage reattachment',
      predecessorStatus: 'idle' as const,
    },
    {
      missingStorage: false,
      concurrentRevisionAdvance: true,
      expectedError: 'Worker storage revision changed.',
      predecessorStatus: 'idle' as const,
    },
    {
      missingStorage: false,
      concurrentRevisionAdvance: false,
      expectedError: 'injected stop after selected storage reattachment',
      predecessorStatus: 'failed' as const,
    },
    {
      missingStorage: true,
      concurrentRevisionAdvance: false,
      expectedError: 'injected stop after selected storage reattachment',
      predecessorStatus: 'idle' as const,
    },
    {
      missingStorage: true,
      concurrentRevisionAdvance: false,
      expectedError: 'injected stop after selected storage reattachment',
      predecessorStatus: 'failed' as const,
    },
  ])('carries only its proved cleanup revision through restart-unproved Task admission: predecessor=$predecessorStatus concurrent=$concurrentRevisionAdvance missingStorage=$missingStorage', async ({
    concurrentRevisionAdvance,
    missingStorage,
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
          expect(
            coreDb.sqlite
              .prepare(
                'SELECT state, current_sandbox_binding_ref AS sandboxBindingRef FROM worker_storage_bindings'
              )
              .all()
          ).toEqual([{ state: 'attached', sandboxBindingRef: expect.any(String) }]);
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
      const attached = missingStorage
        ? null
        : attachNanoHostStorageFixture(coreDb, {
            agentSessionId: 'as_restart_selected_idle',
            deploymentId: 'deployment_restart_selected',
            runtimeTargetId: 'target_restart_selected',
            sandboxBindingRef: 'sandbox-binding-restart-selected',
            threadId: 'thread_restart_selected',
            workspaceId: 'workspace_restart_selected',
          });
      selectedStorageRef = attached?.storageRef ?? null;
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
      const selectedChoice = attached
        ? {
            expectedRevision: attached.revision,
            goalId: null,
            kind: 'selected' as const,
            purpose: 'work' as const,
            storageRef: attached.storageRef,
            taskId: null,
          }
        : { kind: 'fresh' as const, goalId: null, taskId: null };
      const runtime = createConfiguredWorkerLifecycleRuntime({
        coreDb,
        env: {},
        nanoHostSessionDispatch: sessionDispatch,
        store,
        workerControlGateway: new WorkerControlGateway(),
      });
      const previewInput = {
        agentSetup: createTestAgentSetup({
          imageRef: `sha256:${'4'.repeat(64)}`,
          requiredCapabilities: ['trusted-worker-inference-relay'],
        }),
        freshAgentSessionId: 'as_restart_selected_next',
        requestId,
        turn: {
          completedAt: null,
          configVersion: null,
          durationMs: null,
          error: null,
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
          agentManifests: [
            createTestAgentSetup({
              imageRef: `sha256:${'4'.repeat(64)}`,
              requiredCapabilities: ['trusted-worker-inference-relay'],
            }).manifest,
          ],
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
          attachmentGeneration: attached ? attached.attachmentGeneration + 1 : 1,
          storageRef: attached?.storageRef ?? expect.any(String),
        });
      }
      expect(effects.slice(0, 2).map(({ kind }) => kind)).toEqual([
        'bridge.close',
        'sandbox.delete',
      ]);
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
        if (request.kind === 'workspace.collect')
          return request.input.mode === 'baseline'
            ? {
                requestId: request.requestId,
                outcome: 'baseline',
                head: {
                  tree: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
                  manifest: 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391',
                },
              }
            : { requestId: request.requestId, outcome: 'no_new_head', unstable: false };
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

  it('materializes a nonmember server-admin Task through exact admission lease lineage', async () => {
    const fixture = prepareNonmemberAdminWorkerStorage('admin_success');
    try {
      expect(
        fixture.coreDb.sqlite
          .prepare('SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
          .get(fixture.workspaceId, fixture.adminUserId)
      ).toBeUndefined();
      await fixture.backend.materialize(fixture.environmentPackage, { workspaceRoots: [] });
      expect(fixture.effects.map((effect) => effect.kind)).toEqual([
        'image.acquire',
        'image.inspect',
        'sandbox.create',
      ]);
      const sandboxEffect = fixture.effects.find((effect) => effect.kind === 'sandbox.create');
      if (!sandboxEffect) throw new Error('Expected Sandbox creation effect.');
      const storage = sandboxEffect.input.storage as { storageRef: string };
      expect(
        getWorkerStorageBinding(fixture.coreDb, {
          storageRef: storage.storageRef,
        })?.contributors.map((contributor) => contributor.responsibleUserId)
      ).toEqual([fixture.adminUserId]);
    } finally {
      fixture.coreDb.sqlite.close();
    }
  });

  it('preserves contributor authorization denial after inspect and skips sandbox cleanup effects', async () => {
    const fixture = prepareNonmemberAdminWorkerStorage('admin_revoked');
    try {
      fixture.hooks.onInspect = () => {
        fixture.coreDb.sqlite
          .prepare(
            "UPDATE openkit_access_tokens SET status = 'revoked', revoked_at = ? WHERE token_id = ?"
          )
          .run(new Date().toISOString(), fixture.tokenId);
      };
      await expect(
        fixture.backend.materialize(fixture.environmentPackage, { workspaceRoots: [] })
      ).rejects.toMatchObject({
        code: 'authorization_denied',
        message: 'Worker storage contributor is not currently authorized.',
        name: 'WorkerStorageBindingError',
      });
      expect(fixture.effects.map((effect) => effect.kind)).toEqual([
        'image.acquire',
        'image.inspect',
      ]);
      await expect(
        fixture.runtime.cleanupBackendSession(
          fixture.backend.planSession(fixture.environmentPackage)
        )
      ).resolves.toBeUndefined();
      expect(fixture.effects.map((effect) => effect.kind)).toEqual([
        'image.acquire',
        'image.inspect',
      ]);
      expect(
        fixture.coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM worker_storage_bindings').get()
      ).toEqual({ count: 0 });
    } finally {
      fixture.coreDb.sqlite.close();
    }
  });

  it('denies selected reuse of a retained foreign-private storage contributor', async () => {
    const fixture = prepareNonmemberAdminWorkerStorage('admin_foreign');
    try {
      const store = new FsStore({ dataRoot: fixture.coreDb.dataRoot });
      const privateThread = store.createThread(
        fixture.workspaceId,
        'Foreign private',
        'thread_foreign_private',
        'conversation',
        { privateOwnerUserId: fixture.ownerUserId, visibility: 'private' }
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
      const created = createWorkerStorageBinding(fixture.coreDb, {
        deploymentId: `deployment_admin_foreign`,
        layout,
        runtimeTargetId: 'target_admin_foreign',
        workspaceId: fixture.workspaceId,
      });
      const reserved = reserveWorkerStorageAttachment(fixture.coreDb, {
        agentSessionId: 'as_foreign_private',
        authorizeContributor: () => true,
        expectedRevision: created.revision,
        layout,
        purpose: 'work',
        responsibleUserId: fixture.adminUserId,
        runtimeTargetId: 'target_admin_foreign',
        storageRef: created.storageRef,
        threadId: privateThread.id,
        workspaceId: fixture.workspaceId,
      });
      const attached = activateWorkerStorageAttachment(fixture.coreDb, {
        attachmentGeneration: reserved.attachmentGeneration,
        expectedRevision: reserved.revision,
        sandboxBindingRef: 'sandbox-binding:foreign-private',
        storageRef: reserved.storageRef,
        targets: reserved.targets.map((target) => ({ ...target, initialized: true })),
      });
      const idle = releaseWorkerStorageAttachment(fixture.coreDb, {
        attachmentGeneration: attached.attachmentGeneration,
        cleanupProved: true,
        expectedRevision: attached.revision,
        sandboxBindingRef: 'sandbox-binding:foreign-private',
        storageRef: attached.storageRef,
      });
      await expect(
        fixture.backend.materialize(fixture.environmentPackage, {
          workerStorageChoice: {
            expectedRevision: idle.revision,
            goalId: null,
            kind: 'selected',
            purpose: 'work',
            storageRef: idle.storageRef,
            taskId: null,
          },
          workspaceRoots: [],
        })
      ).rejects.toMatchObject({
        code: 'authorization_denied',
        message: 'Worker storage contributor audience is no longer authorized.',
      });
      expect(
        getWorkerStorageBinding(fixture.coreDb, { storageRef: idle.storageRef })
      ).toMatchObject({
        revision: idle.revision,
        state: 'idle',
      });
      expect(fixture.effects.map((effect) => effect.kind)).toEqual([
        'image.acquire',
        'image.inspect',
      ]);
      await expect(
        fixture.runtime.cleanupBackendSession(
          fixture.backend.planSession(fixture.environmentPackage)
        )
      ).resolves.toBeUndefined();
      expect(fixture.effects.map((effect) => effect.kind)).toEqual([
        'image.acquire',
        'image.inspect',
      ]);
    } finally {
      fixture.coreDb.sqlite.close();
    }
  });

  it('denies storage admission after the exact lease is no longer live', async () => {
    const fixture = prepareNonmemberAdminWorkerStorage('admin_expired');
    try {
      fixture.coreDb.sqlite
        .prepare(
          "UPDATE scheduler_session_leases SET status = 'released', expires_at = '2000-01-01T00:00:00.000Z' WHERE lease_id = ?"
        )
        .run('lease_admin_expired');
      await expect(
        fixture.backend.materialize(fixture.environmentPackage, { workspaceRoots: [] })
      ).rejects.toMatchObject({
        code: 'authorization_denied',
        name: 'WorkerStorageBindingError',
      });
      expect(fixture.effects.map((effect) => effect.kind)).toEqual([
        'image.acquire',
        'image.inspect',
      ]);
    } finally {
      fixture.coreDb.sqlite.close();
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
