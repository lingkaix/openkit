// openkit-test-platform: posix
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  CapabilityUsageResponseSchema,
  KnowledgeManagerDraftProposalResponseSchema,
  ListThreadItemsResponseSchema,
  ListWorkspaceAuditEventsResponseSchema,
  ListWorkspaceEvidenceBundlesResponseSchema,
  ListWorkspaceRuntimeEvidenceResponseSchema,
  type WorkspaceInputSnapshot,
  type WorkspaceMaterializationRecord,
} from '@openkit/app-api-schemas';
import type {
  AgentEnvironmentPackage,
  AgentEnvironmentValidationDiagnostic,
  WorkerGovernanceBackendCapabilities,
} from '@openkit/config-schema';
import {
  materializeWorkspaceRoots,
  validateAgentEnvironmentPackageForBackend,
} from '@openkit/config-schema';
import type { ActorRef } from '@openkit/protocol';
import { RequestIdSchema } from '@openkit/protocol';
import {
  buildWorkerCanonicalTerminalEventRecord,
  type WorkerCanonicalEventRecord,
  WorkerCanonicalEventRecordSchema,
  type WorkerLineage,
  type WorkerRuntimeNativeOriginIndexEntry,
  WorkerRuntimeNativeOriginIndexEntrySchema,
  type WorkerRuntimeRawStreamManifest,
  WorkerRuntimeRawStreamManifestSchema,
} from '@openkit/worker-protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SandboxIntegrationClient } from '../../../../packages/worker-shim/src/integration-client.js';
import { runResidentTurn } from '../../../../packages/worker-shim/src/turn.js';
import { createApp, createDefaultWorkerControlGateway } from '../app.js';
import { getArtifactReview } from '../artifact-reviews.js';
import {
  createOpenKitAccessTokenRecord,
  revokeOpenKitAccessTokenRecord,
} from '../auth/access-token-store.js';
import { ensureLocalUser } from '../auth/identity.js';
import * as operationAuthorizer from '../auth/operation-authorizer.js';
import { disableCanonicalUser } from '../auth/user-lifecycle.js';
import { finishCapabilityCall, startCapabilityCall } from '../capability/usage-ledger.js';
import { readStrictWorkerContextPackageDigest } from '../context/worker-context-projection.js';
import { listWorkspaceEvidenceBundles } from '../evidence-bundles.js';
import { FsStore } from '../lib/store.js';
import type {
  LLMGatewayDispatchContext,
  LLMGatewayProviderDispatcher,
} from '../llm/provider-dispatcher.js';
import { ProviderRegistry } from '../providers/registry.js';
import { createSchedulerAdmissionEntry } from '../scheduler-records.js';
import { type CoreDb, openCoreDb, openWorkspaceDb, type WorkspaceDb } from '../storage/db.js';
import { LOCAL_USER_ID, workspaceDbPath } from '../storage/fs-layout.js';
import { retrieveWorkspaceKnowledge } from '../storage/index-rebuild.js';
import {
  applyMigrations as applyCoreMigrations,
  applyScopedMigrations,
} from '../storage/migrate.js';
import {
  createTestAgentSetup,
  createTestGatewayConfig,
} from '../test-support/agent-environment.js';
import { createAppWithWorkspaceAuthority } from '../test-support/app.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { recordTestExecutionAttempt } from '../test-support/execution-attempt.js';
import { seedWritableGitRepository } from '../test-support/git-repository.js';
import { knowledgeOperationRequest } from '../test-support/knowledge-operation.js';
import { recordTestNativeRuntimeTarget } from '../test-support/native-environment.js';
import { operationRequest } from '../test-support/operation-request.js';
import { resolveAgentEnvironmentPackage } from '../test-support/prepared-agent-environment.js';
import { recordTestWorkspaceReviewMaterialization } from '../test-support/workspace-sync.js';
import { createVaultGrant } from '../vault/vault-grants.js';
import { createVaultReference } from '../vault/vault-references.js';
import { createVaultUnlockState } from '../vault/vault-unlock-state.js';
import { listVaultUseRecords } from '../vault/vault-use-records.js';
import { listVaultInjectionPlans } from '../vault-injection-plans.js';
import { listVaultInjectionReceipts } from '../vault-injection-receipts.js';
import {
  bindThreadMaterial,
  createWorkspaceMaterial,
  saveWorkspaceMaterialRevision,
  selectQueuedThreadMaterialRevision,
} from '../workspace-materials.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import {
  WORKSPACE_MUTATION_LATE_PUBLISHERS,
  WorkspaceMutationAdmission,
} from '../workspace-mutation-admission.js';
import * as snapshotLedger from './aep-snapshot-ledger.js';
import { requireAgentEnvironmentPackageSnapshot } from './aep-snapshot-ledger.js';
import { DeterministicAgentPreparationError } from './agent-preparation-error.js';
import * as attempts from './execution-attempt-records.js';
import { commandInputHash } from './idempotent-command.js';
import {
  acceptNanoHostAttemptHeartbeat,
  bindNanoHostAttemptRouteTokenHashes,
  requireNanoHostExecutionAttempt,
} from './nanohost-attempt-records.js';
import { runNanoHostAttemptRecoveryMaintenance } from './nanohost-attempt-recovery.js';
import { createNanoHostEffectRequest } from './nanohost-effect-identity.js';
import {
  dispatchNanoHostHarnessOperation,
  settleNanoHostHarnessOperation,
} from './nanohost-harness-records.js';
import {
  allocateNanoHostRuntimeTargetConnectionGeneration,
  getNanoHostRuntimeTarget,
  upsertNanoHostRuntimeTarget,
} from './nanohost-runtime-target.js';
import type { NanoHostSessionEffectRequest } from './nanohost-session-dispatch.js';
import { dispatchOpenkitWorkTool } from './openkit-work-mcp.js';
import { TurnStartValidationError } from './orchestrator.js';
import {
  answerPendingRequest,
  freezeReadyOutcomes,
  frozenPendingOutcomeInput,
  raisePendingRequest,
} from './pending-requests.js';
import { listWorkspaceRuntimeEvidence } from './runtime-evidence.js';
import { runSchedulerDispatchLoop } from './scheduler-dispatch-loop.js';
import { runSchedulerRecoveryMaintenance } from './scheduler-restart-recovery.js';
import { createConfiguredWorkerLifecycleRuntime } from './turn-executor-factory.js';
import { getWorkerBackendSession } from './worker-backend-sessions.js';
import {
  clearWorkerCheckpoint,
  createWorkerCheckpointContextDiagnostics,
  getWorkerCheckpoint,
  upsertWorkerCheckpoint,
} from './worker-checkpoints.js';
import { WorkerControlGateway } from './worker-control-gateway.js';
import {
  getWorkerControlAcceptedFinalStatus,
  recordWorkerControlAcceptedRecord,
  waitForWorkerControlFinalStatus,
} from './worker-control-records.js';
import type {
  WorkerGovernanceBackend,
  WorkerGovernanceEvidenceRecord,
  WorkerGovernanceMaterializationRecord,
  WorkerGovernanceWorkspaceChangeRecord,
} from './worker-governance-backend.js';
import {
  WORKER_ARTIFACT_COLLECTION_INVALID,
  WORKER_ARTIFACT_RECOVERY_REQUIRED,
  WorkerGovernanceCapacityUnavailableError,
  WorkerNativeProofValidationError,
} from './worker-governance-backend.js';
import {
  prepareWorkerTurnContextPackage,
  WorkerGovernanceTurnExecutor,
} from './worker-governance-turn-executor.js';
import {
  createWorkerRuntimeOriginRef,
  type ImportWorkerRuntimeProvenanceInput,
  importWorkerRuntimeProvenance,
} from './worker-runtime-provenance.js';
import {
  createWorkerStorageBinding,
  getWorkerStorageBinding,
  releaseWorkerStorageAttachment,
  reserveWorkerStorageAttachment,
  workerStorageDefaultWorkSlotRef,
} from './worker-storage-bindings.js';
import type { WorkerTranscriptPayload } from './worker-transcript.js';
import { terminalizeGovernedWorkerTurn } from './worker-turn-failure.js';
import { getFilesystemWorkspaceStagingRoot } from './workspace-filesystem-staging.js';
import {
  acceptWorkspaceBaseline,
  acceptWorkspaceCapture,
  authorizeWorkspaceBaselineInitialization,
} from './workspace-snapshot-chain.js';
import {
  listBackendWorkspaceHandles,
  listWorkspaceChangeSets,
  listWorkspaceInputSnapshots,
  listWorkspaceMaterializationRecords,
  listWorkspaceSyncReviews,
} from './workspace-sync-records.js';

const TURN_ROOT_NATIVE_ID = '019f1000-0000-7000-8000-000000000001';
const TURN_CHILD_NATIVE_ID = '019f1000-0000-7000-8000-000000000002';
const TURN_CHILD_B_NATIVE_ID = '019f1000-0000-7000-8000-000000000003';
const TURN_NATIVE_SESSION_ID = '019f1000-0000-7000-8000-000000000010';
const TURN_CHILD_RAW_MESSAGE = 'private child raw answer must not become a canonical item';

/** Applies Core migrations plus the Demo Workspace authority shared by this executor fixture. */
function applyMigrations(coreDb: CoreDb): void {
  applyCoreMigrations(coreDb);
  ensureLocalUser(coreDb);
  recordWorkspaceOwnerMembership({
    coreDb,
    ownerUserId: LOCAL_USER_ID,
    workspaceId: 'ws_demo',
  });
}

/**
 * Opens the migrated workspace database used by worker governance tests.
 *
 * @param coreDb Core database whose data root owns the workspace database.
 * @returns Migrated workspace database handle.
 */
function openTestWorkspaceDb(coreDb: CoreDb): WorkspaceDb {
  const workspaceDb = openWorkspaceDb(coreDb.dataRoot, 'ws_demo');
  applyScopedMigrations(workspaceDb);
  return workspaceDb;
}

/** Dispatches the scheduler lease that authorizes one executor fixture. */
function recordExecutorAttempt(
  coreDb: CoreDb,
  input: {
    readonly agentSessionId: string;
    readonly packageSnapshotId: string;
    readonly sandboxBindingRef: string;
    readonly threadId: string;
    readonly turnId: string;
    readonly workspaceId?: string;
    readonly requestId?: string;
    readonly turnInput?: string;
    readonly admittedAt?: string;
    readonly triggerActor?: ActorRef;
    readonly serverAdminTokenId?: string;
  }
): void {
  if (!getNanoHostRuntimeTarget(coreDb, 'runtime-target-test')) {
    const runtimeTarget = allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
      deploymentId: 'deployment_fake_executor',
      identityId: 'identity_fake_executor',
      observedAt: '2026-07-15T00:00:00.000Z',
      targetId: 'runtime-target-test',
    });
    upsertNanoHostRuntimeTarget(coreDb, {
      ...runtimeTarget,
      freshEmpty: true,
      observedAt: '2026-07-15T00:00:01.000Z',
      physicalEpoch: 'a'.repeat(64),
      predecessorFenced: true,
      ready: true,
    });
  }
  const entry = createSchedulerAdmissionEntry(coreDb, {
    backendId: 'nanohost',
    triggerActor: input.triggerActor ?? { kind: 'user', id: 'user_local' },
    ...(input.serverAdminTokenId ? { serverAdminTokenId: input.serverAdminTokenId } : {}),
    profileRef: 'profile_worker',
    queueEntryId: `queue_${input.turnId}`,
    requestId: input.requestId ?? `request:${input.turnId}`,
    requestedAgentId: 'agent_codex_host',
    threadId: input.threadId,
    turnId: input.turnId,
    turnInput: input.turnInput ?? 'Run governed worker',
    workspaceId: input.workspaceId ?? 'ws_demo',
    now: () => input.admittedAt ?? '2026-07-15T00:00:01.000Z',
  });
  recordTestExecutionAttempt(coreDb, {
    entry,
    attemptId: `lease_${input.turnId}`,
    agentSessionId: input.agentSessionId,
    inputRef: input.packageSnapshotId,
    bindingRef: input.sandboxBindingRef,
    sessionCompatibilityKey: 'fixture-compatibility',
    now: () => input.admittedAt ?? '2026-07-15T00:00:02.000Z',
  });
}

/** Starts one fixture Worker with a real admission and lease for its exact package lineage. */
function startWithExecutorAttempt(
  coreDb: CoreDb,
  executor: WorkerGovernanceTurnExecutor,
  store: FsStore,
  turn: ReturnType<FsStore['getTurnById']>,
  agentSessionId: string,
  admittedAt: string,
  input: string,
  context: NonNullable<Parameters<WorkerGovernanceTurnExecutor['startTurn']>[3]>
): Promise<void> {
  const sandboxBindingRef = `lease-binding:${turn.id}`;
  recordExecutorAttempt(coreDb, {
    admittedAt,
    agentSessionId,
    packageSnapshotId: `aepsnap_${turn.id}_${agentSessionId}`,
    sandboxBindingRef,
    threadId: turn.threadId,
    turnId: turn.id,
    triggerActor: context.triggerActor ?? turn.triggerActor,
    workspaceId: turn.workspaceId,
    requestId: context.requestId,
    turnInput: input,
  });
  return executor.startTurn(store, turn.id, input, {
    ...context,
    agentSessionId,
    attemptId: `lease_${turn.id}`,
    sandboxBindingRef,
  });
}

/**
 * Runs one Git command in a temporary test repository.
 *
 * @param cwd Repository working directory.
 * @param args Fixed Git arguments.
 * @returns Captured stdout.
 */
function runTestGit(cwd: string, args: readonly string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/**
 * Creates one worker turn with an explicit test-manifest agent assignment.
 *
 * @param store Store that owns the turn.
 * @param workspaceId Workspace that owns the turn.
 * @param threadId Thread that owns the turn.
 * @param input User-facing turn input.
 * @param turnId Optional exact Turn identity.
 * @returns Persisted turn with its exact agent assignment.
 */
function createAssignedTurn(
  store: FsStore,
  workspaceId: string,
  threadId: string,
  input: string,
  turnId?: string
) {
  const turn = store.createTurn(
    workspaceId,
    threadId,
    input,
    {
      kind: 'user',
      id: 'user_local',
    },
    null,
    turnId ? { turnId } : {}
  );
  return store.updateTurn(turn.id, {
    agentId: 'agent_codex_host',
  });
}

/**
 * Binds one running Turn and busy AgentSession to a live worker-control package.
 *
 * @param store Product store that owns the Turn and AgentSession.
 * @param gateway Shared worker-control gateway that owns the live package.
 * @param turn Running Turn to bind.
 * @param registeredTurnId Optional gateway Turn lineage used by mismatch checks.
 * @returns Bound AgentSession and package identities.
 */
function bindInterruptAttempt(
  store: FsStore,
  gateway: WorkerControlGateway,
  turn: ReturnType<typeof createAssignedTurn>,
  registeredTurnId = turn.id
): { readonly agentSessionId: string; readonly packageSnapshotId: string } {
  const agentSessionId = `as_interrupt_${turn.id}`;
  const packageSnapshotId = `aepsnap_interrupt_${turn.id}`;
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
  gateway.registerSession({
    scope: {
      agentSessionId,
      requestId: null,
      threadId: turn.threadId,
      turnId: registeredTurnId,
      workspaceId: turn.workspaceId,
    },
    snapshotId: packageSnapshotId,
  } as AgentEnvironmentPackage);
  return { agentSessionId, packageSnapshotId };
}

/**
 * Derives the expected Task worker Turn identity from one complete command scope.
 *
 * @param command Direct or Chat-subordinate Task command discriminator.
 * @param actorId Authenticated actor identity.
 * @param workspaceId Owning Workspace identity.
 * @param threadId Owning Thread identity.
 * @param requestId Outer command request identity.
 * @returns Deterministic Task worker Turn identity.
 */
function expectedTaskModeTurnId(
  command: 'conversation.submit.task' | 'task.start',
  actorId: string,
  workspaceId: string,
  threadId: string,
  requestId: string
): string {
  const suffix = commandInputHash({
    command,
    actorId,
    workspaceId,
    threadId,
    requestId,
  }).slice(-16);
  return `turn_${requestId}_${suffix}`;
}
/** Creates ordinary Task checkpoint, Material and governed Knowledge state for S39 checks. */
function createWorkerContextExecutorFixture(
  name: string,
  options: {
    readonly materialContent?: string;
    readonly maxContextTokens?: number;
    readonly turnId?: string;
    readonly workerRequest?: string;
  } = {}
) {
  const dataRoot = mkdtempSync(join(tmpdir(), `openkit-governance-context-${name}-`));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  const store = createDemoStore({ dataRoot });
  const requestId = '00000000-0000-4000-8000-000000000270';
  const turn = createAssignedTurn(
    store,
    'ws_demo',
    'th_demo',
    'Prepare worker context',
    options.turnId
  );
  const contextItemId = `it_context_${name}`;
  const maxContextTokens = options.maxContextTokens ?? 12000;
  const workerRequest =
    options.workerRequest ??
    JSON.stringify({
      schemaVersion: 1,
      objective: 'Prepare the accepted worker context.',
      acceptanceCriteria: ['The requested context is available.'],
      contextRefs: [{ kind: 'item', id: contextItemId }],
      resources: [],
      expectedArtifacts: [],
      constraints: { maxContextTokens, maxWorkerIterations: 1 },
      verification: [{ kind: 'manual', description: 'Inspect the worker context.' }],
      reviewPolicy: {
        required: true,
        reviewers: ['human'],
        instructions: 'Review the accepted context.',
      },
      escalationConditions: [],
      reviewContext: null,
    });
  store.createItem({
    completedAt: turn.startedAt,
    createdAt: turn.startedAt ?? new Date().toISOString(),
    id: contextItemId,
    status: 'completed',
    text: 'Existing Thread context.',
    threadId: turn.threadId,
    turnId: turn.id,
    type: 'assistant-message',
    workspaceId: turn.workspaceId,
  });
  const agentSessionId = `as_context_${name}`;
  const sandboxBindingRef = `lease-binding:context-${name}`;
  recordExecutorAttempt(coreDb, {
    agentSessionId,
    packageSnapshotId: `aepsnap_${turn.id}_${agentSessionId}`,
    requestId,
    sandboxBindingRef,
    threadId: turn.threadId,
    turnId: turn.id,
    turnInput: workerRequest,
  });
  const retrievalTraceId = 'krt_0190f4c8-0000-7000-8000-000000000397';
  retrieveWorkspaceKnowledge({
    caller: 'task-mode',
    dataRoot,
    limit: 5,
    pinnedConceptIds: [],
    query: 'Prepare worker context',
    traceId: retrievalTraceId,
    workspaceId: turn.workspaceId,
  });
  const workspaceDb = openTestWorkspaceDb(coreDb);
  upsertWorkerCheckpoint(workspaceDb, {
    goalId: null,
    taskId: null,
    iteration: 0,
    requestId,
    requestInputHash: commandInputHash({}),
    stage: 'preparing',
    threadId: turn.threadId,
    turnId: turn.id,
    workspaceId: turn.workspaceId,
    diagnosticsSummary: createWorkerCheckpointContextDiagnostics({
      contextDigest: commandInputHash(workerRequest),
      contextRefs: [{ kind: 'item', id: contextItemId }],
      knowledgeSelectionInput: options.workerRequest ? null : { retrievalTraceId },
      repositoryResourceId: 'repo_default',
    }),
  });
  const materialContent = options.materialContent ?? '# Exact queued context\n';
  const materialContentDigest = turnRuntimeSha256(Buffer.from(materialContent, 'utf8'));
  const material = createWorkspaceMaterial(workspaceDb, {
    acceptedAt: '2026-07-18T01:00:00.000Z',
    actorId: LOCAL_USER_ID,
    kind: 'markdown',
    requestId: `request_create_context_${name}`,
    sensitivity: 'internal',
    title: 'Context material',
  });
  const revision = saveWorkspaceMaterialRevision(workspaceDb, {
    acceptedAt: '2026-07-18T01:00:01.000Z',
    actorId: LOCAL_USER_ID,
    content: materialContent,
    contentDigest: materialContentDigest,
    expectedRevisionId: null,
    materialId: material.materialId,
    requestId: `request_save_context_${name}`,
  });
  bindThreadMaterial(workspaceDb, {
    acceptedAt: '2026-07-18T01:00:02.000Z',
    expectedBindingState: 'not_bound',
    materialId: material.materialId,
    requestId: `request_bind_context_${name}`,
    threadId: turn.threadId,
  });
  const queuedMaterial = selectQueuedThreadMaterialRevision(workspaceDb, turn.threadId);
  workspaceDb.sqlite.close();
  const packageRoot = join(
    dataRoot,
    'workspaces',
    turn.workspaceId,
    'threads',
    turn.threadId,
    'turns',
    turn.id,
    'context-package'
  );
  return {
    agentSessionId,
    contextItemId,
    coreDb,
    material,
    materialContentDigest,
    packageRoot,
    queuedMaterial,
    requestId,
    revision,
    sandboxBindingRef,
    store,
    tracePath: `${packageRoot}.json`,
    turn,
    workerRequest,
  };
}

/**
 * Prepares one direct-Task-shaped S39 checkpoint under an explicit Turn identity.
 *
 * @param name Stable isolated fixture suffix.
 * @param turnId Exact Turn identity presented to S39.
 * @returns Prepared Context Package state when S39 accepts the identity.
 */
function prepareNullKnowledgeTaskContext(name: string, turnId: string) {
  const fixture = createWorkerContextExecutorFixture(name, { turnId });
  const workspaceDb = openTestWorkspaceDb(fixture.coreDb);
  const checkpoint = getWorkerCheckpoint(
    workspaceDb,
    fixture.turn.workspaceId,
    fixture.turn.threadId,
    fixture.turn.id
  )!;
  upsertWorkerCheckpoint(workspaceDb, {
    diagnosticsSummary: null,
    goalId: null,
    iteration: checkpoint.iteration,
    requestId: checkpoint.requestId,
    requestInputHash: checkpoint.requestInputHash,
    stage: 'preparing',
    taskId: null,
    threadId: fixture.turn.threadId,
    turnId: fixture.turn.id,
    workspaceId: fixture.turn.workspaceId,
  });

  try {
    return prepareWorkerTurnContextPackage(
      fixture.coreDb,
      workspaceDb,
      fixture.store,
      getWorkerCheckpoint(
        workspaceDb,
        fixture.turn.workspaceId,
        fixture.turn.threadId,
        fixture.turn.id
      )!,
      {
        agentSessionId: 'as_context',
        requestId: fixture.requestId,
        threadId: fixture.turn.threadId,
        turnId: fixture.turn.id,
        workerRequest: fixture.workerRequest,
        workspaceId: fixture.turn.workspaceId,
      }
    );
  } finally {
    workspaceDb.sqlite.close();
    fixture.coreDb.sqlite.close();
  }
}

/**
 * Creates one isolated workspace-change ingress fixture with trusted lineage records.
 *
 * @param name Stable test-case slug used for ids and temporary roots.
 * @param strategy Workspace synchronization strategy emitted by the worker.
 * @returns Ingress dependencies and a valid baseline worker change record.
 */
function createWorkspaceChangeIngressFixture(name: string, strategy: 'git' | 'filesystem') {
  const timestamp = '2026-07-11T00:00:00.000Z';
  const requestId = '00000000-0000-4000-8000-000000000260';
  const workspaceId = 'ws_demo';
  const resourceId = 'repo';
  const reviewId = `swr_ingress_${name}`;
  const changeSetId = `wcs_ingress_${name}`;
  const inputSnapshotId = `wis_ingress_${name}`;
  const materializationRecordId = `wmr_ingress_${name}`;
  const repositoryPath = mkdtempSync(join(tmpdir(), `openkit-ingress-${name}-repository-`));
  const stagingRootPath = mkdtempSync(join(tmpdir(), `openkit-ingress-${name}-staging-`));
  const targetRootPath = mkdtempSync(join(tmpdir(), `openkit-ingress-${name}-target-`));
  const dataRoot = mkdtempSync(join(tmpdir(), `openkit-ingress-${name}-data-`));

  runTestGit(repositoryPath, ['init', '-b', 'main']);
  runTestGit(repositoryPath, ['config', 'user.email', 'repository@example.invalid']);
  runTestGit(repositoryPath, ['config', 'user.name', 'Repository User']);
  writeFileSync(join(repositoryPath, 'README.md'), '# Demo\n', 'utf8');
  runTestGit(repositoryPath, ['add', 'README.md']);
  runTestGit(repositoryPath, ['commit', '-m', 'initial']);
  const baseCommit = runTestGit(repositoryPath, ['rev-parse', 'HEAD']).trim();
  writeFileSync(join(repositoryPath, 'README.md'), '# Demo\n\nReviewed.\n', 'utf8');
  const patchText = runTestGit(repositoryPath, [
    'diff',
    '--binary',
    '--no-ext-diff',
    '--',
    'README.md',
  ]);
  writeFileSync(join(repositoryPath, 'README.md'), '# Demo\n', 'utf8');
  const patchDigest = `sha256:${createHash('sha256').update(patchText).digest('hex')}`;
  const beforeDigest = `sha256:${'1'.repeat(64)}`;
  const afterDigest = `sha256:${'2'.repeat(64)}`;
  const workspaceDb = openWorkspaceDb(dataRoot, workspaceId);
  applyScopedMigrations(workspaceDb);

  const storeDataRoot = mkdtempSync(join(tmpdir(), `openkit-ingress-${name}-store-`));
  const store = createDemoStore({ dataRoot: storeDataRoot });
  const turn = createAssignedTurn(store, workspaceId, 'th_demo', `Validate ${name}`);
  const executor = new WorkerGovernanceTurnExecutor({
    backend: new FakeWorkerGovernanceBackend(),
    createAgentSessionId: () => `as_ingress_${name}`,
    environmentBackend: {
      kind: 'openshell',
    },
    now: () => timestamp,
  });
  const environmentPackage = {
    scope: {
      requestId,
      threadId: turn.threadId,
      turnId: turn.id,
      workspaceId,
    },
  } as AgentEnvironmentPackage;
  const version =
    strategy === 'git'
      ? { commit: baseCommit, contentDigest: null }
      : { commit: null, contentDigest: beforeDigest };
  const inputSnapshot = {
    backend: { capabilitySummary: [], kind: 'openshell', label: 'OpenShell worker backend' },
    base: version,
    createdAt: timestamp,
    generatedFiles: [],
    id: inputSnapshotId,
    ignoredPaths: [],
    pathScope: [resourceId],
    resourceId,
    resourceKind: strategy === 'git' ? 'git_repository' : 'filesystem',
    strategy,
    workspaceId,
    writableRoots: [resourceId],
  } satisfies WorkspaceInputSnapshot;
  const materializationRecord = {
    backendKind: 'openshell',
    base: version,
    createdAt: timestamp,
    id: materializationRecordId,
    inputSnapshotId,
    materializedRootRef: `/workspace/${resourceId}`,
    policyDigest: `sha256:${'3'.repeat(64)}`,
    readinessEvidence: [],
    strategy,
    workerSessionId: `session_ingress_${name}`,
    workspaceId,
  } satisfies WorkspaceMaterializationRecord;
  const record = {
    changeSet: {
      artifactIds: [],
      base: version,
      bundle: null,
      changedPaths: [{ binary: false, path: 'README.md', status: 'modified' }],
      createdAt: timestamp,
      evidenceRefs: [{ kind: 'worker', ref: turn.id }],
      head:
        strategy === 'git'
          ? { commit: 'f'.repeat(baseCommit.length), contentDigest: null }
          : { commit: null, contentDigest: afterDigest },
      id: changeSetId,
      inputSnapshotId,
      materializationRecordId,
      patch:
        strategy === 'git'
          ? {
              bytes: Buffer.byteLength(patchText, 'utf8'),
              digest: patchDigest,
              ref: 'worker-session://workspace.patch',
            }
          : null,
      redaction: { notes: [], status: 'no-sensitive-content-found' },
      resourceId,
      strategy,
      workspaceId,
    },
    filesystemApply:
      strategy === 'filesystem'
        ? {
            before: {
              contentDigest: beforeDigest,
              createdAt: timestamp,
              entries: [],
              resourceId,
              workspaceId,
            },
            stagingRootPath,
            targetRootPath,
          }
        : null,
    patchPayload:
      strategy === 'git'
        ? {
            bytes: Buffer.byteLength(patchText, 'utf8'),
            digest: patchDigest,
            mediaType: 'text/x-diff',
            text: patchText,
          }
        : null,
    review: {
      actionCenterRowId: `workspace-review:${reviewId}`,
      changeSetId,
      createdAt: timestamp,
      diffSummary: { additions: 1, deletions: 0, filesChanged: 1 },
      id: reviewId,
      riskSummary: 'One changed path staged for human review.',
      staging:
        strategy === 'git'
          ? {
              branch: `openkit/review/${reviewId}`,
              ref: `staging://workspace/${changeSetId}`,
              strategy: 'git_worktree',
            }
          : {
              branch: null,
              ref: `filesystem-staging://${reviewId}`,
              strategy: 'filesystem_staging',
            },
      status: 'pending',
      updatedAt: timestamp,
      validation: [],
      workspaceId,
    },
  } satisfies WorkerGovernanceWorkspaceChangeRecord;

  return {
    artifactId: `ar_workspace_changes_${turn.id}_${reviewId}`,
    environmentPackage,
    executor,
    inputSnapshot,
    materializationRecord,
    record,
    repositoryPath,
    requestId,
    reviewBranchRef: `refs/heads/openkit/review/${reviewId}`,
    reviewId,
    store,
    storeDataRoot,
    timestamp,
    workspaceDb,
    workspaceId,
  };
}

/**
 * Invokes the executor's workspace-change ingress boundary with explicit trusted lineage.
 *
 * @param fixture Isolated ingress fixture.
 * @param record Worker-emitted change record to validate.
 * @param inputStrategy Optional trusted input strategy override.
 * @param materializationStrategy Optional trusted materialization strategy override.
 * @returns Promise settled after validation and any accepted persistence.
 */
async function ingestWorkspaceChangeFixture(
  fixture: ReturnType<typeof createWorkspaceChangeIngressFixture>,
  record: WorkerGovernanceWorkspaceChangeRecord,
  inputStrategy?: 'git' | 'filesystem',
  materializationStrategy?: 'git' | 'filesystem'
): Promise<void> {
  recordTestWorkspaceReviewMaterialization(fixture.workspaceDb, {
    artifactId: fixture.artifactId,
    ...record,
  });
  const executor = fixture.executor as unknown as {
    createWorkspaceChangeArtifacts(
      store: FsStore,
      environmentPackage: AgentEnvironmentPackage,
      records: readonly WorkerGovernanceWorkspaceChangeRecord[],
      workspaceDb: WorkspaceDb | null,
      inputSnapshots: readonly WorkspaceInputSnapshot[],
      materializationRecords: readonly WorkspaceMaterializationRecord[],
      recordedAt: string
    ): Promise<void>;
  };

  await executor.createWorkspaceChangeArtifacts(
    fixture.store,
    fixture.environmentPackage,
    [record],
    fixture.workspaceDb,
    [{ ...fixture.inputSnapshot, strategy: inputStrategy ?? fixture.inputSnapshot.strategy }],
    [
      {
        ...fixture.materializationRecord,
        strategy: materializationStrategy ?? fixture.materializationRecord.strategy,
      },
    ],
    fixture.timestamp
  );
}

/**
 * Checks whether one exact Git reference exists in a test repository.
 *
 * @param repositoryPath Test repository path.
 * @param reference Exact full Git reference.
 * @returns True only when the reference exists.
 */
function testGitRefExists(repositoryPath: string, reference: string): boolean {
  try {
    runTestGit(repositoryPath, ['show-ref', '--verify', '--quiet', reference]);
    return true;
  } catch {
    return false;
  }
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

/** Supplies a supported, credential-free remote source for lifecycle fixtures that need a workspace input. */
function remoteGitInputFixture() {
  const commit = 'a'.repeat(40);
  return {
    workspaceRoots: [
      {
        id: 'repo',
        access: 'read-write' as const,
        sourceKind: 'remote-git' as const,
        sourceCommit: commit,
        workerPath: '/workspace/openkit',
      },
    ],
    workspaceSourceRefs: { repo: 'repo' },
    workspaceDataSourceCatalog: {
      schemaVersion: 1 as const,
      sources: [
        {
          id: 'repo',
          displayName: 'Repository',
          kind: 'git' as const,
          locator: { commit, url: 'https://example.invalid/repo.git' },
          access: 'read-write' as const,
          allowedSlotKinds: ['worktree' as const],
          sensitivity: 'internal' as const,
          status: 'active' as const,
        },
      ],
    },
  };
}

describe('WorkerGovernanceTurnExecutor', () => {
  it('closes Harness length as a blocked Task after fencing with zero successor launches', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-native-length-seam-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = createDemoStore({ dataRoot });
    recordWorkspaceOwnerMembership({ coreDb, workspaceId: 'ws_demo', ownerUserId: LOCAL_USER_ID });
    const target = recordTestNativeRuntimeTarget(coreDb);
    const backend = new FakeWorkerGovernanceBackend();
    const planSession = backend.planSession.bind(backend);
    backend.planSession = (pkg) => ({
      ...planSession(pkg),
      deploymentId: target.deploymentId,
      runtimeTargetId: target.targetId,
    });
    Object.assign(backend, { prepareAgentSessionContinuity: async () => 'absent' as const });
    const gateway = createDefaultWorkerControlGateway(coreDb);
    const tokens = {
      controlToken: Buffer.alloc(32, 17).toString('base64url'),
      inferenceToken: Buffer.alloc(32, 34).toString('base64url'),
      capabilityToken: Buffer.alloc(32, 51).toString('base64url'),
    };
    const materialize = backend.materialize.bind(backend);
    backend.materialize = async (pkg, context) => {
      const registration = gateway.registerSession(pkg, {
        sandboxBindingRef: context!.sandboxBindingRef!,
        workerControlToken: tokens.controlToken,
        workerInferenceToken: tokens.inferenceToken,
        workerCapabilityToken: tokens.capabilityToken,
      });
      bindNanoHostAttemptRouteTokenHashes(coreDb, {
        attemptId: attempts.listSchedulerExecutionAttemptsForTurn(coreDb, pkg.scope)[0]!.attemptId,
        sandboxBindingRef: context!.sandboxBindingRef!,
        workerControlTokenHash: registration.workerControlTokenHash,
        workerInferenceTokenHash: registration.workerInferenceTokenHash,
        workerCapabilityTokenHash: registration.workerCapabilityTokenHash,
      });
      return materialize(pkg, context);
    };
    let app: ReturnType<typeof createAppWithWorkspaceAuthority>;
    const fenceEntered = Promise.withResolvers<void>();
    const permitFence = Promise.withResolvers<void>();
    const release = backend.release.bind(backend);
    vi.spyOn(backend, 'release').mockImplementation(async (input) => {
      fenceEntered.resolve();
      await permitFence.promise;
      return release(input);
    });
    const setup = createTestAgentSetup();
    const executor = new WorkerGovernanceTurnExecutor({
      backend,
      coreDb,
      awaitWorkerCompletion: async (pkg) => {
        const root = join(dataRoot, 'shim');
        mkdirSync(root, { recursive: true });
        const packagePath = join(root, 'package.json');
        const lineage = {
          workspaceId: pkg.scope.workspaceId,
          threadId: pkg.scope.threadId,
          turnId: pkg.scope.turnId,
          agentSessionId: pkg.scope.agentSessionId,
          requestId: pkg.scope.requestId,
          packageSnapshotId: pkg.snapshotId,
        };
        // The external sandbox double supplies local paths; both terminal producers and Core consumers are real.
        writeFileSync(
          packagePath,
          JSON.stringify({
            ...pkg,
            control: {
              ...pkg.control,
              adapter: { kind: 'openkit-worker-shim', targetRuntime: 'fixture' },
            },
            extensions: {
              openkit: {
                turnInput: 'bounded attempt',
                sessionWorkspace: {
                  layout: { slots: [{ kind: 'worktree', access: 'read-write', path: root }] },
                },
              },
            },
            runtime: { command: { argv: ['openkit-worker-shim'], workingDirectory: root } },
            workspace: { root, inputs: [] },
            supply: { mcpServers: [{ id: 'echo' }] },
          })
        );
        const integration = {
          ready: Promise.resolve(),
          bindTurnRouteTokens() {},
          clearTurnRouteTokens() {},
          async drainTurn() {
            return 0;
          },
          workerControlFetch: async (url: string, init: RequestInit) =>
            app.request(url.replace('/worker-control/', '/api/worker-control/'), init),
        } as unknown as SandboxIntegrationClient;
        await runResidentTurn({
          adapterId: 'fixture',
          credentialValues: [],
          environment: {},
          integration,
          lineage,
          onStarted() {},
          packagePath,
          resident: {
            exited: new Promise(() => {}),
            childState: () => 'running',
            close: async () => {},
            nativeHandle: async () => ({ state: 'pending' }),
            startTurn: async () => ({
              interrupt: async () => {},
              settled: Promise.resolve({
                assistantText: null,
                status: 'length',
                stopReason: 'length',
              }),
            }),
          },
          runtimeEnvironmentNames: new Set(),
          nativeEnvironment: null,
          sessionDir: join(root, 'output'),
          signal: new AbortController().signal,
          tokens,
          turnDirectory: join(root, 'turn'),
        });
        const transcript = backend.collectTranscript.bind(backend);
        vi.spyOn(backend, 'collectTranscript').mockImplementation(async () => ({
          ...(await transcript()),
          eventsJsonl: readFileSync(join(root, 'output', 'events.jsonl'), 'utf8'),
          itemsJsonl: readFileSync(join(root, 'output', 'items.jsonl'), 'utf8'),
        }));
        return getWorkerControlAcceptedFinalStatus(coreDb, lineage)!;
      },
    });
    app = createAppWithWorkspaceAuthority({
      coreDb,
      dataRoot,
      store,
      turnExecutor: executor,
      workerControlGateway: gateway,
      agentManifests: [setup.manifest],
      openKitConfig: { defaults: { defaultAgentId: setup.manifest.id } },
    });
    const requestId = '0190f4c8-0000-7000-8000-000000000698';
    const submit = () =>
      app.request(
        ...operationRequest(
          'task.start',
          { workspaceId: 'ws_demo', threadId: 'th_demo' },
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ requestId, input: 'One bounded attempt.' }),
          }
        )
      );
    try {
      const accepted = await submit();
      expect(accepted.status, await accepted.clone().text()).toBe(202);
      const original = await accepted.json();
      await vi.waitFor(() => expect(backend.calls).toContain('cleanupSession'), {
        timeout: 10_000,
      });
      await Promise.race([
        fenceEntered.promise,
        delay(1_000).then(() => {
          throw new Error('Expected release fence was not reached.');
        }),
      ]);
      const db = openTestWorkspaceDb(coreDb);
      try {
        expect(
          getWorkerCheckpoint(db, 'ws_demo', original.turn.threadId, original.turn.id)
        ).not.toBeNull();
        permitFence.resolve();
        await vi.waitFor(() =>
          expect(
            getWorkerCheckpoint(db, 'ws_demo', original.turn.threadId, original.turn.id)
          ).toBeNull()
        );
      } finally {
        db.sqlite.close();
      }
      expect(store.getTurnById(original.turn.id).status).toBe('completed');
      const replay = await submit();
      expect(replay.status, await replay.clone().text()).toBe(202);
      expect(await replay.json()).toMatchObject({
        state: 'blocked',
        turn: { id: original.turn.id, status: 'completed' },
      });
      expect(store.getTurnEvents(original.turn.id)).toContainEqual(
        expect.objectContaining({
          event: 'turn.completed',
          data: expect.objectContaining({ stopReason: 'length' }),
        })
      );
      const attempt = attempts.listSchedulerExecutionAttemptsForTurn(coreDb, {
        workspaceId: 'ws_demo',
        threadId: original.turn.threadId,
        turnId: original.turn.id,
      });
      expect(attempt).toHaveLength(1);
      expect(attempt[0]).toMatchObject({ phase: 'closed', fenceRef: expect.any(String) });
      expect(backend.calls.filter((call) => call === 'submit')).toHaveLength(1);
      expect(store.listThreadAgentSessions('ws_demo', original.turn.threadId)).toHaveLength(1);
    } finally {
      permitFence.resolve();
      coreDb.sqlite.close();
    }
  });

  it('refuses the r35 host-dir source during AEP preparation with zero backend dispatch', async () => {
    const fixture = createWorkerContextExecutorFixture('r35-host-dir');
    const backend = new FakeWorkerGovernanceBackend();
    Object.assign(backend, { prepareAgentSessionContinuity: async () => 'absent' as const });
    const executor = new WorkerGovernanceTurnExecutor({ backend, coreDb: fixture.coreDb });
    const workspaceRoots = materializeWorkspaceRoots({
      config: {
        id: 'ws_demo',
        name: 'Demo',
        workspace: {
          name: 'Demo',
          roots: [
            {
              id: 'r35-output',
              kind: 'host-dir',
              path: 'r35-outputs',
              access: 'read-write',
              createIfMissing: true,
            },
          ],
        },
      },
      workspaceRoot: fixture.coreDb.dataRoot,
      createMissing: true,
    });
    try {
      await expect(
        executor.prepareAgentSessionForTurn(fixture.store, {
          agentSetup: createTestAgentSetup(),
          freshAgentSessionId: fixture.agentSessionId,
          requestId: fixture.requestId,
          turn: fixture.turn,
          turnInput: fixture.workerRequest,
          workspaceRoots,
        })
      ).rejects.toThrow(
        'NanoHost cannot materialize workspace root r35-output: unsupported source kind host-dir.'
      );
      expect(backend.calls).toEqual([]);
      const commit = 'a'.repeat(40);
      await expect(
        executor.prepareAgentSessionForTurn(fixture.store, {
          agentSetup: createTestAgentSetup(),
          freshAgentSessionId: fixture.agentSessionId,
          requestId: fixture.requestId,
          turn: fixture.turn,
          turnInput: fixture.workerRequest,
          workspaceRoots: [
            {
              id: 'repo',
              access: 'read-write',
              sourceKind: 'remote-git',
              sourceCommit: commit,
              workerPath: '/workspace/openkit',
            },
          ],
          workspaceSourceRefs: { repo: 'main-repo' },
          workspaceDataSourceCatalog: {
            schemaVersion: 1,
            sources: [
              {
                id: 'main-repo',
                displayName: 'Main repository',
                kind: 'git',
                locator: { commit, url: 'https://example.invalid/repo.git' },
                access: 'read-write',
                allowedSlotKinds: ['worktree'],
                sensitivity: 'internal',
                status: 'active',
              },
            ],
          },
        })
      ).resolves.toMatchObject({ agentSessionId: fixture.agentSessionId });
      expect(backend.calls).toEqual([]);
    } finally {
      fixture.coreDb.sqlite.close();
    }
  });

  it.each([
    [false, false],
    [true, false],
    [false, true],
  ])('releases definite image refusal after failed publication only with successful cleanup (unknown=%s, release interrupted=%s)', async (cleanupFails, releaseInterrupted) => {
    const f = createWorkerContextExecutorFixture(
      `image-refusal-${cleanupFails}-${releaseInterrupted}`
    );
    const backend = new FakeWorkerGovernanceBackend();
    const refusal = new Error('NanoHost effect image.acquire already has a pending command.');
    backend.materialize = async (pkg, context) => {
      context?.beforeMaterialization?.();
      backend.calls.push('materialize');
      const intent = attempts.recordSchedulerExecutionOperation(f.coreDb, {
        attemptId: `lease_${f.turn.id}`,
        operationId: createNanoHostEffectRequest(
          backend.planSession(pkg),
          `lease_${f.turn.id}`,
          'image.acquire',
          {
            imageReference:
              pkg.runtime.environment?.imageDigest ?? (pkg.runtime.image as { ref: string }).ref,
          }
        ).requestId!,
      });
      attempts.acceptSchedulerExecutionObservation(f.coreDb, {
        ...attempts.schedulerExecutionCorrelation(intent),
        disposition: 'not_accepted',
        execution: 'unknown',
        fenceRef: null,
        outcomeRef: null,
      });
      expect(pkg.workspace.inputs.length).toBeGreaterThan(0);
      throw refusal;
    };
    backend.failTeardown = cleanupFails;
    const release = vi.spyOn(backend, 'release');
    const releaseError = new Error('live release interrupted after handoff publication');
    if (releaseInterrupted) release.mockRejectedValueOnce(releaseError);
    const executor = new WorkerGovernanceTurnExecutor({
      backend,
      coreDb: f.coreDb,
      createAgentSessionId: () => f.agentSessionId,
      now: () => '2026-07-15T00:00:03.000Z',
    });
    try {
      const error = await executor
        .startTurn(f.store, f.turn.id, f.workerRequest, {
          attemptId: `lease_${f.turn.id}`,
          agentSessionId: f.agentSessionId,
          agentSetup: createTestAgentSetup(),
          requestId: f.requestId,
          sandboxBindingRef: f.sandboxBindingRef,
          triggerActor: f.turn.triggerActor,
          workspaceRoots: [],
        })
        .catch((error: unknown) => error);
      expect(error).toBeInstanceOf(Error);
      expect(f.store.getTurnById(f.turn.id)).toMatchObject({
        status: 'failed',
        error: { message: expect.stringContaining(refusal.message) },
      });
      expect(backend.calls).not.toContain('submit');
      expect(
        attempts.requireSchedulerExecutionAttempt(f.coreDb, `lease_${f.turn.id}`)
      ).toMatchObject({
        phase: cleanupFails || releaseInterrupted ? 'closing' : 'closed',
        disposition: 'not_accepted',
        terminalCause: 'execution-failed',
        ...(cleanupFails
          ? {}
          : {
              outcomeRef: `turn:${f.turn.id}:failed`,
              fenceRef: releaseInterrupted ? null : expect.any(String),
            }),
      });
      expect(release).toHaveBeenCalledTimes(cleanupFails ? 0 : 1);
      if (!cleanupFails && !releaseInterrupted) expect(error).toBe(refusal);
      if (releaseInterrupted) {
        expect(error).toBeInstanceOf(AggregateError);
        expect((error as AggregateError).errors).toEqual([refusal, releaseError]);
        const original = f.store.getTurnById(f.turn.id);
        const originalSession = f.store.getAgentSession(f.agentSessionId);
        const cleanup = vi.spyOn(backend, 'cleanupSession');
        expect(getWorkerBackendSession(f.coreDb, `lease_${f.turn.id}`)).toMatchObject({
          state: 'cleaned',
          workspaceHandoffState: 'complete',
        });
        const workspaceDb = openTestWorkspaceDb(f.coreDb);
        const evidence = listWorkspaceRuntimeEvidence(workspaceDb, 'ws_demo');
        workspaceDb.sqlite.close();
        const recovery = {
          executionBackend: backend,
          store: f.store,
          now: () => '2026-07-15T00:00:05.000Z',
          cleanupBackendSession: () => backend.cleanupSession(),
          prepareBackendCleanup: () => {},
          restoreBackendSession: async () => {},
          reconcileAcceptedFinalStatus: async () => {
            throw new Error('Failed preparation has no final status.');
          },
          projectRecoveredTurn: async () => {
            const result = terminalizeGovernedWorkerTurn({
              store: f.store,
              turnId: f.turn.id,
              agentSessionId: f.agentSessionId,
              requestId: f.requestId,
              completedAt: '2026-07-15T00:00:05.000Z',
              outcome: 'interrupted',
              errorCode: 'worker_governance_restart_recovery',
              message: 'Worker execution was interrupted during scheduler recovery.',
            });
            return { status: result.status };
          },
        };
        await expect(
          runNanoHostAttemptRecoveryMaintenance(f.coreDb, recovery)
        ).resolves.toBeUndefined();
        await expect(
          runNanoHostAttemptRecoveryMaintenance(f.coreDb, recovery)
        ).resolves.toBeUndefined();
        expect(release).toHaveBeenCalledTimes(2);
        await expect(release.mock.results[1]?.value).resolves.toMatchObject({ state: 'released' });
        expect(release.mock.calls[1]).toEqual(release.mock.calls[0]);
        expect(cleanup).not.toHaveBeenCalled();
        expect(f.store.getTurnById(f.turn.id)).toEqual(original);
        expect(f.store.getAgentSession(f.agentSessionId)).toEqual(originalSession);
        expect(
          attempts.requireSchedulerExecutionAttempt(f.coreDb, `lease_${f.turn.id}`)
        ).toMatchObject({
          phase: 'closed',
          terminalCause: 'execution-failed',
          outcomeRef: `turn:${f.turn.id}:failed`,
          fenceRef: expect.any(String),
        });
        const reloaded = new FsStore({ dataRoot: f.coreDb.dataRoot });
        expect(reloaded.getTurnById(f.turn.id)).toEqual(original);
        const after = openTestWorkspaceDb(f.coreDb);
        expect(listWorkspaceRuntimeEvidence(after, 'ws_demo')).toEqual(evidence);
        after.sqlite.close();
      }
      const db = openTestWorkspaceDb(f.coreDb);
      try {
        expect(listBackendWorkspaceHandles(db, 'ws_demo')).toEqual([]);
        expect(listWorkspaceMaterializationRecords(db, 'ws_demo')).toEqual([]);
      } finally {
        db.sqlite.close();
      }
    } finally {
      f.coreDb.sqlite.close();
    }
  });

  it.each([
    'proved',
    'assigned-missing',
    'unknown-operation',
    'accepted-operation',
    'native-evidence',
    'lineage-conflict',
    'store-read-failure',
    'package-inaccessible',
    'package-invalid',
    'package-present',
    'package-directory',
    'package-file-link',
    'package-parent-link',
  ] as const)('settles only proved unassigned planned successor preparation: %s', async (proof) => {
    const coreDb = openCommitFixtureCore();
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const turn = store.createTurn(
      'ws_demo',
      'th_demo',
      'Prepare planned successor',
      { kind: 'user', id: 'user_local' },
      undefined,
      { status: 'pending', agentId: 'agent_codex_host', executorKind: 'worker' }
    );
    const predecessor = store.createAgentSession({
      id: 'as_planned_predecessor',
      agentId: 'agent_codex_host',
      workspaceId: turn.workspaceId,
      threadId: turn.threadId,
      status: 'idle',
      message: null,
      policySnapshotId: 'worker_turn_launch_policy',
      sessionCompatibilityKey: `sha256:${'0'.repeat(64)}`,
      createdAt: '2026-07-15T00:00:00.000Z',
      updatedAt: '2026-07-15T00:00:00.000Z',
    });
    const plannedId = 'as_planned_successor';
    const attemptId = 'attempt_planned_successor';
    const backend = new FakeWorkerGovernanceBackend();
    const continuity = vi.fn(async (input: { readonly reuseAllowed: boolean }) => {
      if (input.reuseAllowed) return 'replacement-required' as const;
      if (proof === 'assigned-missing') store.updateTurn(turn.id, { agentSessionId: plannedId });
      throw new Error('/private/planned-successor-canary native-secret-canary');
    });
    Object.assign(backend, { prepareAgentSessionContinuity: continuity });
    const executor = new WorkerGovernanceTurnExecutor({ backend, coreDb });
    const entry = createSchedulerAdmissionEntry(coreDb, {
      backendId: 'nanohost',
      queueEntryId: 'queue_planned_successor',
      requestId: '00000000-0000-4000-8000-000000000292',
      workspaceId: turn.workspaceId,
      threadId: turn.threadId,
      turnId: turn.id,
      turnInput: 'Prepare planned successor',
      requestedAgentId: 'agent_codex_host',
      triggerActor: turn.triggerActor,
    });
    store.recordCommandRequest({
      command: 'turn.start',
      requestId: entry.requestId,
      inputHash: 'fixture:planned-successor',
      scope: { actorId: 'user_local', workspaceId: entry.workspaceId, threadId: entry.threadId },
      response: { kind: 'turn', id: entry.turnId },
      createdAt: new Date().toISOString(),
    });
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let unreadableDir: string | null = null;
    try {
      await expect(
        runSchedulerDispatchLoop({
          coreDb,
          store,
          turnExecutor: executor,
          executionBackend: executor.executionBackend,
          callerQueueEntryId: entry.queueEntryId,
          createAgentSessionId: () => plannedId,
          createAttemptId: () => attemptId,
          agentManifests: [createTestAgentSetup().manifest],
          gatewayConfig: createTestGatewayConfig(),
          providerRegistry: new ProviderRegistry([
            {
              baseUrl: 'http://127.0.0.1:11434/v1',
              defaultModel: 'openai/gpt-5.2',
              displayName: 'Scheduler fixture provider',
              id: 'agent-openrouter',
              kind: 'local',
              models: ['openai/gpt-5.2'],
              modelMetadata: { 'openai/gpt-5.2': { temperature: false } },
            },
          ]),
        })
      ).rejects.toThrow('The AgentSession runtime binding changed after scheduler dispatch.');
      expect(continuity.mock.calls.some(([input]) => !input.reuseAllowed)).toBe(true);
      const original = store.getTurnById(turn.id);
      const originalEvents = store.getTurnEvents(turn.id);
      expect(original).toMatchObject({
        status: 'failed',
        error: { code: 'worker_preparation_failed' },
      });
      expect(original.agentSessionId).toBe(proof === 'assigned-missing' ? plannedId : undefined);
      expect(originalEvents.filter((event) => event.event === 'turn.completed')).toHaveLength(1);
      expect(() => store.getAgentSession(plannedId)).toThrow();
      const attempt = attempts.requireSchedulerExecutionAttempt(coreDb, attemptId);
      expect(attempt).toMatchObject({
        agentSessionId: plannedId,
        inputRef: `aepsnap_${turn.id}_${plannedId}`,
        phase: 'closed',
        disposition: 'not_accepted',
        operationId: null,
        terminalCause: 'turn-start-failed',
      });
      const workspace = openTestWorkspaceDb(coreDb);
      try {
        expect(
          snapshotLedger.listExportableAgentEnvironmentPackageSnapshots(workspace, 'ws_demo')
        ).toEqual([]);
        const packageRoot = join(
          dirname(dirname(workspace.sqlite.name)),
          'runtime',
          'agent-sessions',
          plannedId,
          'aep-snapshots'
        );
        const packagePath = join(packageRoot, `${attempt.inputRef}.json`);
        if (proof === 'package-present') {
          const environmentPackage = resolveAgentEnvironmentPackage({
            coreDb,
            agentSetup: createTestAgentSetup(),
            agentSessionId: plannedId,
            backend: { kind: 'openshell' },
            requestId: entry.requestId,
            triggerActor: turn.triggerActor,
            turn,
            turnInput: entry.turnInput,
            workspaceCwd: null,
            workspaceRoots: [],
          });
          expect(environmentPackage.snapshotId).toBe(attempt.inputRef);
          snapshotLedger.recordAgentEnvironmentPackageSnapshot(workspace, {
            environmentPackage,
            createdAt: '2026-07-15T00:00:01.000Z',
          });
          expect(
            snapshotLedger.findNamedAgentEnvironmentPackageSnapshot(
              workspace,
              turn.workspaceId,
              plannedId,
              attempt.inputRef!
            )
          ).not.toBeNull();
        } else if (proof === 'package-parent-link') {
          mkdirSync(dirname(packageRoot), { recursive: true });
          symlinkSync(join(dirname(packageRoot), 'missing-package-canary'), packageRoot, 'dir');
        } else if (proof.startsWith('package-')) {
          mkdirSync(packageRoot, { recursive: true });
          if (proof === 'package-directory') mkdirSync(packagePath);
          else if (proof === 'package-file-link')
            symlinkSync(join(packageRoot, 'missing-package-canary'), packagePath);
          else {
            writeFileSync(packagePath, '{}');
            if (proof === 'package-inaccessible') {
              unreadableDir = packageRoot;
              chmodSync(unreadableDir, 0);
              // Prove the existing bytes are inaccessible before testing the settlement grant.
              expect(() => lstatSync(packagePath)).toThrow(
                expect.objectContaining({ code: 'EACCES' })
              );
            }
          }
        }
      } finally {
        workspace.sqlite.close();
      }
      const recovery = {
        executionBackend: executor.executionBackend,
        store,
        cleanupBackendSession: vi.fn(async () => {}),
        prepareBackendCleanup: vi.fn(),
        restoreBackendSession: vi.fn(async () => {}),
        reconcileAcceptedFinalStatus: vi.fn(async () => {}),
        projectRecoveredTurn: vi.fn(async () => ({ status: 'failed' as const })),
      };
      if (proof === 'store-read-failure') {
        const getSession = store.getAgentSession.bind(store);
        vi.spyOn(store, 'getAgentSession').mockImplementation((id) => {
          if (id === plannedId)
            throw new Error('/private/planned-successor-canary native-secret-canary');
          return getSession(id);
        });
      } else if (proof === 'unknown-operation' || proof === 'accepted-operation') {
        coreDb.sqlite
          .prepare(
            'UPDATE scheduler_execution_attempts SET operation_id = ?, disposition = ? WHERE attempt_id = ?'
          )
          .run(
            'original-operation',
            proof === 'unknown-operation' ? 'unknown' : 'accepted',
            attemptId
          );
      } else if (proof === 'native-evidence') {
        coreDb.sqlite
          .prepare(
            'UPDATE scheduler_execution_attempts SET last_worker_sequence = 1 WHERE attempt_id = ?'
          )
          .run(attemptId);
      } else if (proof === 'lineage-conflict') {
        coreDb.sqlite
          .prepare('UPDATE scheduler_admission_entries SET turn_input = ? WHERE queue_entry_id = ?')
          .run('A different immutable request', entry.queueEntryId);
      }
      const beforeRecovery = store.getTurnById(turn.id);
      const beforeAttempt = attempts.requireSchedulerExecutionAttempt(coreDb, attemptId);
      const publish = vi.spyOn(store, 'emitTurnEvent');
      const createSession = vi.spyOn(store, 'createAgentSession');
      for (let pass = 0; pass < 2; pass += 1) {
        if (proof === 'proved') {
          await expect(
            runNanoHostAttemptRecoveryMaintenance(coreDb, recovery)
          ).resolves.toBeUndefined();
        } else {
          await expect(
            runNanoHostAttemptRecoveryMaintenance(coreDb, recovery)
          ).rejects.toMatchObject({
            message: 'Native attempt recovery failed.',
            errors: [
              proof === 'package-inaccessible'
                ? expect.objectContaining({ cause: expect.objectContaining({ code: 'EACCES' }) })
                : expect.any(Error),
            ],
          });
        }
        expect(store.getTurnById(turn.id)).toEqual(beforeRecovery);
        expect(store.getTurnEvents(turn.id)).toEqual(originalEvents);
        expect(attempts.requireSchedulerExecutionAttempt(coreDb, attemptId)).toEqual(beforeAttempt);
      }
      expect(publish).not.toHaveBeenCalled();
      expect(createSession).not.toHaveBeenCalled();
      expect(() => store.getAgentSession(plannedId)).toThrow();
      expect(store.getAgentSession(predecessor.id)).toEqual(predecessor);
      expect(backend.calls).toEqual([]);
      expect(recovery.cleanupBackendSession).not.toHaveBeenCalled();
      expect(recovery.prepareBackendCleanup).not.toHaveBeenCalled();
      expect(recovery.restoreBackendSession).not.toHaveBeenCalled();
      expect(recovery.reconcileAcceptedFinalStatus).not.toHaveBeenCalled();
      expect(recovery.projectRecoveredTurn).not.toHaveBeenCalled();
      expect(log.mock.calls).toHaveLength(proof === 'proved' ? 0 : 2);
      for (const [line] of log.mock.calls)
        expect(JSON.parse(line)).toEqual({
          severityText: 'WARN',
          body: 'Failed-start product settlement check failed.',
          attributes: {
            'openkit.error.code': 'scheduler.native_failed_start_recovery_required',
            'openkit.attempt.id': attemptId,
            'openkit.workspace.id': turn.workspaceId,
            'openkit.thread.id': turn.threadId,
            'openkit.turn.id': turn.id,
            'openkit.agent.session.id': plannedId,
          },
        });
      expect(JSON.stringify(log.mock.calls)).not.toContain('native-secret-canary');
      expect(JSON.stringify(log.mock.calls)).not.toContain('/private/planned-successor-canary');
      expect(JSON.stringify(log.mock.calls)).not.toContain('missing-package-canary');
    } finally {
      if (unreadableDir) chmodSync(unreadableDir, 0o700);
      log.mockRestore();
      coreDb.sqlite.close();
    }
  });

  it('closes a real preparation failure before snapshot publication without backend submission or missing-snapshot maintenance (#108)', async () => {
    const fixture = createWorkerContextExecutorFixture('pre-snapshot-108');
    const backend = new FakeWorkerGovernanceBackend();
    const executor = new WorkerGovernanceTurnExecutor({
      backend,
      coreDb: fixture.coreDb,
      createAgentSessionId: () => fixture.agentSessionId,
      now: () => '2026-07-15T00:00:03.000Z',
    });
    const failedPublication = vi
      .spyOn(snapshotLedger, 'recordAgentEnvironmentPackageSnapshot')
      .mockImplementation(() => {
        throw new Error('Controlled snapshot preparation refusal before publication.');
      });
    try {
      const failure = await executor
        .startTurn(fixture.store, fixture.turn.id, fixture.workerRequest, {
          attemptId: `lease_${fixture.turn.id}`,
          agentSessionId: fixture.agentSessionId,
          agentSetup: createTestAgentSetup(),
          requestId: fixture.requestId,
          sandboxBindingRef: fixture.sandboxBindingRef,
          triggerActor: fixture.turn.triggerActor,
          workspaceRoots: [],
        })
        .catch((error: unknown) => error);
      expect(failedPublication).toHaveBeenCalledOnce();
      expect(failure).toBeInstanceOf(Error);
      expect(backend.calls).not.toContain('materialize');
      expect(backend.calls).not.toContain('submit');
      const workspace = openTestWorkspaceDb(fixture.coreDb);
      try {
        expect(
          snapshotLedger.listExportableAgentEnvironmentPackageSnapshots(workspace, 'ws_demo')
        ).toEqual([]);
      } finally {
        workspace.sqlite.close();
      }
      const original = fixture.store.getTurnById(fixture.turn.id);
      expect(original).toMatchObject({ id: fixture.turn.id, status: 'failed' });
      const attemptTable = fixture.coreDb.sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='scheduler_execution_attempts'"
        )
        .get();
      const retainedAttempts = attemptTable
        ? fixture.coreDb.sqlite
            .prepare('SELECT * FROM scheduler_execution_attempts WHERE turn_id = ?')
            .all(fixture.turn.id)
        : [];
      expect(retainedAttempts).toEqual([
        expect.objectContaining({
          phase: 'closed',
          disposition: 'not_accepted',
          turn_id: fixture.turn.id,
        }),
      ]);
      failedPublication.mockRestore();
      await expect(
        runSchedulerRecoveryMaintenance(fixture.coreDb, {
          executionBackend: backend,
          store: fixture.store,
          now: () => '2026-07-15T00:00:04.000Z',
          projectRecoveredTurn: async () => ({ status: 'failed' }),
        })
      ).resolves.toBeUndefined();
      await expect(
        runSchedulerRecoveryMaintenance(fixture.coreDb, {
          executionBackend: backend,
          store: fixture.store,
          now: () => '2026-07-15T00:00:05.000Z',
          projectRecoveredTurn: async () => ({ status: 'failed' }),
        })
      ).resolves.toBeUndefined();
      const reloaded = new FsStore({ dataRoot: fixture.coreDb.dataRoot });
      expect(reloaded.getTurnById(fixture.turn.id)).toEqual(original);
      expect(reloaded.listThreadItems('ws_demo', fixture.turn.threadId)).toEqual(
        fixture.store.listThreadItems('ws_demo', fixture.turn.threadId)
      );
      expect(backend.calls).not.toContain('submit');
    } finally {
      failedPublication.mockRestore();
      fixture.coreDb.sqlite.close();
    }
  });

  it.each([
    'backend',
    'typed-preview',
    'native-proof',
  ] as const)('retains safe capacity inspection cause and request correlation: %s', async (scenario) => {
    const store = createDemoStore();
    const turn = createAssignedTurn(store, 'ws_demo', 'th_demo', 'Capacity inspection');
    const backend = new FakeWorkerGovernanceBackend();
    const cause =
      scenario === 'typed-preview'
        ? new TurnStartValidationError('preparation_refused', 'Fixed preparation refusal.', 403)
        : scenario === 'native-proof'
          ? new WorkerNativeProofValidationError('package-binding-lineage/attachment-target', {
              proofAgentSessionId: 'as_original_proof',
              packageSnapshotId: 'snapshot_original_proof',
              attemptId: 'lease_original_proof',
              originPhysicalEpoch: 'a'.repeat(64),
              attachmentPhysicalEpoch: 'b'.repeat(64),
            })
          : Object.assign(new Error('credential-canary /private/package-path received=secret'), {
              name: 'secret-error-name',
            });
    if (cause instanceof WorkerNativeProofValidationError && cause.diagnostic) {
      Object.assign(cause.diagnostic, { packageBytes: 'credential-canary /private/package-path' });
    }
    Object.assign(backend, {
      inspectMaterializationCapacity: () => {
        throw cause;
      },
    });
    const executor = new WorkerGovernanceTurnExecutor({ backend });
    // Fault only the guarded preview/inspector boundary; admission and refusal stay production-owned.
    Object.assign(executor, {
      previewAgentEnvironmentPackage: () => {
        if (scenario === 'typed-preview') throw cause;
        return {};
      },
    });
    const appLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const input = {
        agentSetup: createTestAgentSetup(),
        freshAgentSessionId: 'as_capacity_cause',
        requestId: 'request_capacity_cause',
        turn,
        turnInput: 'Capacity inspection',
        workspaceCwd: null,
        workspaceRoots: [],
      };
      let refusal: unknown;
      try {
        (
          executor as unknown as {
            requireMaterializationCapacity(id: string, preparation: typeof input): void;
          }
        ).requireMaterializationCapacity(input.freshAgentSessionId, input);
      } catch (error) {
        refusal = error;
      }
      if (scenario === 'typed-preview') expect(refusal).toBe(cause);
      else {
        expect(refusal).toMatchObject({ code: 'recovery_required', status: 409, cause });
        expect(Object.keys(refusal as Error)).not.toContain('cause');
        expect(JSON.stringify(refusal)).not.toContain('secret-error-name');
        expect((refusal as Error).message).toBe(
          'The worker backend materialization capacity cannot be safely inspected.'
        );
      }
      expect(backend.calls).toEqual([]);
      expect(store.listThreadAgentSessions('ws_demo', 'th_demo')).toEqual([]);
      expect(appLog).toHaveBeenCalledTimes(1);
      const log = JSON.parse(appLog.mock.calls[0]![0] as string);
      expect(log).toEqual({
        event: 'worker.admission.capacity-inspection-failed',
        errorCode: 'recovery_required',
        requestId: input.requestId,
        workspaceId: turn.workspaceId,
        threadId: turn.threadId,
        agentId: input.agentSetup.manifest.id,
        agentSessionId: input.freshAgentSessionId,
        ...(scenario === 'native-proof'
          ? {
              proofAgentSessionId: 'as_original_proof',
              packageSnapshotId: 'snapshot_original_proof',
              attemptId: 'lease_original_proof',
              originPhysicalEpoch: 'a'.repeat(64),
              attachmentPhysicalEpoch: 'b'.repeat(64),
            }
          : {}),
        errorClass:
          scenario === 'native-proof'
            ? 'WorkerNativeProofValidationError'
            : scenario === 'typed-preview'
              ? 'TurnStartValidationError'
              : 'Error',
        message:
          scenario === 'native-proof'
            ? 'Retained native-session proof disagrees with its original binding and package provenance.'
            : 'Worker backend materialization capacity inspection failed.',
        failedCheck:
          scenario === 'native-proof'
            ? 'package-binding-lineage/attachment-target'
            : 'materialization-capacity-inspection',
      });
      expect(JSON.stringify(log)).not.toMatch(
        /credential-canary|package-path|received|secret-error-name/
      );
    } finally {
      appLog.mockRestore();
    }
  });

  it('records possible preparation acceptance before effect-capable materialization', async () => {
    const f = createWorkerContextExecutorFixture('materialization-operation');
    f.coreDb.sqlite
      .prepare(
        "UPDATE scheduler_execution_attempts SET startup_deadline='2999-01-01T00:00:00.000Z'"
      )
      .run();
    const observations: Array<() => void> = [];
    const effects: string[] = [];
    const runtime = createConfiguredWorkerLifecycleRuntime({
      coreDb: f.coreDb,
      store: f.store,
      env: {},
      workerControlGateway: new WorkerControlGateway(),
      nanoHostSessionDispatch: {
        async effect(connectionOrRequest, carriedRequest) {
          const request = carriedRequest ?? (connectionOrRequest as NanoHostSessionEffectRequest);
          effects.push(request.kind);
          const attempt = attempts.requireSchedulerExecutionAttempt(f.coreDb, `lease_${f.turn.id}`);
          const authority = operationAuthorizer.currentWorkerLineageWorkspaceAuthority(
            f.coreDb,
            {
              agentSessionId: f.agentSessionId,
              packageSnapshotId: attempt.inputRef!,
              threadId: f.turn.threadId,
              turnId: f.turn.id,
              workspaceId: f.turn.workspaceId,
              triggerActor: f.turn.triggerActor,
            },
            'runtime.launch',
            true
          );
          observations.push(() => {
            expect(attempt).toMatchObject({
              phase: 'open',
              disposition: 'unknown',
              agentSessionId: f.agentSessionId,
              inputRef: `aepsnap_${f.turn.id}_${f.agentSessionId}`,
            });
            expect(attempt.operationId).toEqual(expect.any(String));
            expect(attempt.preparationInputJson).toEqual(expect.any(String));
            expect(authority).toBeTruthy();
          });
          throw new Error('Controlled image acquisition refusal at the external Native boundary.');
        },
        async poll() {
          return null;
        },
        async result() {},
        async route() {
          throw new Error('Unexpected route.');
        },
      },
    });
    try {
      await expect(
        runtime.turnExecutor.startTurn(f.store, f.turn.id, f.workerRequest, {
          attemptId: `lease_${f.turn.id}`,
          agentSessionId: f.agentSessionId,
          agentSetup: createTestAgentSetup({
            requiredCapabilities: ['trusted-worker-inference-relay'],
          }),
          requestId: f.requestId,
          sandboxBindingRef: f.sandboxBindingRef,
          triggerActor: f.turn.triggerActor,
          workspaceRoots: [],
        })
      ).rejects.toThrow('Controlled image acquisition refusal');
      expect(effects).toEqual(['image.acquire']);
      expect(observations).toHaveLength(1);
      observations[0]!();
      expect(
        attempts.requireSchedulerExecutionAttempt(f.coreDb, `lease_${f.turn.id}`).operationId
      ).toEqual(expect.any(String));
    } finally {
      f.coreDb.sqlite.close();
    }
  });

  it('reuses compatible continuity without previewing a fresh AgentSession target', async () => {
    const store = createDemoStore();
    const turn = createAssignedTurn(store, 'ws_demo', 'th_demo', 'Reuse current continuity');
    const currentCompatibilityKey = `sha256:${'a'.repeat(64)}`;
    store.createAgentSession({
      agentId: 'agent_codex_host',
      createdAt: '2026-08-21T00:00:00.000Z',
      environmentPackageSnapshotId: 'aepsnap-current-continuity',
      id: 'as-current-continuity',
      retainedStorage: {
        storageRef: `wst_${'1'.repeat(32)}`,
        workSlotRef: workerStorageDefaultWorkSlotRef(turn.workspaceId, turn.threadId),
      },
      message: null,
      policySnapshotId: 'worker_turn_launch_policy',
      sessionCompatibilityKey: currentCompatibilityKey,
      status: 'idle',
      threadId: turn.threadId,
      updatedAt: '2026-08-21T00:00:00.000Z',
      workspaceId: turn.workspaceId,
      workspaceRoots: [],
    });
    const backend = new FakeWorkerGovernanceBackend();
    const prepareContinuity = vi.fn(async () => 'reusable' as const);
    Object.assign(backend, { prepareAgentSessionContinuity: prepareContinuity });
    const executor = new WorkerGovernanceTurnExecutor({ backend });
    const preview = vi.fn((agentSessionId: string) => {
      if (agentSessionId !== 'as-current-continuity') {
        throw new Error('Fresh target must not be previewed for compatible reuse.');
      }
      return currentCompatibilityKey;
    });
    Object.assign(executor, { previewAgentSessionCompatibilityKey: preview });

    await expect(
      executor.prepareAgentSessionForTurn(store, {
        agentSetup: createTestAgentSetup(),
        freshAgentSessionId: 'as-fresh-continuity',
        requestId: 'req-reuse-continuity',
        turn,
        turnInput: 'Reuse current continuity',
        workspaceRoots: [],
      })
    ).resolves.toEqual({
      agentSessionId: 'as-current-continuity',
      currentAgentSession: {
        agentId: 'agent_codex_host',
        id: 'as-current-continuity',
        policySnapshotId: 'worker_turn_launch_policy',
        sessionCompatibilityKey: currentCompatibilityKey,
        stale: false,
        status: 'idle',
        updatedAt: '2026-08-21T00:00:00.000Z',
      },
      replacementRequired: false,
      sessionCompatibilityKey: currentCompatibilityKey,
    });
    expect(preview).toHaveBeenCalledTimes(1);
    expect(prepareContinuity).toHaveBeenCalledTimes(2);
    expect(prepareContinuity.mock.calls[0]?.[0]).not.toHaveProperty('environmentPackage');
    expect(prepareContinuity.mock.calls[1]?.[0]).toHaveProperty('environmentPackage');
    expect(prepareContinuity).toHaveBeenCalledWith(expect.objectContaining({ reuseAllowed: true }));
  });

  it('previews a fresh target before closing runtime-incompatible continuity', async () => {
    const store = createDemoStore();
    const turn = createAssignedTurn(store, 'ws_demo', 'th_demo', 'Replace current continuity');
    const currentCompatibilityKey = `sha256:${'b'.repeat(64)}`;
    store.createAgentSession({
      agentId: 'agent_codex_host',
      createdAt: '2026-08-21T00:00:00.000Z',
      environmentPackageSnapshotId: 'aepsnap-runtime-incompatible',
      id: 'as-runtime-incompatible',
      message: null,
      policySnapshotId: 'worker_turn_launch_policy',
      sessionCompatibilityKey: currentCompatibilityKey,
      status: 'idle',
      threadId: turn.threadId,
      updatedAt: '2026-08-21T00:00:00.000Z',
      workspaceId: turn.workspaceId,
      workspaceRoots: [],
    });
    const backend = new FakeWorkerGovernanceBackend();
    const prepareContinuity = vi.fn(async () => 'replacement-required' as const);
    Object.assign(backend, { prepareAgentSessionContinuity: prepareContinuity });
    const executor = new WorkerGovernanceTurnExecutor({ backend });
    Object.assign(executor, {
      previewAgentSessionCompatibilityKey: (agentSessionId: string) => {
        if (agentSessionId === 'as-fresh-after-runtime-mismatch') {
          throw new Error('Fresh target preview failed.');
        }
        return currentCompatibilityKey;
      },
    });

    await expect(
      executor.prepareAgentSessionForTurn(store, {
        agentSetup: createTestAgentSetup(),
        freshAgentSessionId: 'as-fresh-after-runtime-mismatch',
        requestId: 'req-runtime-incompatible',
        turn,
        turnInput: 'Replace current continuity',
        workspaceRoots: [],
      })
    ).rejects.toThrow('Fresh target preview failed.');
    expect(prepareContinuity).toHaveBeenCalledTimes(2);
    expect(prepareContinuity.mock.calls[0]?.[0]).not.toHaveProperty('environmentPackage');
    expect(prepareContinuity.mock.calls[1]?.[0]).toHaveProperty('environmentPackage');
    expect(prepareContinuity).toHaveBeenCalledWith(expect.objectContaining({ reuseAllowed: true }));
    expect(store.getAgentSession('as-runtime-incompatible').status).toBe('idle');
  });

  it('commits replacement only after fresh compatibility and runtime revalidation', async () => {
    const coreDb = openCommitFixtureCore();
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const turn = createAssignedTurn(store, 'ws_demo', 'th_demo', 'Commit current replacement');
    const currentCompatibilityKey = `sha256:${'c'.repeat(64)}`;
    const freshCompatibilityKey = `sha256:${'d'.repeat(64)}`;
    store.createAgentSession({
      agentId: 'agent_codex_host',
      createdAt: '2026-08-21T00:00:00.000Z',
      id: 'as-current-replacement',
      message: null,
      policySnapshotId: 'worker_turn_launch_policy',
      sessionCompatibilityKey: `sha256:${'e'.repeat(64)}`,
      status: 'idle',
      threadId: turn.threadId,
      updatedAt: '2026-08-21T00:00:00.000Z',
      workspaceId: turn.workspaceId,
    });
    const events: string[] = [];
    const backend = new FakeWorkerGovernanceBackend();
    Object.assign(backend, {
      prepareAgentSessionContinuity: vi.fn(async (input: { readonly reuseAllowed: boolean }) => {
        events.push(input.reuseAllowed ? 'runtime-inspect' : 'runtime-close');
        return input.reuseAllowed ? ('replacement-required' as const) : ('closed' as const);
      }),
    });
    const executor = new WorkerGovernanceTurnExecutor({
      backend,
      coreDb,
      now: () => '2026-08-21T00:00:05.000Z',
    });
    Object.assign(executor, {
      previewAgentSessionCompatibilityKey: (agentSessionId: string) => {
        if (agentSessionId === 'as-fresh-replacement') {
          events.push('fresh-preview');
          return freshCompatibilityKey;
        }
        return currentCompatibilityKey;
      },
    });
    const preparation = {
      agentSetup: createTestAgentSetup(),
      freshAgentSessionId: 'as-fresh-replacement',
      requestId: 'req-commit-replacement',
      turn,
      turnInput: 'Commit current replacement',
      workspaceCwd: null,
      workspaceRoots: [],
    };
    const prepared = await executor.prepareAgentSessionForTurn(store, preparation);
    const historyBeforeCommit = store.listThreadTurns(turn.workspaceId, turn.threadId);

    expect(store.getAgentSession('as-current-replacement').status).toBe('idle');
    acquireCommitFixtureAttempt(coreDb, preparation, 'lease-commit-replacement');
    await executor.commitPreparedAgentSessionForTurn(store, {
      attemptId: 'lease-commit-replacement',
      prepared,
      preparation,
    });

    expect(events.indexOf('fresh-preview')).toBeLessThan(events.indexOf('runtime-close'));
    expect(store.getAgentSession('as-current-replacement')).toMatchObject({
      status: 'closed',
      updatedAt: '2026-08-21T00:00:05.000Z',
    });
    expect(store.listThreadTurns(turn.workspaceId, turn.threadId)).toEqual(historyBeforeCommit);
  });

  it('selects a fresh AgentSession without local close for restart-unproved Sandbox continuity', async () => {
    const coreDb = openCommitFixtureCore();
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const turn = createAssignedTurn(store, 'ws_demo', 'th_demo', 'Replace restart continuity');
    const currentCompatibilityKey = `sha256:${'1'.repeat(64)}`;
    const freshCompatibilityKey = `sha256:${'2'.repeat(64)}`;
    store.createAgentSession({
      agentId: 'agent_codex_host',
      createdAt: '2026-09-06T00:00:00.000Z',
      id: 'as-restart-unproved-current',
      message: null,
      policySnapshotId: 'worker_turn_launch_policy',
      sessionCompatibilityKey: currentCompatibilityKey,
      status: 'idle',
      threadId: turn.threadId,
      updatedAt: '2026-09-06T00:00:00.000Z',
      workspaceId: turn.workspaceId,
    });
    const backend = new FakeWorkerGovernanceBackend();
    let finishRetirement!: () => void;
    const retirement = new Promise<void>((resolve) => {
      finishRetirement = resolve;
    });
    const continuity = vi.fn(async (input: { readonly reuseAllowed: boolean }) => {
      if (input.reuseAllowed) return 'sandbox-replacement-required' as const;
      await retirement;
      return 'closed' as const;
    });
    Object.assign(backend, { prepareAgentSessionContinuity: continuity });
    const executor = new WorkerGovernanceTurnExecutor({
      backend,
      coreDb,
      now: () => '2026-09-06T00:00:01.000Z',
    });
    Object.assign(executor, {
      previewAgentSessionCompatibilityKey: (agentSessionId: string) =>
        agentSessionId === 'as-restart-unproved-current'
          ? currentCompatibilityKey
          : freshCompatibilityKey,
    });
    const preparation = {
      agentSetup: createTestAgentSetup(),
      freshAgentSessionId: 'as-restart-unproved-fresh',
      requestId: 'req-restart-unproved',
      turn,
      turnInput: 'Replace restart continuity',
      workspaceCwd: null,
      workspaceRoots: [],
    };
    const historyBefore = store.listThreadTurns(turn.workspaceId, turn.threadId);

    const prepared = await executor.prepareAgentSessionForTurn(store, preparation);
    expect(prepared).toMatchObject({
      agentSessionId: 'as-restart-unproved-fresh',
      replacementRequired: true,
      sessionCompatibilityKey: freshCompatibilityKey,
    });
    acquireCommitFixtureAttempt(coreDb, preparation, 'lease-restart-unproved');
    const committed = executor.commitPreparedAgentSessionForTurn(store, {
      attemptId: 'lease-restart-unproved',
      prepared,
      preparation,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(continuity).toHaveBeenCalledTimes(4);
    expect(continuity.mock.calls.map(([input]) => input.reuseAllowed)).toEqual([
      true,
      true,
      true,
      false,
    ]);
    expect(store.getAgentSession('as-restart-unproved-current').status).toBe('idle');
    expect(() => store.getAgentSession('as-restart-unproved-fresh')).toThrow();
    finishRetirement();
    await committed;
    expect(store.getAgentSession('as-restart-unproved-current')).toMatchObject({
      status: 'closed',
      updatedAt: '2026-09-06T00:00:01.000Z',
    });
    expect(() => store.getAgentSession('as-restart-unproved-fresh')).toThrow();
    expect(store.listThreadTurns(turn.workspaceId, turn.threadId)).toEqual(historyBefore);
  });

  it.each([
    'failed',
    'interrupted',
    'closed',
  ] as const)('retires a %s predecessor binding after admission without rewriting Core history', async (status) => {
    const coreDb = openCommitFixtureCore();
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const turn = createAssignedTurn(store, 'ws_demo', 'th_demo', 'Admit successor after terminal');
    const predecessorCompatibilityKey = `sha256:${'a'.repeat(64)}`;
    const freshCompatibilityKey = `sha256:${'b'.repeat(64)}`;
    store.createAgentSession({
      agentId: 'agent_codex_host',
      createdAt: '2026-08-20T00:00:00.000Z',
      id: 'as-older-failed',
      message: null,
      policySnapshotId: 'worker_turn_launch_policy',
      sessionCompatibilityKey: predecessorCompatibilityKey,
      status: 'failed',
      threadId: turn.threadId,
      updatedAt: '2026-08-20T00:00:00.000Z',
      workspaceId: turn.workspaceId,
    });
    store.createAgentSession({
      agentId: 'agent_codex_host',
      createdAt: '2026-08-21T00:00:00.000Z',
      id: 'as-terminal-predecessor',
      message: null,
      policySnapshotId: 'worker_turn_launch_policy',
      sessionCompatibilityKey: predecessorCompatibilityKey,
      status,
      threadId: turn.threadId,
      updatedAt: '2026-08-21T00:00:00.000Z',
      workspaceId: turn.workspaceId,
    });
    const events: string[] = [];
    let finishClose!: () => void;
    const closeGate = new Promise<void>((resolve) => {
      finishClose = resolve;
    });
    const continuity = vi.fn(
      async (input: { readonly agentSessionId: string; readonly reuseAllowed: boolean }) => {
        events.push(
          input.reuseAllowed ? `inspect:${input.agentSessionId}` : `close:${input.agentSessionId}`
        );
        if (input.agentSessionId !== 'as-terminal-predecessor') {
          throw new Error('Fresh identity must not inspect the blocking Thread binding.');
        }
        if (input.reuseAllowed) return 'replacement-required' as const;
        await closeGate;
        return 'closed' as const;
      }
    );
    const backend = new FakeWorkerGovernanceBackend();
    Object.assign(backend, {
      prepareAgentSessionContinuity: continuity,
      readThreadAgentSessionBinding: (input: {
        readonly threadId: string;
        readonly workspaceId: string;
      }) =>
        input.threadId === turn.threadId && input.workspaceId === turn.workspaceId
          ? { agentSessionId: 'as-terminal-predecessor' }
          : null,
    });
    const executor = new WorkerGovernanceTurnExecutor({
      backend,
      coreDb,
      now: () => '2026-09-17T00:00:01.000Z',
    });
    Object.assign(executor, {
      previewAgentSessionCompatibilityKey: (agentSessionId: string) =>
        agentSessionId === 'as-fresh-after-terminal'
          ? freshCompatibilityKey
          : predecessorCompatibilityKey,
    });
    const preparation = {
      agentSetup: createTestAgentSetup(),
      freshAgentSessionId: 'as-fresh-after-terminal',
      requestId: 'req-terminal-predecessor',
      turn,
      turnInput: 'Admit successor after terminal',
      workspaceCwd: null,
      workspaceRoots: [],
    };
    const historyBefore = store.listThreadTurns(turn.workspaceId, turn.threadId);
    const prepared = await executor.prepareAgentSessionForTurn(store, preparation);
    expect(prepared).toMatchObject({
      agentSessionId: 'as-fresh-after-terminal',
      currentAgentSession: { id: 'as-terminal-predecessor', status },
      replacementRequired: true,
      sessionCompatibilityKey: freshCompatibilityKey,
    });
    acquireCommitFixtureAttempt(coreDb, preparation, 'lease-terminal-predecessor');
    const committed = executor.commitPreparedAgentSessionForTurn(store, {
      attemptId: 'lease-terminal-predecessor',
      prepared,
      preparation,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(events).toEqual([
      'inspect:as-terminal-predecessor',
      'inspect:as-terminal-predecessor',
      'inspect:as-terminal-predecessor',
      'close:as-terminal-predecessor',
    ]);
    expect(store.getAgentSession('as-terminal-predecessor').status).toBe(status);
    expect(store.getAgentSession('as-older-failed').status).toBe('failed');
    expect(() => store.getAgentSession('as-fresh-after-terminal')).toThrow();
    finishClose();
    await committed;
    expect(store.getAgentSession('as-terminal-predecessor')).toMatchObject({
      status,
      updatedAt: '2026-08-21T00:00:00.000Z',
    });
    expect(store.getAgentSession('as-older-failed').status).toBe('failed');
    expect(() => store.getAgentSession('as-fresh-after-terminal')).toThrow();
    expect(store.listThreadTurns(turn.workspaceId, turn.threadId)).toEqual(historyBefore);
  });

  it.each([
    {
      name: 'active Turn',
      expected: 'The current AgentSession still owns an active Turn.',
      setup: 'active' as const,
    },
    {
      name: 'foreign Thread',
      expected: null,
      setup: 'foreign' as const,
    },
    {
      name: 'refused close',
      expected: 'The worker backend did not retire predecessor AgentSession continuity.',
      setup: 'refused' as const,
    },
    {
      name: 'absent binding',
      expected: null,
      setup: 'absent' as const,
    },
  ])('keeps the uniqueness barrier for a $name predecessor binding', async ({
    expected,
    setup,
  }) => {
    const coreDb = openCommitFixtureCore();
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const predecessorTurn = createAssignedTurn(
      store,
      'ws_demo',
      'th_demo',
      'Terminal predecessor work'
    );
    store.createThread(predecessorTurn.workspaceId, 'Foreign thread', 'th_other');
    const turn = createAssignedTurn(store, 'ws_demo', 'th_demo', 'Keep predecessor barrier');
    const foreignTurn = createAssignedTurn(store, 'ws_demo', 'th_other', 'Foreign thread work');
    store.createAgentSession({
      agentId: 'agent_codex_host',
      createdAt: '2026-08-21T00:00:00.000Z',
      id: 'as-local-predecessor',
      message: null,
      policySnapshotId: 'worker_turn_launch_policy',
      sessionCompatibilityKey: `sha256:${'c'.repeat(64)}`,
      status: 'failed',
      threadId: turn.threadId,
      updatedAt: '2026-08-21T00:00:00.000Z',
      workspaceId: turn.workspaceId,
    });
    store.createAgentSession({
      agentId: 'agent_codex_host',
      createdAt: '2026-08-21T00:00:00.000Z',
      id: 'as-foreign-predecessor',
      message: null,
      policySnapshotId: 'worker_turn_launch_policy',
      sessionCompatibilityKey: `sha256:${'c'.repeat(64)}`,
      status: 'failed',
      threadId: foreignTurn.threadId,
      updatedAt: '2026-08-21T00:00:00.000Z',
      workspaceId: turn.workspaceId,
    });
    if (setup === 'active') {
      store.updateTurn(predecessorTurn.id, {
        agentSessionId: 'as-local-predecessor',
        status: 'running',
      });
    }
    const inspected = new Set<string>();
    const continuity = vi.fn(
      async (input: { readonly agentSessionId: string; readonly reuseAllowed: boolean }) => {
        inspected.add(input.agentSessionId);
        if (input.agentSessionId === 'as-foreign-predecessor') {
          throw new Error('Foreign Thread binding must not be closed.');
        }
        if (!input.reuseAllowed) {
          return setup === 'refused' ? ('replacement-required' as const) : ('closed' as const);
        }
        return input.agentSessionId === 'as-local-predecessor'
          ? ('replacement-required' as const)
          : ('absent' as const);
      }
    );
    const backend = new FakeWorkerGovernanceBackend();
    Object.assign(backend, {
      prepareAgentSessionContinuity: continuity,
      readThreadAgentSessionBinding: (input: {
        readonly threadId: string;
        readonly workspaceId: string;
      }) =>
        setup === 'foreign' ||
        setup === 'absent' ||
        input.threadId !== turn.threadId ||
        input.workspaceId !== turn.workspaceId
          ? null
          : { agentSessionId: 'as-local-predecessor' },
    });
    const executor = new WorkerGovernanceTurnExecutor({ backend, coreDb });
    Object.assign(executor, {
      previewAgentSessionCompatibilityKey: () => `sha256:${'d'.repeat(64)}`,
    });
    const preparation = {
      agentSetup: createTestAgentSetup(),
      freshAgentSessionId: 'as-fresh-barrier',
      requestId: 'req-terminal-barrier',
      turn,
      turnInput: 'Keep predecessor barrier',
      workspaceCwd: null,
      workspaceRoots: [],
    };
    if (expected && setup !== 'refused') {
      await expect(executor.prepareAgentSessionForTurn(store, preparation)).rejects.toThrow(
        expected
      );
    } else {
      const prepared = await executor.prepareAgentSessionForTurn(store, preparation);
      if (setup === 'foreign' || setup === 'absent') {
        expect(prepared).toMatchObject({
          agentSessionId: 'as-fresh-barrier',
          currentAgentSession: null,
          replacementRequired: false,
        });
        expect(inspected.has('as-local-predecessor')).toBe(false);
      } else {
        acquireCommitFixtureAttempt(coreDb, preparation, 'lease-terminal-barrier');
        await expect(
          executor.commitPreparedAgentSessionForTurn(store, {
            attemptId: 'lease-terminal-barrier',
            prepared,
            preparation,
          })
        ).rejects.toThrow(expected);
      }
    }
    expect(inspected.has('as-foreign-predecessor')).toBe(false);
    expect(store.getAgentSession('as-local-predecessor').status).toBe('failed');
    expect(store.getAgentSession('as-foreign-predecessor').status).toBe('failed');
  });

  it.each([
    false,
    true,
  ])('uses a fresh work slot only for explicit fresh storage (%s)', async (fresh) => {
    const store = createDemoStore();
    const turn = createAssignedTurn(store, 'ws_demo', 'th_demo', 'Inspect the repository');
    const residentSlot = 'wsl_retained_predecessor';
    const resolveResident = vi.fn(() => residentSlot);
    const inspectContinuity = vi.fn(async () => 'absent' as const);
    const backend = new FakeWorkerGovernanceBackend();
    Object.assign(backend, { prepareAgentSessionContinuity: inspectContinuity });
    const executor = new WorkerGovernanceTurnExecutor({
      backend,
      resolveResidentWorkerStorageWorkSlotRef: resolveResident,
    });
    await executor.prepareAgentSessionForTurn(store, {
      agentSetup: createTestAgentSetup(),
      freshAgentSessionId: 'as_storage_choice_preview',
      requestId: '00000000-0000-4000-8000-00000000b002',
      turn,
      turnInput: 'Inspect the repository',
      workspaceCwd: null,
      workspaceRoots: [],
      ...(fresh
        ? { workerStorageChoice: { kind: 'fresh' as const, goalId: null, taskId: null } }
        : {}),
    });
    expect(inspectContinuity).toHaveBeenCalledWith(
      expect.objectContaining({
        environmentPackage: expect.objectContaining({
          extensions: expect.objectContaining({
            openkit: expect.objectContaining({
              workerStorage: {
                workSlotRef: fresh
                  ? workerStorageDefaultWorkSlotRef(turn.workspaceId, turn.threadId)
                  : residentSlot,
              },
            }),
          }),
        }),
      })
    );
    if (fresh) expect(resolveResident).not.toHaveBeenCalled();
    else expect(resolveResident).toHaveBeenCalled();
  });

  it('starts an ordinary product Turn from the real pre-lease preview key without a Context Package', async () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-governance-preview-launch-')));
    applyMigrations(coreDb);

    try {
      const store = createDemoStore({ dataRoot: coreDb.dataRoot });
      const turnInput = 'Start from the pre-lease preview key';
      const turn = createAssignedTurn(store, 'ws_demo', 'th_demo', turnInput);
      const backend = new FakeWorkerGovernanceBackend();
      Object.assign(backend, {
        prepareAgentSessionContinuity: async () => 'absent' as const,
      });
      const agentSetup = createTestAgentSetup();
      const agentSessionId = 'as_preview_launch_key';
      const executor = new WorkerGovernanceTurnExecutor({
        backend,
        coreDb,
        createAgentSessionId: () => agentSessionId,
        now: () => '2026-08-21T12:00:00.000Z',
      });
      const workspaceCwd = null;
      const workspaceRoots: [] = [];
      const prepared = await executor.prepareAgentSessionForTurn(store, {
        agentSetup,
        freshAgentSessionId: agentSessionId,
        requestId: '00000000-0000-4000-8000-00000000b001',
        turn,
        turnInput,
        workspaceCwd,
        workspaceRoots,
      });
      const sandboxBindingRef = `lease-binding:${turn.id}`;
      recordExecutorAttempt(coreDb, {
        admittedAt: '2026-08-21T11:59:59.000Z',
        agentSessionId,
        packageSnapshotId: `aepsnap_${turn.id}_${agentSessionId}`,
        sandboxBindingRef,
        threadId: turn.threadId,
        turnId: turn.id,
      });

      await expect(
        executor.startTurn(store, turn.id, turnInput, {
          attemptId: `lease_${turn.id}`,
          agentSessionId: prepared.agentSessionId,
          agentSetup,
          requestId: '00000000-0000-4000-8000-00000000b001',
          sandboxBindingRef,
          sessionCompatibilityKey: prepared.sessionCompatibilityKey,
          triggerActor: { kind: 'user', id: 'user_local' },
          workspaceCwd,
          workspaceRoots,
        })
      ).resolves.toBeUndefined();

      expect(backend.calls[0]).toBe('materialize');
      expect(store.getAgentSession(prepared.agentSessionId).sessionCompatibilityKey).toBe(
        prepared.sessionCompatibilityKey
      );
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('advertises interrupts only with the worker-control gateway and a backend interrupt channel', () => {
    const backend = new FakeWorkerGovernanceBackend();
    const interruptible = interruptibleBackend();
    const withoutGateway = new WorkerGovernanceTurnExecutor({ backend: interruptible });
    const withoutChannel = new WorkerGovernanceTurnExecutor({
      backend,
      workerControlGateway: new WorkerControlGateway(),
    });
    const withBoth = new WorkerGovernanceTurnExecutor({
      backend: interruptible,
      workerControlGateway: new WorkerControlGateway(),
    });

    expect(withoutGateway.capabilities.interrupts).toBe(false);
    expect(withoutChannel.capabilities.interrupts).toBe(false);
    expect(withBoth.capabilities.interrupts).toBe(true);
  });

  it('preserves the first exact terminal report after cancellation and closes the Turn as interrupted', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime('2026-07-15T00:00:10.000Z');
    const f = await launchFinalReviewWorker('cancel');
    try {
      expect(f.executor.isTurnExecutionActive(f.turn.id)).toBe(true);
      await f.executor.interruptTurn(f.store, f.turn.id);
      expect(attempts.requireSchedulerExecutionAttempt(f.coreDb, f.attemptId)).toMatchObject({
        phase: 'closing',
        terminalCause: 'turn-cancelled',
      });
      // WCP cancellation wins the product race; the worker's first report still belongs to its exact durable evidence stream.
      f.backend.eventsJsonlFactory = () =>
        `${JSON.stringify(
          buildWorkerCanonicalTerminalEventRecord({
            lineage: f.lineage,
            sequence: 1,
            data: { status: 'completed', stopReason: 'completed' },
          })
        )}\n`;
      f.gateway.recordFinalStatus({
        authorization: `Bearer ${f.token}`,
        lineage: f.lineage,
        sequence: 1,
        status: 'completed',
        stopReason: 'completed',
      });
      expect(getWorkerControlAcceptedFinalStatus(f.coreDb, f.lineage)).toMatchObject({
        status: 'completed',
        stopReason: 'completed',
      });
      const readFinalRow = () =>
        f.coreDb.sqlite
          .prepare(`SELECT * FROM worker_control_records
        WHERE workspace_id = ? AND thread_id = ? AND turn_id = ? AND agent_session_id = ?
          AND package_snapshot_id = ? AND request_id IS ? AND operation = 'final_status'`)
          .get(
            f.lineage.workspaceId,
            f.lineage.threadId,
            f.lineage.turnId,
            f.lineage.agentSessionId,
            f.lineage.packageSnapshotId,
            f.lineage.requestId
          ) as { sequence: number; record_key: string; record_json: string } | undefined;
      const acceptedRow = readFinalRow();
      expect(acceptedRow).toMatchObject({ sequence: 1, record_key: '1' });
      expect(JSON.parse(acceptedRow!.record_json)).toMatchObject({
        sequence: 1,
        status: 'completed',
        stopReason: 'completed',
      });
      expect(await Promise.race([f.execution, delay(2000, 'completion-timeout')])).toBeNull();
      const terminal = f.store.getTurnById(f.turn.id);
      expect(terminal.status).toBe('interrupted');
      expect(f.store.getTurnEvents(f.turn.id)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: 'turn.completed',
            data: expect.objectContaining({ type: 'turn-completed', stopReason: 'aborted' }),
          }),
        ])
      );
      expect(getWorkerControlAcceptedFinalStatus(f.coreDb, f.lineage)).toMatchObject({
        status: 'completed',
        stopReason: 'completed',
      });
      expect(readFinalRow()).toEqual(acceptedRow);
      completeOwnedTerminalAttempt(f.coreDb, terminal);
    } finally {
      await f.dispose();
      vi.useRealTimers();
    }
  });

  it.each([
    'heartbeat',
    'startup',
  ] as const)('wakes the real final-status waiter at the %s deadline while execution is active', async (deadlineKind) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime('2026-07-15T00:00:10.000Z');
    const f = await launchFinalReviewWorker(`active-${deadlineKind}`);
    try {
      if (deadlineKind === 'heartbeat') {
        acceptNanoHostAttemptHeartbeat(f.coreDb, {
          attemptId: f.attemptId,
          heartbeatTimeoutMs: 30_000,
          workerSequence: 0,
          workerProcessKeyHash: createHash('sha256')
            .update('owned-worker-process')
            .digest('base64url'),
        });
        acceptNanoHostAttemptHeartbeat(f.coreDb, {
          attemptId: f.attemptId,
          heartbeatTimeoutMs: 30_000,
          workerSequence: 1,
        });
      }
      const live = requireNanoHostExecutionAttempt(f.coreDb, f.attemptId);
      const timeoutAt =
        deadlineKind === 'heartbeat' ? live.heartbeatDeadline : live.startupDeadline;
      expect(Date.parse(timeoutAt)).toBeLessThan(Date.parse(live.deadline!) - 60_000);
      vi.setSystemTime(timeoutAt);
      expect(f.executor.isTurnExecutionActive(f.turn.id)).toBe(true);
      await runNanoHostAttemptRecoveryMaintenance(f.coreDb, {
        executionBackend: f.backend,
        store: f.store,
        isTurnExecutionActive: (turnId) => f.executor.isTurnExecutionActive(turnId),
        cleanupBackendSession: () => f.backend.cleanupSession(),
        prepareBackendCleanup: () => {},
        restoreBackendSession: async () => {},
        reconcileAcceptedFinalStatus: async () => {
          throw new Error('No terminal report was sent.');
        },
        projectRecoveredTurn: async () => {
          throw new Error('The active executor owns product closeout.');
        },
      });
      expect(requireNanoHostExecutionAttempt(f.coreDb, f.attemptId)).toMatchObject({
        phase: 'closing',
        terminalCause: 'native-liveness-expired',
      });
      await Promise.race([f.execution, delay(2000)]);
      expect(f.settled()).toBe(true);
      expect(f.executor.isTurnExecutionActive(f.turn.id)).toBe(false);
      expect(Date.now()).toBeLessThan(Date.parse(live.deadline!) - 60_000);
    } finally {
      await f.dispose();
      vi.useRealTimers();
    }
  });

  it('delegates exactly one same-attempt interrupt to the backend without owning terminal lifecycle', async () => {
    const coreDb = openCommitFixtureCore();
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const turn = createAssignedTurn(
      store,
      'ws_demo',
      'th_demo',
      'Keep the one-shot worker running'
    );
    const backend = interruptibleBackend();
    const workerControlGateway = new WorkerControlGateway({
      now: () => '2026-08-12T00:00:00.000Z',
    });
    const { agentSessionId, packageSnapshotId } = bindInterruptAttempt(
      store,
      workerControlGateway,
      turn
    );
    recordExecutorAttempt(coreDb, {
      agentSessionId,
      packageSnapshotId,
      sandboxBindingRef: `lease-binding:${turn.id}`,
      threadId: turn.threadId,
      turnId: turn.id,
    });
    const operation = attempts.recordSchedulerExecutionOperation(coreDb, {
      attemptId: `lease_${turn.id}`,
      operationId: `submit:${turn.id}`,
      submission: true,
    });
    attempts.acceptSchedulerExecutionObservation(coreDb, {
      ...attempts.schedulerExecutionCorrelation(operation),
      disposition: 'accepted',
      execution: 'pending',
      fenceRef: null,
      outcomeRef: null,
    });
    const cancel = vi.spyOn(backend, 'cancel');
    const executor = new WorkerGovernanceTurnExecutor({
      backend,
      coreDb,
      workerControlGateway,
    });
    const turnBeforeInterrupt = store.getTurnById(turn.id);
    const sessionBeforeInterrupt = store.getAgentSession(agentSessionId);
    const eventsBeforeInterrupt = store.getTurnEvents(turn.id);

    await executor.interruptTurn(store, turn.id, { requestId: 'req_interrupt_exact' });

    expect(cancel).toHaveBeenCalledExactlyOnceWith(
      attempts.schedulerExecutionCorrelation(
        attempts.requireSchedulerExecutionAttempt(coreDb, `lease_${turn.id}`)
      )
    );
    expect(backend.interruptTurn).not.toHaveBeenCalled();
    expect(attempts.requireSchedulerExecutionAttempt(coreDb, `lease_${turn.id}`)).toMatchObject({
      phase: 'closing',
      terminalCause: 'turn-cancelled',
    });
    await expect(executor.interruptTurn(store, turn.id)).rejects.toThrow(
      'Turn cancellation is already owned or has no live attempt.'
    );
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(workerControlGateway.getSessionSnapshot(packageSnapshotId)).not.toHaveProperty(
      'commands'
    );
    expect(store.getTurnById(turn.id)).toEqual(turnBeforeInterrupt);
    expect(store.getAgentSession(agentSessionId)).toEqual(sessionBeforeInterrupt);
    expect(store.getTurnEvents(turn.id)).toEqual(eventsBeforeInterrupt);
    expect(backend.calls).toEqual([]);
  });

  it.each([
    'missing-agent-session',
    'stale-agent-session',
    'terminal-turn',
    'lineage-mismatch',
    'missing-package-snapshot',
    'package-snapshot-mismatch',
  ])('fails closed for %s interrupt without reaching the backend', async (failureMode) => {
    const store = createDemoStore();
    const turn = createAssignedTurn(store, 'ws_demo', 'th_demo', `Reject ${failureMode} interrupt`);
    const workerControlGateway = new WorkerControlGateway();
    const backend = interruptibleBackend();
    const executor = new WorkerGovernanceTurnExecutor({
      backend,
      workerControlGateway,
    });

    if (failureMode !== 'missing-agent-session') {
      const { agentSessionId } = bindInterruptAttempt(
        store,
        workerControlGateway,
        turn,
        failureMode === 'lineage-mismatch' ? `${turn.id}_other` : turn.id
      );
      if (failureMode === 'stale-agent-session') {
        store.updateAgentSession(agentSessionId, { stale: true });
      }
      if (failureMode === 'terminal-turn') {
        store.updateTurn(turn.id, {
          completedAt: '2026-08-12T00:01:00.000Z',
          status: 'interrupted',
        });
      }
      if (failureMode === 'missing-package-snapshot') {
        store.updateAgentSession(agentSessionId, { environmentPackageSnapshotId: null });
      }
      if (failureMode === 'package-snapshot-mismatch') {
        store.updateAgentSession(agentSessionId, {
          environmentPackageSnapshotId: `aepsnap_interrupt_${turn.id}_other`,
        });
      }
    }
    const turnBeforeInterrupt = store.getTurnById(turn.id);

    await expect(
      executor.interruptTurn(store, turn.id, { requestId: `req_${failureMode}` })
    ).rejects.toThrow();

    expect(backend.interruptTurn).not.toHaveBeenCalled();
    expect(store.getTurnById(turn.id)).toEqual(turnBeforeInterrupt);
  });

  it.each([
    { expectedStatus: 'completed', mode: 'exact' },
    { expectedStatus: 'failed', mode: 'missing' },
    { expectedStatus: 'failed', mode: 'many-missing' },
    { expectedStatus: 'failed', mode: 'invalid-json' },
    { expectedStatus: 'failed', mode: 'conflict' },
    { expectedStatus: 'failed', mode: 'artifact-invalid' },
  ] as const)('reconciles $mode transcript events against durable live acceptance', async ({
    expectedStatus,
    mode,
  }) => {
    const appLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const coreDb = openCoreDb(
      mkdtempSync(join(tmpdir(), `openkit-governance-live-events-${mode}-`))
    );
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const turn = createAssignedTurn(store, 'ws_demo', 'th_demo', `Reconcile ${mode} worker events`);
    const backend = new FakeWorkerGovernanceBackend();
    backend.artifactCollectionInvalid = mode === 'artifact-invalid';
    backend.eventsJsonlFactory = (environmentPackage) => {
      if (mode === 'invalid-json') {
        return '{private-transcript-payload\n';
      }
      const lineage: WorkerLineage = {
        agentSessionId: environmentPackage.scope.agentSessionId,
        packageSnapshotId: environmentPackage.snapshotId,
        requestId: environmentPackage.scope.requestId,
        threadId: environmentPackage.scope.threadId,
        turnId: environmentPackage.scope.turnId,
        workspaceId: environmentPackage.scope.workspaceId,
      };
      const transcriptRecord = WorkerCanonicalEventRecordSchema.parse({
        event: { data: { status: 'private-transcript-payload' }, type: 'worker.heartbeat' },
        kind: 'event',
        lineage,
        schemaVersion: 1,
        sequence: 0,
      });

      if (mode !== 'missing' && mode !== 'many-missing') {
        const acceptedRecord: WorkerCanonicalEventRecord =
          mode === 'conflict'
            ? WorkerCanonicalEventRecordSchema.parse({
                ...transcriptRecord,
                event: { data: { status: 'different' }, type: 'worker.heartbeat' },
              })
            : transcriptRecord;
        recordWorkerControlAcceptedRecord(coreDb, {
          acceptedAt: '2026-07-15T00:00:00.000Z',
          lineage,
          operation: 'event_append',
          record: acceptedRecord,
          recordKey: String(acceptedRecord.sequence),
          sequence: acceptedRecord.sequence,
        });
      }

      return mode === 'many-missing'
        ? Array.from({ length: 40 }, (_, sequence) =>
            JSON.stringify({ ...transcriptRecord, sequence })
          ).join('\n')
        : `${JSON.stringify(transcriptRecord)}\n`;
    };
    const executor = new WorkerGovernanceTurnExecutor({
      backend,
      coreDb,
      createAgentSessionId: () => `as_governance_live_events_${mode}`,
      environmentBackend: {
        kind: 'openshell',
      },
      now: () => '2026-07-15T00:00:01.000Z',
    });
    const requestId = {
      conflict: '00000000-0000-4000-8000-000000000233',
      exact: '00000000-0000-4000-8000-000000000231',
      missing: '00000000-0000-4000-8000-000000000232',
      'many-missing': '00000000-0000-4000-8000-000000000235',
      'invalid-json': '00000000-0000-4000-8000-000000000236',
      'artifact-invalid': '00000000-0000-4000-8000-000000000234',
    }[mode];
    const run = startWithExecutorAttempt(
      coreDb,
      executor,
      store,
      turn,
      `as_governance_live_events_${mode}`,
      '2026-07-15T00:00:00.000Z',
      `Reconcile ${mode} worker events`,
      {
        agentSetup: createTestAgentSetup(),
        requestId,
        triggerActor: turn.triggerActor,
        workspaceRoots: [],
      }
    );

    if (mode === 'exact') {
      await expect(run).resolves.toBeUndefined();
    } else if (mode === 'artifact-invalid') {
      await expect(run).rejects.toMatchObject({ code: 'invalid_request', status: 400 });
      expect(backend.calls.at(-1)).toBe('cleanupSession');
    } else {
      await expect(run).rejects.toThrow('Worker transcript event reconciliation failed');
      const diagnosticCode =
        mode === 'conflict'
          ? 'worker_transcript_live_event_conflict'
          : mode === 'invalid-json'
            ? 'worker_transcript_invalid_json'
            : 'worker_transcript_live_event_missing';
      const sequences =
        mode === 'many-missing'
          ? `${JSON.stringify(Array.from({ length: 32 }, (_, sequence) => sequence))}; omittedSequences=8`
          : mode === 'invalid-json'
            ? '[]'
            : '[0]';
      const detail = `${diagnosticCode}; rejectedEventSequences=${sequences}`;
      expect(store.getTurnById(turn.id).error).toMatchObject({
        code: 'worker_governance_turn_failed',
        message: expect.stringContaining(detail),
      });
      expect(appLog).toHaveBeenCalledWith(expect.stringContaining(detail));
      expect(createDemoStore({ dataRoot: coreDb.dataRoot }).getTurnById(turn.id).error).toEqual(
        store.getTurnById(turn.id).error
      );
      expect(appLog.mock.calls.flat().join(' ')).not.toContain('private-transcript-payload');
      expect(store.getTurnById(turn.id).error?.message).not.toContain('private-transcript-payload');
    }
    expect(store.getTurnById(turn.id).status).toBe(expectedStatus);
    appLog.mockRestore();
    coreDb.sqlite.close();
  });

  it('submits one live Artifact proposal through the accepted Context Package trace', async () => {
    const fixture = createWorkerContextExecutorFixture('artifact-review');
    const {
      agentSessionId,
      coreDb,
      material,
      materialContentDigest,
      requestId,
      revision,
      sandboxBindingRef,
      store,
      turn,
      workerRequest,
    } = fixture;
    const artifactBytes = Buffer.from('# Proposed material revision\n', 'utf8');
    const backend = new FakeWorkerGovernanceBackend();
    let artifactId: string | undefined;
    const launch = backend.submit.bind(backend);
    vi.spyOn(backend, 'submit').mockImplementation(async (input) => {
      const environmentPackage = backend.lastPackage!;
      const workspaceDb = openTestWorkspaceDb(coreDb);
      try {
        const result = await dispatchOpenkitWorkTool(
          {
            coreDb,
            store,
            workspaceDb,
            environmentPackage,
            captureArtifact: async () => ({
              bytes: artifactBytes,
              credentialCheckValues: (await backend.collectTranscript()).credentialCheckValues!,
            }),
          },
          'work_submit_artifact',
          {
            requestId: 'request_material_submission',
            path: `${environmentPackage.workspace.outputs[0]!.path}/report.md`,
            kind: 'report',
            mediaType: 'text/markdown',
            title: 'Governed worker report',
            materialProposal: {
              baseContentDigest: materialContentDigest,
              baseRevisionId: revision.revisionId,
              materialId: material.materialId,
            },
          }
        );
        artifactId = result.structuredContent.artifactId as string;
      } finally {
        workspaceDb.sqlite.close();
      }
      return launch(input);
    });
    const executor = new WorkerGovernanceTurnExecutor({
      backend,
      coreDb,
      createAgentSessionId: () => agentSessionId,
      environmentBackend: {
        kind: 'openshell',
      },
      now: () => '2026-07-15T00:00:03.000Z',
    });

    try {
      await executor.startTurn(store, turn.id, workerRequest, {
        attemptId: `lease_${turn.id}`,
        agentSessionId,
        agentSetup: createTestAgentSetup(),
        requestId,
        sandboxBindingRef,
        triggerActor: turn.triggerActor,
        workspaceRoots: [],
      });

      const packageSnapshotId = backend.lastPackage?.snapshotId;
      expect(packageSnapshotId).toBeTruthy();
      expect(artifactId).toEqual(expect.any(String));
      expect(store.getArtifact(turn.workspaceId, artifactId!)).toMatchObject({
        content: { body: artifactBytes.toString('utf8'), format: 'markdown' },
        contentDigest: turnRuntimeSha256(artifactBytes),
        origin: {
          kind: 'turn-output',
          requestId: 'request_material_submission',
          threadId: turn.threadId,
          turnId: turn.id,
        },
        status: 'ready',
        version: 1,
      });
      const workspaceDb = openTestWorkspaceDb(coreDb);
      expect(getArtifactReview(workspaceDb, artifactId!, 1)).toMatchObject({
        artifactId,
        artifactVersion: 1,
        decision: null,
        materialProposal: {
          baseContentDigest: materialContentDigest,
          baseRevisionId: revision.revisionId,
          materialId: material.materialId,
        },
        sourceAgentId: turn.agentId,
        sourceThreadId: turn.threadId,
        sourceTurnId: turn.id,
      });
      workspaceDb.sqlite.close();
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('rejects stale runtime authority before publishing worker output', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-governance-stale-publication-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    const turn = createAssignedTurn(store, 'ws_demo', 'th_demo', 'Do not publish stale output');
    const backend = new FakeWorkerGovernanceBackend();
    const collectTranscript = backend.collectTranscript.bind(backend);
    vi.spyOn(backend, 'collectTranscript').mockImplementation(async () => {
      const transcript = { ...(await collectTranscript()) };
      delete transcript.itemsJsonl;
      coreDb.sqlite.transaction(() => {
        disableCanonicalUser(coreDb, LOCAL_USER_ID, new Date('2026-07-15T00:00:02.000Z'));
      })();
      return transcript;
    });
    const runtimeProvenanceImporter = vi.fn(importWorkerRuntimeProvenance);
    const executor = new WorkerGovernanceTurnExecutor({
      backend,
      coreDb,
      createAgentSessionId: () => 'as_governance_stale_publication_1',
      environmentBackend: {
        kind: 'openshell',
      },
      now: () => '2026-07-15T00:00:03.000Z',
      runtimeProvenanceImporter,
    });

    try {
      await expect(
        startWithExecutorAttempt(
          coreDb,
          executor,
          store,
          turn,
          'as_governance_stale_publication_1',
          '2026-07-15T00:00:00.000Z',
          'Do not publish stale output',
          {
            agentSetup: createTestAgentSetup({
              requiredCapabilities: [
                'trusted-worker-inference-relay',
                'worker.runtime-provenance.v1',
              ],
            }),
            requestId: '00000000-0000-4000-8000-000000000235',
            triggerActor: turn.triggerActor,
            workspaceRoots: [],
          }
        )
      ).rejects.toMatchObject({ code: 'workspace_access_denied', status: 403 });

      expect(backend.calls).toEqual([
        'materialize',
        'submit',
        'collectEvidence',
        'collectTranscript',
        'cleanupSession',
      ]);
      expect(runtimeProvenanceImporter).not.toHaveBeenCalled();
      expect(store.listArtifacts(turn.workspaceId)).toEqual([]);
      const workspaceDb = openTestWorkspaceDb(coreDb);
      expect(listWorkspaceEvidenceBundles(workspaceDb, turn.workspaceId)).toEqual([]);
      workspaceDb.sqlite.close();
      expect(store.getTurnById(turn.id)).toMatchObject({
        error: { code: 'workspace_access_denied' },
        status: 'interrupted',
      });
      expect(store.getAgentSession('as_governance_stale_publication_1')).toMatchObject({
        status: 'interrupted',
      });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it.each([
    'workspace.write',
    'artifact.write',
    'deletion',
    'allowed',
  ] as const)('fences release collection publication with current %s authority', async (mode) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-collection-publication-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const fixture = createWorkspaceChangeIngressFixture(`publication_${mode}`, 'git');
    const publicationDb = openWorkspaceDb(dataRoot, fixture.workspaceId);
    applyScopedMigrations(publicationDb);
    publicationDb.sqlite.close();
    const mutationAdmission = new WorkspaceMutationAdmission();
    const authority = vi
      .spyOn(operationAuthorizer, 'currentWorkerLineageWorkspaceAuthority')
      .mockImplementation((_db, _lineage, operation) => (operation === mode ? null : 'owner'));
    const executor = new WorkerGovernanceTurnExecutor({
      backend: new FakeWorkerGovernanceBackend(),
      coreDb,
      environmentBackend: { kind: 'openshell' },
      workspaceMutationAdmission: mutationAdmission,
    });
    // This test isolates publication authorization; the real Git handoff tests exercise ingress bytes and review staging.
    const publish = vi
      .spyOn(
        executor as unknown as {
          createWorkspaceChangeArtifacts: (...args: unknown[]) => Promise<void>;
        },
        'createWorkspaceChangeArtifacts'
      )
      .mockResolvedValue();
    try {
      if (mode === 'deletion') await mutationAdmission.close(fixture.workspaceId);
      const run = executor.publishWorkspaceCollections(fixture.store, fixture.environmentPackage, [
        fixture.record,
      ]);
      if (mode === 'allowed') {
        await expect(run).resolves.toBeUndefined();
        expect(publish).toHaveBeenCalledOnce();
        expect(publish.mock.calls[0]?.[2]).toEqual([fixture.record]);
        expect(authority.mock.calls.map((call) => [call[2], call[3]])).toEqual([
          ['workspace.write', true],
          ['artifact.write', true],
        ]);
        // The publisher must release its admission after staging.
        await expect(mutationAdmission.close(fixture.workspaceId)).resolves.toBeUndefined();
      } else {
        await expect(run).rejects.toMatchObject({ code: 'workspace_access_denied', status: 403 });
        expect(publish).not.toHaveBeenCalled();
      }
    } finally {
      authority.mockRestore();
      publish.mockRestore();
      fixture.workspaceDb.sqlite.close();
      coreDb.sqlite.close();
      rmSync(dataRoot, { force: true, recursive: true });
    }
  });

  it('rejects worker output after the Workspace deletion fence closes', async () => {
    expect(WORKSPACE_MUTATION_LATE_PUBLISHERS).toEqual(['worker-turn-closeout']);
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-governance-deletion-fence-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    const turn = createAssignedTurn(store, 'ws_demo', 'th_demo', 'Do not publish fenced output');
    recordExecutorAttempt(coreDb, {
      agentSessionId: 'as_governance_deletion_fence_1',
      packageSnapshotId: `aepsnap_${turn.id}_as_governance_deletion_fence_1`,
      sandboxBindingRef: `lease-binding:${turn.id}`,
      threadId: turn.threadId,
      turnId: turn.id,
    });
    const backend = new FakeWorkerGovernanceBackend();
    const mutationAdmission = new WorkspaceMutationAdmission();
    const collectTranscript = backend.collectTranscript.bind(backend);
    vi.spyOn(backend, 'collectTranscript').mockImplementation(async () => {
      const transcript = await collectTranscript();
      await mutationAdmission.close(turn.workspaceId);
      return transcript;
    });
    const executor = new WorkerGovernanceTurnExecutor({
      backend,
      coreDb,
      createAgentSessionId: () => 'as_governance_deletion_fence_1',
      environmentBackend: { kind: 'openshell' },
      now: () => '2026-07-15T00:00:03.000Z',
      workspaceMutationAdmission: mutationAdmission,
    });

    try {
      await expect(
        executor.startTurn(store, turn.id, 'Do not publish fenced output', {
          attemptId: `lease_${turn.id}`,
          agentSessionId: 'as_governance_deletion_fence_1',
          sandboxBindingRef: `lease-binding:${turn.id}`,
          agentSetup: createTestAgentSetup(),
          requestId: '00000000-0000-4000-8000-000000000236',
          triggerActor: turn.triggerActor,
          workspaceRoots: [],
        })
      ).rejects.toMatchObject({ code: 'workspace_access_denied', status: 403 });
      expect(store.listArtifacts(turn.workspaceId)).toEqual([]);
      expect(store.getTurnById(turn.id)).toMatchObject({
        error: { code: 'workspace_access_denied' },
        status: 'interrupted',
      });
    } finally {
      coreDb.sqlite.close();
      rmSync(dataRoot, { force: true, recursive: true });
    }
  });

  it('refuses unadvertised runtime provenance before backend effects with a deterministic error', async () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-provenance-admission-')));
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const turn = createAssignedTurn(store, 'ws_demo', 'th_demo', 'Require unsupported provenance');
    const backend = new FakeWorkerGovernanceBackend();
    const validation = vi
      .spyOn(backend, 'validatePackage')
      .mockImplementation(async (...args: [AgentEnvironmentPackage]) => {
        const environmentPackage = args[0];
        return validateAgentEnvironmentPackageForBackend(environmentPackage, {
          capabilities: environmentPackage.backend.requiredCapabilities.filter(
            (capability) => capability !== 'worker.runtime-provenance.v1'
          ),
          dynamicCapabilities: [],
          kind: 'openshell',
        });
      });
    const executor = new WorkerGovernanceTurnExecutor({
      backend,
      coreDb,
      now: () => '2026-07-15T00:00:01.000Z',
    });
    try {
      const execution = startWithExecutorAttempt(
        coreDb,
        executor,
        store,
        turn,
        'as_unsupported_provenance',
        '2026-07-15T00:00:00.000Z',
        'Require unsupported provenance',
        {
          agentSetup: createTestAgentSetup({
            requiredCapabilities: [
              'trusted-worker-inference-relay',
              'worker.runtime-provenance.v1',
            ],
          }),
          triggerActor: turn.triggerActor,
          workspaceRoots: [],
        }
      );
      const failure = await execution.catch((error: unknown) => error);
      expect(validation).toHaveBeenCalledOnce();
      expect(backend.calls).toEqual([]);
      expect(failure).toBeInstanceOf(DeterministicAgentPreparationError);
      expect(failure).toMatchObject({
        message:
          'Backend openshell does not support required capability worker.runtime-provenance.v1.',
      });
      expect(store.listThreadAgentSessions(turn.workspaceId, turn.threadId)).toEqual([]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('imports worker transcript records and tears down the materialized backend session', async () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-governance-records-')));

    applyMigrations(coreDb);

    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const turn = createAssignedTurn(store, 'ws_demo', 'th_demo', 'Run in OpenShell');
    store.updateTurn(turn.id, { agentId: 'agent_opencode_host' });
    const completedAt = new Date(
      new Date(turn.startedAt ?? Date.now()).getTime() + 1000
    ).toISOString();
    const backend = new FakeWorkerGovernanceBackend({ sandboxName: 'sandbox_governance_1' });
    const cleanupSession = vi.spyOn(backend, 'cleanupSession');
    const executor = new WorkerGovernanceTurnExecutor({
      backend,
      coreDb,
      createAgentSessionId: () => 'as_governance_1',
      environmentBackend: {
        kind: 'openshell',
      },
      now: () => completedAt,
    });

    await startWithExecutorAttempt(
      coreDb,
      executor,
      store,
      turn,
      'as_governance_1',
      completedAt,
      'Run in OpenShell',
      {
        agentSetup: createTestAgentSetup({
          agentId: 'agent_opencode_host',
          displayName: 'OpenCode Agent',
          provider: {
            model: 'gpt-5-codex',
            origin: 'server-providers',
            providerId: 'agent-openrouter',
            secretRef: null,
          },
        }),
        requestId: '00000000-0000-4000-8000-000000000201',
        triggerActor: {
          kind: 'automation',
          id: 'automation_governance_test',
          responsibleUserId: 'user_local',
        },
        workspaceCwd: null,
        ...remoteGitInputFixture(),
      }
    );

    expect(backend.calls).toEqual([
      'materialize',
      'submit',
      'collectEvidence',
      'collectTranscript',
      'collectWorkspaceChanges',
      'cleanupSession',
    ]);
    expect(cleanupSession).toHaveBeenCalledOnce();
    expect(cleanupSession.mock.calls[0]).toHaveLength(1);
    expect(backend.lastPackage?.extensions.openkit).toMatchObject({
      turnInput: 'Run in OpenShell',
    });
    expect(backend.lastPackage?.scope.triggerActor).toEqual({
      kind: 'automation',
      id: 'automation_governance_test',
      responsibleUserId: 'user_local',
    });
    expect(backend.lastPackage?.agent).toEqual({
      agentId: 'agent_opencode_host',
      capabilityRequests: [],
      displayName: 'OpenCode Agent',
      instructions: [],
      profileId: 'default',
      profileKind: null,
      runtimeKind: 'codex',
      runtimeVersion: 'test',
    });
    expect(backend.lastPackage?.llm.routes[0]?.model).toBe('openai/gpt-5.2');
    const expectedWorktree = `/workspace/worktrees/${workerStorageDefaultWorkSlotRef(
      turn.workspaceId,
      turn.threadId
    )}`;
    expect(backend.lastPackage?.runtime.command.workingDirectory).toBe(expectedWorktree);
    expect(backend.lastContext?.workspaceRoots).toEqual([
      expect.objectContaining({
        id: 'repo',
        sourceKind: 'remote-git',
        workerPath: '/workspace/openkit',
      }),
    ]);
    expect(store.getTurnById(turn.id)).toMatchObject({
      agentId: 'agent_opencode_host',
      agentProfileId: 'default',
      agentSessionId: 'as_governance_1',
      status: 'completed',
      completedAt,
    });
    const storedSession = store.getAgentSession('as_governance_1');
    expect(storedSession).toMatchObject({
      environmentPackageSnapshotId: `aepsnap_${turn.id}_as_governance_1`,
      policySnapshotId: 'worker_turn_launch_policy',
      sessionCompatibilityKey: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      status: 'idle',
    });
    expect(storedSession).not.toHaveProperty('environmentPackageSnapshot');
    expect(
      store
        .listThreadItems('ws_demo', 'th_demo')
        .filter((item) => item.type === 'assistant-message')
    ).toEqual([
      expect.objectContaining({
        text: 'Governed worker completed the task.',
        status: 'completed',
      }),
    ]);
    expect(store.listArtifacts('ws_demo')).toEqual([]);
    const workspaceDb = openTestWorkspaceDb(coreDb);
    expect(listWorkspaceInputSnapshots(workspaceDb, 'ws_demo')).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^wis_/),
        resourceId: 'repo',
        strategy: 'git',
      }),
    ]);
    expect(listWorkspaceMaterializationRecords(workspaceDb, 'ws_demo')).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^wmr_/),
        inputSnapshotId: expect.stringMatching(/^wis_/),
        materializedRootRef: expectedWorktree,
        workerSessionId: 'sandbox_governance_1',
      }),
    ]);
    expect(listBackendWorkspaceHandles(workspaceDb, 'ws_demo')).toEqual([
      expect.objectContaining({
        cleanupStatus: 'cleaned',
        packageSnapshotId: `aepsnap_${turn.id}_as_governance_1`,
        workerSessionId: 'sandbox_governance_1',
      }),
    ]);
    expect(
      listWorkspaceRuntimeEvidence(workspaceDb, 'ws_demo').filter(
        (record) => record.phase === 'teardown'
      )
    ).toEqual([
      expect.objectContaining({
        agentSessionId: 'as_governance_1',
        backendType: 'openshell',
        backendVersion: '0.0.63',
        outcome: 'succeeded',
        phase: 'teardown',
        placement: 'local',
        stopReason: 'completed',
        summary: 'Worker backend teardown succeeded.',
        threadId: 'th_demo',
        turnId: turn.id,
        workerImage: 'openkit/worker-codex:dev',
      }),
    ]);
    expect(listWorkspaceChangeSets(workspaceDb, 'ws_demo')).toEqual([]);
    expect(listWorkspaceSyncReviews(workspaceDb, 'ws_demo')).toEqual([]);
    expect(
      requireAgentEnvironmentPackageSnapshot(
        workspaceDb,
        'ws_demo',
        `aepsnap_${turn.id}_as_governance_1`
      )
    ).toMatchObject({
      snapshotId: `aepsnap_${turn.id}_as_governance_1`,
      workspaceId: 'ws_demo',
      turnId: turn.id,
      agentSessionId: 'as_governance_1',
      agentId: 'agent_opencode_host',
    });

    workspaceDb.sqlite.close();
    coreDb.sqlite.close();
  });

  it.each([
    'failed',
    'completed',
    'over-16-kib',
  ] as const)('preserves accepted diagnostics in one failure closeout log: %s', async (kind) => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-failure-log-')));
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const turn = createAssignedTurn(store, 'ws_demo', 'th_demo', 'Inspect failure diagnostics');
    const diagnostics = {
      ...(kind === 'over-16-kib'
        ? Object.fromEntries(
            Array.from({ length: 17 }, (_, index) => [`summary${index}`, 'x'.repeat(1000)])
          )
        : {}),
      timeline: JSON.stringify({
        startedAt: '2026-10-05T00:00:00.000Z',
        entries: Array.from({ length: 8 }, (_, ms) => ({
          label: 'heartbeat',
          reason: 'accepted',
          ms,
          durationMs: 0,
        })),
        dropped: 0,
      }),
    };
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const executor = new WorkerGovernanceTurnExecutor({
      awaitWorkerCompletion: async () => ({
        acceptedAt: '2026-07-15T00:00:03.000Z',
        status: kind === 'completed' ? 'completed' : 'failed',
        stopReason: kind === 'completed' ? 'completed' : 'error',
        diagnostics,
      }),
      backend: new FakeWorkerGovernanceBackend(),
      coreDb,
      createAgentSessionId: () => 'as_failure_log',
      environmentBackend: { kind: 'openshell' },
      now: () => '2026-07-15T00:00:03.000Z',
    });
    try {
      await startWithExecutorAttempt(
        coreDb,
        executor,
        store,
        turn,
        'as_failure_log',
        '2026-07-15T00:00:00.000Z',
        'Inspect failure diagnostics',
        {
          agentSetup: createTestAgentSetup(),
          requestId: '00000000-0000-4000-8000-000000000253',
          triggerActor: turn.triggerActor,
          workspaceRoots: [],
        }
      );
      if (kind === 'completed') {
        expect(log).not.toHaveBeenCalled();
      } else {
        expect(log).toHaveBeenCalledTimes(1);
        const line = log.mock.calls[0]![0] as string;
        const record = JSON.parse(line);
        expect(record).toMatchObject({
          event: 'worker.turn.failed',
          turnId: turn.id,
          status: 'failed',
          diagnostics: { timeline: diagnostics.timeline },
        });
        expect(record.diagnostics).toEqual(diagnostics);
        expect(record).not.toHaveProperty('droppedDiagnostics');
        if (kind === 'over-16-kib') {
          const bytes = Buffer.byteLength(JSON.stringify(diagnostics));
          expect(bytes).toBeGreaterThan(16 * 1024);
          expect(bytes).toBeLessThan(64 * 1024);
          expect(Object.keys(diagnostics).at(-1)).toBe('timeline');
        }
      }
    } finally {
      log.mockRestore();
      coreDb.sqlite.close();
    }
  });

  it.each([
    'none',
    'native-cause',
    'native-summary',
    'stream-failed',
    'truncated',
    'provider-stream-failed',
    'unsupported-feature',
    'unsupported-later-success',
    'unsupported-other-package',
    'later-success',
    'other-package',
    'unknown-code',
  ] as const)('collects durable outputs and preserves a failed worker status with %s inference', async (inference) => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-governance-failed-status-')));
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const turn = createAssignedTurn(store, 'ws_demo', 'th_demo', 'Observe failed worker status');
    const agentSessionId = 'as_failed_status_1';
    const packageSnapshotId = `aepsnap_${turn.id}_${agentSessionId}`;
    const sandboxBindingRef = 'lease-binding:failed-status';
    recordExecutorAttempt(coreDb, {
      agentSessionId,
      packageSnapshotId,
      sandboxBindingRef,
      threadId: turn.threadId,
      turnId: turn.id,
    });
    const backend = new FakeWorkerGovernanceBackend();
    const executor = new WorkerGovernanceTurnExecutor({
      awaitWorkerCompletion: async () => {
        backend.calls.push('awaitWorkerCompletion');
        if (
          inference !== 'none' &&
          inference !== 'native-cause' &&
          inference !== 'native-summary'
        ) {
          const workspaceDb = openWorkspaceDb(coreDb.dataRoot, turn.workspaceId);
          try {
            const call = startCapabilityCall({
              callId: 'cap_stream_failed',
              workspaceDb,
              workspaceId: turn.workspaceId,
              threadId: turn.threadId,
              turnId: turn.id,
              agentSessionId,
              packageSnapshotId:
                inference === 'other-package' || inference === 'unsupported-other-package'
                  ? 'aepsnap_other'
                  : packageSnapshotId,
              authorityActor: null,
              capabilityId: 'llm.responses',
              family: 'llm',
              operation: 'responses',
              serviceRef: 'worker-inference-gateway',
              redactionClass: 'metadata-only',
              now: new Date('2026-07-15T00:00:01Z'),
            });
            finishCapabilityCall({
              workspaceDb,
              callId: call.id,
              status: 'failed',
              errorCode: inference.startsWith('unsupported-')
                ? 'unsupported_gateway_feature'
                : inference === 'unknown-code'
                  ? 'unknown-internal-detail'
                  : inference === 'truncated'
                    ? 'provider_stream_truncated'
                    : inference === 'provider-stream-failed'
                      ? 'provider_stream_failed'
                      : 'worker_inference_stream_failed',
            });
            if (inference === 'later-success' || inference === 'unsupported-later-success') {
              const retry = startCapabilityCall({
                ...call.context,
                callId: 'cap_retry',
                workspaceDb,
                now: new Date('2026-07-15T00:00:02Z'),
              });
              finishCapabilityCall({ workspaceDb, callId: retry.id, status: 'succeeded' });
            }
          } finally {
            workspaceDb.sqlite.close();
          }
        }
        return {
          acceptedAt: '2026-07-15T00:00:03.000Z',
          status: 'failed' as const,
          stopReason: 'error',
          ...(inference === 'native-cause'
            ? {
                diagnostics: {
                  failureCause: 'DeepSeek model returned a completed response with no content.',
                },
              }
            : inference === 'native-summary'
              ? { diagnostics: { native: 'Native setup failed' } }
              : {}),
        };
      },
      backend,
      coreDb,
      createAgentSessionId: () => agentSessionId,
      environmentBackend: {
        kind: 'openshell',
      },
      now: () => '2026-07-15T00:00:03.000Z',
    });

    await expect(
      executor.startTurn(store, turn.id, 'Observe failed worker status', {
        attemptId: `lease_${turn.id}`,
        agentSessionId,
        agentSetup: createTestAgentSetup(),
        requestId: '00000000-0000-4000-8000-000000000253',
        sandboxBindingRef,
        triggerActor: turn.triggerActor,
        workspaceRoots: [],
      })
    ).resolves.toBeUndefined();
    expect(backend.calls).toEqual([
      'materialize',
      'submit',
      'awaitWorkerCompletion',
      'collectEvidence',
      'collectTranscript',
      'collectWorkspaceChanges',
      'cleanupSession',
    ]);
    expect(store.getTurnById(turn.id).status).toBe('failed');
    const expectedError = {
      code:
        inference === 'unsupported-feature'
          ? 'unsupported_gateway_feature'
          : 'worker_governance_turn_failed',
      message:
        inference === 'unsupported-feature'
          ? 'The Gateway cannot preserve the requested features for the selected model route. Choose a compatible model route and start a new Task.'
          : inference === 'native-cause'
            ? 'DeepSeek model returned a completed response with no content.'
            : inference === 'native-summary'
              ? 'Native setup failed'
              : 'Worker reported terminal status: failed.' +
                (inference === 'stream-failed' ||
                inference === 'truncated' ||
                inference === 'provider-stream-failed'
                  ? ' Last worker inference stream failed before completion.'
                  : ''),
    };
    expect(store.getTurnById(turn.id).error).toEqual(expectedError);
    if (inference === 'native-cause') {
      for (const canary of [
        'sk-reviewerSyntheticToken123',
        '/private/customer/project/payroll.txt',
        'CONFIDENTIAL_PROMPT_CANARY',
      ])
        expect(store.getTurnById(turn.id).error?.message).not.toContain(canary);
    }
    expect(store.getTurnEvents(turn.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          data: expect.objectContaining({
            stopReason: 'error',
            type: 'turn-completed',
            turn: expect.objectContaining({ error: expectedError }),
          }),
          event: 'turn.completed',
        }),
      ])
    );
    coreDb.sqlite.close();
  });

  it.each([
    'completed',
    'failed',
  ] as const)('preserves a non-UUID App command through Worker launch and %s closeout', async (outcome) => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-command-id-')));
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const turn = createAssignedTurn(store, 'ws_demo', 'th_demo', 'Check command identity');
    const agentSessionId = `as_command_id_${outcome}`;
    const requestId = 'human-approved-readonly-goal-step-20260917-th7';
    const backend = new FakeWorkerGovernanceBackend();
    const executor = new WorkerGovernanceTurnExecutor({
      ...(outcome === 'failed'
        ? {
            awaitWorkerCompletion: async () => ({
              acceptedAt: '2026-07-15T00:00:03.000Z',
              status: 'failed' as const,
              stopReason: 'error',
            }),
          }
        : {}),
      backend,
      coreDb,
      createAgentSessionId: () => agentSessionId,
      environmentBackend: { kind: 'openshell' },
      now: () => '2026-07-15T00:00:03.000Z',
    });
    try {
      await startWithExecutorAttempt(
        coreDb,
        executor,
        store,
        turn,
        agentSessionId,
        '2026-07-15T00:00:03.000Z',
        'Check command identity',
        {
          agentSetup: createTestAgentSetup(),
          requestId,
          triggerActor: turn.triggerActor,
          workspaceRoots: [],
        }
      );
      expect(backend.lastPackage?.scope.requestId).toBe(requestId);
      expect(backend.planSession(backend.lastPackage!).backendSessionId).toBe(
        `openkit-${agentSessionId}`
      );
      expect(store.getTurnById(turn.id).status).toBe(outcome);
      const events = store
        .getTurnEvents(turn.id)
        .filter((event) => event.event === 'turn.completed');
      expect(events.length).toBeGreaterThan(0);
      for (const event of events) {
        expect(RequestIdSchema.safeParse(event.requestId).success).toBe(true);
      }
      expect(new Set(events.map((event) => event.requestId)).size).toBe(1);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it.each([
    { retained: true, sessionStatus: 'idle' },
    { retained: false, sessionStatus: 'interrupted' },
  ] as const)('keeps an interrupted Turn AgentSession $sessionStatus when the binding retained is $retained', async ({
    retained,
    sessionStatus,
  }) => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-governance-retained-')));
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const turn = createAssignedTurn(store, 'ws_demo', 'th_demo', 'Interrupt a resident worker');
    const agentSessionId = 'as_retained_1';
    const sandboxBindingRef = 'lease-binding:retained';
    recordExecutorAttempt(coreDb, {
      agentSessionId,
      packageSnapshotId: `aepsnap_${turn.id}_${agentSessionId}`,
      sandboxBindingRef,
      threadId: turn.threadId,
      turnId: turn.id,
    });
    // The backend retains a binding it proved reusable after closeout; others it closed.
    const backend = Object.assign(new FakeWorkerGovernanceBackend(), {
      readThreadAgentSessionBinding: () => (retained ? { agentSessionId } : null),
    });
    const executor = new WorkerGovernanceTurnExecutor({
      awaitWorkerCompletion: async () => ({
        acceptedAt: '2026-07-15T00:00:03.000Z',
        status: 'interrupted' as const,
        stopReason: 'aborted',
      }),
      backend,
      coreDb,
      createAgentSessionId: () => agentSessionId,
      now: () => '2026-07-15T00:00:03.000Z',
    });

    try {
      await executor.startTurn(store, turn.id, 'Interrupt a resident worker', {
        attemptId: `lease_${turn.id}`,
        agentSessionId,
        agentSetup: createTestAgentSetup(),
        requestId: '00000000-0000-4000-8000-000000000256',
        sandboxBindingRef,
        triggerActor: turn.triggerActor,
        workspaceRoots: [],
      });

      expect(store.getTurnById(turn.id)).toMatchObject({
        error: { code: 'worker_governance_turn_cancelled' },
        status: 'interrupted',
      });
      expect(store.getAgentSession(agentSessionId)).toMatchObject({
        message: retained ? null : 'Worker reported an aborted terminal status.',
        status: sessionStatus,
      });
      expect(backend.calls.at(-1)).toBe('cleanupSession');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it.each([
    'closed',
    'idle',
  ] as const)('continues a pre-fact predecessor with no proof and no backend binding: %s', async (status) => {
    const coreDb = openCommitFixtureCore();
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const turn = createAssignedTurn(store, 'ws_demo', 'th_demo', 'Continue without native proof');
    const backend = new FakeWorkerGovernanceBackend();
    backend.prepareAgentSessionContinuity = async () => 'absent';
    const executor = new WorkerGovernanceTurnExecutor({ backend, coreDb });
    const input = {
      agentSetup: createTestAgentSetup(),
      freshAgentSessionId: 'as_unproved_next',
      requestId: null,
      turn,
      turnInput: 'Continue without native proof',
      workspaceRoots: [],
    };
    store.createAgentSession({
      id: 'as_unproved_old',
      agentId: input.agentSetup.manifest.id,
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      status,
      message: null,
      createdAt: '2026-10-03T00:00:00.000Z',
      updatedAt: '2026-10-03T00:00:00.000Z',
    });
    const prepared = await executor.prepareAgentSessionForTurn(store, input);
    expect(prepared.agentSessionId).toBe(input.freshAgentSessionId);
    expect(prepared.workerStorageChoice).toBeUndefined();
    acquireCommitFixtureAttempt(coreDb, input, 'lease_unproved');
    expect(
      await executor.commitPreparedAgentSessionForTurn(store, {
        prepared,
        preparation: input,
        attemptId: 'lease_unproved',
      })
    ).toBeUndefined();
    expect(store.getAgentSession('as_unproved_old')).toMatchObject({
      nativeHandleDigest: null,
      retainedStorage: null,
    });
    expect(backend.calls).toEqual([]);
  });

  it('refuses a reusable runtime ready proof without attachment provenance even before digest handoff', async () => {
    const store = createDemoStore();
    const turn = createAssignedTurn(store, 'ws_demo', 'th_demo', 'Continue');
    const backend = new FakeWorkerGovernanceBackend();
    Object.assign(backend, { prepareAgentSessionContinuity: async () => 'reusable' as const });
    const executor = new WorkerGovernanceTurnExecutor({ backend });
    const input = {
      agentSetup: createTestAgentSetup(),
      freshAgentSessionId: 'as_unrecorded_ready_next',
      requestId: null,
      turn,
      turnInput: 'Continue',
      workspaceCwd: null,
      workspaceRoots: [],
    };
    const sessionCompatibilityKey = (
      executor as unknown as {
        previewAgentSessionCompatibilityKey(id: string, preparation: typeof input): string;
      }
    ).previewAgentSessionCompatibilityKey('as_unrecorded_ready', input);
    store.createAgentSession({
      id: 'as_unrecorded_ready',
      agentId: input.agentSetup.manifest.id,
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      status: 'idle',
      message: null,
      policySnapshotId: 'worker_turn_launch_policy',
      sessionCompatibilityKey,
      createdAt: '2026-10-03T00:00:00.000Z',
      updatedAt: '2026-10-03T00:00:00.000Z',
    });
    // Reusable disposition proves an already-ready runtime binding; Core handoff may still be absent.
    await expect(executor.prepareAgentSessionForTurn(store, input)).rejects.toMatchObject({
      code: 'recovery_required',
    });
    expect(store.getAgentSession('as_unrecorded_ready')).toMatchObject({
      nativeHandleDigest: null,
      retainedStorage: null,
    });
    expect(backend.calls).toEqual([]);
  });

  it.each([
    false,
    true,
  ])('reconstructs the same proof source and nondefault slot after restart without rebasing caller revision: explicit=%s', async (explicit) => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-retained-selection-')));
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    coreDb.sqlite
      .prepare(
        `INSERT INTO nanohost_runtime_targets (target_id, identity_id, deployment_id, connection_generation, predecessor_fenced, ready, fresh_empty, observed_at, slot_count) VALUES ('target_retained', 'identity_retained', 'deployment_retained', 1, 1, 1, 1, ?, 1)`
      )
      .run('2026-10-03T00:00:00.000Z');
    const binding = createWorkerStorageBinding(coreDb, {
      deploymentId: 'deployment_retained',
      runtimeTargetId: 'target_retained',
      workspaceId: 'ws_demo',
      layout: {
        family: 'openkit-worker',
        version: '1',
        uid: 1000,
        gid: 1000,
        workingDirectory: '/tmp/openkit-bootstrap',
        platform: { architecture: 'amd64', os: 'linux' },
        targets: [{ target: '/sandbox' }, { target: '/workspace' }],
      },
    });
    const reserved = reserveWorkerStorageAttachment(coreDb, {
      storageRef: binding.storageRef,
      expectedRevision: binding.revision,
      layout: binding.layout,
      purpose: 'work',
      responsibleUserId: 'user_local',
      threadId: 'th_demo',
      workspaceId: 'ws_demo',
      authorizeContributor: () => true,
      agentSessionId: 'as_retained_proof',
      runtimeTargetId: 'target_retained',
    });
    // A prior explicit handoff supplied a slot that differs from the Thread's generated default.
    coreDb.sqlite
      .prepare('UPDATE worker_storage_contributors SET work_slot_ref = ? WHERE storage_ref = ?')
      .run('slot-exact', binding.storageRef);
    coreDb.sqlite
      .prepare(
        "UPDATE worker_storage_bindings SET state = 'idle', current_agent_session_id = NULL, current_thread_id = NULL, current_work_slot_ref = NULL WHERE storage_ref = ?"
      )
      .run(binding.storageRef);
    const retainedStorage = { storageRef: binding.storageRef, workSlotRef: 'slot-exact' };
    store.createAgentSession({
      id: 'as_retained_proof',
      agentId: 'agent_codex_host',
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      status: 'closed',
      message: null,
      createdAt: '2026-10-03T00:00:00.000Z',
      updatedAt: '2026-10-03T00:00:00.000Z',
      nativeHandleDigest: 'a'.repeat(64),
      retainedStorage,
    });
    store.createAgentSession({
      id: 'as_failed_unproved',
      agentId: 'agent_codex_host',
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      status: 'failed',
      message: null,
      createdAt: '2026-10-03T00:00:01.000Z',
      updatedAt: '2026-10-03T00:00:01.000Z',
      retainedStorage: { storageRef: `wst_${'9'.repeat(32)}`, workSlotRef: 'unproved-slot' },
    });
    const restarted = new FsStore({ dataRoot: coreDb.dataRoot });
    const backend = new FakeWorkerGovernanceBackend();
    const inspect = vi.fn(async () => 'absent' as const);
    Object.assign(backend, { prepareAgentSessionContinuity: inspect });
    const executor = new WorkerGovernanceTurnExecutor({ backend, coreDb });
    const turn = createAssignedTurn(restarted, 'ws_demo', 'th_demo', 'Continue');
    const callerChoice = {
      kind: 'selected' as const,
      purpose: 'work' as const,
      storageRef: binding.storageRef,
      expectedRevision: 1,
      goalId: null,
      taskId: null,
    };
    try {
      const prepared = await executor.prepareAgentSessionForTurn(restarted, {
        agentSetup: createTestAgentSetup(),
        freshAgentSessionId: 'as_retained_next',
        requestId: null,
        turn,
        turnInput: 'Continue',
        workspaceCwd: null,
        workspaceRoots: [],
        ...(explicit ? { workerStorageChoice: callerChoice } : {}),
      });
      expect(prepared.workerStorageChoice).toEqual({
        kind: 'selected',
        purpose: 'work',
        storageRef: binding.storageRef,
        expectedRevision: explicit ? 1 : reserved.revision,
        goalId: null,
        taskId: null,
        reuseWorkSlotRef: 'slot-exact',
      });
      expect(inspect).toHaveBeenCalledWith(
        expect.objectContaining({
          environmentPackage: expect.objectContaining({
            extensions: expect.objectContaining({
              openkit: expect.objectContaining({ workerStorage: { workSlotRef: 'slot-exact' } }),
            }),
          }),
        })
      );
      if (explicit) {
        expect(() =>
          reserveWorkerStorageAttachment(coreDb, {
            ...callerChoice,
            reuseWorkSlotRef: 'slot-exact',
            layout: binding.layout,
            responsibleUserId: 'user_local',
            threadId: 'th_demo',
            workspaceId: 'ws_demo',
            authorizeContributor: () => true,
            agentSessionId: 'as_retained_next',
            runtimeTargetId: 'target_retained',
          })
        ).toThrow('revision changed');
      }
      const occupied = reserveWorkerStorageAttachment(coreDb, {
        storageRef: binding.storageRef,
        expectedRevision: reserved.revision,
        reuseWorkSlotRef: 'slot-exact',
        layout: binding.layout,
        purpose: 'work',
        responsibleUserId: 'user_local',
        threadId: 'th_demo',
        workspaceId: 'ws_demo',
        authorizeContributor: () => true,
        agentSessionId: 'as_other_live',
        runtimeTargetId: 'target_retained',
      });
      expect(() =>
        reserveWorkerStorageAttachment(coreDb, {
          storageRef: binding.storageRef,
          expectedRevision: occupied.revision,
          reuseWorkSlotRef: 'slot-exact',
          layout: binding.layout,
          purpose: 'work',
          responsibleUserId: 'user_local',
          threadId: 'th_demo',
          workspaceId: 'ws_demo',
          authorizeContributor: () => true,
          agentSessionId: 'as_retained_next',
          runtimeTargetId: 'target_retained',
        })
      ).toThrow('already has an attachment');
      expect(restarted.getAgentSession('as_retained_proof').retainedStorage).toEqual(
        retainedStorage
      );
    } finally {
      coreDb.sqlite.close();
    }
  });

  it.each([
    false,
    true,
  ])('records actual attachment before native open and refuses work on recording failure: failure=%s', async (recordingFailure) => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-attachment-before-open-')));
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const retainedStorage = {
      storageRef: `wst_${'3'.repeat(32)}`,
      workSlotRef: 'actual-nondefault',
    };
    const backend = new FakeWorkerGovernanceBackend();
    const materialize = backend.materialize.bind(backend);
    backend.materialize = async (...args) => ({ ...(await materialize(...args)), retainedStorage });
    let record:
      | ((digest: string, retainedStorage: { storageRef: string; workSlotRef: string }) => void)
      | null = null;
    Object.assign(backend, {
      bindNativeHandleRecorder: (
        _id: string,
        recorder: (
          digest: string,
          retainedStorage: { storageRef: string; workSlotRef: string }
        ) => void
      ) => {
        record = recorder;
      },
    });
    const launch = vi.fn(async () => {
      expect(
        new FsStore({ dataRoot: coreDb.dataRoot }).getAgentSession('as_attachment_before_open')
      ).toMatchObject({ retainedStorage });
      record?.('d'.repeat(64), retainedStorage);
      // A ready proof precedes baseline collection; collection need never complete.
      throw new Error('baseline failed after ready proof');
    });
    backend.submit = launch;
    if (recordingFailure) {
      const update = store.updateAgentSession.bind(store);
      vi.spyOn(store, 'updateAgentSession').mockImplementation((id, input) => {
        if ('retainedStorage' in input) throw new Error('attachment persistence failed');
        return update(id, input);
      });
    }
    const executor = new WorkerGovernanceTurnExecutor({ backend, coreDb });
    const turn = createAssignedTurn(store, 'ws_demo', 'th_demo', 'Record before open');
    try {
      await expect(
        startWithExecutorAttempt(
          coreDb,
          executor,
          store,
          turn,
          'as_attachment_before_open',
          new Date().toISOString(),
          'Continue',
          {
            agentSetup: createTestAgentSetup(),
            requestId: null,
            triggerActor: turn.triggerActor,
            workspaceRoots: [],
          }
        )
      ).rejects.toThrow(
        recordingFailure ? 'attachment persistence failed' : 'baseline failed after ready proof'
      );
      expect(backend.calls).toContain('cleanupSession');
      if (recordingFailure) {
        expect(launch).not.toHaveBeenCalled();
        expect(store.getAgentSession('as_attachment_before_open').nativeHandleDigest).toBeNull();
      } else {
        expect(launch).toHaveBeenCalledOnce();
        expect(
          new FsStore({ dataRoot: coreDb.dataRoot }).getAgentSession('as_attachment_before_open')
        ).toMatchObject({ retainedStorage, nativeHandleDigest: 'd'.repeat(64), status: 'failed' });
      }
    } finally {
      coreDb.sqlite.close();
    }
  });

  it.each([
    'missing',
    'fresh',
    'different-storage',
    'different-slot',
  ])('refuses continuation before planning or effects when attachment choice is $0', async (violation) => {
    const store = createDemoStore();
    const predecessor = store.createAgentSession({
      id: 'as_choice_predecessor',
      agentId: 'agent_codex_host',
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      nativeHandleDigest: 'a'.repeat(64),
      status: 'closed',
      message: null,
      createdAt: '2026-10-03T00:00:00.000Z',
      updatedAt: '2026-10-03T00:00:00.000Z',
    });
    const retainedStorage = { storageRef: `wst_${'1'.repeat(32)}`, workSlotRef: 'slot-exact' };
    // Isolate selection from schema evolution: the durable-record regression verifies real persistence.
    vi.spyOn(store, 'listThreadAgentSessions').mockReturnValue([
      { ...predecessor, retainedStorage: violation === 'missing' ? null : retainedStorage },
    ]);
    const backend = new FakeWorkerGovernanceBackend();
    const inspect = vi.fn(async () => 'absent' as const);
    Object.assign(backend, { prepareAgentSessionContinuity: inspect });
    const executor = new WorkerGovernanceTurnExecutor({ backend });
    const turn = createAssignedTurn(store, 'ws_demo', 'th_demo', 'Continue');
    const workerStorageChoice =
      violation === 'missing'
        ? undefined
        : violation === 'fresh'
          ? { kind: 'fresh' as const, goalId: null, taskId: null }
          : {
              kind: 'selected' as const,
              purpose: 'work' as const,
              goalId: null,
              taskId: null,
              expectedRevision: 7,
              storageRef:
                violation === 'different-storage'
                  ? `wst_${'2'.repeat(32)}`
                  : retainedStorage.storageRef,
              reuseWorkSlotRef:
                violation === 'different-slot' ? 'different' : retainedStorage.workSlotRef,
            };
    await expect(
      executor.prepareAgentSessionForTurn(store, {
        agentSetup: createTestAgentSetup(),
        freshAgentSessionId: 'as_choice_next',
        requestId: null,
        turn,
        turnInput: 'Continue',
        workspaceCwd: null,
        workspaceRoots: [],
        ...(workerStorageChoice ? { workerStorageChoice } : {}),
      })
    ).rejects.toMatchObject({
      code: violation === 'missing' ? 'recovery_required' : 'worker_storage_choice_conflict',
    });
    expect(inspect).not.toHaveBeenCalled();
    expect(backend.calls).toEqual([]);
    expect(store.getAgentSession(predecessor.id).nativeHandleDigest).toBe('a'.repeat(64));
  });

  it.each([
    false,
    true,
  ])('keeps the triggering Turn queued through predecessor refusal, retirement failure=%s', async (retirementFails) => {
    const coreDb = openCommitFixtureCore();
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const target = recordTestNativeRuntimeTarget(coreDb);
    const binding = createWorkerStorageBinding(coreDb, {
      deploymentId: target.deploymentId,
      runtimeTargetId: target.targetId,
      workspaceId: 'ws_demo',
      layout: {
        family: 'openkit-worker',
        version: '1',
        uid: 1000,
        gid: 1000,
        workingDirectory: '/tmp/openkit-bootstrap',
        platform: { architecture: 'amd64', os: 'linux' },
        targets: [{ target: '/sandbox' }, { target: '/workspace' }],
      },
    });
    const reserved = reserveWorkerStorageAttachment(coreDb, {
      storageRef: binding.storageRef,
      expectedRevision: binding.revision,
      layout: binding.layout,
      purpose: 'work',
      responsibleUserId: 'user_local',
      threadId: 'th_demo',
      workspaceId: 'ws_demo',
      authorizeContributor: () => true,
      agentSessionId: 'as_queued_predecessor',
      runtimeTargetId: target.targetId,
    });
    releaseWorkerStorageAttachment(coreDb, {
      storageRef: reserved.storageRef,
      expectedRevision: reserved.revision,
      attachmentGeneration: reserved.attachmentGeneration,
      cleanupProved: true,
    });
    const predecessor = store.createAgentSession({
      id: 'as_queued_predecessor',
      agentId: 'agent_codex_host',
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      status: 'idle',
      message: null,
      createdAt: '2026-07-15T00:00:00.000Z',
      updatedAt: '2026-07-15T00:00:00.000Z',
      sessionCompatibilityKey: `sha256:${'0'.repeat(64)}`,
      nativeHandleDigest: 'a'.repeat(64),
      retainedStorage: {
        storageRef: binding.storageRef,
        workSlotRef: workerStorageDefaultWorkSlotRef('ws_demo', 'th_demo'),
      },
    });
    let refused = false;
    const effects: string[] = [];
    const backend = Object.assign(new FakeWorkerGovernanceBackend(), {
      prepareAgentSessionContinuity: async (input: { readonly reuseAllowed: boolean }) => {
        if (input.reuseAllowed)
          return refused
            ? ('sandbox-replacement-required' as const)
            : ('replacement-required' as const);
        if (!refused) {
          refused = true;
          effects.push('predecessor-close-refused');
          throw new WorkerGovernanceCapacityUnavailableError(
            'Settled predecessor close needs retirement.'
          );
        }
        effects.push('sandbox-retirement');
        if (retirementFails) throw new Error('Sandbox retirement failed.');
        return 'closed' as const;
      },
    });
    const planSession = backend.planSession.bind(backend);
    backend.planSession = (environmentPackage) => ({
      ...planSession(environmentPackage),
      deploymentId: target.deploymentId,
      runtimeTargetId: target.targetId,
    });
    const materialize = backend.materialize.bind(backend);
    backend.materialize = async (...args) => ({
      ...(await materialize(...args)),
      retainedStorage: predecessor.retainedStorage!,
    });
    const executor = new WorkerGovernanceTurnExecutor({
      backend,
      coreDb,
      awaitWorkerCompletion: async () => ({
        acceptedAt: '2026-07-15T00:00:03.000Z',
        status: 'completed' as const,
        stopReason: 'completed',
      }),
    });
    const entry = createSchedulerAdmissionEntry(coreDb, {
      backendId: 'nanohost',
      queueEntryId: 'queue_refused_predecessor',
      requestId: '00000000-0000-4000-8000-000000000291',
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      turnId: 'turn_binding_change',
      turnInput: 'Continue after the MCP binding change',
      requestedAgentId: 'agent_codex_host',
      triggerActor: { kind: 'user', id: 'user_local' },
    });
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
      inputHash: 'fixture:binding-change',
      scope: { actorId: 'user_local', workspaceId: entry.workspaceId, threadId: entry.threadId },
      response: { kind: 'turn', id: entry.turnId },
      createdAt: new Date().toISOString(),
    });
    const dispatch = {
      coreDb,
      store,
      turnExecutor: executor,
      executionBackend: executor.executionBackend,
      agentManifests: [createTestAgentSetup().manifest],
      gatewayConfig: createTestGatewayConfig(),
      providerRegistry: new ProviderRegistry([
        {
          baseUrl: 'http://127.0.0.1:11434/v1',
          defaultModel: 'openai/gpt-5.2',
          displayName: 'Scheduler fixture provider',
          id: 'agent-openrouter',
          kind: 'local',
          models: ['openai/gpt-5.2'],
          modelMetadata: { 'openai/gpt-5.2': { temperature: false } },
        },
      ]),
    };
    try {
      expect((await runSchedulerDispatchLoop(dispatch)).terminalResult).toEqual({
        status: 'queued',
        reason: 'backend-busy',
      });
      expect(store.getTurnById(entry.turnId)).toMatchObject({ status: 'pending' });
      expect(store.getTurnById(entry.turnId).agentSessionId).toBeUndefined();
      expect(store.getAgentSession(predecessor.id).status).toBe('idle');
      expect(backend.calls).toEqual([]);
      const firstAttempt = coreDb.sqlite
        .prepare('SELECT * FROM scheduler_execution_attempts')
        .get() as { attempt_id: string };
      expect(firstAttempt).toMatchObject({
        phase: 'closed',
        disposition: 'not_accepted',
        operation_id: null,
        terminal_cause: 'backend-busy',
      });
      expect(
        coreDb.sqlite
          .prepare('SELECT status FROM scheduler_admission_entries WHERE queue_entry_id = ?')
          .get(entry.queueEntryId)
      ).toEqual({ status: 'queued' });
      const next = runSchedulerDispatchLoop(dispatch);
      if (retirementFails) {
        await expect(next).rejects.toMatchObject({ code: 'recovery_required' });
        expect(store.getTurnById(entry.turnId)).toMatchObject({
          status: 'failed',
          error: { code: 'worker_preparation_failed' },
        });
        expect(backend.calls).toEqual([]);
        await runSchedulerDispatchLoop(dispatch);
        expect(effects).toEqual(['predecessor-close-refused', 'sandbox-retirement']);
      } else {
        expect((await next).startedTurns[0]?.dispatch.entry.turnId).toBe(entry.turnId);
        await vi.waitFor(() => expect(store.getTurnById(entry.turnId).status).toBe('completed'));
        expect(backend.lastContext?.nativeResume).toEqual({
          digest: predecessor.nativeHandleDigest,
          locator: predecessor.id,
        });
        expect(store.getAgentSession(predecessor.id).status).toBe('closed');
        expect(effects).toEqual(['predecessor-close-refused', 'sandbox-retirement']);
        expect(backend.calls.filter((call) => call === 'submit')).toHaveLength(1);
      }
      const attemptRows = coreDb.sqlite
        .prepare('SELECT * FROM scheduler_execution_attempts ORDER BY rowid')
        .all() as { attempt_id: string; turn_id: string; queue_entry_id: string }[];
      expect(attemptRows).toHaveLength(2);
      expect(attemptRows[1]!.attempt_id).not.toBe(firstAttempt.attempt_id);
      expect(attemptRows.map((attempt) => attempt.turn_id)).toEqual([entry.turnId, entry.turnId]);
      expect(attemptRows.map((attempt) => attempt.queue_entry_id)).toEqual([
        entry.queueEntryId,
        entry.queueEntryId,
      ]);
      expect(store.listThreadTurns(entry.workspaceId, entry.threadId)).toHaveLength(1);
    } finally {
      await vi.waitFor(() => expect(executor.isTurnExecutionActive(entry.turnId)).toBe(false));
    }
  });

  it('records the accepted ready handle digest and offers it as the successor resume pair', async () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-governance-resume-pair-')));
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const digest = 'a'.repeat(64);
    let record:
      | ((digest: string, retainedStorage: { storageRef: string; workSlotRef: string }) => void)
      | null = null;
    const backend = Object.assign(new FakeWorkerGovernanceBackend(), {
      bindNativeHandleRecorder: (
        _packageSnapshotId: string,
        recorder: (
          digest: string,
          retainedStorage: { storageRef: string; workSlotRef: string }
        ) => void
      ) => {
        record = recorder;
      },
    });
    const agentSessionIds = ['as_resume_first', 'as_resume_successor'];
    const executor = new WorkerGovernanceTurnExecutor({
      awaitWorkerCompletion: async () => {
        // The backend accepts the ready proof during the Turn, after materialization.
        record?.(digest, {
          storageRef: `wst_${'1'.repeat(32)}`,
          workSlotRef: workerStorageDefaultWorkSlotRef('ws_demo', 'th_demo'),
        });
        return {
          acceptedAt: '2026-07-15T00:00:03.000Z',
          status: 'completed' as const,
          stopReason: 'completed',
        };
      },
      backend,
      coreDb,
      now: () => '2026-07-15T00:00:03.000Z',
    });
    const run = async (agentSessionId: string, index: number) => {
      const turn = createAssignedTurn(store, 'ws_demo', 'th_demo', `Resume turn ${index}`);
      const sandboxBindingRef = `lease-binding:resume-${index}`;
      recordExecutorAttempt(coreDb, {
        agentSessionId,
        packageSnapshotId: `aepsnap_${turn.id}_${agentSessionId}`,
        sandboxBindingRef,
        threadId: turn.threadId,
        turnId: turn.id,
      });
      await executor.startTurn(store, turn.id, `Resume turn ${index}`, {
        attemptId: `lease_${turn.id}`,
        agentSessionId,
        agentSetup: createTestAgentSetup(),
        requestId: `00000000-0000-4000-8000-00000000026${index}`,
        sandboxBindingRef,
        triggerActor: turn.triggerActor,
        workspaceRoots: [],
      });
    };

    try {
      await run(agentSessionIds[0]!, 1);
      // The first binding of a Thread starts a new native conversation.
      expect(backend.lastContext?.nativeResume).toBeNull();
      expect(store.getAgentSession(agentSessionIds[0]!)).toMatchObject({
        nativeHandleDigest: digest,
        status: 'idle',
      });
      // The pair outlives the binding: close the predecessor, then admit a successor.
      store.updateAgentSession(agentSessionIds[0]!, { status: 'closed' });
      coreDb.sqlite
        .prepare(
          "UPDATE scheduler_execution_attempts SET phase = 'closed' WHERE agent_session_id = ?"
        )
        .run(agentSessionIds[0]);
      record = null;

      await run(agentSessionIds[1]!, 2);
      expect(backend.lastContext?.nativeResume).toEqual({
        digest,
        locator: agentSessionIds[0],
      });
      expect(store.getAgentSession(agentSessionIds[0]!).nativeHandleDigest).toBe(digest);
      // A conflicting later proof for the same AgentSession is refused.
      expect(() =>
        store.updateAgentSession(agentSessionIds[1]!, { nativeHandleDigest: digest })
      ).not.toThrow();
      expect(() =>
        store.updateAgentSession(agentSessionIds[1]!, { nativeHandleDigest: 'b'.repeat(64) })
      ).toThrow('resume digest cannot change');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('keeps a ready proof accepted at open when the Turn fails before export', async () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-governance-open-proof-')));
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const digest = 'c'.repeat(64);
    let record:
      | ((digest: string, retainedStorage: { storageRef: string; workSlotRef: string }) => void)
      | null = null;
    const backend = Object.assign(new FakeWorkerGovernanceBackend(), {
      bindNativeHandleRecorder: (
        _packageSnapshotId: string,
        recorder: (
          digest: string,
          retainedStorage: { storageRef: string; workSlotRef: string }
        ) => void
      ) => {
        record = recorder;
      },
    });
    backend.prepareLaunch = vi.fn(async () => {
      backend.calls.push('prepareLaunch');
      // The backend accepts the open proof, then a later import fails the launch.
      record?.(digest, {
        storageRef: `wst_${'1'.repeat(32)}`,
        workSlotRef: workerStorageDefaultWorkSlotRef('ws_demo', 'th_demo'),
      });
      throw new Error('reference import failed');
    });
    const executor = new WorkerGovernanceTurnExecutor({ backend, coreDb });
    const turn = createAssignedTurn(store, 'ws_demo', 'th_demo', 'Open proof turn');
    try {
      await expect(
        startWithExecutorAttempt(
          coreDb,
          executor,
          store,
          turn,
          'as_open_proof',
          new Date().toISOString(),
          'Open proof turn',
          {
            agentSetup: createTestAgentSetup(),
            requestId: '00000000-0000-4000-8000-000000000271',
            triggerActor: turn.triggerActor,
            workspaceRoots: [],
          }
        )
      ).rejects.toThrow('reference import failed');
      expect(backend.prepareLaunch).toHaveBeenCalledOnce();
      expect(backend.calls).not.toContain('submit');
      expect(backend.calls).toContain('cleanupSession');
      expect(store.getAgentSession('as_open_proof').nativeHandleDigest).toBe(digest);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it.each([
    {
      expected: { digest: 'b'.repeat(64), locator: 'as_a_newer' },
      name: 'orders by creation, not by id',
      sessions: [
        { createdAt: '2026-07-15T00:00:01.000Z', digest: 'a'.repeat(64), id: 'as_z_older' },
        { createdAt: '2026-07-15T00:00:02.000Z', digest: 'b'.repeat(64), id: 'as_a_newer' },
      ],
    },
    {
      expected: { digest: 'a'.repeat(64), locator: 'as_z_older' },
      name: 'walks past a newer predecessor without proof to the pair it would have resumed',
      sessions: [
        { createdAt: '2026-07-15T00:00:01.000Z', digest: 'a'.repeat(64), id: 'as_z_older' },
        { createdAt: '2026-07-15T00:00:02.000Z', digest: null, id: 'as_a_newer' },
      ],
    },
    {
      expected: null,
      name: 'starts a new conversation when no AgentSession has proof',
      sessions: [
        { createdAt: '2026-07-15T00:00:01.000Z', digest: null, id: 'as_z_older' },
        { createdAt: '2026-07-15T00:00:02.000Z', digest: null, id: 'as_a_newer' },
      ],
    },
    {
      expected: 'recovery_required',
      name: 'fails closed when equal creation times leave the predecessor unproved',
      sessions: [
        { createdAt: '2026-07-15T00:00:02.000Z', digest: 'a'.repeat(64), id: 'as_z_older' },
        { createdAt: '2026-07-15T00:00:02.000Z', digest: 'b'.repeat(64), id: 'as_a_newer' },
      ],
    },
  ])('selects the successor resume pair: $name', async ({ expected, sessions }) => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-governance-predecessor-')));
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    for (const session of sessions) {
      store.createAgentSession({
        agentId: 'agent_demo',
        createdAt: session.createdAt,
        id: session.id,
        message: null,
        nativeHandleDigest: session.digest,
        retainedStorage: {
          storageRef: `wst_${'1'.repeat(32)}`,
          workSlotRef: workerStorageDefaultWorkSlotRef('ws_demo', 'th_demo'),
        },
        status: 'closed',
        threadId: 'th_demo',
        updatedAt: session.createdAt,
        workspaceId: 'ws_demo',
      });
    }
    const backend = new FakeWorkerGovernanceBackend();
    const executor = new WorkerGovernanceTurnExecutor({ backend, coreDb });
    const turn = createAssignedTurn(store, 'ws_demo', 'th_demo', 'Successor turn');
    try {
      const started = startWithExecutorAttempt(
        coreDb,
        executor,
        store,
        turn,
        'as_successor',
        new Date().toISOString(),
        'Successor turn',
        {
          agentSetup: createTestAgentSetup(),
          requestId: '00000000-0000-4000-8000-000000000272',
          triggerActor: turn.triggerActor,
          workspaceRoots: [],
        }
      );
      if (expected === 'recovery_required') {
        await expect(started).rejects.toMatchObject({ code: 'recovery_required' });
        expect(backend.calls).not.toContain('materialize');
        return;
      }
      await started;
      expect(backend.lastContext?.nativeResume).toEqual(expected);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it.each([
    {
      finalStatus: 'completed',
      stopReason: 'completed',
      turnStatus: 'completed',
    },
    {
      finalStatus: 'completed',
      stopReason: 'completed',
      turnStatus: 'completed',
      routeHashEcho: true,
    },
    {
      artifactRecoveryRequired: true,
      finalStatus: 'completed',
      stopReason: 'completed',
      turnStatus: 'interrupted',
    },
    {
      artifactCollectionInvalid: true,
      finalStatus: 'completed',
      stopReason: 'completed',
      turnStatus: 'interrupted',
    },
    {
      artifactCollectionInvalid: true,
      finalStatus: 'completed',
      stopReason: 'completed',
      terminalProjectionFailure: 'turn',
      turnStatus: 'interrupted',
    },
    {
      artifactCollectionInvalid: true,
      finalStatus: 'completed',
      stopReason: 'completed',
      terminalProjectionFailure: 'session',
      turnStatus: 'interrupted',
    },
    {
      finalStatus: 'blocked',
      stopReason: 'length',
      turnStatus: 'completed',
    },
    {
      finalStatus: 'blocked',
      stopReason: 'budget_exhausted',
      turnStatus: 'completed',
    },
    {
      finalStatus: 'cancelled',
      stopReason: 'aborted',
      turnStatus: 'interrupted',
    },
    {
      finalStatus: 'interrupted',
      stopReason: 'aborted',
      turnStatus: 'interrupted',
    },
    {
      finalStatus: 'failed',
      stopReason: 'error',
      turnStatus: 'failed',
    },
    {
      finalStatus: 'degraded',
      stopReason: 'error',
      turnStatus: 'failed',
    },
    {
      finalStatus: 'lost',
      stopReason: 'error',
      turnStatus: 'failed',
    },
  ] as const)('resumes the normal closeout path after restart for $finalStatus/$stopReason', async (testCase) => {
    const { finalStatus, stopReason, turnStatus } = testCase;
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-governance-completion-gate-')));
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const turn = createAssignedTurn(
      store,
      'ws_demo',
      'th_demo',
      'Wait for durable worker completion'
    );
    const agentSessionId = 'as_completion_gate_1';
    const packageSnapshotId = `aepsnap_${turn.id}_${agentSessionId}`;
    const sandboxBindingRef = 'lease-binding:completion-gate';
    recordExecutorAttempt(coreDb, {
      agentSessionId,
      packageSnapshotId,
      sandboxBindingRef,
      threadId: turn.threadId,
      turnId: turn.id,
    });
    const backend = new FakeWorkerGovernanceBackend();
    backend.artifactRecoveryRequired = 'artifactRecoveryRequired' in testCase;
    backend.artifactCollectionInvalid = 'artifactCollectionInvalid' in testCase;
    if ('routeHashEcho' in testCase) {
      backend.assistantText = `Echo ${[17, 34, 51].map((byte) => Buffer.alloc(32, byte).toString('base64url')).join(' ')}.`;
    }
    const completion = new Promise<void>(() => {});
    let reportWaiterStarted!: () => void;
    const waiterStarted = new Promise<void>((resolve) => {
      reportWaiterStarted = resolve;
    });
    let awaitedEnvironmentPackage: AgentEnvironmentPackage | null = null;
    let awaitedLeaseId: string | null = null;
    const awaitWorkerCompletion = vi.fn(
      async (environmentPackage: AgentEnvironmentPackage, leaseId: string) => {
        awaitedEnvironmentPackage = environmentPackage;
        awaitedLeaseId = leaseId;
        reportWaiterStarted();
        await completion;
      }
    );
    const executor = new WorkerGovernanceTurnExecutor({
      awaitWorkerCompletion,
      backend,
      coreDb,
      createAgentSessionId: () => agentSessionId,
      environmentBackend: {
        kind: 'openshell',
      },
      now: () => '2026-07-15T00:00:03.000Z',
    });
    const execution = executor.startTurn(store, turn.id, 'Wait for durable worker completion', {
      attemptId: `lease_${turn.id}`,
      agentSessionId,
      agentSetup: createTestAgentSetup(),
      requestId: '00000000-0000-4000-8000-000000000254',
      sandboxBindingRef,
      triggerActor: turn.triggerActor,
      workspaceRoots: [],
    });

    const firstBoundary = await Promise.race([
      waiterStarted.then(() => 'waiter-started' as const),
      execution.then(() => 'execution-finished' as const),
    ]);

    expect(firstBoundary).toBe('waiter-started');
    expect(awaitWorkerCompletion).toHaveBeenCalledTimes(1);
    expect(awaitedEnvironmentPackage).toMatchObject({ snapshotId: packageSnapshotId });
    expect(awaitedLeaseId).toBe(`lease_${turn.id}`);
    expect(backend.calls).toEqual(['materialize', 'submit']);
    const session = getWorkerBackendSession(coreDb, `lease_${turn.id}`);
    if (!awaitedEnvironmentPackage || !session) {
      throw new Error('Restart fixture did not reach the durable launch boundary.');
    }
    recordWorkerControlAcceptedRecord(coreDb, {
      acceptedAt: '2026-07-15T00:00:04.000Z',
      lineage: {
        agentSessionId,
        packageSnapshotId,
        requestId: '00000000-0000-4000-8000-000000000254',
        threadId: turn.threadId,
        turnId: turn.id,
        workspaceId: turn.workspaceId,
      },
      operation: 'final_status',
      record: {
        sequence: 1,
        status: finalStatus,
        stopReason,
        ...(finalStatus === 'failed'
          ? {
              diagnostics: {
                failureCause: 'DeepSeek model returned a completed response with no content.',
              },
            }
          : {}),
      },
      recordKey: '1',
      sequence: 1,
    });
    const reopensStore = finalStatus === 'failed' || 'routeHashEcho' in testCase;
    const reopenedCoreDb = reopensStore ? openCoreDb(coreDb.dataRoot) : coreDb;
    const reopenedStore = reopensStore ? createDemoStore({ dataRoot: coreDb.dataRoot }) : store;
    const restartedExecutor = new WorkerGovernanceTurnExecutor({
      backend,
      coreDb: reopenedCoreDb,
      environmentBackend: {
        kind: 'openshell',
      },
      now: () => '2026-07-15T00:00:04.000Z',
    });

    if ('artifactRecoveryRequired' in testCase || 'artifactCollectionInvalid' in testCase) {
      const cleanupSession = vi.spyOn(backend, 'cleanupSession');
      const projectionFailure =
        'terminalProjectionFailure' in testCase ? testCase.terminalProjectionFailure : null;
      const projectionSpy =
        projectionFailure === 'turn'
          ? vi.spyOn(store, 'updateTurn').mockImplementationOnce(() => {
              throw new Error('injected restart Turn persistence failure');
            })
          : projectionFailure === 'session'
            ? vi.spyOn(store, 'updateAgentSession').mockImplementationOnce(() => {
                throw new Error('injected restart Session persistence failure');
              })
            : null;
      const recovery = restartedExecutor.resumeAcceptedFinalStatus(
        store,
        awaitedEnvironmentPackage,
        session
      );
      expect(restartedExecutor.isTurnExecutionActive(turn.id)).toBe(true);
      if (projectionSpy) {
        await expect(recovery).rejects.toThrow('stable product outcome could not be persisted');
        expect(restartedExecutor.isTurnExecutionActive(turn.id)).toBe(false);
        projectionSpy.mockRestore();
        expect(backend.calls).not.toContain('cleanupSession');
        const retrySession = getWorkerBackendSession(coreDb, `lease_${turn.id}`);
        if (!retrySession) {
          throw new Error('Restart projection failure lost its backend session owner.');
        }
        await expect(
          restartedExecutor.resumeAcceptedFinalStatus(
            store,
            awaitedEnvironmentPackage,
            retrySession
          )
        ).resolves.toBe('interrupted');
        expect(backend.calls.filter((call) => call === 'cleanupSession')).toHaveLength(1);
        expect(cleanupSession).toHaveBeenCalledWith(expect.any(Object), { failedCloseout: true });
        expect(store.getAgentSession(agentSessionId)).toMatchObject({ status: 'interrupted' });
        expect(
          store
            .getTurnEvents(turn.id)
            .filter(
              (event) => event.event === 'turn.completed' && event.data.type === 'turn-completed'
            )
        ).toHaveLength(1);
        expect(getWorkerBackendSession(coreDb, `lease_${turn.id}`)).toMatchObject({
          state: 'cleaned',
        });
        expect(store.getTurnById(turn.id)).toMatchObject({
          error: { code: 'worker_governance_restart_recovery' },
          status: 'interrupted',
        });
        coreDb.sqlite.close();
        return;
      }
      await expect(recovery).resolves.toBe('interrupted');
      expect(restartedExecutor.isTurnExecutionActive(turn.id)).toBe(false);
      expect(backend.calls).toEqual([
        'materialize',
        'submit',
        'collectEvidence',
        'collectTranscript',
        'cleanupSession',
      ]);
      expect(cleanupSession).toHaveBeenCalledWith(expect.any(Object), { failedCloseout: true });
      expect(getWorkerBackendSession(coreDb, `lease_${turn.id}`)).toMatchObject({
        state: 'cleaned',
      });
      expect(store.getTurnById(turn.id)).toMatchObject({
        error: { code: 'worker_governance_restart_recovery' },
        status: 'interrupted',
      });
      const cleanedSession = getWorkerBackendSession(coreDb, `lease_${turn.id}`);
      if (!cleanedSession) {
        throw new Error('Restart recovery did not retain its cleaned session record.');
      }
      await expect(
        restartedExecutor.resumeAcceptedFinalStatus(
          store,
          awaitedEnvironmentPackage,
          cleanedSession
        )
      ).resolves.toBe('interrupted');
      expect(backend.calls).toEqual([
        'materialize',
        'submit',
        'collectEvidence',
        'collectTranscript',
        'cleanupSession',
      ]);
      coreDb.sqlite.close();
      return;
    }

    const recovery = restartedExecutor.resumeAcceptedFinalStatus(
      reopenedStore,
      awaitedEnvironmentPackage,
      session
    );
    expect(restartedExecutor.isTurnExecutionActive(turn.id)).toBe(true);
    await expect(recovery).resolves.toBe(turnStatus);
    expect(restartedExecutor.isTurnExecutionActive(turn.id)).toBe(false);

    expect(backend.calls).toEqual([
      'materialize',
      'submit',
      'collectEvidence',
      'collectTranscript',
      'collectWorkspaceChanges',
      'cleanupSession',
    ]);
    if (reopenedCoreDb !== coreDb) reopenedCoreDb.sqlite.close();
    const durableStore = reopensStore ? createDemoStore({ dataRoot: coreDb.dataRoot }) : store;
    if ('routeHashEcho' in testCase) {
      expect(durableStore.listThreadItems(turn.workspaceId, turn.threadId)).toContainEqual(
        expect.objectContaining({
          type: 'assistant-message',
          text: 'Echo [redacted] [redacted] [redacted].',
        })
      );
      const history = readFileSync(
        join(
          coreDb.dataRoot,
          'workspaces',
          turn.workspaceId,
          'threads',
          turn.threadId,
          'turns',
          turn.id,
          'items.jsonl'
        ),
        'utf8'
      );
      for (const byte of [17, 34, 51])
        expect(history).not.toContain(Buffer.alloc(32, byte).toString('base64url'));
    }
    expect(durableStore.getTurnById(turn.id)).toMatchObject({
      agentSessionId,
      status: turnStatus,
    });
    if (finalStatus === 'failed') {
      expect(durableStore.getTurnById(turn.id).error).toEqual({
        code: 'worker_governance_turn_failed',
        message: 'DeepSeek model returned a completed response with no content.',
      });
      for (const canary of [
        'sk-reviewerSyntheticToken123',
        '/private/customer/project/payroll.txt',
        'CONFIDENTIAL_PROMPT_CANARY',
      ])
        expect(durableStore.getTurnById(turn.id).error?.message).not.toContain(canary);
    }
    if (stopReason === 'aborted') {
      expect(durableStore.getAgentSession(agentSessionId)).toMatchObject({ status: 'interrupted' });
    }
    expect(
      durableStore.getTurnEvents(turn.id).find((event) => event.event === 'turn.completed')
    ).toMatchObject({ data: { stopReason } });
    expect(getWorkerBackendSession(coreDb, `lease_${turn.id}`)).toMatchObject({ state: 'cleaned' });
    coreDb.sqlite.close();
  });

  it('reconciles worker inference with runtime provenance before one canonical outer result', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-governance-provenance-success-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    const turn = createAssignedTurn(
      store,
      'ws_demo',
      'th_demo',
      'Import governed runtime provenance'
    );
    const backend = new FakeWorkerGovernanceBackend({
      capabilities: [
        'container',
        'transcript-sink',
        'worker-control',
        'trusted-worker-inference-relay',
        'worker.runtime-provenance.v1',
      ],
    });
    let capture: TurnRuntimeProvenanceCapture | null = null;
    backend.runtimeProvenanceFactory = (environmentPackage) => {
      capture = createTurnRuntimeProvenanceCapture(
        mkdtempSync(join(tmpdir(), 'openkit-governance-provenance-capture-')),
        environmentPackage,
        null,
        'per-stream'
      );
      return capture.collection;
    };
    const sandboxBindingRef = 'lease-binding:provenance-blackbox-1';
    const workerControlToken = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const workerInferenceToken = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
    const workerCapabilityToken = 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
    const workerControlGateway = new WorkerControlGateway({
      resolveTokenBinding: () => ({ status: 'accepted' }),
    });
    const workerRequests: Array<{ prompt_cache_key?: string }> = [];
    const llmGatewayDispatcher = {
      createResponses: vi.fn(
        async (
          _provider: unknown,
          request: { model: string; prompt_cache_key?: string },
          context: LLMGatewayDispatchContext
        ) => {
          workerRequests.push(request);
          context.onUsage?.({ input_tokens: 3, output_tokens: 1, total_tokens: 4 });
          return {
            id: 'resp_provenance_blackbox',
            model: request.model,
            object: 'response' as const,
            output: [],
            status: 'completed' as const,
          };
        }
      ),
    } as unknown as LLMGatewayProviderDispatcher;
    const app = createApp({
      coreDb,
      gatewayConfig: createTestGatewayConfig(),
      llmGatewayDispatcher,
      mode: 'local',
      providerCredentialResolver: (secretRef) =>
        secretRef === 'test:provenance-api-key' ? 'synthetic-provenance-api-key' : null,
      providerRegistry: new ProviderRegistry([
        {
          defaultModel: 'openai/gpt-5.2',
          displayName: 'Agent OpenRouter',
          id: 'agent-openrouter',
          kind: 'gateway',
          models: ['openai/gpt-5.2'],
          secretRef: 'test:provenance-api-key',
          vendor: 'openrouter',
        },
      ]),
      store,
      workerControlGateway,
    });
    const materialize = backend.materialize.bind(backend);
    vi.spyOn(backend, 'materialize').mockImplementation(async (environmentPackage, context) => {
      workerControlGateway.registerSession(environmentPackage, {
        sandboxBindingRef,
        workerCapabilityToken,
        workerControlToken,
        workerInferenceToken,
      });
      return materialize(environmentPackage, context);
    });

    /**
     * Posts one canonical Codex worker-inference request through the authenticated relay route.
     *
     * @param nativeThreadId Runtime-native origin thread.
     * @param nativeCacheLineageId Runtime-native cache lineage.
     * @param parentNativeThreadId Optional runtime-native parent thread.
     * @param options Optional body overrides and expected response status.
     * @returns Worker inference route response.
     */
    async function postWorkerInference(
      nativeThreadId: string,
      nativeCacheLineageId: string,
      parentNativeThreadId?: string,
      options: { body?: Record<string, unknown>; expectedStatus?: number } = {}
    ): Promise<Response> {
      const response = await app.request('/api/worker-inference/v1/responses', {
        body: JSON.stringify({
          input: 'Deterministic worker inference',
          model: 'openai/gpt-5.2',
          openkit_runtime_hint: {
            runtimeFamily: 'codex',
            nativeSessionId: TURN_NATIVE_SESSION_ID,
            nativeThreadId,
            nativeCacheLineageId,
            ...(parentNativeThreadId ? { parentNativeThreadId, subagentKind: 'thread_spawn' } : {}),
          },
          ...options.body,
        }),
        headers: {
          authorization: `Bearer ${workerInferenceToken}`,
          'content-type': 'application/json',
        },
        method: 'POST',
      });

      expect(response.status, await response.clone().text()).toBe(options.expectedStatus ?? 200);
      return response;
    }

    const collectTranscript = backend.collectTranscript.bind(backend);
    vi.spyOn(backend, 'collectTranscript').mockImplementation(async () => {
      await postWorkerInference(TURN_ROOT_NATIVE_ID, 'cache_shared');
      await postWorkerInference(TURN_CHILD_NATIVE_ID, 'cache_child_a', TURN_ROOT_NATIVE_ID);
      await postWorkerInference(TURN_CHILD_B_NATIVE_ID, 'cache_shared', TURN_ROOT_NATIVE_ID);
      const bypassResponse = await postWorkerInference(
        TURN_ROOT_NATIVE_ID,
        'cache_shared',
        undefined,
        { body: { provider_id: 'public-default' }, expectedStatus: 403 }
      );
      await expect(bypassResponse.json()).resolves.toMatchObject({
        error: { code: 'worker_inference_lineage_mismatch' },
      });
      expect(workerRequests).toHaveLength(3);
      return collectTranscript();
    });
    let importedCapture: unknown = null;
    const runtimeProvenanceImporter = vi.fn(async (input: ImportWorkerRuntimeProvenanceInput) => {
      backend.calls.push('importRuntimeProvenance');
      expect(
        store
          .listThreadItems('ws_demo', 'th_demo')
          .filter((item) => item.turnId === turn.id && item.type === 'assistant-message')
      ).toEqual([]);
      expect(capture).not.toBeNull();
      importedCapture = input.capture;
      return importWorkerRuntimeProvenance(input);
    });
    const executor = new WorkerGovernanceTurnExecutor({
      backend,
      coreDb,
      createAgentSessionId: () => 'as_governance_provenance_success_1',
      environmentBackend: {
        kind: 'openshell',
      },
      now: () => '2026-07-13T00:00:01.000Z',
      runtimeProvenanceImporter,
    });

    try {
      await startWithExecutorAttempt(
        coreDb,
        executor,
        store,
        turn,
        'as_governance_provenance_success_1',
        '2026-07-13T00:00:00.000Z',
        'Import governed runtime provenance',
        {
          agentSetup: createTestAgentSetup({
            provider: {
              model: 'openai/gpt-5.2',
              origin: 'server-providers',
              providerId: 'agent-openrouter',
              secretRef: null,
            },
            requiredCapabilities: [
              'trusted-worker-inference-relay',
              'worker.runtime-provenance.v1',
            ],
          }),
          requestId: '00000000-0000-4000-8000-000000000220',
          triggerActor: turn.triggerActor,
          workspaceRoots: [],
        }
      );

      expect(runtimeProvenanceImporter).toHaveBeenCalledOnce();
      expect(importedCapture).toEqual({
        nativeOriginIndexPath: capture?.nativeOriginIndexPath,
        rawStreamPaths: capture?.rawStreamPaths,
        streamManifestPath: capture?.streamManifestPath,
      });
      expect(backend.calls.indexOf('importRuntimeProvenance')).toBeGreaterThan(
        backend.calls.indexOf('collectTranscript')
      );
      expect(backend.calls.indexOf('importRuntimeProvenance')).toBeLessThan(
        backend.calls.indexOf('collectWorkspaceChanges')
      );
      const evidenceResponse = await app.request(
        ...operationRequest('evidence.bundle-list', { workspaceId: 'ws_demo' }, {})
      );
      expect(evidenceResponse.status, await evidenceResponse.clone().text()).toBe(200);
      const evidence = ListWorkspaceEvidenceBundlesResponseSchema.parse(
        await evidenceResponse.json()
      );
      const rawBundle = evidence.evidenceBundles.find(
        (bundle) => bundle.sourceKind === 'worker-runtime-provenance-raw'
      );
      const indexBundle = evidence.evidenceBundles.find(
        (bundle) => bundle.sourceKind === 'worker-runtime-provenance-index'
      );
      expect(
        evidence.evidenceBundles.filter(
          (bundle) => bundle.sourceKind === 'worker-runtime-provenance-raw'
        )
      ).toHaveLength(1);
      expect(
        evidence.evidenceBundles.filter(
          (bundle) => bundle.sourceKind === 'worker-runtime-provenance-index'
        )
      ).toHaveLength(1);
      expect(rawBundle).toMatchObject({
        importStatus: 'promoted',
        rawEvidenceRefs: [],
        retentionClass: 'restricted-raw',
      });
      expect(indexBundle).toMatchObject({
        importStatus: 'promoted',
        retentionClass: 'turn-evidence',
      });
      expect(indexBundle?.summary).toContain('4 streams');
      expect(indexBundle?.summary).toContain('2 children');
      expect(indexBundle?.summary).toContain('3/3 gateway calls reconciled');
      const upstreamCacheKeys = workerRequests.map((request) => request.prompt_cache_key);
      expect(upstreamCacheKeys).toEqual([
        expect.stringMatching(/^openkit:responses:[a-f0-9]{32}$/),
        expect.stringMatching(/^openkit:responses:[a-f0-9]{32}$/),
        expect.stringMatching(/^openkit:responses:[a-f0-9]{32}$/),
      ]);
      expect(upstreamCacheKeys[0]).toBe(upstreamCacheKeys[2]);
      expect(upstreamCacheKeys[1]).not.toBe(upstreamCacheKeys[2]);
      expect(JSON.stringify(workerRequests)).not.toContain('cache_shared');
      expect(JSON.stringify(workerRequests)).not.toContain('cache_child_a');

      const usageResponse = await app.request(
        ...operationRequest('usage.read', { workspaceId: 'ws_demo' }, {})
      );
      expect(usageResponse.status, await usageResponse.clone().text()).toBe(200);
      const usage = CapabilityUsageResponseSchema.parse(await usageResponse.json());
      const workerCalls = usage.capabilityCalls.filter(
        (call) => call.serviceRef === 'worker-inference-gateway'
      );
      const packageSnapshotId = backend.lastPackage!.snapshotId;
      const rootOriginRef = createWorkerRuntimeOriginRef(packageSnapshotId, TURN_ROOT_NATIVE_ID);
      const childOriginRef = createWorkerRuntimeOriginRef(packageSnapshotId, TURN_CHILD_NATIVE_ID);
      const childBOriginRef = createWorkerRuntimeOriginRef(
        packageSnapshotId,
        TURN_CHILD_B_NATIVE_ID
      );
      const callsByOrigin = new Map(workerCalls.map((call) => [call.runtimeOriginRef, call]));
      const workerCallIds = new Set(workerCalls.map((call) => call.id));
      expect(workerCalls).toHaveLength(3);
      expect(new Set(workerCalls.map((call) => call.packageSnapshotId))).toEqual(
        new Set([packageSnapshotId])
      );
      expect(new Set(workerCalls.map((call) => call.requestId))).toHaveProperty('size', 3);
      expect(new Set(workerCalls.map((call) => call.runtimeOriginRef))).toEqual(
        new Set([rootOriginRef, childOriginRef, childBOriginRef])
      );
      expect(callsByOrigin.get(rootOriginRef)?.runtimeCacheLineageRef).toBe(
        callsByOrigin.get(childBOriginRef)?.runtimeCacheLineageRef
      );
      expect(callsByOrigin.get(childOriginRef)?.runtimeCacheLineageRef).not.toBe(
        callsByOrigin.get(childBOriginRef)?.runtimeCacheLineageRef
      );
      expect(
        new Set(
          usage.usageRecords
            .filter((record) => workerCallIds.has(record.capabilityCallId))
            .map((record) => record.capabilityCallId)
        )
      ).toEqual(workerCallIds);

      const auditResponse = await app.request(
        ...operationRequest('audit.workspace-list', { workspaceId: 'ws_demo' }, {})
      );
      expect(auditResponse.status, await auditResponse.clone().text()).toBe(200);
      const audit = ListWorkspaceAuditEventsResponseSchema.parse(await auditResponse.json());
      const linkedFinishEvents = audit.auditEvents.filter(
        (event) =>
          event.action === 'capability.finish' &&
          event.capabilityCallId !== null &&
          workerCallIds.has(event.capabilityCallId)
      );
      expect(new Set(linkedFinishEvents.map((event) => event.capabilityCallId))).toEqual(
        workerCallIds
      );
      expect(linkedFinishEvents.every((event) => event.outcome === 'succeeded')).toBe(true);

      const runtimeEvidenceResponse = await app.request(
        ...operationRequest('evidence.runtime-list', { workspaceId: 'ws_demo' }, {})
      );
      expect(runtimeEvidenceResponse.status, await runtimeEvidenceResponse.clone().text()).toBe(
        200
      );
      const runtimeEvidence = ListWorkspaceRuntimeEvidenceResponseSchema.parse(
        await runtimeEvidenceResponse.json()
      ).runtimeEvidence.filter((record) => record.phase === 'transcript-collection');
      expect(runtimeEvidence).toEqual([
        expect.objectContaining({
          outcome: 'succeeded',
          phase: 'transcript-collection',
        }),
      ]);
      expect(runtimeEvidence[0]?.evidenceBundleIds).toHaveLength(2);
      const itemsResponse = await app.request('/api/app/operations/thread.items', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId: 'ws_demo', threadId: 'th_demo' }),
      });
      expect(itemsResponse.status, await itemsResponse.clone().text()).toBe(200);
      const turnItems = ListThreadItemsResponseSchema.parse(
        await itemsResponse.json()
      ).items.filter((item) => item.turnId === turn.id);
      expect(turnItems.filter((item) => item.type === 'assistant-message')).toEqual([
        expect.objectContaining({
          text: 'Governed worker completed the task.',
          type: 'assistant-message',
        }),
      ]);
      expect(JSON.stringify(turnItems)).not.toContain(TURN_CHILD_RAW_MESSAGE);
      expect(store.getTurnById(turn.id)).toMatchObject({ status: 'completed' });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it.each([
    'missing',
    'tampered',
    'unmapped',
  ] as const)('fails the outer turn while retaining %s runtime provenance quarantine evidence', async (failure) => {
    const dataRoot = mkdtempSync(join(tmpdir(), `openkit-governance-provenance-${failure}-`));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    const turn = createAssignedTurn(
      store,
      'ws_demo',
      'th_demo',
      `Reject ${failure} runtime provenance`
    );
    const backend = new FakeWorkerGovernanceBackend({
      capabilities: [
        'container',
        'transcript-sink',
        'worker-control',
        'trusted-worker-inference-relay',
        'worker.runtime-provenance.v1',
      ],
    });
    backend.runtimeProvenanceFactory = (environmentPackage) =>
      createTurnRuntimeProvenanceCapture(
        mkdtempSync(join(tmpdir(), `openkit-governance-provenance-${failure}-capture-`)),
        environmentPackage,
        failure
      ).collection;
    const runtimeProvenanceImporter = vi.fn(async (input: ImportWorkerRuntimeProvenanceInput) => {
      backend.calls.push('importRuntimeProvenance');
      return importWorkerRuntimeProvenance(input);
    });
    const executor = new WorkerGovernanceTurnExecutor({
      backend,
      coreDb,
      createAgentSessionId: () => `as_governance_provenance_${failure}_1`,
      environmentBackend: {
        kind: 'openshell',
      },
      now: () => '2026-07-13T00:00:01.000Z',
      runtimeProvenanceImporter,
    });

    try {
      await expect(
        startWithExecutorAttempt(
          coreDb,
          executor,
          store,
          turn,
          `as_governance_provenance_${failure}_1`,
          '2026-07-13T00:00:00.000Z',
          `Reject ${failure} runtime provenance`,
          {
            agentSetup: createTestAgentSetup({
              provider: {
                model: 'openai/gpt-5.2',
                origin: 'server-providers',
                providerId: 'agent-openrouter',
                secretRef: null,
              },
              requiredCapabilities: [
                'trusted-worker-inference-relay',
                'worker.runtime-provenance.v1',
              ],
            }),
            requestId: `00000000-0000-4000-8000-${failure === 'missing' ? '000000000221' : failure === 'tampered' ? '000000000222' : '000000000223'}`,
            triggerActor: turn.triggerActor,
            workspaceRoots: [],
          }
        )
      ).rejects.toThrow();

      expect(runtimeProvenanceImporter).toHaveBeenCalledOnce();
      expect(backend.calls.at(-1)).toBe('cleanupSession');
      expect(store.getTurnById(turn.id)).toMatchObject({ status: 'failed' });
      expect(
        store
          .listThreadItems('ws_demo', 'th_demo')
          .filter((item) => item.turnId === turn.id && item.type === 'assistant-message')
      ).toEqual([]);
      const workspaceDb = openTestWorkspaceDb(coreDb);
      expect(listWorkspaceEvidenceBundles(workspaceDb, 'ws_demo')).toEqual([
        expect.objectContaining({
          importStatus: 'quarantined',
          sourceKind: 'worker-runtime-provenance-raw',
        }),
      ]);
      const runtimeEvidence = listWorkspaceRuntimeEvidence(workspaceDb, 'ws_demo').filter(
        (record) => record.phase === 'transcript-collection'
      );
      expect(runtimeEvidence).toEqual([
        expect.objectContaining({
          outcome: 'failed',
          phase: 'transcript-collection',
        }),
      ]);
      expect(runtimeEvidence[0]?.evidenceBundleIds).toHaveLength(1);
      workspaceDb.sqlite.close();
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('rejects missing durable capture history without falling back to current settings or launching', async () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-missing-capture-')));
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const turn = createAssignedTurn(store, 'ws_demo', 'th_demo', 'Reject missing binding');
    const turnPath = join(
      coreDb.dataRoot,
      'workspaces',
      turn.workspaceId,
      'threads',
      turn.threadId,
      'turns',
      turn.id,
      'turn.json'
    );
    const record = JSON.parse(readFileSync(turnPath, 'utf8'));
    delete record.captureCoverage;
    writeFileSync(turnPath, JSON.stringify(record));
    store.setLiveCaptureCoverage({ scope: 'server', value: 'on' });
    const backend = new FakeWorkerGovernanceBackend();
    const executor = new WorkerGovernanceTurnExecutor({
      backend,
      coreDb,
      environmentBackend: { kind: 'openshell' },
    });
    try {
      await expect(
        startWithExecutorAttempt(
          coreDb,
          executor,
          store,
          turn,
          'as_missing_capture',
          new Date().toISOString(),
          'Reject missing binding',
          {
            agentSetup: createTestAgentSetup(),
            requestId: '00000000-0000-4000-8000-000000000299',
            triggerActor: turn.triggerActor,
            workspaceRoots: [],
          }
        )
      ).rejects.toMatchObject({ code: 'recovery_required' });
      expect(backend.calls).toEqual([]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('binds the trusted provider selection into the materialized package', async () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-governance-admitted-')));
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const turn = createAssignedTurn(store, 'ws_demo', 'th_demo', 'Run trusted worker inference');
    const backend = new FakeWorkerGovernanceBackend();
    const executor = new WorkerGovernanceTurnExecutor({
      coreDb,
      backend,
      createAgentSessionId: () => 'as_governance_relay_1',
      environmentBackend: {
        kind: 'openshell',
      },
    });

    await startWithExecutorAttempt(
      coreDb,
      executor,
      store,
      turn,
      'as_governance_relay_1',
      new Date().toISOString(),
      'Run trusted worker inference',
      {
        agentSetup: createTestAgentSetup({
          requiredCapabilities: ['trusted-worker-inference-relay'],
        }),
        requestId: '00000000-0000-4000-8000-000000000214',
        triggerActor: turn.triggerActor,
        workspaceCwd: '/workspace/repo',
        workspaceRoots: [],
      }
    );

    expect(backend.lastPackage?.llm.routes).toEqual([
      expect.objectContaining({
        model: 'openai/gpt-5.2',
        providerInstanceId: 'openkit-gateway',
      }),
    ]);
    expect(backend.lastPackage).not.toHaveProperty('providers');
    coreDb.sqlite.close();
  });

  it.each([
    'utf8',
    'non-utf8',
  ] as const)('retains worker Git evidence without staging a host branch: $0', async (format) => {
    const fixture = createWorkspaceChangeIngressFixture('staged_review_branch', 'git');
    const stagedBytes =
      format === 'utf8' ? Buffer.from('# Demo\n\nReviewed.\n') : Buffer.from([98, 255, 10]);
    writeFileSync(join(fixture.repositoryPath, 'README.md'), stagedBytes);
    const patchBytes = execFileSync('git', ['diff', '--binary', '--full-index', '--no-ext-diff'], {
      cwd: fixture.repositoryPath,
    });
    writeFileSync(join(fixture.repositoryPath, 'README.md'), '# Demo\n');
    const digest = `sha256:${createHash('sha256').update(patchBytes).digest('hex')}`;
    const record: WorkerGovernanceWorkspaceChangeRecord = {
      ...fixture.record,
      changeSet: {
        ...fixture.record.changeSet,
        patch: { ...fixture.record.changeSet.patch!, digest, bytes: patchBytes.length },
      },
      patchPayload: {
        mediaType: 'text/x-diff',
        digest,
        bytes: patchBytes.length,
        text: patchBytes.toString(format === 'utf8' ? 'utf8' : 'base64'),
        ...(format === 'non-utf8' ? { encoding: 'base64' as const } : {}),
      },
    };
    const baseCommit = runTestGit(fixture.repositoryPath, ['rev-parse', 'HEAD']).trim();
    const initialStatus = runTestGit(fixture.repositoryPath, ['status', '--short']);
    const initialWorktrees = runTestGit(fixture.repositoryPath, [
      'worktree',
      'list',
      '--porcelain',
    ]);

    recordTestWorkspaceReviewMaterialization(fixture.workspaceDb, {
      artifactId: fixture.artifactId,
      ...record,
    });

    await ingestWorkspaceChangeFixture(fixture, record);

    const branchCommit = record.changeSet.head.commit;
    expect(() =>
      runTestGit(fixture.repositoryPath, ['rev-parse', '--verify', fixture.reviewBranchRef])
    ).toThrow();
    expect(listWorkspaceSyncReviews(fixture.workspaceDb, fixture.workspaceId)).toEqual([
      expect.objectContaining({
        artifactId: fixture.artifactId,
        patchPayload: record.patchPayload,
      }),
    ]);
    expect(runTestGit(fixture.repositoryPath, ['rev-parse', 'HEAD']).trim()).toBe(baseCommit);
    expect(runTestGit(fixture.repositoryPath, ['status', '--short'])).toBe(initialStatus);
    expect(runTestGit(fixture.repositoryPath, ['worktree', 'list', '--porcelain'])).toBe(
      initialWorktrees
    );
    expect(listWorkspaceChangeSets(fixture.workspaceDb, fixture.workspaceId)).toEqual([
      expect.objectContaining({
        head: expect.objectContaining({ commit: branchCommit }),
        id: record.changeSet.id,
      }),
    ]);
    const artifact = fixture.store.getArtifact(fixture.workspaceId, fixture.artifactId);
    const body = JSON.stringify(
      {
        changeSet: {
          ...record.changeSet,
          head: { ...record.changeSet.head, commit: branchCommit },
        },
        patchPayload: record.patchPayload,
        review: record.review,
      },
      null,
      2
    );
    expect(artifact).toMatchObject({
      content: { body, format: 'json' },
      contentDigest: `sha256:${createHash('sha256').update(body, 'utf8').digest('hex')}`,
      lastMutationRequestId: fixture.requestId,
      origin: {
        kind: 'turn-output',
        requestId: fixture.requestId,
        threadId: fixture.environmentPackage.scope.threadId,
        turnId: fixture.environmentPackage.scope.turnId,
      },
      status: 'ready',
      version: 1,
    });
    expect(
      fixture.store
        .getTurnEvents(fixture.environmentPackage.scope.turnId)
        .map((event) => ({ event: event.event, requestId: event.requestId, type: event.data.type }))
    ).toEqual([
      { event: 'item.created', requestId: fixture.requestId, type: 'item-created' },
      { event: 'item.completed', requestId: fixture.requestId, type: 'item-completed' },
      { event: 'artifact.created', requestId: fixture.requestId, type: 'artifact-created' },
    ]);
    fixture.workspaceDb.sqlite.close();
  });

  it('accepts equivalent workspace bases with different object key order', async () => {
    const fixture = createWorkspaceChangeIngressFixture('equivalent_base_key_order', 'git');
    const record = {
      ...fixture.record,
      changeSet: {
        ...fixture.record.changeSet,
        base: {
          contentDigest: fixture.record.changeSet.base.contentDigest,
          commit: fixture.record.changeSet.base.commit,
        },
      },
    } satisfies WorkerGovernanceWorkspaceChangeRecord;

    await ingestWorkspaceChangeFixture(fixture, record);

    expect(listWorkspaceSyncReviews(fixture.workspaceDb, fixture.workspaceId)).toEqual([
      expect.objectContaining({ review: expect.objectContaining({ id: fixture.reviewId }) }),
    ]);
    fixture.workspaceDb.sqlite.close();
  });

  it('rejects a workspace review without package request proof before Artifact or Review writes', async () => {
    const fixture = createWorkspaceChangeIngressFixture('missing_package_request_proof', 'git');
    const createArtifact = vi.spyOn(fixture.store, 'createArtifact');

    fixture.environmentPackage.scope.requestId = null;

    try {
      await expect(ingestWorkspaceChangeFixture(fixture, fixture.record)).rejects.toThrow();
      expect(createArtifact).not.toHaveBeenCalled();
      expect(listWorkspaceSyncReviews(fixture.workspaceDb, fixture.workspaceId)).toEqual([]);
    } finally {
      createArtifact.mockRestore();
      fixture.workspaceDb.sqlite.close();
    }
  });

  it('refuses governed dispatch without durable capture admission before Git backend effects', async () => {
    const fixture = createWorkspaceChangeIngressFixture('git_without_core_db', 'git');
    const backend = new FakeWorkerGovernanceBackend();
    const collectWorkspaceChanges = vi
      .spyOn(backend, 'collectWorkspaceChanges')
      .mockResolvedValue([fixture.record]);
    const executor = new WorkerGovernanceTurnExecutor({
      backend,
      createAgentSessionId: () => 'as_git_without_core_db_1',
      environmentBackend: {
        kind: 'openshell',
      },
      now: () => fixture.timestamp,
    });

    const before = fixture.store.getTurnById(fixture.environmentPackage.scope.turnId);
    try {
      await expect(
        executor.startTurn(
          fixture.store,
          fixture.environmentPackage.scope.turnId,
          'Review Git changes without durable workspace storage',
          {
            agentSetup: createTestAgentSetup(),
            requestId: '00000000-0000-4000-8000-000000000202',
            triggerActor: fixture.store.getTurnById(fixture.environmentPackage.scope.turnId)
              .triggerActor,
            workspaceRoots: [],
          }
        )
      ).rejects.toThrow('Governed execution requires its exact durable attempt.');

      expect(backend.calls).toEqual([]);
      expect(collectWorkspaceChanges).not.toHaveBeenCalled();
      expect(fixture.store.getTurnById(fixture.environmentPackage.scope.turnId)).toEqual(before);
    } finally {
      collectWorkspaceChanges.mockRestore();
      fixture.workspaceDb.sqlite.close();
    }
  });

  it('stores worker Git evidence in the owner-independent workspace', async () => {
    const fixture = createWorkspaceChangeIngressFixture('actor_scope', 'git');
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-governance-actor-scope-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    const workspace = store.listWorkspaces().find((candidate) => candidate.kind === 'code');
    if (!workspace) {
      throw new Error('Demo workspace was not created.');
    }
    const thread = store.listThreads(workspace.id)[0];
    if (!thread) {
      throw new Error('Demo thread was not created.');
    }
    const turn = createAssignedTurn(
      store,
      workspace.id,
      thread.id,
      'Persist workspace review records'
    );
    const setupDb = openWorkspaceDb(dataRoot, workspace.id);
    applyScopedMigrations(setupDb);
    setupDb.sqlite.close();
    const backend = new FakeWorkerGovernanceBackend();
    const collectWorkspaceChanges = vi
      .spyOn(backend, 'collectWorkspaceChanges')
      .mockImplementation(async () => {
        if (!backend.lastPackage) {
          throw new Error('Workspace package was not materialized.');
        }
        const commit = backend.lastPackage.workspace.inputs[0]?.source.commit;
        if (typeof commit !== 'string') {
          throw new Error('Workspace package did not capture its Git base.');
        }
        const base = { commit, contentDigest: null };
        return [
          {
            ...fixture.record,
            changeSet: {
              ...fixture.record.changeSet,
              base,
              evidenceRefs: [{ kind: 'worker', ref: turn.id }],
              inputSnapshotId: `wis_${backend.lastPackage.snapshotId}_repo`,
              materializationRecordId: `wmr_${backend.lastPackage.snapshotId}_repo`,
              workspaceId: workspace.id,
            },
            review: {
              ...fixture.record.review,
              workspaceId: workspace.id,
            },
          },
        ];
      });
    const executor = new WorkerGovernanceTurnExecutor({
      backend,
      coreDb,
      createAgentSessionId: () => 'as_actor_scope_1',
      environmentBackend: {
        kind: 'openshell',
      },
      now: () => fixture.timestamp,
    });
    let startError: unknown = null;

    try {
      try {
        await startWithExecutorAttempt(
          coreDb,
          executor,
          store,
          turn,
          'as_actor_scope_1',
          fixture.timestamp,
          'Persist workspace review records',
          {
            agentSetup: createTestAgentSetup(),
            requestId: '00000000-0000-4000-8000-000000000203',
            triggerActor: turn.triggerActor,
            workspaceCwd: null,
            workspaceDataSourceCatalog: {
              schemaVersion: 1,
              sources: [
                {
                  id: 'repo',
                  displayName: 'Remote Git source',
                  kind: 'git',
                  access: 'read-write',
                  allowedSlotKinds: ['worktree'],
                  sensitivity: 'internal',
                  status: 'active',
                  locator: {
                    url: 'https://example.invalid/source.git',
                    commit: fixture.record.changeSet.base.commit!,
                  },
                },
              ],
            },
            workspaceSourceRefs: { repo: 'repo' },
            workspaceRoots: [
              {
                access: 'read-write',
                id: 'repo',
                sourceKind: 'remote-git',
                sourceCommit: fixture.record.changeSet.base.commit!,
                workerPath: '/workspace/repo',
              },
            ],
          }
        );
      } catch (error) {
        startError = error;
      }

      const workspaceDb = openWorkspaceDb(dataRoot, workspace.id);
      applyScopedMigrations(workspaceDb);
      try {
        expect.soft(startError).toBeNull();
        expect.soft(listWorkspaceInputSnapshots(workspaceDb, workspace.id)).toHaveLength(1);
        expect.soft(listWorkspaceSyncReviews(workspaceDb, workspace.id)).toEqual([]);
        expect.soft(listWorkspaceChangeSets(workspaceDb, workspace.id)).toEqual([]);
        const evidence = store.getArtifact(
          workspace.id,
          `ar_workspace_changes_${turn.id}_${fixture.reviewId}`
        );
        expect(evidence).toMatchObject({
          workspaceId: workspace.id,
          origin: { threadId: turn.threadId, turnId: turn.id },
          title: 'Git work evidence',
          content: { format: 'json' },
        });
        const body = JSON.parse(evidence.content.body);
        expect(body).toMatchObject({
          changeSet: {
            id: fixture.record.changeSet.id,
            workspaceId: workspace.id,
            resourceId: 'repo',
          },
          patchPayload: fixture.record.patchPayload,
        });
        expect(body).not.toHaveProperty('review');
      } finally {
        workspaceDb.sqlite.close();
      }
    } finally {
      collectWorkspaceChanges.mockRestore();
      fixture.workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('retains a complete Artifact for exact retry when later ingress persistence fails', async () => {
    const fixture = createWorkspaceChangeIngressFixture('artifact_compensation', 'git');
    const createArtifact = fixture.store.createArtifact.bind(fixture.store);
    fixture.store.createArtifact = (artifact) => {
      const created = createArtifact(artifact);

      if (artifact.id === fixture.artifactId) {
        throw new Error('artifact persistence failed after write');
      }
      return created;
    };

    recordTestWorkspaceReviewMaterialization(fixture.workspaceDb, {
      artifactId: fixture.artifactId,
      ...fixture.record,
    });

    await expect(ingestWorkspaceChangeFixture(fixture, fixture.record)).rejects.toThrow(
      'artifact persistence failed after write'
    );

    const retainedArtifact = fixture.store.getArtifact(fixture.workspaceId, fixture.artifactId);
    expect(
      createDemoStore({ dataRoot: fixture.storeDataRoot }).getArtifact(
        fixture.workspaceId,
        fixture.artifactId
      )
    ).toEqual(retainedArtifact);
    expect(testGitRefExists(fixture.repositoryPath, fixture.reviewBranchRef)).toBe(false);
    expect(listWorkspaceChangeSets(fixture.workspaceDb, fixture.workspaceId)).toEqual([]);
    expect(listWorkspaceSyncReviews(fixture.workspaceDb, fixture.workspaceId)).toEqual([]);

    fixture.store.createArtifact = createArtifact;
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await ingestWorkspaceChangeFixture(fixture, fixture.record);

    expect(fixture.store.listArtifacts(fixture.workspaceId)).toEqual([retainedArtifact]);
    expect(listWorkspaceSyncReviews(fixture.workspaceDb, fixture.workspaceId)).toEqual([
      expect.objectContaining({ artifactId: fixture.artifactId }),
    ]);
    fixture.workspaceDb.sqlite.close();
  });

  it('retains a refinement-only candidate without staging a Git review branch', async () => {
    const fixture = createWorkspaceChangeIngressFixture('refinement_only', 'git');
    const record = {
      ...fixture.record,
      review: {
        ...fixture.record.review,
        staging: { ...fixture.record.review.staging, branch: null },
        validation: [
          {
            command: 'workspace-snapshot-apply',
            status: 'failed' as const,
            ref: null,
          },
        ],
      },
    };
    try {
      await expect(ingestWorkspaceChangeFixture(fixture, record)).resolves.toBeUndefined();
      expect(testGitRefExists(fixture.repositoryPath, fixture.reviewBranchRef)).toBe(false);
      expect(listWorkspaceSyncReviews(fixture.workspaceDb, fixture.workspaceId)).toEqual([
        expect.objectContaining({
          review: expect.objectContaining({ staging: expect.objectContaining({ branch: null }) }),
        }),
      ]);
      expect(listWorkspaceChangeSets(fixture.workspaceDb, fixture.workspaceId)).toHaveLength(1);
    } finally {
      fixture.workspaceDb.sqlite.close();
    }
  });

  const rejectedIngressCases: readonly {
    readonly inputStrategy?: 'git' | 'filesystem';
    readonly materializationStrategy?: 'git' | 'filesystem';
    readonly mutate: (
      record: WorkerGovernanceWorkspaceChangeRecord
    ) => WorkerGovernanceWorkspaceChangeRecord;
    readonly name: string;
    readonly strategy: 'git' | 'filesystem';
  }[] = [
    ...(['accepted', 'needs_refinement', 'rejected', 'blocked'] as const).map((status) => ({
      mutate: (record: WorkerGovernanceWorkspaceChangeRecord) => ({
        ...record,
        review: { ...record.review, status },
      }),
      name: `non-pending ${status} review`,
      strategy: 'git' as const,
    })),
    {
      mutate: (record) => ({
        ...record,
        review: {
          ...record.review,
          staging: {
            branch: null,
            ref: `filesystem-staging://${record.review.id}`,
            strategy: 'filesystem_staging',
          },
        },
      }),
      name: 'Git change set with filesystem staging',
      strategy: 'git',
    },
    {
      mutate: (record) => ({
        ...record,
        review: {
          ...record.review,
          staging: {
            branch: `openkit/review/${record.review.id}`,
            ref: `staging://workspace/${record.changeSet.id}`,
            strategy: 'git_worktree',
          },
        },
      }),
      name: 'filesystem change set with Git staging',
      strategy: 'filesystem',
    },
    {
      inputStrategy: 'filesystem',
      mutate: (record) => record,
      name: 'change-set and input-snapshot strategy mismatch',
      strategy: 'git',
    },
    {
      materializationStrategy: 'filesystem',
      mutate: (record) => record,
      name: 'change-set and materialization strategy mismatch',
      strategy: 'git',
    },
    {
      mutate: (record) => ({ ...record, filesystemApply: null }),
      name: 'filesystem change set without apply metadata',
      strategy: 'filesystem',
    },
    {
      mutate: (record) => ({
        ...record,
        filesystemApply: record.filesystemApply
          ? {
              ...record.filesystemApply,
              before: { ...record.filesystemApply.before, workspaceId: 'ws_other' },
            }
          : null,
      }),
      name: 'filesystem before snapshot from another workspace',
      strategy: 'filesystem',
    },
    {
      mutate: (record) => ({
        ...record,
        filesystemApply: record.filesystemApply
          ? {
              ...record.filesystemApply,
              before: { ...record.filesystemApply.before, resourceId: 'repo_other' },
            }
          : null,
      }),
      name: 'filesystem before snapshot from another resource',
      strategy: 'filesystem',
    },
    {
      mutate: (record) => ({
        ...record,
        filesystemApply: record.filesystemApply
          ? {
              ...record.filesystemApply,
              before: {
                ...record.filesystemApply.before,
                contentDigest: `sha256:${'9'.repeat(64)}`,
              },
            }
          : null,
      }),
      name: 'filesystem before snapshot with another content digest',
      strategy: 'filesystem',
    },
    {
      mutate: (record) => ({ ...record, patchPayload: null }),
      name: 'Git change set without patch payload',
      strategy: 'git',
    },
    {
      mutate: (record) => ({
        ...record,
        changeSet: { ...record.changeSet, patch: null },
      }),
      name: 'Git change set without patch reference',
      strategy: 'git',
    },
    {
      mutate: (record) => ({
        ...record,
        patchPayload: record.patchPayload
          ? { ...record.patchPayload, digest: `sha256:${'8'.repeat(64)}` }
          : null,
      }),
      name: 'Git patch payload that mismatches its reference',
      strategy: 'git',
    },
  ];

  it('retains Git-source output as evidence without a host repository or apply review', async () => {
    const fixture = createWorkspaceChangeIngressFixture('vendor_git_evidence', 'git');
    fixture.environmentPackage.workspace = {
      inputs: [{ id: 'repo', access: 'read-write', source: { kind: 'git' } }],
    } as AgentEnvironmentPackage['workspace'];
    try {
      await ingestWorkspaceChangeFixture(fixture, fixture.record);
      expect(
        fixture.store
          .listArtifacts(fixture.workspaceId)
          .find((artifact) => artifact.id === fixture.artifactId)
      ).toMatchObject({ kind: 'diff', title: 'Git work evidence' });
      expect(listWorkspaceSyncReviews(fixture.workspaceDb, fixture.workspaceId)).toEqual([]);
      expect(listWorkspaceChangeSets(fixture.workspaceDb, fixture.workspaceId)).toEqual([]);
      expect(testGitRefExists(fixture.repositoryPath, fixture.reviewBranchRef)).toBe(false);
    } finally {
      fixture.workspaceDb.sqlite.close();
    }
  });

  it('reports a non-secret workspace review actionability reason', async () => {
    const fixture = createWorkspaceChangeIngressFixture('actionability_reason', 'git');
    let ingressError: unknown;

    try {
      await ingestWorkspaceChangeFixture(fixture, {
        ...fixture.record,
        patchPayload: null,
      });
    } catch (error) {
      ingressError = error;
    }

    expect(ingressError).toMatchObject({
      message: `Workspace review is not actionable (git_patch_invalid): ${fixture.reviewId}`,
    });
    fixture.workspaceDb.sqlite.close();
  });

  it.each(rejectedIngressCases)('rejects $name before review effects', async ({
    inputStrategy,
    materializationStrategy,
    mutate,
    name,
    strategy,
  }) => {
    const fixture = createWorkspaceChangeIngressFixture(
      name.replaceAll(/[^a-z0-9]+/gi, '_').toLowerCase(),
      strategy
    );
    let ingressError: unknown;

    try {
      await ingestWorkspaceChangeFixture(
        fixture,
        mutate(fixture.record),
        inputStrategy,
        materializationStrategy
      );
    } catch (error) {
      ingressError = error;
    }

    expect({
      branchExists: testGitRefExists(fixture.repositoryPath, fixture.reviewBranchRef),
      changeSetIds: listWorkspaceChangeSets(fixture.workspaceDb, fixture.workspaceId).map(
        (changeSet) => changeSet.id
      ),
      filesystemStagingExists: Boolean(
        getFilesystemWorkspaceStagingRoot(
          fixture.workspaceDb,
          fixture.workspaceId,
          fixture.reviewId
        )
      ),
      rejected: ingressError instanceof Error,
      reviewArtifactIds: fixture.store
        .listArtifacts(fixture.workspaceId)
        .filter((artifact) => artifact.id === fixture.artifactId)
        .map((artifact) => artifact.id),
      reviewIds: listWorkspaceSyncReviews(fixture.workspaceDb, fixture.workspaceId).map(
        (item) => item.review.id
      ),
    }).toEqual({
      branchExists: false,
      changeSetIds: [],
      filesystemStagingExists: false,
      rejected: true,
      reviewArtifactIds: [],
      reviewIds: [],
    });
    fixture.workspaceDb.sqlite.close();
  });

  it('rejects a conflicting pre-existing review artifact without overwriting or deleting it', async () => {
    const fixture = createWorkspaceChangeIngressFixture('conflicting_artifact', 'git');
    const body = 'Unrelated artifact content.';
    const existingArtifact = fixture.store.createArtifact({
      content: { body, format: 'markdown' },
      contentDigest: `sha256:${createHash('sha256').update(body, 'utf8').digest('hex')}`,
      createdAt: fixture.timestamp,
      id: fixture.artifactId,
      kind: 'diff',
      lastMutationRequestId: fixture.requestId,
      origin: {
        kind: 'turn-output',
        requestId: fixture.requestId,
        threadId: fixture.environmentPackage.scope.threadId,
        turnId: fixture.environmentPackage.scope.turnId,
      },
      status: 'ready',
      summary: 'Existing unrelated artifact.',
      threadId: fixture.environmentPackage.scope.threadId,
      title: 'Existing unrelated artifact',
      turnId: fixture.environmentPackage.scope.turnId,
      updatedAt: fixture.timestamp,
      version: 1,
      workspaceId: fixture.workspaceId,
    });
    let ingressError: unknown;

    try {
      await ingestWorkspaceChangeFixture(fixture, fixture.record);
    } catch (error) {
      ingressError = error;
    }

    expect({
      artifactUnchanged:
        JSON.stringify(fixture.store.getArtifact(fixture.workspaceId, fixture.artifactId)) ===
        JSON.stringify(existingArtifact),
      branchExists: testGitRefExists(fixture.repositoryPath, fixture.reviewBranchRef),
      changeSetIds: listWorkspaceChangeSets(fixture.workspaceDb, fixture.workspaceId).map(
        (changeSet) => changeSet.id
      ),
      rejected: ingressError instanceof Error,
      reviewIds: listWorkspaceSyncReviews(fixture.workspaceDb, fixture.workspaceId).map(
        (item) => item.review.id
      ),
    }).toEqual({
      artifactUnchanged: true,
      branchExists: false,
      changeSetIds: [],
      rejected: true,
      reviewIds: [],
    });
    fixture.workspaceDb.sqlite.close();
  });

  it('passes failedCloseout into backend cleanup after rejected Workspace-change lineage', async () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-governance-failed-closeout-')));
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const turn = createAssignedTurn(store, 'ws_demo', 'th_demo', 'Fail missing-target handoff');
    const agentSessionId = 'as_failed_closeout_1';
    const packageSnapshotId = `aepsnap_${turn.id}_${agentSessionId}`;
    const sandboxBindingRef = 'lease-binding:failed-closeout';
    recordExecutorAttempt(coreDb, {
      agentSessionId,
      packageSnapshotId,
      sandboxBindingRef,
      threadId: turn.threadId,
      turnId: turn.id,
    });
    const backend = new FakeWorkerGovernanceBackend();
    const fixture = createWorkspaceChangeIngressFixture('failed_closeout_missing_target', 'git');
    vi.spyOn(backend, 'collectWorkspaceChanges').mockResolvedValue([fixture.record]);
    const cleanupSession = vi.spyOn(backend, 'cleanupSession');
    const executor = new WorkerGovernanceTurnExecutor({
      awaitWorkerCompletion: async () => ({
        acceptedAt: '2026-07-15T00:00:03.000Z',
        status: 'completed' as const,
        stopReason: 'completed',
      }),
      backend,
      coreDb,
      createAgentSessionId: () => agentSessionId,
      environmentBackend: {
        kind: 'openshell',
      },
      now: () => '2026-07-15T00:00:03.000Z',
    });

    try {
      await expect(
        executor.startTurn(store, turn.id, 'Fail missing-target handoff', {
          attemptId: `lease_${turn.id}`,
          agentSessionId,
          agentSetup: createTestAgentSetup(),
          requestId: '00000000-0000-4000-8000-000000000257',
          sandboxBindingRef,
          triggerActor: turn.triggerActor,
          workspaceRoots: [],
        })
      ).rejects.toThrow('Workspace review lineage mismatch');
      expect(cleanupSession).toHaveBeenCalledWith(expect.any(Object), { failedCloseout: true });
    } finally {
      fixture.workspaceDb.sqlite.close();
      coreDb.sqlite.close();
    }
  });

  it('adopts an exact orphan review artifact without rewriting it', async () => {
    const fixture = createWorkspaceChangeIngressFixture('exact_orphan_artifact', 'git');
    const review = fixture.record.review;
    const body = JSON.stringify(
      {
        changeSet: fixture.record.changeSet,
        patchPayload: fixture.record.patchPayload,
        review,
      },
      null,
      2
    );
    const orphanArtifact = fixture.store.createArtifact({
      content: { body, format: 'json' },
      contentDigest: `sha256:${createHash('sha256').update(body, 'utf8').digest('hex')}`,
      createdAt: fixture.timestamp,
      id: fixture.artifactId,
      kind: 'diff',
      lastMutationRequestId: fixture.requestId,
      origin: {
        kind: 'turn-output',
        requestId: fixture.requestId,
        threadId: fixture.environmentPackage.scope.threadId,
        turnId: fixture.environmentPackage.scope.turnId,
      },
      status: 'ready',
      summary: review.riskSummary,
      threadId: fixture.environmentPackage.scope.threadId,
      title: 'Workspace changes ready for review',
      turnId: fixture.environmentPackage.scope.turnId,
      updatedAt: fixture.timestamp,
      version: 1,
      workspaceId: fixture.workspaceId,
    });
    const createArtifact = vi.spyOn(fixture.store, 'createArtifact');

    try {
      recordTestWorkspaceReviewMaterialization(fixture.workspaceDb, {
        artifactId: fixture.artifactId,
        ...fixture.record,
      });
      await ingestWorkspaceChangeFixture(fixture, fixture.record);
      await ingestWorkspaceChangeFixture(fixture, fixture.record);

      expect(createArtifact.mock.calls.length).toBe(0);
      expect(fixture.store.getArtifact(fixture.workspaceId, fixture.artifactId)).toEqual(
        orphanArtifact
      );
      expect(listWorkspaceSyncReviews(fixture.workspaceDb, fixture.workspaceId)).toEqual([
        expect.objectContaining({ artifactId: fixture.artifactId, review }),
      ]);
      expect(fixture.store.getTurnEvents(fixture.environmentPackage.scope.turnId)).toEqual([]);
    } finally {
      createArtifact.mockRestore();
      fixture.workspaceDb.sqlite.close();
    }
  });

  it('passes user-declared sandbox access into the resolved worker package', async () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-governance-sandbox-access-')));

    applyMigrations(coreDb);

    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const turn = createAssignedTurn(store, 'ws_demo', 'th_demo', 'Run with sandbox access');
    const backend = new FakeWorkerGovernanceBackend();
    const executor = new WorkerGovernanceTurnExecutor({
      backend,
      coreDb,
      createAgentSessionId: () => 'as_sandbox_access_1',
      environmentBackend: {
        kind: 'openshell',
      },
      now: () => '2026-06-16T00:00:00.000Z',
    });

    await startWithExecutorAttempt(
      coreDb,
      executor,
      store,
      turn,
      'as_sandbox_access_1',
      '2026-06-15T23:59:59.000Z',
      'Run with sandbox access',
      {
        agentSetup: createTestAgentSetup({
          filesystem: [
            {
              access: 'read-write',
              id: 'tool_cache',
              purpose: 'Tool cache',
              targetPath: '/sandbox/.cache/tool',
            },
          ],
          network: [
            {
              host: 'registry.npmjs.org',
              id: 'npm_registry',
              port: 443,
              purpose: 'Install dependencies',
            },
          ],
        }),
        requestId: '00000000-0000-4000-8000-000000000204',
        triggerActor: turn.triggerActor,
        workspaceRoots: [],
      }
    );

    expect(backend.lastPackage?.policy.filesystem?.rules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'tool_cache',
          workerPath: '/sandbox/.cache/tool',
        }),
      ])
    );
    expect(backend.lastPackage?.policy.network?.rules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          host: 'registry.npmjs.org',
          id: 'npm_registry',
          port: 443,
        }),
      ])
    );

    coreDb.sqlite.close();
  });

  it.each([
    false,
    true,
  ])('persists primary HTTP facts when cleanup also fails: %s', async (cleanupFails) => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-primary-fetch-failure-')));
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const turn = createAssignedTurn(store, 'ws_demo', 'th_demo', 'Observe failed fetch');
    const backend = new FakeWorkerGovernanceBackend();
    const explanation = {
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
    } as const;
    vi.spyOn(backend, 'submit').mockRejectedValue(
      Object.assign(new Error('Repository access returned HTTP 403; attribution unavailable.'), {
        explanation,
      })
    );
    backend.failTeardown = cleanupFails;
    const executor = new WorkerGovernanceTurnExecutor({
      backend,
      coreDb,
      createAgentSessionId: () => 'as_fetch_failure',
      environmentBackend: { kind: 'openshell' },
      now: () => '2026-06-16T00:00:00.000Z',
    });
    try {
      await expect(
        startWithExecutorAttempt(
          coreDb,
          executor,
          store,
          turn,
          'as_fetch_failure',
          '2026-06-15T23:59:59.000Z',
          'Observe failed fetch',
          {
            agentSetup: createTestAgentSetup(),
            requestId: '00000000-0000-4000-8000-000000000205',
            triggerActor: turn.triggerActor,
            workspaceRoots: [],
          }
        )
      ).rejects.toThrow(
        cleanupFails
          ? 'Worker execution and backend cleanup failed'
          : 'Repository access returned HTTP 403'
      );
      expect(store.getTurnById(turn.id)).toMatchObject({
        status: 'failed',
        error: { explanation },
      });
      expect(store.getTurnEvents(turn.id)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: 'turn.completed',
            data: expect.objectContaining({
              turn: expect.objectContaining({ error: expect.objectContaining({ explanation }) }),
            }),
          }),
        ])
      );
      expect(backend.calls.filter((call) => call === 'cleanupSession')).toHaveLength(1);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('keeps workspace handles pending and omits teardown evidence when cleanup fails', async () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-governance-teardown-fail-')));

    applyMigrations(coreDb);

    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const turn = createAssignedTurn(store, 'ws_demo', 'th_demo', 'Run in OpenShell');
    const backend = new FakeWorkerGovernanceBackend({ sandboxName: 'sandbox_teardown_fail_1' });
    backend.failTeardown = true;
    const executor = new WorkerGovernanceTurnExecutor({
      backend,
      coreDb,
      createAgentSessionId: () => 'as_teardown_fail_1',
      environmentBackend: {
        kind: 'openshell',
      },
      now: () => '2026-06-16T00:00:00.000Z',
    });

    await expect(
      startWithExecutorAttempt(
        coreDb,
        executor,
        store,
        turn,
        'as_teardown_fail_1',
        '2026-06-15T23:59:59.000Z',
        'Run in OpenShell',
        {
          agentSetup: createTestAgentSetup(),
          requestId: '00000000-0000-4000-8000-000000000205',
          triggerActor: turn.triggerActor,
          ...remoteGitInputFixture(),
        }
      )
    ).rejects.toThrow('teardown failed');

    const workspaceDb = openTestWorkspaceDb(coreDb);

    expect(listBackendWorkspaceHandles(workspaceDb, 'ws_demo')).toEqual([
      expect.objectContaining({
        cleanupStatus: 'pending',
        workerSessionId: 'sandbox_teardown_fail_1',
      }),
    ]);
    expect(
      listWorkspaceRuntimeEvidence(workspaceDb, 'ws_demo').filter(
        (record) => record.phase === 'teardown'
      )
    ).toEqual([]);

    workspaceDb.sqlite.close();
    coreDb.sqlite.close();
  });

  it('retries teardown during final cleanup and records a successful retry', async () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-governance-teardown-retry-')));
    applyMigrations(coreDb);

    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const turn = createAssignedTurn(store, 'ws_demo', 'th_demo', 'Retry OpenShell teardown');
    const backend = new FakeWorkerGovernanceBackend({ sandboxName: 'sandbox_teardown_retry_1' });
    backend.teardownFailuresRemaining = 1;
    const executor = new WorkerGovernanceTurnExecutor({
      backend,
      coreDb,
      createAgentSessionId: () => 'as_teardown_retry_1',
      environmentBackend: {
        kind: 'openshell',
      },
    });

    await expect(
      startWithExecutorAttempt(
        coreDb,
        executor,
        store,
        turn,
        'as_teardown_retry_1',
        new Date().toISOString(),
        'Retry OpenShell teardown',
        {
          agentSetup: createTestAgentSetup(),
          requestId: '00000000-0000-4000-8000-000000000206',
          triggerActor: turn.triggerActor,
          ...remoteGitInputFixture(),
        }
      )
    ).rejects.toThrow('teardown failed');

    expect(executor.isTurnExecutionActive(turn.id)).toBe(false);
    expect(backend.calls.filter((call) => call === 'cleanupSession')).toHaveLength(2);
    expect(store.getTurnById(turn.id)).toMatchObject({ status: 'failed' });
    const workspaceDb = openTestWorkspaceDb(coreDb);
    expect(listBackendWorkspaceHandles(workspaceDb, 'ws_demo')).toEqual([
      expect.objectContaining({
        cleanupStatus: 'cleaned',
        workerSessionId: 'sandbox_teardown_retry_1',
      }),
    ]);
    expect(
      listWorkspaceRuntimeEvidence(workspaceDb, 'ws_demo').filter(
        (record) => record.phase === 'teardown'
      )
    ).toEqual([
      expect.objectContaining({
        agentSessionId: 'as_teardown_retry_1',
        outcome: 'succeeded',
        stopReason: 'completed',
        summary: 'Worker backend teardown succeeded.',
      }),
    ]);
    workspaceDb.sqlite.close();
    coreDb.sqlite.close();
  });

  it('closes workspace storage and fails the turn when cleanup status persistence fails', async () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-governance-cleanup-status-')));
    applyMigrations(coreDb);

    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const setupDb = openTestWorkspaceDb(coreDb);
    const sqlitePrototype = Object.getPrototypeOf(setupDb.sqlite) as {
      close: typeof setupDb.sqlite.close;
      prepare: typeof setupDb.sqlite.prepare;
    };
    const prepare = sqlitePrototype.prepare;
    const prepareSpy = vi.spyOn(sqlitePrototype, 'prepare').mockImplementation(function (sql) {
      if (sql.includes('UPDATE backend_workspace_handles')) {
        return {
          run: () => {
            throw new Error('cleanup status persistence failed');
          },
        } as ReturnType<typeof setupDb.sqlite.prepare>;
      }
      return prepare.call(this, sql);
    });
    const closeSpy = vi.spyOn(sqlitePrototype, 'close');
    setupDb.sqlite.close();
    closeSpy.mockClear();

    const turn = createAssignedTurn(store, 'ws_demo', 'th_demo', 'Fail cleanup status persistence');
    const backend = new FakeWorkerGovernanceBackend();
    const executor = new WorkerGovernanceTurnExecutor({
      backend,
      coreDb,
      createAgentSessionId: () => 'as_cleanup_status_1',
      environmentBackend: {
        kind: 'openshell',
      },
    });

    try {
      await expect(
        startWithExecutorAttempt(
          coreDb,
          executor,
          store,
          turn,
          'as_cleanup_status_1',
          new Date().toISOString(),
          'Fail cleanup status persistence',
          {
            agentSetup: createTestAgentSetup(),
            requestId: '00000000-0000-4000-8000-000000000207',
            triggerActor: turn.triggerActor,
            ...remoteGitInputFixture(),
          }
        )
      ).rejects.toThrow('cleanup status persistence failed');

      expect(backend.calls.filter((call) => call === 'cleanupSession')).toHaveLength(1);
      expect(store.getTurnById(turn.id)).toMatchObject({ status: 'failed' });
      expect(closeSpy).toHaveBeenCalledTimes(2);
    } finally {
      closeSpy.mockRestore();
      prepareSpy.mockRestore();
    }

    const workspaceDb = openTestWorkspaceDb(coreDb);
    expect(listBackendWorkspaceHandles(workspaceDb, 'ws_demo')).toEqual([
      expect.objectContaining({
        cleanupStatus: 'pending',
        workerSessionId: 'openkit-as_cleanup_status_1',
      }),
    ]);
    workspaceDb.sqlite.close();
    coreDb.sqlite.close();
  });

  it('fails with one terminal outcome when workspace storage cannot be opened', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-governance-workspace-open-fail-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);

    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const turn = createAssignedTurn(store, 'ws_demo', 'th_demo', 'Fail workspace storage open');
    recordExecutorAttempt(coreDb, {
      agentSessionId: 'as_workspace_open_fail_1',
      packageSnapshotId: `aepsnap_${turn.id}_as_workspace_open_fail_1`,
      sandboxBindingRef: `lease-binding:${turn.id}`,
      threadId: turn.threadId,
      turnId: turn.id,
    });
    rmSync(workspaceDbPath(dataRoot, 'ws_demo'), { force: true });
    mkdirSync(workspaceDbPath(dataRoot, 'ws_demo'), { recursive: true });
    const executor = new WorkerGovernanceTurnExecutor({
      backend: new FakeWorkerGovernanceBackend(),
      coreDb,
      createAgentSessionId: () => 'as_workspace_open_fail_1',
      environmentBackend: {
        kind: 'openshell',
      },
    });

    try {
      await expect(
        executor.startTurn(store, turn.id, 'Fail workspace storage open', {
          attemptId: `lease_${turn.id}`,
          agentSessionId: 'as_workspace_open_fail_1',
          sandboxBindingRef: `lease-binding:${turn.id}`,
          agentSetup: createTestAgentSetup(),
          requestId: '00000000-0000-4000-8000-000000000208',
          triggerActor: turn.triggerActor,
          workspaceRoots: [],
        })
      ).rejects.toThrow();

      expect(store.getTurnById(turn.id)).toMatchObject({ status: 'failed' });
      expect(
        store.getTurnEvents(turn.id).filter((event) => event.event === 'turn.completed')
      ).toEqual([
        expect.objectContaining({
          data: expect.objectContaining({ stopReason: 'error' }),
        }),
      ]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('fails with one terminal outcome when workspace storage migration fails', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-governance-workspace-migrate-fail-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    const setupDb = openWorkspaceDb(dataRoot, 'ws_demo');
    const sqlitePrototype = Object.getPrototypeOf(setupDb.sqlite) as {
      exec: typeof setupDb.sqlite.exec;
      prepare: typeof setupDb.sqlite.prepare;
    };
    setupDb.sqlite.close();
    const originalPrepare = sqlitePrototype.prepare;
    // Drizzle apply uses Database.prepare, not exec. Poison the workspace file's artifact_reviews statement only.
    const prepareSpy = vi.spyOn(sqlitePrototype, 'prepare').mockImplementation(function (
      this: { name?: string },
      sql: string,
      ...rest: unknown[]
    ) {
      const filename = typeof this.name === 'string' ? this.name : '';
      if (filename.endsWith('workspace.sqlite') && sql.includes('artifact_reviews')) {
        throw new Error('injected workspace migration failure');
      }
      return originalPrepare.call(this, sql, ...rest);
    });

    const turn = createAssignedTurn(
      store,
      'ws_demo',
      'th_demo',
      'Fail workspace storage migration'
    );
    recordExecutorAttempt(coreDb, {
      agentSessionId: 'as_workspace_migrate_fail_1',
      packageSnapshotId: `aepsnap_${turn.id}_as_workspace_migrate_fail_1`,
      sandboxBindingRef: `lease-binding:${turn.id}`,
      threadId: turn.threadId,
      turnId: turn.id,
    });
    const executor = new WorkerGovernanceTurnExecutor({
      backend: new FakeWorkerGovernanceBackend(),
      coreDb,
      createAgentSessionId: () => 'as_workspace_migrate_fail_1',
      environmentBackend: {
        kind: 'openshell',
      },
    });

    try {
      await expect(
        executor.startTurn(store, turn.id, 'Fail workspace storage migration', {
          attemptId: `lease_${turn.id}`,
          agentSessionId: 'as_workspace_migrate_fail_1',
          sandboxBindingRef: `lease-binding:${turn.id}`,
          agentSetup: createTestAgentSetup(),
          requestId: '00000000-0000-4000-8000-000000000209',
          triggerActor: turn.triggerActor,
          workspaceRoots: [],
        })
      ).rejects.toThrow(
        /Failed to apply workspace native Drizzle migrations:[\s\S]*artifact_reviews/
      );

      expect(store.getTurnById(turn.id)).toMatchObject({ status: 'failed' });
      expect(
        store.getTurnEvents(turn.id).filter((event) => event.event === 'turn.completed')
      ).toEqual([
        expect.objectContaining({
          data: expect.objectContaining({ stopReason: 'error' }),
        }),
      ]);
    } finally {
      prepareSpy.mockRestore();
      coreDb.sqlite.close();
    }
  });

  it('does not emit completed before failed when workspace storage close fails', async () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-governance-close-fail-')));
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const setupDb = openTestWorkspaceDb(coreDb);
    const sqlitePrototype = Object.getPrototypeOf(setupDb.sqlite) as {
      close: typeof setupDb.sqlite.close;
    };
    setupDb.sqlite.close();
    const closeSpy = vi.spyOn(sqlitePrototype, 'close').mockImplementationOnce(() => {
      throw new Error('workspace storage close failed');
    });

    const turn = createAssignedTurn(store, 'ws_demo', 'th_demo', 'Fail workspace storage close');
    const executor = new WorkerGovernanceTurnExecutor({
      backend: new FakeWorkerGovernanceBackend(),
      coreDb,
      createAgentSessionId: () => 'as_workspace_close_fail_1',
      environmentBackend: {
        kind: 'openshell',
      },
    });

    try {
      await expect(
        startWithExecutorAttempt(
          coreDb,
          executor,
          store,
          turn,
          'as_workspace_close_fail_1',
          new Date().toISOString(),
          'Fail workspace storage close',
          {
            agentSetup: createTestAgentSetup(),
            requestId: '00000000-0000-4000-8000-000000000210',
            triggerActor: turn.triggerActor,
            workspaceRoots: [],
          }
        )
      ).rejects.toThrow('workspace storage close failed');

      expect(store.getTurnById(turn.id)).toMatchObject({ status: 'failed' });
      expect(
        store.getTurnEvents(turn.id).filter((event) => event.event === 'turn.completed')
      ).toEqual([
        expect.objectContaining({
          data: expect.objectContaining({ stopReason: 'error' }),
        }),
      ]);
    } finally {
      closeSpy.mockRestore();
      coreDb.sqlite.close();
    }
  });

  it('fails terminally when completed turn persistence fails after the session becomes idle', async () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-governance-admitted-')));
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const turn = createAssignedTurn(store, 'ws_demo', 'th_demo', 'Fail completed turn persistence');
    const updateTurn = store.updateTurn.bind(store);
    const updateTurnSpy = vi.spyOn(store, 'updateTurn').mockImplementation((turnId, patch) => {
      if (patch.status === 'completed') {
        throw new Error('completed turn persistence failed');
      }
      return updateTurn(turnId, patch);
    });
    const executor = new WorkerGovernanceTurnExecutor({
      coreDb,
      backend: new FakeWorkerGovernanceBackend(),
      createAgentSessionId: () => 'as_completed_turn_persistence_fail_1',
      environmentBackend: {
        kind: 'openshell',
      },
    });

    try {
      await expect(
        startWithExecutorAttempt(
          coreDb,
          executor,
          store,
          turn,
          'as_completed_turn_persistence_fail_1',
          new Date().toISOString(),
          'Fail completed turn persistence',
          {
            agentSetup: createTestAgentSetup(),
            requestId: '00000000-0000-4000-8000-000000000211',
            triggerActor: turn.triggerActor,
            workspaceRoots: [],
          }
        )
      ).rejects.toThrow('completed turn persistence failed');

      expect(store.getAgentSession('as_completed_turn_persistence_fail_1')).toMatchObject({
        status: 'failed',
      });
      expect(store.getTurnById(turn.id)).toMatchObject({ status: 'failed' });
      expect(
        store.getTurnEvents(turn.id).filter((event) => event.event === 'turn.completed')
      ).toEqual([
        expect.objectContaining({
          data: expect.objectContaining({ stopReason: 'error' }),
        }),
      ]);
    } finally {
      updateTurnSpy.mockRestore();
    }
    coreDb.sqlite.close();
  });

  it('fails terminally when the backend rejects without an error value', async () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-governance-admitted-')));
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const turn = createAssignedTurn(store, 'ws_demo', 'th_demo', 'Reject without an error value');
    const backend = new FakeWorkerGovernanceBackend();
    const collectEvidenceSpy = vi.spyOn(backend, 'collectEvidence').mockRejectedValue(undefined);
    const executor = new WorkerGovernanceTurnExecutor({
      coreDb,
      backend,
      createAgentSessionId: () => 'as_falsey_rejection_1',
      environmentBackend: {
        kind: 'openshell',
      },
    });
    let rejected = false;

    try {
      await startWithExecutorAttempt(
        coreDb,
        executor,
        store,
        turn,
        'as_falsey_rejection_1',
        new Date().toISOString(),
        'Reject without an error value',
        {
          agentSetup: createTestAgentSetup(),
          requestId: '00000000-0000-4000-8000-000000000101',
          triggerActor: turn.triggerActor,
          workspaceRoots: [],
        }
      );
    } catch {
      rejected = true;
    } finally {
      collectEvidenceSpy.mockRestore();
    }

    expect({
      rejected,
      status: store.getTurnById(turn.id).status,
      terminalEvents: store
        .getTurnEvents(turn.id)
        .filter((event) => event.event === 'turn.completed'),
    }).toEqual({
      rejected: true,
      status: 'failed',
      terminalEvents: [
        expect.objectContaining({ data: expect.objectContaining({ stopReason: 'error' }) }),
      ],
    });
    coreDb.sqlite.close();
  });

  it('keeps one terminal outcome when completion notification fails before persistence', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-governance-terminal-notify-fail-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    const turn = createAssignedTurn(store, 'ws_demo', 'th_demo', 'Fail completion notification');
    const unsubscribe = store.addTurnListener(turn.id, (event) => {
      if (event.data.type === 'turn-completed' && event.data.stopReason === 'completed') {
        throw new Error('completion notification failed before persistence');
      }
    });
    const executor = new WorkerGovernanceTurnExecutor({
      coreDb,
      backend: new FakeWorkerGovernanceBackend(),
      createAgentSessionId: () => 'as_terminal_notify_fail_1',
      environmentBackend: {
        kind: 'openshell',
      },
    });
    let failure: unknown = null;

    try {
      await startWithExecutorAttempt(
        coreDb,
        executor,
        store,
        turn,
        'as_terminal_notify_fail_1',
        new Date().toISOString(),
        'Fail completion notification',
        {
          agentSetup: createTestAgentSetup(),
          requestId: '00000000-0000-4000-8000-000000000102',
          triggerActor: turn.triggerActor,
          workspaceRoots: [],
        }
      );
    } catch (error) {
      failure = error;
    } finally {
      unsubscribe();
    }

    const durableStore = createDemoStore({ dataRoot });
    const durableTurn = durableStore.getTurnById(turn.id);
    const terminalEvents = durableStore
      .getTurnEvents(turn.id)
      .filter((event) => event.event === 'turn.completed');

    expect(failure).toBeInstanceOf(Error);
    expect(terminalEvents).toHaveLength(1);
    expect(terminalEvents[0]).toMatchObject({
      data: { turn: { status: durableTurn.status } },
    });
    coreDb.sqlite.close();
  });

  it.each([
    'agent-session',
    'turn',
    'agent-session-event',
  ] as const)('terminalizes after the failed %s write reports an after-write failure', async (failurePoint) => {
    const dataRoot = mkdtempSync(join(tmpdir(), `openkit-governance-${failurePoint}-fail-`));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    const turn = createAssignedTurn(
      store,
      'ws_demo',
      'th_demo',
      `Fail ${failurePoint} persistence`
    );
    const backend = new FakeWorkerGovernanceBackend();
    const requestId =
      failurePoint === 'agent-session'
        ? '00000000-0000-4000-8000-000000000103'
        : failurePoint === 'turn'
          ? '00000000-0000-4000-8000-000000000104'
          : '00000000-0000-4000-8000-000000000105';
    const collectEvidenceSpy = vi
      .spyOn(backend, 'collectEvidence')
      .mockRejectedValue(new Error('worker execution failed'));
    let restoreFailure = (): void => {};
    let injected = false;

    if (failurePoint === 'agent-session') {
      const updateAgentSession = store.updateAgentSession.bind(store);
      const spy = vi.spyOn(store, 'updateAgentSession').mockImplementation((id, patch) => {
        const updated = updateAgentSession(id, patch);
        if (!injected && patch.status === 'failed') {
          injected = true;
          throw new Error('failed AgentSession persistence reported failure after write');
        }
        return updated;
      });
      restoreFailure = () => spy.mockRestore();
    } else if (failurePoint === 'turn') {
      const updateTurn = store.updateTurn.bind(store);
      const spy = vi.spyOn(store, 'updateTurn').mockImplementation((id, patch) => {
        const updated = updateTurn(id, patch);
        if (!injected && patch.status === 'failed') {
          injected = true;
          throw new Error('failed turn persistence reported failure after write');
        }
        return updated;
      });
      restoreFailure = () => spy.mockRestore();
    } else {
      const emitTurnEvent = store.emitTurnEvent.bind(store);
      const spy = vi.spyOn(store, 'emitTurnEvent').mockImplementation((id, event) => {
        const emitted = emitTurnEvent(id, event);
        if (
          !injected &&
          event.data.type === 'agent-session-updated' &&
          event.data.agentSession.status === 'failed'
        ) {
          injected = true;
          throw new Error('failed AgentSession event reported failure after write');
        }
        return emitted;
      });
      restoreFailure = () => spy.mockRestore();
    }

    const executor = new WorkerGovernanceTurnExecutor({
      coreDb,
      backend,
      createAgentSessionId: () => `as_${failurePoint}_fail_1`,
      environmentBackend: {
        kind: 'openshell',
      },
    });
    let failure: unknown = null;

    try {
      await startWithExecutorAttempt(
        coreDb,
        executor,
        store,
        turn,
        `as_${failurePoint}_fail_1`,
        new Date().toISOString(),
        `Fail ${failurePoint} persistence`,
        {
          agentSetup: createTestAgentSetup(),
          requestId,
          triggerActor: turn.triggerActor,
          workspaceRoots: [],
        }
      );
    } catch (error) {
      failure = error;
    } finally {
      restoreFailure();
      collectEvidenceSpy.mockRestore();
    }

    const durableStore = createDemoStore({ dataRoot });
    expect(failure).toBeInstanceOf(AggregateError);
    expect(durableStore.getTurnById(turn.id)).toMatchObject({ status: 'failed' });
    expect(
      durableStore.getTurnEvents(turn.id).filter((event) => event.event === 'turn.completed')
    ).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ stopReason: 'error' }),
      }),
    ]);
    coreDb.sqlite.close();
  });

  it('terminalizes setup failures after the turn and worker session exist', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-governance-setup-fail-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    const turn = createAssignedTurn(store, 'ws_demo', 'th_demo', 'Fail worker setup');
    const createItem = store.createItem.bind(store);
    const createItemSpy = vi.spyOn(store, 'createItem').mockImplementation((item) => {
      const created = createItem(item);
      if (item.id === `it_user_${turn.id}`) {
        throw new Error('worker setup failed after item persistence');
      }
      return created;
    });
    const executor = new WorkerGovernanceTurnExecutor({
      coreDb,
      backend: new FakeWorkerGovernanceBackend(),
      createAgentSessionId: () => 'as_setup_fail_1',
      environmentBackend: {
        kind: 'openshell',
      },
    });
    let failure: unknown = null;

    try {
      await startWithExecutorAttempt(
        coreDb,
        executor,
        store,
        turn,
        'as_setup_fail_1',
        new Date().toISOString(),
        'Fail worker setup',
        {
          agentSetup: createTestAgentSetup(),
          requestId: '00000000-0000-4000-8000-000000000106',
          triggerActor: turn.triggerActor,
          workspaceRoots: [],
        }
      );
    } catch (error) {
      failure = error;
    } finally {
      createItemSpy.mockRestore();
    }

    const durableStore = createDemoStore({ dataRoot });
    expect(failure).toBeInstanceOf(Error);
    expect(durableStore.getTurnById(turn.id)).toMatchObject({
      agentId: 'agent_codex_host',
      agentProfileId: 'default',
      agentSessionId: 'as_setup_fail_1',
      status: 'failed',
    });
    expect(
      durableStore.getTurnEvents(turn.id).filter((event) => event.event === 'turn.completed')
    ).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ stopReason: 'error' }),
      }),
    ]);
    coreDb.sqlite.close();
  });

  it.each([
    'source',
    'cursor',
    'historical',
    'unproved',
    'foreign-thread',
    'foreign-slot',
    'corrupt-cursor',
    'corrupt-receipt',
  ] as const)('passes workspace source catalog context and accepted base into the resolved handoff (override: %s)', async (mode) => {
    if (!['source', 'cursor', 'historical'].includes(mode)) {
      await assertNativePreSubmissionFault(mode as NativePreSubmissionFault);
      return;
    }
    const overrideBase = mode !== 'source';
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-governance-source-ref-')));

    applyMigrations(coreDb);

    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const repositoryPath = mkdtempSync(join(tmpdir(), 'openkit-governance-source-ref-repo-'));
    seedWritableGitRepository(repositoryPath);
    const turn = createAssignedTurn(store, 'ws_demo', 'th_demo', 'Run with source catalog');
    const backend = new FakeWorkerGovernanceBackend();
    const acceptedCommit = 'e'.repeat(40);
    const originalCommit = runTestGit(repositoryPath, ['rev-parse', 'HEAD']).trim();
    const materialize = backend.materialize.bind(backend);
    vi.spyOn(backend, 'materialize').mockImplementation(async (...args) => {
      const result = await materialize(...args);
      if (overrideBase) {
        const db = openTestWorkspaceDb(coreDb);
        const aep = args[0];
        const identity = {
          workspaceId: aep.scope.workspaceId,
          storageRef: 'storage_context',
          scopeDigest: `sha256:${'a'.repeat(64)}`,
          attachmentGeneration: 1,
          sandboxId: 'sandbox_context',
          workSlot: (aep.extensions.openkit as { workerStorage: { workSlotRef: string } })
            .workerStorage.workSlotRef,
          collectionId: 'baseline',
          agentSessionId: aep.scope.agentSessionId,
          threadId: aep.scope.threadId,
          turnId: aep.scope.turnId,
          packageSnapshotId: aep.snapshotId,
        };
        authorizeWorkspaceBaselineInitialization(db, identity);
        acceptWorkspaceBaseline(
          db,
          identity,
          { tree: 'a'.repeat(40), manifest: 'b'.repeat(40) },
          'a'.repeat(40),
          acceptedCommit
        );
        if (mode === 'historical') {
          acceptWorkspaceCapture(
            db,
            { ...identity, collectionId: 'capture_context' },
            { outcome: 'no_new_head', unstable: false },
            null
          );
          db.sqlite
            .prepare('UPDATE workspace_snapshot_cursors SET accepted_commit = ?')
            .run('f'.repeat(40));
        }
        db.sqlite.close();
      }
      return {
        ...result,
        ...(overrideBase ? { workspaceBaseCommits: { repo_default: acceptedCommit } } : {}),
      };
    });
    const executor = new WorkerGovernanceTurnExecutor({
      backend,
      coreDb,
      createAgentSessionId: () => 'as_source_ref_1',
      environmentBackend: {
        kind: 'openshell',
      },
    });

    // Observe the real finalized-package and Workspace-handoff consumers at the native effect.
    const launch = backend.submit.bind(backend);
    const launchEvidence: Array<() => void> = [];
    const launchGate = vi.spyOn(backend, 'submit').mockImplementation(async (...args) => {
      const aep = backend.lastPackage!;
      const attempt = observeExecutionAttempts(coreDb).find((row) => row.turn_id === turn.id);
      const db = openTestWorkspaceDb(coreDb);
      const snapshot = requireAgentEnvironmentPackageSnapshot(
        db,
        aep.scope.workspaceId,
        aep.snapshotId
      ).snapshot;
      const records = listWorkspaceMaterializationRecords(db, aep.scope.workspaceId);
      db.sqlite.close();
      const boundSession = store.getTurnById(turn.id).agentSessionId;
      const authority = operationAuthorizer.currentWorkerLineageWorkspaceAuthority(
        coreDb,
        { ...turnRuntimeLineage(aep), triggerActor: aep.scope.triggerActor },
        'runtime.launch',
        true
      );
      launchEvidence.push(() => {
        expect(attempt, 'A native effect requires its persisted exact attempt.').toBeDefined();
        expect(attempt).toMatchObject({
          phase: 'open',
          disposition: 'unknown',
          agent_session_id: aep.scope.agentSessionId,
          input_ref: aep.snapshotId,
        });
        expect(attempt!.operation_id).toEqual(expect.any(String));
        expect(snapshot).toEqual(aep);
        expect(records).toContainEqual(
          expect.objectContaining({
            packageSnapshotId: aep.snapshotId,
            inputSnapshotId: `wis_${aep.snapshotId}_repo_default`,
            workspaceId: aep.scope.workspaceId,
            workerSessionId: backend.lastPackage && backend.planSession(aep).backendSessionId,
            base: expect.objectContaining({
              commit: overrideBase ? acceptedCommit : originalCommit,
            }),
          })
        );
        expect(boundSession).toBe(aep.scope.agentSessionId);
        expect(authority).toBeTruthy();
      });
      return launch(...args);
    });
    const execution = startWithExecutorAttempt(
      coreDb,
      executor,
      store,
      turn,
      'as_source_ref_1',
      new Date().toISOString(),
      'Run with source catalog',
      {
        agentSetup: createTestAgentSetup(),
        requestId: '00000000-0000-4000-8000-000000000212',
        triggerActor: turn.triggerActor,
        workspaceDataSourceCatalog: {
          schemaVersion: 1,
          sources: [
            {
              access: 'read-write',
              allowedSlotKinds: ['worktree'],
              displayName: 'Main repository',
              id: 'repo_default',
              kind: 'git',
              locator: { url: 'https://example.invalid/source.git', commit: originalCommit },
              sensitivity: 'internal',
              status: 'active',
            },
          ],
        },
        workspaceRoots: [
          {
            access: 'read-write',
            id: 'repo_default',
            sourceKind: 'remote-git',
            sourceCommit: originalCommit,
            workerPath: '/workspace/openkit',
          },
        ],
        workspaceSourceRefs: { repo_default: 'repo_default' },
      }
    );

    await expect(execution).resolves.toBeUndefined();
    expect(launchEvidence).toHaveLength(1);
    launchEvidence[0]!();
    expect(backend.lastPackage?.workspace.inputs[0]?.source).toMatchObject({
      catalogEntryDigest: expect.stringMatching(/^sha256:/),
      kind: 'git',
      url: 'https://example.invalid/source.git',
      commit: originalCommit,
      sourceId: 'repo_default',
      sourceRef: 'repo_default',
    });
    const workspaceDb = openTestWorkspaceDb(coreDb);

    expect(listWorkspaceInputSnapshots(workspaceDb, 'ws_demo')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          base: expect.objectContaining({ commit: overrideBase ? acceptedCommit : originalCommit }),
          resourceId: 'repo_default',
          sourceId: 'repo_default',
        }),
      ])
    );
    expect(listWorkspaceMaterializationRecords(workspaceDb, 'ws_demo')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          base: expect.objectContaining({ commit: overrideBase ? acceptedCommit : originalCommit }),
          sourceId: 'repo_default',
        }),
      ])
    );

    workspaceDb.sqlite.close();
    launchGate.mockRestore();
    coreDb.sqlite.close();
  });

  it('accepts the exact Artifact Review follow-up request through the S39 boundary', async () => {
    const artifactContent = 'Redo this exact Artifact.';
    const workerRequest = JSON.stringify({
      kind: 'artifact-review-follow-up',
      workspaceId: 'ws_demo',
      reviewId: 'arev_demo',
      artifactId: 'ar_demo',
      artifactVersion: 1,
      contentDigest: `sha256:${createHash('sha256').update(artifactContent).digest('hex')}`,
      artifactContent,
      artifactMediaType: 'text/plain',
      sourceThreadId: 'th_demo',
      sourceTurnId: 'tu_source_review',
      sourceAgentId: 'agent_codex_host',
      materialProposal: null,
      decision: 'redo',
      feedback: 'Address the missing evidence.',
      decisionRequestId: '00000000-0000-4000-8000-000000000270',
      workerRequestId: '00000000-0000-4000-8000-000000000270',
    });
    const fixture = createWorkerContextExecutorFixture('artifact-follow-up', { workerRequest });
    const workspaceDb = openTestWorkspaceDb(fixture.coreDb);
    workspaceDb.sqlite.transaction(() => {})();
    workspaceDb.sqlite.close();
    const backend = new FakeWorkerGovernanceBackend();
    const executor = new WorkerGovernanceTurnExecutor({
      backend,
      coreDb: fixture.coreDb,
      createAgentSessionId: () => fixture.agentSessionId,
      environmentBackend: {
        kind: 'openshell',
      },
      now: () => '2026-07-15T00:00:03.000Z',
    });

    try {
      await executor.startTurn(fixture.store, fixture.turn.id, workerRequest, {
        attemptId: `lease_${fixture.turn.id}`,
        agentSessionId: fixture.agentSessionId,
        agentSetup: createTestAgentSetup(),
        requestId: fixture.requestId,
        sandboxBindingRef: fixture.sandboxBindingRef,
        triggerActor: fixture.turn.triggerActor,
        workspaceRoots: [],
      });
      expect(readFileSync(join(fixture.packageRoot, 'instructions.md'), 'utf8')).toBe(
        workerRequest
      );
    } finally {
      fixture.coreDb.sqlite.close();
    }
  });

  it.each([
    'outcome',
    'carried',
  ] as const)('preserves checkpoint-free %s delivery before native launch', async (cause) => {
    const triggerInput = 'Receive pending request outcomes.';
    const fixture = createWorkerContextExecutorFixture(`pending-${cause}`, {
      workerRequest: triggerInput,
    });
    const workspaceDb = openTestWorkspaceDb(fixture.coreDb);
    const pendingRequestId = 'pending_context_question';
    const now = '2026-07-15T00:00:03.000Z';
    clearWorkerCheckpoint(
      workspaceDb,
      fixture.turn.workspaceId,
      fixture.turn.threadId,
      fixture.turn.id
    );
    raisePendingRequest(workspaceDb.sqlite, {
      requestId: pendingRequestId,
      workspaceId: fixture.turn.workspaceId,
      threadId: fixture.turn.threadId,
      raisingTurnId: 'tu_previous_question',
      requestItemId: 'it_previous_question',
      kind: 'user-input',
      requesterKind: 'worker',
      agentId: fixture.turn.agentId,
      responsibleUserId: LOCAL_USER_ID,
      questions: [{ id: 'tone', header: 'Tone', question: 'Which tone?', options: [] }],
      now,
    });
    answerPendingRequest(
      workspaceDb.sqlite,
      pendingRequestId,
      { kind: 'user', id: LOCAL_USER_ID },
      { tone: ['Detailed'] },
      now
    );
    expect(
      freezeReadyOutcomes(workspaceDb.sqlite, {
        workspaceId: fixture.turn.workspaceId,
        threadId: fixture.turn.threadId,
        turnId: fixture.turn.id,
        executor: 'worker',
        agentId: fixture.turn.agentId,
        cause,
        now,
      })
    ).toHaveLength(1);
    const frozenInput = frozenPendingOutcomeInput(
      workspaceDb.sqlite,
      fixture.turn.id,
      triggerInput
    );
    const app = createApp({ coreDb: fixture.coreDb, mode: 'local', store: fixture.store });
    if (cause === 'carried') {
      fixture.store.recordCommandRequest({
        command: 'turn.start',
        requestId: fixture.requestId,
        scope: { workspaceId: fixture.turn.workspaceId, threadId: fixture.turn.threadId },
        inputHash: commandInputHash({
          workspaceId: fixture.turn.workspaceId,
          threadId: fixture.turn.threadId,
          requestId: fixture.requestId,
          input: triggerInput,
          profileId: 'profile_worker',
        }),
        response: { kind: 'turn', id: fixture.turn.id },
      });
    }
    const backend = new FakeWorkerGovernanceBackend();
    const nativeLaunch = backend.submit.bind(backend);
    const launch = vi.spyOn(backend, 'submit').mockImplementation(async (...args) => {
      if (cause === 'carried') {
        const replay = await app.request('/api/app/operations/turn.start', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-openkit-request-id': fixture.requestId,
          },
          body: JSON.stringify({
            workspaceId: fixture.turn.workspaceId,
            threadId: fixture.turn.threadId,
            input: triggerInput,
            profileId: 'profile_worker',
          }),
        });
        expect(replay.status, await replay.clone().text()).toBe(202);
        expect(await replay.json()).toMatchObject({ id: fixture.turn.id, status: 'running' });
      }
      if (cause === 'outcome') {
        const digest = readStrictWorkerContextPackageDigest({
          coreDb: fixture.coreDb,
          workspaceDb,
          store: fixture.store,
          threadId: fixture.turn.threadId,
          turnId: fixture.turn.id,
        });
        expect(digest).toMatch(/^ctxpkg_sha256_[a-f0-9]{64}$/);
        expect(readFileSync(join(fixture.packageRoot, 'instructions.md'), 'utf8')).toBe(
          frozenInput
        );
      }
      expect(
        fixture.store
          .listThreadItems(fixture.turn.workspaceId, fixture.turn.threadId)
          .find((item) => item.id === `it_user_${fixture.turn.id}`)
      ).toMatchObject({
        type: 'user-message',
        text: cause === 'outcome' ? frozenInput : triggerInput,
        actor:
          cause === 'outcome'
            ? { kind: 'system', id: 'nanocore-pending-request', responsibleUserId: LOCAL_USER_ID }
            : fixture.turn.triggerActor,
      });
      return nativeLaunch(...args);
    });
    const executor = new WorkerGovernanceTurnExecutor({
      backend,
      coreDb: fixture.coreDb,
      createAgentSessionId: () => fixture.agentSessionId,
      now: () => now,
    });
    try {
      await executor.startTurn(fixture.store, fixture.turn.id, triggerInput, {
        attemptId: `lease_${fixture.turn.id}`,
        agentSessionId: fixture.agentSessionId,
        agentSetup: createTestAgentSetup(),
        requestId: fixture.requestId,
        sandboxBindingRef: fixture.sandboxBindingRef,
        triggerActor: fixture.turn.triggerActor,
        workspaceRoots: [],
      });
      expect(launch).toHaveBeenCalledOnce();
      expect(
        getWorkerCheckpoint(
          workspaceDb,
          fixture.turn.workspaceId,
          fixture.turn.threadId,
          fixture.turn.id
        )
      ).toBeNull();
    } finally {
      workspaceDb.sqlite.close();
      fixture.coreDb.sqlite.close();
    }
  });

  it('excludes an automatic binding that exceeds the remaining Context Package budget', async () => {
    const fixture = createWorkerContextExecutorFixture('binding-budget', {
      materialContent: 'B'.repeat(5_000),
      maxContextTokens: 1_000,
    });
    const {
      agentSessionId,
      coreDb,
      material,
      queuedMaterial,
      requestId,
      revision,
      sandboxBindingRef,
      store,
      tracePath,
      turn,
      workerRequest,
    } = fixture;
    const backend = new FakeWorkerGovernanceBackend();
    const launchSpy = vi.spyOn(backend, 'submit');
    const executor = new WorkerGovernanceTurnExecutor({
      backend,
      coreDb,
      createAgentSessionId: () => agentSessionId,
      environmentBackend: {
        kind: 'openshell',
      },
      now: () => '2026-07-15T00:00:03.000Z',
    });

    try {
      await executor.startTurn(store, turn.id, workerRequest, {
        attemptId: `lease_${turn.id}`,
        agentSessionId,
        agentSetup: createTestAgentSetup(),
        requestId,
        sandboxBindingRef,
        triggerActor: turn.triggerActor,
        workspaceRoots: [],
      });
      expect(launchSpy).toHaveBeenCalledTimes(1);
      expect(JSON.parse(readFileSync(tracePath, 'utf8'))).toMatchObject({
        materialExclusions: [
          {
            materialId: material.materialId,
            reason: 'budget_exceeded',
            revisionId: revision.revisionId,
            sensitivity: 'internal',
          },
        ],
        materialSelections: [],
      });
      const reopenedDb = openTestWorkspaceDb(coreDb);
      expect(selectQueuedThreadMaterialRevision(reopenedDb, turn.threadId)).toEqual(queuedMaterial);
      reopenedDb.sqlite.close();
    } finally {
      launchSpy.mockRestore();
      coreDb.sqlite.close();
    }
  });

  it('delivers direct-Task Knowledge through S39 and proves exact completed-work proposal lineage', async () => {
    const fixture = createWorkerContextExecutorFixture('task-knowledge');
    const knowledge = fixture.store.createKnowledgeEntry('ws_demo', {
      content: 'Zygomorphic worker guidance belongs in the existing Context Package.',
      kind: 'project-context',
      title: 'Zygomorphic worker guidance',
    });
    const oversizedKnowledge = fixture.store.createKnowledgeEntry('ws_demo', {
      content: `Zygomorphic worker guidance that exceeds the package budget.\n${'X'.repeat(50_000)}`,
      kind: 'project-context',
      title: 'Oversized zygomorphic worker guidance',
    });
    const retrievalTraceId = 'krt_0190f4c8-0000-7000-8000-000000000398';
    const retrieval = retrieveWorkspaceKnowledge({
      caller: 'task-mode',
      dataRoot: fixture.coreDb.dataRoot,
      limit: 5,
      pinnedConceptIds: [],
      query: 'Zygomorphic worker guidance',
      traceId: retrievalTraceId,
      workspaceId: fixture.turn.workspaceId,
    });
    const knowledgePagesRoot = join(
      fixture.coreDb.dataRoot,
      'workspaces',
      fixture.turn.workspaceId,
      'knowledge',
      'pages'
    );
    const knowledgePagePath = join(knowledgePagesRoot, `${knowledge.id}.md`);
    const knowledgePageBytes = readFileSync(knowledgePagePath, 'utf8');
    const knowledgePageDigest = turnRuntimeSha256(Buffer.from(knowledgePageBytes, 'utf8'));
    const oversizedKnowledgePageBytes = readFileSync(
      join(knowledgePagesRoot, `${oversizedKnowledge.id}.md`),
      'utf8'
    );
    const oversizedKnowledgePageDigest = turnRuntimeSha256(
      Buffer.from(oversizedKnowledgePageBytes, 'utf8')
    );
    expect(retrieval.selected).toHaveLength(2);
    expect(retrieval.selected).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          contentDigest: knowledgePageDigest,
          knowledgePageId: knowledge.id,
          sourceReferences: [],
        }),
        expect.objectContaining({
          contentDigest: oversizedKnowledgePageDigest,
          knowledgePageId: oversizedKnowledge.id,
          sourceReferences: [],
        }),
      ])
    );

    const workspaceDb = openTestWorkspaceDb(fixture.coreDb);
    const checkpoint = getWorkerCheckpoint(
      workspaceDb,
      fixture.turn.workspaceId,
      fixture.turn.threadId,
      fixture.turn.id
    )!;
    workspaceDb.sqlite.transaction(() => {
      upsertWorkerCheckpoint(workspaceDb, {
        diagnosticsSummary: createWorkerCheckpointContextDiagnostics({
          contextDigest: commandInputHash(fixture.workerRequest),
          contextRefs: [],
          knowledgeSelectionInput: { retrievalTraceId },
          repositoryResourceId: 'repo_default',
        }),
        goalId: null,
        iteration: checkpoint.iteration,
        requestId: checkpoint.requestId,
        requestInputHash: checkpoint.requestInputHash,
        stage: 'preparing',
        taskId: null,
        threadId: fixture.turn.threadId,
        turnId: fixture.turn.id,
        workspaceId: fixture.turn.workspaceId,
      });
    })();
    workspaceDb.sqlite.close();

    const backend = new FakeWorkerGovernanceBackend();
    const launch = backend.submit.bind(backend);
    const launchSpy = vi.spyOn(backend, 'submit').mockImplementation(async (...args) => {
      expect(JSON.parse(readFileSync(fixture.tracePath, 'utf8'))).toMatchObject({
        goalId: null,
        knowledgeExclusions: [
          {
            contentDigest: oversizedKnowledgePageDigest,
            knowledgePageId: oversizedKnowledge.id,
            reason: 'budget_exceeded',
          },
        ],
        knowledgeSelectionInput: { retrievalTraceId },
        knowledgeSelections: [
          {
            contentDigest: knowledgePageDigest,
            knowledgePageId: knowledge.id,
            packagePath: `knowledge/pages/${knowledge.id}.md`,
            sourceRefs: [],
          },
        ],
        taskId: null,
      });
      expect(
        readFileSync(join(fixture.packageRoot, 'knowledge', 'pages', `${knowledge.id}.md`), 'utf8')
      ).toBe(knowledgePageBytes);
      expect(
        existsSync(join(fixture.packageRoot, 'knowledge', 'pages', `${oversizedKnowledge.id}.md`))
      ).toBe(false);
      return launch(...args);
    });
    const executor = new WorkerGovernanceTurnExecutor({
      backend,
      coreDb: fixture.coreDb,
      createAgentSessionId: () => fixture.agentSessionId,
      environmentBackend: {
        kind: 'openshell',
      },
      now: () => '2026-07-15T00:00:03.000Z',
    });

    try {
      await executor.startTurn(fixture.store, fixture.turn.id, fixture.workerRequest, {
        attemptId: `lease_${fixture.turn.id}`,
        agentSessionId: fixture.agentSessionId,
        agentSetup: createTestAgentSetup(),
        requestId: fixture.requestId,
        sandboxBindingRef: fixture.sandboxBindingRef,
        triggerActor: fixture.turn.triggerActor,
        workspaceRoots: [],
      });
      expect(launchSpy).toHaveBeenCalledTimes(1);

      const completedTurn = fixture.store.getTurn(
        fixture.turn.workspaceId,
        fixture.turn.threadId,
        fixture.turn.id
      );
      const completedAssistantItems = fixture.store
        .listThreadItems(fixture.turn.workspaceId, fixture.turn.threadId)
        .filter(
          (item) =>
            item.turnId === fixture.turn.id &&
            item.type === 'assistant-message' &&
            item.status === 'completed'
        );
      const finalAssistantItem = completedAssistantItems.at(-1)!;
      const earlierAssistantItem = completedAssistantItems[0]!;
      const contextTrace = JSON.parse(readFileSync(fixture.tracePath, 'utf8')) as {
        contextPackageDigest: string;
        goalId: string | null;
        knowledgeSelectionInput: unknown | null;
        taskId: string | null;
      };
      expect(completedTurn.status).toBe('completed');
      expect(contextTrace).toMatchObject({
        goalId: null,
        knowledgeSelectionInput: expect.any(Object),
        taskId: null,
      });
      expect(finalAssistantItem.id).not.toBe(earlierAssistantItem.id);

      const sourceReferences = [
        `context-package:${fixture.turn.id}@${contextTrace.contextPackageDigest}`,
        `item:${finalAssistantItem.id}`,
        `turn:${fixture.turn.id}`,
      ];
      const candidatePageBytes = [
        '---',
        'type: "KnowledgePage"',
        'title: "Direct Task lesson"',
        'schema_version: "openkit-workspace-knowledge-schema-v2"',
        'openkit_status: "active"',
        'status: "stable"',
        'scope: "workspace"',
        'openkit_entry_id: "direct-task-lesson"',
        'openkit_entry_kind: "project-context"',
        `source_refs: ${JSON.stringify(sourceReferences)}`,
        'review_state: "accepted"',
        'sensitivity: "normal"',
        'freshness: "current"',
        'created_at: "2026-07-19T00:00:00.000Z"',
        'updated_at: "2026-07-19T00:00:00.000Z"',
        '---',
        'The retained direct Task supports this reusable lesson.',
        '',
      ].join('\n');
      const app = createApp({ coreDb: fixture.coreDb, mode: 'local', store: fixture.store });
      const draftRequest = {
        requestId: '00000000-0000-4000-8000-000000000639',
        knowledgePageId: 'direct-task-lesson',
        canonicalPageBytes: candidatePageBytes,
        contentDigest: turnRuntimeSha256(Buffer.from(candidatePageBytes, 'utf8')),
        sourceReferences,
        rationale: 'Retain one source-traceable lesson from the completed direct Task.',
        confidence: 0.8,
      };
      const draftResponse = await app.request(
        ...knowledgeOperationRequest(
          'knowledge.proposal.draft',
          { workspaceId: 'ws_demo' },
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(draftRequest),
          }
        )
      );
      expect(draftResponse.status, await draftResponse.clone().text()).toBe(200);
      const drafted = KnowledgeManagerDraftProposalResponseSchema.parse(await draftResponse.json());
      expect(drafted.validation).toEqual({
        conformance: 'Workspace-schema-valid',
        generatedFromCompletedWorkHistory: true,
      });

      const invalidSourceReferences = sourceReferences.map((reference) =>
        reference === `item:${finalAssistantItem.id}`
          ? `item:${earlierAssistantItem.id}`
          : reference
      );
      const invalidCandidatePageBytes = candidatePageBytes.replace(
        JSON.stringify(sourceReferences),
        JSON.stringify(invalidSourceReferences)
      );
      const invalidDraftResponse = await app.request(
        ...knowledgeOperationRequest(
          'knowledge.proposal.draft',
          { workspaceId: 'ws_demo' },
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              requestId: '00000000-0000-4000-8000-000000000640',
              knowledgePageId: 'direct-task-lesson',
              canonicalPageBytes: invalidCandidatePageBytes,
              contentDigest: turnRuntimeSha256(Buffer.from(invalidCandidatePageBytes, 'utf8')),
              sourceReferences: invalidSourceReferences,
              rationale: 'An earlier completed Item must not masquerade as final worker output.',
              confidence: 0.8,
            }),
          }
        )
      );
      expect(invalidDraftResponse.status).toBe(400);
      await expect(invalidDraftResponse.json()).resolves.toMatchObject({ code: 'invalid_request' });
      expect(fixture.store.listKnowledgeProposals('ws_demo')).toHaveLength(1);

      const decisionRequestId = '00000000-0000-4000-8000-000000000641';
      const acceptedDecision = await app.request(
        ...knowledgeOperationRequest(
          'knowledge.proposal.decide',
          { workspaceId: 'ws_demo', proposalId: drafted.proposal.id },
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ requestId: decisionRequestId, decision: 'accepted' }),
          }
        )
      );
      expect(acceptedDecision.status, await acceptedDecision.clone().text()).toBe(200);
      const retrievalResponse = await app.request(
        ...knowledgeOperationRequest(
          'knowledge.retrieval',
          { workspaceId: 'ws_demo' },
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              query: 'Direct Task lesson',
              limit: 5,
              pinnedConceptIds: [],
            }),
          }
        )
      );
      expect(retrievalResponse.status, await retrievalResponse.clone().text()).toBe(200);
      const acceptedRetrieval = (await retrievalResponse.json()) as {
        selected: Array<{ knowledgePageId: string; sourceReferences: string[] }>;
      };
      expect(acceptedRetrieval.selected).toEqual([
        expect.objectContaining({
          knowledgePageId: 'direct-task-lesson',
          sourceReferences,
        }),
      ]);
      const pagePath = join(
        fixture.coreDb.dataRoot,
        'workspaces',
        'ws_demo',
        'knowledge',
        'pages',
        'direct-task-lesson.md'
      );
      const changedPageBytes = `${candidatePageBytes}Intervening edit.\n`;
      writeFileSync(pagePath, changedPageBytes, 'utf8');

      const workspaceDb = openTestWorkspaceDb(fixture.coreDb);
      workspaceDb.sqlite
        .prepare(
          `DELETE FROM idempotency_requests
           WHERE command_name = 'knowledge.proposal.draft' AND request_id = ?`
        )
        .run(draftRequest.requestId);
      workspaceDb.sqlite
        .prepare(
          `DELETE FROM idempotency_requests
           WHERE command_name = 'knowledge.proposal.decide' AND request_id = ?`
        )
        .run(decisionRequestId);
      workspaceDb.sqlite
        .prepare('DELETE FROM audit_events WHERE request_id = ?')
        .run(decisionRequestId);
      workspaceDb.sqlite.close();
      rmSync(fixture.tracePath);
      const interruptedReplay = await app.request(
        ...knowledgeOperationRequest(
          'knowledge.proposal.draft',
          { workspaceId: 'ws_demo' },
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(draftRequest),
          }
        )
      );
      expect(interruptedReplay.status).toBe(409);
      await expect(interruptedReplay.json()).resolves.toMatchObject({
        code: 'recovery_required',
      });
      expect(fixture.store.listKnowledgeProposals('ws_demo')).toHaveLength(1);

      const conflictingResume = await app.request(
        ...knowledgeOperationRequest(
          'knowledge.proposal.decide',
          { workspaceId: 'ws_demo', proposalId: drafted.proposal.id },
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ requestId: decisionRequestId, decision: 'accepted' }),
          }
        )
      );
      expect(conflictingResume.status).toBe(409);
      await expect(conflictingResume.json()).resolves.toMatchObject({
        code: 'recovery_required',
      });
      expect(readFileSync(pagePath, 'utf8')).toBe(changedPageBytes);
    } finally {
      launchSpy.mockRestore();
      fixture.coreDb.sqlite.close();
    }
  });

  it('fails closed when a direct Task checkpoint lacks its governed Knowledge selection', async () => {
    const fixture = createWorkerContextExecutorFixture('task-knowledge-missing');
    const workspaceDb = openTestWorkspaceDb(fixture.coreDb);
    const checkpoint = getWorkerCheckpoint(
      workspaceDb,
      fixture.turn.workspaceId,
      fixture.turn.threadId,
      fixture.turn.id
    )!;
    upsertWorkerCheckpoint(workspaceDb, {
      diagnosticsSummary: null,
      goalId: null,
      iteration: checkpoint.iteration,
      requestId: checkpoint.requestId,
      requestInputHash: checkpoint.requestInputHash,
      stage: 'preparing',
      taskId: null,
      threadId: fixture.turn.threadId,
      turnId: fixture.turn.id,
      workspaceId: fixture.turn.workspaceId,
    });
    workspaceDb.sqlite.close();

    const backend = new FakeWorkerGovernanceBackend();
    const launchSpy = vi.spyOn(backend, 'submit');
    const executor = new WorkerGovernanceTurnExecutor({
      backend,
      coreDb: fixture.coreDb,
      createAgentSessionId: () => fixture.agentSessionId,
      environmentBackend: {
        kind: 'openshell',
      },
      now: () => '2026-07-15T00:00:03.000Z',
    });

    try {
      await expect(
        executor.startTurn(fixture.store, fixture.turn.id, fixture.workerRequest, {
          attemptId: `lease_${fixture.turn.id}`,
          agentSessionId: fixture.agentSessionId,
          agentSetup: createTestAgentSetup(),
          requestId: fixture.requestId,
          sandboxBindingRef: fixture.sandboxBindingRef,
          triggerActor: fixture.turn.triggerActor,
          workspaceRoots: [],
        })
      ).rejects.toMatchObject({ code: 'recovery_required', status: 409 });
      expect(launchSpy).not.toHaveBeenCalled();
      expect(existsSync(fixture.tracePath)).toBe(false);
    } finally {
      launchSpy.mockRestore();
      fixture.coreDb.sqlite.close();
    }
  });

  it.each([
    {
      name: 'direct-task',
      turnId: expectedTaskModeTurnId(
        'task.start',
        LOCAL_USER_ID,
        'ws_demo',
        'th_demo',
        '00000000-0000-4000-8000-000000000270'
      ),
    },
    {
      name: 'actor-mismatch',
      turnId: expectedTaskModeTurnId(
        'conversation.submit.task',
        'user_forged',
        'ws_demo',
        'th_demo',
        '00000000-0000-4000-8000-000000000270'
      ),
    },
    {
      name: 'workspace-mismatch',
      turnId: expectedTaskModeTurnId(
        'conversation.submit.task',
        LOCAL_USER_ID,
        'ws_other',
        'th_demo',
        '00000000-0000-4000-8000-000000000270'
      ),
    },
    {
      name: 'thread-mismatch',
      turnId: expectedTaskModeTurnId(
        'conversation.submit.task',
        LOCAL_USER_ID,
        'ws_demo',
        'th_other',
        '00000000-0000-4000-8000-000000000270'
      ),
    },
    {
      name: 'request-mismatch',
      turnId: expectedTaskModeTurnId(
        'conversation.submit.task',
        LOCAL_USER_ID,
        'ws_demo',
        'th_demo',
        '00000000-0000-4000-8000-000000000271'
      ),
    },
  ])('rejects null Knowledge for $name identity', ({ name, turnId }) => {
    expect(() => prepareNullKnowledgeTaskContext(`chat-identity-${name}`, turnId)).toThrow(
      'Worker Context Package Task Knowledge selection authority is contradictory.'
    );
  });

  it('permits null Knowledge only for the exact Chat-subordinate Task identity', () => {
    const prepared = prepareNullKnowledgeTaskContext(
      'chat-identity-exact',
      expectedTaskModeTurnId(
        'conversation.submit.task',
        LOCAL_USER_ID,
        'ws_demo',
        'th_demo',
        '00000000-0000-4000-8000-000000000270'
      )
    );
    expect(prepared.knowledgeSelectionInput).toBeNull();
    expect(prepared.packageFiles.knowledgeSelections).toEqual([]);
    expect(prepared.knowledgeExclusions).toEqual([]);
  });

  it('keeps recovery maintenance out of a live accepted-final-status closeout', async () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-live-closeout-race-')));
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const turn = createAssignedTurn(store, 'ws_demo', 'th_demo', 'Complete without takeover');
    const agentSessionId = 'as_live_closeout';
    const packageSnapshotId = `aepsnap_${turn.id}_${agentSessionId}`;
    const requestId = '00000000-0000-4000-8000-000000000254';
    const sandboxBindingRef = 'lease-binding:live-closeout';
    const leaseId = `lease_${turn.id}`;
    const lineage = {
      agentSessionId,
      packageSnapshotId,
      requestId,
      threadId: turn.threadId,
      turnId: turn.id,
      workspaceId: turn.workspaceId,
    };
    recordExecutorAttempt(coreDb, {
      ...lineage,
      sandboxBindingRef,
    });
    const backend = new FakeWorkerGovernanceBackend();
    const cleanupEntered = Promise.withResolvers<void>();
    const releaseCleanup = Promise.withResolvers<void>();
    const cleanup = vi.spyOn(backend, 'cleanupSession').mockImplementationOnce(async () => {
      cleanupEntered.resolve();
      await releaseCleanup.promise;
    });
    const executor = new WorkerGovernanceTurnExecutor({
      awaitWorkerCompletion: async () => {
        recordWorkerControlAcceptedRecord(coreDb, {
          acceptedAt: '2026-07-15T00:00:04.000Z',
          lineage,
          operation: 'final_status',
          record: { sequence: 1, status: 'completed', stopReason: 'completed' },
          recordKey: '1',
          sandboxBindingRef,
          sequence: 1,
        });
        beginOwnedAttemptCloseout(coreDb, {
          attemptId: leaseId,
          now: () => '2026-07-15T00:00:04.000Z',
          firstTerminalCause: 'worker-final-status',
        });
        return getWorkerControlAcceptedFinalStatus(coreDb, lineage)!;
      },
      backend,
      coreDb,
      now: () => '2026-07-15T00:00:05.000Z',
    });
    const execution = executor.startTurn(store, turn.id, 'Complete without takeover', {
      attemptId: `lease_${turn.id}`,
      agentSessionId,
      agentSetup: createTestAgentSetup(),
      requestId,
      sandboxBindingRef,
      triggerActor: turn.triggerActor,
      workspaceRoots: [],
    });
    const executionResult = execution.then(
      () => null,
      (error: unknown) => error
    );
    const projectRecoveredTurn = vi.fn(async () => {
      const result = terminalizeGovernedWorkerTurn({
        agentSessionId,
        completedAt: '2026-07-15T00:01:00.000Z',
        errorCode: 'worker_governance_restart_recovery',
        message: 'Worker execution was interrupted during scheduler recovery.',
        outcome: 'interrupted',
        requestId,
        store,
        turnId: turn.id,
      });
      return { status: result.status as 'interrupted' };
    });
    try {
      await Promise.race([cleanupEntered.promise, execution]);
      expect(getWorkerBackendSession(coreDb, leaseId)?.state).toBe('cleanup-pending');
      const nativeRecovery = {
        cleanupBackendSession: (
          identity: Parameters<WorkerGovernanceBackend['cleanupSession']>[0]
        ) => backend.cleanupSession(identity),
        isTurnExecutionActive: (turnId: string) => executor.isTurnExecutionActive(turnId),
        now: () => '2026-07-15T00:01:00.000Z',
        prepareBackendCleanup: () => {
          throw new Error('The live owner already holds cleanup.');
        },
        restoreBackendSession: async () => {
          throw new Error('Online closeout cannot be restored by maintenance.');
        },
        reconcileAcceptedFinalStatus: async () => {
          throw new Error('Online closeout owns accepted final status.');
        },
        projectRecoveredTurn,
      };
      await runSchedulerRecoveryMaintenance(coreDb, {
        executionBackend: backend,
        now: nativeRecovery.now,
        projectRecoveredTurn,
      });
      await runNanoHostAttemptRecoveryMaintenance(coreDb, nativeRecovery);
      // The live owner still has to prove cleanup and publish its canonical outcome.
      expect(store.getTurnById(turn.id).status).toBe('running');
      expect(projectRecoveredTurn).not.toHaveBeenCalled();
      expect(cleanup).toHaveBeenCalledTimes(1);
      expect(
        observeExecutionAttempts(coreDb).find((attempt) => attempt.attempt_id === leaseId)?.phase
      ).toBe('closing');
      expect(getWorkerBackendSession(coreDb, leaseId)?.physicalCleanedAt).toBeNull();
      releaseCleanup.resolve();
      expect(await executionResult).toBeNull();
      expect(executor.isTurnExecutionActive(turn.id)).toBe(false);
      expect(store.getTurnById(turn.id).status).toBe('completed');
      expect(getWorkerBackendSession(coreDb, leaseId)?.state).toBe('cleaned');
      completeOwnedTerminalAttempt(coreDb, store.getTurnById(turn.id));
      await runNanoHostAttemptRecoveryMaintenance(coreDb, nativeRecovery);
      await runSchedulerRecoveryMaintenance(coreDb, {
        executionBackend: backend,
        projectRecoveredTurn,
      });
      expect(projectRecoveredTurn).not.toHaveBeenCalled();
      expect(
        observeExecutionAttempts(coreDb).find((attempt) => attempt.attempt_id === leaseId)?.phase
      ).toBe('closed');
    } finally {
      releaseCleanup.resolve();
      await executionResult;
      cleanup.mockRestore();
      coreDb.sqlite.close();
    }
  });

  it('passes scheduler-owned lineage into backend materialization', async () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-governance-binding-')));

    applyMigrations(coreDb);

    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const turn = createAssignedTurn(store, 'ws_demo', 'th_demo', 'Run with scheduler binding');
    const agentSessionId = 'as_governance_binding_1';
    const sandboxBindingRef = 'lease-binding:executor_1';
    recordExecutorAttempt(coreDb, {
      agentSessionId,
      packageSnapshotId: `aepsnap_${turn.id}_${agentSessionId}`,
      sandboxBindingRef,
      threadId: turn.threadId,
      turnId: turn.id,
    });
    const backend = new FakeWorkerGovernanceBackend();
    const executor = new WorkerGovernanceTurnExecutor({
      backend,
      coreDb,
      createAgentSessionId: () => 'as_unexpected_random_1',
      environmentBackend: {
        kind: 'openshell',
      },
      now: () => '2026-07-15T00:00:03.000Z',
    });

    await executor.startTurn(store, turn.id, 'Run with scheduler binding', {
      attemptId: `lease_${turn.id}`,
      agentSessionId,
      agentSetup: createTestAgentSetup(),
      requestId: '00000000-0000-4000-8000-000000000214',
      sandboxBindingRef,
      triggerActor: turn.triggerActor,
      workspaceRoots: [],
    });

    expect(backend.lastContext?.sandboxBindingRef).toBe('lease-binding:executor_1');
    expect(backend.lastPackage?.scope.agentSessionId).toBe('as_governance_binding_1');
    expect(backend.lastPackage?.snapshotId).toBe(`aepsnap_${turn.id}_as_governance_binding_1`);
    expect(store.getAgentSession('as_governance_binding_1')).toMatchObject({
      id: 'as_governance_binding_1',
      status: 'idle',
    });

    coreDb.sqlite.close();
  });

  it.each([
    false,
    true,
  ])('uses exact server-admin admission for nonmember Worker effects (revoked: %s)', async (revoked) => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-governance-admin-lineage-')));
    applyMigrations(coreDb);
    const timestamp = '2026-07-15T00:00:03.000Z';
    coreDb.sqlite
      .prepare(`INSERT INTO users (id, display_name, email, email_verified, created_at, updated_at, kind, status)
      VALUES ('user_admin_worker', 'Admin Worker', 'admin-worker@example.test', false, ?, ?, 'human', 'active')`)
      .run(Date.parse(timestamp), Date.parse(timestamp));
    createOpenKitAccessTokenRecord(coreDb, {
      expiresAt: '2099-01-01T00:00:00.000Z',
      ownerUserId: 'user_admin_worker',
      scope: 'server-admin',
      tokenId: 'token_admin_worker_effect',
      workspaceIds: [],
    });
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const actor = { kind: 'user', id: 'user_admin_worker' } as const;
    const turn = store.createTurn('ws_demo', 'th_demo', 'Run as nonmember administrator', actor);
    store.updateTurn(turn.id, { agentId: 'agent_codex_host' });
    const agentSessionId = 'as_admin_worker_effect';
    const sandboxBindingRef = 'lease-binding:admin-worker-effect';
    recordExecutorAttempt(coreDb, {
      agentSessionId,
      packageSnapshotId: `aepsnap_${turn.id}_${agentSessionId}`,
      sandboxBindingRef,
      threadId: turn.threadId,
      turnId: turn.id,
      triggerActor: actor,
      serverAdminTokenId: 'token_admin_worker_effect',
    });
    if (revoked) {
      revokeOpenKitAccessTokenRecord(coreDb, 'token_admin_worker_effect', new Date(timestamp));
    }
    const backend = new FakeWorkerGovernanceBackend();
    const executor = new WorkerGovernanceTurnExecutor({
      backend,
      coreDb,
      now: () => timestamp,
    });
    try {
      const execution = executor.startTurn(store, turn.id, 'Run as nonmember administrator', {
        attemptId: `lease_${turn.id}`,
        agentSessionId,
        agentSetup: createTestAgentSetup(),
        requestId: '00000000-0000-4000-8000-000000000237',
        sandboxBindingRef,
        triggerActor: actor,
        workspaceRoots: [],
      });
      if (revoked) {
        await expect(execution).rejects.toMatchObject({
          code: 'workspace_access_denied',
          status: 403,
        });
        expect(backend.calls).toEqual([]);
      } else {
        await expect(execution).resolves.toBeUndefined();
        expect(backend.calls).toContain('submit');
        expect(store.getTurnById(turn.id)).toMatchObject({ status: 'completed' });
      }
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('rechecks runtime authority before backend materialization', async () => {
    const coreDb = openCoreDb(
      mkdtempSync(join(tmpdir(), 'openkit-governance-prematerialize-authority-'))
    );
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const turn = createAssignedTurn(store, 'ws_demo', 'th_demo', 'Do not materialize stale work');
    const agentSessionId = 'as_prematerialize_authority_1';
    const sandboxBindingRef = 'lease-binding:prematerialize-authority';
    recordExecutorAttempt(coreDb, {
      agentSessionId,
      packageSnapshotId: `aepsnap_${turn.id}_${agentSessionId}`,
      sandboxBindingRef,
      threadId: turn.threadId,
      turnId: turn.id,
    });
    coreDb.sqlite.transaction(() => {
      disableCanonicalUser(coreDb, LOCAL_USER_ID, new Date('2026-07-15T00:00:02.500Z'));
    })();
    const backend = new FakeWorkerGovernanceBackend();
    const executor = new WorkerGovernanceTurnExecutor({
      backend,
      coreDb,
      createAgentSessionId: () => agentSessionId,
      environmentBackend: {
        kind: 'openshell',
      },
      now: () => '2026-07-15T00:00:03.000Z',
    });

    try {
      await expect(
        executor.startTurn(store, turn.id, 'Do not materialize stale work', {
          attemptId: `lease_${turn.id}`,
          agentSessionId,
          agentSetup: createTestAgentSetup(),
          requestId: '00000000-0000-4000-8000-000000000249',
          sandboxBindingRef,
          triggerActor: turn.triggerActor,
          workspaceRoots: [],
        })
      ).rejects.toMatchObject({ code: 'workspace_access_denied', status: 403 });

      expect(backend.calls).toEqual([]);
      expect(getWorkerBackendSession(coreDb, `lease_${turn.id}`)).toBeNull();
      const workspaceDb = openTestWorkspaceDb(coreDb);
      expect(listWorkspaceInputSnapshots(workspaceDb, turn.workspaceId)).toEqual([]);
      expect(listWorkspaceMaterializationRecords(workspaceDb, turn.workspaceId)).toEqual([]);
      workspaceDb.sqlite.close();
      expect(store.getTurnById(turn.id)).toMatchObject({
        error: { code: 'workspace_access_denied' },
        status: 'interrupted',
      });
      expect(store.listThreadAgentSessions(turn.workspaceId, turn.threadId)).toEqual([]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('writes a package-scoped backend anchor before incoming materialization effects and cleans it for zero-input turns', async () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-governance-anchor-order-')));
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const turn = createAssignedTurn(store, 'ws_demo', 'th_demo', 'Anchor before effect');
    const agentSessionId = 'as_anchor_order_1';
    const packageSnapshotId = `aepsnap_${turn.id}_${agentSessionId}`;
    const sandboxBindingRef = 'lease-binding:anchor-order';
    recordExecutorAttempt(coreDb, {
      agentSessionId,
      packageSnapshotId,
      sandboxBindingRef,
      threadId: turn.threadId,
      turnId: turn.id,
    });
    const backend = new FakeWorkerGovernanceBackend();
    const materialize = backend.materialize.bind(backend);
    const materializeSpy = vi.spyOn(backend, 'materialize').mockImplementation(async (...args) => {
      args[1]?.beforeMaterialization?.();
      expect(getWorkerBackendSession(coreDb, `lease_${turn.id}`)).toMatchObject({
        backendSessionId: `openkit-${agentSessionId}`,
        packageSnapshotId,
        state: 'materializing',
      });
      return materialize(args[0], { ...args[1], beforeMaterialization: undefined });
    });
    const executor = new WorkerGovernanceTurnExecutor({
      backend,
      coreDb,
      createAgentSessionId: () => agentSessionId,
      environmentBackend: {
        kind: 'openshell',
      },
      now: () => '2026-07-15T00:00:03.000Z',
    });

    try {
      await executor.startTurn(store, turn.id, 'Anchor before effect', {
        attemptId: `lease_${turn.id}`,
        agentSessionId,
        agentSetup: createTestAgentSetup(),
        requestId: '00000000-0000-4000-8000-000000000250',
        sandboxBindingRef,
        triggerActor: turn.triggerActor,
        workspaceRoots: [],
      });

      expect(getWorkerBackendSession(coreDb, `lease_${turn.id}`)).toMatchObject({
        state: 'cleaned',
      });
    } finally {
      materializeSpy.mockRestore();
      coreDb.sqlite.close();
    }
  });

  it.each([
    ['cleanup succeeds', false, 'cleaned'],
    ['cleanup fails', true, 'cleanup-failed'],
  ] as const)('records materialize-after-effect failure when %s', async (_description, failTeardown, expectedState) => {
    const coreDb = openCoreDb(
      mkdtempSync(join(tmpdir(), 'openkit-governance-materialize-failure-'))
    );
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const turn = createAssignedTurn(store, 'ws_demo', 'th_demo', 'Fail after materialize effect');
    const agentSessionId = 'as_materialize_failure_1';
    const packageSnapshotId = `aepsnap_${turn.id}_${agentSessionId}`;
    const sandboxBindingRef = 'lease-binding:materialize-failure';
    recordExecutorAttempt(coreDb, {
      agentSessionId,
      packageSnapshotId,
      sandboxBindingRef,
      threadId: turn.threadId,
      turnId: turn.id,
    });
    const backend = new FakeWorkerGovernanceBackend();
    backend.failTeardown = failTeardown;
    const materialize = backend.materialize.bind(backend);
    const materializeSpy = vi.spyOn(backend, 'materialize').mockImplementation(async (...args) => {
      // This modeled Native producer records its actual operation before the controlled effect.
      // Without that fact, the generic no-effect closeout would truthfully release this fixture.
      attempts.recordSchedulerExecutionOperation(coreDb, {
        attemptId: `lease_${turn.id}`,
        operationId: `materialize:${turn.id}`,
      });
      await materialize(...args);
      throw new Error('materialize failed after external effect');
    });
    const executor = new WorkerGovernanceTurnExecutor({
      backend,
      coreDb,
      createAgentSessionId: () => agentSessionId,
      environmentBackend: {
        kind: 'openshell',
      },
      now: () => '2026-07-15T00:00:03.000Z',
    });

    try {
      await expect(
        executor.startTurn(store, turn.id, 'Fail after materialize effect', {
          attemptId: `lease_${turn.id}`,
          agentSessionId,
          agentSetup: createTestAgentSetup(),
          requestId: '00000000-0000-4000-8000-000000000251',
          sandboxBindingRef,
          triggerActor: turn.triggerActor,
          workspaceRoots: [],
        })
      ).rejects.toThrow('materialize failed after external effect');
      expect(getWorkerBackendSession(coreDb, `lease_${turn.id}`)).toMatchObject({
        state: expectedState,
      });
      expect(attempts.requireSchedulerExecutionAttempt(coreDb, `lease_${turn.id}`)).toMatchObject({
        phase: failTeardown ? 'closing' : 'closed',
        // Cleanup fences the possible effect; it never proves that the prior materialization was absent.
        disposition: 'unknown',
        fenceRef: failTeardown ? null : expect.any(String),
        ...(failTeardown ? {} : { outcomeRef: `turn:${turn.id}:failed` }),
      });
    } finally {
      materializeSpy.mockRestore();
      coreDb.sqlite.close();
    }
  });

  it('does not launch when the scheduler lease stops being live during materialization', async () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-governance-prelaunch-gate-')));
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const turn = createAssignedTurn(store, 'ws_demo', 'th_demo', 'Lose lease before launch');
    const agentSessionId = 'as_prelaunch_gate_1';
    const packageSnapshotId = `aepsnap_${turn.id}_${agentSessionId}`;
    const sandboxBindingRef = 'lease-binding:prelaunch-gate';
    recordExecutorAttempt(coreDb, {
      agentSessionId,
      packageSnapshotId,
      sandboxBindingRef,
      threadId: turn.threadId,
      turnId: turn.id,
    });
    const backend = new FakeWorkerGovernanceBackend();
    const materialize = backend.materialize.bind(backend);
    const materializeSpy = vi.spyOn(backend, 'materialize').mockImplementation(async (...args) => {
      const result = await materialize(...args);
      attempts.markSchedulerExecutionAttemptClosing(coreDb, {
        attemptId: `lease_${turn.id}`,
        cause: 'authority-revoked',
      });
      return result;
    });
    const launchSpy = vi.spyOn(backend, 'submit');
    const executor = new WorkerGovernanceTurnExecutor({
      backend,
      coreDb,
      createAgentSessionId: () => agentSessionId,
      environmentBackend: {
        kind: 'openshell',
      },
      now: () => '2026-07-15T00:00:03.000Z',
    });

    try {
      await expect(
        executor.startTurn(store, turn.id, 'Lose lease before launch', {
          attemptId: `lease_${turn.id}`,
          agentSessionId,
          agentSetup: createTestAgentSetup(),
          requestId: '00000000-0000-4000-8000-000000000252',
          sandboxBindingRef,
          triggerActor: turn.triggerActor,
          workspaceRoots: [],
        })
      ).rejects.toThrow('Execution authority was revoked before the operation.');
      expect(launchSpy).not.toHaveBeenCalled();
      expect(backend.calls.filter((call) => call === 'cleanupSession')).toHaveLength(1);
      expect(getWorkerBackendSession(coreDb, `lease_${turn.id}`)).toMatchObject({
        state: 'cleaned',
      });
    } finally {
      launchSpy.mockRestore();
      materializeSpy.mockRestore();
      coreDb.sqlite.close();
    }
  });

  it('does not launch when the startup deadline elapses during materialization', async () => {
    await assertNativePreSubmissionFault('startup-deadline');
  });

  it('records Vault injection receipts only when a Turn opens its binding', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-governance-vault-reuse-'));
    const coreDb = openCoreDb(dataRoot);
    const vaultUnlockState = createVaultUnlockState({
      backendKind: 'encrypted-file',
      storeDir: join(dataRoot, 'server', 'vault'),
    });
    const timestamp = '2026-07-05T00:00:00.000Z';
    const agentSessionId = 'as_governance_vault_reuse';

    applyMigrations(coreDb);
    vaultUnlockState.unlock({ masterKey: Buffer.alloc(32, 8) });
    vaultUnlockState.backend().store({
      material: 'ghp_governance_token',
      metadata: { ownerScope: 'server' },
      referenceId: 'vault_github_read',
    });
    createVaultReference(coreDb, {
      backendKind: 'encrypted-file',
      backendLocator: 'encrypted-file://server/vault/vault_github_read',
      displayName: 'GitHub read token',
      ownerScope: 'server',
      referenceId: 'vault_github_read',
      secretKind: 'github-token',
      now: () => timestamp,
    });
    createVaultGrant(coreDb, {
      allowedInjectionPaths: ['backend-provider'],
      expiresAt: '2099-07-05T01:00:00.000Z',
      grantId: 'grant_github_read',
      lifetime: 'turn',
      ownerScope: 'server',
      policyDecisionId: 'pd_repo_read_1',
      targetAgentSessionId: agentSessionId,
      vaultReferenceId: 'vault_github_read',
      now: () => timestamp,
    });
    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const backend = new FakeWorkerGovernanceBackend();
    // Each Turn has its own backend session record even when it reuses the AgentSession binding.
    const planSession = backend.planSession.bind(backend);
    backend.planSession = (environmentPackage) => ({
      ...planSession(environmentPackage),
      backendSessionId: `openkit-${environmentPackage.snapshotId}`,
    });
    const executor = new WorkerGovernanceTurnExecutor({
      backend,
      coreDb,
      createAgentSessionId: () => agentSessionId,
      now: () => timestamp,
      vaultBackend: () => vaultUnlockState.backend(),
    });
    const agentSetup = createTestAgentSetup({
      credentialDeclarations: [
        {
          id: 'github_mcp_read',
          provider: {
            credentialKey: 'GITHUB_TOKEN',
            instanceId: 'provider_github_read',
            profileId: 'github_mcp',
            type: 'github_mcp',
          },
          vaultGrantId: 'grant_github_read',
          visibility: 'sandbox-provider',
        },
      ],
    });
    const run = async (index: number) => {
      const turn = createAssignedTurn(store, 'ws_demo', 'th_demo', `Vault reuse ${index}`);
      await startWithExecutorAttempt(
        coreDb,
        executor,
        store,
        turn,
        agentSessionId,
        timestamp,
        `Vault reuse ${index}`,
        {
          agentSessionId,
          agentSetup,
          requestId: `00000000-0000-4000-8000-00000000027${index}`,
          triggerActor: turn.triggerActor,
          workspaceRoots: [],
        }
      );
    };

    try {
      await run(1);
      expect(listVaultInjectionReceipts(coreDb)).toHaveLength(1);
      coreDb.sqlite
        .prepare(
          "UPDATE scheduler_execution_attempts SET phase = 'closed' WHERE agent_session_id = ?"
        )
        .run(agentSessionId);

      // The idle AgentSession's binding is reused: credential material was delivered at open.
      await run(2);
      expect(store.getAgentSession(agentSessionId).status).toBe('idle');
      expect(listVaultInjectionReceipts(coreDb)).toHaveLength(1);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('passes vault backend dependencies into worker package resolution', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-governance-vault-grants-'));
    const coreDb = openCoreDb(dataRoot);
    const vaultUnlockState = createVaultUnlockState({
      backendKind: 'encrypted-file',
      storeDir: join(dataRoot, 'server', 'vault'),
    });
    const timestamp = '2026-07-05T00:00:00.000Z';

    applyMigrations(coreDb);
    vaultUnlockState.unlock({ masterKey: Buffer.alloc(32, 8) });
    vaultUnlockState.backend().store({
      material: 'ghp_governance_token',
      metadata: { ownerScope: 'server' },
      referenceId: 'vault_github_read',
    });
    createVaultReference(coreDb, {
      backendKind: 'encrypted-file',
      backendLocator: 'encrypted-file://server/vault/vault_github_read',
      displayName: 'GitHub read token',
      ownerScope: 'server',
      referenceId: 'vault_github_read',
      secretKind: 'github-token',
      now: () => timestamp,
    });
    createVaultGrant(coreDb, {
      allowedInjectionPaths: ['backend-provider'],
      expiresAt: '2099-07-05T01:00:00.000Z',
      grantId: 'grant_github_read',
      lifetime: 'turn',
      ownerScope: 'server',
      policyDecisionId: 'pd_repo_read_1',
      targetAgentSessionId: 'as_governance_vault_1',
      vaultReferenceId: 'vault_github_read',
      now: () => timestamp,
    });

    const store = createDemoStore({ dataRoot: coreDb.dataRoot });
    const turn = createAssignedTurn(store, 'ws_demo', 'th_demo', 'Run GitHub MCP in OpenShell');
    const backend = new FakeWorkerGovernanceBackend();
    const executor = new WorkerGovernanceTurnExecutor({
      backend,
      coreDb,
      createAgentSessionId: () => 'as_governance_vault_1',
      environmentBackend: {
        kind: 'openshell',
      },
      now: () => timestamp,
      vaultBackend: () => vaultUnlockState.backend(),
    });

    try {
      await startWithExecutorAttempt(
        coreDb,
        executor,
        store,
        turn,
        'as_governance_vault_1',
        timestamp,
        'Run GitHub MCP in OpenShell',
        {
          agentSetup: createTestAgentSetup({
            credentialDeclarations: [
              {
                id: 'github_mcp_read',
                provider: {
                  credentialKey: 'GITHUB_TOKEN',
                  instanceId: 'provider_github_read',
                  profileId: 'github_mcp',
                  type: 'github_mcp',
                },
                vaultGrantId: 'grant_github_read',
                visibility: 'sandbox-provider',
              },
            ],
            mcpIds: ['github'],
          }),
          requestId: '00000000-0000-4000-8000-000000000215',
          triggerActor: turn.triggerActor,
          workspaceMcpServerCatalog: {
            schemaVersion: 1,
            servers: [
              {
                allowedTools: ['*'],
                approvalRequiredTools: [],
                credentialBindings: [],
                deniedTools: [],
                enabled: true,
                id: 'github',
                pinnedSchemaSnapshotId: null,
                schemaPolicy: 'tracking',
                timeoutMs: 60_000,
                transport: {
                  args: ['fixtures/github.mjs'],
                  command: 'node',
                  environment: {},
                  kind: 'stdio',
                },
              },
            ],
          },
          workspaceRoots: [],
        }
      );

      expect(backend.lastPackage?.vault.grants).toEqual([
        expect.objectContaining({
          expiresAt: '2099-07-05T01:00:00.000Z',
          id: 'grant_github_read',
        }),
      ]);
      expect(listVaultInjectionPlans(coreDb)).toEqual([
        expect.objectContaining({
          grantId: 'grant_github_read',
          packageSnapshotId: backend.lastPackage?.snapshotId,
        }),
      ]);
      expect(listVaultInjectionReceipts(coreDb)).toEqual([
        expect.objectContaining({
          agentSessionId: 'as_governance_vault_1',
          grantId: 'grant_github_read',
        }),
      ]);
      expect(listVaultUseRecords(coreDb)).toEqual([
        expect.objectContaining({
          grantId: 'grant_github_read',
          outcome: 'succeeded',
          resolvingPath: 'grant',
        }),
      ]);
      expect(JSON.stringify(backend.lastPackage)).not.toContain('ghp_governance_token');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('passes vault-backed runtime files into backend-private materialization context', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-governance-runtime-file-'));
    const coreDb = openCoreDb(dataRoot);
    const vaultUnlockState = createVaultUnlockState({
      backendKind: 'encrypted-file',
      storeDir: join(dataRoot, 'server', 'vault'),
    });
    const timestamp = '2026-07-05T00:00:00.000Z';

    applyMigrations(coreDb);
    vaultUnlockState.unlock({ masterKey: Buffer.alloc(32, 10) });
    vaultUnlockState.backend().store({
      material: '{"tokens":{"openai":"codex_executor_secret"}}',
      metadata: { ownerScope: 'server' },
      referenceId: 'vault_codex_auth_json',
    });
    createVaultReference(coreDb, {
      backendKind: 'encrypted-file',
      backendLocator: 'encrypted-file://server/vault/vault_codex_auth_json',
      displayName: 'Codex auth JSON',
      ownerScope: 'server',
      referenceId: 'vault_codex_auth_json',
      secretKind: 'codex-auth-json',
      now: () => timestamp,
    });
    createVaultGrant(coreDb, {
      allowedInjectionPaths: ['runtime-file'],
      grantId: 'grant_codex_auth_json',
      lifetime: 'agent-session',
      ownerScope: 'server',
      targetAgentSessionId: 'as_governance_runtime_file_1',
      vaultReferenceId: 'vault_codex_auth_json',
      now: () => timestamp,
    });

    const store = createDemoStore({ dataRoot });
    const turn = createAssignedTurn(store, 'ws_demo', 'th_demo', 'Run Codex auth runtime file');
    const backend = new FakeWorkerGovernanceBackend();
    const executor = new WorkerGovernanceTurnExecutor({
      backend,
      coreDb,
      createAgentSessionId: () => 'as_governance_runtime_file_1',
      environmentBackend: {
        kind: 'openshell',
      },
      now: () => timestamp,
      vaultBackend: () => vaultUnlockState.backend(),
    });

    try {
      await startWithExecutorAttempt(
        coreDb,
        executor,
        store,
        turn,
        'as_governance_runtime_file_1',
        timestamp,
        'Run Codex auth runtime file',
        {
          agentSetup: createTestAgentSetup({
            credentialDeclarations: [
              {
                id: 'codex_auth_json',
                targetPath: '/sandbox/.codex/auth.json',
                vaultGrantId: 'grant_codex_auth_json',
                visibility: 'runtime-file',
              },
            ],
          }),
          requestId: '00000000-0000-4000-8000-000000000216',
          triggerActor: turn.triggerActor,
          workspaceRoots: [],
        }
      );

      expect(backend.lastContext?.runtimeFileCredentials).toEqual([
        {
          credentialValue: '{"tokens":{"openai":"codex_executor_secret"}}',
          targetPath: '/sandbox/.codex/auth.json',
        },
      ]);
      expect(listVaultUseRecords(coreDb)).toEqual([
        expect.objectContaining({
          grantId: 'grant_codex_auth_json',
          outcome: 'succeeded',
          resolvingPath: 'grant',
        }),
      ]);
      expect(listVaultInjectionReceipts(coreDb)).toEqual([
        expect.objectContaining({
          agentSessionId: 'as_governance_runtime_file_1',
          grantId: 'grant_codex_auth_json',
        }),
      ]);
      expect(JSON.stringify(backend.lastPackage)).not.toContain('codex_executor_secret');
    } finally {
      coreDb.sqlite.close();
    }
  });
  it.each([
    false,
    true,
  ])('records runtime-env receipts only after native startup (launch failure: %s)', async (launchFails) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-governance-runtime-env-'));
    const coreDb = openCoreDb(dataRoot);
    const vaultUnlockState = createVaultUnlockState({
      backendKind: 'encrypted-file',
      storeDir: join(dataRoot, 'server', 'vault'),
    });
    let timestamp = '2026-07-05T00:00:00.000Z';

    applyMigrations(coreDb);
    vaultUnlockState.unlock({ masterKey: Buffer.alloc(32, 10) });
    vaultUnlockState.backend().store({
      material: 'runtime-env-receipt-canary',
      metadata: { ownerScope: 'server' },
      referenceId: 'vault_runtime_env',
    });
    createVaultReference(coreDb, {
      backendKind: 'encrypted-file',
      backendLocator: 'encrypted-file://server/vault/vault_runtime_env',
      displayName: 'Codex auth JSON',
      ownerScope: 'server',
      referenceId: 'vault_runtime_env',
      secretKind: 'codex-auth-json',
      now: () => timestamp,
    });
    createVaultGrant(coreDb, {
      allowedInjectionPaths: ['runtime-env'],
      grantId: 'grant_runtime_env',
      lifetime: 'agent-session',
      ownerScope: 'server',
      targetAgentSessionId: 'as_governance_runtime_env_1',
      vaultReferenceId: 'vault_runtime_env',
      now: () => timestamp,
    });

    const store = createDemoStore({ dataRoot });
    const turn = createAssignedTurn(store, 'ws_demo', 'th_demo', 'Run Codex auth runtime file');
    const backend = new FakeWorkerGovernanceBackend();
    const nativeLaunch = backend.submit.bind(backend);
    vi.spyOn(backend, 'submit').mockImplementation(async (...args) => {
      expect(listVaultInjectionReceipts(coreDb)).toEqual([]);
      if (launchFails) throw new Error('credential_materialization_failed');
      const credentials = backend.lastContext?.runtimeEnvCredentials ?? [];
      const environment = Object.fromEntries(
        credentials.map((entry) => [entry.targetEnvVarName, entry.credentialValue])
      );
      const observed = execFileSync(
        process.execPath,
        [
          '-e',
          "process.stdout.write(String(process.env.GITHUB_TOKEN === 'runtime-env-receipt-canary'))",
        ],
        { env: environment, encoding: 'utf8' }
      );
      expect(observed).toBe('true');
      timestamp = '2026-07-05T00:00:10.000Z';
      return nativeLaunch(...args);
    });
    const executor = new WorkerGovernanceTurnExecutor({
      backend,
      coreDb,
      createAgentSessionId: () => 'as_governance_runtime_env_1',
      environmentBackend: {
        kind: 'openshell',
      },
      now: () => timestamp,
      vaultBackend: () => vaultUnlockState.backend(),
    });

    try {
      const run = startWithExecutorAttempt(
        coreDb,
        executor,
        store,
        turn,
        'as_governance_runtime_env_1',
        timestamp,
        'Run Codex auth runtime file',
        {
          agentSetup: createTestAgentSetup({
            credentialDeclarations: [
              {
                id: 'codex_auth_json',
                targetEnvVarName: 'GITHUB_TOKEN',
                vaultGrantId: 'grant_runtime_env',
                visibility: 'runtime-env',
              },
            ],
          }),
          requestId: '00000000-0000-4000-8000-000000000216',
          triggerActor: turn.triggerActor,
          workspaceRoots: [],
        }
      );

      if (launchFails) {
        await expect(run).rejects.toThrow('credential_materialization_failed');
        expect(listVaultInjectionReceipts(coreDb)).toEqual([]);
        return;
      }
      await run;

      expect(backend.lastContext?.runtimeEnvCredentials).toEqual([
        {
          credentialValue: 'runtime-env-receipt-canary',
          materialVersion: 1,
          vaultReferenceId: 'vault_runtime_env',
          targetEnvVarName: 'GITHUB_TOKEN',
        },
      ]);
      expect(listVaultUseRecords(coreDb)).toEqual([
        expect.objectContaining({
          grantId: 'grant_runtime_env',
          outcome: 'succeeded',
          resolvingPath: 'grant',
        }),
      ]);
      expect(listVaultInjectionReceipts(coreDb)).toEqual([
        expect.objectContaining({
          agentSessionId: 'as_governance_runtime_env_1',
          grantId: 'grant_runtime_env',
          injectedAt: '2026-07-05T00:00:10.000Z',
        }),
      ]);
      expect(JSON.stringify(backend.lastPackage)).not.toContain('runtime-env-receipt-canary');
    } finally {
      coreDb.sqlite.close();
    }
  });
});

/** One native JSON frame and its restricted origin claims. */
interface TurnRuntimeNativeFrame {
  /** Exact native JSON object retained in the raw stream. */
  record: Record<string, unknown>;
  /** Restricted native-origin fields for this frame. */
  origin: Partial<
    Pick<
      WorkerRuntimeNativeOriginIndexEntry,
      | 'nativeSessionId'
      | 'nativeThreadId'
      | 'parentNativeThreadId'
      | 'nativeTurnId'
      | 'runtimeRole'
      | 'runtimeNickname'
      | 'runtimeDepth'
    >
  >;
}

/** One synthetic raw stream plus its manifest and native-index rows. */
interface TurnRuntimeStream {
  /** Exact raw JSONL bytes. */
  bytes: Buffer;
  /** Native index rows covering every physical frame. */
  entries: WorkerRuntimeNativeOriginIndexEntry[];
  /** Restricted stream manifest row. */
  manifest: WorkerRuntimeRawStreamManifest['streams'][number];
}

/** Backend-local provenance capture returned by the fake transcript collector. */
interface TurnRuntimeProvenanceCapture {
  /** Worker transcript collection projection. */
  collection: NonNullable<WorkerTranscriptPayload['runtimeProvenance']>;
  /** Backend-local native-origin index path. */
  nativeOriginIndexPath: string;
  /** Backend-local synthetic raw stream directory. */
  rawStreamsRoot: string;
  /** Exact backend-local path for every synthetic stream. */
  rawStreamPaths: Record<string, string>;
  /** Backend-local raw stream manifest path. */
  streamManifestPath: string;
}

/**
 * Creates a small complete, missing, digest-tampered, or incompletely mapped runtime forest.
 *
 * @param root Isolated backend-local collection root.
 * @param environmentPackage Provenance-required outer AEP.
 * @param failure Optional collection failure mode.
 * @param streamLayout Whether streams share one directory or use independent staging directories.
 * @returns Backend transcript projection and canonical importer paths.
 */
function createTurnRuntimeProvenanceCapture(
  root: string,
  environmentPackage: AgentEnvironmentPackage,
  failure: 'missing' | 'tampered' | 'unmapped' | null = null,
  streamLayout: 'per-stream' | 'shared-root' = 'shared-root'
): TurnRuntimeProvenanceCapture {
  const lineage = turnRuntimeLineage(environmentPackage);
  const rawStreamsRoot = join(root, 'runtime', 'raw');
  const streamManifestPath = join(root, 'runtime', 'raw-streams.json');
  const nativeOriginIndexPath = join(root, 'runtime', 'native-origin-index.jsonl');
  const streams = [
    createTurnRuntimeStream(lineage, 'stream-0000.jsonl', 'primary', [
      {
        record: { thread_id: TURN_ROOT_NATIVE_ID, type: 'thread.started' },
        origin: { nativeThreadId: TURN_ROOT_NATIVE_ID },
      },
      {
        record: {
          item: {
            receiver_thread_ids: [TURN_CHILD_NATIVE_ID, TURN_CHILD_B_NATIVE_ID],
            sender_thread_id: TURN_ROOT_NATIVE_ID,
            status: 'completed',
            tool: 'spawn_agent',
            type: 'collab_tool_call',
          },
          type: 'item.completed',
        },
        origin: { nativeThreadId: TURN_ROOT_NATIVE_ID },
      },
    ]),
    createTurnRuntimeStream(lineage, 'stream-0001.jsonl', 'runtime-thread', [
      {
        record: turnRuntimeSessionMeta(TURN_ROOT_NATIVE_ID),
        origin: {
          nativeSessionId: TURN_NATIVE_SESSION_ID,
          nativeThreadId: TURN_ROOT_NATIVE_ID,
        },
      },
    ]),
    createTurnRuntimeStream(lineage, 'stream-0002.jsonl', 'runtime-thread', [
      {
        record: turnRuntimeSessionMeta(TURN_CHILD_NATIVE_ID, TURN_ROOT_NATIVE_ID),
        origin: {
          nativeSessionId: TURN_NATIVE_SESSION_ID,
          nativeThreadId: TURN_CHILD_NATIVE_ID,
          parentNativeThreadId: TURN_ROOT_NATIVE_ID,
          runtimeDepth: 1,
          runtimeNickname: 'Curie',
          runtimeRole: 'researcher',
        },
      },
      {
        record: {
          payload: {
            content: [{ text: TURN_CHILD_RAW_MESSAGE, type: 'output_text' }],
            role: 'assistant',
            type: 'message',
          },
          timestamp: '2026-07-13T00:00:01.000Z',
          type: 'response_item',
        },
        origin: {
          nativeSessionId: TURN_NATIVE_SESSION_ID,
          nativeThreadId: TURN_CHILD_NATIVE_ID,
          parentNativeThreadId: TURN_ROOT_NATIVE_ID,
          runtimeDepth: 1,
          runtimeNickname: 'Curie',
          runtimeRole: 'researcher',
        },
      },
    ]),
    createTurnRuntimeStream(lineage, 'stream-0003.jsonl', 'runtime-thread', [
      {
        record: turnRuntimeSessionMeta(TURN_CHILD_B_NATIVE_ID, TURN_ROOT_NATIVE_ID),
        origin: {
          nativeSessionId: TURN_NATIVE_SESSION_ID,
          nativeThreadId: TURN_CHILD_B_NATIVE_ID,
          parentNativeThreadId: TURN_ROOT_NATIVE_ID,
          runtimeDepth: 1,
          runtimeNickname: 'Curie',
          runtimeRole: 'researcher',
        },
      },
    ]),
  ];
  const manifest = WorkerRuntimeRawStreamManifestSchema.parse({
    adapterVersion: '0.153.4',
    captureStatus: 'complete',
    lineage,
    primaryStreamRef: 'stream-0000.jsonl',
    runtimeFamily: 'codex',
    schemaVersion: 1,
    streams: streams.map((stream, index) =>
      failure === 'tampered' && index === 2
        ? { ...stream.manifest, sha256: `sha256:${'f'.repeat(64)}` }
        : stream.manifest
    ),
  });
  const rawStreamPaths = Object.fromEntries(
    streams.map((stream, index) => [
      stream.manifest.streamRef,
      streamLayout === 'per-stream'
        ? join(
            root,
            'runtime',
            `staged-${String(index).padStart(4, '0')}`,
            stream.manifest.streamRef
          )
        : join(rawStreamsRoot, stream.manifest.streamRef),
    ])
  );
  for (const stream of streams) {
    const streamPath = rawStreamPaths[stream.manifest.streamRef];
    if (!streamPath) {
      throw new Error(`Missing runtime provenance fixture path for ${stream.manifest.streamRef}.`);
    }
    mkdirSync(dirname(streamPath), { recursive: true });
    writeFileSync(streamPath, stream.bytes);
  }
  writeFileSync(
    nativeOriginIndexPath,
    `${streams
      .flatMap((stream) => stream.entries)
      .map((entry) => JSON.stringify(entry))
      .join('\n')}\n`
  );

  if (failure !== 'missing') {
    writeFileSync(streamManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  return {
    collection: {
      diagnostics:
        failure && failure !== 'unmapped'
          ? [
              {
                code: `worker_runtime_provenance_${failure}`,
                message: `Runtime provenance collection is ${failure}.`,
                path: '/openkit/session/runtime/raw-streams.json',
              },
            ]
          : [],
      manifestPath: streamManifestPath,
      missingPaths: failure === 'missing' ? ['/openkit/session/runtime/raw-streams.json'] : [],
      nativeOriginIndexPath,
      rawStreamPaths:
        failure === 'unmapped'
          ? Object.fromEntries(
              Object.entries(rawStreamPaths).filter(
                ([streamRef]) => streamRef !== 'stream-0002.jsonl'
              )
            )
          : rawStreamPaths,
    },
    nativeOriginIndexPath,
    rawStreamsRoot,
    rawStreamPaths,
    streamManifestPath,
  };
}

/**
 * Builds one exact LF-framed runtime stream and matching index rows.
 *
 * @param lineage Authoritative outer worker lineage.
 * @param streamRef Synthetic stream reference.
 * @param sourceKind Primary or runtime-thread stream class.
 * @param frames Native frames and adapter origin claims.
 * @returns Exact raw bytes, manifest row, and index rows.
 */
function createTurnRuntimeStream(
  lineage: WorkerLineage,
  streamRef: string,
  sourceKind: 'primary' | 'runtime-thread',
  frames: TurnRuntimeNativeFrame[]
): TurnRuntimeStream {
  const chunks: Buffer[] = [];
  const entries: WorkerRuntimeNativeOriginIndexEntry[] = [];
  let byteOffset = 0;
  for (const [frameSequence, frame] of frames.entries()) {
    const bytes = Buffer.from(`${JSON.stringify(frame.record)}\n`);
    chunks.push(bytes);
    entries.push(
      WorkerRuntimeNativeOriginIndexEntrySchema.parse({
        adapterVersion: '0.153.4',
        byteLength: bytes.byteLength,
        byteOffset,
        eventKind: frame.record.type,
        frameSequence,
        frameSha256: turnRuntimeSha256(bytes),
        lineage,
        ...frame.origin,
        parseStatus: 'parsed',
        runtimeFamily: 'codex',
        schemaVersion: 1,
        streamRef,
      })
    );
    byteOffset += bytes.byteLength;
  }
  const bytes = Buffer.concat(chunks);
  return {
    bytes,
    entries,
    manifest: {
      bytes: bytes.byteLength,
      captureStatus: 'complete',
      frameCount: frames.length,
      sha256: turnRuntimeSha256(bytes),
      sourceKind,
      stableTerminal: true,
      streamRef,
    },
  };
}

/**
 * Builds pinned Codex session metadata for a root or child runtime thread.
 *
 * @param threadId Native thread id.
 * @param parentThreadId Native parent id for a child thread.
 * @returns One Codex rollout session metadata record.
 */
function turnRuntimeSessionMeta(
  threadId: string,
  parentThreadId?: string
): Record<string, unknown> {
  return {
    payload: {
      cwd: '/private/runtime-provenance',
      id: threadId,
      originator: 'codex_exec',
      ...(parentThreadId ? { parent_thread_id: parentThreadId } : {}),
      session_id: TURN_NATIVE_SESSION_ID,
      source: parentThreadId
        ? {
            subagent: {
              thread_spawn: {
                agent_nickname: 'Curie',
                agent_role: 'researcher',
                depth: 1,
                parent_thread_id: parentThreadId,
              },
            },
          }
        : 'exec',
      timestamp: '2026-07-13T00:00:00.000Z',
    },
    timestamp: '2026-07-13T00:00:00.000Z',
    type: 'session_meta',
  };
}

/** Builds authoritative runtime provenance lineage from a materialized AEP. */
function turnRuntimeLineage(environmentPackage: AgentEnvironmentPackage): WorkerLineage {
  return {
    agentSessionId: environmentPackage.scope.agentSessionId,
    packageSnapshotId: environmentPackage.snapshotId,
    requestId: environmentPackage.scope.requestId ?? null,
    threadId: environmentPackage.scope.threadId,
    turnId: environmentPackage.scope.turnId,
    workspaceId: environmentPackage.scope.workspaceId,
  };
}

/** Returns a fake backend that also owns a private Harness interrupt channel. */
function interruptibleBackend() {
  return Object.assign(new FakeWorkerGovernanceBackend(), {
    interruptTurn: vi.fn(async (_packageSnapshotId: string) => undefined),
  });
}

/** Computes one canonical prefixed SHA-256 digest. */
function turnRuntimeSha256(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

class FakeWorkerGovernanceBackend implements WorkerGovernanceBackend {
  public readonly id = 'nanohost';
  /** The external double prepares without importing or launching a native process. */
  public async prepareLaunch(): Promise<void> {}
  /** Inspection reports only this double's exact accepted operation. */
  public async inspect(input: import('./execution-backend.js').ExecutionBackendCorrelation) {
    return {
      ...input,
      disposition: 'accepted' as const,
      execution: 'terminal' as const,
      fenceRef: null,
      outcomeRef: null,
    };
  }
  /** Cancellation acknowledges the same identity without proving a physical fence. */
  public async cancel(input: import('./execution-backend.js').ExecutionBackendCorrelation) {
    return {
      ...input,
      disposition: 'accepted' as const,
      execution: 'unknown' as const,
      fenceRef: null,
      outcomeRef: null,
    };
  }
  /** Releases only after all real Core closeout barriers reached this external double. */
  public async release(input: Parameters<WorkerGovernanceBackend['release']>[0]) {
    expect(Object.values(input.proof)).toEqual([true, true, true, true, true, true]);
    const { proof: _proof, ...correlation } = input;
    return {
      ...correlation,
      state: 'released' as const,
      fenceRef: `fixture-fence:${input.attemptId}`,
    };
  }
  public readonly calls: string[] = [];
  /** Candidate reply; private comparison evidence never includes echoed route plaintext. */
  public assistantText = 'Governed worker completed the task.';
  public artifactCollectionInvalid = false;
  public artifactRecoveryRequired = false;
  public failTeardown = false;
  public teardownFailuresRemaining = 0;
  public lastContext: Parameters<WorkerGovernanceBackend['materialize']>[1] | null = null;
  public lastPackage: AgentEnvironmentPackage | null = null;
  /** Optional canonical event transcript factory used by reconciliation tests. */
  public eventsJsonlFactory: ((environmentPackage: AgentEnvironmentPackage) => string) | null =
    null;
  public runtimeProvenanceFactory:
    | ((
        environmentPackage: AgentEnvironmentPackage
      ) => NonNullable<WorkerTranscriptPayload['runtimeProvenance']>)
    | null = null;
  private readonly capabilities: string[];
  private readonly materializationStatus:
    | WorkerGovernanceMaterializationRecord['backendStatus']
    | undefined;
  /** Optional sandbox id distinct from package lineage. */
  private readonly sandboxName: string | undefined;

  public constructor(
    options: {
      capabilities?: string[];
      materializationStatus?: WorkerGovernanceMaterializationRecord['backendStatus'];
      /** Product-safe sandbox name returned by materialization. */
      sandboxName?: string;
    } = {}
  ) {
    this.capabilities = options.capabilities ?? ['container', 'transcript-sink', 'worker-control'];
    this.materializationStatus = options.materializationStatus ?? {
      gatewayEndpoint: null,
      gatewayName: 'openshell',
      health: 'ready',
      version: '0.0.63',
    };
    this.sandboxName = options.sandboxName;
  }

  public async describeCapabilities(): Promise<WorkerGovernanceBackendCapabilities> {
    return {
      capabilities: this.capabilities,
      dynamicCapabilities: [],
      kind: 'openshell',
      version: '0.0.63',
    };
  }

  public async validatePackage(): Promise<AgentEnvironmentValidationDiagnostic[]> {
    return [];
  }

  public planSession(environmentPackage: AgentEnvironmentPackage) {
    return {
      agentSessionId: environmentPackage.scope.agentSessionId,
      backendKind: 'openshell' as const,
      backendSessionId: this.sandboxName ?? `openkit-${environmentPackage.scope.agentSessionId}`,
      deploymentId: 'deployment_fake_executor',
      packageSnapshotId: environmentPackage.snapshotId,
      runtimeTargetId: 'runtime-target-test',
      stagingDirectoryRef: `server/runtime/worker-backend-sessions/${environmentPackage.snapshotId}`,
      transientProviderInstanceId: null,
    };
  }

  /** Cleans one exact fake physical session. */
  public async cleanupSession(): Promise<void> {
    this.calls.push('cleanupSession');

    if (this.teardownFailuresRemaining > 0) {
      this.teardownFailuresRemaining -= 1;
      throw new Error('teardown failed');
    }

    if (this.failTeardown) {
      throw new Error('teardown failed');
    }
  }

  public async materialize(
    environmentPackage: AgentEnvironmentPackage,
    context?: Parameters<WorkerGovernanceBackend['materialize']>[1]
  ): Promise<WorkerGovernanceMaterializationRecord> {
    context?.beforeMaterialization?.();
    this.calls.push('materialize');
    this.lastContext = context ?? null;
    this.lastPackage = environmentPackage;

    return {
      retainedStorage: {
        storageRef: `wst_${'1'.repeat(32)}`,
        workSlotRef: workerStorageDefaultWorkSlotRef(
          environmentPackage.scope.workspaceId,
          environmentPackage.scope.threadId
        ),
      },
      backendKind: 'openshell',
      command: {
        argv: environmentPackage.runtime.command.argv,
        workingDirectory: environmentPackage.runtime.command.workingDirectory,
      },
      controlMode: environmentPackage.control.mode,
      packageId: environmentPackage.packageId,
      packageSnapshotId: environmentPackage.snapshotId,
      requiredCapabilities: environmentPackage.backend.requiredCapabilities,
      ...(this.materializationStatus ? { backendStatus: this.materializationStatus } : {}),
      sandbox: {
        name: this.sandboxName ?? `openkit-${environmentPackage.scope.agentSessionId}`,
        source: 'openkit/worker-codex:dev',
        state: 'created' as const,
      },
      workspaceInputs: environmentPackage.workspace.inputs.map((input) => ({
        access: input.access,
        id: input.id,
        kind: input.kind,
        target: sessionWorkspaceInputTarget(environmentPackage, input.id),
      })),
    };
  }

  public async submit(input: Parameters<WorkerGovernanceBackend['submit']>[0]) {
    this.calls.push('submit');
    return {
      ...input,
      disposition: 'accepted' as const,
      execution: 'pending' as const,
      fenceRef: null,
      outcomeRef: null,
    };
  }

  public async update(): Promise<AgentEnvironmentValidationDiagnostic[]> {
    return [];
  }

  public async collectEvidence(): Promise<WorkerGovernanceEvidenceRecord[]> {
    this.calls.push('collectEvidence');

    return [];
  }

  public async collectProviderRefreshStatuses(): Promise<WorkerGovernanceEvidenceRecord[]> {
    this.calls.push('collectProviderRefreshStatuses');

    return [];
  }

  public async collectTranscript(): Promise<WorkerTranscriptPayload> {
    this.calls.push('collectTranscript');

    if (this.artifactCollectionInvalid) {
      throw Object.assign(new Error('Invalid Worker Artifact collection.'), {
        code: WORKER_ARTIFACT_COLLECTION_INVALID,
      });
    }
    if (this.artifactRecoveryRequired) {
      throw Object.assign(new Error('Restored Worker Artifact collection requires recovery.'), {
        code: WORKER_ARTIFACT_RECOVERY_REQUIRED,
      });
    }

    if (!this.lastPackage) {
      throw new Error('Package was not materialized.');
    }

    return {
      credentialCheckValues: {
        sensitiveValues: [
          ...(this.lastContext?.providerCredentials ?? []).map((item) => item.credentialValue),
          ...(this.lastContext?.runtimeEnvCredentials ?? []).map((item) => item.credentialValue),
          ...(this.lastContext?.runtimeFileCredentials ?? []).map((item) => item.credentialValue),
          ...(this.lastContext?.sandboxBindingRef ? [this.lastContext.sandboxBindingRef] : []),
        ],
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
      ...(this.eventsJsonlFactory
        ? { eventsJsonl: this.eventsJsonlFactory(this.lastPackage) }
        : {}),
      itemsJsonl: `${JSON.stringify({
        schemaVersion: 1,
        kind: 'item',
        lineage: {
          workspaceId: this.lastPackage.scope.workspaceId,
          threadId: this.lastPackage.scope.threadId,
          turnId: this.lastPackage.scope.turnId,
          agentSessionId: this.lastPackage.scope.agentSessionId,
          packageSnapshotId: this.lastPackage.snapshotId,
          requestId: this.lastPackage.scope.requestId,
        },
        sequence: 1,
        item: {
          type: 'assistant-message',
          status: 'completed',
          text: this.assistantText,
        },
      })}\n`,
      ...(this.runtimeProvenanceFactory
        ? { runtimeProvenance: this.runtimeProvenanceFactory(this.lastPackage) }
        : {}),
    };
  }

  public async collectWorkspaceChanges(): Promise<WorkerGovernanceWorkspaceChangeRecord[]> {
    this.calls.push('collectWorkspaceChanges');

    if (!this.lastPackage) {
      throw new Error('Package was not materialized.');
    }

    return [];
  }
}

/**
 * Reads the planned slot target for a package workspace input.
 *
 * @param environmentPackage Package carrying the OpenKit session workspace extension.
 * @param inputId Workspace input id.
 * @returns Worker-visible materialized target path.
 */
function sessionWorkspaceInputTarget(
  environmentPackage: AgentEnvironmentPackage,
  inputId: string
): string {
  const openkit = environmentPackage.extensions.openkit as
    | {
        sessionWorkspace?: {
          layout: { slots: Array<{ id: string; path: string }> };
          materialization: { inputs: Array<{ inputId: string; slotId: string }> };
        };
      }
    | undefined;
  const slotId = openkit?.sessionWorkspace?.materialization.inputs.find(
    (input) => input.inputId === inputId
  )?.slotId;
  const path = openkit?.sessionWorkspace?.layout.slots.find((slot) => slot.id === slotId)?.path;

  if (!path) {
    throw new Error(`session workspace target missing for input: ${inputId}`);
  }

  return path;
}

// This fixture supplies confirmed image evidence; the production resolver and subject checks still run.
vi.mock('../runtime/agent-environment.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../runtime/agent-environment.js')>();
  const { withTestPreparedNativeEnvironment } = await import(
    '../test-support/native-environment.js'
  );
  return withTestPreparedNativeEnvironment(actual);
});

describe('retained-record failure publication', () => {
  it('terminalizes forced snapshot preparation failure with fixed text before backend effects', async () => {
    const marker = 'ROW_SECRET_X9';
    const fixture = createWorkerContextExecutorFixture('snapshot-preparation-failure');
    fixture.coreDb.sqlite
      .prepare(
        "UPDATE scheduler_execution_attempts SET startup_deadline = '2099-01-01T00:00:00.000Z'"
      )
      .run();
    const backend = new FakeWorkerGovernanceBackend();
    const original = snapshotLedger.recordAgentEnvironmentPackageSnapshot;
    const recording = vi
      .spyOn(snapshotLedger, 'recordAgentEnvironmentPackageSnapshot')
      .mockImplementation((db, input) =>
        original(db, {
          ...input,
          environmentPackage: { ...input.environmentPackage, schemaVersion: marker } as never,
        })
      );
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const executor = new WorkerGovernanceTurnExecutor({
      backend,
      coreDb: fixture.coreDb,
      createAgentSessionId: () => fixture.agentSessionId,
      environmentBackend: { kind: 'openshell' },
      now: () => '2026-07-18T01:00:06.000Z',
    });
    try {
      const caught = await executor
        .startTurn(fixture.store, fixture.turn.id, fixture.workerRequest, {
          attemptId: `lease_${fixture.turn.id}`,
          agentSessionId: fixture.agentSessionId,
          agentSetup: createTestAgentSetup(),
          requestId: fixture.requestId,
          sandboxBindingRef: fixture.sandboxBindingRef,
          triggerActor: fixture.turn.triggerActor,
          workspaceRoots: [],
        })
        .catch((error: unknown) => error);
      expect(recording).toHaveBeenCalledOnce();
      expect((caught as Error).constructor.name, (caught as Error).message).toBe(
        'AgentEnvironmentSnapshotPreparationError'
      );
      expect(backend.calls).not.toContain('materialize');
      expect(backend.calls).not.toContain('submit');
      const turn = fixture.store.getTurnById(fixture.turn.id);
      expect(turn).toMatchObject({
        status: 'failed',
        error: {
          code: 'worker_governance_turn_failed',
          message: 'The agent environment snapshot could not be prepared.',
        },
      });
      const session = fixture.store.getAgentSession(fixture.agentSessionId);
      expect(session.message).toBe('The agent environment snapshot could not be prepared.');
      const terminal = fixture.store
        .getTurnEvents(fixture.turn.id)
        .find((event) => event.event === 'turn.completed');
      expect(terminal).toMatchObject({
        data: { type: 'turn-completed', stopReason: 'error', turn: { error: turn.error } },
      });
      for (const published of [turn, session, terminal, logged.mock.calls])
        expect(JSON.stringify(published)).not.toContain(marker);
    } finally {
      recording.mockRestore();
      logged.mockRestore();
      fixture.coreDb.sqlite.close();
    }
  });

  it.each([
    ['healthy', false],
    ['syntax', false],
    ['unknown-core', false],
    ['syntax', true],
    ['unknown-core', true],
  ] as const)('publishes %s start with cleanup failure %s safely', async (variant, cleanupFails) => {
    const marker = 'ROW_SECRET_X9';
    const fixture = createWorkerContextExecutorFixture(`published-${variant}-${cleanupFails}`);
    fixture.coreDb.sqlite
      .prepare(
        "UPDATE scheduler_execution_attempts SET startup_deadline = '2099-01-01T00:00:00.000Z'"
      )
      .run();
    const backend = new FakeWorkerGovernanceBackend();
    backend.failTeardown = cleanupFails;
    const executor = new WorkerGovernanceTurnExecutor({
      backend,
      coreDb: fixture.coreDb,
      createAgentSessionId: () => fixture.agentSessionId,
      environmentBackend: { kind: 'openshell' },
      now: () => '2026-07-18T01:00:06.000Z',
    });
    createSchedulerAdmissionEntry(fixture.coreDb, {
      backendId: 'nanohost',
      queueEntryId: 'queue_unrelated',
      workspaceId: 'ws_demo',
      threadId: 'th_unrelated',
      turnId: 'tu_unrelated',
      turnInput: 'Unrelated private input',
      triggerActor: { kind: 'user', id: 'user_local' },
      requestedAgentId: 'agent_codex_host',
      profileRef: null,
    });
    const bytes =
      variant === 'syntax'
        ? marker
        : JSON.stringify({
            kind: 'user',
            id: 'user_local',
            ...(variant === 'unknown-core' ? { kind: marker } : {}),
          });
    fixture.coreDb.sqlite
      .prepare(
        "UPDATE scheduler_admission_entries SET status = 'admitted', trigger_actor_json = ? WHERE queue_entry_id = 'queue_unrelated'"
      )
      .run(bytes);
    const materialize = backend.materialize.bind(backend);
    vi.spyOn(backend, 'materialize').mockImplementation(async (...args) => {
      const result = await materialize(...args);
      if (variant !== 'healthy')
        fixture.coreDb.sqlite
          .prepare(
            'UPDATE scheduler_admission_entries SET trigger_actor_json=? WHERE queue_entry_id=?'
          )
          .run(bytes, `queue_${fixture.turn.id}`);
      return result;
    });
    try {
      const start = executor.startTurn(fixture.store, fixture.turn.id, fixture.workerRequest, {
        attemptId: `lease_${fixture.turn.id}`,
        agentSessionId: fixture.agentSessionId,
        agentSetup: createTestAgentSetup(),
        requestId: fixture.requestId,
        sandboxBindingRef: fixture.sandboxBindingRef,
        triggerActor: fixture.turn.triggerActor,
        workspaceRoots: [],
      });
      if (variant === 'healthy') {
        await start;
        expect(backend.calls).toContain('submit');
        expect(fixture.store.getTurnById(fixture.turn.id).status).toBe('completed');
      } else {
        const caught = await start.catch((error: unknown) => error);
        expect(caught).toBeInstanceOf(cleanupFails ? AggregateError : Error);
        const primary = caught instanceof AggregateError ? caught.errors[0] : caught;
        if (variant === 'syntax') expect((primary as Error).message).toContain(marker);
        else
          expect(primary).toMatchObject({
            issues: expect.arrayContaining([
              expect.objectContaining({
                code: 'invalid_union',
                path: [],
                errors: expect.arrayContaining([
                  expect.arrayContaining([
                    expect.objectContaining({
                      code: 'invalid_value',
                      path: ['kind'],
                      values: ['user'],
                    }),
                  ]),
                ]),
              }),
            ]),
          });
        expect(backend.calls).toContain('materialize');
        expect(backend.calls).toContain('cleanupSession');
        expect(backend.calls).not.toContain('submit');
        const turn = fixture.store.getTurnById(fixture.turn.id);
        const disk = readFileSync(
          join(
            fixture.coreDb.dataRoot,
            'workspaces/ws_demo/threads/th_demo/turns',
            fixture.turn.id,
            'turn.json'
          ),
          'utf8'
        );
        expect(turn).toMatchObject({
          status: 'failed',
          error: {
            code: 'worker_governance_turn_failed',
            message: 'The record could not be processed.',
          },
        });
        expect(JSON.parse(disk)).toMatchObject({ error: turn.error });
        const session = fixture.store.getAgentSession(fixture.agentSessionId);
        expect(session).toMatchObject({
          status: 'failed',
          message: 'The record could not be processed.',
        });
        const terminal = fixture.store
          .getTurnEvents(fixture.turn.id)
          .find((event) => event.event === 'turn.completed');
        expect(terminal).toMatchObject({
          data: { type: 'turn-completed', stopReason: 'error', turn: { error: turn.error } },
        });
        const app = createApp({ coreDb: fixture.coreDb, mode: 'local', store: fixture.store });
        const response = await app.request('/api/app/operations/turn.read', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            workspaceId: 'ws_demo',
            threadId: 'th_demo',
            turnId: fixture.turn.id,
          }),
        });
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body).toMatchObject({ error: turn.error });
        for (const published of [
          disk,
          JSON.stringify(session),
          JSON.stringify(terminal),
          JSON.stringify(body),
        ])
          expect(published).not.toContain(marker);
      }
      expect(
        fixture.coreDb.sqlite
          .prepare(
            "SELECT trigger_actor_json AS bytes FROM scheduler_admission_entries WHERE queue_entry_id = 'queue_unrelated'"
          )
          .get()
      ).toEqual({ bytes });
    } finally {
      fixture.coreDb.sqlite.close();
    }
  });

  it('persists the authored missing-repository recovery sentence unchanged', async () => {
    const fixture = createWorkerContextExecutorFixture('published-authored');
    fixture.coreDb.sqlite
      .prepare(
        "UPDATE scheduler_execution_attempts SET startup_deadline = '2099-01-01T00:00:00.000Z'"
      )
      .run();
    const backend = new FakeWorkerGovernanceBackend();
    const message =
      'Workspace review is not actionable (git_repository_missing): review_demo. Link repository resource repo_demo in Repositories. A new authorized Task can recover retained changes if they remain; linking does not replay the old handoff or apply them.';
    vi.spyOn(backend, 'materialize').mockRejectedValueOnce(new Error(message));
    const executor = new WorkerGovernanceTurnExecutor({
      backend,
      coreDb: fixture.coreDb,
      createAgentSessionId: () => fixture.agentSessionId,
      environmentBackend: { kind: 'openshell' },
      now: () => '2026-07-18T01:00:06.000Z',
    });
    try {
      await expect(
        executor.startTurn(fixture.store, fixture.turn.id, fixture.workerRequest, {
          attemptId: `lease_${fixture.turn.id}`,
          agentSessionId: fixture.agentSessionId,
          agentSetup: createTestAgentSetup(),
          requestId: fixture.requestId,
          sandboxBindingRef: fixture.sandboxBindingRef,
          triggerActor: fixture.turn.triggerActor,
          workspaceRoots: [],
        })
      ).rejects.toThrow(message);
      expect(fixture.store.getTurnById(fixture.turn.id)).toMatchObject({
        status: 'failed',
        error: { code: 'worker_governance_turn_failed', message },
      });
    } finally {
      fixture.coreDb.sqlite.close();
    }
  });
});

/** Moves the exact live Core attempt into closing through its current owner. */
function beginOwnedAttemptCloseout(
  db: CoreDb,
  input: { attemptId: string; firstTerminalCause: string; now?: () => string }
) {
  return attempts.markSchedulerExecutionAttemptClosing(db, {
    attemptId: input.attemptId,
    cause: input.firstTerminalCause,
    ...(input.now ? { now: input.now } : {}),
  });
}

/** Requires online closeout itself to have released its complete attempt; this observer grants nothing. */
function completeOwnedTerminalAttempt(db: CoreDb, input: { id: string }) {
  expect(observeExecutionAttempts(db).filter((row) => row.turn_id === input.id)).toEqual([
    expect.objectContaining({ phase: 'closed', fence_ref: expect.any(String) }),
  ]);
}

const commitFixtureDbs: CoreDb[] = [];
afterEach(() => {
  for (const db of commitFixtureDbs.splice(0)) db.sqlite.close();
});

/** Opens the ordinary authority required by commit-only fixture consumers. */
function openCommitFixtureCore(): CoreDb {
  const db = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-governance-commit-')));
  applyMigrations(db);
  commitFixtureDbs.push(db);
  return db;
}

/** Acquires Core exclusion before the production commit binds its exact Native preparation. */
function acquireCommitFixtureAttempt(
  db: CoreDb,
  preparation: Parameters<WorkerGovernanceTurnExecutor['prepareAgentSessionForTurn']>[1],
  attemptId: string
): void {
  const entry = createSchedulerAdmissionEntry(db, {
    backendId: 'nanohost',
    queueEntryId: `queue:${attemptId}`,
    requestId: preparation.requestId,
    threadId: preparation.turn.threadId,
    turnId: preparation.turn.id,
    workspaceId: preparation.turn.workspaceId,
    turnInput: preparation.turnInput,
    triggerActor: preparation.turn.triggerActor,
    requestedAgentId: preparation.agentSetup.manifest.id,
  });
  attempts.createSchedulerExecutionAttempt(db, {
    entry,
    attemptId,
    preparationInput: { turnInput: preparation.turnInput },
  });
}

/** Faults at the accepted-baseline or Native liveness crossing immediately before turn.start. */
type NativePreSubmissionFault =
  | 'unproved'
  | 'foreign-thread'
  | 'foreign-slot'
  | 'corrupt-cursor'
  | 'corrupt-receipt'
  | 'startup-deadline';

/**
 * Drives the actual Core, governance, Native preparation and submission consumers; only the external
 * NanoHost responses are modeled. Each fault mutates the exact retained fact its consumer reads.
 */
async function assertNativePreSubmissionFault(fault: NativePreSubmissionFault): Promise<void> {
  const fixture = createWorkerContextExecutorFixture(`native-${fault}`);
  const { coreDb, store, turn, agentSessionId } = fixture;
  const attemptId = `lease_${turn.id}`;
  coreDb.sqlite
    .prepare("UPDATE scheduler_execution_attempts SET startup_deadline='2999-01-01T00:00:00.000Z'")
    .run();
  const commit = 'e'.repeat(40);
  const effects: NanoHostSessionEffectRequest[] = [];
  const runtime = createConfiguredWorkerLifecycleRuntime({
    coreDb,
    store,
    env: {},
    workerControlGateway: new WorkerControlGateway(),
    nanoHostSessionDispatch: {
      async effect(connectionOrRequest, carriedRequest) {
        const request = carriedRequest ?? (connectionOrRequest as NanoHostSessionEffectRequest);
        effects.push(request);
        switch (request.kind) {
          case 'image.acquire':
            return { digest: `sha256:${'a'.repeat(64)}` };
          case 'image.inspect':
            return {
              digest: request.input.imageDigest,
              environmentDefaults: {
                defaultsDigest:
                  'sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
                values: {},
              },
              platform: { architecture: 'amd64', os: 'linux' },
              storageLayout: {
                family: 'openkit-worker',
                gid: 1000,
                uid: 1000,
                targets: [{ target: '/sandbox' }, { target: '/workspace' }],
                version: '1',
                workingDirectory: '/tmp/openkit-bootstrap',
              },
            };
          case 'sandbox.create': {
            const storage = request.input.storage as { targets: readonly object[] };
            return {
              sandboxId: request.input.sandboxId,
              state: 'created',
              storage: {
                ...storage,
                targets: storage.targets.map((target) => ({ ...target, initialized: true })),
              },
            };
          }
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
            throw new Error(`Unexpected Native pre-submission effect ${request.kind}.`);
        }
      },
      async poll() {
        return null;
      },
      async result() {},
      async route() {
        throw new Error('Unexpected route.');
      },
    },
  });
  const backend = (runtime.turnExecutor as unknown as { readonly backend: WorkerGovernanceBackend })
    .backend;
  const prepare = backend.prepareLaunch.bind(backend);
  let injected = false;
  const preparing = vi.spyOn(backend, 'prepareLaunch').mockImplementation(async (...args) => {
    const materialization = args[0];
    if (fault === 'corrupt-receipt') {
      // A retained cursor is valid; its exact successor collection receipt is the corrupted input.
      // The Native collection consumer must read this receipt instead of rescanning or submitting.
      const storage = store.getAgentSession(agentSessionId).retainedStorage!;
      const binding = getWorkerStorageBinding(coreDb, { storageRef: storage.storageRef })!;
      const sandboxCreated = effects.find((effect) => effect.kind === 'sandbox.create')!;
      expect(sandboxCreated.input.sandboxId).toEqual(expect.any(String));
      const identity = {
        workspaceId: turn.workspaceId,
        storageRef: binding.storageRef,
        scopeDigest: binding.scopeDigest,
        attachmentGeneration: binding.attachmentGeneration,
        sandboxId: sandboxCreated.input.sandboxId as string,
        workSlot: storage.workSlotRef,
        collectionId: 'baseline',
        agentSessionId,
        threadId: turn.threadId,
        turnId: turn.id,
        packageSnapshotId: materialization.packageSnapshotId,
      };
      const db = openTestWorkspaceDb(coreDb);
      try {
        authorizeWorkspaceBaselineInitialization(db, identity);
        acceptWorkspaceBaseline(
          db,
          identity,
          {
            tree: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
            manifest: 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391',
          },
          null,
          commit
        );
        acceptWorkspaceCapture(
          db,
          {
            ...identity,
            collectionId: `successor-${createHash('sha256').update(materialization.packageSnapshotId).digest('hex')}`,
          },
          { outcome: 'no_new_head', unstable: false },
          null
        );
        db.sqlite
          .prepare(
            "UPDATE workspace_snapshot_collections SET result_json=json_set(result_json, '$.outcome', 'future')"
          )
          .run();
        injected = true;
      } finally {
        db.sqlite.close();
      }
    }
    await prepare(...args);
    if (fault === 'corrupt-receipt') return;
    const db = openTestWorkspaceDb(coreDb);
    try {
      const cursors = db.sqlite
        .prepare('SELECT baseline_identity_json AS identity FROM workspace_snapshot_cursors')
        .all() as { identity: string }[];
      expect(cursors).toHaveLength(1);
      expect(JSON.parse(cursors[0]!.identity)).toMatchObject({
        agentSessionId,
        threadId: turn.threadId,
        turnId: turn.id,
        workspaceId: turn.workspaceId,
        packageSnapshotId: materialization.packageSnapshotId,
      });
      if (fault === 'unproved')
        db.sqlite
          .prepare('UPDATE workspace_snapshot_cursors SET accepted_base_json=NULL, head_json=NULL')
          .run();
      if (fault === 'foreign-thread')
        db.sqlite
          .prepare(
            "UPDATE workspace_snapshot_cursors SET baseline_identity_json=json_set(baseline_identity_json, '$.threadId', 'foreign-thread')"
          )
          .run();
      if (fault === 'foreign-slot')
        db.sqlite.prepare("UPDATE workspace_snapshot_cursors SET work_slot='foreign-slot'").run();
      if (fault === 'corrupt-cursor')
        db.sqlite
          .prepare('UPDATE workspace_snapshot_cursors SET head_json=?')
          .run(JSON.stringify({ tree: 'unknown', manifest: 'b'.repeat(40) }));
      if (fault === 'startup-deadline')
        coreDb.sqlite
          .prepare(
            "UPDATE scheduler_execution_attempts SET startup_deadline='2026-01-01T00:00:00.000Z' WHERE attempt_id=?"
          )
          .run(attemptId);
      injected = true;
    } finally {
      db.sqlite.close();
    }
  });
  const cleanup = vi.spyOn(backend, 'cleanupSession');
  const commands: string[] = [];
  const acceptedPreparationOperations: string[] = [];
  let done = false;
  let failure: unknown;
  const running = runtime.turnExecutor
    .startTurn(store, turn.id, fixture.workerRequest, {
      attemptId,
      agentSessionId,
      requestId: fixture.requestId,
      sandboxBindingRef: fixture.sandboxBindingRef,
      triggerActor: turn.triggerActor,
      agentSetup: createTestAgentSetup({
        requiredCapabilities: ['trusted-worker-inference-relay'],
      }),
      workspaceDataSourceCatalog: {
        schemaVersion: 1,
        sources: [
          {
            access: 'read-write',
            allowedSlotKinds: ['worktree'],
            displayName: 'Main repository',
            id: 'repo_default',
            kind: 'git',
            locator: { url: 'https://example.invalid/source.git', commit },
            sensitivity: 'internal',
            status: 'active',
          },
        ],
      },
      workspaceRoots: [
        {
          access: 'read-write',
          id: 'repo_default',
          sourceKind: 'remote-git',
          sourceCommit: commit,
          workerPath: '/workspace/openkit',
        },
      ],
      workspaceSourceRefs: { repo_default: 'repo_default' },
    })
    .catch((error: unknown) => {
      failure = error;
    })
    .finally(() => {
      done = true;
    });
  try {
    for (let tick = 0; tick < 1000 && !done; tick += 1) {
      const integrations = coreDb.sqlite
        .prepare('SELECT sandbox_integration_binding_ref AS ref FROM sandbox_runtime_records')
        .all() as { ref: string }[];
      for (const integration of integrations) {
        const command = dispatchNanoHostHarnessOperation(coreDb, {
          sandboxIntegrationBindingRef: integration.ref,
        });
        if (!command) continue;
        if (command.operation === 'session.open') {
          const preparation = attempts.requireSchedulerExecutionAttempt(coreDb, attemptId);
          expect(preparation).toMatchObject({ phase: 'open', deadline: null });
          expect(preparation.operationId).toEqual(expect.any(String));
          acceptedPreparationOperations.push(preparation.operationId!);
        }
        runtime.acceptNanoHostHarnessCommand(command);
        commands.push(command.operation);
        // An illicit turn.start is refused externally so the test still drains the production waiter.
        // The refusal assertion below counts queue publication itself, before this modeled result.
        const result = {
          disposition:
            command.operation === 'turn.start' ? ('refused' as const) : ('succeeded' as const),
          body:
            command.operation === 'turn.start'
              ? {
                  reasonCode: 'dependency_failed',
                  message: 'Unexpected turn.start at the pre-submission fault.',
                }
              : command.operation === 'session.close'
                ? { state: 'closed', privateState: 'absent', childState: 'absent' }
                : command.operation === 'session.open'
                  ? {
                      state: 'open',
                      maxActiveTurns: 1,
                      nativeHandleState: 'pending',
                      nativeHandleDigest: null,
                      workspaceGitBaseline: {
                        commit,
                        tree: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
                      },
                    }
                  : {
                      state: 'open',
                      childState: 'absent',
                      cleanupState: 'clean',
                      nativeHandleState: 'pending',
                      nativeHandleDigest: null,
                    },
          harnessInstanceId: command.harnessInstanceId,
          operationId: command.operationId,
          schemaVersion: 2 as const,
          sequence: command.sequence,
        };
        settleNanoHostHarnessOperation(coreDb, {
          result,
          sandboxIntegrationBindingRef: integration.ref,
          timestamp: new Date().toISOString(),
        });
        runtime.acceptNanoHostHarnessResult(result);
      }
      if (!done) await new Promise<void>((resolve) => setTimeout(resolve, 1));
    }
    expect(
      done,
      'The actual Native refusal and cleanup must finish within the existing test timeout.'
    ).toBe(true);
    await running;
    expect(
      injected,
      `The exact named fault must be installed after real materialization: ${(failure as Error)?.message ?? 'no failure'}.`
    ).toBe(true);
    expect(commands).toContain('session.open');
    expect(commands).not.toContain('turn.start');
    expect(failure).toBeInstanceOf(Error);
    const primary = failure instanceof AggregateError ? failure.errors[0] : failure;
    expect((primary as Error).message).toMatch(
      fault === 'startup-deadline'
        ? /execution attempt is not live for worker backend launch\./
        : fault === 'corrupt-cursor'
          ? /Invalid string: must match pattern/
          : fault === 'corrupt-receipt'
            ? /Invalid discriminator value|Invalid input/
            : /accepted baseline/
    );
    expect(cleanup).toHaveBeenCalledTimes(1);
    const attempt = attempts.requireSchedulerExecutionAttempt(coreDb, attemptId);
    expect(attempt.operationId).toEqual(expect.any(String));
    // Corrupt retained collection is refused during preparation, before a submit intent exists.
    // Its successful fixed effects are accepted; that does not claim native Turn acceptance.
    expect(attempt.disposition).toBe(fault === 'corrupt-receipt' ? 'accepted' : 'unknown');
    expect(attempt.deadline).toEqual(fault === 'corrupt-receipt' ? null : expect.any(String));
    if (fault === 'corrupt-receipt')
      expect(acceptedPreparationOperations).toContain(attempt.operationId);
    // Receipt decoding and startup expiry precede submit; failures inside submit retain unknown output/evidence barriers.
    const failedBeforeSubmit = fault === 'corrupt-receipt' || fault === 'startup-deadline';
    expect(attempt.phase).toBe(failedBeforeSubmit ? 'closed' : 'closing');
    expect(attempt.fenceRef).toEqual(failedBeforeSubmit ? expect.any(String) : null);
    if (failedBeforeSubmit) expect(attempt.outcomeRef).toBe(`turn:${turn.id}:failed`);
  } finally {
    preparing.mockRestore();
    cleanup.mockRestore();
    coreDb.sqlite.close();
  }
}

/** Launches through the real Core owners and waits on the real durable completion stream; only the external worker is modeled. */
async function launchFinalReviewWorker(suffix: string) {
  const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-final-review-')));
  applyMigrations(coreDb);
  const store = createDemoStore({ dataRoot: coreDb.dataRoot });
  const turn = createAssignedTurn(store, 'ws_demo', 'th_demo', 'Exercise worker closeout');
  const agentSessionId = `as_review_${suffix}`;
  const attemptId = `lease_${turn.id}`;
  const sandboxBindingRef = `lease-binding:${turn.id}`;
  const requestId = '00000000-0000-4000-8000-000000000290';
  const lineage = {
    agentSessionId,
    packageSnapshotId: `aepsnap_${turn.id}_${agentSessionId}`,
    requestId,
    threadId: turn.threadId,
    turnId: turn.id,
    workspaceId: turn.workspaceId,
  };
  const gateway = createDefaultWorkerControlGateway(coreDb);
  const backend = interruptibleBackend();
  const materialize = backend.materialize.bind(backend);
  let token = '';
  backend.materialize = async (pkg, context) => {
    const registration = gateway.registerSession(pkg, {
      sandboxBindingRef,
      workerControlToken: Buffer.alloc(32, 17).toString('base64url'),
      workerInferenceToken: Buffer.alloc(32, 34).toString('base64url'),
      workerCapabilityToken: Buffer.alloc(32, 51).toString('base64url'),
    });
    token = registration.token;
    bindNanoHostAttemptRouteTokenHashes(coreDb, {
      attemptId,
      sandboxBindingRef,
      workerControlTokenHash: registration.workerControlTokenHash,
      workerInferenceTokenHash: registration.workerInferenceTokenHash,
      workerCapabilityTokenHash: registration.workerCapabilityTokenHash,
    });
    return materialize(pkg, context);
  };
  let notifyWaiting!: () => void;
  const waiting = new Promise<void>((resolve) => {
    notifyWaiting = resolve;
  });
  let settled = false;
  const executor = new WorkerGovernanceTurnExecutor({
    backend,
    coreDb,
    workerControlGateway: gateway,
    awaitWorkerCompletion: (_pkg, exactAttemptId) => {
      const result = waitForWorkerControlFinalStatus(coreDb, {
        attemptId: exactAttemptId,
        lineage,
      });
      notifyWaiting();
      return result;
    },
  });
  const execution = startWithExecutorAttempt(
    coreDb,
    executor,
    store,
    turn,
    agentSessionId,
    new Date().toISOString(),
    'Exercise worker closeout',
    {
      agentSetup: createTestAgentSetup(),
      requestId,
      triggerActor: turn.triggerActor,
      workspaceRoots: [],
    }
  ).then(
    () => {
      settled = true;
      return null;
    },
    (error: unknown) => {
      settled = true;
      return error;
    }
  );
  await Promise.race([
    waiting,
    execution.then((error) => {
      if (error) throw error;
    }),
  ]);
  return {
    coreDb,
    store,
    turn,
    agentSessionId,
    attemptId,
    lineage,
    gateway,
    backend,
    executor,
    token,
    execution,
    settled: () => settled,
    async dispose() {
      if (!settled) {
        attempts.markSchedulerExecutionAttemptClosing(coreDb, {
          attemptId,
          cause: 'test-disposal',
        });
        vi.setSystemTime(requireNanoHostExecutionAttempt(coreDb, attemptId).deadline!);
        await execution;
      }
      coreDb.sqlite.close();
    },
  };
}
