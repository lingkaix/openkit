import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect as connectHttp2, createServer as createHttp2Server } from 'node:http2';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AgentEnvironmentPackage,
  AgentEnvironmentPackageSchema,
  planSessionWorkspaceMaterialization,
  type SessionWorkspaceMaterializationPlan,
} from '@openkit/config-schema';
import { describe, expect, it, vi } from 'vitest';
import { createDefaultWorkerControlGateway } from '../app.js';
import { createOpenKitAccessTokenRecord } from '../auth/access-token-store.js';
import { ensureLocalUser } from '../auth/identity.js';
import {
  createNanoHostTransportSessionAuthority,
  readNanoHostPhysicalConnectionContext,
} from '../auth/nanohost-transport-session.js';
import { SimulatedTurnExecutor } from '../lib/simulator.js';
import { createDemoWorkspaceForUser, FsStore } from '../lib/store.js';
import { ProviderRegistry } from '../providers/registry.js';
import * as attemptActionOwners from '../scheduler-records.js';
import { createSchedulerAdmissionEntry } from '../scheduler-records.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { ensureLayout } from '../storage/fs-layout.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import {
  createTestAgentSetup,
  createTestGatewayConfig,
} from '../test-support/agent-environment.js';
import { createAppWithWorkspaceAuthority } from '../test-support/app.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { recordTestExecutionAttempt } from '../test-support/execution-attempt.js';
import {
  admitTestNativeEnvironment,
  createTestNativeEnvironmentDb,
} from '../test-support/native-environment.js';
import { operationRequest } from '../test-support/operation-request.js';
import type { VaultBackend } from '../vault/vault-backend.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import {
  recordAgentEnvironmentPackageSnapshot,
  requireAgentEnvironmentPackageSnapshot,
} from './aep-snapshot-ledger.js';
import {
  resolveAgentEnvironmentPackageMetadata as resolveMetadata,
  resolveAgentEnvironmentPackage as resolvePackage,
} from './agent-environment.js';
import * as attempts from './execution-attempt-records.js';
import {
  acceptSchedulerExecutionObservation,
  recordSchedulerExecutionOperation,
  schedulerExecutionCorrelation,
} from './execution-attempt-records.js';
import { bindNanoHostAttemptPreparation } from './nanohost-attempt-records.js';
import { runNanoHostAttemptRecoveryMaintenance } from './nanohost-attempt-recovery.js';
import {
  createNanoHostEffectRequest,
  stableNanoHostEffectJson,
} from './nanohost-effect-identity.js';
import {
  createNanoHostHarnessRuntime,
  deriveNanoHostAgentSessionCompatibilityKey,
  dispatchNanoHostHarnessOperation,
  inspectNanoHostAgentSessionContinuity,
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
import {
  createNanoHostSessionDispatch,
  NANO_HOST_EFFECT_OPERATIONS,
} from './nanohost-session-dispatch.js';
import { runSchedulerDispatchLoop } from './scheduler-dispatch-loop.js';
import {
  createConfiguredTurnExecutor,
  createConfiguredWorkerLifecycleRuntime,
} from './turn-executor-factory.js';
import type { PrepareAgentSessionForTurnInput } from './types.js';
import {
  getWorkerBackendSession,
  markWorkerBackendWorkspaceHandoffComplete,
  transitionWorkerBackendSessionState,
} from './worker-backend-sessions.js';
import { WorkerControlGateway } from './worker-control-gateway.js';
import { recordWorkerControlAcceptedRecord } from './worker-control-records.js';
import { createWorkerEnvironmentRuntimeEffects } from './worker-environment-runtime-effects.js';
import {
  openShellFilesystemGrantsFromPackagePolicy,
  type WorkerArtifactCapture,
  type WorkerGovernanceBackend,
  type WorkerGovernanceBackendSessionIdentity,
  WorkerGovernanceCapacityUnavailableError,
  WorkerNativeProofValidationError,
} from './worker-governance-backend.js';
import {
  agentSessionCompatibilityKeyFromPackage,
  WorkerGovernanceTurnExecutor,
} from './worker-governance-turn-executor.js';
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
  acceptWorkspaceBaseline,
  authorizeWorkspaceBaselineInitialization,
  readWorkspaceSnapshotCursor,
} from './workspace-snapshot-chain.js';

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
    note: 'ignored',
    storage: {
      ...storage,
      note: 'ignored',
      targets: storage.targets.map((target) => ({ ...target, initialized: true, note: 'ignored' })),
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

/** Records the exact originating admission and prepared Core attempt for one Worker package. */
function bindNanoHostWorkerLineage(
  coreDb: ReturnType<typeof createFactoryCoreDb>,
  environmentPackage: AgentEnvironmentPackage,
  input: {
    readonly attemptId: string;
    readonly sandboxBindingRef: string;
    readonly queueEntryId?: string;
    readonly serverAdminTokenId?: string | null;
  }
): void {
  // Package authorship time is retained history; this newly acquired Native authority is live now.
  const now = new Date().toISOString();
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
    existingAdmission?.queueEntryId ?? input.queueEntryId ?? `queue:${input.attemptId}`;
  if (!existingAdmission) {
    createSchedulerAdmissionEntry(coreDb, {
      backendId: 'nanohost',
      now: () => now,
      queueEntryId,
      requestId: environmentPackage.scope.requestId,
      requestedAgentId: environmentPackage.agent.agentId,
      serverAdminTokenId: input.serverAdminTokenId ?? null,
      threadId: environmentPackage.scope.threadId,
      triggerActor: environmentPackage.scope.triggerActor,
      turnId: environmentPackage.scope.turnId,
      turnInput: 'Factory worker storage fixture',
      workspaceId: environmentPackage.scope.workspaceId,
    });
  }
  if (
    !coreDb.sqlite
      .prepare('SELECT 1 FROM scheduler_execution_attempts WHERE attempt_id = ?')
      .get(input.attemptId)
  ) {
    recordTestExecutionAttempt(coreDb, {
      entry: attemptActionOwners.requireSchedulerAdmissionEntry(coreDb, queueEntryId),
      attemptId: input.attemptId,
      agentSessionId: environmentPackage.scope.agentSessionId,
      inputRef: environmentPackage.snapshotId,
      bindingRef: input.sandboxBindingRef,
      sessionCompatibilityKey: (
        environmentPackage.extensions.openkit as {
          sessionWorkspace: SessionWorkspaceMaterializationPlan;
        }
      ).sessionWorkspace.compatibilityKey.digest,
      now: () => now,
    });
  }
}

/** Drives the actual preparation and submission crossings of a directly-authored Native fixture. */
async function submitTestNanoHostTurn(
  coreDb: ReturnType<typeof createFactoryCoreDb>,
  backend: WorkerGovernanceBackend,
  materialization: Parameters<WorkerGovernanceBackend['prepareLaunch']>[0]
) {
  await backend.prepareLaunch(materialization);
  const attempt = coreDb.sqlite
    .prepare('SELECT attempt_id AS attemptId FROM scheduler_execution_attempts WHERE input_ref = ?')
    .get(materialization.packageSnapshotId) as { attemptId: string };
  expect(attempt, 'Native submission must name the prepared package owner.').toBeDefined();
  const submission = recordSchedulerExecutionOperation(coreDb, {
    attemptId: attempt.attemptId,
    operationId: `fixture-submit:${attempt.attemptId}`,
    submission: true,
  });
  const observation = await backend.submit({
    ...schedulerExecutionCorrelation(submission),
    deadline: submission.deadline!,
  });
  expect(acceptSchedulerExecutionObservation(coreDb, observation)).not.toBeNull();
  return observation;
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
    requireAttemptId(packageSnapshotId: string): string;
  };
  const identity = backend.planSession(environmentPackage);
  let leaseId: string;
  try {
    leaseId = internal.requireAttemptId(environmentPackage.snapshotId);
  } catch {
    leaseId = `lease-fixture:${environmentPackage.snapshotId}`;
  }
  if (
    coreDb.sqlite.prepare('SELECT 1 FROM worker_backend_sessions WHERE attempt_id = ?').get(leaseId)
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
      'SELECT binding_ref AS sandboxBindingRef FROM scheduler_execution_attempts WHERE attempt_id = ?'
    )
    .get(leaseId) as { readonly sandboxBindingRef: string } | undefined;
  if (!lease) {
    const sandboxBindingRef = `lease-binding:${leaseId}`;
    bindNanoHostWorkerLineage(coreDb, environmentPackage, {
      attemptId: leaseId,
      sandboxBindingRef,
    });
    lease = { sandboxBindingRef };
  }
  coreDb.sqlite
    .prepare(
      `INSERT INTO worker_backend_sessions (
         attempt_id, workspace_id, thread_id, turn_id, agent_session_id,
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
  readonly agentSetup?: ReturnType<typeof createTestAgentSetup>;
  readonly scope: Record<string, unknown>;
  readonly snapshotId: string;
  readonly workspace?: Record<string, unknown>;
}): AgentEnvironmentPackage {
  const { agentSetup, ...packageInput } = input;
  const base = resolveAgentEnvironmentPackage({
    captureCoverage: { scope: 'server', value: 'off' },
    agentSessionId: 'as_factory_fixture',
    agentSetup: agentSetup ?? createTestAgentSetup(),
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
    ...packageInput,
    runtime: {
      ...base.runtime,
      ...runtime,
      image: runtime?.image ?? base.runtime.image,
    },
    scope: { ...base.scope, requestId: `request:${input.scope.turnId}`, ...input.scope },
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
    onRetirement?: () => void;
    onCollection?: (request: NanoHostSessionEffectRequest) => Promise<Record<string, unknown>>;
    onExport?: (request: NanoHostSessionEffectRequest) => Promise<Record<string, unknown>>;
  } = {}
): NanoHostSessionDispatch {
  return {
    async effect(requestOrConnection: object, carriedRequest?: NanoHostSessionEffectRequest) {
      const request = carriedRequest ?? (requestOrConnection as NanoHostSessionEffectRequest);
      effects.push(request);
      if (request.kind === 'image.acquire')
        return {
          digest: String(request.input.imageReference).startsWith('sha256:')
            ? request.input.imageReference
            : `sha256:${'a'.repeat(64)}`,
        };
      if (request.kind === 'image.build') return { digest: `sha256:${'a'.repeat(64)}` };
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
      if (request.kind === 'file.export' && hooks.onExport) return await hooks.onExport(request);
      if (request.kind === 'reference.import') return { state: 'imported' };
      if (request.kind === 'bridge.close' || request.kind === 'sandbox.delete') {
        hooks.onRetirement?.();
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
        requireAttemptId(packageSnapshotId: string): string;
        readonly sessions: Map<string, unknown>;
      };
    }
  ).backend;
  const leaseId = `lease_${label}`;
  backend.requireAttemptId = () => leaseId;
  authorizeNanoHostPackage(coreDb, environmentPackage);
  anchorNanoHostMaterialization(coreDb, backend, environmentPackage);
  coreDb.sqlite.exec(`CREATE TEMP TRIGGER abort_${label}_activation
    BEFORE UPDATE ON worker_storage_bindings
    WHEN OLD.state = 'reserved' AND NEW.state = 'attached'
    BEGIN
      SELECT RAISE(ABORT, 'test activation write failure');
    END`);
  try {
    await expect(
      backend.materialize(environmentPackage, {
        sandboxBindingRef: factoryPackageBinding(coreDb, environmentPackage),
        workspaceRoots: [],
      })
    ).rejects.toThrow('test activation write failure');
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
    attemptId: `lease_${label}`,
    sandboxBindingRef: `lease-binding:${label}`,
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

/** Observes the Core attempt phase without projecting the retired grant or physical accounting. */
function observeExecutionAttempts(
  coreDb: ReturnType<typeof openCoreDb>
): Record<string, unknown>[] {
  const present = coreDb.sqlite
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='scheduler_execution_attempts'"
    )
    .get();
  return present
    ? (coreDb.sqlite
        .prepare('SELECT * FROM scheduler_execution_attempts ORDER BY rowid')
        .all() as Record<string, unknown>[])
    : [];
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
      const imageInspection = createNanoHostEffectRequest(
        identity,
        'lease_effect_carriage',
        'image.inspect',
        { imageDigest }
      );
      const otherLeaseInspection = createNanoHostEffectRequest(
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

      const sandboxCreate = createNanoHostEffectRequest(
        identity,
        'lease_effect_carriage',
        'sandbox.create',
        {
          imageDigest,
          sandboxId: 'sandbox-effect-carriage',
          policyIntent: { additionalFilesystemGrants: [], additionalNetworkEndpoints: [] },
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
            requireAttemptId(packageSnapshotId: string): string;
          };
        }
      ).backend;
      backend.requireAttemptId = () => 'lease_pre_witness_cleanup';
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
             attempt_id, workspace_id, thread_id, turn_id, agent_session_id,
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
             attempt_id, workspace_id, thread_id, turn_id, agent_session_id,
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
      const epochPackage = completeNanoHostPackage({
        scope: {
          agentSessionId: identity.agentSessionId,
          workspaceId: 'workspace_epoch_race',
          threadId: 'thread_epoch_race',
          turnId: 'turn_epoch_race',
        },
        snapshotId: identity.packageSnapshotId,
      });
      authorizeNanoHostPackage(coreDb, epochPackage);
      bindNanoHostWorkerLineage(coreDb, epochPackage, {
        attemptId: 'lease_epoch_race',
        sandboxBindingRef: 'sandbox-binding-epoch-race',
      });
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
            requireAttemptId(packageSnapshotId: string): string;
          };
        }
      ).backend;
      backend.requireAttemptId = () => 'lease_epoch_race';
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
      ?.split('public async prepareLaunch(')[0];
    const launchSource = backendSource
      ?.split('public async prepareLaunch(')[1]
      ?.split('public async submit(')[0];
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
    expect(launchSource).not.toContain("'turn.start'");
    expect(
      backendSource?.split('public async submit(')[1]?.split('public async inspect(')[0]
    ).toContain("'turn.start'");
    expect(materializeSource).not.toContain("'reference.import'");
    expect(launchSource).toContain('for (const file of pendingImports)');
    expect(materializeSource).toContain('this.restoreSharedHarness(');
    expect(materializeSource).toContain('await this.effect(identity, attemptId');
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
    const effectSource = backendSource
      ?.split('private async effect(')[1]
      ?.split('private createCleanupRecoveryResult(')[0];
    expect(effectSource).toContain(
      'createNanoHostEffectRequest(identity, attemptId, operation, input)'
    );
    const identitySource = readFileSync(
      new URL('./nanohost-effect-identity.ts', import.meta.url),
      'utf8'
    );
    expect(identitySource).toContain('stableNanoHostEffectJson');
    expect(identitySource).toContain('operation');
    expect(identitySource).toContain("operation === 'bridge.open'");
    for (const bootstrapField of ['harnessBindingRef', 'integrationReady', 'session.open']) {
      expect(backendSource).toContain(bootstrapField);
    }
    expect(materializeSource).not.toContain('workerControlToken');
    expect(materializeSource).not.toContain('workerInferenceToken');
    expect(launchSource).not.toContain('workerControlToken');
    expect(launchSource).not.toContain('workerInferenceToken');
    expect(backendSource).toContain('acceptHarnessCommand');
    expect(transcriptSource?.indexOf('final_status')).toBeLessThan(
      transcriptSource?.indexOf("'file.export'") ?? -1
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
    // Use a real admitted predecessor, including its immutable package and actual attachment.
    const admitted = await admitIdleSupplyResident('continuity_key');
    const { coreDb, environmentPackage } = admitted;
    const sessionCompatibilityKey = sessionCompatibilityDigest(environmentPackage);
    try {
      const runtime = createConfiguredWorkerLifecycleRuntime({
        coreDb,
        env: {},
        workerControlGateway: new WorkerControlGateway(),
      });
      const backend = (
        runtime.turnExecutor as unknown as {
          backend: WorkerGovernanceBackend & {
            restoreSharedHarness(
              sandboxKey: string,
              harnessKey: string,
              targetId: string,
              adapterId: string,
              adapterVersion: string
            ): unknown;
          };
        }
      ).backend;
      const keys = coreDb.sqlite
        .prepare(`SELECT s.sandbox_compatibility_key AS sandboxKey,
        h.harness_compatibility_key AS harnessKey, h.adapter_id AS adapterId,
        h.adapter_version AS adapterVersion FROM sandbox_runtime_records s
        JOIN harness_instance_records h ON h.sandbox_runtime_id = s.sandbox_runtime_id`)
        .get() as {
        sandboxKey: string;
        harnessKey: string;
        adapterId: string;
        adapterVersion: string;
      };
      backend.restoreSharedHarness(
        keys.sandboxKey,
        keys.harnessKey,
        'target_continuity_key',
        keys.adapterId,
        keys.adapterVersion
      );
      const input = {
        agentSessionCompatibilityKey: sessionCompatibilityKey,
        agentSessionId: environmentPackage.scope.agentSessionId,
        reuseAllowed: true,
        threadId: environmentPackage.scope.threadId,
        workspaceId: environmentPackage.scope.workspaceId,
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

      createSchedulerAdmissionEntry(coreDb, {
        backendId: 'nanohost',
        queueEntryId: 'queue_continuity_commit',
        requestedAgentId: 'agent_codex_host',
        threadId: input.threadId,
        turnId: 'turn-continuity-commit',
        turnInput: 'Commit exact continuity',
        triggerActor: environmentPackage.scope.triggerActor,
        workspaceId: input.workspaceId,
      });
      const continuityAttempt = attempts.createSchedulerExecutionAttempt(coreDb, {
        entry: attemptActionOwners.requireSchedulerAdmissionEntry(
          coreDb,
          'queue_continuity_commit'
        ),
        attemptId: 'lease-continuity-commit',
        preparationInput: { admission: 'queue_continuity_commit' },
      });
      attempts.bindSchedulerExecutionAttemptSession(coreDb, {
        attemptId: continuityAttempt.attemptId,
        agentSessionId: input.agentSessionId,
      });

      await expect(
        backend.prepareAgentSessionContinuity?.({
          ...input,
          admissionAgentSessionId: input.agentSessionId,
          admissionAttemptId: 'lease-continuity-commit',
        })
      ).resolves.toBe('replacement-required');
      expect(
        coreDb.sqlite
          .prepare(
            'SELECT lifecycle_state AS lifecycleState FROM agent_session_runtime_bindings WHERE agent_session_id = ?'
          )
          .get(input.agentSessionId)
      ).toEqual({ lifecycleState: 'open' });

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
          admissionAttemptId: 'lease-continuity-commit',
        })
      ).resolves.toBe('sandbox-replacement-required');
      coreDb.sqlite
        .prepare(
          `UPDATE scheduler_execution_attempts SET agent_session_id = ?
           WHERE attempt_id = 'lease-continuity-commit'`
        )
        .run('as-continuity-successor');
      const retirementPackage = completeNanoHostPackage({
        scope: {
          agentSessionId: 'as-continuity-successor',
          threadId: input.threadId,
          turnId: 'turn-continuity-commit',
          workspaceId: input.workspaceId,
        },
        snapshotId: 'snapshot-continuity-retirement',
      });
      authorizeNanoHostPackage(coreDb, retirementPackage);
      bindNanoHostAttemptPreparation(coreDb, {
        attemptId: continuityAttempt.attemptId,
        agentSessionId: retirementPackage.scope.agentSessionId,
        inputRef: retirementPackage.snapshotId,
        bindingRef: 'lease-binding:continuity-commit',
        sessionCompatibilityKey,
      });
      await expect(
        backend.prepareAgentSessionContinuity?.({
          ...input,
          admissionAgentSessionId: retirementPackage.scope.agentSessionId,
          admissionAttemptId: 'lease-continuity-commit',
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
      gitBaseline?: { commit: string; tree: string };
      nativeValues?: Record<string, string>;
      inspection?: 'unavailable' | 'stale';
      effects?: NanoHostSessionEffectRequest[];
      vaultBackend?: () => VaultBackend;
      configurePackage?: (
        environmentPackage: AgentEnvironmentPackage,
        coreDb: ReturnType<typeof createFactoryCoreDb>
      ) => void;
      onCollection?: (request: NanoHostSessionEffectRequest) => Promise<Record<string, unknown>>;
      onExport?: (request: NanoHostSessionEffectRequest) => Promise<Record<string, unknown>>;
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
    const sessionDispatch = createFactoryNanoHostDispatch(effects, {
      onCollection: options.onCollection,
      onExport: options.onExport,
    });
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
      attemptId: `lease_${label}`,
      sandboxBindingRef: `sandbox-binding:${label}`,
    });
    anchorNanoHostMaterialization(coreDb, backend, environmentPackage);
    const materialization = await backend
      .materialize(environmentPackage, { workspaceRoots: [] })
      .catch((error) => {
        coreDb.sqlite.close();
        throw error;
      });
    new FsStore({ dataRoot: coreDb.dataRoot }).updateAgentSession(agentSessionId, {
      retainedStorage: materialization.retainedStorage!,
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
    const launch = submitTestNanoHostTurn(coreDb, backend, materialization);
    const initialOpen = await settleNext('session.open', {
      ...(options.gitBaseline ? { workspaceGitBaseline: options.gitBaseline } : {}),
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

    await closeFactoryAttempt(coreDb, `lease_${label}`);
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

  it('pins actual runtime and preparation producers to the Host effect fixture', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openkit-producer-pin-'));
    const captured: Array<{ producer: string; request: NanoHostSessionEffectRequest }> = [];
    const residents: Awaited<ReturnType<typeof admitIdleSupplyResident>>[] = [];
    const dockerfile = `FROM docker.io/library/alpine@sha256:${'d'.repeat(64)}\n`;
    const buildImage: AgentEnvironmentPackage['runtime']['image'] = {
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
    };
    let serial = 0;
    const onExport = async () => {
      const directory = join(root, String(serial++));
      mkdirSync(directory);
      const stagingPath = join(directory, 'complete');
      const bytes = Buffer.from('\n');
      writeFileSync(stagingPath, bytes);
      return {
        stagingPath,
        byteLength: bytes.length,
        sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      };
    };
    let pinCoreDb: ReturnType<typeof openCoreDb> | undefined;
    let client: ReturnType<typeof connectHttp2> | undefined;
    let server: ReturnType<typeof createHttp2Server> | undefined;
    try {
      const registryImage = {
        kind: 'reference' as const,
        pullPolicy: 'if-not-present' as const,
        ref: `docker.io/library/alpine@sha256:${'a'.repeat(64)}`,
      };
      const resident = await admitIdleSupplyResident('producer_pin', {
        onExport,
        configurePackage: (pkg) => {
          pkg.scope.requestId = 'request_factory_fixture';
          pkg.runtime.image = registryImage;
        },
      });
      residents.push(resident);
      resident.backend.sessions.set(resident.environmentPackage.snapshotId, resident.session);
      await resident.backend.collectTranscript(resident.environmentPackage.snapshotId, true);
      await resident.backend.collectWorkspaceChanges(resident.environmentPackage.snapshotId, true);
      const created = resident.effects.find((request) => request.kind === 'sandbox.create')!;
      // Invoke the existing wider-cleanup producer with the resident's actual identities.
      await (
        resident.backend as unknown as {
          deleteSandbox(
            identity: WorkerGovernanceBackendSessionIdentity,
            input: { attemptId: string; sandboxId: string },
            bridgeOpen: boolean
          ): Promise<void>;
        }
      ).deleteSandbox(
        resident.backend.planSession(resident.environmentPackage),
        {
          attemptId: String(created.input.leaseId),
          sandboxId: String(created.input.sandboxId),
        },
        true
      );
      captured.push(
        ...resident.effects.map((request) => ({ producer: 'runtime-reference', request }))
      );
      for (const variant of ['build', 'confirmed'] as const) {
        const next = await admitIdleSupplyResident(
          `producer_pin_${variant}`,
          variant === 'confirmed'
            ? { nativeValues: {} }
            : {
                configurePackage: (pkg) => {
                  pkg.runtime.image = buildImage;
                },
              }
        );
        residents.push(next);
        captured.push(
          ...next.effects
            .filter((request) => request.kind.startsWith('image.'))
            .map((request) => ({ producer: `runtime-${variant}`, request }))
        );
      }
      const preparationRequests: NanoHostSessionEffectRequest[] = [];
      const storage = getWorkerStorageBinding(resident.coreDb, {
        storageRef: String((created.input.storage as Record<string, unknown>).storageRef),
      })!;
      const preparation = createWorkerEnvironmentRuntimeEffects({
        ...createFactoryNanoHostDispatch([]),
        effect: (async (request: NanoHostSessionEffectRequest) => {
          preparationRequests.push(request);
          if (request.kind === 'image.acquire' || request.kind === 'image.build')
            return { digest: `sha256:${'a'.repeat(64)}` };
          if (request.kind === 'image.inspect') return nanoHostImageInspection(request);
          if (request.kind === 'storage.inspect')
            return {
              attachment: null,
              capacity: { availableBytes: 2048, totalBytes: 4096 },
              layoutDigest: storage.layoutDigest,
              scopeDigest: storage.scopeDigest,
              state: 'available',
              storageRef: storage.storageRef,
              targets: storage.targets.map(({ target, volumeRef, initialized }) => ({
                target,
                volumeRef,
                initialized,
              })),
            };
          if (request.kind === 'storage.purge')
            return { state: 'purged', storageRef: storage.storageRef };
          throw new Error(`Unexpected preparation effect ${request.kind}`);
        }) as NanoHostSessionDispatch['effect'],
      });
      const candidate = {
        artifactId: 'artifact_pin',
        artifactVersion: 1,
        contentDigest: `sha256:${'c'.repeat(64)}`,
      };
      await preparation.prepareImage({
        authorize: () => true,
        candidate,
        image: { kind: 'reference', pullPolicy: 'never', ref: `sha256:${'a'.repeat(64)}` },
      });
      await preparation.prepareImage({ authorize: () => true, candidate, image: buildImage });
      await preparation.prepareImage({ authorize: () => true, candidate, image: registryImage });
      await preparation.inspectImage({
        authorize: () => true,
        imageDigest: `sha256:${'a'.repeat(64)}`,
        requestId: 'inspect-pin',
      });
      await preparation.inspectStorage({
        authorize: () => true,
        binding: storage,
        commandRequestId: 'storage-inspect-pin',
      });
      await preparation.purgeStorage({
        authorize: () => true,
        binding: { ...storage, state: 'purge-pending' },
        commandRequestId: 'storage-purge-pin',
      });
      captured.push(
        ...preparationRequests.map((request) => ({ producer: 'preparation', request }))
      );
      expect(new Set(captured.map(({ request }) => request.kind))).toEqual(
        new Set(NANO_HOST_EFFECT_OPERATIONS)
      );
      const coreDb = openCoreDb(join(root, 'dispatch'));
      pinCoreDb = coreDb;
      applyMigrations(coreDb);
      const authority = createNanoHostTransportSessionAuthority();
      let admit!: (physical: object) => void;
      const ready = new Promise<object>((resolve) => {
        admit = resolve;
      });
      server = createHttp2Server((request, response) => {
        admit(readNanoHostPhysicalConnectionContext(request)!);
        response.writeHead(204).end();
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing producer pin address.');
      client = connectHttp2(`http://127.0.0.1:${address.port}`);
      client
        .request({ ':method': 'POST', ':path': '/' })
        .on('data', () => {})
        .end();
      const physical = await ready;
      const target = {
        targetId: 'producer-pin',
        identityId: 'producer-pin',
        deploymentId: 'producer-pin',
      };
      allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
        ...target,
        observedAt: '2026-10-05T00:00:00.000Z',
      });
      authority.admit({
        connectionGeneration: 1,
        identityId: target.identityId,
        physicalConnection: physical,
      });
      const fixture = [];
      for (const { producer, request } of captured) {
        const dispatch = createNanoHostSessionDispatch({ coreDb, sessionAuthority: authority });
        await dispatch.readiness!(
          physical,
          Buffer.from(JSON.stringify({ physicalEpoch: 'a'.repeat(64) })),
          { ...target, coreDb }
        );
        void dispatch.effect(request).catch(() => undefined);
        const command = await dispatch.poll(physical, request.kind);
        expect(command, `${producer} ${request.kind}`).not.toBeNull();
        fixture.push({
          producer,
          kind: request.kind,
          requestId: request.requestId,
          input: request.input,
          command,
        });
        if (request.kind === 'workspace.collect')
          await dispatch.result(
            physical,
            request.kind,
            request.input.mode === 'baseline'
              ? {
                  requestId: request.requestId,
                  outcome: 'baseline',
                  head: { tree: '1'.repeat(40), manifest: '2'.repeat(40) },
                }
              : { requestId: request.requestId, outcome: 'no_new_head', unstable: false }
          );
      }
      // Normalize only generated identity values, never field names or authored payloads.
      const volumeIds = new Map<string, string>();
      const normalized = JSON.parse(
        JSON.stringify(fixture, (key, value) => {
          if (value?.type === 'Buffer')
            return { type: 'Buffer', hex: Buffer.from(value.data).toString('hex') };
          if (key === 'requestId') {
            expect(value).toMatch(/^[0-9a-f]{64}$/);
            return 'a'.repeat(64);
          }
          if (key === 'backendSessionId') {
            expect(value).toMatch(/^nh-[0-9a-f]{16}-[0-9a-f]{16}$/);
            return `nh-${'1'.repeat(16)}-${'2'.repeat(16)}`;
          }
          if (key === 'sandboxId') {
            expect(value).toMatch(/^nh-[0-9a-f]{16}$/);
            return `nh-${'1'.repeat(16)}`;
          }
          if (key === 'storageRef') {
            expect(value).toMatch(/^wst_[0-9a-f]{32}$/);
            return `wst_${'1'.repeat(32)}`;
          }
          if (key === 'sandboxIntegrationBindingRef') {
            expect(value).toMatch(/^integration-binding-/);
            return 'integration-pin';
          }
          if (key === 'attemptNonce') {
            expect(value).toMatch(/^[0-9a-f]{32}$/);
            return '0'.repeat(32);
          }
          if (key === 'loopbackDigests') {
            expect(value).toEqual([
              expect.stringMatching(/^[0-9a-f]{64}$/),
              expect.stringMatching(/^[0-9a-f]{64}$/),
            ]);
            return ['b'.repeat(64), 'c'.repeat(64)];
          }
          if (key === 'volumeRef') {
            expect(value).toMatch(/^wsv_[0-9a-f]{32}$/);
            if (!volumeIds.has(value))
              volumeIds.set(value, `wsv_${(volumeIds.size + 1).toString(16).padStart(32, '0')}`);
            return volumeIds.get(value);
          }
          return value;
        })
      );
      const fixturePath = new URL(
        '../../../nanohost/src/core-effect-command-fixture.json',
        import.meta.url
      );
      if (process.env.OPENKIT_UPDATE_EFFECT_FIXTURE === '1')
        writeFileSync(fixturePath, `${JSON.stringify(normalized, null, 2)}\n`);
      const originalFixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as typeof normalized;
      expect(normalized).toEqual(originalFixture);
      expect(normalized.filter((effect) => effect.kind === 'file.export')).toHaveLength(2);
    } finally {
      client?.destroy();
      if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
      pinCoreDb?.sqlite.close();
      for (const resident of residents) resident.coreDb.sqlite.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    'missing-lease',
    'contradictory-route',
    'cleanup-failed',
  ] as const)('keeps live capture %s on recovery_required with failed-closeout cleanup', async (mode) => {
    const fixture = await admitIdleSupplyResident(`live_evidence_${mode}`, {
      configurePackage: (pkg) => {
        pkg.workspace.outputs = [
          {
            id: 'turn-output',
            path: '/workspace/outputs',
            registerAsArtifacts: true,
            retention: 'sync-on-turn-end',
          },
        ];
      },
    });
    fixture.backend.sessions.set(fixture.environmentPackage.snapshotId, fixture.session);
    const cleanup = vi.spyOn(fixture.backend, 'cleanupSession');
    if (mode === 'cleanup-failed')
      cleanup.mockRejectedValue(new Error('Private cleanup I/O failure.'));
    else cleanup.mockResolvedValue(undefined);
    try {
      if (mode === 'missing-lease')
        fixture.coreDb.sqlite.prepare('DELETE FROM scheduler_execution_attempts').run();
      else
        fixture.coreDb.sqlite
          .prepare(
            'UPDATE scheduler_execution_attempts SET worker_capability_token_hash = ? WHERE attempt_id = ?'
          )
          .run('f'.repeat(64), `lease_live_evidence_${mode}`);
      const before = fixture.effects.filter((effect) => effect.kind === 'file.export').length;
      const capture = (fixture.backend as unknown as { captureArtifact: WorkerArtifactCapture })
        .captureArtifact;
      await expect(
        capture({
          packageSnapshotId: fixture.environmentPackage.snapshotId,
          requestId: 'file-request',
          path: '/workspace/outputs/file.md',
          maxByteLength: 17,
        })
      ).rejects.toMatchObject({ code: 'recovery_required' });
      expect(cleanup).toHaveBeenCalledWith(
        fixture.backend.planSession(fixture.environmentPackage),
        { failedCloseout: true }
      );
      expect(fixture.effects.filter((effect) => effect.kind === 'file.export')).toHaveLength(
        before
      );
    } finally {
      cleanup.mockRestore();
      fixture.coreDb.sqlite.close();
    }
  });

  it('exports accepted final status while retaining a running Harness without process absence claims', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openkit-resident-export-'));
    const bytes = Buffer.from('\n');
    let serial = 0;
    const f = await admitIdleSupplyResident('export_barrier', {
      onExport: async () => {
        const directory = join(root, String(serial++));
        mkdirSync(directory);
        const stagingPath = join(directory, 'complete');
        writeFileSync(stagingPath, bytes);
        return {
          stagingPath,
          sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
          byteLength: bytes.length,
        };
      },
    });
    f.backend.sessions.set(f.environmentPackage.snapshotId, f.session);
    try {
      await expect(
        f.backend.collectTranscript!(f.environmentPackage.snapshotId, true)
      ).resolves.toMatchObject({ eventsJsonl: '\n', itemsJsonl: '\n' });
      const exports = f.effects.filter((request) => request.kind === 'file.export');
      expect(exports).toHaveLength(2);
      for (const request of exports) {
        expect(request.input).toMatchObject({
          finalStatusAccepted: true,
          terminalBarrierProved: true,
        });
        expect(request.input).not.toHaveProperty('processGroupAbsent');
      }
      expect(f.effects.map((request) => request.kind)).not.toContain('bridge.close');
      expect(f.effects.map((request) => request.kind)).not.toContain('sandbox.delete');
      expect(
        f.coreDb.sqlite
          .prepare('SELECT lifecycle_state AS lifecycle FROM agent_session_runtime_bindings')
          .all()
      ).toEqual([{ lifecycle: 'open' }]);
    } finally {
      f.coreDb.sqlite.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

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
  it('compares a Git report to the pin without reading a host repository', async () => {
    const commit = 'a'.repeat(64);
    const f = await admitIdleSupplyResident('remote_git_report');
    const original = f.session as { environmentPackage: AgentEnvironmentPackage };
    const session = {
      ...original,
      environmentPackage: {
        ...original.environmentPackage,
        workspace: {
          ...original.environmentPackage.workspace,
          inputs: [
            {
              id: 'repo',
              access: 'read-write',
              source: { kind: 'git', commit, url: 'https://example.invalid/repo.git' },
            },
          ],
        },
      },
    };
    const collector = f.backend as unknown as {
      ensureWorkspaceBaseline(
        session: unknown,
        opensNewBinding: boolean,
        gitBaseline?: { commit: string; tree: string }
      ): Promise<void>;
      workspaceCollectionIdentity(
        session: unknown,
        id: string
      ): import('./workspace-snapshot-chain.js').WorkspaceCollectionIdentity;
    };
    const db = openWorkspaceDb(f.coreDb.dataRoot, f.environmentPackage.scope.workspaceId);
    try {
      db.sqlite.exec(
        'DELETE FROM workspace_snapshot_collections; DELETE FROM workspace_snapshot_cursors;'
      );
      const identity = collector.workspaceCollectionIdentity(session, 'baseline');
      authorizeWorkspaceBaselineInitialization(db, identity);
      await collector.ensureWorkspaceBaseline(session, true, { commit, tree: 'b'.repeat(64) });
      expect(readWorkspaceSnapshotCursor(db, identity)?.acceptedCommit).toBe(commit);
    } finally {
      db.sqlite.close();
      f.coreDb.sqlite.close();
    }
  });
  it('accepts a Sandbox-pinned Git baseline and closes with no host repository', async () => {
    const commit = 'a'.repeat(40);
    const tree = 'b'.repeat(40);
    const f = await admitIdleSupplyResident('remote_git_baseline', {
      gitBaseline: { commit, tree },
      configurePackage: (env) => {
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
      },
      onCollection: async (request) =>
        request.input.mode === 'baseline'
          ? { outcome: 'baseline', head: { tree, manifest: '2'.repeat(40) } }
          : { outcome: 'no_new_head', unstable: false },
    });
    const db = openWorkspaceDb(f.coreDb.dataRoot, f.environmentPackage.scope.workspaceId);
    try {
      expect(
        db.sqlite
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workspace_repository_resources'"
          )
          .all()
      ).toEqual([]);
      const collector = f.backend as unknown as {
        ensureWorkspaceBaseline(
          session: unknown,
          opensNewBinding: boolean,
          gitBaseline?: { commit: string; tree: string }
        ): Promise<void>;
        workspaceCollectionIdentity(
          session: unknown,
          id: string
        ): import('./workspace-snapshot-chain.js').WorkspaceCollectionIdentity;
      };
      const identity = collector.workspaceCollectionIdentity(f.session, 'baseline');
      expect(readWorkspaceSnapshotCursor(db, identity)).toEqual({
        acceptedBase: { tree, manifest: '2'.repeat(40) },
        head: { tree, manifest: '2'.repeat(40) },
        acceptedCommit: commit,
      });
      expect(
        f.effects.filter(
          (effect) => effect.kind === 'workspace.collect' && effect.input.mode === 'baseline'
        )
      ).toHaveLength(1);
      // A retained slot must not acquire another baseline, even if the later report is missing.
      await collector.ensureWorkspaceBaseline(f.session, true);
      expect(
        f.effects.filter(
          (effect) => effect.kind === 'workspace.collect' && effect.input.mode === 'baseline'
        )
      ).toHaveLength(1);
      db.sqlite.exec(
        'DELETE FROM workspace_snapshot_collections; DELETE FROM workspace_snapshot_cursors;'
      );
      authorizeWorkspaceBaselineInitialization(db, identity);
      for (const report of [
        undefined,
        { commit: 'f'.repeat(40), tree },
        { commit, tree: 'invalid' },
      ]) {
        await expect(collector.ensureWorkspaceBaseline(f.session, true, report)).rejects.toThrow(
          report?.commit === 'f'.repeat(40) ? 'baseline_mismatch' : 'baseline_source_unavailable'
        );
        expect(readWorkspaceSnapshotCursor(db, identity)).toBeNull();
      }
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
    { gitSource: false, format: 'text' },
    { gitSource: true, format: 'text' },
    { gitSource: true, format: 'binary' },
    { gitSource: true, format: 'invalid-utf8' },
  ])('retains exact cumulative candidate bytes with gitSource=$gitSource format=$format without a Git apply review', async ({
    gitSource,
    format,
  }) => {
    const repositoryPath = mkdtempSync(join(tmpdir(), 'n6-candidate-source-'));
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
    const expectedTree = gitSource
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
    const f = await admitIdleSupplyResident(`candidate_${gitSource}_${format}`, {
      ...(gitSource ? { gitBaseline: { commit, tree: expectedTree } } : {}),
      ...(gitSource
        ? {
            configurePackage: (env: AgentEnvironmentPackage) => {
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
      await expect(firstCollection).resolves.toHaveLength(0);
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
      expect(
        db.sqlite.prepare('SELECT count(*) AS count FROM staged_workspace_reviews').get()
      ).toEqual({ count: 0 });
      expect(JSON.parse(row.result_json).acceptedCommit).toBe(gitSource ? commit : null);
      bytes = Buffer.from('openkit-full-mode-delta\n0644 0600 8 file.txt\n');
      const unsupported = await collector.collectWorkspaceSnapshot(f.session, 'release');
      expect(unsupported).toEqual([]);
      expect(published).not.toHaveBeenCalled();
      const cursor = db.sqlite
        .prepare('SELECT head_json AS head FROM workspace_snapshot_cursors')
        .get() as { head: string };
      expect(JSON.parse(cursor.head)).toEqual({ tree: '4'.repeat(40), manifest: '5'.repeat(40) });
      captureEmpty = true;
      await expect(collector.collectWorkspaceSnapshot(f.session, 'successor')).resolves.toEqual([]);
      const manifests = db.sqlite
        .prepare('SELECT payload_json FROM worker_output_manifests')
        .all() as { payload_json: string }[];
      expect(manifests).toHaveLength(0);
      const emptyScans = f.effects.length;
      await expect(collector.collectWorkspaceSnapshot(f.session, 'successor')).resolves.toEqual([]);
      expect(f.effects).toHaveLength(emptyScans);
      expect(
        db.sqlite.prepare('SELECT COUNT(*) AS count FROM worker_output_manifests').get()
      ).toEqual({ count: 0 });
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

  it('retains original credential evidence after live-memory loss and lease expiry, refusing missing route hashes', async () => {
    const f = await admitIdleSupplyResident('credential_admission');
    try {
      const collector = f.backend as unknown as {
        transcriptCredentialCheckValues(
          session: unknown
        ): import('./worker-credential-guard.js').WorkerCredentialCheckValues;
      };
      const session = f.session as {
        liveRouteTokens: [string, string, string] | null;
        runtimeEnvironment: Record<string, string> | null;
      };
      const live = collector.transcriptCredentialCheckValues(session);
      expect(session.liveRouteTokens).toHaveLength(3);
      for (const token of session.liveRouteTokens!) expect(live.sensitiveValues).toContain(token);
      expect(live.sensitiveValues).toContain('sandbox-binding:credential_admission');
      f.coreDb.sqlite
        .prepare('UPDATE scheduler_execution_attempts SET deadline = ? WHERE attempt_id = ?')
        .run('2000-01-01T00:00:00.000Z', 'lease_credential_admission');
      const recovered = collector.transcriptCredentialCheckValues({
        ...session,
        liveRouteTokens: null,
        runtimeEnvironment: null,
      });
      expect(recovered.routeTokenHashes).toEqual(live.routeTokenHashes);
      expect(recovered.loopbackDigests).toEqual(live.loopbackDigests);
      expect(recovered.sensitiveValues).toEqual(['sandbox-binding:credential_admission']);
      for (const token of session.liveRouteTokens!)
        expect(recovered.sensitiveValues).not.toContain(token);
      f.coreDb.sqlite
        .prepare(
          'UPDATE scheduler_execution_attempts SET worker_control_token_hash = NULL WHERE attempt_id = ?'
        )
        .run('lease_credential_admission');
      expect(() =>
        collector.transcriptCredentialCheckValues({
          ...session,
          liveRouteTokens: null,
          runtimeEnvironment: null,
        })
      ).toThrowError(expect.objectContaining({ code: 'recovery_required' }));
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
        scope: {
          ...environmentPackage.scope,
          turnId: 'turn_supply_same_next',
          requestId: `request:${'turn_supply_same_next'}`,
        },
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
        attemptId: 'lease_supply_same_next',
        sandboxBindingRef: 'sandbox-binding:supply-same-next',
      });
      anchorNanoHostMaterialization(coreDb, backend, nextPackage);
      const nextLaunch = submitTestNanoHostTurn(
        coreDb,
        backend,
        await backend.materialize(nextPackage, {
          sandboxBindingRef: factoryPackageBinding(coreDb, nextPackage),
          workspaceRoots: [],
        })
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
          requestId: `request:${'turn_supply_mcp_successor'}`,
        },
        'snapshot_supply_mcp_successor'
      );
      const resume = { digest: readyDigest, locator: environmentPackage.scope.agentSessionId };
      authorizeNanoHostPackage(coreDb, successorPackage);
      bindNanoHostWorkerLineage(coreDb, successorPackage, {
        attemptId: 'lease_supply_mcp_successor',
        sandboxBindingRef: 'sandbox-binding:supply-mcp-successor',
      });
      anchorNanoHostMaterialization(coreDb, backend, successorPackage);
      const successorMaterialization = await backend.materialize(successorPackage, {
        sandboxBindingRef: factoryPackageBinding(coreDb, successorPackage),
        nativeResume: resume,
        workspaceRoots: [],
      });
      backend.bindNativeHandleRecorder(successorPackage.snapshotId, () => undefined);
      const successorLaunch = submitTestNanoHostTurn(coreDb, backend, successorMaterialization);
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
        attemptId: `lease-${environmentPackage.snapshotId}`,
        sandboxBindingRef: 'lease-binding:restart-same-epoch',
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
        sandboxBindingRef: factoryPackageBinding(coreDb, environmentPackage),
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
      const launch = submitTestNanoHostTurn(coreDb, firstBackend, materialization);
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

      await closeFactoryAttempt(coreDb, `lease-${environmentPackage.snapshotId}`);
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
                  b.cleanup_state AS cleanupState, b.current_attempt_id AS currentLeaseId,
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
        attemptId: 'lease_selected_slot',
        sandboxBindingRef: 'sandbox-binding:selected-slot',
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
        sandboxBindingRef: factoryPackageBinding(coreDb, environmentPackage),
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
      await closeFactoryAttempt(
        coreDb,
        (
          coreDb.sqlite
            .prepare('SELECT attempt_id AS id FROM scheduler_execution_attempts WHERE input_ref=?')
            .get(environmentPackage.snapshotId) as { id: string }
        ).id
      );
      bindNanoHostWorkerLineage(coreDb, successorPackage, {
        attemptId: 'lease_selected_slot_no_choice',
        sandboxBindingRef: 'sandbox-binding:selected-slot-no-choice',
      });
      anchorNanoHostMaterialization(coreDb, backend, successorPackage);
      const successorMaterialization = await backend.materialize(successorPackage, {
        sandboxBindingRef: factoryPackageBinding(coreDb, successorPackage),
        workspaceRoots: [],
      });
      expect(successorPackage.workspace.inputs[0]?.target).toBe(expectedWorktree);
      expect(successorPackage.runtime.command.workingDirectory).toBe(expectedWorktree);

      const launch = submitTestNanoHostTurn(coreDb, backend, successorMaterialization);
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
            requireAttemptId(packageSnapshotId: string): string;
          };
        }
      ).backend;
      backend.requireAttemptId = () => 'lease_absent_cleanup';
      const environmentPackage = completeNanoHostPackage({
        scope: {
          agentSessionId: 'as_absent_cleanup',
          threadId: 'thread_absent_cleanup',
          turnId: 'turn_absent_cleanup',
          workspaceId: 'workspace_absent_cleanup',
        },
        snapshotId: 'aepsnap_absent_cleanup',
      });
      authorizeNanoHostPackage(coreDb, environmentPackage);
      bindNanoHostWorkerLineage(coreDb, environmentPackage, {
        attemptId: 'lease_absent_cleanup',
        sandboxBindingRef: 'sandbox-binding-absent-cleanup',
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
            requireAttemptId(packageSnapshotId: string): string;
          };
        }
      ).backend;
      backend.requireAttemptId = () => 'lease_pending_cleanup';
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
               attempt_id, workspace_id, thread_id, turn_id, agent_session_id,
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
            requireAttemptId(packageSnapshotId: string): string;
          };
        }
      ).backend;
      backend.requireAttemptId = () => 'lease_reserved_cleanup';
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
             attempt_id, workspace_id, thread_id, turn_id, agent_session_id,
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
            requireAttemptId(packageSnapshotId: string): string;
          };
        }
      ).backend;
      initialBackend.requireAttemptId = () => 'lease_post_fence';
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
             attempt_id, workspace_id, thread_id, turn_id, agent_session_id,
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
            requireAttemptId(packageSnapshotId: string): string;
          };
        }
      ).backend;
      restartedBackend.requireAttemptId = () => 'lease_post_fence';

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
             attempt_id, workspace_id, thread_id, turn_id, agent_session_id,
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
      ).rejects.toThrow('Turn cancellation is already owned or has no live attempt.');

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
        } finally {
          db.sqlite.close();
        }
      }

      bindNanoHostWorkerLineage(coreDb, environmentPackage, {
        attemptId: 'lease_human_gate',
        sandboxBindingRef: 'sandbox-binding:resident-session',
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
            backend.materialize(invalidPackage, {
              sandboxBindingRef: factoryPackageBinding(coreDb, invalidPackage),
              workspaceRoots: [],
            })
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
        sandboxBindingRef: factoryPackageBinding(coreDb, environmentPackage),
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

      const launch = submitTestNanoHostTurn(coreDb, backend, materialization);
      await settleNext('session.open', {
        ...(fixtureRepositoryPath
          ? {
              workspaceGitBaseline: {
                commit: environmentPackage.workspace.inputs[0]!.source.commit,
                tree: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
              },
            }
          : {}),
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
      // This terminal-inspection subject begins with exact occupancy; Harness record regressions separately retain the leaseId-to-attemptId publication defect.
      coreDb.sqlite
        .prepare(`UPDATE agent_session_runtime_bindings
        SET current_attempt_id = 'lease_human_gate'
        WHERE agent_session_id = 'as_human_gate' AND current_turn_id = 'turn_human_gate'`)
        .run();

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
        await closeFactoryAttempt(coreDb, 'lease_human_gate');
        const nextPackage = {
          ...environmentPackage,
          scope: {
            ...environmentPackage.scope,
            turnId: 'turn_human_gate_next',
            requestId: `request:${'turn_human_gate_next'}`,
          },
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
          attemptId: 'lease_human_gate_next',
          sandboxBindingRef: 'sandbox-binding:resident-session-next',
        });
        anchorNanoHostMaterialization(coreDb, backend, nextPackage);
        const nextMaterialization = await backend.materialize(nextPackage, {
          sandboxBindingRef: factoryPackageBinding(coreDb, nextPackage),
          runtimeEnvCredentials: [
            { targetEnvVarName: 'GITHUB_TOKEN', credentialValue: 'private-dispatch-env-canary' },
          ],
          workspaceRoots: [],
        });
        const nextLaunch = submitTestNanoHostTurn(coreDb, backend, nextMaterialization);
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
      const retainedStorage = { storageRef: `wst_${'1'.repeat(32)}`, workSlotRef: 'slot-inspect' };
      const environmentPackage = {
        extensions: { openkit: { workerStorage: { workSlotRef: retainedStorage.workSlotRef } } },
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
        attemptId: 'attempt_factory_inspect',
        nativeResume: resume ? { digest: resume, locator: 'as_factory_predecessor' } : null,
        nativeSessionReusable: false,
        recordNativeHandleDigest: (digest: string, actualStorage: typeof retainedStorage) => {
          expect(actualStorage).toEqual(retainedStorage);
          recordedDigests.push(digest);
        },
        sharedHarness: {
          sandbox: { workerStorageBinding: { storageRef: retainedStorage.storageRef } },
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
          requireAttemptId(packageSnapshotId: string): string;
        };
      }
    ).backend;
    backend.requireAttemptId = () => 'lease_factory_pre_bridge_failure';
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
    await expect(
      backend.materialize(environmentPackage, {
        sandboxBindingRef: factoryPackageBinding(factoryCoreDb, environmentPackage),
        workspaceRoots: [],
      })
    ).rejects.toThrow('NanoHost Context Package lineage or private root is invalid.');
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
          requireAttemptId(packageSnapshotId: string): string;
        };
      }
    ).backend;
    backend.requireAttemptId = () => 'lease_factory_reservation_failure';
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
      await expect(
        backend.materialize(environmentPackage, {
          sandboxBindingRef: factoryPackageBinding(factoryCoreDb, environmentPackage),
          workspaceRoots: [],
        })
      ).rejects.toThrow('test reservation write failure');
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
        attemptId: fixture.leaseId,
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
        attemptId: fixture.leaseId,
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
        attemptId: fixture.leaseId,
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
        attemptId: fixture.leaseId,
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
        attemptId: fixture.leaseId,
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
        attemptId: fixture.leaseId,
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
      const materialization = backend.materialize(environmentPackage, {
        sandboxBindingRef: factoryPackageBinding(coreDb, environmentPackage),
        workspaceRoots: [],
      });
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
      let environmentPackage = completeNanoHostPackage({
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
      bindNanoHostWorkerLineage(coreDb, environmentPackage, {
        attemptId: 'lease_a_current',
        sandboxBindingRef: 'binding:lease_a_current',
      });
      expect(() =>
        recordTestExecutionAttempt(coreDb, {
          entry: attemptActionOwners.requireSchedulerAdmissionEntry(
            coreDb,
            'queue:lease_a_current'
          ),
          attemptId: 'lease_b_current',
          agentSessionId: environmentPackage.scope.agentSessionId,
          inputRef: packageSnapshotId,
          bindingRef: 'binding:lease_b_current',
          sessionCompatibilityKey: 'duplicate-refused',
          now: () => new Date().toISOString(),
        })
      ).toThrow('no longer dispatchable');
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
      await expect(
        backend.materialize(environmentPackage, {
          sandboxBindingRef: factoryPackageBinding(coreDb, environmentPackage),
          workspaceRoots: [],
        })
      ).rejects.toThrow('exact local image is unavailable');
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
      await closeFactoryAttempt(
        coreDb,
        (
          coreDb.sqlite
            .prepare('SELECT attempt_id AS id FROM scheduler_execution_attempts WHERE input_ref=?')
            .get(environmentPackage.snapshotId) as { id: string }
        ).id
      );
      environmentPackage = {
        ...environmentPackage,
        snapshotId: `snapshot_acquire_mismatch`,
        scope: {
          ...environmentPackage.scope,
          agentSessionId: 'as_acquire_mismatch',
          turnId: 'turn_acquire_mismatch',
          requestId: 'request_acquire_mismatch',
        },
      };
      authorizeNanoHostPackage(coreDb, environmentPackage);
      anchorNanoHostMaterialization(coreDb, backend, environmentPackage);

      await expect(
        backend.materialize(environmentPackage, {
          sandboxBindingRef: factoryPackageBinding(coreDb, environmentPackage),
          workspaceRoots: [],
        })
      ).rejects.toThrow('local image acquisition returned a different digest');
      expect(effects.map((effect) => effect.kind)).toEqual(['image.acquire']);
      expect(
        coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM worker_storage_bindings').get()
      ).toEqual({ count: 0 });
      expect(
        coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM sandbox_runtime_records').get()
      ).toEqual({ count: 0 });

      effects.length = 0;
      acquisitionResult = 'match';
      await closeFactoryAttempt(
        coreDb,
        (
          coreDb.sqlite
            .prepare('SELECT attempt_id AS id FROM scheduler_execution_attempts WHERE input_ref=?')
            .get(environmentPackage.snapshotId) as { id: string }
        ).id
      );
      environmentPackage = {
        ...environmentPackage,
        snapshotId: `snapshot_acquire_match`,
        scope: {
          ...environmentPackage.scope,
          agentSessionId: 'as_acquire_match',
          turnId: 'turn_acquire_match',
          requestId: 'request_acquire_match',
        },
      };
      authorizeNanoHostPackage(coreDb, environmentPackage);
      anchorNanoHostMaterialization(coreDb, backend, environmentPackage);

      await expect(
        backend.materialize(environmentPackage, {
          sandboxBindingRef: factoryPackageBinding(coreDb, environmentPackage),
          workspaceRoots: [],
        })
      ).rejects.toThrow('Sandbox creation reached');
      expect(effects).toHaveLength(3);
      expect(effects[0]).toMatchObject({
        input: { imageReference: localDigest, leaseId: 'lease-fixture:snapshot_acquire_match' },
        kind: 'image.acquire',
      });
      expect(effects[1]).toMatchObject({
        input: { imageDigest: localDigest },
        kind: 'image.inspect',
      });
      expect(effects[1]?.input).not.toHaveProperty('leaseId');
      expect(effects[2]).toMatchObject({
        input: { imageDigest: localDigest, leaseId: 'lease-fixture:snapshot_acquire_match' },
        kind: 'sandbox.create',
      });
      // The new original sandbox.create has an unknown response; it cannot replay a cleanup effect.
      const failedAttempt = attempts.requireSchedulerExecutionAttempt(
        coreDb,
        'lease-fixture:snapshot_acquire_match'
      );
      expect(failedAttempt.disposition).toBe('unknown');
      await expect(
        runtime.cleanupBackendSession(backend.planSession(environmentPackage))
      ).rejects.toThrow('An unknown operation must be inspected or fenced before another effect.');
      expect(effects).toHaveLength(3);
      expect(attempts.requireSchedulerExecutionAttempt(coreDb, failedAttempt.attemptId)).toEqual(
        failedAttempt
      );
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
            requireAttemptId(packageSnapshotId: string): string;
          };
        }
      ).backend;
      backend.requireAttemptId = (packageSnapshotId) => `lease-${packageSnapshotId}`;
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
      for (const row of coreDb.sqlite
        .prepare(
          "SELECT attempt_id AS id FROM scheduler_execution_attempts WHERE phase <> 'closed'"
        )
        .all() as { id: string }[])
        await closeFactoryAttempt(coreDb, row.id);
      anchorNanoHostMaterialization(coreDb, backend, codexPackage);
      await backend.materialize(codexPackage, {
        sandboxBindingRef: factoryPackageBinding(coreDb, codexPackage),
        workspaceRoots: [],
      });
      for (const row of coreDb.sqlite
        .prepare(
          "SELECT attempt_id AS id FROM scheduler_execution_attempts WHERE phase <> 'closed'"
        )
        .all() as { id: string }[])
        await closeFactoryAttempt(coreDb, row.id);
      anchorNanoHostMaterialization(coreDb, backend, openCodePackage);
      await backend.materialize(openCodePackage, {
        sandboxBindingRef: factoryPackageBinding(coreDb, openCodePackage),
        workspaceRoots: [],
      });
      for (const row of coreDb.sqlite
        .prepare(
          "SELECT attempt_id AS id FROM scheduler_execution_attempts WHERE phase <> 'closed'"
        )
        .all() as { id: string }[])
        await closeFactoryAttempt(coreDb, row.id);
      anchorNanoHostMaterialization(coreDb, backend, nextCodexPackage);
      await backend.materialize(nextCodexPackage, {
        sandboxBindingRef: factoryPackageBinding(coreDb, nextCodexPackage),
        workspaceRoots: [],
      });

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
            requireAttemptId(packageSnapshotId: string): string;
          };
        }
      ).backend;
      firstBackend.requireAttemptId = (packageSnapshotId) => `lease-${packageSnapshotId}`;
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
      await firstBackend.materialize(environmentPackage, {
        sandboxBindingRef: factoryPackageBinding(coreDb, environmentPackage),
        workspaceRoots: [],
      });
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
        "UPDATE scheduler_execution_attempts SET phase = 'closed' WHERE phase NOT IN ('closed', 'lost', 'failed')"
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
            requireAttemptId(packageSnapshotId: string): string;
          };
        }
      ).backend;
      restoredBackend.requireAttemptId = (packageSnapshotId) => `lease-${packageSnapshotId}`;
      anchorNanoHostMaterialization(coreDb, restoredBackend, environmentPackage);
      await restoredBackend.materialize(environmentPackage, {
        sandboxBindingRef: factoryPackageBinding(coreDb, environmentPackage),
        workspaceRoots: [],
      });
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
            requireAttemptId(packageSnapshotId: string): string;
          };
        }
      ).backend;
      backend.requireAttemptId = (packageSnapshotId) => `lease-${packageSnapshotId}`;
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
      const firstMaterialization = await backend.materialize(firstPackage, {
        sandboxBindingRef: factoryPackageBinding(coreDb, firstPackage),
        workspaceRoots: [],
      });
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
            requireAttemptId(packageSnapshotId: string): string;
            restoreSession(environmentPackage: AgentEnvironmentPackage, leaseId: string): void;
          };
        }
      ).backend;
      restoredBackend.requireAttemptId = (packageSnapshotId) => `lease-${packageSnapshotId}`;
      restoredBackend.restoreSession(firstPackage, `lease-${firstPackage.snapshotId}`);
      const inspectLaunch = submitTestNanoHostTurn(coreDb, restoredBackend, firstMaterialization);
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
              requireAttemptId(packageSnapshotId: string): string;
              restoreSession(environmentPackage: AgentEnvironmentPackage, leaseId: string): void;
            };
          }
        ).backend;
        backend.requireAttemptId = (packageSnapshotId) => `lease-${packageSnapshotId}`;
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
        attemptId: 'lease-snapshot_resume_open',
        sandboxBindingRef: 'lease-binding:resume-open',
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
        sandboxBindingRef: factoryPackageBinding(coreDb, environmentPackage),
        nativeResume: { digest: predecessorDigest, locator: 'as_resume_predecessor' },
        workspaceRoots: [],
      });
      const recordedDigests: string[] = [];
      backend.bindNativeHandleRecorder?.(environmentPackage.snapshotId, (digest) => {
        recordedDigests.push(digest);
      });
      const launch = submitTestNanoHostTurn(coreDb, backend, materialization);
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
        attemptId: 'lease_ready_open',
        sandboxBindingRef: 'sandbox-binding:ready-open',
      });
      anchorNanoHostMaterialization(coreDb, backend, environmentPackage);
      const materialization = await backend.materialize(environmentPackage, {
        sandboxBindingRef: factoryPackageBinding(coreDb, environmentPackage),
        workspaceRoots: [],
      });
      backend.bindNativeHandleRecorder?.(environmentPackage.snapshotId, () => {
        throw new Error('recorder failed');
      });
      const launch = submitTestNanoHostTurn(coreDb, backend, materialization);
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
              requireAttemptId(packageSnapshotId: string): string;
              restoreSession(environmentPackage: AgentEnvironmentPackage, leaseId: string): void;
              readonly sessions: Map<string, unknown>;
            };
          }
        ).backend;
        backend.requireAttemptId = (packageSnapshotId) => `lease-${packageSnapshotId}`;
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
        attemptId: 'lease-snapshot_restored_proof',
        sandboxBindingRef: 'lease-binding:restored-proof',
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
        sandboxBindingRef: factoryPackageBinding(coreDb, environmentPackage),
        nativeResume: { digest: readyDigest, locator: 'as_restored_predecessor' },
        workspaceRoots: [],
      });
      backend.bindNativeHandleRecorder?.(environmentPackage.snapshotId, () => undefined);
      const launch = submitTestNanoHostTurn(coreDb, backend, materialization);
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

  it.each([
    'eviction',
    'missing-fact',
    'handoff',
    'intact',
    'image-intact',
    'image-handoff',
    'cross-thread-missing-fact',
    'cross-thread-handoff',
    'cross-thread-closed-handoff',
    'cross-thread-old-epoch-handoff',
    'ignored-package-proof-handoff',
    'ignored-package-cross-thread-handoff',
    'ignored-package-restoration',
    'known-package-proof-handoff',
    'known-package-restoration',
  ] as const)('ordinary admission preserves native proof across eviction or incompatible replacement after restart: %s', async (scenario) => {
    const coreDb = createFactoryCoreDb();
    const effects: NanoHostSessionEffectRequest[] = [];
    const digest = 'a'.repeat(64);
    const setups = [
      createTestAgentSetup({
        adapter: 'codex',
        agentId: 'agent_resume_a',
        requiredCapabilities: ['trusted-worker-inference-relay'],
      }),
      createTestAgentSetup({
        adapter: 'pi',
        agentId: 'agent_resume_b',
        requiredCapabilities: ['trusted-worker-inference-relay'],
      }),
    ];
    for (const setup of setups) admitTestNativeEnvironment(coreDb, setup.manifest);
    coreDb.sqlite
      .prepare(
        `INSERT INTO nanohost_runtime_targets (target_id, identity_id, deployment_id, connection_generation, predecessor_fenced, ready, fresh_empty, physical_epoch, observed_at, slot_count) VALUES ('staging-nanohost-a2', 'identity_resume', 'staging-a2', 1, 1, 1, 1, ?, ?, 1)`
      )
      .run('a'.repeat(64), '2999-10-03T00:00:00.000Z');
    for (const [index, setup] of setups.entries())
      authorizeNanoHostPackage(
        coreDb,
        resolveAgentEnvironmentPackage({
          coreDb,
          captureCoverage: { scope: 'server', value: 'off' },
          agentSessionId: `as_seed_${index}`,
          agentSetup: setup,
          backend: { kind: 'openshell' },
          createdAt: '2999-10-03T00:00:00.000Z',
          requestId: null,
          triggerActor: { kind: 'user', id: 'user_resume' },
          turn: {
            completedAt: null,
            configVersion: null,
            durationMs: null,
            error: null,
            id: `turn_seed_${index}`,
            items: [],
            startedAt: '2999-10-03T00:00:00.000Z',
            status: 'running',
            threadId: `thread_resume_${index}`,
            triggerActor: { kind: 'user', id: 'user_resume' },
            workspaceId: 'workspace_resume',
          },
          turnInput: 'Continue',
          workspaceCwd: null,
          workspaceRoots: [],
        })
      );
    let store = new FsStore({ dataRoot: coreDb.dataRoot });
    let runtime = createConfiguredWorkerLifecycleRuntime({
      coreDb,
      env: {},
      nanoHostSessionDispatch: createFactoryNanoHostDispatch(effects),
      store,
      workerControlGateway: new WorkerControlGateway(),
    });
    const backend = (runtime.turnExecutor as unknown as { backend: WorkerGovernanceBackend })
      .backend;
    // D83/D103 and retained-volume continuation require the new admitted Session's package; the round-6 counterexample after eviction preserves the production mismatch.
    // This regression owns storage, native admission and cleanup; transcript export is a separate boundary.
    backend.collectTranscript = async () => ({
      eventsJsonl: '',
      itemsJsonl: '',
    });
    let tick = 1;
    const executor = new WorkerGovernanceTurnExecutor({
      backend,
      coreDb,
      now: () => `2999-10-03T00:00:${String(tick).padStart(2, '0')}.000Z`,
      awaitWorkerCompletion: async (aep) => {
        recordWorkerControlAcceptedRecord(coreDb, {
          acceptedAt: `2999-10-03T00:00:${String(tick).padStart(2, '0')}.000Z`,
          lineage: { ...aep.scope, packageSnapshotId: aep.snapshotId },
          operation: 'final_status',
          record: { sequence: 1, status: 'completed', stopReason: 'completed' },
          recordKey: '1',
          sequence: 1,
        });
        return {
          acceptedAt: `2999-10-03T00:00:${String(tick).padStart(2, '0')}.000Z`,
          status: 'completed',
          stopReason: 'completed',
        };
      },
    });

    const providerRegistry = new ProviderRegistry([
      {
        baseUrl: 'http://127.0.0.1:11434/v1',
        defaultModel: 'openai/gpt-5.2',
        displayName: 'Resume fixture',
        id: 'agent-openrouter',
        kind: 'local',
        models: ['openai/gpt-5.2'],
      },
    ]);
    const opens: Record<string, unknown>[] = [];
    /** Runs real scheduler preparation/commit/start while settling only the external Harness boundary. */
    const run = async (index: number, agentIndex: number) => {
      tick = index * 10;
      createSchedulerAdmissionEntry(coreDb, {
        backendId: 'nanohost',
        now: () => `2999-10-03T00:00:${tick}.000Z`,
        queueEntryId: `queue_resume_${index}`,
        requestId: `request_resume_${index}`,
        requestedAgentId: setups[agentIndex]!.manifest.id,
        threadId: `thread_resume_${agentIndex}`,
        turnId: `turn_resume_${index}`,
        turnInput: 'Continue',
        triggerActor: { kind: 'user', id: 'user_resume' },
        workspaceId: 'workspace_resume',
      });
      publishFactoryAdmission(
        store,
        attemptActionOwners.requireSchedulerAdmissionEntry(coreDb, `queue_resume_${index}`)
      );
      let done = false;
      const running = runSchedulerDispatchLoop({
        agentManifests: setups.map((setup) => setup.manifest),
        coreDb,
        createAgentSessionId: () => `as_resume_${index}`,
        createAttemptId: () => `lease_resume_${index}`,
        gatewayConfig: createTestGatewayConfig(),
        maxDispatches: 1,
        now: () => `2999-10-03T00:00:${tick}.000Z`,
        providerRegistry,
        store,
        turnExecutor: executor,
        executionBackend: backend,
      })
        .then(async (result) => {
          await Promise.all(result.startedTurns.map(({ handle }) => handle.completion));
          return result;
        })
        .finally(() => {
          done = true;
        });
      // Observe the rejection immediately while the external-command driver drains.
      void running.catch(() => undefined);
      for (let attempt = 0; attempt < 5000 && !done; attempt += 1) {
        const integrations = coreDb.sqlite
          .prepare('SELECT sandbox_integration_binding_ref AS ref FROM sandbox_runtime_records')
          .all() as { ref: string }[];
        for (const integration of integrations) {
          const command = dispatchNanoHostHarnessOperation(coreDb, {
            sandboxIntegrationBindingRef: integration.ref,
          });
          if (!command) continue;
          runtime.acceptNanoHostHarnessCommand(command);
          if (command.operation === 'session.open') opens.push(command.body);
          const body =
            command.operation === 'session.close'
              ? { state: 'closed', privateState: 'absent', childState: 'absent' }
              : command.operation === 'turn.start'
                ? { state: 'started', nativeHandleState: 'ready', nativeHandleDigest: digest }
                : command.operation === 'session.open'
                  ? {
                      maxActiveTurns: 1,
                      state: 'open',
                      nativeHandleState: 'ready',
                      nativeHandleDigest: digest,
                    }
                  : {
                      state: 'open',
                      childState: 'absent',
                      cleanupState: 'clean',
                      nativeHandleState: 'ready',
                      nativeHandleDigest: digest,
                    };
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
            sandboxIntegrationBindingRef: integration.ref,
            timestamp: `2999-10-03T00:00:${tick}.000Z`,
          });
          runtime.acceptNanoHostHarnessResult(result);
        }
        if (!done) await new Promise<void>((resolve) => setTimeout(resolve, 1));
      }
      expect(done).toBe(true);
      const dispatched = await running;
      expect(dispatched.startedTurns).toHaveLength(1);
      await completeOwnedTerminalAttempt(coreDb, store.getTurnById(`turn_resume_${index}`));
      expect(store.getTurnById(`turn_resume_${index}`).status).toBe('completed');
    };
    try {
      await run(1, 0);
      const original = effects.find((effect) => effect.kind === 'sandbox.create')!.input.storage;

      expect(
        coreDb.sqlite
          .prepare(
            'SELECT runtime_target_id AS targetId, deployment_id AS deploymentId FROM worker_backend_sessions'
          )
          .get()
      ).toEqual({ targetId: 'staging-nanohost-a2', deploymentId: 'staging-a2' });
      expect.soft(store.getAgentSession('as_resume_1')).toMatchObject({
        nativeHandleDigest: digest,
        retainedStorage: {
          storageRef: (original as { storageRef: string }).storageRef,
          workSlotRef: workerStorageDefaultWorkSlotRef('workspace_resume', 'thread_resume_0'),
        },
      });
      if (scenario !== 'eviction') {
        const predecessor = store.getAgentSession('as_resume_1');
        // Persist the exact crash/pre-fact state; the write-once API must not erase a live fact.
        const recordPath = join(
          coreDb.dataRoot,
          'workspaces/workspace_resume/runtime/agent-sessions/as_resume_1/session.json'
        );
        const record = JSON.parse(readFileSync(recordPath, 'utf8'));
        if (!['intact', 'image-intact'].includes(scenario)) record.nativeHandleDigest = null;
        if (['missing-fact', 'cross-thread-missing-fact'].includes(scenario))
          record.retainedStorage = null;
        writeFileSync(recordPath, JSON.stringify(record));
        store = new FsStore({ dataRoot: coreDb.dataRoot });
        runtime = createConfiguredWorkerLifecycleRuntime({
          coreDb,
          env: {},
          nanoHostSessionDispatch: createFactoryNanoHostDispatch(effects, {
            onRetirement: () => {
              if (!['cross-thread-handoff', 'cross-thread-closed-handoff'].includes(scenario))
                return;
              // Observe Core handoff at the first external retirement effect, not only afterward.
              expect(store.getAgentSession(predecessor.id)).toMatchObject({
                nativeHandleDigest: digest,
                retainedStorage: predecessor.retainedStorage,
              });
              expect(
                coreDb.sqlite
                  .prepare(
                    'SELECT native_handle_digest AS digest FROM agent_session_runtime_bindings WHERE agent_session_id = ?'
                  )
                  .get(predecessor.id)
              ).toEqual({ digest });
            },
          }),
          store,
          workerControlGateway: new WorkerControlGateway(),
        });
        const restoredBackend = (
          runtime.turnExecutor as unknown as { backend: WorkerGovernanceBackend }
        ).backend;
        restoredBackend.collectTranscript = backend.collectTranscript;
        Object.assign(executor, { backend: restoredBackend, executionBackend: restoredBackend });
        expect(
          coreDb.sqlite
            .prepare(
              'SELECT native_handle_state AS state, native_handle_digest AS digest FROM agent_session_runtime_bindings WHERE agent_session_id = ?'
            )
            .get(predecessor.id)
        ).toMatchObject({ state: 'ready', digest });
        if (scenario === 'cross-thread-closed-handoff') {
          coreDb.sqlite
            .prepare("UPDATE agent_session_runtime_bindings SET lifecycle_state = 'closed'")
            .run();
        }
        if (scenario === 'cross-thread-old-epoch-handoff') {
          const packageDb = openWorkspaceDb(coreDb.dataRoot, predecessor.workspaceId);
          let priorPackage: AgentEnvironmentPackage;
          try {
            priorPackage = requireAgentEnvironmentPackageSnapshot(
              packageDb,
              predecessor.workspaceId,
              predecessor.environmentPackageSnapshotId!
            ).snapshot;
          } finally {
            packageDb.sqlite.close();
          }
          const liveBackend = restoredBackend as WorkerGovernanceBackend & {
            restoreSession(environmentPackage: AgentEnvironmentPackage, leaseId: string): void;
            sessions: Map<
              string,
              { sharedHarness: { bindings: Map<string, { nativeHandleDigest: string | null }> } }
            >;
          };
          const lease = coreDb.sqlite
            .prepare(
              'SELECT attempt_id AS leaseId FROM worker_backend_sessions WHERE agent_session_id = ?'
            )
            .get(predecessor.id) as { leaseId: string };
          liveBackend.restoreSession(priorPackage, lease.leaseId);
          // The durable ready result may precede publication to the volatile binding cache.
          liveBackend.sessions
            .get(priorPackage.snapshotId)!
            .sharedHarness.bindings.get(predecessor.id)!.nativeHandleDigest = null;
          coreDb.sqlite
            .prepare('UPDATE nanohost_runtime_targets SET physical_epoch = ?')
            .run('f'.repeat(64));
          coreDb.sqlite
            .prepare(
              "UPDATE sandbox_runtime_records SET lifecycle_state = 'failed', health_state = 'unknown', drain_state = 'draining', cleanup_state = 'unknown'"
            )
            .run();
          coreDb.sqlite.prepare("UPDATE worker_storage_bindings SET state = 'unknown'").run();
        }
        if (scenario.startsWith('ignored-package-') || scenario.startsWith('known-package-')) {
          const snapshotPath = join(
            coreDb.dataRoot,
            'workspaces/workspace_resume/runtime/agent-sessions',
            predecessor.id,
            'aep-snapshots',
            `${predecessor.environmentPackageSnapshotId}.json`
          );
          const retained = JSON.parse(readFileSync(snapshotPath, 'utf8'));
          retained.snapshot.control.transcript.artifactsPath = '/retired-transcript-artifacts';
          retained.contentDigest = createHash('sha256')
            .update(JSON.stringify(retained.snapshot))
            .digest('hex');
          writeFileSync(snapshotPath, JSON.stringify(retained));
          // Reproduce the earlier release's admitted Harness identity over the stored package.
          const aep = retained.snapshot;
          const { openkit, ...extensions } = aep.extensions;
          const {
            turnInput: _turnInput,
            sessionWorkspace: _sessionWorkspace,
            workerStorage: _workerStorage,
            ...staticOpenkit
          } = openkit;
          const historicalHarnessKey = createHash('sha256')
            .update(
              stableNanoHostEffectJson({
                adapter: aep.control.adapter,
                agentRuntime: { kind: aep.agent.runtimeKind, version: aep.agent.runtimeVersion },
                control: { transcript: aep.control.transcript },
                credentials: aep.credentials,
                extensions: { ...extensions, openkit: staticOpenkit },
                resources: aep.resources,
                runtime: {
                  binaries: aep.runtime.binaries,
                  command: { ...aep.runtime.command, workingDirectory: 'worker-storage-worktree' },
                  process: aep.runtime.process ?? null,
                  session: aep.runtime.session ?? null,
                },
                supply: aep.supply,
                vault: aep.vault,
              })
            )
            .digest('hex');
          const historicalSandboxKey = (
            coreDb.sqlite
              .prepare('SELECT sandbox_compatibility_key AS key FROM sandbox_runtime_records')
              .get() as { key: string }
          ).key;
          const historicalSessionKey = deriveNanoHostAgentSessionCompatibilityKey({
            adapterId: aep.control.adapter.targetRuntime,
            adapterVersion: aep.agent.runtimeVersion,
            harnessCompatibilityKey: historicalHarnessKey,
            sessionCompatibilityKey:
              aep.extensions.openkit.sessionWorkspace.compatibilityKey.digest,
            threadId: aep.scope.threadId,
          });
          coreDb.sqlite
            .prepare('UPDATE harness_instance_records SET harness_compatibility_key = ?')
            .run(historicalHarnessKey);
          coreDb.sqlite
            .prepare(
              'UPDATE agent_session_runtime_bindings SET agent_session_compatibility_key = ?'
            )
            .run(historicalSessionKey);
          const packageDb = openWorkspaceDb(coreDb.dataRoot, predecessor.workspaceId);
          let normalized: AgentEnvironmentPackage;
          try {
            normalized = requireAgentEnvironmentPackageSnapshot(
              packageDb,
              predecessor.workspaceId,
              retained.snapshotId
            ).snapshot;
          } finally {
            packageDb.sqlite.close();
          }
          expect(normalized.control.transcript).not.toHaveProperty('artifactsPath');
          const lease = coreDb.sqlite
            .prepare(
              'SELECT attempt_id AS leaseId FROM worker_backend_sessions WHERE agent_session_id = ?'
            )
            .get(predecessor.id) as { leaseId: string };
          const internal = restoredBackend as WorkerGovernanceBackend & {
            restoreSession(aep: AgentEnvironmentPackage, leaseId: string): void;
            sessions: Map<string, unknown>;
            sharedHarnesses: Map<string, unknown>;
            recordNativeHandleDigest(
              agentSessionId: string,
              digest: string,
              retainedStorage: {
                storageRef: string;
                workSlotRef: string;
              }
            ): void;
          };
          const recorder = vi.spyOn(internal, 'recordNativeHandleDigest');
          if (scenario.startsWith('known-package-')) {
            const effectsBefore = [...effects];
            const bindingsBefore = coreDb.sqlite
              .prepare('SELECT * FROM agent_session_runtime_bindings')
              .all();
            const harnessesBefore = coreDb.sqlite
              .prepare('SELECT * FROM harness_instance_records')
              .all();
            const sandboxesBefore = coreDb.sqlite
              .prepare('SELECT * FROM sandbox_runtime_records')
              .all();
            // A checksum supplied by the altered file cannot replace its original admitted keys.
            retained.snapshot.runtime.command.stdout =
              retained.snapshot.runtime.command.stdout === 'ignore' ? 'pipe' : 'ignore';
            retained.contentDigest = createHash('sha256')
              .update(JSON.stringify(retained.snapshot))
              .digest('hex');
            writeFileSync(snapshotPath, JSON.stringify(retained));
            const alteredDb = openWorkspaceDb(coreDb.dataRoot, predecessor.workspaceId);
            let altered: AgentEnvironmentPackage;
            try {
              altered = requireAgentEnvironmentPackageSnapshot(
                alteredDb,
                predecessor.workspaceId,
                retained.snapshotId
              ).snapshot;
            } finally {
              alteredDb.sqlite.close();
            }
            expect(altered.runtime.command.stdout).not.toBe(normalized.runtime.command.stdout);
            expect(internal.sessions.size).toBe(0);
            expect(internal.sharedHarnesses.size).toBe(0);
            if (scenario === 'known-package-restoration') {
              expect(() => internal.restoreSession(altered, lease.leaseId)).toThrow(
                WorkerNativeProofValidationError
              );
            } else {
              coreDb.sqlite
                .prepare('UPDATE nanohost_runtime_targets SET physical_epoch = ?')
                .run('f'.repeat(64));
              expect(() => restoredBackend.inspectMaterializationCapacity!(altered)).toThrow(
                WorkerNativeProofValidationError
              );
            }
            expect(recorder).not.toHaveBeenCalled();
            expect(store.getAgentSession(predecessor.id).nativeHandleDigest).toBeNull();
            expect(internal.sessions.size).toBe(0);
            expect(internal.sharedHarnesses.size).toBe(0);
            expect(effects).toEqual(effectsBefore);
            expect(
              coreDb.sqlite.prepare('SELECT * FROM agent_session_runtime_bindings').all()
            ).toEqual(bindingsBefore);
            expect(coreDb.sqlite.prepare('SELECT * FROM harness_instance_records').all()).toEqual(
              harnessesBefore
            );
            expect(coreDb.sqlite.prepare('SELECT * FROM sandbox_runtime_records').all()).toEqual(
              sandboxesBefore
            );
            return;
          }
          if (scenario === 'ignored-package-restoration') {
            expect(() => internal.restoreSession(normalized, lease.leaseId)).not.toThrow();
            const recorder = vi.fn();
            restoredBackend.bindNativeHandleRecorder?.(normalized.snapshotId, recorder);
            expect(recorder).toHaveBeenCalledExactlyOnceWith(digest, predecessor.retainedStorage);
            return;
          }
          coreDb.sqlite
            .prepare('UPDATE nanohost_runtime_targets SET physical_epoch = ?')
            .run('f'.repeat(64));
          const desired =
            scenario === 'ignored-package-cross-thread-handoff'
              ? {
                  ...normalized,
                  snapshotId: 'snapshot_fresh_cross_thread',
                  scope: {
                    ...normalized.scope,
                    agentSessionId: 'as_resume_2',
                    threadId: 'thread_resume_1',
                    turnId: 'turn_resume_2',
                  },
                }
              : normalized;
          const inspect = () => restoredBackend.inspectMaterializationCapacity!(desired);
          const effectsBefore = [...effects];
          const acceptedInspection = inspectNanoHostAgentSessionContinuity(coreDb, {
            agentSessionId: predecessor.id,
            workspaceId: predecessor.workspaceId,
            threadId: predecessor.threadId,
            reuseAllowed: true,
          });
          if (!acceptedInspection) throw new Error('Expected the original ready binding.');
          const handoff = () =>
            (
              restoredBackend as unknown as {
                handoffDurableAgentSessionProof(
                  inspection: NonNullable<typeof acceptedInspection>
                ): void;
              }
            ).handoffDurableAgentSessionProof(acceptedInspection);
          for (const [field, altered] of [
            ['agent_session_runtime_binding_id', 'wrong-binding-identity'],
            ['native_handle_digest', 'e'.repeat(64)],
          ]) {
            const original = coreDb.sqlite
              .prepare(`SELECT ${field} AS value FROM agent_session_runtime_bindings`)
              .get() as { value: string };
            coreDb.sqlite
              .prepare(`UPDATE agent_session_runtime_bindings SET ${field} = ?`)
              .run(altered);
            expect(handoff).toThrow();
            expect(recorder).not.toHaveBeenCalled();
            expect(store.getAgentSession(predecessor.id).nativeHandleDigest).toBeNull();
            coreDb.sqlite
              .prepare(`UPDATE agent_session_runtime_bindings SET ${field} = ?`)
              .run(original.value);
          }
          // These corruptions retain the ignored field, so tolerance cannot mask failed authority checks.
          for (const [table, field, altered, failedCheck] of [
            [
              'worker_backend_sessions',
              'thread_id',
              'wrong-thread',
              'package-binding-lineage/anchor-thread',
            ],
            [
              'worker_backend_sessions',
              'origin_physical_epoch',
              'e'.repeat(64),
              'package-binding-lineage/attachment-epoch',
            ],
            [
              'worker_backend_sessions',
              'backend_lineage_json',
              JSON.stringify({ imageRef: `sha256:${'7'.repeat(64)}` }),
              'package-binding-lineage/backend-image',
            ],
            [
              'worker_backend_sessions',
              'backend_session_id',
              `nh-${'e'.repeat(16)}-${'f'.repeat(16)}`,
              'package-binding-lineage/backend-session',
            ],
            [
              'worker_backend_sessions',
              'runtime_target_id',
              'wrong-nanohost-target',
              'package-binding-lineage/attachment-target',
            ],
            [
              'worker_backend_sessions',
              'attempt_id',
              'wrong-lease',
              'package-binding-lineage/lease-missing',
            ],
            [
              'agent_session_runtime_bindings',
              'thread_id',
              'wrong-thread',
              'package-binding-lineage/attachment-thread',
            ],
            [
              'agent_session_runtime_bindings',
              'agent_session_compatibility_key',
              'e'.repeat(64),
              'package-binding-lineage/agent-session-key',
            ],
            [
              'worker_storage_bindings',
              'current_sandbox_binding_ref',
              'wrong-binding',
              'retained-storage-association',
            ],
          ]) {
            const original = coreDb.sqlite
              .prepare(`SELECT ${field} AS value FROM ${table}`)
              .get() as { value: string };
            coreDb.sqlite.prepare(`UPDATE ${table} SET ${field} = ?`).run(altered);
            let failure: unknown;
            try {
              handoff();
            } catch (error) {
              failure = error;
            }
            expect(failure, `${table}.${field}`).toMatchObject({
              name: 'WorkerNativeProofValidationError',
              failedCheck,
            });
            expect(effects).toEqual(effectsBefore);
            expect(recorder).not.toHaveBeenCalled();
            expect(store.getAgentSession(predecessor.id).nativeHandleDigest).toBeNull();
            coreDb.sqlite.prepare(`UPDATE ${table} SET ${field} = ?`).run(original.value);
          }
          coreDb.sqlite
            .prepare(
              "UPDATE worker_backend_sessions SET thread_id = 'wrong-thread', runtime_target_id = 'wrong-nanohost-target'"
            )
            .run();
          expect(inspect).toThrow(
            expect.objectContaining({ failedCheck: 'package-binding-lineage/anchor-thread' })
          );
          expect(recorder).not.toHaveBeenCalled();
          coreDb.sqlite
            .prepare('UPDATE worker_backend_sessions SET thread_id = ?, runtime_target_id = ?')
            .run(predecessor.threadId, 'staging-nanohost-a2');
          const originalBytes = readFileSync(snapshotPath, 'utf8');
          retained.snapshot.scope.threadId = 'wrong-package-thread';
          writeFileSync(snapshotPath, JSON.stringify(retained));
          expect(() => inspect()).toThrow('digest mismatch');
          retained.contentDigest = createHash('sha256')
            .update(JSON.stringify(retained.snapshot))
            .digest('hex');
          writeFileSync(snapshotPath, JSON.stringify(retained));
          expect(() => inspect()).toThrow('lineage mismatch');
          writeFileSync(snapshotPath, originalBytes);
          const changedScope = JSON.parse(originalBytes);
          changedScope.threadId = 'wrong-package-thread';
          changedScope.snapshot.scope.threadId = changedScope.threadId;
          changedScope.contentDigest = createHash('sha256')
            .update(JSON.stringify(changedScope.snapshot))
            .digest('hex');
          writeFileSync(snapshotPath, JSON.stringify(changedScope));
          expect(() => inspect()).toThrow();
          writeFileSync(snapshotPath, originalBytes);
          for (const [field, value] of [
            ['triggerActor', { kind: 'user', id: 'wrong-package-actor' }],
            ['requestId', 'wrong-package-request'],
          ]) {
            const changedAdmission = JSON.parse(originalBytes);
            changedAdmission.snapshot.scope[field as string] = value;
            changedAdmission.contentDigest = createHash('sha256')
              .update(JSON.stringify(changedAdmission.snapshot))
              .digest('hex');
            writeFileSync(snapshotPath, JSON.stringify(changedAdmission));
            expect(() => inspect()).toThrow();
            expect(recorder).not.toHaveBeenCalled();
            expect(store.getAgentSession(predecessor.id).nativeHandleDigest).toBeNull();
            writeFileSync(snapshotPath, originalBytes);
          }
          expect(recorder).not.toHaveBeenCalled();
          expect(inspect()).toBe('available');
          expect(recorder).toHaveBeenCalledExactlyOnceWith(
            predecessor.id,
            digest,
            predecessor.retainedStorage
          );
          expect(readFileSync(snapshotPath, 'utf8')).toBe(originalBytes);
          expect(effects).toEqual(effectsBefore);
          expect(store.getAgentSession(predecessor.id)).toMatchObject({
            nativeHandleDigest: digest,
            retainedStorage: predecessor.retainedStorage,
          });
          expect(
            coreDb.sqlite
              .prepare('SELECT harness_compatibility_key AS key FROM harness_instance_records')
              .get()
          ).toEqual({ key: historicalHarnessKey });
          expect(
            coreDb.sqlite
              .prepare(
                'SELECT agent_session_compatibility_key AS key FROM agent_session_runtime_bindings'
              )
              .get()
          ).toEqual({ key: historicalSessionKey });
          expect(
            coreDb.sqlite
              .prepare('SELECT sandbox_compatibility_key AS key FROM sandbox_runtime_records')
              .get()
          ).toEqual({ key: historicalSandboxKey });
          if (scenario === 'ignored-package-cross-thread-handoff') {
            // Observe durable handoff while the victim still exists, then admit another Thread.
            expect(
              coreDb.sqlite
                .prepare('SELECT 1 FROM agent_session_runtime_bindings WHERE agent_session_id = ?')
                .get(predecessor.id)
            ).toBeDefined();
            await run(2, 1);
            expect(opens).toHaveLength(2);
            expect(opens[1]).toMatchObject({ resume: null });
            expect(
              coreDb.sqlite
                .prepare('SELECT 1 FROM agent_session_runtime_bindings WHERE agent_session_id = ?')
                .get(predecessor.id)
            ).toBeUndefined();
            expect(readFileSync(snapshotPath, 'utf8')).toBe(originalBytes);
            expect(store.getAgentSession(predecessor.id)).toMatchObject({
              nativeHandleDigest: digest,
              retainedStorage: predecessor.retainedStorage,
            });
            expect(store.getAgentSession('as_resume_2').retainedStorage?.storageRef).not.toBe(
              predecessor.retainedStorage?.storageRef
            );
            return;
          }
          // Once Core has accepted a pair, a changed ready digest must not replace it.
          coreDb.sqlite
            .prepare('UPDATE agent_session_runtime_bindings SET native_handle_digest = ?')
            .run('e'.repeat(64));
          expect(() => inspect()).toThrow();
          expect(store.getAgentSession(predecessor.id).nativeHandleDigest).toBe(digest);
          return;
        }
        const crossThread = scenario.startsWith('cross-thread-');
        const imageReplacement = scenario.startsWith('image-');
        if (imageReplacement) {
          setups[0]!.manifest.runtime.image = {
            kind: 'reference',
            pullPolicy: 'if-not-present',
            ref: `sha256:${'7'.repeat(64)}`,
          };
          admitTestNativeEnvironment(coreDb, setups[0]!.manifest);
        } else if (!crossThread) {
          setups[0]!.manifest.runtime.version = 'test-new-version';
        }
        const effectsBefore = [...effects];
        if (['missing-fact', 'cross-thread-missing-fact'].includes(scenario)) {
          await expect(run(2, crossThread ? 1 : 0)).rejects.toMatchObject({
            code: 'recovery_required',
            status: 409,
          });
          expect(effects).toEqual(effectsBefore);
          expect(
            coreDb.sqlite.prepare('SELECT drain_state AS state FROM sandbox_runtime_records').all()
          ).toEqual([{ state: 'accepting' }]);
          expect(
            coreDb.sqlite.prepare('SELECT drain_state AS state FROM harness_instance_records').all()
          ).toEqual([{ state: 'accepting' }]);
          expect(opens).toHaveLength(1);
          expect(store.getAgentSession(predecessor.id)).toMatchObject({
            status: 'idle',
            nativeHandleDigest: null,
            retainedStorage: null,
          });
          expect(
            coreDb.sqlite
              .prepare(
                'SELECT native_handle_state AS state, native_handle_digest AS digest FROM agent_session_runtime_bindings WHERE agent_session_id = ?'
              )
              .get(predecessor.id)
          ).toMatchObject({ state: 'ready', digest });
          expect(store.listThreadAgentSessions('workspace_resume', 'thread_resume_0')).toHaveLength(
            1
          );
        } else if (crossThread) {
          await run(2, 1);
          expect(opens).toHaveLength(2);
          expect(opens[1]).toMatchObject({ resume: null });
          expect(
            effects.slice(effectsBefore.length).some((effect) => effect.kind === 'sandbox.delete')
          ).toBe(scenario !== 'cross-thread-old-epoch-handoff');
          expect(
            coreDb.sqlite
              .prepare('SELECT 1 FROM agent_session_runtime_bindings WHERE agent_session_id = ?')
              .get(predecessor.id)
          ).toBeUndefined();
          expect(store.getAgentSession(predecessor.id)).toMatchObject({
            nativeHandleDigest: digest,
            retainedStorage: predecessor.retainedStorage,
          });
          expect(store.getAgentSession('as_resume_2').retainedStorage?.storageRef).not.toBe(
            predecessor.retainedStorage?.storageRef
          );
        } else {
          await run(2, 0);
          const creates = effects.filter((effect) => effect.kind === 'sandbox.create');
          expect(opens).toHaveLength(2);
          expect(opens[1]).toMatchObject({ resume: { digest, locator: predecessor.id } });
          if (imageReplacement) {
            expect(creates).toHaveLength(2);
            expect(
              effects.slice(effectsBefore.length).some((effect) => effect.kind === 'sandbox.delete')
            ).toBe(true);
          }
          // Version-only native replacement may keep the compatible Sandbox; every mount keeps exact targets.
          for (const create of creates) {
            expect(create.input.storage).toMatchObject({
              storageRef: (original as { storageRef: string }).storageRef,
              targets: (original as { targets: unknown }).targets,
            });
          }
          expect(
            coreDb.sqlite
              .prepare('SELECT storage_ref AS storageRef FROM worker_storage_bindings')
              .all()
          ).toEqual([{ storageRef: (original as { storageRef: string }).storageRef }]);
          expect(store.getAgentSession(predecessor.id)).toMatchObject({
            status: 'closed',
            nativeHandleDigest: digest,
            retainedStorage: predecessor.retainedStorage,
          });
          expect(store.getAgentSession('as_resume_2').retainedStorage).toEqual(
            predecessor.retainedStorage
          );
        }
        return;
      }
      await run(2, 1);
      expect(opens[1]).toMatchObject({ resume: null });
      expect(
        effects.filter((effect) => effect.kind === 'sandbox.create')[1]!.input.storage
      ).not.toMatchObject({ storageRef: (original as { storageRef: string }).storageRef });
      expect(effects.some((effect) => effect.kind === 'sandbox.delete')).toBe(true);
      // Re-read durable AgentSession history rather than relying on the first process's Store cache.
      store = new FsStore({ dataRoot: coreDb.dataRoot });
      await run(3, 0);
      const creates = effects.filter((effect) => effect.kind === 'sandbox.create');
      expect(creates).toHaveLength(3);
      expect(creates[2]!.input.storage).toMatchObject({
        storageRef: (original as { storageRef: string }).storageRef,
        targets: (original as { targets: unknown }).targets,
      });
      expect(opens[2]).toMatchObject({ resume: { digest, locator: 'as_resume_1' } });
      expect(store.getAgentSession('as_resume_3').retainedStorage).toEqual(
        store.getAgentSession('as_resume_1').retainedStorage
      );
    } finally {
      coreDb.sqlite.close();
    }
  }, 30_000);

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
      const settledOperations: string[] = [];
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
        settledOperations.push(command.operation);
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

      /** Enqueues product lineage before the same capacity probe and lease insertion as dispatch. */
      const enqueue = (environmentPackage: AgentEnvironmentPackage) =>
        createSchedulerAdmissionEntry(coreDb, {
          backendId: 'nanohost',
          queueEntryId: `queue:${environmentPackage.snapshotId}`,
          requestId: environmentPackage.scope.requestId,
          requestedAgentId: environmentPackage.agent.agentId,
          ...environmentPackage.scope,
          turnInput: 'Complete a reusable Turn',
        });
      /** Inserts the real scheduler grant and its capacity accounting before backend effects. */
      const dispatch = (environmentPackage: AgentEnvironmentPackage) => {
        expect(backend.inspectMaterializationCapacity?.(environmentPackage)).toBe('available');
        bindNanoHostWorkerLineage(coreDb, environmentPackage, {
          attemptId: `lease:${environmentPackage.snapshotId}`,
          sandboxBindingRef: `lease-binding:${environmentPackage.snapshotId}`,
        });
        anchorNanoHostMaterialization(coreDb, backend, environmentPackage);
      };
      let originalOpenCodeSandboxId: string | undefined;
      for (const [index, environmentPackage] of packages.slice(0, 3).entries()) {
        authorizeNanoHostPackage(coreDb, environmentPackage);
        enqueue(environmentPackage);
        dispatch(environmentPackage);
        const materializing = backend.materialize(environmentPackage, {
          sandboxBindingRef: factoryPackageBinding(coreDb, environmentPackage),
          workspaceRoots: [],
        });
        if (index > 0)
          await settleNext('session.close', {
            state: 'closed',
            privateState: 'absent',
            childState: 'absent',
          });
        const materialized = await materializing;
        // Direct backend admission supplies the actual attachment that ordinary launch records.
        new FsStore({ dataRoot: coreDb.dataRoot }).updateAgentSession(
          environmentPackage.scope.agentSessionId,
          {
            retainedStorage: materialized.retainedStorage!,
          }
        );
        const sandboxId = backend.sessions.get(environmentPackage.snapshotId)!.sharedHarness.sandbox
          .sandboxRuntimeId;
        if (index === 0) originalOpenCodeSandboxId = sandboxId;
        if (index === 2) expect(sandboxId).toBe(originalOpenCodeSandboxId);
        backend.bindNativeHandleRecorder?.(environmentPackage.snapshotId, () => {});
        const launch = submitTestNanoHostTurn(coreDb, backend, materialized);
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
        const effectsBeforeRelease = effects.length;
        const commandsBeforeRelease = settledOperations.length;
        const lease = coreDb.sqlite
          .prepare(
            'SELECT attempt_id AS leaseId FROM scheduler_execution_attempts WHERE input_ref = ?'
          )
          .get(environmentPackage.snapshotId) as { readonly leaseId: string };
        coreDb.sqlite
          .prepare(
            `UPDATE worker_backend_sessions SET workspace_handoff_state = 'complete' WHERE attempt_id = ?`
          )
          .run(lease.leaseId);
        transitionWorkerBackendSessionState(coreDb, {
          fromState: 'materializing',
          toState: 'cleanup-pending',
          attemptId: lease.leaseId,
        });
        await runtime.cleanupBackendSession(backend.planSession(environmentPackage));
        expect(backend.sessions.has(environmentPackage.snapshotId)).toBe(false);
        transitionWorkerBackendSessionState(coreDb, {
          fromState: 'cleanup-pending',
          toState: 'physical-cleaned',
          attemptId: lease.leaseId,
        });
        await closeFactoryAttempt(
          coreDb,
          lease.leaseId,
          `turn:${environmentPackage.scope.turnId}:completed`
        );
        expect(
          observeExecutionAttempts(coreDb).find((attempt) => attempt.attempt_id === lease.leaseId)
            ?.phase
        ).toBe('closed');
        const closed = observeExecutionAttempts(coreDb).find(
          (attempt) => attempt.attempt_id === lease.leaseId
        )!;
        expect(closed.terminal_cause).toEqual(expect.any(String));
        expect(closed.outcome_ref).toBe(`turn:${closed.turn_id}:completed`);
        expect(settledOperations.slice(commandsBeforeRelease)).not.toContain('session.close');
        expect(
          effects.slice(effectsBeforeRelease).some((effect) => effect.kind === 'sandbox.delete')
        ).toBe(false);
        expect(
          coreDb.sqlite
            .prepare(`SELECT lifecycle_state, cleanup_state, current_turn_id, current_attempt_id
          FROM agent_session_runtime_bindings WHERE agent_session_id = ?`)
            .get(environmentPackage.scope.agentSessionId)
        ).toEqual({
          lifecycle_state: 'open',
          cleanup_state: 'clean',
          current_turn_id: null,
          current_attempt_id: null,
        });
      }
      const desired = packages[3]!;
      authorizeNanoHostPackage(coreDb, desired);
      enqueue(desired);
      const effectsBeforeRetry = effects.length;
      expect(
        coreDb.sqlite
          .prepare(
            `SELECT lifecycle_state AS state, cleanup_state AS cleanupState,
                current_turn_id AS turnId, current_attempt_id AS leaseId FROM agent_session_runtime_bindings`
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
      const replacement = backend.materialize(desired, {
        sandboxBindingRef: factoryPackageBinding(coreDb, desired),
        workspaceRoots: [],
      });
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
            requireAttemptId(packageSnapshotId: string): string;
          };
        }
      ).backend;
      backend.requireAttemptId = (packageSnapshotId) => `lease-${packageSnapshotId}`;
      const native = backend as WorkerGovernanceBackend & {
        evictIncompatibleIdleSandbox(...args: unknown[]): Promise<unknown>;
      };
      const retirementFailures: unknown[] = [];
      const evict = native.evictIncompatibleIdleSandbox.bind(native);
      vi.spyOn(native, 'evictIncompatibleIdleSandbox').mockImplementation(async (...args) => {
        try {
          return await evict(...args);
        } catch (error) {
          retirementFailures.push(error);
          throw error;
        }
      });
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
        attemptId: 'lease-snapshot_idle_eviction_a',
        sandboxBindingRef: 'lease-binding:idle-eviction-a',
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
          await expect(
            backend.materialize(firstPackage, {
              sandboxBindingRef: factoryPackageBinding(coreDb, firstPackage),
              workspaceRoots: [],
            })
          ).rejects.toThrow('NanoHost one-Sandbox capacity is occupied or unproved.');
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
      const firstMaterialization = await backend.materialize(firstPackage, {
        sandboxBindingRef: factoryPackageBinding(coreDb, firstPackage),
        workspaceRoots: [],
      });
      // Keep the real admitted fact when this direct fixture accepts ready proof.
      new FsStore({ dataRoot: coreDb.dataRoot }).updateAgentSession(
        firstPackage.scope.agentSessionId,
        {
          retainedStorage: firstMaterialization.retainedStorage!,
        }
      );
      const recordedDigests: string[] = [];
      backend.bindNativeHandleRecorder?.(firstPackage.snapshotId, (digest) => {
        recordedDigests.push(digest);
      });
      const launch = submitTestNanoHostTurn(coreDb, backend, firstMaterialization);

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
            ? ' Repository access returned HTTP 403; the source of the refusal is not established. Ask an authorized operator to inspect sandbox network policy and upstream access separately, then start a new Task only after cleanup and storage admission allow it. The incomplete slot stays in place.'
            : startupRefused === 'retained_baseline_conflict'
              ? ' The retained checkout and requested commit differ; choose a fresh work environment for the requested commit, or restore the source configuration to the retained checkout’s original commit before reusing it.'
              : startupRefused === 'git_fetch_commit_unavailable'
                ? ' The configured Git remote does not serve the requested commit; publish that commit or select one the remote serves, then start a new Task. The incomplete slot stays in place.'
                : startupRefused === 'git_fetch_tls_failed'
                  ? ' The worker could not trust the configured Git remote during fetch. Repair the sandbox trust bundle, then start a new Task. The incomplete slot stays in place.'
                  : startupRefused === 'git_fetch_transport_failed'
                    ? ' The worker could not complete the Git fetch transport. This covers a subprocess, timeout, or transport failure and is not proof that the remote lacks the commit. The incomplete slot stays in place.'
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

      await closeFactoryAttempt(coreDb, 'lease-snapshot_idle_eviction_a');
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
      expect(backend.inspectMaterializationCapacity?.(firstPackage)).toBe('available');
      coreDb.sqlite
        .prepare(
          `UPDATE agent_session_runtime_bindings
           SET lifecycle_state = 'active', current_turn_id = 'turn_compatible_busy',
               current_attempt_id = 'lease_compatible_busy'`
        )
        .run();
      coreDb.sqlite.prepare('UPDATE harness_instance_records SET active_turn_count = 1').run();
      // D70 keeps current execution excluded; retired physical pool headroom is no dispatch authority.
      expect(backend.inspectMaterializationCapacity?.(firstPackage)).toBe('capacity-saturated');
      coreDb.sqlite
        .prepare(
          `UPDATE agent_session_runtime_bindings
           SET lifecycle_state = 'open', current_turn_id = NULL, current_attempt_id = NULL`
        )
        .run();
      coreDb.sqlite.prepare('UPDATE harness_instance_records SET active_turn_count = 0').run();
      // This synthetic history tests closed occupancy, not an accepted native proof without provenance.
      coreDb.sqlite
        .prepare(
          `INSERT INTO agent_session_runtime_bindings (
             agent_session_runtime_binding_id, harness_instance_id, agent_session_id,
             workspace_id, thread_id, agent_session_compatibility_key,
             effective_setup_generation, native_handle_state, native_handle_digest,
             lifecycle_state, current_turn_id, current_attempt_id, next_turn_sequence,
             cleanup_state, created_at, updated_at, image_digest
           ) SELECT 'binding_closed_history', harness_instance_id, 'as_closed_history',
                    'workspace_closed_history', 'thread_closed_history', ?, 1, 'absent', NULL,
                    'closed', NULL, NULL, 1, 'clean', ?, ?, ?
             FROM harness_instance_records LIMIT 1`
        )
        .run(
          'f'.repeat(64),
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
          sandboxBindingRef: factoryPackageBinding(coreDb, secondPackage),
          workerStorageChoice: {
            ...selectedChoice,
            expectedRevision: selectedBinding.revision - 1,
          },
          workspaceRoots: [],
        })
      ).rejects.toThrow(
        'Incompatible resident cleanup requires exact deletion or Epoch fence proof.'
      );
      expect(retirementFailures).toHaveLength(1);
      expect(retirementFailures[0]).toMatchObject({
        name: 'WorkerStorageBindingError',
        code: 'revision_conflict',
        message: 'Worker storage revision changed.',
      });
      expect(effects).toHaveLength(effectsBeforeReplacement);
      expect(
        coreDb.sqlite.prepare('SELECT drain_state AS drainState FROM sandbox_runtime_records').get()
      ).toEqual({ drainState: 'accepting' });

      const replacement = backend.materialize(secondPackage, {
        sandboxBindingRef: factoryPackageBinding(coreDb, secondPackage),
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
          name: 'WorkerGovernanceCapacityUnavailableError',
          message: 'Incompatible resident cleanup requires exact deletion or Epoch fence proof.',
        });
        expect(retirementFailures).toHaveLength(2);
        expect(retirementFailures[1]).toMatchObject({
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
          name: 'WorkerGovernanceCapacityUnavailableError',
          message: 'Incompatible resident cleanup requires exact deletion or Epoch fence proof.',
        });
        expect(retirementFailures).toHaveLength(2);
        expect(retirementFailures[1]).toMatchObject({ message: 'Eviction Sandbox delete failed.' });
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
            requireAttemptId(packageSnapshotId: string): string;
          };
        }
      ).backend;
      backend.requireAttemptId = (packageSnapshotId) => `lease-${packageSnapshotId}`;
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
      const bindAndAnchor = async (environmentPackage: AgentEnvironmentPackage) => {
        for (const row of coreDb.sqlite
          .prepare(
            "SELECT attempt_id AS id FROM scheduler_execution_attempts WHERE workspace_id = ? AND thread_id = ? AND phase <> 'closed'"
          )
          .all(environmentPackage.scope.workspaceId, environmentPackage.scope.threadId) as {
          id: string;
        }[])
          await closeFactoryAttempt(coreDb, row.id);
        bindNanoHostWorkerLineage(coreDb, environmentPackage, {
          attemptId: leaseIdFor(environmentPackage),
          sandboxBindingRef: `lease-binding:${environmentPackage.scope.turnId}`,
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
      await bindAndAnchor(firstPackage);
      await backend.materialize(firstPackage, {
        sandboxBindingRef: factoryPackageBinding(coreDb, firstPackage),
        workspaceRoots: [],
      });
      const residentBinding = getWorkerStorageBindingForSandbox(coreDb, {
        sandboxBindingRef: latestSandboxBindingRef(),
      });
      if (!residentBinding) throw new Error('Expected attached retained storage.');
      expect(residentBinding.currentWorkSlotRef).toBe(workSlotRef);

      const effectsAfterFirst = effects.length;
      await bindAndAnchor(omittedPackage);
      await backend.materialize(omittedPackage, {
        sandboxBindingRef: factoryPackageBinding(coreDb, omittedPackage),
        workspaceRoots: [],
      });
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
      await bindAndAnchor(selectedSamePackage);
      const effectsBeforeStale = effects.length;
      await expect(
        backend.materialize(selectedSamePackage, {
          sandboxBindingRef: factoryPackageBinding(coreDb, selectedSamePackage),
          workerStorageChoice: { ...sameRefChoice, expectedRevision: residentBinding.revision - 1 },
          workspaceRoots: [],
        })
      ).rejects.toThrow('revision changed');
      await expect(
        backend.materialize(selectedSamePackage, {
          sandboxBindingRef: factoryPackageBinding(coreDb, selectedSamePackage),
          workerStorageChoice: { ...sameRefChoice, reuseWorkSlotRef: 'wsl_missing_selected_slot' },
          workspaceRoots: [],
        })
      ).rejects.toThrow('work slot is unavailable');
      expect(effects).toHaveLength(effectsBeforeStale);

      await backend.materialize(selectedSamePackage, {
        sandboxBindingRef: factoryPackageBinding(coreDb, selectedSamePackage),
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

      await bindAndAnchor(peerPackage);
      await expect(
        backend.materialize(peerPackage, {
          sandboxBindingRef: factoryPackageBinding(coreDb, peerPackage),
          workerStorageChoice: { ...sameRefChoice, expectedRevision: residentBinding.revision - 1 },
          workspaceRoots: [],
        })
      ).rejects.toThrow('revision changed');
      await expect(
        backend.materialize(peerPackage, {
          sandboxBindingRef: factoryPackageBinding(coreDb, peerPackage),
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
      await bindAndAnchor(selectedOtherPackage);
      await expect(
        backend.materialize(selectedOtherPackage, {
          sandboxBindingRef: factoryPackageBinding(coreDb, selectedOtherPackage),
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
          `UPDATE scheduler_execution_attempts SET phase = 'closed'
           WHERE attempt_id IN (?, ?, ?, ?, ?)`
        )
        .run(
          leaseIdFor(firstPackage),
          leaseIdFor(omittedPackage),
          leaseIdFor(selectedSamePackage),
          leaseIdFor(peerPackage),
          leaseIdFor(selectedOtherPackage)
        );

      await bindAndAnchor(selectedOtherRetryPackage);
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
          sandboxBindingRef: factoryPackageBinding(coreDb, selectedOtherRetryPackage),
          workerStorageChoice: { ...otherChoice, expectedRevision: idleOther.revision - 1 },
          workspaceRoots: [],
        })
      ).rejects.toThrow('revision changed');
      await expect(
        backend.materialize(selectedOtherRetryPackage, {
          sandboxBindingRef: factoryPackageBinding(coreDb, selectedOtherRetryPackage),
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
        sandboxBindingRef: factoryPackageBinding(coreDb, selectedOtherRetryPackage),
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

      await closeFactoryAttempt(coreDb, leaseIdFor(selectedOtherRetryPackage));
      const alternatePackage = packageFor('alternate', { workSlotRef: peerSlot });
      authorizeNanoHostPackage(coreDb, alternatePackage);
      await bindAndAnchor(alternatePackage);
      const beforeHandoff = effects.length;
      await backend.materialize(alternatePackage, {
        sandboxBindingRef: factoryPackageBinding(coreDb, alternatePackage),
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
      await closeFactoryAttempt(coreDb, leaseIdFor(alternatePackage));
      const otherAfterCleanup = getWorkerStorageBinding(coreDb, {
        storageRef: idleOther.storageRef,
      });
      await bindAndAnchor(freshPackage);
      await backend.materialize(freshPackage, {
        sandboxBindingRef: factoryPackageBinding(coreDb, freshPackage),
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
    {
      label: 'Round 33 Codex close unknown, independent Pi',
      origin: 'a'.repeat(64),
      dirty: false,
      operation: 'unknown',
    },
    { label: 'previous-Epoch queued', origin: 'f'.repeat(64), dirty: false, operation: 'queued' },
    { label: 'previous-Epoch dirty', origin: 'f'.repeat(64), dirty: true, operation: 'dispatched' },
  ] as const)('handles $label resident admission without replaying old Harness work', async ({
    label,
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
        adapterVersion: '0.160.0',
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
      if (operation === 'unknown') {
        openNanoHostAgentSessionBinding(coreDb, {
          agentSessionCompatibilityKey: 'd'.repeat(64),
          agentSessionId: 'as_round33_compatible_sibling',
          agentSessionRuntimeBindingId: 'binding-round33-compatible-sibling',
          effectiveSetupGeneration: 1,
          harnessInstanceId: 'harness-capacity-guard',
          threadId: 'thread_round33_compatible_sibling',
          timestamp: '2026-10-02T07:57:21.621Z',
          workspaceId: 'workspace_capacity_guard_resident',
        });
      }
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
      if (operation === 'dispatched' || operation === 'unknown') {
        expect(
          dispatchNanoHostHarnessOperation(coreDb, {
            sandboxIntegrationBindingRef: 'integration-binding-capacity-guard',
            now: () => '2026-10-02T08:02:19.267Z',
          })
        ).not.toBeNull();
      }
      if (operation === 'unknown')
        markNanoHostHarnessOperationUnknown(coreDb, {
          harnessBindingRef: 'harness-binding-capacity-guard',
          operationId: (
            coreDb.sqlite
              .prepare('SELECT operation_id AS id FROM harness_instance_records')
              .get() as { id: string }
          ).id,
          timestamp: '2026-10-02T08:02:20.267Z',
        });
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
        WHEN OLD.harness_instance_id = 'harness-capacity-guard'
        BEGIN INSERT INTO retired_harness_operations VALUES (OLD.operation_state); END;`);
      const workerControlGateway = createDefaultWorkerControlGateway(coreDb);
      let transcriptEvent: unknown;
      const nativeDispatch = createFactoryNanoHostDispatch(effects, {
        onExport: async (request) => {
          const stagingPath = join(mkdtempSync(join(tmpdir(), 'round33-export-')), 'complete');
          const bytes = Buffer.from(
            request.input.relativePath === 'events.jsonl' && transcriptEvent
              ? `${JSON.stringify(transcriptEvent)}\n`
              : '\n'
          );
          writeFileSync(stagingPath, bytes);
          return {
            stagingPath,
            byteLength: bytes.length,
            sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
          };
        },
      });
      const runtime = createConfiguredWorkerLifecycleRuntime({
        coreDb,
        env: {},
        nanoHostSessionDispatch:
          operation === 'unknown'
            ? nativeDispatch
            : {
                ...nativeDispatch,
                async effect(
                  requestOrConnection: object,
                  carriedRequest?: NanoHostSessionEffectRequest
                ) {
                  const request =
                    carriedRequest ?? (requestOrConnection as NanoHostSessionEffectRequest);
                  effects.push(request);
                  if (request.kind === 'image.acquire')
                    return { digest: request.input.imageReference };
                  if (request.kind === 'image.inspect') return nanoHostImageInspection(request);
                  if (request.kind === 'sandbox.create') return nanoHostSandboxCreated(request);
                  throw new Error(`Unexpected old-Epoch effect: ${request.kind}`);
                },
              },
        workerControlGateway,
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
      const residentAttemptId = (
        coreDb.sqlite
          .prepare('SELECT attempt_id AS id FROM scheduler_execution_attempts WHERE input_ref=?')
          .get(residentPackage.snapshotId) as { id: string }
      ).id;
      attempts.recordSchedulerExecutionOperation(coreDb, {
        attemptId: residentAttemptId,
        operationId: `fixture:${residentAttemptId}`,
        submission: true,
      });
      await closeFactoryAttempt(coreDb, residentAttemptId);
      coreDb.sqlite
        .prepare(`UPDATE scheduler_execution_attempts
        SET binding_ref = 'sandbox-binding-capacity-guard',
          terminal_cause = 'scheduler-restart-backend-cleanup'
        WHERE agent_session_id = 'as_capacity_guard_resident'`)
        .run();
      coreDb.sqlite
        .prepare(`UPDATE worker_backend_sessions
        SET sandbox_binding_ref = 'sandbox-binding-capacity-guard', state = 'cleaned',
          workspace_handoff_state = 'complete', physical_cleaned_at = '2026-10-02T08:01:37.559Z',
          origin_physical_epoch = ? WHERE agent_session_id = 'as_capacity_guard_resident'`)
        .run(origin);
      const residentKey = (
        coreDb.sqlite
          .prepare(
            "SELECT sandbox_compatibility_key AS key FROM sandbox_runtime_records WHERE sandbox_runtime_id = 'sandbox-runtime-capacity-guard'"
          )
          .get() as { key: string }
      ).key;
      coreDb.sqlite
        .prepare('UPDATE worker_backend_sessions SET backend_session_id=? WHERE attempt_id=?')
        .run(
          `nh-${residentKey.slice(0, 16)}-${createHash('sha256').update(residentPackage.snapshotId).digest('hex').slice(0, 16)}`,
          residentAttemptId
        );
      const oldAttempt = observeExecutionAttempts(coreDb).find(
        (attempt) => attempt.agent_session_id === 'as_capacity_guard_resident'
      );
      expect(oldAttempt).toBeDefined();
      if (operation === 'unknown')
        expect(oldAttempt!.phase, 'A must already be a positively closed Core attempt.').toBe(
          'closed'
        );
      const oldClose = coreDb.sqlite
        .prepare('SELECT operation_id, operation, operation_state FROM harness_instance_records')
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
        open_session_count: operation === 'unknown' ? 2 : 1,
        active_turn_count: 0,
        operation: 'session.close',
        result_json: null,
      });
      const siblingBefore = coreDb.sqlite
        .prepare(
          "SELECT * FROM agent_session_runtime_bindings WHERE agent_session_runtime_binding_id = 'binding-round33-compatible-sibling'"
        )
        .get();
      if (operation === 'unknown') {
        // A2's reported history fixes a regression target; it supplies no root-cause proof.
        ensureLocalUser(coreDb);
        const setup = createTestAgentSetup({
          adapter: 'pi',
          imageRef: `sha256:${'2'.repeat(64)}`,
          requiredCapabilities: ['trusted-worker-inference-relay'],
        });
        admitTestNativeEnvironment(coreDb, setup.manifest);
        const store = new FsStore({ dataRoot: coreDb.dataRoot });
        // Product admission composes the real Core entry and the real NanoHost executor.
        const app = createAppWithWorkspaceAuthority({
          coreDb,
          store,
          turnExecutor: runtime.turnExecutor,
          executionBackend: (
            runtime.turnExecutor as unknown as { backend: WorkerGovernanceBackend }
          ).backend,
          workerControlGateway,
          agentManifests: [setup.manifest],
          providerRegistry: new ProviderRegistry([
            {
              id: 'agent-openrouter',
              displayName: 'Pi fixture',
              kind: 'gateway',
              models: ['openai/gpt-5.2'],
            },
          ]),
          gatewayConfig: createTestGatewayConfig(),
        });
        // Use a distinct Thread under the same currently authorized Workspace.
        store.createThread(
          residentPackage.scope.workspaceId,
          'Independent Pi',
          'thread_round33_pi'
        );
        recordWorkspaceOwnerMembership({
          coreDb,
          workspaceId: residentPackage.scope.workspaceId,
          ownerUserId:
            residentPackage.scope.triggerActor.kind === 'user'
              ? residentPackage.scope.triggerActor.id
              : residentPackage.scope.triggerActor.responsibleUserId!,
        });
        insertFactoryUser(coreDb, 'user_local');
        coreDb.sqlite
          .prepare(
            "INSERT OR IGNORE INTO workspace_members (workspace_id,user_id,status,access_level,revision,joined_at,created_at,updated_at) VALUES (?, 'user_local','active','editor',1,?,?,?)"
          )
          .run(
            residentPackage.scope.workspaceId,
            new Date().toISOString(),
            new Date().toISOString(),
            new Date().toISOString()
          );
        const post = () =>
          app.request(
            ...operationRequest(
              'turn.start',
              {},
              {
                body: JSON.stringify({
                  workspaceId: residentPackage.scope.workspaceId,
                  threadId: 'thread_round33_pi',
                  agentId: setup.manifest.id,
                  input: 'Independent Pi work.',
                  requestId: '00000000-0000-4000-8000-00000000a234',
                }),
              }
            )
          );
        const receipt = await post();
        expect(receipt.status, label).toBe(202);
        const accepted = await receipt.json();
        expect(accepted.status).toBe('pending');
        expect((await (await post()).json()).id).toBe(accepted.id);
        expect(attemptActionOwners.listQueuedSchedulerAdmissionEntries(coreDb)).toContainEqual(
          expect.objectContaining({ turnId: accepted.id, status: 'queued' })
        );
        const originalAdmission = attemptActionOwners
          .listQueuedSchedulerAdmissionEntries(coreDb)
          .find((entry) => entry.turnId === accepted.id)!;
        expect(originalAdmission).toBeDefined();
        expect(effects).toEqual([]);
        expect(
          coreDb.sqlite
            .prepare(
              'SELECT operation, operation_state, open_session_count, active_turn_count FROM harness_instance_records'
            )
            .get()
        ).toEqual({
          operation: 'session.close',
          operation_state: 'unknown',
          open_session_count: 2,
          active_turn_count: 0,
        });
        expect(getWorkerStorageBinding(coreDb, { storageRef: retainedStorage.storageRef })).toEqual(
          retainedStorage
        );
        // The affected physical fence does not invent another session.close or a Core admission veto.
        expect(
          coreDb.sqlite
            .prepare(
              "SELECT * FROM agent_session_runtime_bindings WHERE agent_session_runtime_binding_id = 'binding-round33-compatible-sibling'"
            )
            .get()
        ).toEqual(siblingBefore);
        const reopened = openCoreDb(coreDb.dataRoot);
        try {
          expect(attemptActionOwners.listQueuedSchedulerAdmissionEntries(reopened)).toContainEqual(
            expect.objectContaining({ turnId: accepted.id, status: 'queued' })
          );
          expect(
            reopened.sqlite.prepare('SELECT operation_state FROM harness_instance_records').get()
          ).toEqual({ operation_state: 'unknown' });
          expect(
            reopened.sqlite
              .prepare(
                "SELECT * FROM agent_session_runtime_bindings WHERE agent_session_runtime_binding_id = 'binding-round33-compatible-sibling'"
              )
              .get()
          ).toEqual(siblingBefore);
        } finally {
          reopened.sqlite.close();
        }
        const providerRegistry = new ProviderRegistry([
          {
            id: 'agent-openrouter',
            displayName: 'Pi fixture',
            kind: 'gateway',
            models: ['openai/gpt-5.2'],
          },
        ]);
        const dispatch = () =>
          runSchedulerDispatchLoop({
            coreDb,
            store,
            turnExecutor: runtime.turnExecutor,
            executionBackend: (
              runtime.turnExecutor as unknown as { backend: WorkerGovernanceBackend }
            ).backend,
            agentManifests: [setup.manifest],
            providerRegistry,
            gatewayConfig: createTestGatewayConfig(),
            maxDispatches: 1,
          });
        const maintain = () =>
          runNanoHostAttemptRecoveryMaintenance(coreDb, {
            executionBackend: backend,
            reconcileAcceptedFinalStatus: async () => {},
            store,
            cleanupBackendSession: runtime.cleanupBackendSession,
            prepareBackendCleanup: runtime.prepareBackendCleanup,
            restoreBackendSession: runtime.restoreBackendSession,
            projectRecoveredTurn: async () => {
              throw new Error(
                'Maintenance must not invent an outcome for closed A or independent live B.'
              );
            },
          });
        /** Repeats real maintenance/dispatch and proves the exact unknown close is not replayed. */
        const refuseUnproved = async () => {
          for (let tick = 0; tick < 2; tick += 1) {
            await maintain();
            await dispatch();
            expect(attemptActionOwners.listQueuedSchedulerAdmissionEntries(coreDb)).toContainEqual(
              expect.objectContaining({ turnId: accepted.id, status: 'queued' })
            );
            expect(effects).toEqual([]);
            expect(
              coreDb.sqlite
                .prepare(
                  'SELECT operation_id, operation, operation_state FROM harness_instance_records'
                )
                .get()
            ).toEqual(oldClose);
            expect(
              observeExecutionAttempts(coreDb).find(
                (row) => row.attempt_id === oldAttempt!.attempt_id
              )
            ).toMatchObject({
              phase: 'closed',
              terminal_cause: oldAttempt!.terminal_cause,
              outcome_ref: oldAttempt!.outcome_ref,
            });
          }
        };
        await refuseUnproved();
        const unfenced = allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
          targetId: 'target_capacity_guard',
          deploymentId: 'deployment_capacity_guard',
          identityId: 'identity_capacity_guard',
          observedAt: '2026-10-02T10:10:00.000Z',
        });
        // Inject an incomplete projection; the readiness producer correctly rejects this as a proof.
        coreDb.sqlite
          .prepare(
            'UPDATE nanohost_runtime_targets SET predecessor_fenced = 0, ready = 1, fresh_empty = 1, physical_epoch = ? WHERE target_id = ? AND connection_generation = ?'
          )
          .run('b'.repeat(64), unfenced.targetId, unfenced.connectionGeneration);
        // Fresh readiness is insufficient while this successor has not fenced its exact predecessor.
        await refuseUnproved();
        const successor = unfenced;
        // Keep the exact successor, with its predecessor fence proved but readiness still absent.
        coreDb.sqlite
          .prepare(
            'UPDATE nanohost_runtime_targets SET predecessor_fenced = 1, ready = 0, fresh_empty = 0 WHERE target_id = ? AND connection_generation = ?'
          )
          .run(successor.targetId, successor.connectionGeneration);
        await refuseUnproved();
        upsertNanoHostRuntimeTarget(coreDb, {
          ...successor,
          predecessorFenced: true,
          ready: true,
          freshEmpty: true,
          physicalEpoch: 'b'.repeat(64),
          observedAt: '2026-10-02T10:10:02.000Z',
        });
        const nativeCommands: NonNullable<ReturnType<typeof dispatchNanoHostHarnessOperation>>[] =
          [];
        let finished = false;
        const running = dispatch()
          .then(async (result) => {
            await Promise.all(result.startedTurns.map(({ handle }) => handle.completion));
            return result;
          })
          .finally(() => {
            finished = true;
          });
        void running.catch(() => undefined);
        // Only the external Harness worker is doubled. Core creates B's package, session and attempt.
        for (let tick = 0; tick < 1000 && !finished; tick += 1) {
          const integrations = coreDb.sqlite
            .prepare('SELECT sandbox_integration_binding_ref AS ref FROM sandbox_runtime_records')
            .all() as { ref: string }[];
          for (const integration of integrations) {
            const exact = dispatchNanoHostHarnessOperation(coreDb, {
              sandboxIntegrationBindingRef: integration.ref,
            });
            if (!exact) continue;
            nativeCommands.push(exact);
            expect(exact.harnessInstanceId).not.toBe('harness-capacity-guard');
            expect(exact.body.agentSessionId).not.toBe('as_capacity_guard_resident');
            expect(exact.operationId).not.toBe((oldClose as { operation_id: string }).operation_id);
            const wire = runtime.acceptNanoHostHarnessCommand(exact);
            if (exact.operation === 'turn.start') {
              expect(exact.body.turnId).toBe(accepted.id);
              expect(
                coreDb.sqlite
                  .prepare(
                    'SELECT adapter_id FROM harness_instance_records WHERE harness_instance_id = ?'
                  )
                  .get(exact.harnessInstanceId)
              ).toEqual({ adapter_id: 'pi' });
              const own = observeExecutionAttempts(coreDb).find(
                (row) => row.turn_id === accepted.id && row.phase === 'open'
              );
              expect(own).toBeDefined();
              expect(own!.agent_session_id).toBe(exact.body.agentSessionId);
              expect(own!.attempt_id).toEqual(expect.any(String));
              expect(own!.queue_entry_id).toBe(originalAdmission.queueEntryId);
              expect(
                observeExecutionAttempts(coreDb).filter(
                  (row) => row.turn_id === accepted.id && row.phase === 'open'
                )
              ).toHaveLength(1);
              expect(own!.terminal_cause).toBeNull();
              expect(own!.outcome_ref).toBeNull();
              expect(own!.fence_ref).toBeNull();
              const agentSession = store.getAgentSession(String(exact.body.agentSessionId));
              const packageSnapshotId = agentSession.environmentPackageSnapshotId!;
              expect(packageSnapshotId).toEqual(expect.any(String));
              const workspaceDb = openWorkspaceDb(coreDb.dataRoot, accepted.workspaceId);
              try {
                const produced = requireAgentEnvironmentPackageSnapshot(
                  workspaceDb,
                  accepted.workspaceId,
                  packageSnapshotId
                ).snapshot;
                expect(produced.scope).toMatchObject({
                  turnId: accepted.id,
                  threadId: 'thread_round33_pi',
                  requestId: '00000000-0000-4000-8000-00000000a234',
                });
                expect(produced.agent.runtimeKind).toBe('pi');
                expect(
                  workerControlGateway.recordFinalStatus({
                    authorization: `Bearer ${wire.body.workerControlToken}`,
                    tokenFamily: 'worker-control',
                    lineage: {
                      agentSessionId: produced.scope.agentSessionId,
                      packageSnapshotId,
                      requestId: produced.scope.requestId,
                      threadId: produced.scope.threadId,
                      turnId: produced.scope.turnId,
                      workspaceId: produced.scope.workspaceId,
                    },
                    sequence: 1,
                    status: 'completed',
                    stopReason: 'completed',
                  }).accepted
                ).toBe(true);
              } finally {
                workspaceDb.sqlite.close();
              }
              const events = coreDb.sqlite
                .prepare(
                  "SELECT record_json FROM worker_control_records WHERE turn_id = ? AND operation = 'event_append'"
                )
                .all(accepted.id) as { record_json: string }[];
              transcriptEvent = events.length ? JSON.parse(events[0]!.record_json) : undefined;
            }
            const result = {
              schemaVersion: 2 as const,
              harnessInstanceId: exact.harnessInstanceId,
              operationId: exact.operationId,
              sequence: exact.sequence,
              disposition: 'succeeded' as const,
              body:
                exact.operation === 'session.close'
                  ? { state: 'closed', privateState: 'absent', childState: 'absent' }
                  : exact.operation === 'turn.start'
                    ? {
                        state: 'started',
                        nativeHandleState: 'ready',
                        nativeHandleDigest: 'a'.repeat(64),
                      }
                    : {
                        state: 'open',
                        maxActiveTurns: 1,
                        childState: 'running',
                        cleanupState: 'clean',
                        nativeHandleState: 'ready',
                        nativeHandleDigest: 'a'.repeat(64),
                      },
            };
            settleNanoHostHarnessOperation(coreDb, {
              result,
              sandboxIntegrationBindingRef: integration.ref,
              timestamp: new Date().toISOString(),
            });
            runtime.acceptNanoHostHarnessResult(result);
          }
          if (!finished) await new Promise<void>((resolve) => setTimeout(resolve, 1));
        }
        expect(finished, 'Core must consume the original queued Pi admission after proof.').toBe(
          true
        );
        const dispatched = await running;
        expect(dispatched.startedTurns).toHaveLength(1);
        expect(dispatched.startedTurns[0]!.dispatch.entry.turnId).toBe(accepted.id);
        expect(dispatched.startedTurns[0]!.handle.turn.id).toBe(accepted.id);
        expect(nativeCommands.filter((command) => command.operation === 'turn.start')).toHaveLength(
          1
        );
        expect(store.getTurnById(accepted.id).status).toBe('completed');
        for (let tick = 0; tick < 2; tick += 1) {
          await maintain();
          expect((await dispatch()).startedTurns).toEqual([]);
        }
        expect(nativeCommands.filter((command) => command.operation === 'turn.start')).toHaveLength(
          1
        );
        expect(
          coreDb.sqlite
            .prepare('SELECT 1 FROM harness_instance_records WHERE harness_instance_id = ?')
            .get('harness-capacity-guard')
        ).toBeUndefined();
        // B may retain a safe Pi resident or perform its own proved cleanup; neither replays A's close.
        for (const retained of coreDb.sqlite
          .prepare('SELECT adapter_id FROM harness_instance_records')
          .all())
          expect(retained).toEqual({ adapter_id: 'pi' });
        expect(effects.filter((effect) => effect.kind === 'sandbox.create')).toHaveLength(1);
        expect(coreDb.sqlite.prepare('SELECT * FROM retired_harness_operations').all()).toEqual([
          { operation_state: 'unknown' },
        ]);
        expect(
          observeExecutionAttempts(coreDb).find((row) => row.attempt_id === oldAttempt!.attempt_id)
        ).toMatchObject({
          phase: 'closed',
          terminal_cause: oldAttempt!.terminal_cause,
          outcome_ref: oldAttempt!.outcome_ref,
        });
        const ownClosed = observeExecutionAttempts(coreDb).filter(
          (row) => row.turn_id === accepted.id
        );
        expect(ownClosed.length).toBeGreaterThan(0);
        expect(ownClosed.every((row) => row.phase === 'closed')).toBe(true);
        expect(ownClosed.at(-1)).toMatchObject({ outcome_ref: `turn:${accepted.id}:completed` });
        expect(String(ownClosed.at(-1)!.terminal_cause)).not.toContain('session.close');
        return;
      }
      const desiredPackage = completeNanoHostPackage({
        agentSetup: createTestAgentSetup(),
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
        await expect(
          backend.materialize(desiredPackage, {
            sandboxBindingRef: factoryPackageBinding(coreDb, desiredPackage),
            workspaceRoots: [],
          })
        ).rejects.toThrow('capacity is occupied or unproved');
        expect(effects).toEqual([]);
        expect(
          coreDb.sqlite.prepare('SELECT operation_state FROM harness_instance_records').all()
        ).toEqual([{ operation_state: operation }]);
        expect(getWorkerStorageBinding(coreDb, { storageRef: retainedStorage.storageRef })).toEqual(
          retainedStorage
        );
        return;
      }
      // Physical absence cannot settle a live scheduler owner or a current Turn reference.
      coreDb.sqlite.exec(
        "UPDATE scheduler_execution_attempts SET phase = 'open' WHERE agent_session_id = 'as_capacity_guard_resident'"
      );
      expect(backend.inspectMaterializationCapacity?.(desiredPackage)).toBe('capacity-saturated');
      coreDb.sqlite.exec(
        "UPDATE scheduler_execution_attempts SET phase = 'closed' WHERE agent_session_id = 'as_capacity_guard_resident'"
      );
      for (const field of ['current_turn_id', 'current_attempt_id']) {
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
      await backend.materialize(desiredPackage, {
        sandboxBindingRef: factoryPackageBinding(coreDb, desiredPackage),
        workspaceRoots: [],
      });
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
        observeExecutionAttempts(coreDb).find(
          (attempt) => attempt.agent_session_id === 'as_capacity_guard_resident'
        )
      ).toEqual(oldAttempt);
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
        .prepare('UPDATE sandbox_runtime_records SET origin_physical_epoch = ?')
        .run(originPhysicalEpoch);
      if (withHarness) {
        // Fresh Epoch absence also retires stale binding lifecycle projections.
        expect(backend.inspectMaterializationCapacity?.(desiredPackage)).toBe('available');
        coreDb.sqlite.exec("UPDATE agent_session_runtime_bindings SET lifecycle_state = 'open'");
        coreDb.sqlite.exec('UPDATE harness_instance_records SET active_turn_count = 1');
        expect(backend.inspectMaterializationCapacity?.(desiredPackage)).toBe('capacity-saturated');
        coreDb.sqlite.exec('UPDATE harness_instance_records SET active_turn_count = 0');
        coreDb.sqlite.exec(
          "UPDATE agent_session_runtime_bindings SET current_attempt_id = 'lease_busy'"
        );
        expect(backend.inspectMaterializationCapacity?.(desiredPackage)).toBe('capacity-saturated');
        coreDb.sqlite.exec('UPDATE agent_session_runtime_bindings SET current_attempt_id = NULL');
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
          'SELECT attempt_id AS leaseId, binding_ref AS bindingRef FROM scheduler_execution_attempts'
        )
        .get() as { leaseId: string; bindingRef: string };
      coreDb.sqlite
        .prepare('UPDATE scheduler_execution_attempts SET binding_ref = ? WHERE attempt_id = ?')
        .run('sandbox-binding-capacity-guard', lease.leaseId);
      expect(backend.inspectMaterializationCapacity?.(desiredPackage)).toBe('capacity-saturated');
      coreDb.sqlite
        .prepare('UPDATE scheduler_execution_attempts SET binding_ref = ? WHERE attempt_id = ?')
        .run(lease.bindingRef, lease.leaseId);
      await backend.materialize(desiredPackage, {
        sandboxBindingRef: factoryPackageBinding(coreDb, desiredPackage),
        workspaceRoots: [],
      });
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
                   current_attempt_id = 'lease_busy'
               WHERE agent_session_runtime_binding_id = 'binding-capacity-guard'`
          )
          .run();
        coreDb.sqlite
          .prepare(
            `UPDATE harness_instance_records SET active_turn_count = 1
               WHERE harness_instance_id = 'harness-capacity-guard'`
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
            requireAttemptId(packageSnapshotId: string): string;
          };
        }
      ).backend;
      firstBackend.requireAttemptId = (snapshotId) => `lease-${snapshotId}`;
      anchorNanoHostMaterialization(coreDb, firstBackend, firstPackage);
      const firstMaterialization = await firstBackend.materialize(firstPackage, {
        sandboxBindingRef: factoryPackageBinding(coreDb, firstPackage),
        workspaceRoots: [],
      });
      new FsStore({ dataRoot: coreDb.dataRoot }).updateAgentSession(
        firstPackage.scope.agentSessionId,
        {
          retainedStorage: firstMaterialization.retainedStorage!,
        }
      );
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
      // The first binding retains ready proof for the positive reuse check; the synthetic incompatible Harness owns only restart retirement and has no accepted native proof.
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
           SET lifecycle_state = 'open', native_handle_state = 'absent',
               native_handle_digest = NULL, cleanup_state = 'clean'
           WHERE agent_session_runtime_binding_id = 'binding-restart-unproved-other'`
        )
        .run();
      coreDb.sqlite
        .prepare(
          `UPDATE scheduler_execution_attempts
           SET phase = 'closed'
           WHERE input_ref = ?`
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
      expect(restartedBackend.inspectMaterializationCapacity?.(secondPackage)).toBe('available');
      coreDb.sqlite
        .prepare(
          `UPDATE agent_session_runtime_bindings
           SET lifecycle_state = 'active', current_turn_id = 'turn_restart_busy',
               current_attempt_id = 'lease_restart_busy'`
        )
        .run();
      coreDb.sqlite.prepare('UPDATE harness_instance_records SET active_turn_count = 1').run();
      expect(restartedBackend.inspectMaterializationCapacity?.(secondPackage)).toBe(
        'capacity-saturated'
      );
      coreDb.sqlite
        .prepare(
          `UPDATE agent_session_runtime_bindings
           SET lifecycle_state = 'open', current_turn_id = NULL, current_attempt_id = NULL`
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
        attemptId: 'lease-restart-unproved-fresh',
        sandboxBindingRef: 'lease-binding:restart-unproved',
      });
      await expect(
        recoveringBackend.prepareAgentSessionContinuity?.({
          admissionAgentSessionId: secondPackage.scope.agentSessionId,
          admissionAttemptId: 'lease-restart-unproved-fresh',
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
          admissionAttemptId: 'lease-restart-unproved-fresh',
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
      await restartedBackend.materialize(secondPackage, {
        sandboxBindingRef: factoryPackageBinding(coreDb, secondPackage),
        workspaceRoots: [],
      });

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
      // This regression owns selected-storage release without native proof. Missing-fact ready proof
      // must refuse, as the ordinary restart/replacement regression above proves independently.
      coreDb.sqlite
        .prepare(
          `UPDATE agent_session_runtime_bindings
             SET lifecycle_state = 'open', native_handle_state = 'absent',
                 native_handle_digest = NULL, cleanup_state = 'clean'`
        )
        .run();
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

      const historyBackend = (
        runtime.turnExecutor as unknown as { backend: WorkerGovernanceBackend }
      ).backend;
      bindNanoHostWorkerLineage(coreDb, scopePackage, {
        attemptId: 'attempt_restart_selected_previous',
        sandboxBindingRef: 'sandbox-binding-restart-selected',
      });
      anchorNanoHostMaterialization(coreDb, historyBackend, scopePackage);
      coreDb.sqlite
        .prepare('UPDATE worker_backend_sessions SET backend_session_id=? WHERE attempt_id=?')
        .run(
          `nh-${'6'.repeat(16)}-${createHash('sha256').update(scopePackage.snapshotId).digest('hex').slice(0, 16)}`,
          'attempt_restart_selected_previous'
        );
      attempts.recordSchedulerExecutionOperation(coreDb, {
        attemptId: 'attempt_restart_selected_previous',
        operationId: 'operation_restart_selected_previous',
        submission: true,
      });
      await closeFactoryAttempt(coreDb, 'attempt_restart_selected_previous');
      createSchedulerAdmissionEntry(coreDb, {
        backendId: 'nanohost',
        now: () => '2026-09-11T00:00:02.000Z',
        queueEntryId: 'queue_restart_selected',
        requestId,
        requestedAgentId: 'agent_codex_host',
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

      publishFactoryAdmission(
        store,
        attemptActionOwners.requireSchedulerAdmissionEntry(coreDb, 'queue_restart_selected')
      );
      let observedError: unknown;
      try {
        const dispatchResult = await runSchedulerDispatchLoop({
          agentManifests: [
            createTestAgentSetup({
              imageRef: `sha256:${'4'.repeat(64)}`,
              requiredCapabilities: ['trusted-worker-inference-relay'],
            }).manifest,
          ],
          coreDb,
          createAgentSessionId: () => 'as_restart_selected_next',
          createAttemptId: () => 'lease_restart_selected_next',
          gatewayConfig: createTestGatewayConfig(),
          maxDispatches: 1,
          now: () => '2999-09-11T00:00:03.000Z',
          providerRegistry,
          store,
          turnExecutor: runtime.turnExecutor,
          executionBackend: (
            runtime.turnExecutor as unknown as { backend: WorkerGovernanceBackend }
          ).backend,
        });
        expect(
          dispatchResult.startedTurns,
          JSON.stringify(dispatchResult.terminalResult)
        ).toHaveLength(1);
        await Promise.all(dispatchResult.startedTurns.map(({ handle }) => handle.completion));
      } catch (error) {
        observedError = error;
      }
      const errorMessages = (error: unknown): string[] => [
        ...(error instanceof Error ? [error.message] : [String(error)]),
        ...(error instanceof AggregateError
          ? error.errors.flatMap((nested) => errorMessages(nested))
          : []),
      ];
      expect(errorMessages(observedError), JSON.stringify(errorMessages(observedError))).toContain(
        expectedError
      );

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
            requireAttemptId(packageSnapshotId: string): string;
          };
        }
      ).backend;
      backend.requireAttemptId = () => 'lease-credentials';
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
          sandboxBindingRef: factoryPackageBinding(coreDb, environmentPackage),
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
            requireAttemptId(packageSnapshotId: string): string;
          };
        }
      ).backend;
      backend.requireAttemptId = (snapshotId) => `lease-${snapshotId}`;
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
          backend.materialize(environmentPackage, {
            sandboxBindingRef: factoryPackageBinding(coreDb, environmentPackage),
            workspaceRoots: [],
          })
        ).rejects.toThrow('first sandbox.create reached');
        const sandboxCreate = sandboxCreates.at(-1);
        expect(sandboxCreate?.input).toMatchObject({
          backendSessionId: firstPlan.backendSessionId,
          environment: {},
          imageDigest: `sha256:${'b'.repeat(64)}`,
          leaseId: `lease-${snapshotId}`,
          packageSnapshotId: snapshotId,
          policyIntent: {
            additionalFilesystemGrants: [
              { access: 'read-only', path: '/workspace/vendor-sdk' },
              { access: 'read-write', path: '/sandbox/.cache/npm' },
            ],
            additionalNetworkEndpoints: [
              {
                access: 'read-only',
                binaries: ['/usr/bin/curl'],
                host: 'api.example.com',
                name: 'artifact_api',
                port: 443,
                protocol: 'rest',
              },
            ],
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
      await fixture.backend.materialize(fixture.environmentPackage, {
        sandboxBindingRef: factoryPackageBinding(fixture.coreDb, fixture.environmentPackage),
        workspaceRoots: [],
      });
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
        fixture.backend.materialize(fixture.environmentPackage, {
          sandboxBindingRef: factoryPackageBinding(fixture.coreDb, fixture.environmentPackage),
          workspaceRoots: [],
        })
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
          sandboxBindingRef: factoryPackageBinding(fixture.coreDb, fixture.environmentPackage),
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
          "UPDATE scheduler_execution_attempts SET phase = 'closed', deadline = '2000-01-01T00:00:00.000Z' WHERE attempt_id = ?"
        )
        .run('lease_admin_expired');
      await expect(
        fixture.backend.materialize(fixture.environmentPackage, {
          sandboxBindingRef: factoryPackageBinding(fixture.coreDb, fixture.environmentPackage),
          workspaceRoots: [],
        })
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

/** Completes all six modeled external owners for synthetic idle backend histories; this is not Native cleanup evidence. */
async function completeOwnedTerminalAttempt(
  db: ReturnType<typeof openCoreDb>,
  input: {
    readonly id: string;
    readonly workspaceId: string;
    readonly threadId: string;
    readonly status: string;
  }
) {
  const row = db.sqlite
    .prepare('SELECT attempt_id AS id FROM scheduler_execution_attempts WHERE turn_id = ?')
    .get(input.id) as { id: string };
  return closeFactoryAttempt(db, row.id, `turn:${input.id}:${input.status}`);
}

/** Establishes a positively fenced predecessor in backend-only fixtures whose external owners are modeled. */
async function closeFactoryAttempt(
  db: ReturnType<typeof openCoreDb>,
  attemptId: string,
  outcomeRef: string | null = null
) {
  const native = getWorkerBackendSession(db, attemptId);
  if (native && native.state !== 'cleaned') {
    if (!['cleanup-pending', 'cleanup-failed', 'physical-cleaned'].includes(native.state))
      transitionWorkerBackendSessionState(db, {
        attemptId,
        fromState: native.state,
        toState: 'cleanup-pending',
      });
    const stage = getWorkerBackendSession(db, attemptId)!;
    if (stage.state !== 'physical-cleaned')
      transitionWorkerBackendSessionState(db, {
        attemptId,
        fromState: stage.state,
        toState: 'physical-cleaned',
      });
    if (getWorkerBackendSession(db, attemptId)!.workspaceHandoffState !== 'complete')
      markWorkerBackendWorkspaceHandoffComplete(db, { attemptId });
    transitionWorkerBackendSessionState(db, {
      attemptId,
      fromState: 'physical-cleaned',
      toState: 'cleaned',
    });
  }
  const current = attempts.requireSchedulerExecutionAttempt(db, attemptId);
  if (current.phase === 'closed') return current;
  if (!current.operationId)
    return attempts.closeSchedulerExecutionAttemptWithoutEffects(db, {
      attemptId,
      cause: 'worker-final-phase',
      noOutstandingEffects: true,
    });
  const closing = attempts.markSchedulerExecutionAttemptClosing(db, {
    attemptId,
    cause: 'worker-final-phase',
    outcomeRef,
  });
  const proof = {
    terminalHandoff: true,
    output: true,
    evidence: true,
    outsideWorkspaceCollection: true,
    integrationDrain: true,
    routesRevoked: true,
  } as const;
  const released = await new SimulatedTurnExecutor({ coreDb: db }).release({
    ...attempts.schedulerExecutionCorrelation(closing),
    proof,
  });
  expect(released.state).toBe('released');
  return attempts.closeSchedulerExecutionAttemptWithFence(db, {
    correlation: attempts.schedulerExecutionCorrelation(closing),
    fenceRef: released.fenceRef!,
    proof,
  });
}

/** Publishes the same pending Turn and ordinary receipt produced by the command owner before dispatch. */
function publishFactoryAdmission(
  store: FsStore,
  entry: ReturnType<typeof createSchedulerAdmissionEntry>
) {
  store.createTurn(
    entry.workspaceId,
    entry.threadId,
    entry.turnInput,
    entry.triggerActor,
    undefined,
    {
      turnId: entry.turnId,
      status: 'pending',
      agentId: entry.requestedAgentId,
      executorKind: 'worker',
    }
  );
  store.recordCommandRequest({
    command: 'turn.start',
    requestId: entry.requestId,
    inputHash: `fixture:${entry.queueEntryId}`,
    scope: {
      workspaceId: entry.workspaceId,
      threadId: entry.threadId,
      actorId:
        entry.triggerActor.kind === 'user'
          ? entry.triggerActor.id
          : entry.triggerActor.responsibleUserId!,
    },
    response: { kind: 'turn', id: entry.turnId },
    createdAt: new Date().toISOString(),
  });
}

/** Carries the exact already-prepared Core binding at the direct Native materialization boundary. */
function factoryPackageBinding(
  db: ReturnType<typeof openCoreDb>,
  pkg: AgentEnvironmentPackage
): string | undefined {
  return (
    db.sqlite
      .prepare(
        'SELECT binding_ref AS bindingRef FROM scheduler_execution_attempts WHERE input_ref=? ORDER BY rowid DESC LIMIT 1'
      )
      .get(pkg.snapshotId) as { bindingRef: string } | undefined
  )?.bindingRef;
}
