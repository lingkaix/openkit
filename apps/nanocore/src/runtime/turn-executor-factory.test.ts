import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { connect as connectHttp2, createServer as createHttp2Server } from 'node:http2';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { getRequestListener } from '@hono/node-server';
import {
  type AgentEnvironmentPackage,
  AgentEnvironmentPackageSchema,
  planSessionWorkspaceMaterialization,
  resolveWorkspaceMcpServer,
  type SessionWorkspaceMaterializationPlan,
  WORKSPACE_RESOURCE_POLICY_FEATURE,
  WorkerSandboxAccessSchema,
  WorkspaceConfigSchema,
} from '@openkit/config-schema';
import { ENTITY_KINDS, entityIdPattern, isEntityId, workspaceIdForOwner } from '@openkit/protocol';
import {
  WORKER_OBSERVATION_SOURCE_MAX_BYTES,
  WorkerCanonicalEventRecordSchema,
  workerSessionInputPaths,
} from '@openkit/worker-protocol';
import { Hono } from 'hono';
import { afterAll, afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { createDefaultWorkerControlGateway } from '../app.js';
import { createOpenKitAccessTokenRecord } from '../auth/access-token-store.js';
import type { AuthVariables } from '../auth/middleware.js';
import {
  createNanoHostTransportSessionAuthority,
  readNanoHostPhysicalConnectionContext,
} from '../auth/nanohost-transport-session.js';
import {
  createMcpConfig,
  importWorkspaceSkill,
  loadResourceCatalog,
  skillSnapshotPath,
  updateMcpBinding,
} from '../catalog/resource-catalog.js';
import {
  createInMemoryRuntimeConfigSnapshot,
  createRuntimeConfigManager,
  loadRuntimeConfig,
} from '../config/runtime-config.js';
import { listStoredWorkspaceEvidenceBundles } from '../evidence-bundles.js';
import { KnowledgeNotebook } from '../knowledge/notebook.js';
import { SimulatedTurnExecutor } from '../lib/simulator.js';
import { commandRequestExpiresAt, commandRequestKey, FsStore } from '../lib/store.js';
import { createOperationInvocation } from '../operation-composition.js';
import { ProviderRegistry } from '../providers/registry.js';
import * as attemptActionOwners from '../scheduler-records.js';
import {
  createSchedulerAdmissionEntry,
  type SchedulerWorkerStorageChoice,
} from '../scheduler-records.js';
import { FileAdmissionError, FileStorageAdmission } from '../storage/artifacts/file-admission.js';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { ensureLayout } from '../storage/fs-layout.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { StoredAgentSessionV1Schema } from '../storage/retained-work-metadata-v1.js';
import { readWorkObservations } from '../storage/work-observations.js';
import { isCurrentAgentSessionStatus } from '../storage/workspace-file-records.js';
import {
  createTestAgentSetup,
  createTestGatewayConfig,
} from '../test-support/agent-environment.js';
import { createAppWithWorkspaceAuthority } from '../test-support/app.js';
import {
  createDemoStore,
  createDemoWorkspaceForUser,
  DEMO_THREAD_ID,
  DEMO_WORKSPACE_ID,
} from '../test-support/demo-store.js';
import { testEntityId } from '../test-support/entity-ids.js';
import {
  queueTestPreparedHarnessOperation as queueNanoHostHarnessOperation,
  recordTestExecutionAttempt,
} from '../test-support/execution-attempt.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import {
  admitTestNativeEnvironment,
  createTestNativeEnvironmentDb,
  recordTestNativeRuntimeTarget,
} from '../test-support/native-environment.js';
import { createNativeTaskAdmissionFixture } from '../test-support/native-task-admission.js';
import { notebookImportFixture } from '../test-support/notebook-import.js';
import { operationRequest } from '../test-support/operation-request.js';
import { managedThreadPolicy } from '../test-support/resource-policy.js';
import type { VaultBackend } from '../vault/vault-backend.js';
import { createVaultGrant, getVaultGrant, revokeVaultGrant } from '../vault/vault-grants.js';
import {
  advanceActiveVaultReferenceVersion,
  createVaultReference,
  getVaultReference,
} from '../vault/vault-references.js';
import { createVaultUnlockState } from '../vault/vault-unlock-state.js';
import { listVaultUseRecords } from '../vault/vault-use-records.js';
import { listVaultInjectionPlans } from '../vault-injection-plans.js';
import {
  type CreateVaultInjectionReceiptInput,
  createVaultInjectionReceipt,
  listVaultInjectionReceipts,
} from '../vault-injection-receipts.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
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
import * as journalOwners from './execution-journal.js';
import { createExecutionStepJournalReader } from './execution-journal.js';
import type { ExecutionInvocation, ExecutionJournalRef } from './execution-step-journal.js';
import { commandInputHash } from './idempotent-command.js';
import {
  bindNanoHostAttemptPreparation,
  requireNanoHostExecutionAttempt,
} from './nanohost-attempt-records.js';
import { runNanoHostAttemptRecoveryMaintenance } from './nanohost-attempt-recovery.js';
import { createNanoHostEffectRequest } from './nanohost-effect-identity.js';
import * as harnessRecords from './nanohost-harness-records.js';
import {
  createNanoHostHarnessRuntime,
  deriveNanoHostAgentSessionCompatibilityKey,
  dispatchNanoHostHarnessOperation,
  markNanoHostHarnessOperationUnknown,
  openNanoHostAgentSessionBinding,
  readNanoHostMeasuredHarnessIdentity,
  settleNanoHostHarnessOperation,
} from './nanohost-harness-records.js';
import {
  allocateNanoHostRuntimeTargetConnectionGeneration,
  getNanoHostRuntimeTarget,
  NanoHostCleanupFencePendingError,
  recordNanoHostRuntimeTargetConnectionClose,
  upsertNanoHostRuntimeTarget,
} from './nanohost-runtime-target.js';
import type {
  NanoHostSessionDispatch,
  NanoHostSessionEffectRequest,
} from './nanohost-session-dispatch.js';
import {
  createNanoHostSessionDispatch,
  NANO_HOST_EFFECT_OPERATIONS,
  registerNanoHostSessionEffectRoutes,
  registerNanoHostSessionSemanticRoutes,
} from './nanohost-session-dispatch.js';
import * as productOwners from './product-turn-start.js';
import { startSchedulerAttemptMaintenanceService } from './scheduler-attempt-maintenance-service.js';
import * as schedulerOwners from './scheduler-dispatch-loop.js';
import {
  getSchedulerPreparationClaims,
  runSchedulerDispatchLoop,
} from './scheduler-dispatch-loop.js';
import * as factoryOwners from './turn-executor-factory.js';
import {
  createConfiguredTurnExecutor,
  createConfiguredWorkerLifecycleRuntime as createWorkerLifecycleOwner,
} from './turn-executor-factory.js';
import type { PrepareAgentSessionForTurnInput } from './types.js';
import {
  getWorkerBackendSession,
  markWorkerBackendWorkspaceHandoffComplete,
  recordWorkerBackendSessionMaterializing,
  transitionWorkerBackendSessionState,
} from './worker-backend-sessions.js';
import { getWorkerCheckpoint } from './worker-checkpoints.js';
import { WorkerControlGateway } from './worker-control-gateway.js';
import {
  getWorkerControlAcceptedFinalStatus,
  recordWorkerControlAcceptedRecord,
} from './worker-control-records.js';
import { createWorkerEnvironmentRuntimeEffects } from './worker-environment-runtime-effects.js';
import {
  openShellFilesystemGrantsFromPackagePolicy,
  type WorkerArtifactCapture,
  type WorkerGovernanceBackend,
  type WorkerGovernanceBackendSessionIdentity,
  WorkerGovernanceCapacityUnavailableError,
  type WorkerGovernanceRuntimeEnvCredential,
  WorkerNativeProofValidationError,
} from './worker-governance-backend.js';
import {
  agentSessionCompatibilityKeyFromPackage,
  prepareWorkerTurnJournalIntents,
  type WorkerGovernanceTurnExecutor,
} from './worker-governance-turn-executor.js';
import * as storageOwners from './worker-storage-bindings.js';
import {
  activateWorkerStorageAttachment,
  createWorkerStorageBinding,
  getWorkerStorageBinding,
  getWorkerStorageBindingForSandbox,
  listWorkerStorageBindings,
  markWorkerStorageAttachmentUnknown,
  releaseWorkerStorageAttachment,
  reserveWorkerStorageAttachment,
  workerStorageDefaultWorkSlotRef,
} from './worker-storage-bindings.js';
import { terminalizeGovernedWorkerTurn } from './worker-turn-failure.js';
import {
  listWorkspaceReconciliationRecords,
  resolveWorkspaceReconciliationRecord,
} from './workspace-reconciliation-records.js';
import * as captureOwner from './workspace-snapshot-chain.js';
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

const fixtureDatabases: ReturnType<typeof openCoreDb>[] = [];
afterAll(() => {
  for (const coreDb of fixtureDatabases.splice(0)) {
    if (coreDb.sqlite.open) coreDb.sqlite.close();
    rmSync(coreDb.dataRoot, { recursive: true, force: true });
  }
});

/** Creates the durable deployment identity required by real executor construction. */
function createFactoryCoreDb() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-turn-executor-factory-'));
  ensureLayout(dataRoot);
  const coreDb = openCoreDb(dataRoot);
  fixtureDatabases.push(coreDb);
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
      targets: [{ target: '/openkit/threads' }, { target: '/sandbox' }, { target: '/workspace' }],
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
async function authorizeNanoHostPackage(
  coreDb: ReturnType<typeof createFactoryCoreDb>,
  environmentPackage: AgentEnvironmentPackage,
  options: {
    readonly membership?: boolean;
    readonly ownerUserId?: string;
  } = {}
): Promise<void> {
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
    await store.importWorkspaceSnapshot({
      ...notebookImportFixture({
        workspaceId: environmentPackage.scope.workspaceId,
        knowledge: [],
      }),
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
    await store.createThread(
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
  const attempt = coreDb.sqlite
    .prepare(
      'SELECT attempt_id AS attemptId, workspace_id AS workspaceId FROM scheduler_execution_attempts WHERE input_ref = ?'
    )
    .get(materialization.packageSnapshotId) as { attemptId: string; workspaceId: string };
  expect(attempt, 'Native submission must name the prepared package owner.').toBeDefined();
  const workspaceDb = openWorkspaceDb(coreDb.dataRoot, attempt.workspaceId);
  try {
    await backend.prepareLaunch(materialization, workspaceDb);
  } finally {
    workspaceDb.sqlite.close();
  }
  const submission = recordSchedulerExecutionOperation(coreDb, {
    attemptId: attempt.attemptId,
    operationId: commandInputHash({
      attemptId: attempt.attemptId,
      inputRef: materialization.packageSnapshotId,
      operation: 'submit',
    }),
    submission: true,
  });
  const observation = await backend.submit({
    ...schedulerExecutionCorrelation(submission),
    deadline: submission.deadline!,
  });
  expect(acceptSchedulerExecutionObservation(coreDb, observation)).not.toBeNull();
  return observation;
}

/** Observes the actual queue commit before dispatch, within the caller's original case bound. */
async function waitForFactoryHarnessCommand(coreDb: ReturnType<typeof createFactoryCoreDb>) {
  const queued = Promise.withResolvers<void>();
  const queue = harnessRecords.queueNanoHostHarnessOperation;
  const observation = vi
    .spyOn(harnessRecords, 'queueNanoHostHarnessOperation')
    .mockImplementation((...args) => {
      const sequence = queue(...args);
      if (args[0] === coreDb) queued.resolve();
      return sequence;
    });
  onTestFinished(() => observation.mockRestore());
  const dispatch = () => {
    const integration = coreDb.sqlite
      .prepare(`SELECT sandbox_integration_binding_ref AS integrationRef
        FROM sandbox_runtime_records ORDER BY created_at LIMIT 1`)
      .get() as { readonly integrationRef: string } | undefined;
    return {
      command: integration
        ? dispatchNanoHostHarnessOperation(coreDb, {
            sandboxIntegrationBindingRef: integration.integrationRef,
          })
        : null,
      integrationRef: integration?.integrationRef ?? '',
    };
  };
  try {
    const current = dispatch();
    if (current.command) return current;
    await queued.promise;
    return dispatch();
  } finally {
    observation.mockRestore();
  }
}

/** Admits the real Turn binding and original execution obligations before a backend fixture effect. */
async function admitFactoryTurnJournal(
  coreDb: ReturnType<typeof createFactoryCoreDb>,
  environmentPackage: AgentEnvironmentPackage,
  attemptId: string,
  identity: WorkerGovernanceBackendSessionIdentity
): Promise<void> {
  const store = new FsStore({ dataRoot: coreDb.dataRoot });
  try {
    store.getTurnById(environmentPackage.scope.turnId);
  } catch {
    await store.createTurn(
      environmentPackage.scope.workspaceId,
      environmentPackage.scope.threadId,
      'Factory backend fixture',
      environmentPackage.scope.triggerActor,
      null,
      {
        turnId: environmentPackage.scope.turnId,
        agentId: environmentPackage.agent.agentId,
        executorKind: 'worker',
        captureCoverage: { scope: 'server', value: 'off' },
      }
    );
  }
  const workspaceDb = openWorkspaceDb(coreDb.dataRoot, environmentPackage.scope.workspaceId);
  try {
    if (
      workspaceDb.sqlite
        .prepare('SELECT 1 FROM control_executions WHERE work_id=?')
        .get(environmentPackage.scope.turnId)
    )
      return;
    const attempt = attempts.requireSchedulerExecutionAttempt(coreDb, attemptId);
    const journalIntents = prepareWorkerTurnJournalIntents(
      workspaceDb,
      environmentPackage,
      attempt,
      {
        backendKind: identity.backendKind,
        targetId: identity.runtimeTargetId,
        allocationRef: attempt.bindingRef,
      }
    );
    await store.updateTurn(
      environmentPackage.scope.turnId,
      {
        agentId: environmentPackage.agent.agentId,
        agentSessionId: environmentPackage.scope.agentSessionId,
      },
      { journalIntents }
    );
  } finally {
    workspaceDb.sqlite.close();
  }
}

/** Adds the already-owned pre-effect backend anchor for direct backend-unit materialization. */
async function anchorNanoHostMaterialization(
  coreDb: ReturnType<typeof createFactoryCoreDb>,
  backend: WorkerGovernanceBackend,
  environmentPackage: AgentEnvironmentPackage
): Promise<void> {
  const fixtureStore = new FsStore({ dataRoot: coreDb.dataRoot });
  try {
    fixtureStore.getAgentSession(environmentPackage.scope.agentSessionId);
  } catch {
    for (const prior of fixtureStore.listThreadAgentSessions(
      environmentPackage.scope.workspaceId,
      environmentPackage.scope.threadId
    ))
      if (prior.status !== 'closed')
        await fixtureStore.updateAgentSession(prior.id, {
          status: 'closed',
          updatedAt: environmentPackage.createdAt,
        });
    await fixtureStore.createAgentSession({
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
    leaseId = testEntityId('attempt', `lease-fixture:${environmentPackage.snapshotId}`);
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
  await admitFactoryTurnJournal(coreDb, environmentPackage, leaseId, identity);
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
    responsibleUserId: 'usr_00000000-0000-7696-8ea8-dab52c9a8217',
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
    agentSessionId: String(input.scope.agentSessionId ?? testEntityId('as', 'as_factory_fixture')),
    agentSetup: agentSetup ?? createTestAgentSetup(),
    backend: { kind: 'openshell' },
    createdAt: '2026-08-21T00:00:00.000Z',
    requestId: 'request_factory_fixture',
    triggerActor: { kind: 'user', id: 'usr_00000000-0000-7353-b5d8-71f1d581a738' },
    turn: {
      completedAt: null,
      configVersion: null,
      durationMs: null,
      error: null,
      id: String(input.scope.turnId ?? testEntityId('tu', 'turn_factory_fixture')),
      items: [],
      startedAt: '2026-08-21T00:00:00.000Z',
      status: 'running',
      threadId: String(input.scope.threadId ?? 'th_00000000-0000-79ee-a2d0-3fba4a9c8530'),
      triggerActor: { kind: 'user', id: 'usr_00000000-0000-7353-b5d8-71f1d581a738' },
      owner: {
        kind: 'workspace',
        workspaceId: String(input.scope.workspaceId ?? 'ws_00000000-0000-7d70-aab0-c1f50b525f79'),
      },
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
    runtime: {
      image: { kind: 'reference', pullPolicy: 'if-not-present', ref: 'openkit/worker:test' },
    },
    scope: {
      agentSessionId: testEntityId('as', `as_${label}`),
      threadId: testEntityId('th', `thread_${label}`),
      turnId: testEntityId('tu', `turn_${label}`),
      workspaceId: testEntityId('ws', `ws_${label}`),
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
  const leaseId = testEntityId('attempt', `lease_${label}`);
  backend.requireAttemptId = () => leaseId;
  await authorizeNanoHostPackage(coreDb, environmentPackage);
  await anchorNanoHostMaterialization(coreDb, backend, environmentPackage);
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
async function prepareNonmemberAdminWorkerStorage(label: string) {
  const coreDb = createFactoryCoreDb();
  const effects: NanoHostSessionEffectRequest[] = [];
  const hooks: { onInspect?: () => void } = {};
  const adminUserId = 'usr_00000000-0000-7608-82c1-24d471dc8ebe';
  const ownerUserId = 'usr_00000000-0000-7616-b399-55d24068709b';
  const tokenId = `token_${label}`;
  const workspaceId = testEntityId('ws', `workspace_${label}`);
  const environmentPackage = completeNanoHostPackage({
    scope: {
      agentSessionId: testEntityId('as', `as_${label}`),
      threadId: testEntityId('th', `thread_${label}`),
      turnId: testEntityId('tu', `turn_${label}`),
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
  await authorizeNanoHostPackage(coreDb, environmentPackage, {
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
    attemptId: testEntityId('attempt', `lease_${label}`),
    sandboxBindingRef: `lease-binding:${label}`,
    serverAdminTokenId: tokenId,
  });
  const currentConfiguration = createInMemoryRuntimeConfigSnapshot({
    dataRoot: coreDb.dataRoot,
    workspaceConfigs: loadRuntimeConfig(coreDb.dataRoot).workspaceConfigs,
  });
  const runtime = createConfiguredWorkerLifecycleRuntime({
    readRuntimeConfig: () => currentConfiguration,
    coreDb,
    env: {},
    nanoHostSessionDispatch: createFactoryNanoHostDispatch(effects, hooks),
    workerControlGateway: new WorkerControlGateway(),
  });
  const backend = (runtime.turnExecutor as unknown as { readonly backend: WorkerGovernanceBackend })
    .backend;
  await anchorNanoHostMaterialization(coreDb, backend, environmentPackage);
  return {
    currentConfiguration,
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

/** Reads current authored Policy after each fixture creates its owned Workspace. */
function createConfiguredWorkerLifecycleRuntime(
  options: Parameters<typeof createWorkerLifecycleOwner>[0] = {}
) {
  return createWorkerLifecycleOwner({
    ...options,
    readRuntimeConfig:
      options.readRuntimeConfig ??
      (() =>
        options.coreDb
          ? loadRuntimeConfig(options.coreDb.dataRoot)
          : createInMemoryRuntimeConfigSnapshot({ dataRoot: null })),
  });
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
        agentSessionId: testEntityId('as', 'as_effect_carriage'),
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
        testEntityId('attempt', 'lease_effect_carriage'),
        'image.inspect',
        { imageDigest }
      );
      const otherLeaseInspection = createNanoHostEffectRequest(
        identity,
        testEntityId('attempt', 'lease_effect_carriage_other'),
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
        testEntityId('attempt', 'lease_effect_carriage'),
        'sandbox.create',
        {
          imageDigest,
          sandboxId: 'sandbox-effect-carriage',
          policyIntent: { additionalFilesystemGrants: [], additionalNetworkEndpoints: [] },
          storage: {
            attachmentGeneration: 1,
            layoutDigest: `sha256:${'a'.repeat(64)}`,
            scopeDigest: `sha256:${'b'.repeat(64)}`,
            storageRef: 'wst_00000000-0000-748a-8c09-e3eb26ff4e25',
            targets: [{ target: '/workspace', volumeRef: 'wsv_effect_carriage' }],
          },
        }
      );
      expect(sandboxCreate.input).toMatchObject({
        backendSessionId: identity.backendSessionId,
        leaseId: testEntityId('attempt', 'lease_effect_carriage'),
        packageSnapshotId: identity.packageSnapshotId,
        storage: { storageRef: 'wst_00000000-0000-748a-8c09-e3eb26ff4e25' },
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
    const dispatch = createNanoHostSessionDispatch({
      coreDb,
      sessionAuthority: authority,
      fileAdmission: new FileStorageAdmission(coreDb.dataRoot, () => 0n),
    });
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
      const attemptId = testEntityId('attempt', 'lease_pre_witness_cleanup');
      const environmentPackage = completeNanoHostPackage({
        scope: {
          agentSessionId: testEntityId('as', 'as_pre_witness_cleanup'),
          threadId: 'th_00000000-0000-7ca5-9987-116ab66f51c7',
          turnId: testEntityId('tu', 'turn_pre_witness_cleanup'),
          workspaceId: 'ws_00000000-0000-703d-8b8c-9fdf9957fc96',
        },
        snapshotId: 'aepsnap_pre_witness_cleanup',
      });
      await authorizeNanoHostPackage(coreDb, environmentPackage);
      bindNanoHostWorkerLineage(coreDb, environmentPackage, {
        attemptId,
        sandboxBindingRef: 'sandbox-binding-pre-witness-cleanup',
      });
      const identity = backend.planSession(environmentPackage);
      await anchorNanoHostMaterialization(coreDb, backend, environmentPackage);
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
        threadId: 'th_00000000-0000-7ca5-9987-116ab66f51c7',
        workspaceId: 'ws_00000000-0000-703d-8b8c-9fdf9957fc96',
      });
      transitionWorkerBackendSessionState(coreDb, {
        attemptId,
        fromState: 'materializing',
        toState: 'cleanup-pending',
      });
      // Model the converted predecessor cohort only after valid original owner setup.
      coreDb.sqlite
        .prepare(
          `UPDATE worker_backend_sessions SET origin_physical_epoch = 'pre-witness'
           WHERE attempt_id = ?`
        )
        .run(attemptId);

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
        agentSessionId: testEntityId('as', 'as_epoch_race'),
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
           ) VALUES ('${testEntityId('attempt', 'lease_epoch_race')}', 'ws_00000000-0000-75f7-b25a-09c4b172778e', 'th_00000000-0000-7f4f-88a5-4b398f8f889d',
             'tu_00000000-0000-72bc-acff-63dafcde7826', ?, ?, 'openshell', ?, ?, ?, ?, ?,
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
          workspaceId: 'ws_00000000-0000-75f7-b25a-09c4b172778e',
          threadId: 'th_00000000-0000-7f4f-88a5-4b398f8f889d',
          turnId: testEntityId('tu', 'turn_epoch_race'),
        },
        snapshotId: identity.packageSnapshotId,
      });
      await authorizeNanoHostPackage(coreDb, epochPackage);
      bindNanoHostWorkerLineage(coreDb, epochPackage, {
        attemptId: testEntityId('attempt', 'lease_epoch_race'),
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
      backend.requireAttemptId = () => testEntityId('attempt', 'lease_epoch_race');
      await anchorNanoHostMaterialization(
        coreDb,
        backend as unknown as WorkerGovernanceBackend,
        epochPackage
      );
      await admitFactoryTurnJournal(
        coreDb,
        epochPackage,
        testEntityId('attempt', 'lease_epoch_race'),
        identity
      );
      await expect(
        backend.effect(identity, testEntityId('attempt', 'lease_epoch_race'), 'image.inspect', {
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
        backend.effect(identity, testEntityId('attempt', 'lease_epoch_race'), 'image.inspect', {
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
      ?.split('/** Returns ws_00000000-0000-7652-b38f-f1800a855e1b candidates')[0];
    const workspaceSource = backendSource
      ?.split('public async collectWorkspaceChanges(')[1]
      ?.split('/** Dispatches one fixed effect')[0];
    const cleanupSource = backendSource
      ?.split('private async deleteSandbox(')[1]
      ?.split('/** Drops process-local projections')[0];
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
    expect(prepareImports).toBeGreaterThanOrEqual(0);
    expect(prepareImports).toBeLessThan(
      materializeSource?.indexOf('this.evictIncompatibleIdleSandbox(') ?? -1
    );
    expect(prepareImports).toBeLessThan(imageBuild);
    expect(prepareImports).toBeLessThan(sandboxCreate);
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
    const store = await createDemoStore();
    const turn = await store.updateTurn(
      (
        await store.createTurn(
          'ws_00000000-0000-7000-8000-000000000001',
          'th_00000000-0000-7000-8000-000000000001',
          'Require configured NanoHost readiness',
          { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
          null
        )
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
          freshAgentSessionId: 'as_00000000-0000-7d6e-a3d8-9e0d90e77ae0',
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
      agentSessionId: 'as_00000000-0000-7ff2-9481-d757fe7ac840',
      agentSessionRuntimeBindingId: 'binding-unready-predecessor',
      effectiveSetupGeneration: 1,
      harnessInstanceId: 'harness-unready-admission',
      threadId: 'th_00000000-0000-7000-8000-000000000001',
      timestamp: '2026-08-21T00:00:01.000Z',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    });
    allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
      deploymentId: 'deployment-unready-admission',
      identityId: 'identity-unready-admission',
      observedAt: '2026-08-21T00:00:02.000Z',
      targetId: 'target-unready-admission',
    });
    const store = await createDemoStore();
    const turn = await store.updateTurn(
      (
        await store.createTurn(
          'ws_00000000-0000-7000-8000-000000000001',
          'th_00000000-0000-7000-8000-000000000001',
          'Do not close before readiness',
          { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
          null
        )
      ).id,
      { agentId: 'agent_codex_host' }
    );
    await store.createAgentSession({
      agentId: 'agent_codex_host',
      createdAt: '2026-08-21T00:00:01.000Z',
      environmentPackageSnapshotId: 'aepsnap-unready-predecessor',
      id: 'as_00000000-0000-7ff2-9481-d757fe7ac840',
      message: null,
      policySnapshotId: 'worker_turn_launch_policy',
      sessionCompatibilityKey: `sha256:${'d'.repeat(64)}`,
      status: 'idle',
      threadId: turn.threadId,
      updatedAt: '2026-08-21T00:00:01.000Z',
      workspaceId: workspaceIdForOwner(turn.owner),
      workspaceRoots: [],
    });
    const predecessorPackage = completeNanoHostPackage({
      agentSetup: createTestAgentSetup(),
      scope: {
        agentSessionId: 'as_00000000-0000-7ff2-9481-d757fe7ac840',
        threadId: turn.threadId,
        turnId: turn.id,
        triggerActor: turn.triggerActor,
        workspaceId: workspaceIdForOwner(turn.owner),
      },
      snapshotId: 'aepsnap-unready-predecessor',
    });
    const workspaceDb = openWorkspaceDb(coreDb.dataRoot, workspaceIdForOwner(turn.owner));
    try {
      recordAgentEnvironmentPackageSnapshot(workspaceDb, {
        environmentPackage: predecessorPackage,
        createdAt: predecessorPackage.createdAt,
      });
    } finally {
      workspaceDb.sqlite.close();
    }
    const runtime = createConfiguredWorkerLifecycleRuntime({
      coreDb,
      env: {},
      workerControlGateway: new WorkerControlGateway(),
    });
    try {
      await expect(
        runtime.turnExecutor.prepareAgentSessionForTurn?.(store, {
          agentSetup: createTestAgentSetup(),
          freshAgentSessionId: 'as_00000000-0000-75cf-8a90-5e33ce6f37f2',
          requestId: 'req-unready-runtime-target',
          turn,
          turnInput: turn.input,
          workspaceRoots: [],
        })
      ).rejects.toBeInstanceOf(WorkerGovernanceCapacityUnavailableError);
      expect(store.getAgentSession('as_00000000-0000-7ff2-9481-d757fe7ac840').status).toBe('idle');
      expect(
        coreDb.sqlite
          .prepare(
            'SELECT lifecycle_state AS lifecycleState FROM agent_session_runtime_bindings WHERE agent_session_id = ?'
          )
          .get('as_00000000-0000-7ff2-9481-d757fe7ac840')
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
          readonly backend: WorkerGovernanceBackend & {
            queueAndWaitForHarnessOperation(
              session: unknown,
              operation: 'harness.drain',
              body: Readonly<Record<string, unknown>>
            ): Promise<Readonly<Record<string, unknown>>>;
          };
        }
      ).backend;
      const environmentPackage = completeNanoHostPackage({
        scope: {
          workspaceId: testEntityId('ws', 'harness-deadline'),
          threadId: testEntityId('th', 'harness-deadline'),
          turnId: testEntityId('tu', 'harness-deadline'),
          agentSessionId: testEntityId('as', 'harness-deadline'),
        },
        snapshotId: 'snapshot-harness-deadline',
      });
      await authorizeNanoHostPackage(coreDb, environmentPackage);
      await anchorNanoHostMaterialization(coreDb, backend, environmentPackage);
      const attemptId = (
        coreDb.sqlite
          .prepare('SELECT attempt_id FROM scheduler_execution_attempts WHERE input_ref=?')
          .get(environmentPackage.snapshotId) as { attempt_id: string }
      ).attempt_id;
      const session: {
        environmentPackage: AgentEnvironmentPackage;
        attemptId: string;
        harnessBindingRef: string;
        harnessInstanceId: string;
        pendingHarnessOperation: { operationId: string | null } | null;
      } = {
        environmentPackage,
        attemptId,
        harnessBindingRef: 'harness-binding-never-polled',
        harnessInstanceId: 'harness-never-polled',
        pendingHarnessOperation: null,
      };
      const queue = harnessRecords.queueNanoHostHarnessOperation;
      let queued!: () => void;
      const queuedCommand = new Promise<void>((resolve) => {
        queued = resolve;
      });
      const queueObservation = vi
        .spyOn(harnessRecords, 'queueNanoHostHarnessOperation')
        .mockImplementation((...args) => {
          const sequence = queue(...args);
          queued();
          return sequence;
        });
      const pending = backend.queueAndWaitForHarnessOperation(session, 'harness.drain', {});
      void pending.catch(() => undefined);
      await Promise.race([queuedCommand, pending]);
      queueObservation.mockRestore();
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
    const store = await createDemoStore();
    const turn = await store.updateTurn(
      (
        await store.createTurn(
          'ws_00000000-0000-7000-8000-000000000001',
          'th_00000000-0000-7000-8000-000000000001',
          'Admit against ready NanoHost',
          { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
          null
        )
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
          freshAgentSessionId: 'as_00000000-0000-7ef6-8585-a46fb4284ef8',
          requestId: 'req-ready-runtime-target',
          turn,
          turnInput: turn.input,
          workspaceRoots: [],
        })
      ).resolves.toEqual({
        agentSessionId: 'as_00000000-0000-7ef6-8585-a46fb4284ef8',
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
        threadId: 'th_00000000-0000-730e-88b8-d76794f39a2f',
        workspaceId: 'ws_00000000-0000-70f1-89ce-933e4aeb49a8',
      });
      for (const suffix of ['one', 'two']) {
        openNanoHostAgentSessionBinding(coreDb, {
          agentSessionCompatibilityKey: suffix === 'one' ? 'b'.repeat(64) : 'c'.repeat(64),
          agentSessionId: testEntityId('as', `agent-session-${suffix}`),
          agentSessionRuntimeBindingId: `agent-session-binding-${suffix}`,
          effectiveSetupGeneration: 1,
          harnessInstanceId: 'harness-factory-restore',
          threadId: `thread-${suffix}`,
          timestamp: '2026-08-21T00:00:00.000Z',
          workspaceId: 'ws_00000000-0000-70f1-89ce-933e4aeb49a8',
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
      ).toEqual(
        [testEntityId('as', 'agent-session-one'), testEntityId('as', 'agent-session-two')].sort()
      );
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
        turnId: 'tu_00000000-0000-7198-835c-d2d0d4772464',
        turnInput: 'Commit exact continuity',
        triggerActor: environmentPackage.scope.triggerActor,
        workspaceId: input.workspaceId,
      });
      const continuityAttempt = attempts.createSchedulerExecutionAttempt(coreDb, {
        entry: attemptActionOwners.requireSchedulerAdmissionEntry(
          coreDb,
          'queue_continuity_commit'
        ),
        attemptId: testEntityId('attempt', 'lease-continuity-commit'),
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
          admissionAttemptId: testEntityId('attempt', 'lease-continuity-commit'),
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
          admissionAttemptId: testEntityId('attempt', 'lease-continuity-commit'),
        })
      ).resolves.toBe('sandbox-replacement-required');
      coreDb.sqlite
        .prepare(
          `UPDATE scheduler_execution_attempts SET agent_session_id = ?
           WHERE attempt_id = '${testEntityId('attempt', 'lease-continuity-commit')}'`
        )
        .run('as_00000000-0000-7ae9-8d3d-3dddb5075810');
      const retirementPackage = completeNanoHostPackage({
        scope: {
          agentSessionId: 'as_00000000-0000-7ae9-8d3d-3dddb5075810',
          threadId: input.threadId,
          turnId: 'tu_00000000-0000-7198-835c-d2d0d4772464',
          workspaceId: input.workspaceId,
        },
        snapshotId: 'snapshot-continuity-retirement',
      });
      await authorizeNanoHostPackage(coreDb, retirementPackage);
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
          admissionAttemptId: testEntityId('attempt', 'lease-continuity-commit'),
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
   * Leaves a backend-only terminal Harness binding idle with its ready digest recorded.
   * This fixture does not prove the full Worker output and release path.
   *
   * @param label Fixture suffix.
   * @returns The resident package and the backend that still owns its Harness.
   */
  async function admitIdleSupplyResident(
    label: string,
    options: {
      scope?: Pick<
        AgentEnvironmentPackage['scope'],
        'workspaceId' | 'threadId' | 'agentSessionId' | 'turnId'
      >;
      attemptId?: string;
      agentSetup?: ReturnType<typeof createTestAgentSetup>;
      capacity?: number;
      gitBaseline?: { commit: string; tree: string };
      nativeValues?: Record<string, string>;
      inspection?: 'unavailable' | 'stale';
      effects?: NanoHostSessionEffectRequest[];
      vaultBackend?: () => VaultBackend;
      configurePackage?: (
        environmentPackage: AgentEnvironmentPackage,
        coreDb: ReturnType<typeof createFactoryCoreDb>
      ) => void | Promise<void>;
      onCollection?: (request: NanoHostSessionEffectRequest) => Promise<Record<string, unknown>>;
      onExport?: (request: NanoHostSessionEffectRequest) => Promise<Record<string, unknown>>;
      /** Admits original observation output while this fixture's submitted Turn is still live. */
      beforeFinalStatus?: (input: {
        coreDb: ReturnType<typeof createFactoryCoreDb>;
        environmentPackage: AgentEnvironmentPackage;
      }) => Promise<void>;
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
    const workspaceId = options.scope?.workspaceId ?? testEntityId('ws', `workspace_${label}`);
    const threadId = options.scope?.threadId ?? testEntityId('th', `thread_${label}`);
    const agentSessionId = options.scope?.agentSessionId ?? testEntityId('as', `as_${label}`);
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
      fileAdmission: new FileStorageAdmission(coreDb.dataRoot, () => 0n),
      ...(options.vaultBackend ? { vaultBackend: options.vaultBackend } : {}),
      ...(options.capacity === undefined
        ? {}
        : {
            readRuntimeConfig: () =>
              createInMemoryRuntimeConfigSnapshot({
                dataRoot: coreDb.dataRoot,
                openKitConfig: { nanohost: { maxActiveTurnsPerSandbox: options.capacity! } },
                workspaceConfigs: loadRuntimeConfig(coreDb.dataRoot).workspaceConfigs,
              }),
          }),
      env: {},
      nanoHostSessionDispatch: sessionDispatch,
      workerControlGateway: new WorkerControlGateway(),
    });
    const backend = (
      runtime.turnExecutor as unknown as {
        readonly backend: WorkerGovernanceBackend & {
          bindNativeHandleRecorder(
            snapshotId: string,
            recorder: (digest: string) => void | Promise<void>
          ): Promise<void>;
          inspectTerminalHarnessSession(session: unknown): Promise<void>;
          readonly sessions: Map<string, unknown>;
        };
      }
    ).backend;
    const environmentPackage = completeNanoHostPackage({
      agentSetup: options.agentSetup,
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
        turnId: options.scope?.turnId ?? testEntityId('tu', `turn_${label}`),
        workspaceId,
      },
      snapshotId: `snapshot_${label}`,
    });
    await authorizeNanoHostPackage(coreDb, environmentPackage);
    await options.configurePackage?.(environmentPackage, coreDb);
    bindNanoHostWorkerLineage(coreDb, environmentPackage, {
      attemptId: options.attemptId ?? testEntityId('attempt', `lease_${label}`),
      sandboxBindingRef: `sandbox-binding:${label}`,
    });
    await anchorNanoHostMaterialization(coreDb, backend, environmentPackage);
    const materialization = await backend
      .materialize(environmentPackage, {
        dataRoot: coreDb.dataRoot,
        workspaceRoots: [],
        sandboxBindingRef: factoryPackageBinding(coreDb, environmentPackage),
      })
      .catch((error) => {
        coreDb.sqlite.close();
        throw error;
      });
    await new FsStore({ dataRoot: coreDb.dataRoot }).updateAgentSession(agentSessionId, {
      retainedStorage: materialization.retainedStorage!,
    });
    const recordedDigests: string[] = [];
    await backend.bindNativeHandleRecorder(environmentPackage.snapshotId, (digest) => {
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
      operation:
        | 'session.open'
        | 'turn.start'
        | 'session.inspect'
        | 'session.close'
        | 'harness.drain'
        | 'turn.interrupt',
      body: Readonly<Record<string, unknown>>
    ) => {
      const queued = Promise.withResolvers<void>();
      const queue = harnessRecords.queueNanoHostHarnessOperation;
      const observation = vi
        .spyOn(harnessRecords, 'queueNanoHostHarnessOperation')
        .mockImplementation((...args) => {
          const sequence = queue(...args);
          if (args[0] === coreDb) queued.resolve();
          return sequence;
        });
      onTestFinished(() => observation.mockRestore());
      let command: ReturnType<typeof dispatchNanoHostHarnessOperation> = null;
      try {
        command = dispatchNanoHostHarnessOperation(coreDb, {
          sandboxIntegrationBindingRef: integrationRef(),
        });
        if (!command) {
          await queued.promise;
          command = dispatchNanoHostHarnessOperation(coreDb, {
            sandboxIntegrationBindingRef: integrationRef(),
          });
        }
      } finally {
        observation.mockRestore();
      }
      if (!command || command.operation !== operation) {
        throw new Error(
          `Expected queued ${operation} Harness command, received ${command?.operation ?? 'none'}.`
        );
      }
      await runtime.acceptNanoHostHarnessCommand(command);
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
      await runtime.acceptNanoHostHarnessResult(result);
      return command;
    };
    const launch = submitTestNanoHostTurn(coreDb, backend, materialization);
    const initialOpen = await settleNext('session.open', {
      ...(options.gitBaseline ? { workspaceGitBaseline: options.gitBaseline } : {}),
      maxActiveTurns: options.capacity ?? 20,
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
    await options.beforeFinalStatus?.({ coreDb, environmentPackage });
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

    await closeFactoryAttempt(
      coreDb,
      options.attemptId ?? testEntityId('attempt', `lease_${label}`),
      null,
      backend
    );
    expect(
      coreDb.sqlite
        .prepare(
          `SELECT agent_session_id AS agentSessionId, native_handle_digest AS digest
           FROM agent_session_runtime_bindings`
        )
        .all()
    ).toEqual([{ agentSessionId, digest: readyDigest }]);
    return {
      runtime,
      backend,
      coreDb,
      environmentPackage,
      readyDigest,
      settleNext,
      session: capturedSession,
      effects,
    };
  }

  it('refuses a Worker image without the declared retained Thread root before Sandbox creation', async () => {
    const coreDb = createFactoryCoreDb();
    const effects: NanoHostSessionEffectRequest[] = [];
    const fixed = createFactoryNanoHostDispatch(effects);
    const dispatch: NanoHostSessionDispatch = {
      ...fixed,
      async effect(requestOrConnection: object, carriedRequest?: NanoHostSessionEffectRequest) {
        const request = carriedRequest ?? (requestOrConnection as NanoHostSessionEffectRequest);
        const result = await fixed.effect(request);
        if (request.kind !== 'image.inspect') return result;
        const facts = nanoHostImageInspection(request);
        return {
          ...facts,
          storageLayout: {
            ...facts.storageLayout,
            targets: facts.storageLayout.targets.filter(
              (target) => target.target !== '/openkit/threads'
            ),
          },
        };
      },
    };
    try {
      coreDb.sqlite
        .prepare(`INSERT INTO nanohost_runtime_targets (target_id, identity_id, deployment_id,
        connection_generation, predecessor_fenced, ready, fresh_empty, physical_epoch, observed_at, slot_count)
        VALUES ('target_thread_root', 'identity_thread_root', 'deployment_thread_root', 1, 1, 1, 1, ?, ?, 1)`)
        .run('a'.repeat(64), new Date().toISOString());
      const runtime = createConfiguredWorkerLifecycleRuntime({
        coreDb,
        env: {},
        nanoHostSessionDispatch: dispatch,
        workerControlGateway: new WorkerControlGateway(),
      });
      const backend = (runtime.turnExecutor as unknown as { backend: WorkerGovernanceBackend })
        .backend;
      const environmentPackage = completeNanoHostPackage({
        scope: {},
        snapshotId: 'snapshot_thread_root',
      });
      await authorizeNanoHostPackage(coreDb, environmentPackage);
      bindNanoHostWorkerLineage(coreDb, environmentPackage, {
        attemptId: testEntityId('attempt', 'lease_thread_root'),
        sandboxBindingRef: 'binding_thread_root',
      });
      await anchorNanoHostMaterialization(coreDb, backend, environmentPackage);
      await expect(
        backend.materialize(environmentPackage, {
          workspaceRoots: [],
          sandboxBindingRef: 'binding_thread_root',
        })
      ).rejects.toThrow('retained /openkit/threads');
      expect(effects.map((effect) => effect.kind)).toEqual(['image.acquire', 'image.inspect']);
      await backend.cleanupSession(backend.planSession(environmentPackage));
      expect(effects.map((effect) => effect.kind)).toEqual(['image.acquire', 'image.inspect']);
      expect(
        coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM sandbox_runtime_records').get()
      ).toEqual({ count: 0 });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it.each([
    { authored: undefined, bound: 20 },
    { authored: 8, bound: 8 },
  ])('shares one Core Harness at the exact authored/default bound $bound and preserves command and release owners', async ({
    authored,
    bound,
  }) => {
    const coreDb = createFactoryCoreDb();
    const dataRoot = coreDb.dataRoot;
    const ownerUserId = ensureLocalUser(coreDb);
    const store = await createDemoStore({ dataRoot });
    const workspaceId = DEMO_WORKSPACE_ID;
    recordWorkspaceOwnerMembership({ coreDb, workspaceId, ownerUserId });
    const threadIds = Array.from({ length: bound }, (_, i) =>
      testEntityId('th', `bound_${bound}_${i}`)
    );
    for (const id of threadIds) await store.createThread(workspaceId, 'Bound cohort', id);
    const manifest = createTestAgentSetup({
      imageRef: `sha256:${'a'.repeat(64)}`,
      requiredCapabilities: ['trusted-worker-inference-relay'],
    }).manifest;
    admitTestNativeEnvironment(coreDb, manifest);
    const readRuntimeConfig = () => {
      const config = loadRuntimeConfig(dataRoot);
      return createInMemoryRuntimeConfigSnapshot({
        ...config,
        ...(authored === undefined
          ? {}
          : {
              openKitConfig: {
                ...config.openKitConfig,
                nanohost: { ...config.openKitConfig.nanohost, maxActiveTurnsPerSandbox: authored },
              },
            }),
        agentManifests: [manifest],
        gatewayConfig: createTestGatewayConfig(),
        providerRegistry: new ProviderRegistry([
          {
            id: 'agent-openrouter',
            displayName: 'Bound fixture',
            kind: 'local',
            models: ['openai/gpt-5.2'],
          },
        ]),
      });
    };
    const native = createNativeTaskAdmissionFixture(coreDb, store, { readRuntimeConfig });
    const backend = native.executor.executionBackend as WorkerGovernanceBackend;
    const cohort: Array<Awaited<ReturnType<typeof native.admitTurn>>> = [];
    const joins: Promise<unknown>[] = [];
    const commands: harnessRecords.NanoHostHarnessCommand[] = [];
    const results: Parameters<typeof native.runtime.acceptNanoHostHarnessResult>[0][] = [];
    const supplied = new Map<string, AgentEnvironmentPackage>();
    const firstCleanup = Promise.withResolvers<void>(),
      continueFirst = Promise.withResolvers<void>();
    const firstReleasing = Promise.withResolvers<void>(),
      releaseFirst = Promise.withResolvers<void>();
    const releaseSiblings = Promise.withResolvers<void>();
    let siblingsReleasing = Promise.withResolvers<void>();
    const lastReleasing = Promise.withResolvers<void>();
    let siblingReleaseAttemptId: string | null = null;
    const heldReleases = new Set<string>();
    let holdSiblings = false;
    let firstProof: Parameters<typeof backend.release>[0]['proof'] | undefined;
    let proofFault: { mockRestore(): void } | undefined;
    const materialize = backend.materialize.bind(backend);
    const materializations = vi
      .spyOn(backend, 'materialize')
      .mockImplementation(async (pkg, ...args) => {
        supplied.set(pkg.snapshotId, pkg);
        return materialize(pkg, ...args);
      });
    const accept = native.runtime.acceptNanoHostHarnessCommand;
    const sent = vi
      .spyOn(native.runtime, 'acceptNanoHostHarnessCommand')
      .mockImplementation(async (command) => {
        // Worker Control: the preceding exact result settles before this Harness dispatches again.
        expect(results.at(-1)?.operationId).toBe(commands.at(-1)?.operationId);
        if (commands.length) expect(command.sequence).toBe(commands.at(-1)!.sequence + 1);
        const wire = await accept(command);
        const {
          agentSessionId,
          agentSessionRuntimeBindingId,
          turnId,
          leaseId,
          packageSnapshotId,
          maxActiveTurns,
        } = wire.body;
        commands.push({
          ...wire,
          body: {
            agentSessionId,
            agentSessionRuntimeBindingId,
            turnId,
            leaseId,
            packageSnapshotId,
            maxActiveTurns,
          },
        });
        return wire;
      });
    const acceptResult = native.runtime.acceptNanoHostHarnessResult;
    const received = vi
      .spyOn(native.runtime, 'acceptNanoHostHarnessResult')
      .mockImplementation(async (result) => {
        expect(result).toMatchObject({
          harnessInstanceId: commands.at(-1)!.harnessInstanceId,
          operationId: commands.at(-1)!.operationId,
          sequence: commands.at(-1)!.sequence,
        });
        await acceptResult(result);
        results.push(result);
      });
    const cleanup = backend.cleanupSession.bind(backend);
    const cleanups = vi
      .spyOn(backend, 'cleanupSession')
      .mockImplementation(async (identity, ...args) => {
        if (!holdSiblings && identity.packageSnapshotId === cohort[0]?.pkg.snapshotId) {
          firstCleanup.resolve();
          await continueFirst.promise;
        }
        return cleanup(identity, ...args);
      });
    // Chain the fixture's existing real release observer; never change a held correlation.
    const release = vi.mocked(backend.release);
    const actualRelease = release.getMockImplementation()!;
    release.mockImplementation(async (input) => {
      if (input.attemptId === cohort[0]?.attempt.attemptId) {
        firstProof = input.proof;
        firstReleasing.resolve();
        await releaseFirst.promise;
      } else if (holdSiblings) {
        heldReleases.add(input.attemptId);
        if (input.attemptId === siblingReleaseAttemptId) siblingsReleasing.resolve();
        if (heldReleases.size === bound - 1) lastReleasing.resolve();
        await releaseSiblings.promise;
      }
      return actualRelease(input);
    });
    /** Publishes ordinary work with the first binding's actual, currently revisioned association. */
    const entryFor = async (index: number, thread = index) => {
      const attemptId = testEntityId('attempt', `bound_${bound}_${index}`);
      const agentSessionId = testEntityId('as', `bound_${bound}_${index}`);
      const storage = cohort.length
        ? getWorkerStorageBinding(
            coreDb,
            store.getAgentSession(cohort[0]!.pkg.scope.agentSessionId).retainedStorage!
          )
        : null;
      const entry = createSchedulerAdmissionEntry(coreDb, {
        backendId: 'nanohost',
        queueEntryId: `queue:${attemptId}`,
        requestId: testEntityId('tu', `bound_request_${bound}_${index}`).slice(3),
        requestedAgentId: manifest.id,
        workspaceId,
        threadId: threadIds[thread]!,
        turnId: testEntityId('tu', `bound_${bound}_${index}`),
        turnInput: `Bound ${bound} Turn ${index}`,
        triggerActor: { kind: 'user', id: ownerUserId },
        ...(storage
          ? {
              workerStorageChoice: {
                kind: 'selected',
                storageRef: storage.storageRef,
                expectedRevision: storage.revision,
                purpose: 'work',
                goalId: null,
                taskId: null,
              } as const,
            }
          : {}),
      });
      await publishFactoryAdmission(store, entry);
      return { entry, attemptId, agentSessionId, candidateAgentSessionId: agentSessionId };
    };
    const occupancy = () =>
      coreDb.sqlite
        .prepare(
          'SELECT COUNT(*) AS count, SUM(active_turn_count) AS active FROM harness_instance_records'
        )
        .get();
    const physicalEffects = () =>
      native.effects.filter((e) => e.kind === 'bridge.close' || e.kind === 'sandbox.delete');
    try {
      for (let index = 0; index < bound; index += 1) {
        const input = await entryFor(index);
        const admitted = await native.admitTurn(input.entry, input);
        cohort.push(admitted);
        expect(
          commands.find((c) => c.operation === 'turn.start' && c.body.turnId === input.entry.turnId)
            ?.body
        ).toMatchObject({
          agentSessionId: input.agentSessionId,
          leaseId: input.attemptId,
          packageSnapshotId: admitted.pkg.snapshotId,
        });
        expect(
          backend.readThreadAgentSessionBinding?.({ workspaceId, threadId: input.entry.threadId })
        ).toMatchObject({ agentSessionId: input.agentSessionId });
      }
      const first = cohort[0]!,
        last = cohort.at(-1)!;
      expect(occupancy()).toEqual({ count: 1, active: bound });
      expect(
        coreDb.sqlite
          .prepare(
            'SELECT COUNT(*) AS count, MAX(max_active_turns) AS capacity FROM sandbox_runtime_records'
          )
          .get()
      ).toEqual({ count: 1, capacity: bound });
      expect(
        coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM agent_session_runtime_bindings').get()
      ).toEqual({ count: bound });
      expect(
        new Set(
          commands
            .filter((c) => c.operation === 'session.open')
            .map((c) => c.body.agentSessionRuntimeBindingId)
        ).size
      ).toBe(bound);
      expect(new Set(cohort.map((c) => c.pkg.control.transcript?.root)).size).toBe(bound);
      expect(native.effects.filter((e) => e.kind === 'sandbox.create')).toHaveLength(1);
      for (const open of commands.filter((c) => c.operation === 'session.open')) {
        expect(open.body.maxActiveTurns).toBe(bound);
        expect(results.find((r) => r.operationId === open.operationId)?.body).toMatchObject({
          maxActiveTurns: bound,
        });
      }
      expect(await backend.inspectMaterializationCapacity?.(first.pkg)).toBe('capacity-saturated');
      // Deliberate missed-observation fault after real acceptance; restore its exact prior facts.
      const inspected = cohort[1]!.attempt;
      const originalState = getWorkerBackendSession(coreDb, inspected.attemptId)!.state;
      coreDb.sqlite
        .prepare("UPDATE worker_backend_sessions SET state = 'launching' WHERE attempt_id = ?")
        .run(inspected.attemptId);
      coreDb.sqlite
        .prepare(
          "UPDATE scheduler_execution_attempts SET disposition = 'unknown' WHERE attempt_id = ?"
        )
        .run(inspected.attemptId);
      try {
        expect(await backend.inspect!(schedulerExecutionCorrelation(inspected))).toMatchObject({
          disposition: 'accepted',
          execution: 'running',
        });
      } finally {
        coreDb.sqlite
          .prepare('UPDATE worker_backend_sessions SET state = ? WHERE attempt_id = ?')
          .run(originalState, inspected.attemptId);
        coreDb.sqlite
          .prepare('UPDATE scheduler_execution_attempts SET disposition = ? WHERE attempt_id = ?')
          .run(inspected.disposition, inspected.attemptId);
      }
      const firstFinished = first.complete();
      joins.push(firstFinished);
      void firstFinished.catch(() => undefined);
      const firstClosed = firstFinished.then(() => {
        throw new Error('Native first Turn completed before its held closeout gate.');
      });
      await Promise.race([firstCleanup.promise, firstClosed]);
      const livePackage = supplied.get(first.pkg.snapshotId)!;
      const transcript = livePackage.control.transcript!;
      const beforeExports = native.effects.filter((e) => e.kind === 'file.export').length;
      livePackage.control.transcript = {
        ...transcript,
        eventsPath: `${workerSessionInputPaths(first.pkg.scope.agentSessionId).root}/outputs/events.jsonl`,
      };
      try {
        await expect(backend.collectTranscript!(first.pkg.snapshotId, true)).rejects.toThrow(
          'Turn capture'
        );
      } finally {
        livePackage.control.transcript = transcript;
      }
      expect(native.effects.filter((e) => e.kind === 'file.export')).toHaveLength(beforeExports);
      continueFirst.resolve();
      await Promise.race([firstReleasing.promise, firstClosed]);
      expect(firstProof).toMatchObject({
        terminalHandoff: true,
        output: true,
        evidence: true,
        outsideWorkspaceCollection: true,
        integrationDrain: true,
        routesRevoked: true,
      });
      expect(getWorkerBackendSession(coreDb, first.attempt.attemptId)!.state).toBe('cleaned');
      expect(
        attempts.requireSchedulerExecutionAttempt(coreDb, first.attempt.attemptId)
      ).toMatchObject({ phase: 'closing', fenceRef: null });
      expect(occupancy()).toEqual({ count: 1, active: bound - 1 });
      expect(await backend.inspectMaterializationCapacity?.(first.pkg)).toBe('capacity-saturated');
      releaseFirst.resolve();
      await firstFinished;
      expect(
        attempts.requireSchedulerExecutionAttempt(coreDb, first.attempt.attemptId)
      ).toMatchObject({ phase: 'closed', fenceRef: expect.any(String) });
      expect(await backend.inspectMaterializationCapacity?.(first.pkg)).toBe('available');
      const completed = store.getTurnById(first.pkg.scope.turnId);
      const resident = store.getAgentSession(first.pkg.scope.agentSessionId);
      const residentRows = coreDb.sqlite
        .prepare(
          'SELECT lifecycle_state, health_state, drain_state, cleanup_state FROM sandbox_runtime_records'
        )
        .all();
      const incoming = await entryFor(bound, 0);
      const refusal = new Error('Controlled pre-submit refusal.');
      const incomingFailure = native.executionFor(incoming.entry.turnId).execution.then(
        () => null,
        (error: unknown) => error
      );
      let faultEffects = -1;
      const beforeIncoming = commands.length;
      const prepareFault = vi.spyOn(backend, 'prepareLaunch').mockImplementation(async () => {
        faultEffects = native.effects.length;
        throw refusal;
      });
      try {
        await expect(
          native.admitTurn(incoming.entry, { ...incoming, agentSessionId: resident.id })
        ).rejects.toBe(refusal);
      } finally {
        prepareFault.mockRestore();
      }
      expect(faultEffects).toBeGreaterThanOrEqual(0);
      expect(await incomingFailure).toBe(refusal);
      expect(native.effects).toHaveLength(faultEffects);
      expect(commands).toHaveLength(beforeIncoming);
      expect(store.getTurnById(completed.id)).toEqual(completed);
      expect(store.getAgentSession(resident.id)).toMatchObject({
        id: resident.id,
        status: 'idle',
        nativeHandleDigest: resident.nativeHandleDigest,
        retainedStorage: resident.retainedStorage,
      });
      expect(
        coreDb.sqlite
          .prepare(
            'SELECT lifecycle_state, health_state, drain_state, cleanup_state FROM sandbox_runtime_records'
          )
          .all()
      ).toEqual(residentRows);
      expect(attempts.requireSchedulerExecutionAttempt(coreDb, incoming.attemptId)).toMatchObject({
        phase: 'closed',
        disposition: 'not_accepted',
        operationId: null,
        deadline: null,
      });
      expect(occupancy()).toEqual({ count: 1, active: bound - 1 });
      expect(physicalEffects()).toEqual([]);

      holdSiblings = true;
      // Stage Main collection without releasing any original closeout or reducing peak occupancy.
      for (const admitted of cohort.slice(1, -1)) {
        siblingReleaseAttemptId = admitted.attempt.attemptId;
        siblingsReleasing = Promise.withResolvers<void>();
        const joined = admitted.complete();
        joins.push(joined);
        void joined.catch(() => undefined);
        await Promise.race([
          siblingsReleasing.promise,
          joined.then(() => {
            throw new Error('Native sibling completed before its held release observation.');
          }),
        ]);
      }
      siblingReleaseAttemptId = null;
      const siblingsClosed = Promise.all(joins).then(() => {
        throw new Error('Native siblings completed before their held release observations.');
      });
      await Promise.race([siblingsReleasing.promise, siblingsClosed]);
      expect(heldReleases.size).toBe(bound - 2);
      // Every ordinary final and canonical publication is acknowledged before global peer faults.
      for (const admitted of cohort.slice(0, -1))
        expect(store.getTurnById(admitted.pkg.scope.turnId).status).toBe('completed');
      expect(occupancy()).toEqual({ count: 1, active: 1 });
      const proofs = cohort.map((c) => store.getAgentSession(c.pkg.scope.agentSessionId));
      const record = native.executor.recordNativeHandleDigest.bind(native.executor);
      let refusedProof = false;
      proofFault = vi
        .spyOn(native.executor, 'recordNativeHandleDigest')
        .mockImplementation(async (...args) => {
          if (args[1] === resident.id) {
            refusedProof = true;
            throw new Error('Controlled native proof handoff refusal.');
          }
          return record(...args);
        });
      native.peerFaults.failedFinal = true;
      native.peerFaults.failFileExport = true;
      native.peerFaults.closeRefusal = 'cleanup_required';
      const lastFinished = last.complete();
      joins.push(lastFinished);
      void lastFinished.catch(() => undefined);
      await expect(lastFinished).rejects.toThrow();
      expect(refusedProof).toBe(true);
      expect(native.peerFaults.failedExportPaths.length).toBeGreaterThan(0);
      const close = commands.find(
        (c) =>
          c.operation === 'session.close' && c.body.agentSessionId === last.pkg.scope.agentSessionId
      )!;
      expect(results.find((r) => r.operationId === close.operationId)).toMatchObject({
        disposition: 'refused',
        body: { reasonCode: 'cleanup_required' },
      });
      expect(physicalEffects().map((e) => e.kind)).toEqual(['bridge.close', 'sandbox.delete']);
      expect(
        coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM agent_session_runtime_bindings').get()
      ).toEqual({ count: bound });
      for (const proof of proofs)
        expect(store.getAgentSession(proof.id)).toMatchObject({
          nativeHandleDigest: proof.nativeHandleDigest,
          retainedStorage: proof.retainedStorage,
        });
      expect(
        attempts.requireSchedulerExecutionAttempt(coreDb, last.attempt.attemptId)
      ).toMatchObject({ phase: 'closing', fenceRef: null });
      expect(await backend.inspectMaterializationCapacity?.(last.pkg)).toBe('capacity-saturated');
      const failed = store.getTurnById(last.pkg.scope.turnId);
      expect(failed.status).toBe('failed');
      proofFault.mockRestore();
      proofFault = undefined;
      native.peerFaults.failedFinal = false;
      native.peerFaults.closeRefusal = undefined;
      // Keep export loss truthful after deletion; recovery finalizes absence, never fabricates bytes.
      await native.runtime.reconcileAcceptedFinalStatus(
        getWorkerBackendSession(coreDb, last.attempt.attemptId)!
      );
      expect(getWorkerBackendSession(coreDb, last.attempt.attemptId)!.state).toBe('cleaned');
      expect(
        coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM sandbox_runtime_records').get()
      ).toEqual({ count: 0 });
      expect(await backend.inspectMaterializationCapacity?.(last.pkg)).toBe('capacity-saturated');
      const recovered = native.runtime.reconcileAcceptedFinalStatus(
        getWorkerBackendSession(coreDb, last.attempt.attemptId)!
      );
      joins.push(recovered);
      void recovered.catch(() => undefined);
      await Promise.race([
        lastReleasing.promise,
        recovered.then(() => {
          throw new Error('Native recovery completed before its held release observation.');
        }),
      ]);
      expect(heldReleases.has(last.attempt.attemptId)).toBe(true);
      expect(physicalEffects().map((e) => e.kind)).toEqual(['bridge.close', 'sandbox.delete']);
      releaseSiblings.resolve();
      await recovered;
      await Promise.all(joins.filter((joined) => joined !== lastFinished));
      for (const admitted of cohort) {
        expect(store.getTurnById(admitted.pkg.scope.turnId).status).toBe(
          admitted === last ? 'failed' : 'completed'
        );
        expect(
          attempts.requireSchedulerExecutionAttempt(coreDb, admitted.attempt.attemptId)
        ).toMatchObject({ phase: 'closed', fenceRef: expect.any(String) });
        expect(native.executor.releaseResults).toContainEqual(
          expect.objectContaining({
            attemptId: admitted.attempt.attemptId,
            inputRef: admitted.pkg.snapshotId,
            state: 'released',
          })
        );
      }
      expect(store.getTurnById(failed.id).error).toEqual(failed.error);
      expect(physicalEffects().map((e) => e.kind)).toEqual(['bridge.close', 'sandbox.delete']);
      expect(await backend.inspectMaterializationCapacity?.(last.pkg)).toBe('available');
      expect(results).toHaveLength(commands.length);
      expect(new Set(commands.map((c) => c.harnessInstanceId)).size).toBe(1);
      expect(commands.filter((c) => c.operation === 'turn.start')).toHaveLength(bound);
    } finally {
      continueFirst.resolve();
      releaseFirst.resolve();
      releaseSiblings.resolve();
      proofFault?.mockRestore();
      native.peerFaults.failedFinal = false;
      native.peerFaults.failFileExport = false;
      native.peerFaults.closeRefusal = undefined;
      await Promise.allSettled([...joins, ...cohort.map((c) => c.cleanup())]);
      release.mockImplementation(actualRelease);
      cleanups.mockRestore();
      materializations.mockRestore();
      sent.mockRestore();
      received.mockRestore();
      await native.restore();
      await shutdownControlStoreWorkerClient();
      coreDb.sqlite.close();
    }
  }, 180_000);

  it('plans a new physical Sandbox identity when encoded-slash authority changes', async () => {
    const f = await admitIdleSupplyResident('encoding_identity');
    try {
      const packageFor = (allowEncodedSlash?: boolean) =>
        completeNanoHostPackage({
          scope: f.environmentPackage.scope,
          snapshotId: 'snapshot_encoding_comparison',
          agentSetup: createTestAgentSetup({
            network: WorkerSandboxAccessSchema.parse({
              network: [
                {
                  id: 'package-read',
                  host: 'packages.example.com',
                  port: 443,
                  protocol: 'rest',
                  access: 'read-only',
                  purpose: 'Read packages.',
                  binaries: ['/usr/local/bin/node'],
                  ...(allowEncodedSlash === undefined ? {} : { allowEncodedSlash }),
                },
              ],
            }).network,
          }),
        });
      const omitted = packageFor();
      const before = JSON.stringify(omitted);
      const nativeIdentity = (pkg: AgentEnvironmentPackage) =>
        f.backend.planSession(pkg).backendSessionId;
      expect(nativeIdentity(packageFor(true))).not.toBe(nativeIdentity(packageFor(false)));
      expect(nativeIdentity(packageFor(true))).not.toBe(nativeIdentity(omitted));
      expect(JSON.stringify(omitted)).toBe(before);
    } finally {
      f.coreDb.sqlite.close();
    }
  });

  it('rejects a selected Skill corrupted after preview before materialization eviction or effects', async () => {
    const coreDb = createFactoryCoreDb();
    const dataRoot = coreDb.dataRoot;
    const ownerUserId = ensureLocalUser(coreDb);
    const store = await createDemoStore({ dataRoot });
    const workspaceDb = openWorkspaceDb(dataRoot, DEMO_WORKSPACE_ID);
    const workspaceId = DEMO_WORKSPACE_ID;
    const threadId = DEMO_THREAD_ID;
    recordWorkspaceOwnerMembership({ coreDb, ownerUserId, workspaceId });
    let manifest = createTestAgentSetup({
      imageRef: `sha256:${'a'.repeat(64)}`,
      requiredCapabilities: ['trusted-worker-inference-relay'],
    }).manifest;
    const configuration = createInMemoryRuntimeConfigSnapshot({
      ...loadRuntimeConfig(dataRoot),
      gatewayConfig: createTestGatewayConfig(),
      providerRegistry: new ProviderRegistry([
        {
          id: 'agent-openrouter',
          displayName: 'Skill fixture',
          kind: 'local',
          models: ['openai/gpt-5.2'],
        },
      ]),
    });
    const native = createNativeTaskAdmissionFixture(coreDb, store, {
      readRuntimeConfig: () => ({ ...configuration, agentManifests: [manifest] }),
    });
    const commands = vi.spyOn(native.runtime, 'acceptNanoHostHarnessCommand');
    const registration = vi.spyOn(native.workerControlGateway, 'registerSession');
    const agentSessionId = testEntityId('as', 'as_skill_pre_effect');
    let resident: ReturnType<FsStore['getAgentSession']> | undefined;
    let storage: ReturnType<typeof listWorkerStorageBindings> = [];
    let originalTurn: ReturnType<FsStore['getTurnById']> | undefined;
    let history: ReturnType<typeof requireAgentEnvironmentPackageSnapshot> | undefined;
    const storageScope = { workspaceId, authorizeContributor: () => true };
    try {
      for (const label of ['resident', 'corrupt', 'reuse']) {
        manifest = { ...manifest, skills: label === 'corrupt' ? [{ id: 'repo-guidelines' }] : [] };
        const attemptId = testEntityId('attempt', `skill_pre_effect_${label}`);
        const turnId = testEntityId('tu', `skill_pre_effect_${label}`);
        const entry = createSchedulerAdmissionEntry(coreDb, {
          backendId: 'nanohost',
          queueEntryId: `queue:${attemptId}`,
          requestId: testEntityId('tu', `request_skill_pre_effect_${label}`).slice(3),
          requestedAgentId: manifest.id,
          workspaceId,
          threadId,
          turnId,
          turnInput: 'Use selected Skill',
          triggerActor: { kind: 'user', id: ownerUserId },
        });
        await publishFactoryAdmission(store, entry);
        const admission = {
          attemptId,
          agentSessionId,
          candidateAgentSessionId: testEntityId('as', `skill_pre_effect_${label}`),
        };
        if (label === 'resident') admission.candidateAgentSessionId = agentSessionId;
        if (label === 'corrupt') {
          const { version } = importWorkspaceSkill({
            activate: true,
            createdAt: '2026-10-17T00:00:00.000Z',
            dataRoot,
            displayName: 'Repo guidelines',
            expectedRevision: 0,
            producer: entry.triggerActor,
            tree: [
              {
                kind: 'file',
                path: 'SKILL.md',
                contentBase64: Buffer.from(
                  '---\nname: repo-guidelines\ndescription: Repository guidance.\n---\nRead this Skill.\n'
                ).toString('base64'),
              },
            ],
            workspaceId,
          });
          const snapshot = skillSnapshotPath(
            dataRoot,
            workspaceId,
            'repo-guidelines',
            version.digest
          );
          const corruptContent = 'corrupt after preview: private-skill-content-r570';
          let previewed = false;
          let beforeEffects = native.effects.length;
          const prepare = native.executor.prepareAgentSessionForTurn!.bind(native.executor);
          const postPreviewCorruption = vi
            .spyOn(native.executor, 'prepareAgentSessionForTurn')
            .mockImplementation(async (...args) => {
              const preview = await prepare(...args);
              expect(preview.replacementRequired).toBe(true);
              expect(preview.currentAgentSession?.id).toBe(resident!.id);
              previewed = true;
              beforeEffects = native.effects.length;
              commands.mockClear();
              registration.mockClear();
              writeFileSync(join(snapshot, 'SKILL.md'), corruptContent);
              return preview;
            });
          try {
            await expect(native.admitTurn(entry, admission)).rejects.toThrow();
          } finally {
            postPreviewCorruption.mockRestore();
          }
          expect(previewed).toBe(true);
          const failed = store.getTurnById(turnId);
          expect(failed).toMatchObject({
            status: 'failed',
            error: { code: 'worker_preparation_failed' },
          });
          expect(failed.error?.message).toMatch(/Skill|snapshot|integrity|digest|inventory/i);
          const publicFailure = JSON.stringify(failed.error);
          for (const privateValue of [dataRoot, snapshot, corruptContent])
            expect(publicFailure.includes(privateValue)).toBe(false);
          expect(native.effects.slice(beforeEffects).map((effect) => effect.kind)).toEqual([]);
          expect(commands.mock.calls.length).toBe(0);
          expect(registration.mock.calls.length).toBe(0);
          expect(native.executor.inputs).toEqual(['Use selected Skill']);
          const {
            updatedAt: _observation,
            message: _message,
            sandboxSummary: _summary,
            ...authority
          } = resident!;
          expect(store.getAgentSession(agentSessionId)).toMatchObject(authority);
          expect(listWorkerStorageBindings(coreDb, storageScope)).toEqual(
            storage.map((binding) => ({ ...binding, updatedAt: expect.any(String) }))
          );
          expect(store.getTurnById(originalTurn!.id)).toEqual(originalTurn);
          expect(
            requireAgentEnvironmentPackageSnapshot(workspaceDb, workspaceId, history!.snapshotId)
          ).toEqual(history);
          expect(
            store
              .listThreadAgentSessions(workspaceId, threadId)
              .filter((session) => isCurrentAgentSessionStatus(session.status))
              .map((session) => session.id)
          ).toEqual([agentSessionId]);
          continue;
        }
        const admitted = await native.admitTurn(entry, admission);
        try {
          await admitted.complete();
          expect(store.getTurnById(turnId)).toMatchObject({ status: 'completed', agentSessionId });
          if (label === 'resident') {
            resident = structuredClone(store.getAgentSession(agentSessionId));
            originalTurn = structuredClone(store.getTurnById(turnId));
            history = requireAgentEnvironmentPackageSnapshot(
              workspaceDb,
              workspaceId,
              admitted.pkg.snapshotId
            );
            expect(resident).toMatchObject({
              status: 'idle',
              nativeHandleDigest: expect.any(String),
              retainedStorage: expect.any(Object),
            });
            storage = listWorkerStorageBindings(coreDb, storageScope);
            expect(storage.length).toBeGreaterThan(0);
          } else {
            expect(store.getAgentSession(agentSessionId)).toMatchObject({
              status: 'idle',
              id: resident!.id,
            });
            expect(
              commands.mock.calls.filter(([command]) => command.operation === 'session.open').length
            ).toBe(0);
          }
        } finally {
          await admitted.cleanup();
        }
      }
    } finally {
      commands.mockRestore();
      registration.mockRestore();
      await native.restore();
      workspaceDb.sqlite.close();
      await shutdownControlStoreWorkerClient();
      coreDb.sqlite.close();
    }
  });

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
      // This fixture crosses authored admission, resolution, native dispatch and the Rust SDK consumer.
      const authored = WorkerSandboxAccessSchema.parse({
        network: [
          {
            id: 'scoped-package-read',
            host: 'packages.example.com',
            port: 443,
            protocol: 'rest',
            access: 'read-only',
            allowEncodedSlash: true,
            purpose: 'Read scoped packages.',
            binaries: ['/usr/local/bin/node'],
          },
        ],
      });
      const resident = await admitIdleSupplyResident('producer_pin', {
        scope: {
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          threadId: 'th_00000000-0000-7000-8000-000000000001',
          agentSessionId: 'as_00000000-0000-7000-8000-000000000001',
          turnId: 'tu_00000000-0000-7000-8000-000000000001',
        },
        attemptId: 'attempt_00000000-0000-7000-8000-000000000001',
        agentSetup: createTestAgentSetup({ network: authored.network }),
        onExport,
        configurePackage: async (pkg, coreDb) => {
          pkg.scope.requestId = 'request_factory_fixture';
          pkg.runtime.image = registryImage;
          importWorkspaceSkill({
            activate: true,
            createdAt: '2026-10-17T00:00:00.000Z',
            dataRoot: coreDb.dataRoot,
            displayName: 'Repo guidelines',
            expectedRevision: 0,
            producer: pkg.scope.triggerActor,
            tree: [
              {
                kind: 'file',
                path: 'SKILL.md',
                contentBase64: Buffer.from(
                  '---\nname: repo-guidelines\ndescription: Repository guidance.\n---\nRun run.sh.\n'
                ).toString('base64'),
              },
              { kind: 'directory', path: 'empty-dir' },
              {
                kind: 'file',
                path: 'run.sh',
                executable: true,
                contentBase64: Buffer.from('#!/bin/sh\nprintf ready\n').toString('base64'),
              },
            ],
            workspaceId: pkg.scope.workspaceId,
          });
          pkg.supply = resolveAgentEnvironmentPackageMetadata({
            captureCoverage: { scope: 'server', value: 'off' },
            agentSetup: createTestAgentSetup({ skillIds: ['repo-guidelines'] }),
            agentSessionId: pkg.scope.agentSessionId,
            backend: { kind: 'openshell' },
            coreDb,
            createdAt: pkg.createdAt,
            requestId: pkg.scope.requestId,
            turn: await new FsStore({ dataRoot: coreDb.dataRoot }).createTurn(
              pkg.scope.workspaceId,
              pkg.scope.threadId,
              'Use retained fixture Skill',
              pkg.scope.triggerActor,
              null,
              { turnId: pkg.scope.turnId }
            ),
            triggerActor: pkg.scope.triggerActor,
            userId:
              pkg.scope.triggerActor.kind === 'user'
                ? pkg.scope.triggerActor.id
                : pkg.scope.triggerActor.responsibleUserId!,
            workspaceRoots: [],
          }).supply;
        },
      });
      residents.push(resident);
      resident.backend.sessions.set(resident.environmentPackage.snapshotId, resident.session);
      const collectionDb = openWorkspaceDb(
        resident.coreDb.dataRoot,
        resident.environmentPackage.scope.workspaceId
      );
      try {
        await resident.backend.collectTranscript(
          resident.environmentPackage.snapshotId,
          true,
          collectionDb
        );
      } finally {
        collectionDb.sqlite.close();
      }
      await resident.backend.collectWorkspaceChanges(resident.environmentPackage.snapshotId, true);
      expect(resident.environmentPackage.policy.network?.rules).toContainEqual(
        expect.objectContaining({ id: 'scoped-package-read', allowEncodedSlash: true })
      );
      const created = resident.effects.find((request) => request.kind === 'sandbox.create')!;
      expect(created.input.policyIntent).toMatchObject({
        additionalNetworkEndpoints: [
          {
            name: 'scoped_package_read',
            host: 'packages.example.com',
            port: 443,
            protocol: 'rest',
            access: 'read-only',
            allowEncodedSlash: true,
            binaries: ['/usr/local/bin/node'],
          },
        ],
      });
      // Wider retirement enters its existing durable drain before any physical contact.
      const cleanupAnchor = getWorkerBackendSession(
        resident.coreDb,
        String(created.input.leaseId)
      )!;
      harnessRecords.drainNanoHostSandboxAdmission(resident.coreDb, {
        sandboxBindingRef: cleanupAnchor.sandboxBindingRef,
        originPhysicalEpoch: cleanupAnchor.originPhysicalEpoch,
      });
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
      const coreDb = openCoreDb(join(root, 'dispatch'));
      pinCoreDb = coreDb;
      applyMigrations(coreDb);
      // Match the real preparation caller and the independent 3a provenance fixtures.
      const actor = { kind: 'user' as const, id: ensureLocalUser(coreDb) };
      const publicationStore = new FsStore({ dataRoot: coreDb.dataRoot });
      const publicationThread = await publicationStore.createServerThread(
        'Host producer fixture preparation',
        undefined,
        'conversation'
      );
      const publicationTurn = await publicationStore.createServerTurn(
        publicationThread.id,
        'Prepare the fixture images.',
        actor
      );
      expect(
        new FsStore({ dataRoot: coreDb.dataRoot }).getServerTurn(
          publicationThread.id,
          publicationTurn.id
        )
      ).toMatchObject({ id: publicationTurn.id, owner: { kind: 'server' }, triggerActor: actor });
      const candidate = {
        artifactId: testEntityId('ar', 'artifact_pin'),
        artifactVersion: 1,
        contentDigest: `sha256:${'c'.repeat(64)}`,
      };
      await preparation.prepareImage({
        actor,
        workId: publicationTurn.id,
        authorize: () => true,
        candidate,
        image: { kind: 'reference', pullPolicy: 'never', ref: `sha256:${'a'.repeat(64)}` },
      });
      await preparation.prepareImage({
        actor,
        workId: publicationTurn.id,
        authorize: () => true,
        candidate,
        image: buildImage,
      });
      await preparation.prepareImage({
        actor,
        workId: publicationTurn.id,
        authorize: () => true,
        candidate,
        image: registryImage,
      });
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
        const dispatch = createNanoHostSessionDispatch({
          coreDb,
          sessionAuthority: authority,
          fileAdmission: new FileStorageAdmission(coreDb.dataRoot, () => 0n),
        });
        await dispatch.readiness!(
          physical,
          Buffer.from(JSON.stringify({ physicalEpoch: 'a'.repeat(64) })),
          { ...target, coreDb }
        );
        // Project an already observed producer request; never re-run its completed private owner hooks.
        const {
          beforeDelivery: _delivery,
          consumeResult: _consumer,
          signal: _signal,
          ...transportRequest
        } = request;
        let dispatchFailure: unknown;
        void dispatch.effect(transportRequest).catch((error) => {
          dispatchFailure = error;
        });
        const command = await dispatch.poll(physical, request.kind);
        if (!command && dispatchFailure) throw dispatchFailure;
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
      const entityIds = new Map<string, string>();
      const entityCounts = new Map<string, number>();
      const normalized = JSON.parse(
        JSON.stringify(fixture, (key, value) => {
          if (typeof value === 'string' && key !== 'storageRef') {
            const kind = ENTITY_KINDS.find((candidate) => isEntityId(candidate, value));
            if (kind) {
              if (!entityIds.has(value)) {
                const ordinal = (entityCounts.get(kind) ?? 0) + 1;
                entityCounts.set(kind, ordinal);
                entityIds.set(
                  value,
                  `${kind}_00000000-0000-7000-8000-${ordinal.toString(16).padStart(12, '0')}`
                );
              }
              return entityIds.get(value);
            }
          }
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
            expect(value).toMatch(entityIdPattern('wst'));
            return 'wst_00000000-0000-7ac8-9f6c-13552db6aa87';
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
      expect(normalized).toContainEqual(
        expect.objectContaining({
          kind: 'reference.import',
          command: expect.objectContaining({ entryKind: 'directory', slot: 'worker-supply' }),
        })
      );
      expect(normalized).toContainEqual(
        expect.objectContaining({
          kind: 'reference.import',
          command: expect.objectContaining({
            entryKind: 'file',
            executable: true,
            slot: 'worker-supply',
          }),
        })
      );
    } finally {
      client?.destroy();
      if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
      pinCoreDb?.sqlite.close();
      for (const resident of residents) resident.coreDb.sqlite.close();
      rmSync(root, { recursive: true, force: true });
    }
    // Three resident Workspaces and the dispatch database exceed the default budget under contention.
  }, 60_000);

  // The runner covers real fixture setup and publication; product deadlines stay unchanged.
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
          .run('f'.repeat(64), testEntityId('attempt', `lease_live_evidence_${mode}`));
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
  }, 60_000);

  it.each([
    'retained',
    'missing',
    'committed',
    'oversized-cleanup',
  ] as const)('hands off only uncommitted accepted observation source (%s)', async (mode) => {
    const root = mkdtempSync(join(tmpdir(), 'openkit-observation-bridge-'));
    const bytes = Buffer.from('exact source');
    let metadata!: ReturnType<typeof WorkerCanonicalEventRecordSchema.parse>;
    let source = Buffer.alloc(0);
    let sourcePath = '';
    let serial = 0;
    const f = await admitIdleSupplyResident(`observation_bridge_${mode}`, {
      configurePackage: async (pkg, coreDb) => {
        pkg.observability.captureCoverage = { scope: 'server', value: 'on' };
        await new FsStore({ dataRoot: coreDb.dataRoot }).createTurn(
          pkg.scope.workspaceId,
          pkg.scope.threadId,
          'Capture exact observation',
          pkg.scope.triggerActor,
          null,
          {
            turnId: pkg.scope.turnId,
            agentId: pkg.agent.agentId,
            executorKind: 'worker',
            captureCoverage: { scope: 'server', value: 'on' },
          }
        );
      },
      beforeFinalStatus: async ({ coreDb, environmentPackage: pkg }) => {
        const { workspaceId, threadId, turnId, agentSessionId, requestId } = pkg.scope;
        const lineage = {
          workspaceId,
          threadId,
          turnId,
          agentSessionId,
          requestId,
          packageSnapshotId: pkg.snapshotId,
        };
        metadata = WorkerCanonicalEventRecordSchema.parse({
          schemaVersion: 1,
          kind: 'event',
          lineage,
          sequence: 0,
          event: {
            type: 'observation.recorded',
            data: {
              observationId: 'bridge-source',
              sourceRef: 'bridge-source',
              sourceSequence: 0,
              observedAt: pkg.createdAt,
              fact: {
                kind: 'assistant',
                runtimeOriginRef: null,
                phase: 'updated',
                messageRef: 'bridge-message',
                representation: 'delta',
              },
              content: {
                state: 'expected',
                mediaType: 'text/plain',
                boundary: 'assistant.text',
                bytes: bytes.length,
                chunkCount: 1,
                sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
              },
            },
          },
        });
        const chunk = WorkerCanonicalEventRecordSchema.parse({
          schemaVersion: 1,
          kind: 'event',
          lineage,
          sequence: 1,
          event: {
            type: 'observation.content.chunk',
            data: {
              observationId: 'bridge-source',
              chunkIndex: 0,
              byteOffset: 0,
              encoding: 'base64',
              data: bytes.toString('base64'),
            },
          },
        });
        for (const record of mode === 'committed' ? [metadata, chunk] : [metadata])
          await recordWorkerControlAcceptedRecord(coreDb, {
            acceptedAt: pkg.createdAt,
            lineage,
            operation: 'event_append',
            record,
            recordKey: String(record.sequence),
            sequence: record.sequence,
          });
        source = Buffer.from(`${JSON.stringify(metadata)}\n${JSON.stringify(chunk)}\n`);
      },
      onExport: async (request) => {
        if (request.input.presence === 'optional' && mode === 'missing') return { state: 'absent' };
        const payload = request.input.presence === 'optional' ? source : Buffer.from('\n');
        const directory = join(root, String(serial++));
        mkdirSync(directory);
        const stagingPath = join(directory, 'complete');
        if (request.input.presence === 'optional' && mode === 'oversized-cleanup') {
          // The real file has an honest oversized length and digest, without a large heap buffer.
          const byteLength = WORKER_OBSERVATION_SOURCE_MAX_BYTES + 1;
          writeFileSync(stagingPath, '');
          truncateSync(stagingPath, byteLength);
          const digest = createHash('sha256');
          for await (const chunk of createReadStream(stagingPath)) digest.update(chunk);
          sourcePath = stagingPath;
          return { stagingPath, byteLength, sha256: `sha256:${digest.digest('hex')}` };
        }
        writeFileSync(stagingPath, payload);
        if (request.input.presence === 'optional') sourcePath = stagingPath;
        return {
          stagingPath,
          byteLength: payload.length,
          sha256: `sha256:${createHash('sha256').update(payload).digest('hex')}`,
        };
      },
    });
    f.backend.sessions.set(f.environmentPackage.snapshotId, f.session);
    try {
      if (mode === 'oversized-cleanup') {
        await expect(
          f.backend.collectTranscript!(f.environmentPackage.snapshotId, true)
        ).rejects.toThrow();
        expect(
          f.effects.filter(
            (effect) => effect.kind === 'file.export' && effect.input.presence === 'optional'
          )
        ).toHaveLength(1);
        expect(existsSync(sourcePath)).toBe(true);
        const stagingDirectory = dirname(sourcePath);
        // This proved reusable resident needs only the existing local session/staging cleanup.
        await f.backend.cleanupSession(f.backend.planSession(f.environmentPackage));
        // Cleanup must own the Host-returned path even when admission refused before inspection.
        expect(existsSync(stagingDirectory)).toBe(false);
        return;
      }
      const transcript = await f.backend.collectTranscript!(f.environmentPackage.snapshotId, true);
      const exports = f.effects.filter(
        (effect) => effect.kind === 'file.export' && effect.input.presence === 'optional'
      );
      if (mode === 'committed') {
        expect(exports).toEqual([]);
        expect(transcript.observationSources ?? []).toEqual([]);
      } else {
        expect(exports).toHaveLength(1);
        expect(exports[0]!.input).toMatchObject({
          slot: 'session',
          presence: 'optional',
          finalStatusAccepted: true,
          terminalBarrierProved: true,
          relativePath: `${f.environmentPackage.scope.threadId}/${f.environmentPackage.control.adapter.targetRuntime}/capture/${f.environmentPackage.scope.turnId}/runtime/observations/0.jsonl`,
        });
        expect(transcript.observationSources ?? []).toEqual(
          mode === 'retained' ? [{ metadata, sourcePath }] : []
        );
        if (mode === 'retained') expect(readFileSync(sourcePath)).toEqual(source);
      }
      const db = openWorkspaceDb(f.coreDb.dataRoot, f.environmentPackage.scope.workspaceId);
      try {
        const rows = readWorkObservations(db, f.environmentPackage.scope);
        expect(
          rows.some(
            (row) =>
              row.type === 'runtime.observed' && row.payload.observationId === 'bridge-source'
          )
        ).toBe(true);
        expect(rows.filter((row) => row.type === 'content.published')).toHaveLength(
          mode === 'committed' ? 1 : 0
        );
      } finally {
        db.sqlite.close();
      }
      expect(transcript.eventsJsonl).toBe('\n');
      expect(transcript.itemsJsonl).toBe('\n');
    } finally {
      f.coreDb.sqlite.close();
      rmSync(root, { recursive: true, force: true });
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
  // Real baseline admission and canonical-state checks use this local runner limit; product deadlines stay unchanged.
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
    } finally {
      db.sqlite.close();
      f.coreDb.sqlite.close();
    }
  }, 60_000);
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
  const capturePublicationFaults = [
    'body',
    'capture-result',
    'idle',
    'idle-epoch',
    'idle-concurrent',
  ] as const;
  it.each(capturePublicationFaults)('capture publication: %s', async (fault) => {
    const idleCapture = fault === 'idle' || fault === 'idle-epoch' || fault === 'idle-concurrent';
    let coreDb = createFactoryCoreDb();
    const dataRoot = coreDb.dataRoot;
    const ownerUserId = ensureLocalUser(coreDb);
    const store = await createDemoStore({ dataRoot });
    recordWorkspaceOwnerMembership({ coreDb, ownerUserId, workspaceId: DEMO_WORKSPACE_ID });
    const manifest = createTestAgentSetup({
      imageRef: `sha256:${'a'.repeat(64)}`,
      requiredCapabilities: ['trusted-worker-inference-relay'],
    }).manifest;
    const configuration = createInMemoryRuntimeConfigSnapshot({
      ...loadRuntimeConfig(dataRoot),
      agentManifests: [manifest],
      gatewayConfig: createTestGatewayConfig(),
      providerRegistry: new ProviderRegistry([
        {
          id: 'agent-openrouter',
          displayName: 'Capture fixture',
          kind: 'local',
          models: ['openai/gpt-5.2'],
        },
      ]),
    });
    const options = { readRuntimeConfig: () => configuration };
    let native = createNativeTaskAdmissionFixture(coreDb, store, options);
    let admitted: Awaited<ReturnType<typeof native.admitTurn>> | undefined;
    let journalRef: ExecutionJournalRef | undefined;
    const writeIntent = vi
      .mocked(store.writeWorkspaceExecutionJournalIntent)
      .getMockImplementation();
    if (!writeIntent) throw new Error('Native admission has no real journal observer.');
    const intents = vi
      .spyOn(store, 'writeWorkspaceExecutionJournalIntent')
      .mockImplementation(async (...args) => {
        const invocation = await writeIntent(...args);
        journalRef = invocation.ref.execution;
        return invocation;
      });
    onTestFinished(() => intents.mockRestore());
    let db: ReturnType<typeof openWorkspaceDb> | undefined;
    const workingRoot = mkdtempSync(join(tmpdir(), 'refused-capture-work-'));
    const workingFile = join(workingRoot, 'current.patch');
    let durableCore: ReturnType<typeof openCoreDb> | undefined;
    let durableCapacity: WorkerGovernanceBackend | undefined;
    let concurrentArmed = false;
    let concurrentScans = 0;
    const concurrentEntered = Promise.withResolvers<void>();
    const concurrentRelease = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    let concurrentSibling: Awaited<ReturnType<typeof native.admitTurn>> | undefined;
    let idleCollection = false;
    let arrivedStage: string | undefined;
    const a = Buffer.from(
      'diff --git a/file.txt b/file.txt\nnew file mode 100644\n--- /dev/null\n+++ b/file.txt\n@@ -0,0 +1 @@\n+A\n'
    );
    const b = Buffer.from(
      'diff --git a/file.txt b/file.txt\nnew file mode 100644\n--- /dev/null\n+++ b/file.txt\n@@ -0,0 +1 @@\n+B\n'
    );
    writeFileSync(workingFile, idleCapture ? Buffer.alloc(0) : a);
    onTestFinished(async () => {
      for (const gate of concurrentRelease) gate.resolve();
      await concurrentSibling?.cleanup();
      if (durableCore?.sqlite.open) durableCore.sqlite.close();
      if (db?.sqlite.open) db.sqlite.close();
      await admitted?.cleanup();
      await native.restore();
      await shutdownControlStoreWorkerClient();
      if (coreDb.sqlite.open) coreDb.sqlite.close();
      rmSync(workingRoot, { recursive: true, force: true });
    });
    const backend = native.executor.executionBackend as WorkerGovernanceBackend & {
      sessionDispatch: NanoHostSessionDispatch;
    };
    const effect = backend.sessionDispatch.effect.bind(backend.sessionDispatch);
    const injected = vi
      .spyOn(backend.sessionDispatch, 'effect')
      .mockImplementation(async (...args) => {
        const request = (args[1] ?? args[0]) as NanoHostSessionEffectRequest;
        if (
          concurrentArmed &&
          request.kind === 'workspace.collect' &&
          request.input.mode !== 'baseline'
        ) {
          const gate = concurrentRelease[concurrentScans++];
          if (!gate) throw new Error('Concurrent idle close dispatched an extra scan.');
          if (concurrentScans === 2) concurrentEntered.resolve();
          await gate.promise;
          return await effect(...args);
        }
        if (
          request.kind !== 'workspace.collect' ||
          request.input.mode === 'baseline' ||
          (idleCapture && !idleCollection)
        )
          return await effect(...args);
        if (idleCollection) {
          if (!admitted || !durableCapacity) throw new Error('Idle scan lacks its durable reader.');
          expect(await durableCapacity.inspectMaterializationCapacity!(admitted.pkg)).toBe(
            'capacity-saturated'
          );
        }
        native.outside.effects.push(request);
        const bytes = readFileSync(workingFile);
        const stagingPath = join(mkdtempSync(join(dataRoot, 'arrived-capture-')), 'complete');
        writeFileSync(stagingPath, bytes);
        arrivedStage = stagingPath;
        return {
          outcome: 'candidate',
          head: { tree: '3'.repeat(40), manifest: '4'.repeat(40) },
          previousHead: request.input.previousHead,
          acceptedBase: request.input.acceptedBase,
          unstable: false,
          byteLength: bytes.length,
          sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
          stagingPath,
        };
      });
    onTestFinished(() => injected.mockRestore());
    const attemptId = testEntityId('attempt', 'capture_insert_rollback');
    const agentSessionId = testEntityId('as', 'capture_insert_rollback');
    const entry = createSchedulerAdmissionEntry(coreDb, {
      backendId: 'nanohost',
      queueEntryId: `queue:${attemptId}`,
      requestId: testEntityId('tu', 'capture_insert_rollback_request').slice(3),
      requestedAgentId: manifest.id,
      workspaceId: DEMO_WORKSPACE_ID,
      threadId: DEMO_THREAD_ID,
      turnId: testEntityId('tu', 'capture_insert_rollback'),
      turnInput: 'Retain the original arrived capture after a local refusal.',
      triggerActor: { kind: 'user', id: ownerUserId },
    });
    await publishFactoryAdmission(store, entry);
    admitted = await native.admitTurn(entry, {
      attemptId,
      agentSessionId,
      candidateAgentSessionId: agentSessionId,
    });
    expect(admitted.pkg.workspace.inputs).toEqual([]);
    const originalSession = store.getAgentSession(agentSessionId);
    expect(originalSession.retainedStorage?.attachmentGeneration).toBeGreaterThan(0);
    const anchor = getWorkerBackendSession(coreDb, attemptId)!;
    expect(anchor.packageSnapshotId).toBe(admitted.pkg.snapshotId);
    db = openWorkspaceDb(dataRoot, DEMO_WORKSPACE_ID);
    const cursor = db.sqlite.prepare('SELECT * FROM workspace_snapshot_cursors').all();
    const receipts = db.sqlite.prepare('SELECT * FROM workspace_snapshot_collections').all();
    if (fault === 'idle-concurrent') {
      await admitted.complete();
      if (!journalRef) throw new Error('Original idle Turn has no acknowledged journal.');
      const firstRef = journalRef;
      const siblingThread = await store.createThread(
        entry.workspaceId,
        'Independent concurrent idle capture',
        testEntityId('th', 'capture_concurrent_sibling')
      );
      const storage = getWorkerStorageBinding(
        coreDb,
        store.getAgentSession(agentSessionId).retainedStorage!
      )!;
      const siblingAttemptId = testEntityId('attempt', 'capture_concurrent_sibling');
      const siblingAgentSessionId = testEntityId('as', 'capture_concurrent_sibling');
      const siblingEntry = createSchedulerAdmissionEntry(coreDb, {
        backendId: 'nanohost',
        queueEntryId: `queue:${siblingAttemptId}`,
        requestId: testEntityId('tu', 'capture_concurrent_sibling_request').slice(3),
        requestedAgentId: manifest.id,
        workspaceId: entry.workspaceId,
        threadId: siblingThread.id,
        turnId: testEntityId('tu', 'capture_concurrent_sibling'),
        turnInput: 'Complete an independent binding in the same shared Sandbox.',
        triggerActor: { kind: 'user', id: ownerUserId },
        workerStorageChoice: {
          kind: 'selected',
          storageRef: storage.storageRef,
          expectedRevision: storage.revision,
          purpose: 'work',
          goalId: null,
          taskId: null,
        },
      });
      await publishFactoryAdmission(store, siblingEntry);
      concurrentSibling = await native.admitTurn(siblingEntry, {
        attemptId: siblingAttemptId,
        agentSessionId: siblingAgentSessionId,
        candidateAgentSessionId: siblingAgentSessionId,
      });
      await concurrentSibling.complete();
      if (!journalRef) throw new Error('Sibling idle Turn has no acknowledged journal.');
      expect(journalRef.executionId).not.toBe(firstRef.executionId);
      const residents = [admitted, concurrentSibling];
      const bindings = residents.map(({ pkg }) =>
        harnessRecords.inspectNanoHostAgentSessionContinuity(coreDb, {
          agentSessionId: pkg.scope.agentSessionId,
          threadId: pkg.scope.threadId,
          workspaceId: pkg.scope.workspaceId,
        })
      );
      expect(bindings[0]?.harnessInstanceId).toBeTruthy();
      expect(bindings[1]?.harnessInstanceId).toBe(bindings[0]!.harnessInstanceId);
      const originals = await Promise.all(
        [firstRef, journalRef].map(async (ref) => {
          const reader = createExecutionStepJournalReader(db!, ref.owner);
          const root = await reader.readExecution(ref);
          expect(root.phase).toBe('closed');
          return { ref, root, steps: await reader.readEndedSteps(ref) };
        })
      );
      durableCore = openCoreDb(dataRoot);
      const durableOwner = createConfiguredWorkerLifecycleRuntime({
        ...options,
        coreDb: durableCore,
        store,
      });
      durableCapacity = (durableOwner.turnExecutor as WorkerGovernanceTurnExecutor)
        .executionBackend as WorkerGovernanceBackend;
      for (const { pkg } of residents)
        expect(await durableCapacity.inspectMaterializationCapacity!(pkg)).toBe('available');
      const closing: Array<Promise<number>> = [];
      const finished: number[] = [];
      let outcomes: PromiseSettledResult<number>[] = [];
      try {
        concurrentArmed = true;
        for (const [index, { pkg }] of residents.entries()) {
          closing.push(
            backend.prepareAgentSessionContinuity!({
              agentSessionId: pkg.scope.agentSessionId,
              threadId: pkg.scope.threadId,
              workspaceId: pkg.scope.workspaceId,
              environmentPackage: pkg,
              reuseAllowed: false,
            }).then((disposition) => {
              expect(disposition).toBe('closed');
              finished.push(index);
              return index;
            })
          );
        }
        await Promise.race([
          concurrentEntered.promise,
          Promise.all(closing).then(() => {
            throw new Error('Both closes finished before both external scans arrived.');
          }),
        ]);
        concurrentRelease[0]!.resolve();
        const completed = await Promise.race(closing);
        expect(finished).toEqual([completed]);
        expect(
          await durableCapacity.inspectMaterializationCapacity!(residents[1 - completed]!.pkg)
        ).toBe('capacity-saturated');
        for (const original of originals) {
          const reader = createExecutionStepJournalReader(db, original.ref.owner);
          expect(await reader.readExecution(original.ref)).toStrictEqual(original.root);
          expect(await reader.readEndedSteps(original.ref)).toStrictEqual(original.steps);
        }
      } finally {
        for (const gate of concurrentRelease) gate.resolve();
        outcomes = await Promise.allSettled(closing);
      }
      for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason;
      return;
    }
    if (idleCapture) {
      await admitted.complete();
      if (!journalRef) throw new Error('Completed native Turn has no acknowledged journal.');
      const closedRef = journalRef;
      const reader = createExecutionStepJournalReader(db, closedRef.owner);
      const closed = await reader.readExecution(closedRef);
      const ended = await reader.readEndedSteps(closedRef);
      expect(closed).toMatchObject({ phase: 'closed', openSteps: [], exclusionRefs: [] });
      const completedTurn = store.getTurnById(entry.turnId);
      expect(completedTurn.status).toBe('completed');
      const idle = harnessRecords.inspectNanoHostAgentSessionContinuity(coreDb, {
        agentSessionId,
        threadId: entry.threadId,
        workspaceId: entry.workspaceId,
      });
      if (!idle) throw new Error('Completed native Turn has no retained idle binding.');
      const cursor = db.sqlite.prepare('SELECT * FROM workspace_snapshot_cursors').all();
      const receipts = db.sqlite.prepare('SELECT * FROM workspace_snapshot_collections').all();
      durableCore = openCoreDb(dataRoot);
      const durableOwner = createConfiguredWorkerLifecycleRuntime({
        ...options,
        coreDb: durableCore,
        store,
      });
      durableCapacity = (durableOwner.turnExecutor as WorkerGovernanceTurnExecutor)
        .executionBackend as WorkerGovernanceBackend;
      expect(await durableCapacity.inspectMaterializationCapacity!(admitted.pkg)).toBe('available');
      writeFileSync(workingFile, a);
      idleCollection = true;
      let reserveRefused = false;
      const reserve = native.fileAdmission.reserve.bind(native.fileAdmission);
      const refusal = vi.spyOn(native.fileAdmission, 'reserve').mockImplementation((writes) => {
        if (!reserveRefused && arrivedStage && writes.publicationBytes > 0n) {
          expect(readFileSync(arrivedStage)).toEqual(a);
          reserveRefused = true;
          throw new FileAdmissionError('storage_capacity_unavailable');
        }
        return reserve(writes);
      });
      const beforeIdle = native.effects.length;
      try {
        await expect(
          backend.prepareAgentSessionContinuity!({
            agentSessionId,
            threadId: entry.threadId,
            workspaceId: entry.workspaceId,
            environmentPackage: admitted.pkg,
            reuseAllowed: false,
          })
        ).rejects.toThrow();
      } finally {
        refusal.mockRestore();
      }
      durableCore.sqlite.close();
      expect(reserveRefused).toBe(true);
      expect(
        native.effects.slice(beforeIdle).filter((effect) => effect.kind === 'workspace.collect')
      ).toHaveLength(1);
      expect(
        native.effects
          .slice(beforeIdle)
          .filter((effect) => ['bridge.close', 'sandbox.delete'].includes(effect.kind))
      ).toEqual([]);
      expect(await reader.readExecution(closedRef)).toStrictEqual(closed);
      expect(await reader.readEndedSteps(closedRef)).toStrictEqual(ended);
      expect(db.sqlite.prepare('SELECT * FROM workspace_snapshot_cursors').all()).toEqual(cursor);
      expect(db.sqlite.prepare('SELECT * FROM workspace_snapshot_collections').all()).toEqual(
        receipts
      );
      writeFileSync(workingFile, b);
      await admitted.cleanup();
      await native.restore();
      await shutdownControlStoreWorkerClient();
      db.sqlite.close();
      coreDb.sqlite.close();
      coreDb = openCoreDb(dataRoot);
      db = openWorkspaceDb(dataRoot, DEMO_WORKSPACE_ID);
      const coldStore = await createDemoStore({ dataRoot });
      native = createNativeTaskAdmissionFixture(coreDb, coldStore, options, native.outside);
      const coldBackend = native.executor.executionBackend as WorkerGovernanceBackend;
      const afterReopen = native.effects.length;
      expect(admitted.pkg.workspace.inputs).toEqual([]);
      expect(await coldBackend.inspectMaterializationCapacity!(admitted.pkg)).toBe(
        'capacity-saturated'
      );
      expect(native.effects.slice(afterReopen)).toEqual([]);
      if (fault === 'idle-epoch') {
        const retainedSession = coldStore.getAgentSession(agentSessionId);
        const storageBefore = getWorkerStorageBinding(coreDb, retainedSession.retainedStorage!)!;
        expect(storageBefore).toBeTruthy();
        const current = getNanoHostRuntimeTarget(coreDb, anchor.runtimeTargetId!)!;
        expect(anchor.originPhysicalEpoch).toBe('a'.repeat(64));
        const generation = allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
          deploymentId: current.deploymentId,
          identityId: current.identityId,
          targetId: current.targetId,
          observedAt: new Date().toISOString(),
        });
        // The outside peer proves a fenced predecessor and ready fresh Epoch B.
        const replacement = upsertNanoHostRuntimeTarget(coreDb, {
          ...generation,
          physicalEpoch: 'b'.repeat(64),
          predecessorFenced: true,
          freshEmpty: true,
          ready: true,
          observedAt: new Date().toISOString(),
        });
        expect(replacement).toMatchObject({
          physicalEpoch: 'b'.repeat(64),
          predecessorFenced: true,
          freshEmpty: true,
          ready: true,
        });
        expect(replacement.connectionGeneration).toBeGreaterThan(current.connectionGeneration);
        await native.restore();
        native.outside.bindings.clear();
        native.outside.integrationBindingRef = undefined;
        native = createNativeTaskAdmissionFixture(coreDb, coldStore, options, native.outside);
        const incomingThread = await coldStore.createThread(
          entry.workspaceId,
          'Fresh Epoch with unresolved predecessor capture',
          testEntityId('th', 'capture_partial_fresh_epoch')
        );
        const nextAttemptId = testEntityId('attempt', 'capture_partial_fresh_epoch');
        const incomingEntry = createSchedulerAdmissionEntry(coreDb, {
          backendId: 'nanohost',
          queueEntryId: `queue:${nextAttemptId}`,
          requestId: testEntityId('tu', 'capture_partial_fresh_request').slice(3),
          requestedAgentId: manifest.id,
          workspaceId: entry.workspaceId,
          threadId: incomingThread.id,
          turnId: testEntityId('tu', 'capture_partial_fresh_epoch'),
          turnInput: 'Refuse reuse before the original partial capture has a disposition.',
          triggerActor: { kind: 'user', id: ownerUserId },
        });
        await publishFactoryAdmission(coldStore, incomingEntry);
        const incoming: { admission?: Awaited<ReturnType<typeof native.admitTurn>> } = {};
        try {
          await expect(
            native
              .admitTurn(incomingEntry, {
                attemptId: nextAttemptId,
                agentSessionId: testEntityId('as', 'capture_partial_fresh_epoch'),
                candidateAgentSessionId: testEntityId('as', 'capture_partial_fresh_epoch'),
              })
              .then((admission) => {
                incoming.admission = admission;
              })
          ).rejects.toThrow();
        } finally {
          await incoming.admission?.cleanup();
        }
        const retained = getWorkerStorageBinding(coreDb, retainedSession.retainedStorage!)!;
        expect(retained).toMatchObject({
          attachmentGeneration: storageBefore.attachmentGeneration,
          currentSandboxBindingRef: storageBefore.currentSandboxBindingRef,
          currentWorkSlotRef: storageBefore.currentWorkSlotRef,
          targets: storageBefore.targets,
        });
        expect(['attached', 'unknown']).toContain(retained.state);
        expect(coldStore.getAgentSession(agentSessionId)).toMatchObject({
          retainedStorage: retainedSession.retainedStorage,
          nativeHandleDigest: retainedSession.nativeHandleDigest,
        });
        expect(native.effects.slice(afterReopen)).toEqual([]);
      }
      const coldReader = createExecutionStepJournalReader(db, closedRef.owner);
      expect(await coldReader.readExecution(closedRef)).toStrictEqual(closed);
      expect(await coldReader.readEndedSteps(closedRef)).toStrictEqual(ended);
      expect(coldStore.getTurnById(entry.turnId)).toStrictEqual(completedTurn);
      expect(db.sqlite.prepare('SELECT * FROM workspace_snapshot_cursors').all()).toEqual(cursor);
      expect(db.sqlite.prepare('SELECT * FROM workspace_snapshot_collections').all()).toEqual(
        receipts
      );
      return;
    }
    // Real SQLite refusal after valid native setup; this is ABORT, not a claimed BUSY result.
    if (fault === 'body')
      db.sqlite.exec(`CREATE TRIGGER refuse_capture_insert BEFORE INSERT ON workspace_snapshot_collections
      BEGIN SELECT RAISE(ABORT, 'capture INSERT refused'); END`);
    let ambiguousBoundaryReached = false;
    const acceptCapture = captureOwner.acceptWorkspaceCapture;
    const captureFault = vi
      .spyOn(captureOwner, 'acceptWorkspaceCapture')
      .mockImplementation((...args) => {
        const receipt = acceptCapture(...args);
        if (fault === 'capture-result') {
          ambiguousBoundaryReached = true;
          throw new Error('Controlled capture-result ambiguity');
        }
        return receipt;
      });
    onTestFinished(() => captureFault.mockRestore());
    const before = native.effects.length;
    try {
      if (fault === 'body')
        await expect(admitted.complete()).rejects.toThrow('capture INSERT refused');
      else await expect(admitted.complete()).rejects.toThrow('Controlled capture-result ambiguity');
    } finally {
      if (fault === 'body') db.sqlite.exec('DROP TRIGGER refuse_capture_insert');
    }
    captureFault.mockRestore();
    if (!journalRef) throw new Error('Native admission did not acknowledge its real journal.');
    const ended = await createExecutionStepJournalReader(db, journalRef.owner).readEndedSteps(
      journalRef
    );
    if (fault === 'capture-result') {
      expect(ambiguousBoundaryReached).toBe(true);
      expect(
        ended.filter((step) => step.control.kind === 'collect' && step.state === 'failed')
      ).toEqual([]);
      expect(native.executor.releaseResults).toEqual([]);
      const unknown = ended.filter((step) => step.state === 'unknown');
      expect(unknown.length).toBeGreaterThan(0);
      await admitted.cleanup();
      await native.restore();
      await shutdownControlStoreWorkerClient();
      db.sqlite.close();
      coreDb.sqlite.close();
      coreDb = openCoreDb(dataRoot);
      db = openWorkspaceDb(dataRoot, DEMO_WORKSPACE_ID);
      const ambiguousStore = await createDemoStore({ dataRoot });
      native = createNativeTaskAdmissionFixture(coreDb, ambiguousStore, options, native.outside);
      const ambiguousBackend = native.executor.executionBackend as WorkerGovernanceBackend;
      const coldEffects = native.effects.length;
      expect(await ambiguousBackend.inspectMaterializationCapacity?.(admitted.pkg)).toBe(
        'capacity-saturated'
      );
      expect(native.effects.slice(coldEffects)).toEqual([]);
      expect(attempts.requireSchedulerExecutionAttempt(coreDb, attemptId)).toMatchObject({
        phase: 'closing',
        fenceRef: null,
      });
      const retained = await createExecutionStepJournalReader(db, journalRef.owner).readEndedSteps(
        journalRef
      );
      for (const original of unknown)
        expect(retained.find((step) => step.ref.stepId === original.ref.stepId)).toStrictEqual(
          original
        );
      return;
    }
    expect(
      ended.some((step) => step.control.kind === 'collect' && step.state === 'completed')
    ).toBe(true);
    const captureFailure = ended.find(
      (step) => step.control.kind === 'collect' && step.state === 'failed'
    );
    if (!captureFailure) throw new Error('Known capture refusal has no failed invocation.');
    expect(ended.some((step) => step.state === 'unknown')).toBe(false);
    const failedTurn = store.getTurnById(entry.turnId);
    expect(db.sqlite.prepare('SELECT * FROM workspace_snapshot_cursors').all()).toEqual(cursor);
    expect(db.sqlite.prepare('SELECT * FROM workspace_snapshot_collections').all()).toEqual(
      receipts
    );
    expect(
      native.effects.slice(before).filter((request) => request.kind === 'workspace.collect')
    ).toHaveLength(1);
    expect(
      native.effects
        .slice(before)
        .filter((request) => ['bridge.close', 'sandbox.delete'].includes(request.kind))
    ).toEqual([]);
    writeFileSync(workingFile, b);
    await admitted.cleanup();
    injected.mockRestore();
    await native.restore();
    await shutdownControlStoreWorkerClient();
    db.sqlite.close();
    coreDb.sqlite.close();
    coreDb = openCoreDb(dataRoot);
    const coldStore = new FsStore({ dataRoot });
    native = createNativeTaskAdmissionFixture(coreDb, coldStore, options, native.outside);
    db = openWorkspaceDb(dataRoot, DEMO_WORKSPACE_ID);
    expect(coldStore.getAgentSession(agentSessionId).retainedStorage).toStrictEqual(
      originalSession.retainedStorage
    );
    expect(getWorkerBackendSession(coreDb, attemptId)).toMatchObject({
      attemptId,
      agentSessionId,
      packageSnapshotId: admitted.pkg.snapshotId,
      workspaceId: DEMO_WORKSPACE_ID,
      threadId: DEMO_THREAD_ID,
      turnId: entry.turnId,
      backendSessionId: anchor.backendSessionId,
      originPhysicalEpoch: anchor.originPhysicalEpoch,
    });
    expect(db.sqlite.prepare('SELECT * FROM workspace_snapshot_cursors').all()).toEqual(cursor);
    expect(db.sqlite.prepare('SELECT * FROM workspace_snapshot_collections').all()).toEqual(
      receipts
    );
    // Inventory observes the owned restricted mount; it supplies no recovery or execution authority.
    const evidenceRoot = join(dataRoot, 'workspaces', DEMO_WORKSPACE_ID, 'evidence', 'backend');
    expect(existsSync(evidenceRoot)).toBe(true);
    const retainedBytes = readdirSync(evidenceRoot, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => readFileSync(join(entry.parentPath, entry.name)));
    expect(retainedBytes.some((bytes) => bytes.equals(a))).toBe(true);
    expect(retainedBytes.some((bytes) => bytes.equals(b))).toBe(false);
    const afterReopen = native.effects.length;
    const coldBackend = native.executor.executionBackend as WorkerGovernanceBackend;
    expect(await coldBackend.inspectMaterializationCapacity!(admitted.pkg)).toBe(
      'capacity-saturated'
    );
    expect(native.effects.slice(afterReopen)).toEqual([]);
    await native.runtime.reconcileAcceptedFinalStatus(getWorkerBackendSession(coreDb, attemptId)!);
    const digest = `sha256:${createHash('sha256').update(a).digest('hex')}`;
    const bundle = listStoredWorkspaceEvidenceBundles(db, DEMO_WORKSPACE_ID).find(
      (value) =>
        value.turnId === entry.turnId &&
        value.agentSessionId === agentSessionId &&
        value.contentDigests.includes(digest)
    );
    expect(bundle).toMatchObject({
      workspaceId: DEMO_WORKSPACE_ID,
      threadId: DEMO_THREAD_ID,
      retentionClass: 'restricted-raw',
      sensitivityClass: 'restricted',
    });
    if (!bundle) throw new Error('Cold recovery omitted the exact original capture bundle.');
    expect(['collected', 'verified']).toContain(bundle.importStatus);
    expect(bundle.rawEvidenceRefs.length).toBeGreaterThan(0);
    const reconciliation = listWorkspaceReconciliationRecords(db, DEMO_WORKSPACE_ID).find((value) =>
      value.evidenceBundleIds.includes(bundle.id)
    );
    expect(reconciliation).toMatchObject({
      stateAfter: 'requires-human',
      retentionDecision: 'retain-backend',
    });
    if (!reconciliation)
      throw new Error('Cold recovery omitted its original-capture reconciliation.');
    const physicalKinds = ['workspace.collect', 'bridge.close', 'sandbox.delete'];
    expect(
      native.effects.slice(afterReopen).filter((effect) => physicalKinds.includes(effect.kind))
    ).toEqual([]);
    expect(native.executor.releaseResults).toEqual([]);
    resolveWorkspaceReconciliationRecord({
      workspaceDb: db,
      workspaceId: DEMO_WORKSPACE_ID,
      reconciliationRecordId: reconciliation.id,
      decision: 'abandon',
      decidedAt: new Date().toISOString(),
    });
    await native.runtime.reconcileAcceptedFinalStatus(getWorkerBackendSession(coreDb, attemptId)!);
    const released = native.executor.releaseResults.find((value) => value.attemptId === attemptId);
    expect(released).toMatchObject({
      attemptId,
      backendId: coldBackend.id,
      bindingRef: admitted.attempt.bindingRef,
      inputRef: admitted.pkg.snapshotId,
      state: 'released',
      fenceRef: expect.any(String),
    });
    expect(released?.operationId).toBe(
      attempts.requireSchedulerExecutionAttempt(coreDb, attemptId).operationId
    );
    expect(attempts.requireSchedulerExecutionAttempt(coreDb, attemptId)).toMatchObject({
      phase: 'closed',
      fenceRef: expect.any(String),
    });
    const reader = createExecutionStepJournalReader(db, journalRef.owner);
    expect(await reader.readExecution(journalRef)).toMatchObject({
      phase: 'closed',
      exclusionRefs: [],
    });
    expect(
      native.effects
        .slice(afterReopen)
        .filter((effect) => ['bridge.close', 'sandbox.delete'].includes(effect.kind))
        .map((effect) => effect.kind)
    ).toEqual(['bridge.close', 'sandbox.delete']);
    const settled = await reader.readEndedSteps(journalRef);
    for (const original of ended)
      expect(settled.find((step) => step.ref.stepId === original.ref.stepId)).toStrictEqual(
        original
      );
    expect(coldStore.getTurnById(entry.turnId)).toStrictEqual(failedTurn);
    expect(db.sqlite.prepare('SELECT * FROM workspace_snapshot_cursors').all()).toEqual(cursor);
    expect(db.sqlite.prepare('SELECT * FROM workspace_snapshot_collections').all()).toEqual(
      receipts
    );
    expect(
      readdirSync(evidenceRoot, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .some((entry) => readFileSync(join(entry.parentPath, entry.name)).equals(a))
    ).toBe(true);
  });

  it('preserves a refused collection without a cursor advance, receipt, or review', async () => {
    const failure = { outcome: 'credential_hit' };
    const f = await admitIdleSupplyResident('closed_failures', {
      onCollection: async (request) =>
        request.input.mode === 'baseline'
          ? {
              outcome: 'baseline',
              head: { tree: '4b825dc642cb6eb9a060e54bf8d69288fbee4904', manifest: '2'.repeat(40) },
            }
          : failure,
    });
    const collector = f.backend as unknown as {
      collectWorkspaceSnapshot(session: unknown, boundary: 'turn-end'): Promise<unknown>;
    };
    const db = openWorkspaceDb(f.coreDb.dataRoot, f.environmentPackage.scope.workspaceId);
    try {
      const before = db.sqlite.prepare('SELECT * FROM workspace_snapshot_cursors').all();
      await expect(collector.collectWorkspaceSnapshot(f.session, 'turn-end')).rejects.toMatchObject(
        { ...failure, name: 'WorkspaceCollectionError' }
      );
      expect(db.sqlite.prepare('SELECT * FROM workspace_snapshot_cursors').all()).toEqual(before);
      expect(
        db.sqlite.prepare('SELECT COUNT(*) AS count FROM workspace_snapshot_collections').get()
      ).toEqual({ count: 0 });
      expect(
        db.sqlite.prepare('SELECT COUNT(*) AS count FROM staged_workspace_reviews').get()
      ).toEqual({ count: 0 });
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
    const referenceId = testEntityId('vault', 'collection-versions');
    const grantId = testEntityId('grant', 'collection-versions');
    const originalMaterial = randomUUID();
    const currentMaterial = randomUUID();
    let currentVersion = 7;
    let workspaceId = '';
    const resolveMaterial = (input: { referenceId: string; version?: number }) =>
      input.version === 7 ? originalMaterial : currentMaterial;
    const resolve = vi.fn(resolveMaterial);
    const vault = {
      kind: 'encrypted-file',
      health: vi.fn(() => ({
        kind: 'encrypted-file',
        state: 'available',
        diagnostic: 'available',
      })),
      listReferences: () => [
        {
          referenceId,
          backendKind: 'encrypted-file',
          ownerScope: 'workspace',
          workspaceId,
          currentVersion,
          versionCount: currentVersion,
          revoked: false,
        },
      ],
      resolve,
    } as unknown as VaultBackend;
    const coreDb = createFactoryCoreDb();
    const ownerUserId = ensureLocalUser(coreDb);
    const store = await createDemoStore({ dataRoot: coreDb.dataRoot });
    workspaceId = DEMO_WORKSPACE_ID;
    recordWorkspaceOwnerMembership({ coreDb, workspaceId, ownerUserId });
    const agentSessionId = testEntityId('as', 'collection-versions');
    const setup = createTestAgentSetup({
      imageRef: `sha256:${'a'.repeat(64)}`,
      requiredCapabilities: ['trusted-worker-inference-relay'],
      credentialDeclarations: [
        {
          id: 'collection-version',
          requirementId: 'collection-version',
          visibility: 'runtime-env',
          targetEnvVarName: 'TOKEN',
        },
      ],
    });
    createVaultReference(coreDb, {
      referenceId,
      ownerScope: 'workspace',
      workspaceId,
      displayName: 'Collection version fixture',
      secretKind: 'github-token',
      backendKind: 'encrypted-file',
      backendLocator: 'synthetic-collection-reference',
    });
    for (let version = 2; version <= 7; version++)
      advanceActiveVaultReferenceVersion(coreDb, { referenceId, currentVersion: version });
    createVaultGrant(coreDb, {
      grantId,
      vaultReferenceId: referenceId,
      ownerScope: 'workspace',
      workspaceId,
      targetAgentId: setup.manifest.id,
      targetAgentSessionId: agentSessionId,
      allowedInjectionPaths: ['runtime-env'],
      lifetime: 'workspace',
    });
    const runtimeConfig = loadRuntimeConfig(coreDb.dataRoot);
    const configuration = createInMemoryRuntimeConfigSnapshot({
      ...runtimeConfig,
      agentManifests: [setup.manifest],
      workspaceConfigs: [
        ...runtimeConfig.workspaceConfigs.filter((entry) => entry.workspaceId !== workspaceId),
        {
          workspaceId,
          path: join(coreDb.dataRoot, 'workspaces', workspaceId, 'workspace.yaml'),
          config: WorkspaceConfigSchema.parse({
            schemaVersion: 1,
            workspace: {
              name: 'Collection version fixture',
              agents: [
                {
                  agentId: setup.manifest.id,
                  credentialBindings: [
                    { requirementId: 'collection-version', vaultGrantId: grantId },
                  ],
                },
              ],
            },
          }),
        },
      ],
      gatewayConfig: createTestGatewayConfig(),
      providerRegistry: new ProviderRegistry([
        {
          id: 'agent-openrouter',
          displayName: 'Collection version fixture',
          kind: 'local',
          models: ['openai/gpt-5.2'],
        },
      ]),
    });
    const native = createNativeTaskAdmissionFixture(coreDb, store, {
      readRuntimeConfig: () => configuration,
      vaultBackend: () => vault,
    });
    const backend = native.executor.executionBackend as WorkerGovernanceBackend & {
      readonly sessions: Map<string, unknown>;
    };
    const workspaceDb = openWorkspaceDb(coreDb.dataRoot, workspaceId);
    const admitted: Awaited<ReturnType<typeof native.admitTurn>>[] = [];
    const admit = async (label: string) => {
      const turnId = testEntityId('tu', `collection-versions-${label}`);
      const entry = createSchedulerAdmissionEntry(coreDb, {
        backendId: 'nanohost',
        queueEntryId: `queue:collection-versions-${label}`,
        requestId: turnId.slice(3),
        requestedAgentId: setup.manifest.id,
        workspaceId,
        threadId: DEMO_THREAD_ID,
        turnId,
        turnInput: 'Collect with original credential authority.',
        triggerActor: { kind: 'user', id: ownerUserId },
      });
      await publishFactoryAdmission(store, entry);
      const turn = await native.admitTurn(entry, {
        attemptId: testEntityId('attempt', `collection-versions-${label}`),
        agentSessionId,
        candidateAgentSessionId: agentSessionId,
      });
      admitted.push(turn);
      await native.waitForStartup(turnId);
      return turn;
    };
    const failures: unknown[] = [];
    try {
      const original = await admit('original');
      const f = { coreDb, backend, environmentPackage: original.pkg };
      const collector = backend as unknown as {
        restoreCollectionRuntimeEnvironment(
          session: unknown,
          workspaceDb: ReturnType<typeof openWorkspaceDb>
        ): Promise<Record<string, string>>;
      };
      const real = backend.sessions.get(original.pkg.snapshotId) as {
        agentSessionRuntimeBindingId: string;
        environmentPackage: AgentEnvironmentPackage;
        runtimeEnvironment: Record<string, string> | null;
      };
      const originalPlan = listVaultInjectionPlans(f.coreDb).find(
        (plan) =>
          plan.packageSnapshotId === real.environmentPackage.snapshotId && plan.grantId === grantId
      );
      expect(originalPlan, 'Setup must retain the original producer plan.').toBeDefined();
      expect(listVaultInjectionReceipts(f.coreDb)).toContainEqual(
        expect.objectContaining({
          planId: originalPlan!.planId,
          grantId,
          agentSessionId: real.environmentPackage.scope.agentSessionId,
        })
      );
      // The shared native owner publishes the actual terminal tuple before another Turn is admitted.
      await original.complete();
      expect(store.getTurnById(original.pkg.scope.turnId)).toMatchObject({ status: 'completed' });
      advanceActiveVaultReferenceVersion(f.coreDb, { referenceId, currentVersion: 8 });
      currentVersion = 8;
      // Losing live material requires an audited reread of the exact original version.
      const originalUseDb = workspaceDb;
      {
        const previous = new Set(listVaultUseRecords(originalUseDb).map((use) => use.useId));
        resolve.mockClear();
        real.runtimeEnvironment = null;
        expect(await collector.restoreCollectionRuntimeEnvironment(real, workspaceDb)).toEqual({
          TOKEN: originalMaterial,
        });
        expect(resolve).toHaveBeenCalledExactlyOnceWith({ referenceId, version: 7 });
        const uses = listVaultUseRecords(originalUseDb).filter((use) => !previous.has(use.useId));
        expect(uses).toEqual([
          expect.objectContaining({
            grantId,
            planId: originalPlan!.planId,
            vaultReferenceId: referenceId,
            materialVersion: 7,
            outcome: 'succeeded',
            agentSessionId: real.environmentPackage.scope.agentSessionId,
          }),
        ]);
      }
      const next = await admit('successor');
      const successor = next.pkg;
      expect(successor.snapshotId).not.toBe(real.environmentPackage.snapshotId);
      expect(listVaultInjectionPlans(f.coreDb)).toContainEqual(
        expect.objectContaining({ packageSnapshotId: successor.snapshotId, grantId })
      );
      const session = backend.sessions.get(successor.snapshotId) as typeof real;
      await next.complete();
      expect(store.getTurnById(successor.scope.turnId)).toMatchObject({ status: 'completed' });
      expect(
        session.agentSessionRuntimeBindingId,
        'Setup must reuse the actual original binding.'
      ).toBe(real.agentSessionRuntimeBindingId);
      const validVersions = (
        f.coreDb.sqlite
          .prepare(
            'SELECT runtime_env_check_versions_json AS versions FROM agent_session_runtime_bindings WHERE agent_session_runtime_binding_id = ?'
          )
          .get(real.agentSessionRuntimeBindingId) as { versions: string }
      ).versions;
      const write = (versions: string | null) =>
        f.coreDb.sqlite
          .prepare(
            'UPDATE agent_session_runtime_bindings SET runtime_env_check_versions_json = ? WHERE agent_session_runtime_binding_id = ?'
          )
          .run(versions, real.agentSessionRuntimeBindingId);
      const useDb = workspaceDb;
      {
        const previous = new Set(listVaultUseRecords(useDb).map((use) => use.useId));
        resolve.mockClear();
        session.runtimeEnvironment = null;
        expect(await collector.restoreCollectionRuntimeEnvironment(session, workspaceDb)).toEqual({
          TOKEN: originalMaterial,
        });
        session.runtimeEnvironment = null;
        expect(await collector.restoreCollectionRuntimeEnvironment(session, workspaceDb)).toEqual({
          TOKEN: originalMaterial,
        });
        expect(resolve).toHaveBeenNthCalledWith(1, { referenceId, version: 7 });
        expect(resolve).toHaveBeenNthCalledWith(2, { referenceId, version: 7 });
        const uses = listVaultUseRecords(useDb).filter((use) => !previous.has(use.useId));
        // Vault-Use Audit Emission requires evidence for each actual original-version resolution.
        expect.soft(uses).toHaveLength(2);
        for (const use of uses)
          expect.soft(use).toMatchObject({
            grantId,
            planId: originalPlan!.planId,
            vaultReferenceId: referenceId,
            materialVersion: 7,
            outcome: 'succeeded',
            agentSessionId: real.environmentPackage.scope.agentSessionId,
          });
      }
      for (const versions of [
        null,
        'invalid',
        '{}',
        '[null]',
        '[]',
        JSON.stringify([
          { targetEnvVarName: 'TOKEN', vaultReferenceId: referenceId, materialVersion: 0 },
        ]),
        JSON.stringify([
          {
            targetEnvVarName: 'TOKEN',
            vaultReferenceId: referenceId,
            materialVersion: Number.MAX_SAFE_INTEGER + 1,
          },
        ]),
        JSON.stringify([{ targetEnvVarName: 'TOKEN', vaultReferenceId: '', materialVersion: 7 }]),
      ]) {
        write(versions);
        await expect(
          collector.restoreCollectionRuntimeEnvironment(session, workspaceDb)
        ).rejects.toThrow('check_values_unavailable');
      }
      // Old env/ref/version-only evidence grants no original authority, even with a valid successor.
      write(
        JSON.stringify([
          { targetEnvVarName: 'TOKEN', vaultReferenceId: referenceId, materialVersion: 7 },
        ])
      );
      const resolutionsBeforeMissingLineage = resolve.mock.calls.length;
      await expect
        .soft(collector.restoreCollectionRuntimeEnvironment(session, workspaceDb))
        .rejects.toThrow('check_values_unavailable');
      expect.soft(resolve).toHaveBeenCalledTimes(resolutionsBeforeMissingLineage);
      write(validVersions);
      vi.mocked(vault.health).mockReturnValueOnce({
        kind: 'encrypted-file',
        state: 'unavailable',
        diagnostic: 'unavailable',
      } as ReturnType<VaultBackend['health']>);
      await expect(
        collector.restoreCollectionRuntimeEnvironment(session, workspaceDb)
      ).rejects.toThrow('check_values_unavailable');
      resolve.mockImplementation(() => {
        throw new Error('version expired');
      });
      await expect(
        collector.restoreCollectionRuntimeEnvironment(session, workspaceDb)
      ).rejects.toThrow('check_values_unavailable');
      expect(
        JSON.stringify(
          f.coreDb.sqlite
            .prepare('SELECT runtime_env_check_versions_json FROM agent_session_runtime_bindings')
            .all()
        )
      ).not.toContain(originalMaterial);
      resolve.mockImplementation(resolveMaterial);
      // Only deliberate negative faults alter retained authority after its real owners created it.
      f.coreDb.sqlite
        .prepare("UPDATE vault_grants SET issuance = 'imported-history' WHERE grant_id = ?")
        .run(grantId);
      try {
        const resolutions = resolve.mock.calls.length;
        await expect
          .soft(collector.restoreCollectionRuntimeEnvironment(session, workspaceDb))
          .rejects.toThrow('check_values_unavailable');
        expect.soft(resolve).toHaveBeenCalledTimes(resolutions);
      } finally {
        f.coreDb.sqlite
          .prepare("UPDATE vault_grants SET issuance = 'target' WHERE grant_id = ?")
          .run(grantId);
      }
      // Cached material still requires current original-grant authority before it can be used.
      session.runtimeEnvironment = { TOKEN: originalMaterial };
      revokeVaultGrant(f.coreDb, { grantId });
      const resolutionsAfterRevocation = resolve.mock.calls.length;
      await expect
        .soft(collector.restoreCollectionRuntimeEnvironment(session, workspaceDb))
        .rejects.toThrow('check_values_unavailable');
      expect.soft(resolve).toHaveBeenCalledTimes(resolutionsAfterRevocation);
      f.coreDb.sqlite
        .prepare(
          "UPDATE agent_session_runtime_bindings SET schema_version = 2, runtime_env_check_versions_json = '{' WHERE agent_session_runtime_binding_id = ?"
        )
        .run(real.agentSessionRuntimeBindingId);
      const retained = f.coreDb.sqlite.serialize();
      const resolutions = resolve.mock.calls.length;
      await expect(
        collector.restoreCollectionRuntimeEnvironment(session, workspaceDb)
      ).rejects.toThrow('Unsupported retained record format.');
      expect(resolve).toHaveBeenCalledTimes(resolutions);
      expect(f.coreDb.sqlite.serialize().equals(retained)).toBe(true);
    } catch (cause) {
      failures.push(cause);
    }
    for (const turn of admitted) {
      try {
        await turn.cleanup();
      } catch (cause) {
        failures.push(cause);
      }
    }
    try {
      await native.restore();
    } catch (cause) {
      failures.push(cause);
    }
    workspaceDb.sqlite.close();
    coreDb.sqlite.close();
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1)
      throw new AggregateError(failures, 'Vault version scenario and cleanup failed.');
  });

  it('retains original credential evidence after live-memory loss and lease expiry, refusing missing route hashes', async () => {
    const f = await admitIdleSupplyResident('credential_admission');
    const workspaceDb = openWorkspaceDb(f.coreDb.dataRoot, f.environmentPackage.scope.workspaceId);
    try {
      const collector = f.backend as unknown as {
        transcriptCredentialCheckValues(
          session: unknown,
          workspaceDb: ReturnType<typeof openWorkspaceDb>
        ): Promise<import('./worker-credential-guard.js').WorkerCredentialCheckValues>;
      };
      const session = f.session as {
        liveRouteTokens: [string, string, string] | null;
        runtimeEnvironment: Record<string, string> | null;
      };
      const live = await collector.transcriptCredentialCheckValues(session, workspaceDb);
      expect(session.liveRouteTokens).toHaveLength(3);
      for (const token of session.liveRouteTokens!) expect(live.sensitiveValues).toContain(token);
      expect(live.sensitiveValues).toContain('sandbox-binding:credential_admission');
      f.coreDb.sqlite
        .prepare('UPDATE scheduler_execution_attempts SET deadline = ? WHERE attempt_id = ?')
        .run('2000-01-01T00:00:00.000Z', testEntityId('attempt', 'lease_credential_admission'));
      const recovered = await collector.transcriptCredentialCheckValues(
        {
          ...session,
          liveRouteTokens: null,
          runtimeEnvironment: null,
        },
        workspaceDb
      );
      expect(recovered.routeTokenHashes).toEqual(live.routeTokenHashes);
      expect(recovered.loopbackDigests).toEqual(live.loopbackDigests);
      expect(recovered.sensitiveValues).toEqual(['sandbox-binding:credential_admission']);
      for (const token of session.liveRouteTokens!)
        expect(recovered.sensitiveValues).not.toContain(token);
      f.coreDb.sqlite
        .prepare(
          'UPDATE scheduler_execution_attempts SET worker_control_token_hash = NULL WHERE attempt_id = ?'
        )
        .run(testEntityId('attempt', 'lease_credential_admission'));
      await expect(
        collector.transcriptCredentialCheckValues(
          {
            ...session,
            liveRouteTokens: null,
            runtimeEnvironment: null,
          },
          workspaceDb
        )
      ).rejects.toThrowError(expect.objectContaining({ code: 'recovery_required' }));
    } finally {
      workspaceDb.sqlite.close();
      f.coreDb.sqlite.close();
    }
  });
  it('constructs collection from exact attachment proof and refuses oversized or incomplete check commands', async () => {
    const f = await admitIdleSupplyResident('association');
    const workspaceDb = openWorkspaceDb(f.coreDb.dataRoot, f.environmentPackage.scope.workspaceId);
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
          cursor: unknown,
          workspaceDb: ReturnType<typeof openWorkspaceDb>
        ): Promise<Record<string, unknown>>;
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
      expect(
        await collector.workspaceCollectionCommand(real, identity, 'capture', cursor, workspaceDb)
      ).toMatchObject({
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
      });
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
      await expect(
        collector.workspaceCollectionCommand(
          {
            ...real,
            runtimeEnvironment: Object.fromEntries(
              Array.from({ length: 128 }, (_, i) => [`VALUE_${i}`, 'x'.repeat(65536)])
            ),
          },
          identity,
          'capture',
          cursor,
          workspaceDb
        )
      ).rejects.toThrow('command_too_large');
      await expect(
        collector.workspaceCollectionCommand(
          {
            ...real,
            runtimeEnvironment: Object.fromEntries(
              Array.from({ length: 129 }, (_, i) => [`VALUE_${i}`, 'x'])
            ),
          },
          identity,
          'capture',
          cursor,
          workspaceDb
        )
      ).rejects.toThrow('check_values_unavailable');
      await expect(
        collector.workspaceCollectionCommand(
          { ...real, runtimeEnvironment: { VALUE: 'nul\0' } },
          identity,
          'capture',
          cursor,
          workspaceDb
        )
      ).rejects.toThrow('check_values_unavailable');
    } finally {
      workspaceDb.sqlite.close();
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

  it('does not recreate a deleted resident Workspace during independent preparation', async () => {
    const admitted = await admitIdleSupplyResident('missing_skill_admission', {
      capacity: 20,
      configurePackage: (environmentPackage, coreDb) => {
        const configRoot = join(
          coreDb.dataRoot,
          'workspaces',
          environmentPackage.scope.workspaceId,
          'config'
        );
        mkdirSync(configRoot, { recursive: true });
        writeFileSync(
          join(configRoot, 'workspace.jsonc'),
          JSON.stringify(
            WorkspaceConfigSchema.parse({
              schemaVersion: 1,
              workspace: { name: 'Admission recovery fixture' },
            })
          )
        );
      },
    });
    const { coreDb, environmentPackage, effects, runtime } = admitted;
    try {
      const independent = completeNanoHostPackage({
        scope: {
          ...environmentPackage.scope,
          agentSessionId: testEntityId('as', 'missing_skill_independent'),
          threadId: testEntityId('th', 'missing_skill_independent'),
          turnId: testEntityId('tu', 'missing_skill_independent'),
          workspaceId: testEntityId('ws', 'missing_skill_independent'),
        },
        snapshotId: 'snapshot_missing_skill_independent',
      });
      await authorizeNanoHostPackage(coreDb, independent);
      const configRoot = join(
        coreDb.dataRoot,
        'workspaces',
        independent.scope.workspaceId,
        'config'
      );
      mkdirSync(configRoot, { recursive: true });
      writeFileSync(
        join(configRoot, 'workspace.jsonc'),
        JSON.stringify(
          WorkspaceConfigSchema.parse({
            schemaVersion: 1,
            workspace: { name: 'Independent admission fixture' },
          })
        )
      );
      const store = new FsStore({ dataRoot: coreDb.dataRoot });
      const turn = await store.createTurn(
        independent.scope.workspaceId,
        independent.scope.threadId,
        'Prepare an independent Worker.',
        independent.scope.triggerActor,
        undefined,
        {
          turnId: independent.scope.turnId,
          status: 'pending',
          agentId: independent.agent.agentId,
          executorKind: 'worker',
        }
      );
      const input = {
        agentSetup: createTestAgentSetup(),
        freshAgentSessionId: independent.scope.agentSessionId,
        requestId: 'request_missing_skill_independent',
        turn,
        turnInput: 'Prepare an independent Worker.',
        workspaceCwd: null,
        workspaceRoots: [],
      } satisfies PrepareAgentSessionForTurnInput;
      const executor = runtime.turnExecutor as WorkerGovernanceTurnExecutor;
      const expected = {
        agentSessionId: independent.scope.agentSessionId,
        currentAgentSession: null,
        replacementRequired: false,
      };
      await expect(executor.prepareAgentSessionForTurn(store, input)).resolves.toMatchObject(
        expected
      );
      const beforeEffects = [...effects];
      const beforeBindings = coreDb.sqlite
        .prepare('SELECT * FROM agent_session_runtime_bindings')
        .all();
      const beforeBackends = coreDb.sqlite.prepare('SELECT * FROM worker_backend_sessions').all();
      await expect(
        executor.prepareAgentSessionForTurn(store, {
          ...input,
          agentSetup: createTestAgentSetup({ skillIds: ['missing-admission-skill'] }),
        })
      ).rejects.toThrow('Worker supply catalog entry not found: skill:missing-admission-skill');
      expect(effects).toEqual(beforeEffects);
      expect(coreDb.sqlite.prepare('SELECT * FROM agent_session_runtime_bindings').all()).toEqual(
        beforeBindings
      );
      expect(coreDb.sqlite.prepare('SELECT * FROM worker_backend_sessions').all()).toEqual(
        beforeBackends
      );
      await expect(executor.prepareAgentSessionForTurn(store, input)).resolves.toMatchObject(
        expected
      );
      expect(effects).toEqual(beforeEffects);

      // Reproduce the retained Core facts after completed canonical Workspace deletion.
      // These disposable fixture bytes are gone; runtime retirement still belongs to the backend.
      const deletedRoot = join(coreDb.dataRoot, 'workspaces', environmentPackage.scope.workspaceId);
      const deletedDb = join(deletedRoot, 'db', 'workspace.sqlite');
      coreDb.sqlite
        .prepare(
          "UPDATE workspace_registry SET status = 'deleted', revision = revision + 2 WHERE workspace_id = ?"
        )
        .run(environmentPackage.scope.workspaceId);
      rmSync(deletedRoot, { recursive: true });
      expect(() => readFileSync(deletedDb)).toThrow(expect.objectContaining({ code: 'ENOENT' }));
      const preparation = await executor
        .prepareAgentSessionForTurn(store, input)
        .then((value) => ({ value, error: null }))
        .catch((error: unknown) => ({ value: null, error }));
      expect(preparation.error).toMatchObject({
        code: 'recovery_required',
        status: 409,
        message: expect.stringContaining(
          'The worker backend materialization capacity cannot be safely inspected.'
        ),
      });
      expect(JSON.stringify(preparation.error)).not.toContain(coreDb.dataRoot);
      expect((preparation.error as Error).message).toContain(
        'package-binding-lineage/workspace-deleted'
      );
      expect(() => readFileSync(deletedDb)).toThrow(expect.objectContaining({ code: 'ENOENT' }));
      expect(effects).toEqual(beforeEffects);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it.each([
    ['reuses the resident binding when supply is unchanged', 'same'],
    [
      'replaces the resident binding when only mcp changes and resumes its exact recorded pair',
      'mcp',
    ],
    [
      'replaces the resident binding when only native changes and resumes its exact recorded pair',
      'native',
    ],
    [
      'materializes two adapter-keyed Harnesses without creating a second compatible Sandbox',
      'adapters',
    ],
  ] as const)('%s', async (_title, change) => {
    const coreDb = createFactoryCoreDb();
    const dataRoot = coreDb.dataRoot;
    const ownerUserId = ensureLocalUser(coreDb);
    const environment = { NATIVE_SETTING: 'changed', EMPTY: '' };
    const sharedAdapters = change === 'adapters';
    const imageDigest = `sha256:${(sharedAdapters ? 'f' : 'a').repeat(64)}`;
    const labels = sharedAdapters
      ? ['codex', 'opencode', 'codex-next']
      : change === 'same'
        ? ['supply_same', 'supply_same_next']
        : ['supply_mcp', 'supply_mcp_successor'];
    const workspaceId = sharedAdapters
      ? 'ws_00000000-0000-763b-a723-89cbc100e1e6'
      : testEntityId('ws', `workspace_${labels[0]}`);
    const initialThreadId = testEntityId(
      'th',
      sharedAdapters ? 'thread-codex' : `thread_${labels[0]}`
    );
    const originalId = testEntityId(
      'as',
      sharedAdapters ? 'agent-session-codex' : `as_${labels[0]}`
    );
    const nextId = testEntityId(
      'as',
      sharedAdapters ? 'agent-session-opencode' : `as_${labels[1]}`
    );
    const store = new FsStore({ dataRoot });
    const fixture = createDemoWorkspaceForUser(ownerUserId);
    await store.importWorkspaceSnapshot({
      workspace: {
        ...fixture.workspace,
        id: workspaceId,
        counts: { threadCount: 1, artifactCount: 0, knowledgeEntryCount: 0 },
      },
      threads: [
        { ...fixture.thread, id: initialThreadId, owner: { kind: 'workspace', workspaceId } },
      ],
      turns: [],
      knowledge: [],
      agentSessions: [],
      artifacts: [],
      itemRevisions: [],
      turnEvents: [],
      ...notebookImportFixture({ workspaceId, knowledge: [], userId: ownerUserId }),
    });
    recordWorkspaceOwnerMembership({ coreDb, ownerUserId, workspaceId });
    const manifests = (sharedAdapters ? ['codex', 'opencode'] : ['codex']).map(
      (adapter) =>
        createTestAgentSetup({
          adapter,
          agentId: sharedAdapters ? `agent-${adapter}` : 'agent_codex_host',
          imageRef: imageDigest,
          requiredCapabilities: ['trusted-worker-inference-relay'],
        }).manifest
    );
    if (sharedAdapters)
      for (const manifest of manifests) admitTestNativeEnvironment(coreDb, manifest);
    let manifest = manifests[0]!;
    let configuration = createInMemoryRuntimeConfigSnapshot({ dataRoot });
    const native = createNativeTaskAdmissionFixture(coreDb, store, {
      readRuntimeConfig: () => configuration,
    });
    const commands: harnessRecords.NanoHostHarnessCommand[] = [];
    const results: Parameters<typeof native.runtime.acceptNanoHostHarnessResult>[0][] = [];
    const authorities: string[] = [];
    const loopbackAuthorities: string[] = [];
    let predecessorAtOpen: ReturnType<FsStore['getAgentSession']> | undefined;
    let closeAtOpen: (typeof results)[number] | undefined;
    const acceptResult = native.runtime.acceptNanoHostHarnessResult;
    const resultObservation = vi
      .spyOn(native.runtime, 'acceptNanoHostHarnessResult')
      .mockImplementation(async (result) => {
        await acceptResult(result);
        results.push(result);
      });
    const accept = native.runtime.acceptNanoHostHarnessCommand;
    const observation = vi
      .spyOn(native.runtime, 'acceptNanoHostHarnessCommand')
      .mockImplementation(async (command) => {
        const wire = await accept(command);
        // Keep credentials out of the retained command observation.
        const {
          agentSessionId,
          agentSessionRuntimeBindingId,
          turnId,
          leaseId,
          packageSnapshotId,
          resume,
          nativeEnvironment,
        } = wire.body;
        commands.push({
          ...wire,
          body: {
            agentSessionId,
            agentSessionRuntimeBindingId,
            turnId,
            leaseId,
            packageSnapshotId,
            resume,
            nativeEnvironment,
          },
        });
        if (!sharedAdapters && wire.operation === 'session.open' && agentSessionId === nextId) {
          predecessorAtOpen = store.getAgentSession(originalId);
          closeAtOpen = results.find(
            (result) =>
              result.operationId ===
              commands.find((c) => c.operation === 'session.close')?.operationId
          );
        }
        if (wire.operation === 'session.open')
          loopbackAuthorities.push(
            ...['capabilityLoopbackCredential', 'inferenceLoopbackCredential'].map((key) =>
              createHash('sha256').update(String(wire.body[key])).digest('hex')
            )
          );
        if (wire.operation === 'turn.start')
          authorities.push(
            ...['workerControlToken', 'inferenceToken', 'capabilityToken'].map((key) =>
              createHash('sha256').update(String(wire.body[key])).digest('hex')
            )
          );
        return wire;
      });
    const packages = new Map<string, string>();
    let originalPackage: AgentEnvironmentPackage | undefined;
    let resume: { locator: string; digest: string } | undefined;
    try {
      for (const [index, label] of labels.entries()) {
        // Supply retains one Thread; adapter sharing uses independent Thread-bound Sessions.
        const threadId = sharedAdapters ? testEntityId('th', `thread-${label}`) : initialThreadId;
        if (sharedAdapters) {
          if (index) await store.createThread(workspaceId, `Harness ${label}`, threadId);
          manifest = manifests[index === 1 ? 1 : 0]!;
        }
        if (index && change !== 'same' && !sharedAdapters) {
          if (change === 'mcp') {
            const owner = { kind: 'workspace' as const, workspaceId };
            const created = createMcpConfig({
              dataRoot,
              owner,
              id: 'added-mcp',
              displayName: 'Added MCP',
              selectCurrent: true,
              declaration: { kind: 'http', endpoint: 'https://mcp.example.invalid/mcp' },
              allowedTools: ['echo'],
              expectedRevision: loadResourceCatalog(dataRoot, owner).revision,
              createdAt: new Date().toISOString(),
            });
            updateMcpBinding({
              dataRoot,
              owner,
              entryId: 'added-mcp',
              expectedRevision: created.catalog.revision,
              binding: {
                ...created.catalog.mcp.bindings.find((binding) => binding.entryId === 'added-mcp')!,
                enabled: true,
              },
            });
            manifest = { ...manifest, mcp: [...manifest.mcp, { id: 'added-mcp' }] };
          } else manifest = { ...manifest, runtime: { ...manifest.runtime, environment } };
        }
        configuration = createInMemoryRuntimeConfigSnapshot({
          ...loadRuntimeConfig(dataRoot),
          agentManifests: sharedAdapters ? manifests : [manifest],
          gatewayConfig: createTestGatewayConfig(),
          providerRegistry: new ProviderRegistry([
            {
              id: 'agent-openrouter',
              displayName: 'Supply fixture',
              kind: 'local',
              models: ['openai/gpt-5.2'],
            },
          ]),
        });
        const turnId = testEntityId('tu', sharedAdapters ? `turn-${label}` : `turn_${label}`);
        const attemptId = testEntityId(
          'attempt',
          sharedAdapters ? `lease-${label}` : `lease_${label}`
        );
        const candidateId = sharedAdapters
          ? testEntityId('as', `agent-session-${label}`)
          : index
            ? nextId
            : originalId;
        const agentSessionId = change === 'same' ? originalId : candidateId;
        const selectedStorage =
          sharedAdapters && index
            ? getWorkerStorageBinding(coreDb, store.getAgentSession(originalId).retainedStorage!)
            : null;
        if (sharedAdapters && index) expect(selectedStorage).not.toBeNull();
        const entry = createSchedulerAdmissionEntry(coreDb, {
          backendId: 'nanohost',
          queueEntryId: `queue:${attemptId}`,
          requestId: testEntityId(
            'tu',
            sharedAdapters ? `request-${label}` : `request_${label}`
          ).slice(3),
          requestedAgentId: manifest.id,
          workspaceId,
          threadId,
          turnId,
          turnInput: sharedAdapters ? `Run ${label}` : index ? 'Run next fixture' : 'Run fixture',
          workerStorageChoice: selectedStorage
            ? {
                expectedRevision: selectedStorage.revision,
                goalId: null,
                kind: 'selected',
                purpose: 'work',
                storageRef: selectedStorage.storageRef,
                taskId: null,
              }
            : undefined,
          triggerActor: { kind: 'user', id: ownerUserId },
        });
        await publishFactoryAdmission(store, entry);
        const admitted = await native.admitTurn(entry, {
          attemptId,
          agentSessionId,
          candidateAgentSessionId: candidateId,
        });
        const { pkg } = admitted;
        try {
          expect(store.getTurnById(turnId)).toMatchObject({ agentSessionId, status: 'running' });
          expect(pkg.scope).toMatchObject({ agentSessionId, turnId, requestId: entry.requestId });
          if (sharedAdapters) {
            expect(pkg.scope).toMatchObject({
              threadId,
              workspaceId,
              triggerActor: entry.triggerActor,
            });
            expect(pkg.agent).toMatchObject({
              agentId: manifest.id,
              runtimeKind: manifest.runtime.kind,
            });
          }
          packages.set(attemptId, pkg.snapshotId);
          const opened = commands.find(
            (c) => c.operation === 'session.open' && c.body.agentSessionId === agentSessionId
          )!;
          const started = commands.find(
            (c) => c.operation === 'turn.start' && c.body.turnId === turnId
          )!;
          expect(opened.body.agentSessionRuntimeBindingId).toEqual(expect.any(String));
          expect(started.body).toMatchObject({
            agentSessionId,
            agentSessionRuntimeBindingId: opened.body.agentSessionRuntimeBindingId,
            turnId,
            leaseId: attemptId,
            packageSnapshotId: pkg.snapshotId,
          });
          expect(commands.indexOf(opened)).toBeLessThan(commands.indexOf(started));
          expect(opened.body.resume).toEqual(
            index && change !== 'same' && !sharedAdapters ? resume : null
          );
          expect(opened.body.nativeEnvironment).toEqual(
            index && change === 'native' ? environment : {}
          );
          expect(pkg.runtime.environment?.values).toEqual(opened.body.nativeEnvironment);
          if (originalPackage && !sharedAdapters) {
            expect(pkg.snapshotId).not.toBe(originalPackage.snapshotId);
            if (change === 'same')
              expect(sessionCompatibilityDigest(pkg)).toBe(
                sessionCompatibilityDigest(originalPackage)
              );
            else {
              // Core AgentSession Replacement: retirement and exact resume precede successor work.
              expect(predecessorAtOpen).toMatchObject({
                id: originalId,
                status: 'closed',
                nativeHandleDigest: resume!.digest,
              });
              expect(closeAtOpen).toMatchObject({
                disposition: 'succeeded',
                body: { state: 'closed', privateState: 'absent' },
              });
              expect(store.getAgentSession(originalId)).toMatchObject({
                status: 'closed',
                retainedStorage: store.getAgentSession(nextId).retainedStorage,
              });
              expect(started.body.agentSessionRuntimeBindingId).not.toBe(
                commands[0]!.body.agentSessionRuntimeBindingId
              );
            }
            expect(pkg.agent).toEqual(originalPackage.agent);
            const runtime = originalPackage.runtime;
            const expectedEnvironment =
              change === 'native'
                ? { ...runtime.environment!, values: environment }
                : runtime.environment;
            expect(pkg.runtime).toEqual({ ...runtime, environment: expectedEnvironment });
            if (change !== 'mcp') expect(pkg.supply).toEqual(originalPackage.supply);
            else {
              const selected = resolveWorkspaceMcpServer({
                catalog: configuration.workspaceMcpServerCatalogs.find(
                  (catalog) => catalog.workspaceId === workspaceId
                )!.catalog,
                serverId: 'added-mcp',
              });
              expect(pkg.supply).toEqual({
                ...originalPackage.supply,
                mcpServers: expect.arrayContaining([
                  ...originalPackage.supply.mcpServers,
                  {
                    id: 'added-mcp',
                    allowedTools: ['echo'],
                    catalogDigest: selected.catalogDigest,
                    pinnedSchemaSnapshotId: null,
                    schemaPolicy: 'tracking',
                  },
                ]),
              });
            }
            if (change === 'mcp')
              expect(pkg.supply.mcpServers).toHaveLength(
                originalPackage.supply.mcpServers.length + 1
              );
            expect(
              store
                .listThreadAgentSessions(workspaceId, threadId)
                .filter((session) => isCurrentAgentSessionStatus(session.status))
                .map((session) => session.id)
            ).toEqual([agentSessionId]);
          } else if (!originalPackage) originalPackage = pkg;
          expect((await admitted.complete()).startedTurns).toHaveLength(1);
          expect(store.getTurnById(turnId)).toMatchObject({ agentSessionId, status: 'completed' });
          expect(attempts.requireSchedulerExecutionAttempt(coreDb, attemptId)).toMatchObject({
            phase: 'closed',
            fenceRef: expect.any(String),
          });
          expect(native.executor.releaseResults[index]).toMatchObject({
            attemptId,
            inputRef: pkg.snapshotId,
            state: 'released',
            fenceRef: expect.any(String),
          });
          const resident = store.getAgentSession(agentSessionId);
          expect(resident).toMatchObject({
            status: 'idle',
            nativeHandleDigest: 'a'.repeat(64),
            retainedStorage: expect.any(Object),
          });
          if (!index) resume = { locator: resident.id, digest: resident.nativeHandleDigest! };
        } finally {
          await admitted.cleanup();
        }
      }
      const sessionIds = sharedAdapters
        ? labels.map((label) => testEntityId('as', `agent-session-${label}`))
        : change === 'same'
          ? [originalId]
          : [originalId, nextId];
      const operations: Record<string, number> = {};
      for (const command of commands) {
        expect(
          change === 'same' || sharedAdapters
            ? ['session.open', 'session.inspect', 'turn.start']
            : ['session.open', 'session.inspect', 'session.close', 'turn.start']
        ).toContain(command.operation);
        expect(sessionIds).toContain(command.body.agentSessionId);
        const started = commands.find(
          (c) =>
            c.operation === 'turn.start' && c.body.agentSessionId === command.body.agentSessionId
        )!;
        expect(command.harnessInstanceId).toBe(started.harnessInstanceId);
        expect(command.body.agentSessionRuntimeBindingId).toBe(
          started.body.agentSessionRuntimeBindingId
        );
        operations[command.operation] = (operations[command.operation] ?? 0) + 1;
      }
      expect(operations).toMatchObject(
        sharedAdapters
          ? { 'session.open': 3, 'turn.start': 3 }
          : change === 'same'
            ? { 'session.open': 1, 'turn.start': 2 }
            : { 'session.open': 2, 'session.close': 1, 'turn.start': 2 }
      );
      if (change !== 'same' && !sharedAdapters)
        expect(
          commands.find((command) => command.operation === 'session.close')!.body
        ).toMatchObject({
          agentSessionId: originalId,
          agentSessionRuntimeBindingId: commands[0]!.body.agentSessionRuntimeBindingId,
        });
      expect(new Set(commands.map((command) => command.operationId)).size).toBe(commands.length);
      if (sharedAdapters) {
        const starts = commands.filter((command) => command.operation === 'turn.start');
        expect(starts[0]!.harnessInstanceId).toBe(starts[2]!.harnessInstanceId);
        expect(starts[1]!.harnessInstanceId).not.toBe(starts[0]!.harnessInstanceId);
      } else if (change !== 'mcp')
        expect(new Set(commands.map((command) => command.harnessInstanceId)).size).toBe(1);
      expect(
        new Set(commands.map((command) => command.body.agentSessionRuntimeBindingId)).size
      ).toBe(sharedAdapters ? 3 : change === 'same' ? 1 : 2);
      expect(new Set(authorities).size).toBe(sharedAdapters ? 9 : 6);
      expect(new Set(loopbackAuthorities).size).toBe(
        sharedAdapters ? 6 : change === 'same' ? 2 : 4
      );
      expect(
        store.getTurnById(
          testEntityId('tu', sharedAdapters ? `turn-${labels[0]}` : `turn_${labels[0]}`)
        ).status
      ).toBe('completed');
      expect(store.getAgentSession(originalId)).toMatchObject({
        status: change === 'same' || sharedAdapters ? 'idle' : 'closed',
        nativeHandleDigest: resume!.digest,
      });
      if (sharedAdapters) {
        for (const [index, label] of labels.entries()) {
          const sessions = store.listThreadAgentSessions(
            workspaceId,
            testEntityId('th', `thread-${label}`)
          );
          expect(sessions).toMatchObject([{ id: sessionIds[index], status: 'idle' }]);
          expect(sessions).toHaveLength(1);
        }
        // Different Threads share the association and retain distinct mutable work slots.
        const storage = sessionIds.map((id) => store.getAgentSession(id).retainedStorage!);
        expect(new Set(storage.map((entry) => entry.storageRef)).size).toBe(1);
        expect(new Set(storage.map((entry) => entry.workSlotRef)).size).toBe(3);
      } else {
        const sessions = store.listThreadAgentSessions(workspaceId, initialThreadId);
        expect(sessions.map((session) => session.id).sort()).toEqual(sessionIds.sort());
      }
      expect(native.executor.inputs).toEqual(
        sharedAdapters
          ? ['Run codex', 'Run opencode', 'Run codex-next']
          : ['Run fixture', 'Run next fixture']
      );
      // R280: acquisition is authorized point-of-use work; inspection has no incidental count cap.
      const counts: Record<string, number> = {};
      for (const effect of native.effects) {
        counts[effect.kind] = (counts[effect.kind] ?? 0) + 1;
        if (effect.kind === 'image.acquire') {
          expect(effect.input.imageReference).toBe(imageDigest);
          expect(packages.has(String(effect.input.leaseId))).toBe(true);
          expect(effect.input.packageSnapshotId).toBe(packages.get(String(effect.input.leaseId)));
        } else if (effect.kind === 'image.inspect' || effect.kind === 'sandbox.create') {
          expect(counts['image.acquire'] ?? 0).toBeGreaterThan(0);
          if (effect.kind === 'image.inspect') expect(effect.input.imageDigest).toBe(imageDigest);
          else expect(counts['image.inspect'] ?? 0).toBeGreaterThan(0);
        }
      }
      const allowedEffects = [
        'image.acquire',
        'image.inspect',
        'sandbox.create',
        'bridge.open',
        'reference.import',
        'workspace.collect',
        'file.export',
      ].sort();
      if (sharedAdapters)
        for (const kind of Object.keys(counts)) expect(allowedEffects).toContain(kind);
      else expect(Object.keys(counts).sort()).toEqual(allowedEffects);
      expect(counts['image.acquire']).toBeGreaterThan(0);
      expect(counts).toMatchObject({ 'sandbox.create': 1, 'bridge.open': 1 });
      expect(new Set(native.effects.map((effect) => effect.requestId)).size).toBe(
        native.effects.length
      );
    } finally {
      observation.mockRestore();
      resultObservation.mockRestore();
      await native.restore();
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
        workspaceId: 'ws_00000000-0000-7734-9328-04bb0a013ecb',
      });
      const predecessor = reserveWorkerStorageAttachment(coreDb, {
        agentSessionId: testEntityId('as', 'as_restart_same_epoch_predecessor'),
        authorizeContributor: () => true,
        expectedRevision: createdStorage.revision,
        layout,
        purpose: 'work',
        responsibleUserId: 'usr_00000000-0000-7353-b5d8-71f1d581a738',
        runtimeTargetId: 'target_restart_same_epoch',
        storageRef: createdStorage.storageRef,
        threadId: 'th_00000000-0000-7980-ad21-84518466e2ab',
        workspaceId: 'ws_00000000-0000-7734-9328-04bb0a013ecb',
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
        workerStorageDefaultWorkSlotRef(
          'ws_00000000-0000-7734-9328-04bb0a013ecb',
          'th_00000000-0000-7721-81c5-55891e4c429c'
        )
      );
      const triggerActor = {
        kind: 'user' as const,
        id: 'usr_00000000-0000-7353-b5d8-71f1d581a738',
      };
      const packageResolution = {
        captureCoverage: { scope: 'server', value: 'off' } as const,
        agentSessionId: testEntityId('as', 'as_restart_same_epoch'),
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
          id: testEntityId('tu', 'turn_restart_same_epoch'),
          items: [],
          startedAt: '2026-08-21T00:00:00.000Z',
          status: 'running' as const,
          threadId: 'th_00000000-0000-7721-81c5-55891e4c429c',
          triggerActor,
          owner: { kind: 'workspace', workspaceId: 'ws_00000000-0000-7734-9328-04bb0a013ecb' },
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
        workerStorageDefaultWorkSlotRef(
          'ws_00000000-0000-7734-9328-04bb0a013ecb',
          'th_00000000-0000-7721-81c5-55891e4c429c'
        )
      );
      await authorizeNanoHostPackage(coreDb, environmentPackage);
      await new FsStore({ dataRoot: coreDb.dataRoot }).createThread(
        environmentPackage.scope.workspaceId,
        'Predecessor',
        'th_00000000-0000-7980-ad21-84518466e2ab'
      );
      bindNanoHostWorkerLineage(coreDb, environmentPackage, {
        attemptId: testEntityId('attempt', `lease-${environmentPackage.snapshotId}`),
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
        const { command } = await waitForFactoryHarnessCommand(coreDb);
        if (!command || command.operation !== operation) {
          throw new Error(`Expected queued ${operation} Harness command.`);
        }
        await firstRuntime.acceptNanoHostHarnessCommand(command);
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
        await firstRuntime.acceptNanoHostHarnessResult(result);
      };
      await anchorNanoHostMaterialization(coreDb, firstBackend, environmentPackage);
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
      await firstBackend.bindNativeHandleRecorder?.(environmentPackage.snapshotId, (digest) => {
        recordedDigests.push(digest);
      });
      const launch = submitTestNanoHostTurn(coreDb, firstBackend, materialization);
      await settleNext('session.open', {
        maxActiveTurns: 20,
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

      await closeFactoryAttempt(
        coreDb,
        testEntityId('attempt', `lease-${environmentPackage.snapshotId}`)
      );
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
          agentSessionId: testEntityId('as', 'as_cold_slot_absent'),
          threadId: 'th_00000000-0000-7d65-8e5e-41063cbfcd4f',
          turnId: testEntityId('tu', 'turn_cold_slot_absent'),
          workspaceId: 'ws_00000000-0000-74d8-aece-4769474f6ae5',
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
    const dataRoot = coreDb.dataRoot;
    const ownerUserId = ensureLocalUser(coreDb);
    const store = await createDemoStore({ dataRoot });
    const workspaceId = DEMO_WORKSPACE_ID;
    const workspaceDb = openWorkspaceDb(dataRoot, workspaceId);
    recordWorkspaceOwnerMembership({ coreDb, ownerUserId, workspaceId });
    const setup = createTestAgentSetup({
      imageRef: `sha256:${'6'.repeat(64)}`,
      requiredCapabilities: ['trusted-worker-inference-relay'],
    });
    const manifest: typeof setup.manifest = {
      ...setup.manifest,
      workspace: { inputs: [{ access: 'read-write', id: 'repo', sourceRef: 'main-repo' }] },
    };
    const readRuntimeConfig = () =>
      createInMemoryRuntimeConfigSnapshot({
        ...loadRuntimeConfig(dataRoot),
        agentManifests: [manifest],
        gatewayConfig: createTestGatewayConfig(),
        providerRegistry: new ProviderRegistry([
          {
            id: 'agent-openrouter',
            displayName: 'Selected slot fixture',
            kind: 'local',
            models: ['openai/gpt-5.2'],
          },
        ]),
        workspaceDataSourceCatalogs: [
          {
            workspaceId,
            path: join(dataRoot, 'workspaces', workspaceId, 'data-sources.json'),
            catalog: {
              schemaVersion: 1,
              requiredFeatures: [],
              extensions: {},
              sources: [
                {
                  access: 'read-write',
                  allowedSlotKinds: ['worktree'],
                  displayName: 'Main repository',
                  id: 'main-repo',
                  kind: 'git',
                  locator: {
                    commit: 'a'.repeat(40),
                    url: 'https://example.invalid/repository.git',
                  },
                  sensitivity: 'internal',
                  status: 'active',
                  vaultGrantRef: null,
                  requiredFeatures: [],
                  extensions: {},
                  syncHints: {},
                },
              ],
            },
          },
        ],
      });
    const native = createNativeTaskAdmissionFixture(coreDb, store, {
      readRuntimeConfig,
      workspaceGitBaseline: {
        commit: 'a'.repeat(40),
        tree: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
      },
    });
    const commands = vi.spyOn(native.runtime, 'acceptNanoHostHarnessCommand');
    const joins: Array<() => Promise<void>> = [];
    const thread = async (label: string) =>
      (await store.createThread(workspaceId, label, testEntityId('th', `selected_slot_${label}`)))
        .id;
    const entryFor = async (
      label: string,
      threadId: string,
      choice?: SchedulerWorkerStorageChoice
    ) => {
      const entry = createSchedulerAdmissionEntry(coreDb, {
        backendId: 'nanohost',
        queueEntryId: `queue:selected-slot-${label}`,
        requestId: testEntityId('tu', `request_selected_slot_${label}`).slice(3),
        requestedAgentId: manifest.id,
        workspaceId,
        threadId,
        turnId: testEntityId('tu', `selected_slot_${label}`),
        turnInput: `Continue retained work ${label}`,
        workerStorageChoice: choice,
        triggerActor: { kind: 'user', id: ownerUserId },
        workspaceCwd: null,
        workspaceRoots: [
          {
            access: 'read-write',
            id: 'repo',
            sourceKind: 'remote-git',
            sourceCommit: 'a'.repeat(40),
            workerPath: '/workspace/legacy-root',
          },
        ],
      });
      await publishFactoryAdmission(store, entry);
      return entry;
    };
    // The public scheduler carries authored source admission; the existing fixture owns the peer.
    const dispatch = (entry: Awaited<ReturnType<typeof entryFor>>) =>
      runSchedulerDispatchLoop({
        coreDb,
        store,
        turnExecutor: native.executor,
        executionBackend: native.executor.executionBackend!,
        ...readRuntimeConfig(),
        maxDispatches: 1,
        createAttemptId: () => testEntityId('attempt', `selected_slot_${entry.turnId}`),
        createAgentSessionId: () => testEntityId('as', `selected_slot_${entry.turnId}`),
      });
    const run = async (entry: Awaited<ReturnType<typeof entryFor>>, expectedSessionId?: string) => {
      const work = native.executionFor(entry.turnId);
      const execution = dispatch(entry);
      let launched = false;
      joins.push(async () => {
        work.completion.resolve();
        await execution.catch(() => undefined);
        if (launched) await work.execution.catch(() => undefined);
      });
      await Promise.race([
        work.launched.promise,
        execution.then((result) => {
          if (!result.startedTurns.length)
            throw new Error('Expected native selected-slot admission.');
          return work.launched.promise;
        }),
      ]);
      launched = true;
      const attempt = attempts.requireSchedulerExecutionAttempt(
        coreDb,
        testEntityId('attempt', `selected_slot_${entry.turnId}`)
      );
      const sessionId = expectedSessionId ?? testEntityId('as', `selected_slot_${entry.turnId}`);
      const pkg = requireAgentEnvironmentPackageSnapshot(
        workspaceDb,
        workspaceId,
        attempt.inputRef!
      ).snapshot;
      expect(pkg.scope).toMatchObject({
        workspaceId,
        threadId: entry.threadId,
        turnId: entry.turnId,
        requestId: entry.requestId,
        agentSessionId: sessionId,
      });
      const start = commands.mock.calls.find(
        ([command]) => command.operation === 'turn.start' && command.body.turnId === entry.turnId
      )![0];
      expect(start.body).toMatchObject({
        agentSessionId: sessionId,
        leaseId: attempt.attemptId,
        packageSnapshotId: pkg.snapshotId,
      });
      work.completion.resolve();
      expect((await execution).startedTurns).toHaveLength(1);
      await work.execution;
      expect(store.getTurnById(entry.turnId)).toMatchObject({
        status: 'completed',
        agentSessionId: sessionId,
      });
      const session = store.getAgentSession(sessionId);
      expect(session).toMatchObject({ status: 'idle', nativeHandleDigest: 'a'.repeat(64) });
      const closed = attempts.requireSchedulerExecutionAttempt(coreDb, attempt.attemptId);
      expect(closed).toMatchObject({ phase: 'closed', fenceRef: expect.any(String) });
      return { entry, pkg, session, start };
    };
    const assertWorktree = (pkg: AgentEnvironmentPackage, slot: string) => {
      expect(pkg.workspace.inputs[0]).toMatchObject({
        target: `/workspace/worktrees/${slot}`,
        source: {
          kind: 'git',
          commit: 'a'.repeat(40),
          url: 'https://example.invalid/repository.git',
        },
      });
      expect(pkg.runtime.command.workingDirectory).toBe(`/workspace/worktrees/${slot}`);
    };
    try {
      const p = await thread('p');
      const prior = await run(await entryFor('p', p));
      const original = prior.session.retainedStorage!;
      const selectedWorkSlotRef = original.workSlotRef;
      expect(selectedWorkSlotRef).toBe(workerStorageDefaultWorkSlotRef(workspaceId, p));
      assertWorktree(prior.pkg, selectedWorkSlotRef);
      const donor = getWorkerStorageBinding(coreDb, original)!;
      const a = await thread('a');
      const first = await run(
        await entryFor('a', a, {
          kind: 'selected',
          storageRef: original.storageRef,
          expectedRevision: donor.revision,
          reuseWorkSlotRef: selectedWorkSlotRef,
          purpose: 'work',
          goalId: null,
          taskId: null,
        })
      );
      expect(workerStorageDefaultWorkSlotRef(workspaceId, a)).not.toBe(selectedWorkSlotRef);
      assertWorktree(first.pkg, selectedWorkSlotRef);
      expect(first.session.retainedStorage).toEqual({
        ...original,
        attachmentGeneration: getWorkerStorageBinding(coreDb, original)!.attachmentGeneration,
      });
      expect(getWorkerStorageBinding(coreDb, original)).toMatchObject({
        state: 'attached',
        currentWorkSlotRef: selectedWorkSlotRef,
        targets: donor.targets,
      });
      const opensBeforeB = commands.mock.calls.filter(
        ([c]) => c.operation === 'session.open'
      ).length;
      const beforeB = getWorkerStorageBinding(coreDb, original);
      const second = await run(await entryFor('b', a), first.session.id);
      expect(second.entry.workerStorageChoice).toBeNull();
      assertWorktree(second.pkg, selectedWorkSlotRef);
      expect(second.session.retainedStorage).toEqual(first.session.retainedStorage);
      expect(second.session.id).toBe(first.session.id);
      expect(second.start.body.agentSessionRuntimeBindingId).toBe(
        first.start.body.agentSessionRuntimeBindingId
      );
      expect(second.pkg.snapshotId).not.toBe(first.pkg.snapshotId);
      expect(second.entry.requestId).not.toBe(first.entry.requestId);
      expect(commands.mock.calls.filter(([c]) => c.operation === 'session.open')).toHaveLength(
        opensBeforeB
      );
      expect(getWorkerStorageBinding(coreDb, original)).toEqual(beforeB);
      const commandWires = await Promise.all(
        commands.mock.results.flatMap((result) => (result.type === 'return' ? [result.value] : []))
      );
      const startAuthorities = commandWires.flatMap((wire) =>
        wire.operation === 'turn.start'
          ? [createHash('sha256').update(String(wire.body.workerControlToken)).digest('hex')]
          : []
      );
      expect(new Set(startAuthorities).size).toBe(3);
      expect(
        harnessRecords.readNanoHostThreadAgentSessionBinding(coreDb, { workspaceId, threadId: a })
      ).toEqual({ agentSessionId: first.session.id });

      const freshChoice = { kind: 'fresh' as const, goalId: null, taskId: null };
      const conflict = await entryFor('fresh_conflict', a, freshChoice);
      const oldSession = store.getAgentSession(first.session.id);
      const history = requireAgentEnvironmentPackageSnapshot(
        workspaceDb,
        workspaceId,
        second.pkg.snapshotId
      );
      const beforeConflict = [native.effects.length, commands.mock.calls.length];
      const storageBefore = listWorkerStorageBindings(coreDb, {
        workspaceId,
        authorizeContributor: () => true,
      });
      await expect(dispatch(conflict)).rejects.toMatchObject({
        code: 'worker_storage_choice_conflict',
      });
      expect(store.getTurnById(conflict.turnId)).toMatchObject({
        status: 'failed',
        error: { code: 'worker_preparation_failed' },
      });
      expect([native.effects.length, commands.mock.calls.length]).toEqual(beforeConflict);
      expect(store.getAgentSession(first.session.id)).toEqual(oldSession);
      expect(
        listWorkerStorageBindings(coreDb, { workspaceId, authorizeContributor: () => true })
      ).toEqual(storageBefore);
      expect(
        requireAgentEnvironmentPackageSnapshot(workspaceDb, workspaceId, second.pkg.snapshotId)
      ).toEqual(history);
      const c = await thread('fresh');
      const fresh = await run(await entryFor('fresh', c, freshChoice));
      expect(fresh.session.retainedStorage!.storageRef).not.toBe(original.storageRef);
      expect(fresh.session.retainedStorage!.workSlotRef).toBe(
        workerStorageDefaultWorkSlotRef(workspaceId, c)
      );
      assertWorktree(fresh.pkg, workerStorageDefaultWorkSlotRef(workspaceId, c));
      const u = await thread('unrelated');
      const unrelated = await run(await entryFor('unrelated', u));
      expect(unrelated.entry.workerStorageChoice).toBeNull();
      expect([original.storageRef, fresh.session.retainedStorage!.storageRef]).not.toContain(
        unrelated.session.retainedStorage!.storageRef
      );
      expect(unrelated.session.retainedStorage!.workSlotRef).toBe(
        workerStorageDefaultWorkSlotRef(workspaceId, u)
      );
      assertWorktree(unrelated.pkg, workerStorageDefaultWorkSlotRef(workspaceId, u));
      expect(
        new Set([prior.session.id, first.session.id, fresh.session.id, unrelated.session.id]).size
      ).toBe(4);
      for (const { session } of [prior, first, fresh, unrelated]) {
        const open = commands.mock.calls.find(
          ([command]) =>
            command.operation === 'session.open' && command.body.agentSessionId === session.id
        )![0];
        expect(open.body).toMatchObject({ resume: null });
      }
      // Storage reaches the peer through each admitted AEP, never through a Session control body.
      for (const [command] of commands.mock.calls.filter(([c]) => c.operation === 'session.open')) {
        expect(command.body).not.toHaveProperty('storageRef');
        expect(command.body).not.toHaveProperty('workSlotRef');
      }
      expect(getWorkerStorageBinding(coreDb, original)?.state).toBe('idle');
      expect(getWorkerStorageBinding(coreDb, fresh.session.retainedStorage!)?.state).toBe('idle');
    } finally {
      for (const join of joins) await join();
      commands.mockRestore();
      await native.restore();
      await shutdownControlStoreWorkerClient();
      workspaceDb.sqlite.close();
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
      backend.requireAttemptId = () => testEntityId('attempt', 'lease_absent_cleanup');
      const environmentPackage = completeNanoHostPackage({
        scope: {
          agentSessionId: testEntityId('as', 'as_absent_cleanup'),
          threadId: 'th_00000000-0000-7a35-b70b-6c17df884783',
          turnId: testEntityId('tu', 'turn_absent_cleanup'),
          workspaceId: 'ws_00000000-0000-76f3-9adf-5651f3be6dfc',
        },
        snapshotId: 'aepsnap_absent_cleanup',
      });
      await authorizeNanoHostPackage(coreDb, environmentPackage);
      bindNanoHostWorkerLineage(coreDb, environmentPackage, {
        attemptId: testEntityId('attempt', 'lease_absent_cleanup'),
        sandboxBindingRef: 'sandbox-binding-absent-cleanup',
      });
      const identity = backend.planSession(environmentPackage);
      await anchorNanoHostMaterialization(coreDb, backend, environmentPackage);
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
      backend.requireAttemptId = () => testEntityId('attempt', 'lease_pending_cleanup');
      const environmentPackage = completeNanoHostPackage({
        scope: {
          agentSessionId: testEntityId('as', 'as_pending_cleanup'),
          threadId: 'th_00000000-0000-763f-8a74-8d8ab0efa3c7',
          turnId: testEntityId('tu', 'turn_pending_cleanup'),
          workspaceId: 'ws_00000000-0000-7749-aa22-245c0564b3b2',
        },
        snapshotId: 'aepsnap_pending_cleanup',
      });
      await authorizeNanoHostPackage(coreDb, environmentPackage);
      bindNanoHostWorkerLineage(coreDb, environmentPackage, {
        attemptId: testEntityId('attempt', 'lease_pending_cleanup'),
        sandboxBindingRef: 'lease-binding:pending-cleanup',
      });
      const identity = backend.planSession(environmentPackage);
      await anchorNanoHostMaterialization(coreDb, backend, environmentPackage);
      transitionWorkerBackendSessionState(coreDb, {
        attemptId: testEntityId('attempt', 'lease_pending_cleanup'),
        fromState: 'materializing',
        toState: 'cleanup-pending',
      });
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
        responsibleUserId: 'usr_00000000-0000-7353-b5d8-71f1d581a738',
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
        agentSessionId: testEntityId('as', 'as_sibling_cleanup'),
        expectedRevision: siblingCreated.revision,
        storageRef: siblingCreated.storageRef,
        threadId: 'th_00000000-0000-7d26-a570-f586e40d63eb',
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
          readonly backend: WorkerGovernanceBackend;
        }
      ).backend;
      const environmentPackage = completeNanoHostPackage({
        scope: {
          agentSessionId: testEntityId('as', 'as_reserved_cleanup'),
          threadId: 'th_00000000-0000-7f8f-9c18-44d0901cf5ef',
          turnId: testEntityId('tu', 'turn_reserved_cleanup'),
          workspaceId: 'ws_00000000-0000-7112-91c0-28c0825f328a',
        },
        snapshotId: 'aepsnap_reserved_cleanup',
      });
      await authorizeNanoHostPackage(coreDb, environmentPackage);
      const identity = backend.planSession(environmentPackage);
      const attemptId = testEntityId('attempt', 'lease_reserved_cleanup');
      const sandboxBindingRef = 'lease-binding:reserved-cleanup';
      const entry = createSchedulerAdmissionEntry(coreDb, {
        backendId: 'nanohost',
        queueEntryId: `queue:${attemptId}`,
        requestId: environmentPackage.scope.requestId,
        requestedAgentId: environmentPackage.agent.agentId,
        triggerActor: environmentPackage.scope.triggerActor,
        workspaceId: environmentPackage.scope.workspaceId,
        threadId: environmentPackage.scope.threadId,
        turnId: environmentPackage.scope.turnId,
        turnInput: 'Recover the original no-Sandbox storage reservation.',
        now: () => failureAt,
      });
      recordTestExecutionAttempt(coreDb, {
        entry,
        attemptId,
        agentSessionId: identity.agentSessionId,
        inputRef: identity.packageSnapshotId,
        bindingRef: sandboxBindingRef,
        sessionCompatibilityKey: (
          environmentPackage.extensions.openkit as {
            sessionWorkspace: SessionWorkspaceMaterializationPlan;
          }
        ).sessionWorkspace.compatibilityKey.digest,
        now: () => failureAt,
      });
      recordWorkerBackendSessionMaterializing(coreDb, {
        identity,
        backendVersion: '0.0.99',
        backendLineage: { kind: 'reference', imageRef: 'openkit/worker-codex:dev' },
        sandboxBindingRef,
        lineage: {
          workspaceId: environmentPackage.scope.workspaceId,
          threadId: environmentPackage.scope.threadId,
          turnId: environmentPackage.scope.turnId,
        },
        now: () => failureAt,
      });
      transitionWorkerBackendSessionState(coreDb, {
        attemptId,
        fromState: 'materializing',
        toState: 'cleanup-pending',
        now: () => failureAt,
      });
      transitionWorkerBackendSessionState(coreDb, {
        attemptId,
        fromState: 'cleanup-pending',
        toState: 'cleanup-failed',
        now: () => failureAt,
      });
      attempts.markSchedulerExecutionAttemptClosing(coreDb, {
        attemptId,
        cause: 'turn-start-failed',
        now: () => failureAt,
      });
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
        responsibleUserId: 'usr_00000000-0000-7353-b5d8-71f1d581a738',
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
        responsibleUserId: 'usr_00000000-0000-7353-b5d8-71f1d581a738',
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
        const result = new Promise<never>((_, reject) => resultOnlyRejectors.push(reject));
        // Keep the controlled failure observable before the recovery owner awaits it.
        void result.catch(() => undefined);
        return result;
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
      initialBackend.requireAttemptId = () => testEntityId('attempt', 'lease_post_fence');
      const environmentPackage = completeNanoHostPackage({
        scope: {
          agentSessionId: testEntityId('as', 'as_post_fence'),
          threadId: 'th_00000000-0000-7c74-9ab7-ed20fc758df8',
          turnId: testEntityId('tu', 'turn_post_fence'),
          workspaceId: 'ws_00000000-0000-7199-922f-b9ab14e4af98',
        },
        snapshotId: 'aepsnap_post_fence',
      });
      await authorizeNanoHostPackage(coreDb, environmentPackage);
      bindNanoHostWorkerLineage(coreDb, environmentPackage, {
        attemptId: testEntityId('attempt', 'lease_post_fence'),
        sandboxBindingRef: 'lease-binding:post-fence',
      });
      const identity = initialBackend.planSession(environmentPackage);
      await anchorNanoHostMaterialization(coreDb, initialBackend, environmentPackage);
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
        threadId: 'th_00000000-0000-7c74-9ab7-ed20fc758df8',
        workspaceId: 'ws_00000000-0000-7199-922f-b9ab14e4af98',
      });
      transitionWorkerBackendSessionState(coreDb, {
        attemptId: testEntityId('attempt', 'lease_post_fence'),
        fromState: 'materializing',
        toState: 'cleanup-pending',
      });
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
      restartedBackend.requireAttemptId = () => testEntityId('attempt', 'lease_post_fence');

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
        agentSessionId: testEntityId('as', 'as_lookup_none'),
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
          agentSessionId: testEntityId('as', 'as_lookup_ambiguous'),
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
             '${testEntityId('attempt', 'lease_lookup_worker')}', 'ws_00000000-0000-7372-b5d3-9ed01d53b7fc', 'th_00000000-0000-75af-a582-f592a850d0e6',
             'tu_00000000-0000-7963-abd2-3651e8c769fa', 'as_00000000-0000-7076-8b53-ad40211a7a2a', 'aepsnap_lookup_worker', 'openshell',
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
        agentSessionId: testEntityId('as', 'as_lookup_worker'),
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
        agentSessionId: testEntityId('as', 'as_lookup_agent'),
        agentSessionRuntimeBindingId: 'binding-lookup-agent',
        effectiveSetupGeneration: 1,
        harnessInstanceId: 'harness-lookup-agent',
        threadId: 'th_00000000-0000-745f-8011-8eeba156aed6',
        timestamp: '2026-08-21T00:00:00.000Z',
        workspaceId: 'ws_00000000-0000-7372-b5d3-9ed01d53b7fc',
      });
      const agentIdentity: WorkerGovernanceBackendSessionIdentity = {
        ...nonProjectingIdentity,
        agentSessionId: testEntityId('as', 'as_lookup_agent'),
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

  it('keys shared Sandboxes by static isolation inputs, with private Context and output namespaces', () => {
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
                  'ws_00000000-0000-7b28-a22f-e9264be03c98',
                  `${testEntityId('th', `thread-${turnId}`)}`
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
                  workerPath: `/openkit/sessions/${testEntityId('as', `agent-session-${turnId}`)}/context`,
                },
              ],
            },
          },
          resources: {},
          runtime: { image: { kind: 'reference', ref: 'openkit/worker:test' } },
          schemaVersion: 4,
          scope: {
            agentSessionId: testEntityId('as', `agent-session-${turnId}`),
            threadId: testEntityId('th', `thread-${turnId}`),
            triggerActor: {
              kind: 'user',
              id: overrides.actorId ?? 'usr_00000000-0000-762e-acbb-d80b6f0e8f34',
            },
            turnId: testEntityId('tu', `turn-${turnId}`),
            workspaceId: 'ws_00000000-0000-7b28-a22f-e9264be03c98',
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
                target: `/openkit/sessions/${testEntityId('as', `agent-session-${turnId}`)}/config/package.json`,
              },
            ],
            inputs: [
              {
                access: 'read-only',
                id: `context_${testEntityId('tu', `turn-${turnId}`)}`,
                kind: 'generated',
                materialization: {
                  contentDigest: `sha256:${turnId.repeat(64).slice(0, 64)}`,
                  slotId: 'context',
                  strategy: 'filesystem',
                },
                source: {
                  kind: 'generated',
                  pathRef: `threads/${testEntityId('th', `thread-${turnId}`)}/turns/${testEntityId('tu', `turn-${turnId}`)}/context-package`,
                },
                target: `/openkit/sessions/${testEntityId('as', `agent-session-${turnId}`)}/context`,
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
            outputs: [
              {
                id: 'turn-output-root',
                path: `/openkit/sessions/${testEntityId('as', `agent-session-${turnId}`)}/outputs`,
                registerAsArtifacts: true,
                retention: 'sync-on-turn-end',
              },
            ],
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
      expect(
        keyFor(packageFor('c', { actorId: 'usr_00000000-0000-7de9-993f-8088d6e797b7' }))
      ).not.toBe(baseline);
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

  it.each([
    { route: 'grant', binding: 'busy', cleanupUnknown: false },
    { route: 'reference', binding: 'idle', cleanupUnknown: false },
    { route: 'server-reference', binding: 'idle', cleanupUnknown: false },
    { route: 'narrow', binding: 'idle', cleanupUnknown: false },
    { route: 'grant', binding: 'idle', cleanupUnknown: true },
    { route: 'grant', binding: 'launching', cleanupUnknown: false },
    { route: 'grant', binding: 'idle-after-no-effect', cleanupUnknown: false },
    { route: 'grant', binding: 'sibling-closeout', cleanupUnknown: false },
    { route: 'grant', binding: 'sibling-late-drain', cleanupUnknown: false },
    { route: 'grant', binding: 'idle-contradiction', cleanupUnknown: false },
  ] as const)('closes runtime-env exposure through public $route revocation ($binding, unknown cleanup: $cleanupUnknown)', async ({
    route,
    binding,
    cleanupUnknown,
  }) => {
    const coreDb = createFactoryCoreDb();
    const ownerUserId = ensureLocalUser(coreDb);
    const store = await createDemoStore({ dataRoot: coreDb.dataRoot });
    const workspaceId = DEMO_WORKSPACE_ID;
    recordWorkspaceOwnerMembership({ coreDb, workspaceId, ownerUserId });
    const label = `credential-revoke-${route}-${binding}-${cleanupUnknown}`;
    const serverReference = route === 'server-reference';
    const owner = serverReference
      ? { ownerScope: 'server' as const }
      : { ownerScope: 'workspace' as const, workspaceId };
    const referenceId = testEntityId('vault', label);
    const grantId = testEntityId('grant', label);
    const agentSessionId = testEntityId('as', label);
    const attemptId = testEntityId('attempt', label);
    const secret = 'private-runtime-revocation-canary';
    const vaultUnlockState = createVaultUnlockState({
      backendKind: 'encrypted-file',
      storeDir: join(coreDb.dataRoot, 'server', 'vault'),
    });
    vaultUnlockState.unlock({ masterKey: Buffer.alloc(32, 27) });
    vaultUnlockState.backend().store({
      referenceId,
      material: secret,
      metadata: owner,
    });
    createVaultReference(coreDb, {
      referenceId,
      ...owner,
      displayName: serverReference ? 'Shared MCP credential' : 'Runtime revocation fixture',
      secretKind: serverReference ? 'mcp-credential' : 'github-token',
      backendKind: 'encrypted-file',
      backendLocator: serverReference
        ? `encrypted-file://server/vault/${referenceId}`
        : `encrypted-file://workspace/${workspaceId}/vault/${referenceId}`,
    });
    createVaultGrant(coreDb, {
      grantId,
      vaultReferenceId: referenceId,
      ...owner,
      allowedInjectionPaths: ['runtime-env'],
      lifetime: serverReference ? 'agent-session' : 'workspace',
      ...(serverReference ? { targetAgentSessionId: agentSessionId } : {}),
    });
    const setup = createTestAgentSetup({
      requiredCapabilities: ['trusted-worker-inference-relay'],
    });
    const runtimeConfig = loadRuntimeConfig(coreDb.dataRoot);
    const configuration = createInMemoryRuntimeConfigSnapshot({
      ...runtimeConfig,
      agentManifests: [
        {
          ...setup.manifest,
          sandbox: {
            ...setup.manifest.sandbox,
            credentialDeclarations: serverReference
              ? [
                  {
                    id: 'revocable_token',
                    vaultGrantId: grantId,
                    visibility: 'runtime-env',
                    targetEnvVarName: 'GITHUB_TOKEN',
                  },
                ]
              : [
                  {
                    id: 'revocable_token',
                    requirementId: 'revocable-token',
                    purpose: 'Exercise Workspace credential revocation on a native resident.',
                    required: true,
                    visibility: 'runtime-env',
                    targetEnvVarName: 'GITHUB_TOKEN',
                  },
                ],
          },
        },
      ],
      workspaceConfigs: [
        ...runtimeConfig.workspaceConfigs.filter((entry) => entry.workspaceId !== workspaceId),
        {
          workspaceId,
          path: join(coreDb.dataRoot, 'workspaces', workspaceId, 'workspace.yaml'),
          config: WorkspaceConfigSchema.parse({
            schemaVersion: 1,
            workspace: {
              name: 'Runtime revocation fixture',
              agents: [
                {
                  agentId: setup.manifest.id,
                  credentialBindings: serverReference
                    ? []
                    : [{ requirementId: 'revocable-token', vaultGrantId: grantId }],
                },
              ],
            },
          }),
        },
      ],
      gatewayConfig: createTestGatewayConfig(),
      providerRegistry: new ProviderRegistry([
        {
          id: 'agent-openrouter',
          displayName: 'Revocation fixture',
          kind: 'local',
          models: ['openai/gpt-5.2'],
        },
      ]),
      openKitConfig: {
        defaults: { defaultAgentId: setup.manifest.id },
        ...(binding === 'sibling-closeout' || binding === 'sibling-late-drain'
          ? { nanohost: { maxActiveTurnsPerSandbox: 2 } }
          : {}),
      },
    });
    const native = createNativeTaskAdmissionFixture(coreDb, store, {
      readRuntimeConfig: () => configuration,
      vaultBackend: () => vaultUnlockState.backend(),
    });
    const acceptCommand = native.runtime.acceptNanoHostHarnessCommand.bind(native.runtime);
    const commands = vi.spyOn(native.runtime, 'acceptNanoHostHarnessCommand');
    const app = createAppWithWorkspaceAuthority({
      coreDb,
      dataRoot: coreDb.dataRoot,
      store,
      turnExecutor: native.executor,
      runtimeConfigManager: createRuntimeConfigManager({
        dataRoot: coreDb.dataRoot,
        initialSnapshot: configuration,
      }),
      fileAdmission: native.fileAdmission,
      workerControlGateway: native.workerControlGateway,
      vaultUnlockState,
    });
    let admitted: Awaited<ReturnType<typeof native.admitTurn>> | undefined;
    let originalBackendSessionId: string | undefined;
    try {
      const entry = createSchedulerAdmissionEntry(coreDb, {
        backendId: 'nanohost',
        queueEntryId: `queue:${label}`,
        requestId: testEntityId('tu', `request-${label}`).slice(3),
        requestedAgentId: setup.manifest.id,
        workspaceId,
        threadId: DEMO_THREAD_ID,
        turnId: testEntityId('tu', label),
        turnInput: 'Keep the credential-bearing resident binding available.',
        triggerActor: { kind: 'user', id: ownerUserId },
      });
      await publishFactoryAdmission(store, entry);
      if (binding === 'launching') {
        const submitEntered = Promise.withResolvers<void>();
        const allowSubmit = Promise.withResolvers<void>();
        let held = false;
        commands.mockImplementation(async (command) => {
          const wire = await acceptCommand(command);
          if (command.operation === 'turn.start' && !held) {
            held = true;
            submitEntered.resolve();
            await allowSubmit.promise;
          }
          return wire;
        });
        const admission = native.admitTurn(entry, {
          attemptId,
          agentSessionId,
          candidateAgentSessionId: agentSessionId,
        });
        void admission.catch(() => undefined);
        let revocation: Promise<Response> | undefined;
        try {
          await Promise.race([
            submitEntered.promise,
            admission.then(() => {
              throw new Error('The native submission did not reach the held boundary.');
            }),
          ]);
          const opened = await commands.mock.results.find(
            (result, index) =>
              result.type === 'return' &&
              commands.mock.calls[index]![0].operation === 'session.open'
          )!.value;
          expect(opened.body.runtimeEnvironment).toEqual({ GITHUB_TOKEN: secret });
          expect(
            [...native.outside.bindings.values()].flatMap((sessions) => [...sessions.values()])
          ).toEqual([expect.objectContaining({ state: 'open' })]);
          expect(listVaultInjectionReceipts(coreDb)).toEqual([]);
          const plans = listVaultInjectionPlans(coreDb);
          expect(plans).toEqual([
            expect.objectContaining({ grantId, injectionVisibility: 'runtime-env' }),
          ]);
          let successWithLiveExposure = false;
          revocation = app
            .request(
              ...operationRequest(
                'vault.grant-revoke',
                {},
                {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ workspaceId, grantId }),
                }
              )
            )
            .then((response) => {
              // Core Vault lifecycle 5/7: no receipt is not proof that the exposed binding is absent.
              successWithLiveExposure =
                response.ok &&
                [...native.outside.bindings.values()].some((sessions) =>
                  [...sessions.values()].some((session) => session.state !== 'closed')
                );
              return response;
            });
          void revocation.catch(() => undefined);
          await vi.waitFor(() => expect(getVaultGrant(coreDb, grantId)?.status).toBe('revoked'));
          allowSubmit.resolve();
          // The peer can report its final only after it accepts start or records refusal.
          await native.executionFor(entry.turnId).launched.promise.catch(() => undefined);
          native.executionFor(entry.turnId).completion.resolve();
          admitted = await admission.catch(() => undefined);
          const response = await revocation;
          await admitted?.execution.catch(() => undefined);
          expect(successWithLiveExposure).toBe(false);
          expect(
            listVaultInjectionReceipts(coreDb).filter(
              (receipt) => receipt.grantId === grantId && receipt.revocationStatus === 'active'
            )
          ).toEqual([]);
          for (const { status: _projection, ...original } of plans)
            expect(listVaultInjectionPlans(coreDb)).toEqual(
              expect.arrayContaining([expect.objectContaining(original)])
            );
          if (response.ok) {
            expect(
              [...native.outside.bindings.values()].flatMap((sessions) => [...sessions.values()])
            ).toEqual([expect.objectContaining({ state: 'closed' })]);
            expect(
              coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM sandbox_runtime_records').get()
            ).toEqual({ count: 0 });
          } else {
            expect(response.status).toBe(409);
            await expect(response.clone().json()).resolves.toMatchObject({
              code: 'recovery_required',
            });
          }
          expect(
            store.listThreadAgentSessions(workspaceId, DEMO_THREAD_ID).map((session) => session.id)
          ).toEqual([agentSessionId]);
          expect(JSON.stringify(await response.json())).not.toContain(secret);
        } finally {
          allowSubmit.resolve();
          native.executionFor(entry.turnId).completion.resolve();
          admitted ??= await admission.catch(() => undefined);
          await revocation?.catch(() => undefined);
        }
        return;
      }
      admitted = await native.admitTurn(entry, {
        attemptId,
        agentSessionId,
        candidateAgentSessionId: agentSessionId,
      });
      await vi.waitFor(() => expect(listVaultInjectionReceipts(coreDb)).toHaveLength(1));
      const receipts = listVaultInjectionReceipts(coreDb);
      expect(receipts).toEqual([
        expect.objectContaining({ grantId, agentSessionId, revocationStatus: 'active' }),
      ]);
      const opened = await commands.mock.results.find(
        (result, index) =>
          result.type === 'return' && commands.mock.calls[index]![0].operation === 'session.open'
      )!.value;
      expect(opened.body.runtimeEnvironment).toEqual({ GITHUB_TOKEN: secret });
      const idle =
        binding === 'idle' ||
        binding === 'idle-after-no-effect' ||
        binding === 'idle-contradiction';
      if (idle) {
        await admitted.complete();
        expect(store.getAgentSession(agentSessionId).status).toBe('idle');
      } else expect(store.getAgentSession(agentSessionId).status).toBe('busy');
      expect(
        [...native.outside.bindings.values()].flatMap((sessions) => [...sessions.values()])
      ).toEqual([expect.objectContaining({ state: idle ? 'completed' : 'running' })]);
      if (binding === 'sibling-closeout' || binding === 'sibling-late-drain') {
        const lateDrain = binding === 'sibling-late-drain';
        const siblingThread = await store.createThread(
          workspaceId,
          'Owned revocation sibling',
          testEntityId('th', `${label}-sibling`)
        );
        const storage = getWorkerStorageBinding(
          coreDb,
          store.getAgentSession(agentSessionId).retainedStorage!
        )!;
        const siblingAgentSessionId = testEntityId('as', `${label}-sibling`);
        const siblingAttemptId = testEntityId('attempt', `${label}-sibling`);
        const siblingEntry = createSchedulerAdmissionEntry(coreDb, {
          ...entry,
          queueEntryId: `queue:${label}-sibling`,
          requestId: testEntityId('tu', `request-${label}-sibling`).slice(3),
          threadId: siblingThread.id,
          turnId: testEntityId('tu', `${label}-sibling`),
          turnInput: 'Retain an independent cancellation and collection owner in the same Sandbox.',
          workerStorageChoice: {
            kind: 'selected',
            storageRef: storage.storageRef,
            expectedRevision: storage.revision,
            purpose: 'work',
            goalId: null,
            taskId: null,
          },
        });
        await publishFactoryAdmission(store, siblingEntry);
        const sibling = await native.admitTurn(siblingEntry, {
          attemptId: siblingAttemptId,
          agentSessionId: siblingAgentSessionId,
          candidateAgentSessionId: siblingAgentSessionId,
        });
        // Peer acceptance can precede the executor's startup ACK and credential receipt publication.
        await native.waitForStartup(siblingEntry.turnId);
        const backend = native.executor.executionBackend as WorkerGovernanceBackend;
        const collect = backend.collectTranscript.bind(backend);
        const firstCloseoutPaused = Promise.withResolvers<void>();
        const siblingCollecting = Promise.withResolvers<void>();
        const releaseFirst = Promise.withResolvers<void>();
        const releaseSibling = Promise.withResolvers<void>();
        const collection = vi
          .spyOn(backend, 'collectTranscript')
          .mockImplementation(async (...args) => {
            if (args[0] === sibling.pkg.snapshotId) {
              siblingCollecting.resolve();
              await releaseSibling.promise;
            }
            const transcript = await collect(...args);
            if (!lateDrain && args[0] === admitted!.pkg.snapshotId) {
              firstCloseoutPaused.resolve();
              await releaseFirst.promise;
            }
            return transcript;
          });
        const completeTurn = store.completeTurn.bind(store);
        const publication = lateDrain
          ? vi.spyOn(store, 'completeTurn').mockImplementation(async (...args) => {
              const turn = await completeTurn(...args);
              if (args[0] === entry.turnId) {
                expect(store.getTurnById(entry.turnId).status).toBe('completed');
                expect(getWorkerBackendSession(coreDb, attemptId)).toMatchObject({
                  state: 'cleaned',
                  physicalCleanedAt: expect.any(String),
                });
                expect(attempts.requireSchedulerExecutionAttempt(coreDb, attemptId)).toMatchObject({
                  phase: 'closing',
                  fenceRef: null,
                });
                expect(
                  coreDb.sqlite
                    .prepare(`SELECT b.lifecycle_state AS lifecycleState,
              b.cleanup_state AS cleanupState, b.native_handle_state AS nativeHandleState,
              b.native_handle_digest AS nativeHandleDigest, b.current_attempt_id AS currentAttemptId,
              s.drain_state AS sandboxDrain FROM agent_session_runtime_bindings b
              JOIN harness_instance_records h ON h.harness_instance_id = b.harness_instance_id
              JOIN sandbox_runtime_records s ON s.sandbox_runtime_id = h.sandbox_runtime_id
              WHERE b.agent_session_id = ?`)
                    .get(agentSessionId)
                ).toEqual({
                  lifecycleState: 'open',
                  cleanupState: 'clean',
                  nativeHandleState: 'ready',
                  nativeHandleDigest: expect.any(String),
                  currentAttemptId: null,
                  sandboxDrain: 'accepting',
                });
                // Ordinary cleanup and terminal publication precede this still-unreleased attempt.
                firstCloseoutPaused.resolve();
                await releaseFirst.promise;
              }
              return turn;
            })
          : undefined;
        let firstSettled = false;
        let firstCloseout: Promise<unknown> | undefined;
        let revocation: Promise<Response> | undefined;
        let publicResponse: Response | undefined;
        try {
          expect(
            coreDb.sqlite
              .prepare(`SELECT h.sandbox_runtime_id AS sandboxRuntimeId,
            b.agent_session_id AS agentSessionId FROM agent_session_runtime_bindings b
            JOIN harness_instance_records h ON h.harness_instance_id = b.harness_instance_id
            ORDER BY b.agent_session_id`)
              .all()
          ).toEqual(
            expect.arrayContaining([
              { sandboxRuntimeId: expect.any(String), agentSessionId },
              { sandboxRuntimeId: expect.any(String), agentSessionId: siblingAgentSessionId },
            ])
          );
          expect(
            coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM sandbox_runtime_records').get()
          ).toEqual({ count: 1 });
          const originalReceipts = listVaultInjectionReceipts(coreDb);
          expect(originalReceipts.map((receipt) => receipt.agentSessionId).sort()).toEqual(
            [agentSessionId, siblingAgentSessionId].sort()
          );
          firstCloseout = admitted.complete();
          void firstCloseout.then(
            () => {
              firstSettled = true;
            },
            () => {
              firstSettled = true;
            }
          );
          await Promise.race([firstCloseoutPaused.promise, firstCloseout]);
          expect(firstSettled).toBe(false);
          await native.executor.interruptTurn(store, siblingEntry.turnId);
          await Promise.race([siblingCollecting.promise, sibling.execution]);
          const finalFor = (pkg: AgentEnvironmentPackage) =>
            getWorkerControlAcceptedFinalStatus(coreDb, {
              ...pkg.scope,
              packageSnapshotId: pkg.snapshotId,
            });
          expect(finalFor(admitted.pkg)).toMatchObject({ status: 'completed' });
          expect(finalFor(sibling.pkg)).toMatchObject({ status: 'interrupted' });
          const effectsBefore = native.effects.length;
          revocation = app
            .request(
              ...operationRequest(
                'vault.grant-revoke',
                {},
                {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ workspaceId, grantId }),
                }
              )
            )
            .then((response) => {
              publicResponse = response;
              return response;
            });
          void revocation.catch(() => undefined);
          await vi.waitFor(() => {
            expect(getVaultGrant(coreDb, grantId)?.status).toBe('revoked');
            const resident = coreDb.sqlite
              .prepare(`SELECT drain_state AS drainState
              FROM sandbox_runtime_records WHERE sandbox_binding_ref = ?`)
              .get(storage.currentSandboxBindingRef) as { drainState: string } | undefined;
            expect(resident?.drainState === 'draining' || publicResponse !== undefined).toBe(true);
          });
          releaseFirst.resolve();
          await firstCloseout;
          // Sandbox lifecycle and Scheduler cleanup retain every sibling's collection exclusion.
          expect(
            native.effects
              .slice(effectsBefore)
              .filter(
                (effect) => effect.kind === 'bridge.close' || effect.kind === 'sandbox.delete'
              )
          ).toEqual([]);
          expect(attempts.requireSchedulerExecutionAttempt(coreDb, siblingAttemptId)).toMatchObject(
            {
              phase: 'closing',
              fenceRef: null,
            }
          );
          releaseSibling.resolve();
          await Promise.allSettled([firstCloseout, sibling.execution]);
          const response = await revocation;
          expect(store.getTurnById(entry.turnId).status).toBe('completed');
          expect(store.getTurnById(siblingEntry.turnId).status).toBe('interrupted');
          expect(finalFor(admitted.pkg)).toMatchObject({ status: 'completed' });
          expect(finalFor(sibling.pkg)).toMatchObject({ status: 'interrupted' });
          // Vault Lifecycle And Failure Rules preserves runtime exposure as stale-session.
          expect(listVaultInjectionReceipts(coreDb)).toEqual(
            originalReceipts.map((receipt) => ({
              ...receipt,
              revocationStatus: 'stale-session',
            }))
          );
          // Healthy exact owners must close runtime-env residency across either admission-drain window.
          expect(response.status, await response.clone().text()).toBe(200);
          expect(
            [...native.outside.bindings.values()].flatMap((sessions) => [...sessions.values()])
          ).toEqual([
            expect.objectContaining({ state: 'closed' }),
            expect.objectContaining({ state: 'closed' }),
          ]);
          expect(
            coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM sandbox_runtime_records').get()
          ).toEqual({ count: 0 });
          for (const ownerAttemptId of [attemptId, siblingAttemptId])
            expect(attempts.requireSchedulerExecutionAttempt(coreDb, ownerAttemptId)).toMatchObject(
              {
                phase: 'closed',
                fenceRef: expect.any(String),
              }
            );
          expect(
            store.listThreadAgentSessions(workspaceId, DEMO_THREAD_ID).map((session) => session.id)
          ).toEqual([agentSessionId]);
          expect(
            store
              .listThreadAgentSessions(workspaceId, siblingThread.id)
              .map((session) => session.id)
          ).toEqual([siblingAgentSessionId]);
          expect(JSON.stringify(await response.json())).not.toContain(secret);
        } finally {
          releaseFirst.resolve();
          releaseSibling.resolve();
          await firstCloseout?.catch(() => undefined);
          await sibling.cleanup();
          await revocation?.catch(() => undefined);
          publication?.mockRestore();
          collection.mockRestore();
        }
        return;
      }
      if (binding === 'idle-after-no-effect') {
        const failedAttemptId = testEntityId('attempt', `${label}-later`);
        const later = createSchedulerAdmissionEntry(coreDb, {
          ...entry,
          queueEntryId: `queue:${label}-later`,
          requestId: testEntityId('tu', `request-${label}-later`).slice(3),
          turnId: testEntityId('tu', `${label}-later`),
          turnInput: 'Fail preparation after publication without touching the resident.',
        });
        await publishFactoryAdmission(store, later);
        const backend = native.executor.executionBackend as WorkerGovernanceBackend;
        const materialize = backend.materialize.bind(backend);
        const failure = new Error('Controlled failure after backend anchor publication.');
        let failedAtPublishedAnchor = false;
        const preparation = vi
          .spyOn(backend, 'materialize')
          .mockImplementationOnce(async (pkg, context) =>
            materialize(pkg, {
              ...context,
              beforeMaterialization: async () => {
                await context?.beforeMaterialization?.();
                expect(getWorkerBackendSession(coreDb, failedAttemptId)).toMatchObject({
                  agentSessionId,
                  packageSnapshotId: pkg.snapshotId,
                });
                failedAtPublishedAnchor = true;
                throw failure;
              },
            })
          );
        try {
          void native.executionFor(later.turnId).execution.catch(() => undefined);
          await expect(
            native.admitTurn(later, {
              attemptId: failedAttemptId,
              agentSessionId,
              candidateAgentSessionId: testEntityId('as', `${label}-unused`),
            })
          ).rejects.toThrow();
        } finally {
          preparation.mockRestore();
        }
        expect(failedAtPublishedAnchor).toBe(true);
        expect(attempts.requireSchedulerExecutionAttempt(coreDb, failedAttemptId)).toMatchObject({
          agentSessionId,
          phase: 'closed',
          disposition: 'not_accepted',
          operationId: null,
          deadline: null,
        });
        expect(
          Date.parse(getWorkerBackendSession(coreDb, failedAttemptId)!.createdAt)
        ).toBeGreaterThan(Date.parse(getWorkerBackendSession(coreDb, attemptId)!.createdAt));
        expect(
          [...native.outside.bindings.values()].flatMap((sessions) => [...sessions.values()])
        ).toEqual([expect.objectContaining({ state: 'completed' })]);
      }
      const releasesBefore = native.executor.releaseResults.filter(
        (result) => result.state === 'released'
      );
      const attemptBefore = attempts.requireSchedulerExecutionAttempt(coreDb, attemptId);
      const retainedStorage = store.getAgentSession(agentSessionId).retainedStorage!;
      const storageBefore = getWorkerStorageBinding(coreDb, retainedStorage)!;
      if (cleanupUnknown) {
        // Scheduler Attempt, Reconnect, And Cleanup permits ordinary release with a safe resident.
        expect(attemptBefore).toMatchObject({ phase: 'closed', fenceRef: expect.any(String) });
        expect(releasesBefore).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              attemptId,
              state: 'released',
              fenceRef: attemptBefore.fenceRef,
            }),
          ])
        );
        expect(storageBefore.state).toBe('attached');
      }
      const effectsBefore = native.effects.length;
      if (binding === 'idle-contradiction') {
        const anchor = getWorkerBackendSession(coreDb, attemptId)!;
        originalBackendSessionId = anchor.backendSessionId;
        // Fault injection after real admission: retained physical identity contradicts its binding.
        const wrongSandboxId = `${anchor.backendSessionId.slice(0, 3)}${anchor.backendSessionId[3] === 'a' ? 'b' : 'a'}${anchor.backendSessionId.slice(4)}`;
        coreDb.sqlite
          .prepare('UPDATE worker_backend_sessions SET backend_session_id = ? WHERE attempt_id = ?')
          .run(wrongSandboxId, attemptId);
        expect(getWorkerBackendSession(coreDb, attemptId)).toEqual({
          ...anchor,
          backendSessionId: wrongSandboxId,
        });
      }
      native.peerFaults.closeRefusal = cleanupUnknown ? 'cleanup_required' : undefined;
      native.peerFaults.failSandboxDelete = cleanupUnknown;
      const operation = serverReference
        ? 'vault.server-mcp-secret-revoke'
        : route === 'reference'
          ? 'vault.secret-revoke'
          : route === 'narrow'
            ? 'vault.grant-narrow'
            : 'vault.grant-revoke';
      const response = await app.request(
        ...operationRequest(
          operation,
          {},
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              ...(serverReference
                ? { referenceId, requestId: testEntityId('tu', `${label}-revoke`).slice(3) }
                : { workspaceId, ...(route === 'reference' ? { referenceId } : { grantId }) }),
              ...(route === 'narrow'
                ? { constraints: { targetAgentSessionId: agentSessionId } }
                : {}),
            }),
          }
        )
      );
      // Vault lifecycle rules: durable revocation and immutable completion survive either runtime outcome.
      expect(getVaultGrant(coreDb, grantId)?.status).toBe('revoked');
      if (route === 'reference' || serverReference)
        expect(getVaultReference(coreDb, referenceId)?.status).toBe('revoked');
      expect(listVaultInjectionReceipts(coreDb)).toEqual(
        receipts.map((receipt) => ({ ...receipt, revocationStatus: 'stale-session' }))
      );
      if (cleanupUnknown) {
        expect(response.ok).toBe(false);
        await admitted.execution.catch(() => undefined);
        for (const result of native.executor.releaseResults.filter(
          (release) => release.state === 'released'
        ))
          expect(result).toMatchObject({ attemptId, fenceRef: attemptBefore.fenceRef });
        expect(attempts.requireSchedulerExecutionAttempt(coreDb, attemptId)).toMatchObject({
          phase: 'closed',
          fenceRef: attemptBefore.fenceRef,
          outcomeRef: attemptBefore.outcomeRef,
          terminalCause: attemptBefore.terminalCause,
        });
        expect(store.getTurnById(entry.turnId).status).toBe('completed');
        expect(
          native.effects.slice(effectsBefore).some((effect) => effect.kind === 'sandbox.delete')
        ).toBe(true);
        // Uncertain Sandbox cleanup fences residency and storage without rewriting prior Turn proof.
        expect(
          coreDb.sqlite
            .prepare(`SELECT cleanup_state AS cleanupState, drain_state AS drainState,
              health_state AS healthState, lifecycle_state AS lifecycleState
              FROM sandbox_runtime_records WHERE sandbox_binding_ref = ?`)
            .all(storageBefore.currentSandboxBindingRef)
        ).toEqual([
          {
            cleanupState: 'unknown',
            drainState: 'draining',
            healthState: 'unknown',
            lifecycleState: 'failed',
          },
        ]);
        expect(
          coreDb.sqlite
            .prepare(`SELECT drain_state AS drainState, lifecycle_state AS lifecycleState
              FROM harness_instance_records`)
            .all()
        ).toEqual([{ drainState: 'draining', lifecycleState: 'failed' }]);
        expect(getWorkerStorageBinding(coreDb, retainedStorage)).toMatchObject({
          state: 'unknown',
          attachmentGeneration: storageBefore.attachmentGeneration,
          currentSandboxBindingRef: storageBefore.currentSandboxBindingRef,
        });
        await expect(
          (native.executor.executionBackend as WorkerGovernanceBackend)
            .inspectMaterializationCapacity!(admitted.pkg)
        ).resolves.toBe('capacity-saturated');
        expect(
          [...native.outside.bindings.values()].flatMap((sessions) => [...sessions.values()])
        ).toEqual([expect.objectContaining({ state: 'completed' })]);
      } else if (binding === 'idle-contradiction') {
        // Vault lifecycle 9 and exact cleanup lineage forbid contacting a different physical Sandbox.
        expect(response.status).toBe(409);
        await expect(response.clone().json()).resolves.toMatchObject({ code: 'recovery_required' });
        expect(
          native.effects
            .slice(effectsBefore)
            .filter((effect) => effect.kind === 'bridge.close' || effect.kind === 'sandbox.delete')
        ).toEqual([]);
        expect(
          [...native.outside.bindings.values()].flatMap((sessions) => [...sessions.values()])
        ).toEqual([expect.objectContaining({ state: 'completed' })]);
        expect(attempts.requireSchedulerExecutionAttempt(coreDb, attemptId)).toMatchObject({
          phase: 'closed',
          fenceRef: attemptBefore.fenceRef,
          outcomeRef: attemptBefore.outcomeRef,
          terminalCause: attemptBefore.terminalCause,
        });
      } else {
        expect(response.status, await response.clone().text()).toBe(200);
        // Declaration Runtime Environment Visibility and Vault revocation acceptance require physical closure.
        expect(
          [...native.outside.bindings.values()].flatMap((sessions) => [...sessions.values()])
        ).toEqual([expect.objectContaining({ state: 'closed' })]);
        expect(native.effects.some((effect) => effect.kind === 'sandbox.delete')).toBe(true);
        expect(
          coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM sandbox_runtime_records').get()
        ).toEqual({ count: 0 });
        await admitted.execution.catch(() => undefined);
        expect(attempts.requireSchedulerExecutionAttempt(coreDb, attemptId)).toMatchObject({
          phase: 'closed',
          fenceRef: expect.any(String),
        });
        expect(['closed', 'interrupted', 'failed']).toContain(
          store.getAgentSession(agentSessionId).status
        );
        if (binding === 'busy') expect(store.getTurnById(entry.turnId).status).toBe('interrupted');
      }
      expect(
        store.listThreadAgentSessions(workspaceId, DEMO_THREAD_ID).map((session) => session.id)
      ).toEqual([agentSessionId]);
      expect(JSON.stringify(await response.json())).not.toContain(secret);
    } finally {
      if (originalBackendSessionId !== undefined)
        coreDb.sqlite
          .prepare('UPDATE worker_backend_sessions SET backend_session_id = ? WHERE attempt_id = ?')
          .run(originalBackendSessionId, attemptId);
      native.peerFaults.closeRefusal = undefined;
      native.peerFaults.failSandboxDelete = false;
      await admitted?.cleanup();
      commands.mockRestore();
      await native.restore();
      await shutdownControlStoreWorkerClient();
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
      const store = await createDemoStore();
      const turn = await store.createTurn(
        'ws_00000000-0000-7000-8000-000000000001',
        'th_00000000-0000-7000-8000-000000000001',
        'Interrupt the configured worker',
        { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
        null,
        { turnId: testEntityId('tu', 'turn_factory_interrupt') }
      );
      const agentSessionId = testEntityId('as', 'as_factory_interrupt');
      const packageSnapshotId = 'aepsnap_factory_interrupt';
      await store.createAgentSession({
        agentId: 'agent_codex_host',
        createdAt: turn.startedAt ?? '2026-08-12T00:00:00.000Z',
        environmentPackageSnapshotId: packageSnapshotId,
        id: agentSessionId,
        message: null,
        status: 'busy',
        threadId: turn.threadId,
        updatedAt: turn.startedAt ?? '2026-08-12T00:00:00.000Z',
        workspaceId: workspaceIdForOwner(turn.owner),
      });
      await store.updateTurn(turn.id, { agentSessionId });
      const priorPackageSnapshotId = `${packageSnapshotId}_prior`;
      workerControlGateway.registerSession({
        scope: {
          agentSessionId,
          requestId: null,
          threadId: turn.threadId,
          turnId: turn.id,
          workspaceId: workspaceIdForOwner(turn.owner),
        },
        snapshotId: priorPackageSnapshotId,
      } as AgentEnvironmentPackage);
      workerControlGateway.registerSession({
        scope: {
          agentSessionId,
          requestId: null,
          threadId: turn.threadId,
          turnId: turn.id,
          workspaceId: workspaceIdForOwner(turn.owner),
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
    const vaultUnlockState = createVaultUnlockState({
      backendKind: 'encrypted-file',
      storeDir: join(coreDb.dataRoot, 'server', 'vault'),
    });
    vaultUnlockState.unlock({ masterKey: Buffer.alloc(32, 31) });
    const interruptReply = Promise.withResolvers<void>();
    let interruptResult: Promise<
      NonNullable<ReturnType<typeof dispatchNanoHostHarnessOperation>>
    > | null = null;
    let stop: Promise<void> | undefined;
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
                'ws_00000000-0000-7fa5-9782-1098693cdfc1',
                'th_00000000-0000-7b36-ada8-71118e96b488'
              ),
            },
          },
        },
        scope: {
          agentSessionId: testEntityId('as', 'as_human_gate'),
          threadId: 'th_00000000-0000-7b36-ada8-71118e96b488',
          turnId: testEntityId('tu', 'turn_human_gate'),
          workspaceId: 'ws_00000000-0000-7fa5-9782-1098693cdfc1',
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
          agentSessionId: testEntityId('as', 'as_human_gate'),
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
            id: testEntityId('tu', 'turn_human_gate'),
            items: [],
            startedAt: '2026-09-03T00:00:00.000Z',
            status: 'running',
            threadId: 'th_00000000-0000-7b36-ada8-71118e96b488',
            triggerActor: environmentPackage.scope.triggerActor,
            owner: { kind: 'workspace', workspaceId: 'ws_00000000-0000-7fa5-9782-1098693cdfc1' },
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
      await authorizeNanoHostPackage(coreDb, environmentPackage);
      if (fixtureRepositoryPath) {
        const db = openWorkspaceDb(coreDb.dataRoot, environmentPackage.scope.workspaceId);
        try {
          applyScopedMigrations(db);
        } finally {
          db.sqlite.close();
        }
      }

      // A directly authored manifest grant requires Server scope and real private sink lineage.
      const referenceId = testEntityId('vault', 'dispatch-canary');
      const grantId = testEntityId('grant', 'dispatch-canary');
      const { workspaceId, threadId, turnId, agentSessionId, triggerActor } =
        environmentPackage.scope;
      vaultUnlockState.backend().store({
        referenceId,
        material: 'private-dispatch-env-canary',
        metadata: { ownerScope: 'server' },
      });
      createVaultReference(coreDb, {
        referenceId,
        ownerScope: 'server',
        displayName: 'Private dispatch credential fixture',
        secretKind: 'github-token',
        backendKind: 'encrypted-file',
        backendLocator: `encrypted-file://server/vault/${referenceId}`,
      });
      createVaultGrant(coreDb, {
        grantId,
        vaultReferenceId: referenceId,
        ownerScope: 'server',
        targetAgentId: environmentPackage.agent.agentId,
        targetAgentSessionId: agentSessionId,
        allowedInjectionPaths: ['runtime-env'],
        lifetime: 'agent-session',
      });
      const store = new FsStore({ dataRoot: coreDb.dataRoot });
      const turnInput = 'Private dispatch credential fixture';
      const turn = await store.createTurn(workspaceId, threadId, turnInput, triggerActor, null, {
        turnId,
        agentId: environmentPackage.agent.agentId,
        executorKind: 'worker',
        captureCoverage: { scope: 'server', value: 'off' },
      });
      createSchedulerAdmissionEntry(coreDb, {
        backendId: 'nanohost',
        queueEntryId: `queue:${testEntityId('attempt', 'lease_human_gate')}`,
        requestId: environmentPackage.scope.requestId,
        requestedAgentId: environmentPackage.agent.agentId,
        workspaceId,
        threadId,
        turnId,
        triggerActor,
        turnInput,
      });
      const runtimeEnvCredentials: WorkerGovernanceRuntimeEnvCredential[] = [];
      const receipts: CreateVaultInjectionReceiptInput[] = [];
      const resolution: Parameters<typeof resolveAgentEnvironmentPackage>[0] = {
        captureCoverage: { scope: 'server', value: 'off' },
        agentSessionId,
        agentSetup: createTestAgentSetup({
          adapter: adapterId,
          agentId: environmentPackage.agent.agentId,
          credentialDeclarations: [
            {
              id: 'dispatch-token',
              vaultGrantId: grantId,
              visibility: 'runtime-env',
              targetEnvVarName: 'GITHUB_TOKEN',
            },
          ],
        }),
        backend: { kind: 'openshell' },
        coreDb,
        createdAt: environmentPackage.createdAt,
        now: () => new Date().toISOString(),
        requestId: environmentPackage.scope.requestId,
        triggerActor,
        turn,
        turnInput,
        workspaceCwd: '/workspace',
        workspaceRoots: [],
        vaultBackend: () => vaultUnlockState.backend(),
        runtimeEnvCredentialSink: (credential) => runtimeEnvCredentials.push(credential),
        credentialReceiptSink: (receipt) => receipts.push(receipt),
      };
      const preview = resolveAgentEnvironmentPackageMetadata(resolution);
      // Preserve the scenario's adapter/repository inputs under the producer's actual snapshot.
      environmentPackage = {
        ...environmentPackage,
        snapshotId: preview.snapshotId,
        scope: preview.scope,
        credentials: preview.credentials,
        vault: preview.vault,
      };
      bindNanoHostWorkerLineage(coreDb, environmentPackage, {
        attemptId: testEntityId('attempt', 'lease_human_gate'),
        sandboxBindingRef: 'sandbox-binding:resident-session',
      });
      const produced = resolveAgentEnvironmentPackage(resolution);
      environmentPackage.credentials = produced.credentials;
      environmentPackage.vault = produced.vault;
      const runtime = createConfiguredWorkerLifecycleRuntime({
        coreDb,
        vaultBackend: () => vaultUnlockState.backend(),
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
      await anchorNanoHostMaterialization(coreDb, backend, environmentPackage);
      const materialization = await backend.materialize(environmentPackage, {
        sandboxBindingRef: factoryPackageBinding(coreDb, environmentPackage),
        runtimeEnvCredentials,
        workspaceRoots: [],
      });
      const recordedDigests: string[] = [];
      const proofRoot =
        purpose === 'failed-ready'
          ? mkdtempSync(join(tmpdir(), 'openkit-factory-failed-ready-'))
          : null;
      const proofStore = proofRoot ? await createDemoStore({ dataRoot: proofRoot }) : null;
      if (proofStore) {
        const proofTurn = await proofStore.createTurn(
          'ws_00000000-0000-7000-8000-000000000001',
          'th_00000000-0000-7000-8000-000000000001',
          'Failed ready proof',
          { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
          null,
          { turnId: testEntityId('tu', 'turn_factory_failed_ready') }
        );
        await proofStore.updateTurn(proofTurn.id, { agentId: 'agent_codex_host' });
        await proofStore.createAgentSession({
          agentId: 'agent_codex_host',
          createdAt: '2026-09-03T00:00:00.000Z',
          id: testEntityId('as', 'as_factory_failed_ready'),
          message: null,
          status: 'idle',
          threadId: proofTurn.threadId,
          updatedAt: '2026-09-03T00:00:00.000Z',
          workspaceId: workspaceIdForOwner(proofTurn.owner),
        });
      }
      await backend.bindNativeHandleRecorder?.(environmentPackage.snapshotId, async (digest) => {
        if (purpose === 'failed-ready-unrecorded') {
          throw new Error('recorder failed');
        }
        recordedDigests.push(digest);
        if (
          proofStore &&
          proofStore.getAgentSession(testEntityId('as', 'as_factory_failed_ready'))
            .nativeHandleDigest !== digest
        ) {
          await proofStore.updateAgentSession(testEntityId('as', 'as_factory_failed_ready'), {
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
      let holdInterruptReply = false;
      const interruptDispatched = Promise.withResolvers<void>();
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
        const queued = Promise.withResolvers<void>();
        const queue = harnessRecords.queueNanoHostHarnessOperation;
        const observation = vi
          .spyOn(harnessRecords, 'queueNanoHostHarnessOperation')
          .mockImplementation((...args) => {
            const sequence = queue(...args);
            if (args[0] === coreDb) queued.resolve();
            return sequence;
          });
        onTestFinished(() => observation.mockRestore());
        let command: ReturnType<typeof dispatchNanoHostHarnessOperation> = null;
        try {
          command = dispatchNanoHostHarnessOperation(coreDb, {
            sandboxIntegrationBindingRef: integration.integrationRef,
          });
          if (!command) {
            await queued.promise;
            command = dispatchNanoHostHarnessOperation(coreDb, {
              sandboxIntegrationBindingRef: integration.integrationRef,
            });
          }
        } finally {
          observation.mockRestore();
        }
        if (!command || command.operation !== operation) {
          throw new Error(`Expected queued ${operation} Harness command.`);
        }
        const wireCommand = await runtime.acceptNanoHostHarnessCommand(command);
        if (operation === 'session.open') {
          expect(effects.some((effect) => effect.kind === 'reference.import')).toBe(true);
          expect(wireCommand.body).toMatchObject({
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
            aepRef: `/openkit/sessions/${testEntityId('as', 'as_human_gate')}/config/package.json`,
            contextRef: `/openkit/sessions/${testEntityId('as', 'as_human_gate')}/context`,
          });
        }
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
          expect(durable).not.toContain(String(wireCommand.body.inferenceLoopbackCredential));
          expect(durable).not.toContain(String(wireCommand.body.capabilityLoopbackCredential));
        }
        if (operation === 'turn.start') {
          expect(wireCommand.body).not.toHaveProperty('runtimeEnvironment');
        }
        if (operation === 'turn.interrupt' && holdInterruptReply) {
          interruptDispatched.resolve();
          await interruptReply.promise;
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
        await runtime.acceptNanoHostHarnessResult(result);
        return command;
      };

      const launch = submitTestNanoHostTurn(coreDb, backend, materialization);
      await Promise.race([
        settleNext('session.open', {
          ...(fixtureRepositoryPath
            ? {
                workspaceGitBaseline: {
                  commit: environmentPackage.workspace.inputs[0]!.source.commit,
                  tree: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
                },
              }
            : {}),
          maxActiveTurns: 20,
          nativeHandleDigest: null,
          nativeHandleState: 'pending',
          state: 'open',
        }),
        launch,
      ]);
      await Promise.race([
        settleNext('turn.start', {
          nativeHandleDigest: null,
          nativeHandleState: 'pending',
          state: 'started',
        }),
        launch,
      ]);
      await launch;
      // Native turn.start acknowledgement proves the generated private sink completed.
      for (const receipt of receipts) createVaultInjectionReceipt(coreDb, receipt);
      // This terminal-inspection subject begins with exact occupancy; Harness record regressions separately retain the leaseId-to-attemptId publication defect.
      coreDb.sqlite
        .prepare(`UPDATE agent_session_runtime_bindings
        SET current_attempt_id = '${testEntityId('attempt', 'lease_human_gate')}'
        WHERE agent_session_id = 'as_00000000-0000-724a-bad4-af2315ba9f21' AND current_turn_id = 'tu_00000000-0000-75c6-a618-1f296931ec36'`)
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

      holdInterruptReply = !completed;
      stop = completed ? Promise.resolve() : backend.interruptTurn(environmentPackage.snapshotId);
      void stop.catch(() => undefined);
      interruptResult = completed ? null : settleNext('turn.interrupt', { state: 'interrupted' });
      // Native intent acknowledgement and actual Harness dispatch must precede final-status admission.
      if (interruptResult) await Promise.race([interruptDispatched.promise, interruptResult]);
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
        interruptReply.resolve();
        const interrupt = await interruptResult!;
        expect(interrupt.body).toMatchObject({
          agentSessionId: testEntityId('as', 'as_human_gate'),
          leaseId: testEntityId('attempt', 'lease_human_gate'),
          purpose: 'interrupt',
          turnId: testEntityId('tu', 'turn_human_gate'),
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
            agentSessionId: testEntityId('as', 'as_human_gate_next'),
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
        const reloaded = await createDemoStore({ dataRoot: proofRoot });
        expect(
          reloaded.getAgentSession(testEntityId('as', 'as_factory_failed_ready')).nativeHandleDigest
        ).toBe('a'.repeat(64));
      }
    } finally {
      interruptReply.resolve();
      await Promise.allSettled([interruptResult, stop]);
      vaultUnlockState.lock();
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
      const retainedStorage = {
        storageRef: 'wst_00000000-0000-7ac8-9f6c-13552db6aa87',
        workSlotRef: 'slot-inspect',
      };
      const environmentPackage = {
        extensions: { openkit: { workerStorage: { workSlotRef: retainedStorage.workSlotRef } } },
        scope: {
          agentSessionId: testEntityId('as', 'as_factory_inspect'),
          requestId: null,
          threadId: 'th_00000000-0000-728a-9acc-1d67cef1f13c',
          turnId: testEntityId('tu', 'turn_factory_inspect'),
          workspaceId: 'ws_00000000-0000-7af6-9cee-9356913f50cf',
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
        attemptId: testEntityId('attempt', 'attempt_factory_inspect'),
        nativeResume: resume
          ? {
              digest: resume,
              locator: testEntityId('as', 'as_factory_predecessor'),
            }
          : null,
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
            agentSessionId: testEntityId('as', 'as_factory_inspect'),
            requestId: null,
            threadId: 'th_00000000-0000-728a-9acc-1d67cef1f13c',
            turnId: testEntityId('tu', 'turn_factory_inspect'),
            workspaceId: 'ws_00000000-0000-7af6-9cee-9356913f50cf',
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

  it('refuses invalid Context before creating a Sandbox or admitting its bridge', async () => {
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
    backend.requireAttemptId = () => testEntityId('attempt', 'lease_factory_pre_bridge_failure');
    const environmentPackage = completeNanoHostPackage({
      policy: {
        filesystem: { default: 'deny', rules: [] },
        network: { default: 'deny', enforcement: 'openshell', rules: [] },
        process: { default: 'deny', rules: [] },
        snapshotId: 'policy_factory_pre_bridge_failure',
      },
      runtime: {
        image: { kind: 'reference', pullPolicy: 'if-not-present', ref: 'openkit/worker:test' },
      },
      scope: {
        agentSessionId: testEntityId('as', 'as_factory_pre_bridge_failure'),
        threadId: 'th_00000000-0000-7bce-9381-19961748c911',
        turnId: testEntityId('tu', 'turn_factory_pre_bridge_failure'),
        workspaceId: 'ws_00000000-0000-728c-9485-f030b87c022c',
      },
      snapshotId: packageSnapshotId,
      workspace: {
        inputs: [
          {
            access: 'read-only',
            id: `context_${testEntityId('tu', 'turn_factory_pre_bridge_failure')}`,
            kind: 'generated',
            source: {
              kind: 'generated',
              pathRef: `threads/th_00000000-0000-7bce-9381-19961748c911/turns/${testEntityId('tu', 'turn_factory_pre_bridge_failure')}/context-package`,
            },
            target: '/openkit/context',
          },
        ],
      },
    });
    await authorizeNanoHostPackage(factoryCoreDb, environmentPackage);
    const identity = backend.planSession(environmentPackage);

    await anchorNanoHostMaterialization(factoryCoreDb, backend, environmentPackage);
    await expect(
      backend.materialize(environmentPackage, {
        sandboxBindingRef: factoryPackageBinding(factoryCoreDb, environmentPackage),
        workspaceRoots: [],
      })
    ).rejects.toThrow('NanoHost Context Package lineage or private root is invalid.');
    await runtime.cleanupBackendSession(identity);
    expect(operations).toEqual([]);
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
    backend.requireAttemptId = () => testEntityId('attempt', 'lease_factory_reservation_failure');
    const environmentPackage = completeNanoHostPackage({
      policy: {
        filesystem: { default: 'deny', rules: [] },
        network: { default: 'deny', enforcement: 'openshell', rules: [] },
        process: { default: 'deny', rules: [] },
        snapshotId: 'policy_factory_reservation_failure',
      },
      runtime: {
        image: { kind: 'reference', pullPolicy: 'if-not-present', ref: 'openkit/worker:test' },
      },
      scope: {
        agentSessionId: testEntityId('as', 'as_factory_reservation_failure'),
        threadId: 'th_00000000-0000-72db-b3c8-374d6ada7039',
        turnId: testEntityId('tu', 'turn_factory_reservation_failure'),
        workspaceId: 'ws_00000000-0000-7788-af62-b10b8ed2158d',
      },
      snapshotId: packageSnapshotId,
    });
    await authorizeNanoHostPackage(factoryCoreDb, environmentPackage);
    factoryCoreDb.sqlite.exec(`CREATE TEMP TRIGGER reject_test_storage_contributor
      BEFORE INSERT ON worker_storage_contributors BEGIN
        SELECT RAISE(ABORT, 'test reservation write failure');
      END`);

    try {
      await anchorNanoHostMaterialization(factoryCoreDb, backend, environmentPackage);
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
        agentSessionId: testEntityId('as', 'as_live_partial_sibling'),
        authorizeContributor: () => true,
        expectedRevision: sibling.revision,
        layout: before.layout,
        purpose: 'work',
        responsibleUserId: 'usr_00000000-0000-7353-b5d8-71f1d581a738',
        runtimeTargetId: fixture.identity.runtimeTargetId,
        storageRef: sibling.storageRef,
        threadId: 'th_00000000-0000-79ee-8305-d2c3357bd6fa',
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
    'image.acquire.pending',
  ] as const)('keeps the ready connection usable after rejected %s and live cleanup', async (operation) => {
    const coreDb = createFactoryCoreDb();
    const authority = createNanoHostTransportSessionAuthority();
    const dispatch = createNanoHostSessionDispatch({
      coreDb,
      sessionAuthority: authority,
      fileAdmission: new FileStorageAdmission(coreDb.dataRoot, () => 0n),
    });
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
          agentSessionId: testEntityId('as', 'as_image_failure'),
          threadId: 'th_00000000-0000-78c4-aa89-8c93b3620c54',
          turnId: testEntityId('tu', 'turn_image_failure'),
          workspaceId: 'ws_00000000-0000-74e5-8f9d-77c66511df54',
        },
        snapshotId: 'aepsnap_image_failure',
      });
      await authorizeNanoHostPackage(coreDb, environmentPackage);
      await anchorNanoHostMaterialization(coreDb, backend, environmentPackage);
      const predecessor =
        operation === 'image.acquire.pending'
          ? dispatch.effect({
              kind: 'image.acquire',
              requestId: 'd'.repeat(64),
              input: { imageReference: `sha256:${'c'.repeat(64)}` },
            })
          : null;
      const materialization = backend.materialize(environmentPackage, {
        sandboxBindingRef: factoryPackageBinding(coreDb, environmentPackage),
        workspaceRoots: [],
      });
      const rejected = expect(materialization).rejects.toThrow(
        operation === 'image.acquire.pending' ? 'already has a pending command' : 'effect_failed'
      );
      let command: Record<string, unknown> | null = null;
      await vi.waitFor(async () => {
        command = await dispatch.poll(
          physical,
          operation === 'image.build' ? operation : 'image.acquire'
        );
        expect(command).not.toBeNull();
      });
      if (operation !== 'image.build' && operation !== 'image.acquire.pending') {
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
      if (operation === 'image.acquire.pending') {
        await rejected;
        const owned = requireNanoHostExecutionAttempt(
          coreDb,
          (
            coreDb.sqlite
              .prepare(
                'SELECT attempt_id AS id FROM scheduler_execution_attempts WHERE input_ref = ?'
              )
              .get(environmentPackage.snapshotId) as { id: string }
          ).id
        );
        expect(owned).toMatchObject({ disposition: 'not_accepted', deadline: null });
      }
      await dispatch.result(
        physical,
        operation === 'image.acquire.pending' ? 'image.acquire' : operation,
        {
          requestId: command!.requestId,
          failureCode: 'effect_failed',
        }
      );
      await rejected;
      if (predecessor) await predecessor.catch(() => undefined);
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

  it.each([
    'failure',
    'mismatch',
    'match',
  ] as const)('acquires an exact local digest before inspection and stops when acquisition fails (%s)', async (acquisitionResult) => {
    const coreDb = createFactoryCoreDb();
    const effects: NanoHostSessionEffectRequest[] = [];
    const localDigest = `sha256:${'d'.repeat(64)}`;
    const suffix =
      acquisitionResult === 'failure' ? 'factory_newest_lease' : `acquire_${acquisitionResult}`;
    const turnId = testEntityId('tu', `turn_${suffix}`);
    const attemptId = testEntityId('attempt', `lease_${suffix}`);
    const agentSessionId = testEntityId('as', `as_${suffix}`);
    const setup = createTestAgentSetup({
      imageRef: localDigest,
      requiredCapabilities: ['trusted-worker-inference-relay'],
    });
    setup.manifest.runtime.image = { kind: 'reference', pullPolicy: 'never', ref: localDigest };
    const ownerUserId = ensureLocalUser(coreDb);
    const store = await createDemoStore({ dataRoot: coreDb.dataRoot });
    recordWorkspaceOwnerMembership({ coreDb, ownerUserId, workspaceId: DEMO_WORKSPACE_ID });
    recordTestNativeRuntimeTarget(coreDb);
    admitTestNativeEnvironment(coreDb, setup.manifest);
    const entry = createSchedulerAdmissionEntry(coreDb, {
      backendId: 'nanohost',
      queueEntryId: `queue:${attemptId}`,
      requestId: testEntityId('tu', `request_${suffix}`).slice(3),
      requestedAgentId: setup.manifest.id,
      threadId: DEMO_THREAD_ID,
      turnId,
      turnInput: 'Acquire the exact local image.',
      triggerActor: { kind: 'user', id: ownerUserId },
      workspaceId: DEMO_WORKSPACE_ID,
    });
    await publishFactoryAdmission(store, entry);
    let preparationObserved = false;
    const runtime = createConfiguredWorkerLifecycleRuntime({
      coreDb,
      store,
      env: {},
      fileAdmission: new FileStorageAdmission(coreDb.dataRoot, () => 1_000_000_000n),
      workerControlGateway: createDefaultWorkerControlGateway(coreDb),
      nanoHostSessionDispatch: {
        async effect(requestOrConnection: object, carried?: NanoHostSessionEffectRequest) {
          const request = carried ?? (requestOrConnection as NanoHostSessionEffectRequest);
          effects.push(request);
          if (request.kind === 'image.acquire') {
            const original = attempts.requireSchedulerExecutionAttempt(coreDb, attemptId);
            expect(store.getTurnById(turnId).agentSessionId).toBe(agentSessionId);
            expect(getWorkerBackendSession(coreDb, attemptId)).toMatchObject({
              turnId,
              agentSessionId,
            });
            // Scheduler Admission And Launch: the original preparation excludes a second grant.
            expect(() =>
              recordTestExecutionAttempt(coreDb, {
                entry,
                attemptId: testEntityId('attempt', `duplicate_${suffix}`),
                agentSessionId,
                inputRef: original.inputRef!,
                bindingRef: original.bindingRef!,
                sessionCompatibilityKey: 'duplicate-refused',
                now: () => new Date().toISOString(),
              })
            ).toThrow('no longer dispatchable');
            preparationObserved = true;
            if (acquisitionResult === 'failure')
              throw new Error('exact local image is unavailable');
            return {
              digest: acquisitionResult === 'mismatch' ? `sha256:${'e'.repeat(64)}` : localDigest,
            };
          }
          if (request.kind === 'image.inspect') return nanoHostImageInspection(request);
          if (request.kind === 'sandbox.create') throw new Error('Sandbox creation reached');
          if (request.kind === 'bridge.close') {
            expect(attempts.requireSchedulerExecutionAttempt(coreDb, attemptId)).toMatchObject({
              disposition: 'unknown',
              operationId: effects[2]?.requestId,
              phase: 'closing',
            });
            throw new Error('Wider image cleanup is unknown.');
          }
          throw new Error(`Unexpected image trial effect: ${request.kind}`);
        },
        poll: async () => null,
        async result() {},
        async route() {
          throw new Error('Unexpected semantic route.');
        },
      },
    });
    const dispatch = () =>
      runSchedulerDispatchLoop({
        coreDb,
        store,
        turnExecutor: runtime.turnExecutor,
        executionBackend: runtime.turnExecutor.executionBackend!,
        agentManifests: [setup.manifest],
        gatewayConfig: createTestGatewayConfig(),
        maxDispatches: 1,
        createAttemptId: () => attemptId,
        createAgentSessionId: () => agentSessionId,
        providerRegistry: new ProviderRegistry([
          {
            id: 'agent-openrouter',
            displayName: 'Image fixture',
            kind: 'local',
            models: ['openai/gpt-5.2'],
          },
        ]),
      });
    try {
      const failure = await dispatch().catch((error: unknown) => error);
      const messages = (error: unknown): string[] =>
        error instanceof AggregateError
          ? [error.message, ...error.errors.flatMap(messages)]
          : [error instanceof Error ? error.message : String(error)];
      expect(failure).toBeInstanceOf(Error);
      expect(preparationObserved, 'The real native preparation must reach image acquisition.').toBe(
        true
      );
      expect(messages(failure)).toContain(
        acquisitionResult === 'failure'
          ? 'exact local image is unavailable'
          : acquisitionResult === 'mismatch'
            ? 'NanoHost local image acquisition returned a different digest.'
            : 'Sandbox creation reached'
      );
      // NanoHost Image Acquisition And Build forbids inspection/create after refusal or mismatch.
      expect(effects.map((effect) => effect.kind)).toEqual(
        acquisitionResult === 'match'
          ? ['image.acquire', 'image.inspect', 'sandbox.create', 'bridge.close']
          : ['image.acquire']
      );
      const anchor = getWorkerBackendSession(coreDb, attemptId)!;
      expect(anchor).toMatchObject({ turnId, agentSessionId, attemptId });
      expect(effects[0]?.input).toMatchObject({
        imageReference: localDigest,
        leaseId: attemptId,
        backendSessionId: anchor.backendSessionId,
        packageSnapshotId: anchor.packageSnapshotId,
      });
      if (acquisitionResult !== 'match') {
        expect(
          listWorkerStorageBindings(coreDb, {
            workspaceId: entry.workspaceId,
            authorizeContributor: () => true,
          })
        ).toEqual([]);
        return;
      }
      expect(effects[1]?.input).toEqual({ imageDigest: localDigest });
      expect(effects[2]?.input).toMatchObject({
        imageDigest: localDigest,
        leaseId: attemptId,
        backendSessionId: anchor.backendSessionId,
        packageSnapshotId: anchor.packageSnapshotId,
      });
      // Scheduler cleanup widens once; neither lost result permits release or effect replay.
      expect(messages(failure)).toContain('Wider image cleanup is unknown.');
      expect(effects[3]?.requestId).toMatch(/^[0-9a-f]{64}$/);
      expect(effects[3]?.requestId).not.toBe(effects[2]?.requestId);
      expect(effects[3]?.input).toMatchObject({
        leaseId: attemptId,
        backendSessionId: anchor.backendSessionId,
        packageSnapshotId: anchor.packageSnapshotId,
        sandboxId: effects[2]?.input.sandboxId,
      });
      expect(anchor).toMatchObject({ state: 'cleanup-failed', physicalCleanedAt: null });
      expect(
        getWorkerStorageBinding(coreDb, {
          storageRef: (effects[2]!.input.storage as { storageRef: string }).storageRef,
        })
      ).toMatchObject({ state: 'unknown' });
      const original = attempts.requireSchedulerExecutionAttempt(coreDb, attemptId);
      expect(original).toMatchObject({
        disposition: 'unknown',
        operationId: effects[2]?.requestId,
        phase: 'closing',
        fenceRef: null,
      });
      await expect(runtime.cleanupBackendSession(anchor)).rejects.toBeInstanceOf(
        NanoHostCleanupFencePendingError
      );
      const competing = createSchedulerAdmissionEntry(coreDb, {
        ...entry,
        queueEntryId: `queue:${attemptId}:competing`,
        requestId: testEntityId('tu', 'request_acquire_match_competing').slice(3),
        turnId: testEntityId('tu', 'turn_acquire_match_competing'),
      });
      await publishFactoryAdmission(store, competing);
      expect((await dispatch()).startedTurns).toEqual([]);
      expect(effects).toHaveLength(4);
      expect(attempts.requireSchedulerExecutionAttempt(coreDb, attemptId)).toEqual(original);
      expect(getWorkerBackendSession(coreDb, attemptId)).toEqual(anchor);
    } finally {
      await shutdownControlStoreWorkerClient();
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
      backend.requireAttemptId = (packageSnapshotId) =>
        testEntityId('attempt', `lease-${packageSnapshotId}`);
      const triggerActor = {
        id: 'usr_00000000-0000-7d88-9ab3-251840286dba',
        kind: 'user' as const,
      };
      const firstPackage = resolveAgentEnvironmentPackage({
        captureCoverage: { scope: 'server', value: 'off' },
        agentSessionId: testEntityId('as', 'agent-session-measured-inspect'),
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
          id: 'tu_00000000-0000-7fae-a34b-1136e7368f9c',
          items: [],
          startedAt: '2026-08-21T00:00:00.000Z',
          status: 'running',
          threadId: 'th_00000000-0000-7465-bba5-dc4cf7c89b86',
          triggerActor,
          owner: { kind: 'workspace', workspaceId: 'ws_00000000-0000-7058-8e48-7cd50df605b6' },
        },
        turnInput: 'Inspect restored binding copy',
        workspaceCwd: '/workspace',
        workspaceRoots: [],
      });
      await authorizeNanoHostPackage(coreDb, firstPackage);
      await anchorNanoHostMaterialization(coreDb, backend, firstPackage);
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
      restoredBackend.requireAttemptId = (packageSnapshotId) =>
        testEntityId('attempt', `lease-${packageSnapshotId}`);
      restoredBackend.restoreSession(
        firstPackage,
        testEntityId('attempt', `lease-${firstPackage.snapshotId}`)
      );
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
        backend.requireAttemptId = (packageSnapshotId) =>
          testEntityId('attempt', `lease-${packageSnapshotId}`);
        return { backend, runtime };
      };
      const { backend, runtime } = createBackend();
      const environmentPackage = completeNanoHostPackage({
        runtime: {
          image: { kind: 'reference', pullPolicy: 'never', ref: `sha256:${'1'.repeat(64)}` },
        },
        scope: {
          agentSessionId: testEntityId('as', 'as_resume_open'),
          threadId: 'th_00000000-0000-7180-88f8-8a00cdc67226',
          turnId: testEntityId('tu', 'turn_resume_open'),
          workspaceId: 'ws_00000000-0000-7672-9133-5f5991b8c6ba',
        },
        snapshotId: 'snapshot_resume_open',
      });
      await authorizeNanoHostPackage(coreDb, environmentPackage);
      bindNanoHostWorkerLineage(coreDb, environmentPackage, {
        attemptId: testEntityId('attempt', 'lease-snapshot_resume_open'),
        sandboxBindingRef: 'lease-binding:resume-open',
      });
      const settleNext = async (
        operation: 'session.open' | 'turn.start',
        body: Readonly<Record<string, unknown>>
      ) => {
        const { command, integrationRef } = await waitForFactoryHarnessCommand(coreDb);
        if (!command || command.operation !== operation) {
          throw new Error(`Expected queued ${operation} Harness command.`);
        }
        // Continuity: acknowledged ready proof precedes native Turn work, not an event-loop delay.
        if (operation === 'turn.start') expect(recordedDigests).toEqual([predecessorDigest]);
        await runtime.acceptNanoHostHarnessCommand(command);
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
        await runtime.acceptNanoHostHarnessResult(result);
        return command;
      };

      await anchorNanoHostMaterialization(coreDb, backend, environmentPackage);
      const materialization = await backend.materialize(environmentPackage, {
        sandboxBindingRef: factoryPackageBinding(coreDb, environmentPackage),
        nativeResume: {
          digest: predecessorDigest,
          locator: testEntityId('as', 'as_resume_predecessor'),
        },
        workspaceRoots: [],
      });
      const recordedDigests: string[] = [];
      await backend.bindNativeHandleRecorder?.(environmentPackage.snapshotId, (digest) => {
        recordedDigests.push(digest);
      });
      const launch = submitTestNanoHostTurn(coreDb, backend, materialization);
      void launch.catch(() => undefined);
      const open = await settleNext('session.open', {
        maxActiveTurns: 20,
        nativeHandleDigest: openedDigest,
        nativeHandleState: 'ready',
        state: 'open',
      });
      expect(open.body).toMatchObject({
        resume: {
          digest: predecessorDigest,
          locator: testEntityId('as', 'as_resume_predecessor'),
        },
      });
      if (openedDigest !== predecessorDigest) {
        await expect(launch).rejects.toThrow('session.open result is incompatible');
        expect(recordedDigests).toEqual([]);
        return;
      }
      await settleNext('turn.start', {
        nativeHandleDigest: predecessorDigest,
        nativeHandleState: 'ready',
        state: 'started',
      });
      await launch;

      // A restarted NanoCore restores the binding from its durable row and hands the recorder the
      // proof that row holds, closing the window between the row commit and the AgentSession write.
      const restored = createBackend().backend;
      restored.restoreSession(
        environmentPackage,
        testEntityId('attempt', 'lease-snapshot_resume_open')
      );
      const restoredDigests: string[] = [];
      await restored.bindNativeHandleRecorder?.(environmentPackage.snapshotId, (digest) => {
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
                'ws_00000000-0000-7a51-9dfb-8cae00dd2ce8',
                'th_00000000-0000-76d6-b987-2ed544055f3e'
              ),
            },
          },
        },
        scope: {
          agentSessionId: testEntityId('as', 'as_ready_open'),
          threadId: 'th_00000000-0000-76d6-b987-2ed544055f3e',
          turnId: testEntityId('tu', 'turn_ready_open'),
          workspaceId: 'ws_00000000-0000-7a51-9dfb-8cae00dd2ce8',
        },
        snapshotId: 'snapshot_ready_open',
      });
      environmentPackage.control.adapter.targetRuntime = adapterId;
      environmentPackage.agent.runtimeVersion = adapterId === 'pi' ? '0.85.1' : '0.153.4';
      await authorizeNanoHostPackage(coreDb, environmentPackage);
      bindNanoHostWorkerLineage(coreDb, environmentPackage, {
        attemptId: testEntityId('attempt', 'lease_ready_open'),
        sandboxBindingRef: 'sandbox-binding:ready-open',
      });
      await anchorNanoHostMaterialization(coreDb, backend, environmentPackage);
      const materialization = await backend.materialize(environmentPackage, {
        sandboxBindingRef: factoryPackageBinding(coreDb, environmentPackage),
        workspaceRoots: [],
      });
      await backend.bindNativeHandleRecorder?.(environmentPackage.snapshotId, () => {
        throw new Error('recorder failed');
      });
      const launch = submitTestNanoHostTurn(coreDb, backend, materialization);
      const { command } = await waitForFactoryHarnessCommand(coreDb);
      if (!command || command.operation !== 'session.open') {
        throw new Error('Expected queued session.open Harness command.');
      }
      expect(command.body).toMatchObject({ resume: null });
      await runtime.acceptNanoHostHarnessCommand(command);
      const result = {
        body: {
          maxActiveTurns: 20,
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
      await runtime.acceptNanoHostHarnessResult(result);
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
      await backend.bindNativeHandleRecorder?.(environmentPackage.snapshotId, (digest) => {
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
        backend.requireAttemptId = (packageSnapshotId) =>
          testEntityId('attempt', `lease-${packageSnapshotId}`);
        return { backend, runtime };
      };
      const { backend, runtime } = createBackend();
      const environmentPackage = completeNanoHostPackage({
        runtime: {
          image: { kind: 'reference', pullPolicy: 'never', ref: `sha256:${'1'.repeat(64)}` },
        },
        scope: {
          agentSessionId: testEntityId('as', 'as_restored_proof'),
          threadId: 'th_00000000-0000-7829-91a3-9f116054448c',
          turnId: testEntityId('tu', 'turn_restored_proof'),
          workspaceId: 'ws_00000000-0000-79a0-bbc2-fef84b0979c4',
        },
        snapshotId: 'snapshot_restored_proof',
      });
      await authorizeNanoHostPackage(coreDb, environmentPackage);
      bindNanoHostWorkerLineage(coreDb, environmentPackage, {
        attemptId: testEntityId('attempt', 'lease-snapshot_restored_proof'),
        sandboxBindingRef: 'lease-binding:restored-proof',
      });
      const settleNext = async (
        operation: 'session.open' | 'turn.start',
        body: Readonly<Record<string, unknown>>
      ) => {
        const { command, integrationRef } = await waitForFactoryHarnessCommand(coreDb);
        if (!command || command.operation !== operation) {
          throw new Error(`Expected queued ${operation} Harness command.`);
        }
        await runtime.acceptNanoHostHarnessCommand(command);
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
        await runtime.acceptNanoHostHarnessResult(result);
      };
      await anchorNanoHostMaterialization(coreDb, backend, environmentPackage);
      const materialization = await backend.materialize(environmentPackage, {
        sandboxBindingRef: factoryPackageBinding(coreDb, environmentPackage),
        nativeResume: {
          digest: readyDigest,
          locator: testEntityId('as', 'as_restored_predecessor'),
        },
        workspaceRoots: [],
      });
      await backend.bindNativeHandleRecorder?.(environmentPackage.snapshotId, () => undefined);
      const launch = submitTestNanoHostTurn(coreDb, backend, materialization);
      void launch.catch(() => undefined);
      await settleNext('session.open', {
        maxActiveTurns: 20,
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
      restored.restoreSession(
        environmentPackage,
        testEntityId('attempt', 'lease-snapshot_restored_proof')
      );
      await expect(
        restored.bindNativeHandleRecorder?.(environmentPackage.snapshotId, () => {
          throw new Error('recorder failed');
        })
      ).rejects.toThrow(/recorder failed/);
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
      await restored.bindNativeHandleRecorder?.(environmentPackage.snapshotId, (digest) => {
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

  // These independent Tasks retain their original 60-second local runner budget.
  it.each([
    'active',
    'closeout',
    'late-capacity',
    'materialization-forced-retirement-guard',
  ] as const)('keeps an independent Task queued until one-Sandbox release: %s', async (scenario) => {
    const coreDb = createFactoryCoreDb();
    const ownerUserId = ensureLocalUser(coreDb);
    const store = await createDemoStore({ dataRoot: coreDb.dataRoot });
    const workspaceId = DEMO_WORKSPACE_ID;
    recordWorkspaceOwnerMembership({ coreDb, workspaceId, ownerUserId });
    const threadIds = ['first', 'second'].map((label) => testEntityId('th', `th_busy_${label}`));
    for (const threadId of threadIds)
      await store.createThread(workspaceId, 'Independent Task', threadId);
    const setup = createTestAgentSetup({
      requiredCapabilities: ['trusted-worker-inference-relay'],
    });
    const initial = createInMemoryRuntimeConfigSnapshot({
      ...loadRuntimeConfig(coreDb.dataRoot),
      agentManifests: [setup.manifest],
      gatewayConfig: createTestGatewayConfig(),
      providerRegistry: new ProviderRegistry([
        {
          id: 'agent-openrouter',
          displayName: 'Busy fixture',
          kind: 'local',
          models: ['openai/gpt-5.2'],
        },
      ]),
      openKitConfig: {
        defaults: { defaultAgentId: setup.manifest.id },
        nanohost: {
          maxActiveTurnsPerSandbox: scenario === 'active' || scenario === 'closeout' ? 1 : 2,
        },
      },
    });
    const reduced = createInMemoryRuntimeConfigSnapshot({
      ...initial,
      openKitConfig: { ...initial.openKitConfig, nanohost: { maxActiveTurnsPerSandbox: 1 } },
    });
    let configuration = initial;
    const config = createRuntimeConfigManager({
      dataRoot: coreDb.dataRoot,
      initialSnapshot: initial,
    });
    const configRead = vi.spyOn(config, 'current').mockImplementation(() => configuration);
    const native = createNativeTaskAdmissionFixture(coreDb, store, {
      readRuntimeConfig: () => config.current(),
    });
    const executor = native.executor;
    const backend = executor.executionBackend as WorkerGovernanceBackend;
    const held = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const collect = backend.collectTranscript.bind(backend);
    const collection = vi
      .spyOn(backend, 'collectTranscript')
      .mockImplementation(async (...args) => {
        const transcript = await collect(...args);
        if (scenario === 'closeout') {
          held.resolve();
          await release.promise;
        }
        return transcript;
      });
    const inspect = backend.inspectMaterializationCapacity!.bind(backend);
    const commit = executor.commitPreparedAgentSessionForTurn!.bind(executor);
    const commitObservation = vi
      .spyOn(executor, 'commitPreparedAgentSessionForTurn')
      .mockImplementation(async (...args) => {
        const result = await commit(...args);
        if (args[1].preparation.turn.threadId === threadIds[1]) {
          if (scenario === 'late-capacity') configuration = reduced;
        }
        return result;
      });
    const materialize = backend.materialize.bind(backend);
    const materializationCapacity: string[] = [];
    const materialization = vi.spyOn(backend, 'materialize').mockImplementation(async (...args) => {
      if (args[0].scope.threadId === threadIds[1])
        materializationCapacity.push(await inspect(args[0]));
      return materialize(...args);
    });
    const commandObservation = vi.spyOn(native.runtime, 'acceptNanoHostHarnessCommand');
    const admissions = vi.spyOn(productOwners, 'observeTurnAdmission');
    const dispatches = vi.spyOn(schedulerOwners, 'runSchedulerDispatchLoop');
    const app = createAppWithWorkspaceAuthority({
      coreDb,
      dataRoot: coreDb.dataRoot,
      store,
      turnExecutor: executor,
      runtimeConfigManager: config,
      fileAdmission: native.fileAdmission,
      workerControlGateway: native.workerControlGateway,
    });
    const workspaceDb = openWorkspaceDb(coreDb.dataRoot, workspaceId);
    const requestIds = [
      '00000000-0000-4000-8000-000000000300',
      '00000000-0000-4000-8000-000000000301',
    ];
    const post = (index: number) =>
      app.request(
        ...operationRequest(
          'task.start',
          { workspaceId, threadId: threadIds[index]! },
          {
            body: JSON.stringify({
              requestId: requestIds[index],
              input: 'Run an independent Task and complete once capacity is released.',
            }),
          }
        )
      );
    let admitted: Awaited<ReturnType<typeof native.admitTurn>> | undefined;
    try {
      const firstResponse = await post(0);
      expect(firstResponse.status, await firstResponse.clone().text()).toBe(202);
      const first = (await firstResponse.json()).turn as ReturnType<FsStore['getTurnById']>;
      const firstWork = native.executionFor(first.id);
      const firstCloseout = admissions.mock.results.find((result) => result.type === 'return')!
        .value.closeout;
      await Promise.race([firstWork.launched.promise, firstCloseout]);
      const firstAttempt = await vi.waitFor(() => {
        const attempt = attempts.listSchedulerExecutionAttemptsForTurn(coreDb, {
          workspaceId,
          threadId: first.threadId,
          turnId: first.id,
        })[0]!;
        expect(attempt).toMatchObject({
          phase: 'open',
          disposition: 'accepted',
          deadline: expect.any(String),
        });
        return attempt;
      });
      if (scenario === 'closeout') {
        firstWork.completion.resolve();
        await Promise.race([held.promise, firstWork.execution]);
      }
      expect(store.getTurnById(first.id).status).toBe('running');
      expect(executor.releaseResults).toEqual([]);
      const firstSession = store.getAgentSession(firstAttempt.agentSessionId!);
      expect(firstSession.status).toBe('busy');
      const firstStorage = getWorkerStorageBinding(coreDb, firstSession.retainedStorage!);
      expect(firstStorage).toMatchObject({
        state: 'attached',
        currentSandboxBindingRef: expect.any(String),
      });
      const firstBinding = harnessRecords.readNanoHostThreadAgentSessionBinding(coreDb, {
        workspaceId,
        threadId: first.threadId,
      });
      expect(firstBinding).toEqual({ agentSessionId: firstAttempt.agentSessionId });
      const effectsBefore = native.effects.length;
      const secondResponse = await post(1);
      expect(secondResponse.status, await secondResponse.clone().text()).toBe(202);
      const second = (await secondResponse.json()).turn as ReturnType<FsStore['getTurnById']>;
      expect(second.threadId).not.toBe(first.threadId);
      expect(second.id).not.toBe(first.id);
      const entry = attemptActionOwners
        .listQueuedSchedulerAdmissionEntries(coreDb)
        .find((candidate) => candidate.turnId === second.id)!;
      expect(entry).toMatchObject({
        status: 'queued',
        workspaceId,
        threadId: threadIds[1],
        requestId: requestIds[1],
      });
      expect(entry.workerStorageChoice).toBeNull();
      const secondScope = { workspaceId, threadId: second.threadId, turnId: second.id };
      const scope = { workspaceId, threadId: second.threadId, actorId: ownerUserId };
      const receipt = store.getCommandRequest('task.start', requestIds[1]!, scope);
      const checkpoint = getWorkerCheckpoint(workspaceDb, workspaceId, second.threadId, second.id);
      expect(receipt).toMatchObject({ response: { kind: 'turn', id: second.id } });
      expect(checkpoint).toMatchObject({
        stage: 'preparing',
        workerSessionId: null,
        turnId: second.id,
      });
      const eventsBefore = store.getTurnEvents(second.id);
      const { execution } = await vi.waitFor(() => {
        const index = dispatches.mock.calls.findIndex(
          ([input]) => input.callerQueueEntryId === entry.queueEntryId
        );
        const result = dispatches.mock.results[index];
        if (result?.type !== 'return') throw new Error('Original Task dispatch has not entered.');
        return { execution: result.value };
      });
      const deferred = await execution;
      expect(deferred).toMatchObject({
        startedTurns: [],
        terminalResult: { status: 'queued', reason: 'backend-busy' },
      });
      const busy = attempts.listSchedulerExecutionAttemptsForTurn(coreDb, secondScope);
      expect(busy).toHaveLength(1);
      expect(attempts.isSchedulerExecutionBusyRefusal(busy[0]!)).toBe(true);
      expect(getWorkerBackendSession(coreDb, busy[0]!.attemptId)).toBeNull();
      const finalGuard = scenario === 'materialization-forced-retirement-guard';
      const materialized = materialization.mock.calls.flatMap(([pkg], index) =>
        pkg.scope.threadId === second.threadId ? [materialization.mock.results[index]!.value] : []
      );
      expect(materialized).toHaveLength(finalGuard ? 1 : 0);
      if (finalGuard)
        await expect(materialized[0]).rejects.toBeInstanceOf(
          WorkerGovernanceCapacityUnavailableError
        );
      if (scenario === 'late-capacity') expect(configuration).toBe(reduced);
      expect(materializationCapacity).toEqual(finalGuard ? ['available'] : []);
      if (finalGuard)
        expect(configuration.openKitConfig.nanohost?.maxActiveTurnsPerSandbox).toBe(2);
      const retainedAttempt = attempts.requireSchedulerExecutionAttempt(
        coreDb,
        firstAttempt.attemptId
      );
      expect(attempts.schedulerExecutionCorrelation(retainedAttempt)).toEqual(
        attempts.schedulerExecutionCorrelation(firstAttempt)
      );
      expect(retainedAttempt).toMatchObject({
        queueEntryId: firstAttempt.queueEntryId,
        workspaceId,
        threadId: first.threadId,
        turnId: first.id,
        agentSessionId: firstSession.id,
        preparationInputJson: firstAttempt.preparationInputJson,
        deadline: firstAttempt.deadline,
        disposition: 'accepted',
      });
      // Terminal evidence can advance closing while the same exclusion remains held.
      expect(['open', 'closing']).toContain(retainedAttempt.phase);
      for (const field of ['terminalCause', 'outcomeRef', 'fenceRef'] as const)
        if (firstAttempt[field] !== null) expect(retainedAttempt[field]).toBe(firstAttempt[field]);
      expect(
        harnessRecords.readNanoHostThreadAgentSessionBinding(coreDb, {
          workspaceId,
          threadId: first.threadId,
        })
      ).toEqual(firstBinding);
      // Creation and update timestamps do not identify the retained attachment.
      const {
        createdAt: _storageCreatedAt,
        updatedAt: _storageUpdatedAt,
        ...storageAuthority
      } = firstStorage!;
      expect(getWorkerStorageBinding(coreDb, firstSession.retainedStorage!)).toMatchObject(
        storageAuthority
      );
      expect(store.getAgentSession(firstSession.id).status).toBe('busy');
      expect(store.getTurnById(second.id)).toMatchObject({
        id: second.id,
        status: 'pending',
        error: null,
        completedAt: null,
      });
      expect(store.getTurnById(second.id).agentSessionId ?? null).toBeNull();
      expect(store.getTurnEvents(second.id)).toEqual(eventsBefore);
      expect(
        store
          .getTurnEvents(second.id)
          .filter(
            (event) => event.event === 'turn.completed' && event.data.type === 'turn-completed'
          )
      ).toEqual([]);
      expect(
        attemptActionOwners.requireSchedulerAdmissionEntry(coreDb, entry.queueEntryId)
      ).toEqual(entry);
      expect(store.getCommandRequest('task.start', requestIds[1]!, scope)).toEqual(receipt);
      expect(getWorkerCheckpoint(workspaceDb, workspaceId, second.threadId, second.id)).toEqual(
        checkpoint
      );
      expect(store.listThreadAgentSessions(workspaceId, second.threadId)).toEqual([]);
      for (const effect of native.effects.slice(effectsBefore))
        expect(['image.acquire', 'image.inspect']).toContain(effect.kind);
      expect(native.effects.filter((effect) => effect.kind === 'sandbox.create')).toHaveLength(1);
      expect(
        commandObservation.mock.calls
          .filter(([command]) => command.operation === 'turn.start')
          .map(([command]) => command.body.turnId)
      ).toEqual([first.id]);
      for (const [command] of commandObservation.mock.calls)
        expect(['session.open', 'session.inspect', 'turn.start']).toContain(command.operation);
      expect(executor.releaseResults).toEqual([]);
      configuration = initial;
      release.resolve();
      firstWork.completion.resolve();
      await firstWork.execution;
      await firstCloseout;
      const closedFirst = attempts.requireSchedulerExecutionAttempt(coreDb, firstAttempt.attemptId);
      expect(closedFirst).toMatchObject({
        phase: 'closed',
        disposition: 'accepted',
        fenceRef: expect.any(String),
      });
      expect(executor.releaseResults).toEqual([
        expect.objectContaining({
          attemptId: firstAttempt.attemptId,
          inputRef: firstAttempt.inputRef,
          state: 'released',
          fenceRef: closedFirst.fenceRef,
        }),
      ]);
      expect(store.getTurnById(first.id).status).toBe('completed');
      const attemptId = testEntityId('attempt', 'attempt_busy_after_release');
      const agentSessionId = testEntityId('as', 'as_busy_second');
      expect(attemptId).not.toBe(busy[0]!.attemptId);
      admitted = await native.admitTurn(entry, {
        attemptId,
        agentSessionId,
        candidateAgentSessionId: agentSessionId,
      });
      expect(admitted.pkg.scope).toMatchObject({
        workspaceId,
        threadId: second.threadId,
        turnId: second.id,
        requestId: requestIds[1],
        agentSessionId,
      });
      expect((await admitted.complete()).startedTurns).toHaveLength(1);
      await Promise.all(
        admissions.mock.results
          .filter((result) => result.type === 'return')
          .map((result) => result.value.closeout)
      );
      expect(store.getTurnById(second.id)).toMatchObject({ status: 'completed', agentSessionId });
      const closedSecond = attempts.requireSchedulerExecutionAttempt(coreDb, attemptId);
      expect(closedSecond).toMatchObject({
        phase: 'closed',
        disposition: 'accepted',
        fenceRef: expect.any(String),
      });
      expect(executor.releaseResults[1]).toMatchObject({
        attemptId,
        inputRef: admitted.pkg.snapshotId,
        state: 'released',
        fenceRef: closedSecond.fenceRef,
      });
      expect(executor.releaseResults).toHaveLength(2);
      expect(store.getAgentSession(agentSessionId).retainedStorage!.storageRef).not.toBe(
        firstStorage!.storageRef
      );
      expect(store.getCommandRequest('task.start', requestIds[1]!, scope)).toEqual(receipt);
      const commands = commandObservation.mock.calls.map(([command]) => command);
      const starts = commands.filter((command) => command.operation === 'turn.start');
      expect(starts.map((command) => command.body.turnId)).toEqual([first.id, second.id]);
      expect(starts.map((command) => command.body.packageSnapshotId)).toEqual([
        firstAttempt.inputRef,
        admitted.pkg.snapshotId,
      ]);
      expect(starts.map((command) => command.body.agentSessionId)).toEqual([
        firstAttempt.agentSessionId,
        agentSessionId,
      ]);
      const commandWires = await Promise.all(
        commandObservation.mock.results.flatMap((result) =>
          result.type === 'return' ? [result.value] : []
        )
      );
      const authorities = commandWires.flatMap((wire) =>
        wire.operation === 'turn.start'
          ? [createHash('sha256').update(String(wire.body.workerControlToken)).digest('hex')]
          : []
      );
      expect(new Set(authorities).size).toBe(2);
      for (const command of commands)
        expect(['session.open', 'session.inspect', 'session.close', 'turn.start']).toContain(
          command.operation
        );
      expect(new Set(commands.map((command) => command.operationId)).size).toBe(commands.length);
      const allowed = [
        'image.acquire',
        'image.inspect',
        'sandbox.create',
        'bridge.open',
        'reference.import',
        'file.export',
        'workspace.collect',
        'bridge.close',
        'sandbox.delete',
      ];
      for (const effect of native.effects) expect(allowed).toContain(effect.kind);
      expect(new Set(native.effects.map((effect) => effect.requestId)).size).toBe(
        native.effects.length
      );
      const creates = native.effects.flatMap((effect, index) =>
        effect.kind === 'sandbox.create' ? [index] : []
      );
      expect(creates).toHaveLength(2);
      expect(
        native.effects.findIndex((effect) => effect.kind === 'sandbox.delete')
      ).toBeGreaterThan(creates[0]!);
      expect(native.effects.findIndex((effect) => effect.kind === 'sandbox.delete')).toBeLessThan(
        creates[1]!
      );
      expect(
        attempts
          .listSchedulerExecutionAttemptsForTurn(coreDb, secondScope)
          .map((attempt) => attempt.attemptId)
      ).toEqual([busy[0]!.attemptId, attemptId]);
    } finally {
      configuration = initial;
      release.resolve();
      for (const threadId of threadIds)
        for (const turn of store.listThreadTurns(workspaceId, threadId))
          native.executionFor(turn.id).completion.resolve();
      await admitted?.cleanup();
      await Promise.allSettled([...getSchedulerPreparationClaims(coreDb).values()]);
      // Failed assertions may leave accepted queued Tasks; cancel only through their public owner.
      for (const entry of attemptActionOwners
        .listQueuedSchedulerAdmissionEntries(coreDb)
        .filter((entry) => threadIds.includes(entry.threadId))) {
        await app.request(
          ...operationRequest('scheduler.cancel', { workspaceId, queueEntryId: entry.queueEntryId })
        );
      }
      await Promise.allSettled(
        admissions.mock.results
          .filter((result) => result.type === 'return')
          .map((result) => result.value.closeout)
      );
      await Promise.allSettled(
        vi
          .mocked(executor.startTurn)
          .mock.results.filter((result) => result.type === 'return')
          .map((result) => result.value)
      );
      collection.mockRestore();
      commitObservation.mockRestore();
      materialization.mockRestore();
      commandObservation.mockRestore();
      dispatches.mockRestore();
      admissions.mockRestore();
      configRead.mockRestore();
      await native.restore();
      await shutdownControlStoreWorkerClient();
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  }, 60_000);

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
    'cross-thread-pre-naming-recorded',
    'cross-thread-pre-naming-live',
    'cross-thread-pre-naming-unrecorded',
    'cross-thread-pre-naming-conflicting-digest',
    'cross-thread-pre-naming-conflicting-snapshot',
    'cross-thread-pre-naming-conflicting-attachment',
    'known-package-proof-handoff',
    'known-package-restoration',
    'ignored-package-proof-handoff',
    'ignored-package-cross-thread-handoff',
    'ignored-package-restoration',
  ] as const)('ordinary admission preserves native proof across eviction or incompatible replacement after restart: %s', async (scenario) => {
    const preNaming = scenario.includes('pre-naming');
    const ignored = scenario.startsWith('ignored-package');
    const historicalFirst = preNaming || ignored;
    let coreDb = createFactoryCoreDb();
    const dataRoot = coreDb.dataRoot;
    const ownerUserId = ensureLocalUser(coreDb);
    let store = await createDemoStore({ dataRoot });
    const workspaceId = DEMO_WORKSPACE_ID;
    recordWorkspaceOwnerMembership({ coreDb, workspaceId, ownerUserId });
    const threadIds = ['a', 'b'].map((label) => testEntityId('th', `proof_${scenario}_${label}`));
    for (const threadId of threadIds)
      await store.createThread(workspaceId, 'Native continuity', threadId);
    const manifests = ['codex', 'pi'].map(
      (adapter, index) =>
        createTestAgentSetup({
          adapter,
          agentId: `agent_proof_${index}`,
          imageRef: `sha256:${(index ? 'b' : 'a').repeat(64)}`,
          requiredCapabilities: ['trusted-worker-inference-relay'],
        }).manifest
    );
    for (const manifest of manifests) admitTestNativeEnvironment(coreDb, manifest);
    const readRuntimeConfig = () =>
      createInMemoryRuntimeConfigSnapshot({
        ...loadRuntimeConfig(dataRoot),
        agentManifests: manifests,
        gatewayConfig: createTestGatewayConfig(),
        providerRegistry: new ProviderRegistry([
          {
            id: 'agent-openrouter',
            displayName: 'Proof fixture',
            kind: 'local',
            models: ['openai/gpt-5.2'],
          },
        ]),
      });
    let native = createNativeTaskAdmissionFixture(coreDb, store, { readRuntimeConfig });
    const outside = native.outside;
    const commands: harnessRecords.NanoHostHarnessCommand[] = [];
    const results: Parameters<typeof native.runtime.acceptNanoHostHarnessResult>[0][] = [];
    const authorities: string[] = [];
    const observations: Array<() => void> = [];
    const joins: Array<() => Promise<void>> = [];
    let original: ReturnType<FsStore['getAgentSession']> | undefined;
    let originalPackage: AgentEnvironmentPackage | undefined;
    let originalAttemptId: string | undefined;
    // Observe the existing effect entry; no response, request identity or history is changed.
    const push = outside.effects.push.bind(outside.effects);
    const effectObservation = vi
      .spyOn(outside.effects, 'push')
      .mockImplementation((...requests) => {
        const length = push(...requests);
        for (const request of requests)
          if (['bridge.close', 'sandbox.delete'].includes(request.kind)) {
            if (!original) throw new Error('Retirement preceded acknowledged native proof.');
            expect(store.getAgentSession(original.id)).toMatchObject({
              nativeHandleDigest: original!.nativeHandleDigest,
              retainedStorage: original!.retainedStorage,
            });
          }
        return length;
      });
    /** Observes every actual command, keeping credentials only as scoped equality hashes. */
    const observe = () => {
      const accept = native.runtime.acceptNanoHostHarnessCommand;
      const command = vi
        .spyOn(native.runtime, 'acceptNanoHostHarnessCommand')
        .mockImplementation(async (request) => {
          const wire = await accept(request);
          commands.push({
            ...wire,
            body: Object.fromEntries(
              [
                'agentSessionId',
                'agentSessionRuntimeBindingId',
                'turnId',
                'leaseId',
                'packageSnapshotId',
                'resume',
              ].map((key) => [key, wire.body[key]])
            ),
          });
          if (wire.operation === 'session.open')
            for (const key of ['capabilityLoopbackCredential', 'inferenceLoopbackCredential']) {
              expect(wire.body[key]).toEqual(expect.any(String));
              authorities.push(createHash('sha256').update(String(wire.body[key])).digest('hex'));
            }
          if (wire.operation === 'turn.start')
            for (const key of ['workerControlToken', 'inferenceToken', 'capabilityToken']) {
              expect(wire.body[key]).toEqual(expect.any(String));
              authorities.push(createHash('sha256').update(String(wire.body[key])).digest('hex'));
            }
          return wire;
        });
      const acceptResult = native.runtime.acceptNanoHostHarnessResult;
      const result = vi
        .spyOn(native.runtime, 'acceptNanoHostHarnessResult')
        .mockImplementation(async (value) => {
          await acceptResult(value);
          results.push(value);
        });
      observations.push(() => {
        command.mockRestore();
        result.mockRestore();
      });
    };
    observe();
    /** Joins and stops the sole peer before disposing its Core controller. */
    const stop = async () => {
      for (const join of joins.splice(0)) await join();
      for (const restore of observations.splice(0)) restore();
      await native.restore();
      await shutdownControlStoreWorkerClient();
    };
    /** Reopens the joined stopped controller with the same outside incarnation. */
    const restart = () => {
      coreDb.sqlite.close();
      coreDb = openCoreDb(dataRoot);
      store = new FsStore({ dataRoot });
      // Age only the synchronous Main replay reader; native work always starts with real clocks.
      if (historicalFirst) vi.useFakeTimers({ toFake: ['Date'] });
      try {
        if (historicalFirst) {
          vi.setSystemTime(vi.getRealSystemTime() + attempts.EXECUTION_ATTEMPT_BUDGET_MS);
          const originalAttempt = attempts.requireSchedulerExecutionAttempt(
            coreDb,
            originalAttemptId!
          );
          expect(originalAttempt.phase).toBe('closed');
          expect(Date.parse(originalAttempt.deadline!)).toBeLessThanOrEqual(Date.now());
        }
        native = createNativeTaskAdmissionFixture(coreDb, store, { readRuntimeConfig }, outside);
      } finally {
        if (historicalFirst) vi.useRealTimers();
      }
      observe();
    };
    const entryFor = async (index: number, agent: number, thread: number) => {
      const turnId = testEntityId('tu', `proof_${scenario}_${index}`);
      const attemptId = testEntityId('attempt', `proof_${scenario}_${index}`);
      const agentSessionId = testEntityId('as', `proof_${scenario}_${index}`);
      const entry = createSchedulerAdmissionEntry(coreDb, {
        backendId: 'nanohost',
        queueEntryId: `queue:${attemptId}`,
        requestId: testEntityId('tu', `request_proof_${scenario}_${index}`).slice(3),
        requestedAgentId: manifests[agent]!.id,
        workspaceId,
        threadId: threadIds[thread]!,
        turnId,
        turnInput: `Native proof ${index}`,
        triggerActor: { kind: 'user', id: ownerUserId },
      });
      await publishFactoryAdmission(store, entry);
      return { entry, attemptId, agentSessionId };
    };
    /** Completes only work actually accepted by the native peer and its release owner. */
    const run = async (
      input: Awaited<ReturnType<typeof entryFor>>,
      resume: { locator: string; digest: string } | null
    ) => {
      const admitted = await native.admitTurn(input.entry, {
        ...input,
        candidateAgentSessionId: input.agentSessionId,
      });
      joins.push(admitted.cleanup);
      const { pkg } = admitted;
      expect(pkg.scope).toMatchObject({
        workspaceId,
        threadId: input.entry.threadId,
        turnId: input.entry.turnId,
        agentSessionId: input.agentSessionId,
        requestId: input.entry.requestId,
        triggerActor: input.entry.triggerActor,
      });
      const open = commands.find(
        (command) =>
          command.operation === 'session.open' &&
          command.body.agentSessionId === input.agentSessionId
      )!;
      const start = commands.find(
        (command) =>
          command.operation === 'turn.start' && command.body.turnId === input.entry.turnId
      )!;
      expect(open.body.resume).toEqual(resume);
      expect(start.body).toMatchObject({
        agentSessionId: input.agentSessionId,
        agentSessionRuntimeBindingId: open.body.agentSessionRuntimeBindingId,
        turnId: input.entry.turnId,
        leaseId: input.attemptId,
        packageSnapshotId: pkg.snapshotId,
      });
      expect(commands.indexOf(open)).toBeLessThan(commands.indexOf(start));
      expect(
        (await admitted.complete()).startedTurns.map(({ dispatch }) => dispatch.attempt.attemptId)
      ).toEqual([input.attemptId]);
      expect(store.getTurnById(input.entry.turnId)).toMatchObject({
        status: 'completed',
        agentSessionId: input.agentSessionId,
      });
      const closed = attempts.requireSchedulerExecutionAttempt(coreDb, input.attemptId);
      expect(closed).toMatchObject({
        phase: 'closed',
        fenceRef: expect.any(String),
        inputRef: pkg.snapshotId,
      });
      expect(native.executor.releaseResults).toContainEqual(
        expect.objectContaining({
          ...schedulerExecutionCorrelation(closed),
          state: 'released',
          fenceRef: closed.fenceRef,
        })
      );
      expect(store.getAgentSession(input.agentSessionId)).toMatchObject({
        status: 'idle',
        nativeHandleDigest: 'a'.repeat(64),
        retainedStorage: expect.any(Object),
      });
      return pkg;
    };
    /** Uses the ordinary scheduler and joins its actual preparation without fabricating admission. */
    const dispatch = async (admission: Awaited<ReturnType<typeof entryFor>>) => {
      const config = readRuntimeConfig();
      const input = {
        coreDb,
        store,
        turnExecutor: native.executor,
        executionBackend: native.executor.executionBackend,
        agentManifests: config.agentManifests,
        gatewayConfig: config.gatewayConfig,
        providerRegistry: config.providerRegistry,
        workspaceMcpServerCatalogs: config.workspaceMcpServerCatalogs,
        maxDispatches: 1,
        createAttemptId: () => admission.attemptId,
        createAgentSessionId: () => admission.agentSessionId,
      };
      const observations = await Promise.allSettled([runSchedulerDispatchLoop(input)]);
      observations.push(
        ...(await Promise.allSettled([...getSchedulerPreparationClaims(coreDb).values()]))
      );
      return observations;
    };
    /** Models outside loss, then submits its fresh report through the actual target owner. */
    const loseEpoch = async (attemptId: string) => {
      const target = recordTestNativeRuntimeTarget(coreDb);
      expect(getWorkerBackendSession(coreDb, attemptId)!.originPhysicalEpoch).toBe(
        target.physicalEpoch
      );
      await stop();
      outside.bindings.clear();
      outside.integrationBindingRef = undefined;
      recordNanoHostRuntimeTargetConnectionClose(coreDb, {
        targetId: target.targetId,
        closedGeneration: target.connectionGeneration,
        authoritativeGeneration: null,
        observedAt: new Date().toISOString(),
      });
      const next = allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
        targetId: target.targetId,
        identityId: target.identityId,
        deploymentId: target.deploymentId,
        observedAt: new Date().toISOString(),
      });
      const fresh = upsertNanoHostRuntimeTarget(coreDb, {
        ...next,
        freshEmpty: true,
        predecessorFenced: true,
        ready: true,
        physicalEpoch: 'f'.repeat(64),
        observedAt: new Date().toISOString(),
      });
      expect(fresh.physicalEpoch).not.toBe(target.physicalEpoch);
      restart();
    };
    try {
      let baseline: ReturnType<FsStore['getAgentSession']> | undefined;
      if (scenario === 'handoff' || scenario === 'image-handoff') {
        const prior = await entryFor(0, 0, 0);
        await run(prior, null);
        baseline = original = store.getAgentSession(prior.agentSessionId);
        manifests[0]!.runtime.version = '0.153.4';
        admitTestNativeEnvironment(coreDb, manifests[0]!);
      }
      const first = await entryFor(1, 0, 0);
      originalAttemptId = first.attemptId;
      const unrecorded = ['handoff', 'image-handoff', 'cross-thread-handoff'].includes(scenario);
      if (unrecorded) {
        const commandCount = commands.length;
        const effectCount = outside.effects.length;
        const failedExecution = Promise.allSettled([
          native.executionFor(first.entry.turnId).execution,
        ]);
        const record = native.executor.recordNativeHandleDigest;
        const fault = vi
          .spyOn(native.executor, 'recordNativeHandleDigest')
          .mockImplementation((...args) =>
            args[1] === first.agentSessionId
              ? Promise.reject(new Error('Controlled pre-ACK native proof publication failure.'))
              : record.apply(native.executor, args)
          );
        try {
          await expect(
            native.admitTurn(first.entry, {
              ...first,
              candidateAgentSessionId: first.agentSessionId,
            })
          ).rejects.toThrow();
        } finally {
          fault.mockRestore();
        }
        expect(await failedExecution).toMatchObject([{ status: 'rejected' }]);
        const failedAttempt = attempts.requireSchedulerExecutionAttempt(coreDb, first.attemptId);
        expect(failedAttempt).toMatchObject({ phase: 'closing', fenceRef: null });
        expect(store.getTurnById(first.entry.turnId).status).toBe('failed');
        expect(store.getAgentSession(first.agentSessionId)).toMatchObject({
          nativeHandleDigest: null,
          retainedStorage: expect.any(Object),
        });
        if (baseline)
          expect(store.getAgentSession(first.agentSessionId).retainedStorage).toEqual(
            baseline.retainedStorage
          );
        const opened = commands.find(
          (command) =>
            command.operation === 'session.open' &&
            command.body.agentSessionId === first.agentSessionId
        )!;
        const ready = results.find((result) => result.operationId === opened.operationId);
        expect(ready).toMatchObject({
          disposition: 'succeeded',
          body: { nativeHandleDigest: 'a'.repeat(64) },
        });
        expect(
          commands.slice(commandCount).some((command) => command.operation === 'turn.start')
        ).toBe(false);
        expect(
          outside.effects
            .slice(effectCount)
            .some((effect) => ['bridge.close', 'sandbox.delete'].includes(effect.kind))
        ).toBe(false);
        // Decision:76/78: retry the real recorder while its original cleanup owner still exists.
        const anchor = getWorkerBackendSession(coreDb, first.attemptId)!;
        await native.runtime.restoreBackendSession(anchor);
        expect(store.getAgentSession(first.agentSessionId).nativeHandleDigest).toBe('a'.repeat(64));
        original = store.getAgentSession(first.agentSessionId);
        const originalOutcome = store.getTurnById(first.entry.turnId);
        await runNanoHostAttemptRecoveryMaintenance(coreDb, {
          store,
          executionBackend: native.executor.executionBackend,
          cleanupBackendSession: native.runtime.cleanupBackendSession,
          reconcileExecutions: () => native.runtime.executionReconciler.runOnce(),
          prepareBackendCleanup: native.runtime.prepareBackendCleanup,
          restoreBackendSession: native.runtime.restoreBackendSession,
          reconcileAcceptedFinalStatus: native.runtime.reconcileAcceptedFinalStatus,
          isTurnExecutionActive: native.runtime.isTurnExecutionActive,
          projectRecoveredTurn: async (subject) => {
            const actual = await terminalizeGovernedWorkerTurn({
              store,
              turnId: subject.turnId,
              agentSessionId: subject.agentSessionId,
              requestId: first.entry.requestId,
              completedAt: new Date().toISOString(),
              errorCode: 'worker_governance_restart_recovery',
              message: 'Worker execution was interrupted during scheduler recovery.',
              outcome: 'interrupted',
            });
            // Terminal recovery preserves the actual first failed outcome; it supplies no completion.
            expect(actual.status).toBe('failed');
            return { status: actual.status as 'failed' };
          },
        });
        expect(store.getTurnById(first.entry.turnId)).toEqual(originalOutcome);
        expect(attempts.requireSchedulerExecutionAttempt(coreDb, first.attemptId)).toMatchObject({
          phase: 'closed',
          fenceRef: expect.any(String),
        });
        expect(native.executor.releaseResults).toContainEqual(
          expect.objectContaining({
            attemptId: first.attemptId,
            state: 'released',
            fenceRef: expect.any(String),
          })
        );
        const db = openWorkspaceDb(dataRoot, workspaceId);
        try {
          originalPackage = requireAgentEnvironmentPackageSnapshot(
            db,
            workspaceId,
            anchor.packageSnapshotId
          ).snapshot;
        } finally {
          db.sqlite.close();
        }
      } else {
        originalPackage = await run(first, null);
      }
      original = store.getAgentSession(first.agentSessionId);
      const originalStorage = getWorkerStorageBinding(coreDb, original.retainedStorage!)!;
      const originalHistory = store.getTurnEvents(first.entry.turnId);
      const resume = { digest: original.nativeHandleDigest!, locator: original.id };
      const snapshotPath = join(
        dataRoot,
        'workspaces',
        workspaceId,
        'runtime/agent-sessions',
        original.id,
        'aep-snapshots',
        `${originalPackage!.snapshotId}.json`
      );
      const initialBytes = readFileSync(snapshotPath, 'utf8');
      const backend = native.executor.executionBackend as WorkerGovernanceBackend;
      if (scenario === 'cross-thread-closed-handoff') {
        expect(
          await backend.prepareAgentSessionContinuity!({
            agentSessionId: original.id,
            workspaceId,
            threadId: original.threadId,
            reuseAllowed: false,
          })
        ).toBe('closed');
        const close = commands.find(
          (command) =>
            command.operation === 'session.close' && command.body.agentSessionId === original!.id
        )!;
        expect(results).toContainEqual(
          expect.objectContaining({
            operationId: close.operationId,
            disposition: 'succeeded',
            body: expect.objectContaining({ state: 'closed', privateState: 'absent' }),
          })
        );
      }
      await stop();
      const corrupted =
        ['missing-fact', 'cross-thread-missing-fact'].includes(scenario) ||
        /pre-naming-(unrecorded|conflicting-)/.test(scenario);
      let corruptedRecord: string | undefined;
      if (corrupted) {
        // Exact stopped-row historical fault, never an ordinary crash or successful owner write.
        const db = openWorkspaceDb(dataRoot, workspaceId);
        try {
          const row = db.sqlite
            .prepare(
              'SELECT revision, record_json FROM control_agent_sessions WHERE id = ? AND workspace_id = ? AND thread_id = ?'
            )
            .get(original.id, workspaceId, original.threadId) as {
            revision: number;
            record_json: string;
          };
          expect(row).toBeDefined();
          const record = JSON.parse(row.record_json);
          if (scenario.endsWith('missing-fact')) {
            record.nativeHandleDigest = null;
            record.retainedStorage = null;
          }
          if (scenario.endsWith('unrecorded')) record.nativeHandleDigest = null;
          if (scenario.endsWith('conflicting-digest')) record.nativeHandleDigest = 'e'.repeat(64);
          if (scenario.endsWith('conflicting-snapshot'))
            record.environmentPackageSnapshotId = originalPackage!.snapshotId + '_foreign';
          if (scenario.endsWith('conflicting-attachment'))
            record.retainedStorage.workSlotRef = workerStorageDefaultWorkSlotRef(
              workspaceId,
              threadIds[1]!
            );
          corruptedRecord = JSON.stringify(record);
          expect(
            db.sqlite
              .prepare(
                'UPDATE control_agent_sessions SET record_json = ? WHERE id = ? AND workspace_id = ? AND thread_id = ? AND revision = ? AND record_json = ?'
              )
              .run(
                corruptedRecord,
                original.id,
                workspaceId,
                original.threadId,
                row.revision,
                row.record_json
              ).changes
          ).toBe(1);
        } finally {
          db.sqlite.close();
        }
      }
      const known = scenario.startsWith('known-package');
      if (preNaming || known || ignored) {
        const retained = JSON.parse(initialBytes);
        if (preNaming)
          retained.snapshot.capabilities.routes = [
            'mcp.list_servers',
            'mcp.list_tools',
            'mcp.call_tool',
          ];
        else if (ignored)
          // Current admission plus a rehashed addition is corruption, not historical authority.
          retained.snapshot.control.transcript.artifactsPath = '/retired-transcript-artifacts';
        else
          retained.snapshot.runtime.command.stdout =
            retained.snapshot.runtime.command.stdout === 'ignore' ? 'pipe' : 'ignore';
        retained.contentDigest = createHash('sha256')
          .update(JSON.stringify(retained.snapshot))
          .digest('hex');
        writeFileSync(snapshotPath, JSON.stringify(retained));
      }
      const retainedBytes = readFileSync(snapshotPath, 'utf8');
      restart();
      if (scenario === 'ignored-package-proof-handoff') {
        // AEP Restart And Recovery: prove each authority refusal through public cold restoration.
        // Faults follow real admission; original keys, proof and attachment are never regenerated.
        writeFileSync(snapshotPath, initialBytes);
        const anchor = getWorkerBackendSession(coreDb, first.attemptId)!;
        const proof = store.getAgentSession(original.id);
        const wrongAttempt = testEntityId('attempt', `proof_${scenario}_foreign`);
        // Establish the clean control before faults; an always-failing restore cannot pass this matrix.
        await native.runtime.restoreBackendSession(anchor);
        expect(store.getAgentSession(original.id)).toEqual(proof);
        /** Proves cold refusal without changing accepted native or durable authority. */
        const refuse = async (fault: string, afterRead?: () => void) => {
          const effects = [...outside.effects];
          const sent = [...commands];
          const bytes = readFileSync(snapshotPath, 'utf8');
          const authority = [
            'worker_backend_sessions',
            'agent_session_runtime_bindings',
            'worker_storage_bindings',
          ].map((table) => ({
            table,
            rows: coreDb.sqlite.prepare(`SELECT * FROM ${table}`).all(),
          }));
          // Keep controller construction outside the expected restore refusal.
          await stop();
          expect(restart, `cold controller before ${fault}`).not.toThrow();
          const damagedAnchor =
            getWorkerBackendSession(coreDb, first.attemptId) ??
            getWorkerBackendSession(coreDb, wrongAttempt);
          expect(damagedAnchor).toBeDefined();
          if (afterRead) {
            const read = harnessRecords.inspectNanoHostAgentSessionContinuity;
            let injected = false;
            const crossing = vi
              .spyOn(harnessRecords, 'inspectNanoHostAgentSessionContinuity')
              .mockImplementationOnce((...args) => {
                const inspection = read(...args);
                expect(inspection).not.toBeNull();
                afterRead();
                injected = true;
                for (const entry of authority)
                  entry.rows = coreDb.sqlite.prepare(`SELECT * FROM ${entry.table}`).all();
                return inspection;
              });
            try {
              await expect(
                (native.executor.executionBackend as WorkerGovernanceBackend)
                  .prepareAgentSessionContinuity!({
                  agentSessionId: original!.id,
                  threadId: original!.threadId,
                  workspaceId,
                  reuseAllowed: true,
                  recordNativeHandleDigest: native.executor.recordNativeHandleDigest.bind(
                    native.executor,
                    store,
                    original!.id
                  ),
                })
              ).rejects.toThrow();
              expect(injected).toBe(true);
            } finally {
              crossing.mockRestore();
            }
          } else
            await expect(native.runtime.restoreBackendSession(damagedAnchor!)).rejects.toThrow();
          expect(outside.effects).toEqual(effects);
          expect(commands).toEqual(sent);
          expect(store.getAgentSession(original!.id)).toEqual(proof);
          expect(store.getTurnEvents(first.entry.turnId)).toEqual(originalHistory);
          expect(readFileSync(snapshotPath, 'utf8')).toBe(bytes);
          // Recovery refusal must preserve the deliberately damaged authority, not repair it.
          for (const { table, rows } of authority)
            expect(coreDb.sqlite.prepare(`SELECT * FROM ${table}`).all()).toEqual(rows);
        };
        for (const [table, field, altered] of [
          ['agent_session_runtime_bindings', 'agent_session_runtime_binding_id', 'wrong-binding'],
          ['agent_session_runtime_bindings', 'native_handle_digest', 'e'.repeat(64)],
          ['worker_backend_sessions', 'thread_id', threadIds[1]!],
          ['worker_backend_sessions', 'origin_physical_epoch', 'e'.repeat(64)],
          [
            'worker_backend_sessions',
            'backend_lineage_json',
            JSON.stringify({ imageRef: `sha256:${'7'.repeat(64)}` }),
          ],
          [
            'worker_backend_sessions',
            'backend_session_id',
            `nh-${'e'.repeat(16)}-${'f'.repeat(16)}`,
          ],
          ['worker_backend_sessions', 'runtime_target_id', 'wrong-target'],
          ['worker_backend_sessions', 'attempt_id', wrongAttempt],
          ['agent_session_runtime_bindings', 'thread_id', threadIds[1]!],
          ['agent_session_runtime_bindings', 'agent_session_compatibility_key', 'e'.repeat(64)],
          ['worker_storage_bindings', 'current_sandbox_binding_ref', 'wrong-binding'],
        ] as const) {
          const rows = coreDb.sqlite.prepare(`SELECT ${field} AS value FROM ${table}`).all() as {
            value: string;
          }[];
          expect(rows).toHaveLength(1);
          try {
            const mutate = () =>
              expect(
                coreDb.sqlite.prepare(`UPDATE ${table} SET ${field} = ?`).run(altered).changes
              ).toBe(1);
            const stale =
              field === 'agent_session_runtime_binding_id' || field === 'native_handle_digest';
            if (field === 'native_handle_digest') {
              mutate();
              await refuse(`${table}.${field}:cold`);
              coreDb.sqlite.prepare(`UPDATE ${table} SET ${field} = ?`).run(rows[0]!.value);
            }
            if (!stale) mutate();
            await refuse(`${table}.${field}`, stale ? mutate : undefined);
          } finally {
            coreDb.sqlite.prepare(`UPDATE ${table} SET ${field} = ?`).run(rows[0]!.value);
          }
        }
        for (const fault of [
          'checksum',
          'inner-thread',
          'outer-and-inner-thread',
          'actor',
          'request',
        ]) {
          const retained = JSON.parse(initialBytes);
          if (fault.includes('thread') || fault === 'checksum')
            retained.snapshot.scope.threadId = threadIds[1]!;
          if (fault === 'outer-and-inner-thread') retained.threadId = threadIds[1]!;
          if (fault === 'actor')
            retained.snapshot.scope.triggerActor = {
              kind: 'user',
              id: 'usr_00000000-0000-78d7-b17c-43d9aa145f21',
            };
          if (fault === 'request') retained.snapshot.scope.requestId = 'wrong-package-request';
          if (fault !== 'checksum')
            retained.contentDigest = createHash('sha256')
              .update(JSON.stringify(retained.snapshot))
              .digest('hex');
          try {
            writeFileSync(snapshotPath, JSON.stringify(retained));
            await refuse(fault);
          } finally {
            writeFileSync(snapshotPath, initialBytes);
          }
        }
        writeFileSync(snapshotPath, retainedBytes);
        await stop();
        restart();
      }
      const physicallyAbsent =
        (preNaming && !scenario.endsWith('live')) || scenario === 'cross-thread-old-epoch-handoff';
      if (physicallyAbsent) await loseEpoch(first.attemptId);
      const crossThread =
        scenario.startsWith('cross-thread') ||
        scenario === 'eviction' ||
        scenario === 'ignored-package-cross-thread-handoff';
      if (!crossThread) {
        manifests[0] = {
          ...manifests[0]!,
          runtime: {
            ...manifests[0]!.runtime,
            ...(scenario.startsWith('image-')
              ? {
                  image: {
                    kind: 'reference',
                    ref: `sha256:${'d'.repeat(64)}`,
                    pullPolicy: 'never',
                  },
                }
              : { version: '0.153.5' }),
          },
        };
        admitTestNativeEnvironment(coreDb, manifests[0]!);
      }
      const second = await entryFor(2, crossThread ? 1 : 0, crossThread ? 1 : 0);
      const negative = corrupted || scenario.endsWith('pre-naming-live') || known || ignored;
      if (negative) {
        const effectsBefore = [...outside.effects];
        const commandsBefore = [...commands];
        const storageBefore = getWorkerStorageBinding(coreDb, originalStorage!);
        const bindingBefore = coreDb.sqlite
          .prepare('SELECT * FROM agent_session_runtime_bindings WHERE agent_session_id = ?')
          .get(original.id);
        const anchorBefore = getWorkerBackendSession(coreDb, first.attemptId);
        if (
          scenario === 'known-package-restoration' ||
          scenario === 'ignored-package-restoration'
        ) {
          await expect(native.runtime.restoreBackendSession(anchorBefore!)).rejects.toBeInstanceOf(
            WorkerNativeProofValidationError
          );
          expect(store.getTurnById(second.entry.turnId).status).toBe('pending');
          expect(attemptActionOwners.listQueuedSchedulerAdmissionEntries(coreDb)).toContainEqual(
            expect.objectContaining({
              queueEntryId: second.entry.queueEntryId,
              turnId: second.entry.turnId,
            })
          );
        } else {
          for (const observation of await dispatch(second)) {
            if (observation.status === 'rejected')
              expect(observation.reason).toMatchObject({ code: 'recovery_required', status: 409 });
            else expect(observation.value.startedTurns).toEqual([]);
          }
          expect(store.getTurnById(second.entry.turnId)).toMatchObject({
            status: 'failed',
            error: { code: 'worker_preparation_failed' },
          });
          expect(
            attempts.listSchedulerExecutionAttemptsByTurnId(coreDb, second.entry.turnId)
          ).toEqual([
            expect.objectContaining({
              attemptId: second.attemptId,
              queueEntryId: second.entry.queueEntryId,
              workspaceId,
              threadId: second.entry.threadId,
              turnId: second.entry.turnId,
              backendId: 'nanohost',
              phase: 'closed',
              operationId: null,
              terminalCause: 'turn-start-failed',
            }),
          ]);
        }
        expect(outside.effects).toEqual(effectsBefore);
        expect(commands).toEqual(commandsBefore);
        expect(
          store
            .listWorkspaceAgentSessions(workspaceId)
            .filter((session) => isCurrentAgentSessionStatus(session.status))
            .some((session) => session.id === second.agentSessionId)
        ).toBe(false);
        expect(getWorkerStorageBinding(coreDb, originalStorage!)).toEqual(storageBefore);
        expect(getWorkerBackendSession(coreDb, first.attemptId)).toEqual(anchorBefore);
        expect(
          coreDb.sqlite
            .prepare('SELECT * FROM agent_session_runtime_bindings WHERE agent_session_id = ?')
            .get(original.id)
        ).toEqual(bindingBefore);
        if (corruptedRecord) {
          const db = openWorkspaceDb(dataRoot, workspaceId);
          try {
            expect(
              (
                db.sqlite
                  .prepare('SELECT record_json FROM control_agent_sessions WHERE id = ?')
                  .get(original.id) as { record_json: string }
              ).record_json
            ).toBe(corruptedRecord);
          } finally {
            db.sqlite.close();
          }
        } else expect(store.getAgentSession(original.id)).toEqual(original);
      } else {
        const before = outside.effects.length;
        await run(second, crossThread ? null : resume);
        const next = store.getAgentSession(second.agentSessionId);
        expect(store.getAgentSession(original.id)).toMatchObject({
          nativeHandleDigest: resume.digest,
          retainedStorage: original.retainedStorage,
        });
        if (crossThread) {
          expect(next.retainedStorage!.storageRef).not.toBe(originalStorage.storageRef);
          expect(getWorkerStorageBinding(coreDb, originalStorage)).toMatchObject({
            state: 'idle',
            currentSandboxBindingRef: null,
          });
        } else
          expect(next.retainedStorage).toEqual({
            ...original.retainedStorage,
            attachmentGeneration: getWorkerStorageBinding(coreDb, next.retainedStorage!)!
              .attachmentGeneration,
          });
        if (!crossThread) {
          expect(store.getAgentSession(original.id)).toMatchObject({
            status: expect.stringMatching(/^(closed|failed)$/),
            nativeHandleDigest: resume.digest,
            retainedStorage: original.retainedStorage,
          });
          expect(
            store
              .listWorkspaceAgentSessions(workspaceId)
              .filter(
                (session) =>
                  session.threadId === original!.threadId &&
                  isCurrentAgentSessionStatus(session.status)
              )
              .map((session) => session.id)
          ).toEqual([second.agentSessionId]);
        }
        if (physicallyAbsent)
          expect(
            outside.effects
              .slice(before)
              .some((effect) => ['bridge.close', 'sandbox.delete'].includes(effect.kind))
          ).toBe(false);
        if (scenario === 'image-intact')
          expect(
            outside.effects.slice(before).some((effect) => effect.kind === 'sandbox.delete')
          ).toBe(true);
        if (scenario === 'eviction') {
          await stop();
          restart();
          const third = await entryFor(3, 0, 0);
          await run(third, resume);
          expect(store.getAgentSession(third.agentSessionId).retainedStorage).toEqual({
            ...original.retainedStorage,
            attachmentGeneration: getWorkerStorageBinding(coreDb, original.retainedStorage!)!
              .attachmentGeneration,
          });
          expect(
            outside.effects
              .filter((effect) => effect.kind === 'sandbox.create')
              .map((effect) => (effect.input.storage as { storageRef: string }).storageRef)
          ).toEqual([
            original.retainedStorage!.storageRef,
            next.retainedStorage!.storageRef,
            original.retainedStorage!.storageRef,
          ]);
        }
        for (const effect of outside.effects)
          if (
            effect.kind === 'sandbox.create' &&
            (effect.input.storage as { storageRef: string }).storageRef ===
              original.retainedStorage!.storageRef
          )
            expect(effect.input.storage).toMatchObject({
              targets: originalStorage!.targets
                .filter((target) => target.active)
                .map(({ target, volumeRef }) => ({ target, volumeRef })),
            });
      }
      expect(readFileSync(snapshotPath, 'utf8')).toBe(retainedBytes);
      expect(store.getTurnEvents(first.entry.turnId)).toEqual(originalHistory);
      expect(store.getTurnById(first.entry.turnId).status).toBe(
        unrecorded ? 'failed' : 'completed'
      );
      expect(new Set(commands.map((command) => command.operationId)).size).toBe(commands.length);
      expect(new Set(authorities).size).toBe(authorities.length);
      expect(new Set(outside.effects.map((effect) => effect.requestId)).size).toBe(
        outside.effects.length
      );
      for (const command of commands)
        expect([
          'session.open',
          'session.inspect',
          'session.close',
          'turn.start',
          'turn.end',
        ]).toContain(command.operation);
      for (const effect of outside.effects)
        expect([
          'image.acquire',
          'image.inspect',
          'sandbox.create',
          'bridge.open',
          'reference.import',
          'workspace.collect',
          'file.export',
          'bridge.close',
          'sandbox.delete',
        ]).toContain(effect.kind);
    } finally {
      for (const join of joins.splice(0)) await join();
      if (vi.isMockFunction(native.executor.startTurn))
        for (const result of native.executor.startTurn.mock.results)
          if (result.type === 'return') await result.value.catch(() => undefined);
      await stop();
      effectObservation.mockRestore();
      coreDb.sqlite.close();
    }
  }, 60_000);

  // Four durable admissions need the same runner budget as adjacent lifecycle fixtures.
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
          agentSessionId: testEntityId('as', `as_admission_stall_${number}`),
          agentSetup: setup,
          backend: { kind: 'openshell' },
          createdAt: '2026-09-06T00:00:00.000Z',
          requestId: `request_admission_stall_${number}`,
          triggerActor: { kind: 'user', id: 'usr_00000000-0000-7353-b5d8-71f1d581a738' },
          turn: {
            completedAt: null,
            configVersion: null,
            durationMs: null,
            error: null,
            id: testEntityId('tu', `turn_admission_stall_${number}`),
            items: [],
            startedAt: '2026-09-06T00:00:00.000Z',
            status: 'running',
            threadId: testEntityId('th', `thread_admission_stall_${number}`),
            triggerActor: { kind: 'user', id: 'usr_00000000-0000-7353-b5d8-71f1d581a738' },
            owner: { kind: 'workspace', workspaceId: 'ws_00000000-0000-7ae6-ab0c-3edb48a2c46a' },
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
        const { command, integrationRef } = await waitForFactoryHarnessCommand(coreDb);
        if (!command || command.operation !== operation)
          throw new Error(`Expected queued ${operation} Harness command.`);
        settledOperations.push(command.operation);
        await runtime.acceptNanoHostHarnessCommand(command);
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
        await runtime.acceptNanoHostHarnessResult(result);
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
      const dispatch = async (environmentPackage: AgentEnvironmentPackage) => {
        expect(await backend.inspectMaterializationCapacity?.(environmentPackage)).toBe(
          'available'
        );
        bindNanoHostWorkerLineage(coreDb, environmentPackage, {
          attemptId: testEntityId('attempt', `lease:${environmentPackage.snapshotId}`),
          sandboxBindingRef: `lease-binding:${environmentPackage.snapshotId}`,
        });
        await anchorNanoHostMaterialization(coreDb, backend, environmentPackage);
      };
      let originalOpenCodeSandboxId: string | undefined;
      for (const [index, environmentPackage] of packages.slice(0, 3).entries()) {
        await authorizeNanoHostPackage(coreDb, environmentPackage);
        enqueue(environmentPackage);
        await dispatch(environmentPackage);
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
        await new FsStore({ dataRoot: coreDb.dataRoot }).updateAgentSession(
          environmentPackage.scope.agentSessionId,
          {
            retainedStorage: materialized.retainedStorage!,
          }
        );
        const sandboxId = backend.sessions.get(environmentPackage.snapshotId)!.sharedHarness.sandbox
          .sandboxRuntimeId;
        if (index === 0) originalOpenCodeSandboxId = sandboxId;
        if (index === 2) expect(sandboxId).toBe(originalOpenCodeSandboxId);
        await backend.bindNativeHandleRecorder?.(environmentPackage.snapshotId, () => {});
        const launch = submitTestNanoHostTurn(coreDb, backend, materialized);
        await settleNext('session.open', {
          maxActiveTurns: 20,
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
        transitionWorkerBackendSessionState(coreDb, {
          fromState: 'cleanup-pending',
          toState: 'physical-cleaned',
          attemptId: lease.leaseId,
        });
        await closeFactoryAttempt(
          coreDb,
          lease.leaseId,
          `turn:${environmentPackage.scope.turnId}:completed`,
          backend
        );
        expect(backend.sessions.has(environmentPackage.snapshotId)).toBe(false);
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
      await authorizeNanoHostPackage(coreDb, desired);
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
      expect(await backend.inspectMaterializationCapacity?.(desired)).toBe('available');
      expect(effects).toHaveLength(effectsBeforeRetry);
      await dispatch(desired);
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
  }, 60_000);

  it.each([
    null,
    'predecessor-close-required',
    'predecessor-effectful',
    'predecessor-delete-failed',
    'predecessor-restart',
    'eviction-cleanup-required',
    'eviction-delete-failed',
    'eviction-live-cleanup',
    'predecessor-fresh-same-runtime',
    'predecessor-fresh-different-runtime',
    'predecessor-fresh-delete-failed',
  ] as const)('reattaches selected storage or surfaces startup failure: %s', async (scenario) => {
    const eviction = scenario?.startsWith('eviction-') ?? false;
    const fresh = scenario?.startsWith('predecessor-fresh-') ?? false;
    const deleteFails = scenario?.endsWith('delete-failed') ?? false;
    let coreDb = createFactoryCoreDb();
    const dataRoot = coreDb.dataRoot;
    const ownerUserId = ensureLocalUser(coreDb);
    let store = await createDemoStore({ dataRoot });
    const workspaceId = DEMO_WORKSPACE_ID;
    const threadId = 'th_00000000-0000-7915-a6f9-62c39f405597';
    await store.createThread(workspaceId, 'Retained storage replacement', threadId);
    recordWorkspaceOwnerMembership({ coreDb, ownerUserId, workspaceId });
    const setupFor = (image: string, adapter: 'codex' | 'opencode' = 'codex') =>
      createTestAgentSetup({
        adapter,
        agentId: 'agent_codex_host',
        imageRef: `sha256:${image.repeat(64)}`,
        requiredCapabilities: ['trusted-worker-inference-relay'],
      });
    let setup = setupFor('1');
    const readRuntimeConfig = () =>
      createInMemoryRuntimeConfigSnapshot({
        ...loadRuntimeConfig(dataRoot),
        agentManifests: [setup.manifest],
        gatewayConfig: createTestGatewayConfig(),
        providerRegistry: new ProviderRegistry([
          {
            id: 'agent-openrouter',
            displayName: 'Storage replacement fixture',
            kind: 'local',
            models: ['openai/gpt-5.2'],
          },
        ]),
      });
    const construct = factoryOwners.createConfiguredWorkerLifecycleRuntime;
    const failedDeletes: NanoHostSessionEffectRequest[] = [];
    const retirementObservations: Array<{ actual: unknown; expected: unknown }> = [];
    const construction = vi
      .spyOn(factoryOwners, 'createConfiguredWorkerLifecycleRuntime')
      .mockImplementation((options = {}) => {
        const dispatch = options.nanoHostSessionDispatch!;
        return construct({
          ...options,
          nanoHostSessionDispatch: {
            ...dispatch,
            async effect(connection: object, carried?: NanoHostSessionEffectRequest) {
              const request = carried ?? (connection as NanoHostSessionEffectRequest);
              if (request.kind === 'bridge.close' || request.kind === 'sandbox.delete') {
                try {
                  const leaseId = testEntityId('attempt', 'lease-snapshot_idle_eviction_a');
                  const entry = entries.at(-1)!;
                  retirementObservations.push({
                    actual: {
                      input: { ...request.input },
                      drain: coreDb.sqlite
                        .prepare('SELECT drain_state FROM sandbox_runtime_records')
                        .get(),
                      capacity: await backend.inspectMaterializationCapacity?.(priorPackage!),
                      storage: getWorkerStorageBinding(coreDb, choice!),
                      attempt: attempts.listSchedulerExecutionAttemptsForTurn(coreDb, entry).at(-1),
                    },
                    expected: {
                      input: {
                        leaseId,
                        packageSnapshotId: priorPackage!.snapshotId,
                        sandboxId: outside.effects.find(
                          (effect) => effect.kind === 'sandbox.create'
                        )!.input.sandboxId,
                      },
                      drain: { drain_state: 'draining' },
                      capacity: 'capacity-saturated',
                      storage: {
                        currentSandboxBindingRef: selected!.currentSandboxBindingRef,
                        attachmentGeneration: selected!.attachmentGeneration,
                      },
                      attempt: {
                        queueEntryId: entry.queueEntryId,
                        turnId: entry.turnId,
                        phase: 'open',
                        operationId: null,
                        deadline: null,
                      },
                    },
                  });
                } catch (error) {
                  retirementObservations.push({ actual: { error }, expected: { error: null } });
                }
              }
              if (deleteFails && request.kind === 'sandbox.delete') {
                failedDeletes.push(request);
                throw new Error('Controlled delete failure.');
              }
              return carried ? dispatch.effect(connection, carried) : dispatch.effect(request);
            },
          },
        });
      });
    let native = createNativeTaskAdmissionFixture(coreDb, store, { readRuntimeConfig });
    const outside = native.outside;
    const effects = outside.effects;
    let backend = native.executor.executionBackend as WorkerGovernanceBackend;
    const continuity =
      scenario === 'predecessor-effectful'
        ? vi.spyOn(backend, 'prepareAgentSessionContinuity')
        : null;
    const acceptCommand = native.runtime.acceptNanoHostHarnessCommand.bind(native.runtime);
    let commands = vi.spyOn(native.runtime, 'acceptNanoHostHarnessCommand');
    let incomingIntent: string | undefined;
    if (continuity)
      commands.mockImplementation((command) => {
        if (command.operation === 'session.close') {
          const input = continuity.mock.calls.findLast(
            ([value]) => value.admissionAttemptId && !value.reuseAllowed
          )?.[0];
          const pkg = input?.environmentPackage;
          if (!input?.admissionAttemptId || !pkg?.runtime.environment)
            throw new Error('Incoming native preparation ownership is absent.');
          const attempt = attempts.requireSchedulerExecutionAttempt(
            coreDb,
            input.admissionAttemptId
          );
          expect(attempt).toMatchObject({
            phase: 'open',
            disposition: 'not_accepted',
            operationId: null,
            deadline: null,
            agentSessionId: pkg.scope.agentSessionId,
            inputRef: pkg.snapshotId,
            workspaceId: pkg.scope.workspaceId,
            threadId: pkg.scope.threadId,
            turnId: pkg.scope.turnId,
          });
          const request = createNanoHostEffectRequest(
            backend.planSession(pkg),
            input.admissionAttemptId,
            'image.acquire',
            { imageReference: pkg.runtime.environment.imageDigest }
          );
          incomingIntent = request.requestId!;
          // Crash-before-contact intent is unknown; no accepted result or native contact is invented.
          recordSchedulerExecutionOperation(coreDb, {
            attemptId: input.admissionAttemptId,
            operationId: incomingIntent,
          });
        }
        return acceptCommand(command);
      });
    let results = vi.spyOn(native.runtime, 'acceptNanoHostHarnessResult');
    const priorCommands: harnessRecords.NanoHostHarnessCommand[] = [];
    const priorResults: Parameters<typeof native.runtime.acceptNanoHostHarnessResult>[0][] = [];
    const release = vi.spyOn(storageOwners, 'releaseWorkerStorageAttachment');
    const reserve = vi.spyOn(storageOwners, 'reserveWorkerStorageAttachment');
    const selection = vi.spyOn(storageOwners, 'authorizeAttachedWorkerStorageReplacement');
    const collected = Promise.withResolvers<void>();
    const proceed = Promise.withResolvers<void>();
    const collect = backend.collectTranscript.bind(backend);
    const collection = vi
      .spyOn(backend, 'collectTranscript')
      .mockImplementation(async (...args) => {
        const transcript = await collect(...args);
        collected.resolve();
        await proceed.promise;
        return transcript;
      });
    const joins: Array<() => Promise<void>> = [];
    const entries: ReturnType<typeof createSchedulerAdmissionEntry>[] = [];
    const receipts: ReturnType<FsStore['getCommandRequest']>[] = [];
    const scope = { workspaceId, threadId, actorId: ownerUserId };
    let priorPackage: AgentEnvironmentPackage | undefined;
    let predecessor: ReturnType<FsStore['getAgentSession']> | undefined;
    let selected: ReturnType<typeof getWorkerStorageBinding> | undefined;
    let choice: Extract<SchedulerWorkerStorageChoice, { kind: 'selected' }> | undefined;
    try {
      for (const [index, label] of ['a', 'b'].entries()) {
        let agentSessionId = testEntityId('as', `as_idle_eviction_${label}`);
        let attemptId = testEntityId('attempt', `lease-snapshot_idle_eviction_${label}`);
        let entry = createSchedulerAdmissionEntry(coreDb, {
          backendId: 'nanohost',
          queueEntryId: `queue:idle-eviction-${label}`,
          requestId: testEntityId('tu', `request_idle_eviction_${label}`).slice(3),
          requestedAgentId: setup.manifest.id,
          workspaceId,
          threadId:
            index && eviction
              ? (await store.createThread(workspaceId, 'Eviction request')).id
              : threadId,
          turnId: testEntityId('tu', `turn_idle_eviction_${label}`),
          turnInput: `Continue retained work ${label}`,
          workerStorageChoice: choice,
          triggerActor: { kind: 'user', id: ownerUserId },
        });
        await publishFactoryAdmission(store, entry);
        entries.push(entry);
        const receipt = store.getCommandRequest('turn.start', entry.requestId, {
          ...scope,
          threadId: entry.threadId,
        });
        expect(receipt?.response).toEqual({ kind: 'turn', id: entry.turnId });
        receipts.push(receipt);
        if (index) {
          const dispatch = () =>
            runSchedulerDispatchLoop({
              coreDb,
              store,
              turnExecutor: native.executor,
              executionBackend: backend,
              ...readRuntimeConfig(),
              maxDispatches: 1,
              createAttemptId: () => attemptId,
              createAgentSessionId: () => agentSessionId,
            });
          if (scenario && !eviction) {
            native.peerFaults.closeRefusal = 'cleanup_required';
            if (scenario === 'predecessor-effectful') {
              await expect(dispatch()).rejects.toMatchObject({ code: 'recovery_required' });
              expect(incomingIntent).toMatch(/^[0-9a-f]{64}$/);
              expect(effects.some(({ requestId }) => requestId === incomingIntent)).toBe(false);
              const uncertain = attempts.requireSchedulerExecutionAttempt(coreDb, attemptId);
              expect(uncertain).toMatchObject({
                phase: 'closing',
                disposition: 'unknown',
                operationId: incomingIntent,
                deadline: null,
              });
              expect(attempts.isSchedulerExecutionBusyRefusal(uncertain)).toBe(false);
              expect(attempts.listSchedulerExecutionAttemptsForTurn(coreDb, entry)).toHaveLength(1);
              expect(store.getTurnById(entry.turnId)).toMatchObject({
                status: 'failed',
                error: { code: 'worker_preparation_failed' },
              });
              expect(store.getTurnById(entries[0]!.turnId).status).toBe('completed');
              expect(store.getAgentSession(predecessor!.id)).toMatchObject({
                status: 'idle',
                nativeHandleDigest: predecessor!.nativeHandleDigest,
                retainedStorage: predecessor!.retainedStorage,
              });
              expect(getWorkerStorageBinding(coreDb, choice!)).toEqual(selected);
              expect(
                coreDb.sqlite.prepare('SELECT drain_state FROM harness_instance_records').all()
              ).toEqual([{ drain_state: 'draining' }]);
              expect(release).not.toHaveBeenCalled();
              expect(reserve).toHaveBeenCalledTimes(1);
              const closes = commands.mock.calls
                .map(([command]) => command)
                .filter((command) => command.operation === 'session.close');
              expect(closes).toHaveLength(1);
              expect(
                results.mock.calls.find(
                  ([result]) => result.operationId === closes[0]!.operationId
                )?.[0]
              ).toMatchObject({
                disposition: 'refused',
                body: { reasonCode: 'cleanup_required' },
              });
              expect(
                commands.mock.calls
                  .filter(([command]) => command.operation === 'turn.start')
                  .map(([command]) => command.body.turnId)
              ).toEqual([entries[0]!.turnId]);
              expect(effects.filter(({ kind }) => kind === 'sandbox.create')).toHaveLength(1);
              expect(
                effects.filter(({ kind }) => kind === 'bridge.close' || kind === 'sandbox.delete')
              ).toEqual([]);
              const before = [effects.length, commands.mock.calls.length];
              expect(
                (
                  await runSchedulerDispatchLoop({
                    coreDb,
                    store,
                    turnExecutor: native.executor,
                    executionBackend: backend,
                    ...readRuntimeConfig(),
                  })
                ).startedTurns
              ).toEqual([]);
              expect([effects.length, commands.mock.calls.length]).toEqual(before);
              expect(attempts.requireSchedulerExecutionAttempt(coreDb, attemptId)).toEqual(
                uncertain
              );
              for (const [i, original] of entries.entries())
                expect(
                  store.getCommandRequest('turn.start', original.requestId, {
                    ...scope,
                    threadId: original.threadId,
                  })
                ).toEqual(receipts[i]);
              return;
            }
            expect(await dispatch()).toMatchObject({
              startedTurns: [],
              terminalResult: { status: 'queued', reason: 'backend-busy' },
            });
            const deferred = attempts.requireSchedulerExecutionAttempt(coreDb, attemptId);
            expect(attempts.isSchedulerExecutionBusyRefusal(deferred)).toBe(true);
            expect(store.getTurnById(entry.turnId).status).toBe('pending');
            expect(effects.filter((effect) => effect.kind === 'sandbox.create')).toHaveLength(1);
            expect(effects.filter((effect) => effect.kind === 'sandbox.delete')).toHaveLength(0);
            if (scenario === 'predecessor-restart') {
              for (const join of joins.splice(0)) await join();
              priorCommands.push(...commands.mock.calls.map(([command]) => command));
              priorResults.push(...results.mock.calls.map(([result]) => result));
              commands.mockRestore();
              results.mockRestore();
              collection.mockRestore();
              await native.restore();
              await shutdownControlStoreWorkerClient();
              coreDb.sqlite.close();
              coreDb = openCoreDb(dataRoot);
              store = new FsStore({ dataRoot });
              native = createNativeTaskAdmissionFixture(
                coreDb,
                store,
                { readRuntimeConfig },
                outside
              );
              backend = native.executor.executionBackend as WorkerGovernanceBackend;
              commands = vi.spyOn(native.runtime, 'acceptNanoHostHarnessCommand');
              results = vi.spyOn(native.runtime, 'acceptNanoHostHarnessResult');
              expect(attempts.requireSchedulerExecutionAttempt(coreDb, deferred.attemptId)).toEqual(
                deferred
              );
            }
            if (fresh) {
              const invoke = createOperationInvocation({
                coreDb,
                store,
                dataRoot,
                workspaceMutationAdmission: new WorkspaceMutationAdmission(),
                repositoryWorkspaceDb: (id) => openWorkspaceDb(dataRoot, id),
              });
              await expect(
                invoke(
                  'scheduler.cancel',
                  { workspaceId, queueEntryId: entry.queueEntryId },
                  {
                    kind: 'public',
                    actor: { kind: 'local', userId: ownerUserId },
                  }
                )
              ).resolves.toEqual({ cancelled: true });
              expect(store.getTurnById(entry.turnId).status).toBe('cancelled');
              const nextThread = await store.createThread(workspaceId, 'Fresh retirement request');
              setup = setupFor(
                '1',
                scenario === 'predecessor-fresh-different-runtime' ? 'opencode' : 'codex'
              );
              admitTestNativeEnvironment(coreDb, setup.manifest);
              agentSessionId = testEntityId('as', 'as_fresh_retirement');
              entry = createSchedulerAdmissionEntry(coreDb, {
                ...entry,
                queueEntryId: 'queue:fresh-retirement',
                requestId: testEntityId('tu', 'request_fresh_retirement').slice(3),
                turnId: testEntityId('tu', 'turn_fresh_retirement'),
                threadId: nextThread.id,
                workerStorageChoice: undefined,
              });
              await publishFactoryAdmission(store, entry);
              entries.push(entry);
              const receipt = store.getCommandRequest('turn.start', entry.requestId, {
                ...scope,
                threadId: entry.threadId,
              });
              expect(receipt?.response).toEqual({ kind: 'turn', id: entry.turnId });
              receipts.push(receipt);
            }
            attemptId = testEntityId('attempt', 'lease-snapshot_idle_eviction_c');
            if (scenario === 'predecessor-close-required') setup = setupFor('1');
            if (deleteFails) {
              // The consuming commit wraps the actual delete fault as a continuity refusal.
              await expect(dispatch()).rejects.toMatchObject({ code: 'recovery_required' });
              expect(failedDeletes).toHaveLength(1);
              expect(failedDeletes[0]?.kind).toBe('sandbox.delete');
              expect(getWorkerStorageBinding(coreDb, choice!)!.state).toBe('unknown');
              expect(store.getTurnById(entry.turnId)).toMatchObject({
                status: 'failed',
                error: { code: 'worker_preparation_failed' },
              });
              break;
            }
          }
          if (eviction) {
            native.peerFaults.closeRefusal =
              scenario === 'eviction-live-cleanup' ? 'conflict' : 'cleanup_required';
            if (deleteFails || scenario === 'eviction-live-cleanup') {
              if (scenario === 'eviction-live-cleanup') {
                await expect(dispatch()).rejects.toMatchObject({ code: 'recovery_required' });
                const refused = attempts.requireSchedulerExecutionAttempt(coreDb, attemptId);
                expect(refused).toMatchObject({
                  phase: 'closed',
                  disposition: 'not_accepted',
                  operationId: null,
                  deadline: null,
                });
                expect(attempts.isSchedulerExecutionBusyRefusal(refused)).toBe(false);
                expect(store.getTurnById(entry.turnId)).toMatchObject({
                  status: 'failed',
                  error: { code: 'worker_preparation_failed' },
                });
              } else {
                expect(await dispatch()).toMatchObject({
                  startedTurns: [],
                  terminalResult: { status: 'queued', reason: 'backend-busy' },
                });
                expect(
                  attempts.isSchedulerExecutionBusyRefusal(
                    attempts.requireSchedulerExecutionAttempt(coreDb, attemptId)
                  )
                ).toBe(true);
                expect(store.getTurnById(entry.turnId).status).toBe('pending');
                expect(store.getTurnById(entry.turnId).agentSessionId ?? null).toBeNull();
              }
              const retained = getWorkerStorageBinding(coreDb, choice!)!;
              expect(retained).toMatchObject({
                storageRef: selected!.storageRef,
                targets: selected!.targets,
                attachmentGeneration: selected!.attachmentGeneration,
                currentWorkSlotRef: selected!.currentWorkSlotRef,
                currentSandboxBindingRef: selected!.currentSandboxBindingRef,
                state: deleteFails ? 'unknown' : 'attached',
                revision: selected!.revision + Number(deleteFails),
              });
              expect(failedDeletes).toHaveLength(deleteFails ? 1 : 0);
              expect(
                coreDb.sqlite.prepare('SELECT cleanup_state FROM sandbox_runtime_records').get()
              ).toEqual({ cleanup_state: deleteFails ? 'unknown' : 'clean' });
              expect(release).not.toHaveBeenCalled();
              expect(reserve).toHaveBeenCalledTimes(1);
              expect(store.getAgentSession(predecessor!.id)).toMatchObject({
                status: 'idle',
                nativeHandleDigest: predecessor!.nativeHandleDigest,
                retainedStorage: predecessor!.retainedStorage,
              });
              expect(
                commands.mock.calls.filter(([command]) => command.operation === 'session.close')
              ).toHaveLength(1);
              const close = commands.mock.calls.find(
                ([command]) => command.operation === 'session.close'
              )![0];
              expect(close.body.agentSessionId).toBe(predecessor!.id);
              expect(results.mock.calls.at(-1)?.[0]).toMatchObject({
                harnessInstanceId: close.harnessInstanceId,
                operationId: close.operationId,
                sequence: close.sequence,
                disposition: 'refused',
                body: {
                  reasonCode:
                    scenario === 'eviction-live-cleanup' ? 'conflict' : 'cleanup_required',
                },
              });
              expect(
                commands.mock.calls
                  .filter(([command]) => command.operation === 'turn.start')
                  .map(([command]) => command.body.turnId)
              ).toEqual([entries[0]!.turnId]);
              const before = [effects.length, commands.mock.calls.length];
              expect(
                (
                  await runSchedulerDispatchLoop({
                    coreDb,
                    store,
                    turnExecutor: native.executor,
                    executionBackend: backend,
                    ...readRuntimeConfig(),
                  })
                ).startedTurns
              ).toEqual([]);
              expect([effects.length, commands.mock.calls.length]).toEqual(before);
              expect(getWorkerStorageBinding(coreDb, choice!)).toEqual(retained);
              expect(failedDeletes).toHaveLength(deleteFails ? 1 : 0);
              expect(effects.filter((effect) => effect.kind === 'sandbox.create')).toHaveLength(1);
              expect(effects.filter((effect) => effect.kind === 'sandbox.delete')).toHaveLength(0);
              for (const [i, original] of entries.entries())
                expect(
                  store.getCommandRequest('turn.start', original.requestId, {
                    ...scope,
                    threadId: original.threadId,
                  })
                ).toEqual(receipts[i]);
              return;
            }
          }
        }
        const admitted = await native.admitTurn(entry, {
          attemptId,
          agentSessionId,
          candidateAgentSessionId: agentSessionId,
        });
        joins.push(admitted.cleanup);
        const current = store.getAgentSession(agentSessionId);
        expect(current.nativeHandleDigest).toEqual(expect.any(String));
        if (!index) {
          priorPackage = admitted.pkg;
          predecessor = current;
          selected = getWorkerStorageBinding(coreDb, current.retainedStorage!)!;
          expect(selected).toMatchObject({
            state: 'attached',
            currentWorkSlotRef: workerStorageDefaultWorkSlotRef(workspaceId, threadId),
          });
          choice = {
            kind: 'selected',
            storageRef: selected.storageRef,
            expectedRevision: selected.revision,
            reuseWorkSlotRef: current.retainedStorage!.workSlotRef,
            purpose: 'work',
            goalId: null,
            taskId: null,
          };
          const incoming = () =>
            productOwners.startProductTurn({
              coreDb,
              store,
              snapshot: readRuntimeConfig(),
              turnExecutor: native.executor,
              providerCredentialResolver: () => null,
              workerPlacement: 'remote',
              triggerActor: entry.triggerActor,
              input: {
                workspaceId,
                threadId,
                requestId: testEntityId('tu', 'request_idle_eviction_b').slice(3),
                input: 'Continue retained work b',
                agentId: setup.manifest.id,
              },
            });
          // Protocol, Turn Semantics: reject same-Thread input before creating a second nonterminal Turn.
          const beforeBusy = effects.length;
          await expect(incoming()).rejects.toMatchObject({ code: 'thread_busy' });
          expect(effects).toHaveLength(beforeBusy);
          const completing = admitted.complete();
          await Promise.race([collected.promise, admitted.execution]);
          const beforeCollectingBusy = effects.length;
          await expect(incoming()).rejects.toMatchObject({ code: 'thread_busy' });
          expect(effects).toHaveLength(beforeCollectingBusy);
          expect(store.listThreadTurns(workspaceId, threadId).map((turn) => turn.id)).toEqual([
            entry.turnId,
          ]);
          expect(effects.filter((effect) => effect.kind === 'sandbox.delete')).toHaveLength(0);
          proceed.resolve();
          await completing;
          expect(getWorkerStorageBinding(coreDb, choice)).toEqual(selected);
          setup = setupFor('2');
          admitTestNativeEnvironment(coreDb, setup.manifest);
          const resident = store.getAgentSession(current.id);
          const before = [effects.length, commands.mock.calls.length];
          const stale = createSchedulerAdmissionEntry(coreDb, {
            ...entry,
            queueEntryId: 'queue:idle-eviction-stale',
            requestId: testEntityId('tu', 'request_idle_eviction_stale').slice(3),
            turnId: testEntityId('tu', 'turn_idle_eviction_stale'),
            workerStorageChoice: { ...choice, expectedRevision: selected.revision - 1 },
          });
          await publishFactoryAdmission(store, stale);
          const staleAttemptId = testEntityId('attempt', 'idle_eviction_stale');
          await expect(
            runSchedulerDispatchLoop({
              coreDb,
              store,
              turnExecutor: native.executor,
              executionBackend: backend,
              ...readRuntimeConfig(),
              maxDispatches: 1,
              createAttemptId: () => staleAttemptId,
              createAgentSessionId: () => testEntityId('as', 'idle_eviction_stale'),
            })
          ).rejects.toMatchObject({ code: 'recovery_required' });
          expect(selection.mock.calls.at(-1)?.[1]).toMatchObject({
            storageRef: choice.storageRef,
            expectedRevision: selected.revision - 1,
            reuseWorkSlotRef: choice.reuseWorkSlotRef,
            sandboxBindingRef: selected.currentSandboxBindingRef,
          });
          expect(selection.mock.results.at(-1)).toMatchObject({
            type: 'throw',
            value: { code: 'revision_conflict' },
          });
          expect(attempts.requireSchedulerExecutionAttempt(coreDb, staleAttemptId)).toMatchObject({
            queueEntryId: stale.queueEntryId,
            turnId: stale.turnId,
            phase: 'closed',
            operationId: null,
          });
          expect(store.getTurnById(stale.turnId)).toMatchObject({
            status: 'failed',
            error: { code: 'worker_preparation_failed' },
          });
          expect([effects.length, commands.mock.calls.length]).toEqual(before);
          expect(store.getAgentSession(current.id)).toEqual(resident);
          expect(getWorkerStorageBinding(coreDb, choice)).toEqual(selected);
        } else {
          const reattached = getWorkerStorageBinding(coreDb, current.retainedStorage!)!;
          expect(
            effects.filter((effect) => effect.kind === 'sandbox.create').at(-1)!.input.storage
          ).toMatchObject({
            storageRef: reattached.storageRef,
            attachmentGeneration: reattached.attachmentGeneration,
            targets: reattached.targets
              .filter(({ active }) => active)
              .map(({ target, volumeRef }) => ({ target, volumeRef })),
          });
          if (!fresh)
            expect(current.retainedStorage).toEqual({
              ...predecessor!.retainedStorage,
              attachmentGeneration: reattached.attachmentGeneration,
            });
          expect(store.getAgentSession(predecessor!.id).status).toBe(
            eviction || fresh ? 'idle' : 'closed'
          );
          const released = release.mock.results[0]!.value;
          expect(released).toMatchObject({
            state: 'idle',
            currentSandboxBindingRef: null,
            targets: selected!.targets,
          });
          expect(release.mock.calls[0]![1]).toMatchObject({
            storageRef: selected!.storageRef,
            expectedRevision: selected!.revision,
            attachmentGeneration: selected!.attachmentGeneration,
            sandboxBindingRef: selected!.currentSandboxBindingRef,
            cleanupProved: true,
          });
          if (fresh) {
            expect(admitted.pkg.agent.runtimeKind).toBe(
              scenario === 'predecessor-fresh-different-runtime' ? 'opencode' : 'codex'
            );
            expect(current.retainedStorage!.storageRef).not.toBe(selected!.storageRef);
            expect(current.retainedStorage!.workSlotRef).toBe(
              workerStorageDefaultWorkSlotRef(workspaceId, entry.threadId)
            );
            expect(getWorkerStorageBinding(coreDb, choice!)).toEqual(released);
            expect(reattached).toMatchObject({ state: 'attached', attachmentGeneration: 1 });
            expect(reattached.currentWorkSlotRef).toBe(current.retainedStorage!.workSlotRef);
            expect(reattached.revision).toBe(reserve.mock.results.at(-1)!.value.revision + 1);
            expect(reattached.targets.map(({ volumeRef }) => volumeRef)).not.toEqual(
              selected!.targets.map(({ volumeRef }) => volumeRef)
            );
          } else {
            expect(reserve.mock.calls.at(-1)![1]).toMatchObject({
              storageRef: selected!.storageRef,
              expectedRevision: released.revision,
              purpose: 'work',
              reuseWorkSlotRef: predecessor!.retainedStorage!.workSlotRef,
            });
            expect(reattached).toMatchObject({
              state: 'attached',
              storageRef: selected!.storageRef,
              targets: selected!.targets,
              attachmentGeneration: selected!.attachmentGeneration + 1,
              currentWorkSlotRef: predecessor!.retainedStorage!.workSlotRef,
            });
            expect(reattached.revision).toBeGreaterThan(released.revision);
          }
          expect(
            getWorkerStorageBindingForSandbox(coreDb, {
              sandboxBindingRef: selected!.currentSandboxBindingRef!,
            })
          ).toBeNull();
          expect(
            getWorkerStorageBindingForSandbox(coreDb, {
              sandboxBindingRef: reattached.currentSandboxBindingRef!,
            })
          ).toEqual(reattached);
          await admitted.complete();
        }
        expect(store.getTurnById(entry.turnId)).toMatchObject({
          status: 'completed',
          agentSessionId,
        });
        expect(attempts.requireSchedulerExecutionAttempt(coreDb, attemptId)).toMatchObject({
          phase: 'closed',
          inputRef: admitted.pkg.snapshotId,
          fenceRef: expect.any(String),
        });
        expect(native.executor.releaseResults.at(-1)).toMatchObject({
          attemptId,
          state: 'released',
          inputRef: admitted.pkg.snapshotId,
          fenceRef: expect.any(String),
        });
      }
      expect(store.getAgentSession(predecessor!.id)).toMatchObject({
        nativeHandleDigest: predecessor!.nativeHandleDigest,
        retainedStorage: predecessor!.retainedStorage,
      });
      if (fresh) {
        const last = entries.at(-1)!;
        expect(store.listThreadTurns(workspaceId, last.threadId).map((turn) => turn.id)).toEqual([
          last.turnId,
        ]);
        expect(attempts.listSchedulerExecutionAttemptsForTurn(coreDb, last)).toHaveLength(1);
      }
      const actual = [...priorCommands, ...commands.mock.calls.map(([command]) => command)];
      const opens = actual.filter((command) => command.operation === 'session.open');
      const failed = deleteFails;
      if (!failed) {
        expect(opens.map((command) => command.body.resume)).toEqual([
          null,
          eviction || fresh
            ? null
            : { locator: predecessor!.id, digest: predecessor!.nativeHandleDigest },
        ]);
      } else expect(opens).toHaveLength(1);
      const close = actual.find((command) => command.operation === 'session.close')!;
      expect(
        [...priorResults, ...results.mock.calls.map(([result]) => result)].find(
          (result) => result.operationId === close.operationId
        )
      ).toMatchObject(
        scenario
          ? { disposition: 'refused', body: { reasonCode: 'cleanup_required' } }
          : {
              disposition: 'succeeded',
              body: { state: 'closed', privateState: 'absent', childState: 'absent' },
            }
      );
      expect(actual.filter((command) => command.operation === 'session.close')).toHaveLength(1);
      if (!failed) {
        expect(actual.indexOf(close)).toBeLessThan(actual.indexOf(opens[1]!));
        expect(opens[1]!.body.agentSessionRuntimeBindingId).not.toBe(
          opens[0]!.body.agentSessionRuntimeBindingId
        );
        expect(effects.filter((effect) => effect.kind === 'sandbox.delete')).toHaveLength(1);
        const creates = effects.filter((effect) => effect.kind === 'sandbox.create');
        expect(creates).toHaveLength(2);
        expect(effects.findIndex((effect) => effect.kind === 'sandbox.delete')).toBeLessThan(
          effects.indexOf(creates[1]!)
        );
      } else expect(effects.filter((effect) => effect.kind === 'sandbox.create')).toHaveLength(1);
      const after = effects.length;
      expect(
        (
          await runSchedulerDispatchLoop({
            coreDb,
            store,
            turnExecutor: native.executor,
            executionBackend: backend,
            ...readRuntimeConfig(),
          })
        ).startedTurns
      ).toEqual([]);
      expect(effects).toHaveLength(after);
      if (failed) {
        expect(failedDeletes).toHaveLength(1);
        expect(
          coreDb.sqlite.prepare('SELECT cleanup_state FROM sandbox_runtime_records').get()
        ).toEqual({ cleanup_state: 'unknown' });
      }
      expect(priorCommands.length + commands.mock.calls.length).toBe(actual.length);
      expect(
        [...priorCommands, ...commands.mock.calls.map(([command]) => command)]
          .filter((command) => command.operation === 'turn.start')
          .map((command) => command.body.turnId)
      ).toEqual(
        entries
          .filter((_, i) => !fresh || i !== 1)
          .slice(0, failed ? 1 : 2)
          .map((entry) => entry.turnId)
      );
      for (const [index, entry] of entries.entries())
        expect(
          store.getCommandRequest('turn.start', entry.requestId, {
            ...scope,
            threadId: entry.threadId,
          })
        ).toEqual(receipts[index]);
      if (!failed)
        expect(
          store
            .listThreadAgentSessions(workspaceId, entries.at(-1)!.threadId)
            .filter((session) => isCurrentAgentSessionStatus(session.status))
            .map((session) => session.id)
        ).toEqual([opens[1]!.body.agentSessionId]);
    } finally {
      try {
        proceed.resolve();
        for (const join of joins) await join();
        collection.mockRestore();
        continuity?.mockRestore();
        release.mockRestore();
        reserve.mockRestore();
        selection.mockRestore();
        commands.mockRestore();
        results.mockRestore();
        await native.restore();
        construction.mockRestore();
        coreDb.sqlite.close();
      } finally {
        for (const { actual, expected } of retirementObservations)
          expect(actual).toMatchObject(expected);
      }
    }
  }, 60_000);

  // The runner covers real fixture setup and publication; product deadlines stay unchanged.
  it.each([
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
            requireAttemptId(packageSnapshotId: string): string;
          };
        }
      ).backend;
      backend.requireAttemptId = (packageSnapshotId) =>
        testEntityId('attempt', `lease-${packageSnapshotId}`);
      const firstPackage = completeNanoHostPackage({
        runtime: {
          image: { kind: 'reference', pullPolicy: 'never', ref: `sha256:${'1'.repeat(64)}` },
        },
        scope: {
          agentSessionId: testEntityId('as', 'as_idle_eviction_a'),
          threadId: 'th_00000000-0000-7915-a6f9-62c39f405597',
          turnId: testEntityId('tu', 'turn_idle_eviction_a'),
          workspaceId: 'ws_00000000-0000-7395-a40f-79180b090159',
        },
        extensions: {
          openkit: {
            workerStorage: {
              workSlotRef: workerStorageDefaultWorkSlotRef(
                'ws_00000000-0000-7395-a40f-79180b090159',
                'th_00000000-0000-7915-a6f9-62c39f405597'
              ),
            },
          },
        },
        snapshotId: 'snapshot_idle_eviction_a',
      });
      await authorizeNanoHostPackage(coreDb, firstPackage);
      bindNanoHostWorkerLineage(coreDb, firstPackage, {
        attemptId: testEntityId('attempt', 'lease-snapshot_idle_eviction_a'),
        sandboxBindingRef: 'lease-binding:idle-eviction-a',
      });
      const settleNext = async (
        operation: 'session.open' | 'turn.start' | 'session.inspect' | 'session.close',
        body: Readonly<Record<string, unknown>>,
        disposition: 'succeeded' | 'refused' = 'succeeded'
      ) => {
        const { command } = await waitForFactoryHarnessCommand(coreDb);
        if (!command || command.operation !== operation) {
          throw new Error(`Expected queued ${operation} Harness command.`);
        }
        await runtime.acceptNanoHostHarnessCommand(command);
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
        await runtime.acceptNanoHostHarnessResult(result);
      };

      await anchorNanoHostMaterialization(coreDb, backend, firstPackage);
      const firstMaterialization = await backend.materialize(firstPackage, {
        sandboxBindingRef: factoryPackageBinding(coreDb, firstPackage),
        workspaceRoots: [],
      });
      // Keep the real admitted fact when this direct fixture accepts ready proof.
      await new FsStore({ dataRoot: coreDb.dataRoot }).updateAgentSession(
        firstPackage.scope.agentSessionId,
        {
          retainedStorage: firstMaterialization.retainedStorage!,
        }
      );
      const launch = submitTestNanoHostTurn(coreDb, backend, firstMaterialization);

      if (startupRefused && !startupRefused.startsWith('predecessor-')) {
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
    } finally {
      coreDb.sqlite.close();
    }
  }, 60_000);

  it('honors explicit selected and fresh storage on a shared resident contributor', async () => {
    const coreDb = createFactoryCoreDb();
    const ownerUserId = ensureLocalUser(coreDb);
    const store = await createDemoStore({ dataRoot: coreDb.dataRoot });
    const workspaceId = DEMO_WORKSPACE_ID;
    const workspaceDb = openWorkspaceDb(coreDb.dataRoot, workspaceId);
    recordWorkspaceOwnerMembership({ coreDb, ownerUserId, workspaceId });
    const setup = createTestAgentSetup({
      imageRef: `sha256:${'a'.repeat(64)}`,
      requiredCapabilities: ['trusted-worker-inference-relay'],
    });
    const readRuntimeConfig = () =>
      createInMemoryRuntimeConfigSnapshot({
        ...loadRuntimeConfig(coreDb.dataRoot),
        agentManifests: [setup.manifest],
        gatewayConfig: createTestGatewayConfig(),
        providerRegistry: new ProviderRegistry([
          {
            id: 'agent-openrouter',
            displayName: 'Shared choice fixture',
            kind: 'local',
            models: ['openai/gpt-5.2'],
          },
        ]),
      });
    const native = createNativeTaskAdmissionFixture(coreDb, store, { readRuntimeConfig });
    const commands = vi.spyOn(native.runtime, 'acceptNanoHostHarnessCommand');
    const joins: Array<() => Promise<void>> = [];
    const proceed = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    const release = vi.mocked(native.executor.executionBackend!.release).getMockImplementation()!;
    let heldAttempt: string | undefined;
    const acknowledgement = vi
      .spyOn(native.executor.executionBackend!, 'release')
      .mockImplementation(async (...args) => {
        const result = await release(...args);
        if (args[0].attemptId === heldAttempt) {
          expect(result).toMatchObject({ state: 'released', fenceRef: expect.any(String) });
          released.resolve();
          await proceed.promise;
        }
        return result;
      });
    const thread = async (label: string) =>
      (await store.createThread(workspaceId, label, testEntityId('th', `shared_choice_${label}`)))
        .id;
    const entryFor = async (
      label: string,
      threadId: string,
      choice?: SchedulerWorkerStorageChoice
    ) => {
      const entry = createSchedulerAdmissionEntry(coreDb, {
        backendId: 'nanohost',
        queueEntryId: `queue:shared-choice-${label}`,
        requestId: testEntityId('tu', `request_shared_choice_${label}`).slice(3),
        requestedAgentId: setup.manifest.id,
        workspaceId,
        threadId,
        turnId: testEntityId('tu', `shared_choice_${label}`),
        turnInput: `Shared choice ${label}`,
        workerStorageChoice: choice,
        triggerActor: { kind: 'user', id: ownerUserId },
      });
      await publishFactoryAdmission(store, entry);
      return entry;
    };
    const selected = (storageRef: string, reuseWorkSlotRef?: string) => ({
      kind: 'selected' as const,
      storageRef,
      expectedRevision: getWorkerStorageBinding(coreDb, { storageRef })!.revision,
      reuseWorkSlotRef,
      purpose: 'work' as const,
      goalId: null,
      taskId: null,
    });
    const admit = async (entry: Awaited<ReturnType<typeof entryFor>>, sessionId?: string) => {
      const candidate = testEntityId('as', `shared_choice_${entry.turnId}`);
      const admitted = await native.admitTurn(entry, {
        attemptId: testEntityId('attempt', `shared_choice_${entry.turnId}`),
        agentSessionId: sessionId ?? candidate,
        candidateAgentSessionId: candidate,
      });
      joins.push(admitted.cleanup);
      return admitted;
    };
    const finish = async (
      entry: Awaited<ReturnType<typeof entryFor>>,
      admitted: Awaited<ReturnType<typeof admit>>
    ) => {
      expect((await admitted.complete()).startedTurns).toHaveLength(1);
      const session = store.getAgentSession(admitted.pkg.scope.agentSessionId);
      expect(session).toMatchObject({ status: 'idle', nativeHandleDigest: 'a'.repeat(64) });
      expect(store.getTurnById(entry.turnId)).toMatchObject({
        status: 'completed',
        agentSessionId: session.id,
      });
      const closed = attempts.requireSchedulerExecutionAttempt(coreDb, admitted.attempt.attemptId);
      expect(closed).toMatchObject({ phase: 'closed', fenceRef: expect.any(String) });
      return session;
    };
    const refuse = async (
      label: string,
      threadId: string,
      choice: SchedulerWorkerStorageChoice,
      code: string
    ) => {
      const entry = await entryFor(label, threadId, choice);
      const retained = listWorkerStorageBindings(coreDb, {
        workspaceId,
        authorizeContributor: () => true,
      });
      const sessions = store.listThreadAgentSessions(workspaceId, threadId);
      const before = [native.effects.length, commands.mock.calls.length];
      const launchesBefore = native.executor.launches;
      // Observe the existing execution before admission can reject, including before native launch.
      const observed = native.executionFor(entry.turnId).execution.then(
        () => ({ status: 'fulfilled' as const }),
        (error: unknown) => ({ status: 'rejected' as const, error })
      );
      await expect(admit(entry)).rejects.toMatchObject({ code });
      if (native.executor.launches !== launchesBefore)
        expect(await observed).toMatchObject({ status: 'rejected', error: { code } });
      // This helper already published accepted queued work; either failure stage ends that Turn.
      const refusedTurn = store.getTurnById(entry.turnId);
      expect(refusedTurn.status).toBe('failed');
      expect(refusedTurn.error).not.toBeNull();
      expect([native.effects.length, commands.mock.calls.length]).toEqual(before);
      expect(
        listWorkerStorageBindings(coreDb, { workspaceId, authorizeContributor: () => true })
      ).toEqual(retained);
      for (const session of sessions)
        if (label !== 'own_stale') expect(store.getAgentSession(session.id)).toEqual(session);
    };
    try {
      const p = await thread('p');
      const first = await entryFor('first', p);
      const predecessor = await finish(first, await admit(first));
      const original = predecessor.retainedStorage!;
      const workSlotRef = workerStorageDefaultWorkSlotRef(workspaceId, p);
      expect(original.workSlotRef).toBe(workSlotRef);
      const omitted = await entryFor('omitted', p);
      const omittedWork = await admit(omitted, predecessor.id);
      expect((await finish(omitted, omittedWork)).retainedStorage).toEqual(original);
      const peer = await thread('peer');
      const peerChoice = selected(original.storageRef, workSlotRef);
      await refuse(
        'peer_stale',
        peer,
        { ...peerChoice, expectedRevision: peerChoice.expectedRevision - 1 },
        'revision_conflict'
      );
      await refuse(
        'peer_missing',
        peer,
        { ...peerChoice, reuseWorkSlotRef: 'wsl_missing_peer_slot' },
        'authorization_denied'
      );
      const same = await entryFor('same', p, selected(original.storageRef, workSlotRef));
      await finish(same, await admit(same, predecessor.id));
      expect(native.effects.filter((e) => e.kind === 'sandbox.create')).toHaveLength(1);
      expect(native.effects.filter((e) => e.kind === 'sandbox.delete')).toHaveLength(0);
      expect(commands.mock.calls.filter(([c]) => c.operation === 'session.open')).toHaveLength(1);
      const peerEntry = await entryFor('peer', peer, selected(original.storageRef));
      const peerSession = await finish(peerEntry, await admit(peerEntry));
      const peerSlot = workerStorageDefaultWorkSlotRef(workspaceId, peer);
      expect(peerSession.retainedStorage).toEqual({
        storageRef: original.storageRef,
        workSlotRef: peerSlot,
        attachmentGeneration: getWorkerStorageBinding(coreDb, original)!.attachmentGeneration,
      });
      expect(native.effects.filter((e) => e.kind === 'sandbox.create')).toHaveLength(1);
      expect(native.effects.filter((e) => e.kind === 'sandbox.delete')).toHaveLength(0);
      // A different real resident makes an accidental warm-storage fallback observable.
      const q = await thread('q');
      const freshChoice = { kind: 'fresh' as const, goalId: null, taskId: null };
      const qEntry = await entryFor('q', q, freshChoice);
      const qWork = await admit(qEntry);
      heldAttempt = qWork.attempt.attemptId;
      const completing = finish(qEntry, qWork);
      await Promise.race([released.promise, qWork.execution]);
      expect(attempts.requireSchedulerExecutionAttempt(coreDb, heldAttempt).phase).toBe('closing');
      const qBinding = getWorkerStorageBinding(
        coreDb,
        store.getAgentSession(qWork.pkg.scope.agentSessionId).retainedStorage!
      )!;
      expect(qBinding.storageRef).not.toBe(original.storageRef);
      const idleOriginal = getWorkerStorageBinding(coreDb, original)!;
      expect(idleOriginal.state).toBe('idle');
      const r = await thread('r');
      const other = await entryFor('other', r, selected(original.storageRef, workSlotRef));
      const beforeBusy = native.effects.length;
      const busyAttempt = testEntityId('attempt', 'shared_choice_busy');
      expect(
        await runSchedulerDispatchLoop({
          coreDb,
          store,
          turnExecutor: native.executor,
          executionBackend: native.executor.executionBackend!,
          ...readRuntimeConfig(),
          maxDispatches: 1,
          createAttemptId: () => busyAttempt,
          createAgentSessionId: () => testEntityId('as', 'shared_choice_busy'),
        })
      ).toMatchObject({
        startedTurns: [],
        terminalResult: { status: 'queued', reason: 'backend-busy' },
      });
      expect(
        attempts.isSchedulerExecutionBusyRefusal(
          attempts.requireSchedulerExecutionAttempt(coreDb, busyAttempt)
        )
      ).toBe(true);
      const pending = store.getTurnById(other.turnId);
      expect(pending.status).toBe('pending');
      expect(pending.agentSessionId ?? null).toBeNull();
      expect(native.effects).toHaveLength(beforeBusy);
      expect(getWorkerStorageBinding(coreDb, original)).toEqual(idleOriginal);
      expect(getWorkerStorageBinding(coreDb, qBinding)).toEqual(qBinding);
      proceed.resolve();
      await completing;
      const otherSession = await finish(other, await admit(other));
      const replaced = getWorkerStorageBinding(coreDb, original)!;
      expect(otherSession.retainedStorage).toEqual({
        ...original,
        attachmentGeneration: replaced.attachmentGeneration,
      });
      expect(replaced).toMatchObject({
        state: 'attached',
        targets: idleOriginal.targets,
        currentWorkSlotRef: workSlotRef,
        attachmentGeneration: idleOriginal.attachmentGeneration + 1,
        revision: idleOriginal.revision + 2,
      });
      expect(getWorkerStorageBinding(coreDb, qBinding)?.state).toBe('idle');
      const sameChoice = selected(original.storageRef, workSlotRef);
      const backend = native.executor.executionBackend as WorkerGovernanceBackend;
      expect(backend.readThreadAgentSessionBinding!({ workspaceId, threadId: p })).toBeNull();
      const absentP = store.getAgentSession(predecessor.id);
      const pTurns = store.listThreadTurns(workspaceId, p);
      const pSnapshot = requireAgentEnvironmentPackageSnapshot(
        workspaceDb,
        workspaceId,
        absentP.environmentPackageSnapshotId!
      );
      const residentR = store.getAgentSession(otherSession.id);
      const bindingR = backend.readThreadAgentSessionBinding!({ workspaceId, threadId: r });
      expect(bindingR).toEqual({ agentSessionId: otherSession.id });
      await refuse(
        'own_stale',
        p,
        { ...sameChoice, expectedRevision: sameChoice.expectedRevision - 1 },
        'revision_conflict'
      );
      expect(store.getAgentSession(predecessor.id)).toEqual({
        ...absentP,
        status: 'closed',
        message: expect.any(String),
        updatedAt: expect.any(String),
      });
      expect(store.listThreadAgentSessions(workspaceId, p).map(({ id }) => id)).toEqual([
        predecessor.id,
      ]);
      expect(backend.readThreadAgentSessionBinding!({ workspaceId, threadId: p })).toBeNull();
      expect(store.getAgentSession(otherSession.id)).toEqual(residentR);
      expect(backend.readThreadAgentSessionBinding!({ workspaceId, threadId: r })).toEqual(
        bindingR
      );
      for (const turn of pTurns) expect(store.getTurnById(turn.id)).toEqual(turn);
      expect(
        requireAgentEnvironmentPackageSnapshot(workspaceDb, workspaceId, pSnapshot.snapshotId)
      ).toEqual(pSnapshot);
      await refuse(
        'own_missing',
        p,
        { ...sameChoice, reuseWorkSlotRef: 'wsl_missing_selected_slot' },
        'worker_storage_choice_conflict'
      );
      await refuse('native_fresh_conflict', p, freshChoice, 'worker_storage_choice_conflict');
      await refuse(
        'native_other_conflict',
        p,
        selected(qBinding.storageRef),
        'worker_storage_choice_conflict'
      );
      await refuse(
        'native_slot_conflict',
        p,
        selected(original.storageRef, peerSlot),
        'worker_storage_choice_conflict'
      );
      const invalidOther = await thread('other-invalid');
      const otherChoice = selected(qBinding.storageRef, qBinding.currentWorkSlotRef!);
      await refuse(
        'other_stale',
        invalidOther,
        { ...otherChoice, expectedRevision: otherChoice.expectedRevision - 1 },
        'revision_conflict'
      );
      await refuse(
        'other_missing',
        invalidOther,
        { ...otherChoice, reuseWorkSlotRef: 'wsl_missing_other_slot' },
        'authorization_denied'
      );
      const h = await thread('handoff');
      const handoff = await entryFor('handoff', h, selected(original.storageRef, peerSlot));
      const beforeHandoff = native.effects.length;
      const handoffWork = await admit(handoff);
      expect((await finish(handoff, handoffWork)).retainedStorage).toEqual({
        storageRef: original.storageRef,
        workSlotRef: peerSlot,
        attachmentGeneration: replaced.attachmentGeneration + 1,
      });
      expect(getWorkerStorageBinding(coreDb, original)).toMatchObject({
        state: 'attached',
        targets: replaced.targets,
        currentWorkSlotRef: peerSlot,
        attachmentGeneration: replaced.attachmentGeneration + 1,
      });
      expect(
        native.effects
          .slice(beforeHandoff)
          .map((e) => e.kind)
          .filter((kind) =>
            ['sandbox.delete', 'image.acquire', 'image.inspect', 'sandbox.create'].includes(kind)
          )
      ).toEqual(['sandbox.delete', 'image.acquire', 'image.inspect', 'sandbox.create']);
      const c = await thread('fresh');
      const fresh = await entryFor('fresh', c, freshChoice);
      const freshSession = await finish(fresh, await admit(fresh));
      expect([original.storageRef, qBinding.storageRef]).not.toContain(
        freshSession.retainedStorage!.storageRef
      );
      expect(freshSession.retainedStorage!.workSlotRef).toBe(
        workerStorageDefaultWorkSlotRef(workspaceId, c)
      );
      expect(getWorkerStorageBinding(coreDb, original)?.state).toBe('idle');
      for (const [command] of commands.mock.calls.filter(([c]) => c.operation === 'session.open')) {
        expect(command.body).toMatchObject({ resume: null });
        expect(command.body).not.toHaveProperty('storageRef');
        expect(command.body).not.toHaveProperty('workSlotRef');
      }
    } finally {
      proceed.resolve();
      for (const join of joins) await join();
      acknowledgement.mockRestore();
      commands.mockRestore();
      await native.restore();
      await shutdownControlStoreWorkerClient();
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  // Real resident setup shares gate CPU; the assertions still check fencing and no replay.
  // biome-ignore format: Preserve the unchanged lifecycle matrix body while exposing its case signal.
  it.for([
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
  ] as const)('handles $label resident admission without replaying old Harness work', { timeout: 60_000 }, async ({
    label,
    origin,
    dirty,
    operation,
  }, { signal }) => {
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
        agentSessionId: testEntityId('as', 'as_capacity_guard_resident'),
        agentSessionRuntimeBindingId: 'binding-capacity-guard',
        effectiveSetupGeneration: 1,
        harnessInstanceId: 'harness-capacity-guard',
        threadId: 'th_00000000-0000-7e51-97fc-1eab919d6dc2',
        timestamp: '2026-10-02T07:57:21.621Z',
        workspaceId: 'ws_00000000-0000-7ba9-891a-e2ba53e69f41',
      });
      if (operation === 'unknown') {
        openNanoHostAgentSessionBinding(coreDb, {
          agentSessionCompatibilityKey: 'd'.repeat(64),
          agentSessionId: testEntityId('as', 'as_round33_compatible_sibling'),
          agentSessionRuntimeBindingId: 'binding-round33-compatible-sibling',
          effectiveSetupGeneration: 1,
          harnessInstanceId: 'harness-capacity-guard',
          threadId: 'th_00000000-0000-7478-98d3-d3efdca62b71',
          timestamp: '2026-10-02T07:57:21.621Z',
          workspaceId: 'ws_00000000-0000-7ba9-891a-e2ba53e69f41',
        });
      }
      coreDb.sqlite.exec("UPDATE agent_session_runtime_bindings SET lifecycle_state = 'open'");
      coreDb.sqlite.exec('UPDATE harness_instance_records SET next_sequence = 3');
      queueNanoHostHarnessOperation(coreDb, {
        body: {
          agentSessionId: testEntityId('as', 'as_capacity_guard_resident'),
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
        agentSessionId: testEntityId('as', 'as_capacity_guard_resident'),
        deploymentId: 'deployment_capacity_guard',
        runtimeTargetId: 'target_capacity_guard',
        sandboxBindingRef: 'sandbox-binding-capacity-guard',
        threadId: 'th_00000000-0000-7e51-97fc-1eab919d6dc2',
        workspaceId: 'ws_00000000-0000-7ba9-891a-e2ba53e69f41',
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
            typeof request.input.relativePath === 'string' &&
              request.input.relativePath.endsWith('/events.jsonl') &&
              transcriptEvent
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
          agentSessionId: testEntityId('as', 'as_capacity_guard_resident'),
          threadId: 'th_00000000-0000-7e51-97fc-1eab919d6dc2',
          turnId: testEntityId('tu', 'turn_capacity_guard_resident'),
          workspaceId: 'ws_00000000-0000-7ba9-891a-e2ba53e69f41',
        },
        snapshotId: 'snapshot_capacity_guard_resident',
      });
      await authorizeNanoHostPackage(coreDb, residentPackage);
      await anchorNanoHostMaterialization(coreDb, backend, residentPackage);
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
        WHERE agent_session_id = '${testEntityId('as', 'as_capacity_guard_resident')}'`)
        .run();
      coreDb.sqlite
        .prepare(`UPDATE worker_backend_sessions
        SET sandbox_binding_ref = 'sandbox-binding-capacity-guard', state = 'cleaned',
          workspace_handoff_state = 'complete', physical_cleaned_at = '2026-10-02T08:01:37.559Z',
          origin_physical_epoch = ? WHERE agent_session_id = '${testEntityId('as', 'as_capacity_guard_resident')}'`)
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
        (attempt) => attempt.agent_session_id === testEntityId('as', 'as_capacity_guard_resident')
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
          `SELECT * FROM worker_backend_sessions WHERE agent_session_id = '${testEntityId('as', 'as_capacity_guard_resident')}'`
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
          providerCredentialResolver: (secretRef) =>
            secretRef === 'env:OPENKIT_PI_ADMISSION_FIXTURE_KEY' ? 'pi-fixture-value' : null,
          providerRegistry: new ProviderRegistry([
            {
              id: 'agent-openrouter',
              displayName: 'Pi fixture',
              kind: 'llm-gateway',
              models: ['openai/gpt-5.2'],
              secretRef: 'env:OPENKIT_PI_ADMISSION_FIXTURE_KEY',
            },
          ]),
          gatewayConfig: createTestGatewayConfig(),
        });
        // Use a distinct Thread under the same currently authorized Workspace.
        await store.createThread(
          residentPackage.scope.workspaceId,
          'Independent Pi',
          'th_00000000-0000-75c1-9965-6a5e0ce7021b'
        );
        recordWorkspaceOwnerMembership({
          coreDb,
          workspaceId: residentPackage.scope.workspaceId,
          ownerUserId:
            residentPackage.scope.triggerActor.kind === 'user'
              ? residentPackage.scope.triggerActor.id
              : residentPackage.scope.triggerActor.responsibleUserId!,
        });
        insertFactoryUser(coreDb, 'usr_00000000-0000-7000-8000-000000000001');
        coreDb.sqlite
          .prepare(
            "INSERT OR IGNORE INTO workspace_members (workspace_id,user_id,status,revision,joined_at,created_at,updated_at) VALUES (?, 'usr_00000000-0000-7000-8000-000000000001','active',1,?,?,?)"
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
                  threadId: 'th_00000000-0000-75c1-9965-6a5e0ce7021b',
                  agentId: setup.manifest.id,
                  input: 'Independent Pi work.',
                  requestId: '00000000-0000-4000-8000-00000000a234',
                }),
              }
            )
          );
        const receipt = await post();
        expect(receipt.status, `${label}: ${await receipt.clone().text()}`).toBe(202);
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
            kind: 'llm-gateway',
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
            reconcileExecutions: () => runtime.executionReconciler.runOnce(),
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
        signal.throwIfAborted();
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
        // Serve the outside worker until the original dispatch and full closeout settle.
        while (!finished && !signal.aborted) {
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
            expect(exact.body.agentSessionId).not.toBe(
              testEntityId('as', 'as_capacity_guard_resident')
            );
            expect(exact.operationId).not.toBe((oldClose as { operation_id: string }).operation_id);
            const wire = await runtime.acceptNanoHostHarnessCommand(exact);
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
              const workspaceDb = openWorkspaceDb(
                coreDb.dataRoot,
                workspaceIdForOwner(accepted.owner)
              );
              try {
                const produced = requireAgentEnvironmentPackageSnapshot(
                  workspaceDb,
                  workspaceIdForOwner(accepted.owner),
                  packageSnapshotId
                ).snapshot;
                expect(produced.scope).toMatchObject({
                  turnId: accepted.id,
                  threadId: 'th_00000000-0000-75c1-9965-6a5e0ce7021b',
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
                        maxActiveTurns: 20,
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
            await runtime.acceptNanoHostHarnessResult(result);
          }
          if (!finished) await new Promise<void>((resolve) => setTimeout(resolve, 1));
        }
        signal.throwIfAborted();
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
          agentSessionId: testEntityId('as', 'as_capacity_guard_desired'),
          threadId: 'th_00000000-0000-7cc2-ae24-9531d997b506',
          turnId: testEntityId('tu', 'turn_capacity_guard_desired'),
          workspaceId: 'ws_00000000-0000-78c9-9512-ae197f839de0',
        },
        snapshotId: 'snapshot_capacity_guard_desired',
      });
      await authorizeNanoHostPackage(coreDb, desiredPackage);
      if (origin === 'a'.repeat(64)) {
        expect(await backend.inspectMaterializationCapacity?.(desiredPackage)).toBe(
          'capacity-saturated'
        );
        await anchorNanoHostMaterialization(coreDb, backend, desiredPackage);
        await expect(
          backend.materialize(desiredPackage, {
            sandboxBindingRef: factoryPackageBinding(coreDb, desiredPackage),
            workspaceRoots: [],
          })
        ).rejects.toMatchObject({
          name: 'WorkerGovernanceCapacityUnavailableError',
          message: expect.stringContaining('capacity is occupied or unproved'),
        });
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
        `UPDATE scheduler_execution_attempts SET phase = 'open' WHERE agent_session_id = '${testEntityId('as', 'as_capacity_guard_resident')}'`
      );
      expect(await backend.inspectMaterializationCapacity?.(desiredPackage)).toBe(
        'capacity-saturated'
      );
      coreDb.sqlite.exec(
        `UPDATE scheduler_execution_attempts SET phase = 'closed' WHERE agent_session_id = '${testEntityId('as', 'as_capacity_guard_resident')}'`
      );
      for (const field of ['current_turn_id', 'current_attempt_id']) {
        coreDb.sqlite.exec(
          `UPDATE agent_session_runtime_bindings SET ${field} = 'unsettled-owner'`
        );
        expect(await backend.inspectMaterializationCapacity?.(desiredPackage)).toBe(
          'capacity-saturated'
        );
        coreDb.sqlite.exec(`UPDATE agent_session_runtime_bindings SET ${field} = NULL`);
      }
      expect(await backend.inspectMaterializationCapacity?.(desiredPackage)).toBe('available');
      expect(effects).toEqual([]);
      expect(
        coreDb.sqlite.prepare('SELECT operation_state FROM harness_instance_records').all()
      ).toEqual([{ operation_state: operation }]);
      await anchorNanoHostMaterialization(coreDb, backend, desiredPackage);
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
          (attempt) => attempt.agent_session_id === testEntityId('as', 'as_capacity_guard_resident')
        )
      ).toEqual(oldAttempt);
      expect(
        coreDb.sqlite
          .prepare(
            `SELECT * FROM worker_backend_sessions WHERE agent_session_id = '${testEntityId('as', 'as_capacity_guard_resident')}'`
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
        agentSessionId: testEntityId('as', 'as_capacity_guard_resident'),
        agentSessionRuntimeBindingId: 'binding-capacity-guard',
        effectiveSetupGeneration: 1,
        harnessInstanceId: 'harness-capacity-guard',
        threadId: 'th_00000000-0000-7e51-97fc-1eab919d6dc2',
        timestamp: '2026-09-06T00:00:00.000Z',
        workspaceId: 'ws_00000000-0000-7ba9-891a-e2ba53e69f41',
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
          agentSessionId: testEntityId('as', 'as_capacity_guard_desired'),
          threadId: 'th_00000000-0000-7cc2-ae24-9531d997b506',
          turnId: testEntityId('tu', 'turn_capacity_guard_desired'),
          workspaceId: 'ws_00000000-0000-78c9-9512-ae197f839de0',
        },
        snapshotId: 'snapshot_capacity_guard_desired',
      });

      const retainedStorage = withStorage
        ? attachNanoHostStorageFixture(coreDb, {
            agentSessionId: testEntityId('as', 'as_capacity_guard_resident'),
            deploymentId: 'deployment_capacity_guard',
            runtimeTargetId: 'target_capacity_guard',
            sandboxBindingRef: 'sandbox-binding-capacity-guard',
            threadId: 'th_00000000-0000-7e51-97fc-1eab919d6dc2',
            workspaceId: 'ws_00000000-0000-7ba9-891a-e2ba53e69f41',
          })
        : null;
      for (const readinessField of ['ready', 'fresh_empty', 'predecessor_fenced']) {
        coreDb.sqlite.exec(`UPDATE nanohost_runtime_targets SET ${readinessField} = 0`);
        expect(await backend.inspectMaterializationCapacity?.(desiredPackage)).toBe(
          'capacity-saturated'
        );
        coreDb.sqlite.exec(`UPDATE nanohost_runtime_targets SET ${readinessField} = 1`);
      }
      coreDb.sqlite
        .prepare('UPDATE sandbox_runtime_records SET origin_physical_epoch = ?')
        .run('a'.repeat(64));
      expect(await backend.inspectMaterializationCapacity?.(desiredPackage)).toBe(
        'capacity-saturated'
      );
      coreDb.sqlite
        .prepare('UPDATE sandbox_runtime_records SET origin_physical_epoch = ?')
        .run(originPhysicalEpoch);
      if (withHarness) {
        // Fresh Epoch absence also retires stale binding lifecycle projections.
        expect(await backend.inspectMaterializationCapacity?.(desiredPackage)).toBe('available');
        coreDb.sqlite.exec("UPDATE agent_session_runtime_bindings SET lifecycle_state = 'open'");
        coreDb.sqlite.exec('UPDATE harness_instance_records SET active_turn_count = 1');
        expect(await backend.inspectMaterializationCapacity?.(desiredPackage)).toBe(
          'capacity-saturated'
        );
        coreDb.sqlite.exec('UPDATE harness_instance_records SET active_turn_count = 0');
        coreDb.sqlite.exec(
          `UPDATE agent_session_runtime_bindings SET current_attempt_id = '${testEntityId('attempt', 'lease_busy')}'`
        );
        expect(await backend.inspectMaterializationCapacity?.(desiredPackage)).toBe(
          'capacity-saturated'
        );
        coreDb.sqlite.exec('UPDATE agent_session_runtime_bindings SET current_attempt_id = NULL');
        if (operationState === 'unknown') {
          for (const blockedState of ['queued', 'dispatched'] as const) {
            coreDb.sqlite.exec(
              `UPDATE harness_instance_records SET operation_state = '${blockedState}'`
            );
            expect(await backend.inspectMaterializationCapacity?.(desiredPackage)).toBe(
              'available'
            );
          }
          coreDb.sqlite.exec("UPDATE harness_instance_records SET operation_state = 'unknown'");
        }
      }
      await authorizeNanoHostPackage(coreDb, desiredPackage);
      expect(await backend.inspectMaterializationCapacity?.(desiredPackage)).toBe('available');
      expect(effects).toEqual([]);
      expect(
        coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM sandbox_runtime_records').get()
      ).toEqual({ count: 1 });
      await anchorNanoHostMaterialization(coreDb, backend, desiredPackage);
      const lease = coreDb.sqlite
        .prepare(
          'SELECT attempt_id AS leaseId, binding_ref AS bindingRef FROM scheduler_execution_attempts'
        )
        .get() as { leaseId: string; bindingRef: string };
      coreDb.sqlite
        .prepare('UPDATE scheduler_execution_attempts SET binding_ref = ? WHERE attempt_id = ?')
        .run('sandbox-binding-capacity-guard', lease.leaseId);
      expect(await backend.inspectMaterializationCapacity?.(desiredPackage)).toBe(
        'capacity-saturated'
      );
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
        agentSessionId: testEntityId('as', 'as_capacity_guard_resident'),
        agentSessionRuntimeBindingId: 'binding-capacity-guard',
        effectiveSetupGeneration: 1,
        harnessInstanceId: 'harness-capacity-guard',
        threadId: 'th_00000000-0000-7e51-97fc-1eab919d6dc2',
        timestamp: '2026-09-06T00:00:00.000Z',
        workspaceId: 'ws_00000000-0000-7ba9-891a-e2ba53e69f41',
      });
      if (residentState === 'busy') {
        coreDb.sqlite
          .prepare(
            `UPDATE agent_session_runtime_bindings
               SET lifecycle_state = 'active', current_turn_id = 'tu_00000000-0000-7c04-875c-717df339cee2',
                   current_attempt_id = '${testEntityId('attempt', 'lease_busy')}'
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
          agentSessionId: testEntityId('as', 'as_capacity_guard_desired'),
          threadId: 'th_00000000-0000-7cc2-ae24-9531d997b506',
          turnId: testEntityId('tu', 'turn_capacity_guard_desired'),
          workspaceId: 'ws_00000000-0000-78c9-9512-ae197f839de0',
        },
        snapshotId: 'snapshot_capacity_guard_desired',
      });

      expect(await backend.inspectMaterializationCapacity?.(desiredPackage)).toBe(
        'capacity-saturated'
      );
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
            workspaceId: 'ws_00000000-0000-7050-bc9a-ee2fefbe2fe1',
          },
          snapshotId,
        });
      const firstPackage = packageFor(
        testEntityId('as', 'as_restart_unproved_old'),
        'th_00000000-0000-7752-b888-31811df1ac3f',
        testEntityId('tu', 'turn_restart_unproved_old'),
        'snapshot_restart_unproved_old'
      );
      await authorizeNanoHostPackage(coreDb, firstPackage);
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
      firstBackend.requireAttemptId = (snapshotId) =>
        testEntityId('attempt', `lease-${snapshotId}`);
      await anchorNanoHostMaterialization(coreDb, firstBackend, firstPackage);
      const firstMaterialization = await firstBackend.materialize(firstPackage, {
        sandboxBindingRef: factoryPackageBinding(coreDb, firstPackage),
        workspaceRoots: [],
      });
      await new FsStore({ dataRoot: coreDb.dataRoot }).updateAgentSession(
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
        testEntityId('as', 'as_restart_unproved_other_harness'),
        'th_00000000-0000-7faa-b25f-dc7565a66f04',
        testEntityId('tu', 'turn_restart_unproved_other_harness'),
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
      await closeFactoryAttempt(
        coreDb,
        testEntityId('attempt', `lease-${firstPackage.snapshotId}`)
      );

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
      recoveringBackend.restoreSession(
        firstPackage,
        testEntityId('attempt', `lease-${firstPackage.snapshotId}`)
      );
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
        testEntityId('as', 'as_restart_unproved_fresh'),
        unprovedPackage.scope.threadId,
        testEntityId('tu', 'turn_restart_unproved_fresh'),
        'snapshot_restart_unproved_fresh'
      );
      await authorizeNanoHostPackage(coreDb, secondPackage);
      const retainedStorageBeforeCorruption = getWorkerStorageBindingForSandbox(coreDb, {
        sandboxBindingRef: harness.sandboxBindingRef,
      });
      coreDb.sqlite
        .prepare("UPDATE sandbox_runtime_records SET origin_physical_epoch = 'malformed'")
        .run();
      await expect(
        restartedBackend.inspectMaterializationCapacity?.(secondPackage)
      ).rejects.toThrow(/physical Epoch/i);
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
      expect(await restartedBackend.inspectMaterializationCapacity?.(secondPackage)).toBe(
        'available'
      );
      coreDb.sqlite
        .prepare(
          `UPDATE agent_session_runtime_bindings
           SET lifecycle_state = 'active', current_turn_id = 'tu_00000000-0000-7e5b-8098-dc806c691ee4',
               current_attempt_id = '${testEntityId('attempt', 'lease_restart_busy')}'`
        )
        .run();
      coreDb.sqlite.prepare('UPDATE harness_instance_records SET active_turn_count = 1').run();
      expect(await restartedBackend.inspectMaterializationCapacity?.(secondPackage)).toBe(
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
      expect(await restartedBackend.inspectMaterializationCapacity?.(secondPackage)).toBe(
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
        attemptId: testEntityId('attempt', 'lease-restart-unproved-fresh'),
        sandboxBindingRef: 'lease-binding:restart-unproved',
      });
      await expect(
        recoveringBackend.prepareAgentSessionContinuity?.({
          admissionAgentSessionId: secondPackage.scope.agentSessionId,
          admissionAttemptId: testEntityId('attempt', 'lease-restart-unproved-fresh'),
          agentSessionCompatibilityKey: unprovedSessionCompatibilityKey,
          agentSessionId: unprovedPackage.scope.agentSessionId,
          environmentPackage: secondPackage,
          reuseAllowed: false,
          threadId: unprovedPackage.scope.threadId,
          workspaceId: unprovedPackage.scope.workspaceId,
        })
      ).rejects.toMatchObject({
        name: 'WorkerGovernanceCapacityUnavailableError',
        message: 'NanoHost one-Sandbox capacity is occupied or unproved.',
      });
      await expect(
        restartedBackend.prepareAgentSessionContinuity?.({
          admissionAgentSessionId: secondPackage.scope.agentSessionId,
          admissionAttemptId: testEntityId('attempt', 'lease-restart-unproved-fresh'),
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
      await anchorNanoHostMaterialization(coreDb, restartedBackend, secondPackage);
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

  // A failed Turn retains its valid idle Session; accepted native proof survives Core restart.
  it.each([
    { failedTurn: false, concurrentRevisionAdvance: false, missingStorage: false },
    { failedTurn: false, concurrentRevisionAdvance: true, missingStorage: false },
    { failedTurn: true, concurrentRevisionAdvance: false, missingStorage: false },
    { failedTurn: false, concurrentRevisionAdvance: false, missingStorage: true },
    { failedTurn: true, concurrentRevisionAdvance: false, missingStorage: true },
  ])('preserves exact storage authority through native restart: failedTurn=$failedTurn concurrent=$concurrentRevisionAdvance missingStorage=$missingStorage', async ({
    concurrentRevisionAdvance,
    missingStorage,
    failedTurn,
  }) => {
    let coreDb = createFactoryCoreDb();
    const dataRoot = coreDb.dataRoot;
    let native: ReturnType<typeof createNativeTaskAdmissionFixture> | undefined;
    const joins: Array<() => Promise<void>> = [];
    let restoreRelease: (() => void) | undefined;
    let restoreOpenObservation: (() => void) | undefined;
    try {
      const scopePackage = completeNanoHostPackage({
        scope: {
          agentSessionId: testEntityId('as', 'as_restart_selected_idle'),
          threadId: 'th_00000000-0000-70b7-8999-770fc3deeb0f',
          triggerActor: { kind: 'user', id: 'usr_00000000-0000-7696-8ea8-dab52c9a8217' },
          turnId: testEntityId('tu', 'turn_restart_selected_previous'),
          workspaceId: 'ws_00000000-0000-7666-b81a-a9189af9b625',
        },
        snapshotId: 'snapshot_restart_selected_previous',
      });
      await authorizeNanoHostPackage(coreDb, scopePackage);
      let store = new FsStore({ dataRoot });
      let setup = createTestAgentSetup({
        imageRef: `sha256:${'4'.repeat(64)}`,
        requiredCapabilities: ['trusted-worker-inference-relay'],
      });
      const readRuntimeConfig = () =>
        createInMemoryRuntimeConfigSnapshot({
          ...loadRuntimeConfig(dataRoot),
          agentManifests: [setup.manifest],
          gatewayConfig: createTestGatewayConfig(),
          providerRegistry: new ProviderRegistry([
            {
              id: 'agent-openrouter',
              displayName: 'Restart-selected fixture provider',
              kind: 'local',
              models: ['openai/gpt-5.2'],
            },
          ]),
        });
      native = createNativeTaskAdmissionFixture(coreDb, store, { readRuntimeConfig });
      const outside = native.outside;
      const preOpen: Readonly<{
        retainedStorage?: unknown;
        generation?: number;
        readFailed?: boolean;
      }>[] = [];
      const acceptOpen = native.runtime.acceptNanoHostHarnessCommand;
      const openObservation = vi
        .spyOn(native.runtime, 'acceptNanoHostHarnessCommand')
        .mockImplementation(async (request) => {
          const command = await acceptOpen(request);
          if (command.operation === 'session.open') {
            try {
              const session = store.getAgentSession(String(command.body.agentSessionId));
              const attachment = session.retainedStorage
                ? getWorkerStorageBinding(coreDb, session.retainedStorage)
                : null;
              preOpen.push(
                Object.freeze({
                  retainedStorage: session.retainedStorage
                    ? Object.freeze({ ...session.retainedStorage })
                    : session.retainedStorage,
                  generation: attachment?.attachmentGeneration,
                })
              );
            } catch {
              preOpen.push(Object.freeze({ readFailed: true }));
            }
          }
          return command;
        });
      restoreOpenObservation = () => openObservation.mockRestore();
      native.peerFaults.failedFinal = failedTurn;
      const previous = createSchedulerAdmissionEntry(coreDb, {
        backendId: 'nanohost',
        queueEntryId: 'queue_restart_selected_previous',
        requestId: '00000000-0000-4000-8000-00000000e500',
        requestedAgentId: setup.manifest.id,
        threadId: scopePackage.scope.threadId,
        turnId: scopePackage.scope.turnId,
        turnInput: 'Establish retained native work before restart.',
        triggerActor: scopePackage.scope.triggerActor,
        workspaceId: scopePackage.scope.workspaceId,
      });
      await publishFactoryAdmission(store, previous);
      const original = await native.admitTurn(previous, {
        attemptId: testEntityId('attempt', 'attempt_restart_selected_previous'),
        agentSessionId: scopePackage.scope.agentSessionId,
        candidateAgentSessionId: scopePackage.scope.agentSessionId,
      });
      joins.push(original.cleanup);
      await original.complete();
      await joins.pop()!();
      // Continuity Decision: observe pre-open facts without throwing into native dispatch.
      expect(preOpen.length).toBeGreaterThan(0);
      for (const fact of preOpen) {
        expect(fact.readFailed).not.toBe(true);
        expect(fact.generation).toBeGreaterThan(0);
        expect(fact.retainedStorage).toMatchObject({ attachmentGeneration: fact.generation });
      }
      const predecessor = store.getAgentSession(scopePackage.scope.agentSessionId);
      expect(predecessor).toMatchObject({ status: 'idle', nativeHandleDigest: expect.any(String) });
      const previousTurn = store.getTurnById(previous.turnId);
      expect(previousTurn).toMatchObject({
        status: failedTurn ? 'failed' : 'completed',
        agentSessionId: predecessor.id,
      });
      const closed = attempts.requireSchedulerExecutionAttempt(coreDb, original.attempt.attemptId);
      expect(closed).toMatchObject({ phase: 'closed', fenceRef: expect.any(String) });
      expect(native.executor.releaseResults).toContainEqual(
        expect.objectContaining({
          attemptId: closed.attemptId,
          state: 'released',
          fenceRef: closed.fenceRef,
        })
      );
      if (!predecessor.retainedStorage) throw new Error('Native predecessor storage is absent.');
      const retained = getWorkerStorageBinding(coreDb, predecessor.retainedStorage)!;
      expect(retained).toMatchObject({
        state: 'attached',
        attachmentGeneration: expect.any(Number),
      });
      expect(
        await Promise.all(
          openObservation.mock.results.flatMap((result) =>
            result.type === 'return' ? [result.value] : []
          )
        )
      ).toContainEqual(expect.objectContaining({ operation: 'session.open' }));
      restoreOpenObservation();
      restoreOpenObservation = undefined;
      await native.restore();
      native = undefined;
      await shutdownControlStoreWorkerClient();
      if (missingStorage) {
        // Deliberate stopped-owner fault: preserve the accepted pair and historical attachment.
        coreDb.sqlite
          .prepare('DELETE FROM worker_storage_contributors WHERE storage_ref = ?')
          .run(retained.storageRef);
        coreDb.sqlite
          .prepare('DELETE FROM worker_storage_bindings WHERE storage_ref = ?')
          .run(retained.storageRef);
      }
      coreDb.sqlite.close();
      coreDb = openCoreDb(dataRoot);
      store = new FsStore({ dataRoot });
      // Continuity Decision: reopen preserves the original attachment fact.
      expect(store.getAgentSession(predecessor.id).retainedStorage).toEqual({
        ...predecessor.retainedStorage,
        attachmentGeneration: retained.attachmentGeneration,
      });
      const changedAttachment = {
        ...predecessor.retainedStorage,
        attachmentGeneration: retained.attachmentGeneration + 1,
      };
      await expect(
        store.updateAgentSession(predecessor.id, { retainedStorage: changedAttachment })
      ).rejects.toBeInstanceOf(Error);
      expect(store.getAgentSession(predecessor.id)).toEqual(predecessor);
      // A real environment change requires replacement; it does not erase the predecessor proof.
      setup = createTestAgentSetup({
        imageRef: `sha256:${'5'.repeat(64)}`,
        requiredCapabilities: ['trusted-worker-inference-relay'],
      });
      admitTestNativeEnvironment(coreDb, setup.manifest);
      let earned: ReturnType<typeof getWorkerStorageBinding> | undefined;
      let competing: ReturnType<typeof getWorkerStorageBinding> | undefined;
      const releaseOwner = storageOwners.releaseWorkerStorageAttachment;
      const release = vi
        .spyOn(storageOwners, 'releaseWorkerStorageAttachment')
        .mockImplementation((db, input) => {
          const result = releaseOwner(db, input);
          if (result.storageRef === retained.storageRef) {
            earned = result;
            if (concurrentRevisionAdvance) {
              competing = reserveWorkerStorageAttachment(db, {
                agentSessionId: testEntityId('as', 'as_restart_selected_competing'),
                authorizeContributor: () => true,
                expectedRevision: result.revision,
                layout: result.layout,
                purpose: 'work',
                responsibleUserId: 'usr_00000000-0000-7696-8ea8-dab52c9a8217',
                runtimeTargetId: result.runtimeTargetId,
                storageRef: result.storageRef,
                threadId: scopePackage.scope.threadId,
                workspaceId: scopePackage.scope.workspaceId,
              });
            }
          }
          return result;
        });
      restoreRelease = () => release.mockRestore();
      native = createNativeTaskAdmissionFixture(coreDb, store, { readRuntimeConfig }, outside);
      native.peerFaults.failedFinal = false;
      const beforeEffects = outside.effects.length;
      const successor = createSchedulerAdmissionEntry(coreDb, {
        ...previous,
        queueEntryId: 'queue_restart_selected',
        requestId: '00000000-0000-4000-8000-00000000e501',
        turnId: testEntityId('tu', 'turn_restart_selected_next'),
        turnInput: 'Continue from the exact retained native attachment.',
        workerStorageChoice: {
          kind: 'selected',
          expectedRevision: retained.revision,
          storageRef: retained.storageRef,
          reuseWorkSlotRef: predecessor.retainedStorage.workSlotRef,
          purpose: 'work',
          goalId: null,
          taskId: null,
        },
      });
      await publishFactoryAdmission(store, successor);
      const incoming = native.admitTurn(successor, {
        attemptId: testEntityId('attempt', 'lease_restart_selected_next'),
        agentSessionId: testEntityId('as', 'as_restart_selected_next'),
        candidateAgentSessionId: testEntityId('as', 'as_restart_selected_next'),
      });
      if (missingStorage) {
        await expect(incoming).rejects.toMatchObject({ code: 'recovery_required' });
      } else if (concurrentRevisionAdvance) {
        // Exact earned and competing records below establish the revision refusal boundary.
        await expect(incoming).rejects.toBeInstanceOf(Error);
      } else {
        const admitted = await incoming;
        joins.push(admitted.cleanup);
        await admitted.complete();
        await joins.pop()!();
      }
      const effects = outside.effects.slice(beforeEffects);
      const creates = effects.filter((effect) => effect.kind === 'sandbox.create');
      if (missingStorage) {
        expect(effects).toEqual([]);
        expect(release).not.toHaveBeenCalled();
        expect(getWorkerStorageBinding(coreDb, retained)).toBeNull();
        expect(
          listWorkerStorageBindings(coreDb, {
            authorizeContributor: () => true,
            workspaceId: scopePackage.scope.workspaceId,
          })
        ).toEqual([]);
        expect(store.getAgentSession(predecessor.id).status).toBe('idle');
      } else {
        expect(earned).toMatchObject({
          storageRef: retained.storageRef,
          revision: retained.revision + 1,
          state: 'idle',
          attachmentGeneration: retained.attachmentGeneration,
        });
        expect(
          release.mock.calls.filter(([, input]) => input.storageRef === retained.storageRef)
        ).toHaveLength(1);
        expect(effects.filter(({ kind }) => kind === 'bridge.close')).toHaveLength(1);
        expect(effects.filter(({ kind }) => kind === 'sandbox.delete')).toHaveLength(1);
        if (concurrentRevisionAdvance) {
          expect(competing).toMatchObject({ revision: earned!.revision + 1, state: 'reserved' });
          expect(getWorkerStorageBinding(coreDb, retained)).toEqual(competing);
          expect(creates).toEqual([]);
        } else {
          expect(creates).toHaveLength(1);
          // Persistent Worker Volumes: a new attachment has its own historical generation.
          expect(
            store.getAgentSession(testEntityId('as', 'as_restart_selected_next')).retainedStorage
          ).toEqual({
            ...predecessor.retainedStorage,
            attachmentGeneration: retained.attachmentGeneration + 1,
          });
          expect(creates[0]!.input.storage).toMatchObject({
            storageRef: retained.storageRef,
            attachmentGeneration: retained.attachmentGeneration + 1,
          });
          expect(getWorkerStorageBinding(coreDb, retained)).toMatchObject({
            state: 'attached',
            revision: earned!.revision + 2,
            storageRef: retained.storageRef,
            attachmentGeneration: retained.attachmentGeneration + 1,
            targets: retained.targets,
          });
        }
        expect(store.getAgentSession(predecessor.id).status).toBe('closed');
      }
      expect(store.getAgentSession(predecessor.id)).toMatchObject({
        nativeHandleDigest: predecessor.nativeHandleDigest,
        retainedStorage: predecessor.retainedStorage,
      });
      expect(store.getTurnById(previous.turnId)).toEqual(previousTurn);
      expect(attempts.requireSchedulerExecutionAttempt(coreDb, closed.attemptId)).toEqual(closed);
    } finally {
      for (const join of joins) await join();
      restoreOpenObservation?.();
      await native?.restore();
      restoreRelease?.();
      await shutdownControlStoreWorkerClient();
      coreDb.sqlite.close();
    }
  }, 60_000);

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
      backend.requireAttemptId = () => testEntityId('attempt', 'lease-credentials');
      const environmentPackage = completeNanoHostPackage({
        scope: {
          agentSessionId: testEntityId('as', 'agent-session-credentials'),
          threadId: 'th_00000000-0000-7e27-9ef5-642b88a2b99c',
          turnId: 'tu_00000000-0000-7cc1-90b4-e57137ac6003',
          workspaceId: 'ws_00000000-0000-7095-90fc-d79041a2f1c4',
        },
        snapshotId: 'snapshot-credentials',
      });

      await authorizeNanoHostPackage(coreDb, environmentPackage);
      await anchorNanoHostMaterialization(coreDb, backend, environmentPackage);

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
        backend.materialize(environmentPackage, {
          providerCredentials: [
            {
              credentialKey: 'EXAMPLE_TOKEN',
              credentialValue: 'provider-secret',
              providerInstanceId: 'provider-example',
              providerType: 'generic',
            },
          ],
          workspaceRoots: [],
        })
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
      backend.requireAttemptId = (snapshotId) => testEntityId('attempt', `lease-${snapshotId}`);
      const sandboxIds: string[] = [];
      const agentSetup = createTestAgentSetup();
      // The policy below grants curl access, so the resolved AEP must declare its binary.
      agentSetup.manifest.runtime.binaries.push({ id: 'curl', path: '/usr/bin/curl' });
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
        [testEntityId('as', 'as_wp5_gate_r3'), 'aepsnap_factory_dns_lower'],
        [testEntityId('as', 'as_wp5_gate_r3_second'), 'aepsnap_factory_dns_upper'],
      ] as const) {
        const environmentPackage = completeNanoHostPackage({
          agentSetup,
          policy,
          runtime: {
            image: { kind: 'reference', pullPolicy: 'if-not-present', ref: 'openkit/worker:test' },
          },
          scope: {
            agentSessionId,
            threadId: testEntityId('th', `thread_${snapshotId}`),
            turnId: testEntityId('tu', `turn_${snapshotId}`),
            workspaceId: testEntityId('ws', `ws_${snapshotId}`),
          },
          snapshotId,
        });
        await authorizeNanoHostPackage(coreDb, environmentPackage);
        const firstPlan = backend.planSession(environmentPackage);
        const secondPlan = backend.planSession(environmentPackage);
        expect(secondPlan.backendSessionId).toBe(firstPlan.backendSessionId);

        await anchorNanoHostMaterialization(coreDb, backend, environmentPackage);
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
          leaseId: testEntityId('attempt', `lease-${snapshotId}`),
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
            storageRef: expect.stringMatching(entityIdPattern('wst')),
            targets: [
              {
                target: '/openkit/threads',
                volumeRef: expect.stringMatching(/^wsv_[0-9a-f]{32}$/),
              },
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
    const fixture = await prepareNonmemberAdminWorkerStorage('admin_success');
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

  it('admits canonical shared Thread storage without opening unrelated Knowledge', async () => {
    const coreDb = createFactoryCoreDb();
    const ownerUserId = ensureLocalUser(coreDb);
    const store = await createDemoStore({ dataRoot: coreDb.dataRoot });
    recordWorkspaceOwnerMembership({ coreDb, ownerUserId, workspaceId: DEMO_WORKSPACE_ID });
    const manifest = createTestAgentSetup({
      imageRef: `sha256:${'a'.repeat(64)}`,
      requiredCapabilities: ['trusted-worker-inference-relay'],
    }).manifest;
    admitTestNativeEnvironment(coreDb, manifest);
    const configuration = createInMemoryRuntimeConfigSnapshot({
      ...loadRuntimeConfig(coreDb.dataRoot),
      agentManifests: [manifest],
      gatewayConfig: createTestGatewayConfig(),
      providerRegistry: new ProviderRegistry([
        {
          id: 'agent-openrouter',
          displayName: 'Storage audience fixture',
          kind: 'local',
          models: ['openai/gpt-5.2'],
        },
      ]),
    });
    const native = createNativeTaskAdmissionFixture(coreDb, store, {
      readRuntimeConfig: () => configuration,
    });
    const backend = native.executor.executionBackend as WorkerGovernanceBackend;
    const materialize = backend.materialize.bind(backend);
    let openedNotebook = false;
    const materialization = vi.spyOn(backend, 'materialize').mockImplementation(async (...args) => {
      // Knowledge is a separate family; its content cannot decide storage audience eligibility.
      const notebook = vi.spyOn(KnowledgeNotebook.prototype, 'publishedRevision');
      notebook.mockImplementation(() => {
        openedNotebook = true;
        throw new Error('Unrelated Knowledge is unavailable.');
      });
      try {
        return await materialize(...args);
      } finally {
        notebook.mockRestore();
      }
    });
    let admitted: Awaited<ReturnType<typeof native.admitTurn>> | undefined;
    try {
      const entry = createSchedulerAdmissionEntry(coreDb, {
        backendId: 'nanohost',
        queueEntryId: 'queue:storage-audience-metadata',
        requestId: '00000000-0000-4000-8000-00000000e800',
        requestedAgentId: manifest.id,
        workspaceId: DEMO_WORKSPACE_ID,
        threadId: DEMO_THREAD_ID,
        turnId: testEntityId('tu', 'storage_audience_metadata'),
        turnInput: 'Use the current shared Thread audience.',
        triggerActor: { kind: 'user', id: ownerUserId },
      });
      await publishFactoryAdmission(store, entry);
      const agentSessionId = testEntityId('as', 'storage_audience_metadata');
      const admission = native.admitTurn(entry, {
        attemptId: testEntityId('attempt', 'storage_audience_metadata'),
        agentSessionId,
        candidateAgentSessionId: agentSessionId,
      });
      admitted = await admission.catch(() => undefined);
      expect(openedNotebook, 'Storage audience admission opened unrelated Knowledge.').toBe(false);
      expect(admitted).toBeDefined();
      expect((await admitted!.complete()).startedTurns).toHaveLength(1);
      expect(store.getTurnById(entry.turnId).status).toBe('completed');
    } finally {
      await admitted?.cleanup();
      materialization.mockRestore();
      await native.restore();
      await shutdownControlStoreWorkerClient();
      coreDb.sqlite.close();
    }
  });

  it('refuses retained storage after current named Thread Policy revokes the exact Agent', async () => {
    const fixture = await prepareNonmemberAdminWorkerStorage('resource_policy_revoked');
    const boundary = WorkspaceConfigSchema.parse({
      schemaVersion: 1,
      requiredFeatures: [WORKSPACE_RESOURCE_POLICY_FEATURE],
      workspace: {
        name: 'Managed retained storage',
        policy: {
          mediation: managedThreadPolicy({
            workspaceId: fixture.workspaceId,
            threadId: fixture.environmentPackage.scope.threadId,
            userId: fixture.adminUserId,
            agentId: fixture.environmentPackage.agent.agentId,
            operations: ['thread.read'],
          }),
        },
      },
    });
    fixture.currentConfiguration.workspaceConfigs.find(
      (entry) => entry.workspaceId === fixture.workspaceId
    )!.config = boundary;
    fixture.hooks.onInspect = () => {
      const policy = boundary.workspace.policy!.mediation;
      policy.statements = policy.statements.filter(
        (statement) => statement.kind === 'managed-boundary'
      );
    };
    try {
      await expect(
        fixture.backend.materialize(fixture.environmentPackage, {
          sandboxBindingRef: factoryPackageBinding(fixture.coreDb, fixture.environmentPackage),
          workspaceRoots: [],
        })
      ).rejects.toMatchObject({ code: 'authorization_denied', name: 'WorkerStorageBindingError' });
      expect(fixture.effects.map((effect) => effect.kind)).toEqual([
        'image.acquire',
        'image.inspect',
      ]);
    } finally {
      fixture.coreDb.sqlite.close();
    }
  });

  it('preserves contributor authorization denial after inspect and skips sandbox cleanup effects', async () => {
    const fixture = await prepareNonmemberAdminWorkerStorage('admin_revoked');
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
    const fixture = await prepareNonmemberAdminWorkerStorage('admin_foreign');
    try {
      const store = new FsStore({ dataRoot: fixture.coreDb.dataRoot });
      const privateThread = await store.createThread(
        fixture.workspaceId,
        'Foreign private',
        'th_00000000-0000-7d43-8173-d017b7b4d592',
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
        agentSessionId: testEntityId('as', 'as_00000000-0000-7a52-acda-ab0e51b27751'),
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
    const fixture = await prepareNonmemberAdminWorkerStorage('admin_expired');
    try {
      fixture.coreDb.sqlite
        .prepare(
          "UPDATE scheduler_execution_attempts SET phase = 'closed', deadline = '2000-01-01T00:00:00.000Z' WHERE attempt_id = ?"
        )
        .run(testEntityId('attempt', 'lease_admin_expired'));
      await expect(
        fixture.backend.materialize(fixture.environmentPackage, {
          sandboxBindingRef: factoryPackageBinding(fixture.coreDb, fixture.environmentPackage),
          workspaceRoots: [],
        })
      ).rejects.toMatchObject({
        code: 'authorization_denied',
        name: 'WorkerStorageBindingError',
      });
      // Scheduler Admission And Launch requires current authority before preparation effects.
      expect(fixture.effects.map((effect) => effect.kind)).toEqual([]);
    } finally {
      fixture.coreDb.sqlite.close();
    }
  });

  it.each([
    'cleanup',
    'eviction',
  ] as const)('preserves the shared resident after a pre-dispatch %s failure', async (path) => {
    const label = `no_effect_${path}`;
    const coreDb = createFactoryCoreDb();
    const dataRoot = coreDb.dataRoot;
    const ownerUserId = ensureLocalUser(coreDb);
    const store = await createDemoStore({ dataRoot });
    recordWorkspaceOwnerMembership({ coreDb, ownerUserId, workspaceId: DEMO_WORKSPACE_ID });
    const manifest = createTestAgentSetup({
      imageRef: `sha256:${'a'.repeat(64)}`,
      requiredCapabilities: ['trusted-worker-inference-relay'],
    }).manifest;
    const configuration = createInMemoryRuntimeConfigSnapshot({
      ...loadRuntimeConfig(dataRoot),
      agentManifests: [manifest],
      gatewayConfig: createTestGatewayConfig(),
      providerRegistry: new ProviderRegistry([
        {
          id: 'agent-openrouter',
          displayName: 'Resident fixture',
          kind: 'local',
          models: ['openai/gpt-5.2'],
        },
      ]),
    });
    const options = { readRuntimeConfig: () => configuration };
    const f = createNativeTaskAdmissionFixture(coreDb, store, options);
    let original: Awaited<ReturnType<typeof f.admitTurn>> | undefined;
    // Join native work and stop its sole peer before closing the caller-owned Core.
    onTestFinished(async () => {
      await original?.cleanup();
      await f.restore();
      await shutdownControlStoreWorkerClient();
      coreDb.sqlite.close();
    });
    const attemptId = testEntityId('attempt', `lease_${label}`);
    const agentSessionId = testEntityId('as', `as_${label}`);
    const entry = createSchedulerAdmissionEntry(coreDb, {
      backendId: 'nanohost',
      queueEntryId: `queue:${attemptId}`,
      requestId: testEntityId('tu', `request_${label}`).slice(3),
      requestedAgentId: manifest.id,
      workspaceId: DEMO_WORKSPACE_ID,
      threadId: DEMO_THREAD_ID,
      turnId: testEntityId('tu', `turn_${label}`),
      turnInput: 'Complete the original resident Turn',
      triggerActor: { kind: 'user', id: ownerUserId },
    });
    await publishFactoryAdmission(store, entry);
    original = await f.admitTurn(entry, {
      attemptId,
      agentSessionId,
      candidateAgentSessionId: agentSessionId,
    });
    await original.complete();
    const resident = original.pkg;
    const backend = (f.runtime.turnExecutor as WorkerGovernanceTurnExecutor)
      .executionBackend as WorkerGovernanceBackend;
    const native = backend as typeof backend & {
      createCleanupRecoveryResult(...args: unknown[]): unknown;
      deleteSandbox(...args: unknown[]): Promise<void>;
    };
    const sibling = store.getTurnById(resident.scope.turnId);
    expect(sibling.status).toBe('completed');
    const incoming = completeNanoHostPackage({
      ...(path === 'eviction'
        ? {
            runtime: {
              image: { kind: 'reference', pullPolicy: 'never', ref: `sha256:${'2'.repeat(64)}` },
            },
          }
        : {}),
      scope: {
        ...resident.scope,
        agentSessionId: testEntityId('as', `as_incoming_${path}`),
        threadId: testEntityId('th', `thread_incoming_${path}`),
        turnId: testEntityId('tu', `turn_incoming_${path}`),
      },
      snapshotId: `snapshot_incoming_${path}`,
    });
    await authorizeNanoHostPackage(coreDb, incoming);
    await anchorNanoHostMaterialization(coreDb, backend, incoming);
    const own = observeExecutionAttempts(coreDb).find(
      (row) => row.turn_id === incoming.scope.turnId
    )!;
    const beforeEffects = f.effects.length;
    const residentLifecycle = coreDb.sqlite
      .prepare(
        'SELECT lifecycle_state, health_state, drain_state, cleanup_state FROM sandbox_runtime_records'
      )
      .get();
    const failure = new Error('Cleanup failed before dispatch.');
    const injection =
      path === 'cleanup'
        ? vi.spyOn(native, 'createCleanupRecoveryResult').mockImplementation(() => {
            throw failure;
          })
        : vi.spyOn(native, 'deleteSandbox').mockRejectedValue(failure);
    try {
      if (path === 'eviction') {
        const materialization = backend.materialize(incoming, {
          sandboxBindingRef: factoryPackageBinding(coreDb, incoming),
          workspaceRoots: [],
        });
        await expect(materialization).rejects.toBeInstanceOf(
          WorkerGovernanceCapacityUnavailableError
        );
      }
      attempts.closeSchedulerExecutionAttemptWithoutEffects(coreDb, {
        attemptId: String(own.attempt_id),
        cause: 'turn-start-failed',
        noOutstandingEffects: true,
      });
      if (path === 'cleanup')
        await backend.cleanupSession(backend.planSession(incoming)).catch((error) => {
          expect(error).toBe(failure);
        });
      if (path === 'eviction') expect(injection).toHaveBeenCalledOnce();
      expect(
        f.effects
          .slice(beforeEffects)
          .filter((effect) => effect.kind === 'bridge.close' || effect.kind === 'sandbox.delete')
      ).toEqual([]);
      expect(
        coreDb.sqlite
          .prepare(
            'SELECT lifecycle_state, health_state, drain_state, cleanup_state FROM sandbox_runtime_records'
          )
          .get()
      ).toEqual(residentLifecycle);
      expect(
        coreDb.sqlite
          .prepare('SELECT lifecycle_state, drain_state FROM harness_instance_records')
          .get()
      ).toEqual({ lifecycle_state: 'open', drain_state: 'accepting' });
      expect(store.getTurnById(sibling.id)).toEqual(sibling);
      expect(
        attempts.requireSchedulerExecutionAttempt(coreDb, String(own.attempt_id))
      ).toMatchObject({
        phase: 'closed',
        disposition: 'not_accepted',
        operationId: null,
        terminalCause: 'turn-start-failed',
      });
    } finally {
      injection.mockRestore();
    }
  });

  it('durably consumes the idle bridge result before HTTP ACK and retains it across the pre-delete cold cut', async () => {
    let workspaceRef: ExecutionJournalRef | undefined;
    const label = 'bridge_closed_delete_refused_live';
    const attemptId = testEntityId('attempt', `lease_${label}`);
    // This case needs an actually closed Worker Turn root, beyond the backend-only idle fixture.
    const coreDb = createFactoryCoreDb();
    const dataRoot = coreDb.dataRoot;
    const ownerUserId = ensureLocalUser(coreDb);
    const store = await createDemoStore({ dataRoot });
    recordWorkspaceOwnerMembership({ coreDb, ownerUserId, workspaceId: DEMO_WORKSPACE_ID });
    const manifest = createTestAgentSetup({
      imageRef: `sha256:${'a'.repeat(64)}`,
      requiredCapabilities: ['trusted-worker-inference-relay'],
    }).manifest;
    const options = {
      readRuntimeConfig: () =>
        createInMemoryRuntimeConfigSnapshot({
          ...loadRuntimeConfig(dataRoot),
          agentManifests: [manifest],
          gatewayConfig: createTestGatewayConfig(),
          providerRegistry: new ProviderRegistry([
            {
              id: 'agent-openrouter',
              displayName: 'Idle cleanup fixture',
              kind: 'local',
              models: ['openai/gpt-5.2'],
            },
          ]),
        }),
    };
    const nativeFixture = createNativeTaskAdmissionFixture(coreDb, store, options);
    const entry = createSchedulerAdmissionEntry(coreDb, {
      backendId: 'nanohost',
      queueEntryId: `queue:${attemptId}`,
      requestId: testEntityId('tu', `request_${label}`).slice(3),
      requestedAgentId: manifest.id,
      workspaceId: DEMO_WORKSPACE_ID,
      threadId: DEMO_THREAD_ID,
      turnId: testEntityId('tu', `turn_${label}`),
      turnInput: 'Complete the original resident Turn',
      triggerActor: { kind: 'user', id: ownerUserId },
    });
    // Preserve the fixture's journal registration while observing acknowledged owner output.
    const writeIntent = vi
      .mocked(store.writeWorkspaceExecutionJournalIntent)
      .getMockImplementation();
    if (!writeIntent) throw new Error('Native admission has no real journal observer.');
    const prepared = vi
      .spyOn(store, 'writeWorkspaceExecutionJournalIntent')
      .mockImplementation(async (...args) => {
        const invocation = await writeIntent(...args);
        if (args[1].execution.workId === entry.turnId) workspaceRef = invocation.ref.execution;
        return invocation;
      });
    await publishFactoryAdmission(store, entry);
    const agentSessionId = testEntityId('as', `as_${label}`);
    const admitted = await nativeFixture.admitTurn(entry, {
      attemptId,
      agentSessionId,
      candidateAgentSessionId: agentSessionId,
    });
    onTestFinished(async () => {
      await admitted.cleanup();
      await nativeFixture.restore();
    });
    await admitted.complete();
    const f = {
      coreDb,
      runtime: nativeFixture.runtime,
      backend: nativeFixture.executor.executionBackend as WorkerGovernanceBackend,
      environmentPackage: admitted.pkg,
    };
    prepared.mockRestore();
    if (!workspaceRef) throw new Error('Resident fixture has no admitted Workspace journal.');
    const historicalRef = workspaceRef;
    const pkg = f.environmentPackage;
    const anchor = getWorkerBackendSession(f.coreDb, attemptId)!;
    const target = getNanoHostRuntimeTarget(f.coreDb, anchor.runtimeTargetId)!;
    const native = f.backend as unknown as {
      sessionDispatch: NanoHostSessionDispatch;
      evictIncompatibleIdleSandbox(pkg: AgentEnvironmentPackage, force: boolean): Promise<unknown>;
    };
    const readHistorical = async () => {
      const db = openWorkspaceDb(f.coreDb.dataRoot, pkg.scope.workspaceId);
      try {
        const reader = createExecutionStepJournalReader(db, historicalRef.owner);
        return {
          root: await reader.readExecution(historicalRef),
          steps: await reader.readEndedSteps(historicalRef),
        };
      } finally {
        db.sqlite.close();
      }
    };
    const historical = await readHistorical();
    const originalTurn = store.getTurnById(pkg.scope.turnId);
    expect(originalTurn.status).toBe('completed');
    const originalAttempt = attempts.requireSchedulerExecutionAttempt(f.coreDb, attemptId);
    let currentDb = f.coreDb;
    let runtime = f.runtime;
    let recoveryBackend: WorkerGovernanceBackend = f.backend;
    const authority = createNanoHostTransportSessionAuthority();
    let dispatch = createNanoHostSessionDispatch({
      coreDb: f.coreDb,
      sessionAuthority: authority,
    });
    const observed = new Map<string, ExecutionInvocation['ref']>();
    const write = journalOwners.writeExecutionJournalIntent;
    const preDeleteCut = new Error('Core cut before first delete intent SQL.');
    let cutBeforeDelete = true;
    let deleteIntent: Parameters<typeof write>[1] | undefined;
    let bridgeRef: ExecutionInvocation['ref'] | undefined;
    const journal = vi
      .spyOn(journalOwners, 'writeExecutionJournalIntent')
      .mockImplementation((...args) => {
        if (
          args[0].dataRoot === f.coreDb.dataRoot &&
          args[1].execution.ref.owner.kind === 'server' &&
          args[1].carriage.operation === 'sandbox.delete' &&
          cutBeforeDelete
        ) {
          deleteIntent = args[1];
          throw preDeleteCut;
        }
        const invocation = write(...args);
        if (
          args[0].dataRoot === f.coreDb.dataRoot &&
          invocation.ref.execution.owner.kind === 'server'
        )
          observed.set(JSON.stringify(invocation.ref), invocation.ref);
        if (
          args[0].dataRoot === f.coreDb.dataRoot &&
          invocation.carriage.operation === 'bridge.close'
        )
          bridgeRef = invocation.ref;
        return invocation;
      });
    let bridgeRequest: NanoHostSessionEffectRequest | undefined;
    let deleteRequest: NanoHostSessionEffectRequest | undefined;
    const queued = Promise.withResolvers<void>();
    const pendingAbort = new AbortController();
    const recoveryAbort = new AbortController();
    const outsideEffect = native.sessionDispatch.effect.bind(native.sessionDispatch);
    const effect = vi.spyOn(native.sessionDispatch, 'effect').mockImplementation((...args) => {
      const request = (args[1] ?? args[0]) as NanoHostSessionEffectRequest;
      if (request.kind !== 'bridge.close') return outsideEffect(request);
      bridgeRequest = request;
      // Normal Sandbox Drain And End requires durable exclusion before bridge contact.
      expect(
        currentDb.sqlite
          .prepare('SELECT drain_state FROM sandbox_runtime_records WHERE sandbox_binding_ref = ?')
          .get(anchor.sandboxBindingRef)
      ).toEqual({ drain_state: 'draining' });
      expect(
        currentDb.sqlite
          .prepare(
            `SELECT h.drain_state FROM harness_instance_records h
         JOIN sandbox_runtime_records s ON s.sandbox_runtime_id = h.sandbox_runtime_id
         WHERE s.sandbox_binding_ref = ?`
          )
          .all(anchor.sandboxBindingRef)
      ).toEqual([{ drain_state: 'draining' }]);
      const pending = dispatch.effect({ ...request, signal: pendingAbort.signal });
      queued.resolve();
      return pending;
    });
    // Read only actual owner output; neither a definition name nor a journal row is fabricated.
    const readCleanup = async (db: ReturnType<typeof openCoreDb>) => {
      const reader = createExecutionStepJournalReader(db, { kind: 'server' });
      const invocations = await Promise.all(
        [...observed.values()].map((ref) => reader.readInvocation(ref))
      );
      const bridge = invocations.find(
        (entry) => entry.carriage.requestId === bridgeRequest?.requestId
      );
      expect(bridge, 'bridge result has no durable Core invocation').toBeDefined();
      const ref = bridge!.ref.execution;
      const ended = await reader.readEndedSteps(ref);
      expect(bridge!.state).toBe('completed');
      expect(bridge!.carriage.operation).toBe('bridge.close');
      expect(bridge!.control.target?.targetId).toBe(anchor.runtimeTargetId);
      const lineage = JSON.stringify(bridge, (_key, value) =>
        typeof value === 'bigint' ? value.toString() : value
      );
      expect(lineage).toContain(anchor.originPhysicalEpoch);
      expect(lineage).toContain(anchor.sandboxBindingRef);
      const consumed = ended.find(
        (entry) => entry.control.kind === 'consume-receipt' && entry.state === 'completed'
      );
      expect(consumed, 'bridge outcome has no durable consume step').toBeDefined();
      expect(bridge!.control.outputRefs.length).toBeGreaterThan(0);
      const root = await reader.readExecution(ref);
      expect(root.workId).not.toBe(pkg.scope.turnId);
      expect(ref).not.toEqual(historicalRef);
      return { bridge, consumed, root, ended };
    };
    let beforeAck: Awaited<ReturnType<typeof readCleanup>> | undefined;
    let routeError: Error | undefined;
    const path = '/api/nanohost/transport/effects/bridge.close';
    // Rebind the ordinary routes to each cold Core and its real receiver.
    const routes = () => {
      const app = new Hono<{ Variables: AuthVariables }>();
      app.onError((error, context) => {
        routeError = error;
        return context.body(null, 500);
      });
      app.use(`${path}/result`, async (context, next) => {
        await next();
        // Hono has not returned the response to the native H2 listener yet.
        if (context.res.status === 204) beforeAck = await readCleanup(currentDb);
      });
      app.use('/api/nanohost/transport/effects/sandbox.delete/result', async (context, next) => {
        await next();
        if (context.res.status !== 204) return;
        const reader = createExecutionStepJournalReader(currentDb, { kind: 'server' });
        const invocation = await reader.readInvocation({
          execution: deleteIntent!.execution.ref,
          stepId: deleteIntent!.stepId,
        });
        expect(invocation.state).toBe('completed');
        expect(invocation.carriage.requestId).toBe(deleteRequest!.requestId);
        const linked = await reader.readLinkedInspections(invocation.ref);
        expect(
          linked.some(
            ({ inspection }) =>
              inspection.state === 'completed' &&
              inspection.control.kind === 'consume-receipt' &&
              inspection.control.operationId === deleteRequest!.requestId &&
              inspection.control.inputRefs[0] === invocation.control.outputRefs[0]
          )
        ).toBe(true);
      });
      registerNanoHostSessionSemanticRoutes({
        app,
        coreDb: currentDb,
        dispatch,
        nanoHostConfig: target,
      });
      registerNanoHostSessionEffectRoutes({ app, dispatch });
      return getRequestListener(app.fetch);
    };
    let listener = routes();
    const maintain = () =>
      runNanoHostAttemptRecoveryMaintenance(currentDb, {
        executionBackend: recoveryBackend,
        store,
        cleanupBackendSession: runtime.cleanupBackendSession,
        reconcileExecutions: () => runtime.executionReconciler.runOnce(),
        prepareBackendCleanup: runtime.prepareBackendCleanup,
        restoreBackendSession: runtime.restoreBackendSession,
        reconcileAcceptedFinalStatus: runtime.reconcileAcceptedFinalStatus,
        projectRecoveredTurn: async () => {
          throw new Error('Idle cleanup must not publish another historical Turn outcome.');
        },
      });
    let physical: object | undefined;
    const server = createHttp2Server(async (request, response) => {
      if (!physical) {
        physical = readNanoHostPhysicalConnectionContext(request)!;
        authority.admit({
          identityId: target.identityId,
          connectionGeneration: target.connectionGeneration,
          physicalConnection: physical,
        });
        await dispatch.readiness!(
          physical,
          Buffer.from(JSON.stringify({ physicalEpoch: anchor.originPhysicalEpoch })),
          { ...target, coreDb: f.coreDb }
        );
      }
      void listener(request, response);
    });
    let client: ReturnType<typeof connectHttp2> | undefined;
    let cold: ReturnType<typeof openCoreDb> | undefined;
    let closing: Promise<unknown> | undefined;
    let maintenance: ReturnType<typeof startSchedulerAttemptMaintenanceService> | undefined;
    try {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('Missing idle cleanup test address.');
      client = connectHttp2(`http://127.0.0.1:${address.port}`);
      const post = async (route: string, body: unknown) => {
        const stream = client!.request({
          ':method': 'POST',
          ':path': route,
          'content-type': 'application/json',
        });
        const headers = once(stream, 'response');
        stream.end(JSON.stringify(body));
        const [received] = await headers;
        const chunks: Buffer[] = [];
        for await (const chunk of stream) chunks.push(Buffer.from(chunk));
        return { status: received[':status'], body: Buffer.concat(chunks).toString() };
      };
      // The fixture target has a distinct identity; admit its actual native readiness selector.
      expect((await post('/fixture/readiness', {})).status).toBe(404);
      closing = native.evictIncompatibleIdleSandbox(pkg, true);
      void closing.catch(() => undefined);
      await Promise.race([
        queued.promise,
        closing.then(() => {
          throw new Error('Idle cleanup completed without bridge contact.');
        }),
      ]);
      const command = await post(path, {});
      expect(command.status).toBe(200);
      expect(JSON.parse(command.body).requestId).toBe(bridgeRequest!.requestId);
      expect(bridgeRef).toBeDefined();
      const unfinished = await createExecutionStepJournalReader(currentDb, {
        kind: 'server',
      }).readInvocation(bridgeRef!);
      expect(unfinished.state).toBe('intent');
      expect(unfinished.control.outputRefs).toEqual([]);
      expect(historical.root.phase).toBe('closed');
      expect(originalAttempt.phase).toBe('closed');

      // Drop the original owner before cancelling its process-local wait. No outcome is forged.
      await runtime.executionReconciler.stop();
      await nativeFixture.restore();
      await shutdownControlStoreWorkerClient();
      currentDb.sqlite.close();
      pendingAbort.abort();
      await closing.catch(() => undefined);
      effect.mockRestore();
      cold = openCoreDb(f.coreDb.dataRoot);
      currentDb = cold;
      dispatch = createNanoHostSessionDispatch({ coreDb: currentDb, sessionAuthority: authority });
      runtime = createConfiguredWorkerLifecycleRuntime({
        coreDb: currentDb,
        store,
        ...options,
        env: {},
        nanoHostSessionDispatch: dispatch,
        workerControlGateway: new WorkerControlGateway(),
      });
      recoveryBackend = (runtime.turnExecutor as WorkerGovernanceTurnExecutor).executionBackend;
      listener = routes();
      await dispatch.readiness!(
        physical!,
        Buffer.from(JSON.stringify({ physicalEpoch: anchor.originPhysicalEpoch })),
        { ...target, coreDb: currentDb }
      );
      const waitingEffects = vi.spyOn(dispatch, 'effect');
      const resultOnly = vi.spyOn(dispatch, 'expectResultOnly');
      onTestFinished(() => {
        waitingEffects.mockRestore();
        resultOnly.mockRestore();
      });
      const checkpoints = vi.fn(async () => {});
      maintenance = startSchedulerAttemptMaintenanceService({
        intervalMs: 30_000,
        runRecoveryMaintenance: { scheduler: async () => {}, native: maintain, checkpoints },
        setInterval: () => 'idle-result-only-test',
        clearInterval: () => {},
      });
      for (let pass = 0; pass < 2; pass += 1) {
        await maintenance.runOnce();
        expect(checkpoints).toHaveBeenCalledTimes(pass + 1);
        expect(waitingEffects).not.toHaveBeenCalled();
        const stillWaiting = await createExecutionStepJournalReader(currentDb, {
          kind: 'server',
        }).readInvocation(bridgeRef!);
        expect(stillWaiting).toEqual({ ...unfinished, remainingMs: expect.any(Number) });
        expect(stillWaiting.remainingMs).toBeLessThanOrEqual(unfinished.remainingMs);
        // DX Physical Receipt Consumption: unfinished ownership cannot become orphan cleanup.
        expect(journalOwners.hasIdleCleanupExecution(currentDb, anchor)).toBe(true);
        expect(await readHistorical()).toEqual(historical);
        expect(store.getTurnById(pkg.scope.turnId)).toEqual(originalTurn);
        expect(await recoveryBackend.inspectMaterializationCapacity?.(pkg)).toBe(
          'capacity-saturated'
        );
      }
      await maintenance.stop();
      expect(resultOnly).toHaveBeenCalledTimes(1);
      expect(
        resultOnly.mock.calls[0]![0].map(({ kind, requestId, originPhysicalEpoch }) => ({
          kind,
          requestId,
          originPhysicalEpoch,
        }))
      ).toEqual([
        {
          kind: 'bridge.close',
          requestId: bridgeRequest!.requestId,
          originPhysicalEpoch: anchor.originPhysicalEpoch,
        },
      ]);
      const result = {
        requestId: bridgeRequest!.requestId,
        sandboxId: bridgeRequest!.input.sandboxId,
        state: 'closed',
      };
      const ack = await post(`${path}/result`, result);
      if (routeError) throw routeError;
      expect(ack.status).toBe(204);
      expect(beforeAck).toBeDefined();
      expect(waitingEffects).not.toHaveBeenCalled();
      // The recovered result alone commits consumption. Maintenance owns subsequent delete admission.
      closing = maintain();
      void closing.catch(() => undefined);
      await expect(closing).rejects.toSatisfy((failure: unknown) => {
        // The real refusal must survive composition; aggregate nesting and repeats are not authority.
        const causes = (error: unknown): unknown[] =>
          error instanceof AggregateError ? error.errors.flatMap(causes) : [error];
        const original = causes(failure);
        return original.length > 0 && original.every((error) => error === preDeleteCut);
      });
      expect(deleteIntent).toBeDefined();
      expect(deleteIntent!.carriage.requestId).not.toBe(bridgeRequest!.requestId);
      expect(
        currentDb.sqlite
          .prepare('SELECT 1 FROM control_executions WHERE id = ?')
          .get(deleteIntent!.execution.ref.executionId)
      ).toBeUndefined();
      expect(waitingEffects).not.toHaveBeenCalled();
      expect(await recoveryBackend.inspectMaterializationCapacity?.(pkg)).toBe(
        'capacity-saturated'
      );
      const retained = await readCleanup(currentDb);
      expect(retained.root.phase).toBe('closed');
      // Exact ownership is independent of candidate discovery and CLOSED root terminality.
      expect(journalOwners.hasIdleCleanupExecution(currentDb, anchor)).toBe(true);
      expect(retained.bridge).toEqual(beforeAck!.bridge);
      expect(retained.consumed).toEqual(beforeAck!.consumed);
      expect(await readHistorical()).toEqual(historical);
      expect(store.getTurnById(pkg.scope.turnId)).toEqual(originalTurn);
      expect(attempts.requireSchedulerExecutionAttempt(currentDb, attemptId)).toEqual(
        originalAttempt
      );
      await runtime.executionReconciler.stop();
      await shutdownControlStoreWorkerClient();
      waitingEffects.mockRestore();
      resultOnly.mockRestore();
      currentDb.sqlite.close();
      cold = openCoreDb(f.coreDb.dataRoot);
      currentDb = cold;
      expect(await readCleanup(cold)).toEqual(retained);
      expect(journalOwners.hasIdleCleanupExecution(cold, anchor)).toBe(true);
      expect(await readHistorical()).toEqual(historical);
      const reopened = createNanoHostSessionDispatch({ coreDb: cold, sessionAuthority: authority });
      dispatch = reopened;
      runtime = createConfiguredWorkerLifecycleRuntime({
        coreDb: currentDb,
        store,
        ...options,
        env: {},
        nanoHostSessionDispatch: dispatch,
        workerControlGateway: new WorkerControlGateway(),
      });
      recoveryBackend = (runtime.turnExecutor as WorkerGovernanceTurnExecutor).executionBackend;
      listener = routes();
      await reopened.readiness!(
        physical!,
        Buffer.from(JSON.stringify({ physicalEpoch: anchor.originPhysicalEpoch })),
        { ...target, coreDb: cold }
      );
      await expect(reopened.result(physical!, 'bridge.close', result)).resolves.toBeUndefined();
      await expect(
        reopened.result(physical!, 'bridge.close', { ...result, sandboxId: 'unrelated-resident' })
      ).rejects.toThrow();
      expect(await readCleanup(cold)).toEqual(retained);
      await expect(reopened.poll(physical!, 'bridge.close')).resolves.toBeNull();
      await expect(reopened.poll(physical!, 'sandbox.delete')).resolves.toBeNull();
      cutBeforeDelete = false;
      const deleteQueued = Promise.withResolvers<void>();
      const forward = reopened.effect.bind(reopened);
      const resumed = vi.spyOn(reopened, 'effect').mockImplementation((...args) => {
        const request = (args[1] ?? args[0]) as NanoHostSessionEffectRequest;
        expect(request.kind).toBe('sandbox.delete');
        deleteRequest = request;
        const pending = forward({
          ...request,
          signal: AbortSignal.any([
            ...(request.signal ? [request.signal] : []),
            recoveryAbort.signal,
          ]),
        });
        deleteQueued.resolve();
        return pending;
      });
      onTestFinished(() => resumed.mockRestore());
      const consumedOnly = vi.spyOn(reopened, 'expectResultOnly');
      onTestFinished(() => consumedOnly.mockRestore());
      closing = maintain();
      void closing.catch(() => undefined);
      await Promise.race([
        deleteQueued.promise,
        closing.then(() => {
          throw new Error('Cold maintenance completed without the first actual delete.');
        }),
      ]);
      expect(resumed).toHaveBeenCalledTimes(1);
      expect(
        consumedOnly.mock.calls
          .flatMap(([entries]) => entries)
          .some((entry) => entry.kind === 'bridge.close')
      ).toBe(false);
      expect(deleteRequest!.requestId).toBe(deleteIntent!.carriage.requestId);
      expect(deleteRequest!.input.sandboxId).toBe(bridgeRequest!.input.sandboxId);
      expect(await readCleanup(currentDb)).toEqual(retained);
      expect(await recoveryBackend.inspectMaterializationCapacity?.(pkg)).toBe(
        'capacity-saturated'
      );
      const deletePath = '/api/nanohost/transport/effects/sandbox.delete';
      const admittedDelete = await post(deletePath, {});
      expect(admittedDelete.status).toBe(200);
      expect(JSON.parse(admittedDelete.body).requestId).toBe(deleteRequest!.requestId);
      expect(await recoveryBackend.inspectMaterializationCapacity?.(pkg)).toBe(
        'capacity-saturated'
      );
      expect(
        (
          await post(`${deletePath}/result`, {
            requestId: deleteRequest!.requestId,
            sandboxId: deleteRequest!.input.sandboxId,
            state: 'deleted',
          })
        ).status
      ).toBe(204);
      if (routeError) throw routeError;
      await closing;
      expect(await recoveryBackend.inspectMaterializationCapacity?.(pkg)).toBe('available');
      expect(resumed).toHaveBeenCalledTimes(1);
      expect(await readCleanup(currentDb)).toEqual(retained);
      expect(await readHistorical()).toEqual(historical);
      expect(store.getTurnById(pkg.scope.turnId)).toEqual(originalTurn);
      expect(attempts.requireSchedulerExecutionAttempt(currentDb, attemptId)).toEqual(
        originalAttempt
      );
    } finally {
      const executionsStopped = Promise.allSettled([runtime.executionReconciler.stop()]);
      await maintenance?.stop();
      client?.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      pendingAbort.abort();
      recoveryAbort.abort();
      await closing?.catch(() => undefined);
      await executionsStopped;
      await nativeFixture.restore();
      effect.mockRestore();
      journal.mockRestore();
      prepared.mockRestore();
      cold?.sqlite.close();
      if (f.coreDb.sqlite.open) f.coreDb.sqlite.close();
    }
  });

  it('joins the addressed idle resident while a distinct anchor has failed storage release', async () => {
    const coreDb = createFactoryCoreDb();
    const ownerUserId = ensureLocalUser(coreDb);
    const store = await createDemoStore({ dataRoot: coreDb.dataRoot });
    recordWorkspaceOwnerMembership({ coreDb, ownerUserId, workspaceId: DEMO_WORKSPACE_ID });
    const setup = createTestAgentSetup({
      imageRef: `sha256:${'a'.repeat(64)}`,
      requiredCapabilities: ['trusted-worker-inference-relay'],
    });
    const f = createNativeTaskAdmissionFixture(coreDb, store, {
      readRuntimeConfig: () =>
        createInMemoryRuntimeConfigSnapshot({
          ...loadRuntimeConfig(coreDb.dataRoot),
          agentManifests: [setup.manifest],
          gatewayConfig: createTestGatewayConfig(),
          openKitConfig: { nanohost: { maxActiveTurnsPerSandbox: 2 } },
          providerRegistry: new ProviderRegistry([
            {
              id: 'agent-openrouter',
              displayName: 'Idle resident join fixture',
              kind: 'local',
              models: ['openai/gpt-5.2'],
            },
          ]),
        }),
    });
    const cohort: Array<Awaited<ReturnType<typeof f.admitTurn>>> = [];
    const intents = new Map<string, ExecutionInvocation['ref']>();
    const write = journalOwners.writeExecutionJournalIntent;
    const journal = vi
      .spyOn(journalOwners, 'writeExecutionJournalIntent')
      .mockImplementation((...args) => {
        const invocation = write(...args);
        if (
          args[0].dataRoot === coreDb.dataRoot &&
          invocation.ref.execution.owner.kind === 'server' &&
          invocation.control.kind !== 'consume-receipt' &&
          ['bridge.close', 'sandbox.delete'].includes(invocation.carriage.operation)
        )
          intents.set(invocation.carriage.operation, invocation.ref);
        return invocation;
      });
    let storageFault: { mockRestore(): void } | undefined;
    try {
      for (const label of ['first', 'second']) {
        const thread = await store.createThread(
          DEMO_WORKSPACE_ID,
          `Idle resident join ${label}`,
          testEntityId('th', `idle_resident_join_${label}`)
        );
        const storage = cohort.length
          ? getWorkerStorageBinding(
              coreDb,
              store.getAgentSession(cohort[0]!.pkg.scope.agentSessionId).retainedStorage!
            )!
          : null;
        const entry = createSchedulerAdmissionEntry(coreDb, {
          backendId: 'nanohost',
          queueEntryId: `queue:idle-resident-join-${label}`,
          requestId: testEntityId('tu', `idle_resident_join_request_${label}`).slice(3),
          requestedAgentId: setup.manifest.id,
          workspaceId: DEMO_WORKSPACE_ID,
          threadId: thread.id,
          turnId: testEntityId('tu', `idle_resident_join_${label}`),
          turnInput: 'Retain the exact resident until its storage attachment is released.',
          triggerActor: { kind: 'user', id: ownerUserId },
          ...(storage
            ? {
                workerStorageChoice: {
                  kind: 'selected' as const,
                  storageRef: storage.storageRef,
                  expectedRevision: storage.revision,
                  purpose: 'work' as const,
                  goalId: null,
                  taskId: null,
                },
              }
            : {}),
        });
        await publishFactoryAdmission(store, entry);
        const agentSessionId = testEntityId('as', `idle_resident_join_${label}`);
        cohort.push(
          await f.admitTurn(entry, {
            attemptId: testEntityId('attempt', `idle_resident_join_${label}`),
            agentSessionId,
            candidateAgentSessionId: agentSessionId,
          })
        );
      }
      expect(f.effects.filter(({ kind }) => kind === 'sandbox.create')).toHaveLength(1);
      const second = cohort[1]!;
      const backend = f.executor.executionBackend as WorkerGovernanceBackend;
      const identity = backend.planSession(second.pkg);
      for (const admitted of cohort) await admitted.complete();
      const originalTurns = cohort.map(({ pkg }) => store.getTurnById(pkg.scope.turnId));
      const anchor = getWorkerBackendSession(coreDb, second.attempt.attemptId)!;
      for (const admitted of cohort)
        expect(
          attempts.requireSchedulerExecutionAttempt(coreDb, admitted.attempt.attemptId).phase
        ).toBe('closed');
      const attachment = getWorkerStorageBinding(
        coreDb,
        store.getAgentSession(cohort[0]!.pkg.scope.agentSessionId).retainedStorage!
      );
      if (!attachment?.currentSandboxBindingRef)
        throw new Error('Idle join fixture has no actual attached resident.');
      harnessRecords.drainNanoHostSandboxAdmission(coreDb, {
        sandboxBindingRef: attachment.currentSandboxBindingRef,
        originPhysicalEpoch: anchor.originPhysicalEpoch,
      });
      const releaseFailure = new Error('Controlled addressed-resident storage release refusal.');
      storageFault = vi
        .spyOn(storageOwners, 'releaseWorkerStorageAttachment')
        .mockImplementation(() => {
          throw releaseFailure;
        });
      // Actual physical completion does not retire the resident's still-owned storage attachment.
      const cleanupFailure = await backend
        .cleanupSession(identity, { failedCloseout: false, wholeSandbox: true })
        .catch((error: unknown) => error);
      // Keep setup refusals visible without unbounded exception trees or private stack bytes.
      const failureMessages = (failure: unknown, depth = 0): string[] => {
        if (depth === 3) return ['Further cleanup causes omitted.'];
        if (!(failure instanceof Error)) return [`Cleanup outcome: ${typeof failure}.`];
        return [
          `${failure.name}: ${failure.message.slice(0, 256)}`,
          ...(failure instanceof AggregateError
            ? failure.errors.slice(0, 4).flatMap((error) => failureMessages(error, depth + 1))
            : failure.cause === undefined
              ? []
              : failureMessages(failure.cause, depth + 1)),
        ];
      };
      expect(
        storageFault,
        failureMessages(cleanupFailure).join(' | ').slice(0, 2048)
      ).toHaveBeenCalled();
      expect(intents.has('bridge.close')).toBe(true);
      expect(intents.has('sandbox.delete')).toBe(true);
      const reader = createExecutionStepJournalReader(coreDb, { kind: 'server' });
      const original = await reader.readInvocation(intents.get('sandbox.delete')!);
      const residentBinding = original.carriage.bindingRef!;
      expect(residentBinding).not.toBe(anchor.sandboxBindingRef);
      expect(original.state).toBe('completed');
      expect(
        (await reader.readLinkedInspections(original.ref)).some(
          ({ inspection }) =>
            inspection.state === 'completed' && inspection.control.kind === 'consume-receipt'
        )
      ).toBe(true);
      expect(
        getWorkerStorageBindingForSandbox(coreDb, { sandboxBindingRef: residentBinding })
      ).not.toBeNull();
      // DX Physical Receipt Consumption: absence of an anchor is not absence of its addressed resident.
      await expect(f.runtime.executionReconciler.reconcileIdleCleanup(identity)).rejects.toThrow();
      expect(await backend.inspectMaterializationCapacity?.(second.pkg)).toBe('capacity-saturated');
      const physical = () =>
        f.effects
          .filter(({ kind }) => kind === 'bridge.close' || kind === 'sandbox.delete')
          .map(({ kind }) => kind);
      expect(physical()).toEqual(['bridge.close', 'sandbox.delete']);

      storageFault.mockRestore();
      storageFault = undefined;
      await expect(
        f.runtime.executionReconciler.reconcileIdleCleanup(identity)
      ).resolves.toBeUndefined();
      expect(
        getWorkerStorageBindingForSandbox(coreDb, { sandboxBindingRef: residentBinding })
      ).toBeNull();
      expect(await reader.readInvocation(original.ref)).toEqual(original);
      expect(physical()).toEqual(['bridge.close', 'sandbox.delete']);
      expect(cohort.map(({ pkg }) => store.getTurnById(pkg.scope.turnId))).toEqual(originalTurns);
    } finally {
      storageFault?.mockRestore();
      await Promise.allSettled([f.runtime.executionReconciler.stop()]);
      for (const admitted of cohort) await admitted.cleanup();
      await f.restore();
      journal.mockRestore();
      await shutdownControlStoreWorkerClient();
      if (coreDb.sqlite.open) coreDb.sqlite.close();
    }
  });

  it.each([
    true,
    false,
  ])('releases a genuinely unknown close only after complete closeout and a fresh physical fence (failed final=%s)', async (failedFinal) => {
    const coreDb = createFactoryCoreDb();
    const dataRoot = coreDb.dataRoot;
    const ownerUserId = ensureLocalUser(coreDb);
    const store = await createDemoStore({ dataRoot });
    recordWorkspaceOwnerMembership({ coreDb, ownerUserId, workspaceId: DEMO_WORKSPACE_ID });
    const manifest = createTestAgentSetup({
      imageRef: `sha256:${'a'.repeat(64)}`,
      requiredCapabilities: ['trusted-worker-inference-relay'],
    }).manifest;
    const options = {
      readRuntimeConfig: () =>
        createInMemoryRuntimeConfigSnapshot({
          ...loadRuntimeConfig(dataRoot),
          agentManifests: [manifest],
          gatewayConfig: createTestGatewayConfig(),
          providerRegistry: new ProviderRegistry([
            {
              id: 'agent-openrouter',
              displayName: 'Unknown close fixture',
              kind: 'local',
              models: ['openai/gpt-5.2'],
            },
          ]),
        }),
    };
    const f = createNativeTaskAdmissionFixture(coreDb, store, options);
    f.peerFaults.failedFinal = failedFinal;
    const attemptId = testEntityId('attempt', 'unknown_release');
    const agentSessionId = testEntityId('as', 'unknown_release');
    const turnId = testEntityId('tu', 'unknown_release');
    const sibling = await store.createThread(
      DEMO_WORKSPACE_ID,
      'Unrelated retained sibling',
      testEntityId('th', 'unknown_release_sibling')
    );
    let original: Awaited<ReturnType<typeof f.admitTurn>> | undefined;
    let workspace: ReturnType<typeof openWorkspaceDb> | undefined;
    let cold: ReturnType<typeof openCoreDb> | undefined;
    let coldWorkspace: ReturnType<typeof openWorkspaceDb> | undefined;
    onTestFinished(async () => {
      await original?.cleanup();
      await f.restore();
      await shutdownControlStoreWorkerClient();
      if (workspace?.sqlite.open) workspace.sqlite.close();
      if (coldWorkspace?.sqlite.open) coldWorkspace.sqlite.close();
      if (coreDb.sqlite.open) coreDb.sqlite.close();
      if (cold?.sqlite.open) cold.sqlite.close();
      vi.restoreAllMocks();
    });
    let ref: ExecutionJournalRef | undefined;
    // Chain the shared fixture's actual writer observation, retaining its own journal registration.
    const write = vi.mocked(store.writeWorkspaceExecutionJournalIntent).getMockImplementation()!;
    vi.spyOn(store, 'writeWorkspaceExecutionJournalIntent').mockImplementation(async (...args) => {
      const invocation = await write(...args);
      if (args[1].execution.workId === turnId) ref = invocation.ref.execution;
      return invocation;
    });
    const inspecting = new Set<string>();
    let lostClose: harnessRecords.NanoHostHarnessCommand | undefined;
    const accept = f.runtime.acceptNanoHostHarnessCommand;
    const command = vi
      .spyOn(f.runtime, 'acceptNanoHostHarnessCommand')
      .mockImplementation(async (input) => {
        const wire = await accept(input);
        if (input.operation === 'session.inspect') inspecting.add(input.operationId);
        if (input.operation === 'session.close' && !lostClose) {
          lostClose = input;
          // Outside peer loses this accepted local-close response; its real catch records unknown.
          throw new Error('Controlled local-close response loss.');
        }
        return wire;
      });
    const settle = harnessRecords.settleNanoHostHarnessOperation;
    const receiver = vi
      .spyOn(harnessRecords, 'settleNanoHostHarnessOperation')
      .mockImplementation((db, input) => {
        if (db === coreDb && inspecting.has(input.result.operationId)) {
          // The outside peer reports its failed process, so ordinary close follows real capture.
          Object.assign(input.result.body, { state: 'failed' });
        }
        return settle(db, input);
      });
    const entry = createSchedulerAdmissionEntry(coreDb, {
      backendId: 'nanohost',
      queueEntryId: `queue:${attemptId}`,
      requestId: turnId.slice(3),
      requestedAgentId: manifest.id,
      workspaceId: DEMO_WORKSPACE_ID,
      threadId: DEMO_THREAD_ID,
      turnId,
      turnInput: 'Retain unknown cleanup until the exact full release proof exists.',
      triggerActor: { kind: 'user', id: ownerUserId },
    });
    await publishFactoryAdmission(store, entry);
    original = await f.admitTurn(entry, {
      attemptId,
      agentSessionId,
      candidateAgentSessionId: agentSessionId,
    });
    await expect(original.complete()).rejects.toBeInstanceOf(Error);
    expect(lostClose, 'the fault must reach an actually admitted local close').toBeDefined();
    expect(f.effects.some((effect) => effect.kind === 'file.export')).toBe(true);
    const failed = store.getTurnById(turnId);
    expect(failed.status).toBe('failed');
    await original.cleanup();
    await f.restore();
    command.mockRestore();
    receiver.mockRestore();
    if (!ref) throw new Error('Unknown close has no actual Workspace execution.');
    const journalRef = ref;
    workspace = openWorkspaceDb(dataRoot, DEMO_WORKSPACE_ID);
    const reader = createExecutionStepJournalReader(workspace, journalRef.owner);
    const unknown = (await reader.readEndedSteps(journalRef)).filter(
      (step) => step.state === 'unknown'
    );
    expect(unknown.length).toBeGreaterThan(0);
    expect(
      unknown.some(
        (step) => step.control.kind === 'inspect-cleanup' || step.control.kind === 'inspect-session'
      )
    ).toBe(true);
    const originalUnknownIds = new Set(unknown.map((step) => step.ref.stepId));
    // Raw readback is necessary here: the owner must preserve the actual unknown bytes, not a rebuilt view.
    const unknownBytes = (db: ReturnType<typeof openWorkspaceDb>) =>
      db.sqlite
        .prepare(
          "SELECT * FROM control_execution_steps WHERE execution_id = ? AND state = 'unknown' ORDER BY ordinal"
        )
        .all(journalRef.executionId)
        .filter((row) => originalUnknownIds.has((row as { step_id: string }).step_id));
    const originalUnknown = unknownBytes(workspace);
    const closing = await reader.readExecution(journalRef);
    expect(closing.phase).toBe('closing');
    expect(closing.exclusionRefs.length).toBeGreaterThan(0);
    const anchor = getWorkerBackendSession(coreDb, attemptId)!;
    const target = getNanoHostRuntimeTarget(coreDb, anchor.runtimeTargetId)!;
    const runtime = createConfiguredWorkerLifecycleRuntime({
      ...options,
      coreDb,
      store,
      env: {},
      nanoHostSessionDispatch: createFactoryNanoHostDispatch(f.effects),
      workerControlGateway: new WorkerControlGateway(),
    });
    const maintenance = () =>
      runNanoHostAttemptRecoveryMaintenance(coreDb, {
        store,
        executionBackend: runtime.turnExecutor.executionBackend!,
        cleanupBackendSession: runtime.cleanupBackendSession,
        reconcileExecutions: () => runtime.executionReconciler.runOnce(),
        prepareBackendCleanup: runtime.prepareBackendCleanup,
        restoreBackendSession: runtime.restoreBackendSession,
        reconcileAcceptedFinalStatus: runtime.reconcileAcceptedFinalStatus,
        isTurnExecutionActive: runtime.isTurnExecutionActive,
        projectRecoveredTurn: async () => {
          throw new Error('Accepted final retains its actual closeout owner.');
        },
      });
    const effectsBeforeProof = f.effects.length;
    // A refusal or no advancement is valid; neither can turn weak same-Epoch evidence into release.
    await maintenance().catch(() => undefined);
    expect(attempts.requireSchedulerExecutionAttempt(coreDb, attemptId)).toMatchObject({
      phase: 'closing',
      fenceRef: null,
    });
    expect(await reader.readExecution(journalRef)).toMatchObject({
      phase: 'closing',
      exclusionRefs: closing.exclusionRefs,
    });
    expect(unknownBytes(workspace)).toEqual(originalUnknown);
    expect(f.effects).toHaveLength(effectsBeforeProof);
    expect(store.getTurnById(turnId)).toEqual(failed);
    const unknownBeforeRelease = (await reader.readEndedSteps(journalRef)).filter(
      (step) => step.state === 'unknown'
    );
    const successor = allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
      targetId: anchor.runtimeTargetId,
      identityId: target.identityId,
      deploymentId: anchor.deploymentId,
      observedAt: new Date().toISOString(),
    });
    upsertNanoHostRuntimeTarget(coreDb, {
      ...successor,
      physicalEpoch:
        anchor.originPhysicalEpoch === 'b'.repeat(64) ? 'c'.repeat(64) : 'b'.repeat(64),
      predecessorFenced: true,
      ready: true,
      freshEmpty: true,
      observedAt: new Date().toISOString(),
    });
    // No fabricated cleanup state or direct release-helper call supplies the positive proof.
    await expect(maintenance()).resolves.toBeUndefined();
    const released = attempts.requireSchedulerExecutionAttempt(coreDb, attemptId);
    expect(released).toMatchObject({ phase: 'closed', fenceRef: expect.any(String) });
    const closed = await reader.readExecution(journalRef);
    expect(closed).toMatchObject({ phase: 'closed', exclusionRefs: [] });
    expect(unknownBytes(workspace)).toEqual(originalUnknown);
    for (const step of unknownBeforeRelease) {
      expect(await reader.readLinkedInspections(step.ref)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            inspection: expect.objectContaining({
              state: 'completed',
              control: expect.objectContaining({
                kind: 'inspect-cleanup',
                outputRefs: [released.fenceRef],
              }),
            }),
          }),
        ])
      );
    }
    expect(store.getTurnById(turnId)).toEqual(failed);
    expect(store.getThread(DEMO_WORKSPACE_ID, sibling.id)).toEqual(sibling);
    const ended = await reader.readEndedSteps(journalRef);
    workspace.sqlite.close();
    await shutdownControlStoreWorkerClient();
    coreDb.sqlite.close();
    cold = openCoreDb(dataRoot);
    coldWorkspace = openWorkspaceDb(dataRoot, DEMO_WORKSPACE_ID);
    const coldReader = createExecutionStepJournalReader(coldWorkspace, journalRef.owner);
    expect(await coldReader.readExecution(journalRef)).toEqual(closed);
    expect(await coldReader.readEndedSteps(journalRef)).toEqual(ended);
    expect(unknownBytes(coldWorkspace)).toEqual(originalUnknown);
    const coldStore = new FsStore({ dataRoot });
    expect(coldStore.getTurnById(turnId)).toEqual(failed);
    const repeated = createConfiguredWorkerLifecycleRuntime({
      ...options,
      coreDb: cold,
      store: coldStore,
      env: {},
      nanoHostSessionDispatch: createFactoryNanoHostDispatch(f.effects),
      workerControlGateway: new WorkerControlGateway(),
    });
    await repeated.reconcileAcceptedFinalStatus(getWorkerBackendSession(cold, attemptId)!);
    expect(await coldReader.readExecution(journalRef)).toEqual(closed);
    expect(await coldReader.readEndedSteps(journalRef)).toEqual(ended);
    expect(unknownBytes(coldWorkspace)).toEqual(originalUnknown);
    expect(coldStore.getTurnById(turnId)).toEqual(failed);
    expect(coldStore.getThread(DEMO_WORKSPACE_ID, sibling.id)).toEqual(sibling);
    expect(f.effects).toHaveLength(effectsBeforeProof);
  });

  it.each([
    false,
    true,
  ])('continues fenced accepted-final closeout through factory maintenance (cold=%s)', async (cold) => {
    const label = `accepted_closeout_${cold}`;
    const coreDb = createFactoryCoreDb();
    const dataRoot = coreDb.dataRoot;
    const ownerUserId = ensureLocalUser(coreDb);
    const store = await createDemoStore({ dataRoot });
    recordWorkspaceOwnerMembership({ coreDb, ownerUserId, workspaceId: DEMO_WORKSPACE_ID });
    const manifest = createTestAgentSetup({
      imageRef: `sha256:${'a'.repeat(64)}`,
      requiredCapabilities: ['trusted-worker-inference-relay'],
    }).manifest;
    const configuration = createInMemoryRuntimeConfigSnapshot({
      ...loadRuntimeConfig(dataRoot),
      agentManifests: [manifest],
      gatewayConfig: createTestGatewayConfig(),
      providerRegistry: new ProviderRegistry([
        {
          id: 'agent-openrouter',
          displayName: 'Resident fixture',
          kind: 'local',
          models: ['openai/gpt-5.2'],
        },
      ]),
    });
    const options = { readRuntimeConfig: () => configuration };
    let f = createNativeTaskAdmissionFixture(coreDb, store, options);
    let original: Awaited<ReturnType<typeof f.admitTurn>> | undefined;
    // Join native work and stop its sole peer before closing the caller-owned Core.
    onTestFinished(async () => {
      await original?.cleanup();
      await f.restore();
      await shutdownControlStoreWorkerClient();
      coreDb.sqlite.close();
    });
    const attemptId = testEntityId('attempt', `lease_${label}`);
    const agentSessionId = testEntityId('as', `as_${label}`);
    const entry = createSchedulerAdmissionEntry(coreDb, {
      backendId: 'nanohost',
      queueEntryId: `queue:${attemptId}`,
      requestId: testEntityId('tu', `request_${label}`).slice(3),
      requestedAgentId: manifest.id,
      workspaceId: DEMO_WORKSPACE_ID,
      threadId: DEMO_THREAD_ID,
      turnId: testEntityId('tu', `turn_${label}`),
      turnInput: 'Complete the original resident Turn',
      triggerActor: { kind: 'user', id: ownerUserId },
    });
    await publishFactoryAdmission(store, entry);
    original = await f.admitTurn(entry, {
      attemptId,
      agentSessionId,
      candidateAgentSessionId: agentSessionId,
    });
    await original.complete();
    const pkg = original.pkg;
    const completed = store.getTurnById(pkg.scope.turnId);
    expect(completed.status).toBe('completed');
    if (cold) {
      await original.cleanup();
      await f.restore();
      f = createNativeTaskAdmissionFixture(coreDb, store, options, f.outside);
    }
    const runtime = f.runtime;
    const backend = (runtime.turnExecutor as WorkerGovernanceTurnExecutor).executionBackend;
    const anchor = getWorkerBackendSession(coreDb, attemptId)!;
    const target = getNanoHostRuntimeTarget(coreDb, anchor.runtimeTargetId);
    if (!target) throw new Error('The original native runtime target is missing.');
    expect(anchor.state).toBe('cleaned');
    coreDb.sqlite
      .prepare(
        `UPDATE scheduler_execution_attempts SET phase = 'closing', fence_ref = NULL, terminal_cause = 'worker-final-status', outcome_ref = ? WHERE attempt_id = ?`
      )
      .run(`turn:${pkg.scope.turnId}:completed`, attemptId);
    coreDb.sqlite.exec(`UPDATE sandbox_runtime_records SET lifecycle_state = 'failed', health_state = 'unknown', drain_state = 'draining', cleanup_state = 'unknown';
      UPDATE harness_instance_records SET lifecycle_state = 'failed', drain_state = 'draining'`);
    const storage = getWorkerStorageBindingForSandbox(coreDb, {
      sandboxBindingRef: anchor.sandboxBindingRef,
    })!;
    const beforeEffects = f.effects.length;
    const recovery = {
      executionBackend: backend,
      store,
      cleanupBackendSession: runtime.cleanupBackendSession,
      reconcileExecutions: () => runtime.executionReconciler.runOnce(),
      prepareBackendCleanup: runtime.prepareBackendCleanup,
      restoreBackendSession: runtime.restoreBackendSession,
      reconcileAcceptedFinalStatus: runtime.reconcileAcceptedFinalStatus,
      projectRecoveredTurn: async () => ({ status: 'completed' as const }),
    };
    const assertFence = () => {
      expect(attempts.requireSchedulerExecutionAttempt(coreDb, attemptId)).toMatchObject({
        phase: 'closing',
        terminalCause: 'worker-final-status',
      });
      expect(
        coreDb.sqlite.prepare('SELECT cleanup_state FROM sandbox_runtime_records').get()
      ).toEqual({ cleanup_state: 'unknown' });
      expect(getWorkerStorageBinding(coreDb, { storageRef: storage.storageRef })).toEqual(storage);
      expect(f.effects).toHaveLength(beforeEffects);
    };
    const keepFence = async () => {
      await expect(runNanoHostAttemptRecoveryMaintenance(coreDb, recovery)).rejects.toThrow(
        'Native attempt recovery failed'
      );
      assertFence();
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ticks: Array<() => void> = [];
    const nativeMaintenance = vi.fn(() => runNanoHostAttemptRecoveryMaintenance(coreDb, recovery));
    const checkpoints = vi.fn(async () => {});
    const service = startSchedulerAttemptMaintenanceService({
      intervalMs: 30_000,
      runRecoveryMaintenance: { scheduler: async () => {}, native: nativeMaintenance, checkpoints },
      setInterval: (tick) => {
        ticks.push(tick);
        return 'closeout-timer';
      },
      clearInterval: () => {},
    });
    try {
      for (let pass = 0; pass < 2; pass += 1) {
        if (pass > 0) ticks[0]!();
        await expect(service.runOnce()).rejects.toThrow('Scheduler recovery maintenance failed');
        await new Promise<void>((resolve) => setImmediate(resolve));
        assertFence();
        expect(nativeMaintenance).toHaveBeenCalledTimes(pass + 1);
        expect(checkpoints).toHaveBeenCalledTimes(pass + 1);
        expect(warn.mock.calls.map(([text]) => JSON.parse(String(text)).attributes)).toEqual(
          Array.from({ length: pass + 1 }, () =>
            expect.objectContaining({
              'openkit.error.code': 'scheduler.native_attempt_recovery_failed',
              'openkit.attempt.id': attemptId,
              'openkit.turn.id': pkg.scope.turnId,
            })
          )
        );
      }
      const successor = allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
        targetId: anchor.runtimeTargetId,
        identityId: target.identityId,
        deploymentId: anchor.deploymentId,
        observedAt: '2026-10-08T00:01:00.000Z',
      });
      upsertNanoHostRuntimeTarget(coreDb, {
        ...successor,
        predecessorFenced: true,
        ready: true,
        freshEmpty: true,
        physicalEpoch: 'a'.repeat(64),
        observedAt: '2026-10-08T00:01:01.000Z',
      });
      await keepFence();
      // The former physical Epoch's peer is gone before its retained Integration is retired.
      await f.restore();
      coreDb.sqlite
        .prepare(
          'UPDATE nanohost_runtime_targets SET physical_epoch = ?, ready = 0, fresh_empty = 0, predecessor_fenced = 0'
        )
        .run('b'.repeat(64));
      const beforeContradictoryWarnings = warn.mock.calls.length;
      ticks[0]!();
      await expect(service.runOnce()).rejects.toThrow('Scheduler recovery maintenance failed');
      await new Promise<void>((resolve) => setImmediate(resolve));
      assertFence();
      expect(nativeMaintenance).toHaveBeenCalledTimes(3);
      expect(checkpoints).toHaveBeenCalledTimes(3);
      expect(
        warn.mock.calls
          .slice(beforeContradictoryWarnings)
          .map(([text]) => JSON.parse(String(text)).attributes['openkit.error.code'])
      ).toEqual([
        'scheduler.native_attempt_recovery_failed',
        'scheduler.native_recovery_stage_failed',
        'scheduler.attempt_maintenance_failed',
      ]);
      coreDb.sqlite.exec('UPDATE nanohost_runtime_targets SET ready = 1, fresh_empty = 1');
      await keepFence();
      coreDb.sqlite.exec('UPDATE nanohost_runtime_targets SET predecessor_fenced = 1');
      const actualRelease = backend.release.bind(backend);
      vi.spyOn(backend, 'release').mockImplementation(async (input) => {
        const result = await actualRelease(input);
        if (result.state === 'released') {
          expect(
            coreDb.sqlite.prepare('SELECT 1 FROM sandbox_runtime_records').get()
          ).toBeUndefined();
          expect(getWorkerStorageBinding(coreDb, { storageRef: storage.storageRef })).toMatchObject(
            { state: 'idle', revision: storage.revision + 1, currentSandboxBindingRef: null }
          );
          expect(attempts.requireSchedulerExecutionAttempt(coreDb, attemptId).phase).toBe(
            'closing'
          );
        }
        return result;
      });
      const beforeFreshProofWarnings = warn.mock.calls.length;
      ticks[0]!();
      await expect(service.runOnce()).resolves.toBeUndefined();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(nativeMaintenance).toHaveBeenCalledTimes(4);
      expect(checkpoints).toHaveBeenCalledTimes(4);
      expect(warn.mock.calls).toHaveLength(beforeFreshProofWarnings);
      expect(attempts.requireSchedulerExecutionAttempt(coreDb, attemptId)).toMatchObject({
        phase: 'closed',
        terminalCause: 'worker-final-status',
        fenceRef: expect.any(String),
      });
      expect(new FsStore({ dataRoot: coreDb.dataRoot }).getTurnById(pkg.scope.turnId)).toEqual(
        completed
      );
      expect(f.effects).toHaveLength(beforeEffects);
      const next = completeNanoHostPackage({
        scope: {
          ...pkg.scope,
          agentSessionId: testEntityId('as', `as_next_${label}`),
          turnId: testEntityId('tu', `turn_next_${label}`),
        },
        snapshotId: `snapshot_next_${label}`,
      });
      await authorizeNanoHostPackage(coreDb, next);
      // Model only the new Epoch's materialization effects after the old peer has stopped.
      const fresh = createConfiguredWorkerLifecycleRuntime({
        coreDb,
        env: {},
        nanoHostSessionDispatch: createFactoryNanoHostDispatch(f.effects),
        workerControlGateway: new WorkerControlGateway(),
      });
      const native = (fresh.turnExecutor as WorkerGovernanceTurnExecutor).executionBackend;
      await anchorNanoHostMaterialization(coreDb, native, next);
      await expect(
        native.materialize(next, {
          sandboxBindingRef: factoryPackageBinding(coreDb, next),
          workspaceRoots: [],
        })
      ).resolves.toMatchObject({ packageSnapshotId: next.snapshotId });
      expect(f.effects.slice(beforeEffects).map((effect) => effect.kind)).toEqual([
        'image.acquire',
        'image.inspect',
        'sandbox.create',
      ]);
    } finally {
      await service.stop();
      vi.restoreAllMocks();
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

/** Establishes a positively fenced predecessor, using the native release owner when the fixture has live backend handles. */
async function closeFactoryAttempt(
  db: ReturnType<typeof openCoreDb>,
  attemptId: string,
  outcomeRef: string | null = null,
  releaseOwner: Pick<WorkerGovernanceBackend, 'release'> = new SimulatedTurnExecutor({ coreDb: db })
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
  const released = await releaseOwner.release({
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
async function publishFactoryAdmission(
  store: FsStore,
  entry: ReturnType<typeof createSchedulerAdmissionEntry>
) {
  const createdAt = new Date().toISOString();
  const scope = {
    workspaceId: entry.workspaceId,
    threadId: entry.threadId,
    actorId:
      entry.triggerActor.kind === 'user'
        ? entry.triggerActor.id
        : entry.triggerActor.responsibleUserId!,
  };
  await store.createTurn(
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
      commandReceipt: {
        key: commandRequestKey('turn.start', entry.requestId, scope),
        command: 'turn.start',
        requestId: entry.requestId,
        scope,
        inputHash: commandInputHash({
          queueEntryId: entry.queueEntryId,
          turnInput: entry.turnInput,
        }),
        responseKind: 'turn',
        createdAt,
        expiresAt: commandRequestExpiresAt(createdAt),
      },
    }
  );
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

// Drain and stop the native fixture owner before the next test can remove or reuse its roots.
afterEach(async () => {
  await shutdownControlStoreWorkerClient();
});

// FAILURE-SCOPE #444: retired content cannot authorize execution or poison healthy target admission.
describe('retired Workspace resident isolation', () => {
  it.each([
    'accepted',
    'delete-failed',
    'missing-package',
    'conflicting-package',
    'conflicting-recorded-work-slot',
    'retained-v1',
    'retained-v1-delete-failed',
    'retained-v1-missing-proof',
    'retained-v1-corrupt-proof',
    'retained-v1-unknown-required-feature',
    'retained-v1-conflicting-digest',
    'retained-v1-conflicting-snapshot',
    'retained-v1-conflicting-storage',
    'retained-v1-conflicting-generation',
    'retained-v1-conflicting-work-slot',
  ] as const)('preserves native proof and retained storage during same-epoch retirement: %s', async (proof) => {
    const { refuseScope, isScopeAdmitted } = await import('../bootstrap/readiness.js');
    const { openControlStoreProductReadHandle } = await import(
      '../storage/control-store-products.js'
    );
    const { getWorkspaceRegistryLifecycleFact, retireQuarantinedWorkspaceRegistry } = await import(
      '../workspace-sharing.js'
    );
    const retainedOnly = proof.startsWith('retained-v1');
    const accepted = proof === 'accepted' || proof === 'retained-v1';
    const deleteFailed = proof === 'delete-failed' || proof === 'retained-v1-delete-failed';
    const coreDb = createFactoryCoreDb();
    const dataRoot = coreDb.dataRoot;
    const ownerUserId = ensureLocalUser(coreDb);
    let store = await createDemoStore({ dataRoot });
    const retiredWorkspaceId = DEMO_WORKSPACE_ID;
    const healthy = await store.createWorkspace('Healthy retirement sibling');
    for (const workspaceId of [retiredWorkspaceId, healthy.id])
      recordWorkspaceOwnerMembership({ coreDb, workspaceId, ownerUserId });
    const healthyThread = await store.createThread(healthy.id, 'Healthy worker');
    const manifest = createTestAgentSetup({
      adapter: 'codex',
      agentId: 'agent_retired_scope',
      requiredCapabilities: ['trusted-worker-inference-relay'],
    }).manifest;
    admitTestNativeEnvironment(coreDb, manifest);
    const snapshot = createInMemoryRuntimeConfigSnapshot({
      ...loadRuntimeConfig(dataRoot),
      agentManifests: [manifest],
      gatewayConfig: createTestGatewayConfig(),
      providerRegistry: new ProviderRegistry([
        {
          id: 'agent-openrouter',
          displayName: 'Retirement fixture',
          kind: 'local',
          models: ['openai/gpt-5.2'],
        },
      ]),
    });
    let native = createNativeTaskAdmissionFixture(coreDb, store, {
      readRuntimeConfig: () => snapshot,
    });
    const joins: Array<() => Promise<void>> = [];
    /** Publishes an actual pending Turn and its receipt through the existing command test builder. */
    const admission = async (index: number, workspaceId: string, threadId: string) => {
      const attemptId = testEntityId('attempt', `failure_scope_${proof}_${index}`);
      const agentSessionId = testEntityId('as', `failure_scope_${proof}_${index}`);
      const entry = createSchedulerAdmissionEntry(coreDb, {
        backendId: 'nanohost',
        queueEntryId: `queue:${attemptId}`,
        requestId: testEntityId('tu', `failure_scope_request_${proof}_${index}`).slice(3),
        requestedAgentId: manifest.id,
        workspaceId,
        threadId,
        turnId: testEntityId('tu', `failure_scope_${proof}_${index}`),
        turnInput: 'Inspect exact retirement isolation.',
        triggerActor: { kind: 'user', id: ownerUserId },
      });
      await publishFactoryAdmission(store, entry);
      return { entry, attemptId, agentSessionId, candidateAgentSessionId: agentSessionId };
    };
    try {
      const first = await admission(1, retiredWorkspaceId, DEMO_THREAD_ID);
      const resident = await native.admitTurn(first.entry, first);
      joins.push(resident.cleanup);
      await resident.complete();
      const original = store.getAgentSession(first.agentSessionId);
      expect(original).toMatchObject({
        status: 'idle',
        nativeHandleDigest: 'a'.repeat(64),
        retainedStorage: expect.any(Object),
      });
      expect(attempts.requireSchedulerExecutionAttempt(coreDb, first.attemptId).phase).toBe(
        'closed'
      );
      let alternateWorkSlotRef: string | undefined;
      let alternateContributorRef: string | undefined;
      if (proof === 'conflicting-recorded-work-slot') {
        const contributorThread = await store.createThread(
          retiredWorkspaceId,
          'Eligible alternative storage contributor'
        );
        const attached = getWorkerStorageBinding(coreDb, original.retainedStorage!)!;
        const shared = storageOwners.admitWorkerStorageContributor(coreDb, {
          authorizeContributor: (contributor) =>
            contributor.workspaceId === retiredWorkspaceId &&
            contributor.responsibleUserId === ownerUserId,
          expectedRevision: attached.revision,
          layout: attached.layout,
          purpose: 'work',
          responsibleUserId: ownerUserId,
          storageRef: attached.storageRef,
          threadId: contributorThread.id,
          workspaceId: retiredWorkspaceId,
        });
        const alternate = shared.contributors.find(
          (contributor) => contributor.threadId === contributorThread.id
        )!;
        alternateContributorRef = alternate.contributorRef;
        alternateWorkSlotRef = alternate.workSlotRef;
        expect(alternateWorkSlotRef).not.toBe(original.retainedStorage!.workSlotRef);
      }
      let storageBefore = getWorkerStorageBinding(coreDb, original.retainedStorage!)!;
      const anchorBefore = getWorkerBackendSession(coreDb, first.attemptId)!;
      const targetBefore = recordTestNativeRuntimeTarget(coreDb);
      expect(anchorBefore.originPhysicalEpoch).toBe(targetBefore.physicalEpoch);
      const snapshotPath = join(
        dataRoot,
        'workspaces',
        retiredWorkspaceId,
        'runtime/agent-sessions',
        original.id,
        'aep-snapshots',
        `${resident.pkg.snapshotId}.json`
      );
      const acceptedBytes = readFileSync(snapshotPath);
      const second = await admission(2, healthy.id, healthyThread.id);
      // Fault injection follows a complete native Turn and acknowledged proof; it cannot create a fixture record.
      if (proof === 'missing-package') rmSync(snapshotPath);
      if (proof === 'conflicting-package') {
        const retained = JSON.parse(acceptedBytes.toString('utf8'));
        retained.snapshot.scope.threadId = healthyThread.id;
        retained.contentDigest = createHash('sha256')
          .update(JSON.stringify(retained.snapshot))
          .digest('hex');
        writeFileSync(snapshotPath, JSON.stringify(retained));
      }
      if (proof === 'conflicting-recorded-work-slot') {
        // Continuity Decision: contributor eligibility cannot replace the exact accepted attachment.
        // Named corruption fault: align an existing contributor with the altered historical slot.
        // All recorded Thread/storage joins then agree; only the accepted AEP proves the mismatch.
        const accepted = JSON.parse(acceptedBytes.toString('utf8'));
        expect(accepted.contentDigest).toBe(
          createHash('sha256').update(JSON.stringify(accepted.snapshot)).digest('hex')
        );
        expect(accepted.snapshot.extensions.openkit.workerStorage.workSlotRef).toBe(
          original.retainedStorage!.workSlotRef
        );
        await shutdownControlStoreWorkerClient();
        const contributorChanged = coreDb.sqlite
          .prepare(
            'UPDATE worker_storage_contributors SET thread_id = ? WHERE contributor_ref = ? AND storage_ref = ? AND attachment_generation = ?'
          )
          .run(
            original.threadId,
            alternateContributorRef!,
            original.retainedStorage!.storageRef,
            original.retainedStorage!.attachmentGeneration
          );
        expect(contributorChanged.changes).toBe(1);
        const damaged = openWorkspaceDb(dataRoot, retiredWorkspaceId);
        try {
          const changed = damaged.sqlite
            .prepare(
              "UPDATE control_agent_sessions SET record_json = json_set(record_json, '$.retainedStorage.workSlotRef', ?) WHERE id = ?"
            )
            .run(alternateWorkSlotRef!, original.id);
          expect(changed.changes).toBe(1);
        } finally {
          damaged.sqlite.close();
        }
        const corruptedSession = store.getAgentSession(original.id);
        expect(corruptedSession.retainedStorage).toEqual({
          ...original.retainedStorage,
          workSlotRef: alternateWorkSlotRef,
        });
        storageBefore = getWorkerStorageBinding(coreDb, original.retainedStorage!)!;
        expect(storageBefore.contributors).toContainEqual(
          expect.objectContaining({
            attachmentGeneration: corruptedSession.retainedStorage!.attachmentGeneration,
            contributorRef: alternateContributorRef,
            responsibleUserId: ownerUserId,
            storageRef: corruptedSession.retainedStorage!.storageRef,
            threadId: corruptedSession.threadId,
            workspaceId: corruptedSession.workspaceId,
            workSlotRef: corruptedSession.retainedStorage!.workSlotRef,
          })
        );
        expect(readFileSync(snapshotPath)).toEqual(acceptedBytes);
      }
      const recordedBeforeRetirement = store.getAgentSession(original.id);
      const sessionPath = join(dirname(snapshotPath), '..', 'session.json');
      if (retainedOnly) {
        // DIAG-444A2: model pre-native retained data only after real owners accept the ready proof.
        // Preserve the original V1 payload; older attachment metadata has no historical generation.
        const retained = StoredAgentSessionV1Schema.parse({
          ...original,
          schemaVersion: 1,
          retainedStorage: {
            storageRef: original.retainedStorage!.storageRef,
            workSlotRef: original.retainedStorage!.workSlotRef,
          },
        });
        if (proof === 'retained-v1-conflicting-digest')
          retained.nativeHandleDigest = 'b'.repeat(64);
        if (proof === 'retained-v1-conflicting-snapshot')
          retained.environmentPackageSnapshotId = 'conflicting-original-snapshot';
        if (proof === 'retained-v1-conflicting-storage')
          retained.retainedStorage!.storageRef = testEntityId(
            'wst',
            'unrelated_retirement_storage'
          );
        if (proof === 'retained-v1-conflicting-generation')
          retained.retainedStorage!.attachmentGeneration =
            original.retainedStorage!.attachmentGeneration! + 1;
        if (proof === 'retained-v1-conflicting-work-slot')
          retained.retainedStorage!.workSlotRef = 'unrelated-retirement-slot';
        if (proof !== 'retained-v1-missing-proof')
          writeFileSync(
            sessionPath,
            proof === 'retained-v1-corrupt-proof'
              ? '{'
              : JSON.stringify(
                  // Contract Evolution: required semantics must be checked before normalization.
                  proof === 'retained-v1-unknown-required-feature'
                    ? { ...retained, requiredFeatures: ['unsupported-cleanup-semantics'] }
                    : retained
                )
          );
      }
      const sessionBytes = existsSync(sessionPath) ? readFileSync(sessionPath) : null;
      const retainedBytes = existsSync(snapshotPath) ? readFileSync(snapshotPath) : null;
      if (retainedOnly) {
        for (const join of joins.splice(0)) await join();
        await native.restore();
        await shutdownControlStoreWorkerClient();
        // Named downgrade fault: the diagnosed owner has neither native projection after restart.
        const historical = openWorkspaceDb(dataRoot, retiredWorkspaceId);
        try {
          // Clear dependent native projections in FK order; original AEP and Core lineage stay intact.
          historical.sqlite.exec(`DELETE FROM control_work_observations;
            DELETE FROM control_product_entries;
            DELETE FROM control_turns;
            DELETE FROM control_agent_sessions;
            DELETE FROM control_threads;
            DELETE FROM control_workspaces;`);
          expect(historical.sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
          expect(historical.sqlite.pragma('foreign_key_check')).toEqual([]);
          expect(historical.sqlite.prepare('SELECT id FROM control_workspaces').all()).toEqual([]);
          expect(historical.sqlite.prepare('SELECT id FROM control_agent_sessions').all()).toEqual(
            []
          );
        } finally {
          historical.sqlite.close();
        }
      }
      refuseScope(dataRoot, { scope: 'workspace', id: retiredWorkspaceId, check: 'recovery' });
      const registry = getWorkspaceRegistryLifecycleFact(coreDb, retiredWorkspaceId)!;
      coreDb.sqlite.transaction(() =>
        retireQuarantinedWorkspaceRegistry({
          coreDb,
          workspaceId: retiredWorkspaceId,
          expectedRegistryRevision: registry.registryRevision,
        })
      )();
      refuseScope(dataRoot, { scope: 'workspace', id: retiredWorkspaceId, check: 'retired' });
      if (retainedOnly) {
        store = new FsStore({ dataRoot });
        // Terminal replay hydration has its own Main clock; no native work runs in this read window.
        vi.useFakeTimers({ toFake: ['Date'] });
        try {
          vi.setSystemTime(vi.getRealSystemTime() + attempts.EXECUTION_ATTEMPT_BUDGET_MS);
          const originalAttempt = attempts.requireSchedulerExecutionAttempt(
            coreDb,
            first.attemptId
          );
          expect(originalAttempt.phase).toBe('closed');
          expect(Date.parse(originalAttempt.deadline!)).toBeLessThanOrEqual(Date.now());
          native = createNativeTaskAdmissionFixture(
            coreDb,
            store,
            {
              readRuntimeConfig: () => snapshot,
            },
            native.outside
          );
        } finally {
          vi.useRealTimers();
        }
      }
      const effectsBefore = [...native.effects];
      const sandboxId = effectsBefore.find((effect) => effect.kind === 'sandbox.create')!.input
        .sandboxId;
      let deleteObserved = false;
      const push = native.outside.effects.push.bind(native.outside.effects);
      const physicalPeer = vi
        .spyOn(native.outside.effects, 'push')
        .mockImplementation((...requests) => {
          const count = push(...requests);
          for (const request of requests)
            if (request.kind === 'sandbox.delete') {
              deleteObserved = true;
              // No Host result exists yet: the old writer must still own its attachment and capacity.
              expect(
                getWorkerStorageBinding(coreDb, original.retainedStorage!)!.currentSandboxBindingRef
              ).not.toBeNull();
              expect(request.input).toMatchObject({
                sandboxId,
                leaseId: first.attemptId,
                packageSnapshotId: resident.pkg.snapshotId,
                backendSessionId: anchorBefore.backendSessionId,
              });
              if (deleteFailed) throw new Error('Outside peer cannot prove physical deletion.');
            }
          return count;
        });
      const newCommands: harnessRecords.NanoHostHarnessCommand[] = [];
      const accept = native.runtime.acceptNanoHostHarnessCommand;
      const observe = vi
        .spyOn(native.runtime, 'acceptNanoHostHarnessCommand')
        .mockImplementation(async (request) => {
          const command = await accept(request);
          newCommands.push(command);
          return command;
        });
      // Accepted ruling: a non-admitted owner must never enter the writing default recorder.
      const recorder = vi.spyOn(native.executor, 'recordNativeHandleDigest');
      const capacityLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        if (
          retainedOnly &&
          (accepted || deleteFailed || proof === 'retained-v1-unknown-required-feature')
        ) {
          const backend = (native.runtime.turnExecutor as WorkerGovernanceTurnExecutor)
            .executionBackend!;
          const desired = {
            ...resident.pkg,
            scope: {
              ...resident.pkg.scope,
              workspaceId: healthy.id,
              threadId: healthyThread.id,
              agentSessionId: second.agentSessionId,
              turnId: second.entry.turnId,
            },
          };
          if (proof === 'retained-v1-unknown-required-feature')
            await expect(backend.inspectMaterializationCapacity!(desired)).rejects.toThrow();
          else
            await expect(backend.inspectMaterializationCapacity!(desired)).resolves.toBe(
              'available'
            );
          expect(native.effects).toEqual(effectsBefore);
          expect(getWorkerStorageBinding(coreDb, original.retainedStorage!)).toEqual(storageBefore);
          expect(getWorkerBackendSession(coreDb, first.attemptId)).toEqual(anchorBefore);
          expect(recorder.mock.calls.some(([, id]) => id === original.id)).toBe(false);
        }
        if (accepted) {
          // Scheduling Scale Completion/Release: same Epoch is residency, never an absence proof.
          const admitted = await native.admitTurn(second.entry, second);
          joins.push(admitted.cleanup);
          await admitted.complete();
          const cleanup = native.effects
            .slice(effectsBefore.length)
            .find((effect) => effect.kind === 'sandbox.delete');
          expect(cleanup).toBeDefined();
          expect(deleteObserved).toBe(true);
          expect(cleanup!.input).toMatchObject({
            sandboxId,
            leaseId: first.attemptId,
            packageSnapshotId: resident.pkg.snapshotId,
            backendSessionId: anchorBefore.backendSessionId,
          });
          expect(recordTestNativeRuntimeTarget(coreDb).physicalEpoch).toBe(
            targetBefore.physicalEpoch
          );
          expect(store.getTurnById(second.entry.turnId).status).toBe('completed');
          const preserved = getWorkerStorageBinding(coreDb, original.retainedStorage!)!;
          expect(preserved).toMatchObject({
            storageRef: storageBefore.storageRef,
            state: 'idle',
            currentSandboxBindingRef: null,
          });
          expect(preserved.targets).toEqual(storageBefore.targets);
        } else {
          // Missing/contradictory accepted authority cannot grant capacity or a replacement execution.
          await expect(native.admitTurn(second.entry, second)).rejects.toThrow();
          if (deleteFailed) {
            expect(deleteObserved).toBe(true);
            expect(
              native.effects
                .slice(effectsBefore.length)
                .some((effect) => effect.kind === 'sandbox.create')
            ).toBe(false);
            expect(
              getWorkerStorageBinding(coreDb, original.retainedStorage!)!.currentSandboxBindingRef
            ).not.toBeNull();
          } else {
            expect(deleteObserved).toBe(false);
            expect(native.effects).toEqual(effectsBefore);
            expect(getWorkerBackendSession(coreDb, first.attemptId)).toEqual(anchorBefore);
            expect(getWorkerStorageBinding(coreDb, original.retainedStorage!)).toEqual(
              storageBefore
            );
          }
          expect(newCommands.some((command) => command.operation === 'turn.start')).toBe(false);
          if (retainedOnly && !deleteFailed) {
            const failure = capacityLog.mock.calls
              .map(([entry]) => JSON.parse(String(entry)))
              .find((entry) => entry.event === 'worker.admission.capacity-inspection-failed');
            // The accepted diagnostic ruling requires finite causes, without exception text or paths.
            expect(failure).toMatchObject({
              causeCode:
                proof === 'retained-v1-unknown-required-feature'
                  ? expect.stringMatching(
                      /^retiring-proof-handoff\/(missing-proof|lineage-conflict|owner-discovery-refused)$/
                    )
                  : proof === 'retained-v1-missing-proof' || proof === 'retained-v1-corrupt-proof'
                    ? 'retiring-proof-handoff/missing-proof'
                    : 'retiring-proof-handoff/lineage-conflict',
            });
          }
        }
        expect(recorder.mock.calls.some(([, id]) => id === original.id)).toBe(false);
        expect(
          newCommands.some(
            (command) =>
              ['session.open', 'turn.start'].includes(command.operation) &&
              command.body.agentSessionId === original.id
          )
        ).toBe(false);
        // Read-only owner observation proves retained native provenance; it grants no executable admission.
        const retainedReader = openControlStoreProductReadHandle(
          join(dataRoot, 'workspaces', retiredWorkspaceId, 'db', 'workspace.sqlite'),
          { kind: 'workspace', workspaceId: retiredWorkspaceId }
        );
        try {
          if (retainedOnly) {
            // Cleanup-only reads must not resurrect native or executable authority.
            expect(retainedReader.get('workspace', retiredWorkspaceId)).toBeUndefined();
            expect(retainedReader.get('agent-session', original.id)).toBeUndefined();
          } else if (proof === 'conflicting-recorded-work-slot') {
            expect(retainedReader.get('agent-session', original.id)!.record).toMatchObject({
              nativeHandleDigest: original.nativeHandleDigest,
              retainedStorage: recordedBeforeRetirement.retainedStorage,
              environmentPackageSnapshotId: original.environmentPackageSnapshotId,
            });
          } else {
            expect(retainedReader.get('agent-session', original.id)!.record).toMatchObject({
              nativeHandleDigest: original.nativeHandleDigest,
              retainedStorage: original.retainedStorage,
              environmentPackageSnapshotId: original.environmentPackageSnapshotId,
            });
          }
        } finally {
          retainedReader.close();
        }
        expect(isScopeAdmitted(dataRoot, 'workspace', retiredWorkspaceId)).toBe(false);
        expect(() => store.getWorkspace(retiredWorkspaceId)).toThrow(
          expect.objectContaining({ code: 'recovery_required' })
        );
        await expect(
          store.createThread(retiredWorkspaceId, 'Must remain retired')
        ).rejects.toMatchObject({ code: 'recovery_required' });
        expect(existsSync(snapshotPath) ? readFileSync(snapshotPath) : null).toEqual(retainedBytes);
        expect(existsSync(sessionPath) ? readFileSync(sessionPath) : null).toEqual(sessionBytes);
      } finally {
        observe.mockRestore();
        physicalPeer.mockRestore();
        recorder.mockRestore();
        capacityLog.mockRestore();
      }
    } finally {
      for (const join of joins) await join();
      await native.restore();
      await shutdownControlStoreWorkerClient();
      coreDb.sqlite.close();
    }
  }, 60_000);
});
