import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
  type WorkerCanonicalEventRecord,
  WorkerCanonicalEventRecordSchema,
  type WorkerLineage,
  type WorkerRuntimeNativeOriginIndexEntry,
  WorkerRuntimeNativeOriginIndexEntrySchema,
  type WorkerRuntimeRawStreamManifest,
  WorkerRuntimeRawStreamManifestSchema,
} from '@openkit/worker-protocol';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { getArtifactReview } from '../artifact-reviews.js';
import { ensureLocalUser } from '../auth/identity.js';
import { disableCanonicalUser } from '../auth/user-lifecycle.js';
import { listWorkspaceEvidenceBundles } from '../evidence-bundles.js';
import {
  claimPendingUserTurnRecord,
  createPendingUserTurnRecord,
  deleteAppliedPendingUserTurnRecord,
  derivePendingUserTurnIds,
  getPendingUserTurnRecord,
} from '../goal-steering-authority.js';
import type { FsStore } from '../lib/store.js';
import type {
  LLMGatewayDispatchContext,
  LLMGatewayProviderDispatcher,
} from '../llm/provider-dispatcher.js';
import { ProviderRegistry } from '../providers/registry.js';
import {
  createSchedulerAdmissionEntry,
  dispatchNextSchedulerEntry,
  upsertSchedulerCapacityRecord,
  upsertSchedulerTargetHealthRecord,
  upsertSchedulerWorkerPool,
} from '../scheduler-records.js';
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
import { createDemoStore } from '../test-support/demo-store.js';
import { recordTestWorkspaceReviewMaterialization } from '../test-support/workspace-sync.js';
import { createVaultGrant } from '../vault/vault-grants.js';
import { createVaultReference } from '../vault/vault-references.js';
import { createVaultUnlockState } from '../vault/vault-unlock-state.js';
import { listVaultUseRecords } from '../vault/vault-use-records.js';
import { listVaultInjectionPlans } from '../vault-injection-plans.js';
import { listVaultInjectionReceipts } from '../vault-injection-receipts.js';
import { upsertWorkspaceRepositoryResource } from '../workspace/repository-store.js';
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
import { requireAgentEnvironmentPackageSnapshot } from './aep-snapshot-ledger.js';
import { createGoalRecord, createGoalTask, updateGoalStatus } from './goal-store.js';
import { commandInputHash } from './idempotent-command.js';
import { TurnStartValidationError } from './orchestrator.js';
import { listWorkspaceRuntimeEvidence } from './runtime-evidence.js';
import { getWorkerBackendSession } from './worker-backend-sessions.js';
import {
  createWorkerCheckpointContextDiagnostics,
  getWorkerCheckpoint,
  upsertWorkerCheckpoint,
} from './worker-checkpoints.js';
import { WorkerControlGateway } from './worker-control-gateway.js';
import { recordWorkerControlAcceptedRecord } from './worker-control-records.js';
import type {
  WorkerGovernanceBackend,
  WorkerGovernanceEvidenceRecord,
  WorkerGovernanceMaterializationRecord,
  WorkerGovernanceWorkspaceChangeRecord,
} from './worker-governance-backend.js';
import {
  WORKER_ARTIFACT_COLLECTION_INVALID,
  WORKER_ARTIFACT_RECOVERY_REQUIRED,
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
import type { WorkerTranscriptPayload } from './worker-transcript.js';
import { getFilesystemWorkspaceStagingRoot } from './workspace-filesystem-staging.js';
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
function dispatchExecutorLease(
  coreDb: CoreDb,
  input: {
    readonly agentSessionId: string;
    readonly packageSnapshotId: string;
    readonly sandboxBindingRef: string;
    readonly threadId: string;
    readonly turnId: string;
    readonly requestId?: string;
    readonly turnInput?: string;
  }
): void {
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
    poolId: 'pool_executor_anchor',
    queueLimit: 20,
    status: 'active',
  });
  upsertSchedulerCapacityRecord(coreDb, {
    capacityClass: 'local',
    concurrencyCeiling: 1,
    inUseCount: 0,
    observationSource: 'configured',
    observedAt: '2026-07-15T00:00:00.000Z',
    poolId: 'pool_executor_anchor',
    queueDepth: 0,
    targetId: 'target_executor_anchor',
  });
  upsertSchedulerTargetHealthRecord(coreDb, {
    checkResults: [],
    consecutiveFailureCount: 0,
    consecutiveSuccessCount: 1,
    healthState: 'healthy',
    lastProbeAt: '2026-07-15T00:00:00.000Z',
    nextProbeAt: '2026-07-15T00:01:00.000Z',
    targetId: 'target_executor_anchor',
  });
  createSchedulerAdmissionEntry(coreDb, {
    triggerActor: { kind: 'user', id: 'user_local' },
    priorityClass: 'interactive',
    profileRef: 'profile_worker',
    queueEntryId: `queue_${input.turnId}`,
    ...(input.requestId ? { requestId: input.requestId } : {}),
    requestedAgentId: 'agent_codex_host',
    requiredPoolConstraints: ['openshell.local'],
    threadId: input.threadId,
    turnId: input.turnId,
    turnInput: input.turnInput ?? 'Run governed worker',
    workspaceId: 'ws_demo',
    now: () => '2026-07-15T00:00:01.000Z',
  });
  dispatchNextSchedulerEntry(coreDb, {
    agentSessionId: input.agentSessionId,
    expectedControlMode: 'poll',
    expectedDataPlaneMode: 'openshell-files',
    heartbeatIntervalMs: 10_000,
    heartbeatTimeoutMs: 30_000,
    leaseDurationMs: 900_000,
    leaseId: `lease_${input.turnId}`,
    now: () => '2026-07-15T00:00:02.000Z',
    packageSnapshotId: input.packageSnapshotId,
    planId: `plan_${input.turnId}`,
    sandboxBindingRef: input.sandboxBindingRef,
    schedulerEpoch: 1,
    startupTimeoutMs: 120_000,
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

/**
 * Creates the single scheduler, checkpoint, Item, and Material tuple used by S39 executor tests.
 *
 * @param name Stable isolated fixture suffix.
 * @param options Optional steering, budget, and claim variants.
 * @returns Exact execution owners plus their canonical package paths.
 */
function createWorkerContextExecutorFixture(
  name: string,
  options: {
    readonly inputKind?: 'material' | 'message';
    readonly materialContent?: string;
    readonly maxContextTokens?: number;
    readonly mismatchedClaim?: boolean;
    readonly steeringContent?: string;
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
  const goalId = `goal_context_${name}`;
  const taskId = `task_context_${name}`;
  const maxContextTokens = options.maxContextTokens ?? 12_000;
  const pendingIds = derivePendingUserTurnIds({
    requestId: `request_steering_context_${name}`,
    threadId: turn.threadId,
    workspaceId: turn.workspaceId,
  });
  const workerRequest =
    options.workerRequest ??
    JSON.stringify({
      schemaVersion: 1,
      objective: 'Prepare the accepted worker context.',
      acceptanceCriteria: ['The requested context is available.'],
      contextRefs: [
        { kind: 'item', id: contextItemId },
        { kind: 'item', id: pendingIds.contentItemId },
      ],
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
  const steeringReceivedAt = '2026-07-18T00:59:59.000Z';
  store.createItem({
    actor: turn.triggerActor,
    causationId: `request_steering_context_${name}`,
    completedAt: steeringReceivedAt,
    createdAt: steeringReceivedAt,
    id: pendingIds.contentItemId,
    parentItemId: null,
    status: 'completed',
    text: 'Apply this accepted steering input.',
    threadId: turn.threadId,
    turnId: turn.id,
    type: 'user-message',
    workspaceId: turn.workspaceId,
  });
  const agentSessionId = `as_context_${name}`;
  const sandboxBindingRef = `lease-binding:context-${name}`;
  dispatchExecutorLease(coreDb, {
    agentSessionId,
    packageSnapshotId: `aepsnap_${turn.id}_${agentSessionId}`,
    requestId,
    sandboxBindingRef,
    threadId: turn.threadId,
    turnId: turn.id,
    turnInput: workerRequest,
  });
  const workspaceDb = openTestWorkspaceDb(coreDb);
  createGoalRecord(workspaceDb, {
    goalId,
    objective: 'Prepare the accepted worker context.',
    threadId: turn.threadId,
    title: 'Prepare worker context',
    workspaceExists: (workspaceId) => workspaceId === turn.workspaceId,
    workspaceId: turn.workspaceId,
  });
  updateGoalStatus(workspaceDb, {
    goalId,
    planItemId: `it_plan_context_${name}`,
    status: 'running',
    threadId: turn.threadId,
    workspaceId: turn.workspaceId,
  });
  createGoalTask(workspaceDb, {
    acceptanceCriteria: ['The requested context is available.'],
    contextBudgetTokens: maxContextTokens,
    dependsOnTaskIds: [],
    escalationConditions: [],
    expectedArtifacts: [],
    goalId,
    objective: 'Prepare the accepted worker context.',
    orderIndex: 0,
    planItemId: `it_plan_context_${name}`,
    resources: [],
    reviewPolicy: {
      instructions: 'Review the accepted context.',
      required: true,
      reviewers: ['human'],
    },
    status: 'running',
    taskId,
    threadId: turn.threadId,
    title: 'Prepare worker context',
    verificationChecks: [{ description: 'Inspect the worker context.', kind: 'manual' }],
    workspaceId: turn.workspaceId,
  });
  upsertWorkerCheckpoint(workspaceDb, {
    goalId,
    iteration: 0,
    requestId,
    requestInputHash: commandInputHash({}),
    stage: 'preparing',
    taskId,
    threadId: turn.threadId,
    turnId: turn.id,
    workspaceId: turn.workspaceId,
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
  const steeringMaterial =
    options.inputKind === 'material'
      ? createWorkspaceMaterial(workspaceDb, {
          acceptedAt: '2026-07-18T01:00:03.000Z',
          actorId: LOCAL_USER_ID,
          kind: 'markdown',
          requestId: `request_create_steering_context_${name}`,
          sensitivity: 'internal',
          title: 'Steering context material',
        })
      : null;
  const steeringContent = options.steeringContent ?? '# Exact steering context\n';
  const steeringContentDigest = turnRuntimeSha256(Buffer.from(steeringContent, 'utf8'));
  const steeringRevision = steeringMaterial
    ? saveWorkspaceMaterialRevision(workspaceDb, {
        acceptedAt: '2026-07-18T01:00:04.000Z',
        actorId: LOCAL_USER_ID,
        content: steeringContent,
        contentDigest: steeringContentDigest,
        expectedRevisionId: null,
        materialId: steeringMaterial.materialId,
        requestId: `request_save_steering_context_${name}`,
      })
    : null;
  const pending = createPendingUserTurnRecord(workspaceDb, {
    activeTurnId: turn.id,
    goalId,
    input:
      steeringMaterial && steeringRevision
        ? {
            contentDigest: steeringContentDigest,
            kind: 'material',
            materialId: steeringMaterial.materialId,
            revisionId: steeringRevision.revisionId,
          }
        : { kind: 'message' },
    receivedAt: steeringReceivedAt,
    requestId: `request_steering_context_${name}`,
    threadId: turn.threadId,
    workspaceId: turn.workspaceId,
  });
  claimPendingUserTurnRecord(workspaceDb, {
    pendingTurnId: pending.pendingTurnId,
    terminalClaimId: options.mismatchedClaim ? 'ctxpkg_wrong_turn' : `ctxpkg_${turn.id}`,
    terminalClaimKind: 'applied',
    terminalClaimedAt: '2026-07-18T01:00:05.000Z',
    threadId: turn.threadId,
    workspaceId: turn.workspaceId,
  });
  workspaceDb.sqlite.close();
  const workspaceRoot = join(dataRoot, 'workspaces', turn.workspaceId);
  const packageRoot = join(
    workspaceRoot,
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
    pending,
    queuedMaterial,
    requestId,
    revision,
    sandboxBindingRef,
    store,
    steeringMaterial,
    steeringRevision,
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
 * @param repositoryStrategy Linked repository staging strategy, or `missing` for no exact link.
 * @returns Ingress dependencies and a valid baseline worker change record.
 */
function createWorkspaceChangeIngressFixture(
  name: string,
  strategy: 'git' | 'filesystem',
  repositoryStrategy: 'missing' | 'review-branch' | 'staging-root'
) {
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
  if (repositoryStrategy !== 'missing') {
    upsertWorkspaceRepositoryResource(workspaceDb, {
      displayName: 'Ingress validation repository',
      git: {
        authorEmail: 'approver@example.invalid',
        authorName: 'Approving Human',
        stagingStrategy: repositoryStrategy,
      },
      localPath: repositoryPath,
      resourceId,
      workspaceExists: (candidateWorkspaceId) => candidateWorkspaceId === workspaceId,
      workspaceId,
    });
  }

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

describe('WorkerGovernanceTurnExecutor', () => {
  it('reuses compatible continuity without previewing a fresh AgentSession target', async () => {
    const store = createDemoStore();
    const turn = createAssignedTurn(store, 'ws_demo', 'th_demo', 'Reuse current continuity');
    const currentCompatibilityKey = `sha256:${'a'.repeat(64)}`;
    store.createAgentSession({
      agentId: 'agent_codex_host',
      createdAt: '2026-08-21T00:00:00.000Z',
      environmentPackageSnapshotId: 'aepsnap-current-continuity',
      id: 'as-current-continuity',
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
        turnInput: turn.input,
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
    expect(prepareContinuity).toHaveBeenCalledOnce();
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
        turnInput: turn.input,
        workspaceRoots: [],
      })
    ).rejects.toThrow('Fresh target preview failed.');
    expect(prepareContinuity).toHaveBeenCalledOnce();
    expect(prepareContinuity).toHaveBeenCalledWith(expect.objectContaining({ reuseAllowed: true }));
    expect(store.getAgentSession('as-runtime-incompatible').status).toBe('idle');
  });

  it('commits replacement only after fresh compatibility and runtime revalidation', async () => {
    const store = createDemoStore();
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
      turnInput: turn.input,
      workspaceCwd: null,
      workspaceRoots: [],
    };
    const prepared = await executor.prepareAgentSessionForTurn(store, preparation);

    expect(store.getAgentSession('as-current-replacement').status).toBe('idle');
    await executor.commitPreparedAgentSessionForTurn(store, {
      leaseId: 'lease-commit-replacement',
      prepared,
      preparation,
    });

    expect(events.indexOf('fresh-preview')).toBeLessThan(events.indexOf('runtime-close'));
    expect(store.getAgentSession('as-current-replacement')).toMatchObject({
      status: 'closed',
      updatedAt: '2026-08-21T00:00:05.000Z',
    });
  });

  it('starts an ordinary product Turn from the real pre-lease preview key without a Context Package', async () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-governance-preview-launch-')));
    applyMigrations(coreDb);

    try {
      const store = createDemoStore();
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
      const workspaceCwd = process.cwd();
      const workspaceRoots = [
        {
          access: 'read-write' as const,
          id: 'repo',
          sourceKind: 'host-dir' as const,
          sourcePath: workspaceCwd,
          workerPath: '/workspace/openkit',
        },
      ];
      const prepared = await executor.prepareAgentSessionForTurn(store, {
        agentSetup,
        freshAgentSessionId: agentSessionId,
        requestId: '00000000-0000-4000-8000-00000000b001',
        turn,
        turnInput,
        workspaceCwd,
        workspaceRoots,
      });

      await expect(
        executor.startTurn(store, turn.id, turnInput, {
          agentSessionId: prepared.agentSessionId,
          agentSetup,
          requestId: '00000000-0000-4000-8000-00000000b001',
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

  it('advertises interrupts only when the shared worker-control capability exists', () => {
    const backend = new FakeWorkerGovernanceBackend();
    const withoutGateway = new WorkerGovernanceTurnExecutor({ backend });
    const withGateway = new WorkerGovernanceTurnExecutor({
      backend,
      workerControlGateway: new WorkerControlGateway(),
    });

    expect(withoutGateway.capabilities.interrupts).toBe(false);
    expect(withGateway.capabilities.interrupts).toBe(true);
  });

  it('enqueues exactly one same-attempt interrupt without owning terminal lifecycle', async () => {
    const store = createDemoStore();
    const turn = createAssignedTurn(
      store,
      'ws_demo',
      'th_demo',
      'Keep the one-shot worker running'
    );
    const backend = new FakeWorkerGovernanceBackend();
    const workerControlGateway = new WorkerControlGateway({
      now: () => '2026-08-12T00:00:00.000Z',
    });
    const { agentSessionId, packageSnapshotId } = bindInterruptAttempt(
      store,
      workerControlGateway,
      turn
    );
    const executor = new WorkerGovernanceTurnExecutor({
      backend,
      workerControlGateway,
    });
    const enqueueInterrupt = vi.spyOn(workerControlGateway, 'enqueueInterrupt');
    const turnBeforeInterrupt = store.getTurnById(turn.id);
    const sessionBeforeInterrupt = store.getAgentSession(agentSessionId);
    const eventsBeforeInterrupt = store.getTurnEvents(turn.id);

    await executor.interruptTurn(store, turn.id, { requestId: 'req_interrupt_exact' });

    expect(enqueueInterrupt).toHaveBeenCalledTimes(1);
    expect(enqueueInterrupt).toHaveBeenCalledWith(packageSnapshotId, null);
    expect(workerControlGateway.getSessionSnapshot(packageSnapshotId)?.commands).toEqual([
      {
        commandId: 'worker-command-1',
        deliveredAt: null,
        kind: 'interrupt',
        queuedAt: '2026-08-12T00:00:00.000Z',
        reason: null,
        sequence: 1,
      },
    ]);
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
  ])('fails closed for %s interrupt without enqueuing a worker command', async (failureMode) => {
    const store = createDemoStore();
    const turn = createAssignedTurn(store, 'ws_demo', 'th_demo', `Reject ${failureMode} interrupt`);
    const workerControlGateway = new WorkerControlGateway();
    const executor = new WorkerGovernanceTurnExecutor({
      backend: new FakeWorkerGovernanceBackend(),
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
    const enqueueInterrupt = vi.spyOn(workerControlGateway, 'enqueueInterrupt');
    const turnBeforeInterrupt = store.getTurnById(turn.id);

    await expect(
      executor.interruptTurn(store, turn.id, { requestId: `req_${failureMode}` })
    ).rejects.toThrow();

    expect(enqueueInterrupt).not.toHaveBeenCalled();
    expect(store.getTurnById(turn.id)).toEqual(turnBeforeInterrupt);
  });

  it.each([
    { expectedStatus: 'completed', mode: 'exact' },
    { expectedStatus: 'failed', mode: 'missing' },
    { expectedStatus: 'failed', mode: 'conflict' },
    { expectedStatus: 'failed', mode: 'artifact-invalid' },
  ] as const)('reconciles $mode transcript events against durable live acceptance', async ({
    expectedStatus,
    mode,
  }) => {
    const coreDb = openCoreDb(
      mkdtempSync(join(tmpdir(), `openkit-governance-live-events-${mode}-`))
    );
    applyMigrations(coreDb);
    const store = createDemoStore();
    const turn = createAssignedTurn(store, 'ws_demo', 'th_demo', `Reconcile ${mode} worker events`);
    const backend = new FakeWorkerGovernanceBackend();
    backend.artifactCollectionInvalid = mode === 'artifact-invalid';
    backend.eventsJsonlFactory = (environmentPackage) => {
      const lineage: WorkerLineage = {
        agentSessionId: environmentPackage.scope.agentSessionId,
        packageSnapshotId: environmentPackage.snapshotId,
        requestId: environmentPackage.scope.requestId,
        threadId: environmentPackage.scope.threadId,
        turnId: environmentPackage.scope.turnId,
        workspaceId: environmentPackage.scope.workspaceId,
      };
      const transcriptRecord = WorkerCanonicalEventRecordSchema.parse({
        event: { data: { status: 'running' }, type: 'worker.heartbeat' },
        kind: 'event',
        lineage,
        schemaVersion: 1,
        sequence: 0,
      });

      if (mode !== 'missing') {
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

      return `${JSON.stringify(transcriptRecord)}\n`;
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
      'artifact-invalid': '00000000-0000-4000-8000-000000000234',
    }[mode];
    const run = executor.startTurn(store, turn.id, `Reconcile ${mode} worker events`, {
      agentSetup: createTestAgentSetup(),
      requestId,
      triggerActor: turn.triggerActor,
      workspaceRoots: [],
    });

    if (mode === 'exact') {
      await expect(run).resolves.toBeUndefined();
    } else if (mode === 'artifact-invalid') {
      await expect(run).rejects.toMatchObject({ code: 'invalid_request', status: 400 });
      expect(backend.calls.at(-1)).toBe('cleanupSession');
    } else {
      await expect(run).rejects.toThrow('Worker transcript event reconciliation failed');
    }
    expect(store.getTurnById(turn.id).status).toBe(expectedStatus);
    coreDb.sqlite.close();
  });

  it('imports one backend-validated Artifact proposal through the accepted Context Package trace', async () => {
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
    backend.artifactOutput = {
      bytes: artifactBytes,
      materialProposal: {
        baseContentDigest: materialContentDigest,
        baseRevisionId: revision.revisionId,
        materialId: material.materialId,
      },
    };
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
        agentSessionId,
        agentSetup: createTestAgentSetup(),
        requestId,
        sandboxBindingRef,
        triggerActor: turn.triggerActor,
        workspaceRoots: [],
      });

      const packageSnapshotId = backend.lastPackage?.snapshotId;
      expect(packageSnapshotId).toBeTruthy();
      const artifactId = `worker-artifact-${packageSnapshotId}-2`;
      expect(store.getArtifact(turn.workspaceId, artifactId)).toMatchObject({
        content: { body: artifactBytes.toString('utf8'), format: 'markdown' },
        contentDigest: turnRuntimeSha256(artifactBytes),
        origin: {
          kind: 'turn-output',
          requestId,
          threadId: turn.threadId,
          turnId: turn.id,
        },
        status: 'ready',
        version: 1,
      });
      const workspaceDb = openTestWorkspaceDb(coreDb);
      expect(getArtifactReview(workspaceDb, artifactId, 1)).toMatchObject({
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
    backend.artifactOutput = { bytes: Buffer.from('# Stale output\n', 'utf8') };
    const collectTranscript = backend.collectTranscript.bind(backend);
    vi.spyOn(backend, 'collectTranscript').mockImplementation(async () => {
      const transcript = { ...(await collectTranscript()) };
      delete transcript.itemsJsonl;
      coreDb.sqlite.transaction(() => {
        disableCanonicalUser(coreDb, LOCAL_USER_ID, new Date('2026-07-15T00:00:02.000Z'));
      })();
      return transcript;
    });
    const executor = new WorkerGovernanceTurnExecutor({
      backend,
      coreDb,
      createAgentSessionId: () => 'as_governance_stale_publication_1',
      environmentBackend: {
        kind: 'openshell',
      },
      now: () => '2026-07-15T00:00:03.000Z',
    });

    try {
      await expect(
        executor.startTurn(store, turn.id, 'Do not publish stale output', {
          agentSetup: createTestAgentSetup(),
          requestId: '00000000-0000-4000-8000-000000000235',
          triggerActor: turn.triggerActor,
          workspaceRoots: [],
        })
      ).rejects.toMatchObject({ code: 'workspace_access_denied', status: 403 });

      expect(backend.calls).toEqual([
        'materialize',
        'launch',
        'collectEvidence',
        'collectTranscript',
        'collectWorkspaceChanges',
        'cleanupSession',
      ]);
      expect(store.listArtifacts(turn.workspaceId)).toEqual([]);
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

  it('rejects worker output after the Workspace deletion fence closes', async () => {
    expect(WORKSPACE_MUTATION_LATE_PUBLISHERS).toEqual(['worker-turn-closeout']);
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-governance-deletion-fence-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore({ dataRoot });
    const turn = createAssignedTurn(store, 'ws_demo', 'th_demo', 'Do not publish fenced output');
    const backend = new FakeWorkerGovernanceBackend();
    backend.artifactOutput = { bytes: Buffer.from('# Fenced output\n', 'utf8') };
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

  it('imports worker transcript records and tears down the materialized backend session', async () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-governance-records-')));

    applyMigrations(coreDb);

    const store = createDemoStore();
    const turn = createAssignedTurn(store, 'ws_demo', 'th_demo', 'Run in OpenShell');
    store.updateTurn(turn.id, { agentId: 'agent_opencode_host' });
    const completedAt = new Date(
      new Date(turn.startedAt ?? Date.now()).getTime() + 1000
    ).toISOString();
    const backend = new FakeWorkerGovernanceBackend({ sandboxName: 'sandbox_governance_1' });
    const executor = new WorkerGovernanceTurnExecutor({
      backend,
      coreDb,
      createAgentSessionId: () => 'as_governance_1',
      environmentBackend: {
        kind: 'openshell',
      },
      now: () => completedAt,
    });

    await executor.startTurn(store, turn.id, 'Run in OpenShell', {
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
      workspaceCwd: process.cwd(),
      workspaceRoots: [
        {
          access: 'read-write',
          id: 'repo',
          sourceKind: 'host-dir',
          sourcePath: process.cwd(),
          workerPath: '/workspace/openkit',
        },
      ],
    });

    expect(backend.calls).toEqual([
      'materialize',
      'launch',
      'collectEvidence',
      'collectTranscript',
      'collectWorkspaceChanges',
      'cleanupSession',
    ]);
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
    expect(backend.lastPackage?.runtime.command.workingDirectory).toBe('/workspace/openkit');
    expect(backend.lastContext?.workspaceRoots).toEqual([
      expect.objectContaining({
        id: 'repo',
        sourcePath: process.cwd(),
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
        materializedRootRef: '/workspace/openkit/worktrees/main',
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

  it('collects durable outputs and preserves a failed worker status', async () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-governance-failed-status-')));
    applyMigrations(coreDb);
    const store = createDemoStore();
    const turn = createAssignedTurn(store, 'ws_demo', 'th_demo', 'Observe failed worker status');
    const agentSessionId = 'as_failed_status_1';
    const packageSnapshotId = `aepsnap_${turn.id}_${agentSessionId}`;
    const sandboxBindingRef = 'lease-binding:failed-status';
    dispatchExecutorLease(coreDb, {
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
        return {
          acceptedAt: '2026-07-15T00:00:03.000Z',
          status: 'failed' as const,
          stopReason: 'error',
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
      'launch',
      'awaitWorkerCompletion',
      'collectEvidence',
      'collectTranscript',
      'collectWorkspaceChanges',
      'cleanupSession',
    ]);
    expect(store.getTurnById(turn.id).status).toBe('failed');
    expect(store.getTurnEvents(turn.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          data: expect.objectContaining({ stopReason: 'error', type: 'turn-completed' }),
          event: 'turn.completed',
        }),
      ])
    );
    coreDb.sqlite.close();
  });

  it('cleans an ask-user worker before interrupting the product owners and requiring recovery', async () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-governance-ask-user-')));
    applyMigrations(coreDb);
    const store = createDemoStore();
    const turn = createAssignedTurn(store, 'ws_demo', 'th_demo', 'Ask for unavailable input');
    const agentSessionId = 'as_ask_user_1';
    const packageSnapshotId = `aepsnap_${turn.id}_${agentSessionId}`;
    const sandboxBindingRef = 'lease-binding:ask-user';
    dispatchExecutorLease(coreDb, {
      agentSessionId,
      packageSnapshotId,
      sandboxBindingRef,
      threadId: turn.threadId,
      turnId: turn.id,
    });
    const backend = new FakeWorkerGovernanceBackend();
    const executor = new WorkerGovernanceTurnExecutor({
      awaitWorkerCompletion: async () => ({
        acceptedAt: '2026-07-15T00:00:03.000Z',
        status: 'blocked' as const,
        stopReason: 'ask_user',
      }),
      backend,
      coreDb,
      createAgentSessionId: () => agentSessionId,
      environmentBackend: {
        kind: 'openshell',
      },
      now: () => '2026-07-15T00:00:03.000Z',
    });

    const error = await executor
      .startTurn(store, turn.id, 'Ask for unavailable input', {
        agentSessionId,
        agentSetup: createTestAgentSetup(),
        requestId: '00000000-0000-4000-8000-000000000255',
        sandboxBindingRef,
        triggerActor: turn.triggerActor,
        workspaceRoots: [],
      })
      .then(
        () => null,
        (cause: unknown) => cause
      );

    expect(error).toBeInstanceOf(TurnStartValidationError);
    expect(error).toMatchObject({ code: 'recovery_required', status: 409 });
    expect(backend.calls.at(-1)).toBe('cleanupSession');
    expect(store.getTurnById(turn.id)).toMatchObject({
      error: { code: 'worker_human_gate_unavailable' },
      status: 'interrupted',
    });
    expect(store.getAgentSession(agentSessionId)).toMatchObject({ status: 'interrupted' });
    expect(getWorkerBackendSession(coreDb, `lease_${turn.id}`)).toMatchObject({ state: 'cleaned' });
    coreDb.sqlite.close();
  });

  it.each([
    {
      finalStatus: 'completed',
      stopReason: 'completed',
      turnStatus: 'completed',
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
      turnStatus: 'cancelled',
    },
    {
      finalStatus: 'interrupted',
      stopReason: 'aborted',
      turnStatus: 'cancelled',
    },
    {
      finalStatus: 'blocked',
      stopReason: 'ask_user',
      turnStatus: 'interrupted',
    },
    {
      finalStatus: 'blocked',
      preexistingErrorCode: 'unrelated_interruption',
      stopReason: 'ask_user',
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
    const store = createDemoStore();
    const turn = createAssignedTurn(
      store,
      'ws_demo',
      'th_demo',
      'Wait for durable worker completion'
    );
    const agentSessionId = 'as_completion_gate_1';
    const packageSnapshotId = `aepsnap_${turn.id}_${agentSessionId}`;
    const sandboxBindingRef = 'lease-binding:completion-gate';
    dispatchExecutorLease(coreDb, {
      agentSessionId,
      packageSnapshotId,
      sandboxBindingRef,
      threadId: turn.threadId,
      turnId: turn.id,
    });
    const backend = new FakeWorkerGovernanceBackend();
    backend.artifactRecoveryRequired = 'artifactRecoveryRequired' in testCase;
    backend.artifactCollectionInvalid = 'artifactCollectionInvalid' in testCase;
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
    expect(backend.calls).toEqual(['materialize', 'launch']);
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
      record: { sequence: 1, status: finalStatus, stopReason },
      recordKey: '1',
      sequence: 1,
    });
    if ('preexistingErrorCode' in testCase) {
      store.updateTurn(turn.id, {
        agentSessionId,
        completedAt: '2026-07-15T00:00:04.000Z',
        error: {
          code: testCase.preexistingErrorCode,
          message: 'Existing unrelated interruption.',
        },
        status: 'interrupted',
      });
    }
    const restartedExecutor = new WorkerGovernanceTurnExecutor({
      backend,
      coreDb,
      environmentBackend: {
        kind: 'openshell',
      },
      now: () => '2026-07-15T00:00:04.000Z',
    });

    if ('artifactRecoveryRequired' in testCase || 'artifactCollectionInvalid' in testCase) {
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
      if (projectionSpy) {
        await expect(recovery).rejects.toThrow('stable product outcome could not be persisted');
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
      expect(backend.calls).toEqual([
        'materialize',
        'launch',
        'collectEvidence',
        'collectTranscript',
        'cleanupSession',
      ]);
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
        'launch',
        'collectEvidence',
        'collectTranscript',
        'cleanupSession',
      ]);
      coreDb.sqlite.close();
      return;
    }

    if ('preexistingErrorCode' in testCase) {
      await expect(
        restartedExecutor.resumeAcceptedFinalStatus(store, awaitedEnvironmentPackage, session)
      ).rejects.toThrow('Restart closeout did not establish the unavailable human-gate fallback.');
      expect(store.getTurnById(turn.id)).toMatchObject({
        error: { code: testCase.preexistingErrorCode },
        status: 'interrupted',
      });
      expect(store.getAgentSession(agentSessionId)).toMatchObject({ status: 'busy' });
      expect(getWorkerBackendSession(coreDb, `lease_${turn.id}`)).toMatchObject({
        state: 'cleaned',
      });
      coreDb.sqlite.close();
      return;
    }

    await expect(
      restartedExecutor.resumeAcceptedFinalStatus(store, awaitedEnvironmentPackage, session)
    ).resolves.toBe(turnStatus);

    expect(backend.calls).toEqual([
      'materialize',
      'launch',
      'collectEvidence',
      'collectTranscript',
      'collectWorkspaceChanges',
      'cleanupSession',
    ]);
    expect(store.getTurnById(turn.id)).toMatchObject({
      ...(stopReason === 'ask_user' ? { error: { code: 'worker_human_gate_unavailable' } } : {}),
      agentSessionId,
      status: turnStatus,
    });
    expect(
      store.getTurnEvents(turn.id).find((event) => event.event === 'turn.completed')
    ).toMatchObject({ data: { stopReason: stopReason === 'ask_user' ? 'aborted' : stopReason } });
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
      providerRegistry: new ProviderRegistry([
        {
          defaultModel: 'openai/gpt-5.2',
          displayName: 'Agent OpenRouter',
          id: 'agent-openrouter',
          kind: 'gateway',
          models: ['openai/gpt-5.2'],
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
      const turnMetadata = {
        ...(parentNativeThreadId
          ? { parent_thread_id: parentNativeThreadId, subagent_kind: 'thread_spawn' }
          : {}),
        request_kind: 'turn',
        session_id: TURN_NATIVE_SESSION_ID,
        thread_id: nativeThreadId,
      };
      const encodedMetadata = JSON.stringify(turnMetadata);
      const response = await app.request('/api/worker-inference/v1/responses', {
        body: JSON.stringify({
          client_metadata: {
            session_id: TURN_NATIVE_SESSION_ID,
            thread_id: nativeThreadId,
            ...(parentNativeThreadId
              ? {
                  'x-codex-parent-thread-id': parentNativeThreadId,
                  'x-openai-subagent': 'collab_spawn',
                }
              : {}),
            'x-codex-turn-metadata': encodedMetadata,
          },
          input: 'Deterministic worker inference',
          model: 'openai/gpt-5.2',
          prompt_cache_key: nativeCacheLineageId,
          ...options.body,
        }),
        headers: {
          authorization: `Bearer ${workerInferenceToken}`,
          'content-type': 'application/json',
          'session-id': TURN_NATIVE_SESSION_ID,
          'thread-id': nativeThreadId,
          'x-client-request-id': nativeThreadId,
          ...(parentNativeThreadId
            ? {
                'x-codex-parent-thread-id': parentNativeThreadId,
                'x-openai-subagent': 'collab_spawn',
              }
            : {}),
          'x-codex-turn-metadata': encodedMetadata,
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
      await executor.startTurn(store, turn.id, 'Import governed runtime provenance', {
        agentSetup: createTestAgentSetup({
          provider: {
            model: 'openai/gpt-5.2',
            origin: 'server-providers',
            providerId: 'agent-openrouter',
            secretRef: null,
          },
          requiredCapabilities: ['trusted-worker-inference-relay', 'worker.runtime-provenance.v1'],
        }),
        requestId: '00000000-0000-4000-8000-000000000220',
        triggerActor: turn.triggerActor,
        workspaceRoots: [],
      });

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
      const evidenceResponse = await app.request('/api/app/workspaces/ws_demo/evidence-bundles');
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

      const usageResponse = await app.request('/api/app/workspaces/ws_demo/capability-usage');
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

      const auditResponse = await app.request('/api/app/workspaces/ws_demo/audit/events');
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
        '/api/app/workspaces/ws_demo/runtime-evidence'
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
      const itemsResponse = await app.request('/api/app/workspaces/ws_demo/threads/th_demo/items');
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
        executor.startTurn(store, turn.id, `Reject ${failure} runtime provenance`, {
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
        })
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

  it('binds the trusted provider selection into the materialized package', async () => {
    const store = createDemoStore();
    const turn = createAssignedTurn(store, 'ws_demo', 'th_demo', 'Run trusted worker inference');
    const backend = new FakeWorkerGovernanceBackend();
    const executor = new WorkerGovernanceTurnExecutor({
      backend,
      createAgentSessionId: () => 'as_governance_relay_1',
      environmentBackend: {
        kind: 'openshell',
      },
    });

    await executor.startTurn(store, turn.id, 'Run trusted worker inference', {
      agentSetup: createTestAgentSetup({
        requiredCapabilities: ['trusted-worker-inference-relay'],
      }),
      requestId: '00000000-0000-4000-8000-000000000214',
      triggerActor: turn.triggerActor,
      workspaceCwd: '/workspace/repo',
      workspaceRoots: [],
    });

    expect(backend.lastPackage?.llm.routes).toEqual([
      expect.objectContaining({
        model: 'openai/gpt-5.2',
        providerInstanceId: 'openkit-gateway',
      }),
    ]);
    expect(backend.lastPackage).not.toHaveProperty('providers');
  });

  it('stages linked review branches while ingesting production worker changes', async () => {
    const fixture = createWorkspaceChangeIngressFixture(
      'staged_review_branch',
      'git',
      'review-branch'
    );
    const baseCommit = runTestGit(fixture.repositoryPath, ['rev-parse', 'HEAD']).trim();
    const initialStatus = runTestGit(fixture.repositoryPath, ['status', '--short']);
    const initialWorktrees = runTestGit(fixture.repositoryPath, [
      'worktree',
      'list',
      '--porcelain',
    ]);

    recordTestWorkspaceReviewMaterialization(fixture.workspaceDb, {
      artifactId: fixture.artifactId,
      ...fixture.record,
    });

    await ingestWorkspaceChangeFixture(fixture, fixture.record);

    const branchCommit = runTestGit(fixture.repositoryPath, [
      'rev-parse',
      '--verify',
      fixture.reviewBranchRef,
    ]).trim();
    expect(branchCommit).not.toBe(baseCommit);
    expect(runTestGit(fixture.repositoryPath, ['show', `${branchCommit}:README.md`])).toBe(
      '# Demo\n\nReviewed.\n'
    );
    expect(runTestGit(fixture.repositoryPath, ['rev-parse', 'HEAD']).trim()).toBe(baseCommit);
    expect(runTestGit(fixture.repositoryPath, ['status', '--short'])).toBe(initialStatus);
    expect(runTestGit(fixture.repositoryPath, ['worktree', 'list', '--porcelain'])).toBe(
      initialWorktrees
    );
    expect(listWorkspaceChangeSets(fixture.workspaceDb, fixture.workspaceId)).toEqual([
      expect.objectContaining({
        head: expect.objectContaining({ commit: branchCommit }),
        id: fixture.record.changeSet.id,
      }),
    ]);
    const artifact = fixture.store.getArtifact(fixture.workspaceId, fixture.artifactId);
    const body = JSON.stringify(
      {
        changeSet: {
          ...fixture.record.changeSet,
          head: { ...fixture.record.changeSet.head, commit: branchCommit },
        },
        patchPayload: fixture.record.patchPayload,
        review: fixture.record.review,
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
    const fixture = createWorkspaceChangeIngressFixture(
      'equivalent_base_key_order',
      'git',
      'staging-root'
    );
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
    const fixture = createWorkspaceChangeIngressFixture(
      'missing_package_request_proof',
      'git',
      'staging-root'
    );
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

  it('keeps Git workspace changes reviewable when durable workspace storage is disabled', async () => {
    const fixture = createWorkspaceChangeIngressFixture('git_without_core_db', 'git', 'missing');
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

    try {
      await executor.startTurn(
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
      );

      expect(fixture.store.getArtifact(fixture.workspaceId, fixture.artifactId)).toMatchObject({
        id: fixture.artifactId,
        kind: 'diff',
        status: 'ready',
      });
      expect(fixture.store.getTurnById(fixture.environmentPackage.scope.turnId)).toMatchObject({
        status: 'completed',
      });
    } finally {
      collectWorkspaceChanges.mockRestore();
      fixture.workspaceDb.sqlite.close();
    }
  });

  it('stores worker synchronization records in the owner-independent workspace', async () => {
    const fixture = createWorkspaceChangeIngressFixture('actor_scope', 'git', 'missing');
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-governance-actor-scope-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    const store = createDemoStore();
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
    upsertWorkspaceRepositoryResource(setupDb, {
      displayName: 'Workspace repository',
      git: {
        authorEmail: 'actor@example.invalid',
        authorName: 'Actor User',
        stagingStrategy: 'staging-root',
      },
      localPath: fixture.repositoryPath,
      resourceId: 'repo',
      workspaceExists: (candidateWorkspaceId) => candidateWorkspaceId === workspace.id,
      workspaceId: workspace.id,
    });
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
        await executor.startTurn(store, turn.id, 'Persist workspace review records', {
          agentSetup: createTestAgentSetup(),
          requestId: '00000000-0000-4000-8000-000000000203',
          triggerActor: turn.triggerActor,
          workspaceCwd: fixture.repositoryPath,
          workspaceRoots: [
            {
              access: 'read-write',
              id: 'repo',
              sourceKind: 'host-dir',
              sourcePath: fixture.repositoryPath,
              workerPath: '/workspace/repo',
            },
          ],
        });
      } catch (error) {
        startError = error;
      }

      const workspaceDb = openWorkspaceDb(dataRoot, workspace.id);
      applyScopedMigrations(workspaceDb);
      try {
        expect.soft(startError).toBeNull();
        expect.soft(listWorkspaceInputSnapshots(workspaceDb, workspace.id)).toHaveLength(1);
        expect.soft(listWorkspaceSyncReviews(workspaceDb, workspace.id)).toEqual([
          expect.objectContaining({
            review: expect.objectContaining({
              id: fixture.reviewId,
              staging: expect.objectContaining({ branch: null }),
            }),
          }),
        ]);
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
    const fixture = createWorkspaceChangeIngressFixture(
      'artifact_compensation',
      'git',
      'review-branch'
    );
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

  const rejectedIngressCases: readonly {
    readonly inputStrategy?: 'git' | 'filesystem';
    readonly materializationStrategy?: 'git' | 'filesystem';
    readonly mutate: (
      record: WorkerGovernanceWorkspaceChangeRecord
    ) => WorkerGovernanceWorkspaceChangeRecord;
    readonly name: string;
    readonly repositoryStrategy: 'missing' | 'review-branch' | 'staging-root';
    readonly strategy: 'git' | 'filesystem';
  }[] = [
    ...(['accepted', 'needs_refinement', 'rejected', 'blocked'] as const).map((status) => ({
      mutate: (record: WorkerGovernanceWorkspaceChangeRecord) => ({
        ...record,
        review: { ...record.review, status },
      }),
      name: `non-pending ${status} review`,
      repositoryStrategy: 'review-branch' as const,
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
      repositoryStrategy: 'review-branch',
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
      repositoryStrategy: 'missing',
      strategy: 'filesystem',
    },
    {
      inputStrategy: 'filesystem',
      mutate: (record) => record,
      name: 'change-set and input-snapshot strategy mismatch',
      repositoryStrategy: 'review-branch',
      strategy: 'git',
    },
    {
      materializationStrategy: 'filesystem',
      mutate: (record) => record,
      name: 'change-set and materialization strategy mismatch',
      repositoryStrategy: 'review-branch',
      strategy: 'git',
    },
    {
      mutate: (record) => record,
      name: 'Git change set without its exact repository resource',
      repositoryStrategy: 'missing',
      strategy: 'git',
    },
    {
      mutate: (record) => ({ ...record, filesystemApply: null }),
      name: 'filesystem change set without apply metadata',
      repositoryStrategy: 'missing',
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
      repositoryStrategy: 'missing',
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
      repositoryStrategy: 'missing',
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
      repositoryStrategy: 'missing',
      strategy: 'filesystem',
    },
    {
      mutate: (record) => ({ ...record, patchPayload: null }),
      name: 'Git change set without patch payload',
      repositoryStrategy: 'staging-root',
      strategy: 'git',
    },
    {
      mutate: (record) => ({
        ...record,
        changeSet: { ...record.changeSet, patch: null },
      }),
      name: 'Git change set without patch reference',
      repositoryStrategy: 'staging-root',
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
      repositoryStrategy: 'staging-root',
      strategy: 'git',
    },
  ];

  it('reports a non-secret workspace review actionability reason', async () => {
    const fixture = createWorkspaceChangeIngressFixture(
      'actionability_reason',
      'git',
      'staging-root'
    );
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
    repositoryStrategy,
    strategy,
  }) => {
    const fixture = createWorkspaceChangeIngressFixture(
      name.replaceAll(/[^a-z0-9]+/gi, '_').toLowerCase(),
      strategy,
      repositoryStrategy
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
    const fixture = createWorkspaceChangeIngressFixture(
      'conflicting_artifact',
      'git',
      'review-branch'
    );
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

  it('adopts an exact orphan review artifact without rewriting it', async () => {
    const fixture = createWorkspaceChangeIngressFixture(
      'exact_orphan_artifact',
      'git',
      'staging-root'
    );
    const review = {
      ...fixture.record.review,
      staging: { ...fixture.record.review.staging, branch: null },
    };
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

    const store = createDemoStore();
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

    await executor.startTurn(store, turn.id, 'Run with sandbox access', {
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
    });

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

  it('keeps workspace handles pending and omits teardown evidence when cleanup fails', async () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-governance-teardown-fail-')));

    applyMigrations(coreDb);

    const store = createDemoStore();
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
      executor.startTurn(store, turn.id, 'Run in OpenShell', {
        agentSetup: createTestAgentSetup(),
        requestId: '00000000-0000-4000-8000-000000000205',
        triggerActor: turn.triggerActor,
        workspaceRoots: [
          {
            access: 'read-write',
            id: 'repo',
            sourceKind: 'host-dir',
            sourcePath: process.cwd(),
            workerPath: '/workspace/openkit',
          },
        ],
      })
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

    const store = createDemoStore();
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
      executor.startTurn(store, turn.id, 'Retry OpenShell teardown', {
        agentSetup: createTestAgentSetup(),
        requestId: '00000000-0000-4000-8000-000000000206',
        triggerActor: turn.triggerActor,
        workspaceRoots: [
          {
            access: 'read-write',
            id: 'repo',
            sourceKind: 'host-dir',
            sourcePath: process.cwd(),
            workerPath: '/workspace/openkit',
          },
        ],
      })
    ).rejects.toThrow('teardown failed');

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

    const store = createDemoStore();
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
        executor.startTurn(store, turn.id, 'Fail cleanup status persistence', {
          agentSetup: createTestAgentSetup(),
          requestId: '00000000-0000-4000-8000-000000000207',
          triggerActor: turn.triggerActor,
          workspaceRoots: [
            {
              access: 'read-write',
              id: 'repo',
              sourceKind: 'host-dir',
              sourcePath: process.cwd(),
              workerPath: '/workspace/openkit',
            },
          ],
        })
      ).rejects.toThrow('cleanup status persistence failed');

      expect(backend.calls.filter((call) => call === 'cleanupSession')).toHaveLength(1);
      expect(store.getTurnById(turn.id)).toMatchObject({ status: 'failed' });
      expect(closeSpy).toHaveBeenCalledTimes(1);
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
    mkdirSync(workspaceDbPath(dataRoot, 'ws_demo'), { recursive: true });

    const store = createDemoStore();
    const turn = createAssignedTurn(store, 'ws_demo', 'th_demo', 'Fail workspace storage open');
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
    const setupDb = openWorkspaceDb(dataRoot, 'ws_demo');
    const sqlitePrototype = Object.getPrototypeOf(setupDb.sqlite) as {
      exec: typeof setupDb.sqlite.exec;
    };
    setupDb.sqlite.close();
    const execSpy = vi.spyOn(sqlitePrototype, 'exec').mockImplementationOnce(() => {
      throw new Error('injected workspace migration failure');
    });

    const store = createDemoStore();
    const turn = createAssignedTurn(
      store,
      'ws_demo',
      'th_demo',
      'Fail workspace storage migration'
    );
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
          agentSetup: createTestAgentSetup(),
          requestId: '00000000-0000-4000-8000-000000000209',
          triggerActor: turn.triggerActor,
          workspaceRoots: [],
        })
      ).rejects.toThrow('Failed to apply database setup workspace_0000_setup');

      expect(store.getTurnById(turn.id)).toMatchObject({ status: 'failed' });
      expect(
        store.getTurnEvents(turn.id).filter((event) => event.event === 'turn.completed')
      ).toEqual([
        expect.objectContaining({
          data: expect.objectContaining({ stopReason: 'error' }),
        }),
      ]);
    } finally {
      execSpy.mockRestore();
      coreDb.sqlite.close();
    }
  });

  it('does not emit completed before failed when workspace storage close fails', async () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-governance-close-fail-')));
    applyMigrations(coreDb);
    const setupDb = openTestWorkspaceDb(coreDb);
    const sqlitePrototype = Object.getPrototypeOf(setupDb.sqlite) as {
      close: typeof setupDb.sqlite.close;
    };
    setupDb.sqlite.close();
    const closeSpy = vi.spyOn(sqlitePrototype, 'close').mockImplementationOnce(() => {
      throw new Error('workspace storage close failed');
    });

    const store = createDemoStore();
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
        executor.startTurn(store, turn.id, 'Fail workspace storage close', {
          agentSetup: createTestAgentSetup(),
          requestId: '00000000-0000-4000-8000-000000000210',
          triggerActor: turn.triggerActor,
          workspaceRoots: [],
        })
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
    const store = createDemoStore();
    const turn = createAssignedTurn(store, 'ws_demo', 'th_demo', 'Fail completed turn persistence');
    const updateTurn = store.updateTurn.bind(store);
    const updateTurnSpy = vi.spyOn(store, 'updateTurn').mockImplementation((turnId, patch) => {
      if (patch.status === 'completed') {
        throw new Error('completed turn persistence failed');
      }
      return updateTurn(turnId, patch);
    });
    const executor = new WorkerGovernanceTurnExecutor({
      backend: new FakeWorkerGovernanceBackend(),
      createAgentSessionId: () => 'as_completed_turn_persistence_fail_1',
      environmentBackend: {
        kind: 'openshell',
      },
    });

    try {
      await expect(
        executor.startTurn(store, turn.id, 'Fail completed turn persistence', {
          agentSetup: createTestAgentSetup(),
          requestId: '00000000-0000-4000-8000-000000000211',
          triggerActor: turn.triggerActor,
          workspaceRoots: [],
        })
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
  });

  it('fails terminally when the backend rejects without an error value', async () => {
    const store = createDemoStore();
    const turn = createAssignedTurn(store, 'ws_demo', 'th_demo', 'Reject without an error value');
    const backend = new FakeWorkerGovernanceBackend();
    const collectEvidenceSpy = vi.spyOn(backend, 'collectEvidence').mockRejectedValue(undefined);
    const executor = new WorkerGovernanceTurnExecutor({
      backend,
      createAgentSessionId: () => 'as_falsey_rejection_1',
      environmentBackend: {
        kind: 'openshell',
      },
    });
    let rejected = false;

    try {
      await executor.startTurn(store, turn.id, 'Reject without an error value', {
        agentSetup: createTestAgentSetup(),
        requestId: '00000000-0000-4000-8000-000000000101',
        triggerActor: turn.triggerActor,
        workspaceRoots: [],
      });
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
  });

  it('keeps one terminal outcome when completion notification fails before persistence', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-governance-terminal-notify-fail-'));
    const store = createDemoStore({ dataRoot });
    const turn = createAssignedTurn(store, 'ws_demo', 'th_demo', 'Fail completion notification');
    const unsubscribe = store.addTurnListener(turn.id, (event) => {
      if (event.data.type === 'turn-completed' && event.data.stopReason === 'completed') {
        throw new Error('completion notification failed before persistence');
      }
    });
    const executor = new WorkerGovernanceTurnExecutor({
      backend: new FakeWorkerGovernanceBackend(),
      createAgentSessionId: () => 'as_terminal_notify_fail_1',
      environmentBackend: {
        kind: 'openshell',
      },
    });
    let failure: unknown = null;

    try {
      await executor.startTurn(store, turn.id, 'Fail completion notification', {
        agentSetup: createTestAgentSetup(),
        requestId: '00000000-0000-4000-8000-000000000102',
        triggerActor: turn.triggerActor,
        workspaceRoots: [],
      });
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
  });

  it.each([
    'agent-session',
    'turn',
    'agent-session-event',
  ] as const)('terminalizes after the failed %s write reports an after-write failure', async (failurePoint) => {
    const dataRoot = mkdtempSync(join(tmpdir(), `openkit-governance-${failurePoint}-fail-`));
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
      backend,
      createAgentSessionId: () => `as_${failurePoint}_fail_1`,
      environmentBackend: {
        kind: 'openshell',
      },
    });
    let failure: unknown = null;

    try {
      await executor.startTurn(store, turn.id, `Fail ${failurePoint} persistence`, {
        agentSetup: createTestAgentSetup(),
        requestId,
        triggerActor: turn.triggerActor,
        workspaceRoots: [],
      });
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
  });

  it('terminalizes setup failures after the turn and worker session exist', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-governance-setup-fail-'));
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
      backend: new FakeWorkerGovernanceBackend(),
      createAgentSessionId: () => 'as_setup_fail_1',
      environmentBackend: {
        kind: 'openshell',
      },
    });
    let failure: unknown = null;

    try {
      await executor.startTurn(store, turn.id, 'Fail worker setup', {
        agentSetup: createTestAgentSetup(),
        requestId: '00000000-0000-4000-8000-000000000106',
        triggerActor: turn.triggerActor,
        workspaceRoots: [],
      });
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
  });

  it('passes workspace source catalog context into the resolved AEP snapshot', async () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-governance-source-ref-')));

    applyMigrations(coreDb);

    const store = createDemoStore();
    const turn = createAssignedTurn(store, 'ws_demo', 'th_demo', 'Run with source catalog');
    const backend = new FakeWorkerGovernanceBackend();
    const executor = new WorkerGovernanceTurnExecutor({
      backend,
      coreDb,
      createAgentSessionId: () => 'as_source_ref_1',
      environmentBackend: {
        kind: 'openshell',
      },
    });

    await executor.startTurn(store, turn.id, 'Run with source catalog', {
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
            locator: { repositoryResourceId: 'repo_default' },
            sensitivity: 'internal',
            status: 'active',
          },
        ],
      },
      workspaceRoots: [
        {
          access: 'read-write',
          id: 'repo_default',
          sourceKind: 'host-dir',
          sourcePath: process.cwd(),
          workerPath: '/workspace/openkit',
        },
      ],
      workspaceSourceRefs: { repo_default: 'repo_default' },
    });

    expect(backend.lastPackage?.workspace.inputs[0]?.source).toMatchObject({
      catalogEntryDigest: expect.stringMatching(/^sha256:/),
      kind: 'git',
      locator: { repositoryResourceId: 'repo_default' },
      sourceId: 'repo_default',
      sourceRef: 'repo_default',
    });
    const workspaceDb = openTestWorkspaceDb(coreDb);

    expect(listWorkspaceInputSnapshots(workspaceDb, 'ws_demo')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          resourceId: 'repo_default',
          sourceId: 'repo_default',
        }),
      ])
    );
    expect(listWorkspaceMaterializationRecords(workspaceDb, 'ws_demo')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceId: 'repo_default',
        }),
      ])
    );

    workspaceDb.sqlite.close();
    coreDb.sqlite.close();
  });

  it.each([
    { inputKind: 'message', name: 'happy-message' },
    { inputKind: 'material', name: 'happy-material' },
  ] as const)('verifies $inputKind steering cleanup before worker launch', async ({
    inputKind,
    name,
  }) => {
    const fixture = createWorkerContextExecutorFixture(name, { inputKind });
    const {
      agentSessionId,
      contextItemId,
      coreDb,
      material,
      packageRoot,
      pending,
      requestId,
      revision,
      sandboxBindingRef,
      steeringMaterial,
      steeringRevision,
      store,
      tracePath,
      turn,
      workerRequest,
    } = fixture;
    const backend = new FakeWorkerGovernanceBackend();
    const launch = backend.launch.bind(backend);
    const launchSpy = vi.spyOn(backend, 'launch').mockImplementation(async (...args) => {
      const trace = JSON.parse(readFileSync(tracePath, 'utf8')) as {
        contextPackageDigest: string;
        includedItemIds: string[];
        materialSelections: Array<{
          inclusionReason: string;
          materialId: string;
          revisionId: string;
        }>;
      };
      expect(trace.contextPackageDigest).toMatch(/^ctxpkg_sha256_[0-9a-f]{64}$/);
      expect(trace.includedItemIds).toEqual([
        `it_user_${turn.id}`,
        pending.contentItemId,
        contextItemId,
      ]);
      expect(trace.materialSelections).toHaveLength(inputKind === 'material' ? 2 : 1);
      expect(trace.materialSelections).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            inclusionReason: 'thread_binding',
            materialId: material.materialId,
            revisionId: revision.revisionId,
          }),
          ...(steeringMaterial && steeringRevision
            ? [
                expect.objectContaining({
                  inclusionReason: 'goal_steering',
                  materialId: steeringMaterial.materialId,
                  revisionId: steeringRevision.revisionId,
                }),
              ]
            : []),
        ])
      );
      const prelaunchDb = openTestWorkspaceDb(coreDb);
      expect(getPendingUserTurnRecord(prelaunchDb, turn.workspaceId, turn.threadId)).toBeNull();
      expect(selectQueuedThreadMaterialRevision(prelaunchDb, turn.threadId)).toBeNull();
      prelaunchDb.sqlite.close();
      return launch(...args);
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
        agentSessionId,
        agentSetup: createTestAgentSetup(),
        requestId,
        sandboxBindingRef,
        triggerActor: turn.triggerActor,
        workspaceRoots: [],
      });
      expect(launchSpy).toHaveBeenCalledTimes(1);
      expect(backend.lastContext?.workspaceRoots).toEqual([
        {
          access: 'read-only',
          id: `context_${turn.id}`,
          sourceKind: 'materialized-dir',
          sourcePath: packageRoot,
          workerPath: '/openkit/context',
        },
      ]);
    } finally {
      launchSpy.mockRestore();
      coreDb.sqlite.close();
    }
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
    workspaceDb.sqlite.transaction(() => {
      deleteAppliedPendingUserTurnRecord(workspaceDb, {
        workspaceId: fixture.turn.workspaceId,
        threadId: fixture.turn.threadId,
        pendingTurnId: fixture.pending.pendingTurnId,
        contextPackageId: `ctxpkg_${fixture.turn.id}`,
      });
    })();
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
    const launchSpy = vi.spyOn(backend, 'launch');
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
      expect(getPendingUserTurnRecord(reopenedDb, turn.workspaceId, turn.threadId)).toBeNull();
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
      deleteAppliedPendingUserTurnRecord(workspaceDb, {
        contextPackageId: `ctxpkg_${fixture.turn.id}`,
        pendingTurnId: fixture.pending.pendingTurnId,
        threadId: fixture.turn.threadId,
        workspaceId: fixture.turn.workspaceId,
      });
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
    const launch = backend.launch.bind(backend);
    const launchSpy = vi.spyOn(backend, 'launch').mockImplementation(async (...args) => {
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
        'schema_version: "openkit-workspace-knowledge-schema-v1"',
        'status: "active"',
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
        '/api/app/workspaces/ws_demo/knowledge/manager/proposals',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(draftRequest),
        }
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
        '/api/app/workspaces/ws_demo/knowledge/manager/proposals',
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
      );
      expect(invalidDraftResponse.status).toBe(400);
      await expect(invalidDraftResponse.json()).resolves.toMatchObject({ code: 'invalid_request' });
      expect(fixture.store.listKnowledgeProposals('ws_demo')).toHaveLength(1);

      const decisionRequestId = '00000000-0000-4000-8000-000000000641';
      const acceptedDecision = await app.request(
        `/api/app/workspaces/ws_demo/knowledge/proposals/${drafted.proposal.id}/decision`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ requestId: decisionRequestId, decision: 'accepted' }),
        }
      );
      expect(acceptedDecision.status, await acceptedDecision.clone().text()).toBe(200);
      const retrievalResponse = await app.request(
        '/api/app/workspaces/ws_demo/knowledge/retrievals',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            query: 'Direct Task lesson',
            limit: 5,
            pinnedConceptIds: [],
          }),
        }
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
        '/api/app/workspaces/ws_demo/knowledge/manager/proposals',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(draftRequest),
        }
      );
      expect(interruptedReplay.status).toBe(409);
      await expect(interruptedReplay.json()).resolves.toMatchObject({
        code: 'recovery_required',
      });
      expect(fixture.store.listKnowledgeProposals('ws_demo')).toHaveLength(1);

      const conflictingResume = await app.request(
        `/api/app/workspaces/ws_demo/knowledge/proposals/${drafted.proposal.id}/decision`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ requestId: decisionRequestId, decision: 'accepted' }),
        }
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
    const launchSpy = vi.spyOn(backend, 'launch');
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

  it.each([
    {
      expectedError: 'Worker Context Package file digest mismatch: instructions.md.',
      failure: 'corrupt package bytes',
      name: 'corrupt',
    },
    {
      expectedError: 'Worker Context Package applied steering claim is contradictory.',
      failure: 'mismatched applied claim',
      name: 'claim',
    },
    {
      expectedError: 'Worker Context Package scheduler binding is unavailable.',
      failure: 'missing scheduler binding',
      name: 'binding',
    },
    {
      expectedError: {
        code: 'goal_steering_delivery_unavailable',
        message: 'Worker Context Package steering Material exceeds the context budget.',
        status: 503,
      },
      failure: 'oversized steering Material',
      name: 'steering-budget',
    },
  ] as const)('fails closed before launch for $failure and preserves the Material queue', async ({
    expectedError,
    failure,
    name,
  }) => {
    const fixture = createWorkerContextExecutorFixture(name, {
      inputKind: failure === 'oversized steering Material' ? 'material' : undefined,
      maxContextTokens: failure === 'oversized steering Material' ? 1_000 : undefined,
      mismatchedClaim: failure === 'mismatched applied claim',
      steeringContent: failure === 'oversized steering Material' ? 'S'.repeat(5_000) : undefined,
    });
    const {
      agentSessionId,
      coreDb,
      packageRoot,
      pending,
      queuedMaterial,
      requestId,
      sandboxBindingRef,
      store,
      tracePath,
      turn,
      workerRequest,
    } = fixture;
    const backend = new FakeWorkerGovernanceBackend();
    const materialize = backend.materialize.bind(backend);
    const materializeSpy = vi.spyOn(backend, 'materialize').mockImplementation(async (...args) => {
      const result = await materialize(...args);
      if (failure === 'corrupt package bytes') {
        writeFileSync(join(packageRoot, 'instructions.md'), 'corrupt');
      }
      return result;
    });
    const launchSpy = vi.spyOn(backend, 'launch');
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
      const execution = executor.startTurn(store, turn.id, workerRequest, {
        agentSessionId,
        agentSetup: createTestAgentSetup(),
        requestId,
        ...(failure === 'missing scheduler binding' ? {} : { sandboxBindingRef }),
        triggerActor: turn.triggerActor,
        workspaceRoots: [],
      });
      if (typeof expectedError === 'string') {
        await expect(execution).rejects.toThrow(expectedError);
      } else {
        await expect(execution).rejects.toMatchObject(expectedError);
      }
      expect(materializeSpy).toHaveBeenCalledTimes(failure === 'corrupt package bytes' ? 1 : 0);
      expect(launchSpy).not.toHaveBeenCalled();
      expect(existsSync(tracePath)).toBe(false);
      const reopenedDb = openTestWorkspaceDb(coreDb);
      expect(selectQueuedThreadMaterialRevision(reopenedDb, turn.threadId)).toEqual(queuedMaterial);
      expect(getPendingUserTurnRecord(reopenedDb, turn.workspaceId, turn.threadId)).toMatchObject({
        pendingTurnId: pending.pendingTurnId,
        terminalClaimKind: 'applied',
      });
      reopenedDb.sqlite.close();
    } finally {
      launchSpy.mockRestore();
      materializeSpy.mockRestore();
      coreDb.sqlite.close();
    }
  });

  it('passes scheduler-owned lineage into backend materialization', async () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-governance-binding-')));

    applyMigrations(coreDb);

    const store = createDemoStore();
    const turn = createAssignedTurn(store, 'ws_demo', 'th_demo', 'Run with scheduler binding');
    const agentSessionId = 'as_governance_binding_1';
    const sandboxBindingRef = 'lease-binding:executor_1';
    dispatchExecutorLease(coreDb, {
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

  it('rechecks runtime authority before backend materialization', async () => {
    const coreDb = openCoreDb(
      mkdtempSync(join(tmpdir(), 'openkit-governance-prematerialize-authority-'))
    );
    applyMigrations(coreDb);
    const store = createDemoStore();
    const turn = createAssignedTurn(store, 'ws_demo', 'th_demo', 'Do not materialize stale work');
    const agentSessionId = 'as_prematerialize_authority_1';
    const sandboxBindingRef = 'lease-binding:prematerialize-authority';
    dispatchExecutorLease(coreDb, {
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
      expect(store.getAgentSession(agentSessionId)).toMatchObject({ status: 'interrupted' });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('writes a package-scoped backend anchor before materialization and cleans it for zero-input turns', async () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-governance-anchor-order-')));
    applyMigrations(coreDb);
    const store = createDemoStore();
    const turn = createAssignedTurn(store, 'ws_demo', 'th_demo', 'Anchor before effect');
    const agentSessionId = 'as_anchor_order_1';
    const packageSnapshotId = `aepsnap_${turn.id}_${agentSessionId}`;
    const sandboxBindingRef = 'lease-binding:anchor-order';
    dispatchExecutorLease(coreDb, {
      agentSessionId,
      packageSnapshotId,
      sandboxBindingRef,
      threadId: turn.threadId,
      turnId: turn.id,
    });
    const backend = new FakeWorkerGovernanceBackend();
    const materialize = backend.materialize.bind(backend);
    const materializeSpy = vi.spyOn(backend, 'materialize').mockImplementation(async (...args) => {
      expect(getWorkerBackendSession(coreDb, `lease_${turn.id}`)).toMatchObject({
        backendSessionId: `openkit-${agentSessionId}`,
        packageSnapshotId,
        state: 'materializing',
      });
      return materialize(...args);
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
    const store = createDemoStore();
    const turn = createAssignedTurn(store, 'ws_demo', 'th_demo', 'Fail after materialize effect');
    const agentSessionId = 'as_materialize_failure_1';
    const packageSnapshotId = `aepsnap_${turn.id}_${agentSessionId}`;
    const sandboxBindingRef = 'lease-binding:materialize-failure';
    dispatchExecutorLease(coreDb, {
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
      expect(
        coreDb.sqlite
          .prepare(
            `SELECT leases.status, capacity.in_use_count AS inUseCount
               FROM scheduler_session_leases AS leases
               JOIN scheduler_capacity_records AS capacity ON capacity.target_id = leases.target_id
               WHERE leases.lease_id = ?`
          )
          .get(`lease_${turn.id}`)
      ).toEqual({ inUseCount: 1, status: 'acquired' });
    } finally {
      materializeSpy.mockRestore();
      coreDb.sqlite.close();
    }
  });

  it('does not launch when the scheduler lease stops being live during materialization', async () => {
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-governance-prelaunch-gate-')));
    applyMigrations(coreDb);
    const store = createDemoStore();
    const turn = createAssignedTurn(store, 'ws_demo', 'th_demo', 'Lose lease before launch');
    const agentSessionId = 'as_prelaunch_gate_1';
    const packageSnapshotId = `aepsnap_${turn.id}_${agentSessionId}`;
    const sandboxBindingRef = 'lease-binding:prelaunch-gate';
    dispatchExecutorLease(coreDb, {
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
      coreDb.sqlite
        .prepare(
          "UPDATE scheduler_session_leases SET status = 'stale', release_reason = 'heartbeat-timeout' WHERE lease_id = ?"
        )
        .run(`lease_${turn.id}`);
      return result;
    });
    const launchSpy = vi.spyOn(backend, 'launch');
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
          agentSessionId,
          agentSetup: createTestAgentSetup(),
          requestId: '00000000-0000-4000-8000-000000000252',
          sandboxBindingRef,
          triggerActor: turn.triggerActor,
          workspaceRoots: [],
        })
      ).rejects.toThrow('Scheduler lease is not live for worker backend launch.');
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
    const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-governance-deadline-gate-')));
    applyMigrations(coreDb);
    const store = createDemoStore();
    const turn = createAssignedTurn(store, 'ws_demo', 'th_demo', 'Expire before launch');
    const agentSessionId = 'as_deadline_gate_1';
    const packageSnapshotId = `aepsnap_${turn.id}_${agentSessionId}`;
    const sandboxBindingRef = 'lease-binding:deadline-gate';
    let timestamp = '2026-07-15T00:00:03.000Z';
    dispatchExecutorLease(coreDb, {
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
      timestamp = '2026-07-15T00:03:00.000Z';
      return result;
    });
    const launchSpy = vi.spyOn(backend, 'launch');
    const executor = new WorkerGovernanceTurnExecutor({
      backend,
      coreDb,
      createAgentSessionId: () => agentSessionId,
      environmentBackend: {
        kind: 'openshell',
      },
      now: () => timestamp,
    });

    try {
      await expect(
        executor.startTurn(store, turn.id, 'Expire before launch', {
          agentSessionId,
          agentSetup: createTestAgentSetup(),
          requestId: '00000000-0000-4000-8000-000000000253',
          sandboxBindingRef,
          triggerActor: turn.triggerActor,
          workspaceRoots: [],
        })
      ).rejects.toThrow('Scheduler lease is not live for worker backend launch.');
      expect(launchSpy).not.toHaveBeenCalled();
      expect(backend.calls.filter((call) => call === 'cleanupSession')).toHaveLength(1);
      expect(getWorkerBackendSession(coreDb, `lease_${turn.id}`)).toMatchObject({
        state: 'cleaned',
      });
      expect(
        coreDb.sqlite
          .prepare('SELECT status FROM scheduler_session_leases WHERE lease_id = ?')
          .get(`lease_${turn.id}`)
      ).toEqual({ status: 'acquired' });
    } finally {
      launchSpy.mockRestore();
      materializeSpy.mockRestore();
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

    const store = createDemoStore();
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
      await executor.startTurn(store, turn.id, 'Run GitHub MCP in OpenShell', {
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
      });

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

    const store = createDemoStore();
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
      await executor.startTurn(store, turn.id, 'Run Codex auth runtime file', {
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
      });

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

/** Computes one canonical prefixed SHA-256 digest. */
function turnRuntimeSha256(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

class FakeWorkerGovernanceBackend implements WorkerGovernanceBackend {
  public readonly calls: string[] = [];
  public artifactCollectionInvalid = false;
  public artifactOutput: {
    readonly bytes: Buffer;
    readonly materialProposal?: {
      readonly baseContentDigest: string;
      readonly baseRevisionId: string;
      readonly materialId: string;
    };
  } | null = null;
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
    this.calls.push('materialize');
    this.lastContext = context ?? null;
    this.lastPackage = environmentPackage;

    return {
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

  public async launch(): Promise<WorkerGovernanceEvidenceRecord> {
    this.calls.push('launch');

    return {
      data: {},
      kind: 'fake.launch',
      timestamp: '2026-06-16T00:00:00.000Z',
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

    const artifactOutput = this.artifactOutput;
    return {
      ...(this.eventsJsonlFactory
        ? { eventsJsonl: this.eventsJsonlFactory(this.lastPackage) }
        : {}),
      ...(artifactOutput
        ? {
            artifactFiles: [{ bytes: artifactOutput.bytes, sequence: 2 }],
            artifactsJsonl: `${JSON.stringify({
              schemaVersion: 1,
              kind: 'artifact',
              lineage: {
                workspaceId: this.lastPackage.scope.workspaceId,
                threadId: this.lastPackage.scope.threadId,
                turnId: this.lastPackage.scope.turnId,
                agentSessionId: this.lastPackage.scope.agentSessionId,
                packageSnapshotId: this.lastPackage.snapshotId,
                requestId: this.lastPackage.scope.requestId,
              },
              sequence: 2,
              artifact: {
                kind: 'report',
                mediaType: 'text/markdown',
                path: '/openkit/artifacts/report.md',
                title: 'Governed worker report',
                ...(artifactOutput.materialProposal
                  ? { materialProposal: artifactOutput.materialProposal }
                  : {}),
              },
            })}\n`,
          }
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
          text: 'Governed worker completed the task.',
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
